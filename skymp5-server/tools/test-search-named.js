'use strict'

// searchSystem.ts against a stub mp: a PK body's window lists property keys and writings by name and lets them move like any other item, every other window keeps them put: node tools/test-search-named.js

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
  const mp = {
    get: (id, key) => {
      const f = forms.get(id)
      if (!f) throw new Error('no form')
      return f[key] === undefined ? null : JSON.parse(JSON.stringify(f[key]))
    },
    set: (id, key, value) => { forms.get(id)[key] = value },
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
  return { mp, packets }
}

;(async () => {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [settingsStub], logLevel: 'error' })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  const { SearchSystem } = compiled.exports

  const { mp, packets } = stubMp()
  const lines = []
  const sys = new SearchSystem((line) => lines.push(line), {})
  sys.namedLoot = (id) => id === PK_BODY
  const ctx = { svr: mp, gm: new EventEmitter() }
  await sys.initAsync(ctx)
  const approved = () => packets.filter((p) => p.customPacketType === 'searchApproved').at(-1)

  // A PK body lists the key by name, and it is taken and put back like any other item
  sys.customPacket(USER, 'searchRequest', { target: PK_BODY }, ctx)
  assert.deepEqual(approved().entries, [{ baseId: GOLD, count: 50 }, { baseId: KEY, count: 1, name: KEY_NAME }])
  assert.equal(mp.onTakeItem(PK_BODY, LOOTER, KEY, 1), true, 'the key is taken from a PK body')
  assert.equal(lines.at(-1), '[take] ff000a01 takes db0e2 x1 from ff000c01')
  assert.equal(mp.onPutItem(PK_BODY, LOOTER, KEY, 1), true, 'and put back')
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
