'use strict'

// Moves a test server build to the live one: pure functions over explicit paths, no config reads, so tools/test-migrate.js runs them in temp dirs

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { isDeepStrictEqual } = require('util')

// Copied from the test server dir when present; a directory replaces the live one wholesale
const SERVER_ITEMS = ['dist_back', 'scam_native.node', 'gamemode.js', 'gamemode_extensions', 'plugins', 'data/scripts', 'NPC-Spawns.json', 'weather-regions.json', 'Jobs.json', 'faction-access.json', 'alert-keywords.json']

// Live identity, runtime, debug-only and feature switch keys the settings merge never overwrites
const PROTECTED_SETTINGS = ['name', 'port', 'maxPlayers', 'playerSlots', 'queueGraceMs', 'queueStaffBypass', 'masterKey', 'masterApiAuthToken', 'master', 'offlineMode', 'databaseDriver', 'databaseName', 'databaseUri', 'dataDir', 'loadOrder', 'archives', 'logDir', 'listenHost', 'uiListenHost', 'ip', 'voiceChat', 'access', 'adminRoleIds', 'adminRoles', 'adminProfileIds', 'discordAuth', 'metricsAuth', 'securityAlertChannelId', 'dailyRestartAt', 'enableConsoleCommandsForAll', 'isPapyrusHotReloadEnabled', 'gamemodeHotReload', 'npcCorpseWatch', 'combatTrace',
  // Test-only features the owner copies to live by hand once signed off
  'alduinakDamageFormulaSettings', 'survivalEnabled', 'masterySlots', 'healthRegenerationMultiplier',
  // Authority checks enforced on test stay log-only on live until the owner switches them there
  'enforceMovementSpeed', 'enforceActivateDistance', 'enforceMeleeReach', 'enforceShotDistance', 'enforceSpellHitWindow']
// Synced by Migrate client from the manifest, so its diff records the plugin shifts the MongoDB purge needs
const MANIFEST_SETTINGS = ['loadOrder', 'archives']

// Client key files left out of the backup: the CEF runtime is huge and never changes between builds
const BACKUP_SKIP = ['Platform/Distribution/RuntimeDependencies/libcef.dll', 'Platform/Distribution/RuntimeDependencies/SkyrimPlatformCEF.exe.hidden']

const noop = () => {}
const exists = p => fs.existsSync(p)
const fwd = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
const lower = s => String(s).toLowerCase()
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// YYYYMMDD-HHMMSS, the backup folder name
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// JSON of a value for log lines, cut at 80 characters
function short(v) {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 80 ? s.slice(0, 77) + '...' : s
}

// Every file under dir as a forward-slash path relative to it
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

// Windows refuses to overwrite or delete a read-only file
function writable(p) {
  try { fs.chmodSync(p, 0o666) } catch {}
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (exists(to)) writable(to)
  fs.copyFileSync(from, to)
  const { atime, mtime } = fs.statSync(from)
  fs.utimesSync(to, atime, mtime)
}

// Copies a file or a whole directory; a directory at the destination is replaced
function copyItem(from, to) {
  if (fs.statSync(from).isDirectory()) {
    fs.rmSync(to, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true })
  } else copyFile(from, to)
}

// ── Server ───────────────────────────────────────────────────────────────────

// The items present in from replace their counterparts in to; each old one is copied to backupDir/<item> first
function copyServerItems({ from, to, backupDir, items = SERVER_ITEMS, log = noop }) {
  const copied = [], backedUp = []
  for (const item of items) {
    const src = path.join(from, item)
    const dest = path.join(to, item)
    if (!exists(src)) { log(`skip ${item}: not in ${from}`); continue }
    let note = ''
    if (exists(dest)) { copyItem(dest, path.join(backupDir, item)); backedUp.push(item); note = ', old copy backed up' }
    copyItem(src, dest)
    copied.push(item)
    log(`copied ${item}${note}`)
  }
  return { copied, backedUp }
}

// ── Settings ─────────────────────────────────────────────────────────────────

// "<fromDir>/x.esp" -> "<toDir>/x.esp", compared with forward slashes and no case; entries outside fromDir stay as they are
function swapPrefix(entry, fromDir, toDir) {
  const e = fwd(entry)
  const f = fwd(fromDir)
  return f && lower(e).startsWith(lower(f) + '/') ? `${fwd(toDir)}${e.slice(f.length)}` : e
}

