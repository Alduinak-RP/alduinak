'use strict'

// ClientIntegritySystem against the test server's real data/manifest.json and the backend's client-modules list for the
// test manifest: plugin and dll rules, malformed reports, the login/recheck kick paths, the skipped checks while the
// backend or the manifest is unavailable, and the boot prefetch: node tools/test-client-integrity.js

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
  const entry = (name) => {
    const entries = list.modules[name.toLowerCase()]
    assert.ok(entries, `${name} is in the test manifest's dll list`)
    return entries[0]
  }
  const cleanModules = () => [
    { path: 'Data\\SKSE\\Plugins\\EngineFixes.dll', size: entry('EngineFixes.dll').size, sha256: entry('EngineFixes.dll').sha256 },
    { path: '...\\SKSE\\Plugins\\po3_Tweaks.dll', size: entry('po3_Tweaks.dll').size, sha256: entry('po3_Tweaks.dll').sha256 },
    { path: 'Data\\Platform\\Distribution\\RuntimeDependencies\\libcef.dll', size: entry('libcef.dll').size, sha256: '' },
    { path: 'skse64_1_6_1179.dll', size: 1, sha256: entry('skse64_1_6_1179.dll').sha256 },
    { path: 'steam_api64.dll', size: 300000, sha256: 'ab'.repeat(32) },
  ]
  // The owner's 2026-10-05 login report shape (23 dlls): lower-case data\SKSE\Plugins, Platform dlls, store and SKSE dlls in the root
  const OWNER_SKSE_PLUGINS = ['EngineFixes.dll', 'ActorLimitFix.dll', 'AnimationQueueFix.dll', 'CraftingCategories.dll', 'CrashLogger.dll', 'DynDOLOD.DLL', 'hdtsmp64.dll', 'MCMHelper.dll', 'NativeEditorIDFix.dll', 'po3_Tweaks.dll', 'SimpleDualSheath.dll', 'SkyrimPlatform.dll', 'SkyrimSoulsRE.dll', 'SSEDisplayTweaks.dll', 'MpClientPlugin.dll']
  const ownerModules = () => [
    { path: 'steam_api64.dll', size: 294816, sha256: 'ab'.repeat(32) },
    { path: 'bink2w64.dll', size: 401920, sha256: 'ab'.repeat(32) },
    { path: 'd3dx9_42.dll', size: entry('d3dx9_42.dll').size, sha256: entry('d3dx9_42.dll').sha256 },
    { path: 'skse64_1_6_1170.dll', size: 288256, sha256: entry('skse64_1_6_1170.dll').sha256 },
    ...OWNER_SKSE_PLUGINS.map((n) => ({ path: `data\\SKSE\\Plugins\\${n}`, size: entry(n).size, sha256: entry(n).sha256 })),
    ...['SkyrimPlatformImpl.dll', 'chrome_elf.dll'].map((n) => ({ path: `Data\\Platform\\Distribution\\RuntimeDependencies\\${n}`, size: entry(n).size, sha256: entry(n).sha256 })),
    ...['libcef.dll', 'libnode.dll'].map((n) => ({ path: `Data\\Platform\\Distribution\\RuntimeDependencies\\${n}`, size: entry(n).size, sha256: '' })),
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
  assert.deepEqual(moduleProblems(ownerModules(), list, none), [], 'the owner\'s real report passes')
  assert.equal(ownerModules().length, 23)
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
  const logs = []
  let guid = 'g1'
  const svr = {
    getUserGuid: () => guid, isConnected: () => true, getUserActor: () => 0xff000d22,
    sendCustomPacket: (userId, json) => packets.push([userId, JSON.parse(json)]), kick: (userId) => kicked.push(userId),
  }
  const ctx = { svr, gm: null }
  let fetches = 0
  const backendUp = async (url, opts) => {
    fetches++
    assert.match(url, /\/api\/servers\/KEY\/client-modules$/)
    assert.equal(opts.headers['X-Auth-Token'], 'TOKEN')
    assert.ok(opts.signal instanceof AbortSignal && !opts.signal.aborted, 'the request carries a timeout signal')
    return { ok: true, json: async () => list }
  }
  const backendDown = (status) => async (url, opts) => {
    fetches++
    assert.ok(opts.signal instanceof AbortSignal, 'the request carries a timeout signal')
    return { ok: false, status }
  }
  global.fetch = backendUp
  const make = (mode) => {
    const sys = new ClientIntegritySystem((...a) => logs.push(a.join(' ')), 'http://backend', 'KEY')
    Object.assign(sys, { mode, authToken: 'TOKEN', dataDir: path.dirname(SERVER_MANIFEST) })
    return sys
  }
  const report = () => ({ plugins: cleanPlugins(), modules: cleanModules() })
  const cheat = () => ({ plugins: cleanPlugins(), modules: [...cleanModules(), { path: '...\\SKSE\\Plugins\\SpeedHack.dll', size: 9, sha256: 'cd'.repeat(32) }] })
  const cheatPlugin = () => ({ plugins: [...cleanPlugins(), { name: 'Cheats.esp', crc32: 1, size: 1 }], modules: cleanModules() })
  const silence = (which, fn) => async (...a) => { const orig = console[which]; console[which] = () => {}; try { return await fn(...a) } finally { console[which] = orig } }
  const quiet = (fn) => silence('log', fn)
  const quietErr = (fn) => silence('error', fn)
  const lastLog = () => logs[logs.length - 1]
  const lastPacket = () => packets[packets.length - 1][1]
  const lastAlert = () => globalThis.__alerts[globalThis.__alerts.length - 1][1]
  const alerts = () => (globalThis.__alerts || []).length
  const recheck = (sys, userId, integrity) => quiet(async () => {
    sys.customPacket(userId, 'integrityReport', { integrity }, ctx)
    await new Promise((r) => setTimeout(r, 10))
  })()

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
  assert.equal(logs.length, 0, 'a clean login and a kick write no skip line')

  // An old client sends nothing at all
  assert.equal(await quiet(() => kick.checkLogin(4, 8, null, undefined, ctx))(), false)
  assert.match(packets[1][1].reason, /no file report \(outdated client\)/)

  // The kick lists five problems and counts the rest
  const many = { plugins: cleanPlugins(), modules: Array.from({ length: 8 }, (_, i) => ({ path: `x${i}.dll`, size: 1, sha256: '' })) }
  assert.equal(await quiet(() => kick.checkLogin(5, 9, null, many, ctx))(), false)
  assert.match(packets[2][1].reason, /x4\.dll\n\.\.\.and 3 more/)
  assert.doesNotMatch(packets[2][1].reason, /x5\.dll/)

  // The slot changed hands during the check: nobody is kicked
  let before = kicked.length
  const slow = make('kick')
  global.fetch = async () => { guid = 'g2'; return { ok: true, json: async () => list } }
  assert.equal(await slow.checkLogin(6, 10, null, cheat(), ctx), false)
  assert.equal(kicked.length, before)
  guid = 'g1'
  global.fetch = backendUp

  // Log mode alerts but lets the player in
  const logOnly = make('log')
  logOnly.moduleList = { value: list, at: Date.now() }
  assert.equal(await quiet(() => logOnly.checkLogin(3, 7, null, cheat(), ctx))(), true)
  assert.equal(kicked.length, before)
  assert.match(lastAlert(), /logged only/)

  // The periodic report kicks a dll loaded after login
  await recheck(kick, 3, cheat())
  assert.equal(kicked[kicked.length - 1], 3)
  assert.match(lastAlert(), /actor ff000d22 \(slot 3\) failed the client check at recheck/)

  // A main menu login carries dlls but no plugin list yet: skipped at login, a client problem at the recheck
  const menu = make('kick')
  menu.moduleList = { value: list, at: Date.now() }
  before = kicked.length
  assert.equal(await menu.checkLogin(3, 7, null, { plugins: null, modules: cleanModules() }, ctx), true)
  assert.equal(kicked.length, before)
  assert.equal(lastLog(), 'ClientIntegrity: plugin check skipped at login for profile 7 (slot 3): the client has not read its plugin list yet (login from the main menu)')
  await recheck(menu, 3, { plugins: null, modules: cleanModules() })
  assert.equal(kicked.length, before + 1)
  assert.match(lastPacket().reason, /the client sent no plugin list/)
  // Neither list (an old SkyrimPlatform) stays a client problem at login
  assert.equal(await quiet(() => menu.checkLogin(3, 7, null, {}, ctx))(), false)
  assert.match(lastPacket().reason, /no plugin list\n.*cannot list its dlls/)

  // Backend down and no cached list: the dll check is skipped and logged, the login goes on
  global.fetch = backendDown(404)
  const cold = make('kick')
  before = kicked.length
  let alertsBefore = alerts()
  assert.equal(await quiet(quietErr(() => cold.checkLogin(3, 7, null, report(), ctx)))(), true)
  assert.equal(kicked.length, before)
  assert.equal(lastLog(), 'ClientIntegrity: dll check skipped at login for profile 7 (slot 3): the server cannot get the allowed dll list (HTTP 404)')
  assert.equal(alerts(), alertsBefore + 1, 'the outage raises one alert')
  assert.equal(lastAlert(), 'dll check skipped for every login: the server cannot get the allowed dll list (HTTP 404)')
  // Without the list a cheat dll cannot be seen, and the outage is not alerted again
  assert.equal(await quietErr(() => cold.checkLogin(4, 8, null, cheat(), ctx))(), true)
  assert.equal(kicked.length, before)
  assert.equal(alerts(), alertsBefore + 1, 'no alert per login during the outage')
  assert.equal(lastLog(), 'ClientIntegrity: dll check skipped at login for profile 8 (slot 4): the server cannot get the allowed dll list (HTTP 404)')
  // A plugin problem still kicks while the backend is down, and the kick names only the client problem
  assert.equal(await quiet(quietErr(() => cold.checkLogin(3, 7, null, cheatPlugin(), ctx)))(), false)
  assert.equal(kicked.length, before + 1)
  assert.match(lastPacket().reason, /extra plugin Cheats\.esp/)
  assert.doesNotMatch(lastPacket().reason, /dll list/)
  // The recheck skips the same way
  await quietErr(() => recheck(cold, 3, cheat()))()
  assert.equal(kicked.length, before + 1)
  assert.equal(lastLog(), 'ClientIntegrity: dll check skipped at recheck for actor ff000d22 (slot 3): the server cannot get the allowed dll list (HTTP 404)')
  // The backend answers again: one line, the cheat dll is seen
  global.fetch = backendUp
  assert.equal(await quiet(() => cold.checkLogin(3, 7, null, cheat(), ctx))(), false)
  assert.equal(kicked.length, before + 2)
  assert.equal(lastLog(), 'ClientIntegrity: dll check runs again')
  // A timed out request reads as such
  global.fetch = async (url, opts) => { assert.ok(opts.signal instanceof AbortSignal); throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }
  const hang = make('kick')
  assert.equal(await quiet(quietErr(() => hang.checkLogin(3, 7, null, report(), ctx)))(), true)
  assert.equal(lastLog(), 'ClientIntegrity: dll check skipped at login for profile 7 (slot 3): the server cannot get the allowed dll list (no answer in 5000 ms)')
  global.fetch = backendUp

  // The server cannot read its manifest: the plugin check is skipped, the dll check still runs
  const noManifest = make('kick')
  noManifest.dataDir = path.join(__dirname, 'nowhere')
  noManifest.moduleList = { value: list, at: Date.now() }
  before = kicked.length
  alertsBefore = alerts()
  assert.equal(await quiet(quietErr(() => noManifest.checkLogin(3, 7, null, report(), ctx)))(), true)
  assert.equal(kicked.length, before)
  assert.equal(lastLog(), 'ClientIntegrity: plugin check skipped at login for profile 7 (slot 3): the server cannot read its plugin manifest')
  assert.equal(lastAlert(), 'plugin check skipped for every login: the server cannot read its plugin manifest')
  assert.equal(await quiet(quietErr(() => noManifest.checkLogin(3, 7, null, cheat(), ctx)))(), false)
  assert.equal(kicked.length, before + 1)
  assert.equal(alerts(), alertsBefore + 2, 'the manifest outage alerted once, the kick once')

  // Boot prefetch: one line either way, the outage alert once
  const boot = make('kick')
  await boot.prefetchModuleList()
  assert.equal(lastLog(), `ClientIntegrity: allowed dll list: ${Object.keys(list.modules).length} dll names from the backend`)
  global.fetch = backendDown(404)
  const bootCold = make('kick')
  alertsBefore = alerts()
  await quiet(quietErr(() => bootCold.prefetchModuleList()))()
  assert.equal(lastLog(), 'ClientIntegrity: the backend gave no dll list (HTTP 404): dll checks are skipped until it answers, is AlduinakBackend running the current code?')
  assert.equal(alerts(), alertsBefore + 1)
  assert.equal(await quietErr(() => bootCold.checkLogin(3, 7, null, report(), ctx))(), true)
  assert.equal(alerts(), alertsBefore + 1, 'the login after a failed prefetch alerts nothing new')
  global.fetch = backendUp

  console.log('test-client-integrity: all checks passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
