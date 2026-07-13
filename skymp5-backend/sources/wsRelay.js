// WS Relay
//
// Single WebSocketServer that bridges two connection types:
//
//   gamemode  - one persistent connection from the SkyMP gamemode sandbox.
//               Identified by RELAY_SECRET on first message.
//
//   player    - one connection per in-game browser (skymp5-front).
//               Identified by a one-time nonce that the gamemode registers
//               before the browser connects.
//
//   console   - the SkyRP Server Manager admin console. Shares RELAY_SECRET;
//               forwards typed commands to the gamemode and receives the
//               gamemode's command output to display in the manager's Console.
//
// Message protocol (all JSON):
//
//   Handshake (first message, unauthenticated):
//     { type:'auth', role:'gamemode', secret:'...' }   -> gamemode auth
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
const crypto = require('crypto')

// No default: privileged (gamemode/console) auth fails closed when unset.
const RELAY_SECRET = process.env.RELAY_SECRET
const WS_PORT      = parseInt(process.env.WS_PORT || '7778', 10)

// Constant-time check of a client-provided secret for the privileged roles.
// Fails closed when RELAY_SECRET is unset/empty so a misconfigured server never
// grants console/gamemode control to anyone reaching the port.
function secretMatches(provided) {
  if (!RELAY_SECRET) {
    console.error('[ws-relay] RELAY_SECRET is not set; refusing privileged auth')
    return false
  }
  if (typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(RELAY_SECRET)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// One gamemode socket (reconnects on crash/restart)
let gamemodeSocket = null

// userId -> WebSocket (one per authenticated player browser)
const playerSockets = new Map()

// Admin console sockets (the SkyRP Server Manager): receive console_output.
const consoleSockets = new Set()

// nonce -> userId (registered by gamemode, consumed on player auth)
const nonceMap = new Map()

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function toGamemode(msg) {
  send(gamemodeSocket, msg)
}

const wss = new WebSocketServer({ port: WS_PORT })

wss.on('connection', (ws) => {
  let role   = null   // 'gamemode' | 'player'
  let userId = null

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // auth handshake
    if (role === null) {
      if (msg.type === 'auth' && msg.role === 'gamemode') {
        if (!secretMatches(msg.secret)) {
          ws.close(4001, 'bad secret')
          return
        }
        role = 'gamemode'
        gamemodeSocket = ws
        send(ws, { type: 'auth_ok', role: 'gamemode' })
        console.log('[ws-relay] gamemode authenticated')
        return
      }

      // Admin console
      if (msg.type === 'auth' && msg.role === 'console') {
        if (!secretMatches(msg.secret)) { ws.close(4001, 'bad secret'); return }
        role = 'console'
        consoleSockets.add(ws)
        send(ws, { type: 'auth_ok', role: 'console' })
        console.log('[ws-relay] console authenticated')
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
        console.log(`[ws-relay] player ${userId} authenticated`)
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
      console.log('[ws-relay] gamemode disconnected')
      return
    }
    if (role === 'console') {
      consoleSockets.delete(ws)
      console.log('[ws-relay] console disconnected')
      return
    }
    if (role === 'player') {
      playerSockets.delete(userId)
      toGamemode({ type: 'player_disconnected', userId })
      console.log(`[ws-relay] player ${userId} disconnected`)
    }
  })

  ws.on('error', (err) => {
    console.error(`[ws-relay] socket error (${role ?? 'unauthenticated'}):`, err.message)
  })
})

wss.on('error', (err) => {
  console.error('[ws-relay] server error:', err.message)
})

console.log(`[ws-relay] listening on ws://0.0.0.0:${WS_PORT}`)

module.exports = wss
