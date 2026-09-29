'use strict'
// Console tab: four containers (Backend, MongoDB, Main Server, Test Server), each with its services' controls, usage and logs.
// Every container collapses sideways to a strip that still shows the status; the two server containers hold the command box.

const CONSOLE_LINES = 100
const STATS_MS = 4000
const STATUS_MS = 10000

// services: the container's services, the first is its own (dot, state and command log); log: false means no log view;
// group: the Start/Stop all target; profile: the relay behind the command input; collapse: the side the container folds to
const COLUMNS = [
  { key: 'backend', label: 'Backend', services: [{ key: 'backend', label: 'Backend' }, { key: 'nginx', label: 'Nginx' }], collapse: 'left' },
  { key: 'mongo', label: 'MongoDB', services: [{ key: 'mongo', label: 'MongoDB' }], collapse: 'left' },
  { key: 'main', label: 'Main Server', group: 'main', profile: 'live', input: true, collapse: 'right',
    services: [{ key: 'game', label: 'Game' }, { key: 'livekit', label: 'LiveKit', log: false }] },
  { key: 'test', label: 'Test Server', group: 'test', profile: 'test', input: true, collapse: 'right',
    services: [{ key: 'test-game', label: 'Game' }, { key: 'test-livekit', label: 'LiveKit', log: false }] },
]
const columnOfProfile = Object.fromEntries(COLUMNS.filter(c => c.profile).map(c => [c.profile, c]))
let serviceStatus = {}

const logOf = key => $(`#clog-${key}`)
const hasLog = svc => svc.log !== false
// The command log of a profile's container (its game log); unknown profiles land in the live one
const consoleLog = profile => logOf((columnOfProfile[profile] || columnOfProfile.live).services[0].key)

function readCollapsed() {
  try { return JSON.parse(localStorage.getItem('consoleCollapsed') || '{}') } catch { return {} }
}

function renderColumns() {
  const box = $('#console-columns')
  const collapsed = readCollapsed()
  box.innerHTML = ''
  for (const col of COLUMNS) {
    const c = el('section', { className: `ccol collapse-${col.collapse}` + (collapsed[col.key] ? ' collapsed' : ''), id: `ccol-${col.key}` })
    const head = el('div', { className: 'ccol-head' })
    head.appendChild(el('span', { className: 'dot', id: `cdot-${col.key}` }))
    head.appendChild(el('span', { className: 'ccol-name' }, esc(col.label)))
    head.appendChild(el('span', { className: 'ccol-state', id: `cstate-${col.key}` }))
    if (col.group) {
      const all = el('button', { className: 'action small ccol-group', id: `ctoggle-${col.key}` }, 'Start all')
      all.addEventListener('click', () => groupAction(col, serviceStatus[col.services[0].key] === 'SERVICE_RUNNING' ? 'stop' : 'start'))
      head.appendChild(all)
    }
    const fold = el('button', { className: 'ccol-fold', title: 'Collapse or expand' }, col.collapse === 'left' ? '&#9664;' : '&#9654;')
    fold.addEventListener('click', () => {
      const next = readCollapsed()
      next[col.key] = !next[col.key]
      try { localStorage.setItem('consoleCollapsed', JSON.stringify(next)) } catch {}
      c.classList.toggle('collapsed', !!next[col.key])
    })
    head.appendChild(fold)
    c.appendChild(head)

    // A single-service container skips the per-service name row and the log subtabs: the head already names it
    const single = col.services.length === 1
    const body = el('div', { className: 'ccol-body' })
    for (const svc of col.services) {
      const row = el('div', { className: 'csvc' })
      const line = el('div', { className: 'csvc-line' })
      if (!single) {
        line.appendChild(el('span', { className: 'dot', id: `sdot-${svc.key}` }))
        line.appendChild(el('span', { className: 'csvc-name' }, esc(svc.label)))
      }
      const toggle = el('button', { className: 'action small', id: `stoggle-${svc.key}` }, 'START')
      toggle.addEventListener('click', () => serviceAction(col, svc, serviceStatus[svc.key] === 'SERVICE_RUNNING' ? 'stop' : 'start'))
      const restart = el('button', { className: 'action small' }, 'RESTART')
      restart.addEventListener('click', () => serviceAction(col, svc, 'restart'))
      line.appendChild(toggle)
      line.appendChild(restart)
      row.appendChild(line)
      row.appendChild(el('div', { className: 'csvc-stats', id: `sstats-${svc.key}` }))
      body.appendChild(row)
    }
    const logged = col.services.filter(hasLog)
    if (!single) {
      const views = el('div', { className: 'clog-views' })
      logged.forEach((svc, i) => {
        const b = el('button', { className: 'subtab' + (i === 0 ? ' active' : '') }, esc(svc.label))
        b.addEventListener('click', () => {
          views.querySelectorAll('.subtab').forEach(x => x.classList.remove('active'))
          b.classList.add('active')
          logged.forEach(s => { logOf(s.key).hidden = s.key !== svc.key })
        })
        views.appendChild(b)
      })
      body.appendChild(views)
    }
    logged.forEach((svc, i) => {
      const pre = el('pre', { className: 'log clog', id: `clog-${svc.key}` })
      pre.dataset.max = String(CONSOLE_LINES)
      pre.hidden = i !== 0
      body.appendChild(pre)
    })
    if (col.input) {
      const form = el('form', { className: 'row cinput' })
      const input = el('input', { type: 'text', placeholder: "Command, 'help' lists them", autocomplete: 'off' })
      form.appendChild(input)
      form.appendChild(el('button', { className: 'action', type: 'submit' }, 'Send'))
      form.addEventListener('submit', async e => {
        e.preventDefault()
        const text = input.value.trim()
        if (!text) return
        const log = consoleLog(col.profile)
        appendLog(log, `> ${text}\n`)
        input.value = ''
        const r = await window.mgr.consoleCommand(text, col.profile)
        if (!r.ok) appendLog(log, `[command not delivered] ${r.error}\n`)
      })
      body.appendChild(form)
    }
    c.appendChild(body)
    box.appendChild(c)
  }
}

