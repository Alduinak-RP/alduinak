'use strict'

const serverSettings = [
  // Identity
  { key: 'name',        label: 'Server name',  type: 'text',   group: 'Identity', help: 'Public name shown in the launcher / master list.' },
  { key: 'port',        label: 'Game port (UDP)', type: 'number', group: 'Identity', help: 'RakNet game port.' },
  { key: 'maxPlayers',  label: 'Max connections', type: 'number', group: 'Identity', help: 'RakNet connection cap including the queue room, at most the native MAX_PLAYERS (1300). To test the queue lower Play slots, never this: a connection above this number is refused before the queue sees it.' },
  { key: 'playerSlots', label: 'Play slots',   type: 'number', group: 'Identity', help: 'Verified logins that may play at once; logins above it wait in the queue up to Max connections. Empty = Max connections (queue off). Read at boot.' },
  { key: 'queueGraceMs', label: 'Queue grace (ms)', type: 'number', group: 'Identity', help: 'How long a disconnected player keeps their slot or queue place. Default 120000.' },
  { key: 'queueStaffBypass', label: 'Staff skip the queue', type: 'bool', group: 'Identity', help: 'On (default, also when unset): adminRoles tiers, adminRoleIds and adminProfileIds never wait. Turn off to test the queue with a staff account. Read at boot.' },
  { key: 'lang',        label: 'Language',     type: 'select', group: 'Identity',
    options: ['english', 'russian', 'german', 'french', 'spanish', 'italian', 'polish', 'chinese', 'japanese'] },

  // Networking
  { key: 'listenHost',   label: 'Listen host',    type: 'text', group: 'Networking', placeholder: '0.0.0.0', help: 'Bind address for game (RakNet) traffic.' },
  { key: 'uiListenHost', label: 'UI listen host', type: 'text', group: 'Networking', placeholder: '0.0.0.0', help: 'Bind address for the HTTP/UI port.' },
  { key: 'ip',           label: 'Advertised IP',  type: 'text', group: 'Networking', help: 'Public IP advertised to clients (NAT).' },

  // Mode & auth
  { key: 'offlineMode', label: 'Offline mode',  type: 'bool', group: 'Mode & auth', help: 'When on, any profile id may connect; master/masterKey are ignored.' },
  { key: 'master',      label: 'Master URL',    type: 'text', group: 'Mode & auth', help: 'Master API URL for online-mode session validation. Empty = offline.' },
  { key: 'masterKey',   label: 'Master key',    type: 'secret', group: 'Mode & auth', help: 'Public server id, not a secret: players receive it via /api/serverinfo and the launcher. Must match the backend SERVER_MASTER_KEY.' },
  { key: 'masterApiAuthToken', label: 'Master API auth token', type: 'secret', group: 'Mode & auth', help: 'Private secret sent as X-Auth-Token on heartbeats, bans and purchases. Must match the backend MASTER_API_AUTH_TOKEN.' },
  { key: 'enableConsoleCommandsForAll', label: 'Console commands for all (keep off)', type: 'bool', group: 'Mode & auth', help: 'Must stay off. The console is disabled on this server; turning this on skips the admin check and gives every player additem, placeatme and the other server console commands.' },

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
  { key: 'startingItems',           label: 'Starting items',        type: 'json',   group: 'Gameplay', help: 'Kit granted to fresh characters: [{ baseId, count }]. baseId as a number or "0x..." string. Gold (0x0000000f) is granted once per slot. Wearable kit items are equipped when character creation finishes.' },
  { key: 'playersInheritBaseSpells', label: 'Players inherit base spells', type: 'bool', group: 'Gameplay', help: 'On (default): player characters carry the Player record\'s castable spells (Flames, Healing) and their race\'s greater power. Off: characters start without them; abilities, racial passives, lesser powers (Night Eye) and spells learned from tomes stay. Read by the native server at boot.' },
  { key: 'logoutGraceMs',           label: 'Logout grace (ms)',     type: 'number', group: 'Gameplay', help: 'How long a disconnected body stays killable in the world before despawning. Default 300000.' },
  { key: 'respawnSeconds',          label: 'Respawn seconds',       type: 'number', group: 'Gameplay', help: 'Bleedout/respawn timer applied to players (gamemode). Default 15.' },
  { key: 'afkKickMinutes',          label: 'AFK kick (minutes)',    type: 'number', group: 'Gameplay', help: 'Minutes without movement, chat, or voice before an idle player is kicked. 0 disables. Default 20.' },
  { key: 'afkWarnMinutes',          label: 'AFK warning (minutes)', type: 'number', group: 'Gameplay', help: 'Minutes before the AFK kick to warn the player in chat. Default 2.' },
  { key: 'regenerationMultiplier',  label: 'Regen multiplier',      type: 'number', group: 'Gameplay', help: 'Scales the health/magicka/stamina regen the server accepts from clients. 1 = race-record rates, 0 = no natural regen. Needs a native rebuild to change engine behavior; the setting itself is read at boot.' },
  { key: 'chatRanges',              label: 'Chat ranges',           type: 'json',   group: 'Gameplay', help: 'Audible ranges in game units: { whisper, low, say, wide, shout }. Provided keys override the defaults.' },
  { key: 'voiceChat',               label: 'Voice chat',            type: 'json',   group: 'Gameplay', help: 'LiveKit proximity voice: { enabled, url, apiKey, apiSecret, room, rangeUnits }. rangeUnits = MAX talk range (defaults to chatRanges.shout); speakers pick their range between chatRanges.whisper and this with V + mousewheel.' },
  { key: 'maskName',                label: 'Mask name',             type: 'text',   group: 'Gameplay', help: 'Name shown for a /mask-ed player. Default "Masked Person".' },
  { key: 'introduceCooldownMs',     label: 'Introduce cooldown (ms)', type: 'number', group: 'Gameplay', help: 'Min gap between /introduce prompts to the same target. Default 10000.' },
  { key: 'gatheringVeinTotal',      label: 'Ore per vein',          type: 'number', group: 'Gameplay', help: 'Ore collections every mining vein holds, one per pickaxe strike. Default 6; 0 uses each record\'s own total (3 for vanilla veins). Read at boot.' },
  { key: 'gatheringVeinRespawnMinutes', label: 'Vein regrow (minutes)', type: 'number', group: 'Gameplay', help: 'Minutes after the first ore taken until the whole vein is back at once. Default 1440 (24 h); 0 keeps the default. Read at boot.' },
  { key: 'gatheringVeinRegenMinutes', label: 'Vein gradual regrow (minutes)', type: 'number', group: 'Gameplay', help: 'Leave empty (default) for the whole vein at once. Set: one ore collection grows back per that many minutes instead. Read at boot.' },
  { key: 'gatheringProduceYield',   label: 'Beehive yield',         type: 'json',   group: 'Gameplay', help: '{ "<container editor id>": { "<item editor id>": count } } handed over on E instead of the container record\'s contents. Default: occupied and vacant beehives and apiaries give 2 Bee Honeycomb, 2 Bee and 2 Beehive Husk, back after an hour (gatheringProduceContainers). Read at boot.' },
  { key: 'gatheringPickMinutes',    label: 'Nirnroot and critter regrow (minutes)', type: 'number', group: 'Gameplay', help: 'Minutes a picked nirnroot or a caught bee or firefly stays gone for everyone. Default 30. Read at boot.' },
  { key: 'needsSurvivalModeFlag',   label: 'Survival mode flag on clients', type: 'bool', group: 'Gameplay', help: 'On (default): clients set the Creation\'s Survival_ModeToggle (SRVT) to 1 with each needs update. The HUD polls that global every frame and draws the red penalty segments on the stamina and magicka bars only under it; off, the HUD clears them once after each load whatever the penalty globals hold. Survival_ModeEnabled is script-only, nothing in the engine reads it. On also gives every client the engine\'s Survival extras: arrows, bolts and the lockpick weigh their record weight and armour cards show a Warmth line. Read at boot.' },

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
  { key: 'bountyBoardCostGold',        label: 'Bounty board post cost',        type: 'number', group: 'Interactions', help: 'Gold taken for pinning a notice on a Missives board. 0 = free. Default 25.' },
  { key: 'writingEnabled',             label: 'Writeable letters and books',   type: 'bool',   group: 'Interactions', help: 'Lets players write letters, journals and books. Keep off until the plugin with the writing records is in the manifest and players have re-downloaded. Read at startup. Default off.' },

  // Data & storage
  { key: 'dataDir',        label: 'Data directory', type: 'text',   group: 'Data & storage', placeholder: 'data', help: 'ESMs / ESPs / UI / scripts.' },
  { key: 'gamemodePath',   label: 'Gamemode path',  type: 'text',   group: 'Data & storage', placeholder: './gamemode.js' },
  { key: 'databaseDriver', label: 'Database driver', type: 'select', group: 'Data & storage', options: ['file', 'mongodb', 'zip', 'migration'] },
  { key: 'databaseName',   label: 'Database name',   type: 'text',   group: 'Data & storage', placeholder: 'world', help: 'File DB folder / Mongo db name. Characters live in <name>/changeForms.' },
  { key: 'databaseUri',    label: 'Database URI',    type: 'secret', group: 'Data & storage', placeholder: 'mongodb://user:pass@127.0.0.1:27017', help: 'Mongo connection string (mongodb driver only). Embeds credentials - keep it secret.' },
  { key: 'logDir',         label: 'Log directory',   type: 'text',   group: 'Data & storage', placeholder: 'C:\\logs', help: 'Where chat.log and service logs are written. Overridden by the ALDUINAK_LOG_DIR env var.' },

  // Complex / nested (rendered as JSON sub-editors)
  { key: 'loadOrder',     label: 'Load order',     type: 'json', group: 'Advanced', help: 'Array of ESM/ESP filenames in order.' },
  { key: 'archives',      label: 'BSA archives',   type: 'json', group: 'Advanced', help: 'Array of BSA filenames to load.' },
  { key: 'startPoints',   label: 'Start points',   type: 'json', group: 'Advanced', help: 'Spawn points: [{ pos:[x,y,z], worldOrCell, angleZ }].' },
  { key: 'reloot',        label: 'Reloot timers',  type: 'json', group: 'Advanced', help: 'Record type → ms before respawn. FLOR and TREE are the alchemy plants: 1800000 (30 min) live, one hour when unset. Native server, read at boot.' },
  { key: 'forbiddenReloot', label: 'Forbidden reloot', type: 'json', group: 'Advanced', help: 'Record types that never respawn; wins over Reloot timers. Item types (MISC, WEAP, ...) and FLOR/TREE: plugin-placed refs cannot be taken at all. "LIGH": placed torches and lanterns. "CONT": an emptied container never refills, so storage chests stay player-only. Native server, read at boot.' },
  { key: 'emptyContainers', label: 'Empty containers', type: 'bool', group: 'Advanced', help: 'On (default, also when unset): chests, barrels and other placed containers from every plugin open without their plugin loot; items players put in stay, and containers already filled keep what they hold. Off: a container that never received anything gets its plugin loot on its next open. NPCs and corpses are unaffected. Native server, read at boot.' },
  { key: 'containerLootBaseIds', label: 'Containers keeping loot', type: 'json', group: 'Advanced', help: 'CONT base records (numbers, "0x..." strings or "hex:File.esp") that keep their plugin loot while Empty containers is on. Default []. Native server, read at boot.' },
  { key: 'untouchableBaseIds', label: 'Untouchable objects', type: 'json', group: 'Advanced', help: 'Base form ids nobody can activate (numbers or "0x..." strings). Default: the vanilla coin purses, loose salmon, Stones of Barenziah and wall torch sconces. [] disables.' },
  { key: 'exteriorScriptAllowlist', label: 'Exterior scripts', type: 'json', group: 'Advanced', help: 'Vanilla Papyrus scripts that still run on exterior objects; every other vanilla script is stripped there. Default: ["default2StateActivator", "NorLever01SCRIPT"] so lever-driven exterior gates open. [] strips them too. Native server, read at boot.' },
  { key: 'blockedSpells',  label: 'Blocked spells',  type: 'json', group: 'Advanced', help: 'Spell form ids players may not cast (numbers or "0x..." strings), e.g. racial powers.' },
  { key: 'adminProfileIds', label: 'Admin profile IDs', type: 'json', group: 'Advanced', help: 'Master-api profile ids granted in-game admin chat commands. Array of numbers.' },
  { key: 'adminRoleIds',    label: 'Admin Discord roles', type: 'json', group: 'Advanced', help: 'Legacy flat list of Discord role ids (strings) that get the in-game admin menu (Insert) and the server console. Roles here but in no adminRoles tier get full (senior) rights. Example: ["1521259484859863190"].' },
  { key: 'adminRoles',      label: 'Admin role tiers',    type: 'json', group: 'Advanced', help: 'Discord role ids per tier: { senior:[...], developer:[...], gm:[...] }. senior and gm have every power; developer has everything except Kick and Ban. Tier lists win over adminRoleIds; precedence senior > developer > gm.' },
  { key: 'adminTeleportLocations', label: 'Admin teleport locations', type: 'json', group: 'Advanced', help: 'Admin panel Teleport tab: [{ name, cellOrWorldDesc: "hexId:Plugin.esm", pos:[x,y,z], rot:[x,y,z], kind? }]. Listed before the built-in map-marker locations; bad entries are dropped at boot.' },
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
  { key: 'SKYMP_UI_PORT',  label: 'Game UI/metrics port', type: 'number', group: 'Game server', help: 'HTTP/metrics port of the game server. Empty = 3000 for game port 7777, else game port + 1.' },
  { key: 'SERVER_ADDRESS', label: 'Public address',   type: 'text',   group: 'Game server', help: 'Public IP advertised to external clients.' },

  // Server metadata (reported to the launcher)
  { key: 'SERVER_NAME',        label: 'Server name',      type: 'text',   group: 'Server metadata', help: 'Keep in sync with server-settings.json name.' },
  { key: 'SERVER_MAX_PLAYERS', label: 'Max players',      type: 'number', group: 'Server metadata' },
  { key: 'SERVER_OFFLINE_MODE', label: 'Offline mode',    type: 'bool',   group: 'Server metadata', help: 'Must match server-settings.json offlineMode.' },
  { key: 'SERVER_NPC_ENABLED', label: 'NPCs enabled',     type: 'bool',   group: 'Server metadata' },
  { key: 'SERVER_GAMEMODE',    label: 'Gamemode label',   type: 'text',   group: 'Server metadata', placeholder: 'Roleplay' },

  // Master API
  { key: 'SERVER_MASTER_KEY',      label: 'Master key',         type: 'secret', group: 'Master API', help: 'Public server id, not a secret. Must match server-settings.json masterKey.' },
  { key: 'MASTER_URL',             label: 'Master URL',         type: 'text',   group: 'Master API' },
  { key: 'MASTER_API_AUTH_TOKEN',  label: 'Master API auth token', type: 'secret', group: 'Master API', help: 'Private secret the game server sends as X-Auth-Token. Must match server-settings.json masterApiAuthToken.' },

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
  { key: 'LAUNCH_CHECK_ENFORCE',   label: 'Enforce launch check', type: 'bool', group: 'Access control', help: 'Refuse connections whose launcher did not verify client files + load order. Unset = enforced (the default); only Off disables it, for players on pre-check launcher builds.' },
  { key: 'BAN_LOG_DIR',            label: 'Ban log directory', type: 'text', group: 'Access control', help: 'Where ban.log and faction.log are written. Empty = the default logs folder.' },

  // Client updates
  { key: 'GITHUB_WEBHOOK_SECRET', label: 'GitHub webhook secret', type: 'secret', group: 'Client updates' },
  { key: 'CLIENT_BRANCH',         label: 'Client branch',         type: 'text',   group: 'Client updates', placeholder: 'refs/heads/main' },
  { key: 'CLIENT_FILES_DIR',      label: 'Client files directory', type: 'text',  group: 'Client updates', help: 'Bucket holding skymp-client.zip and the served client files. Empty = build/client-files.' },

  // CI & tooling
  { key: 'ALDUINAK_GH_TOKEN',     label: 'GitHub token (PAT)',    type: 'secret', group: 'CI & tooling', help: 'PAT with actions:write - powers the manager CI Rebuild (workflow dispatch).' },

  // Web Server Manager (dashboard) and its AlduinakManager agent
  { key: 'MANAGER_AGENT_PORT',        label: 'Agent port',          type: 'number', group: 'Web manager', help: 'Loopback port of the AlduinakManager service. Default 4003. Restart the backend and the agent after a change.' },
  { key: 'MANAGER_AGENT_SECRET',      label: 'Agent secret',        type: 'secret', group: 'Web manager', help: 'Shared secret the backend signs agent calls with, at least 32 characters.' },
  { key: 'MANAGER_LOG_DIR',           label: 'Manager log folder',  type: 'text',   group: 'Web manager', placeholder: 'C:\\logs\\manager', help: 'Web jobs, their logs, the busy lock and the audit files.' },
  { key: 'MANAGER_AUDIT_WEBHOOK_URL', label: 'Audit Discord webhook', type: 'secret', group: 'Web manager', help: 'Optional private staff channel webhook that mirrors manager actions and failed logins.' },
  { key: 'AUTO_RESTART_AT',           label: 'Daily restart time',  type: 'text',   group: 'Web manager', placeholder: '04:00', help: 'Local HH:MM when the agent restarts the game server and archives the logs, with in-game warnings from 1 hour before. off disables it. Read live. Default 04:00.' },
]

module.exports = { serverSettings, backendEnv }
