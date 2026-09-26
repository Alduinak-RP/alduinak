'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

/**
 * Writes the client files version manifest: build/client-files/root/ -> data/files-version.json
 * Run standalone: node scripts/merge-files.js. Called by scripts/setup-client.js.
 */

const path                     = require('path')
const fs                       = require('fs')
const { execFileSync }         = require('child_process')
const config                   = require('../config')
const { walkFiles, sha256File } = require('./client-package')

const ROOT = path.join(__dirname, '..')

const OUTPUT_DIR   = path.join(config.clientFilesDir, 'root')
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

// Main export

async function mergeSourcesIntoRoot() {
  const startMs = Date.now()

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const files = await listFiles(OUTPUT_DIR)
  console.log(`[merge] Hashed ${files.length} files for the version manifest`)

  // CLIENT_VERSION in routes/version.js overrides the update-signal version
  const version = routeClientVersion() || clientGitHash()
  fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true })
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    version,
    builtAt:   new Date().toISOString(),
    fileCount: files.length,
    files,
  }, null, 2) + '\n')
  console.log(`[merge] Version: ${version}, ${files.length} files in ${Date.now() - startMs}ms`)

  return { total: files.length }
}

// CLI entry

if (require.main === module) {
  mergeSourcesIntoRoot().catch(err => {
    console.error('[merge] Fatal:', err.message)
    process.exit(1)
  })
}

module.exports = { mergeSourcesIntoRoot }
