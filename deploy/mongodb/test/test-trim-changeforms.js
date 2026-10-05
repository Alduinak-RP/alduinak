'use strict'

// trim-changeforms.js against a stub collection: dry run, refusals, step order, backup, the index helpers and the ff_decor backfill: node deploy/mongodb/test/test-trim-changeforms.js

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
function stubCol({ indexes = OLD, missingCollection = false, dups = [], numChanges = 3, decorDocs = [], flaggedGroups = [{ _id: { actor: true, ff: true }, n: 2 }] } = {}) {
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
      const out = match.recType === 0 ? decorDocs : match.$nor ? dups : flaggedGroups
      return { toArray: async () => out.map(d => ({ ...d })) }
    },
    async bulkWrite(ops) { writes.push(`bulkWrite ${ops.length}`); col.bulkOps = ops; return { modifiedCount: ops.length } },
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

  // ff_decor: a plugin with one live worldspace (3c), a deleted one and a cell
  const record = (type, formId, flags = 0) => {
    const h = Buffer.alloc(24)
    h.write(type, 0, 'latin1')
    h.writeUInt32LE(flags, 8)
    h.writeUInt32LE(formId, 12)
    return h
  }
  const group = (label, type, children) => {
    const h = Buffer.alloc(24)
    const body = Buffer.concat(children)
    h.write('GRUP', 0, 'latin1')
    h.writeUInt32LE(24 + body.length, 4)
    if (typeof label === 'string') h.write(label, 8, 'latin1')
    else h.writeUInt32LE(label, 8)
    h.writeInt32LE(type, 12)
    return Buffer.concat([h, body])
  }
  const dataDir = path.join(tmp, 'Data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'Fake.esm'), Buffer.concat([
    record('TES4', 0),
    group('CELL', 0, [record('CELL', 0x165a7)]),
    group('WRLD', 0, [record('WRLD', 0x3c), group(0x3c, 1, [record('REFR', 0x99)]), record('WRLD', 0x1a26f, 0x20)]),
  ]))
  assert.deepEqual([...T.worldDescsOf([path.join(dataDir, 'Fake.esm')])], ['3c:fake.esm'])

  const DECOR_DOCS = [
    // Indoor primary, outdoor partner: only the street half shows the entrance lock
    { formDesc: '166c7:Fake.esm', worldOrCellDesc: '165a7:Fake.esm', housing: { owner: 20, name: 'Test House', lockedEntrance: true, lockedExit: false, partner: 0x1a700 } },
    { formDesc: '1a700:Fake.esm', worldOrCellDesc: '3c:Fake.esm', housing: { primary: 0x166c7 } },
    // A legacy one-lock container already marked
    { formDesc: '200:Fake.esm', worldOrCellDesc: '3c:Fake.esm', housing: { owner: 21, name: '', locked: true }, decor: { name: null, locked: true } },
    // Released: no mark
    { formDesc: '300:Fake.esm', worldOrCellDesc: '3c:Fake.esm', housing: { owner: 0, partner: 0x301 } },
    // Its pair half has no document
    { formDesc: '400:Fake.esm', worldOrCellDesc: '3c:Fake.esm', housing: { owner: 22, name: 'Shack', lockedEntrance: false, lockedExit: true, partner: 0x500 } },
  ]
  const writeSettings = extra => fs.writeFileSync(settingsFile, JSON.stringify({ databaseDriver: 'mongodb', databaseUri: 'mongodb://stub', databaseName: 'stub_db', ...extra }))

  // Without the plugins the halves cannot be told apart: nothing is written
  col = stubCol({ decorDocs: DECOR_DOCS })
  r = await run(['--apply'], col)
  assert.match(r.refusal, /decor: the halves of 3 claims cannot be told apart without the plugins: server-settings.json needs loadOrder and dataDir/)
  assert.deepEqual(col.writes, [])

  writeSettings({ dataDir, loadOrder: [path.join(dataDir, 'Fake.esm')] })
  col = stubCol({ indexes: [], numChanges: 0, flaggedGroups: [], decorDocs: DECOR_DOCS })
  r = await run(['--test'], col)
  assert.match(r.text, /decor: 3 claim halves to mark with ff_decor \(3 live claims\)/)
  assert.match(r.text, /1 pair half has no housing document, housingSystem marks it at the next change: 500:Fake.esm \(pair of 400:Fake.esm\)/)
  r = await run(['--apply'], col)
  assert.equal(r.refusal, null)
  assert.equal(col.writes[col.writes.length - 1], 'bulkWrite 3')
  assert.match(r.text, /decor: set ff_decor on 3 of 3/)
  assert.deepEqual(col.bulkOps.map(o => [o.updateOne.filter.formDesc, o.updateOne.update.$set['dynamicFields.ff_decor']]), [
    ['166c7:Fake.esm', { name: 'Test House', locked: false }],
    ['1a700:Fake.esm', { name: 'Test House', locked: true }],
    ['400:Fake.esm', { name: 'Shack', locked: true }],
  ])
  assert.deepEqual(T.decorOf({ name: null, lockedEntrance: false, lockedExit: true }, false, true), { name: null, locked: false })

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('test-trim-changeforms: all passed')
})().catch(err => { console.error(err); process.exitCode = 1 })
