'use strict'

// MasterySystem with multiclass slots over a stub mp: picks and their order, per-slot hours, clock and bank, recipe gates, caps,
// markers, the widened rank readers, skills and magicka, resets, the login settle and the off switch: node tools/test-mastery-multiclass.js

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

const { MasterySystem } = load('masterySystem.ts')
const { parseSlots } = load('masterySlots.ts')

const ACTOR = 0xff000100
const USER = 7
const HOUR = 3600000
const RANK_HOURS = [40, 100, 180, 6000]
const THREE = [
  { name: 'Primary', cap: 'Legendary' },
  { name: 'Secondary', cap: 'Adept', rankHours: [20, 60] },
  { name: 'Tertiary', cap: 'Novice', rankHours: [20] },
]
// Bench keywords and recipes
const FORGE = 0x88105
const RACK = 0x7866a
const ARMOR_TABLE = 0xadb78
const SMELTER = 0xa5ccb
const STRIPS = 0x1001   // ungated, tanning rack
const HIDE = 0x1002     // tailor Novice, tanning rack
const TEMPER = 0x1003   // blacksmith Novice, armor table
const NAILS = 0x1004    // ungated, forge
const SMELT = 0x1005    // miner or blacksmith Novice, smelter
const FLAMES = 0x12fcd
const markersOf = (base) => [1, 2, 3, 4, 5].map((i) => base + i)
const SPELLS = { blacksmith: markersOf(0xb00), tailor: markersOf(0xc00), miner: markersOf(0xd00), mage: markersOf(0xe00), hunter: markersOf(0xf00) }

// A SPEL record whose SPIT reads type Spell, so a cast counts
const SPELL_RECORD = { record: { type: 'SPEL', editorId: 'Flames', fields: [{ type: 'SPIT', data: new Uint8Array(36) }] }, toGlobalRecordId: (id) => id }

let now = 1e12
Date.now = () => now

const makeMp = () => {
  const props = new Map()
  const packets = []
  const spells = new Set()
  const calls = []
  props.set(`${ACTOR}:profileId`, 1)
  const idOf = (arg) => parseInt(arg.desc, 16)
  return {
    props, packets, spells, calls,
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, JSON.parse(JSON.stringify(v))) },
    sendCustomPacket: (userId, text) => { if (userId === USER) packets.push(JSON.parse(text)) },
    lookupEspmRecordById: (id) => (id === FLAMES ? SPELL_RECORD : {}),
    getIdFromDesc: () => 0,
    getDescFromId: (id) => id.toString(16),
    getUserByActor: (id) => (id === ACTOR ? USER : 65535),
    getUserActor: (userId) => (userId === USER ? ACTOR : 0),
    callPapyrusFunction: (_kind, _cls, fn, _self, args) => {
      const id = idOf(args[0])
      calls.push(`${fn} ${id.toString(16)}`)
      if (fn === 'AddSpell') spells.add(id)
      if (fn === 'RemoveSpell') spells.delete(id)
      return true
    },
  }
}

const rulesOf = (keywords, extra = {}) => ({ craftKeywords: new Set(keywords), craftStations: new Set(), activatePrefixes: [], activateTypes: new Set(), killKeywords: new Set(), ...extra })

