'use strict'

// The Skills tab's hour bank strip (skymp5-front features/masteryMenu), one strip for the character's hour clock and shared bank, over what
// masteryService.ts parses from masteryMenu and professionState: node tools/test-mastery-bank.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const repo = path.join(__dirname, '..', '..')
const front = path.join(repo, 'skymp5-front')
const menuSource = path.join(front, 'src', 'features', 'masteryMenu', 'index.tsx')
const serviceSource = path.join(repo, 'skymp5-client', 'src', 'services', 'services', 'masteryService.ts')

const stubs = {
  name: 'stubs',
  setup (build) {
    build.onLoad({ filter: /\.scss$/ }, () => ({ contents: '', loader: 'js' }))
    build.onLoad({ filter: /\.jpg$/ }, () => ({ contents: 'module.exports = ""', loader: 'js' }))
    const stub = (filter, contents) => {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }))
      build.onLoad({ filter, namespace: 'stub' }, () => ({ contents, loader: 'js' }))
    }
    stub(/^\.\/clientListener$/, 'exports.ClientListener = class {}')
    stub(/^\.\/customPacketUtil$/, 'exports.onCustomPacket = () => {}; exports.notifyNextUpdate = () => {}')
  },
}

async function load (source) {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', external: ['react', 'react-dom'], jsx: 'transform', plugins: [stubs] })
  const compiled = new Module(source)
  compiled.filename = source
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const MIN = 60000
const HOUR = 60 * MIN
let now = 1e12
Date.now = () => now

const slot = (index, name, profession, label, hours) => ({ slot: index, name, profession, label, rank: 1, rankName: 'Novice', hours, cap: 5, capName: 'Legendary', rankHours: [0, 0, 40, 100, 180, 6000] })
const SLOTS = [slot(0, 'Primary', 'blacksmith', 'Blacksmith', 7), slot(1, 'Secondary', 'tailor', 'Tailor', 3)]
const EMPTY_SLOTS = [slot(0, 'Primary', null, '', 0), slot(1, 'Secondary', null, '', 0)]
const PROFESSIONS = [
  { id: 'alchemist', label: 'Alchemist', title: 'The Patient Hand' }, { id: 'blacksmith', label: 'Blacksmith', title: 'The Forge-Bound' },
  { id: 'tailor', label: 'Tailor', title: 'The Fine Thread' }, { id: 'woodworker', label: 'Woodworker', title: 'The Grain Reader' },
]
// The server's BankSummary, idle unless told otherwise
const bankOf = (extra = {}) => ({ max: 2, intervalMs: HOUR, offline: true, countedMs: 0, counted: null, payMs: 0, queue: [], ...extra })
const menuPacket = (bank, slots = SLOTS, primary = 'blacksmith') => ({ customPacketType: 'masteryMenu', profession: primary, rank: 1, hours: 7, rankHours: [0, 0, 40, 100, 180, 6000], resetsLeft: 1, professions: PROFESSIONS, slots, bank })

;(async () => {
  global.window = { skyrimPlatform: { sendMessage () {} }, addEventListener () {}, removeEventListener () {} }
  const service = await load(serviceSource)
  const menu = await load(menuSource)
  const React = require(require.resolve('react', { paths: [front] }))
  const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: [front] }))
  const events = { choose: 'c', reset: 'r', close: 'x' }
  const render = (info) => renderToStaticMarkup(React.createElement(menu.default, { embedded: true, data: { ...info, events } }))
  // The text of every hour cell of the strip
  const cells = (html) => html.split(/<div class="mastery__bank-hour(?: mastery__bank-hour--filled)?"/).slice(1).map((cell) =>
    cell.replace(/^[^>]*>/, '').replace(/<\/div>[\s\S]*$/, '').replace(/<[^>]+>/g, ' | ').replace(/\u00a0/g, '').replace(/( \| )+$/, '').trim())
  const count = (html, text) => html.split(text).length - 1

  // A server that sends no bank, or a character with no craft, shows no strip
  {
    const none = service.parseMasteryMenu(menuPacket(undefined))
    assert.equal(none.bank, null)
    assert.ok(!render(none).includes('mastery__bank'))
    assert.ok(!render(none).includes('mastery__frame--bank'))
    assert.ok(!render(service.parseMasteryMenu(menuPacket(bankOf(), EMPTY_SLOTS, null))).includes('mastery__bank'), 'no craft held, with slots')
    assert.ok(!render(service.parseMasteryMenu(menuPacket(bankOf(), [], null))).includes('mastery__bank'), 'no craft held, one-craft view')
    assert.ok(render(service.parseMasteryMenu(menuPacket(bankOf(), [], 'blacksmith'))).includes('mastery__bank'), 'one-craft view with a craft')
  }

  // The parsed shape, and the hour counting now with one hour banked for another craft, read ten minutes after it arrived
  {
    const info = service.parseMasteryMenu(menuPacket(bankOf({ countedMs: 50 * MIN, counted: 'blacksmith', payMs: 50 * MIN, queue: ['tailor'] })))
    assert.deepEqual(info.bank, { max: 2, intervalMs: HOUR, offline: true, countedMs: 50 * MIN, counted: 'blacksmith', payMs: 50 * MIN, queue: ['tailor'], at: now }, 'stamped on arrival')
    now += 10 * MIN
    const html = render(info)
    assert.ok(html.includes('mastery__frame mastery__frame--slots mastery__frame--bank'))
    assert.ok(html.indexOf('class="mastery__bank"') < html.indexOf('class="mastery__slots"'), 'the strip is above the craft chips')
    assert.equal(count(html, 'class="mastery__bank-hours"'), 1, 'one strip for the character')
    assert.deepEqual(cells(html), ['Hour 1 \u00b7 Counted | Blacksmith, next in 40 min', 'Hour 2 \u00b7 Pending | Tailor, in 40 min', 'Hour 3 \u00b7 Empty'])
    assert.equal(count(html, 'mastery__bank-hour--filled'), 2)
    assert.ok(html.includes('Extra crafts wait here and count in order, online or not.'))
    now += 45 * MIN
    assert.deepEqual(cells(render(info)), ['Hour 1 \u00b7 Open | work counts now', 'Hour 2 \u00b7 Pending | Tailor, any moment', 'Hour 3 \u00b7 Empty'], 'run out: the server pays within a minute')
  }

  // The owner's bow, potion, bow: the woodworking hour counts now, the alchemy hour pays next and the second woodworking hour an interval later
  {
    const slots = [slot(0, 'Primary', 'woodworker', 'Woodworker', 1), slot(1, 'Secondary', 'alchemist', 'Alchemist', 0)]
    const info = service.parseMasteryMenu(menuPacket(bankOf({ countedMs: 50 * MIN, counted: 'woodworker', payMs: 50 * MIN, queue: ['alchemist', 'woodworker'] }), slots, 'woodworker'))
    assert.deepEqual(cells(render(info)), ['Hour 1 \u00b7 Counted | Woodworker, next in 50 min', 'Hour 2 \u00b7 Pending | Alchemist, in 50 min', 'Hour 3 \u00b7 Pending | Woodworker, in 110 min'])
    // After a night away the server has paid what fell due before it sends, so the strip never shows a due hour as pending
    const morning = service.parseMasteryMenu(menuPacket(bankOf({ countedMs: 30 * MIN, counted: 'alchemist', payMs: 30 * MIN, queue: ['woodworker'] }), slots, 'woodworker'))
    assert.deepEqual(cells(render(morning)), ['Hour 1 \u00b7 Counted | Alchemist, next in 30 min', 'Hour 2 \u00b7 Pending | Woodworker, in 30 min', 'Hour 3 \u00b7 Empty'])
  }

  // The online-only rule names itself, a bank of 0 leaves the counted hour alone, an over-full bank from an old record's fold draws every hour, and an unknown id shows as is
  {
    const online = service.parseMasteryMenu(menuPacket(bankOf({ offline: false, payMs: 30 * MIN, queue: ['blacksmith', 'blacksmith'] }), [SLOTS[0]]))
    let html = render(online)
    assert.ok(html.includes('mastery__frame mastery__frame--bank'))
    assert.ok(html.includes('Extra crafts wait here and count in order while you are online.'))
    assert.deepEqual(cells(html), ['Hour 1 \u00b7 Open | work counts now', 'Hour 2 \u00b7 Pending | Blacksmith, in 30 min', 'Hour 3 \u00b7 Pending | Blacksmith, in 90 min'])
    assert.deepEqual(cells(render(service.parseMasteryMenu(menuPacket(bankOf({ max: 0 }), [SLOTS[0]])))), ['Hour 1 \u00b7 Open | work counts now'])
    html = render(service.parseMasteryMenu(menuPacket(bankOf({ countedMs: 20 * MIN, counted: 'blacksmith', payMs: 20 * MIN, queue: ['tailor', 'tailor', 'cook', 'blacksmith'] }))))
    assert.deepEqual(cells(html), ['Hour 1 \u00b7 Counted | Blacksmith, next in 20 min', 'Hour 2 \u00b7 Pending | Tailor, in 20 min', 'Hour 3 \u00b7 Pending | Tailor, in 80 min', 'Hour 4 \u00b7 Pending | cook, in 140 min', 'Hour 5 \u00b7 Pending | Blacksmith, in 200 min'])
  }

  // A professionState lays its hours and bank over the open menu and keeps the rest
  {
    const open = service.parseMasteryMenu(menuPacket(bankOf()))
    now += 5 * MIN
    const state = { customPacketType: 'professionState', profession: 'blacksmith', rank: 1, rankName: 'Novice', hours: 8, skills: {}, magicka: null, slots: [{ ...SLOTS[0], hours: 8 }, SLOTS[1]], bank: bankOf({ countedMs: HOUR, counted: 'blacksmith' }) }
    const next = service.applyProfessionState(open, state)
    assert.deepEqual([next.hours, next.slots[0].hours, next.bank.at, next.resetsLeft, next.professions.length], [8, 8, now, 1, 4])
    assert.deepEqual(cells(render(next)), ['Hour 1 \u00b7 Counted | Blacksmith, next in 60 min', 'Hour 2 \u00b7 Empty', 'Hour 3 \u00b7 Empty'])
    const old = service.applyProfessionState(open, { customPacketType: 'professionState', profession: 'blacksmith', rank: 1, hours: 8 })
    assert.deepEqual([old.slots.length, old.bank.at], [2, open.bank.at], 'a state without slots or bank keeps the menu\'s')
  }

  console.log('6/6 passed')
})().catch((err) => {
  console.log('FAIL')
  console.log(err)
  process.exit(1)
})
