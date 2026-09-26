'use strict'
// Security tab: alerts by kind on the left, the chosen kind's alerts on the right. Opening a kind marks its alerts read;
// the red number on the tab counts the unread ones and refreshes every 30 seconds.

const ALERT_KINDS = [
  { type: 'banEvasion', label: 'Ban Evasions', hint: 'An IP address or HWID seen on more than one Discord account.' },
  { type: 'goldSpawn', label: 'Gold Spawning', hint: 'A character gained more gold than goldAlertThreshold (default 5000) within 10 seconds: looting, a trade or a spawn.' },
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
    const accounts = (d.accounts || []).map(x => `${esc(x.name || x.discordId)} <span class="muted">(profile ${esc(x.profileId)}, ${esc(x.discordId)})</span>${x.banned ? ' <span class="badge bad">banned</span>' : ''}`).join('<br>')
    return `<div class="alert${a.read ? '' : ' unread'}"><div class="alert-head"><b>${d.kind === 'hwid' ? 'HWID' : 'IP'} <code>${esc(d.value)}</code> is shared</b><span class="muted">${esc(when(a.createdAt))}</span></div><div>${accounts}</div></div>`
  }
  return `<div class="alert${a.read ? '' : ' unread'}"><div class="alert-head"><b>${esc(d.name || d.actorId)} gained ${Number(d.gain || 0).toLocaleString()} gold</b><span class="muted">${esc(when(d.at || a.createdAt))}</span></div>` +
    `<div class="muted">${Number(d.before || 0).toLocaleString()} to ${Number(d.after || 0).toLocaleString()} gold, character ${esc(d.actorId)}, profile ${esc(d.profileId)}</div></div>`
}

async function showKind(k) {
  openKind = k.type
  renderKinds()
  const box = $('#security-detail')
  box.innerHTML = `<h3>${esc(k.label)}</h3><p class="muted">${esc(k.hint)}</p><p class="muted">Loading…</p>`
  const r = await window.mgr.securityList(k.type)
  if (!r.ok) { box.lastChild.textContent = `Error: ${r.error}`; return }
  box.lastChild.remove()
  box.insertAdjacentHTML('beforeend', r.alerts.length ? r.alerts.map(alertRow).join('') : '<p class="muted">No alerts.</p>')
  if (r.alerts.some(a => !a.read)) {
    const m = await window.mgr.securityMarkRead(k.type)
    if (m.ok) { unread = m.unread; paintUnread() }
  }
}

renderKinds()
refreshUnread()
setInterval(refreshUnread, 30000)
document.addEventListener('tab-shown', e => { if (e.detail === 'security') refreshUnread() })
