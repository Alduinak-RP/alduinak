'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mgr', {
  // Console / services
  servicesStatus:  ()             => ipcRenderer.invoke('services:status'),
  serviceAction:   (key, action)  => ipcRenderer.invoke('service:action', key, action),
  servicesAction:  (action)       => ipcRenderer.invoke('services:action', action),
  consoleCommand:  (text)         => ipcRenderer.invoke('console:command', text),
  onLog:           (cb)           => ipcRenderer.on('log:data', (_e, d) => cb(d)),
  onConsoleRelay:  (cb)           => ipcRenderer.on('console:relay', (_e, d) => cb(d)),
  onBuildLog:      (cb)           => ipcRenderer.on('build:log', (_e, t) => cb(t)),

  // Build tab
  buildServer:        ()   => ipcRenderer.invoke('build:server'),
  buildLauncher:      ()   => ipcRenderer.invoke('build:launcher'),
  buildClient:        ()   => ipcRenderer.invoke('build:client'),
  launcherGetVersion: ()   => ipcRenderer.invoke('launcher:getVersion'),
  launcherSetVersion: (v)  => ipcRenderer.invoke('launcher:setVersion', v),
  clientGetVersion:   ()   => ipcRenderer.invoke('client:getVersion'),
  clientSetVersion:   (v)  => ipcRenderer.invoke('client:setVersion', v),

  // Players tab
  playersList:    ()              => ipcRenderer.invoke('players:list'),
  playersDetail:  (id)            => ipcRenderer.invoke('players:detail', id),
  playersUpdate:  (profileId, p)  => ipcRenderer.invoke('players:update', profileId, p),

  // Settings tab
  settingsSchema: ()                   => ipcRenderer.invoke('settings:schema'),
  settingsRead:   (key)                => ipcRenderer.invoke('settings:read', key),
  settingsWrite:  (key, values, extra) => ipcRenderer.invoke('settings:write', key, values, extra),

  // Modlist tab
  modlistRead:           () => ipcRenderer.invoke('modlist:read'),
  modlistUpdateManifest: () => ipcRenderer.invoke('modlist:updateManifest'),
})
