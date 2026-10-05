'use strict'

// Block stamina by worn armor weight (rebalance D19): the rule read from alduinakDamageFormulaSettings, the plan's table, the native
// getCombatStats adapter, the weight kept per player until an equipment report and the unchanged cost without the block: node tools/test-block-stamina.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const systemsDir = path.join(__dirname, '..', 'ts', 'systems')
// One bundle, so the test reaches the Settings the system reads
const { outputFiles } = esbuild.buildSync({
  stdin: { contents: "export * from './needsSystem'; export * from './combatStats'; export { Settings } from '../settings';", resolveDir: systemsDir, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error',
})
const source = path.join(systemsDir, 'needsSystem.ts')
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(systemsDir)
compiled._compile(outputFiles[0].text, source)
const { NeedsSystem, Settings, blockWeightRule, blockWeightMult, hasCombatStats, combatStats, armorWeightOf } = compiled.exports

const design = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'misc', 'combat-settings', 'design.json'), 'utf8'))

const BLOCKER = 0xff000001
const NPC = 0x000a2c8e
const ATTACKER = 0xff000002
const SWORD = 0x13989
const SHIELD = 0x12eb6
const WARD = 0x13018
const USER = 3
const OTHER_BODY = 0xff000003
const DEFAULT_RULE = { perWeight: 0.006, cap: 115 }
const ENABLED = { enabled: true, blockStamina: { perArmorWeight: 0.006, weightCap: 115 } }

const desc = (id) => id.toString(16)
const TYPES = { [SWORD]: 'WEAP', [SHIELD]: 'ARMO', [WARD]: 'SPEL' }

// native: undefined leaves getCombatStats out, as an older scam_native.node does
const makeMp = (native, stamina = 1) => {
  const props = new Map()
  const packets = []
  const calls = []
  for (const id of [BLOCKER, NPC]) {
    props.set(`${id}:type`, 'MpActor')
    props.set(`${id}:isDead`, false)
    props.set(`${id}:percentages`, { health: 1, magicka: 1, stamina })
  }
  const mp = {
    props,
    packets,
    calls,
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    sendCustomPacket: (userId, text) => { packets.push([userId, JSON.parse(text)]) },
    lookupEspmRecordById: (id) => ({ record: TYPES[id] ? { type: TYPES[id] } : undefined }),
    getIdFromDesc: (d) => parseInt(d, 16),
    getDescFromId: desc,
    isConnected: () => true,
    getUserByActor: (id) => (id === BLOCKER ? USER : -1),
  }
  if (native) mp.getCombatStats = (actorId) => { calls.push(actorId >>> 0); return native(actorId >>> 0) }
  return mp
}

