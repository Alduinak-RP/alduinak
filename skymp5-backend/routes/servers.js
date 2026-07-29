'use strict'

const router = require('express').Router()
const http   = require('http')
const config = require('../config')

// Last heartbeat received from the game server via POST /:key
let heartbeat = null

router.get('/', (_req, res) => {
  res.json([
    {
      name:    heartbeat?.name    ?? config.serverName,
      address: config.skyrimServerAddress,
      port:    config.skyrimServerPort,
      online:  heartbeat?.online  ?? null,
      maxPlayers: heartbeat?.maxPlayers ?? config.serverMaxPlayers,
      lastSeen:   heartbeat?.lastSeen   ?? null,
    },
  ])
})

// Called by the SkyMP in-game client for the game server's host/port; sessionValid/allowed are extra UI hints when X-Session is sent
router.get('/:key/serverinfo', async (req, res) => {
  if (req.params.key !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid master key.' })
  }

  // Optional session validation for the allowed/sessionValid hints
  const { lookupSession, isDiscordWhitelisted } = require('./master-api')
  const token = req.headers['x-session']
  let sessionValid = false
  let allowed      = true

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

  res.json({
    host:        config.skyrimServerAddress,
    port:        config.skyrimServerPort,
    name:        heartbeat?.name       ?? config.serverName,
    maxPlayers:  heartbeat?.maxPlayers ?? config.serverMaxPlayers,
    offlineMode: config.serverOfflineMode,
    masterKey:   config.serverMasterKey || null,
    masterUrl:   config.masterUrl       || null,
    locked:      config.serverLocked,
    sessionValid,
    allowed,
  })
})

// Fetch a JSON file the game server publishes on its UI port.
function fetchGameJson(pathname) {
  return new Promise(resolve => {
    const req = http.get(
      { host: config.skyrimServerHost, port: config.skympUiPort, path: pathname, timeout: 3000 },
      res => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }
    )
    req.on('error',   () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

let modsCache = { value: null, expiresAt: 0 }

// Called by the SkyMP client for the server's mod list. This used to return an
// empty array, which made the client's load-order check always warn "you have
// more mods than server". Proxy the game server's real manifest instead.
// BSAs and .esl files are filtered out: the client counts only full plugins
// (Game.getModCount excludes light plugins), so anything else skews the compare.
router.get('/:key/manifest.json', async (req, res) => {
  if (req.params.key !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid master key.' })
  }
  const now = Date.now()
  if (!modsCache.value || now >= modsCache.expiresAt) {
    const manifest = await fetchGameJson('/manifest.json') || await fetchGameJson('/data/manifest.json')
    const mods = Array.isArray(manifest?.mods)
      ? manifest.mods.filter(m => m && typeof m.filename === 'string' && !/\.(bsa|esl)$/i.test(m.filename))
      : []
    // Only cache a real answer; an empty list means the game server was down
    if (mods.length) modsCache = { value: mods, expiresAt: now + 60000 }
    else return res.json({ versionMajor: 1, mods: [] })
  }
  res.json({ versionMajor: 1, mods: modsCache.value })
})

// Called by MasterClient every 5 s: POST /api/servers/:key
// Body: { name, maxPlayers, online }
router.post('/:key', (req, res) => {
  if (req.params.key !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid master key.' })
  }

  const { name, maxPlayers, online } = req.body || {}
  heartbeat = {
    name:       typeof name       === 'string' ? name       : config.serverName,
    maxPlayers: typeof maxPlayers === 'number' ? maxPlayers : config.serverMaxPlayers,
    online:     typeof online     === 'number' ? online     : null,
    lastSeen:   new Date().toISOString(),
  }

  res.json({ ok: true })
})

module.exports = router
module.exports.getHeartbeat = () => heartbeat
