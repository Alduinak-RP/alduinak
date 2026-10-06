'use strict'
// Players tab: every account from MongoDB with filters, sorting, general stats, the account detail and the character popup.
// Account changes (ban, kick, delete, faction ranks) go through the backend or the game console; character edits write the store.

const PROFESSIONS = ['alchemist', 'blacksmith', 'cook', 'farmer', 'hunter', 'mage', 'miner', 'tailor', 'warrior', 'woodworker']
const RANK_NAMES = [loc('players.rank.free'), loc('players.rank.novice'), loc('players.rank.adept'), loc('players.rank.expert'), loc('players.rank.master'), loc('players.rank.legendary')]
const titleCase = x => x[0].toUpperCase() + x.slice(1)
const craftText = s => s.profession ? loc('players.craftText', { profession: titleCase(s.profession), rank: RANK_NAMES[s.rank] || RANK_NAMES[0], hours: s.hours }) : loc('players.none')

// A profession a sub-slot follows cannot become the primary; main.js applyMastery refuses it too
function profOption(x, c) {
  const sub = x === c.profession ? null : (c.crafts || []).slice(1).find(s => s.profession === x)
  return `<option value="${x}"${x === c.profession ? ' selected' : ''}${sub ? ' disabled' : ''}>${titleCase(x)}${sub ? ' ' + esc(loc('players.subCraft', { slot: sub.name.toLowerCase() })) : ''}</option>`
}
const FLAG_FILTERS = ['Online', 'GM', 'Banned', 'Dead']
const GENDER_FILTERS = ['Male', 'Female']
const FILTER_LABELS = { Online: loc('players.filter.online'), GM: loc('players.filter.gm'), Banned: loc('players.banned'), Dead: loc('players.filter.dead'), Male: loc('players.filter.male'), Female: loc('players.filter.female') }
const SORTS = {
  profile: [loc('players.profileId'), (a, b) => a.profileId - b.profileId],
  newest:  [loc('players.sort.newest'), (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))],
  oldest:  [loc('players.sort.oldest'), (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))],
  richest: [loc('players.sort.richest'), (a, b) => b.gold - a.gold],
  poorest: [loc('players.sort.poorest'), (a, b) => a.gold - b.gold],
  most:    [loc('players.sort.most'), (a, b) => b.seconds - a.seconds],
  least:   [loc('players.sort.least'), (a, b) => a.seconds - b.seconds],
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
  if (!Number.isFinite(n) || n < 0) throw new Error(loc('players.badHex', { label }))
  return n >>> 0
}

function parseNum(text, label) {
  const s = String(text).trim()
  const n = Number(s)
  if (!s || !Number.isFinite(n)) throw new Error(loc('players.notNumber', { label }))
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
      label.appendChild(document.createTextNode(' ' + (FILTER_LABELS[name] || name)))
      box.appendChild(label)
    }
    menu.appendChild(box)
  }
  const sort = $('#players-sort')
  if (!sort.options.length) for (const [key, [label]] of Object.entries(SORTS)) sort.appendChild(el('option', { value: key }, esc(label)))
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
  $('#players-filter-btn').textContent = filters.size ? loc('players.filtersCount', { n: filters.size }) : loc('players.filters')
  ul.innerHTML = ''
  const stats = el('li', { className: 'pinned' + (selected === 'stats' ? ' selected' : '') }, `<div class="pl-main"><span class="pl-name">${esc(loc('players.stats.title'))}</span></div>`)
  stats.addEventListener('click', showStats)
  ul.appendChild(stats)
  for (const r of visible) {
    const li = el('li', { className: selected === r.profileId ? 'selected' : '' })
    li.innerHTML =
      `<div class="pl-main"><span class="dot ${online.has(r.profileId) ? 'ok' : 'off'}"></span><span class="pl-name">${esc(r.name)}</span>` +
      `${r.banned ? `<span class="badge bad">${esc(loc('common.banned'))}</span>` : ''}</div>` +
      `<div class="pl-sub">${esc(loc(r.characters.length === 1 ? 'players.charCountOne' : 'players.charCountMany', { n: r.characters.length }))}${r.lastPlayed ? ` · ${esc(r.lastPlayed)}` : ''}</div>`
    li.addEventListener('click', () => showPlayer(r.profileId))
    ul.appendChild(li)
  }
}

