'use strict'

// migrate-morrowind-houses.js against a local backend copy on the committed seed: plan, backup, apply and its refusals: node deploy/mongodb/test/test-migrate-morrowind-houses.js

const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-houses-test-'))
const TOKEN = 'test-houses-token-0123456789'
process.env.BAN_LOG_DIR = tmp
process.env.SERVER_SETTINGS_PATH = path.join(tmp, 'server-settings.json')
process.env.TEST_SERVER_SETTINGS_PATH = path.join(tmp, 'no-test-server.json')
fs.writeFileSync(process.env.SERVER_SETTINGS_PATH, JSON.stringify({ masterApiAuthToken: TOKEN }))

const repo = path.join(__dirname, '..', '..', '..')
const backendDir = path.join(repo, 'skymp5-backend')
const SEED = path.join(backendDir, 'test', 'fixtures', 'faction-whitelist.json')
const doc = require(path.join(backendDir, 'sources', 'db')).store('factions')
const store = require(path.join(backendDir, 'sources', 'factionWhitelist'))
const config = require(path.join(repo, 'server-manager', 'src', 'config'))
const express = require(require.resolve('express', { paths: [backendDir] }))
const { main, Refusal } = require(path.join(__dirname, '..', 'migrate-morrowind-houses'))

const ACTOR = 'test'
const join = (requirementId, discordId, slot, playerName) => store.createAssignment({ requirementId, discordId, slot, playerName }, ACTOR)

function guild(group, province, ranks) {
  let { faction } = store.createFaction({ type: 'guild', group, province }, ACTOR)
  for (const r of ranks) ({ faction } = store.createRank(faction.id, { rev: faction.rev, ...r }, ACTOR))
  return faction.id
}

// Indoril with the owner's Windhelm member, Telvanni with none, the Morag Tong which is no house
function seed() {
  doc.set('whitelist', JSON.parse(fs.readFileSync(SEED, 'utf8')))
  doc.delete('whitelist.bak')
  const ladder = [{ rank: 'Leader', leader: true, craft: true }, { rank: 'Member', craft: true }]
  guild('House Indoril', 'Morrowind', ladder)
  guild('House Telvanni', 'Morrowind', ladder)
  guild('Morag Tong', 'Morrowind', ladder)
  join('faction:house-indoril:leader', '901', 0, 'Helseth')
  join('faction:house-indoril:member', '903', 1, 'Athyn')
  join('hold:eastmarch:citizen', '903', 1, 'Athyn')
  join('faction:house-telvanni:member', '904', 0, 'Neloth')
  join('hold:whiterun:citizen', '904', 1, 'Neloth Two')
}

