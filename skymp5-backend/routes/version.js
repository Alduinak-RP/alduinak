const router = require('express').Router()
const fs = require('fs')

/**
 * Update LATEST_VERSION here whenever you release a new launcher build.
 * Set DOWNLOAD_URL to the installer download link (e.g. a GitHub Releases URL).
 */
const LATEST_VERSION = '1.3.2'
const DOWNLOAD_URL   = 'https://www.skyrimroleplay.co.uk/download'

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
