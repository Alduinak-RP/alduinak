'use strict'

// torchSystem.ts against a stub mp and a fake clock: lighting, putting out, relogs, character select, the burn-out and the 0 switch: node tools/test-torch.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')
const { EventEmitter } = require('events')

// The settings module reads server-settings.json; the test hands its own
const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: globalThis.__torchSettings }) }', loader: 'js' }))
  },
}
const source = path.join(__dirname, '..', 'ts', 'systems', 'torchSystem.ts')
let TorchSystem

const ACTOR = 0xff000d66
const OTHER = 0xff000d67
const TORCH = 0x1d4ec
const DLC_TORCH = 0x2015374
const SWORD = 0x12eb7
const TYPES = { [TORCH]: 'LIGH', [DLC_TORCH]: 'LIGH', [SWORD]: 'WEAP' }

let now = 1_000_000
Date.now = () => now
const minutes = (n) => { now += n * 60000 }

function stubMp (user = 4) {
  const props = new Map([[ACTOR, { profileId: 7, inventory: { entries: [{ baseId: TORCH, count: 3 }, { baseId: SWORD, count: 1 }] } }], [OTHER, { profileId: 8, inventory: { entries: [] } }]])
  const state = { user, actorOfUser: ACTOR }
  const packets = []
  const papyrus = []
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      const v = props.get(id)[key]
      return v === undefined ? null : JSON.parse(JSON.stringify(v))
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      props.get(id)[key] = JSON.parse(JSON.stringify(value))
    },
    getUserByActor: (id) => (state.user >= 0 && id === state.actorOfUser ? state.user : -1),
    getUserActor: (u) => (u === state.user ? state.actorOfUser : 0),
    isConnected: (u) => u === state.user,
    getActorName: () => 'Eerik',
    getDescFromId: (id) => id.toString(16),
    lookupEspmRecordById: (id) => (TYPES[id] ? { record: { type: TYPES[id] } } : null),
    callPapyrusFunction: (...args) => papyrus.push(args),
    sendCustomPacket: (u, text) => packets.push({ u, ...JSON.parse(text) }),
  }
  return { mp, props, state, packets, papyrus, p: props.get(ACTOR) }
}

const report = (entries) => ({ inv: { entries }, numChanges: 1 })
const holding = (baseId = TORCH) => report([{ baseId, count: 1, wornLeft: true }, { baseId: SWORD, count: 1, worn: true }])
const empty = report([{ baseId: TORCH, count: 3 }, { baseId: SWORD, count: 1, worn: true }])

async function setup (settings, s = stubMp()) {
  globalThis.__torchSettings = settings
  const lines = []
  const sys = new TorchSystem((line) => lines.push(line))
  const ctx = { svr: s.mp, gm: new EventEmitter() }
  await sys.initAsync(ctx)
  const send = (eq, allowed = true) => s.mp.onUpdateEquipmentAttempt(ACTOR, eq, allowed)
  const poll = () => sys.updateAsync(ctx)
  return { ...s, sys, ctx, lines, send, poll }
}

const torchCount = (p) => p.inventory.entries.filter((e) => e.baseId === TORCH).reduce((n, e) => n + e.count, 0)

