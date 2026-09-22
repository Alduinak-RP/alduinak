'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

/**
 * Zips the bucket the launcher downloads and writes its version manifest:
 *   build/dist/client (via `npm run populate`) -> build/client-files/root/ -> build/client-files/<zip> + data/files-version.json
 * SKSE is NOT included; the user manages it via the Vortex collection.
 * Run standalone: node scripts/merge-files.js. Called by scripts/setup-client.js and routes/webhook.js.
 */

const path                     = require('path')
const fs                       = require('fs')
const { execFileSync }         = require('child_process')
const archiver                 = require('archiver')
const config                   = require('../config')
const { walkFiles, sha256File } = require('./client-package')

const ROOT = path.join(__dirname, '..')

const OUTPUT_DIR   = path.join(config.clientFilesDir, 'root')
const ZIP_PATH     = path.join(config.clientFilesDir, config.clientZipName)
const VERSION_FILE = path.join(ROOT, 'data', 'files-version.json')

// Version helpers

function routeClientVersion() {
  return require('../routes/version').readConst('CLIENT_VERSION', '').trim()
}

// Short git hash of the monorepo for the client files version; changes only on new commits, 'nogit' outside a repo
function clientGitHash() {
  try {
    return execFileSync('git', ['-C', path.join(ROOT, '..'), 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio:    ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { return 'nogit' }
}

// Per-file manifest of the output dir (launcher-owned files excluded), so the launcher's Check Files can verify every client file by size + sha256.

async function listFiles(dir) {
  const out = []
  for (const f of walkFiles(dir)) out.push({ path: f.rel, size: f.size, sha256: await sha256File(f.full) })
  return out
}

// Zip builder

function buildZip(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true })
    const output  = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })

    output.on('close', () => resolve(archive.pointer()))
    archive.on('error', reject)

    archive.pipe(output)
    archive.directory(srcDir, false)  // false = no root folder prefix in zip
    archive.finalize()
  })
}

// Main export

async function mergeSourcesIntoRoot() {
  const startMs = Date.now()

  console.log(`[merge] Zipping ${OUTPUT_DIR}`)
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('[merge] Building zip…')
  const zipStart = Date.now()
  const zipSize  = await buildZip(OUTPUT_DIR, ZIP_PATH)
  console.log(`[merge] Zip built: ${(zipSize / 1024 / 1024).toFixed(1)} MB in ${Date.now() - zipStart}ms`)

  const files = await listFiles(OUTPUT_DIR)
  console.log(`[merge] Hashed ${files.length} files for the version manifest`)

  // CLIENT_VERSION in routes/version.js overrides the update-signal version
  const version = routeClientVersion() || clientGitHash()
  fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true })
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    version,
    builtAt:   new Date().toISOString(),
    fileCount: files.length,
    zipSize,
    files,
  }, null, 2) + '\n')
  console.log(`[merge] Version: ${version}, ${files.length} files in ${Date.now() - startMs}ms`)

  return { total: files.length, zipSize }
}

// CLI entry

if (require.main === module) {
  mergeSourcesIntoRoot().catch(err => {
    console.error('[merge] Fatal:', err.message)
    process.exit(1)
  })
}

module.exports = { mergeSourcesIntoRoot }
