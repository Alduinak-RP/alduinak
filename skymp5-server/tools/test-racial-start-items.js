'use strict'

// RacialSystem start items: once per profile and slot at creation, the login backfill window, private.starterGold untouched: node tools/test-racial-start-items.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'racialSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { RacialSystem } = compiled.exports

const IMPERIAL = 0x13744
const NORD = 0x13746
const GOLD = 0xf
const RACES = { [IMPERIAL]: 'ImperialRace', [NORD]: 'NordRace' }
const LAUNCH = Date.parse('2026-10-01T16:00:00-07:00')
const BLOCK = { races: { ImperialRace: { startingItems: [{ baseId: '0x0000000F', count: 50 }] } } }

// A fresh starter-grants.json in a temporary working directory, and actors with a race, profile, slot and 50 kit gold
const setup = (block = BLOCK) => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'racial-')))
  const props = new Map()
  const mp = {
    get: (id, key) => props.get(`${id >>> 0}:${key}`),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    lookupEspmRecordById: (id) => (RACES[id] ? { record: { type: 'RACE', editorId: RACES[id], fields: [] } } : {}),
    callPapyrusFunction: () => undefined,
    getDescFromId: (id) => id.toString(16),
  }
  const logs = []
  const racial = new RacialSystem((line) => logs.push(String(line)))
  racial.mp = mp
  racial.configure(block)
  const actor = (id, raceId, { profileId = 7, slot = 0, createdAt } = {}) => {
    mp.set(id, 'appearance', { raceId })
    mp.set(id, 'profileId', profileId)
    mp.set(id, 'private.charSlot', slot)
    mp.set(id, 'inventory', { entries: [{ baseId: GOLD, count: 50 }] })
    if (createdAt) mp.set(id, 'private.startLocation', { id: 'riverwood', at: createdAt })
    return id
  }
  const gold = (id) => (mp.get(id, 'inventory')?.entries || []).filter((e) => e.baseId === GOLD).reduce((n, e) => n + e.count, 0)
  return { racial, mp, logs, actor, gold }
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

test('a new Imperial gets 50 gold on top of the kit, recorded, without private.starterGold', () => {
  const t = setup()
  const id = t.actor(0xff000001, IMPERIAL)
  t.racial.grantStartItems(id, 'creation')
  assert.equal(t.gold(id), 100)
  assert.equal(t.mp.get(id, 'private.starterGold'), undefined)
  const rec = t.mp.get(id, 'private.racial').startItems
  assert.equal(rec.race, 'ImperialRace')
  assert.deepEqual(rec.items, [{ baseId: GOLD, count: 50 }])
  assert.equal(rec.via, 'creation')
  assert.ok(t.logs.includes('[racial] ff000001 ImperialRace start items: 50 gold (slot 0, creation)'), t.logs.join('\n'))
  t.racial.grantStartItems(id, 'creation')
  assert.equal(t.gold(id), 100)
})

test('a character recreated in the same slot gets nothing, whatever race; another slot does', () => {
  const t = setup()
  t.racial.grantStartItems(t.actor(0xff000001, IMPERIAL, { slot: 2 }), 'creation')
  const again = t.actor(0xff000002, IMPERIAL, { slot: 2 })
  t.racial.grantStartItems(again, 'creation')
  assert.equal(t.gold(again), 50)
  assert.equal(t.mp.get(again, 'private.racial').startItems.note, 'slot already granted')
  const other = t.actor(0xff000003, IMPERIAL, { slot: 3 })
  t.racial.grantStartItems(other, 'creation')
  assert.equal(t.gold(other), 100)
  const nord = t.actor(0xff000004, NORD, { slot: 4 })
  t.racial.grantStartItems(nord, 'creation')
  assert.equal(t.gold(nord), 50)
  assert.equal(t.mp.get(nord, 'private.racial'), undefined)
})

test('the login backfill gives the items to a character created since the window, not before, and not twice', () => {
  const t = setup()
  const late = t.actor(0xff000001, IMPERIAL, { slot: 0, createdAt: LAUNCH + 60000 })
  const early = t.actor(0xff000002, IMPERIAL, { slot: 1, createdAt: LAUNCH - 60000 })
  t.racial.backfillStartItems(late)
  t.racial.backfillStartItems(early)
  t.racial.backfillStartItems(late)
  assert.equal(t.gold(late), 100)
  assert.equal(t.mp.get(late, 'private.racial').startItems.via, 'login')
  assert.equal(t.gold(early), 50)
  assert.equal(t.mp.get(early, 'private.racial'), undefined)
})

test('the backfill skips a pending creation, records an unknown creation time once, and honours startItemsSince', () => {
  const t = setup({ ...BLOCK, startItemsSince: '2026-09-01T00:00:00Z' })
  const pending = t.actor(0xff000001, IMPERIAL, { createdAt: Date.now() })
  t.mp.set(pending, 'private.creationPending', true)
  t.racial.backfillStartItems(pending)
  assert.equal(t.gold(pending), 50)
  const unknown = t.actor(0xff000002, IMPERIAL, { slot: 1 })
  t.racial.backfillStartItems(unknown)
  assert.equal(t.mp.get(unknown, 'private.racial').startItems.note, 'creation time unknown')
  const september = t.actor(0xff000003, IMPERIAL, { slot: 2, createdAt: Date.parse('2026-09-15T00:00:00Z') })
  t.racial.backfillStartItems(september)
  assert.equal(t.gold(september), 100)
})

test('enabled false or no racialPassives block grants nothing', () => {
  for (const block of [{ ...BLOCK, enabled: false }, null]) {
    const t = setup(block)
    const id = t.actor(0xff000001, IMPERIAL, { createdAt: Date.now() })
    t.racial.grantStartItems(id, 'creation')
    t.racial.backfillStartItems(id)
    assert.equal(t.gold(id), 50)
  }
})

test('an unreadable starter-grants.json refuses the grant instead of overwriting the kit guards', () => {
  const t = setup()
  fs.writeFileSync('starter-grants.json', '{"7:0": true')
  const id = t.actor(0xff000001, IMPERIAL)
  t.racial.grantStartItems(id, 'creation')
  assert.equal(t.gold(id), 50)
  assert.equal(fs.readFileSync('starter-grants.json', 'utf8'), '{"7:0": true')
})

let failed = 0
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) {
    failed++
    console.log(`     ${err && err.message}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
