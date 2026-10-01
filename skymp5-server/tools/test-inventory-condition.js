'use strict'

// The per-copy condition (durability) through server TS over stub mps: identity and stacking in inventoryExtras.ts, the trade's condition
// preference, settle and lock guard, the crafted extras name and carry-over rules, the afterlife undress, the skinning hand-off, a search and the PK body:
// node tools/test-inventory-condition.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onResolve({ filter: /^discord\.js$/ }, () => ({ path: 'discord', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: globalThis.__conditionSettings, dataDir: "", loadOrder: [] }) }', loader: 'js' }))
    build.onLoad({ filter: /^discord$/, namespace: 'stub' }, () => ({ contents: 'exports.REST = class {}; exports.Routes = {}', loader: 'js' }))
  },
}

// One bundle, so the systems share inventoryExtras and durabilityNative
const load = async () => {
  const dir = path.join(__dirname, '..', 'ts', 'systems')
  const source = path.join(dir, 'test-inventory-condition-entry.ts')
  const contents = [
    'export * as extras from "./inventoryExtras";',
    'export * as native from "./durabilityNative";',
    'export { TradeSystem, __test as tradeTest } from "./tradeSystem";',
    'export { CraftedExtrasSystem, __test as craftedTest } from "./craftedExtrasSystem";',
    'export { AfterlifeSystem } from "./afterlifeSystem";',
    'export { HuntingSystem } from "./huntingSystem";',
    'export { BodySystem } from "./bodySystem";',
    'export { SearchSystem } from "./searchSystem";',
  ].join(' ')
  const { outputFiles } = await esbuild.build({
    stdin: { contents, resolveDir: dir, sourcefile: source, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', plugins: [settingsStub], logLevel: 'error',
  })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(dir)
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

let extras, native, TradeSystem, tradeTest, CraftedExtrasSystem, craftedTest, AfterlifeSystem, HuntingSystem, BodySystem, SearchSystem

const DURABILITY = { alduinakDamageFormulaSettings: { enabled: false, durability: { enabled: true, nameTag: { showAtFull: true, brokenLabel: 'Broken' } } } }
const OFF = {}

const SWORD = 0x13989
const CUIRASS = 0x13952
const INGOT = 0x5ace5
const GOLD = 0xf
const POISON = 0x3a5a4
const PELT = 0x3ad74
// Conditions as the native hands them out: float32 of a value rounded to 1e-4
const c = (v) => Math.fround(v)
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sword = (condition, more = {}) => ({ baseId: SWORD, count: 1, ...(condition === undefined ? {} : { condition: c(condition) }), ...more })

const results = []
const pending = []
function test (name, fn) {
  pending.push(async () => {
    try {
      await fn()
      results.push([true, name])
    } catch (err) {
      results.push([false, name, err])
    }
  })
}

// ── inventoryExtras ─────────────────────────────────────────────────────────

test('conditionPercent shows what the name tag shows: rounded down, 1 above broken, 100 without a value', () => {
  const table = [[undefined, 100], [null, 100], [1, 100], [1.5, 100], [NaN, 100], [0.9999, 99], [c(0.97), 97], [c(0.29), 29], [c(0.57), 57],
    [0.5, 50], [0.011, 1], [0.005, 1], [0.0001, 1], [0, 0], [-0.2, 0]]
  for (const [value, percent] of table) assert.equal(extras.conditionPercent(value), percent, `condition ${value}`)
  assert.equal(extras.conditionOf({}), 1)
  assert.equal(extras.conditionOf({ condition: 0 }), 0, 'broken is a value, not an empty extra')
  assert.equal(extras.conditionOf({ condition: 7 }), 1)
})

test('condition is no identity but keeps copies apart: a worn copy never stacks onto a pristine one', () => {
  assert.ok(extras.EXTRA_KEYS.includes('condition'))
  assert.ok(!extras.IDENTITY_KEYS.includes('condition'))
  assert.ok(extras.sameItem(sword(0.4), sword()), 'the same item to a client')
  assert.equal(extras.lineKey(sword(0.4)), extras.lineKey(sword()))
  assert.ok(!extras.hasIdentityExtras(sword(0.4)))
  assert.ok(!extras.sameExtras(sword(0.4), sword()), 'worn and pristine')
  assert.ok(!extras.sameExtras(sword(0), sword()), 'broken and pristine')
  assert.ok(!extras.sameExtras(sword(0.4), sword(0.4001)), 'one step of the native rounding apart')
  assert.ok(extras.sameExtras(sword(0.4), { baseId: SWORD, count: 3, condition: 0.4 }), 'float32 and double of one value')
  assert.ok(extras.sameExtras(sword(), { baseId: SWORD, count: 1, condition: 1 }), 'no value is 100%')

  const inv = extras.addEntries({ entries: [{ baseId: SWORD, count: 2 }, sword(0.4)] }, [sword(0.4), sword(0.9), sword(), sword(0)])
  assert.deepEqual(inv.entries, [{ baseId: SWORD, count: 3 }, { baseId: SWORD, count: 2, condition: c(0.4) }, sword(0.9), sword(0)])
  assert.deepEqual(extras.withCount({ ...sword(0.4), worn: true }, 1), sword(0.4), 'a moved copy keeps its condition')
  assert.deepEqual(extras.withoutCondition(sword(0.4, { health: 1.2 })), { baseId: SWORD, count: 1, health: 1.2 })
  assert.deepEqual(extras.byNearestCondition([sword(0.9), sword(), sword(0.42), sword(0.4)], 0.41), [2, 3, 0, 1], 'a tie keeps the inventory order')
  assert.deepEqual(extras.byNearestCondition([sword(), sword(), sword()], 0.4), [0, 1, 2], 'pristine copies keep their order')
})

test('a client condition is taken as a hint from 0 up to but not 1, and the log text names a broken copy', () => {
  const hint = (raw) => { const item = { baseId: SWORD, count: 1 }; extras.copyValidExtras(raw, item); return item.condition }
  assert.equal(hint({ condition: 0.43 }), 0.43)
  assert.equal(hint({ condition: 0 }), 0)
  for (const bad of [1, 1.2, -0.1, '0.5', null, NaN, undefined]) assert.equal(hint({ condition: bad }), undefined, `condition ${bad}`)
  assert.deepEqual(extras.describeExtras(sword(0.4312, { health: 1.2 })), ['health=1.2', 'condition=0.4312'])
  assert.deepEqual(extras.describeExtras(sword(0)), ['condition=0'])
  assert.deepEqual(extras.describeExtras(sword()), [])
})

// ── Trade ───────────────────────────────────────────────────────────────────

test('an offer line draws the copy showing its condition, then the nearest, and the copy moves with the server value', () => {
  const { resolveOffer, normalizeOffer } = tradeTest
  const inv = { entries: [sword(), sword(0.43), sword(0.9), { baseId: GOLD, count: 10 }] }
  const one = (condition) => resolveOffer(inv, normalizeOffer([{ baseId: SWORD, count: 1, condition }])).moved
  assert.deepEqual(one(0.43), [sword(0.43)])
  assert.deepEqual(one(0.4399), [sword(0.43)], 'the same percent')
  assert.deepEqual(one(0.5), [sword(0.43)], 'a stale hint takes the nearest copy, never its own value')
  assert.deepEqual(one(0.8), [sword(0.9)])
  assert.deepEqual(one(undefined), [sword()], 'a line without a condition means the pristine copy')
  assert.deepEqual(one(0), [sword(0.43)], 'broken asked, the most worn drawn')

  const two = resolveOffer(inv, normalizeOffer([{ baseId: SWORD, count: 1, condition: 0.6 }, { baseId: SWORD, count: 1, condition: 0.43 }]))
  assert.deepEqual(two.moved, [sword(0.43), sword(0.9)], 'the line at 43% keeps its copy, the stale line takes the nearest one left')
  assert.deepEqual(two.rest.entries, [sword(), { baseId: GOLD, count: 10 }])
  const all = resolveOffer(inv, normalizeOffer([{ baseId: SWORD, count: 3 }]))
  assert.ok(all.ok)
  assert.deepEqual(all.moved, [sword(), sword(0.9), sword(0.43)], 'a pristine line spills onto the best copies first')
  assert.ok(!resolveOffer(inv, normalizeOffer([{ baseId: SWORD, count: 4 }])).ok)

  const lines = normalizeOffer([{ baseId: SWORD, count: 1, condition: 0.43 }, { baseId: SWORD, count: 1, condition: 0.431 }, { baseId: SWORD, count: 2 },
    { baseId: SWORD, count: 1, condition: 1 }, { baseId: SWORD, count: 1, condition: 0.9 }])
  assert.deepEqual(lines, [{ baseId: SWORD, count: 2, condition: 0.43 }, { baseId: SWORD, count: 3 }, { baseId: SWORD, count: 1, condition: 0.9 }], 'one line per shown percent')
})

test('without any condition an offer resolves as before, in inventory order', () => {
  const { resolveOffer, normalizeOffer } = tradeTest
  const inv = { entries: [{ baseId: SWORD, count: 1, worn: true }, { baseId: SWORD, count: 2, health: 1.2 }, { baseId: SWORD, count: 2 }, { baseId: GOLD, count: 10 }] }
  const res = resolveOffer(inv, normalizeOffer([{ baseId: SWORD, count: 2 }, { baseId: SWORD, count: 1, health: 1.2 }, { baseId: GOLD, count: 4 }]))
  assert.deepEqual(res.moved, [{ baseId: SWORD, count: 1 }, { baseId: SWORD, count: 1 }, { baseId: SWORD, count: 1, health: 1.2 }, { baseId: GOLD, count: 4 }])
  assert.deepEqual(res.rest.entries, [{ baseId: SWORD, count: 1, health: 1.2 }, { baseId: SWORD, count: 1 }, { baseId: GOLD, count: 6 }])
  assert.deepEqual(res.plain, [false, false, false])
  assert.equal(tradeTest.wornSig(res.moved), '')
})

const A = 0xff000001
const B = 0xff000002
const tradeWorld = async ({ settings, invA, invB, settle, noNative }) => {
  globalThis.__conditionSettings = settings
  const props = new Map([[A, { inventory: { entries: invA }, profileId: 1 }], [B, { inventory: { entries: invB }, profileId: 2 }]])
  const packets = { 1: [], 2: [] }
  const order = []
  const lines = []
  const mp = {
    get: (id, key) => clone(props.get(id)?.[key]),
    set: (id, key, v) => { order.push(`set:${id === A ? 'A' : 'B'}`); props.get(id)[key] = clone(v) },
    getUserActor: (u) => (u === 1 ? A : u === 2 ? B : 0),
    getUserByActor: (id) => (id === A ? 1 : id === B ? 2 : 65535),
    isConnected: () => true,
    getActorName: (id) => (id === A ? 'Anja' : 'Bors'),
    getActorCellOrWorld: () => 0x3c,
    getActorPos: () => [0, 0, 0],
    sendCustomPacket: (u, text) => packets[u].push(JSON.parse(text)),
  }
  if (!noNative) mp.settleWear = (id) => { order.push(`settle:${id === A ? 'A' : 'B'}`); if (settle) settle(id, props) }
  const trade = new TradeSystem((line) => lines.push(String(line)))
  const ctx = { svr: mp, gm: { on: () => {} } }
  await trade.initAsync(ctx)
  const send = (user, type, content = {}) => trade.customPacket(user, type, content, ctx)
  const state = (user) => packets[user].filter((p) => p.customPacketType === 'tradeState').at(-1)
  const got = (user, type) => packets[user].filter((p) => p.customPacketType === type)
  const inv = (id) => props.get(id).inventory.entries
  send(1, 'tradeRequest', { recipient: B })
  send(2, 'tradeRespond', { accept: true })
  return { mp, props, packets, order, lines, send, state, got, inv }
}

test('a trade settles the wear of both sides first, shows the buyer the server condition and moves that copy apart from pristine ones', async () => {
  let lowered = false
  const t = await tradeWorld({
    settings: DURABILITY,
    invA: [sword(), sword(0.43)],
    invB: [{ baseId: SWORD, count: 2 }, { baseId: GOLD, count: 100 }],
    // The fight before the trade left one more percent of wear in memory
    settle: (id, props) => {
      if (id !== A || lowered) return
      lowered = true
      props.get(A).inventory.entries[1].condition = c(0.42)
    },
  })
  assert.deepEqual(t.order, ['settle:A', 'settle:B'], 'both settled when the window opens')
  t.send(1, 'tradeSetOffer', { items: [{ baseId: SWORD, count: 1, condition: 0.43 }], seq: 1 })
  t.send(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 50 }], seq: 1 })
  assert.deepEqual(t.state(2).theirOffer, [sword(0.42)], 'the buyer sees the condition the server holds')
  assert.deepEqual(t.state(1).myOffer, [{ baseId: SWORD, count: 1, condition: 0.43 }], 'the seller keeps the line as offered')
  t.send(1, 'tradeLock'); t.send(2, 'tradeLock'); t.send(1, 'tradeAccept')
  t.order.length = 0
  t.send(2, 'tradeAccept')
  assert.deepEqual(t.order, ['settle:A', 'settle:B', 'set:A', 'set:B'], 'settled before the inventories are read and swapped')
  assert.equal(t.got(1, 'tradeCompleted').length, 1)
  assert.deepEqual(t.inv(A), [sword(), { baseId: GOLD, count: 50 }])
  assert.deepEqual(t.inv(B), [{ baseId: SWORD, count: 2 }, { baseId: GOLD, count: 50 }, sword(0.42)], 'the worn sword stays an entry of its own')
  assert.match(t.lines.at(-1), /gave \[1x 0x13989 \{condition=0\.42\}\] to "Bors"/)
})

