const router = require('express').Router()
const fs = require('fs')

// Bump LATEST_VERSION on each launcher release; DOWNLOAD_URL is the installer link (e.g. a GitHub Releases URL)
const LATEST_VERSION = '2.1.1'
const DOWNLOAD_URL   = 'https://api.alduinak.com/downloads/AlduinakLauncher.exe'

router.get('/', (_req, res) => {
  res.json({
    version:     currentVersion(),
    downloadUrl: DOWNLOAD_URL,
  })
})

// Re-read LATEST_VERSION from disk each request so a version bump is served without a backend restart.
function currentVersion() {
  try {
    const m = fs.readFileSync(__filename, 'utf8').match(/const\s+LATEST_VERSION\s*=\s*['"]([^'"]+)['"]/)
    if (m) return m[1]
  } catch { /* fall back to the value loaded at startup */ }
  return LATEST_VERSION
}

module.exports = router
