'use strict'

/**
 * Nexus Mods API integration.
 *
 * The user supplies their personal API key (Settings → the key from
 * https://next.nexusmods.com/settings/api-keys). With it we can:
 *  - validate the key and show who's logged in (+ premium status)
 *  - resolve a mod's main file
 *  - PREMIUM ONLY: generate direct download links and pull archives
 *    straight into MO2's downloads folder, Wabbajack-style.
 *
 * Free accounts can't generate download links through the API (Nexus
 * policy) - for them the launcher falls back to opening mod pages and
 * catching the nxm:// downloads via the registered handler.
 */

const https  = require('https')
const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const GAME = 'skyrimspecialedition'

// Nexus API policy: every request must carry the application name and version.
// Derived from package.json so the version stays accurate and forks inherit their own identity.
const pkg = require('../package.json')
const APP_HEADERS = {
  'User-Agent':          `${pkg.name}/${pkg.version}`,
  'Application-Name':    pkg.name,
  'Application-Version': pkg.version,
}

// Logger
let _log = (...args) => console.log('[nexus]', ...args)
function setLogger(fn) { _log = (...args) => fn('[nexus]', ...args) }

// Auth header for either credential kind. A plain string is treated as an
// API key (SSO-era call sites); OAuth callers pass { bearer: accessToken }.
function authHeaders(auth) {
  if (typeof auth === 'string' && auth) return { apikey: auth }
  if (auth && auth.bearer) return { Authorization: `Bearer ${auth.bearer}` }
  if (auth && auth.apiKey) return { apikey: auth.apiKey }
  throw new Error('Not logged in to Nexus.')
}

// Low-level API call

function apiGet(auth, apiPath) {
  return new Promise((resolve, reject) => {
    let headers
    try { headers = { ...authHeaders(auth), ...APP_HEADERS, accept: 'application/json' } }
    catch (err) { return reject(err) }
    const req = https.get({
      hostname: 'api.nexusmods.com',
      path:     apiPath,
      headers,
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid or expired Nexus API key.'))
        if (res.statusCode === 403) return reject(new Error('Nexus refused the request (premium required?).'))
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Nexus API HTTP ${res.statusCode}`))
        }
        try { resolve(JSON.parse(data)) }
        catch (err) { reject(new Error(`Bad JSON from Nexus: ${err.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Nexus API request timed out')) })
  })
}

// Account

/**
 * Validate a credential (API key or { bearer }).
 * Returns { name, isPremium, profileUrl } or throws.
 */
async function validateKey(auth) {
  const data = await apiGet(auth, '/v1/users/validate.json')
  return {
    name:       data.name,
    isPremium:  data.is_premium === true,
    profileUrl: data.profile_url || null,
  }
}

/**
 * Identity for an OAuth login. /v1/users/validate.json is API-key-only (500s
 * on Bearer tokens), so OAuth callers use the userinfo endpoint instead.
 * Returns the same shape as validateKey.
 */
function oauthUserInfo(accessToken, oauthBase = OAUTH_BASE) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${oauthBase}/oauth/userinfo`)
    const req = https.get({
      hostname: u.hostname,
      path:     u.pathname,
      headers:  { Authorization: `Bearer ${accessToken}`, accept: 'application/json', ...APP_HEADERS },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Nexus userinfo HTTP ${res.statusCode}`))
        }
        try {
          const info = JSON.parse(data)
          const roles = Array.isArray(info.membership_roles) ? info.membership_roles : []
          resolve({
            name:       info.name || 'Nexus user',
            isPremium:  roles.includes('premium'),
            profileUrl: info.avatar || null,
          })
        } catch (err) { reject(new Error(`Bad JSON from Nexus userinfo: ${err.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Nexus userinfo request timed out')) })
  })
}

// Mod files

/**
 * PREMIUM ONLY: generate a direct download link for a specific file.
 * Returns the first CDN URI.
 */
async function getDownloadLink(auth, nexusId, fileId) {
  const links = await apiGet(auth, `/v1/games/${GAME}/mods/${nexusId}/files/${fileId}/download_link.json`)
  if (!Array.isArray(links) || links.length === 0 || !links[0].URI) {
    throw new Error('Nexus returned no download link (premium account required).')
  }
  return links[0].URI
}

// Download

/** Stream a URL to destPath, following redirects. */
function downloadFile(url, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: APP_HEADERS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
        return resolve(downloadFile(res.headers.location, destPath, onProgress, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} downloading mod archive`))
      }

      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const file = fs.createWriteStream(destPath)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', err => { try { fs.unlinkSync(destPath) } catch {} reject(err) })
      res.on('error',  err => { try { fs.unlinkSync(destPath) } catch {} reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('Mod download timed out')) })
  })
}

