const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')
const { MANIFEST_NAME } = require('../sources/manifestFormat')

const MANIFEST_PATH = path.join(__dirname, '..', 'data', MANIFEST_NAME)

// GET /api/manifest - the install manifest (built by scripts/compile-manifest.js); launchers fetch it fresh and never cache it
router.get('/', (_req, res) => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(404).json({ error: 'This server has not published a mod manifest yet. Ask the admin to run Build manifest in the server manager.' })
  }
  res.sendFile(MANIFEST_PATH, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
})

module.exports = router
