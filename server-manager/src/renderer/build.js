'use strict'
// Build tab: Server, Client, Migrate and Launcher boxes over one output log. Every build targets the test server; the Migrate box
// copies a tested build to the live one. Build client walks Build client -> Update Modlist -> Update Version, Migrate server -> Migrate settings.

const buildLog = () => $('#build-log')
window.mgr.onBuildLog(t => appendLog(buildLog(), t))
window.mgr.onModlistLog(t => appendLog(buildLog(), t))

const DIFF_LIST_CAP = 200
const TEST = 'test'
let serviceState = {}
let busy = false

function setBusy(on) {
  busy = on
  $$('#build button.action').forEach(b => { b.disabled = on })
  paintGates()
}

// Package versions fill the Test fields, versions.json the Live fields and the published notes
async function loadVersions() {
  for (const [key, get] of [['launcher', window.mgr.launcherGetVersion], ['client', window.mgr.clientGetVersion], ['server', window.mgr.serverGetVersion]]) {
    const r = await get()
    if (r.version) $(`#${key}-version`).value = r.version
  }
  const pub = await window.mgr.versionsPublished()
  if (!pub.ok) return
  const v = pub.versions
  const t = v.test || {}
  $('#launcher-live').textContent = `Live: ${v.launcher || '?'}`
  $('#server-live-version').value = v.server || ''
  $('#client-live-version').value = v.client || ''
  $('#server-test-published').textContent = `(published ${t.server || '?'})`
  $('#client-test-published').textContent = `(published ${t.client || '?'})`
  $('#migrate-live-version').value = v.client || v.server || ''
  $('#migrate-test-version').value = t.client || t.server || ''
  $('#migrate-live-now').textContent = `(client ${v.client || '?'}, server ${v.server || '?'})`
  $('#migrate-test-now').textContent = `(client ${t.client || '?'}, server ${t.server || '?'})`
}

async function saveVersion(label, run) {
  const r = await run()
  appendLog(buildLog(), r.ok ? `\n${label} saved.\n` : `\nError: ${r.error}\n`)
  if (r.ok) loadVersions()
}

// Both versions.json keys of a server side: the root pair for live, the test block for test
async function setPair(prefix, version) {
  for (const key of ['client', 'server']) {
    const r = await window.mgr.versionsSet(prefix + key, version)
    if (!r.ok) return r
  }
  return { ok: true }
}

const versionSavers = [
  ['#launcher-save', 'launcher version', () => window.mgr.launcherSetVersion($('#launcher-version').value)],
  ['#client-save', 'client test version', () => window.mgr.clientSetVersion($('#client-version').value)],
  ['#server-save', 'server test version', () => window.mgr.serverSetVersion($('#server-version').value)],
  ['#client-live-save', 'client live version', () => window.mgr.versionsSet('client', $('#client-live-version').value)],
  ['#server-live-save', 'server live version', () => window.mgr.versionsSet('server', $('#server-live-version').value)],
  ['#migrate-live-save', 'live client and server versions', () => setPair('', $('#migrate-live-version').value)],
  ['#migrate-test-save', 'test client and server versions', () => setPair('test.', $('#migrate-test-version').value)],
]
for (const [sel, label, run] of versionSavers) $(sel).addEventListener('click', () => saveVersion(label, run))

// Copy test build: the client package version, with a note when the server package differs
async function copyTestBuild(input) {
  const [client, server] = await Promise.all([window.mgr.clientGetVersion(), window.mgr.serverGetVersion()])
  if (!client.version) return appendLog(buildLog(), `\nError: ${client.error || 'no client version'}\n`)
  input.value = client.version
  if (server.version && server.version !== client.version) appendLog(buildLog(), `\nnote: skymp5-server/package.json is ${server.version}, skymp5-client/package.json ${client.version}; the field took the client's\n`)
}
$('#migrate-live-copy').addEventListener('click', () => copyTestBuild($('#migrate-live-version')))
$('#migrate-test-copy').addEventListener('click', () => copyTestBuild($('#migrate-test-version')))

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

// Update modlist for the test server; an unchanged MO2 modlist reports so and changes nothing
async function updateModlist() {
  const r = await runStep('Update modlist', () => window.mgr.modlistRun(TEST))
  renderDiff(r.diff)
  loadPurgeState()
  return r
}
$('#modlist-run').addEventListener('click', updateModlist)

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
    paintGates()
  })
}

