'use strict'

// masterySlots.ts: slot parsing and the off switch, ranks and caps per slot, craft gates, pick order and duplicates: node tools/test-mastery-slots.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'masterySlots.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false })
const compiled = new Module(source)
compiled._compile(outputFiles[0].text, source)
const slots = compiled.exports

const { FREE, NOVICE, ADEPT, LEGENDARY, RANK_NAMES } = slots
const EXPERT = RANK_NAMES.indexOf('Expert')
const MASTER = RANK_NAMES.indexOf('Master')
const RANK_HOURS = [40, 100, 180, 6000]
const PRIMARY = { name: 'Primary', cap: LEGENDARY, rankHours: [0, 40, 100, 180, 6000] }
const SECONDARY = { name: 'Secondary', cap: ADEPT, rankHours: [20, 60] }
const TERTIARY = { name: 'Tertiary', cap: NOVICE, rankHours: [20] }
// The multiclass design's value, the one the test settings carry
const THREE = [
  { name: 'Primary', cap: 'Legendary' },
  { name: 'Secondary', cap: 'Adept', rankHours: [20, 60] },
  { name: 'Tertiary', cap: 'Novice', rankHours: [20] },
]
const PROFESSIONS = ['alchemist', 'blacksmith', 'cook', 'farmer', 'hunter', 'mage', 'miner', 'tailor', 'warrior', 'woodworker']

const results = []
function test(name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

const gate = (profession, rank) => ({ profession, rank })

test('no masterySlots is one Legendary primary on masteryRankHours, multiclassing off', () => {
  for (const raw of [undefined, null]) {
    const parsed = slots.parseSlots(raw, RANK_HOURS)
    assert.deepEqual(parsed, { slots: [PRIMARY], error: null })
    assert.equal(slots.multiclassOn(parsed.slots), false)
  }
  assert.deepEqual(slots.parseSlots(undefined, [10, 20, 30, 40]).slots[0].rankHours, [0, 10, 20, 30, 40])
  assert.equal(slots.describeSlots(slots.defaultSlots(RANK_HOURS)), 'Primary to Legendary (0/40/100/180/6000 h), multiclass off')
})

test('the design value parses into three slots with their caps and ladders', () => {
  const parsed = slots.parseSlots(THREE, RANK_HOURS)
  assert.deepEqual(parsed, { slots: [PRIMARY, SECONDARY, TERTIARY], error: null })
  assert.equal(slots.multiclassOn(parsed.slots), true)
  assert.equal(slots.describeSlots(parsed.slots), 'Primary to Legendary (0/40/100/180/6000 h), Secondary to Adept (20/60 h), Tertiary to Novice (20 h)')
})

test('a one-entry list is the off switch: no sub-slot takes a pick', () => {
  const parsed = slots.parseSlots([{ name: 'Primary', cap: 'Legendary' }], RANK_HOURS)
  assert.deepEqual(parsed, { slots: [PRIMARY], error: null })
  assert.equal(slots.multiclassOn(parsed.slots), false)
  const count = parsed.slots.length
  assert.equal(slots.nextEmptySlot(['blacksmith', null, null], count), -1)
  assert.equal(slots.chooseRefusal(['blacksmith', null, null], count, 'tailor', 1), 'not-configured')
  assert.equal(slots.chooseRefusal([null, null, null], count, 'tailor', 0), null)
})

test('caps by name in any case or by index, names by position, hours past the cap ignored', () => {
  const parsed = slots.parseSlots([{ cap: 5 }, { cap: ' adept ', rankHours: [20, 60, 100] }, { cap: 1, rankHours: [20, 40] }], RANK_HOURS)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.slots, [PRIMARY, SECONDARY, TERTIARY])
  assert.deepEqual(slots.parseSlots([{ name: 'Main', cap: 'Expert' }], RANK_HOURS).slots, [{ name: 'Main', cap: EXPERT, rankHours: [0, 40, 100] }])
  assert.deepEqual(slots.parseSlots([{ cap: 'Legendary', rankHours: [20, 60, 120, 200, 7000] }], RANK_HOURS).slots[0].rankHours, [20, 60, 120, 200, 7000])
  assert.deepEqual(slots.parseSlots([{ cap: 'Legendary' }, { cap: 'Novice', rankHours: [0] }], RANK_HOURS).slots[1].rankHours, [0])
})

