'use strict'

// Server Manager configuration. The manager lives inside the repo, so the repo
// root is auto-detected (server-manager/src -> repo). Everything else has a
// sensible Windows default and can be overridden with an environment variable.

const path = require('path')
const fs   = require('fs')
const { loc } = require('./loc')

const repoRoot = path.resolve(__dirname, '..', '..')

function nssmPath() {
  const bundled = 'C:\\tools\\nssm\\nssm.exe'
  return fs.existsSync(bundled) ? bundled : 'nssm'
}

// Read a single KEY=value from the backend .env (used for the WS console link).
function readEnv(key) {
  try {
    const txt = fs.readFileSync(path.join(repoRoot, 'skymp5-backend', '.env'), 'utf8')
    const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)\\s*$', 'm'))
    // Surrounding quotes are dropped as dotenv does, so the backend and the manager read the same secret
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : ''
  } catch { return '' }
}

// A relay port from the backend .env: an integer in range, else NaN so the relay client refuses to connect
function relayPort(key, fallback) {
  const port = Number(readEnv(key) || fallback)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : NaN
}

// systemLog.path of the mongod config under deploy/mongodb, which the MongoDB service loads
function mongoLogFile(cfgName, fallback) {
  try {
    const m = /^\s*path:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(repoRoot, 'deploy', 'mongodb', cfgName), 'utf8'))
    if (m) return m[1]
  } catch {}
  return fallback
}

function readServerSetting(key, file = serverSettings) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))[key] || '' } catch { return '' }
}

const serverSettings = process.env.ALDUINAK_SERVER_SETTINGS
  || path.join(repoRoot, 'build', 'dist', 'server', 'server-settings.json')
const serverDir = process.env.ALDUINAK_SERVER_DIR || path.dirname(serverSettings)
const testServerDir = process.env.ALDUINAK_TEST_SERVER_DIR || path.join(repoRoot, 'build', 'dist', 'testserver')
const testServerSettings = process.env.ALDUINAK_TEST_SERVER_SETTINGS || path.join(testServerDir, 'server-settings.json')

