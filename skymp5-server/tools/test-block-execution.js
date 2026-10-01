'use strict'

// executionSystem.ts at a headsman's block against a stub mp: the marks, the vanilla block events, the chop packet, the kill and release timers and the kneel fallback: node tools/test-block-execution.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')
const { EventEmitter } = require('events')

const stubs = {
  name: 'stubs',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onResolve({ filter: /^discord\.js$/ }, () => ({ path: 'discord', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: globalThis.__execSettings, dataDir: "", loadOrder: [] }) }', loader: 'js' }))
    build.onLoad({ filter: /^discord$/, namespace: 'stub' }, () => ({ contents: 'exports.REST = class {}; exports.Routes = {}', loader: 'js' }))
  },
}
const source = path.join(__dirname, '..', 'ts', 'systems', 'executionSystem.ts')
process.env.ALDUINAK_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'block-exec-'))

const HEADSMAN = 0xff000a01
const PRISONER = 0xff000b01
const VIEWER = 0xff000c01
const FAR = 0xff000d01
const BLOCK = 0xaa7cc
const TORCH = 0x1d4ec
const SWORD = 0x12eb7
const BLOCK_POS = [15671.1, -81493.4, 8203.3]
const BLOCK_YAW = 269.3

const timers = []
global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
const runTimer = (ms) => {
  const i = timers.findIndex((t) => t.ms === ms)
  assert.notEqual(i, -1, `a timer at ${ms} ms`)
  timers.splice(i, 1)[0].fn()
}

function stubMp () {
  const actor = (user, extra = {}) => ({ type: 'MpActor', isDead: false, profileId: user, baseDesc: '7:Skyrim.esm', worldOrCellDesc: '3c:Skyrim.esm', cell: 0x3c, angle: [0, 0, 0], equipment: { inv: { entries: [] } }, actorNeighbors: [], ...extra })
  const forms = new Map([
    [HEADSMAN, actor(1, { pos: [15600, -81450, 8203] })],
    [PRISONER, actor(2, { pos: [15620, -81460, 8203], 'private.restrained': { boundHands: true }, actorNeighbors: [HEADSMAN, VIEWER] })],
    [VIEWER, actor(3, { pos: [15000, -81000, 8203] })],
    [FAR, actor(4, { pos: [0, 0, 0] })],
    [BLOCK, { type: 'MpObjectReference', baseDesc: '2e8eb:Skyrim.esm', worldOrCellDesc: '3c:Skyrim.esm', pos: BLOCK_POS, angle: [0, 0, BLOCK_YAW] }],
  ])
  const users = new Map([[HEADSMAN, 1], [PRISONER, 2], [VIEWER, 3], [FAR, 4]])
  const state = { drawn: new Set(), sneaking: new Set() }
  const packets = []
  const ids = (desc) => parseInt(String(desc).split(':')[0], 16)
  const mp = {
    get: (id, key) => {
      if (id === 0 && key === 'onlinePlayers') return [...users.keys()]
      const f = forms.get(id)
      if (!f) throw new Error('no form')
      if (key === 'locationalData') return { cellOrWorldDesc: f.worldOrCellDesc, pos: f.pos, rot: f.angle }
      const v = f[key]
      return v === undefined ? null : JSON.parse(JSON.stringify(v))
    },
    set: (id, key, value) => {
      const f = forms.get(id)
      if (!f) throw new Error('no form')
      if (key === 'locationalData') {
        f.pos = value.pos
        f.angle = value.rot
      }
      f[key] = JSON.parse(JSON.stringify(value))
    },
    getUserActor: (u) => [...users].find(([, v]) => v === u)?.[0] ?? 0,
    getUserByActor: (id) => users.has(id) ? users.get(id) : 65535,
    isConnected: (u) => [...users.values()].includes(u),
    getActorCellOrWorld: (id) => forms.get(id).cell,
    getActorPos: (id) => forms.get(id).pos,
    getNeighborsByPosition: () => [BLOCK, HEADSMAN, PRISONER],
    getIdFromDesc: ids,
    getDescFromId: (id) => id.toString(16),
    lookupEspmRecordById: (id) => id === TORCH ? { record: { type: 'LIGH' } }
      : id === SWORD ? { record: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([1]) }] } } : null,
    callPapyrusFunction: (_kind, _cls, fn, self) => {
      const target = ids(self.desc)
      if (fn === 'IsWeaponDrawn') return state.drawn.has(target)
      if (fn === 'GetAnimationVariableBool') return state.sneaking.has(target)
      return undefined
    },
    sendCustomPacket: (u, text) => packets.push({ u, ...JSON.parse(text) }),
  }
  return { mp, forms, users, state, packets }
}

