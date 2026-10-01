'use strict'

// Faction definition store, /api/factions and the loopback-only manager token against a temp copy of the committed seed: node scripts/test-factions.js

const assert = require('node:assert/strict')
const fs     = require('fs')
const http   = require('http')
const os     = require('os')
const path   = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faction-test-'))
const TOKEN = 'test-manager-token-0123456789'
process.env.BAN_LOG_DIR = tmp
process.env.SERVER_SETTINGS_PATH = path.join(tmp, 'server-settings.json')
fs.writeFileSync(process.env.SERVER_SETTINGS_PATH, JSON.stringify({ masterApiAuthToken: TOKEN }))
process.env.ROLE_PERMISSIONS_FILE = path.join(tmp, 'role-permissions.json')
fs.writeFileSync(process.env.ROLE_PERMISSIONS_FILE, JSON.stringify({ roles: { 'role-view': { name: 'View', permissions: ['factions.view', 'factions.manage'] }, 'role-admin': { name: 'Admin', permissions: ['admin.*'] } } }))

const express  = require('express')
const store    = require('../sources/factionWhitelist')
const sessions = require('../sources/dashboardSessions')
const managerOrPermission = require('../middleware/managerOrPermission')

const SEED = path.join(__dirname, '..', 'test', 'fixtures', 'faction-whitelist.json')
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
// The factions document in the memory-only store (no db.init here)
const doc = require('../sources/db').store('factions')
const readFile = () => doc.get('whitelist')
const writeFile = data => doc.set('whitelist', data)
const auditLines = () => (fs.existsSync(path.join(tmp, 'faction.log')) ? fs.readFileSync(path.join(tmp, 'faction.log'), 'utf8').trim().split('\n') : [])

function resetSeed() {
  writeFile(JSON.parse(fs.readFileSync(SEED, 'utf8')))
  doc.delete('whitelist.bak')
  fs.rmSync(path.join(tmp, 'faction.log'), { force: true })
}

// The hold ladder of the 2026-09-19 spec, craft on the Captain only since r15: slug -> [capacity, recruit, promote, permissions]
const HOLD_LADDER = {
  jarl: [1, [], [], ['leader']],
  noble: [null, [], [], []],
  steward: [4, ['citizen'], ['chieftan', 'courtier'], ['housing']],
  captain: [4, ['guard'], [], ['craft', 'arrest', 'execute']],
  courtier: [10, [], [], []],
  thane: [5, ['citizen'], ['housecarl', 'guard'], []],
  housecarl: [10, [], [], ['arrest']],
  guard: [40, [], [], ['arrest']],
  chieftan: [5, ['citizen'], [], []],
  citizen: [null, [], [], []],
}

const FACTION_COUNT = 19
const PERMISSIONS = ['leader', 'remove', 'craft', 'housing', 'arrest', 'execute']

