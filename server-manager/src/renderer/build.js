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
  $('#launcher-live').textContent = loc('build.launcher.live', { version: v.launcher || '?' })
  $('#launcher-url').value = v.launcherUrl || ''
  $('#server-live-version').value = v.server || ''
  $('#client-live-version').value = v.client || ''
  $('#server-test-published').textContent = loc('build.published', { version: t.server || '?' })
  $('#client-test-published').textContent = loc('build.published', { version: t.client || '?' })
  for (const [side, src] of [['live', v], ['test', t]]) {
    $(`#migrate-${side}-server`).value = src.server || ''
    $(`#migrate-${side}-client`).value = src.client || ''
    $(`#migrate-${side}-now`).textContent = loc('build.migrate.now', { server: src.server || '?', client: src.client || '?' })
  }
}

async function saveVersion(label, run) {
  const r = await run()
  appendLog(buildLog(), '\n' + (r.ok ? loc('build.saved', { label }) : loc('common.error', { error: r.error })) + '\n')
  if (r.ok) loadVersions()
}

// The filled server and client fields of a Migrate row: root keys for live, the test block for test
async function saveMigrateRow(side) {
  const prefix = side === 'test' ? 'test.' : ''
  const filled = ['server', 'client'].map(k => [k, $(`#migrate-${side}-${k}`).value.trim()]).filter(([, v]) => v)
  if (!filled.length) return { ok: false, error: loc('build.migrate.fillFirst') }
  for (const [k, v] of filled) {
    const r = await window.mgr.versionsSet(prefix + k, v)
    if (!r.ok) return { ok: false, error: `${k}: ${r.error}` }
  }
  return { ok: true }
}

const versionSavers = [
  ['#launcher-save', loc('build.saver.launcher'), () => window.mgr.launcherSetVersion($('#launcher-version').value)],
  ['#launcher-url-save', loc('build.saver.launcherUrl'), () => window.mgr.versionsSet('launcherUrl', $('#launcher-url').value)],
  ['#client-save', loc('build.saver.clientTest'), () => window.mgr.clientSetVersion($('#client-version').value)],
  ['#server-save', loc('build.saver.serverTest'), () => window.mgr.serverSetVersion($('#server-version').value)],
  ['#client-live-save', loc('build.saver.clientLive'), () => window.mgr.versionsSet('client', $('#client-live-version').value)],
  ['#server-live-save', loc('build.saver.serverLive'), () => window.mgr.versionsSet('server', $('#server-live-version').value)],
  ['#migrate-live-save', loc('build.saver.migrateLive'), () => saveMigrateRow('live')],
  ['#migrate-test-save', loc('build.saver.migrateTest'), () => saveMigrateRow('test')],
]
for (const [sel, label, run] of versionSavers) $(sel).addEventListener('click', () => saveVersion(label, run))

// Copy test build: each field from its own package.json
async function copyTestBuild(side) {
  const [server, client] = await Promise.all([window.mgr.serverGetVersion(), window.mgr.clientGetVersion()])
  for (const [k, r] of [['server', server], ['client', client]]) {
    if (r.version) $(`#migrate-${side}-${k}`).value = r.version
    else appendLog(buildLog(), '\n' + loc('common.error', { error: r.error || loc('build.noVersion', { component: k }) }) + '\n')
  }
}
$('#migrate-live-copy').addEventListener('click', () => copyTestBuild('live'))
$('#migrate-test-copy').addEventListener('click', () => copyTestBuild('test'))

async function runStep(label, fn) {
  setBusy(true)
  appendLog(buildLog(), `\n######## ${label} ########\n`)
  try {
    const r = await fn()
    appendLog(buildLog(), '\n' + (r.ok ? loc('build.stepDone', { label }) : loc('build.stepFailed', { label, error: r.error })) + '\n')
    return r
  } finally {
    setBusy(false)
  }
}

$('#build-gamemode').addEventListener('click', () => runStep(loc('build.step.gamemode'), () => window.mgr.buildGamemode()))
$('#build-server').addEventListener('click', () => runStep(loc('build.server.button'), () => window.mgr.buildServer({ native: $('#build-server-native').checked })))

// Update modlist for the test server; an unchanged MO2 modlist reports so and changes nothing
async function updateModlist() {
  const r = await runStep(loc('build.client.updateModlist'), () => window.mgr.modlistRun(TEST))
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
      if (r && r.ok) { btn.dataset.state = 'publish'; btn.textContent = loc('build.updateVersion') }
      return
    }
    const r = await runStep(loc('build.step.publish', { component: key }), () => window.mgr.versionsPublish(key))
    if (r.ok) {
      appendLog(buildLog(), loc('build.advertises', { component: key, version: r.version }) + '\n')
      btn.dataset.state = 'run'
      btn.textContent = label
      loadVersions()
    }
    paintGates()
  })
}

publishButton($('#build-launcher'), 'launcher', loc('build.launcher.button'), () => runStep(loc('build.launcher.button'), () => window.mgr.buildLauncher()))

