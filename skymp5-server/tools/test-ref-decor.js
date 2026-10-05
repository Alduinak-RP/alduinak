'use strict'

// housingSystem.ts refDecor and ff_decor against a stub mp: logins share one full list, each claim write sends only its halves and sets ff_decor on them when it changes, a lock shuts both halves, the first login backfills older claims: node tools/test-ref-decor.js

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-decor-'))
process.chdir(tmp)

const LOCK = 0x03003012
// A teleport pair: the street half is the primary, the hall half is indoors
const STREET = 0x0001a000
const HALL = 0x0001a001
const CHEST = 0x0001b000
const [OWNER, NEIGHBOUR, ADMIN] = [0xff000001, 0xff000002, 0xff000009]

const tick = () => new Promise((resolve) => setImmediate(resolve))

function setup () {
  const props = new Map()
  const packets = []
  const decorSets = []
  const users = new Map()
  const form = (id, p) => props.set(id, { pos: [0, 0, 0], ...p })
  for (const id of [STREET, HALL, CHEST]) form(id, {})
  const actors = [[OWNER, 11, 'Aela'], [NEIGHBOUR, 12, 'Vilkas'], [ADMIN, 99, 'Staff']]
  actors.forEach(([id, profileId, name], i) => {
    form(id, { profileId, appearance: { name }, inventory: { entries: [{ baseId: LOCK, count: 3 }] } })
    users.set(i + 1, id)
  })
  const userOf = (actorId) => [...users].find(([, a]) => a === actorId)?.[0] ?? -1
  const mp = {
    get: (id, key) => {
      if (id === 0 && key === 'onlinePlayers') return [...users.values()]
      if (!props.has(id)) throw new Error('no form')
      return props.get(id)[key]
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      if (key === 'ff_decor') decorSets.push(id)
      props.get(id)[key] = value === null ? null : JSON.parse(JSON.stringify(value))
    },
    getUserActor: (u) => users.get(u) ?? 0,
    getUserByActor: userOf,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, text) => packets.push({ u, text, ...JSON.parse(text) }),
  }
  const sys = new HousingSystem(() => {})
  const ctx = { svr: mp }
  sys.baseTypeOf = (_ctx, id) => (id === CHEST ? 'CONT' : 'DOOR')
  sys.partnerOf = (_ctx, id) => (id === STREET ? HALL : id === HALL ? STREET : 0)
  sys.outdoors = (_ctx, id) => (id === CHEST ? null : id === STREET)
  sys.holdOf = () => ({ key: 'whiterun', name: 'Whiterun' })
  sys.isAdmin = (_ctx, a) => a === ADMIN
  let builds = 0
  const decorRefs = sys.decorRefs.bind(sys)
  sys.decorRefs = (c) => { builds++; return decorRefs(c) }
  return {
    props, sys, ctx,
    builds: () => builds,
    decorOf: (id) => props.get(id).ff_decor,
    decorSets: () => decorSets.splice(0),
    act: (actor, action, target, extra = {}) => {
      sys.lastRequestMs.clear()
      sys.customPacket(userOf(actor), 'propertyRequest', { action, target, ...extra }, ctx)
    },
    login: (actor) => sys.onActorAssigned(ctx, userOf(actor)),
    decor: () => {
      const out = packets.filter((p) => p.customPacketType === 'refDecor')
      packets.length = 0
      return out
    },
    menus: () => packets.filter((p) => p.customPacketType === 'propertyMenu'),
  }
}

