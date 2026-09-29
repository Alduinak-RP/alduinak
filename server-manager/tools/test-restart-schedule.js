'use strict'

// The task schedule on a fake clock: time zones and DST, warnings, busy retries, refusals, say and command tasks, claims, runner hand-over and file validation: node tools/test-restart-schedule.js

const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const S = require('../src/restartSchedule')

const MINUTE = 60000
const NY = 'America/New_York'
// 2026-09-22 is a Tuesday; New York is on EDT (UTC-4) then
const utc = (h, m, d = 22, mo = 9) => Date.UTC(2026, mo - 1, d, h, m)
const task = over => ({ id: 't1', enabled: true, kind: 'restart', target: 'live', time: '04:00', days: [], message: '', command: '', ...over })

function harness({ start, tasks = [task()], timeZone = NY, running = true, replies = [], claim = () => true, active = () => true, lastBeat = () => null }) {
  const clock = { t: start }
  const said = []
  const commands = []
  const services = []
  const logs = []
  const s = S.createScheduler({
    read: () => ({ schedule: { timeZone, tasks } }),
    act: {
      say: (target, text) => { said.push([target, text]); return { ok: true } },
      command: (target, text) => { commands.push([target, text, clock.t]); return { ok: true } },
      service: async (target, verb) => { services.push([target, verb, clock.t]); return replies.shift() || { ok: true } },
      gameRunning: async () => running,
    },
    claim,
    active,
    lastBeat,
    log: text => logs.push(text),
    now: () => clock.t,
  })
  const run = async (until, step = 20000) => { while (clock.t <= until) { await s.tick(); clock.t += step } }
  return { clock, said, commands, services, logs, run, tick: () => s.tick() }
}

