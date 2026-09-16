// Server tab: game service control, web jobs, logs, allow-listed console and masked settings through /api/manager
// Player-controlled text (logs, chat, names) is only ever inserted as text nodes, never as HTML
;(() => {
  const POLL_MS = 3000
  const LOG_TEXT_MAX = 1024 * 1024
  const TABS = [['status', 'Status'], ['jobs', 'Jobs'], ['logs', 'Logs'], ['console', 'Console'], ['settings', 'Settings']]

  const m = {
    user: null, me: null, tab: 'status', stopped: false, inFlight: false, opening: false,
    jobId: null, jobFrom: 0, jobDone: true, jobPollCount: 0,
    logId: '', logStart: null, logEnd: null,
    consoleAfter: 0,
  }

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : String(child))
    }
    return node
  }

  const fmtTime = iso => (iso ? new Date(iso).toLocaleString() : '-')
  const fmtBytes = n => (n === null || n === undefined ? '-' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`)

  // DOM
  const navButton = h('button', { class: 'nav-button hidden', type: 'button', dataset: { view: 'manager' } }, 'Server')
  const banner = h('div', { class: 'manager-banner hidden' })
  const sessionInfo = h('span', { class: 'muted' })
  const agentPill = h('span', { class: 'status-pill' }, 'Agent unknown')
  const tabButtons = TABS.map(([key, label]) => h('button', { class: 'ghost mini manager-tab', type: 'button', dataset: { managerTab: key }, onclick: () => selectTab(key) }, label))

  const servicesTable = h('div', { class: 'table compact-table' })
  const busyLine = h('p', { class: 'muted' })
  const purgeLine = h('p', { class: 'manager-warning hidden' })
  const buildButtons = h('div', { class: 'actions-row' })

  const jobsTable = h('div', { class: 'table compact-table' })
  const jobTitle = h('span', { class: 'muted' }, 'No job selected')
  const jobPre = h('pre', { class: 'manager-pre' })

  const logSelect = h('select', { onchange: () => openLog(logSelect.value) })
  const followInput = h('input', { type: 'checkbox', checked: true })
  const logInfo = h('span', { class: 'muted' })
  const logPre = h('pre', { class: 'manager-pre tall' })

  const consoleState = h('span', { class: 'muted' })
  const consolePre = h('pre', { class: 'manager-pre tall' })
  const consoleInput = h('input', { autocomplete: 'off', maxlength: '500', placeholder: 'say <text> | notify <name|all> <text> | kick <name> | players | status' })

  const settingsBox = h('div', { class: 'manager-settings' })

  const panels = {
    status: h('div', { class: 'manager-panel' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Services'), busyLine),
        purgeLine,
        servicesTable),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Builds'), h('span', { class: 'muted' }, 'Runs on the box from main; refused while the checkout has uncommitted changes. gamemode_extensions is not in git, so each job records its file hashes instead')),
        buildButtons)),
    jobs: h('div', { class: 'split' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Job history'), h('button', { class: 'ghost mini', type: 'button', onclick: () => refreshJobs() }, 'Refresh')), jobsTable),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Job log'), jobTitle), jobPre)),
    logs: h('section', { class: 'panel' },
      h('div', { class: 'toolbar' },
        h('label', {}, 'Log', logSelect),
        h('button', { class: 'ghost mini', type: 'button', onclick: () => loadLogList() }, 'Refresh list'),
        h('button', { class: 'ghost mini', type: 'button', onclick: () => loadOlder() }, 'Load older'),
        h('label', { class: 'check-row' }, followInput, h('span', {}, 'Follow')),
        logInfo),
      logPre),
    console: h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Game console'), consoleState),
      consolePre,
      h('form', { class: 'manager-console-form', onsubmit: event => { event.preventDefault(); sendConsole() } },
        consoleInput, h('button', { class: 'primary', type: 'submit' }, 'Send'))),
    settings: h('div', {},
      h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, 'Read-only. Secrets only show whether they are set; edit settings on the box.'), h('button', { class: 'ghost mini', type: 'button', onclick: () => loadSettings() }, 'Refresh')),
      settingsBox),
  }

  const view = h('section', { id: 'managerView', class: 'view hidden manager' },
    h('div', { class: 'toolbar' }, h('div', { class: 'manager-tabs' }, tabButtons), sessionInfo, agentPill),
    banner,
    Object.values(panels))

  document.querySelector('.nav').append(navButton)
  document.querySelector('main.content').append(view)

  // Helpers

  function showBanner(text, kind = 'error') {
    banner.textContent = text
    banner.className = `manager-banner ${kind}`
  }

  function hideBanner() {
    banner.textContent = ''
    banner.className = 'manager-banner hidden'
  }

  // Only the first request after real input counts as activity; the rest are marked as polls so the idle timeout still runs
  let inputAt = Date.now()
  let reportedAt = 0
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(type, () => { inputAt = Date.now() }, { capture: true, passive: true })
  }

  async function call(path, options = {}) {
    const active = inputAt > reportedAt
    if (active) reportedAt = Date.now()
    const headers = active ? options.headers : { ...(options.headers || {}), 'X-Dashboard-Poll': '1' }
    try {
      return await api(`/api/manager${path}`, { ...options, headers })
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        m.stopped = true
        showBanner(`${err.message}. The Server tab stopped refreshing.`)
      } else if (err.status === 502 || err.status === 503) {
        agentPill.textContent = 'Agent offline'
        agentPill.classList.remove('online')
        showBanner(err.message)
      }
      throw err
    }
  }

  function post(path, body) {
    return call(path, { method: 'POST', body: JSON.stringify(body) })
  }

  function selectTab(key) {
    m.tab = key
    for (const button of tabButtons) button.classList.toggle('active', button.dataset.managerTab === key)
    for (const [name, panel] of Object.entries(panels)) panel.classList.toggle('hidden', name !== key)
    if (key === 'jobs') refreshJobs().catch(() => {})
    if (key === 'logs' && !logSelect.options.length) loadLogList().catch(() => {})
    if (key === 'settings') loadSettings().catch(() => {})
    tick()
  }

  function visible() {
    return !view.classList.contains('hidden') && !document.hidden
  }

  function appendCapped(pre, text) {
    pre.append(text)
    if (pre.textContent.length > LOG_TEXT_MAX) pre.textContent = pre.textContent.slice(-LOG_TEXT_MAX)
  }

  // Status and builds

  async function startJob(kind, label) {
    if (!window.confirm(`${label}?`)) return
    try {
      const r = await post('/jobs', { kind })
      toast(`${label} started`)
      m.jobId = r.jobId
      m.jobFrom = 0
      m.jobDone = false
      jobPre.textContent = ''
      selectTab('jobs')
    } catch (err) {
      toast(err.message)
    }
  }

  function renderServices(data) {
    const rows = data.services.map(s => h('tr', {},
      h('td', {}, s.label),
      h('td', { class: 'muted' }, s.name),
      h('td', {}, h('span', { class: `tag ${s.status === 'SERVICE_RUNNING' ? '' : 'locked'}` }, s.status.replace(/^SERVICE_/, '').toLowerCase())),
      h('td', {}, s.controllable
        ? h('div', { class: 'manager-buttons' },
          h('button', { class: 'ghost mini', type: 'button', onclick: () => startJob('game.start', 'Start the game server') }, 'Start'),
          h('button', { class: 'ghost mini', type: 'button', onclick: () => startJob('game.restart', 'Restart the game server') }, 'Restart'),
          h('button', { class: 'danger mini', type: 'button', onclick: () => startJob('game.stop', 'Stop the game server') }, 'Stop'))
        : h('span', { class: 'muted' }, 'local only'))))
    servicesTable.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Service'), h('th', {}, 'Windows service'), h('th', {}, 'Status'), h('th', {}, ''))), h('tbody', {}, rows)))
    busyLine.textContent = data.busy ? `Busy: ${data.busy.kind} (${data.busy.source}${data.busy.actor ? `, ${data.busy.actor}` : ''}) since ${fmtTime(data.busy.startedAt)}` : 'No build or job running'
    purgeLine.textContent = data.purgePending || ''
    purgeLine.classList.toggle('hidden', !data.purgePending)
  }

  function renderBuildButtons() {
    const builds = (m.me.jobKinds || []).filter(k => k.build)
    buildButtons.replaceChildren(...builds.map(k => h('button', { class: 'primary', type: 'button', onclick: () => startJob(k.kind, k.label) }, k.label)))
  }

  async function refreshServices() {
    renderServices(await call('/services'))
  }

  // Jobs

  async function refreshJobs() {
    const data = await call('/jobs?limit=50')
    const rows = data.jobs.map(job => h('tr', { class: job.id === m.jobId ? 'selected' : '' },
      h('td', {}, fmtTime(job.startedAt)),
      h('td', {}, job.label || job.kind),
      h('td', {}, job.actor ? job.actor.username : '-'),
      h('td', { class: 'muted', title: job.gamemode ? `gamemode_extensions sha256 ${job.gamemode.sha256}` : null }, job.commit ? job.commit.slice(0, 10) : '-', job.gamemode ? ` / gm ${job.gamemode.sha256.slice(0, 10)}` : ''),
      h('td', {}, h('span', { class: `tag ${job.status === 'ok' || job.status === 'running' ? '' : 'locked'}` }, job.status)),
      h('td', {}, h('button', { class: 'ghost mini', type: 'button', onclick: () => openJob(job.id) }, 'Log'))))
    jobsTable.replaceChildren(rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Started', 'Job', 'By', 'Commit', 'Status', ''].map(t => h('th', {}, t)))), h('tbody', {}, rows))
      : h('div', { class: 'empty-row' }, 'No web jobs yet'))
    if (m.jobId && !data.jobs.some(j => j.id === m.jobId)) jobTitle.textContent = m.jobId
  }

  function openJob(id) {
    m.jobId = id
    m.jobFrom = 0
    m.jobDone = false
    jobPre.textContent = ''
    jobTitle.textContent = id
    pollJobLog().catch(() => {})
    refreshJobs().catch(() => {})
  }

  async function pollJobLog() {
    if (!m.jobId || m.jobDone) return
    const id = m.jobId
    const data = await call(`/jobs/${id}/log?from=${m.jobFrom}`)
    if (id !== m.jobId) return
    if (data.text) appendCapped(jobPre, data.text)
    m.jobFrom = data.end
    jobTitle.textContent = `${id}: ${data.status}`
    if (data.done && data.end >= data.size) {
      m.jobDone = true
      refreshJobs().catch(() => {})
    }
  }

  // Logs

  async function loadLogList() {
    const data = await call('/logs')
    const previous = logSelect.value
    logSelect.replaceChildren(h('option', { value: '' }, 'Choose a log'), ...data.logs.map(l => h('option', { value: l.id }, `${l.label} - ${l.name} (${fmtBytes(l.size)})`)))
    if (data.logs.some(l => l.id === previous)) logSelect.value = previous
  }

  async function openLog(id) {
    m.logId = id
    logPre.textContent = ''
    logInfo.textContent = ''
    if (!id) return
    const data = await call(`/logs/${id}`)
    if (id !== m.logId) return
    logPre.textContent = data.text
    m.logStart = data.start
    m.logEnd = data.end
    logInfo.textContent = `${fmtBytes(data.size)} total`
    logPre.scrollTop = logPre.scrollHeight
  }

  async function loadOlder() {
    if (!m.logId || !m.logStart) return
    const id = m.logId
    const data = await call(`/logs/${id}?before=${m.logStart}`)
    if (id !== m.logId) return
    logPre.prepend(data.text)
    m.logStart = data.start
  }

  async function followLog() {
    if (!m.logId || !followInput.checked || m.logEnd === null) return
    const id = m.logId
    const data = await call(`/logs/${id}?from=${m.logEnd}`)
    if (id !== m.logId) return
    if (data.reset) {
      logPre.textContent = data.text
      m.logStart = data.start
    } else if (data.text) {
      const atBottom = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 8
      appendCapped(logPre, data.text)
      if (atBottom) logPre.scrollTop = logPre.scrollHeight
    }
    m.logEnd = data.end
    logInfo.textContent = `${fmtBytes(data.size)} total`
  }

  // Console

  async function pollConsole() {
    const data = await call(`/console?after=${m.consoleAfter}`)
    consoleState.textContent = data.connected ? 'Connected to the game server' : 'Relay offline'
    if (data.last < m.consoleAfter) m.consoleAfter = 0
    if (data.lines.length) {
      const atBottom = consolePre.scrollTop + consolePre.clientHeight >= consolePre.scrollHeight - 8
      appendCapped(consolePre, data.lines.map(l => `${l.text}\n`).join(''))
      if (atBottom) consolePre.scrollTop = consolePre.scrollHeight
    }
    m.consoleAfter = Math.max(m.consoleAfter, data.last)
  }

  async function sendConsole() {
    const text = consoleInput.value.trim()
    if (!text) return
    try {
      await post('/console', { text })
      consoleInput.value = ''
      pollConsole().catch(() => {})
    } catch (err) {
      toast(err.message)
    }
  }

  // Settings

  function settingValue(entry) {
    if (entry.secret) return h('span', { class: `tag ${entry.secretSet ? '' : 'locked'}` }, entry.secretSet ? 'secret set' : 'not set')
    if (entry.value === undefined || entry.value === null || entry.value === '') return h('span', { class: 'muted' }, 'unset')
    if (typeof entry.value !== 'object') return String(entry.value)
    const text = JSON.stringify(entry.value, (key, value) => (value && typeof value === 'object' && Object.keys(value).length === 1 && 'secretSet' in value
      ? (value.secretSet ? '[secret set]' : '[secret not set]')
      : value), 2)
    return h('pre', { class: 'manager-json' }, text)
  }

  function settingsTable(title, data) {
    const rows = [...data.fields, ...data.extra].map(entry => h('tr', {},
      h('td', {}, h('div', {}, entry.label), h('div', { class: 'muted' }, entry.key)),
      h('td', {}, settingValue(entry)),
      h('td', {}, entry.locked ? h('span', { class: 'tag locked' }, 'locked') : '')))
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, title), h('span', { class: 'muted' }, data.exists === false ? `missing: ${data.path}` : data.path)),
      data.error ? h('p', { class: 'manager-warning' }, data.error) : null,
      h('div', { class: 'table' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Setting'), h('th', {}, 'Value'), h('th', {}, 'Web'))), h('tbody', {}, rows))))
  }

  async function loadSettings() {
    const [server, env] = await Promise.all([call('/settings/serverSettings'), call('/settings/backendEnv')])
    settingsBox.replaceChildren(settingsTable('server-settings.json', server), settingsTable('Backend .env', env))
  }

  // Polling, paused while the tab or the browser window is hidden

  async function tick() {
    if (m.stopped || m.inFlight || !m.me || !visible()) return
    m.inFlight = true
    try {
      if (m.tab === 'status') await refreshServices()
      if (m.tab === 'jobs') {
        await pollJobLog()
        if (++m.jobPollCount % 5 === 0) await refreshJobs()
      }
      if (m.tab === 'logs') await followLog()
      if (m.tab === 'console') await pollConsole()
      const health = await call('/health')
      agentPill.textContent = health.relayConnected ? 'Agent online' : 'Agent online, relay offline'
      agentPill.classList.add('online')
      hideBanner()
    } catch {
      // call() already reported it
    } finally {
      m.inFlight = false
    }
  }

  async function openManager() {
    if (m.opening) return
    const user = state.user
    if (user.aud !== 'dashboard' || user.mfa !== true) {
      m.me = null
      showBanner(user.mfa !== true
        ? 'The server manager needs two-factor authentication on your Discord account. Turn it on in Discord, then log out and log in again.'
        : 'The server manager only accepts logins started from this dashboard. Log out and log in again here.')
      for (const panel of Object.values(panels)) panel.classList.add('hidden')
      return
    }
    m.opening = true
    try {
      m.stopped = false
      m.me = await call('/me')
      hideBanner()
      sessionInfo.textContent = `Signed out after ${Math.round(m.me.idleTimeoutMs / 60000)} minutes without input; session ends ${fmtTime(new Date(m.me.expiresAt).toISOString())}`
      renderBuildButtons()
      selectTab(m.tab)
    } catch {
      m.me = null
    } finally {
      m.opening = false
    }
  }

  function syncVisibility() {
    const admin = !!(state.user && (state.user.permissions || []).includes('admin.*'))
    if (state.user !== m.user) {
      m.user = state.user
      m.me = null
      m.consoleAfter = 0
      consolePre.textContent = ''
    }
    navButton.classList.toggle('hidden', !admin)
    const show = admin && state.activeView === 'manager'
    view.classList.toggle('hidden', !show)
    if (show && !m.me && !banner.textContent) openManager()
  }

  document.querySelector('.nav').addEventListener('click', event => {
    const button = event.target.closest('[data-view]')
    if (!button) return
    if (button === navButton) {
      hideBanner()
      m.me = null
    }
    syncVisibility()
  })

  setInterval(syncVisibility, 1000)
  setInterval(tick, POLL_MS)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
})()
