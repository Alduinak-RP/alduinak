const router      = require('express').Router()
const config      = require('../config')
const { sessionHints } = require('./master-api')
const { getHeartbeat, fetchGameJson } = require('./servers')
const fs          = require('fs')
const path        = require('path')

const PUBLIC_KEYS_PATH = path.join(__dirname, '..', 'data', 'public-keys.json')

// Load order per server id, from the data/manifest.json each game server publishes
const loadOrderCache = new Map()

async function getGameLoadOrder(server = config.servers[0]) {
  const cached = loadOrderCache.get(server.id) || { value: null, expiresAt: 0 }
  if (cached.expiresAt > Date.now()) return cached.value

  const manifest = (await fetchGameJson('/manifest.json', server.uiPort)) || (await fetchGameJson('/data/manifest.json', server.uiPort))
  const value = Array.isArray(manifest?.loadOrder) ? manifest.loadOrder : cached.value
  loadOrderCache.set(server.id, { value, expiresAt: Date.now() + 60_000 })
  return value
}

function loadPublicKeys() {
  try { return JSON.parse(fs.readFileSync(PUBLIC_KEYS_PATH, 'utf8')) }
  catch { return null }
}

// ?server=<id> answers for another game server; the lock and the whitelist are global
router.get('/', async (req, res) => {
  const server = config.serverById(req.query.server) || config.servers[0]
  const { locked, sessionValid, allowed } = await sessionHints(req.headers['x-session'], server)
  const hb = getHeartbeat(server.id)

  res.json({
    name:                hb?.name       ?? server.name,
    maxPlayers:          hb?.maxPlayers ?? config.serverMaxPlayers,
    port:                server.port,
    offlineMode:         config.serverOfflineMode,
    npcEnabled:          config.serverNpcEnabled,
    gamemode:            config.serverGamemode,
    discordAuthRequired: !!config.discordClientId,
    // Rich Presence application id for the launcher; null keeps the launcher's built-in one
    discordAppId:        config.discordPresenceAppId || null,
    masterKey:           server.masterKey  || null,
    masterUrl:           config.masterUrl         || null,
    locked,
    // Server's esp/esm load order (basenames, in order); null if offline
    loadOrder:           await getGameLoadOrder(server),
    // lockedAllowList intentionally omitted: never expose the allow-list to clients.
    // Session-aware fields: only meaningful when X-Session header is present
    sessionValid,
    allowed,
    publicKeys: loadPublicKeys(),
  })
})

module.exports = router
// Exposed for the launch-check route, which compares a client's reported plugin list to the server's current load order
module.exports.getGameLoadOrder = getGameLoadOrder