async function run(argv) {
  const lines = []
  let refusal = null
  try {
    await main(argv, { out: line => lines.push(line) })
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    refusal = err.message
  }
  return { text: lines.join('\n'), refusal }
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

async function start() {
  const app = express()
  app.use(express.json())
  app.use('/api/factions', require(path.join(backendDir, 'routes', 'factions')))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  config.backendApi = { port: server.address().port, token: TOKEN, key: '' }

  await test('plan lists each house, its ranks, members and the Windhelm row, and changes nothing', async () => {
    seed()
    const before = JSON.stringify(doc.get('whitelist'))
    const { text, refusal } = await run([])
    assert.equal(refusal, null)
    assert.match(text, /House Indoril: faction:house-indoril \(guild, Morrowind, rev \d+\) -> hold:indoril/)
    assert.match(text, /faction:house-indoril:leader -> hold:indoril:leader: Leader \(leader, craft, factionAccess; capacity open\), 1 member/)
    assert.match(text, /Athyn \(discord 903, character 2\) as Member/)
    assert.match(text, /REMOVE from Court of Eastmarch: Athyn \(discord 903, character 2\), Citizen/)
    assert.match(text, /House Telvanni: faction:house-telvanni .* -> hold:telvanni/)
    assert.doesNotMatch(text, /Morag Tong/)
    assert.doesNotMatch(text, /Neloth Two/, 'another character of the account is no clash')
    assert.match(text, /plan is safe/)
    assert.equal(JSON.stringify(doc.get('whitelist')), before)
  })

  await test('apply needs a matching backup, dry runs without --apply, then converts', async () => {
    seed()
    assert.match((await run(['apply'])).refusal, /apply needs --backup/)
    const file = path.join(tmp, 'backup.json')
    assert.equal((await run(['backup', '--out', file])).refusal, null)
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).rosters['faction:house-indoril'].length === 2)
    assert.match((await run(['backup', '--out', file])).refusal, /already exists/)
    const dry = await run(['apply', '--backup', file])
    assert.equal(dry.refusal, null)
    assert.match(dry.text, /\[dry run\]/)
    assert.ok(store.definitions().factions.some(f => f.id === 'faction:house-indoril'))
    const done = await run(['apply', '--backup', file, '--apply'])
    assert.equal(done.refusal, null)
    assert.match(done.text, /converted faction:house-indoril -> hold:indoril: 2 members moved, 1 row removed from other territories/)
    assert.match(done.text, /converted faction:house-telvanni -> hold:telvanni: 1 member moved, 0 rows removed/)
    const ids = store.definitions().factions.map(f => f.id)
    assert.ok(ids.includes('hold:indoril') && ids.includes('hold:telvanni') && !ids.includes('faction:house-indoril'))
    assert.deepEqual(store.getPlayerAssignments('903').map(a => a.requirementId), ['hold:indoril:member'])
    assert.match((await run([])).text, /no Morrowind house guild is left to convert/)
  })

  await test('a change after the backup refuses the apply', async () => {
    seed()
    const file = path.join(tmp, 'backup-stale.json')
    await run(['backup', '--out', file])
    join('faction:house-indoril:member', '905', 0, 'Late Joiner')
    const { refusal } = await run(['apply', '--backup', file, '--apply'])
    assert.match(refusal, /changed since the backup/)
    assert.ok(store.definitions().factions.some(f => f.id === 'faction:house-indoril'))
  })

  await test('a clash the owner did not name, or a second Windhelm member, is unsafe and refused', async () => {
    seed()
    join('hold:whiterun:citizen', '904', 0, 'Neloth')
    join('faction:house-indoril:member', '906', null, 'Dral')
    join('hold:eastmarch:guard', '906', 3, 'Dral')
    const plan = await run([])
    assert.match(plan.text, /UNSAFE: Neloth \(discord 904, character 1\) is Citizen of Court of Whiterun/)
    assert.match(plan.text, /UNSAFE: 2 members of House Indoril also belong to Windhelm/)
    assert.match(plan.text, /plan is NOT safe/)
    const file = path.join(tmp, 'backup-unsafe.json')
    await run(['backup', '--out', file])
    assert.match((await run(['apply', '--backup', file, '--apply'])).refusal, /not safe/)
    assert.ok(store.definitions().factions.some(f => f.id === 'faction:house-telvanni'), 'nothing converted')
  })

  await test('an account-wide Windhelm row against a one-character house row is unsafe', async () => {
    seed()
    store.deleteAssignment(store.getPlayerAssignments('903').find(a => a.requirementId === 'hold:eastmarch:citizen').id, ACTOR)
    join('hold:eastmarch:citizen', '903', null, 'Athyn')
    const { text } = await run([])
    assert.match(text, /REMOVE from Court of Eastmarch: Athyn \(discord 903, every character\), Citizen/)
    assert.match(text, /UNSAFE: Athyn \(discord 903, every character\) is Citizen of Court of Eastmarch, but in House Indoril only as character 2; removing the row takes the account's other characters out/)
    assert.match(text, /plan is NOT safe/)
  })

  await test('two houses that would become the same territory are unsafe', async () => {
    seed()
    guild('Great House Telvanni', 'Morrowind', [{ rank: 'Leader', leader: true }])
    const { text } = await run([])
    assert.match(text, /UNSAFE: faction:great-house-telvanni \(Great House Telvanni\) would become hold:telvanni too, and only one can/)
    assert.match(text, /UNSAFE: faction:house-telvanni \(House Telvanni\) would become hold:telvanni too/)
    assert.match(text, /plan is NOT safe/)
  })

  await test('an existing territory under the new id is refused by the backend', async () => {
    seed()
    store.createFaction({ type: 'hold', group: 'Indoril', name: 'Indoril Lands' }, ACTOR)
    const { text } = await run([])
    assert.match(text, /REFUSED by the backend: .*hold:indoril already exists/)
    assert.match(text, /plan is NOT safe/)
  })

  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  let failed = 0
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
    if (!ok) {
      failed++
      console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n      ') : err}`)
    }
  }
  console.log(`${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})
