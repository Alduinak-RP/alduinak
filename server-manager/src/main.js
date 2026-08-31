'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const https = require('https')
const { execFile } = require('child_process')
const WebSocket = require('ws')
const config = require('./config')
const { Builder } = require('./build')
const schema = require('./settingsSchema')

let win = null

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780, minWidth: 980, minHeight: 600,
    backgroundColor: '#14110d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  startLogTail()
  consoleRelay.connect()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  // One-time hint when the box still runs pre-rename service names.
  setTimeout(async () => {
    await statusAll()
    const legacy = config.services.filter(s => resolvedNames[s.key] && resolvedNames[s.key] !== s.name)
    if (legacy.length) {
      send('console:relay', { kind: 'status', text: `legacy service names in use (${legacy.map(s => resolvedNames[s.key]).join(', ')}) - run build\\dist\\server\\install-services.bat once to migrate` })
    }
  }, 4000)
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
	
const serviceByKey = Object.fromEntries(config.services.map(s => [s.key, s]))

// nssm <verb> <service ...args> - returns trimmed stdout (status / message).
// nssm prints UTF-16LE; read as utf8 it interleaves NUL bytes, so strip them.
function nssm(verb, name, ...rest) {
  return new Promise(resolve => {
    execFile(config.nssm, [verb, name, ...rest], { windowsHide: true, timeout: verb === 'status' ? 5000 : 30000 }, (err, stdout, stderr) => {
      const clean = String(stdout || stderr || (err && err.message) || '').replace(/\u0000/g, '').trim()
      resolve(clean)
    })
  })
}

