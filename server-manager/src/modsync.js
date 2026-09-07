'use strict'

// Keeps the live game server in step with the compiled MO2 manifest: diffs builds, rewrites the settings loadOrder, mirrors MO2 mods into Data

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const config = require('./config')
const formIds = require('./formIds')

const VANILLA_PLUGINS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']
const VANILLA_SET = new Set(VANILLA_PLUGINS.map(n => n.toLowerCase()))
// Plugins and archives are removed when the manifest drops them even if edited on disk
const PLUGIN_OR_ARCHIVE_RE = /\.(esp|esm|esl|bsa)$/i
// Files above this size are compared by size only
const HASH_LIMIT = 64 * 1024 * 1024
// TES4 header flag the server treats as "light" (libespm Combiner.cpp)
const TES4_LIGHT_FLAG = 0x200
// Files in Data the game server writes itself
const RESERVED = new Set(['manifest.json'])

const paths = {
  manifest:     path.join(config.paths.dataDir, 'install-manifest.json'),
  prevManifest: path.join(config.paths.dataDir, 'install-manifest.json.prev'),
  diff:         path.join(config.paths.dataDir, 'manifest-diff.json'),
  stamp:        path.join(config.paths.dataDir, 'data-sync.json'),
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const lower = s => String(s).toLowerCase()
const fileKey = to => lower(to).replace(/\\/g, '/')
const yieldLoop = () => new Promise(r => setImmediate(r))

function basename(p) { return String(p).split(/[\\/]/).pop() }

// Windows caps paths at MAX_PATH unless prefixed with \\?\ (hair meshes exceed it)
function longPath(p) {
  if (process.platform !== 'win32') return p
  const abs = path.resolve(p)
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(longPath(p), { highWaterMark: 1 << 20 })
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function lineLogger(log) {
  const fn = typeof log === 'function' ? log : () => {}
  return text => fn(text.endsWith('\n') ? text : text + '\n')
}

function statFile(p) {
  try { const st = fs.statSync(longPath(p)); return st.isFile() ? st : null } catch { return null }
}

function isDir(p) {
  try { return fs.statSync(longPath(p)).isDirectory() } catch { return false }
}

function sameSequence(a, b) {
  return a.length === b.length && a.every((v, i) => lower(v) === lower(b[i]))
}

function uniqueNames(names) {
  const seen = new Set()
  return names.filter(n => n && !seen.has(lower(n)) && seen.add(lower(n)))
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// server-settings.json is BOM-free 2-space JSON; the previous copy is kept as .prev
function writeSettingsFile(settingsPath, obj) {
  const prevCopy = settingsPath + '.prev'
  const existed = Boolean(statFile(settingsPath))
  if (existed) fs.copyFileSync(settingsPath, prevCopy)
  writeJsonAtomic(settingsPath, obj)
  return { prevCopy: existed ? prevCopy : null }
}

function readSettingsFile(settingsPath) {
  const st = fs.statSync(settingsPath)
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''))
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('server-settings.json is not a JSON object')
  return { settings, mtimeMs: st.mtimeMs }
}

// A manifest 'to' is only ever written below Data: no drive, no root, no '..'
function safeRel(to) {
  const s = String(to || '')
  if (!s || /^[A-Za-z]:/.test(s) || /^[\\/]/.test(s)) return null
  const parts = s.split(/[\\/]/)
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null
  return parts.join(path.sep)
}

function safeName(name) {
  const s = String(name || '')
  return Boolean(s) && s !== '.' && s !== '..' && !/[\\/]/.test(s)
}

function clearReadOnly(p) {
  try { fs.chmodSync(longPath(p), 0o666) } catch {}
}

// Windows refuses to delete read-only files even with force:true
function removeFile(file) {
  const p = longPath(file)
  try { fs.rmSync(p, { force: true }); return }
  catch (err) { if (process.platform !== 'win32') throw err }
  clearReadOnly(file)
  fs.rmSync(p, { force: true, maxRetries: 5, retryDelay: 200 })
}

// Remove directories left empty below root, walking up from dir and never touching root itself
function pruneEmptyDirs(dir, root) {
  const stop = lower(path.resolve(root))
  let cur = path.resolve(dir)
  while (lower(cur) !== stop && lower(cur).startsWith(stop + path.sep)) {
    let entries
    try { entries = fs.readdirSync(longPath(cur)) } catch { return }
    if (entries.length) return
    try { fs.rmdirSync(longPath(cur)) } catch { return }
    cur = path.dirname(cur)
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

// Inline blobs are blanked before parsing so a base64-heavy manifest stays cheap to hold
function readManifestLight(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
  let m
  try { m = JSON.parse(text.replace(/"inline":"[A-Za-z0-9+\/=]*"/g, '"inline":""')) }
  catch (err) { throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`) }
  text = null
  return {
    builtAt: m.builtAt || null,
    order:   Array.isArray(m.order) ? m.order : [],
    plugins: Array.isArray(m.plugins) ? m.plugins : [],
    mods: (Array.isArray(m.mods) ? m.mods : []).map(mod => ({
      name: mod.name,
      hash: mod.hash || '',
      files: (Array.isArray(mod.files) ? mod.files : []).map(f => ({
        to: f.to, sha256: f.sha256 || '', size: f.size || 0, inline: f.inline != null,
      })),
    })),
  }
}

function enabledPlugins(manifest) {
  return ((manifest && manifest.plugins) || [])
    .map(l => String(l).trim())
    .filter(l => l.startsWith('*'))
    .map(l => l.slice(1).trim())
    .filter(Boolean)
}

// First mod in mods[] (top of modlist.txt) wins a conflicting 'to'
function resolveExpected(manifest) {
  const out = new Map()
  for (const mod of (manifest && manifest.mods) || []) {
    for (const f of mod.files || []) {
      const key = fileKey(f.to)
      if (!out.has(key)) out.set(key, { to: f.to, mod: mod.name, sha256: lower(f.sha256 || ''), size: f.size || 0 })
    }
  }
  return out
}

// Enabled in plugins.txt while no mod in the manifest provides the file (a stale MO2 profile)
function unprovidedPlugins(manifest, expected = resolveExpected(manifest)) {
  return enabledPlugins(manifest).filter(n => !expected.has(fileKey(n)))
}

// ── Plugin flags ─────────────────────────────────────────────────────────────

// TES4 record header: bytes 0-3 magic, bytes 8-11 flags (uint32 LE); null when not a plugin
function readTes4Flags(file) {
  let fd
  try {
    fd = fs.openSync(longPath(file), 'r')
    const buf = Buffer.alloc(12)
    const n = fs.readSync(fd, buf, 0, 12, 0)
    if (n < 12 || buf.toString('latin1', 0, 4) !== 'TES4') return null
    return buf.readUInt32LE(8)
  } catch { return null }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

// light is the deployed copy (Data, else the previous diff, else MO2); lightNext is what manifests[0] will deploy (its MO2 winner, else Data, else light)
function readPluginFlags(names, { dataDir, mo2Root, manifests = [], previous = null, carry = false } = {}) {
  const modsDir = mo2Root ? path.join(mo2Root, 'mods') : null
  const expected = manifests.filter(Boolean).map(resolveExpected)
  const prevFlags = (previous && previous.pluginFlags) || {}
  const prevLower = new Map(Object.keys(prevFlags).map(k => [lower(k), prevFlags[k]]))
  let modDirs = null
  const listModDirs = () => {
    if (!modDirs) {
      try { modDirs = fs.readdirSync(modsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) }
      catch { modDirs = [] }
    }
    return modDirs
  }
  const probe = (file, from) => {
    const flags = readTes4Flags(file)
    return flags === null ? null : { light: (flags & TES4_LIGHT_FLAG) !== 0, from }
  }
  const fromData = name => (dataDir ? probe(path.join(dataDir, name), 'data') : null)
  const fromPrevious = name => {
    const p = prevFlags[name] || prevLower.get(lower(name))
    return p && typeof p.light === 'boolean' ? { light: p.light, from: 'previous' } : null
  }
  const fromWinner = (map, name) => {
    const hit = map && map.get(lower(name))
    return hit && modsDir && safeRel(hit.to) && safeName(hit.mod) ? probe(path.join(modsDir, hit.mod, safeRel(hit.to)), 'mo2') : null
  }
  const fromMo2 = name => {
    if (!modsDir) return null
    for (const map of expected) { const f = fromWinner(map, name); if (f) return f }
    if (!safeName(name)) return null
    for (const dir of listModDirs()) { const f = probe(path.join(modsDir, dir, name), 'mo2'); if (f) return f }
    return null
  }

  const out = {}
  for (const name of names) {
    const data = fromData(name)
    const deployed = (carry && fromPrevious(name)) || data || fromPrevious(name) || fromMo2(name) || { light: null, from: null }
    const next = fromWinner(expected[0], name) || data || deployed
    out[name] = { light: deployed.light, from: deployed.from, lightNext: next.light, fromNext: next.from }
  }
  return out
}

// ── Diff ─────────────────────────────────────────────────────────────────────

function diffFileLists(prevFiles, nextFiles) {
  const a = new Map(prevFiles.map(f => [fileKey(f.to), lower(f.sha256 || '')]))
  const b = new Map(nextFiles.map(f => [fileKey(f.to), lower(f.sha256 || '')]))
  let filesAdded = 0, filesRemoved = 0, filesChanged = 0
  for (const [k, sha] of b) {
    if (!a.has(k)) filesAdded++
    else if (a.get(k) !== sha) filesChanged++
  }
  for (const k of a.keys()) if (!b.has(k)) filesRemoved++
  return { filesAdded, filesRemoved, filesChanged }
}

function computeDiff({ prev = null, next, settings = {}, previousDiff = null, dataDir, mo2Root, profileDir } = {}) {
  if (!next || !Array.isArray(next.mods)) throw new Error('computeDiff needs the current manifest')
  settings = settings || {}
  dataDir = dataDir || settings.dataDir || ''
  mo2Root = mo2Root || config.mo2Root
  profileDir = profileDir || path.join(mo2Root, 'profiles', config.profile)

  const prevMods = new Map((prev ? prev.mods : []).map(m => [m.name, m]))
  const nextMods = new Map(next.mods.map(m => [m.name, m]))
  const mods = { added: [], removed: [], changed: [] }
  for (const name of nextMods.keys()) if (!prevMods.has(name)) mods.added.push(name)
  for (const name of prevMods.keys()) if (!nextMods.has(name)) mods.removed.push(name)
  for (const [name, b] of nextMods) {
    const a = prevMods.get(name)
    if (!a || (a.hash && b.hash && a.hash === b.hash)) continue
    const d = diffFileLists(a.files, b.files)
    if ((a.hash && b.hash) || d.filesAdded || d.filesRemoved || d.filesChanged) mods.changed.push({ name, ...d })
  }

  const prevEnabled = prev ? enabledPlugins(prev) : []
  const nextEnabled = enabledPlugins(next)
  const prevSet = new Set(prevEnabled.map(lower))
  const nextSet = new Set(nextEnabled.map(lower))
  const plugins = {
    prev: prevEnabled,
    next: nextEnabled,
    added: nextEnabled.filter(n => !prevSet.has(lower(n))),
    removed: prevEnabled.filter(n => !nextSet.has(lower(n))),
    reordered: !sameSequence(prevEnabled.filter(n => nextSet.has(lower(n))), nextEnabled.filter(n => prevSet.has(lower(n)))),
  }

  const prevExp = prev ? resolveExpected(prev) : new Map()
  const nextExp = resolveExpected(next)
  const files = { added: 0, removed: 0, changed: 0, addedList: [], removedList: [], changedList: [] }
  for (const [k, f] of nextExp) {
    const p = prevExp.get(k)
    if (!p) files.addedList.push({ to: f.to, mod: f.mod })
    else if (p.sha256 !== f.sha256) files.changedList.push({ to: f.to, mod: f.mod })
  }
  for (const [k, p] of prevExp) if (!nextExp.has(k)) files.removedList.push({ to: p.to, mod: p.mod })
  files.added = files.addedList.length
  files.removed = files.removedList.length
  files.changed = files.changedList.length

  const warnings = []
  const unprovided = unprovidedPlugins(next, nextExp)
  if (unprovided.length) warnings.push(`enabled in plugins.txt but provided by no mod in the manifest: ${unprovided.join(', ')}; fix the MO2 profile and rebuild the manifest`)

  // A previous diff that still needs its purge owns the load order the database was written under
  const carry = Boolean(previousDiff && !previousDiff.purgedAt && previousDiff.purgeNeeded && Array.isArray(previousDiff.settingsLoadOrder) && previousDiff.settingsLoadOrder.length)
  const currentOrder = Array.isArray(settings.loadOrder) ? settings.loadOrder.map(basename) : []
  const settingsLoadOrder = carry ? previousDiff.settingsLoadOrder.slice() : currentOrder
  const settingsLoadOrderFrom = carry ? (previousDiff.settingsLoadOrderFrom || previousDiff.builtAt || null) : (next.builtAt || null)
  if (carry && previousDiff.syncedSettingsAt) warnings.push('server settings were synced before the MongoDB purge ran; if the game server was restarted in between, restore the last purge backup or expect inconsistent ids')

  const newOrder = uniqueNames([...VANILLA_PLUGINS, ...nextEnabled])
  const newSet = new Set(newOrder.map(lower))
  const names = uniqueNames([...settingsLoadOrder, ...newOrder, ...prevEnabled])
  const pluginFlags = readPluginFlags(names, { dataDir, mo2Root, manifests: [next, prev].filter(Boolean), previous: previousDiff, carry })
  const surviving = settingsLoadOrder.filter(n => newSet.has(lower(n)))
  const removedFromOrder = settingsLoadOrder.filter(n => !newSet.has(lower(n)))
  const flagChanges = surviving.filter(n => typeof pluginFlags[n].light === 'boolean' && typeof pluginFlags[n].lightNext === 'boolean' && pluginFlags[n].light !== pluginFlags[n].lightNext)
  const unknown = uniqueNames([
    ...settingsLoadOrder.filter(n => typeof pluginFlags[n].light !== 'boolean'),
    ...newOrder.filter(n => typeof pluginFlags[n].lightNext !== 'boolean'),
  ])
  let shiftedPlugins = []
  if (unknown.length) warnings.push(`light flag unknown for ${unknown.join(', ')}: the MongoDB purge will refuse until the plugin file can be read`)
  else {
    try { shiftedPlugins = formIds.shiftedBetween(settingsLoadOrder, formIds.flagsOf(pluginFlags, 'light'), newOrder, formIds.flagsOf(pluginFlags, 'lightNext')) }
    catch (err) { warnings.push(`shifted plugins not computed: ${err.message}`) }
  }
  const purgeNeeded = plugins.removed.length > 0 || removedFromOrder.length > 0 || shiftedPlugins.length > 0 || flagChanges.length > 0 || unknown.length > 0

  return {
    builtAt: next.builtAt || null,
    prevBuiltAt: prev ? prev.builtAt || null : null,
    manifestPath: paths.manifest,
    profileDir,
    mods, plugins, files,
    settingsLoadOrder, settingsLoadOrderFrom,
    pluginFlags, flagChanges, shiftedPlugins, removedFromOrder, purgeNeeded, warnings,
    syncedSettingsAt: null,
    syncedDataAt: null,
    purgeStartedAt: null,
    purgeBackup: null,
    purgedAt: null,
  }
}

function writeDiff(diff) {
  writeJsonAtomic(paths.diff, diff)
  return diff
}

function readDiff() {
  let text
  try { text = fs.readFileSync(paths.diff, 'utf8') }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
  try { return JSON.parse(text) }
  catch (err) { throw new Error(`manifest-diff.json is not valid JSON: ${err.message}`) }
}

function updateDiff(patch) {
  const diff = readDiff()
  if (!diff) throw new Error('no manifest-diff.json to update, compute a diff first')
  Object.assign(diff, patch)
  return writeDiff(diff)
}

// ".prev" always means the last manifest whose files reached the Data folder
function shouldRotatePrev(previousDiff) {
  return !previousDiff || Boolean(previousDiff.syncedDataAt)
}

// ── Server settings ──────────────────────────────────────────────────────────

function syncSettings({ manifest, settingsPath = config.paths.serverSettings, log, dryRun = false } = {}) {
  const line = lineLogger(log)
  const fail = error => ({ ok: false, error, changed: false, added: [], removed: [], reordered: false, loadOrder: [] })
  let settings
  try { ({ settings } = readSettingsFile(settingsPath)) }
  catch (err) {
    if (err instanceof SyntaxError) return fail(`server-settings.json is not valid JSON, refusing to write it: ${err.message}`)
    return fail(err.code ? `cannot read ${settingsPath}: ${err.message}` : err.message)
  }
  if (!settings.dataDir) return fail('server-settings.json has no dataDir')
  const enabled = enabledPlugins(manifest)
  if (!enabled.length) return fail('the manifest lists no enabled plugins, refusing to empty the loadOrder')

  const dataDir = String(settings.dataDir).replace(/\\/g, '/').replace(/\/+$/, '')
  const target = [...VANILLA_PLUGINS, ...enabled]
  const loadOrder = target.map(n => `${dataDir}/${n}`)
  const currentNames = (Array.isArray(settings.loadOrder) ? settings.loadOrder : []).map(basename)
  const curSet = new Set(currentNames.map(lower))
  const tgtSet = new Set(target.map(lower))
  const added = target.filter(n => !curSet.has(lower(n)))
  const removed = currentNames.filter(n => !tgtSet.has(lower(n)))
  const reordered = !sameSequence(currentNames.filter(n => tgtSet.has(lower(n))), target.filter(n => curSet.has(lower(n))))
  const changed = added.length > 0 || removed.length > 0 || reordered
  const result = { ok: true, changed, added, removed, reordered, loadOrder }

  if (!changed) {
    line(`[settings] loadOrder already in sync with the manifest (${target.length} plugins)`)
    return result
  }
  line(`[settings] loadOrder: ${currentNames.length} -> ${target.length} plugins (${added.length} added, ${removed.length} removed${reordered ? ', order changed' : ''})`)
  for (const n of removed) line(`[settings] - ${n}`)
  for (const n of added) line(`[settings] + ${n}`)
  for (const n of added) {
    if (!statFile(path.join(settings.dataDir, n))) line(`[settings] WARNING: ${n} is not in ${settings.dataDir} yet, run Sync Data before restarting the game server`)
  }
  for (const n of unprovidedPlugins(manifest)) {
    line(`[settings] WARNING: ${n} is enabled in plugins.txt but no mod in the manifest provides it, fix the MO2 profile and rebuild the manifest`)
  }
  if (dryRun) {
    line('[settings] dry run: server-settings.json not written')
    return result
  }

  settings.loadOrder = loadOrder
  const { prevCopy } = writeSettingsFile(settingsPath, settings)
  line(`[settings] wrote ${basename(settingsPath)} (${loadOrder.length} plugins), previous copy at ${basename(prevCopy)}`)
  line('[settings] restart the game server to load the new order; players must re-run the launcher')
  return result
}

// ── Data folder ──────────────────────────────────────────────────────────────

// '' when the file on disk still matches the recorded manifest entry, else why not
async function modifiedReason(file, st, rec) {
  if (typeof rec.size === 'number' && st.size !== rec.size) return 'size differs'
  if (!rec.sha256) return 'no recorded hash'
  if (st.size > HASH_LIMIT) return ''
  return (await sha256File(file)) === rec.sha256 ? '' : 'sha256 differs'
}

async function destUpToDate(dest, f) {
  const st = statFile(dest)
  if (!st || st.size !== f.size) return false
  if (f.size > HASH_LIMIT || !f.sha256) return true
  return (await sha256File(dest)) === f.sha256
}

// Copy through a temp file so a failed copy never leaves a half-written Data file
async function copyVerified({ src, dest, sha256, size }) {
  fs.mkdirSync(longPath(path.dirname(dest)), { recursive: true })
  const tmp = dest + '.modsync-tmp'
  try {
    fs.copyFileSync(longPath(src), longPath(tmp))
    if (sha256 && size <= HASH_LIMIT && (await sha256File(tmp)) !== sha256) {
      throw new Error('sha256 mismatch after copy, the MO2 file differs from the manifest (rebuild the manifest)')
    }
    if (statFile(dest)) clearReadOnly(dest)
    fs.renameSync(longPath(tmp), longPath(dest))
  } catch (err) {
    try { removeFile(tmp) } catch {}
    throw err
  }
}

async function syncData({ manifest, prev = null, stamp = null, dataDir, mo2Root = config.mo2Root, log, dryRun = false } = {}) {
  const line = lineLogger(log)
  const fail = error => ({ ok: false, error, plan: null, applied: null, stamp })
  if (!manifest || !Array.isArray(manifest.mods)) return fail('no manifest loaded')
  if (!dataDir) return fail('server-settings.json has no dataDir')
  const dataRoot = path.resolve(String(dataDir))
  const modsDir = path.join(path.resolve(String(mo2Root)), 'mods')
  if (!isDir(dataRoot)) return fail(`Data folder not found: ${dataRoot}`)
  if (!isDir(modsDir)) return fail(`MO2 mods folder not found: ${modsDir}`)

  line(`[data] ${dryRun ? 'dry run' : 'sync'}: ${dataRoot} <- ${modsDir}`)
  const expectedNext = resolveExpected(manifest)
  const deployedBefore = new Map()
  if (prev) for (const [key, f] of resolveExpected(prev)) deployedBefore.set(key, f)
  for (const f of (stamp && Array.isArray(stamp.files) ? stamp.files : [])) {
    if (f && f.to) deployedBefore.set(fileKey(f.to), { to: f.to, mod: f.mod, sha256: lower(f.sha256 || ''), size: f.size })
  }
  line(`[data] manifest ${manifest.builtAt || '?'}: ${expectedNext.size} files expected, ${deployedBefore.size} known from the last deploy`)

  const plan = { deletes: [], copies: [], upToDate: 0, skipped: [], missingSources: [] }
  const deleteJobs = [], copyJobs = []
  const stillEnabled = new Set(enabledPlugins(manifest).map(lower))
  const upToDateKeys = new Set()
  let checked = 0
  const progress = async () => {
    if (++checked % 200 === 0) await yieldLoop()
    if (checked % 250 === 0) line(`[data] checked ${checked} files`)
  }

  for (const [key, rec] of deployedBefore) {
    if (expectedNext.has(key)) continue
    const rel = safeRel(rec.to)
    if (!rel) { plan.skipped.push({ to: rec.to, reason: 'unsafe path' }); continue }
    if (VANILLA_SET.has(lower(rel))) { plan.skipped.push({ to: rec.to, reason: 'vanilla master, never deleted' }); continue }
    if (RESERVED.has(lower(rel))) { plan.skipped.push({ to: rec.to, reason: 'written by the game server, never touched' }); continue }
    const file = path.join(dataRoot, rel)
    const st = statFile(file)
    if (!st) continue
    await progress()
    if (stillEnabled.has(lower(rel))) {
      line(`[data] WARNING: ${rec.to} is still enabled in plugins.txt but no mod provides it, kept so the server keeps booting; fix the MO2 profile and rebuild the manifest`)
      plan.skipped.push({ to: rec.to, reason: 'still enabled in plugins.txt, fix the MO2 profile and rebuild the manifest' })
      continue
    }
    const why = await modifiedReason(file, st, rec)
    if (!why) plan.deletes.push({ to: rec.to, reason: 'no longer in the manifest' })
    else if (PLUGIN_OR_ARCHIVE_RE.test(rel)) plan.deletes.push({ to: rec.to, reason: `no longer in the manifest, ${why} on disk but plugins and archives are removed anyway` })
    else { plan.skipped.push({ to: rec.to, reason: `no longer in the manifest but ${why} on disk, left in place` }); continue }
    deleteJobs.push({ to: rec.to, file })
  }

  for (const [key, f] of expectedNext) {
    const rel = safeRel(f.to)
    if (!rel) { plan.skipped.push({ to: f.to, reason: 'unsafe path' }); continue }
    if (!safeName(f.mod)) { plan.skipped.push({ to: f.to, reason: `unsafe mod name "${f.mod}"` }); continue }
    if (RESERVED.has(lower(rel))) { plan.skipped.push({ to: f.to, reason: 'written by the game server, never touched' }); continue }
    const src = path.join(modsDir, f.mod, rel)
    const dest = path.join(dataRoot, rel)
    await progress()
    const sst = statFile(src)
    if (!sst) { plan.missingSources.push({ to: f.to, mod: f.mod }); continue }
    if (sst.size !== f.size) { plan.skipped.push({ to: f.to, reason: `MO2 file size ${sst.size} differs from the manifest (${f.size}), rebuild the manifest` }); continue }
    if (await destUpToDate(dest, f)) { plan.upToDate++; upToDateKeys.add(key); continue }
    plan.copies.push({ to: f.to, mod: f.mod })
    copyJobs.push({ key, to: f.to, src, dest, sha256: f.sha256, size: f.size })
  }

  line(`[data] plan: ${plan.deletes.length} delete(s), ${plan.copies.length} copy(ies), ${plan.upToDate} up to date, ${plan.skipped.length} skipped, ${plan.missingSources.length} missing source(s)`)
  for (const d of plan.deletes) line(`[data] delete ${d.to} (${d.reason})`)
  for (const m of plan.missingSources) line(`[data] MISSING SOURCE ${m.to} (mod "${m.mod}")`)
  for (const s of plan.skipped) line(`[data] skip ${s.to}: ${s.reason}`)
  for (const c of plan.copies.slice(0, 100)) line(`[data] copy ${c.to} <- ${c.mod}`)
  if (plan.copies.length > 100) line(`[data] ... and ${plan.copies.length - 100} more copies (${plan.copies.length} total)`)
  if (dryRun) {
    line('[data] dry run: nothing touched')
    return { ok: true, plan, applied: null, stamp }
  }

  const applied = { copied: 0, deleted: 0, errors: [] }
  const touchedDirs = new Set()
  for (const job of deleteJobs) {
    try { removeFile(job.file); applied.deleted++; touchedDirs.add(path.dirname(job.file)) }
    catch (err) { applied.errors.push({ to: job.to, error: err.message }); line(`[data] ERROR deleting ${job.to}: ${err.message}`) }
  }
  for (const dir of touchedDirs) pruneEmptyDirs(dir, dataRoot)

  const copiedKeys = new Set()
  let n = 0
  for (const job of copyJobs) {
    try { await copyVerified(job); applied.copied++; copiedKeys.add(job.key) }
    catch (err) { applied.errors.push({ to: job.to, error: err.message }); line(`[data] ERROR copying ${job.to}: ${err.message}`) }
    if (++n % 250 === 0) line(`[data] copied ${n}/${copyJobs.length}`)
    if (n % 200 === 0) await yieldLoop()
  }

  const files = []
  for (const [key, f] of expectedNext) {
    if (upToDateKeys.has(key) || copiedKeys.has(key)) files.push({ to: f.to, sha256: f.sha256, size: f.size, mod: f.mod })
  }
  // Dropped files still on disk stay tracked so a later sync can delete them once nothing holds them back
  for (const [key, rec] of deployedBefore) {
    if (expectedNext.has(key)) continue
    const rel = safeRel(rec.to)
    if (!rel || VANILLA_SET.has(lower(rel)) || RESERVED.has(lower(rel)) || !statFile(path.join(dataRoot, rel))) continue
    files.push({ to: rec.to, sha256: rec.sha256, size: rec.size, mod: rec.mod })
  }
  const newStamp = { syncedAt: new Date().toISOString(), manifestBuiltAt: manifest.builtAt || null, files }
  writeJsonAtomic(paths.stamp, newStamp)

  line(`[data] done: ${applied.copied} copied, ${applied.deleted} deleted, ${plan.upToDate} already up to date, ${applied.errors.length} error(s), ${plan.missingSources.length} missing source(s)`)
  const problems = applied.errors.length + plan.missingSources.length
  return {
    ok: problems === 0,
    ...(problems ? { error: `${applied.errors.length} error(s), ${plan.missingSources.length} missing source(s), see log` } : {}),
    plan, applied, stamp: newStamp,
  }
}

module.exports = {
  VANILLA_PLUGINS,
  paths,
  readManifestLight,
  enabledPlugins,
  resolveExpected,
  unprovidedPlugins,
  readPluginFlags,
  computeDiff,
  writeDiff,
  readDiff,
  updateDiff,
  shouldRotatePrev,
  readSettingsFile,
  writeSettingsFile,
  syncSettings,
  syncData,
  basename,
  longPath,
  sha256File,
}
