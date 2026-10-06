'use strict'

// Faction and rank definition editor shared by the dashboard Factions view and the Server Manager Factions tab; the host supplies request(method, path, body)
;(function () {
  const RANK_LISTS = [
    ['recruit', dashLoc('editor.recruitInto')],
    ['promote', dashLoc('editor.promoteTo')],
  ]
  const RANK_FLAGS = [
    ['leader', dashLoc('editor.flagLeader'), false],
    ['remove', dashLoc('editor.flagRemove'), false],
    ['craft', dashLoc('editor.flagCraft'), false],
    ['housing', dashLoc('editor.flagHousing'), false],
    ['arrest', dashLoc('editor.flagArrest'), false],
    ['execute', dashLoc('editor.flagExecute'), false],
    ['factionAccess', dashLoc('editor.flagFactionAccess'), false],
  ]
  // The stored type hold reads Territory in every label
  const TYPE_NAMES = { hold: dashLoc('editor.typeHold'), military: dashLoc('editor.typeMilitary'), guild: dashLoc('editor.typeGuild') }
  const SCOPE_NAMES = { hold: dashLoc('editor.typeHold'), faction: dashLoc('editor.scopeFaction') }
  const PROVINCES = ['Skyrim', 'Cyrodiil', 'Morrowind', 'High Rock', 'Valenwood', 'Elsweyr', 'Black Marsh', 'Summerset']
  const HOLD_NAMES = { reach: 'The Reach', rift: 'The Rift', pale: 'The Pale' }
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
  const COLOR_RE = /^[0-9a-f]{6}$/
  const SAMPLE = 10
  const SORT_KEY = 'factionEditor.sort'

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]))
  const slugOf = rank => String(rank.id).split(':')[2]
  const holdName = key => HOLD_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1)
  const holdKey = groupSlug => String(groupSlug || '').replace(/^the-/, '')
  const landText = faction => (faction.land ? dashLoc('editor.land', { hold: holdName(faction.land) }) : dashLoc('editor.noLand'))
  const slotText = slot => (slot === null || slot === undefined ? dashLoc('editor.everyCharacter') : dashLoc('editor.character', { n: Number(slot) + 1 }))
  const plural = (n, one, many) => dashLoc(n === 1 ? one : many, { n })
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))
  const provinceOf = faction => faction.province || 'Skyrim'
  const byName = (a, b) => (a.scope === 'hold' ? 0 : 1) - (b.scope === 'hold' ? 0 : 1) || a.name.localeCompare(b.name)

  function readSort() {
    try { return localStorage.getItem(SORT_KEY) === 'province' ? 'province' : 'name' } catch { return 'name' }
  }

  // Faction ids are "<scope>:<group>" slugs, so paths never need encoding and cannot leave /api/factions
  function factionPath(id, suffix = '') {
    const [scope, group, extra] = String(id).split(':')
    if (extra !== undefined || !SLUG_RE.test(scope || '') || !SLUG_RE.test(group || '')) throw new Error(dashLoc('editor.unexpectedFaction', { id }))
    return `/${scope}/${group}${suffix}`
  }

  function rankPath(faction, slug) {
    if (!SLUG_RE.test(slug)) throw new Error(dashLoc('editor.unexpectedRank', { id: slug }))
    return factionPath(faction.id, `/ranks/${slug}`)
  }

  function mount(root, { request, onSelectPlayer = null, onChange = null } = {}) {
    const state = {
      factions: [], retiredFactions: [], provinces: PROVINCES, holds: [], canDefine: false, loaded: false,
      selected: '', rank: '', creating: false, filter: '', sort: readSort(), members: null, confirm: null, busy: false,
    }

    root.classList.add('fe')
    root.innerHTML = `
      <div class="fe-toolbar">
        <input class="fe-search" type="search" placeholder="${esc(dashLoc('editor.search'))}" autocomplete="off">
        <select class="fe-sort" title="${esc(dashLoc('editor.listOrder'))}">
          <option value="name"${state.sort === 'name' ? ' selected' : ''}>${esc(dashLoc('editor.sortName'))}</option>
          <option value="province"${state.sort === 'province' ? ' selected' : ''}>${esc(dashLoc('editor.sortProvince'))}</option>
        </select>
        <button class="fe-btn fe-primary" type="button" data-act="new" data-write>${esc(dashLoc('editor.newFaction'))}</button>
        <button class="fe-btn" type="button" data-act="refresh">${esc(dashLoc('editor.refresh'))}</button>
        <span class="fe-status" role="status"></span>
      </div>
      <p class="fe-note">${esc(dashLoc('editor.note'))}</p>
      <div class="fe-split">
        <ul class="fe-list"></ul>
        <div class="fe-detail"></div>
      </div>`
    const $ = selector => root.querySelector(selector)

    function setStatus(text, error = false) {
      const node = $('.fe-status')
      node.textContent = text || ''
      node.classList.toggle('fe-error', !!error)
    }

    const current = () => state.factions.find(f => f.id === state.selected) || null

    function replaceFaction(faction) {
      const i = state.factions.findIndex(f => f.id === faction.id)
      if (i === -1) state.factions.push(faction)
      else state.factions[i] = faction
    }

    // Resolves the response data; a refusal throws with its body, and a stale revision reloads that faction first
    async function call(method, path, body) {
      let res
      try {
        res = await request(method, path, body)
      } catch (err) {
        res = { ok: false, status: 0, error: err && err.message }
      }
      if (res && res.ok) return res.data
      const data = (res && res.data) || {}
      const err = new Error(data.error || (res && res.error) || dashLoc('editor.requestFailed', { status: res ? res.status : dashLoc('editor.noResponse') }))
      err.data = data
      if (data.stale && data.faction) {
        replaceFaction(data.faction)
        state.confirm = null
        render()
        err.message = dashLoc('editor.staleReloaded')
      }
      throw err
    }

    async function run(label, job) {
      if (state.busy) return
      state.busy = true
      root.classList.add('fe-busy')
      setStatus(label)
      try {
        await job()
      } catch (err) {
        setStatus(err.message, true)
      } finally {
        state.busy = false
        root.classList.remove('fe-busy')
      }
    }

    function changed(text) {
      setStatus(text)
      if (onChange) onChange()
    }

    async function load() {
      const data = await call('GET', '')
      state.factions = data.factions || []
      state.holds = data.holds || []
      state.provinces = data.provinces || state.provinces
      state.retiredFactions = (data.retired && data.retired.factions) || []
      state.canDefine = data.canDefine === true
      state.loaded = true
      if (!current()) state.selected = ''
      render()
      if (state.selected) await loadMembers()
    }

    async function loadMembers() {
      const faction = current()
      if (!faction) return
      const data = await call('GET', factionPath(faction.id, '/members'))
      if (state.selected !== faction.id) return
      state.members = data.members || []
      renderMembers()
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    function render() {
      renderList()
      renderDetail()
      root.querySelectorAll('[data-write]').forEach(node => { node.disabled = !state.canDefine })
    }

    function swatch(color) {
      return `<span class="fe-swatch" style="background:#${COLOR_RE.test(color) ? color : '555555'}"></span>`
    }

    function renderList() {
      const q = state.filter.trim().toLowerCase()
      const grouped = state.sort === 'province'
      const shown = state.factions
        .filter(f => !q || f.name.toLowerCase().includes(q) || f.id.includes(q) || provinceOf(f).toLowerCase().includes(q))
        .sort((a, b) => (grouped ? provinceOf(a).localeCompare(provinceOf(b)) : 0) || byName(a, b))
      const heading = (f, i) => {
        if (!grouped || (i > 0 && provinceOf(shown[i - 1]) === provinceOf(f))) return ''
        const count = shown.filter(x => provinceOf(x) === provinceOf(f)).length
        return `<li class="fe-group">${esc(provinceOf(f))} <span class="fe-muted">${plural(count, 'editor.factionOne', 'editor.factionMany')}</span></li>`
      }
      $('.fe-list').innerHTML = !state.loaded ? `<li class="fe-empty">${esc(dashLoc('editor.loading'))}</li>`
        : !shown.length ? `<li class="fe-empty">${esc(q ? dashLoc('editor.noMatches') : dashLoc('editor.noFactions'))}</li>`
          : shown.map((f, i) => `${heading(f, i)}
            <li data-act="select" data-id="${esc(f.id)}" class="${f.id === state.selected ? 'fe-selected' : ''}">
              <div class="fe-line">${swatch(f.color)}<span class="fe-name">${esc(f.name)}</span><span class="fe-badge">${esc(provinceOf(f))}</span><span class="fe-badge">${esc(TYPE_NAMES[f.type] || f.type || SCOPE_NAMES[f.scope])}</span></div>
              <div class="fe-sub">${esc(f.id)} · ${plural(f.ranks.length, 'editor.rankOne', 'editor.rankMany')} · ${plural(f.members, 'editor.memberOne', 'editor.memberMany')}</div>
            </li>`).join('')
    }

    function provinceOptions(selected) {
      return state.provinces.map(p => `<option value="${esc(p)}"${p === selected ? ' selected' : ''}>${esc(p)}</option>`).join('')
    }

    function colorFields(color) {
      const hex = COLOR_RE.test(color) ? color : 'c9a36b'
      return `
        <label>${esc(dashLoc('editor.colour'))}
          <span class="fe-color"><input type="color" name="colorPicker" value="#${hex}" data-write><input name="color" value="${esc(color)}" maxlength="7" placeholder="c9a36b" data-write></span>
        </label>`
    }

    function renderDetail() {
      const detail = $('.fe-detail')
      if (state.creating) { detail.innerHTML = createForm(); return }
      const faction = current()
      if (!faction) {
        detail.innerHTML = `<p class="fe-muted">${state.loaded ? esc(dashLoc('editor.pickFaction')) : ''}</p>${state.loaded && !state.canDefine ? readOnlyNote() : ''}`
        return
      }
      detail.innerHTML = `
        <h3 class="fe-title">${swatch(faction.color)}${esc(faction.name)} <code>${esc(faction.id)}</code></h3>
        ${state.canDefine ? '' : readOnlyNote()}
        <form class="fe-card" data-form="faction">
          <h4>${esc(dashLoc('editor.factionCard'))}</h4>
          <div class="fe-grid">
            <label>${esc(dashLoc('editor.displayName'))} <input name="name" value="${esc(faction.name)}" maxlength="48" required data-write></label>
            <label>${esc(dashLoc('editor.province'))} <select name="province" data-write>${provinceOptions(faction.province || 'Skyrim')}</select></label>
            ${colorFields(faction.color)}
          </div>
          <p class="fe-muted">${esc(dashLoc(faction.type === 'hold' ? 'editor.typeLineLand' : 'editor.typeLine', { type: TYPE_NAMES[faction.type] || faction.type, group: faction.group || faction.id, land: landText(faction) }))}</p>
          <div class="fe-row"><button class="fe-btn fe-primary" type="submit" data-write>${esc(dashLoc('editor.saveFaction'))}</button></div>
        </form>
        ${ranksCard(faction)}
        ${state.rank ? rankCard(faction) : ''}
        <section class="fe-card"><h4>${esc(dashLoc('editor.members'))}</h4><div class="fe-members"></div></section>
        <section class="fe-card fe-danger-zone">
          <h4>${esc(dashLoc('editor.deleteFaction'))}</h4>
          <p class="fe-muted">${esc(dashLoc(faction.land ? 'editor.deleteNoteLand' : 'editor.deleteNote'))}</p>
          ${confirmBlock(`faction:${faction.id}`, 'delete-faction', esc(dashLoc('editor.deleteFaction')))}
        </section>`
      renderMembers()
    }

    function readOnlyNote() {
      return `<p class="fe-note fe-warn">${esc(dashLoc('editor.readOnly'))}</p>`
    }

    function ranksCard(faction) {
      const last = faction.ranks.length - 1
      return `
        <section class="fe-card">
          <h4>${esc(dashLoc('editor.ranks'))} <span class="fe-muted">${esc(dashLoc('editor.leaderFirst'))}</span></h4>
          ${faction.ranks.length ? `
          <table class="fe-table">
            <thead><tr><th></th><th>${esc(dashLoc('editor.colRank'))}</th><th>${esc(dashLoc('editor.colCapacity'))}</th><th>${esc(dashLoc('editor.colMembers'))}</th><th></th></tr></thead>
            <tbody>${faction.ranks.map((r, i) => `
              <tr class="${slugOf(r) === state.rank ? 'fe-selected' : ''}">
                <td class="fe-order">
                  <button class="fe-btn fe-small" type="button" data-act="move" data-rank="${esc(slugOf(r))}" data-dir="-1" ${i === 0 ? 'disabled' : 'data-write'} title="${esc(dashLoc('editor.moveUp'))}">▲</button>
                  <button class="fe-btn fe-small" type="button" data-act="move" data-rank="${esc(slugOf(r))}" data-dir="1" ${i === last ? 'disabled' : 'data-write'} title="${esc(dashLoc('editor.moveDown'))}">▼</button>
                </td>
                <td>${esc(r.rank)}${i === 0 ? ` <span class="fe-badge">${esc(dashLoc('editor.leaderBadge'))}</span>` : ''}</td>
                <td>${r.capacity === null ? esc(dashLoc('editor.open')) : r.capacity}</td>
                <td>${r.assigned}</td>
                <td><button class="fe-btn fe-small" type="button" data-act="edit-rank" data-rank="${esc(slugOf(r))}">${esc(slugOf(r) === state.rank ? dashLoc('editor.editing') : dashLoc('editor.edit'))}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>` : `<p class="fe-muted">${esc(dashLoc('editor.noRanks'))}</p>`}
          <form class="fe-row" data-form="add-rank">
            <input name="rank" placeholder="${esc(dashLoc('editor.newRankName'))}" maxlength="48" required data-write>
            <input name="capacity" type="number" min="0" max="999" placeholder="${esc(dashLoc('editor.capacity'))}" title="${esc(dashLoc('editor.emptyIsOpen'))}" data-write>
            <button class="fe-btn" type="submit" data-write>${esc(dashLoc('editor.addRank'))}</button>
          </form>
        </section>`
    }

    const listsFor = () => RANK_LISTS

    // A leader carries every permission, so its own ticks are shown filled and change nothing
    function effectiveList(faction, rank, key) {
      if (rank.leader) return faction.ranks.filter(r => !r.leader).map(slugOf)
      return Array.isArray(rank[key]) ? rank[key] : []
    }

    function rankCard(faction) {
      const rank = faction.ranks.find(r => slugOf(r) === state.rank)
      if (!rank) return ''
      const leader = rank.leader === true
      const targets = faction.ranks.filter(r => r !== rank)
      return `
        <form class="fe-card" data-form="rank">
          <h4>${esc(dashLoc('editor.rankTitle', { name: rank.rank }))} <code>${esc(rank.id)}</code></h4>
          <div class="fe-grid">
            <label>${esc(dashLoc('editor.name'))} <input name="rank" value="${esc(rank.rank)}" maxlength="48" required data-write></label>
            <label>${esc(dashLoc('editor.capacity'))} <input name="capacity" type="number" min="0" max="999" value="${rank.capacity === null ? '' : rank.capacity}" placeholder="${esc(dashLoc('editor.open'))}" data-write></label>
            <label>${esc(dashLoc('editor.title'))} <input name="title" value="${esc(rank.title || '')}" maxlength="48" placeholder="${esc(rank.rank)}" data-write></label>
            <label>${esc(dashLoc('editor.titleFemale'))} <input name="titleFemale" value="${esc(rank.titleFemale || '')}" maxlength="48" placeholder="${esc(dashLoc('editor.sameAsTitle'))}" data-write></label>
          </div>
          <p class="fe-muted">${esc(dashLoc('editor.permissionString'))} <code>${esc(rank.permission || '')}</code>${esc(dashLoc('editor.permissionFixed'))}</p>
          <div class="fe-flags">${RANK_FLAGS.filter(([, , holdOnly]) => !holdOnly || faction.scope === 'hold').map(([key, label]) => `
            <label class="fe-check"><input type="checkbox" name="${key}" ${rank[key] ? 'checked' : ''} data-write> ${esc(label)}</label>`).join('')}
          </div>
          <p class="fe-muted">${leader
            ? esc(dashLoc('editor.leaderNote'))
            : esc(dashLoc('editor.rankNote'))}</p>
          ${targets.length ? `
          <table class="fe-table fe-matrix">
            <thead><tr><th>${esc(dashLoc('editor.colRank'))}</th>${listsFor(faction, rank).map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
            <tbody>${targets.map(t => `
              <tr><td>${esc(t.rank)}</td>${listsFor(faction, rank).map(([key]) => `
                <td><input type="checkbox" data-list="${key}" value="${esc(slugOf(t))}" ${effectiveList(faction, rank, key).includes(slugOf(t)) ? 'checked' : ''} data-write></td>`).join('')}
              </tr>`).join('')}
            </tbody>
          </table>` : ''}
          <div class="fe-row">
            <button class="fe-btn fe-primary" type="submit" data-write>${esc(dashLoc('editor.saveRank'))}</button>
            <button class="fe-btn" type="button" data-act="close-rank">${esc(dashLoc('editor.close'))}</button>
          </div>
          ${confirmBlock(`rank:${rank.id}`, 'delete-rank', esc(dashLoc('editor.deleteRank')))}
        </form>`
    }

    // First click shows who would lose a rank and arms the delete; the second click sends it with the count that was shown
    function confirmBlock(key, act, label) {
      const armed = state.confirm && state.confirm.key === key ? state.confirm : null
      if (!armed) return `<div class="fe-row"><button class="fe-btn fe-danger" type="button" data-act="${act}" data-write>${label}</button></div>`
      const sample = armed.sample || []
      const list = sample.length ? `<ul class="fe-sample">${sample.map(m => `<li>${esc(m.playerName || dashLoc('editor.unknown'))} (${esc(slotText(m.slot))}${m.rank ? `, ${esc(m.rank)}` : ''})</li>`).join('')}${armed.members > sample.length ? `<li>${esc(dashLoc('editor.andMore', { n: armed.members - sample.length }))}</li>` : ''}</ul>` : ''
      return `
        <div class="fe-confirm">
          ${armed.members ? `<p>${esc(act === 'delete-rank' ? plural(armed.members, 'editor.holdsRankOne', 'editor.holdsRankMany') : plural(armed.members, 'editor.holdsFactionOne', 'editor.holdsFactionMany'))}</p>${list}` : `<p>${esc(dashLoc('editor.nobodyHolds'))}</p>`}
          <div class="fe-row">
            <button class="fe-btn fe-danger" type="button" data-act="${act}" data-write>${esc(armed.members ? plural(armed.members, 'editor.removeOneAndDelete', 'editor.removeManyAndDelete') : dashLoc('editor.clickAgain'))}</button>
            <button class="fe-btn" type="button" data-act="cancel-confirm">${esc(dashLoc('editor.cancel'))}</button>
          </div>
        </div>`
    }

    function renderMembers() {
      const box = $('.fe-members')
      const faction = current()
      if (!box || !faction) return
      if (state.members === null) { box.innerHTML = `<p class="fe-muted">${esc(dashLoc('editor.loading'))}</p>`; return }
      if (!state.members.length) { box.innerHTML = `<p class="fe-muted">${esc(dashLoc('editor.noMembers'))}</p>`; return }
      const order = new Map(faction.ranks.map((r, i) => [slugOf(r), i]))
      const rows = [...state.members].sort((a, b) => (order.get(a.rankSlug) ?? 99) - (order.get(b.rankSlug) ?? 99) || String(a.playerName).localeCompare(String(b.playerName)))
      box.innerHTML = `<ul class="fe-member-list">${rows.map(m => `
        <li>${onSelectPlayer && m.discordId ? `<button class="fe-link" type="button" data-act="player" data-discord="${esc(m.discordId)}">${esc(m.playerName || dashLoc('editor.unknown'))}</button>` : esc(m.playerName || dashLoc('editor.unknown'))}
          <span class="fe-muted">${esc(m.rank || m.rankSlug)}, ${esc(slotText(m.slot))}</span></li>`).join('')}</ul>`
    }

    function createForm() {
      const courts = new Set([...state.factions.map(f => f.id), ...state.retiredFactions].filter(id => id.startsWith('hold:')).map(id => holdKey(id.split(':')[1])))
      const free = state.holds.filter(h => !courts.has(h))
      const scope = free.length ? 'hold' : 'guild'
      return `
        <form class="fe-card" data-form="create">
          <h4>${esc(dashLoc('editor.newFaction'))}</h4>
          ${state.canDefine ? '' : readOnlyNote()}
          <div class="fe-grid">
            <label>${esc(dashLoc('editor.type'))} <select name="scope" data-write>${Object.entries(TYPE_NAMES).map(([k, v]) => `<option value="${k}"${k === scope ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
            <label data-scope="hold"${scope === 'hold' ? '' : ' hidden'}>${esc(dashLoc('editor.landLabel'))} <select name="hold" data-write>${free.map(h => `<option value="${esc(h)}">${esc(holdName(h))}</option>`).join('')}<option value="">${esc(dashLoc('editor.noLandOption'))}</option></select></label>
            <label data-scope="group"${scope === 'hold' ? ' hidden' : ''}>${esc(dashLoc('editor.group'))} <input name="group" maxlength="48" placeholder="${esc(dashLoc('editor.groupPlaceholder'))}" data-write></label>
            <label>${esc(dashLoc('editor.displayName'))} <input name="name" maxlength="48" placeholder="${esc(dashLoc('editor.sameAsGroup'))}" data-write></label>
            <label>${esc(dashLoc('editor.province'))} <select name="province" data-write>${provinceOptions('Skyrim')}</select></label>
            ${colorFields('')}
          </div>
          <p class="fe-muted">${esc(dashLoc('editor.createNote'))} ${free.length ? '' : esc(dashLoc('editor.allHoldsTaken'))}</p>
          <div class="fe-row">
            <button class="fe-btn fe-primary" type="submit" data-write>${esc(dashLoc('editor.createFaction'))}</button>
            <button class="fe-btn" type="button" data-act="cancel-create">${esc(dashLoc('editor.cancel'))}</button>
          </div>
        </form>`
    }

    // A territory names its hold, or takes a group when it has no land; armies and guilds always take a group
    function syncCreateScope(form) {
      const territory = form.elements.scope.value === 'hold'
      form.querySelector('[data-scope="hold"]').hidden = !territory
      form.querySelector('[data-scope="group"]').hidden = territory && form.elements.hold.value !== ''
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    const colorValue = form => String(form.elements.color.value || '').replace(/^#/, '').toLowerCase()

    function createFaction(form) {
      const type = form.elements.scope.value
      const group = type === 'hold' && form.elements.hold.value ? holdName(form.elements.hold.value) : form.elements.group.value
      return run(dashLoc('editor.creating'), async () => {
        const data = await call('POST', '', { type, group, name: form.elements.name.value, province: form.elements.province.value, color: colorValue(form) })
        replaceFaction(data.faction)
        state.creating = false
        state.selected = data.faction.id
        state.members = []
        render()
        changed(dashLoc('editor.created', { name: data.faction.name }))
      })
    }

    function saveFaction(form) {
      const faction = current()
      const body = { rev: faction.rev, name: form.elements.name.value, province: form.elements.province.value, color: colorValue(form) }
      return run(dashLoc('editor.saving'), async () => {
        const data = await call('PATCH', factionPath(faction.id), body)
        replaceFaction(data.faction)
        render()
        changed(dashLoc('editor.factionSaved'))
      })
    }

    function addRank(form) {
      const faction = current()
      return run(dashLoc('editor.addingRank'), async () => {
        const data = await call('POST', factionPath(faction.id, '/ranks'), { rev: faction.rev, rank: form.elements.rank.value, capacity: form.elements.capacity.value })
        replaceFaction(data.faction)
        render()
        changed(dashLoc('editor.rankAdded'))
      })
    }

    function moveRank(slug, dir) {
      const faction = current()
      const ids = faction.ranks.map(slugOf)
      const from = ids.indexOf(slug)
      const to = from + dir
      if (from < 0 || to < 0 || to >= ids.length) return
      ;[ids[from], ids[to]] = [ids[to], ids[from]]
      return run(dashLoc('editor.reordering'), async () => {
        const data = await call('PUT', factionPath(faction.id, '/ranks'), { rev: faction.rev, ranks: ids })
        replaceFaction(data.faction)
        render()
        changed(to === 0 || from === 0 ? dashLoc('editor.leaderChanged') : dashLoc('editor.reordered'))
      })
    }

    function saveRank(form) {
      const faction = current()
      const rank = faction.ranks.find(r => slugOf(r) === state.rank)
      const body = { rev: faction.rev, rank: form.elements.rank.value, capacity: form.elements.capacity.value }
      for (const [key] of RANK_FLAGS) if (form.elements[key]) body[key] = form.elements[key].checked
      for (const key of ['title', 'titleFemale']) if (form.elements[key]) body[key] = form.elements[key].value
      const lists = listsFor(faction, rank)
      const ticked = Object.fromEntries(lists.map(([key]) => [key, [...form.querySelectorAll(`input[data-list="${key}"]:checked`)].map(i => i.value)]))
      // Lists are sent together once any tick changed, so what was shown is what is saved
      if (lists.some(([key]) => !sameSet(ticked[key], effectiveList(faction, rank, key)))) Object.assign(body, ticked)
      return run(dashLoc('editor.savingRank'), async () => {
        const data = await call('PATCH', rankPath(faction, state.rank), body)
        replaceFaction(data.faction)
        render()
        changed(dashLoc('editor.rankSaved'))
      })
    }

    async function deleteTarget(kind) {
      const faction = current()
      const rank = kind === 'rank' ? faction.ranks.find(r => slugOf(r) === state.rank) : null
      const key = kind === 'rank' ? `rank:${rank.id}` : `faction:${faction.id}`
      if (!state.confirm || state.confirm.key !== key) {
        const count = kind === 'rank' ? rank.assigned : faction.members
        const holders = (state.members || []).filter(m => !rank || m.rankSlug === slugOf(rank))
        state.confirm = { key, members: count, sample: holders.slice(0, SAMPLE) }
        render()
        setStatus('')
        return
      }
      const members = state.confirm.members
      const path = kind === 'rank' ? rankPath(faction, slugOf(rank)) : factionPath(faction.id)
      await run(dashLoc('editor.deleting'), async () => {
        try {
          const data = await call('DELETE', path, { rev: faction.rev, ...(members ? { removeMembers: true, expectedMembers: members } : {}) })
          state.confirm = null
          if (kind === 'rank') {
            replaceFaction(data.faction)
            state.rank = ''
          } else {
            state.factions = state.factions.filter(f => f.id !== faction.id)
            state.retiredFactions.push(faction.id)
            state.selected = ''
          }
          render()
          changed(data.removedMembers
            ? plural(data.removedMembers, kind === 'rank' ? 'editor.rankDeletedOne' : 'editor.factionDeletedOne', kind === 'rank' ? 'editor.rankDeletedMany' : 'editor.factionDeletedMany')
            : dashLoc(kind === 'rank' ? 'editor.rankDeleted' : 'editor.factionDeleted'))
          if (state.selected) await loadMembers()
        } catch (err) {
          // The count changed since it was shown: arm again with the new list
          if (err.data && err.data.hasMembers) {
            state.confirm = { key, members: err.data.members, sample: err.data.sample || [] }
            render()
          }
          throw err
        }
      })
    }

    root.addEventListener('click', event => {
      const target = event.target.closest('[data-act]')
      if (!target || !root.contains(target) || target.disabled) return
      const act = target.dataset.act
      if (act === 'select') {
        if (state.selected === target.dataset.id) return
        Object.assign(state, { selected: target.dataset.id, rank: '', creating: false, confirm: null, members: null })
        render()
        loadMembers().catch(err => setStatus(err.message, true))
      } else if (act === 'new') {
        Object.assign(state, { creating: true, selected: '', rank: '', confirm: null })
        render()
      } else if (act === 'cancel-create') {
        state.creating = false
        render()
      } else if (act === 'refresh') {
        run(dashLoc('editor.loading'), async () => { await load(); setStatus('') })
      } else if (act === 'edit-rank') {
        Object.assign(state, { rank: target.dataset.rank, confirm: null })
        render()
      } else if (act === 'close-rank') {
        Object.assign(state, { rank: '', confirm: null })
        render()
      } else if (act === 'move') {
        moveRank(target.dataset.rank, Number(target.dataset.dir))
      } else if (act === 'delete-faction' || act === 'delete-rank') {
        deleteTarget(act === 'delete-rank' ? 'rank' : 'faction')
      } else if (act === 'cancel-confirm') {
        state.confirm = null
        render()
      } else if (act === 'player' && onSelectPlayer) {
        onSelectPlayer(target.dataset.discord)
      }
    })

    root.addEventListener('submit', event => {
      const form = event.target.closest('form[data-form]')
      if (!form) return
      event.preventDefault()
      if (!state.canDefine) return
      const kind = form.dataset.form
      if (kind === 'create') createFaction(form)
      else if (kind === 'faction') saveFaction(form)
      else if (kind === 'add-rank') addRank(form)
      else if (kind === 'rank') saveRank(form)
    })

    root.addEventListener('input', event => {
      const node = event.target
      if (node.classList.contains('fe-search')) {
        state.filter = node.value
        renderList()
      } else if (node.name === 'colorPicker') {
        node.form.elements.color.value = node.value.slice(1)
      } else if (node.name === 'color') {
        const hex = node.value.replace(/^#/, '').toLowerCase()
        if (COLOR_RE.test(hex)) node.form.elements.colorPicker.value = `#${hex}`
      }
    })

    root.addEventListener('change', event => {
      if (event.target.classList.contains('fe-sort')) {
        state.sort = event.target.value === 'province' ? 'province' : 'name'
        try { localStorage.setItem(SORT_KEY, state.sort) } catch { /* per-viewer convenience only */ }
        renderList()
        return
      }
      if (['scope', 'hold'].includes(event.target.name) && event.target.form && event.target.form.dataset.form === 'create') syncCreateScope(event.target.form)
    })

    render()
    run(dashLoc('editor.loading'), async () => { await load(); setStatus('') })
    return { refresh: () => run(dashLoc('editor.loading'), async () => { await load(); setStatus('') }) }
  }

  window.FactionEditor = { mount }
})()
