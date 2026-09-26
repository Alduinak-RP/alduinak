'use strict'
// Players tab: every account from MongoDB with filters, sorting, general stats, the account detail and the character popup.
// Account changes (ban, kick, delete, faction ranks) go through the backend or the game console; character edits write the store.

const PROFESSIONS = ['alchemist', 'blacksmith', 'cook', 'hunter', 'miner', 'tailor', 'warrior', 'woodworker']
const FLAG_FILTERS = ['Online', 'GM', 'Banned', 'Dead']
const GENDER_FILTERS = ['Male', 'Female']
const SORTS = {
  profile: ['Profile ID', (a, b) => a.profileId - b.profileId],
  newest:  ['Newest', (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))],
  oldest:  ['Oldest', (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))],
  richest: ['Richest', (a, b) => b.gold - a.gold],
  poorest: ['Poorest', (a, b) => a.gold - b.gold],
  most:    ['Most Played', (a, b) => b.seconds - a.seconds],
  least:   ['Least Played', (a, b) => a.seconds - b.seconds],
}

let rows = []
let races = []
let online = new Map()        // profileId -> online entry
let selected = null           // profileId, or 'stats'
const filters = new Set()

const hours = s => (s / 3600).toFixed(1)
const fmtDate = iso => iso ? String(iso).replace('T', ' ').slice(0, 16) : '-'
const cmHex = id => '0x' + Number(id >>> 0).toString(16).toUpperCase()
const fmtFormDesc = fd => String(fd || '').includes(':') ? String(fd) : '0x' + String(fd || '').toUpperCase()

function parseHex(text, label) {
  const n = parseInt(String(text).trim().replace(/^0x/i, ''), 16)
  if (!Number.isFinite(n) || n < 0) throw new Error(label + ': bad hex id')
  return n >>> 0
}

