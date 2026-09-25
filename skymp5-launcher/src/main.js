// Load .env before anything else - only in unpackaged (dev/local) builds.
// Packaged installers use real environment variables set by the OS / process manager.
if (!require('electron').app.isPackaged) {
  require('dotenv').config()
}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')

// Basic/Remote display adapters (RDP, VMs, servers) bugcheck the video
// scheduler when Chromium drives them; the launcher UI does not need the GPU.
app.disableHardwareAcceleration()
const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const zlib   = require('zlib')
const http   = require('http')
const https  = require('https')
const { spawn, execFile, execFileSync } = require('child_process')
const Store  = require('electron-store')
const AdmZip = require('adm-zip')
const config = require('./config')
const mo2    = require('./mo2')
const nexus  = require('./nexus')
const ini    = require('./ini')
const gameversion = require('./gameversion')
const cleanmasters = require('./cleanmasters')
const { DiscordPresence } = require('./discordPresence')

const isDev = process.argv.includes('--dev')

// Always log installs: a packaged launcher that fails on a player's machine is
// undiagnosable without one. Dev builds keep using the temp path.
const LOG_FILE = isDev
  ? path.join(require('os').tmpdir(), 'alduinak-install.log')
  : path.join(app.getPath('userData'), 'install.log')

function log(...args) {
  const line = args.join(' ')
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`) } catch { }
}

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  // Truncate per run so the file stays small and always covers the last attempt
  fs.writeFileSync(LOG_FILE, `=== alduinak install log ${new Date().toISOString()} ===\n`)
} catch { }

// Route module debug output through the same logger
mo2.setLogger(log)
nexus.setLogger(log)

// Only user-specific preferences live in the store.
const store = new Store({
  defaults: {
    skyrimPath:        '',
    activeServerId:    'alduinak',
    cachedServers:     [],   // last-known server list fetched from /api/servers
    filesVersion:      '',   // version tag from last successful file download
    discordUser:       null,
    mo2Enabled:        true,   // launch the game through the managed portable MO2
    discordPresence:   true,   // show "Playing Alduinak" on Discord while the game runs
    nexusApiKey:       '',     // Nexus API key (websocket SSO flow)
    nexusOauth:        null,   // { accessToken, refreshToken, expiresAt } (OAuth flow)
    nexusUser:         null,   // { name, isPremium } from the last validation
    isolatedGame:      true,  // play from the isolated game copy instead of skyrimPath
    gameDirPath:       '',     // legacy: pre-base-dir location of the game copy
    baseDirPath:       '',     // Alduinak base dir: MO2 root, with the game at <base>\skyrim
    forcedDefaultsApplied: false, // server-required graphics defaults seeded once at first install
  }
})

mo2.setRootProvider(() => store.get('baseDirPath') || DEFAULT_BASE_DIR)

// Default install root for MO2 + the portable game copy when none is stored.
const DEFAULT_BASE_DIR = 'C:\\Alduinak'

let win = null

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Active server helper
// Returns the currently selected game server from the cached API list (the first one when the choice is gone),
// or null if no servers have been fetched yet.
function activeServer() {
  const servers = store.get('cachedServers') || []
  return servers.find(s => s.id && s.id === store.get('activeServerId')) || servers[0] || null
}

// The main server answers the plain URLs; any other selected server is named in the query
function serverQuery() {
  const srv = activeServer()
  const main = (store.get('cachedServers') || [])[0]
  return srv && srv.id && srv.id !== main.id ? `?server=${encodeURIComponent(srv.id)}` : ''
}
const serverInfoUrl = () => `${config.apiUrl}/api/serverinfo${serverQuery()}`

// Effective game path
// Creates an isolated copy, this keeps the base directory clean
function isolatedGameDir() {
  const base = store.get('baseDirPath')
  if (base) return path.join(base, 'skyrim')
  // Legacy layouts from before the base-dir structure
  const legacy = store.get('gameDirPath')
  if (legacy) return legacy
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Alduinak', 'GameDir')
}

function isolatedGameReady() {
  return fs.existsSync(path.join(isolatedGameDir(), 'SkyrimSE.exe'))
}

// A usable game copy needs more than SkyrimSE.exe (it is copied first, so an
// interrupted run leaves it behind with a partial Data). The completion marker
// written by copyGameDir is authoritative; copies made before the marker
// existed fall back to the masters check (the esms are copied nearly last,
// so their presence implies the BSAs made it too).
function gameCopyComplete(dir) {
  if (!fs.existsSync(path.join(dir, 'SkyrimSE.exe'))) return false
  if (fs.existsSync(path.join(dir, 'vanilla-copy-complete.json'))) return true
  return fs.existsSync(path.join(dir, 'Data', 'Skyrim.esm'))
    && fs.existsSync(path.join(dir, 'Data', 'Update.esm'))
}

function effectiveGamePath() {
  if (store.get('isolatedGame') && isolatedGameReady()) return isolatedGameDir()
  return store.get('skyrimPath')
}

// Skyrim path auto-detection
// Registry keys the store editions write at install time, probed in order.
const SKYRIM_REGISTRY_PROBES = [
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1801825368', value: 'path' },   // Skyrim AE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1711230643', value: 'path' },   // Skyrim SE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 489830', value: 'InstallLocation' },  // Steam
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\Skyrim Special Edition', value: 'installed path' },
]

// GOG product ids differ per store listing, so enumerate the whole Games key
// instead of relying on the pinned ids above.
function gogSkyrimPaths() {
  const out = []
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM\\SOFTWARE\\GOG.com\\Games']) {
    let listing = ''
    try {
      listing = execFileSync('reg', ['query', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { continue }
    for (const line of listing.split(/\r?\n/)) {
      const key = line.trim()
      if (!key.startsWith('HK')) continue
      const p = regQueryValue(key, 'path')
      if (p) out.push(p)
    }
  }
  return out
}

// Common Steam library roots, for installs outside the default library.
function steamSkyrimPaths() {
  const out = []
  const suffix = path.join('steamapps', 'common', 'Skyrim Special Edition')
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    out.push(path.join(`${drive}:\\`, 'Program Files (x86)', 'Steam', suffix))
    out.push(path.join(`${drive}:\\`, 'Steam', suffix))
    out.push(path.join(`${drive}:\\`, 'SteamLibrary', suffix))
    out.push(path.join(`${drive}:\\`, 'Games', 'Steam', suffix))
  }
  return out
}

// Read a single registry value via reg.exe (argv array, same pattern as mo2.js).
function regQueryValue(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value],
      { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }   // key or value missing
}

function isValidSkyrimPath(p) {
  return !!p && fs.existsSync(path.join(p, 'SkyrimSE.exe'))
}

// Stable per-machine id (Windows MachineGuid) for the backend ban system; null when unavailable, treated as optional.
function getHwid() {
  if (process.platform !== 'win32') return null
  const guid = regQueryValue('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')
  return guid && /^[0-9a-fA-F-]{10,64}$/.test(guid) ? guid : null
}

// Fire-and-forget: attach this machine's hwid to the fresh play session.
async function reportHwid(token) {
  const hwid = getHwid()
  if (!hwid || !token) return
  try {
    await postJSON(`${config.apiUrl}/api/users/me/hwid`, { hwid }, { Authorization: `Bearer ${token}` })
  } catch (err) {
    log(`[hwid] report failed (${err.statusCode || err.message}) - continuing without it`)
  }
}

// First registry hit that exists on disk and contains SkyrimSE.exe, or null.
function detectSkyrimPath() {
  if (process.platform !== 'win32') return null
  for (const probe of SKYRIM_REGISTRY_PROBES) {
    const p = regQueryValue(probe.key, probe.value)
    if (isValidSkyrimPath(p)) return p
  }
  for (const p of gogSkyrimPaths()) {
    if (isValidSkyrimPath(p)) return p
  }
  for (const p of steamSkyrimPaths()) {
    if (isValidSkyrimPath(p)) return p
  }
  return null
}

// When the stored path is empty or invalid, auto-fill it from the registry and persist.
function ensureSkyrimPath() {
  const stored = store.get('skyrimPath')
  if (isValidSkyrimPath(stored)) return stored
  const detected = detectSkyrimPath()
  if (detected) {
    store.set('skyrimPath', detected)
    log(`[detect] Skyrim path auto-detected: ${detected}`)
  }
  return detected
}

ipcMain.handle('game:detectPath', () => {
  // Fill-only: the renderer shows the result and Save persists it
  return { path: detectSkyrimPath() }
})

// Window
function createWindow() {
  win = new BrowserWindow({
    width:     1280,
    height:    720,
    minWidth:  1024,
    minHeight: 600,
    frame:     false,
    resizable: true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    backgroundColor: '#080503',
    show: false,
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => {
    win.show()
    // Chained so the two startup modals never stack
    maybeWarnNeverLaunched().then(() => {
      const gv = gameVersionProblem()
      if (gv) showGameVersionDialog(gv)
    })
  })

  if (isDev) win.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  ensureSkyrimPath()
  adoptChatFov()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Window controls
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:maximize', () => {
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.on('window:close', () => win?.close())

// Settings
ipcMain.handle('settings:load', async () => {
  // Refresh the server list from the backend on every load.
  // On failure we keep the previously cached list so offline launches still work.
  try {
    const fetched = await fetchJSON(`${config.apiUrl}/api/servers`)
    if (Array.isArray(fetched) && fetched.length > 0) {
      store.set('cachedServers', fetched)
    }
  } catch { /* keep existing cache */ }

  // Auto-fill an empty/invalid Skyrim path from the registry (runs at startup and on settings open).
  ensureSkyrimPath()

  const servers = store.get('cachedServers') || []
  // Whitelist only what the renderer reads. Never spread the whole store: it
  // holds secrets (nexusApiKey, nexusOauth tokens, gameSession, gameProfileId)
  // the renderer must never receive.
  return {
    skyrimPath:        store.get('skyrimPath'),
    baseDirPath:       store.get('baseDirPath') || DEFAULT_BASE_DIR,
    activeServerId:    (activeServer() || {}).id || '',
    mo2Enabled:        store.get('mo2Enabled'),
    isolatedGame:      store.get('isolatedGame'),
    discordPresence:   store.get('discordPresence'),
    servers,
    multiServer:       servers.length > 1,
    discordUser:       store.get('discordUser') || null,
  }
})
ipcMain.handle('settings:save', (_e, data) => {
  const allowed = ['skyrimPath', 'baseDirPath', 'activeServerId', 'mo2Enabled', 'isolatedGame', 'discordPresence']
  const clean = {}
  for (const k of allowed) if (k in data) clean[k] = data[k]
  store.set(clean)
  if ('discordPresence' in clean) setPresenceRunning(gameWasRunning)
})

// Discord Rich Presence: lives in the main process while the game runs and the toggle is on
const presence = new DiscordPresence(log)
let presenceStart = 0
let presenceTimer = null
let lastServerInfo = null
function discordAppId() {
  return (lastServerInfo && lastServerInfo.discordAppId) || config.discordAppId
}
async function updatePresence() {
  let players = null
  try {
    const s = await fetchJSON(`${config.apiUrl}/api/status${serverQuery()}`)
    if (s && s.status === 'online' && Number.isFinite(Number(s.players))) players = Number(s.players)
  } catch { }
  const srv = activeServer() || {}
  const max = Number(srv.maxPlayers) || Number(lastServerInfo?.maxPlayers) || config.discordPartyMax
  const activity = {
    details: 'Playing Alduinak',
    state: players === null ? 'server offline' : `${players}/${max} players online`,
    timestamps: { start: presenceStart },
    assets: { large_image: 'alduinak', large_text: 'Alduinak RP', small_image: 'alduinaklogoofficial', small_text: 'SkyMP' },
    buttons: [{ label: 'Website', url: config.websiteUrl }],
  }
  // Discord refuses a party of fewer than one; the state line already carries the 0/max text
  if (players) activity.party = { id: 'alduinak', size: [Math.min(players, max), max] }
  presence.setActivity(activity)
}
function setPresenceRunning(running) {
  const want = running && !!store.get('discordPresence')
  if (want && !presenceStart) {
    presenceStart = Date.now()
    presence.start(discordAppId())
    updatePresence()
    presenceTimer = setInterval(updatePresence, 10_000)
  } else if (!want && presenceStart) {
    clearInterval(presenceTimer)
    presenceTimer = null
    presenceStart = 0
    presence.stop()
  }
}
app.on('before-quit', () => presence.stop())

// Graphics / hotkey settings (Settings tab)
// Graphics edit the MO2 portable profile's SkyrimPrefs.ini (FOV its Skyrim.ini). NOTE: this assumes
// the Alduinak profile uses profile-specific INI files; and if SSEDisplayTweaks is
// active it may override window mode via its own ini.
function skyrimPrefsPath() {
  return path.join(mo2.getProfileDir(), 'skyrimprefs.ini')
}
const profileIni = name => path.join(mo2.getProfileDir(), name)
// The file MO2 seeds a missing profile ini from: the player's own, and for Skyrim.ini else the game's default
function profileIniSeed(name) {
  const prefs = findOriginalPrefsIni()
  const game = effectiveGamePath()
  return [prefs && path.join(path.dirname(prefs), name), name === 'skyrim.ini' && game && path.join(game, 'Skyrim_Default.ini')]
    .find(f => f && fs.existsSync(f)) || null
}
// The profile ini, or while it is missing the file MO2 will seed it from
function profileIniInEffect(name) {
  return fs.existsSync(profileIni(name)) ? profileIni(name) : profileIniSeed(name)
}
// Seeds a missing profile ini so a minimal one never hides the player's settings (language, archives, etc)
function ensureProfileIni(name) {
  const dest = profileIni(name)
  const src = fs.existsSync(dest) ? null : profileIniSeed(name)
  if (src) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
  return dest
}
// The engine reads FOV from Skyrim.ini [Display], and SkyrimCustom.ini loads after it
const FOV_KEYS = ['fDefaultWorldFOV', 'fDefault1stPersonFOV']
const FOV_INIS = ['skyrimcustom.ini', 'skyrim.ini']
const FOV_DEFAULT = 80
function clampFov(v) {
  const n = Math.round(parseFloat(v))
  return Number.isFinite(n) ? Math.min(170, Math.max(70, n)) : null
}
function fovInEffect() {
  const d = FOV_INIS.map(profileIniInEffect).map(f => (f && ini.read(f).Display) || {}).find(x => FOV_KEYS[0] in x) || {}
  const n = parseFloat(d[FOV_KEYS[0]])
  return Number.isFinite(n) ? n : FOV_DEFAULT
}
// The slider value once moved, else the one the inis give; launches copy the stored one into the client settings
function launcherFov() {
  return clampFov(store.get('fov')) ?? clampFov(fovInEffect())
}
// Stores a moved slider value, and writes both profile FOV keys when the value differs from the one in effect
function saveFov(v) {
  const fov = clampFov(v)
  if (fov === null) return
  if (fov !== launcherFov()) store.set('fov', fov)
  if (!fs.existsSync(skyrimPrefsPath()) || fov === Math.round(fovInEffect())) return
  const fovEdit = { Display: Object.fromEntries(FOV_KEYS.map(k => [k, fov.toFixed(4)])) }
  ini.write(ensureProfileIni(FOV_INIS[1]), fovEdit)
  const custom = profileIniInEffect(FOV_INIS[0])
  if (custom && FOV_KEYS.some(k => k in (ini.read(custom).Display || {}))) ini.write(ensureProfileIni(FOV_INIS[0]), fovEdit)
}
// Server hotkeys live in the Skyrim Platform client settings (the object exposed
// to the client as settings["skymp5-client"] - the file content is that object).
function clientSettingsPath() {
  return path.join(effectiveGamePath() || '', 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')
}
function readClientSettings() {
  try {
    const obj = JSON.parse(fs.readFileSync(clientSettingsPath(), 'utf8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}
// The in-game chat settings the client persists through writePlugin: "//" + JSON with fov and fovLauncher
function chatSettingsPath() {
  return path.join(effectiveGamePath() || '', 'Data', 'Platform', 'PluginsNoLoad', 'chat-settings-no-load.js')
}
function readChatSettings() {
  try {
    const obj = JSON.parse(fs.readFileSync(chatSettingsPath(), 'utf8').replace(/^\/\//, ''))
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}
// Takes the in-game chat FOV into the slider when its fovLauncher stamp equals the stored slider value
function adoptChatFov() {
  try {
    const c = readChatSettings()
    const chat = clampFov(c.fov)
    const stamp = clampFov(c.fovLauncher) ?? 0
    const mine = clampFov(store.get('fov')) ?? 0
    if (chat === null || stamp !== mine || chat === launcherFov()) return
    saveFov(chat)
    log('[fov] adopted in-game value', chat)
  } catch (err) {
    log('[fov] adopt failed:', err.message)
  }
}

ipcMain.handle('graphics:load', () => {
  adoptChatFov()
  try {
    const p = skyrimPrefsPath()
    const data = ini.read(p)
    const disp = data['Display'] || {}
    const controls = data['Controls'] || {}
    const full = String(disp['bFull Screen'] || '0') === '1'
    // Default to borderless when the ini doesn't say otherwise (missing file
    // or keys). An explicit bFull Screen=0 + bBorderless=0 reads as windowed.
    const hasMode = ('bFull Screen' in disp) || ('bBorderless' in disp)
    const borderless = hasMode ? String(disp['bBorderless'] || '0') === '1' : true
    // Fallback chain for player-owned values: profile ini, then the player's
    // original My Games ini, then the engine default.
    let orig = {}
    try {
      const src = findOriginalPrefsIni()
      if (src) orig = ini.read(src)
    } catch { /* fall through to defaults */ }
    const origDisp = orig['Display'] || {}
    const val = (section, key, dflt) => {
      const a = data[section] || {}
      if (key in a) return String(a[key])
      const b = orig[section] || {}
      if (key in b) return String(b[key])
      return dflt
    }
    const num = (section, key, dflt) => {
      const n = parseInt(val(section, key, ''), 10)
      return Number.isNaN(n) ? dflt : n
    }
    const skip = num('Display', 'iTexMipMapSkip', 0)
    const shadowRes = num('Display', 'iShadowMapResolution', 2048)
    const reflH = num('Water', 'iWaterReflectHeight', 512)
    const maxDecals = num('Decals', 'uMaxDecals', 250)
    return {
      ok: true,
      path: p,
      exists: fs.existsSync(p),
      windowMode: full ? 'fullscreen' : (borderless ? 'borderless' : 'windowed'),
      width:  disp['iSize W'] || origDisp['iSize W'] || '1920',
      height: disp['iSize H'] || origDisp['iSize H'] || '1080',
      invertY: String(controls['bInvertYValues'] || '0') === '1',
      texQuality: skip >= 2 ? 'low' : (skip === 1 ? 'medium' : 'high'),
      aa: val('Display', 'bUseTAA', '1') === '1' ? 'taa'
        : (val('Display', 'bFXAAEnabled', '0') === '1' ? 'fxaa' : 'off'),
      shadowQuality: shadowRes <= 512 ? 'low' : (shadowRes <= 1024 ? 'medium' : (shadowRes <= 2048 ? 'high' : 'ultra')),
      decals: val('Decals', 'bDecals', '1') === '0' ? 'off'
        : (maxDecals <= 100 ? 'low' : (maxDecals <= 250 ? 'medium' : (maxDecals <= 350 ? 'high' : 'ultra'))),
      reflections: reflH >= 1024
        ? (val('Water', 'bReflectLODTrees', '0') === '1' ? 'ultra' : 'high')
        : (val('Water', 'bReflectLODLand', '0') === '1' ? 'medium' : 'low'),
      fov:       launcherFov(),
      godrays:   val('Display', 'bVolumetricLightingEnable', '1') === '1',
      lensFlare: val('Imagespace', 'bLensFlare', '1') === '1',
      ao:        val('Display', 'bSAOEnable', '1') === '1',
      precip:    val('Display', 'bPrecipitationOcclusion', '1') === '1',
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('graphics:save', (_e, g) => {
  try {
    g = g || {}
    const display = {}
    if (g.windowMode === 'fullscreen')      { display['bFull Screen'] = '1'; display['bBorderless'] = '0' }
    else if (g.windowMode === 'borderless') { display['bFull Screen'] = '0'; display['bBorderless'] = '1' }
    else if (g.windowMode === 'windowed')   { display['bFull Screen'] = '0'; display['bBorderless'] = '0' }
    if (g.width)  display['iSize W'] = String(g.width)
    if (g.height) display['iSize H'] = String(g.height)
    const TEX = { high: '0', medium: '1', low: '2' }
    if (TEX[g.texQuality]) display['iTexMipMapSkip'] = TEX[g.texQuality]
    if (['off', 'fxaa', 'taa'].includes(g.aa)) {
      display['bUseTAA']      = g.aa === 'taa'  ? '1' : '0'
      display['bFXAAEnabled'] = g.aa === 'fxaa' ? '1' : '0'
    }
    const SHADOW = { low: '512', medium: '1024', high: '2048', ultra: '4096' }
    if (SHADOW[g.shadowQuality]) display['iShadowMapResolution'] = SHADOW[g.shadowQuality]
    if (typeof g.godrays === 'boolean') display['bVolumetricLightingEnable'] = g.godrays ? '1' : '0'
    if (typeof g.ao === 'boolean')      display['bSAOEnable'] = g.ao ? '1' : '0'
    if (typeof g.precip === 'boolean')  display['bPrecipitationOcclusion'] = g.precip ? '1' : '0'
    const edits = { Display: display, Controls: { bInvertYValues: g.invertY ? '1' : '0' } }
    if (typeof g.lensFlare === 'boolean') {
      display['bIBLFEnable'] = g.lensFlare ? '1' : '0'
      edits.Imagespace = { bLensFlare: g.lensFlare ? '1' : '0' }
    }
    const DECALS = {
      off:    { bDecals: '0', bSkinnedDecals: '0' },
      low:    { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '100',  uMaxSkinDecals: '25',  uMaxSkinDecalsPerActor: '20' },
      medium: { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '250',  uMaxSkinDecals: '50',  uMaxSkinDecalsPerActor: '40' },
      high:   { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '350',  uMaxSkinDecals: '75',  uMaxSkinDecalsPerActor: '50' },
      ultra:  { bDecals: '1', bSkinnedDecals: '1', uMaxDecals: '1000', uMaxSkinDecals: '100', uMaxSkinDecalsPerActor: '60' },
    }
    if (DECALS[g.decals]) edits.Decals = DECALS[g.decals]
    const REFLECTIONS = {
      low:    { iWaterReflectHeight: '512',  iWaterReflectWidth: '512',  bReflectLODLand: '0', bReflectLODObjects: '0', bReflectLODTrees: '0', bReflectSky: '0' },
      medium: { iWaterReflectHeight: '512',  iWaterReflectWidth: '512',  bReflectLODLand: '1', bReflectLODObjects: '0', bReflectLODTrees: '0', bReflectSky: '1' },
      high:   { iWaterReflectHeight: '1024', iWaterReflectWidth: '1024', bReflectLODLand: '1', bReflectLODObjects: '1', bReflectLODTrees: '0', bReflectSky: '1' },
      ultra:  { iWaterReflectHeight: '1024', iWaterReflectWidth: '1024', bReflectLODLand: '1', bReflectLODObjects: '1', bReflectLODTrees: '1', bReflectSky: '1' },
    }
    if (REFLECTIONS[g.reflections]) edits.Water = Object.assign({ bUseWaterReflections: '1' }, REFLECTIONS[g.reflections])
    ini.write(skyrimPrefsPath(), edits)
    saveFov(g.fov)
    return { ok: true, path: skyrimPrefsPath() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('graphics:saveFov', (_e, v) => {
  try {
    saveFov(v)
    return { ok: true }
  } catch (err) {
    log('[graphics] could not save the FOV:', err.message)
    return { ok: false, error: err.message }
  }
})

// hotkeys:load/save field -> skymp5-client settings key; chatFocusKeyCodes is the one list-valued hotkey
const CLIENT_HOTKEY_KEYS = {
  freeCursor: 'freeCursorKeyCode', voicePtt: 'voicePushToTalkKeyCode',
  hideUi: 'hideUiKeyCode', altInteract: 'altInteractKeyCode',
  emoteWheel: 'emoteWheelKeyCode',
}
const CLIENT_SETTINGS_HOTKEYS = ['chatFocusKeyCodes', ...Object.values(CLIENT_HOTKEY_KEYS)]
// Hotkeys saved while the game runs wait here for the next launch, as SkyrimPlatform reloads every plugin when its folder changes
const PENDING_HOTKEYS = 'pendingClientHotkeys'

ipcMain.handle('hotkeys:load', () => {
  try {
    const c = { ...readClientSettings(), ...store.get(PENDING_HOTKEYS) }
    const out = { ok: true, path: clientSettingsPath(), chatFocus: Array.isArray(c.chatFocusKeyCodes) ? c.chatFocusKeyCodes : null }
    for (const [field, key] of Object.entries(CLIENT_HOTKEY_KEYS)) out[field] = typeof c[key] === 'number' ? c[key] : null
    // Interact / Menus cannot be unbound, so a stored 0 shows and saves the X default
    if (out.altInteract === 0) out.altInteract = null
    return out
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('hotkeys:save', async (_e, h) => {
  try {
    h = h || {}
    const c = { ...readClientSettings(), ...store.get(PENDING_HOTKEYS) }
    if (Array.isArray(h.chatFocus)) c.chatFocusKeyCodes = h.chatFocus.filter(n => typeof n === 'number')
    for (const [field, key] of Object.entries(CLIENT_HOTKEY_KEYS)) {
      // Interact / Menus cannot be unbound, so a 0 keeps the stored key
      if (typeof h[field] === 'number' && (field !== 'altInteract' || h[field] > 0)) c[key] = h[field]
    }
    const p = clientSettingsPath()
    if ((await gameProcessRunning()) || Date.now() - launchStartedAt < LAUNCH_GRACE_MS) {
      store.set(PENDING_HOTKEYS, Object.fromEntries(CLIENT_SETTINGS_HOTKEYS.filter(k => k in c).map(k => [k, c[k]])))
      return { ok: true, path: p, deferred: true }
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(c, null, 2))
    store.delete(PENDING_HOTKEYS)
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Game hotkeys edit the keyboard and mouse columns of the game's controlmap.txt.
// Values are DirectInput scan codes, the same space the renderer's KEY_TABLE uses; mouse button n is 256 + n.
const GAME_HOTKEY_EVENTS = ['Activate', 'Jump', 'Sprint', 'Sneak', 'Shout', 'Toggle POV']
const MOUSE_DIK = 256

function controlmapPath() {
  const gp = effectiveGamePath()
  return gp ? path.join(gp, 'Data', 'Interface', 'Controls', 'PC', 'controlmap.txt') : ''
}

// The game saves in-game rebinds to ControlMap_Custom.txt in its working directory, the game root
function controlmapCustomPath() {
  const gp = effectiveGamePath()
  return gp ? path.join(gp, 'ControlMap_Custom.txt') : ''
}

function readCustomControlmap() {
  const p = controlmapCustomPath()
  try { return p ? fs.readFileSync(p) : null } catch { return null }
}

const CONTROLMAP_SEED = path.join(__dirname, '..', 'assets', 'controlmap.txt')

function readControlmapText() {
  const p = controlmapPath()
  if (p && fs.existsSync(p)) return { path: p, text: upgradeControlmapText(fs.readFileSync(p, 'utf8')), exists: true }
  return { path: p, text: fs.readFileSync(CONTROLMAP_SEED, 'utf8'), exists: false }
}

function controlmapEventRe(ev) {
  const escaped = ev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^(' + escaped + '[ \\t]+)(\\S+)([ \\t]+)(\\S+)', 'm')
}

// A bound mouse column wins over the keyboard one; 0xff is unbound
function controlmapBinding(kb, mouse) {
  const m = parseInt(mouse, 16)
  if (m >= 0 && m < 8) return MOUSE_DIK + m
  const k = parseInt(kb, 16)
  return k > 0 && k < 0xff ? k : null
}

// Line index of an event in the Main Gameplay context, the id ControlMap_Custom.txt entries use
function gameplayEventIndex(text, ev) {
  let i = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('//')) continue
    if (/^([ \t\r]|$)/.test(line)) return -1
    if (line.split('\t')[0] === ev) return i
    i++
  }
  return -1
}

// Keyboard and mouse entries of ControlMap_Custom.txt: per device a [2, length hi, length lo] header, then [event index, 4-byte big-endian key] entries
function customControlmapEntries(buf) {
  const out = []
  if (!buf) return out
  for (let dev = 0, off = 0; dev < 2 && off + 3 <= buf.length; dev++) {
    const end = Math.min(off + ((buf[off + 1] << 8) | buf[off + 2]), buf.length)
    if (end < off + 3) break
    if (buf[off] === 2) for (let e = off + 3; e + 5 <= end; e += 5) out.push({ dev, index: buf[e], at: e + 1 })
    off = end
  }
  return out
}

// The binding the game uses: a ControlMap_Custom.txt entry overrides the controlmap.txt column
function gameHotkeyBinding(text, ev, custom, entries) {
  const m = text.match(controlmapEventRe(ev))
  if (!m) return null
  const cols = [m[2], m[4]]
  const idx = gameplayEventIndex(text, ev)
  for (const e of entries) if (e.index === idx) cols[e.dev] = custom.readUInt32BE(e.at).toString(16)
  return controlmapBinding(cols[0], cols[1])
}

// Stale launcher copies lack the AE Creations Menu context or still bind Wait on the gamepad
function isStaleLauncherControlmap(text) {
  if (!/launcher controlmap override/.test(text)) return false
  const wait = text.match(/^Wait[ \t]+\S+[ \t]+\S+[ \t]+(\S+)/m)
  return !/^PurchaseCredits[ \t]/m.test(text) || (!!wait && wait[1].toLowerCase() !== '0xff')
}

// Rebuilds a stale launcher copy from the seed, keeping the keyboard and mouse rebinds the Settings tab manages
function upgradeControlmapText(text) {
  if (!isStaleLauncherControlmap(text)) return text
  let upgraded = fs.readFileSync(CONTROLMAP_SEED, 'utf8')
  for (const ev of GAME_HOTKEY_EVENTS) {
    const m = text.match(controlmapEventRe(ev))
    if (m) upgraded = upgraded.replace(controlmapEventRe(ev), (_m, head, _kb, sep) => head + m[2] + sep + m[4])
  }
  return upgraded
}

// Seeds the Wait-unbound controlmap when the game has none and upgrades a stale launcher copy; a player's own map is never touched
function applyControlmapOverride(gamePath) {
  try {
    if (!gamePath) return
    const dest = path.join(gamePath, 'Data', 'Interface', 'Controls', 'PC', 'controlmap.txt')
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(CONTROLMAP_SEED, dest)
      log('[defaults] wrote controlmap override (Wait unbound on keyboard and gamepad) to ' + dest)
      return
    }
    const text = fs.readFileSync(dest, 'utf8')
    const upgraded = upgradeControlmapText(text)
    if (upgraded !== text) {
      fs.writeFileSync(dest, upgraded)
      log('[defaults] rebuilt the stale controlmap override from the current seed at ' + dest)
    }
  } catch (err) {
    log('[defaults] could not write controlmap override:', err.message)
  }
}

ipcMain.handle('gameHotkeys:load', () => {
  try {
    const cm = readControlmapText()
    const custom = readCustomControlmap()
    const entries = customControlmapEntries(custom)
    const keys = {}
    for (const ev of GAME_HOTKEY_EVENTS) keys[ev] = gameHotkeyBinding(cm.text, ev, custom, entries)
    return { ok: true, path: cm.path, exists: cm.exists, hasGamePath: !!cm.path, keys }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('gameHotkeys:save', (_e, keys) => {
  try {
    const p = controlmapPath()
    if (!p) return { ok: false, error: 'Skyrim path is not configured yet' }
    let { text } = readControlmapText()
    const custom = readCustomControlmap()
    const entries = customControlmapEntries(custom)
    let customChanged = false
    for (const [ev, code] of Object.entries(keys || {})) {
      const mouse = code >= MOUSE_DIK && code < MOUSE_DIK + 8
      if (!GAME_HOTKEY_EVENTS.includes(ev) || typeof code !== 'number' || !(mouse || (code > 0 && code < 0xff))) continue
      // One binding per action: the other column goes unbound
      const kb = mouse ? '0xff' : '0x' + code.toString(16)
      const ms = mouse ? '0x' + (code - MOUSE_DIK).toString(16) : '0xff'
      if (code !== gameHotkeyBinding(text, ev, custom, entries)) {
        const idx = gameplayEventIndex(text, ev)
        for (const e of entries) if (e.index === idx) { custom.writeUInt32BE(Number(e.dev ? ms : kb), e.at); customChanged = true }
      }
      text = text.replace(controlmapEventRe(ev), (_m, head, _kb, sep) => head + kb + sep + ms)
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
    if (customChanged) fs.writeFileSync(controlmapCustomPath(), custom)
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Forced server defaults
// The server ships a couple of required defaults. We apply them once, when the
// Alduinak install is first set up, so later tweaks in the Settings tab aren't
// reverted on every client update:
//   • borderless window mode → MO2 profile's SkyrimPrefs.ini [Display]
//     (resolution is player-owned: it comes from the seeded ini, or the
//      Settings tab default when the ini doesn't specify one)
//   • Wait unbound (T, pad Back) → controlmap override (waiting is disabled here)
function applyForcedServerDefaults(gamePath) {
  // One-time repair for profiles created before resolution became
  // player-owned: earlier builds force-stamped 1920x1080 into the profile
  // ini, hiding the player's real resolution. Re-import it once from the
  // original My Games ini; from then on the Settings tab owns the values.
  if (!store.get('resolutionMigrated')) {
    try {
      const src  = findOriginalPrefsIni()
      const prof = skyrimPrefsPath()
      if (src && fs.existsSync(prof)) {
        const orig = ini.read(src)['Display'] || {}
        if (orig['iSize W'] && orig['iSize H']) {
          ini.write(prof, { Display: { 'iSize W': String(orig['iSize W']), 'iSize H': String(orig['iSize H']) } })
          log(`[defaults] re-imported resolution ${orig['iSize W']}x${orig['iSize H']} from the original ini`)
        }
      }
      store.set('resolutionMigrated', true)
    } catch (err) {
      log('[defaults] resolution migration failed:', err.message)
    }
  }

  // Graphics: force borderless window mode. ini.write preserves every other
  // key, including whatever resolution the player's ini carries.
  if (!store.get('forcedDefaultsApplied')) {
    try {
      ini.write(skyrimPrefsPath(), {
        Display: { 'bFull Screen': '0', 'bBorderless': '1' },
      })
      store.set('forcedDefaultsApplied', true)
      log('[defaults] forced borderless window mode into SkyrimPrefs.ini')
    } catch (err) {
      log('[defaults] could not write graphics defaults:', err.message)
    }
  }

  applyControlmapOverride(gamePath)

  // AE popup suppression, re-applied on every install pass so existing installs pick it up.
  try {
    // Portable copies only: never blank the ccc of a player's real install.
    if (gamePath && store.get('isolatedGame') && gamePath === isolatedGameDir()) {
      const ccc = path.join(gamePath, 'Skyrim.ccc')
      if (!fs.existsSync(ccc) || fs.statSync(ccc).size > 0) {
        fs.writeFileSync(ccc, '')
        log('[defaults] wrote empty Skyrim.ccc (no CC content expected)')
      }
    }
  } catch (err) {
    log('[defaults] could not write Skyrim.ccc:', err.message)
  }
  // Profile ini: kill the Bethesda.net platform, which drives the "AE content available for download" prompt and the CC news.
  try {
    const dest = ensureProfileIni('skyrim.ini')
    const cur = ini.read(dest)['Bethesda.net'] || {}
    if (String(cur['bEnablePlatform'] || '') !== '0') {
      ini.write(dest, { 'Bethesda.net': { bEnablePlatform: '0' } })
      log('[defaults] disabled the Bethesda.net platform in the profile Skyrim.ini')
    }
  } catch (err) {
    log('[defaults] could not write the profile Skyrim.ini:', err.message)
  }

  // MO2 only honors the profile inis the Settings tab edits when local settings are enabled.
  try {
    const settingsIni = path.join(mo2.getProfileDir(), 'settings.ini')
    const general = ini.read(settingsIni)['General'] || {}
    if (String(general['LocalSettings'] || '') !== 'true') {
      ini.write(settingsIni, { General: { LocalSettings: 'true', LocalSaves: 'false' } })
      log('[defaults] enabled profile-local inis in the MO2 profile')
    }
  } catch (err) {
    log('[defaults] could not enable profile-local inis:', err.message)
  }
}

// Folder picker
ipcMain.handle('dialog:openFolder', async (_e, title) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: typeof title === 'string' && title ? title : 'Select Skyrim Installation Folder',
  })
  return result.canceled ? null : result.filePaths[0]
})

// Open external URL - http/https only
ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url)
  }
})

// News
ipcMain.handle('api:news', async () => {
  try {
    const items = await fetchJSON(`${config.apiUrl}/api/news`)
    return { ok: true, items: Array.isArray(items) ? items : [] }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Server status
ipcMain.handle('api:status', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/status${serverQuery()}`)
    return { ok: true, ...data }
  } catch {
    return { ok: false }
  }
})

