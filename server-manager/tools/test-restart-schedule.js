'use strict'

// The daily restart schedule on a fake clock: warnings, skipped late warnings, busy retries and refusals: node tools/test-restart-schedule.js

const assert = require('node:assert/strict')
const { createRestartSchedule, warningText, parseAt } = require('../src/restartSchedule')

const MINUTE = 60000

function harness({ start, at = '04:00', running = true, replies = [] }) {
  const clock = { t: start }
  const said = []
  const restarts = []
  const logs = []
  const s = createRestartSchedule({
    at: () => at,
    say: text => { said.push(text); return { ok: true } },
    restart: async () => { restarts.push(clock.t); return replies.shift() || { status: 202, body: { jobId: 'j' } } },
    gameRunning: async () => running,
    log: text => logs.push(text),
    now: () => clock.t,
  })
  const run = async (until, step = 20000) => { while (clock.t <= until) { await s.tick(); clock.t += step } }
  return { clock, said, restarts, logs, run }
}

const day = (h, m) => new Date(2026, 8, 22, h, m, 0, 0).getTime()

async function main() {
  assert.deepEqual(parseAt('04:00'), { h: 4, m: 0 })
  assert.equal(parseAt('off'), null)
  assert.equal(parseAt('24:00'), null)
  assert.equal(warningText(60), 'Server restart in 1 hour. Please find a safe spot and log out.')
  assert.equal(warningText(1), 'Server restart in 1 minute. Please find a safe spot and log out.')
  assert.equal(warningText(5), 'Server restart in 5 minutes. Please find a safe spot and log out.')

  // Full evening: every warning once, in order, then one restart at 04:00
  let h = harness({ start: day(2, 30) })
  await h.run(day(4, 5))
  assert.deepEqual(h.said, [60, 30, 10, 5, 4, 3, 2, 1].map(warningText))
  assert.deepEqual(h.restarts, [day(4, 0)])

  // Started inside the window: past warnings are skipped, never sent late
  h = harness({ start: day(3, 52) })
  await h.run(day(4, 1))
  assert.deepEqual(h.said, [5, 4, 3, 2, 1].map(warningText))
  assert.equal(h.restarts.length, 1)

  // Busy lock: retried each minute until the job starts
  const busy = { status: 409, body: { error: 'another task is running', busy: { kind: 'build.server' } } }
  h = harness({ start: day(3, 59), replies: [busy, busy] })
  await h.run(day(4, 10))
  assert.deepEqual(h.restarts, [day(4, 0), day(4, 1), day(4, 2)])

  // A pending purge is refused once, never retried
  h = harness({ start: day(3, 59), replies: [{ status: 409, body: { error: 'refused: a MongoDB purge is pending' } }] })
  await h.run(day(4, 10))
  assert.equal(h.restarts.length, 1)

  // Game stopped by hand: warnings still go out, no restart
  h = harness({ start: day(3, 58), running: false })
  await h.run(day(4, 5))
  assert.equal(h.restarts.length, 0)

  // off: nothing at all
  h = harness({ start: day(2, 30), at: 'off' })
  await h.run(day(4, 5))
  assert.equal(h.said.length + h.restarts.length, 0)

  console.log('restart schedule: all checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