test('a locked offer that would now move another copy or a more worn one is shown again instead of swapped', async () => {
  const t = await tradeWorld({ settings: DURABILITY, invA: [sword(0.9), sword(0.1)], invB: [{ baseId: GOLD, count: 100 }] })
  t.send(1, 'tradeSetOffer', { items: [{ baseId: SWORD, count: 1, condition: 0.9 }], seq: 1 })
  t.send(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 80 }], seq: 1 })
  t.send(1, 'tradeLock'); t.send(2, 'tradeLock')
  assert.deepEqual(t.state(2).theirOffer, [sword(0.9)])
  // The good sword leaves the seller's pack after both locked
  t.props.get(A).inventory.entries = [sword(0.1)]
  t.send(1, 'tradeAccept'); t.send(2, 'tradeAccept')
  assert.equal(t.got(2, 'tradeCompleted').length, 0, 'no swap')
  assert.deepEqual(t.inv(B), [{ baseId: GOLD, count: 100 }])
  for (const user of [1, 2]) assert.equal(t.got(user, 'tradeNotice').at(-1).text, 'An offered item is no longer in the condition shown. Check the offer and lock again.')
  assert.equal(t.state(2).bothLocked, false)
  assert.equal(t.state(2).theyAccepted, false)
  assert.deepEqual(t.state(2).theirOffer, [sword(0.1)], 'the buyer now sees the copy that would arrive')
  // Both agree to that copy
  t.send(1, 'tradeLock'); t.send(2, 'tradeLock'); t.send(1, 'tradeAccept'); t.send(2, 'tradeAccept')
  assert.equal(t.got(2, 'tradeCompleted').length, 1)
  assert.deepEqual(t.inv(B), [{ baseId: GOLD, count: 20 }, sword(0.1)])
  assert.deepEqual(t.inv(A), [{ baseId: GOLD, count: 80 }])
})