// Server info
// Include the stored session token so the backend's session-aware `allowed`
// field reflects whether this user is on the whitelist / server lock list.
ipcMain.handle('api:serverinfo', async () => {
  const session = store.get('gameSession')
  const headers = session ? { 'x-session': session } : {}
  try {
    lastServerInfo = await fetchJSON(serverInfoUrl(), headers)
    return lastServerInfo
  } catch { return null }
})

// Discord OAuth

ipcMain.handle('discord:getUser', () => store.get('discordUser') || null)

ipcMain.handle('discord:logout', () => {
  store.set('discordUser',   null)
  store.set('gameProfileId', null)
  store.set('gameSession',   null)

  // Clear auth-data-no-load.js so the SkyMP in-game client reverts to showing
  // its own Discord OAuth dialog (//null is read as null by the SkyMP client).
  const skyrimPath = effectiveGamePath()
  if (skyrimPath) {
    const authDataPath = path.join(skyrimPath, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js')
    try { fs.writeFileSync(authDataPath, '//null') } catch { /* file may not exist yet */ }
  }

  return { success: true }
})

ipcMain.handle('discord:login', async () => {
  const state = crypto.randomBytes(32).toString('hex')

  // Open the backend's login-discord URL in the user's default browser.
  // The backend registers the state, redirects to Discord, exchanges the code
  // on callback, and makes the result available at the /status endpoint.
  shell.openExternal(`${config.apiUrl}/api/users/login-discord?state=${state}`)

  // Poll the status endpoint until auth completes or times out (5 minutes).
  const POLL_INTERVAL_MS = 2000
  const deadline = Date.now() + 5 * 60 * 1000
  let unexpectedStreak = 0    // consecutive non-401 poll failures
  let stateRegistered  = false // backend has answered 401 (= browser reached /login-discord)

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    let data
    try {
      data = await fetchJSON(
        `${config.apiUrl}/api/users/login-discord/status?state=${encodeURIComponent(state)}`
      )
    } catch (err) {
      if (err.statusCode === 401) { stateRegistered = true; unexpectedStreak = 0; continue }  // still pending - keep polling
      if (err.statusCode === 403) {
        // The state only exists server-side once the browser loads the login
        // URL. A 403 before we ever saw it pending just means the browser is
        // still opening (cold start, open-link prompt) - keep waiting.
        if (!stateRegistered) { unexpectedStreak = 0; continue }
        return { success: false, error: 'Login attempt expired - please try again.' }
      }

      // Anything else (cross-host redirect, 404 from a stale backend, 5xx,
      // network blip): keep polling briefly, but give up with the real reason
      // instead of burning the full five minutes in silence.
      unexpectedStreak++
      log(`[discord] status poll failed (${err.statusCode ? 'HTTP ' + err.statusCode : err.message}), ${unexpectedStreak} in a row`)
      if (unexpectedStreak >= 10) {
        return {
          success: false,
          error: `Cannot read the login status from the backend (${err.statusCode ? 'HTTP ' + err.statusCode : err.message}).`,
        }
      }
      continue
    }
    unexpectedStreak = 0

    // 200 OK - auth complete.
    // token is the play-session token; masterApiId is the stable numeric profileId.
    const { token, masterApiId, discordUsername, discordAvatar } = data

    const discordUser = {
      username: discordUsername || `Player ${masterApiId}`,
      tag:      discordUsername || `Player ${masterApiId}`,
      avatar:   discordAvatar   || null,
    }

    store.set('discordUser',   discordUser)
    store.set('gameProfileId', masterApiId)
    store.set('gameSession',   token)
    log(`[discord] logged in as ${discordUser.username} (profileId ${masterApiId})`)

    reportHwid(token) // not awaited: login must not block on the ban-system hwid

    return { success: true, user: discordUser }
  }

  return { success: false, error: 'Login timed out - please try again.' }
})

