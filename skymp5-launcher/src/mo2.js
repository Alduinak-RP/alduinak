'use strict'

/**
 * Mod Organizer 2 integration - portable install fully managed by the launcher.
 *
 *   %LOCALAPPDATA%\SkyRP\MO2\
 *     ModOrganizer.exe          downloaded from the official MO2 release
 *     ModOrganizer.ini          portable instance config (written by us)
 *     nxmhandler.ini            nxm:// → this MO2 instance
 *     downloads\                Nexus "Mod Manager Download" archives land here
 *     mods\<Mod Name>\          installed mods (assembled from the manifest)
 *     profiles\SkyRP\           the single launcher-managed profile
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
const PROFILE     = 'SkyRP'

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
  return path.join(local, 'SkyRP', 'MO2')
}

const getExe          = () => path.join(getRoot(), 'ModOrganizer.exe')
const getDownloadsDir = () => path.join(getRoot(), 'downloads')
const getModsDir      = () => path.join(getRoot(), 'mods')
const getProfileDir   = () => path.join(getRoot(), 'profiles', PROFILE)

function isInstalled() {
  return fs.existsSync(getExe())
}

// 7za ships inside the 7zip-bin npm package
function get7za() {
  const sevenBin = require('7zip-bin')
  return sevenBin.path7za.replace('app.asar', 'app.asar.unpacked')
}

// Download / install MO2

/** Download url to dest, following redirects (GitHub releases redirect to a CDN). */
function downloadFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
        return resolve(downloadFile(res.headers.location, dest, onProgress, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
      }

      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const file = fs.createWriteStream(dest)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', err => { try { fs.unlinkSync(dest) } catch {} reject(err) })
      res.on('error',  err => { try { fs.unlinkSync(dest) } catch {} reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('Download timed out')) })
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

/**
 * Download and unpack MO2 itself. Resolves immediately if already installed.
 * onProgress(message) receives human-readable status lines.
 */
async function ensureInstalled(onProgress) {
  if (isInstalled()) return

  const root    = getRoot()
  const archive = path.join(os.tmpdir(), `mo2-${MO2_VERSION}.7z`)

  _log(`installing MO2 ${MO2_VERSION} to ${root}`)
  if (onProgress) onProgress('Downloading Mod Organizer 2…')

  await downloadFile(MO2_URL, archive, (received, total) => {
    if (onProgress && total > 0) {
      const mb = n => (n / 1024 / 1024).toFixed(1)
      onProgress(`Downloading Mod Organizer 2… ${mb(received)} / ${mb(total)} MB`)
    }
  })

  if (onProgress) onProgress('Extracting Mod Organizer 2…')
  extractArchive(archive, root)
  try { fs.unlinkSync(archive) } catch {}

  if (!isInstalled()) {
    throw new Error('MO2 extraction finished but ModOrganizer.exe was not found.')
  }
  _log('MO2 installed')
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
    ...(style ? [`style=${style}`] : []),
    '',
    '[customExecutables]',
    'size=1',
    '1\\title=SKSE',
    `1\\binary=${fwd(path.join(skyrimPath, 'skse64_loader.exe'))}`,
    `1\\workingDirectory=${fwd(skyrimPath)}`,
    '1\\arguments=',
    '1\\hide=false',
    '1\\toolbar=true',
    '1\\ownicon=true',
    '',
  ].join('\r\n')
}

// Update only the path lines in an existing ini so a moved install still
// launches, without touching gameEdition or any other MO2-written state.
function healInstancePaths(iniPath, skyrimPath) {
  const gamePath = fwd(skyrimPath)
  const ssePath  = fwd(path.join(skyrimPath, 'skse64_loader.exe'))
  let txt = fs.readFileSync(iniPath, 'utf8')
  // Function replacers avoid '$' in paths being treated as replacement tokens.
  txt = txt.replace(/^gamePath=.*$/m,            () => `gamePath=@ByteArray(${gamePath})`)
  txt = txt.replace(/^1\\binary=.*$/m,           () => `1\\binary=${ssePath}`)
  txt = txt.replace(/^1\\workingDirectory=.*$/m, () => `1\\workingDirectory=${gamePath}`)
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
 * Create or refresh the portable instance config and the SkyRP profile.
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
    const vanilla = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'])
    const lines = loadOrder
      .map(f => path.basename(f))
      .filter(f => !vanilla.has(f.toLowerCase()))
      .map(f => `*${f}`)
    fs.writeFileSync(pluginsPath,
      '# This file was automatically generated by Mod Organizer.\r\n' + lines.join('\r\n') + '\r\n')
  } else if (!fs.existsSync(pluginsPath)) {
    fs.writeFileSync(pluginsPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }
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
  await downloadFile(url, temp, onProgress)
  fs.renameSync(temp, dest)
  return fileName
}

// Manifest install (deterministic replay)

