'use strict'

/**
 * Compile data/manifest.json from a reference MO2 install (format in sources/manifestFormat.js).
 * Author overrides live in data/manifest-sources.json (all optional):
 *   { "urls": { "<archiveName>": "https://direct-download/…" }, "rootInclude": ["d3dx9_42.dll", …],
 *     "creations": { "plugins": ["ccBGSSSE001-Fish.esm", …], "searchDirs": ["Data", …], "extraAccept": { "<file>": [{ "sha256", "size" }] } } }
 * `urls` gives a download source to non-Nexus archives; `rootInclude` lists game-root files to capture.
 * `creations` names Creation Club plugins every Skyrim SE 1.6 install carries: they are hashed from --game, never
 * redistributed, and the launcher copies them out of the player's own game; `extraAccept` adds known store copies.
 * Files found in no archive are packed into one extras archive the backend serves from /files/extras.
 */

const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const crypto  = require('crypto')
const zlib    = require('zlib')
const { execFileSync } = require('child_process')
const config  = require('../config')
const { MANIFEST_NAME } = require('../sources/manifestFormat')
const { readVersions } = require('../sources/versions')
// Prefer a full 7-Zip: the standalone 7za from 7zip-bin has no Rar codec, so .rar downloads would be skipped
const SEVEN = [process.env.ALDUINAK_7Z, 'C:\\Program Files\\7-Zip\\7z.exe']
  .find(p => p && fs.existsSync(p)) || require('7zip-bin').path7za

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
  console.error('Usage: node scripts/compile-manifest.js --mo2 <MO2 root> [--game <game root>] [--profile Alduinak] [--out <file>]')
  process.exit(1)
}

const MO2         = path.resolve(args.mo2)
const DOWNLOADS   = path.join(MO2, 'downloads')
const MODS        = path.join(MO2, 'mods')
const PROFILE_DIR = path.join(MO2, 'profiles', args.profile)
const DATA_DIR    = path.join(__dirname, '..', 'data')
const OUT         = args.out ? path.resolve(args.out) : path.join(DATA_DIR, MANIFEST_NAME)
const MODLIST_OUT = path.join(DATA_DIR, 'modlist.json')
const EXTRAS_DIR  = path.join(config.clientFilesDir, 'extras')
const PUBLIC_API  = (process.env.PUBLIC_API_URL || 'https://api.alduinak.com').replace(/\/+$/, '')

// Where the launcher looks for Creation files, relative to the game root; Keizaal's launcher parks them in _disabledByKzl
const CREATION_SEARCH_DIRS = ['Data', 'Data/_disabledByKzl', '_disabledByKzl', 'Data/disabled_by_kzl', 'disabled CC mods']
const CREATION_TITLES = {
  'ccbgssse001-fish.esm': 'Fishing',
  'ccqdrsse001-survivalmode.esl': 'Survival Mode',
  'ccbgssse037-curios.esl': 'Rare Curios',
  'ccbgssse025-advdsgs.esm': 'Saints & Seducers',
}

// The launcher writes the client settings on every launch; a mod copy would shadow it under MO2
const CLIENT_SETTINGS_FILE = 'skymp5-client-settings.txt'

let sources = { urls: {}, rootInclude: [] }
try {
  sources = { urls: {}, rootInclude: [], ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest-sources.json'), 'utf8')) }
} catch { /* optional */ }

const sha256Buf = buf => crypto.createHash('sha256').update(buf).digest('hex')

// Streaming sha256 + CRC32 + size: mod folders hold multi-GB BSAs
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    let crc = 0, size = 0
    fs.createReadStream(p)
      .on('data', d => { h.update(d); crc = zlib.crc32(d, crc); size += d.length })
      .on('end', () => resolve({ sha: h.digest('hex'), crc: (crc >>> 0).toString(16).toUpperCase().padStart(8, '0'), size }))
      .on('error', reject)
  })
}

// Every file under dir as a forward-slash path relative to base
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

// A download's .meta sidecar: Nexus mod and file ids
function readDownloadMeta(name) {
  try {
    const meta = fs.readFileSync(path.join(DOWNLOADS, name + '.meta'), 'utf8')
    const num = re => Number((meta.match(re) || [])[1] || 0)
    return { modId: num(/^modID\s*=\s*(\d+)/im), fileId: num(/^fileID\s*=\s*(\d+)/im) }
  } catch { return { modId: 0, fileId: 0 } }
}