function parseNum(text, label) {
  const s = String(text).trim()
  const n = Number(s)
  if (!s || !Number.isFinite(n)) throw new Error(label + ': not a number')
  return n
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function renderToolbar() {
  const menu = $('#players-filter-menu')
  menu.innerHTML = ''
  for (const group of [FLAG_FILTERS, GENDER_FILTERS, races]) {
    const box = el('div', { className: 'filter-group' })
    for (const name of group) {
      const label = el('label', { className: 'chk' })
      const cb = el('input', { type: 'checkbox', checked: filters.has(name) })
      cb.addEventListener('change', () => { cb.checked ? filters.add(name) : filters.delete(name); renderList() })
      label.appendChild(cb)
      label.appendChild(document.createTextNode(' ' + name))
      box.appendChild(label)
    }
    menu.appendChild(box)
  }
  const sort = $('#players-sort')
  if (!sort.options.length) for (const [key, [label]] of Object.entries(SORTS)) sort.appendChild(el('option', { value: key }, label))
}

// Flags must all hold; within genders and within races any one is enough
function matches(r) {
  const q = $('#player-search').value.trim().toLowerCase()
  if (q && ![r.name, r.username, r.discordId, String(r.profileId), ...r.characters.map(c => c.name)].some(v => String(v).toLowerCase().includes(q))) return false
  if (filters.has('Online') && !online.has(r.profileId)) return false
  if (filters.has('GM') && !r.gm) return false
  if (filters.has('Banned') && !r.banned) return false
  if (filters.has('Dead') && !r.characters.some(c => c.fallen)) return false
  const genders = GENDER_FILTERS.filter(g => filters.has(g))
  if (genders.length && !r.characters.some(c => genders.includes(c.female ? 'Female' : 'Male'))) return false
  const wanted = races.filter(x => filters.has(x))
  if (wanted.length && !r.characters.some(c => wanted.includes(c.race))) return false
  return true
}

function renderList() {
  const ul = $('#players-list')
  const visible = rows.filter(matches).sort(SORTS[$('#players-sort').value || 'profile'][1])
  $('#players-count').textContent = `${visible.length} / ${rows.length}`
  $('#players-filter-btn').textContent = filters.size ? `Filters (${filters.size})` : 'Filters'
  ul.innerHTML = ''
  const stats = el('li', { className: 'pinned' + (selected === 'stats' ? ' selected' : '') }, '<div class="pl-main"><span class="pl-name">General Stats</span></div>')
  stats.addEventListener('click', showStats)
  ul.appendChild(stats)
  for (const r of visible) {
    const li = el('li', { className: selected === r.profileId ? 'selected' : '' })
    li.innerHTML =
      `<div class="pl-main"><span class="dot ${online.has(r.profileId) ? 'ok' : 'off'}"></span><span class="pl-name">${esc(r.name)}</span>` +
      `${r.banned ? '<span class="badge bad">banned</span>' : ''}</div>` +
      `<div class="pl-sub">${r.characters.length} character${r.characters.length === 1 ? '' : 's'}${r.lastPlayed ? ` · ${esc(r.lastPlayed)}` : ''}</div>`
    li.addEventListener('click', () => showPlayer(r.profileId))
    ul.appendChild(li)
  }
}

async function loadPlayers() {
  const r = await window.mgr.playersList()
  if (!r.ok) { rows = []; $('#players-list').innerHTML = `<li>Error: ${esc(r.error)}</li>`; return }
  rows = r.rows
  races = r.races
  renderToolbar()
  renderList()
  refreshOnline()
}

async function refreshOnline() {
  const r = await window.mgr.playersOnline()
  online = new Map(r.ok ? r.online.map(p => [Number(p.profileId), p]) : [])
  renderList()
}

// ── General stats ─────────────────────────────────────────────────────────────

function showStats() {
  selected = 'stats'
  renderList()
  const box = $('#player-detail')
  box.innerHTML = '<h3>General Stats</h3><p class="muted">Counts every account and living character in the database.</p>'
  const btn = el('button', { className: 'action go' }, 'Generate stats')
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Generating…'
    const r = await window.mgr.playersStats()
    btn.remove()
    if (!r.ok) { box.appendChild(el('p', {}, `Error: ${esc(r.error)}`)); return }
    const s = r.stats
    const table = (title, counts, order) => {
      const keys = order || Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      return `<h4>${esc(title)}</h4><div class="stat-grid">` + keys.map(k => `<span>${esc(k)}</span><b>${counts[k] || 0}</b>`).join('') + '</div>'
    }
    box.insertAdjacentHTML('beforeend',
      `<div class="kv"><b>Accounts</b><span>${s.players}</span></div><div class="kv"><b>Living characters</b><span>${s.characters}</span></div>` +
      table('Race', s.races) + table('Gender', s.genders) + table('Profession', s.professions) +
      table('Hours played', s.hours, s.hourOrder) +
      `<h4>Wealth</h4><div class="kv"><b>Total gold carried</b><span>${s.totalWealth.toLocaleString()}</span></div>` +
      `<div class="kv"><b>Average per account</b><span>${s.averageWealth.toLocaleString()}</span></div>` +
      table('Gold per account', s.wealth, s.wealthOrder))
  })
  box.appendChild(btn)
}

// ── Account detail ────────────────────────────────────────────────────────────

let detail = null

