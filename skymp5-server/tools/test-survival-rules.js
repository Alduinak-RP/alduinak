'use strict'

// SurvivalSystem rules against a mock server: settings, body rules on and off, raw meat food poisoning, expiry, cure and shrines: node tools/test-survival-rules.js

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

const HOUR = 3600000
const T0 = 2e12

const CARRY = 0x887
const REGEN = 0x41340
const WATER = 0x41393
const FOOD_POISON = 0x918
const WEAKENED = 0x910
const ROCKJOINT = 0xb8782
const RESIST_DISEASE_50 = 0x9001
const RESIST_EFFECT = 0x9002
const NORD_RACE = 0x13746
const REDGUARD_RACE = 0x13748
const KHAJIIT_RACE = 0x13745
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
  [ROCKJOINT, spell('DiseaseRockjoint', 1)],
  [RESIST_DISEASE_50, spell('TestResistDisease50', 4, [[RESIST_EFFECT, 50]])],
  [RESIST_EFFECT, record('MGEF', 'AbResistDisease', [field('DATA', mgefData(0, 0, 45))])],
  [NORD_RACE, record('RACE', 'NordRace')],
  [REDGUARD_RACE, record('RACE', 'RedguardRace', [field('SPLO', u32(RESIST_DISEASE_50))])],
  [KHAJIIT_RACE, record('RACE', 'KhajiitRace')],
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

const desc = (id) => `${(id >>> 0).toString(16)}:Test.esp`

