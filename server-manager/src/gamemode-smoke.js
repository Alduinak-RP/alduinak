'use strict'

const fs   = require('fs')
const path = require('path')
const vm   = require('vm')
const { locLookup } = require('../../localization/loc')

const locFile = path.join(__dirname, '..', '..', 'localization', 'en_loc.json')

// mp getters the parts call at module scope for an object; every other mp member is a function returning undefined
const SETTINGS_GETTERS = new Set(['getServerSettings', 'getSettings', 'getAllSettings'])
// fs reads pass through, every other fs call is a no-op so a smoke run writes nothing
const FS_READS = new Set(['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'accessSync'])

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// "ReferenceError: loc is not defined at gamemode.js:458:26"
const describe = (err, filename) => {
  const m = String((err && err.stack) || '').match(new RegExp(escapeRe(filename) + ':(\\d+):(\\d+)'))
  return `${err}` + (m ? ` at ${filename}:${m[1]}:${m[2]}` : '')
}

// Runs a gamemode bundle's module scope the way the server loads it (a CommonJS wrapper over a stub mp and loc); nothing it starts outlives the call
// Returns { ok, error } plus what the run touched: mp (members read), mpSet (members assigned), globals (written), timers, required, logs
function smokeRunGamemode(source, opts = {}) {
  const filename = opts.filename || 'gamemode.js'
  const cwd = opts.cwd || process.cwd()
  const timeout = opts.timeout || 5000
  const table = opts.gamemodeTable || JSON.parse(fs.readFileSync(locFile, 'utf8')).gamemode
  const touched = { mp: new Set(), mpSet: new Set(), timers: 0, required: new Set(), logs: [] }

  const mp = new Proxy({}, {
    get(_t, name) {
      if (typeof name !== 'string' || name === 'then') return undefined
      touched.mp.add(name)
      return SETTINGS_GETTERS.has(name) ? () => ({}) : () => undefined
    },
    set(_t, name) { if (typeof name === 'string') touched.mpSet.add(name); return true },
  })
  const fsFacade = new Proxy({}, { get: (_t, name) => (FS_READS.has(name) ? fs[name] : () => undefined) })
  const timer = () => { touched.timers++; return { ref() { return this }, unref() { return this }, hasRef: () => false, refresh() { return this } } }
  const log = level => (...args) => touched.logs.push(`${level}: ${args.map(String).join(' ')}`)

  const sandbox = {
    mp,
    loc: opts.loc || ((key, vars) => locLookup(table, key, vars)),
    console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
    setTimeout: timer, setInterval: timer, setImmediate: timer,
    clearTimeout() {}, clearInterval() {}, clearImmediate() {}, queueMicrotask() {},
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
    // The relay stays off: a smoke run opens no socket
    process: {
      env: { ...process.env, ALDUINAK_RELAY: 'off' }, cwd: () => cwd, platform: process.platform, pid: process.pid,
      argv: [process.execPath, filename], version: process.version, versions: process.versions,
      uptime: () => process.uptime(), memoryUsage: () => process.memoryUsage(), nextTick() {}, on() {}, once() {}, exit() {},
    },
    require: name => {
      touched.required.add(name)
      if (name === 'path') return path
      if (name === 'fs') return fsFacade
      throw new Error(`${name} is not loaded in a smoke run`)
    },
    module: { exports: {} },
    __filename: path.join(cwd, filename),
    __dirname: cwd,
    // The server owns the three mp hooks and the packet router before the first load
    __alduinakTsHooks: true,
    __alduinakTsRouter: true,
  }
  sandbox.exports = sandbox.module.exports
  const before = new Set(Object.keys(sandbox))
  const context = vm.createContext(sandbox)
  const summary = () => ({
    mp: [...touched.mp].sort(), mpSet: [...touched.mpSet].sort(),
    globals: Object.keys(context).filter(k => !before.has(k)).sort(),
    timers: touched.timers, required: [...touched.required].sort(), logs: touched.logs,
  })
  try {
    const wrapped = `(function (require, module, exports, __filename, __dirname) {${source}\n})(require, module, exports, __filename, __dirname)`
    new vm.Script(wrapped, { filename }).runInContext(context, { timeout })
  } catch (err) {
    return { ok: false, error: describe(err, filename), ...summary() }
  }
  return { ok: true, error: null, ...summary() }
}

module.exports = { smokeRunGamemode }

// node server-manager/src/gamemode-smoke.js <path to gamemode.js>
if (require.main === module) {
  const file = path.resolve(process.argv[2] || 'gamemode.js')
  const r = smokeRunGamemode(fs.readFileSync(file, 'utf8'), { filename: path.basename(file), cwd: path.dirname(file) })
  console.log(r.ok ? `module scope OK: ${file}` : `module scope FAILED: ${r.error}`)
  console.log(`mp read: ${r.mp.join(' ')}`)
  console.log(`mp assigned: ${r.mpSet.join(' ')}`)
  console.log(`globals written: ${r.globals.join(' ')}`)
  console.log(`timers: ${r.timers}  required: ${r.required.join(' ')}`)
  for (const line of r.logs) console.log(`  ${line}`)
  process.exitCode = r.ok ? 0 : 1
}
