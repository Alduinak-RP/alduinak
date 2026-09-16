'use strict'
// Dashboard session store: tokens issued after Discord OAuth, kept only as sha256 hashes in data/dashboard-sessions.json so restarts don't log everyone out

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

const FILE = path.join(__dirname, '..', 'data', 'dashboard-sessions.json')
const TTL  = 24 * 60 * 60 * 1000  // 24 h
const FLUSH_MS = 60 * 1000

// sha256(token) -> { id, discordId, username, avatar, roles, permissions, aud, mfa, createdAt, expiresAt, lastUsedAt }
const sessions = new Map()
let dirty = false

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function _load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    const now = Date.now()
    // The first format was [rawToken, data] pairs; hashing them on load keeps those logins valid for the dashboard
    const legacy = Array.isArray(raw)
    const entries = legacy ? raw.map(([token, data]) => [hashToken(token), data]) : (raw.sessions || []).map(s => [s.id, s])
    for (const [id, data] of entries) {
      if (data && data.expiresAt > now) sessions.set(id, { ...data, id, createdAt: data.createdAt || data.expiresAt - TTL })
    }
    if (legacy) _save()
    console.log(`[dashboard-sessions] loaded ${sessions.size} active session(s)`)
  } catch { /* file absent on first run */ }
}

function _save() {
  try {
    const dir = path.dirname(FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, sessions: [...sessions.values()] }))
    fs.renameSync(tmp, FILE)
    dirty = false
  } catch (err) {
    console.error('[dashboard-sessions] save failed:', err.message)
  }
}

// Last-used stamps change on every request, so they are flushed at most once a minute
setInterval(() => { if (dirty) _save() }, FLUSH_MS).unref()

function create(discordId, username, avatar, roles = [], permissions = [], { aud = 'website', mfa = false } = {}) {
  const now = Date.now()
  for (const [id, d] of sessions) if (d.expiresAt <= now) sessions.delete(id)

  const token = crypto.randomBytes(32).toString('hex')
  const id = hashToken(token)
  sessions.set(id, { id, discordId, username, avatar, roles, permissions, aud, mfa: mfa === true, createdAt: now, expiresAt: now + TTL, lastUsedAt: now })
  _save()
  return token
}

function validate(token) {
  if (!token) return null
  const id = hashToken(token)
  const data = sessions.get(id)
  if (!data) return null
  if (data.expiresAt < Date.now()) {
    sessions.delete(id)
    _save()
    return null
  }
  return data
}

function touch(session) {
  session.lastUsedAt = Date.now()
  dirty = true
}

function revoke(token) {
  if (sessions.delete(hashToken(token))) _save()
}

function revokeById(id) {
  if (sessions.delete(id)) _save()
}

/** Revokes every session matching the predicate and returns how many went. */
function revokeWhere(predicate) {
  let count = 0
  for (const [id, data] of sessions) {
    if (predicate(data)) { sessions.delete(id); count++ }
  }
  if (count) _save()
  return count
}

_load()
module.exports = { create, validate, touch, revoke, revokeById, revokeWhere, hashToken }
