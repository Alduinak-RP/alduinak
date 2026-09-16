const config = window.ALDUINAK_DASHBOARD_CONFIG || {}
const apiBaseUrl = (config.apiBaseUrl || '').replace(/\/$/, '')
const tokenKey = 'alduinak.dashboard.token'
const loginNonceKey = 'alduinak.dashboard.loginNonce'

const state = {
  token: localStorage.getItem(tokenKey) || '',
  user: null,
  players: [],
  selectedProfileId: null,
  factions: [],
  requirements: [],
  assignments: [],
  editFactionId: '',
  editRankId: '',
  access: null,
  roles: {},
  knownPermissions: [],
  selectedRequirementId: '',
  assignGroup: '',
  activeView: 'access',
}

const el = id => document.getElementById(id)

const nodes = {
  apiStatus: el('apiStatus'),
  statusText: el('statusText'),
  userName: el('userName'),
  loginButton: el('loginButton'),
  logoutButton: el('logoutButton'),
  signedOut: el('signedOut'),
  accessView: el('accessView'),
  playersView: el('playersView'),
  factionsView: el('factionsView'),
  permissionsView: el('permissionsView'),
  accessForm: el('accessForm'),
  serverLockedInput: el('serverLockedInput'),
  lockedRoleIdsInput: el('lockedRoleIdsInput'),
  lockedDiscordIdsInput: el('lockedDiscordIdsInput'),
  whitelistRoleIdInput: el('whitelistRoleIdInput'),
  bannedRoleIdInput: el('bannedRoleIdInput'),
  accessCheckForm: el('accessCheckForm'),
  accessCheckDiscordId: el('accessCheckDiscordId'),
  accessCheckResult: el('accessCheckResult'),
  playerCount: el('playerCount'),
  playerSearchInput: el('playerSearchInput'),
  newPlayerButton: el('newPlayerButton'),
  playersRefreshButton: el('playersRefreshButton'),
  playersTable: el('playersTable'),
  selectedPlayerLabel: el('selectedPlayerLabel'),
  playerForm: el('playerForm'),
  playerDiscordIdInput: el('playerDiscordIdInput'),
  playerUsernameInput: el('playerUsernameInput'),
  playerDisplayNameInput: el('playerDisplayNameInput'),
  playerNotesInput: el('playerNotesInput'),
  whitelistPlayerButton: el('whitelistPlayerButton'),
  banPlayerButton: el('banPlayerButton'),
  playerAssignmentsTable: el('playerAssignmentsTable'),
  playerFactionForm: el('playerFactionForm'),
  playerRequirementSelect: el('playerRequirementSelect'),
  playerFactionNotesInput: el('playerFactionNotesInput'),
  stats: el('stats'),
  scopeFilter: el('scopeFilter'),
  groupFilter: el('groupFilter'),
  refreshButton: el('refreshButton'),
  requirementsTable: el('requirementsTable'),
  assignmentsTable: el('assignmentsTable'),
  assignGroupSelect: el('assignGroupSelect'),
  requirementSelect: el('requirementSelect'),
  selectedSlot: el('selectedSlot'),
  slotCount: el('slotCount'),
  assignmentCount: el('assignmentCount'),
  assignmentForm: el('assignmentForm'),
  discordIdInput: el('discordIdInput'),
  slotSelect: el('slotSelect'),
  playerSlotSelect: el('playerSlotSelect'),
  playerNameInput: el('playerNameInput'),
  notesInput: el('notesInput'),
  rolesTable: el('rolesTable'),
  roleCount: el('roleCount'),
  roleForm: el('roleForm'),
  roleIdInput: el('roleIdInput'),
  roleNameInput: el('roleNameInput'),
  selectedRole: el('selectedRole'),
  permissionChecks: el('permissionChecks'),
  factionForm: el('factionForm'),
  factionEditSelect: el('factionEditSelect'),
  factionEditLabel: el('factionEditLabel'),
  factionScopeInput: el('factionScopeInput'),
  factionGroupInput: el('factionGroupInput'),
  factionNameInput: el('factionNameInput'),
  factionZoneInput: el('factionZoneInput'),
  factionColorInput: el('factionColorInput'),
  factionUniformInput: el('factionUniformInput'),
  factionDeleteButton: el('factionDeleteButton'),
  ranksTable: el('ranksTable'),
  rankForm: el('rankForm'),
  rankEditLabel: el('rankEditLabel'),
  rankNameInput: el('rankNameInput'),
  rankOrderInput: el('rankOrderInput'),
  rankCapacityInput: el('rankCapacityInput'),
  rankPermissionInput: el('rankPermissionInput'),
  rankUniformIssuerInput: el('rankUniformIssuerInput'),
  rankAppointsChecks: el('rankAppointsChecks'),
  rankUniformInput: el('rankUniformInput'),
  rankNewButton: el('rankNewButton'),
  rankDeleteButton: el('rankDeleteButton'),
  toast: el('toast'),
}