test('a malformed value keeps the one-slot default and says why', () => {
  const primary = { name: 'Primary', cap: 'Legendary' }
  const bad = [
    'three',
    { cap: 'Legendary' },
    [],
    [primary, THREE[1], THREE[2], { cap: 'Novice', rankHours: [20] }],
    [5],
    [[primary]],
    [{ cap: 'Free' }],
    [{ cap: 0 }],
    [{ cap: 'Grandmaster' }],
    [{ cap: 6 }],
    [{ cap: 2.5 }],
    [{ cap: '2' }],
    [{}],
    [{ cap: 'Legendary', rankHours: [0, 40] }],
    [primary, { cap: 'Adept' }],
    [primary, { cap: 'Adept', rankHours: [20] }],
    [primary, { cap: 'Adept', rankHours: [60, 20] }],
    [primary, { cap: 'Novice', rankHours: [-1] }],
    [primary, { cap: 'Novice', rankHours: ['20'] }],
    [primary, { cap: 'Novice', rankHours: [Infinity] }],
    [primary, { cap: 'Novice', rankHours: 20 }],
    [primary, null],
  ]
  for (const raw of bad) {
    const parsed = slots.parseSlots(raw, RANK_HOURS)
    assert.deepEqual(parsed.slots, [PRIMARY], JSON.stringify(raw))
    assert.equal(typeof parsed.error, 'string', JSON.stringify(raw))
    assert.ok(parsed.error.length > 0, JSON.stringify(raw))
  }
  assert.match(slots.parseSlots([primary, { cap: 'Adept' }], RANK_HOURS).error, /^slot 2 rankHours/)
  assert.match(slots.parseSlots([{ cap: 'Grandmaster' }], RANK_HOURS).error, /^slot 1 cap/)
})

test('rank per slot at 0, 19, 20, 59, 60 and 500 hours', () => {
  const hours = [0, 19, 20, 59, 60, 500]
  const expected = [
    [PRIMARY, [NOVICE, NOVICE, NOVICE, ADEPT, ADEPT, MASTER]],
    [SECONDARY, [FREE, FREE, NOVICE, NOVICE, ADEPT, ADEPT]],
    [TERTIARY, [FREE, FREE, NOVICE, NOVICE, NOVICE, NOVICE]],
  ]
  for (const [cfg, ranks] of expected) {
    assert.deepEqual(hours.map(h => slots.slotRankFor(cfg, h)), ranks, cfg.name)
  }
  assert.equal(slots.slotRankFor(PRIMARY, 99), ADEPT)
  assert.equal(slots.slotRankFor(PRIMARY, 100), EXPERT)
  assert.equal(slots.slotRankFor(PRIMARY, 6000), LEGENDARY)
  assert.equal(slots.slotRankFor(SECONDARY, 100000), ADEPT)
})

test('a slot at its cap earns nothing more and has no next rank', () => {
  assert.equal(slots.isCapped(SECONDARY, 59), false)
  assert.equal(slots.isCapped(SECONDARY, 60), true)
  assert.equal(slots.isCapped(SECONDARY, 500), true)
  assert.equal(slots.isCapped(TERTIARY, 19), false)
  assert.equal(slots.isCapped(TERTIARY, 20), true)
  assert.equal(slots.isCapped(PRIMARY, 5999), false)
  assert.equal(slots.isCapped(PRIMARY, 6000), true)
  assert.deepEqual(slots.hoursToNext(SECONDARY, 7), { rank: NOVICE, at: 20, left: 13 })
  assert.deepEqual(slots.hoursToNext(SECONDARY, 27), { rank: ADEPT, at: 60, left: 33 })
  assert.equal(slots.hoursToNext(SECONDARY, 60), null)
  assert.deepEqual(slots.hoursToNext(TERTIARY, 0), { rank: NOVICE, at: 20, left: 20 })
  assert.equal(slots.hoursToNext(TERTIARY, 20), null)
  assert.deepEqual(slots.hoursToNext(PRIMARY, 52), { rank: EXPERT, at: 100, left: 48 })
})

