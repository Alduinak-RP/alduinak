// Load .env before anything else - only in unpackaged (dev/local) builds.
// Packaged installers use real environment variables set by the OS / process manager.
if (!require('electron').app.isPackaged) {
  require('dotenv').config()
}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const http   = require('http')
const https  = require('https')
const { spawn, execFileSync } = require('child_process')
const Store  = require('electron-store')
const AdmZip = require('adm-zip')
const config = require('./config')
const mo2    = require('./mo2')
const nexus  = require('./nexus')
const ini    = require('./ini')

const isDev = process.argv.includes('--dev')

// Dev logger
const LOG_FILE = isDev ? path.join(require('os').tmpdir(), 'alduinak-install.log') : null

function log(...args) {
  const line = args.join(' ')
  console.log(line)
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n')
}

if (LOG_FILE) {
  fs.writeFileSync(LOG_FILE, `=== alduinak install log ${new Date().toISOString()} ===\n`)
  console.log('[dev] logging to', LOG_FILE)
}

// Route module debug output through the same logger
mo2.setLogger(log)
nexus.setLogger(log)

// Only user-specific preferences live in the store.
const store = new Store({
  defaults: {
    skyrimPath:        '',
    activeServerIndex: 0,
    cachedServers:     [],   // last-known server list fetched from /api/servers
    filesVersion:      '',   // version tag from last successful file download
    discordUser:       null,
    mo2Enabled:        true,   // launch the game through the managed portable MO2
    nexusApiKey:       '',     // Nexus API key (websocket SSO flow)
    nexusOauth:        null,   // { accessToken, refreshToken, expiresAt } (OAuth flow)
    nexusUser:         null,   // { name, isPremium } from the last validation
    isolatedGame:      true,  // play from the isolated game copy instead of skyrimPath
    gameDirPath:       '',     // legacy: pre-base-dir location of the game copy
    baseDirPath:       '',     // Alduinak base dir: MO2 root, with the game at <base>\skyrim
    forcedDefaultsApplied: false, // server-required graphics defaults seeded once at first install
  }
})

mo2.setRootProvider(() => store.get('baseDirPath') || null)

// Default install root for MO2 + the portable game copy when none is stored.
const DEFAULT_BASE_DIR = 'C:\\Alduinak'

let win = null

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Active server helper
// Returns the currently selected game server from the cached API list,
// or null if no servers have been fetched yet.
function activeServer() {
  const servers = store.get('cachedServers') || []
  if (servers.length === 0) return null
  const idx = Math.min(store.get('activeServerIndex') || 0, servers.length - 1)
  return servers[idx]
}

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
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1711237643', value: 'path' },   // Skyrim SE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 489830', value: 'InstallLocation' },  // Steam
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\Skyrim Special Edition', value: 'installed path' },
]

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

// Stable per-machine id (Windows MachineGuid) reported to the backend for the
// ban system; null when unavailable, the backend treats it as optional.
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
  const p = detectSkyrimPath()
  if (p) store.set('skyrimPath', p)
  return { path: p }
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
  win.once('ready-to-show', () => win.show())

  if (isDev) win.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  ensureSkyrimPath()
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

  // Auto-fill an empty/invalid Skyrim path from the registry (renderer calls
  // this at startup and whenever the settings modal opens).
  ensureSkyrimPath()

  const servers = store.get('cachedServers') || []
  // Whitelist only what the renderer reads. Never spread the whole store: it
  // holds secrets (nexusApiKey, nexusOauth tokens, gameSession, gameProfileId)
  // the renderer must never receive.
  return {
    skyrimPath:        store.get('skyrimPath'),
    baseDirPath:       store.get('baseDirPath') || DEFAULT_BASE_DIR,
    activeServerIndex: store.get('activeServerIndex'),
    mo2Enabled:        store.get('mo2Enabled'),
    isolatedGame:      store.get('isolatedGame'),
    servers,
    multiServer:       servers.length > 1,
    discordUser:       store.get('discordUser') || null,
  }
})
ipcMain.handle('settings:save', (_e, data) => {
  const allowed = ['skyrimPath', 'baseDirPath', 'activeServerIndex', 'mo2Enabled', 'isolatedGame']
  const clean = {}
  for (const k of allowed) if (k in data) clean[k] = data[k]
  store.set(clean)
})

