'use strict'

// The repair menu of the workbench and grindstone (durabilitySystem.ts) over a stub mp: costs, the activation hook, the packets, the
// repair itself, "Improve items", the chat command, the wear notices and the unchanged server without the block or the natives:
// node tools/test-durability-repair.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: globalThis.__repairSettings, dataDir: "", loadOrder: [] }) }', loader: 'js' }))
  },
}

const load = async () => {
  const dir = path.join(__dirname, '..', 'ts', 'systems')
  const source = path.join(dir, 'test-durability-repair-entry.ts')
  const { outputFiles } = await esbuild.build({
    stdin: { contents: 'export * from "./durabilitySystem"; export * as native from "./durabilityNative";', resolveDir: dir, sourcefile: source, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', plugins: [settingsStub], logLevel: 'error',
  })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(dir)
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

let DurabilitySystem, repairUnits, applyRepairs, materialsHeld, rowKey, native

const PLAYER = 0xff000001
const USER = 3
const NPC = 0xff000044
const WORKBENCH = 0x000d932f
const GRINDSTONE = 0x0006e9c2
const DOOR = 0x00016a02
const WORKBENCH_BASE = 0x000d5501
const GRINDSTONE_BASE = 0x000d5502
const DOOR_BASE = 0x000d5503
const ARMOR_TABLE = 0x000adb78
const SHARPENING_WHEEL = 0x00088108
const SWORD = 0x13989
const CUIRASS = 0x13952
const HELMET = 0x13954
const SHIELD = 0x13955
const BOW = 0x13985
const RELIC = 0x000f1234
const ODDITY = 0x000f1235
const STEEL = 0x5ace5
const IRON = 0x5ace4
const LEATHER = 0xdb5d2
const NAMES = { [SWORD]: 'Steel Sword', [CUIRASS]: 'Steel Armor', [HELMET]: 'Steel Helmet', [SHIELD]: 'Steel Shield', [BOW]: 'Hunting Bow',
  [RELIC]: 'Old Relic Blade', [ODDITY]: 'Odd Blade', [STEEL]: 'Steel Ingot', [IRON]: 'Iron Ingot', [LEATHER]: 'Leather' }

// Conditions as the native hands them out: float32 of a value rounded to 1e-4
const c = (v) => Math.fround(v)
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const item = (baseId, condition, more = {}) => ({ baseId, count: 1, ...(condition === undefined ? {} : { condition: c(condition) }), ...more })

const u32 = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return new Uint8Array(b) }
const record = (type, fields = []) => ({ record: { type, editorId: '', fields }, toGlobalRecordId: (id) => id >>> 0 })
const temper = (created, bench, inputs) => record('COBJ', [
  { type: 'CNAM', data: u32(created) }, { type: 'BNAM', data: u32(bench) }, ...inputs.map(([id, n]) => ({ type: 'CNTO', data: u32(id, n) })),
])
const armor = (bipedBits) => record('ARMO', [{ type: 'BOD2', data: u32(bipedBits, 1) }])
const weapon = (animType) => record('WEAP', [{ type: 'DNAM', data: new Uint8Array([animType, 0, 0, 0]) }])

const RECORDS = {
  [SWORD]: weapon(1), [BOW]: weapon(7), [RELIC]: weapon(1), [ODDITY]: weapon(1),
  [CUIRASS]: armor(1 << 2), [HELMET]: armor(1 << 0), [SHIELD]: armor(1 << 9),
  [STEEL]: record('MISC'), [IRON]: record('MISC'), [LEATHER]: record('MISC'),
  [WORKBENCH_BASE]: record('FURN'), [GRINDSTONE_BASE]: record('FURN'), [DOOR_BASE]: record('DOOR'),
  0xc001: temper(SWORD, SHARPENING_WHEEL, [[STEEL, 1]]),
  0xc002: temper(CUIRASS, ARMOR_TABLE, [[STEEL, 1]]),
  0xc003: temper(HELMET, ARMOR_TABLE, [[STEEL, 1]]),
  0xc004: temper(SHIELD, ARMOR_TABLE, [[STEEL, 1]]),
  0xc005: temper(BOW, SHARPENING_WHEEL, [[STEEL, 1], [LEATHER, 2]]),
  // A second way to temper the sword, and a smithing recipe that is no temper
  0xc006: temper(SWORD, SHARPENING_WHEEL, [[IRON, 3]]),
  0xc007: temper(SWORD, 0x00088105, [[STEEL, 9]]),
}

const durability = (repair = {}, more = {}) => ({
  alduinakDamageFormulaSettings: {
    enabled: false,
    durability: {
      enabled: true,
      nameTag: { showAtFull: true, brokenLabel: 'Broken' },
      repair: { fallbackMaterial: { weapon: { Iron: '5ace4:Skyrim.esm', Ghost: 'ffffff:Missing.esm' } }, ...repair },
      ...more,
    },
  },
})

// What the native lists: every durable copy with its row, kind, slot and full HP
const KINDS = { [SWORD]: ['weapon', 'Steel', '', 350], [BOW]: ['bow', 'Hunting', '', 350], [RELIC]: ['weapon', 'Iron', '', 250], [ODDITY]: ['weapon', 'Ghost', '', 250],
  [CUIRASS]: ['armor', 'Steel', 'cuirass', 270], [HELMET]: ['armor', 'Steel', 'helmet', 68], [SHIELD]: ['shield', 'Steel', 'shield', 360] }

// shape "design" is the list the design names, without index, maxHp and fallbackMaterial
function world (settings, { natives = ['getDurability', 'settleWear'], inventory = [], equipment = [], shape = 'native' } = {}) {
  globalThis.__repairSettings = settings
  delete globalThis.__alduinakRepairOpen
  globalThis.__alduinakItemName = (id) => NAMES[id] || null
  const w = { packets: [], lines: [], order: [], sets: 0, vanilla: [], paid: [], now: 1000000, tired: false, rankOk: true, canPay: true }
  const props = new Map([
    [PLAYER, { type: 'MpActor', isDead: false, pos: [0, 0, 0], worldOrCellDesc: '3c:Skyrim.esm', inventory: { entries: clone(inventory) }, equipment: { inv: { entries: clone(equipment) } } }],
    [NPC, { type: 'MpActor', isDead: false, pos: [0, 0, 0], worldOrCellDesc: '3c:Skyrim.esm', inventory: { entries: [item(SWORD, 0.2)] } }],
    [WORKBENCH, { pos: [100, 0, 0], worldOrCellDesc: '3c:Skyrim.esm', base: WORKBENCH_BASE }],
    [GRINDSTONE, { pos: [0, 200, 0], worldOrCellDesc: '3c:Skyrim.esm', base: GRINDSTONE_BASE }],
    [DOOR, { pos: [0, 50, 0], worldOrCellDesc: '3c:Skyrim.esm', base: DOOR_BASE }],
    [0, { onlinePlayers: [PLAYER] }],
  ])
  w.props = props
  w.inv = () => props.get(PLAYER).inventory.entries
  const mp = {
    get: (id, prop) => {
      if (prop === 'inventory') w.order.push('get')
      const form = props.get(id >>> 0)
      if (!form) throw new Error('no form ' + id)
      return clone(form[prop])
    },
    set: (id, prop, value) => { w.sets++; w.order.push('set:' + prop); props.get(id >>> 0)[prop] = clone(value) },
    getUserByActor: (id) => (id === PLAYER ? USER : 0xffff),
    getUserActor: (userId) => (userId === USER ? PLAYER : 0),
    isConnected: () => true,
    sendCustomPacket: (userId, json) => w.packets.push({ userId, ...JSON.parse(json) }),
    lookupEspmRecordById: (id) => RECORDS[id >>> 0] || { record: null },
    getEspmRecordIdsByType: (type) => Object.keys(RECORDS).map(Number).filter((id) => RECORDS[id].record.type === type),
    getIdFromDesc: (desc) => { if (/Missing/.test(desc)) throw new Error('not loaded'); return parseInt(desc, 16) },
    getDescFromId: (id) => id.toString(16) + ':Skyrim.esm',
    getNeighborsByPosition: () => [DOOR, GRINDSTONE, WORKBENCH, NPC],
    // The engine's activation: the hook decides, then the vanilla bench opens
    callPapyrusFunction: (_kind, _cls, fn, self, args) => {
      assert.equal(fn, 'Activate')
      const target = parseInt(self.desc, 16); const caster = parseInt(args[0].desc, 16)
      if (mp.onActivate(target, caster) !== false) w.vanilla.push(target)
    },
    // The needs check of a bench, installed before the durability hook
    onActivate: (target) => { w.order.push('previous'); return !(w.tired && (target === WORKBENCH || target === GRINDSTONE)) },
  }
  if (natives.includes('settleWear')) mp.settleWear = (id) => { w.order.push('settle:' + (id >>> 0).toString(16)) }
  if (natives.includes('getDurability')) {
    mp.getDurability = (id) => {
      const worn = (props.get(id >>> 0).equipment?.inv?.entries || [])
      return props.get(id >>> 0).inventory.entries.map((e, index) => {
        if (!KINDS[e.baseId]) return null
        const [kind, row, slot, maxHp] = KINDS[e.baseId]
        const condition = e.condition ?? 1
        const at = worn.find((x) => x.baseId === e.baseId && Math.abs((x.condition ?? 1) - condition) < 5e-5)
        const copy = { baseId: e.baseId, count: e.count, condition, row, kind, slot, worn: !!at, wornLeft: !!at && !!at.wornLeft, health: e.health ?? 1 }
        if (shape === 'design') return { ...copy, hp: maxHp }
        // Durability::GetDurability of the native
        return { index, ...copy, percent: Math.floor(condition * 100), broken: condition <= 0, hp: Math.round(condition * maxHp * 10) / 10, maxHp, exempt: false,
          fallbackMaterial: row === 'Iron' ? IRON : 0 }
      }).filter(Boolean)
    }
  }
  w.mp = mp
  const benchKeywords = { [WORKBENCH]: [ARMOR_TABLE], [GRINDSTONE]: [SHARPENING_WHEEL] }
  w.mastery = {
    stationKeywords: (_ctx, refrId) => new Set(benchKeywords[refrId] || []),
    craftSlot: () => ({ rank: 2, profession: 'blacksmith' }),
    halfCostBench: () => false,
    temperCap: () => (w.rankOk ? { rank: 2, profession: 'blacksmith' } : null),
  }
  w.needs = {
    canPay: (_actor, effort, rank, half, mult) => { w.order.push(`canPay:${effort}:${rank}:${mult}`); return w.canPay },
    pay: (_ctx, _actor, effort, rank, what, half, mult) => { w.paid.push({ effort, rank, what, mult }) },
  }
  const handlers = {}
  w.ctx = { svr: mp, gm: { on: (name, fn) => { (handlers[name] ||= []).push(fn) }, once: () => {}, emit: (name, ...args) => (handlers[name] || []).forEach((fn) => fn(...args)) } }
  w.system = new DurabilitySystem((...a) => w.lines.push(a.join(' ')), w.mastery, w.needs)
  w.boot = async () => { await w.system.initAsync(w.ctx); return w }
  w.packet = (type, content = {}) => { w.now += 1000; w.system.customPacket(USER, type, content, w.ctx) }
  w.take = () => w.packets.splice(0)
  w.menu = () => w.packets.filter((p) => p.customPacketType === 'repairMenu').pop()
  w.notices = () => w.packets.filter((p) => p.customPacketType === 'repairNotice').map((p) => p.text)
  return w
}

const results = []
const pending = []
function test (name, fn) {
  pending.push(async () => {
    try { await fn(); results.push([true, name]) } catch (err) { results.push([false, name, err]) }
  })
}

let clock = null
const realNow = Date.now
const withClock = (w) => { clock = w; return w }

test('units: one set per 50% missing for weapons and cuirasses, one set for other pieces, counted on the shown percent', () => {
  assert.deepEqual([0, 1, 49, 50, 51, 99, 100].map((p) => repairUnits(p, 0.5)), [2, 2, 2, 1, 1, 1, 0])
  assert.deepEqual([0, 43, 99, 100].map((p) => repairUnits(p, 1)), [1, 1, 1, 0])
  assert.equal(repairUnits(0, 0.25), 4)
  assert.equal(repairUnits(10, 0), 1, 'a broken setting costs one set')
})

test('settings: defaults without the block, both shapes of fallbackMaterial, an empty chat command stays empty', () => {
  const none = native.repairSettings(undefined)
  assert.deepEqual(none, { unitsPerMissing: { weapon: 0.5, cuirass: 0.5, other: 1 }, fallbackMaterial: {}, requireProfessionRank: false, fatigue: 0,
    anyBench: false, menuOnActivate: true, chatCommand: 'repair', lowNoticeBelow: 0.25 })
  const set = native.repairSettings({ alduinakDamageFormulaSettings: { durability: { repair: {
    unitsPerMissing: { weapon: 0.25, cuirass: 7, other: 'x' }, fallbackMaterial: { weapon: { Iron: '5ace4:Skyrim.esm', Bad: 5 }, Steel: ' 5ace5:Skyrim.esm ' },
    requireProfessionRank: true, fatigue: 0.5, anyBench: true, menuOnActivate: false, chatCommand: ' /Fix ', lowNoticeBelow: 0.1 } } } })
  assert.deepEqual(set, { unitsPerMissing: { weapon: 0.25, cuirass: 0.5, other: 1 }, fallbackMaterial: { weapon: { Iron: '5ace4:Skyrim.esm' }, '': { Steel: '5ace5:Skyrim.esm' } },
    requireProfessionRank: true, fatigue: 0.5, anyBench: true, menuOnActivate: false, chatCommand: 'fix', lowNoticeBelow: 0.1 })
  assert.equal(native.repairSettings({ alduinakDamageFormulaSettings: { durability: { repair: { chatCommand: '' } } } }).chatCommand, '')
})

test('getDurability is read as a list or as { items }, with slot or slots and hp or maxHp', () => {
  const mp = { getDurability: () => ({ items: [
    { baseId: CUIRASS, condition: 0.5, hp: 270, row: 'Steel', kind: 'Armor', slots: ['cuirass'], worn: true },
    { index: 4, baseId: HELMET, condition: 2, maxHp: 68, hp: 30, slot: 'helmet', wornLeft: true, fallbackMaterial: IRON },
    { baseId: SWORD }, { baseId: 0 }, null,
  ] }) }
  assert.deepEqual(native.durableCopies(mp, PLAYER), [
    { index: -1, baseId: CUIRASS, kind: 'armor', row: 'Steel', maxHp: 270, cuirass: true, condition: 0.5, worn: true, wornLeft: false, fallbackMaterial: 0 },
    { index: 4, baseId: HELMET, kind: '', row: '', maxHp: 68, cuirass: false, condition: 1, worn: false, wornLeft: true, fallbackMaterial: IRON },
    { index: -1, baseId: SWORD, kind: '', row: '', maxHp: 0, cuirass: null, condition: 1, worn: false, wornLeft: false, fallbackMaterial: 0 },
  ])
  assert.equal(native.durableCopies({}, PLAYER), null)
  assert.equal(native.durableCopies({ getDurability: () => { throw new Error('x') } }, PLAYER), null)
})

test('applyRepairs takes materials from plain stacks only, a repaired copy joins its pristine stack and a worn one keeps its entry', () => {
  const inv = { entries: [
    item(SWORD), item(SWORD, 0.4), item(CUIRASS, 0.3, { worn: true }), { baseId: STEEL, count: 2 }, { baseId: STEEL, count: 1, condition: c(0.5) },
    { baseId: STEEL, count: 2 }, item(HELMET, 0.9, { health: 1.2 }),
  ] }
  const before = clone(inv)
  assert.deepEqual(Array.from(materialsHeld(inv)), [[SWORD, 1], [STEEL, 4]])
  const out = applyRepairs(inv, [1, 2], new Map([[STEEL, 3]]))
  assert.deepEqual(out.entries, [
    { baseId: SWORD, count: 2 }, { baseId: CUIRASS, count: 1, worn: true }, { baseId: STEEL, count: 1, condition: c(0.5) }, { baseId: STEEL, count: 1 },
    item(HELMET, 0.9, { health: 1.2 }),
  ])
  assert.deepEqual(inv, before, 'the inventory read is left as it was')
  assert.equal(applyRepairs(inv, [1], new Map([[STEEL, 5]])), null, 'short of materials')
  assert.notEqual(rowKey(item(SWORD, 0.4)), rowKey(item(SWORD, 0.39)), 'a copy that wore on answers to another key')
  assert.notEqual(rowKey(item(SWORD, 0.4)), rowKey(item(SWORD, 0.4, { health: 1.2 })))
})

test('without the block, or with durability off, nothing is installed and no packet is answered', async () => {
  for (const settings of [{}, { alduinakDamageFormulaSettings: { enabled: true, durability: { enabled: false } } }]) {
    const w = world(settings, { inventory: [item(CUIRASS, 0.4), { baseId: STEEL, count: 5 }] })
    const hook = w.mp.onActivate
    await w.boot()
    assert.equal(w.mp.onActivate, hook, 'the activation hook is untouched')
    assert.equal(w.mp.onItemBroken, undefined)
    assert.equal(globalThis.__alduinakRepairOpen, undefined)
    w.ctx.gm.emit('userAssignActor', USER, PLAYER)
    w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
    w.packet('durabilityImprove', { bench: WORKBENCH })
    w.packet('durabilityClose')
    await w.system.updateAsync(w.ctx)
    assert.deepEqual(w.packets, [])
    assert.deepEqual(w.lines, [])
    assert.equal(w.sets, 0)
    assert.deepEqual(w.order, [], 'no inventory read, no native call')
  }
})

test('a native without durability switches the feature off with one line; settleWear alone gives the tags but no repairs', async () => {
  const old = await world(durability(), { natives: [], inventory: [item(CUIRASS, 0.4)] }).boot()
  const hook = old.mp.onActivate
  assert.equal(old.lines.length, 1)
  assert.match(old.lines[0], /no durability \(no getDurability, no settleWear\): no condition tags, no repairs/)
  old.ctx.gm.emit('userAssignActor', USER, PLAYER)
  assert.deepEqual(old.packets, [])
  assert.equal(old.mp.onActivate, hook)
  assert.equal(globalThis.__alduinakRepairOpen, undefined)

  const half = world(durability(), { natives: ['settleWear'], inventory: [item(CUIRASS, 0.4)] })
  const before = half.mp.onActivate
  await half.boot()
  assert.deepEqual(half.lines, ['[durability] repairs and wear notices are off: this scam_native.node has no getDurability'])
  half.ctx.gm.emit('userAssignActor', USER, PLAYER)
  assert.deepEqual(half.take(), [{ userId: USER, customPacketType: 'durabilityConfig', enabled: true, showAtFull: true, brokenLabel: 'Broken' }])
  assert.equal(half.mp.onActivate, before)
  half.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(half.packets, [])
})

test('a native that answers null, as after a settings block it rejected, gets no condition tags and no menu', async () => {
  const w = await world(durability(), { inventory: [item(CUIRASS, 0.4)] }).boot()
  w.mp.getDurability = () => null
  w.ctx.gm.emit('userAssignActor', USER, PLAYER)
  w.ctx.gm.emit('userAssignActor', USER, PLAYER)
  assert.deepEqual(w.packets, [])
  assert.equal(w.lines.filter((l) => /the native runs without durability although the settings enable it/.test(l)).length, 1)
})

test('login sends durabilityConfig with the name tag settings', async () => {
  const w = await world(durability({}, { nameTag: { showAtFull: false, brokenLabel: ' Ruined ' } })).boot()
  w.ctx.gm.emit('userAssignActor', USER, PLAYER)
  assert.deepEqual(w.take(), [{ userId: USER, customPacketType: 'durabilityConfig', enabled: true, showAtFull: false, brokenLabel: 'Ruined' }])
  assert.match(w.lines.join('\n'), /\[durability\] repairs on: workbench armor and shields, grindstone weapons, one set of temper materials per 50% of a weapon, 50% of a cuirass, 100% of another piece, 1 fallback materials \(1 not in the load order: weapon Ghost ffffff:Missing.esm\), anyone repairs, fatigue 0, menu on activation, \/repair, low notice below 25%/)
})

const PACK = [
  item(SWORD, 0), item(SWORD), item(CUIRASS, 0.43, { health: 1.2 }), item(HELMET, 0.1), item(SHIELD, 0.995), item(BOW, 0.5, { count: 2 }),
  item(RELIC, 0.3), item(ODDITY, 0.6), { baseId: STEEL, count: 5 }, { baseId: IRON, count: 1 }, { baseId: LEATHER, count: 3 },
]
const WORN = [item(CUIRASS, 0.43, { health: 1.2, worn: true }), item(SWORD, 0, { worn: true }), item(SHIELD, 0.995, { wornLeft: true })]

test('activating the workbench with damaged armor opens the menu before any other check of the bench', async () => {
  const w = await world(durability(), { inventory: PACK, equipment: WORN }).boot()
  w.tired = true
  w.order.length = 0
  assert.equal(w.mp.onActivate(WORKBENCH, PLAYER), false, 'the vanilla bench stays closed')
  assert.deepEqual(w.order, ['settle:ff000001', 'get'], 'wear settled before the pack is read, the needs check never asked')
  const steel = (need) => [{ baseId: STEEL, name: 'Steel Ingot', need, have: 5 }]
  assert.deepEqual(w.take(), [{
    userId: USER, customPacketType: 'repairMenu', bench: WORKBENCH, kind: 'armor', title: 'Workbench: repair armor', reason: 'open',
    rows: [
      { key: rowKey(PACK[2]), baseId: CUIRASS, name: 'Steel Armor (Superior)', percent: 43, hp: 116, maxHp: 270, worn: true, cost: steel(2) },
      { key: rowKey(PACK[4]), baseId: SHIELD, name: 'Steel Shield', percent: 99, hp: 358, maxHp: 360, worn: true, cost: steel(1) },
      { key: rowKey(PACK[3]), baseId: HELMET, name: 'Steel Helmet', percent: 10, hp: 7, maxHp: 68, worn: false, cost: steel(1) },
    ],
  }])
  assert.equal(w.sets, 0)
})

test('the grindstone lists weapons and bows: recipe inputs per set, a stack priced as a whole, fallback material, free without one', async () => {
  const w = await world(durability(), { inventory: PACK, equipment: WORN }).boot()
  assert.equal(w.mp.onActivate(GRINDSTONE, PLAYER), false)
  const menu = w.menu()
  assert.equal(menu.title, 'Grindstone: repair weapons')
  assert.equal(menu.kind, 'weapon')
  assert.deepEqual(menu.rows.map((r) => [r.name, r.percent, r.hp, r.maxHp, r.worn, r.cost.map((m) => `${m.need}/${m.have} ${m.name}`).join(' + ')]), [
    ['Steel Sword', 0, 0, 350, true, '2/5 Steel Ingot'],
    ['Old Relic Blade', 30, 75, 250, false, '2/1 Iron Ingot'],
    ['Hunting Bow x2', 50, 175, 350, false, '2/5 Steel Ingot + 4/3 Leather'],
    ['Odd Blade', 60, 150, 250, false, ''],
  ])
  assert.equal(w.lines.filter((l) => /repaired for free/.test(l)).length, 1)
  assert.match(w.lines.join('\n'), /f1235 \(Odd Blade\) has no temper recipe and no repair.fallbackMaterial for weapon row "Ghost": it is repaired for free/)
  w.mp.onActivate(GRINDSTONE, PLAYER)
  assert.equal(w.lines.filter((l) => /repaired for free/.test(l)).length, 1, 'logged once per base')
})

test('a native that lists the copies as the design names them gives the same menu: worn by the equipment, materials by the settings', async () => {
  const w = await world(durability(), { inventory: PACK, equipment: WORN, shape: 'design' }).boot()
  const now = await world(durability(), { inventory: PACK, equipment: WORN }).boot()
  for (const bench of [WORKBENCH, GRINDSTONE]) {
    assert.equal(w.mp.onActivate(bench, PLAYER), false)
    now.mp.onActivate(bench, PLAYER)
    assert.deepEqual(w.menu(), now.menu())
  }
  assert.equal(w.menu().rows[1].cost[0].name, 'Iron Ingot')
})

test('a second temper recipe pays when the pack covers it and the first one is short', async () => {
  const w = await world(durability(), { inventory: [item(SWORD, 0.2), { baseId: IRON, count: 6 }, { baseId: STEEL, count: 1 }] }).boot()
  w.mp.onActivate(GRINDSTONE, PLAYER)
  assert.deepEqual(w.menu().rows[0].cost, [{ baseId: IRON, name: 'Iron Ingot', need: 6, have: 6 }])
  const poor = await world(durability(), { inventory: [item(SWORD, 0.2)] }).boot()
  poor.mp.onActivate(GRINDSTONE, PLAYER)
  assert.deepEqual(poor.menu().rows[0].cost, [{ baseId: STEEL, name: 'Steel Ingot', need: 2, have: 0 }], 'the first recipe is shown when none is covered')
})

test('a bench with no damaged gear of its kind, another target, an NPC and a downed player pass to the other hooks', async () => {
  const w = await world(durability(), { inventory: [item(CUIRASS, 0.4), item(SWORD)] }).boot()
  w.order.length = 0
  assert.equal(w.mp.onActivate(GRINDSTONE, PLAYER), true, 'only damaged armor: the grindstone is the vanilla one')
  assert.equal(w.order.pop(), 'previous')
  assert.equal(w.mp.onActivate(DOOR, PLAYER), true)
  assert.equal(w.mp.onActivate(GRINDSTONE, NPC), true)
  w.tired = true
  assert.equal(w.mp.onActivate(GRINDSTONE, PLAYER), false, 'the needs check still refuses the vanilla bench')
  assert.deepEqual(w.packets, [])
  w.tired = false
  w.props.get(PLAYER)['private.bleedout'] = true
  w.order.length = 0
  assert.equal(w.mp.onActivate(WORKBENCH, PLAYER), true)
  assert.deepEqual(w.order, ['previous'], 'a downed player is left to the bleedout hook')
  assert.deepEqual(w.packets, [])
})

test('repair by key: one inventory write takes the materials and clears the condition, then the menu is refreshed', async () => {
  const w = withClock(await world(durability(), { inventory: PACK, equipment: WORN }).boot())
  w.mp.onActivate(WORKBENCH, PLAYER)
  const [cuirass] = w.take()[0].rows
  w.order.length = 0
  w.packet('durabilityRepair', { bench: WORKBENCH, keys: [cuirass.key] })
  assert.equal(w.sets, 1)
  assert.deepEqual(w.order.slice(0, 4), ['settle:ff000001', 'get', 'set:inventory', 'settle:ff000001'])
  assert.deepEqual(w.inv().find((e) => e.baseId === CUIRASS), { baseId: CUIRASS, count: 1, health: 1.2 })
  assert.equal(w.inv().find((e) => e.baseId === STEEL).count, 3)
  assert.match(w.lines.join('\n'), /\[durability\] ff000001 repaired 13952 \(Steel Armor \(Superior\)\) 43% -> 100% for 2x Steel Ingot/)
  assert.deepEqual(w.notices(), ['Repaired Steel Armor (Superior) for 2 Steel Ingot.'])
  const menu = w.menu()
  assert.equal(menu.reason, 'refresh')
  assert.deepEqual(menu.rows.map((r) => [r.name, r.cost[0].have]), [['Steel Shield', 3], ['Steel Helmet', 3]])
  assert.deepEqual(w.paid, [], 'no fatigue by default')

  w.take()
  w.packet('durabilityRepair', { bench: WORKBENCH, keys: [cuirass.key] })
  assert.equal(w.sets, 1, 'a stale key repairs nothing')
  assert.deepEqual(w.notices(), ['That item is no longer in the condition shown.'])
  assert.equal(w.menu().reason, 'refresh')
})

test('repair all pays what the pack covers in the order of the rows and names what is left', async () => {
  const w = withClock(await world(durability(), { inventory: PACK, equipment: WORN }).boot())
  w.mp.onActivate(GRINDSTONE, PLAYER)
  w.take()
  w.packet('durabilityRepair', { bench: GRINDSTONE, all: true })
  assert.equal(w.sets, 1)
  // Sword 2 steel, relic short of iron, bows 2 steel but short of leather, the odd blade free
  assert.deepEqual(w.inv(), [
    { baseId: SWORD, count: 2 }, item(CUIRASS, 0.43, { health: 1.2 }), item(HELMET, 0.1), item(SHIELD, 0.995), item(BOW, 0.5, { count: 2 }),
    item(RELIC, 0.3), { baseId: STEEL, count: 3 }, { baseId: IRON, count: 1 }, { baseId: LEATHER, count: 3 }, item(ODDITY),
  ])
  assert.deepEqual(w.notices(), ['Repaired 2 items. 2 items were left: You lack 1 Iron Ingot to repair Old Relic Blade.'])
  assert.deepEqual(w.menu().rows.map((r) => r.name), ['Old Relic Blade', 'Hunting Bow x2'])
})

test('a repair needs the open menu of that bench, the player at it and the materials', async () => {
  const w = withClock(await world(durability(), { inventory: [item(HELMET, 0.5), item(SWORD, 0.5)] }).boot())
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.packets, [], 'no menu open')
  w.mp.onActivate(WORKBENCH, PLAYER)
  w.take()
  w.packet('durabilityRepair', { bench: GRINDSTONE, all: true })
  assert.deepEqual(w.packets, [], 'another bench than the one of the menu')
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.notices(), ['You lack 1 Steel Ingot to repair Steel Helmet.'])
  assert.equal(w.sets, 0)
  w.take()
  w.props.get(PLAYER).pos = [5000, 0, 0]
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.take(), [{ userId: USER, customPacketType: 'repairNotice', text: 'You are too far from the bench.' }])
  w.props.get(PLAYER).pos = [0, 0, 0]
  w.packet('durabilityClose')
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.packets, [], 'closed')
})

