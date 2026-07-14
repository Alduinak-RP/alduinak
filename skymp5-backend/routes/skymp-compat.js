'use strict'

/**
 * SkyMP Master API compatibility routes: the endpoints the SkyMP game client
 * (authService.ts) expects on the master server, bridged to the session
 * infrastructure in master-api.js. Mounted as app.use('/api/users', ...) in server.js.
 *
 * Endpoints:
 *   GET /api/users/login-discord?state=<hex>
 *     Client opens this in the system browser with its own state token; we register the state as pending and redirect to Discord OAuth.
 *   GET /api/users/login-discord/callback?code=...&state=...
 *     Discord's registered redirect URI: exchanges the code, creates a session, marks the state done for the polling endpoint.
 *   GET /api/users/login-discord/status?state=<hex>
 *     Client polls this while waiting for the browser OAuth to finish.
 *     401: still pending
 *     200: done; returns { token, masterApiId, discordUsername, discordDiscriminator, discordAvatar } (token = play-session token; /me/play just validates it)
 *     403: unknown or expired state
 *   POST /api/users/me/play/:serverKey
 *     Headers: { authorization: <token> }  Body: {} (ignored)
 *     Validates the token is a live session and returns { session: token }.
 */

const router  = require('express').Router()
const https   = require('https')
const crypto  = require('crypto')
const fs      = require('fs')
const path    = require('path')
const config  = require('../config')

// Pending/completed auth store: state -> { status: 'pending'|'done', expiresAt, ...sessionFields }
// Pending entries expire after 10 min (OAuth timeout); done entries after 5 min, or 60 s after first delivery.
// Persisted on every mutation: the launcher polls for up to 5 min while the user is in the browser, and a
// backend restart in that window (`node --watch` restarts on save in dev) would wipe the in-flight login.

const authStates = new Map()
const PENDING_TTL     = 10 * 60 * 1000
const DONE_TTL        =  5 * 60 * 1000
const DELIVERED_GRACE =      60 * 1000
const AUTH_STATES_PATH = path.join(__dirname, '..', 'data', 'auth-states.json')

function saveAuthStates() {
  const now     = Date.now()
  const entries = [...authStates.entries()].filter(([, v]) => v.expiresAt > now)
  try { fs.writeFileSync(AUTH_STATES_PATH, JSON.stringify(entries) + '\n') }
  catch (e) { console.error('[skymp-compat] failed to persist auth states:', e.message) }
}

function loadAuthStates() {
  try {
    const entries = JSON.parse(fs.readFileSync(AUTH_STATES_PATH, 'utf8'))
    const now     = Date.now()
    for (const [k, v] of entries)
      if (v.expiresAt > now) authStates.set(k, v)
    if (authStates.size > 0)
      console.log(`[skymp-compat] restored ${authStates.size} in-flight auth state(s)`)
  } catch { /* first run or file absent: start fresh */ }
}

loadAuthStates()

function pruneAuthStates() {
  const now = Date.now()
  let removed = false
  for (const [k, v] of authStates)
    if (v.expiresAt < now) { authStates.delete(k); removed = true }
  if (removed) saveAuthStates()
}

// GET /api/users/login-discord

