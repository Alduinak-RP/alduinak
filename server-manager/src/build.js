'use strict'

const fs   = require('fs')
const path = require('path')
const cp   = require('child_process')
const { spawn } = require('child_process')
const config = require('./config')

const isWin = process.platform === 'win32'

class Builder {
  constructor(log) {
    this.log = log || (() => {})
    this._cmake = undefined
  }

  line(text) { this.log(text.endsWith('\n') ? text : text + '\n') }
  banner(text) { this.log(`\n==================== ${text} ====================\n`) }

  // Run a command, streaming combined stdout/stderr to the build console.
  run(cmd, args, cwd, label, env, shell = isWin) {
    return new Promise(resolve => {
      this.log(`\n$ ${label || [cmd, ...args].join(' ')}\n`)
      let child
      try {
        child = spawn(cmd, args, {
          cwd, shell, windowsHide: true,
          env: { ...process.env, ...(env || {}) },
        })
      } catch (err) {
        this.line(`[spawn failed] ${err.message}`)
        return resolve({ ok: false, code: -1 })
      }
      child.stdout.on('data', d => this.log(d.toString()))
      child.stderr.on('data', d => this.log(d.toString()))
      child.on('error', err => { this.line(`[error] ${err.message}`); resolve({ ok: false, code: -1 }) })
      child.on('close', code => { this.line(`[exit ${code}]`); resolve({ ok: code === 0, code }) })
    })
  }

  // Prefer yarn when it's on PATH (the repo's build scripts assume it), else npm.
  packageManager() {
    try { cp.execSync(isWin ? 'where yarn' : 'which yarn', { stdio: 'ignore' }); return 'yarn' }
    catch { return 'npm' }
  }

  // Install a project's dependencies when node_modules is missing
  async ensureDeps(dir, label, pm = this.packageManager()) {
    if (!fs.existsSync(dir)) return { ok: false, error: `${label}: directory not found (${dir})` }
    if (fs.existsSync(path.join(dir, 'node_modules'))) return { ok: true }
    this.line(`[${label}] installing dependencies (node_modules missing)…`)
    const args = pm === 'yarn' ? ['install', '--frozen-lockfile'] : ['install', '--legacy-peer-deps']
    const r = await this.run(pm, args, dir, `${label}: ${pm} install`)
    // yarn --frozen-lockfile fails on a stale/absent lockfile; retry permissively.
    if (!r.ok && pm === 'yarn') {
      this.line(`[${label}] frozen install failed — retrying without --frozen-lockfile…`)
      const r2 = await this.run(pm, ['install'], dir, `${label}: yarn install`)
      return r2.ok ? { ok: true } : { ok: false, error: `${label}: dependency install failed` }
    }
    return r.ok ? { ok: true } : { ok: false, error: `${label}: dependency install failed` }
  }

