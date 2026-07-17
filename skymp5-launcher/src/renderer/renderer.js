// Window controls
document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize())
document.getElementById('btn-close').addEventListener('click',    () => window.electronAPI.close())

// External nav links
const EXTERNAL_URLS = {
  website: 'https://alduinak.com/',           // e.g. 'https://example.com'
  discord: 'https://discord.gg/Pkxdgt6W8q',   // e.g. 'https://discord.gg/...'
}

document.querySelectorAll('.topnav-link[data-href]').forEach(link => {
  link.addEventListener('click', () => {
    const url = EXTERNAL_URLS[link.dataset.href]
    if (url) window.electronAPI.openExternal(url)
  })
})

// Settings modal
const modalOverlay = document.getElementById('modal-settings')

// loadSettings re-runs main's registry auto-detect and refreshes the path fields.
function openModal() { modalOverlay.hidden = false; loadSettings(); loadGameSettingsTab() }
function closeModal() { modalOverlay.hidden = true }

document.getElementById('btn-gear').addEventListener('click', openModal)
document.getElementById('modal-close').addEventListener('click', closeModal)
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal() })

// Settings tabs
document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true })
    tab.classList.add('active')
    document.getElementById(`tab-${tab.dataset.tab}`).hidden = false
  })
})

// Settings tab: graphics + server hotkeys
// DirectInput scan codes - must match DxScanCode in the Skyrim Platform client.
const KEY_OPTIONS = [
  { label: '— none —', code: 0 },
  { label: 'Enter', code: 28 }, { label: 'Space', code: 57 }, { label: 'Tab', code: 15 },
  { label: 'Left Shift', code: 42 }, { label: 'Left Ctrl', code: 29 }, { label: 'Left Alt', code: 56 },
  { label: 'Caps Lock', code: 58 }, { label: 'Grave (~)', code: 41 },
  { label: 'A', code: 30 }, { label: 'B', code: 48 }, { label: 'C', code: 46 }, { label: 'D', code: 32 },
  { label: 'E', code: 18 }, { label: 'F', code: 33 }, { label: 'G', code: 34 }, { label: 'H', code: 35 },
  { label: 'I', code: 23 }, { label: 'J', code: 36 }, { label: 'K', code: 37 }, { label: 'L', code: 38 },
  { label: 'M', code: 50 }, { label: 'N', code: 49 }, { label: 'O', code: 24 }, { label: 'P', code: 25 },
  { label: 'Q', code: 16 }, { label: 'R', code: 19 }, { label: 'S', code: 31 }, { label: 'T', code: 20 },
  { label: 'U', code: 22 }, { label: 'V', code: 47 }, { label: 'W', code: 17 }, { label: 'X', code: 45 },
  { label: 'Y', code: 21 }, { label: 'Z', code: 44 },
  { label: 'F1', code: 59 }, { label: 'F2', code: 60 }, { label: 'F3', code: 61 }, { label: 'F4', code: 62 },
  { label: 'F5', code: 63 }, { label: 'F6', code: 64 }, { label: 'F7', code: 65 }, { label: 'F8', code: 66 },
  { label: 'F9', code: 67 }, { label: 'F10', code: 68 }, { label: 'F11', code: 87 }, { label: 'F12', code: 88 },
]
const RESOLUTIONS = ['1280x720', '1366x768', '1600x900', '1920x1080', '2560x1080', '2560x1440', '3440x1440', '3840x2160']

function fillKeySelect(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.innerHTML = ''
  for (const o of KEY_OPTIONS) {
    const opt = document.createElement('option')
    opt.value = String(o.code)
    opt.textContent = o.label
    el.appendChild(opt)
  }
}
function setKey(id, code) { const el = document.getElementById(id); if (el) el.value = String(typeof code === 'number' ? code : 0) }
function getKey(id) { const el = document.getElementById(id); return el ? (parseInt(el.value, 10) || 0) : 0 }

;['hk-chat', 'hk-cursor', 'hk-housing', 'hk-interact', 'hk-personal', 'hk-faction'].forEach(fillKeySelect)

async function loadGameSettingsTab() {
  try {
    const g = await window.electronAPI.graphicsLoad()
    if (g && g.ok) {
      const wm = document.getElementById('gfx-windowmode'); if (wm) wm.value = g.windowMode || 'windowed'
      const resSel = document.getElementById('gfx-resolution')
      if (resSel) {
        const cur = (g.width && g.height) ? `${g.width}x${g.height}` : ''
        const list = RESOLUTIONS.slice()
        if (cur && !list.includes(cur)) list.unshift(cur)
        resSel.innerHTML = ''
        for (const r of list) { const o = document.createElement('option'); o.value = r; o.textContent = r; resSel.appendChild(o) }
        if (cur) resSel.value = cur
      }
      const f = g.fades || {}
      const setv = (id, v) => { const e = document.getElementById(id); if (e) e.value = (v === undefined || v === null) ? '' : v }
      setv('gfx-fade-actor', f.actor); setv('gfx-fade-item', f.item); setv('gfx-fade-object', f.object)
      setv('gfx-fade-grass', f.grass); setv('gfx-fade-shadow', f.shadow)
      const iy = document.getElementById('gfx-invert-y'); if (iy) iy.checked = !!g.invertY
      const hint = document.getElementById('gfx-path-hint')
      if (hint) hint.textContent = g.exists ? `Editing: ${g.path}` : `Will be created on save: ${g.path}`
    }
    const h = await window.electronAPI.hotkeysLoad()
    if (h && h.ok) {
      const chat = Array.isArray(h.chatFocus) ? (h.chatFocus.find(c => c !== 28) || h.chatFocus[0] || 20) : 20
      setKey('hk-chat', chat)
      setKey('hk-cursor', h.freeCursor != null ? h.freeCursor : 64)
      setKey('hk-housing', h.housing != null ? h.housing : 35)
      setKey('hk-interact', h.interact != null ? h.interact : 21)
      setKey('hk-personal', h.personal != null ? h.personal : 22)
      setKey('hk-faction', h.faction != null ? h.faction : 34)
    }
  } catch (err) { /* settings tab is best-effort */ }
}

