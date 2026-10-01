'use strict'

// searchSystem.ts against a stub mp: a PK body's window lists property keys and writings by name and lets them move like any other item, a move the native side refuses for want of the name is resynced and never logged as done, every other window keeps them put: node tools/test-search-named.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')
const { EventEmitter } = require('events')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: {} }) }', loader: 'js' }))
  },
}
const source = path.join(__dirname, '..', 'ts', 'systems', 'searchSystem.ts')

const GOLD = 0xf
const KEY = 0xdb0e2
const KEY_NAME = 'Breezehome Key (H1A2B/3)'
const LOOTER = 0xff000a01
const PK_BODY = 0xff000c01
const OWN_BODY = 0xff000b01
const USER = 1

const timers = []
global.setTimeout = (fn) => { timers.push(fn); return timers.length }

function stubMp () {
  const pack = () => ({ entries: [{ baseId: GOLD, count: 50 }, { baseId: KEY, count: 1, name: KEY_NAME }] })
  const forms = new Map([
    [LOOTER, { type: 'MpActor', isDead: false, profileId: 1, pos: [0, 0, 0], inventory: { entries: [] } }],
    [PK_BODY, { type: 'MpActor', isDead: true, profileId: -1, pos: [100, 0, 0], inventory: pack() }],
    [OWN_BODY, { type: 'MpActor', isDead: true, profileId: 4, pos: [0, 100, 0], inventory: pack() }],
  ])
  const packets = []
  const sets = []
  const mp = {
    get: (id, key) => {
      const f = forms.get(id)
      if (!f) throw new Error('no form')
      return f[key] === undefined ? null : JSON.parse(JSON.stringify(f[key]))
    },
    set: (id, key, value) => { sets.push([id, key]); forms.get(id)[key] = value },
    getUserActor: (userId) => (userId === USER ? LOOTER : 0),
    getUserByActor: (id) => (id === LOOTER ? USER : 65535),
    isConnected: (userId) => userId === USER,
    getActorCellOrWorld: () => 0x3c,
    getActorPos: (id) => forms.get(id).pos,
    getIdFromDesc: () => 7,
    lookupEspmRecordById: () => ({}),
    setInventoryOccupant: () => {},
    sendCustomPacket: (userId, json) => packets.push(JSON.parse(json)),
  }
  return { mp, packets, forms, sets }
}

;(async () => {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [settingsStub], logLevel: 'error' })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  const { SearchSystem } = compiled.exports

  const { mp, packets, forms, sets } = stubMp()
  const lines = []
  const sys = new SearchSystem((line) => lines.push(line), {})
  sys.namedLoot = (id) => id === PK_BODY
  const ctx = { svr: mp, gm: new EventEmitter() }
  await sys.initAsync(ctx)
  const approved = () => packets.filter((p) => p.customPacketType === 'searchApproved').at(-1)
  // What the native side does after the hook when it matches the named copy
  const moveKey = (from, to) => {
    const entries = forms.get(from).inventory.entries
    forms.get(to).inventory.entries.push(...entries.splice(entries.findIndex((e) => e.baseId === KEY), 1))
  }
  const afterNative = () => new Promise(setImmediate)
  const resyncs = () => {
    sets.length = 0
    timers.splice(0).forEach((fn) => fn())
    return sets.filter(([id, key]) => id === LOOTER && key === 'inventory').length
  }

  // A PK body lists the key by name, and it is taken and put back like any other item
  sys.customPacket(USER, 'searchRequest', { target: PK_BODY }, ctx)
  assert.deepEqual(approved().entries, [{ baseId: GOLD, count: 50 }, { baseId: KEY, count: 1, name: KEY_NAME }])
  assert.equal(mp.onTakeItem(PK_BODY, LOOTER, KEY, 1), true, 'the key is taken from a PK body')
  moveKey(PK_BODY, LOOTER)
  await afterNative()
  assert.equal(lines.at(-1), '[take] ff000a01 takes db0e2 x1 from ff000c01', 'logged once the native take went through')
  assert.equal(resyncs(), 1, 'the looter\'s pack is resynced after a named move')
  assert.equal(mp.onPutItem(PK_BODY, LOOTER, KEY, 1), true, 'and put back')
  moveKey(LOOTER, PK_BODY)
  await afterNative()
  assert.equal(lines.at(-1), '[put] ff000a01 puts db0e2 x1 into ff000c01')
  assert.equal(resyncs(), 1)

  // An older client's take sends no name, the native side matches no copy and the body keeps the key: no take line, and the looter's phantom copy goes
  assert.equal(mp.onTakeItem(PK_BODY, LOOTER, KEY, 1), true)
  await afterNative()
  assert.equal(lines.at(-1), '[take] ff000a01 take of db0e2 x1 from ff000c01 refused natively: no copy under the name the client sent, the pack is resynced')
  assert.equal(lines.filter((l) => l === '[take] ff000a01 takes db0e2 x1 from ff000c01').length, 1, 'no take line for the take that never happened')
  assert.equal(resyncs(), 1, 'the looter\'s pack is set back from the server')
  assert.equal(mp.onPutItem(PK_BODY, LOOTER, KEY, 1), true)
  await afterNative()
  assert.equal(lines.at(-1), '[put] ff000a01 put of db0e2 x1 into ff000c01 refused natively: no copy under the name the client sent, the pack is resynced')
  assert.equal(resyncs(), 1)
  assert.equal(mp.onTakeItem(PK_BODY, LOOTER, GOLD, 10), true)
  assert.equal(lines.at(-1), '[take] ff000a01 takes f x10 from ff000c01', 'an unnamed base is logged at once')
  assert.equal(resyncs(), 0, 'and not resynced')
  sys.customPacket(USER, 'searchEnd', {}, ctx)
  assert.equal(packets.at(-1).customPacketType, 'searchClose')

  // A player's own body lists it without its name and keeps it put; the gold still moves
  sys.customPacket(USER, 'searchRequest', { target: OWN_BODY }, ctx)
  assert.deepEqual(approved().entries, [{ baseId: GOLD, count: 50 }, { baseId: KEY, count: 1 }])
  assert.equal(mp.onTakeItem(OWN_BODY, LOOTER, KEY, 1), false, 'the key stays on an own body')
  assert.equal(mp.onPutItem(OWN_BODY, LOOTER, KEY, 1), false)
  assert.equal(mp.onTakeItem(OWN_BODY, LOOTER, GOLD, 10), true)
  sys.customPacket(USER, 'searchEnd', {}, ctx)

  // Outside a search the hooks never refuse a key
  assert.equal(mp.onTakeItem(PK_BODY, LOOTER, KEY, 1), true)

  console.log('test-search-named: all passed')
})().catch((e) => { console.error(e); process.exit(1) })
