'use strict'

const fs   = require('fs')
const path = require('path')
const cp   = require('child_process')
const crypto = require('crypto')
const config = require('./config')
const { loc, gamemodeLocPrelude } = require('./loc')
// Shared with the backend's populate and compile-manifest scripts so the key-file list lives in one place
const clientPackage = require(path.join(config.paths.backend, 'scripts', 'client-package'))

const isWin = process.platform === 'win32'

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

// A Data-relative client path as the zip listing keys it

// One hash over sha256sum-style lines of the part files, recomputable from Get-FileHash output
function extensionsManifest(files) {
  return { sha256: sha256(files.map(f => `${f.sha256}  ${f.name}\n`).join('')), files }
}

const fwd = p => String(p).replace(/\\/g, '/')

// Most Build buttons are pure JS/packaging: bundle TypeScript, build the launcher, zip client files.
// buildNative() compiles the C++ locally with CMake + MSVC (needs the VS 2022 C++ workload); the CI Rebuild button builds the same on GitHub.
// Every build lands in the profile's dirs (serverDir, clientOut); the default is config.buildProfile, the test server.
class Builder {
  constructor(log, profile = config.profiles[config.buildProfile]) {
    this.log = log || (() => {})
    this.profile = profile
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
        this.line(loc('builder.spawnFailed', { error: err.message }))
        return resolve({ ok: false, code: -1 })
      }
      child.stdout.on('data', d => this.log(d.toString()))
      child.stderr.on('data', d => this.log(d.toString()))
      child.on('error', err => { this.line(loc('builder.runError', { error: err.message })); resolve({ ok: false, code: -1 }) })
      child.on('close', code => { this.line(loc('builder.exit', { code })); resolve({ ok: code === 0, code }) })
    })
  }

  // Prefer yarn when it's on PATH (the repo's build scripts assume it), else npm.
  packageManager() {
    try { cp.execSync(isWin ? 'where yarn' : 'which yarn', { stdio: 'ignore' }); return 'yarn' }
    catch { return 'npm' }
  }

  // Install a project's dependencies when node_modules is missing
  async ensureDeps(dir, label, pm = this.packageManager()) {
    if (!fs.existsSync(dir)) return { ok: false, error: loc('builder.deps.noDir', { label, dir }) }
    if (fs.existsSync(path.join(dir, 'node_modules'))) return { ok: true }
    this.line(`[${label}] ${loc('builder.deps.installing')}`)
    const args = pm === 'yarn' ? ['install', '--frozen-lockfile'] : ['install', '--legacy-peer-deps']
    const r = await this.run(pm, args, dir, `${label}: ${pm} install`)
    // yarn --frozen-lockfile fails on a stale/absent lockfile; retry permissively.
    if (!r.ok && pm === 'yarn') {
      this.line(`[${label}] ${loc('builder.deps.retry')}`)
      const r2 = await this.run(pm, ['install'], dir, `${label}: yarn install`)
      return r2.ok ? { ok: true } : { ok: false, error: loc('builder.deps.failed', { label }) }
    }
    return r.ok ? { ok: true } : { ok: false, error: loc('builder.deps.failed', { label }) }
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
    return this.run('winget', args, config.repoRoot, loc('builder.prereq.install', { label }))
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

    this.banner(loc('builder.prereq.banner'))
    if (!this.hasCmd('winget')) {
      return { ok: false, error: loc('builder.prereq.noWinget', { missing: missing.map(m => m.label).join(', ') }) }
    }
    this.line(`[prereqs] ${loc('builder.prereq.installing', { missing: missing.map(m => m.label).join(', ') })}`)
    for (const m of missing) {
      await this.wingetInstall(m.id, m.label)
      this.refreshPath()
    }
    const still = missing.filter(m => !m.check())
    if (still.length) {
      return { ok: false, error: loc('builder.prereq.stillMissing', { missing: still.map(m => m.label).join(', ') }) }
    }
    this.line(`[prereqs] ${loc('builder.prereq.done')}`)
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
        loc('builder.native.needVs') + '\n' +
        loc('builder.native.addVs') + '\n' +
        '      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vs_installer.exe" modify ^\n' +
        '        --productId Microsoft.VisualStudio.Product.Community ^\n' +
        '        --channelId VisualStudio.17.Release ^\n' +
        '        --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --norestart'
      )
    }
    const cmake = this.findCmake(vsDir)
    if (!cmake) problems.push(loc('builder.native.needCmake'))
    if (!this.hasCmd('git')) problems.push(loc('builder.native.needGit'))
    if (!this.hasCmd('python') && !this.hasCmd('python3')) problems.push(loc('builder.native.needPython'))
    const vcpkgDir = path.join(config.repoRoot, 'vcpkg')
    if (!fs.existsSync(path.join(vcpkgDir, '.git')) && !fs.existsSync(path.join(vcpkgDir, 'bootstrap-vcpkg.bat'))) {
      problems.push(loc('builder.native.needVcpkg'))
    }
    return { vsDir, cmake, vcpkgDir, problems }
  }

  // CMake pins a build tree to the VS install it was first configured with, so a moved install needs a fresh cache.
  resetStaleCmakeCache(buildDir, vsDir) {
    const cacheFile = path.join(buildDir, 'CMakeCache.txt')
    let cached = null
    try { cached = fs.readFileSync(cacheFile, 'utf8').match(/^CMAKE_GENERATOR_INSTANCE:\w+=(.*)$/m) } catch {}
    const norm = p => p.split(',')[0].trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!cached || norm(cached[1]) === norm(vsDir)) return { ok: true }
    this.line(`[native] ${loc('builder.native.resetCache', { vs: cached[1].trim() })}`)
    try {
      // CMakeFiles first, so a failure leaves the stale cache entry that triggers the retry
      fs.rmSync(path.join(buildDir, 'CMakeFiles'), { recursive: true, force: true })
      fs.rmSync(cacheFile, { force: true })
    } catch (err) {
      return { ok: false, error: loc('builder.native.resetFailed', { error: err.message }) }
    }
    return { ok: true }
  }

  // Configure + build the C++ with CMake/MSVC, same flags as the "Dist Windows Flatrim" CI workflow (.github/actions/pr_base).
  // The repo pins the CMake binary dir to <repo>/build; SKYMP_DIST_SERVER_DIR and SKYMP_DIST_CLIENT_DIR
  // point the artifacts at the profile's dirs, so they land there directly, no copy step.
  // opts.targets limits the build (e.g. ['skymp5-server']); omit for everything.
  async buildNative(opts = {}) {
    this.banner(loc('builder.native.banner', { server: this.profile.label }))
    if (!isWin) return { ok: false, error: loc('builder.native.windowsOnly') }

    const tc = this.checkNativeToolchain()
    if (tc.problems.length) {
      this.line(`[native] ${loc('builder.native.cannotBuild')}`)
      for (const p of tc.problems) this.line(`  - ${p}`)
      this.line(`\n[native] ${loc('builder.native.ciTip')}`)
      return { ok: false, error: loc('builder.native.missingTools', { n: tc.problems.length }) }
    }
    this.line(`[native] Visual Studio: ${tc.vsDir}`)
    this.line(`[native] cmake: ${tc.cmake}`)

    // CMakeLists refuses any other binary dir, so this cannot be relocated.
    const buildDir = path.join(config.repoRoot, 'build')
    fs.mkdirSync(buildDir, { recursive: true })

    // The linker writes scam_native.node straight into the profile's server dir;
    // fail before the long build instead of at the very end.
    const serverOnly = Array.isArray(opts.targets) && opts.targets.every(t => t === 'skymp5-server')
    const buildsServer = !Array.isArray(opts.targets) || opts.targets.includes('skymp5-server')
    const { serverDir, clientOut } = this.profile
    if (buildsServer) {
      const nodeBin = path.join(serverDir, 'scam_native.node')
      if (fs.existsSync(nodeBin)) {
        try { fs.closeSync(fs.openSync(nodeBin, 'r+')) }
        catch { return { ok: false, error: loc('builder.native.nodeLocked', { server: this.profile.label }) } }
      }
    }

    // The CMake configure itself runs `yarn install` (cmake/yarn.cmake); npm is
    // not accepted there, so the JS builds' npm fallback does not apply.
    if (!this.hasCmd('yarn')) {
      this.line(`[native] ${loc('builder.native.yarnMissing')}`)
      const y = await this.run('npm', ['install', '-g', 'yarn'], config.repoRoot, loc('builder.prereq.install', { label: 'yarn' }))
      this.refreshPath()
      if (!y.ok || !this.hasCmd('yarn')) {
        return { ok: false, error: loc('builder.native.yarnRequired') }
      }
    }

    if (!fs.existsSync(path.join(tc.vcpkgDir, 'vcpkg.exe'))) {
      this.line(`[native] ${loc('builder.native.vcpkgBoot')}`)
      const boot = await this.run(path.join(tc.vcpkgDir, 'bootstrap-vcpkg.bat'), [], tc.vcpkgDir, 'bootstrap vcpkg')
      if (!boot.ok) return { ok: false, error: loc('builder.native.vcpkgFailed') }
    }

    // SKYMP_VOICE_CHAT / VCPKG_MANIFEST_FEATURES=voice-chat from circulating guides do not exist here (the latter aborts configure).
    // Voice chat is already built in; see docs/alduinak_voice_chat.md.
    const args = [
      '-B', buildDir,
      '-G', 'Visual Studio 17 2022',
      '-A', 'x64',
      `-DCMAKE_GENERATOR_INSTANCE=${tc.vsDir.replace(/\\/g, '/')}`,
      `-DVCPKG_ROOT=${tc.vcpkgDir.replace(/\\/g, '/')}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_NODEJS=OFF',
      '-DBUILD_FRONT=OFF',
      '-DDOWNLOAD_SKYRIM_DATA=OFF',
      `-DBUILD_UNIT_TESTS=${opts.unitTests ? 'ON' : 'OFF'}`,
      `-DSKYRIM_VR=${opts.skyrimVr ? 'ON' : 'OFF'}`,
      `-DSKYMP_DIST_SERVER_DIR=${fwd(serverDir)}`,
      `-DSKYMP_DIST_CLIENT_DIR=${fwd(clientOut)}`,
    ]
    if (config.gameRoot && fs.existsSync(config.gameRoot)) {
      args.push(`-DSKYRIM_DIR=${fwd(config.gameRoot)}`)
    }

    // The client TS bundle feeds native packaging; CI builds it before configuring (pr_base "Early build skymp5-client").
    if (!serverOnly) {
      const clientDeps = await this.ensureDeps(config.paths.client, 'client')
      if (!clientDeps.ok) return clientDeps
      const early = await this.run(this.packageManager(), ['run', 'build'], config.paths.client, 'client: build bundle', this.clientBundleEnv())
      if (!early.ok) return { ok: false, error: loc('builder.native.bundleFailed') }
    }

    const reset = this.resetStaleCmakeCache(buildDir, tc.vsDir)
    if (!reset.ok) return reset

    // shell:false: cmake.exe and several args contain spaces a shell command line would split.
    this.line(`\n[native] ${loc('builder.native.configuring')}`)
    const cfg = await this.run(tc.cmake, args, config.repoRoot, 'cmake configure', { VCPKG_FEATURE_FLAGS: 'manifests' }, false)
    if (!cfg.ok) return { ok: false, error: loc('builder.native.configureFailed') }

    // The server post-build step regenerates server-settings.json with
    // upstream defaults (it force-sets offlineMode and master), so snapshot
    // the deployed files and put them back afterwards.
    // With BUILD_GAMEMODE off, the ALL build also touches gamemode.js through skymp5-functions-lib.
    const guarded = ['server-settings.json', 'launch_server.bat', 'gamemode.js'].map(name => {
      const file = path.join(serverDir, name)
      let before = null
      try { before = fs.readFileSync(file) } catch {}
      return { file, before }
    })

    this.line(`\n[native] ${loc('builder.native.compiling')}`)
    const buildArgs = ['--build', buildDir, '--config', 'Release']
    for (const t of (opts.targets || [])) buildArgs.push('--target', t)
    const build = await this.run(tc.cmake, buildArgs, config.repoRoot, 'cmake build', null, false)

    for (const g of guarded) {
      if (!g.before) continue
      let after = null
      try { after = fs.readFileSync(g.file) } catch {}
      if (!after || !after.equals(g.before)) {
        fs.writeFileSync(g.file, g.before)
        this.line(`[native] ${loc('builder.native.restored', { file: path.basename(g.file) })}`)
      }
    }
    if (!build.ok) return { ok: false, error: loc('builder.native.buildFailed') }

    this.line('')
    const expected = []
    if (buildsServer) expected.push(path.join(serverDir, 'scam_native.node'))
    if (!serverOnly) expected.push(path.join(clientOut, 'Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'))
    for (const p of expected) this.line(fs.existsSync(p) ? `✓ ${p}` : loc('builder.native.missingFile', { file: p }))
    this.line('\n' + loc('builder.native.done', { server: this.profile.label, serverDir, clientOut }))
    return { ok: true, out: { serverDir, clientOut } }
  }

  // Purges the profile's server dir except for settings, world, and the CI-built artifacts.
  pruneServerDeploy() {
    const deployDir = this.profile.serverDir
    const keep = new Set(['world', 'gamemode.js', 'gamemode_extensions', 'plugins', 'dist_back', 'scam_native.node', 'data', 'sign-gamemode.js', 'signing-private.pem', 'install-services.bat', 'launch_server.bat', 'readme.md', 'starter-grants.json', 'zone-spawns.json', 'companions.json', 'housing.json', 'pets.json', 'npc-spawns.json', 'writings', 'faction-access.json', 'jobs.json', 'alert-keywords.json', 'gathering-picks.json', 'weather-state.json', 'weather-regions.json'])
    for (const extra of (process.env.ALDUINAK_SERVER_KEEP || '').split(',')) {
      const n = extra.trim().toLowerCase(); if (n) keep.add(n)
    }
    let entries
    try { entries = fs.readdirSync(deployDir) } catch { return }
    for (const name of entries) {
      // server-settings.json with its .prev/.tmp copies and timestamped backups (purges, deploy/mongodb scripts) stay
      if (keep.has(name.toLowerCase()) || /^server-settings[.-]/i.test(name) || /-\d{13}\.json$/i.test(name)) continue
      try {
        fs.rmSync(path.join(deployDir, name), { recursive: true, force: true })
        this.line(`[deploy] ${loc('builder.deploy.removed', { name })}`)
      } catch (err) { this.line(`[deploy] ${loc('builder.deploy.removeFailed', { name, error: err.message })}`) }
    }
  }

  // GAMEMODE: concatenate <serverDir>/gamemode_extensions/*.js (sorted by
  // filename) into gamemode.js. The game server hot-reloads the result within a
  // second, so this needs no service restart.
  async buildGamemode() {
    this.banner(loc('builder.gamemode.banner', { server: this.profile.label }))
    const serverDir = this.profile.serverDir
    if (!fs.existsSync(serverDir)) return { ok: false, error: loc('builder.noServerDir', { server: this.profile.label, dir: serverDir }) }
    const extDir = path.join(serverDir, 'gamemode_extensions')
    const target = path.join(serverDir, 'gamemode.js')
    let parts = []
    try { parts = fs.readdirSync(extDir).filter(f => f.endsWith('.js')).sort() } catch {}
    if (!parts.length) {
      this.line(`[gamemode] ${loc('builder.gamemode.noParts')}`)
      return { ok: true, extensions: extensionsManifest([]) }
    }
    const bodies = []
    const files = []
    for (const name of parts) {
      try {
        const raw = fs.readFileSync(path.join(extDir, name))
        files.push({ name, sha256: sha256(raw) })
        bodies.push(raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\s+$/, ''))
        this.line(`[gamemode] + ${name}  sha256 ${files[files.length - 1].sha256.slice(0, 16)}`)
      } catch (err) {
        return { ok: false, error: loc('builder.gamemode.readFailed', { name, error: err.message }) }
      }
    }
    // gamemode_extensions is not in git, so the hashes are the only record of which parts were built
    const extensions = extensionsManifest(files)
    this.line(`[gamemode] extensions sha256 ${extensions.sha256}`)
    const banner = '// GENERATED from gamemode_extensions/ by the Server Manager - edit the parts, not this file.\n\n'
    let prelude
    try { prelude = gamemodeLocPrelude() }
    catch (err) { return { ok: false, error: loc('builder.gamemode.locFailed', { error: err.message }), extensions } }
    const out = banner + prelude + '\n' + bodies.join('\n\n') + '\n'
    // Compile without running: a part with a syntax error must never reach the live file.
    try { new (require('vm').Script)(out, { filename: 'gamemode.js' }) }
    catch (err) { return { ok: false, error: loc('builder.gamemode.syntax', { error: err.message }), extensions } }
    let current = ''
    try { current = fs.readFileSync(target, 'utf8') } catch {}
    if (current === out) {
      this.line(`[gamemode] ${loc('builder.gamemode.upToDate')}`)
      return { ok: true, extensions }
    }
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, target)
    this.line('\n' + loc('builder.gamemode.done', { n: parts.length }))
    return { ok: true, extensions }
  }

  // The package.json build-ts script bundles into the live dist, so its two steps run here with the profile's outfile
  async buildServerTs(dir) {
    const script = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts['build-ts'] || ''
    const [tsc, esbuild] = script.split('&&').map(s => s.trim().split(/\s+/)).filter(a => a[0])
    if (!tsc || !esbuild || !esbuild.some(a => a.startsWith('--outfile='))) return { ok: false, error: loc('builder.server.noScript') }
    const outfile = path.join(this.profile.serverDir, 'dist_back', 'skymp5-server.js')
    const bin = name => path.join(dir, 'node_modules', '.bin', isWin ? `${name}.cmd` : name)
    // shell:true on Windows (.cmd shims), so a spaced outfile path is quoted here
    const quote = a => (/\s/.test(a) ? `"${a}"` : a)
    const t = await this.run(bin(tsc[0]), tsc.slice(1), dir, 'game server: ' + tsc.join(' '))
    if (!t.ok) return { ok: false, error: loc('builder.server.tscFailed') }
    const args = esbuild.slice(1).map(a => (a.startsWith('--outfile=') ? quote(`--outfile=${outfile}`) : a))
    const e = await this.run(bin(esbuild[0]), args, dir, `game server: esbuild -> ${outfile}`)
    return e.ok ? { ok: true } : { ok: false, error: loc('builder.server.esbuildFailed') }
  }

  // GAME SERVER: bundle the TypeScript into <serverDir>/dist_back. The native
  // scam_native.node comes from CI (the "server-dist" artifact) or Run CMake first;
  // it sits next to dist_back and is preserved by the prune step. Does not restart the service.
  async buildServer(opts = {}) {
    const { label, serverDir } = this.profile
    this.banner(loc('builder.server.banner', { server: label }))
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre
    if (!fs.existsSync(serverDir)) return { ok: false, error: loc('builder.noServerDir', { server: label, dir: serverDir }) }
    if (opts.native) {
      // Targeted: only the server native module; its output lands in the profile's server dir directly
      const nat = await this.buildNative({ targets: ['skymp5-server'] })
      if (!nat.ok) return nat
    }
    const dir = config.paths.server
    const dep = await this.ensureDeps(dir, 'game server')
    if (!dep.ok) return dep

    // TS bundle, safe to overwrite even while the server runs (read at startup).
    const r = await this.buildServerTs(dir)
    if (!r.ok) return r

    const gm = await this.buildGamemode()
    if (!gm.ok) return gm

    this.pruneServerDeploy()
    if (!fs.existsSync(path.join(serverDir, 'scam_native.node'))) {
      this.line(`\n[server] ${loc('builder.server.noNative', { dir: serverDir })}`)
    }
    this.line('\n' + loc('builder.server.done', { dir: serverDir, server: label }))
    return { ok: true, extensions: gm.extensions }
  }

  // LAUNCHER: the website installer (build/launcher-website) carries the cleaned-master patches, the nginx one (build/launcher) leaves them out
  async buildLauncher() {
    this.banner(loc('builder.launcher.banner'))
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre
    const dir = config.paths.launcher
    const dep = await this.ensureDeps(dir, 'launcher', 'npm')
    if (!dep.ok) return dep
    const mastersSrc = path.join(config.repoRoot, 'build', 'client-files', 'cleaned-masters')
    const mastersDst = path.join(dir, 'src-tauri', 'resources', 'cleaned-masters')
    const isPatch = f => f.toLowerCase().endsWith('.vcdiff')
    const clearPatches = () => { for (const f of fs.readdirSync(mastersDst).filter(isPatch)) fs.unlinkSync(path.join(mastersDst, f)) }
    const patches = fs.existsSync(mastersSrc) ? fs.readdirSync(mastersSrc).filter(isPatch) : []
    if (!patches.length) return { ok: false, error: loc('builder.launcher.noPatches', { dir: mastersSrc }) }
    try {
      fs.mkdirSync(mastersDst, { recursive: true })
      clearPatches()
      for (const f of patches) fs.copyFileSync(path.join(mastersSrc, f), path.join(mastersDst, f))
    } catch (err) {
      return { ok: false, error: loc('builder.launcher.copyFailed', { error: err.message }) }
    }
    this.line(`[launcher] ${loc('builder.launcher.bundling', { n: patches.length, dir: mastersSrc })}`)
    const cargo = path.join(process.env.USERPROFILE || '', '.cargo', 'bin')
    // Windows keeps PATH under whatever casing it came with; a second key would be ambiguous
    const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH'
    const env = { [pathKey]: `${cargo};${process.env[pathKey] || ''}` }
    const build = await this.run('npx', ['tauri', 'build'], dir, 'launcher: tauri build (website installer)', env)
    if (!build.ok) return { ok: false, error: loc('builder.launcher.tauriFailed') }
    const bundle = path.join(dir, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
    const version = JSON.parse(fs.readFileSync(config.paths.launcherPkg, 'utf8')).version
    const place = outDir => {
      // Older installers stay in the bundle folder, so pick the one for this version
      const built = fs.readdirSync(bundle).find(f => f.toLowerCase().endsWith(`_${version}_x64-setup.exe`))
      if (!built) return null
      fs.mkdirSync(outDir, { recursive: true })
      const exePath = path.join(outDir, config.launcherArtifact)
      // Copied aside then renamed, so a launcher never downloads a half-written installer
      fs.copyFileSync(path.join(bundle, built), exePath + '.part')
      fs.renameSync(exePath + '.part', exePath)
      return exePath
    }
    const webExe = place(path.join(config.repoRoot, 'build', 'launcher-website'))
    if (!webExe) return { ok: false, error: loc('builder.launcher.noInstaller', { version, dir: bundle }) }
    try { clearPatches() } catch (err) {
      return { ok: false, error: loc('builder.launcher.clearFailed', { error: err.message }) }
    }
    // Re-bundles the same binary without the patches, no second compile
    const plain = await this.run('npx', ['tauri', 'bundle'], dir, 'launcher: tauri bundle (nginx installer, no patches)', env)
    if (!plain.ok) return { ok: false, error: loc('builder.launcher.bundleFailed') }
    const exePath = place(config.paths.launcherOut)
    if (!exePath) return { ok: false, error: loc('builder.launcher.noInstaller', { version, dir: bundle }) }
    this.line(`[launcher] ${loc('builder.launcher.website', { file: webExe })}`)
    this.line(`[launcher] ${loc('builder.launcher.nginx', { file: exePath })}`)
    try {
      const v = require(path.join(config.paths.backend, 'sources', 'versions')).readVersions()
      if (new URL(v.launcherUrl).host === new URL(v.legacyDownloadUrl).host) {
        this.line(`[launcher] ${loc('builder.launcher.urlHere', { url: v.launcherUrl })}`)
      }
    } catch { /* unreadable versions.json: nothing to compare */ }
    this.line(`[launcher] ${loc('builder.launcher.publishHint', { version })}`)
    this.line('\n' + loc('builder.launcher.done', { website: webExe, nginx: exePath }))
    return { ok: true, out: config.paths.launcherOut }
  }

  // The client webpack config writes skymp5-client.js where ALDUINAK_CLIENT_OUT points
  clientBundleEnv() {
    return { ALDUINAK_CLIENT_OUT: path.join(this.profile.clientOut, 'Data', 'Platform', 'Plugins') }
  }

  // FRONT-END: rebuild the chat/UI webpack bundle into the profile's client dir. webpack
  // reads skymp5-front/config.js (gitignored) for its output path, so we write it
  // to target the client dist's Data/Platform/UI folder.
  async buildFront() {
    this.banner(loc('builder.front.banner'))
    const dir = config.paths.front
    const uiOut = path.join(this.profile.clientOut, 'Data', 'Platform', 'UI')
    try {
      fs.writeFileSync(path.join(dir, 'config.js'), `module.exports = { outputPath: ${JSON.stringify(uiOut)} };\n`)
    } catch (err) {
      return { ok: false, error: loc('builder.front.configFailed', { error: err.message }) }
    }
    const dep = await this.ensureDeps(dir, 'front-end')
    if (!dep.ok) return dep
    const pm = this.packageManager()
    const r = await this.run(pm, pm === 'yarn' ? ['build'] : ['run', 'build'], dir, 'front-end: webpack build')
    if (!r.ok) return { ok: false, error: loc('builder.front.failed') }
    // On-box static UI media (menu background/music - kept out of the public
    // repo): everything in skymp5-front/ui-static ships next to index.html.
    const staticDir = path.join(dir, 'ui-static')
    if (fs.existsSync(staticDir)) {
      for (const name of fs.readdirSync(staticDir)) {
        try {
          fs.copyFileSync(path.join(staticDir, name), path.join(uiOut, name))
          this.line(`[front] + ui-static/${name}`)
        } catch (err) {
          return { ok: false, error: loc('builder.front.copyFailed', { name, error: err.message }) }
        }
      }
    }
    this.line('\n' + loc('builder.front.done', { dir: uiOut }))
    return { ok: true }
  }

  // CLIENT LOGIC: rebuild skymp5-client.js into the profile's client dir (Data/Platform/Plugins)
  async buildClientLogic() {
    this.banner(loc('builder.logic.banner'))
    const dir = config.paths.client
    const dep = await this.ensureDeps(dir, 'client logic')
    if (!dep.ok) return dep
    const pm = this.packageManager()
    const env = this.clientBundleEnv()
    const r = await this.run(pm, pm === 'yarn' ? ['build'] : ['run', 'build'], dir, 'client logic: webpack build', env)
    if (!r.ok) return { ok: false, error: loc('builder.logic.failed') }
    this.line('\n' + loc('builder.logic.done', { dir: env.ALDUINAK_CLIENT_OUT }))
    return { ok: true }
  }

  // A client dir without Data starts as a copy of the live one, so the CI dlls and fonts are in place before the JS lands
  seedClientDir() {
    const { clientOut } = this.profile
    const live = config.profiles.live.clientOut
    if (fs.existsSync(path.join(clientOut, 'Data')) || path.resolve(clientOut) === path.resolve(live)) return { ok: true }
    if (!fs.existsSync(path.join(live, 'Data'))) {
      return { ok: false, error: loc('builder.client.noSeed', { dir: path.join(clientOut, 'Data'), live }) }
    }
    this.line(`[client] ${loc('builder.client.seeding', { dir: clientOut, live })}`)
    try { fs.cpSync(live, clientOut, { recursive: true }) }
    catch (err) { return { ok: false, error: loc('builder.client.seedFailed', { dir: clientOut, live, error: err.message }) } }
    this.line(`[client] ${loc('builder.client.seeded')}`)
    return { ok: true }
  }

  // CLIENT: rebuild the client-side JS (front-end UI + skymp5-client.js) into the profile's client dir.
  // Players get it through the Alduinak Client Files mod; the native .dll binaries come from CI or the CMake build.
  async buildClient(opts = {}) {
    const { label, clientOut } = this.profile
    this.banner(loc('builder.client.banner', { server: label }))
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre

    const seed = this.seedClientDir()
    if (!seed.ok) return seed

    if (opts.native) {
      // Targeted: the platform DLLs + client bundle, written into the profile's client dir directly
      const nat = await this.buildNative({ targets: ['skymp5-client', 'skyrim-platform'] })
      if (!nat.ok) return nat
    }

    const clientData = path.join(clientOut, 'Data')
    if (!fs.existsSync(clientData)) {
      return { ok: false, error: loc('builder.client.noOutput', { dir: clientData, out: clientOut }) }
    }

    // Rebuild the client-side JS before packaging so the launcher ships the latest
    // UI and client logic. The native .dll is left as-is (it comes from CI).
    const front = await this.buildFront()
    if (!front.ok) return front
    const logic = await this.buildClientLogic()
    if (!logic.ok) return logic

    const missing = clientPackage.KEY_FILES.filter(rel => !fs.existsSync(path.join(clientData, rel)))
    if (missing.length) return { ok: false, error: loc('builder.client.missingFiles', { dir: clientData, files: missing.join(', ') }) }
    this.line('\n' + loc('builder.client.done', { out: clientOut, data: clientData, mod: path.join(config.mo2Root, 'mods', 'Alduinak Client Files') }))
    return { ok: true, out: clientOut }
  }
}

module.exports = { Builder }
