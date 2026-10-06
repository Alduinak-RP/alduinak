'use strict'
// Shared contract between the backend /api/manager gateway and the loopback AlduinakManager agent

const crypto = require('crypto')
const { loc } = require('../loc')

const SKEW_MS = 30 * 1000
const MIN_SECRET_LENGTH = 32

// Phase 1 jobs; everything else (manifest, sync, settings writes, launcher/client/native builds, purge, wipe) stays local
const JOB_KINDS = {
  'game.start':     { label: loc('job.gameStart'), build: false },
  'game.stop':      { label: loc('job.gameStop'),  build: false },
  'game.restart':   { label: loc('job.gameRestart'), build: false },
  'build.gamemode': { label: loc('job.buildGamemode'), build: true },
  'build.server':   { label: loc('job.buildServer'), build: true },
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
  if (typeof text !== 'string') return { ok: false, error: loc('console.notText') }
  if (text.length > CONSOLE_MAX) return { ok: false, error: loc('console.tooLong', { max: CONSOLE_MAX }) }
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!clean) return { ok: false, error: loc('console.empty') }
  if (clean.includes('__')) return { ok: false, error: loc('console.underscores') }
  const [first, ...rest] = clean.split(/\s+/)
  const verb = first.toLowerCase()
  if (!CONSOLE_VERBS.includes(verb)) return { ok: false, error: loc('console.verbs', { verbs: CONSOLE_VERBS.join(', ') }) }
  const usage = { say: loc('console.usageSay'), notify: loc('console.usageNotify'), kick: loc('console.usageKick') }
  if ((verb === 'players' || verb === 'status') && rest.length) return { ok: false, error: loc('console.noArguments', { verb }) }
  if ((verb === 'say' || verb === 'kick') && !rest.length) return { ok: false, error: loc('console.usage', { usage: usage[verb] }) }
  if (verb === 'notify' && rest.length < 2) return { ok: false, error: loc('console.usage', { usage: usage.notify }) }
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
  if (!secret || secret.length < MIN_SECRET_LENGTH) return { ok: false, status: 503, error: loc('signed.secretTooShort', { min: MIN_SECRET_LENGTH }) }
  const ts = String(headers['x-mgr-ts'] || '')
  const nonce = String(headers['x-mgr-nonce'] || '')
  const actorB64 = String(headers['x-mgr-actor'] || '')
  const sig = String(headers['x-mgr-sig'] || '')
  if (!/^\d{13}$/.test(ts) || Math.abs(now - Number(ts)) > SKEW_MS) return { ok: false, status: 401, error: loc('signed.staleTimestamp') }
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig) || !/^[A-Za-z0-9_-]{1,2048}$/.test(actorB64)) return { ok: false, status: 401, error: loc('signed.malformedHeaders') }
  const expected = signature(secret, { ts, nonce, method, path, actor: actorB64, body })
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return { ok: false, status: 401, error: loc('signed.badSignature') }
  for (const [n, at] of nonces) if (now - at > 2 * SKEW_MS) nonces.delete(n)
  if (nonces.has(nonce)) return { ok: false, status: 401, error: loc('signed.replayed') }
  nonces.set(nonce, now)
  let actor
  try { actor = JSON.parse(Buffer.from(actorB64, 'base64url').toString('utf8')) } catch { actor = null }
  if (!actor || typeof actor.discordId !== 'string' || !actor.discordId) return { ok: false, status: 401, error: loc('signed.missingActor') }
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
