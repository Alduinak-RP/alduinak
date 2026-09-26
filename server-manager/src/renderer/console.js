'use strict'
// Console tab: one column per console (Nginx, Backend with MongoDB, Game with LiveKit), each with its services' controls,
// usage and logs. Columns collapse sideways to a strip that still shows the status.

const CONSOLE_LINES = 100
const STATS_MS = 4000
const STATUS_MS = 10000

// services: the column's services, the first is its own; collapse: the side the column folds to
const COLUMNS = [
  { key: 'nginx',   label: 'Nginx',   services: [{ key: 'nginx', label: 'Nginx' }], collapse: 'left' },
  { key: 'backend', label: 'Backend', services: [{ key: 'backend', label: 'Backend' }, { key: 'mongo', label: 'MongoDB' }], collapse: 'left' },
  { key: 'game',    label: 'Game',    services: [{ key: 'game', label: 'Game' }, { key: 'livekit', label: 'LiveKit' }], collapse: 'right', input: true },
]
const serviceColumn = Object.fromEntries(COLUMNS.flatMap(c => c.services.map(s => [s.key, c.key])))
let serviceStatus = {}

const logOf = key => $(`#clog-${key}`)
const gameLog = () => logOf('game')

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
    const fold = el('button', { className: 'ccol-fold', title: 'Collapse or expand' }, col.collapse === 'left' ? '&#9664;' : '&#9654;')
    fold.addEventListener('click', () => {
      const next = readCollapsed()
      next[col.key] = !next[col.key]
      try { localStorage.setItem('consoleCollapsed', JSON.stringify(next)) } catch {}
      c.classList.toggle('collapsed', !!next[col.key])
    })
    head.appendChild(fold)
    c.appendChild(head)

    const body = el('div', { className: 'ccol-body' })
    for (const svc of col.services) {
      const row = el('div', { className: 'csvc' })
      const line = el('div', { className: 'csvc-line' })
      if (col.services.length > 1) {
        line.appendChild(el('span', { className: 'dot', id: `sdot-${svc.key}` }))
        line.appendChild(el('span', { className: 'csvc-name' }, esc(svc.label)))
      }
      const toggle = el('button', { className: 'action small', id: `stoggle-${svc.key}` }, 'START')
      toggle.addEventListener('click', () => serviceAction(svc, serviceStatus[svc.key] === 'SERVICE_RUNNING' ? 'stop' : 'start'))
      const restart = el('button', { className: 'action small' }, 'RESTART')
      restart.addEventListener('click', () => serviceAction(svc, 'restart'))
      line.appendChild(toggle)
      line.appendChild(restart)
      row.appendChild(line)
      row.appendChild(el('div', { className: 'csvc-stats', id: `sstats-${svc.key}` }))
      body.appendChild(row)
    }
    if (col.services.length > 1) {
      const views = el('div', { className: 'clog-views' })
      col.services.forEach((svc, i) => {
        const b = el('button', { className: 'subtab' + (i === 0 ? ' active' : '') }, esc(svc.label))
        b.addEventListener('click', () => {
          views.querySelectorAll('.subtab').forEach(x => x.classList.remove('active'))
          b.classList.add('active')
          col.services.forEach(s => { logOf(s.key).hidden = s.key !== svc.key })
        })
        views.appendChild(b)
      })
      body.appendChild(views)
    }
    col.services.forEach((svc, i) => {
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
        appendLog(gameLog(), `> ${text}\n`)
        input.value = ''
        const r = await window.mgr.consoleCommand(text)
        if (!r.ok) appendLog(gameLog(), `[command not delivered] ${r.error}\n`)
      })
      body.appendChild(form)
    }
    c.appendChild(body)
    box.appendChild(c)
  }
}

async function serviceAction(svc, action) {
  const log = logOf(svc.key)
  $$('#console-columns button.action').forEach(b => { b.disabled = true })
  appendLog(log, `\n--- ${action} ${svc.label} ---\n`)
  try {
    const r = await window.mgr.serviceAction(svc.key, action)
    if (r.steps) r.steps.forEach(x => appendLog(log, x + '\n'))
    if (r.error) appendLog(log, 'error: ' + r.error + '\n')
    if (r.status) paintConsoleStatus(r.status)
  } finally {
    $$('#console-columns button.action').forEach(b => { b.disabled = false })
  }
}

function paintConsoleStatus(st) {
  serviceStatus = st || {}
  const up = key => serviceStatus[key] === 'SERVICE_RUNNING'
  for (const col of COLUMNS) {
    const own = col.services[0].key
    $(`#cdot-${col.key}`).className = 'dot ' + (up(own) ? 'ok' : 'bad')
    $(`#cstate-${col.key}`).textContent = up(own) ? 'Online' : 'Offline'
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

window.mgr.onLog(d => {
  const target = logOf(d.service) || logOf(serviceColumn[d.service]) || gameLog()
  appendLog(target, d.text)
})
window.mgr.onConsoleRelay(d => {
  if (d.kind === 'status') appendLog(gameLog(), `\n[console] ${d.text}\n`)
  else appendLog(gameLog(), d.text.endsWith('\n') ? d.text : d.text + '\n')
})

renderColumns()
refreshConsoleStatus()
setInterval(refreshConsoleStatus, STATUS_MS)
setInterval(refreshStats, STATS_MS)
document.addEventListener('tab-shown', e => { if (e.detail === 'console') refreshStats() })
appendLog(gameLog(), "Type 'help' for manager commands (services, builds); anything else goes to the game console.\n")