// Each actor: user, race, learned spells; every Papyrus spell call and packet recorded
const makeMp = () => {
  const props = new Map()
  const learned = new Map()
  const users = new Map()
  const calls = []
  const packets = []
  const known = (id) => { if (!learned.has(id)) learned.set(id, new Set()); return learned.get(id) }
  return {
    props, learned: known, users, calls, packets,
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    lookupEspmRecordById: (id) => RECORDS.get(id >>> 0) || null,
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => desc(id),
    getUserByActor: (id) => users.get(id >>> 0) ?? 65535,
    getActorCellOrWorld: (id) => { const p = props.get(`${id >>> 0}:place`); if (p === undefined) throw new Error('not in the world'); return p },
    getActorPos: (id) => props.get(`${id >>> 0}:pos`) || [0, 0, 0],
    getUserActor: (userId) => { for (const [a, u] of users) if (u === userId) return a; return 0 },
    isConnected: () => true,
    sendCustomPacket: (userId, text) => { packets.push([userId, JSON.parse(text)]) },
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

// A configured system with every record resolved, its hooks on a mock server; actors are added with join
const setup = (settings = { survivalEnabled: true }, cold = false) => {
  const logs = []
  const mp = makeMp()
  const racial = {
    traits: (id) => {
      const raceEdid = RECORDS.get(mp.get(id, 'appearance')?.raceId)?.record.editorId || ''
      return { raceEdid, rawMeatSafe: !!RACES[raceEdid], coldRateMult: COLD_MULT[raceEdid] ?? 1, warmth: 0 }
    },
  }
  const weather = { region: 'coast', weatherId: SNOW, kind: 'snow', regionOf: () => weather.region, currentWeatherOf: () => ({ id: weather.weatherId, edid: 'Weather', kind: weather.kind }) }
  const hunting = { rawMeatIds: () => [VENISON] }
  const sys = new SurvivalSystem((l) => logs.push(String(l)), racial, hunting, weather)
  const { problems } = sys.configure(settings)
  const ids = { Survival_abLowerCarryWeightSpell: CARRY, AldSurvival_AbNoHealthRegen: REGEN, AldSurvival_FreezingWaterDamage: WATER }
  for (const b of sys.body) b.id = b.name ? ids[b.name] || 0 : 0
  sys.foodPoison = FOOD_POISON
  sys.afflictions = [WEAKENED]
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
  return { sys, mp, ctx, logs, problems, join, update, notices, rec, states, put, wear, weather }
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
    assert.equal(off.sys.cureMode, 'cureDiseaseOrHealth')
    assert.equal(off.sys.cureMinHealth, 25)
    assert.equal(off.sys.poisonChance, 0.5)
    assert.equal(off.sys.poisonMs, 24 * HOUR)
    assert.deepEqual(off.sys.body.map((b) => b.name), ['Survival_abLowerCarryWeightSpell', 'AldSurvival_AbNoHealthRegen', 'AldSurvival_FreezingWaterDamage'])
    const bad = setup({ survivalEnabled: 'yes', survivalRespawnHealth: 0, survivalCure: 'prayer', survivalFoodPoisoningChance: 2, survivalCarryWeightSpell: '', survivalNoHealthRegen: false, survivalRawMeatExtra: 'FoodBeef' })
    assert.equal(bad.sys.enabled, false, 'only true switches it on')
    assert.equal(bad.sys.respawnHealth, 0.01)
    assert.equal(bad.sys.cureMode, 'cureDiseaseOrHealth')
    assert.deepEqual(bad.sys.body.map((b) => b.name), ['', '', 'AldSurvival_FreezingWaterDamage'])
    assert.deepEqual(bad.problems, [
      'survivalRespawnHealth 0 is out of range, 0.01 is used',
      'survivalFoodPoisoningChance 2 is out of range, 0.5 is used',
      'survivalCure "prayer" is not cureDisease or cureDiseaseOrHealth, cureDiseaseOrHealth is used',
      'survivalRawMeatExtra is not a list of strings, none are added',
    ])
  })

  await test('body rules wait out the login delay, grant the three abilities, set 1% respawn once and log one line', async () => {
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
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell granted, no regen AldSurvival_AbNoHealthRegen granted, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1% (set), no food poisoning; cold 55 (Comfortable), place not known yet, cold ability none`])
    t.sys.goOffline(t.ctx, a)
    t.logs.length = 0
    t.mp.calls.length = 0
    t.sys.onActorAssigned(t.ctx, t.mp.users.get(a), a)
    later()
    await t.update()
    assert.deepEqual(t.mp.calls, [`${h} +887`, `${h} +41340`, `${h} +41393`], 'AddSpell of a known spell changes nothing')
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell held, no regen AldSurvival_AbNoHealthRegen held, freezing water AldSurvival_FreezingWaterDamage held, respawn health 1%, no food poisoning; cold 55 (Comfortable), place not known yet, cold ability none`])
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
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight off, no regen AldSurvival_AbNoHealthRegen not in the plugin yet, skipped, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1% (set), removed Survival_abLowerCarryWeightSpell, no food poisoning; cold 55 (Comfortable), place not known yet, cold ability none`])
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
    const a = actor()
    t.join(a, REDGUARD_RACE)
    t.put(a, TAMRIEL, [1000, 1000, 0])
    later()
    await t.update()
    const h = a.toString(16)
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell granted, no regen AldSurvival_AbNoHealthRegen granted, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1% (set), no food poisoning; cold 55 (Comfortable), level 16 (freezing, night, snow; region coast), warmth 0 (0% less cold), freezing water area yes, cold ability Survival_ColdStage1`])
    assert.deepEqual(t.mp.calls, [`${h} +887`, `${h} +41340`, `${h} +41393`, `${h} +86e`])
    assert.deepEqual(t.states(a), [{ customPacketType: 'survivalState', cold: 55, coldStage: 1, coldStageName: 'Comfortable', coldPenalty: 0, temperatureLevel: 0, warmth: 0, freezingArea: true, afflictions: [], diseases: [] }])
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
    t.mp.onRespawn(a)
    await tick()
    assert.equal(t.rec(a).cold, 55)
    assert.ok(t.logs.includes(`[survival] ${h} respawned: cold 400 -> 55`))
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
    assert.deepEqual(u.states(b).pop(), { customPacketType: 'survivalState', cold: -1, coldStage: -1, coldStageName: '', coldPenalty: 0, temperatureLevel: 0, warmth: 0, freezingArea: true, afflictions: [], diseases: [] })
    const v = setup({ survivalEnabled: true, survivalColdKills: true, survivalNightHours: [0, 24] }, true)
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
