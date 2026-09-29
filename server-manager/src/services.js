'use strict'

// nssm service control, log rotation and log discovery, shared by the Electron manager and the AlduinakManager agent

const path = require('path')
const fs   = require('fs')
const config = require('./config')
const modsync = require('./modsync')
const playtime = require('./playtime')
const managerLock = require('./managerLock')
const { nssm, nativeModuleLocked } = require('./serviceCheck')

// Host callbacks: onRotated(file) after a log is archived, status(text, profileKey) for warnings
const hooks = { onRotated: () => {}, status: () => {} }

const serviceByKey = Object.fromEntries(config.services.map(s => [s.key, s]))
const LIVE = config.profiles.live

// The profile a game or LiveKit service belongs to; the shared MongoDB resolves to live, the backend group to undefined
function profileOf(svc) {
  return Object.values(config.profiles).find(p => Object.values(p.services).includes(svc.key))
}

// A profile's manifest set under the backend data dir
const dataPaths = modsync.pathsFor

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

async function gameStatus(profile = LIVE) { return nssm('status', await serviceName(serviceByKey[profile.services.game])) }

// Lenient read for the players and log tabs: {} when the file is missing or invalid
function readServerSettings(profile = LIVE) {
  try { return modsync.readSettingsFile(profile.serverSettings).settings } catch { return {} }
}

// Until the purge ran, the database still holds ids encoded under the old load order
function purgePending(profile = LIVE) {
  let diff = null
  try { diff = modsync.readDiff(dataPaths(profile)) } catch {}
  if (!modsync.purgePending(diff)) return null
  return 'refused: a MongoDB purge is pending for the new load order, run Purge MongoDB (or Restore last purge) first'
}

// The backend and both game servers hold MongoDB open; stopping it under them loses writes
const MONGO_USERS = { mongo: ['backend', 'game', 'test-game'] }

// Installed and not stopped (running or in a pending state)
async function isActive(key) {
  const status = await nssm('status', await serviceName(serviceByKey[key]))
  return /^SERVICE_/.test(status) && status !== 'SERVICE_STOPPED'
}

async function act(svc, verb) {
  if (verb === 'stop') {
    for (const dep of MONGO_USERS[svc.key] || []) {
      if (await isActive(dep)) return { ok: false, text: `refused: stop ${serviceByKey[dep].label} first` }
    }
  }
  const profile = profileOf(svc)
  if (verb === 'start' && profile && svc.key === profile.services.game) {
    const pending = purgePending(profile)
    if (pending) return { ok: false, text: pending }
  }
  const name = await serviceName(svc)
  // Archive logs while the service is stopped (nssm frees the file handle),
  // so a restart (stop then start) always begins a fresh log file.
  if (verb === 'start' && await nssm('status', name) === 'SERVICE_STOPPED') {
    await rotateServiceLogs(svc)
  }
  await nssm(verb, name)
  const r = await awaitStatus(name, verb === 'stop' ? 'SERVICE_STOPPED' : 'SERVICE_RUNNING')
  if (r.ok) return { ok: true, text: verb === 'stop' ? 'stopped' : 'started' }
  return { ok: false, text: `${verb} failed (status: ${r.status || 'unknown'})` }
}

// ── Log rotation: datestamp on restart, archived into <dir>\YYYY-MM ────────────