async function saveGameSettingsTab() {
  try {
    const wm = document.getElementById('gfx-windowmode')
    const resSel = document.getElementById('gfx-resolution')
    let width = '', height = ''
    if (resSel && /^\d+x\d+$/.test(resSel.value)) { const p = resSel.value.split('x'); width = p[0]; height = p[1] }
    const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : '' }
    const iy = document.getElementById('gfx-invert-y')
    await window.electronAPI.graphicsSave({
      windowMode: wm ? wm.value : 'windowed',
      width, height,
      invertY: !!(iy && iy.checked),
      fades: { actor: val('gfx-fade-actor'), item: val('gfx-fade-item'), object: val('gfx-fade-object'), grass: val('gfx-fade-grass'), shadow: val('gfx-fade-shadow') },
    })
    const chatKey = getKey('hk-chat')
    await window.electronAPI.hotkeysSave({
      chatFocus: [28, chatKey].filter(c => c > 0),
      freeCursor: getKey('hk-cursor'),
      housing:    getKey('hk-housing'),
      interact:   getKey('hk-interact'),
      personal:   getKey('hk-personal'),
      faction:    getKey('hk-faction'),
    })
  } catch (err) { /* best-effort */ }
}

// Form fields
const fieldSkyrimPath   = document.getElementById('setting-skyrim-path')
const fieldBaseDir      = document.getElementById('setting-base-dir')
const skyrimPathWarning = document.getElementById('skyrim-path-warning')

const DETECT_FAIL_MSG = 'Could not auto-detect Skyrim - set the path manually'

function setPathWarning(msg) {
  skyrimPathWarning.textContent = msg || ''
  skyrimPathWarning.hidden = !msg
}

// Footer server selector
const footerServerName   = document.getElementById('footer-server-name')
const footerServerSelect = document.getElementById('footer-server-select')

footerServerSelect.addEventListener('change', () => {
  window.electronAPI.saveSettings({ activeServerIndex: parseInt(footerServerSelect.value, 10) })
})

// MO2 fields
const fieldMo2Enabled = document.getElementById('setting-mo2-enabled')
const mo2StatusDot    = document.getElementById('mo2-status-dot')
const mo2StatusText   = document.getElementById('mo2-status-text')

// Discord auth state (kept in module scope for PLAY check)
let discordUser         = null
let serverLocked        = false
// Whether the current user is allowed to join (session-aware: set after login
// by re-fetching /api/serverinfo with X-Session).  Defaults true so unauthed
// users are not blocked before they have a chance to log in.
let serverAllowed       = true

// Re-evaluates Play button state whenever lock/whitelist state changes.
// Call this after login, logout, and initial serverinfo load.
function updateLockState() {
  // While the game runs (or a play sequence is in flight) the button is
  // managed by updatePlayButton() - don't fight over it here.
  if (gameRunning || playBusy) return

  if (serverLocked && discordUser && !serverAllowed) {
    // Logged in but not on the server lock allow-list
    btnConnect.disabled = true
    btnConnect.title    = 'The server is currently locked.'
    connectWarning.textContent = 'Server is currently locked - you are not on the allow list.'
    connectWarning.classList.add('visible')
  } else if (!serverLocked && discordUser && !serverAllowed) {
    // Logged in but not on the whitelist
    btnConnect.disabled = true
    btnConnect.title    = 'You are not on the server whitelist.'
    connectWarning.textContent = 'You are not on the server whitelist.'
    connectWarning.classList.add('visible')
  } else {
    btnConnect.disabled = false
    btnConnect.title    = ''
    // Fix instantly disappearing
    const lockMessages = [
      'You are not on the server whitelist.',
    ]
    if (lockMessages.includes(connectWarning.textContent)) {
      connectWarning.classList.remove('visible')
      connectWarning.textContent = ''
    }
  }
}

// Load / save settings
async function loadSettings() {
  const s = await window.electronAPI.loadSettings()
  fieldSkyrimPath.value = s.skyrimPath || ''
  // Empty here means main's registry auto-detect already failed.
  setPathWarning(s.skyrimPath ? '' : DETECT_FAIL_MSG)
  fieldBaseDir.value = s.baseDirPath || ''

  // Footer server selector - dropdown when >1 server, plain text otherwise
  if (s.servers && s.servers.length > 1) {
    footerServerName.hidden   = true
    footerServerSelect.hidden = false
    footerServerSelect.innerHTML = ''
    s.servers.forEach((srv, i) => {
      const opt = document.createElement('option')
      opt.value       = i
      opt.textContent = srv.name
      opt.selected    = i === (s.activeServerIndex || 0)
      footerServerSelect.appendChild(opt)
    })
  } else {
    footerServerName.hidden   = false
    footerServerSelect.hidden = true
    if (s.servers && s.servers.length === 1) {
      footerServerName.textContent = s.servers[0].name
    }
  }

  // Restore Discord user from persisted store
  if (s.discordUser) {
    discordUser = s.discordUser
    renderTopbarDiscord()
  }

  // Restore MO2 settings
  fieldMo2Enabled.checked = !!s.mo2Enabled
  refreshMo2Status()

  // Restore isolated-game setting
  fieldIsolated.checked = !!s.isolatedGame
  refreshIsolatedStatus()

  return s
}

// Discord topbar widget
const discordTopbarSlot = document.getElementById('discord-topbar-slot')

