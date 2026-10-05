'use strict'

// CraftedExtrasSystem tempers (path B) over a stub mp with the real MasterySystem and NeedsSystem: the recipe's rank gates, the rank cap
// of the recipe's profession across multiclass slots, fatigue through needs.pay, the switch and its default, the report of a temper the native
// craft already recorded and the shared recipe index: node tools/test-crafted-temper.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

// One bundle, so the three systems share their modules
const load = () => {
  const dir = path.join(__dirname, '..', 'ts', 'systems')
  const source = path.join(dir, 'test-crafted-temper-entry.ts')
  const contents = [
    'export { CraftedExtrasSystem, __test as craftedTest } from "./craftedExtrasSystem";',
    'export { Settings } from "../settings";',
    'export { MasterySystem } from "./masterySystem";',
    'export { NeedsSystem, fatigueCost } from "./needsSystem";',
    'export { parseSlots } from "./masterySlots";',
    'export * as recipes from "./temperRecipes";',
  ].join(' ')
  const { outputFiles } = esbuild.buildSync({
    stdin: { contents, resolveDir: dir, sourcefile: source, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error',
  })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(dir)
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const { CraftedExtrasSystem, craftedTest, Settings, MasterySystem, NeedsSystem, fatigueCost, parseSlots, recipes } = load()

const ACTOR = 0xff000100
const USER = 7
const RANK_HOURS = [40, 100, 180, 6000]
const THREE = [
  { name: 'Primary', cap: 'Legendary' },
  { name: 'Secondary', cap: 'Adept', rankHours: [20, 60] },
  { name: 'Tertiary', cap: 'Novice', rankHours: [20] },
]
const FUTURE = 1e12 + 1e11

// Bench keywords, stations and their placed references
const FORGE = 0x88105
const ARMOR_TABLE = 0xadb78
const WHEEL = 0x88108
const WHEEL_BASE = 0x6001
const TABLE_BASE = 0x6002
const FORGE_BASE = 0x6003
const WHEEL_REF = 0x9001
const TABLE_REF = 0x9002
const FORGE_REF = 0x9003
// Items
const SWORD = 0x13989
const DAEDRIC = 0x139b9
const HIDE = 0x13911
const LEATHER_ARMOR = 0x3619e
const INGOT = 0x5ace5
const EBONY = 0x5ad9d
const LEATHER = 0xdb5d2
const POISON = 0x3a5a4
// Recipes
const FORGE_SWORD = 0x2000      // makes the sword at the forge
const TEMPER_SWORD = 0x2001     // blacksmith Novice, grindstone
const TEMPER_HIDE = 0x2002      // ungated, armor table
const TEMPER_DAEDRIC = 0x2003   // blacksmith Master, grindstone
const TEMPER_LEATHER = 0x2004   // tailor Novice, armor table
const markersOf = (base) => [1, 2, 3, 4, 5].map((i) => base + i)
const SPELLS = { blacksmith: markersOf(0xb00), tailor: markersOf(0xc00), woodworker: markersOf(0xd00) }

const u32 = (...values) => {
  const data = new Uint8Array(4 * values.length)
  const view = new DataView(data.buffer)
  values.forEach((v, i) => view.setUint32(4 * i, v, true))
  return data
}
const record = (type, editorId, fields = []) => ({ record: { type, editorId, fields: fields.map(([t, data]) => ({ type: t, data })) }, toGlobalRecordId: (id) => id })
const cobj = (editorId, created, bench, inputs) =>
  record('COBJ', editorId, [['CNAM', u32(created)], ['BNAM', u32(bench)], ...inputs.map(([id, count]) => ['CNTO', u32(id, count)])])

const RECORDS = {
  [WHEEL_BASE]: record('FURN', 'CraftingBlacksmithSharpeningWheel', [['WBDT', new Uint8Array([2, 255])], ['KWDA', u32(WHEEL)]]),
  [TABLE_BASE]: record('FURN', 'CraftingBlacksmithArmorWorkbench', [['WBDT', new Uint8Array([7, 255])], ['KWDA', u32(ARMOR_TABLE)]]),
  [FORGE_BASE]: record('FURN', 'CraftingBlacksmithForge', [['WBDT', new Uint8Array([1, 255])], ['KWDA', u32(FORGE)]]),
  [SWORD]: record('WEAP', 'SteelSword'),
  [DAEDRIC]: record('WEAP', 'DaedricSword'),
  [HIDE]: record('ARMO', 'ArmorHideCuirass'),
  [LEATHER_ARMOR]: record('ARMO', 'ArmorLeatherCuirass'),
  [INGOT]: record('MISC', 'IngotSteel'),
  [EBONY]: record('MISC', 'IngotEbony'),
  [LEATHER]: record('MISC', 'Leather01'),
  // ENIT: value, then the flags with the poison bit
  [POISON]: record('ALCH', 'PoisonDamageHealth01', [['ENIT', u32(10, 0x20000)]]),
  [FORGE_SWORD]: cobj('RecipeWeaponSteelSword', SWORD, FORGE, [[INGOT, 2]]),
  [TEMPER_SWORD]: cobj('TemperWeaponSteelSword', SWORD, WHEEL, [[INGOT, 1]]),
  [TEMPER_HIDE]: cobj('TemperArmorHideCuirass', HIDE, ARMOR_TABLE, [[LEATHER, 1]]),
  [TEMPER_DAEDRIC]: cobj('TemperWeaponDaedricSword', DAEDRIC, WHEEL, [[EBONY, 1]]),
  [TEMPER_LEATHER]: cobj('TemperArmorLeatherCuirass', LEATHER_ARMOR, ARMOR_TABLE, [[LEATHER, 1]]),
}
const RECIPE_IDS = [FORGE_SWORD, TEMPER_SWORD, TEMPER_HIDE, TEMPER_DAEDRIC, TEMPER_LEATHER]

let now = 1e12
Date.now = () => now

const makeMp = () => {
  const props = new Map()
  const packets = []
  const key = (id, name) => `${id >>> 0}:${name}`
  props.set(key(ACTOR, 'profileId'), 1)
  props.set(key(ACTOR, 'worldOrCellDesc'), '3c:Skyrim.esm')
  for (const [ref, base] of [[WHEEL_REF, WHEEL_BASE], [TABLE_REF, TABLE_BASE], [FORGE_REF, FORGE_BASE]]) {
    props.set(key(ref, 'worldOrCellDesc'), '3c:Skyrim.esm')
    props.set(key(ref, 'pos'), [10, 0, 0])
    props.set(key(ref, 'baseDesc'), `${base.toString(16)}:Skyrim.esm`)
  }
  return {
    props, packets,
    get: (id, name) => props.get(key(id, name)),
    set: (id, name, v) => { props.set(key(id, name), JSON.parse(JSON.stringify(v))) },
    sendCustomPacket: (userId, text) => { if (userId === USER) packets.push(JSON.parse(text)) },
    lookupEspmRecordById: (id) => RECORDS[id] || {},
    getEspmRecordIdsByType: (type) => (type === 'COBJ' ? RECIPE_IDS : []),
    getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16),
    getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`,
    getActorPos: () => [0, 0, 0],
    getUserByActor: (id) => (id === ACTOR ? USER : 65535),
    getUserActor: (userId) => (userId === USER ? ACTOR : 0),
    isConnected: () => true,
    callPapyrusFunction: () => true,
  }
}

const rulesOf = (keywords) => ({ craftKeywords: new Set(keywords), craftStations: new Set(), activatePrefixes: [], activateTypes: new Set(), killKeywords: new Set() })

// The three systems as initAsync leaves them, the character online with a full bar and a frozen clock
const setup = ({ slots = THREE } = {}) => {
  const lines = []
  const log = (line) => lines.push(String(line))
  const mp = makeMp()
  const ctx = { svr: mp, gm: { on: () => {}, emit: () => {} } }
  const mastery = new MasterySystem(log)
  mastery.slots = parseSlots(slots, RANK_HOURS).slots
  mastery.spells = SPELLS
  for (const [profession, list] of Object.entries(SPELLS)) list.forEach((id, i) => mastery.markers.set(id, { profession, rank: 1 + i }))
  mastery.rules = { blacksmith: rulesOf([FORGE, ARMOR_TABLE, WHEEL]), tailor: rulesOf([ARMOR_TABLE]), woodworker: rulesOf([WHEEL]) }
  mastery.kits = { blacksmith: [], tailor: [], woodworker: [] }
  mastery.kitGold = 0
  mastery.gateCache.set(FORGE_SWORD, [])
  mastery.gateCache.set(TEMPER_SWORD, [{ profession: 'blacksmith', rank: 1 }])
  mastery.gateCache.set(TEMPER_HIDE, [])
  mastery.gateCache.set(TEMPER_DAEDRIC, [{ profession: 'blacksmith', rank: 4 }])
  mastery.gateCache.set(TEMPER_LEATHER, [{ profession: 'tailor', rank: 1 }])
  mastery.onActorAssigned(ctx, USER, ACTOR)
  // The login grant timer would fire into a later test
  mastery.pendingGrants.clear(ACTOR)
  const needs = new NeedsSystem(log, mastery)
  needs.onActorAssigned(ctx, USER, ACTOR)
  needs.online.get(ACTOR).rec.at = FUTURE
  const crafted = new CraftedExtrasSystem(log, mastery, needs)

  const choose = (profession, slot) => { mastery.lastChooseMs.clear(); mastery.onChoose(ctx, USER, { profession, slot }) }
  const grant = (hours, slot) => mastery.grantPoints(ctx, ACTOR, hours, slot)
  const hold = (...entries) => mp.set(ACTOR, 'inventory', { entries })
  const held = () => mp.get(ACTOR, 'inventory').entries
  const copy = (baseId, health) => held().filter((e) => e.baseId === baseId && Math.round((e.health || 1) * 10) === Math.round(health * 10)).reduce((n, e) => n + e.count, 0)
  const count = (baseId) => held().filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0)
  const report = (workbench, gained, lost) => {
    mp.packets.length = 0
    lines.length = 0
    crafted.lastReportAt.clear()
    crafted.lastNoticeAt.clear()
    crafted.customPacket(USER, 'craftedExtras', { customPacketType: 'craftedExtras', workbench, gained, lost }, ctx)
  }
  const fatigue = () => needs.online.get(ACTOR).rec.fatigue
  const setFatigue = (v) => { needs.online.get(ACTOR).rec.fatigue = v }
  const reverted = () => mp.packets.filter((p) => p.customPacketType === 'craftedExtrasRefused').flatMap((p) => p.baseIds)
  const notices = () => mp.packets.filter((p) => p.customPacketType === 'notification').map((p) => p.text)
  return { mp, ctx, lines, mastery, needs, crafted, choose, grant, hold, held, copy, count, report, fatigue, setFatigue, reverted, notices }
}

const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`)

const results = []
const pending = []
function test(name, fn) {
  pending.push([name, fn])
}

// initAsync as the server runs it, over these settings
const boot = async (t, allSettings) => {
  Settings.get = async () => ({ allSettings })
  await t.crafted.initAsync(t.ctx)
  return t
}
const REBALANCE = { alduinakDamageFormulaSettings: { enabled: true, durability: { enabled: false } } }

test('the index lists every recipe of an item and the temper ones by bench; the cap step follows the native HealthOfRank', () => {
  const lines = []
  const mp = makeMp()
  let reads = 0
  const ids = mp.getEspmRecordIdsByType
  mp.getEspmRecordIdsByType = (type) => { reads++; return ids(type) }
  const log = (l) => lines.push(l)
  assert.deepEqual(recipes.recipesOf(mp, SWORD, log).map((r) => r.id), [FORGE_SWORD, TEMPER_SWORD])
  assert.deepEqual(recipes.temperRecipesOf(mp, SWORD, log), [{ id: TEMPER_SWORD, bench: WHEEL, inputs: [{ id: INGOT, count: 1 }] }])
  assert.deepEqual(recipes.recipesAt(mp, SWORD, [FORGE], log).map((r) => r.id), [FORGE_SWORD])
  assert.deepEqual(recipes.temperRecipesOf(mp, INGOT, log), [])
  assert.equal(reads, 1, 'read once per server')
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(recipes.temperCapStep), [11, 12, 13, 14, 15, 16, 16])
  assert.deepEqual([10, 11, 13, 16, 20].map(recipes.qualityName), ['', 'Fine', 'Exquisite', 'Legendary', 'Legendary'])
  assert.deepEqual([recipes.ARMOR_TABLE, recipes.SHARPENING_WHEEL], [ARMOR_TABLE, WHEEL])
  const old = makeMp()
  delete old.getEspmRecordIdsByType
  assert.deepEqual(recipes.recipesOf(old, SWORD, log), [])
  assert.deepEqual(recipes.recipesOf(old, SWORD, log), [])
  assert.equal(lines.filter((l) => l.includes('getEspmRecordIdsByType')).length, 1, lines.join('\n'))
})

test('temperCap: the slot holding a gate caps a gated recipe, the best bench slot an ungated one, and unheld gates refuse', () => {
  const t = setup()
  assert.equal(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_SWORD), null, 'no profession, gated')
  assert.deepEqual(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_HIDE), { rank: 0, profession: null }, 'no profession, ungated')
  t.choose('tailor', 0)
  t.grant(180, 0)
  t.choose('blacksmith', 1)
  assert.equal(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_SWORD), null, 'a Free secondary holds no Novice marker')
  t.grant(20, 1)
  assert.deepEqual(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_SWORD), { rank: 1, profession: 'blacksmith' })
  assert.deepEqual(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_LEATHER), { rank: 4, profession: 'tailor' })
  assert.deepEqual(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_HIDE), { rank: 4, profession: 'tailor' }, 'both work the armor table, the better one caps')
  assert.equal(t.mastery.temperCap(t.ctx, ACTOR, TEMPER_DAEDRIC), null, 'a Novice blacksmith holds no Master marker')
})