const tick = () => new Promise((r) => setImmediate(r))
const near = (actual, expected, what, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${what}: ${actual} != ${expected}`)

// A NeedsSystem with only the block hook installed; warrior names the actors holding the profession
const setup = ({ rule = null, native, stamina = 1, warrior = [], cost = 0.1, warriorCost = 0.05, stagger = 0.5 } = {}) => {
  const logs = []
  const mastery = { rankOf: (_ctx, id, p) => (p === 'warrior' && warrior.includes(id) ? 2 : 0) }
  const sys = new NeedsSystem((line) => logs.push(String(line)), mastery)
  const mp = makeMp(native, stamina)
  const listeners = {}
  const ctx = { svr: mp, gm: { on: (event, fn) => { (listeners[event] ||= []).push(fn) }, emit: () => {} } }
  sys.installBlockStamina(ctx, cost, warriorCost, stagger, rule)
  const hit = async (target = BLOCKER, src = SWORD, blocked = true) => {
    mp['onPapyrusEvent:OnHit'](target, { type: 'form', desc: desc(ATTACKER) }, { type: 'espm', desc: desc(src) }, null, false, false, false, blocked)
    await tick()
  }
  // The client's equipment report, as the native fires it after applying the change
  const equip = (id = BLOCKER) => mp.onUpdateEquipmentAttempt(id, { inv: { entries: [] }, numChanges: 1 }, true)
  const assign = (userId, actorId) => (listeners.userAssignActor || []).forEach((fn) => fn(userId, actorId))
  const staminaOf = (id = BLOCKER) => mp.get(id, 'percentages').stamina
  return { sys, mp, ctx, logs, hit, equip, assign, staminaOf }
}

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
  await test('the rule exists only while alduinakDamageFormulaSettings.enabled is true', () => {
    assert.equal(blockWeightRule(undefined), null)
    assert.equal(blockWeightRule(null), null)
    assert.equal(blockWeightRule('on'), null)
    assert.equal(blockWeightRule({}), null)
    assert.equal(blockWeightRule({ enabled: false, blockStamina: { perArmorWeight: 0.006, weightCap: 115 } }), null)
    assert.equal(blockWeightRule({ enabled: false, durability: { enabled: true } }), null)
    assert.equal(blockWeightRule({ enabled: 'true' }), null)
    assert.equal(blockWeightRule({ enabled: 1 }), null)
    assert.deepEqual(blockWeightRule({ enabled: true }), DEFAULT_RULE)
    assert.deepEqual(blockWeightRule(ENABLED), DEFAULT_RULE)
  })

  await test('the generator design carries the same numbers as the defaults', () => {
    assert.deepEqual(blockWeightRule({ enabled: true, blockStamina: design.blockStamina }), DEFAULT_RULE)
    assert.equal(design.blockStamina.base, 0.1)
    assert.equal(design.blockStamina.warrior, 0.05)
  })

  await test('perArmorWeight 0 turns the rule off, an absent value takes the default', () => {
    const problems = []
    const rule = (blockStamina) => blockWeightRule({ enabled: true, blockStamina }, (text) => problems.push(text))
    assert.equal(rule({ perArmorWeight: 0 }), null)
    assert.deepEqual(rule({ perArmorWeight: 0.01, weightCap: 90 }), { perWeight: 0.01, cap: 90 })
    assert.deepEqual(rule({ weightCap: 0 }), { perWeight: 0.006, cap: 0 })
    assert.deepEqual(rule({ perArmorWeight: 0.01 }), { perWeight: 0.01, cap: 115 })
    assert.deepEqual(rule({}), DEFAULT_RULE)
    // The native reads a null object as absent
    assert.deepEqual(rule(null), DEFAULT_RULE)
    assert.deepEqual(problems, [])
  })

  await test('a value the native rejects the block for switches the rule off and is named', () => {
    const cases = [
      [{ perArmorWeight: '0' }, ['blockStamina.perArmorWeight should be a number from 0 to 1000000, found "0"']],
      [{ perArmorWeight: -1 }, ['blockStamina.perArmorWeight should be a number from 0 to 1000000, found -1']],
      [{ perArmorWeight: null }, ['blockStamina.perArmorWeight should be a number from 0 to 1000000, found null']],
      [{ perArmorWeight: 0.006, weightCap: 'x' }, ['blockStamina.weightCap should be a number from 0 to 1000000, found "x"']],
      [{ weightCap: 2000000 }, ['blockStamina.weightCap should be a number from 0 to 1000000, found 2000000']],
      [{ perArmorWeight: true, weightCap: -5 }, ['blockStamina.perArmorWeight should be a number from 0 to 1000000, found true',
        'blockStamina.weightCap should be a number from 0 to 1000000, found -5']],
      // A bad cap is named even when perArmorWeight 0 switches the rule off anyway
      [{ perArmorWeight: 0, weightCap: 'x' }, ['blockStamina.weightCap should be a number from 0 to 1000000, found "x"']],
      ['heavy', ['blockStamina should be an object, found "heavy"']],
      [[0.006, 115], ['blockStamina should be an object, found [0.006,115]']],
      [0.006, ['blockStamina should be an object, found 0.006']],
    ]
    for (const [blockStamina, expected] of cases) {
      const problems = []
      assert.equal(blockWeightRule({ enabled: true, blockStamina }, (text) => problems.push(text)), null, JSON.stringify(blockStamina))
      assert.deepEqual(problems, expected)
      // Without a listener the answer is the same
      assert.equal(blockWeightRule({ enabled: true, blockStamina }), null)
    }
    // A block that is off is never read
    const problems = []
    assert.equal(blockWeightRule({ enabled: false, blockStamina: 'heavy' }, (text) => problems.push(text)), null)
    assert.deepEqual(problems, [])
  })

  await test('the multiplier gives the plan table: cost x, blocks from full and Warrior blocks', () => {
    // set, weight, cost x, blocks from full, Warrior blocks (plan (d), D19)
    const table = [['Unarmored', 0, 1.00, 10.0, 20.0], ['Elven', 7, 1.04, 9.6, 19.2], ['Glass', 13, 1.08, 9.3, 18.6],
      ['Steel', 52, 1.31, 7.6, 15.2], ['Daedric', 81, 1.49, 6.7, 13.5], ['Orcish', 85, 1.51, 6.6, 13.2]]
    for (const [set, weight, mult, blocks, warriorBlocks] of table) {
      const m = blockWeightMult(DEFAULT_RULE, weight)
      near(m, 1 + 0.006 * weight, `${set} multiplier`)
      assert.equal(m.toFixed(2), mult.toFixed(2), `${set} cost x`)
      assert.equal((1 / (0.1 * m)).toFixed(1), blocks.toFixed(1), `${set} blocks`)
      assert.equal((1 / (0.05 * m)).toFixed(1), warriorBlocks.toFixed(1), `${set} Warrior blocks`)
    }
    near(blockWeightMult(DEFAULT_RULE, 115), 1.69, 'at the cap')
    near(blockWeightMult(DEFAULT_RULE, 300), 1.69, 'above the cap')
    assert.equal(blockWeightMult(DEFAULT_RULE, -5), 1)
    near(blockWeightMult({ perWeight: 0.01, cap: 115 }, 81), 1.81, 'D19 alternative 0.01')
  })

  await test('the adapter reads the native object and survives a missing, failing or empty native', () => {
    assert.equal(hasCombatStats({}), false)
    assert.equal(hasCombatStats(null), false)
    assert.equal(hasCombatStats({ getCombatStats: 5 }), false)
    assert.equal(hasCombatStats({ getCombatStats: () => null }), true)
    assert.equal(combatStats({}, BLOCKER), null)
    assert.equal(combatStats({ getCombatStats: () => null }, BLOCKER), null)
    assert.equal(combatStats({ getCombatStats: () => undefined }, BLOCKER), null)
    assert.equal(combatStats({ getCombatStats: () => 7 }, BLOCKER), null)
    assert.equal(combatStats({ getCombatStats: () => { throw new Error('no actor') } }, BLOCKER), null)
    const seen = []
    assert.deepEqual(combatStats({ getCombatStats: (id) => { seen.push(id); return { armorWeight: 52 } } }, BLOCKER), { armorWeight: 52 })
    assert.deepEqual(seen, [BLOCKER])
    assert.equal(armorWeightOf({ armorWeight: 52, wornArmorWeight: 1 }), 52)
    assert.equal(armorWeightOf({ wornArmorWeight: 81 }), 81)
    assert.equal(armorWeightOf({ wornWeight: 7 }), 7)
    assert.equal(armorWeightOf({ armorWeight: 0 }), 0)
    assert.equal(armorWeightOf({ armorWeight: '52' }), null)
    assert.equal(armorWeightOf({ armorWeight: NaN }), null)
    assert.equal(armorWeightOf({ armorWeight: -3 }), null)
    assert.equal(armorWeightOf({ pieces: [] }), null)
  })

  await test('without the rule a block costs exactly today\'s share and the native is never asked', async () => {
    const t = setup({ rule: null, native: () => ({ armorWeight: 81 }) })
    await t.hit()
    assert.equal(t.staminaOf(), 1 - 0.1)
    await t.hit(BLOCKER, SHIELD)
    assert.equal(t.staminaOf(), 1 - 0.1 - 0.1)
    assert.deepEqual(t.mp.calls, [])
    assert.deepEqual(t.logs, [])
    assert.equal(t.mp.onUpdateEquipmentAttempt, undefined)
    const w = setup({ rule: null, native: () => ({ armorWeight: 81 }), warrior: [BLOCKER] })
    await w.hit()
    assert.equal(w.staminaOf(), 1 - 0.05)
  })

  await test('with the rule a Steel set costs x1.312, a warrior half of it, and the line names the numbers', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 52 }) })
    assert.equal(t.logs.length, 1)
    assert.match(t.logs[0], /block stamina by armor weight: a block costs x \(1 \+ 0\.006 x worn armor weight, counted up to 115\)/)
    await t.hit()
    near(t.staminaOf(), 1 - 0.1312, 'Steel block')
    assert.deepEqual(t.mp.calls, [BLOCKER])
    assert.match(t.logs[1], /ff000001 blocked in 52 armor weight: stamina -13\.1% \(10% x1\.312\)/)
    const w = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 52 }), warrior: [BLOCKER] })
    await w.hit()
    near(w.staminaOf(), 1 - 0.0656, 'Steel warrior block')
  })

  await test('a Daedric set gets 6 full blocks from full stamina where the base cost gives 10', async () => {
    const count = async (rule) => {
      const t = setup({ rule, native: () => ({ armorWeight: 81 }), stagger: 0 })
      let blocks = 0
      for (let i = 0; i < 30; i++) {
        const before = t.staminaOf()
        await t.hit()
        // A block that could be paid in full
        if (before - t.staminaOf() > 0.0999 && before >= (rule ? 0.1486 : 0.1) - 1e-9) blocks++
      }
      return [blocks, t.staminaOf()]
    }
    assert.deepEqual(await count(DEFAULT_RULE), [6, 0])
    const [base] = await count(null)
    assert.ok(base === 9 || base === 10, `base blocks ${base}`)
  })

  await test('an unarmored blocker and weight 0 pay the base share with no line', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 0 }) })
    await t.hit()
    assert.equal(t.staminaOf(), 1 - 0.1)
    assert.equal(t.logs.length, 1)
  })

  await test('weight above the cap counts as 115', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 240 }) })
    await t.hit()
    near(t.staminaOf(), 1 - 0.169, 'capped block')
  })

  await test('an NPC blocker is priced by its own worn weight', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: (id) => ({ armorWeight: id === NPC ? 85 : 7 }) })
    await t.hit(NPC)
    near(t.staminaOf(NPC), 1 - 0.151, 'NPC block')
    assert.equal(t.staminaOf(BLOCKER), 1)
    assert.deepEqual(t.mp.calls, [NPC])
  })

  await test('a native without getCombatStats switches the rule off with one line and blocks cost the base share', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: undefined })
    assert.equal(t.logs.length, 1)
    assert.match(t.logs[0], /block stamina by armor weight is off: this scam_native\.node has no getCombatStats/)
    await t.hit()
    await t.hit()
    assert.equal(t.staminaOf(), 1 - 0.1 - 0.1)
    assert.equal(t.logs.length, 1)
  })

  await test('a native that throws leaves the base share and says why once', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => { throw new Error('actorFormId should be a number') } })
    await t.hit()
    await t.hit()
    await t.hit(NPC)
    assert.equal(t.staminaOf(), 1 - 0.1 - 0.1)
    assert.equal(t.staminaOf(NPC), 1 - 0.1)
    assert.deepEqual(t.logs.slice(1), ['[needs] getCombatStats of ff000001 failed: Error: actorFormId should be a number, blocks cost their base share'])
    // A failed read is asked again on the next block
    assert.deepEqual(t.mp.calls, [BLOCKER, BLOCKER, NPC])
  })

  await test('a native that has no stats for the blocker leaves the base share and says so once', async () => {
    for (const nothing of [null, undefined, 7]) {
      const t = setup({ rule: DEFAULT_RULE, native: () => nothing })
      await t.hit()
      await t.hit()
      await t.hit(NPC)
      assert.equal(t.staminaOf(), 1 - 0.1 - 0.1)
      assert.equal(t.logs.length, 2)
      assert.match(t.logs[1], /^\[needs\] getCombatStats has no stats for ff000001 \(the native gives none while it prices hits without the rebalance formula, .*\), blocks cost their base share$/)
    }
  })

  await test('each reason is logged once and a later weighted block still logs its own line', async () => {
    let answer = () => null
    const t = setup({ rule: DEFAULT_RULE, native: () => answer() })
    // Each new answer follows an equipment report, which drops the kept weight
    const next = (fn) => { answer = fn; t.equip() }
    await t.hit()
    next(() => { throw new Error('gone') })
    await t.hit()
    next(() => ({ wornDT: 3 }))
    await t.hit()
    next(() => null)
    await t.hit()
    next(() => ({ armorWeight: 52 }))
    await t.hit()
    assert.equal(t.logs.length, 5)
    assert.match(t.logs[1], /has no stats for ff000001/)
    assert.match(t.logs[2], /getCombatStats of ff000001 failed: Error: gone/)
    assert.match(t.logs[3], /carries no armor weight \(fields wornDT\)/)
    assert.match(t.logs[4], /blocked in 52 armor weight/)
    near(t.staminaOf(), 1 - 0.4 - 0.1312, 'four base blocks and a Steel one')
  })

  await test('a player\'s weight is read once and kept until their next equipment report', async () => {
    let weight = 52
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: weight }) })
    await t.hit()
    await t.hit()
    assert.deepEqual(t.mp.calls, [BLOCKER])
    weight = 81
    await t.hit()
    near(t.staminaOf(), 1 - 3 * 0.1312, 'three Steel blocks')
    // A report for someone else keeps it
    t.equip(NPC)
    await t.hit()
    assert.deepEqual(t.mp.calls, [BLOCKER])
    t.equip()
    await t.hit()
    assert.deepEqual(t.mp.calls, [BLOCKER, BLOCKER])
    near(t.staminaOf(), 1 - 4 * 0.1312 - 0.1486, 'then a Daedric block')
    assert.match(t.logs[t.logs.length - 1], /ff000001 blocked in 81 armor weight/)
  })

  await test('a character switch or a disconnect of the player drops the kept weight, another user\'s keeps it', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 52 }) })
    await t.hit()
    t.assign(USER + 1, OTHER_BODY)
    t.sys.disconnect(USER + 1, t.ctx)
    await t.hit()
    assert.deepEqual(t.mp.calls, [BLOCKER])
    t.assign(USER, OTHER_BODY)
    await t.hit()
    assert.deepEqual(t.mp.calls, [BLOCKER, BLOCKER])
    t.sys.disconnect(USER, t.ctx)
    await t.hit()
    assert.deepEqual(t.mp.calls, [BLOCKER, BLOCKER, BLOCKER])
    near(t.staminaOf(), 1 - 4 * 0.1312, 'four Steel blocks')
  })

  await test('an NPC blocker, which sends no equipment reports, is read on every block', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 85 }) })
    await t.hit(NPC)
    await t.hit(NPC)
    assert.deepEqual(t.mp.calls, [NPC, NPC])
    near(t.staminaOf(NPC), 1 - 2 * 0.151, 'two Orcish blocks')
  })

  await test('stats without a weight field keep the base share and say so once', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ wornDT: 9.75, pieces: [] }) })
    await t.hit()
    await t.hit()
    assert.equal(t.staminaOf(), 1 - 0.1 - 0.1)
    assert.equal(t.logs.length, 2)
    assert.match(t.logs[1], /getCombatStats of ff000001 carries no armor weight \(fields wornDT, pieces\)/)
  })

  await test('the other field names of the weight are read too', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ wornArmorWeight: 81 }) })
    await t.hit()
    near(t.staminaOf(), 1 - 0.1486, 'Daedric block')
  })

  await test('the stagger follows the weighted cost: 12% stamina pays a base block but not a Daedric one', async () => {
    const heavy = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 81 }), stamina: 0.12 })
    await heavy.hit()
    assert.equal(heavy.staminaOf(), 0)
    assert.deepEqual(heavy.mp.packets, [[USER, { customPacketType: 'stagger', magnitude: 0.5 }]])
    const off = setup({ rule: null, native: () => ({ armorWeight: 81 }), stamina: 0.12 })
    await off.hit()
    near(off.staminaOf(), 0.02, 'base block')
    assert.deepEqual(off.mp.packets, [])
  })

  await test('unblocked hits, ward blocks and a dead blocker cost nothing and ask nothing', async () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 81 }) })
    await t.hit(BLOCKER, SWORD, false)
    await t.hit(BLOCKER, WARD, true)
    t.mp.set(NPC, 'isDead', true)
    await t.hit(NPC)
    assert.equal(t.staminaOf(), 1)
    assert.equal(t.staminaOf(NPC), 1)
    assert.deepEqual(t.mp.calls, [])
  })

  await test('blockStaminaCost 0 for both keeps the hook out, rule or not', () => {
    const t = setup({ rule: DEFAULT_RULE, native: () => ({ armorWeight: 81 }), cost: 0, warriorCost: 0 })
    assert.equal(t.mp['onPapyrusEvent:OnHit'], undefined)
    assert.equal(t.mp.onUpdateEquipmentAttempt, undefined)
    assert.deepEqual(t.logs, [])
  })

  // initAsync with needs off installs only the block hook, so the settings key is read end to end
  const boot = async (allSettings, native) => {
    Settings.cachedPromise = Promise.resolve({ allSettings: { needsEnabled: false, ...allSettings }, dataDir: '.', loadOrder: [] })
    const logs = []
    const sys = new NeedsSystem((line) => logs.push(String(line)), { rankOf: () => 0 })
    const mp = makeMp(native)
    await sys.initAsync({ svr: mp, gm: { on: () => {}, emit: () => {} } })
    mp['onPapyrusEvent:OnHit'](BLOCKER, { type: 'form', desc: desc(ATTACKER) }, { type: 'espm', desc: desc(SWORD) }, null, false, false, false, true)
    await tick()
    return { logs, mp, stamina: mp.get(BLOCKER, 'percentages').stamina }
  }
  const steel = () => ({ armorWeight: 52 })

  await test('boot: no block, enabled false and durability alone change nothing', async () => {
    for (const all of [{}, { alduinakDamageFormulaSettings: { ...ENABLED, enabled: false } },
      { alduinakDamageFormulaSettings: { enabled: false, durability: { enabled: true }, blockStamina: ENABLED.blockStamina } },
      { alduinakDamageFormulaSettings: null }]) {
      const b = await boot(all, steel)
      assert.equal(b.stamina, 1 - 0.1)
      assert.deepEqual(b.mp.calls, [])
      assert.deepEqual(b.logs, ['[needs] disabled by needsEnabled'])
    }
  })

  await test('boot: the enabled block prices a block by weight, with the block\'s own numbers', async () => {
    const b = await boot({ alduinakDamageFormulaSettings: ENABLED }, steel)
    near(b.stamina, 1 - 0.1312, 'Steel block')
    const own = await boot({ alduinakDamageFormulaSettings: { enabled: true, blockStamina: { perArmorWeight: 0.01, weightCap: 40 } }, blockStaminaCost: 0.2 }, steel)
    near(own.stamina, 1 - 0.2 * 1.4, 'own numbers')
  })

  await test('boot: a blockStamina value the native rejects boots, names the value once and charges the base share', async () => {
    for (const [blockStamina, found] of [[{ perArmorWeight: '0' }, 'blockStamina.perArmorWeight should be a number from 0 to 1000000, found "0"'],
      [{ perArmorWeight: -1 }, 'blockStamina.perArmorWeight should be a number from 0 to 1000000, found -1'],
      [{ weightCap: 'x' }, 'blockStamina.weightCap should be a number from 0 to 1000000, found "x"']]) {
      const b = await boot({ alduinakDamageFormulaSettings: { enabled: true, blockStamina } }, steel)
      assert.equal(b.stamina, 1 - 0.1)
      assert.deepEqual(b.mp.calls, [])
      assert.deepEqual(b.logs, [`[needs] block stamina by armor weight is off: alduinakDamageFormulaSettings.${found}; ` +
        'the native rejects the whole block for such a value, so a block costs its base share', '[needs] disabled by needsEnabled'])
    }
  })

  await test('boot: a native that rejected the block gives no stats, so the base share is charged and one line says why', async () => {
    const b = await boot({ alduinakDamageFormulaSettings: ENABLED }, () => null)
    assert.equal(b.stamina, 1 - 0.1)
    assert.equal(b.logs.filter((l) => /getCombatStats has no stats for ff000001/.test(l)).length, 1)
  })

  await test('boot: the enabled block on a native without getCombatStats boots, logs once and charges the base share', async () => {
    const b = await boot({ alduinakDamageFormulaSettings: ENABLED }, undefined)
    assert.equal(b.stamina, 1 - 0.1)
    assert.equal(b.logs.filter((l) => /has no getCombatStats/.test(l)).length, 1)
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
