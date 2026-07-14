'use strict'
// Dashboard Discord OAuth: separate flow from the launcher (own redirect_uri, issues dashboard session tokens)
// Discord app settings must list DISCORD_DASHBOARD_REDIRECT_URI under Redirects

const { Router }              = require('express')
const https                   = require('https')
const crypto                  = require('crypto')
const config                  = require('../config')
const sessions                = require('../sources/dashboardSessions')
const discordBot              = require('../sources/discordBot')
const { resolvePermissions, hasPermission } = require('../sources/permissions')

const router  = Router()

// state -> { redirectUrl }  (10-min TTL)
const pending = new Map()

// GET /auth/dashboard/url?redirect=<return-url>: returns the Discord authorization URL for the website to send the browser to
router.get('/url', (req, res) => {
  if (!config.discordClientId) {
    return res.status(503).json({ error: 'Discord not configured on this server.' })
  }

  const state       = crypto.randomBytes(16).toString('hex')

  // The redirect target later receives the session token, so restrict it to known front-end origins to prevent token exfiltration via ?redirect=
  let redirectUrl = config.websiteUrl + '/dashboard'
  const requestedRedirect = req.query.redirect
  if (requestedRedirect) {
    try {
      const u = new URL(String(requestedRedirect))
      const allowedOrigins = [config.websiteUrl, config.dashboardPublicUrl].map(b => new URL(b).origin)
      if (allowedOrigins.includes(u.origin)) redirectUrl = u.href
    } catch { /* malformed redirect: keep default */ }
  }

  pending.set(state, { redirectUrl })
  setTimeout(() => pending.delete(state), 10 * 60 * 1000)

  const params = new URLSearchParams({
    client_id:     config.discordClientId,
    redirect_uri:  config.discordDashboardRedirectUri,
    response_type: 'code',
    scope:         'identify',
    state,
  })

  res.json({ url: `https://discord.com/api/oauth2/authorize?${params}` })
})

// GET /auth/dashboard/callback: Discord redirects here; on success issue a session and redirect to the website with the token, on failure redirect with ?error=<reason>
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query

  const fallbackRedirect = config.websiteUrl + '/dashboard'

  if (error) {
    return res.redirect(fallbackRedirect + '?error=cancelled')
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state.')
  }

  const pend = pending.get(state)
  if (!pend) {
    return res.redirect(fallbackRedirect + '?error=expired')
  }
  pending.delete(state)

  try {
    const tokenData   = await _tokenExchange(code)
    const user        = await _getUser(tokenData.access_token)

    const roleIds     = await discordBot.getMemberRoles(user.id)
    const permissions = resolvePermissions(roleIds)
    if (config.dashboardDiscordIds.includes(user.id) && !permissions.includes('admin.*')) {
      permissions.push('admin.*')
    }

    // Allow access via the dashboard permission or the legacy DASHBOARD_DISCORD_IDS allowlist
    const isAllowed = hasPermission(permissions, 'dashboard.access') || config.dashboardDiscordIds.includes(user.id)
    if (!isAllowed) {
      return res.redirect(pend.redirectUrl + '?error=unauthorized')
    }

    const username = user.global_name || user.username
    const avatar   = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : null

    const token = sessions.create(user.id, username, avatar, roleIds, permissions)
    // Fragment, not query string: fragments never reach the server, keeping the token out of access logs, history sync and Referer headers
    return res.redirect(`${pend.redirectUrl}#token=${token}`)

  } catch (err) {
    console.error('[dashboard-auth] callback error:', err.message)
    return res.redirect(pend.redirectUrl + '?error=server_error')
  }
})

// GET /auth/dashboard/me: validates a session token and returns the user's Discord info; the website uses it to confirm the session after page load
router.get('/me', (req, res) => {
  const auth    = req.headers['authorization'] ?? ''
  const token   = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const session = sessions.validate(token)
  if (!session) return res.status(401).json({ error: 'invalid or expired session' })
  res.json({ ok: true, user: session })
})

// POST /auth/dashboard/logout
router.post('/logout', (req, res) => {
  const auth  = req.headers['authorization'] ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token) sessions.revoke(token)
  res.json({ ok: true })
})

// Discord helpers

function _tokenExchange(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  config.discordDashboardRedirectUri,
    }).toString()

    const req = https.request({
      hostname: 'discord.com',
      path:     '/api/oauth2/token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        const json = JSON.parse(data)
        if (json.error) reject(new Error(json.error_description || json.error))
        else resolve(json)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function _getUser(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'discord.com',
      path:     '/api/users/@me',
      headers:  { Authorization: `Bearer ${accessToken}` },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject)
  })
}

module.exports = router
