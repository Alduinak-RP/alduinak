'use strict'

// The migrate helpers in temp dirs: server items with backup, the settings merge, the client mirror and the manifest URL rewrite: node tools/test-migrate.js

const assert = require('node:assert/strict')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const m = require('../src/migrate')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alduinak-migrate-test-'))
const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const r = file => fs.readFileSync(file, 'utf8')

function testServerItems() {
  const test = path.join(root, 'testserver')
  const live = path.join(root, 'server')
  const backup = path.join(root, 'backup', 'server')
  w(path.join(test, 'dist_back', 'skymp5-server.js'), 'new bundle')
  w(path.join(test, 'gamemode.js'), 'new gm')
  w(path.join(test, 'gamemode_extensions', '10_a.js'), 'a')
  w(path.join(test, 'data', 'scripts', 'x.pex'), 'x')
  w(path.join(test, 'housing.json'), '{"test":1}')
  w(path.join(test, 'server-settings.json'), '{"name":"Test"}')
  w(path.join(live, 'dist_back', 'skymp5-server.js'), 'old bundle')
  w(path.join(live, 'gamemode.js'), 'old gm')
  w(path.join(live, 'gamemode_extensions', '00_old.js'), 'old')
  w(path.join(live, 'gamemode_extensions', '10_a.js'), 'old a')
  w(path.join(live, 'housing.json'), '{"live":1}')
  w(path.join(live, 'server-settings.json'), '{"name":"Live"}')
  w(path.join(live, 'world', 'changeForms', '1.json'), '{}')
  const logs = []
  const res = m.copyServerItems({ from: test, to: live, backupDir: backup, log: t => logs.push(t) })
  assert.deepEqual(res.copied, ['dist_back', 'gamemode.js', 'gamemode_extensions', 'data/scripts'])
  assert.deepEqual(res.backedUp, ['dist_back', 'gamemode.js', 'gamemode_extensions'])
  assert.equal(r(path.join(live, 'dist_back', 'skymp5-server.js')), 'new bundle')
  assert.equal(r(path.join(live, 'gamemode.js')), 'new gm')
  assert.ok(!fs.existsSync(path.join(live, 'gamemode_extensions', '00_old.js')), 'a directory is replaced wholesale')
  assert.equal(r(path.join(live, 'gamemode_extensions', '10_a.js')), 'a')
  assert.equal(r(path.join(live, 'data', 'scripts', 'x.pex')), 'x')
  // State and identity files stay
  assert.equal(r(path.join(live, 'housing.json')), '{"live":1}')
  assert.equal(r(path.join(live, 'server-settings.json')), '{"name":"Live"}')
  assert.ok(fs.existsSync(path.join(live, 'world', 'changeForms', '1.json')))
  // The backup holds the old copies
  assert.equal(r(path.join(backup, 'dist_back', 'skymp5-server.js')), 'old bundle')
  assert.equal(r(path.join(backup, 'gamemode.js')), 'old gm')
  assert.equal(r(path.join(backup, 'gamemode_extensions', '00_old.js')), 'old')
  assert.ok(!fs.existsSync(path.join(backup, 'housing.json')))
  assert.ok(logs.some(l => l.startsWith('skip scam_native.node')))
  assert.match(m.stamp(), /^\d{8}-\d{6}$/)
}

