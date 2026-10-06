'use strict'

const $  = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))
const el = (tag, props = {}, html) => Object.assign(document.createElement(tag), props, html != null ? { innerHTML: html } : {})
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const activeTab = () => ($('.tab.active') || {}).dataset?.tab

// Per-pane line caps: the console tails services forever and unbounded
// textContent eventually breaks rendering, so keep only the newest lines.
const LINE_LIMITS = { 'build-log': 2000 }

function appendLog(node, text) {
  if (!node) return
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  // Normalise CRLF to LF
  text = text.replace(/\r\n/g, '\n')
  if (text.indexOf('\r') === -1) {
    node.textContent += text
  } else {
    const old = node.textContent
    const cut = old.lastIndexOf('\n') + 1          // only the unfinished last line can be rewritten
    node.textContent = old.slice(0, cut) + (old.slice(cut) + text)
      .split('\n')
      .map(seg => { const i = seg.lastIndexOf('\r'); return i === -1 ? seg : seg.slice(i + 1) })
      .join('\n')
  }
  const max = Number(node.dataset.max) || LINE_LIMITS[node.id]
  if (max) {
    // A trailing '' after split is the usual newline-terminated state, not a line
    const lines = node.textContent.split('\n')
    const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    if (count > max) {
      const before = node.scrollHeight
      node.textContent = lines.slice(count - max).join('\n')
      // Content was removed from the top: keep a scrolled-up reader anchored
      if (!atBottom) node.scrollTop = Math.max(0, node.scrollTop - (before - node.scrollHeight))
    }
  }
  if (atBottom) node.scrollTop = node.scrollHeight
}

// A draggable divider after list inside split; the list's width is remembered under storageKey
function makeResizable(split, list, storageKey) {
  const bar = el('div', { className: 'splitter', title: loc('common.dragResize') })
  list.after(bar)
  list.style.flexShrink = '0'
  try { const w = Number(localStorage.getItem(storageKey)); if (w) list.style.width = w + 'px' } catch {}
  bar.addEventListener('pointerdown', e => {
    bar.setPointerCapture(e.pointerId)
    const left = split.getBoundingClientRect().left
    const move = ev => { list.style.width = Math.max(200, Math.min(ev.clientX - left, split.clientWidth - 320)) + 'px' }
    const up = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      try { localStorage.setItem(storageKey, parseInt(list.style.width, 10)) } catch {}
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
  })
}

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'))
    $$('.panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    $('#' + tab.dataset.tab).classList.add('active')
    // The News tab reads the file the first time it is opened
    if (tab.dataset.tab === 'news' && !newsLoaded) { newsLoaded = true; loadNews() }
    document.dispatchEvent(new CustomEvent('tab-shown', { detail: tab.dataset.tab }))
  })
})

// Destructive buttons ask for a second click instead of a dialog; a preview (dry run) must return truthy to arm, armMs 0 stays armed until disarmConfirm, onArm runs once armed.
const armTimers = new WeakMap()
function armConfirm(btn, label, fn, { preview = null, armMs = 4000, armedLabel = loc('common.clickAgain'), onArm = null } = {}) {
  if (!btn) return
  btn.dataset.label = label
  btn.addEventListener('click', async () => {
    if (btn.disabled) return
    if (!btn.dataset.armed) {
      if (preview) {
        btn.disabled = true
        let go = false
        try { go = await preview() } finally { btn.disabled = false }
        if (!go) return
      }
      btn.dataset.armed = '1'
      btn.textContent = armedLabel
      if (armMs > 0) armTimers.set(btn, setTimeout(() => disarmConfirm(btn), armMs))
      if (onArm) onArm()
      return
    }
    disarmConfirm(btn)
    btn.disabled = true
    try { await fn() } finally { btn.disabled = false }
  })
}

function disarmConfirm(btn) {
  if (!btn || !btn.dataset.label) return
  clearTimeout(armTimers.get(btn))
  delete btn.dataset.armed
  btn.textContent = btn.dataset.label
}

