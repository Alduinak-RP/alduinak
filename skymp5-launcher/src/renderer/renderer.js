// Window controls
document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize())
document.getElementById('btn-close').addEventListener('click',    () => window.electronAPI.close())

// External nav links
const EXTERNAL_URLS = {
  website: 'https://alduinak.com/',           // e.g. 'https://example.com'
  discord: 'https://discord.gg/Pkxdgt6W8q',   // e.g. 'https://discord.gg/...'
  patreon: 'https://www.patreon.com/cw/Alduinak',
  legal: 'https://alduinak.com/legal/',
}

document.querySelectorAll('.topnav-link[data-href], .legal-link[data-href]').forEach(link => {
  link.addEventListener('click', () => {
    const url = EXTERNAL_URLS[link.dataset.href]
    if (url) window.electronAPI.openExternal(url)
  })
})

// Settings modal
const modalOverlay = document.getElementById('modal-settings')

// loadSettings re-runs main's registry auto-detect and refreshes the path fields.
function openModal() { modalOverlay.hidden = false; loadSettings(); loadGameSettingsTab() }
function closeModal() { endCapture(true); modalOverlay.hidden = true }

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
    // The ini files may have changed in game or in MO2 since the last look
    if (tab.dataset.tab === 'settings') loadGameSettingsTab()
  })
})

// Settings tab: graphics + server hotkeys
// KeyboardEvent.code -> [DirectInput scan code, label].
// DIK codes must match DxScanCode in the Skyrim Platform client.
const KEY_TABLE = {
  Enter: [28, 'Enter'], Space: [57, 'Space'], Tab: [15, 'Tab'],
  ShiftLeft: [42, 'Left Shift'], ControlLeft: [29, 'Left Ctrl'], AltLeft: [56, 'Left Alt'],
  ShiftRight: [54, 'Right Shift'], ControlRight: [157, 'Right Ctrl'], AltRight: [184, 'Right Alt'],
  CapsLock: [58, 'Caps Lock'], Backquote: [41, 'Grave (~)'], Backspace: [14, 'Backspace'],
  KeyA: [30, 'A'], KeyB: [48, 'B'], KeyC: [46, 'C'], KeyD: [32, 'D'],
  KeyE: [18, 'E'], KeyF: [33, 'F'], KeyG: [34, 'G'], KeyH: [35, 'H'],
  KeyI: [23, 'I'], KeyJ: [36, 'J'], KeyK: [37, 'K'], KeyL: [38, 'L'],
  KeyM: [50, 'M'], KeyN: [49, 'N'], KeyO: [24, 'O'], KeyP: [25, 'P'],
  KeyQ: [16, 'Q'], KeyR: [19, 'R'], KeyS: [31, 'S'], KeyT: [20, 'T'],
  KeyU: [22, 'U'], KeyV: [47, 'V'], KeyW: [17, 'W'], KeyX: [45, 'X'],
  KeyY: [21, 'Y'], KeyZ: [44, 'Z'],
  Digit1: [2, '1'], Digit2: [3, '2'], Digit3: [4, '3'], Digit4: [5, '4'], Digit5: [6, '5'],
  Digit6: [7, '6'], Digit7: [8, '7'], Digit8: [9, '8'], Digit9: [10, '9'], Digit0: [11, '0'],
  Minus: [12, '-'], Equal: [13, '='],
  BracketLeft: [26, '['], BracketRight: [27, ']'],
  Semicolon: [39, ';'], Quote: [40, "'"], Backslash: [43, '\\'],
  Comma: [51, ','], Period: [52, '.'], Slash: [53, '/'],
  F1: [59, 'F1'], F2: [60, 'F2'], F3: [61, 'F3'], F4: [62, 'F4'],
  F5: [63, 'F5'], F6: [64, 'F6'], F7: [65, 'F7'], F8: [66, 'F8'],
  F9: [67, 'F9'], F10: [68, 'F10'], F11: [87, 'F11'], F12: [88, 'F12'],
  Numpad0: [82, 'Numpad 0'], Numpad1: [79, 'Numpad 1'], Numpad2: [80, 'Numpad 2'],
  Numpad3: [81, 'Numpad 3'], Numpad4: [75, 'Numpad 4'], Numpad5: [76, 'Numpad 5'],
  Numpad6: [77, 'Numpad 6'], Numpad7: [71, 'Numpad 7'], Numpad8: [72, 'Numpad 8'],
  Numpad9: [73, 'Numpad 9'],
  NumpadMultiply: [55, 'Numpad *'], NumpadSubtract: [74, 'Numpad -'], NumpadAdd: [78, 'Numpad +'],
  NumpadDecimal: [83, 'Numpad .'], NumpadDivide: [181, 'Numpad /'], NumpadEnter: [156, 'Numpad Enter'],
  NumLock: [69, 'Num Lock'], ScrollLock: [70, 'Scroll Lock'], Pause: [197, 'Pause'], PrintScreen: [183, 'Print Screen'],
  ArrowUp: [200, 'Up'], ArrowDown: [208, 'Down'], ArrowLeft: [203, 'Left'], ArrowRight: [205, 'Right'],
  PageUp: [201, 'Page Up'], PageDown: [209, 'Page Down'],
  Insert: [210, 'Insert'], Delete: [211, 'Delete'], Home: [199, 'Home'], End: [207, 'End'],
  MetaLeft: [219, 'Left Win'], MetaRight: [220, 'Right Win'], ContextMenu: [221, 'Menu'],
}
// MouseEvent.button -> [DxScanCode, label]; left and right stay attack and block, so they cancel a capture
const MOUSE_TABLE = { 1: [258, 'Middle Mouse'], 3: [259, 'Mouse 4'], 4: [260, 'Mouse 5'] }
const DIK_LABELS = { 1: 'Esc', 256: 'Left Mouse', 257: 'Right Mouse', 261: 'Mouse 6', 262: 'Mouse 7', 263: 'Mouse 8' }
// Left and right bind only on Game Hotkeys rows, the attack and block keys
const GAME_MOUSE_TABLE = { ...MOUSE_TABLE, 0: [256, 'Left Mouse'], 2: [257, 'Right Mouse'] }
for (const [dik, label] of [...Object.values(KEY_TABLE), ...Object.values(MOUSE_TABLE)]) DIK_LABELS[dik] = label