test('a Free character tempers an ungated recipe to Fine at most, pays a Free craft and the client is told to revert the rest', () => {
  const t = setup()
  t.hold({ baseId: HIDE, count: 1 }, { baseId: LEATHER, count: 3 })
  t.report(TABLE_REF, [{ baseId: HIDE, count: 1, health: 1.6 }], [{ baseId: HIDE, count: 1 }, { baseId: LEATHER, count: 1 }])
  assert.equal(t.copy(HIDE, 1.1), 1, JSON.stringify(t.held()))
  assert.equal(t.count(LEATHER), 2)
  near(1 - t.fatigue(), fatigueCost('craft', 0), 'a Free craft')
  assert.deepEqual(t.reverted(), [HIDE])
  assert.deepEqual(t.notices(), ['Your rank improves that item to Fine at most.'])
  assert.ok(t.lines.some((l) => l.includes('tempered to 1.1 (recipe 2002, cap Free, asked 1.6)')), t.lines.join('\n'))
  assert.ok(t.lines.some((l) => l.startsWith('[needs] ff000100 temper 13911 by 2002 r0 (crafted extras): -33.3%')), t.lines.join('\n'))
})

test('a Novice blacksmith tempers the gated sword to Superior, uncapped claims pass untouched and cost one Novice craft', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 2 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.equal(t.copy(SWORD, 1.2), 1, JSON.stringify(t.held()))
  assert.equal(t.count(INGOT), 1)
  near(1 - t.fatigue(), fatigueCost('craft', 1), 'a Novice craft')
  assert.deepEqual([t.reverted(), t.notices()], [[], []])
  assert.ok(t.lines.some((l) => l.includes('tempered to 1.2 (recipe 2001, cap Novice blacksmith)')), t.lines.join('\n'))
  // The next step is above the cap, so the copy stays and nothing is taken
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.6 }], [{ baseId: SWORD, count: 1, health: 1.2 }, { baseId: INGOT, count: 1 }])
  assert.equal(t.copy(SWORD, 1.2), 1)
  assert.equal(t.count(INGOT), 1)
  near(1 - t.fatigue(), fatigueCost('craft', 1), 'no second charge')
  assert.deepEqual(t.reverted(), [SWORD])
  assert.deepEqual(t.notices(), ['Your rank in that craft cannot improve the item any further.'])
  assert.ok(t.lines.some((l) => l.includes('refused') && l.endsWith('(rank)')), t.lines.join('\n'))
})