// A mod folder's MO2 meta.ini: Nexus mod id and version
function readModMeta(modDir) {
  try {
    const meta = fs.readFileSync(path.join(modDir, 'meta.ini'), 'utf8')
    return { modId: Number((meta.match(/^modid\s*=\s*(\d+)/im) || [])[1] || 0), version: ((meta.match(/^version\s*=\s*(.*)$/im) || [])[1] || '').trim() }
  } catch { return { modId: 0, version: '' } }
}

// Archive entries as [{ path, size, crc }], files only
function listEntries(archivePath) {
  const out = execFileSync(SEVEN, ['l', '-slt', '-ba', archivePath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60 * 1000 })
  const entries = []
  let cur = null
  const push = () => { if (cur && cur.path) entries.push(cur) }
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('Path = '))               { push(); cur = { path: line.slice(7), size: 0, crc: '', folder: false } }
    else if (cur && line.startsWith('Size = '))   cur.size   = parseInt(line.slice(7), 10) || 0
    else if (cur && line.startsWith('CRC = '))    cur.crc    = line.slice(6).trim()
    else if (cur && line.startsWith('Folder = ')) cur.folder = line.slice(9).trim() === '+'
  }
  push()
  return entries.filter(e => e.crc && !e.folder).map(e => ({ path: e.path.split('\\').join('/'), size: e.size, crc: e.crc }))
}

const readText = file => { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') } catch { return '' } }

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
    }
  }
  const hash = sha256Buf(Buffer.from(files.map(f => `${f.name}:${f.accept.map(a => `${a.sha256}/${a.size}`).join(',')}`).join('\n')))
  return { plugins: c.plugins, searchDirs: Array.isArray(c.searchDirs) ? c.searchDirs : CREATION_SEARCH_DIRS, files, hash }
}

// "Data/Meshes/x.nif" -> ["Data/Meshes", "x.nif"]
function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]
}

// One compact file entry; `to` is left out when the folder is the same inside the archive and the mod,
// `name` only when the archive holds the same bytes under another filename
function fileEntry(key, fromPath, toPath, sha, size) {
  const [fromDir, fromName] = splitPath(fromPath)
  const [toDir, file] = splitPath(toPath)
  const entry = { file }
  if (fromName !== file) entry.name = fromName
  entry.from = fromDir ? `${key}/${fromDir}` : key
  if (toDir !== fromDir) entry.to = toDir ? `root/${toDir}` : 'root'
  entry.size = size
  entry.sha256 = sha
  return entry
}

// Pretty enough to read: top-level keys on their own lines, one line per mod field and per file entry
function writeManifestFile(out, m) {
  const fd = fs.openSync(out, 'w')
  const w = s => fs.writeSync(fd, s)
  const list = (items, indent) => items.map(x => indent + JSON.stringify(x)).join(',\n')
  try {
    w('{\n')
    for (const k of ['version', 'build', 'game']) w(`  ${JSON.stringify(k)}: ${JSON.stringify(m[k])},\n`)
    w('  "mods": [\n')
    m.mods.forEach((mod, i) => {
      w('    {\n')
      for (const k of ['name', 'source', 'modId', 'version', 'hash', 'size']) w(`      ${JSON.stringify(k)}: ${JSON.stringify(mod[k])},\n`)
      w('      "files": [\n' + list(mod.files, '        ') + '\n      ]\n')
      w(i < m.mods.length - 1 ? '    },\n' : '    }\n')
    })
    w('  ],\n')
    w('  "gameFiles": [\n' + list(m.gameFiles, '    ') + '\n  ],\n')
    w(`  "creations": ${JSON.stringify(m.creations)},\n`)
    for (const k of ['modlist', 'plugins', 'settings']) w(`  ${JSON.stringify(k)}: ${JSON.stringify(m[k])},\n`)
    w(`  "initweaks": ${JSON.stringify(m.initweaks)}\n}\n`)
  } finally {
    fs.closeSync(fd)
  }
}

