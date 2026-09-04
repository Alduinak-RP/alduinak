const router = require('express').Router()
const fs = require('fs')

// Written by the manager Build tab. LATEST_VERSION = launcher app release (GET /api/version, update prompt)
// CLIENT_VERSION = client files release (baked into data/files-version.json by merge-files.js)
// SERVER_VERSION = game server release label (informational)
const LATEST_VERSION = '2.1.11'
const CLIENT_VERSION = '0.1.9'
const SERVER_VERSION = '0.1.8'
const DOWNLOAD_URL   = 'https://api.alduinak.com/downloads/AlduinakLauncher.exe'

router.get('/', (_req, res) => {
  res.json({
    version:       readConst('LATEST_VERSION', LATEST_VERSION),
    downloadUrl:   DOWNLOAD_URL,
    clientVersion: readConst('CLIENT_VERSION', CLIENT_VERSION),
    serverVersion: readConst('SERVER_VERSION', SERVER_VERSION),
  })
})

// Re-read from disk each request so a version bump is served without a backend restart.
function readConst(name, fallback) {
  try {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`)
    const m = fs.readFileSync(__filename, 'utf8').match(re)
    if (m) return m[1]
  } catch { /* fall back to the value loaded at startup */ }
  return fallback
}

module.exports = router
module.exports.readConst = readConst