test('"Improve items" opens the vanilla bench once through the other checks, the next activation is the menu again', async () => {
  const w = withClock(await world(durability(), { inventory: [item(HELMET, 0.5)] }).boot())
  w.mp.onActivate(WORKBENCH, PLAYER)
  w.take()
  w.packet('durabilityImprove', { bench: WORKBENCH })
  assert.deepEqual(w.vanilla, [WORKBENCH])
  assert.deepEqual(w.packets, [])
  assert.equal(w.mp.onActivate(WORKBENCH, PLAYER), false, 'the bypass is spent')
  assert.equal(w.take().length, 1)
  w.tired = true
  w.packet('durabilityImprove', { bench: WORKBENCH })
  assert.deepEqual(w.vanilla, [WORKBENCH], 'a tired player is still refused the vanilla bench')
  w.packet('durabilityImprove', { bench: WORKBENCH })
  assert.deepEqual(w.vanilla, [WORKBENCH], 'the menu was closed by the first press')
})

test('the chat command opens the nearest bench with work and says why not otherwise', async () => {
  const w = withClock(await world(durability(), { inventory: [item(SWORD, 0.5), { baseId: STEEL, count: 1 }] }).boot())
  const run = () => { w.now += 2000; return globalThis.__alduinakRepairOpen(PLAYER) }
  assert.equal(run(), '', 'the workbench is nearer but only the grindstone has work')
  assert.equal(w.take()[0].bench, GRINDSTONE)
  assert.equal(globalThis.__alduinakRepairOpen(PLAYER), '', 'a second call within the cooldown is dropped')
  assert.deepEqual(w.packets, [])
  w.packet('durabilityRepair', { bench: GRINDSTONE, all: true })
  w.take()
  assert.equal(run(), 'Nothing you carry needs repair at this bench.')
  w.props.get(PLAYER).pos = [9000, 0, 0]
  assert.equal(run(), 'There is no workbench or grindstone within reach.')
  assert.equal(globalThis.__alduinakRepairOpen(NPC), '')
  assert.deepEqual(w.packets, [])
})