test('a claim above the cap is cut to it: a Novice asking for Legendary gets Superior', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.6 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.equal(t.copy(SWORD, 1.2), 1, JSON.stringify(t.held()))
  assert.equal(t.count(INGOT), 0)
  assert.deepEqual(t.reverted(), [SWORD])
  assert.deepEqual(t.notices(), ['Your rank improves that item to Superior at most.'])
})

test('a recipe whose rank marker the character lacks is refused: nothing taken, nothing charged', () => {
  const t = setup()
  t.choose('tailor', 0)
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }, { baseId: DAEDRIC, count: 1 }, { baseId: EBONY, count: 1 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.1 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual([t.copy(SWORD, 1), t.count(INGOT), t.fatigue()], [1, 1, 1])
  assert.deepEqual(t.reverted(), [SWORD])
  assert.deepEqual(t.notices(), ['Your rank in that craft cannot improve the item any further.'])
  const smith = setup()
  smith.choose('blacksmith', 0)
  smith.grant(40, 0)
  smith.hold({ baseId: DAEDRIC, count: 1 }, { baseId: EBONY, count: 1 })
  smith.report(WHEEL_REF, [{ baseId: DAEDRIC, count: 1, health: 1.1 }], [{ baseId: DAEDRIC, count: 1 }, { baseId: EBONY, count: 1 }])
  assert.deepEqual([smith.copy(DAEDRIC, 1), smith.count(EBONY), smith.fatigue()], [1, 1, 1], 'an Adept holds no Master marker')
  assert.deepEqual(smith.reverted(), [DAEDRIC])
})

