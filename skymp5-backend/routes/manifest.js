const router = require('express').Router()
const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const { MANIFEST_NAME } = require('../sources/manifestFormat')

const MANIFEST_PATH = path.join(__dirname, '..', 'data', MANIFEST_NAME)

// The manifest's sha256, recomputed when the file changes
let hashed = { mtimeMs: 0, sha256: '' }
function manifestHash() {
  const { mtimeMs } = fs.statSync(MANIFEST_PATH)
  if (mtimeMs !== hashed.mtimeMs) hashed = { mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(MANIFEST_PATH)).digest('hex') }
  return hashed.sha256
}

// GET /api/manifest - the install manifest (built by scripts/compile-manifest.js).
// Launchers keep a copy and send its sha256 as If-None-Match; only a copy equal to this one gets 304, so an edited copy is sent again in full.
router.get('/', (req, res) => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(404).json({ error: 'This server has not published a mod manifest yet. Ask the admin to run Update modlist in the server manager.' })
  }
  const etag = `"${manifestHash()}"`
  if (req.headers['if-none-match'] === etag) return res.status(304).set('ETag', etag).end()
  res.sendFile(MANIFEST_PATH, { etag: false, lastModified: false, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: etag } })
})

module.exports = router