test('with durability off the native is never asked and a trade runs as before', async () => {
  for (const settings of [OFF, { alduinakDamageFormulaSettings: { enabled: true, durability: { enabled: false } } }]) {
    const t = await tradeWorld({ settings, invA: [{ baseId: SWORD, count: 2, health: 1.2 }, { baseId: SWORD, count: 1 }], invB: [{ baseId: GOLD, count: 100 }] })
    t.send(1, 'tradeSetOffer', { items: [{ baseId: SWORD, count: 1, health: 1.2 }, { baseId: SWORD, count: 1 }], seq: 3 })
    t.send(2, 'tradeSetOffer', { items: [{ baseId: GOLD, count: 30 }], seq: 1 })
    assert.deepEqual(t.state(1).myOffer, [{ baseId: SWORD, count: 1, health: 1.2 }, { baseId: SWORD, count: 1 }])
    assert.equal(t.state(1).mySeq, 3)
    t.send(1, 'tradeLock'); t.send(2, 'tradeLock'); t.send(1, 'tradeAccept'); t.send(2, 'tradeAccept')
    assert.equal(t.got(1, 'tradeCompleted').length, 1)
    assert.deepEqual(t.inv(A), [{ baseId: SWORD, count: 1, health: 1.2 }, { baseId: GOLD, count: 30 }])
    assert.deepEqual(t.inv(B), [{ baseId: GOLD, count: 70 }, { baseId: SWORD, count: 1, health: 1.2 }, { baseId: SWORD, count: 1 }])
    assert.deepEqual(t.order, ['set:A', 'set:B'], 'no settleWear call')
    assert.deepEqual(t.lines.filter((l) => l.includes('durability')), [])
  }
})

