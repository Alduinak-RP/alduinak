'use strict'
// Gate for /api/manager and every other admin-level power: admin.* confirmed live against Discord, a dashboard-origin login with Discord 2FA, and a dashboard Origin on writes

const config   = require('../config')
const { sessionFromRequest, confirmAdmin } = require('../sources/dashboardAuth')
const { auditLog, requestActor } = require('../sources/manager/audit')

const audit = auditLog('backend')

function dashboardOrigin() {
  try { return new URL(config.dashboardPublicUrl).origin } catch { return '' }
}

/** Why a session may not use the manager, or null; idle and lifetime limits are enforced earlier by sessionFromRequest. */
function managerDenial(session, { method = 'GET', origin = '' } = {}) {
  if (!session) return { status: 401, error: 'not authenticated', reason: 'session' }
  if (!(session.permissions || []).includes('admin.*')) return { status: 403, error: 'the server manager needs the dashboard admin role', reason: 'admin' }
  if (session.aud !== 'dashboard') return { status: 403, error: 'log in through the dashboard itself to use the server manager', reason: 'audience' }
  if (session.mfa !== true) return { status: 403, error: 'turn on two-factor authentication for your Discord account, then log out and in again', reason: 'mfa' }
  if (method !== 'GET' && method !== 'HEAD' && origin !== dashboardOrigin()) return { status: 403, error: 'requests that change anything must come from the dashboard page', reason: 'origin' }
  return null
}

/** managerDenial plus a live Discord confirmation of admin.*; resolves the denial or null. */
async function managerCheck(req, session) {
  const denial = managerDenial(session, { method: req.method, origin: req.get('origin') || '' })
  if (denial) return denial
  let verdict
  try { verdict = await confirmAdmin(session) }
  catch { verdict = 'unavailable' }
  if (verdict === 'unavailable') return { status: 503, error: 'cannot confirm your Discord roles right now, try again shortly', reason: 'discord' }
  if (verdict !== 'ok') return { status: 401, error: 'your Discord roles changed, log in again', reason: 'roles' }
  return null
}

async function requireManager(req, res, next) {
  const session = sessionFromRequest(req)
  const denial = await managerCheck(req, session)
  if (denial) {
    audit.append({ ...requestActor(req, session), action: `manager ${req.method} ${req.baseUrl}${req.path}`, outcome: 'denied', status: denial.status, detail: denial.reason }, { mirror: denial.status === 403 })
    return res.status(denial.status).json({ error: denial.error, reason: denial.reason })
  }
  req.managerSession = session
  next()
}

/** Audits a privileged change by req.session and answers the request when the manager gate refuses it; resolves true when allowed. */
async function guardPrivilegedChange(req, res, { action, target, what }) {
  const denial = await managerCheck(req, req.session)
  audit.append({ ...requestActor(req, req.session), action, target, detail: denial ? `${what}: ${denial.reason}` : what, outcome: denial ? 'denied' : 'allowed', status: denial ? denial.status : undefined }, { mirror: true })
  if (!denial) return true
  const error = denial.reason === 'admin' ? `only admins can ${what}` : `${denial.error} (needed to ${what})`
  res.status(denial.status).json({ error, reason: denial.reason })
  return false
}

module.exports = { requireManager, managerDenial, managerCheck, guardPrivilegedChange }
