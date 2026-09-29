'use strict'

// Timed tasks from <agent dir>/schedule.json, run by the agent, or by the Electron manager while no agent heartbeat is fresh

const fs   = require('fs')
const path = require('path')

const WARN_MINUTES = [60, 30, 10, 5, 4, 3, 2, 1]
const TICK_MS = 20000
const MINUTE = 60000
const HOUR = 60 * MINUTE
const BUSY_RETRY_MINUTES = 30
const LATE_MINUTES = 10
const HEARTBEAT_STALE_MS = 90000
const CLAIM_KEEP_MS = 3 * 24 * HOUR
const LOG_KEEP = 30
const MAX_TASKS = 50
const TEXT_MAX = 300
const KINDS = ['restart', 'say', 'command', 'start', 'stop']
const TARGETS = ['live', 'test']
const DEFAULT_TIME_ZONE = 'America/New_York'
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

const scheduleFile = dir => path.join(dir, 'schedule.json')
const heartbeatFile = dir => path.join(dir, 'schedule-runner.json')
const pad2 = n => String(n).padStart(2, '0')

function warningText(lead) {
  const when = lead === 60 ? '1 hour' : `${lead} minute${lead === 1 ? '' : 's'}`
  return `Server restart in ${when}. Please find a safe spot and log out.`
}

// 'HH:MM' to { h, m }; empty or malformed gives null
function parseAt(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ''))
  if (!m || +m[1] > 23 || +m[2] > 59) return null
  return { h: +m[1], m: +m[2] }
}

function seedSchedule() {
  return { timeZone: DEFAULT_TIME_ZONE, tasks: [{ id: 'daily-restart', enabled: true, kind: 'restart', target: 'live', time: '04:00', days: [], message: '', command: '' }] }
}

function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true } catch { return false }
}

const formatters = new Map()
function zoneParts(t, timeZone) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(timeZone, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]))
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second }
}

// How far the zone's wall clock is ahead of UTC at instant t
function zoneOffset(t, timeZone) {
  const p = zoneParts(t, timeZone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000
}

// The instant of a wall-clock time in the zone; a time skipped by a DST change lands just after the gap
function zonedInstant(y, mo, d, h, mi, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  const first = wall - zoneOffset(wall, timeZone)
  const second = wall - zoneOffset(first, timeZone)
  const p = zoneParts(second, timeZone)
  return p.h === h && p.mi === mi ? second : first
}

// Next instant after now at the task's time on one of its days (0 Sunday to 6, none = every day), or null
function nextRun(task, timeZone, now) {
  const at = parseAt(task.time)
  if (!at) return null
  const today = zoneParts(now, timeZone)
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + i))
    if (task.days && task.days.length && !task.days.includes(day.getUTCDay())) continue
    const t = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), at.h, at.m, timeZone)
    if (t > now) return t
  }
  return null
}

function formatAt(t, timeZone) {
  return new Date(t).toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
}

// A schedule checked field by field; throws with the first problem
function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the schedule must be a JSON object')
  const timeZone = raw.timeZone === undefined || raw.timeZone === '' ? DEFAULT_TIME_ZONE : raw.timeZone
  if (!validTimeZone(timeZone)) throw new Error(`unknown time zone "${timeZone}", use an IANA name like America/New_York`)
  if (!Array.isArray(raw.tasks) || raw.tasks.length > MAX_TASKS) throw new Error(`tasks must be a list of at most ${MAX_TASKS}`)
  const ids = new Set()
  const tasks = raw.tasks.map((t, i) => {
    const where = `task ${i + 1}`
    if (!t || typeof t !== 'object') throw new Error(`${where} is not an object`)
    if (!ID_RE.test(String(t.id || '')) || ids.has(t.id)) throw new Error(`${where} needs a unique id of letters, digits, - or _`)
    ids.add(t.id)
    if (!KINDS.includes(t.kind)) throw new Error(`${where}: kind must be one of ${KINDS.join(', ')}`)
    if (!TARGETS.includes(t.target)) throw new Error(`${where}: target must be live or test`)
    const at = parseAt(t.time)
    if (!at) throw new Error(`${where}: time must be HH:MM (24 hour)`)
    const days = t.days === undefined ? [] : t.days
    if (!Array.isArray(days) || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error(`${where}: days are 0 (Sunday) to 6 (Saturday)`)
    const text = key => {
      const v = String(t[key] ?? '').trim()
      if (v.length > TEXT_MAX || /[\r\n]/.test(v)) throw new Error(`${where}: ${key} must be one line of at most ${TEXT_MAX} characters`)
      return v
    }
    const message = text('message')
    const command = text('command')
    if (t.kind === 'say' && !message) throw new Error(`${where}: a say task needs a message`)
    if (t.kind === 'command' && !command) throw new Error(`${where}: a command task needs a command`)
    return { id: t.id, enabled: t.enabled !== false, kind: t.kind, target: t.target, time: `${pad2(at.h)}:${pad2(at.m)}`, days: [...new Set(days)].sort((a, b) => a - b), message, command }
  })
  return { timeZone, tasks }
}

