'use strict'

// The Skills tab's hour bank strip (skymp5-front features/masteryMenu) over what masteryService.ts parses from masteryMenu and professionState: node tools/test-mastery-bank.js

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
const PROFESSIONS = [{ id: 'blacksmith', label: 'Blacksmith', title: 'The Forge-Bound' }, { id: 'tailor', label: 'Tailor', title: 'The Fine Thread' }]
const idle = (index) => ({ slot: index, countedMs: 0, banked: 0, payMs: 0, capped: false })
const bankOf = (slots, extra) => ({ max: 2, intervalMs: HOUR, offline: false, slots, ...extra })
const menuPacket = (bank, slots = SLOTS) => ({ customPacketType: 'masteryMenu', profession: 'blacksmith', rank: 1, hours: 7, rankHours: [0, 0, 40, 100, 180, 6000], resetsLeft: 1, professions: PROFESSIONS, slots, bank })

;(async () => {
  global.window = { skyrimPlatform: { sendMessage () {} }, addEventListener () {}, removeEventListener () {} }
  const service = await load(serviceSource)
  const menu = await load(menuSource)
  const React = require(require.resolve('react', { paths: [front] }))
  const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: [front] }))
  const events = { choose: 'c', reset: 'r', close: 'x' }
  const render = (info) => renderToStaticMarkup(React.createElement(menu.default, { embedded: true, data: { ...info, events } }))
  // The text of every hour cell, craft by craft
  const cells = (html) => html.split('class="mastery__bank-craft"').slice(1).map((craft) =>
    craft.split(/<div class="mastery__bank-hour(?: mastery__bank-hour--filled)?"/).slice(1).map((cell) => cell.replace(/^[^>]*>/, '').replace(/<\/div>[\s\S]*$/, '').replace(/<[^>]+>/g, ' | ').replace(/\u00a0/g, '').replace(/( \| )+$/, '').trim()))
  const names = (html) => [...html.matchAll(/class="mastery__bank-name">([^<]*)</g)].map((m) => m[1])
  const count = (html, text) => html.split(text).length - 1

  // A server that sends no bank, or a character with no craft, shows no strip
  {
    const none = service.parseMasteryMenu(menuPacket(undefined))
    assert.equal(none.bank, null)
    assert.ok(!render(none).includes('mastery__bank'))
    assert.ok(!render(none).includes('mastery__frame--bank'))
    assert.ok(!render(service.parseMasteryMenu(menuPacket(bankOf([])))).includes('mastery__bank'))
  }

  // A counted hour with one hour banked, read ten minutes after it arrived
  {
    const info = service.parseMasteryMenu(menuPacket(bankOf([{ slot: 0, countedMs: 50 * MIN, banked: 1, payMs: 50 * MIN, capped: false }, idle(1)])))
    assert.equal(info.bank.at, now, 'stamped on arrival')
    now += 10 * MIN
    const html = render(info)
    assert.ok(html.includes('mastery__frame mastery__frame--slots mastery__frame--bank'))
    assert.ok(html.indexOf('class="mastery__bank"') < html.indexOf('class="mastery__slots"'), 'the strip is above the craft chips')
    assert.deepEqual(names(html), ['Blacksmith \u00b7 Primary', 'Tailor \u00b7 Secondary'])
    assert.deepEqual(cells(html), [
      ['Hour 1 \u00b7 Counted | next in 40 min', 'Hour 2 \u00b7 Pending | in 40 min online', 'Hour 3 \u00b7 Empty'],
      ['Hour 1 \u00b7 Open | work counts now', 'Hour 2 \u00b7 Empty', 'Hour 3 \u00b7 Empty'],
    ])
    assert.equal(count(html, 'mastery__bank-hour--filled'), 2)
    assert.ok(html.includes('One is counted per hour you are online.'))
    now += 45 * MIN
    assert.deepEqual(cells(render(info))[0], ['Hour 1 \u00b7 Open | work counts now', 'Hour 2 \u00b7 Pending | any moment', 'Hour 3 \u00b7 Empty'], 'run out: the server pays within a minute')
  }

  // Two banked hours pay an interval apart; with one craft slot the group carries the craft's name alone
  {
    const info = service.parseMasteryMenu(menuPacket(bankOf([{ slot: 0, countedMs: 0, banked: 2, payMs: 30 * MIN, capped: false }]), [SLOTS[0]]))
    const html = render(info)
    assert.ok(html.includes('mastery__frame mastery__frame--bank'))
    assert.deepEqual(names(html), ['Blacksmith'])
    assert.deepEqual(cells(html), [['Hour 1 \u00b7 Open | work counts now', 'Hour 2 \u00b7 Pending | in 30 min online', 'Hour 3 \u00b7 Pending | in 90 min online']])
  }

  // masteryBankOffline names its rule, a capped sub-slot earns nothing, and a bank of 0 leaves the counted hour alone
  {
    const info = service.parseMasteryMenu(menuPacket(bankOf([{ slot: 0, countedMs: 20 * MIN, banked: 1, payMs: 20 * MIN, capped: false }, { ...idle(1), capped: true }], { offline: true })))
    const html = render(info)
    assert.ok(html.includes('One is counted per hour, online or not.'))
    assert.deepEqual(cells(html), [['Hour 1 \u00b7 Counted | next in 20 min', 'Hour 2 \u00b7 Pending | in 20 min', 'Hour 3 \u00b7 Empty'], ['At its cap | earns no more hours']])
    assert.deepEqual(cells(render(service.parseMasteryMenu(menuPacket(bankOf([idle(0)], { max: 0 }), [SLOTS[0]])))), [['Hour 1 \u00b7 Open | work counts now']])
  }

  // A professionState lays its hours and bank over the open menu and keeps the rest
  {
    const open = service.parseMasteryMenu(menuPacket(bankOf([idle(0), idle(1)])))
    now += 5 * MIN
    const state = { customPacketType: 'professionState', profession: 'blacksmith', rank: 1, rankName: 'Novice', hours: 8, skills: {}, magicka: null, slots: [{ ...SLOTS[0], hours: 8 }, SLOTS[1]], bank: bankOf([{ slot: 0, countedMs: HOUR, banked: 0, payMs: 0, capped: false }, idle(1)]) }
    const next = service.applyProfessionState(open, state)
    assert.deepEqual([next.hours, next.slots[0].hours, next.bank.at, next.resetsLeft, next.professions.length], [8, 8, now, 1, 2])
    assert.deepEqual(cells(render(next))[0], ['Hour 1 \u00b7 Counted | next in 60 min', 'Hour 2 \u00b7 Empty', 'Hour 3 \u00b7 Empty'])
    const old = service.applyProfessionState(open, { customPacketType: 'professionState', profession: 'blacksmith', rank: 1, hours: 8 })
    assert.deepEqual([old.slots.length, old.bank.at], [2, open.bank.at], 'a state without slots or bank keeps the menu\'s')
  }

  console.log('5/5 passed')
})().catch((err) => {
  console.log('FAIL')
  console.log(err)
  process.exit(1)
})
