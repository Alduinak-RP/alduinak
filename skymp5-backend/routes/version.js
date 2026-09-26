const router = require('express').Router()
const { readVersions } = require('../sources/versions')

// Launcher 3+ read launcher/client/server; the version/downloadUrl/packageUrl/clientVersion/serverVersion names keep Electron 2.x launchers updating
router.get('/', (_req, res) => {
  const v = readVersions()
  res.json({
    launcher: v.launcher,
    client: v.client,
    server: v.server,
    launcherUrl: v.launcherUrl,
    version: v.launcher,
    downloadUrl: v.launcherUrl,
    packageUrl: v.launcherUrl,
    clientVersion: v.client,
    serverVersion: v.server,
  })
})

module.exports = router
