'use strict'

// NeedsSystem modifier sources: every fatigue cost path, the hunger drain, food and the bar's refill take the source factors; the stage
// event and the drink rule: node tools/test-needs-modifiers.js

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

const { NeedsSystem, fatigueCost, NEEDS_STAGE_EVENT } = load('needsSystem.ts')
const { RacialSystem, parseRacialPassives } = load('racialSystem.ts')

const NORD = 0xff000001
const ALTMER = 0xff000002
const ORC = 0xff000003
const WOLF = 0xff000010
const BENCH = 0x88105
const RECIPE = 0x5000
const SPELL = 0x12fcd
const HOUR = 3600000
const FUTURE = Date.now() + 1e12

const RACE_FATIGUE = { [ALTMER]: 0.75, [ORC]: 0.85 }
const RACE_HUNGER = { [ORC]: 0.85 }

// A SPEL record whose SPIT reads type Spell, fire and forget
const spit = new Uint8Array(36)
const SPELL_RECORD = { record: { type: 'SPEL', editorId: 'Flames', fields: [{ type: 'SPIT', data: spit }] }, toGlobalRecordId: (id) => id }

const makeMp = () => {
  const props = new Map()
  const packets = []
  for (const id of [NORD, ALTMER, ORC]) props.set(`${id}:profileId`, 1)
  return {
    props,
    packets,
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    sendCustomPacket: (_userId, text) => { packets.push(JSON.parse(text)) },
    lookupEspmRecordById: (id) => (id === SPELL ? SPELL_RECORD : {}),
    getIdFromDesc: () => 0,
    getDescFromId: (id) => id.toString(16),
    callPapyrusFunction: () => undefined,
    isConnected: () => true,
    getUserActor: () => 0,
  }
}

const mastery = {
  holdsInputs: () => true,
  craftCost: () => ({ rank: 1, half: false }),
  stationKeywords: () => new Set([BENCH]),
  isCraftBench: (k) => k === BENCH,
  craftRank: () => 1,
  craftSlot: () => ({ rank: 1, profession: 'blacksmith' }),
  halfCostBench: () => false,
  rankOf: () => 1,
  rankIn: () => 1,
  actorHasKeyword: () => false,
  professionOf: () => '',
}

const raceSource = {
  label: 'race',
  fatigueCostMult: (id) => RACE_FATIGUE[id] ?? 1,
  hungerDrainMult: (id) => RACE_HUNGER[id] ?? 1,
  describe: () => 'fatigue AltmerTest x0.75',
}

// A system with the three characters online, their clocks frozen, and a spy on costOf and the stage events
const setup = (sources = [raceSource], professions = mastery) => {
  const logs = []
  const sys = new NeedsSystem((line) => logs.push(String(line)), professions)
  for (const src of sources) sys.addModifierSource(src)
  const mp = makeMp()
  const events = []
  const ctx = { svr: mp, gm: { on: () => {}, emit: (name, ...args) => { events.push([name, ...args]) } } }
  const priced = []
  const costOf = sys.costOf.bind(sys)
  sys.costOf = (actorId, effort, ...rest) => { priced.push([actorId, effort]); return costOf(actorId, effort, ...rest) }
  for (const [i, id] of [NORD, ALTMER, ORC].entries()) {
    sys.onActorAssigned(ctx, i + 1, id)
    sys.online.get(id).rec.at = FUTURE
  }
  logs.length = 0
  const fatigue = (id) => sys.online.get(id).rec.fatigue
  const setFatigue = (id, v) => { sys.online.get(id).rec.fatigue = v }
  return { sys, ctx, mp, logs, priced, events, fatigue, setFatigue }
}

// Ranks by profession for the drink tests; craftCost and the bench's craftSlot name the pricing profession unless named is false
const professionsOf = (ranks, price, named = true) => ({
  ...mastery,
  rankOf: (_ctx, _id, p) => ranks[p] ?? 0,
  rankIn: (_ctx, _id, ps) => Math.max(0, ...ps.map((p) => ranks[p] ?? 0)),
  craftCost: () => (named ? { ...price } : { rank: price.rank, half: price.half, profession: null }),
  craftSlot: () => ({ rank: price.rank, profession: named ? price.profession : null }),
})