let SCHEMA = { serverSettings: [], backendEnv: [] }
let settingsKey = 'serverSettings'
let currentValues = {}
let settingsMtimeMs = null   // server-settings.json mtime at load; the save refuses when it changed since
// Both server-settings.json subtabs (live and test) share the serverSettings schema
const schemaKey = () => settingsKey === 'testServerSettings' ? 'serverSettings' : settingsKey

window.mgr.settingsSchema().then(s => { SCHEMA = s; loadSettings() })

$$('.subtab').forEach(sub => {
  sub.addEventListener('click', () => {
    $$('.subtab').forEach(s => s.classList.remove('active'))
    sub.classList.add('active')
    settingsKey = sub.dataset.cfg
    loadSettings()
  })
})

async function loadSettings() {
  const form = $('#settings-form')
  const st = $('#settings-status')
  st.textContent = loc('common.loading')
  form.innerHTML = ''
  const r = await window.mgr.settingsRead(settingsKey)
  if (!r.ok) { st.textContent = r.path ? loc('common.errorPath', { error: r.error, path: r.path }) : loc('common.error', { error: r.error }); return }
  currentValues = r.values || {}
  settingsMtimeMs = r.mtimeMs ?? null
  st.textContent = r.seeded ? loc('settings.seeded', { path: r.path }) : r.path
  renderSettingsForm(r.extra)
}

function renderSettingsForm(extra) {
  const form = $('#settings-form')
  form.innerHTML = ''
  const fields = SCHEMA[schemaKey()] || []
  const groups = []
  const byGroup = {}
  for (const f of fields) {
    if (!byGroup[f.group]) { byGroup[f.group] = []; groups.push(f.group) }
    byGroup[f.group].push(f)
  }

  for (const group of groups) {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, esc(group)))
    for (const f of byGroup[group]) fs.appendChild(renderField(f))
    form.appendChild(fs)
  }

  // server-settings.json
  if (schemaKey() === 'serverSettings') {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, esc(loc('settings.otherRaw'))))
    const wrap = el('div', { className: 'sfield wide' })
    wrap.appendChild(el('label', {}, esc(loc('settings.extraKeys'))))
    const ta = el('textarea', { id: 'settings-extra', rows: 6, spellcheck: false })
    ta.value = extra && Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '{}'
    wrap.appendChild(ta)
    fs.appendChild(wrap)
    form.appendChild(fs)
  }
}

function renderField(f) {
  const wrap = el('div', { className: 'sfield' + (f.type === 'json' ? ' wide' : '') })
  const id = 'set-' + f.key
  wrap.appendChild(el('label', { htmlFor: id }, esc(f.label)))
  const val = currentValues[f.key]

  if (f.type === 'bool') {
    const on = (settingsKey === 'backendEnv') ? String(val).toLowerCase() === 'true' : val === true
    const group = el('div', { className: 'radio-group', id })
    for (const opt of [[loc('settings.on'), true], [loc('settings.off'), false]]) {
      const lbl = el('label', { className: 'radio' })
      const radio = el('input', { type: 'radio', name: id, value: String(opt[1]) })
      if (val !== undefined && opt[1] === on) radio.checked = true
      lbl.appendChild(radio)
      lbl.appendChild(document.createTextNode(' ' + opt[0]))
      group.appendChild(lbl)
    }
    wrap.appendChild(group)
  } else if (f.type === 'select') {
    const sel = el('select', { id, className: 'sinput' })
    const cur = val == null ? '' : String(val)
    const opts = f.options.includes(cur) || cur === '' ? f.options : [cur, ...f.options]
    sel.appendChild(el('option', { value: '' }, '—'))
    for (const o of opts) { const op = el('option', { value: o }, esc(o)); if (o === cur) op.selected = true; sel.appendChild(op) }
    wrap.appendChild(sel)
  } else if (f.type === 'json') {
    const ta = el('textarea', { id, className: 'sinput', rows: 4, spellcheck: false })
    ta.value = val === undefined ? '' : JSON.stringify(val, null, 2)
    wrap.appendChild(ta)
  } else if (f.type === 'secret') {
    const row = el('div', { className: 'secret-row' })
    const inp = el('input', { id, type: 'password', className: 'sinput', value: val == null ? '' : String(val) })
    const toggle = el('button', { type: 'button', className: 'action small reveal' }, esc(loc('settings.show')))
    toggle.addEventListener('click', () => {
      inp.type = inp.type === 'password' ? 'text' : 'password'
      toggle.textContent = inp.type === 'password' ? loc('settings.show') : loc('settings.hide')
    })
    row.appendChild(inp); row.appendChild(toggle)
    wrap.appendChild(row)
  } else {
    const inp = el('input', { id, type: f.type === 'number' ? 'number' : 'text', className: 'sinput',
      value: val == null ? '' : String(val), placeholder: f.placeholder || '' })
    wrap.appendChild(inp)
  }

  if (f.help) wrap.appendChild(el('small', {}, esc(f.help)))
  return wrap
}

