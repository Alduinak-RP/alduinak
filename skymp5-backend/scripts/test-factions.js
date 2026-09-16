'use strict'

// Faction definition store, /api/factions and the loopback-only manager token against a temp copy of the committed seed: node scripts/test-factions.js

const assert = require('node:assert/strict')
const fs     = require('fs')
const http   = require('http')
const os     = require('os')
const path   = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faction-test-'))
const FILE = path.join(tmp, 'faction-whitelist.json')
const TOKEN = 'test-manager-token-0123456789'
process.env.FACTION_WHITELIST_FILE = FILE
process.env.BAN_LOG_DIR = tmp
process.env.MASTER_API_AUTH_TOKEN = TOKEN
process.env.ROLE_PERMISSIONS_FILE = path.join(tmp, 'role-permissions.json')
fs.writeFileSync(process.env.ROLE_PERMISSIONS_FILE, JSON.stringify({ roles: { 'role-view': { name: 'View', permissions: ['factions.view', 'factions.manage'] }, 'role-admin': { name: 'Admin', permissions: ['admin.*'] } } }))

const express  = require('express')
const store    = require('../sources/factionWhitelist')
const sessions = require('../sources/dashboardSessions')
const managerOrPermission = require('../middleware/managerOrPermission')

const SEED = path.join(__dirname, '..', 'seeds', 'faction-whitelist.json')
const ACTOR = 'test'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

function status(fn) {
  try {
    fn()
  } catch (err) {
    return { status: err.status, message: err.message, extra: err.extra || {} }
  }
  throw new Error('expected a refusal')
}

const revOf = id => store.definitions().factions.find(f => f.id === id).rev
const rankOf = (factionId, slug) => store.definitions().factions.find(f => f.id === factionId).ranks.find(r => r.id === `${factionId}:${slug}`)
const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'))
const auditLines = () => (fs.existsSync(path.join(tmp, 'faction.log')) ? fs.readFileSync(path.join(tmp, 'faction.log'), 'utf8').trim().split('\n') : [])

function resetSeed() {
  fs.copyFileSync(SEED, FILE)
  for (const f of ['faction.log', 'faction-whitelist.json.bak']) fs.rmSync(path.join(tmp, f), { force: true })
}

// HoldClaims::CanAppoint, transcribed from skymp5-server/cpp/server_guest_lib/HoldClaims.cpp
const HOLD_CLAIMS_APPOINTS = {
  jarl: ['steward', 'captain-of-the-guard', 'court-wizard', 'thane', 'housecarl', 'village-elder', 'guard', 'lord-lady', 'citizen'],
  steward: ['lord-lady', 'citizen'],
  'captain-of-the-guard': ['guard'],
  'court-wizard': [],
  thane: ['housecarl', 'guard', 'village-elder', 'lord-lady', 'citizen'],
  housecarl: ['guard'],
  'village-elder': ['lord-lady', 'citizen'],
  guard: [],
  'lord-lady': ['citizen'],
  citizen: [],
}