// Build client -> Update Modlist -> Update Version (publishes test.client from skymp5-client/package.json) -> Build client
const clientBtn = $('#build-client')
const CLIENT_STEPS = [
  [loc('build.client.button'), () => runStep(loc('build.client.button'), () => window.mgr.buildClient({ native: $('#build-client-native').checked }))],
  [loc('build.client.updateModlistStep'), async () => {
    const r = await updateModlist()
    // Nothing new in MO2 means the Nexus files were not installed there yet, so the version is not published
    if (r.ok && r.unchanged) { appendLog(buildLog(), loc('build.client.installFirst') + '\n'); return { ok: false } }
    return r
  }],
  [loc('build.updateVersion'), async () => {
    const r = await runStep(loc('build.step.publishTestClient'), () => window.mgr.versionsPublish('test.client'))
    if (r.ok) { appendLog(buildLog(), loc('build.advertisesTestClient', { version: r.version }) + '\n'); loadVersions() }
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
const MIGRATE_LABELS = [loc('build.migrate.server'), loc('build.migrate.settings')]
let migrateStep = 0
armConfirm(migrateBtn, MIGRATE_LABELS[0], async () => {
  if (migrateStep === 0) {
    const r = await runStep(loc('build.migrate.server'), () => window.mgr.migrateServer())
    if (r.ok) migrateStep = 1
  } else {
    await runStep(loc('build.migrate.settings'), () => window.mgr.migrateSettings())
    migrateStep = 0
  }
  migrateBtn.dataset.label = MIGRATE_LABELS[migrateStep]
  migrateBtn.textContent = migrateBtn.dataset.label
})

armConfirm($('#migrate-client'), loc('build.migrate.client'), async () => {
  const r = await runStep(loc('build.migrate.client'), () => window.mgr.migrateClient())
  renderDiff(r.diff)
})

// Modlist and migrate write a server's database and files, so they wait for that game server to stop
function paintGates() {
  const testUp = serviceState['test-game'] !== 'SERVICE_STOPPED'
  const liveUp = serviceState.game !== 'SERVICE_STOPPED'
  $('#modlist-run').disabled = busy || testUp
  clientBtn.disabled = busy || (clientStep === 1 && testUp)
  const mg = $('#modlist-gate')
  mg.hidden = !testUp
  mg.textContent = /^SERVICE_/.test(serviceState['test-game'] || '') ? loc('build.gate.testStopped') : loc('build.gate.testMissing')
  for (const sel of ['#migrate-server', '#migrate-client']) $(sel).disabled = busy || liveUp
  const lg = $('#migrate-gate')
  lg.hidden = !liveUp
  lg.textContent = /^SERVICE_/.test(serviceState.game || '') ? loc('build.gate.mainStopped') : loc('build.gate.mainMissing')
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
    d.appendChild(el('summary', {}, esc(loc(items.length === 1 ? 'build.diff.itemsOne' : 'build.diff.itemsMany', { n: items.length }))))
    const ul = el('ul')
    items.slice(0, DIFF_LIST_CAP).forEach(t => ul.appendChild(el('li', {}, esc(t))))
    if (items.length > DIFF_LIST_CAP) ul.appendChild(el('li', { className: 'more' }, esc(loc('build.diff.more', { n: items.length - DIFF_LIST_CAP }))))
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
  const kind = light => light === true ? loc('build.diff.light') : light === false ? loc('build.diff.full') : '?'
  const groups = [
    [names(diff.warnings), loc('build.diff.warnings'), 'warn'],
    [names(m.added), loc('build.diff.modsAdded'), 'added'],
    [names(m.removed), loc('build.diff.modsRemoved'), 'removed'],
    [names(m.changed).map(changedModLine), loc('build.diff.modsChanged'), 'changed'],
    [names(p.added), loc('build.diff.pluginsAdded'), 'added'],
    [names(p.removed), loc('build.diff.pluginsRemoved'), 'removed'],
    [names(diff.shiftedPlugins).map(s => `${s.name}: ${s.from} -> ${s.to}`), loc('build.diff.pluginsShifted'), 'changed'],
    [names(diff.flagChanges).map(n => { const fl = flags[n] || {}; return `${n}: ${kind(fl.light)} -> ${kind(fl.lightNext)}` }), loc('build.diff.flagChanged'), 'changed'],
    [files(f.addedList), loc('build.diff.filesAdded'), 'added'],
    [files(f.removedList), loc('build.diff.filesRemoved'), 'removed'],
    [files(f.changedList), loc('build.diff.filesChanged'), 'changed'],
  ].filter(g => g[0].length)
  if (!groups.length && !p.reordered) box.appendChild(el('div', { className: 'card muted' }, esc(loc('build.diff.none'))))
  for (const [items, label, cls] of groups) box.appendChild(diffCard(items.length, label, items, cls))
  if (p.reordered) box.appendChild(diffCard(loc('build.diff.yes'), loc('build.diff.reordered'), null, 'changed'))
}

// A purge that did not finish leaves its backup recorded; Restore last purge puts it back
async function loadPurgeState() {
  const diff = await window.mgr.modlistDiff(TEST)
  $('#modlist-purge-restore').hidden = !(diff && diff.purgeStartedAt && !diff.purgedAt)
}

armConfirm($('#modlist-purge-restore'), loc('build.client.restorePurge'), async () => {
  const r = await runStep(loc('build.client.restorePurge'), () => window.mgr.modlistPurgeRestore(TEST))
  if (r.ok) appendLog(buildLog(), loc('build.client.restored', { n: r.inserted + r.replaced }) + '\n')
  loadPurgeState()
})

loadVersions()
loadPurgeState()
paintGates()