test('durability on a scam_native.node without settleWear: one log line for every system, and trades and bodies still work', async () => {
  const t = await tradeWorld({ settings: DURABILITY, noNative: true, invA: [sword(0.43)], invB: [] })
  const missing = t.lines.filter((l) => l.includes('no settleWear'))
  assert.equal(missing.length, 1)
  assert.match(missing[0], /^\[durability\] wear is not settled before items change hands: this scam_native\.node has no settleWear/)
  t.send(1, 'tradeSetOffer', { items: [{ baseId: SWORD, count: 1, condition: 0.43 }], seq: 1 })
  t.send(1, 'tradeLock'); t.send(2, 'tradeLock'); t.send(1, 'tradeAccept'); t.send(2, 'tradeAccept')
  assert.deepEqual(t.inv(B), [sword(0.43)])
  const lines = []
  const settle = native.wearSettler({}, DURABILITY, (l) => lines.push(l))
  settle(A)
  assert.deepEqual(lines, [], 'reported once per server')
  assert.equal(native.hasSettleWear({}), false)
  assert.equal(native.hasSettleWear({ settleWear: () => {} }), true)
  // A native call that throws is reported once and moves on
  const failing = native.wearSettler({ settleWear: () => { throw new Error('no such actor') } }, DURABILITY, (l) => lines.push(l))
  failing(A); failing(B)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[durability\] settleWear failed for ff000001/)
})

