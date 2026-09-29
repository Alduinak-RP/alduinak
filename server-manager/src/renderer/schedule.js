'use strict'
// Schedule tab: timed restarts with warnings, say, console commands, start and stop per game server; edits apply on Save

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TASK_KINDS = [['restart', 'Restart'], ['say', 'Say'], ['command', 'Console command'], ['start', 'Start'], ['stop', 'Stop']]
const TASK_TARGETS = [['live', 'Main Server'], ['test', 'Test Server']]
const TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC']
let sched = { timeZone: 'America/New_York', tasks: [] }
let schedNext = {}
let schedDirty = false

const schedStatus = text => { $('#schedule-status').textContent = text }
const newTaskId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

function schedChanged() {
  schedDirty = true
  schedStatus('Unsaved changes')
}

function paintRunner(r) {
  const box = $('#schedule-runner')
  if (r.runner === 'agent') {
    box.className = 'sched-runner ok'
    box.textContent = `Runner: the AlduinakManager service (last report ${new Date(r.beatAt).toLocaleTimeString()}). Tasks run whether or not this app is open.`
  } else {
    const svc = /^SERVICE_/.test(r.agentService || '')
      ? `the AlduinakManager service is ${r.agentService.replace('SERVICE_', '').toLowerCase()} but not reporting (restart it after updating server-manager/src)`
      : 'the AlduinakManager service is not installed (server-manager/Setup-Agent.bat, see docs/docs_web_server_manager.md)'
    box.className = 'sched-runner warn'
    box.textContent = `Runner: only this app. Tasks run only while the Server Manager is open, because ${svc}.`
  }
  const log = $('#schedule-log')
  log.textContent = (r.log || []).join('\n')
  log.scrollTop = log.scrollHeight
}

function taskRow(t, i) {
  const tr = el('tr')
  const cell = node => { const td = el('td'); td.appendChild(node); tr.appendChild(td); return node }
  const on = cell(el('input', { type: 'checkbox', checked: t.enabled, title: 'Enabled' }))
  on.addEventListener('change', () => { t.enabled = on.checked; schedChanged() })
  const kind = cell(el('select'))
  for (const [k, label] of TASK_KINDS) kind.appendChild(el('option', { value: k, selected: k === t.kind }, esc(label)))
  kind.addEventListener('change', () => { t.kind = kind.value; schedChanged(); renderSchedule() })
  const target = cell(el('select'))
  for (const [k, label] of TASK_TARGETS) target.appendChild(el('option', { value: k, selected: k === t.target }, esc(label)))
  target.addEventListener('change', () => { t.target = target.value; schedChanged() })
  const time = cell(el('input', { type: 'time', value: t.time }))
  time.addEventListener('change', () => { t.time = time.value; schedChanged() })
  const days = cell(el('div', { className: 'sched-days', title: 'No day ticked runs it every day' }))
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
  const hint = key === 'message' ? 'Message to broadcast' : key === 'command' ? 'Game console command, as in the Console tab' : ''
  const text = cell(el('input', { type: 'text', value: key ? t[key] : '', disabled: !key, placeholder: hint }))
  text.addEventListener('input', () => { t[key] = text.value; schedChanged() })
  cell(el('span', { className: 'muted sched-next' }, esc(t.enabled ? (schedNext[t.id] || 'after Save') : 'disabled')))
  const del = cell(el('button', { className: 'action small stop', title: 'Delete task' }, '✕'))
  del.addEventListener('click', () => { sched.tasks.splice(i, 1); schedChanged(); renderSchedule() })
  return tr
}

function renderSchedule() {
  $('#schedule-tz').value = sched.timeZone
  const body = $('#schedule-tasks')
  body.innerHTML = ''
  if (!sched.tasks.length) body.appendChild(el('tr', {}, '<td colspan="8" class="muted">No tasks. Add one.</td>'))
  sched.tasks.forEach((t, i) => body.appendChild(taskRow(t, i)))
}

function applySchedule(r) {
  if (!r.ok) { schedStatus(`Error: ${r.error}`); return }
  sched = r.schedule
  schedNext = r.next || {}
  schedDirty = false
  $('#schedule-file').textContent = r.file
  renderSchedule()
  paintRunner(r)
  schedStatus(r.error ? `Error: ${r.error}` : r.exists ? '' : 'No schedule.json yet: showing the default daily restart, which runs until you save your own.')
}

async function loadSchedule() {
  schedStatus('Loading…')
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
  schedStatus('Saving…')
  const r = await window.mgr.scheduleSave(sched)
  if (!r.ok) { schedStatus(`Not saved: ${r.error}`); return }
  applySchedule(r)
  schedStatus('Saved.')
})

document.addEventListener('tab-shown', e => { if (e.detail === 'schedule' && !schedDirty) loadSchedule() })
setInterval(async () => {
  if (activeTab() !== 'schedule') return
  const r = await window.mgr.scheduleRead()
  if (r.ok) paintRunner(r)
}, 15000)
