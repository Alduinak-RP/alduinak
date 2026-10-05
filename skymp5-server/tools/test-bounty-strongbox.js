'use strict'

// The board strongboxes at boot (bountyBoardSystem.ts stashOf): a box of another base is swapped with its contents, and the boot line says what each holds: node tools/test-bounty-strongbox.js

const assert  = require('node:assert/strict')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const { EventEmitter } = require('events')
const esbuild = require('esbuild')

// bounty.log is the shared live log, so anything this run appends goes to a scratch folder
process.env.ALDUINAK_LOG_DIR = path.join(os.tmpdir(), 'alduinak-test-logs')

const systemSource = path.join(__dirname, '..', 'ts', 'systems', 'bountyBoardSystem.ts')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: {} }) }', loader: 'js' }))
  },
}

async function load (source) {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', plugins: [settingsStub] })
  const compiled = new Module(source)
  compiled.filename = source
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const PLUGIN_BASE = { 'skyrim.esm': 0, 'missives.esp': 0x05000000 }
const OLD_BASE = '10aad2:Skyrim.esm'
const NEW_BASE = '9424c:Skyrim.esm'
const WHITERUN = 0x05000d66
const GOLD = 0xf
const SWORD = 0x12eb7

// A world of references with properties, enough of ScampServer for the strongbox code
function makeWorld () {
  const refs = new Map()
  let nextFf = 0xff000001
  const ref = (id) => {
    if (!refs.has(id)) refs.set(id, { pos: [id & 0xffff, 0, 0], worldOrCellDesc: '3c:Skyrim.esm' })
    return refs.get(id)
  }
  const idOf = (desc) => {
    const [hex, plugin] = String(desc).split(':')
    if (plugin === undefined) return (0xff000000 + parseInt(hex, 16)) >>> 0
    const base = PLUGIN_BASE[plugin.toLowerCase()]
    if (base === undefined) throw new Error('unknown plugin ' + plugin)
    return (base + parseInt(hex, 16)) >>> 0
  }
  const descOf = (id) => (id >= 0xff000000 ? (id - 0xff000000).toString(16) : id >= 0x05000000 ? (id - 0x05000000).toString(16) + ':Missives.esp' : id.toString(16) + ':Skyrim.esm')
  const mp = {
    getIdFromDesc: idOf,
    getDescFromId: descOf,
    lookupEspmRecordById: (id) => ({ record: { type: [idOf(OLD_BASE), idOf(NEW_BASE)].includes(id) ? 'CONT' : 'ACTI' } }),
    get: (id, prop) => {
      if (!refs.has(id)) throw new Error('no form ' + id.toString(16))
      return refs.get(id)[prop]
    },
    set: (id, prop, value) => { ref(id)[prop] = value },
    callPapyrusFunction: (kind, cls, fn, self, args) => {
      const selfId = idOf(self.desc)
      if (fn === 'PlaceAtMe') {
        const id = nextFf++
        refs.set(id, { baseDesc: args[0].desc, pos: ref(selfId).pos.slice(), worldOrCellDesc: ref(selfId).worldOrCellDesc, isDisabled: args[3] })
        return { type: 'form', desc: descOf(id) }
      }
      if (fn === 'MoveTo') {
        const target = ref(idOf(args[0].desc))
        ref(selfId).pos = [target.pos[0] + args[1], target.pos[1] + args[2], target.pos[2] + args[3]]
        return undefined
      }
      if (fn === 'Delete') {
        refs.delete(selfId)
        return undefined
      }
      throw new Error('unexpected ' + cls + '.' + fn)
    },
  }
  return { mp, refs, ref }
}

async function boot (BountyBoardSystem, world) {
  const lines = []
  const sys = new BountyBoardSystem((l) => lines.push(l))
  const gm = new EventEmitter()
  await sys.initAsync({ svr: world.mp, gm })
  gm.emit('worldLoaded')
  await new Promise((resolve) => setImmediate(resolve))
  return lines
}

;(async () => {
  const { BountyBoardSystem } = await load(systemSource)
  const world = makeWorld()
  // Every board reference exists; Riften and Windhelm are past their one-time swap
  for (const local of [0xd66, 0x12cc, 0x21846, 0x21847, 0x9492, 0x9491, 0x21844, 0x21845, 0x9478, 0x9477, 0x2183a, 0x2183f, 0x94a3, 0x94a2, 0x21840, 0x21841,
    0x9490, 0x948f, 0x21838, 0x21839, 0x94b1, 0x94ae, 0x94b5, 0x94b2, 0x94ad, 0x94aa, 0x94a9, 0x94a6]) world.ref(0x05000000 + local)
  world.ref(0x05009492)['private.bountyBoardSwapped'] = true

  // Whiterun has a box of the old base with two posting fees and a sword a steward put away
  const oldBox = 0xff000777
  const held = { entries: [{ baseId: GOLD, count: 50 }, { baseId: SWORD, count: 1 }] }
  world.refs.set(oldBox, { baseDesc: OLD_BASE, pos: [0xd66 & 0xffff, 0, 0], worldOrCellDesc: '3c:Skyrim.esm', inventory: held })
  world.ref(WHITERUN)['private.bountyBoard'] = { nextId: 3, notes: [], stash: oldBox }

  let lines = await boot(BountyBoardSystem, world)
  const whiterunBox = world.ref(WHITERUN)['private.bountyBoard'].stash
  assert.notEqual(whiterunBox, oldBox)
  assert.equal(world.refs.get(whiterunBox).baseDesc, NEW_BASE)
  assert.deepEqual(world.refs.get(whiterunBox).inventory, held)
  assert.equal(world.refs.has(oldBox), false)
  assert.ok(lines.some((l) => new RegExp(`placed the Whiterun board strongbox ${whiterunBox.toString(16)} in place of ff000777 \\(${OLD_BASE}\\), contents moved`).test(l)), lines.join('\n'))

  // Every other board gets an empty box of the base without items, and one line says what they all hold
  const boxes = Array.from(world.refs.entries()).filter(([, r]) => r.baseDesc)
  assert.equal(boxes.length, 9)
  assert.ok(boxes.every(([, r]) => r.baseDesc === NEW_BASE))
  assert.equal(boxes.filter(([, r]) => r.inventory.entries.length === 0).length, 8)
  const holds = lines.find((l) => l.startsWith('[bounty] strongboxes hold: '))
  assert.match(holds, /Whiterun 50 gold and 1 other stack(,|$)/)
  assert.match(holds, /Riften 0 gold(,|$)/)
  assert.equal(holds.split(', ').length, 9)

  // The next start keeps every box
  const before = boxes.map(([id]) => id).sort()
  lines = await boot(BountyBoardSystem, world)
  assert.deepEqual(Array.from(world.refs.entries()).filter(([, r]) => r.baseDesc).map(([id]) => id).sort(), before)
  assert.equal(lines.filter((l) => l.includes('placed the')).length, 0)
  assert.match(lines.find((l) => l.startsWith('[bounty] strongboxes hold: ')), /Whiterun 50 gold and 1 other stack/)

  console.log('test-bounty-strongbox: all checks passed')
  // The hourly sweep's timer would keep the process alive
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
