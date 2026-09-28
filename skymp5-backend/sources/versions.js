'use strict'

// data/versions.json holds every release version; it is read on each call, so the manager's edits need no backend restart
// Shape: { launcher, client, server, launcherUrl, test: { client, server } }; the test block belongs to the test game server
const fs = require('fs')
const path = require('path')

const VERSIONS_PATH = path.join(__dirname, '..', 'data', 'versions.json')

// The test server's id is a literal here: config.js is not required so this module stays free of it
const TEST_ID = 'test'

const DEFAULTS = {
  launcher: '0.0.0',
  client: '',
  server: '',
  launcherUrl: 'https://api.alduinak.com/downloads/AlduinakLauncher.exe',
}
const TEST_DEFAULTS = { client: '', server: '' }

// file is only overridden by tests
function readVersions(file = VERSIONS_PATH) {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* defaults */ }
  const test = raw[TEST_ID] && typeof raw[TEST_ID] === 'object' ? raw[TEST_ID] : {}
  return { ...DEFAULTS, ...raw, [TEST_ID]: { ...TEST_DEFAULTS, ...test } }
}

// key: client, server, launcher, launcherUrl, test.client or test.server
function writeVersion(key, value, file = VERSIONS_PATH) {
  const next = readVersions(file)
  const [head, tail] = String(key).split('.')
  if (tail) next[head] = { ...(next[head] && typeof next[head] === 'object' ? next[head] : {}), [tail]: value }
  else next[head] = value
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return next
}

// { client, server } of one game server: the test server reads its block, every other id the root keys
function versionsFor(serverId, file = VERSIONS_PATH) {
  const v = readVersions(file)
  const src = serverId === TEST_ID ? v[TEST_ID] : v
  return { client: src.client || '', server: src.server || '' }
}

module.exports = { VERSIONS_PATH, readVersions, writeVersion, versionsFor }
