const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')

const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'install-manifest.json')

// Compiled, hash-verified install manifest (built by scripts/compile-manifest.js).
//
// Streamed rather than readFileSync+send: with base64-inlined files the
// manifest can exceed Node's ~512 MB string cap, and the old string read then
// threw - reporting a perfectly good manifest as "not built yet".
//
// data/ is untracked runtime state, so a fresh backend deploy has NO manifest
// until compile-manifest is run again on the server box.
router.get('/', (_req, res) => {
  let stat
  try { stat = fs.statSync(MANIFEST_PATH) } catch {
    console.warn('[install-manifest] requested but data/install-manifest.json is missing - run `npm run compile-manifest`')
    return res.status(404).json({
      error: 'This server has not published a mod manifest yet. Ask the admin to run `npm run compile-manifest` on the backend (needed again after every fresh deploy - data/ is not tracked in git).',
    })
  }

  res.type('application/json')
  res.setHeader('Content-Length', stat.size)
  const stream = fs.createReadStream(MANIFEST_PATH)
  stream.on('error', err => {
    console.error('[install-manifest] read failed:', err.message)
    if (!res.headersSent) res.status(500).json({ error: `Could not read the manifest: ${err.message}` })
    else res.destroy()
  })
  stream.pipe(res)
})

module.exports = router