function collectSettings() {
  const values = {}
  for (const f of (SCHEMA[schemaKey()] || [])) {
    const id = 'set-' + f.key
    if (f.type === 'bool') {
      const checked = document.querySelector(`input[name="${id}"]:checked`)
      if (checked) values[f.key] = checked.value === 'true'
    } else {
      const node = document.getElementById(id)
      if (node) values[f.key] = node.value
    }
  }
  return values
}

$('#settings-reload').addEventListener('click', loadSettings)
$('#settings-save').addEventListener('click', async () => {
  const values = collectSettings()
  const extra = schemaKey() === 'serverSettings' ? ($('#settings-extra')?.value || '') : undefined
  $('#settings-status').textContent = loc('common.saving')
  const r = await window.mgr.settingsWrite(settingsKey, values, extra, settingsMtimeMs)
  if (r.ok && r.mtimeMs !== undefined) settingsMtimeMs = r.mtimeMs
  $('#settings-status').textContent = r.ok ? loc('settings.saved', { path: r.path }) : loc('common.error', { error: r.error })
})

// News tab

let newsLoaded = false
let newsItems = []
let newsImages = []
let newsSelected = null   // index into newsItems, or 'new'

function newsSetStatus(text, bad) {
  const node = $('#news-status')
  node.textContent = text || ''
  node.classList.toggle('bad', !!bad)
}

function renderNewsList() {
  const list = $('#news-list')
  list.innerHTML = ''
  if (!newsItems.length) {
    list.appendChild(el('li', { className: 'muted' }, esc(loc('news.none'))))
    return
  }
  newsItems.forEach((item, i) => {
    const li = el('li', { className: 'player' + (newsSelected === i ? ' selected' : '') })
    li.innerHTML = `<strong>${esc(item.title)}</strong><br><small>${esc(item.tag || 'UPDATE')} &middot; ${esc(item.date || '')}</small>`
    li.addEventListener('click', () => { newsSelected = i; renderNews() })
    list.appendChild(li)
  })
}