router.get('/login-discord', (req, res) => {
  const { state } = req.query
  if (!state) return res.status(400).send('Missing state parameter.')

  if (!config.discordClientId) {
    return res.status(503).send(authPage({
      ok: false, title: 'Login unavailable',
      message: 'Discord login is not configured on this server yet. Tell the server admin to set DISCORD_CLIENT_ID.',
    }))
  }

  // Register the state so /status can tell "unknown" from "pending"; never clobber a completed login awaiting delivery (e.g. browser Back re-loads this URL)
  const existing = authStates.get(state)
  if (!existing || existing.status === 'pending') {
    authStates.set(state, { status: 'pending', expiresAt: Date.now() + PENDING_TTL })
    saveAuthStates()
    console.log(`[skymp-compat] auth started (state ${String(state).slice(0, 8)}…)`)
  }

  const params = new URLSearchParams({
    client_id:     config.discordClientId,
    redirect_uri:  config.discordRedirectUri,
    response_type: 'code',
    scope:         'identify',
    state,
  })

  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`)
})

// GET /api/users/login-discord/callback
// Discord's registered redirect URI: <MASTER_URL>/api/users/login-discord/callback, set in both DISCORD_REDIRECT_URI (.env) and the Discord app settings

router.get('/login-discord/callback', async (req, res) => {
  const { code, state, error } = req.query

  if (error) {
    if (state && authStates.has(state)) { authStates.delete(state); saveAuthStates() }
    return res.status(400).send(authPage({
      ok: false, title: 'Login cancelled',
      message: `Discord reported: ${escapeHtml(String(error))}. Return to the launcher and try again.`,
    }))
  }

  if (!code || !state) {
    return res.status(400).send(authPage({
      ok: false, title: 'Login failed',
      message: 'The Discord response was missing its code or state. Return to the launcher and try again.',
    }))
  }

  const entry = authStates.get(state)
  if (!entry || entry.status !== 'pending') {
    return res.status(400).send(authPage({
      ok: false, title: 'Login expired',
      message: 'This login link is no longer valid (it may have expired or already been used). Return to the launcher and try again.',
    }))
  }

  try {
    const tokenData = await discordTokenExchange({
      client_id:     config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  config.discordRedirectUri,
    })

    const user = await discordGetUser(tokenData.access_token)

    const { createSession } = require('./master-api')
    const { session, profileId } = createSession({
      id:       user.id,
      username: user.global_name || user.username,
    })

    const username = user.global_name || user.username
    authStates.set(state, {
      status:              'done',
      expiresAt:           Date.now() + DONE_TTL,
      session,
      profileId,
      discordId:           user.id,
      username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
        : null,
    })
    saveAuthStates()
    console.log(`[skymp-compat] auth completed for ${username} (state ${String(state).slice(0, 8)}…)`)

    res.send(authPage({
      ok: true, title: 'Logged in',
      message: `Welcome, <strong>${escapeHtml(username)}</strong>. You can return to the launcher.`,
      autoClose: true,
    }))
  } catch (err) {
    console.error('[skymp-compat] Discord callback error:', err.message)
    authStates.delete(state)
    saveAuthStates()
    res.status(500).send(authPage({
      ok: false, title: 'Login failed',
      message: 'Something went wrong while talking to Discord. Return to the launcher and try again.',
    }))
  }
})

// GET /api/users/login-discord/status

router.get('/login-discord/status', (req, res) => {
  const { state } = req.query
  if (!state) return res.status(400).json({ error: 'Missing state.' })

  pruneAuthStates()

  const entry = authStates.get(state)

  if (!entry)          return res.status(403).json({ error: 'Unknown or expired state.' })
  if (entry.status === 'pending') return res.status(401).json({ error: 'Auth not completed yet.' })

  // Don't consume on first read: a lost response must let the next poll succeed, so just shorten the entry's life to a grace window for pruning to collect
  if (!entry.deliveredAt) {
    entry.deliveredAt = Date.now()
    entry.expiresAt   = Date.now() + DELIVERED_GRACE
    saveAuthStates()
    console.log(`[skymp-compat] auth result delivered to client for ${entry.username || entry.profileId}`)
  }

  res.json({
    token:                entry.session,
    masterApiId:          entry.profileId,
    discordUsername:      entry.username  || null,
    discordDiscriminator: null,            // not stored; nullable in SkyMP
    discordAvatar:        entry.avatar    || null,
  })
})

// POST /api/users/me/play/:serverKey

router.post('/me/play/:serverKey', (req, res) => {
  const token = req.headers['authorization']
  if (!token) return res.status(401).json({ error: 'Missing authorization header.' })

  if (req.params.serverKey !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid server key.' })
  }

  const { lookupSession } = require('./master-api')
  const session = lookupSession(token)
  if (!session) return res.status(401).json({ error: 'Invalid or expired session token.' })

  res.json({ session: token })
})

// Browser-facing pages

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// End-of-OAuth page; autoClose tries window.close(), which browsers only honour for some external-app-opened tabs, so the message stays as a fallback
function authPage({ ok, title, message, autoClose = false }) {
  const accent = ok ? '#c8a25f' : '#c0564f'
  const mark   = ok ? '&#10003;' : '&#10007;'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkyRP — ${escapeHtml(title)}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at center, #16120d 0%, #0b0906 70%);
    color: #d8cdb8; font-family: Georgia, 'Times New Roman', serif;
    text-align: center;
  }
  .card { padding: 2.5rem 3rem; max-width: 26rem; }
  .mark {
    width: 4rem; height: 4rem; margin: 0 auto 1.25rem; border-radius: 50%;
    border: 2px solid ${accent}; color: ${accent};
    display: flex; align-items: center; justify-content: center;
    font-size: 1.8rem;
  }
  h1 {
    margin: 0 0 .75rem; font-size: 1.5rem; font-weight: normal;
    color: ${accent}; letter-spacing: .12em; text-transform: uppercase;
  }
  p { margin: 0; line-height: 1.6; font-size: 1rem; }
  .note { margin-top: 1.5rem; font-size: .85rem; color: #857a66; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${mark}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    <p class="note" id="note">${autoClose ? 'This tab will close itself…' : ''}</p>
  </div>
${autoClose ? `<script>
  window.close()
  setTimeout(function () {
    var n = document.getElementById('note')
    if (n) n.textContent = 'You can close this tab now.'
  }, 600)
</script>` : ''}
</body>
</html>`
}

// Discord API helpers

function discordTokenExchange(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString()
    const req  = https.request(
      {
        hostname: 'discord.com',
        path:     '/api/oauth2/token',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          const json = JSON.parse(data)
          if (json.error) reject(new Error(json.error_description || json.error))
          else resolve(json)
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function discordGetUser(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'discord.com',
        path:     '/api/users/@me',
        headers:  { Authorization: `Bearer ${accessToken}` },
      },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      }
    )
    req.on('error', reject)
  })
}

module.exports = router