function testSettingsMerge() {
  const live = {
    name: 'Alduinak', port: 7777, maxPlayers: 64, masterKey: 'k', dataDir: 'C:/GOG Games/Skyrim Anniversary Edition/Data',
    loadOrder: ['C:/GOG Games/Skyrim Anniversary Edition/Data/Skyrim.esm', 'C:/GOG Games/Skyrim Anniversary Edition/Data/Old.esp'],
    archives: ['C:/GOG Games/Skyrim Anniversary Edition/Data/Skyrim - Misc.bsa'],
    respawnSeconds: 30, reloot: { a: 1 }, liveOnly: true, access: { locked: true }, healthRegenerationMultiplier: 1,
  }
  const test = {
    name: 'Test Server', port: 7787, maxPlayers: 20, masterKey: 't', dataDir: 'C:\\GOG Games\\Skyrim Anniversary Edition - Test\\Data',
    loadOrder: ['C:/GOG Games/Skyrim Anniversary Edition - Test/Data/Skyrim.esm', 'c:/gog games/skyrim anniversary edition - test/Data/New.esp', 'D:/elsewhere/Other.esp'],
    archives: ['C:/GOG Games/Skyrim Anniversary Edition - Test/Data/Skyrim - Misc.bsa', 'C:/GOG Games/Skyrim Anniversary Edition - Test/Data/New.bsa'],
    respawnSeconds: 45, reloot: { a: 1 }, newKey: [1, 2], access: { locked: false }, enableConsoleCommandsForAll: true, isPapyrusHotReloadEnabled: true, gamemodeHotReload: true,
    alduinakDamageFormulaSettings: { enabled: true }, survivalEnabled: true, masterySlots: 3, healthRegenerationMultiplier: 0,
  }
  const logs = []
  const res = m.mergeSettings({ live, test, log: t => logs.push(t) })
  assert.deepEqual(res.added, ['newKey'])
  assert.deepEqual(res.changed, ['respawnSeconds'])
  assert.deepEqual(res.kept, ['name', 'port', 'maxPlayers', 'masterKey', 'dataDir', 'access', 'enableConsoleCommandsForAll', 'isPapyrusHotReloadEnabled', 'gamemodeHotReload', 'alduinakDamageFormulaSettings', 'survivalEnabled', 'masterySlots', 'healthRegenerationMultiplier'])
  const mg = res.merged
  assert.equal(mg.name, 'Alduinak')
  assert.equal(mg.port, 7777)
  assert.equal(mg.maxPlayers, 64)
  assert.equal(mg.masterKey, 'k')
  assert.equal(mg.dataDir, live.dataDir)
  assert.equal(mg.liveOnly, true)
  assert.equal(mg.respawnSeconds, 45)
  assert.deepEqual(mg.newKey, [1, 2])
  assert.deepEqual(mg.reloot, { a: 1 })
  assert.deepEqual(mg.access, { locked: true })
  assert.ok(!('enableConsoleCommandsForAll' in mg) && !('isPapyrusHotReloadEnabled' in mg) && !('gamemodeHotReload' in mg), 'debug toggles never migrate')
  assert.ok(!('alduinakDamageFormulaSettings' in mg) && !('survivalEnabled' in mg) && !('masterySlots' in mg), 'test-only feature switches never migrate')
  assert.equal(mg.healthRegenerationMultiplier, 1)
  assert.ok(logs.includes('kept survivalEnabled (protected)'))
  // The load order follows the manifest through Migrate client, never this merge
  assert.deepEqual(mg.loadOrder, live.loadOrder)
  assert.deepEqual(mg.archives, live.archives)
  assert.ok(logs.includes('loadOrder and archives left as they are: Migrate client syncs them from the manifest'))
  assert.ok(logs.includes('added newKey'))
  assert.ok(logs.includes('changed respawnSeconds: 30 -> 45'))
  assert.ok(logs.includes('kept name (protected)'))
  assert.ok(!logs.some(l => l.includes('reloot')), 'equal keys are not logged')
  assert.ok(!logs.some(l => l.includes('kept loadOrder') || l.includes('changed loadOrder')), 'the manifest lists are neither kept nor changed here')
  // The originals are untouched
  assert.equal(live.respawnSeconds, 30)
  // Long values are cut at 80 characters
  const long = []
  m.mergeSettings({ live: { a: 'x'.repeat(200) }, test: { a: 'y'.repeat(200) }, log: t => long.push(t) })
  assert.equal(long.length, 1)
  assert.ok(long[0].length < 180 && long[0].includes('...'))
  // The same settings twice change nothing
  const again = m.mergeSettings({ live: mg, test })
  assert.deepEqual([again.added, again.changed], [[], []])
  // A test file with lists but no dataDir is fine: the lists are not touched
  const bare = m.mergeSettings({ live: { loadOrder: ['L'] }, test: { loadOrder: ['T'], respawnSeconds: 1 } })
  assert.deepEqual([bare.merged.loadOrder, bare.added], [['L'], ['respawnSeconds']])
}