// nssm start/stop returns before the service settles (exiting non-zero on the
// transient *_PENDING states), so poll `nssm status` until the target state.
async function awaitStatus(name, want) {
  const deadline = Date.now() + 30000
  for (;;) {
    const status = await nssm('status', name)
    if (status === want) return { ok: true }
    if (!/^SERVICE_/.test(status) || Date.now() >= deadline) return { ok: false, status }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// The live box may still run the pre-rename service names until
// install-services.bat is re-run, so resolve which installed name to target:
// canonical first, then legacyNames. Cached per key; re-probed if it vanishes.
const resolvedNames = {}
async function probeService(svc) {
  const candidates = [...new Set([resolvedNames[svc.key], svc.name, ...(svc.legacyNames || [])].filter(Boolean))]
  let firstStatus = ''
  for (const name of candidates) {
    const status = await nssm('status', name)
    if (!firstStatus) firstStatus = status
    if (/^SERVICE_/.test(status)) { resolvedNames[svc.key] = name; return { name, status } }
  }
  delete resolvedNames[svc.key]
  return { name: svc.name, status: firstStatus || 'unknown' }
}

async function serviceName(svc) { return (await probeService(svc)).name }

async function act(svc, verb) {
  const name = await serviceName(svc)
  // Archive logs while the service is stopped (nssm frees the file handle),
  // so a restart (stop then start) always begins a fresh log file.
  if (verb === 'start' && await nssm('status', name) === 'SERVICE_STOPPED') {
    await rotateServiceLogs(svc)
  }
  await nssm(verb, name)
  const r = await awaitStatus(name, verb === 'stop' ? 'SERVICE_STOPPED' : 'SERVICE_RUNNING')
  if (r.ok) {
    let extra = ''
    if (svc.key === 'game' && verb === 'start') extra = await startLiveKitAlongside()
    return { ok: true, text: (verb === 'stop' ? 'stopped' : 'started') + extra }
  }
  return { ok: false, text: `${verb} failed (status: ${r.status || 'unknown'})` }
}

// Best-effort LiveKit (voice media server) start alongside the game server; boxes without the AlduinakLiveKit service skip silently.
async function startLiveKitAlongside() {
  const status = await nssm('status', 'AlduinakLiveKit')
  if (!/^SERVICE_/.test(status) || status === 'SERVICE_RUNNING') return ''
  await nssm('start', 'AlduinakLiveKit')
  const r = await awaitStatus('AlduinakLiveKit', 'SERVICE_RUNNING')
  return r.ok ? ' (+LiveKit)' : ` (LiveKit start failed: ${r.status || 'unknown'})`
}

// ── Log rotation: datestamp on restart, archived into <dir>\YYYY-MM ────────────

function pad2(n) { return String(n).padStart(2, '0') }
function monthDirName(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }
function datestamp(d) {
  return `${monthDirName(d)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
}

// chat.log lives wherever the gamemode writes it; mirror its resolution chain
// (env var, then the optional logDir key in server-settings.json, then default).
function chatLogDir() {
  return process.env.ALDUINAK_LOG_DIR || readServerSettings().logDir || 'C:\\logs'
}

// The nssm-configured stdout/stderr files for a service, plus the gamemode's
// chat.log for the game server (written directly, not via nssm).
async function serviceLogFiles(svc) {
  const name = await serviceName(svc)
  const files = []
  for (const stream of ['AppStdout', 'AppStderr']) {
    const p = parseNssmPath(await nssm('get', name, stream))
    if (p) files.push(p)
  }
  if (svc.key === 'game') {
    for (const f of ['chat.log', 'admin.log', 'pvp.log', 'trading.log', 'bounty.log']) {
      files.push(path.join(chatLogDir(), f))
    }
  }
  return files
}

// Rename the active log with a datestamp and file it under <dir>\YYYY-MM
// (month taken from the file's last write, so a December log lands in December).
function archiveLogFile(file) {
  let stat
  try { stat = fs.statSync(file) } catch { return }
  if (!stat.isFile() || stat.size === 0) return
  const ext = path.extname(file) || '.log'
  const base = path.basename(file, ext)
  const monthDir = path.join(path.dirname(file), monthDirName(stat.mtime))
  try {
    fs.mkdirSync(monthDir, { recursive: true })
    fs.renameSync(file, path.join(monthDir, `${base}-${datestamp(stat.mtime)}${ext}`))
    delete tailState[file] // fresh file: restart the tail from the top
  } catch (err) {
    send('console:relay', { kind: 'status', text: `log rotation skipped for ${file}: ${err.message}` })
  }
}

// Sweep already-rotated siblings (ours and nssm's own size rotation, both named
// <base>-<digits...>) into their month folder. "-<digit>" avoids eating other
// active logs like gameserver-err.log.
function sweepRotatedLogs(file) {
  const dir = path.dirname(file)
  const ext = path.extname(file) || '.log'
  const base = path.basename(file, ext)
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return }
  for (const entry of entries) {
    if (!entry.startsWith(base + '-') || !entry.endsWith(ext)) continue
    if (!/^\d/.test(entry.slice(base.length + 1))) continue
    let stat
    try { stat = fs.statSync(path.join(dir, entry)) } catch { continue }
    if (!stat.isFile()) continue
    const monthDir = path.join(dir, monthDirName(stat.mtime))
    try {
      fs.mkdirSync(monthDir, { recursive: true })
      fs.renameSync(path.join(dir, entry), path.join(monthDir, entry))
    } catch { /* locked or already moved, retry on the next restart */ }
  }
}

async function rotateServiceLogs(svc) {
  for (const file of await serviceLogFiles(svc)) {
    sweepRotatedLogs(file)
    archiveLogFile(file)
  }
}

async function statusAll() {
  const pairs = await Promise.all(config.services.map(async s => [s.key, (await probeService(s)).status]))
  return Object.fromEntries(pairs)
}

ipcMain.handle('services:status', () => statusAll())

// Act on a single service (per-service dropdowns and console commands).
async function doServiceAction(key, action) {
  const svc = serviceByKey[key]
  if (!svc) return { ok: false, error: `unknown service ${key}` }
  const steps = []
  let ok = true
  const step = async verb => { const r = await act(svc, verb); ok = ok && r.ok; steps.push(`${svc.label}: ${r.text}`); return r.ok }
  if (action === 'stop') await step('stop')
  else if (action === 'start') await step('start')
  else if (action === 'restart') { if (await step('stop')) await step('start') }
  else return { ok: false, error: `unknown action ${action}` }
  return { ok, steps, status: await statusAll() }
}

// Act on every service in order (stop order reversed) - the "all" controls.
async function doServicesAction(action) {
  const steps = []
  let ok = true
  const step = async (s, verb) => { const r = await act(s, verb); ok = ok && r.ok; steps.push(`${s.label}: ${r.text}`) }
  const doStop  = async () => { for (const s of [...config.services].reverse()) await step(s, 'stop') }
  const doStart = async () => { for (const s of config.services)                await step(s, 'start') }
  if (action === 'stop') await doStop()
  else if (action === 'start') await doStart()
  else if (action === 'restart') { await doStop(); await doStart() }
  else return { ok: false, error: `unknown action ${action}` }
  return { ok, steps, status: await statusAll() }
}

ipcMain.handle('service:action', (_e, key, action) => doServiceAction(key, action))
ipcMain.handle('services:action', (_e, action) => doServicesAction(action))

const tailState = {}   // file -> last byte offset
let logTargets = []    // [{ file, label }]

function parseNssmPath(s) {
  const p = String(s || '').replace(/\u0000/g, '').trim().replace(/^"|"$/g, '')
  return p && !/^reset|^\(|unknown|service/i.test(p) ? p : ''
}

async function discoverLogTargets() {
  const targets = []
  const seen = new Set()
  const add = (file, label) => {
    if (file && !seen.has(file)) { seen.add(file); targets.push({ file, label }) }
  }
  for (const s of config.services) {
    const name = await serviceName(s)
    for (const stream of ['AppStdout', 'AppStderr']) {
      const p = parseNssmPath(await nssm('get', name, stream))
      add(p, `${s.label}${stream === 'AppStderr' ? ' (err)' : ''}`)
    }
  }
  // Fallbacks
  const fallbacks = [
    ['gameserver.log', 'Game'], ['gameserver-err.log', 'Game (err)'],
    ['backend.log', 'Backend'], ['backend-err.log', 'Backend (err)'],
  ]
  for (const [name, label] of fallbacks) add(path.join(config.logDir, name), label)
  for (const f of ['error.log', 'access.log']) add(path.join('C:\\nginx', 'logs', f), `Nginx (${f.replace('.log', '')})`)
  // Keep only the files that actually exist right now (re-checked on each refresh).
  logTargets = targets.filter(t => { try { return fs.statSync(t.file).isFile() } catch { return false } })
}

function pollLogs() {
  for (const { file, label } of logTargets) {
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (tailState[file] === undefined) tailState[file] = Math.max(0, stat.size - 8192) // seed from tail
    if (stat.size < tailState[file]) tailState[file] = 0                                // rotated/truncated
    if (stat.size > tailState[file]) {
      try {
        const fd = fs.openSync(file, 'r')
        const len = stat.size - tailState[file]
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, tailState[file])
        fs.closeSync(fd)
        tailState[file] = stat.size
        send('log:data', { source: label, text: buf.toString('utf8') })
      } catch { /* mid-write race, retry next tick */ }
    }
  }
}

function startLogTail() {
  discoverLogTargets()
  setInterval(pollLogs, 1500)
  setInterval(discoverLogTargets, 30000)   // services may be re-installed/reconfigured
}

const consoleRelay = {
  ws: null, connected: false, timer: null, pending: new Map(),
  connect() {
    if (this.ws) return
    let ws
    try { ws = new WebSocket(`ws://127.0.0.1:${config.relay.port}`) }
    catch { return this.scheduleReconnect() }
    this.ws = ws
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', role: 'console', secret: config.relay.secret })))
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'auth_ok') { this.connected = true; send('console:relay', { kind: 'status', text: 'connected to relay' }); return }
      if (m.type === 'console_output' || m.type === 'console_log') {
        const text = String(m.text ?? '')
        // A marked reply line is consumed by its pending query, not shown in the
        // console. Position 0 only: a marker mid-text could be player-supplied.
        for (const [marker, p] of this.pending) {
          if (text.startsWith(marker)) { this.pending.delete(marker); clearTimeout(p.timer); p.resolve(text.slice(marker.length).trim()); return }
        }
        send('console:relay', { kind: 'output', text })
      }
    })
    ws.on('close', () => { this.connected = false; this.ws = null; this.scheduleReconnect() })
    ws.on('error', () => { /* 'close' handles the retry */ })
  },
  scheduleReconnect() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.connect() }, 4000) },
  command(text) {
    if (!this.connected || !this.ws) return { ok: false, error: 'relay not connected - is the backend running?' }
    try { this.ws.send(JSON.stringify({ type: 'console_command', text })); return { ok: true } }
    catch (err) { return { ok: false, error: err.message } }
  },
  // Send a command and resolve with the reply line following its marker.
  // Same-marker queries are serialized: pending is keyed on the marker, so two
  // in flight at once would clobber each other's resolver.
  query(command, marker, timeoutMs = 2500) {
    const queues = this.queues || (this.queues = new Map())
    const next = (queues.get(marker) || Promise.resolve()).then(() => this.queryNow(command, marker, timeoutMs))
    queues.set(marker, next)
    return next
  },
  queryNow(command, marker, timeoutMs) {
    return new Promise(resolve => {
      if (!this.connected || !this.ws) return resolve({ ok: false, error: 'relay not connected' })
      const timer = setTimeout(() => { this.pending.delete(marker); resolve({ ok: false, error: 'query timed out' }) }, timeoutMs)
      this.pending.set(marker, { resolve: payload => resolve({ ok: true, payload }), timer })
      try { this.ws.send(JSON.stringify({ type: 'console_command', text: command })) }
      catch (err) { this.pending.delete(marker); clearTimeout(timer); resolve({ ok: false, error: err.message }) }
    })
  },
}

