'use strict'

// factionRules.ts against the committed seed: types, capacities, the permission model and titles: node tools/test-faction-rules.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'factionRules.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false })
const compiled = new Module(source)
compiled._compile(outputFiles[0].text, source)
const rules = compiled.exports

const seed = require('../../skymp5-backend/seeds/faction-whitelist.json')

// The ladders of the 2026-09-19 spec, craft on the Captain only since r15: rank slug -> [capacity, permissions the rank carries]
const HOLD_LADDER = [
  ['jarl', 1, ['leader']],
  ['noble', null, []],
  ['steward', 4, ['housing']],
  ['captain', 4, ['craft', 'arrest', 'execute']],
  ['courtier', 10, []],
  ['thane', 5, []],
  ['housecarl', 10, ['arrest']],
  ['guard', 40, ['arrest']],
  ['chieftan', 5, []],
  ['citizen', null, []],
]

const TYPES = {
  hold: 9,
  military: 5,
  guild: 5,
}

const PERMISSIONS = ['remove', 'craft', 'housing', 'arrest', 'execute']

const results = []
function test(name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

const factions = rules.buildFactions(seed)
const slugOf = rank => (rank ? rank.slug : null)
const as = (faction, slug) => ({ staff: false, rank: rules.rankOf(faction, slug), acting: false })
const STAFF = { staff: true, rank: null, acting: false }

test('every faction carries a type, and the counts match the spec', () => {
  const counted = {}
  for (const f of factions.values()) counted[f.type] = (counted[f.type] || 0) + 1
  assert.deepEqual(counted, TYPES)
  for (const f of factions.values()) {
    assert.equal(f.type === 'hold', f.scope === 'hold', `${f.id} scope and type disagree`)
    assert.ok(f.ranks.length > 0, `${f.id} has no ranks`)
    assert.ok(f.ranks[0].leader, `${f.id} does not start with a leader rank`)
  }
})

test('the hold ladder matches the spec, rank for rank', () => {
  const courts = [...factions.values()].filter(f => f.type === 'hold')
  assert.equal(courts.length, 9)
  for (const court of courts) {
    assert.deepEqual(court.ranks.map(r => r.slug), HOLD_LADDER.map(([slug]) => slug), court.id)
    for (const [slug, capacity, permissions] of HOLD_LADDER) {
      const rank = rules.rankOf(court, slug)
      assert.equal(rank.capacity, capacity, `${court.id} ${slug} capacity`)
      for (const key of PERMISSIONS) {
        assert.equal(rank[key], permissions.includes(key), `${court.id} ${slug} ${key}`)
      }
    }
    assert.deepEqual(rules.rankOf(court, 'steward').promote, ['chieftan', 'courtier'])
    assert.deepEqual(rules.rankOf(court, 'thane').promote, ['housecarl', 'guard'])
    assert.deepEqual(rules.rankOf(court, 'captain').recruit, ['guard'])
    // A Noble is a Lord or a Lady, never "Noble", once Show Title is on
    assert.equal(rules.titleOf(court, rules.rankOf(court, 'noble'), false, false), 'Lord')
    assert.equal(rules.titleOf(court, rules.rankOf(court, 'noble'), false, true), 'Lady')
    assert.equal(rules.titleOf(court, rules.rankOf(court, 'jarl'), false, true), 'Jarl')
  }
})

test('army and guild ladders keep the seats the spec gives them', () => {
  const capacityOf = (id, slug) => rules.rankOf(factions.get(id), slug).capacity
  assert.equal(capacityOf('faction:imperial-legion', 'tribune'), 3)
  assert.equal(capacityOf('faction:imperial-legion', 'auxiliary'), null)
  assert.equal(capacityOf('faction:stormcloaks', 'soldier'), 49)
  assert.equal(capacityOf('faction:thalmor', 'emissary'), 2)
  assert.equal(capacityOf('faction:thieves-guild', 'initiate'), null)
  assert.equal(capacityOf('faction:dark-brotherhood', 'assassin'), 19)
  // Small armies hold 20 and large ones 50, counting only the capped ranks
  const capped = id => factions.get(id).ranks.reduce((sum, r) => sum + (r.capacity || 0), 0)
  assert.equal(capped('faction:imperial-legion'), 50)
  assert.equal(capped('faction:stormcloaks'), 50)
  assert.equal(capped('faction:thalmor'), 20)
  assert.equal(capped('faction:forsworn'), 20)
  assert.equal(capped('faction:dawnguard'), 20)
  assert.equal(capped('faction:companions'), 20)
  assert.equal(capped('faction:college-of-winterhold'), 20)
  assert.equal(capped('faction:thieves-guild'), 20)
  assert.equal(capped('faction:bards-college'), 20)
  // The Legion's three top ranks all lead, so any of them blocks a second leadership
  assert.deepEqual(rules.leaderRanks(factions.get('faction:imperial-legion')).map(slugOf), ['general', 'legate', 'tribune'])
  assert.deepEqual(rules.leaderRanks(factions.get('faction:thalmor')).map(slugOf), ['emissary'])
})

test('a leader carries every permission, a plain member none', () => {
  const court = factions.get('hold:whiterun')
  const jarl = as(court, 'jarl')
  const citizen = as(court, 'citizen')
  for (const key of PERMISSIONS) {
    assert.equal(rules.hasPermission(jarl, key), true, `jarl ${key}`)
    assert.equal(rules.hasPermission(citizen, key), false, `citizen ${key}`)
    assert.equal(rules.hasPermission(STAFF, key), true, `staff ${key}`)
  }
  // A regent standing in for an absent leader acts with the same rights, under the regent title
  const acting = { staff: false, rank: rules.rankOf(court, 'guard'), acting: true }
  for (const key of PERMISSIONS) assert.equal(rules.hasPermission(acting, key), true, `acting ${key}`)
  assert.equal(rules.titleOf(court, rules.rankOf(court, 'guard'), true, false), 'Lord Regent')
  assert.equal(rules.titleOf(factions.get('faction:stormcloaks'), rules.rankOf(factions.get('faction:stormcloaks'), 'soldier'), true, false), 'Acting Commander')
  assert.equal(rules.titleOf(factions.get('faction:companions'), rules.rankOf(factions.get('faction:companions'), 'member'), true, false), 'Acting Guildmaster')
})

test('Recruit takes the lowest rank the recruiter may recruit into', () => {
  const court = factions.get('hold:whiterun')
  assert.equal(slugOf(rules.recruitRankFor(court, as(court, 'steward'))), 'citizen')
  assert.equal(slugOf(rules.recruitRankFor(court, as(court, 'captain'))), 'guard')
  assert.equal(rules.recruitRankFor(court, as(court, 'courtier')), null)
  // A leader recruits into anything but a leader seat, so Recruit lands on the bottom rank
  assert.equal(slugOf(rules.recruitRankFor(court, as(court, 'jarl'))), 'citizen')
  assert.ok(rules.recruitableRanks(court, as(court, 'jarl')).every(r => !r.leader))
  assert.equal(rules.recruitRankFor(court, { staff: false, rank: null, acting: false }), null)
  const legion = factions.get('faction:imperial-legion')
  assert.equal(slugOf(rules.recruitRankFor(legion, as(legion, 'prefect'))), 'auxiliary')
  assert.equal(slugOf(rules.recruitRankFor(legion, as(legion, 'optio'))), 'auxiliary')
  assert.equal(rules.recruitRankFor(legion, as(legion, 'centurion')), null)
})

test('a rank acts only on members below it, and only lands them on its promote list', () => {
  const court = factions.get('hold:whiterun')
  const rank = slug => rules.rankOf(court, slug)
  const steward = as(court, 'steward')
  assert.equal(rules.canActOn(steward, rank('guard')), true)
  assert.equal(rules.canActOn(steward, rank('steward')), false, 'nobody acts on their own rank')
  assert.equal(rules.canActOn(steward, rank('jarl')), false)
  assert.deepEqual(rules.promoteTargets(court, steward, rank('citizen')).map(slugOf), ['courtier', 'chieftan'])
  assert.deepEqual(rules.promoteTargets(court, steward, rank('courtier')).map(slugOf), ['chieftan'], 'the member itself is never a target')
  assert.deepEqual(rules.promoteTargets(court, steward, rank('noble')), [], 'a Noble outranks the Steward')
  const thane = as(court, 'thane')
  assert.deepEqual(rules.promoteTargets(court, thane, rank('citizen')).map(slugOf), ['housecarl', 'guard'])
  assert.equal(rules.canSetRank(court, thane, rank('citizen'), rank('courtier')), false)
  // The Jarl places anyone anywhere below itself
  const jarl = as(court, 'jarl')
  assert.deepEqual(rules.promoteTargets(court, jarl, rank('citizen')).map(slugOf), court.ranks.filter(r => r.slug !== 'citizen').map(slugOf))
  assert.equal(rules.canSetRank(court, jarl, rank('citizen'), rank('citizen')), false)
})

test('removal needs both the reach and the remove permission', () => {
  const court = factions.get('hold:whiterun')
  const rank = slug => rules.rankOf(court, slug)
  assert.equal(rules.canRemove(court, as(court, 'jarl'), rank('guard')), true)
  assert.equal(rules.canRemove(court, as(court, 'steward'), rank('guard')), false, 'the Steward may not remove anyone')
  assert.equal(rules.canRemove(court, STAFF, rank('jarl')), true)
  const college = factions.get('faction:college-of-winterhold')
  assert.equal(rules.canRemove(college, as(college, 'headmaster'), rules.rankOf(college, 'student')), true)
  assert.equal(rules.canRemove(college, as(college, 'headmaster'), rules.rankOf(college, 'master-wizard')), false)
  assert.equal(rules.canRemove(college, as(college, 'student'), rules.rankOf(college, 'student')), false)
  // Only a leader seats regents; an acting regent is a stand-in, not a leader
  assert.equal(rules.canManageRegency(as(court, 'jarl')), true)
  assert.equal(rules.canManageRegency(as(court, 'steward')), false)
  assert.equal(rules.canManageRegency({ staff: false, rank: rank('steward'), acting: true }), false)
  assert.equal(rules.canManageRegency(STAFF), true)
})

test('memberships carry their join date, and hold managers follow the housing flag', () => {
  const court = factions.get('hold:whiterun')
  assert.equal(rules.managesHold(undefined, 'steward'), true)
  assert.equal(rules.managesHold(undefined, 'thane'), false)
  assert.equal(rules.managesHold(court, 'steward'), true)
  assert.equal(rules.managesHold(court, 'guard'), false)
  assert.equal(rules.managesHold(court, 'retired-rank'), false)
  assert.equal(rules.managesHold(null, 'jarl'), false)
  const holds = rules.holdRanksOf({ factions: [{ requirementId: 'hold:the-rift:jarl', slot: 0 }] })
  assert.deepEqual(holds, [{ factionId: 'hold:the-rift', hold: 'rift', rank: 'jarl' }])
  const mine = rules.membershipsOf({ factions: [{ requirementId: 'hold:the-rift:jarl', slot: 0, createdAt: '2026-09-01T00:00:00.000Z' }] })
  assert.equal(mine[0].since, Date.parse('2026-09-01T00:00:00.000Z'))
  assert.equal(rules.membershipsOf({ factions: [{ requirementId: 'hold:the-rift:jarl', slot: 0 }] })[0].since, 0)
})

test('regency seats and the enabled switch survive the definitions round trip', () => {
  const raw = JSON.parse(JSON.stringify(seed))
  const record = raw.factions.find(f => f.id === 'hold:whiterun')
  record.regencyEnabled = true
  record.regents = [{ profileId: 7, slot: 0 }, { profileId: 9, slot: null }, { profileId: 0, slot: 0 }]
  const court = rules.buildFactions(raw).get('hold:whiterun')
  assert.equal(court.regencyEnabled, true)
  assert.deepEqual(court.regents, [{ profileId: 7, slot: 0 }, { profileId: 9, slot: null }])
  assert.equal(factions.get('hold:the-rift').regencyEnabled, false)
  assert.deepEqual(factions.get('hold:the-rift').regents, [])
})

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