// MO2 integration

ipcMain.handle('mo2:status', () => mo2.getStatus())

ipcMain.handle('mo2:open', () => {
  try { mo2.openUI(); return { success: true } }
  catch (err) { return { success: false, error: err.message } }
})

// Open the portable install (base) folder in the OS file manager.
ipcMain.handle('install:openFolder', async () => {
  const dir = store.get('baseDirPath') || mo2.getRoot()
  if (!dir || !fs.existsSync(dir)) {
    return { success: false, error: 'No portable install folder yet - set one up first.' }
  }
  const err = await shell.openPath(dir)
  return err ? { success: false, error: err } : { success: true }
})

// Nexus Mods login

ipcMain.handle('nexus:getUser', () => store.get('nexusUser') || null)

ipcMain.handle('nexus:logout', () => {
  store.set('nexusApiKey', '')
  store.set('nexusOauth', null)
  store.set('nexusUser', null)
  return { success: true }
})

// One-click web login. Prefers OAuth (authorization code + PKCE) when a
// client id is configured; falls back to the older websocket SSO when only
// the application slug is set. The renderer flow is identical either way.
ipcMain.handle('nexus:ssoAvailable', () => !!(config.nexusOauthClientId || config.nexusAppSlug))

// Current Nexus credential for API calls: OAuth bearer (refreshed when close
// to expiry) or the SSO-era API key. Null when logged out.
async function getNexusAuth() {
  const oauth = store.get('nexusOauth')
  if (oauth && oauth.accessToken) {
    const nearExpiry = oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000
    if (nearExpiry && oauth.refreshToken && config.nexusOauthClientId) {
      try {
        const t = await nexus.refreshOauth(config.nexusOauthClientId, oauth.refreshToken)
        const next = {
          accessToken:  t.access_token,
          refreshToken: t.refresh_token || oauth.refreshToken,
          expiresAt:    Date.now() + (t.expires_in ? t.expires_in * 1000 : 6 * 3600 * 1000),
        }
        store.set('nexusOauth', next)
        log('[nexus] OAuth token refreshed')
        return { bearer: next.accessToken }
      } catch (err) {
        log('[nexus] token refresh failed:', err.message)
        // The old token may still work; the API answers 401 if not.
      }
    }
    return { bearer: oauth.accessToken }
  }
  const key = store.get('nexusApiKey')
  return key ? { apiKey: key } : null
}

ipcMain.handle('nexus:ssoLogin', async () => {
  try {
    if (config.nexusOauthClientId) {
      const tokens = await nexus.oauthLogin({
        clientId: config.nexusOauthClientId,
        port:     config.nexusOauthPort,
        openUrl:  url => shell.openExternal(url),
      })
      store.set('nexusOauth', {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt:    Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : 6 * 3600 * 1000),
      })
      store.set('nexusApiKey', '')   // the bearer token replaces any old key
      const user = await nexus.oauthUserInfo(tokens.access_token)
      store.set('nexusUser', user)
      log(`[nexus] OAuth login as ${user.name} (premium: ${user.isPremium})`)
      return { success: true, user }
    }

    if (!config.nexusAppSlug) {
      return { success: false, error: 'Nexus login is not configured in this build (missing OAuth client id / application slug).' }
    }
    const apiKey = await nexus.ssoLogin(config.nexusAppSlug, url => shell.openExternal(url))
    const user   = await nexus.validateKey(apiKey)
    store.set('nexusApiKey', apiKey)
    store.set('nexusUser', user)
    log(`[nexus] SSO login as ${user.name} (premium: ${user.isPremium})`)
    return { success: true, user }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Isolated game copy

ipcMain.handle('game:isolatedStatus', () => ({
  enabled: !!store.get('isolatedGame'),
  ready:   isolatedGameReady(),
  dir:     isolatedGameDir(),
  base:    store.get('baseDirPath') || '',
}))

// True if either path is the same as, or nested inside, the other; junctions are followed so a linked folder compares as its target.
function pathsOverlap(a, b) {
  const real = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
  const norm = p => real(p).replace(/[\\/]+$/, '').toLowerCase() + path.sep
  const na = norm(a), nb = norm(b)
  return na.startsWith(nb) || nb.startsWith(na)
}

ipcMain.handle('game:createIsolated', async (_e, baseDirOverride, opts) => {
  if (installing) {
    return { success: false, error: 'An install is already running - wait for it to finish.' }
  }
  installing = true
  try {
    return await createIsolatedImpl(baseDirOverride, !!(opts && opts.force))
  } finally {
    installing = false
  }
})

// force re-copies vanilla and deletes the Creation files and strays; other Repair sections stay
async function createIsolatedImpl(baseDirOverride, force = false) {
  const src = store.get('skyrimPath')
  if (!src || !fs.existsSync(path.join(src, 'SkyrimSE.exe'))) {
    return { success: false, error: 'Set a valid Skyrim path first (SkyrimSE.exe not found).' }
  }

  // Never copy a wrong-version exe into the portable install
  const gv = gameversion.checkGameVersion(src, mo2.detectEdition(src))
  if (!gv.ok) {
    showGameVersionDialog(gv)
    return { success: false, error: `Skyrim ${gv.version} found; downgrade to ${gv.required} before installing the game copy.` }
  }

  if (!findOriginalPrefsIni()) {
    return { success: false, error: NEVER_LAUNCHED_ERROR }
  }

  // No clean-install check needed: copyGameDir copies only vanilla files, so a modded source is fine.

  // Install target: the Install Location field, else the stored/default base dir.
  let base = (typeof baseDirOverride === 'string' && baseDirOverride.trim()) ||
             store.get('baseDirPath') || DEFAULT_BASE_DIR

  // Portable instance fix: nest a generic folder under \Alduinak
  if (path.basename(base).toLowerCase() !== 'alduinak' &&
      !fs.existsSync(path.join(base, 'alduinak-instance.txt'))) {
    base = path.join(base, 'Alduinak')
  }

  const dst = path.join(base, 'skyrim')

  // Dummy protection for those trying to install it on their base directory
  if (pathsOverlap(src, dst) || pathsOverlap(src, base)) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Cannot install on top of itself',
      message: 'Warning, you are trying to download the game on top of itself. ' +
               'Please choose a new spot to install a copy of Skyrim, such as the root folder (c:/).',
      detail:
        'Alduinak uses a portable Skyrim install for maximum compatibility with other modlists or servers.\n' +
        "If you're short on disk space, you can turn this feature off in the troubleshooting tab.",
      buttons: ['OK'],
      defaultId: 0,
    })
    return {
      success: false,
      error: 'Choose an install location OUTSIDE your Skyrim folder. ' +
             'Portable install is for compatibility. If you lack the diskspace, turn off portable install.',
    }
  }

  try {
    store.set('baseDirPath', base)
    // Mark this folder as an Alduinak instance so future setups reuse it in
    // place instead of nesting again.
    try { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, 'alduinak-instance.txt'), '') } catch {}
    send('isolated:progress', 'Installing Mod Organizer 2…')
    await mo2.ensureInstalled(msg => send('isolated:progress', msg))

    let manifest = null
    let vd = null
    if (force) {
      // The copy folder could have become a link into the original install since the first check
      if (pathsOverlap(src, dst)) return { success: false, error: 'The game copy folder resolves into your original Skyrim install - remove the link before repairing.' }
      send('isolated:progress', 'Removing the old vanilla game files…')
      try { fs.rmSync(path.join(dst, 'vanilla-copy-complete.json'), { force: true }) } catch {}
      for (const job of vanillaJobs(src)) {
        try { fs.rmSync(path.join(dst, job.sub, job.rel), { force: true }) } catch {}
      }
      try { manifest = await fetchJSON(MANIFEST_URL()) } catch (err) { log(`[isolated] no manifest, strays and Creation files stay: ${err.message}`) }
      if (manifest && Number(manifest.schema) > MANIFEST_SCHEMA) manifest = null
      try { vd = await fetchJSON(`${config.apiUrl}/api/files/version`) } catch {}
      if (manifest) {
        send('isolated:progress', 'Removing the Creation Club files…')
        for (const rel of [CREATIONS_STAMP, ...((manifest.creations && manifest.creations.files) || []).map(f => f.to)]) {
          try { fs.rmSync(path.join(dst, ...String(rel).split('/')), { force: true }) } catch {}
        }
      }
    }
    // portable copy setup (re-copies when a previous copy was interrupted:
    // SkyrimSE.exe lands first, so its presence alone proves nothing)
    if (force || !gameCopyComplete(dst)) {
      const copy = await copyGameDir(src, dst)
      if (!copy.success) return copy
    } else {
      log('[isolated] reusing existing game copy at ' + dst)
    }
    if (manifest) {
      const strays = removeGameCopyStrays(dst, manifest, clientZipFiles(manifest, vd))
      if (strays) send('isolated:progress', `Removed ${strays} stray file(s) from the game copy`)
    }
    send('isolated:progress', 'Cleaning the Skyrim masters…')
    const masters = await ensureCleanedMasters(dst, { portable: true })
    if (masters.warning) log(`[isolated] ${masters.warning}`)

    // configuration
    let serverInfo = null
    try { serverInfo = await fetchJSON(serverInfoUrl()) } catch {}
    mo2.ensureInstance(dst, serverInfo?.loadOrder)
    mo2.registerNxmHandler()
    seedProfilePrefs(src)

    store.set('isolatedGame', true)
    store.set('mo2Enabled', true)

    log(`[isolated] Alduinak install ready at ${base}`)
    return { success: true, dir: base }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// Vanilla root files, by store edition. Only those present get copied.
// Skyrim.ccc is deliberately NOT copied: no cc* plugins are copied either, and
// an orphan ccc list makes the engine treat the AE/CC content set as changed,
// which pops the Creation Club announcement over the main menu on first boot.
// That box is modal and SkyrimPlatform cannot dismiss pre-game menus.
// copyGameDir instead writes an EMPTY Skyrim.ccc and applyForcedServerDefaults keeps it empty.
// With the Bethesda.net platform disabled too, AE owners never get the "download AE content" prompt.
const VANILLA_ROOT_FILES = [
  'SkyrimSE.exe', 'SkyrimSELauncher.exe', 'bink2w64.dll',
  'steam_api64.dll', 'Galaxy64.dll', 'EOSSDK-Win64-Shipping.dll',
  'High.ini', 'Medium.ini', 'Low.ini', 'Ultra.ini', 'Skyrim_Default.ini',
  'installscript.vdf',
]

// Vanilla BSAs the engine loads without a matching plugin (cc* still excluded).
const VANILLA_STANDALONE_BSAS = new Set(['marketplacetextures.bsa', '_resourcepack.bsa'])

// A Data file is vanilla if it is a known master or a vanilla-named BSA (cc* excluded).
function isVanillaDataFile(name) {
  const l = name.toLowerCase()
  if (l.startsWith('cc')) return false
  if (VANILLA_MASTERS.has(l)) return true
  if (l.endsWith('.bsa')) {
    if (l.startsWith('skyrim - ') || VANILLA_STANDALONE_BSAS.has(l)) return true
    const base = l.replace(/\.bsa$/, '')
    return base === 'skyrim' || VANILLA_MASTERS.has(`${base}.esm`) || VANILLA_MASTERS.has(`${base}.esl`)
  }
  return false
}

// The vanilla file inventory of a source install: exactly what copyGameDir
// copies, and what the integrity check verifies. Only vanilla files can ever
// appear here (isVanillaDataFile), so skse, the engine-fixes preloader, and
// downloaded client files are naturally out of scope.
function vanillaJobs(src) {
  const jobs = []
  for (const name of VANILLA_ROOT_FILES) {
    if (fs.existsSync(path.join(src, name))) jobs.push({ rel: name, sub: '' })
  }
  const dataDir = path.join(src, 'Data')
  try {
    for (const e of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (e.isFile() && isVanillaDataFile(e.name)) jobs.push({ rel: e.name, sub: 'Data' })
    }
  } catch { /* no Data dir; the SkyrimSE.exe check already guards the source */ }
  try {
    for (const e of fs.readdirSync(path.join(dataDir, 'Video'), { withFileTypes: true })) {
      if (e.isFile()) jobs.push({ rel: e.name, sub: path.join('Data', 'Video') })
    }
  } catch { /* no Video folder */ }
  try {
    // Vanilla loose strings exist on localized installs; English keeps them in the BSAs.
    const bases = [...VANILLA_MASTERS].map(m => m.replace(/\.es[mlp]$/, ''))
    for (const e of fs.readdirSync(path.join(dataDir, 'Strings'), { withFileTypes: true })) {
      const l = e.name.toLowerCase()
      if (e.isFile() && !l.startsWith('cc') && bases.some(b => l.startsWith(`${b}_`))) {
        jobs.push({ rel: e.name, sub: path.join('Data', 'Strings') })
      }
    }
  } catch { /* no Strings folder */ }
  return jobs
}

// Copy only Bethesda's vanilla files from the (possibly modded) source so the user's install stays intact.
async function copyGameDir(src, dst) {
  const jobs = vanillaJobs(src)

  if (!jobs.some(j => j.rel.toLowerCase() === 'skyrim.esm')) {
    return { success: false, error: 'Skyrim.esm not found in Data - is the Skyrim path correct?' }
  }

  let copied = 0
  // A fresh run invalidates any previous completion marker.
  try { fs.rmSync(path.join(dst, 'vanilla-copy-complete.json'), { force: true }) } catch {}
  for (const job of jobs) {
    const to = path.join(dst, job.sub, job.rel)
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      await fs.promises.copyFile(path.join(src, job.sub, job.rel), to)
    } catch (err) {
      return { success: false, error: `Failed copying ${job.rel}: ${err.message}` }
    }
    copied++
    send('isolated:progress', `Copying vanilla game files… ${copied}/${jobs.length} (${job.rel})`)
  }
  // AE popup fix: an empty Skyrim.ccc declares no CC content expected, so the engine never prompts AE owners to download it.
  try { fs.writeFileSync(path.join(dst, 'Skyrim.ccc'), '') } catch { /* re-applied by applyForcedServerDefaults */ }
  // Completion marker: file presence alone cannot prove the copy finished
  // (the esms sort after the BSAs, so partial copies look deceptively full).
  try {
    fs.writeFileSync(path.join(dst, 'vanilla-copy-complete.json'),
      JSON.stringify({ files: copied, at: new Date().toISOString() }) + '\n')
  } catch { /* marker is an optimization; the masters check still applies */ }
  log(`[isolated] copied ${copied} vanilla file(s) to ${dst}`)
  return { success: true, copied }
}

// Vanilla files in the game copy that are missing or the wrong size compared
// to the original install; a cleaned master counts as intact.
function vanillaMismatches(src, dir) {
  const sizeOf = p => { try { return fs.statSync(p).size } catch { return -1 } }
  const bad = []
  for (const job of vanillaJobs(src)) {
    const want = sizeOf(path.join(src, job.sub, job.rel))
    const have = sizeOf(path.join(dir, job.sub, job.rel))
    if (want >= 0 && have !== want && !cleanmasters.cleanedSizes(job.rel).includes(have)) bad.push(job)
  }
  return bad
}

