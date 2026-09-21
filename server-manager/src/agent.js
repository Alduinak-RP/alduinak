'use strict'

// AlduinakManager: loopback-only job agent behind the dashboard's /api/manager gateway, run as its own nssm service

const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const config = require('./config')
const { Builder } = require('./build')
const services = require('./services')
const managerLock = require('./managerLock')
const modsync = require('./modsync')
const { createConsoleRelay } = require('./relayClient')
const { createRestartSchedule } = require('./restartSchedule')
const { maskSettings, secretValues, redactText } = require('./settingsMask')

const backendModule = name => require(path.join(config.paths.backend, 'sources', name))
const protocol = backendModule('manager/protocol')
const liveEnv  = backendModule('liveEnv')
const { auditLog } = backendModule('manager/audit')

const CONSOLE_BUFFER = 2000
const MAX_BODY = 64 * 1024
const LOG_CHUNK = 65536
const LOG_CHUNK_MAX = 262144
// Web builds refuse a checkout with changes other than these, which the Electron manager's version fields rewrite
const VERSION_FILES = ['skymp5-client/package.json', 'skymp5-server/package.json', 'skymp5-launcher/package.json', 'skymp5-backend/routes/version.js']

const RUNNERS = {
  'game.start':     (b, d) => serviceJob(b, d, 'start'),
  'game.stop':      (b, d) => serviceJob(b, d, 'stop'),
  'game.restart':   (b, d) => serviceJob(b, d, 'restart'),
  'build.gamemode': b => b.buildGamemode(),
  'build.server':   b => b.buildServer({}),
}

async function serviceJob(b, deps, verb) {
  const r = await deps.serviceAction(verb)
  for (const step of r.steps || []) b.line(step)
  return r.ok ? { ok: true } : { ok: false, error: (r.steps || []).join('; ') || r.error || `${verb} failed` }
}

function gitRun(root, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', root, ...args], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), error: err ? String(stderr || err.message).trim() : '' })
    })
  })
}

async function readGitState(root = config.repoRoot) {
  const [branch, head, status, merge] = await Promise.all([
    gitRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitRun(root, ['rev-parse', 'HEAD']),
    gitRun(root, ['status', '--porcelain=v1']),
    gitRun(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']),
  ])
  const failed = [branch, head, status].find(r => !r.ok)
  return {
    ok: !failed,
    error: failed ? failed.error : '',
    branch: branch.out.trim(),
    head: head.out.trim(),
    merging: merge.ok,
    dirty: status.out.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/')),
  }
}

/** Why a web build may not run from this checkout, or null. */
function gitProblem(state) {
  if (!state.ok) return `cannot read the git checkout: ${state.error}`
  if (state.branch !== 'main') return `web builds run only from main, the checkout is on ${state.branch}`
  if (state.merging) return 'a merge is in progress in the checkout'
  const other = state.dirty.filter(f => !VERSION_FILES.includes(f))
  if (other.length) return `the checkout has uncommitted changes besides version files: ${other.slice(0, 5).join(', ')}${other.length > 5 ? ', ...' : ''}`
  return null
}

/** Reads a byte range on line boundaries: tail by default, older text with before, newer text with from. */
function readChunk(file, { from = null, before = null, max = LOG_CHUNK } = {}) {
  const size = fs.statSync(file).size
  let reset = false
  if (from !== null && from > size) { reset = true; from = null }
  let start, end
  if (from !== null) { start = from; end = Math.min(size, from + max) }
  else if (before !== null) { end = Math.min(before, size); start = Math.max(0, end - max) }
  else { end = size; start = Math.max(0, size - max) }
  const buf = Buffer.alloc(end - start)
  if (buf.length) {
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, start) } finally { fs.closeSync(fd) }
  }
  let lo = 0
  let hi = buf.length
  if (from === null && start > 0) {
    const nl = buf.indexOf(10)
    lo = nl >= 0 ? nl + 1 : buf.length
  }
  if (from !== null) {
    const nl = buf.lastIndexOf(10)
    // A line still being written waits for the next poll, so no line is ever split
    if (nl >= 0) hi = nl + 1
    else if (end === size) hi = 0
  }
  return { text: buf.subarray(lo, hi).toString('utf8'), start: start + lo, end: start + hi, size, reset }
}