/**
 * Extract an archive into a per-run cache dir (.x/<archiveId>) and return its
 * path. Re-extraction is skipped if the cache already exists this run.
 */
function extractToCache(archivePath, archiveId) {
  const dir = path.join(getRoot(), '.x', String(archiveId))
  if (!fs.existsSync(lp(dir))) extractArchive(archivePath, dir)
  return dir
}

/** Remove a cached extraction (or the whole .x cache when no id is given). */
function clearCache(archiveId) {
  const dir = archiveId == null ? path.join(getRoot(), '.x') : path.join(getRoot(), '.x', String(archiveId))
  try { fs.rmSync(lp(dir), { recursive: true, force: true }) } catch {}
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

  try { fs.rmSync(lp(buildDir), { recursive: true, force: true }) } catch {}
  try {
    for (const f of files) writeDirective(f, buildDir, extractedDirs)

    fs.writeFileSync(lp(path.join(buildDir, 'meta.ini')), [
      '[General]', 'gameName=SkyrimSE', `modid=${modId || 0}`, `name=${folderName}`,
      'repository=Nexus', 'skyrpManaged=true', `skyrpHash=${hash || ''}`, '',
    ].join('\r\n'))

    try { fs.rmSync(lp(modDir), { recursive: true, force: true }) } catch {}
    fs.mkdirSync(lp(path.dirname(modDir)), { recursive: true })
    fs.renameSync(lp(buildDir), lp(modDir))
    _log(`installed ${folderName} (${files.length} file(s))`)
    return { folder: folderName }
  } catch (err) {
    try { fs.rmSync(lp(buildDir), { recursive: true, force: true }) } catch {}
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
        ['[General]', 'gameName=SkyrimSE', 'modid=0', `name=${name}`, 'skyrpManaged=true', ''].join('\r\n'))
    }
  }

  // Reconcile the previous modlist against the new manifest:
  //  - genuine user-added mods (not launcher-managed) are kept below ours;
  //  - launcher-managed mods that dropped out of the manifest are stale - their
  //    folder is deleted and their line removed, so changes apply without a
  //    full reinstall.
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let userLines = []
  try {
    const leftover = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/)
      .filter(l => /^[+-]/.test(l) && !managed.has(l.slice(1).trim()))
    for (const line of leftover) {
      const name = line.slice(1).trim()
      if (isManaged(name)) {
        try { fs.rmSync(lp(path.join(getModsDir(), name)), { recursive: true, force: true }) } catch {}
        _log(`removed stale managed mod (no longer in manifest): ${name}`)
      } else {
        userLines.push(line)
      }
    }
  } catch { /* first install */ }

  const lines = [
    '# This file was automatically generated by Mod Organizer.',
    ...order.map(n => `+${n}`),
    ...userLines,
  ]
  fs.writeFileSync(modlistPath, lines.join('\r\n') + '\r\n')
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
        ['[General]', 'gameName=SkyrimSE', 'modid=0', 'name=SKSE', 'repository=', 'skyrpManaged=true', ''].join('\r\n'))
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
    return /^skyrpManaged\s*=\s*true/im.test(fs.readFileSync(path.join(getModsDir(), modName, 'meta.ini'), 'utf8'))
  } catch { return false }
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
    return (meta.match(/^skyrpHash\s*=\s*(.*)$/im) || [])[1]?.trim() || ''
  } catch { return '' }
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

/**
 * Disable any user-added mod that ships a plugin or an SKSE plugin DLL, so only
 * the server's modpack content can load (prevents desync and SKSE-plugin
 * cheats). Launcher-managed mods and separators are always kept; texture/mesh-
 * only user mods stay enabled. Returns the names that were disabled.
 */
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
    for (const key of cache.keys()) if (!present.has(key)) cache.delete(key)
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
function listArchiveContents(archivePath, st) {
  const c = _archiveListCache.get(archivePath)
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return Promise.resolve(c.listing)
  return new Promise(resolve => {
    execFile(get7za(), ['l', lp(archivePath)],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        _archiveListCache.set(archivePath, { size: st.size, mtimeMs: st.mtimeMs, listing: stdout })
        resolve(stdout)
      })
  })
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
function launchGame() {
  if (!isInstalled()) throw new Error('MO2 is not installed - run setup in Settings first.')
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
  getRoot,
  getDownloadsDir,
  getModsDir,
  getProfileDir,
  isInstalled,
  ensureInstalled,
  ensureInstance,
  registerNxmHandler,
  downloadToDownloads,
  findDownloadByFileId,
  findArchiveByHash,
  verifyArchive,
  sha256File,
  extractToCache,
  clearCache,
  applyMod,
  readModHash,
  applyRootFiles,
  setModlistOrder,
  setPlugins,
  skseSourceFor,
  installSkse,
  enforceModRules,
  waitForDownloads,
  disableCcContent,
  launchGame,
  openUI,
  getStatus,
}
