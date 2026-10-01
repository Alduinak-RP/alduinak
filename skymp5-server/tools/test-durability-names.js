'use strict'

// The client's condition tags (skymp5-client sync/durabilityNames.ts, sync/inventory.ts, craftedExtrasService.ts, tradeService.ts) and repairService.ts against a stub of the engine's inventory: node tools/test-durability-names.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const client = path.join(__dirname, '..', '..', 'skymp5-client', 'src')

const PLAYER = 0x14
const SWORD = 0x13989
const CUIRASS = 0x13952
const RING = 0x3b97c
const STAFF = 0x29b77
const GOLD = 0xf
const TYPES = { Weapon: 41, Armor: 26, Misc: 32, Potion: 46, Ingredient: 30, Ammo: 42, Light: 31 }

const forms = new Map([
  [SWORD, { kind: 'weapon', name: 'Steel Sword', type: TYPES.Weapon, weaponType: 1 }],
  [STAFF, { kind: 'weapon', name: 'Staff of Sparks', type: TYPES.Weapon, weaponType: 8 }],
  [CUIRASS, { kind: 'armor', name: 'Steel Armor', type: TYPES.Armor, weightClass: 1, slotMask: 0x4 }],
  [RING, { kind: 'armor', name: 'Gold Ring', type: TYPES.Armor, weightClass: 2, slotMask: 0x40 }],
  [GOLD, { kind: 'misc', name: 'Gold', type: TYPES.Misc }],
])
const formOf = (id) => {
  const f = forms.get(id)
  return f && {
    getFormID: () => id, getName: () => f.name, getType: () => f.type, isPlayable: () => true, hasKeyword: () => false,
    getWeaponType: () => f.weaponType, getWeightClass: () => f.weightClass, getSlotMask: () => f.slotMask, kind: f.kind,
  }
}

// The engine's side: one extra list per copy or stack, told apart by name, tempering and worn state
const engine = { lists: [], calls: [], misses: 0, renames: [], rename: undefined, worn: [false, false] }
const reset = (lists, rename) => {
  engine.lists = lists.map((l) => ({ count: 1, ...l }))
  engine.calls = []
  engine.renames = []
  engine.misses = 0
  engine.rename = rename ? renameInPlace : undefined
}
function renameInPlace (refrId, baseId, from, to, worn, wornLeft) {
  engine.renames.push([baseId, from, to, worn, wornLeft])
  const list = engine.lists.find((l) => !l.loose && l.baseId === baseId && (l.name || '') === from && !!l.worn === worn && !!l.wornLeft === wornLeft)
  if (list) list.name = to
  return !!list
}
const names = (baseId) => engine.lists.filter((l) => l.baseId === baseId).map((l) => `${l.name}${l.worn ? ' worn' : ''}${l.count > 1 ? ' x' + l.count : ''}`).sort()

