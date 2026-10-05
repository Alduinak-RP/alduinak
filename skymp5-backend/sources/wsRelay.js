// WS Relay: one WebSocketServer per game server bridging two connection types:
//   gamemode - one persistent connection from the SkyMP gamemode sandbox; identified by RELAY_SECRET on first message
//   console  - the SkyRP Server Manager admin console; shares RELAY_SECRET, sends typed commands to the gamemode and shows its output
//
// The main relay listens on WS_PORT; the test server's relay on WS_PORT_TEST (loopback only) when the test server is listed.
//
// Message protocol (all JSON):
//
//   Handshake (first message, unauthenticated):
//     { type:'auth', role:'gamemode', secret:'...' }   -> gamemode auth (closed 4003 while another gamemode is connected)
//     { type:'auth', role:'console',  secret:'...' }   -> console auth
//
//   Gamemode -> relay:
//     { type:'console_output', text }                  -> push text to all consoles
//
//   Console -> relay -> gamemode:
//     { type:'console_command', text }                 -> run a server command

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

// A relay with its own gamemode socket and consoles; host undefined listens on every interface
function createRelay({ port, host, label }) {
  const tag = label ? `[ws-relay:${label}]` : '[ws-relay]'

  // One gamemode socket (reconnects on crash/restart); a second one is refused while it is open
  let gamemodeSocket = null
  let lastRefusedLog = 0

  // Admin console sockets (the Alduinak Server Manager): receive console_output.
  const consoleSockets = new Set()

  function toGamemode(msg) {
    send(gamemodeSocket, msg)
  }

  const wss = new WebSocketServer({ port, host })

  wss.on('connection', (ws) => {
    let role = null   // 'gamemode' | 'console'

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

        // Unknown or missing auth: reject immediately
        ws.close(4000, 'auth required')
        return
      }

      if (role === 'gamemode') {
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
