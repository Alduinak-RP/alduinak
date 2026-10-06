'use strict'

// The client's one hidden state for world refs (skymp5-client view/modelApplyUtils.ts applyModelVisibility) against a stub engine whose latent calls run in order on the next VM step: a taken item stays hidden through a disabled=false update, after a loaded game and when its carry ends, a carried item shows again when the carry ends, a hidden plant is left disabled after its harvested refresh: node tools/test-plugin-ref-visibility.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', '..', 'skymp5-client', 'src', 'view', 'modelApplyUtils.ts')
const TYPES = { Activator: 24, Misc: 32, Tree: 38, Flora: 39 }

// Papyrus natives are latent: queued here and run in order on the next VM step, each promise settling after its call
const vm = []
const latent = (fn) => new Promise((resolve) => vm.push(() => { fn(); resolve() }))
async function settle () {
  while (vm.length) {
    for (const call of vm.splice(0)) call()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const refs = new Map()
class Refr {
  constructor (id, type) { this.id = id; this.type = type; this.disabled = false; this.harvested = false; this.log = []; refs.set(id, this) }
  getFormID () { return this.id }
  getBaseObject () { return { getType: () => this.type, getFormID: () => 1, getName: () => 'thing' } }
  isDisabled () { return this.disabled }
  isHarvested () { return this.harvested }
  setHarvested (v) { this.harvested = v; this.log.push(`harvested ${v}`) }
  disable () { return latent(() => { this.disabled = true; this.log.push('disable') }) }
  enable () { return latent(() => { this.disabled = false; this.log.push('enable') }) }
  activate () { this.harvested = true; this.log.push('activate'); return true }
  getPositionX () { return 0 }
  getPositionY () { return 0 }
  getPositionZ () { return 0 }
}

global.__visibilityTestPlatform = {
  FormType: TYPES,
  Game: { getFormEx: (id) => refs.get(id) ?? null, findRandomActor: () => null, getForm: () => null, getPlayer: () => null },
  ObjectReference: { from: (f) => f ?? null },
  Actor: { from: () => null },
  TextureSet: { from: () => null },
  NetImmerse: {},
}

const stubs = {
  name: 'stubs',
  setup (build) {
    const stub = (filter, contents) => {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }))
      build.onLoad({ filter, namespace: 'stub' }, () => ({ contents, loader: 'js' }))
    }
    stub(/^(skyrimPlatform|@skyrim-platform\/skyrim-platform)$/, 'module.exports = global.__visibilityTestPlatform')
    stub(/sync\/inventory$/, 'exports.applyInventory = () => {}')
    stub(/logging$/, 'exports.logError = () => {}; exports.logTrace = () => {}')
    stub(/createActorMessage$/, 'module.exports = {}')
  },
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

async function main () {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', plugins: [stubs] })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  const { ModelApplyUtils } = compiled.exports
  const show = (refr, harvested, hidden) => ModelApplyUtils.applyModelVisibility(refr, harvested, hidden)

  await test('a taken item is hidden, and a disabled=false update does not show it again', async () => {
    const sword = new Refr(0x1001, TYPES.Misc)
    show(sword, true, false)
    await settle()
    assert.equal(sword.disabled, true)
    show(sword, true, false)
    await settle()
    assert.deepEqual(sword.log, ['disable'])
  })

  await test('a taken item a loaded game brought back enabled is hidden again', async () => {
    const sword = new Refr(0x1002, TYPES.Misc)
    show(sword, true, false)
    await settle()
    sword.disabled = false
    show(sword, true, false)
    await settle()
    assert.equal(sword.disabled, true)
    assert.deepEqual(sword.log, ['disable', 'disable'])
  })

  await test('a carried item hides and shows again when the carry ends', async () => {
    const cup = new Refr(0x1003, TYPES.Misc)
    show(cup, false, true)
    await settle()
    assert.equal(cup.disabled, true)
    show(cup, false, false)
    await settle()
    assert.equal(cup.disabled, false)
    assert.deepEqual(cup.log, ['disable', 'enable'])
  })

  await test('a taken item stays hidden when its carry ends', async () => {
    const cup = new Refr(0x1004, TYPES.Misc)
    show(cup, true, true)
    await settle()
    show(cup, true, false)
    await settle()
    assert.equal(cup.disabled, true)
    assert.deepEqual(cup.log, ['disable'])
  })

  await test('a harvested plant that is shown refreshes its 3D and ends enabled', async () => {
    const bush = new Refr(0x1005, TYPES.Flora)
    show(bush, true, false)
    await settle()
    assert.equal(bush.harvested, true)
    assert.equal(bush.disabled, false)
    assert.deepEqual(bush.log, ['harvested true', 'disable', 'enable'])
  })

  await test('a harvested plant the server hides is left disabled after the refresh', async () => {
    const bush = new Refr(0x1006, TYPES.Tree)
    show(bush, true, true)
    await settle()
    assert.equal(bush.harvested, true)
    assert.equal(bush.disabled, true)
    assert.ok(!bush.log.includes('enable'), bush.log.join())
  })

  await test('a hidden plant shown again once regrown ends enabled and unharvested', async () => {
    const bush = new Refr(0x1007, TYPES.Flora)
    show(bush, true, true)
    await settle()
    show(bush, false, false)
    await settle()
    assert.equal(bush.harvested, false)
    assert.equal(bush.disabled, false)
  })

  await test('a disabled activator hides and shows with the server flag alone', async () => {
    const lever = new Refr(0x1008, TYPES.Activator)
    show(lever, false, true)
    await settle()
    assert.equal(lever.disabled, true)
    show(lever, false, false)
    await settle()
    assert.equal(lever.disabled, false)
    assert.deepEqual(lever.log, ['disable', 'enable'])
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
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