// A system as initAsync leaves it, with the given masterySlots value and an optional race magicka bonus
const setup = ({ slots = THREE, bonus = null } = {}) => {
  const lines = []
  const sys = new MasterySystem((line) => lines.push(line))
  const mp = makeMp()
  const ctx = { svr: mp, gm: { on: () => {} } }
  sys.ctx = ctx
  sys.slots = parseSlots(slots, RANK_HOURS).slots
  sys.spells = SPELLS
  for (const [profession, list] of Object.entries(SPELLS)) list.forEach((id, i) => sys.markers.set(id, { profession, rank: 1 + i }))
  sys.rules = {
    blacksmith: rulesOf([FORGE, ARMOR_TABLE, SMELTER]),
    tailor: rulesOf([RACK, ARMOR_TABLE]),
    hunter: rulesOf([RACK]),
    miner: rulesOf([SMELTER]),
    mage: rulesOf([]),
  }
  sys.kits = { blacksmith: [{ baseId: 0x5ace4, count: 5 }], tailor: [{ baseId: 0xdb5d2, count: 5 }], miner: [{ baseId: 0xe3c16, count: 1 }], mage: [], hunter: [] }
  const recipe = (id, bench, editorId, gates) => {
    sys.benchCache.set(id, bench)
    sys.baseCache.set(id, { id, type: 'COBJ', editorId })
    sys.gateCache.set(id, gates)
  }
  recipe(STRIPS, RACK, 'RecipeLeatherStrips', [])
  recipe(HIDE, RACK, 'RecipeHide', [{ profession: 'tailor', rank: 1 }])
  recipe(TEMPER, ARMOR_TABLE, 'TemperIron', [{ profession: 'blacksmith', rank: 1 }])
  recipe(NAILS, FORGE, 'BYOHRecipeNails', [])
  recipe(SMELT, SMELTER, 'RecipeIngotSteel', [{ profession: 'miner', rank: 1 }, { profession: 'blacksmith', rank: 1 }])
  sys.baseCache.set(0, null)
  sys.benchInReach = () => true
  if (bonus !== null) sys.setRacial({ baseBonus: () => ({ magicka: bonus }) })
  const login = () => sys.onActorAssigned(ctx, USER, ACTOR)
  const choose = (profession, slot) => { sys.lastChooseMs.clear(); sys.onChoose(ctx, USER, slot === undefined ? { profession } : { profession, slot }) }
  const reset = (profession) => { sys.lastChooseMs.clear(); sys.onResetRequest(ctx, USER, profession ? { profession } : {}) }
  const craft = (recipeId) => sys.creditActivity(ctx, { kind: 'craft', actorId: ACTOR, detail: { recipeId, held: 1 } })
  const cast = () => sys.creditActivity(ctx, { kind: 'cast', actorId: ACTOR, detail: { spellId: FLAMES } })
  const notices = () => mp.packets.filter((p) => p.customPacketType === 'masteryNotice').map((p) => p.text)
  const last = (type) => mp.packets.filter((p) => p.customPacketType === type).pop()
  const primary = () => mp.props.get(`${ACTOR}:private.mastery`)
  const subs = () => mp.props.get(`${ACTOR}:private.masterySlots`)
  login()
  return { sys, mp, ctx, lines, login, choose, reset, craft, cast, notices, last, primary, subs }
}

