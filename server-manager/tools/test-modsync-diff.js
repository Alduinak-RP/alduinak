'use strict'

// The manifest diff on version bumps and unchanged builds, and the per-profile diff files, in temp folders: node tools/test-modsync-diff.js

const assert = require('node:assert/strict')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const modsync = require('../src/modsync')
const config = require('../src/config')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alduinak-diff-test-'))
const dataDir = path.join(root, 'Data')
const mo2Root = path.join(root, 'MO2')
const profileDir = path.join(mo2Root, 'profiles', 'Alduinak')
for (const d of [dataDir, path.join(mo2Root, 'mods'), profileDir]) fs.mkdirSync(d, { recursive: true })

// A file with a TES4 header, so the light flag can be read
function plugin(dir, name, light = false) {
  const buf = Buffer.alloc(24)
  buf.write('TES4', 0, 'latin1')
  buf.writeUInt32LE(light ? 0x200 : 0, 8)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), buf)
}
for (const n of modsync.VANILLA_PLUGINS) plugin(dataDir, n)
plugin(dataDir, 'A.esp')
plugin(path.join(mo2Root, 'mods', 'ModA'), 'A.esp')

const file = (to, sha256 = 'aa', size = 24) => ({ to, sha256, size, inline: false })
const mod = (name, version, files) => ({ name, version, hash: 'h:' + files.map(f => `${f.to}=${f.sha256}`).join(','), files })
const manifest = (builtAt, mods, plugins = ['A.esp']) => ({ builtAt, order: mods.map(m => m.name), plugins: plugins.map(p => '*' + p), creations: null, mods })

const paths = { manifest: path.join(root, 'manifest.json'), prevManifest: path.join(root, 'manifest.json.prev'), diff: path.join(root, 'diff.json'), stamp: path.join(root, 'stamp.json'), modlist: path.join(root, 'modlist.json') }
const settings = { dataDir, loadOrder: [...modsync.VANILLA_PLUGINS, 'A.esp'].map(n => `${dataDir.replace(/\\/g, '/')}/${n}`) }
const diffOf = (prev, next, previousDiff = null) => modsync.computeDiff({ prev, next, settings, previousDiff, dataDir, mo2Root, profileDir, paths })

try {
  const v1 = manifest('2026-01-01T00:00:00Z', [mod('ModA', '1.0', [file('A.esp')])])
  const v1again = manifest('2026-01-02T00:00:00Z', [mod('ModA', '1.0', [file('A.esp')])])
  const v2 = manifest('2026-01-03T00:00:00Z', [mod('ModA', '1.1', [file('A.esp')])])
  const edited = manifest('2026-01-04T00:00:00Z', [mod('ModA', '1.1', [file('A.esp', 'bb')])])

  // Same mods, files and versions: nothing changed, whatever the build time
  const same = diffOf(v1, v1again)
  assert.deepEqual(same.mods, { added: [], removed: [], changed: [] })
  assert.equal(same.files.added + same.files.removed + same.files.changed, 0)
  assert.equal(same.plugins.reordered, false)
  assert.ok(modsync.nothingChanged(same))
  assert.equal(same.purgeNeeded, false)
  assert.equal(same.manifestPath, paths.manifest)

  // A version bump with identical files is a change
  const bump = diffOf(v1, v2)
  assert.deepEqual(bump.mods.changed, [{ name: 'ModA', filesAdded: 0, filesRemoved: 0, filesChanged: 0, versionFrom: '1.0', versionTo: '1.1' }])
  assert.ok(!modsync.nothingChanged(bump))
  assert.equal(bump.files.changed, 0)

  // A changed file under the same version reports the file counts and no version pair
  const files = diffOf(v2, edited)
  assert.deepEqual(files.mods.changed, [{ name: 'ModA', filesAdded: 0, filesRemoved: 0, filesChanged: 1 }])
  assert.equal(files.files.changed, 1)
  assert.ok(!modsync.nothingChanged(files))

  // A first build has no previous manifest: every mod is added
  const first = diffOf(null, v1)
  assert.deepEqual(first.mods.added, ['ModA'])
  assert.ok(!modsync.nothingChanged(first))

  // A mod dropped from MO2
  const dropped = diffOf(v1, manifest('2026-01-05T00:00:00Z', [], []))
  assert.deepEqual(dropped.mods.removed, ['ModA'])
  assert.deepEqual(dropped.plugins.removed, ['A.esp'])
  assert.ok(!modsync.nothingChanged(dropped))
  assert.ok(!modsync.nothingChanged(null))

  // Diff files follow the paths handed in, never the live set
  modsync.writeDiff(bump, paths)
  assert.ok(fs.existsSync(paths.diff))
  assert.equal(modsync.readDiff(paths).builtAt, v2.builtAt)
  assert.equal(modsync.updateDiff({ syncedDataAt: 'now' }, paths).syncedDataAt, 'now')
  assert.equal(modsync.readDiff(paths).syncedDataAt, 'now')
  assert.equal(modsync.readDiff({ diff: path.join(root, 'none.json') }), null)
  assert.ok(modsync.purgePending({ syncedSettingsAt: 'x', purgeNeeded: true, purgedAt: null }))

  // Each profile owns its own set under the backend data dir
  const live = modsync.pathsFor(config.profiles.live)
  const test = modsync.pathsFor(config.profiles.test)
  assert.deepEqual(live, modsync.paths)
  assert.equal(path.basename(live.diff), 'manifest-diff.json')
  assert.equal(path.basename(test.diff), 'manifest-diff-test.json')
  assert.equal(path.basename(test.manifest), 'manifest-test.json')
  assert.equal(path.basename(test.prevManifest), 'manifest-test.json.prev')
  assert.equal(path.basename(test.stamp), 'data-sync-test.json')
  assert.equal(path.basename(test.modlist), 'modlist-test.json')
  assert.equal(path.dirname(test.diff), config.paths.dataDir)

  console.log('test-modsync-diff: OK')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
