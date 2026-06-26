'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')
const { spawn, execFile } = require('child_process')
const WebSocket = require('ws')
const config = require('./config')

let win = null
const isWin = process.platform === 'win32'

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 560,
    backgroundColor: '#14110d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  startLogTail()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── Process helpers ───────────────────────────────────────────────────────────

// Run a command, streaming combined stdout/stderr to the renderer's build log.
function runStreaming(cmd, args, cwd, label, env, shell = isWin) {
  return new Promise(resolve => {
    send('build:log', `\n$ ${label || cmd + ' ' + args.join(' ')}\n`)
    let child
    try {
      child = spawn(cmd, args, { cwd, shell, windowsHide: true, env: { ...process.env, ...(env || {}) } })
    } catch (err) {
      send('build:log', `[spawn failed] ${err.message}\n`)
      return resolve({ ok: false, code: -1 })
    }
    child.stdout.on('data', d => send('build:log', d.toString()))
    child.stderr.on('data', d => send('build:log', d.toString()))
    child.on('error', err => { send('build:log', `[error] ${err.message}\n`); resolve({ ok: false, code: -1 }) })
    child.on('close', code => {
      send('build:log', `\n[exit ${code}]\n`)
      resolve({ ok: code === 0, code })
    })
  })
}

// nssm <verb> <service> — returns trimmed stdout (status string or message).
function nssm(verb, service) {
  return new Promise(resolve => {
    execFile(config.nssm, [verb, service], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      // nssm prints UTF-16LE; read as utf8 it interleaves NUL bytes — strip them.
      const clean = String(stdout || stderr || (err && err.message) || '').replace(/\u0000/g, '').trim()
      resolve(clean)
    })
  })
}

const yarnOrNpm = () => {
  // build scripts prefer yarn when present, else npm with legacy peer deps.
  try { require('child_process').execSync(isWin ? 'where yarn' : 'which yarn', { stdio: 'ignore' }); return 'yarn' }
  catch { return 'npm' }
}

// Install a project's dependencies if they're missing (mirrors the build bats'
// first-run behaviour), so the manager can build a freshly-cloned checkout.
async function ensureDeps(dir, pm, label) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return { ok: true }
  const args = pm === 'yarn' ? ['install', '--frozen-lockfile'] : ['install', '--legacy-peer-deps']
  return runStreaming(pm, args, dir, `${label}: install dependencies`)
}

