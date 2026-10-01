'use strict'

// housingSystem.ts faction claims against a stub mp: claim for a faction, member use, manager actions, a new leader, courts, hand-over, transfer and old records: node tools/test-faction-claims.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'housingSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { HousingSystem } = compiled.exports

// The registry file lands in the working directory
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faction-claims-'))
process.chdir(tmp)

const LOCK = 0x03003012
const DOOR = 0x0001a000
const HOUSE = 0x0001a100
const COMPANIONS = 'faction:companions'
const WHITERUN = 'hold:whiterun'
const ADMIN = 0xff000009
const [MANAGER, MEMBER, OUTSIDER, OWNER, HEIR] = [0xff000001, 0xff000002, 0xff000003, 0xff000004, 0xff000005]

function setup () {
  const props = new Map()
  const packets = []
  const users = new Map()
  const form = (id, p) => props.set(id, { pos: [0, 0, 0], ...p })
  form(DOOR, {})
  form(HOUSE, {})
  const actors = [[MANAGER, 11, 'Kodlak'], [MEMBER, 12, 'Vilkas'], [OUTSIDER, 13, 'Nazeem'], [OWNER, 14, 'Aela'], [HEIR, 15, 'Farkas'], [ADMIN, 99, 'Staff']]
  actors.forEach(([id, profileId, name], i) => {
    form(id, { profileId, appearance: { name }, inventory: { entries: [{ baseId: LOCK, count: 2 }] } })
    users.set(i + 1, id)
  })
  const userOf = (actorId) => [...users].find(([, a]) => a === actorId)?.[0] ?? -1
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      return props.get(id)[key]
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      props.get(id)[key] = value === null ? null : JSON.parse(JSON.stringify(value))
    },
    getUserActor: (u) => users.get(u) ?? 0,
    getUserByActor: userOf,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, text) => packets.push({ u, actor: users.get(u), ...JSON.parse(text) }),
  }
  const lines = []
  const sys = new HousingSystem((line) => lines.push(line))
  const ctx = { svr: mp }
  const rights = new Map([
    [MANAGER, [{ id: COMPANIONS, name: 'The Companions', use: true, manage: true }]],
    [MEMBER, [{ id: COMPANIONS, name: 'The Companions', use: true, manage: false }]],
    [OWNER, [{ id: COMPANIONS, name: 'The Companions', use: true, manage: true }]],
  ])
  const border = new Map()
  let hold = { key: 'whiterun', name: 'Whiterun' }
  sys.factionRights = (a) => rights.get(a) || []
  sys.territoryRefusal = (a) => border.get(a) || ''
  sys.factionDef = (id) => (id === COMPANIONS ? { name: 'The Companions' } : id === WHITERUN ? { name: 'Court of Whiterun' } : null)
  sys.baseTypeOf = () => 'DOOR'
  sys.partnerOf = () => 0
  sys.outdoors = () => null
  sys.holdOf = () => hold
  sys.isAdmin = (_ctx, a) => a === ADMIN
  sys.installActivationHook(ctx)
  const t = {
    mp, props, packets, lines, sys, ctx, rights, border,
    setHold: (h) => { hold = h },
    user: userOf,
    act: (actor, action, target = DOOR, extra = {}) => {
      sys.lastRequestMs.clear()
      packets.length = 0
      sys.customPacket(userOf(actor), 'propertyRequest', { action, target, ...extra }, ctx)
      return packets
    },
    menu: (actor, target = DOOR) => {
      packets.length = 0
      sys.customPacket(userOf(actor), 'propertyInfoRequest', { target }, ctx)
      return packets.find((p) => p.customPacketType === 'propertyMenu')
    },
    notice: () => packets.filter((p) => p.customPacketType === 'propertyNotice').map((p) => p.text).join(' | '),
    rec: (id = DOOR) => props.get(id)['private.housing'],
    locks: (actor) => mp.get(actor, 'inventory').entries.find((e) => e.baseId === LOCK)?.count ?? 0,
  }
  return t
}