const results = []
function test(name, fn) {
  try {
    now = 1e12
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

test('with one slot a pick is the primary as before and a sub-slot pick is refused', () => {
  const t = setup({ slots: null })
  t.choose('blacksmith')
  assert.equal(t.primary().profession, 'blacksmith')
  assert.equal(t.primary().rank, 1)
  assert.ok(t.mp.spells.has(SPELLS.blacksmith[0]))
  t.choose('tailor', 1)
  assert.equal(t.notices().pop(), 'This server offers no such craft slot.')
  assert.equal(t.subs(), undefined)
  assert.equal(t.last('masteryMenu').slots.length, 1)
  assert.deepEqual(t.last('masteryMenu').rankHours, [0, 0, 40, 100, 180, 6000])
})

test('picks go in order, a held craft is refused, and a sub-slot starts Free with kit items and no gold', () => {
  const t = setup()
  t.choose('tailor', 1)
  assert.equal(t.notices().pop(), 'Choose your primary craft first.')
  t.choose('blacksmith', 0)
  t.choose('blacksmith', 1)
  assert.equal(t.notices().pop(), 'You already follow the Blacksmith.')
  t.choose('miner', 2)
  assert.equal(t.notices().pop(), 'Choose your secondary craft first.')
  t.choose('tailor', 1)
  const rec = t.subs().secondary
  assert.deepEqual([rec.profession, rec.rank, rec.points], ['tailor', 0, 0])
  assert.deepEqual(t.subs().granted, [])
  assert.ok(!t.mp.spells.has(SPELLS.tailor[0]))
  assert.deepEqual(t.subs().kits, ['tailor'])
  assert.ok(t.mp.calls.includes('AddItem db5d2'))
  assert.equal(t.mp.calls.filter((c) => c === 'AddItem f').length, 1, 'gold only from the primary kit')
  assert.match(t.notices().find((n) => n.includes('rising')), /rising no higher than Adept\. It starts at Free: 20 hours of its free work make you a Novice\./)
  t.choose('miner', 1)
  assert.equal(t.notices().pop(), 'Your secondary craft is already the Tailor.')
  const menu = t.last('masteryMenu')
  assert.deepEqual(menu.slots.map((s) => [s.name, s.profession, s.rankName, s.capName]), [['Primary', 'blacksmith', 'Novice', 'Legendary'], ['Secondary', 'tailor', 'Free', 'Adept'], ['Tertiary', null, 'Free', 'Novice']])
  assert.deepEqual(menu.slots.map((s) => s.rankHours), [[0, 0, 40, 100, 180, 6000], [0, 20, 60], [0, 20]])
})

test('a Free sub-slot counts only free work; a gated recipe counts only for its own profession at a rank held', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.craft(STRIPS)
  assert.equal(t.subs().secondary.points, 1)
  assert.equal(t.primary().points, 0, 'the rack is not a blacksmith bench')
  assert.equal(t.notices().pop(), 'Your work as a Tailor is counted: 1 of 20 hours toward Novice.')
  now += HOUR
  t.craft(TEMPER)
  assert.equal(t.primary().points, 1)
  assert.equal(t.subs().secondary.points, 1, 'a blacksmith-gated temper at the shared armor table is not tailor work')
  now += HOUR
  t.craft(HIDE)
  assert.equal(t.subs().secondary.points, 1, 'a tailor Novice recipe is not free work')
  t.craft(SMELT)
  assert.equal(t.primary().points, 2, 'an OR group counts for the blacksmith')
})

test('each slot has its own clock and bank, and banked hours are paid per slot', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.craft(STRIPS)
  t.craft(NAILS)
  assert.deepEqual([t.primary().points, t.subs().secondary.points], [1, 1])
  assert.equal(t.notices().pop(), 'Your work as a Blacksmith is counted: 1 hour at the craft.')
  now += 10 * 60000
  t.craft(STRIPS)
  assert.deepEqual([t.subs().secondary.bank, t.primary().bank], [1, 0])
  assert.equal(t.notices().pop(), 'Extra work banked for your secondary craft: 1 hour will be counted, one per hour you stay online.')
  now += 51 * 60000
  t.sys.payBanks(t.ctx)
  assert.deepEqual([t.subs().secondary.points, t.subs().secondary.bank, t.primary().points], [2, 0, 1])
  assert.ok(t.lines.some((l) => /secondary tailor hour paid from the bank after 60 online min: 2h, 2 of 20 hours toward Novice/.test(l)))
})

test('the bank check reads only online characters with banked hours, saves their online time and lets them go once paid', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.craft(NAILS)
  assert.equal(t.sys.banked.size, 0, 'a counted hour banks nothing')
  t.craft(NAILS)
  assert.deepEqual([...t.sys.banked], [ACTOR])
  t.sys.disconnect(USER, t.ctx)
  assert.equal(t.sys.banked.size, 0, 'offline characters are not checked')
  t.login()
  assert.deepEqual([...t.sys.banked], [ACTOR], 'a login with an hour in the bank joins the check')
  now += 6 * 60000
  t.sys.payBanks(t.ctx)
  assert.deepEqual([t.primary().points, t.primary().bank, t.primary().onlineMs], [1, 1, 6 * 60000], 'not yet due, the online time is saved')
  now += 54 * 60000
  t.sys.payBanks(t.ctx)
  assert.deepEqual([t.primary().points, t.primary().bank, t.sys.banked.size], [2, 0, 0], 'paid and out of the check')
  let reads = 0
  const get = t.mp.get
  t.mp.get = (id, key) => { reads++; return get(id, key) }
  now += HOUR
  t.sys.payBanks(t.ctx)
  assert.equal(reads, 0, 'an empty check reads no record')
})