test('creditsCraft: Anyone, own gate, another profession\'s gate, an OR group, a gate above the slot', () => {
  // Anyone recipes carry no gate and count for every slot, Free included
  assert.equal(slots.creditsCraft('tailor', FREE, []), true)
  assert.equal(slots.creditsCraft('tailor', ADEPT, []), true)
  // Markers are cumulative, so a gate at or below the slot's rank counts
  assert.equal(slots.creditsCraft('tailor', NOVICE, [gate('tailor', NOVICE)]), true)
  assert.equal(slots.creditsCraft('tailor', ADEPT, [gate('tailor', NOVICE)]), true)
  assert.equal(slots.creditsCraft('tailor', ADEPT, [gate('blacksmith', NOVICE)]), false)
  // Smelter corundum ingot: miner or blacksmith of Novice
  const corundum = [gate('miner', NOVICE), gate('blacksmith', NOVICE)]
  assert.equal(slots.creditsCraft('blacksmith', NOVICE, corundum), true)
  assert.equal(slots.creditsCraft('miner', ADEPT, corundum), true)
  assert.equal(slots.creditsCraft('miner', FREE, corundum), false)
  assert.equal(slots.creditsCraft('tailor', LEGENDARY, corundum), false)
  // A Free slot counts only ungated work
  assert.equal(slots.creditsCraft('tailor', FREE, [gate('tailor', NOVICE)]), false)
  assert.equal(slots.creditsCraft('tailor', NOVICE, [gate('tailor', ADEPT)]), false)
})

test('slots fill in order: primary, then secondary, then tertiary', () => {
  assert.equal(slots.nextEmptySlot([null, null, null], 3), 0)
  assert.equal(slots.nextEmptySlot(['blacksmith', null, null], 3), 1)
  assert.equal(slots.nextEmptySlot(['blacksmith', 'tailor', null], 3), 2)
  assert.equal(slots.nextEmptySlot(['blacksmith', 'tailor', 'miner'], 3), -1)
  assert.equal(slots.nextEmptySlot([null, 'tailor', 'miner'], 3), 0)
  assert.equal(slots.nextEmptySlot(['blacksmith'], 3), 1)
  const refusals = [
    [[null, null, null], 'blacksmith', 0, null],
    [[null, null, null], 'tailor', 1, 'out-of-order'],
    [['blacksmith', null, null], 'tailor', 2, 'out-of-order'],
    [['blacksmith', null, null], 'tailor', 1, null],
    [['blacksmith', null, null], 'blacksmith', 1, 'held'],
    [['blacksmith', null, null], 'cook', 0, 'taken'],
    [['blacksmith', null, null], 'blacksmith', 0, 'taken'],
    [['blacksmith', 'tailor', null], 'tailor', 2, 'held'],
    [['blacksmith', 'tailor', null], 'miner', 2, null],
    [['blacksmith', 'tailor', 'miner'], 'cook', 3, 'not-configured'],
    [['blacksmith', null, null], 'cook', -1, 'not-configured'],
    [['blacksmith', null, null], 'cook', 1.5, 'not-configured'],
    [['blacksmith', null, null], 'cook', undefined, 'not-configured'],
    // A reset primary is refilled by a new pick; the secondary never moves up
    [[null, 'tailor', null], 'tailor', 0, 'held'],
    [[null, 'tailor', null], 'cook', 0, null],
    [[null, 'tailor', null], 'cook', 2, 'out-of-order'],
  ]
  for (const [held, profession, slot, expected] of refusals) {
    assert.equal(slots.chooseRefusal(held, 3, profession, slot), expected, `${JSON.stringify(held)} ${profession} -> ${slot}`)
  }
  // With multiclassing off a kept sub-slot record does not block the primary; the login settle drops the duplicate later
  assert.equal(slots.chooseRefusal([null, 'tailor', null], 1, 'tailor', 0), null)
})