// { schedule, exists, error }: a missing file gives the seed, an unreadable or invalid one no tasks
function readSchedule(file) {
  const none = { timeZone: DEFAULT_TIME_ZONE, tasks: [] }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return { schedule: seedSchedule(), exists: false, error: null }
    return { schedule: none, exists: true, error: `cannot read ${file}: ${err.message}` }
  }
  try { return { schedule: normalizeSchedule(JSON.parse(text.replace(/^﻿/, ''))), exists: true, error: null } }
  catch (err) { return { schedule: none, exists: true, error: `${file} is not valid, no task runs: ${err.message}` } }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(file + '.tmp', file)
}

function writeSchedule(file, raw) {
  const schedule = normalizeSchedule(raw)
  writeJsonAtomic(file, schedule)
  return schedule
}

function readHeartbeat(dir) {
  try { return JSON.parse(fs.readFileSync(heartbeatFile(dir), 'utf8')) } catch { return null }
}

const heartbeatFresh = (hb, now = Date.now()) => !!hb && now - Date.parse(hb.at) < HEARTBEAT_STALE_MS

function agentActive(dir, now = Date.now()) {
  const hb = readHeartbeat(dir)
  return !!hb && hb.source === 'agent' && heartbeatFresh(hb, now)
}

// The instant of the last heartbeat any runner wrote, or null
function lastBeatAt(dir) {
  const hb = readHeartbeat(dir)
  const at = hb ? Date.parse(hb.at) : NaN
  return Number.isFinite(at) ? at : null
}

function writeHeartbeat(dir, source, log) {
  writeJsonAtomic(heartbeatFile(dir), { source, pid: process.pid, at: new Date().toISOString(), log })
}

// One runner per occurrence and per restart warning: the first to create its marker runs it
function claimRun(dir, id, at) {
  const runs = path.join(dir, 'schedule-runs')
  fs.mkdirSync(runs, { recursive: true })
  for (const name of fs.readdirSync(runs)) {
    if (!(Number(name.split('@')[1]) > Date.now() - CLAIM_KEEP_MS)) fs.rmSync(path.join(runs, name), { force: true })
  }
  try { fs.closeSync(fs.openSync(path.join(runs, `${id}@${at}`), 'wx')); return true }
  catch (err) { if (err.code === 'EEXIST') return false; throw err }
}

function describe(task) {
  const what = task.kind === 'say' ? `say "${task.message}"` : task.kind === 'command' ? `command "${task.command}"` : task.kind
  return `${what} on ${task.target} (${task.id})`
}

