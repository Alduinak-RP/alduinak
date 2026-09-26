// Backend server configuration; all values come from env vars (.env for local dev, real env in production)
// Must run before any process.env read below: this module snapshots the env at load time
require('dotenv').config()

const path = require('path')

const SKYMP_PORT = parseInt(process.env.SKYMP_PORT || '7777', 10)

const config = module.exports = {
  // Client files bucket
  clientFilesDir: process.env.CLIENT_FILES_DIR
    || path.join(__dirname, '..', 'build', 'client-files'),

  // Game server connection (used for status checks and metrics)
  skyrimServerHost: process.env.SKYMP_HOST || '127.0.0.1',
  skyrimServerPort: SKYMP_PORT,
  skyrimServerAddress: process.env.SERVER_ADDRESS || process.env.SKYMP_HOST || '127.0.0.1',

  // UI/metrics port: defaults to 3000 for the standard 7777 game port, else game port + 1.
  skympUiPort: parseInt(process.env.SKYMP_UI_PORT, 10) || (SKYMP_PORT === 7777 ? 3000 : SKYMP_PORT + 1),

  // Server metadata (returned by /api/serverinfo and /api/servers)
  serverName:       process.env.SERVER_NAME        || 'SkyMP Server',
  serverMaxPlayers: parseInt(process.env.SERVER_MAX_PLAYERS || '100', 10),
  serverOfflineMode: process.env.SERVER_OFFLINE_MODE === 'true',
  serverNpcEnabled:  process.env.SERVER_NPC_ENABLED  === 'true',
  serverGamemode:    process.env.SERVER_GAMEMODE     || null,
  // Master API: used by the SkyMP client for online-mode auth; ignored by the launcher in offline mode
  serverMasterKey:    process.env.SERVER_MASTER_KEY    || '',
  masterUrl:          process.env.MASTER_URL           || 'https://api.alduinak.com/',
  masterApiAuthToken: process.env.MASTER_API_AUTH_TOKEN || '',

  // Discord OAuth (launcher login)
  discordClientId:     process.env.DISCORD_CLIENT_ID     || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  // Redirect URI registered in the Discord application settings
  discordRedirectUri:  process.env.DISCORD_REDIRECT_URI  || 'http://localhost:4000/api/users/login-discord/callback',
  // Optional Rich Presence application id handed to launchers through /api/serverinfo
  discordPresenceAppId: process.env.DISCORD_PRESENCE_APP_ID || '',

  // Metrics HTTP auth (Basic auth for the game server's /metrics endpoint)
  metricsUser:     process.env.METRICS_USER     || '',
  metricsPassword: process.env.METRICS_PASSWORD || '',

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

  // Server lockdown: when true only holders of a serverLockedRoleIds role or serverLockedAllowList IDs can connect; data/server-access.json overrides these
  serverLocked:          process.env.SERVER_LOCKED === 'true',
  // Comma-separated list of Discord snowflake IDs that may still connect.
  serverLockedAllowList: (process.env.SERVER_LOCKED_ALLOW || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Comma-separated Discord role IDs that may connect while SERVER_LOCKED=true.
  serverLockedRoleIds: (process.env.SERVER_LOCKED_ROLE_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Discord role used as the gameplay whitelist; when set it replaces data/whitelist.json as the source of truth for who may join
  whitelistRoleId: process.env.WHITELIST_ROLE_ID || '',

  // Discord role used as the gameplay ban list. Users with this role cannot join.
  bannedRoleId: process.env.BANNED_ROLE_ID || process.env.BAN_ROLE_ID || '',
}

// Game servers, main first; each is known by its public master key (serverinfo, manifest, heartbeat, master API)
// settingsPath: that server's server-settings.json, whose "access" block holds its lock, whitelist and staff-only rules
const REPO_ROOT = require('path').join(__dirname, '..')
config.servers = [{
  id: 'alduinak', name: config.serverName, host: config.skyrimServerHost, address: config.skyrimServerAddress,
  port: config.skyrimServerPort, uiPort: config.skympUiPort, masterKey: config.serverMasterKey,
  settingsPath: process.env.SERVER_SETTINGS_PATH || require('path').join(REPO_ROOT, 'build', 'dist', 'server', 'server-settings.json'),
}]

// The test server is listed only when TEST_SERVER_PORT and TEST_SERVER_MASTER_KEY are set and clash with nothing live
const TEST_PORT = parseInt(process.env.TEST_SERVER_PORT, 10) || 0
const TEST_KEY  = process.env.TEST_SERVER_MASTER_KEY || ''
if (TEST_PORT && TEST_KEY) {
  const test = {
    id: 'test', name: process.env.TEST_SERVER_NAME || 'Test Server', host: config.skyrimServerHost,
    address: process.env.TEST_SERVER_ADDRESS || config.skyrimServerAddress,
    port: TEST_PORT, uiPort: parseInt(process.env.TEST_SERVER_UI_PORT, 10) || TEST_PORT + 1, masterKey: TEST_KEY,
    settingsPath: process.env.TEST_SERVER_SETTINGS_PATH || require('path').join(REPO_ROOT, 'testserver', 'server-settings.json'),
    // Reads live backend state but never writes it, and admits only staff-only role holders (none set: nobody)
    readOnly: true,
    staffOnly: true,
    roleIds: (process.env.TEST_SERVER_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  }
  const live = [config.skyrimServerPort, config.skympUiPort]
  if (TEST_KEY === config.serverMasterKey) console.warn('[config] TEST_SERVER_MASTER_KEY equals SERVER_MASTER_KEY: test server not listed')
  else if (live.includes(test.port) || live.includes(test.uiPort)) console.warn(`[config] test server ports ${test.port}/${test.uiPort} collide with the live server (${live.join('/')}): test server not listed`)
  else config.servers.push(test)
}

config.serverByKey = key => (key && config.servers.find(s => s.masterKey === key)) || null
config.serverById  = id => config.servers.find(s => s.id === id) || null