const FOOD = 0x6400
const ALE = 0x6401
const HUNGER_EFFECT = 0x6402

// A food restoring 100 hunger and an ale restoring none, both past the record reads
const stock = (sys) => {
  sys.foodCache.set(FOOD, [{ mgefId: HUNGER_EFFECT, amount: 100 }])
  sys.foodCache.set(ALE, [])
  sys.alcoholCache.set(FOOD, false)
  sys.alcoholCache.set(ALE, true)
}

const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`)
const tick = () => new Promise((r) => setImmediate(r))

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

async function main() {
  await test('a craft charges the race factor and logs it; a Nord pays the full price with no race field', () => {
    const t = setup()
    assert.equal(t.sys.chargeCraft(t.ctx, ALTMER, RECIPE), true)
    assert.equal(t.sys.chargeCraft(t.ctx, NORD, RECIPE), true)
    near(1 - t.fatigue(ALTMER), fatigueCost('craft', 1) * 0.75, 'Altmer craft')
    near(1 - t.fatigue(NORD), fatigueCost('craft', 1), 'Nord craft')
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000002 craft') && l.endsWith(', race x0.75')), t.logs.join('\n'))
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000001 craft') && !l.includes('race')), t.logs.join('\n'))
  })

  await test('the bench check prices with the race factor', () => {
    const t = setup()
    const price = fatigueCost('craft', 1)
    t.setFatigue(NORD, price * 0.8)
    t.setFatigue(ALTMER, price * 0.8)
    assert.equal(t.sys.tooTiredForBench(t.ctx, 0x1234, NORD), true)
    assert.equal(t.sys.tooTiredForBench(t.ctx, 0x1234, ALTMER), false)
  })

  await test('a craft the bar cannot pay at the race price is refused, and the refusal line names the factor', async () => {
    const t = setup()
    const price = fatigueCost('craft', 1)
    t.setFatigue(ORC, price * 0.8)
    assert.equal(t.sys.chargeCraft(t.ctx, ORC, RECIPE), false)
    await tick()
    assert.ok(t.logs.some((l) => l.startsWith('[needs] craft refused for ff000003') && l.endsWith(', race x0.85')), t.logs.join('\n'))
  })

  await test('casts, cast charges and kills price through costOf with the actor', () => {
    const t = setup()
    assert.equal(t.sys.castAttempt(t.ctx, ALTMER, SPELL), true)
    t.sys.chargeCast(t.ctx, ALTMER, SPELL)
    t.mp.set(WOLF, 'profileId', -1)
    t.sys.noteHit(ORC, WOLF)
    t.sys.chargeKill(t.ctx, NORD, WOLF)
    assert.deepEqual(t.priced.filter(([, e]) => e === 'magic').map(([id]) => id), [ALTMER, ALTMER])
    near(1 - t.fatigue(ORC), fatigueCost('fight', 1) * 0.85 / 2, 'Orc kill share')
    near(1 - t.fatigue(NORD), fatigueCost('fight', 1) / 2, 'Nord kill share')
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000003 kill') && l.endsWith(', race x0.85')), t.logs.join('\n'))
  })

  await test('canPay and pay multiply the race factor with the caller multiplier', () => {
    const t = setup()
    const cost = fatigueCost('gather', 1, true) * 0.5
    t.setFatigue(NORD, cost * 0.8)
    t.setFatigue(ALTMER, cost * 0.8)
    assert.equal(t.sys.canPay(NORD, 'gather', 1, true, 0.5), false)
    assert.equal(t.sys.canPay(ALTMER, 'gather', 1, true, 0.5), true)
    t.setFatigue(ALTMER, 1)
    t.sys.pay(t.ctx, ALTMER, 'gather', 1, 'harvest flora', true, 0.5)
    near(1 - t.fatigue(ALTMER), cost * 0.75, 'Altmer flower')
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000002 harvest flora') && l.endsWith(', race x0.75')), t.logs.join('\n'))
    assert.deepEqual(t.priced.map(([id, e]) => [id, e]), [[NORD, 'gather'], [ALTMER, 'gather'], [ALTMER, 'gather']])
  })

  await test('a factor that is not finite or not positive counts as 1, and sources multiply', () => {
    const bad = [NaN, 0, -2, Infinity, undefined, 'x'].map((v) => ({ label: 'bad', fatigueCostMult: () => v }))
    const thrower = { label: 'throws', fatigueCostMult: () => { throw new Error('boom') } }
    const extra = { label: 'disease', fatigueCostMult: () => 1.2 }
    const t = setup([raceSource, ...bad, thrower, extra])
    t.sys.chargeCraft(t.ctx, NORD, RECIPE)
    t.sys.chargeCraft(t.ctx, ALTMER, RECIPE)
    near(1 - t.fatigue(NORD), fatigueCost('craft', 1) * 1.2, 'Nord with disease')
    near(1 - t.fatigue(ALTMER), fatigueCost('craft', 1) * 0.75 * 1.2, 'Altmer with disease')
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000002 craft') && l.endsWith(', race x0.75, disease x1.2')), t.logs.join('\n'))
  })

  await test('switched-off fatigue costs nothing whatever the factor', () => {
    const t = setup()
    t.sys.fatigueOn = false
    t.sys.chargeCraft(t.ctx, ALTMER, RECIPE)
    assert.equal(t.fatigue(ALTMER), 1)
  })

  await test('hunger drains by the race factor online', () => {
    const t = setup()
    const now = Date.now()
    for (const id of [NORD, ORC]) Object.assign(t.sys.online.get(id).rec, { hunger: 145, at: now - HOUR })
    t.sys.catchUp(t.sys.online.get(NORD), now)
    t.sys.catchUp(t.sys.online.get(ORC), now)
    near(t.sys.online.get(NORD).rec.hunger - 145, 125, 'Nord hunger per hour')
    near(t.sys.online.get(ORC).rec.hunger - 145, 125 * 0.85, 'Orc hunger per hour')
  })

  await test('the login advance drains offline hunger by the factor and the online line names it', () => {
    const t = setup()
    t.sys.hungerOffline = true
    t.sys.goOffline(t.ctx, ORC)
    t.mp.set(ORC, 'private.needs', { hunger: 145, fatigue: 1, at: Date.now() - HOUR })
    t.logs.length = 0
    t.sys.onActorAssigned(t.ctx, 9, ORC)
    const hunger = t.sys.online.get(ORC).rec.hunger
    assert.ok(Math.abs(hunger - (145 + 125 * 0.85)) < 0.01, `Orc offline hunger ${hunger}`)
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000003 online:') && l.endsWith('hunger drain race x0.85, fatigue costs race x0.85')), t.logs.join('\n'))
  })

  await test('RacialSystem as the source: racialPassives numbers by appearance race, aliases, creation and enabled false', () => {
    const RACE_IDS = { 0x13747: 'OrcRace', 0xa82b9: 'OrcRaceVampire', 0x13743: 'HighElfRace', 0x13746: 'NordRace' }
    const block = { races: { OrcRace: { hungerRateMult: 0.85, fatigueCostMult: 0.85 }, HighElfRace: { fatigueCostMult: 0.75 } } }
    const racial = new RacialSystem(() => {})
    const t = setup([racial])
    t.mp.lookupEspmRecordById = (id) => (RACE_IDS[id] ? { record: { type: 'RACE', editorId: RACE_IDS[id], fields: [] } } : id === SPELL ? SPELL_RECORD : {})
    racial.mp = t.mp
    assert.deepEqual(racial.configure(block), [])
    const VAMPIRE = 0xff000004
    t.mp.set(ORC, 'appearance', { raceId: 0x13747 })
    t.mp.set(ALTMER, 'appearance', { raceId: 0x13743 })
    t.mp.set(NORD, 'appearance', { raceId: 0x13746 })
    t.mp.set(VAMPIRE, 'appearance', { raceId: 0xa82b9 })
    t.mp.set(VAMPIRE, 'private.creationPending', true)
    assert.equal(racial.fatigueCostMult(ORC), 0.85)
    assert.equal(racial.hungerDrainMult(ALTMER), 1)
    assert.equal(racial.fatigueCostMult(NORD), 1)
    assert.equal(racial.traits(VAMPIRE).key, '')
    t.mp.set(VAMPIRE, 'private.creationPending', false)
    racial.raceCache.delete(VAMPIRE)
    assert.equal(racial.traits(VAMPIRE).key, 'OrcRace')
    t.sys.chargeCraft(t.ctx, ALTMER, RECIPE)
    near(1 - t.fatigue(ALTMER), fatigueCost('craft', 1) * 0.75, 'Altmer craft through RacialSystem')
    racial.configure({ ...block, enabled: false })
    assert.equal(racial.fatigueCostMult(ORC), 1)
    const { problems } = parseRacialPassives({ races: { OrcRace: { fatigueCostMult: 0, coldRateMult: 0 } } })
    assert.deepEqual(problems, ['races.OrcRace.fatigueCostMult 0 is not a positive number, 1 is used'])
  })

  await test('a food restores its hunger times the food factor, and the eat line names the factor', () => {
    const gut = { label: 'survival', foodHungerMult: (id) => (id === NORD ? 0.5 : 1) }
    const t = setup([raceSource, gut])
    stock(t.sys)
    for (const id of [NORD, ALTMER]) t.sys.online.get(id).rec.hunger = 400
    t.sys.eat(t.ctx, NORD, FOOD)
    t.sys.eat(t.ctx, ALTMER, FOOD)
    near(t.sys.online.get(NORD).rec.hunger, 350, 'Nord hunger')
    near(t.sys.online.get(ALTMER).rec.hunger, 300, 'Altmer hunger')
    assert.deepEqual(t.logs.filter((l) => l.includes(' ate ')), ['[needs] ff000001 ate 6400: hunger -50 of 100, survival x0.5, hunger 350'])
  })

  await test('the bar refills by the refill factor online and in the offline refill at login', () => {
    const rot = { label: 'survival', fatigueRegenMult: (id) => (id === ORC ? 0.5 : 1) }
    const t = setup([raceSource, rot])
    const now = Date.now()
    for (const id of [NORD, ORC]) Object.assign(t.sys.online.get(id).rec, { fatigue: 0, at: now - HOUR / 2 })
    t.sys.catchUp(t.sys.online.get(NORD), now)
    t.sys.catchUp(t.sys.online.get(ORC), now)
    near(t.fatigue(NORD), 0.5, 'Nord half an hour online')
    near(t.fatigue(ORC), 0.25, 'Orc half an hour online at x0.5')
    t.sys.goOffline(t.ctx, ORC)
    t.mp.set(ORC, 'private.needs', { hunger: 145, fatigue: 0, at: now - HOUR })
    t.logs.length = 0
    t.sys.onActorAssigned(t.ctx, 9, ORC)
    assert.ok(Math.abs(t.fatigue(ORC) - 0.5) < 0.001, `Orc offline refill ${t.fatigue(ORC)}`)
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000003 rested offline') && l.endsWith('fatigue 0% -> 50%, refill survival x0.5')), t.logs.join('\n'))
    assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000003 online:') && l.endsWith(', fatigue refill survival x0.5')), t.logs.join('\n'))
  })

  await test('NEEDS_STAGE_EVENT fires once per stage change and for everyone at the minute tick', async () => {
    const t = setup()
    t.mp.getUserActor = (userId) => [NORD, ALTMER, ORC][userId - 1]
    t.sys.pay(t.ctx, NORD, 'craft', 0, 'craft')
    t.sys.pay(t.ctx, NORD, 'gather', 1, 'harvest')
    t.sys.pay(t.ctx, NORD, 'gather', 4, 'harvest')
    assert.deepEqual(t.events, [[NEEDS_STAGE_EVENT, NORD, 1, 2], [NEEDS_STAGE_EVENT, NORD, 1, 3]])
    t.events.length = 0
    t.sys.poll(t.ctx)
    assert.deepEqual(t.events, [[NEEDS_STAGE_EVENT, NORD, 1, 3], [NEEDS_STAGE_EVENT, ALTMER, 1, 1], [NEEDS_STAGE_EVENT, ORC, 1, 1]])
  })

  await test('a drink steadies a cook in any slot, and discounts only the crafts a cook or alchemist slot priced', async () => {
    const ranks = { blacksmith: 4, cook: 1 }
    const cases = [
      [{ rank: 4, half: false, profession: 'blacksmith' }, true, 1],
      [{ rank: 1, half: false, profession: 'cook' }, true, 0.75],
      [{ rank: 4, half: false }, false, 1],
      [{ rank: 1, half: false }, false, 1],
    ]
    for (const [price, named, share] of cases) {
      const t = setup([], professionsOf(ranks, price, named))
      stock(t.sys)
      t.sys.eat(t.ctx, NORD, ALE)
      await tick()
      assert.ok(t.sys.online.get(NORD).rec.drinkUntil > Date.now(), 'steadied')
      t.sys.chargeCraft(t.ctx, NORD, RECIPE)
      near(1 - t.fatigue(NORD), fatigueCost('craft', price.rank) * share, `${JSON.stringify(price)} craft`)
      assert.deepEqual(t.mp.packets.filter((p) => p.customPacketType === 'masteryNotice').map((p) => p.text),
        ['The drink steadies your hands: your Cook work costs 25% less fatigue for 10 minutes.'])
      assert.ok(t.logs.some((l) => l.startsWith('[needs] ff000001 drinks 6401: Cook crafts -25% until')), t.logs.join('\n'))
    }
    const t = setup([], professionsOf({ cook: 2, alchemist: 1 }, { rank: 2, half: false, profession: 'cook' }))
    stock(t.sys)
    t.sys.eat(t.ctx, NORD, ALE)
    t.sys.eat(t.ctx, NORD, ALE)
    await tick()
    assert.deepEqual(t.mp.packets.filter((p) => p.customPacketType === 'masteryNotice').map((p) => p.text),
      ['The drink steadies your hands: your Cook and Alchemist work costs 25% less fatigue for 10 minutes.', 'The drink keeps your hands steady for another 10 minutes.'])
  })

  await test('the bench check gives the drink discount only at a bench a cook or alchemist slot prices, never through an equal rank of another craft', async () => {
    const ranks = { blacksmith: 2, cook: 2 }
    const full = fatigueCost('craft', 2)
    for (const [profession, tired] of [['blacksmith', true], ['cook', false]]) {
      const t = setup([], professionsOf(ranks, { rank: 2, half: false, profession }))
      stock(t.sys)
      t.sys.eat(t.ctx, NORD, ALE)
      await tick()
      t.setFatigue(NORD, full * 0.9)
      assert.equal(t.sys.tooTiredForBench(t.ctx, 0x1234, NORD), tired, `${profession} bench with a cook Adept beside a blacksmith Adept`)
    }
  })

  await test('a character with no cook or alchemist rank in any slot is not steadied', async () => {
    const t = setup([], professionsOf({ blacksmith: 4 }, { rank: 4, half: false, profession: 'blacksmith' }))
    stock(t.sys)
    t.sys.eat(t.ctx, NORD, ALE)
    await tick()
    assert.equal(t.sys.online.get(NORD).rec.drinkUntil, 0)
    assert.deepEqual(t.mp.packets.filter((p) => p.customPacketType === 'masteryNotice'), [])
  })

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
