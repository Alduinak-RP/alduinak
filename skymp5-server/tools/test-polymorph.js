'use strict'

// polymorph.ts against a stub mp and a fixed race list: refusals, transform, face rules, gear, the weapon lock and attack events, sex swap, revert and the restart lookup: node tools/test-polymorph.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'polymorph.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false })
const compiled = new Module(source)
compiled._compile(outputFiles[0].text, source)
const { Polymorph } = compiled.exports

const PLUGINS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm']
const idOf = (desc) => {
  const [hex, file] = desc.split(':')
  const index = PLUGINS.indexOf(file)
  if (index < 0) throw new Error(file + ' not found in loaded files')
  return ((index << 24) | parseInt(hex, 16)) >>> 0
}

const sex = (usable, head = [], faceTexture = '') => ({ usable, head, faceTexture })
const race = (desc, edid, group, faceGen, extra = {}) => ({
  desc, edid, name: edid.replace(/Race.*/, ''), group, faceGen, morph: '', risk: '', shield: true, attacks: [], male: sex(true), female: sex(true), ...extra,
})
const RACES = [
  race('13746:Skyrim.esm', 'NordRace', 'playable', true, { male: sex(true, ['1:Skyrim.esm', '2:Skyrim.esm']), female: sex(true, ['3:Skyrim.esm'], '3b522:Skyrim.esm') }),
  race('13745:Skyrim.esm', 'KhajiitRace', 'playable', true, { male: sex(true, ['51616:Skyrim.esm', '5150d:Skyrim.esm']), female: sex(true, ['51612:Skyrim.esm'], 'f00:Missing.esp') }),
  race('88794:Skyrim.esm', 'NordRaceVampire', 'vampire', true, { morph: '13746:Skyrim.esm' }),
  race('1320a:Skyrim.esm', 'WolfRace', 'creature', false, { shield: false, attacks: ['attackStart_Attack1', 'attackStart_AttackLeft1'] }),
  race('131f0:Skyrim.esm', 'DremoraRace', 'people', true, { shield: false, attacks: ['attackStart'] }),
  race('d53:Skyrim.esm', 'DraugrRace', 'creature', false, { attacks: ['attackStart1HMSwipe'] }),
  race('e7713:Skyrim.esm', 'AlduinRace', 'creature', false, { female: sex(false), risk: 'flying race' }),
  race('17f44:Skyrim.esm', 'SkeeverRace', 'creature', false, { female: sex(false) }),
  race('99999:Skyrim.esm', 'BrokenRace', 'creature', false, { male: sex(false), female: sex(false) }),
]

function stubMp () {
  const props = new Map()
  const packets = []
  const sets = []
  const mp = {
    get: (id, key) => {
      if (!props.has(id)) throw new Error('no form')
      return props.get(id)[key]
    },
    set: (id, key, value) => {
      if (!props.has(id)) throw new Error('no form')
      sets.push(key)
      props.get(id)[key] = value === null ? null : JSON.parse(JSON.stringify(value))
    },
    getIdFromDesc: idOf,
    getUserByActor: (id) => (id === 0xff000001 ? 3 : -1),
    isConnected: (u) => u === 3,
    sendCustomPacket: (u, text) => packets.push({ u, ...JSON.parse(text) }),
    findFormsByPropertyValue: (key, value) => Array.from(props.entries()).filter(([, p]) => p[key] === value).map(([id]) => id),
  }
  return { mp, props, packets, sets }
}

const NORD_LOOK = {
  isFemale: false, raceId: 0x13746, weight: 50, skinColor: 111, hairColor: 222, headpartIds: [0x10, 0x11], headTextureSetId: 0x77,
  options: new Array(19).fill(0.5), presets: [1, 2, 3, 4], tints: [{ texturePath: 'a.dds', argb: 5, type: 1 }], name: 'Hrolf',
}
const WORN = [{ baseId: 0x12eb7, count: 1, worn: true }, { baseId: 0x13911, count: 1, worn: true }, { baseId: 0x64b31, count: 1, worn: false }]

function setup (look = NORD_LOOK) {
  const s = stubMp()
  s.props.set(0xff000001, {
    appearance: JSON.parse(JSON.stringify(look)),
    equipment: { inv: { entries: WORN }, numChanges: 7 },
    inventory: { entries: [{ baseId: 0x12eb7, count: 1 }, { baseId: 0x64b31, count: 1 }] },
  })
  const lines = []
  const pm = new Polymorph((line) => lines.push(line), '', [])
  pm.races = RACES
  pm.byDesc = new Map(RACES.map((r) => [r.desc.toLowerCase(), r]))
  return { ...s, pm, lines, id: 0xff000001, p: s.props.get(0xff000001) }
}

// Captures the delayed gear restore so it runs on demand
const timers = []
global.setTimeout = (fn) => { timers.push(fn); return 0 }

let t = setup()
assert.equal(new Polymorph(() => {}, '', []).transform(t.mp, t.id, '1320a:Skyrim.esm', 1).startsWith('The race list is still loading'), true, 'no catalog yet')
assert.equal(t.pm.transform(t.mp, t.id, 'dead:Skyrim.esm', 1), 'Unknown race')
assert.match(t.pm.transform(t.mp, t.id, '99999:Skyrim.esm', 1), /no skeleton/, 'a race without a skeleton is refused')
assert.equal(t.pm.transform(t.mp, t.id, 'e7713:Skyrim.esm', 1), 'Alduin (AlduinRace) is marked as a crash risk (flying race), refused')
assert.equal(t.pm.transform(t.mp, t.id, '13746:Skyrim.esm', 1), 'The character already is that race')
assert.equal(t.p['private.polymorph'], undefined, 'refusals store nothing')

