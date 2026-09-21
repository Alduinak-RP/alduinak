'use strict'

// Daily game restart at a local HH:MM with in-game say warnings before it, run by the AlduinakManager agent

const WARN_MINUTES = [60, 30, 10, 5, 4, 3, 2, 1]
const TICK_MS = 20000
const MINUTE = 60000
const BUSY_RETRY_MINUTES = 30

function warningText(lead) {
  const when = lead === 60 ? '1 hour' : `${lead} minute${lead === 1 ? '' : 's'}`
  return `Server restart in ${when}. Please find a safe spot and log out.`
}

// 'HH:MM' to { h, m }; 'off', empty or malformed gives null
function parseAt(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ''))
  if (!m || +m[1] > 23 || +m[2] > 59) return null
  return { h: +m[1], m: +m[2] }
}

function nextTarget({ h, m }, now) {
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// restart() resolves with the agent's startJob reply; a 409 with busy set is retried each minute for 30 minutes
function createRestartSchedule({ at, say, restart, gameRunning, log, now = Date.now }) {
  let cycle = null
  let badText = null
  let ticking = false
  let timer = null

  function newCycle(text, t) {
    const target = nextTarget(parseAt(text), t)
    // Warnings whose time already passed when the cycle starts are skipped, never sent late
    const sent = new Set(WARN_MINUTES.filter(lead => target - lead * MINUTE <= t))
    log(`next daily restart at ${new Date(target).toLocaleString()}`)
    return { text, target, sent, retryAt: null }
  }

  async function attemptRestart(c, t) {
    if (!(await gameRunning())) {
      log('daily restart skipped: the game server is not running')
      return true
    }
    const r = await restart()
    if (r.status === 202) { log(`daily restart started (job ${r.body.jobId})`); return true }
    const error = (r.body && r.body.error) || `status ${r.status}`
    if (r.status === 409 && r.body && r.body.busy && t < c.target + BUSY_RETRY_MINUTES * MINUTE) {
      c.retryAt = t + MINUTE
      log(`daily restart waiting: ${error}`)
      return false
    }
    log(`daily restart not run: ${error}`)
    return true
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const t = now()
      const text = String(at() || '').trim()
      if (!parseAt(text)) {
        if (text && text.toLowerCase() !== 'off' && text !== badText) log(`AUTO_RESTART_AT "${text}" is not HH:MM or off: daily restart disabled`)
        badText = text
        cycle = null
        return
      }
      if (!cycle || cycle.text !== text) cycle = newCycle(text, t)
      const due = WARN_MINUTES.filter(lead => !cycle.sent.has(lead) && t >= cycle.target - lead * MINUTE)
      if (due.length) {
        due.forEach(lead => cycle.sent.add(lead))
        const lead = Math.min(...due)
        const r = say(warningText(lead))
        log(`restart warning (${lead} min)${r && r.ok === false ? ` not sent: ${r.error}` : ''}`)
      }
      if (t < cycle.target || (cycle.retryAt && t < cycle.retryAt)) return
      if (await attemptRestart(cycle, t)) cycle = null
    } catch (err) {
      log(`daily restart error: ${err.message}`)
      if (cycle && now() >= cycle.target) cycle = null
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    start() { if (!timer) { timer = setInterval(tick, TICK_MS); tick() } },
    stop() { clearInterval(timer); timer = null },
  }
}

module.exports = { createRestartSchedule, warningText, parseAt, nextTarget, WARN_MINUTES }
