'use strict'

// The dlls a game client may load for one server: every dll the install manifest ships plus SKSE's root files
const fs = require('fs')
const { manifestPath } = require('./serverFiles')

// sha256 of the files SKSE 2.2.6 puts in the game root (mirrors SKSE_FILE_HASHES in the launcher's install.rs)
const SKSE_ROOT_DLLS = {
  'skse64_1_6_1170.dll': 'c9a2c8a80df6bf2372c5f49468bb2e5ab67786157265b6f29ece9f4eac075d54',
  'skse64_1_6_1179.dll': '1af746d2db9c4bf8e716c6b122e2faa7ca205039274a10573bd5908ba9712177',
}

// Store dlls in the game root whose build differs per edition (VANILLA_ROOT_FILES in the launcher's gamecopy.rs)
const ANY_HASH_ROOT_DLLS = ['bink2w64.dll', 'steam_api64.dll', 'galaxy64.dll']

const MODULE_RE = /\.(dll|node)$/i

const cache = new Map()

function addFile(modules, name, sha256, size) {
  const key = name.toLowerCase()
  const list = modules[key] || (modules[key] = [])
  if (!list.some(e => e.sha256 === sha256)) list.push({ sha256, size })
}

function build(manifest) {
  const modules = {}
  const entries = [
    ...(manifest.mods || []).flatMap(m => m.files || []),
    ...(manifest.gameFiles || []),
  ]
  for (const f of entries) {
    if (typeof f.file === 'string' && MODULE_RE.test(f.file) && typeof f.sha256 === 'string') {
      addFile(modules, f.file, f.sha256.toLowerCase(), f.size)
    }
  }
  for (const [name, sha256] of Object.entries(SKSE_ROOT_DLLS)) addFile(modules, name, sha256, null)
  return { modules, anyHashRoot: ANY_HASH_ROOT_DLLS }
}

// Null when the server has no published manifest; rebuilt when the manifest file changes
function clientModules(serverId) {
  const file = manifestPath(serverId)
  if (!fs.existsSync(file)) return null
  const { mtimeMs } = fs.statSync(file)
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.value
  const value = build(JSON.parse(fs.readFileSync(file, 'utf8')))
  cache.set(file, { mtimeMs, value })
  return value
}

module.exports = { clientModules }
