'use strict'

// SurvivalSystem rules against a mock server: settings, body rules on and off, raw meat food poisoning, expiry, cure, shrines, cold, afflictions,
// diseases, contagion and the admin event: node tools/test-survival-rules.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const load = (file) => {
  const source = path.join(__dirname, '..', 'ts', 'systems', file)
  const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const { SurvivalSystem } = load('survivalSystem.ts')
const { LOGIN_SYNC_DELAY_MS, RESYNC_DELAY_MS } = load('stageAbilities.ts')
const C = load('survivalClimate.ts')
const { ARMOR_WARMTH, ARMOR_WARMTH_INPUTS } = load('armorWarmth.ts')
const D = load('survivalDiseases.ts')

const HOUR = 3600000
const T0 = 2e12

const CARRY = 0x887
const REGEN = 0x41340
const WATER = 0x41393
const FOOD_POISON = 0x918
const WEAKENED = 0x910
const ADDLED = 0x911
const FROSTBITTEN = 0x913
const ROCKJOINT = 0xb8782
const RESIST_DISEASE_50 = 0x9001
const RESIST_EFFECT = 0x9002
const NORD_RACE = 0x13746
const REDGUARD_RACE = 0x13748
const KHAJIIT_RACE = 0x13745
const ORC_RACE = 0x13747
const VENISON = 0x65c99
const CURE = 0xae723
const CURE_EFFECT = 0xae722
const HEAL50 = 0x3eadd
const HEAL10 = 0x3eade
const STEW = 0x3eadf
const HEAL_EFFECT = 0x3eb15
const ALTAR = 0xd9883
const ALTAR_REF = 0xff00a000

const u32 = (...vals) => { const b = new Uint8Array(vals.length * 4); vals.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x >>> 0, true)); return b }
const spit = (type) => { const b = new Uint8Array(36); new DataView(b.buffer).setUint32(8, type, true); return b }
const efit = (magnitude) => { const b = new Uint8Array(12); new DataView(b.buffer).setFloat32(0, magnitude, true); return b }
const mgefData = (flags, archetype, av) => { const b = new Uint8Array(0x98); const v = new DataView(b.buffer); v.setUint32(0, flags, true); v.setUint32(0x40, archetype, true); v.setInt32(0x44, av, true); return b }
const enit = (flags) => { const b = new Uint8Array(20); new DataView(b.buffer).setUint32(4, flags, true); return b }
const field = (type, data) => ({ type, data })
const record = (type, editorId, fields = []) => ({ record: { type, editorId, fields }, toGlobalRecordId: (id) => id })
const spell = (editorId, type, effects = []) => record('SPEL', editorId, [field('SPIT', spit(type)), ...effects.flatMap(([id, mag]) => [field('EFID', u32(id)), field('EFIT', efit(mag))])])
const potion = (editorId, effects, flags = 0) => record('ALCH', editorId, [field('ENIT', enit(flags)), ...effects.flatMap(([id, mag]) => [field('EFID', u32(id)), field('EFIT', efit(mag))])])

const RECORDS = new Map([
  [CARRY, spell('Survival_abLowerCarryWeightSpell', 4)],
  [REGEN, spell('AldSurvival_AbNoHealthRegen', 4)],
  [WATER, spell('AldSurvival_FreezingWaterDamage', 4)],
  [FOOD_POISON, spell('Survival_DiseaseFoodPoisoning', 1)],
  [WEAKENED, spell('Survival_AfflictionWeakened', 4)],
  [ADDLED, spell('Survival_AfflictionAddled', 4)],
  [FROSTBITTEN, spell('Survival_AfflictionFrostbitten', 4)],
  [ROCKJOINT, spell('DiseaseRockjoint', 1)],
  [RESIST_DISEASE_50, spell('TestResistDisease50', 4, [[RESIST_EFFECT, 50]])],
  [RESIST_EFFECT, record('MGEF', 'AbResistDisease', [field('DATA', mgefData(0, 0, 45))])],
  [NORD_RACE, record('RACE', 'NordRace')],
  [REDGUARD_RACE, record('RACE', 'RedguardRace', [field('SPLO', u32(RESIST_DISEASE_50))])],
  [KHAJIIT_RACE, record('RACE', 'KhajiitRace')],
  [ORC_RACE, record('RACE', 'OrcRace')],
  [VENISON, potion('FoodVenison', [], 0x2)],
  [CURE_EFFECT, record('MGEF', 'AlchCureDisease', [field('DATA', mgefData(0, 3, -1))])],
  [HEAL_EFFECT, record('MGEF', 'AlchRestoreHealth', [field('DATA', mgefData(0, 0, 24))])],
  [CURE, potion('CureDisease', [[CURE_EFFECT, 0]])],
  [HEAL50, potion('RestoreHealth02', [[HEAL_EFFECT, 50]])],
  [HEAL10, potion('RestoreHealth00', [[HEAL_EFFECT, 10]])],
  [STEW, potion('FoodHealingStew', [[HEAL_EFFECT, 50]], 0x2)],
  [ALTAR, record('ACTI', 'TempleShrineArkay')],
])

const COLD = [0x890, 0x86e, 0x891, 0x86d, 0x870, 0x871]
const TAMRIEL = 0x3c
const INN = 0x1000
const CAVE = 0x1001
const SOVNGARDE = 0x2ee41
const KW_WARM = 0x2ed9
const KW_COLD = 0x2ed8
const KW_HOOD = 0x2edb
const KW_FROST = 0x1cead
const KW_FIRE = 0x1cea8
const FUR = 0x6100
const HOOD = 0x6101
const BOOTS = 0x6102
const TORCH = 0x1d4ec
const MOD_ROBE = 0x6110
const MOD_HARNESS = 0x6111
const FUR_CLOAK = 0x6112
const LINEN_CAPE = 0x6113
const SCARF = 0x6114
const MOD_SHIELD = 0x6115
// The real descs of the mod pieces, as armorWarmth.ts keys them
const MOD_DESCS = new Map([
  [MOD_ROBE, '2316e:Hothtrooper44_ArmorCompilation.esp'], [MOD_HARNESS, '2327d:Hothtrooper44_ArmorCompilation.esp'],
  [FUR_CLOAK, '2883:Cloaks&Capes.esp'], [LINEN_CAPE, '12c7:Cloaks&Capes.esp'], [SCARF, '876:evgnnsmpaccessories.esp'],
])
const FROST_EFFECT = 0x6200
const FIRE_EFFECT = 0x6201
const FROSTBITE = 0x6202
const FLAMES = 0x6203
const RESTORE_COLD = 0x2ee5
const FOOD_WARMTH = 0x2ee6
const HOT_STEW = 0x9e7
const SPIDER_RACE = 0x4e507
const SPIDER = 0xff00b000
const SNOW = 0x4d7fb
const BLIZZARD = 0xc8221
const armor = (editorId, slots, keywords = []) => record('ARMO', editorId, [field('BOD2', u32(slots, 0)), ...(keywords.length ? [field('KWDA', u32(...keywords))] : [])])
const COLD_RECORDS = [
  ...COLD.map((id, i) => [id, spell(`Survival_ColdStage${i}`, 4)]),
  [TAMRIEL, record('WRLD', 'Tamriel')],
  [SOVNGARDE, record('WRLD', 'Sovngarde')],
  [INN, record('CELL', 'TestInn')],
  [CAVE, record('CELL', 'TestCave')],
  [FUR, armor('ArmorFurCuirass', 1 << 2, [KW_WARM])],
  [HOOD, armor('ClothesHood', 1 << 1)],
  [BOOTS, armor('ArmorIronBoots', 1 << 7, [KW_COLD])],
  [MOD_ROBE, armor('IATribunalLightRobeBlackNoCloak', 1 << 2)],
  [MOD_HARNESS, armor('IABrigandIronHide', 1 << 2)],
  [FUR_CLOAK, armor('vol_FurCloak_Black', (1 << 10) | (1 << 16))],
  [LINEN_CAPE, armor('vol_Cape_RED', (1 << 10) | (1 << 16))],
  [SCARF, armor('evgsmpwovenscarfarmor', 1 << 15, [KW_WARM])],
  [MOD_SHIELD, armor('IAShield', 1 << 9)],
  [TORCH, record('LIGH', 'Torch01')],
  [FROST_EFFECT, record('MGEF', 'FrostDamage', [field('DATA', mgefData(0x4, 0, 24)), field('KWDA', u32(KW_FROST))])],
  [FIRE_EFFECT, record('MGEF', 'FireDamage', [field('DATA', mgefData(0x4, 0, 24)), field('KWDA', u32(KW_FIRE))])],
  [FROSTBITE, spell('Frostbite', 0, [[FROST_EFFECT, 8]])],
  [FLAMES, spell('Flames', 0, [[FIRE_EFFECT, 8]])],
  [RESTORE_COLD, record('MGEF', 'Survival_FoodRestoreCold', [field('DATA', mgefData(0, 0, 4))])],
  [FOOD_WARMTH, record('MGEF', 'Survival_FoodFortifyWarmth', [field('DATA', mgefData(0, 34, 76))])],
  [HOT_STEW, potion('Survival_FoodHotBeefStew', [[FOOD_WARMTH, 25], [RESTORE_COLD, 200]], 0x2)],
  [SPIDER_RACE, record('RACE', 'FrostbiteSpiderRace')],
]
for (const [id, rec] of COLD_RECORDS) RECORDS.set(id, rec)

// The plugin's AldDisease_<Id>1..3 at their pinned ids, in catalog order from 0x041341
const DISEASE_IDS = new Map()
Object.values(D.defaultDiseases()).forEach((d, i) => d.spells.forEach((edid, s) => {
  const id = 0x41341 + i * 3 + s
  DISEASE_IDS.set(edid, id)
  RECORDS.set(id, spell(edid, 1))
}))
const sick = (edid) => DISEASE_IDS.get(edid)
const SKEEVER_RACE = 0x13200
const WOLF_RACE = 0x13201
const WEREWOLF_RACE = 0xcdd84
const SKEEVER = 0xff00c000
const WOLF = 0xff00c001
const WEREWOLF = 0xff00c002
const DOG = 0xff00c003
const IRON_SWORD = 0x12eb7
for (const [id, rec] of [[SKEEVER_RACE, record('RACE', 'SkeeverRace')], [WOLF_RACE, record('RACE', 'WolfRace')], [WEREWOLF_RACE, record('RACE', 'WerewolfBeastRace')], [IRON_SWORD, record('WEAP', 'IronSword')]]) RECORDS.set(id, rec)

const desc = (id) => `${(id >>> 0).toString(16)}:Test.esp`

// Each actor: user, race, learned spells; every Papyrus spell call and packet recorded
const makeMp = () => {
  const props = new Map()
  const learned = new Map()
  const users = new Map()
  const calls = []
  const packets = []
  const healthSent = []
  const sentOrder = []
  const known = (id) => { if (!learned.has(id)) learned.set(id, new Set()); return learned.get(id) }
  return {
    props, learned: known, users, calls, packets, healthSent, sentOrder,
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v); if (key === 'percentages') { healthSent.push([id >>> 0, v.health]); sentOrder.push(`health ${v.health}`) } },
    lookupEspmRecordById: (id) => RECORDS.get(id >>> 0) || null,
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => desc(id),
    getUserByActor: (id) => users.get(id >>> 0) ?? 65535,
    getActorCellOrWorld: (id) => { const p = props.get(`${id >>> 0}:place`); if (p === undefined) throw new Error('not in the world'); return p },
    getActorPos: (id) => props.get(`${id >>> 0}:pos`) || [0, 0, 0],
    getActorName: (id) => props.get(`${id >>> 0}:appearance`)?.name,
    getUserActor: (userId) => { for (const [a, u] of users) if (u === userId) return a; return 0 },
    isConnected: () => true,
    sendCustomPacket: (userId, text) => { packets.push([userId, JSON.parse(text)]); sentOrder.push(JSON.parse(text).customPacketType) },
    callPapyrusFunction: (_kind, _cls, method, self, args) => {
      const actor = parseInt(self.desc, 16) >>> 0
      const spells = known(actor)
      if (method === 'GetSpellCount') return spells.size
      if (method === 'GetNthSpell') return { desc: desc(Array.from(spells)[args[0]]) }
      const id = parseInt(args[0].desc, 16) >>> 0
      calls.push(`${actor.toString(16)} ${method === 'AddSpell' ? '+' : '-'}${id.toString(16)}`)
      if (method === 'AddSpell') { if (spells.has(id)) return false; spells.add(id); return true }
      spells.delete(id)
    },
  }
}

const clock = { now: T0 }
const realNow = Date.now
const realTimeout = global.setTimeout
const realRandom = Math.random
Date.now = () => clock.now
global.setTimeout = (f) => setImmediate(f)

const tick = () => new Promise((r) => setImmediate(r))
// Past the learned spell cache and the login delay
const later = (ms = LOGIN_SYNC_DELAY_MS) => { clock.now += ms }

const RACES = { NordRace: false, RedguardRace: false, KhajiitRace: true }
const COLD_MULT = { NordRace: 0, KhajiitRace: 1.25 }
// Base health as RacialSystem.maxHealth reads it: the RACE starting value plus the Player offset, 0 for an unreadable race
const BASE_HEALTH = { OrcRace: 150 }