let _cmakePath
function resolveCmake() {
  if (_cmakePath) return _cmakePath
  const cp = require('child_process')
  const ok = p => { try { return p && fs.existsSync(p) ? p : null } catch { return null } }
  let found = ok(process.env.SKYRP_CMAKE)
  if (!found) {
    try {
      const out = cp.execSync(isWin ? 'where cmake' : 'which cmake', { encoding: 'utf8' })
      found = ok(out.split(/\r?\n/)[0].trim())
    } catch {}
  }
  if (!found && isWin) {
    const cands = ['C:\\Program Files\\CMake\\bin\\cmake.exe', 'C:\\Program Files (x86)\\CMake\\bin\\cmake.exe']
    try {
      const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
      if (fs.existsSync(vswhere)) {
        const vs = cp.execSync(`"${vswhere}" -latest -products * -property installationPath`, { encoding: 'utf8' }).trim()
        if (vs) cands.push(path.join(vs, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'))
      }
    } catch {}
    for (const c of cands) { if (ok(c)) { found = c; break } }
  }
  if (found) _cmakePath = found
  return found
}

// Compiler, requires VS 2022
async function buildNative(targets, label) {
  if (process.env.SKYRP_SKIP_NATIVE === '1') {
    send('build:log', `\n[${label}] SKYRP_SKIP_NATIVE=1 — skipping native build.\n`)
    return { ok: true, skipped: true }
  }
  const cmake = resolveCmake()
  if (!cmake) {
    send('build:log', `\n[${label}] cmake not found. Install CMake (or Visual Studio / Build Tools with the "C++ CMake tools" component), or set SKYRP_CMAKE to the full path of cmake.exe.\n`)
    return { ok: false, error: 'cmake not found — install it or set SKYRP_CMAKE (see log)' }
  }
  send('build:log', `\n[${label}] cmake: ${cmake}\n`)
  const buildDir = config.buildDir
  const generator = process.env.SKYRP_CMAKE_GENERATOR || 'Visual Studio 17 2022'

  // Reset just the CMake cache, not /dist
  try {
    const cache = path.join(buildDir, 'CMakeCache.txt')
    if (fs.existsSync(cache)) {
      const m = fs.readFileSync(cache, 'utf8').match(/^CMAKE_GENERATOR:INTERNAL=(.*)$/m)
      if (m && m[1].trim() !== generator) {
        send('build:log', `\n[${label}] build dir was generated with "${m[1].trim()}"; resetting CMake cache for "${generator}".\n`)
        fs.rmSync(cache, { force: true })
        fs.rmSync(path.join(buildDir, 'CMakeFiles'), { recursive: true, force: true })
      }
    }
  } catch {}

  // Configure unless the build system is fully GENERATED.
  let generated = false
  try {
    generated = fs.existsSync(path.join(buildDir, 'build.ninja')) ||
      (fs.existsSync(buildDir) && fs.readdirSync(buildDir).some(f => f.toLowerCase().endsWith('.sln')))
  } catch {}
  if (!generated) {
    const extra = (process.env.SKYRP_CMAKE_CONFIGURE_ARGS || '').trim()
    const cfgArgs = [
      '-B', buildDir,
      '-G', generator,
      ...(/visual studio/i.test(generator) ? ['-A', 'x64'] : []),
      '-DSWEETPIE=OFF',
      `-DSKYRIM_DIR=${config.gameRoot}`,
      '-DBUILD_FRONT=OFF',
      '-DDOWNLOAD_SKYRIM_DATA=OFF',
      '-DPREPARE_NEXUS_ARCHIVES=OFF',
      ...(extra ? extra.split(' ').filter(Boolean) : []),
    ]
    const cfg = await runStreaming(cmake, cfgArgs, config.repoRoot, `${label}: cmake configure`, undefined, false)
    if (!cfg.ok) {
      return { ok: false, error: `cmake configure failed — needs the "${generator}" toolchain (install the VS 2022 Build Tools "Desktop development with C++" workload) and a bootstrapped vcpkg; or set SKYRP_CMAKE_GENERATOR / SKYRP_SKIP_NATIVE=1 (see log)` }

    }
  }
  const args = ['--build', buildDir, '--config', 'Release']
  for (const t of targets) args.push('--target', t)
  const r = await runStreaming(cmake, args, config.repoRoot, `${label}: cmake build (${targets.join(', ')})`, undefined, false)
  return r.ok ? { ok: true } : { ok: false, error: `native build failed (${targets.join(', ')}) — see log` }
}

// ── Services (Console tab) ──────────────────────────────────────────────────────

ipcMain.handle('services:status', async () => {
  const out = {}
  for (const s of config.services) out[s] = await nssm('status', s)
  return out
})

ipcMain.handle('services:action', async (_e, action) => {
  const steps = []
  const doStop  = async () => { for (const s of [...config.services].reverse()) steps.push(`${s}: ${await nssm('stop', s)}`) }
  const doStart = async () => { for (const s of config.services)               steps.push(`${s}: ${await nssm('start', s)}`) }

  if (action === 'stop') await doStop()
  else if (action === 'start') await doStart()
  else if (action === 'restart') { await doStop(); await new Promise(r => setTimeout(r, 2000)); await doStart() }
  else return { ok: false, error: `unknown action ${action}` }

  const status = {}
  for (const s of config.services) status[s] = await nssm('status', s)
  return { ok: true, steps, status }
})

// Rebuild the game server: the TS bundle (dist_back/skymp5-server.js) and the
// native addon (scam_native.node), both into build/dist/server. Does NOT restart
// the service — start/stop is the Console tab's job.
ipcMain.handle('server:rebuild', async () => {
  const dir = config.paths.server
  const dep = await ensureDeps(dir, 'npm', 'game server')
  if (!dep.ok) return { ok: false, error: 'dependency install failed' }

  // TS bundle — safe to overwrite even while the server runs (read at startup).
  const r = await runStreaming('npm', ['run', 'build-ts'], dir, 'game server: build-ts')
  if (!r.ok) return { ok: false, error: 'build-ts failed — see log (TypeScript errors stop the build)' }

  // Native addon (scam_native.node) -> build/dist/server. The file is locked
  // while SkyrpGameServer runs, so only (re)build it when the service is stopped.
  const status = await nssm('status', 'SkyrpGameServer')
  if (/SERVICE_RUNNING/i.test(status)) {
    send('build:log', '\n[server native] SkyrpGameServer is running — skipped scam_native.node (file is locked). Stop it from the Console tab, then rebuild to update the native addon.\n')
  } else {
    const n = await buildNative(['skymp5-server'], 'server native')
    if (!n.ok) return n
  }
  return { ok: true }
})

// ── Settings tab: edit server-settings.json and the backend .env ────────────────

const CONFIG_FILES = { serverSettings: config.paths.serverSettings, backendEnv: config.paths.backendEnv }

ipcMain.handle('config:read', (_e, key) => {
  const file = CONFIG_FILES[key]
  if (!file) return { ok: false, error: 'unknown config' }
  try { return { ok: true, path: file, content: fs.readFileSync(file, 'utf8') } }
  catch (err) { return { ok: false, path: file, error: err.message } }
})

ipcMain.handle('config:write', (_e, key, content) => {
  const file = CONFIG_FILES[key]
  if (!file) return { ok: false, error: 'unknown config' }
  // Don't let a typo brick the game server — validate JSON before saving it.
  if (key === 'serverSettings') {
    try { JSON.parse(content) } catch (err) { return { ok: false, error: `Invalid JSON: ${err.message}` } }
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return { ok: true, path: file } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Log tailing (Console tab) ───────────────────────────────────────────────────
// Follow nssm's per-service log files, emitting only newly-appended bytes.

const tailState = {}   // file -> last byte offset

function logFiles() {
  return ['gameserver.log', 'gameserver-err.log', 'backend.log', 'backend-err.log']
    .map(n => path.join(config.logDir, n))
}

function pollLogs() {
  for (const file of logFiles()) {
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    const prev = tailState[file]
    if (prev === undefined) {
      // First sight: seed from the tail so we don't dump the whole history.
      tailState[file] = Math.max(0, stat.size - 8192)
    }
    if (stat.size < tailState[file]) tailState[file] = 0   // rotated/truncated
    if (stat.size > tailState[file]) {
      try {
        const fd = fs.openSync(file, 'r')
        const len = stat.size - tailState[file]
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, tailState[file])
        fs.closeSync(fd)
        tailState[file] = stat.size
        send('log:data', { file: path.basename(file), text: buf.toString('utf8') })
      } catch { /* mid-write race — retry next tick */ }
    }
  }
}

function startLogTail() { setInterval(pollLogs, 1500) }

ipcMain.handle('log:dir', () => config.logDir)

// ── Console command over the WS relay ───────────────────────────────────────────

ipcMain.handle('console:command', async (_e, text) => {
  const cmd = String(text || '').trim()
  if (!cmd) return { ok: false, error: 'empty command' }
  return new Promise(resolve => {
    let settled = false
    const finish = r => { if (!settled) { settled = true; try { ws.close() } catch {} resolve(r) } }
    const ws = new WebSocket(`ws://127.0.0.1:${config.relay.port}`)
    const timer = setTimeout(() => finish({ ok: false, error: 'relay timeout — is the backend running?' }), 5000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', role: 'console', secret: config.relay.secret }))
      ws.send(JSON.stringify({ type: 'console_command', text: cmd }))
      clearTimeout(timer)
      finish({ ok: true })
    })
    ws.on('error', err => { clearTimeout(timer); finish({ ok: false, error: err.message }) })
  })
})

// ── Version file editing helpers ────────────────────────────────────────────────

function setJsonVersion(file, version) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  json.version = version
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
}

// Replace LATEST_VERSION = '...' inside routes/version.js.
function setRouteVersion(file, version) {
  const src = fs.readFileSync(file, 'utf8')
  const next = src.replace(/(const\s+LATEST_VERSION\s*=\s*)['"][^'"]*['"]/, `$1'${version}'`)
  if (next === src) throw new Error('LATEST_VERSION not found in version.js')
  fs.writeFileSync(file, next)
}

// Upsert KEY=value in a .env file, creating the key if missing.
function setEnvVar(file, key, value) {
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch {}
  const line = `${key}=${value}`
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  if (re.test(txt)) txt = txt.replace(re, line)
  else txt = txt.replace(/\s*$/, '') + `\n${line}\n`
  fs.writeFileSync(file, txt)
}

// ── Launcher tab ────────────────────────────────────────────────────────────────

ipcMain.handle('launcher:getVersion', () => {
  try { return { version: require(config.paths.launcherPkg).version } }
  catch (err) { return { version: '', error: err.message } }
})

ipcMain.handle('launcher:setVersion', (_e, version) => {
  version = String(version || '').trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, error: 'Use a semver like 1.2.3' }
  try {
    setJsonVersion(config.paths.launcherPkg, version)       // actual build version
    setRouteVersion(config.paths.versionRoute, version)     // version the backend reports
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('launcher:rebuild', async () => {
  const dir = config.paths.launcher
  // Wipe the previous output so stale installers never linger.
  try { fs.rmSync(config.paths.launcherOut, { recursive: true, force: true }) } catch {}

  const install = await runStreaming('npm', ['install'], dir, 'launcher: npm install')
  if (!install.ok) return { ok: false, error: 'npm install failed' }

  // CSC_IDENTITY_AUTO_DISCOVERY=false stops an expired code-signing cert in the
  // Windows store from aborting the build. artifactName forces the output name.
  const build = await runStreaming(
    'npx',
    ['electron-builder', '--win', '-c.nsis.artifactName=' + config.launcherArtifact],
    dir, 'launcher: electron-builder --win',
    { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  if (!build.ok) return { ok: false, error: 'electron-builder failed' }

  // Fallback rename in case the artifactName override is ignored by an older builder.
  try {
    const exe = fs.readdirSync(config.paths.launcherOut).find(f => f.toLowerCase().endsWith('.exe'))
    if (exe && exe !== config.launcherArtifact) {
      fs.renameSync(path.join(config.paths.launcherOut, exe), path.join(config.paths.launcherOut, config.launcherArtifact))
    }
  } catch {}
  return { ok: true, out: config.paths.launcherOut }
})

// ── Client tab ──────────────────────────────────────────────────────────────────

ipcMain.handle('client:getVersion', () => {
  try { return { version: require(config.paths.clientPkg).version } }
  catch (err) { return { version: '', error: err.message } }
})

ipcMain.handle('client:setVersion', (_e, version) => {
  version = String(version || '').trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, error: 'Use a semver like 1.2.3' }
  try {
    setJsonVersion(config.paths.clientPkg, version)               // client package.json
    setEnvVar(config.paths.backendEnv, 'CLIENT_VERSION', version) // backend .env -> files-version.json
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('client:update', async () => {
  const pm = yarnOrNpm()
  const buildArgs = pm === 'yarn' ? ['build'] : ['run', 'build']
  const build = pm === 'yarn' ? ['build'] : ['run', 'build']

  fs.writeFileSync(config.paths.frontConfig,
    "module.exports = {\n  outputPath: '../build/dist/client/Data/Platform/UI',\n};\n")

  const steps = [
    { label: 'client logic (skymp5-client.js)',        dir: config.paths.client,  pm, args: build },
    { label: 'front-end UI',                            dir: config.paths.front,   pm, args: build },
    { label: 'native DLLs (SkyrimPlatform/MpClientPlugin/CEF)', native: ['skyrim-platform'] },
    { label: 'package /dist for redistribution',        dir: config.paths.backend, pm: 'npm', args: ['run', 'build-client'] },
  ]

  for (const s of steps) {
    send('build:log', `\n==================== ${s.label} ====================\n`)
    if (s.native) {
      const r = await buildNative(s.native, s.label)
      if (!r.ok) return { ok: false, error: `${s.label}: ${r.error}` }
      continue
    }
    const dep = await ensureDeps(s.dir, s.pm, s.label)
    if (!dep.ok) return { ok: false, error: `${s.label}: dependency install failed — see log` }
    const r = await runStreaming(s.pm, s.args, s.dir, `${s.label}: build`)
    if (!r.ok) return { ok: false, error: `${s.label}: build failed — see log` }
  }

  send('build:log', '\n✓ Client rebuilt and packaged into build/dist for redistribution.\n')

  return { ok: true }
})

// ── Modlist tab ─────────────────────────────────────────────────────────────────

ipcMain.handle('modlist:read', () => {
  const profileDir = path.join(config.mo2Root, 'profiles', config.profile)
  const readLines = (f) => {
    try { return fs.readFileSync(path.join(profileDir, f), 'utf8').split(/\r?\n/) }
    catch { return null }
  }
  const modlist = readLines('modlist.txt')
  const plugins = readLines('plugins.txt')
  if (!modlist) return { ok: false, error: `No modlist.txt under ${profileDir}. Check SKYRP_MO2_ROOT / profile.` }

  const mods = [], separators = []
  for (const line of modlist) {
    const name = line.slice(1).trim()
    if (!name) continue
    if (name.endsWith('_separator')) {
      if (line[0] === '+' || line[0] === '-') separators.push(name.replace(/_separator$/, ''))
    } else if (line[0] === '+') {
      mods.push(name)
    }
  }
  const pluginList = (plugins || []).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  return { ok: true, profileDir, mods, separators, plugins: pluginList }
})

ipcMain.handle('modlist:updateManifest', async () => {
  const dep = await ensureDeps(config.paths.backend, 'npm', 'backend')   // compile-manifest needs 7zip-bin
  if (!dep.ok) return { ok: false, error: 'backend dependency install failed' }
  const args = ['scripts/compile-manifest.js', '--mo2', config.mo2Root, '--profile', config.profile]
  if (fs.existsSync(path.join(config.gameRoot, 'SkyrimSE.exe'))) args.push('--game', config.gameRoot)
  const r = await runStreaming('node', args, config.paths.backend, 'compile-manifest')
  return r.ok ? { ok: true } : { ok: false, error: 'compile-manifest failed' }
})

// ── Players (Client tab list + popup) ───────────────────────────────────────────
// Read the backend's source modules directly so the data matches the live API.

function backendModule(name) {
  return require(path.join(config.paths.backend, 'sources', name))
}

ipcMain.handle('players:list', () => {
  try {
    const players = backendModule('players.js').list()
    let whitelist = []
    try { whitelist = JSON.parse(fs.readFileSync(path.join(config.paths.dataDir, 'whitelist.json'), 'utf8')) } catch {}
    const wl = new Set((Array.isArray(whitelist) ? whitelist : []).map(String))
    return {
      ok: true,
      players: players.map(p => ({
        discordId: p.discordId, profileId: p.profileId,
        name: p.displayName || p.username || `Player ${p.profileId}`,
        whitelisted: wl.has(String(p.discordId)),
      })),
    }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('players:detail', (_e, discordId) => {
  try {
    const players = backendModule('players.js').list()
    const p = players.find(x => String(x.discordId) === String(discordId))
    if (!p) return { ok: false, error: 'player not found' }
    return {
      ok: true,
      discord: {
        discordId: p.discordId, username: p.username, displayName: p.displayName,
        avatar: p.avatar, profileId: p.profileId, notes: p.notes,
        createdAt: p.createdAt, lastSeenAt: p.lastSeenAt,
      },
      factions: p.assignments || [],
      permissions: p.factionPermissions || [],
      // Characters live in the game-server save store (C++); not available here yet.
      characters: [],
    }
  } catch (err) { return { ok: false, error: err.message } }
})