// Console box: manager commands are handled locally, anything else is
// forwarded to the game server console over the WS relay (the gamemode).
const BUILD_KINDS = ['server', 'launcher', 'client', 'native', 'gamemode']
const CONSOLE_HELP = [
  'Manager commands:',
  '  help                           this help',
  '  status                         service status',
  '  start|stop|restart <svc|all>   control services (' + config.services.map(s => s.key).join(', ') + ')',
  '  build <' + BUILD_KINDS.join('|') + '>   run a build (output streams here)',
  'Anything else is sent to the game server console (gamemode).',
].join('\n')

function consoleOut(text) { send('console:relay', { kind: 'output', text: text + '\n' }) }

// Returns a result object when the command was handled locally, null otherwise.
async function tryLocalCommand(cmd) {
  const parts = cmd.split(/\s+/)
  const verb = parts[0].toLowerCase()
  const arg = (parts[1] || '').toLowerCase()
  // help/status also go to the gamemode so its command list and player count
  // append below the local output (fan-out arrives via console:relay).
  if (verb === 'help' || verb === '?') {
    consoleOut(CONSOLE_HELP)
    if (!consoleRelay.command('help').ok) consoleOut('(game console offline - gamemode commands unavailable)')
    return { ok: true }
  }
  if (verb === 'status') {
    const st = await statusAll()
    consoleOut(config.services.map(s => `${s.label}: ${st[s.key] || 'unknown'}`).join('\n'))
    consoleRelay.command('status')
    return { ok: true }
  }
  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    const keys = config.services.map(s => s.key)
    if (!arg || (arg !== 'all' && !keys.includes(arg))) {
      consoleOut(`usage: ${verb} <${keys.join('|')}|all>`)
      return { ok: true }
    }
    consoleOut(`${verb} ${arg}…`)
    const r = arg === 'all' ? await doServicesAction(verb) : await doServiceAction(arg, verb)
    consoleOut((r.steps || [r.error || 'failed']).join('\n'))
    return { ok: r.ok !== false }
  }
  if (verb === 'build') {
    if (!BUILD_KINDS.includes(arg)) { consoleOut(`usage: build <${BUILD_KINDS.join('|')}>`); return { ok: true } }
    if (buildBusy) { consoleOut('a build is already running - wait for it to finish'); return { ok: true } }
    consoleOut(`starting ${arg} build…`)
    // Not awaited: builds take minutes; progress streams via build:log and the
    // outcome is reported here when it lands.
    runBuild(arg).then(r => consoleOut(r.ok ? `${arg} build complete` : `${arg} build failed: ${r.error || 'see log'}`))
    return { ok: true }
  }
  return null
}

