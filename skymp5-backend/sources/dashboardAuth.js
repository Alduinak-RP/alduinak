'use strict'
// Resolves the dashboard session behind a request and drops it once its permissions no longer match the live roles

const sessions   = require('./dashboardSessions')
const discordBot = require('./discordBot')
const liveEnv    = require('./liveEnv')
const { effectivePermissions } = require('./permissions')

function bearerToken(req) {
  const auth = req.headers['authorization'] ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

function samePermissions(a, b) {
  const x = [...new Set(a || [])].sort()
  const y = [...new Set(b || [])].sort()
  return x.length === y.length && x.every((p, i) => p === y[i])
}

// Stale means role-permissions.json, DASHBOARD_DISCORD_IDS or the member's roles no longer grant what the session was issued
function isStale(session, roles = session.roles) {
  return !samePermissions(effectivePermissions(session.discordId, roles), session.permissions)
}

// Sessions holding admin.* can reach the server manager, so they also end after 30 idle minutes and 12 hours
const ADMIN_IDLE_MS     = 30 * 60 * 1000
const ADMIN_ABSOLUTE_MS = 12 * 60 * 60 * 1000

function adminSessionExpired(session, now = Date.now()) {
  if (!(session.permissions || []).includes('admin.*')) return false
  return now - session.createdAt > ADMIN_ABSOLUTE_MS || now - (session.lastUsedAt || session.createdAt) > ADMIN_IDLE_MS
}

function sessionFromRequest(req) {
  const session = sessions.validate(bearerToken(req))
  if (!session) return null
  if (isStale(session) || adminSessionExpired(session)) {
    sessions.revokeById(session.id)
    return null
  }
  if (!isBackgroundPoll(req)) sessions.touch(session)
  return session
}

// The Server tab marks the requests it makes without user input, so an unattended page still reaches the idle timeout
function isBackgroundPoll(req) {
  return req.headers['x-dashboard-poll'] === '1'
}

/** Revokes every session whose permissions changed, e.g. after a role permission edit. */
function revokeStaleSessions() {
  return sessions.revokeWhere(s => isStale(s))
}

/**
 * Confirms admin.* against Discord's current roles instead of the login snapshot.
 * Returns 'ok', 'denied' (the session was revoked or never held admin.*) or 'unavailable' (Discord could not be asked).
 */
async function confirmAdmin(session) {
  if (liveEnv.list('DASHBOARD_DISCORD_IDS').includes(String(session.discordId))) return 'ok'
  const roles = await discordBot.lookupMemberRoles(session.discordId)
  if (roles === null) return 'unavailable'
  if (isStale(session, roles)) {
    sessions.revokeById(session.id)
    return 'denied'
  }
  return effectivePermissions(session.discordId, roles).includes('admin.*') ? 'ok' : 'denied'
}

discordBot.onMemberRolesChanged((discordId, roles) => {
  const dropped = sessions.revokeWhere(s => String(s.discordId) === String(discordId) && isStale(s, roles || []))
  if (dropped) console.log(`[dashboard-auth] revoked ${dropped} session(s) of ${discordId} after a Discord role change`)
})

module.exports = { bearerToken, sessionFromRequest, revokeStaleSessions, confirmAdmin, isStale, adminSessionExpired, ADMIN_IDLE_MS, ADMIN_ABSOLUTE_MS }