async function main() {
  assert.deepEqual(S.parseAt('04:00'), { h: 4, m: 0 })
  assert.equal(S.parseAt('24:00'), null)
  assert.equal(S.warningText(60), 'Server restart in 1 hour. Please find a safe spot and log out.')
  assert.equal(S.warningText(1), 'Server restart in 1 minute. Please find a safe spot and log out.')

  // 04:00 in New York, whatever the box's own zone, across both DST changes
  assert.equal(S.nextRun(task(), NY, utc(7, 0)), utc(8, 0))
  assert.equal(S.nextRun(task(), NY, utc(8, 0)), utc(8, 0, 23))
  assert.equal(S.nextRun(task(), NY, utc(12, 0, 31, 10)), utc(9, 0, 1, 11))
  assert.equal(S.nextRun(task({ time: '02:30' }), NY, utc(0, 0, 8, 3)), utc(7, 30, 8, 3))
  assert.equal(S.nextRun(task(), 'UTC', utc(7, 0)), utc(4, 0, 23))
  // Days: a Saturday-only task seen on Tuesday runs on Saturday the 26th
  assert.equal(S.nextRun(task({ days: [6] }), NY, utc(7, 0)), utc(8, 0, 26))
  // A weekly task whose hour passed today comes back in a week
  assert.equal(S.nextRun(task({ days: [2] }), NY, utc(9, 0)), utc(8, 0, 29))

  // Full evening: every warning once, in order, on the task's server, then one restart at 04:00 New York
  let h = harness({ start: utc(6, 30) })
  await h.run(utc(8, 5))
  assert.deepEqual(h.said, S.WARN_MINUTES.map(lead => ['live', S.warningText(lead)]))
  assert.deepEqual(h.services, [['live', 'restart', utc(8, 0)]])

  // Started inside the window: past warnings are skipped, never sent late
  h = harness({ start: utc(7, 52) })
  await h.run(utc(8, 1))
  assert.deepEqual(h.said.map(s => s[1]), [5, 4, 3, 2, 1].map(S.warningText))
  assert.equal(h.services.length, 1)

  // Busy lock: retried each minute until the task runs
  const busy = { ok: false, busy: true, error: 'another task is running' }
  h = harness({ start: utc(7, 59), replies: [busy, busy] })
  await h.run(utc(8, 10))
  assert.deepEqual(h.services.map(s => s[2]), [utc(8, 0), utc(8, 1), utc(8, 2)])

  // A pending purge is refused once, never retried
  h = harness({ start: utc(7, 59), replies: [{ ok: false, error: 'refused: a MongoDB purge is pending' }] })
  await h.run(utc(8, 10))
  assert.equal(h.services.length, 1)

  // Game stopped by hand: warnings still go out, no restart
  h = harness({ start: utc(7, 58), running: false })
  await h.run(utc(8, 5))
  assert.equal(h.services.length, 0)
  assert.ok(h.said.length > 0)

  // Disabled: nothing at all
  h = harness({ start: utc(6, 30), tasks: [task({ enabled: false })] })
  await h.run(utc(8, 5))
  assert.equal(h.said.length + h.services.length, 0)

  // Say, command, start and stop on the test server run once at their time, without warnings
  h = harness({ start: utc(13, 58), tasks: [
    task({ id: 'a', kind: 'say', target: 'test', time: '10:00', message: 'Hello' }),
    task({ id: 'b', kind: 'command', target: 'test', time: '10:01', command: 'status' }),
    task({ id: 'c', kind: 'stop', target: 'test', time: '10:02' }),
    task({ id: 'd', kind: 'start', target: 'test', time: '10:03' }),
  ] })
  await h.run(utc(14, 10))
  assert.deepEqual(h.said, [['test', 'Hello']])
  assert.deepEqual(h.commands, [['test', 'status', utc(14, 1)]])
  assert.deepEqual(h.services, [['test', 'stop', utc(14, 2)], ['test', 'start', utc(14, 3)]])

  // Another runner claimed the occurrence and its warnings: nothing is repeated
  h = harness({ start: utc(7, 59), claim: () => false })
  await h.run(utc(8, 5))
  assert.equal(h.services.length + h.said.length, 0)

  // Two runners sharing the claims (two open managers, or the agent and the app at a hand-over): each warning and the restart go out once
  const store = new Set()
  const shared = (id, at) => !store.has(`${id}@${at}`) && !!store.add(`${id}@${at}`)
  const a = harness({ start: utc(6, 30), claim: shared })
  const b = harness({ start: utc(6, 30), claim: shared })
  for (let t = utc(6, 30); t <= utc(8, 5); t += 20000) { a.clock.t = b.clock.t = t; await b.tick(); await a.tick() }
  assert.deepEqual([...a.said, ...b.said].map(s => s[1]).sort(), S.WARN_MINUTES.map(S.warningText).sort())
  assert.equal(a.services.length + b.services.length, 1)

  // Inactive (the agent runs it): nothing; taking over mid-window skips the passed warnings
  let on = false
  h = harness({ start: utc(7, 0), active: () => on })
  await h.run(utc(7, 56))
  assert.equal(h.said.length, 0)
  on = true
  await h.run(utc(8, 1))
  assert.deepEqual(h.said.map(s => s[1]), [3, 2, 1].map(S.warningText))
  assert.equal(h.services.length, 1)

  // Taking over after the target from a runner whose heartbeat stopped just before it: the occurrence still runs, once, without late warnings
  on = false
  h = harness({ start: utc(7, 59), active: () => on, lastBeat: () => utc(7, 58) + 50000 })
  await h.run(utc(8, 0))
  on = true
  await h.run(utc(8, 5))
  assert.deepEqual(h.services, [['live', 'restart', utc(8, 0) + 20000]])
  assert.equal(h.said.length, 0)

  // The previous runner had claimed it: not repeated, and the next cycle is the next day
  h = harness({ start: utc(8, 0) + 20000, lastBeat: () => utc(7, 59) + 40000, claim: (id, at) => at !== utc(8, 0) })
  await h.run(utc(8, 10))
  assert.equal(h.services.length, 0)
  assert.deepEqual(h.logs.filter(l => /^next /.test(l)).length, 1)

  // A heartbeat older than the late grace (the manager was closed): a missed occurrence waits for its next time
  h = harness({ start: utc(8, 5), lastBeat: () => utc(2, 0) })
  await h.run(utc(8, 10))
  assert.equal(h.services.length, 0)

  // An edit to the time moves the pending occurrence
  const tasks = [task()]
  h = harness({ start: utc(6, 0), tasks })
  await h.run(utc(6, 1))
  tasks[0] = task({ time: '03:00' })
  await h.run(utc(7, 5))
  assert.deepEqual(h.services.map(s => s[2]), [utc(7, 0)])

  // Validation and the file
  assert.throws(() => S.normalizeSchedule({ timeZone: 'Mars/Base', tasks: [] }), /unknown time zone/)
  assert.throws(() => S.normalizeSchedule({ tasks: [task({ time: '4pm' })] }), /HH:MM/)
  assert.throws(() => S.normalizeSchedule({ tasks: [task(), task()] }), /unique id/)
  assert.throws(() => S.normalizeSchedule({ tasks: [task({ kind: 'say' })] }), /needs a message/)
  assert.throws(() => S.normalizeSchedule({ tasks: [task({ kind: 'command', command: 'a\nb' })] }), /one line/)
  assert.throws(() => S.normalizeSchedule({ tasks: [task({ target: 'prod' })] }), /live or test/)
  assert.deepEqual(S.normalizeSchedule({ tasks: [task({ time: '4:05', days: [5, 1, 5] })] }).tasks[0], task({ time: '04:05', days: [1, 5] }))
  assert.equal(S.normalizeSchedule({ tasks: [] }).timeZone, NY)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-test-'))
  try {
    const file = S.scheduleFile(dir)
    let r = S.readSchedule(file)
    assert.equal(r.exists, false)
    assert.deepEqual(r.schedule, S.seedSchedule())
    assert.deepEqual(r.schedule.tasks.map(t => [t.kind, t.target, t.time, t.enabled]), [['restart', 'live', '04:00', true]])
    fs.writeFileSync(file, '{ not json')
    r = S.readSchedule(file)
    assert.equal(r.schedule.tasks.length, 0)
    assert.match(r.error, /not valid/)
    S.writeSchedule(file, { timeZone: 'UTC', tasks: [task({ kind: 'say', message: ' Hi ' })] })
    r = S.readSchedule(file)
    assert.equal(r.error, null)
    assert.equal(r.schedule.tasks[0].message, 'Hi')

    const soon = Date.now() + MINUTE
    assert.equal(S.claimRun(dir, 't1', soon), true)
    assert.equal(S.claimRun(dir, 't1', soon), false)
    assert.equal(S.claimRun(dir, 't2', soon), true)
    assert.equal(S.claimRun(dir, 't1.warn5', soon), true)
    assert.equal(S.claimRun(dir, 't1.warn5', soon), false)
    assert.equal(S.agentActive(dir), false)
    S.writeHeartbeat(dir, 'app', [])
    assert.equal(S.agentActive(dir), false)
    S.writeHeartbeat(dir, 'agent', ['x'])
    assert.equal(S.agentActive(dir), true)
    assert.equal(S.agentActive(dir, Date.now() + S.HEARTBEAT_STALE_MS + 1000), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('schedule: all checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
