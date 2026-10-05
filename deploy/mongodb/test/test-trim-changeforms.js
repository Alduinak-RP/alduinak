'use strict'

// trim-changeforms.js against a stub collection: dry run, refusals, step order, backup and the index helpers: node deploy/mongodb/test/test-trim-changeforms.js

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-changeforms-test-'))
const settingsFile = path.join(tmp, 'server-settings.json')
fs.writeFileSync(settingsFile, JSON.stringify({ databaseDriver: 'mongodb', databaseUri: 'mongodb://stub', databaseName: 'stub_db' }))
process.env.ALDUINAK_SERVER_SETTINGS = settingsFile
process.env.ALDUINAK_TEST_SERVER_SETTINGS = settingsFile
process.env.ALDUINAK_WIPE_BACKUP_ROOT = tmp

const T = require(path.join(__dirname, '..', 'trim-changeforms'))
const { Refusal } = require(path.join(__dirname, '..', 'strip-common'))

const OLD = [
  { name: 'formDesc_1', key: { formDesc: 1 } },
  { name: 'worldOrCellDesc_1', key: { worldOrCellDesc: 1 } },
  { name: 'profileId_1', key: { profileId: 1 } },
]
const FLAGGED = [{ _id: 'a', formDesc: 'ff000001', isDeleted: true }, { _id: 'b', formDesc: 'ff000002', isDeleted: true }]

// Answers by filter shape; records every write
function stubCol({ indexes = OLD, missingCollection = false, dups = [], numChanges = 3 } = {}) {
  const writes = []
  let list = missingCollection ? null : indexes.map(i => ({ v: 2, ...i }))
  let flaggedLeft = FLAGGED.length
  let noNumChanges = numChanges
  const col = {
    writes,
    async indexes() {
      if (!list) { const err = new Error('ns does not exist'); err.code = 26; throw err }
      return list.map(i => ({ ...i }))
    },
    async createIndex(key, opts) { writes.push(`create ${opts.name}`); list = [...(list || []), { v: 2, key, ...opts }] },
    async dropIndex(name) { writes.push(`drop ${name}`); list = list.filter(i => i.name !== name) },
    aggregate(pipeline) {
      const match = pipeline[0].$match
      const out = match.$nor ? dups : [{ _id: { actor: true, ff: true }, n: 2 }]
      return { toArray: async () => out }
    },
    async countDocuments(filter) {
      if (filter['equipmentDump.numChanges']) return noNumChanges
      if (filter.profileId && filter.profileId.$gte === 0) return 1
      return flaggedLeft
    },
    find() { return { toArray: async () => FLAGGED.map(d => ({ ...d })) } },
    async deleteMany(filter) { writes.push('deleteMany'); flaggedLeft -= filter._id.$in.length; return { deletedCount: filter._id.$in.length } },
    async updateMany() { writes.push('updateMany'); const n = noNumChanges; noNumChanges = 0; return { modifiedCount: n } },
  }
  return col
}

async function run(argv, col, blockerReason = null) {
  const lines = []
  let refusal = null
  try {
    await T.main(argv, { open: async () => ({ client: { close: async () => {} }, col }), blocker: async () => blockerReason, out: l => lines.push(l) })
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    refusal = err.message
  }
  return { text: lines.join('\n'), refusal }
}

;(async () => {
  // Dry run: every step planned, nothing written
  let col = stubCol()
  let r = await run(['--test'], col)
  assert.equal(r.refusal, null)
  assert.match(r.text, /dry run/)
  assert.match(r.text, /purge: 2 flagged documents to delete \(2 FF actors\), 1 deleted character stays flagged/)
  assert.match(r.text, /numChanges: 3 equipment dumps without numChanges/)
  assert.match(r.text, /indexes: drop formDesc_1, worldOrCellDesc_1, profileId_1; create formDesc_1 \(unique\), profileId_1_formDesc_1 \(partial\)/)
  assert.deepEqual(col.writes, [])

  // A running game server refuses before any read
  col = stubCol()
  r = await run(['--apply'], col, 'AlduinakGameServer is SERVICE_RUNNING, stop it first')
  assert.match(r.refusal, /SERVICE_RUNNING/)
  assert.deepEqual(col.writes, [])

  // Duplicate formDescs refuse the whole apply
  col = stubCol({ dups: [{ _id: 'ff000003', n: 2 }] })
  r = await run(['--apply'], col)
  assert.match(r.refusal, /indexes: 1 formDesc is on more than one document.*ff000003 \(2\)/)
  assert.deepEqual(col.writes, [])

  // Apply: backup, purge, numChanges, then the index swap
  col = stubCol()
  r = await run(['--apply'], col)
  assert.equal(r.refusal, null)
  assert.deepEqual(col.writes, ['deleteMany', 'updateMany', 'drop formDesc_1', 'drop worldOrCellDesc_1', 'drop profileId_1', 'create formDesc_1', 'create profileId_1_formDesc_1'])
  assert.match(r.text, /purge: deleted 2 of 2, 0 flagged left/)
  assert.match(r.text, /numChanges: set numChanges 0 on 3, 0 left/)
  const dir = fs.readdirSync(tmp).find(n => n.startsWith('rollback-trim-stub_db-'))
  assert.ok(dir, 'backup folder written')
  const info = JSON.parse(fs.readFileSync(path.join(tmp, dir, 'trim-backup.json'), 'utf8'))
  assert.equal(info.count, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, dir, 'changeforms.ejson'), 'utf8')).length, 2)
  assert.deepEqual((await T.planIndexes(col)), { drop: [], create: [] })

  // A migrated collection has nothing left to swap
  r = await run([], col)
  assert.match(r.text, /indexes: formDesc_1 \(unique\), profileId_1_formDesc_1 \(partial\) present/)

  // ensureIndexes: a missing collection gets both, an old one only the free name
  col = stubCol({ missingCollection: true })
  assert.match(await T.ensureIndexes(col), /created: formDesc_1 \(unique\), profileId_1_formDesc_1 \(partial\)$/)
  col = stubCol()
  assert.match(await T.ensureIndexes(col), /created: profileId_1_formDesc_1 \(partial\); formDesc_1 \(unique\) held by an older index/)
  assert.deepEqual(col.writes, ['create profileId_1_formDesc_1'])

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('test-trim-changeforms: all passed')
})().catch(err => { console.error(err); process.exitCode = 1 })
