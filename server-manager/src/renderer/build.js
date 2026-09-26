'use strict'
// Build tab: game server, launcher and client boxes over one output log. The launcher's build button and the client's
// Update modlist button turn into Update Version once they finish, which publishes that version in versions.json.

const buildLog = () => $('#build-log')
window.mgr.onBuildLog(t => appendLog(buildLog(), t))
window.mgr.onModlistLog(t => appendLog(buildLog(), t))

const DIFF_LIST_CAP = 200
let gameRunning = false
let busy = false

function setBusy(on) {
  busy = on
  $$('#build button.action').forEach(b => { b.disabled = on })
  paintModlistGate()
}

async function loadVersions() {
  for (const [key, get] of [['launcher', window.mgr.launcherGetVersion], ['client', window.mgr.clientGetVersion], ['server', window.mgr.serverGetVersion]]) {
    const r = await get()
    if (r.version) $(`#${key}-version`).value = r.version
  }
  const pub = await window.mgr.versionsPublished()
  if (pub.ok) {
    $('#launcher-live').textContent = `Live: ${pub.versions.launcher || '?'}`
    $('#client-live').textContent = `Live: ${pub.versions.client || '?'}`
  }
}

for (const [key, set] of [['launcher', v => window.mgr.launcherSetVersion(v)], ['client', v => window.mgr.clientSetVersion(v)], ['server', v => window.mgr.serverSetVersion(v)]]) {
  $(`#${key}-save`).addEventListener('click', async () => {
    const r = await set($(`#${key}-version`).value)
    appendLog(buildLog(), r.ok ? `\n${key} version saved.\n` : `\nError: ${r.error}\n`)
  })
}

async function runStep(label, fn) {
  setBusy(true)
  appendLog(buildLog(), `\n######## ${label} ########\n`)
  try {
    const r = await fn()
    appendLog(buildLog(), r.ok ? `\n✓ ${label} done.\n` : `\n✗ ${label} failed: ${r.error}\n`)
    return r
  } finally {
    setBusy(false)
  }
}

$('#build-gamemode').addEventListener('click', () => runStep('Build gamemode', () => window.mgr.buildGamemode()))
$('#build-server').addEventListener('click', () => runStep('Build server', () => window.mgr.buildServer({ native: $('#build-server-native').checked })))
$('#build-client').addEventListener('click', () => runStep('Build client', () => window.mgr.buildClient({ native: $('#build-client-native').checked })))

// A two-state button: its action, then Update Version until that is pressed
function publishButton(btn, key, label, run) {
  btn.dataset.state = 'run'
  btn.textContent = label
  btn.addEventListener('click', async () => {
    if (btn.dataset.state === 'run') {
      const r = await run()
      if (r && r.ok) { btn.dataset.state = 'publish'; btn.textContent = 'Update Version' }
      return
    }
    const r = await runStep(`Publish ${key} version`, () => window.mgr.versionsPublish(key))
    if (r.ok) {
      appendLog(buildLog(), `versions.json now advertises ${key} ${r.version}\n`)
      btn.dataset.state = 'run'
      btn.textContent = label
      loadVersions()
    }
    paintModlistGate()
  })
}

publishButton($('#build-launcher'), 'launcher', 'Build launcher', () => runStep('Build launcher', () => window.mgr.buildLauncher()))
publishButton($('#modlist-run'), 'client', 'Update modlist', async () => {
  const r = await runStep('Update modlist', () => window.mgr.modlistRun())
  renderDiff(r.diff)
  loadPurgeState()
  return r
})

// Update modlist writes the database, so it waits for the game server to stop; publishing needs no stop
function paintModlistGate() {
  const btn = $('#modlist-run')
  const gated = btn.dataset.state === 'run' && gameRunning
  btn.disabled = busy || gated
  $('#modlist-gate').hidden = !gated
}
document.addEventListener('services-status', e => {
  gameRunning = e.detail.game !== 'SERVICE_STOPPED'
  paintModlistGate()
})

function diffCard(n, label, items, cls) {
  const c = el('div', { className: 'card' + (cls ? ' ' + cls : '') })
  c.appendChild(el('div', { className: 'n' }, esc(n)))
  c.appendChild(el('div', { className: 'l' }, esc(label)))
  if (items && items.length) {
    const d = el('details')
    d.appendChild(el('summary', {}, `${items.length} item${items.length === 1 ? '' : 's'}`))
    const ul = el('ul')
    items.slice(0, DIFF_LIST_CAP).forEach(t => ul.appendChild(el('li', {}, esc(t))))
    if (items.length > DIFF_LIST_CAP) ul.appendChild(el('li', { className: 'more' }, `and ${items.length - DIFF_LIST_CAP} more`))
    d.appendChild(ul)
    c.appendChild(d)
  }
  return c
}

// The change report of the last Update modlist, kept only in this window
function renderDiff(diff) {
  const box = $('#modlist-diff')
  box.innerHTML = ''
  if (!diff) return
  const m = diff.mods || {}, p = diff.plugins || {}, f = diff.files || {}, flags = diff.pluginFlags || {}
  const names = list => Array.isArray(list) ? list : []
  const files = list => names(list).map(x => `${x.to} (${x.mod})`)
  const kind = light => light === true ? 'light' : light === false ? 'full' : '?'
  const groups = [
    [names(diff.warnings), 'warnings', 'warn'],
    [names(m.added), 'mods added', 'added'],
    [names(m.removed), 'mods removed', 'removed'],
    [names(m.changed).map(c => `${c.name} (+${c.filesAdded} -${c.filesRemoved} ~${c.filesChanged})`), 'mods changed', 'changed'],
    [names(p.added), 'plugins added', 'added'],
    [names(p.removed), 'plugins removed', 'removed'],
    [names(diff.shiftedPlugins).map(s => `${s.name}: ${s.from} -> ${s.to}`), 'plugins shifted (form ids change)', 'changed'],
    [names(diff.flagChanges).map(n => { const fl = flags[n] || {}; return `${n}: ${kind(fl.light)} -> ${kind(fl.lightNext)}` }), 'light flag changed', 'changed'],
    [files(f.addedList), 'files added', 'added'],
    [files(f.removedList), 'files removed', 'removed'],
    [files(f.changedList), 'files changed', 'changed'],
  ].filter(g => g[0].length)
  if (!groups.length && !p.reordered) box.appendChild(el('div', { className: 'card muted' }, 'No changes since the last modlist'))
  for (const [items, label, cls] of groups) box.appendChild(diffCard(items.length, label, items, cls))
  if (p.reordered) box.appendChild(diffCard('yes', 'plugins reordered', null, 'changed'))
}

// A purge that did not finish leaves its backup recorded; Restore last purge puts it back
async function loadPurgeState() {
  const diff = await window.mgr.modlistDiff()
  $('#modlist-purge-restore').hidden = !(diff && diff.purgeStartedAt && !diff.purgedAt)
}

armConfirm($('#modlist-purge-restore'), 'Restore last purge', async () => {
  const r = await runStep('Restore last purge', () => window.mgr.modlistPurgeRestore())
  if (r.ok) appendLog(buildLog(), `Restored ${r.inserted + r.replaced} document(s). Update modlist again once the cause is fixed.\n`)
  loadPurgeState()
})

loadVersions()
loadPurgeState()
