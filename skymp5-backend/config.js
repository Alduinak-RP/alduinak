// Backend server configuration; all values come from env vars (.env for local dev, real env in production)
// Must run before any process.env read below: this module snapshots the env at load time
require('dotenv').config()

const fs   = require('fs')
const path = require('path')

// A game server's server-settings.json, re-read whenever it changes on disk
const settingsCache = new Map()
function readSettings(file) {
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch { return {} }
  const hit = settingsCache.get(file)
  if (hit && hit.mtime === mtime) return hit.data
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  settingsCache.set(file, { mtime, data })
  return data
}

const config = module.exports = {
  // Client files bucket
  clientFilesDir: process.env.CLIENT_FILES_DIR
    || path.join(__dirname, '..', 'build', 'client-files'),

  // Where the game servers run (status checks and metrics) and the address players connect to
  skyrimServerHost: process.env.SKYMP_HOST || '127.0.0.1',
  skyrimServerAddress: process.env.SERVER_ADDRESS || process.env.SKYMP_HOST || '127.0.0.1',
  serverGamemode: process.env.SERVER_GAMEMODE || null,

  // Discord OAuth (launcher login)
  discordClientId:     process.env.DISCORD_CLIENT_ID     || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  // Redirect URI registered in the Discord application settings
  discordRedirectUri:  process.env.DISCORD_REDIRECT_URI  || 'http://localhost:4000/api/users/login-discord/callback',
  // Optional Rich Presence application id handed to launchers through /api/serverinfo
  discordPresenceAppId: process.env.DISCORD_PRESENCE_APP_ID || '',

  // Refuse game-server connections whose launcher didn't verify client files + load order; set LAUNCH_CHECK_ENFORCE=false to disable (e.g. for launcher builds predating the check)
  launchCheckEnforce: process.env.LAUNCH_CHECK_ENFORCE !== 'false',
  // false still admits the 24h session token in the game login (launchers before 3.1.0)
  playTokenEnforce: process.env.PLAY_TOKEN_ENFORCE !== 'false',

  // Dashboard auth
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '4002', 10),
  dashboardPublicUrl: process.env.DASHBOARD_PUBLIC_URL || 'http://localhost:4002',
  dashboardApiBaseUrl: process.env.DASHBOARD_API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,
  // Comma-separated Discord user IDs allowed to access the admin dashboard.
  dashboardDiscordIds: (process.env.DASHBOARD_DISCORD_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // OAuth redirect URI registered in the Discord application for the dashboard.
  discordDashboardRedirectUri: process.env.DISCORD_DASHBOARD_REDIRECT_URI
    || 'http://localhost:4000/auth/dashboard/callback',
  // Public URL of the website (used to redirect back after OAuth).
  websiteUrl: process.env.WEBSITE_URL || 'http://localhost:4001',

  // Discord bot (role-based access): token/guild used to fetch member roles at login; the bot needs "Server Members Intent" enabled in the Developer Portal
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordGuildId:  process.env.DISCORD_GUILD_ID  || '',
}

// A game server whose name, ports, keys and player cap are read live from its server-settings.json
function gameServer(id, settingsPath, extra = {}) {
  const settings = () => readSettings(settingsPath)
  const server = { id, settingsPath, host: config.skyrimServerHost, address: config.skyrimServerAddress, ...extra }
  const getters = {
    name:        () => settings().name || id,
    port:        () => settings().port || 7777,
    // SkyMP's UI/metrics port: 3000 for game port 7777, else game port + 1
    uiPort:      () => (server.port === 7777 ? 3000 : server.port + 1),
    masterKey:   () => settings().masterKey || '',
    maxPlayers:  () => settings().playerSlots || settings().maxPlayers || 100,
    offlineMode: () => settings().offlineMode === true,
    npcEnabled:  () => settings().npcEnabled === true,
    master:      () => settings().master || '',
    masterApiAuthToken: () => settings().masterApiAuthToken || '',
    metricsAuth: () => settings().metricsAuth || {},
    settings,
  }
  for (const [k, get] of Object.entries(getters)) Object.defineProperty(server, k, { get, enumerable: true })
  return server
}

// Game servers, main first; each is known by its public master key (serverinfo, manifest, heartbeat, master API)
const REPO_ROOT = path.join(__dirname, '..')
const main = gameServer('alduinak', process.env.SERVER_SETTINGS_PATH || path.join(REPO_ROOT, 'build', 'dist', 'server', 'server-settings.json'))
config.servers = [main]

// The master API token and URL are the main server's
Object.defineProperty(config, 'masterApiAuthToken', { get: () => main.masterApiAuthToken, enumerable: true })
Object.defineProperty(config, 'masterUrl', { get: () => main.master, enumerable: true })

// The test server is listed when its settings file exists with its own master key and ports; it reads live backend state but never writes it
const testSettings = process.env.TEST_SERVER_SETTINGS_PATH || path.join(REPO_ROOT, 'testserver', 'server-settings.json')
if (fs.existsSync(testSettings)) {
  const test = gameServer('test', testSettings, { readOnly: true, staffOnly: true })
  if (!test.masterKey || test.masterKey === main.masterKey) console.warn('[config] the test server has no master key of its own: test server not listed')
  else if ([main.port, main.uiPort].some(p => p === test.port || p === test.uiPort)) console.warn(`[config] test server ports ${test.port}/${test.uiPort} collide with the live server: test server not listed`)
  else config.servers.push(test)
}

config.serverByKey = key => (key && config.servers.find(s => s.masterKey === key)) || null
config.serverById  = id => config.servers.find(s => s.id === id) || null
