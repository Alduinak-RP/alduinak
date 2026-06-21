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
    return m ? m[1].trim() : ''
  } catch { return '' }
}

module.exports = {
  repoRoot,
  logDir:   process.env.SKYRP_LOG_DIR || 'C:\\logs',
  nssm:     nssmPath(),

  // nssm services, in start order (stop order is the reverse).
  services: ['SkyrpNginx', 'SkyrpBackend', 'SkyrpGameServer'],

  // Reference MO2 install used to compile the manifest (the Modlist tab).
  mo2Root:  process.env.SKYRP_MO2_ROOT  || 'C:\\MO2',
  gameRoot: process.env.SKYRP_GAME_ROOT || 'C:\\GOG Games\\Skyrim Anniversary Edition',
  profile:  process.env.SKYRP_MO2_PROFILE || 'Default',

  paths: {
    launcher:     path.join(repoRoot, 'skymp5-launcher'),
    backend:      path.join(repoRoot, 'skymp5-backend'),
    front:        path.join(repoRoot, 'skymp5-front'),
    client:       path.join(repoRoot, 'skymp5-client'),
    server:       path.join(repoRoot, 'skymp5-server'),
    launcherPkg:  path.join(repoRoot, 'skymp5-launcher', 'package.json'),
    clientPkg:    path.join(repoRoot, 'skymp5-client', 'package.json'),
    versionRoute: path.join(repoRoot, 'skymp5-backend', 'routes', 'version.js'),
    backendEnv:   path.join(repoRoot, 'skymp5-backend', '.env'),
    // The deployed game server's settings (holds secrets; not in the repo).
    serverSettings: process.env.SKYRP_SERVER_SETTINGS
      || path.join(repoRoot, 'build', 'dist', 'server', 'server-settings.json'),
    launcherOut:  path.join(repoRoot, 'build', 'launcher'),
    frontConfig:  path.join(repoRoot, 'skymp5-front', 'config.js'),
    dataDir:      path.join(repoRoot, 'skymp5-backend', 'data'),
  },

  // WS relay link for the Console command box (read live from the backend .env).
  relay: {
    get port()   { return parseInt(readEnv('WS_PORT') || '7778', 10) },
    get secret() { return readEnv('RELAY_SECRET') || 'dev-relay-secret' },
  },

  launcherArtifact: 'SkyrimRoleplayLauncher.exe',
}
