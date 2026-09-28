// WS Relay: one WebSocketServer per game server bridging three connection types:
//   gamemode - one persistent connection from the SkyMP gamemode sandbox; identified by RELAY_SECRET on first message
//   player   - one connection per in-game browser (skymp5-front); identified by a one-time nonce the gamemode registers first
//   console  - the SkyRP Server Manager admin console; shares RELAY_SECRET, sends typed commands to the gamemode and shows its output
//
// The main relay listens on WS_PORT; the test server's relay on WS_PORT_TEST (loopback only) when the test server is listed.
//
// Message protocol (all JSON):
//
//   Handshake (first message, unauthenticated):
//     { type:'auth', role:'gamemode', secret:'...' }   -> gamemode auth (closed 4003 while another gamemode is connected)
//     { type:'auth', role:'console',  secret:'...' }   -> console auth
//     { type:'auth', nonce:'...' }                     -> player auth
//
//   Gamemode -> relay:
//     { type:'register_nonce', nonce, userId }         -> map nonce to userId
//     { type:'chat_deliver',   userId, msg }           -> push msg to one player
//     { type:'chat_broadcast', msg }                   -> push msg to all players
//     { type:'console_output', text }                  -> push text to all consoles
//
//   Console -> relay -> gamemode:
//     { type:'console_command', text }                 -> run a server command
//
//   Player -> relay -> gamemode:
//     { type:'chat_send', text }                       -> relayed with userId added
//
//   Relay -> gamemode (informational):
//     { type:'player_connected',    userId }
//     { type:'player_disconnected', userId }

'use strict'

const { WebSocketServer, WebSocket } = require('ws')
const { safeEqual } = require('./safeEqual')
const config = require('../config')

// No default: privileged (gamemode/console) auth fails closed when unset.
const RELAY_SECRET = process.env.RELAY_SECRET
const WS_PORT      = parseInt(process.env.WS_PORT || '7778', 10)