// File download

/**
 * Download one resolved file entry into downloadsDir. The archive is named
 * deterministically (`…-{modId}-{fileId}…`) so re-runs reuse it.
 * PREMIUM ONLY (uses the download-link API).
 */
async function downloadFileEntry(auth, nexusId, file, downloadsDir, onProgress) {
  const url         = await getDownloadLink(auth, nexusId, file.fileId)
  const ext         = path.extname(file.fileName) || '.zip'
  const base        = path.basename(file.fileName, ext)
  const archiveName = `${base}-${nexusId}-${file.fileId}${ext}`
  const destPath    = path.join(downloadsDir, archiveName)

  if (fs.existsSync(destPath)) { _log(`${archiveName} already downloaded`); return archiveName }
  fs.mkdirSync(downloadsDir, { recursive: true })
  const tmp = destPath + '.unfinished'
  await downloadFile(url, tmp, onProgress)
  fs.renameSync(tmp, destPath)
  return archiveName
}

// SSO login (one-click, Vortex/Wabbajack-style)

/**
 * Nexus SSO flow: connect to wss://sso.nexusmods.com, hand the browser an
 * authorize URL, and receive the user's API key over the websocket once
 * they click "Authorise" on the Nexus site.
 *
 * Requires an application slug registered with Nexus Mods. Uses Node's
 * built-in WebSocket client (Node >= 21 / current Electron).
 *
 * @param {string} appSlug                Registered Nexus application slug
 * @param {(url: string) => void} openUrl Called with the authorize URL to open
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}             The user's API key
 */
function ssoLogin(appSlug, openUrl, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (!appSlug) return reject(new Error('No Nexus application slug configured.'))
    if (typeof WebSocket === 'undefined') {
      return reject(new Error('WebSocket client unavailable in this runtime.'))
    }

    const id = require('crypto').randomUUID()
    const ws = new WebSocket('wss://sso.nexusmods.com')

    let settled = false
    const finish = (err, key) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      err ? reject(err) : resolve(key)
    }

    const timer = setTimeout(() => finish(new Error('Nexus login timed out - try again.')), timeoutMs)

    ws.onopen = () => {
      // protocol 2: server replies with a connection_token, then (after the
      // user authorises in the browser) with the api_key.
      ws.send(JSON.stringify({ id, token: null, protocol: 2 }))
      openUrl(`https://www.nexusmods.com/sso?id=${id}&application=${appSlug}`)
    }

    ws.onmessage = event => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.success === false) {
        return finish(new Error(msg.error || 'Nexus SSO rejected the request.'))
      }
      if (msg.data?.api_key) {
        _log('SSO login complete')
        return finish(null, msg.data.api_key)
      }
      // First reply carries data.connection_token - nothing to do but wait.
    }

    ws.onerror = ()  => finish(new Error('Could not reach the Nexus SSO service.'))
    ws.onclose = ()  => finish(new Error('Nexus SSO connection closed before login completed.'))
  })
}

// OAuth login (users.nexusmods.com, authorization code + PKCE)
//
// The flow Nexus registers new applications for. The launcher is a public
// client: no secret, PKCE (S256) proves the token request comes from the
// same app that started the authorization. The registered callback URL is
//   http://127.0.0.1:<port>/nexus/callback
// served by a short-lived loopback listener that exists only for the login.

const OAUTH_BASE = 'https://users.nexusmods.com'

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** POST a form-encoded body and parse the JSON reply. */
function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url)
    const body = new URLSearchParams(params).toString()
    const mod  = u.protocol === 'https:' ? https : http
    const req  = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...APP_HEADERS,
        accept:           'application/json',
      },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { /* keep raw for the error below */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(json?.error_description || json?.error || `HTTP ${res.statusCode} from ${u.hostname}`))
        }
        if (!json) return reject(new Error(`Bad JSON from ${u.hostname}`))
        resolve(json)
      })
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Nexus OAuth request timed out')) })
    req.write(body)
    req.end()
  })
}