test('multiclass: a Master tailor with a Novice blacksmith slot tempers the sword at the Novice cap and price, tailor work at the Master ones', () => {
  const t = setup()
  t.choose('tailor', 0)
  t.grant(180, 0)
  t.choose('blacksmith', 1)
  t.grant(20, 1)
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }, { baseId: LEATHER_ARMOR, count: 1 }, { baseId: LEATHER, count: 1 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.5 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.equal(t.copy(SWORD, 1.2), 1, JSON.stringify(t.held()))
  near(1 - t.fatigue(), fatigueCost('craft', 1), 'the blacksmith slot prices it')
  assert.deepEqual(t.notices(), ['Your rank improves that item to Superior at most.'])
  t.setFatigue(1)
  t.report(TABLE_REF, [{ baseId: LEATHER_ARMOR, count: 1, health: 1.5 }], [{ baseId: LEATHER_ARMOR, count: 1 }, { baseId: LEATHER, count: 1 }])
  assert.equal(t.copy(LEATHER_ARMOR, 1.5), 1, JSON.stringify(t.held()))
  near(1 - t.fatigue(), fatigueCost('craft', 4), 'the tailor slot prices it')
  assert.deepEqual([t.reverted(), t.notices()], [[], []])
})

test('a bar that cannot pay refuses the temper, and of two tempers in one report only the one it can pay is made', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  const price = fatigueCost('craft', 1)
  t.hold({ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 })
  t.setFatigue(price * 0.5)
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual([t.copy(SWORD, 1), t.count(INGOT)], [2, 2])
  near(t.fatigue(), price * 0.5, 'nothing charged')
  assert.deepEqual(t.reverted(), [SWORD])
  assert.deepEqual(t.notices(), ['You are too tired to improve that item. Rest a while.'])
  assert.ok(t.lines.some((l) => l.includes('refused') && l.endsWith('(tired)')), t.lines.join('\n'))
  t.setFatigue(price * 1.5)
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 2, health: 1.2 }], [{ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 }])
  assert.deepEqual([t.copy(SWORD, 1.2), t.copy(SWORD, 1), t.count(INGOT)], [1, 1, 1], JSON.stringify(t.held()))
  near(t.fatigue(), price * 0.5, 'one craft paid')
  assert.deepEqual(t.reverted(), [SWORD])
  // With fatigue costs off the bar never refuses
  t.needs.fatigueOn = false
  t.setFatigue(0)
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual([t.copy(SWORD, 1.2), t.count(INGOT), t.fatigue()], [2, 0, 0])
})

