'use strict'

// The changeForms formDesc index ensure against stubbed clients: present, created, missing collection, timeout, connection error and non-mongodb drivers: node tools/test-formdesc-index.js

const assert = require('node:assert/strict')
const I = require('../src/formDescIndex')

const settings = { databaseDriver: 'mongodb', databaseUri: 'mongodb://user:secret@127.0.0.1:1/skymp', databaseName: 'skymp' }
const tick = () => new Promise(r => setImmediate(r))

// A collection holding the given indexes; indexes: null makes listIndexes fail as on a missing collection
function stub(indexes) {
  const calls = { created: [], closed: 0 }
  const col = {
    async indexes() {
      if (indexes === null) throw Object.assign(new Error('ns does not exist: skymp.changeForms'), { code: 26 })
      return indexes
    },
    async createIndex(key, opts) { calls.created.push([key, opts]); return opts.name },
  }
  const client = { async close() { calls.closed++ } }
  return { calls, open: async s => { calls.settings = s; return { client, col } } }
}

async function main() {
  const idOnly = [{ v: 2, key: { _id: 1 }, name: '_id_' }]

  let s = stub([...idOnly, { v: 2, key: { formDesc: 1 }, name: 'formDesc_1' }])
  let r = await I.ensureFormDescIndex(settings, { open: s.open })
  assert.equal(r.ok, true)
  assert.equal(r.outcome, 'present')
  assert.match(r.line, /^\[index\] changeForms\.formDesc present on skymp \(\d+ ms\)$/)
  assert.deepEqual(s.calls.created, [])
  await tick()
  assert.equal(s.calls.closed, 1)
  assert.equal(s.calls.settings, settings)

  // An index on formDesc under another name or with options also counts, so createIndex never conflicts with it
  s = stub([...idOnly, { v: 2, key: { formDesc: 1 }, name: 'byDesc', unique: true }])
  r = await I.ensureFormDescIndex(settings, { open: s.open })
  assert.equal(r.outcome, 'present')
  assert.deepEqual(s.calls.created, [])

  // Compound or descending keys do not
  s = stub([...idOnly, { v: 2, key: { formDesc: 1, recType: 1 }, name: 'formDesc_1_recType_1' }, { v: 2, key: { formDesc: -1 }, name: 'formDesc_-1' }])
  r = await I.ensureFormDescIndex(settings, { open: s.open })
  assert.equal(r.outcome, 'created')
  assert.match(r.line, /^\[index\] changeForms\.formDesc created on skymp \(\d+ ms\)$/)
  assert.deepEqual(s.calls.created, [[{ formDesc: 1 }, { name: 'formDesc_1' }]])
  await tick()
  assert.equal(s.calls.closed, 1)

  // After a wipe the collection is gone: createIndex creates it with the index
  s = stub(null)
  r = await I.ensureFormDescIndex(settings, { open: s.open })
  assert.equal(r.outcome, 'created')
  assert.equal(s.calls.created.length, 1)

  // A server that never answers gives up at the cap
  const t0 = Date.now()
  r = await I.ensureFormDescIndex(settings, { open: () => new Promise(() => {}), timeoutMs: 60 })
  assert.ok(Date.now() - t0 < 1000, 'the timeout caps the wait')
  assert.equal(r.ok, false)
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on skymp: no answer within 0.06 s')
  assert.equal(I.TIMEOUT_MS, 15000)

  // A connection that lands after the cap is closed without touching the collection
  let land
  s = stub(idOnly)
  r = await I.ensureFormDescIndex(settings, { open: () => new Promise(res => { land = () => res(s.open(settings)) }), timeoutMs: 30 })
  assert.equal(r.ok, false)
  assert.equal(s.calls.closed, 0)
  land()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(s.calls.created.length, 0, 'no index build after the cap, the game may be booting')
  assert.equal(s.calls.closed, 1, 'a late connection is closed')

  // listIndexes answering after the cap skips createIndex too
  let answer
  s = stub(idOnly)
  const slowCol = { indexes: () => new Promise(res => { answer = () => res(idOnly) }), createIndex: async (key, opts) => { s.calls.created.push([key, opts]) } }
  r = await I.ensureFormDescIndex(settings, { open: async () => ({ ...(await s.open(settings)), col: slowCol }), timeoutMs: 30 })
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on skymp: no answer within 0.03 s')
  answer()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(s.calls.created.length, 0, 'no index build after the cap, the game may be booting')
  assert.equal(s.calls.closed, 1)

  // A connection error is one line with the URI masked
  r = await I.ensureFormDescIndex(settings, { open: async () => { throw new Error(`connect ECONNREFUSED ${settings.databaseUri}`) } })
  assert.equal(r.ok, false)
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on skymp: connect ECONNREFUSED <databaseUri>')
  assert.ok(!r.line.includes('secret'))

  // createIndex failing (a conflicting index) is reported, not thrown, and the client is closed
  s = stub(idOnly)
  const col = { indexes: async () => idOnly, createIndex: async () => { throw new Error('Index already exists with a different name') } }
  r = await I.ensureFormDescIndex(settings, { open: async () => ({ ...(await s.open(settings)), col }) })
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on skymp: Index already exists with a different name')
  await tick()
  assert.equal(s.calls.closed, 1)

  // The file driver, no driver at all, or no URI never opens a connection
  const never = async () => { throw new Error('must not connect') }
  r = await I.ensureFormDescIndex({ databaseDriver: 'file', databaseName: 'world' }, { open: never })
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on world: databaseDriver is "file", only mongodb has indexes')
  r = await I.ensureFormDescIndex({}, { open: never })
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on (no databaseName): databaseDriver is "file", only mongodb has indexes')
  r = await I.ensureFormDescIndex(undefined, { open: never })
  assert.equal(r.ok, false)
  r = await I.ensureFormDescIndex({ databaseDriver: 'mongodb', databaseName: 'skymp_test' }, { open: never })
  assert.equal(r.line, '[index] changeForms.formDesc not ensured on skymp_test: server-settings.json has no databaseUri')

  console.log('formdesc-index: all checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