const RESOLUTIONS = ['1280x720', '1366x768', '1600x900', '1920x1080', '2560x1080', '2560x1440', '3440x1440', '3840x2160']

function labelForCode(code) {
  if (!code) return '— none —'
  return DIK_LABELS[code] || `0x${code.toString(16)}`
}
function setKey(id, code) {
  const el = document.getElementById(id)
  if (!el) return
  const c = typeof code === 'number' ? code : 0
  el.dataset.code = String(c)
  el.textContent = labelForCode(c)
  showHotkeyConflict()
}
function getKey(id) { const el = document.getElementById(id); return el ? (parseInt(el.dataset.code, 10) || 0) : 0 }
// Shared keys only warn; they are still saved
function showHotkeyConflict() {
  const interact = getKey('hk-alt-interact')
  const interactClash = !!interact && interact === getKey('ghk-activate')
  const el = document.getElementById('hk-conflict')
  if (el) el.hidden = !interactClash
  const uses = new Map()
  for (const id of [...SERVER_HOTKEY_IDS, ...GAME_HOTKEY_IDS]) {
    const btn = document.getElementById(id)
    const code = getKey(id)
    if (!btn || !code) continue
    if (!uses.has(code)) uses.set(code, { ids: [], names: new Set() })
    uses.get(code).ids.push(id)
    uses.get(code).names.add(btn.previousElementSibling.textContent)
  }
  const shared = { hk: [], ghk: [] }
  for (const [code, { ids, names }] of uses) {
    const fixed = CLIENT_FIXED_KEYS[code]
    if (fixed && (fixed[1] || ids.some(id => id.startsWith('hk-')))) names.add(fixed[0])
    // hk-conflict already explains Interact / Menus on the Activate key
    if (names.size < 2 || (interactClash && code === interact && names.size === 2)) continue
    const text = `${labelForCode(code)} (${[...names].join(', ')})`
    for (const section of Object.keys(shared)) if (ids.some(id => id.startsWith(section + '-'))) shared[section].push(text)
  }
  for (const [section, list] of Object.entries(shared)) {
    const warn = document.getElementById(section + '-duplicate')
    if (!warn) continue
    warn.hidden = !list.length
    warn.textContent = `Each of these keys does more than one thing on the same press: ${list.join('; ')}.`
  }
}

// Backspace unbinds server hotkeys except Interact / Menus; gameHotkeys:save drops code 0, so game keys cannot unbind
// Server hotkey button -> [hotkeys:load/save field, default DIK]; hk-chat is separate because it pairs with Enter
const SERVER_HOTKEYS = {
  'hk-cursor': ['freeCursor', 64], 'hk-voice-ptt': ['voicePtt', 47],
  'hk-hide-ui': ['hideUi', 59], 'hk-alt-interact': ['altInteract', 45],
  'hk-emote-wheel': ['emoteWheel', 48],
}
const SERVER_HOTKEY_IDS = ['hk-chat', ...Object.keys(SERVER_HOTKEYS)]
// Game hotkey button id -> [label, controlmap event, default DIK]; the defaults are the vanilla bindings
const GAME_HOTKEYS = {
  'ghk-forward': ['Forward', 'Forward', 17], 'ghk-back': ['Back', 'Back', 31],
  'ghk-left': ['Left', 'Strafe Left', 30], 'ghk-right': ['Right', 'Strafe Right', 32],
  'ghk-left-hand': ['Left Hand', 'Left Attack/Block', 257], 'ghk-right-hand': ['Right Hand', 'Right Attack/Block', 256],
  'ghk-activate': ['Activate', 'Activate', 18], 'ghk-ready': ['Ready', 'Ready Weapon', 19],
  'ghk-menu': ['Menu', 'Tween Menu', 15], 'ghk-pov': ['Toggle POV', 'Toggle POV', 33],
  'ghk-jump': ['Jump', 'Jump', 57], 'ghk-sprint': ['Sprint', 'Sprint', 56],
  'ghk-shout': ['Power', 'Shout', 44], 'ghk-sneak': ['Sneak', 'Sneak', 29],
  'ghk-run': ['Run', 'Run', 42], 'ghk-always-run': ['Always Run', 'Toggle Always Run', 58],
  'ghk-automove': ['Automove', 'Auto-Move', 46], 'ghk-favorites': ['Favorites', 'Favorites', 16],
  'ghk-journal': ['Journal', 'Journal', 36], 'ghk-system': ['System', 'Pause', 1],
  'ghk-inventory': ['Inventory', 'Quick Inventory', 23], 'ghk-magic': ['Magic', 'Quick Magic', 25],
  'ghk-stats': ['Stats', 'Quick Stats', 53], 'ghk-map': ['Map', 'Quick Map', 50],
}
const GHK_MAP = Object.fromEntries(Object.entries(GAME_HOTKEYS).map(([id, [, ev]]) => [id, ev]))
const GAME_HOTKEY_IDS = Object.keys(GAME_HOTKEYS)
const ghkRows = document.getElementById('ghk-rows')
for (const [id, [label]] of Object.entries(GAME_HOTKEYS)) {
  const group = document.createElement('div')
  group.className = 'settings-group'
  group.innerHTML = `<label class="setting-label">${label}</label><button type="button" class="setting-input hotkey-btn" id="${id}"></button>`
  ghkRows.appendChild(group)
}
// DIK -> [use, also shared by Game Hotkeys rows]; movement cancelling an emote is intended, so those only count for Server Hotkeys
const CLIENT_FIXED_KEYS = {
  28: ['Activate Chat', true], 49: ['bounty board', true],
  17: ['emote cancel', false], 30: ['emote cancel', false], 31: ['emote cancel', false],
  32: ['emote cancel', false], 57: ['emote cancel', false], 19: ['emote cancel', false],
}