function renderTopbarDiscord() {
  discordTopbarSlot.innerHTML = ''

  if (discordUser) {
    const wrap = document.createElement('div')
    wrap.className = 'discord-topbar-user'

    if (discordUser.avatar) {
      const img = document.createElement('img')
      img.className = 'discord-topbar-avatar'
      img.src = discordUser.avatar
      img.alt = discordUser.username
      wrap.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className   = 'discord-topbar-avatar-placeholder'
      ph.textContent = '✦'
      wrap.appendChild(ph)
    }

    const name = document.createElement('span')
    name.className   = 'discord-topbar-name'
    name.textContent = `Discord: ${discordUser.tag || discordUser.username}`
    wrap.appendChild(name)

    const logoutBtn = document.createElement('button')
    logoutBtn.className   = 'discord-topbar-logout'
    logoutBtn.title       = 'Logout'
    logoutBtn.textContent = '✕'
    logoutBtn.addEventListener('click', async () => {
      await window.electronAPI.discordLogout()
      discordUser   = null
      serverAllowed = true  // reset: access unknown until next login
      renderTopbarDiscord()
      updateLockState()
    })
    wrap.appendChild(logoutBtn)

    discordTopbarSlot.appendChild(wrap)
  } else {
    const loginBtn = document.createElement('button')
    loginBtn.className   = 'btn-discord-topbar'
    loginBtn.textContent = 'Discord Login'
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled    = true
      loginBtn.textContent = 'Waiting for Discord…'
      loginBtn.title       = 'Finish logging in from the browser window that just opened.'
      if (connectWarning.textContent.startsWith('Discord login failed:')) {
        connectWarning.classList.remove('visible')
        connectWarning.textContent = ''
      }
      const result = await window.electronAPI.discordLogin()
      if (result.success) {
        discordUser = result.user
        // Re-fetch serverinfo now that we have a session - the backend will
        // evaluate whitelist / lock access and return the correct `allowed` flag.
        const freshInfo = await window.electronAPI.fetchServerInfo()
        serverAllowed = freshInfo ? freshInfo.allowed !== false : true
        renderTopbarDiscord()
        updateLockState()
      } else {
        loginBtn.disabled    = false
        loginBtn.textContent = 'Discord Login'
        loginBtn.title       = ''
        // Stays visible until the next attempt - the user is usually still
        // alt-tabbed in the browser when the failure lands.
        connectWarning.textContent = `Discord login failed: ${result.error}`
        connectWarning.classList.add('visible')
      }
    })
    discordTopbarSlot.appendChild(loginBtn)
  }
}

renderTopbarDiscord()


// Nexus topbar widget
// Login is the one-click SSO flow (registered application slug): the button
// opens nexusmods.com in the browser and the key arrives over the SSO
// websocket. The old paste-your-API-key modal is gone.
const nexusTopbarSlot = document.getElementById('nexus-topbar-slot')

let nexusUser = null

function renderTopbarNexus() {
  nexusTopbarSlot.innerHTML = ''

  if (nexusUser) {
    const wrap = document.createElement('div')
    wrap.className = 'discord-topbar-user nexus-topbar-user'

    if (nexusUser.profileUrl) {
      const img = document.createElement('img')
      img.className = 'discord-topbar-avatar'
      img.src = nexusUser.profileUrl
      img.alt = nexusUser.name
      wrap.appendChild(img)
    }

    const name = document.createElement('span')
    name.className   = 'discord-topbar-name'
    name.textContent = `Nexus: ${nexusUser.name}${nexusUser.isPremium ? ' \u2605' : ''}`
    name.title       = nexusUser.isPremium
      ? 'Nexus Premium - automatic mod downloads enabled'
      : 'Nexus free account - downloads open in the browser'
    wrap.appendChild(name)

    const logoutBtn = document.createElement('button')
    logoutBtn.className   = 'discord-topbar-logout'
    logoutBtn.title       = 'Logout from Nexus'
    logoutBtn.textContent = '\u2715'
    logoutBtn.addEventListener('click', async () => {
      await window.electronAPI.nexusLogout()
      nexusUser = null
      renderTopbarNexus()
    })
    wrap.appendChild(logoutBtn)

    nexusTopbarSlot.appendChild(wrap)
  } else {
    const loginBtn = document.createElement('button')
    loginBtn.className   = 'btn-nexus-topbar'
    loginBtn.textContent = 'Nexus Login'
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled    = true
      loginBtn.textContent = 'Waiting for Nexus…'
      loginBtn.title       = 'Click Authorise on the Nexus page that just opened.'
      if (connectWarning.textContent.startsWith('Nexus login failed:')) {
        connectWarning.classList.remove('visible')
        connectWarning.textContent = ''
      }
      const result = await window.electronAPI.nexusSsoLogin()
      if (result.success) {
        nexusUser = result.user
        renderTopbarNexus()
      } else {
        loginBtn.disabled    = false
        loginBtn.textContent = 'Nexus Login'
        loginBtn.title       = ''
        connectWarning.textContent = `Nexus login failed: ${result.error}`
        connectWarning.classList.add('visible')
      }
    })
    nexusTopbarSlot.appendChild(loginBtn)
  }
}

window.electronAPI.nexusGetUser().then(user => {
  nexusUser = user
  renderTopbarNexus()
})

// Isolated game copy UI
const isolatedDot       = document.getElementById('isolated-status-dot')
const isolatedText      = document.getElementById('isolated-status-text')
const fieldIsolated     = document.getElementById('setting-isolated-game')
const btnCreateIsolated = document.getElementById('btn-create-isolated')
const btnInstallMo2     = document.getElementById('btn-install-mo2')
const btnInstallSkse    = document.getElementById('btn-install-skse')
const btnInstallClient  = document.getElementById('btn-install-client')
const btnFullInstall    = document.getElementById('btn-full-install')
const isolatedGroup     = document.getElementById('isolated-install-group')

// locks the full install until there's a game to manage
function refreshDownloadModsState(st) {
  if (mo2InstallRunning) return  // button is in Cancel mode; don't fight it
  const ready = !fieldIsolated.checked || st.ready
  btnFullInstall.disabled = !ready
  btnFullInstall.title = ready
    ? ''
    : 'Install the game files first, or turn off Portable Skyrim Mode in the Troubleshooting tab.'
}

