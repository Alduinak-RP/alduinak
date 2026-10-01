'use strict'

// huntingSystem.ts skinning a dead player's own body or a PK body against a stub mp: modes, refusals, the search lock, the heart and Khajiit pelt rolls, respawns and interruptions: node tools/test-player-skinning.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')
const { EventEmitter } = require('events')

const FLESH = 0x1016b3
const HEART = 0xb18cd
const KPELT = 0x4013e0
const KHAJIIT = 0x13745
const KHAJIIT_VAMPIRE = 0x88845
const NORD = 0x13746
const KNIFE = 0x1f25a
const HUNTER = 0xff000a01
const OTHER_HUNTER = 0xff000a02
const LOOTER = 0xff000a03
const VICTIM = 0xff000b01
const CLONE = 0xff000c01
const WOLF = 0xff000d01

// The settings module reads server-settings.json and the editor id scan reads the plugins; the test hands its own
const stubs = {
  name: 'stubs',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onResolve({ filter: /^\.\/espmEditorIds$/ }, () => ({ path: 'espm', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: globalThis.__skinSettings, dataDir: "", loadOrder: [] }) }', loader: 'js' }))
    build.onLoad({ filter: /^espm$/, namespace: 'stub' }, () => ({
      contents: `
        const known = { humanflesh: '1016b3:Skyrim.esm', humanheart: 'b18cd:Skyrim.esm', wolfpelt: '3ad74:Skyrim.esm', actortypeanimal: '13798:Skyrim.esm',
          aldkhajiitpelt: '4013e0:AlduinakAdditions.esp', khajiitrace: '13745:Skyrim.esm', khajiitracevampire: '88845:Skyrim.esm' }
        const has = (n) => known[n.toLowerCase()] && !(globalThis.__skinMissing || []).includes(n)
        exports.isEditorId = (s) => !s.includes(':') && !/^[0-9a-f]{8}$/i.test(s)
        exports.resolveEditorIds = async (names) => ({ resolved: new Map(names.filter(has).map((n) => [n.toLowerCase(), known[n.toLowerCase()]])), unresolved: [], scannedMs: 0 })`,
      loader: 'js',
    }))
  },
}
const source = path.join(__dirname, '..', 'ts', 'systems', 'huntingSystem.ts')
let HuntingSystem

const timers = []
global.setTimeout = (fn) => { timers.push(fn); return timers.length }
global.setImmediate = (fn) => fn()
const runTimers = () => { while (timers.length) timers.shift()() }

let roll = 0.5
Math.random = () => roll

function stubMp () {
  const actor = (profileId, extra = {}) => ({ type: 'MpActor', isDead: false, profileId, baseDesc: '7:Skyrim.esm', pos: [0, 0, 0], cell: 0x3c, inventory: { entries: [] }, ...extra })
  const forms = new Map([
    [HUNTER, actor(1, { inventory: { entries: [{ baseId: KNIFE, count: 1 }] } })],
    [OTHER_HUNTER, actor(2, { pos: [50, 0, 0], inventory: { entries: [{ baseId: KNIFE, count: 1 }] } })],
    [LOOTER, actor(3, { pos: [0, 50, 0] })],
    [VICTIM, actor(4, { isDead: true, pos: [100, 0, 0], appearance: { raceId: NORD }, inventory: { entries: [{ baseId: 0xf, count: 300 }, { baseId: 0x12eb7, count: 1, worn: true }] } })],
    [CLONE, actor(-1, { isDead: true, pos: [120, 0, 0], appearance: { raceId: KHAJIIT }, inventory: { entries: [{ baseId: 0xf, count: 50 }] } })],
    [WOLF, actor(-1, { isDead: true, baseDesc: '23aba:Skyrim.esm', pos: [80, 0, 0] })],
  ])
  const users = new Map([[HUNTER, 1], [OTHER_HUNTER, 2], [LOOTER, 3], [VICTIM, 4]])
  const state = { sneaking: new Set() }
  const packets = []
  const added = []
  const ids = (desc) => parseInt(String(desc).split(':')[0], 16)
  const mp = {
    get: (id, key) => {
      const f = forms.get(id)
      if (!f) throw new Error('no form')
      const v = f[key]
      return v === undefined ? null : JSON.parse(JSON.stringify(v))
    },
    set: (id, key, value) => {
      if (!forms.has(id)) throw new Error('no form')
      forms.get(id)[key] = JSON.parse(JSON.stringify(value))
    },
    getUserByActor: (id) => users.has(id) ? users.get(id) : 65535,
    isConnected: (u) => [...users.values()].includes(u),
    getActorCellOrWorld: (id) => forms.get(id).cell,
    getActorPos: (id) => forms.get(id).pos,
    getActorName: () => 'Eerik',
    getIdFromDesc: ids,
    getDescFromId: (id) => id.toString(16),
    lookupEspmRecordById: (id) => id === 0x23aba ? { record: { type: 'NPC_', editorId: 'EncWolf' } } : null,
    callPapyrusFunction: (_kind, _cls, fn, self, args) => {
      const target = ids(self.desc)
      if (fn === 'GetAnimationVariableBool') return state.sneaking.has(target)
      if (fn === 'AddItem') added.push({ to: target, item: ids(args[0].desc), count: args[1] })
      return undefined
    },
    sendCustomPacket: (u, text) => packets.push({ u, ...JSON.parse(text) }),
  }
  return { mp, forms, users, state, packets, added }
}

