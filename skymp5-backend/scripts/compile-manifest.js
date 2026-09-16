'use strict'

/**
 * Compile an install manifest from a reference MO2 install.
 * Author overrides live in data/manifest-sources.json (all optional):
 *   { "urls": { "<archiveName>": "https://direct-download/…" }, "rootInclude": ["skse64_loader.exe", …],
 *     "creations": { "plugins": ["ccBGSSSE001-Fish.esm", …], "searchDirs": ["Data", …], "extraAccept": { "<file>": [{ "sha256", "size" }] } } }
 * `urls` gives a download source to non-Nexus archives; `rootInclude` lists
 * game-root files to capture (skse64_*.exe/.dll are picked up automatically).
 * `creations` names Creation Club plugins every Skyrim SE 1.6 install carries: they are hashed from --game, never
 * redistributed, and the launcher copies them out of the player's own game; `extraAccept` adds known store copies.
 */

const fs      = require('fs')
const path    = require('path')
const crypto  = require('crypto')
const zlib    = require('zlib')
const { execFileSync } = require('child_process')
// Prefer a full 7-Zip: the standalone 7za from 7zip-bin has no Rar codec, so
// .rar downloads would be silently skipped and their mods inlined instead.
const SEVEN = [process.env.ALDUINAK_7Z, 'C:\\Program Files\\7-Zip\\7z.exe']
  .find(p => p && fs.existsSync(p)) || require('7zip-bin').path7za

// Args

function parseArgs(argv) {
  const a = { profile: 'Alduinak' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if      (k === '--mo2')     a.mo2     = argv[++i]
    else if (k === '--game')    a.game    = argv[++i]
    else if (k === '--profile') a.profile = argv[++i]
    else if (k === '--out')     a.out     = argv[++i]
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
if (!args.mo2) {
  console.error('Usage: node scripts/compile-manifest.js --mo2 <MO2 root> [--game <game root>] [--profile Alduinak]')
  process.exit(1)
}

const MO2         = path.resolve(args.mo2)
const DOWNLOADS   = path.join(MO2, 'downloads')
const MODS        = path.join(MO2, 'mods')
const PROFILE_DIR = path.join(MO2, 'profiles', args.profile)
const DATA_DIR    = path.join(__dirname, '..', 'data')
const OUT         = args.out ? path.resolve(args.out) : path.join(DATA_DIR, 'install-manifest.json')
const MODLIST_OUT = path.join(DATA_DIR, 'modlist.json')

// Where the launcher looks for Creation files, relative to the game root; Keizaal's launcher parks them in disabled_by_kzl
const CREATION_SEARCH_DIRS = ['Data', 'Data/disabled_by_kzl', 'disabled_by_kzl', 'disabled CC mods']
const CREATION_TITLES = {
  'ccbgssse001-fish.esm': 'Fishing',
  'ccqdrsse001-survivalmode.esl': 'Survival Mode',
  'ccbgssse037-curios.esl': 'Rare Curios',
  'ccbgssse025-advdsgs.esm': 'Saints & Seducers',
}

// AlduinakCreations.esp copies whole cells, worldspaces and reverted records out of the plugins before it; its build pins them
const CREATIONS_PLUGIN = 'AlduinakCreations.esp'
const CREATIONS_INPUTS = 'AlduinakCreations.inputs.json'
const VANILLA_MASTERS = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'])

const INLINE_WARN = 50 * 1024 * 1024   // warn when inlining anything this large
// Hard cap on total inlined base64: the launcher parses the manifest as one
// JSON string, which V8 caps at ~512 MB. Fail fast with the offenders listed
// rather than shipping a manifest no client can read.
const MAX_INLINE_TOTAL = 384 * 1024 * 1024

let sources = { urls: {}, rootInclude: [] }
try {
  sources = { urls: {}, rootInclude: [], ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest-sources.json'), 'utf8')) }
} catch { /* optional */ }

// Hash helpers

function sha256Buf(buf)  { return crypto.createHash('sha256').update(buf).digest('hex') }

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(p)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

// Streaming sha256 + CRC32 + size: mod folders hold multi-GB BSAs, so file
// contents must never be loaded into memory just to hash them.
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    let crc = 0, size = 0
    fs.createReadStream(p)
      .on('data', d => { h.update(d); crc = zlib.crc32(d, crc); size += d.length })
      .on('end', () => resolve({
        sha: h.digest('hex'),
        crc: (crc >>> 0).toString(16).toUpperCase().padStart(8, '0'),
        size,
      }))
      .on('error', reject)
  })
}

