'use strict'

// General Stats wealth and material counts over fixture characters and containers, with the material ids resolved from stub plugin headers: node tools/test-player-stats.js

const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const P = require('../src/playerData')

const LIGHT = 0x200
const VANILLA = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']

// A Data folder holding a bare TES4 header per plugin
function dataDir(plugins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-stats-'))
  for (const [name, flags] of Object.entries(plugins)) {
    const header = Buffer.alloc(24)
    header.write('TES4', 0, 'latin1')
    header.writeUInt32LE(flags, 8)
    fs.writeFileSync(path.join(dir, name), header)
  }
  return dir
}

const byLabel = materials => Object.fromEntries(materials)
const inv = (...pairs) => pairs.map(([baseId, count]) => ({ baseId, count }))
const character = (name, inventory, over = {}) => ({ name, formDesc: name.toLowerCase(), appearance: { raceId: 0x13746 }, fallen: '', profession: '', roles: [], inventory, ...over })

function main() {
  const dirs = []
  try {
    // Full CC masters take full slots after the DLC, a light .esl a light one
    const dir = dataDir({ ...Object.fromEntries(VANILLA.map(n => [n, 1])), 'ccBGSSSE001-Fish.esm': 1, 'ccQDRSSE001-SurvivalMode.esl': 1 | LIGHT, 'ccBGSSSE025-AdvDSGS.esm': 1 })
    dirs.push(dir)
    const order = [...VANILLA, 'ccBGSSSE001-Fish.esm', 'ccQDRSSE001-SurvivalMode.esl', 'ccBGSSSE025-AdvDSGS.esm']
    const settings = { dataDir: dir, loadOrder: order.map(n => `C:/GOG Games/Skyrim Anniversary Edition/Data/${n}`) }
    let m = byLabel(P.materialIds(settings))
    assert.deepEqual(Object.keys(m), P.MATERIALS.map(x => x[0]))
    assert.deepEqual(m['Leather'], [0x000db5d2])
    assert.deepEqual(m['Leather Strips'], [0x000800e4])
    assert.deepEqual(m['Iron Ingot'], [0x0005ace4])
    assert.deepEqual(m['Refined Malachite'], [0x0005ada1])
    // Records injected into Update.esm's id space keep index 01
    assert.deepEqual(m['Thread'], [0x016ce001])
    assert.deepEqual(m['Glacial Crystal Ingot'], [0x01da0b12])
    assert.deepEqual(m['Wood'], [0x0006f993, 0x0403cf16, 0x0300300e])
    assert.deepEqual(m['Refined Amber'], [0x06000bc7])
    assert.deepEqual(m['Madness Ingot'], [0x06000bc8])
    assert.deepEqual(m['Charcoal'], [0x00033760])

    // An ESL-flagged master reads as 0xFE plus its light slot
    const lightDir = dataDir({ ...Object.fromEntries(VANILLA.map(n => [n, 1])), 'ccQDRSSE001-SurvivalMode.esl': 1 | LIGHT, 'ccBGSSSE025-AdvDSGS.esm': 1 | LIGHT })
    dirs.push(lightDir)
    m = byLabel(P.materialIds({ dataDir: lightDir, loadOrder: [...VANILLA, 'ccQDRSSE001-SurvivalMode.esl', 'ccBGSSSE025-AdvDSGS.esm'] }))
    assert.deepEqual(m['Refined Amber'], [0xfe001bc7])

    // A plugin left out of the load order drops its ids, the rest still resolve
    m = byLabel(P.materialIds({ dataDir: dir, loadOrder: ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm'] }))
    assert.deepEqual(m['Refined Amber'], [])
    assert.deepEqual(m['Wood'], [0x0006f993, 0x0300300e])
    assert.deepEqual(m['Thread'], [0x016ce001])

    // A load order plugin missing from dataDir has no light flag, which the stats page reports
    assert.throws(() => P.materialIds({ dataDir: dir, loadOrder: [...VANILLA, 'Missing.esp'] }), /unknown light flag for Missing\.esp/)

    // Two accounts; the fallen character still counts toward gold and materials, like the carried gold always did
    const backend = {
      players: new Map([['d1', { displayName: 'One' }], ['d2', { displayName: 'Two' }]]),
      profiles: new Map([['d1', 1], ['d2', 2]]),
      bannedIds: new Set(),
      playtime: new Map(),
      whitelist: { factions: [], requirements: [], assignments: [] },
    }
    const materials = P.materialIds(settings)
    const THREAD = 0x016ce001
    const chars = new Map([
      [1, [
        character('Ada', inv([0xf, 120], [0x000db5d2, 3], [0x000800e4, 10], [THREAD, 4], [0x0005ace4, 2])),
        character('Bo', inv([0xf, 30], [0x0006f993, 5], [0x0300300e, 2]), { fallen: 'Sovngarde' }),
      ]],
      [2, [character('Cy', inv([0xf, 50], [0x00033760, 6], [0x06000bc7, 1], [0x0403cf16, 1]))]],
      // A profile the backend does not know is not an account row, so its character is left out
      [3, [character('Orphan', inv([0xf, 9999], [0x000db5d2, 99]))]],
    ])
    const rows = P.buildRows(backend, chars, '')
    const containers = [
      inv([0xf, 400], [0x000db5d2, 7], [0x0005ace4, 3], [0x0005ace5, 8]),
      inv([0x000800e4, 5], [THREAD, 1], [0x00033760, 4], [0x0006f993, 10]),
      // Refined Amber at a light slot belongs to another load order
      inv([0xf, 25], [0xfe001bc7, 2]),
    ]
    const s = P.stats(rows, containers, materials)
    assert.equal(s.players, 2)
    assert.equal(s.carriedWealth, 200)
    assert.equal(s.storedWealth, 425)
    assert.equal(s.totalWealth, 625)
    assert.equal(s.averageWealth, 100)
    assert.deepEqual(s.wealth, { '50 to 499': 2 })
    assert.deepEqual(s.materialOrder, P.MATERIALS.map(x => x[0]))
    assert.equal(s.materials['Leather'], 10)
    assert.equal(s.materials['Leather Strips'], 15)
    assert.equal(s.materials['Iron Ingot'], 5)
    assert.equal(s.materials['Steel Ingot'], 8)
    assert.equal(s.materials['Thread'], 5)
    assert.equal(s.materials['Charcoal'], 10)
    assert.equal(s.materials['Wood'], 18)
    assert.equal(s.materials['Refined Amber'], 1)
    assert.equal(s.materials['Ebony Ingot'], 0)

    // Without containers or materials the page keeps its carried totals
    const bare = P.stats(rows)
    assert.equal(bare.totalWealth, 200)
    assert.equal(bare.storedWealth, 0)
    assert.deepEqual(bare.materials, {})
    assert.deepEqual(bare.materialOrder, [])
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  }
  console.log('player-stats: all checks passed')
}

main()
