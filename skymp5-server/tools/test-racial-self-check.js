'use strict'

// RacialSystem self-check: racialReport against the appearance race, its spells and base values, one racialResync per spawn: node tools/test-racial-self-check.js

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

const DARK = 0x13742
const NORD = 0x13746
const BRETON = 0x13741
const SPELLS = { 0x100: ['RaceDarkElf', 4], 0x101: ['AldRaceSpeed_DarkElf', 4], 0x102: ['PowerDarkElfAncestorsWrath', 2], 0x200: ['AldRacial_Nord', 4], 0x300: ['AldRacial_Breton', 4], 0xaa020: ['RaceNord', 4] }
const RESIST_FROST = 0x24315
const RACES = { [DARK]: ['DarkElfRace', [50, 50, 50], [0x100, 0x101, 0x102]], [NORD]: ['NordRace', [50, 50, 100], [0x200]], [BRETON]: ['BretonRace', [50, 100, 50], [0x300]] }

const bytes = (size, write) => { const data = new Uint8Array(size); write(new DataView(data.buffer)); return data }
const formIds = (ids) => ids.map((id) => ({ type: 'SPLO', data: bytes(4, (v) => v.setUint32(0, id, true)) }))
const record = (type, editorId, fields) => ({ record: { type, editorId, fields }, toGlobalRecordId: (id) => id })
const lookup = (id) => {
  if (id === 0x7) return record('NPC_', 'Player', [{ type: 'ACBS', data: bytes(24, (v) => [4, 6, 20].forEach((o) => v.setInt16(o, 50, true))) }])
  if (RACES[id]) {
    const [edid, start, splo] = RACES[id]
    return record('RACE', edid, [{ type: 'DATA', data: bytes(128, (v) => start.forEach((s, i) => v.setFloat32(36 + i * 4, s, true))) }, ...formIds(splo)])
  }
  if (SPELLS[id]) return record('SPEL', SPELLS[id][0], [{ type: 'SPIT', data: bytes(36, (v) => v.setUint32(8, SPELLS[id][1], true)) }])
  if (id === RESIST_FROST) return record('MGEF', 'AbResistFrost', [])
  return {}
}

const setup = (block = { selfCheck: 'resync' }) => {
  const props = new Map()
  const packets = []
  const users = new Map()
  const mp = {
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    lookupEspmRecordById: lookup,
    getUserActor: (u) => users.get(u) || 0,
    getUserByActor: (id) => [...users.entries()].find(([, a]) => a === id)?.[0] ?? -1,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, s) => packets.push({ u, ...JSON.parse(s) }),
  }
  const logs = []
  const racial = new RacialSystem((line) => logs.push(String(line)))
  racial.mp = mp
  racial.configure(block)
  const actor = (userId, id, raceId) => { users.set(userId, id); mp.set(id, 'appearance', { raceId }); return id }
  // A report of the race exactly as the server expects it; the greater power is not held, as the client cuts it
  const report = (raceId, over = {}) => ({
    reason: 'spawn', baseRace: raceId, engineRace: raceId,
    spells: RACES[raceId][2].filter((id) => SPELLS[id][1] !== 2).map((id) => ({ id, held: true, state: 'on' })), stray: [],
    base: { health: RACES[raceId][1][0] + 50, magicka: RACES[raceId][1][1] + 50, stamina: RACES[raceId][1][2] + 50 }, masteryMagicka: null, ...over,
  })
  // The next report is past the per-character gap
  const send = (userId, content) => {
    const state = racial.checks.get(users.get(userId))
    if (state) state.at = 0
    racial.customPacket(userId, 'racialReport', content)
    return logs[logs.length - 1] || ''
  }
  return { racial, mp, logs, packets, actor, report, send }
}

