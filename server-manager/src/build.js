'use strict'

const fs   = require('fs')
const path = require('path')
const cp   = require('child_process')
const { spawn } = require('child_process')
const config = require('./config')

const isWin = process.platform === 'win32'

// The manager no longer compiles native code (.dll / .node) locally — the GitHub
// "PR Windows Flatrim" workflow does that and publishes the `dist` artifact. Each
// Build button here is pure JS/packaging: it bundles TypeScript, builds the
// Electron launcher, and zips the CI-produced client files for the launcher to
// download. Drop the CI `dist` into build/dist/client (and scam_native.node into
// build/dist/server) before building.
class Builder {
  constructor(log) {
    this.log = log || (() => {})
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

  // Ensure the JS toolchain every build needs (Node.js + Git). No C++ toolchain —
  // the native binaries come prebuilt from CI.
  async ensurePrereqs() {
    if (!isWin) return { ok: true }                        // auto-install is Windows-only
    if (process.env.SKYRP_NO_AUTO_INSTALL === '1') return { ok: true }

    const missing = []
    if (!this.hasCmd('node')) missing.push({ id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS', check: () => this.hasCmd('node') })
    if (!this.hasCmd('git'))  missing.push({ id: 'Git.Git',           label: 'Git',         check: () => this.hasCmd('git') })
    if (!missing.length) return { ok: true }

    this.banner('Installing missing prerequisites')
    if (!this.hasCmd('winget')) {
      return { ok: false, error: `missing ${missing.map(m => m.label).join(', ')} and winget is unavailable to auto-install — install the App Installer (winget), or get them manually: Node https://nodejs.org/ , Git https://git-scm.com/download/win . Then re-run (or set SKYRP_NO_AUTO_INSTALL=1).` }
    }
    this.line(`[prereqs] missing: ${missing.map(m => m.label).join(', ')} — installing with winget…`)
    for (const m of missing) {
      await this.wingetInstall(m.id, m.label)
      this.refreshPath()
    }
    const still = missing.filter(m => !m.check())
    if (still.length) {
      return { ok: false, error: `still missing after install: ${still.map(m => m.label).join(', ')}. Check the winget output above (a PENDING REBOOT is the usual cause — reboot and Build again).` }
    }
    this.line('[prereqs] toolchain installed.')
    return { ok: true }
  }

  // Purges build/dist/server except for settings, world, and the CI-built artifacts.
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

  // GAME SERVER: bundle the TypeScript into build/dist/server/dist_back. The native
  // scam_native.node comes prebuilt from CI (the "server-dist" artifact) — drop it
  // next to dist_back and it's preserved by the prune step. Does not restart the
  // service.
  async buildServer() {
    this.banner('Game server')
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre
    const dir = config.paths.server
    const dep = await this.ensureDeps(dir, 'game server')
    if (!dep.ok) return dep

    // TS bundle — safe to overwrite even while the server runs (read at startup).
    const pm = this.packageManager()
    const r = await this.run(pm, pm === 'yarn' ? ['build-ts'] : ['run', 'build-ts'], dir, 'game server: build-ts')
    if (!r.ok) return { ok: false, error: 'build-ts failed — TypeScript errors stop the build (see log)' }

    this.pruneServerDeploy()
    if (!fs.existsSync(path.join(config.buildDir, 'dist', 'server', 'scam_native.node'))) {
      this.line('\n[server] note: scam_native.node is not in build/dist/server — copy it from the CI "server-dist" artifact so the game server can start.')
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

  // CLIENT: package the CI-built client files (build/dist/client) into the
  // launcher's redistributable — skymp-client.zip + data/files-version.json.
  // The .dll/.js client binaries are compiled by CI; this only zips them.
  async buildClient() {
    this.banner('Client')
    const pre = await this.ensurePrereqs()
    if (!pre.ok) return pre

    const clientData = path.join(config.paths.clientOut, 'Data')
    if (!fs.existsSync(clientData)) {
      return { ok: false, error: `client build output not found at ${clientData} — download the CI "dist" artifact (PR Windows Flatrim workflow) and extract it into build/dist/client, then Build again.` }
    }

    // populate-files.js copies build/dist/client/Data into the backend file bucket,
    // merge-files.js builds skymp-client.zip + data/files-version.json (version from
    // CLIENT_VERSION in the backend .env — set it from the Client version field).
    const dep = await this.ensureDeps(config.paths.backend, 'backend', 'npm')
    if (!dep.ok) return dep
    const r = await this.run('npm', ['run', 'build-client'], config.paths.backend, 'package client: npm run build-client')
    if (!r.ok) return { ok: false, error: 'build-client failed — see log (is build/dist/client complete?)' }

    this.line('\n✓ Client files packaged into the launcher bucket (skymp-client.zip + files-version.json) from the CI build.')
    return { ok: true, out: config.paths.clientOut }
  }
}

module.exports = { Builder }
