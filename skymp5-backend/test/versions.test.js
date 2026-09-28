'use strict'
// Per-server versions and data file names; run through test/run-manager-tests.js, which executes this file inside a temporary copy

const test   = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const path   = require('path')

const ROOT = process.env.ALDUINAK_MANAGER_TEST_ROOT
if (!ROOT || !path.resolve(__dirname).startsWith(path.resolve(ROOT))) {
  console.error('run these tests with: node test/run-manager-tests.js')
  process.exit(1)
}

const { readVersions, writeVersion, versionsFor } = require('../sources/versions')
const { manifestPath, modlistPath, extrasDirName } = require('../sources/serverFiles')
const config = require('../config')

const FILE = path.join(ROOT, 'versions-test.json')

test('versions: the test block defaults to empty strings and dotted keys write into it', () => {
  fs.rmSync(FILE, { force: true })
  assert.deepEqual(readVersions(FILE).test, { client: '', server: '' })
  assert.deepEqual(versionsFor('test', FILE), { client: '', server: '' })

  writeVersion('client', '1.2.3', FILE)
  writeVersion('server', '1.2.4', FILE)
  writeVersion('test.client', '2.0.0', FILE)
  const v = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  assert.equal(v.client, '1.2.3')
  assert.deepEqual(v.test, { client: '2.0.0', server: '' })

  assert.deepEqual(versionsFor(config.servers[0].id, FILE), { client: '1.2.3', server: '1.2.4' })
  assert.deepEqual(versionsFor(undefined, FILE), { client: '1.2.3', server: '1.2.4' })
  assert.deepEqual(versionsFor('test', FILE), { client: '2.0.0', server: '' })

  // A root write leaves the test block alone and the reverse
  writeVersion('test.server', '2.0.1', FILE)
  writeVersion('launcher', '3.0.0', FILE)
  const after = readVersions(FILE)
  assert.equal(after.client, '1.2.3')
  assert.equal(after.launcher, '3.0.0')
  assert.deepEqual(after.test, { client: '2.0.0', server: '2.0.1' })
})

test('server files: the main server keeps the plain names, any other id is suffixed', () => {
  const data = path.resolve(__dirname, '..', 'data')
  const main = config.servers[0].id
  assert.equal(manifestPath(main), path.join(data, 'manifest.json'))
  assert.equal(manifestPath(undefined), path.join(data, 'manifest.json'))
  assert.equal(manifestPath('test'), path.join(data, 'manifest-test.json'))
  assert.equal(modlistPath(main), path.join(data, 'modlist.json'))
  assert.equal(modlistPath('test'), path.join(data, 'modlist-test.json'))
  assert.equal(extrasDirName(main), 'extras')
  assert.equal(extrasDirName('test'), 'extras-test')
  assert.equal(config.serverOrMain('no-such-server').id, main)
})