// Vanilla integrity gate, run on every install pass. Portable copies are
// verified against the player's original install and repaired file by file;
// when playing from the real install there is no clean source to copy from,
// so a failed check only warns (verify the game in Steam/GOG instead).
async function ensureVanillaIntegrity(gamePath) {
  const portable = store.get('isolatedGame') && isolatedGameReady() && gamePath === isolatedGameDir()
  if (portable) {
    const original = store.get('skyrimPath')
    if (!original || !fs.existsSync(path.join(original, 'Data', 'Skyrim.esm'))) {
      // No source to verify against; the launch gate still blocks a broken copy.
      return { ok: true, warning: null }
    }
    const bad = vanillaMismatches(original, gamePath)
    if (bad.length === 0) return { ok: true, warning: null }
    log(`[integrity] repairing ${bad.length} vanilla file(s): ${bad.map(j => j.rel).join(', ')}`)
    let done = 0
    for (const job of bad) {
      const to = path.join(gamePath, job.sub, job.rel)
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        await fs.promises.copyFile(path.join(original, job.sub, job.rel), to)
      } catch (err) {
        return { ok: false, error: `Vanilla file repair failed on ${job.rel}: ${err.message}` }
      }
      done++
      send('install:progress', { phase: 'download', file: `Repairing vanilla game files… ${done}/${bad.length} (${job.rel})`, index: done, total: bad.length, skipped: false })
    }
    return { ok: true, warning: null, repaired: done }
  }
  // Real install: the masters every SE edition ships must at least exist.
  const missing = [...VANILLA_MASTERS]
    .filter(m => m !== '_resourcepack.esl')
    .filter(m => !fs.existsSync(path.join(gamePath, 'Data', m)))
  if (missing.length > 0) {
    return { ok: true, warning: `Vanilla file check failed: ${missing.join(', ')} missing from the game folder. Verify the game files in Steam/GOG Galaxy.` }
  }
  return { ok: true, warning: null }
}

// First-launch sanity check
// The game writes its My Games inis (and registry entries) the first time
// vanilla Skyrim reaches the main menu. Installing MO2 before that leaves the
// profile with unconfigured defaults and the engine unregistered, which
// breaks in confusing ways - so installs are blocked until the ini exists.
// Folder name varies by store edition, mirroring pluginsTxtDirs().
const MYGAMES_VARIANTS = [
  'Skyrim Special Edition',
  'Skyrim Special Edition GOG',
  'Skyrim Special Edition EPIC',
  'Skyrim Special Edition MS',
]

function findOriginalPrefsIni() {
  const docs = app.getPath('documents')
  for (const v of MYGAMES_VARIANTS) {
    const p = path.join(docs, 'My Games', v, 'SkyrimPrefs.ini')
    if (fs.existsSync(p)) return p
  }
  return null
}

const NEVER_LAUNCHED_ERROR =
  'Skyrim has never been launched on this PC (no SkyrimPrefs.ini in Documents\\My Games). ' +
  'Start the game once the normal way (Steam/GOG), reach the main menu, quit, then run this install again.'

// Startup warning, once per launch. Fires only when a Skyrim install was found
// but the My Games inis are missing; a missing game has its own renderer flow.
let neverLaunchedWarned = false
async function maybeWarnNeverLaunched() {
  if (neverLaunchedWarned) return
  neverLaunchedWarned = true
  if (!store.get('skyrimPath') || findOriginalPrefsIni()) return
  return dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Skyrim has never been launched',
    message: "Skyrim's My Documents ini files are missing.",
    detail:
      'Run vanilla Skyrim once (Steam/GOG), reach the main menu, then quit so the game creates them. ' +
      'The Alduinak install steps stay blocked until then.',
    buttons: ['OK'],
    defaultId: 0,
  })
}

// Wrong game version popup with a button to the Reliquary downgrade page
let gameVersionDialogOpen = false
async function showGameVersionDialog(gv) {
  if (gameVersionDialogOpen || !win || win.isDestroyed()) return
  gameVersionDialogOpen = true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Wrong Skyrim version',
      message: `Skyrim is version ${gv.version}, but Alduinak needs ${gv.required}.`,
      detail:
        `Checked: ${gv.exe}\n\n` +
        'Use the Reliquary downgrade tool from Nexus Mods to switch Skyrim Special Edition to build 1.6.1170; it only downloads the files that differ. ' +
        'Afterwards set Steam to "Only update this game when I launch it" so it stays on that build, then press PLAY again.' +
        (gv.required === gameversion.GAME_VERSION_GOG
          ? '\n\nGOG installs: roll back to 1.6.1179 through GOG Galaxy (Manage installation > Configure > Version) instead of Reliquary.'
          : ''),
      buttons: ['Open downgrade page', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) shell.openExternal(gameversion.GAME_DOWNGRADE_URL)
  } finally {
    gameVersionDialogOpen = false
  }
}

// Checks the original install first (the portable copy is rebuilt from it), then the copy that actually runs
function gameVersionProblem() {
  for (const dir of [store.get('skyrimPath'), isolatedGameReady() ? isolatedGameDir() : null]) {
    if (!dir) continue
    const gv = gameversion.checkGameVersion(dir, mo2.detectEdition(dir))
    log(`[version] ${gv.exe} = ${gv.version || 'unreadable'}`)
    if (!gv.ok) return gv
  }
  return null
}

// Seed the MO2 profile SkyrimPrefs.ini from the player's own prefs, then
// rewrite the server's forced window mode (borderless) on top. Resolution is
// deliberately NOT rewritten: it stays whatever the player's ini says, and
// the Settings tab only shows 1080p as a fallback when the ini has none.
function seedProfilePrefs(skyrimPath) {
  const dest = path.join(mo2.getProfileDir(), 'skyrimprefs.ini')
  if (fs.existsSync(dest)) return
  const candidates = [
    path.join(skyrimPath, 'Skyrim', 'SkyrimPrefs.ini'),
    findOriginalPrefsIni(),
  ].filter(Boolean)
  for (const from of candidates) {
    if (!fs.existsSync(from)) continue
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(from, dest)
      ini.write(dest, {
        Display: { 'bFull Screen': '0', 'bBorderless': '1' },
      })
      log(`[isolated] seeded profile SkyrimPrefs.ini from ${from}`)
    } catch (err) {
      log(`[isolated] could not seed SkyrimPrefs.ini: ${err.message}`)
    }
    return
  }
  log('[isolated] no source SkyrimPrefs.ini found to seed')
}

// Servers
ipcMain.handle('api:servers', async () => {
  try {
    const servers = await fetchJSON(`${config.apiUrl}/api/servers`)
    if (Array.isArray(servers) && servers.length > 0) store.set('cachedServers', servers)
    return servers
  } catch {
    return store.get('cachedServers') || []
  }
})

