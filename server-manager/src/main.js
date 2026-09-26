'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')
const https = require('https')
const os = require('os')
const config = require('./config')
const { Builder } = require('./build')
const schema = require('./settingsSchema')
const modsync = require('./modsync')
const mongoPurge = require('./mongoPurge')
const managerLock = require('./managerLock')
const { createConsoleRelay } = require('./relayClient')
const { LOCK_CODES, nssm } = require('./serviceCheck')
const {
  hooks: serviceHooks, serviceByKey, resolvedNames, serviceName, gameStatus, readServerSettings,
  statusAll, doServiceAction, doServicesAction, discoverLogTargets, requireGameStopped,
} = require('./services')
const { backendRequest, factionsRequest } = require('./backendApi')
const playerData = require('./playerData')
const serviceStats = require('./serviceStats')
const news = require('./news')

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
	
ipcMain.handle('services:status', () => statusAll())

ipcMain.handle('service:action', (_e, key, action) => doServiceAction(key, action))
// Sampled only while the Console tab is open
ipcMain.handle('services:stats', () => serviceStats.sample().catch(() => ({})))
ipcMain.handle('services:action', (_e, action) => doServicesAction(action))

const tailState = {}   // file -> last byte offset
let logTargets = []    // [{ file, label }]

serviceHooks.onRotated = file => { delete tailState[file] }
serviceHooks.status = text => send('console:relay', { kind: 'status', text })

async function refreshLogTargets() {
  logTargets = await discoverLogTargets()
}

function pollLogs() {
  for (const { file, label, service } of logTargets) {
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
        send('log:data', { service, source: label, text: buf.toString('utf8') })
      } catch { /* mid-write race, retry next tick */ }
    }
  }
}

function startLogTail() {
  refreshLogTargets()
  setInterval(pollLogs, 1500)
  setInterval(refreshLogTargets, 30000)   // services may be re-installed/reconfigured
}

const consoleRelay = createConsoleRelay({
  onStatus: text => send('console:relay', { kind: 'status', text }),
  onOutput: text => send('console:relay', { kind: 'output', text }),
})

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
    const holder = managerLock.holder()
    if (holder) { consoleOut(`a build or sync is already running (${managerLock.describe(holder)}) - wait for it to finish`); return { ok: true } }
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

// Builds stream to build:log, the Modlist tab's operations to modlist:log
function builder(channel = 'build:log') { return new Builder(t => send(channel, t)) }

// One build or sync at a time: console commands, the Build tab, the Modlist tab and the web manager agent share this lock.
async function exclusive(fn) {
  let lock
  try { lock = managerLock.acquire({ source: 'electron', kind: 'manager build or sync', actor: `local:${os.userInfo().username}` }) }
  catch (err) { return { ok: false, error: `cannot take the build lock: ${err.message}` } }
  if (!lock.ok) return { ok: false, error: `a build or sync is already running: ${managerLock.describe(lock.holder)}` }
  try {
    const r = await fn()
    // Let queued build:log messages land before the renderer prints the outcome, else the failure line appears above its error.
    await new Promise(res => setTimeout(res, 100))
    return r
  } catch (err) {
    return { ok: false, error: err.message }
  } finally { lock.release() }
}

