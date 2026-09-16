'use strict'

// factionRules.ts against the committed seed: the HoldClaims appoint matrix, the pre-split rules, the split lists and flags: node tools/test-faction-rules.js

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

// HoldClaims::CanAppoint from skymp5-server/cpp/server_guest_lib/HoldClaims.cpp
const HOLD_CLAIMS = {
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

// The single appoints list rules as merged in 0e08e76f, kept here to prove the fallback changes nothing
const before = {
  canAppoint(f, auth, target) {
    if (auth.staff) return true
    const own = auth.rank
    if (!own || rules.isLeaderRank(f, target)) return false
    return own.appoints ? own.appoints.includes(target.slug) : rules.isLeaderRank(f, own)
  },
  canManage(f, auth, member) {
    if (auth.staff) return true
    const own = auth.rank
    if (!own) return false
    if (rules.isLeaderRank(f, own)) return !rules.isLeaderRank(f, member)
    return before.canAppoint(f, auth, member)
  },
  appointable: (f, auth) => f.ranks.filter(r => before.canAppoint(f, auth, r)),
  promotionFor(f, auth, member) {
    if (!before.canManage(f, auth, member)) return null
    const above = before.appointable(f, auth).filter(r => r.order < member.order)
    return above.length ? above[above.length - 1] : null
  },
  demotionFor(f, auth, member) {
    if (!before.canManage(f, auth, member)) return null
    return before.appointable(f, auth).find(r => r.order > member.order) || null
  },
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

const factions = rules.buildFactions(seed)
const slugOf = rank => (rank ? rank.slug : null)
const authorities = f => [{ staff: true, rank: null }, { staff: false, rank: null }, ...f.ranks.map(rank => ({ staff: false, rank }))]

test('every hold ladder reproduces HoldClaims::CanAppoint exactly', () => {
  const courts = [...factions.values()].filter(f => f.scope === 'hold')
  assert.equal(courts.length, 9)
  for (const court of courts) {
    for (const own of court.ranks) {
      const allowed = court.ranks.filter(target => rules.canAppoint(court, { staff: false, rank: own }, target)).map(r => r.slug)
      assert.deepEqual(allowed.sort(), [...HOLD_CLAIMS[own.slug]].sort(), `${court.id} ${own.slug}`)
    }
  }
})

test('without split lists every seed faction behaves as before the split', () => {
  for (const f of factions.values()) {
    for (const auth of authorities(f)) {
      for (const member of f.ranks) {
        const label = `${f.id} ${auth.staff ? 'staff' : slugOf(auth.rank)} on ${member.slug}`
        assert.equal(rules.canAppoint(f, auth, member), before.canAppoint(f, auth, member), `appoint ${label}`)
        assert.equal(rules.canInvite(f, auth, member), before.canAppoint(f, auth, member), `invite ${label}`)
        assert.equal(rules.canRemove(f, auth, member), before.canManage(f, auth, member), `remove ${label}`)
        for (const target of f.ranks) {
          const setBefore = target.slug !== member.slug && before.canManage(f, auth, member) && before.canAppoint(f, auth, target)
          assert.equal(rules.canSetRank(f, auth, member, target), setBefore, `set ${label} to ${target.slug}`)
        }
        assert.equal(slugOf(rules.promotionFor(f, auth, member)), slugOf(before.promotionFor(f, auth, member)), `promote ${label}`)
        assert.equal(slugOf(rules.demotionFor(f, auth, member)), slugOf(before.demotionFor(f, auth, member)), `demote ${label}`)
      }
    }
  }
})

test('split lists and flags act on their own', () => {
  const raw = JSON.parse(JSON.stringify(seed))
  const edit = (id, patch) => Object.assign(raw.requirements.find(r => r.id === id), patch)
  edit('hold:whiterun:captain-of-the-guard', { appoints: ['guard'], promotes: ['housecarl'], demotes: ['housecarl'], removes: ['guard', 'housecarl'], invites: false })
  edit('hold:whiterun:thane', { invites: false })
  edit('hold:whiterun:guard', { managesProperty: true, factionAccess: false })
  const court = rules.buildFactions(raw).get('hold:whiterun')
  const rank = slug => rules.rankOf(court, slug)
  const captain = { staff: false, rank: rank('captain-of-the-guard') }
  assert.equal(rules.canAppoint(court, captain, rank('guard')), true)
  assert.equal(rules.canAppoint(court, captain, rank('housecarl')), false)
  assert.equal(rules.canRemove(court, captain, rank('guard')), true)
  assert.equal(rules.canRemove(court, captain, rank('citizen')), false)
  assert.equal(slugOf(rules.promotionFor(court, captain, rank('guard'))), 'housecarl')
  assert.equal(rules.promotionFor(court, captain, rank('citizen')), null)
  assert.equal(slugOf(rules.demotionFor(court, captain, rank('housecarl'))), 'guard')
  assert.equal(rules.demotionFor(court, captain, rank('guard')), null)
  assert.deepEqual(rules.rankTargets(court, captain, rank('guard')).map(slugOf), ['housecarl'])
  assert.deepEqual(rules.rankTargets(court, captain, rank('housecarl')).map(slugOf), ['guard'])
  assert.deepEqual(rules.invitableRanks(court, captain), [])
  const thane = { staff: false, rank: rank('thane') }
  assert.deepEqual(rules.invitableRanks(court, thane), [])
  assert.ok(court.ranks.some(r => rules.canAppoint(court, thane, r)))
  assert.ok(rules.invitableRanks(court, { staff: true, rank: null }).length === court.ranks.length)
  assert.equal(rank('guard').managesProperty, true)
  assert.equal(rank('guard').factionAccess, false)
  assert.equal(rank('jarl').managesProperty, true)
  assert.equal(rank('thane').managesProperty, false)
})

test('Set rank obeys the promote and demote lists, not only appoints', () => {
  const raw = JSON.parse(JSON.stringify(seed))
  const edit = (id, patch) => Object.assign(raw.requirements.find(r => r.id === id), patch)
  // The Thane appoints Housecarl and Guard but promotes to nothing and demotes nobody
  edit('hold:whiterun:thane', { promotes: [], demotes: [] })
  // The Captain may demote Housecarls without appointing them, landing on the Guard rank it appoints
  edit('hold:whiterun:captain-of-the-guard', { demotes: ['housecarl'] })
  // A Lord or Lady may remove Citizens and nothing more
  edit('hold:whiterun:lord-lady', { appoints: [], promotes: [], demotes: [], removes: ['citizen'] })
  const court = rules.buildFactions(raw).get('hold:whiterun')
  const rank = slug => rules.rankOf(court, slug)
  const thane = { staff: false, rank: rank('thane') }
  assert.equal(rules.canAppoint(court, thane, rank('housecarl')), true)
  assert.equal(rules.canSetRank(court, thane, rank('guard'), rank('housecarl')), false, 'appoint alone does not promote')
  assert.equal(rules.canSetRank(court, thane, rank('housecarl'), rank('guard')), false, 'appoint alone does not demote')
  assert.equal(rules.promotionFor(court, thane, rank('guard')), null)
  assert.equal(rules.demotionFor(court, thane, rank('housecarl')), null)
  assert.deepEqual(rules.rankTargets(court, thane, rank('guard')), [])
  assert.equal(rules.canRemove(court, thane, rank('guard')), true)

  const captain = { staff: false, rank: rank('captain-of-the-guard') }
  assert.equal(rules.canAppoint(court, captain, rank('housecarl')), false)
  assert.equal(slugOf(rules.demotionFor(court, captain, rank('housecarl'))), 'guard')
  assert.equal(rules.canSetRank(court, captain, rank('housecarl'), rank('citizen')), false, 'a demotion lands on an appointed rank')
  assert.equal(rules.promotionFor(court, captain, rank('housecarl')), null, 'demote from gives no say upwards')

  const lord = { staff: false, rank: rank('lord-lady') }
  assert.equal(rules.canRemove(court, lord, rank('citizen')), true)
  assert.equal(rules.promotionFor(court, lord, rank('citizen')), null, 'remove gives no promotion')
  assert.deepEqual(rules.rankTargets(court, lord, rank('citizen')), [])

  const jarl = { staff: false, rank: rank('jarl') }
  assert.equal(rules.canSetRank(court, jarl, rank('guard'), rank('jarl')), false, 'nobody but staff sets a leader')
  assert.equal(rules.canSetRank(court, { staff: true, rank: null }, rank('guard'), rank('jarl')), true)
})

test('hold managers: Jarl and Steward until definitions load, the flag after, nobody for a deleted court', () => {
  const court = factions.get('hold:whiterun')
  assert.equal(rules.managesHold(undefined, 'steward'), true)
  assert.equal(rules.managesHold(undefined, 'thane'), false)
  assert.equal(rules.managesHold(court, 'steward'), true)
  assert.equal(rules.managesHold(court, 'guard'), false)
  assert.equal(rules.managesHold(court, 'retired-rank'), false)
  assert.equal(rules.managesHold(null, 'jarl'), false)
  const holds = rules.holdRanksOf({ factions: [{ requirementId: 'hold:the-rift:jarl', slot: 0 }] })
  assert.deepEqual(holds, [{ factionId: 'hold:the-rift', hold: 'rift', rank: 'jarl' }])
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
