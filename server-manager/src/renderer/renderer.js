'use strict'

const $  = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))
const el = (tag, props = {}, html) => Object.assign(document.createElement(tag), props, html != null ? { innerHTML: html } : {})
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function appendLog(node, text) {
  if (!node) return
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  // Normalise CRLF to LF
  text = text.replace(/\r\n/g, '\n')
  if (text.indexOf('\r') === -1) {
    node.textContent += text
  } else {
    const old = node.textContent
    const cut = old.lastIndexOf('\n') + 1          // only the unfinished last line can be rewritten
    node.textContent = old.slice(0, cut) + (old.slice(cut) + text)
      .split('\n')
      .map(seg => { const i = seg.lastIndexOf('\r'); return i === -1 ? seg : seg.slice(i + 1) })
      .join('\n')
  }
  if (atBottom) node.scrollTop = node.scrollHeight
}

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'))
    $$('.panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    $('#' + tab.dataset.tab).classList.add('active')
  })
})

// Build output streams to the active panel's log (Build → #build-log, Modlist → #modlist-log).
window.mgr.onBuildLog(t => appendLog($('.panel.active')?.querySelector('.log') || $('#build-log'), t))

// Keep in sync with `services` in src/config.js (the main process owns the
// nssm service names; this is the renderer's copy of key/label). If the two
// drift, the UI silently shows a stale set.
const SERVICES = [
  { key: 'nginx',   label: 'Nginx'   },
  { key: 'backend', label: 'Backend' },
  { key: 'game',    label: 'Game'    },
]
const logNode = $('#log')

function renderServices() {
  const box = $('#services')
  box.innerHTML = ''
  for (const s of SERVICES) {
    const row = el('div', { className: 'svc-row' })
    row.appendChild(el('span', { className: 'svc-name' }, s.label))
    row.appendChild(el('span', { className: 'svc-status', id: `svc-${s.key}` }, '…'))
    const sel = el('select', { className: 'svc-action' })
    sel.appendChild(el('option', { value: '' }, 'Action…'))
    sel.appendChild(el('option', { value: 'start' }, 'Start'))
    sel.appendChild(el('option', { value: 'stop' }, 'Stop'))
    sel.appendChild(el('option', { value: 'restart' }, 'Restart'))
    sel.addEventListener('change', async () => {
      const action = sel.value
      sel.value = ''
      if (!action) return
      sel.disabled = true
      appendLog(logNode, `\n--- ${action} ${s.label} ---\n`)
      const r = await window.mgr.serviceAction(s.key, action)
      if (r.steps) r.steps.forEach(x => appendLog(logNode, x + '\n'))
      if (r.error) appendLog(logNode, 'error: ' + r.error + '\n')
      if (r.status) paintStatus(r.status)
      sel.disabled = false
    })
    row.appendChild(sel)
    box.appendChild(row)
  }
  const allRow = el('div', { className: 'svc-row' })
  allRow.appendChild(el('span', { className: 'svc-name' }, 'All'))
  allRow.appendChild(el('span', { className: 'svc-status', id: 'svc-all' }, '…'))
  const allSel = el('select', { className: 'svc-action' })
  allSel.appendChild(el('option', { value: '' }, 'Action…'))
  allSel.appendChild(el('option', { value: 'start' }, 'Start all'))
  allSel.appendChild(el('option', { value: 'stop' }, 'Stop all'))
  allSel.appendChild(el('option', { value: 'restart' }, 'Restart all'))
  allSel.addEventListener('change', async () => {
    const action = allSel.value
    allSel.value = ''
    if (!action) return
    allSel.disabled = true
    appendLog(logNode, `\n--- ${action} all services ---\n`)
    const r = await window.mgr.servicesAction(action)
    if (r.steps) r.steps.forEach(x => appendLog(logNode, x + '\n'))
    if (r.error) appendLog(logNode, 'error: ' + r.error + '\n')
    if (r.status) paintStatus(r.status)
    allSel.disabled = false
  })
  allRow.appendChild(allSel)
  box.appendChild(allRow)
}

function paintStatus(st) {
  let up = 0
  for (const s of SERVICES) {
    const node = $(`#svc-${s.key}`)
    if (!node) continue
    const raw = st[s.key] || '?'
    const running = /SERVICE_RUNNING/i.test(raw)
    const stopped = /SERVICE_STOPPED/i.test(raw)
    if (running) up++
    node.textContent = running ? 'running' : stopped ? 'stopped' : raw.replace(/^SERVICE_/i, '').toLowerCase()
    node.className = 'svc-status ' + (running ? 'ok' : stopped ? 'bad' : 'unknown')
  }
  const all = $('#svc-all')
  if (all) {
    const total = SERVICES.length
    all.textContent = up === total ? 'all up' : up === 0 ? 'all down' : `${up}/${total} up`
    all.className = 'svc-status ' + (up === total ? 'ok' : up === 0 ? 'bad' : 'unknown')
  }
}

