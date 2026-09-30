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

// A configured system with every record resolved, its hooks on a mock server; actors are added with join
const setup = (settings = { survivalEnabled: true }) => {
  const logs = []
  const mp = makeMp()
  const racial = {
    traits: (id) => {
      const raceEdid = RECORDS.get(mp.get(id, 'appearance')?.raceId)?.record.editorId || ''
      return { raceEdid, rawMeatSafe: !!RACES[raceEdid] }
    },
  }
  const hunting = { rawMeatIds: () => [VENISON] }
  const sys = new SurvivalSystem((l) => logs.push(String(l)), racial, hunting, {})
  const { problems } = sys.configure(settings)
  const ids = { Survival_abLowerCarryWeightSpell: CARRY, AldSurvival_AbNoHealthRegen: REGEN, AldSurvival_FreezingWaterDamage: WATER }
  for (const b of sys.body) b.id = b.name ? ids[b.name] || 0 : 0
  sys.foodPoison = FOOD_POISON
  sys.afflictions = [WEAKENED]
  sys.rawMeat = new Set([VENISON])
  sys.altars = new Set([ALTAR])
  const ctx = { svr: mp, gm: { on: () => {}, emit: () => {} } }
  if (sys.enabled) sys.installHooks(ctx)
  let nextUser = 1
  const join = (actorId, raceId, stored) => {
    const userId = nextUser++
    mp.users.set(actorId, userId)
    mp.set(actorId, 'profileId', 1)
    mp.set(actorId, 'appearance', { raceId })
    mp.set(actorId, 'respawnPercentages', { health: 1, magicka: 0.5, stamina: 1 })
    if (stored) mp.set(actorId, 'private.survival', stored)
    sys.onActorAssigned(ctx, userId, actorId)
    return userId
  }
  const update = () => sys.updateAsync(ctx)
  const notices = (actorId) => mp.packets.filter(([u, p]) => u === mp.users.get(actorId) && p.customPacketType === 'masteryNotice').map(([, p]) => p.text)
  const rec = (actorId) => mp.get(actorId, 'private.survival')
  return { sys, mp, ctx, logs, problems, join, update, notices, rec }
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
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell granted, no regen AldSurvival_AbNoHealthRegen granted, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1% (set), no food poisoning`])
    t.sys.goOffline(t.ctx, a)
    t.logs.length = 0
    t.mp.calls.length = 0
    t.sys.onActorAssigned(t.ctx, t.mp.users.get(a), a)
    later()
    await t.update()
    assert.deepEqual(t.mp.calls, [`${h} +887`, `${h} +41340`, `${h} +41393`], 'AddSpell of a known spell changes nothing')
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight Survival_abLowerCarryWeightSpell held, no regen AldSurvival_AbNoHealthRegen held, freezing water AldSurvival_FreezingWaterDamage held, respawn health 1%, no food poisoning`])
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
    assert.deepEqual(t.logs, [`[survival] ${h} body: carry weight off, no regen AldSurvival_AbNoHealthRegen not in the plugin yet, skipped, freezing water AldSurvival_FreezingWaterDamage granted, respawn health 1% (set), removed Survival_abLowerCarryWeightSpell, no food poisoning`])
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