// Runs one service action with every console button disabled and its steps written to log
async function runAction(log, title, run) {
  $$('#console-columns button.action').forEach(b => { b.disabled = true })
  appendLog(log, `\n--- ${title} ---\n`)
  try {
    const r = await run()
    if (r.steps) r.steps.forEach(x => appendLog(log, x + '\n'))
    if (r.error) appendLog(log, 'error: ' + r.error + '\n')
    if (r.status) paintConsoleStatus(r.status)
  } finally {
    $$('#console-columns button.action').forEach(b => { b.disabled = false })
  }
}

// A service without a log view (LiveKit) reports into its container's first log
function serviceAction(col, svc, action) {
  return runAction(logOf(svc.key) || logOf(col.services[0].key), `${action} ${svc.label}`, () => window.mgr.serviceAction(svc.key, action))
}

function groupAction(col, action) {
  return runAction(logOf(col.services[0].key), `${action} all: ${col.label}`, () => window.mgr.servicesAction(action, col.group))
}

function paintConsoleStatus(st) {
  serviceStatus = st || {}
  const up = key => serviceStatus[key] === 'SERVICE_RUNNING'
  for (const col of COLUMNS) {
    const own = col.services[0].key
    $(`#cdot-${col.key}`).className = 'dot ' + (up(own) ? 'ok' : 'bad')
    $(`#cstate-${col.key}`).textContent = up(own) ? 'Online' : 'Offline'
    const all = $(`#ctoggle-${col.key}`)
    if (all) all.textContent = up(own) ? 'Stop all' : 'Start all'
    for (const svc of col.services) {
      const dot = $(`#sdot-${svc.key}`)
      if (dot) dot.className = 'dot ' + (up(svc.key) ? 'ok' : 'bad')
      $(`#stoggle-${svc.key}`).textContent = up(svc.key) ? 'STOP' : 'START'
    }
  }
  document.dispatchEvent(new CustomEvent('services-status', { detail: serviceStatus }))
}

async function refreshConsoleStatus() {
  try { paintConsoleStatus(await window.mgr.servicesStatus()) } catch {}
}

async function refreshStats() {
  if (activeTab() !== 'console') return
  const stats = await window.mgr.servicesStats()
  for (const col of COLUMNS) {
    for (const svc of col.services) {
      const s = stats[svc.key]
      const parts = s ? [`CPU ${s.cpu}%`, `RAM ${s.memMb} MB`] : ['not running']
      if (s && s.requestsPerMin !== undefined && s.requestsPerMin !== null) parts.push(`${s.requestsPerMin} req/min`)
      $(`#sstats-${svc.key}`).textContent = parts.join('  ·  ')
    }
  }
}

// Each service's log goes to its own view; a service without one (LiveKit) is not shown
window.mgr.onLog(d => appendLog(logOf(d.service), d.text))
window.mgr.onConsoleRelay(d => {
  const log = consoleLog(d.profile)
  if (d.kind === 'status') appendLog(log, `\n[console] ${d.text}\n`)
  else appendLog(log, d.text.endsWith('\n') ? d.text : d.text + '\n')
})

renderColumns()
refreshConsoleStatus()
setInterval(refreshConsoleStatus, STATUS_MS)
setInterval(refreshStats, STATS_MS)
document.addEventListener('tab-shown', e => { if (e.detail === 'console') refreshStats() })
for (const col of COLUMNS.filter(c => c.input)) {
  appendLog(consoleLog(col.profile), `Type 'help' for manager commands (services, builds); anything else goes to the ${col.label} game console.\n`)
}