const results = []
function test(name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

test('a report that matches logs check ok with the race spells and base values, and sends nothing', () => {
  const t = setup()
  t.actor(1, 0xff000001, DARK)
  const line = t.send(1, t.report(DARK))
  assert.equal(line, '[racial] ff000001 check ok DarkElfRace after spawn: 2 race spells held (RaceDarkElf, AldRaceSpeed_DarkElf), base H/M/S 100/100/100')
  assert.equal(t.packets.length, 0)
})

test('a wrong engine race is a mismatch with one racialResync per spawn, and a new spawn may resync again', () => {
  const t = setup()
  const id = t.actor(1, 0xff000001, DARK)
  const line = t.send(1, t.report(DARK, { engineRace: NORD, baseRace: NORD }))
  assert.match(line, /MISMATCH DarkElfRace after spawn: engine NordRace base NordRace server DarkElfRace, spells not compared; .*racialResync sent$/)
  assert.equal(t.packets.length, 1)
  assert.deepEqual(t.packets[0], { u: 1, customPacketType: 'racialResync', raceId: DARK, spells: [0x100, 0x101], problems: ['engine NordRace base NordRace server DarkElfRace, spells not compared'] })
  assert.match(t.send(1, t.report(DARK, { engineRace: NORD })), /resync already sent this spawn$/)
  assert.equal(t.packets.length, 1)
  t.racial.forget(id)
  assert.match(t.send(1, t.report(DARK, { engineRace: NORD })), /racialResync sent$/)
  assert.equal(t.packets.length, 2)
})

test('missing, unheld, stopped and other races\' spells are named and resynced', () => {
  const t = setup()
  t.actor(1, 0xff000001, DARK)
  const line = t.send(1, t.report(DARK, { spells: [{ id: 0x100, held: false, state: 'off' }], stray: [0x200] }))
  assert.match(line, /MISMATCH DarkElfRace after spawn: missing AldRaceSpeed_DarkElf; not held RaceDarkElf; off RaceDarkElf; other races' AldRacial_Nord running or held; .*racialResync sent$/)
})

test('a client that reports shared effects holds its strays; an effect running without its spell and a leftover still running are named, never resynced; cleared leftovers end the line', () => {
  const t = setup()
  t.actor(1, 0xff000001, DARK)
  const r = t.report(DARK)
  assert.match(t.send(1, { ...r, sharedEffects: [], stray: [0x200] }), /MISMATCH DarkElfRace after spawn: other races' AldRacial_Nord held; .*racialResync sent$/)
  assert.equal(t.packets.length, 1)
  const t2 = setup()
  t2.actor(1, 0xff000001, DARK)
  const line = t2.send(1, { ...r, sharedEffects: [{ spell: 0x200, effect: RESIST_FROST }], leftovers: [{ id: 0xaa020, held: false, dispelled: false, recast: true, active: true }] })
  assert.equal(line, "[racial] ff000001 MISMATCH DarkElfRace after spawn: running without the spell: AbResistFrost (AldRacial_Nord's), no held spell gives the effect; leftover RaceNord still running; base H/M/S 100/100/100; no resync, the race sync cannot fix a plugin difference, a base value or an effect another spell gives")
  assert.equal(t2.packets.length, 0)
  const ok = t2.send(1, { ...r, sharedEffects: [], leftovers: [{ id: 0xaa020, held: false, dispelled: true, recast: false, active: false }, { id: 0x300, held: true, dispelled: false, recast: false, active: false }] })
  assert.equal(ok, '[racial] ff000001 check ok DarkElfRace after spawn: 2 race spells held (RaceDarkElf, AldRaceSpeed_DarkElf), base H/M/S 100/100/100; cleared RaceNord (dispelled), AldRacial_Breton (held)')
  // A Nord's RaceNord with a failed dispel and nothing seen; a held spell removeSpell refused
  const unseen = t2.send(1, { ...r, sharedEffects: [], leftovers: [{ id: 0xaa020, held: false, removed: false, dispelled: false, recast: false, active: false }, { id: 0x300, held: true, removed: false, dispelled: true, recast: false, active: false }] })
  assert.equal(unseen, "[racial] ff000001 check ok DarkElfRace after spawn: 2 race spells held (RaceDarkElf, AldRaceSpeed_DarkElf), base H/M/S 100/100/100; cleared AldRacial_Breton (held, not removed, dispelled); RaceNord not dispelled, its effect cannot be told from a held spell's")
  assert.equal(t2.packets.length, 0)
})

test('the same problems are logged once per spawn, their first repeat as unchanged; a check ok or a new spawn starts over', () => {
  const t = setup()
  const id = t.actor(1, 0xff000001, DARK)
  const r = t.report(DARK, { sharedEffects: [{ spell: 0x200, effect: RESIST_FROST }] })
  assert.match(t.send(1, r), /MISMATCH DarkElfRace after spawn: running without the spell/)
  assert.equal(t.send(1, { ...r, reason: 'resync' }), '[racial] ff000001 MISMATCH DarkElfRace after resync: unchanged, not logged again this spawn')
  const n = t.logs.length
  t.send(1, { ...r, reason: 'the Magic menu' })
  assert.equal(t.logs.length, n, 'a further identical report is not logged')
  assert.match(t.send(1, { ...r, stray: [0x200] }), /MISMATCH DarkElfRace after spawn: other races' AldRacial_Nord held; running without the spell/, 'different problems are logged')
  assert.match(t.send(1, t.report(DARK)), /check ok/)
  assert.match(t.send(1, r), /MISMATCH DarkElfRace after spawn: running without the spell/)
  t.racial.forget(id)
  assert.match(t.send(1, r), /MISMATCH DarkElfRace after spawn: running without the spell/)
})

test('an extra spell means another plugin on the client: logged, never resynced', () => {
  const t = setup()
  t.actor(1, 0xff000001, NORD)
  const r = t.report(NORD)
  const line = t.send(1, { ...r, spells: r.spells.concat([{ id: 0x999, held: true, state: 'on' }]), base: { ...r.base, stamina: 100 } })
  assert.match(line, /extra 999 on the client's race record, another plugin; base S 100 expected 150 \(race\); .*no resync, the client's plugins differ from the server's$/)
  assert.equal(t.packets.length, 0)
})

test('a base value alone is logged without a resync', () => {
  const t = setup()
  t.actor(1, 0xff000001, BRETON)
  const r = t.report(BRETON)
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 125 } }), /base M 125 expected 150 \(race\); .*no resync, the race sync cannot fix a plugin difference, a base value or an effect another spell gives$/)
  assert.equal(t.packets.length, 0)
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 150.3 } }), /check ok/)
})