test('the menu and every state carry each held craft\'s hour clock and bank, read from the stored record after a relog', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  const menuBank = () => { t.sys.sendMenu(t.ctx, USER); return t.last('masteryMenu').bank }
  const idle = (slot) => ({ slot, countedMs: 0, banked: 0, payMs: 0, capped: false })
  assert.deepEqual(menuBank(), { max: 2, intervalMs: HOUR, offline: false, slots: [idle(0), idle(1)] })
  t.craft(NAILS)
  now += 10 * 60000
  const sent = t.mp.packets.length
  t.craft(NAILS)
  assert.ok(t.mp.packets.slice(sent).some((p) => p.customPacketType === 'professionState'), 'a banked hour sends a new state')
  assert.deepEqual(t.last('professionState').bank.slots, [{ slot: 0, countedMs: 50 * 60000, banked: 1, payMs: 50 * 60000, capped: false }, idle(1)])
  now += 20 * 60000
  t.sys.disconnect(USER, t.ctx)
  now += 3 * HOUR
  t.login()
  assert.deepEqual(menuBank().slots[0], { slot: 0, countedMs: 0, banked: 1, payMs: 30 * 60000, capped: false }, 'the counted hour ran out while away, the bank still wants 30 online minutes')
  now += 30 * 60000
  t.sys.payBanks(t.ctx)
  assert.equal(t.primary().points, 2)
  assert.deepEqual(t.last('professionState').bank.slots[0], { slot: 0, countedMs: HOUR, banked: 0, payMs: 0, capped: false })
  t.sys.grantPoints(t.ctx, ACTOR, 60, 1)
  assert.deepEqual(menuBank().slots[1], { slot: 1, countedMs: 0, banked: 0, payMs: 0, capped: true }, 'a sub-slot at its cap')
})

test('with masteryBankOffline the hours that fell due while logged out are counted at the next bank check, an interval apart', () => {
  const t = setup()
  t.sys.bankOffline = true
  t.choose('blacksmith', 0)
  const start = now
  for (let i = 0; i < 3; i++) t.craft(NAILS)
  assert.deepEqual([t.primary().points, t.primary().bank], [1, 2])
  assert.equal(t.notices().pop(), 'Extra work banked: 2 hours will be counted, one per hour, online or not.')
  t.sys.disconnect(USER, t.ctx)
  now += 90 * 60000
  t.login()
  t.sys.sendMenu(t.ctx, USER)
  assert.deepEqual(t.last('masteryMenu').bank.slots, [{ slot: 0, countedMs: 0, banked: 2, payMs: 0, capped: false }])
  t.sys.payBanks(t.ctx)
  assert.deepEqual([t.primary().points, t.primary().bank, t.primary().lastPointAt], [2, 1, start + HOUR], 'one was due, counted when it fell due')
  assert.deepEqual(t.last('professionState').bank, { max: 2, intervalMs: HOUR, offline: true, slots: [{ slot: 0, countedMs: 30 * 60000, banked: 1, payMs: 30 * 60000, capped: false }] })
  assert.ok(t.lines.some((l) => /blacksmith hour paid from the bank after 60 min: 2h, 1 hour still banked/.test(l)))
  now += 30 * 60000
  t.sys.payBanks(t.ctx)
  assert.deepEqual([t.primary().points, t.primary().bank], [3, 0], 'the other falls due online')
  const u = setup()
  u.sys.bankOffline = true
  u.choose('blacksmith', 0)
  for (let i = 0; i < 3; i++) u.craft(NAILS)
  u.sys.disconnect(USER, u.ctx)
  now += 5 * HOUR
  u.login()
  u.sys.payBanks(u.ctx)
  assert.deepEqual([u.primary().points, u.primary().bank, u.sys.banked.size], [3, 0, 0], 'both in one check')
})

