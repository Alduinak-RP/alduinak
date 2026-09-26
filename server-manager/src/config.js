'use strict'

// Server Manager configuration. The manager lives inside the repo, so the repo
// root is auto-detected (server-manager/src -> repo). Everything else has a
// sensible Windows default and can be overridden with an environment variable.

const path = require('path')
const fs   = require('fs')

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

function readServerSetting(key) {
  try { return JSON.parse(fs.readFileSync(serverSettings, 'utf8'))[key] || '' } catch { return '' }
}

const serverSettings = process.env.ALDUINAK_SERVER_SETTINGS
  || path.join(repoRoot, 'build', 'dist', 'server', 'server-settings.json')

module.exports = {
  repoRoot,
  logDir:   process.env.ALDUINAK_LOG_DIR || 'C:\\logs',
  nssm:     nssmPath(),

  // Build output directory. Holds dist/ (the CI-built client/server payloads the
  // launcher and game server consume) and launcher/ (the Electron installer).
  buildDir: process.env.ALDUINAK_BUILD_DIR || path.join(repoRoot, 'build'),

  // nssm services. `key` is the short label shown in the UI; `name` is the
  // actual Windows service. Order is the start order (stop order is reversed).
  // Keep this list in sync with SERVICES in src/renderer/renderer.js (the
  // renderer has its own copy of key/label and would show a stale set if they drift).
  // Renamed services: migrate the live box by re-running build/dist/server/install-services.bat
  // legacyNames are pre-rename service names the manager falls back to until then.
  services: [
    { key: 'nginx',   name: 'AlduinakNginx',      legacyNames: ['SkyrpNginx', 'SkyMPNginx'],      label: 'Nginx'    },
    { key: 'backend', name: 'AlduinakBackend',    legacyNames: ['SkyrpBackend', 'SkyRP-Backend'], label: 'Backend'  },
    { key: 'livekit', name: 'AlduinakLiveKit',    legacyNames: [],                                label: 'LiveKit'  },
    { key: 'game',    name: 'AlduinakGameServer', legacyNames: ['SkyrpGameServer'],               label: 'Game'     },
  ],

  // Reference MO2 install used to compile the manifest (the Modlist tab).
  mo2Root:  process.env.ALDUINAK_MO2_ROOT  || 'C:\\MO2',
  gameRoot: process.env.ALDUINAK_GAME_ROOT || 'C:\\GOG Games\\Skyrim Anniversary Edition',
  profile:  process.env.ALDUINAK_MO2_PROFILE || 'Alduinak',

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
    serverDir:    process.env.ALDUINAK_SERVER_DIR || path.dirname(serverSettings),
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
    get port()   { return parseInt(readEnv('WS_PORT') || '7778', 10) },
    // No fallback secret: when RELAY_SECRET is unset the relay must fail auth
    // rather than silently authenticate with a well-known default.
    get secret() { return readEnv('RELAY_SECRET') },
  },

  // AlduinakManager agent: loopback port, backend shared secret, and the folder for its lock, jobs and audit (read live from the backend .env)
  agent: {
    get port()   { return parseInt(readEnv('MANAGER_AGENT_PORT') || '4003', 10) },
    get secret() { return readEnv('MANAGER_AGENT_SECRET') },
    get dir()    { return readEnv('MANAGER_LOG_DIR') || path.join(module.exports.logDir, 'manager') },
  },

  // Daily game restart time (local HH:MM, or off), read live from the backend .env
  get autoRestartAt() { return readEnv('AUTO_RESTART_AT') || '04:00' },

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