let activeCapture = null

function endCapture(restorePrev) {
  if (!activeCapture) return
  const { btn, prevCode, onKey, onMouse, timer } = activeCapture
  activeCapture = null
  if (timer) clearTimeout(timer)
  window.removeEventListener('keydown', onKey, { capture: true })
  window.removeEventListener('mouseup', onMouse, { capture: true })
  btn.classList.remove('hotkey-btn--capturing')
  if (restorePrev) setKey(btn.id, prevCode)
  btn.blur()
}

function startCapture(btn, canUnbind) {
  endCapture(true)
  const prompt = canUnbind ? 'Press a key or mouse button… (Esc cancels, Backspace unbinds)' : 'Press a key or mouse button… (Esc cancels)'
  const onKey = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.code === 'Escape') { endCapture(true); return }
    if (canUnbind && e.code === 'Backspace') { endCapture(false); setKey(btn.id, 0); saveHotkeys(btn.id); return }
    if (e.code === 'Backspace' && btn.id === 'hk-alt-interact') { endCapture(true); return }
    const entry = KEY_TABLE[e.code]
    if (!entry) {
      if (activeCapture.timer) clearTimeout(activeCapture.timer)
      btn.textContent = 'Unsupported key'
      activeCapture.timer = setTimeout(() => { if (activeCapture) btn.textContent = prompt }, 1000)
      return
    }
    endCapture(false)
    setKey(btn.id, entry[0])
    saveHotkeys(btn.id)
  }
  // Bound on release so the back and forward buttons never reach Chromium's history navigation
  const onMouse = (e) => {
    const entry = (btn.id.startsWith('ghk-') ? GAME_MOUSE_TABLE : MOUSE_TABLE)[e.button]
    if (!entry) { endCapture(true); return }
    e.preventDefault()
    e.stopPropagation()
    endCapture(false)
    setKey(btn.id, entry[0])
    saveHotkeys(btn.id)
  }
  btn.classList.add('hotkey-btn--capturing')
  btn.textContent = prompt
  window.addEventListener('keydown', onKey, { capture: true })
  window.addEventListener('mouseup', onMouse, { capture: true })
  activeCapture = { btn, prevCode: getKey(btn.id), onKey, onMouse, timer: null }
}

;[...SERVER_HOTKEY_IDS, ...GAME_HOTKEY_IDS].forEach(id => {
  const btn = document.getElementById(id)
  if (!btn) return
  setKey(id, 0)
  btn.addEventListener('click', () => startCapture(btn, SERVER_HOTKEY_IDS.includes(id) && id !== 'hk-alt-interact'))
})
window.addEventListener('blur', () => endCapture(true))

const GFX_INPUT_IDS = [
  'gfx-windowmode', 'gfx-resolution', 'gfx-texquality', 'gfx-aa', 'gfx-shadowquality',
  'gfx-decals', 'gfx-godrays', 'gfx-lensflare', 'gfx-ao', 'gfx-precip',
]
const fovInput = document.getElementById('gfx-fov')
const showFov = () => { const out = document.getElementById('gfx-fov-value'); if (out && fovInput) out.textContent = fovInput.value }
if (fovInput) fovInput.addEventListener('input', showFov)
// Stored on release
const fovError = document.getElementById('gfx-fov-error')
if (fovInput) fovInput.addEventListener('change', async () => {
  const r = await window.electronAPI.graphicsSaveFov(fovInput.value).catch(() => null)
  if (fovError) fovError.hidden = !!(r && r.ok)
})