async function run() {
  await test('the seed loads with the spec ladders, types and permissions', () => {
    resetSeed()
    const { factions } = store.definitions()
    assert.equal(factions.length, FACTION_COUNT)
    const byType = {}
    for (const f of factions) byType[f.type] = (byType[f.type] || 0) + 1
    assert.deepEqual(byType, { hold: 9, military: 5, guild: 5 })
    for (const court of factions.filter(f => f.type === 'hold')) {
      assert.deepEqual(court.ranks.map(r => r.id.split(':')[2]), Object.keys(HOLD_LADDER), court.id)
      for (const rank of court.ranks) {
        const [capacity, recruit, promote, permissions] = HOLD_LADDER[rank.id.split(':')[2]]
        assert.equal(rank.capacity, capacity, `${rank.id} capacity`)
        assert.deepEqual(rank.recruit, recruit, `${rank.id} recruit`)
        assert.deepEqual(rank.promote, promote, `${rank.id} promote`)
        for (const key of PERMISSIONS) assert.equal(rank[key], permissions.includes(key), `${rank.id} ${key}`)
        assert.equal(rank.factionAccess, true)
      }
    }
    assert.equal(rankOf('faction:companions', 'guildmaster').housing, false)
    assert.equal(rankOf('faction:companions', 'guildmaster').leader, true)
    // The Legion leads with three ranks, so any of them blocks a second leadership
    assert.deepEqual(store.definitions().factions.find(f => f.id === 'faction:imperial-legion').ranks.filter(r => r.leader).map(r => r.id.split(':')[2]), ['general', 'legate', 'tribune'])
  })

  await test('faction validation', () => {
    resetSeed()
    assert.equal(status(() => store.createFaction({ type: 'army', group: 'Vigilants' }, ACTOR)).status, 400)
    // A territory outside the nine holds exists without Skyrim land
    const landless = store.createFaction({ type: 'hold', group: 'Solstheim' }, ACTOR).faction
    assert.equal(landless.id, 'hold:solstheim')
    assert.equal(landless.land, '')
    assert.equal(store.definitions().factions.find(f => f.id === 'hold:the-rift').land, 'rift')
    assert.equal(status(() => store.createFaction({ type: 'hold', group: 'The Solstheim' }, ACTOR)).status, 409)
    assert.match(status(() => store.createFaction({ type: 'hold', group: 'Rift' }, ACTOR)).message, /already the territory of that hold/)
    assert.equal(status(() => store.createFaction({ type: 'guild', group: '!!!' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'Vigilants', color: 'red' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createFaction({ type: 'military', group: 'Legion Two', name: 'imperial legion' }, ACTOR)).status, 409)
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'Companions' }, ACTOR)).status, 409)
    const { faction } = store.createFaction({ type: 'guild', group: 'Vigilants of Stendarr', color: '#AABBCC', zone: 'neutral' }, ACTOR)
    assert.equal(faction.id, 'faction:vigilants-of-stendarr')
    assert.equal(faction.type, 'guild')
    // A court never becomes a guild, and the other way round
    assert.equal(status(() => store.updateFaction(faction.id, { rev: 1, type: 'hold' }, ACTOR)).status, 400)
    assert.equal(store.updateFaction(faction.id, { rev: 1, type: 'military' }, ACTOR).faction.type, 'military')
    assert.equal(faction.color, 'aabbcc')
    assert.equal(faction.rev, 1)
    assert.equal(status(() => store.updateFaction(faction.id, { name: 'X' }, ACTOR)).status, 400)
    assert.equal(store.updateFaction(faction.id, { rev: 2, name: 'The Vigilants' }, ACTOR).faction.rev, 3)
    assert.equal(faction.zone, undefined)
    assert.equal(faction.province, 'Skyrim')
  })

  await test('province is validated, defaulted by name and saved on the next write', () => {
    resetSeed()
    const raw = readFile()
    raw.factions.push({ id: 'faction:house-telvanni', scope: 'faction', type: 'guild', group: 'House Telvanni', name: 'House Telvanni', zone: 'east', rev: 1 })
    raw.factions.push({ id: 'faction:aldmeri-dominion', scope: 'faction', type: 'military', group: 'Aldmeri Dominion', name: 'Aldmeri Dominion', rev: 1 })
    writeFile(raw)
    const byId = id => store.definitions().factions.find(f => f.id === id)
    assert.equal(byId('faction:house-telvanni').province, 'Morrowind')
    assert.equal(byId('faction:aldmeri-dominion').province, 'Summerset')
    assert.equal(byId('faction:thalmor').province, 'Summerset')
    assert.equal(byId('faction:imperial-legion').province, 'Cyrodiil')
    assert.equal(byId('faction:companions').province, 'Skyrim')
    assert.equal(byId('faction:house-telvanni').zone, undefined)
    assert.ok(store.definitions().provinces.includes('Black Marsh'))
    assert.equal(readFile().factions.find(f => f.id === 'faction:aldmeri-dominion').province, undefined)
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'Vigilants', province: 'Atmora' }, ACTOR)).status, 400)
    assert.equal(store.createFaction({ type: 'guild', group: 'Mythic Dawn' }, ACTOR).faction.province, 'Cyrodiil')
    assert.equal(store.createFaction({ type: 'guild', group: 'Vigilants', province: 'high rock' }, ACTOR).faction.province, 'High Rock')
    assert.equal(status(() => store.updateFaction('faction:aldmeri-dominion', { rev: 1, province: 'Tamriel' }, ACTOR)).status, 400)
    assert.equal(store.updateFaction('faction:aldmeri-dominion', { rev: 1, province: 'Elsweyr' }, ACTOR).faction.province, 'Elsweyr')
    const saved = readFile().factions
    assert.equal(saved.find(f => f.id === 'faction:house-telvanni').province, 'Morrowind')
    assert.equal(saved.find(f => f.id === 'faction:house-telvanni').zone, undefined)
    assert.equal(saved.find(f => f.id === 'faction:aldmeri-dominion').province, 'Elsweyr')
  })

  await test('permission strings follow the rank id and cannot be set', () => {
    resetSeed()
    const id = 'faction:companions'
    for (const permission of ['hold.whiterun.jarl', 'admin.*', '*', 'faction.thalmor.initiate']) {
      assert.equal(status(() => store.createRank(id, { rev: revOf(id), rank: 'Shield Brother', permission }, ACTOR)).status, 400, permission)
      assert.equal(status(() => store.updateRank(`${id}:member`, { rev: revOf(id), permission }, ACTOR)).status, 400, permission)
    }
    const { faction } = store.createRank(id, { rev: revOf(id), rank: 'Shield Brother', permission: 'faction.companions.shield-brother' }, ACTOR)
    assert.equal(faction.ranks.find(r => r.id === `${id}:shield-brother`).permission, 'faction.companions.shield-brother')
    assert.equal(store.updateRank(`${id}:member`, { rev: faction.rev, permission: '' }, ACTOR).faction.rev, faction.rev)

    // A hand-edited custom or wildcard string never reaches the game server
    const data = readFile()
    Object.assign(data.requirements.find(r => r.id === `${id}:member`), { permission: 'admin.*' })
    writeFile(data)
    store.createAssignment({ requirementId: `${id}:member`, discordId: '777', slot: 0, playerName: 'Farkas' }, ACTOR)
    assert.deepEqual(store.getPlayerFactionPermissions('777'), ['faction.companions.member'])
    assert.equal(store.getPlayerGameFactions('777')[0].permission, 'faction.companions.member')
    assert.equal(store.listDefinitions().requirements.find(r => r.id === `${id}:member`).permission, 'faction.companions.member')
    assert.equal(readFile().requirements.find(r => r.id === `${id}:member`).permission, 'faction.companions.member', 'the next write stores the derived string')
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
    assert.equal(status(() => store.createRank(id, { rev, rank: 'Shield-Brother', recruit: ['nobody'] }, ACTOR)).status, 400)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'Shield-Brother', craft: 'yes' }, ACTOR)).status, 400)
    assert.equal(status(() => store.createRank(id, { rev, rank: 'member' }, ACTOR)).status, 409)
    const { faction } = store.createRank(id, { rev, rank: 'Shield Brother', capacity: 3, recruit: ['member', 'guildmaster'], promote: ['member'], craft: true, housing: true }, ACTOR)
    const rank = faction.ranks.find(r => r.id === `${id}:shield-brother`)
    assert.equal(faction.rev, rev + 1)
    assert.equal(rank.order, faction.ranks.length - 1)
    assert.deepEqual(rank.recruit, ['member'], 'nobody is recruited straight into a leader seat')
    assert.deepEqual(rank.promote, ['member'])
    assert.equal(rank.craft, true)
    assert.equal(rank.housing, true, 'a guild rank may manage its faction claims')
    assert.equal(rank.leader, false)
    assert.equal(status(() => store.updateRank(`${id}:shield-brother`, { rev: faction.rev, rank: 'Member' }, ACTOR)).status, 409)
    const court = store.updateRank('hold:whiterun:guard', { rev: revOf('hold:whiterun'), housing: true }, ACTOR).faction
    assert.equal(court.ranks.find(r => r.id === 'hold:whiterun:guard').housing, true)
  })

  await test('rank reorder needs every rank once', () => {
    resetSeed()
    const id = 'faction:thalmor'
    const ladder = store.definitions().factions.find(f => f.id === id).ranks.map(r => r.id.split(':')[2])
    const rev = revOf(id)
    assert.equal(status(() => store.reorderRanks(id, { rev, ranks: ladder.slice(1) }, ACTOR)).status, 400)
    assert.equal(status(() => store.reorderRanks(id, { rev, ranks: [ladder[0], ...ladder] }, ACTOR)).status, 400)
    const { faction } = store.reorderRanks(id, { rev, ranks: [...ladder].reverse() }, ACTOR)
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
    assert.ok(data.requirements.filter(r => r.id.startsWith('hold:whiterun:')).every(r => !(r.recruit || []).includes('guard')), 'the rank leaves every recruit list')
    assert.ok(doc.has('whitelist.bak'))
    const lines = auditLines()
    assert.equal(lines.filter(l => l.includes('action=member.remove') && l.includes(`requirement=${rankId}`)).length, 2)
    assert.ok(lines.some(l => l.includes('action=rank.delete') && l.includes('removedMembers=2')))
  })

  await test('deleting an empty rank or faction needs no confirmation', () => {
    resetSeed()
    const rev = revOf('faction:thalmor')
    assert.equal(store.deleteRank('faction:thalmor:enforcer', { rev }, ACTOR).removedMembers, 0)
    assert.equal(store.deleteFaction('faction:thalmor', { rev: rev + 1 }, ACTOR).removedMembers, 0)
    assert.ok(!doc.has('whitelist.bak'))
  })

  await test('deleted ids are tombstoned and never reused, and survive the wipe', () => {
    resetSeed()
    store.createAssignment({ requirementId: 'faction:thieves-guild:runner', discordId: '444', slot: 0, playerName: 'Vex' }, ACTOR)
    const rev = revOf('faction:thieves-guild')
    assert.equal(status(() => store.deleteFaction('faction:thieves-guild', { rev }, ACTOR)).extra.members, 1)
    store.deleteFaction('faction:thieves-guild', { rev, removeMembers: '1', expectedMembers: '1' }, ACTOR)
    const retired = readFile().retired
    assert.ok(retired.factions.includes('faction:thieves-guild'))
    assert.ok(retired.ranks.includes('faction:thieves-guild:runner'))
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'Thieves Guild' }, ACTOR)).status, 409)
    assert.ok(store.createFaction({ type: 'guild', group: 'Thieves Guild of Riften' }, ACTOR).faction)

    const courtRev = revOf('hold:the-pale')
    store.deleteRank('hold:the-pale:courtier', { rev: courtRev }, ACTOR)
    assert.equal(status(() => store.createRank('hold:the-pale', { rev: courtRev + 1, rank: 'Courtier' }, ACTOR)).status, 409)

    // A deleted court retires its hold under either spelling
    store.deleteFaction('hold:the-rift', { rev: revOf('hold:the-rift') }, ACTOR)
    for (const group of ['The Rift', 'Rift']) {
      const refused = status(() => store.createFaction({ type: 'hold', group }, ACTOR))
      assert.equal(refused.status, 409, group)
      assert.match(refused.message, /hold:the-rift/)
    }
    assert.ok(store.createFaction({ type: 'guild', group: 'Rift' }, ACTOR).faction, 'only hold courts share a hold key')

    // wipe-world.js keeps every key but assignments
    const wiped = { ...readFile(), assignments: [] }
    writeFile(wiped)
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'Thieves Guild' }, ACTOR)).status, 409)
  })

  await test('one faction of each type, one leader seat anywhere, and regency seats follow membership', () => {
    resetSeed()
    const join = (requirementId, discordId, slot, playerName) => store.createAssignment({ requirementId, discordId, slot, playerName }, ACTOR)
    join('hold:whiterun:guard', '111', 0, 'Lydia')
    assert.equal(status(() => join('hold:the-rift:citizen', '111', 0, 'Lydia')).status, 409, 'two courts')
    assert.ok(join('faction:companions:member', '111', 0, 'Lydia'), 'a guild as well as a court')
    assert.ok(join('faction:stormcloaks:soldier', '111', 0, 'Lydia'), 'and an army')
    assert.equal(status(() => join('faction:thalmor:initiate', '111', 0, 'Lydia')).status, 409, 'two armies')
    // Another character of the same account joins whatever it likes
    assert.ok(join('hold:the-rift:citizen', '111', 1, 'Lydia the Second'))

    join('hold:whiterun:jarl', '222', 0, 'Balgruuf')
    assert.equal(status(() => join('faction:imperial-legion:general', '222', 0, 'Balgruuf')).status, 409, 'two leaderships')
    assert.ok(join('faction:companions:guildmaster', '333', 0, 'Kodlak'))

    store.setRegency('hold:whiterun', { enabled: true, regents: [{ discordId: '111', slot: 0 }] }, ACTOR)
    assert.equal(status(() => store.setRegency('hold:whiterun', { regents: [{ discordId: '222', slot: 0 }] }, ACTOR)).status, 400, 'the leader needs no seat')
    assert.equal(status(() => store.setRegency('hold:whiterun', { regents: [{ discordId: '333', slot: 0 }] }, ACTOR)).status, 400, 'an outsider holds no seat')
    assert.equal(status(() => join('faction:imperial-legion:general', '111', 0, 'Lydia')).status, 409, 'a regent never leads')

    const seated = store.definitions().factions.find(f => f.id === 'hold:whiterun')
    assert.equal(seated.regencyEnabled, true)
    assert.deepEqual(seated.regents, [{ discordId: '111', slot: 0 }])
    // Losing the membership loses the seat
    const row = store.getPlayerAssignments('111').find(a => a.requirementId === 'hold:whiterun:guard')
    store.deleteAssignment(row.id, ACTOR)
    assert.deepEqual(store.definitions().factions.find(f => f.id === 'hold:whiterun').regents, [])
  })

  // A Morrowind house guild as add-craft-factions.js made it, with members, a regent and one member also in Eastmarch
  function seedHouse() {
    resetSeed()
    let { faction } = store.createFaction({ type: 'guild', group: 'House Indoril', province: 'Morrowind', color: '445566' }, ACTOR)
    ;({ faction } = store.createRank(faction.id, { rev: faction.rev, rank: 'Leader', leader: true, craft: true, title: 'Grandmaster' }, ACTOR))
    ;({ faction } = store.createRank(faction.id, { rev: faction.rev, rank: 'Steward', craft: true, housing: false }, ACTOR))
    ;({ faction } = store.createRank(faction.id, { rev: faction.rev, rank: 'Member', capacity: 20 }, ACTOR))
    ;({ faction } = store.updateRank(`${faction.id}:steward`, { rev: faction.rev, recruit: ['member'] }, ACTOR))
    store.createAssignment({ requirementId: 'faction:house-indoril:leader', discordId: '901', slot: 0, playerName: 'Helseth' }, ACTOR)
    store.createAssignment({ requirementId: 'faction:house-indoril:steward', discordId: '902', slot: null, playerName: 'Brara' }, ACTOR)
    store.createAssignment({ requirementId: 'faction:house-indoril:member', discordId: '903', slot: 1, playerName: 'Athyn' }, ACTOR)
    store.createAssignment({ requirementId: 'hold:eastmarch:citizen', discordId: '903', slot: 1, playerName: 'Athyn' }, ACTOR)
    store.createAssignment({ requirementId: 'hold:eastmarch:citizen', discordId: '903', slot: 2, playerName: 'Athyn Two' }, ACTOR)
    store.setRegency('faction:house-indoril', { enabled: true, regents: [{ discordId: '902', slot: null }] }, ACTOR)
    return store.definitions().factions.find(f => f.id === 'faction:house-indoril')
  }
  const convertInput = (house, extra = {}) => ({ rev: house.rev, type: 'hold', group: 'Indoril', expectedMembers: house.members, ...extra })

  await test('a dry run reports the conversion and its clashes and changes nothing', () => {
    const house = seedHouse()
    const before = JSON.stringify(readFile())
    const plan = store.convertFaction(house.id, convertInput(house, { dryRun: true }), ACTOR)
    assert.equal(JSON.stringify(readFile()), before)
    assert.equal(plan.dryRun, true)
    assert.equal(plan.to, 'hold:indoril')
    assert.deepEqual(plan.ranks.map(r => [r.from, r.to, r.members]), [
      ['faction:house-indoril:leader', 'hold:indoril:leader', 1], ['faction:house-indoril:steward', 'hold:indoril:steward', 1], ['faction:house-indoril:member', 'hold:indoril:member', 1],
    ])
    assert.deepEqual(plan.clashes.map(c => [c.factionId, c.playerName, c.slot, c.released]), [['hold:eastmarch', 'Athyn', 1, false]], 'slot 2 does not overlap slot 1')
    assert.equal(plan.faction.name, 'House Indoril')
    assert.equal(plan.faction.land, '')
    assert.equal(status(() => store.convertFaction(house.id, convertInput(house), ACTOR)).status, 409, 'an unreleased clash refuses')
    assert.equal(status(() => store.convertFaction(house.id, convertInput(house, { expectedMembers: 2 }), ACTOR)).status, 409)
    assert.equal(status(() => store.convertFaction(house.id, convertInput(house, { group: 'House Indoril', type: 'guild' }), ACTOR)).status, 400, 'the same id')
    const stray = store.getPlayerAssignments('901')[0].id
    assert.equal(status(() => store.convertFaction(house.id, convertInput(house, { release: [stray] }), ACTOR)).status, 400, 'only clashing rows are released')
    assert.equal(status(() => store.convertFaction(house.id, convertInput(house, { group: 'Rift' }), ACTOR)).status, 409, 'a Skyrim hold keeps its one territory')
    assert.equal(JSON.stringify(readFile()), before)
  })

  await test('a conversion moves every member and permission, releases the clash and retires the guild', () => {
    const house = seedHouse()
    const before = readFile()
    const plan = store.convertFaction(house.id, convertInput(house, { dryRun: true }), ACTOR)
    const done = store.convertFaction(house.id, convertInput(house, { release: plan.clashes.map(c => c.assignmentId) }), ACTOR)
    assert.equal(done.dryRun, false)
    const { factions } = store.definitions()
    assert.ok(!factions.some(f => f.id === house.id))
    const territory = factions.find(f => f.id === 'hold:indoril')
    assert.equal(territory.type, 'hold')
    assert.equal(territory.name, 'House Indoril')
    assert.equal(territory.province, 'Morrowind')
    assert.equal(territory.color, '445566')
    assert.equal(territory.members, 3)
    assert.equal(territory.regencyEnabled, true)
    assert.deepEqual(territory.regents, [{ discordId: '902', slot: null }])
    const oldRanks = house.ranks
    for (const rank of territory.ranks) {
      const old = oldRanks.find(r => r.id === `${house.id}:${rank.id.split(':')[2]}`)
      for (const key of ['rank', 'order', 'capacity', 'leader', 'remove', 'craft', 'housing', 'arrest', 'execute', 'factionAccess', 'title', 'titleFemale']) assert.deepEqual(rank[key], old[key], `${rank.id} ${key}`)
      assert.deepEqual(rank.recruit, old.recruit)
      assert.equal(rank.permission, rank.id.split(':').join('.'))
    }
    // The steward slug would default to housing in a territory; the copy keeps the guild's own flag
    assert.equal(territory.ranks.find(r => r.id === 'hold:indoril:steward').housing, false)
    const data = readFile()
    const moved = data.assignments.filter(a => a.requirementId.startsWith('hold:indoril:'))
    assert.deepEqual(moved.map(a => [a.discordId, a.slot, a.requirementId]).sort(), [['901', 0, 'hold:indoril:leader'], ['902', null, 'hold:indoril:steward'], ['903', 1, 'hold:indoril:member']])
    for (const a of moved) {
      const was = before.assignments.find(b => b.id === a.id)
      assert.equal(was.createdAt, a.createdAt, 'tenure is kept')
    }
    assert.deepEqual(data.assignments.filter(a => a.requirementId.startsWith('hold:eastmarch:')).map(a => a.slot), [2], 'only the clashing Eastmarch row left')
    assert.ok(data.retired.factions.includes(house.id))
    assert.ok(data.retired.ranks.includes('faction:house-indoril:leader'))
    assert.deepEqual(data.successors, { 'faction:house-indoril': 'hold:indoril' })
    assert.deepEqual(store.listDefinitions().successors, { 'faction:house-indoril': 'hold:indoril' })
    assert.ok(doc.has('whitelist.bak'))
    const lines = auditLines()
    assert.ok(lines.some(l => l.includes('action=faction.convert') && l.includes('to=hold:indoril') && l.includes('moved=3') && l.includes('released=1')))
    assert.equal(lines.filter(l => l.includes('action=member.move')).length, 3)
    assert.ok(lines.some(l => l.includes('action=member.remove') && l.includes('requirement=hold:eastmarch:citizen')))
    // The old id is never reused, and a second hold-type membership is refused as usual
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'House Indoril' }, ACTOR)).status, 409)
    assert.match(status(() => store.createAssignment({ requirementId: 'hold:eastmarch:citizen', discordId: '903', slot: 1 }, ACTOR)).message, /one territory faction at a time/)
  })

  await test('roster rows carry the join date so the menu can show tenure', () => {
    resetSeed()
    store.createAssignment({ requirementId: 'hold:whiterun:guard', discordId: '111', slot: 0, playerName: 'Lydia' }, ACTOR)
    const [member] = store.getFactionRoster('hold:whiterun')
    assert.ok(Date.parse(member.since) > 0, 'the roster row names when the rank was granted')
    assert.ok(Date.parse(store.namedRoster(store.getFactionRoster('hold:whiterun'))[0].since) > 0)
  })

  await test('a malformed document refuses writes and definition reads and stays as it is', () => {
    writeFile('{ not json')
    assert.equal(status(() => store.createFaction({ type: 'guild', group: 'Anyone' }, ACTOR)).status, 500)
    assert.equal(readFile(), '{ not json')
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
    assert.equal(ok.data.factions.length, FACTION_COUNT)
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
    const body = { type: 'guild', group: 'Penitus Oculatus' }
    assert.equal((await call('POST', '/api/factions', { body, headers: { Authorization: 'Bearer view' } })).status, 403)
    const made = await call('POST', '/api/factions', { body, headers: { Authorization: 'Bearer admin' } })
    assert.equal(made.status, 201)
    assert.ok(auditLines().some(l => l.includes('actor=dashboard:id-admin') && l.includes('action=faction.create')))
    assert.equal((await call('GET', '/api/factions/HOLD/whiterun/members', { headers: manager })).status, 404)
  })

  await test('cascade confirm over HTTP', async () => {
    store.createAssignment({ requirementId: 'faction:companions:member', discordId: '555', slot: 2, playerName: 'Athis' }, ACTOR)
    const rev = revOf('faction:companions')
    const members = await call('GET', '/api/factions/faction/companions/members', { headers: manager })
    assert.deepEqual(members.data.members.map(m => [m.playerName, m.slot, m.rankSlug, m.discordId]), [['Athis', 2, 'member', '555']])
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

  await test('convert over HTTP with the manager token', async () => {
    const house = seedHouse()
    const body = convertInput(house, { dryRun: true })
    assert.equal((await call('POST', '/api/factions/faction/house-indoril/convert', { body, headers: { Authorization: 'Bearer view' } })).status, 403)
    const plan = await call('POST', '/api/factions/faction/house-indoril/convert', { body, headers: manager })
    assert.equal(plan.status, 200)
    assert.equal(plan.data.clashes.length, 1)
    const refused = await call('POST', '/api/factions/faction/house-indoril/convert', { body: { ...body, dryRun: false }, headers: manager })
    assert.equal(refused.status, 409)
    assert.equal(refused.data.clashes[0].factionId, 'hold:eastmarch')
    const done = await call('POST', '/api/factions/faction/house-indoril/convert', { body: { ...body, dryRun: false, release: [plan.data.clashes[0].assignmentId] }, headers: manager })
    assert.equal(done.status, 200)
    assert.equal(done.data.to, 'hold:indoril')
    assert.ok(auditLines().some(l => l.includes('actor=server-manager') && l.includes('action=faction.convert')))
    resetSeed()
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
