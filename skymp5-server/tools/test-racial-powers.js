'use strict'

// RacialSystem power gate: cooldowns in wall-clock time, refusal notices, racialState, effects not built yet refused: node tools/test-racial-powers.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'racialSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { RacialSystem } = compiled.exports

const WOOD = 0x13749
const WOOD_VAMPIRE = 0x88884
const NORD = 0x13746
const COMMAND = 0x0504133a
const RATIONED = 0x0504133b
const STRAY = 0x0504133c
const HOUR = 3600000
const PLUGIN = 'AlduinakAdditions.esp'
const SPELLS = { [COMMAND]: ['AldPowerCommandAnimal', 3, 'Command Animal'], [RATIONED]: ['AldPowerTestRation', 3, ''], [STRAY]: ['AldPowerStray', 3, 'Stray'] }
const RACES = { [WOOD]: ['WoodElfRace', [COMMAND]], [WOOD_VAMPIRE]: ['WoodElfRaceVampire', [COMMAND, STRAY]], [NORD]: ['NordRace', [RATIONED]] }

const bytes = (size, write) => { const data = new Uint8Array(size); write(new DataView(data.buffer)); return data }
const record = (type, editorId, fields) => ({ record: { type, editorId, fields }, toGlobalRecordId: (id) => id })
const lookup = (id) => {
  if (RACES[id]) return record('RACE', RACES[id][0], RACES[id][1].map((s) => ({ type: 'SPLO', data: bytes(4, (v) => v.setUint32(0, s, true)) })))
  if (SPELLS[id]) {
    const [edid, type, full] = SPELLS[id]
    const fields = [{ type: 'SPIT', data: bytes(36, (v) => v.setUint32(8, type, true)) }]
    if (full) fields.push({ type: 'FULL', data: new Uint8Array(Buffer.from(full + '\0', 'utf8')) })
    return record('SPEL', edid, fields)
  }
  return {}
}
const descOf = (id) => `${(id & 0xffffff).toString(16)}:${PLUGIN}`
const RESOLVED = new Map([['aldpowercommandanimal', descOf(COMMAND)], ['aldpowertestration', descOf(RATIONED)]])
const BLOCK = { powers: {
  AldPowerCommandAnimal: { cooldownHours: 20, consumeOnMiss: false, commandAnimal: { durationSec: 60 } },
  AldPowerTestRation: { cooldownHours: 2 },
  AldPowerMissing: { cooldownHours: 1 },
} }

const tick = () => new Promise((r) => setImmediate(r))

const setup = (block = BLOCK) => {
  const props = new Map()
  const packets = []
  const users = new Map()
  const mp = {
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    lookupEspmRecordById: lookup,
    getIdFromDesc: (d) => (0x05000000 | parseInt(d.split(':')[0], 16)) >>> 0,
    getDescFromId: descOf,
    getUserByActor: (a) => { for (const [u, id] of users) if (id === a) return u; return -1 },
    getUserActor: (u) => users.get(u) || 0,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, s) => packets.push({ u, ...JSON.parse(s) }),
  }
  const logs = []
  const racial = new RacialSystem((line) => logs.push(String(line)))
  racial.mp = mp
  const problems = racial.configure(block)
  const warnings = []
  const powersLine = racial.resolvePowers(RESOLVED, warnings)
  const player = (userId, id, raceId) => { users.set(userId, id); mp.set(id, 'appearance', { raceId }); mp.set(id, 'profileId', userId); return id }
  // One cast: the attempt inside the native call, then the cast once it returns
  const cast = async (id, spellId) => {
    const allowed = racial.powerAttempt(id, spellId)
    if (allowed) racial.powerCast(id, spellId)
    await tick()
    return allowed
  }
  const stamp = (id, spellId) => mp.get(id, 'private.racial')?.powers?.[descOf(spellId)]
  const last = (type) => packets.filter((p) => p.customPacketType === type).pop()
  return { racial, mp, logs, packets, problems, warnings, powersLine, player, cast, stamp, last }
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