// act: say(target, text) and command(target, text) -> { ok, error }, service(target, verb) -> Promise<{ ok, busy, error, detail }>, gameRunning(target) -> Promise<bool>; lastBeat() -> ms or null
function createScheduler({ read, act, log, active = () => true, claim = () => true, beat = () => {}, lastBeat = () => null, now = Date.now }) {
  const cycles = new Map()
  const recent = []
  let lastError = null
  let ticking = false
  let timer = null
  let wasActive = false

  function note(text) {
    recent.push(`${new Date(now()).toISOString()} ${text}`)
    if (recent.length > LOG_KEEP) recent.shift()
    log(text)
  }

  function newCycle(task, timeZone, sig, t, resumeFrom) {
    // Taking over within the late grace of the last runner's heartbeat, an occurrence due since that beat still runs unless it was claimed
    const from = resumeFrom !== null && t - resumeFrom <= LATE_MINUTES * MINUTE ? Math.min(t, resumeFrom - TICK_MS) : t
    const target = nextRun(task, timeZone, from)
    if (target === null) return null
    // Warnings whose time already passed when the cycle starts are skipped, never sent late
    return { sig, target, sent: new Set(WARN_MINUTES.filter(lead => target - lead * MINUTE <= t)), retryAt: null, claimed: false }
  }

  // true when the occurrence is finished, false to retry a minute later
  async function run(task, c, t) {
    if (task.kind === 'say' || task.kind === 'command') {
      const r = task.kind === 'say' ? act.say(task.target, task.message) : act.command(task.target, task.command)
      note(`${describe(task)}${r && r.ok === false ? ` not sent: ${r.error}` : ' sent'}`)
      return true
    }
    if (task.kind === 'restart' && !(await act.gameRunning(task.target))) {
      note(`${describe(task)} skipped: the game server is not running`)
      return true
    }
    const r = await act.service(task.target, task.kind)
    if (r.ok) { note(`${describe(task)} done${r.detail ? ` (${r.detail})` : ''}`); return true }
    if (r.busy && t < c.target + BUSY_RETRY_MINUTES * MINUTE) {
      c.retryAt = t + MINUTE
      note(`${describe(task)} waiting: ${r.error}`)
      return false
    }
    note(`${describe(task)} not run: ${r.error}`)
    return true
  }

  async function step(task, timeZone, t, resumeFrom) {
    const sig = JSON.stringify([task.kind, task.target, task.time, task.days, task.message, task.command, timeZone])
    let c = cycles.get(task.id)
    // A DST change between now and the target moves it; recomputed only before the warnings start
    if (c && c.sig === sig && t < c.target - HOUR && nextRun(task, timeZone, t) !== c.target) c = null
    if (!c || c.sig !== sig) {
      c = newCycle(task, timeZone, sig, t, resumeFrom)
      if (!c) { cycles.delete(task.id); return }
      cycles.set(task.id, c)
      const late = c.target <= t
      note(`${late ? 'catching up' : 'next'} ${describe(task)} ${late ? 'due at' : 'at'} ${formatAt(c.target, timeZone)}`)
    }
    if (task.kind === 'restart') {
      const due = WARN_MINUTES.filter(lead => !c.sent.has(lead) && t >= c.target - lead * MINUTE)
      if (due.length) {
        due.forEach(lead => c.sent.add(lead))
        const lead = Math.min(...due)
        // Claimed like the run, so a second runner never repeats a warning
        if (claim(`${task.id}.warn${lead}`, c.target)) {
          const r = act.say(task.target, warningText(lead))
          note(`restart warning (${lead} min) on ${task.target}${r && r.ok === false ? ` not sent: ${r.error}` : ''}`)
        }
      }
    }
    if (t < c.target || (c.retryAt && t < c.retryAt)) return
    let done = true
    if (c.claimed) done = await run(task, c, t)
    else if (t > c.target + LATE_MINUTES * MINUTE) note(`${describe(task)} skipped: its time passed more than ${LATE_MINUTES} minutes ago`)
    else if (claim(task.id, c.target)) { c.claimed = true; done = await run(task, c, t) }
    if (done) cycles.delete(task.id)
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      if (!active()) { cycles.clear(); wasActive = false; return }
      const t = now()
      const resumeFrom = wasActive ? null : lastBeat()
      wasActive = true
      const { schedule, error } = read()
      if (error && error !== lastError) note(error)
      lastError = error
      const enabled = schedule.tasks.filter(task => task.enabled)
      for (const id of cycles.keys()) if (!enabled.some(task => task.id === id)) cycles.delete(id)
      for (const task of enabled) {
        try { await step(task, schedule.timeZone, t, resumeFrom) } catch (err) { note(`${describe(task)} error: ${err.message}`); cycles.delete(task.id) }
      }
      beat(recent.slice())
    } catch (err) {
      note(`schedule error: ${err.message}`)
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    recent: () => recent.slice(),
    start() { if (!timer) { timer = setInterval(tick, TICK_MS); tick() } },
    stop() { clearInterval(timer); timer = null },
  }
}

module.exports = {
  WARN_MINUTES, KINDS, TARGETS, DEFAULT_TIME_ZONE, HEARTBEAT_STALE_MS,
  warningText, parseAt, seedSchedule, validTimeZone, nextRun, formatAt, normalizeSchedule,
  scheduleFile, readSchedule, writeSchedule, readHeartbeat, heartbeatFresh, agentActive, lastBeatAt, writeHeartbeat, claimRun, createScheduler,
}
