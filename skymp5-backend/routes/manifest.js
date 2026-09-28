const router = require('express').Router()
const crypto = require('crypto')
const fs     = require('fs')
const config = require('../config')
const { manifestPath } = require('../sources/serverFiles')

// Each manifest file's sha256, recomputed when that file changes
const hashed = new Map()
function manifestHash(file) {
  const { mtimeMs } = fs.statSync(file)
  const hit = hashed.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.sha256
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  hashed.set(file, { mtimeMs, sha256 })
  return sha256
}

// GET /api/manifest?server=<id> - the install manifest (built by scripts/compile-manifest.js); an unknown or missing id is the main server.
// Launchers keep a copy and send its sha256 as If-None-Match; only a copy equal to this one gets 304, so an edited copy is sent again in full.
router.get('/', (req, res) => {
  const file = manifestPath(config.serverOrMain(req.query.server).id)
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'This server has not published a mod manifest yet. Ask the admin to run Update modlist in the server manager.' })
  }
  const etag = `"${manifestHash(file)}"`
  if (req.headers['if-none-match'] === etag) return res.status(304).set('ETag', etag).end()
  res.sendFile(file, { etag: false, lastModified: false, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: etag } })
})

module.exports = router
