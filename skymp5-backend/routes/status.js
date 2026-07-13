const router = require('express').Router()
const http   = require('http')
const config = require('../config')
const { getHeartbeat } = require('./servers')

function metricsAuthHeader() {
  const { metricsUser: user, metricsPassword: password } = config
  if (user && password) {
    return { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
  }
  return {}
}

// Probe the SkyMP HTTP UI port. Any HTTP response (even an auth error)
// proves the server process is up; the player count is derived from the
// Prometheus metrics when they are readable.
//   Online players ≈ skymp_connects_total − skymp_disconnects_total
// (The old UDP probe was meaningless: a UDP send "succeeds" as soon as the
// OS accepts the packet, so a dead game server still read as online.)
function probeGameServer(host, uiPort) {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: host, port: uiPort, path: '/metrics', timeout: 3000, headers: metricsAuthHeader() },
      res => {
        let raw = ''
        res.on('data', c => { raw += c })
        res.on('end', () => {
          const val = name => {
            const m = raw.match(new RegExp(`^${name}\\s+(\\d+)`, 'm'))
            return m ? parseInt(m[1], 10) : null
          }
          const connects    = val('skymp_connects_total')
          const disconnects = val('skymp_disconnects_total')
          const players = (connects !== null && disconnects !== null)
            ? Math.max(0, connects - disconnects)
            : null
          resolve({ reachable: true, players })
        })
      }
    )
    req.on('error',   () => resolve({ reachable: false, players: null }))
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, players: null }) })
  })
}

// server heartbeats every ~5s; allow a few misses before calling it offline
const HEARTBEAT_TTL_MS = 20_000

router.get('/', async (_req, res) => {
  const { skyrimServerHost: host, skympUiPort: uiPort } = config
  const hb = getHeartbeat()

  // a fresh heartbeat proves the server process is up; fall back to probing
  // the metrics port only when no heartbeat has been seen since backend start
  let online  = null
  let players = null
  if (hb && hb.lastSeen) {
    online = (Date.now() - new Date(hb.lastSeen).getTime()) < HEARTBEAT_TTL_MS
    if (online && typeof hb.online === 'number') players = hb.online
  }

  if (online === null || (online && players === null)) {
    const probe = await probeGameServer(host, uiPort)
    if (online === null) online = probe.reachable
    if (online && players === null) players = probe.players
  }

  res.json({ status: online ? 'online' : 'offline', players })
})

module.exports = router
