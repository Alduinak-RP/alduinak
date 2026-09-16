'use strict'

// Cross-process busy lock so the Electron manager and the AlduinakManager agent never build or sync at once

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const config = require('./config')

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)
const startTimes = new Map() // pid -> { at, value }

function lockFile() {
  return path.join(config.agent.dir, 'busy.lock')
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// Windows reuses pids, so a live pid only counts while its start time matches the lock's
function processStartTime(pid) {
  const cached = startTimes.get(pid)
  if (cached && Date.now() - cached.at < 30000) return cached.value
  let value = null
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { windowsHide: true, timeout: 10000, encoding: 'utf8' })
    const t = Date.parse(out.trim())
    value = Number.isFinite(t) ? t : null
  } catch { value = null }
  startTimes.set(pid, { at: Date.now(), value })
  return value
}

function isStale(holder, mtimeMs) {
  if (!holder) return Date.now() - mtimeMs > 10000 // writer died between creating and filling the file
  if (!Number.isInteger(holder.pid)) return true
  if (holder.pid === process.pid) return holder.procStart !== PROCESS_STARTED_AT
  if (!isAlive(holder.pid)) return true
  if (process.platform !== 'win32' || !holder.procStart) return false
  const started = processStartTime(holder.pid)
  return started !== null && Math.abs(started - holder.procStart) > 5000
}

/** { raw, record, mtimeMs } of a lock file, or null when it does not exist. */
function readLock(file) {
  let raw, stat
  try {
    stat = fs.statSync(file)
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let record = null
  try { record = JSON.parse(raw) } catch { /* partially written */ }
  return { raw, record, mtimeMs: stat.mtimeMs }
}

/** The live holder record, or null when free or stale; never removes anything, so polling cannot race a locker. */
function holder() {
  let seen = null
  try { seen = readLock(lockFile()) } catch { /* being released right now */ }
  if (!seen || isStale(seen.record, seen.mtimeMs)) return null
  return seen.record || { kind: 'unknown' }
}

// Moves the lock aside before deleting it, and puts it back when it is no longer the stale lock that was checked
function clearStale(file, seen) {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`
  try { fs.renameSync(file, aside) } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  const moved = readLock(aside)
  if (!moved || moved.raw !== seen.raw || moved.mtimeMs !== seen.mtimeMs) {
    try { fs.copyFileSync(aside, file, fs.constants.COPYFILE_EXCL) } catch { /* a newer lock already took its place */ }
  }
  fs.rmSync(aside, { force: true })
}

function describe(h) {
  return `${h.kind || 'a task'} (${h.source || 'unknown'}${h.actor ? `, ${h.actor}` : ''}, since ${h.startedAt || '?'})`
}

/** { ok: true, record, release } or { ok: false, holder }. */
function acquire({ source, kind, actor = '', jobId = null }) {
  const file = lockFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd
    try { fd = fs.openSync(file, 'wx') }
    catch (err) {
      if (err.code !== 'EEXIST') throw err
      const seen = readLock(file)
      if (seen && !isStale(seen.record, seen.mtimeMs)) return { ok: false, holder: seen.record || { kind: 'unknown' } }
      if (seen) clearStale(file, seen)
      continue
    }
    const record = { pid: process.pid, procStart: PROCESS_STARTED_AT, source, kind, actor, jobId, startedAt: new Date().toISOString() }
    try { fs.writeSync(fd, JSON.stringify(record)) } finally { fs.closeSync(fd) }
    let released = false
    const release = () => {
      if (released) return
      released = true
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (current.pid === record.pid && current.startedAt === record.startedAt) fs.unlinkSync(file)
      } catch { /* already gone */ }
    }
    return { ok: true, record, release }
  }
  return { ok: false, holder: holder() || { kind: 'unknown' } }
}

module.exports = { acquire, holder, describe, clearStale, readLock }