async function setup () {
  globalThis.__execSettings = {}
  const s = stubMp()
  const lines = []
  const calls = []
  const capture = {
    menuFlagProviders: [], interactRange: 300,
    carriedOf: () => 0,
    freeCaptive: (_ctx, id) => calls.push(['freed', id]),
  }
  const bleedout = {
    isDowned: (id) => s.forms.get(id)?.downed === true,
    die: (id, how, killer) => { calls.push(['died', id, how, killer]); s.forms.get(id).isDead = true },
    hold: () => '',
    completeHold: () => {},
  }
  const factions = { canExecute: () => true, borderRefusal: () => '', factionsWith: () => ['hold:falkreath'] }
  const afterlife = { sendToSovngarde: (id) => calls.push(['sovngarde', id]) }
  const bodies = { leaveBody: (id) => calls.push(['body', id]) }
  const seats = { seatOf: () => undefined }
  const sys = new ExecutionSystem((line) => lines.push(line), capture, bleedout, factions, afterlife, bodies, seats)
  const ctx = { svr: s.mp, gm: new EventEmitter() }
  await sys.initAsync(ctx)
  timers.length = 0
  const request = (actorId, type, target, extra = {}) => sys.customPacket(s.users.get(actorId), type, { target, ...extra })
  const sent = (actorId, type) => s.packets.filter((p) => p.u === s.users.get(actorId) && p.customPacketType === type)
  const notices = (actorId) => sent(actorId, 'notification').map((p) => p.text)
  return { ...s, sys, ctx, capture, lines, calls, request, sent, notices }
}

const near = (actual, expected, what) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 0.05, `${what}[${i}] ${v} vs ${expected[i]}`))

let ExecutionSystem

