'use strict'

/**
 * Mod Organizer 2 integration - portable install fully managed by the launcher.
 *
 *   %LOCALAPPDATA%\Alduinak\MO2\
 *     ModOrganizer.exe          downloaded from the official MO2 release
 *     ModOrganizer.ini          portable instance config (written by us)
 *     nxmhandler.ini            nxm:// → this MO2 instance
 *     downloads\                Nexus "Mod Manager Download" archives land here
 *     mods\<Mod Name>\          installed mods (assembled from the manifest)
 *     profiles\Alduinak\        the single launcher-managed profile
 *
 * Mods are installed by replaying a compiled manifest (see the backend's
 * scripts/compile-manifest.js): each archive is downloaded + verified by
 * sha256, extracted once, and the manifest's per-file directives reproduce the
 * reference install's exact layout. No FOMOD parsing or merge heuristics live
 * here - the manifest already encodes every choice.
 */

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const https = require('https')
const crypto = require('crypto')
const { spawn, execFileSync, execFile } = require('child_process')

const MO2_VERSION = '2.5.2'
const MO2_URL     = `https://github.com/ModOrganizer2/modorganizer/releases/download/v${MO2_VERSION}/Mod.Organizer-${MO2_VERSION}.7z`
const PROFILE     = 'Alduinak'

// SKSE is edition-specific: the Steam and GOG builds ship different loaders and
// runtime DLLs, so we download the one matching the player's game.
const SKSE_VERSION = 'skse64_2_02_06'
const SKSE_URLS    = {
  steam: `https://skse.silverlock.org/beta/${SKSE_VERSION}.7z`,
  gog:   `https://skse.silverlock.org/beta/${SKSE_VERSION}_gog.7z`,
}

// Logger
let _log = (...args) => console.log('[mo2]', ...args)
function setLogger(fn) { _log = (...args) => fn('[mo2]', ...args) }

// Paths

let _rootProvider = null
function setRootProvider(fn) { _rootProvider = fn }

function getRoot() {
  const custom = _rootProvider ? _rootProvider() : null
  if (custom) return custom
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Alduinak', 'MO2')
}

const getExe          = () => path.join(getRoot(), 'ModOrganizer.exe')
const getDownloadsDir = () => path.join(getRoot(), 'downloads')
const getModsDir      = () => path.join(getRoot(), 'mods')
const getProfileDir   = () => path.join(getRoot(), 'profiles', PROFILE)

function isInstalled() {
  return fs.existsSync(getExe())
}

// Prefer the vendored full 7-Zip (7z.exe + 7z.dll from assets/7zip, shipped
// via extraResources): unlike the standalone 7za in the 7zip-bin package it
// can read the .rar archives many Nexus mods come as. 7za stays as fallback.
function get7za() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, '7zip', '7z.exe') : null,
    path.join(__dirname, '..', 'assets', '7zip', '7z.exe'),
  ].filter(Boolean)
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p } catch {}
  }
  const sevenBin = require('7zip-bin')
  return sevenBin.path7za.replace('app.asar', 'app.asar.unpacked')
}

// Download / install MO2

/** Download url to dest, following redirects (GitHub releases redirect to a CDN). */
// Settle the promise exactly once on every outcome, including an aborted response.
function downloadFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let file = null
    let settled = false
    const finish = val => { if (!settled) { settled = true; resolve(val) } }
    // Destroy the stream before unlinking: an open handle leaves the partial file delete-pending on Windows and blocks every retry this session.
    const fail = err => {
      if (settled) return
      settled = true
      if (file && !file.destroyed) {
        file.once('close', () => { try { fs.unlinkSync(dest) } catch {} reject(err) })
        file.destroy()
      } else {
        try { fs.unlinkSync(dest) } catch {}
        reject(err)
      }
    }
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return fail(new Error('Too many redirects'))
        return finish(downloadFile(res.headers.location, dest, onProgress, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return fail(new Error(`HTTP ${res.statusCode} downloading ${url}`))
      }

      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      file = fs.createWriteStream(dest)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => finish(dest)))
      file.on('error', fail)
      res.on('error',  fail)
      res.on('aborted', () => fail(new Error('Download interrupted')))
    })
    req.on('error', fail)
    req.setTimeout(120_000, () => { req.destroy(); fail(new Error('Download timed out')) })
  })
}

/** Extract a .7z/.zip archive with the bundled 7za. */
function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  execFileSync(get7za(), ['x', '-y', `-o${destDir}`, archivePath], {
    stdio: 'ignore',
    timeout: 10 * 60 * 1000,
  })
}

const MO2_STAMP = '.mo2-integrity.json'

// Top-level root entries that hold player data, caches or another Repair section rather than MO2 itself.
const MO2_DATA_DIRS = ['mods', 'downloads', 'profiles', 'overwrite', 'webcache', 'logs', '.x', '.b', '.skse', 'skyrim']

// Size+count stamp over MO2's own exe/dll files: inis and caches change in
// normal use, but the binaries only change with the pinned MO2 version, so a
// mismatch means corruption or an AV quarantine and triggers a reinstall.
function mo2BinaryStats() {
  const root = getRoot()
  const skipTop = new Set(MO2_DATA_DIRS)
  let size = 0
  let count = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (dir === root && skipTop.has(e.name.toLowerCase())) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!/\.(exe|dll)$/i.test(e.name)) continue
      count++
      try { size += fs.statSync(lp(p)).size } catch { /* unreadable = size mismatch */ }
    }
  }
  return { size, count }
}

function readMo2Stamp() {
  try { return JSON.parse(fs.readFileSync(path.join(getRoot(), MO2_STAMP), 'utf8')) } catch { return null }
}

function writeMo2Stamp() {
  const stats = mo2BinaryStats()
  fs.writeFileSync(path.join(getRoot(), MO2_STAMP),
    JSON.stringify({ version: MO2_VERSION, size: stats.size, count: stats.count }) + '\n')
}

/**
 * Download and unpack MO2 itself. Resolves immediately when the installed
 * binaries match the integrity stamp; anything else (corruption, quarantine,
 * version bump, pre-stamp install) re-extracts over the existing install.
 * onProgress(message) receives human-readable status lines.
 */
async function ensureInstalled(onProgress) {
  if (isInstalled()) {
    const stamp = readMo2Stamp()
    if (stamp && stamp.version === MO2_VERSION) {
      const now = mo2BinaryStats()
      if (now.size === stamp.size && now.count === stamp.count) return
      _log(`MO2 binaries do not match the stamp (${now.count} files/${now.size} bytes vs ${stamp.count}/${stamp.size}) - repairing`)
      if (onProgress) onProgress('Repairing Mod Organizer 2…')
    } else if (!stamp) {
      // Pre-stamp install: adopt the current binaries as the baseline instead
      // of forcing every existing player through a re-download; the stamp
      // catches corruption from here on. Player-added MO2 plugins converge
      // after one refresh cycle.
      _log('no MO2 integrity stamp - adopting the current install as baseline')
      writeMo2Stamp()
      return
    } else {
      _log(`MO2 version changed (${stamp.version} -> ${MO2_VERSION}) - reinstalling`)
    }
  }
  await installFresh(onProgress)
}

