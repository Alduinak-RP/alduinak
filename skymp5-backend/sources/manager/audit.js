'use strict'
// Append-only JSONL audit trail; every line carries the hash of the one before it, so an edited or deleted line breaks the chain

const crypto  = require('crypto')
const fs      = require('fs')
const https   = require('https')
const path    = require('path')
const liveEnv = require('../liveEnv')

const SECRET_KEY_RE = /token|secret|pass|pwd|key|uri|auth|cookie|webhook|credential/i
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/
const MIRROR_PER_MIN = 30

function logDir() {
  return liveEnv.get('MANAGER_LOG_DIR') || 'C:\\logs\\manager'
}

function clean(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
  if (typeof value !== 'object') return value
  if (depth > 3) return '[nested]'
  if (Array.isArray(value)) return value.slice(0, 20).map(v => clean(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : clean(v, depth + 1)
  return out
}

function lastHash(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 65536)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    return lines.length ? JSON.parse(lines[lines.length - 1]).hash || 'unreadable' : 'genesis'
  } catch (err) {
    return err.code === 'ENOENT' ? 'genesis' : 'unreadable'
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

let mirrorWindow = { start: 0, count: 0 }

function mirror(record) {
  const url = liveEnv.get('MANAGER_AUDIT_WEBHOOK_URL')
  if (!url || !WEBHOOK_RE.test(url)) return
  const now = Date.now()
  if (now - mirrorWindow.start > 60000) mirrorWindow = { start: now, count: 0 }
  if (++mirrorWindow.count > MIRROR_PER_MIN) return
  const who = record.actor ? `${record.actor.username || '?'} (${record.actor.discordId || '?'})` : 'unknown'
  const content = `[${record.src}] ${record.outcome} ${record.action}${record.target ? ' ' + record.target : ''} by ${who} from ${record.ip || '?'}${record.detail ? ': ' + record.detail : ''} #${String(record.hash).slice(0, 12)}`
  const body = JSON.stringify({ content: content.replace(/[`@]/g, "'").slice(0, 1900), allowed_mentions: { parse: [] } })
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 5000 })
  req.on('error', err => console.error('[manager-audit] webhook failed:', err.message))
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.end(body)
}

const logs = new Map()

/** One shared chained file per writing process, e.g. audit-backend.jsonl and audit-agent.jsonl. */
function auditLog(src) {
  if (logs.has(src)) return logs.get(src)
  let chain = { file: null, hash: null }
  const log = {
    append(event, { mirror: toDiscord = false } = {}) {
      const file = path.join(logDir(), `audit-${src}.jsonl`)
      try {
        if (chain.file !== file) chain = { file, hash: lastHash(file) }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const record = { ts: new Date().toISOString(), src, ...clean(event), prevHash: chain.hash }
        record.hash = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')
        fs.appendFileSync(file, JSON.stringify(record) + '\n')
        chain.hash = record.hash
        if (toDiscord) mirror(record)
        return record
      } catch (err) {
        console.error('[manager-audit] write failed:', err.message)
        return null
      }
    },
  }
  logs.set(src, log)
  return log
}

/** Checks the hash chain of one audit file: { ok, lines, brokenAt } with brokenAt as a 1-based line number. */
function verifyAuditFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let prev = null
  for (let i = 0; i < lines.length; i++) {
    let record
    try { record = JSON.parse(lines[i]) } catch { return { ok: false, lines: lines.length, brokenAt: i + 1 } }
    const { hash, ...rest } = record
    const expected = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex')
    if (hash !== expected || (prev !== null && rest.prevHash !== prev)) return { ok: false, lines: lines.length, brokenAt: i + 1 }
    prev = hash
  }
  return { ok: true, lines: lines.length, brokenAt: null }
}

/** Audit fields describing the caller of a request. */
function requestActor(req, session) {
  return {
    actor: session ? { discordId: session.discordId, username: session.username } : null,
    ip: req.ip,
    ua: String(req.get('user-agent') || '').slice(0, 80),
  }
}

module.exports = { auditLog, verifyAuditFile, requestActor, clean, SECRET_KEY_RE }
