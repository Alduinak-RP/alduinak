'use strict'

const express = require('express')
const path    = require('path')
const config  = require('../config')

function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

// A stolen dashboard token controls the server, so scripts, frames and form targets are locked to this origin
function securityHeaders() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https://cdn.discordapp.com data:",
    `connect-src 'self' ${originOf(config.dashboardApiBaseUrl)}`.trim(),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
  const https = config.dashboardPublicUrl.startsWith('https:')
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    })
    if (https) res.set('Strict-Transport-Security', 'max-age=31536000')
    next()
  }
}

function start() {
  if (!config.dashboardPort) return

  const app = express()
  const publicDir = path.join(__dirname, '..', 'public', 'dashboard')

  app.disable('x-powered-by')
  app.use(securityHeaders())

  app.get('/dashboard-config.js', (_req, res) => {
    res.type('application/javascript').send(
      `window.ALDUINAK_DASHBOARD_CONFIG=${JSON.stringify({
        apiBaseUrl: config.dashboardApiBaseUrl,
        dashboardUrl: config.dashboardPublicUrl,
      })};`
    )
  })

  app.use(express.static(publicDir))
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')))

  app.listen(config.dashboardPort, () => {
    console.log(`Alduinak dashboard running on ${config.dashboardPublicUrl}`)
  })
}

module.exports = { start, securityHeaders }