/** Lower-cased top-level names the MO2 archive writes into the root. */
async function archiveTopLevelNames(archive) {
  const entries = await listArchiveEntries(archive)
  if (!entries) throw new Error('Could not read the downloaded MO2 archive.')
  return new Set(entries.map(e => e.path.split('/')[0].toLowerCase()))
}

/** Remove the root entries in `names` (case-insensitive, player data dirs excluded), then the stamp last so an aborted wipe is never adopted as healthy. Returns the removed names. */
function removeRootEntries(names) {
  const root = getRoot()
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const removed = []
  for (const e of entries) {
    const lower = e.name.toLowerCase()
    if (lower === MO2_STAMP || MO2_DATA_DIRS.includes(lower) || !names.has(lower)) continue
    rmrfSync(path.join(root, e.name))
    removed.push(e.name)
  }
  const stamp = path.join(root, MO2_STAMP)
  if (fs.existsSync(stamp)) { fs.rmSync(stamp, { force: true }); removed.push(MO2_STAMP) }
  return removed
}

async function downloadMo2Archive(onProgress) {
  const archive = path.join(os.tmpdir(), `mo2-${MO2_VERSION}.7z`)
  if (onProgress) onProgress('Downloading Mod Organizer 2…')
  await downloadFile(MO2_URL, archive, (received, total) => {
    if (onProgress && total > 0) {
      const mb = n => (n / 1024 / 1024).toFixed(1)
      onProgress(`Downloading Mod Organizer 2… ${mb(received)} / ${mb(total)} MB`)
    }
  })
  return archive
}

function extractMo2Archive(archive, onProgress) {
  if (onProgress) onProgress('Extracting Mod Organizer 2…')
  extractArchive(archive, getRoot())
  try { fs.unlinkSync(archive) } catch {}
  if (!isInstalled()) {
    throw new Error('MO2 extraction finished but ModOrganizer.exe was not found.')
  }
  writeMo2Stamp()
  _log('MO2 installed')
}

/** Download first so a failed fetch leaves the install untouched; only a launcher-made instance (portable.txt) has the archive's own entries removed before extraction. */
async function reinstall(onProgress) {
  const root = getRoot()
  _log(`reinstalling MO2 ${MO2_VERSION} in ${root}`)
  const archive = await downloadMo2Archive(onProgress)
  if (isInstalled() && fs.existsSync(path.join(root, 'portable.txt'))) {
    const removed = removeRootEntries(await archiveTopLevelNames(archive))
    _log(`removed ${removed.length} MO2 entries from ${root} for a fresh install`)
  }
  extractMo2Archive(archive, onProgress)
}

async function installFresh(onProgress) {
  _log(`installing MO2 ${MO2_VERSION} to ${getRoot()}`)
  extractMo2Archive(await downloadMo2Archive(onProgress), onProgress)
}

// Portable instance / profile

// Forward slashes everywhere: valid for Windows APIs and avoids INI escaping.
const fwd = p => p.replace(/\\/g, '/')

// Detect the Skyrim SE store edition
function detectEdition(gameDir) {
  try {
    const names = fs.readdirSync(gameDir)
    if (names.includes('Galaxy64.dll') || names.some(f => /^goggame-.*\.(info|dll|hashdb)$/i.test(f))) return 'GOG'
    if (names.includes('EOSSDK-Win64-Shipping.dll')) return 'Epic Games'
    if (names.some(f => /^Gaming\.Desktop|appxmanifest/i.test(f))) return 'Microsoft Store'
    if (names.includes('steam_api64.dll')) return 'Steam'
  } catch { /* unreadable */ }
  return 'Steam'
}

function instanceDirLines() {
  const root = fwd(getRoot())
  return [
    `base_directory=${root}`,
    `mod_directory=${root}/mods`,
    `download_directory=${root}/downloads`,
    `cache_directory=${root}/webcache`,
    `profiles_directory=${root}/profiles`,
    `overwrite_directory=${root}/overwrite`,
  ]
}

// The custom-executable entry (array slot n) that moshortcut://:SKSE resolves against.
function skseExecutableLines(skyrimPath, n) {
  return [
    `${n}\\title=SKSE`,
    `${n}\\binary=${fwd(path.join(skyrimPath, 'skse64_loader.exe'))}`,
    `${n}\\workingDirectory=${fwd(skyrimPath)}`,
    `${n}\\arguments=`,
    `${n}\\hide=false`,
    `${n}\\toolbar=true`,
    `${n}\\ownicon=true`,
  ]
}

// Full portable-instance ini, written once when the instance is first created.
function buildInstanceIni(skyrimPath, style) {
  return [
    '[General]',
    'gameName=Skyrim Special Edition',
    `gameEdition=${detectEdition(skyrimPath)}`,
    `gamePath=@ByteArray(${fwd(skyrimPath)})`,
    `selected_profile=@ByteArray(${PROFILE})`,
    `version=${MO2_VERSION}`,
    'first_start=false',
    '',
    '[Settings]',
    'check_for_updates=false',
    ...instanceDirLines(),
    ...(style ? [`style=${style}`] : []),
    '',
    '[customExecutables]',
    'size=1',
    ...skseExecutableLines(skyrimPath, 1),
    '',
  ].join('\r\n')
}

// Reinstate a lost SKSE shortcut entry; MO2 cannot resolve moshortcut://:SKSE without it.
function ensureSkseEntry(txt, skyrimPath) {
  const lines = txt.split(/\r?\n/)
  const start = lines.findIndex(l => l.trim() === '[customExecutables]')
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return lines.concat(['', '[customExecutables]', 'size=1', ...skseExecutableLines(skyrimPath, 1), '']).join('\r\n')
  }
  let end = start + 1
  while (end < lines.length && !/^\[/.test(lines[end].trim())) end++
  // Append as the next array slot, bumping (or adding) the section's size counter.
  let n = 1
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^size=(\d+)/)
    if (m) { n = parseInt(m[1], 10) + 1; lines[i] = `size=${n}`; break }
  }
  const insert = skseExecutableLines(skyrimPath, n)
  if (n === 1) insert.unshift('size=1')
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, ...insert)
  return lines.join('\r\n')
}

