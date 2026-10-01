'use strict'

// factionCraftSystem.ts against a stub mp: markers follow the craft ranks, failed calls retry, and the login and change lines: node tools/test-faction-craft.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const load = (file) => {
  const source = path.join(__dirname, '..', 'ts', 'systems', file)
  const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}
const { FactionCraftSystem, markerEdidOf } = load('factionCraftSystem.ts')
const rules = load('factionRules.ts')

const ACTOR = 0xff0003cc
const EASTMARCH = 0x330410ab
const WHITERUN = 0x330410ac

function stub ({ failAdd = false } = {}) {
  const props = new Map([[ACTOR, {}]])
  const calls = []
  const mp = {
    get: (id, key) => props.get(id)[key],
    set: (id, key, value) => { props.get(id)[key] = JSON.parse(JSON.stringify(value)) },
    getDescFromId: (id) => id.toString(16),
    callPapyrusFunction: (kind, cls, fn, self, args) => {
      if (fn === 'AddSpell' && failAdd) throw new Error('no form')
      calls.push(`${fn} ${args[0].desc}`)
      return true
    },
  }
  return { ctx: { svr: mp }, props, calls }
}

function system (craftFactions) {
  const lines = []
  const sys = new FactionCraftSystem((s) => lines.push(s), { factionsWith: (id, key) => (key === 'craft' ? craftFactions() : []) })
  sys.enabled = true
  sys.spells.set('hold:eastmarch', EASTMARCH)
  sys.spells.set('hold:whiterun', WHITERUN)
  return { sys, lines }
}

// The editor ids the plugin carries
assert.equal(markerEdidOf('hold:eastmarch'), 'AldFaction_holdeastmarch')
assert.equal(markerEdidOf('hold:the-rift'), 'AldFaction_holdtherift')

// The owner's 2026-09-30 edit gives a Courtier craft, so a Courtier of Eastmarch is handed its marker
const defs = rules.buildFactions({
  factions: [{ id: 'hold:eastmarch', type: 'hold', name: 'Court of Eastmarch' }],
  requirements: [
    { id: 'hold:eastmarch:jarl', rank: 'Jarl', order: 0 },
    { id: 'hold:eastmarch:captain', rank: 'Captain', order: 3, craft: true },
    { id: 'hold:eastmarch:courtier', rank: 'Courtier', order: 4, craft: true },
    { id: 'hold:eastmarch:citizen', rank: 'Citizen', order: 9 },
  ],
})
const eastmarch = defs.get('hold:eastmarch')
const can = (slug) => rules.hasPermission({ staff: false, rank: rules.rankOf(eastmarch, slug), acting: false }, 'craft')
assert.deepEqual(['jarl', 'captain', 'courtier', 'citizen'].map(can), [true, true, true, false])

// Login: the marker is granted and both the grant and the holding are logged
{
  let factions = ['hold:eastmarch']
  const { sys, lines } = system(() => factions)
  const { ctx, props, calls } = stub()
  sys.sync(ctx, ACTOR, 'at login')
  assert.deepEqual(calls, ['AddSpell 330410ab'])
  assert.deepEqual(props.get(ACTOR)['private.factionMarkers'], [EASTMARCH])
  assert.deepEqual(lines, ['[factionCraft] ff0003cc at login holds the craft marker of hold:eastmarch, granted hold:eastmarch'])

  // A rank reload with nothing changed casts and logs nothing
  sys.sync(ctx, ACTOR, 'after a rank reload')
  assert.equal(calls.length, 1)
  assert.equal(lines.length, 1)

  // A later login still names what the character holds
  sys.sync(ctx, ACTOR, 'at login')
  assert.equal(calls.length, 1)
  assert.equal(lines[1], '[factionCraft] ff0003cc at login holds the craft marker of hold:eastmarch')

  // Moving from Eastmarch to Whiterun swaps the markers
  factions = ['hold:whiterun']
  sys.sync(ctx, ACTOR, 'after a rank reload')
  assert.deepEqual(calls.slice(1), ['RemoveSpell 330410ab', 'AddSpell 330410ac'])
  assert.deepEqual(props.get(ACTOR)['private.factionMarkers'], [WHITERUN])
  assert.equal(lines[2], '[factionCraft] ff0003cc after a rank reload holds the craft marker of hold:whiterun, granted hold:whiterun, revoked hold:eastmarch')

  // Leaving every craft rank takes the last one back
  factions = []
  sys.sync(ctx, ACTOR, 'after a rank reload')
  assert.deepEqual(props.get(ACTOR)['private.factionMarkers'], [])
  assert.equal(lines[3], '[factionCraft] ff0003cc after a rank reload holds the craft marker of nothing, revoked hold:whiterun')

  // No craft rank at login: nothing to say
  sys.sync(ctx, ACTOR, 'at login')
  assert.equal(lines.length, 4)
}

// A grant that throws is not recorded as held, so the next sync tries it again
{
  const { sys, lines } = system(() => ['hold:eastmarch'])
  const failing = stub({ failAdd: true })
  sys.sync(failing.ctx, ACTOR, 'at login')
  assert.equal(failing.props.get(ACTOR)['private.factionMarkers'], undefined)
  assert.match(lines[0], /^\[factionCraft\] could not grant 330410ab to ff0003cc: Error: no form$/)
  const ok = stub()
  ok.props.set(ACTOR, failing.props.get(ACTOR))
  sys.sync(ok.ctx, ACTOR, 'after a rank reload')
  assert.deepEqual(ok.calls, ['AddSpell 330410ab'])
  assert.deepEqual(ok.props.get(ACTOR)['private.factionMarkers'], [EASTMARCH])
}

console.log('test-faction-craft: all checks passed')
