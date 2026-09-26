'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mgr', {
  // Console / services
  servicesStatus:  ()             => ipcRenderer.invoke('services:status'),
  serviceAction:   (key, action)  => ipcRenderer.invoke('service:action', key, action),
  servicesAction:  (action)       => ipcRenderer.invoke('services:action', action),
  servicesStats:   ()             => ipcRenderer.invoke('services:stats'),
  consoleCommand:  (text)         => ipcRenderer.invoke('console:command', text),
  onLog:           (cb)           => ipcRenderer.on('log:data', (_e, d) => cb(d)),
  onConsoleRelay:  (cb)           => ipcRenderer.on('console:relay', (_e, d) => cb(d)),
  onBuildLog:      (cb)           => ipcRenderer.on('build:log', (_e, t) => cb(t)),
  onModlistLog:    (cb)           => ipcRenderer.on('modlist:log', (_e, t) => cb(t)),

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
  serverGetVersion:   ()   => ipcRenderer.invoke('server:getVersion'),
  serverSetVersion:   (v)  => ipcRenderer.invoke('server:setVersion', v),
  versionsPublished:  ()   => ipcRenderer.invoke('versions:published'),
  versionsPublish:    (k)  => ipcRenderer.invoke('versions:publish', k),

  // Players tab
  playersList:    ()              => ipcRenderer.invoke('players:list'),
  playersDetail:  (id)            => ipcRenderer.invoke('players:detail', id),
  playersStats:   ()              => ipcRenderer.invoke('players:stats'),
  playersBan:     (profileId, on) => ipcRenderer.invoke('players:ban', profileId, on),
  playersKick:    (profileId)     => ipcRenderer.invoke('players:kick', profileId),
  playersOnline:  ()              => ipcRenderer.invoke('players:online'),
  charsItemNames: (ids)           => ipcRenderer.invoke('chars:itemNames', ids),
  charsSave:      (formDesc, p)   => ipcRenderer.invoke('chars:save', formDesc, p),
  charsDelete:    (formDesc)      => ipcRenderer.invoke('chars:delete', formDesc),
  charsRevive:    (formDesc)      => ipcRenderer.invoke('chars:revive', formDesc),
  charsAfterlife: (formDesc, realm) => ipcRenderer.invoke('chars:afterlife', formDesc, realm),
  charsFaction:   (profileId, change) => ipcRenderer.invoke('chars:faction', profileId, change),
  playersDelete:  (profileId, o)  => ipcRenderer.invoke('players:delete', profileId, o),

  // Factions tab
  factionsApi:    (method, path, body) => ipcRenderer.invoke('factions:api', method, path, body),

  // Settings tab
  settingsSchema: ()                   => ipcRenderer.invoke('settings:schema'),
  settingsRead:   (key)                => ipcRenderer.invoke('settings:read', key),
  settingsWrite:  (key, values, extra, mtimeMs) => ipcRenderer.invoke('settings:write', key, values, extra, mtimeMs),

  // News tab
  newsList:     ()          => ipcRenderer.invoke('news:list'),
  newsSave:     (i, item)   => ipcRenderer.invoke('news:save', i, item),
  newsDelete:   (i)         => ipcRenderer.invoke('news:delete', i),
  newsAddImage: ()          => ipcRenderer.invoke('news:addImage'),

  // Build tab > Client > Update modlist
  modlistRun:            () => ipcRenderer.invoke('modlist:run'),
  modlistDiff:           () => ipcRenderer.invoke('modlist:diff'),
  modlistPurgeRestore:   () => ipcRenderer.invoke('modlist:purgeRestore'),

  // Security tab
  securityUnread:   ()     => ipcRenderer.invoke('security:unread'),
  securityList:     (type) => ipcRenderer.invoke('security:list', type),
  securityMarkRead: (type) => ipcRenderer.invoke('security:markRead', type),
})
