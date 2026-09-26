'use strict'

// data/versions.json holds every release version; it is read on each call, so the manager's edits need no backend restart
const fs = require('fs')
const path = require('path')

const VERSIONS_PATH = path.join(__dirname, '..', 'data', 'versions.json')

const DEFAULTS = {
  launcher: '0.0.0',
  client: '',
  server: '',
  launcherUrl: 'https://api.alduinak.com/downloads/AlduinakLauncher.exe',
}

function readVersions() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8')) } }
  catch { return { ...DEFAULTS } }
}

function writeVersion(key, value) {
  const next = { ...readVersions(), [key]: value }
  fs.mkdirSync(path.dirname(VERSIONS_PATH), { recursive: true })
  fs.writeFileSync(VERSIONS_PATH, JSON.stringify(next, null, 2) + '\n')
  return next
}

module.exports = { VERSIONS_PATH, readVersions, writeVersion }
