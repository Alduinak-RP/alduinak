const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  // User settings (skyrimPath, activeServerIndex, mo2Enabled, isolatedGame)
  loadSettings: ()     => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),

  // OS folder picker (optional dialog title)
  openFolder: (title) => ipcRenderer.invoke('dialog:openFolder', title),

  // Skyrim path auto-detection (registry probe) - { path } or { path: null }
  detectSkyrimPath: () => ipcRenderer.invoke('game:detectPath'),

  // Settings tab - graphics (SkyrimPrefs.ini) and server hotkeys (client settings)
  graphicsLoad: ()  => ipcRenderer.invoke('graphics:load'),
  graphicsSave: (g) => ipcRenderer.invoke('graphics:save', g),
  hotkeysLoad:  ()  => ipcRenderer.invoke('hotkeys:load'),
  hotkeysSave:  (h) => ipcRenderer.invoke('hotkeys:save', h),

  // API calls proxied through main (keeps CSP clean, uses config.js values)
  fetchStatus:     () => ipcRenderer.invoke('api:status'),
  fetchNews:       () => ipcRenderer.invoke('api:news'),
  fetchServerInfo: () => ipcRenderer.invoke('api:serverinfo'),
  fetchMetrics:    () => ipcRenderer.invoke('api:metrics'),
  fetchModlist:    () => ipcRenderer.invoke('api:modlist'),
  fetchServers:    () => ipcRenderer.invoke('api:servers'),

  // Discord OAuth
  discordLogin:   () => ipcRenderer.invoke('discord:login'),
  discordLogout:  () => ipcRenderer.invoke('discord:logout'),
  discordGetUser: () => ipcRenderer.invoke('discord:getUser'),

  // Launcher update check + in-app install
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, d) => cb(d)),

  // Open external URL in default browser (http/https only)
  openExternal: (url) => ipcRenderer.send('open:external', url),

  // SKSE launch
  launchSkse:   () => ipcRenderer.invoke('launch:skse'),
  launchViaMO2: () => ipcRenderer.invoke('launch:viaMO2'),
  launchDirect: () => ipcRenderer.invoke('launch:direct'),

  // Client files update check - { ok, updateAvailable }
  filesUpdateCheck: () => ipcRenderer.invoke('files:updateCheck'),

  // Game process state - true while Skyrim / the SKSE loader is running
  gameIsRunning: () => ipcRenderer.invoke('game:isRunning'),

  // File install
  startInstall: (mode) => ipcRenderer.send('install:start', mode),
  cancelInstall: () => ipcRenderer.send('install:cancel'),
  onInstallProgress: (cb) =>
    ipcRenderer.on('install:progress', (_e, data) => cb(data)),
  onInstallComplete: (cb) =>
    ipcRenderer.on('install:complete',  (_e, data) => cb(data)),
  removeInstallListeners: () => {
    ipcRenderer.removeAllListeners('install:progress')
    ipcRenderer.removeAllListeners('install:complete')
  },

  // Nexus Mods login (one-click SSO only)
  nexusGetUser: ()    => ipcRenderer.invoke('nexus:getUser'),
  nexusLogout:  ()    => ipcRenderer.invoke('nexus:logout'),
  nexusSsoAvailable: () => ipcRenderer.invoke('nexus:ssoAvailable'),
  nexusSsoLogin:     () => ipcRenderer.invoke('nexus:ssoLogin'),

  // Isolated game copy (baseDir optional; falls back to the stored/default install location)
  isolatedStatus: () => ipcRenderer.invoke('game:isolatedStatus'),
  createIsolated: (baseDir) => ipcRenderer.invoke('game:createIsolated', baseDir),
  onIsolatedProgress: (cb) => ipcRenderer.on('isolated:progress', (_e, msg) => cb(msg)),
  removeIsolatedListeners: () => ipcRenderer.removeAllListeners('isolated:progress'),

  // MO2 integration
  mo2Status: () => ipcRenderer.invoke('mo2:status'),
  mo2Open:   () => ipcRenderer.invoke('mo2:open'),

  // Open the portable install (base) folder in the OS file manager
  openInstallFolder: () => ipcRenderer.invoke('install:openFolder'),
})