// FS helpers

/** Recursively list files under dir as forward-slash paths relative to base. */
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

/** Read a download's .meta sidecar for Nexus mod/file ids. */
function readDownloadMeta(name) {
  try {
    const meta   = fs.readFileSync(path.join(DOWNLOADS, name + '.meta'), 'utf8')
    const modId  = (meta.match(/^modID\s*=\s*(\d+)/im)  || [])[1]
    const fileId = (meta.match(/^fileID\s*=\s*(\d+)/im) || [])[1]
    return { modId: modId ? Number(modId) : 0, fileId: fileId ? Number(fileId) : 0 }
  } catch { return { modId: 0, fileId: 0 } }
}

/** Read a mod folder's MO2 meta.ini for its Nexus mod id. */
function readModId(modDir) {
  try {
    const id = (fs.readFileSync(path.join(modDir, 'meta.ini'), 'utf8').match(/^modid\s*=\s*(\d+)/im) || [])[1]
    return id ? Number(id) : 0
  } catch { return 0 }
}

/** List archive entries as [{ path, size, crc }] (files only, with a CRC). */
function listEntries(archivePath) {
  const out = execFileSync(SEVEN, ['l', '-slt', '-ba', archivePath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  })
  const entries = []
  let cur = null
  const push = () => { if (cur && cur.path) entries.push(cur) }
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('Path = '))        { push(); cur = { path: line.slice(7), size: 0, crc: '', folder: false } }
    else if (cur && line.startsWith('Size = '))   cur.size   = parseInt(line.slice(7), 10) || 0
    else if (cur && line.startsWith('CRC = '))    cur.crc    = line.slice(6).trim()
    else if (cur && line.startsWith('Folder = ')) cur.folder = line.slice(9).trim() === '+'
  }
  push()
  return entries
    .filter(e => e.crc && !e.folder)
    .map(e => ({ path: e.path.split('\\').join('/'), size: e.size, crc: e.crc }))
}

// Write the manifest incrementally: JSON.stringify of the whole object dies
// with "Invalid string length" once inlined files push it past V8's ~512 MB
// string cap, so each directive is stringified on its own.
function writeManifestFile(out, m) {
  const fd = fs.openSync(out, 'w')
  const w = s => fs.writeSync(fd, s)
  const writeFiles = list => list.forEach((f, i) => { if (i) w(','); w(JSON.stringify(f)) })
  try {
    w('{"schema":' + JSON.stringify(m.schema))
    w(',"builtAt":' + JSON.stringify(m.builtAt))
    w(',"game":' + JSON.stringify(m.game))
    w(',"archives":' + JSON.stringify(m.archives))
    w(',"mods":[')
    m.mods.forEach((mod, i) => {
      if (i) w(',')
      w('{"name":' + JSON.stringify(mod.name) + ',"modId":' + JSON.stringify(mod.modId) + ',"files":[')
      writeFiles(mod.files)
      w('],"hash":' + JSON.stringify(mod.hash) + '}')
    })
    w('],"order":' + JSON.stringify(m.order))
    w(',"plugins":' + JSON.stringify(m.plugins))
    if (m.creations) w(',"creations":' + JSON.stringify(m.creations))
    w(',"root":[')
    writeFiles(m.root)
    w('],"rootHash":' + JSON.stringify(m.rootHash) + '}')
  } finally {
    fs.closeSync(fd)
  }
}

