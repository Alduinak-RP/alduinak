'use strict'

// The owner's racial list of 2026-09-30, line by line, against the patcher spec (plugin) and RacialSystem with the Test racialPassives block:
// node tools/test-racial-owner-list.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'racialSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { RacialSystem, magicDamageEntries, nativeMagicResistance } = compiled.exports

const spec = require(path.join(__dirname, '..', '..', 'misc', 'proficiency-patcher', 'spec.json')).races

// The Test Server's racialPassives block (docs_server_settings_reference, staged in alduinak-r13/live/r27-RC4)
const BLOCK = {
  enabled: true,
  races: {
    NordRace: { warmth: 25, freezingWaterImmune: false },
    ArgonianRace: { coldRateMult: 1.25, rawMeatSafe: true },
    KhajiitRace: { coldRateMult: 1.25, rawMeatSafe: true },
    OrcRace: { hungerRateMult: 0.85, fatigueCostMult: 0.85, warmth: 10 },
    WoodElfRace: { fatigueCostMult: 0.75 },
    DarkElfRace: { fatigueCostMult: 0.75 },
    HighElfRace: { fatigueCostMult: 0.75 },
    ImperialRace: { startingItems: [{ baseId: '0x0000000F', count: 50 }] },
  },
  powers: { AldPowerCommandAnimal: { cooldownHours: 20, consumeOnMiss: false, commandAnimal: { durationSec: 60, maxLevel: 99, range: 2048, coneDeg: 25, conditionsFrom: 'RaceWoodElfCommandAnimal' } } },
}

const RACE_IDS = { ArgonianRace: 0x13740, BretonRace: 0x13741, DarkElfRace: 0x13742, HighElfRace: 0x13743, ImperialRace: 0x13744, KhajiitRace: 0x13745, NordRace: 0x13746, OrcRace: 0x13747, RedguardRace: 0x13748, WoodElfRace: 0x13749 }
const VAMPIRE_IDS = { ArgonianRaceVampire: 0x8883a, NordRaceVampire: 0x88794, OrcRaceVampire: 0xa82b9, WoodElfRaceVampire: 0x88884 }
const EDIDS = Object.fromEntries(Object.entries({ ...RACE_IDS, ...VAMPIRE_IDS }).map(([edid, id]) => [id, edid]))

const props = new Map()
const mp = {
  get: (id, key) => props.get(`${id >>> 0}:${key}`),
  set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
  lookupEspmRecordById: (id) => (EDIDS[id] ? { record: { type: 'RACE', editorId: EDIDS[id], fields: [] } } : {}),
  callPapyrusFunction: () => undefined,
  getDescFromId: (id) => id.toString(16),
}
const racial = new RacialSystem(() => {})
racial.mp = mp
const problems = racial.configure(BLOCK)
let nextActor = 0xff000200
const traitsOf = (raceEdid) => {
  const id = nextActor++
  mp.set(id, 'appearance', { raceId: RACE_IDS[raceEdid] ?? VAMPIRE_IDS[raceEdid] })
  mp.set(id, 'profileId', 1)
  return racial.traits(id)
}

// What the plugin gives the race: its AldRacial_* effects, RACE starting values above the common 50 and the weapon its fists copy
const ability = (race) => Object.values(spec.abilities).find((a) => a.races.includes(race))?.effects || {}
const passive = (race) => spec.passives.find((p) => p.races.includes(race)) || {}
const bonus = (race) => ({ health: (passive(race).startingHealth ?? 50) - 50, magicka: (passive(race).startingMagicka ?? 50) - 50, stamina: (passive(race).startingStamina ?? 50) - 50 })
const NONE = { health: 0, magicka: 0, stamina: 0 }