// Modlist
ipcMain.handle('api:modlist', async () => {
  try {
    const items = await fetchJSON(`${config.apiUrl}/api/modlist`)
    return { ok: true, items: Array.isArray(items) ? items : [] }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Game process detection
// Used by the renderer to switch the Play button into its "running" state.
function isProcessRunning(imageName) {
  return new Promise(resolve => {
    require('child_process').exec(
      `tasklist /FI "IMAGENAME eq ${imageName}" /NH`,
      { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(!err && stdout.toLowerCase().includes(imageName.toLowerCase()))
    )
  })
}

// Lightweight update probe for the Play/Update button: compares the server's
// published client-files version with what was last installed.
ipcMain.handle('files:updateCheck', async () => {
  try {
    const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
    const gamePath   = effectiveGamePath()
    const allPresent = clientFilesPresent(gamePath, store.get('mo2Enabled'))
    // A failed modpack install also flips the Play button to UPDATE so one
    // click re-runs the install and self-heals the incomplete state.
    const modpackFailed = store.get('mo2Enabled') && store.get('modpackState') === 'failed'
    return {
      ok: true,
      updateAvailable: vd.version !== store.get('filesVersion') || !allPresent || modpackFailed,
      serverVersion:   vd.version,
    }
  } catch {
    return { ok: false, updateAvailable: false }
  }
})

// MO2 can take a while to boot Skyrim, so a fresh launch blocks relaunching until the game shows up or this runs out
const LAUNCH_GRACE_MS = 90_000
let launchInFlight = false
let launchStartedAt = 0

let gameWasRunning = false
async function gameProcessRunning() {
  if (process.platform !== 'win32') return false
  const running = (await isProcessRunning('SkyrimSE.exe')) || (await isProcessRunning('skse64_loader.exe'))
  if (running) launchStartedAt = 0
  if (gameWasRunning && !running) adoptChatFov()
  gameWasRunning = running
  setPresenceRunning(running)
  return running
}

// Refuses a launch while another is being prepared, starting, or the game already runs
async function guardLaunch(launch) {
  if (launchInFlight) return { success: false, error: 'The game is already launching.' }
  launchInFlight = true
  try {
    if (await gameProcessRunning()) return { success: false, error: 'Skyrim is already running.' }
    if (Date.now() - launchStartedAt < LAUNCH_GRACE_MS) {
      return { success: false, error: 'Skyrim is still starting - give MO2 a moment.' }
    }
    const result = await launch()
    if (result.success) launchStartedAt = Date.now()
    return result
  } finally {
    launchInFlight = false
  }
}

ipcMain.handle('game:isRunning', gameProcessRunning)

// Launcher update check
ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    const latest    = data.version
    const hasUpdate = compareVersions(latest, current) > 0
    return { current, latest, hasUpdate, downloadUrl: data.downloadUrl || '' }
  } catch {
    return { current, latest: null, hasUpdate: false, downloadUrl: '' }
  }
})

// Reject remote plain-HTTP downloads of payloads we run or extract: guards
// against MITM tampering and https->http redirect downgrades. Loopback stays
// allowed so the http://localhost dev backend still works.
function assertSecureDownloadUrl(url) {
  if (/^https:/i.test(url)) return
  let host = ''
  try { host = new URL(url).hostname } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return
  throw new Error(`Refusing to download over an insecure (non-HTTPS) URL: ${url}`)
}

// Download a URL to a local file, following redirects (release URLs hit a CDN).
// Settles exactly once on every outcome, including an aborted response.
function downloadToFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    let file = null
    let settled = false
    const finish = val => { if (!settled) { settled = true; resolve(val) } }
    // Destroy the stream before unlinking: an open handle leaves the partial file delete-pending on Windows and blocks every retry this session.
    const fail = err => {
      if (settled) return
      settled = true
      if (file && !file.destroyed) {
        file.once('close', () => { try { fs.unlinkSync(dest) } catch {} reject(err) })
        file.destroy()
      } else {
        try { fs.unlinkSync(dest) } catch {}
        reject(err)
      }
    }
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return fail(new Error('Too many redirects'))
        return finish(downloadToFile(res.headers.location, dest, onProgress, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode}`)) }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      file = fs.createWriteStream(dest)
      res.on('data', c => { received += c.length; if (onProgress) onProgress(received, total) })
      res.pipe(file)
      file.on('finish', () => file.close(() => finish(dest)))
      file.on('error', fail)
      res.on('error',  fail)
      res.on('aborted', () => fail(new Error('Download interrupted')))
    })
    req.on('error', fail)
    req.setTimeout(120_000, () => { req.destroy(); fail(new Error('Download timed out')) })
  })
}

// The website ships the installer inside a zip; a plain exe at the same URL still works
function unpackUpdate(pkg, dest) {
  const fd = fs.openSync(pkg, 'r')
  const magic = Buffer.alloc(2)
  try { fs.readSync(fd, magic, 0, 2, 0) } finally { fs.closeSync(fd) }
  if (magic.toString('latin1') !== 'PK') {
    fs.renameSync(pkg, dest)
    return
  }
  send('update:progress', { phase: 'extract' })
  const exes = new AdmZip(pkg).getEntries().filter(e => !e.isDirectory && /\.exe$/i.test(e.entryName))
  const entry = exes.find(e => /(^|\/)AlduinakLauncher[^/]*\.exe$/i.test(e.entryName)) || (exes.length === 1 ? exes[0] : null)
  if (!entry) throw new Error('The update package has no launcher installer.')
  fs.writeFileSync(dest, entry.getData())
  fs.rmSync(pkg, { force: true })
}

// In-app launcher update: download the new installer, run it silently, and let
// it relaunch us (--force-run). Replaces the "open the download page" flow.
ipcMain.handle('app:installUpdate', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    const url = data.packageUrl || data.downloadUrl
    if (!url) return { ok: false, error: 'No download URL is configured on the server.' }
    // The installer is executed with the user's privileges, so refuse to fetch
    // it over anything but HTTPS (no plain-http, no redirect downgrade).
    if (!/^https:/i.test(url)) {
      return { ok: false, error: 'Refusing to install an update from a non-HTTPS URL.' }
    }

    const pkg  = path.join(os.tmpdir(), 'AlduinakLauncher-update.pkg')
    const dest = path.join(os.tmpdir(), 'AlduinakLauncher-update.exe')
    send('update:progress', { phase: 'download', received: 0, total: 0 })
    await downloadToFile(url, pkg, (received, total) =>
      send('update:progress', { phase: 'download', received, total }))
    try { fs.rmSync(dest, { force: true }) } catch {}
    unpackUpdate(pkg, dest)

    send('update:progress', { phase: 'install' })
    // /S silent + --force-run: NSIS replaces our files and relaunches the app.
    spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 1200)   // release our files so the installer can overwrite
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Launch SKSE

// Data files that must exist before we allow launching
const CLIENT_SCRIPT = 'Platform/Plugins/skymp5-client.js'
const REQUIRED_FILES = [CLIENT_SCRIPT, 'SKSE/Plugins/SkyrimPlatform.dll', 'SKSE/Plugins/MpClientPlugin.dll']

// Engine fixes preloader
const PRELOADER_DLLS = ['d3dx9_42.dll', 'winhttp.dll']
const preloaderPresent = (gamePath) =>
  !!gamePath && PRELOADER_DLLS.some(f => fs.existsSync(path.join(gamePath, f)))

// Tells whether a Data-relative file is in the real Data or, under MO2, in any mod folder
function dataFileFinder(gamePath, viaMO2) {
  let modDirs = []
  if (viaMO2) {
    try {
      modDirs = fs.readdirSync(mo2.getModsDir(), { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(mo2.getModsDir(), e.name))
    } catch {}
  }
  return rel => [path.join(gamePath, 'Data'), ...modDirs].some(dir => fs.existsSync(path.join(dir, ...rel.split('/'))))
}

// True when every client-package file the launcher can check is on disk.
const clientFilesPresent = (gamePath, viaMO2) =>
  !!gamePath &&
  REQUIRED_FILES.every(dataFileFinder(gamePath, viaMO2)) &&
  preloaderPresent(gamePath)

// The manifest mods that carry the SkyMP client; under MO2 they replace the backend's client zip
function clientMods(manifest) {
  const target = CLIENT_SCRIPT.toLowerCase()
  return ((manifest && manifest.mods) || []).filter(m => (m.files || []).some(f => String(f.to).toLowerCase() === target))
}

ipcMain.handle('launch:skse', () => guardLaunch(async () => {
  const skyrimPath = effectiveGamePath()
  const mo2Enabled = store.get('mo2Enabled')

  if (!skyrimPath) {
    return { success: false, error: 'Skyrim path not configured.' }
  }

  if (mo2Enabled && !mo2.isInstalled()) {
    return { success: false, error: 'MO2 is not set up - open Settings → Repair and run Repair MO2.' }
  }

  // Shared pre-launch steps: client settings, load order, file validation.
  const prep = await prepareForLaunch(skyrimPath, mo2Enabled)
  if (!prep.success) return prep

  try {
    if (mo2Enabled) {
      // MO2 manages plugins.txt itself via the profile; launch through its VFS.
      mo2.launchGame(skyrimPath)
    } else {
      // Direct launch (manual mod installs): run SKSE in active game dir
      const exe = path.join(skyrimPath, 'skse64_loader.exe')
      if (!fs.existsSync(exe)) {
        return { success: false, error: `skse64_loader.exe not found in ${skyrimPath}. Install SKSE there, or enable MO2.` }
      }
      spawn(exe, [], { detached: true, stdio: 'ignore', cwd: skyrimPath }).unref()
    }
    return { success: true, loadOrderFixed: prep.loadOrderFixed }
  } catch (err) {
    return { success: false, error: err.message }
  }
}))

/**
 * Common pre-launch pipeline:
 *  1. Re-write skymp5-client-settings.txt so server-ip/port/gameData are current.
 *  2. Sync plugins.txt with the server's published load order (if available).
 *     Blocks the launch when required plugins are missing from Data/.
 *  3. Verify the SkyMP client files exist.
 */
 
// Highest install manifest schema this launcher understands; the backend refuses newer manifests to older launchers
const MANIFEST_SCHEMA = 3
const MANIFEST_URL = () => `${config.apiUrl}/api/install-manifest?schema=${MANIFEST_SCHEMA}`
const UPDATE_LAUNCHER_ERROR = 'This server needs a newer Alduinak launcher. Accept the launcher update (or download it again from the website), then try again.'
const CREATIONS_STAMP = 'creations-complete.json'

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

// Copies the manifest's Creation Club files from the player's own Skyrim install (never downloaded) into gamePath/Data
async function ensureCreations(manifest, gamePath) {
  const c = manifest && manifest.creations
  if (!c || !Array.isArray(c.files) || c.files.length === 0) return { ok: true, warning: null }
  const portable = !!store.get('isolatedGame') && gamePath === isolatedGameDir()
  const sourceRoot = portable ? store.get('skyrimPath') : gamePath
  const dirs = mo2.creationDirs(sourceRoot, c.searchDirs)
  const stampPath = path.join(gamePath, CREATIONS_STAMP)
  const stamp = readJsonOrNull(stampPath)
  const stamped = new Map(stamp && stamp.hash === c.hash && Array.isArray(stamp.files) ? stamp.files.map(f => [String(f.name).toLowerCase(), f]) : [])
  const accepted = (f, size, sha) => (f.accept || []).some(a => a.size === size && String(a.sha256).toLowerCase() === sha)
  const done = []
  const missing = []
  const warnings = []
  const mb = n => (n / 1048576).toFixed(0)

  for (let i = 0; i < c.files.length; i++) {
    const f = c.files[i]
    const to = path.join(gamePath, ...String(f.to).split('/'))
    const progress = text => send('install:progress', { phase: 'download', file: text, index: i, total: c.files.length, skipped: false })
    let st = null
    try { st = fs.statSync(mo2.lp(to)) } catch { /* not there yet */ }
    const prior = stamped.get(f.name.toLowerCase())
    if (st && prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs) { done.push(prior); continue }
    if (st) {
      progress(`Checking ${f.title} (${f.name})…`)
      const sha = await mo2.hashCached(to, st)
      if (accepted(f, st.size, sha)) { done.push({ name: f.name, size: st.size, mtimeMs: st.mtimeMs, sha256: sha }); continue }
      log(`[creations] ${f.name}: ${to} does not match the server copy (size ${st.size}, sha256 ${sha})`)
    }
    progress(`Looking for ${f.title} (${f.name}) in your Skyrim install…`)
    const found = await mo2.locateCreation(f, dirs.filter(d => path.resolve(d, f.name).toLowerCase() !== path.resolve(to).toLowerCase()))
    for (const r of found.rejected) log(`[creations] ${f.name}: ${r.path} does not match the server copy (size ${r.size}, sha256 ${r.sha256})`)
    if (!found.path) {
      if (st && f.kind === 'archive') {
        const sha = await mo2.hashCached(to, st)
        warnings.push(`${f.name} differs from the server copy (sha256 ${sha}) and was kept`)
        done.push({ name: f.name, size: st.size, mtimeMs: st.mtimeMs, sha256: sha })
        continue
      }
      missing.push({ ...f, differs: !!st })
      continue
    }
    if (!found.verified) warnings.push(`${f.name} at ${found.path} differs from the server copy (sha256 ${found.sha256}) and was used anyway`)
    const tmp = `${to}.alduinak-tmp`
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      // Our own quarantine of this install is moved back rather than copied
      if (path.resolve(path.dirname(found.path)).toLowerCase() === path.resolve(gamePath, mo2.CC_QUARANTINE_DIR).toLowerCase()) {
        fs.renameSync(mo2.lp(found.path), mo2.lp(to))
        const moved = fs.statSync(mo2.lp(to))
        done.push({ name: f.name, size: moved.size, mtimeMs: moved.mtimeMs, sha256: found.sha256 })
        log(`[creations] moved ${found.path} back to ${to}`)
        continue
      }
      progress(`Copying ${f.title} (${f.name}, ${mb(found.size)} MB) from ${found.path}…`)
      await fs.promises.copyFile(mo2.lp(found.path), mo2.lp(tmp))
      const tst = fs.statSync(mo2.lp(tmp))
      if (tst.size !== found.size || await mo2.sha256FileAsync(tmp) !== found.sha256) throw new Error('the copy does not match its source')
      fs.renameSync(mo2.lp(tmp), mo2.lp(to))
      const final = fs.statSync(mo2.lp(to))
      done.push({ name: f.name, size: final.size, mtimeMs: final.mtimeMs, sha256: found.sha256 })
      log(`[creations] copied ${found.path} -> ${to}`)
    } catch (err) {
      try { fs.rmSync(mo2.lp(tmp), { force: true }) } catch {}
      return { ok: false, error: `Could not copy ${f.name} from ${found.path}: ${err.message}` }
    }
  }

  if (missing.length > 0) {
    const byTitle = new Map()
    for (const f of missing) byTitle.set(f.title, [...(byTitle.get(f.title) || []), f.differs ? `${f.name}, whose copy in Data is a different version` : f.name])
    const list = [...byTitle].map(([title, names]) => `${title} (${names.join(', ')})`).join(', ')
    return {
      ok: false,
      error: `Alduinak needs the free Creations included with Skyrim Special Edition 1.6 (no Anniversary Edition purchase needed): ${list}. ` +
             `Not found in ${dirs.length ? dirs.join(', ') : `${sourceRoot || 'your Skyrim folder'} (no Data folder found)`}. ` +
             'Verify the game files in Steam (Properties > Installed Files > Verify integrity of game files) or GOG Galaxy, ' +
             'or move them back from the folder another launcher put them in, then press Update again.',
    }
  }
  try { fs.writeFileSync(stampPath, JSON.stringify({ hash: c.hash, files: done }, null, 2) + '\n') } catch { /* the stamp only saves re-hashing */ }
  store.set('creationFiles', c.files.map(f => f.name))
  for (const w of warnings) log(`[creations] ${w}`)
  return { ok: true, warning: warnings.length ? `Creation Club: ${warnings.join('; ')}` : null }
}

function bundledXdelta() {
  return [
    process.resourcesPath ? path.join(process.resourcesPath, 'xdelta', 'xdelta3.exe') : null,
    path.join(__dirname, '..', 'assets', 'xdelta', 'xdelta3.exe'),
  ].find(p => p && fs.existsSync(p)) || null
}

// Downloads a Simple Cleaned Masters patch once into the MO2 downloads folder, verified by sha256
async function cleanedMasterPatch(v) {
  const dir = path.join(mo2.getDownloadsDir(), 'cleaned-masters')
  const file = path.join(dir, v.patch)
  if (fs.existsSync(file) && await mo2.sha256FileAsync(file) === v.patchSha256) return file
  fs.mkdirSync(dir, { recursive: true })
  await downloadToFile(`${config.apiUrl}/files/cleaned-masters/${encodeURIComponent(v.patch)}`, file)
  if (await mo2.sha256FileAsync(file) !== v.patchSha256) {
    try { fs.rmSync(file, { force: true }) } catch {}
    throw new Error(`${v.patch} failed its checksum after download`)
  }
  return file
}

// Cleans the masters and Creation plugins in gamePath/Data; real installs back up the originals, strict turns failures into errors
async function ensureCleanedMasters(gamePath, { force = false, portable = !!store.get('isolatedGame') && gamePath === isolatedGameDir(), strict = false } = {}) {
  const dataDir  = path.join(gamePath, 'Data')
  const original = store.get('skyrimPath')
  const unknown  = []
  const failed   = []
  let cleaned = 0
  for (const m of cleanmasters.MASTERS) {
    const file   = path.join(dataDir, m.name)
    const backup = path.join(dataDir, cleanmasters.BACKUP_DIR, m.name)
    const restoreFrom = portable ? (original && path.join(original, 'Data', m.name)) : backup
    if (force && restoreFrom && fs.existsSync(restoreFrom) && fs.existsSync(file)) {
      await fs.promises.copyFile(restoreFrom, file)
      log(`[masters] restored ${m.name} from ${restoreFrom}`)
    }
    let size = -1
    try { size = fs.statSync(file).size } catch { continue }   // masters and Creations are installed by their own steps
    const v = cleanmasters.classify(m.name, size)
    if (v === 'cleaned') continue
    if (!v) { unknown.push(`${m.name} (size ${size})`); continue }

    send('install:progress', { phase: 'download', file: `Cleaning ${m.name} (${v.edition})…`, index: cleaned, total: 0, skipped: false })
    const xdelta = bundledXdelta()
    if (!xdelta) {
      const error = 'xdelta3.exe is missing from the launcher install. Reinstall the launcher.'
      if (strict) return { ok: false, error }
      log(`[masters] ${error}`)
      failed.push(m.name)
      break
    }
    const tmp = `${file}.alduinak-tmp`
    try {
      const patch = await cleanedMasterPatch(v)
      const failure = await new Promise(resolve => execFile(xdelta, ['-d', '-f', '-s', file, patch, tmp], { windowsHide: true, timeout: 10 * 60 * 1000 },
        (err, _out, stderr) => resolve(err ? (String(stderr || '').trim() || err.message) : null)))
      if (failure) throw new Error(failure)
      if (fs.statSync(tmp).size !== v.dstSize || (v.dstSha256 && await mo2.sha256FileAsync(tmp) !== v.dstSha256)) throw new Error('the patched file does not match the cleaned master')
      if (!portable && !fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(backup), { recursive: true })
        await fs.promises.copyFile(file, backup)
      }
      fs.renameSync(tmp, file)
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }) } catch {}
      const error = `Could not clean ${m.name}: ${err.message}`
      if (strict) return { ok: false, error }
      log(`[masters] ${error}`)
      failed.push(m.name)
      continue
    }
    cleaned++
    log(`[masters] cleaned ${m.name} (${v.edition})`)
  }
  if (unknown.length) log(`[masters] no cleaning patch for this build of ${unknown.join(', ')}`)
  const warning = [
    unknown.length ? `No cleaned-master patch for ${unknown.join(', ')}; they stay as shipped.` : null,
    failed.length ? `Could not clean ${failed.join(', ')}; they stay as shipped (see install.log, or use Repair Cleaned Masters).` : null,
  ].filter(Boolean).join(' ') || null
  return { ok: true, cleaned, warning }
}

// The client zip's file list when no manifest mod carries the client, [] when one does, null when the list is unknown
function clientZipFiles(manifest, vd) {
  if (clientMods(manifest).length > 0) return []
  return vd && Array.isArray(vd.files) ? vd.files.map(f => String(f.path)) : null
}

// Matches the game-root-relative paths the launcher puts in the portable copy, plus the game's in-game rebinds file
function gameCopyAllowlist(src, manifest, zipFiles) {
  const keep = new Set([
    ...vanillaJobs(src).map(j => path.join(j.sub, j.rel)),
    'Skyrim.ccc', 'vanilla-copy-complete.json', CREATIONS_STAMP, ...PRELOADER_DLLS,
    'Data/Platform/Plugins/skymp5-client-settings.txt',
    'Data/Platform/PluginsNoLoad/auth-data-no-load.js',
    'Data/Interface/Controls/PC/controlmap.txt',
    'ControlMap_Custom.txt',
    ...((manifest.creations && manifest.creations.files) || []).map(f => f.to),
    ...(manifest.root || []).map(f => f.to),
    ...zipFiles,
  ].map(p => String(p).split(path.sep).join('/').toLowerCase()))
  return rel => {
    const l = rel.toLowerCase()
    return keep.has(l) || /^skse64_[^/]*\.(exe|dll)$/.test(l) || CLIENT_OWN_FILE_RES.some(re => re.test(l))
  }
}

// Files in the portable game copy the launcher never installs; [] whenever a cleanup would not be safe
function gameCopyStrays(gamePath, manifest, zipFiles) {
  const src  = store.get('skyrimPath')
  const base = store.get('baseDirPath')
  const safe = !!(store.get('isolatedGame') && store.get('mo2Enabled') && base && gamePath === isolatedGameDir() &&
    fs.existsSync(path.join(base, 'alduinak-instance.txt')) && src && !pathsOverlap(src, gamePath) &&
    fs.existsSync(path.join(src, 'Data', 'Skyrim.esm')) && manifest && Array.isArray(zipFiles))
  if (!safe) return []
  const kept = gameCopyAllowlist(src, manifest, zipFiles)
  return mo2.listFilesRel(gamePath).filter(rel => {
    if (kept(rel)) return false
    try { return !fs.lstatSync(path.join(gamePath, ...rel.split('/'))).isSymbolicLink() } catch { return false }
  })
}

function removeGameCopyStrays(gamePath, manifest, zipFiles) {
  const strays = gameCopyStrays(gamePath, manifest, zipFiles)
  for (const rel of strays) {
    const full = path.join(gamePath, ...rel.split('/'))
    try {
      fs.rmSync(mo2.lp(full), { force: true })
      log(`[game] removed stray file ${rel}`)
    } catch (err) {
      log(`[game] could not remove stray file ${rel}: ${err.message}`)
    }
    for (let dir = path.dirname(full); dir.length > gamePath.length; dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir) } catch { break }
    }
  }
  ensureClientDirs(gamePath)
  return strays.length
}

// Adds two missing folders to prevent a code 2 crash
function ensureClientDirs(gamePath) {
  if (!gamePath) return
  for (const d of ['PluginsDev', 'PluginsNoLoad']) {
    try { fs.mkdirSync(path.join(gamePath, 'Data', 'Platform', d), { recursive: true }) } catch {}
  }
}

/** Read-only pre-launch staging check; returns a list of problems (empty = ready to launch). */
function verifyLaunchReadiness(skyrimPath, viaMO2, serverInfo) {
  const problems = []

  // SkyMP / Skyrim Platform client files.
  const found = dataFileFinder(skyrimPath, viaMO2)
  const missingFiles = REQUIRED_FILES.filter(f => !found(f))
  if (missingFiles.length > 0) {
    const names = missingFiles.map(f => path.basename(f)).join(', ')
    problems.push(`Client files missing (${names}); run Repair SkyMP Client in Settings first.`)
  }

  // SKSE runtime.
  if (!fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))) {
    problems.push('SKSE is not installed (skse64_loader.exe missing); install the modpack first.')
  }

  // Vanilla masters: without them the engine hard-crashes before the menu.
  if (!fs.existsSync(path.join(skyrimPath, 'Data', 'Skyrim.esm')) ||
      !fs.existsSync(path.join(skyrimPath, 'Data', 'Update.esm'))) {
    problems.push('Vanilla game files missing (Skyrim.esm/Update.esm); click UPDATE to repair the game copy.')
  }

  // Server load order: every required plugin must be present.
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    const missingPlugins = missingServerPlugins(skyrimPath, serverInfo.loadOrder, viaMO2)
    if (missingPlugins.length > 0) {
      problems.push(`Required plugins missing (${missingPlugins.join(', ')}); install the server modlist first.`)
    }
  }

  // Fallback if install fails
  if (viaMO2 && store.get('modpackState') === 'failed') {
    problems.push('The last modpack install did not finish. Press PLAY (it will show UPDATE) or run Repair Modlist to complete it first.')
  }

  // Fallback for engine fixes failure (like with AV software)
  if (!preloaderPresent(skyrimPath)) {
    problems.push('The Engine Fixes preloader dll is missing from the game folder; press PLAY (it will show UPDATE) to restore it.')
  }

  // Online servers need a launcher Discord login so auth-data-no-load.js can be seeded; without it SkyMP shows its own auth menu and never connects.
  if (serverInfo && serverInfo.offlineMode === false) {
    const session   = store.get('gameSession')
    const user      = store.get('discordUser')
    const profileId = store.get('gameProfileId')
    if (!(session && user && profileId != null)) {
      problems.push('Discord login required; log in from the launcher topbar before playing, otherwise the in-game auth menu appears and you stay on the main menu.')
    }
  }

  return problems
}

async function prepareForLaunch(skyrimPath, viaMO2) {
  ensureClientDirs(skyrimPath)

  // Version gate; the dialog is not awaited so the warning strip updates while it is up
  const gv = gameversion.checkGameVersion(skyrimPath, mo2.detectEdition(skyrimPath))
  if (!gv.ok) {
    showGameVersionDialog(gv)
    return { success: false, error: `Skyrim ${gv.version} found in ${skyrimPath}; Alduinak needs ${gv.required}. Downgrade it (see the popup), then press PLAY again.` }
  }

  quarantineContentCatalogs()

  const srv = activeServer()
  let serverInfo = null
  if (srv) {
    try { serverInfo = await fetchJSON(serverInfoUrl()) } catch {}
  }

  // Non-portable installs play from the user's real Skyrim folder: quarantine
  // Creation Club content the server doesn't use into "disabled CC mods", or
  // the engine force-loads it via Skyrim.ccc and fights the server load order.
  // The isolated game copy never receives cc* files, so this is a no-op there.
  if (skyrimPath === store.get('skyrimPath')) {
    mo2.disableCcContent(skyrimPath, serverInfo?.loadOrder, store.get('creationFiles'))
  }

  if (Number(serverInfo?.manifestSchema) > MANIFEST_SCHEMA) {
    return { success: false, error: UPDATE_LAUNCHER_ERROR }
  }

  // Staging gate: surface everything missing before we write settings or launch
  const notReady = verifyLaunchReadiness(skyrimPath, viaMO2, serverInfo)
  if (notReady.length > 0) {
    return { success: false, error: 'Not ready to launch:\n' + notReady.map(p => '• ' + p).join('\n') }
  }

  if (srv) {
    const settingsPath = path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')
    try {
      writeClientSettings(settingsPath, srv, serverInfo)
      log('[launch] client settings written')
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  applyControlmapOverride(skyrimPath)

  // Load order sync
  let loadOrderFixed = false
  // Heal the instance ini (paths + SKSE shortcut) before every MO2 launch, even when serverinfo is unavailable.
  if (viaMO2) mo2.ensureInstance(skyrimPath, serverInfo?.loadOrder)
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    if (viaMO2) {
      const missing = missingServerPlugins(skyrimPath, serverInfo.loadOrder, true)
      if (missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${missing.join(', ')}. ` +
                 `Run Repair Modlist in Settings first.`,
        }
      }
      loadOrderFixed = true
    } else {
      const result = fixLoadOrder(skyrimPath, serverInfo.loadOrder)
      loadOrderFixed = result.changed
      if (result.missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${result.missing.join(', ')}. ` +
                 `Install the server's modlist first (see the Modlist panel).`,
        }
      }
      if (result.changed) log('[launch] plugins.txt updated to match server load order')
    }
  } else {
    log('[launch] server load order unavailable - leaving plugins.txt untouched')
  }

  // MO2 lockdown
  // Disables plugins or skse scripts not part of the server files
  if (viaMO2) {
    // Wipe stray plugins/BSAs from the overwrite folder first: they load at top
    // priority and would otherwise desync the client load order from the server.
    const wiped = mo2.cleanOverwrite()
    if (wiped.length > 0) log(`[launch] cleaned stray overwrite items: ${wiped.join(', ')}`)
    const removed = mo2.enforceModRules()
    if (removed.length > 0) log(`[launch] disabled unauthorised mods: ${removed.join(', ')}`)
  }

  // Launch sanity check: report our files version + plugin list so the backend
  // approves this session for the game server's session validation. Backend
  // unreachable = fail open (the server itself still enforces at connect).
  const session = store.get('gameSession')
  if (session && serverInfo && serverInfo.offlineMode === false) {
    try {
      const check = await postJSON(`${config.apiUrl}/api/launch-check`, {
        filesVersion: store.get('filesVersion') || '',
        plugins: Array.isArray(serverInfo.loadOrder)
          ? serverInfo.loadOrder.map(f => path.basename(f))
          : [],
        manifestSchema: MANIFEST_SCHEMA,
      }, { 'x-session': session })
      if (!check.ok) {
        if (check.filesOk === false) {
          return { success: false, error: 'Your client files are out of date. Press the button again to update, then launch.' }
        }
        return { success: false, error: 'Your plugin load order does not match the server. Run Repair Modlist in Settings.' }
      }
      log('[launch] launch-check passed')
    } catch (err) {
      log(`[launch] launch-check unavailable (${err.message}) - continuing, server will enforce`)
    }
  }

  // SKSE, client files, plugins, and Discord auth were all confirmed by the staging gate above.
  return { success: true, loadOrderFixed }
}

const VANILLA_MASTERS = new Set([
  'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm', '_resourcepack.esl',
])

function pluginsTxtDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const variants = [
    'Skyrim Special Edition',
    'Skyrim Special Edition GOG',
    'Skyrim Special Edition EPIC',
    'Skyrim Special Edition MS',
  ]
  const existing = variants.map(v => path.join(local, v)).filter(p => fs.existsSync(p))
  return existing.length > 0 ? existing : [path.join(local, variants[0])]
}