function toast(message) {
  nodes.toast.textContent = message
  nodes.toast.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => nodes.toast.classList.add('hidden'), 3200)
}

// Character slot: '' in a select means "all characters" (slot null on the
// backend); '0'..'9' are individual characters, shown to admins as 1-based.
function slotFromSelect(value) {
  return value === '' || value === null || value === undefined ? null : Number(value)
}

// Names come from the game server's character report (player.characters)
function slotLabel(slot, player) {
  if (slot === null || slot === undefined) return 'All'
  const character = ((player && player.characters) || []).find(c => c.slot === Number(slot))
  const label = `Character ${Number(slot) + 1}`
  return character && character.name ? `${label}: ${character.name}${character.dead ? ' (dead)' : ''}` : label
}

// Every reported character of the player, or three unnamed slots before the first report; a new player starts on their first character
function renderSlotOptions(select, player) {
  const reported = (player && player.characters) || []
  const slots = reported.length ? reported.map(c => c.slot) : [0, 1, 2]
  const owner = player ? String(player.profileId) : ''
  const previous = select.dataset.owner === owner ? select.value : null
  select.dataset.owner = owner
  select.innerHTML = '<option value="">All characters</option>' + slots
    .map(slot => `<option value="${slot}">${escapeHtml(slotLabel(slot, player))}</option>`)
    .join('')
  select.value = previous !== null && [...select.options].some(o => o.value === previous) ? previous : String(slots[0])
}

function playerByDiscordId(discordId) {
  const id = String(discordId || '').trim()
  return state.players.find(player => String(player.discordId) === id) || null
}

// One item per line: "<form id or desc> <count>"
function parseUniform(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s+/)
      const count = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? Number(parts.pop()) : 1
      return { item: parts.join(' '), count }
    })
}

function uniformText(list) {
  return (list || []).map(u => `${u.item} ${u.count}`).join('\n')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  })

  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed with ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// A token in the fragment is only accepted with the nonce this tab stored when it started the login, so a crafted link cannot sign someone in
function captureTokenFromUrl() {
  const url = new URL(window.location.href)
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
  const token = hashParams.get('token')
  if (!token) return
  let expected = null
  try {
    expected = sessionStorage.getItem(loginNonceKey)
    sessionStorage.removeItem(loginNonceKey)
  } catch {}
  window.history.replaceState({}, '', url.pathname)
  if (!expected || hashParams.get('nonce') !== expected) {
    toast('Login link ignored: start the login from this page')
    return
  }
  state.token = token
  localStorage.setItem(tokenKey, token)
}

async function login() {
  const redirect = `${window.location.origin}/`
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
  sessionStorage.setItem(loginNonceKey, nonce)
  const data = await fetch(`${apiBaseUrl}/auth/dashboard/url?redirect=${encodeURIComponent(redirect)}&nonce=${nonce}`)
    .then(res => res.json())
  if (!data.url) throw new Error(data.error || 'OAuth URL unavailable')
  window.location.href = data.url
}

async function logout() {
  try {
    if (state.token) await api('/auth/dashboard/logout', { method: 'POST' })
  } catch {
    // Local logout still matters even if the session already expired.
  }
  state.token = ''
  state.user = null
  localStorage.removeItem(tokenKey)
  renderAuth()
}

async function loadSession() {
  if (!state.token) return
  const data = await api('/auth/dashboard/me')
  state.user = data.user
}

async function loadFactions() {
  const data = await api('/api/faction-whitelist')
  state.factions = data.factions || []
  state.requirements = data.requirements || []
  state.assignments = data.assignments || []
}

async function loadPlayers() {
  const data = await api('/api/players')
  state.players = data.players || []
}

async function loadAccess() {
  state.access = await api('/api/server-access')
}

async function loadPermissions() {
  const data = await api('/api/role-permissions')
  state.roles = data.roles || {}
  state.knownPermissions = data.knownPermissions || []
}

function renderAuth() {
  const signedIn = !!state.user
  nodes.apiStatus.textContent = signedIn ? 'Online' : 'Offline'
  nodes.apiStatus.classList.toggle('online', signedIn)
  nodes.userName.textContent = signedIn ? state.user.username : 'Signed out'
  nodes.statusText.textContent = signedIn
    ? `Signed in as ${state.user.username}`
    : 'Connect with Discord to manage the realm.'
  nodes.loginButton.classList.toggle('hidden', signedIn)
  nodes.logoutButton.classList.toggle('hidden', !signedIn)
  nodes.signedOut.classList.toggle('hidden', signedIn)
  document.querySelectorAll('.view').forEach(view => view.classList.add('hidden'))
  if (signedIn) renderActiveView()
}

