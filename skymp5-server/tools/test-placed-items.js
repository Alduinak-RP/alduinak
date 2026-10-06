'use strict'

// placedItemSystem.ts carries against a stub mp: a grab of a plugin item is granted, flags it ff_carried and hides the other viewers' copies, a move or release sends itemMoved, and a taken (harvested) or disabled item is refused: node tools/test-placed-items.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'placedItemSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { PlacedItemSystem } = compiled.exports

const SWORD_BASE = 0x00013989
const CELL = '13a65:Skyrim.esm'
const [SWORD, TAKEN, HIDDEN] = [0x0001a000, 0x0001a001, 0x0001a002]
const [CARRIER, WATCHER] = [0xff000001, 0xff000002]

function setup () {
  const props = new Map()
  const packets = []
  const users = new Map([[1, CARRIER], [2, WATCHER]])
  const item = (id, extra) => props.set(id, { baseDesc: 'sword', locationalData: { cellOrWorldDesc: CELL, pos: [100, 0, 0], rot: [0, 0, 0] }, isDisabled: false, harvested: false, ...extra })
  item(SWORD, {})
  item(TAKEN, { harvested: true })
  item(HIDDEN, { isDisabled: true })
  for (const actor of users.values()) props.set(actor, { pos: [0, 0, 0], locationalData: { cellOrWorldDesc: CELL, pos: [0, 0, 0], rot: [0, 0, 0] } })
  const userOf = (actorId) => [...users].find(([, a]) => a === actorId)?.[0] ?? -1
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      return props.get(id)[key]
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      props.get(id)[key] = value
    },
    getIdFromDesc: (desc) => (desc === 'sword' ? SWORD_BASE : 0),
    getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`,
    lookupEspmRecordById: (id) => (id === SWORD_BASE ? { record: { type: 'WEAP', fields: [] } } : undefined),
    // The native harvested flag, read through Papyrus
    callPapyrusFunction: (kind, cls, fn, self) => (fn === 'IsHarvested' ? !!props.get(parseInt(self.desc, 16))?.harvested : undefined),
    getUserActor: (u) => users.get(u) ?? 0,
    getUserByActor: userOf,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, text) => packets.push({ u, ...JSON.parse(text) }),
  }
  const sys = new PlacedItemSystem(() => {})
  // Both users have the items loaded
  sys.viewers = () => [...users.keys()]
  const ctx = { svr: mp }
  return {
    props, sys,
    send: (actor, type, target, extra = {}) => sys.customPacket(userOf(actor), type, { target, ...extra }, ctx),
    packets: () => packets.splice(0),
    carriedOn: (id) => props.get(id).ff_carried,
    done: () => sys.releaseBy(mp, CARRIER),
  }
}

const results = []
function test (name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

test('a grab of a plugin item is granted, flags it carried and hides the other viewer\'s copy', () => {
  const t = setup()
  t.send(CARRIER, 'itemGrab', SWORD)
  const sent = t.packets()
  const state = sent.find((p) => p.customPacketType === 'itemGrabState')
  assert.deepEqual([state.u, state.target, state.ok], [1, SWORD, true])
  assert.equal(t.carriedOn(SWORD), CARRIER)
  assert.deepEqual(sent.filter((p) => p.customPacketType === 'itemGrabbed').map((p) => p.u), [2])
  t.send(CARRIER, 'itemRelease', SWORD)
  assert.equal(t.carriedOn(SWORD), 0)
  const moved = t.packets().filter((p) => p.customPacketType === 'itemMoved')
  assert.deepEqual(moved.map((p) => p.u).sort(), [1, 2])
  assert.deepEqual(moved[0].pos, [100, 0, 0])
})

test('a move lands the item on the surface, flags it moved and tells every viewer', () => {
  const t = setup()
  t.send(CARRIER, 'itemGrab', SWORD)
  t.packets()
  t.send(CARRIER, 'itemMove', SWORD, { pos: [50, 20, 10], rot: [0, 0, 90] })
  assert.equal(t.carriedOn(SWORD), 0)
  assert.equal(t.props.get(SWORD).ff_moved, true)
  const loc = t.props.get(SWORD).locationalData
  assert.deepEqual(loc.pos, [50, 20, 10])
  assert.equal(loc.rot[2], 90)
  const moved = t.packets().filter((p) => p.customPacketType === 'itemMoved')
  assert.deepEqual(moved.map((p) => p.u).sort(), [1, 2])
  assert.deepEqual(moved[0].pos, [50, 20, 10])
})

test('a taken plugin item, harvested for good, is refused and never flagged', () => {
  const t = setup()
  t.send(CARRIER, 'itemGrab', TAKEN)
  assert.deepEqual(t.packets().map((p) => [p.u, p.customPacketType, p.ok]), [[1, 'itemGrabState', false]])
  assert.equal(t.carriedOn(TAKEN), undefined)
  t.done()
})

test('a disabled plugin item is refused the same way', () => {
  const t = setup()
  t.send(CARRIER, 'itemGrab', HIDDEN)
  assert.deepEqual(t.packets().map((p) => [p.u, p.customPacketType, p.ok]), [[1, 'itemGrabState', false]])
  assert.equal(t.carriedOn(HIDDEN), undefined)
  t.done()
})

test('a second player cannot activate or grab a carried item', () => {
  const t = setup()
  t.send(CARRIER, 'itemGrab', SWORD)
  t.packets()
  assert.equal(t.sys.onActivate({ get: () => undefined }, SWORD, WATCHER), false)
  t.send(WATCHER, 'itemGrab', SWORD)
  assert.deepEqual(t.packets().map((p) => [p.u, p.customPacketType, p.ok]), [[2, 'itemGrabState', false]])
  assert.equal(t.carriedOn(SWORD), CARRIER)
  t.done()
})

let failed = 0
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) {
    failed++
    console.log(err)
  }
}
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