async function showPlayer(profileId) {
  selected = profileId
  renderList()
  const box = $('#player-detail')
  box.innerHTML = '<p class="muted">Loading…</p>'
  const r = await window.mgr.playersDetail(profileId)
  if (!r.ok) { box.innerHTML = `<p>Error: ${esc(r.error)}</p>`; return }
  detail = r
  const p = r.player
  const isOnline = online.has(p.profileId)
  const roles = [p.gm && 'GM', p.dev && 'Developer', p.whitelisted && 'Whitelist'].filter(Boolean)
  const list = items => items.length
    ? '<ul class="mini">' + items.map(e => `<li><code>${esc(e.value)}</code>${e.lastSeen ? ` <span class="muted">last ${esc(fmtDate(e.lastSeen))}</span>` : ''}</li>`).join('') + '</ul>'
    : '<span class="muted">none</span>'
  const factions = r.assignments.length
    ? '<ul class="mini">' + r.assignments.map(a => `<li>${esc(a.faction)} - ${esc(a.rank)}${a.slot === null ? '' : ` <span class="muted">(slot ${a.slot})</span>`}</li>`).join('') + '</ul>'
    : '<span class="muted">none</span>'

  box.innerHTML =
    `<h3><span class="dot ${isOnline ? 'ok' : 'off'}"></span> ${esc(p.name)}</h3>` +
    `<div class="kv"><b>Account</b><span>${esc(p.username || '-')}</span></div>` +
    `<div class="kv"><b>Discord ID</b><span>${esc(p.discordId)}</span></div>` +
    `<div class="kv"><b>Roles</b><span>${roles.length ? roles.map(x => `<span class="badge">${x}</span>`).join(' ') : '<span class="muted">none</span>'}</span></div>` +
    `<div class="kv"><b>Profile ID</b><span>${p.profileId}</span></div>` +
    `<div class="kv"><b>Created</b><span>${esc(fmtDate(p.createdAt))}</span></div>` +
    `<div class="kv"><b>Last seen</b><span>${esc(fmtDate(p.lastSeenAt))}</span></div>` +
    `<div class="kv"><b>Hours played</b><span>${hours(p.seconds)}</span></div>` +
    `<div class="kv"><b>IP addresses</b><span>${list(p.ips)}</span></div>` +
    `<div class="kv"><b>HWIDs</b><span>${list(p.hwids)}</span></div>` +
    `<div class="kv"><b>Factions</b><span>${factions}</span></div>` +
    `<h4>Characters</h4>${r.charError ? `<p class="muted">character data unavailable: ${esc(r.charError)}</p>` : ''}` +
    (p.characters.length ? '<ul class="char-list" id="pd-chars"></ul>' : '<p class="muted">No characters.</p>') +
    '<div class="row">' +
      `<label class="chk"><input type="checkbox" id="pd-ban"${p.banned ? ' checked' : ''} /> Banned</label>` +
      `<button id="pd-kick" class="action small"${isOnline ? '' : ' disabled title="Not online"'}>Kick</button>` +
      `<label class="chk"><input type="checkbox" id="pd-del-chars"${p.characters.length ? '' : ' disabled'} /> with characters</label>` +
      '<button id="pd-delete" class="action small stop">Delete account</button>' +
      '<span id="pd-status" class="status"></span>' +
    '</div>' +
    '<small>Ban, kick and delete go through the backend or the game console, so those services must be running. A deleted account gets a fresh profile id at its next login.</small>'

  const ul = $('#pd-chars')
  for (const c of p.characters) {
    const li = el('li')
    li.innerHTML = `<span class="cname">${esc(c.name)}</span> <span class="cid">${esc(fmtFormDesc(c.formDesc))}</span>` +
      `${c.fallen ? ` <span class="badge">${esc(c.fallen)}</span>` : ''} <span class="muted">${esc(c.race)}, ${c.female ? 'female' : 'male'}</span>`
    li.addEventListener('click', e => { if (!e.target.closest('button')) openCharModal(c) })
    const del = el('button', { className: 'action small stop' }, 'Delete')
    armConfirm(del, 'Delete', async () => {
      const res = await window.mgr.charsDelete(c.formDesc)
      $('#pd-status').textContent = res.ok ? `${c.name} deleted.` : `Error: ${res.error}`
      if (res.ok) { await loadPlayers(); showPlayer(p.profileId) }
    })
    li.appendChild(del)
    ul && ul.appendChild(li)
  }

  $('#pd-ban').addEventListener('change', async e => {
    const on = e.target.checked
    $('#pd-status').textContent = on ? 'banning…' : 'unbanning…'
    const res = await window.mgr.playersBan(p.profileId, on)
    $('#pd-status').textContent = res.ok ? (on ? 'Banned.' : 'Unbanned.') : `Error: ${res.error}`
    if (!res.ok) e.target.checked = !on
    else { p.banned = on; const row = rows.find(x => x.profileId === p.profileId); if (row) row.banned = on; renderList() }
  })
  $('#pd-kick').addEventListener('click', async () => {
    const res = await window.mgr.playersKick(p.profileId)
    $('#pd-status').textContent = res.ok ? 'Kick sent.' : `Error: ${res.error}`
  })
  armConfirm($('#pd-delete'), 'Delete account', async () => {
    const res = await window.mgr.playersDelete(p.profileId, { deleteCharacters: $('#pd-del-chars').checked })
    if (!res.ok) { $('#pd-status').textContent = `Error: ${res.error}`; return }
    selected = null
    box.innerHTML = `<p class="muted">Account deleted${res.deletedChars ? `, with ${res.deletedChars} character${res.deletedChars === 1 ? '' : 's'}` : ''}.</p>`
    loadPlayers()
  })
}

