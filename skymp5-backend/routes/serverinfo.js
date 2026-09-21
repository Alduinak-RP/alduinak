const router      = require('express').Router()
const config      = require('../config')
const { lookupSession, isDiscordWhitelisted } = require('./master-api')
const { getHeartbeat, fetchGameJson } = require('./servers')
const { publishedSchema } = require('./install-manifest')
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
  const token = req.headers['x-session']

  let sessionValid = false
  let allowed      = true   // true when no session provided (offline / launcher handles it)

  if (token) {
    const entry = lookupSession(token)
    if (!entry) {
      sessionValid = false
      allowed      = false
    } else {
      sessionValid = true
      if (config.serverLocked) {
        allowed = config.serverLockedAllowList.includes(entry.discordId)
      } else {
        try {
          allowed = await isDiscordWhitelisted(entry.discordId)
        } catch {
          allowed = false
        }
      }
    }
  }

  const hb = getHeartbeat(server.id)

  res.json({
    name:                hb?.name       ?? server.name,
    maxPlayers:          hb?.maxPlayers ?? config.serverMaxPlayers,
    port:                server.port,
    offlineMode:         config.serverOfflineMode,
    npcEnabled:          config.serverNpcEnabled,
    gamemode:            config.serverGamemode,
    discordAuthRequired: !!config.discordClientId,
    masterKey:           server.masterKey  || null,
    masterUrl:           config.masterUrl         || null,
    locked:              config.serverLocked,
    // Server's esp/esm load order (basenames, in order); null if offline
    loadOrder:           await getGameLoadOrder(server),
    // Schema of the install manifest; a launcher that cannot read it must update before installing or playing
    manifestSchema:      publishedSchema(),
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
