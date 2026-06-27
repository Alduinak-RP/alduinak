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

  // Path to an installed Visual Studio 2022 (v17) with the C++ x64 toolset, or
  // null. We check that the compiler dir (VC/Tools/MSVC) actually exists on disk
  // rather than trusting vswhere's component query, which can false-negative.
  vs2022Path() {
    if (!isWin) return null
    // 1) vswhere as JSON — find a v17 instance whose C++ compiler dir is present.
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    if (fs.existsSync(vswhere)) {
      try {
        const out = cp.execSync(`"${vswhere}" -products * -prerelease -format json -utf8`, { encoding: 'utf8', windowsHide: true })
        for (const inst of JSON.parse(out)) {
          const major = parseInt(String(inst.installationVersion || '').split('.')[0], 10)
          const p = inst.installationPath
          if (major === 17 && p && fs.existsSync(path.join(p, 'VC', 'Tools', 'MSVC'))) return p
        }
      } catch {}
    }
    // 2) Fallback: well-known VS 2022 install locations (in case vswhere is stale).
    for (const base of ['C:\\Program Files\\Microsoft Visual Studio\\2022', 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022']) {
      for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
        const p = path.join(base, edition)
        if (fs.existsSync(path.join(p, 'VC', 'Tools', 'MSVC'))) return p
      }
    }
    return null
  }

  // Human-readable list of installed VS instances (for diagnostics in the log).
  vsSummary() {
    if (!isWin) return '(not Windows)'
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    if (!fs.existsSync(vswhere)) return '  vswhere.exe not found'
    try {
      const arr = JSON.parse(cp.execSync(`"${vswhere}" -products * -prerelease -format json -utf8`, { encoding: 'utf8', windowsHide: true }))
      if (!arr.length) return '  no Visual Studio instances found'
      return arr.map(i => {
        const cpp = i.installationPath && fs.existsSync(path.join(i.installationPath, 'VC', 'Tools', 'MSVC')) ? 'C++ present' : 'C++ MISSING'
        return `  - ${i.displayName || 'VS'} ${i.installationVersion} @ ${i.installationPath} (${cpp})`
      }).join('\n')
    } catch (e) { return '  vswhere query failed: ' + e.message }
  }

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

  wingetInstall(id, label, override, force) {
    // `--silent` runs the installer unattended. `--force` re-runs even if winget
    // thinks the package is present, so the VS `--override` (which adds the C++
    // workload) actually applies when a VS Build Tools shell already exists.
    const args = ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent']
    if (force) args.push('--force')
    if (override) args.push('--override', override)
    return this.run('winget', args, config.repoRoot, `install ${label}`)
  }

  // Ensure the toolchain this build needs is present
  async ensurePrereqs({ native }) {
    if (!isWin) return { ok: true }                        // auto-install is Windows-only
    if (process.env.SKYRP_NO_AUTO_INSTALL === '1') return { ok: true }

    const missing = []
    if (!this.hasCmd('node')) missing.push({ id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS', check: () => this.hasCmd('node') })
    if (!this.hasCmd('git'))  missing.push({ id: 'Git.Git',           label: 'Git',         check: () => this.hasCmd('git') })
    if (native) {
      if (!this.resolveCmake()) missing.push({ id: 'Kitware.CMake', label: 'CMake', check: () => { this._cmake = undefined; return !!this.resolveCmake() } })
      // Pin to VS 2022 (v143) — the CI-tested toolchain. If the user forces a
      // different generator via SKYRP_CMAKE_GENERATOR, accept any VS C++ toolset.
      const forcedGen = !!process.env.SKYRP_CMAKE_GENERATOR
      const haveToolset = () => forcedGen ? this.hasMsvcCpp() : !!this.vs2022Path()
      if (!haveToolset()) missing.push({
        id: 'Microsoft.VisualStudio.2022.BuildTools',
        label: forcedGen ? 'MSVC C++ Build Tools' : 'Visual Studio 2022 C++ Build Tools',
        override: '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
        force: true,   // re-run even if a VS Build Tools shell exists, so the C++ workload is added
        check: haveToolset,
      })
    }
    if (missing.length) {
      this.banner('Installing missing prerequisites')
      if (!this.hasCmd('winget')) {
        return { ok: false, error: `missing ${missing.map(m => m.label).join(', ')} and winget is unavailable to auto-install — install the App Installer (winget), or get them manually: Node https://nodejs.org/ , CMake https://cmake.org/download/ , VS 2022 Build Tools ("Desktop development with C++") https://aka.ms/vs/17/release/vs_BuildTools.exe . Then re-run (or set SKYRP_NO_AUTO_INSTALL=1).` }
      }
      this.line(`[prereqs] missing: ${missing.map(m => m.label).join(', ')} — installing with winget (MSVC Build Tools is several GB; this can take a while)…`)
      for (const m of missing) {
        await this.wingetInstall(m.id, m.label, m.override, m.force)
        this.refreshPath()
      }
      const still = missing.filter(m => !m.check())
      if (still.length) {
        if (still.some(m => /Visual Studio|MSVC/i.test(m.label))) {
          this.line('[prereqs] Visual Studio instances detected after install:\n' + this.vsSummary())
        }
        return { ok: false, error: `still missing after install: ${still.map(m => m.label).join(', ')}. Check the winget output and the VS list above. VS installs commonly fail on a PENDING REBOOT — reboot and Build again; or install "VS 2022 Build Tools" with the "Desktop development with C++" workload manually (https://aka.ms/vs/17/release/vs_BuildTools.exe).` }
      }
      this.line('[prereqs] toolchain installed.')
    }

    if (native) {
      const y = await this.ensureYarn()
      if (!y.ok) return y
    }
    return { ok: true }
  }

  async ensureYarn() {
    if (this.hasCmd('yarn')) return { ok: true }
    if (!this.hasCmd('npm')) return { ok: false, error: 'yarn is required for native builds and npm is unavailable to install it — install Node.js, then yarn, and retry.' }
    this.line('[prereqs] yarn not found — installing yarn (classic) with npm (cmake/yarn.cmake needs it)…')
    await this.run('npm', ['install', '-g', 'yarn'], config.repoRoot, 'npm install -g yarn')
    this.refreshPath()
    // The npm global bin dir may not be on the registry PATH yet — add it.
    try {
      const prefix = cp.execSync('npm config get prefix', { encoding: 'utf8', windowsHide: true }).trim()
      if (prefix && !(process.env.PATH || '').toLowerCase().includes(prefix.toLowerCase())) {
        process.env.PATH = `${prefix};${process.env.PATH || ''}`
      }
    } catch {}
    if (this.hasCmd('yarn')) { this.line('[prereqs] yarn installed.'); return { ok: true } }
    if (this.hasCmd('corepack')) {
      await this.run('corepack', ['enable'], config.repoRoot, 'corepack enable')
      this.refreshPath()
      if (this.hasCmd('yarn')) { this.line('[prereqs] yarn enabled via corepack.'); return { ok: true } }
    }
    return { ok: false, error: 'yarn is required for native builds but could not be installed — run `npm install -g yarn` in an elevated shell and retry (a manager restart may be needed for PATH).' }
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

  resolveGenerator(cmake) {
    if (process.env.SKYRP_CMAKE_GENERATOR) return process.env.SKYRP_CMAKE_GENERATOR
    // Prefer VS 2022 (v143)
    if (this.vs2022Path()) return 'Visual Studio 17 2022'
    // Otherwise fall back to CMake's default (newest installed VS) and warn.
    try {
      const help = cp.execSync(`"${cmake}" --help`, { encoding: 'utf8', windowsHide: true })
      let firstVs = null
      for (const raw of help.split(/\r?\n/)) {
        const m = raw.match(/(Visual Studio \d+ \d{4})/)
        if (!m) continue
        if (!firstVs) firstVs = m[1]
        if (raw.trimStart().startsWith('*')) {
          this.line(`[generator] warning: VS 2022 not found; using "${m[1]}". The client is tested with VS 2022 — install it (or set SKYRP_CMAKE_GENERATOR) if the build misbehaves.`)
          return m[1]
        }
      }
      if (firstVs) return firstVs
    } catch {}
    return 'Visual Studio 17 2022'
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
    const generator = this.resolveGenerator(cmake)
    this.line(`[${label}] generator: ${generator}`)

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
        return { ok: false, error: `cmake configure failed — needs a Visual Studio C++ toolchain matching "${generator}" ("Desktop development with C++") and a bootstrapped vcpkg; or set SKYRP_CMAKE_GENERATOR / SKYRP_SKIP_NATIVE=1 (see log)` }
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

  // Purges dist except for settings and world
  pruneServerDeploy() {
    const deployDir = path.join(config.buildDir, 'dist', 'server')
    const keep = new Set(['world', 'server-settings.json', 'gamemode.js', 'dist_back', 'scam_native.node'])
    for (const extra of (process.env.SKYRP_SERVER_KEEP || '').split(',')) {
      const n = extra.trim(); if (n) keep.add(n)
    }
    let entries
    try { entries = fs.readdirSync(deployDir) } catch { return }
    for (const name of entries) {
      if (keep.has(name) || keep.has(name.toLowerCase())) continue
      try {
        fs.rmSync(path.join(deployDir, name), { recursive: true, force: true })
        this.line(`[deploy] removed stale ${name}`)
      } catch (err) { this.line(`[deploy] could not remove ${name}: ${err.message}`) }
    }
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
      this.pruneServerDeploy()
      return { ok: true, nativeSkipped: true }
    }
    const n = await this.buildNative(['skymp5-server'], 'server native')
    if (!n.ok) return n
    this.pruneServerDeploy()
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