function jobId() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2))
  fs.renameSync(file + '.tmp', file)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function createAgent(overrides = {}) {
  const deps = {
    secret: () => config.agent.secret,
    dir: () => config.agent.dir,
    statusAll: () => services.statusAll(),
    serviceAction: verb => services.doServiceAction('game', verb),
    purgePending: () => services.purgePending(),
    builder: log => new Builder(log),
    gitState: () => readGitState(),
    discoverLogTargets: () => services.discoverLogTargets(),
    logDirs: () => [config.logDir, services.chatLogDir()],
    serverSettingsPath: () => config.paths.serverSettings,
    envValues: () => (fs.existsSync(liveEnv.FILE) ? liveEnv.all() : {}),
    lock: managerLock,
    audit: auditLog('agent'),
    relay: null,
    ...overrides,
  }

  const nonces = new Map()
  const consoleLines = []
  let consoleSeq = 0
  let running = null

  const jobsDir = () => path.join(deps.dir(), 'jobs')
  const jobFile = id => path.join(jobsDir(), `${id}.json`)
  const jobLog = id => path.join(jobsDir(), `${id}.log`)

  function readServerSettingsFile() {
    try { return { exists: true, ...modsync.readSettingsFile(deps.serverSettingsPath()) } }
    catch (err) {
      if (err.code === 'ENOENT') return { exists: false, settings: {}, mtimeMs: null }
      return { exists: true, settings: {}, mtimeMs: null, error: err instanceof SyntaxError ? 'server-settings.json is not valid JSON' : 'server-settings.json cannot be read' }
    }
  }

  let secretCache = { at: 0, list: [] }
  function secrets() {
    if (Date.now() - secretCache.at > 30000) {
      secretCache = { at: Date.now(), list: secretValues(readServerSettingsFile().settings, deps.envValues()) }
    }
    return secretCache.list
  }

  const webText = text => redactText(protocol.dropInternalLines(text), secrets())

  function pushConsole(text, kind) {
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
      if (!line.trim() || protocol.isInternalLine(line)) continue
      consoleLines.push({ seq: ++consoleSeq, at: new Date().toISOString(), kind, text: line })
    }
    if (consoleLines.length > CONSOLE_BUFFER) consoleLines.splice(0, consoleLines.length - CONSOLE_BUFFER)
  }

  const relay = deps.relay || createConsoleRelay({
    onStatus: text => pushConsole(text, 'status'),
    onOutput: text => pushConsole(text, 'output'),
  })

  let logTargetCache = { at: 0, list: [] }
  async function logTargets() {
    if (Date.now() - logTargetCache.at < 30000) return logTargetCache.list
    const byPath = new Map()
    const add = (file, label) => {
      const key = path.resolve(file).toLowerCase()
      if (!byPath.has(key)) byPath.set(key, { id: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12), file, label })
    }
    // nginx access.log holds every player IP and request line, so it stays off the web
    for (const t of await deps.discoverLogTargets()) if (!/access\.log$/i.test(t.file)) add(t.file, t.label)
    for (const dir of deps.logDirs()) {
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const name of names.sort()) {
        const file = path.join(dir, name)
        try { if (/\.log$/i.test(name) && fs.statSync(file).isFile()) add(file, name) } catch { /* vanished */ }
      }
    }
    logTargetCache = { at: Date.now(), list: [...byPath.values()] }
    return logTargetCache.list
  }

  function listJobs(limit) {
    let names = []
    try { names = fs.readdirSync(jobsDir()).filter(n => /^\d{8}-\d{6}-[a-f0-9]{6}\.json$/.test(n)) } catch { return [] }
    return names.sort().reverse().slice(0, limit).map(n => readJson(path.join(jobsDir(), n))).filter(Boolean)
  }

  function publicJob(job) {
    return job && { ...job, result: job.result && { ...job.result, error: job.result.error ? webText(job.result.error) : undefined } }
  }

  // Jobs still marked running belong to an agent that was stopped mid-job (nssm kills its children)
  function markInterrupted() {
    for (const job of listJobs(1000)) {
      if (job.status !== 'running') continue
      job.status = 'interrupted'
      job.finishedAt = new Date().toISOString()
      writeJsonAtomic(jobFile(job.id), job)
      deps.audit.append({ actor: job.actor, action: 'job.finish', target: job.kind, jobId: job.id, outcome: 'interrupted' })
    }
  }

  async function startJob(kind, actor) {
    const spec = protocol.JOB_KINDS[kind]
    const who = `${actor.username || '?'} (${actor.discordId})`
    const base = { actor: { discordId: actor.discordId, username: actor.username }, ip: actor.ip, action: 'job.start', target: kind }
    let git = null
    if (spec.build) {
      git = await deps.gitState()
      const problem = gitProblem(git)
      if (problem) {
        deps.audit.append({ ...base, outcome: 'refused', commit: git.head || null, detail: problem })
        return { status: 409, body: { error: problem, commit: git.head || null } }
      }
    }
    // Refused before the stop half of a restart, so a pending purge never leaves the server down
    const pending = kind === 'game.start' || kind === 'game.restart' ? deps.purgePending() : null
    if (pending) {
      deps.audit.append({ ...base, outcome: 'refused', detail: pending })
      return { status: 409, body: { error: pending } }
    }
    const id = jobId()
    let lock
    try { lock = deps.lock.acquire({ source: 'web', kind, actor: who, jobId: id }) }
    catch (err) { return { status: 500, body: { error: `cannot take the build lock: ${err.message}` } } }
    if (!lock.ok) {
      const error = `another task is running: ${managerLock.describe(lock.holder)}`
      deps.audit.append({ ...base, outcome: 'refused', detail: error })
      return { status: 409, body: { error, busy: lock.holder } }
    }
    const job = {
      id, kind, label: spec.label, status: 'running',
      actor: { discordId: actor.discordId, username: actor.username, ip: actor.ip },
      commit: git ? git.head : null, branch: git ? git.branch : null,
      startedAt: new Date().toISOString(), finishedAt: null, result: null,
    }
    try { writeJsonAtomic(jobFile(id), job) }
    catch (err) { lock.release(); return { status: 500, body: { error: `cannot record the job: ${err.message}` } } }
    deps.audit.append({ ...base, outcome: 'started', jobId: id, commit: job.commit })
    running = job
    runJob(job, lock)
    return { status: 202, body: { jobId: id, commit: job.commit } }
  }

  async function runJob(job, lock) {
    let fd = null
    try { fd = fs.openSync(jobLog(job.id), 'a') } catch { /* the result still lands in the job record */ }
    const write = text => { if (fd !== null) { try { fs.writeSync(fd, text) } catch { /* disk full */ } } }
    const b = deps.builder(write)
    let result
    try {
      b.banner(`${job.label} requested by ${job.actor.username} (${job.actor.discordId})${job.commit ? ` at ${job.commit.slice(0, 12)}` : ''}`)
      result = await RUNNERS[job.kind](b, deps)
    } catch (err) {
      result = { ok: false, error: err.message }
    }
    job.status = result && result.ok ? 'ok' : 'failed'
    job.finishedAt = new Date().toISOString()
    job.result = { ok: job.status === 'ok', error: result && result.error ? String(result.error) : undefined }
    // gamemode_extensions is untracked, so the commit alone does not identify the gamemode that shipped
    if (result && result.extensions) job.gamemode = result.extensions
    write(`\n[agent] ${job.kind} ${job.status}${job.result.error ? `: ${job.result.error}` : ''}\n`)
    try { writeJsonAtomic(jobFile(job.id), job) } catch (err) { console.error('[agent] job record write failed:', err.message) }
    if (fd !== null) fs.closeSync(fd)
    lock.release()
    running = null
    deps.audit.append({ actor: { discordId: job.actor.discordId, username: job.actor.username }, ip: job.actor.ip, action: 'job.finish', target: job.kind, jobId: job.id, commit: job.commit, gamemodeSha256: job.gamemode && job.gamemode.sha256, gamemodeFiles: job.gamemode && job.gamemode.files.length, outcome: job.status, detail: job.result.error })
  }

  const routes = [
    ['GET', /^\/health$/, async () => ({ body: { ok: true, pid: process.pid, relayConnected: relay.connected, busy: deps.lock.holder(), running: running && running.id } })],

    ['GET', /^\/services$/, async () => {
      const status = await deps.statusAll()
      return { body: {
        services: config.services.map(s => ({ key: s.key, label: s.label, name: services.resolvedNames[s.key] || s.name, status: status[s.key] || 'unknown', controllable: s.key === 'game' })),
        busy: deps.lock.holder(),
        purgePending: deps.purgePending(),
      } }
    }],

    ['GET', /^\/logs$/, async () => ({ body: { logs: (await logTargets()).map(t => {
      let size = null, mtime = null
      try { const st = fs.statSync(t.file); size = st.size; mtime = st.mtime.toISOString() } catch { /* rotated away */ }
      return { id: t.id, label: t.label, name: path.basename(t.file), size, mtime }
    }) } })],

    ['GET', /^\/logs\/([a-f0-9]{12})$/, async (m, q) => {
      const target = (await logTargets()).find(t => t.id === m[1])
      if (!target) return { status: 404, body: { error: 'unknown log' } }
      const chunk = readChunk(target.file, { from: q.from, before: q.before, max: q.max || LOG_CHUNK })
      return { body: { ...chunk, text: webText(chunk.text), label: target.label } }
    }],

    ['GET', /^\/jobs$/, async (m, q) => ({ body: { jobs: listJobs(q.limit || 50).map(publicJob), busy: deps.lock.holder() } })],

    ['GET', /^\/jobs\/(\d{8}-\d{6}-[a-f0-9]{6})$/, async m => {
      const job = readJson(jobFile(m[1]))
      return job ? { body: publicJob(job) } : { status: 404, body: { error: 'unknown job' } }
    }],

    ['GET', /^\/jobs\/(\d{8}-\d{6}-[a-f0-9]{6})\/log$/, async (m, q) => {
      const job = readJson(jobFile(m[1]))
      if (!job) return { status: 404, body: { error: 'unknown job' } }
      let chunk = { text: '', start: 0, end: 0, size: 0 }
      try { chunk = readChunk(jobLog(job.id), { from: q.from || 0, max: LOG_CHUNK_MAX }) } catch { /* no output yet */ }
      return { body: { ...chunk, text: webText(chunk.text), status: job.status, done: job.status !== 'running' } }
    }],

    ['POST', /^\/jobs$/, async (m, q, body, actor) => {
      if (!body || typeof body !== 'object' || Object.keys(body).some(k => k !== 'kind') || !Object.prototype.hasOwnProperty.call(protocol.JOB_KINDS, body.kind)) {
        return { status: 400, body: { error: 'unknown job kind or options' } }
      }
      const r = await startJob(body.kind, actor)
      return { status: r.status, body: r.body }
    }],

    ['GET', /^\/console$/, async (m, q) => {
      const after = q.after || 0
      return { body: {
        connected: relay.connected,
        last: consoleSeq,
        lines: consoleLines.filter(l => l.seq > after).slice(-500).map(l => ({ ...l, text: webText(l.text) })),
      } }
    }],

    ['POST', /^\/console$/, async (m, q, body, actor) => {
      const parsed = protocol.parseConsoleCommand(body && body.text)
      if (!parsed.ok) {
        deps.audit.append({ actor, ip: actor.ip, action: 'console', outcome: 'refused', detail: parsed.error })
        return { status: 400, body: { error: parsed.error } }
      }
      const r = relay.command(parsed.command)
      deps.audit.append({ actor: { discordId: actor.discordId, username: actor.username }, ip: actor.ip, action: 'console', target: parsed.verb, params: { command: parsed.command }, outcome: r.ok ? 'sent' : 'failed', detail: r.error })
      if (!r.ok) return { status: 502, body: { error: r.error } }
      pushConsole(`> ${parsed.command}   (${actor.username || actor.discordId})`, 'input')
      return { body: { ok: true } }
    }],

    ['GET', /^\/settings\/(serverSettings|backendEnv)$/, async m => {
      if (m[1] === 'serverSettings') {
        const r = readServerSettingsFile()
        return { body: { file: m[1], path: deps.serverSettingsPath(), exists: r.exists, mtimeMs: r.mtimeMs, error: r.error, ...maskSettings('serverSettings', r.settings) } }
      }
      const exists = fs.existsSync(liveEnv.FILE)
      return { body: { file: m[1], path: liveEnv.FILE, exists, ...maskSettings('backendEnv', deps.envValues()) } }
    }],
  ]

  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
    res.end(text)
  }

  function parseQuery(url) {
    const q = {}
    for (const [k, v] of url.searchParams) {
      if (!/^\d{1,15}$/.test(v)) return null
      q[k] = Number(v)
    }
    return q
  }

  async function handle(req, res, port) {
    // Loopback only, and never through a proxy that could forward outside traffic
    if (!protocol.isLoopback(req.socket.remoteAddress) || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) {
      req.socket.destroy()
      return
    }
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || ''))) return sendJson(res, 421, { error: 'bad host' })
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) return sendJson(res, 413, { error: 'body too large' })
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const verified = protocol.verifySigned(deps.secret(), { method: req.method, path: req.url, headers: req.headers, body: raw, nonces })
    if (!verified.ok) {
      deps.audit.append({ action: `agent ${req.method} ${String(req.url).slice(0, 80)}`, outcome: 'denied', detail: verified.error })
      return sendJson(res, verified.status, { error: verified.error })
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    const query = parseQuery(url)
    if (!query) return sendJson(res, 400, { error: 'query values must be integers' })
    let body = null
    if (raw) {
      try { body = JSON.parse(raw) } catch { return sendJson(res, 400, { error: 'invalid JSON' }) }
    }
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname)
      if (!m || method !== req.method) continue
      try {
        const r = await fn(m, query, body, verified.actor)
        return sendJson(res, r.status || 200, r.body)
      } catch (err) {
        return sendJson(res, 500, { error: webText(err.message) })
      }
    }
    sendJson(res, 404, { error: 'not found' })
  }

  function listen(port, host = '127.0.0.1') {
    const server = http.createServer((req, res) => {
      handle(req, res, server.address().port).catch(err => {
        if (!res.headersSent) sendJson(res, 500, { error: webText(err.message) })
      })
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        markInterrupted()
        if (!deps.relay) {
          relay.connect()
          createRestartSchedule({
            at: () => config.autoRestartAt,
            say: text => relay.command(`say ${text}`),
            restart: () => startJob('game.restart', { discordId: 'scheduler', username: 'Daily restart', ip: '127.0.0.1' }),
            gameRunning: async () => (await deps.statusAll()).game === 'SERVICE_RUNNING',
            log: text => { console.log(`[schedule] ${text}`); pushConsole(`[schedule] ${text}`, 'status') },
          }).start()
        }
        resolve(server)
      })
    })
  }

  return { listen, handle, startJob, readChunk, pushConsole, relay, deps }
}

function main() {
  // Services get no user PATH, so the Administrator's npm folder (yarn) comes in through ALDUINAK_EXTRA_PATH
  const extra = String(process.env.ALDUINAK_EXTRA_PATH || '').split(';').filter(Boolean)
  if (extra.length) process.env.PATH = [...extra, process.env.PATH].join(';')
  if (!process.env.ALDUINAK_NO_AUTO_INSTALL) process.env.ALDUINAK_NO_AUTO_INSTALL = '1'
  if (String(config.agent.secret).length < protocol.MIN_SECRET_LENGTH) {
    console.error(`[agent] MANAGER_AGENT_SECRET in skymp5-backend/.env is missing or shorter than ${protocol.MIN_SECRET_LENGTH} characters; every request is refused until it is set`)
  }
  createAgent().listen(config.agent.port).then(server => {
    console.log(`[agent] AlduinakManager listening on http://127.0.0.1:${server.address().port}`)
  }, err => {
    console.error(`[agent] cannot listen on 127.0.0.1:${config.agent.port}: ${err.message}`)
    process.exit(1)
  })
}

if (require.main === module) main()

module.exports = { createAgent, readChunk, readGitState, gitProblem, VERSION_FILES }
