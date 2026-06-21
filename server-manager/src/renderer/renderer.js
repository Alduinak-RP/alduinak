'use strict'

const $ = sel => document.querySelector(sel)
const el = (tag, props = {}, html) => Object.assign(document.createElement(tag), props, html != null ? { innerHTML: html } : {})

// ── Tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    $('#' + tab.dataset.tab).classList.add('active')
  })
})

function appendLog(node, text) {
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  node.textContent += text
  if (atBottom) node.scrollTop = node.scrollHeight
}

// ── Console ─────────────────────────────────────────────────────────────────
const logNode = $('#log')
window.mgr.onLog(d => appendLog(logNode, d.text))

async function refreshStatus() {
  const st = await window.mgr.servicesStatus()
  $('#svc-status').textContent = Object.entries(st).map(([k, v]) => `${k.replace('Skyrp', '')}: ${v || '?'}`).join('   ')
}
async function svc(action, btn) {
  btn.disabled = true
  appendLog(logNode, `\n--- ${action} services ---\n`)
  const r = await window.mgr.servicesAction(action)
  if (r.steps) r.steps.forEach(s => appendLog(logNode, s + '\n'))
  if (r.error) appendLog(logNode, 'error: ' + r.error + '\n')
  await refreshStatus()
  btn.disabled = false
}
$('#btn-start').addEventListener('click', e => svc('start', e.target))
$('#btn-stop').addEventListener('click', e => svc('stop', e.target))
$('#btn-restart').addEventListener('click', e => svc('restart', e.target))

// ── Server tab ────────────────────────────────────────────────────────────────
$('#server-build').addEventListener('click', async e => {
  e.target.disabled = true
  $('#server-log').textContent = ''
  appendLog($('#server-log'), 'Rebuilding game server (build-ts)…\n')
  const r = await window.mgr.serverRebuild()
  appendLog($('#server-log'), r.ok ? '\nServer rebuilt and restarted.\n' : `\nFailed: ${r.error}\n`)
  await refreshStatus()
  e.target.disabled = false
})

// ── Settings tab (config editors) ───────────────────────────────────────────────
let settingsKey = 'serverSettings'
async function loadConfig() {
  const ed = $('#settings-editor')
  const st = $('#settings-status')
  st.textContent = 'loading…'
  const r = await window.mgr.configRead(settingsKey)
  if (r.ok) { ed.value = r.content; st.textContent = r.path }
  else { ed.value = ''; st.textContent = `Error: ${r.error}` + (r.path ? ` (${r.path})` : '') }
}
document.querySelectorAll('.subtab').forEach(sub => {
  sub.addEventListener('click', () => {
    document.querySelectorAll('.subtab').forEach(s => s.classList.remove('active'))
    sub.classList.add('active')
    settingsKey = sub.dataset.cfg
    loadConfig()
  })
})
$('#settings-reload').addEventListener('click', loadConfig)
$('#settings-save').addEventListener('click', async () => {
  const r = await window.mgr.configWrite(settingsKey, $('#settings-editor').value)
  $('#settings-status').textContent = r.ok ? `Saved ${r.path}` : `Error: ${r.error}`
})
loadConfig()

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

refreshStatus()
setInterval(refreshStatus, 10000)

// ── Launcher ────────────────────────────────────────────────────────────────
window.mgr.onBuildLog(t => {
  // route build output to the active panel's log (Console uses #log, others .log.small)
  const target = $('.panel.active')?.querySelector('.log') || $('#launcher-log')
  if (target) appendLog(target, t)
})

window.mgr.launcherGetVersion().then(r => { if (r.version) $('#launcher-version').value = r.version })
$('#launcher-save').addEventListener('click', async () => {
  const r = await window.mgr.launcherSetVersion($('#launcher-version').value)
  appendLog($('#launcher-log'), r.ok ? 'Version saved.\n' : 'Error: ' + r.error + '\n')
})
$('#launcher-rebuild').addEventListener('click', async e => {
  e.target.disabled = true
  const r = await window.mgr.launcherRebuild()
  appendLog($('#launcher-log'), r.ok ? `\nDone → ${r.out}\n` : `\nFailed: ${r.error}\n`)
  e.target.disabled = false
})