test('the durability switch and the name tag are read from alduinakDamageFormulaSettings.durability', () => {
  assert.deepEqual(native.durabilityTags(null), { enabled: false, showAtFull: true, brokenLabel: 'Broken' })
  assert.deepEqual(native.durabilityTags({ alduinakDamageFormulaSettings: { enabled: true } }), { enabled: false, showAtFull: true, brokenLabel: 'Broken' })
  assert.deepEqual(native.durabilityTags(DURABILITY), { enabled: true, showAtFull: true, brokenLabel: 'Broken' })
  assert.deepEqual(native.durabilityTags({ alduinakDamageFormulaSettings: { durability: { enabled: true, nameTag: { showAtFull: false, brokenLabel: ' Ruined ' } } } }),
    { enabled: true, showAtFull: false, brokenLabel: 'Ruined' })
  assert.equal(native.durabilityTags({ alduinakDamageFormulaSettings: { durability: { enabled: 'yes' } } }).enabled, false)
})

// ── Crafted extras ──────────────────────────────────────────────────────────

test('cleanName takes the condition tag off with the quality behind it, and leaves names alone with durability off', () => {
  const { cleanName } = craftedTest
  const tag = native.conditionTagPattern('Broken')
  assert.equal(cleanName('Steel Sword (97%)', tag), 'Steel Sword')
  assert.equal(cleanName('Steel Sword (97%) (Fine)', tag), 'Steel Sword')
  assert.equal(cleanName('Steel Sword (Fine) (100%)', tag), 'Steel Sword')
  assert.equal(cleanName('Steel Sword (Broken) (Legendary)', tag), 'Steel Sword')
  assert.equal(cleanName('Oathkeeper (3%) (97%)', tag), 'Oathkeeper')
  assert.equal(cleanName('Blade of 50% (half) sharpness', tag), 'Blade of 50% (half) sharpness')
  assert.equal(cleanName('(97%)', tag), '(97%)', 'a name is never emptied')
  assert.equal(cleanName('Steel Sword (Ruined)', native.conditionTagPattern('Ruined')), 'Steel Sword')
  assert.equal(cleanName('Steel Sword (Broken)', native.conditionTagPattern('Ruined')), 'Steel Sword', 'the default label still parses')
  assert.equal(cleanName('Steel Sword (97%) (Fine)', null), 'Steel Sword (97%)', 'as before')
  assert.equal(cleanName('Steel Sword (Fine)', null), 'Steel Sword')
  assert.equal(cleanName('Steel Sword (Fine) (Fine)', null), 'Steel Sword (Fine)')
  assert.equal(cleanName(7, tag), undefined)
})