async function run() {
  await test('seed loads with the HoldClaims matrix and default flags', () => {
    resetSeed()
    const { factions } = store.definitions()
    assert.equal(factions.length, 16)
    for (const court of factions.filter(f => f.scope === 'hold')) {
      assert.equal(court.ranks.length, 10, court.id)
      for (const rank of court.ranks) {
        const slug = rank.id.split(':')[2]
        assert.deepEqual([...rank.appoints].sort(), [...HOLD_CLAIMS_APPOINTS[slug]].sort(), rank.id)
        for (const key of ['promotes', 'demotes', 'removes']) assert.deepEqual(rank[key], rank.appoints, `${rank.id} ${key}`)
        assert.equal(rank.managesProperty, slug === 'jarl' || slug === 'steward', rank.id)
        assert.equal(rank.invites, true)
        assert.equal(rank.factionAccess, true)
      }
    }
    assert.equal(rankOf('faction:companions', 'harbinger').managesProperty, false)
  })

  await test('faction validation', () => {
    resetSeed()
    assert.equal(status(() => store.createFaction({ scope: 'guild', group: 'Vigilants' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ scope: 'hold', group: 'Solstheim' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ scope: 'hold', group: 'Rift' }, ACTOR)).status, 409)
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: '!!!' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Vigilants', color: 'red' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Vigilants', zone: 'north' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Legion Two', name: 'imperial legion' }, ACTOR)).status, 409)
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Companions' }, ACTOR)).status, 409)
    const { faction } = store.createFaction({ scope: 'faction', group: 'Vigilants of Stendarr', color: '#AABBCC', zone: 'neutral' }, ACTOR)
    assert.equal(faction.id, 'faction:vigilants-of-stendarr')
    assert.equal(faction.color, 'aabbcc')
    assert.equal(faction.rev, 1)
    assert.equal(status(() => store.updateFaction(faction.id, { name: 'X' }, ACTOR)).status, 400)
    assert.equal(store.updateFaction(faction.id, { rev: 1, name: 'The Vigilants' }, ACTOR).faction.rev, 2)
  })

  await test('uniform lists are edited through the API', () => {
    resetSeed()
    const id = 'faction:companions'
    const uniform = [{ item: '0x00013ED9', count: 1 }, { item: '13ed9:Skyrim.esm', count: 2 }]
    assert.equal(status(() => store.updateFaction(id, { rev: revOf(id), uniform: [{ item: '', count: 1 }] }, ACTOR)).status, 400)
    assert.equal(status(() => store.updateFaction(id, { rev: revOf(id), uniform: [{ item: '0x1', count: 101 }] }, ACTOR)).status, 400)
    const saved = store.updateFaction(id, { rev: revOf(id), uniform }, ACTOR).faction
    assert.deepEqual(saved.uniform, uniform)
    assert.equal(store.updateFaction(id, { rev: saved.rev, uniform }, ACTOR).faction.rev, saved.rev, 'an unchanged list is no edit')
    const rank = store.updateRank(`${id}:harbinger`, { rev: saved.rev, uniform: [{ item: '0x00012E4D', count: 1 }] }, ACTOR).faction.ranks.find(r => r.id === `${id}:harbinger`)
    assert.deepEqual(rank.uniform, [{ item: '0x00012E4D', count: 1 }])
    assert.equal(store.updateRank(`${id}:harbinger`, { rev: revOf(id), uniform: null }, ACTOR).faction.ranks.find(r => r.id === `${id}:harbinger`).uniform, null)
  })

  await test('permission strings follow the rank id and cannot be set', () => {
    resetSeed()
    const id = 'faction:companions'
    for (const permission of ['hold.whiterun.jarl', 'admin.*', '*', 'faction.thalmor.agent']) {
      assert.equal(status(() => store.createRank(id, { rev: revOf(id), rank: 'Shield Brother', permission }, ACTOR)).status, 400, permission)
      assert.equal(status(() => store.updateRank(`${id}:whelp`, { rev: revOf(id), permission }, ACTOR)).status, 400, permission)
    }
    const { faction } = store.createRank(id, { rev: revOf(id), rank: 'Shield Brother', permission: 'faction.companions.shield-brother' }, ACTOR)
    assert.equal(faction.ranks.find(r => r.id === `${id}:shield-brother`).permission, 'faction.companions.shield-brother')
    assert.equal(store.updateRank(`${id}:whelp`, { rev: faction.rev, permission: '' }, ACTOR).faction.rev, faction.rev)

    // A hand-edited custom or wildcard string never reaches the game server
    const data = readFile()
    Object.assign(data.requirements.find(r => r.id === `${id}:whelp`), { permission: 'admin.*' })
    fs.writeFileSync(FILE, JSON.stringify(data))
    store.createAssignment({ requirementId: `${id}:whelp`, discordId: '777', slot: 0, playerName: 'Farkas' }, ACTOR)
    assert.deepEqual(store.getPlayerFactionPermissions('777'), ['faction.companions.whelp'])
    assert.equal(store.getPlayerGameFactions('777')[0].permission, 'faction.companions.whelp')
    assert.equal(store.listDefinitions().requirements.find(r => r.id === `${id}:whelp`).permission, 'faction.companions.whelp')
    assert.equal(readFile().requirements.find(r => r.id === `${id}:whelp`).permission, 'faction.companions.whelp', 'the next write stores the derived string')
  })

  await test('rank validation and optimistic revisions', () => {
    resetSeed()
    const id = 'faction:companions'
    const rev = revOf(id)
    assert.equal(status(() => store.createRank(id, { rank: 'Shield-Brother' }, ACTOR)).status, 400)
    const stale = status(() => store.createRank(id, { rev: rev + 5, rank: 'Shield-Brother' }, ACTOR))
    assert.equal(stale.status, 409)
    assert.equal(stale.extra.stale, true)
    assert.equal(stale.extra.faction.id, id)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'Shield-Brother', capacity: 1000 }, ACTOR)).status, 400)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'Shield-Brother', appoints: ['nobody'] }, ACTOR)).status, 400)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'Shield-Brother', managesProperty: true }, ACTOR)).status, 400)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'Shield-Brother', invites: 'yes' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'whelp' }, ACTOR)).status, 409)
    const { faction } = store.createRank(id, { rev, rank: 'Shield Brother', capacity: 3, appoints: ['whelp', 'harbinger'], removes: [], invites: false }, ACTOR)
    const rank = faction.ranks.find(r => r.id === `${id}:shield-brother`)
    assert.equal(faction.rev, rev + 1)
    assert.equal(rank.order, faction.ranks.length - 1)
    assert.deepEqual(rank.appoints, ['whelp'], 'the leader rank is never a target')
    assert.deepEqual(rank.promotes, ['whelp'])
    assert.deepEqual(rank.removes, [])
    assert.equal(rank.invites, false)
    assert.equal(status(() => store.updateRank(`${id}:shield-brother`, { rev: faction.rev, rank: 'Whelp' }, ACTOR)).status, 409)
    const court = store.updateRank('hold:whiterun:guard', { rev: revOf('hold:whiterun'), managesProperty: true }, ACTOR).faction
    assert.equal(court.ranks.find(r => r.id === 'hold:whiterun:guard').managesProperty, true)
  })

  await test('rank reorder needs every rank once', () => {
    resetSeed()
    const id = 'faction:thalmor'
    const ladder = store.definitions().factions.find(f => f.id === id).ranks.map(r => r.id.split(':')[2])
    assert.equal(status(() => store.reorderRanks(id, { rev: 0, ranks: ladder.slice(1) }, ACTOR)).status, 400)
    assert.equal(status(() => store.reorderRanks(id, { rev: 0, ranks: [ladder[0], ...ladder] }, ACTOR)).status, 400)
    const { faction } = store.reorderRanks(id, { rev: 0, ranks: [...ladder].reverse() }, ACTOR)
    assert.deepEqual(faction.ranks.map(r => r.id.split(':')[2]), [...ladder].reverse())
    assert.deepEqual(faction.ranks.map(r => r.order), ladder.map((_, i) => i))
  })

  await test('deleting a rank with members needs the confirmed count', () => {
    resetSeed()
    const rankId = 'hold:whiterun:guard'
    store.createAssignment({ requirementId: rankId, discordId: '111', slot: 0, playerName: 'Lydia' }, ACTOR)
    store.createAssignment({ requirementId: rankId, discordId: '222', slot: 1, playerName: 'Hrongar' }, ACTOR)
    store.createAssignment({ requirementId: 'hold:whiterun:citizen', discordId: '333', slot: 0, playerName: 'Ysolda' }, ACTOR)
    const rev = revOf('hold:whiterun')
    const blocked = status(() => store.deleteRank(rankId, { rev }, ACTOR))
    assert.equal(blocked.status, 409)
    assert.equal(blocked.extra.hasMembers, true)
    assert.equal(blocked.extra.members, 2)
    assert.deepEqual(blocked.extra.sample.map(m => m.playerName).sort(), ['Hrongar', 'Lydia'])
    const miscounted = status(() => store.deleteRank(rankId, { rev, removeMembers: true, expectedMembers: 1 }, ACTOR))
    assert.equal(miscounted.status, 409)
    assert.equal(miscounted.extra.members, 2)
    assert.equal(readFile().assignments.length, 3, 'a refused delete changes nothing')

    const done = store.deleteRank(rankId, { rev, removeMembers: true, expectedMembers: 2 }, ACTOR)
    assert.equal(done.removedMembers, 2)
    const data = readFile()
    assert.deepEqual(data.assignments.map(a => a.playerName), ['Ysolda'])
    assert.ok(!data.requirements.some(r => r.id === rankId))
    assert.ok(data.requirements.filter(r => r.id.startsWith('hold:whiterun:')).every(r => !(r.appoints || []).includes('guard')), 'the rank leaves every appoint list')
    assert.ok(fs.existsSync(FILE + '.bak'))
    const lines = auditLines()
    assert.equal(lines.filter(l => l.includes('action=member.remove') && l.includes(`requirement=${rankId}`)).length, 2)
    assert.ok(lines.some(l => l.includes('action=rank.delete') && l.includes('removedMembers=2')))
  })

  await test('deleting an empty rank or faction needs no confirmation', () => {
    resetSeed()
    const rev = revOf('faction:thalmor')
    assert.equal(store.deleteRank('faction:thalmor:agent', { rev }, ACTOR).removedMembers, 0)
    assert.equal(store.deleteFaction('faction:thalmor', { rev: rev + 1 }, ACTOR).removedMembers, 0)
    assert.ok(!fs.existsSync(FILE + '.bak'))
  })

  await test('deleted ids are tombstoned and never reused, and survive the wipe', () => {
    resetSeed()
    store.createAssignment({ requirementId: 'faction:thieves-guild:footpad', discordId: '444', slot: 0, playerName: 'Vex' }, ACTOR)
    const rev = revOf('faction:thieves-guild')
    assert.equal(status(() => store.deleteFaction('faction:thieves-guild', { rev }, ACTOR)).extra.members, 1)
    store.deleteFaction('faction:thieves-guild', { rev, removeMembers: '1', expectedMembers: '1' }, ACTOR)
    const retired = readFile().retired
    assert.ok(retired.factions.includes('faction:thieves-guild'))
    assert.ok(retired.ranks.includes('faction:thieves-guild:footpad'))
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Thieves Guild' }, ACTOR)).status, 409)
    assert.ok(store.createFaction({ scope: 'faction', group: 'Thieves Guild of Riften' }, ACTOR).faction)

    const courtRev = revOf('hold:the-pale')
    store.deleteRank('hold:the-pale:court-wizard', { rev: courtRev }, ACTOR)
    assert.equal(status(() => store.createRank('hold:the-pale', { rev: courtRev + 1, rank: 'Court Wizard' }, ACTOR)).status, 409)

    // A deleted court retires its hold under either spelling
    store.deleteFaction('hold:the-rift', { rev: revOf('hold:the-rift') }, ACTOR)
    for (const group of ['The Rift', 'Rift']) {
      const refused = status(() => store.createFaction({ scope: 'hold', group }, ACTOR))
      assert.equal(refused.status, 409, group)
      assert.match(refused.message, /hold:the-rift/)
    }
    assert.ok(store.createFaction({ scope: 'faction', group: 'Rift' }, ACTOR).faction, 'only hold courts share a hold key')

    // wipe-world.js keeps every key but assignments
    const wiped = { ...readFile(), assignments: [] }
    fs.writeFileSync(FILE, JSON.stringify(wiped))
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Thieves Guild' }, ACTOR)).status, 409)
  })

  await test('an unreadable file refuses writes and definition reads and stays as it is', () => {
    fs.writeFileSync(FILE, '{ not json')
    assert.equal(status(() => store.createFaction({ scope: 'faction', group: 'Anyone' }, ACTOR)).status, 500)
    assert.equal(fs.readFileSync(FILE, 'utf8'), '{ not json')
    // The game server keeps its last definitions instead of loading an empty table
    assert.equal(status(() => store.listDefinitions()).status, 500)
    assert.equal(status(() => store.definitions()).status, 500)
    assert.deepEqual(store.getPlayerFactionPermissions('111'), [])
  })

  await test('the loopback check refuses proxied, remote and foreign-host requests', () => {
    const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:4000', ...headers } })
    const { isDirectLoopback } = managerOrPermission
    assert.equal(isDirectLoopback(req('127.0.0.1', {})), true)
    assert.equal(isDirectLoopback(req('::1', { host: 'localhost:4000' })), true)
    assert.equal(isDirectLoopback(req('::ffff:127.0.0.1', {})), true)
    assert.equal(isDirectLoopback(req('10.0.0.5', {})), false)
    assert.equal(isDirectLoopback(req('203.0.113.9', {})), false)
    assert.equal(isDirectLoopback(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false)
    assert.equal(isDirectLoopback(req('127.0.0.1', { 'x-real-ip': '203.0.113.9' })), false)
    assert.equal(isDirectLoopback(req('127.0.0.1', { forwarded: 'for=203.0.113.9' })), false)
    assert.equal(isDirectLoopback(req('127.0.0.1', { host: 'api.alduinak.com' })), false)
  })

  resetSeed()
  const app = express()
  app.use(express.json())
  app.use('/api/factions', require('../routes/factions'))
  app.get('/definitions', (_req, res) => res.json(store.listDefinitions()))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const port = server.address().port

  const call = (method, apiPath, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, method, path: apiPath,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })

  // Sessions as a login issues them, so the live permission recompute and admin timeouts accept them
  const SESSIONS = { view: ['factions.view', 'factions.manage'], admin: ['admin.*'] }
  const ROLES = { view: ['role-view'], admin: ['role-admin'] }
  sessions.validate = token => (SESSIONS[token] ? { id: `s-${token}`, discordId: `id-${token}`, roles: ROLES[token], permissions: SESSIONS[token], createdAt: Date.now(), lastUsedAt: Date.now() } : null)
  const manager = { 'X-Auth-Token': TOKEN }

  await test('manager token works from loopback and nowhere else', async () => {
    assert.equal((await call('GET', '/api/factions')).status, 401)
    const ok = await call('GET', '/api/factions', { headers: manager })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.canDefine, true)
    assert.equal(ok.data.factions.length, 16)
    assert.equal((await call('GET', '/api/factions', { headers: { 'X-Auth-Token': 'wrong' } })).status, 403)
    assert.equal((await call('GET', '/api/factions', { headers: { ...manager, 'X-Forwarded-For': '203.0.113.9' } })).status, 403)
    assert.equal((await call('GET', '/api/factions', { headers: { ...manager, 'X-Real-IP': '203.0.113.9' } })).status, 403)
    assert.equal((await call('GET', '/api/factions', { headers: { ...manager, Host: 'api.alduinak.com' } })).status, 403)
    assert.equal((await call('GET', '/api/factions', { headers: { ...manager, Authorization: 'Bearer admin', 'X-Forwarded-For': '203.0.113.9' } })).status, 403)
  })

  await test('definitions need factions.define, which admin.* covers and factions.manage does not', async () => {
    const view = await call('GET', '/api/factions', { headers: { Authorization: 'Bearer view' } })
    assert.equal(view.status, 200)
    assert.equal(view.data.canDefine, false)
    const body = { scope: 'faction', group: 'Penitus Oculatus' }
    assert.equal((await call('POST', '/api/factions', { body, headers: { Authorization: 'Bearer view' } })).status, 403)
    const made = await call('POST', '/api/factions', { body, headers: { Authorization: 'Bearer admin' } })
    assert.equal(made.status, 201)
    assert.ok(auditLines().some(l => l.includes('actor=dashboard:id-admin') && l.includes('action=faction.create')))
    assert.equal((await call('GET', '/api/factions/HOLD/whiterun/members', { headers: manager })).status, 404)
  })

  await test('cascade confirm over HTTP', async () => {
    store.createAssignment({ requirementId: 'faction:companions:whelp', discordId: '555', slot: 2, playerName: 'Athis' }, ACTOR)
    const rev = revOf('faction:companions')
    const members = await call('GET', '/api/factions/faction/companions/members', { headers: manager })
    assert.deepEqual(members.data.members.map(m => [m.playerName, m.slot, m.rankSlug, m.discordId]), [['Athis', 2, 'whelp', '555']])
    const first = await call('DELETE', '/api/factions/faction/companions', { body: { rev }, headers: manager })
    assert.equal(first.status, 409)
    assert.equal(first.data.hasMembers, true)
    assert.equal(first.data.members, 1)
    const second = await call('DELETE', '/api/factions/faction/companions', { body: { rev, removeMembers: true, expectedMembers: first.data.members }, headers: manager })
    assert.equal(second.status, 200)
    assert.equal(second.data.removedMembers, 1)
    assert.ok(auditLines().some(l => l.includes('actor=server-manager') && l.includes('action=faction.delete')))
    const stale = await call('PATCH', '/api/factions/hold/whiterun', { body: { rev: 99, name: 'x' }, headers: manager })
    assert.equal(stale.status, 409)
    assert.equal(stale.data.stale, true)
  })

  await test('the game server ETag ignores memberships and follows definitions', async () => {
    const first = await call('GET', '/definitions')
    const etag = first.headers.etag
    assert.ok(etag)
    assert.equal(first.data.requirements.some(r => 'assigned' in r || 'remaining' in r), false)
    store.createAssignment({ requirementId: 'hold:whiterun:citizen', discordId: '666', slot: 0, playerName: 'Carlotta' }, ACTOR)
    assert.equal((await call('GET', '/definitions', { headers: { 'If-None-Match': etag } })).status, 304)
    store.updateFaction('hold:whiterun', { rev: revOf('hold:whiterun'), color: '112233' }, ACTOR)
    assert.equal((await call('GET', '/definitions', { headers: { 'If-None-Match': etag } })).status, 200)
  })

  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })

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
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