;(async () => {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [stubs], packages: 'external' })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  ExecutionSystem = compiled.exports.ExecutionSystem

  const yaw = BLOCK_YAW * Math.PI / 180
  // The prisoner's mark: 87.7 ahead, 68.8 right, turned 270 degrees
  const prisonerMark = [
    BLOCK_POS[0] + Math.sin(yaw) * 87.7 + Math.cos(yaw) * 68.8,
    BLOCK_POS[1] + Math.cos(yaw) * 87.7 - Math.sin(yaw) * 68.8,
    BLOCK_POS[2],
  ]

  {
    const t = await setup()
    t.request(HEADSMAN, 'prepareExecutionRequest', PRISONER)
    near(t.forms.get(PRISONER).pos, prisonerMark, 'prisoner on the mark')
    assert.ok(Math.abs(t.forms.get(PRISONER).angle[2] - (BLOCK_YAW + 270 - 360)) < 0.01, 'turned 270 degrees, kept within 0-360')
    assert.deepEqual(t.sent(PRISONER, 'executionState').map((p) => p.pose), ['IdleExecutioneeIdle'], 'the vanilla block kneel')
    assert.equal(t.forms.get(PRISONER).lastAnimEvent, 'IdleExecutioneeIdle', 'mirrored for late viewers')
    assert.match(t.lines.join('\n'), /ff000a01 puts ff000b01 on block aa7cc at the prisoner's mark \(15583, -81426, 8203\) yaw 179, IdleExecutioneeIdle/)

    t.state.drawn.add(HEADSMAN)
    t.request(HEADSMAN, 'executeRequest', PRISONER)
    assert.equal(t.notices(HEADSMAN).at(-1), 'Sheathe your weapon first.')
    t.state.drawn.delete(HEADSMAN)
    t.state.sneaking.add(HEADSMAN)
    t.request(HEADSMAN, 'executeRequest', PRISONER)
    assert.equal(t.notices(HEADSMAN).at(-1), 'Stand up first.')
    t.state.sneaking.delete(HEADSMAN)
    t.forms.get(HEADSMAN).equipment = { inv: { entries: [{ baseId: TORCH, count: 1, wornLeft: true }] } }
    t.request(HEADSMAN, 'executeRequest', PRISONER)
    assert.equal(t.notices(HEADSMAN).at(-1), 'Put away your torch first.')
    t.forms.get(HEADSMAN).equipment = { inv: { entries: [{ baseId: TORCH, count: 1 }] } }
    assert.equal(t.sent(HEADSMAN, 'executionChop').length, 0, 'no chop on a refusal')

    t.request(HEADSMAN, 'executeRequest', PRISONER)
    assert.deepEqual(t.forms.get(HEADSMAN).pos, BLOCK_POS, 'the headsman stands on the block origin')
    assert.equal(t.forms.get(HEADSMAN).angle[2], BLOCK_YAW, 'facing the block yaw')
    assert.deepEqual(t.sent(HEADSMAN, 'executionState').map((p) => [p.pose, p.exit]), [['IdleExecutionerIdle', 'IdleChairExitStart']])
    assert.equal(t.forms.get(HEADSMAN).lastAnimEvent, 'IdleExecutionerIdle')
    const chops = t.packets.filter((p) => p.customPacketType === 'executionChop')
    assert.deepEqual(chops.map((p) => p.u).sort(), [1, 2, 3], 'both participants and the viewer, not the far player')
    const chop = chops[0]
    assert.equal(chop.executor, HEADSMAN)
    assert.equal(chop.prisoner, PRISONER)
    assert.equal(chop.inMs, 3000)
    assert.equal(chop.ms, 24000)
    near(chop.headsmanSpot.pos, BLOCK_POS, 'headsman spot')
    near(chop.prisonerSpot.pos, prisonerMark, 'prisoner spot')
    assert.deepEqual(timers.map((x) => x.ms).sort((a, b) => a - b), [19610, 24000])
    assert.match(t.lines.join('\n'), /ff000a01 executes ff000b01 at block aa7cc: headsman moved to his mark \(15671, -81493, 8203\) yaw 269, IdleExecutionerIdle; chop \d+ on every client in 3000 ms \(prisoner in IdleExecutioneeIdle\), the kill at \+19610 ms, IdleChairExitStart at \+24000 ms/)

    t.request(HEADSMAN, 'executeRequest', PRISONER)
    assert.equal(t.notices(HEADSMAN).at(-1), 'You cannot do that now.', 'one chop at a time')
    assert.equal(t.capture.blockRefusal(PRISONER), 'The axe is already falling.')

    t.request(PRISONER, 'executionStep', PRISONER, { seq: chop.seq, step: 'IdleExecutionerChop on the prisoner 14 (this player): taken' })
    assert.match(t.lines.join('\n'), /block step from ff000b01's client on ff000b01 \(chop \d+\): IdleExecutionerChop on the prisoner 14 \(this player\): taken/)
    t.request(VIEWER, 'executionStep', PRISONER, { step: 'spam' })
    assert.ok(!t.lines.join('\n').includes('spam'), 'a bystander is not logged')

    runTimer(19610)
    assert.deepEqual(t.calls.slice(0, 3), [['died', PRISONER, 'executed', HEADSMAN], ['body', PRISONER], ['freed', PRISONER]])
    assert.ok(t.calls.some((c) => c[0] === 'sovngarde' && c[1] === PRISONER))
    assert.equal(t.sent(PRISONER, 'executionState').at(-1).pose, '', 'off the block')
    assert.equal(t.forms.get(PRISONER).lastAnimEvent, 'IdleForceDefaultState')
    assert.match(t.lines.join('\n'), /ff000b01 left block aa7cc/)
    assert.equal(t.sent(HEADSMAN, 'executionState').length, 1, 'the headsman keeps the stance until his swing is over')

    runTimer(24000)
    assert.deepEqual(t.sent(HEADSMAN, 'executionState').map((p) => p.pose), ['IdleExecutionerIdle', ''])
    assert.equal(t.forms.get(HEADSMAN).lastAnimEvent, 'IdleChairExitStart')
    assert.match(t.lines.join('\n'), /ff000a01 steps off the block after the chop of ff000b01 \(IdleChairExitStart\)/)
  }

  {
    const t = await setup()
    t.request(HEADSMAN, 'prepareExecutionRequest', PRISONER)
    t.request(PRISONER, 'executionStep', PRISONER, { step: 'IdleExecutioneeIdle never taken (weapon drawn false)', fallback: 'kneel' })
    assert.deepEqual(t.sent(PRISONER, 'executionState').map((p) => p.pose), ['IdleExecutioneeIdle', 'bleedOutStart'])
    assert.equal(t.forms.get(PRISONER).lastAnimEvent, 'bleedOutStart')
    assert.match(t.lines.join('\n'), /ff000b01 kneels in bleedOutStart instead: their graph never took IdleExecutioneeIdle/)
    t.request(PRISONER, 'executionStep', PRISONER, { step: 'again', fallback: 'kneel' })
    assert.equal(t.sent(PRISONER, 'executionState').length, 2, 'the fallback is sent once')
    t.request(HEADSMAN, 'executeRequest', PRISONER)
    assert.match(t.lines.join('\n'), /\(prisoner in bleedOutStart\)/)
    t.request(PRISONER, 'executionStep', PRISONER, { step: 'late', fallback: 'kneel' })
    assert.equal(t.sent(PRISONER, 'executionState').length, 2, 'no fallback once the axe falls')
  }

  {
    const t = await setup()
    t.request(HEADSMAN, 'prepareExecutionRequest', PRISONER)
    t.request(PRISONER, 'executionStep', PRISONER, { step: 'refused', fallback: 'kneel' })
    t.capture.releaseFromBlock(PRISONER)
    assert.equal(t.forms.get(PRISONER).lastAnimEvent, 'bleedOutStop', 'the bleedout kneel leaves through its own exit')
  }

  {
    const t = await setup()
    t.forms.get(PRISONER).downed = true
    t.forms.get(PRISONER)['private.restrained'] = null
    t.forms.get(HEADSMAN).equipment = { inv: { entries: [{ baseId: SWORD, count: 1, worn: true }] } }
    t.state.drawn.add(HEADSMAN)
    t.request(HEADSMAN, 'finishOffRequest', PRISONER)
    const pairs = t.packets.filter((p) => p.customPacketType === 'pairedIdle')
    assert.deepEqual(pairs.map((p) => p.u).sort(), [1, 2, 3], 'the finish off still reaches both players and the viewer')
  }

  console.log('test-block-execution: all checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