function pad2(n) { return String(n).padStart(2, '0') }
function monthDirName(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }
function datestamp(d) {
  return `${monthDirName(d)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
}

// chat.log lives wherever that profile's gamemode writes it
function chatLogDir(profile = LIVE) { return profile.logDir }

const GAME_LOG_FILES = ['chat.log', 'admin.log', 'pvp.log', 'pk.log', 'trading.log', 'bounty.log', 'writing.log']
// The backend opens these per write, so they can be archived while it runs
const AUDIT_LOG_FILES = ['ban.log', 'faction.log']

// nssm stdout/stderr files plus, for a game server, its gamemode logs and (live only) the backend audit logs
async function serviceLogFiles(svc) {
  const name = await serviceName(svc)
  const files = []
  for (const stream of ['AppStdout', 'AppStderr']) {
    const p = parseNssmPath(await nssm('get', name, stream))
    if (p) files.push(p)
  }
  files.push(...(svc.logFiles || []))
  const profile = profileOf(svc)
  if (profile && svc.key === profile.services.game) {
    for (const f of GAME_LOG_FILES) {
      files.push(path.join(chatLogDir(profile), f))
    }
    if (profile === LIVE) for (const f of AUDIT_LOG_FILES) files.push(path.join(config.auditLogDir, f))
  }
  return files
}

// Rename the active log with a datestamp and file it under <dir>\YYYY-MM
// (month taken from the file's last write, so a December log lands in December).
function archiveLogFile(file, profileKey) {
  let stat
  try { stat = fs.statSync(file) } catch { return }
  if (!stat.isFile() || stat.size === 0) return
  const ext = path.extname(file) || '.log'
  const base = path.basename(file, ext)
  const monthDir = path.join(path.dirname(file), monthDirName(stat.mtime))
  try {
    fs.mkdirSync(monthDir, { recursive: true })
    fs.renameSync(file, path.join(monthDir, `${base}-${datestamp(stat.mtime)}${ext}`))
    hooks.onRotated(file) // fresh file: restart the tail from the top
  } catch (err) {
    hooks.status(`log rotation skipped for ${file}: ${err.message}`, profileKey)
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

// The game's own log, and nssm's size-rotated pieces of it, add their sessions to the hours played first
async function countPlaytime(file) {
  const dir = path.dirname(file)
  const ext = path.extname(file) || '.log'
  const base = path.basename(file, ext)
  let pieces = []
  try { pieces = fs.readdirSync(dir).filter(e => e.startsWith(base + '-') && e.endsWith(ext) && /^\d/.test(e.slice(base.length + 1))) } catch {}
  for (const f of [...pieces.map(e => path.join(dir, e)), file]) {
    try { await playtime.addFromLog(f, readServerSettings()) }
    catch (err) { hooks.status(`hours played not counted from ${f}: ${err.message}`, LIVE.key) }
  }
}

// Hours played count only for the live game
async function rotateServiceLogs(svc) {
  const files = await serviceLogFiles(svc)
  const profileKey = profileOf(svc)?.key
  if (svc.key === LIVE.services.game && files[0]) await countPlaytime(files[0])
  for (const file of files) {
    sweepRotatedLogs(file)
    archiveLogFile(file, profileKey)
  }
}

async function statusAll() {
  const pairs = await Promise.all(config.services.map(async s => [s.key, (await probeService(s)).status]))
  return Object.fromEntries(pairs)
}

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

// A scheduled start, stop or restart of a profile's game under the shared busy lock; busy is set when another task holds it
async function lockedServiceAction(source, profile, verb) {
  let lock
  try { lock = managerLock.acquire({ source, kind: `scheduled ${verb} (${profile.label})`, actor: 'schedule' }) }
  catch (err) { return { ok: false, error: `cannot take the build lock: ${err.message}` } }
  if (!lock.ok) return { ok: false, busy: true, error: `another task is running: ${managerLock.describe(lock.holder)}` }
  try {
    const r = await doServiceAction(profile.services.game, verb)
    return r.ok ? { ok: true } : { ok: false, error: (r.steps || []).join('; ') || r.error || `${verb} failed` }
  } finally { lock.release() }
}

// Act on every service in order (stop order reversed), or only on one group's services.
// A service that is not installed is skipped, so a missing test profile never fails the live ones.
async function doServicesAction(action, group) {
  if (group && !config.groups.some(g => g.key === group)) return { ok: false, error: `unknown group ${group}` }
  const list = config.services.filter(s => !group || s.group === group)
  const status = await statusAll()
  const steps = []
  let ok = true
  const step = async (s, verb) => {
    if (!/^SERVICE_/.test(status[s.key] || '')) { steps.push(`${s.label}: not installed, skipped`); return }
    const r = await act(s, verb); ok = ok && r.ok; steps.push(`${s.label}: ${r.text}`)
  }
  const doStop  = async () => { for (const s of [...list].reverse()) await step(s, 'stop') }
  const doStart = async () => { for (const s of list)                await step(s, 'start') }
  if (action === 'stop') await doStop()
  else if (action === 'start') await doStart()
  else if (action === 'restart') { await doStop(); await doStart() }
  else return { ok: false, error: `unknown action ${action}` }
  return { ok, steps, status: await statusAll() }
}

function parseNssmPath(s) {
  const p = String(s || '').replace(/\u0000/g, '').trim().replace(/^"|"$/g, '')
  return p && !/^reset|^\(|unknown|service/i.test(p) ? p : ''
}

// [{ file, label, service }] for the logs that exist right now
async function discoverLogTargets() {
  const targets = []
  const seen = new Set()
  const add = (file, label, service) => {
    if (file && !seen.has(file)) { seen.add(file); targets.push({ file, label, service }) }
  }
  for (const s of config.services) {
    const name = await serviceName(s)
    for (const stream of ['AppStdout', 'AppStderr']) {
      const p = parseNssmPath(await nssm('get', name, stream))
      add(p, `${s.label}${stream === 'AppStderr' ? ' (err)' : ''}`, s.key)
    }
    for (const f of s.logFiles || []) add(f, s.label, s.key)
  }
  // Fallbacks
  const fallbacks = [
    [config.logDir, 'gameserver.log', 'Game', 'game'], [config.logDir, 'gameserver-err.log', 'Game (err)', 'game'],
    [config.logDir, 'backend.log', 'Backend', 'backend'], [config.logDir, 'backend-err.log', 'Backend (err)', 'backend'],
    [config.profiles.test.logDir, 'gameserver.log', 'Game', 'test-game'], [config.profiles.test.logDir, 'gameserver-err.log', 'Game (err)', 'test-game'],
  ]
  for (const [dir, name, label, key] of fallbacks) add(path.join(dir, name), label, key)
  for (const f of ['error.log', 'access.log']) add(path.join('C:\\nginx', 'logs', f), `Nginx (${f.replace('.log', '')})`, 'nginx')
  // Keep only the files that actually exist right now (re-checked on each refresh).
  return targets.filter(t => { try { return fs.statSync(t.file).isFile() } catch { return false } })
}

// A running game server re-upserts every loaded form, so database writes need it stopped; a dry run only warns
async function requireGameStopped(log, dryRun, profile = LIVE) {
  const status = await gameStatus(profile)
  const error = status === 'SERVICE_STOPPED' ? nativeModuleLocked(profile) : `the ${profile.label} game is ${status || 'in an unknown state'}, stop it first`
  if (!error) return null
  if (dryRun) { log(`WARNING: ${error} (a dry run needs no stop)`); return null }
  return { ok: false, error }
}

module.exports = {
  hooks,
  serviceByKey,
  resolvedNames,
  serviceName,
  profileOf,
  dataPaths,
  gameStatus,
  readServerSettings,
  purgePending,
  chatLogDir,
  GAME_LOG_FILES,
  statusAll,
  doServiceAction,
  doServicesAction,
  lockedServiceAction,
  discoverLogTargets,
  requireGameStopped,
}
