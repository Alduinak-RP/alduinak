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
  { key: 'enableConsoleCommandsForAll', label: 'Console commands for all', type: 'bool', group: 'Mode & auth', help: 'Allow every player to run console commands (testing only - dangerous).' },

  // Gameplay
  { key: 'characterSelect',         label: 'Character select',      type: 'bool',   group: 'Gameplay', help: 'Show the character-select screen on join.' },
  { key: 'characterSelectMaxCharacters', label: 'Max characters',   type: 'number', group: 'Gameplay', help: 'Character slots per player when character select is on (1-10, default 3).' },
  { key: 'npcEnabled',              label: 'NPCs enabled',          type: 'bool',   group: 'Gameplay' },
  { key: 'isPapyrusHotReloadEnabled', label: 'Papyrus hot reload',  type: 'bool',   group: 'Gameplay', help: 'Reload compiled .pex scripts on change.' },
  { key: 'enableGamemodeDataUpdatesBroadcast', label: 'Broadcast gamemode updates', type: 'bool', group: 'Gameplay', help: 'Push gamemode script updates to connected clients.' },
  { key: 'locale',                  label: 'Locale file',           type: 'text',   group: 'Gameplay', help: 'File in data/localization (no .json) for M.GetText().' },
  { key: 'manaclesFormId',          label: 'Manacles item',         type: 'text',   group: 'Gameplay', help: 'Form id (number or "0x..." string) of the item a captor must hold to restrain a player. Defaults to vanilla prisoner cuffs 0x0005DC02.' },
  { key: 'captiveAnimEvent',        label: 'Captive anim event',    type: 'text',   group: 'Gameplay', help: 'Behaviour-graph event played on a restrained player. Leave empty for the default bound-hands pose.' },
  { key: 'carrierAnimEvent',        label: 'Carrier anim event',    type: 'text',   group: 'Gameplay', help: 'Behaviour-graph event played on a player carrying someone. Leave empty for the default hold pose.' },
  { key: 'startingItems',           label: 'Starting items',        type: 'json',   group: 'Gameplay', help: 'Kit granted to fresh characters: [{ baseId, count }]. baseId as a number or "0x..." string. Gold (0x0000000f) is granted once per slot.' },
  { key: 'logoutGraceMs',           label: 'Logout grace (ms)',     type: 'number', group: 'Gameplay', help: 'How long a disconnected body stays killable in the world before despawning. Default 300000.' },
  { key: 'respawnSeconds',          label: 'Respawn seconds',       type: 'number', group: 'Gameplay', help: 'Bleedout/respawn timer applied to players (gamemode). Default 15.' },
  { key: 'chatRanges',              label: 'Chat ranges',           type: 'json',   group: 'Gameplay', help: 'Audible ranges in game units: { whisper, low, say, wide, shout }. Provided keys override the defaults.' },
  { key: 'maskName',                label: 'Mask name',             type: 'text',   group: 'Gameplay', help: 'Name shown for a /mask-ed player. Default "Masked Person".' },
  { key: 'introduceCooldownMs',     label: 'Introduce cooldown (ms)', type: 'number', group: 'Gameplay', help: 'Min gap between /introduce prompts to the same target. Default 10000.' },

  // Interactions (capture / carry / search / trade tunables)
  { key: 'captureInteractMaxDistance', label: 'Capture range',                 type: 'number', group: 'Interactions', help: 'Max game-units distance to start a capture/carry. Default 256.' },
  { key: 'captureConsentTimeoutMs',    label: 'Capture consent timeout (ms)',  type: 'number', group: 'Interactions', help: 'How long a capture/carry consent prompt waits for an answer. Default 20000.' },
  { key: 'captureConsentCooldownMs',   label: 'Capture consent cooldown (ms)', type: 'number', group: 'Interactions', help: 'Min gap before prompting the same target again. Default 15000.' },
  { key: 'tradeMaxDistance',           label: 'Trade range',                   type: 'number', group: 'Interactions', help: 'Max game-units distance both players must stay within to trade. Default 1024.' },
  { key: 'tradeInviteTtlMs',           label: 'Trade invite TTL (ms)',         type: 'number', group: 'Interactions', help: 'Pending trade invites auto-cancel after this. Default 60000.' },
  { key: 'tradeInviteCooldownMs',      label: 'Trade invite cooldown (ms)',    type: 'number', group: 'Interactions', help: 'Min gap between trade invites per initiator to target. Default 30000.' },
  { key: 'searchStartMaxDistance',     label: 'Search start range',            type: 'number', group: 'Interactions', help: 'Max game-units distance to start searching a player. Default 256.' },
  { key: 'searchKeepMaxDistance',      label: 'Search keep range',             type: 'number', group: 'Interactions', help: 'The search window closes once the pair drift further apart than this. Default 512.' },
  { key: 'searchConsentTimeoutMs',     label: 'Search consent timeout (ms)',   type: 'number', group: 'Interactions', help: 'How long a search consent prompt waits for an answer. Default 20000.' },
  { key: 'searchConsentCooldownMs',    label: 'Search consent cooldown (ms)',  type: 'number', group: 'Interactions', help: 'Min gap before prompting the same target again. Default 15000.' },

  // Data & storage
  { key: 'dataDir',        label: 'Data directory', type: 'text',   group: 'Data & storage', placeholder: 'data', help: 'ESMs / ESPs / UI / scripts.' },
  { key: 'gamemodePath',   label: 'Gamemode path',  type: 'text',   group: 'Data & storage', placeholder: './gamemode.js' },
  { key: 'databaseDriver', label: 'Database driver', type: 'select', group: 'Data & storage', options: ['file', 'mongodb', 'zip', 'migration'] },
  { key: 'databaseName',   label: 'Database name',   type: 'text',   group: 'Data & storage', placeholder: 'world', help: 'File DB folder / Mongo db name. Characters live in <name>/changeForms.' },
  { key: 'logDir',         label: 'Log directory',   type: 'text',   group: 'Data & storage', placeholder: 'C:\\logs', help: 'Where chat.log and service logs are written. Overridden by the ALDUINAK_LOG_DIR env var.' },

  // Complex / nested (rendered as JSON sub-editors)
  { key: 'loadOrder',     label: 'Load order',     type: 'json', group: 'Advanced', help: 'Array of ESM/ESP filenames in order.' },
  { key: 'archives',      label: 'BSA archives',   type: 'json', group: 'Advanced', help: 'Array of BSA filenames to load.' },
  { key: 'startPoints',   label: 'Start points',   type: 'json', group: 'Advanced', help: 'Spawn points: [{ pos:[x,y,z], worldOrCell, angleZ }].' },
  { key: 'reloot',        label: 'Reloot timers',  type: 'json', group: 'Advanced', help: 'Record type → ms before respawn.' },
  { key: 'forbiddenReloot', label: 'Forbidden reloot', type: 'json', group: 'Advanced', help: 'Record types that never respawn.' },
  { key: 'blockedSpells',  label: 'Blocked spells',  type: 'json', group: 'Advanced', help: 'Spell form ids players may not cast (numbers or "0x..." strings), e.g. racial powers.' },
  { key: 'adminProfileIds', label: 'Admin profile IDs', type: 'json', group: 'Advanced', help: 'Master-api profile ids granted in-game admin chat commands. Array of numbers.' },
  { key: 'npcSettings',   label: 'NPC settings',   type: 'json', group: 'Advanced' },
  { key: 'metricsAuth',   label: 'Metrics auth',   type: 'json', group: 'Advanced', help: '{ user, password } for /metrics basic auth.' },
  { key: 'damageMultFormulaSettings', label: 'Damage formula', type: 'json', group: 'Advanced' },
  { key: 'additionalServerSettings',  label: 'Additional settings (GitHub)', type: 'json', group: 'Advanced' },
  { key: 'discordAuth',   label: 'Discord auth',   type: 'json', group: 'Advanced', help: 'Discord bot integration: { botToken, guilds:[{ guildId, banRoleId, eventLogChannelId }] }. Holds a bot token - keep it secret.' },
]

// backend .env - the Express backend configuration. `secret: true` masks the value.
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
  { key: 'ADMIN_URL',             label: 'Admin service URL',     type: 'text',   group: 'Admin dashboard', help: 'Local SkyMP-Admin service - never expose publicly.' },
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