// live takes every non-protected test key (unchanged ones untouched, live-only keys kept); loadOrder and archives stay
function mergeSettings({ live, test, protectedKeys = PROTECTED_SETTINGS, log = noop }) {
  const merged = { ...live }
  const added = [], changed = [], kept = []
  const prot = new Set(protectedKeys)
  for (const key of Object.keys(test)) {
    if (MANIFEST_SETTINGS.includes(key)) continue
    const same = key in live && isDeepStrictEqual(live[key], test[key])
    if (prot.has(key)) {
      if (!same) { kept.push(key); log(`kept ${key} (protected)`) }
      continue
    }
    if (same) continue
    if (key in live) { changed.push(key); log(`changed ${key}: ${short(live[key])} -> ${short(test[key])}`) }
    else { added.push(key); log(`added ${key}`) }
    merged[key] = test[key]
  }
  if (MANIFEST_SETTINGS.some(k => k in test)) log('loadOrder and archives left as they are: Migrate client syncs them from the manifest')
  return { merged, added, changed, kept }
}

// ── Client ───────────────────────────────────────────────────────────────────

// Big files (the CEF runtime) go by size and time stamp, the rest by content
const HASH_LIMIT = 8 * 1024 * 1024

function sameFile(a, b) {
  let sa, sb
  try { sa = fs.statSync(a); sb = fs.statSync(b) } catch { return false }
  if (sa.size !== sb.size || Math.abs(sa.mtimeMs - sb.mtimeMs) >= 2000) return false
  return sa.size > HASH_LIMIT || sha256File(a) === sha256File(b)
}

function pruneEmptyDirs(dir, root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), root)
  if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
}

// Makes `to` an exact copy of `from`: new and changed files copied, files `from` lacks deleted, emptied folders removed
function mirrorDir({ from, to, log = noop }) {
  const src = walk(from)
  const srcKeys = new Set(src.map(lower))
  const result = { copied: 0, deleted: 0, unchanged: 0 }
  for (const rel of src) {
    const a = path.join(from, rel)
    const b = path.join(to, rel)
    if (sameFile(a, b)) { result.unchanged++; continue }
    copyFile(a, b)
    result.copied++
  }
  for (const rel of exists(to) ? walk(to) : []) {
    if (srcKeys.has(lower(rel))) continue
    const file = path.join(to, rel)
    writable(file)
    fs.rmSync(file, { force: true })
    result.deleted++
    log(`deleted ${rel}`)
  }
  if (exists(to)) pruneEmptyDirs(to, to)
  return result
}

// Copies the live client's key files (Data-relative) into backupDir before the mirror replaces them
function backupClientKeyFiles({ clientDir, keyFiles, backupDir, skip = BACKUP_SKIP, log = noop }) {
  const skipped = new Set(skip.map(lower))
  const backedUp = []
  for (const rel of keyFiles) {
    if (skipped.has(lower(rel))) continue
    const file = path.join(clientDir, 'Data', rel)
    if (!exists(file)) continue
    copyFile(file, path.join(backupDir, 'Data', rel))
    backedUp.push(rel)
    log(`backed up ${rel}`)
  }
  return backedUp
}

// ── Manifest ─────────────────────────────────────────────────────────────────

// Extras archive URLs of a manifest text moved from one served folder (/files/<dir>/) to another
function rewriteExtrasUrls(text, fromDir, toDir) {
  return String(text).replace(new RegExp(`/files/${escapeRe(fromDir)}/`, 'g'), `/files/${toDir}/`)
}

// The archive names a manifest text references under /files/<dir>/
function extrasArchives(text, dir) {
  const names = new Set()
  const re = new RegExp(`/files/${escapeRe(dir)}/([^"'\\s]+)`, 'g')
  for (const m of String(text).matchAll(re)) names.add(decodeURIComponent(m[1]))
  return [...names]
}

// Copies the named archives between the served folders, skipping ones already identical
function copyExtras({ names, from, to, log = noop }) {
  const copied = [], skipped = [], missing = []
  for (const name of names) {
    const src = path.join(from, name)
    const dest = path.join(to, name)
    if (!exists(src)) { missing.push(name); log(`MISSING ${name} in ${from}`); continue }
    if (exists(dest) && fs.statSync(src).size === fs.statSync(dest).size && sha256File(src) === sha256File(dest)) { skipped.push(name); log(`${name} already in ${to}`); continue }
    copyFile(src, dest)
    copied.push(name)
    log(`copied ${name} -> ${to}`)
  }
  return { copied, skipped, missing }
}

module.exports = {
  SERVER_ITEMS, PROTECTED_SETTINGS, MANIFEST_SETTINGS, BACKUP_SKIP,
  stamp, short, walk, copyItem,
  copyServerItems, swapPrefix, mergeSettings,
  mirrorDir, backupClientKeyFiles,
  rewriteExtrasUrls, extrasArchives, copyExtras,
}