const ACTOR = 0xff000100
const USER = 7
const WHEEL = 0x88108
const WHEEL_BASE = 0x6001
const WHEEL_REF = 0x9001
const TEMPER_SWORD = 0x2001
const u32 = (...values) => {
  const data = new Uint8Array(4 * values.length)
  const view = new DataView(data.buffer)
  values.forEach((v, i) => view.setUint32(4 * i, v, true))
  return data
}
const record = (type, editorId, fields = []) => ({ record: { type, editorId, fields: fields.map(([t, data]) => ({ type: t, data })) }, toGlobalRecordId: (id) => id })
const RECORDS = {
  [WHEEL_BASE]: record('FURN', 'CraftingBlacksmithSharpeningWheel', [['WBDT', new Uint8Array([2, 255])], ['KWDA', u32(WHEEL)]]),
  [SWORD]: record('WEAP', 'SteelSword'),
  [INGOT]: record('MISC', 'IngotSteel'),
  [POISON]: record('ALCH', 'PoisonDamageHealth01', [['ENIT', u32(10, 0x20000)]]),
  [TEMPER_SWORD]: record('COBJ', 'TemperWeaponSteelSword', [['CNAM', u32(SWORD)], ['BNAM', u32(WHEEL)], ['CNTO', u32(INGOT, 1)]]),
}
const craftWorld = (entries) => {
  const props = new Map([[ACTOR, { inventory: { entries }, worldOrCellDesc: '3c:Skyrim.esm' }], [WHEEL_REF, { worldOrCellDesc: '3c:Skyrim.esm', pos: [10, 0, 0], baseDesc: `${WHEEL_BASE.toString(16)}:Skyrim.esm` }]])
  const lines = []
  const mp = {
    get: (id, key) => clone(props.get(id)?.[key]),
    set: (id, key, v) => { props.get(id)[key] = clone(v) },
    sendCustomPacket: () => {},
    lookupEspmRecordById: (id) => RECORDS[id] || {},
    getEspmRecordIdsByType: (type) => (type === 'COBJ' ? [TEMPER_SWORD] : []),
    getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16),
    getActorPos: () => [0, 0, 0],
    getUserByActor: () => USER,
    getUserActor: () => ACTOR,
  }
  const crafted = new CraftedExtrasSystem((l) => lines.push(String(l)), null, null)
  // Materials only, so the test needs neither a rank nor a fatigue bar
  crafted.temperRules = false
  const ctx = { svr: mp, gm: { on: () => {} } }
  const report = (gained, lost) => {
    crafted.lastReportAt.clear()
    crafted.customPacket(USER, 'craftedExtras', { customPacketType: 'craftedExtras', workbench: WHEEL_REF, gained, lost }, ctx)
  }
  return { mp, props, lines, crafted, ctx, report, inv: () => props.get(ACTOR).inventory.entries }
}