// ── Modlist ─────────────────────────────────────────────────────────────────
$('#modlist-refresh').addEventListener('click', async () => {
  const r = await window.mgr.modlistRead()
  const box = $('#modlist-summary')
  box.innerHTML = ''
  if (!r.ok) { box.appendChild(el('div', { className: 'card' }, r.error)); return }
  const card = (n, l) => { const c = el('div', { className: 'card' }); c.appendChild(el('div', { className: 'n' }, String(n))); c.appendChild(el('div', { className: 'l' }, l)); return c }
  box.appendChild(card(r.mods.length, 'mods'))
  box.appendChild(card(r.separators.length, 'separators'))
  box.appendChild(card(r.plugins.length, 'plugins'))
  const list = el('div', { className: 'card' })
  list.appendChild(el('div', { className: 'l' }, 'Enabled mods'))
  const ul = el('ul')
  r.mods.slice(0, 400).forEach(m => ul.appendChild(el('li', {}, m)))
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

// ── Client ──────────────────────────────────────────────────────────────────
window.mgr.clientGetVersion().then(r => { if (r.version) $('#client-version').value = r.version })
$('#client-save').addEventListener('click', async () => {
  const r = await window.mgr.clientSetVersion($('#client-version').value)
  appendLog($('#client-log'), r.ok ? 'Version saved.\n' : 'Error: ' + r.error + '\n')
})
$('#client-update').addEventListener('click', async e => {
  e.target.disabled = true
  $('#client-log').textContent = ''
  const r = await window.mgr.clientUpdate()
  appendLog($('#client-log'), r.ok ? '\nClient updated and packaged.\n' : `\nFailed: ${r.error}\n`)
  e.target.disabled = false
})

async function loadPlayers() {
  const ul = $('#players')
  ul.innerHTML = ''
  const r = await window.mgr.playersList()
  if (!r.ok) { ul.appendChild(el('li', {}, 'Error: ' + r.error)); return }
  if (r.players.length === 0) { ul.appendChild(el('li', {}, 'No players yet.')); return }
  r.players.forEach(p => {
    const li = el('li')
    li.appendChild(el('span', {}, p.name))
    if (p.whitelisted) li.appendChild(el('span', { className: 'badge' }, 'whitelist'))
    li.addEventListener('click', () => showPlayer(p.discordId))
    ul.appendChild(li)
  })
}
$('#players-refresh').addEventListener('click', loadPlayers)

async function showPlayer(discordId) {
  const r = await window.mgr.playersDetail(discordId)
  const body = $('#modal-body')
  if (!r.ok) { body.innerHTML = `<p>${r.error}</p>` } else {
    const d = r.discord
    const kv = (k, v) => `<div class="kv"><b>${k}:</b> ${v ?? '—'}</div>`
    const factions = r.factions.length
      ? '<ul>' + r.factions.map(f => `<li>${f.requirement ? `${f.requirement.group} — ${f.requirement.rank}` : f.requirementId}</li>`).join('') + '</ul>'
      : '<p class="muted">None</p>'
    const chars = r.characters.length
      ? '<ul>' + r.characters.map(c => `<li>${c}</li>`).join('') + '</ul>'
      : '<p class="muted">Character list lives in the game-server save store — not wired yet.</p>'
    body.innerHTML =
      `<h3>${d.displayName || d.username || 'Player'}</h3>` +
      `<h4>Discord</h4>` +
      kv('Username', d.username) + kv('Display name', d.displayName) +
      kv('Discord ID', d.discordId) + kv('Profile ID', d.profileId) +
      kv('Notes', d.notes) + kv('Last seen', d.lastSeenAt) +
      `<h4>Factions</h4>${factions}` +
      `<h4>Characters</h4>${chars}`
  }
  $('#modal').classList.remove('hidden')
}
$('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'))
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden') })

loadPlayers()