async function loadPlayers() {
  const r = await window.mgr.playersList()
  if (!r.ok) { rows = []; $('#players-list').innerHTML = `<li>${esc(loc('common.error', { error: r.error }))}</li>`; return }
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
  box.innerHTML = `<h3>${esc(loc('players.stats.title'))}</h3><p class="muted">${esc(loc('players.stats.intro'))}</p>`
  const btn = el('button', { className: 'action go' }, esc(loc('players.stats.generate')))
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = loc('players.stats.generating')
    const r = await window.mgr.playersStats()
    btn.remove()
    if (!r.ok) { box.appendChild(el('p', {}, esc(loc('common.error', { error: r.error })))); return }
    const s = r.stats
    const block = (title, body) => `<div class="stat-block"><h4>${esc(title)}</h4>${body}</div>`
    const kv = (label, value) => `<div class="kv"><b>${esc(label)}</b><span>${value}</span></div>`
    const table = (title, counts, order) => {
      const keys = order || Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      return block(title, '<div class="stat-grid">' + keys.map(k => `<span>${esc(k)}</span><b>${counts[k] || 0}</b>`).join('') + '</div>')
    }
    const col = (...blocks) => `<div class="stat-col">${blocks.join('')}</div>`
    box.insertAdjacentHTML('beforeend', '<div class="stat-cols">' +
      col(block(loc('players.stats.totals'), kv(loc('players.stats.accounts'), s.players) + kv(loc('players.stats.living'), s.characters)),
        table(loc('players.stats.gender'), s.genders),
        s.materialError ? block(loc('players.stats.materials'), `<p class="muted">${esc(loc('players.stats.unavailable', { error: s.materialError }))}</p>`) : table(loc('players.stats.materialsAll'), s.materials, s.materialOrder)) +
      col(table(loc('players.hoursPlayed'), s.hours, s.hourOrder), table(loc('players.profession'), s.professions)) +
      col(block(loc('players.stats.wealth'), kv(loc('players.stats.totalGold'), s.totalWealth.toLocaleString()) + kv(loc('players.stats.carried'), s.carriedWealth.toLocaleString()) +
          kv(loc('players.stats.stored'), s.storedWealth.toLocaleString()) + kv(loc('players.stats.average'), s.averageWealth.toLocaleString())),
        table(loc('players.stats.goldPerAccount'), s.wealth, s.wealthOrder), table(loc('players.stats.race'), s.races)) +
      '</div>')
  })
  box.appendChild(btn)
}

// ── Account detail ────────────────────────────────────────────────────────────

let detail = null

