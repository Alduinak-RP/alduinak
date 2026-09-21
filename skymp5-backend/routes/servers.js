'use strict'

const router = require('express').Router()
const http   = require('http')
const config = require('../config')

// Last heartbeat from each game server via POST /:key, by server id
const heartbeats = new Map()
const getHeartbeat = (id = config.servers[0].id) => heartbeats.get(id) || null

router.get('/', (_req, res) => {
  res.json(config.servers.map(server => {
    const hb = getHeartbeat(server.id)
    return {
      id:         server.id,
      name:       hb?.name ?? server.name,
      address:    server.address,
      port:       server.port,
      masterKey:  server.masterKey || null,
      online:     hb?.online ?? null,
      maxPlayers: hb?.maxPlayers ?? config.serverMaxPlayers,
      lastSeen:   hb?.lastSeen ?? null,
    }
  }))
})

// Called by the SkyMP in-game client for the game server's host/port; sessionValid/allowed are extra UI hints when X-Session is sent
router.get('/:key/serverinfo', async (req, res) => {
  const server = config.serverByKey(req.params.key)
  if (!server) return res.status(403).json({ error: 'Invalid master key.' })

  const { sessionHints } = require('./master-api')
  const { locked, sessionValid, allowed } = await sessionHints(req.headers['x-session'], server)
  const hb = getHeartbeat(server.id)
  res.json({
    host:        server.address,
    port:        server.port,
    name:        hb?.name       ?? server.name,
    maxPlayers:  hb?.maxPlayers ?? config.serverMaxPlayers,
    offlineMode: config.serverOfflineMode,
    masterKey:   server.masterKey || null,
    masterUrl:   config.masterUrl       || null,
    locked,
    sessionValid,
    allowed,
  })
})

// Fetch a JSON file a game server publishes on its UI port (the main server's by default).
function fetchGameJson(pathname, uiPort = config.skympUiPort) {
  return new Promise(resolve => {
    const req = http.get(
      { host: config.skyrimServerHost, port: uiPort, path: pathname, timeout: 3000 },
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

// Mods per server id
const modsCache = new Map()

// Called by the SkyMP client for its load-order check; proxies that game server's real manifest.
// BSAs and .esl files are filtered out: the client counts only full plugins (Game.getModCount excludes light plugins).
router.get('/:key/manifest.json', async (req, res) => {
  const server = config.serverByKey(req.params.key)
  if (!server) return res.status(403).json({ error: 'Invalid master key.' })
  const now = Date.now()
  let cached = modsCache.get(server.id)
  if (!cached || now >= cached.expiresAt) {
    const manifest = await fetchGameJson('/manifest.json', server.uiPort) || await fetchGameJson('/data/manifest.json', server.uiPort)
    const mods = Array.isArray(manifest?.mods)
      ? manifest.mods.filter(m => m && typeof m.filename === 'string' && !/\.(bsa|esl)$/i.test(m.filename))
      : []
    // Only cache a real answer; an empty list means the game server was down
    if (!mods.length) return res.json({ versionMajor: 1, mods: [] })
    cached = { value: mods, expiresAt: now + 60000 }
    modsCache.set(server.id, cached)
  }
  res.json({ versionMajor: 1, mods: cached.value })
})

// Called by MasterClient every 5 s: POST /api/servers/:key  (X-Auth-Token)
// Body: { name, maxPlayers, online }
router.post('/:key', (req, res) => {
  const { checkKey, checkWriteToken } = require('./master-api')
  if (!checkKey(req, res, { write: false }) || !checkWriteToken(req, res)) return

  const { name, maxPlayers, online } = req.body || {}
  heartbeats.set(req.server.id, {
    name:       typeof name       === 'string' ? name       : req.server.name,
    maxPlayers: typeof maxPlayers === 'number' ? maxPlayers : config.serverMaxPlayers,
    online:     typeof online     === 'number' ? online     : null,
    lastSeen:   new Date().toISOString(),
  })

  res.json({ ok: true })
})

module.exports = router
module.exports.getHeartbeat = getHeartbeat
module.exports.fetchGameJson = fetchGameJson
