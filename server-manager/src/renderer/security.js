'use strict'
// Security tab: alerts by kind on the left, the chosen kind's alerts on the right. Opening a kind marks its alerts read;
// the red number on the tab counts the unread ones and refreshes every 30 seconds.

const ALERT_KINDS = [
  { type: 'banEvasion', label: loc('security.banEvasion.label'), hint: loc('security.banEvasion.hint') },
  { type: 'goldSpawn', label: loc('security.goldSpawn.label'), hint: loc('security.goldSpawn.hint') },
]
let unread = {}
let openKind = null

function paintUnread() {
  const total = Object.values(unread).reduce((n, v) => n + v, 0)
  const badge = $('#security-badge')
  badge.textContent = total > 99 ? '99+' : String(total)
  badge.hidden = !total
  for (const k of ALERT_KINDS) {
    const n = $(`#sec-count-${k.type}`)
    if (n) { n.textContent = unread[k.type] || ''; n.hidden = !unread[k.type] }
  }
}

async function refreshUnread() {
  const r = await window.mgr.securityUnread()
  if (r.ok) { unread = r.unread; paintUnread() }
}

function renderKinds() {
  const ul = $('#security-kinds')
  ul.innerHTML = ''
  for (const k of ALERT_KINDS) {
    const li = el('li', { className: openKind === k.type ? 'selected' : '' })
    li.innerHTML = `<div class="pl-main"><span class="pl-name">${esc(k.label)}</span><span class="count-badge" id="sec-count-${k.type}" hidden></span></div>`
    li.addEventListener('click', () => showKind(k))
    ul.appendChild(li)
  }
  paintUnread()
}

const when = d => d ? new Date(d).toLocaleString() : '-'

function alertRow(a) {
  const d = a.details || {}
  if (a.type === 'banEvasion') {
    const accounts = (d.accounts || []).map(x => `${esc(x.name || x.discordId)} <span class="muted">${esc(loc('security.account', { profileId: x.profileId, discordId: x.discordId }))}</span>${x.banned ? ` <span class="badge bad">${esc(loc('common.banned'))}</span>` : ''}`).join('<br>')
    const shared = loc('security.shared', { kind: esc(d.kind === 'hwid' ? loc('security.kindHwid') : loc('security.kindIp')), value: `<code>${esc(d.value)}</code>` })
    return `<div class="alert${a.read ? '' : ' unread'}"><div class="alert-head"><b>${shared}</b><span class="muted">${esc(when(a.createdAt))}</span></div><div>${accounts}</div></div>`
  }
  const gained = esc(loc('security.goldGained', { name: d.name || d.actorId, gain: Number(d.gain || 0).toLocaleString() }))
  const detail = esc(loc('security.goldDetail', { before: Number(d.before || 0).toLocaleString(), after: Number(d.after || 0).toLocaleString(), actorId: d.actorId, profileId: d.profileId }))
  return `<div class="alert${a.read ? '' : ' unread'}"><div class="alert-head"><b>${gained}</b><span class="muted">${esc(when(d.at || a.createdAt))}</span></div>` +
    `<div class="muted">${detail}</div></div>`
}

async function showKind(k) {
  openKind = k.type
  renderKinds()
  const box = $('#security-detail')
  box.innerHTML = `<h3>${esc(k.label)}</h3><p class="muted">${esc(k.hint)}</p><p class="muted">${esc(loc('common.loadingCap'))}</p>`
  const r = await window.mgr.securityList(k.type)
  if (!r.ok) { box.lastChild.textContent = loc('common.error', { error: r.error }); return }
  box.lastChild.remove()
  box.insertAdjacentHTML('beforeend', r.alerts.length ? r.alerts.map(alertRow).join('') : `<p class="muted">${esc(loc('security.none'))}</p>`)
  if (r.alerts.some(a => !a.read)) {
    const m = await window.mgr.securityMarkRead(k.type)
    if (m.ok) { unread = m.unread; paintUnread() }
  }
}

renderKinds()
refreshUnread()
setInterval(refreshUnread, 30000)
document.addEventListener('tab-shown', e => { if (e.detail === 'security') refreshUnread() })