test('duplicate professions keep the lower slot', () => {
  assert.deepEqual(slots.duplicateSlots(['blacksmith', 'tailor', 'blacksmith']), [2])
  assert.deepEqual(slots.duplicateSlots(['blacksmith', 'blacksmith', 'blacksmith']), [1, 2])
  assert.deepEqual(slots.duplicateSlots([null, 'tailor', 'tailor']), [2])
  assert.deepEqual(slots.duplicateSlots(['tailor', null, 'tailor']), [2])
  assert.deepEqual(slots.duplicateSlots(['blacksmith', 'tailor', 'miner']), [])
  assert.deepEqual(slots.duplicateSlots([null, null, null]), [])
})

test('rank readers take the best slot of the professions, and craft pricing follows the recipe gates', () => {
  const held = [{ profession: 'blacksmith', rank: MASTER }, { profession: 'tailor', rank: ADEPT }, { profession: 'miner', rank: FREE }]
  assert.equal(slots.bestSlot(held, ['tailor']).rank, ADEPT)
  assert.equal(slots.bestSlot(held, ['miner']).rank, FREE)
  assert.equal(slots.bestSlot(held, ['cook']), null)
  // Shared charcoal takes the best of its professions
  assert.equal(slots.bestSlot(held, ['woodworker', 'blacksmith', 'miner']).profession, 'blacksmith')
  // Armor table: an ungated Bandit temper goes to the best bench slot, a tailor-gated leather to the tailor
  const armorTable = ['blacksmith', 'tailor']
  assert.equal(slots.bestSlot(held, armorTable, []).profession, 'blacksmith')
  assert.equal(slots.bestSlot(held, armorTable, [gate('tailor', NOVICE)]).profession, 'tailor')
  // Smelter corundum: the Free miner does not qualify, the Master blacksmith does
  assert.equal(slots.bestSlot(held, ['blacksmith', 'miner'], [gate('miner', NOVICE), gate('blacksmith', NOVICE)]).profession, 'blacksmith')
  assert.equal(slots.bestSlot(held, ['miner'], [gate('miner', NOVICE)]), null)
  // Equal ranks: the lower slot prices it
  assert.equal(slots.bestSlot([{ profession: 'cook', rank: NOVICE }, { profession: 'alchemist', rank: NOVICE }], ['alchemist', 'cook']).profession, 'cook')
  // Empty slots never count
  assert.equal(slots.bestSlot([{ profession: null, rank: ADEPT }], ['cook']), null)
  // One profession behaves as before: its rank at its own benches, Free elsewhere
  const single = [{ profession: 'blacksmith', rank: ADEPT }]
  assert.equal(slots.bestSlot(single, ['blacksmith'], [gate('blacksmith', NOVICE)]).rank, ADEPT)
  assert.equal(slots.bestSlot(single, ['blacksmith'], []).rank, ADEPT)
  assert.equal(slots.bestSlot(single, ['tailor'], []), null)
})

test('stored sub-slot records are clamped, and unknown professions are dropped', () => {
  const known = id => PROFESSIONS.includes(id)
  assert.equal(slots.toSlotRecord(undefined, known), null)
  assert.equal(slots.toSlotRecord('tailor', known), null)
  assert.equal(slots.toSlotRecord({ profession: 'bard', points: 5 }, known), null)
  assert.equal(slots.toSlotRecord({ points: 5 }, known), null)
  assert.deepEqual(
    slots.toSlotRecord({ profession: 'tailor', points: '7', lastPointAt: -5, rank: 9, bank: 1.7, onlineMs: 'x' }, known),
    { profession: 'tailor', points: 7, lastPointAt: 0, rank: LEGENDARY, bank: 1, onlineMs: 0 })
  assert.deepEqual(slots.toSlotRecord({ profession: 'miner', points: 25, lastPointAt: 1700000000000, rank: 1, bank: 2, onlineMs: 600000 }, known),
    { profession: 'miner', points: 25, lastPointAt: 1700000000000, rank: NOVICE, bank: 2, onlineMs: 600000 })
  assert.deepEqual(slots.emptySlotRecord('tailor'), { profession: 'tailor', points: 0, lastPointAt: 0, rank: FREE, bank: 0, onlineMs: 0 })
})

let failed = 0
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) {
    failed++
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`)
  }
}
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