// Creation Club files: a plugin is accepted only by sha256 and size, its archives by name (the launcher logs a mismatch)
async function creationsSection() {
  const c = sources.creations
  if (!c || !Array.isArray(c.plugins) || c.plugins.length === 0) return null
  if (!args.game) throw new Error('manifest-sources.json lists creations: pass --game <game root> so their files can be hashed')
  const data = path.join(path.resolve(args.game), 'Data')
  const extra = c.extraAccept || {}
  const files = []
  for (const plugin of c.plugins) {
    const base = plugin.replace(/\.es[mlp]$/i, '')
    for (const name of [plugin, `${base}.bsa`, `${base} - Textures.bsa`]) {
      const full = path.join(data, name)
      if (!fs.existsSync(full)) {
        if (name === plugin) throw new Error(`creation plugin missing from ${data}: ${name}`)
        continue
      }
      const { sha, size } = await hashFile(full)
      const accept = [{ sha256: sha, size }, ...(Array.isArray(extra[name]) ? extra[name] : [])]
      files.push({ name, plugin, to: `Data/${name}`, kind: name === plugin ? 'plugin' : 'archive', title: CREATION_TITLES[plugin.toLowerCase()] || base, accept })
      console.log(`  creation ${name} (${(size / 1048576).toFixed(1)} MB, sha256 ${sha.slice(0, 16)}…)`)
    }
  }
  const hash = sha256Buf(Buffer.from(files.map(f => `${f.name}:${f.accept.map(a => `${a.sha256}/${a.size}`).join(',')}`).join('\n')))
  return { plugins: c.plugins, searchDirs: Array.isArray(c.searchDirs) ? c.searchDirs : CREATION_SEARCH_DIRS, files, hash }
}

// Refuses to publish an AlduinakCreations.esp built against other plugins than the ones this manifest loads before it
function checkCreationsInputs(mods, plugins, creations, inputsFiles) {
  const provider = new Map()
  for (const m of mods) {
    for (const f of m.files) {
      const key = f.to.toLowerCase()
      if (!key.includes('/') && !provider.has(key)) provider.set(key, { sha256: f.sha256, mod: m.name })
    }
  }
  for (const f of (creations && creations.files) || []) {
    if (f.kind === 'plugin') provider.set(f.name.toLowerCase(), { sha256: f.accept[0].sha256, mod: 'the game' })
  }
  const own = provider.get(CREATIONS_PLUGIN.toLowerCase())
  if (!own) return
  const fail = why => {
    throw new Error(`${CREATIONS_PLUGIN} in mod "${own.mod}" ${why}. It copies whole cells and worldspaces from the plugins loaded before it: ` +
      `rebuild it with misc/proficiency-patcher and copy the new plugin and ${CREATIONS_INPUTS} into that mod (docs/docs_roleplay_creations_and_needs.md)`)
  }
  const file = inputsFiles.get(own.mod)
  if (!file) fail(`has no ${CREATIONS_INPUTS} next to it`)
  let pinned
  try { pinned = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) { fail(`has an unreadable ${CREATIONS_INPUTS} (${err.message})`) }
  if (pinned.sha256 !== own.sha256) fail(`does not match its ${CREATIONS_INPUTS}, which belongs to another build`)
  const enabled = plugins.filter(l => l.startsWith('*')).map(l => l.slice(1).trim())
  const at = enabled.findIndex(n => n.toLowerCase() === CREATIONS_PLUGIN.toLowerCase())
  if (at < 0 || at !== enabled.length - 1) fail('is not the last enabled plugin in plugins.txt')
  const before = enabled.slice(0, at).filter(n => !VANILLA_MASTERS.has(n.toLowerCase()))
  const inputs = Array.isArray(pinned.inputs) ? pinned.inputs : []
  const built = inputs.map(i => String(i.name))
  const differs = before.findIndex((n, k) => n.toLowerCase() !== (built[k] || '').toLowerCase())
  if (differs >= 0 || before.length !== built.length) {
    const k = differs >= 0 ? differs : Math.min(before.length, built.length)
    fail(`was built for another load order: plugin ${k + 1} after the vanilla masters is ${before[k] || 'none'} here and was ${built[k] || 'none'} in the build`)
  }
  const stale = inputs
    .map(i => ({ name: i.name, was: String(i.sha256), now: (provider.get(i.name.toLowerCase()) || {}).sha256 || 'missing' }))
    .filter(i => i.was !== i.now)
  if (stale.length) fail(`is stale, ${stale.length} plugin(s) changed since its build: ${stale.map(i => `${i.name} (built ${i.was.slice(0, 8)}, now ${i.now.slice(0, 8)})`).join(', ')}`)
  console.log(`  ${CREATIONS_PLUGIN}: built against the ${built.length} plugins this manifest loads before it`)
}

// Main

