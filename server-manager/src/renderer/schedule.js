'use strict'
// Schedule tab: timed restarts with warnings, say, console commands, start and stop per game server; edits apply on Save

const DAY_NAMES = [loc('schedule.day.sun'), loc('schedule.day.mon'), loc('schedule.day.tue'), loc('schedule.day.wed'), loc('schedule.day.thu'), loc('schedule.day.fri'), loc('schedule.day.sat')]
const TASK_KINDS = [['restart', loc('schedule.kind.restart')], ['say', loc('schedule.kind.say')], ['command', loc('schedule.kind.command')], ['start', loc('schedule.kind.start')], ['stop', loc('schedule.kind.stop')]]
const TASK_TARGETS = [['live', loc('servers.main')], ['test', loc('servers.test')]]
const TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC']
let sched = { timeZone: 'America/New_York', tasks: [] }
let schedNext = {}
let schedDirty = false

const schedStatus = text => { $('#schedule-status').textContent = text }
const newTaskId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

function schedChanged() {
  schedDirty = true
  schedStatus(loc('schedule.unsaved'))
}

function paintRunner(r) {
  const box = $('#schedule-runner')
  if (r.runner === 'agent') {
    box.className = 'sched-runner ok'
    box.textContent = loc('schedule.runnerAgent', { time: new Date(r.beatAt).toLocaleTimeString() })
  } else {
    const svc = /^SERVICE_/.test(r.agentService || '')
      ? loc('schedule.agentSilent', { state: r.agentService.replace('SERVICE_', '').toLowerCase() })
      : loc('schedule.agentMissing')
    box.className = 'sched-runner warn'
    box.textContent = loc('schedule.runnerApp', { reason: svc })
  }
  const log = $('#schedule-log')
  log.textContent = (r.log || []).join('\n')
  log.scrollTop = log.scrollHeight
}

function taskRow(t, i) {
  const tr = el('tr')
  const cell = node => { const td = el('td'); td.appendChild(node); tr.appendChild(td); return node }
  const on = cell(el('input', { type: 'checkbox', checked: t.enabled, title: loc('schedule.enabled') }))
  on.addEventListener('change', () => { t.enabled = on.checked; schedChanged() })
  const kind = cell(el('select'))
  for (const [k, label] of TASK_KINDS) kind.appendChild(el('option', { value: k, selected: k === t.kind }, esc(label)))
  kind.addEventListener('change', () => { t.kind = kind.value; schedChanged(); renderSchedule() })
  const target = cell(el('select'))
  for (const [k, label] of TASK_TARGETS) target.appendChild(el('option', { value: k, selected: k === t.target }, esc(label)))
  target.addEventListener('change', () => { t.target = target.value; schedChanged() })
  const time = cell(el('input', { type: 'time', value: t.time }))
  time.addEventListener('change', () => { t.time = time.value; schedChanged() })
  const days = cell(el('div', { className: 'sched-days', title: loc('schedule.everyDay') }))
  DAY_NAMES.forEach((name, d) => {
    const box = el('input', { type: 'checkbox', checked: t.days.includes(d) })
    box.addEventListener('change', () => {
      t.days = DAY_NAMES.map((_, x) => x).filter(x => (x === d ? box.checked : t.days.includes(x)))
      schedChanged()
    })
    const label = days.appendChild(el('label', { className: 'chk' }))
    label.append(box, name)
  })
  const key = t.kind === 'say' ? 'message' : t.kind === 'command' ? 'command' : null
  const hint = key === 'message' ? loc('schedule.messageHint') : key === 'command' ? loc('schedule.commandHint') : ''
  const text = cell(el('input', { type: 'text', value: key ? t[key] : '', disabled: !key, placeholder: hint }))
  text.addEventListener('input', () => { t[key] = text.value; schedChanged() })
  cell(el('span', { className: 'muted sched-next' }, esc(t.enabled ? (schedNext[t.id] || loc('schedule.afterSave')) : loc('schedule.disabled'))))
  const del = cell(el('button', { className: 'action small stop', title: loc('schedule.deleteTask') }, '✕'))
  del.addEventListener('click', () => { sched.tasks.splice(i, 1); schedChanged(); renderSchedule() })
  return tr
}

function renderSchedule() {
  $('#schedule-tz').value = sched.timeZone
  const body = $('#schedule-tasks')
  body.innerHTML = ''
  if (!sched.tasks.length) body.appendChild(el('tr', {}, `<td colspan="8" class="muted">${esc(loc('schedule.none'))}</td>`))
  sched.tasks.forEach((t, i) => body.appendChild(taskRow(t, i)))
}

function applySchedule(r) {
  if (!r.ok) { schedStatus(loc('common.error', { error: r.error })); return }
  sched = r.schedule
  schedNext = r.next || {}
  schedDirty = false
  $('#schedule-file').textContent = r.file
  renderSchedule()
  paintRunner(r)
  schedStatus(r.error ? loc('common.error', { error: r.error }) : r.exists ? '' : loc('schedule.noFile'))
}

async function loadSchedule() {
  schedStatus(loc('common.loadingCap'))
  applySchedule(await window.mgr.scheduleRead())
}

for (const zone of TIME_ZONES) $('#schedule-tz-list').appendChild(el('option', { value: zone }))
$('#schedule-tz').addEventListener('change', () => { sched.timeZone = $('#schedule-tz').value.trim(); schedChanged() })
$('#schedule-add').addEventListener('click', () => {
  sched.tasks.push({ id: newTaskId(), enabled: true, kind: 'say', target: 'live', time: '12:00', days: [], message: '', command: '' })
  schedChanged()
  renderSchedule()
})
$('#schedule-reload').addEventListener('click', loadSchedule)
$('#schedule-save').addEventListener('click', async () => {
  schedStatus(loc('schedule.saving'))
  const r = await window.mgr.scheduleSave(sched)
  if (!r.ok) { schedStatus(loc('schedule.notSaved', { error: r.error })); return }
  applySchedule(r)
  schedStatus(loc('schedule.saved'))
})

document.addEventListener('tab-shown', e => { if (e.detail === 'schedule' && !schedDirty) loadSchedule() })
setInterval(async () => {
  if (activeTab() !== 'schedule') return
  const r = await window.mgr.scheduleRead()
  if (r.ok) paintRunner(r)
}, 15000)
