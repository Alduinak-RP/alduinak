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
  buildServer:        (o)  => ipcRenderer.invoke('build:server', o),
  buildLauncher:      ()   => ipcRenderer.invoke('build:launcher'),
  buildClient:        (o)  => ipcRenderer.invoke('build:client', o),
  buildNative:        ()   => ipcRenderer.invoke('build:native'),
  buildGamemode:      ()   => ipcRenderer.invoke('build:gamemode'),
  buildCi:            ()   => ipcRenderer.invoke('build:ci'),
  launcherGetVersion: ()   => ipcRenderer.invoke('launcher:getVersion'),
  launcherSetVersion: (v)  => ipcRenderer.invoke('launcher:setVersion', v),
  clientGetVersion:   ()   => ipcRenderer.invoke('client:getVersion'),
  clientSetVersion:   (v)  => ipcRenderer.invoke('client:setVersion', v),

  // Players tab
  playersList:    ()              => ipcRenderer.invoke('players:list'),
  playersDetail:  (id)            => ipcRenderer.invoke('players:detail', id),
  playersUpdate:  (profileId, p)  => ipcRenderer.invoke('players:update', profileId, p),
  playersOnline:  ()              => ipcRenderer.invoke('players:online'),

  // Settings tab
  settingsSchema: ()                   => ipcRenderer.invoke('settings:schema'),
  settingsRead:   (key)                => ipcRenderer.invoke('settings:read', key),
  settingsWrite:  (key, values, extra) => ipcRenderer.invoke('settings:write', key, values, extra),

  // Modlist tab
  modlistRead:           () => ipcRenderer.invoke('modlist:read'),
  modlistUpdateManifest: () => ipcRenderer.invoke('modlist:updateManifest'),
})