test('materials, the bench and the station still decide as before', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 2 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }])
  assert.deepEqual([t.copy(SWORD, 1), t.fatigue()], [1, 1], 'no materials reported lost')
  assert.deepEqual(t.notices(), ['The server did not accept that change to your item, so it keeps its previous state.'])
  for (const bench of [FORGE_REF, TABLE_REF, 0]) {
    t.report(bench, [{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 2 }])
    assert.deepEqual([t.copy(SWORD, 1), t.count(INGOT), t.fatigue()], [1, 2, 1], `bench ${bench.toString(16)}`)
    assert.deepEqual(t.reverted(), [SWORD])
  }
  t.mp.props.set(`${WHEEL_REF}:pos`, [5000, 0, 0])
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.equal(t.copy(SWORD, 1), 1, 'out of reach of the grindstone')
})

test('a change that is no temper never asks rank or fatigue: a Free character poisons a Legendary sword', () => {
  const t = setup()
  t.setFatigue(0)
  t.hold({ baseId: SWORD, count: 1, health: 1.6 }, { baseId: POISON, count: 1 })
  t.report(0, [{ baseId: SWORD, count: 1, health: 1.6, poisonId: POISON, poisonCount: 1 }], [{ baseId: SWORD, count: 1, health: 1.6 }, { baseId: POISON, count: 1 }])
  const sword = t.held().find((e) => e.baseId === SWORD)
  assert.deepEqual([sword.health, sword.poisonId, sword.poisonCount, t.count(POISON), t.fatigue()], [1.6, POISON, 1, 0, 0], JSON.stringify(t.held()))
  assert.deepEqual([t.reverted(), t.notices()], [[], []])
})