publishButton($('#build-launcher'), 'launcher', 'Build launcher', () => runStep('Build launcher', () => window.mgr.buildLauncher()))

// Build client -> Update Modlist -> Update Version (publishes test.client from skymp5-client/package.json) -> Build client
const clientBtn = $('#build-client')
const CLIENT_STEPS = [
  ['Build client', () => runStep('Build client', () => window.mgr.buildClient({ native: $('#build-client-native').checked }))],
  ['Update Modlist', async () => {
    const r = await updateModlist()
    // Nothing new in MO2 means the Nexus files were not installed there yet, so the version is not published
    if (r.ok && r.unchanged) { appendLog(buildLog(), 'Install the new Alduinak Client Files into MO2 first, then press Update Modlist again.\n'); return { ok: false } }
    return r
  }],
  ['Update Version', async () => {
    const r = await runStep('Publish test client version', () => window.mgr.versionsPublish('test.client'))
    if (r.ok) { appendLog(buildLog(), `versions.json now advertises test client ${r.version}\n`); loadVersions() }
    return r
  }],
]
let clientStep = 0
clientBtn.addEventListener('click', async () => {
  const r = await CLIENT_STEPS[clientStep][1]()
  if (r && r.ok) clientStep = (clientStep + 1) % CLIENT_STEPS.length
  clientBtn.textContent = CLIENT_STEPS[clientStep][0]
  paintGates()
})

// Migrate server -> Migrate settings -> Migrate server; both clicks ask for confirmation
const migrateBtn = $('#migrate-server')
const MIGRATE_LABELS = ['Migrate server', 'Migrate settings']
let migrateStep = 0
armConfirm(migrateBtn, MIGRATE_LABELS[0], async () => {
  if (migrateStep === 0) {
    const r = await runStep('Migrate server', () => window.mgr.migrateServer())
    if (r.ok) migrateStep = 1
  } else {
    await runStep('Migrate settings', () => window.mgr.migrateSettings())
    migrateStep = 0
  }
  migrateBtn.dataset.label = MIGRATE_LABELS[migrateStep]
  migrateBtn.textContent = migrateBtn.dataset.label
})

armConfirm($('#migrate-client'), 'Migrate client', async () => {
  const r = await runStep('Migrate client', () => window.mgr.migrateClient())
  renderDiff(r.diff)
})

// Modlist and migrate write a server's database and files, so they wait for that game server to stop
const gateText = st => (/^SERVICE_/.test(st || '') ? 'must be stopped' : 'service is not installed')
function paintGates() {
  const testUp = serviceState['test-game'] !== 'SERVICE_STOPPED'
  const liveUp = serviceState.game !== 'SERVICE_STOPPED'
  $('#modlist-run').disabled = busy || testUp
  clientBtn.disabled = busy || (clientStep === 1 && testUp)
  const mg = $('#modlist-gate')
  mg.hidden = !testUp
  mg.textContent = `Test server ${gateText(serviceState['test-game'])}`
  for (const sel of ['#migrate-server', '#migrate-client']) $(sel).disabled = busy || liveUp
  const lg = $('#migrate-gate')
  lg.hidden = !liveUp
  lg.textContent = `Main server ${gateText(serviceState.game)}`
}
document.addEventListener('services-status', e => {
  serviceState = e.detail || {}
  paintGates()
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

// "name: v1 -> v2" for a version bump, with the file counts when files moved too
function changedModLine(c) {
  const counts = c.filesAdded || c.filesRemoved || c.filesChanged ? ` (+${c.filesAdded} -${c.filesRemoved} ~${c.filesChanged})` : ''
  return c.versionFrom !== undefined ? `${c.name}: ${c.versionFrom || '?'} -> ${c.versionTo || '?'}${counts}` : `${c.name}${counts}`
}

// The change report of the last Update modlist or Migrate client, kept only in this window
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
    [names(m.changed).map(changedModLine), 'mods changed', 'changed'],
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
  const diff = await window.mgr.modlistDiff(TEST)
  $('#modlist-purge-restore').hidden = !(diff && diff.purgeStartedAt && !diff.purgedAt)
}

armConfirm($('#modlist-purge-restore'), 'Restore last purge', async () => {
  const r = await runStep('Restore last purge', () => window.mgr.modlistPurgeRestore(TEST))
  if (r.ok) appendLog(buildLog(), `Restored ${r.inserted + r.replaced} document(s). Update modlist again once the cause is fixed.\n`)
  loadPurgeState()
})

loadVersions()
loadPurgeState()
paintGates()