function renderNewsDetail() {
  const box = $('#news-detail')
  if (newsSelected === null) {
    box.innerHTML = `<p class="muted">${esc(loc('news.selectHint'))}</p>`
    return
  }
  const isNew = newsSelected === 'new'
  const item = isNew ? { title: '', body: '', tag: 'UPDATE', date: '', image: '' } : newsItems[newsSelected]
  const options = [`<option value="">${esc(loc('news.noImage'))}</option>`]
    .concat(newsImages.map(p => `<option value="${esc(p)}"${item.image === p ? ' selected' : ''}>${esc(p)}</option>`))
  // An entry may carry an http(s) image that is not in the folder; keep it selectable
  if (item.image && !newsImages.includes(item.image)) {
    options.push(`<option value="${esc(item.image)}" selected>${esc(item.image)}</option>`)
  }
  box.innerHTML = `
    <h3>${esc(isNew ? loc('news.newEntry') : loc('news.editEntry'))}</h3>
    <label>${esc(loc('news.field.title'))}<input id="news-title" type="text" maxlength="120" value="${esc(item.title)}" /></label>
    <label>${esc(loc('news.field.body'))}<textarea id="news-body" rows="6" maxlength="4000">${esc(item.body || '')}</textarea></label>
    <label>${esc(loc('news.field.tag'))}<input id="news-tag" type="text" maxlength="24" value="${esc(item.tag || 'UPDATE')}" /></label>
    <label>${esc(loc('news.field.date'))}<input id="news-date" type="text" maxlength="40" placeholder="${esc(loc('news.datePlaceholder'))}" value="${esc(item.date || '')}" /></label>
    <label>${esc(loc('news.field.image'))}<select id="news-image">${options.join('')}</select></label>
    <div class="row">
      <button id="news-image-add" class="action small">${esc(loc('news.addImage'))}</button>
      <button id="news-save" class="action go">${esc(loc('common.save'))}</button>
      ${isNew ? '' : `<button id="news-delete" class="action small stop">${esc(loc('common.delete'))}</button>`}
      <button id="news-cancel" class="action small">${esc(loc('common.cancel'))}</button>
    </div>
    <div id="news-preview" class="muted"></div>`

  const preview = $('#news-preview')
  // The panel's CSP is default-src 'self', so the image itself cannot be shown here; the launcher is where it renders
  const showPreview = () => {
    const v = $('#news-image').value
    preview.textContent = v ? loc('news.previewFrom', { url: v }) : loc('news.previewNone')
  }
  $('#news-image').addEventListener('change', showPreview)

  $('#news-image-add').addEventListener('click', async () => {
    newsSetStatus(loc('news.choosing'))
    const r = await window.mgr.newsAddImage()
    if (r.cancelled) return newsSetStatus('')
    if (!r.ok) return newsSetStatus(r.error, true)
    newsImages = r.images
    const keep = { ...item, image: r.image }
    if (isNew) { newsSelected = 'new'; newsItems = newsItems } // keep the form open
    renderNewsDetail()
    $('#news-image').value = keep.image
    $('#news-title').value = keep.title
    $('#news-body').value = keep.body || ''
    newsSetStatus(loc('news.added', { image: r.image }))
  })

  $('#news-save').addEventListener('click', async () => {
    const entry = {
      title: $('#news-title').value,
      body:  $('#news-body').value,
      tag:   $('#news-tag').value,
      date:  $('#news-date').value,
      image: $('#news-image').value,
    }
    newsSetStatus(loc('common.saving'))
    const r = await window.mgr.newsSave(isNew ? undefined : newsSelected, entry)
    if (!r.ok) return newsSetStatus(r.error, true)
    newsItems = r.items
    newsImages = r.images
    newsSelected = isNew ? 0 : newsSelected
    renderNews()
    newsSetStatus(loc('news.saved'))
  })

  if (!isNew) {
    $('#news-delete').addEventListener('click', async () => {
      if (!confirm(loc('news.deleteConfirm', { title: item.title }))) return
      newsSetStatus(loc('news.deleting'))
      const r = await window.mgr.newsDelete(newsSelected)
      if (!r.ok) return newsSetStatus(r.error, true)
      newsItems = r.items
      newsImages = r.images
      newsSelected = null
      renderNews()
      newsSetStatus(loc('news.deleted'))
    })
  }

  $('#news-cancel').addEventListener('click', () => { newsSelected = null; renderNews(); newsSetStatus('') })
  showPreview()
}

function renderNews() {
  renderNewsList()
  renderNewsDetail()
}

async function loadNews() {
  newsSetStatus(loc('common.loading'))
  const r = await window.mgr.newsList()
  if (!r.ok) return newsSetStatus(r.error, true)
  newsItems = r.items
  newsImages = r.images
  renderNews()
  newsSetStatus(loc(newsItems.length === 1 ? 'news.countOne' : 'news.countMany', { n: newsItems.length }))
}

$('#news-refresh').addEventListener('click', loadNews)
$('#news-new').addEventListener('click', () => { newsSelected = 'new'; renderNews(); newsSetStatus('') })