// ── Character popup ───────────────────────────────────────────────────────────

let cmChar = null
let cmEntries = []
let cmItemNames = {}

const cmStatus = text => { $('#cm-status').textContent = text }

function openCharModal(c) {
  cmChar = c
  cmEntries = (c.inventory || []).map(e => ({ ...e }))
  cmItemNames = {}
  $('#cm-title').textContent = `${c.name} (${fmtFormDesc(c.formDesc)})${c.fallen ? `, ${c.fallen}` : ''}`
  cmStatus('')
  renderCmMain()
  renderCmFaction()
  renderCmAppearance()
  renderCmInventory()
  $('#char-modal').hidden = false
  fetchItemNames()
}

function renderCmMain() {
  const c = cmChar
  const pos = c.position ? c.position.map(n => Math.round(n * 100) / 100).join(', ') : ''
  const box = $('#cm-main')
  box.innerHTML =
    `<div class="sfield"><label>Name</label><input id="cm-name" type="text" class="sinput" value="${esc(c.name)}" /></div>` +
    `<div class="sfield"><label>Max health change</label><input id="cm-hp" class="sinput" type="number" value="${c.attrBonus.health}" /></div>` +
    `<div class="sfield"><label>Max stamina change</label><input id="cm-sp" class="sinput" type="number" value="${c.attrBonus.stamina}" /></div>` +
    `<div class="sfield"><label>Max magicka change</label><input id="cm-mp" class="sinput" type="number" value="${c.attrBonus.magicka}" /></div>` +
    `<div class="sfield"><label>Profession</label><select id="cm-prof" class="sinput"><option value="">None</option>${PROFESSIONS.map(x => `<option value="${x}"${x === c.profession ? ' selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>` +
    `<div class="sfield"><label>Hours in profession</label><input id="cm-hours" class="sinput" type="number" min="0" value="${c.professionHours}" /></div>` +
    `<div class="sfield"><label>Coordinates (x, y, z)</label><input id="cm-pos" type="text" class="sinput" value="${esc(pos)}" /></div>` +
    `<div class="sfield"><label>Cell ID</label><input id="cm-cell" type="text" class="sinput" value="${esc(c.worldOrCell || '')}" /></div>`
  const row = el('div', { className: 'row span-all' })
  const save = el('button', { className: 'action go' }, 'Save')
  save.addEventListener('click', saveCmMain)
  row.appendChild(save)
  for (const [realm, label] of [['sovngarde', 'Send to Sovngarde'], ['soulCairn', 'Send to Soul Cairn']]) {
    const b = el('button', { className: 'action small stop' }, label)
    b.disabled = !!c.fallen
    armConfirm(b, label, async () => {
      const r = await window.mgr.charsAfterlife(c.formDesc, realm)
      cmStatus(r.ok ? `Sent to ${label.replace('Send to ', '')}.` : `Error: ${r.error}`)
      if (r.ok) refreshAfterEdit()
    })
    row.appendChild(b)
  }
  const revive = el('button', { className: 'action small go' }, 'Revive')
  revive.disabled = !c.fallen
  armConfirm(revive, 'Revive', async () => {
    const r = await window.mgr.charsRevive(c.formDesc)
    cmStatus(r.ok ? 'Revived, they wake at the Temple of Kynareth.' : `Error: ${r.error}`)
    if (r.ok) refreshAfterEdit()
  })
  row.appendChild(revive)
  box.appendChild(row)
}

async function saveCmMain() {
  try {
    const pos = $('#cm-pos').value.split(/[\s,]+/).filter(Boolean).map(x => parseNum(x, 'Coordinates'))
    const patch = {
      name: $('#cm-name').value,
      attrBonus: { health: parseNum($('#cm-hp').value, 'Max health'), stamina: parseNum($('#cm-sp').value, 'Max stamina'), magicka: parseNum($('#cm-mp').value, 'Max magicka') },
      mastery: { profession: $('#cm-prof').value, hours: parseNum($('#cm-hours').value, 'Hours in profession') },
      location: { worldOrCellDesc: $('#cm-cell').value.trim(), position: pos },
    }
    cmStatus('saving…')
    const r = await window.mgr.charsSave(cmChar.formDesc, patch)
    cmStatus(r.ok ? 'Saved.' : `Error: ${r.error}`)
    if (r.ok) refreshAfterEdit()
  } catch (err) { cmStatus(`Error: ${err.message}`) }
}

// Faction ranks held by this character's slot, and a faction and rank to add
function renderCmFaction() {
  const box = $('#cm-faction')
  box.innerHTML = ''
  const slot = cmChar.slot
  const held = detail.assignments.filter(a => a.slot === slot || a.slot === null)
  for (const a of held) {
    const line = el('div', { className: 'row' })
    line.appendChild(el('span', {}, `${esc(a.faction)} - ${esc(a.rank)}${a.slot === null ? ' <span class="muted">(whole account)</span>' : ''}`))
    const rm = el('button', { className: 'action small stop', title: 'Remove rank' }, '✕')
    armConfirm(rm, '✕', async () => {
      const r = await window.mgr.charsFaction(detail.player.profileId, { remove: a.id })
      cmStatus(r.ok ? 'Rank removed.' : `Error: ${r.error}`)
      if (r.ok) refreshAfterEdit()
    })
    line.appendChild(rm)
    box.appendChild(line)
  }
  const row = el('div', { className: 'row' })
  const fac = el('select', { className: 'sinput' })
  fac.appendChild(el('option', { value: '' }, 'Faction…'))
  for (const f of detail.factions) fac.appendChild(el('option', { value: f.id }, esc(f.name)))
  const rank = el('select', { className: 'sinput' })
  const fillRanks = () => {
    rank.innerHTML = ''
    const f = detail.factions.find(x => x.id === fac.value)
    for (const r of (f ? f.ranks : [])) rank.appendChild(el('option', { value: r.id }, esc(r.rank)))
  }
  fac.addEventListener('change', fillRanks)
  const add = el('button', { className: 'action small go' }, 'Add rank')
  add.addEventListener('click', async () => {
    if (!rank.value) { cmStatus('Pick a faction and a rank'); return }
    const r = await window.mgr.charsFaction(detail.player.profileId, { requirementId: rank.value, slot, playerName: cmChar.name })
    cmStatus(r.ok ? 'Rank added.' : `Error: ${r.error}`)
    if (r.ok) refreshAfterEdit()
  })
  row.appendChild(fac)
  row.appendChild(rank)
  row.appendChild(add)
  box.appendChild(row)
}

// Re-reads the account and reopens the popup on the same character
async function refreshAfterEdit() {
  const formDesc = cmChar && cmChar.formDesc
  const pid = detail.player.profileId
  await loadPlayers()
  await showPlayer(pid)
  const c = detail && detail.player.characters.find(x => x.formDesc === formDesc)
  if (c && !$('#char-modal').hidden) {
    const status = $('#cm-status').textContent
    openCharModal(c)
    cmStatus(status)
  }
}

async function fetchItemNames() {
  const ids = cmEntries.map(e => e.baseId)
  if (!ids.length) return
  const r = await window.mgr.charsItemNames(ids)
  if (!r.ok) return
  cmItemNames = r.names || {}
  renderCmInventory()
}

// key, label, kind (text | bool | hex | number | int | hexlist)
const CM_APPEARANCE_FIELDS = [
  ['isFemale', 'Female', 'bool'],
  ['raceId', 'Race ID', 'hex'],
  ['weight', 'Weight (0-100)', 'number'],
  ['skinColor', 'Skin color (ARGB int)', 'int'],
  ['hairColor', 'Hair color (ARGB int)', 'int'],
  ['headTextureSetId', 'Head texture set', 'hex'],
  ['headpartIds', 'Headparts (hex ids, one per line)', 'hexlist'],
]

function renderCmAppearance() {
  const box = $('#cm-appearance')
  box.innerHTML = '<h4>Appearance</h4>'
  const a = cmChar.appearance
  if (!a) { box.appendChild(el('p', { className: 'muted' }, 'No appearance data on this character.')); return }
  for (const [key, label, kind] of CM_APPEARANCE_FIELDS) {
    const wrap = el('div', { className: 'sfield' })
    wrap.appendChild(el('label', {}, esc(label)))
    if (kind === 'bool') {
      const sel = el('select', { id: 'cma-' + key, className: 'sinput' })
      for (const [t, v] of [['No', 'false'], ['Yes', 'true']]) sel.appendChild(el('option', { value: v, selected: String(!!a[key]) === v }, t))
      wrap.appendChild(sel)
    } else if (kind === 'hexlist') {
      const ta = el('textarea', { id: 'cma-' + key, rows: 5, spellcheck: false })
      ta.value = (Array.isArray(a[key]) ? a[key] : []).map(cmHex).join('\n')
      wrap.appendChild(ta)
    } else {
      const inp = el('input', { id: 'cma-' + key, type: 'text', className: 'sinput' })
      inp.value = kind === 'hex' ? cmHex(a[key] || 0) : String(a[key] ?? '')
      wrap.appendChild(inp)
    }
    box.appendChild(wrap)
  }
  // Full-object escape hatch for morphs, presets and tints
  const adv = el('details')
  adv.appendChild(el('summary', {}, 'All saved appearance data (JSON; overrides the fields above when edited)'))
  const ta = el('textarea', { id: 'cma-raw', rows: 10, spellcheck: false })
  ta.value = JSON.stringify(a, null, 2)
  ta.dataset.initial = ta.value
  adv.appendChild(ta)
  box.appendChild(adv)
  const save = el('button', { className: 'action go' }, 'Save appearance')
  save.addEventListener('click', saveCmAppearance)
  box.appendChild(save)
}

async function saveCmAppearance() {
  try {
    const rawTa = $('#cma-raw')
    let appearance
    if (rawTa && rawTa.value !== rawTa.dataset.initial) {
      appearance = JSON.parse(rawTa.value)
    } else {
      appearance = JSON.parse(JSON.stringify(cmChar.appearance))
      appearance.isFemale = $('#cma-isFemale').value === 'true'
      appearance.raceId = parseHex($('#cma-raceId').value, 'Race ID')
      appearance.weight = parseNum($('#cma-weight').value, 'Weight')
      appearance.skinColor = parseNum($('#cma-skinColor').value, 'Skin color') | 0
      appearance.hairColor = parseNum($('#cma-hairColor').value, 'Hair color') | 0
      appearance.headTextureSetId = parseHex($('#cma-headTextureSetId').value, 'Head texture set')
      appearance.headpartIds = $('#cma-headpartIds').value.split(/[\s,]+/).filter(Boolean).map(x => parseHex(x, 'Headparts'))
    }
    cmStatus('saving appearance…')
    const r = await window.mgr.charsSave(cmChar.formDesc, { appearance })
    cmStatus(r.ok ? 'Appearance saved.' : `Error: ${r.error}`)
    if (r.ok) refreshAfterEdit()
  } catch (err) { cmStatus(`Error: ${err.message}`) }
}

function entryHasExtras(e) {
  return Object.keys(e).some(k => k !== 'baseId' && k !== 'count' && e[k] !== undefined && e[k] !== null && e[k] !== false)
}

function renderCmInventory() {
  const box = $('#cm-inventory')
  box.innerHTML = `<h4>Inventory (${cmEntries.length} stack${cmEntries.length === 1 ? '' : 's'})</h4>`
  const add = el('div', { className: 'inv-add' })
  const idInp = el('input', { type: 'text', placeholder: 'form id, e.g. 0xF' })
  const cntInp = el('input', { type: 'number', value: '1', min: '1' })
  const addBtn = el('button', { className: 'action small' }, 'Add')
  addBtn.addEventListener('click', () => {
    try {
      const baseId = parseHex(idInp.value, 'Form id')
      if (!baseId) throw new Error('Form id: bad hex id')
      const count = Math.max(1, Math.floor(Number(cntInp.value) || 1))
      const stack = cmEntries.find(e => e.baseId === baseId && !entryHasExtras(e))
      if (stack) stack.count += count
      else cmEntries.push({ baseId, count })
      renderCmInventory()
      fetchItemNames()
    } catch (err) { cmStatus(`Error: ${err.message}`) }
  })
  add.append(idInp, cntInp, addBtn)
  box.appendChild(add)
  cmEntries.forEach((e, i) => {
    const row = el('div', { className: 'inv-row' })
    row.appendChild(el('span', { className: 'iid' }, esc(cmHex(e.baseId))))
    const extras = entryHasExtras(e) ? ` <span class="badge" title="${esc(JSON.stringify(e))}">extras</span>` : ''
    row.appendChild(el('span', { className: 'iname' }, esc(cmItemNames[(e.baseId >>> 0).toString(16)] || '') + extras))
    const cnt = el('input', { type: 'number', className: 'icount', value: String(e.count), min: '0' })
    cnt.addEventListener('change', () => { e.count = Math.max(0, Math.floor(Number(cnt.value) || 0)) })
    row.appendChild(cnt)
    const rm = el('button', { className: 'action small stop', title: 'Remove' }, '✕')
    rm.addEventListener('click', () => { cmEntries.splice(i, 1); renderCmInventory() })
    row.appendChild(rm)
    box.appendChild(row)
  })
  const save = el('button', { className: 'action go' }, 'Save inventory')
  save.addEventListener('click', async () => {
    cmStatus('saving inventory…')
    const entries = cmEntries.filter(e => e.count > 0)
    const r = await window.mgr.charsSave(cmChar.formDesc, { invEntries: entries })
    cmStatus(r.ok ? 'Inventory saved.' : `Error: ${r.error}`)
    if (r.ok) refreshAfterEdit()
  })
  box.appendChild(save)
}

function closeCharModal() { $('#char-modal').hidden = true; cmChar = null }
$('#cm-close').addEventListener('click', closeCharModal)
// Close only on a true backdrop click, so a drag that ends on the backdrop never eats edits
let cmDownOnBackdrop = false
$('#char-modal').addEventListener('mousedown', e => { cmDownOnBackdrop = e.target === $('#char-modal') })
$('#char-modal').addEventListener('click', e => { if (cmDownOnBackdrop && e.target === $('#char-modal')) closeCharModal() })

// ── Wiring ────────────────────────────────────────────────────────────────────

// The Factions tab's member links open the account here
function showPlayerByDiscordId(discordId) {
  const row = rows.find(r => r.discordId === String(discordId))
  if (row) showPlayer(row.profileId)
}

$('#players-refresh').addEventListener('click', loadPlayers)
$('#player-search').addEventListener('input', renderList)
$('#players-sort').addEventListener('change', renderList)
$('#players-filter-btn').addEventListener('click', e => { e.stopPropagation(); $('#players-filter-menu').hidden = !$('#players-filter-menu').hidden })
document.addEventListener('click', e => { if (!e.target.closest('#players-filter-menu')) $('#players-filter-menu').hidden = true })
makeResizable($('#players .split'), $('#players-list'), 'playersListWidth')
loadPlayers()
setInterval(() => { if (activeTab() === 'players') refreshOnline() }, 10000)