ipcMain.handle('console:command', async (_e, text) => {
  const cmd = String(text || '').trim()
  if (!cmd) return { ok: false, error: 'empty command' }
  const local = await tryLocalCommand(cmd)
  if (local) return local
  return consoleRelay.command(cmd)
})

function builder() { return new Builder(t => send('build:log', t)) }

// One build at a time: console commands and Build tab buttons share this gate.
let buildBusy = false
async function runBuild(kind, opts) {
  if (buildBusy) return { ok: false, error: 'a build is already running' }
  buildBusy = true
  try {
    const b = builder()
    let r
    if (kind === 'server')        r = await b.buildServer(opts)
    else if (kind === 'launcher') r = await b.buildLauncher()
    else if (kind === 'client')   r = await b.buildClient(opts)
    else if (kind === 'native')   r = await b.buildNative()
    else if (kind === 'gamemode') r = await b.buildGamemode()
    else return { ok: false, error: `unknown build ${kind}` }
    // Let queued build:log messages land before the renderer prints the outcome, else the failure line appears above its error.
    await new Promise(res => setTimeout(res, 100))
    return r
  } catch (err) {
    return { ok: false, error: err.message }
  } finally { buildBusy = false }
}

ipcMain.handle('build:server',   (_e, opts) => runBuild('server', opts))
ipcMain.handle('build:launcher', () => runBuild('launcher'))
ipcMain.handle('build:client',   (_e, opts) => runBuild('client', opts))
ipcMain.handle('build:native',   () => runBuild('native'))
ipcMain.handle('build:gamemode', () => runBuild('gamemode'))

// Trigger the flatrim CI workflow on GitHub to rebuild the native binaries.
function ghDispatch() {
  return new Promise((resolve) => {
    const g = config.github
    if (!g.token) return resolve({ ok: false, error: 'No GitHub token. Set ALDUINAK_GH_TOKEN in skymp5-backend/.env (a PAT with actions:write scope).' })
    const body = JSON.stringify({ ref: g.ref })
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${g.repo}/actions/workflows/${encodeURIComponent(g.workflow)}/dispatches`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${g.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'AlduinakManager',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => {
        if (res.statusCode === 204) resolve({ ok: true, url: `https://github.com/${g.repo}/actions/workflows/${g.workflow}` })
        else resolve({ ok: false, error: `GitHub API ${res.statusCode}: ${String(d).slice(0, 300)}` })
      })
    })
    req.on('error', e => resolve({ ok: false, error: e.message }))
    req.write(body); req.end()
  })
}
ipcMain.handle('build:ci', () => ghDispatch())

function setJsonVersion(file, version) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  json.version = version
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
}

// Replace const <name> = '...' inside routes/version.js (no-op if already set).
function setRouteVersion(file, name, version) {
  const src = fs.readFileSync(file, 'utf8')
  const re = new RegExp(`(const\\s+${name}\\s*=\\s*)['"][^'"]*['"]`)
  if (!re.test(src)) throw new Error(`${name} not found in version.js`)
  const next = src.replace(re, `$1'${version}'`)
  if (next !== src) fs.writeFileSync(file, next)
}

// Upsert KEY=value in a .env file, creating the key if missing, preserving the rest.
function setEnvVar(file, key, value) {
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch {}
  // Strip CR/LF so a value cannot inject extra KEY=value lines into the .env.
  value = String(value).replace(/[\r\n]+/g, ' ')
  const line = `${key}=${value}`
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm')
  // Replace via a function so $-sequences in the value are not treated as patterns.
  if (re.test(txt)) txt = txt.replace(re, () => line)
  else txt = txt.replace(/\s*$/, '') + `\n${line}\n`
  fs.writeFileSync(file, txt)
}

// Anchored at both ends: the version is spliced into backend source
// (routes/version.js), so trailing garbage must be rejected.
const SEMVER_RE = /^\d+\.\d+\.\d+$/