// Update ini path
function healInstancePaths(iniPath, skyrimPath) {
  const gamePath = fwd(skyrimPath)
  const ssePath  = fwd(path.join(skyrimPath, 'skse64_loader.exe'))
  let txt = fs.readFileSync(iniPath, 'utf8')
  // Function replacers avoid '$' in paths being treated as replacement tokens.
  txt = txt.replace(/^gamePath=.*$/m, () => `gamePath=@ByteArray(${gamePath})`)

  // Heal the SKSE entry by its title (MO2 may reorder the array on save), or reinstate it when lost.
  const skseIdx = (txt.match(/^(\d+)\\title=SKSE\s*$/m) || [])[1]
  if (skseIdx) {
    txt = txt.replace(new RegExp(`^${skseIdx}\\\\binary=.*$`, 'm'),           () => `${skseIdx}\\binary=${ssePath}`)
    txt = txt.replace(new RegExp(`^${skseIdx}\\\\workingDirectory=.*$`, 'm'), () => `${skseIdx}\\workingDirectory=${gamePath}`)
  } else {
    txt = ensureSkseEntry(txt, skyrimPath)
  }

  // Upsert each directory pin: replace an existing key or append under [Settings].
  for (const line of instanceDirLines()) {
    const key = line.slice(0, line.indexOf('='))
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(txt)) txt = txt.replace(re, () => line)
    else if (/^\[Settings\]\s*$/m.test(txt)) txt = txt.replace(/^\[Settings\]\s*$/m, m => `${m}\r\n${line}`)
    else txt += `\r\n[Settings]\r\n${line}\r\n`
  }
  fs.writeFileSync(iniPath, txt)
}

/**
 * Pick a dark stylesheet bundled with MO2 (preference order, then any *.qss
 * with "dark" in the name). Returns '' if none found.
 */
function pickDarkStyle() {
  const dir = path.join(getRoot(), 'stylesheets')
  const preferred = ['Paper Dark.qss', 'paper-dark.qss', 'VS15.qss', 'dark.qss', '1809.qss']
  try {
    const files = fs.readdirSync(dir)
    for (const name of preferred) {
      if (files.includes(name)) return name
    }
    const anyDark = files.find(f => /dark/i.test(f) && f.toLowerCase().endsWith('.qss'))
    if (anyDark) return anyDark
  } catch { /* stylesheets dir missing */ }
  return ''
}

/**
 * Create or refresh the portable instance config and the Alduinak profile.
 * Safe to call repeatedly; user data (mods, downloads) is never touched.
 *
 * @param {string}   skyrimPath
 * @param {string[]} [loadOrder]  Server esp/esm order for the profile's plugins.txt
 */
