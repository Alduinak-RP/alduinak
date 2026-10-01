'use strict'

// The front's repair menu (skymp5-front features/repairMenu) over the widget repairService.ts pushes: node tools/test-repair-menu.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const repo = path.join(__dirname, '..', '..')
const front = path.join(repo, 'skymp5-front')
const menuSource = path.join(front, 'src', 'features', 'repairMenu', 'index.tsx')
const serviceSource = path.join(repo, 'skymp5-client', 'src', 'services', 'services', 'repairService.ts')

const scssStub = {
  name: 'scss-stub',
  setup (build) {
    build.onLoad({ filter: /\.scss$/ }, () => ({ contents: '', loader: 'js' }))
  },
}

async function load (source) {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', external: ['react', 'react-dom'], jsx: 'transform', plugins: [scssStub] })
  const compiled = new Module(source)
  compiled.filename = source
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const events = { repair: 'repairMenu:repair', repairAll: 'repairMenu:repairAll', improve: 'repairMenu:improve', close: 'repairMenu:close' }

const sword = { key: '12eb7:0.43:1.2:w', baseId: 0x12eb7, name: 'Steel Sword (Superior)', percent: 43, hp: 150, maxHp: 350, worn: true, cost: [{ baseId: 0x5ace5, name: 'Steel Ingot', need: 2, have: 5 }] }
const shield = { key: 'k2', baseId: 0x12eb6, name: 'Iron Shield', percent: 0, hp: 0, maxHp: 200, worn: false, cost: [{ baseId: 0x5ace4, name: 'Iron Ingot', need: 1, have: 0 }, { baseId: 0x800e4, name: 'Leather Strips', need: 2, have: 4 }] }
const boots = { key: 7, baseId: 0x13910, name: 'Hide Boots x2', percent: 80, hp: 0, maxHp: 0, worn: false, cost: [] }

;(async () => {
  const sent = []
  global.window = { skyrimPlatform: { sendMessage: (...args) => sent.push(args) }, addEventListener () {}, removeEventListener () {} }

  const menu = await load(menuSource)
  const React = require(require.resolve('react', { paths: [front] }))
  const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: [front] }))

  // Every button of a render with its label, so a click can be played without a DOM
  let buttons = []
  const createElement = React.createElement
  React.createElement = (type, props, ...children) => {
    if (type === 'button') buttons.push({ label: children.join('').trim(), disabled: !!props.disabled, click: props.onClick })
    return createElement(type, props, ...children)
  }
  const render = (data) => {
    buttons = []
    return renderToStaticMarkup(createElement(menu.default, { data }))
  }
  const count = (html, text) => html.split(text).length - 1
  const widget = (rows, extra) => ({ type: 'repairMenu', id: 42, kind: 'weapon', title: 'Grindstone: repair weapons', rows, events, ...extra })

  // The condition readout and what a row can pay
  {
    assert.equal(menu.conditionText(sword), '43% (150/350)')
    assert.equal(menu.conditionText(shield), 'Broken (0/200)')
    assert.equal(menu.conditionText(boots), '80%')
    assert.equal(menu.conditionText({ ...boots, percent: 0 }), 'Broken')
    assert.equal(menu.canAfford(sword), true)
    assert.equal(menu.canAfford(shield), false)
    assert.equal(menu.canAfford(boots), true, 'an empty cost is a free repair')
    assert.equal(menu.canAfford({ ...sword, cost: [{ baseId: 1, name: 'x', need: 2, have: 2 }] }), true)
    assert.equal(menu.canAfford({ key: 'x' }), true, 'a row without a cost list')
  }

  // Three rows: title, condition, cost and which buttons work
  {
    const html = render(widget([sword, shield, boots]))
    assert.ok(html.includes('>Grindstone: repair weapons</h2>'))
    assert.ok(html.includes('3 damaged items'))
    assert.equal(count(html, 'class="repair-menu__row"'), 3)
    assert.ok(html.includes('Steel Sword (Superior)<span class="repair-menu__tag">equipped</span>'))
    assert.equal(count(html, 'repair-menu__tag'), 1, 'only the worn copy is tagged')
    assert.ok(html.includes('43% (150/350)') && html.includes('Broken (0/200)') && html.includes('>80%<'))
    assert.ok(html.includes('style="width:43%"') && html.includes('style="width:0%"') && html.includes('style="width:80%"'))
    assert.equal(count(html, 'repair-menu__bar-fill--low'), 1, 'only the broken shield is under a quarter')
    assert.equal(count(html, 'repair-menu__percent--broken'), 1)
    assert.ok(html.includes('2 Steel Ingot <span class="repair-menu__have">(have 5)</span>'))
    assert.ok(html.includes('class="repair-menu__material repair-menu__material--short">1 Iron Ingot'))
    assert.equal(count(html, 'repair-menu__material--short'), 1, 'Leather Strips are covered')
    assert.equal(count(html, 'No materials needed'), 1)
    assert.ok(html.includes('Hide Boots x2'))

    assert.deepEqual(buttons.map((b) => b.label), ['Repair', 'Repair', 'Repair', 'Repair all', 'Improve items', 'Close'])
    assert.deepEqual(buttons.map((b) => b.disabled), [false, true, false, false, false, false])

    for (const b of buttons) if (!b.disabled) b.click()
    assert.deepEqual(sent, [
      ['repairMenu:repair', '12eb7:0.43:1.2:w'],
      ['repairMenu:repair', 7],
      ['repairMenu:repairAll'],
      ['repairMenu:improve'],
      ['repairMenu:close'],
    ], 'a row key goes back as it came, a number stays a number')
    sent.length = 0
  }

  // One row reads "1 damaged item"; a menu whose rows are all short cannot repair all
  {
    assert.ok(render(widget([sword])).includes('1 damaged item<'))
    render(widget([shield, { ...shield, key: 'k3' }]))
    assert.deepEqual(buttons.map((b) => b.disabled), [true, true, true, false, false])
  }

  // A refresh with no rows keeps the footer
  {
    const html = render(widget([]))
    assert.ok(html.includes('Nothing left to repair') && html.includes('All repaired'))
    assert.equal(count(html, 'class="repair-menu__row"'), 0)
    assert.deepEqual(buttons.map((b) => b.label), ['Repair all', 'Improve items', 'Close'])
    assert.deepEqual(buttons.map((b) => b.disabled), [true, false, false])
  }

  // A widget with nothing in it still renders
  {
    const html = render({ type: 'repairMenu', id: 42 })
    assert.ok(html.includes('>Repair</h2>') && html.includes('Nothing left to repair'))
    assert.ok(render(widget([{ key: 'bare', name: 'Odd' }])).includes('Odd'))
  }

  // An odd percent never draws outside the bar
  {
    const html = render(widget([{ ...sword, percent: 140 }, { ...sword, key: 'b', percent: -5 }]))
    assert.ok(html.includes('style="width:100%"') && html.includes('style="width:0%"'))
  }

  // Outside the game a click only logs
  {
    const log = console.log
    const logged = []
    console.log = (...args) => logged.push(args)
    global.window = {}
    try {
      render(widget([sword]))
      buttons[0].click()
    } finally {
      console.log = log
    }
    assert.equal(logged.length, 1)
    assert.equal(sent.length, 0)
  }

  // After a click the repair buttons stay off for longer than the server's repair cooldown, however fast its refresh comes
  {
    const system = fs.readFileSync(path.join(repo, 'skymp5-server', 'ts', 'systems', 'durabilitySystem.ts'), 'utf8')
    const cooldown = Number((/const REPAIR_COOLDOWN_MS = (\d+);/.exec(system) || [])[1])
    assert.ok(cooldown > 0, 'the server cooldown is read')
    assert.ok(menu.REPAIR_GAP_MS >= cooldown + 50, 'the next click is sent after the cooldown, with room for jitter')
    assert.equal(menu.busyLeft(1000, 1100), menu.REPAIR_GAP_MS - 100, 'a refresh after 100 ms waits out the rest')
    assert.equal(menu.busyLeft(1000, 1000 + menu.REPAIR_GAP_MS), 0)
    assert.equal(menu.busyLeft(1000, 5000), 0, 'a late refresh frees the buttons at once')
    assert.equal(menu.busyLeft(0, 5000), 0, 'and so does one that follows no click')
  }

  // The widget type, the event keys and the wiring match what the client pushes
  {
    const service = fs.readFileSync(serviceSource, 'utf8')
    assert.ok(/type:\s*"repairMenu"/.test(service), 'repairService pushes a repairMenu widget')
    for (const [name, key] of Object.entries(events)) {
      assert.ok(new RegExp(`${name}:\\s*'${key}'`).test(service), `repairService event ${name}`)
    }
    const source = fs.readFileSync(menuSource, 'utf8')
    for (const name of Object.keys(events)) assert.ok(source.includes('ev.' + name), `the menu sends ${name}`)
    for (const field of ['title', 'rows']) assert.ok(new RegExp(`${field}:\\s*info\\.${field}`).test(service), `repairService passes ${field}`)

    const constructor = fs.readFileSync(path.join(front, 'src', 'constructor.js'), 'utf8')
    assert.ok(constructor.includes("import RepairMenu from './features/repairMenu'"))
    assert.ok(/case 'repairMenu':\s*return <RepairMenu data=\{rend\} \/>/.test(constructor))
    const app = fs.readFileSync(path.join(front, 'src', 'App.js'), 'utf8')
    assert.ok(app.includes("(widget.type === 'repairMenu') ? ('repairMenu-' + widget.id)"), 'a refresh keeps the menu instance and its scroll')
  }

  console.log('repair menu tests passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
