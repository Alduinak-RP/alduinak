'use strict'

/**
 * File distribution endpoints, both built by `npm run merge` (scripts/merge-files.js); 404 until then.
 *   GET /api/files/version - version metadata the launcher uses to decide whether to re-download
 *   GET /api/files/zip     - the distributable zip streamed to the client
 */

const router = require('express').Router()
const path   = require('path')
const fs     = require('fs')
const rateLimit = require('express-rate-limit')
const config = require('../config')

const ZIP_PATH     = path.join(config.clientFilesDir, config.clientZipName)
const VERSION_PATH = path.join(__dirname, '..', 'data', 'files-version.json')

const NOT_BUILT = { error: 'File package not found. Run `npm run merge` on the server first.' }

// Only the zip is rate-limited: /version is polled every 10s by every open launcher (90 requests/window each), which a router-wide cap of 100 would choke on
const filesRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
})

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

// GET /api/files/zip

router.get('/zip', filesRateLimiter, (req, res) => {
  if (!fs.existsSync(ZIP_PATH)) return res.status(404).json(NOT_BUILT)

  const stat = fs.statSync(ZIP_PATH)
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Content-Disposition', 'attachment; filename="SkyMP-client.zip"')

  const stream = fs.createReadStream(ZIP_PATH)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
})

module.exports = router