async function refreshIsolatedStatus() {
  const st = await window.electronAPI.isolatedStatus()
  // Portable mode off: the game-copy button and status are irrelevant,
  // so hide them instead of explaining them.
  isolatedGroup.hidden = !fieldIsolated.checked
  btnCreateIsolated.hidden = !fieldIsolated.checked
  if (!st.ready) {
    isolatedDot.className    = 'vortex-status-dot'
    isolatedText.textContent = 'Game copy not installed yet - use Install Game Copy'
  } else if (!fieldIsolated.checked) {
    isolatedDot.className    = 'vortex-status-dot dot-warn'
    isolatedText.textContent = 'Alduinak install exists - playing from the original Skyrim'
  } else {
    isolatedDot.className    = 'vortex-status-dot dot-ok'
    isolatedText.textContent = `Alduinak installed at ${st.base || st.dir}`
  }
  refreshDownloadModsState(st)
}

btnCreateIsolated.addEventListener('click', async () => {
  btnCreateIsolated.disabled = true

  window.electronAPI.removeIsolatedListeners()
  // Game-copy steps stream into the shared install progress log.
  window.electronAPI.onIsolatedProgress(msg => installLive(msg))
  installLog('Installing game copy…')

  const result = await window.electronAPI.createIsolated(fieldBaseDir.value.trim())
  window.electronAPI.removeIsolatedListeners()

  btnCreateIsolated.disabled = false

  if (!result.success) {
    installLog(`Error: ${result.error}`)
    return
  }
  // The base may have been nested under \Alduinak - reflect what was used.
  if (result.dir) fieldBaseDir.value = result.dir
  installLog('Game copy ready ✓')
  fieldIsolated.checked = true
  await window.electronAPI.saveSettings({ isolatedGame: true })
  refreshIsolatedStatus()
  refreshPlayState()
})

fieldIsolated.addEventListener('change', refreshIsolatedStatus)

document.getElementById('btn-save').addEventListener('click', async () => {
  const data = {
    skyrimPath:   fieldSkyrimPath.value.trim(),
    baseDirPath:  fieldBaseDir.value.trim(),
    mo2Enabled:   fieldMo2Enabled.checked,
    isolatedGame: fieldIsolated.checked,
  }

  await window.electronAPI.saveSettings(data)
  await saveGameSettingsTab()
  refreshMo2Status()

  const btn = document.getElementById('btn-save')
  btn.textContent = 'Saved!'
  setTimeout(() => { btn.textContent = 'Save Settings' }, 1400)
})

// Browse folder
document.getElementById('btn-browse').addEventListener('click', async () => {
  const folder = await window.electronAPI.openFolder()
  if (folder) { fieldSkyrimPath.value = folder; setPathWarning('') }
})

// Browse install location (dialog fallback for the Install Location field)
document.getElementById('btn-browse-base').addEventListener('click', async () => {
  const folder = await window.electronAPI.openFolder('Choose where to install Alduinak (~16 GB: MO2 + game copy)')
  if (folder) fieldBaseDir.value = folder
})

// Detect Skyrim from the registry (persists on success)
document.getElementById('btn-detect-path').addEventListener('click', async () => {
  const r = await window.electronAPI.detectSkyrimPath()
  if (r && r.path) {
    fieldSkyrimPath.value = r.path
    setPathWarning('')
  } else {
    setPathWarning(DETECT_FAIL_MSG)
  }
})

// MO2 UI

const mo2EnableText = document.getElementById('mo2-enable-text')

async function refreshMo2Status() {
  const status  = await window.electronAPI.mo2Status()
  const enabled = fieldMo2Enabled.checked

  // Checkbox caption reflects what disabling MO2 means.
  mo2EnableText.textContent = enabled
    ? 'Launch the game through MO2 - mods stay out of your Skyrim folder'
    : 'You will need to install mods manually.'

  if (!status.installed) {
    mo2StatusDot.className    = 'vortex-status-dot'
    mo2StatusText.textContent = 'MO2 not installed yet - use Install MO2'
  } else if (!enabled) {
    mo2StatusDot.className    = 'vortex-status-dot dot-warn'
    mo2StatusText.textContent = `MO2 ${status.version} ready (${status.modCount} mods) - launching without it`
  } else {
    mo2StatusDot.className    = 'vortex-status-dot dot-ok'
    mo2StatusText.textContent = `MO2 ${status.version} active (${status.modCount} mods)`
  }
}

const btnOpenMo2  = document.getElementById('btn-open-mo2')
const mo2OpenWarn = document.getElementById('mo2-open-warning')
btnOpenMo2.addEventListener('click', async () => {
  btnOpenMo2.disabled    = true
  btnOpenMo2.textContent = 'MO2 is running'
  if (mo2OpenWarn) mo2OpenWarn.hidden = false

  const result = await window.electronAPI.mo2Open()
  if (!result.success) {
    alert(`Could not open MO2: ${result.error}`)
    btnOpenMo2.disabled    = false
    btnOpenMo2.textContent = 'Open & Configure MO2'
    if (mo2OpenWarn) mo2OpenWarn.hidden = true
  }
})

fieldMo2Enabled.addEventListener('change', refreshMo2Status)

document.getElementById('btn-open-install').addEventListener('click', async () => {
  const r = await window.electronAPI.openInstallFolder()
  if (!r.success) alert(`Could not open the install folder: ${r.error}`)
})

// Troubleshooting: manual launch buttons
const troubleLaunchStatus = document.getElementById('trouble-launch-status')

document.getElementById('btn-launch-mo2').addEventListener('click', async () => {
  troubleLaunchStatus.textContent = 'Launching via MO2…'
  const r = await window.electronAPI.launchViaMO2()
  troubleLaunchStatus.textContent = r.success ? 'Launched via MO2 ✓' : `Error: ${r.error}`
})

document.getElementById('btn-launch-direct').addEventListener('click', async () => {
  troubleLaunchStatus.textContent = 'Launching SKSE…'
  const r = await window.electronAPI.launchDirect()
  troubleLaunchStatus.textContent = r.success ? 'Launched ✓' : `Error: ${r.error}`
})

// Installation tab: shared install progress log
// All five install buttons stream their progress into the one <pre> below them.
const installProgressEl = document.getElementById('install-progress')
let installLogLines = []
let installLiveLine = ''