test('craftedExtrasTemperRules false tempers by materials alone: no gate, no cap, no fatigue', () => {
  const t = setup()
  t.crafted.temperRules = false
  t.setFatigue(0)
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.9 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual([t.copy(SWORD, 1.6), t.count(INGOT), t.fatigue()], [1, 0, 0], JSON.stringify(t.held()))
  assert.deepEqual([t.reverted(), t.notices()], [[], []])
})

test('the rules follow the rebalance block unless craftedExtrasTemperRules is set: a server without the block tempers by materials as before', async () => {
  const { temperRulesOn } = craftedTest
  const on = { enabled: true }
  const wear = { enabled: false, durability: { enabled: true } }
  const off = { enabled: false, durability: { enabled: false } }
  assert.deepEqual([{}, { alduinakDamageFormulaSettings: off }, { alduinakDamageFormulaSettings: 'on' }, { alduinakDamageFormulaSettings: null }].map(temperRulesOn), [false, false, false, false])
  assert.deepEqual([{ alduinakDamageFormulaSettings: on }, { alduinakDamageFormulaSettings: wear }].map(temperRulesOn), [true, true])
  assert.equal(temperRulesOn({ craftedExtrasTemperRules: true }), true)
  assert.equal(temperRulesOn({ craftedExtrasTemperRules: true, alduinakDamageFormulaSettings: off }), true)
  assert.equal(temperRulesOn({ craftedExtrasTemperRules: false, alduinakDamageFormulaSettings: on }), false)
  assert.equal(temperRulesOn({ craftedExtrasTemperRules: 'yes' }), false, 'only true or false set it')

  // No block: no craft hook, and a tired character with no profession tempers the gated sword for the ingot alone
  const plain = await boot(setup(), {})
  assert.equal(plain.crafted.temperRules, false)
  assert.equal(plain.mp.onCraft, undefined)
  assert.deepEqual(plain.lines.filter((l) => l.startsWith('[crafted] a reported temper')),
    ['[crafted] a reported temper takes materials only: craftedExtrasTemperRules is not set and alduinakDamageFormulaSettings is absent or off'])
  plain.setFatigue(0)
  plain.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 })
  plain.report(WHEEL_REF, [{ baseId: SWORD, count: 1, health: 1.6 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }])
  assert.deepEqual([plain.copy(SWORD, 1.6), plain.count(INGOT), plain.fatigue()], [1, 0, 0], JSON.stringify(plain.held()))
  assert.deepEqual([plain.reverted(), plain.notices()], [[], []])

  const rebalance = await boot(setup(), REBALANCE)
  assert.equal(rebalance.crafted.temperRules, true)
  assert.equal(typeof rebalance.mp.onCraft, 'function')
  assert.deepEqual(rebalance.lines.filter((l) => l.startsWith('[crafted] a reported temper')),
    ["[crafted] a reported temper follows its recipe's rank gates and rank cap and costs a craft of fatigue: craftedExtrasTemperRules is not set and alduinakDamageFormulaSettings is on"])
  const forced = await boot(setup(), { craftedExtrasTemperRules: false, ...REBALANCE })
  assert.equal(forced.mp.onCraft, undefined)
  assert.ok(forced.lines.includes('[crafted] a reported temper takes materials only: craftedExtrasTemperRules is false'), forced.lines.join('\n'))
})