// Register the getVersion/setVersion IPC pair for one component. The getter reads
// pkgPath's version; the setter validates the semver, writes pkgPath, then runs
// each extra writer (e.g. routes/version.js or the backend .env).
function registerVersionIpc(name, pkgPath, extraWriteFns) {
  ipcMain.handle(`${name}:getVersion`, () => {
    try { return { version: JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version } }
    catch (err) { return { version: '', error: err.message } }
  })
  ipcMain.handle(`${name}:setVersion`, (_e, version) => {
    version = String(version || '').trim()
    if (!SEMVER_RE.test(version)) return { ok: false, error: 'Use a semver like 1.2.3' }
    try {
      setJsonVersion(pkgPath, version)
      for (const fn of extraWriteFns) fn(version)
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  })
}

registerVersionIpc('launcher', config.paths.launcherPkg, [v => setRouteVersion(config.paths.versionRoute, 'LATEST_VERSION', v)])
registerVersionIpc('client', config.paths.clientPkg, [v => setRouteVersion(config.paths.versionRoute, 'CLIENT_VERSION', v)])
registerVersionIpc('server', config.paths.serverPkg, [v => setRouteVersion(config.paths.versionRoute, 'SERVER_VERSION', v)])

function backendModule(name) {
  return require(path.join(config.paths.backend, 'sources', name))
}

// Build a character record from a changeform (file JSON or mongo doc); null if not a character.
function charFromCf(cf) {
  if (!cf || cf.recType !== 1) return null            // 1 = ACHR (a character)
  const profileId = Number(cf.profileId)
  if (!Number.isFinite(profileId) || profileId < 0) return null
  // The store embeds appearanceDump as an object; very old file saves held a JSON string.
  let appearance = null
  if (cf.appearanceDump && typeof cf.appearanceDump === 'object') appearance = cf.appearanceDump
  else if (typeof cf.appearanceDump === 'string') { try { appearance = JSON.parse(cf.appearanceDump) } catch {} }
  const name = cf.displayName || (appearance && appearance.name) || cf.formDesc || '(unnamed)'
  return {
    profileId,
    formDesc: cf.formDesc,
    name,
    disabled: !!cf.isDisabled,
    dead: !!cf.isDead,
    worldOrCell: cf.worldOrCellDesc,
    position: Array.isArray(cf.position) ? cf.position : null,
    health: cf.healthPercentage,
    magicka: cf.magickaPercentage,
    stamina: cf.staminaPercentage,
    inventory: (cf.inv && Array.isArray(cf.inv.entries)) ? cf.inv.entries : [],
    spellCount: Array.isArray(cf.learnedSpells) ? cf.learnedSpells.length : 0,
    spawnDelay: cf.spawnDelay,
    appearance,
  }
}

function readServerSettings() {
  try { return JSON.parse(fs.readFileSync(config.paths.serverSettings, 'utf8')) } catch { return {} }
}

// Run fn against the mongo changeForms collection, closing the client either way.
async function withMongoChangeForms(settings, fn) {
  let MongoClient
  try { ({ MongoClient } = require('mongodb')) }
  catch { throw new Error('mongodb module not installed in server-manager - run npm install') }
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    return await fn(client.db(settings.databaseName || 'db').collection('changeForms'))
  } finally { await client.close() }
}