async function setup (settings = {}, missing = []) {
  globalThis.__skinSettings = settings
  globalThis.__skinMissing = missing
  const s = stubMp()
  const lines = []
  const paid = []
  const credited = []
  const mastery = {
    rankOf: (_ctx, id, prof) => prof === 'hunter' && (id === HUNTER || id === OTHER_HUNTER) ? 1 : 0,
    creditWork: (id, prof) => credited.push([id, prof]),
    actorHasKeyword: (_ctx, id) => id === WOLF,
  }
  const needs = { canPay: () => true, pay: (_ctx, id, effort, rank, what, half) => paid.push([id, effort, what, half]) }
  const sys = new HuntingSystem((line) => lines.push(line), mastery, needs)
  const ctx = { svr: s.mp, gm: new EventEmitter() }
  await sys.initAsync(ctx)
  timers.length = 0
  const skin = (actorId, bodyId = VICTIM) => sys.trySkin(ctx, actorId, bodyId)
  const notices = (actorId) => s.packets.filter((p) => p.u === s.users.get(actorId) && p.customPacketType === 'notification').map((p) => p.text)
  const locks = (actorId) => s.packets.filter((p) => p.u === s.users.get(actorId) && p.customPacketType === 'actionLock').map((p) => p.seconds)
  return { ...s, sys, ctx, lines, paid, credited, skin, notices, locks }
}

