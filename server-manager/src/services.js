'use strict'

// nssm service control, log rotation and log discovery, shared by the Electron manager and the AlduinakManager agent

const path = require('path')
const fs   = require('fs')
const config = require('./config')
const modsync = require('./modsync')
const { nssm, nativeModuleLocked } = require('./serviceCheck')

// Host callbacks: onRotated(file) after a log is archived, status(text) for warnings
const hooks = { onRotated: () => {}, status: () => {} }

const serviceByKey = Object.fromEntries(config.services.map(s => [s.key, s]))

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

async function gameStatus() { return nssm('status', await serviceName(serviceByKey.game)) }

// Lenient read for the players and log tabs: {} when the file is missing or invalid
function readServerSettings() {
  try { return modsync.readSettingsFile(config.paths.serverSettings).settings } catch { return {} }
}

// Until the purge ran, the database still holds ids encoded under the old load order
function purgePending() {
  let diff = null
  try { diff = modsync.readDiff() } catch {}
  if (!modsync.purgePending(diff)) return null
  return 'refused: a MongoDB purge is pending for the new load order, run Purge MongoDB (or Restore last purge) first'
}

async function act(svc, verb) {
  if (svc.key === 'game' && verb === 'start') {
    const pending = purgePending()
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

// chat.log lives wherever the gamemode writes it; mirror its resolution chain
// (env var, then the optional logDir key in server-settings.json, then default).
function chatLogDir() {
  return process.env.ALDUINAK_LOG_DIR || readServerSettings().logDir || 'C:\\logs'
}

const GAME_LOG_FILES = ['chat.log', 'admin.log', 'pvp.log', 'trading.log', 'bounty.log', 'writing.log']

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
    for (const f of GAME_LOG_FILES) {
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
    hooks.onRotated(file) // fresh file: restart the tail from the top
  } catch (err) {
    hooks.status(`log rotation skipped for ${file}: ${err.message}`)
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

function parseNssmPath(s) {
  const p = String(s || '').replace(/\u0000/g, '').trim().replace(/^"|"$/g, '')
  return p && !/^reset|^\(|unknown|service/i.test(p) ? p : ''
}

// [{ file, label }] for the logs that exist right now
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
  return targets.filter(t => { try { return fs.statSync(t.file).isFile() } catch { return false } })
}

// A running game server re-upserts every loaded form, so database writes need it stopped; a dry run only warns
async function requireGameStopped(log, dryRun) {
  const status = await gameStatus()
  const error = status === 'SERVICE_STOPPED' ? nativeModuleLocked() : `the game server is ${status || 'in an unknown state'}, stop it first`
  if (!error) return null
  if (dryRun) { log(`WARNING: ${error} (a dry run needs no stop)`); return null }
  return { ok: false, error }
}

module.exports = {
  hooks,
  serviceByKey,
  resolvedNames,
  serviceName,
  gameStatus,
  readServerSettings,
  purgePending,
  chatLogDir,
  GAME_LOG_FILES,
  statusAll,
  doServiceAction,
  doServicesAction,
  discoverLogTargets,
  requireGameStopped,
}