function testClientMirror() {
  const from = path.join(root, 'testclient')
  const to = path.join(root, 'client')
  const cef = 'Platform/Distribution/RuntimeDependencies/libcef.dll'
  w(path.join(from, 'Data', 'Platform', 'Plugins', 'skymp5-client.js'), 'new js')
  w(path.join(from, 'Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'), 'same dll')
  w(path.join(from, 'Data', cef), 'cef')
  w(path.join(from, 'Data', 'new.txt'), 'new')
  w(path.join(to, 'Data', 'Platform', 'Plugins', 'skymp5-client.js'), 'old js')
  w(path.join(to, 'Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'), 'same dll')
  w(path.join(to, 'Data', cef), 'cef')
  w(path.join(to, 'Data', 'stale', 'gone.txt'), 'gone')
  const t = new Date(2026, 0, 1)
  for (const rel of ['SKSE/Plugins/SkyrimPlatform.dll', cef]) for (const dir of [from, to]) fs.utimesSync(path.join(dir, 'Data', rel), t, t)
  const backup = path.join(root, 'backup', 'client')
  const backed = m.backupClientKeyFiles({ clientDir: to, keyFiles: ['Platform/Plugins/skymp5-client.js', 'SKSE/Plugins/SkyrimPlatform.dll', cef, 'missing.dll'], backupDir: backup })
  assert.deepEqual(backed, ['Platform/Plugins/skymp5-client.js', 'SKSE/Plugins/SkyrimPlatform.dll'])
  assert.equal(r(path.join(backup, 'Data', 'Platform', 'Plugins', 'skymp5-client.js')), 'old js')
  assert.ok(!fs.existsSync(path.join(backup, 'Data', cef)), 'the CEF runtime is never backed up')
  const logs = []
  const res = m.mirrorDir({ from, to, log: t => logs.push(t) })
  assert.deepEqual(res, { copied: 2, deleted: 1, unchanged: 2 })
  assert.equal(r(path.join(to, 'Data', 'Platform', 'Plugins', 'skymp5-client.js')), 'new js')
  assert.equal(r(path.join(to, 'Data', 'new.txt')), 'new')
  assert.ok(!fs.existsSync(path.join(to, 'Data', 'stale')), 'emptied folders go too')
  assert.deepEqual(logs, ['deleted Data/stale/gone.txt'])
  assert.deepEqual(m.mirrorDir({ from, to }), { copied: 0, deleted: 0, unchanged: 4 })
}

function testManifestRewrite() {
  const text = '{"url":"https://api.alduinak.com/files/extras-test/alduinak-extras-abc.7z","x":"/files/extras-test/other%20name.7z","keep":"/files/extras/old.7z"}'
  const out = m.rewriteExtrasUrls(text, 'extras-test', 'extras')
  assert.equal(out, '{"url":"https://api.alduinak.com/files/extras/alduinak-extras-abc.7z","x":"/files/extras/other%20name.7z","keep":"/files/extras/old.7z"}')
  assert.deepEqual(m.extrasArchives(out, 'extras'), ['alduinak-extras-abc.7z', 'other name.7z', 'old.7z'])
  assert.deepEqual(m.extrasArchives(text, 'extras'), ['old.7z'])
  const from = path.join(root, 'client-files', 'extras-test')
  const to = path.join(root, 'client-files', 'extras')
  w(path.join(from, 'alduinak-extras-abc.7z'), 'abc')
  w(path.join(from, 'other name.7z'), 'other')
  w(path.join(to, 'other name.7z'), 'other')
  const res = m.copyExtras({ names: m.extrasArchives(out, 'extras'), from, to })
  assert.deepEqual(res, { copied: ['alduinak-extras-abc.7z'], skipped: ['other name.7z'], missing: ['old.7z'] })
  assert.equal(r(path.join(to, 'alduinak-extras-abc.7z')), 'abc')
}

try {
  testServerItems()
  testSettingsMerge()
  testClientMirror()
  testManifestRewrite()
  console.log('test-migrate: OK')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
