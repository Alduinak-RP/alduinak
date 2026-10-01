'use strict'

// goldWatchSystem.ts drop lines and the pack summary spawn.ts logs at logout, despawn and login, against a stub mp: node tools/test-inventory-log.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')
const { EventEmitter } = require('events')

const MORM = 0xff000e9f
const ORE = 0x71cf3
const PELT = 0x3ad74
const LEATHER = 0xdb5d2
const POTION = 0x3eadd

const stubs = {
  name: 'stubs',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /^settings$/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: {}, master: "", masterKey: "" }) }', loader: 'js' }))
  },
}
const source = path.join(__dirname, '..', 'ts', 'systems', 'goldWatchSystem.ts')

global.setImmediate = (fn) => fn()

;(async () => {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [stubs] })
  const compiled = new Module(source)
  compiled._compile(outputFiles[0].text, source)
  const { GoldWatchSystem, packSummary } = compiled.exports

  {
    const pack = packSummary([
      { baseId: 0xf, count: 128 },
      { baseId: LEATHER, count: 5 },
      { baseId: ORE, count: 18 },
      { baseId: LEATHER, count: 3, name: 'Named' },
      { baseId: PELT, count: 3, worn: false },
      { baseId: 0x12eb7, count: 0 },
    ])
    assert.equal(pack.gold, 128)
    assert.deepEqual(pack.items, ['3ad74 x3', '71cf3 x18', 'db5d2 x8'], 'one count per base id in id order, gold and empty stacks apart')
    assert.deepEqual(packSummary(undefined), { gold: 0, items: [] })
  }

  {
    const lines = []
    const edids = { [ORE]: 'OreIron', [POTION]: 'RestoreHealth01' }
    const mp = {
      get: (id, key) => key === 'profileId' ? 149 : key === 'appearance' ? { name: 'Morm' } : null,
      lookupEspmRecordById: (id) => edids[id] ? { record: { editorId: edids[id] } } : null,
    }
    const gm = new EventEmitter()
    const sys = new GoldWatchSystem((...a) => lines.push(a.join(' ')))
    await sys.initAsync({ svr: mp, gm })
    gm.emit('worldLoaded')

    assert.equal(mp.onDropItem(MORM, ORE, 18), undefined)
    assert.equal(lines.at(-1), '[inv] Morm (ff000e9f, profile 149) dropped OreIron 71cf3 x18')

    mp.onEatItem(MORM, POTION)
    mp.onDropItem(MORM, POTION, 1)
    assert.match(lines.at(-1), /^\[inv\] Morm \(ff000e9f, profile 149\) drop of RestoreHealth01 3eadd x1 \d+ ms after eating one: the client sent the eat as a drop too$/)

    mp.onDropItem(MORM, PELT, 2)
    assert.equal(lines.at(-1), '[inv] Morm (ff000e9f, profile 149) dropped item 3ad74 x2', 'an id without a record still logs')

    // A drop another system refused never happened
    const refusing = { svr: { ...mp, onDropItem: () => false }, gm: new EventEmitter() }
    await new GoldWatchSystem((...a) => lines.push(a.join(' '))).initAsync(refusing)
    refusing.gm.emit('worldLoaded')
    const count = lines.length
    assert.equal(refusing.svr.onDropItem(MORM, ORE, 1), false)
    assert.equal(lines.length, count, 'a refused drop logs nothing')
  }

  console.log('test-inventory-log: all checks passed')
})().catch((e) => { console.error(e); process.exit(1) })
