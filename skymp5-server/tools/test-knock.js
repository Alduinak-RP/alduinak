'use strict'

// housingSystem.ts knocking against a stub mp: who reads the notice on both halves of a door, the names, the range and the cooldown: node tools/test-knock.js

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knock-'))
process.chdir(tmp)

const INSIDE = 0x0001a000
const OUTSIDE = 0x0001a001
const GATE = 0x0001a100
const STREET = '3c:Skyrim.esm'
const HOUSE = '165a8:Skyrim.esm'
const [KNOCKER, FRIEND, STRANGER, HOST, FAR_GUEST, PASSERBY] = [0xff000001, 0xff000002, 0xff000003, 0xff000004, 0xff000005, 0xff000006]

function setup () {
  const props = new Map()
  const packets = []
  const users = new Map()
  const form = (id, p) => props.set(id, p)
  form(INSIDE, { pos: [0, 0, 0], worldOrCellDesc: HOUSE })
  form(OUTSIDE, { pos: [5000, 5000, 0], worldOrCellDesc: STREET })
  form(GATE, { pos: [9000, 5000, 0], worldOrCellDesc: STREET })
  const actors = [
    [KNOCKER, 'Ria', [5100, 5000, 0], STREET, []],
    // Introduced to the knocker, beside her
    [FRIEND, 'Vilkas', [5300, 5000, 0], STREET, [KNOCKER]],
    // Never introduced, beside her
    [STRANGER, 'Nazeem', [5000, 6500, 0], STREET, []],
    // Introduced, behind the door
    [HOST, 'Aela', [0, 1500, 0], HOUSE, [KNOCKER]],
    // Behind the door, past say range
    [FAR_GUEST, 'Farkas', [0, 2500, 0], HOUSE, [KNOCKER]],
    // Same street, past say range
    [PASSERBY, 'Lars', [8000, 5000, 0], STREET, [KNOCKER]],
  ]
  actors.forEach(([id, name, pos, cell, known], i) => {
    form(id, { profileId: 10 + i, appearance: { name }, pos, worldOrCellDesc: cell, ff_knownIds: known, inventory: { entries: [] } })
    users.set(i + 1, id)
  })
  const userOf = (actorId) => [...users].find(([, a]) => a === actorId)?.[0] ?? -1
  const cellIds = new Map([[STREET, 0x3c], [HOUSE, 0x165a8]])
  const cellOf = (desc) => {
    if (!cellIds.has(desc)) throw new Error('bad desc')
    return cellIds.get(desc)
  }
  const mp = {
    get: (id, key) => {
      if (id === 0 && key === 'onlinePlayers') return [...users.values()]
      if (!props.has(id)) throw new Error('no form')
      return props.get(id)[key]
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      props.get(id)[key] = value === null ? null : JSON.parse(JSON.stringify(value))
    },
    getUserActor: (u) => users.get(u) ?? 0,
    getUserByActor: userOf,
    getIdFromDesc: cellOf,
    getActorCellOrWorld: (id) => cellOf(props.get(id).worldOrCellDesc),
    getActorPos: (id) => props.get(id).pos,
    isConnected: (u) => users.has(u),
    sendCustomPacket: (u, text) => packets.push({ u, actor: users.get(u), ...JSON.parse(text) }),
  }
  const lines = []
  const sys = new HousingSystem((line) => lines.push(line))
  const ctx = { svr: mp }
  sys.factionRights = () => []
  sys.territoryRefusal = () => ''
  sys.factionDef = () => null
  sys.baseTypeOf = () => 'DOOR'
  sys.partnerOf = (_ctx, id) => (id === INSIDE ? OUTSIDE : id === OUTSIDE ? INSIDE : 0)
  sys.outdoors = (_ctx, id) => id !== INSIDE
  sys.holdOf = () => null
  sys.isAdmin = () => false
  sys.installActivationHook(ctx)
  return {
    mp, props, packets, lines, sys,
    // Opens the menu at the half, then knocks; returns the notices by reader
    knock: (actor, half = OUTSIDE) => {
      sys.customPacket(userOf(actor), 'propertyInfoRequest', { target: half }, ctx)
      sys.lastRequestMs.clear()
      packets.length = 0
      sys.customPacket(userOf(actor), 'propertyRequest', { action: 'knock', target: half }, ctx)
      const read = new Map()
      for (const p of packets) {
        assert.equal(p.customPacketType, 'propertyNotice')
        read.set(p.actor, (read.get(p.actor) || []).concat(p.text))
      }
      return read
    },
  }
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

test('both halves read the knock within say range, by the name each reader knows', () => {
  const t = setup()
  const read = t.knock(KNOCKER)
  assert.deepEqual(read.get(KNOCKER), ['You knock on the door.'])
  assert.deepEqual(read.get(FRIEND), ['Ria knocks on the door.'])
  assert.deepEqual(read.get(STRANGER), ['Someone knocks on the door.'])
  assert.deepEqual(read.get(HOST), ['Ria knocks on the door.'])
  assert.equal(read.has(FAR_GUEST), false)
  assert.equal(read.has(PASSERBY), false)
  assert.ok(t.lines.some((l) => l === '[housing] knock on door 1a001 (outside) by Ria (profile 10): read within talking range by 2 at that door, 1 at door 1a000 (inside)'), t.lines.join('\n'))
})

test('a knock from inside reaches the street', () => {
  const t = setup()
  t.props.get(KNOCKER).pos = [100, 0, 0]
  t.props.get(KNOCKER).worldOrCellDesc = HOUSE
  const read = t.knock(KNOCKER, INSIDE)
  assert.deepEqual([...read.keys()].sort(), [KNOCKER, FRIEND, STRANGER, HOST].sort())
  assert.deepEqual(read.get(STRANGER), ['Someone knocks on the door.'])
})

test('it needs no gamemode part', () => {
  const t = setup()
  assert.equal(globalThis.__alduinakEmoteAt, undefined)
  assert.equal(globalThis.__alduinakKnown, undefined)
  assert.equal(t.knock(KNOCKER).size, 4)
})

test('the gamemode introduce cache answers when it is loaded, a reader without a list counts as introduced', () => {
  const t = setup()
  const lists = new Map([[STRANGER, new Set([KNOCKER])], [FRIEND, new Set()]])
  const asked = new Set()
  globalThis.__alduinakKnown = (id) => {
    asked.add(id)
    return lists.get(id) ?? null
  }
  try {
    const read = t.knock(KNOCKER)
    assert.deepEqual(read.get(STRANGER), ['Ria knocks on the door.'])
    assert.deepEqual(read.get(FRIEND), ['Someone knocks on the door.'])
    assert.deepEqual(read.get(HOST), ['Ria knocks on the door.'])
    assert.deepEqual([...asked].sort(), [FRIEND, STRANGER, HOST].sort())
  } finally {
    delete globalThis.__alduinakKnown
  }
})

test('the Show Title prefix goes in front of a known name only', () => {
  const t = setup()
  t.props.get(KNOCKER).ff_factionTitle = 'Thane'
  const read = t.knock(KNOCKER)
  assert.deepEqual(read.get(HOST), ['Thane Ria knocks on the door.'])
  assert.deepEqual(read.get(STRANGER), ['Someone knocks on the door.'])
})

test('chatRanges.say sets the range', () => {
  const t = setup()
  t.sys.sayRange = 250
  const read = t.knock(KNOCKER)
  assert.deepEqual([...read.keys()], [KNOCKER])
  t.sys.sayRange = 4000
  t.sys.lastKnockMs.clear()
  assert.equal(t.knock(KNOCKER).size, 6)
})

test('a door without another half is read around itself', () => {
  const t = setup()
  t.props.get(KNOCKER).pos = [8900, 5000, 0]
  const read = t.knock(KNOCKER, GATE)
  assert.deepEqual([...read.keys()].sort(), [KNOCKER, PASSERBY].sort())
  assert.ok(t.lines.some((l) => /knock on door 1a100 by Ria \(profile 10\): read within talking range by 1 at that door, no other half$/.test(l)), t.lines.join('\n'))
})

test('a reader in range of both halves reads one line', () => {
  const t = setup()
  t.props.get(INSIDE).worldOrCellDesc = STREET
  t.props.get(INSIDE).pos = [5500, 5000, 0]
  const read = t.knock(KNOCKER)
  assert.deepEqual(read.get(FRIEND), ['Ria knocks on the door.'])
  assert.deepEqual(read.get(KNOCKER), ['You knock on the door.'])
})

test('a second knock within 10 s is refused and nobody else reads it', () => {
  const t = setup()
  t.knock(KNOCKER)
  const read = t.knock(KNOCKER)
  assert.deepEqual([...read.keys()], [KNOCKER])
  assert.match(read.get(KNOCKER)[0], /^You knocked a moment ago\. Wait \d+ s\.$/)
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
