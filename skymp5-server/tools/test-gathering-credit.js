'use strict'

// gatheringSystem.ts crediting mastery work with the yield over a stub mp and a stub mastery: one credit per swing's firewood, per ore
// collection, per harvest that costs fatigue (farmer or alchemist for flora and nirnroot, the farmer for a crop), none for a free rack
// taking, a strike that collects nothing or a harvest the native side refused: node tools/test-gathering-credit.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'gatheringSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { GatheringSystem } = compiled.exports

const ACTOR = 0xff000100
const BLOCK = 0x1001
const VEIN = 0x1002
const MARKER = 0x1003
const FLOWER = 0x1004
const WHEAT = 0x1005
const RACK = 0x1006
const NIRNROOT = 0x1007
const FIREWOOD = 0x6f993
const ORE = 0x5ace5
const HOE = 0x4013aa
const CELL = '3c:Skyrim.esm'

let now = 1e12
Date.now = () => now
// The native harvest's hand-over is waited for on the next turn
global.setImmediate = (fn) => fn()
Math.random = () => 0.5

const setup = ({ tired = false, hoe = true } = {}) => {
  const forms = new Map([
    [ACTOR, { profileId: 1, locationalData: { pos: [0, 0, 0], cellOrWorldDesc: CELL }, inventory: { entries: hoe ? [{ baseId: HOE, count: 1 }] : [] } }],
    [BLOCK, { worldOrCellDesc: CELL, pos: [50, 0, 0] }],
    [VEIN, { worldOrCellDesc: CELL, pos: [50, 0, 0] }],
    [MARKER, { worldOrCellDesc: CELL, pos: [60, 0, 0] }],
    [FLOWER, { worldOrCellDesc: CELL, pos: [40, 0, 0] }],
    [WHEAT, { worldOrCellDesc: CELL, pos: [40, 0, 0] }],
    [RACK, { worldOrCellDesc: CELL, pos: [40, 0, 0] }],
    [NIRNROOT, { worldOrCellDesc: CELL, pos: [40, 0, 0] }],
  ])
  const harvested = new Set()
  const added = []
  const packets = []
  const idOf = (desc) => parseInt(desc, 16)
  const mp = {
    get: (id, key) => {
      const f = forms.get(id)
      if (!f) throw new Error('no form')
      return f[key] === undefined ? null : f[key]
    },
    set: (id, key, v) => { forms.get(id)[key] = v },
    getDescFromId: (id) => id.toString(16),
    getIdFromDesc: idOf,
    getUserByActor: (id) => (id === ACTOR ? 1 : 65535),
    isConnected: () => true,
    lookupEspmRecordById: () => null,
    callPapyrusFunction: (_kind, _cls, fn, self, args) => {
      if (fn === 'AddItem') added.push([idOf(args[0].desc), args[1]])
      if (fn === 'IsHarvested') return harvested.has(idOf(self.desc))
      return undefined
    },
    sendCustomPacket: (_user, text) => packets.push(JSON.parse(text)),
  }
  const lines = []
  const paid = []
  const credited = []
  const mastery = {
    rankOf: () => 1,
    rankIn: () => 1,
    hoeFormId: () => HOE,
    creditWork: (id, ...professions) => credited.push([id, professions]),
  }
  const needs = { canPay: () => !tired, pay: (_ctx, id, effort, rank, what) => paid.push([id, effort, rank, what]) }
  const sys = new GatheringSystem((line) => lines.push(line), mastery, needs, { seatOf: () => null })
  const ctx = { svr: mp, gm: { on: () => {}, once: () => {} } }
  const session = (extra) => ({ actorId: ACTOR, furnitureId: BLOCK, kind: 'chop', veinId: 0, resource: FIREWOOD, perStrike: 2, cap: 0, given: 0, strikesPer: 1, strikesLeft: 1, intervalMs: 10000, exitIdle: 0, startedAt: now, nextAt: now, seatedAt: now, ...extra })
  // A harvest as onActivate runs it: the verdict, then the activation going through
  const harvest = (refrId, props, name, grant) => {
    const verdict = sys.harvest(ctx, refrId, ACTOR, props, name, grant)
    if (typeof verdict === 'function') verdict()
    return verdict
  }
  return { sys, ctx, mp, forms, harvested, added, packets, lines, paid, credited, session, harvest }
}