const results = []
async function test (name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

const half = (refId, name, locked) => ({ refId, name, locked })

async function main () {
  await test('a write reaches clients on the next turn as the claim\'s halves only, without full', async () => {
    const t = setup()
    t.act(OWNER, 'claim', HALL)
    assert.deepEqual(t.decor(), [])
    await tick()
    const sent = t.decor()
    assert.equal(sent.length, 3)
    for (const p of sent) {
      assert.equal(p.full, undefined)
      assert.deepEqual(p.refs, [half(STREET, null, false), half(HALL, null, false)])
    }
    assert.equal(new Set(sent.map((p) => p.u)).size, 3)
  })

  await test('a lock, asked for as the entrance lock by an older menu, shows on both halves', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    t.act(OWNER, 'rename', STREET, { name: 'Jorrvaskr' })
    await tick()
    t.decor()
    t.act(OWNER, 'lockentrance', STREET)
    await tick()
    const sent = t.decor()
    assert.equal(sent.length, 3)
    assert.deepEqual(sent[0].refs, [half(STREET, 'Jorrvaskr', true), half(HALL, 'Jorrvaskr', true)])
    assert.ok(sent[0].text.length < 200)
    const rec = t.sys.read(t.ctx, STREET)
    assert.deepEqual([rec.lockedEntrance, rec.lockedExit], [true, true])
    assert.equal(t.sys.onActivate(t.ctx, HALL, NEIGHBOUR), false)
    assert.equal(t.sys.onActivate(t.ctx, STREET, NEIGHBOUR), false)
    t.act(OWNER, 'unlock', STREET)
    assert.equal(t.sys.onActivate(t.ctx, HALL, NEIGHBOUR), true)
    assert.equal(t.sys.onActivate(t.ctx, STREET, NEIGHBOUR), true)
  })

  await test('the menu offers one lock on a door with two halves', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    t.act(OWNER, 'lock', STREET)
    const menu = t.menus().pop()
    assert.equal(menu.sides, false)
    assert.equal(menu.locked, true)
  })

  await test('writes in one turn go out as one packet per player', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    t.act(NEIGHBOUR, 'claim', CHEST)
    t.act(OWNER, 'lock', STREET)
    await tick()
    const sent = t.decor()
    assert.equal(sent.length, 3)
    assert.deepEqual(sent[0].refs, [half(STREET, null, true), half(HALL, null, true), half(CHEST, null, false)])
  })

  await test('giving up sends both halves unnamed and unlocked', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    t.act(OWNER, 'rename', STREET, { name: 'Jorrvaskr' })
    t.act(OWNER, 'lock', STREET)
    await tick()
    t.decor()
    t.act(OWNER, 'abandon', STREET)
    await tick()
    assert.deepEqual(t.decor()[0].refs, [half(STREET, null, false), half(HALL, null, false)])
  })

  await test('a write on a claim that was and stays unclaimed sends nothing', async () => {
    const t = setup()
    t.sys.write(t.ctx, CHEST, { owner: 0, ownerName: '', name: null, lockedEntrance: false, lockedExit: false, serial: 2, cut: 0, partner: 0, containers: [], faction: '' })
    await tick()
    assert.deepEqual(t.decor(), [])
  })

  await test('logins share one full list until a claim changes', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    t.act(NEIGHBOUR, 'claim', CHEST)
    await tick()
    t.decor()
    t.login(OWNER)
    t.login(NEIGHBOUR)
    const first = t.decor()
    assert.equal(t.builds(), 1)
    assert.equal(first.length, 2)
    assert.equal(first[0].full, true)
    assert.equal(first[0].text, first[1].text)
    assert.deepEqual(first[0].refs, [half(STREET, null, false), half(HALL, null, false), half(CHEST, null, false)])
    t.act(NEIGHBOUR, 'lock', CHEST)
    await tick()
    t.decor()
    t.login(ADMIN)
    assert.equal(t.builds(), 2)
    assert.deepEqual(t.decor()[0].refs, [half(STREET, null, false), half(HALL, null, false), half(CHEST, null, true)])
  })

  await test('ff_decor follows each half: claim, rename, lock, give up', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    assert.deepEqual(t.decorOf(STREET), { name: null, locked: false })
    assert.deepEqual(t.decorOf(HALL), { name: null, locked: false })
    assert.deepEqual(t.decorSets().sort(), [STREET, HALL].sort())
    t.act(OWNER, 'rename', STREET, { name: 'Jorrvaskr' })
    t.act(OWNER, 'lock', STREET)
    assert.deepEqual(t.decorOf(STREET), { name: 'Jorrvaskr', locked: true })
    assert.deepEqual(t.decorOf(HALL), { name: 'Jorrvaskr', locked: true })
    t.decorSets()
    t.act(OWNER, 'abandon', STREET)
    assert.equal(t.decorOf(STREET), null)
    assert.equal(t.decorOf(HALL), null)
    assert.deepEqual(t.decorSets().sort(), [STREET, HALL].sort())
  })

  await test('a write that leaves the name and lock alone sets no ff_decor', async () => {
    const t = setup()
    t.act(NEIGHBOUR, 'claim', CHEST)
    assert.deepEqual(t.decorSets(), [CHEST])
    const rec = t.sys.read(t.ctx, CHEST)
    t.sys.write(t.ctx, CHEST, { ...rec, cut: rec.cut + 1 })
    assert.deepEqual(t.decorSets(), [])
    t.sys.write(t.ctx, CHEST, { owner: 0, ownerName: '', name: null, lockedEntrance: false, lockedExit: false, serial: 2, cut: 0, partner: 0, containers: [], faction: '' })
    assert.equal(t.decorOf(CHEST), null)
    t.sys.write(t.ctx, CHEST, { owner: 0, ownerName: '', name: null, lockedEntrance: false, lockedExit: false, serial: 2, cut: 0, partner: 0, containers: [], faction: '' })
    assert.deepEqual(t.decorSets(), [CHEST])
  })

  await test('the first login brings ff_decor up to date on claims written before it or under another lock rule', async () => {
    const t = setup()
    t.act(OWNER, 'claim', STREET)
    t.act(OWNER, 'rename', STREET, { name: 'Jorrvaskr' })
    t.act(OWNER, 'lock', STREET)
    t.act(NEIGHBOUR, 'claim', CHEST)
    t.decorSets()
    delete t.props.get(STREET).ff_decor
    t.props.get(HALL).ff_decor = { name: 'Jorrvaskr', locked: false }
    t.login(OWNER)
    assert.deepEqual(t.decorSets().sort(), [STREET, HALL].sort())
    assert.deepEqual(t.decorOf(STREET), { name: 'Jorrvaskr', locked: true })
    assert.deepEqual(t.decorOf(HALL), { name: 'Jorrvaskr', locked: true })
    assert.deepEqual(t.decorOf(CHEST), { name: null, locked: false })
    delete t.props.get(CHEST).ff_decor
    t.login(NEIGHBOUR)
    assert.deepEqual(t.decorSets(), [])
  })

  await test('a login with no actor gets nothing and builds nothing', async () => {
    const t = setup()
    t.sys.onActorAssigned(t.ctx, 42)
    assert.deepEqual(t.decor(), [])
    assert.equal(t.builds(), 0)
  })
}

main().then(() => {
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
})