async function main() {
  if (!fs.existsSync(MODS)) throw new Error(`mods folder not found: ${MODS}`)

  // 1. Index every archive's entries by (size, CRC32)
  const archives = []                 // { id, hash, size, name, source, _entries }
  const index    = new Map()          // "size:CRC" -> { id, from }
  const referenced = new Set()

  const dlNames = fs.existsSync(DOWNLOADS)
    ? fs.readdirSync(DOWNLOADS).filter(n => !/\.(meta|unfinished)$/i.test(n))
    : []

  for (const name of dlNames) {
    const full = path.join(DOWNLOADS, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue

    let entries
    try { entries = listEntries(full) }
    catch { console.warn(`  skipped ${name}: cannot list as archive (unsupported format?)`); continue }
    if (entries.length === 0) continue

    const meta = readDownloadMeta(name)
    let source
    // An explicit URL override wins over the Nexus meta: it is the escape
    // hatch for files whose Nexus pin has died (author removed the version).
    if (sources.urls[name])             source = { type: 'url', url: sources.urls[name] }
    else if (meta.modId && meta.fileId) source = { type: 'nexus', modId: meta.modId, fileId: meta.fileId }
    else                                source = { type: 'manual', name }

    const id   = 'a' + (archives.length + 1)
    const hash = await sha256File(full)
    archives.push({ id, hash, size: st.size, name, source })

    for (const e of entries) {
      // Every empty file shares one size+crc key, so indexing them makes an
      // unrelated archive the source for any mod's empty files. They cost
      // nothing inline, so leave them out and let directiveFor emit them.
      if (e.size === 0) continue
      const key = e.size + ':' + e.crc
      if (!index.has(key)) index.set(key, { id, from: e.path })   // first archive wins
    }
    console.log(`  indexed ${name} (${entries.length} entries, ${source.type})`)
  }

  // 2. Resolve the enabled mod order + plugin load order from the profile
  let order = []
  try {
    order = fs.readFileSync(path.join(PROFILE_DIR, 'modlist.txt'), 'utf8')
      .split(/\r?\n/)
      .filter(l => l.startsWith('+') || (l.startsWith('-') && l.slice(1).trim().endsWith('_separator')))
      .map(l => l.slice(1).trim())
      .filter(Boolean)
  } catch { /* no profile: fall back to every folder below */ }

  if (order.length === 0) {
    order = fs.readdirSync(MODS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    console.warn(`No profiles/${args.profile}/modlist.txt found - using all ${order.length} mod folders (unordered).`)
  }

  // plugins.txt: the esp/esm load order (MO2's "*" prefix marks an enabled plugin).
  let plugins = []
  try {
    plugins = fs.readFileSync(path.join(PROFILE_DIR, 'plugins.txt'), 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  } catch { /* no plugins.txt: load order then comes from the server at launch */ }

  // The Creations load right after the vanilla masters in Skyrim.ccc order, whatever the MO2 profile says
  const creations = await creationsSection()
  if (creations) {
    const own = new Set(creations.plugins.map(p => p.toLowerCase()))
    plugins = [...creations.plugins.map(p => `*${p}`), ...plugins.filter(l => !own.has(l.replace(/^[*+-]/, '').trim().toLowerCase()))]
  }

  // 3. Emit a directive per file in each mod folder
  const mods = []
  const inlineWarnings = []

  // Stable per-mod content fingerprint so the launcher reinstalls only mods that actually changed on rebuild
  const contentHash = files =>
    sha256Buf(Buffer.from(files.map(f => `${f.to}:${f.sha256}`).sort().join('\n')))

  // Inline accounting for the MAX_INLINE_TOTAL guard.
  let inlineTotal = 0
  const inlineByLabel = new Map()

  async function directiveFor(absFile, toRel, label) {
    const { sha, crc, size } = await hashFile(absFile)
    const hit = index.get(size + ':' + crc)
    if (hit) {
      referenced.add(hit.id)
      return { to: toRel, archive: hit.id, from: hit.from, sha256: sha, size }
    }
    if (size > INLINE_WARN) inlineWarnings.push(`${toRel} (${(size / 1048576).toFixed(0)} MB)`)
    const inline = fs.readFileSync(absFile).toString('base64')
    inlineTotal += inline.length
    inlineByLabel.set(label, (inlineByLabel.get(label) || 0) + inline.length)
    return { to: toRel, inline, sha256: sha, size }
  }

  const inputsFiles = new Map()
  for (const modName of order) {
    const modDir = path.join(MODS, modName)
    if (!fs.existsSync(modDir)) continue
    const all = walk(modDir)
    if (all.some(r => r.toLowerCase() === CREATIONS_INPUTS.toLowerCase())) inputsFiles.set(modName, path.join(modDir, CREATIONS_INPUTS))
    // The inputs file is build metadata for the check below, never installed
    const rels = all.filter(r => r.toLowerCase() !== 'meta.ini' && r.toLowerCase() !== CREATIONS_INPUTS.toLowerCase())
    if (rels.length === 0) continue

    const files = []
    for (const rel of rels) {
      files.push(await directiveFor(path.join(modDir, rel.split('/').join(path.sep)), rel, modName))
    }
    mods.push({ name: modName, modId: readModId(modDir), files, hash: contentHash(files) })
  }

  checkCreationsInputs(mods, plugins, creations, inputsFiles)

  // 4. Optional game-root files (preloaders, etc.)
  const root = []
  if (args.game) {
    const gameRoot = path.resolve(args.game)
    for (const rel of new Set(sources.rootInclude || [])) {
      const full = path.join(gameRoot, rel.split('/').join(path.sep))
      if (!fs.existsSync(full)) { console.warn(`rootInclude not found, skipping: ${rel}`); continue }
      root.push(await directiveFor(full, rel, 'root'))
    }
  }

  // Fail fast when the inline volume would produce a manifest the launcher
  // cannot parse - name the offending mods so the fix is obvious.
  if (inlineTotal > MAX_INLINE_TOTAL) {
    const top = [...inlineByLabel.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([n, b]) => `  - ${n}: ${(b / 1048576).toFixed(0)} MB inlined`).join('\n')
    throw new Error(
      `manifest would inline ${(inlineTotal / 1048576).toFixed(0)} MB of base64 ` +
      `(limit ${(MAX_INLINE_TOTAL / 1048576).toFixed(0)} MB). ` +
      'Add the missing source archives to downloads\\ (or "urls" in data/manifest-sources.json) for:\n' + top)
  }

  // 5. Write the manifest (only referenced archives carry over)
  const usedArchives = archives
    .filter(a => referenced.has(a.id))
    .map(({ id, hash, size, name, source }) => ({ id, hash, size, name, source }))

  const manifest = {
    // Launchers that predate a schema refuse it; the install-manifest route answers them with an update message
    schema:  creations ? 3 : 2,
    builtAt: new Date().toISOString(),
    game:    'skyrimspecialedition',
    archives: usedArchives,
    mods,
    order,      // full modlist.txt order, separators included
    plugins,    // plugins.txt load order
    creations,
    root,
    rootHash: contentHash(root),
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  writeManifestFile(OUT, manifest)

  // Lightweight display list so /api/modlist (the launcher's Modlist panel) keeps its shape without a second source of truth
  const display = [
    { name: 'SkyMP Client', required: true, enabled: true, source: 'backend' },
    ...mods.map(m => ({
      name: m.name, required: true, enabled: true,
      source: m.modId ? 'nexus' : 'url',
      ...(m.modId ? { nexusId: m.modId } : {}),
    })),
  ]
  fs.writeFileSync(MODLIST_OUT, JSON.stringify(display, null, 2) + '\n')

  // Report
  const inlineCount = mods.reduce((n, m) => n + m.files.filter(f => f.inline != null).length, 0) +
                      root.filter(f => f.inline != null).length
  console.log(`\narchives:    ${usedArchives.length} referenced (${archives.length} scanned)`)
  console.log(`mods:        ${mods.length}`)
  console.log(`separators:  ${order.filter(n => n.endsWith('_separator')).length}`)
  console.log(`plugins:     ${plugins.length}`)
  console.log(`creations:   ${creations ? `${creations.plugins.length} plugins, ${creations.files.length} files (schema 3)` : 'none'}`)
  console.log(`root files:  ${root.length}`)
  console.log(`directives:  ${mods.reduce((n, m) => n + m.files.length, 0) + root.length} (${inlineCount} inline)`)

  const manual = usedArchives.filter(a => a.source.type === 'manual')
  if (manual.length) {
    console.warn('\nReferenced archives with NO download source - the launcher cannot fetch these.')
    console.warn('Add a URL for each in data/manifest-sources.json ("urls"):')
    for (const a of manual) console.warn(`  - ${a.name}`)
  }
  if (inlineWarnings.length) {
    console.warn('\nLarge files were inlined (bloats the manifest - add the source archive to downloads\\):')
    for (const w of inlineWarnings) console.warn(`  - ${w}`)
  }

  console.log(`\nWrote ${OUT}`)
  console.log(`Wrote ${MODLIST_OUT}`)
}

main().catch(err => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
