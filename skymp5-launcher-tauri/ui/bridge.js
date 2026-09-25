// window.electronAPI on top of Tauri, so renderer.js runs unchanged
const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const appWindow = window.__TAURI__.window.getCurrentWindow()

// Event listeners by channel, so a flow can drop its own before re-subscribing
const unlisteners = {}
function on(channel, cb) {
  const p = listen(channel, e => cb(e.payload))
  ;(unlisteners[channel] = unlisteners[channel] || []).push(p)
}
function off(channel) {
  for (const p of unlisteners[channel] || []) p.then(un => un())
  unlisteners[channel] = []
}

window.electronAPI = {
  minimize: () => appWindow.minimize(),
  maximize: () => appWindow.toggleMaximize(),
  close:    () => appWindow.close(),

  loadSettings: ()     => invoke('settings_load'),
  saveSettings: (data) => invoke('settings_save', { data }),
  openFolder:   (title) => invoke('dialog_open_folder', { title: title || null }),

  detectSkyrimPath: ()    => invoke('game_detect_path'),
  checkSkyrimPath:  (dir) => invoke('game_check_path', { dir }),

  graphicsLoad:    ()  => invoke('graphics_load'),
  graphicsSave:    (g) => invoke('graphics_save', { g }),
  graphicsSaveFov: (v) => invoke('graphics_save_fov', { v: Number(v) }),
  hotkeysLoad:     ()  => invoke('hotkeys_load'),
  hotkeysSave:     (h) => invoke('hotkeys_save', { h }),
  gameHotkeysLoad: ()  => invoke('game_hotkeys_load'),
  gameHotkeysSave: (keys) => invoke('game_hotkeys_save', { keys }),

  fetchStatus:     () => invoke('api_status'),
  fetchNews:       () => invoke('api_news'),
  fetchServerInfo: () => invoke('api_serverinfo'),
  fetchModlist:    () => invoke('api_modlist'),

  discordLogin:  () => invoke('discord_login'),
  discordLogout: () => invoke('discord_logout'),

  checkUpdate:      () => invoke('app_check_update'),
  installUpdate:    () => invoke('app_install_update'),
  onUpdateProgress: (cb) => on('update:progress', cb),

  openExternal: (url) => invoke('open_external', { url }),

  launchSkse:       () => invoke('launch_skse'),
  filesUpdateCheck: () => invoke('files_update_check'),
  gameIsRunning:    () => invoke('game_is_running'),

  startInstall:   (mode, opts) => invoke('install_start', { mode, opts: opts || {} }),
  cancelInstall:  () => invoke('install_cancel'),
  installMo2Only: (opts) => invoke('install_mo2_only', { opts: opts || {} }),
  installSkse:    (opts) => invoke('install_skse', { opts: opts || {} }),
  installMasters: (opts) => invoke('install_masters', { opts: opts || {} }),
  onInstallProgress: (cb) => on('install:progress', cb),
  onInstallComplete: (cb) => on('install:complete', cb),

  nexusGetUser: () => invoke('nexus_get_user'),
  nexusLogout:  () => invoke('nexus_logout'),
  nexusLogin:   () => invoke('nexus_login'),

  isolatedStatus: () => invoke('game_isolated_status'),
  createIsolated: (baseDir, opts) => invoke('game_create_isolated', { baseDir: baseDir || null, opts: opts || {} }),
  onIsolatedProgress: (cb) => on('isolated:progress', cb),
  removeIsolatedListeners: () => off('isolated:progress'),

  mo2Status: () => invoke('mo2_status'),
  mo2Open:   () => invoke('mo2_open'),

  openFolderOf: (kind) => invoke('folder_open', { kind }),
}
