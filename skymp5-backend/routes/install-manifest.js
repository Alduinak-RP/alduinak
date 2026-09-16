const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')

const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'install-manifest.json')
// Launchers without a schema query predate schema 3 and show only a 404's error text
const DEFAULT_LAUNCHER_SCHEMA = 2
const UPDATE_LAUNCHER = 'This server needs a newer Alduinak launcher. Accept the launcher update (or download it again from the website), then press Update.'

// Schema of the compiled manifest, read from its first bytes; 0 when there is none
function publishedSchema() {
  let fd
  try {
    fd = fs.openSync(MANIFEST_PATH, 'r')
    const buf = Buffer.alloc(64)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const m = buf.toString('utf8', 0, n).match(/"schema":\s*(\d+)/)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function supportedSchema(value) {
  const v = Number(value)
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_LAUNCHER_SCHEMA
}

// Compiled, hash-verified install manifest (built by scripts/compile-manifest.js).
// Streamed, not readFileSync: base64-inlined files can push the manifest past Node's ~512 MB string cap, which made the old string read report a good manifest as "not built yet".
// data/ is untracked runtime state, so a fresh backend deploy has NO manifest until compile-manifest runs again on the server box.
router.get('/', (req, res) => {
  let stat
  try { stat = fs.statSync(MANIFEST_PATH) } catch {
    console.warn('[install-manifest] requested but data/install-manifest.json is missing - run `npm run compile-manifest`')
    return res.status(404).json({
      error: 'This server has not published a mod manifest yet. Ask the admin to run `npm run compile-manifest` on the backend (needed again after every fresh deploy - data/ is not tracked in git).',
    })
  }

  if (publishedSchema() > supportedSchema(req.query.schema)) {
    return res.status(404).json({ error: UPDATE_LAUNCHER })
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
module.exports.publishedSchema = publishedSchema
module.exports.supportedSchema = supportedSchema