;(async () => {
  await test('the boot line names each power with its cooldown, miss rule, effect and races, and warns about unrationed ones', () => {
    const t = setup()
    assert.equal(t.powersLine,
      'AldPowerCommandAnimal 504133a "Command Animal" on WoodElfRace, WoodElfRaceVampire (cooldown 20 h of real time, counting offline, a miss is free, effect commandAnimal not built yet, so casts are refused); ' +
      'AldPowerTestRation 504133b "Test Ration" on NordRace (cooldown 2 h of real time, counting offline, a miss is free, no effect); ' +
      'AldPowerMissing not in the load order yet (cooldown 1 h of real time, counting offline, a miss is free, no effect)')
    assert.deepEqual(t.warnings, ['AldPowerStray is on WoodElfRaceVampire but racialPassives.powers has no entry for it, so its casts are not rationed'])
  })

  await test('Command Animal is refused with a notice while its effect is not built, and nothing is stamped (critique A.4)', async () => {
    const t = setup()
    const id = t.player(1, 0xff000001, WOOD)
    assert.equal(await t.cast(id, COMMAND), false)
    assert.equal(t.stamp(id, COMMAND), undefined)
    assert.deepEqual(t.last('masteryNotice'), { u: 1, customPacketType: 'masteryNotice', text: 'Command Animal is not available yet.' })
    assert.deepEqual(t.last('racialState'), { u: 1, customPacketType: 'racialState', powers: [{ spellId: COMMAND, name: 'Command Animal', readyInMs: 0, available: false }] })
    assert.ok(t.logs.includes('[racial] ff000001 AldPowerCommandAnimal refused: its commandAnimal effect is not built yet'), t.logs.join('\n'))
  })

  await test('a power that worked is stamped and refused for its cooldown with the time left; a miss is free', async () => {
    const t = setup()
    const id = t.player(1, 0xff000001, WOOD)
    let worked = false
    t.racial.powerEffects.commandAnimal = () => worked
    assert.equal(await t.cast(id, COMMAND), true)
    assert.equal(t.stamp(id, COMMAND), undefined)
    assert.ok(t.logs.includes('[racial] ff000001 AldPowerCommandAnimal cast with no effect, the power stays ready'))
    worked = true
    const before = Date.now()
    assert.equal(await t.cast(id, COMMAND), true)
    assert.ok(t.stamp(id, COMMAND) >= before)
    assert.match(t.logs[t.logs.length - 1], /^\[racial\] ff000001 AldPowerCommandAnimal used, ready again at \S+Z \(20 h, counting offline\)$/)
    const state = t.last('racialState').powers[0]
    assert.equal(state.available, true)
    assert.ok(state.readyInMs > 20 * HOUR - 5000 && state.readyInMs <= 20 * HOUR)
    assert.equal(await t.cast(id, COMMAND), false)
    assert.equal(t.last('masteryNotice').text, 'Command Animal is ready again in 20 h.')
    assert.match(t.logs[t.logs.length - 1], /refused: ready again in 20 h, last used /)
  })

  await test('the cooldown is wall-clock time: offline hours count, a future stamp is a full cooldown at most', async () => {
    const t = setup()
    const id = t.player(1, 0xff000001, WOOD)
    t.racial.powerEffects.commandAnimal = () => true
    const entry = t.racial.powerById.get(COMMAND)
    t.mp.set(id, 'private.racial', { v: 1, powers: { [descOf(COMMAND)]: Date.now() - 6 * HOUR - 40 * 60000 } })
    assert.equal(await t.cast(id, COMMAND), false)
    assert.equal(t.last('masteryNotice').text, 'Command Animal is ready again in 13 h 20 min.')
    t.mp.set(id, 'private.racial', { v: 1, powers: { [descOf(COMMAND)]: Date.now() - 21 * HOUR } })
    assert.equal(t.racial.readyInMs(id, entry), 0)
    assert.equal(await t.cast(id, COMMAND), true)
    t.mp.set(id, 'private.racial', { v: 1, powers: { [descOf(COMMAND)]: Date.now() + 100 * HOUR } })
    assert.equal(t.racial.readyInMs(id, entry), 20 * HOUR)
  })

  await test('consumeOnMiss stamps a miss; a thrown effect counts as a miss', async () => {
    const t = setup({ powers: { AldPowerCommandAnimal: { cooldownHours: 20, consumeOnMiss: true, commandAnimal: {} } } })
    const id = t.player(1, 0xff000001, WOOD)
    t.racial.powerEffects.commandAnimal = () => { throw new Error('no animal') }
    assert.equal(await t.cast(id, COMMAND), true)
    assert.ok(t.stamp(id, COMMAND) > 0)
    assert.ok(t.logs.some((l) => l === '[racial] ff000001 AldPowerCommandAnimal effect failed: Error: no animal'))
    assert.match(t.logs[t.logs.length - 1], /used with no effect \(consumeOnMiss\), ready again at/)
  })

  await test('a power with no effect block is stamped at every cast; the use is kept on the character across a race change', async () => {
    const t = setup()
    const id = t.player(1, 0xff000001, NORD)
    assert.equal(await t.cast(id, RATIONED), true)
    assert.ok(t.stamp(id, RATIONED) > 0)
    assert.equal(await t.cast(id, RATIONED), false)
    assert.equal(t.last('masteryNotice').text, 'Test Ration is ready again in 2 h.')
    t.mp.set(id, 'appearance', { raceId: WOOD })
    t.racial.forget(id)
    t.racial.sendPowerState(id)
    assert.deepEqual(t.last('racialState').powers.map((p) => p.spellId), [COMMAND, RATIONED])
  })

  await test('refusals are noticed once per 3 s; NPC casters, other spells and enabled false are never gated', async () => {
    const t = setup()
    const id = t.player(1, 0xff000001, WOOD)
    assert.equal(await t.cast(id, COMMAND), false)
    assert.equal(await t.cast(id, COMMAND), false)
    assert.equal(t.packets.filter((p) => p.customPacketType === 'masteryNotice').length, 1)
    t.mp.set(0xff000009, 'appearance', { raceId: WOOD })
    assert.equal(await t.cast(0xff000009, COMMAND), true)
    assert.equal(await t.cast(id, 0x12fcc), true)
    const off = setup({ enabled: false, powers: BLOCK.powers })
    const other = off.player(1, 0xff000001, WOOD)
    assert.equal(await off.cast(other, COMMAND), true)
    assert.equal(off.stamp(other, COMMAND), undefined)
    off.racial.sendPowerState(other)
    assert.equal(off.packets.length, 0)
    assert.match(off.powersLine, /^off \(enabled false\), none refused; configured /)
  })

  await test('a racialReport is answered with racialState; bad power settings are reported', async () => {
    const t = setup()
    t.player(1, 0xff000001, NORD)
    t.racial.customPacket(1, 'racialReport', { reason: 'spawn', baseRace: NORD, engineRace: NORD, spells: [{ id: RATIONED, held: true, state: 'power' }] })
    assert.deepEqual(t.last('racialState'), { u: 1, customPacketType: 'racialState', powers: [{ spellId: RATIONED, name: 'Test Ration', readyInMs: 0, available: true }] })
    const bad = setup({ powers: { AldPowerCommandAnimal: { cooldownHours: -1, commandAnimal: true, cooldown: 5 } } })
    assert.deepEqual(bad.problems, [
      'powers.AldPowerCommandAnimal.cooldownHours is not a non-negative number, 0 is used',
      'powers.AldPowerCommandAnimal.cooldown is not a known key',
      'powers.AldPowerCommandAnimal.commandAnimal is not an object, the power has no effect',
    ])
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
})()