function setInputsDisabled(ids, disabled) {
  for (const id of ids) { const el = document.getElementById(id); if (el) el.disabled = !!disabled }
}
let gfxExists = true
// Graphics live in the MO2 profile inis, which a direct launch never reads
function lockGfx() {
  const mo2On = mo2Selected()
  setInputsDisabled(GFX_INPUT_IDS, !gfxExists || !mo2On)
  const note = document.getElementById('gfx-mo2-off'); if (note) note.hidden = mo2On
}

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
      const iy = document.getElementById('gfx-invert-y'); if (iy) iy.checked = !!g.invertY
      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v }
      const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v }
      setVal('gfx-texquality', g.texQuality)
      setVal('gfx-aa', g.aa)
      setVal('gfx-shadowquality', g.shadowQuality)
      setVal('gfx-decals', g.decals)
      setVal('gfx-fov', g.fov)
      showFov()
      setChk('gfx-godrays', g.godrays)
      setChk('gfx-lensflare', g.lensFlare)
      setChk('gfx-ao', g.ao)
      setChk('gfx-precip', g.precip)
      gfxExists = !!g.exists
      lockGfx()
    }
    const gh = await window.electronAPI.gameHotkeysLoad()
    const ghkEditable = !!(gh && gh.ok && gh.hasGamePath)
    setInputsDisabled(Object.keys(GHK_MAP), !ghkEditable)
    if (gh && gh.ok) {
      for (const [id, [, ev, dflt]] of Object.entries(GAME_HOTKEYS)) {
        const code = gh.keys ? gh.keys[ev] : null
        setKey(id, typeof code === 'number' && code > 0 ? code : dflt)
      }
    }
    const h = await window.electronAPI.hotkeysLoad()
    if (h && h.ok) {
      const chat = Array.isArray(h.chatFocus) ? (h.chatFocus.find(c => c !== 28) || h.chatFocus[0] || 20) : 20
      setKey('hk-chat', chat)
      for (const [id, [field, dflt]] of Object.entries(SERVER_HOTKEYS)) setKey(id, h[field] != null ? h[field] : dflt)
    }
  } catch (err) { /* settings tab is best-effort */ }
}

// The inis live in the MO2 profile; while it is missing the controls are locked and nothing is written
async function saveGraphics() {
  if (document.getElementById('gfx-windowmode').disabled) return
  const resSel = document.getElementById('gfx-resolution')
  let width = '', height = ''
  if (resSel && /^\d+x\d+$/.test(resSel.value)) [width, height] = resSel.value.split('x')
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : '' }
  const chk = (id) => { const el = document.getElementById(id); return !!(el && el.checked) }
  await window.electronAPI.graphicsSave({
    windowMode:    val('gfx-windowmode'),
    width, height,
    invertY:       chk('gfx-invert-y'),
    texQuality:    val('gfx-texquality'),
    aa:            val('gfx-aa'),
    shadowQuality: val('gfx-shadowquality'),
    decals:        val('gfx-decals'),
    fov:           val('gfx-fov'),
    godrays:       chk('gfx-godrays'),
    lensFlare:     chk('gfx-lensflare'),
    ao:            chk('gfx-ao'),
    precip:        chk('gfx-precip'),
  }).catch(() => null)
}
for (const id of [...GFX_INPUT_IDS, 'gfx-invert-y']) {
  const el = document.getElementById(id)
  if (el) el.addEventListener('change', saveGraphics)
}