const results = []
function test (name, fn) {
  try {
    fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

test('only a managing rank is offered Claim for the faction', () => {
  const t = setup()
  assert.deepEqual(t.menu(MANAGER).claimFactions, [{ id: COMPANIONS, name: 'The Companions' }])
  assert.equal(t.menu(MANAGER).view, 'claimable')
  assert.deepEqual(t.menu(MEMBER).claimFactions, [])
  assert.deepEqual(t.menu(OUTSIDER).claimFactions, [])
  t.act(MEMBER, 'claimfaction', DOOR, { faction: COMPANIONS })
  assert.match(t.notice(), /does not manage its property/)
  t.act(OUTSIDER, 'claimfaction', DOOR, { faction: COMPANIONS })
  assert.match(t.notice(), /do not belong to that faction/)
  assert.equal(t.rec(), undefined)
})

test('a faction claim spends one lock and stores the faction, not a profile', () => {
  const t = setup()
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  assert.match(t.notice(), /belongs to The Companions now/)
  assert.equal(t.locks(MANAGER), 1)
  assert.equal(t.rec().owner, -1)
  assert.equal(t.rec().faction, COMPANIONS)
  assert.equal(t.props.get(DOOR)['private.indexed.housingOwner'], COMPANIONS)
  assert.ok(t.lines.some((l) => /lock spent by Kodlak \(profile 11\) on claim 1a000 of faction:companions \(The Companions\), claimed as faction manager/.test(l)))
  t.act(OUTSIDER, 'claim')
  assert.match(t.notice(), /Somebody already owns this/)
})

test('a member with door access locks and unlocks it, an outsider cannot', () => {
  const t = setup()
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  const m = t.menu(MEMBER)
  assert.equal(m.view, 'keyholder')
  assert.equal(m.canLock, true)
  assert.deepEqual(m.faction, { id: COMPANIONS, name: 'The Companions', role: 'member' })
  assert.equal(m.ownerName, 'The Companions')
  t.act(MEMBER, 'lock')
  assert.equal(t.rec().lockedEntrance, true)
  assert.ok(t.lines.some((l) => /claim 1a000 of faction:companions locked by Vilkas \(profile 12\) as faction member/.test(l)))
  assert.equal(t.mp.onActivate(DOOR, MEMBER), false, 'a lock shuts everyone out, members included')
  assert.match(t.notice(), /Unlock it from the housing menu/)
  const o = t.menu(OUTSIDER)
  assert.equal(o.view, 'denied')
  assert.equal(o.ownerName, 'The Companions')
  assert.equal(o.faction.role, '')
  t.act(OUTSIDER, 'unlock')
  assert.match(t.notice(), /You have no key to this/)
  t.act(MEMBER, 'unlock')
  assert.equal(t.rec().lockedEntrance, false)
  assert.equal(t.mp.onActivate(DOOR, OUTSIDER), true, 'unlocked, anyone passes as on a personal claim')
})

test('members do not rename, cut keys, transfer or give it up; managers do', () => {
  const t = setup()
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  t.act(MEMBER, 'rename', DOOR, { name: 'Jorrvaskr' })
  assert.match(t.notice(), /not yours to name/)
  t.act(MEMBER, 'createkey', DOOR, { name: 'Hall Key' })
  assert.match(t.notice(), /Only the owner cuts keys/)
  t.act(MEMBER, 'abandon')
  assert.match(t.notice(), /not yours to give up/)
  assert.equal(t.menu(MANAGER).view, 'owner')
  t.act(MANAGER, 'rename', DOOR, { name: 'Jorrvaskr' })
  assert.equal(t.rec().name, 'Jorrvaskr')
  assert.ok(t.lines.some((l) => /claim 1a000 of faction:companions renamed "Jorrvaskr" by Kodlak \(profile 11\) as faction manager/.test(l)))
  t.act(MANAGER, 'createkey', DOOR, { name: 'Hall Key' })
  assert.ok(t.mp.get(MANAGER, 'inventory').entries.some((e) => e.name === 'Hall Key (1A000/1)'))
  assert.ok(t.lines.some((l) => /Hall Key \(1A000\/1\) cut for claim 1a000 "Jorrvaskr" of faction:companions by Kodlak/.test(l)))
})

test('the claim stays with the faction when the leader is replaced', () => {
  const t = setup()
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  t.rights.delete(MANAGER)
  t.rights.set(HEIR, [{ id: COMPANIONS, name: 'The Companions', use: true, manage: true }])
  assert.equal(t.menu(MANAGER).view, 'denied')
  t.act(MANAGER, 'abandon')
  assert.match(t.notice(), /not yours to give up/)
  assert.equal(t.rec().faction, COMPANIONS)
  assert.equal(t.menu(HEIR).view, 'owner')
  t.act(HEIR, 'rename', DOOR, { name: 'Jorrvaskr' })
  assert.equal(t.rec().name, 'Jorrvaskr')
  assert.equal(t.rec().faction, COMPANIONS)
})

test('the menu and faction claim requests wait for fresh ranks, personal claims do not', () => {
  const t = setup()
  const waiting = []
  const jobs = []
  t.sys.factionFresh = (userId, job) => { waiting.push(userId); jobs.push(job) }
  const release = () => jobs.splice(0).forEach((job) => job())
  t.act(OWNER, 'claim', HOUSE)
  assert.equal(t.rec(HOUSE).owner, 14, 'a personal claim runs at once')
  assert.equal(waiting.length, 0)
  t.rights.delete(MANAGER)
  assert.equal(t.menu(MANAGER), undefined, 'no menu before the ranks are back')
  t.rights.set(MANAGER, [{ id: COMPANIONS, name: 'The Companions', use: true, manage: true }])
  release()
  assert.deepEqual(t.packets.find((p) => p.customPacketType === 'propertyMenu').claimFactions, [{ id: COMPANIONS, name: 'The Companions' }])
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  assert.equal(t.rec(), undefined)
  release()
  assert.equal(t.rec().faction, COMPANIONS)
  t.rights.delete(MEMBER)
  t.act(MEMBER, 'lock')
  release()
  assert.match(t.notice(), /You have no key to this/, 'a member removed meanwhile no longer locks it')
  assert.deepEqual(waiting, [t.user(MANAGER), t.user(MANAGER), t.user(MEMBER)])
})

test('a court claims only inside its own hold, and its ranks act only standing in it', () => {
  const t = setup()
  t.rights.set(MANAGER, [{ id: WHITERUN, name: 'Court of Whiterun', use: true, manage: true }])
  t.rights.set(MEMBER, [{ id: WHITERUN, name: 'Court of Whiterun', use: true, manage: false }])
  t.setHold({ key: 'rift', name: 'The Rift' })
  assert.deepEqual(t.menu(MANAGER).claimFactions, [])
  t.act(MANAGER, 'claimfaction', DOOR, { faction: WHITERUN })
  assert.match(t.notice(), /may only claim property inside Whiterun/)
  t.setHold({ key: 'whiterun', name: 'Whiterun' })
  t.border.set(MANAGER, 'Your authority as Steward of Court of Whiterun ends at the Whiterun border.')
  assert.deepEqual(t.menu(MANAGER).claimFactions, [])
  t.border.delete(MANAGER)
  t.act(MANAGER, 'claimfaction', DOOR, { faction: WHITERUN })
  assert.equal(t.rec().faction, WHITERUN)
  t.border.set(MEMBER, 'Your authority as Guard of Court of Whiterun ends at the Whiterun border.')
  t.act(MEMBER, 'lock')
  assert.match(t.notice(), /ends at the Whiterun border/)
  t.border.set(MANAGER, 'Your authority as Steward of Court of Whiterun ends at the Whiterun border.')
  t.act(MANAGER, 'rename', DOOR, { name: 'Dragonsreach' })
  assert.match(t.notice(), /ends at the Whiterun border/)
  assert.equal(t.rec().name, null)
})

test('a territory without land claims in any hold, and a claim under a converted id follows to the new one', () => {
  const t = setup()
  const INDORIL = 'hold:indoril'
  t.rights.set(MANAGER, [{ id: INDORIL, name: 'House Indoril', use: true, manage: true }])
  t.setHold({ key: 'eastmarch', name: 'Eastmarch' })
  assert.deepEqual(t.menu(MANAGER).claimFactions, [{ id: INDORIL, name: 'House Indoril' }])
  t.act(MANAGER, 'claimfaction', DOOR, { faction: INDORIL })
  assert.equal(t.rec().faction, INDORIL)
  t.act(MANAGER, 'claimfaction', HOUSE, { faction: INDORIL })
  t.props.get(HOUSE)['private.housing'].faction = 'faction:house-indoril'
  assert.deepEqual([t.menu(MANAGER, HOUSE).faction.id, t.menu(MANAGER, HOUSE).faction.role], ['faction:house-indoril', ''], 'without a successor the old id matches no rank')
  t.sys.factionSuccessor = (id) => (id === 'faction:house-indoril' ? INDORIL : id)
  assert.equal(t.menu(MANAGER, HOUSE).faction.id, INDORIL)
  assert.equal(t.menu(MANAGER, HOUSE).faction.role, 'manager')
})

test('an owner hands a personal claim to the faction without a lock, and old keys stop fitting', () => {
  const t = setup()
  t.act(OWNER, 'claim', HOUSE)
  assert.equal(t.rec(HOUSE).owner, 14)
  assert.equal(t.locks(OWNER), 1)
  assert.deepEqual(t.menu(OWNER, HOUSE).claimFactions, [{ id: COMPANIONS, name: 'The Companions' }])
  assert.deepEqual(t.menu(MEMBER, HOUSE).claimFactions, [])
  const serial = t.rec(HOUSE).serial
  t.act(OWNER, 'claimfaction', HOUSE, { faction: COMPANIONS })
  assert.equal(t.locks(OWNER), 1, 'no second lock')
  assert.equal(t.rec(HOUSE).faction, COMPANIONS)
  assert.equal(t.rec(HOUSE).owner, -1)
  assert.equal(t.rec(HOUSE).serial, serial + 1)
  assert.ok(t.lines.some((l) => /claim 1a100 of faction:companions \(The Companions\) handed to the faction by its owner Aela \(profile 14\)/.test(l)))
})

test('a manager transfers a faction claim to a player, who then owns it personally', () => {
  const t = setup()
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  t.act(MANAGER, 'transfer', DOOR, { recipient: OUTSIDER })
  assert.equal(t.rec().owner, 13)
  assert.equal(t.rec().faction, '')
  assert.equal(t.props.get(DOOR)['private.indexed.housingOwner'], '13')
  assert.equal(t.menu(OUTSIDER).view, 'owner')
  assert.equal(t.menu(OUTSIDER).faction, null)
  assert.equal(t.menu(MEMBER).view, 'denied')
  assert.ok(t.lines.some((l) => /claim 1a000 of faction:companions transferred to Nazeem \(profile 13\) by Kodlak \(profile 11\) as faction manager/.test(l)))
})

test('giving up and breaking the lock clear the faction, members hear about the broken lock', () => {
  const t = setup()
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  t.act(ADMIN, 'breaklock')
  assert.equal(t.rec().owner, 0)
  assert.equal(t.rec().faction, '')
  const told = t.packets.filter((p) => p.customPacketType === 'propertyNotice' && /no longer belongs to The Companions/.test(p.text)).map((p) => p.actor)
  assert.deepEqual(told.sort(), [MANAGER, MEMBER, OWNER].sort())
  t.act(MANAGER, 'claimfaction', DOOR, { faction: COMPANIONS })
  t.act(MANAGER, 'abandon')
  assert.equal(t.rec().owner, 0)
  assert.equal(t.rec().faction, '')
  assert.ok(t.lines.some((l) => /claim 1a000 of faction:companions given up by Kodlak \(profile 11\) as faction manager/.test(l)))
})

test('a record from before faction claims stays personal', () => {
  const t = setup()
  t.props.get(HOUSE)['private.housing'] = { owner: 14, ownerName: 'Aela', name: 'Hunter Lodge', locked: true, serial: 3, cut: 2, partner: 0, containers: [] }
  const m = t.menu(OWNER, HOUSE)
  assert.equal(m.view, 'owner')
  assert.equal(m.faction, null)
  assert.equal(m.lockedEntrance, true)
  assert.equal(t.menu(MEMBER, HOUSE).view, 'denied')
  t.act(OWNER, 'unlock', HOUSE)
  assert.equal(t.rec(HOUSE).faction, '')
  assert.equal(t.rec(HOUSE).owner, 14)
  assert.equal(t.rec(HOUSE).serial, 3)
})

let failed = 0
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) {
    failed++
    console.log(err)
  }
}
console.log(`${results.length - failed}/${results.length} passed`)
process.chdir(os.tmpdir())
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
