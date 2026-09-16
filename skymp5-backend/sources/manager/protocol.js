'use strict'
// Shared contract between the backend /api/manager gateway and the loopback AlduinakManager agent

const crypto = require('crypto')

const SKEW_MS = 30 * 1000
const MIN_SECRET_LENGTH = 32

// Phase 1 jobs; everything else (manifest, sync, settings writes, launcher/client/native builds, purge, wipe) stays local
const JOB_KINDS = {
  'game.start':     { label: 'Start game server',   build: false },
  'game.stop':      { label: 'Stop game server',    build: false },
  'game.restart':   { label: 'Restart game server', build: false },
  'build.gamemode': { label: 'Build gamemode only', build: true },
  'build.server':   { label: 'Build server',        build: true },
}

const CONSOLE_VERBS = ['say', 'notify', 'kick', 'players', 'status']
const CONSOLE_MAX = 500

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(address) {
  return LOOPBACK.has(String(address || ''))
}

// Internal query replies such as __PLAYERSJSON__ are fanned out to every console socket and never shown on the web
function isInternalLine(line) {
  return /^\s*__/.test(line)
}

function dropInternalLines(text) {
  return String(text).split('\n').filter(line => !isInternalLine(line)).join('\n')
}

/** Validates a web console command against the allow-list: { ok, verb, command } or { ok: false, error }. */
function parseConsoleCommand(text) {
  if (typeof text !== 'string') return { ok: false, error: 'command must be text' }
  if (text.length > CONSOLE_MAX) return { ok: false, error: `commands are limited to ${CONSOLE_MAX} characters` }
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!clean) return { ok: false, error: 'empty command' }
  if (clean.includes('__')) return { ok: false, error: 'commands may not contain "__"' }
  const [first, ...rest] = clean.split(/\s+/)
  const verb = first.toLowerCase()
  if (!CONSOLE_VERBS.includes(verb)) return { ok: false, error: `only ${CONSOLE_VERBS.join(', ')} are allowed from the web console` }
  const usage = { say: 'say <text>', notify: 'notify <name|all> <text>', kick: 'kick <name>' }
  if ((verb === 'players' || verb === 'status') && rest.length) return { ok: false, error: `${verb} takes no arguments` }
  if ((verb === 'say' || verb === 'kick') && !rest.length) return { ok: false, error: `usage: ${usage[verb]}` }
  if (verb === 'notify' && rest.length < 2) return { ok: false, error: `usage: ${usage.notify}` }
  return { ok: true, verb, command: [verb, ...rest].join(' ') }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function signature(secret, { ts, nonce, method, path, actor, body }) {
  const canonical = [ts, nonce, String(method).toUpperCase(), path, actor, sha256(body)].join('\n')
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex')
}

/** Headers for a backend-to-agent call; path includes the query string, so neither can be swapped. */
function signedHeaders(secret, { method, path, actor, body = '' }) {
  const ts = String(Date.now())
  const nonce = crypto.randomBytes(16).toString('hex')
  const actorB64 = Buffer.from(JSON.stringify(actor || {})).toString('base64url')
  return {
    'X-Mgr-Ts': ts,
    'X-Mgr-Nonce': nonce,
    'X-Mgr-Actor': actorB64,
    'X-Mgr-Sig': signature(secret, { ts, nonce, method, path, actor: actorB64, body }),
  }
}

/** Checks a signed agent request: { ok, actor } or { ok: false, status, error }. nonces is a Map the caller keeps. */
function verifySigned(secret, { method, path, headers, body = '', nonces, now = Date.now() }) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return { ok: false, status: 503, error: `MANAGER_AGENT_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters` }
  const ts = String(headers['x-mgr-ts'] || '')
  const nonce = String(headers['x-mgr-nonce'] || '')
  const actorB64 = String(headers['x-mgr-actor'] || '')
  const sig = String(headers['x-mgr-sig'] || '')
  if (!/^\d{13}$/.test(ts) || Math.abs(now - Number(ts)) > SKEW_MS) return { ok: false, status: 401, error: 'stale or missing timestamp' }
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig) || !/^[A-Za-z0-9_-]{1,2048}$/.test(actorB64)) return { ok: false, status: 401, error: 'malformed signature headers' }
  const expected = signature(secret, { ts, nonce, method, path, actor: actorB64, body })
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return { ok: false, status: 401, error: 'bad signature' }
  for (const [n, at] of nonces) if (now - at > 2 * SKEW_MS) nonces.delete(n)
  if (nonces.has(nonce)) return { ok: false, status: 401, error: 'replayed request' }
  nonces.set(nonce, now)
  let actor
  try { actor = JSON.parse(Buffer.from(actorB64, 'base64url').toString('utf8')) } catch { actor = null }
  if (!actor || typeof actor.discordId !== 'string' || !actor.discordId) return { ok: false, status: 401, error: 'missing actor' }
  return { ok: true, actor }
}

module.exports = {
  JOB_KINDS,
  CONSOLE_VERBS,
  MIN_SECRET_LENGTH,
  isLoopback,
  isInternalLine,
  dropInternalLines,
  parseConsoleCommand,
  signedHeaders,
  verifySigned,
}