async function showPlayer(profileId) {
  selected = profileId
  renderList()
  const box = $('#player-detail')
  box.innerHTML = `<p class="muted">${esc(loc('common.loadingCap'))}</p>`
  const r = await window.mgr.playersDetail(profileId)
  if (!r.ok) { box.innerHTML = `<p>${esc(loc('common.error', { error: r.error }))}</p>`; return }
  detail = r
  const p = r.player
  const isOnline = online.has(p.profileId)
  const roles = [p.gm && loc('players.role.gm'), p.dev && loc('players.role.dev'), p.whitelisted && loc('players.role.whitelist')].filter(Boolean)
  const list = items => items.length
    ? '<ul class="mini">' + items.map(e => `<li><code>${esc(e.value)}</code>${e.lastSeen ? ` <span class="muted">${esc(loc('players.lastShort', { date: fmtDate(e.lastSeen) }))}</span>` : ''}</li>`).join('') + '</ul>'
    : `<span class="muted">${esc(loc('players.noneLower'))}</span>`
  const factions = r.assignments.length
    ? '<ul class="mini">' + r.assignments.map(a => `<li>${esc(a.faction)} - ${esc(a.rank)}${a.slot === null ? '' : ` <span class="muted">${esc(loc('players.slot', { slot: a.slot }))}</span>`}</li>`).join('') + '</ul>'
    : `<span class="muted">${esc(loc('players.noneLower'))}</span>`

  box.innerHTML =
    `<h3><span class="dot ${isOnline ? 'ok' : 'off'}"></span> ${esc(p.name)}</h3>` +
    `<div class="kv"><b>${esc(loc('players.account'))}</b><span>${esc(p.username || '-')}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.discordId'))}</b><span>${esc(p.discordId)}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.roles'))}</b><span>${roles.length ? roles.map(x => `<span class="badge">${esc(x)}</span>`).join(' ') : `<span class="muted">${esc(loc('players.noneLower'))}</span>`}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.profileId'))}</b><span>${p.profileId}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.created'))}</b><span>${esc(fmtDate(p.createdAt))}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.lastSeen'))}</b><span>${esc(fmtDate(p.lastSeenAt))}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.hoursPlayed'))}</b><span>${hours(p.seconds)}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.ips'))}</b><span>${list(p.ips)}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.hwids'))}</b><span>${list(p.hwids)}</span></div>` +
    `<div class="kv"><b>${esc(loc('players.factions'))}</b><span>${factions}</span></div>` +
    `<h4>${esc(loc('players.characters'))}</h4>${r.charError ? `<p class="muted">${esc(loc('players.charError', { error: r.charError }))}</p>` : ''}` +
    (p.characters.length ? '<ul class="char-list" id="pd-chars"></ul>' : `<p class="muted">${esc(loc('players.noChars'))}</p>`) +
    '<div class="row">' +
      `<label class="chk"><input type="checkbox" id="pd-ban"${p.banned ? ' checked' : ''} /> ${esc(loc('players.banned'))}</label>` +
      `<button id="pd-kick" class="action small"${isOnline ? '' : ` disabled title="${esc(loc('players.notOnline'))}"`}>${esc(loc('players.kick'))}</button>` +
      `<label class="chk"><input type="checkbox" id="pd-del-chars"${p.characters.length ? '' : ' disabled'} /> ${esc(loc('players.withChars'))}</label>` +
      `<button id="pd-delete" class="action small stop">${esc(loc('players.deleteAccount'))}</button>` +
      '<span id="pd-status" class="status"></span>' +
    '</div>' +
    `<small>${esc(loc('players.detailHelp'))}</small>`

  const ul = $('#pd-chars')
  for (const c of p.characters) {
    const li = el('li')
    li.innerHTML = `<span class="cname">${esc(c.name)}</span> <span class="cid">${esc(fmtFormDesc(c.formDesc))}</span>` +
      `${c.fallen ? ` <span class="badge">${esc(c.fallen)}</span>` : ''} <span class="muted">${esc(c.race)}, ${esc(c.female ? loc('players.female') : loc('players.male'))}</span>`
    li.addEventListener('click', e => { if (!e.target.closest('button')) openCharModal(c) })
    const del = el('button', { className: 'action small stop' }, esc(loc('common.delete')))
    armConfirm(del, loc('common.delete'), async () => {
      const res = await window.mgr.charsDelete(c.formDesc)
      $('#pd-status').textContent = res.ok ? loc('players.charDeleted', { name: c.name }) : loc('common.error', { error: res.error })
      if (res.ok) { await loadPlayers(); showPlayer(p.profileId) }
    })
    li.appendChild(del)
    ul && ul.appendChild(li)
  }

  $('#pd-ban').addEventListener('change', async e => {
    const on = e.target.checked
    $('#pd-status').textContent = on ? loc('players.banning') : loc('players.unbanning')
    const res = await window.mgr.playersBan(p.profileId, on)
    $('#pd-status').textContent = res.ok ? (on ? loc('players.bannedDone') : loc('players.unbannedDone')) : loc('common.error', { error: res.error })
    if (!res.ok) e.target.checked = !on
    else { p.banned = on; const row = rows.find(x => x.profileId === p.profileId); if (row) row.banned = on; renderList() }
  })
  $('#pd-kick').addEventListener('click', async () => {
    const res = await window.mgr.playersKick(p.profileId)
    $('#pd-status').textContent = res.ok ? loc('players.kickSent') : loc('common.error', { error: res.error })
  })
  armConfirm($('#pd-delete'), loc('players.deleteAccount'), async () => {
    const res = await window.mgr.playersDelete(p.profileId, { deleteCharacters: $('#pd-del-chars').checked })
    if (!res.ok) { $('#pd-status').textContent = loc('common.error', { error: res.error }); return }
    selected = null
    const gone = !res.deletedChars ? loc('players.accountDeleted') : loc(res.deletedChars === 1 ? 'players.accountDeletedOne' : 'players.accountDeletedMany', { n: res.deletedChars })
    box.innerHTML = `<p class="muted">${esc(gone)}</p>`
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
    `<div class="sfield"><label>${esc(loc('players.cm.name'))}</label><input id="cm-name" type="text" class="sinput" value="${esc(c.name)}" /></div>` +
    `<div class="sfield"><label>${esc(loc('players.cm.maxHealthChange'))}</label><input id="cm-hp" class="sinput" type="number" value="${c.attrBonus.health}" /></div>` +
    `<div class="sfield"><label>${esc(loc('players.cm.maxStaminaChange'))}</label><input id="cm-sp" class="sinput" type="number" value="${c.attrBonus.stamina}" /></div>` +
    `<div class="sfield"><label>${esc(loc('players.cm.maxMagickaChange'))}</label><input id="cm-mp" class="sinput" type="number" value="${c.attrBonus.magicka}" /></div>` +
    `<div class="sfield"><label>${esc(loc('players.profession'))}</label><select id="cm-prof" class="sinput"><option value="">${esc(loc('players.none'))}</option>${PROFESSIONS.map(x => profOption(x, c)).join('')}</select></div>` +
    `<div class="sfield"><label>${esc(loc('players.cm.hours'))}</label><input id="cm-hours" class="sinput" type="number" min="0" value="${c.professionHours}" /></div>` +
    (c.crafts || []).slice(1).map(s => `<div class="sfield"><label>${esc(loc('players.cm.craftLabel', { slot: s.name }))}</label><input class="sinput" type="text" readonly title="${esc(loc('players.cm.craftTitle'))}" value="${esc(craftText(s))}" /></div>`).join('') +
    `<div class="sfield"><label>${esc(loc('players.cm.coordsLabel'))}</label><input id="cm-pos" type="text" class="sinput" value="${esc(pos)}" /></div>` +
    `<div class="sfield"><label>${esc(loc('players.cm.cellId'))}</label><input id="cm-cell" type="text" class="sinput" value="${esc(c.worldOrCell || '')}" /></div>`
  const row = el('div', { className: 'row span-all' })
  const save = el('button', { className: 'action go' }, esc(loc('common.save')))
  save.addEventListener('click', saveCmMain)
  row.appendChild(save)
  for (const [realm, label, sent] of [['sovngarde', loc('players.cm.sendSovngarde'), loc('players.cm.sentSovngarde')], ['soulCairn', loc('players.cm.sendSoulCairn'), loc('players.cm.sentSoulCairn')]]) {
    const b = el('button', { className: 'action small stop' }, esc(label))
    b.disabled = !!c.fallen
    armConfirm(b, label, async () => {
      const r = await window.mgr.charsAfterlife(c.formDesc, realm)
      cmStatus(r.ok ? sent : loc('common.error', { error: r.error }))
      if (r.ok) refreshAfterEdit()
    })
    row.appendChild(b)
  }
  const revive = el('button', { className: 'action small go' }, esc(loc('players.cm.revive')))
  revive.disabled = !c.fallen
  armConfirm(revive, loc('players.cm.revive'), async () => {
    const r = await window.mgr.charsRevive(c.formDesc)
    cmStatus(r.ok ? loc('players.cm.revived') : loc('common.error', { error: r.error }))
    if (r.ok) refreshAfterEdit()
  })
  row.appendChild(revive)
  box.appendChild(row)
}

async function saveCmMain() {
  try {
    const pos = $('#cm-pos').value.split(/[\s,]+/).filter(Boolean).map(x => parseNum(x, loc('players.cm.coords')))
    const patch = {
      name: $('#cm-name').value,
      attrBonus: { health: parseNum($('#cm-hp').value, loc('players.cm.maxHealth')), stamina: parseNum($('#cm-sp').value, loc('players.cm.maxStamina')), magicka: parseNum($('#cm-mp').value, loc('players.cm.maxMagicka')) },
      mastery: { profession: $('#cm-prof').value, hours: parseNum($('#cm-hours').value, loc('players.cm.hours')) },
      location: { worldOrCellDesc: $('#cm-cell').value.trim(), position: pos },
    }
    cmStatus(loc('common.saving'))
    const r = await window.mgr.charsSave(cmChar.formDesc, patch)
    cmStatus(r.ok ? loc('players.cm.saved') : loc('common.error', { error: r.error }))
    if (r.ok) refreshAfterEdit()
  } catch (err) { cmStatus(loc('common.error', { error: err.message })) }
}

// Faction ranks held by this character's slot, and a faction and rank to add
function renderCmFaction() {
  const box = $('#cm-faction')
  box.innerHTML = ''
  const slot = cmChar.slot
  const held = detail.assignments.filter(a => a.slot === slot || a.slot === null)
  for (const a of held) {
    const line = el('div', { className: 'row' })
    line.appendChild(el('span', {}, `${esc(a.faction)} - ${esc(a.rank)}${a.slot === null ? ` <span class="muted">${esc(loc('players.cm.wholeAccount'))}</span>` : ''}`))
    const rm = el('button', { className: 'action small stop', title: loc('players.cm.removeRank') }, '✕')
    armConfirm(rm, '✕', async () => {
      const r = await window.mgr.charsFaction(detail.player.profileId, { remove: a.id })
      cmStatus(r.ok ? loc('players.cm.rankRemoved') : loc('common.error', { error: r.error }))
      if (r.ok) refreshAfterEdit()
    })
    line.appendChild(rm)
    box.appendChild(line)
  }
  const row = el('div', { className: 'row' })
  const fac = el('select', { className: 'sinput' })
  fac.appendChild(el('option', { value: '' }, esc(loc('players.cm.factionPick'))))
  const groups = new Map()
  for (const f of detail.factions) {
    if (!groups.has(f.province)) groups.set(f.province, fac.appendChild(el('optgroup', { label: f.province })))
    groups.get(f.province).appendChild(el('option', { value: f.id }, esc(f.name)))
  }
  const rank = el('select', { className: 'sinput' })
  const fillRanks = () => {
    rank.innerHTML = ''
    const f = detail.factions.find(x => x.id === fac.value)
    for (const r of (f ? f.ranks : [])) rank.appendChild(el('option', { value: r.id }, esc(r.rank)))
  }
  fac.addEventListener('change', fillRanks)
  const add = el('button', { className: 'action small go' }, esc(loc('players.cm.addRank')))
  add.addEventListener('click', async () => {
    if (!rank.value) { cmStatus(loc('players.cm.pickRank')); return }
    const r = await window.mgr.charsFaction(detail.player.profileId, { requirementId: rank.value, slot, playerName: cmChar.name })
    cmStatus(r.ok ? loc('players.cm.rankAdded') : loc('common.error', { error: r.error }))
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
  ['isFemale', loc('players.filter.female'), 'bool'],
  ['raceId', loc('players.cm.raceId'), 'hex'],
  ['weight', loc('players.cm.weightLabel'), 'number'],
  ['skinColor', loc('players.cm.skinColorLabel'), 'int'],
  ['hairColor', loc('players.cm.hairColorLabel'), 'int'],
  ['headTextureSetId', loc('players.cm.headTexture'), 'hex'],
  ['headpartIds', loc('players.cm.headpartsLabel'), 'hexlist'],
]

function renderCmAppearance() {
  const box = $('#cm-appearance')
  box.innerHTML = `<h4>${esc(loc('players.cm.appearance'))}</h4>`
  const a = cmChar.appearance
  if (!a) { box.appendChild(el('p', { className: 'muted' }, esc(loc('players.cm.noAppearance')))); return }
  for (const [key, label, kind] of CM_APPEARANCE_FIELDS) {
    const wrap = el('div', { className: 'sfield' })
    wrap.appendChild(el('label', {}, esc(label)))
    if (kind === 'bool') {
      const sel = el('select', { id: 'cma-' + key, className: 'sinput' })
      for (const [t, v] of [[loc('players.cm.no'), 'false'], [loc('players.cm.yes'), 'true']]) sel.appendChild(el('option', { value: v, selected: String(!!a[key]) === v }, esc(t)))
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
  adv.appendChild(el('summary', {}, esc(loc('players.cm.rawAppearance'))))
  const ta = el('textarea', { id: 'cma-raw', rows: 10, spellcheck: false })
  ta.value = JSON.stringify(a, null, 2)
  ta.dataset.initial = ta.value
  adv.appendChild(ta)
  box.appendChild(adv)
  const save = el('button', { className: 'action go' }, esc(loc('players.cm.saveAppearance')))
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
      appearance.raceId = parseHex($('#cma-raceId').value, loc('players.cm.raceId'))
      appearance.weight = parseNum($('#cma-weight').value, loc('players.cm.weight'))
      appearance.skinColor = parseNum($('#cma-skinColor').value, loc('players.cm.skinColor')) | 0
      appearance.hairColor = parseNum($('#cma-hairColor').value, loc('players.cm.hairColor')) | 0
      appearance.headTextureSetId = parseHex($('#cma-headTextureSetId').value, loc('players.cm.headTexture'))
      appearance.headpartIds = $('#cma-headpartIds').value.split(/[\s,]+/).filter(Boolean).map(x => parseHex(x, loc('players.cm.headparts')))
    }
    cmStatus(loc('players.cm.savingAppearance'))
    const r = await window.mgr.charsSave(cmChar.formDesc, { appearance })
    cmStatus(r.ok ? loc('players.cm.appearanceSaved') : loc('common.error', { error: r.error }))
    if (r.ok) refreshAfterEdit()
  } catch (err) { cmStatus(loc('common.error', { error: err.message })) }
}

function entryHasExtras(e) {
  return Object.keys(e).some(k => k !== 'baseId' && k !== 'count' && e[k] !== undefined && e[k] !== null && e[k] !== false)
}

function renderCmInventory() {
  const box = $('#cm-inventory')
  box.innerHTML = `<h4>${esc(loc(cmEntries.length === 1 ? 'players.cm.inventoryOne' : 'players.cm.inventoryMany', { n: cmEntries.length }))}</h4>`
  const add = el('div', { className: 'inv-add' })
  const idInp = el('input', { type: 'text', placeholder: loc('players.cm.formIdPlaceholder') })
  const cntInp = el('input', { type: 'number', value: '1', min: '1' })
  const addBtn = el('button', { className: 'action small' }, esc(loc('players.cm.add')))
  addBtn.addEventListener('click', () => {
    try {
      const baseId = parseHex(idInp.value, loc('players.cm.formId'))
      if (!baseId) throw new Error(loc('players.badHex', { label: loc('players.cm.formId') }))
      const count = Math.max(1, Math.floor(Number(cntInp.value) || 1))
      const stack = cmEntries.find(e => e.baseId === baseId && !entryHasExtras(e))
      if (stack) stack.count += count
      else cmEntries.push({ baseId, count })
      renderCmInventory()
      fetchItemNames()
    } catch (err) { cmStatus(loc('common.error', { error: err.message })) }
  })
  add.append(idInp, cntInp, addBtn)
  box.appendChild(add)
  cmEntries.forEach((e, i) => {
    const row = el('div', { className: 'inv-row' })
    row.appendChild(el('span', { className: 'iid' }, esc(cmHex(e.baseId))))
    const extras = entryHasExtras(e) ? ` <span class="badge" title="${esc(JSON.stringify(e))}">${esc(loc('players.cm.extras'))}</span>` : ''
    row.appendChild(el('span', { className: 'iname' }, esc(cmItemNames[(e.baseId >>> 0).toString(16)] || '') + extras))
    const cnt = el('input', { type: 'number', className: 'icount', value: String(e.count), min: '0' })
    cnt.addEventListener('change', () => { e.count = Math.max(0, Math.floor(Number(cnt.value) || 0)) })
    row.appendChild(cnt)
    const rm = el('button', { className: 'action small stop', title: loc('players.cm.remove') }, '✕')
    rm.addEventListener('click', () => { cmEntries.splice(i, 1); renderCmInventory() })
    row.appendChild(rm)
    box.appendChild(row)
  })
  const save = el('button', { className: 'action go' }, esc(loc('players.cm.saveInventory')))
  save.addEventListener('click', async () => {
    cmStatus(loc('players.cm.savingInventory'))
    const entries = cmEntries.filter(e => e.count > 0)
    const r = await window.mgr.charsSave(cmChar.formDesc, { invEntries: entries })
    cmStatus(r.ok ? loc('players.cm.inventorySaved') : loc('common.error', { error: r.error }))
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
