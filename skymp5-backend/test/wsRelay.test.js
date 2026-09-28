'use strict'
// Console relay handshake; run through test/run-manager-tests.js, which executes this file inside a temporary copy

const test   = require('node:test')
const assert = require('node:assert/strict')
const path   = require('path')
const { once } = require('node:events')

const ROOT = process.env.ALDUINAK_MANAGER_TEST_ROOT
if (!ROOT || !path.resolve(__dirname).startsWith(path.resolve(ROOT))) {
  console.error('run these tests with: node test/run-manager-tests.js')
  process.exit(1)
}

// The module starts the main relay on require; an ephemeral port keeps it off the live relay's WS_PORT
process.env.WS_PORT = '0'
process.env.RELAY_SECRET = 'unit-relay-secret'
const { WebSocket } = require('ws')
const wss = require('../sources/wsRelay')

// Connects as a gamemode and resolves with the first message or the close code
const gamemode = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`)
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', role: 'gamemode', secret: process.env.RELAY_SECRET })))
  ws.on('message', raw => resolve({ ws, msg: JSON.parse(raw.toString()) }))
  ws.on('close', (code, reason) => resolve({ ws, code, reason: reason.toString() }))
  ws.on('error', reject)
})

test('relay: a second gamemode is refused while one is connected and accepted once it leaves', async () => {
  if (!wss.address()) await once(wss, 'listening')
  const first = await gamemode()
  assert.equal(first.msg.type, 'auth_ok')

  const second = await gamemode()
  assert.equal(second.code, 4003)
  assert.equal(second.reason, 'gamemode already connected')
  assert.equal(first.ws.readyState, WebSocket.OPEN)

  first.ws.close()
  await once(first.ws, 'close')
  const third = await gamemode()
  assert.equal(third.msg.type, 'auth_ok')

  third.ws.close()
  await once(third.ws, 'close')
  wss.close()
})