// Saves the section the changed hotkey belongs to
async function saveHotkeys(id) {
  if (id.startsWith('ghk-')) {
    const keys = {}
    for (const [gid, ev] of Object.entries(GHK_MAP)) {
      const code = getKey(gid)
      if (code > 0) keys[ev] = code
    }
    await window.electronAPI.gameHotkeysSave(keys).catch(() => null)
    return
  }
  const hk = { chatFocus: [28, getKey('hk-chat')].filter(c => c > 0) }
  for (const [sid, [field]] of Object.entries(SERVER_HOTKEYS)) hk[field] = getKey(sid)
  await window.electronAPI.hotkeysSave(hk).catch(() => null)
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

// Status, lock and PLAY state follow the selected server
footerServerSelect.addEventListener('change', async () => {
  await window.electronAPI.saveSettings({ activeServerId: footerServerSelect.value })
  checkServerStatus()
  loadServerInfo()
  refreshPlayState()
})

// MO2 fields
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
  if (gameRunning || launchStartedAt || playBusy) return

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
  checkSkyrimPath()
  fieldBaseDir.value = s.baseDirPath || ''

  // Footer server selector - dropdown when >1 server, plain text otherwise
  if (s.servers && s.servers.length > 1) {
    footerServerName.hidden   = true
    footerServerSelect.hidden = false
    footerServerSelect.innerHTML = ''
    for (const srv of s.servers) {
      const opt = document.createElement('option')
      opt.value       = srv.id || ''
      opt.textContent = srv.name
      opt.selected    = srv.id === s.activeServerId
      footerServerSelect.appendChild(opt)
    }
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

  fieldModManager.value = s.mo2Enabled ? 'mo2' : 'none'
  fieldIsolated.checked = !!s.isolatedGame
  applyModManager()
  refreshMo2Status()
  refreshIsolatedStatus()

  fieldDiscordPresence.checked = !!s.discordPresence

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
// Login opens nexusmods.com in the browser (OAuth with PKCE).
const nexusTopbarSlot = document.getElementById('nexus-topbar-slot')

let nexusUser = null

const PREMIUM_URL = 'https://www.nexusmods.com/premium'

// The notice above the modlist: only while the account signed in has no premium.
// Signed out counts as no premium, since that is when the manual-download warning matters most.
function renderPremiumNotice() {
  const box = document.getElementById('premium-notice')
  if (!box) return
  box.hidden = !!(nexusUser && nexusUser.isPremium)
}

const premiumLink = document.getElementById('premium-link')
if (premiumLink) {
  premiumLink.addEventListener('click', e => {
    e.preventDefault()
    window.electronAPI.openExternal(PREMIUM_URL)
  })
}

function renderTopbarNexus() {
  renderPremiumNotice()
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
      const result = await window.electronAPI.nexusLogin()
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

// Install Options tab
const isolatedDot      = document.getElementById('isolated-status-dot')
const isolatedText     = document.getElementById('isolated-status-text')
const fieldIsolated    = document.getElementById('setting-isolated-game')
const fieldDiscordPresence = document.getElementById('setting-discord-presence')
const isolatedGroup    = document.getElementById('isolated-install-group')

// Troubleshooting tab
const btnInstallMo2    = document.getElementById('btn-install-mo2')
const btnCopyGame      = document.getElementById('btn-copy-game')
const btnCleanMasters  = document.getElementById('btn-clean-masters')
const btnInstallSkse   = document.getElementById('btn-install-skse')
const btnDownloadMods  = document.getElementById('btn-download-mods')
const btnRepairModlist = document.getElementById('btn-repair-modlist')
const btnRepairGame    = document.getElementById('btn-repair-game')
const REPAIR_BUTTONS   = [btnInstallMo2, btnCopyGame, btnCleanMasters, btnInstallSkse, btnDownloadMods, btnRepairModlist, btnRepairGame]
const MODLIST_BUTTONS  = [btnDownloadMods, btnRepairModlist]

// locks the modlist buttons until there's a game to manage
function refreshDownloadModsState(st) {
  if (mo2InstallRunning || repairRunning) return  // a button is in Cancel mode or locked; don't fight it
  const ready = !fieldIsolated.checked || st.ready
  for (const b of MODLIST_BUTTONS) {
    b.disabled = !ready
    b.title = ready ? '' : 'Copy the game first, or turn off Portable Installation in Install Options.'
  }
}

async function refreshIsolatedStatus() {
  const st = await window.electronAPI.isolatedStatus()
  // Portable mode off: hide the game-copy buttons and status instead of explaining them.
  isolatedGroup.hidden = !fieldIsolated.checked
  btnCopyGame.hidden = btnRepairGame.hidden = !fieldIsolated.checked
  if (!st.ready) {
    isolatedDot.className    = 'vortex-status-dot'
    isolatedText.textContent = 'Game copy not installed yet - press PLAY or Copy Game under Troubleshooting'
  } else if (!fieldIsolated.checked) {
    isolatedDot.className    = 'vortex-status-dot dot-warn'
    isolatedText.textContent = 'Alduinak install exists - playing from the original Skyrim'
  } else {
    isolatedDot.className    = 'vortex-status-dot dot-ok'
    isolatedText.textContent = `Alduinak installed at ${st.base || st.dir}`
  }
  refreshDownloadModsState(st)
}

// Copies the vanilla files into the portable game copy; force re-copies every file.
async function copyGame(force) {
  window.electronAPI.removeIsolatedListeners()
  // Game-copy steps stream into the shared install progress log.
  window.electronAPI.onIsolatedProgress(msg => installLive(msg))
  installLog(force ? 'Repairing the game files…' : 'Copying the game…')

  const result = await window.electronAPI.createIsolated(fieldBaseDir.value.trim(), { force })
  window.electronAPI.removeIsolatedListeners()

  if (!result.success) {
    installLog(`Error: ${result.error}`)
    return false
  }
  // The base may have been nested under \Alduinak - reflect what was used.
  if (result.dir) fieldBaseDir.value = result.dir
  installLog('Game copy ready ✓')
  refreshIsolatedStatus()
  refreshPlayState()
  return true
}

// Every Install Options field saves as soon as it changes
const saveSetting = data => window.electronAPI.saveSettings(data)

fieldIsolated.addEventListener('change', async () => {
  await saveSetting({ isolatedGame: fieldIsolated.checked })
  refreshIsolatedStatus()
  refreshPlayState()
})
fieldDiscordPresence.addEventListener('change', () => saveSetting({ discordPresence: fieldDiscordPresence.checked }))

// Warns below the path field about a missing SkyrimSE.exe, a wrong version or an unsupported store
async function checkSkyrimPath() {
  const p = fieldSkyrimPath.value.trim()
  if (!p) { setPathWarning(DETECT_FAIL_MSG); return }
  const r = await window.electronAPI.checkSkyrimPath(p)
  setPathWarning(r.warning)
}

async function setSkyrimPath(p) {
  fieldSkyrimPath.value = p
  await saveSetting({ skyrimPath: p.trim() })
  checkSkyrimPath()
  refreshPlayState()
}

fieldSkyrimPath.addEventListener('change', () => setSkyrimPath(fieldSkyrimPath.value))
fieldBaseDir.addEventListener('change', () => saveSetting({ baseDirPath: fieldBaseDir.value.trim() }))

document.getElementById('btn-browse').addEventListener('click', async () => {
  const folder = await window.electronAPI.openFolder()
  if (folder) setSkyrimPath(folder)
})

document.getElementById('btn-browse-base').addEventListener('click', async () => {
  const folder = await window.electronAPI.openFolder('Choose where to install Alduinak (~16 GB: MO2 + game copy)')
  if (folder) { fieldBaseDir.value = folder; saveSetting({ baseDirPath: folder }) }
})

document.getElementById('btn-detect-path').addEventListener('click', async () => {
  const r = await window.electronAPI.detectSkyrimPath()
  if (r && r.path) setSkyrimPath(r.path)
  else setPathWarning(DETECT_FAIL_MSG)
})

// Mod manager: MO2 or None. None installs into the Skyrim folder, so the portable copy is off and locked.
const fieldModManager = document.getElementById('setting-mod-manager')
const modManagerHint  = document.getElementById('mod-manager-hint')
const btnOpenMo2      = document.getElementById('btn-open-mo2')
const mo2Selected     = () => fieldModManager.value === 'mo2'

function applyModManager() {
  const mo2 = mo2Selected()
  fieldIsolated.disabled = !mo2
  if (!mo2) fieldIsolated.checked = false
  btnOpenMo2.disabled = !mo2
  modManagerHint.textContent = mo2
    ? 'The game starts through MO2, so mods stay out of your Skyrim folder.'
    : 'Mods install directly into your Skyrim folder and the game starts through SKSE.'
}

fieldModManager.addEventListener('change', async () => {
  applyModManager()
  await saveSetting({ mo2Enabled: mo2Selected(), isolatedGame: fieldIsolated.checked })
  refreshMo2Status()
  refreshIsolatedStatus()
  refreshPlayState()
})

async function refreshMo2Status() {
  lockGfx()
  const status = await window.electronAPI.mo2Status()
  if (!status.installed) {
    mo2StatusDot.className    = 'vortex-status-dot'
    mo2StatusText.textContent = 'MO2 not installed yet - press PLAY or Install MO2 under Troubleshooting'
  } else if (!mo2Selected()) {
    mo2StatusDot.className    = 'vortex-status-dot dot-warn'
    mo2StatusText.textContent = `MO2 ${status.version} ready (${status.modCount} mods) - launching without it`
  } else {
    mo2StatusDot.className    = 'vortex-status-dot dot-ok'
    mo2StatusText.textContent = `MO2 ${status.version} active (${status.modCount} mods)`
  }
}

btnOpenMo2.addEventListener('click', async () => {
  btnOpenMo2.disabled    = true
  btnOpenMo2.textContent = 'MO2 is starting…'
  const result = await window.electronAPI.mo2Open()
  if (!result.success) alert(`Could not open MO2: ${result.error}`)
  btnOpenMo2.disabled    = false
  btnOpenMo2.textContent = 'Open and Configure Mod Manager'
})

document.querySelectorAll('[data-open-folder]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const r = await window.electronAPI.openFolderOf(btn.dataset.openFolder)
    if (!r.success) installLog(`Could not open the folder: ${r.error}`)
  })
})