test('a mage\'s magicka: skipped while no source is wired, then compared with MasterySystem\'s value', () => {
  const t = setup()
  const id = t.actor(1, 0xff000001, BRETON)
  const r = t.report(BRETON)
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 100 }, masteryMagicka: 100 }), /check ok .*, magicka from the mage rank not checked$/)
  t.racial.writtenMagicka = (actorId) => (actorId === id ? 100 + t.racial.baseBonus(actorId).magicka : null)
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 100 }, masteryMagicka: 100 }), /base M 100 expected 150 \(mastery\)/)
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 150 }, masteryMagicka: 150 }), /check ok/)
  t.racial.writtenMagicka = () => null
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 100 }, masteryMagicka: 100 }), /base M 100 expected 150 \(race\)/)
})

test('reports within the gap, during creation, without a race or of another type are not compared', () => {
  const t = setup()
  t.actor(1, 0xff000001, DARK)
  t.racial.customPacket(1, 'racialReport', t.report(DARK))
  t.racial.customPacket(1, 'racialReport', t.report(DARK, { engineRace: NORD }))
  assert.equal(t.logs.length, 1)
  t.racial.customPacket(1, 'otherPacket', t.report(DARK))
  assert.equal(t.logs.length, 1)
  assert.match(t.send(1, { reason: 'load', spells: 'junk', base: null }), /race check after load ignored: the report names no race$/)
  t.mp.set(0xff000001, 'private.creationPending', true)
  assert.match(t.send(1, t.report(DARK)), /race check after spawn skipped: creation pending$/)
  t.racial.customPacket(9, 'racialReport', t.report(DARK))
  assert.equal(t.packets.length, 0)
})

test('selfCheck: off by default and with the block missing or disabled compares nothing; log compares without a resync; a bad value is named', () => {
  for (const block of [{}, null, { enabled: false, selfCheck: 'resync' }]) {
    const t = setup(block)
    t.actor(1, 0xff000001, DARK)
    t.send(1, t.report(DARK, { engineRace: NORD }))
    assert.deepEqual([t.logs, t.packets], [[], []], JSON.stringify(block))
  }
  const t = setup({ selfCheck: 'log' })
  t.actor(1, 0xff000001, DARK)
  assert.match(t.send(1, t.report(DARK, { engineRace: NORD })), /MISMATCH DarkElfRace after spawn: .*; no resync, racialPassives.selfCheck is log$/)
  assert.equal(t.packets.length, 0)
  const bad = setup()
  assert.deepEqual(bad.racial.configure({ selfCheck: 'yes' }), ['selfCheck "yes" is not off, log, resync, off is used'])
})

