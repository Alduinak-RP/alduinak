'use strict'

const fs   = require('fs')
const path = require('path')
const cp   = require('child_process')
const config = require('./config')

const isWin = process.platform === 'win32'

// Most Build buttons are pure JS/packaging: bundle TypeScript, build the launcher, zip client files.
// buildNative() compiles the C++ locally with CMake + MSVC (needs the VS 2022 C++ workload); the CI Rebuild button builds the same on GitHub.
class Builder {
  constructor(log) {
    this.log = log || (() => {})
  }

  line(text) { this.log(text.endsWith('\n') ? text : text + '\n') }
  banner(text) { this.log(`\n==================== ${text} ====================\n`) }

  // Run a command, streaming combined stdout/stderr to the build console.
  // With shell:true a spaced program path must be quoted or cmd.exe splits it; args with spaces need shell:false.
  run(cmd, args, cwd, label, env, shell = isWin) {
    if (shell && isWin && /\s/.test(cmd) && !cmd.startsWith('"')) cmd = `"${cmd}"`
    return new Promise(resolve => {
      this.log(`\n$ ${label || [cmd, ...args].join(' ')}\n`)
      let child
      try {
        child = cp.spawn(cmd, args, {
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
      this.line(`[${label}] frozen install failed - retrying without --frozen-lockfile…`)
      const r2 = await this.run(pm, ['install'], dir, `${label}: yarn install`)
      return r2.ok ? { ok: true } : { ok: false, error: `${label}: dependency install failed` }
    }
    return r.ok ? { ok: true } : { ok: false, error: `${label}: dependency install failed` }
  }

  hasCmd(cmd) {
    try { cp.execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' }); return true }
    catch { return false }
  }

  refreshPath() {
    if (!isWin) return
    try {
      const ps = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
      const out = cp.execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim()
      if (out) process.env.PATH = out
    } catch {}
    for (const d of ['C:\\Program Files\\nodejs', 'C:\\Program Files\\Git\\cmd']) {
      if (fs.existsSync(d) && !(process.env.PATH || '').toLowerCase().includes(d.toLowerCase())) {
        process.env.PATH = `${d};${process.env.PATH || ''}`
      }
    }
  }

  wingetInstall(id, label) {
    const args = ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent']
    return this.run('winget', args, config.repoRoot, `install ${label}`)
  }

  // Ensure the JS toolchain every build needs (Node.js + Git). No C++ toolchain,
  // the native binaries come prebuilt from CI.
  async ensurePrereqs() {
    if (!isWin) return { ok: true }                        // auto-install is Windows-only
    if (process.env.ALDUINAK_NO_AUTO_INSTALL === '1') return { ok: true }

    const missing = []
    if (!this.hasCmd('node')) missing.push({ id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS', check: () => this.hasCmd('node') })
    if (!this.hasCmd('git'))  missing.push({ id: 'Git.Git',           label: 'Git',         check: () => this.hasCmd('git') })
    if (!missing.length) return { ok: true }

    this.banner('Installing missing prerequisites')
    if (!this.hasCmd('winget')) {
      return { ok: false, error: `missing ${missing.map(m => m.label).join(', ')} and winget is unavailable to auto-install - install the App Installer (winget), or get them manually: Node https://nodejs.org/ , Git https://git-scm.com/download/win . Then re-run (or set ALDUINAK_NO_AUTO_INSTALL=1).` }
    }
    this.line(`[prereqs] missing: ${missing.map(m => m.label).join(', ')} - installing with winget…`)
    for (const m of missing) {
      await this.wingetInstall(m.id, m.label)
      this.refreshPath()
    }
    const still = missing.filter(m => !m.check())
    if (still.length) {
      return { ok: false, error: `still missing after install: ${still.map(m => m.label).join(', ')}. Check the winget output above (a PENDING REBOOT is the usual cause - reboot and Build again).` }
    }
    this.line('[prereqs] toolchain installed.')
    return { ok: true }
  }

  // ── Native (C++) build ──────────────────────────────────────────────────────

  // Locate a VS 2022 install with the C++ toolset; vswhere -requires filters out installs missing it.
  findVsWithCpp() {
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    if (!fs.existsSync(vswhere)) return null
    try {
      const out = cp.execSync(
        `"${vswhere}" -products * -version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -format value -property installationPath`,
        { encoding: 'utf8' }
      ).trim()
      const dir = out.split(/\r?\n/)[0]
      if (dir && fs.existsSync(path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))) return dir
    } catch {}
    return null
  }

  // cmake: PATH first, then the copy VS ships with the C++ workload.
  findCmake(vsDir) {
    if (this.hasCmd('cmake')) return 'cmake'
    if (vsDir) {
      const bundled = path.join(vsDir, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe')
      if (fs.existsSync(bundled)) return bundled
    }
    return null
  }

  // Reports everything the native build needs in one go, so the operator fixes it all in one pass.
  checkNativeToolchain() {
    const problems = []
    const vsDir = this.findVsWithCpp()
    if (!vsDir) {
      problems.push(
        'Visual Studio 2022 with the "Desktop development with C++" workload.\n' +
        '      Add it to an existing VS 2022 install (elevated):\n' +
        '      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vs_installer.exe" modify ^\n' +
        '        --productId Microsoft.VisualStudio.Product.Community ^\n' +
        '        --channelId VisualStudio.17.Release ^\n' +
        '        --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --norestart'
      )
    }
    const cmake = this.findCmake(vsDir)
    if (!cmake) problems.push('CMake (comes with the C++ workload above, or install it separately and put it on PATH)')
    if (!this.hasCmd('git')) problems.push('Git (needed for the vcpkg submodule)')
    if (!this.hasCmd('python') && !this.hasCmd('python3')) problems.push('Python 3 (some vcpkg ports need it)')
    const vcpkgDir = path.join(config.repoRoot, 'vcpkg')
    if (!fs.existsSync(path.join(vcpkgDir, '.git')) && !fs.existsSync(path.join(vcpkgDir, 'bootstrap-vcpkg.bat'))) {
      problems.push('the vcpkg submodule (run: git submodule update --init --recursive)')
    }
    return { vsDir, cmake, vcpkgDir, problems }
  }

  // Configure + build the C++ with CMake/MSVC, same flags as the "Dist Windows Flatrim" CI workflow (.github/actions/pr_base).
  // Produces SkyrimPlatform.dll + scam_native.node under build/dist.
  async buildNative(opts = {}) {
    this.banner('Native (C++) build')
    if (!isWin) return { ok: false, error: 'native build is Windows-only' }

    const tc = this.checkNativeToolchain()
    if (tc.problems.length) {
      this.line('[native] cannot build - missing:')
      for (const p of tc.problems) this.line(`  - ${p}`)
      this.line('\n[native] Tip: the "CI Rebuild" button builds the same binaries on GitHub instead.')
      return { ok: false, error: `missing build tools: ${tc.problems.length} item(s), see log` }
    }
    this.line(`[native] Visual Studio: ${tc.vsDir}`)
    this.line(`[native] cmake: ${tc.cmake}`)

    // vcpkg builds hundreds of ports; keep them off the small system drive.
    const buildDir = process.env.ALDUINAK_NATIVE_BUILD_DIR || path.join(config.buildDir, 'native')
    fs.mkdirSync(buildDir, { recursive: true })

    if (!fs.existsSync(path.join(tc.vcpkgDir, 'vcpkg.exe'))) {
      this.line('[native] bootstrapping vcpkg (first run, this takes a few minutes)…')
      const boot = await this.run(path.join(tc.vcpkgDir, 'bootstrap-vcpkg.bat'), [], tc.vcpkgDir, 'bootstrap vcpkg')
      if (!boot.ok) return { ok: false, error: 'vcpkg bootstrap failed - see log' }
    }

    // SKYMP_VOICE_CHAT / VCPKG_MANIFEST_FEATURES=voice-chat from circulating guides do not exist here (the latter aborts configure).
    // Voice chat is already built in; see docs/alduinak_voice_chat.md.
    const args = [
      '-B', buildDir,
      '-G', 'Visual Studio 17 2022',
      '-A', 'x64',
      `-DVCPKG_ROOT=${tc.vcpkgDir.replace(/\\/g, '/')}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_NODEJS=OFF',
      '-DBUILD_FRONT=OFF',
      '-DDOWNLOAD_SKYRIM_DATA=OFF',
      `-DBUILD_UNIT_TESTS=${opts.unitTests ? 'ON' : 'OFF'}`,
      `-DSKYRIM_VR=${opts.skyrimVr ? 'ON' : 'OFF'}`,
    ]
    if (config.gameRoot && fs.existsSync(config.gameRoot)) {
      args.push(`-DSKYRIM_DIR=${config.gameRoot.replace(/\\/g, '/')}`)
    }

    // The client TS bundle feeds native packaging; CI builds it before configuring (pr_base "Early build skymp5-client").
    const clientDeps = await this.ensureDeps(config.paths.client, 'client')
    if (!clientDeps.ok) return clientDeps
    const early = await this.run(this.packageManager(), ['run', 'build'], config.paths.client, 'client: build bundle')
    if (!early.ok) return { ok: false, error: 'client bundle build failed - see log' }

    // shell:false: cmake.exe and several args contain spaces a shell command line would split.
    this.line('\n[native] configuring (first run compiles all vcpkg dependencies - expect 1-3 hours)…')
    const cfg = await this.run(tc.cmake, args, config.repoRoot, 'cmake configure', { VCPKG_FEATURE_FLAGS: 'manifests' }, false)
    if (!cfg.ok) return { ok: false, error: 'cmake configure failed - see log' }

    this.line('\n[native] compiling…')
    const build = await this.run(tc.cmake, ['--build', buildDir, '--config', 'Release'], config.repoRoot, 'cmake build', null, false)
    if (!build.ok) return { ok: false, error: 'cmake build failed - see log' }

    // CMake writes its dist next to the build dir; report what landed to copy into build/dist.
    const outDir = path.join(buildDir, 'dist')
    this.line('')
    for (const rel of ['client/Data/SKSE/Plugins/SkyrimPlatform.dll', 'server/scam_native.node']) {
      const p = path.join(outDir, rel)
      this.line(fs.existsSync(p) ? `✓ ${rel}` : `MISSING ${rel}`)
    }
    this.line(`\n✓ Native build complete: ${outDir}`)
    this.line('  Copy client/ into build/dist/client and scam_native.node into build/dist/server, then run Build Client.')
    return { ok: true, out: outDir }
  }

  // Purges build/dist/server except for settings, world, and the CI-built artifacts.
  pruneServerDeploy() {
    const deployDir = path.join(config.buildDir, 'dist', 'server')
    const keep = new Set(['world', 'server-settings.json', 'gamemode.js', 'gamemode_extensions', 'plugins', 'dist_back', 'scam_native.node', 'data', 'sign-gamemode.js', 'signing-private.pem', 'install-services.bat', 'launch_server.bat', 'README.md', 'starter-grants.json', 'zone-spawns.json'])
    for (const extra of (process.env.ALDUINAK_SERVER_KEEP || '').split(',')) {
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

  // GAMEMODE: concatenate build/dist/server/gamemode_extensions/*.js (sorted by
  // filename) into gamemode.js. The game server hot-reloads the result within a
  // second, so this needs no service restart.
  async buildGamemode() {
    this.banner('Gamemode')
    const serverDir = config.paths.serverDir
    const extDir = path.join(serverDir, 'gamemode_extensions')
    const target = path.join(serverDir, 'gamemode.js')
    let parts = []
    try { parts = fs.readdirSync(extDir).filter(f => f.endsWith('.js')).sort() } catch {}
    if (!parts.length) {
      this.line('[gamemode] no gamemode_extensions/*.js found - gamemode.js left untouched.')
      return { ok: true }
    }
    const bodies = []
    for (const name of parts) {
      try {
        bodies.push(fs.readFileSync(path.join(extDir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, ''))
        this.line(`[gamemode] + ${name}`)
      } catch (err) {
        return { ok: false, error: `gamemode: could not read ${name} (${err.message})` }
      }
    }
    const banner = '// GENERATED from gamemode_extensions/ by the Server Manager - edit the parts, not this file.\n\n'
    const out = banner + bodies.join('\n\n') + '\n'
    // Compile without running: a part with a syntax error must never reach the live file.
    try { new (require('vm').Script)(out, { filename: 'gamemode.js' }) }
    catch (err) { return { ok: false, error: `gamemode: syntax error in the concatenated output - ${err.message}` } }
    let current = ''
    try { current = fs.readFileSync(target, 'utf8') } catch {}
    if (current === out) {
      this.line('[gamemode] gamemode.js already up to date.')
      return { ok: true }
    }
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, target)
    this.line(`\n✓ gamemode.js built from ${parts.length} extension file(s); the server hot-reloads it within a second.`)
    return { ok: true }
  }

  // GAME SERVER: bundle the TypeScript into build/dist/server/dist_back. The native
  // scam_native.node comes prebuilt from CI (the "server-dist" artifact); drop it
  // next to dist_back and it's preserved by the prune step. Does not restart the
  // service.
  async buildServer() {
    this.banner('Game server')
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre
    const dir = config.paths.server
    const dep = await this.ensureDeps(dir, 'game server')
    if (!dep.ok) return dep

    // TS bundle, safe to overwrite even while the server runs (read at startup).
    const pm = this.packageManager()
    const r = await this.run(pm, pm === 'yarn' ? ['build-ts'] : ['run', 'build-ts'], dir, 'game server: build-ts')
    if (!r.ok) return { ok: false, error: 'build-ts failed - TypeScript errors stop the build (see log)' }

    const gm = await this.buildGamemode()
    if (!gm.ok) return gm

    this.pruneServerDeploy()
    if (!fs.existsSync(path.join(config.buildDir, 'dist', 'server', 'scam_native.node'))) {
      this.line('\n[server] note: scam_native.node is not in build/dist/server - copy it from the CI "server-dist" artifact so the game server can start.')
    }
    this.line('\n✓ Game server TS bundle built into build/dist/server (native scam_native.node comes from CI).')
    return { ok: true }
  }

  // LAUNCHER: the Electron installer. Wipes the old output, installs deps, builds.
  async buildLauncher() {
    this.banner('Launcher')
    const pre = await this.ensurePrereqs()
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
    if (!build.ok) return { ok: false, error: 'electron-builder failed - see log' }

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

  // FRONT-END: rebuild the chat/UI webpack bundle into build/dist/client. webpack
  // reads skymp5-front/config.js (gitignored) for its output path, so we write it
  // to target the client dist's Data/Platform/UI folder.
  async buildFront() {
    this.banner('Front-end UI')
    const dir = config.paths.front
    const uiOut = path.join(config.paths.clientOut, 'Data', 'Platform', 'UI')
    try {
      fs.writeFileSync(path.join(dir, 'config.js'), `module.exports = { outputPath: ${JSON.stringify(uiOut)} };\n`)
    } catch (err) {
      return { ok: false, error: `front-end: could not write config.js (${err.message})` }
    }
    const dep = await this.ensureDeps(dir, 'front-end')
    if (!dep.ok) return dep
    const pm = this.packageManager()
    const r = await this.run(pm, pm === 'yarn' ? ['build'] : ['run', 'build'], dir, 'front-end: webpack build')
    if (!r.ok) return { ok: false, error: 'front-end build failed (see log)' }
    this.line(`\n✓ Front-end UI built into ${uiOut}`)
    return { ok: true }
  }

  // CLIENT LOGIC: rebuild skymp5-client.js into build/dist/client. Its webpack
  // config already targets Data/Platform/Plugins, so no output wiring is needed.
  async buildClientLogic() {
    this.banner('Client logic (skymp5-client.js)')
    const dir = config.paths.client
    const dep = await this.ensureDeps(dir, 'client logic')
    if (!dep.ok) return dep
    const pm = this.packageManager()
    const r = await this.run(pm, pm === 'yarn' ? ['build'] : ['run', 'build'], dir, 'client logic: webpack build')
    if (!r.ok) return { ok: false, error: 'client logic build failed (see log)' }
    this.line('\n✓ skymp5-client.js built into build/dist/client/Data/Platform/Plugins.')
    return { ok: true }
  }

  // CLIENT: rebuild the client-side JS (front-end UI + skymp5-client.js) into
  // build/dist/client, then package the client files into the launcher's
  // redistributable (skymp-client.zip + data/files-version.json). The native
  // .dll binaries still come prebuilt from CI.
  async buildClient() {
    this.banner('Client')
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre

    const clientData = path.join(config.paths.clientOut, 'Data')
    if (!fs.existsSync(clientData)) {
      return { ok: false, error: `client build output not found at ${clientData} - download the CI "dist" artifact (PR Windows Flatrim workflow) and extract it into build/dist/client, then Build again.` }
    }

    // Rebuild the client-side JS before packaging so the launcher ships the latest
    // UI and client logic. The native .dll is left as-is (it comes from CI).
    const front = await this.buildFront()
    if (!front.ok) return front
    const logic = await this.buildClientLogic()
    if (!logic.ok) return logic

    // populate-files.js copies build/dist/client/Data into the backend file bucket,
    // merge-files.js builds skymp-client.zip + data/files-version.json (version from
    // CLIENT_VERSION in routes/version.js, set it from the Client version field).
    const dep = await this.ensureDeps(config.paths.backend, 'backend', 'npm')
    if (!dep.ok) return dep
    const r = await this.run('npm', ['run', 'build-client'], config.paths.backend, 'package client: npm run build-client')
    if (!r.ok) return { ok: false, error: 'build-client failed - see log (is build/dist/client complete?)' }

    this.line('\n✓ Client files packaged into the launcher bucket (skymp-client.zip + files-version.json) from the CI build.')
    return { ok: true, out: config.paths.clientOut }
  }
}

module.exports = { Builder }
