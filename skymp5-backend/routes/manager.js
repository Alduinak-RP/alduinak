'use strict'
// Web Server Manager gateway: authenticates, rate-limits and audits, then relays to the loopback AlduinakManager agent

const { Router } = require('express')
const rateLimit  = require('express-rate-limit')
const { requireManager } = require('../middleware/requireManager')
const { ADMIN_IDLE_MS, ADMIN_ABSOLUTE_MS } = require('../sources/dashboardAuth')
const { callAgent } = require('../sources/manager/agentClient')
const { auditLog, requestActor } = require('../sources/manager/audit')
const { JOB_KINDS, CONSOLE_VERBS, parseConsoleCommand } = require('../sources/manager/protocol')

const router = Router()
const audit  = auditLog('backend')

function limited(scope) {
  return (req, res) => {
    audit.append({ ...requestActor(req, req.managerSession), action: `manager ${req.method} ${req.baseUrl}${req.path}`, outcome: 'rate-limited', detail: scope })
    res.status(429).json({ error: 'too many requests, slow down' })
  }
}

const common = { windowMs: 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false }
// Before auth, per client IP, to slow token guessing without starving several admins behind one address
const ipLimiter = rateLimit({ ...common, limit: 600, handler: limited('ip') })
// Polling reads and actions get separate per-session budgets so a busy log view never blocks a restart
const readLimiter = rateLimit({ ...common, limit: 300, keyGenerator: req => `read:${req.managerSession.id}`, skip: req => req.method !== 'GET', handler: limited('reads') })
const actionLimiter = rateLimit({ ...common, limit: 20, keyGenerator: req => `action:${req.managerSession.id}`, skip: req => req.method === 'GET', handler: limited('actions') })

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
router.use(ipLimiter, requireManager, readLimiter, actionLimiter)

function actorOf(req) {
  return { discordId: String(req.managerSession.discordId), username: String(req.managerSession.username || ''), ip: req.ip }
}

function intParam(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return null
  if (!/^\d{1,15}$/.test(String(value))) return NaN
  const n = Number(value)
  return n >= min && n <= max ? n : NaN
}

// Rebuilds the query from validated integers so nothing the browser sent is forwarded verbatim
function query(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

async function relay(req, res, method, path, body) {
  const r = await callAgent({ method, path, actor: actorOf(req), body })
  res.status(r.status).json(r.data)
  return r
}

function bad(res, error) {
  res.status(400).json({ error })
}

router.get('/me', (req, res) => {
  const s = req.managerSession
  res.json({
    user: { discordId: s.discordId, username: s.username, avatar: s.avatar },
    idleTimeoutMs: ADMIN_IDLE_MS,
    expiresAt: s.createdAt + ADMIN_ABSOLUTE_MS,
    consoleVerbs: CONSOLE_VERBS,
    jobKinds: Object.entries(JOB_KINDS).map(([kind, k]) => ({ kind, label: k.label, build: k.build })),
  })
})

router.get('/health', (req, res) => relay(req, res, 'GET', '/health'))
router.get('/services', (req, res) => relay(req, res, 'GET', '/services'))
router.get('/logs', (req, res) => relay(req, res, 'GET', '/logs'))

router.get('/logs/:id', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return bad(res, 'unknown log')
  const from = intParam(req.query.from), before = intParam(req.query.before), max = intParam(req.query.max, { min: 1024, max: 262144 })
  if ([from, before, max].some(Number.isNaN)) return bad(res, 'from, before and max must be byte offsets')
  relay(req, res, 'GET', `/logs/${req.params.id}${query({ from, before, max })}`)
})

router.get('/jobs', (req, res) => {
  const limit = intParam(req.query.limit, { min: 1, max: 200 })
  if (Number.isNaN(limit)) return bad(res, 'limit must be 1-200')
  relay(req, res, 'GET', `/jobs${query({ limit })}`)
})

const JOB_ID_RE = /^\d{8}-\d{6}-[a-f0-9]{6}$/

router.get('/jobs/:id', (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return bad(res, 'unknown job')
  relay(req, res, 'GET', `/jobs/${req.params.id}`)
})

router.get('/jobs/:id/log', (req, res) => {
  const from = intParam(req.query.from)
  if (!JOB_ID_RE.test(req.params.id) || Number.isNaN(from)) return bad(res, 'unknown job or offset')
  relay(req, res, 'GET', `/jobs/${req.params.id}/log${query({ from })}`)
})

router.post('/jobs', async (req, res) => {
  const body = req.body || {}
  const kind = body.kind
  const base = { ...requestActor(req, req.managerSession), action: 'job.start', target: String(kind || '') }
  if (Object.keys(body).some(k => k !== 'kind') || typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(JOB_KINDS, kind)) {
    audit.append({ ...base, outcome: 'refused', detail: 'unknown job kind or options' }, { mirror: true })
    return bad(res, `kind must be one of ${Object.keys(JOB_KINDS).join(', ')} with no other options`)
  }
  const r = await relay(req, res, 'POST', '/jobs', { kind })
  audit.append({ ...base, outcome: r.status === 202 ? 'started' : 'refused', status: r.status, jobId: r.data && r.data.jobId, commit: r.data && r.data.commit, detail: r.data && r.data.error }, { mirror: true })
})

router.get('/console', (req, res) => {
  const after = intParam(req.query.after)
  if (Number.isNaN(after)) return bad(res, 'after must be a line number')
  relay(req, res, 'GET', `/console${query({ after })}`)
})

router.post('/console', async (req, res) => {
  const parsed = parseConsoleCommand((req.body || {}).text)
  const base = { ...requestActor(req, req.managerSession), action: 'console' }
  if (!parsed.ok) {
    audit.append({ ...base, target: String((req.body || {}).text || '').slice(0, 40), outcome: 'refused', detail: parsed.error }, { mirror: true })
    return bad(res, parsed.error)
  }
  const r = await relay(req, res, 'POST', '/console', { text: parsed.command })
  audit.append({ ...base, target: parsed.verb, params: { command: parsed.command }, outcome: r.status === 200 ? 'sent' : 'failed', status: r.status, detail: r.data && r.data.error }, { mirror: true })
})

router.get('/settings/:file', async (req, res) => {
  if (!['serverSettings', 'backendEnv'].includes(req.params.file)) return bad(res, 'unknown settings file')
  const r = await relay(req, res, 'GET', `/settings/${req.params.file}`)
  audit.append({ ...requestActor(req, req.managerSession), action: 'settings.view', target: req.params.file, outcome: r.status === 200 ? 'ok' : 'failed', status: r.status })
})

module.exports = router