test('repair.menuOnActivate false leaves the benches alone, repair.anyBench lets either bench repair everything', async () => {
  const quiet = withClock(await world(durability({ menuOnActivate: false }), { inventory: [item(HELMET, 0.5)] }).boot())
  assert.equal(quiet.mp.onActivate(WORKBENCH, PLAYER), true)
  assert.deepEqual(quiet.packets, [])
  quiet.now += 2000
  assert.equal(globalThis.__alduinakRepairOpen(PLAYER), '')
  assert.equal(quiet.menu().bench, WORKBENCH)

  const any = await world(durability({ anyBench: true }), { inventory: [item(HELMET, 0.5), item(SWORD, 0.5)] }).boot()
  assert.equal(any.mp.onActivate(GRINDSTONE, PLAYER), false)
  assert.equal(any.menu().title, 'Grindstone: repair gear')
  assert.deepEqual(any.menu().rows.map((r) => r.name), ['Steel Helmet', 'Steel Sword'])
})

test('repair.requireProfessionRank asks for the recipe rank and repair.fatigue is paid per repaired item', async () => {
  const w = withClock(await world(durability({ requireProfessionRank: true, fatigue: 0.5 }), { inventory: [item(HELMET, 0.5), item(CUIRASS, 0.9), { baseId: STEEL, count: 5 }] }).boot())
  w.mp.onActivate(WORKBENCH, PLAYER)
  w.take()
  w.rankOk = false
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.notices(), ['2 items were left: You lack the profession rank to repair Steel Helmet.'])
  assert.equal(w.sets, 0)
  w.rankOk = true
  w.canPay = false
  w.take()
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.notices(), ['2 items were left: You are too tired to repair Steel Helmet.'])
  w.canPay = true
  w.take()
  w.order.length = 0
  w.packet('durabilityRepair', { bench: WORKBENCH, all: true })
  assert.deepEqual(w.order.filter((o) => o.startsWith('canPay')), ['canPay:craft:2:0.5', 'canPay:craft:2:1'])
  assert.deepEqual(w.paid, [{ effort: 'craft', rank: 2, what: 'repair of 2 item(s)', mult: 1 }])
  assert.deepEqual(w.notices(), ['Repaired 2 items.'])
  assert.deepEqual(w.menu().rows, [])
})