async function main() {
  if (!fs.existsSync(MODS)) throw new Error(`mods folder not found: ${MODS}`)

  // 1. Index every archive's entries by (size, CRC32)
  const archives = new Map()          // key -> { key, name, size, sha256, url?, modId, fileId }
  const index    = new Map()          // "size:CRC" -> [{ key, from, modId, fileId }] in scan order
  const dlNames = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS).filter(n => !/\.(meta|unfinished)$/i.test(n)) : []
  for (const name of dlNames) {
    const full = path.join(DOWNLOADS, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue
    let entries
    try { entries = listEntries(full) } catch { console.warn(`  skipped ${name}: cannot list as archive`); continue }
    if (entries.length === 0) continue
    const meta = readDownloadMeta(name)
    const key = 'a' + (archives.size + 1)
    // An explicit URL wins over the Nexus meta: the escape hatch for a Nexus pin that died
    archives.set(key, { key, name, size: st.size, sha256: (await hashFile(full)).sha, url: sources.urls[name], modId: meta.modId, fileId: meta.fileId })
    for (const e of entries) {
      // Every empty file shares one size+crc key; they go to the extras archive instead
      if (e.size === 0) continue
      const k = e.size + ':' + e.crc
      if (!index.has(k)) index.set(k, [])
      index.get(k).push({ key, from: e.path, modId: meta.modId, fileId: meta.fileId })
    }
    console.log(`  indexed ${name} (${entries.length} entries)`)
  }

  // 2. The profile: MO2's own text files, and the enabled mods in priority order
  const modlist = readText(path.join(PROFILE_DIR, 'modlist.txt'))
  let plugins = readText(path.join(PROFILE_DIR, 'plugins.txt'))
  const settings = readText(path.join(PROFILE_DIR, 'settings.ini'))
  const initweaks = readText(path.join(PROFILE_DIR, 'initweaks.ini'))
  let order = modlist.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1).trim()).filter(Boolean)
  if (order.length === 0) {
    order = fs.readdirSync(MODS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    console.warn(`No profiles/${args.profile}/modlist.txt found - using all ${order.length} mod folders (unordered).`)
  }

  // The Creations load right after the vanilla masters in Skyrim.ccc order, whatever the MO2 profile says
  const creations = await creationsSection()
  if (creations) {
    const own = new Set(creations.plugins.map(p => p.toLowerCase()))
    const lines = plugins.split('\n').filter(l => !own.has(l.replace(/^[*+-]/, '').trim().toLowerCase()))
    const at = lines.findIndex(l => l.trim() && !l.startsWith('#'))
    lines.splice(at < 0 ? lines.length : at, 0, ...creations.plugins.map(p => `*${p}`))
    plugins = lines.join('\n')
  }

  // 3. A file entry per file in each mod folder; unmatched files go to the extras archive
  const extras = []                   // { stage: "<mod>/<rel>", abs, owner }
  const contentHash = files => sha256Buf(Buffer.from(files.map(f => `${f.to}:${f.sha256}`).sort().join('\n')))
  // A mod takes a file from the newest archive of its own Nexus mod, else from the first archive scanned
  const pickSource = (hits, modId) => {
    const own = modId ? hits.filter(h => h.modId === modId) : []
    return own.length ? own.reduce((a, b) => (b.fileId > a.fileId ? b : a)) : hits[0]
  }

  async function collect(owner, absFile, toRel, modId, used, flat) {
    const { sha, crc, size } = await hashFile(absFile)
    const hit = size > 0 && index.get(size + ':' + crc)
    if (hit) {
      const h = pickSource(hit, modId)
      used.add(h.key)
      flat.push({ key: h.key, from: h.from, to: toRel, sha, size })
    } else {
      const stage = `${owner}/${toRel}`
      extras.push({ stage, abs: absFile })
      flat.push({ key: 'x', from: stage, to: toRel, sha, size })
    }
  }

  const built = []                    // { name, modId, version, used, flat }
  for (const modName of order) {
    const modDir = path.join(MODS, modName)
    if (!fs.existsSync(modDir)) continue
    const rels = walk(modDir).filter(r => r.toLowerCase() !== 'meta.ini' && path.posix.basename(r).toLowerCase() !== CLIENT_SETTINGS_FILE)
    if (rels.length === 0) continue
    const meta = readModMeta(modDir)
    const used = new Set()
    const flat = []
    for (const rel of rels) await collect(modName, path.join(modDir, rel.split('/').join(path.sep)), rel, meta.modId, used, flat)
    built.push({ name: modName, modId: meta.modId, version: meta.version, used, flat })
  }

  // 4. Optional game-root files (preloaders, etc.)
  const gameUsed = new Set()
  const gameFlat = []
  if (args.game) {
    for (const rel of new Set(sources.rootInclude || [])) {
      const full = path.join(path.resolve(args.game), rel.split('/').join(path.sep))
      if (!fs.existsSync(full)) { console.warn(`rootInclude not found, skipping: ${rel}`); continue }
      await collect('game', full, rel, 0, gameUsed, gameFlat)
    }
  }

  // 5. The extras archive, named by its content so a changed build never reuses a stale download
  let extrasEntry = null
  if (extras.length) {
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alduinak-extras-'))
    try {
      for (const e of extras) {
        const dest = path.join(stageDir, e.stage.split('/').join(path.sep))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(e.abs, dest)
      }
      const tmp = path.join(os.tmpdir(), `alduinak-extras-${process.pid}.7z`)
      fs.rmSync(tmp, { force: true })
      execFileSync(SEVEN, ['a', '-t7z', '-mx=9', '-bso0', '-bsp0', tmp, '.'], { cwd: stageDir })
      const { sha, size } = await hashFile(tmp)
      const name = `alduinak-extras-${sha.slice(0, 12)}.7z`
      fs.mkdirSync(EXTRAS_DIR, { recursive: true })
      for (const old of fs.readdirSync(EXTRAS_DIR)) if (old !== name) fs.rmSync(path.join(EXTRAS_DIR, old), { force: true })
      fs.renameSync(tmp, path.join(EXTRAS_DIR, name))
      extrasEntry = { archive: name, key: 'x', size, sha256: sha, url: `${PUBLIC_API}/files/extras/${encodeURIComponent(name)}` }
      console.log(`  extras archive ${name}: ${extras.length} file(s), ${(size / 1048576).toFixed(1)} MB`)
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true })
    }
  }

  // Archive entries first, then file entries: the launcher resolves every file's key from the same list
  const entriesFor = (used, flat, modId) => {
    const out = []
    for (const key of used) {
      const a = archives.get(key)
      const entry = { archive: a.name, key, size: a.size, sha256: a.sha256 }
      if (a.url) entry.url = a.url
      else if (a.fileId) entry.fileId = a.fileId
      if (a.modId && a.modId !== modId) entry.modId = a.modId
      out.push(entry)
    }
    if (flat.some(f => f.key === 'x')) out.push(extrasEntry)
    for (const f of flat) out.push(fileEntry(f.key, f.from, f.to, f.sha, f.size))
    return out
  }

  const mods = built.map(b => ({
    name: b.name,
    source: b.flat.some(f => f.key !== 'x' && archives.get(f.key).fileId && !archives.get(f.key).url) ? 'nexus' : 'url',
    modId: b.modId,
    version: b.version,
    hash: contentHash(b.flat.map(f => ({ to: f.to, sha256: f.sha }))),
    size: b.flat.reduce((n, f) => n + f.size, 0),
    files: entriesFor(b.used, b.flat, b.modId),
  }))

  const manifest = {
    version: readVersions().client,
    build: new Date().toISOString(),
    game: 'skyrimspecialedition',
    mods,
    gameFiles: entriesFor(gameUsed, gameFlat, 0),
    creations,
    modlist, plugins, settings, initweaks,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  writeManifestFile(OUT, manifest)

  // Display list for /api/modlist (the launcher's Modlist panel)
  const display = mods.map(m => ({ name: m.name, required: true, enabled: true, source: m.source, ...(m.modId ? { nexusId: m.modId } : {}) }))
  fs.writeFileSync(MODLIST_OUT, JSON.stringify(display, null, 2) + '\n')

  const manual = [...archives.values()].filter(a => !a.url && !a.fileId && built.some(b => b.used.has(a.key)))
  console.log(`\nmods:       ${mods.length}`)
  console.log(`archives:   ${new Set(built.flatMap(b => [...b.used])).size} referenced (${archives.size} scanned)`)
  console.log(`files:      ${built.reduce((n, b) => n + b.flat.length, 0)} (${extras.length} in the extras archive)`)
  console.log(`game files: ${gameFlat.length}`)
  console.log(`creations:  ${creations ? creations.files.length : 0}`)
  if (manual.length) {
    console.warn('\nReferenced archives with NO download source - add a URL for each in data/manifest-sources.json ("urls"):')
    for (const a of manual) console.warn(`  - ${a.name}`)
  }
  console.log(`\nWrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`)
  console.log(`Wrote ${MODLIST_OUT}`)
}

main().catch(err => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