function renderInstallProgress() {
  installProgressEl.textContent = installLogLines.concat(installLiveLine ? [installLiveLine] : []).join('\n')
  installProgressEl.scrollTop = installProgressEl.scrollHeight
}
// Transient line (per-file progress) - overwritten by the next update.
function installLive(msg) { installLiveLine = msg; renderInstallProgress() }
// Permanent line (start/finish/error) - settles the current live line first.
function installLog(msg) {
  if (installLiveLine) { installLogLines.push(installLiveLine); installLiveLine = '' }
  installLogLines.push(msg)
  if (installLogLines.length > 300) installLogLines.splice(0, installLogLines.length - 300)
  renderInstallProgress()
}

function formatInstallProgress({ phase, file, index, total, skipped }) {
  if (phase === 'download') return file
  if (phase === 'mods') return total > 0 ? `[mods ${index}/${total}] ${file}` : file
  return `${skipped ? '[skip]' : `[${index}/${total}]`} ${file}`
}

// Single owner of the install channels, attached once: progress always feeds
// the shared pane (plus an optional per-flow mirror) and completion resolves
// whichever flow started the install. Nothing detaches these, so a second
// button click can no longer strand a running install's events.
let installCompleteHandler = null
let installProgressMirror = null
window.electronAPI.onInstallProgress(p => {
  if (installProgressMirror) installProgressMirror(p)
  installLive(formatInstallProgress(p))
})
window.electronAPI.onInstallComplete(d => {
  const cb = installCompleteHandler
  installCompleteHandler = null
  installProgressMirror = null
  if (cb) cb(d)
})

function installBusy() {
  if (installCompleteHandler) { installLog('An install is already running.'); return true }
  return false
}

// Install MO2 (standalone)
btnInstallMo2.addEventListener('click', async () => {
  btnInstallMo2.disabled = true
  installLog('Installing Mod Organizer 2…')
  const r = await window.electronAPI.installMo2Only()
  installLog(r.success ? 'MO2 installed ✓' : `Error: ${r.error}`)
  btnInstallMo2.disabled = false
  refreshMo2Status()
})

// Install SKSE (standalone)
btnInstallSkse.addEventListener('click', async () => {
  btnInstallSkse.disabled = true
  installLog('Installing SKSE…')
  const r = await window.electronAPI.installSkse()
  installLog(r.success ? 'SKSE installed ✓' : `Error: ${r.error}`)
  btnInstallSkse.disabled = false
})

// Install / Update Client Files
btnInstallClient.addEventListener('click', () => {
  if (installBusy()) return
  btnInstallClient.disabled = true
  installCompleteHandler = (({ success, error, upToDate }) => {
    btnInstallClient.disabled = false
    if (!success) {
      installLog(`Error: ${error}`)
      return
    }
    installLog(upToDate ? 'Client files up to date ✓' : 'Client files installed ✓')
  })
  installLog('Installing client files…')
  window.electronAPI.startInstall('client')
})

// Full install (MO2 + client files + modpack manifest)
let mo2InstallRunning = false

function startModpackInstall() {
  // While an install runs the same button cancels it, so a wedged install
  // can always be stopped and retried without restarting the launcher.
  if (mo2InstallRunning) {
    installLog('Cancelling…')
    window.electronAPI.cancelInstall()
    return
  }
  if (installBusy()) return
  mo2InstallRunning = true
  btnFullInstall.textContent = 'Cancel Install'
  installLog('Installing modlist…')

  installCompleteHandler = (({ success, error, upToDate, warning, modsTotal }) => {
    mo2InstallRunning = false
    btnFullInstall.textContent = 'Install Modlist'
    // Keep the Play button honest right away instead of waiting for the 10s
    // poll - otherwise a stale UPDATE label eats the player's next click.
    refreshPlayState()
    if (!success) {
      installLog(`Error: ${error}`)
      return
    }
    if (warning) {
      installLog(`⚠ ${warning}`)
      refreshMo2Status()
      return
    }
    installLog(upToDate ? `Modlist up to date ✓ - ${modsTotal ?? 0} mods` : `Modlist ready ✓ - ${modsTotal ?? 0} mods`)
    refreshMo2Status()
  })

  window.electronAPI.startInstall('modlist')
}
btnFullInstall.addEventListener('click', startModpackInstall)

// PLAY button
// One click does everything: verify/refresh client files, sync the load
// order, then launch. While the game runs the button reflects that state.
const btnConnect     = document.getElementById('btn-connect')
const connectWarning = document.getElementById('connect-warning')

let gameRunning     = false
let playBusy        = false
let isoReady        = true   // isolation disabled, or the game copy exists
let updateAvailable = false  // server has newer client files than installed

const PLAY_LABEL = '\u25BA PLAY'
const updatePill = document.getElementById('update-pill')

function updatePlayButton() {
  updatePill.hidden = !(updateAvailable && isoReady && !gameRunning)

  if (gameRunning) {
    btnConnect.disabled    = true
    btnConnect.textContent = '\u23F3 GAME RUNNING'
    btnConnect.title       = 'Skyrim is currently running.'
    return
  }
  if (playBusy) return  // label managed by the play/update sequence

  if (!isoReady) {
    btnConnect.disabled    = false
    btnConnect.textContent = '\u2699 INSTALL'
    btnConnect.title       = 'Installs Alduinak automatically, then launches.'
    return
  }

  if (updateAvailable) {
    btnConnect.disabled    = false
    btnConnect.textContent = '\u2913 UPDATE'
    btnConnect.title       = 'A client files update is available.'
    return
  }

  btnConnect.textContent = PLAY_LABEL
  btnConnect.title       = ''
  btnConnect.disabled    = false
  updateLockState()
}

// Re-evaluate the install/update state (called at startup, after installs,
// after the game copy is created, and on a slow poll).
async function refreshPlayState() {
  const iso = await window.electronAPI.isolatedStatus()
  isoReady = !iso.enabled || iso.ready

  const uc = await window.electronAPI.filesUpdateCheck()
  updateAvailable = !!uc.updateAvailable
  if (uc.serverVersion) clientVersionEl.textContent = `v${uc.serverVersion}`

  updatePlayButton()
}
setInterval(refreshPlayState, 10_000)