// Graphics / hotkey settings (Settings tab)
// Graphics edit the MO2 portable profile's SkyrimPrefs.ini. NOTE: this assumes
// the Alduinak profile uses profile-specific INI files; and if SSEDisplayTweaks is
// active it may override window mode via its own ini.
function skyrimPrefsPath() {
  return path.join(mo2.getProfileDir(), 'skyrimprefs.ini')
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

ipcMain.handle('graphics:load', () => {
  try {
    const p = skyrimPrefsPath()
    const data = ini.read(p)
    const disp = data['Display'] || {}
    const grass = data['Grass'] || {}
    const controls = data['Controls'] || {}
    const full = String(disp['bFull Screen'] || '0') === '1'
    // Default to borderless when the ini doesn't say otherwise (missing file
    // or keys). An explicit bFull Screen=0 + bBorderless=0 reads as windowed.
    const hasMode = ('bFull Screen' in disp) || ('bBorderless' in disp)
    const borderless = hasMode ? String(disp['bBorderless'] || '0') === '1' : true
    // Resolution fallback chain: profile ini, then the player's original
    // My Games ini, then 1080p.
    let orig = {}
    try {
      const src = findOriginalPrefsIni()
      if (src) orig = ini.read(src)['Display'] || {}
    } catch { /* fall through to 1080p */ }
    return {
      ok: true,
      path: p,
      exists: fs.existsSync(p),
      windowMode: full ? 'fullscreen' : (borderless ? 'borderless' : 'windowed'),
      width:  disp['iSize W'] || orig['iSize W'] || '1920',
      height: disp['iSize H'] || orig['iSize H'] || '1080',
      invertY: String(controls['bInvertYValues'] || '0') === '1',
      fades: {
        actor:  disp['fLODFadeOutMultActors']  || '',
        item:   disp['fLODFadeOutMultItems']   || '',
        object: disp['fLODFadeOutMultObjects'] || '',
        grass:  grass['fGrassStartFadeDistance'] || '',
        shadow: disp['fShadowDistance']        || '',
      },
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
    const f = g.fades || {}
    const num = (x) => (x !== undefined && x !== null && String(x).trim() !== '')
    if (num(f.actor))  display['fLODFadeOutMultActors']  = String(f.actor)
    if (num(f.item))   display['fLODFadeOutMultItems']   = String(f.item)
    if (num(f.object)) display['fLODFadeOutMultObjects'] = String(f.object)
    if (num(f.shadow)) display['fShadowDistance']        = String(f.shadow)
    const edits = { Display: display, Controls: { bInvertYValues: g.invertY ? '1' : '0' } }
    if (num(f.grass)) edits['Grass'] = { fGrassStartFadeDistance: String(f.grass) }
    ini.write(skyrimPrefsPath(), edits)
    return { ok: true, path: skyrimPrefsPath() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('hotkeys:load', () => {
  try {
    const c = readClientSettings()
    const numOrNull = (v) => (typeof v === 'number' ? v : null)
    return {
      ok: true,
      path: clientSettingsPath(),
      chatFocus:  Array.isArray(c.chatFocusKeyCodes) ? c.chatFocusKeyCodes : null,
      freeCursor: numOrNull(c.freeCursorKeyCode),
      housing:    numOrNull(c.housingMenuKeyCode),
      faction:    numOrNull(c.factionMenuKeyCode),
      interact:   numOrNull(c.interactMenuKeyCode),
      personal:   numOrNull(c.personalMenuKeyCode),
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('hotkeys:save', (_e, h) => {
  try {
    h = h || {}
    const c = readClientSettings()
    if (Array.isArray(h.chatFocus))        c.chatFocusKeyCodes  = h.chatFocus.filter(n => typeof n === 'number')
    if (typeof h.freeCursor === 'number')  c.freeCursorKeyCode  = h.freeCursor
    if (typeof h.housing === 'number')     c.housingMenuKeyCode = h.housing
    if (typeof h.faction === 'number')     c.factionMenuKeyCode = h.faction
    if (typeof h.interact === 'number')    c.interactMenuKeyCode = h.interact
    if (typeof h.personal === 'number')    c.personalMenuKeyCode = h.personal
    const p = clientSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(c, null, 2))
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
//   • Wait key (T) unbound   → controlmap override (waiting is disabled here)
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

  // Controls: drop in a controlmap with the Wait key unbound. Only seed it when
  // the game has no controlmap yet, so we never clobber a player's own rebinds.
  try {
    if (gamePath) {
      const dest = path.join(gamePath, 'Data', 'Interface', 'Controls', 'PC', 'controlmap.txt')
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(__dirname, '..', 'assets', 'controlmap.txt'), dest)
        log('[defaults] wrote controlmap override (Wait/T unbound) to ' + dest)
      }
    }
  } catch (err) {
    log('[defaults] could not write controlmap override:', err.message)
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
    const data = await fetchJSON(`${config.apiUrl}/api/status`)
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
  try { return await fetchJSON(`${config.apiUrl}/api/serverinfo`, headers) }
  catch { return null }
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

// True if either path is the same as, or nested inside, the other.
function pathsOverlap(a, b) {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase() + path.sep
  const na = norm(a), nb = norm(b)
  return na.startsWith(nb) || nb.startsWith(na)
}

ipcMain.handle('game:createIsolated', async (_e, baseDirOverride) => {
  const src = store.get('skyrimPath')
  if (!src || !fs.existsSync(path.join(src, 'SkyrimSE.exe'))) {
    return { success: false, error: 'Set a valid Skyrim path first (SkyrimSE.exe not found).' }
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

    // portable copy setup (re-copies when a previous copy was interrupted:
    // SkyrimSE.exe lands first, so its presence alone proves nothing)
    if (!gameCopyComplete(dst)) {
      const copy = await copyGameDir(src, dst)
      if (!copy.success) return copy
    } else {
      log('[isolated] reusing existing game copy at ' + dst)
    }

    // configuration
    let serverInfo = null
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
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
})

// Vanilla root files, by store edition. Only those present get copied.
// Skyrim.ccc is deliberately NOT copied: no cc* plugins are copied either, and
// an orphan ccc list makes the engine treat the AE/CC content set as changed,
// which pops the Creation Club announcement over the main menu on first boot.
// That box is modal and SkyrimPlatform cannot dismiss pre-game menus.
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
// to the original install.
function vanillaMismatches(src, dir) {
  const sizeOf = p => { try { return fs.statSync(p).size } catch { return -1 } }
  const bad = []
  for (const job of vanillaJobs(src)) {
    const want = sizeOf(path.join(src, job.sub, job.rel))
    if (want >= 0 && sizeOf(path.join(dir, job.sub, job.rel)) !== want) bad.push(job)
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

// Metrics
ipcMain.handle('api:metrics', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/metrics`)
    return { ok: true, ...data }
  }
  catch { return { ok: false, error: 'Backend unreachable' } }
})

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
    const allPresent = clientFilesPresent(gamePath)
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

ipcMain.handle('game:isRunning', async () => {
  if (process.platform !== 'win32') return false
  return (await isProcessRunning('SkyrimSE.exe')) || (await isProcessRunning('skse64_loader.exe'))
})

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
function downloadToFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
        return resolve(downloadToFile(res.headers.location, dest, onProgress, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const file = fs.createWriteStream(dest)
      res.on('data', c => { received += c.length; if (onProgress) onProgress(received, total) })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(dest)))
      file.on('error', err => { try { fs.unlinkSync(dest) } catch {} reject(err) })
      res.on('error',  err => { try { fs.unlinkSync(dest) } catch {} reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('Download timed out')) })
  })
}

// In-app launcher update: download the new installer, run it silently, and let
// it relaunch us (--force-run). Replaces the "open the download page" flow.
ipcMain.handle('app:installUpdate', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    if (!data.downloadUrl) return { ok: false, error: 'No download URL is configured on the server.' }
    // The installer is executed with the user's privileges, so refuse to fetch
    // it over anything but HTTPS (no plain-http, no redirect downgrade).
    if (!/^https:/i.test(data.downloadUrl)) {
      return { ok: false, error: 'Refusing to install an update from a non-HTTPS URL.' }
    }

    const dest = path.join(os.tmpdir(), 'AlduinakLauncher-update.exe')
    send('update:progress', { phase: 'download', received: 0, total: 0 })
    await downloadToFile(data.downloadUrl, dest, (received, total) =>
      send('update:progress', { phase: 'download', received, total }))

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

// Files that must exist before we allow launching
const REQUIRED_FILES = [
  path.join('Data', 'Platform', 'Plugins', 'skymp5-client.js'),
  path.join('Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'),
  path.join('Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll'),
]

// Engine fixes preloader
const PRELOADER_DLLS = ['d3dx9_42.dll', 'winhttp.dll']
const preloaderPresent = (gamePath) =>
  !!gamePath && PRELOADER_DLLS.some(f => fs.existsSync(path.join(gamePath, f)))

// True when every client-package file the launcher can check is on disk.
const clientFilesPresent = (gamePath) =>
  !!gamePath &&
  REQUIRED_FILES.every(f => fs.existsSync(path.join(gamePath, f))) &&
  preloaderPresent(gamePath)

ipcMain.handle('launch:skse', async () => {
  const skyrimPath = effectiveGamePath()
  const mo2Enabled = store.get('mo2Enabled')

  if (!skyrimPath) {
    return { success: false, error: 'Skyrim path not configured.' }
  }

  if (mo2Enabled && !mo2.isInstalled()) {
    return { success: false, error: 'MO2 is not set up - open Settings → Mod Manager and run setup.' }
  }

  // Shared pre-launch steps: client settings, load order, file validation.
  const prep = await prepareForLaunch(skyrimPath, mo2Enabled)
  if (!prep.success) return prep

  try {
    if (mo2Enabled) {
      // MO2 manages plugins.txt itself via the profile; launch through its VFS.
      mo2.launchGame()
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
})

// Troubleshooting: force a launch path regardless of the mo2Enabled setting.
ipcMain.handle('launch:viaMO2', async () => {
  const skyrimPath = effectiveGamePath()
  if (!skyrimPath) return { success: false, error: 'Skyrim path not configured.' }
  if (!mo2.isInstalled()) return { success: false, error: 'MO2 is not installed - run Full Install first.' }
  const prep = await prepareForLaunch(skyrimPath, true)
  if (!prep.success) return prep
  try { mo2.launchGame(); return { success: true } }
  catch (err) { return { success: false, error: err.message } }
})

ipcMain.handle('launch:direct', async () => {
  const skyrimPath = effectiveGamePath()
  if (!skyrimPath) return { success: false, error: 'Skyrim path not configured.' }
  const prep = await prepareForLaunch(skyrimPath, false)
  if (!prep.success) return prep
  const exe = path.join(skyrimPath, 'skse64_loader.exe')
  if (!fs.existsSync(exe)) {
    return { success: false, error: `skse64_loader.exe not found in ${skyrimPath}. Install SKSE there first.` }
  }
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', cwd: skyrimPath }).unref()
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
})

/**
 * Common pre-launch pipeline:
 *  1. Re-write skymp5-client-settings.txt so server-ip/port/gameData are current.
 *  2. Sync plugins.txt with the server's published load order (if available).
 *     Blocks the launch when required plugins are missing from Data/.
 *  3. Verify the SkyMP client files exist.
 */
 
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
  const missingFiles = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(skyrimPath, f)))
  if (missingFiles.length > 0) {
    const names = missingFiles.map(f => path.basename(f)).join(', ')
    const hint  = viaMO2 ? 'run Full Install in Settings' : 'run Install'
    problems.push(`Client files missing (${names}); ${hint} first.`)
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
    const missingPlugins = viaMO2
      ? missingPluginsForMO2(skyrimPath, serverInfo.loadOrder)
      : serverInfo.loadOrder
          .map(f => path.basename(f))
          .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()) &&
                       !fs.existsSync(path.join(skyrimPath, 'Data', f)))
    if (missingPlugins.length > 0) {
      problems.push(`Required plugins missing (${missingPlugins.join(', ')}); install the server modlist first.`)
    }
  }

  // Fallback if install fails
  if (viaMO2 && store.get('modpackState') === 'failed') {
    problems.push('The last modpack install did not finish. Press PLAY (it will show UPDATE) or run Full Install to complete it first.')
  }

  // Fallback for engine fixes failure (like with AV software)
  if (!preloaderPresent(skyrimPath)) {
    problems.push('The Engine Fixes preloader dll is missing from the game folder; press PLAY (it will show UPDATE) to reinstall the client files.')
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
  const srv = activeServer()
  let serverInfo = null
  if (srv) {
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
  }

  // Non-portable installs play from the user's real Skyrim folder: quarantine
  // Creation Club content the server doesn't use into "disabled CC mods", or
  // the engine force-loads it via Skyrim.ccc and fights the server load order.
  // The isolated game copy never receives cc* files, so this is a no-op there.
  if (skyrimPath === store.get('skyrimPath')) {
    mo2.disableCcContent(skyrimPath, serverInfo?.loadOrder)
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

  // Load order sync
  let loadOrderFixed = false
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    if (viaMO2) {
      mo2.ensureInstance(skyrimPath, serverInfo.loadOrder)
      const missing = missingPluginsForMO2(skyrimPath, serverInfo.loadOrder)
      if (missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${missing.join(', ')}. ` +
                 `Run Full Install in Settings first.`,
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
      }, { 'x-session': session })
      if (!check.ok) {
        if (check.filesOk === false) {
          return { success: false, error: 'Your client files are out of date. Press the button again to update, then launch.' }
        }
        return { success: false, error: 'Your plugin load order does not match the server. Run Full Install in Settings.' }
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

function missingPluginsForMO2(skyrimPath, serverLoadOrder) {
  const dataDir = path.join(skyrimPath, 'Data')
  const modsDir = mo2.getModsDir()

  let modDirs = []
  try {
    modDirs = fs.readdirSync(modsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(modsDir, e.name))
  } catch {}

  return serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()))
    .filter(f =>
      !fs.existsSync(path.join(dataDir, f)) &&
      !modDirs.some(dir => fs.existsSync(path.join(dir, f))))
}

// Install files

let installing   = false
let installAbort = null   // AbortController for the running install's waits

ipcMain.on('install:start', (_e, mode) => {
  if (installing) {
    // Never ignore the click silently: the user has no other way to know an
    // earlier install is still running (e.g. parked on a downloads wait).
    send('install:progress', {
      phase: 'mods',
      file: 'An install is already running - press Cancel Install to stop it first.',
      index: 0, total: 0, skipped: false,
    })
    return
  }
  installing = true
  installAbort = new AbortController()

  let fn
  if (mode === 'client') {
    fn = runDirectInstall()
  } else if (mode === 'mo2') {
    fn = runMO2Install()
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

// Standalone install steps (Installation tab buttons). Both stream their
// progress over the same install:progress channel as the full installers.

// MO2 only: download/unpack MO2 and refresh the portable instance.
ipcMain.handle('install:mo2only', async () => {
  if (installing) return { success: false, error: 'An install is already running - cancel it first.' }
  installing = true
  try {
    await mo2.ensureInstalled(msg =>
      send('install:progress', { phase: 'download', file: msg, index: 0, total: 0, skipped: false }))
    const gamePath = effectiveGamePath()
    if (gamePath && fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))) {
      let serverInfo = null
      try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
      mo2.ensureInstance(gamePath, serverInfo?.loadOrder)
      mo2.registerNxmHandler()
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    installing = false
  }
})

// SKSE only: download the edition-matched SKSE and install it into the game root.
ipcMain.handle('install:skse', async () => {
  if (installing) return { success: false, error: 'An install is already running - cancel it first.' }
  const gamePath = effectiveGamePath()
  if (!gamePath || !fs.existsSync(path.join(gamePath, 'SkyrimSE.exe'))) {
    return { success: false, error: 'No game folder found - install the game copy or set a valid Skyrim path first.' }
  }
  installing = true
  try {
    await installSkseIntoRoot(gamePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    installing = false
  }
})

// Shared download + extract helpers

/**
 * Stream the client zip from the backend to a local temp file.
 * Calls onProgress(bytesReceived, totalBytes) as data arrives.
 */
function downloadClientZip(tempPath, onProgress) {
  const url = `${config.apiUrl}/api/files/zip`
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode === 404) {
        res.resume()
        return reject(new Error('Update package not found on server. Run npm run merge on the backend.'))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return reject(new Error(`Server returned HTTP ${res.statusCode}`))
      }

      const total    = parseInt(res.headers['content-length'] || '0', 10)
      let   received = 0

      const file = fs.createWriteStream(tempPath)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', err => { try { fs.unlinkSync(tempPath) } catch {} reject(err) })
      res.on('error',  err => { try { fs.unlinkSync(tempPath) } catch {} reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Download timed out')) })
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

async function installClientFilesCore(skyrimPath, srv, serverInfo) {
  const tempZip = path.join(os.tmpdir(), 'alduinak-client.zip')
  const clientSettingsPath = path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')

  try {
    // 1. Check whether a download is needed
    let serverVersion = null
    try {
      const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
      serverVersion = vd.version
    } catch (err) {
      if (err.statusCode === 404) {
        return { success: false, error: 'Client files have not been packaged on the server yet. Ask the server admin to run `npm run build-client`.' }
      }
      // Network error - play on cached files if they exist
      const allPresent = clientFilesPresent(skyrimPath)
      if (!allPresent) return { success: false, error: 'Backend unreachable and client files are not installed. Check your connection.' }
      log('[install] Backend unreachable - files already installed, updating settings only')
      writeClientSettings(clientSettingsPath, srv, serverInfo)
      return { success: true, upToDate: true }
    }

    const allPresent    = clientFilesPresent(skyrimPath)
    const needsDownload = serverVersion !== store.get('filesVersion') || !allPresent

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

    // 3. Extract directly into Skyrim directory
    const extracted = extractClientZip(tempZip, skyrimPath, (file, i, total) => {
      send('install:progress', { phase: 'extract', file, index: i, total, skipped: false })
    })
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

async function runDirectInstall() {
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

  let serverInfo = null
  try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}

  const core = await installClientFilesCore(skyrimPath, srv, serverInfo)
  if (core.success) applyForcedServerDefaults(skyrimPath)
  send('install:complete', core.success
    ? { success: true, upToDate: core.upToDate, ...(integrity.warning ? { warning: integrity.warning } : {}) }
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

// Open the MO2 downloads folder (archive staging) + the backend page listing every file-pinned Nexus link, once per install run.
let _downloadListOpened = false
function openDownloadList(downloadsDir) {
  if (_downloadListOpened) return
  _downloadListOpened = true
  try { fs.mkdirSync(downloadsDir, { recursive: true }); shell.openPath(downloadsDir) } catch {}
  shell.openExternal(`${config.apiUrl}/api/nexus-downloads`)
}

// MO2 install
// Full modpack pipeline: MO2 itself → SkyMP client files → manifest replay.
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

async function runMO2Install() {
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
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
    mo2.ensureInstance(skyrimPath, serverInfo?.loadOrder)
    mo2.registerNxmHandler()
    seedProfilePrefs(store.get('skyrimPath') || skyrimPath)
    applyForcedServerDefaults(skyrimPath)

    // 2. SkyMP client files into the real Data/
    const core = await installClientFilesCore(skyrimPath, srv, serverInfo)
    if (!core.success) return fail(core.error)

    // 3. Mods from the compiled install manifest
    let manifest
    try { manifest = await fetchJSON(`${config.apiUrl}/api/install-manifest`) }
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

    const finishOrder = () => {
      const order = (Array.isArray(manifest.order) && manifest.order.length)
        ? manifest.order.slice()
        : manifest.mods.map(m => m.name)
      if (fs.existsSync(path.join(mo2.getModsDir(), 'SKSE')) && !order.includes('SKSE')) order.push('SKSE')
      mo2.setModlistOrder(order)        // also prunes managed mods dropped from the manifest
      mo2.setPlugins(manifest.plugins)
      store.set('installedRootHash', manifest.rootHash || '')
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
        success: true, mo2: true, upToDate: core.upToDate, modsTotal: 0,
        warning: [vanillaWarning, 'The install manifest has no mods yet - compile it from the reference MO2 install on the backend.']
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
    const modChanged = m =>
      !fs.existsSync(modFolderPath(m)) ||
      !m.hash ||                                   // pre-hash manifest: be safe, reinstall
      mo2.readModHash(m.name) !== m.hash
    const rootSetUp      = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    const rootChanged    = (store.get('installedRootHash') || '') !== (manifest.rootHash || '')
    const needsRoot      = !rootSetUp || rootChanged
    log(`[mo2-install] root check: skse=${rootSetUp} hashChanged=${rootChanged} -> needsRoot=${needsRoot}`)
    const modsToInstall  = manifest.mods.filter(modChanged)

    if (modsToInstall.length === 0 && !needsRoot) {
      finishOrder()
      store.set('modpackState', 'ready')
      send('install:complete', {
        success: true, mo2: true, upToDate: true, modsTotal: manifest.mods.length,
        ...(vanillaWarning ? { warning: vanillaWarning } : {}),
      })
      return
    }

    const archivePaths = {}      // archiveId -> verified local path
    const needBrowser  = []      // nexus archives we couldn't auto-download

    // Acquire only the archives the to-install mods (and root files) reference.
    const neededArchiveIds = new Set()
    for (const m of modsToInstall) for (const f of m.files) if (f.archive) neededArchiveIds.add(f.archive)
    if (needsRoot) for (const f of (manifest.root || [])) if (f.archive) neededArchiveIds.add(f.archive)

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
      openDownloadList(downloadsDir)
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
    if (needsRoot) bump(new Set((manifest.root || []).filter(f => f.archive).map(f => f.archive)))

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

    if (needsRoot && manifest.root && manifest.root.length > 0) {
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
      success: true, mo2: true, upToDate: core.upToDate, modsTotal: manifest.mods.length,
      ...(vanillaWarning ? { warning: vanillaWarning } : {}),
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
  const settings = {}

  settings['server-ip']   = srv.address
  settings['server-port'] = Number(srv.port)

  // Default to false (online mode) when serverInfo is unavailable - safer
  // than defaulting to offline, which would write a wrong profileId-based gameData.
  const offlineMode = serverInfo?.offlineMode ?? false

  settings['master']            = serverInfo?.masterUrl || ''
  settings['server-master-key'] = serverInfo?.masterKey || null

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
