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
const SPELLS = { 0x100: ['RaceDarkElf', 4], 0x101: ['AldRaceSpeed_DarkElf', 4], 0x102: ['PowerDarkElfAncestorsWrath', 2], 0x200: ['RaceNord', 4], 0x300: ['AldRacial_Breton', 4] }
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
  return {}
}

const setup = () => {
  const props = new Map()
  const packets = []
  const users = new Map()
  const mp = {
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    lookupEspmRecordById: lookup,
    getUserActor: (u) => users.get(u) || 0,
    sendCustomPacket: (u, s) => packets.push({ u, ...JSON.parse(s) }),
  }
  const logs = []
  const racial = new RacialSystem((line) => logs.push(String(line)))
  racial.mp = mp
  racial.configure({})
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
  assert.match(line, /MISMATCH DarkElfRace after spawn: missing AldRaceSpeed_DarkElf; not held RaceDarkElf; off RaceDarkElf; other races' RaceNord running or held; .*racialResync sent$/)
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
  assert.match(t.send(1, { ...r, base: { ...r.base, magicka: 125 } }), /base M 125 expected 150 \(race\); .*no resync, the race sync cannot fix a plugin or base value difference$/)
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