const platform = {
  FormType: TYPES,
  DxScanCode: { Escape: 1 },
  storage: {},
  printConsole: () => {},
  once: () => {},
  Game: { getFormEx: formOf },
  Weapon: { from: (f) => (f && f.kind === 'weapon' ? f : null) },
  Armor: { from: (f) => (f && f.kind === 'armor' ? f : null) },
  Ammo: { from: () => null },
  Actor: { from: () => ({ isEquipped: () => false, queueNiNodeUpdate: () => {} }) },
  Enchantment: { from: () => null },
  Potion: { from: () => null },
  Keyword: { getKeyword: () => null },
  getContainer: () => [],
  getExtraContainerChanges: () => {
    const byBase = new Map()
    for (const l of engine.lists) {
      const extras = []
      if (l.name !== undefined) extras.push({ type: 'TextDisplayData', name: l.name })
      if (l.health) extras.push({ type: 'Health', health: l.health })
      if (l.worn) extras.push({ type: 'Worn' })
      if (l.wornLeft) extras.push({ type: 'WornLeft' })
      if (l.count > 1) extras.push({ type: 'Count', count: l.count })
      const e = byBase.get(l.baseId) || { baseId: l.baseId, countDelta: 0, extendDataList: [] }
      e.countDelta += l.count
      if (!l.loose) e.extendDataList.push(extras)
      byBase.set(l.baseId, e)
    }
    return Array.from(byBase.values())
  },
  TESModPlatform: {
    resetContainer: () => {},
    pushWornState: (worn, wornLeft) => { engine.worn = [worn, wornLeft] },
    addItemEx: (refr, form, count, health, ench, maxCharge, removeOnUnequip, charge, name) => {
      const [worn, wornLeft] = engine.worn
      engine.worn = [false, false]
      const baseId = form.getFormID()
      engine.calls.push([count, name])
      // A copy without an extra list leaves under the form name, as applyInventory has always removed it
      const same = (l) => l.baseId === baseId && (l.loose ? count < 0 && name === form.getName() : l.name === name) && (l.health || 1) === health && !!l.worn === worn && !!l.wornLeft === wornLeft
      const list = engine.lists.find(same)
      if (count > 0) {
        if (list) list.count += count
        else engine.lists.push({ baseId, count, name, health: health > 1 ? health : undefined, worn, wornLeft })
        return
      }
      if (!list || list.count < -count) {
        engine.misses++
        return
      }
      list.count += count
      engine.lists = engine.lists.filter((l) => l.count > 0)
    },
  },
}
Object.defineProperty(platform, 'setInventoryItemName', { enumerable: true, get: () => engine.rename })
global.__durabilityTestPlatform = platform
const packets = global.__durabilityTestPackets = []
// What the repair service did to the browser and the periodic inventory apply
const ui = global.__durabilityTestUi = { calls: [], notices: [], applies: 0 }

const stubs = {
  name: 'stubs',
  setup (build) {
    const stub = (filter, contents) => {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }))
      build.onLoad({ filter, namespace: 'stub' }, () => ({ contents, loader: 'js' }))
    }
    stub(/^(skyrimPlatform|@skyrim-platform\/skyrim-platform)$/, 'module.exports = global.__durabilityTestPlatform')
    stub(/^\.\/remoteServer$/, 'exports.getPcInventory = () => undefined; exports.holdPcInventoryApply = () => {}; exports.requestPcInventoryApply = () => { global.__durabilityTestUi.applies++ }')
    stub(/^\.\/clientListener$/, 'exports.ClientListener = class {}')
    stub(/^\.\/customPacketUtil$/, 'exports.parseCustomPacket = (e) => JSON.parse(e.message.contentJsonDump); exports.notifyNextUpdate = (controller, sp, text) => global.__durabilityTestUi.notices.push(text); exports.sendCustomPacket = (controller, packet) => global.__durabilityTestPackets.push(packet)')
    stub(/^\.\/widgetMenuUtil$/, `exports.closeWidget = () => {}; exports.showUi = () => {}; exports.buttonEventKeyCode = (e) => e.code;
      exports.openFormMenu = (sp, setter, args) => global.__durabilityTestUi.calls.push(['open', args.info]);
      exports.refreshFormMenu = (sp, setter, args) => global.__durabilityTestUi.calls.push(['refresh', args.info]);
      exports.closeFormMenu = (sp, id) => global.__durabilityTestUi.calls.push(['close', id])`)
    stub(/worldViewMisc$/, 'exports.localIdToRemoteId = (id) => id')
  },
}