test('a report built before the native temper reached the client is no second temper: nothing tempered, taken, charged or refused', async () => {
  const stale = [[{ baseId: SWORD, count: 1, health: 1.2 }], [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }]]
  const price = fatigueCost('craft', 1)
  const smith = async () => {
    const t = await boot(setup(), REBALANCE)
    t.choose('blacksmith', 0)
    return t
  }
  // The craft hook, then what the native does when no hook refuses: one copy tempered for one ingot
  const nativeTemper = (t, ...after) => {
    assert.notEqual(t.mp.onCraft(ACTOR, SWORD, 1, TEMPER_SWORD), false)
    t.hold(...after)
  }

  let t = await smith()
  t.hold({ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 })
  nativeTemper(t, { baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }, { baseId: SWORD, count: 1, health: 1.2 })
  now += 400
  t.report(WHEEL_REF, ...stale)
  assert.deepEqual([t.copy(SWORD, 1.2), t.copy(SWORD, 1), t.count(INGOT), t.fatigue()], [1, 1, 1, 1], JSON.stringify(t.held()))
  assert.deepEqual([t.reverted(), t.notices()], [[], []])
  assert.ok(t.lines.some((l) => l === '[crafted] ff000100 13989: the reported temper is the one the craft already recorded, nothing changed'), t.lines.join('\n'))
  // One native temper answers one report: the next one is a temper of the second copy
  t.report(WHEEL_REF, ...stale)
  assert.deepEqual([t.copy(SWORD, 1.2), t.count(INGOT)], [2, 0], JSON.stringify(t.held()))
  near(1 - t.fatigue(), price, 'one Novice craft')

  // The only copy: no "server did not accept" for the temper that was made
  t = await smith()
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 })
  nativeTemper(t, { baseId: SWORD, count: 1, health: 1.2 })
  t.report(WHEEL_REF, ...stale)
  assert.deepEqual([t.copy(SWORD, 1.2), t.fatigue()], [1, 1])
  assert.deepEqual([t.reverted(), t.notices()], [[], []])

  // A craft another hook refused changed nothing, so its report is judged as any other: too tired
  t = await smith()
  t.setFatigue(price * 0.5)
  t.hold({ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 })
  nativeTemper(t, { baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 })
  t.report(WHEEL_REF, ...stale)
  assert.deepEqual([t.copy(SWORD, 1), t.count(INGOT)], [2, 2])
  assert.deepEqual(t.reverted(), [SWORD])
  assert.deepEqual(t.notices(), ['You are too tired to improve that item. Rest a while.'])

  // Two clicks in one report, the second refused by the native: the first is known, the second is refused
  t = await smith()
  t.hold({ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 })
  nativeTemper(t, { baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }, { baseId: SWORD, count: 1, health: 1.2 })
  t.setFatigue(price * 0.5)
  nativeTemper(t, { baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }, { baseId: SWORD, count: 1, health: 1.2 })
  t.report(WHEEL_REF, [{ baseId: SWORD, count: 2, health: 1.2 }], [{ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 }])
  assert.deepEqual([t.copy(SWORD, 1.2), t.copy(SWORD, 1), t.count(INGOT)], [1, 1, 1], JSON.stringify(t.held()))
  near(t.fatigue(), price * 0.5, 'nothing charged')
  assert.deepEqual(t.reverted(), [SWORD])

  // Later than a report can lag, the same lines are a temper of their own
  t = await smith()
  t.hold({ baseId: SWORD, count: 2 }, { baseId: INGOT, count: 2 })
  nativeTemper(t, { baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }, { baseId: SWORD, count: 1, health: 1.2 })
  now += 3001
  t.report(WHEEL_REF, ...stale)
  assert.deepEqual([t.copy(SWORD, 1.2), t.count(INGOT)], [2, 0], JSON.stringify(t.held()))

  // A poison on the copy just tempered is no temper claim, and a forge craft leaves no note
  t = await smith()
  t.hold({ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 3 }, { baseId: POISON, count: 1 })
  nativeTemper(t, { baseId: SWORD, count: 1, health: 1.2 }, { baseId: INGOT, count: 2 }, { baseId: POISON, count: 1 })
  t.report(0, [{ baseId: SWORD, count: 1, health: 1.2, poisonId: POISON, poisonCount: 1 }], [{ baseId: SWORD, count: 1, health: 1.2 }, { baseId: POISON, count: 1 }])
  assert.equal(t.held().find((e) => e.baseId === SWORD).poisonId, POISON, JSON.stringify(t.held()))
  t.mp.onCraft(ACTOR, SWORD, 1, FORGE_SWORD)
  assert.equal(t.crafted.nativeTempers.get(ACTOR).length, 1, 'only the temper is noted')
})

;(async () => {
  for (const [name, fn] of pending) {
    try {
      now = 1e12
      await fn()
      results.push([true, name])
    } catch (err) {
      results.push([false, name, err])
    }
  }
  let failed = 0
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
    if (!ok) { failed++; console.log(err) }
  }
  console.log(`${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()