// Nord to wolf: no FaceGen head, gear off before the body changes, the original stored and indexed
let r = t.pm.transform(t.mp, t.id, '1320a:skyrim.esm', 12)
assert.equal(typeof r, 'object')
assert.equal(r.gearOff, true)
assert.equal(r.face, 'no FaceGen head')
assert.deepEqual(t.p.appearance, { ...NORD_LOOK, raceId: 0x1320a, skinColor: 0, hairColor: 0, headpartIds: [], headTextureSetId: 0, options: new Array(19).fill(0), presets: [0, 0, 0, 0], tints: [] })
assert.ok(t.sets.indexOf('equipment') < t.sets.indexOf('appearance'), 'equipment is stripped before the appearance changes')
assert.deepEqual(t.p.equipment.inv.entries, [])
assert.deepEqual(t.p['private.polymorph'].appearance, NORD_LOOK)
assert.deepEqual(t.p['private.polymorph'].equipment.inv.entries, WORN.slice(0, 2), 'only the worn entries are kept')
assert.equal(t.p['private.polymorph'].by, 12)
assert.equal(t.p['private.indexed.polymorph'], 'on')
assert.equal(r.noDraw, true)
assert.equal(r.attacks, 2)
assert.deepEqual(t.packets.pop(), { u: 3, customPacketType: 'polymorph', on: true, raceId: 0x1320a, gearOff: true, noDraw: true, attacks: ['attackStart_Attack1', 'attackStart_AttackLeft1'], worn: [] })

// Wolf to the Nord's vampire form: the stored original stays, the own face comes back, the gear stays off until Revert
const since = t.p['private.polymorph'].since
r = t.pm.transform(t.mp, t.id, '88794:Skyrim.esm', 13)
assert.equal(r.face, 'own face kept')
assert.equal(r.gearOff, false)
assert.equal(r.noDraw, false, 'a race with a shield biped object draws weapons')
assert.deepEqual(t.packets.pop().attacks, [], 'a humanoid form attacks the engine way')
assert.deepEqual(t.p.appearance, { ...NORD_LOOK, raceId: 0x88794 })
assert.deepEqual(t.p['private.polymorph'].appearance, NORD_LOOK)
assert.deepEqual(t.p['private.polymorph'].equipment.inv.entries, WORN.slice(0, 2))
assert.equal(t.p['private.polymorph'].since, since)
assert.equal(t.pm.transform(t.mp, t.id, '13746:Skyrim.esm', 1), "That is the character's own race, use Revert")

// A /mask while transformed renames the current look; Revert keeps that name and puts everything else back
t.p.appearance.name = 'Masked Person'
const rec = t.pm.revert(t.mp, t.id, 'by test')
assert.ok(rec)
assert.deepEqual(t.p.appearance, { ...NORD_LOOK, name: 'Masked Person' })
assert.equal(t.p['private.polymorph'], null)
assert.equal(t.p['private.indexed.polymorph'], null)
const back = t.packets.pop()
assert.equal(back.on, false)
assert.equal(back.raceId, 0x13746)
assert.equal(back.noDraw, false)
assert.deepEqual(back.attacks, [])
assert.deepEqual(back.worn, [WORN[0]], 'only worn items the character still carries go back on')
assert.equal(timers.length, 1)
timers.shift()()
assert.deepEqual(t.p.equipment.inv.entries, [WORN[0]], 'the server gear follows after the delay')
assert.equal(t.pm.revert(t.mp, t.id, 'twice'), null, 'a second revert finds nothing')
assert.match(t.lines.join('\n'), /polymorph revert ff000001 by test: NordRaceVampire|polymorph revert ff000001 by test: Nord/)

// Nord to Khajiit: the race default head, an unknown face texture plugin reads as none
t = setup({ ...NORD_LOOK, isFemale: true })
r = t.pm.transform(t.mp, t.id, '13745:Skyrim.esm', 1)
assert.match(r.face, /race default head \(1 part/)
assert.deepEqual(t.p.appearance.headpartIds, [0x51612])
assert.equal(t.p.appearance.headTextureSetId, 0)
assert.equal(t.p.appearance.skinColor, 111, 'a FaceGen race keeps the colours')
assert.deepEqual(t.p.equipment.inv.entries, WORN, 'a playable race keeps the gear')

// A humanoid race without a shield biped object keeps its gear and its weapons sheathed; a creature with one draws and attacks the engine way
t = setup()
r = t.pm.transform(t.mp, t.id, '131f0:Skyrim.esm', 1)
assert.equal(r.gearOff, false)
assert.equal(r.noDraw, true)
assert.deepEqual(t.packets.pop(), { u: 3, customPacketType: 'polymorph', on: true, raceId: 0x131f0, gearOff: false, noDraw: true, attacks: [], worn: [] })
r = t.pm.transform(t.mp, t.id, 'd53:Skyrim.esm', 1)
assert.equal(r.gearOff, true)
assert.equal(r.noDraw, false)
assert.deepEqual(t.packets.pop().attacks, [])

// A female admin into a male-only race gets the male body; the revert brings her back
t = setup({ ...NORD_LOOK, isFemale: true })
r = t.pm.transform(t.mp, t.id, '17f44:Skyrim.esm', 1)
assert.equal(r.swapped, true)
assert.equal(t.p.appearance.isFemale, false)
t.pm.revert(t.mp, t.id, 'test')
assert.equal(t.p.appearance.isFemale, true)

// A restart finds the characters left transformed through the index
t = setup()
t.pm.transform(t.mp, t.id, '1320a:Skyrim.esm', 1)
assert.deepEqual(t.pm.transformedActors(t.mp), [t.id])
t.pm.revert(t.mp, t.id, 'at boot')
assert.deepEqual(t.pm.transformedActors(t.mp), [])

console.log('polymorph: all checks passed')