// A configured system with every record resolved, its hooks on a mock server; actors are added with join
const setup = (settings = { survivalEnabled: true }, cold = false, plugin = true) => {
  const logs = []
  const mp = makeMp()
  const racial = {
    traits: (id) => {
      const raceEdid = RECORDS.get(mp.get(id, 'appearance')?.raceId)?.record.editorId || ''
      return { raceEdid, rawMeatSafe: !!RACES[raceEdid], coldRateMult: COLD_MULT[raceEdid] ?? 1, warmth: 0 }
    },
    maxHealth: (id) => { const edid = racial.traits(id).raceEdid; return edid ? BASE_HEALTH[edid] ?? 100 : 0 },
  }
  const weather = { region: 'coast', weatherId: SNOW, kind: 'snow', regionOf: () => weather.region, currentWeatherOf: () => ({ id: weather.weatherId, edid: 'Weather', kind: weather.kind }) }
  const hunting = { rawMeatIds: () => [VENISON] }
  const sys = new SurvivalSystem((l) => logs.push(String(l)), racial, hunting, weather)
  const { problems } = sys.configure(settings)
  const ids = { Survival_abLowerCarryWeightSpell: CARRY, AldSurvival_AbNoHealthRegen: REGEN, AldSurvival_FreezingWaterDamage: WATER }
  for (const b of sys.body) b.id = b.name ? ids[b.name] || 0 : 0
  sys.foodPoison = FOOD_POISON
  const afflictionIds = { Survival_AfflictionWeakened: WEAKENED, Survival_AfflictionAddled: ADDLED, Survival_AfflictionFrostbitten: FROSTBITTEN }
  for (const a of sys.afflictions) a.id = afflictionIds[a.spell]
  sys.rawMeat = new Set([VENISON])
  sys.altars = new Set([ALTAR])
  if (cold) {
    sys.coldSpells = COLD.slice()
    sys.keywords = { warm: KW_WARM, cold: KW_COLD, bodyAndHead: KW_HOOD, frost: KW_FROST, fire: KW_FIRE }
    sys.coldEffects = { restoreCold: RESTORE_COLD, warmth: FOOD_WARMTH }
    sys.blizzard = new Set([BLIZZARD])
    sys.oblivionAreas = new Set([SOVNGARDE])
    sys.coldCells = new Set([CAVE])
    sys.heatInteriors.set(INN, [[100, 100, 0]])
  }
  if (plugin) for (const d of Object.values(sys.dis.diseases)) sys.diseaseSpells.set(d.id, d.spells.map((edid) => DISEASE_IDS.get(edid) || 0))
  sys.mp = mp
  const ctx = { svr: mp, gm: { on: () => {}, emit: () => {} } }
  if (sys.enabled) sys.installHooks(ctx)
  let nextUser = 1
  const join = (actorId, raceId, stored) => {
    const userId = nextUser++
    mp.users.set(actorId, userId)
    mp.set(actorId, 'profileId', 1)
    mp.set(actorId, 'appearance', { raceId })
    mp.set(actorId, 'respawnPercentages', { health: 1, magicka: 0.5, stamina: 1 })
    mp.set(actorId, 'type', 'MpActor')
    mp.set(actorId, 'isDead', false)
    if (stored) mp.set(actorId, 'private.survival', stored)
    sys.onActorAssigned(ctx, userId, actorId)
    return userId
  }
  const update = () => sys.updateAsync(ctx)
  const notices = (actorId) => mp.packets.filter(([u, p]) => u === mp.users.get(actorId) && p.customPacketType === 'masteryNotice').map(([, p]) => p.text)
  const rec = (actorId) => mp.get(actorId, 'private.survival')
  const states = (actorId) => mp.packets.filter(([u, p]) => u === mp.users.get(actorId) && p.customPacketType === 'survivalState').map(([, p]) => p)
  const put = (actorId, place, pos = [0, 0, 0]) => { mp.set(actorId, 'place', place); mp.set(actorId, 'pos', pos) }
  const wear = (actorId, ...bases) => mp.set(actorId, 'equipment', { inv: { entries: bases.map((baseId) => ({ baseId, count: 1, worn: true })) } })
  // A creature of the race hits the target with the source (unarmed when omitted)
  const creature = (id, raceId) => { mp.set(id, 'appearance', { raceId }); mp.set(id, 'profileId', -1) }
  const hitBy = (target, aggressor, source = 0x1f4, blocked = false) => mp['onPapyrusEvent:OnHit'](target, { type: 'form', desc: desc(aggressor) }, { type: 'espm', desc: desc(source) }, null, false, false, false, blocked)
  return { sys, mp, ctx, logs, problems, join, update, notices, rec, states, put, wear, weather, creature, hitBy }
}

let nextActor = 0xff000100
const actor = () => nextActor++

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  } finally {
    Math.random = realRandom
  }
}

