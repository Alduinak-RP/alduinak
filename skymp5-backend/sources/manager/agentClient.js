'use strict'
// Signed loopback calls from the backend to the AlduinakManager agent

const http     = require('http')
const liveEnv  = require('../liveEnv')
const { signedHeaders } = require('./protocol')

const MAX_RESPONSE = 4 * 1024 * 1024

/** Resolves { status, data }; never rejects, so routes can pass agent errors straight through. */
function callAgent({ method, path, actor, body }) {
  return new Promise(resolve => {
    const secret = liveEnv.get('MANAGER_AGENT_SECRET')
    if (!secret) return resolve({ status: 503, data: { error: 'MANAGER_AGENT_SECRET is not set in skymp5-backend/.env' } })
    const port = parseInt(liveEnv.get('MANAGER_AGENT_PORT') || '4003', 10)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      timeout: 15000,
      headers: {
        ...signedHeaders(secret, { method, path, actor, body: payload }),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = []
      let size = 0
      res.on('data', c => {
        size += c.length
        if (size > MAX_RESPONSE) return req.destroy(new Error('agent response too large'))
        chunks.push(c)
      })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch { resolve({ status: 502, data: { error: 'manager agent sent an unreadable reply' } }) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', err => {
      const down = err.code === 'ECONNREFUSED'
      resolve({ status: 502, data: { error: down ? 'manager agent is not running (AlduinakManager service)' : `manager agent unreachable: ${err.message}`, agentDown: down } })
    })
    req.end(payload)
  })
}

module.exports = { callAgent }