// Page shown in the browser at the end of the OAuth hop. Success closes
// itself where the browser allows it, mirroring the Discord callback page.
function oauthCallbackPage(ok, message) {
  const accent = ok ? '#c8a25f' : '#c0564f'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alduinak - Nexus login</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#16120d 0%,#0b0906 70%);color:#d8cdb8;font-family:Georgia,serif;text-align:center}h1{color:${accent};font-weight:normal;letter-spacing:.12em;text-transform:uppercase;font-size:1.4rem}p{color:#857a66}</style>
</head><body><div><h1>${ok ? 'Logged in to Nexus' : 'Nexus login failed'}</h1><p id="note">${ok ? 'This tab will close itself…' : String(message || 'Return to the launcher and try again.').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</p></div>
${ok ? '<script>window.close();setTimeout(function(){var n=document.getElementById("note");if(n)n.textContent="You can close this tab and return to the launcher."},600)</script>' : ''}</body></html>`
}

/**
 * OAuth authorization-code + PKCE login.
 * Resolves { access_token, refresh_token, expires_in, ... } from the token
 * endpoint. `oauthBase` is overridable for tests.
 *
 * @param {object} opts
 * @param {string} opts.clientId  Registered Nexus OAuth client id
 * @param {number} opts.port      Loopback port; the registered callback URL
 *                                must be http://127.0.0.1:<port>/nexus/callback
 * @param {(url: string) => void} opts.openUrl
 */
function oauthLogin({ clientId, port, openUrl, timeoutMs = 5 * 60 * 1000, oauthBase = OAUTH_BASE }) {
  return new Promise((resolve, reject) => {
    if (!clientId) return reject(new Error('No Nexus OAuth client id configured.'))

    const verifier    = b64url(crypto.randomBytes(32))
    const challenge   = b64url(crypto.createHash('sha256').update(verifier).digest())
    const state       = b64url(crypto.randomBytes(16))
    const redirectUri = `http://127.0.0.1:${port}/nexus/callback`

    let settled = false
    const finish = (err, tokens) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // close() stops new connections but lets the in-flight callback
      // response finish, and frees the port for an immediate retry.
      try { server.close() } catch {}
      err ? reject(err) : resolve(tokens)
    }
    const timer = setTimeout(() => finish(new Error('Nexus login timed out - try again.')), timeoutMs)

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirectUri)
      if (u.pathname !== '/nexus/callback') { res.writeHead(404); return res.end() }
      const deny = msg => {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(oauthCallbackPage(false, msg))
        finish(new Error(msg))
      }
      if (u.searchParams.get('error')) return deny(`Nexus reported: ${u.searchParams.get('error_description') || u.searchParams.get('error')}`)
      if (u.searchParams.get('state') !== state) return deny('OAuth state mismatch - start the login again from the launcher.')
      const code = u.searchParams.get('code')
      if (!code) return deny('The Nexus reply carried no authorization code.')
      try {
        const tokens = await postForm(`${oauthBase}/oauth/token`, {
          grant_type:    'authorization_code',
          client_id:     clientId,
          code,
          redirect_uri:  redirectUri,
          code_verifier: verifier,
        })
        if (!tokens.access_token) throw new Error('No access token in the token reply.')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(oauthCallbackPage(true))
        _log('OAuth login complete')
        finish(null, tokens)
      } catch (err) {
        deny(`Token exchange failed: ${err.message}`)
      }
    })
    server.on('error', err => finish(err.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use - close whatever is using it and try again.`)
      : err))
    server.listen(port, '127.0.0.1', () => {
      const params = new URLSearchParams({
        response_type:         'code',
        client_id:             clientId,
        redirect_uri:          redirectUri,
        scope:                 'openid profile',
        state,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
      })
      openUrl(`${oauthBase}/oauth/authorize?${params}`)
    })
  })
}

/** Exchange a refresh token for a fresh access token. */
function refreshOauth(clientId, refreshToken, oauthBase = OAUTH_BASE) {
  return postForm(`${oauthBase}/oauth/token`, {
    grant_type:    'refresh_token',
    client_id:     clientId,
    refresh_token: refreshToken,
  })
}

module.exports = {
  setLogger,
  authHeaders,
  validateKey,
  oauthUserInfo,
  getDownloadLink,
  downloadFileEntry,
  ssoLogin,
  oauthLogin,
  refreshOauth,
}