async function pollGameRunning() {
  const running = await window.electronAPI.gameIsRunning()
  if (running !== gameRunning) {
    gameRunning = running
    updatePlayButton()
  }
}
setInterval(pollGameRunning, 10_000)
pollGameRunning()

function showWarning(text) {
  connectWarning.textContent = text
  connectWarning.classList.add('visible')
}

function clearWarning() {
  connectWarning.classList.remove('visible')
  connectWarning.textContent = ''
}

// Run the installer (auto mode) and resolve with its completion result,
// mirroring progress onto the Play button / warning strip.
function runInstallForPlay() {
  return new Promise(resolve => {
    if (installCompleteHandler) {
      return resolve({ success: false, error: 'An install is already running - wait for it to finish.' })
    }
    installProgressMirror = ({ phase, file }) => {
      btnConnect.textContent = phase === 'download' ? '\u2913 DOWNLOADING\u2026' : '\u2699 INSTALLING\u2026'
      showWarning(file)
    }
    installCompleteHandler = result => resolve(result)
    window.electronAPI.startInstall('auto')
  })
}

btnConnect.addEventListener('click', async () => {
  if (gameRunning || playBusy) return

  // settings:load re-runs the registry auto-detect for an empty/invalid path,
  // so an empty result here means Skyrim really could not be found.
  const s = await window.electronAPI.loadSettings()
  if (!s.skyrimPath) {
    showWarning('Could not auto-detect Skyrim - set the path manually in Settings.')
    openModal()
    return
  }

  // Launch prerequisites. A pending update or first-run install still runs -
  // the files refresh, and the warning explains what is missing before the
  // game can start.
  const blockers = []
  if (discordUser && !serverAllowed) {
    blockers.push(serverLocked
      ? 'Server is currently locked - you are not on the allow list.'
      : 'You are not on the server whitelist.')
  }
  if (!discordUser) blockers.push('Login with Discord first - use the button in the toolbar.')

  const needsGameCopy = !isoReady
  if (blockers.length > 0 && !updateAvailable && !needsGameCopy) {
    showWarning(blockers[0])
    return
  }

  playBusy            = true
  btnConnect.disabled = true
  clearWarning()

  try {
    // 0. First run: create the game copy + MO2 at the default/current install
    // location automatically instead of bouncing the player into Settings.
    if (needsGameCopy) {
      btnConnect.textContent = '\u2699 INSTALLING\u2026'
      window.electronAPI.removeIsolatedListeners()
      window.electronAPI.onIsolatedProgress(msg => showWarning(msg))
      const created = await window.electronAPI.createIsolated()
      window.electronAPI.removeIsolatedListeners()
      if (!created.success) {
        showWarning(created.error || 'Install failed.')
        return
      }
      fieldIsolated.checked = true
      await window.electronAPI.saveSettings({ isolatedGame: true })
      refreshIsolatedStatus()
      isoReady = true
      clearWarning()
    }

    // 1. Make sure client files are present and current (fast no-op when up
    // to date; a pending update or fresh install runs the full pipeline here).
    btnConnect.textContent = needsGameCopy ? '\u2699 INSTALLING\u2026'
      : (updateAvailable ? '\u2913 UPDATING\u2026' : '\u2699 CHECKING FILES\u2026')
    const install = await runInstallForPlay()
    if (!install.success) {
      showWarning(install.error || 'Update failed.')
      return
    }
    if (install.warning) showWarning(`\u26A0 ${install.warning}`)

    // Updated but not launchable yet (e.g. no Discord login): say why and stop.
    if (blockers.length > 0) {
      showWarning(blockers[0])
      return
    }

    // 2. Launch - main also re-syncs plugins.txt against the server load order.
    // One click both updates and launches; no second press needed.
    btnConnect.textContent = '\u25BA LAUNCHING\u2026'
    if (!install.warning) clearWarning()
    const result = await window.electronAPI.launchSkse()

    if (!result.success) {
      showWarning(result.error)
      return
    }

    if (!install.warning) clearWarning()
    gameRunning = true  // optimistic; the 10s poll keeps it honest
  } finally {
    playBusy = false
    await refreshPlayState()
  }
})

// Server status
// The badge follows the GAME SERVER's state as reported by /api/status
// (heartbeat, falling back to a metrics-port probe) - a reachable backend
// with a dead game server reads OFFLINE.
const badgeStatus  = document.getElementById('badge-status')
const badgeLabel   = document.getElementById('badge-label')
const badgePlayers = document.getElementById('badge-players')
// Footer player count hidden for now - the topbar badge already shows it.
// const footerPlayers = document.getElementById('footer-players')

// track reachability so we can resync the one-shot panels when the backend returns
let backendWasReachable = null

async function checkServerStatus() {
  const data = await window.electronAPI.fetchStatus()
  const backendUp = !!(data && data.ok)   // drives the reconnect resync below
  if (!data || !data.ok || data.status !== 'online') {
    badgeStatus.classList.remove('online')
    badgeLabel.textContent = 'OFFLINE'
    badgePlayers.hidden = true
    // footerPlayers.textContent = '—'
  } else {
    badgeStatus.classList.add('online')
    badgeLabel.textContent = 'ONLINE'
    if (data.players != null) {
      badgePlayers.textContent = `${data.players} PLAYERS`
      badgePlayers.hidden = false
      // footerPlayers.textContent = `${data.players}`
    } else {
      badgePlayers.hidden = true
      // footerPlayers.textContent = '—'
    }
  }

  // resync only when the backend goes offline then back online; skip the first poll
  if (backendUp && backendWasReachable === false) {
    refreshServerData()
  }
  backendWasReachable = backendUp
}

// re-pull panels that only load at startup; player count already polls itself
function refreshServerData() {
  loadNews()
  loadModlist()
  loadServerInfo()
  refreshPlayState()   // client version + update availability
}