// File driver: yields [file, changeForm] for every parseable json in the store.
function* fileChangeForms(settings) {
  const dbName = settings.databaseName || 'world'
  const dbDir = path.isAbsolute(dbName) ? dbName : path.join(config.paths.serverDir, dbName)
  const changeForms = path.join(dbDir, 'changeForms')
  for (const entry of (fs.existsSync(changeForms) ? fs.readdirSync(changeForms) : [])) {
    if (!entry.endsWith('.json')) continue
    const file = path.join(changeForms, entry)
    let cf
    try { cf = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    yield [file, cf]
  }
}

// Read the game server's character store (changeForms) and group by profileId.
// Driver-aware: file reads world/changeForms/*.json, mongodb queries the collection.
let _charCache = { at: 0, map: new Map() }
let _charError = ''
async function readCharactersByProfile() {
  if (Date.now() - _charCache.at < 3000) return _charCache.map
  const map = new Map()
  const add = cf => {
    const c = charFromCf(cf)
    if (!c) return
    const list = map.get(c.profileId) || []
    list.push(c)
    map.set(c.profileId, list)
  }
  const settings = readServerSettings()
  try {
    if ((settings.databaseDriver || 'file') === 'mongodb') {
      await withMongoChangeForms(settings, async col => {
        for (const cf of await col.find({ recType: 1 }).toArray()) add(cf)
      })
    } else {
      for (const [, cf] of fileChangeForms(settings)) add(cf)
    }
    _charError = ''
  } catch (err) {
    _charError = err.message
  }
  _charCache = { at: Date.now(), map }
  return map
}

function whitelistSet() {
  try {
    const wl = JSON.parse(fs.readFileSync(path.join(config.paths.dataDir, 'whitelist.json'), 'utf8'))
    return new Set((Array.isArray(wl) ? wl : []).map(String))
  } catch { return new Set() }
}

ipcMain.handle('players:list', async () => {
  try {
    const players = backendModule('players').list()
    const wl = whitelistSet()
    const chars = await readCharactersByProfile()
    return {
      ok: true,
      charError: _charError || undefined,
      players: players.map(p => ({
        discordId: p.discordId,
        profileId: p.profileId,
        name: p.displayName || p.username || `Player ${p.profileId}`,
        whitelisted: wl.has(String(p.discordId)),
        characters: (chars.get(Number(p.profileId)) || []).map(c => c.name),
      })),
    }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('players:detail', async (_e, discordId) => {
  try {
    const players = backendModule('players').list()
    const p = players.find(x => String(x.discordId) === String(discordId))
    if (!p) return { ok: false, error: 'player not found' }
    const wl = whitelistSet()
    const chars = await readCharactersByProfile()
    return {
      ok: true,
      charError: _charError || undefined,
      player: {
        discordId: p.discordId, profileId: p.profileId,
        username: p.username || '', displayName: p.displayName || '',
        avatar: p.avatar || null, notes: p.notes || '',
        createdAt: p.createdAt || null, updatedAt: p.updatedAt || null, lastSeenAt: p.lastSeenAt || null,
        whitelisted: wl.has(String(p.discordId)),
      },
      factions: p.assignments || [],
      permissions: p.factionPermissions || [],
      gameFactions: p.gameFactions || [],
      characters: chars.get(Number(p.profileId)) || [],
    }
  } catch (err) { return { ok: false, error: err.message } }
})

// Persist edits to a player's username / displayName / notes.
ipcMain.handle('players:update', (_e, profileId, patch) => {
  try {
    const clean = {}
    for (const k of ['username', 'displayName', 'notes']) {
      if (patch && patch[k] !== undefined) clean[k] = String(patch[k] ?? '')
    }
    const updated = backendModule('players').updateByProfileId(Number(profileId), clean)
    return { ok: true, player: updated }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Character editing: writes straight to the changeForms store ────────────────

// Strict: only numbers and non-empty numeric strings ('' / null / [] / true
// would all coerce to 0 or 1 through Number()).
function asUint(v, label) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v)
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(`${label}: not a valid number/form id`)
  }
  return v >>> 0
}

// The server's Appearance::FromJson needs the full field set with exact types;
// normalize everything so a save can never brick the character.
function sanitizeAppearance(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('appearance: not an object')
  const out = {
    isFemale: !!a.isFemale,
    raceId: asUint(a.raceId, 'raceId'),
    weight: Number(a.weight) || 0,
    skinColor: Number(a.skinColor) | 0,
    hairColor: Number(a.hairColor) | 0,
    headpartIds: (Array.isArray(a.headpartIds) ? a.headpartIds : []).map(x => asUint(x, 'headpartIds')),
    headTextureSetId: asUint(a.headTextureSetId, 'headTextureSetId'),
    options: (Array.isArray(a.options) ? a.options : []).map(Number),
    presets: (Array.isArray(a.presets) ? a.presets : []).map(Number),
    tints: (Array.isArray(a.tints) ? a.tints : []).map(t => ({
      texturePath: String((t && t.texturePath) || ''),
      argb: Number(t && t.argb) | 0,
      type: Number(t && t.type) | 0,
    })),
    name: String(a.name || ''),
  }
  if (out.options.some(n => !Number.isFinite(n)) || out.presets.some(n => !Number.isFinite(n))) {
    throw new Error('appearance: options/presets must be numbers')
  }
  // raceId 0 resolves to no espm record, which makes the server skip the whole character at load
  if (!out.raceId) throw new Error('appearance: raceId must be a non-zero race form id')
  return out
}

const INV_EXTRA_KEYS = ['health', 'enchantmentId', 'maxCharge', 'removeEnchantmentOnUnequip', 'chargePercent', 'name', 'soul', 'poisonId', 'poisonCount', 'worn', 'wornLeft']
function sanitizeInvEntries(list) {
  if (!Array.isArray(list)) throw new Error('inventory: not an array')
  const out = []
  for (const e of list) {
    const entry = { baseId: asUint(e && e.baseId, 'baseId'), count: asUint(e && e.count, 'count') }
    if (!entry.baseId || !entry.count) continue
    for (const k of INV_EXTRA_KEYS) if (e[k] !== undefined && e[k] !== null) entry[k] = e[k]
    out.push(entry)
  }
  return out
}

async function saveCharacter(formDesc, patch) {
  if (typeof formDesc !== 'string' || !formDesc) throw new Error('missing formDesc')
  const set = {}
  if (patch && patch.appearance !== undefined) set.appearanceDump = sanitizeAppearance(patch.appearance)
  if (patch && patch.invEntries !== undefined) set.inv = { entries: sanitizeInvEntries(patch.invEntries) }
  if (!Object.keys(set).length) throw new Error('nothing to save')
  const settings = readServerSettings()
  if ((settings.databaseDriver || 'file') === 'mongodb') {
    await withMongoChangeForms(settings, async col => {
      const r = await col.updateOne({ formDesc, recType: 1 }, { $set: set })
      if (!r.matchedCount) throw new Error(`no character with formDesc ${formDesc}`)
    })
  } else {
    let saved = false
    for (const [file, cf] of fileChangeForms(settings)) {
      if (cf.formDesc !== formDesc || cf.recType !== 1) continue
      Object.assign(cf, set)
      fs.writeFileSync(file, JSON.stringify(cf, null, 2))
      saved = true
      break
    }
    if (!saved) throw new Error(`no character with formDesc ${formDesc}`)
  }
  _charCache = { at: 0, map: new Map() }
}

async function deleteCharacter(formDesc) {
  if (typeof formDesc !== 'string' || !formDesc) throw new Error('missing formDesc')
  const settings = readServerSettings()
  if ((settings.databaseDriver || 'file') === 'mongodb') {
    await withMongoChangeForms(settings, async col => {
      const r = await col.deleteOne({ formDesc, recType: 1 })
      if (!r.deletedCount) throw new Error(`no character with formDesc ${formDesc}`)
    })
  } else {
    let deleted = false
    for (const [file, cf] of fileChangeForms(settings)) {
      if (cf.formDesc !== formDesc || cf.recType !== 1) continue
      fs.unlinkSync(file)
      deleted = true
      break
    }
    if (!deleted) throw new Error(`no character with formDesc ${formDesc}`)
  }
  _charCache = { at: 0, map: new Map() }
}

async function deleteCharactersByProfile(profileId) {
  if (!Number.isInteger(profileId) || profileId < 0) throw new Error('bad profileId')
  const settings = readServerSettings()
  let count = 0
  if ((settings.databaseDriver || 'file') === 'mongodb') {
    count = await withMongoChangeForms(settings, async col =>
      (await col.deleteMany({ recType: 1, profileId })).deletedCount)
  } else {
    for (const [file, cf] of fileChangeForms(settings)) {
      if (cf.recType !== 1 || Number(cf.profileId) !== profileId) continue
      fs.unlinkSync(file)
      count++
    }
  }
  _charCache = { at: 0, map: new Map() }
  return count
}

ipcMain.handle('chars:save', async (_e, formDesc, patch) => {
  try { await saveCharacter(formDesc, patch); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('chars:delete', async (_e, formDesc) => {
  try { await deleteCharacter(formDesc); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

// Ask the running backend to drop a user's sessions (they live in its memory).
function backendDropSessions(discordId) {
  return new Promise((resolve, reject) => {
    const api = config.backendApi
    if (!api.key || !api.token) return reject(new Error('backend api credentials missing'))
    const req = http.request({
      hostname: '127.0.0.1', port: api.port, method: 'DELETE',
      path: `/api/servers/${encodeURIComponent(api.key)}/sessions-by-discord/${encodeURIComponent(discordId)}`,
      headers: { 'X-Auth-Token': api.token },
      timeout: 3000,
    }, res => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => {
        if (res.statusCode === 200) { try { resolve({ ok: true, dropped: JSON.parse(d).dropped || 0 }) } catch { resolve({ ok: true, dropped: 0 }) } }
        else if (res.statusCode === 404) resolve({ ok: false, noRoute: true })  // backend runs pre-route code
        else resolve({ ok: false })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

// A deleted player's cached launcher session (24h sliding TTL) would let them
// rejoin under the removed profile id, so their sessions must go too.
async function dropPlayerSessions(discordId) {
  try {
    const r = await backendDropSessions(discordId)
    if (r.ok) return { dropped: r.dropped, warnRestart: false }
    if (!r.noRoute) return { dropped: 0, warnRestart: true }
    // fall through to the file scrub with a restart warning
  } catch { /* backend down: the file scrub below is fully effective */ }
  // Scrub the persisted store; a RUNNING backend keeps its in-memory copy
  // (and rewrites the file), so it needs a restart in the noRoute case.
  let dropped = 0
  let backendRunning = false
  try {
    const file = path.join(config.paths.dataDir, 'sessions.json')
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
    const keep = entries.filter(([, s]) => String(s && s.discordId) !== String(discordId))
    dropped = entries.length - keep.length
    if (dropped) fs.writeFileSync(file, JSON.stringify(keep, null, 2) + '\n')
  } catch { /* no sessions file yet */ }
  try { backendRunning = /^SERVICE_RUNNING/.test(await nssm('status', await serviceName(serviceByKey.backend))) } catch {}
  return { dropped, warnRestart: backendRunning }
}

// Deletes the backend player record + profile mapping (and their sessions),
// optionally with all their characters. A returning player gets a fresh profile.
ipcMain.handle('players:delete', async (_e, profileId, opts) => {
  const pid = Number(profileId)
  let deletedChars = 0
  try {
    const players = backendModule('players')
    // Verify the mapping BEFORE the irreversible character delete.
    if (!players.getByProfileId(pid)) return { ok: false, error: 'player not found' }
    if (opts && opts.deleteCharacters) deletedChars = await deleteCharactersByProfile(pid)
    const r = players.deleteByProfileId(pid)
    const sessions = await dropPlayerSessions(r.discordId)
    return { ok: true, discordId: r.discordId, deletedChars, sessions }
  } catch (err) { return { ok: false, error: err.message, deletedChars } }
})

// Resolve item display names through the live gamemode (espm access is server-side only).
ipcMain.handle('chars:itemNames', async (_e, baseIds) => {
  const ids = [...new Set((Array.isArray(baseIds) ? baseIds : []).map(n => Number(n) >>> 0).filter(n => n > 0))].slice(0, 500)
  if (!ids.length) return { ok: true, names: {} }
  const r = await consoleRelay.query('__itemnamesjson ' + ids.map(n => n.toString(16)).join(','), '__ITEMNAMESJSON__', 5000)
  if (!r.ok) return { ok: false, error: r.error }
  try { return { ok: true, names: JSON.parse(r.payload) } } catch { return { ok: false, error: 'bad names payload' } }
})

// Ask the gamemode (over the relay) which profiles are currently online.
ipcMain.handle('players:online', async () => {
  const r = await consoleRelay.query('__playersjson', '__PLAYERSJSON__')
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const list = JSON.parse(r.payload)
    return { ok: true, profileIds: list.map(p => Number(p.profileId)), online: list }
  } catch { return { ok: false, error: 'bad players payload' } }
})

// Settings tab (structured forms)

ipcMain.handle('settings:schema', () => schema)

// Parse a .env-style file into { values, order } preserving unknown lines on write.
function readEnvValues(file) {
  const values = {}
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch {}
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/)
    if (m && !line.trimStart().startsWith('#')) values[m[1]] = m[2].trim()
  }
  return values
}

ipcMain.handle('settings:read', (_e, key) => {
  if (key === 'serverSettings') {
    const file = config.paths.serverSettings
    let values = {}
    try { values = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
      if (fs.existsSync(file)) return { ok: false, path: file, error: `Invalid JSON: ${err.message}` }
    }
    const known = new Set(schema.serverSettings.map(f => f.key))
    const extra = {}
    for (const k of Object.keys(values)) if (!known.has(k)) extra[k] = values[k]
    return { ok: true, path: file, values, extra }
  }
  if (key === 'backendEnv') {
    const file = config.paths.backendEnv
    const exists = fs.existsSync(file)
    const source = exists ? file : config.paths.backendEnvExample
    return { ok: true, path: file, values: readEnvValues(source), seeded: !exists }
  }
  return { ok: false, error: 'unknown config' }
})

ipcMain.handle('settings:write', (_e, key, values, extraRaw) => {
  try {
    if (key === 'serverSettings') {
      const file = config.paths.serverSettings
      let current = {}
      if (fs.existsSync(file)) {
        // A corrupt file must block the save, or this write replaces the live config with {}.
        try { current = JSON.parse(fs.readFileSync(file, 'utf8')) }
        catch (err) { throw new Error(`refusing to save: ${path.basename(file)} is invalid JSON (${err.message}) - fix the file first`) }
      }
      for (const field of schema.serverSettings) {
        const v = values[field.key]
        if (v === undefined) continue
        if (field.type === 'number') {
          if (v === '' || v === null) delete current[field.key]; else current[field.key] = Number(v)
        } else if (field.type === 'bool') {
          current[field.key] = !!v
        } else if (field.type === 'json') {
          if (v === '' || v === null) { delete current[field.key]; continue }
          try { current[field.key] = JSON.parse(v) } catch (e) { throw new Error(`${field.label}: invalid JSON (${e.message})`) }
        } else {
          if (v === '' || v === null) delete current[field.key]; else current[field.key] = String(v)
        }
      }
      // Merge the "other / advanced" raw-JSON bucket of unknown keys.
      if (extraRaw && String(extraRaw).trim()) {
        let extra
        try { extra = JSON.parse(extraRaw) } catch (e) { throw new Error(`Advanced JSON: ${e.message}`) }
        const known = new Set(schema.serverSettings.map(f => f.key))
        for (const k of Object.keys(current)) if (!known.has(k)) delete current[k] // replace the bucket wholesale
        Object.assign(current, extra)
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n')
      return { ok: true, path: file }
    }
    if (key === 'backendEnv') {
      const file = config.paths.backendEnv
      // Seed from the example on first save so comments/structure are preserved.
      if (!fs.existsSync(file) && fs.existsSync(config.paths.backendEnvExample)) {
        fs.copyFileSync(config.paths.backendEnvExample, file)
      }
      for (const field of schema.backendEnv) {
        if (values[field.key] === undefined) continue
        let v = values[field.key]
        if (field.type === 'bool') v = v ? 'true' : 'false'
        setEnvVar(file, field.key, String(v ?? ''))
      }
      return { ok: true, path: file }
    }
    return { ok: false, error: 'unknown config' }
  } catch (err) { return { ok: false, error: err.message } }
})

// Modlist tab

ipcMain.handle('modlist:read', () => {
  const profileDir = path.join(config.mo2Root, 'profiles', config.profile)
  const readLines = (f) => {
    try { return fs.readFileSync(path.join(profileDir, f), 'utf8').split(/\r?\n/) }
    catch { return null }
  }
  const modlist = readLines('modlist.txt')
  const plugins = readLines('plugins.txt')
  if (!modlist) return { ok: false, error: `No modlist.txt under ${profileDir}. Check ALDUINAK_MO2_ROOT / profile.` }

  const mods = [], separators = []
  for (const line of modlist) {
    const name = line.slice(1).trim()
    if (!name) continue
    if (name.endsWith('_separator')) {
      if (line[0] === '+' || line[0] === '-') separators.push(name.replace(/_separator$/, ''))
    } else if (line[0] === '+') {
      mods.push(name)
    }
  }
  const pluginList = (plugins || []).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  return { ok: true, profileDir, mods, separators, plugins: pluginList }
})

ipcMain.handle('modlist:updateManifest', async () => {
  const b = builder()
  const dep = await b.ensureDeps(config.paths.backend, 'backend', 'npm')   // compile-manifest needs 7zip-bin
  if (!dep.ok) return { ok: false, error: 'backend dependency install failed' }
  const args = ['scripts/compile-manifest.js', '--mo2', config.mo2Root, '--profile', config.profile]
  if (fs.existsSync(path.join(config.gameRoot, 'SkyrimSE.exe'))) args.push('--game', config.gameRoot)
  // Spawn node.exe directly (shell=false): no cmd.exe means config-derived paths
  // with spaces or shell metacharacters cannot split args or be interpreted.
  const r = await b.run('node', args, config.paths.backend, 'compile-manifest', null, false)
  return r.ok ? { ok: true } : { ok: false, error: 'compile-manifest failed' }
})