async function refreshStatus() {
  try { paintStatus(await window.mgr.servicesStatus()) } catch {}
}

window.mgr.onLog(d => appendLog(logNode, d.source ? `[${d.source}] ${d.text}` : d.text))
window.mgr.onConsoleRelay(d => {
  if (d.kind === 'status') appendLog(logNode, `\n[console] ${d.text}\n`)
  else appendLog(logNode, d.text.endsWith('\n') ? d.text : d.text + '\n')
})

$('#cmd-form').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('#cmd')
  const text = input.value.trim()
  if (!text) return
  appendLog(logNode, `> ${text}\n`)
  input.value = ''
  const r = await window.mgr.consoleCommand(text)
  if (!r.ok) appendLog(logNode, `[command not delivered] ${r.error}\n`)
})

renderServices()
refreshStatus()
setInterval(refreshStatus, 10000)

let allPlayers = []
let selectedDiscordId = null

async function loadPlayers() {
  const r = await window.mgr.playersList()
  if (!r.ok) { allPlayers = []; $('#players-list').innerHTML = `<li>Error: ${esc(r.error)}</li>`; return }
  allPlayers = r.players
  renderPlayerList()
}

function renderPlayerList() {
  const ul = $('#players-list')
  const q = $('#player-search').value.trim().toLowerCase()
  const filtered = !q ? allPlayers : allPlayers.filter(p =>
    String(p.name).toLowerCase().includes(q) ||
    String(p.discordId).toLowerCase().includes(q) ||
    (p.characters || []).some(c => String(c).toLowerCase().includes(q)))

  ul.innerHTML = ''
  $('#players-count').textContent = `${filtered.length} / ${allPlayers.length}`
  if (filtered.length === 0) { ul.appendChild(el('li', { className: 'muted' }, q ? 'No matches.' : 'No players yet.')); return }

  for (const p of filtered) {
    const li = el('li')
    if (p.discordId === selectedDiscordId) li.classList.add('selected')
    const main = el('div', { className: 'pl-main' })
    main.appendChild(el('span', { className: 'pl-name' }, esc(p.name)))
    if (p.whitelisted) main.appendChild(el('span', { className: 'badge' }, 'whitelist'))
    li.appendChild(main)
    const sub = (p.characters && p.characters.length)
      ? `${p.characters.length} char${p.characters.length > 1 ? 's' : ''}: ${esc(p.characters.join(', '))}`
      : 'no characters'
    li.appendChild(el('div', { className: 'pl-sub' }, sub))
    li.addEventListener('click', () => selectPlayer(p.discordId))
    ul.appendChild(li)
  }
}

async function selectPlayer(discordId) {
  selectedDiscordId = discordId
  renderPlayerList()
  const box = $('#player-detail')
  box.innerHTML = '<p class="muted">Loading…</p>'
  const r = await window.mgr.playersDetail(discordId)
  if (!r.ok) { box.innerHTML = `<p>Error: ${esc(r.error)}</p>`; return }
  const p = r.player

  const factions = r.factions.length
    ? '<ul class="mini">' + r.factions.map(f => `<li>${esc(f.requirement ? `${f.requirement.group || f.requirement.faction || ''} — ${f.requirement.rank ?? ''}` : (f.requirementId || ''))}</li>`).join('') + '</ul>'
    : '<p class="muted">None</p>'
  const chars = r.characters.length
    ? '<ul class="mini">' + r.characters.map(c => `<li>${esc(c.name)}${c.disabled ? ' <span class="muted">(disabled)</span>' : ''}</li>`).join('') + '</ul>'
    : '<p class="muted">No characters found in the save store.</p>'

  box.innerHTML =
    `<h3>${esc(p.displayName || p.username || 'Player')}` +
      `${p.whitelisted ? ' <span class="badge">whitelist</span>' : ''}</h3>` +
    `<div class="kv"><b>Discord ID</b><span>${esc(p.discordId)}</span></div>` +
    `<div class="kv"><b>Profile ID</b><span>${esc(p.profileId)}</span></div>` +
    `<div class="kv"><b>Last seen</b><span>${esc(p.lastSeenAt || '—')}</span></div>` +
    `<div class="kv"><b>Created</b><span>${esc(p.createdAt || '—')}</span></div>` +
    `<div class="field"><label>Username</label><input id="pd-username" type="text" value="${esc(p.username)}" /></div>` +
    `<div class="field"><label>Display name</label><input id="pd-displayName" type="text" value="${esc(p.displayName)}" /></div>` +
    `<div class="field"><label>Notes</label><textarea id="pd-notes" rows="3">${esc(p.notes)}</textarea></div>` +
    `<div class="row"><button id="pd-save" class="action go">Save changes</button><span id="pd-status" class="status"></span></div>` +
    `<h4>Factions</h4>${factions}` +
    `<h4>Characters</h4>${chars}`

  $('#pd-save').addEventListener('click', async () => {
    const patch = {
      username: $('#pd-username').value,
      displayName: $('#pd-displayName').value,
      notes: $('#pd-notes').value,
    }
    $('#pd-status').textContent = 'saving…'
    const res = await window.mgr.playersUpdate(p.profileId, patch)
    if (!res.ok) { $('#pd-status').textContent = 'Error: ' + res.error; return }
    $('#pd-status').textContent = 'Saved.'
    // Reflect the new name in the list.
    const row = allPlayers.find(x => x.discordId === p.discordId)
    if (row) row.name = patch.displayName || patch.username || row.name
    renderPlayerList()
  })
}