;(async () => {
  // One bundle, so the inventory code and the crafted extras report share the durability module's state
  const entry = path.join(__dirname, 'durability-names-entry.ts')
  const { outputFiles } = await esbuild.build({
    stdin: {
      contents: `export * as names from "./sync/durabilityNames"; export * as inventory from "./sync/inventory"; export { getCraftReport } from "./services/services/craftedExtrasService"; export { TradeService } from "./services/services/tradeService"; export { RepairService } from "./services/services/repairService";`,
      resolveDir: client, sourcefile: entry, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [stubs], logLevel: 'error',
  })
  const compiled = new Module(entry)
  compiled._compile(outputFiles[0].text, entry)
  const { names: d, inventory: inv, getCraftReport, TradeService, RepairService } = compiled.exports

  const player = { getFormID: () => PLAYER, getBaseObject: () => ({ getFormID: () => 7 }), removeAllItems: () => {} }
  const pass = (server, options) => d.applyDurabilityNames(player, { entries: server }, options)

  // Off until the server says so: no tag, no rename, no call, whatever the conditions are
  assert.equal(d.tagFor(0.5), '')
  assert.equal(d.durabilityName('Steel Sword', 0.5, formOf(SWORD)), 'Steel Sword')
  assert.equal(d.stripTag('Oathkeeper (50%)'), 'Oathkeeper (50%)', 'a name a player gave is not cut either')
  reset([{ baseId: SWORD, name: 'Steel Sword', worn: true }], true)
  inv.applyInventory(player, { entries: [{ baseId: SWORD, count: 1, condition: 0.5 }] }, false, true)
  pass([{ baseId: SWORD, count: 1, condition: 0.5 }])
  assert.deepEqual([engine.calls, engine.renames], [[], []], 'a server that sent no durabilityConfig leaves every name alone')
  reset([], true)
  inv.applyInventory(player, { entries: [{ baseId: SWORD, count: 1, condition: 0.5 }] }, false, true)
  assert.deepEqual(engine.calls, [[1, 'Steel Sword']], 'and an added copy gets the form name as before')

  assert.equal(d.setDurabilityConfig({ showAtFull: true, brokenLabel: 'Broken' }), true)
  assert.equal(d.setDurabilityConfig({ showAtFull: true, brokenLabel: 'Broken' }), false, 'the same config again changes nothing')

  // Tags: whole percent rounded down, 1% above broken, pristine shown, the label at 0
  assert.equal(d.tagFor(undefined), '(100%)')
  assert.equal(d.tagFor(1), '(100%)')
  assert.equal(d.tagFor(0.97), '(97%)')
  assert.equal(d.tagFor(0.5699999928474426), '(57%)', '0.57 as the float the server stores')
  assert.equal(d.tagFor(0.29), '(29%)')
  assert.equal(d.tagFor(0.9999), '(99%)')
  assert.equal(d.tagFor(0.004), '(1%)')
  assert.equal(d.tagFor(0), '(Broken)')
  assert.deepEqual(d.splitTag('Steel Sword (97%) (Fine)'), { base: 'Steel Sword', tag: '(97%)', suffix: ' (Fine)' })
  assert.deepEqual(d.splitTag('Steel Sword (Broken)'), { base: 'Steel Sword', tag: '(Broken)', suffix: '' })
  assert.deepEqual(d.splitTag('Steel Sword (Fine)'), { base: 'Steel Sword (Fine)', tag: '', suffix: '' })
  assert.equal(d.stripTag('Steel Sword (97%) (Fine)'), 'Steel Sword (Fine)')
  assert.equal(d.stripTag('Ring (Old)'), 'Ring (Old)')
  assert.equal(d.conditionOfName('Steel Sword (40%)'), 0.4)
  assert.equal(d.conditionOfName('Steel Sword (100%)'), undefined)
  assert.equal(d.conditionOfName('Steel Sword (Broken) (Epic)'), 0)

  // What wears: weapons but staffs, light and heavy armor; clothing, jewelry and the rest never get a tag
  assert.equal(d.durabilityName('Steel Sword', 0.97, formOf(SWORD)), 'Steel Sword (97%)')
  assert.equal(d.durabilityName('Steel Sword (12%)', undefined, formOf(SWORD)), 'Steel Sword (100%)', 'an old tag is replaced, never stacked')
  assert.equal(d.durabilityName('Steel Armor', 0, formOf(CUIRASS)), 'Steel Armor (Broken)')
  assert.equal(d.durabilityName('Gold Ring', 0.5, formOf(RING)), 'Gold Ring')
  assert.equal(d.durabilityName('Staff of Sparks', 0.5, formOf(STAFF)), 'Staff of Sparks')
  assert.equal(d.durabilityName('Gold', 0.5, formOf(GOLD)), 'Gold')

  // A new copy is added under its tag
  reset([], true)
  inv.applyInventory(player, { entries: [{ baseId: SWORD, count: 1, condition: 0.97 }, { baseId: GOLD, count: 5 }] }, false, true)
  assert.deepEqual(engine.calls, [[1, 'Steel Sword (97%)'], [5, 'Gold']])

  // Wear on the worn sword: no remove and add, one rename in place
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)', worn: true }], true)
  const worn93 = [{ baseId: SWORD, count: 1, condition: 0.93 }]
  inv.applyInventory(player, { entries: worn93 }, false, true)
  pass(worn93)
  assert.deepEqual(engine.calls, [], 'a condition change is no inventory difference')
  assert.deepEqual(engine.renames, [[SWORD, 'Steel Sword (97%)', 'Steel Sword (93%)', true, false]])
  pass(worn93)
  assert.equal(engine.renames.length, 1, 'and nothing more once the tag is right')

  // The quality the engine appended stays out of the new name, it comes back by itself
  reset([{ baseId: SWORD, name: 'Steel Sword (97%) (Fine)', health: 1.1, worn: true }], true)
  pass([{ baseId: SWORD, count: 1, health: 1.1, condition: 0.5 }])
  assert.deepEqual(engine.renames, [[SWORD, 'Steel Sword (97%) (Fine)', 'Steel Sword (50%)', true, false]])

  // A dll without the export: the worn copy keeps its old tag and is never taken off, an unworn copy goes out and in again
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)', worn: true }], false)
  pass(worn93)
  assert.deepEqual([engine.calls, names(SWORD)], [[], ['Steel Sword (97%) worn']])
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)' }], false)
  pass(worn93)
  assert.deepEqual(engine.calls, [[-1, 'Steel Sword (97%)'], [1, 'Steel Sword (93%)']])
  assert.deepEqual([names(SWORD), engine.misses], [['Steel Sword (93%)'], 0])
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)' }], false)
  pass(worn93, { reAdd: false })
  assert.deepEqual(engine.calls, [], 'not while a spawn outfit settles')

  // A copy the engine made itself (crafted, picked up) has no name yet: put in again under the tag
  reset([{ baseId: SWORD, loose: true }], true)
  pass([{ baseId: SWORD, count: 1 }])
  assert.deepEqual(engine.calls, [[-1, 'Steel Sword'], [1, 'Steel Sword (100%)']])

  // A dressed spawn piece has an extra list without a name, which the export names
  reset([{ baseId: CUIRASS, worn: true }], true)
  pass([{ baseId: CUIRASS, count: 1, condition: 0.62 }])
  assert.deepEqual([engine.renames, engine.calls], [[[CUIRASS, '', 'Steel Armor (62%)', true, false]], []])

  // Of two swords at the same tag the changed one is the worn one
  reset([{ baseId: SWORD, name: 'Steel Sword (100%)' }, { baseId: SWORD, name: 'Steel Sword (100%)', worn: true }], true)
  pass([{ baseId: SWORD, count: 1, condition: 0.93 }, { baseId: SWORD, count: 1 }])
  assert.deepEqual(names(SWORD), ['Steel Sword (100%)', 'Steel Sword (93%) worn'])

  // A repair of the spare leaves the worn one alone
  reset([{ baseId: SWORD, name: 'Steel Sword (40%)' }, { baseId: SWORD, name: 'Steel Sword (93%)', worn: true }], true)
  pass([{ baseId: SWORD, count: 1, condition: 0.93 }, { baseId: SWORD, count: 1 }])
  assert.deepEqual(names(SWORD), ['Steel Sword (100%)', 'Steel Sword (93%) worn'])

  // Two worn copies each take the nearest new tag
  reset([{ baseId: SWORD, name: 'Steel Sword (80%)', worn: true }, { baseId: SWORD, name: 'Steel Sword (60%)', wornLeft: true }], true)
  pass([{ baseId: SWORD, count: 1, condition: 0.59 }, { baseId: SWORD, count: 1, condition: 0.79 }])
  assert.deepEqual(engine.lists.map((l) => l.name), ['Steel Sword (79%)', 'Steel Sword (59%)'])

  // A tag never crosses from the tempered copy to the plain one
  reset([{ baseId: SWORD, name: 'Steel Sword (100%)', health: 1.2 }, { baseId: SWORD, name: 'Steel Sword (100%)', worn: true }], true)
  pass([{ baseId: SWORD, count: 1, health: 1.2, condition: 0.4 }, { baseId: SWORD, count: 1 }])
  assert.deepEqual(engine.lists.map((l) => [l.name, l.health]), [['Steel Sword (40%)', 1.2], ['Steel Sword (100%)', undefined]])
  assert.equal(engine.renames.length, 1)

  // Two copies in one stack: only one of them changed, so it leaves the stack instead of the stack being renamed
  reset([{ baseId: SWORD, name: 'Steel Sword (100%)', count: 2 }], true)
  pass([{ baseId: SWORD, count: 1 }, { baseId: SWORD, count: 1, condition: 0.5 }])
  assert.deepEqual([engine.renames, names(SWORD)], [[], ['Steel Sword (100%)', 'Steel Sword (50%)']])
  // both changed to the same tag: the stack is renamed as one
  reset([{ baseId: SWORD, name: 'Steel Sword (90%)', count: 2 }], true)
  pass([{ baseId: SWORD, count: 2 }])
  assert.deepEqual([engine.calls, names(SWORD)], [[], ['Steel Sword (100%) x2']])

  // A base the apply of the same update still changes waits
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)', worn: true }], true)
  pass(worn93, { skipBaseIds: new Set([SWORD]) })
  assert.deepEqual(engine.renames, [])

  // The server took one of two copies: the apply removes the one whose tag is gone, by its own name
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)' }, { baseId: SWORD, name: 'Steel Sword (40%)' }], true)
  inv.applyInventory(player, { entries: [{ baseId: SWORD, count: 1, condition: 0.97 }] }, false, true)
  assert.deepEqual([engine.calls, engine.misses, names(SWORD)], [[[-1, 'Steel Sword (40%)']], 0, ['Steel Sword (97%)']])
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)' }, { baseId: SWORD, name: 'Steel Sword (40%)' }], true)
  inv.applyInventory(player, { entries: [] }, false, true)
  assert.deepEqual([engine.misses, names(SWORD)], [0, []], 'and both go under their own names')

  // A drop tells the server which copy: the tag read off the dropped reference, else the tag the pack lost
  const server2 = { entries: [{ baseId: SWORD, count: 1, condition: 0.97 }, { baseId: SWORD, count: 1, condition: 0.4 }] }
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)' }], true)
  assert.equal(d.droppedName(player, server2, SWORD, 1, 'Steel Sword (40%) (Fine)'), 'Steel Sword (40%)')
  assert.equal(d.droppedName(player, server2, SWORD, 1, 'Steel Sword'), 'Steel Sword (40%)')
  assert.equal(d.droppedName(player, server2, GOLD, 1, 'Gold'), undefined)
  reset([], true)
  assert.equal(d.droppedName(player, server2, SWORD, 1, ''), undefined, 'two tags gone for one drop: no guess')

  // A container move names the copy that went or came
  reset([{ baseId: SWORD, name: 'Steel Sword (97%)' }, { baseId: SWORD, name: 'Steel Sword (40%)' }], true)
  d.noteCopies(player)
  engine.lists.shift()
  assert.deepEqual(d.movedNames(player, { baseId: SWORD, count: 1, name: 'Steel Sword (40%)' }, true), ['Steel Sword (97%)'], 'the put copy, not the one the merged entry is named after')
  d.noteCopies(player)
  engine.lists.push({ baseId: SWORD, count: 1, name: 'Steel Sword (12%)' }, { baseId: SWORD, count: 1, name: 'Steel Sword (100%)' })
  assert.deepEqual(d.movedNames(player, { baseId: SWORD, count: -2, name: 'Steel Sword (40%)' }, false), ['Steel Sword (12%)', 'Steel Sword (100%)'])
  assert.equal(d.movedNames(player, { baseId: SWORD, count: -1 }, false), undefined, 'a count that does not add up is left to the old message')
  assert.equal(d.movedNames(player, { baseId: GOLD, count: 5 }, true), undefined)

  // A crafted extras report: the tag is not part of the name, and the copy the server claims is the one at the tempered copy's tag
  const report = getCraftReport(
    { entries: [{ baseId: SWORD, count: 1, condition: 0.97 }, { baseId: SWORD, count: 1, condition: 0.4 }] },
    { entries: [{ baseId: SWORD, count: 1, name: 'Steel Sword (97%)' }, { baseId: SWORD, count: 1, name: 'Steel Sword (40%) (Fine)', health: 1.1 }] })
  assert.deepEqual(report.gained, [{ baseId: SWORD, count: 1, name: 'Steel Sword (Fine)', health: 1.1 }])
  assert.deepEqual(report.lost, [{ baseId: SWORD, count: 1, condition: 0.4 }])
  const tempered97 = getCraftReport(
    { entries: [{ baseId: SWORD, count: 1, condition: 0.97 }, { baseId: SWORD, count: 1, condition: 0.4 }] },
    { entries: [{ baseId: SWORD, count: 1, name: 'Steel Sword (40%)' }, { baseId: SWORD, count: 1, name: 'Steel Sword (97%) (Fine)', health: 1.1 }] })
  assert.deepEqual(tempered97.lost, [{ baseId: SWORD, count: 1, condition: 0.97 }])

  // The trade window: one row per condition, the tag beside the name, the hint in the offer and the partner's true value
  {
    const handlers = {}
    const updates = []
    let widgets = []
    const window = { skyrimPlatform: { widgets: { get: () => widgets, set: (w) => { widgets = w } } } }
    const sp = {
      Game: { getPlayer: () => player, getFormEx: formOf }, Weapon: platform.Weapon, Potion: platform.Potion,
      browser: { executeJavaScript: (text) => new Function('window', text)(window), setVisible: () => {}, setFocused: () => {} },
    }
    const controller = {
      on: (name, fn) => { handlers[name] = fn }, once: (name, fn) => updates.push(fn),
      emitter: { on: (name, fn) => { handlers[name] = fn }, emit: () => {} },
    }
    const service = new TradeService(sp, controller)
    assert.ok(service)
    const state = (myOffer, theirOffer, mySeq) => {
      handlers.customPacketMessage({ message: { contentJsonDump: JSON.stringify({ customPacketType: 'tradeState', partnerName: 'Brynjolf', myOffer, theirOffer, mySeq }) } })
      updates.splice(0).forEach((fn) => fn())
      return widgets.find((w) => w.type === 'trade')
    }
    const rows = (list) => list.map((r) => `${r.name} x${r.count} [${(r.tags || []).join(', ')}]${r.equipped ? ' equipped' : ''}`)
    reset([{ baseId: SWORD, name: 'Steel Sword (97%)', worn: true }, { baseId: SWORD, name: 'Steel Sword (40%)' }, { baseId: SWORD, name: 'Steel Sword (40%) (Fine)', health: 1.1 }, { baseId: RING, name: 'Gold Ring' }], true)
    let widget = state([], [{ baseId: SWORD, count: 1, condition: 0.6312 }, { baseId: CUIRASS, count: 1 }], 0)
    assert.deepEqual(rows(widget.inventory), ['Gold Ring x1 []', 'Steel Sword x1 [97%] equipped', 'Steel Sword x1 [40%]', 'Steel Sword (Fine) x1 [Fine, 40%]'])
    assert.deepEqual(rows(widget.theirOffer), ['Steel Sword x1 [63%]', 'Steel Armor x1 [100%]'])
    const worn40 = widget.inventory.find((r) => r.tags && r.tags[0] === '40%')
    handlers.browserMessage({ arguments: ['trade:add', worn40.lineId, 1] })
    updates.splice(0).forEach((fn) => fn())
    assert.deepEqual(packets.at(-1), { customPacketType: 'tradeSetOffer', items: [{ baseId: SWORD, count: 1, condition: 0.4 }], seq: 1 }, 'the offer names the 40% copy and no tagged name')
    // The server answers with the copy it drew, at its own value
    widget = state([{ baseId: SWORD, count: 1, condition: 0.4012 }], [], 1)
    assert.deepEqual(rows(widget.myOffer), ['Steel Sword x1 [40%]'])
    assert.deepEqual(rows(widget.inventory), ['Gold Ring x1 []', 'Steel Sword x1 [97%] equipped', 'Steel Sword (Fine) x1 [Fine, 40%]'])
    // A server that merges the rows of a line into one: the pack shows neither copy as still on offer
    widget = state([{ baseId: SWORD, count: 2, condition: 0.97 }], [], 1)
    assert.deepEqual(rows(widget.inventory), ['Gold Ring x1 []', 'Steel Sword (Fine) x1 [Fine, 40%]'])
    // A lock the server answers by wiping the offer: the offered row is sent again although its copy now shows another percent
    reset([{ baseId: SWORD, name: 'Steel Sword (39%)' }], true)
    widget = state([{ baseId: SWORD, count: 1, condition: 0.4012 }], [], 1)
    handlers.browserMessage({ arguments: ['trade:lock'] })
    state([], [], 1)
    assert.deepEqual(packets.at(-1).items, [{ baseId: SWORD, count: 1, condition: 0.4012 }], 'the server draws the nearest copy')
    // A name on something that never wears is the player's own, percent sign or not
    reset([{ baseId: RING, name: 'Lucky Band (50%)' }], true)
    widget = state([], [], 2)
    assert.deepEqual(rows(widget.inventory), ['Lucky Band (50%) x1 []'])
    handlers.browserMessage({ arguments: ['trade:add', widget.inventory[0].lineId, 1] })
    updates.splice(0).forEach((fn) => fn())
    assert.deepEqual(packets.at(-1).items, [{ baseId: RING, count: 1, name: 'Lucky Band (50%)' }])
  }

  // Another label and no tag on pristine gear; a tag under the old label still parses
  assert.equal(d.setDurabilityConfig({ showAtFull: false, brokenLabel: 'Ruined' }), true)
  assert.equal(d.tagFor(undefined), '')
  assert.equal(d.tagFor(0), '(Ruined)')
  reset([{ baseId: SWORD, name: 'Steel Sword (Broken)', worn: true }, { baseId: CUIRASS, name: 'Steel Armor (100%)', worn: true }], true)
  pass([{ baseId: SWORD, count: 1, condition: 0 }, { baseId: CUIRASS, count: 1 }])
  assert.deepEqual([names(SWORD), names(CUIRASS)], [['Steel Sword (Ruined) worn'], ['Steel Armor worn']])

  // Durability switched off after tags were written: they come off, and new copies are plain again
  assert.equal(d.setDurabilityConfig(null), true)
  reset([{ baseId: SWORD, name: 'Steel Sword (93%)', worn: true }, { baseId: SWORD, name: 'Steel Sword (40%)' }], true)
  pass([{ baseId: SWORD, count: 1, condition: 0.93 }, { baseId: SWORD, count: 1, condition: 0.4 }])
  assert.deepEqual(names(SWORD), ['Steel Sword', 'Steel Sword worn'])
  assert.equal(d.durabilityName('Steel Sword', 0.5, formOf(SWORD)), 'Steel Sword')

  // The repair service: the server's word switches the tags on, the menu mirrors its packet and the buttons go back as packets
  {
    const handlers = {}
    const controller = { on: (name, fn) => { handlers[name] = fn }, once: () => {}, emitter: { on: (name, fn) => { handlers[name] = fn }, emit: () => {} } }
    const sent = packets.length
    assert.ok(new RepairService({}, controller))
    const packet = (content) => handlers.customPacketMessage({ message: { contentJsonDump: JSON.stringify(content) } })
    const browser = (...args) => handlers.browserMessage({ arguments: args })
    handlers.connectionAccepted({})
    browser('repairMenu:repair', 'k1')
    assert.deepEqual([packets.length, ui.calls, d.getDurabilityConfig().enabled], [sent, [], false], 'a server without durability: nothing sent, nothing opened, no tags')

    const applies = ui.applies
    packet({ customPacketType: 'durabilityConfig', showAtFull: true, brokenLabel: 'Broken' })
    assert.deepEqual(d.getDurabilityConfig(), { enabled: true, showAtFull: true, brokenLabel: 'Broken' })
    assert.equal(ui.applies, applies + 1, 'the names are brought in line at once')
    packet({ customPacketType: 'durabilityConfig', showAtFull: true, brokenLabel: 'Broken' })
    assert.equal(ui.applies, applies + 1)
    assert.equal(d.tagFor(0.5), '(50%)')

    const row = { key: 'k1', baseId: SWORD, name: 'Steel Sword', percent: 43, hp: 150, maxHp: 350, worn: true, cost: [{ baseId: 0x5ace5, name: 'Steel Ingot', need: 2, have: 1 }] }
    packet({ customPacketType: 'repairMenu', reason: 'refresh', bench: 0x1234, kind: 'weapon', rows: [row] })
    assert.deepEqual(ui.calls, [], 'a refresh never opens a closed menu')
    packet({ customPacketType: 'repairMenu', reason: 'open', bench: 0x1234, kind: 'weapon', title: 'Grindstone: repair weapons', rows: [row, { key: 7 }] })
    assert.equal(ui.calls.length, 1)
    assert.deepEqual(ui.calls[0], ['open', { bench: 0x1234, kind: 'weapon', title: 'Grindstone: repair weapons', rows: [row, { key: 7, baseId: 0, name: '', percent: 0, hp: 0, maxHp: 0, worn: false, cost: [] }] }])
    packet({ customPacketType: 'repairMenu', reason: 'refresh', bench: 0x1234, kind: 'weapon', rows: [] })
    assert.deepEqual(ui.calls[1], ['refresh', { bench: 0x1234, kind: 'weapon', title: '', rows: [] }], 'an open menu is refreshed without taking the focus again')

    browser('repairMenu:repair', 'k1')
    assert.deepEqual(packets.at(-1), { customPacketType: 'durabilityRepair', bench: 0x1234, keys: ['k1'] })
    browser('repairMenu:repair', 7)
    assert.deepEqual(packets.at(-1), { customPacketType: 'durabilityRepair', bench: 0x1234, keys: [7] })
    browser('repairMenu:repairAll')
    assert.deepEqual(packets.at(-1), { customPacketType: 'durabilityRepair', bench: 0x1234, all: true })
    browser('repairMenu:improve')
    assert.deepEqual([ui.calls.at(-1), packets.at(-1)], [['close', 42], { customPacketType: 'durabilityImprove', bench: 0x1234 }], 'the browser steps aside for the vanilla bench')
    const afterImprove = packets.length
    browser('repairMenu:repairAll')
    assert.equal(packets.length, afterImprove, 'a closed menu sends nothing')

    packet({ customPacketType: 'repairMenu', bench: 0x1234, kind: 'armor', rows: [row] })
    assert.equal(ui.calls.at(-1)[0], 'open', 'a packet without a reason opens')
    handlers.buttonEvent({ isDown: true, code: 1 })
    assert.deepEqual([ui.calls.at(-1), packets.at(-1)], [['close', 42], { customPacketType: 'durabilityClose' }])
    packet({ customPacketType: 'repairNotice', text: 'Your Steel Sword is badly worn (24%)' })
    assert.deepEqual(ui.notices, ['Your Steel Sword is badly worn (24%)'])

    // The next server may have no durability
    handlers.connectionAccepted({})
    assert.equal(d.tagFor(0.5), '')
  }

  console.log('test-durability-names: all passed')
})().catch((e) => { console.error(e); process.exit(1) })