function quarantineContentCatalogs() {
  for (const dir of pluginsTxtDirs()) {
    const file = path.join(dir, 'ContentCatalog.txt')
    if (!gameversion.catalogFrom17(readJsonOrNull(file))) continue
    try {
      fs.renameSync(file, `${file}.alduinak-bak`)
      log(`[catalog] moved ${file} aside: written by Skyrim 1.7, which crashes 1.6 at startup`)
    } catch (err) {
      log(`[catalog] could not move ${file} aside: ${err.message}`)
    }
  }
}

// Plugin sync
function fixLoadOrder(skyrimPath, serverLoadOrder) {
  const dataDir = path.join(skyrimPath, 'Data')

  const serverPlugins = serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()))

  const missing = serverPlugins.filter(f => !fs.existsSync(path.join(dataDir, f)))
  if (missing.length > 0) return { changed: false, missing }

  const next  = serverPlugins.map(f => `*${f}`).join('\r\n') + '\r\n'
  let changed = false

  for (const dir of pluginsTxtDirs()) {
    const pluginsPath = path.join(dir, 'Plugins.txt')

    let current = null
    try { current = fs.readFileSync(pluginsPath, 'utf8') } catch {}

    if (current !== next) {
      const dropped = (current || '')
        .split(/\r?\n/)
        .filter(l => l.startsWith('*'))
        .map(l => l.slice(1).trim())
        .filter(f => f && !serverPlugins.some(p => p.toLowerCase() === f.toLowerCase()) &&
                     !VANILLA_MASTERS.has(f.toLowerCase()))
      if (dropped.length > 0) {
        log(`[launch] disabling client-side plugins (not allowed on this server): ${dropped.join(', ')}`)
      }
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(pluginsPath, next)
      changed = true
      log(`[launch] wrote ${pluginsPath} (exactly ${serverPlugins.length} server plugins)`)
    }
  }

  return { changed, missing: [] }
}

function missingServerPlugins(skyrimPath, serverLoadOrder, viaMO2) {
  const found = dataFileFinder(skyrimPath, viaMO2)
  return serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()) && !found(f))
}

// Install files

let installing   = false
let installAbort = null   // AbortController for the running install's waits

// opts.force: 'client' rebuilds the client mods under MO2 (else re-downloads the zip), 'modlist' rebuilds every mod (Repair buttons).
ipcMain.on('install:start', (_e, mode, opts) => {
  if (installing) {
    // Never ignore the click silently: the user has no other way to know an
    // earlier install is still running (e.g. parked on a downloads wait).
    send('install:progress', {
      phase: 'mods',
      file: 'An install is already running - press Cancel Install to stop it first.',
      index: 0, total: 0, skipped: false,
    })
    send('install:complete', { success: false, error: 'An install is already running - wait for it to finish.' })
    return
  }
  installing = true
  installAbort = new AbortController()
  const force = !!(opts && opts.force)

  let fn
  if (mode === 'client') {
    fn = store.get('mo2Enabled') ? runMO2Install({ clientOnly: true }) : runDirectInstall(force)
  } else if (mode === 'mo2') {
    fn = runMO2Install()
  } else if (mode === 'modlist') {
    fn = runMO2Install({ modlistOnly: true, force })
  } else {
    // Auto mode (used by the Play button) - delegate based on mo2Enabled setting
    fn = store.get('mo2Enabled') ? runMO2Install() : runDirectInstall()
  }
  fn.catch(err => {
    log('[install] Unhandled error:', err.message)
    send('install:complete', { success: false, error: `Unexpected error: ${err.message}` })
    installing = false
  })
})

// Cancels the running install at its next wait/step boundary.
ipcMain.on('install:cancel', () => {
  if (installing && installAbort) installAbort.abort()
})

// Standalone install steps (Repair tab buttons); all stream progress over the shared install:progress channel.

// MO2 only: download/unpack MO2 and refresh the portable instance. force reinstalls MO2's own files.
ipcMain.handle('install:mo2only', async (_e, opts) => {
  if (installing) return { success: false, error: 'An install is already running - cancel it first.' }
  installing = true
  try {
    const skyrimPath = store.get('skyrimPath')
    if (skyrimPath && pathsOverlap(skyrimPath, mo2.getRoot())) {
      return { success: false, error: 'The install location is inside your Skyrim folder - pick one outside it in Settings before repairing MO2.' }
    }
    if (await isProcessRunning('ModOrganizer.exe')) {
      return { success: false, error: 'Mod Organizer 2 is running - close it before repairing.' }
    }
    const progress = msg => send('install:progress', { phase: 'download', file: msg, index: 0, total: 0, skipped: false })
    if (opts && opts.force) await mo2.reinstall(progress)
    else await mo2.ensureInstalled(progress)
    if (store.get('isolatedGame') && !isolatedGameReady()) {
      log('[install] mo2only: game copy not ready, leaving the original install untouched')
    } else {
      const gamePath = effectiveGamePath()
      if (gamePath && fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))) {
        let serverInfo = null
        try { serverInfo = await fetchJSON(serverInfoUrl()) } catch {}
        mo2.ensureInstance(gamePath, serverInfo?.loadOrder)
        mo2.registerNxmHandler()
        applyForcedServerDefaults(gamePath)
      }
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    installing = false
  }
})

// The game folder a Repair step works on; with isolation on it is the portable copy, never the original install
function repairGamePath(what) {
  let gamePath
  if (store.get('isolatedGame')) {
    gamePath = isolatedGameDir()
    if (!isolatedGameReady()) {
      return { error: `Install the game copy first - ${what} belongs in the portable copy, not your original Skyrim.` }
    }
  } else {
    gamePath = effectiveGamePath()
  }
  if (!gamePath || !fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))) {
    return { error: 'No game folder found - install the game copy or set a valid Skyrim path first.' }
  }
  return { gamePath }
}

// Cleaned masters only; force restores the original masters and patches them again.
ipcMain.handle('install:masters', async (_e, opts) => {
  if (installing) return { success: false, error: 'An install is already running - cancel it first.' }
  const { gamePath, error } = repairGamePath('the cleaned masters')
  if (error) return { success: false, error }
  installing = true
  try {
    const r = await ensureCleanedMasters(gamePath, { force: !!(opts && opts.force), strict: true })
    return r.ok ? { success: true, cleaned: r.cleaned, warning: r.warning } : { success: false, error: r.error }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    installing = false
  }
})

// SKSE only: download the edition-matched SKSE and install it into the game root. force drops the cached archive so a fresh copy is fetched.
ipcMain.handle('install:skse', async (_e, opts) => {
  if (installing) return { success: false, error: 'An install is already running - cancel it first.' }
  const { gamePath, error } = repairGamePath('SKSE')
  if (error) return { success: false, error }
  installing = true
  try {
    if (opts && opts.force) {
      try { fs.rmSync(path.join(mo2.getDownloadsDir(), mo2.skseSourceFor(gamePath).fileName), { force: true }) } catch {}
      for (const name of fs.readdirSync(gamePath)) {
        if (/^skse64_.*\.(exe|dll)$/i.test(name)) try { fs.rmSync(path.join(gamePath, name), { force: true }) } catch {}
      }
      store.set('installedRootHash', '')
    }
    await installSkseIntoRoot(gamePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    installing = false
  }
})

// Read-only integrity scan over every Repair section; nothing on disk changes.
ipcMain.handle('install:check', async () => {
  if (installing) return { ok: false, error: 'An install is already running - wait for it to finish.' }
  installing = true
  try {
    return await checkFilesImpl()
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    installing = false
  }
})

const CHECK_PROGRESS_EVERY = 25
const CHECK_NOTE_SAMPLE    = 10
// Files under Data/Platform and Data/SKSE/Plugins written by the launcher, Skyrim Platform or SKSE rather than shipped in the client zip.
const CLIENT_OWN_FILE_RES = [/^data\/platform\/(logs|pluginsnoload|pluginsdev)\//, /skymp5-client-settings\.txt$/, /\.log$/, /^data\/skse\/plugins\/skse64_/]

function crc32File(p) {
  return new Promise((resolve, reject) => {
    let crc = 0
    fs.createReadStream(mo2.lp(p))
      .on('data', d => { crc = zlib.crc32(d, crc) })
      .on('end', () => resolve((crc >>> 0).toString(16).toUpperCase().padStart(8, '0')))
      .on('error', reject)
  })
}

// Issues carry { kind: missing|corrupt|extra|outdated, path, fix: mo2|game|masters|skse|client|modlist }; notes explain skipped checks.
async function checkFilesImpl() {
  const issues = []
  const notes  = []
  const root   = mo2.getRoot()
  const show   = p => {
    const r = path.relative(root, p)
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p
  }
  const add = (kind, p, fix) => {
    issues.push({ kind, path: p, fix })
    log(`[check] [${kind}] ${p} -> ${fix}`)
  }
  const progress = file => send('install:progress', { phase: 'check', file, index: 0, total: 0, skipped: false })
  const yieldNow = () => new Promise(r => setImmediate(r))
  const sizeOf   = p => { try { return fs.statSync(mo2.lp(p)).size } catch { return -1 } }
  // Size first, so multi-GB files are only hashed when they could still match.
  const verifyFile = async (full, f, label, fix) => {
    const size = sizeOf(full)
    if (size === -1) return add('missing', label, fix)
    if (Number.isFinite(f.size) && size !== f.size) return add('corrupt', `${label} (size ${size}, expected ${f.size})`, fix)
    if (!f.sha256) return
    let sha = ''
    try { sha = await mo2.sha256FileAsync(full) } catch { return add('corrupt', `${label} (unreadable)`, fix) }
    if (sha.toLowerCase() !== String(f.sha256).toLowerCase()) add('corrupt', `${label} (sha256)`, fix)
  }
  const portable = !!store.get('isolatedGame')
  const gamePath = portable ? isolatedGameDir() : store.get('skyrimPath')
  const gameOk   = !!gamePath && fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))

  // MO2
  progress('Checking Mod Organizer 2…')
  if (!mo2.isInstalled()) {
    add('missing', 'ModOrganizer.exe', 'mo2')
  } else {
    const stamp = mo2.readMo2Stamp()
    if (!stamp) add('missing', `${mo2.MO2_STAMP} (MO2 binaries unverified)`, 'mo2')
    else if (stamp.version !== mo2.MO2_VERSION) add('outdated', `ModOrganizer.exe (${stamp.version}, launcher ships ${mo2.MO2_VERSION})`, 'mo2')
    else {
      const now = mo2.mo2BinaryStats()
      if (now.size !== stamp.size || now.count !== stamp.count) {
        add('corrupt', `MO2 binaries (${now.count} files / ${now.size} bytes, stamp ${stamp.count} / ${stamp.size})`, 'mo2')
      }
    }
    for (const f of ['portable.txt', 'ModOrganizer.ini']) if (!fs.existsSync(path.join(root, f))) add('missing', f, 'mo2')
    for (const f of ['modlist.txt', 'plugins.txt']) {
      if (!fs.existsSync(path.join(mo2.getProfileDir(), f))) add('missing', `profiles/${mo2.PROFILE}/${f}`, 'mo2')
    }
  }
  await yieldNow()

  // Game copy (portable only; a real install is verified through Steam/GOG)
  if (portable) {
    progress('Checking the game copy…')
    const src = store.get('skyrimPath')
    if (!gameOk) {
      add('missing', show(path.join(gamePath, 'SkyrimSE.exe')), 'game')
    } else {
      if (src && fs.existsSync(path.join(src, 'Data', 'Skyrim.esm'))) {
        for (const job of vanillaMismatches(src, gamePath)) {
          const full = path.join(gamePath, job.sub, job.rel)
          add(sizeOf(full) === -1 ? 'missing' : 'corrupt', show(full), 'game')
        }
      } else {
        notes.push('Game copy: the original Skyrim install is unreadable, so the vanilla files were not compared.')
        if (!gameCopyComplete(gamePath)) add('missing', `${show(path.join(gamePath, 'Data', 'Skyrim.esm'))} (game copy incomplete)`, 'game')
      }
      const marker = path.join(gamePath, 'vanilla-copy-complete.json')
      if (!fs.existsSync(marker)) add('missing', show(marker), 'game')
      const ccc = sizeOf(path.join(gamePath, 'Skyrim.ccc'))
      if (ccc !== 0) add(ccc === -1 ? 'missing' : 'corrupt', `${show(path.join(gamePath, 'Skyrim.ccc'))}${ccc > 0 ? ' (must be empty)' : ''}`, 'game')
    }
    await yieldNow()
  }

  progress('Fetching the install manifest…')
  let manifest = null
  try { manifest = await fetchJSON(MANIFEST_URL()) }
  catch (err) { notes.push(`Modlist: could not fetch the install manifest (${err.serverError || err.message}), section skipped.`) }
  if (manifest && Number(manifest.schema) > MANIFEST_SCHEMA) {
    notes.push(`Modlist: ${UPDATE_LAUNCHER_ERROR}`)
    manifest = null
  }

  if (gameOk) {
    progress('Checking the cleaned masters…')
    for (const m of cleanmasters.MASTERS) {
      const full = path.join(gamePath, 'Data', m.name)
      const size = sizeOf(full)
      if (size === -1) continue
      const v = cleanmasters.classify(m.name, size)
      if (v === 'cleaned') continue
      if (v) add('outdated', `${show(full)} (not cleaned)`, 'masters')
      else notes.push(`Cleaned masters: ${show(full)} is a build no patch knows (size ${size}), so it stays as shipped.`)
    }
    await yieldNow()
  }

  let vd = null
  if (!gameOk) {
    notes.push('SKSE and client files: no game folder found, both sections skipped.')
  } else {
    // SKSE
    progress('Checking SKSE…')
    const skse    = mo2.skseSourceFor(gamePath)
    const archive = path.join(mo2.getDownloadsDir(), skse.fileName)
    const entries = fs.existsSync(archive) ? await mo2.listArchiveEntries(archive) : null
    if (entries) {
      // installSkse copies every exe/dll from the archive root, one wrapper folder deep at most.
      for (const e of entries) {
        const parts = e.path.split('/')
        const name  = parts[parts.length - 1]
        if (parts.length > 2 || !/\.(exe|dll)$/i.test(name)) continue
        const full = path.join(gamePath, name)
        const size = sizeOf(full)
        if (size === -1) add('missing', show(full), 'skse')
        else if (size !== e.size) add('corrupt', `${show(full)} (size ${size}, archive ${e.size})`, 'skse')
        else if (e.crc && typeof zlib.crc32 === 'function' && await crc32File(full) !== e.crc) add('corrupt', `${show(full)} (crc)`, 'skse')
      }
    } else {
      notes.push(`SKSE: no cached ${skse.fileName} in downloads, so the root files were only checked for presence.`)
      let names = []
      try { names = fs.readdirSync(gamePath) } catch {}
      if (!names.some(n => /^skse64_loader\.exe$/i.test(n))) add('missing', show(path.join(gamePath, 'skse64_loader.exe')), 'skse')
      if (!names.some(n => /^skse64_.*\.dll$/i.test(n))) add('missing', `${show(path.join(gamePath, 'skse64_*.dll'))} (runtime dll)`, 'skse')
    }
    if (!fs.existsSync(path.join(mo2.getModsDir(), 'SKSE', 'meta.ini'))) add('missing', 'mods/SKSE/meta.ini', 'skse')
    await yieldNow()

    // Client files
    progress('Checking client files…')
    try { vd = await fetchJSON(`${config.apiUrl}/api/files/version`) }
    catch (err) { notes.push(`Client files: could not read the server version (${err.message}), version and checksum checks skipped.`) }
    if (vd) {
      const installed = store.get('filesVersion') || ''
      if (vd.version !== installed) add('outdated', `client files (installed ${installed || 'none'}, server ${vd.version})`, 'client')
    }
    const files = vd && Array.isArray(vd.files)
      ? vd.files.filter(f => f && typeof f.path === 'string' && !f.path.split('/').includes('..'))
      : []
    const preloaderIssue = () => { if (!preloaderPresent(gamePath)) add('missing', `${show(path.join(gamePath, PRELOADER_DLLS[0]))} (Engine Fixes preloader)`, 'client') }
    if (store.get('mo2Enabled') && clientMods(manifest).length > 0) {
      notes.push('Client files: under MO2 they come from the modlist, which the Modlist section verifies.')
      const settings = path.join(gamePath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')
      if (!fs.existsSync(settings)) add('missing', show(settings), 'client')
      preloaderIssue()
    } else if (files.length === 0) {
      if (vd) notes.push('Client files: the server publishes no per-file list, so only presence and version were checked.')
      for (const f of REQUIRED_FILES) {
        const full = path.join(gamePath, 'Data', ...f.split('/'))
        if (!fs.existsSync(full)) add('missing', show(full), 'client')
      }
      preloaderIssue()
    } else {
      const listed = new Set()
      for (let i = 0; i < files.length; i++) {
        const f    = files[i]
        const full = path.join(gamePath, ...f.path.split('/'))
        const l    = f.path.toLowerCase()
        listed.add(l)
        // Launcher-owned files are rewritten on every launch, so the published hash never matches
        if (CLIENT_OWN_FILE_RES.some(re => re.test(l))) continue
        await verifyFile(full, f, show(full), 'client')
        if ((i + 1) % CHECK_PROGRESS_EVERY === 0) { progress(`Checking client files… ${i + 1}/${files.length}`); await yieldNow() }
      }
      // Unlisted files are only reported: Repair SkyMP Client re-extracts the zip and never deletes
      const extras = []
      for (const sub of ['Data/Platform', 'Data/SKSE/Plugins']) {
        for (const rel of mo2.listFilesRel(path.join(gamePath, ...sub.split('/')))) {
          const p = `${sub}/${rel}`
          const l = p.toLowerCase()
          if (listed.has(l) || CLIENT_OWN_FILE_RES.some(re => re.test(l))) continue
          extras.push(show(path.join(gamePath, ...p.split('/'))))
        }
      }
      if (extras.length) {
        const more = extras.length > CHECK_NOTE_SAMPLE ? ` and ${extras.length - CHECK_NOTE_SAMPLE} more` : ''
        notes.push(`Client files: ${extras.length} file(s) not in the server package were left alone: ${extras.slice(0, CHECK_NOTE_SAMPLE).join(', ')}${more}.`)
      }
    }
    await yieldNow()
  }

  // Strays in the portable copy; PLAY and Repair Game Copy delete them
  if (portable && gameOk) {
    progress('Checking the game copy for stray files…')
    for (const rel of gameCopyStrays(gamePath, manifest, clientZipFiles(manifest, vd))) add('extra', show(path.join(gamePath, ...rel.split('/'))), 'game')
    await yieldNow()
  }

  // Modlist
  if (manifest && manifest.creations && Array.isArray(manifest.creations.files) && gameOk) {
    progress('Checking the Creation Club files…')
    for (const f of manifest.creations.files) {
      const full = path.join(gamePath, ...String(f.to).split('/'))
      const size = sizeOf(full)
      if (size === -1) { add('missing', show(full), 'modlist'); continue }
      let sha = ''
      try { sha = await mo2.hashCached(full, fs.statSync(mo2.lp(full))) } catch { add('corrupt', `${show(full)} (unreadable)`, 'modlist'); continue }
      const known = (f.accept || []).some(a => a.size === size && String(a.sha256).toLowerCase() === sha)
      if (known) continue
      if (f.kind === 'plugin') add('corrupt', `${show(full)} (differs from the server copy)`, 'modlist')
      else notes.push(`Creation Club: ${show(full)} differs from the server copy (sha256 ${sha}); archives of other store builds are accepted.`)
      await yieldNow()
    }
  }
  if (manifest && Array.isArray(manifest.mods)) {
    const modsDir  = mo2.getModsDir()
    const sanitize = n => String(n).replace(/[<>:"/\\|?*]/g, '')
    const total    = manifest.mods.length
    for (let i = 0; i < total; i++) {
      const m      = manifest.mods[i]
      const folder = sanitize(m.name)
      const dir    = path.join(modsDir, folder)
      progress(`Checking mods… ${i + 1}/${total} (${m.name})`)
      if (!fs.existsSync(mo2.lp(dir))) { add('missing', `mods/${folder}`, 'modlist'); continue }
      if (m.hash && mo2.readModHash(m.name) !== m.hash) add('outdated', `mods/${folder} (installed from an older manifest)`, 'modlist')
      const files    = Array.isArray(m.files) ? m.files : []
      const expected = new Set(files.map(f => String(f.to).toLowerCase()))
      for (let n = 0; n < files.length; n++) {
        const f = files[n]
        await verifyFile(path.join(dir, ...String(f.to).split('/')), f, `mods/${folder}/${f.to}`, 'modlist')
        if ((n + 1) % CHECK_PROGRESS_EVERY === 0) {
          progress(`Checking mods… ${i + 1}/${total} (${m.name}: ${n + 1}/${files.length} files)`)
          await yieldNow()
        }
      }
      for (const rel of mo2.listFilesRel(dir)) {
        const l = rel.toLowerCase()
        if (l === 'meta.ini' || expected.has(l)) continue
        add('extra', `mods/${folder}/${rel}`, 'modlist')
      }
      await yieldNow()
    }

    progress('Checking the MO2 profile…')
    const order = (Array.isArray(manifest.order) && manifest.order.length) ? manifest.order.slice() : manifest.mods.map(m => m.name)
    for (const name of mo2.listStaleManagedMods(order)) add('extra', `mods/${name}`, 'modlist')

    const profile   = mo2.getProfileDir()
    const readLines = p => {
      try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) }
      catch { return null }
    }
    const plugins = readLines(path.join(profile, 'plugins.txt'))
    if (plugins && Array.isArray(manifest.plugins) && manifest.plugins.length) {
      // Every launch rewrites plugins.txt from the server load order, so that rendering counts as intact too.
      // MO2 appends disabled entries for plugins it discovers, so only the enabled sequence is compared.
      let serverInfo = null
      try { serverInfo = await fetchJSON(serverInfoUrl()) } catch {}
      const enabled  = lines => lines.filter(l => l.startsWith('*')).join('\n')
      const accepted = [manifest.plugins, mo2.serverPluginLines(serverInfo?.loadOrder)].filter(a => a.length).map(enabled)
      if (!accepted.includes(enabled(plugins))) add('corrupt', `profiles/${mo2.PROFILE}/plugins.txt (load order drift)`, 'modlist')
    }
    const modlist = readLines(path.join(profile, 'modlist.txt'))
    if (modlist) {
      const want = order.slice()
      if (fs.existsSync(path.join(modsDir, 'SKSE')) && !want.includes('SKSE')) want.push('SKSE')
      const have = modlist.filter(l => /^[+-]/.test(l)).slice(0, want.length)
      if (have.join('\n') !== want.map(n => `+${n}`).join('\n')) add('corrupt', `profiles/${mo2.PROFILE}/modlist.txt (mod order drift)`, 'modlist')
    }
    for (const name of mo2.listOverwriteJunk()) add('extra', `overwrite/${name}`, 'modlist')
  }

  log(`[check] done: ${issues.length} issue(s)`)
  return { ok: true, issues, notes }
}

// Shared download + extract helpers

/**
 * Stream the client zip from the backend to a local temp file.
 * Calls onProgress(bytesReceived, totalBytes) as data arrives.
 */
function downloadClientZip(tempPath, onProgress) {
  const url = `${config.apiUrl}/api/files/zip`
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    let file = null
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    // Destroy the stream before unlinking: an open handle leaves the partial file delete-pending on Windows and blocks every retry this session.
    const fail = err => {
      if (settled) return
      settled = true
      if (file && !file.destroyed) {
        file.once('close', () => { try { fs.unlinkSync(tempPath) } catch {} reject(err) })
        file.destroy()
      } else {
        try { fs.unlinkSync(tempPath) } catch {}
        reject(err)
      }
    }
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode === 404) {
        res.resume()
        return fail(new Error('Update package not found on server. Run npm run merge on the backend.'))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return fail(new Error(`Server returned HTTP ${res.statusCode}`))
      }

      const total    = parseInt(res.headers['content-length'] || '0', 10)
      let   received = 0

      file = fs.createWriteStream(tempPath)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(finish))
      file.on('error', fail)
      res.on('error',  fail)
      res.on('aborted', () => fail(new Error('Download interrupted')))
    })
    req.on('error', fail)
    req.setTimeout(60_000, () => { req.destroy(); fail(new Error('Download timed out')) })
  })
}

