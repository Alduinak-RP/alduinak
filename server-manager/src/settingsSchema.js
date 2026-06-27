'use strict'

const serverSettings = [
  // Identity
  { key: 'name',        label: 'Server name',  type: 'text',   group: 'Identity', help: 'Public name shown in the launcher / master list.' },
  { key: 'port',        label: 'Game port (UDP)', type: 'number', group: 'Identity', help: 'RakNet game port.' },
  { key: 'maxPlayers',  label: 'Max players',  type: 'number', group: 'Identity' },
  { key: 'lang',        label: 'Language',     type: 'select', group: 'Identity',
    options: ['english', 'russian', 'german', 'french', 'spanish', 'italian', 'polish', 'chinese', 'japanese'] },

  // Networking
  { key: 'listenHost',   label: 'Listen host',    type: 'text', group: 'Networking', placeholder: '0.0.0.0', help: 'Bind address for game (RakNet) traffic.' },
  { key: 'uiListenHost', label: 'UI listen host', type: 'text', group: 'Networking', placeholder: '0.0.0.0', help: 'Bind address for the HTTP/UI port.' },
  { key: 'ip',           label: 'Advertised IP',  type: 'text', group: 'Networking', help: 'Public IP advertised to clients (NAT).' },

  // Mode & auth
  { key: 'offlineMode', label: 'Offline mode',  type: 'bool', group: 'Mode & auth', help: 'When on, any profile id may connect; master/masterKey are ignored.' },
  { key: 'master',      label: 'Master URL',    type: 'text', group: 'Mode & auth', help: 'Master API URL for online-mode session validation. Empty = offline.' },
  { key: 'masterKey',   label: 'Master key',    type: 'secret', group: 'Mode & auth', help: 'Shared secret; must match the backend SERVER_MASTER_KEY.' },
  { key: 'masterApiAuthToken', label: 'Master API auth token', type: 'secret', group: 'Mode & auth', help: 'Must match the backend MASTER_API_AUTH_TOKEN.' },
  { key: 'enableConsoleCommandsForAll', label: 'Console commands for all', type: 'bool', group: 'Mode & auth', help: 'Allow every player to run console commands (testing only — dangerous).' },

  // Gameplay
  { key: 'characterSelect',         label: 'Character select',      type: 'bool',   group: 'Gameplay', help: 'Show the character-select screen on join.' },
  { key: 'npcEnabled',              label: 'NPCs enabled',          type: 'bool',   group: 'Gameplay' },
  { key: 'isPapyrusHotReloadEnabled', label: 'Papyrus hot reload',  type: 'bool',   group: 'Gameplay', help: 'Reload compiled .pex scripts on change.' },
  { key: 'enableGamemodeDataUpdatesBroadcast', label: 'Broadcast gamemode updates', type: 'bool', group: 'Gameplay', help: 'Push gamemode script updates to connected clients.' },
  { key: 'locale',                  label: 'Locale file',           type: 'text',   group: 'Gameplay', help: 'File in data/localization (no .json) for M.GetText().' },

  // Data & storage
  { key: 'dataDir',        label: 'Data directory', type: 'text',   group: 'Data & storage', placeholder: 'data', help: 'ESMs / ESPs / UI / scripts.' },
  { key: 'gamemodePath',   label: 'Gamemode path',  type: 'text',   group: 'Data & storage', placeholder: './gamemode.js' },
  { key: 'databaseDriver', label: 'Database driver', type: 'select', group: 'Data & storage', options: ['file', 'mongodb', 'zip', 'migration'] },
  { key: 'databaseName',   label: 'Database name',   type: 'text',   group: 'Data & storage', placeholder: 'world', help: 'File DB folder / Mongo db name. Characters live in <name>/changeForms.' },

  // Complex / nested (rendered as JSON sub-editors)
  { key: 'loadOrder',     label: 'Load order',     type: 'json', group: 'Advanced', help: 'Array of ESM/ESP filenames in order.' },
  { key: 'archives',      label: 'BSA archives',   type: 'json', group: 'Advanced', help: 'Array of BSA filenames to load.' },
  { key: 'startPoints',   label: 'Start points',   type: 'json', group: 'Advanced', help: 'Spawn points: [{ pos:[x,y,z], worldOrCell, angleZ }].' },
  { key: 'reloot',        label: 'Reloot timers',  type: 'json', group: 'Advanced', help: 'Record type → ms before respawn.' },
  { key: 'forbiddenReloot', label: 'Forbidden reloot', type: 'json', group: 'Advanced', help: 'Record types that never respawn.' },
  { key: 'npcSettings',   label: 'NPC settings',   type: 'json', group: 'Advanced' },
  { key: 'metricsAuth',   label: 'Metrics auth',   type: 'json', group: 'Advanced', help: '{ user, password } for /metrics basic auth.' },
  { key: 'damageMultFormulaSettings', label: 'Damage formula', type: 'json', group: 'Advanced' },
  { key: 'additionalServerSettings',  label: 'Additional settings (GitHub)', type: 'json', group: 'Advanced' },
  { key: 'discordAuth',   label: 'Discord auth',   type: 'json', group: 'Advanced', help: 'Discord bot integration: { botToken, guilds:[{ guildId, banRoleId, eventLogChannelId }] }. Holds a bot token — keep it secret.' },
]