$('#players-refresh').addEventListener('click', loadPlayers)
$('#player-search').addEventListener('input', renderPlayerList)
loadPlayers()

window.mgr.launcherGetVersion().then(r => { if (r.version) $('#launcher-version').value = r.version })
window.mgr.clientGetVersion().then(r => { if (r.version) $('#client-version').value = r.version })

$('#launcher-save').addEventListener('click', async () => {
  const r = await window.mgr.launcherSetVersion($('#launcher-version').value)
  appendLog($('#build-log'), r.ok ? '\nLauncher version saved.\n' : '\nError: ' + r.error + '\n')
})
$('#client-save').addEventListener('click', async () => {
  const r = await window.mgr.clientSetVersion($('#client-version').value)
  appendLog($('#build-log'), r.ok ? '\nClient version saved.\n' : '\nError: ' + r.error + '\n')
})

function wireBuild(btnId, fn, label) {
  $(btnId).addEventListener('click', async e => {
    const buttons = $$('#build .action.go')
    buttons.forEach(b => b.disabled = true)
    appendLog($('#build-log'), `\n######## Building ${label} ########\n`)
    const r = await fn()
    appendLog($('#build-log'), r.ok ? `\n✓ ${label} build complete.\n` : `\n✗ ${label} failed: ${r.error}\n`)
    buttons.forEach(b => b.disabled = false)
    refreshStatus()
  })
}
wireBuild('#build-server',   () => window.mgr.buildServer(),   'server')
wireBuild('#build-launcher', () => window.mgr.buildLauncher(), 'launcher')
wireBuild('#build-client',   () => window.mgr.buildClient(),   'client')

$('#modlist-refresh').addEventListener('click', async () => {
  const r = await window.mgr.modlistRead()
  const box = $('#modlist-summary')
  box.innerHTML = ''
  if (!r.ok) { box.appendChild(el('div', { className: 'card' }, esc(r.error))); return }
  const card = (n, l) => { const c = el('div', { className: 'card' }); c.appendChild(el('div', { className: 'n' }, String(n))); c.appendChild(el('div', { className: 'l' }, l)); return c }
  box.appendChild(card(r.mods.length, 'mods'))
  box.appendChild(card(r.separators.length, 'separators'))
  box.appendChild(card(r.plugins.length, 'plugins'))
  const list = el('div', { className: 'card' })
  list.appendChild(el('div', { className: 'l' }, 'Enabled mods'))
  const ul = el('ul')
  r.mods.slice(0, 400).forEach(m => ul.appendChild(el('li', {}, esc(m))))
  list.appendChild(ul)
  box.appendChild(list)
})
$('#modlist-update').addEventListener('click', async e => {
  e.target.disabled = true
  $('#modlist-log').textContent = ''
  const r = await window.mgr.modlistUpdateManifest()
  appendLog($('#modlist-log'), r.ok ? '\nManifest updated. Restart the backend to serve it.\n' : `\nFailed: ${r.error}\n`)
  e.target.disabled = false
})

let SCHEMA = { serverSettings: [], backendEnv: [] }
let settingsKey = 'serverSettings'
let currentValues = {}

window.mgr.settingsSchema().then(s => { SCHEMA = s; loadSettings() })

$$('.subtab').forEach(sub => {
  sub.addEventListener('click', () => {
    $$('.subtab').forEach(s => s.classList.remove('active'))
    sub.classList.add('active')
    settingsKey = sub.dataset.cfg
    loadSettings()
  })
})

