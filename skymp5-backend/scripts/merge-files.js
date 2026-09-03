'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

/**
 * Merge pipeline: copies the client source into the bucket the launcher downloads and builds the zip.
 *   build/dist/client (via `npm run populate`) -> build/client-files/root/ -> build/client-files/<zip> + data/files-version.json
 * SKSE is NOT included; the user manages it via the Vortex collection.
 * Run standalone: node scripts/merge-files.js. Called by scripts/setup-client.js and routes/webhook.js.
 */

const path               = require('path')
const fs                 = require('fs')
const crypto             = require('crypto')
const { execFileSync }   = require('child_process')
const archiver           = require('archiver')
const config             = require('../config')

const ROOT = path.join(__dirname, '..')

const CLIENT_SRC   = path.join(ROOT, 'sources', 'client')
const OUTPUT_DIR   = path.join(config.clientFilesDir, 'root')
const ZIP_PATH     = path.join(config.clientFilesDir, config.clientZipName)
const VERSION_FILE = path.join(ROOT, 'data', 'files-version.json')

// skymp5-client-settings.txt is the launcher's per-player file (server ip, hotkey rebinds): never copied and never listed in the manifest, since the launcher rewrites it on every launch
const SKIP_ALWAYS = new Set(['.git', '.gitignore', '.gitattributes', 'skymp5-client-settings.txt'])

// Version helpers

function routeClientVersion() {
  return require('../routes/version').readConst('CLIENT_VERSION', '').trim()
}

// Short git hash for the client files version: tries the legacy sources/client checkout, then the skyrp monorepo; changes only on new commits, 'nogit' if neither is a repo
function clientGitHash() {
  for (const dir of [CLIENT_SRC, path.join(ROOT, '..')]) {
    try {
      return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch { /* try next */ }
  }
  return 'nogit'
}

// File copy

function copyDir(srcDir, destDir, skipNames = new Set()) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`[merge] source not found, skipping: ${srcDir}`)
    return 0
  }
  let count = 0
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue
    const src  = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      count += copyDir(src, dest, skipNames)
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      count++
    }
  }
  return count
}

// Per-file manifest of the output dir (launcher-owned files excluded), so the launcher's Check Files can verify every client file by size + sha256.

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(p)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

async function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_ALWAYS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { await listFiles(full, base, out); continue }
    out.push({
      path:   path.relative(base, full).split(path.sep).join('/'),
      size:   fs.statSync(full).size,
      sha256: await sha256File(full),
    })
  }
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

  console.log('[merge] Starting merge…')
  console.log(`[merge]   client  : ${CLIENT_SRC}`)
  console.log(`[merge]   output  : ${OUTPUT_DIR}`)

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const clientFiles = copyDir(CLIENT_SRC, OUTPUT_DIR, SKIP_ALWAYS)
  console.log(`[merge] Files merged: ${clientFiles} total in ${Date.now() - startMs}ms`)

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
    fileCount: clientFiles,
    zipSize,
    files,
  }, null, 2) + '\n')
  console.log(`[merge] Version: ${version}`)

  return { clientFiles, total: clientFiles, zipSize }
}

// CLI entry

if (require.main === module) {
  mergeSourcesIntoRoot().catch(err => {
    console.error('[merge] Fatal:', err.message)
    process.exit(1)
  })
}

module.exports = { mergeSourcesIntoRoot }