module.exports = {
  repoRoot,
  logDir:   process.env.ALDUINAK_LOG_DIR || 'C:\\logs',
  nssm:     nssmPath(),

  // Build output directory. Holds dist/ (the CI-built client/server payloads the
  // launcher and game server consume) and launcher/ (the Electron installer).
  buildDir: process.env.ALDUINAK_BUILD_DIR || path.join(repoRoot, 'build'),

  // Console tab containers, left to right; a service's group decides which one lists it
  groups: [
    { key: 'backend', label: loc('services.backend') },
    { key: 'mongo',   label: loc('services.mongo') },
    { key: 'main',    label: loc('servers.main') },
    { key: 'test',    label: loc('servers.test') },
  ],

  // nssm services. `key` is the short label shown in the UI; `name` is the
  // actual Windows service. Order is the start order (stop order is reversed).
  // Renamed services: migrate the live box by re-running build/dist/server/install-services.bat
  // legacyNames are pre-rename service names the manager falls back to until then.
  // logFiles: logs nssm does not know (MongoDB is a plain Windows service)
  // The one MongoDB instance serves both game servers (databases skymp and skymp_test) and the backend
  services: [
    { key: 'mongo',        name: 'AlduinakMongo',       legacyNames: [],                                label: loc('services.mongo'), group: 'mongo',   logFiles: [mongoLogFile('mongod.cfg', 'C:\\Alduinak\\mongodb\\log\\mongod.log')] },
    { key: 'nginx',        name: 'AlduinakNginx',       legacyNames: ['SkyrpNginx', 'SkyMPNginx'],      label: loc('services.nginx'), group: 'backend', accessLog: 'C:\\nginx\\logs\\access.log' },
    { key: 'backend',      name: 'AlduinakBackend',     legacyNames: ['SkyrpBackend', 'SkyRP-Backend'], label: loc('services.backend'), group: 'backend' },
    { key: 'livekit',      name: 'AlduinakLiveKit',     legacyNames: [],                                label: loc('services.livekit'), group: 'main' },
    { key: 'game',         name: 'AlduinakGameServer',  legacyNames: ['SkyrpGameServer'],               label: loc('services.game'), group: 'main' },
    { key: 'test-livekit', name: 'AlduinakLiveKitTest', legacyNames: [],                                label: loc('services.livekit'), group: 'test' },
    { key: 'test-game',    name: 'AlduinakTestServer',  legacyNames: [],                                label: loc('services.game'), group: 'test' },
  ],

  // The two game servers: live receives files only through the Migrate box, every build targets buildProfile.
  // files: this profile's manifest set under paths.dataDir; versionsPrefix: its keys in versions.json
  profiles: {
    live: {
      key: 'live', label: loc('servers.main'), backendId: 'alduinak',
      serverDir, serverSettings,
      clientOut: path.join(repoRoot, 'build', 'dist', 'client'),
      services: { game: 'game', mongo: 'mongo', livekit: 'livekit' },
      files: { manifest: 'manifest.json', prevManifest: 'manifest.json.prev', diff: 'manifest-diff.json', stamp: 'data-sync.json', modlist: 'modlist.json' },
      extrasDir: 'extras', versionsPrefix: '',
      get relayPort() { return relayPort('WS_PORT', 7778) },
      // chat.log lives wherever the gamemode writes it: env var, then the logDir key of server-settings.json, then the default
      get logDir() { return process.env.ALDUINAK_LOG_DIR || readServerSetting('logDir', serverSettings) || 'C:\\logs' },
    },
    test: {
      key: 'test', label: loc('servers.test'), backendId: 'test',
      serverDir: testServerDir, serverSettings: testServerSettings,
      clientOut: path.join(repoRoot, 'build', 'dist', 'testclient'),
      services: { game: 'test-game', mongo: 'mongo', livekit: 'test-livekit' },
      files: { manifest: 'manifest-test.json', prevManifest: 'manifest-test.json.prev', diff: 'manifest-diff-test.json', stamp: 'data-sync-test.json', modlist: 'modlist-test.json' },
      extrasDir: 'extras-test', versionsPrefix: 'test.',
      // The live port here would put the test console on the live game
      get relayPort() { const p = relayPort('WS_PORT_TEST', 7779); return p === relayPort('WS_PORT', 7778) ? NaN : p },
      get logDir() { return readServerSetting('logDir', testServerSettings) || 'C:\\logs\\test' },
    },
  },
  buildProfile: 'test',

  // Reference MO2 install used to compile the manifest (the Modlist tab).
  mo2Root:  process.env.ALDUINAK_MO2_ROOT  || 'C:\\MO2',
  gameRoot: process.env.ALDUINAK_GAME_ROOT || 'C:\\GOG Games\\Skyrim Anniversary Edition',
  profile:  process.env.ALDUINAK_MO2_PROFILE || 'Alduinak',

  // Live server paths; the modules that stay live-only (players, security, playtime, agent) read these
  paths: {
    launcher:     path.join(repoRoot, 'skymp5-launcher-tauri'),
    gamemode:     path.join(repoRoot, 'gamemode'),
    backend:      path.join(repoRoot, 'skymp5-backend'),
    front:        path.join(repoRoot, 'skymp5-front'),
    client:       path.join(repoRoot, 'skymp5-client'),
    server:       path.join(repoRoot, 'skymp5-server'),
    launcherPkg:  path.join(repoRoot, 'skymp5-launcher-tauri', 'src-tauri', 'tauri.conf.json'),
    clientPkg:    path.join(repoRoot, 'skymp5-client', 'package.json'),
    serverPkg:    path.join(repoRoot, 'skymp5-server', 'package.json'),
    backendEnv:   path.join(repoRoot, 'skymp5-backend', '.env'),
    backendEnvExample: path.join(repoRoot, 'skymp5-backend', '.env.example'),
    // The deployed game server's settings (holds secrets; not in the repo).
    serverSettings,
    // The game server's working directory: its file-database (changeForms)
    // and data dir live here. Defaults to the folder holding server-settings.json.
    serverDir,
    launcherOut:  path.join(repoRoot, 'build', 'launcher'),
    clientOut:    path.join(repoRoot, 'build', 'dist', 'client'),
    dataDir:      path.join(repoRoot, 'skymp5-backend', 'data'),
  },

  // Local backend master API: the port from the backend .env, the key and token from server-settings.json
  backendApi: {
    get port()  { return parseInt(readEnv('PORT') || '4000', 10) },
    get key()   { return readServerSetting('masterKey') },
    get token() { return readServerSetting('masterApiAuthToken') },
  },

  // WS relay link for the Console command box (read live from the backend .env).
  relay: {
    get port()   { return relayPort('WS_PORT', 7778) },
    // No fallback secret: when RELAY_SECRET is unset the relay must fail auth
    // rather than silently authenticate with a well-known default.
    get secret() { return readEnv('RELAY_SECRET') },
  },

  // AlduinakManager agent: loopback port, backend shared secret, and the folder for its lock, jobs, audit and schedule.json (read live from the backend .env)
  agent: {
    serviceName: 'AlduinakManager',
    get port()   { return parseInt(readEnv('MANAGER_AGENT_PORT') || '4003', 10) },
    get secret() { return readEnv('MANAGER_AGENT_SECRET') },
    get dir()    { return readEnv('MANAGER_LOG_DIR') || path.join(module.exports.logDir, 'manager') },
  },

  // Backend audit logs (ban.log, faction.log), mirroring auditLog.js
  get auditLogDir() { return readEnv('BAN_LOG_DIR') || module.exports.logDir },

  // GitHub Actions dispatch for the CI Rebuild button (needs a PAT with actions:write).
  // token is a getter so a PAT saved on the Settings tab works without a manager restart.
  github: {
    get token() { return process.env.ALDUINAK_GH_TOKEN || readEnv('ALDUINAK_GH_TOKEN') },
    repo:     process.env.ALDUINAK_GH_REPO || 'Alduinak-RP/alduinak',
    workflow: process.env.ALDUINAK_GH_WORKFLOW || 'dist-windows-flatrim.yml',
    ref:      process.env.ALDUINAK_GH_REF || 'main',
  },

  launcherArtifact: 'AlduinakLauncher.exe',
}