// backend .env — the Express backend configuration. `secret: true` masks the value.
const backendEnv = [
  // HTTP / relay
  { key: 'PORT',         label: 'HTTP port',       type: 'number', group: 'HTTP & relay', help: 'Express backend listen port.' },
  { key: 'WS_PORT',      label: 'WS relay port',   type: 'number', group: 'HTTP & relay', help: 'In-game chat + admin console relay.' },
  { key: 'RELAY_SECRET', label: 'Relay secret',    type: 'secret', group: 'HTTP & relay', help: 'Shared between the relay, the gamemode, and this manager.' },

  // Game server connection
  { key: 'SKYMP_HOST',     label: 'Game server host', type: 'text',   group: 'Game server', placeholder: '127.0.0.1' },
  { key: 'SKYMP_PORT',     label: 'Game server port (UDP)', type: 'number', group: 'Game server' },
  { key: 'SERVER_ADDRESS', label: 'Public address',   type: 'text',   group: 'Game server', help: 'Public IP advertised to external clients.' },

  // Server metadata (reported to the launcher)
  { key: 'SERVER_NAME',        label: 'Server name',      type: 'text',   group: 'Server metadata', help: 'Keep in sync with server-settings.json name.' },
  { key: 'SERVER_MAX_PLAYERS', label: 'Max players',      type: 'number', group: 'Server metadata' },
  { key: 'SERVER_OFFLINE_MODE', label: 'Offline mode',    type: 'bool',   group: 'Server metadata', help: 'Must match server-settings.json offlineMode.' },
  { key: 'SERVER_NPC_ENABLED', label: 'NPCs enabled',     type: 'bool',   group: 'Server metadata' },
  { key: 'SERVER_GAMEMODE',    label: 'Gamemode label',   type: 'text',   group: 'Server metadata', placeholder: 'Roleplay' },
  { key: 'CLIENT_VERSION',     label: 'Client version',   type: 'text',   group: 'Server metadata', help: 'Set automatically by the Build tab.' },

  // Master API
  { key: 'SERVER_MASTER_KEY',      label: 'Master key',         type: 'secret', group: 'Master API', help: 'Must match server-settings.json masterKey.' },
  { key: 'MASTER_URL',             label: 'Master URL',         type: 'text',   group: 'Master API' },
  { key: 'MASTER_API_AUTH_TOKEN',  label: 'Master API auth token', type: 'secret', group: 'Master API' },

  // Discord OAuth & bot
  { key: 'DISCORD_CLIENT_ID',     label: 'Discord client ID',     type: 'text',   group: 'Discord' },
  { key: 'DISCORD_CLIENT_SECRET', label: 'Discord client secret', type: 'secret', group: 'Discord' },
  { key: 'DISCORD_REDIRECT_URI',  label: 'Discord redirect URI',  type: 'text',   group: 'Discord' },
  { key: 'DISCORD_BOT_TOKEN',     label: 'Discord bot token',     type: 'secret', group: 'Discord' },
  { key: 'DISCORD_GUILD_ID',      label: 'Discord guild ID',      type: 'text',   group: 'Discord' },

  // Admin dashboard
  { key: 'DASHBOARD_PORT',        label: 'Dashboard port',        type: 'number', group: 'Admin dashboard' },
  { key: 'DASHBOARD_PUBLIC_URL',  label: 'Dashboard public URL',  type: 'text',   group: 'Admin dashboard' },
  { key: 'DASHBOARD_API_BASE_URL', label: 'Dashboard API base URL', type: 'text', group: 'Admin dashboard' },
  { key: 'DISCORD_DASHBOARD_REDIRECT_URI', label: 'Dashboard redirect URI', type: 'text', group: 'Admin dashboard' },
  { key: 'DASHBOARD_DISCORD_IDS', label: 'Dashboard Discord IDs', type: 'text',   group: 'Admin dashboard', help: 'Comma-separated Discord user IDs.' },
  { key: 'WEBSITE_URL',           label: 'Website URL',           type: 'text',   group: 'Admin dashboard' },
  { key: 'ADMIN_URL',             label: 'Admin service URL',     type: 'text',   group: 'Admin dashboard', help: 'Local SkyMP-Admin service — never expose publicly.' },
  { key: 'ADMIN_TOKEN',           label: 'Admin token',           type: 'secret', group: 'Admin dashboard' },

  // Metrics
  { key: 'METRICS_USER',     label: 'Metrics user',     type: 'text',   group: 'Metrics' },
  { key: 'METRICS_PASSWORD', label: 'Metrics password', type: 'secret', group: 'Metrics' },

  // Access control
  { key: 'SERVER_LOCKED',          label: 'Server locked',     type: 'bool', group: 'Access control', help: 'Only allowed roles/users may join when on.' },
  { key: 'SERVER_LOCKED_ROLE_IDS', label: 'Locked role IDs',   type: 'text', group: 'Access control', help: 'Comma-separated Discord role IDs.' },
  { key: 'SERVER_LOCKED_ALLOW',    label: 'Locked allow list', type: 'text', group: 'Access control', help: 'Comma-separated Discord user IDs (legacy).' },
  { key: 'WHITELIST_ROLE_ID',      label: 'Whitelist role ID', type: 'text', group: 'Access control', help: 'Discord role used as the gameplay whitelist.' },
  { key: 'BANNED_ROLE_ID',         label: 'Banned role ID',    type: 'text', group: 'Access control' },

  // Client updates
  { key: 'GITHUB_WEBHOOK_SECRET', label: 'GitHub webhook secret', type: 'secret', group: 'Client updates' },
  { key: 'CLIENT_BRANCH',         label: 'Client branch',         type: 'text',   group: 'Client updates', placeholder: 'refs/heads/main' },
]

module.exports = { serverSettings, backendEnv }