function ensureInstance(skyrimPath, loadOrder) {
  const root = getRoot()
  for (const dir of [getDownloadsDir(), getModsDir(), getProfileDir(), path.join(root, 'overwrite')]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // portable.txt is MO2's portable-instance marker. Without it MO2 ignores
  // the local ModOrganizer.ini and opens the user's registry-selected
  // (global) instance instead.
  fs.writeFileSync(path.join(root, 'portable.txt'), '')

  const iniPath = path.join(root, 'ModOrganizer.ini')
  if (fs.existsSync(iniPath)) {
    healInstancePaths(iniPath, skyrimPath)
  } else {
    fs.writeFileSync(iniPath, buildInstanceIni(skyrimPath, pickDarkStyle()))
  }

  // Profile files - only created when missing so MO2-side changes survive.
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  if (!fs.existsSync(modlistPath)) {
    fs.writeFileSync(modlistPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }

  const pluginsPath = path.join(getProfileDir(), 'plugins.txt')
  if (Array.isArray(loadOrder) && loadOrder.length > 0) {
    fs.writeFileSync(pluginsPath,
      '# This file was automatically generated by Mod Organizer.\r\n' + serverPluginLines(loadOrder).join('\r\n') + '\r\n')
  } else if (!fs.existsSync(pluginsPath)) {
    fs.writeFileSync(pluginsPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }
}

/** plugins.txt lines for the server load order: every non-vanilla plugin, enabled. */
function serverPluginLines(loadOrder) {
  const vanilla = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'])
  return (loadOrder || [])
    .map(f => path.basename(f))
    .filter(f => !vanilla.has(f.toLowerCase()))
    .map(f => `*${f}`)
}

/**
 * Point the nxm:// protocol at our portable instance so Nexus
 * "Mod Manager Download" buttons feed MO2's downloads folder.
 */
function registerNxmHandler() {
  const root       = getRoot()
  const nxmHandler = path.join(root, 'nxmhandler.exe')

  fs.writeFileSync(path.join(root, 'nxmhandler.ini'), [
    '[handlers]',
    'size=1',
    '1\\games=skyrimse',
    `1\\executable=${fwd(getExe())}`,
    '1\\arguments=',
    '',
  ].join('\r\n'))

  if (process.platform !== 'win32') return
  try {
    // Pass argv arrays to reg.exe (no cmd.exe) so a baseDirPath containing shell
    // metacharacters (& ^ %) cannot inject commands. The command value keeps its
    // embedded quotes around the handler path and %1 so spaced paths still work.
    const run = args => execFileSync('reg', args, { timeout: 5000, stdio: 'ignore' })
    run(['add', 'HKCU\\Software\\Classes\\nxm', '/ve', '/d', 'URL:NXM Protocol', '/f'])
    run(['add', 'HKCU\\Software\\Classes\\nxm', '/v', 'URL Protocol', '/d', '', '/f'])
    run(['add', 'HKCU\\Software\\Classes\\nxm\\shell\\open\\command', '/ve', '/d', `"${nxmHandler}" "%1"`, '/f'])
    _log('nxm:// handler registered')
  } catch (err) {
    _log('nxm handler registration failed:', err.message)
  }
}

// Mod management

// Windows caps fs paths at MAX_PATH (260) unless prefixed with \\?\. Big mods
// (deep mesh trees, e.g. JK's) exceed that while building, so prefix every fs
// boundary - MO2 itself opts into long paths, so it succeeds where plain Node
// copies would fail.
function lp(p) {
  if (process.platform !== 'win32') return p
  const abs = path.resolve(p)
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs
}

// Windows refuses to delete read-only files even with force:true, and both 7z
// (restoring archive attributes into .x) and copyFileSync (propagating them
// into mod folders) produce them. Strip attributes and retry before giving up.
function rmrfSync(target) {
  try {
    fs.rmSync(lp(target), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    return
  } catch (err) {
    if (process.platform !== 'win32') throw err
  }
  const stack = [target]
  const dirs = []
  while (stack.length) {
    const dir = stack.pop()
    dirs.push(dir)
    let entries = []
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else try { fs.chmodSync(lp(p), 0o666) } catch {}
    }
  }
  for (const d of dirs) { try { fs.chmodSync(lp(d), 0o777) } catch {} }
  fs.rmSync(lp(target), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/** Every file under dir as a forward-slash path relative to dir ([] when unreadable). */
function listFilesRel(dir) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(lp(path.join(dir, rel)), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(r)
      else out.push(r)
    }
  }
  return out
}

/** Streaming SHA-256 of a file (handles multi-GB archives without buffering). */
function sha256File(p) {
  const fd  = fs.openSync(lp(p), 'r')
  const h   = crypto.createHash('sha256')
  const buf = Buffer.alloc(1 << 20)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

/** True when the archive on disk matches the manifest's expected sha256. */
function verifyArchive(archivePath, sha256) {
  try { return sha256File(archivePath).toLowerCase() === String(sha256).toLowerCase() }
  catch { return false }
}

/** Find a finished download whose .meta records the given Nexus fileId. */
function findDownloadByFileId(fileId) {
  let names
  try { names = fs.readdirSync(getDownloadsDir()) } catch { return null }
  for (const name of names) {
    if (/\.(meta|unfinished)$/i.test(name)) continue
    try {
      const meta = fs.readFileSync(path.join(getDownloadsDir(), name + '.meta'), 'utf8')
      const id   = (meta.match(/^fileID\s*=\s*(\d+)/im) || [])[1]
      if (id && Number(id) === Number(fileId)) return name
    } catch { /* no meta - skip */ }
  }
  return null
}

/** Download any URL into the MO2 downloads folder. Returns the archive name. */
async function downloadToDownloads(url, fileName, onProgress) {
  const dest = path.join(getDownloadsDir(), fileName)
  if (fs.existsSync(dest)) return fileName
  fs.mkdirSync(getDownloadsDir(), { recursive: true })
  const temp = dest + '.unfinished'
  try { fs.rmSync(temp, { force: true }) } catch {}   // stale partial from an earlier failed run
  try {
    await downloadFile(url, temp, onProgress)
  } catch (err) {
    // One retry: SKSE and mod hosts drop connections often enough that a single blip should not fail the whole install pass.
    _log(`download failed (${err.message}), retrying: ${url}`)
    await new Promise(r => setTimeout(r, 3000))
    await downloadFile(url, temp, onProgress)
  }
  fs.renameSync(temp, dest)
  return fileName
}

// Manifest install (deterministic replay)

/**
 * Extract an archive into a per-run cache dir (.x/<archiveId>) and return its
 * path. Re-extraction is skipped if the cache already exists this run.
 */
// An interrupted extraction leaves a partial folder. Reusing it makes every
// later run fail with "not found in archive" until the install is deleted, so
// a cached extraction counts only when this marker says it finished.
const EXTRACT_MARKER = '.complete'

function extractToCache(archivePath, archiveId) {
  const dir = path.join(getRoot(), '.x', String(archiveId))
  const marker = path.join(dir, EXTRACT_MARKER)
  if (fs.existsSync(lp(marker))) return dir

  if (fs.existsSync(lp(dir))) {
    _log(`discarding incomplete extraction of ${archiveId}`)
    rmrfSync(dir)
  }
  extractArchive(archivePath, dir)
  fs.writeFileSync(lp(marker), '')
  return dir
}

/** Remove leftover .b build folders from interrupted applyMod runs. */
function clearBuildCache() {
  try { rmrfSync(path.join(getRoot(), '.b')) } catch (err) { _log(`could not clear build cache: ${err.message}`) }
}

/** Remove a cached extraction (or the whole .x cache when no id is given). */
function clearCache(archiveId) {
  const dir = archiveId == null ? path.join(getRoot(), '.x') : path.join(getRoot(), '.x', String(archiveId))
  try {
    rmrfSync(dir)
  } catch (err) {
    // A locked cache used to be swallowed here and then reused as if valid
    _log(`could not clear extraction cache ${dir}: ${err.message}`)
    try { fs.rmSync(lp(path.join(dir, EXTRACT_MARKER)), { force: true }) } catch {}
  }
}

/**
 * Build one mod folder from its directives, OVERWRITING any existing install.
 * Files are assembled in a short temp dir and swapped into place only on
 * success, so a failed (re)install never destroys a working folder.
 *
 *   files: [{ to, archive, from, sha256, size } | { to, inline, sha256, size }]
 *   extractedDirs: { [archiveId]: <extracted path> }
 *
 * @returns { folder } | { error }
 */
function applyMod(modName, files, extractedDirs, modId, hash) {
  const folderName = String(modName).replace(/[<>:"/\\|?*]/g, '')
  const modDir     = path.join(getModsDir(), folderName)
  const buildDir   = path.join(getRoot(), '.b', String(_applyCounter++))

  try { rmrfSync(buildDir) } catch {}
  try {
    for (const f of files) {
      try {
        writeDirective(f, buildDir, extractedDirs)
      } catch (err) {
        // Name the file and its source: "mod failed" alone is undiagnosable
        throw new Error(`${f.to}: ${err.message}${f.archive ? ` [archive ${f.archive}, from ${f.from}]` : ' [inline]'}`)
      }
    }

    fs.writeFileSync(lp(path.join(buildDir, 'meta.ini')), [
      '[General]', 'gameName=SkyrimSE', `modid=${modId || 0}`, `name=${folderName}`,
      'repository=Nexus', 'alduinakManaged=true', `alduinakHash=${hash || ''}`, '',
    ].join('\r\n'))

    // Swap via rename-aside: a locked file fails the rename cleanly instead
    // of a partial rmSync leaving a half-deleted mod. Leftover .stale dirs
    // are collected by the stale-mod scan on the next run.
    const staleDir = modDir + '.stale'
    try { rmrfSync(staleDir) } catch {}
    fs.mkdirSync(lp(path.dirname(modDir)), { recursive: true })
    let movedAside = false
    if (fs.existsSync(lp(modDir))) {
      fs.renameSync(lp(modDir), lp(staleDir))
      movedAside = true
    }
    try {
      fs.renameSync(lp(buildDir), lp(modDir))
    } catch (err) {
      if (movedAside) { try { fs.renameSync(lp(staleDir), lp(modDir)) } catch {} }
      throw err
    }
    try { rmrfSync(staleDir) } catch {}
    _log(`installed ${folderName} (${files.length} file(s))`)
    return { folder: folderName }
  } catch (err) {
    try { rmrfSync(buildDir) } catch {}
    return { error: err.message }   // existing modDir left intact
  }
}
let _applyCounter = 1

/** Place game-root files (SKSE, preloaders) directly into the game folder. */
function applyRootFiles(rootFiles, extractedDirs, gameDir) {
  for (const f of rootFiles || []) writeDirective(f, gameDir, extractedDirs)
  return (rootFiles || []).length
}

/** Materialise a single directive (FromArchive or Inline) under destRoot, verifying sha256. */
function writeDirective(f, destRoot, extractedDirs) {
  const dest = path.join(destRoot, f.to.split('/').join(path.sep))
  fs.mkdirSync(lp(path.dirname(dest)), { recursive: true })

  if (f.inline != null) {
    fs.writeFileSync(lp(dest), Buffer.from(f.inline, 'base64'))
  } else {
    const dir = extractedDirs[f.archive]
    if (!dir) throw new Error(`archive ${f.archive} was not extracted`)
    const src = path.join(dir, f.from.split('/').join(path.sep))
    if (!fs.existsSync(lp(src))) throw new Error(`"${f.from}" not found in archive ${f.archive}`)
    fs.copyFileSync(lp(src), lp(dest))
  }

  if (f.sha256 && sha256File(dest).toLowerCase() !== String(f.sha256).toLowerCase()) {
    throw new Error(`hash mismatch for ${f.to}`)
  }
}

/**
 * Write the profile's modlist.txt from the manifest's order so MO2's
 * conflict-resolution priority matches the reference install. The order is
 * preserved verbatim (order[0] = top line = highest priority) and includes
 * separators (names ending in "_separator"), whose empty folders are recreated
 * here. Any user-added mods already in modlist.txt are preserved below the
 * managed set, so re-installing never wipes a player's own texture mods.
 */
function setModlistOrder(order) {
  fs.mkdirSync(getProfileDir(), { recursive: true })
  const managed = new Set(order)

  // Recreate separators (empty folders MO2 recognises by the _separator suffix).
  for (const name of order) {
    if (!name.endsWith('_separator')) continue
    const dir = path.join(getModsDir(), name)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'meta.ini'),
        ['[General]', 'gameName=SkyrimSE', 'modid=0', `name=${name}`, 'alduinakManaged=true', ''].join('\r\n'))
    }
  }

  // Genuine user-added mods (not launcher-managed) keep their lines below
  // ours; dangling lines whose folder is gone are dropped so MO2 never
  // reports missing mods.
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let userLines = []
  try {
    userLines = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/)
      .filter(l => {
        if (!/^[+-]/.test(l)) return false
        const name = l.slice(1).trim()
        if (managed.has(name) || isManaged(name)) return false
        return fs.existsSync(path.join(getModsDir(), name))
      })
  } catch { /* first install */ }

  // An empty order means a broken or empty manifest: never mass-prune on it.
  if (order.length > 0) {
    for (const name of listStaleManagedMods(order)) {
      try {
        rmrfSync(path.join(getModsDir(), name))
        _log(`removed stale managed mod (no longer in manifest): ${name}`)
      } catch (err) {
        _log(`could not remove stale mod ${name}: ${err.message}`)
      }
    }
  } else {
    _log('manifest order is empty - skipping stale-mod pruning')
  }

  const lines = [
    '# This file was automatically generated by Mod Organizer.',
    ...order.map(n => `+${n}`),
    ...userLines,
  ]
  fs.writeFileSync(modlistPath, lines.join('\r\n') + '\r\n')
}

/**
 * Launcher-managed mod folders the manifest order no longer lists. Found by
 * scanning the mods dir itself, never the old modlist.txt: folders left by
 * failed runs or a rewritten modlist have no line there, which is exactly how
 * they used to survive and break the game. NTFS is case-insensitive, so names
 * are compared folded.
 */
function listStaleManagedMods(order) {
  const managedFold = new Set(order.map(n => String(n).replace(/[<>:"/\\|?*]/g, '').toLowerCase()))
  const stale = []
  let modDirs = []
  try { modDirs = fs.readdirSync(getModsDir(), { withFileTypes: true }) } catch {}
  for (const e of modDirs) {
    const fold = e.name.toLowerCase()
    if (!e.isDirectory() || managedFold.has(fold) || fold === 'skse') continue
    if (!isManaged(e.name)) continue // the player's own mod: keep
    // A copied managed folder keeps its original meta name= - that is a
    // player's copy, keep it. Transient .stale folders from an interrupted
    // swap are always ours regardless of the recorded name.
    if (!fold.endsWith('.stale') && readMetaName(e.name).toLowerCase() !== fold) continue
    stale.push(e.name)
  }
  return stale
}

/** Write the profile's plugins.txt from the manifest's captured esp/esm order. */
function setPlugins(pluginLines) {
  if (!Array.isArray(pluginLines) || pluginLines.length === 0) return
  fs.mkdirSync(getProfileDir(), { recursive: true })
  fs.writeFileSync(path.join(getProfileDir(), 'plugins.txt'),
    '# This file was automatically generated by Mod Organizer.\r\n' + pluginLines.join('\r\n') + '\r\n')
}

// SKSE (edition-aware)

/** Pick the SKSE download matching the game's store edition (GOG vs Steam). */
function skseSourceFor(gameDir) {
  const edition = detectEdition(gameDir)
  const gog     = edition === 'GOG'
  return {
    edition,
    url:      gog ? SKSE_URLS.gog : SKSE_URLS.steam,
    fileName: `${SKSE_VERSION}${gog ? '_gog' : ''}.7z`,
  }
}

/**
 * Install SKSE from its archive: skse64_loader.exe + skse64_*.dll go into the
 * game root; the Data payload (Scripts/*.pex, skse.ini) becomes a managed MO2
 * mod so the VFS serves it. Edition selection happens in skseSourceFor.
 *
 * @returns {{ folder: string|null }}  the scripts-mod folder, if one was made
 */
function installSkse(archivePath, gameDir) {
  const tmp = path.join(getRoot(), '.skse')
  try { fs.rmSync(lp(tmp), { recursive: true, force: true }) } catch {}
  extractArchive(archivePath, tmp)
  try {
    // Descend a single wrapper folder (skse64_2_02_06/…) to the real root.
    let rootDir = tmp
    for (let i = 0; i < 3; i++) {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true })
      if (entries.some(e => !e.isDirectory() && /^skse64_loader\.exe$/i.test(e.name))) break
      const dirs = entries.filter(e => e.isDirectory())
      if (dirs.length === 1 && entries.length === 1) { rootDir = path.join(rootDir, dirs[0].name); continue }
      break
    }

    let copied = 0
    for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!e.isDirectory() && /\.(exe|dll)$/i.test(e.name)) {
        fs.copyFileSync(path.join(rootDir, e.name), path.join(gameDir, e.name)); copied++
      }
    }
    if (copied === 0) throw new Error('no skse64 exe/dll found in the SKSE archive')

    let folder = null
    const dataDir = fs.readdirSync(rootDir, { withFileTypes: true })
      .find(e => e.isDirectory() && e.name.toLowerCase() === 'data')
    if (dataDir) {
      folder = 'SKSE'
      const modDir = path.join(getModsDir(), folder)
      try { fs.rmSync(lp(modDir), { recursive: true, force: true }) } catch {}
      fs.mkdirSync(lp(modDir), { recursive: true })
      const src = path.join(rootDir, dataDir.name)
      for (const entry of fs.readdirSync(src)) fs.renameSync(path.join(src, entry), path.join(modDir, entry))
      fs.writeFileSync(path.join(modDir, 'meta.ini'),
        ['[General]', 'gameName=SkyrimSE', 'modid=0', 'name=SKSE', 'repository=', 'alduinakManaged=true', ''].join('\r\n'))
    }
    _log(`SKSE installed (${copied} root file(s))`)
    return { folder }
  } finally {
    try { fs.rmSync(lp(tmp), { recursive: true, force: true }) } catch {}
  }
}

// Launch-time lockdown (anti-desync / anti-cheat)

const PLUGIN_RE = /\.(esp|esm|esl)$/i

/** True if modName's meta.ini marks it as launcher-installed (managed). */
function isManaged(modName) {
  try {
    return /^alduinakManaged\s*=\s*true/im.test(fs.readFileSync(path.join(getModsDir(), modName, 'meta.ini'), 'utf8'))
  } catch { return false }
}

/** The name= recorded in a mod's meta.ini ('' when absent). */
function readMetaName(modName) {
  try {
    const meta = fs.readFileSync(path.join(getModsDir(), modName, 'meta.ini'), 'utf8')
    return (meta.match(/^name\s*=\s*(.*)$/im) || [])[1]?.trim() || ''
  } catch { return '' }
}

/**
 * The content hash recorded in a mod's meta.ini at install time, or '' if the
 * mod folder is absent / has no recorded hash. Lets the installer skip a mod
 * that's already on disk in the exact version the manifest expects (repair,
 * not reinstall) without trusting external state.
 */
function readModHash(modName) {
  const folder = String(modName).replace(/[<>:"/\\|?*]/g, '')
  try {
    const meta = fs.readFileSync(path.join(getModsDir(), folder, 'meta.ini'), 'utf8')
    return (meta.match(/^alduinakHash\s*=\s*(.*)$/im) || [])[1]?.trim() || ''
  } catch { return '' }
}

/**
 * Total byte size of an installed mod folder, excluding the launcher's own
 * meta.ini - directly comparable to the summed directive sizes from the
 * manifest. Returns -1 when the folder is missing or unreadable.
 */
function modFolderSize(modName) {
  const folder = String(modName).replace(/[<>:"/\\|?*]/g, '')
  const root = path.join(getModsDir(), folder)
  if (!fs.existsSync(lp(root))) return -1
  let total = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { return -1 }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (dir === root && e.name.toLowerCase() === 'meta.ini') continue
      try { total += fs.statSync(lp(p)).size } catch { return -1 }
    }
  }
  return total
}

/** Does a mod folder ship a plugin (esp/esm/esl) or an SKSE plugin DLL? */
function modHasRestrictedContent(modDir) {
  const stack = [modDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { stack.push(path.join(dir, e.name)); continue }
      if (PLUGIN_RE.test(e.name)) return true
      if (/\.dll$/i.test(e.name) && /[\\/]skse[\\/]plugins$/i.test(dir)) return true
    }
  }
  return false
}

// Overwrite folder lockdown
const OVERWRITE_JUNK_RE = /\.(esp|esl|esm|bsa)$/i

/** Plugins, BSAs and CC files sitting in the overwrite folder; they load at top priority and desync the load order. */
function listOverwriteJunk() {
  let entries
  try { entries = fs.readdirSync(path.join(getRoot(), 'overwrite'), { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(e => e.isFile() && (OVERWRITE_JUNK_RE.test(e.name) || /^cc/i.test(e.name)))
    .map(e => e.name)
}

function cleanOverwrite() {
  const overwrite = path.join(getRoot(), 'overwrite')
  const removed = []
  for (const name of listOverwriteJunk()) {
    try { fs.rmSync(lp(path.join(overwrite, name)), { force: true }); removed.push(name) }
    catch (err) { _log(`could not remove overwrite item ${name}: ${err.message}`) }
  }
  if (removed.length === 0) return []

  // Drop any now-orphaned plugin lines from plugins.txt (matched case-insensitively).
  const pluginsPath = path.join(getProfileDir(), 'plugins.txt')
  try {
    const gone = new Set(removed.filter(n => OVERWRITE_JUNK_RE.test(n)).map(n => n.toLowerCase()))
    const kept = fs.readFileSync(pluginsPath, 'utf8').split(/\r?\n/)
      .filter(l => !gone.has(l.replace(/^\*/, '').trim().toLowerCase()))
    fs.writeFileSync(pluginsPath, kept.join('\r\n'))
  } catch { /* plugins.txt is rewritten from the server list on install anyway */ }

  _log(`cleaned ${removed.length} stray overwrite item(s): ${removed.join(', ')}`)
  return removed
}

function enforceModRules() {
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let lines
  try { lines = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/) } catch { return [] }

  const disabled = []
  const out = lines.map(line => {
    if (line[0] !== '+') return line               // comment, blank, or already disabled
    const name = line.slice(1).trim()
    if (!name || name.endsWith('_separator') || isManaged(name)) return line
    if (modHasRestrictedContent(path.join(getModsDir(), name))) {
      disabled.push(name)
      return `-${name}`
    }
    return line
  })

  if (disabled.length > 0) {
    fs.writeFileSync(modlistPath, out.join('\r\n'))
    _log(`disabled ${disabled.length} unauthorised mod(s): ${disabled.join(', ')}`)
  }
  return disabled
}

// Browser-partial and sidecar files that are never a finished archive.
const PARTIAL_RE = /\.(meta|unfinished|part|tmp|crdownload|download)$/i
// Caches so repeated scans (the wait loop, locate) don't re-hash or re-list unchanged files.
const _archiveHashCache = new Map()   // full -> { size, mtimeMs, hash }
const _archiveListCache = new Map()   // full -> { size, mtimeMs, listing }

/** Async streaming SHA-256 that yields to the event loop, so the UI stays responsive mid-scan. */
function sha256FileAsync(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(lp(p), { highWaterMark: 1 << 20 })
    s.on('data', chunk => h.update(chunk))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

// Hash a file through the cache; a changed size/mtime (e.g. a finishing copy) re-hashes.
async function hashCached(full, st) {
  const c = _archiveHashCache.get(full)
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.hash
  const hash = (await sha256FileAsync(full)).toLowerCase()
  _archiveHashCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, hash })
  return hash
}

/** Finished (non-partial) archive files in the downloads folder, one stat pass. */
function listDownloadArchives() {
  const out = []
  let names
  try { names = fs.readdirSync(getDownloadsDir()) } catch { return out }
  for (const file of names) {
    if (PARTIAL_RE.test(file)) continue
    const full = path.join(getDownloadsDir(), file)
    let st
    try { st = fs.statSync(lp(full)) } catch { continue }
    if (st.isFile()) out.push({ file, full, st })
  }
  const present = new Set(out.map(a => a.full))
  for (const cache of [_archiveHashCache, _archiveListCache]) {
    for (const key of cache.keys()) if (!present.has(key.split('\0')[0])) cache.delete(key)
  }
  return out
}

/**
 * Path of a finished archive in the downloads folder whose sha256 == hash, or
 * null. Matches by content so manually moved ("Slow Download") files are found
 * regardless of filename; the size pre-filter avoids hashing partials/unrelated files.
 */
async function findArchiveByHash(hash, size) {
  if (!hash) return null
  const want = String(hash).toLowerCase()
  for (const a of listDownloadArchives()) {
    if (typeof size === 'number' && size > 0 && a.st.size !== size) continue
    try { if (await hashCached(a.full, a.st) === want) return a.full } catch { /* mid-copy or locked; caller retries */ }
  }
  return null
}

/**
 * 7za listing of an archive, or null when unreadable (locked, truncated, or
 * not an archive). Successful listings are cached per size/mtime so an
 * unchanged file isn't re-listed on every scan.
 */
function listArchiveContents(archivePath, st, technical = false) {
  const key = technical ? `${archivePath}\0slt` : archivePath
  const c = _archiveListCache.get(key)
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return Promise.resolve(c.listing)
  return new Promise(resolve => {
    execFile(get7za(), technical ? ['l', '-slt', lp(archivePath)] : ['l', lp(archivePath)],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        _archiveListCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, listing: stdout })
        resolve(stdout)
      })
  })
}

/** Parse a 7za technical (-slt) listing into file entries [{ path, size, crc }], directories excluded. */
function parseArchiveListing(text) {
  const body = String(text).split(/^-{10,}\s*$/m)[1] || ''
  const out = []
  for (const block of body.split(/\r?\n\r?\n/)) {
    const get = key => (block.match(new RegExp(`^${key} = (.*)$`, 'm')) || [])[1]
    const p = get('Path')
    if (!p || /^D/.test(get('Attributes') || '')) continue
    out.push({ path: p.replace(/\\/g, '/'), size: parseInt(get('Size') || '0', 10) || 0, crc: (get('CRC') || '').trim().toUpperCase() })
  }
  return out
}

/** File entries of an archive on disk (see parseArchiveListing), or null when unreadable. */
async function listArchiveEntries(archivePath) {
  let st
  try { st = fs.statSync(lp(archivePath)) } catch { return null }
  const text = await listArchiveContents(archivePath, st, true)
  return text == null ? null : parseArchiveListing(text)
}

/**
 * Poll until every wanted archive is present in the downloads folder.
 * `hash` items match by content, whatever the filename; their `namePattern`
 * only flags a look-alike file that fails verification in the status message.
 * `namePattern`-only items match by filename (pre-existing files included) and
 * must yield a readable 7za listing matching every `expect` regex, so mid-copy
 * files or the wrong archive are never claimed. Items with neither never
 * match: guessing an unidentified file risks extracting it into the game root.
 * The deadline slides while the user is actively staging files (a file appears
 * or grows, or an item resolves).
 * Resolves to an array of local paths parallel to `wanted`.
 *
 *   wanted: [{ name, hash?, size?, namePattern?, expect? }]
 */
function waitForDownloads(wanted, onProgress, signal, intervalMs = 1000, timeoutMs = 900_000) {
  let deadline   = Date.now() + timeoutMs
  // The sliding deadline keeps an actively-staging user alive, but any churn
  // in the downloads folder (a crawling browser download, antivirus rewrites)
  // also slides it - so a wait whose wanted file can never match used to hang
  // forever, wedging the whole install. Hard cap: three timeout windows.
  const hardDeadline = Date.now() + timeoutMs * 3
  const found    = new Array(wanted.length).fill(null)
  const prevSize = new Map()    // full -> size at the previous scan; a changing size = mid-copy
  let mismatched = []           // settled files that look like a wanted mod but fail verification
  let progressed = false        // a file appeared/grew or an item resolved since the last tick

  // Per-candidate rejection log (dev log only). One line per item+file+reason,
  // re-emitted only when the reason changes, so a stuck wait explains itself
  // instead of ignoring files silently.
  const lastReason = new Map()  // `${i}:${full}` -> reason
  const why = (i, a, reason) => {
    const key = `${i}:${a.full}`
    if (lastReason.get(key) === reason) return
    lastReason.set(key, reason)
    _log(`[wait] "${wanted[i].name}" vs "${a.file}": ${reason}`)
  }

  const scan = async () => {
    const archives = listDownloadArchives()
    const settled  = a => prevSize.get(a.full) === a.st.size
    const consumed = new Set(found.filter(Boolean))
    const suspect  = []
    for (let i = 0; i < wanted.length; i++) {
      if (found[i]) continue
      const w = wanted[i]
      for (const a of archives) {
        if (w.hash) {
          if (!settled(a)) { why(i, a, 'size still changing - copy in progress'); continue }
          const nameHit = w.namePattern && w.namePattern.test(a.file)
          if (typeof w.size === 'number' && w.size > 0 && a.st.size !== w.size) {
            why(i, a, `size mismatch (want ${w.size}, file is ${a.st.size})${nameHit ? ' - name matches, so likely a different version' : ''}`)
            if (nameHit) suspect.push(a)
            continue
          }
          try {
            if (await hashCached(a.full, a.st) !== String(w.hash).toLowerCase()) {
              why(i, a, `sha256 mismatch${nameHit ? ' - name matches, so likely a different version' : ''}`)
              if (nameHit) suspect.push(a)
              continue
            }
          } catch { why(i, a, 'unreadable right now (locked?)'); continue }   // retry next tick
        } else if (w.namePattern) {
          if (consumed.has(a.full)) continue
          if (!w.namePattern.test(a.file)) { why(i, a, `filename does not match ${w.namePattern}`); continue }
          const listing = await listArchiveContents(a.full, a.st)   // null while locked or incomplete
          if (listing == null) { why(i, a, '7za could not list the archive (locked, incomplete, or not an archive)'); continue }
          const missing = [].concat(w.expect || []).filter(re => !re.test(listing))
          if (missing.length > 0) {   // right mod, wrong file (e.g. Part 1 vs 2)
            why(i, a, `archive lacks expected content: ${missing.map(re => re.source).join(', ')}`)
            if (settled(a)) suspect.push(a)
            continue
          }
        } else {
          continue
        }
        _log(`[wait] "${w.name}" matched by "${a.file}"`)
        found[i] = a.full
        consumed.add(a.full)
        progressed = true
        break
      }
    }
    mismatched = [...new Set(suspect.filter(a => !consumed.has(a.full)).map(a => a.file))]
    for (const a of archives) {
      if (prevSize.get(a.full) !== a.st.size) progressed = true // new file, or a copy still landing
      prevSize.set(a.full, a.st.size)
    }
  }

  return new Promise((resolve, reject) => {
    async function tick() {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      progressed = false
      try { await scan() } catch { /* transient fs error; retry next tick */ }
      if (progressed) deadline = Date.now() + timeoutMs        // the user is actively staging files
      const remaining = wanted.filter((_, i) => !found[i]).map(w => w.name || 'download')
      const note = mismatched.length
        ? ` (${mismatched.map(f => `${f} is not the exact file the server expects - download it through its link on the downloads page, which pins the right version; if that version is gone from Nexus the server admin must update the modlist`).join('; ')})`
        : ''
      if (onProgress) {
        onProgress(wanted.length - remaining.length, wanted.length,
          remaining.length ? `Waiting for downloads: ${remaining.join(', ')}${note}` : 'All downloads received')
      }
      if (remaining.length === 0) return resolve(found)
      if (Date.now() > deadline || Date.now() > hardDeadline) {
        return reject(new Error(`Timed out waiting to download: ${remaining.join(', ')}${note}`))
      }
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

// Creation Club quarantine (non-portable installs)

// Real CC files follow the ccXXXsseNNN- naming (e.g. ccBGSSSE001-Fish.esm).
// A bare cc* match would also catch community mods like CCOR.esp.
const CC_FILE_RE = /^cc[a-z]{3}sse\d{3}-.*\.(?:es[mlp]|bsa)$/i
// AE extras the engine force-loads without a plugins.txt entry.
const CC_EXTRAS  = new Set(['_resourcepack.esl', '_resourcepack.bsa', 'marketplacetextures.bsa'])

/**
 * Move Creation Club plugins/archives (plus the AE resource pack and
 * marketplace textures) out of <gamePath>/Data into "<gamePath>/disabled CC
 * mods". Non-portable installs play from the user's real Skyrim folder, where
 * the engine force-loads CC content via Skyrim.ccc regardless of plugins.txt
 * and fights the server's load order. Files named in serverLoadOrder are left
 * alone. Idempotent; returns the number of files moved.
 */
function disableCcContent(gamePath, serverLoadOrder) {
  const dataDir = path.join(gamePath, 'Data')
  const keep = new Set((serverLoadOrder || []).map(f => path.basename(f).toLowerCase()))
  let names = []
  try { names = fs.readdirSync(dataDir) } catch { return 0 }

  const destDir = path.join(gamePath, 'disabled CC mods')
  let moved = 0
  for (const name of names) {
    const l = name.toLowerCase()
    if (!(CC_FILE_RE.test(l) || CC_EXTRAS.has(l))) continue
    if (keep.has(l)) continue   // the server actually uses it - leave it alone
    try {
      fs.mkdirSync(lp(destDir), { recursive: true })
      fs.renameSync(lp(path.join(dataDir, name)), lp(path.join(destDir, name)))
      moved++
    } catch (err) {
      _log(`could not move ${name} to disabled CC mods: ${err.message}`)
    }
  }
  if (moved > 0) _log(`moved ${moved} Creation Club file(s) to ${destDir}`)
  return moved
}

// Launch

/** Launch the game through MO2's VFS using the SKSE executable entry. */
function launchGame(skyrimPath) {
  if (!isInstalled()) throw new Error('MO2 is not installed - run setup in Settings first.')
  // moshortcut://:SKSE only resolves against the ini's SKSE entry, so verify it and self-heal before spawning.
  const iniPath = path.join(getRoot(), 'ModOrganizer.ini')
  const hasShortcut = () => { try { return /^\d+\\title=SKSE\s*$/m.test(fs.readFileSync(iniPath, 'utf8')) } catch { return false } }
  if (!hasShortcut() && skyrimPath) ensureInstance(skyrimPath)
  if (!hasShortcut()) throw new Error('The MO2 SKSE shortcut is missing from ModOrganizer.ini - run Repair Modlist to repair it.')
  spawn(getExe(), ['-p', PROFILE, 'moshortcut://:SKSE'], {
    detached: true,
    stdio: 'ignore',
    cwd: getRoot(),
  }).unref()
}

/** Open the MO2 UI itself (for manual mod management / inspection). */
function openUI() {
  if (!isInstalled()) throw new Error('MO2 is not installed.')
  spawn(getExe(), ['-p', PROFILE], { detached: true, stdio: 'ignore', cwd: getRoot() }).unref()
}

// Status

function getStatus() {
  let modCount = 0
  try { modCount = fs.readdirSync(getModsDir(), { withFileTypes: true }).filter(e => e.isDirectory()).length }
  catch {}
  return {
    installed: isInstalled(),
    version:   MO2_VERSION,
    root:      getRoot(),
    modCount,
  }
}

module.exports = {
  setLogger,
  setRootProvider,
  PROFILE,
  MO2_VERSION,
  MO2_STAMP,
  getRoot,
  detectEdition,
  getDownloadsDir,
  getModsDir,
  getProfileDir,
  isInstalled,
  ensureInstalled,
  reinstall,
  archiveTopLevelNames,
  removeRootEntries,
  mo2BinaryStats,
  readMo2Stamp,
  ensureInstance,
  registerNxmHandler,
  downloadToDownloads,
  findDownloadByFileId,
  findArchiveByHash,
  verifyArchive,
  sha256File,
  sha256FileAsync,
  listFilesRel,
  lp,
  extractToCache,
  clearCache,
  clearBuildCache,
  applyMod,
  readModHash,
  modFolderSize,
  isManaged,
  readMetaName,
  applyRootFiles,
  setModlistOrder,
  listStaleManagedMods,
  serverPluginLines,
  setPlugins,
  skseSourceFor,
  installSkse,
  enforceModRules,
  listOverwriteJunk,
  cleanOverwrite,
  listArchiveContents,
  parseArchiveListing,
  listArchiveEntries,
  waitForDownloads,
  disableCcContent,
  launchGame,
  openUI,
  getStatus,
}
