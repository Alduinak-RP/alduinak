'use strict'

// captureSystem.ts door watch against a stub mp: a carrier holding a player is refused at a door that teleports: node tools/test-carry-door.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'captureSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { CaptureSystem } = compiled.exports

const DOOR_BASE = 0x00031897
const CHEST_BASE = 0x00031898
const LOAD_DOOR = 0x0001a700
const PLAIN_DOOR = 0x0001a701
const CHEST = 0x0001a702
const TWIN = 0x0001a6ff
const NPC_BASE = 0x00013bbf
const [CARRIER, CAPTIVE, PET, WALKER] = [0xff000014, 0xff000027, 0xff000041, 0xff00001a]
const NOTICE = 'Set them down before going through this door.'

const xtel = (id) => ({ type: 'XTEL', data: Uint8Array.from([id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, (id >>> 24) & 0xff]) })

function setup () {
  const props = new Map([
    [LOAD_DOOR, { baseDesc: 'door' }],
    [PLAIN_DOOR, { baseDesc: 'door' }],
    [CHEST, { baseDesc: 'chest' }],
    [CARRIER, { baseDesc: 'player', profileId: 20 }],
    [CAPTIVE, { baseDesc: 'player', profileId: 1 }],
    [WALKER, { baseDesc: 'player', profileId: 7 }],
    [PET, { baseDesc: 'npc', profileId: -1 }],
  ])
  const records = new Map([
    [DOOR_BASE, { type: 'DOOR', fields: [] }],
    [CHEST_BASE, { type: 'CONT', fields: [] }],
    [NPC_BASE, { type: 'NPC_', fields: [] }],
    [LOAD_DOOR, { type: 'REFR', fields: [xtel(TWIN)] }],
    [PLAIN_DOOR, { type: 'REFR', fields: [] }],
    [CHEST, { type: 'REFR', fields: [] }],
  ])
  const bases = { door: DOOR_BASE, chest: CHEST_BASE, player: 0x7, npc: NPC_BASE }
  const users = new Map([[1, CARRIER], [2, CAPTIVE], [3, WALKER]])
  const packets = []
  const chained = []
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      return props.get(id)[key]
    },
    getIdFromDesc: (desc) => bases[desc],
    lookupEspmRecordById: (id) => {
      if (!records.has(id)) throw new Error('no record')
      return { record: records.get(id), toGlobalRecordId: (local) => local }
    },
    getUserByActor: (actorId) => [...users].find(([, a]) => a === actorId)?.[0] ?? -1,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, text) => packets.push({ actor: users.get(u), ...JSON.parse(text) }),
    // Stands for the door override and the native teleport behind it
    onActivate: (targetId, casterId) => { chained.push([targetId, casterId]); return true },
  }
  const lines = []
  const sys = new CaptureSystem((line) => lines.push(line))
  const ctx = { svr: mp }
  sys.installDoorWatch(ctx)
  const carry = (carrier, carried) => {
    sys.carrying.set(carrier, carried)
    sys.carriedBy.set(carried, carrier)
  }
  return { mp, sys, packets, chained, lines, carry }
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

test('a carrier holding a player is refused at a load door and told to set them down', () => {
  const t = setup()
  t.carry(CARRIER, CAPTIVE)
  assert.equal(t.mp.onActivate(LOAD_DOOR, CARRIER), false)
  assert.deepEqual(t.chained, [])
  assert.deepEqual(t.packets, [{ actor: CARRIER, customPacketType: 'captureNotice', text: NOTICE }])
  assert.deepEqual(t.lines, ['[carry] ff000014 refused at load door 1a700 while carrying ff000027'])
  assert.equal(t.sys.doorUsedAt.has(CARRIER), false)
  assert.equal(t.sys.carriedOf(CARRIER), CAPTIVE)
})

test('a held key gets one notice and one log line, every press refused', () => {
  const t = setup()
  t.carry(CARRIER, CAPTIVE)
  for (let i = 0; i < 5; i++) assert.equal(t.mp.onActivate(LOAD_DOOR, CARRIER), false)
  assert.equal(t.packets.length, 1)
  assert.equal(t.lines.length, 1)
  t.sys.doorNoticeAt.set(CARRIER, Date.now() - 2001)
  assert.equal(t.mp.onActivate(LOAD_DOOR, CARRIER), false)
  assert.equal(t.packets.length, 2)
})

test('a plain door opens for a carrier and counts as a door used', () => {
  const t = setup()
  t.carry(CARRIER, CAPTIVE)
  assert.equal(t.mp.onActivate(PLAIN_DOOR, CARRIER), true)
  assert.deepEqual(t.chained, [[PLAIN_DOOR, CARRIER]])
  assert.deepEqual(t.packets, [])
  assert.equal(t.sys.doorUsedAt.has(CARRIER), true)
})

test('a carried pet goes through a load door with its carrier', () => {
  const t = setup()
  t.carry(CARRIER, PET)
  assert.equal(t.mp.onActivate(LOAD_DOOR, CARRIER), true)
  assert.deepEqual(t.chained, [[LOAD_DOOR, CARRIER]])
  assert.deepEqual(t.packets, [])
  assert.equal(t.sys.doorUsedAt.has(CARRIER), true)
})

test('a player carrying nobody and a carrier at a chest are left alone', () => {
  const t = setup()
  t.carry(CARRIER, CAPTIVE)
  assert.equal(t.mp.onActivate(LOAD_DOOR, WALKER), true)
  assert.equal(t.mp.onActivate(CHEST, CARRIER), true)
  assert.deepEqual(t.chained, [[LOAD_DOOR, WALKER], [CHEST, CARRIER]])
  assert.deepEqual(t.packets, [])
  assert.equal(t.sys.doorUsedAt.size, 0)
})

test('the load door opens again once the captive is set down', () => {
  const t = setup()
  t.carry(CARRIER, CAPTIVE)
  assert.equal(t.mp.onActivate(LOAD_DOOR, CARRIER), false)
  t.sys.carrying.delete(CARRIER)
  t.sys.carriedBy.delete(CAPTIVE)
  assert.equal(t.mp.onActivate(LOAD_DOOR, CARRIER), true)
  assert.deepEqual(t.chained, [[LOAD_DOOR, CARRIER]])
})

test('carryState tells the client of the carrier that the load is a player, and only then', () => {
  const t = setup()
  const state = (carrying, target) => {
    t.packets.length = 0
    t.sys.sendCarryState({ svr: t.mp }, CARRIER, carrying, target)
    const { player, target: npc } = t.packets[0]
    return { player, npc }
  }
  assert.deepEqual(state(true, CAPTIVE), { player: true, npc: 0 })
  assert.deepEqual(state(true, PET), { player: false, npc: PET })
  assert.deepEqual(state(false, CAPTIVE), { player: false, npc: 0 })
  assert.deepEqual(state(false), { player: false, npc: 0 })
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