test('a polymorphed character is not checked, and its traits follow the race it wears without touching the cache', () => {
  const t = setup({ selfCheck: 'resync', races: { NordRace: { coldRateMult: 0 } } })
  const id = t.actor(1, 0xff000001, NORD)
  assert.equal(t.racial.traits(id).raceEdid, 'NordRace')
  t.mp.set(id, 'private.polymorph', { appearance: { raceId: NORD }, race: 'x' })
  t.mp.set(id, 'appearance', { raceId: DARK })
  assert.deepEqual([t.racial.traits(id).raceEdid, t.racial.traits(id).coldRateMult], ['DarkElfRace', 1])
  assert.match(t.send(1, t.report(DARK)), /race check after spawn skipped: a polymorph holds the character \(private.polymorph\)$/)
  assert.equal(t.packets.length, 0)
  t.mp.set(id, 'private.polymorph', null)
  t.mp.set(id, 'appearance', { raceId: NORD })
  assert.deepEqual([t.racial.traits(id).raceEdid, t.racial.traits(id).coldRateMult], ['NordRace', 0])
})

test('a polymorphed character keeps the base bonus of its own race, so a professionState sent meanwhile writes the magicka it has after the revert', () => {
  const t = setup()
  const id = t.actor(1, 0xff000001, BRETON)
  const own = { health: 0, magicka: 50, stamina: 0 }
  assert.deepEqual(t.racial.baseBonus(id), own)
  t.mp.set(id, 'private.polymorph', { appearance: { raceId: BRETON }, race: 'x' })
  t.mp.set(id, 'appearance', { raceId: NORD })
  assert.equal(t.racial.traits(id).raceEdid, 'NordRace', 'the traits follow the worn race')
  assert.deepEqual(t.racial.baseBonus(id), own, 'not the 0/0/50 of the worn race')
  t.mp.set(id, 'private.polymorph', { race: 'x' })
  assert.deepEqual(t.racial.baseBonus(id), { health: 0, magicka: 0, stamina: 50 }, 'a record without a stored race falls back to the worn one')
  t.mp.set(id, 'private.polymorph', null)
  t.mp.set(id, 'appearance', { raceId: BRETON })
  assert.deepEqual(t.racial.baseBonus(id), own)
})

test('racialBase: one packet with the race\'s base health and stamina for an accepted race menu and its creation finish, none with the block off', () => {
  const queued = []
  const realImmediate = global.setImmediate
  global.setImmediate = (fn) => queued.push(fn)
  const flush = () => { while (queued.length) queued.shift()() }
  try {
    const t = setup({})
    const id = t.actor(1, 0xff000001, NORD)
    t.mp.set(id, 'appearance', { raceId: DARK })
    t.racial.forget(id)
    t.racial.queueBase(id, 'race menu')
    t.racial.queueBase(id, 'creation')
    flush()
    assert.deepEqual(t.packets, [{ u: 1, customPacketType: 'racialBase', raceId: DARK, health: 100, stamina: 100 }])
    assert.equal(t.logs.pop(), '[racial] ff000001 base values sent after race menu: DarkElfRace H/S 100/100, magicka left to MasterySystem')
    t.mp.set(id, 'appearance', { raceId: NORD })
    t.racial.forget(id)
    t.racial.queueBase(id, 'creation')
    flush()
    assert.deepEqual(t.packets.pop(), { u: 1, customPacketType: 'racialBase', raceId: NORD, health: 100, stamina: 150 })
    assert.equal(t.racial.maxHealth(id), 100, 'the base health SurvivalSystem measures the respawn health point against')
    t.mp.set(id, 'private.creationPending', true)
    t.racial.queueBase(id, 'creation')
    flush()
    assert.equal(t.packets.length, 1, 'nothing while creation is pending')
    t.racial.forget(id)
    assert.equal(t.racial.maxHealth(id), 0, 'no race while creation is pending')
    const off = setup({ enabled: false })
    off.actor(1, 0xff000001, NORD)
    off.racial.queueBase(0xff000001, 'creation')
    flush()
    assert.equal(off.packets.length, 0)
    assert.equal(off.racial.maxHealth(0xff000001), 100, 'read from the records, block on or off')
  } finally {
    global.setImmediate = realImmediate
  }
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