// Constant-time secret check for the privileged roles; fails closed when RELAY_SECRET is unset so a misconfigured server never grants console/gamemode control
function secretMatches(provided, tag) {
  if (!RELAY_SECRET) {
    console.error(`${tag} RELAY_SECRET is not set; refusing privileged auth`)
    return false
  }
  return safeEqual(provided, RELAY_SECRET)
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// A relay with its own gamemode socket, players, consoles and nonces; host undefined listens on every interface
function createRelay({ port, host, label }) {
  const tag = label ? `[ws-relay:${label}]` : '[ws-relay]'

  // One gamemode socket (reconnects on crash/restart); a second one is refused while it is open
  let gamemodeSocket = null
  let lastRefusedLog = 0

  // userId -> WebSocket (one per authenticated player browser)
  const playerSockets = new Map()

  // Admin console sockets (the Alduinak Server Manager): receive console_output.
  const consoleSockets = new Set()

  // nonce -> userId (registered by gamemode, consumed on player auth)
  const nonceMap = new Map()

  function toGamemode(msg) {
    send(gamemodeSocket, msg)
  }

  const wss = new WebSocketServer({ port, host })

  wss.on('connection', (ws) => {
    let role   = null   // 'gamemode' | 'player' | 'console'
    let userId = null

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // auth handshake
      if (role === null) {
        if (msg.type === 'auth' && msg.role === 'gamemode') {
          if (!secretMatches(msg.secret, tag)) {
            ws.close(4001, 'bad secret')
            return
          }
          // A second gamemode (a test server missing WS_PORT) must not take over this relay's console
          if (gamemodeSocket && gamemodeSocket.readyState === WebSocket.OPEN) {
            if (Date.now() - lastRefusedLog > 60000) {
              lastRefusedLog = Date.now()
              console.error(`${tag} refused a second gamemode while one is connected; is a game server on the wrong WS_PORT?`)
            }
            ws.close(4003, 'gamemode already connected')
            return
          }
          role = 'gamemode'
          gamemodeSocket = ws
          send(ws, { type: 'auth_ok', role: 'gamemode' })
          console.log(`${tag} gamemode authenticated`)
          return
        }

        // Admin console
        if (msg.type === 'auth' && msg.role === 'console') {
          if (!secretMatches(msg.secret, tag)) { ws.close(4001, 'bad secret'); return }
          role = 'console'
          consoleSockets.add(ws)
          send(ws, { type: 'auth_ok', role: 'console' })
          console.log(`${tag} console authenticated`)
          return
        }

        if (msg.type === 'auth' && msg.nonce) {
          const uid = nonceMap.get(msg.nonce)
          if (uid === undefined) {
            send(ws, { type: 'auth_fail', reason: 'unknown_nonce' })
            ws.close(4002, 'unknown nonce')
            return
          }
          role   = 'player'
          userId = uid
          nonceMap.delete(msg.nonce)
          playerSockets.set(userId, ws)
          send(ws, { type: 'auth_ok', role: 'player', userId })
          toGamemode({ type: 'player_connected', userId })
          console.log(`${tag} player ${userId} authenticated`)
          return
        }

        // Unknown or missing auth: reject immediately
        ws.close(4000, 'auth required')
        return
      }

      if (role === 'gamemode') {
        if (msg.type === 'register_nonce') {
          nonceMap.set(msg.nonce, msg.userId)
          return
        }

        if (msg.type === 'chat_deliver') {
          const sock = playerSockets.get(msg.userId)
          send(sock, { type: 'chat_msg', msg: msg.msg })
          return
        }

        if (msg.type === 'chat_broadcast') {
          const payload = JSON.stringify({ type: 'chat_msg', msg: msg.msg })
          for (const sock of playerSockets.values()) {
            if (sock.readyState === WebSocket.OPEN) sock.send(payload)
          }
          return
        }

        // Command output from the gamemode
        if (msg.type === 'console_output' && typeof msg.text === 'string') {
          const payload = JSON.stringify({ type: 'console_output', text: msg.text })
          for (const sock of consoleSockets) {
            if (sock.readyState === WebSocket.OPEN) sock.send(payload)
          }
          return
        }

        return
      }

      if (role === 'console') {
        if (msg.type === 'console_command' && typeof msg.text === 'string') {
          toGamemode({ type: 'console_command', text: msg.text })
        }
        return
      }

      if (role === 'player') {
        if (msg.type === 'chat_send' && typeof msg.text === 'string') {
          toGamemode({ type: 'chat_send', userId, text: msg.text })
        }
        return
      }
    })

    ws.on('close', () => {
      if (role === 'gamemode') {
        if (gamemodeSocket === ws) gamemodeSocket = null
        console.log(`${tag} gamemode disconnected`)
        return
      }
      if (role === 'console') {
        consoleSockets.delete(ws)
        console.log(`${tag} console disconnected`)
        return
      }
      if (role === 'player') {
        playerSockets.delete(userId)
        toGamemode({ type: 'player_disconnected', userId })
        console.log(`${tag} player ${userId} disconnected`)
      }
    })

    ws.on('error', (err) => {
      console.error(`${tag} socket error (${role ?? 'unauthenticated'}):`, err.message)
    })
  })

  wss.on('error', (err) => {
    console.error(`${tag} server error:`, err.message)
  })

  console.log(`${tag} listening on ws://${host || '0.0.0.0'}:${port}`)
  return wss
}

// The main relay starts on require; server.js relies on that
const wss = createRelay({ port: WS_PORT })

// The test game server's relay, loopback only: its gamemode part connects to WS_PORT from the service environment
const testRelay = config.servers.some(s => s.id === 'test')
  ? createRelay({ port: config.testRelayPort, host: '127.0.0.1', label: 'test' })
  : null

module.exports = wss
module.exports.createRelay = createRelay
module.exports.testRelay = testRelay