const results = []
function test (name, fn) {
  try {
    now = 1e12
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

test('every swing of the axe credits the woodworker once, with its firewood, and a swing the bar cannot pay for credits nothing', () => {
  const t = setup()
  const s = t.session({})
  t.sys.sessions.set(ACTOR, s)
  t.sys.chopStrike(t.ctx, s)
  t.sys.chopStrike(t.ctx, s)
  assert.deepEqual(t.added, [[FIREWOOD, 2], [FIREWOOD, 2]])
  assert.deepEqual(t.credited, [[ACTOR, ['woodworker']], [ACTOR, ['woodworker']]])
  assert.deepEqual(t.paid.map((p) => p[3]), ['chop', 'chop'])
  const u = setup({ tired: true })
  const su = u.session({})
  u.sys.sessions.set(ACTOR, su)
  u.sys.chopStrike(u.ctx, su)
  assert.deepEqual([u.added, u.credited, u.sys.sessions.size], [[], [], 0], 'too tired: nothing lands, nothing is credited, the sitting ends')
  assert.equal(u.packets.pop().text, 'You are too tired to swing an axe. Rest a while.')
})

test('a vein credits the miner once per ore collection, never for the strikes before it', () => {
  const t = setup()
  const s = t.session({ furnitureId: MARKER, kind: 'mine', veinId: VEIN, resource: ORE, perStrike: 1, cap: 6, strikesPer: 2, strikesLeft: 2, intervalMs: 5000 })
  t.sys.sessions.set(ACTOR, s)
  t.sys.mineStrike(t.ctx, s, now)
  assert.deepEqual([t.added, t.credited], [[], []], 'the first of two strikes collects nothing')
  t.sys.mineStrike(t.ctx, s, now)
  assert.deepEqual(t.added, [[ORE, 1]])
  assert.deepEqual(t.credited, [[ACTOR, ['miner']]])
  assert.deepEqual(t.forms.get(VEIN)['private.gathering'].left, 5)
  for (let i = 0; i < 10; i++) t.sys.mineStrike(t.ctx, s, now)
  assert.deepEqual([t.added.length, t.credited.length, t.sys.sessions.size], [6, 6, 0], 'six ore, six credits, then the vein is empty and the sitting ends')
  assert.equal(t.packets.pop().text, "You can't identify any useful ore.")
})

test('a plant the native harvest handed over is farmer or alchemist work, a crop the farmer\'s, a refused one nobody\'s', () => {
  const t = setup()
  t.harvested.add(FLOWER)
  t.harvest(FLOWER, { instant: 0, free: 0, crop: 0, item: 0x2001, ingredient: 1 }, 'BlueMountainFlower01')
  assert.deepEqual(t.credited, [[ACTOR, ['farmer', 'alchemist']]])
  assert.deepEqual(t.paid.map((p) => p[3]), ['harvest BlueMountainFlower01 flora r1'])
  now += 5000
  t.harvested.add(WHEAT)
  t.harvest(WHEAT, { instant: 0, free: 0, crop: 1, item: 0x2002, ingredient: 0 }, 'Wheat01')
  assert.deepEqual(t.credited[1], [ACTOR, ['farmer']])
  assert.deepEqual(t.paid[1][3], 'harvest Wheat01 crop r1')
  now += 5000
  t.harvest(FLOWER, { instant: 0, free: 0, crop: 0, item: 0x2001, ingredient: 1 }, 'BlueMountainFlower01')
  t.harvested.delete(FLOWER)
  now += 5000
  t.harvest(FLOWER, { instant: 0, free: 0, crop: 0, item: 0x2001, ingredient: 1 }, 'BlueMountainFlower01')
  assert.deepEqual([t.credited.length, t.paid.length], [3, 3], 'a harvest that handed over nothing costs nothing and credits nothing')
  assert.ok(t.lines.some((l) => /harvest of BlueMountainFlower01 1004 handed over nothing, no fatigue taken/.test(l)))
  const u = setup({ hoe: false })
  u.harvested.add(WHEAT)
  assert.equal(u.harvest(WHEAT, { instant: 0, free: 0, crop: 1, item: 0x2002, ingredient: 0 }, 'Wheat01'), false, 'no hoe, no crop')
  assert.deepEqual(u.credited, [])
})

test('a free rack taking credits nobody; a nirnroot the server hands over credits the pickers with it', () => {
  const t = setup()
  t.harvest(RACK, { instant: 1, free: 1, crop: 0, item: 0x2003, ingredient: 0 }, 'HangingRabbit01')
  assert.deepEqual([t.credited, t.paid], [[], []])
  const given = []
  t.harvest(NIRNROOT, { item: 0x2004, harvest: 1, ingredient: 1 }, 'TreeFloraNirnroot01', (count) => given.push(count))
  assert.deepEqual([given, t.credited], [[1], [[ACTOR, ['farmer', 'alchemist']]]])
  assert.deepEqual(t.paid.map((p) => p[3]), ['harvest TreeFloraNirnroot01 flora r1'])
})

let failed = 0
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) { failed++; console.log(err) }
}
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
