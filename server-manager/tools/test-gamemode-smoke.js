'use strict'

// The gamemode smoke run: a bundle shaped like the parts passes with what it touched listed, an undefined name or a throw fails with its line, nothing it starts leaks: node tools/test-gamemode-smoke.js

const assert = require('node:assert/strict')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { smokeRunGamemode } = require('../src/gamemode-smoke')

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alduinak-gamemode-smoke-test-'))

// Module scope shaped like the real parts: strict, globalThis state, mp hooks and properties, loc, a timer, a log dir
const good = `'use strict'
const g = globalThis
g.__alduinakGen = (g.__alduinakGen || 0) + 1
const fs = require('fs'), path = require('path')
const settings = mp.getServerSettings() || {}
const MASK = (typeof settings.maskName === 'string' && settings.maskName) || loc('names.maskDefault')
mp.on('connect', () => {})
try { mp.makeProperty('ff_decor', {}) } catch (e) { console.error('never reached') }
if (!g.__alduinakTsHooks) mp.onDeath = () => {}
mp.onUserAssignActor = () => {}
try { fs.mkdirSync(path.join(process.cwd(), 'made'), { recursive: true }) } catch (e) {}
setInterval(() => {}, 1000)
console.log('[alduinak] gamemode loaded ' + MASK)
`
const r = smokeRunGamemode(good, { filename: 'gamemode.js', cwd })
assert.equal(r.ok, true, r.error)
assert.deepEqual(r.mp, ['getServerSettings', 'makeProperty', 'on'])
assert.deepEqual(r.mpSet, ['onUserAssignActor'])
assert.deepEqual(r.globals, ['__alduinakGen'])
assert.equal(r.timers, 1)
assert.ok(!fs.existsSync(path.join(cwd, 'made')), 'fs writes are no-ops')
assert.deepEqual(r.logs, ['log: [alduinak] gamemode loaded Masked Person'])

// The 2026-10-05 bundle: loc() at module scope with no prelude and no global; the error names the bundle line
const noLoc = smokeRunGamemode(`'use strict'\nconst A = 1\nconst EXAMINE_FALLBACK = lok('examine.fallback')\n`, { filename: 'gamemode.js', cwd })
assert.equal(noLoc.ok, false)
assert.match(noLoc.error, /^ReferenceError: lok is not defined at gamemode\.js:3:\d+$/)

// A bundle carrying its own loc() prelude shadows the one the run supplies
const own = smokeRunGamemode(`'use strict'\nfunction loc() { return 'mine' }\nconsole.log(loc('names.unknown'))\n`, { cwd })
assert.equal(own.ok, true, own.error)
assert.deepEqual(own.logs, ['log: mine'])

// A throw at module scope and a run that never ends both fail
assert.match(smokeRunGamemode(`throw new TypeError('boom')`, { cwd }).error, /^TypeError: boom at gamemode\.js:1:\d+$/)
assert.match(smokeRunGamemode(`for (;;) {}`, { cwd, timeout: 200 }).error, /timed out/)

// The relay stays off and a module the run does not carry is a plain error a part can catch
const relay = smokeRunGamemode(`console.log(process.env.ALDUINAK_RELAY); try { require('ws') } catch (e) { console.log(e.message) }`, { cwd })
assert.equal(relay.ok, true, relay.error)
assert.deepEqual(relay.logs, ['log: off', 'log: ws is not loaded in a smoke run'])
assert.deepEqual(relay.required, ['ws'])

fs.rmSync(cwd, { recursive: true, force: true })
console.log('test-gamemode-smoke: all assertions passed')