// Server info strip
async function loadServerInfo() {
  const info = await window.electronAPI.fetchServerInfo()
  if (!info || info.error) return

  const strip      = document.getElementById('server-info-strip')
  const nameEl     = document.getElementById('sinfo-name')
  const capEl      = document.getElementById('sinfo-capacity')
  const modeEl     = document.getElementById('sinfo-mode')
  const modeSep    = document.getElementById('sinfo-mode-sep')
  const discEl     = document.getElementById('sinfo-discord')
  const discSep    = document.getElementById('sinfo-discord-sep')
  const lockEl     = document.getElementById('sinfo-locked')
  const lockSep    = document.getElementById('sinfo-locked-sep')
  const footerName = document.getElementById('footer-server-name')

  nameEl.textContent = info.name
  capEl.textContent  = `Max ${info.maxPlayers} players`
  footerName.textContent = info.name

  if (info.gamemode) {
    modeEl.textContent = info.gamemode
    modeEl.hidden  = false
    modeSep.hidden = false
  }

  if (info.discordAuthRequired) {
    discEl.hidden  = false
    discSep.hidden = false
  }

  if (info.locked) {
    serverLocked   = true
    lockEl.hidden  = false
    lockSep.hidden = false
  }

  // `allowed` is session-aware: false only when a session was sent and the
  // backend rejected it (locked/not whitelisted).  Without a session it
  // defaults to true - access is re-checked after Discord login.
  // `sessionValid: false` means the stored session expired - treat as logged out.
  if (info.sessionValid === false && discordUser) {
    // Session expired - clear stale auth so the user can log in again cleanly.
    await window.electronAPI.discordLogout()
    discordUser   = null
    serverAllowed = true
    renderTopbarDiscord()
  } else if (info.allowed === false) {
    serverAllowed = false
  }

  updateLockState()

  strip.hidden = false
}

// Launcher update check
const launcherVersionEl = document.getElementById('launcher-version')
const clientVersionEl   = document.getElementById('client-version')

// The check runs every 10s (see the polling block at the bottom), so the
// UPDATE AVAILABLE state appears while the launcher is open - no restart
// needed. Click/progress handlers are registered exactly once here; the
// periodic check only flips the label state.
let launcherUpdateReady = false

window.electronAPI.onUpdateProgress(d => {
  if (!launcherVersionEl.dataset.updating) return
  if (d.phase === 'download' && d.total > 0) {
    launcherVersionEl.textContent = `Downloading update… ${Math.round(d.received / d.total * 100)}%`
  } else if (d.phase === 'install') {
    launcherVersionEl.textContent = 'Installing - the launcher will restart…'
  }
})

launcherVersionEl.addEventListener('click', async () => {
  if (!launcherUpdateReady || launcherVersionEl.dataset.updating) return
  launcherVersionEl.dataset.updating = '1'
  launcherVersionEl.textContent = 'Downloading update…'
  const r = await window.electronAPI.installUpdate()
  if (!r.ok) {
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    delete launcherVersionEl.dataset.updating
    showWarning(`Update failed: ${r.error}`)
  }
})

async function checkLauncherUpdate() {
  const result = await window.electronAPI.checkUpdate()
  if (!result) return
  if (launcherVersionEl.dataset.updating) return  // don't clobber install progress UI

  if (result.hasUpdate) {
    launcherUpdateReady = true
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    launcherVersionEl.classList.add('update-available')
    launcherVersionEl.title = `v${result.latest} is available - click to update`
  } else {
    launcherUpdateReady = false
    launcherVersionEl.textContent = `v${result.current}`
    launcherVersionEl.classList.remove('update-available')
    launcherVersionEl.title = ''
  }
}

// News
const newsGrid = document.getElementById('news-grid')

// Shared error-state card with a retry button - used by news and modlist
// instead of silently showing fallback content when the backend is unreachable.
function buildErrorState(message, onRetry) {
  const box = document.createElement('div')
  box.className = 'panel-error'

  const text = document.createElement('div')
  text.className   = 'panel-error-text'
  text.textContent = message
  box.appendChild(text)

  const retry = document.createElement('button')
  retry.className   = 'panel-error-retry'
  retry.textContent = 'Retry'
  retry.addEventListener('click', () => {
    retry.disabled    = true
    retry.textContent = 'Retrying…'
    onRetry()
  })
  box.appendChild(retry)

  return box
}

function buildNewsCard(item) {
  const card = document.createElement('div')
  card.className = 'news-card'

  const imgWrap = document.createElement('div')
  imgWrap.className = 'news-card-image'
  if (item.image) {
    const img = document.createElement('img')
    img.src = item.image
    img.alt = item.title
    imgWrap.appendChild(img)
  }

  const body = document.createElement('div')
  body.className = 'news-card-body'

  const tag = document.createElement('div')
  tag.className = 'news-card-tag'
  tag.textContent = item.tag || 'UPDATE'

  const title = document.createElement('div')
  title.className = 'news-card-title'
  title.textContent = item.title

  const date = document.createElement('div')
  date.className = 'news-card-date'
  date.textContent = item.date

  body.appendChild(tag)
  body.appendChild(title)

  if (item.body) {
    const desc = document.createElement('div')
    desc.className = 'news-card-desc'
    desc.textContent = item.body
    body.appendChild(desc)
  }

  body.appendChild(date)

  card.appendChild(imgWrap)
  card.appendChild(body)
  return card
}

async function loadNews() {
  const result = await window.electronAPI.fetchNews()
  newsGrid.innerHTML = ''

  if (!result || !result.ok) {
    newsGrid.appendChild(buildErrorState('Couldn’t reach the server - news unavailable.', loadNews))
    return
  }

  if (result.items.length === 0) {
    const empty = document.createElement('div')
    empty.className   = 'panel-empty'
    empty.textContent = 'No news posted yet.'
    newsGrid.appendChild(empty)
    return
  }

  result.items.forEach(item => newsGrid.appendChild(buildNewsCard(item)))
}

// Modlist

const NEXUS_BASE = 'https://www.nexusmods.com/skyrimspecialedition/mods'

