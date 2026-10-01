'use strict'

// The /armor readout: the lines built from the natives getCombatStats and getDurability, the gate through alduinakDamageFormulaSettings
// and the unchanged server without the block or the natives: node tools/test-combat-readout.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const systemsDir = path.join(__dirname, '..', 'ts', 'systems')
// One bundle, so the test reaches the Settings the system reads
const { outputFiles } = esbuild.buildSync({
  stdin: { contents: "export * from './combatReadoutSystem'; export * from './combatStats'; export { Settings } from '../settings';", resolveDir: systemsDir, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error',
})
const source = path.join(systemsDir, 'combatReadoutSystem.ts')
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(systemsDir)
compiled._compile(outputFiles[0].text, source)
const { CombatReadoutSystem, Settings, armorReport, conditionPercent, conditionText, durableCopies, hasDurability, readoutConfig,
  wornPiecesOf, weaponsOf, totalDtOf } = compiled.exports

const PLAYER = 0xff000001
const CUIRASS = 0x13952
const HELMET = 0x13954
const GAUNTLETS = 0x13953
const BOOTS = 0x13951
const SHIELD = 0x13955
const SWORD = 0x13989
const DAGGER = 0x13986
const ROBE = 0x10d671
const STAFF = 0x29b73
const NAMES = { [CUIRASS]: 'Steel Armor', [HELMET]: 'Steel Helmet', [GAUNTLETS]: 'Steel Nordic Gauntlets', [BOOTS]: 'Steel Cuffed Boots',
  [SHIELD]: 'Steel Shield', [SWORD]: 'Steel Sword', [DAGGER]: 'Steel Dagger', [STAFF]: 'Staff of Flames' }
const nameOf = (id) => NAMES[id] || `item ${id.toString(16)}`

// getCombatStats as the native builds it (AlduinakDamageFormula::GetCombatStats): one weapons entry per hand, in inventory order
const attackJson = (kind, type, row, temperStep, baseDamage) => ({ kind, type, row, temperStep, baseDamage,
  damage: baseDamage * (1 + 0.015 * temperStep), critChance: 0.2, critMult: 1.5, penetration: 0, floor: 0.2, powerMult: 2, sneakMult: 1.5,
  speedFactor: 1, interval: 0.7 })
const nativeWeapon = (baseId, hand, type, temperStep, baseDamage) =>
  ({ ...attackJson('melee', type, `Steel ${type}`, temperStep, baseDamage), baseId, hand, item: 'weapon', fallback: false })
const nativeStaff = (baseId, hand) => ({ ...attackJson('none', 'none', '', 0, 0), baseId, hand, item: 'staff', fallback: false })
const nativePiece = (baseId, kind, slots, temperStep, dt, weight) =>
  ({ baseId, kind, row: 'Steel', class: 'heavy', lightOnHeavy: false, fallback: false, slots, temperStep, dt, countedDT: dt, weight })
const nativeStats = (weapons, shield = true) => () => ({
  actorId: PLAYER,
  isPlayer: true,
  armorWeight: 35,
  shieldWeight: shield ? 12 : 0,
  wornDT: shield ? 6.7455 : 6.0255,
  naturalDT: 0,
  pieces: [nativePiece(CUIRASS, 'armor', ['cuirass'], 2, 6.0255, 35), ...(shield ? [nativePiece(SHIELD, 'shield', ['shield'], 0, 0.72, 12)] : [])],
  weapons,
  unarmed: attackJson('unarmed', 'unarmed', 'unarmed', 0, 4),
})
const FINE_SWORD = nativeWeapon(SWORD, 'right', 'sword', 1, 16.5)

// The shapes the designs gave the two natives before NV3b and NV5 were written
const steelStats = () => ({
  dt: 14.31,
  armorWeight: 52,
  pieces: [
    { baseId: CUIRASS, kind: 'armor', row: 'Steel', temperStep: 2, dt: 8.34 },
    { baseId: HELMET, kind: 'armor', row: 'Steel', temperStep: 0, dt: 2.03 },
    { baseId: GAUNTLETS, kind: 'armor', row: 'Steel', temperStep: 0, dt: 1.69 },
    { baseId: BOOTS, kind: 'armor', row: 'Steel', temperStep: 0, dt: 1.69 },
    { baseId: SHIELD, kind: 'shield', row: 'Steel', temperStep: 0, dt: 0.56 },
  ],
  weapon: { baseId: SWORD, row: 'Steel', type: 'sword', damage: 9, temperStep: 1 },
})
const steelCopies = () => [
  { baseId: CUIRASS, count: 1, condition: 0.97, hp: 270, row: 'Steel', kind: 'armor', slot: 'cuirass', worn: true, wornLeft: false, health: 1.2 },
  { baseId: HELMET, count: 1, hp: 68, row: 'Steel', kind: 'armor', slot: 'helmet', worn: true, wornLeft: false, health: 1 },
  { baseId: GAUNTLETS, count: 1, condition: 0.4, hp: 56, row: 'Steel', kind: 'armor', slot: 'gauntlets', worn: true, wornLeft: false, health: 1 },
  { baseId: BOOTS, count: 1, condition: 0, hp: 56, row: 'Steel', kind: 'armor', slot: 'boots', worn: true, wornLeft: false, health: 1 },
  { baseId: SHIELD, count: 1, condition: 0.5, hp: 360, row: 'Steel', kind: 'shield', slot: 'shield', worn: false, wornLeft: true, health: 1 },
  { baseId: SWORD, count: 1, condition: 0.881, hp: 350, row: 'Steel', kind: 'weapon', slot: '', worn: true, wornLeft: false, health: 1.1 },
  { baseId: SWORD, count: 1, condition: 0.2, hp: 350, row: 'Steel', kind: 'weapon', slot: '', worn: false, wornLeft: false, health: 1 },
]

// stats or copies undefined leaves that native out, as an older scam_native.node does
const makeMp = (stats, copies) => {
  const mp = { calls: [] }
  if (stats) mp.getCombatStats = (actorId) => { mp.calls.push(['getCombatStats', actorId >>> 0]); return stats(actorId >>> 0) }
  if (copies) mp.getDurability = (actorId) => { mp.calls.push(['getDurability', actorId >>> 0]); return copies(actorId >>> 0) }
  return mp
}
const BOTH = { stats: true, wear: true, brokenLabel: 'Broken', nameOf }

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
  await test('the percent is the name tag rule: rounded down, 1 above 0, 0 only when broken', () => {
    assert.equal(conditionPercent(1), 100)
    assert.equal(conditionPercent(0.9999), 99)
    assert.equal(conditionPercent(0.97), 97)
    assert.equal(conditionPercent(0.29), 29)
    assert.equal(conditionPercent(0.57), 57)
    assert.equal(conditionPercent(0.005), 1)
    assert.equal(conditionPercent(0), 0)
    assert.equal(conditionPercent(-1), 0)
    assert.equal(conditionPercent(3), 100)
  })

  await test('the condition text carries the HP when the native sends the full HP', () => {
    assert.equal(conditionText(0.97, 350, 'Broken'), '97% (340/350)')
    assert.equal(conditionText(1, 350, 'Broken'), '100% (350/350)')
    assert.equal(conditionText(0.001, 350, 'Broken'), '1% (1/350)')
    assert.equal(conditionText(0, 350, 'Broken'), 'Broken (0/350)')
    assert.equal(conditionText(0, 350, 'Ruined'), 'Ruined (0/350)')
    assert.equal(conditionText(0.5, null, 'Broken'), '50%')
  })

  await test('the gate reads enabled and durability.enabled of the block', () => {
    assert.deepEqual(readoutConfig(undefined), { formula: false, durability: false, brokenLabel: 'Broken' })
    assert.deepEqual(readoutConfig('on'), { formula: false, durability: false, brokenLabel: 'Broken' })
    assert.deepEqual(readoutConfig({ enabled: 1, durability: { enabled: 'true' } }), { formula: false, durability: false, brokenLabel: 'Broken' })
    assert.deepEqual(readoutConfig({ enabled: true }), { formula: true, durability: false, brokenLabel: 'Broken' })
    assert.deepEqual(readoutConfig({ enabled: false, durability: { enabled: true, nameTag: { brokenLabel: ' Ruined ' } } }),
      { formula: false, durability: true, brokenLabel: 'Ruined' })
    assert.deepEqual(readoutConfig({ enabled: true, durability: { enabled: true, nameTag: { brokenLabel: '' } } }),
      { formula: true, durability: true, brokenLabel: 'Broken' })
  })

  await test('the stats readers take the design names and their fallbacks', () => {
    const stats = steelStats()
    assert.equal(wornPiecesOf(stats).length, 5)
    assert.deepEqual(wornPiecesOf(stats)[0], { baseId: CUIRASS, kind: 'armor', left: false, dt: 8.34, fullDt: 8.34, damage: null, temperStep: 2, condition: null })
    assert.deepEqual(weaponsOf(stats), [{ baseId: SWORD, kind: null, left: false, dt: null, fullDt: null, damage: 9, temperStep: 1, condition: null }])
    assert.equal(totalDtOf(stats), 14.31)
    assert.equal(totalDtOf({ totalDT: 7 }), 7)
    assert.equal(totalDtOf({ wornDT: 6 }), 6)
    // No total: the pieces are summed
    assert.equal(totalDtOf({ pieces: [{ baseId: CUIRASS, dt: 8 }, { baseId: HELMET, dt: 2 }] }), 10)
    assert.equal(totalDtOf({}), null)
    // A worn piece at 60% of its DT, as NV5 sends it
    assert.deepEqual(wornPiecesOf({ armor: [{ baseId: CUIRASS, dt: 8, effectiveDT: 6.4, temper: 3, condition: 0.2 }] })[0],
      { baseId: CUIRASS, kind: null, left: false, dt: 6.4, fullDt: 8, damage: null, temperStep: 3, condition: 0.2 })
    assert.deepEqual(wornPiecesOf({ pieces: 'none' }), [])
    assert.deepEqual(wornPiecesOf({ pieces: [null, 5, { row: 'Steel' }, { baseId: 0 }] }), [])
    assert.deepEqual(weaponsOf({}), [])
    assert.deepEqual(weaponsOf({ weapon: null }), [])
  })

  await test('the stats readers take the native shape: wornDT, pieces and one weapons entry per hand, the right hand first', () => {
    const stats = nativeStats([nativeWeapon(DAGGER, 'left', 'dagger', 0, 11.055), FINE_SWORD], false)()
    assert.equal(totalDtOf(stats), 6.0255)
    assert.deepEqual(wornPiecesOf(stats), [{ baseId: CUIRASS, kind: 'armor', left: false, dt: 6.0255, fullDt: 6.0255, damage: null, temperStep: 2, condition: null }])
    const held = weaponsOf(stats)
    assert.deepEqual(held.map((w) => [w.baseId, w.left, w.kind, w.temperStep]), [[SWORD, false, 'melee', 1], [DAGGER, true, 'melee', 0]])
    assert.ok(Math.abs(held[0].damage - 16.7475) < 1e-9)
    // The native's array is left as it came
    assert.equal(stats.weapons[0].baseId, DAGGER)
    // The array wins over a single object, an empty one is fists, entries that are no weapon are skipped
    assert.deepEqual(weaponsOf({ weapons: [FINE_SWORD], weapon: { baseId: DAGGER, damage: 5 } }).map((w) => w.baseId), [SWORD])
    assert.deepEqual(weaponsOf({ weapons: [], weapon: { baseId: DAGGER, damage: 5 } }), [])
    assert.deepEqual(weaponsOf({ weapons: [null, 7, { hand: 'left' }, { baseId: 0 }] }), [])
    // No list: the single object is read
    assert.deepEqual(weaponsOf({ weapons: 'none', weapon: { baseId: DAGGER, damage: 5 } }).map((w) => w.baseId), [DAGGER])
  })

  await test('the durability adapter reads copies, and nothing from a missing, throwing or empty native', () => {
    assert.equal(hasDurability({}), false)
    assert.equal(hasDurability(null), false)
    assert.equal(durableCopies({}, PLAYER), null)
    assert.equal(durableCopies({ getDurability: () => { throw new Error('gone') } }, PLAYER), null)
    assert.equal(durableCopies({ getDurability: () => null }, PLAYER), null)
    assert.deepEqual(durableCopies({ getDurability: () => [] }, PLAYER), [])
    const copies = durableCopies(makeMp(null, steelCopies), PLAYER)
    assert.equal(copies.length, 7)
    assert.deepEqual(copies[0], { baseId: CUIRASS, condition: 0.97, maxHp: 270, worn: true, left: false })
    // No condition field is a copy that never wore
    assert.deepEqual(copies[1], { baseId: HELMET, condition: 1, maxHp: 68, worn: true, left: false })
    // A shield is worn on the left
    assert.deepEqual(copies[4], { baseId: SHIELD, condition: 0.5, maxHp: 360, worn: true, left: true })
    assert.equal(copies[6].worn, false)
    // maxHp wins over hp when the native sends both
    assert.deepEqual(durableCopies({ getDurability: () => ({ items: [{ baseId: SWORD, condition: 0.5, hp: 175, maxHp: 350, worn: true }] }) }, PLAYER),
      [{ baseId: SWORD, condition: 0.5, maxHp: 350, worn: true, left: false }])
  })

  await test('the native shape: the weapon in hand gets its damage and temper line, with and without durability', () => {
    const stats = nativeStats([FINE_SWORD])
    const copies = () => [
      { baseId: CUIRASS, condition: 0.97, hp: 270, worn: true, wornLeft: false },
      { baseId: SHIELD, condition: 0.5, hp: 360, worn: false, wornLeft: true },
      { baseId: SWORD, condition: 0.881, hp: 350, worn: true, wornLeft: false },
    ]
    assert.deepEqual(armorReport(makeMp(stats, copies), PLAYER, { ...BOTH, wear: false }), [
      'Armor: DT 6.75 (taken off each weapon hit), weight 35',
      'Steel Armor: DT 6.03, Superior',
      'Steel Shield: DT 0.72',
      'Steel Sword: damage 16.75, Fine',
    ])
    assert.deepEqual(armorReport(makeMp(stats, copies), PLAYER, BOTH), [
      'Armor: DT 6.75 (taken off each weapon hit), weight 35',
      'Steel Armor: DT 6.03, Superior, 97% (262/270)',
      'Steel Shield: DT 0.72, 50% (180/360)',
      'Steel Sword: damage 16.75, Fine, 88% (308/350)',
    ])
  })

  await test('the native shape: both hands get a damage line, the right hand first, each with the condition of its own copy', () => {
    const dual = nativeStats([nativeWeapon(DAGGER, 'left', 'dagger', 2, 11.055), FINE_SWORD], false)
    assert.deepEqual(armorReport(makeMp(dual, () => [
      { baseId: DAGGER, condition: 0.6, hp: 350, worn: false, wornLeft: true },
      { baseId: SWORD, condition: 1, hp: 350, worn: true, wornLeft: false },
      { baseId: CUIRASS, condition: 1, hp: 270, worn: true, wornLeft: false },
    ]), PLAYER, BOTH), [
      'Armor: DT 6.03 (taken off each weapon hit), weight 35',
      'Steel Armor: DT 6.03, Superior, 100% (270/270)',
      'Steel Sword: damage 16.75, Fine, 100% (350/350)',
      'Steel Dagger: damage 11.39, Superior, 60% (210/350)',
    ])
    // Two swords of one base: each line takes the copy in its own hand, whatever the order of the copies
    const twins = nativeStats([nativeWeapon(SWORD, 'left', 'sword', 0, 16.5), FINE_SWORD], false)
    for (const copies of [
      [{ baseId: SWORD, condition: 0.3, hp: 350, wornLeft: true }, { baseId: SWORD, condition: 0.9, hp: 350, worn: true }],
      [{ baseId: SWORD, condition: 0.9, hp: 350, worn: true }, { baseId: SWORD, condition: 0.3, hp: 350, wornLeft: true }],
    ]) {
      assert.deepEqual(armorReport(makeMp(twins, () => copies), PLAYER, BOTH).slice(2),
        ['Steel Sword: damage 16.75, Fine, 90% (315/350)', 'Steel Sword: damage 16.5, 30% (105/350)'])
    }
    // A copy list that names no hand still gives each line one copy
    assert.deepEqual(armorReport(makeMp(twins, () => [{ baseId: SWORD, condition: 0.9, hp: 350, worn: true }, { baseId: SWORD, condition: 0.3, hp: 350, worn: true }]),
      PLAYER, BOTH).slice(2), ['Steel Sword: damage 16.75, Fine, 90% (315/350)', 'Steel Sword: damage 16.5, 30% (105/350)'])
  })

  await test('the native shape: a staff has no weapon damage, fists give no weapon line', () => {
    assert.deepEqual(armorReport(makeMp(nativeStats([nativeStaff(STAFF, 'right')], false), () => []), PLAYER, BOTH).slice(2),
      ['Staff of Flames: no weapon damage'])
    assert.equal(armorReport(makeMp(nativeStats([], false), () => []), PLAYER, BOTH).length, 2)
  })

  await test('rebalance and durability: DT, temper and condition per worn piece, then the weapon', () => {
    const mp = makeMp(steelStats, steelCopies)
    assert.deepEqual(armorReport(mp, PLAYER, BOTH), [
      'Armor: DT 14.31 (taken off each weapon hit), weight 52',
      'Steel Armor: DT 8.34, Superior, 97% (262/270)',
      'Steel Helmet: DT 2.03, 100% (68/68)',
      'Steel Nordic Gauntlets: DT 1.69, 40% (22/56)',
      'Steel Cuffed Boots: DT 1.69, Broken (0/56)',
      'Steel Shield: DT 0.56, 50% (180/360)',
      'Steel Sword: damage 9, Fine, 88% (308/350)',
    ])
    assert.deepEqual(mp.calls, [['getCombatStats', PLAYER], ['getDurability', PLAYER]])
  })

  await test('rebalance alone: no condition, and the durability native is never asked', () => {
    const mp = makeMp(steelStats, steelCopies)
    assert.deepEqual(armorReport(mp, PLAYER, { ...BOTH, wear: false }), [
      'Armor: DT 14.31 (taken off each weapon hit), weight 52',
      'Steel Armor: DT 8.34, Superior',
      'Steel Helmet: DT 2.03',
      'Steel Nordic Gauntlets: DT 1.69',
      'Steel Cuffed Boots: DT 1.69',
      'Steel Shield: DT 0.56',
      'Steel Sword: damage 9, Fine',
    ])
    assert.deepEqual(mp.calls, [['getCombatStats', PLAYER]])
  })

  await test('durability alone (TES5 damage): the worn copies with their condition', () => {
    const mp = makeMp(steelStats, steelCopies)
    assert.deepEqual(armorReport(mp, PLAYER, { ...BOTH, stats: false }), [
      'Steel Armor: 97% (262/270)',
      'Steel Helmet: 100% (68/68)',
      'Steel Nordic Gauntlets: 40% (22/56)',
      'Steel Cuffed Boots: Broken (0/56)',
      'Steel Shield: 50% (180/360)',
      'Steel Sword: 88% (308/350)',
    ])
    assert.deepEqual(mp.calls, [['getDurability', PLAYER]])
    assert.deepEqual(armorReport(makeMp(null, () => [{ baseId: SWORD, condition: 0.2, hp: 350, worn: false }]), PLAYER, { ...BOTH, stats: false }),
      ['Nothing you wear or hold wears down.'])
  })

  await test('a worn piece below full condition shows the DT it gives of its full DT', () => {
    const stats = () => ({ dt: 6.4, armorWeight: 35, pieces: [{ baseId: CUIRASS, dt: 8, effectiveDT: 6.4, temperStep: 0, condition: 0.2 }] })
    assert.deepEqual(armorReport(makeMp(stats, () => [{ baseId: CUIRASS, condition: 0.2, hp: 270, worn: true }]), PLAYER, BOTH), [
      'Armor: DT 6.4 (taken off each weapon hit), weight 35',
      'Steel Armor: DT 6.4 of 8, 20% (54/270)',
    ])
    // The condition of the stats shows without a matching copy, without the HP
    assert.deepEqual(armorReport(makeMp(stats, () => []), PLAYER, BOTH)[1], 'Steel Armor: DT 6.4 of 8, 20%')
  })

  await test('unarmored, fists, clothing and a second weapon', () => {
    assert.deepEqual(armorReport(makeMp(() => ({ dt: 0, armorWeight: 0, pieces: [], weapon: null }), () => []), PLAYER, BOTH),
      ['You wear no armor: DT 0, every weapon hit lands in full.'])
    // Clothing has no DT and no durable copy
    assert.deepEqual(armorReport(makeMp(() => ({ dt: 0, armorWeight: 1, pieces: [{ baseId: ROBE, kind: 'clothing', temperStep: 0, dt: 0 }] }), () => []), PLAYER, BOTH),
      ['Armor: DT 0 (taken off each weapon hit), weight 1', 'item 10d671: DT 0'])
    // Stats with the single weapon object: the left hand's dagger is not in them, so it follows as a condition line
    const dual = armorReport(makeMp(() => ({ dt: 0, armorWeight: 0, pieces: [], weapon: { baseId: SWORD, damage: 9, temperStep: 0 } }),
      () => [{ baseId: SWORD, condition: 1, hp: 350, worn: true }, { baseId: DAGGER, condition: 0.6, hp: 350, wornLeft: true }]), PLAYER, BOTH)
    assert.deepEqual(dual, ['You wear no armor: DT 0, every weapon hit lands in full.', 'Steel Sword: damage 9, 100% (350/350)', 'Steel Dagger: 60% (210/350)'])
    // Two worn copies of one base keep their own condition
    const twins = armorReport(makeMp(() => ({ pieces: [{ baseId: CUIRASS, dt: 8 }, { baseId: CUIRASS, dt: 8 }] }),
      () => [{ baseId: CUIRASS, condition: 0.9, hp: 270, worn: true }, { baseId: CUIRASS, condition: 0.3, hp: 270, worn: true }]), PLAYER, BOTH)
    assert.deepEqual(twins, ['Armor: DT 16 (taken off each weapon hit)', 'Steel Armor: DT 8, 90% (243/270)', 'Steel Armor: DT 8, 30% (81/270)'])
  })

  await test('no lines when the natives have nothing for the actor or throw', () => {
    assert.equal(armorReport(makeMp(() => null, () => null), PLAYER, BOTH), null)
    assert.equal(armorReport(makeMp(() => { throw new Error('gone') }, () => { throw new Error('gone') }), PLAYER, BOTH), null)
    assert.equal(armorReport({}, PLAYER, BOTH), null)
    // One native failing leaves the other's lines
    assert.deepEqual(armorReport(makeMp(() => { throw new Error('gone') }, () => [{ baseId: SWORD, condition: 0.5, hp: 350, worn: true }]), PLAYER, BOTH),
      ['Steel Sword: 50% (175/350)'])
  })

  const boot = async (allSettings, stats, copies) => {
    Settings.cachedPromise = Promise.resolve({ allSettings, dataDir: '.', loadOrder: [] })
    delete globalThis.__alduinakArmorReport
    globalThis.__alduinakItemName = (id) => NAMES[id] || null
    const logs = []
    const mp = makeMp(stats, copies)
    await new CombatReadoutSystem((line) => logs.push(String(line))).initAsync({ svr: mp, gm: { on: () => {}, emit: () => {} } })
    return { logs, mp, report: globalThis.__alduinakArmorReport }
  }
  const BLOCK = { enabled: true, durability: { enabled: true, nameTag: { showAtFull: true, brokenLabel: 'Broken' } } }

  await test('boot: no block, or enabled false with durability off, registers nothing and logs nothing', async () => {
    for (const all of [{}, { alduinakDamageFormulaSettings: null }, { alduinakDamageFormulaSettings: { enabled: false } },
      { alduinakDamageFormulaSettings: { enabled: false, durability: { enabled: false } } }, null]) {
      const b = await boot(all, steelStats, steelCopies)
      assert.equal(b.report, undefined)
      assert.deepEqual(b.logs, [])
      assert.deepEqual(b.mp.calls, [])
    }
  })

  await test('boot: the enabled block registers the readout with names from the gamemode', async () => {
    const b = await boot({ alduinakDamageFormulaSettings: BLOCK }, steelStats, steelCopies)
    assert.deepEqual(b.logs, ['[combat] /armor shows DT and temper per worn piece and condition'])
    assert.equal(typeof b.report, 'function')
    const lines = b.report(PLAYER)
    assert.equal(lines.length, 7)
    assert.equal(lines[1], 'Steel Armor: DT 8.34, Superior, 97% (262/270)')
    // An id as the gamemode passes it after >>> 0, and one it could not name
    assert.equal(b.report(String(PLAYER))[6], 'Steel Sword: damage 9, Fine, 88% (308/350)')
    delete NAMES[SWORD]
    assert.equal(b.report(PLAYER)[6], 'item 13989: damage 9, Fine, 88% (308/350)')
    NAMES[SWORD] = 'Steel Sword'
  })

  await test('boot: a native without one function logs it once and shows the rest', async () => {
    const noStats = await boot({ alduinakDamageFormulaSettings: BLOCK }, undefined, steelCopies)
    assert.deepEqual(noStats.logs, ['[combat] this scam_native.node has no getCombatStats (no DT lines)', '[combat] /armor shows condition'])
    assert.equal(noStats.report(PLAYER)[0], 'Steel Armor: 97% (262/270)')
    const noWear = await boot({ alduinakDamageFormulaSettings: BLOCK }, steelStats, undefined)
    assert.deepEqual(noWear.logs, ['[combat] this scam_native.node has no getDurability (no condition)', '[combat] /armor shows DT and temper per worn piece'])
    assert.equal(noWear.report(PLAYER)[1], 'Steel Armor: DT 8.34, Superior')
  })

  await test('boot: a native with neither function boots, logs once and leaves /armor unknown', async () => {
    const b = await boot({ alduinakDamageFormulaSettings: BLOCK }, undefined, undefined)
    assert.deepEqual(b.logs, ['[combat] this scam_native.node has no getCombatStats (no DT lines) and no getDurability (no condition), /armor is off'])
    assert.equal(b.report, undefined)
    const formulaOnly = await boot({ alduinakDamageFormulaSettings: { enabled: true } }, undefined, steelCopies)
    assert.deepEqual(formulaOnly.logs, ['[combat] this scam_native.node has no getCombatStats (no DT lines), /armor is off'])
    assert.equal(formulaOnly.report, undefined)
    assert.deepEqual(formulaOnly.mp.calls, [])
  })

  await test('boot: durability alone never asks getCombatStats, the rebalance alone never asks getDurability', async () => {
    const wearOnly = await boot({ alduinakDamageFormulaSettings: { enabled: false, durability: { enabled: true } } }, steelStats, steelCopies)
    assert.deepEqual(wearOnly.logs, ['[combat] /armor shows condition'])
    wearOnly.report(PLAYER)
    assert.deepEqual(wearOnly.mp.calls, [['getDurability', PLAYER]])
    const formulaOnly = await boot({ alduinakDamageFormulaSettings: { enabled: true, durability: { enabled: false } } }, steelStats, steelCopies)
    assert.deepEqual(formulaOnly.logs, ['[combat] /armor shows DT and temper per worn piece'])
    formulaOnly.report(PLAYER)
    assert.deepEqual(formulaOnly.mp.calls, [['getCombatStats', PLAYER]])
  })

  let failed = 0
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) {
      failed++
      console.log(err && err.stack ? err.stack : err)
    }
  }
  console.log(`${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main()
