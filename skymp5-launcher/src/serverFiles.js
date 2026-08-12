'use strict'

/**
 * "Server Files" export.
 *
 * Builds a zip the server operator drops into the game server's data
 * directory, so the server loads exactly the plugins the players have.
 *
 * The server is authoritative over inventory, actors, containers and cells,
 * and resolves FormIDs through its own loadOrder, so every plugin whose
 * records it must simulate has to be present server-side. The client checks
 * this: loadOrderVerificationService compares its plugin list against the
 * server manifest index by index on filename, crc32 and size, and refuses to
 * connect on a mismatch. This export exists to make that comparison pass.
 *
 * Only plugins and loose server-side Papyrus are exported. Meshes, textures
 * and .bsa archives are client-side only and would bloat the zip for nothing.
 * The vanilla masters are deliberately excluded: they are Bethesda's files and
 * the operator already supplies them from their own install.
 */

const path   = require('path')
const fs     = require('fs')
const AdmZip = require('adm-zip')

// Always first, in this order, and never packed into the zip
const VANILLA_MASTERS = [
  'Skyrim.esm',
  'Update.esm',
  'Dawnguard.esm',
  'HearthFires.esm',
  'Dragonborn.esm',
]

const PLUGIN_EXT = /\.es[mpl]$/i

let _log = (...args) => console.log('[serverfiles]', ...args)
function setLogger(fn) { _log = (...args) => fn('[serverfiles]', ...args) }

const isVanilla = name =>
  VANILLA_MASTERS.some(m => m.toLowerCase() === String(name).toLowerCase())

/** Ordered, enabled plugin names from the MO2 profile's plugins.txt. */
function readPlugins(profileDir) {
  const file = path.join(profileDir, 'plugins.txt')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`No plugins.txt in ${profileDir}. Run the install first so MO2 has a profile.`)
  }

  const enabled = []
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    // MO2 marks active plugins with a leading '*'; unmarked lines are disabled
    if (!text.startsWith('*')) continue
    const name = text.slice(1).trim()
    if (name && PLUGIN_EXT.test(name)) enabled.push(name)
  }

  // Skyrim always loads the masters first, in this fixed order. Profiles may
  // list all of them, some of them, or none, so pull any out of the parsed
  // list and re-seat the canonical five in front: interleaving a partially
  // listed set would silently produce a wrong order.
  const rest = enabled.filter(n => !isVanilla(n))
  return [...VANILLA_MASTERS, ...rest]
}

/** Mod folder names in modlist.txt order, used only to break duplicate hits. */
function readModOrder(profileDir) {
  try {
    return fs.readFileSync(path.join(profileDir, 'modlist.txt'), 'utf8')
      .split(/\r?\n/)
      .filter(l => l.startsWith('+'))
      .map(l => l.slice(1).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Map lowercased plugin filename -> list of absolute paths that provide it.
 * Plugins sit at the root of a mod folder, so one level is enough.
 */
function indexModPlugins(modsDir, modOrder) {
  const index = new Map()

  let entries = []
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true }).filter(e => e.isDirectory())
  } catch {
    return index
  }

  // Walk in modlist order first so the winner is deterministic
  const rank = new Map(modOrder.map((n, i) => [n.toLowerCase(), i]))
  entries.sort((a, b) => {
    const ra = rank.has(a.name.toLowerCase()) ? rank.get(a.name.toLowerCase()) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.name.toLowerCase()) ? rank.get(b.name.toLowerCase()) : Number.MAX_SAFE_INTEGER
    return ra - rb || a.name.localeCompare(b.name)
  })

  for (const dir of entries) {
    let files = []
    try { files = fs.readdirSync(path.join(modsDir, dir.name)) } catch { continue }
    for (const f of files) {
      if (!PLUGIN_EXT.test(f)) continue
      const key = f.toLowerCase()
      if (!index.has(key)) index.set(key, [])
      index.get(key).push(path.join(modsDir, dir.name, f))
    }
  }
  return index
}

/** Loose .pex from every mod's Scripts folder; the server reads data/scripts. */
function collectScripts(modsDir, modOrder) {
  const found = new Map()
  const rank = new Map(modOrder.map((n, i) => [n.toLowerCase(), i]))

  let entries = []
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true }).filter(e => e.isDirectory())
  } catch {
    return found
  }

  entries.sort((a, b) => {
    const ra = rank.has(a.name.toLowerCase()) ? rank.get(a.name.toLowerCase()) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.name.toLowerCase()) ? rank.get(b.name.toLowerCase()) : Number.MAX_SAFE_INTEGER
    return ra - rb || a.name.localeCompare(b.name)
  })

  for (const dir of entries) {
    // MO2 mod folders mirror Data, so scripts live at <mod>/Scripts
    const scriptsDir = path.join(modsDir, dir.name, 'Scripts')
    let files = []
    try { files = fs.readdirSync(scriptsDir) } catch { continue }
    for (const f of files) {
      if (!/\.pex$/i.test(f)) continue
      // First writer wins, matching the deterministic mod order above
      if (!found.has(f.toLowerCase())) found.set(f.toLowerCase(), path.join(scriptsDir, f))
    }
  }
  return found
}