function buildModItem(mod) {
  const item = document.createElement('div')
  item.className = `modlist-item${mod.enabled ? '' : ' modlist-item--disabled'}`

  const dot = document.createElement('span')
  dot.className = `mod-dot ${mod.enabled ? 'mod-dot--enabled' : 'mod-dot--disabled'}`

  const name = document.createElement('span')
  name.className   = 'mod-name'
  name.textContent = mod.name
  name.title       = mod.name

  item.appendChild(dot)
  item.appendChild(name)

  if (mod.required) {
    const badge = document.createElement('span')
    badge.className   = 'mod-badge mod-badge--required'
    badge.textContent = 'REQ'
    item.appendChild(badge)
  }

  // Backend mods are installed automatically by the launcher.
  // Nexus mods are downloaded from Nexus and installed through MO2.
  if (mod.source === 'backend') {
    const badge = document.createElement('span')
    badge.className   = 'mod-badge mod-badge--auto'
    badge.textContent = 'AUTO'
    badge.title       = 'Installed automatically by the launcher'
    item.appendChild(badge)
  } else if (mod.source === 'nexus' && mod.nexusId) {
    const link = document.createElement('a')
    link.className   = 'mod-nexus-link'
    link.textContent = 'Nexus'
    link.title       = 'Open on Nexus Mods'
    link.href        = '#'
    link.addEventListener('click', e => {
      e.preventDefault()
      window.electronAPI.openExternal(`${NEXUS_BASE}/${mod.nexusId}`)
    })
    item.appendChild(link)
  }

  if (mod.version) {
    const ver = document.createElement('span')
    ver.className   = 'mod-version'
    ver.textContent = `v${mod.version}`
    item.appendChild(ver)
  }

  return item
}

// Keep a reference to the last-loaded modlist so the install handler can use it.
let currentModlist = []

async function loadModlist() {
  const panel = document.getElementById('modlist')
  const count = document.getElementById('modlist-count')

  const result = await window.electronAPI.fetchModlist()
  panel.innerHTML = ''

  if (!result || !result.ok) {
    currentModlist    = []
    count.textContent = '—'
    panel.appendChild(buildErrorState('Couldn’t reach the server - modlist unavailable.', loadModlist))
    return
  }

  currentModlist = result.items

  if (currentModlist.length === 0) {
    count.textContent = '0 mods'
    const empty = document.createElement('div')
    empty.className   = 'panel-empty'
    empty.textContent = 'No mods published yet.'
    panel.appendChild(empty)
    return
  }

  currentModlist.forEach(mod => panel.appendChild(buildModItem(mod)))

  const enabled = currentModlist.filter(m => m.enabled).length
  count.textContent = `${enabled} / ${currentModlist.length} enabled`
}

// Metrics modal
const modalMetrics  = document.getElementById('modal-metrics')
const metricsGrid   = document.getElementById('metrics-grid')

document.getElementById('btn-stats').addEventListener('click', () => {
  modalMetrics.hidden = false
  loadMetrics()
})

document.getElementById('metrics-close').addEventListener('click', () => {
  modalMetrics.hidden = true
})

modalMetrics.addEventListener('click', e => {
  if (e.target === modalMetrics) modalMetrics.hidden = true
})

function metricCard(label, value, sub) {
  const card = document.createElement('div')
  card.className = 'metric-card'

  const lEl = document.createElement('div')
  lEl.className   = 'metric-label'
  lEl.textContent = label

  const vEl = document.createElement('div')
  vEl.className   = 'metric-value'
  vEl.textContent = value

  card.appendChild(lEl)
  card.appendChild(vEl)

  if (sub != null) {
    const sEl = document.createElement('div')
    sEl.className   = 'metric-sub'
    sEl.textContent = sub
    card.appendChild(sEl)
  }

  return card
}

async function loadMetrics() {
  metricsGrid.innerHTML = ''
  const loadEl = document.createElement('div')
  loadEl.className   = 'metrics-loading'
  loadEl.textContent = 'Loading…'
  metricsGrid.appendChild(loadEl)

  const result = await window.electronAPI.fetchMetrics()

  metricsGrid.innerHTML = ''

  if (!result || !result.ok) {
    const err = document.createElement('div')
    err.className   = 'metric-card metric-card--error'
    err.textContent = 'Server statistics are currently unavailable.'
    if (result?.error) err.title = result.error
    metricsGrid.appendChild(err)
    return
  }

  const m = result.metrics

  const connects    = m['skymp_connects_total']    ?? null
  const disconnects = m['skymp_disconnects_total'] ?? null
  const online      = (connects !== null && disconnects !== null)
    ? Math.max(0, connects - disconnects)
    : null

  const logins      = m['skymp_logins_total']       ?? null
  const loginErrors = m['skymp_login_errors_total'] ?? null
  const rpcs        = m['skymp_rpc_calls_total']    ?? null
  const tickAvg     = m['skymp_tick_duration_seconds_sum'] != null && m['skymp_tick_duration_seconds_count']
    ? (m['skymp_tick_duration_seconds_sum'] / m['skymp_tick_duration_seconds_count'] * 1000)
    : null

  const fmt = v => v != null ? v.toLocaleString() : '—'
  const fmtMs = v => v != null ? `${v.toFixed(1)} ms` : '—'

  metricsGrid.appendChild(metricCard('Online Now',       fmt(online),      online !== null ? `${fmt(connects)} connects / ${fmt(disconnects)} disconnects` : null))
  metricsGrid.appendChild(metricCard('Total Logins',     fmt(logins),      loginErrors !== null ? `${fmt(loginErrors)} errors` : null))
  metricsGrid.appendChild(metricCard('RPC Calls',        fmt(rpcs),        null))
  metricsGrid.appendChild(metricCard('Avg Tick Duration', fmtMs(tickAvg),  null))
}

// Init
loadSettings()
checkServerStatus()
checkLauncherUpdate()
loadNews()
loadServerInfo()
loadModlist()
// Live 10s heartbeat: game-server status + players (topbar badge), client
// files update (Play button flips to UPDATE), launcher self-update (footer
// label flips to UPDATE AVAILABLE) - all without restarting the launcher.
// refreshPlayState and pollGameRunning poll on their own 10s timers above.
setInterval(checkServerStatus, 10_000)
setInterval(checkLauncherUpdate, 10_000)
refreshPlayState()
