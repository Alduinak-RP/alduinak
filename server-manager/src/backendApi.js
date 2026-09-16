'use strict'

// HTTP calls from the manager to the backend on this machine; the port and token are read live from the backend .env

const http   = require('http')
const config = require('./config')

const FACTION_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
// Faction and rank ids are lower-case slugs, so no dot, percent sign, empty segment or query string ever reaches the backend
const FACTION_PATH_RE = /^(?:\/[a-z][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9-]{0,63}(?:\/members|\/ranks(?:\/[a-z0-9][a-z0-9-]{0,63})?)?)?$/
const MAX_BODY = 64 * 1024

function backendRequest(method, apiPath, { body, headers = {}, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port: config.backendApi.port, method, path: apiPath, timeout,
      headers: { ...headers, ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(payload === null ? undefined : payload)
  })
}

function factionsPathAllowed(method, subPath) {
  return FACTION_METHODS.has(method) && typeof subPath === 'string' && FACTION_PATH_RE.test(subPath)
}

// The renderer's only use of the master token: /api/factions and nothing else
async function factionsRequest(method, subPath, body) {
  if (!factionsPathAllowed(method, subPath)) return { ok: false, status: 0, error: 'refused: not a faction route' }
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > MAX_BODY)) {
    return { ok: false, status: 0, error: 'refused: the body must be a small JSON object' }
  }
  const token = config.backendApi.token
  if (!token) return { ok: false, status: 0, error: 'MASTER_API_AUTH_TOKEN is not set in skymp5-backend/.env' }
  try {
    const { status, data } = await backendRequest(method, `/api/factions${subPath}`, { body, headers: { 'X-Auth-Token': token }, timeout: 10000 })
    const ok = status >= 200 && status < 300
    return { ok, status, data, error: ok ? undefined : (data && data.error) || `the backend answered ${status}` }
  } catch (err) {
    return { ok: false, status: 0, error: `the backend is unreachable (${err.message}); is AlduinakBackend running?` }
  }
}

module.exports = { backendRequest, factionsRequest, factionsPathAllowed }
