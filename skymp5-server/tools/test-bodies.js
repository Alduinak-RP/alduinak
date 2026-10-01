'use strict'

// bodySystem.ts against a stub mp and a fake clock: the move of the whole pack from victim to body, failures that give the pack back, worn pieces, removal only once emptied and restarts: node tools/test-bodies.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')
const { EventEmitter } = require('events')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onResolve({ filter: /^discord\.js$/ }, () => ({ path: 'discord', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: globalThis.__bodySettings }) }', loader: 'js' }))
    build.onLoad({ filter: /^discord$/, namespace: 'stub' }, () => ({ contents: 'exports.REST = class {}; exports.Routes = {}', loader: 'js' }))
  },
}
const source = path.join(__dirname, '..', 'ts', 'systems', 'bodySystem.ts')
let BodySystem

const VICTIM = 0xff000d66
const GOLD = 0xf
const SWORD = 0x12eb7
const CUIRASS = 0x12e49
const KEY = 0xdb0e2
const SPELL = 0x12fcd
// A base the load order no longer holds, so no search window can show it
const STALE = 0x7f00001
const TOTAL = { [GOLD]: 120, [SWORD]: 1, [CUIRASS]: 1, [KEY]: 1 }

let now = 1_000_000
Date.now = () => now
const seconds = (n) => { now += n * 1000 }
const timers = []
global.setTimeout = (fn) => { timers.push(fn); return 0 }
const runTimers = () => timers.splice(0).forEach((fn) => fn())

const victimPack = () => ({ entries: [
  { baseId: GOLD, count: 120 },
  { baseId: SWORD, count: 1, worn: true },
  { baseId: CUIRASS, count: 1, worn: true },
  { baseId: KEY, count: 1, name: 'Breezehome key' },
] })

// refuse: { prop: true | 'body' } makes that set throw, as an unregistered property does
function stubMp (refuse = {}) {
  const props = new Map([[VICTIM, {
    type: 'MpActor', profileId: 7, isDead: true, appearance: { name: 'Eerik' },
    locationalData: { cellOrWorldDesc: '3c:Skyrim.esm', pos: [1, 2, 3], rot: [0, 0, 90] },
    inventory: victimPack(),
    equipment: { inv: { entries: [{ baseId: SWORD, count: 1, worn: true }, { baseId: CUIRASS, count: 1, worn: true }] }, leftSpell: SPELL, numChanges: 5 },
  }]])
  let next = 0xff100000
  const order = []
  const respawned = []
  const destroyed = []
  // Every item has one owner at every moment: the victim and the bodies never hold more than the victim had
  const checkOwners = () => {
    const held = {}
    for (const p of props.values()) {
      for (const e of p.inventory?.entries ?? []) held[e.baseId] = (held[e.baseId] ?? 0) + e.count
    }
    for (const base of Object.keys(held)) assert.ok(held[base] <= (TOTAL[base] ?? 0), `duplicated ${Number(base).toString(16)}: ${held[base]}`)
  }
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      const v = props.get(id)[key]
      return v === undefined ? null : JSON.parse(JSON.stringify(v))
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      if (refuse[key] === true || (refuse[key] === 'body' && id !== VICTIM)) throw new Error(`Property '${key}' doesn't exist`)
      order.push(`${id === VICTIM ? 'victim' : 'body'}.${key}`)
      props.get(id)[key] = JSON.parse(JSON.stringify(value ?? null))
      if (key === 'inventory') checkOwners()
    },
    createActor: () => {
      const id = next++
      props.set(id, { type: 'MpActor', profileId: -1, isDead: false, inventory: { entries: [] } })
      return id
    },
    destroyActor: (id) => { destroyed.push(id); props.delete(id) },
    getIdFromDesc: () => 0x3c,
    respawnActor: (id) => { respawned.push(id); props.get(id).isDead = false },
    lookupEspmRecordById: (id) => ({ record: id === STALE ? null : { type: 'MISC' } }),
    findFormsByPropertyValue: (key, value) => [...props.keys()].filter((id) => props.get(id)[key] === value),
  }
  return { mp, props, order, respawned, destroyed, v: props.get(VICTIM) }
}

const countOf = (inv, base) => (inv?.entries ?? []).filter((e) => e.baseId === base).reduce((n, e) => n + e.count, 0)
const owned = (s, base) => [...s.props.values()].reduce((n, p) => n + countOf(p.inventory, base), 0)