test('activity events are credited on the next turn, one drain for a burst', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  const queued = []
  const realImmediate = global.setImmediate
  global.setImmediate = (fn) => queued.push(fn)
  try {
    t.sys.creditWork(ACTOR, 'blacksmith')
    t.sys.creditWork(ACTOR, 'blacksmith')
  } finally {
    global.setImmediate = realImmediate
  }
  assert.equal(queued.length, 1, 'one drain for both events')
  assert.equal(t.primary().points, 0, 'nothing is credited inside the hook')
  queued[0]()
  assert.equal(t.primary().points, 1, 'one hour per interval')
  assert.equal(t.sys.events.length, 0)
})

test('a sub-slot climbs to its cap on its own ladder, then earns nothing', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.sys.grantPoints(t.ctx, ACTOR, 19, 1)
  assert.equal(t.subs().secondary.rank, 0)
  t.sys.grantPoints(t.ctx, ACTOR, 1, 1)
  assert.equal(t.subs().secondary.rank, 1)
  assert.ok(t.mp.spells.has(SPELLS.tailor[0]))
  assert.ok(t.notices().includes('You are now a Novice of the Tailor, your secondary craft.'))
  t.sys.grantPoints(t.ctx, ACTOR, 40, 1)
  assert.equal(t.subs().secondary.rank, 2)
  t.sys.grantPoints(t.ctx, ACTOR, 100, 1)
  assert.equal(t.subs().secondary.rank, 2)
  assert.deepEqual(t.subs().granted, SPELLS.tailor.slice(0, 2))
  t.craft(STRIPS)
  assert.equal(t.subs().secondary.points, 160, 'a capped sub-slot earns no hours')
  assert.equal(t.sys.grantPoints(t.ctx, ACTOR, 5, 2), null, 'an empty sub-slot takes no hours')
})

test('the rank readers take the best slot and craft pricing follows the recipe gates', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.sys.grantPoints(t.ctx, ACTOR, 60, 1)
  assert.equal(t.sys.rankOf(t.ctx, ACTOR, 'tailor'), 2)
  assert.equal(t.sys.rankOf(t.ctx, ACTOR, 'blacksmith'), 1)
  assert.equal(t.sys.rankIn(t.ctx, ACTOR, ['blacksmith', 'tailor']), 2)
  assert.equal(t.sys.rankOf(t.ctx, ACTOR, 'miner'), 0)
  assert.deepEqual(t.sys.craftSlot(t.ctx, ACTOR, ARMOR_TABLE), { rank: 2, profession: 'tailor' })
  assert.deepEqual(t.sys.craftCost(t.ctx, ACTOR, TEMPER), { rank: 1, half: false, profession: 'blacksmith' })
  assert.deepEqual(t.sys.craftCost(t.ctx, ACTOR, HIDE), { rank: 2, half: true, profession: 'tailor' }, 'the rack is a hunter bench, so half')
  assert.deepEqual(t.sys.craftCost(t.ctx, ACTOR, NAILS), { rank: 1, half: false, profession: 'blacksmith' })
  assert.equal(t.sys.professionOf(t.ctx, ACTOR), 'blacksmith')
})

test('skills are the best of the slots, and magicka follows the mage slot and the race bonus', () => {
  const t = setup({ bonus: 50 })
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.sys.grantPoints(t.ctx, ACTOR, 60, 1)
  let state = t.last('professionState')
  assert.deepEqual([state.skills.Smithing, state.skills.LightArmor, state.skills.Marksman], [40, 40, 15])
  assert.equal(state.magicka, 150, 'a non-mage is held at the race base')
  t.choose('mage', 2)
  assert.equal(t.last('professionState').magicka, 150, 'a Free mage sub-slot writes no mage magicka')
  t.sys.grantPoints(t.ctx, ACTOR, 20, 2)
  state = t.last('professionState')
  assert.equal(state.magicka, 175)
  assert.equal(t.sys.lastMagicka(ACTOR), 175, 'the race check compares what was sent')
  assert.equal(state.profession, 'blacksmith')
  assert.equal(state.slots[2].rankName, 'Novice')
  const bare = setup()
  bare.choose('blacksmith', 0)
  assert.equal(bare.last('professionState').magicka, null, 'without a race source a non-mage keeps the engine base')
  const inCreation = setup({ bonus: 50 })
  inCreation.mp.props.set(`${ACTOR}:private.creationPending`, true)
  inCreation.login()
  assert.equal(inCreation.last('professionState').magicka, null)
  assert.equal(inCreation.sys.lastMagicka(ACTOR), null, 'a spawn starts with no write')
})