function renderActiveView() {
  nodes.accessView.classList.toggle('hidden', state.activeView !== 'access')
  nodes.playersView.classList.toggle('hidden', state.activeView !== 'players')
  nodes.factionsView.classList.toggle('hidden', state.activeView !== 'factions')
  nodes.permissionsView.classList.toggle('hidden', state.activeView !== 'permissions')
  document.querySelectorAll('.nav-button').forEach(button => {
    button.classList.toggle('active', button.dataset.view === state.activeView)
  })
}

function selectedPlayer() {
  return state.players.find(player => player.profileId === state.selectedProfileId) || null
}

function filteredPlayers() {
  const q = String(nodes.playerSearchInput.value || '').trim().toLowerCase()
  if (!q) return state.players
  return state.players.filter(player =>
    String(player.profileId).includes(q) ||
    String(player.discordId || '').toLowerCase().includes(q) ||
    String(player.username || '').toLowerCase().includes(q) ||
    String(player.displayName || '').toLowerCase().includes(q)
  )
}

function renderPlayers() {
  const rows = filteredPlayers()
  nodes.playerCount.textContent = `${rows.length} shown`
  nodes.playersTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Profile</th>
          <th>Name</th>
          <th>Discord ID</th>
          <th>Access</th>
          <th>HWID</th>
          <th>Factions</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(player => `
          <tr class="${player.profileId === state.selectedProfileId ? 'selected' : ''}">
            <td>#${player.profileId}</td>
            <td>${escapeHtml(player.displayName || player.username || 'Unnamed')}</td>
            <td>${escapeHtml(player.discordId)}</td>
            <td><span class="tag ${player.access?.allowed ? '' : 'locked'}">${escapeHtml(player.access?.allowed ? 'allowed' : (player.access?.error || 'blocked'))}</span>${player.ban ? ' <span class="tag locked">banned</span>' : ''}</td>
            <td>${escapeHtml(player.hwid ? player.hwid.slice(0, 12) : '-')}</td>
            <td>${escapeHtml((player.assignments || []).map(a => a.requirement ? `${a.requirement.group} ${a.requirement.rank}` : a.requirementId).join(', '))}</td>
            <td><button class="ghost mini" data-select-player="${player.profileId}" type="button">Open</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
  renderPlayerDetail()
}

function renderPlayerDetail() {
  const player = selectedPlayer()
  nodes.selectedPlayerLabel.textContent = player ? `Profile #${player.profileId}` : 'New player'
  nodes.playerDiscordIdInput.value = player?.discordId || ''
  nodes.playerDiscordIdInput.disabled = !!player
  nodes.playerUsernameInput.value = player?.username || ''
  nodes.playerDisplayNameInput.value = player?.displayName || ''
  nodes.playerNotesInput.value = player?.notes || ''
  nodes.whitelistPlayerButton.disabled = !player
  nodes.banPlayerButton.disabled = !player
  nodes.whitelistPlayerButton.textContent = player?.access?.roles?.includes(state.access?.whitelistRoleId)
    ? 'Remove Whitelist'
    : 'Add Whitelist'
  nodes.banPlayerButton.textContent = playerIsBanned(player)
    ? 'Remove Ban'
    : 'Add Ban'
  nodes.playerAssignmentsTable.innerHTML = player
    ? renderPlayerAssignments(player)
    : '<div class="empty-row">Save the player before assigning factions.</div>'
  nodes.playerRequirementSelect.innerHTML = state.requirements
    .map(req => `<option value="${escapeHtml(req.id)}">${escapeHtml(req.group)} - ${escapeHtml(req.rank)}</option>`)
    .join('')
  renderSlotOptions(nodes.playerSlotSelect, player)
  nodes.playerFactionForm.querySelector('button[type="submit"]').disabled = !player
}

function renderPlayerAssignments(player) {
  const assignments = player.assignments || []
  if (!assignments.length) return '<div class="empty-row">No faction slots assigned.</div>'
  return `
    <table>
      <thead>
        <tr>
          <th>Group</th>
          <th>Rank</th>
          <th>Character</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${assignments.map(assignment => `
          <tr>
            <td>${escapeHtml(assignment.requirement?.group || assignment.requirementId)}</td>
            <td>${escapeHtml(assignment.requirement?.rank || '')}</td>
            <td>${escapeHtml(slotLabel(assignment.slot, player))}</td>
            <td><button class="danger mini" data-delete-player-assignment="${escapeHtml(assignment.id)}" type="button">Remove</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
}

function renderAccess() {
  const access = state.access || {}
  nodes.serverLockedInput.checked = access.serverLocked === true
  nodes.lockedRoleIdsInput.value = (access.lockedRoleIds || []).join('\n')
  nodes.lockedDiscordIdsInput.value = (access.lockedDiscordIds || []).join('\n')
  nodes.whitelistRoleIdInput.value = access.whitelistRoleId || ''
  nodes.bannedRoleIdInput.value = access.bannedRoleId || ''
}

function filteredRequirements() {
  const scope = nodes.scopeFilter.value
  const group = nodes.groupFilter.value
  return state.requirements.filter(req =>
    (!scope || req.scope === scope) &&
    (!group || req.group === group)
  )
}

function renderStats() {
  const uniqueSlots = state.requirements.filter(req => req.capacity === 1).length
  const openUnique = state.requirements.filter(req => req.capacity === 1 && req.assigned === 0).length
  const repeatable = state.requirements.filter(req => req.capacity === null).length
  nodes.stats.innerHTML = [
    ['Assignments', state.assignments.length],
    ['Unique Open', openUnique],
    ['Unique Slots', uniqueSlots],
    ['Repeatable Ranks', repeatable],
  ].map(([label, value]) => `
    <div class="stat">
      <strong>${value}</strong>
      <span class="muted">${label}</span>
    </div>
  `).join('')
}

function renderFilters() {
  const groups = [...new Set(state.requirements.map(req => req.group))].sort()
  const selected = nodes.groupFilter.value
  nodes.groupFilter.innerHTML = '<option value="">All</option>' + groups
    .map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .join('')
  nodes.groupFilter.value = groups.includes(selected) ? selected : ''
}

function renderRequirements() {
  const rows = filteredRequirements()
  nodes.slotCount.textContent = `${rows.length} shown`
  nodes.requirementsTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Scope</th>
          <th>Group</th>
          <th>Rank</th>
          <th>Slots</th>
          <th>Permission</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(req => `
          <tr class="${req.id === state.selectedRequirementId ? 'selected' : ''}">
            <td><span class="tag">${escapeHtml(req.scope)}</span></td>
            <td>${escapeHtml(req.group)}</td>
            <td>${escapeHtml(req.rank)}</td>
            <td>${req.capacity === null ? 'Open' : `${req.assigned}/${req.capacity}`}</td>
            <td>${escapeHtml(req.permission)}</td>
            <td><button class="ghost mini" data-select="${escapeHtml(req.id)}" type="button">Select</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `

  renderAssignForm()
}

function renderAssignForm() {
  const groups = [...new Set(state.requirements.map(req => req.group))]
  if (!groups.includes(state.assignGroup)) {
    state.assignGroup = groups[0] || ''
  }
  nodes.assignGroupSelect.innerHTML = groups
    .map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .join('')
  nodes.assignGroupSelect.value = state.assignGroup
  renderRoleSelect()
}

function renderRoleSelect() {
  const roles = state.requirements.filter(req => req.group === state.assignGroup)
  nodes.requirementSelect.innerHTML = roles
    .map(req => `<option value="${escapeHtml(req.id)}">${escapeHtml(req.rank)}</option>`)
    .join('')
  if (!roles.some(req => req.id === state.selectedRequirementId)) {
    state.selectedRequirementId = roles[0] ? roles[0].id : ''
  }
  nodes.requirementSelect.value = state.selectedRequirementId
  renderSelectedSlot()
}

function renderSelectedSlot() {
  const req = state.requirements.find(item => item.id === state.selectedRequirementId)
  nodes.selectedSlot.textContent = req ? `${req.group} - ${req.rank}` : 'No slot selected'
}

function renderAssignments() {
  const byReq = new Map(state.requirements.map(req => [req.id, req]))
  nodes.assignmentCount.textContent = `${state.assignments.length} total`
  nodes.assignmentsTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Discord ID</th>
          <th>Character</th>
          <th>Group</th>
          <th>Rank</th>
          <th>Permission</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${state.assignments.map(assignment => {
          const req = byReq.get(assignment.requirementId) || {}
          return `
            <tr>
              <td>${escapeHtml(assignment.playerName || 'Unnamed')}</td>
              <td>${escapeHtml(assignment.discordId)}</td>
              <td>${escapeHtml(slotLabel(assignment.slot, playerByDiscordId(assignment.discordId)))}</td>
              <td>${escapeHtml(req.group || '')}</td>
              <td>${escapeHtml(req.rank || '')}</td>
              <td>${escapeHtml(req.permission || '')}</td>
              <td><button class="danger mini" data-delete-assignment="${escapeHtml(assignment.id)}" type="button">Remove</button></td>
            </tr>
          `
        }).join('')}
      </tbody>
    </table>
  `
}

function renderFactions() {
  renderStats()
  renderFilters()
  renderRequirements()
  renderAssignments()
  renderFactionEditor()
  renderSlotOptions(nodes.slotSelect, playerByDiscordId(nodes.discordIdInput.value))
}

function editedFaction() {
  return state.factions.find(f => f.id === state.editFactionId) || null
}

function factionRanks(factionId) {
  return state.requirements
    .filter(req => req.factionId === factionId)
    .sort((a, b) => a.order - b.order)
}

function renderFactionEditor() {
  const faction = editedFaction()
  if (!faction) state.editFactionId = ''
  nodes.factionEditSelect.innerHTML = '<option value="">New faction</option>' + state.factions
    .map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)} (${escapeHtml(f.id)})</option>`)
    .join('')
  nodes.factionEditSelect.value = state.editFactionId
  nodes.factionEditLabel.textContent = faction ? faction.id : 'New faction'
  nodes.factionScopeInput.value = faction ? faction.scope : (nodes.factionScopeInput.value || 'faction')
  nodes.factionScopeInput.disabled = !!faction
  nodes.factionGroupInput.value = faction ? faction.group : ''
  nodes.factionGroupInput.disabled = !!faction
  nodes.factionNameInput.value = faction ? faction.name : ''
  nodes.factionZoneInput.value = faction ? faction.zone : ''
  nodes.factionColorInput.value = faction ? faction.color : ''
  nodes.factionUniformInput.value = faction ? uniformText(faction.uniform) : ''
  nodes.factionDeleteButton.disabled = !faction
  renderRankEditor()
}

function renderRankEditor() {
  const faction = editedFaction()
  const ranks = faction ? factionRanks(faction.id) : []
  const rank = ranks.find(r => r.id === state.editRankId) || null
  if (!rank) state.editRankId = ''
  const rankName = slug => (ranks.find(r => r.id.split(':')[2] === slug) || { rank: slug }).rank
  nodes.ranksTable.innerHTML = !faction
    ? '<div class="empty-row">Save or pick a faction to edit its ranks.</div>'
    : `
    <table>
      <thead>
        <tr>
          <th>Order</th>
          <th>Rank</th>
          <th>Slots</th>
          <th>Appoints</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${ranks.map(r => `
          <tr class="${r.id === state.editRankId ? 'selected' : ''}">
            <td>${r.order}</td>
            <td>${escapeHtml(r.rank)}${r.issuesUniform ? ' <span class="tag">uniforms</span>' : ''}</td>
            <td>${r.capacity === null ? `${r.assigned} / open` : `${r.assigned}/${r.capacity}`}</td>
            <td>${escapeHtml(r.appoints === null ? 'leader only' : r.appoints.map(rankName).join(', ') || '-')}</td>
            <td><button class="ghost mini" data-edit-rank="${escapeHtml(r.id)}" type="button">Edit</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
  nodes.rankEditLabel.textContent = rank ? rank.id : (faction ? 'New rank' : 'No faction')
  nodes.rankNameInput.value = rank ? rank.rank : ''
  nodes.rankOrderInput.value = rank ? rank.order : ''
  nodes.rankCapacityInput.value = rank && rank.capacity !== null ? rank.capacity : ''
  nodes.rankPermissionInput.value = rank ? rank.permission || '' : ''
  nodes.rankUniformIssuerInput.checked = !!(rank && rank.issuesUniform)
  nodes.rankUniformInput.value = rank ? uniformText(rank.uniform) : ''
  const appoints = rank && rank.appoints ? rank.appoints : []
  nodes.rankAppointsChecks.innerHTML = ranks
    .filter(r => !rank || r.id !== rank.id)
    .map(r => {
      const slug = r.id.split(':')[2]
      return `
        <label class="check-row">
          <input type="checkbox" value="${escapeHtml(slug)}" ${appoints.includes(slug) ? 'checked' : ''}>
          <span>${escapeHtml(r.rank)}</span>
        </label>
      `
    }).join('')
  nodes.rankForm.querySelector('button[type="submit"]').disabled = !faction
  nodes.rankDeleteButton.disabled = !rank
}

async function saveFaction(event) {
  event.preventDefault()
  const faction = editedFaction()
  const saved = await api('/api/faction-whitelist/factions', {
    method: 'PUT',
    body: JSON.stringify({
      id: faction ? faction.id : undefined,
      scope: nodes.factionScopeInput.value,
      group: nodes.factionGroupInput.value,
      name: nodes.factionNameInput.value,
      zone: nodes.factionZoneInput.value,
      color: nodes.factionColorInput.value,
      uniform: parseUniform(nodes.factionUniformInput.value),
    }),
  })
  state.editFactionId = saved.id
  await loadFactions()
  renderFactions()
  toast('Faction saved')
}

async function deleteFaction() {
  const faction = editedFaction()
  if (!faction || !window.confirm(`Delete ${faction.name} and all of its ranks?`)) return
  await api(`/api/faction-whitelist/factions/${encodeURIComponent(faction.id)}`, { method: 'DELETE' })
  state.editFactionId = ''
  await loadFactions()
  renderFactions()
  toast('Faction deleted')
}

async function saveRank(event) {
  event.preventDefault()
  const faction = editedFaction()
  if (!faction) return
  const saved = await api('/api/faction-whitelist/requirements', {
    method: 'PUT',
    body: JSON.stringify({
      id: state.editRankId || undefined,
      factionId: faction.id,
      rank: nodes.rankNameInput.value,
      order: nodes.rankOrderInput.value,
      capacity: nodes.rankCapacityInput.value,
      permission: nodes.rankPermissionInput.value,
      issuesUniform: nodes.rankUniformIssuerInput.checked,
      appoints: [...nodes.rankAppointsChecks.querySelectorAll('input:checked')].map(input => input.value),
      uniform: parseUniform(nodes.rankUniformInput.value),
    }),
  })
  state.editRankId = saved.id
  await loadFactions()
  renderFactions()
  toast('Rank saved')
}

async function deleteRank() {
  if (!state.editRankId || !window.confirm('Delete this rank?')) return
  await api(`/api/faction-whitelist/requirements/${encodeURIComponent(state.editRankId)}`, { method: 'DELETE' })
  state.editRankId = ''
  await loadFactions()
  renderFactions()
  toast('Rank deleted')
}

function renderPermissionChecks(selected = []) {
  nodes.permissionChecks.innerHTML = state.knownPermissions.map(permission => `
    <label class="check-row">
      <input type="checkbox" value="${escapeHtml(permission)}" ${selected.includes(permission) ? 'checked' : ''}>
      <span>${escapeHtml(permission)}</span>
    </label>
  `).join('')
}

function renderRoles() {
  const entries = Object.entries(state.roles)
  nodes.roleCount.textContent = `${entries.length} configured`
  nodes.rolesTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Role</th>
          <th>Role ID</th>
          <th>Permissions</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(([roleId, role]) => `
          <tr>
            <td>${escapeHtml(role.name)}</td>
            <td>${escapeHtml(roleId)}</td>
            <td>${escapeHtml((role.permissions || []).join(', '))}</td>
            <td>
              <button class="ghost mini" data-edit-role="${escapeHtml(roleId)}" type="button">Edit</button>
              <button class="danger mini" data-delete-role="${escapeHtml(roleId)}" type="button">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
  renderPermissionChecks()
}

async function refreshAll() {
  await loadAccess()
  renderAccess()
  await loadFactions()
  renderFactions()
  await loadPlayers()
  renderPlayers()
  try {
    await loadPermissions()
    renderRoles()
  } catch (err) {
    nodes.permissionsView.innerHTML = `<section class="empty-state"><h2>Permission access unavailable</h2><p>${escapeHtml(err.message)}</p></section>`
  }
}

async function refreshPlayers() {
  await loadPlayers()
  renderPlayers()
}

function clearSelectedPlayer() {
  state.selectedProfileId = null
  nodes.playerForm.reset()
  nodes.playerFactionNotesInput.value = ''
  renderPlayers()
}

function lines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map(item => item.trim())
    .filter(Boolean)
}

async function saveAccess(event) {
  event.preventDefault()
  state.access = await api('/api/server-access', {
    method: 'PUT',
    body: JSON.stringify({
      serverLocked: nodes.serverLockedInput.checked,
      lockedRoleIds: lines(nodes.lockedRoleIdsInput.value),
      lockedDiscordIds: lines(nodes.lockedDiscordIdsInput.value),
      whitelistRoleId: nodes.whitelistRoleIdInput.value,
      bannedRoleId: nodes.bannedRoleIdInput.value,
    }),
  })
  renderAccess()
  toast('Server access policy saved')
}

async function checkAccess(event) {
  event.preventDefault()
  const discordId = nodes.accessCheckDiscordId.value.trim()
  const result = await api(`/api/server-access/check/${encodeURIComponent(discordId)}`)
  nodes.accessCheckResult.textContent = result.allowed
    ? `Allowed (${result.roles.length} role${result.roles.length === 1 ? '' : 's'})`
    : `Blocked: ${result.error || 'accessDenied'}`
}

async function savePlayer(event) {
  event.preventDefault()
  const player = selectedPlayer()
  const body = {
    discordId: nodes.playerDiscordIdInput.value,
    username: nodes.playerUsernameInput.value,
    displayName: nodes.playerDisplayNameInput.value,
    notes: nodes.playerNotesInput.value,
  }
  const saved = player
    ? await api(`/api/players/${player.profileId}`, { method: 'PUT', body: JSON.stringify(body) })
    : await api('/api/players', { method: 'POST', body: JSON.stringify(body) })
  state.selectedProfileId = saved.profileId
  await refreshPlayers()
  toast('Player saved')
}

async function toggleWhitelist() {
  const player = selectedPlayer()
  if (!player) return
  const enabled = !player.access?.roles?.includes(state.access?.whitelistRoleId)
  await api(`/api/players/${player.profileId}/whitelist`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
  await refreshPlayers()
  toast(enabled ? 'Player whitelisted' : 'Player removed from whitelist')
}

// Banned when a bans.json snapshot exists or the discord ban role is present
function playerIsBanned(player) {
  return !!(player?.ban || player?.access?.roles?.includes(state.access?.bannedRoleId))
}

async function toggleBan() {
  const player = selectedPlayer()
  if (!player) return
  const enabled = !playerIsBanned(player)
  await api(`/api/players/${player.profileId}/ban`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
  await refreshPlayers()
  toast(enabled ? 'Player banned' : 'Player unbanned')
}

async function assignSelectedPlayerFaction(event) {
  event.preventDefault()
  const player = selectedPlayer()
  if (!player) return
  await api(`/api/players/${player.profileId}/factions`, {
    method: 'POST',
    body: JSON.stringify({
      requirementId: nodes.playerRequirementSelect.value,
      slot: slotFromSelect(nodes.playerSlotSelect.value),
      playerName: player.displayName || player.username,
      notes: nodes.playerFactionNotesInput.value,
    }),
  })
  nodes.playerFactionNotesInput.value = ''
  await loadFactions()
  renderFactions()
  await refreshPlayers()
  toast('Faction assigned')
}

async function saveAssignment(event) {
  event.preventDefault()
  const body = {
    requirementId: nodes.requirementSelect.value,
    discordId: nodes.discordIdInput.value,
    slot: slotFromSelect(nodes.slotSelect.value),
    playerName: nodes.playerNameInput.value,
    notes: nodes.notesInput.value,
  }
  await api('/api/faction-whitelist/assignments', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  nodes.assignmentForm.reset()
  await loadFactions()
  renderFactions()
  toast('Assignment saved')
}

async function saveRole(event) {
  event.preventDefault()
  const permissions = [...nodes.permissionChecks.querySelectorAll('input:checked')].map(input => input.value)
  await api(`/api/role-permissions/${encodeURIComponent(nodes.roleIdInput.value)}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: nodes.roleNameInput.value,
      permissions,
    }),
  })
  nodes.roleForm.reset()
  nodes.selectedRole.textContent = 'New role'
  await loadPermissions()
  renderRoles()
  toast('Role permissions saved')
}