// Troubleshooting tab: shared install progress log
// Every repair button streams its progress into the one <pre> below them.
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
  if (phase === 'download' || phase === 'check') return file
  if (phase === 'mods') return total > 0 ? `[mods ${index}/${total}] ${file}` : file
  if (phase === 'verify') return `Verifying installed mods… ${index}/${total}`
  return `${skipped ? '[skip]' : `[${index}/${total}]`} ${file}`
}

// Single owner of the install channels, attached once: progress feeds the shared pane (plus an optional per-flow mirror).
// Completion resolves whichever flow started the install; nothing ever detaches these handlers.
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

// Runs one install:start flow and resolves with its completion payload.
function runInstall(mode, opts) {
  return new Promise(resolve => {
    installCompleteHandler = resolve
    window.electronAPI.startInstall(mode, opts)
  })
}

// Troubleshooting steps: each runs its part of the install script and resolves true on success.
async function installMo2() {
  installLog('Installing Mod Organizer 2…')
  const r = await window.electronAPI.installMo2Only({ force: true })
  installLog(r.success ? 'MO2 installed ✓' : `Error: ${r.error}`)
  refreshMo2Status()
  return r.success
}

async function cleanMasters() {
  installLog('Cleaning the masters…')
  const r = await window.electronAPI.installMasters({ force: true })
  if (r.success && r.warning) installLog(`⚠ ${r.warning}`)
  installLog(r.success ? `Cleaned masters ready ✓ (${r.cleaned} cleaned)` : `Error: ${r.error}`)
  return r.success
}

async function installSkse() {
  installLog('Installing SKSE…')
  const r = await window.electronAPI.installSkse({ force: true })
  installLog(r.success ? 'SKSE installed ✓' : `Error: ${r.error}`)
  return r.success
}

// While the modlist runs its button cancels it, so a wedged run can
// always be stopped and retried without restarting the launcher.
let mo2InstallRunning = false

// Download Mods installs what is missing or changed; Repair Modlist (force) rebuilds every mod
async function runModlist(btn, force) {
  if (installBusy()) return false
  const label = btn.textContent
  mo2InstallRunning = true
  btn.textContent = 'Cancel'
  btn.disabled = false
  installLog(force ? 'Repairing modlist…' : 'Downloading mods…')
  const { success, error, warning, modsTotal } = await runInstall('modlist', { force })
  mo2InstallRunning = false
  btn.textContent = label
  // Keep the Play button honest right away instead of waiting for the 10s
  // poll - otherwise a stale UPDATE label eats the player's next click.
  refreshPlayState()
  if (!success) {
    installLog(`Error: ${error}`)
    return false
  }
  if (warning) installLog(`⚠ ${warning}`)
  else installLog(`Modlist ready ✓ - ${modsTotal ?? 0} mods`)
  refreshMo2Status()
  return true
}