test('a professionState sent while a GM polymorph holds the character writes the magicka of its own race, not of the worn one', () => {
  const { RacialSystem } = load('racialSystem.ts')
  const HIGH_ELF = 0x13743
  const WOLF = 0x1320a
  const startMagicka = { [HIGH_ELF]: 150, [WOLF]: 0 }
  const raceData = (magicka) => { const data = new Uint8Array(128); new DataView(data.buffer).setFloat32(40, magicka, true); return data }
  const t = setup()
  const lookup = t.mp.lookupEspmRecordById
  t.mp.lookupEspmRecordById = (id) => (id in startMagicka ? { record: { type: 'RACE', editorId: '', fields: [{ type: 'DATA', data: raceData(startMagicka[id]) }] } } : lookup(id))
  const racial = new RacialSystem(() => {})
  racial.mp = t.mp
  t.sys.setRacial(racial)
  t.mp.set(ACTOR, 'appearance', { raceId: HIGH_ELF })
  t.choose('blacksmith', 0)
  assert.equal(t.last('professionState').magicka, 200, 'a High Elf with no mage craft')
  t.mp.props.set(`${ACTOR}:private.polymorph`, { appearance: { raceId: HIGH_ELF }, race: '1320a:Skyrim.esm' })
  t.mp.set(ACTOR, 'appearance', { raceId: WOLF })
  const sent = t.mp.packets.length
  t.sys.grantPoints(t.ctx, ACTOR, 40, 0)
  assert.ok(t.mp.packets.slice(sent).some((p) => p.customPacketType === 'professionState'), 'the grant sends a new state')
  assert.equal(t.last('professionState').magicka, 200, 'granted as a wolf: still the 200 of a High Elf, not 100 + (0 - 50)')
  assert.equal(t.sys.lastMagicka(ACTOR), 200)
  t.mp.props.delete(`${ACTOR}:private.polymorph`)
  t.mp.set(ACTOR, 'appearance', { raceId: HIGH_ELF })
  t.sys.grantPoints(t.ctx, ACTOR, 60, 0)
  assert.equal(t.last('professionState').magicka, 200, 'and the same after the revert')
})

test('a sub-slot mage casts count, and the primary mage keeps its spell tier cap', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('mage', 1)
  t.cast()
  assert.equal(t.subs().secondary.points, 1)
  assert.equal(t.primary().points, 0)
  const m = setup()
  m.choose('mage', 0)
  m.sys.grantPoints(m.ctx, ACTOR, 200, 0)
  assert.equal(m.primary().rank, 2, 'no Adept spell cast yet')
})

test('a reset clears one slot, spends one shared reset and leaves the others', () => {
  const t = setup()
  t.sys.resetsPerCharacter = 1
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.sys.grantPoints(t.ctx, ACTOR, 60, 1)
  t.reset('tailor')
  assert.equal(t.subs().secondary, null)
  assert.deepEqual(t.subs().granted, [])
  assert.ok(!t.mp.spells.has(SPELLS.tailor[0]) && !t.mp.spells.has(SPELLS.tailor[1]))
  assert.equal(t.primary().profession, 'blacksmith')
  assert.ok(t.mp.spells.has(SPELLS.blacksmith[0]))
  assert.equal(t.primary().resets, 1)
  t.reset()
  assert.equal(t.notices().pop(), 'You have no profession resets left.')
  t.choose('tailor', 1)
  assert.equal(t.subs().kits.filter((k) => k === 'tailor').length, 1, 'no second kit for the same craft')
  assert.ok(t.sys.resetCharacter(t.ctx, ACTOR, 0), 'an admin reset needs no reset left')
  assert.equal(t.primary().profession, null)
  assert.equal(t.subs().secondary.profession, 'tailor', 'no promotion into the empty primary')
  t.choose('miner', 2)
  assert.equal(t.notices().pop(), 'Choose your primary craft first.')
})