async function main() {
  await test('settings: off by default, the documented defaults, bad values fall back and are named', () => {
    const off = setup({})
    assert.equal(off.sys.enabled, false)
    assert.equal(off.sys.respawnHealth, 0.01)
    assert.equal(off.sys.respawnPoints, 1)
    assert.equal(off.sys.cureMode, 'cureDiseaseOrHealth')
    assert.equal(off.sys.cureMinHealth, 25)
    assert.equal(off.sys.poisonChance, 0.5)
    assert.equal(off.sys.poisonMs, 24 * HOUR)
    assert.deepEqual(off.sys.body.map((b) => b.name), ['Survival_abLowerCarryWeightSpell', 'AldSurvival_AbNoHealthRegen', 'AldSurvival_FreezingWaterDamage'])
    const bad = setup({ survivalEnabled: 'yes', survivalRespawnHealth: 0, survivalRespawnHealthPoints: -1, survivalCure: 'prayer', survivalFoodPoisoningChance: 2, survivalCarryWeightSpell: '', survivalNoHealthRegen: false, survivalRawMeatExtra: 'FoodBeef' })
    assert.equal(bad.sys.enabled, false, 'only true switches it on')
    assert.equal(bad.sys.respawnHealth, 0.01)
    assert.equal(bad.sys.respawnPoints, 1)
    assert.equal(bad.sys.cureMode, 'cureDiseaseOrHealth')
    assert.deepEqual(bad.sys.body.map((b) => b.name), ['', '', 'AldSurvival_FreezingWaterDamage'])
    assert.deepEqual(bad.problems, [
      'survivalRespawnHealth 0 is out of range, 0.01 is used',
      'survivalRespawnHealthPoints -1 is out of range, 1 is used',
      'survivalFoodPoisoningChance 2 is out of range, 0.5 is used',
      'survivalCure "prayer" is not cureDisease or cureDiseaseOrHealth, cureDiseaseOrHealth is used',
      'survivalRawMeatExtra is not a list of strings, none are added',
    ])
  })

  await test('body rules wait out the login delay, grant the three abilities, set the 1 point respawn once and log one line', async () => {
    const t = setup()
    const a = actor()
    t.join(a, NORD_RACE)
    await t.update()
    assert.deepEqual(t.mp.calls, [], 'held back by the login delay')
    later()
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.mp.calls, [`${h} +887`, `${h} +41340`, `${h} +41393`])
    const respawn = t.mp.get(a, 'respawnPercentages')
    assert.deepEqual(respawn, { health: 0.01, magicka: 0.5, stamina: 1 })
    assert.deepEqual(t.rec(a).body, { spells: [desc(CARRY), desc(REGEN), desc(WATER)], respawn: 0.01 })
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell granted, no regen AldSurvival_AbNoHealthRegen granted, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1 of 100 (set), no food poisoning; cold 55 (Comfortable), place not known yet, cold ability none`])
    t.sys.goOffline(t.ctx, a)
    t.logs.length = 0
    t.mp.calls.length = 0
    t.sys.onActorAssigned(t.ctx, t.mp.users.get(a), a)
    later()
    await t.update()
    assert.deepEqual(t.mp.calls, [`${h} +887`, `${h} +41340`, `${h} +41393`], 'AddSpell of a known spell changes nothing')
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell held, no regen AldSurvival_AbNoHealthRegen held, freezing water AldSurvival_FreezingWaterDamage held, respawn health 1 of 100, no food poisoning; cold 55 (Comfortable), place not known yet, cold ability none`])
  })

  await test('a load packet inside the login window replays the granted abilities', async () => {
    const t = setup()
    const a = actor()
    const user = t.join(a, NORD_RACE)
    later()
    await t.update()
    t.mp.calls.length = 0
    t.sys.customPacket(user, 'weatherRequest', {}, t.ctx)
    later(RESYNC_DELAY_MS)
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.mp.calls, [`${h} -887`, `${h} +887`, `${h} -41340`, `${h} +41340`, `${h} -41393`, `${h} +41393`])
    Math.random = () => 0
    t.mp.onEatItem(a, VENISON)
    await tick()
    later(2001)
    t.mp.onEatItem(a, HEAL50)
    await tick()
    t.mp.calls.length = 0
    t.sys.customPacket(user, 'needsRequest', {}, t.ctx)
    later(RESYNC_DELAY_MS)
    await t.update()
    assert.deepEqual(t.mp.calls.slice(-2), [`${h} +918`, `${h} -918`], 'the cured food poisoning is replayed as not held')
  })

  await test('a record the plugin lacks is skipped with a log line, a switch turned off removes what an earlier login granted', async () => {
    const t = setup({ survivalEnabled: true, survivalCarryWeightSpell: '' })
    t.sys.body.find((b) => b.key === 'regen').id = 0
    const a = actor()
    t.join(a, NORD_RACE, { v: 1, at: T0, body: { spells: [desc(CARRY)], respawn: 0.01 }, foodPoisonUntil: 0, foodPoisonSpell: '' })
    t.mp.learned(a).add(CARRY)
    later()
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.mp.calls, [`${h} -887`, `${h} +41393`])
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight off, no regen AldSurvival_AbNoHealthRegen not in the plugin yet, skipped, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1 of 100 (set), removed Survival_abLowerCarryWeightSpell, no food poisoning; cold 55 (Comfortable), place not known yet, cold ability none`])
    assert.deepEqual(t.rec(a).body.spells, [desc(WATER)])
  })

  await test('survival off: a character with body rules gets them undone at login, one without a record is not followed', async () => {
    const t = setup({})
    const a = actor()
    const b = actor()
    t.join(a, NORD_RACE, { v: 1, at: T0, body: { spells: [desc(CARRY), desc(REGEN)], respawn: 0.01 }, foodPoisonUntil: T0 + HOUR, foodPoisonSpell: desc(FOOD_POISON) })
    t.mp.set(a, 'respawnPercentages', { health: 0.01, magicka: 1, stamina: 1 })
    for (const id of [CARRY, REGEN, FOOD_POISON]) t.mp.learned(a).add(id)
    t.join(b, NORD_RACE)
    assert.deepEqual(Array.from(t.sys.online.keys()), [a])
    later()
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.mp.calls, [`${h} -887`, `${h} -41340`, `${h} -918`])
    assert.equal(t.mp.get(a, 'respawnPercentages').health, 1)
    assert.deepEqual(t.rec(a).body, { spells: [], respawn: 1 })
    assert.equal(t.rec(a).foodPoisonUntil, 0)
    assert.deepEqual(t.logs, [`[survival] ${h} body rules off: respawn 100%, abilities removed: Survival_abLowerCarryWeightSpell, AldSurvival_AbNoHealthRegen, Survival_DiseaseFoodPoisoning`])
    assert.equal(t.mp.get(b, 'private.survival'), undefined, 'nothing written for an untouched character')
  })

  await test('respawn: 1 health point of the race, sent to the client after the native respawn and a revive; the share with 0 points, nothing when off', async () => {
    const t = setup()
    const [nord, orc, unread, dead] = [actor(), actor(), actor(), actor()]
    t.join(nord, NORD_RACE)
    t.join(orc, ORC_RACE)
    t.join(unread, 0x999999)
    t.join(dead, NORD_RACE)
    later()
    await t.update()
    assert.equal(t.mp.get(nord, 'respawnPercentages').health, 0.01)
    assert.equal(t.mp.get(orc, 'respawnPercentages').health, 1 / 150)
    assert.equal(t.mp.get(unread, 'respawnPercentages').health, 0.01, 'an unreadable race takes the share')
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${orc.toString(16)} body:`) && l.includes('respawn health 1 of 150 (set)')))
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${unread.toString(16)} body:`) && l.includes('respawn health 1% (set)')))
    t.logs.length = 0
    for (const id of [nord, orc, dead]) t.mp.set(id, 'percentages', { health: t.mp.get(id, 'respawnPercentages').health, magicka: 1, stamina: 0.5 })
    t.mp.healthSent.length = 0
    t.mp.set(dead, 'isDead', true)
    for (const id of [nord, orc, dead]) t.mp.onRespawn(id)
    assert.deepEqual(t.mp.healthSent, [], 'nothing is written inside the hook')
    await tick()
    assert.deepEqual(t.mp.healthSent, [[nord, 1], [nord, 0.01], [orc, 1], [orc, 1 / 150]], 'full first, so the native sends the change; a respawn another hook refused is left alone')
    assert.deepEqual(t.mp.get(nord, 'percentages'), { health: 0.01, magicka: 1, stamina: 0.5 })
    assert.deepEqual(t.logs.filter((l) => l.includes(': health ')), [`[survival] ${nord.toString(16)} respawned: health 1 of 100 sent to the client`, `[survival] ${orc.toString(16)} respawned: health 1 of 150 sent to the client`])
    t.logs.length = 0
    t.mp.set(nord, 'appearance', { raceId: ORC_RACE })
    t.mp.set(nord, 'percentages', { health: 0.8, magicka: 1, stamina: 1 })
    t.mp.healthSent.length = 0
    t.sys.wake(t.mp, nord, 'revived')
    assert.deepEqual(t.mp.healthSent, [[nord, 1], [nord, 1 / 150]])
    assert.equal(t.mp.get(nord, 'respawnPercentages').health, 1 / 150, 'a race changed since the login is followed')
    assert.deepEqual(t.logs, [`[survival] ${nord.toString(16)} revived: health 1 of 150 sent to the client (was 80%)`])
    t.mp.healthSent.length = 0
    t.sys.wake(t.mp, actor(), 'revived')
    assert.deepEqual(t.mp.healthSent, [], 'an offline character is not written')

    const share = setup({ survivalEnabled: true, survivalRespawnHealthPoints: 0, survivalRespawnHealth: 0.25 })
    const s = actor()
    share.join(s, ORC_RACE)
    later()
    await share.update()
    assert.equal(share.mp.get(s, 'respawnPercentages').health, 0.25)
    assert.ok(share.logs[0].includes('respawn health 25% (set)'))
    share.mp.onRespawn(s)
    await tick()
    assert.deepEqual(share.mp.healthSent, [[s, 1], [s, 0.25]])
    assert.equal(share.sys.respawnLine(), '25%')
    assert.equal(t.sys.respawnLine(), "1 point(s) of the race's base health")

    const off = setup({ survivalEnabled: true, survivalRespawnHealth: 1 })
    const o = actor()
    off.join(o, NORD_RACE)
    later()
    await off.update()
    assert.equal(off.mp.get(o, 'respawnPercentages').health, 1)
    assert.ok(off.logs[0].includes('respawn health 100%,'))
    off.mp.onRespawn(o)
    await tick()
    assert.deepEqual(off.mp.healthSent, [], 'survivalRespawnHealth 1 turns the rule off, points or not')
    assert.equal(off.sys.respawnLine(), '100% (off)')
    assert.equal(setup({}).mp.onRespawn, undefined, 'no hook without survivalEnabled')
  })

  await test('a character in creation gets the body rules when the creation finishes', async () => {
    const t = setup()
    const a = actor()
    t.mp.set(a, 'private.creationPending', true)
    t.join(a, NORD_RACE)
    later()
    await t.update()
    assert.deepEqual(t.mp.calls, [])
    t.mp.set(a, 'private.creationPending', false)
    t.sys.onCreationFinished(a)
    await t.update()
    assert.equal(t.mp.calls.length, 3)
    assert.equal(t.mp.get(a, 'respawnPercentages').health, 0.01)
  })

  await test('raw meat: poisoned under the chance, spared above it, never twice, never a raw meat safe race; disease resistance lowers the odds', async () => {
    const t = setup()
    const [nord, redguard, khajiit] = [actor(), actor(), actor()]
    t.join(nord, NORD_RACE)
    t.join(redguard, REDGUARD_RACE)
    t.join(khajiit, KHAJIIT_RACE)
    later()
    await t.update()
    t.logs.length = 0
    t.mp.calls.length = 0
    Math.random = () => 0.3
    for (const id of [nord, redguard, khajiit]) t.mp.onEatItem(id, VENISON)
    await tick()
    const [n, r, k] = [nord, redguard, khajiit].map((id) => id.toString(16))
    assert.deepEqual(t.logs, [
      `[survival] ${n} ate raw FoodVenison: food poisoning 50% x (1 - disease resist 0%) = 50%, roll 0.300, poisoned for 24 h until ${new Date(clock.now + 24 * HOUR).toTimeString().slice(0, 5)}`,
      `[survival] ${r} ate raw FoodVenison: food poisoning 50% x (1 - disease resist 50%) = 25%, roll 0.300, spared`,
      `[survival] ${k} ate raw FoodVenison: KhajiitRace is safe from raw meat`,
    ])
    assert.deepEqual(t.mp.calls, [`${n} +918`])
    assert.equal(t.rec(nord).foodPoisonUntil, clock.now + 24 * HOUR)
    assert.equal(t.rec(nord).foodPoisonSpell, desc(FOOD_POISON))
    assert.deepEqual(t.notices(nord), ['You feel sick: food poisoning slows your magicka and stamina recovery for 24 hours. A Cure Disease potion or a healing potion cures it.'])
    t.logs.length = 0
    Math.random = () => 0
    t.mp.onEatItem(nord, VENISON)
    await tick()
    assert.ok(t.logs[0].endsWith('already has food poisoning until ' + new Date(clock.now + 24 * HOUR).toTimeString().slice(0, 5)), t.logs.join('\n'))
  })

  await test('food poisoning runs out by wall clock, online at the minute tick and for time spent offline', async () => {
    const t = setup()
    const a = actor()
    const b = actor()
    t.join(a, NORD_RACE)
    later()
    await t.update()
    Math.random = () => 0
    t.mp.onEatItem(a, VENISON)
    await tick()
    t.logs.length = 0
    t.mp.calls.length = 0
    later(24 * HOUR + 1)
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.mp.calls, [`${h} -918`])
    assert.equal(t.rec(a).foodPoisonUntil, 0)
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${h} food poisoning ran out at`)), t.logs.join('\n'))
    assert.ok(t.notices(a).includes('Your stomach settles: the food poisoning has passed.'))
    t.join(b, NORD_RACE, { v: 1, at: T0, body: { spells: [], respawn: 1 }, foodPoisonUntil: clock.now - 1, foodPoisonSpell: desc(FOOD_POISON) })
    t.mp.learned(b).add(FOOD_POISON)
    later()
    await t.update()
    assert.ok(t.mp.calls.includes(`${b.toString(16)} -918`))
    assert.equal(t.rec(b).foodPoisonUntil, 0)
  })

  await test('food poisoning shows in survivalState as the first disease while it runs and goes when it runs out', async () => {
    const t = setup({ survivalEnabled: true }, true)
    const a = actor()
    t.join(a, REDGUARD_RACE)
    t.put(a, TAMRIEL, [1000, 1000, 0])
    later()
    await t.update()
    assert.deepEqual(t.states(a).pop().diseases, [])
    Math.random = () => 0
    t.mp.onEatItem(a, VENISON)
    await tick()
    assert.deepEqual(t.states(a).pop().diseases, [{ name: 'Food poisoning', stage: 1 }], 'sent when poisoned')
    later(24 * HOUR + 1)
    await t.update()
    assert.deepEqual(t.states(a).pop().diseases, [], 'sent again when it runs out')
  })

  await test('a Cure Disease potion clears food poisoning and the afflictions; a healing potion of 25 or more also takes every Disease spell', async () => {
    const t = setup()
    const [a, b, c] = [actor(), actor(), actor()]
    const until = clock.now + 10 * HOUR
    for (const id of [a, b, c]) t.join(id, NORD_RACE, { v: 1, at: T0, body: { spells: [], respawn: 1 }, foodPoisonUntil: until, foodPoisonSpell: desc(FOOD_POISON) })
    for (const id of [a, b, c]) for (const s of [FOOD_POISON, WEAKENED, ROCKJOINT]) t.mp.learned(id).add(s)
    later()
    await t.update()
    t.logs.length = 0
    t.mp.calls.length = 0
    t.mp.onEatItem(a, CURE)
    t.mp.onEatItem(b, HEAL50)
    t.mp.onEatItem(c, HEAL10)
    await tick()
    const [ha, hb] = [a, b].map((id) => id.toString(16))
    assert.deepEqual(t.logs, [
      `[survival] ${ha} cured by CureDisease (Cure Disease): food poisoning, Survival_AfflictionWeakened, the native cure took every Disease spell`,
      `[survival] ${hb} cured by RestoreHealth02 (restores 50 health): food poisoning, Survival_AfflictionWeakened, DiseaseRockjoint`,
    ])
    assert.deepEqual(t.mp.calls, [`${ha} -918`, `${ha} -910`, `${hb} -918`, `${hb} -910`, `${hb} -b8782`])
    assert.equal(t.rec(c).foodPoisonUntil, until, 'a potion under 25 health cures nothing')
    assert.deepEqual(t.notices(b), ['The potion cures your sickness.'])
  })

  await test('a healing food and the cureDisease mode cure nothing; a vetoed eat is left alone', async () => {
    const t = setup({ survivalEnabled: true, survivalCure: 'cureDisease' })
    const a = actor()
    t.join(a, NORD_RACE)
    t.mp.learned(a).add(ROCKJOINT)
    later()
    await t.update()
    t.mp.calls.length = 0
    t.mp.onEatItem(a, HEAL50)
    await tick()
    assert.deepEqual(t.mp.calls, [])
    const u = setup()
    const b = actor()
    u.join(b, NORD_RACE)
    u.mp.learned(b).add(ROCKJOINT)
    later()
    await u.update()
    u.mp.calls.length = 0
    u.mp.onEatItem(b, STEW)
    await tick()
    assert.deepEqual(u.mp.calls, [], 'a food is no potion')
    const v = setup()
    const c = actor()
    v.mp.onEatItem = () => false
    v.sys.installHooks(v.ctx)
    v.join(c, NORD_RACE)
    later()
    await v.update()
    v.mp.calls.length = 0
    Math.random = () => 0
    assert.equal(v.mp.onEatItem(c, VENISON), false)
    await tick()
    assert.deepEqual(v.mp.calls, [])
  })

  await test('a shrine cures nothing and says so at most once a minute; it never refuses the activation', async () => {
    const t = setup()
    const a = actor()
    t.join(a, NORD_RACE)
    t.mp.set(ALTAR_REF, 'baseDesc', desc(ALTAR))
    t.mp.learned(a).add(ROCKJOINT)
    const text = 'The shrine offers comfort, but no cure. A Cure Disease potion or a healing potion cures it.'
    assert.equal(t.mp.onActivate(ALTAR_REF, a), true)
    await tick()
    assert.equal(t.mp.onActivate(ALTAR_REF, a), true)
    await tick()
    assert.deepEqual(t.notices(a), [text])
    later(60000)
    t.mp.onActivate(ALTAR_REF, a)
    await tick()
    assert.deepEqual(t.notices(a), [text, text])
    assert.ok(t.mp.learned(a).has(ROCKJOINT))
    assert.ok(t.logs.some((l) => l === `[survival] ${a.toString(16)} prayed at TempleShrineArkay ff00a000: no cure, notice sent`), t.logs.join('\n'))
  })

  await test('an admin reset clears food poisoning and applies the body rules again', async () => {
    const t = setup()
    const a = actor()
    t.join(a, NORD_RACE, { v: 1, at: T0, body: { spells: [], respawn: 1 }, foodPoisonUntil: clock.now + HOUR, foodPoisonSpell: desc(FOOD_POISON) })
    t.mp.learned(a).add(FOOD_POISON)
    assert.equal(t.sys.resetBy(t.ctx, a, 'Admin'), true)
    assert.equal(t.rec(a).foodPoisonUntil, 0)
    later()
    await t.update()
    assert.equal(t.mp.get(a, 'respawnPercentages').health, 0.01)
    assert.equal(t.sys.resetBy(t.ctx, actor(), 'Admin'), false, 'an offline character is not reset')
  })

  await test('cold rules: levels, caps, stages, rate, warmth, areas and the thermometer follow Survival_NeedCold', () => {
    const cfg = C.parseColdSettings({}, [])
    assert.deepEqual([cfg.stages, cfg.caps, cfg.night, cfg.start, cfg.maxHealthPenalty, cfg.kills], [[50, 120, 300, 500, 800], [1, 4, 7, 10, 13], [19, 7], 55, 0.8, false])
    assert.deepEqual(C.coldLevelOf('freezing', true, 'snow', false, cfg.levels), { level: 16, parts: ['freezing', 'night', 'snow'] })
    assert.deepEqual(C.coldLevelOf('cool', true, 'blizzard', false, cfg.levels), { level: 15, parts: ['cool', 'night', 'blizzard'] })
    assert.deepEqual(C.coldLevelOf('warm', false, 'rain', false, cfg.levels), { level: 3, parts: ['warm', 'rain'] })
    assert.equal(C.coldLevelOf('chillyInterior', true, 'snow', false, cfg.levels).level, 6, 'no night or weather indoors')
    assert.equal(C.coldLevelOf('cool', false, '', true, cfg.levels).level, 30)
    assert.equal(C.coldLevelOf('none', true, 'blizzard', false, cfg.levels).level, 0)
    assert.deepEqual([0, 1, 3, 4, 7, 10, 13, 30].map((l) => C.coldCapOf(l, cfg)), [49, 119, 119, 299, 499, 799, 1000, 1000])
    assert.deepEqual([0, 55, 119, 120, 300, 799, 800, 1000].map((c) => C.coldStageOf(c, false, cfg.stages)), [1, 1, 1, 2, 3, 4, 5, 5])
    assert.equal(C.coldStageOf(20, true, cfg.stages), 0)
    const bare = C.coldRatePerSec(16, 0, 1, cfg)
    assert.ok(Math.abs(1000 / bare - 6000.3) < 0.1, 'a snowy coast night fills the bar in 100 minutes')
    assert.ok(Math.abs(C.coldRatePerSec(16, 206, 1, cfg) / bare - 0.15) < 1e-9)
    assert.equal(C.coldRatePerSec(16, 0, 0, cfg), 0)
    assert.equal(C.stepCold(500, 60, 299, 0.1, 40 / 60, false), 460)
    assert.equal(C.stepCold(500, 60, 299, 0.1, 40 / 60, true), 500)
    assert.equal(C.stepCold(300, 60, 299, 0.1, 40 / 60, false), 299)
    assert.equal(C.stepCold(100, 60, 299, 0.5, 40 / 60, false), 130)
    assert.equal(C.stepCold(290, 60, 299, 0.5, 40 / 60, false), 299)
    const w = cfg.warmth
    assert.equal(C.gearWarmth([{ slots: 1 << 2, kind: 'warm', bodyAndHead: false }, { slots: 1 << 1, kind: 'normal', bodyAndHead: false }, { slots: 1 << 7, kind: 'cold', bodyAndHead: false }], true, w), 54 + 18 + 7 + 50)
    assert.equal(C.gearWarmth([{ slots: 1 << 12, kind: 'normal', bodyAndHead: false }, { slots: 1, kind: 'warm', bodyAndHead: false }], false, w), 29, 'a circlet and a helmet warm the head once')
    assert.equal(C.gearWarmth([{ slots: 1 << 2, kind: 'normal', bodyAndHead: true }], false, w), 27 + 18)
    assert.equal(C.gearWarmth([{ slots: 1 << 16, kind: 'warm', bodyAndHead: false }], false, { ...w, cloak: 10 }), 10)
    const piece = (slot, extra) => ({ slots: 1 << (slot - 30), kind: 'normal', bodyAndHead: false, extra })
    assert.equal(C.gearWarmth([piece(46, 20), piece(40, 12), piece(45, 8), piece(44, 3), piece(39, 0)], false, w), 28, 'the warmest piece on the back and the warmest at the neck or face')
    assert.equal(C.gearWarmth([piece(32), piece(46, 12)], false, { ...w, cloak: 10 }), 27 + 12 + 10)
    const at = (p) => C.areaOf({ oblivion: false, interior: false, chilly: false, worldEdid: 'Tamriel', z: 0, regionId: null, ...p }, cfg)
    assert.deepEqual(at({ interior: true }), { area: 'interior', why: 'interior' })
    assert.equal(at({ interior: true, chilly: true }).area, 'chillyInterior')
    assert.equal(at({ oblivion: true, worldEdid: 'Sovngarde' }).area, 'none')
    assert.deepEqual(at({ worldEdid: 'WhiterunWorld', regionId: 'snow' }), { area: 'cool', why: 'world WhiterunWorld' })
    assert.deepEqual(at({ regionId: 'pineForest', z: 19500 }), { area: 'freezing', why: 'height 19500' })
    assert.deepEqual(at({ regionId: 'fallForest', z: 16000 }), { area: 'freezing', why: 'region fallForest above 15150' })
    assert.equal(at({ regionId: 'fallForest', z: 100 }).area, 'warm')
    assert.equal(at({ regionId: 'coast' }).area, 'freezing')
    assert.deepEqual(at({ regionId: 'somewhere' }), { area: 'cool', why: 'region somewhere unlisted' })
    assert.equal(C.isFreezingWater('freezing', 'Tamriel', cfg), true)
    assert.equal(C.isFreezingWater('chillyInterior', '', cfg), true)
    assert.equal(C.isFreezingWater('cool', 'DLC1HunterHQWorld', cfg), true)
    assert.equal(C.isFreezingWater('cool', 'Tamriel', cfg), false)
    assert.deepEqual([20, 12, 6.5, 19, 7].map((h) => C.isNight(h, [19, 7])), [true, false, true, true, false])
    assert.deepEqual([C.weatherAddOf('snow', false, false), C.weatherAddOf('snow', false, true), C.weatherAddOf('snow', true, false), C.weatherAddOf('rainy', false, false), C.weatherAddOf('pleasant', false, false)], ['snow', '', 'blizzard', 'rain', ''])
    assert.deepEqual([
      C.temperatureLevelOf(100, 110, 16, false, 'freezing', cfg.caps), C.temperatureLevelOf(100, 110, 5, false, 'cool', cfg.caps), C.temperatureLevelOf(110, 100, 5, false, 'cool', cfg.caps),
      C.temperatureLevelOf(110, 35, 5, true, 'cool', cfg.caps), C.temperatureLevelOf(75, 0, 5, true, 'cool', cfg.caps), C.temperatureLevelOf(100, 100, 5, false, 'cool', cfg.caps), C.temperatureLevelOf(100, 110, 16, false, 'none', cfg.caps),
    ], [4, 3, 2, 1, 0, 0, 0])
    assert.equal(C.nearHeatPoint([[0, 0, 0]], [580, -580, 580], 580), true)
    assert.equal(C.nearHeatPoint([[0, 0, 0]], [581, 0, 0], 580), false)
    const problems = []
    const odd = C.parseColdSettings({ survivalColdStages: [1, 2], survivalColdHoursToNumb: 0, survivalWarmth: { torch: -1, warm: [60, 30, 25, 25] }, survivalRegionClimate: { coast: 'hot', reach: 'freezing' }, survivalColdLevels: { rain: 5, fog: 2 }, survivalColdOnHit: { falmer: 0, chaurus: 20 }, survivalHighAltitude: { freezingZ: 18000 }, survivalColdKills: 'yes' }, problems)
    assert.deepEqual([odd.stages, odd.hoursToNumb, odd.warmth.torch, odd.warmth.warm, odd.regionClimate.coast, odd.regionClimate.reach, odd.levels.rain, odd.coldOnHit, odd.freezingZ, odd.highRegions, odd.kills],
      [[50, 120, 300, 500, 800], 1.3334, 50, [60, 30, 25, 25], 'freezing', 'freezing', 5, { frostbitespider: 30, falmer: 0, chaurus: 20 }, 18000, { fallForest: 15150 }, false])
    assert.deepEqual(problems, [
      'survivalColdStages [1,2] is not 5 numbers in order, the default is used',
      'survivalWarmth.torch -1 is not usable, ignored',
      'survivalColdHoursToNumb 0 is out of range, the default is used',
      'survivalColdLevels.fog 2 is not usable, ignored',
      'survivalRegionClimate.coast "hot" is not none, warm, cool, freezing, ignored',
      'survivalColdKills "yes" is not true or false, the default is used',
    ])
  })

  const coldRecord = (cold, extra = {}) => ({ v: 1, at: clock.now, body: { spells: [], respawn: 1 }, foodPoisonUntil: 0, foodPoisonSpell: '', cold, coldSpell: '', warmBonus: false, warmUntil: 0, ...extra })

  await test('cold: a snowy night on the coast climbs to Numb in about 100 minutes, swaps the stage abilities, caps the health penalty and never kills by default', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [0, 24] }, true)
    Math.random = () => 0.99
    const a = actor()
    t.join(a, REDGUARD_RACE)
    t.put(a, TAMRIEL, [1000, 1000, 0])
    later()
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell granted, no regen AldSurvival_AbNoHealthRegen granted, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1 of 100 (set), no food poisoning; cold 55 (Comfortable), level 16 (freezing, night, snow; region coast), warmth 0 (0% less cold), freezing water area yes, cold ability Survival_ColdStage1`])
    assert.deepEqual(t.mp.calls, [`${h} +887`, `${h} +41340`, `${h} +41393`, `${h} +86e`])
    assert.deepEqual(t.states(a), [{ customPacketType: 'survivalState', cold: 55, coldStage: 1, coldStageName: 'Comfortable', coldPenalty: 0, temperatureLevel: 0, warmth: 0, freezingArea: true, afflictions: [], diseases: [], contagion: { seconds: 60, range: 150 } }])
    t.logs.length = 0
    t.mp.calls.length = 0
    later(10 * 60000)
    await t.update()
    assert.equal(Math.round(t.rec(a).cold), 155)
    assert.deepEqual(t.mp.calls, [`${h} -86e`, `${h} +891`])
    assert.deepEqual(t.logs, [`[survival] ${h} cold 55 -> 155 (Chilly), level 16 (freezing, night, snow; region coast), warmth 0 (0% less cold)`])
    assert.deepEqual(t.notices(a), ['You are chilly: Your maximum health is reduced. Find warmth or a fire.'])
    const s = t.states(a).pop()
    assert.deepEqual([s.cold, s.coldStage, s.coldPenalty, s.temperatureLevel], [155, 2, 0.04, 4])
    assert.equal(t.rec(a).coldSpell, desc(0x891))
    later(90 * 60000)
    await t.update()
    assert.equal(t.rec(a).cold, 1000)
    assert.deepEqual(t.mp.calls.slice(-2), [`${h} -891`, `${h} +871`])
    assert.equal(t.notices(a).pop(), 'You are numb with cold: Your maximum health is reduced. Find warmth or a fire.')
    assert.equal(t.states(a).pop().coldPenalty, 0.8, 'survivalColdMaxHealthPenalty keeps a fifth of the bar')
    assert.equal(t.mp.get(a, 'isDead'), false)
  })

  await test('cold: Nords gain none, Khajiit gain a quarter more, warm clothes and a torch slow it, the rise stops at the level cap and falls above it', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [0, 24] }, true)
    const [n, k, r, w] = [actor(), actor(), actor(), actor()]
    for (const [id, race] of [[n, NORD_RACE], [k, KHAJIIT_RACE], [r, REDGUARD_RACE], [w, REDGUARD_RACE]]) {
      t.join(id, race)
      t.put(id, TAMRIEL)
    }
    t.wear(w, FUR, HOOD, BOOTS, TORCH)
    later()
    await t.update()
    later(10 * 60000)
    await t.update()
    const bare = C.coldRatePerSec(16, 0, 1, t.sys.cold) * 600
    assert.equal(t.rec(n).cold, 55)
    assert.ok(Math.abs(t.rec(k).cold - (55 + bare * 1.25)) < 1e-6)
    assert.ok(Math.abs(t.rec(r).cold - (55 + bare)) < 1e-6)
    assert.ok(Math.abs(t.rec(w).cold - (55 + bare * (1 - 0.85 * 129 / 206))) < 1e-6)
    assert.equal(t.states(w).pop().warmth, 129)
    t.weather.region = 'tundra'
    t.weather.kind = 'pleasant'
    later(60 * 60000)
    await t.update()
    assert.equal(t.rec(r).cold, 299, 'a cool night (level 5) stops one short of Very Cold')
    t.rec(r).cold = 400
    later(15000)
    t.sys.online.get(r).fightAt = clock.now
    await t.update()
    assert.equal(t.rec(r).cold, 400, 'no warming while fighting')
    later(60000)
    await t.update()
    assert.equal(t.rec(r).cold, 360)
    assert.equal(t.states(r).pop().temperatureLevel, 2)
  })

  await test('cold: standing still at a fire warms by 75 every 6 s, moving does not, and the warm-up is logged when it ends', async () => {
    const t = setup({ survivalEnabled: true }, true)
    const a = actor()
    t.join(a, REDGUARD_RACE, coldRecord(600))
    t.put(a, INN, [300, 300, 0])
    later()
    await t.update()
    const h = a.toString(16)
    later(6000)
    await t.update()
    assert.equal(t.rec(a).cold, 600, 'the first check only notes the position')
    later(6000)
    await t.update()
    assert.equal(t.rec(a).cold, 525)
    assert.equal(t.states(a).pop().temperatureLevel, 1)
    later(6000)
    await t.update()
    assert.equal(t.rec(a).cold, 450, 'the level step is skipped at the fire')
    t.put(a, INN, [2000, 2000, 0])
    later(6000)
    await t.update()
    assert.ok(t.logs.includes(`[survival] ${h} warmed at a fire: cold 600 -> 450`), t.logs.join('\n'))
    later(60000)
    await t.update()
    assert.equal(Math.round(t.rec(a).cold), 406, 'a warm interior takes 40 a minute')
    t.put(a, INN, [150, 150, 0])
    for (let i = 0; i < 20; i++) {
      later(6000)
      await t.update()
    }
    assert.equal(t.rec(a).cold, 0)
    assert.equal(t.rec(a).warmBonus, true)
    assert.equal(t.states(a).pop().coldStageName, 'Warm')
    assert.equal(t.notices(a).pop(), 'You are warm.')
    assert.equal(t.rec(a).coldSpell, desc(0x890))
  })

  await test('cold: a hot meal takes off its cold down to the stage 1 value and warms for 100 minutes', async () => {
    const t = setup({ survivalEnabled: true }, true)
    const a = actor()
    t.join(a, REDGUARD_RACE, coldRecord(640))
    t.put(a, INN, [5000, 5000, 0])
    later()
    await t.update()
    const h = a.toString(16)
    t.logs.length = 0
    t.mp.onEatItem(a, HOT_STEW)
    await tick()
    const until = new Date(clock.now + 100 * 60000).toTimeString().slice(0, 5)
    assert.equal(t.logs.pop(), `[survival] ${h} ate hot Survival_FoodHotBeefStew: cold 640 -> 440, warmth +25 until ${until}`)
    assert.equal(t.rec(a).cold, 440)
    assert.equal(t.rec(a).warmUntil, clock.now + 100 * 60000)
    assert.equal(t.states(a).pop().warmth, 25)
    t.mp.onEatItem(a, HOT_STEW)
    t.mp.onEatItem(a, HOT_STEW)
    await tick()
    assert.equal(t.rec(a).cold, 50)
    later(101 * 60000)
    await t.update()
    assert.equal(t.states(a).pop().warmth, 0)
  })

  await test('cold: frost spells and frostbite venom chill up to Freezing, fire spells warm down to Chilly, a blocked venom hit does nothing', async () => {
    const t = setup({ survivalEnabled: true }, true)
    const a = actor()
    t.join(a, REDGUARD_RACE)
    t.put(a, INN, [5000, 5000, 0])
    t.mp.set(SPIDER, 'appearance', { raceId: SPIDER_RACE })
    later()
    await t.update()
    const h = a.toString(16)
    const hit = (source, blocked = false) => t.mp['onPapyrusEvent:OnHit'](a, { type: 'form', desc: desc(SPIDER) }, { type: 'espm', desc: desc(source) }, null, false, false, false, blocked)
    t.logs.length = 0
    hit(FROSTBITE)
    await tick()
    assert.equal(t.rec(a).cold, 85)
    assert.deepEqual(t.logs, [`[survival] ${h} frost spell Frostbite: cold 55 -> 85`])
    hit(FLAMES)
    await tick()
    assert.equal(t.rec(a).cold, 85, 'fire never warms below the stage 2 value')
    t.rec(a).cold = 135
    hit(FLAMES)
    hit(FLAMES)
    await tick()
    assert.equal(t.rec(a).cold, 120)
    hit(0x1f4)
    await tick()
    assert.equal(t.rec(a).cold, 150)
    assert.ok(t.logs.includes(`[survival] ${h} hit by FrostbiteSpiderRace: cold 120 -> 150`), t.logs.join('\n'))
    hit(0x1f4, true)
    await tick()
    assert.equal(t.rec(a).cold, 150)
    t.rec(a).cold = 490
    hit(FROSTBITE)
    hit(FROSTBITE)
    await tick()
    assert.equal(t.rec(a).cold, 500)
    assert.ok(clock.now - t.sys.online.get(a).fightAt < 1000, 'a hit marks the fight')
  })

  await test('cold: swimming in a freezing area raises cold to Very Cold at once and holds level 30; a flame cloak, a Nord or warm water are spared', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [24, 0] }, true)
    t.weather.kind = 'pleasant'
    const [a, n] = [actor(), actor()]
    const ua = t.join(a, REDGUARD_RACE)
    const un = t.join(n, NORD_RACE)
    t.put(a, TAMRIEL)
    t.put(n, TAMRIEL)
    later()
    await t.update()
    const h = a.toString(16)
    t.logs.length = 0
    t.sys.customPacket(ua, 'survivalReport', { swimming: true, flameCloak: false }, t.ctx)
    t.sys.customPacket(un, 'survivalReport', { swimming: true, flameCloak: false }, t.ctx)
    assert.equal(t.rec(a).cold, 300)
    assert.equal(t.rec(n).cold, 55)
    assert.ok(t.logs.includes(`[survival] ${h} swimming in freezing water: level 30, cold 55`), t.logs.join('\n'))
    const s = t.states(a).pop()
    assert.deepEqual([s.coldStage, s.freezingArea], [3, true])
    later(300)
    t.sys.customPacket(ua, 'survivalReport', { swimming: true, flameCloak: true }, t.ctx)
    assert.ok(t.logs.includes(`[survival] ${h} out of the freezing water: level 6, cold 300`), t.logs.join('\n'))
    t.weather.region = 'tundra'
    later(300)
    t.sys.customPacket(ua, 'survivalReport', { swimming: true, flameCloak: false }, t.ctx)
    assert.equal(t.states(a).pop().freezingArea, false)
    assert.ok(t.rec(a).cold <= 300)
  })

  await test('cold: offline time warms to the start value, a respawn starts over, a request resends the state, a warmth mismatch is logged once', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [24, 0] }, true)
    const [a, b] = [actor(), actor()]
    const ua = t.join(a, REDGUARD_RACE, coldRecord(900, { at: clock.now - 30 * 60000 }))
    t.join(b, REDGUARD_RACE, coldRecord(900, { at: clock.now - 2 * HOUR }))
    t.put(a, INN, [5000, 5000, 0])
    t.put(b, INN, [5000, 5000, 0])
    t.wear(a, FUR)
    later()
    await t.update()
    const h = a.toString(16)
    assert.equal(t.rec(a).cold, 400)
    assert.equal(t.rec(b).cold, 55)
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${h} body:`) && l.includes('cold 400 (Very Cold), warmed offline 0.5 h: 900 -> 400, level 0 (interior; interior)')), t.logs.join('\n'))
    t.mp.set(a, 'percentages', { health: 0.01, magicka: 1, stamina: 1 })
    t.mp.sentOrder.length = 0
    t.mp.onRespawn(a)
    await tick()
    assert.equal(t.rec(a).cold, 55)
    assert.ok(t.logs.includes(`[survival] ${h} respawned: cold 400 -> 55`))
    const order = t.mp.sentOrder.filter((x) => x === 'survivalState' || x.startsWith('health'))
    assert.deepEqual(order, ['survivalState', 'health 1', 'health 0.01'], 'the state lifts the cold penalty before the health write')
    assert.equal(t.states(a).pop().coldPenalty, 0)
    assert.ok(t.logs.indexOf(`[survival] ${h} respawned: cold 400 -> 55`) < t.logs.indexOf(`[survival] ${h} respawned: health 1 of 100 sent to the client`))
    const sent = t.states(a).length
    t.sys.customPacket(ua, 'survivalRequest', {}, t.ctx)
    assert.equal(t.states(a).length, sent + 1)
    t.logs.length = 0
    t.sys.customPacket(ua, 'survivalReport', { swimming: false, flameCloak: false, engineWarmth: 60 }, t.ctx)
    later(300)
    t.sys.customPacket(ua, 'survivalReport', { swimming: false, flameCloak: false, engineWarmth: 60 }, t.ctx)
    later(300)
    t.sys.customPacket(ua, 'survivalReport', { swimming: false, flameCloak: false, engineWarmth: 54 }, t.ctx)
    assert.deepEqual(t.logs, [`[survival] ${h} warmth mismatch: engine 60, server 54 (gear 54, race 0), worn ArmorFurCuirass`])
  })

  await test('cold: armorWarmth.ts rates a mod robe warm and a bare harness cold and adds a cloak and a scarf once each; keyword pieces and survivalWarmthTable false keep the engine rating', async () => {
    const run = async (settings, ...worn) => {
      const t = setup({ survivalEnabled: true, survivalNightHours: [0, 24], ...settings }, true)
      const inner = t.mp.getDescFromId
      t.mp.getDescFromId = (id) => MOD_DESCS.get(id) || inner(id)
      const a = actor()
      const ua = t.join(a, REDGUARD_RACE)
      t.put(a, TAMRIEL)
      t.wear(a, ...worn)
      later()
      await t.update()
      return { t, a, ua, warmth: t.states(a).pop().warmth }
    }
    assert.equal((await run({}, MOD_ROBE)).warmth, 54)
    assert.equal((await run({}, MOD_HARNESS)).warmth, 17)
    assert.equal((await run({}, MOD_ROBE, FUR_CLOAK, LINEN_CAPE, SCARF, MOD_SHIELD)).warmth, 54 + 20 + 8)
    assert.equal((await run({}, LINEN_CAPE)).warmth, 12)
    assert.equal((await run({}, FUR, HOOD, BOOTS)).warmth, 54 + 18 + 7)
    assert.equal((await run({ survivalWarmthTable: false }, MOD_ROBE, FUR_CLOAK, SCARF)).warmth, 27)
    const { t, a, ua } = await run({}, MOD_ROBE, FUR_CLOAK)
    const entries = Object.values(ARMOR_WARMTH).reduce((n, e) => n + (e.warm || []).length + (e.cold || []).length + (e.extra || []).length, 0)
    const heat = { interiors: 0, worlds: 0, points: 0, unknown: 0 }
    assert.ok(t.sys.coldLine(heat).includes(`cloak 0, armorWarmth.ts rates ${entries} more pieces, up to 206`), t.sys.coldLine(heat))
    assert.ok((await run({ survivalWarmthTable: false })).t.sys.coldLine(heat).includes('armorWarmth.ts off (survivalWarmthTable false)'))
    t.logs.length = 0
    t.sys.customPacket(ua, 'survivalReport', { swimming: false, flameCloak: false, engineWarmth: 27 }, t.ctx)
    assert.deepEqual(t.logs, [], 'the engine total is held against the keyword rating, so a table piece is no mismatch')
    later(300)
    t.sys.customPacket(ua, 'survivalReport', { swimming: false, flameCloak: false, engineWarmth: 40 }, t.ctx)
    assert.deepEqual(t.logs, [`[survival] ${a.toString(16)} warmth mismatch: engine 40, server 27 (gear 27, race 0; gear 74 with armorWarmth.ts), worn IATribunalLightRobeBlackNoCloak, vol_FurCloak_Black`])
  })

  await test('cold: the generated armorWarmth.ts lists each piece once with a class or 1 to 20 points and matches its own counts', async () => {
    const counts = ARMOR_WARMTH_INPUTS.counts
    let warm = 0, cold = 0, extra = 0
    for (const [plugin, t] of Object.entries(ARMOR_WARMTH)) {
      const ids = [...(t.warm || []), ...(t.cold || []), ...(t.extra || []).map((e) => e[0])]
      assert.equal(new Set(ids).size, ids.length, `${plugin} lists a piece twice`)
      assert.ok(ids.every((id) => Number.isInteger(id) && id > 0 && id <= 0xffffff), plugin)
      assert.ok((t.extra || []).every((e) => e.length === 2 && e[1] >= 1 && e[1] <= 20), `${plugin} extra points`)
      warm += (t.warm || []).length
      cold += (t.cold || []).length
      extra += (t.extra || []).length
    }
    const sum = (prefix) => Object.entries(counts).filter(([k]) => k.startsWith(prefix) && !k.includes('keyword')).reduce((n, [, v]) => n + v, 0)
    assert.equal(warm, sum('warm ('))
    assert.equal(cold, sum('cold ('))
    assert.equal(extra, counts.extra)
    assert.ok(warm > 500 && cold > 10 && extra > 100, `${warm} warm, ${cold} cold, ${extra} extra`)
    const has = (plugin, key, id) => (ARMOR_WARMTH[plugin]?.[key] || []).some((e) => (Array.isArray(e) ? e[0] : e) === id)
    assert.ok(has('Hothtrooper44_ArmorCompilation.esp', 'warm', 0x232f5), 'Snow Bear Armor is warm')
    assert.ok(has('Hothtrooper44_ArmorCompilation.esp', 'cold', 0x5a5c), 'Barbarian Armor is cold')
    assert.ok(!has('Hothtrooper44_ArmorCompilation.esp', 'warm', 0xd84) && !has('Hothtrooper44_ArmorCompilation.esp', 'cold', 0xd84), 'Vanguard Plate Armor stays normal')
    assert.deepEqual(ARMOR_WARMTH['Cloaks&Capes.esp'].extra.find((e) => e[0] === 0x2883), [0x2883, 20], 'Fur Cloak (Black)')
    assert.ok(!Object.keys(ARMOR_WARMTH).some((p) => /\.(esp|esm|esl)$/i.test(p) === false))
  })

  await test('cold: survival off or cold off takes back the stage ability; with survivalColdKills a character dies at 1000', async () => {
    const t = setup({}, true)
    const a = actor()
    t.join(a, NORD_RACE, coldRecord(400, { coldSpell: desc(0x86d) }))
    t.mp.learned(a).add(0x86d)
    later()
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.mp.calls, [`${h} -86d`])
    assert.deepEqual(t.logs, [`[survival] ${h} body rules off: respawn 100% (already), abilities removed: Survival_ColdStage3`])
    assert.equal(t.rec(a).coldSpell, '')
    assert.deepEqual(t.states(a), [], 'nothing is sent with survival off')
    const u = setup({ survivalEnabled: true, survivalColdEnabled: false }, true)
    const b = actor()
    u.join(b, NORD_RACE, coldRecord(400, { coldSpell: desc(0x86d) }))
    u.put(b, TAMRIEL)
    later()
    await u.update()
    assert.ok(u.mp.calls.includes(`${b.toString(16)} -86d`))
    assert.ok(u.logs[0].endsWith('removed Survival_ColdStage3, no food poisoning; cold off, freezing water area yes'), u.logs[0])
    assert.deepEqual(u.states(b).pop(), { customPacketType: 'survivalState', cold: -1, coldStage: -1, coldStageName: '', coldPenalty: 0, temperatureLevel: 0, warmth: 0, freezingArea: true, afflictions: [], diseases: [], contagion: { seconds: 60, range: 150 } })
    const v = setup({ survivalEnabled: true, survivalColdKills: true, survivalNightHours: [0, 24] }, true)
    Math.random = () => 0.99
    const c = actor()
    v.join(c, REDGUARD_RACE, coldRecord(990))
    v.put(c, TAMRIEL)
    later()
    await v.update()
    later(120000)
    await v.update()
    assert.equal(v.mp.get(c, 'isDead'), true)
    assert.ok(v.logs.includes(`[survival] ${c.toString(16)} died of cold at 1000`))
  })

  await test('cold: nothing moves in an Oblivion plane or while the character is not in the world', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [0, 24] }, true)
    const [a, b] = [actor(), actor()]
    t.join(a, REDGUARD_RACE, coldRecord(300))
    t.join(b, REDGUARD_RACE, coldRecord(300))
    t.put(a, SOVNGARDE)
    later()
    await t.update()
    later(30 * 60000)
    await t.update()
    assert.equal(t.rec(a).cold, 300)
    assert.equal(t.rec(b).cold, 300)
    assert.equal(t.states(a).pop().temperatureLevel, 0)
    assert.deepEqual(t.states(b), [])
  })

  const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5)

  await test('afflictions: the vanilla chances and intervals by default, a key or the whole setting false turns them off, bad values are named', () => {
    const t = setup({ survivalEnabled: true })
    assert.deepEqual(t.sys.afflictions.map((a) => [a.key, a.chance, a.tickMs / 60000]), [['weakened', 0.2, 15], ['addled', 0.3, 30], ['frostbitten', 0.16, 5]])
    assert.equal(t.sys.afflictionMs, 24 * HOUR)
    const u = setup({ survivalEnabled: true, survivalAfflictions: { addled: false, weakened: { chance: 2, tickMinutes: 10 }, frostbitten: 'no' }, survivalAfflictionHours: 0 })
    assert.deepEqual(u.sys.afflictions.map((a) => [a.chance, a.tickMs / 60000]), [[0.2, 10], [0, 30], [0.16, 5]])
    assert.deepEqual(u.problems, [
      'survivalAfflictionHours 0 is out of range, 24 is used',
      'survivalAfflictions.weakened.chance 2 is not between 0 and 1, 0.2 is used',
      'survivalAfflictions.frostbitten "no" is not an object or false, the default is used',
    ])
    assert.deepEqual(setup({ survivalEnabled: true, survivalAfflictions: false }).sys.afflictions.map((a) => a.chance), [0, 0, 0])
  })

  await test('afflictions: starving rolls Weakened on reaching stage 5 and every 15 minutes there, never while held', async () => {
    const t = setup({ survivalEnabled: true })
    const a = actor()
    t.join(a, NORD_RACE)
    later()
    await t.update()
    const h = a.toString(16)
    t.logs.length = 0
    t.mp.calls.length = 0
    Math.random = () => 0.5
    t.sys.onNeedsStage(t.ctx, a, 4, 1)
    await tick()
    assert.deepEqual(t.logs, [])
    t.sys.onNeedsStage(t.ctx, a, 5, 1)
    await tick()
    assert.deepEqual(t.logs, [`[survival] ${h} starving: weakened 20%, roll 0.500, spared`])
    later(60000)
    t.sys.onNeedsStage(t.ctx, a, 5, 1)
    await tick()
    assert.equal(t.logs.length, 1, 'the next roll waits 15 minutes')
    later(14 * 60000)
    Math.random = () => 0.1
    t.sys.onNeedsStage(t.ctx, a, 5, 1)
    await tick()
    const until = clock.now + 24 * HOUR
    assert.equal(t.logs.pop(), `[survival] ${h} starving: weakened 20%, roll 0.100, weakened for 24 h until ${hhmm(until)}`)
    assert.deepEqual(t.mp.calls, [`${h} +910`])
    assert.deepEqual(t.rec(a).afflictions, { weakened: { until, spell: desc(WEAKENED) } })
    assert.equal(t.notices(a).pop(), 'Starving has weakened you: your one-handed, two-handed and block skills suffer for 24 hours. A Cure Disease potion or a healing potion cures it.')
    assert.deepEqual(t.states(a).pop().afflictions, ['Weakened'])
    later(20 * 60000)
    t.sys.onNeedsStage(t.ctx, a, 5, 1)
    await tick()
    assert.deepEqual(t.mp.calls, [`${h} +910`], 'no roll while weakened')
  })

  await test('afflictions: debilitated rolls Addled at most once per 30 min even when fatigue leaves stage 5 and comes back, nothing rolls in creation, dead or with the chance at 0', async () => {
    const t = setup({ survivalEnabled: true, survivalAfflictions: { weakened: { chance: 0 } } })
    const [a, b, c] = [actor(), actor(), actor()]
    t.join(a, NORD_RACE)
    t.join(b, NORD_RACE)
    t.join(c, NORD_RACE)
    later()
    await t.update()
    const h = a.toString(16)
    t.logs.length = 0
    Math.random = () => 0.5
    t.sys.onNeedsStage(t.ctx, a, 5, 5)
    await tick()
    assert.deepEqual(t.logs, [`[survival] ${h} debilitated: addled 30%, roll 0.500, spared`], 'weakened at chance 0 never rolls')
    later(30000)
    t.sys.onNeedsStage(t.ctx, a, 5, 4)
    later(20000)
    t.sys.onNeedsStage(t.ctx, a, 5, 5)
    await tick()
    assert.equal(t.logs.length, 1, 'back at stage 5 within a minute of the last roll')
    later(60000)
    t.sys.onNeedsStage(t.ctx, a, 5, 4)
    later(1000)
    Math.random = () => 0.2
    t.sys.onNeedsStage(t.ctx, a, 5, 5)
    await tick()
    assert.equal(t.logs.length, 1, 'back at stage 5 two minutes after the last roll: the rest-then-work loop rolls nothing')
    later(30 * 60000 - 111000 - 1)
    t.sys.onNeedsStage(t.ctx, a, 5, 5)
    await tick()
    assert.equal(t.logs.length, 1, 'still inside the 30 min interval')
    later(1)
    t.sys.onNeedsStage(t.ctx, a, 5, 5)
    await tick()
    assert.equal(t.logs.pop(), `[survival] ${h} debilitated: addled 30%, roll 0.200, addled for 24 h until ${hhmm(clock.now + 24 * HOUR)}`)
    assert.ok(t.mp.calls.includes(`${h} +911`))
    t.mp.set(b, 'private.creationPending', true)
    t.mp.set(c, 'isDead', true)
    t.sys.onNeedsStage(t.ctx, b, 5, 5)
    t.sys.onNeedsStage(t.ctx, c, 5, 5)
    await tick()
    assert.deepEqual([t.rec(b).afflictions, t.rec(c).afflictions], [{}, {}])
  })

  await test('afflictions: Numb rolls Frostbitten every 5 minutes in the cold step', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [0, 24] }, true)
    const a = actor()
    t.join(a, REDGUARD_RACE, coldRecord(798))
    t.put(a, TAMRIEL)
    later()
    await t.update()
    const h = a.toString(16)
    Math.random = () => 0.5
    later(15000)
    await t.update()
    assert.ok(t.logs.includes(`[survival] ${h} numb: frostbitten 16%, roll 0.500, spared`), t.logs.join('\n'))
    later(15000)
    await t.update()
    assert.equal(t.logs.filter((l) => l.includes('numb: frostbitten')).length, 1)
    Math.random = () => 0.1
    later(5 * 60000)
    await t.update()
    assert.ok(t.logs.includes(`[survival] ${h} numb: frostbitten 16%, roll 0.100, frostbitten for 24 h until ${hhmm(clock.now + 24 * HOUR)}`), t.logs.join('\n'))
    assert.ok(t.mp.calls.includes(`${h} +913`))
    assert.deepEqual(t.states(a).pop().afflictions, ['Frostbitten'])
  })

  await test('afflictions: they run out after survivalAfflictionHours online and offline, the login line names those held, a cure, a reset and survival off take them', async () => {
    const t = setup({ survivalEnabled: true })
    const [a, b, c] = [actor(), actor(), actor()]
    const weakened = (until) => ({ weakened: { until, spell: desc(WEAKENED) } })
    t.join(a, NORD_RACE, coldRecord(55, { afflictions: weakened(clock.now + HOUR) }))
    t.join(b, NORD_RACE, coldRecord(55, { afflictions: weakened(clock.now - 1) }))
    t.join(c, NORD_RACE, coldRecord(55, { afflictions: { ...weakened(clock.now + 3 * HOUR), addled: { until: clock.now + 3 * HOUR, spell: desc(ADDLED) } } }))
    for (const id of [a, b, c]) t.mp.learned(id).add(WEAKENED)
    t.mp.learned(c).add(ADDLED)
    later()
    await t.update()
    const [ha, hb, hc] = [a, b, c].map((id) => id.toString(16))
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${ha} body:`) && l.includes(`no food poisoning, weakened until ${hhmm(clock.now - 5000 + HOUR)}; cold 55`)), t.logs.join('\n'))
    assert.ok(t.mp.calls.includes(`${hb} -910`))
    assert.ok(t.logs.includes(`[survival] ${hb} weakened ran out at ${hhmm(clock.now - 5001)}`), t.logs.join('\n'))
    assert.deepEqual(t.rec(b).afflictions, {})
    assert.ok(t.notices(b).includes('You recover: you are no longer weakened.'))
    t.mp.calls.length = 0
    later(HOUR)
    await t.update()
    assert.deepEqual(t.mp.calls.filter((x) => x.startsWith(ha)), [`${ha} -910`])
    assert.deepEqual(t.rec(a).afflictions, {})
    t.logs.length = 0
    t.mp.onEatItem(c, CURE)
    await tick()
    assert.deepEqual(t.logs, [`[survival] ${hc} cured by CureDisease (Cure Disease): Survival_AfflictionWeakened, Survival_AfflictionAddled, the native cure took every Disease spell`])
    assert.deepEqual(t.rec(c).afflictions, {})
    const d = actor()
    t.join(d, NORD_RACE, coldRecord(55, { afflictions: weakened(clock.now + HOUR), lastRoll: { weakened: clock.now } }))
    assert.equal(t.sys.resetBy(t.ctx, d, 'Admin'), true)
    assert.deepEqual([t.rec(d).afflictions, t.rec(d).lastRoll], [{}, {}])
    const off = setup({})
    const e = actor()
    off.join(e, NORD_RACE, coldRecord(55, { afflictions: weakened(clock.now + HOUR) }))
    off.mp.learned(e).add(WEAKENED)
    later()
    await off.update()
    assert.deepEqual(off.logs, [`[survival] ${e.toString(16)} body rules off: respawn 100% (already), abilities removed: Survival_AfflictionWeakened`])
    assert.deepEqual(off.rec(e).afflictions, {})
  })

  const mmdd = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm(ms)}` }
  const x = (id) => id.toString(16)
  const held = (id, stage, nextAt, extra = {}) => ({ id, stage, nextAt, since: T0, from: 'admin', spell: desc(sick(`AldDisease_${id[0].toUpperCase()}${id.slice(1)}${stage}`)), ...extra })

  await test('diseases: the catalog, carriers and stages follow survival.md 2.3; bad settings fall back and are named', () => {
    const cfg = D.parseDiseaseSettings({}, [])
    const defs = Object.values(cfg.diseases)
    assert.equal(defs.length, 27)
    assert.equal(defs.filter((d) => d.contagious).length, 19)
    assert.deepEqual([cfg.enabled, cfg.stageHours, cfg.max, cfg.exclude, cfg.contagion], [true, [84, 84], 4, ['werewolf', 'werebear'], { chance: 0.05, range: 150, rangeFrom: 'the chat whisper range', checkSeconds: 60, cooldownMinutes: 30 }])
    assert.deepEqual(D.parseDiseaseSettings({ chatRanges: { whisper: 200, say: 2000 } }, []).contagion, { chance: 0.05, range: 200, rangeFrom: 'the chat whisper range, chatRanges.whisper', checkSeconds: 60, cooldownMinutes: 30 })
    assert.deepEqual(D.parseDiseaseSettings({ chatRanges: { whisper: 200 }, survivalContagionRange: 300, survivalContagionCheckSeconds: 30, survivalContagionCooldownMinutes: 0 }, []).contagion, { chance: 0.05, range: 300, rangeFrom: 'survivalContagionRange', checkSeconds: 30, cooldownMinutes: 0 })
    assert.deepEqual([60, 30, 4].map(D.exposureGapMs), [55000, 25000, 2000])
    assert.deepEqual(cfg.diseases.boneBreakFever.spells, ['AldDisease_BoneBreakFever1', 'AldDisease_BoneBreakFever2', 'AldDisease_BoneBreakFever3'])
    assert.deepEqual(cfg.carriers.skeever, { chance: 0.1, diseases: ['ataxia', 'bloodLung', 'feebleLimb', 'redRage', 'shakes', 'witlessPox'] })
    assert.deepEqual(['SkeeverWhiteRace', 'WolfRace', 'WerewolfBeastRace', 'BearSnowRace', 'DLC2WerebearBeastRace', 'SabreCatSnowyRace', 'DLC2AshHopperRace', 'NordRace', ''].map((r) => D.carrierOf(r, cfg.carriers, cfg.exclude)), ['skeever', 'wolf', '', 'bear', '', 'sabrecat', 'ashhopper', '', ''])
    assert.equal(D.pickDisease(['a', 'b', 'c'], ['a'], 0.99), 'c')
    assert.equal(D.pickDisease(['a'], ['a'], 0), '')
    assert.ok(Math.abs(D.resistedChance(0.1, 75) - 0.025) < 1e-12)
    assert.equal(D.resistedChance(0.1, 100), 0)
    assert.deepEqual(D.stageAt(1, T0 + HOUR, T0, [84, 84]), { stage: 1, nextAt: T0 + HOUR })
    assert.deepEqual(D.stageAt(1, T0, T0, [84, 84]), { stage: 2, nextAt: T0 + 84 * HOUR })
    assert.deepEqual(D.stageAt(1, T0, T0 + 200 * HOUR, [84, 84]), { stage: 3, nextAt: 0 })
    assert.deepEqual(D.stageAt(3, 0, T0 + 1e9, [84, 84]), { stage: 3, nextAt: 0 })
    assert.deepEqual([D.nextStageAt(2, T0, [84, 12]), D.nextStageAt(3, T0, [84, 12])], [T0 + 12 * HOUR, 0])
    assert.equal(D.diseaseFactor(cfg.diseases, [{ id: 'collywobbles', stage: 2 }, { id: 'ataxia', stage: 3 }], 'hunger'), 1.5)
    assert.equal(D.diseaseFactor(cfg.diseases, [{ id: 'gutworm', stage: 3 }, { id: 'brownRot', stage: 1 }], 'food'), 0.25)
    assert.equal(D.diseaseFactor(cfg.diseases, [], 'cold'), 1)
    const problems = []
    const odd = D.parseDiseaseSettings({ survivalDiseases: { chills: false, rockjoint: { name: 'Stonejoint', stageHours: [1, 2], cure: 'x' }, plague: {} }, survivalDiseaseCarriers: { skeever: false, Spider: { chance: 0.2, diseases: ['ataxia', 'chills'] }, troll: { chance: 3 } }, survivalMaxDiseases: 0, survivalContagionChance: 2, survivalContagionRange: 0, survivalContagionCooldownMinutes: -1, chatRanges: { whisper: 'far' }, survivalDiseaseStageHours: [1] }, problems)
    assert.equal(odd.diseases.chills, undefined)
    assert.deepEqual([odd.diseases.rockjoint.name, odd.diseases.rockjoint.stageHours, odd.diseases.ataxia.stageHours], ['Stonejoint', [1, 2], [84, 84]])
    assert.equal(odd.carriers.skeever, undefined)
    assert.deepEqual(odd.carriers.spider, { chance: 0.2, diseases: ['ataxia'] })
    assert.deepEqual(odd.carriers.icewraith.diseases, [])
    assert.deepEqual(odd.carriers.troll, { chance: 0.06, diseases: ['gutworm'] })
    assert.deepEqual([odd.max, odd.contagion.chance, odd.contagion.range, odd.contagion.rangeFrom, odd.contagion.cooldownMinutes], [4, 0.05, 150, 'the chat whisper range', 30])
    assert.deepEqual(problems, [
      'survivalDiseaseStageHours [1] is not 2 hours above 0, the default is used',
      'survivalDiseases.rockjoint.cure "x" is not usable, ignored',
      'survivalDiseases.plague is no catalog disease, ignored',
      'survivalDiseaseCarriers.Spider names chills, no disease in force, left out',
      'survivalDiseaseCarriers.troll {"chance":3} is not { chance 0 to 1, diseases [ids] } or false, ignored',
      'survivalContagionRange 0 is out of range, the default is used',
      'survivalMaxDiseases 0 is out of range, the default is used',
      'survivalContagionChance 2 is out of range, the default is used',
      'survivalContagionCooldownMinutes -1 is out of range, the default is used',
    ])
  })

  await test('diseases: a carrier creature\'s hit rolls its chance times disease resistance once and gives one disease the character lacks', async () => {
    const t = setup()
    const [n, r] = [actor(), actor()]
    t.join(n, NORD_RACE)
    t.join(r, REDGUARD_RACE)
    t.creature(SKEEVER, SKEEVER_RACE)
    later()
    await t.update()
    t.logs.length = 0
    t.mp.calls.length = 0
    const a1 = sick('AldDisease_Ataxia1')
    Math.random = () => 0
    t.hitBy(n, SKEEVER)
    await tick()
    assert.deepEqual(t.logs, [`[survival] ${x(n)} hit by SkeeverRace ff00c000: skeever 10% x (1 - disease resist 0%) = 10%, roll 0.000, caught ataxia (AldDisease_Ataxia1), stage 2 at ${mmdd(clock.now + 84 * HOUR)}`])
    assert.deepEqual(t.mp.calls, [`${x(n)} +${x(a1)}`])
    assert.deepEqual(t.rec(n).diseases, [{ id: 'ataxia', stage: 1, nextAt: clock.now + 84 * HOUR, since: clock.now, from: 'skeever SkeeverRace', spell: desc(a1) }])
    assert.equal(t.notices(n).pop(), 'You have caught Ataxia: picking locks and pockets is harder. It worsens over the coming days. A Cure Disease potion or a healing potion cures it.')
    assert.deepEqual(t.states(n).pop().diseases, [{ name: 'Ataxia', stage: 1 }])
    t.hitBy(n, SKEEVER, IRON_SWORD)
    await tick()
    assert.deepEqual(t.rec(n).diseases.map((d) => d.id), ['ataxia', 'bloodLung'], 'the next success picks a disease not held')
    t.logs.length = 0
    Math.random = () => 0.07
    t.hitBy(r, SKEEVER)
    await tick()
    assert.deepEqual(t.logs, [`[survival] ${x(r)} hit by SkeeverRace ff00c000: skeever 10% x (1 - disease resist 50%) = 5%, roll 0.070, spared`])
    t.logs.length = 0
    Math.random = () => 0
    t.creature(DOG, WOLF_RACE)
    t.mp.set(DOG, 'private.pet', { owner: n })
    t.creature(WEREWOLF, WEREWOLF_RACE)
    t.hitBy(r, SKEEVER, 0x1f4, true)
    t.hitBy(r, SKEEVER, FROSTBITE)
    t.hitBy(r, n)
    t.hitBy(r, DOG)
    t.hitBy(r, WEREWOLF)
    await tick()
    assert.deepEqual([t.logs, t.rec(r).diseases], [[], []], 'a blocked hit, a spell, a player, a pet and a werewolf carry nothing')
    const u = setup({ survivalEnabled: true, survivalMaxDiseases: 1 })
    const w = actor()
    u.join(w, NORD_RACE)
    u.creature(WOLF, WOLF_RACE)
    later()
    await u.update()
    u.hitBy(w, WOLF)
    await tick()
    u.logs.length = 0
    u.hitBy(w, WOLF)
    await tick()
    assert.deepEqual(u.logs, [`[survival] ${x(w)} hit by WolfRace ff00c001: wolf 10% x (1 - disease resist 0%) = 10%, roll 0.000, helljoint refused: already sick with 1 (survivalMaxDiseases 1)`])
  })

  await test('diseases: a zone skeever (an NPC_ base with no appearance) infects with its Unarmed bite; a leveled draugr takes its race from the template chain; a mod race matches by fragment; race resistance cuts the roll', async () => {
    const [UNARMED, ENC_SKEEVER, LVL_DRAUGR, DRAUGR_LIST, ENC_DRAUGR, MOD_SKELETON] = [0x1f4, 0x23ab7, 0xabaa1, 0xabaa0, 0x1ff22, 0x5e000d62]
    const [FOX_RACE, DRAUGR_RACE, MOD_RACE, ARGONIAN_RACE, ARGONIAN_BLOOD] = [0x109c7c, 0xd53, 0x5e000d61, 0x13740, 0x41331]
    const acbs = (templateFlags) => { const b = new Uint8Array(24); new DataView(b.buffer).setUint16(18, templateFlags, true); return b }
    const npc = (editorId, raceId, templateFlags = 0, template = 0) => record('NPC_', editorId, [field('ACBS', acbs(templateFlags)), field('RNAM', u32(raceId)), ...(template ? [field('TPLT', u32(template))] : [])])
    const records = [
      [UNARMED, record('WEAP', 'Unarmed')],
      [ENC_SKEEVER, npc('EncSkeever', SKEEVER_RACE)],
      // Use Traits with a leveled list as template: the record's own race is the CK placeholder
      [LVL_DRAUGR, npc('dunFolgunthurThralls_LvlDraugrAmbushMissile', FOX_RACE, 0x1, DRAUGR_LIST)],
      [DRAUGR_LIST, record('LVLN', 'LCharDraugrAmbushMissile')],
      [ENC_DRAUGR, npc('EncDraugr02Missile', DRAUGR_RACE)],
      [MOD_SKELETON, npc('RiftenExtSkeletonGuard', MOD_RACE)],
      [FOX_RACE, record('RACE', 'FoxRace')],
      [DRAUGR_RACE, record('RACE', 'DraugrRace')],
      [MOD_RACE, record('RACE', 'RiftenExtSkeletonArmorRace')],
      [ARGONIAN_RACE, record('RACE', 'ArgonianRace', [field('SPLO', u32(ARGONIAN_BLOOD))])],
      [ARGONIAN_BLOOD, spell('AldRacial_Argonian', 4, [[RESIST_EFFECT, 75]])],
    ]
    for (const [id, rec] of records) RECORDS.set(id, rec)
    try {
      const t = setup()
      // As the native bindings answer for an NPC: appearance null, profile -1, the evaluated template chain
      const spawn = (id, base, chain = [base]) => { for (const [k, v] of [['baseDesc', desc(base)], ['appearance', null], ['profileId', -1], ['templateChain', chain]]) t.mp.set(id, k, v) }
      const [k, a] = [actor(), actor()]
      const [skeever, draugr, skeleton] = [0xff000041, 0xff000042, 0xff000043]
      t.join(k, KHAJIIT_RACE)
      t.join(a, ARGONIAN_RACE)
      spawn(skeever, ENC_SKEEVER)
      spawn(draugr, LVL_DRAUGR, [LVL_DRAUGR, ENC_DRAUGR])
      spawn(skeleton, MOD_SKELETON)
      later()
      await t.update()
      t.logs.length = 0
      t.mp.calls.length = 0
      Math.random = () => 0.5
      t.hitBy(k, skeever, UNARMED)
      await tick()
      assert.deepEqual(t.logs, [`[survival] ${x(k)} hit by SkeeverRace ff000041: skeever 10% x (1 - disease resist 0%) = 10%, roll 0.500, spared`])
      assert.deepEqual([t.mp.calls, t.rec(k).diseases], [[], []], 'nine bites in ten give nothing but the spared line')
      t.logs.length = 0
      Math.random = () => 0.05
      t.hitBy(k, skeever, UNARMED, true)
      await tick()
      assert.deepEqual([t.logs, t.rec(k).diseases], [[], []], 'a blocked bite rolls nothing')
      t.hitBy(k, skeever, UNARMED)
      await tick()
      const a1 = sick('AldDisease_Ataxia1')
      assert.deepEqual(t.logs, [`[survival] ${x(k)} hit by SkeeverRace ff000041: skeever 10% x (1 - disease resist 0%) = 10%, roll 0.050, caught ataxia (AldDisease_Ataxia1), stage 2 at ${mmdd(clock.now + 84 * HOUR)}`])
      assert.deepEqual(t.mp.calls, [`${x(k)} +${x(a1)}`])
      assert.deepEqual(t.rec(k).diseases.map((d) => [d.id, d.stage, d.from]), [['ataxia', 1, 'skeever SkeeverRace']])
      assert.equal(t.notices(k).pop(), 'You have caught Ataxia: picking locks and pockets is harder. It worsens over the coming days. A Cure Disease potion or a healing potion cures it.')
      assert.deepEqual(t.states(k).pop().diseases, [{ name: 'Ataxia', stage: 1 }])
      t.logs.length = 0
      t.hitBy(a, skeever, UNARMED)
      await tick()
      assert.deepEqual(t.logs, [`[survival] ${x(a)} hit by SkeeverRace ff000041: skeever 10% x (1 - disease resist 75%) = 2.5%, roll 0.050, spared`], 'AldRacial_Argonian on the race record')
      t.logs.length = 0
      Math.random = () => 0.01
      t.hitBy(k, draugr, IRON_SWORD)
      await tick()
      assert.deepEqual(t.logs.map((l) => l.split(', roll')[0]), [`[survival] ${x(k)} hit by DraugrRace ff000042: draugr 3% x (1 - disease resist 0%) = 3%`], 'not the placeholder FoxRace of the Use Traits record')
      assert.deepEqual(t.rec(k).diseases.map((d) => d.id), ['ataxia', 'brownRot'])
      t.logs.length = 0
      t.hitBy(k, skeleton, IRON_SWORD)
      await tick()
      assert.deepEqual(t.logs.map((l) => l.split(', roll')[0]), [`[survival] ${x(k)} hit by RiftenExtSkeletonArmorRace ff000043: skeleton 5% x (1 - disease resist 0%) = 5%`])
      assert.deepEqual(t.rec(k).diseases.map((d) => d.id), ['ataxia', 'brownRot', 'blackHeartBlight'])
    } finally {
      for (const [id] of records) RECORDS.delete(id)
    }
  })

  await test('diseases: stages worsen by wall clock at the minute tick and for the time offline; stage 3 stays until cured', async () => {
    const t = setup()
    const [a, b] = [actor(), actor()]
    const [r1, r2, r3] = [1, 2, 3].map((s) => sick(`AldDisease_Rockjoint${s}`))
    const start = clock.now
    t.join(a, NORD_RACE, coldRecord(55, { diseases: [held('rockjoint', 1, start + HOUR)] }))
    t.join(b, NORD_RACE, coldRecord(55, { diseases: [held('rockjoint', 1, start - 200 * HOUR)] }))
    t.mp.learned(a).add(r1)
    t.mp.learned(b).add(r1)
    later()
    await t.update()
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${x(a)} body:`) && l.includes(`no food poisoning, rockjoint 1 (stage 2 at ${mmdd(start + HOUR)}); cold 55`)), t.logs.join('\n'))
    assert.ok(t.logs.includes(`[survival] ${x(b)} rockjoint worsened 1 -> 3 (AldDisease_Rockjoint3, due ${mmdd(start - 200 * HOUR)}), stays until cured`), t.logs.join('\n'))
    assert.ok(t.logs.some((l) => l.startsWith(`[survival] ${x(b)} body:`) && l.includes('rockjoint 3 (until cured)')), t.logs.join('\n'))
    assert.deepEqual(t.mp.calls.filter((c) => c === `${x(b)} -${x(r1)}` || c === `${x(b)} +${x(r3)}`), [`${x(b)} -${x(r1)}`, `${x(b)} +${x(r3)}`])
    assert.equal(t.rec(b).diseases[0].nextAt, 0)
    t.logs.length = 0
    t.mp.calls.length = 0
    later(HOUR)
    await t.update()
    assert.deepEqual(t.mp.calls.filter((c) => c.startsWith(x(a))), [`${x(a)} -${x(r1)}`, `${x(a)} +${x(r2)}`])
    assert.ok(t.logs.includes(`[survival] ${x(a)} rockjoint worsened 1 -> 2 (AldDisease_Rockjoint2, due ${mmdd(start + HOUR)}), stage 3 at ${mmdd(start + 85 * HOUR)}`), t.logs.join('\n'))
    assert.equal(t.notices(a).pop(), 'Your Rockjoint has worsened to its advanced stage. A Cure Disease potion or a healing potion cures it.')
    assert.deepEqual(t.states(a).pop().diseases, [{ name: 'Rockjoint', stage: 2 }])
    t.mp.calls.length = 0
    later(1000 * HOUR)
    await t.update()
    assert.deepEqual(t.mp.calls.filter((c) => c.startsWith(x(b))), [], 'stage 3 stays')
    assert.equal(t.rec(a).diseases[0].stage, 3)
  })

  await test('diseases: a Cure Disease or healing potion, the admin reset, survival off and diseases off take them', async () => {
    const t = setup()
    const [a, b, c] = [actor(), actor(), actor()]
    const r2 = sick('AldDisease_Rockjoint2')
    for (const id of [a, b, c]) {
      t.join(id, NORD_RACE, coldRecord(55, { diseases: [held('rockjoint', 2, clock.now + HOUR)] }))
      t.mp.learned(id).add(r2)
    }
    later()
    await t.update()
    t.logs.length = 0
    t.mp.calls.length = 0
    t.mp.onEatItem(a, CURE)
    t.mp.onEatItem(b, HEAL50)
    await tick()
    assert.deepEqual(t.logs, [
      `[survival] ${x(a)} cured by CureDisease (Cure Disease): AldDisease_Rockjoint2, the native cure took every Disease spell`,
      `[survival] ${x(b)} cured by RestoreHealth02 (restores 50 health): AldDisease_Rockjoint2`,
    ])
    assert.deepEqual(t.mp.calls, [`${x(a)} -${x(r2)}`, `${x(b)} -${x(r2)}`])
    assert.deepEqual([t.rec(a).diseases, t.rec(b).diseases, t.states(a).pop().diseases], [[], [], []])
    t.logs.length = 0
    assert.equal(t.sys.resetBy(t.ctx, c, 'Admin'), true)
    assert.deepEqual([t.logs, t.rec(c).diseases], [[`[survival] ${x(c)} reset by Admin, removed AldDisease_Rockjoint2`], []])
    const off = setup({})
    const d = actor()
    off.join(d, NORD_RACE, coldRecord(55, { diseases: [held('rockjoint', 2, clock.now + HOUR)] }))
    off.mp.learned(d).add(r2)
    later()
    await off.update()
    assert.deepEqual(off.logs, [`[survival] ${x(d)} body rules off: respawn 100% (already), abilities removed: AldDisease_Rockjoint2`])
    assert.deepEqual(off.rec(d).diseases, [])
    const u = setup({ survivalEnabled: true, survivalDiseasesEnabled: false })
    const e = actor()
    u.join(e, NORD_RACE, coldRecord(55, { diseases: [held('rockjoint', 2, clock.now + HOUR)] }))
    u.creature(SKEEVER, SKEEVER_RACE)
    later()
    await u.update()
    assert.ok(u.logs[0].includes('removed AldDisease_Rockjoint2, no food poisoning; cold 55'), u.logs[0])
    Math.random = () => 0
    u.hitBy(e, SKEEVER)
    await tick()
    assert.deepEqual(u.rec(e).diseases, [], 'no disease is caught while diseases are off')
  })

  await test('diseases: Collywobbles, Gutworm and Brown Rot scale the needs and Chills the cold gain; a record not followed yet counts at its stored stages', async () => {
    const t = setup({ survivalEnabled: true, survivalNightHours: [0, 24] }, true)
    const a = actor()
    const list = [held('collywobbles', 2, clock.now + HOUR), held('gutworm', 3, 0), held('brownRot', 1, clock.now + HOUR), held('chills', 2, clock.now + HOUR)]
    t.join(a, REDGUARD_RACE, coldRecord(55, { diseases: list }))
    t.put(a, TAMRIEL)
    assert.deepEqual([t.sys.hungerDrainMult(a), t.sys.foodHungerMult(a), t.sys.fatigueRegenMult(a)], [1.5, 0.25, 0.75])
    const b = actor()
    t.mp.set(b, 'private.survival', coldRecord(55, { diseases: [list[0]] }))
    assert.equal(t.sys.hungerDrainMult(b), 1.5, 'read from the record before survival follows the character')
    later()
    await t.update()
    later(10 * 60000)
    await t.update()
    const bare = C.coldRatePerSec(16, 0, 1, t.sys.cold) * 600
    assert.ok(Math.abs(t.rec(a).cold - (55 + bare * 1.5)) < 1e-6, String(t.rec(a).cold))
    assert.match(t.sys.describe(), /^diseases Brown Rot fatigue refill x0\.75\/0\.5\/0\.25, Gutworm food x0\.75\/0\.5\/0\.25, Chills cold gain x1\.25\/1\.5\/1\.75, Collywobbles hunger drain x1\.25\/1\.5\/1\.75 by stage/)
    assert.equal(setup({}).sys.hungerDrainMult(a), 1, 'nothing while survival is off')
  })

  await test('contagion: ff_contagious lists the contagious diseases a player carries, written at login only when the stored value differs, at a catch and at a cure; null with none and with contagion off; an unregistered property is logged once', async () => {
    const t = setup()
    const writes = []
    const set = t.mp.set
    t.mp.set = (id, key, v) => { if (key === 'ff_contagious') writes.push([id, v]); set(id, key, v) }
    const [a, b, c] = [actor(), actor(), actor()]
    t.join(a, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR), held('witbane', 1, clock.now + HOUR)] }))
    t.join(b, NORD_RACE)
    t.join(c, NORD_RACE, coldRecord(55, { diseases: [held('rockjoint', 2, clock.now + HOUR)] }))
    set(c, 'ff_contagious', ['rockjoint'])
    t.mp.learned(c).add(sick('AldDisease_Rockjoint2'))
    later()
    await t.update()
    assert.deepEqual(writes, [[a, ['collywobbles']]], 'witbane is not contagious, b carries nothing and c had its list stored')
    t.sys.goOffline(t.ctx, a)
    t.sys.onActorAssigned(t.ctx, t.mp.users.get(a), a)
    later()
    await t.update()
    assert.equal(writes.length, 1, 'a relog writes nothing new')
    assert.equal(t.sys.adminRequest(t.ctx, b, 'profile 9', { op: 'giveDisease', disease: 'chills' }).ok, true)
    assert.equal(t.sys.adminRequest(t.ctx, b, 'profile 9', { op: 'giveDisease', disease: 'witbane' }).ok, true)
    assert.equal(t.sys.adminRequest(t.ctx, b, 'profile 9', { op: 'giveDisease', disease: 'chills', stage: 2 }).ok, true)
    t.mp.onEatItem(c, CURE)
    await tick()
    assert.equal(t.sys.adminRequest(t.ctx, b, 'profile 9', { op: 'cure', disease: 'chills' }).ok, true)
    assert.deepEqual(writes.slice(1), [[b, ['chills']], [c, null], [b, null]], 'a catch and a cure write it, a stage or a non-contagious disease does not')
    assert.deepEqual(t.states(b).pop().contagion, { seconds: 60, range: 150 })
    const off = setup({ survivalEnabled: true, survivalContagionChance: 0, chatRanges: { whisper: 200 } })
    const d = actor()
    const userD = off.join(d, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    off.mp.set(d, 'ff_contagious', ['collywobbles'])
    later()
    await off.update()
    off.sys.customPacket(userD, 'survivalRequest', {}, off.ctx)
    assert.deepEqual([off.mp.get(d, 'ff_contagious'), off.states(d).pop().contagion], [null, null], 'contagion off clears the list and tells the client so')
    const near = setup({ survivalEnabled: true, chatRanges: { whisper: 200 } })
    const n = actor()
    const userN = near.join(n, NORD_RACE)
    later()
    await near.update()
    near.sys.customPacket(userN, 'survivalRequest', {}, near.ctx)
    assert.deepEqual(near.states(n).pop().contagion, { seconds: 60, range: 200 }, 'the range follows chatRanges.whisper')
    const u = setup()
    const failing = (fn) => (id, key, v) => { if (key === 'ff_contagious') throw new Error("Property 'ff_contagious' doesn't exist"); return fn(id, key, v) }
    u.mp.get = failing(u.mp.get)
    u.mp.set = failing(u.mp.set)
    const [e, f] = [actor(), actor()]
    for (const id of [e, f]) u.join(id, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    later()
    await u.update()
    assert.deepEqual(u.logs.filter((l) => l.includes('ff_contagious')), [`[survival] ff_contagious could not be written, so no client sees who is contagious (makeProperty in gamemode.js?): Error: Property 'ff_contagious' doesn't exist`])
  })

  await test('contagion: a survivalExposure report rolls once per disease the named source carries and the reporter lacks, named after its source, with no distance check; one report per 55 s; each disease and pair rolls once per 30 min; a spared roll logs nothing', async () => {
    const t = setup({ survivalEnabled: true, survivalContagionChance: 1 })
    const [a, a2, a3, b] = [actor(), actor(), actor(), actor()]
    t.join(a, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR), held('witbane', 1, clock.now + HOUR)] }))
    t.join(a2, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR), held('chills', 3, 0)] }))
    t.join(a3, NORD_RACE, coldRecord(55, { diseases: [held('ataxia', 1, clock.now + HOUR)] }))
    const userB = t.join(b, NORD_RACE)
    t.mp.set(a, 'appearance', { raceId: NORD_RACE, name: 'Aela' })
    t.mp.set(a2, 'appearance', { raceId: NORD_RACE, name: 'Brand' })
    t.mp.set(a3, 'appearance', { raceId: NORD_RACE, name: 'Cosnach' })
    t.put(a, INN, [0, 0, 0])
    t.put(b, CAVE, [90000, 0, 0])
    later()
    await t.update()
    t.logs.length = 0
    Math.random = () => 0.5
    const report = (sources) => t.sys.customPacket(userB, 'survivalExposure', { sources }, t.ctx)
    const caught = (src, name, id) => `[survival] contagion ${x(b)} from ${x(src)} [profile 1] "${name}": ${id} 100% x (1 - disease resist 0%) = 100%, roll 0.500, caught ${id} (AldDisease_${id[0].toUpperCase()}${id.slice(1)}1), stage 2 at ${mmdd(clock.now + 84 * HOUR)}`
    const first = clock.now
    report([{ actorId: a, diseases: ['collywobbles', 'witbane'] }, { actorId: a2, diseases: ['collywobbles', 'chills'] }])
    assert.deepEqual(t.logs, [caught(a, 'Aela', 'collywobbles'), caught(a2, 'Brand', 'chills')])
    assert.deepEqual(t.rec(b).diseases.map((d) => [d.id, d.stage, d.from]), [['collywobbles', 1, `contagion ${x(a)}`], ['chills', 1, `contagion ${x(a2)}`]])
    assert.equal(t.notices(b)[0], 'You have caught Collywobbles from someone near you: you hunger faster and your stamina recovers more slowly. It worsens over the coming days. A Cure Disease potion or a healing potion cures it.')
    assert.deepEqual(t.mp.get(b, 'ff_contagious'), ['collywobbles', 'chills'])
    clock.now = first + 54999
    report([{ actorId: a3, diseases: ['ataxia'] }])
    assert.deepEqual(t.rec(b).diseases.length, 2, 'a second report inside 55 s is dropped')
    clock.now = first + 55000
    report([{ actorId: a3, diseases: ['ataxia'] }])
    assert.deepEqual(t.rec(b).diseases.map((d) => d.id), ['collywobbles', 'chills', 'ataxia'])
    assert.equal(t.logs.length, 3)
    const s = setup({ survivalEnabled: true })
    const [p, p2, q] = [actor(), actor(), actor()]
    s.join(p, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    s.join(p2, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    const userQ = s.join(q, NORD_RACE)
    s.mp.set(p, 'appearance', { raceId: NORD_RACE, name: 'Aela' })
    later()
    await s.update()
    s.logs.length = 0
    let rolls = 0
    Math.random = () => { rolls++; return 0.5 }
    const reportQ = (sources) => s.sys.customPacket(userQ, 'survivalExposure', { sources }, s.ctx)
    const met = clock.now
    reportQ([{ actorId: p, diseases: ['collywobbles'] }])
    assert.deepEqual([rolls, s.logs, s.rec(q).diseases], [1, [], []], 'one 5% roll, spared and not logged')
    clock.now = met + 55000
    reportQ([{ actorId: p, diseases: ['collywobbles', 'witbane'] }])
    assert.deepEqual([rolls, s.logs], [1, []], 'the pair rolled collywobbles in the last 30 min, so nothing rolls and a cooling report is no refuted one')
    clock.now = met + 110000
    reportQ([{ actorId: p, diseases: ['collywobbles'] }, { actorId: p2, diseases: ['collywobbles'] }])
    assert.equal(rolls, 2, 'another carrier is another pair and rolls')
    clock.now = met + 30 * 60000 - 1
    reportQ([{ actorId: p, diseases: ['collywobbles'] }, { actorId: p2, diseases: ['collywobbles'] }])
    assert.equal(rolls, 2, 'both pairs still inside 30 min')
    clock.now = met + 30 * 60000 + 60000
    Math.random = () => { rolls++; return 0.01 }
    reportQ([{ actorId: p2, diseases: ['collywobbles'] }, { actorId: p, diseases: ['collywobbles'] }])
    assert.deepEqual([rolls, s.rec(q).diseases.map((d) => d.from)], [4, [`contagion ${x(p)}`]], 'the first pair rolls again after 30 min, the second still waits')
    assert.ok(s.logs[0].startsWith(`[survival] contagion ${x(q)} from ${x(p)} [profile 1] "Aela": collywobbles 5% x (1 - disease resist 0%) = 5%, roll 0.010, caught collywobbles`), s.logs[0])
    const every = setup({ survivalEnabled: true, survivalContagionCooldownMinutes: 0 })
    const [e1, e2] = [actor(), actor()]
    every.join(e1, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    const userE = every.join(e2, NORD_RACE)
    later()
    await every.update()
    rolls = 0
    Math.random = () => { rolls++; return 0.5 }
    const back = clock.now
    every.sys.customPacket(userE, 'survivalExposure', { sources: [{ actorId: e1, diseases: ['collywobbles'] }] }, every.ctx)
    clock.now = back + 55000
    every.sys.customPacket(userE, 'survivalExposure', { sources: [{ actorId: e1, diseases: ['collywobbles'] }] }, every.ctx)
    assert.equal(rolls, 2, 'cooldown 0 rolls at every report')
    const off = setup({ survivalEnabled: true, survivalContagionChance: 0 })
    const [g, h] = [actor(), actor()]
    off.join(g, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    const userH = off.join(h, NORD_RACE)
    later()
    await off.update()
    rolls = 0
    off.sys.customPacket(userH, 'survivalExposure', { sources: [{ actorId: g, diseases: ['collywobbles'] }] }, off.ctx)
    assert.equal(rolls, 0, 'contagion off rolls nothing')
  })

  await test('contagion: a report names only what the records confirm; hidden, dead, fallen or unsettled players neither catch nor spread; a player at survivalMaxDiseases rolls nothing; an unusable report is logged once per 10 min', async () => {
    const t = setup({ survivalEnabled: true, survivalContagionChance: 1, survivalMaxDiseases: 2 })
    const ids = Array.from({ length: 9 }, () => actor())
    const [s, sGod, sDead, sFallen, r, rGod, rDead, rFallen, rFull] = ids
    for (const id of [s, sGod, sDead, sFallen]) t.join(id, NORD_RACE, coldRecord(55, { diseases: [held('collywobbles', 1, clock.now + HOUR)] }))
    const users = new Map([r, rGod, rDead, rFallen].map((id) => [id, t.join(id, NORD_RACE)]))
    users.set(rFull, t.join(rFull, NORD_RACE, coldRecord(55, { diseases: [held('witbane', 1, clock.now + HOUR), held('droops', 1, clock.now + HOUR)] })))
    later()
    await t.update()
    t.logs.length = 0
    for (const id of [sGod, rGod]) t.mp.set(id, 'ff_adminModes', { god: true })
    for (const id of [sDead, rDead]) t.mp.set(id, 'isDead', true)
    for (const id of [sFallen, rFallen]) t.mp.set(id, 'private.afterlife', { realm: 'sovngarde', reason: 'test', at: T0 })
    Math.random = () => 0.5
    const report = (who, sources) => t.sys.customPacket(users.get(who), 'survivalExposure', { sources }, t.ctx)
    for (const who of [rGod, rDead, rFallen, rFull]) report(who, [{ actorId: s, diseases: ['collywobbles'] }])
    assert.deepEqual([t.logs, ...[rGod, rDead, rFallen].map((id) => t.rec(id).diseases), t.rec(rFull).diseases.length], [[], [], [], [], 2], 'a hidden, dead, fallen or full reporter rolls nothing, silently')
    const start = clock.now
    report(r, [
      { actorId: 0xff00dead, diseases: ['collywobbles'] }, { actorId: r, diseases: ['collywobbles'] }, { actorId: sGod, diseases: ['collywobbles'] },
      { actorId: sDead, diseases: ['collywobbles'] }, { actorId: sFallen, diseases: ['collywobbles'] }, { actorId: s, diseases: ['plague<br>', 'witbane', 'ataxia'] },
    ])
    assert.deepEqual(t.logs, [`[survival] contagion report from ${x(r)} named nothing catchable: ff00dead collywobbles from no other online player, ${x(r)} collywobbles from no other online player, ${x(sGod)} collywobbles from a hidden, dead, fallen or unsettled player, ${x(sDead)} collywobbles from a hidden, dead, fallen or unsettled player, ...`])
    assert.deepEqual(t.rec(r).diseases, [])
    clock.now = start + 60000
    report(r, [{ actorId: s, diseases: ['ataxia'] }])
    assert.equal(t.logs.length, 1, 'the next unusable report inside 10 min is not logged')
    clock.now = start + 10 * 60000
    report(r, [{ actorId: s, diseases: ['witbane', 'plague'] }])
    assert.deepEqual(t.logs.slice(1), [`[survival] contagion report from ${x(r)} named nothing catchable: ${x(s)} witbane not contagious, ${x(s)} ? unknown`])
    clock.now += 60000
    report(r, [{ actorId: s, diseases: ['collywobbles'] }, { actorId: sGod, diseases: ['collywobbles'] }])
    assert.deepEqual(t.rec(r).diseases.map((d) => d.from), [`contagion ${x(s)}`], 'a usable source counts beside an unusable one')
  })

  await test('admin: the survival event gives, stages and cures diseases, sets cold, reads the state and lists the catalog', async () => {
    const t = setup()
    const a = actor()
    assert.deepEqual(t.sys.adminRequest(t.ctx, a, 'profile 1', { op: 'summary' }), { ok: false, text: 'survival has not settled on this character yet (just logged in or still in creation)' })
    t.join(a, NORD_RACE)
    later()
    await t.update()
    const h = x(a)
    const cat = t.sys.adminRequest(t.ctx, 0, 'profile 1', { op: 'catalog' }).catalog
    assert.deepEqual([cat.diseases.length, cat.diseases[0], cat.coldMax, cat.coldStages], [27, { id: 'ataxia', name: 'Ataxia', contagious: true }, 1000, [50, 120, 300, 500, 800]])
    t.logs.length = 0
    t.mp.calls.length = 0
    const [r2, r3] = [2, 3].map((s) => x(sick(`AldDisease_Rockjoint${s}`)))
    const give = t.sys.adminRequest(t.ctx, a, 'profile 1', { op: 'giveDisease', disease: 'rockjoint', stage: 2 })
    assert.deepEqual([give.ok, give.text, give.summary.diseases], [true, 'now has Rockjoint (advanced)', [{ id: 'rockjoint', name: 'Rockjoint', stage: 2, nextAt: clock.now + 84 * HOUR }]])
    assert.deepEqual(t.logs, [`[survival] ${h} given rockjoint stage 2 by profile 1, stage 3 at ${mmdd(clock.now + 84 * HOUR)}`])
    assert.deepEqual(t.mp.calls, [`${h} +${r2}`])
    assert.equal(t.notices(a).pop(), 'You have caught Rockjoint (advanced): your melee attacks are weaker. A Cure Disease potion or a healing potion cures it.')
    assert.equal(t.sys.adminRequest(t.ctx, a, 'profile 1', { op: 'giveDisease', disease: 'Rockjoint', stage: '3' }).text, 'now has Rockjoint (severe)')
    assert.deepEqual(t.mp.calls.slice(-2), [`${h} -${r2}`, `${h} +${r3}`])
    assert.equal(t.logs.pop(), `[survival] ${h} given rockjoint stage 3 by profile 1 (held, stage set), stays until cured`)
    assert.equal(t.sys.adminRequest(t.ctx, a, 'p', { op: 'giveDisease', disease: 'Bone Break Fever' }).text, 'now has Bone Break Fever')
    assert.deepEqual(t.sys.adminRequest(t.ctx, a, 'p', { op: 'giveDisease', disease: 'plague' }), { ok: false, text: "no disease called 'plague'" })
    assert.equal(t.sys.adminRequest(t.ctx, a, 'p', { op: 'giveDisease', disease: 'ataxia', stage: 4 }).text, 'the stage must be 1 to 3')
    const cold = t.sys.adminRequest(t.ctx, a, 'profile 1', { op: 'setCold', cold: 600 })
    assert.deepEqual([cold.ok, cold.text, cold.summary.cold, cold.summary.stage], [true, 'cold 55 -> 600 (Freezing)', 600, 'Freezing'])
    assert.ok(t.logs.includes(`[survival] ${h} cold set by profile 1: cold 55 -> 600`), t.logs.join('\n'))
    assert.equal(t.sys.adminRequest(t.ctx, a, 'p', { op: 'setCold', cold: 'warm' }).text, 'cold must be a number from 0 to 1000')
    assert.equal(t.sys.adminRequest(t.ctx, a, 'p', { op: 'summary' }).text, `cold 600 (Freezing); area not known yet; Rockjoint (severe), Bone Break Fever (worse at ${mmdd(clock.now + 84 * HOUR)})`)
    assert.deepEqual(t.sys.adminRequest(t.ctx, a, 'p', { op: 'cure', disease: 'witbane' }), { ok: false, text: 'does not have Witbane' })
    assert.equal(t.sys.adminRequest(t.ctx, a, 'profile 1', { op: 'cure', disease: 'rockjoint' }).text, 'cured Rockjoint (severe)')
    const all = t.sys.adminRequest(t.ctx, a, 'profile 1', { op: 'cure' })
    assert.deepEqual([all.text, all.summary.diseases], ['cured Bone Break Fever', []])
    assert.equal(t.logs.pop(), `[survival] ${h} cured by profile 1 (admin): AldDisease_BoneBreakFever1`)
    assert.equal(t.sys.adminRequest(t.ctx, a, 'p', { op: 'cure' }).text, 'had no sickness')
    assert.equal(t.sys.adminRequest(t.ctx, a, 'p', { op: 'dance' }).text, "unknown survival request 'dance'")
    const off = setup({ survivalEnabled: true, survivalDiseasesEnabled: false, survivalColdEnabled: false })
    const b = actor()
    off.join(b, NORD_RACE)
    later()
    await off.update()
    assert.deepEqual(off.sys.adminRequest(off.ctx, b, 'p', { op: 'giveDisease', disease: 'ataxia' }), { ok: false, text: 'diseases are switched off (survivalDiseasesEnabled false)' })
    assert.equal(off.sys.adminRequest(off.ctx, b, 'p', { op: 'setCold', cold: 5 }).text, 'cold is switched off (survivalColdEnabled false)')
    assert.deepEqual(off.sys.adminRequest(off.ctx, 0, 'p', { op: 'catalog' }).catalog.diseases, [])
  })

  await test('diseases: one given inside the login window is replayed with its other stages cleared; without the plugin nothing is given', async () => {
    const t = setup()
    const a = actor()
    const user = t.join(a, NORD_RACE)
    later()
    await t.update()
    t.sys.adminRequest(t.ctx, a, 'p', { op: 'giveDisease', disease: 'ataxia', stage: 2 })
    t.mp.calls.length = 0
    t.sys.customPacket(user, 'weatherRequest', {}, t.ctx)
    later(RESYNC_DELAY_MS)
    await t.update()
    const [s1, s2, s3] = [1, 2, 3].map((s) => x(sick(`AldDisease_Ataxia${s}`)))
    const h = x(a)
    assert.deepEqual(t.mp.calls.slice(-6), [`${h} +${s1}`, `${h} -${s1}`, `${h} +${s3}`, `${h} -${s3}`, `${h} -${s2}`, `${h} +${s2}`])
    const u = setup(undefined, false, false)
    const b = actor()
    u.join(b, NORD_RACE)
    u.creature(SKEEVER, SKEEVER_RACE)
    later()
    await u.update()
    u.logs.length = 0
    Math.random = () => 0
    u.hitBy(b, SKEEVER)
    await tick()
    assert.deepEqual([u.logs, u.rec(b).diseases], [[], []])
    assert.equal(u.sys.diseaseLine(), '[survival] diseases: 0 of 27 in the plugin (the AldDisease_* spells come with plugin r27a), none is given')
    assert.equal(u.sys.adminRequest(u.ctx, b, 'p', { op: 'giveDisease', disease: 'ataxia' }).text, 'Ataxia is not in the plugin yet')
    const full = t.sys.diseaseLine()
    assert.ok(full.startsWith('[survival] diseases: 27 of 27 in the plugin (19 contagious); stage 2 after 84 h and stage 3 after 84 h more, offline included, stage 3 stays until cured; at most 4 at once; carriers by race editor id, longest fragment first, never werewolf/werebear: skeever 10% ataxia/bloodLung/feebleLimb/redRage/shakes/witlessPox, wolf 10% rockjoint/helljoint, '), full)
    assert.ok(full.endsWith('contagion by client report: each client checks the players it has loaded every 60 s (the first at a random second) and reports those within 150 units (the chat whisper range) whose ff_contagious names a disease it lacks; the server takes one report per player per 55 s and rolls 5% x (1 - disease resist) once per disease it confirms (contagious, carried by the source, not by the reporter) and at most once per disease and pair every 30 min, players only, never in creation, dead, in an afterlife realm or with god/ghost/invis, and no roll at 4 diseases; server factors Brown Rot fatigue refill x0.75/0.5/0.25, Gutworm food x0.75/0.5/0.25, Chills cold gain x1.25/1.5/1.75, Collywobbles hunger drain x1.25/1.5/1.75'), full)
  })

  Date.now = realNow
  global.setTimeout = realTimeout
  let failed = 0
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) {
      failed++
      console.log(`     ${err && err.message}`)
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main()
