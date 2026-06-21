'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mgr', {
  // Console / services
  servicesStatus:  ()        => ipcRenderer.invoke('services:status'),
  servicesAction:  (action)  => ipcRenderer.invoke('services:action', action),
  serverRebuild:   ()        => ipcRenderer.invoke('server:rebuild'),
  configRead:      (key)     => ipcRenderer.invoke('config:read', key),
  configWrite:     (key, c)  => ipcRenderer.invoke('config:write', key, c),
  consoleCommand:  (text)    => ipcRenderer.invoke('console:command', text),
  logDir:          ()        => ipcRenderer.invoke('log:dir'),
  onLog:           (cb)      => ipcRenderer.on('log:data', (_e, d) => cb(d)),
  onBuildLog:      (cb)      => ipcRenderer.on('build:log', (_e, t) => cb(t)),

  // Launcher
  launcherGetVersion: ()        => ipcRenderer.invoke('launcher:getVersion'),
  launcherSetVersion: (v)       => ipcRenderer.invoke('launcher:setVersion', v),
  launcherRebuild:    ()        => ipcRenderer.invoke('launcher:rebuild'),

  // Client
  clientGetVersion: ()    => ipcRenderer.invoke('client:getVersion'),
  clientSetVersion: (v)   => ipcRenderer.invoke('client:setVersion', v),
  clientUpdate:     ()    => ipcRenderer.invoke('client:update'),
  playersList:      ()    => ipcRenderer.invoke('players:list'),
  playersDetail:    (id)  => ipcRenderer.invoke('players:detail', id),

  // Modlist
  modlistRead:           () => ipcRenderer.invoke('modlist:read'),
  modlistUpdateManifest: () => ipcRenderer.invoke('modlist:updateManifest'),
})