// Every button is blocked while a step runs; the modlist steps re-enable their own button as Cancel.
let repairRunning = false

async function withRepairLock(fn) {
  if (repairRunning) { installLog('A repair is already running.'); return }
  repairRunning = true
  for (const b of REPAIR_BUTTONS) b.disabled = true
  try {
    await fn()
  } finally {
    repairRunning = false
    for (const b of REPAIR_BUTTONS) b.disabled = false
    refreshIsolatedStatus()
  }
}

btnInstallMo2.addEventListener('click', () => withRepairLock(installMo2))
btnCopyGame.addEventListener('click', () => withRepairLock(() => copyGame(false)))
btnRepairGame.addEventListener('click', () => withRepairLock(() => copyGame(true)))
btnCleanMasters.addEventListener('click', () => withRepairLock(cleanMasters))
btnInstallSkse.addEventListener('click', () => withRepairLock(installSkse))
for (const [btn, force] of [[btnDownloadMods, false], [btnRepairModlist, true]]) {
  btn.addEventListener('click', () => {
    if (mo2InstallRunning) {
      installLog('Cancelling…')
      window.electronAPI.cancelInstall()
      return
    }
    withRepairLock(() => runModlist(btn, force))
  })
}

// PLAY button
// One click does everything: verify/refresh client files, sync the load
// order, then launch. While the game runs the button reflects that state.
const btnConnect     = document.getElementById('btn-connect')
const connectWarning = document.getElementById('connect-warning')

let gameRunning     = false
let playBusy        = false
let isoReady        = true   // isolation disabled, or the game copy exists
let updateAvailable = false  // server has newer client files than installed
let launcherUpdateReady = false  // a newer launcher build is published
let launchStartedAt = 0  // set after a successful launch until Skyrim shows up or the launch times out
let launchPollTimer = null
let gamePollInFlight = false

const PLAY_LABEL = '\u25BA PLAY'
const LAUNCHING_LABEL = '\u25BA LAUNCHING\u2026'
const LAUNCH_TIMEOUT_MS = 90_000
const LAUNCH_TIMEOUT_WARNING = 'Skyrim did not start. Check MO2 for an error, then press Play again.'
const updatePill = document.getElementById('update-pill')

function updatePlayButton() {
  updatePill.hidden = !((launcherUpdateReady || (updateAvailable && isoReady)) && !gameRunning && !launchStartedAt)

  if (gameRunning) {
    btnConnect.disabled    = true
    btnConnect.textContent = '\u23F3 GAME RUNNING'
    btnConnect.title       = 'Skyrim is currently running.'
    return
  }
  if (launchStartedAt) {
    btnConnect.disabled    = true
    btnConnect.textContent = LAUNCHING_LABEL
    btnConnect.title       = 'Skyrim is starting. MO2 can take a moment to boot it.'
    return
  }
  if (playBusy) return  // label managed by the play/update sequence

  // The launcher updates itself first: a client update run by an outdated
  // launcher would be replaced by the restart anyway.
  if (launcherUpdateReady) {
    btnConnect.disabled    = false
    btnConnect.textContent = '\u2913 UPDATE LAUNCHER'
    btnConnect.title       = 'Installs the launcher update and restarts.'
    return
  }

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
  // Mirror the launcher notice so players can see which one is updating
  if (updateAvailable) {
    clientVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    clientVersionEl.classList.add('update-available')
    clientVersionEl.title = uc.serverVersion ? `v${uc.serverVersion} is available` : ''
  } else {
    if (uc.serverVersion) clientVersionEl.textContent = `v${uc.serverVersion}`
    clientVersionEl.classList.remove('update-available')
    clientVersionEl.title = ''
  }

  updatePlayButton()
}
setInterval(refreshPlayState, 10_000)

async function pollGameRunning() {
  if (gamePollInFlight) return
  gamePollInFlight = true
  try {
    const running = await window.electronAPI.gameIsRunning()
    const timedOut = !running && launchStartedAt > 0 && Date.now() - launchStartedAt > LAUNCH_TIMEOUT_MS
    if (running || timedOut) endLaunchWatch()
    if (timedOut) showWarning(LAUNCH_TIMEOUT_WARNING)
    if (running && connectWarning.textContent === LAUNCH_TIMEOUT_WARNING) clearWarning()
    if (running !== gameRunning || timedOut) {
      // The game may have changed the FOV; main adopted it on exit
      if (gameRunning && !running && !modalOverlay.hidden) loadGameSettingsTab()
      gameRunning = running
      updatePlayButton()
    }
  } finally {
    gamePollInFlight = false
  }
}
setInterval(pollGameRunning, 10_000)
pollGameRunning()

// Keeps Play locked and polls fast until the launched game process appears
function startLaunchWatch() {
  launchStartedAt = Date.now()
  clearInterval(launchPollTimer)
  launchPollTimer = setInterval(pollGameRunning, 2000)
  updatePlayButton()
}

