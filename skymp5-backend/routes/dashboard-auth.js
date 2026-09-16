'use strict'
// Dashboard Discord OAuth: separate flow from the launcher (own redirect_uri, issues dashboard session tokens)
// Discord app settings must list DISCORD_DASHBOARD_REDIRECT_URI under Redirects

const { Router }              = require('express')
const https                   = require('https')
const crypto                  = require('crypto')
const rateLimit               = require('express-rate-limit')
const config                  = require('../config')
const sessions                = require('../sources/dashboardSessions')
const discordBot              = require('../sources/discordBot')
const { effectivePermissions, hasPermission } = require('../sources/permissions')
const { bearerToken, sessionFromRequest } = require('../sources/dashboardAuth')
const { auditLog, requestActor } = require('../sources/manager/audit')

const router  = Router()
const audit   = auditLog('backend')

// state -> { redirectUrl, aud, nonce }  (10-min TTL)
const pending = new Map()

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    audit.append({ ...requestActor(req, null), action: 'login', outcome: 'rate-limited' })
    res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' })
  },
})

function dashboardOrigin() {
  return new URL(config.dashboardPublicUrl).origin
}

// Only a login that returns to the dashboard origin may later use manager routes
function audienceFor(redirectUrl) {
  try { return new URL(redirectUrl).origin === dashboardOrigin() ? 'dashboard' : 'website' }
  catch { return 'website' }
}

// GET /auth/dashboard/url?redirect=<return-url>&nonce=<hex>: returns the Discord authorization URL; the nonce comes back beside the token so the page only accepts a login it started
router.get('/url', loginLimiter, (req, res) => {
  if (!config.discordClientId) {
    return res.status(503).json({ error: 'Discord not configured on this server.' })
  }

  const state       = crypto.randomBytes(16).toString('hex')

  // The redirect target later receives the session token, so restrict it to known front-end origins to prevent token exfiltration via ?redirect=
  let redirectUrl = dashboardOrigin() + '/'
  const requestedRedirect = req.query.redirect
  if (requestedRedirect) {
    try {
      const u = new URL(String(requestedRedirect))
      const allowedOrigins = [config.websiteUrl, config.dashboardPublicUrl].map(b => new URL(b).origin)
      if (allowedOrigins.includes(u.origin)) redirectUrl = u.origin + u.pathname
    } catch { /* malformed redirect: keep default */ }
  }
  const nonce = /^[a-f0-9]{32,64}$/.test(String(req.query.nonce || '')) ? String(req.query.nonce) : null

  pending.set(state, { redirectUrl, aud: audienceFor(redirectUrl), nonce })
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

// GET /auth/dashboard/callback: Discord redirects here; on success issue a session and redirect with the token in the fragment, on failure redirect with ?error=<reason>
router.get('/callback', loginLimiter, async (req, res) => {
  const { code, state, error } = req.query

  const fallbackRedirect = dashboardOrigin() + '/'

  if (error) {
    return res.redirect(fallbackRedirect + '?error=cancelled')
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state.')
  }

  const pend = pending.get(String(state))
  if (!pend) {
    audit.append({ ...requestActor(req, null), action: 'login', outcome: 'failed', detail: 'unknown or expired state' }, { mirror: true })
    return res.redirect(fallbackRedirect + '?error=expired')
  }
  pending.delete(String(state))

  let identity = null
  try {
    const tokenData   = await _tokenExchange(String(code))
    const user        = await _getUser(tokenData.access_token)
    if (!user || !user.id) throw new Error('Discord returned no user')
    const username    = user.global_name || user.username
    identity          = { discordId: user.id, username }

    const roleIds     = await discordBot.getMemberRoles(user.id)
    const permissions = effectivePermissions(user.id, roleIds)

    // DASHBOARD_DISCORD_IDS members hold admin.*, which covers dashboard.access
    if (!hasPermission(permissions, 'dashboard.access')) {
      audit.append({ ...requestActor(req, identity), action: 'login', outcome: 'failed', detail: 'no dashboard.access' }, { mirror: true })
      return res.redirect(pend.redirectUrl + '?error=unauthorized')
    }

    const avatar   = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : null

    const mfa   = user.mfa_enabled === true
    const admin = permissions.includes('admin.*')
    const token = sessions.create(user.id, username, avatar, roleIds, permissions, { aud: pend.aud, mfa })
    audit.append({ ...requestActor(req, identity), action: 'login', outcome: 'ok', detail: `aud=${pend.aud} mfa=${mfa} admin=${admin}` }, { mirror: admin })
    // Fragment, not query string: fragments never reach the server, keeping the token out of access logs, history sync and Referer headers
    const nonce = pend.nonce ? `&nonce=${pend.nonce}` : ''
    return res.redirect(`${pend.redirectUrl}#token=${token}${nonce}`)

  } catch (err) {
    console.error('[dashboard-auth] callback error:', err.message)
    audit.append({ ...requestActor(req, identity), action: 'login', outcome: 'error', detail: err.message }, { mirror: true })
    return res.redirect(pend.redirectUrl + '?error=server_error')
  }
})

// GET /auth/dashboard/me: validates a session token and returns the user's Discord info; the website uses it to confirm the session after page load
router.get('/me', (req, res) => {
  const session = sessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid or expired session' })
  const { id: _id, ...user } = session
  res.json({ ok: true, user })
})

// POST /auth/dashboard/logout
router.post('/logout', (req, res) => {
  const token = bearerToken(req)
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
        try {
          const json = JSON.parse(data)
          if (json.error) reject(new Error(json.error_description || json.error))
          else resolve(json)
        } catch (err) { reject(err) }
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
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
  })
}

module.exports = router
module.exports.audienceFor = audienceFor