/**
 * @param {object} opts
 * @param {string} opts.destZip     absolute path of the zip to write
 * @param {string} opts.modsDir     MO2 mods directory
 * @param {string} opts.profileDir  MO2 profile directory
 * @param {string} [opts.gameDataDir] Skyrim Data directory, for locating masters
 * @param {(msg:string)=>void} [opts.onProgress]
 */
function buildServerFiles(opts) {
  const { destZip, modsDir, profileDir, gameDataDir } = opts
  const progress = opts.onProgress || (() => {})

  if (!destZip)    throw new Error('destZip is required')
  if (!modsDir)    throw new Error('modsDir is required')
  if (!profileDir) throw new Error('profileDir is required')

  const warnings = []

  progress('Reading load order...')
  const loadOrder = readPlugins(profileDir)
  if (loadOrder.length === 0) throw new Error('No enabled plugins found in plugins.txt.')

  const modOrder = readModOrder(profileDir)
  const index    = indexModPlugins(modsDir, modOrder)

  progress(`Resolving ${loadOrder.length} plugin(s)...`)

  const zip = new AdmZip()
  const included = []
  const skippedVanilla = []
  const missing = []

  for (const name of loadOrder) {
    if (isVanilla(name)) {
      skippedVanilla.push(name)
      continue
    }

    const hits = index.get(name.toLowerCase()) || []
    let source = hits[0]

    if (hits.length > 1) {
      warnings.push(
        `${name} is provided by ${hits.length} mods; used ${path.basename(path.dirname(source))}. ` +
        `Check for a duplicate install.`
      )
    }

    if (!source && gameDataDir) {
      const inData = path.join(gameDataDir, name)
      if (fs.existsSync(inData)) source = inData
    }

    if (!source) {
      missing.push(name)
      continue
    }

    zip.addLocalFile(source, 'data')
    included.push({ name, bytes: fs.statSync(source).size })
  }

  if (missing.length) {
    throw new Error(
      `Could not find ${missing.length} enabled plugin(s): ${missing.join(', ')}. ` +
      `The export was not written, because a partial load order would fail the client's check.`
    )
  }

  progress('Collecting server-side scripts...')
  const scripts = collectScripts(modsDir, modOrder)
  for (const src of scripts.values()) {
    zip.addLocalFile(src, 'data/scripts')
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'alduinak-launcher',
    // Exactly what belongs in server-settings.json "loadOrder", masters first
    loadOrder,
    vanillaMasters: skippedVanilla,
    modPlugins: included.map(p => p.name),
    scriptCount: scripts.size,
  }
  zip.addFile('server-loadorder.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))
  zip.addFile('README.txt', Buffer.from(readme(manifest, warnings), 'utf8'))

  progress('Writing zip...')
  fs.mkdirSync(path.dirname(destZip), { recursive: true })
  zip.writeZip(destZip)

  const result = {
    ok: true,
    zipPath: destZip,
    pluginCount: included.length,
    vanillaCount: skippedVanilla.length,
    scriptCount: scripts.size,
    bytes: fs.statSync(destZip).size,
    loadOrder,
    warnings,
  }
  _log(`exported ${result.pluginCount} plugin(s), ${result.scriptCount} script(s) -> ${destZip}`)
  return result
}

function readme(manifest, warnings) {
  return [
    'Alduinak server files',
    `Generated ${manifest.generatedAt}`,
    '',
    'CONTENTS',
    '  data/                 mod plugins (.esp/.esm/.esl)',
    '  data/scripts/         loose Papyrus the server executes',
    '  server-loadorder.json the exact loadOrder for server-settings.json',
    '',
    'THE VANILLA MASTERS ARE NOT INCLUDED',
    '  ' + manifest.vanillaMasters.join(', '),
    '  They are Bethesda game files. Copy them to the server yourself from',
    '  <Steam>/steamapps/common/Skyrim Special Edition/Data/.',
    '',
    'DEPLOY',
    '  1. Unzip into the server directory so the files land in data/.',
    '  2. Copy "loadOrder" out of server-loadorder.json into',
    '     server-settings.json, or set the LOAD_ORDER variable if the server',
    '     runs in the container.',
    '  3. Restart the server.',
    '',
    'WHY THE ORDER MATTERS',
    '  The client compares its plugin list against the server manifest entry',
    '  by entry, on name, crc32 and size, and refuses to connect if they',
    '  differ. Client-only mods are allowed but must sort after every plugin',
    '  the server loads.',
    '',
    warnings.length ? 'WARNINGS' : '',
    ...warnings.map(w => '  - ' + w),
    '',
  ].filter(l => l !== '').join('\n') + '\n'
}

module.exports = {
  buildServerFiles,
  setLogger,
  VANILLA_MASTERS,
}