  hasCmd(cmd) {
    try { cp.execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' }); return true }
    catch { return false }
  }

  // Are the MSVC C++ build tools (x64) installed? vswhere reports the component.
  hasMsvcCpp() {
    if (!isWin) return true
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    if (!fs.existsSync(vswhere)) return false
    try {
      const out = cp.execSync(
        `"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
        { encoding: 'utf8' }).trim()
      return !!out
    } catch { return false }
  }

  // Rebuild process.env.PATH from the machine+user registry PATH (plus common
  // install dirs) so tools installed during this run are visible to the child
  // processes we spawn — without needing a manager restart.
  refreshPath() {
    if (!isWin) return
    try {
      const ps = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
      const out = cp.execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim()
      if (out) process.env.PATH = out
    } catch {}
    for (const d of ['C:\\Program Files\\nodejs', 'C:\\Program Files\\CMake\\bin', 'C:\\Program Files\\Git\\cmd']) {
      if (fs.existsSync(d) && !(process.env.PATH || '').toLowerCase().includes(d.toLowerCase())) {
        process.env.PATH = `${d};${process.env.PATH || ''}`
      }
    }
    this._cmake = undefined   // re-resolve cmake against the refreshed PATH
  }

  wingetInstall(id, label, override) {
    // `--silent` runs the installer unattended; success is verified afterwards by
    // re-detection, so we don't gate on winget's exit code (it returns non-zero
    // for benign cases like "reboot required").
    const args = ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent']
    if (override) args.push('--override', override)
    return this.run('winget', args, config.repoRoot, `install ${label}`)
  }

  // Ensure the toolchain this build needs is present, installing what's missing
  // with winget. Returns { ok } and never throws.
  async ensurePrereqs({ native }) {
    if (!isWin) return { ok: true }                        // auto-install is Windows-only
    if (process.env.SKYRP_NO_AUTO_INSTALL === '1') return { ok: true }

    const missing = []
    if (!this.hasCmd('node')) missing.push({ id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS', check: () => this.hasCmd('node') })
    if (!this.hasCmd('git'))  missing.push({ id: 'Git.Git',           label: 'Git',         check: () => this.hasCmd('git') })
    if (native) {
      if (!this.resolveCmake()) missing.push({ id: 'Kitware.CMake', label: 'CMake', check: () => { this._cmake = undefined; return !!this.resolveCmake() } })
      if (!this.hasMsvcCpp())   missing.push({
        id: 'Microsoft.VisualStudio.2022.BuildTools', label: 'MSVC C++ Build Tools',
        override: '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
        check: () => this.hasMsvcCpp(),
      })
    }
    if (missing.length === 0) return { ok: true }

    this.banner('Installing missing prerequisites')
    if (!this.hasCmd('winget')) {
      return { ok: false, error: `missing ${missing.map(m => m.label).join(', ')} and winget is unavailable to auto-install — install the App Installer (winget), or get them manually: Node https://nodejs.org/ , CMake https://cmake.org/download/ , VS 2022 Build Tools ("Desktop development with C++") https://aka.ms/vs/17/release/vs_BuildTools.exe . Then re-run (or set SKYRP_NO_AUTO_INSTALL=1).` }
    }
    this.line(`[prereqs] missing: ${missing.map(m => m.label).join(', ')} — installing with winget (MSVC Build Tools is several GB; this can take a while)…`)
    for (const m of missing) {
      await this.wingetInstall(m.id, m.label, m.override)
      this.refreshPath()
    }
    const still = missing.filter(m => !m.check())
    if (still.length) {
      return { ok: false, error: `still missing after install: ${still.map(m => m.label).join(', ')} — a manager restart (or reboot) may be needed for PATH/registration to take effect. See log.` }
    }
    this.line('[prereqs] all prerequisites present.')
    return { ok: true }
  }

  resolveCmake() {
    if (this._cmake !== undefined) return this._cmake
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
    this._cmake = found || null
    return this._cmake
  }

  // Bootstrap the bundled vcpkg submodule if it hasn't been built yet.
  async ensureVcpkg() {
    const dir = config.vcpkgDir
    const exe = path.join(dir, isWin ? 'vcpkg.exe' : 'vcpkg')
    if (fs.existsSync(exe)) return { ok: true }
    if (!fs.existsSync(path.join(dir, 'bootstrap-vcpkg.bat')) && !fs.existsSync(path.join(dir, 'bootstrap-vcpkg.sh'))) {
      // vcpkg is a git submodule — fetch it if the working tree is empty.
      this.line('[vcpkg] submodule not initialised — running git submodule update…')
      const g = await this.run('git', ['submodule', 'update', '--init', '--recursive', 'vcpkg'], config.repoRoot, 'vcpkg: git submodule update')
      if (!g.ok) return { ok: false, error: 'vcpkg is missing and `git submodule update --init vcpkg` failed — see log' }
    }
    this.line('[vcpkg] bootstrapping (first run only)…')
    const script = isWin ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh'
    const r = await this.run(path.join(dir, script), ['-disableMetrics'], dir, 'vcpkg: bootstrap')
    return r.ok ? { ok: true } : { ok: false, error: 'vcpkg bootstrap failed — see log' }
  }

  // Configure (once) + build one or more CMake targets in Release.
  async buildNative(targets, label) {
    if (process.env.SKYRP_SKIP_NATIVE === '1') {
      this.line(`[${label}] SKYRP_SKIP_NATIVE=1 — skipping native build.`)
      return { ok: true, skipped: true }
    }
    const cmake = this.resolveCmake()
    if (!cmake) {
      return { ok: false, error: 'CMake not found — install CMake (or the VS 2022 "C++ CMake tools" component), or set SKYRP_CMAKE to cmake.exe' }
    }
    this.line(`[${label}] cmake: ${cmake}`)

    const vc = await this.ensureVcpkg()
    if (!vc.ok) return vc

    const buildDir  = config.buildDir
    const generator = process.env.SKYRP_CMAKE_GENERATOR || 'Visual Studio 17 2022'

    // If the cache was generated with a different generator, reset just the cache.
    try {
      const cache = path.join(buildDir, 'CMakeCache.txt')
      if (fs.existsSync(cache)) {
        const m = fs.readFileSync(cache, 'utf8').match(/^CMAKE_GENERATOR:INTERNAL=(.*)$/m)
        if (m && m[1].trim() !== generator) {
          this.line(`[${label}] build dir was generated with "${m[1].trim()}"; resetting CMake cache for "${generator}".`)
          fs.rmSync(cache, { force: true })
          fs.rmSync(path.join(buildDir, 'CMakeFiles'), { recursive: true, force: true })
        }
      }
    } catch {}

    // Configure unless the build system is already generated.
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
      this.line(`[${label}] configuring CMake (first run pulls vcpkg deps — this can take a while)…`)
      const cfg = await this.run(cmake, cfgArgs, config.repoRoot, `${label}: cmake configure`, undefined, false)
      if (!cfg.ok) {
        return { ok: false, error: `cmake configure failed — needs the "${generator}" toolchain (VS 2022 Build Tools, "Desktop development with C++") and a bootstrapped vcpkg; or set SKYRP_CMAKE_GENERATOR / SKYRP_SKIP_NATIVE=1 (see log)` }
      }
    }

    const args = ['--build', buildDir, '--config', 'Release']
    for (const t of targets) args.push('--target', t)
    const r = await this.run(cmake, args, config.repoRoot, `${label}: cmake build (${targets.join(', ')})`, undefined, false)
    return r.ok ? { ok: true } : { ok: false, error: `native build failed (${targets.join(', ')}) — see log` }
  }

  // Is the game-server service running? (Its scam_native.node is locked while up.)
  gameServerRunning() {
    try {
      const out = cp.execFileSync(config.nssm, ['status', 'SkyrpGameServer'], { windowsHide: true, timeout: 15000 })
      return /SERVICE_RUNNING/i.test(String(out).replace(/\u0000/g, ''))
    } catch { return false }
  }

  // GAME SERVER: TS bundle (dist_back/skymp5-server.js) + native scam_native.node,
  // both into build/dist/server. Does not restart the service.
  async buildServer() {
    this.banner('Game server')
    // Native runs unless skipped or the service is up (its .node is locked).
    const willBuildNative = process.env.SKYRP_SKIP_NATIVE !== '1' && !this.gameServerRunning()
    const pre = await this.ensurePrereqs({ native: willBuildNative })
    if (!pre.ok) return pre
    const dir = config.paths.server
    const dep = await this.ensureDeps(dir, 'game server')
    if (!dep.ok) return dep

    // TS bundle — safe to overwrite even while the server runs (read at startup).
    const pm = this.packageManager()
    const r = await this.run(pm, pm === 'yarn' ? ['build-ts'] : ['run', 'build-ts'], dir, 'game server: build-ts')
    if (!r.ok) return { ok: false, error: 'build-ts failed — TypeScript errors stop the build (see log)' }

    // Native addon — the .node file is locked while SkyrpGameServer runs.
    if (this.gameServerRunning()) {
      this.line('\n[server native] SkyrpGameServer is running — skipped scam_native.node (file is locked). Stop it from the Console tab, then rebuild to update the native addon.')
      return { ok: true, nativeSkipped: true }
    }
    const n = await this.buildNative(['skymp5-server'], 'server native')
    if (!n.ok) return n
    this.line('\n✓ Game server built into build/dist/server (TS bundle + scam_native.node).')
    return { ok: true }
  }

  // LAUNCHER: the Electron installer. Wipes the old output, installs deps, builds.
  async buildLauncher() {
    this.banner('Launcher')
    const pre = await this.ensurePrereqs({ native: false })   // launcher is JS-only
    if (!pre.ok) return pre
    const dir = config.paths.launcher
    try { fs.rmSync(config.paths.launcherOut, { recursive: true, force: true }) } catch {}

    const dep = await this.ensureDeps(dir, 'launcher', 'npm')
    if (!dep.ok) return dep

    // CSC_IDENTITY_AUTO_DISCOVERY=false stops an expired code-signing cert in the
    // Windows store from aborting the build. artifactName forces the output name.
    const build = await this.run(
      'npx',
      ['electron-builder', '--win', '-c.nsis.artifactName=' + config.launcherArtifact],
      dir, 'launcher: electron-builder --win',
      { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    if (!build.ok) return { ok: false, error: 'electron-builder failed — see log' }

    // Fallback rename in case an older builder ignores the artifactName override.
    try {
      const exe = fs.readdirSync(config.paths.launcherOut).find(f => f.toLowerCase().endsWith('.exe'))
      if (exe && exe !== config.launcherArtifact) {
        fs.renameSync(path.join(config.paths.launcherOut, exe), path.join(config.paths.launcherOut, config.launcherArtifact))
      }
    } catch {}
    this.line(`\n✓ Launcher built → ${path.join(config.paths.launcherOut, config.launcherArtifact)}`)
    return { ok: true, out: config.paths.launcherOut }
  }

  // CLIENT: client logic → front-end UI → native SkyrimPlatform DLLs → package
  // build/dist/client for redistribution.
  async buildClient() {
    this.banner('Client')
    const pre = await this.ensurePrereqs({ native: true })    // client builds native DLLs
    if (!pre.ok) return pre
    const pm = this.packageManager()
    const buildArgs = pm === 'yarn' ? ['build'] : ['run', 'build']

    // Point the front-end build at the client distribution UI directory.
    try {
      fs.writeFileSync(config.paths.frontConfig,
        "module.exports = {\n  outputPath: '../build/dist/client/Data/Platform/UI',\n};\n")
    } catch (err) {
      this.line(`[client] warning: could not write front config: ${err.message}`)
    }

    const steps = [
      { label: 'client logic (skymp5-client.js)', dir: config.paths.client, pm, args: buildArgs },
      { label: 'front-end UI',                     dir: config.paths.front,  pm, args: buildArgs },
      { label: 'native DLLs (SkyrimPlatform / MpClientPlugin / CEF)', native: ['skyrim-platform'] },
      { label: 'package /dist for redistribution', dir: config.paths.backend, pm: 'npm', args: ['run', 'build-client'] },
    ]

    for (const s of steps) {
      this.banner(s.label)
      if (s.native) {
        const r = await this.buildNative(s.native, s.label)
        if (!r.ok) return { ok: false, error: `${s.label}: ${r.error}` }
        continue
      }
      const dep = await this.ensureDeps(s.dir, s.label, s.pm)
      if (!dep.ok) return dep
      const r = await this.run(s.pm, s.args, s.dir, `${s.label}: build`)
      if (!r.ok) return { ok: false, error: `${s.label}: build failed — see log` }
    }

    this.line('\n✓ Client rebuilt, native DLLs compiled, and packaged into build/dist/client for redistribution.')
    return { ok: true, out: config.paths.clientOut }
  }
}

module.exports = { Builder }