async function setup (settings = {}, s = stubMp()) {
  globalThis.__bodySettings = settings
  const lines = []
  const sys = new BodySystem((line) => lines.push(line))
  const ctx = { svr: s.mp, gm: new EventEmitter() }
  await sys.initAsync(ctx)
  ctx.gm.emit('worldLoaded')
  const poll = async () => { seconds(3); await sys.updateAsync(ctx) }
  return { ...s, sys, ctx, lines, poll }
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bodies-'))
  process.chdir(dir)
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [settingsStub], logLevel: 'error' })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  BodySystem = compiled.exports.BodySystem

  // The move: the body stands empty, the victim is stripped, then the body takes the whole pack, the named key with its name
  let t = await setup()
  const bodyId = t.sys.leaveBody(VICTIM, 'finished off by ff000011')
  assert.ok(bodyId)
  const b = t.props.get(bodyId)
  assert.deepEqual(t.order.filter((o) => /inventory|isDead|locationalData|ff_body/.test(o)),
    ['body.ff_body', 'body.isDead', 'body.locationalData', 'victim.inventory', 'body.inventory'])
  assert.equal(b.ff_body, true)
  assert.deepEqual(b['private.pkBody'], { victimId: VICTIM, profileId: 7, at: now }, 'the body carries its own record')
  assert.equal(b['private.indexed.pkBody'], 'on')
  assert.deepEqual(b.equipment, { inv: { entries: [{ baseId: SWORD, count: 1, worn: true }, { baseId: CUIRASS, count: 1, worn: true }] }, numChanges: 0 }, 'worn pieces shown, no spell')
  assert.ok(b.inventory.entries.every((e) => !e.worn && !e.wornLeft), 'the pack itself carries no worn flags, so every stack is takeable')
  assert.deepEqual(b.inventory.entries.find((e) => e.baseId === KEY), { baseId: KEY, count: 1, name: 'Breezehome key' }, 'the key moves with its name')
  assert.deepEqual(t.v.inventory.entries, [], 'the victim keeps nothing, keys and writings included')
  assert.deepEqual(t.v.equipment.inv.entries, [], 'the victim wears nothing')
  assert.equal(t.v.equipment.leftSpell, SPELL, 'spells stay')
  for (const base of Object.keys(TOTAL)) assert.equal(owned(t, Number(base)), TOTAL[base], `nothing lost of ${Number(base).toString(16)}`)
  assert.equal(t.lines.at(-1), '[body] ff000d66 finished off by ff000011: body ff100000 holds 123 item(s) in 4 stack(s) moved from the victim (2 shown worn, 1 named); moved: f x120, 12eb7 x1, 12e49 x1, db0e2 "Breezehome key" x1')
  runTimers()
  assert.deepEqual(t.respawned, [VICTIM], 'the stripped victim respawns, the afterlife routes it')
  // Another character of the victim's account is still refused
  const ALT = 0xff000d67
  t.props.set(ALT, { type: 'MpActor', profileId: 7 })
  assert.equal(t.sys.refusalFor(ALT, bodyId), 'You cannot loot the body of your own fallen character.')
  t.props.delete(ALT)

  // A second death within 30 s leaves no second body and moves nothing
  assert.equal(t.sys.leaveBody(VICTIM, 'soul trapped by ff000011'), bodyId)
  assert.equal(t.props.size, 2)

  // A take of a worn piece: the body stops showing it
  b.inventory.entries = b.inventory.entries.filter((e) => e.baseId !== CUIRASS)
  await t.poll()
  assert.deepEqual(b.equipment.inv.entries.map((e) => e.baseId), [SWORD])
  assert.equal(t.lines.at(-1), '[body] ff100000 no longer shows 1 worn piece(s) taken from it, 1 still shown')
  // A take of gold changes nothing worn
  const shownBefore = t.lines.length
  b.inventory.entries = b.inventory.entries.map((e) => (e.baseId === GOLD ? { ...e, count: 20 } : e))
  await t.poll()
  assert.equal(t.lines.length, shownBefore)

  // Persistence: a restart adopts the body from bodies.json and puts it on the grid again
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'bodies.json'), 'utf8'))
  assert.equal(saved.bodies.length, 1)
  t.order.length = 0
  let r = await setup({}, t)
  assert.equal(r.lines.at(-1), '[body] 1/1 body(ies) of the previous run kept')
  assert.deepEqual(t.order, ['body.locationalData'])

  // No expiry: a body with anything left in it lies on, however long nobody touches it
  seconds(30 * 24 * 3600)
  await r.poll()
  assert.equal(r.props.has(bodyId), true, 'no idle or age expiry')
  b.inventory.entries = b.inventory.entries.filter((e) => e.baseId === KEY)
  seconds(7200)
  await r.poll()
  assert.equal(r.props.has(bodyId), true, 'the key alone keeps the body, it is loot like any other item')
  // The last take empties it: gone at the next check
  b.inventory.entries = []
  await r.poll()
  assert.equal(r.props.has(bodyId), false)
  assert.equal(r.lines.at(-1), '[body] ff100000 of ff000d66 removed: emptied')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bodies.json'), 'utf8')).bodies, [])

  // A body emptied just before a restart goes at the first check after it
  t = await setup()
  const id3 = t.sys.leaveBody(VICTIM, 'executed by ff000011')
  t.props.get(id3).inventory.entries = []
  seconds(61)
  r = await setup({}, t)
  assert.equal(r.lines.at(-1), '[body] 1/1 body(ies) of the previous run kept')
  await r.poll()
  assert.equal(r.lines.at(-1), `[body] ${id3.toString(16)} of ff000d66 removed: emptied`)

  // bodies.json lost the body: the restart finds it by its index and keeps the victim's account from its record
  t = await setup()
  const id4 = t.sys.leaveBody(VICTIM, 'soul trapped by ff000011')
  fs.writeFileSync(path.join(dir, 'bodies.json'), '{"bodies":[]}')
  r = await setup({}, t)
  assert.equal(r.lines.at(-1), `[body] 0/0 body(ies) of the previous run kept, 1 more missing from ./bodies.json found by private.indexed.pkBody: ${id4.toString(16)}`)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bodies.json'), 'utf8')).bodies.length, 1)
  t.props.set(ALT, { type: 'MpActor', profileId: 7 })
  assert.equal(r.sys.refusalFor(ALT, id4), 'You cannot loot the body of your own fallen character.')
  t.props.delete(ALT)

  // A stack whose base the load order lacks never shows in a window, so it cannot keep the body
  t.props.get(id4).inventory.entries = [{ baseId: STALE, count: 3 }]
  seconds(60)
  await r.poll()
  assert.equal(r.props.has(id4), false)
  assert.equal(r.lines.at(-1), `[body] ${id4.toString(16)} of ff000d66 removed: emptied, went with it: 7f00001 x3`)

  // ff_body unregistered: no body, the victim keeps everything
  fs.rmSync(path.join(dir, 'bodies.json'))
  t = await setup({}, stubMp({ ff_body: true }))
  assert.equal(t.sys.leaveBody(VICTIM, 'executed by ff000011'), 0)
  assert.deepEqual(t.v.inventory, victimPack())
  assert.equal(t.destroyed.length, 1)
  assert.match(t.lines.at(-1), /^\[body\] leaving a body for ff000d66 failed setting ff_body \(registered in gamemode\.js\?\), pack kept: Error: Property 'ff_body' doesn't exist$/)

  // The body cannot take the pack: the victim gets it back
  t = await setup({}, stubMp({ inventory: 'body' }))
  assert.equal(t.sys.leaveBody(VICTIM, 'executed by ff000011'), 0)
  assert.deepEqual(t.v.inventory, victimPack())
  assert.equal(t.v.equipment.inv.entries.length, 2, 'equipment untouched on a failure')
  assert.match(t.lines.at(-1), /^\[body\] leaving a body for ff000d66 failed filling the body, pack given back: Error: /)

  // An emptied body lies a minute, then goes with nothing to report
  t = await setup()
  const id2 = t.sys.leaveBody(VICTIM, 'finished off by ff000011')
  t.props.get(id2).inventory.entries = []
  await t.poll()
  assert.equal(t.props.has(id2), true)
  seconds(60)
  await t.poll()
  assert.equal(t.lines.at(-1), `[body] ${id2.toString(16)} of ff000d66 removed: emptied`)

  console.log('test-bodies: all passed')
})().catch((e) => { console.error(e); process.exit(1) })