async function loadSettings() {
  const form = $('#settings-form')
  const st = $('#settings-status')
  st.textContent = 'loading…'
  form.innerHTML = ''
  const r = await window.mgr.settingsRead(settingsKey)
  if (!r.ok) { st.textContent = `Error: ${r.error}` + (r.path ? ` (${r.path})` : ''); return }
  currentValues = r.values || {}
  st.textContent = r.path + (r.seeded ? '  (new — seeded from .env.example)' : '')
  renderSettingsForm(r.extra)
}

function renderSettingsForm(extra) {
  const form = $('#settings-form')
  form.innerHTML = ''
  const fields = SCHEMA[settingsKey] || []
  const groups = []
  const byGroup = {}
  for (const f of fields) {
    if (!byGroup[f.group]) { byGroup[f.group] = []; groups.push(f.group) }
    byGroup[f.group].push(f)
  }

  for (const group of groups) {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, esc(group)))
    for (const f of byGroup[group]) fs.appendChild(renderField(f))
    form.appendChild(fs)
  }

  // server-settings.json
  if (settingsKey === 'serverSettings') {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, 'Other (raw JSON)'))
    const wrap = el('div', { className: 'sfield wide' })
    wrap.appendChild(el('label', {}, 'Keys without a dedicated field'))
    const ta = el('textarea', { id: 'settings-extra', rows: 6, spellcheck: false })
    ta.value = extra && Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '{}'
    wrap.appendChild(ta)
    fs.appendChild(wrap)
    form.appendChild(fs)
  }
}

function renderField(f) {
  const wrap = el('div', { className: 'sfield' + (f.type === 'json' ? ' wide' : '') })
  const id = 'set-' + f.key
  wrap.appendChild(el('label', { htmlFor: id }, esc(f.label)))
  const val = currentValues[f.key]

  if (f.type === 'bool') {
    const on = (settingsKey === 'backendEnv') ? String(val).toLowerCase() === 'true' : val === true
    const group = el('div', { className: 'radio-group', id })
    for (const opt of [['On', true], ['Off', false]]) {
      const lbl = el('label', { className: 'radio' })
      const radio = el('input', { type: 'radio', name: id, value: String(opt[1]) })
      if (val !== undefined && opt[1] === on) radio.checked = true
      lbl.appendChild(radio)
      lbl.appendChild(document.createTextNode(' ' + opt[0]))
      group.appendChild(lbl)
    }
    wrap.appendChild(group)
  } else if (f.type === 'select') {
    const sel = el('select', { id, className: 'sinput' })
    const cur = val == null ? '' : String(val)
    const opts = f.options.includes(cur) || cur === '' ? f.options : [cur, ...f.options]
    sel.appendChild(el('option', { value: '' }, '—'))
    for (const o of opts) { const op = el('option', { value: o }, esc(o)); if (o === cur) op.selected = true; sel.appendChild(op) }
    wrap.appendChild(sel)
  } else if (f.type === 'json') {
    const ta = el('textarea', { id, className: 'sinput', rows: 4, spellcheck: false })
    ta.value = val === undefined ? '' : JSON.stringify(val, null, 2)
    wrap.appendChild(ta)
  } else if (f.type === 'secret') {
    const row = el('div', { className: 'secret-row' })
    const inp = el('input', { id, type: 'password', className: 'sinput', value: val == null ? '' : String(val) })
    const toggle = el('button', { type: 'button', className: 'action small reveal' }, 'show')
    toggle.addEventListener('click', () => {
      inp.type = inp.type === 'password' ? 'text' : 'password'
      toggle.textContent = inp.type === 'password' ? 'show' : 'hide'
    })
    row.appendChild(inp); row.appendChild(toggle)
    wrap.appendChild(row)
  } else {
    const inp = el('input', { id, type: f.type === 'number' ? 'number' : 'text', className: 'sinput',
      value: val == null ? '' : String(val), placeholder: f.placeholder || '' })
    wrap.appendChild(inp)
  }

  if (f.help) wrap.appendChild(el('small', {}, esc(f.help)))
  return wrap
}

function collectSettings() {
  const values = {}
  for (const f of (SCHEMA[settingsKey] || [])) {
    const id = 'set-' + f.key
    if (f.type === 'bool') {
      const checked = document.querySelector(`input[name="${id}"]:checked`)
      if (checked) values[f.key] = checked.value === 'true'
    } else {
      const node = document.getElementById(id)
      if (node) values[f.key] = node.value
    }
  }
  return values
}

$('#settings-reload').addEventListener('click', loadSettings)
$('#settings-save').addEventListener('click', async () => {
  const values = collectSettings()
  const extra = settingsKey === 'serverSettings' ? ($('#settings-extra')?.value || '') : undefined
  $('#settings-status').textContent = 'saving…'
  const r = await window.mgr.settingsWrite(settingsKey, values, extra)
  $('#settings-status').textContent = r.ok ? `Saved ${r.path}` : `Error: ${r.error}`
})