test('wear notices: a worn item falling below the threshold and a break, each once', async () => {
  const w = withClock(await world(durability(), { inventory: [item(SWORD, 0.3), item(HELMET, 0.2)], equipment: [item(SWORD, 0.3, { worn: true })] }).boot())
  const wear = (condition) => {
    w.props.get(PLAYER).inventory.entries[0].condition = c(condition)
    w.props.get(PLAYER).equipment.inv.entries[0].condition = c(condition)
  }
  const poll = async () => { w.now += 11000; await w.system.updateAsync(w.ctx) }
  await poll()
  assert.deepEqual(w.packets, [], 'the first look only remembers')
  wear(0.26)
  await poll()
  assert.deepEqual(w.packets, [])
  wear(0.2499)
  await poll()
  assert.deepEqual(w.take(), [{ userId: USER, customPacketType: 'repairNotice', text: 'Your Steel Sword is badly worn (24%).' }])
  wear(0.1)
  await poll()
  assert.deepEqual(w.packets, [], 'said once')
  wear(0)
  w.mp.onItemBroken(PLAYER, SWORD)
  assert.deepEqual(w.take(), [{ userId: USER, customPacketType: 'repairNotice', text: 'Your Steel Sword has broken.' }])
  await poll()
  assert.deepEqual(w.packets, [], 'the poll does not repeat the native event')
  w.now += 60000
  wear(0.5)
  await poll()
  wear(0)
  await poll()
  assert.deepEqual(w.notices(), ['Your Steel Sword has broken.'], 'a native without the event is covered by the poll')
})

;(async () => {
  ({ DurabilitySystem, repairUnits, applyRepairs, materialsHeld, rowKey, native } = await load())
  Date.now = () => (clock ? clock.now : realNow())
  for (const run of pending) { clock = null; await run() }
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) console.log(String(err && err.stack ? err.stack : err).split('\n').map((l) => '     ' + l).join('\n'))
  }
  const failed = results.filter(([ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()
