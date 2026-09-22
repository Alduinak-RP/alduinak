'use strict'

// Faction and rank definition editor shared by the dashboard Factions view and the Server Manager Factions tab; the host supplies request(method, path, body)
;(function () {
  const RANK_LISTS = [
    ['recruit', 'Recruit into'],
    ['promote', 'Promote to'],
  ]
  const RANK_FLAGS = [
    ['leader', 'Leader (every permission)', false],
    ['remove', 'Removes members', false],
    ['craft', 'Crafts faction gear', false],
    ['housing', 'Manages hold property', true],
    ['arrest', 'Arrests (cuffs and cells)', false],
    ['execute', 'Executes players', false],
    ['factionAccess', 'Opens faction doors and chests', false],
  ]
  const TYPE_NAMES = { hold: 'Hold', military: 'Military', guild: 'Guild' }
  const SCOPE_NAMES = { hold: 'Hold court', faction: 'Army or guild' }
  const ZONE_NAMES = { '': 'None', west: 'West', east: 'East', neutral: 'Neutral' }
  const HOLD_NAMES = { reach: 'The Reach', rift: 'The Rift', pale: 'The Pale' }
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
  const COLOR_RE = /^[0-9a-f]{6}$/
  const SAMPLE = 10

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]))
  const slugOf = rank => String(rank.id).split(':')[2]
  const holdName = key => HOLD_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1)
  const holdKey = groupSlug => String(groupSlug || '').replace(/^the-/, '')
  const slotText = slot => (slot === null || slot === undefined ? 'every character' : `character ${Number(slot) + 1}`)
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))

  // Faction ids are "<scope>:<group>" slugs, so paths never need encoding and cannot leave /api/factions
  function factionPath(id, suffix = '') {
    const [scope, group, extra] = String(id).split(':')
    if (extra !== undefined || !SLUG_RE.test(scope || '') || !SLUG_RE.test(group || '')) throw new Error(`unexpected faction id ${id}`)
    return `/${scope}/${group}${suffix}`
  }

  function rankPath(faction, slug) {
    if (!SLUG_RE.test(slug)) throw new Error(`unexpected rank id ${slug}`)
    return factionPath(faction.id, `/ranks/${slug}`)
  }

  function mount(root, { request, onSelectPlayer = null, onChange = null } = {}) {
    const state = {
      factions: [], retiredFactions: [], zones: Object.keys(ZONE_NAMES), holds: [], canDefine: false, loaded: false,
      selected: '', rank: '', creating: false, filter: '', members: null, confirm: null, busy: false,
    }

    root.classList.add('fe')
    root.innerHTML = `
      <div class="fe-toolbar">
        <input class="fe-search" type="search" placeholder="Search factions" autocomplete="off">
        <button class="fe-btn fe-primary" type="button" data-act="new" data-write>New faction</button>
        <button class="fe-btn" type="button" data-act="refresh">Refresh</button>
        <span class="fe-status" role="status"></span>
      </div>
      <p class="fe-note">Edits reach the game server within about 20 seconds. Faction doors and chests are listed in the game server's faction-access.json.</p>
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
      const err = new Error(data.error || (res && res.error) || `request failed (${res ? res.status : 'no response'})`)
      err.data = data
      if (data.stale && data.faction) {
        replaceFaction(data.faction)
        state.confirm = null
        render()
        err.message = 'Someone else changed this faction; it has been reloaded, apply your change again.'
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
      state.retiredFactions = (data.retired && data.retired.factions) || []
      state.zones = data.zones || state.zones
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
      const shown = state.factions
        .filter(f => !q || f.name.toLowerCase().includes(q) || f.id.includes(q))
        .sort((a, b) => (a.scope === 'hold' ? 0 : 1) - (b.scope === 'hold' ? 0 : 1) || a.name.localeCompare(b.name))
      $('.fe-list').innerHTML = !state.loaded ? '<li class="fe-empty">Loading…</li>'
        : !shown.length ? `<li class="fe-empty">${q ? 'No matches.' : 'No factions yet.'}</li>`
          : shown.map(f => `
            <li data-act="select" data-id="${esc(f.id)}" class="${f.id === state.selected ? 'fe-selected' : ''}">
              <div class="fe-line">${swatch(f.color)}<span class="fe-name">${esc(f.name)}</span><span class="fe-badge">${esc(TYPE_NAMES[f.type] || f.type || SCOPE_NAMES[f.scope])}</span></div>
              <div class="fe-sub">${esc(f.id)} · ${plural(f.ranks.length, 'rank', 'ranks')} · ${plural(f.members, 'member', 'members')}</div>
            </li>`).join('')
    }

    function zoneOptions(selected) {
      return state.zones.map(z => `<option value="${esc(z)}"${z === selected ? ' selected' : ''}>${esc(ZONE_NAMES[z] ?? z)}</option>`).join('')
    }

    function colorFields(color) {
      const hex = COLOR_RE.test(color) ? color : 'c9a36b'
      return `
        <label>Colour
          <span class="fe-color"><input type="color" name="colorPicker" value="#${hex}" data-write><input name="color" value="${esc(color)}" maxlength="7" placeholder="c9a36b" data-write></span>
        </label>`
    }

    function renderDetail() {
      const detail = $('.fe-detail')
      if (state.creating) { detail.innerHTML = createForm(); return }
      const faction = current()
      if (!faction) {
        detail.innerHTML = `<p class="fe-muted">${state.loaded ? 'Pick a faction to edit it, or create a new one.' : ''}</p>${state.loaded && !state.canDefine ? readOnlyNote() : ''}`
        return
      }
      detail.innerHTML = `
        <h3 class="fe-title">${swatch(faction.color)}${esc(faction.name)} <code>${esc(faction.id)}</code></h3>
        ${state.canDefine ? '' : readOnlyNote()}
        <form class="fe-card" data-form="faction">
          <h4>Faction</h4>
          <div class="fe-grid">
            <label>Display name <input name="name" value="${esc(faction.name)}" maxlength="48" required data-write></label>
            <label>Zone <select name="zone" data-write>${zoneOptions(faction.zone)}</select></label>
            ${colorFields(faction.color)}
          </div>
          <p class="fe-muted">Type ${esc(TYPE_NAMES[faction.type] || faction.type)}, group ${esc(faction.group || faction.id)}.</p>
          <div class="fe-row"><button class="fe-btn fe-primary" type="submit" data-write>Save faction</button></div>
        </form>
        ${ranksCard(faction)}
        ${state.rank ? rankCard(faction) : ''}
        <section class="fe-card"><h4>Members</h4><div class="fe-members"></div></section>
        <section class="fe-card fe-danger-zone">
          <h4>Delete faction</h4>
          <p class="fe-muted">A deleted faction's id and rank ids are never reused${faction.scope === 'hold' ? ', so this hold can never get a new court' : ''}.</p>
          ${confirmBlock(`faction:${faction.id}`, 'delete-faction', 'Delete faction')}
        </section>`
      renderMembers()
    }

    function readOnlyNote() {
      return '<p class="fe-note fe-warn">Read only: creating, editing and deleting factions needs the factions.define permission.</p>'
    }

    function ranksCard(faction) {
      const last = faction.ranks.length - 1
      return `
        <section class="fe-card">
          <h4>Ranks <span class="fe-muted">leader first</span></h4>
          ${faction.ranks.length ? `
          <table class="fe-table">
            <thead><tr><th></th><th>Rank</th><th>Capacity</th><th>Members</th><th></th></tr></thead>
            <tbody>${faction.ranks.map((r, i) => `
              <tr class="${slugOf(r) === state.rank ? 'fe-selected' : ''}">
                <td class="fe-order">
                  <button class="fe-btn fe-small" type="button" data-act="move" data-rank="${esc(slugOf(r))}" data-dir="-1" ${i === 0 ? 'disabled' : 'data-write'} title="Move up">▲</button>
                  <button class="fe-btn fe-small" type="button" data-act="move" data-rank="${esc(slugOf(r))}" data-dir="1" ${i === last ? 'disabled' : 'data-write'} title="Move down">▼</button>
                </td>
                <td>${esc(r.rank)}${i === 0 ? ' <span class="fe-badge">leader</span>' : ''}</td>
                <td>${r.capacity === null ? 'open' : r.capacity}</td>
                <td>${r.assigned}</td>
                <td><button class="fe-btn fe-small" type="button" data-act="edit-rank" data-rank="${esc(slugOf(r))}">${slugOf(r) === state.rank ? 'Editing' : 'Edit'}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>` : '<p class="fe-muted">No ranks yet.</p>'}
          <form class="fe-row" data-form="add-rank">
            <input name="rank" placeholder="New rank name" maxlength="48" required data-write>
            <input name="capacity" type="number" min="0" max="999" placeholder="Capacity" title="Empty is open" data-write>
            <button class="fe-btn" type="submit" data-write>Add rank</button>
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
          <h4>Rank: ${esc(rank.rank)} <code>${esc(rank.id)}</code></h4>
          <div class="fe-grid">
            <label>Name <input name="rank" value="${esc(rank.rank)}" maxlength="48" required data-write></label>
            <label>Capacity <input name="capacity" type="number" min="0" max="999" value="${rank.capacity === null ? '' : rank.capacity}" placeholder="open" data-write></label>
            <label>Title <input name="title" value="${esc(rank.title || '')}" maxlength="48" placeholder="${esc(rank.rank)}" data-write></label>
            <label>Title (female) <input name="titleFemale" value="${esc(rank.titleFemale || '')}" maxlength="48" placeholder="same as title" data-write></label>
          </div>
          <p class="fe-muted">Permission string <code>${esc(rank.permission || '')}</code>, fixed by the rank id.</p>
          <div class="fe-flags">${RANK_FLAGS.filter(([, , holdOnly]) => !holdOnly || faction.scope === 'hold').map(([key, label]) => `
            <label class="fe-check"><input type="checkbox" name="${key}" ${rank[key] ? 'checked' : ''} data-write> ${esc(label)}</label>`).join('')}
          </div>
          <p class="fe-muted">${leader
            ? 'A leader carries every permission of the faction: it recruits, promotes, removes, crafts, arrests and executes, and the ticks below are ignored. Nobody leads two factions at once.'
            : 'Recruit into: the ranks this rank may bring outsiders in at; Recruit takes the lowest of them. Promote to: the ranks it may move a member below it to. Removes members covers the whole faction.'}</p>
          ${targets.length ? `
          <table class="fe-table fe-matrix">
            <thead><tr><th>Rank</th>${listsFor(faction, rank).map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
            <tbody>${targets.map(t => `
              <tr><td>${esc(t.rank)}</td>${listsFor(faction, rank).map(([key]) => `
                <td><input type="checkbox" data-list="${key}" value="${esc(slugOf(t))}" ${effectiveList(faction, rank, key).includes(slugOf(t)) ? 'checked' : ''} data-write></td>`).join('')}
              </tr>`).join('')}
            </tbody>
          </table>` : ''}
          <div class="fe-row">
            <button class="fe-btn fe-primary" type="submit" data-write>Save rank</button>
            <button class="fe-btn" type="button" data-act="close-rank">Close</button>
          </div>
          ${confirmBlock(`rank:${rank.id}`, 'delete-rank', 'Delete rank')}
        </form>`
    }

    // First click shows who would lose a rank and arms the delete; the second click sends it with the count that was shown
    function confirmBlock(key, act, label) {
      const armed = state.confirm && state.confirm.key === key ? state.confirm : null
      if (!armed) return `<div class="fe-row"><button class="fe-btn fe-danger" type="button" data-act="${act}" data-write>${label}</button></div>`
      const sample = armed.sample || []
      const list = sample.length ? `<ul class="fe-sample">${sample.map(m => `<li>${esc(m.playerName || 'Unknown')} (${esc(slotText(m.slot))}${m.rank ? `, ${esc(m.rank)}` : ''})</li>`).join('')}${armed.members > sample.length ? `<li>and ${armed.members - sample.length} more</li>` : ''}</ul>` : ''
      return `
        <div class="fe-confirm">
          ${armed.members ? `<p>${plural(armed.members, 'membership still holds', 'memberships still hold')} ${act === 'delete-rank' ? 'this rank' : "this faction's ranks"}, so a plain delete is refused.</p>${list}` : '<p>Nobody holds these ranks.</p>'}
          <div class="fe-row">
            <button class="fe-btn fe-danger" type="button" data-act="${act}" data-write>${armed.members ? `Remove ${plural(armed.members, 'membership', 'memberships')} and delete` : 'Click again to delete'}</button>
            <button class="fe-btn" type="button" data-act="cancel-confirm">Cancel</button>
          </div>
        </div>`
    }

    function renderMembers() {
      const box = $('.fe-members')
      const faction = current()
      if (!box || !faction) return
      if (state.members === null) { box.innerHTML = '<p class="fe-muted">Loading…</p>'; return }
      if (!state.members.length) { box.innerHTML = '<p class="fe-muted">Nobody holds a rank. Players join in game by invitation.</p>'; return }
      const order = new Map(faction.ranks.map((r, i) => [slugOf(r), i]))
      const rows = [...state.members].sort((a, b) => (order.get(a.rankSlug) ?? 99) - (order.get(b.rankSlug) ?? 99) || String(a.playerName).localeCompare(String(b.playerName)))
      box.innerHTML = `<ul class="fe-member-list">${rows.map(m => `
        <li>${onSelectPlayer && m.discordId ? `<button class="fe-link" type="button" data-act="player" data-discord="${esc(m.discordId)}">${esc(m.playerName || 'Unknown')}</button>` : esc(m.playerName || 'Unknown')}
          <span class="fe-muted">${esc(m.rank || m.rankSlug)}, ${esc(slotText(m.slot))}</span></li>`).join('')}</ul>`
    }

    function createForm() {
      const courts = new Set([...state.factions.map(f => f.id), ...state.retiredFactions].filter(id => id.startsWith('hold:')).map(id => holdKey(id.split(':')[1])))
      const free = state.holds.filter(h => !courts.has(h))
      const scope = free.length ? 'hold' : 'guild'
      return `
        <form class="fe-card" data-form="create">
          <h4>New faction</h4>
          ${state.canDefine ? '' : readOnlyNote()}
          <div class="fe-grid">
            <label>Type <select name="scope" data-write>${Object.entries(TYPE_NAMES).map(([k, v]) => `<option value="${k}"${k === scope ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
            <label data-scope="hold"${scope === 'hold' ? '' : ' hidden'}>Hold <select name="hold" data-write>${free.map(h => `<option value="${esc(h)}">${esc(holdName(h))}</option>`).join('')}</select></label>
            <label data-scope="faction"${scope === 'faction' ? '' : ' hidden'}>Group <input name="group" maxlength="48" placeholder="Vigilants of Stendarr" data-write></label>
            <label>Display name <input name="name" maxlength="48" placeholder="Same as the group" data-write></label>
            <label>Zone <select name="zone" data-write>${zoneOptions('')}</select></label>
            ${colorFields('')}
          </div>
          <p class="fe-muted">The id comes from the kind and group, cannot change once created, and is never reused after a delete. ${free.length ? '' : 'Every hold has a court, and a hold whose court was deleted cannot get a new one.'}</p>
          <div class="fe-row">
            <button class="fe-btn fe-primary" type="submit" data-write>Create faction</button>
            <button class="fe-btn" type="button" data-act="cancel-create">Cancel</button>
          </div>
        </form>`
    }

    function syncCreateScope(form) {
      const scope = form.elements.scope.value
      form.querySelectorAll('[data-scope]').forEach(node => { node.hidden = (node.dataset.scope === 'hold') !== (scope === 'hold') })
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    const colorValue = form => String(form.elements.color.value || '').replace(/^#/, '').toLowerCase()

    function createFaction(form) {
      const type = form.elements.scope.value
      const group = type === 'hold' ? holdName(form.elements.hold.value || '') : form.elements.group.value
      return run('Creating…', async () => {
        const data = await call('POST', '', { type, group, name: form.elements.name.value, zone: form.elements.zone.value, color: colorValue(form) })
        replaceFaction(data.faction)
        state.creating = false
        state.selected = data.faction.id
        state.members = []
        render()
        changed(`Created ${data.faction.name}.`)
      })
    }

    function saveFaction(form) {
      const faction = current()
      const body = { rev: faction.rev, name: form.elements.name.value, zone: form.elements.zone.value, color: colorValue(form) }
      return run('Saving…', async () => {
        const data = await call('PATCH', factionPath(faction.id), body)
        replaceFaction(data.faction)
        render()
        changed('Faction saved.')
      })
    }

    function addRank(form) {
      const faction = current()
      return run('Adding rank…', async () => {
        const data = await call('POST', factionPath(faction.id, '/ranks'), { rev: faction.rev, rank: form.elements.rank.value, capacity: form.elements.capacity.value })
        replaceFaction(data.faction)
        render()
        changed('Rank added.')
      })
    }

    function moveRank(slug, dir) {
      const faction = current()
      const ids = faction.ranks.map(slugOf)
      const from = ids.indexOf(slug)
      const to = from + dir
      if (from < 0 || to < 0 || to >= ids.length) return
      ;[ids[from], ids[to]] = [ids[to], ids[from]]
      return run('Reordering…', async () => {
        const data = await call('PUT', factionPath(faction.id, '/ranks'), { rev: faction.rev, ranks: ids })
        replaceFaction(data.faction)
        render()
        changed(to === 0 || from === 0 ? 'Ranks reordered; the leader changed.' : 'Ranks reordered.')
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
      return run('Saving rank…', async () => {
        const data = await call('PATCH', rankPath(faction, state.rank), body)
        replaceFaction(data.faction)
        render()
        changed('Rank saved.')
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
      await run('Deleting…', async () => {
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
          changed(`${kind === 'rank' ? 'Rank' : 'Faction'} deleted${data.removedMembers ? `, ${plural(data.removedMembers, 'membership', 'memberships')} removed` : ''}.`)
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
        run('Loading…', async () => { await load(); setStatus('') })
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
      if (event.target.name === 'scope' && event.target.form && event.target.form.dataset.form === 'create') syncCreateScope(event.target.form)
    })

    render()
    run('Loading…', async () => { await load(); setStatus('') })
    return { refresh: () => run('Loading…', async () => { await load(); setStatus('') }) }
  }

  window.FactionEditor = { mount }
})()
