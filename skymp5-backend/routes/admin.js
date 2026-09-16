'use strict'
// Admin proxy: checks ADMIN_TOKEN or the server manager gate, then forwards to the SkyMP-Admin service, which binds to localhost only

const { Router } = require('express')
const http       = require('http')
const https      = require('https')
const config     = require('../config')
const safeEqual  = require('../sources/safeEqual')
const { bearerToken } = require('../sources/dashboardAuth')
const { requireManager } = require('../middleware/requireManager')
const { auditLog, requestActor } = require('../sources/manager/audit')

const router = Router()
const audit  = auditLog('backend')

// The admin service can stop the game server, so a dashboard session needs everything the server manager needs
function authorize(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: 'admin service not configured (ADMIN_TOKEN not set)' })
  const provided = bearerToken(req)
  if (!provided) return res.status(401).json({ error: 'missing authorization header' })
  if (safeEqual(provided, config.adminToken)) return next()
  requireManager(req, res, () => {
    if (req.method !== 'GET') audit.append({ ...requestActor(req, req.managerSession), action: `admin-proxy ${req.method} ${req.path}`, outcome: 'forwarded' }, { mirror: true })
    next()
  })
}

// Forward any request under /api/admin/* to the admin service
router.all('/*', authorize, (req, res) => {
  const base     = new URL(config.adminUrl)
  const useHttps = base.protocol === 'https:'
  const lib      = useHttps ? https : http

  // Strip the /api/admin prefix, forward the remainder to the admin service
  const adminPath = '/api' + req.path  // e.g. /api/admin/server/start -> /api/server/start

  const options = {
    hostname: base.hostname,
    port:     base.port || (useHttps ? 443 : 80),
    path:     adminPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''),
    method:   req.method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.adminToken}`,
    },
  }

  const proxyReq = lib.request(options, proxyRes => {
    res.status(proxyRes.statusCode)
    let body = ''
    proxyRes.on('data', chunk => { body += chunk })
    proxyRes.on('end', () => {
      try { res.json(JSON.parse(body)) }
      catch { res.send(body) }
    })
  })

  proxyReq.on('error', err => {
    res.status(502).json({ error: 'admin service unreachable', detail: err.message })
  })

  if (req.body && Object.keys(req.body).length > 0) {
    proxyReq.write(JSON.stringify(req.body))
  }

  proxyReq.end()
})

module.exports = router