test('login drops a duplicate sub-slot without stripping the primary, and multiclass off revokes sub markers but keeps records', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.sys.grantPoints(t.ctx, ACTOR, 20, 1)
  const edited = t.subs()
  edited.tertiary = { profession: 'blacksmith', points: 0, lastPointAt: 0, rank: 0, bank: 0, onlineMs: 0 }
  edited.granted.push(SPELLS.blacksmith[0])
  t.mp.props.set(`${ACTOR}:private.masterySlots`, edited)
  t.login()
  assert.equal(t.subs().tertiary, null)
  assert.deepEqual(t.subs().granted, [SPELLS.tailor[0]])
  assert.ok(t.mp.spells.has(SPELLS.blacksmith[0]), 'the primary keeps its marker')
  assert.ok(t.lines.some((l) => /tertiary blacksmith dropped at login/.test(l)))
  assert.ok(t.lines.some((l) => /slots at login: Primary blacksmith Novice 0h, Secondary tailor Novice 20h, Tertiary empty/.test(l)))

  t.sys.slots = parseSlots(undefined, RANK_HOURS).slots
  t.login()
  assert.deepEqual(t.subs().granted, [])
  assert.ok(!t.mp.spells.has(SPELLS.tailor[0]))
  assert.equal(t.subs().secondary.profession, 'tailor', 'the record is kept')
  assert.equal(t.sys.rankOf(t.ctx, ACTOR, 'tailor'), 0)
  t.sys.slots = parseSlots(THREE, RANK_HOURS).slots
  t.login()
  assert.ok(t.sys.pendingGrants.has(ACTOR), 'the login waits out the spawn-time spell wipe')
  t.sys.grantAfterSpawn(t.ctx, ACTOR)
  assert.ok(t.mp.spells.has(SPELLS.tailor[0]), 'turning it back on re-grants the markers')
})

test('with a sub-slot out of force its craft cannot be picked, and the login keeps its record, so restoring the slots loses nothing', () => {
  const t = setup()
  t.choose('blacksmith', 0)
  t.choose('tailor', 1)
  t.sys.grantPoints(t.ctx, ACTOR, 45, 1)
  t.sys.slots = parseSlots(undefined, RANK_HOURS).slots
  t.login()
  t.reset('blacksmith')
  assert.equal(t.sys.summaryOf(t.ctx, ACTOR).profession, null)
  t.choose('tailor', 0)
  assert.equal(t.sys.summaryOf(t.ctx, ACTOR).profession, null, 'the pick is refused')
  assert.equal(t.notices().pop(), 'Your secondary craft, the Tailor, is kept for when this server offers a secondary craft again, so you cannot take it up now.')
  assert.ok(t.lines.some((l) => /tailor refused as primary craft: the secondary slot keeps it while this server has no such slot/.test(l)))
  const stored = t.subs()
  stored.tertiary = { profession: 'cook', points: 5, lastPointAt: 0, rank: 0, bank: 0, onlineMs: 0 }
  t.mp.props.set(`${ACTOR}:private.masterySlots`, stored)
  t.choose('cook', 0)
  assert.equal(t.sys.summaryOf(t.ctx, ACTOR).profession, null, 'a tertiary kept out of force holds its craft too')
  t.login()
  assert.equal(t.subs().secondary.points, 45, 'the out-of-force record is kept at login')
  assert.equal(t.subs().tertiary.profession, 'cook')
  t.sys.slots = parseSlots(THREE, RANK_HOURS).slots
  t.login()
  assert.equal(t.subs().secondary.profession, 'tailor')
  assert.equal(t.sys.rankOf(t.ctx, ACTOR, 'tailor') > 0, true, 'restoring the slots brings the 45 h craft back')
})

let failed = 0
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) { failed++; console.log(err) }
}
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
