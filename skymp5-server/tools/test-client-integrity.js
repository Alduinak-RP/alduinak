'use strict'

// ClientIntegritySystem against the test server's real data/manifest.json and the backend's client-modules list for the
// test manifest: plugin and dll rules, malformed reports, and the login/recheck kick paths: node tools/test-client-integrity.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..', '..')
const SYSTEMS = path.join(__dirname, '..', 'ts', 'systems')
const SERVER_MANIFEST = path.join(ROOT, 'build', 'dist', 'testserver', 'data', 'manifest.json')

// discordAlert records instead of queueing a Discord post
const alertRecorder = {
  name: 'alert-recorder',
  setup: (build) => {
    build.onResolve({ filter: /^\.\/discordAlerts$/ }, () => ({ path: 'discordAlerts', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function discordAlert(kind: string, text: string) { ((globalThis as any).__alerts ||= []).push([kind, text]); }',
      loader: 'ts',
    }))
  },
}

const load = async () => {
  const { outputFiles } = await esbuild.build({ stdin: { contents: 'export * from "./clientIntegrity";', resolveDir: SYSTEMS, sourcefile: 'entry.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error', plugins: [alertRecorder] })
  const file = path.join(SYSTEMS, 'entry.js')
  const compiled = new Module(file)
  compiled.paths = Module._nodeModulePaths(SYSTEMS)
  compiled._compile(outputFiles[0].text, file)
  return compiled.exports
}

const main = async () => {
  const { parseReport, pluginProblems, moduleProblems, ClientIntegritySystem } = await load()
  const manifest = JSON.parse(fs.readFileSync(SERVER_MANIFEST, 'utf8'))
  const { clientModules } = require(path.join(ROOT, 'skymp5-backend', 'sources', 'clientModules'))
  const list = clientModules('test')
  assert.ok(list && Object.keys(list.modules).length > 0, 'the test manifest lists dlls')

  const byName = new Map(manifest.mods.map((m) => [m.filename.toLowerCase(), m]))
  const cleanPlugins = () => [...manifest.loadOrder, '_ResourcePack.esl'].map((name) => {
    const m = byName.get(name.toLowerCase())
    return { name, crc32: m ? m.crc32 | 0 : 0, size: m ? m.size : 0 }
  })
  const entry = (name) => list.modules[name.toLowerCase()][0]
  const cleanModules = () => [
    { path: 'Data\\SKSE\\Plugins\\EngineFixes.dll', size: entry('EngineFixes.dll').size, sha256: entry('EngineFixes.dll').sha256 },
    { path: '...\\SKSE\\Plugins\\po3_Tweaks.dll', size: entry('po3_Tweaks.dll').size, sha256: entry('po3_Tweaks.dll').sha256 },
    { path: 'Data\\Platform\\Distribution\\RuntimeDependencies\\libcef.dll', size: entry('libcef.dll').size, sha256: '' },
    { path: 'skse64_1_6_1179.dll', size: 1, sha256: entry('skse64_1_6_1179.dll').sha256 },
    { path: 'steam_api64.dll', size: 300000, sha256: 'ab'.repeat(32) },
  ]

  // Parsing: malformed input is no report at all
  assert.equal(parseReport(null), null)
  assert.equal(parseReport('x'), null)
  assert.deepEqual(parseReport({}), { plugins: null, modules: null })
  assert.equal(parseReport({ plugins: [{ name: 5 }], modules: [] }).plugins, null)
  assert.equal(parseReport({ plugins: [], modules: [{ path: 'a'.repeat(600) }] }).modules, null)
  assert.equal(parseReport({ modules: new Array(5000).fill({ path: 'x.dll' }) }).modules, null)
  assert.equal(parseReport({ modules: [{ path: 'X.dll', size: 1, sha256: 'ABC' }] }).modules[0].sha256, 'abc')

  // Plugins
  assert.deepEqual(pluginProblems(cleanPlugins(), manifest.loadOrder, manifest.mods), [])
  assert.deepEqual(pluginProblems(null, manifest.loadOrder, manifest.mods), ['the client sent no plugin list'])
  assert.deepEqual(pluginProblems([...cleanPlugins(), { name: 'Cheats.esp', crc32: 1, size: 1 }], manifest.loadOrder, manifest.mods), ['extra plugin Cheats.esp'])
  const edited = cleanPlugins()
  const modded = edited.find((p) => p.name === 'Immersive Weapons.esp')
  modded.crc32 ^= 1
  assert.deepEqual(pluginProblems(edited, manifest.loadOrder, manifest.mods), ['modified plugin Immersive Weapons.esp'])
  const unhashed = cleanPlugins()
  Object.assign(unhashed.find((p) => p.name === 'Immersive Weapons.esp'), { crc32: 0, size: 0 })
  assert.deepEqual(pluginProblems(unhashed, manifest.loadOrder, manifest.mods), ['modified plugin Immersive Weapons.esp'])
  assert.deepEqual(pluginProblems(cleanPlugins().filter((p) => p.name !== 'Immersive Weapons.esp'), manifest.loadOrder, manifest.mods), ['missing plugin Immersive Weapons.esp'])
  // Vanilla masters and Creation Club files go unhashed
  const vanilla = cleanPlugins().map((p) => /^(skyrim|update)\.esm$|^cc/i.test(p.name) ? { ...p, crc32: 0, size: 0 } : p)
  assert.deepEqual(pluginProblems(vanilla, manifest.loadOrder, manifest.mods), [])
  // Case differences between the engine and the manifest do not matter
  assert.deepEqual(pluginProblems(cleanPlugins().map((p) => ({ ...p, name: p.name.toUpperCase() })), manifest.loadOrder, manifest.mods), [])

  // Dlls
  const none = new Set()
  assert.deepEqual(moduleProblems(cleanModules(), list, none), [])
  assert.deepEqual(moduleProblems(null, list, none), ['the client cannot list its dlls (outdated SkyrimPlatform)'])
  assert.deepEqual(moduleProblems([...cleanModules(), { path: '...\\SKSE\\Plugins\\SpeedHack.dll', size: 9, sha256: 'cd'.repeat(32) }], list, none), ['extra dll .../SKSE/Plugins/SpeedHack.dll'])
  assert.deepEqual(moduleProblems([{ path: 'dxgi.dll', size: 9, sha256: 'cd'.repeat(32) }], list, none), ['extra dll dxgi.dll'])
  assert.deepEqual(moduleProblems([{ path: 'dxgi.dll', size: 9, sha256: 'cd'.repeat(32) }], list, new Set(['dxgi.dll'])), [])
  assert.deepEqual(moduleProblems([{ path: 'Data\\SKSE\\Plugins\\EngineFixes.dll', size: 1, sha256: 'cd'.repeat(32) }], list, none), ['modified dll Data/SKSE/Plugins/EngineFixes.dll'])
  assert.deepEqual(moduleProblems([{ path: 'Data\\Platform\\Distribution\\RuntimeDependencies\\libcef.dll', size: 5, sha256: '' }], list, none), ['modified dll Data/Platform/Distribution/RuntimeDependencies/libcef.dll'])
  assert.deepEqual(moduleProblems([{ path: 'skse64_1_6_1179.dll', size: 1, sha256: '' }], list, none), ['modified dll skse64_1_6_1179.dll'])
  // A store dll is free only in the game root
  assert.deepEqual(moduleProblems([{ path: 'Data\\SKSE\\Plugins\\steam_api64.dll', size: 1, sha256: 'cd'.repeat(32) }], list, none), ['extra dll Data/SKSE/Plugins/steam_api64.dll'])

  // Login and recheck through the system
  const kicked = []
  const packets = []
  let guid = 'g1'
  const svr = {
    getUserGuid: () => guid, isConnected: () => true, getUserActor: () => 0xff000d22,
    sendCustomPacket: (userId, json) => packets.push([userId, JSON.parse(json)]), kick: (userId) => kicked.push(userId),
  }
  const ctx = { svr, gm: null }
  let fetches = 0
  global.fetch = async (url, opts) => {
    fetches++
    assert.match(url, /\/api\/servers\/KEY\/client-modules$/)
    assert.equal(opts.headers['X-Auth-Token'], 'TOKEN')
    return { ok: true, json: async () => list }
  }
  const make = (mode) => {
    const sys = new ClientIntegritySystem(() => {}, 'http://backend', 'KEY')
    Object.assign(sys, { mode, authToken: 'TOKEN', dataDir: path.dirname(SERVER_MANIFEST) })
    return sys
  }
  const report = () => ({ plugins: cleanPlugins(), modules: cleanModules() })
  const cheat = () => ({ plugins: cleanPlugins(), modules: [...cleanModules(), { path: '...\\SKSE\\Plugins\\SpeedHack.dll', size: 9, sha256: 'cd'.repeat(32) }] })
  const quiet = (fn) => async (...a) => { const log = console.log; console.log = () => {}; try { return await fn(...a) } finally { console.log = log } }

  assert.equal(await make('off').checkLogin(3, 7, '123456', undefined, ctx), true)
  assert.equal(fetches, 0, 'off mode asks the backend nothing')

  const kick = make('kick')
  assert.equal(await kick.checkLogin(3, 7, '123456', report(), ctx), true)
  assert.equal(kicked.length, 0)
  assert.equal(await quiet(() => kick.checkLogin(3, 7, '123456', cheat(), ctx))(), false)
  assert.deepEqual(kicked, [3])
  assert.equal(packets[0][1].customPacketType, 'kicked')
  assert.match(packets[0][1].reason, /extra dll \.\.\.\/SKSE\/Plugins\/SpeedHack\.dll/)
  assert.equal(fetches, 1, 'the dll list is cached')
  assert.match(globalThis.__alerts[0][1], /profile 7 \(slot 3\) failed the client check at login, kicked: extra dll/)
  assert.equal(globalThis.__alerts[0][0], 'integrity')

  // An old client sends nothing at all
  assert.equal(await quiet(() => kick.checkLogin(4, 8, null, undefined, ctx))(), false)
  assert.match(packets[1][1].reason, /no file report \(outdated client\)/)

  // The kick lists five problems and counts the rest
  const many = { plugins: cleanPlugins(), modules: Array.from({ length: 8 }, (_, i) => ({ path: `x${i}.dll`, size: 1, sha256: '' })) }
  assert.equal(await quiet(() => kick.checkLogin(5, 9, null, many, ctx))(), false)
  assert.match(packets[2][1].reason, /x4\.dll\n\.\.\.and 3 more/)
  assert.doesNotMatch(packets[2][1].reason, /x5\.dll/)

  // The slot changed hands during the check: nobody is kicked
  const before = kicked.length
  const slow = make('kick')
  global.fetch = async () => { guid = 'g2'; return { ok: true, json: async () => list } }
  assert.equal(await slow.checkLogin(6, 10, null, cheat(), ctx), false)
  assert.equal(kicked.length, before)
  guid = 'g1'

  // Log mode alerts but lets the player in
  const logOnly = make('log')
  logOnly.moduleList = { value: list, at: Date.now() }
  assert.equal(await quiet(() => logOnly.checkLogin(3, 7, null, cheat(), ctx))(), true)
  assert.equal(kicked.length, before)
  assert.match(globalThis.__alerts[globalThis.__alerts.length - 1][1], /logged only/)

  // The periodic report kicks a dll loaded after login
  await quiet(async () => {
    kick.customPacket(3, 'integrityReport', { integrity: cheat() }, ctx)
    await new Promise((r) => setTimeout(r, 10))
  })()
  assert.equal(kicked[kicked.length - 1], 3)
  assert.match(globalThis.__alerts[globalThis.__alerts.length - 1][1], /actor ff000d22 \(slot 3\) failed the client check at recheck/)

  // Backend down and no cached list: the check fails closed in kick mode
  const cold = make('kick')
  global.fetch = async () => ({ ok: false, status: 503 })
  const err = console.error
  console.error = () => {}
  assert.equal(await quiet(() => cold.checkLogin(3, 7, null, report(), ctx))(), false)
  console.error = err
  assert.match(packets[packets.length - 1][1].reason, /cannot get the allowed dll list/)

  console.log('test-client-integrity: all checks passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
