'use strict'

/**
 * The SkyMP client package: the paths the launcher extracts from the backend zip into the real Data.
 * No install-manifest mod may carry them, or MO2 lets the mod copy shadow the zip's and a client
 * build never reaches players. Address Library's versionlib bins and the CraftingCategories json
 * are mod content and stay out of this list on purpose.
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const CLIENT_PACKAGE_PREFIXES = ['Platform/']
const CLIENT_PACKAGE_FILES = [
  'SKSE/Plugins/SkyrimPlatform.dll',
  'SKSE/Plugins/MpClientPlugin.dll',
  'Scripts/MpClientPlugin.pex',
  'Scripts/TESModPlatform.pex',
]
const CLIENT_PACKAGE_LABEL = [...CLIENT_PACKAGE_PREFIXES.map(p => p + '**'), ...CLIENT_PACKAGE_FILES].join(', ')

// The client does not activate without these; populate-files warns when the build output lacks one
const REQUIRED = [
  'Platform/UI/index.html',                                   // CEF connect-window page
  'Platform/UI/build.js',                                     // connect-menu front-end bundle
  'Platform/Plugins/skymp5-client.js',                        // client logic
  'SKSE/Plugins/SkyrimPlatform.dll',                          // JS/CEF host plugin
  'SKSE/Plugins/MpClientPlugin.dll',                          // multiplayer plugin
  'Platform/Distribution/RuntimeDependencies/libcef.dll',     // CEF runtime
  'Platform/Distribution/RuntimeDependencies/SkyrimPlatformCEF.exe.hidden',
]

// REQUIRED plus what a native or font rebuild changes; Build Client compares these with the last zip
const KEY_FILES = [
  ...REQUIRED,
  'Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll',
  'Platform/Fonts/Tavern.spritefont',
]

const norm = rel => String(rel).replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()

/** True for a Data-relative path the client zip delivers (case-insensitive). */
function isClientPackage(rel) {
  const r = norm(rel)
  return CLIENT_PACKAGE_PREFIXES.some(p => r.startsWith(p.toLowerCase())) ||
         CLIENT_PACKAGE_FILES.some(f => r === f.toLowerCase())
}

/** True for a Data-relative path only the install manifest may deliver: plugins, the patcher's top-level json files and the CraftingCategories folder. */
function isModOwned(rel) {
  const r = norm(rel)
  return (!r.includes('/') && /\.(esp|esm|esl|json)$/.test(r)) || r.startsWith('skse/plugins/craftingcategories/')
}

// Repo files and the launcher's per-player settings file (rewritten on every launch) never enter the zip listing
const ZIP_SKIP_NAMES = new Set(['.git', '.gitignore', '.gitattributes', 'skymp5-client-settings.txt'])

// Stat-only walk with forward-slash paths relative to base, ZIP_SKIP_NAMES left out
function walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ZIP_SKIP_NAMES.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, base, out)
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: fs.statSync(full).size, full })
  }
  return out
}

// Streamed: libcef.dll is 190 MB and mod folders hold multi-GB BSAs
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(p)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

module.exports = {
  CLIENT_PACKAGE_PREFIXES, CLIENT_PACKAGE_FILES, CLIENT_PACKAGE_LABEL, REQUIRED, KEY_FILES, ZIP_SKIP_NAMES,
  isClientPackage, isModOwned, walkFiles, sha256File,
}