function endLaunchWatch() {
  launchStartedAt = 0
  clearInterval(launchPollTimer)
  launchPollTimer = null
}

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
  if (installCompleteHandler) {
    return Promise.resolve({ success: false, error: 'An install is already running - wait for it to finish.' })
  }
  installProgressMirror = ({ phase, file }) => {
    btnConnect.textContent = phase === 'download' ? '\u2913 DOWNLOADING\u2026' : '\u2699 INSTALLING\u2026'
    showWarning(file)
  }
  return runInstall('auto')
}

btnConnect.addEventListener('click', async () => {
  if (gameRunning || launchStartedAt || playBusy) return
  if (repairRunning) { showWarning('A repair is running, wait for it to finish.'); return }

  // Launcher update takes priority over everything: it replaces this process.
  if (launcherUpdateReady) {
    await runLauncherUpdate()
    return
  }

  // Lock the button before the first await so a second click cannot start another launch.
  const needsGameCopy = !isoReady
  playBusy               = true
  btnConnect.disabled    = true
  btnConnect.textContent = needsGameCopy ? '⚙ INSTALLING…'
    : (updateAvailable ? '⤓ UPDATING…' : '⚙ CHECKING FILES…')

  try {
    // settings:load re-runs the registry auto-detect, so an empty path here means Skyrim really could not be found.
    const s = await window.electronAPI.loadSettings()
    if (!s.skyrimPath) {
      showWarning('Could not auto-detect Skyrim - set the path manually in Settings.')
      openModal()
      return
    }

    // Launch prerequisites. A pending update or first-run install still runs and refreshes the files.
    // The warning explains what is missing before the game can start.
    const blockers = []
    if (discordUser && !serverAllowed) {
      blockers.push(serverLocked
        ? 'Server is currently locked - you are not on the allow list.'
        : 'You are not on the server whitelist.')
    }
    if (!discordUser) blockers.push('Login with Discord first - use the button in the toolbar.')

    if (blockers.length > 0 && !updateAvailable && !needsGameCopy) {
      showWarning(blockers[0])
      return
    }

    clearWarning()

    // 0. First run: create the game copy + MO2 at the default install location instead of bouncing the player into Settings.
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
    btnConnect.textContent = LAUNCHING_LABEL
    if (!install.warning) clearWarning()
    const result = await window.electronAPI.launchSkse()

    if (!result.success) {
      showWarning(result.error)
      return
    }

    if (!install.warning) clearWarning()
    startLaunchWatch()
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
      const queued = data.queued > 0 ? ` · ${data.queued} QUEUED` : ''
      badgePlayers.textContent = `${data.players} PLAYERS${queued}`
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

async function loadServerInfo() {
  const info = await window.electronAPI.fetchServerInfo()
  if (!info || info.error) return

  document.getElementById('footer-server-name').textContent = info.name
  serverLocked = !!info.locked
  document.getElementById('badge-locked').hidden = !serverLocked

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
  } else {
    serverAllowed = info.allowed !== false
  }

  updateLockState()
}

// Launcher update check
const launcherVersionEl = document.getElementById('launcher-version')
const clientVersionEl   = document.getElementById('client-version')

// The check runs every 10s (see the polling block at the bottom), so the
// UPDATE AVAILABLE state appears while the launcher is open - no restart
// needed. Progress handlers are registered exactly once here; the periodic
// check only flips the label state.

window.electronAPI.onUpdateProgress(d => {
  if (!launcherVersionEl.dataset.updating) return
  if (d.phase === 'download' && d.total > 0) {
    launcherVersionEl.textContent = `Downloading update… ${Math.round(d.received / d.total * 100)}%`
  } else if (d.phase === 'extract') {
    launcherVersionEl.textContent = 'Unpacking update…'
  } else if (d.phase === 'install') {
    launcherVersionEl.textContent = 'Installing - the launcher will restart…'
  }
})

// Driven by the Play button; the version labels are read-only notices.
async function runLauncherUpdate() {
  if (!launcherUpdateReady || launcherVersionEl.dataset.updating) return
  playBusy            = true
  btnConnect.disabled = true
  launcherVersionEl.dataset.updating = '1'
  launcherVersionEl.textContent = 'Downloading update…'
  btnConnect.textContent = '⤓ UPDATING LAUNCHER…'
  clearWarning()

  const r = await window.electronAPI.installUpdate()
  if (!r.ok) {
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    delete launcherVersionEl.dataset.updating
    playBusy = false
    showWarning(`Update failed: ${r.error}`)
    updatePlayButton()
  }
  // On success the installer restarts the launcher, so leave the UI as is.
}

async function checkLauncherUpdate() {
  const result = await window.electronAPI.checkUpdate()
  if (!result) return
  if (launcherVersionEl.dataset.updating) return  // don't clobber install progress UI

  const was = launcherUpdateReady
  if (result.hasUpdate) {
    launcherUpdateReady = true
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    launcherVersionEl.classList.add('update-available')
    launcherVersionEl.title = `v${result.latest} is available - use the Play button to update`
  } else {
    launcherUpdateReady = false
    launcherVersionEl.textContent = `v${result.current}`
    launcherVersionEl.classList.remove('update-available')
    launcherVersionEl.title = ''
  }
  if (was !== launcherUpdateReady) updatePlayButton()
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