function runBuild(kind, opts) {
  return exclusive(async () => {
    const b = builder()
    if (kind === 'server')   return b.buildServer(opts)
    if (kind === 'launcher') return b.buildLauncher()
    if (kind === 'client')   return b.buildClient(opts)
    if (kind === 'native')   return b.buildNative()
    if (kind === 'gamemode') return b.buildGamemode()
    return { ok: false, error: `unknown build ${kind}` }
  })
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

// Anchored at both ends so trailing garbage never reaches versions.json
const SEMVER_RE = /^\d+\.\d+\.\d+$/

// Register the getVersion/setVersion IPC pair for one component. The getter reads
// pkgPath's version; the setter validates the semver, writes pkgPath, then runs
// each extra writer (e.g. the backend's versions.json).
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

const writeVersion = key => v => backendModule('versions').writeVersion(key, v)
// The launcher and client versions reach versions.json only through Update Version, once their files are live
registerVersionIpc('launcher', config.paths.launcherPkg, [])
registerVersionIpc('client', config.paths.clientPkg, [])
registerVersionIpc('server', config.paths.serverPkg, [writeVersion('server')])

const PUBLISHED_PKG = { launcher: config.paths.launcherPkg, client: config.paths.clientPkg }

ipcMain.handle('versions:published', () => {
  try { return { ok: true, versions: backendModule('versions').readVersions() } }
  catch (err) { return { ok: false, error: err.message } }
})

// Writes the package's version into versions.json, so launchers update to it
ipcMain.handle('versions:publish', (_e, key) => {
  const pkg = PUBLISHED_PKG[key]
  if (!pkg) return { ok: false, error: 'unknown component' }
  try {
    const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version
    if (!SEMVER_RE.test(String(version))) return { ok: false, error: `bad version ${version}` }
    backendModule('versions').writeVersion(key, version)
    return { ok: true, version }
  } catch (err) { return { ok: false, error: err.message } }
})

function backendModule(name) {
  return require(path.join(config.paths.backend, 'sources', name))
}

// Living characters per player, the server's characterSelectMaxCharacters parse (1-10, default 3)
function maxCharactersOf(settings) {
  const raw = Number(settings.characterSelectMaxCharacters)
  return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : 3
}

// Afterlife state of a changeform, as afterlifeSystem.ts isFallen reads it: the realm label, 'perma-dead', or '' for a living character
const REALM_LABELS = { sovngarde: 'Sovngarde', soulCairn: 'the Soul Cairn' }
function fallenOf(cf) {
  const d = (cf && cf.dynamicFields) || {}
  if (d['private.permaDead'] === true) return 'perma-dead'
  const realm = d['private.afterlife'] && d['private.afterlife'].realm
  return REALM_LABELS[realm] || ''
}

// Build a character record from a changeform (file JSON or mongo doc); null if not a character.
// A deleted character keeps its doc (isDeleted) until the id is reused; the server skips it at boot and so does this.
function charFromCf(cf) {
  if (!cf || cf.recType !== 1 || cf.isDeleted) return null            // 1 = ACHR (a character)
  const profileId = Number(cf.profileId)
  if (!Number.isFinite(profileId) || profileId < 0) return null
  // The store embeds appearanceDump as an object; very old file saves held a JSON string.
  let appearance = null
  if (cf.appearanceDump && typeof cf.appearanceDump === 'object') appearance = cf.appearanceDump
  else if (typeof cf.appearanceDump === 'string') { try { appearance = JSON.parse(cf.appearanceDump) } catch {} }
  const name = cf.displayName || (appearance && appearance.name) || cf.formDesc || '(unnamed)'
  const df = cf.dynamicFields || {}
  return {
    profileId,
    formDesc: cf.formDesc,
    name,
    disabled: !!cf.isDisabled,
    dead: !!cf.isDead,
    slot: (cf.dynamicFields && Number.isInteger(cf.dynamicFields['private.charSlot'])) ? cf.dynamicFields['private.charSlot'] : null,
    fallen: fallenOf(cf),
    profession: (df['private.mastery'] && df['private.mastery'].profession) || '',
    professionHours: (df['private.mastery'] && Number(df['private.mastery'].points)) || 0,
    attrBonus: { health: 0, magicka: 0, stamina: 0, ...(df['private.attrBonus'] || {}) },
    roles: Array.isArray(df['private.discordRoles']) ? df['private.discordRoles'].map(String) : [],
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

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// Rename with retries: the backend may be streaming the target to a launcher at that moment
async function replaceFile(from, to, attempts = 10) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return null }
    catch (err) {
      if (!LOCK_CODES.includes(err.code) || i >= attempts) return err
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

// Run fn against the game server's MongoDB database, closing the client either way.
async function withDatabase(settings, fn) {
  let MongoClient
  try { ({ MongoClient } = require('mongodb')) }
  catch { throw new Error('mongodb module not installed in server-manager - run npm install') }
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    return await fn(client.db(settings.databaseName || 'db'))
  } finally { await client.close() }
}

async function withMongoChangeForms(settings, fn) {
  return withDatabase(settings, db => fn(db.collection('changeForms')))
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
// Revives sent through the running server reach the store at its next save; until then their rows are patched here
const _revivedPending = new Set()
async function readCharactersByProfile() {
  if (Date.now() - _charCache.at < 3000) return _charCache.map
  const map = new Map()
  const add = cf => {
    const c = charFromCf(cf)
    if (!c) return
    if (_revivedPending.has(c.formDesc)) {
      if (c.fallen) Object.assign(c, { fallen: '', worldOrCell: REVIVE_ARRIVAL.worldOrCellDesc, position: REVIVE_ARRIVAL.position })
      else _revivedPending.delete(c.formDesc)
    }
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

function whitelistRoleId() {
  const access = readServerSettings().access
  return (access && access.whitelistRoleId) || ''
}

async function playerRows() {
  const settings = readServerSettings()
  if (settings.databaseDriver !== 'mongodb') throw new Error('the Players tab needs the MongoDB database (databaseDriver "mongodb")')
  const [backend, chars] = await Promise.all([playerData.readBackend(settings), readCharactersByProfile()])
  return { backend, rows: playerData.buildRows(backend, chars, whitelistRoleId()) }
}

ipcMain.handle('players:list', async () => {
  try {
    const { rows } = await playerRows()
    return { ok: true, charError: _charError || undefined, rows, races: playerData.RACE_NAMES }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('players:detail', async (_e, profileId) => {
  try {
    const { backend, rows } = await playerRows()
    const row = rows.find(r => r.profileId === Number(profileId))
    if (!row) return { ok: false, error: 'player not found' }
    return {
      ok: true,
      charError: _charError || undefined,
      player: row,
      assignments: playerData.assignmentsOf(backend.whitelist, row.discordId),
      factions: playerData.factionChoices(backend.whitelist),
    }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('players:stats', async () => {
  try { return { ok: true, stats: playerData.stats((await playerRows()).rows) } }
  catch (err) { return { ok: false, error: err.message } }
})

// Writes to the backend's records go through its API with the manager token
async function backendCall(method, apiPath, body) {
  const token = config.backendApi.token
  if (!token) return { ok: false, error: 'masterApiAuthToken is not set in server-settings.json' }
  try {
    const { status, data } = await backendRequest(method, apiPath, { body, headers: { 'X-Auth-Token': token }, timeout: 10000 })
    const ok = status >= 200 && status < 300
    return { ok, data, error: ok ? undefined : (data && data.error) || `the backend answered ${status}` }
  } catch (err) {
    return { ok: false, error: `the backend is unreachable (${err.message}); start the Backend service` }
  }
}

ipcMain.handle('players:ban', (_e, profileId, enabled) =>
  backendCall('PUT', `/api/players/${Number(profileId)}/ban`, { enabled: enabled === true }))

// Kicks the account's online character through the game console
ipcMain.handle('players:kick', async (_e, profileId) => {
  const r = await consoleRelay.query('__playersjson', '__PLAYERSJSON__')
  if (!r.ok) return { ok: false, error: `${r.error}: the game server must be running` }
  let online = []
  try { online = JSON.parse(r.payload) } catch { return { ok: false, error: 'bad players payload' } }
  const hit = online.find(p => Number(p.profileId) === Number(profileId))
  if (!hit) return { ok: false, error: 'they are not online' }
  return consoleRelay.command(`kick ${hit.name}`)
})

ipcMain.handle('chars:faction', (_e, profileId, change) => {
  const pid = Number(profileId)
  if (change && change.remove) return backendCall('DELETE', `/api/players/${pid}/factions/${encodeURIComponent(String(change.remove))}`)
  const { requirementId, slot, playerName } = change || {}
  return backendCall('POST', `/api/players/${pid}/factions`, { requirementId, slot, playerName })
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

// Reads the character's changeform, lets mutate change it and writes it back whole (dynamicFields keys hold dots, so no field paths)
async function updateCharacterDoc(formDesc, mutate) {
  if (typeof formDesc !== 'string' || !formDesc) throw new Error('missing formDesc')
  const settings = readServerSettings()
  if ((settings.databaseDriver || 'file') === 'mongodb') {
    await withMongoChangeForms(settings, async col => {
      const cf = await col.findOne({ formDesc, recType: 1 })
      if (!cf) throw new Error(`no character with formDesc ${formDesc}`)
      mutate(cf, settings)
      const { _id, ...doc } = cf
      await col.replaceOne({ _id }, doc)
    })
  } else {
    const hit = [...fileChangeForms(settings)].find(([, cf]) => cf.formDesc === formDesc && cf.recType === 1)
    if (!hit) throw new Error(`no character with formDesc ${formDesc}`)
    mutate(hit[1], settings)
    fs.writeFileSync(hit[0], JSON.stringify(hit[1], null, 2))
  }
  _charCache = { at: 0, map: new Map() }
}

const PROFESSIONS = ['alchemist', 'blacksmith', 'cook', 'hunter', 'miner', 'tailor', 'warrior', 'woodworker']
const ATTR_LIMIT = 1000   // adminSystem.ts attrSet bounds

function intIn(v, lo, hi, label) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label}: a whole number from ${lo} to ${hi}`)
  return n
}

// A new profession drops the old one's rank marker spells; the server re-grants the right ones at the next login
function applyMastery(cf, df, { profession, hours }) {
  const prof = profession ? String(profession) : null
  if (prof && !PROFESSIONS.includes(prof)) throw new Error(`profession: unknown ${prof}`)
  const rec = { profession: null, points: 0, lastPointAt: 0, rank: 0, granted: [], ...(df['private.mastery'] || {}) }
  if (rec.profession !== prof) {
    const drop = new Set((rec.granted || []).map(Number))
    if (Array.isArray(cf.learnedSpells)) cf.learnedSpells = cf.learnedSpells.filter(id => !drop.has(Number(id)))
    rec.granted = []
    rec.rank = 0
    rec.profession = prof
  }
  rec.points = intIn(hours, 0, 100000, 'Hours in profession')
  df['private.mastery'] = rec
}

function applyCharacterPatch(cf, patch) {
  const df = cf.dynamicFields = { ...(cf.dynamicFields || {}) }
  let changed = false
  if (patch.appearance !== undefined) { cf.appearanceDump = sanitizeAppearance(patch.appearance); changed = true }
  if (patch.invEntries !== undefined) { cf.inv = { entries: sanitizeInvEntries(patch.invEntries) }; changed = true }
  if (patch.name !== undefined) {
    const name = String(patch.name).replace(/\p{Cc}/gu, ' ').trim().slice(0, 60)
    if (!name) throw new Error('Name: empty')
    cf.appearanceDump = { ...(cf.appearanceDump || {}), name }
    if (cf.displayName !== undefined) cf.displayName = name
    changed = true
  }
  if (patch.attrBonus !== undefined) {
    const b = patch.attrBonus || {}
    df['private.attrBonus'] = {
      health: intIn(b.health, -ATTR_LIMIT, ATTR_LIMIT, 'Max health'),
      magicka: intIn(b.magicka, -ATTR_LIMIT, ATTR_LIMIT, 'Max magicka'),
      stamina: intIn(b.stamina, -ATTR_LIMIT, ATTR_LIMIT, 'Max stamina'),
    }
    changed = true
  }
  if (patch.mastery !== undefined) { applyMastery(cf, df, patch.mastery || {}); changed = true }
  if (patch.location !== undefined) {
    const { worldOrCellDesc, position } = patch.location || {}
    if (!/^[0-9a-f]{1,8}:[^:]+\.(esm|esp|esl)$/i.test(String(worldOrCellDesc || ''))) throw new Error('Cell: expected a form id and plugin, e.g. 165a7:Skyrim.esm')
    if (!Array.isArray(position) || position.length !== 3 || position.some(n => !Number.isFinite(Number(n)))) throw new Error('Coordinates: three numbers')
    cf.worldOrCellDesc = String(worldOrCellDesc)
    cf.position = position.map(Number)
    changed = true
  }
  if (!changed) throw new Error('nothing to save')
}

async function saveCharacter(formDesc, patch) {
  await updateCharacterDoc(formDesc, cf => applyCharacterPatch(cf, patch || {}))
}

// afterlifeSystem.ts REALMS: where each realm's arrivals appear
const REALM_ARRIVALS = {
  sovngarde: { worldOrCellDesc: '95c44:Skyrim.esm', position: [-590.44, -131.84, -357.73], angle: [0, 0, 359] },
  soulCairn: { worldOrCellDesc: '1408:Dawnguard.esm', position: [-19965.66, -15986.51, 2079.48], angle: [0, 0, 77.35] },
}

// As afterlifeSystem.ts send() does, written to the store while the game server is stopped
async function sendToRealm(formDesc, realm) {
  const arrival = REALM_ARRIVALS[realm]
  if (!arrival) throw new Error(`unknown realm ${realm}`)
  if (await gameStatus() !== 'SERVICE_STOPPED') throw new Error('stop the game server first: it owns the character while it runs')
  await updateCharacterDoc(formDesc, cf => {
    if (fallenOf(cf)) throw new Error('They are already fallen')
    const df = cf.dynamicFields = { ...(cf.dynamicFields || {}) }
    df['private.afterlife'] = { realm, reason: 'server manager', at: Date.now() }
    delete df['private.afterlifeOutfit']
    Object.assign(cf, arrival)
  })
}

ipcMain.handle('chars:afterlife', async (_e, formDesc, realm) => {
  try { await sendToRealm(formDesc, realm); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

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

// Where a revived character wakes (afterlifeSystem.ts REVIVE_ARRIVAL, the Temple of Kynareth)
const REVIVE_ARRIVAL = { worldOrCellDesc: '165a7:Skyrim.esm', position: [223.24, 248.85, 54], angle: [0, 0, 0] }
const REVIVE_PROPS = ['private.afterlife', 'private.permaDead', 'private.factionsReleased']

// The server's own revive rules against the store: the doc must be a fallen character and its profile below the living limit
function reviveRefusal(cf, docs, settings) {
  if (!cf || cf.recType !== 1 || cf.isDeleted) return 'no such character'
  if (!fallenOf(cf)) return 'They are not fallen'
  if (cf.isDead) return 'They are dead right now, wait for the respawn'
  const living = docs.filter(d => d.recType === 1 && !d.isDeleted && Number(d.profileId) === Number(cf.profileId) && !fallenOf(d)).length
  if (living >= maxCharactersOf(settings)) return 'The extra slot is in use: delete the character created in it first'
  return ''
}

// Clears the afterlife props and moves the body to the temple, written whole as the server's own save does
function revivedFields(cf) {
  const dynamicFields = { ...(cf.dynamicFields || {}) }
  for (const k of REVIVE_PROPS) delete dynamicFields[k]
  return { dynamicFields, ...REVIVE_ARRIVAL }
}

// Only while the game server is stopped: a running server owns the changeform in memory and would overwrite the edit at its next save
async function reviveOffline(formDesc) {
  if (typeof formDesc !== 'string' || !formDesc) throw new Error('missing formDesc')
  const settings = readServerSettings()
  if ((settings.databaseDriver || 'file') === 'mongodb') {
    await withMongoChangeForms(settings, async col => {
      const docs = await col.find({ recType: 1 }).toArray()
      const cf = docs.find(d => d.formDesc === formDesc)
      const refusal = reviveRefusal(cf, docs, settings)
      if (refusal) throw new Error(refusal)
      await col.updateOne({ formDesc, recType: 1 }, { $set: revivedFields(cf) })
    })
  } else {
    const all = [...fileChangeForms(settings)]
    const hit = all.find(([, cf]) => cf.formDesc === formDesc)
    const refusal = reviveRefusal(hit && hit[1], all.map(([, cf]) => cf), settings)
    if (refusal) throw new Error(refusal)
    fs.writeFileSync(hit[0], JSON.stringify(Object.assign(hit[1], revivedFields(hit[1])), null, 2))
  }
  _charCache = { at: 0, map: new Map() }
}

// Through the running server (it owns the changeform), straight to the store while it is stopped
ipcMain.handle('chars:revive', async (_e, formDesc) => {
  try {
    if (await gameStatus() === 'SERVICE_RUNNING') {
      // Player characters carry a bare hex formDesc; the gamemode resolves it with getIdFromDesc
      if (!/^[0-9a-f]{1,8}$/i.test(String(formDesc || ''))) return { ok: false, error: 'not a player character' }
      const r = await consoleRelay.query('__revivejson ' + formDesc, '__REVIVEJSON__', 5000)
      if (!r.ok) return { ok: false, error: `${r.error}: start the backend, or stop the game server to revive in the database` }
      let res
      try { res = JSON.parse(r.payload) } catch { return { ok: false, error: 'bad revive payload' } }
      if (!res.ok) return { ok: false, error: res.error || 'refused' }
      _revivedPending.add(formDesc)
    } else {
      await reviveOffline(formDesc)
    }
    _charCache = { at: 0, map: new Map() }
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

// Factions tab: definitions live in the backend, which is their only writer
ipcMain.handle('factions:api', (_e, method, subPath, body) => factionsRequest(method, subPath, body))

// Deletes the account through the backend (record, profile mapping and sessions), optionally with all their characters
ipcMain.handle('players:delete', async (_e, profileId, opts) => {
  const pid = Number(profileId)
  let deletedChars = 0
  try {
    if (opts && opts.deleteCharacters) deletedChars = await deleteCharactersByProfile(pid)
    const r = await backendCall('DELETE', `/api/players/${pid}`)
    return r.ok ? { ok: true, deletedChars } : { ok: false, error: r.error, deletedChars }
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

// ── Security tab: alerts the backend and the game server raise into securityAlerts ──

const ALERT_TYPES = ['banEvasion', 'goldSpawn']

async function withAlerts(fn) {
  const settings = readServerSettings()
  if (settings.databaseDriver !== 'mongodb') throw new Error('security alerts need the MongoDB database')
  return withDatabase(settings, db => fn(db.collection('securityAlerts')))
}

async function unreadCounts(col) {
  const out = Object.fromEntries(ALERT_TYPES.map(t => [t, 0]))
  for (const { _id, n } of await col.aggregate([{ $match: { read: false } }, { $group: { _id: '$type', n: { $sum: 1 } } }]).toArray()) out[_id] = n
  return out
}

ipcMain.handle('security:unread', async () => {
  try { return { ok: true, unread: await withAlerts(unreadCounts) } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('security:list', async (_e, type) => {
  if (!ALERT_TYPES.includes(type)) return { ok: false, error: 'unknown alert type' }
  try {
    return await withAlerts(async col => ({
      ok: true,
      alerts: (await col.find({ type }).sort({ createdAt: -1 }).limit(500).toArray()).map(a => ({ ...a, id: String(a._id), _id: undefined })),
    }))
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('security:markRead', async (_e, type) => {
  if (!ALERT_TYPES.includes(type)) return { ok: false, error: 'unknown alert type' }
  try {
    return await withAlerts(async col => {
      await col.updateMany({ type, read: false }, { $set: { read: true, readAt: new Date() } })
      return { ok: true, unread: await unreadCounts(col) }
    })
  } catch (err) { return { ok: false, error: err.message } }
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

// { settings, mtimeMs } of server-settings.json; a missing file reads as {} with mtimeMs null, invalid JSON throws
function readSettingsOrEmpty(file) {
  try { return modsync.readSettingsFile(file) }
  catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, mtimeMs: null }
    if (err instanceof SyntaxError) throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`)
    throw err.code ? new Error(`${path.basename(file)} cannot be read: ${err.message}`) : err
  }
}

// null when the file is missing, throws on invalid JSON
function readSettingsOrNull() {
  const { settings, mtimeMs } = readSettingsOrEmpty(config.paths.serverSettings)
  return mtimeMs === null ? null : settings
}

// The Modlist sync and purge actions refuse to run without the live settings
function requireSettings() {
  const settings = readSettingsOrNull()
  if (!settings) throw new Error(`server-settings.json not found at ${config.paths.serverSettings}`)
  return settings
}

ipcMain.handle('settings:read', (_e, key) => {
  if (key === 'serverSettings') {
    const file = config.paths.serverSettings
    let values, mtimeMs
    try { ({ settings: values, mtimeMs } = readSettingsOrEmpty(file)) }
    catch (err) { return { ok: false, path: file, error: err.message } }
    const known = new Set(schema.serverSettings.map(f => f.key))
    const extra = {}
    for (const k of Object.keys(values)) if (!known.has(k)) extra[k] = values[k]
    return { ok: true, path: file, values, extra, mtimeMs }
  }
  if (key === 'backendEnv') {
    const file = config.paths.backendEnv
    const exists = fs.existsSync(file)
    const source = exists ? file : config.paths.backendEnvExample
    return { ok: true, path: file, values: readEnvValues(source), seeded: !exists }
  }
  return { ok: false, error: 'unknown config' }
})

// mtimeMs is the value settings:read returned; a file edited since then (Sync server settings, a hand edit) is never overwritten
ipcMain.handle('settings:write', (_e, key, values, extraRaw, mtimeMs) => {
  try {
    if (key === 'serverSettings') {
      const file = config.paths.serverSettings
      // A corrupt file must block the save, or this write replaces the live config with {}.
      let current, now
      try { ({ settings: current, mtimeMs: now } = readSettingsOrEmpty(file)) }
      catch (err) { throw new Error(`refusing to save: ${path.basename(file)} is unreadable (${err.message}) - fix the file first`) }
      if (now !== (mtimeMs ?? null)) throw new Error('server-settings.json changed on disk, reload the Settings tab first')
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
      modsync.writeSettingsFile(file, current)
      return { ok: true, path: file, mtimeMs: fs.statSync(file).mtimeMs }
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

// News tab

const newsResult = (fn) => { try { return fn() } catch (err) { return { ok: false, error: err.message } } }

ipcMain.handle('news:list',     ()            => newsResult(() => news.list()))
ipcMain.handle('news:save',     (_e, i, item) => newsResult(() => news.save(i === undefined ? null : i, item)))
ipcMain.handle('news:delete',   (_e, i)       => newsResult(() => news.remove(i)))
ipcMain.handle('news:addImage', async () => {
  const { dialog } = require('electron')
  const r = await dialog.showOpenDialog({
    title: 'Choose a news image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  })
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true }
  return newsResult(() => news.addImage(r.filePaths[0]))
})


// Modlist: Build tab > Client > Update modlist

// Compile the manifest into a .building file and diff it against the last deployed one; only a successful diff rotates it into place
async function updateManifest() {
  const b = builder('modlist:log')
  const previousDiff = modsync.readDiff()
  const settings = readSettingsOrNull()
  if (!settings) b.line('[manifest] WARNING: server-settings.json not found, the load order the database was written under is recorded as empty')
  const dep = await b.ensureDeps(config.paths.backend, 'backend', 'npm')   // compile-manifest needs 7zip-bin
  if (!dep.ok) return { ok: false, error: 'backend dependency install failed' }
  const live = modsync.paths.manifest
  const building = live + '.building'
  const args = ['scripts/compile-manifest.js', '--mo2', config.mo2Root, '--profile', config.profile, '--out', building]
  if (fs.existsSync(path.join(config.gameRoot, 'SkyrimSE.exe'))) args.push('--game', config.gameRoot)
  // shell=false: config-derived paths with spaces or shell metacharacters cannot split args
  const r = await b.run('node', args, config.paths.backend, 'compile-manifest', null, false)
  const rotate = modsync.shouldRotatePrev(previousDiff)
  let prev, diff
  try {
    if (!r.ok) throw new Error('compile-manifest failed')
    const next = modsync.readManifestLight(building)
    if (!next) throw new Error('compile-manifest wrote no usable manifest')
    prev = modsync.readManifestLight(rotate ? live : modsync.paths.prevManifest)
    diff = modsync.computeDiff({ prev, next, settings: settings || {}, previousDiff })
  } catch (err) {
    fs.rmSync(building, { force: true })
    b.line(`[manifest] ${err.message}; ${path.basename(live)} and the previous diff are untouched`)
    return { ok: false, error: err.message }
  }
  if (rotate && prev) {
    fs.copyFileSync(live, modsync.paths.prevManifest)
    b.line(`[manifest] deployed manifest snapshotted to ${path.basename(modsync.paths.prevManifest)}`)
  }
  const renameErr = await replaceFile(building, live)
  if (renameErr) {
    return { ok: false, error: `could not replace ${path.basename(live)}: ${renameErr.message}; the compiled manifest is waiting in ${path.basename(building)} and the next Build manifest overwrites it` }
  }
  modsync.writeDiff(diff)
  const { mods, plugins, files } = diff
  b.line(`[manifest] diff vs ${prev ? prev.builtAt : 'nothing'}: mods +${mods.added.length} -${mods.removed.length} ~${mods.changed.length}, ` +
    `plugins +${plugins.added.length} -${plugins.removed.length}${plugins.reordered ? ' (reordered)' : ''}, ` +
    `files +${files.added} -${files.removed} ~${files.changed}`)
  const shifted = Array.isArray(diff.shiftedPlugins) ? diff.shiftedPlugins : []
  const flagChanges = Array.isArray(diff.flagChanges) ? diff.flagChanges : []
  if (diff.purgeNeeded) {
    b.line(`[manifest] MongoDB purge needed before the game server starts: ${plugins.removed.length} removed, ${shifted.length} shifted, ${flagChanges.length} light flag change(s)`)
    for (const s of shifted) b.line(`[manifest] shift ${s.name}: ${s.from} -> ${s.to}`)
  }
  for (const w of (Array.isArray(diff.warnings) ? diff.warnings : [])) b.line(`[manifest] WARNING: ${w}`)
  return { ok: true, diff }
}

ipcMain.handle('modlist:diff', () => modsync.readDiff())

function readManifestOrFail() {
  const manifest = modsync.readManifestLight(modsync.paths.manifest)
  if (!manifest) throw new Error('no manifest.json, build the manifest first')
  return manifest
}

// Record a sync step on the stored diff; a missing or unreadable diff only logs
function stampDiff(patch, log) {
  try { if (modsync.readDiff()) modsync.updateDiff(patch) }
  catch (err) { log(`[diff] not updated: ${err.message}`) }
}

function syncServerSettings(b) {
  const manifest = readManifestOrFail()
  requireSettings()
  const r = modsync.syncSettings({ manifest, settingsPath: config.paths.serverSettings, log: t => b.line(t), dryRun: false })
  if (r.ok) stampDiff({ syncedSettingsAt: new Date().toISOString() }, t => b.line(t))
  return r
}

async function syncDataFolder(b) {
  const manifest = readManifestOrFail()
  const prev = modsync.readManifestLight(modsync.paths.prevManifest)
  const stamp = readJsonOrNull(modsync.paths.stamp)
  const settings = requireSettings()
  if (!settings.dataDir) return { ok: false, error: 'server-settings.json has no dataDir' }
  // syncData persists data-sync.json itself after a real run
  const r = await modsync.syncData({ manifest, prev, stamp, dataDir: settings.dataDir, mo2Root: config.mo2Root, log: t => b.line(t), dryRun: false })
  if (r.ok) stampDiff({ syncedDataAt: new Date().toISOString() }, t => b.line(t))
  return r
}

async function purgeDatabase(b) {
  const log = t => b.line(`[purge] ${t}`)
  const manifest = readManifestOrFail()
  const diff = modsync.readDiff()
  if (!diff) return { ok: false, error: 'build the manifest first so the current load order is recorded for the MongoDB purge' }
  const settings = requireSettings()
  const r = await mongoPurge.purgeRemovedMods({
    settings, diff, dryRun: false, log,
    newLoadOrder: [...modsync.VANILLA_PLUGINS, ...modsync.enabledPlugins(manifest)],
    currentLoadOrder: (Array.isArray(settings.loadOrder) ? settings.loadOrder : []).map(modsync.basename),
    startPoints: settings.startPoints,
    backupDir: config.paths.serverDir,
    // Throwing here aborts the purge before its first write, so no write ever happens without a recorded backup
    onWriteStart: ({ backupFile }) => { modsync.updateDiff({ purgeStartedAt: new Date().toISOString(), purgeBackup: backupFile }) },
  })
  if (r.ok) stampDiff({ purgedAt: new Date().toISOString(), purgeStartedAt: null }, log)
  return r
}

// Update modlist: manifest, server settings, data folder and the MongoDB purge in one go, with the game server stopped.
// The change report comes back to the window; its file lives only while the steps run, and stays after a failure so the start gate holds.
ipcMain.handle('modlist:run', () => exclusive(async () => {
  const b = builder('modlist:log')
  const blocked = await requireGameStopped(t => b.line(t), false)
  if (blocked) return blocked
  const built = await updateManifest()
  if (!built.ok) return built
  const steps = [
    ['server settings', () => syncServerSettings(b)],
    ['data folder', () => syncDataFolder(b)],
    ['MongoDB purge', () => purgeDatabase(b)],
  ]
  for (const [label, run] of steps) {
    b.line(`\n######## ${label} ########`)
    const r = await run()
    if (!r.ok) return { ok: false, error: `${label}: ${r.error || 'failed'}`, diff: built.diff, report: r.report }
  }
  fs.rmSync(modsync.paths.diff, { force: true })
  return { ok: true, diff: built.diff }
}))

// Puts the last purge backup back and reopens the diff for another purge
ipcMain.handle('modlist:purgeRestore', () => exclusive(async () => {
  const b = builder('modlist:log')
  const log = t => b.line(`[restore] ${t}`)
  const diff = modsync.readDiff()
  if (!diff || !diff.purgeBackup) return { ok: false, error: 'no purge backup recorded in manifest-diff.json' }
  const settings = requireSettings()
  const blocked = await requireGameStopped(log, false)
  if (blocked) return blocked
  const r = await mongoPurge.restorePurge({ settings, backupFile: diff.purgeBackup, log })
  if (r.ok) stampDiff({ purgeStartedAt: null, purgeBackup: null, purgedAt: null }, log)
  return r
}))