const results = []
function test(name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

test('the Test block parses without a problem', () => assert.deepEqual(problems, []))

test('Argonian: resist disease 75, resist poison 75, water breathing, claws of an iron dagger', () => {
  assert.deepEqual([ability('ArgonianRace').AbResistDisease, ability('ArgonianRace').AbResistPoison], [75, 75])
  assert.equal(passive('ArgonianRace').unarmedDamageFrom, 'IronDagger')
  // The vanilla water breathing ability stays: only the listed spell leaves the race
  assert.deepEqual(passive('ArgonianRace').removeSpells, ['RaceArgonianResistDisease'])
  assert.deepEqual(bonus('ArgonianRace'), NONE)
})

test('Breton: resist magic 50, +50 magicka', () => {
  assert.deepEqual(ability('BretonRace'), { AbResistMagic: 50 })
  assert.deepEqual(bonus('BretonRace'), { health: 0, magicka: 50, stamina: 0 })
})

test('Breton and Orc magic resistance on spell damage: the two entries until they are removed, then the native rule of the rebalance', () => {
  const race = (id) => ({ function: 'GetIsRace', runsOn: 'Target', comparison: '==', value: 1, parameter1: id, parameter2: '0x0', logicalOperator: 'OR' })
  // The entries of the Test settings (alduinak-r13/live/r27-RC4)
  const entries = {
    hunterOverDraw: { physicalDamageMultiplier: 1.2, conditions: [] },
    racialMagicResistBreton: { magicDamageMultiplier: 0.5, conditions: [race('0x00013741'), race('0x0008883C')] },
    racialMagicResistOrc: { magicDamageMultiplier: 0.75, conditions: [race('0x00013747'), race('0x000A82B9')] },
  }
  assert.deepEqual(magicDamageEntries(entries).map((e) => [e.key, e.mult, e.raceIds]),
    [['racialMagicResistBreton', 0.5, [0x13741, 0x8883c]], ['racialMagicResistOrc', 0.75, [0x13747, 0xa82b9]]])
  const on = (block, damageMultConditionalFormulaSettings) => nativeMagicResistance({ alduinakDamageFormulaSettings: block, damageMultConditionalFormulaSettings })
  // The Test Server today: the block is on with no magic key and both entries, so the entries do the work
  assert.equal(on({ enabled: true }, entries), false)
  // The entries removed: the native reads the abilities
  assert.equal(on({ enabled: true }, { hunterOverDraw: entries.hunterOverDraw }), true)
  assert.equal(on({ enabled: true }, undefined), true)
  // magic.resistance decides when it is set: true beside the entries counts twice, false counts nothing
  assert.equal(on({ enabled: true, magic: { resistance: true } }, entries), true)
  assert.equal(on({ enabled: true, magic: { resistance: false } }, {}), false)
  assert.equal(on({ enabled: true, magic: { dtShare: 0.5 } }, {}), true)
  // No rebalance formula, no native rule: live without the block, or durability alone
  assert.equal(on(undefined, {}), false)
  assert.equal(on({ enabled: false, durability: { enabled: true }, magic: { resistance: true } }, {}), false)
  // A value the native rejects the whole block for
  assert.equal(on({ enabled: true, magic: { resistance: 'yes' } }, {}), false)
})

test('Dark Elf: resist fire 75', () => {
  assert.equal(ability('DarkElfRace').AbResistFire, 75)
  assert.deepEqual(bonus('DarkElfRace'), NONE)
})

test('High Elf: +100 magicka, weakness to fire, frost and shock 25', () => {
  const a = ability('HighElfRace')
  assert.deepEqual([a.AbWeaknessFireConstant, a.AbWeaknessFrostConstant, a.AbWeaknessShockConstant], [25, 25, 25])
  assert.deepEqual(bonus('HighElfRace'), { health: 0, magicka: 100, stamina: 0 })
})

test('Imperial: +50 starting gold', () => {
  // The grant itself (once per slot, on top of the kit) is tools/test-racial-start-items.js
  assert.deepEqual(racial.entryOf(traitsOf('ImperialRace').raceEdid).startingItems, [{ baseId: 0xf, count: 50 }])
  assert.deepEqual(bonus('ImperialRace'), NONE)
})

test('Khajiit: claws of a steel dagger, Night Eye kept as a racial power', () => {
  assert.equal(passive('KhajiitRace').unarmedDamageFrom, 'SteelDagger')
  assert.ok(spec.keepSpells.includes('PowerKhajiitNightEye'))
  assert.equal(BLOCK.powers.PowerKhajiitNightEye, undefined, 'unlimited: no cooldown entry')
})

test('Nord: 75 frost resistance, +50 stamina, cold at the normal rate with 25 warmth', () => {
  assert.deepEqual(ability('NordRace'), { AbResistFrost: 75, Survival_FortifyWarmthConstant: 25 })
  assert.deepEqual(bonus('NordRace'), { health: 0, magicka: 0, stamina: 50 })
  const t = traitsOf('NordRace')
  assert.deepEqual([t.coldRateMult, t.warmth, t.freezingWaterImmune], [1, 25, false])
  assert.equal(traitsOf('NordRaceVampire').warmth, 25, 'the vampire race takes the entry through its alias')
  assert.ok(!/never|immune/i.test(spec.abilities.AldRacial_Nord.description + spec.descriptions.NordRace), 'no text promises cold immunity')
})

test('Orc: resist magic 25, +50 health, 15% slower hunger and fatigue, +10 warmth', () => {
  assert.equal(ability('OrcRace').AbResistMagic, 25)
  assert.equal(ability('OrcRace').Survival_FortifyWarmthConstant, 10)
  assert.deepEqual(bonus('OrcRace'), { health: 50, magicka: 0, stamina: 0 })
  const t = traitsOf('OrcRace')
  assert.deepEqual([t.hungerRateMult, t.fatigueCostMult, t.warmth], [0.85, 0.85, 10])
  const v = traitsOf('OrcRaceVampire')
  assert.deepEqual([v.hungerRateMult, v.fatigueCostMult, v.warmth], [0.85, 0.85, 10], 'the vampire race takes the entry through its alias')
})

test('Redguard: resist poison and disease 50, +100 stamina', () => {
  assert.deepEqual(ability('RedguardRace'), { AbResistPoison: 50, AbResistDisease: 50 })
  assert.deepEqual(bonus('RedguardRace'), { health: 0, magicka: 0, stamina: 100 })
})

test('Wood Elf: resist disease 75; Command Animal is rationed to 20 real hours with a free miss', () => {
  assert.equal(ability('WoodElfRace').AbResistDisease, 75)
  const power = spec.powers.AldPowerCommandAnimal
  assert.deepEqual(power.races, ['WoodElfRace', 'WoodElfRaceVampire'])
  assert.deepEqual([BLOCK.powers.AldPowerCommandAnimal.cooldownHours, BLOCK.powers.AldPowerCommandAnimal.consumeOnMiss], [20, false])
  // Not handed out until the command itself is built (plan task RC6, critique A.4)
  assert.equal(power.attach, false)
})

test('Wood, Dark and High Elves: 25% fatigue discount, and nobody else but the Orc pays less', () => {
  for (const race of ['WoodElfRace', 'DarkElfRace', 'HighElfRace', 'WoodElfRaceVampire']) assert.equal(traitsOf(race).fatigueCostMult, 0.75, race)
  for (const race of ['NordRace', 'BretonRace', 'ImperialRace', 'RedguardRace', 'KhajiitRace', 'ArgonianRace']) assert.equal(traitsOf(race).fatigueCostMult, 1, race)
})

test('every race and its vampire form holds its ability, the Imperial none', () => {
  for (const race of Object.keys(RACE_IDS)) {
    const holders = Object.values(spec.abilities).filter((a) => a.races.includes(race))
    assert.equal(holders.length, race === 'ImperialRace' ? 0 : 1, race)
    if (holders.length) assert.ok(holders[0].races.includes(`${race}Vampire`), `${race}Vampire`)
  }
})

for (const [ok, name, err] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) console.log(err)
}
const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