test('a reported temper keeps the wear of the server copy it was made from, whatever condition the report claims', () => {
  let t = craftWorld([sword(), sword(0.4), { baseId: INGOT, count: 2 }])
  t.report([{ baseId: SWORD, count: 1, health: 1.1, condition: 0.99 }], [{ baseId: SWORD, count: 1, condition: 0.4 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual(t.inv(), [sword(), { baseId: INGOT, count: 1 }, sword(0.4, { health: 1.1 })], 'the worn copy was tempered and stays at 40%')
  assert.match(t.lines.at(-1), /tempered to 1\.1 .*\{health=1\.1, condition=0\.4\}/)

  // A lost line without a condition means the pristine copy
  t = craftWorld([sword(0.4), sword(), { baseId: INGOT, count: 1 }])
  t.report([{ baseId: SWORD, count: 1, health: 1.1 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual(t.inv(), [sword(0.4), sword(undefined, { health: 1.1 })])

  // Only a worn copy held: the pristine claim still cannot repair it
  t = craftWorld([sword(0.4), { baseId: INGOT, count: 1 }])
  t.report([{ baseId: SWORD, count: 1, health: 1.1 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual(t.inv(), [sword(0.4, { health: 1.1 })])
})

test('a poison applied to the worn weapon lands on the copy at the equipment entry\'s condition', () => {
  const t = craftWorld([sword(), sword(0.4), sword(0.8)])
  t.props.get(ACTOR).equipment = { inv: { entries: [{ ...sword(0.4), worn: true }] } }
  t.crafted.addPoisonCredit(ACTOR, POISON)
  t.crafted.applyPoisonToWorn(t.ctx, ACTOR, POISON)
  assert.deepEqual(t.inv(), [sword(), sword(0.8), sword(0.4, { poisonId: POISON, poisonCount: 1 })])
})

// ── Afterlife, skinning, PK body ────────────────────────────────────────────

test('the afterlife takes its outfit back however worn it is, after the wear is settled, and leaves the player\'s own pieces', () => {
  const order = []
  const props = new Map([[ACTOR, {
    'private.afterlifeOutfit': { realm: 'sovngarde', granted: { [CUIRASS]: 1, [SWORD]: 1 } },
    inventory: { entries: [
      { baseId: CUIRASS, count: 1, worn: true, condition: c(0.6) },
      { baseId: CUIRASS, count: 1, health: 1.2, condition: c(0.9) },
      sword(0),
      { baseId: GOLD, count: 5 },
    ] },
  }]])
  const mp = {
    get: (id, key) => { order.push(`get:${key}`); return clone(props.get(id)?.[key]) },
    set: (id, key, v) => { order.push(`set:${key}`); props.get(id)[key] = clone(v) },
    settleWear: (id) => order.push(`settle:${id.toString(16)}`),
  }
  const lines = []
  const afterlife = new AfterlifeSystem((l) => lines.push(String(l)))
  afterlife.settleWear = native.wearSettler(mp, DURABILITY, () => {})
  afterlife.undress(mp, ACTOR)
  assert.deepEqual(props.get(ACTOR).inventory.entries, [{ baseId: CUIRASS, count: 1, health: 1.2, condition: c(0.9) }, { baseId: GOLD, count: 5 }],
    'the granted cuirass at 60% and the broken granted sword go, the tempered cuirass of the player stays')
  assert.ok(order.indexOf('settle:ff000100') >= 0 && order.indexOf('settle:ff000100') < order.indexOf('get:inventory'), 'settled before the pack is read')
  assert.match(lines.at(-1), /took 2 granted piece\(s\)/)
})

test('a skinner takes a worn stack of the body as the entry it is, and everything else through AddItem as before', () => {
  const BODY = 0xff000200
  const world = (bodyEntries) => {
    const props = new Map([[BODY, { inventory: { entries: bodyEntries } }], [ACTOR, { inventory: { entries: [{ baseId: SWORD, count: 1 }] } }]])
    const added = []
    const sets = []
    const mp = {
      get: (id, key) => clone(props.get(id)?.[key]),
      set: (id, key, v) => { sets.push(id); props.get(id)[key] = clone(v) },
      getDescFromId: (id) => id.toString(16),
      callPapyrusFunction: (kind, cls, fn, self, args) => added.push([fn, self.desc, args[0].desc, args[1]]),
    }
    return { props, added, sets, mp }
  }
  const hunting = new HuntingSystem(() => {}, null, null)
  let w = world([{ baseId: PELT, count: 2 }, sword(0.35, { health: 1.3 }), { baseId: SWORD, count: 1, health: 1.3 }])
  assert.equal(hunting.takeFrom(w.mp, ACTOR, BODY, () => true), 3)
  assert.deepEqual(w.props.get(BODY).inventory.entries, [])
  assert.deepEqual(w.added, [['AddItem', 'ff000100', PELT.toString(16), 2], ['AddItem', 'ff000100', SWORD.toString(16), 1]])
  assert.deepEqual(w.props.get(ACTOR).inventory.entries, [{ baseId: SWORD, count: 1 }, sword(0.35, { health: 1.3 })], 'the worn sword keeps its condition and its tempering')

  // No worn stack: the skinner's inventory is not written, as before
  w = world([{ baseId: PELT, count: 2 }, { baseId: GOLD, count: 7 }])
  assert.equal(hunting.takeFrom(w.mp, ACTOR, BODY, (id) => id === PELT), 1)
  assert.deepEqual(w.sets, [BODY])
  assert.deepEqual(w.added, [['AddItem', 'ff000100', PELT.toString(16), 2]])
  assert.deepEqual(w.props.get(BODY).inventory.entries, [{ baseId: GOLD, count: 7 }])
})

test('a search settles the wear of the searched player before their pack is listed and taken from', () => {
  const TARGET = 0xff000300
  const order = []
  const props = new Map([[TARGET, { inventory: { entries: [sword(0.6), { baseId: GOLD, count: 3 }] } }]])
  const mp = {
    get: (id, key) => { if (key === 'inventory') order.push('list'); return clone(props.get(id)?.[key]) },
    settleWear: (id) => { order.push(`settle:${id.toString(16)}`); props.get(id).inventory.entries[0].condition = c(0.58) },
    setInventoryOccupant: () => order.push('occupant'),
    getUserByActor: (id) => (id === ACTOR ? USER : 65535),
    isConnected: () => true,
    sendCustomPacket: (user, text) => order.push(JSON.parse(text).customPacketType),
    getActorName: () => 'Anja',
  }
  const search = new SearchSystem(() => {}, null)
  search.settleWear = native.wearSettler(mp, DURABILITY, () => {})
  search.startSession({ svr: mp, gm: { on: () => {} } }, ACTOR, TARGET, false)
  assert.deepEqual(order, ['occupant', 'settle:ff000300', 'list', 'searchApproved'])
  assert.deepEqual(props.get(TARGET).inventory.entries[0], sword(0.58), 'the copy a take now moves')
})

test('a PK body takes the pack after the wear is settled, keeps worn and pristine copies apart and hands them on that way', async () => {
  const VICTIM = 0xff000d66
  const KILLER = 0xff000011
  globalThis.__conditionSettings = DURABILITY
  const props = new Map([
    [VICTIM, {
      type: 'MpActor', profileId: 7, isDead: true, appearance: { name: 'Eerik' },
      locationalData: { cellOrWorldDesc: '3c:Skyrim.esm', pos: [1, 2, 3], rot: [0, 0, 90] },
      inventory: { entries: [{ ...sword(0.51), worn: true }, sword(), { baseId: CUIRASS, count: 1, worn: true, condition: c(0.7) }, { baseId: GOLD, count: 9 }] },
      equipment: { inv: { entries: [{ ...sword(0.51), worn: true }, { baseId: CUIRASS, count: 1, worn: true, condition: c(0.7) }] }, numChanges: 5 },
    }],
    [KILLER, { type: 'MpActor', profileId: 9, inventory: { entries: [{ baseId: SWORD, count: 1 }] } }],
  ])
  let next = 0xff100000
  const order = []
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      if (key === 'inventory') order.push(`get:${id.toString(16)}`)
      const v = props.get(id)[key]
      return v === undefined ? null : clone(v)
    },
    set: (id, key, value) => { props.get(id)[key] = clone(value ?? null) },
    // The last hit of the fight took one more percent off the worn sword
    settleWear: (id) => {
      order.push(`settle:${id.toString(16)}`)
      const worn = props.get(id).inventory.entries.find((e) => e.baseId === SWORD && e.worn)
      if (worn) worn.condition = c(0.5)
    },
    createActor: () => { const id = next++; props.set(id, { type: 'MpActor', profileId: -1, inventory: { entries: [] } }); return id },
    destroyActor: (id) => props.delete(id),
    getIdFromDesc: () => 0x3c,
    respawnActor: () => {},
    lookupEspmRecordById: () => ({ record: { type: 'MISC' } }),
    findFormsByPropertyValue: () => [],
    getUserByActor: () => 65535,
    isConnected: () => false,
    sendCustomPacket: () => {},
  }
  const lines = []
  const bodies = new BodySystem((l) => lines.push(String(l)))
  await bodies.initAsync({ svr: mp, gm: { once: () => {} } })
  const bodyId = bodies.leaveBody(VICTIM, 'finished off by ff000011')
  assert.ok(bodyId, lines.join('\n'))
  assert.deepEqual(order.slice(0, 2), ['settle:ff000d66', 'get:ff000d66'], 'settled before the pack is read')
  assert.deepEqual(props.get(VICTIM).inventory.entries, [])
  assert.deepEqual(props.get(bodyId).inventory.entries, [sword(0.5), sword(), { baseId: CUIRASS, count: 1, condition: c(0.7) }, { baseId: GOLD, count: 9 }])
  bodies.emptyInto(bodyId, KILLER, 'looted')
  assert.deepEqual(props.get(KILLER).inventory.entries, [{ baseId: SWORD, count: 2 }, sword(0.5), { baseId: CUIRASS, count: 1, condition: c(0.7) }, { baseId: GOLD, count: 9 }],
    'the pristine sword stacks, the worn one does not')
})

;(async () => {
  ({ extras, native, TradeSystem, tradeTest, CraftedExtrasSystem, craftedTest, AfterlifeSystem, HuntingSystem, BodySystem, SearchSystem } = await load())
  // Invite expiry and the victim's respawn would keep the process alive
  global.setTimeout = () => 0
  // bodies.json goes where no server reads it
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'test-inventory-condition-')))
  for (const run of pending) await run()
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) console.log(String(err && err.stack ? err.stack : err).split('\n').map((l) => '     ' + l).join('\n'))
  }
  const failed = results.filter(([ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()