/**
 * Extract the zip at zipPath into destDir, preserving the internal path structure.
 * Calls onProgress(entryName, index, total) for each file entry.
 * Returns the number of files extracted.
 */
function extractClientZip(zipPath, destDir, onProgress) {
  const zip     = new AdmZip(zipPath)
  const entries = zip.getEntries().filter(e => !e.isDirectory)
  const total   = entries.length

  // Zip-slip guard (defense-in-depth over adm-zip): reject any entry whose
  // resolved destination escapes destDir before writing it.
  const root = path.resolve(destDir)
  for (let i = 0; i < total; i++) {
    const entry = entries[i]
    const resolved = path.resolve(destDir, entry.entryName)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Refusing to extract entry outside the target directory: ${entry.entryName}`)
    }
    zip.extractEntryTo(entry.entryName, destDir, /* maintainEntryPath */ true, /* overwrite */ true)
    if (onProgress) onProgress(entry.entryName, i + 1, total)
  }

  return total
}

// Client files install core
// Shared by the direct and MO2 installers: version check, download, extract, client settings.

async function installClientFilesCore(skyrimPath, srv, serverInfo, force = false) {
  const tempZip = path.join(os.tmpdir(), 'alduinak-client.zip')
  const clientSettingsPath = path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')

  try {
    // 1. Check whether a download is needed
    let serverVersion = null
    let packaged = []
    try {
      const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
      serverVersion = vd.version
      if (Array.isArray(vd.files)) packaged = vd.files.map(f => String(f.path)).filter(p => !p.split('/').includes('..'))
    } catch (err) {
      if (err.statusCode === 404) {
        return { success: false, error: 'Client files have not been packaged on the server yet. Ask the server admin to run `npm run build-client`.' }
      }
      if (force) return { success: false, error: 'Backend unreachable, client files were not reinstalled' }
      // Network error - play on cached files if they exist
      const allPresent = clientFilesPresent(skyrimPath, false)
      if (!allPresent) return { success: false, error: 'Backend unreachable and client files are not installed. Check your connection.' }
      log('[install] Backend unreachable - files already installed, updating settings only')
      writeClientSettings(clientSettingsPath, srv, serverInfo)
      return { success: true, upToDate: true }
    }

    const allPresent    = clientFilesPresent(skyrimPath, false)
    const needsDownload = force || serverVersion !== store.get('filesVersion') || !allPresent

    if (!needsDownload) {
      log('[install] Files up to date, updating settings only')
      writeClientSettings(clientSettingsPath, srv, serverInfo)
      return { success: true, upToDate: true }
    }

    // 2. Download
    send('install:progress', { phase: 'download', file: 'Connecting to server…', index: 0, total: 0, skipped: false })
    await downloadClientZip(tempZip, (received, total) => {
      const mb  = n => (n / 1024 / 1024).toFixed(1)
      const pct = total > 0 ? ` (${Math.round(received / total * 100)}%)` : ''
      send('install:progress', {
        phase: 'download',
        file:  `Downloading update… ${mb(received)} / ${mb(total)} MB${pct}`,
        index: received, total, skipped: false,
      })
    })

    // 3. Extract directly into Skyrim directory.
    // The zip's stock skymp5-client-settings.txt would clobber hotkey rebinds; snapshot it so writeClientSettings sees the pre-extract file.
    let settingsSnapshot = null
    try { settingsSnapshot = fs.readFileSync(clientSettingsPath, 'utf8') } catch { /* first install */ }
    // An interrupted extract must show as an update on the next Play
    store.set('filesVersion', '')
    // A repair deletes the whole package first, so nothing stale survives the re-extract
    if (force) {
      const own = packaged.filter(p => !CLIENT_OWN_FILE_RES.some(re => re.test(p.toLowerCase())))
      for (const p of own) { try { fs.rmSync(mo2.lp(path.join(skyrimPath, ...p.split('/'))), { force: true }) } catch {} }
      log(`[install] removed ${own.length} packaged client file(s) before the re-extract`)
    }
    const extracted = extractClientZip(tempZip, skyrimPath, (file, i, total) => {
      send('install:progress', { phase: 'extract', file, index: i, total, skipped: false })
    })
    if (settingsSnapshot !== null) {
      try { fs.writeFileSync(clientSettingsPath, settingsSnapshot) } catch { /* fall back to zip copy */ }
    }
    log(`[install] extracted ${extracted} files`)
    ensureClientDirs(skyrimPath)

    if (!preloaderPresent(skyrimPath)) {
      return {
        success: false,
        error: 'The client package installed, but no Engine Fixes preloader dll (d3dx9_42.dll / winhttp.dll) is next to SkyrimSE.exe. ' +
               'The server admin needs to add the preloader files to the client package and rebuild it (npm run merge).',
      }
    }

    // 4. Write server settings
    writeClientSettings(clientSettingsPath, srv, serverInfo)
    store.set('filesVersion', serverVersion)

    return { success: true }
  } catch (err) {
    return { success: false, error: `Install failed: ${err.message}` }
  } finally {
    try { fs.unlinkSync(tempZip) } catch {}
  }
}

// Direct install (no mod manager)

async function runDirectInstall(force = false) {
  const skyrimPath = effectiveGamePath()
  const srv        = activeServer()

  const fail = (msg) => {
    log('[install] ABORT:', msg)
    send('install:complete', { success: false, error: msg })
    installing = false
  }

  if (!skyrimPath) return fail('Skyrim path not configured.')
  if (!srv)        return fail('No server selected - open Settings and choose a server.')

  // Vanilla integrity (repairs portable copies, warns for the real install).
  const integrity = await ensureVanillaIntegrity(skyrimPath)
  if (!integrity.ok) return fail(integrity.error)
  const masters = await ensureCleanedMasters(skyrimPath)
  const warning = [integrity.warning, masters.warning].filter(Boolean).join(' | ')

  let serverInfo = null
  try { serverInfo = await fetchJSON(serverInfoUrl()) } catch {}

  const core = await installClientFilesCore(skyrimPath, srv, serverInfo, force)
  if (core.success) applyForcedServerDefaults(skyrimPath)
  send('install:complete', core.success
    ? { success: true, upToDate: core.upToDate, ...(warning ? { warning } : {}) }
    : { success: false, error: core.error })
  installing = false
}

// Filename pattern for a Nexus archive: downloads embed the mod id (…-17230-…); a renamed
// file still matches on the mod's name words. `version` additionally pins the release
// (Nexus encodes v2020.3 as "2020-3" in filenames).
function nexusNamePattern(modId, displayName, version) {
  const words = String(displayName).toLowerCase().match(/[a-z]{4,}/g) || []
  const nameRe = words.slice(0, 2).join('.*')
  const base = `(?:^|[^0-9])${modId}(?:[^0-9]|$)` + (nameRe ? `|${nameRe}` : '')
  if (!version) return new RegExp(base, 'i')
  const verRe = String(version).replace(/[.-]/g, '[.-]')
  return new RegExp(`^(?=.*${verRe})(?=.*(?:${base}))`, 'i')
}

// Open the MO2 downloads folder (archive staging) + the backend page listing the
// file-pinned Nexus links, once per install run. `missing` narrows the page to
// the archives this install still needs, so nothing already downloaded is listed.
let _downloadListOpened = false
function openDownloadList(downloadsDir, missing) {
  if (_downloadListOpened) return
  _downloadListOpened = true
  try { fs.mkdirSync(downloadsDir, { recursive: true }); shell.openPath(downloadsDir) } catch {}
  const need = (missing || [])
    .filter(a => a.source && a.source.modId)
    .map(a => `${a.source.modId}-${a.source.fileId || 'any'}`)
    .join(',')
  const query = need ? `?need=${encodeURIComponent(need)}` : ''
  shell.openExternal(`${config.apiUrl}/api/nexus-downloads${query}`)
}

// MO2 install
// Full modpack pipeline: MO2 itself → manifest replay, whose client mod carries the SkyMP client (else the backend zip).
// Mods are reproduced from the backend's compiled install manifest (download +
// verify each archive, extract once, apply per-file directives) so every player
// gets the reference install's exact, byte-identical layout.

// Download SKSE (edition-aware) and install it into the game root. Shared by
// the manifest root step and the empty-manifest path: without SKSE nothing
// can launch, no matter how few mods the server ships.
async function installSkseIntoRoot(skyrimPath) {
  const mb = n => (n / 1024 / 1024).toFixed(1)
  const skse = mo2.skseSourceFor(skyrimPath)
  send('install:progress', { phase: 'mods', file: `Downloading SKSE (${skse.edition})…`, index: 0, total: 0, skipped: false })
  const name = await mo2.downloadToDownloads(skse.url, skse.fileName, (r, t) => {
    const pct = t > 0 ? ` (${Math.round(r / t * 100)}%)` : ''
    send('install:progress', { phase: 'mods', file: `Downloading SKSE (${skse.edition})… ${mb(r)} MB${pct}`, index: 0, total: 0, skipped: false })
  })
  send('install:progress', { phase: 'mods', file: 'Installing SKSE…', index: 0, total: 0, skipped: false })
  mo2.installSkse(path.join(mo2.getDownloadsDir(), name), skyrimPath)
}

// opts.force rebuilds every mod and the SKSE root step from scratch (Repair Modlist).
// opts.clientOnly rebuilds only the client mods, the root files and the client settings (Repair SkyMP Client).
async function runMO2Install(opts = {}) {
  const modlistOnly = opts.modlistOnly === true
  const force       = opts.force === true
  const clientOnly  = opts.clientOnly === true
  _downloadListOpened = false
  const fail = (msg) => {
    log('[mo2-install] ABORT:', msg)
    // The modpack is not in a known-good state: the launch gate blocks PLAY
    // and the update check flips the button to UPDATE until a run succeeds.
    store.set('modpackState', 'failed')
    send('install:complete', { success: false, error: msg })
    installing = false
  }

  const skyrimPath = effectiveGamePath()
  if (!skyrimPath) return fail('Skyrim path not configured.')

  const srv = activeServer()
  if (!srv) return fail('No server selected - open Settings and choose a server.')

  if (!findOriginalPrefsIni()) return fail(NEVER_LAUNCHED_ERROR)

  try {
    // 0. Vanilla integrity: verify the game copy (existence + size) against
    // the original install and repair portable copies file by file. Playing
    // from the real install only produces a warning.
    const integrity = await ensureVanillaIntegrity(skyrimPath)
    if (!integrity.ok) return fail(integrity.error)
    if (integrity.repaired) log(`[mo2-install] repaired ${integrity.repaired} vanilla file(s)`)
    const vanillaWarning = integrity.warning || null

    // 1. MO2 itself, the portable instance, and the nxm:// handler
    await mo2.ensureInstalled(msg =>
      send('install:progress', { phase: 'download', file: msg, index: 0, total: 0, skipped: false }))

    let serverInfo = null
    try { serverInfo = await fetchJSON(serverInfoUrl()) } catch {}
    mo2.ensureInstance(skyrimPath, serverInfo?.loadOrder)
    mo2.registerNxmHandler()
    seedProfilePrefs(store.get('skyrimPath') || skyrimPath)
    applyForcedServerDefaults(skyrimPath)

    // 2. Mods from the compiled install manifest
    let manifest
    try { manifest = await fetchJSON(MANIFEST_URL()) }
    catch (err) {
      // A 404 means the backend never compiled (or lost, after a fresh
      // deploy) its manifest - surface the backend's own explanation.
      if (err.statusCode === 404) {
        return fail(err.serverError ||
          'The server has not published a mod manifest yet - ask the server admin to run `npm run compile-manifest` on the backend.')
      }
      return fail(`Could not fetch the install manifest: ${err.message}`)
    }
    if (!manifest || !Array.isArray(manifest.mods) || !Array.isArray(manifest.archives)) {
      return fail('Install manifest is missing or malformed - run "npm run compile-manifest" on the backend.')
    }
    if (Number(manifest.schema) > MANIFEST_SCHEMA) return fail(UPDATE_LAUNCHER_ERROR)
    if (force) {
      // Every Creation file is hashed again and nothing stray in overwrite survives
      try { fs.rmSync(path.join(skyrimPath, CREATIONS_STAMP), { force: true }) } catch {}
      const wiped = mo2.cleanOverwrite()
      if (wiped.length > 0) log(`[mo2-install] cleaned overwrite: ${wiped.join(', ')}`)
    }

    // Creation Club files from the player's own install, before any mod: the load order needs them either way
    const creations = await ensureCreations(manifest, skyrimPath)
    if (!creations.ok) return fail(creations.error)
    const masters = await ensureCleanedMasters(skyrimPath)
    const setupWarning = [vanillaWarning, creations.warning, masters.warning].filter(Boolean).join(' | ') || null

    // 3. SkyMP client files: a manifest mod carries them under MO2; without one the backend zip goes into the real Data (skipped by Repair Modlist)
    let coreUpToDate = false
    let clientFilesVersion = null
    let vd = null
    try { vd = await fetchJSON(`${config.apiUrl}/api/files/version`) } catch {}
    if (clientMods(manifest).length > 0) {
      clientFilesVersion = vd && vd.version
      ensureClientDirs(skyrimPath)
      writeClientSettings(clientSettingsPath(), srv, serverInfo)
      coreUpToDate = !!clientFilesVersion && clientFilesVersion === store.get('filesVersion')
    } else if (!modlistOnly) {
      const core = await installClientFilesCore(skyrimPath, srv, serverInfo, clientOnly)
      if (!core.success) return fail(core.error)
      coreUpToDate = !!core.upToDate
    }
    const strays = removeGameCopyStrays(skyrimPath, manifest, clientZipFiles(manifest, vd))
    if (strays) log(`[mo2-install] removed ${strays} stray file(s) from the game copy`)

    const finishOrder = () => {
      const order = (Array.isArray(manifest.order) && manifest.order.length)
        ? manifest.order.slice()
        : manifest.mods.map(m => m.name)
      if (fs.existsSync(path.join(mo2.getModsDir(), 'SKSE')) && !order.includes('SKSE')) order.push('SKSE')
      mo2.setModlistOrder(order)        // also prunes managed mods dropped from the manifest
      mo2.setPlugins(manifest.plugins)
      store.set('installedRootHash', manifest.rootHash || '')
      // The launch gate compares this with the backend's files version
      if (clientFilesVersion) store.set('filesVersion', clientFilesVersion)
    }

    if (manifest.mods.length === 0) {
      // No mods yet, but the game root still needs SKSE or nothing can launch,
      // and the run must reach 'ready' or the button stays stuck on UPDATE.
      if (!fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))) {
        try { await installSkseIntoRoot(skyrimPath) }
        catch (err) { return fail(`SKSE install failed: ${err.message}`) }
      }
      finishOrder()
      store.set('modpackState', 'ready')
      send('install:complete', {
        success: true, mo2: true, upToDate: coreUpToDate, modsTotal: 0,
        warning: [setupWarning, 'The install manifest has no mods yet - compile it from the reference MO2 install on the backend.']
          .filter(Boolean).join(' | '),
      })
      return
    }

    // 3a. Acquire every referenced archive, verified by sha256
    const downloadsDir = mo2.getDownloadsDir()
    const nexusAuth = await getNexusAuth()   // OAuth bearer or SSO API key
    const premium   = !!(nexusAuth && store.get('nexusUser')?.isPremium)
    const mb = n => (n / 1024 / 1024).toFixed(1)
    const sanitize       = n => String(n).replace(/[<>:"/\\|?*]/g, '')
    const modFolderPath  = m => path.join(mo2.getModsDir(), sanitize(m.name))
    if (force) {
      send('install:progress', { phase: 'mods', file: 'Clearing the build and extraction caches…', index: 0, total: 0, skipped: false })
      mo2.clearBuildCache()
      mo2.clearCache()
    }
    const clientSet = new Set(clientMods(manifest))
    const modChanged = m => {
      if (clientOnly) return clientSet.has(m)
      if (force) return true
      if (!fs.existsSync(modFolderPath(m))) return true
      if (!m.hash) return true                     // pre-hash manifest: be safe, reinstall
      if (mo2.readModHash(m.name) !== m.hash) return true
      // Cheap integrity gate: the summed directive sizes vs the folder's
      // actual bytes. The install-time hash stamp alone cannot see files an
      // AV quarantined or a player deleted; a mismatch rebuilds the mod.
      const files = Array.isArray(m.files) ? m.files : []
      if (!files.length || !files.every(f => Number.isFinite(f.size))) return false
      const expected = files.reduce((a, f) => a + f.size, 0)
      const actual = mo2.modFolderSize(m.name)
      if (actual === -1) {
        // Unreadable mid-scan (AV holding a handle): do not wipe a mod over a
        // transient lock, only over a real size mismatch.
        log(`[mo2-install] ${m.name}: folder unreadable during verify - skipping size check`)
        return false
      }
      if (actual !== expected) {
        log(`[mo2-install] ${m.name}: folder is ${actual} bytes, manifest expects ${expected} - repairing`)
        return true
      }
      return false
    }
    const rootSetUp      = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    const rootChanged    = (store.get('installedRootHash') || '') !== (manifest.rootHash || '')
    const rootMissing    = (manifest.root || []).some(f => !fs.existsSync(path.join(skyrimPath, ...String(f.to).split('/'))))
    const needsRoot      = !clientOnly && (force || !rootSetUp || rootChanged || rootMissing)
    // Root files (the preloader) come back on every root step and on Repair SkyMP Client; SKSE only on the root step
    const needsRootFiles = needsRoot || clientOnly
    log(`[mo2-install] root check: skse=${rootSetUp} hashChanged=${rootChanged} filesMissing=${rootMissing} force=${force} clientOnly=${clientOnly} -> needsRoot=${needsRoot}`)
    const modsToInstall  = []
    for (let i = 0; i < manifest.mods.length; i++) {
      if (modChanged(manifest.mods[i])) modsToInstall.push(manifest.mods[i])
      if ((i + 1) % 10 === 0 || i + 1 === manifest.mods.length) {
        send('install:progress', { phase: 'verify', index: i + 1, total: manifest.mods.length })
      }
      // Yield between folder walks so the UI stays responsive on slow disks
      await new Promise(r => setImmediate(r))
    }

    if (modsToInstall.length === 0 && !needsRootFiles) {
      finishOrder()
      store.set('modpackState', 'ready')
      send('install:complete', {
        success: true, mo2: true, upToDate: true, modsTotal: manifest.mods.length,
        ...(setupWarning ? { warning: setupWarning } : {}),
      })
      return
    }

    const archivePaths = {}      // archiveId -> verified local path
    const needBrowser  = []      // nexus archives we couldn't auto-download

    // Acquire only the archives the to-install mods (and root files) reference.
    const neededArchiveIds = new Set()
    for (const m of modsToInstall) for (const f of m.files) if (f.archive) neededArchiveIds.add(f.archive)
    if (needsRootFiles) for (const f of (manifest.root || [])) if (f.archive) neededArchiveIds.add(f.archive)

    const locate = async (a) => {
      const names = []
      if (a.source.type === 'nexus') { const n = mo2.findDownloadByFileId(a.source.fileId); if (n) names.push(n) }
      names.push(a.name)
      for (const name of names) {
        const p = path.join(downloadsDir, name)
        if (fs.existsSync(p) && mo2.verifyArchive(p, a.hash)) return p
      }
      return await mo2.findArchiveByHash(a.hash, a.size)   // manually moved / renamed file
    }

    for (const a of manifest.archives.filter(x => neededArchiveIds.has(x.id))) {
      const existing = await locate(a)
      if (existing) { archivePaths[a.id] = existing; continue }

      if (a.source.type === 'url') {
        send('install:progress', { phase: 'mods', file: `Downloading ${a.name}…`, index: 0, total: 0, skipped: false })
        const name = await mo2.downloadToDownloads(a.source.url, a.name, (r, t) => {
          const pct = t > 0 ? ` (${Math.round(r / t * 100)}%)` : ''
          send('install:progress', { phase: 'mods', file: `Downloading ${a.name}… ${mb(r)} MB${pct}`, index: 0, total: 0, skipped: false })
        })
        const p = path.join(downloadsDir, name)
        if (!mo2.verifyArchive(p, a.hash)) return fail(`${a.name}: downloaded file failed verification (hash mismatch).`)
        archivePaths[a.id] = p
      } else if (a.source.type === 'nexus' && premium) {
        send('install:progress', { phase: 'mods', file: `Downloading ${a.name}…`, index: 0, total: 0, skipped: false })
        let name = null
        try {
          name = await nexus.downloadFileEntry(nexusAuth, a.source.modId, { fileId: a.source.fileId, fileName: a.name }, downloadsDir, (r, t) => {
            const pct = t > 0 ? ` (${Math.round(r / t * 100)}%)` : ''
            send('install:progress', { phase: 'mods', file: `Downloading ${a.name}… ${mb(r)} / ${mb(t)} MB${pct}`, index: 0, total: 0, skipped: false })
          })
        } catch (err) {
          // A dead pin (HTTP 404 = the file was removed or archived on Nexus)
          // must not abort the whole install: fall back to the manual browser
          // flow, which also accepts an already-downloaded copy by sha256.
          log(`[install] auto-download failed for ${a.name} (mod ${a.source.modId}, file ${a.source.fileId}): ${err.message} - falling back to manual download`)
          send('install:progress', { phase: 'mods', file: `${a.name}: auto-download failed (${err.message}) - queued for manual download`, index: 0, total: 0, skipped: false })
          needBrowser.push(a)
          continue
        }
        const p = path.join(downloadsDir, name)
        if (!mo2.verifyArchive(p, a.hash)) return fail(`${a.name}: downloaded file failed verification (hash mismatch - the version pin may have changed).`)
        archivePaths[a.id] = p
      } else if (a.source.type === 'nexus') {
        needBrowser.push(a)
      } else {
        return fail(`${a.name}: no download source. Add a URL in data/manifest-sources.json on the backend.`)
      }
    }

    // 3b. Free / no-key path: open the downloads list page + MO2 staging folder
    if (needBrowser.length > 0) {
      openDownloadList(downloadsDir, needBrowser)
      send('install:progress', {
        phase: 'mods',
        file:  'Opened the downloads list: open each link, click "Slow Download" (about 5 at a time), and move every archive into the Alduinak downloads folder.',
        index: 0, total: needBrowser.length, skipped: false,
      })
      // Matched by sha256, so paths come back verified regardless of filename; the
      // namePattern only flags likely wrong-version files in the status message.
      const paths = await mo2.waitForDownloads(
        needBrowser.map(a => ({ name: a.name, hash: a.hash, size: a.size, namePattern: nexusNamePattern(a.source.modId, a.name) })),
        (done, total, message) => send('install:progress', { phase: 'mods', file: message, index: done, total, skipped: false }),
        installAbort?.signal)
      needBrowser.forEach((a, i) => { archivePaths[a.id] = paths[i] })
    }

    // 3c. Replay the manifest: extract each archive once, apply directives
    // Reference-count archives across mods + root so each extraction is freed
    // as soon as its last consumer is done (bounds temp disk use).
    const refCount = new Map()
    const bump = ids => { for (const id of ids) refCount.set(id, (refCount.get(id) || 0) + 1) }
    for (const m of modsToInstall) bump(new Set(m.files.filter(f => f.archive).map(f => f.archive)))
    if (needsRootFiles) bump(new Set((manifest.root || []).filter(f => f.archive).map(f => f.archive)))

    mo2.clearCache()
    const extractedDirs = {}
    const ensureExtracted = ids => {
      for (const id of ids) {
        if (extractedDirs[id]) continue
        if (!archivePaths[id]) throw new Error(`archive ${id} was never downloaded`)
        extractedDirs[id] = mo2.extractToCache(archivePaths[id], id)
      }
    }
    const release = ids => {
      for (const id of ids) {
        const left = (refCount.get(id) || 0) - 1
        refCount.set(id, left)
        if (left <= 0 && extractedDirs[id]) { mo2.clearCache(id); delete extractedDirs[id] }
      }
    }

    const failed = []
    for (let i = 0; i < modsToInstall.length; i++) {
      const mod = modsToInstall[i]
      const ids = [...new Set(mod.files.filter(f => f.archive).map(f => f.archive))]
      send('install:progress', { phase: 'mods', file: `Installing ${mod.name}…`, index: i, total: modsToInstall.length, skipped: false })
      try {
        ensureExtracted(ids)
        const r = mo2.applyMod(mod.name, mod.files, extractedDirs, mod.modId, mod.hash)
        if (r.error) failed.push(`${mod.name} (${r.error})`)
      } catch (err) {
        failed.push(`${mod.name} (${err.message})`)
      }
      release(ids)
    }

    if (needsRootFiles && manifest.root && manifest.root.length > 0) {
      const ids = [...new Set(manifest.root.filter(f => f.archive).map(f => f.archive))]
      try {
        ensureExtracted(ids)
        mo2.applyRootFiles(manifest.root, extractedDirs, skyrimPath)
      } catch (err) {
        failed.push(`root files (${err.message})`)
      }
      release(ids)
    }

    mo2.clearCache()

    if (failed.length > 0) return fail(`${failed.length} item(s) failed to install: ${failed.join('; ')}`)

    // 4. Game-root components (only on a version change / fresh game copy)
    if (needsRoot) {
      // SKSE - the build matching the player's game edition (Steam vs GOG).
      try { await installSkseIntoRoot(skyrimPath) }
      catch (err) { return fail(`SKSE install failed: ${err.message}`) }
    }

    // 5. Match MO2 priority + plugin order, record the installed version
    finishOrder()

    store.set('modpackState', 'ready')
    send('install:complete', {
      success: true, mo2: true, upToDate: coreUpToDate, modsTotal: manifest.mods.length,
      ...(setupWarning ? { warning: setupWarning } : {}),
    })
  } catch (err) {
    if (err.message === 'Cancelled') { fail('Install cancelled.'); return }
    fail(`Install failed: ${err.message}`)
    return
  } finally {
    installing = false
  }
}

// Helpers

/**
 * Write the SkyMP client settings file (skymp5-client-settings.txt).
 *
 * Format per SkyMP docs:
 *
 *   Offline mode (server offlineMode: true):
 *     { "server-ip": "...", "server-port": N,
 *       "master": "", "server-master-key": null,
 *       "gameData": { "profileId": <integer> } }
 *
 *   Online mode (server offlineMode: false):
 *     { "server-ip": "...", "server-port": N,
 *       "master": "<masterUrl>", "server-master-key": "<masterKey>" }
 *     Also writes PluginsNoLoad/auth-data-no-load.js so the SkyMP in-game client
 *     finds pre-existing credentials and skips its own Discord OAuth dialog.
 *
 * @param {string} destPath   Absolute path to skymp5-client-settings.txt
 * @param {object} srv        Active server entry { address, port }
 * @param {object} serverInfo Cached serverinfo { offlineMode, masterKey, masterUrl }
 */
function writeClientSettings(destPath, srv, serverInfo) {
  // Start fresh every time - do not preserve stale keys from previous writes.
  // Exception: user hotkey bindings, owned by the settings UI; a launch must never reset them to defaults.
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(destPath, 'utf8')) || {} } catch { /* first run */ }
  prev = { ...prev, ...store.get(PENDING_HOTKEYS) }
  const settings = {}
  for (const k of CLIENT_SETTINGS_HOTKEYS) if (prev[k] !== undefined) settings[k] = prev[k]
  const fov = clampFov(store.get('fov'))
  if (fov !== null) settings.fov = fov

  settings['server-ip']   = srv.address
  settings['server-port'] = Number(srv.port)

  // Default to false (online mode) when serverInfo is unavailable - safer
  // than defaulting to offline, which would write a wrong profileId-based gameData.
  const offlineMode = serverInfo?.offlineMode ?? false

  settings['master']            = serverInfo?.masterUrl || ''
  settings['server-master-key'] = srv.masterKey || serverInfo?.masterKey || null

  if (offlineMode) {
    const profileId = store.get('gameProfileId')
    if (profileId == null) throw new Error('No profileId in store - login with Discord before playing')
    settings['gameData'] = { profileId }
  } else {
    // Write auth-data-no-load.js so the SkyMP in-game client finds pre-existing
    // credentials and skips its own Discord OAuth dialog.
    // The SkyMP client reads: {skyrimPath}/Data/Platform/PluginsNoLoad/auth-data-no-load.js
    // Format: //<RemoteAuthGameData JSON>
    // Shape:  { session, masterApiId, discordUsername, discordDiscriminator, discordAvatar }
    const session     = store.get('gameSession')
    const discordUser = store.get('discordUser')
    const profileId   = store.get('gameProfileId')
    if (session && discordUser && profileId != null) {
      const authDataPath = path.join(path.dirname(destPath), '..', 'PluginsNoLoad', 'auth-data-no-load.js')
      const authData = {
        session,
        masterApiId:          profileId,
        discordUsername:      discordUser.username || discordUser.tag || null,
        discordDiscriminator: null,
        discordAvatar:        discordUser.avatar   || null,
      }
      try {
        fs.mkdirSync(path.dirname(authDataPath), { recursive: true })
        fs.writeFileSync(authDataPath, '//' + JSON.stringify(authData))
        log('[writeClientSettings] auth-data-no-load.js written for', discordUser.username || profileId)
      } catch (err) {
        log('[writeClientSettings] Failed to write auth-data-no-load.js:', err.message)
      }
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify(settings, null, 2) + '\n')
  store.delete(PENDING_HOTKEYS)
}

function fetchJSON(url, headers = {}, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const opts   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith('https') ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers,
    }
    const req = mod.request(opts, res => {
      // Follow same-host redirects (e.g. the reverse proxy upgrading http to
      // https). Cross-host hops and https->http downgrades stay errors so the
      // session header can never leak to another origin.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        let next = null
        try { next = new URL(res.headers.location, url) } catch { /* malformed location */ }
        const sameHost  = next && next.hostname === urlObj.hostname
        const downgrade = next && urlObj.protocol === 'https:' && next.protocol !== 'https:'
        if (next && sameHost && !downgrade && redirectsLeft > 0) {
          return resolve(fetchJSON(next.href, headers, redirectsLeft - 1))
        }
        const e = new Error(`HTTP ${res.statusCode} from ${url} (redirect to ${res.headers.location})`)
        e.statusCode = res.statusCode
        reject(e)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Read a little of the body: backend errors carry an explanatory
        // { error } that is far more useful than the bare status code.
        let body = ''
        res.on('data', c => { if (body.length < 4096) body += c })
        res.on('end', () => {
          let detail = ''
          try { detail = JSON.parse(body).error || '' } catch { /* not JSON */ }
          const e = new Error(`HTTP ${res.statusCode} from ${url}${detail ? `: ${detail}` : ''}`)
          e.statusCode   = res.statusCode
          e.serverError  = detail || undefined
          reject(e)
        })
        res.on('error', () => {
          const e = new Error(`HTTP ${res.statusCode} from ${url}`)
          e.statusCode = res.statusCode
          reject(e)
        })
        return
      }
      // Accumulate Buffers, not a growing string: the install manifest can be
      // hundreds of MB and string += chunk degrades quadratically there.
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy()
      reject(new Error(`Request timed out: ${url}`))
    })
    req.end()
  })
}

// POST JSON and parse the JSON reply. No redirect following: launch-check and
// friends are same-origin API calls where a redirect means misconfiguration.
function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const payload = JSON.stringify(body || {})
    const req = mod.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith('https') ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`HTTP ${res.statusCode} from ${url}`)
          e.statusCode = res.statusCode
          return reject(e)
        }
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)) })
    req.write(payload)
    req.end()
  })
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
