const router = require('express').Router()
const config = require('../config')
const { readVersions, versionsFor } = require('../sources/versions')

// GET /api/version?server=<id>: client/server follow the selected game server, launcher fields are global.
// Launcher 3+ read launcher/client/server; the version/downloadUrl/packageUrl/clientVersion/serverVersion names keep Electron 2.x launchers updating
router.get('/', (req, res) => {
  const v = readVersions()
  const { client, server } = versionsFor(config.serverOrMain(req.query.server).id)
  res.json({
    launcher: v.launcher,
    client,
    server,
    launcherUrl: v.launcherUrl,
    version: v.launcher,
    downloadUrl: v.launcherUrl,
    packageUrl: v.launcherUrl,
    clientVersion: client,
    serverVersion: server,
  })
})

module.exports = router