;(async () => {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [settingsStub] })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  TorchSystem = compiled.exports.TorchSystem
  // updateAsync sleeps first; the test runs one poll at a time
  global.setTimeout = (fn) => { fn(); return 0 }

  // 0 switches it off: no hook at all
  let t = await setup({ torchBurnMinutes: 0 })
  assert.equal(t.mp.onUpdateEquipmentAttempt, undefined)
  assert.deepEqual(t.lines, ['[torch] held torches never burn out (torchBurnMinutes 0)'])

  // Default 15, chained after an earlier hook that still runs
  const s = stubMp()
  const seen = []
  s.mp.onUpdateEquipmentAttempt = (id) => { seen.push(id); return true }
  t = await setup({}, s)
  assert.equal(t.lines[0], '[torch] a held torch burns out after 15 min of use')
  assert.equal(t.send(empty), true)
  assert.deepEqual(seen, [ACTOR])
  assert.equal(t.lines.length, 1, 'no light, nothing logged')

  // Lit, ten minutes, put away: saved by the next poll
  t.send(holding())
  assert.equal(t.lines[1], '[torch] ff000d66 lights 1d4ec, 0 of 15 min burned')
  minutes(10)
  await t.poll()
  assert.equal(t.p['private.torchBurnMs'], 600000, 'the minute save while burning')
  t.send(holding())
  t.send(empty)
  assert.equal(t.lines[2], '[torch] ff000d66 torch 1d4ec unequipped at 10 of 15 min')
  minutes(30)
  await t.poll()
  assert.equal(t.p['private.torchBurnMs'], 600000)

  // A restart reads the stored burn; a refused report reads the server's equipment
  s.mp.onUpdateEquipmentAttempt = undefined
  t = await setup({}, { ...s, p: s.props.get(ACTOR) })
  t.p.equipment = holding()
  t.send(report([{ baseId: 0xdead, count: 1, worn: true }]), false)
  assert.equal(t.lines[1], '[torch] ff000d66 lights 1d4ec, 10 of 15 min burned')

  // Disconnect stops the clock at once
  minutes(2)
  s.state.user = -1
  t.sys.disconnect(4, t.ctx)
  assert.equal(t.lines[2], '[torch] ff000d66 torch 1d4ec offline at 12 of 15 min')
  assert.equal(t.p['private.torchBurnMs'], 720000)
  minutes(60)

  // Back online, a different torch carries the same burn; three minutes later it burns out
  s.state.user = 5
  t.p.inventory.entries.push({ baseId: DLC_TORCH, count: 1 })
  t.send(holding(DLC_TORCH))
  assert.equal(t.lines[3], '[torch] ff000d66 lights 2015374, 12 of 15 min burned')
  t.send(holding())
  minutes(2.9)
  await t.poll()
  assert.equal(t.papyrus.length, 0)
  minutes(0.1)
  await t.poll()
  assert.deepEqual(t.papyrus, [['method', 'Actor', 'UnequipItem', { type: 'form', desc: 'ff000d66' }, [{ type: 'espm', desc: '1d4ec' }, false, true]]])
  assert.equal(torchCount(t.p), 2, 'one torch taken from the server inventory')
  assert.deepEqual(t.packets, [{ u: 5, customPacketType: 'notification', text: 'Your torch burns out.' }])
  assert.equal(t.lines[4], '[torch] ff000d66 [profile 7] "Eerik": torch 1d4ec burned out after 15 min of use, 2 left')
  assert.equal(t.p['private.torchBurnMs'], 0)

  // The next torch starts fresh
  t.send(empty)
  t.send(holding())
  assert.equal(t.lines[5], '[torch] ff000d66 lights 1d4ec, 0 of 15 min burned')

  // Switching character puts it out at the next poll
  s.state.actorOfUser = OTHER
  minutes(1)
  await t.poll()
  assert.equal(t.lines[6], '[torch] ff000d66 torch 1d4ec offline at 1 of 15 min')
  assert.equal(t.p['private.torchBurnMs'], 60000)
  s.state.actorOfUser = ACTOR

  // Character select puts it out and saves at the request itself, the body still owned by the user, even when spawn's guard (a request within 10 s of the assign or 15 s of the last one) sends no park event
  const menuRequest = () => t.sys.customPacket(5, 'characterSelectMenuRequest', {}, t.ctx)
  t.send(holding())
  assert.equal(t.lines[7], '[torch] ff000d66 lights 1d4ec, 1 of 15 min burned')
  minutes(1)
  t.sys.customPacket(5, 'chatMessage', {}, t.ctx)
  menuRequest()
  assert.equal(t.lines[8], '[torch] ff000d66 torch 1d4ec offline at 2 of 15 min')
  assert.equal(t.p['private.torchBurnMs'], 120000)
  minutes(30)
  await t.poll()
  menuRequest()
  t.ctx.gm.emit('userMenuQuit', 5, ACTOR)
  assert.equal(t.lines.length, 9, 'nothing burning, nothing logged')
  assert.equal(t.p['private.torchBurnMs'], 120000)

  // A torch the server inventory lacks never lights, and a weapon is not a light
  t.p.inventory.entries = t.p.inventory.entries.filter((e) => e.baseId !== TORCH)
  t.send(holding())
  t.send(report([{ baseId: SWORD, count: 1, worn: true }]))
  assert.equal(t.lines.length, 9)

  // Burning out the last torch
  t.p.inventory.entries.push({ baseId: TORCH, count: 1 })
  t.p['private.torchBurnMs'] = 14.5 * 60000
  t.send(holding())
  minutes(0.5)
  await t.poll()
  assert.equal(torchCount(t.p), 0)
  assert.match(t.lines[t.lines.length - 1], /burned out after 15 min of use, 0 left$/)

  // A short test setting
  t = await setup({ torchBurnMinutes: 0.5 }, stubMp())
  t.send(holding())
  minutes(0.5)
  await t.poll()
  assert.match(t.lines[t.lines.length - 1], /burned out after 0.5 min of use, 2 left$/)

  console.log('test-torch: all passed')
})().catch((e) => { console.error(e); process.exit(1) })