function bindEvents() {
  nodes.loginButton.addEventListener('click', () => login().catch(err => toast(err.message)))
  nodes.logoutButton.addEventListener('click', () => logout())
  nodes.refreshButton.addEventListener('click', () => refreshAll().catch(err => toast(err.message)))
  nodes.newPlayerButton.addEventListener('click', clearSelectedPlayer)
  nodes.playersRefreshButton.addEventListener('click', () => refreshPlayers().catch(err => toast(err.message)))
  nodes.playerSearchInput.addEventListener('input', renderPlayers)
  nodes.playerForm.addEventListener('submit', event => savePlayer(event).catch(err => toast(err.message)))
  nodes.whitelistPlayerButton.addEventListener('click', () => toggleWhitelist().catch(err => toast(err.message)))
  nodes.banPlayerButton.addEventListener('click', () => toggleBan().catch(err => toast(err.message)))
  nodes.playerFactionForm.addEventListener('submit', event => assignSelectedPlayerFaction(event).catch(err => toast(err.message)))
  nodes.accessForm.addEventListener('submit', event => saveAccess(event).catch(err => toast(err.message)))
  nodes.accessCheckForm.addEventListener('submit', event => checkAccess(event).catch(err => toast(err.message)))
  nodes.scopeFilter.addEventListener('change', renderRequirements)
  nodes.groupFilter.addEventListener('change', renderRequirements)
  nodes.assignGroupSelect.addEventListener('change', event => {
    state.assignGroup = event.target.value
    renderRoleSelect()
  })
  nodes.requirementSelect.addEventListener('change', event => {
    state.selectedRequirementId = event.target.value
    renderSelectedSlot()
    renderRequirements()
  })
  nodes.assignmentForm.addEventListener('submit', event => saveAssignment(event).catch(err => toast(err.message)))
  nodes.discordIdInput.addEventListener('input', () => renderSlotOptions(nodes.slotSelect, playerByDiscordId(nodes.discordIdInput.value)))
  nodes.factionForm.addEventListener('submit', event => saveFaction(event).catch(err => toast(err.message)))
  nodes.factionDeleteButton.addEventListener('click', () => deleteFaction().catch(err => toast(err.message)))
  nodes.factionEditSelect.addEventListener('change', event => {
    state.editFactionId = event.target.value
    state.editRankId = ''
    renderFactionEditor()
  })
  nodes.rankForm.addEventListener('submit', event => saveRank(event).catch(err => toast(err.message)))
  nodes.rankDeleteButton.addEventListener('click', () => deleteRank().catch(err => toast(err.message)))
  nodes.rankNewButton.addEventListener('click', () => {
    state.editRankId = ''
    renderRankEditor()
  })
  nodes.roleForm.addEventListener('submit', event => saveRole(event).catch(err => toast(err.message)))

  document.querySelector('.nav').addEventListener('click', event => {
    const button = event.target.closest('[data-view]')
    if (!button) return
    state.activeView = button.dataset.view
    renderActiveView()
  })

  document.body.addEventListener('click', event => {
    const select = event.target.closest('[data-select]')
    if (select) {
      state.selectedRequirementId = select.dataset.select
      const req = state.requirements.find(r => r.id === state.selectedRequirementId)
      if (req) state.assignGroup = req.group
      renderRequirements()
      return
    }

    const editRank = event.target.closest('[data-edit-rank]')
    if (editRank) {
      state.editRankId = editRank.dataset.editRank
      renderRankEditor()
      return
    }

    const selectPlayer = event.target.closest('[data-select-player]')
    if (selectPlayer) {
      state.selectedProfileId = Number(selectPlayer.dataset.selectPlayer)
      renderPlayers()
      return
    }

    const deleteAssignment = event.target.closest('[data-delete-assignment]')
    if (deleteAssignment) {
      api(`/api/faction-whitelist/assignments/${encodeURIComponent(deleteAssignment.dataset.deleteAssignment)}`, {
        method: 'DELETE',
      })
        .then(loadFactions)
        .then(renderFactions)
        .then(refreshPlayers)
        .then(() => toast('Assignment removed'))
        .catch(err => toast(err.message))
      return
    }

    const deletePlayerAssignment = event.target.closest('[data-delete-player-assignment]')
    if (deletePlayerAssignment) {
      const player = selectedPlayer()
      if (!player) return
      api(`/api/players/${player.profileId}/factions/${encodeURIComponent(deletePlayerAssignment.dataset.deletePlayerAssignment)}`, {
        method: 'DELETE',
      })
        .then(loadFactions)
        .then(renderFactions)
        .then(refreshPlayers)
        .then(() => toast('Faction removed'))
        .catch(err => toast(err.message))
      return
    }

    const editRole = event.target.closest('[data-edit-role]')
    if (editRole) {
      const roleId = editRole.dataset.editRole
      const role = state.roles[roleId]
      nodes.roleIdInput.value = roleId
      nodes.roleNameInput.value = role.name || ''
      nodes.selectedRole.textContent = role.name || roleId
      renderPermissionChecks(role.permissions || [])
      return
    }

    const deleteRole = event.target.closest('[data-delete-role]')
    if (deleteRole) {
      api(`/api/role-permissions/${encodeURIComponent(deleteRole.dataset.deleteRole)}`, { method: 'DELETE' })
        .then(loadPermissions)
        .then(renderRoles)
        .then(() => toast('Role removed'))
        .catch(err => toast(err.message))
    }
  })
}

async function start() {
  bindEvents()
  captureTokenFromUrl()
  try {
    await loadSession()
    renderAuth()
    if (state.user) await refreshAll()
  } catch (err) {
    localStorage.removeItem(tokenKey)
    state.token = ''
    state.user = null
    renderAuth()
    toast(err.message)
  }

  const url = new URL(window.location.href)
  const error = url.searchParams.get('error')
  if (error) toast(error)
}

start()