;(async () => {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [stubs] })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  HuntingSystem = compiled.exports.HuntingSystem

  {
    const t = await setup()
    assert.match(t.lines.join('\n'), /players skinned on crouch for 1016b3 and the heart b18cd at 10%, the Khajiit pelt 4013e0 at 20% for race 13745, 88845$/m)
    assert.equal(t.skin(LOOTER), false, 'a non-hunter only searches')
    assert.deepEqual(t.notices(LOOTER), [])
    assert.equal(t.skin(HUNTER), false, 'standing, the hunter searches')
    assert.deepEqual(t.notices(HUNTER), ['Crouch and interact to skin the body instead.'])
    t.forms.get(HUNTER).inventory = { entries: [] }
    t.state.sneaking.add(HUNTER)
    assert.equal(t.skin(HUNTER), false, 'no knife')
    assert.equal(t.notices(HUNTER).at(-1), 'A hunting knife would skin the body.')
    t.forms.get(HUNTER).inventory = { entries: [{ baseId: KNIFE, count: 1 }] }
    assert.equal(t.sys.searchRefusal(VICTIM), '')
    assert.equal(t.skin(HUNTER), true, 'crouched with the knife, the hunter skins')
    assert.deepEqual(t.locks(HUNTER), [5])
    assert.equal(t.sys.searchRefusal(VICTIM), 'A hunter is skinning this body.')
    t.state.sneaking.add(OTHER_HUNTER)
    assert.equal(t.skin(OTHER_HUNTER), false, 'one hunter at a time')
    assert.equal(t.sys.searchRefusal(VICTIM), 'A hunter is skinning this body.')
    roll = 0.05
    runTimers()
    assert.deepEqual(t.added, [{ to: HUNTER, item: FLESH, count: 1 }, { to: HUNTER, item: HEART, count: 1 }])
    assert.deepEqual(t.forms.get(VICTIM).inventory.entries.map((e) => [e.baseId, e.count]), [[0xf, 300], [0x12eb7, 1]], 'the pack stays on the body')
    assert.equal(t.forms.get(VICTIM).isDisabled, undefined, 'the body is never hidden')
    assert.deepEqual(t.notices(VICTIM), ['Your body was skinned by a hunter. Nothing was taken from your pack.'])
    assert.deepEqual(t.paid, [[HUNTER, 'fight', 'skin', true]])
    assert.deepEqual(t.credited, [[HUNTER, 'hunter']])
    assert.match(t.lines.join('\n'), /ff000a01 skinned the body of player ff000b01 \(profile 4\): 1016b3 x1, heart b18cd \(10% chance\), nothing of the pack taken/)
    assert.equal(t.sys.searchRefusal(VICTIM), 'This body has been skinned. Nothing can be taken from it.')
    assert.equal(t.skin(OTHER_HUNTER), false, 'once per death')
    assert.deepEqual(t.notices(OTHER_HUNTER), [], 'the search refusal says it was skinned')
    t.forms.get(VICTIM).isDead = false
    t.mp.onRespawn(VICTIM)
    assert.equal(t.sys.searchRefusal(VICTIM), '', 'the respawn clears the mark')
    t.forms.get(VICTIM).isDead = true
    roll = 0.5
    assert.equal(t.skin(OTHER_HUNTER), true, 'the next death is a fresh body')
    runTimers()
    assert.deepEqual(t.added.slice(2), [{ to: OTHER_HUNTER, item: FLESH, count: 1 }], 'no heart above the chance')
    assert.match(t.lines.join('\n'), /no heart \(10% chance\)/)
  }

  {
    const t = await setup()
    t.state.sneaking.add(HUNTER)
    assert.equal(t.skin(HUNTER), true)
    t.forms.get(VICTIM).isDead = false
    t.mp.onRespawn(VICTIM)
    assert.deepEqual(t.locks(HUNTER), [5, 0], 'the skinner is stood up')
    assert.equal(t.notices(HUNTER).at(-1), 'The body is gone before you could finish.')
    runTimers()
    assert.deepEqual(t.added, [], 'a respawn mid-skin gives nothing')
    assert.match(t.lines.join('\n'), /stopped skinning the body of player ff000b01: they respawned/)
    assert.equal(t.skin(HUNTER), false, 'a living player is no body')
  }

  {
    const t = await setup()
    t.state.sneaking.add(HUNTER)
    assert.equal(t.skin(HUNTER), true)
    t.forms.get(HUNTER).pos = [5000, 0, 0]
    runTimers()
    assert.deepEqual(t.added, [])
    assert.match(t.lines.join('\n'), /stopped skinning the body of player ff000b01: out of reach/)
    assert.equal(t.sys.searchRefusal(VICTIM), '', 'an interrupted skinning leaves the body open')
    t.forms.get(HUNTER).pos = [0, 0, 0]
    assert.equal(t.skin(HUNTER), true)
    t.forms.get(HUNTER)['private.bleedout'] = { since: 1 }
    runTimers()
    assert.match(t.lines.join('\n'), /stopped skinning the body of player ff000b01: downed/)
    delete t.forms.get(HUNTER)['private.bleedout']
    assert.equal(t.skin(HUNTER), true)
    t.forms.get(HUNTER)['private.restrained'] = { boundHands: true }
    runTimers()
    assert.match(t.lines.join('\n'), /stopped skinning the body of player ff000b01: restrained/)
    assert.deepEqual(t.added, [])
  }

  {
    const t = await setup()
    t.state.sneaking.add(HUNTER)
    t.forms.get(VICTIM).isDead = false
    t.forms.get(VICTIM)['private.bleedout'] = { since: 1 }
    assert.equal(t.skin(HUNTER), false, 'a downed player is not skinned')
    assert.equal(t.skin(HUNTER, CLONE), false, 'a clone BodySystem does not know is passed over')
    assert.equal(t.sys.searchRefusal(CLONE), '')
    t.forms.get(VICTIM).isDead = true
    t.sys.leftBody = (id) => id === VICTIM
    assert.equal(t.skin(HUNTER), false, 'a stripped PK victim is passed over')
    t.sys.leftBody = undefined
    assert.equal(t.skin(HUNTER, WOLF), true, 'animals are still skinned')
    assert.equal(t.sys.searchRefusal(WOLF), '', 'an animal body keeps its search rules')
  }

  {
    const t = await setup()
    t.state.sneaking.add(HUNTER)
    assert.equal(t.mp.onActivate(VICTIM, HUNTER), true, 'the native activation never skins a player body')
    assert.deepEqual(t.notices(HUNTER), [])
    assert.deepEqual(t.locks(HUNTER), [])
    assert.equal(t.sys.searchRefusal(VICTIM), '')
    assert.equal(t.mp.onActivate(WOLF, HUNTER), false, 'it still skins an animal')
  }

  {
    const t = await setup({ huntingSkinPlayers: 'interact', huntingHumanHeart: '', huntingHumanHeartChance: 0.5 })
    assert.match(t.lines.join('\n'), /players skinned on interact for 1016b3, no heart/)
    assert.equal(t.mp.onActivate(VICTIM, HUNTER), true, 'only the search request skins a player body')
    assert.equal(t.skin(HUNTER), true, 'interact skins standing')
    roll = 0
    runTimers()
    assert.deepEqual(t.added, [{ to: HUNTER, item: FLESH, count: 1 }])
    assert.match(t.lines.join('\n'), /1016b3 x1, no heart, nothing of the pack taken/)
  }

  {
    const t = await setup({ huntingSkinPlayers: 'off' })
    t.state.sneaking.add(HUNTER)
    assert.match(t.lines.join('\n'), /players not skinned/)
    assert.equal(t.skin(HUNTER), false)
    assert.deepEqual(t.notices(HUNTER), [])
  }

  {
    const t = await setup({ huntingSkinPlayers: 'sometimes' })
    assert.match(t.lines.join('\n'), /huntingSkinPlayers "sometimes" is not one of crouch, interact, off, "crouch" is used/)
  }

  {
    const t = await setup()
    t.forms.get(VICTIM).appearance = { raceId: KHAJIIT }
    t.state.sneaking.add(HUNTER)
    assert.equal(t.skin(HUNTER), true)
    roll = 0.15
    runTimers()
    assert.deepEqual(t.added, [{ to: HUNTER, item: FLESH, count: 1 }, { to: HUNTER, item: KPELT, count: 1 }], 'a Khajiit body adds the pelt under 20%')
    assert.match(t.lines.join('\n'), /skinned the body of player ff000b01 \(profile 4\): 1016b3 x1, no heart \(10% chance\), Khajiit pelt 4013e0 \(20% chance\), nothing of the pack taken/)
    t.forms.get(VICTIM).isDead = false
    t.mp.onRespawn(VICTIM)
    t.forms.get(VICTIM).isDead = true
    t.forms.get(VICTIM).appearance = { raceId: KHAJIIT_VAMPIRE }
    assert.equal(t.skin(HUNTER), true)
    runTimers()
    assert.deepEqual(t.added.slice(2), [{ to: HUNTER, item: FLESH, count: 1 }, { to: HUNTER, item: KPELT, count: 1 }], 'the vampire form counts too')
    t.forms.get(VICTIM).isDead = false
    t.mp.onRespawn(VICTIM)
    t.forms.get(VICTIM).isDead = true
    roll = 0.25
    assert.equal(t.skin(HUNTER), true)
    runTimers()
    assert.deepEqual(t.added.slice(4), [{ to: HUNTER, item: FLESH, count: 1 }], 'no pelt above the chance')
    assert.match(t.lines.join('\n'), /no heart \(10% chance\), no Khajiit pelt \(20% chance\), nothing of the pack taken/)
  }

  {
    const t = await setup()
    t.sys.pkBodyOf = (id) => id === CLONE ? { victimId: VICTIM, profileId: 4 } : undefined
    t.sys.leftBody = (id) => id === VICTIM
    t.state.sneaking.add(HUNTER)
    t.state.sneaking.add(OTHER_HUNTER)
    assert.equal(t.skin(LOOTER, CLONE), false, 'a non-hunter only searches the PK body')
    assert.equal(t.skin(HUNTER, CLONE), true, 'a hunter skins the PK body')
    assert.match(t.lines.join('\n'), /ff000a01 skins the PK body ff000c01 of player ff000b01 \(profile 4\)/)
    assert.equal(t.sys.searchRefusal(CLONE), 'A hunter is skinning this body.')
    assert.equal(t.skin(OTHER_HUNTER, CLONE), false, 'one hunter at a time')
    assert.equal(t.skin(OTHER_HUNTER), false, 'the stripped victim is passed over')
    roll = 0.15
    runTimers()
    assert.deepEqual(t.added, [{ to: HUNTER, item: FLESH, count: 1 }, { to: HUNTER, item: KPELT, count: 1 }], 'a PK body that looks Khajiit adds the pelt')
    assert.deepEqual(t.forms.get(CLONE).inventory.entries, [{ baseId: 0xf, count: 50 }], 'the PK body keeps its pack')
    assert.equal(t.forms.get(CLONE)['private.skinned'], HUNTER)
    assert.equal(t.sys.searchRefusal(CLONE), '', 'the PK body opens for the usual loot rules')
    assert.deepEqual(t.notices(VICTIM), ['The body you left behind was skinned by a hunter.'])
    assert.deepEqual(t.paid, [[HUNTER, 'fight', 'skin', true]])
    assert.match(t.lines.join('\n'), /ff000a01 skinned the PK body ff000c01 of player ff000b01 \(profile 4\): 1016b3 x1, no heart \(10% chance\), Khajiit pelt 4013e0 \(20% chance\), the body keeps its pack/)
    assert.equal(t.skin(OTHER_HUNTER, CLONE), false, 'a PK body is skinned once')
    assert.equal(t.notices(OTHER_HUNTER).at(-1), 'This body has already been skinned.', 'and the search goes on into the loot window')
    assert.equal(t.lines.filter((l) => /ff000a02 skins the PK body/.test(l)).length, 0)
    assert.equal(t.skin(OTHER_HUNTER), false, 'and the own body of that death is passed over')
    t.forms.get(VICTIM).isDead = false
    t.mp.onRespawn(VICTIM)
    t.sys.leftBody = undefined
    assert.equal(t.skin(OTHER_HUNTER, CLONE), false, 'the mark on the PK body outlives the respawn')
    t.forms.get(VICTIM).isDead = true
    assert.equal(t.skin(OTHER_HUNTER), true, 'a later death is a fresh body')
  }

  {
    const t = await setup()
    t.state.sneaking.add(HUNTER)
    assert.equal(t.skin(HUNTER), true)
    t.sys.leftBody = (id) => id === VICTIM
    runTimers()
    assert.deepEqual(t.added, [], 'a PK body left during the skinning holds that death')
    assert.match(t.lines.join('\n'), /stopped skinning the body of player ff000b01: a PK body took their pack/)
    assert.equal(t.sys.searchRefusal(VICTIM), '')
  }

  {
    const t = await setup({}, ['AldKhajiitPelt'])
    assert.match(t.lines.join('\n'), /not in the load order, ignored: .*AldKhajiitPelt/)
    assert.match(t.lines.join('\n'), /players skinned on crouch for 1016b3 and the heart b18cd at 10%, no Khajiit pelt$/m)
    t.forms.get(VICTIM).appearance = { raceId: KHAJIIT }
    t.state.sneaking.add(HUNTER)
    roll = 0
    assert.equal(t.skin(HUNTER), true)
    runTimers()
    assert.deepEqual(t.added, [{ to: HUNTER, item: FLESH, count: 1 }, { to: HUNTER, item: HEART, count: 1 }], 'no pelt record, no pelt')
    assert.match(t.lines.join('\n'), /1016b3 x1, heart b18cd \(10% chance\), nothing of the pack taken/)
  }

  {
    const t = await setup({ huntingKhajiitPelt: '', huntingKhajiitPeltChance: 0.5 })
    assert.match(t.lines.join('\n'), /, no Khajiit pelt$/m)
    assert.doesNotMatch(t.lines.join('\n'), /ignored: .*AldKhajiitPelt/)
    const u = await setup({ huntingKhajiitPeltChance: 0.5 })
    assert.match(u.lines.join('\n'), /the Khajiit pelt 4013e0 at 50% for race 13745, 88845/)
  }

  console.log('test-player-skinning: all checks passed')
})().catch((e) => { console.error(e); process.exit(1) })
