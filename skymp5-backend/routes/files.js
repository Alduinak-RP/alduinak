'use strict'

/**
 * GET /api/files/version - client files version metadata, built by `npm run merge` (scripts/merge-files.js); 404 until then
 */

const router = require('express').Router()
const path   = require('path')
const fs     = require('fs')

const VERSION_PATH = path.join(__dirname, '..', 'data', 'files-version.json')

const NOT_BUILT = { error: 'File package not found. Run `npm run merge` on the server first.' }

// GET /api/files/version

router.get('/version', (_req, res) => {
  if (!fs.existsSync(VERSION_PATH)) return res.status(404).json(NOT_BUILT)
  try {
    // Read fresh every time (do NOT use require(); it caches the module)
    res.json(JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8')))
  } catch {
    res.status(500).json({ error: 'Could not read version file.' })
  }
})

module.exports = router
