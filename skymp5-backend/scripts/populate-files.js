/**
 * Copies the built client files into the backend's file bucket:
 *   build/dist/client/Data/ -> <clientFilesDir>/root/Data/
 * SKSE is not included; the launcher installs it separately.
 * Run from backend/: npm run populate (override the source with SKYMP_CLIENT_DATA=<Data/ path>).
 */

const fs   = require('fs')
const path = require('path')
const { REQUIRED, isModOwned } = require('./client-package')

// Source: the skymp build output Data/ directory
const SKYMP_DATA = process.env.SKYMP_CLIENT_DATA
  || path.join(__dirname, '..', '..', 'build', 'dist', 'client', 'Data')

// Destination
const config    = require('../config')
const ROOT_DEST = path.join(config.clientFilesDir, 'root')
const DATA_DEST = path.join(ROOT_DEST, 'Data')

if (!fs.existsSync(SKYMP_DATA)) {
  console.error(`\nClient build output not found:\n  ${SKYMP_DATA}\n`)
  console.error('Build the client first, or set SKYMP_CLIENT_DATA to its Data/ folder.\n')
  process.exit(1)
}

// Plugins and the patcher's json files ship only through the MO2 install manifest; a zip copy lands in the real Data folder and drifts
const skipped = []

// Copy the whole Data/ tree
let copied = 0
function copyTree(src, dest, rel = '') {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    const r = rel + entry.name + (entry.isDirectory() ? '/' : '')
    if (isModOwned(r)) skipped.push(r)
    else if (entry.isDirectory()) copyTree(s, d, r)
    else { fs.copyFileSync(s, d); copied++ }
  }
}

console.log(`\nCopying client Data from\n  ${SKYMP_DATA}\nto\n  ${DATA_DEST}`)
fs.rmSync(DATA_DEST, { recursive: true, force: true })
copyTree(SKYMP_DATA, DATA_DEST)
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.join(', ')}: the MO2 install manifest delivers plugins and mod-owned json, not the client zip.`)
}

// Completeness check
const missing = REQUIRED.filter(rel => !fs.existsSync(path.join(DATA_DEST, rel.replace(/\//g, path.sep))))

console.log(`\nDone. ${copied} file(s) copied.`)
if (missing.length > 0) {
  console.warn('\nWARNING - required client files are MISSING from the build output:')
  for (const m of missing) console.warn(`  - Data/${m}`)
  console.warn('The in-game client will not activate without them - rebuild the client.\n')
}
