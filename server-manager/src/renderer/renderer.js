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
  const bar = el('div', { className: 'splitter', title: 'Drag to resize' })
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
function armConfirm(btn, label, fn, { preview = null, armMs = 4000, armedLabel = 'Click again to confirm', onArm = null } = {}) {
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
  st.textContent = 'loading…'
  form.innerHTML = ''
  const r = await window.mgr.settingsRead(settingsKey)
  if (!r.ok) { st.textContent = `Error: ${r.error}` + (r.path ? ` (${r.path})` : ''); return }
  currentValues = r.values || {}
  settingsMtimeMs = r.mtimeMs ?? null
  st.textContent = r.path + (r.seeded ? '  (new — seeded from .env.example)' : '')
  renderSettingsForm(r.extra)
}

function renderSettingsForm(extra) {
  const form = $('#settings-form')
  form.innerHTML = ''
  const fields = SCHEMA[settingsKey] || []
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
  if (settingsKey === 'serverSettings') {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, 'Other (raw JSON)'))
    const wrap = el('div', { className: 'sfield wide' })
    wrap.appendChild(el('label', {}, 'Keys without a dedicated field'))
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
    for (const opt of [['On', true], ['Off', false]]) {
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
    const toggle = el('button', { type: 'button', className: 'action small reveal' }, 'show')
    toggle.addEventListener('click', () => {
      inp.type = inp.type === 'password' ? 'text' : 'password'
      toggle.textContent = inp.type === 'password' ? 'show' : 'hide'
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
  for (const f of (SCHEMA[settingsKey] || [])) {
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
  const extra = settingsKey === 'serverSettings' ? ($('#settings-extra')?.value || '') : undefined
  $('#settings-status').textContent = 'saving…'
  const r = await window.mgr.settingsWrite(settingsKey, values, extra, settingsMtimeMs)
  if (r.ok && r.mtimeMs !== undefined) settingsMtimeMs = r.mtimeMs
  $('#settings-status').textContent = r.ok ? `Saved ${r.path}` : `Error: ${r.error}`
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
    list.appendChild(el('li', { className: 'muted' }, 'No entries yet.'))
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
    box.innerHTML = '<p class="muted">Select an entry to edit it, or start a new one.</p>'
    return
  }
  const isNew = newsSelected === 'new'
  const item = isNew ? { title: '', body: '', tag: 'UPDATE', date: '', image: '' } : newsItems[newsSelected]
  const options = ['<option value="">(no image)</option>']
    .concat(newsImages.map(p => `<option value="${esc(p)}"${item.image === p ? ' selected' : ''}>${esc(p)}</option>`))
  // An entry may carry an http(s) image that is not in the folder; keep it selectable
  if (item.image && !newsImages.includes(item.image)) {
    options.push(`<option value="${esc(item.image)}" selected>${esc(item.image)}</option>`)
  }
  box.innerHTML = `
    <h3>${isNew ? 'New entry' : 'Edit entry'}</h3>
    <label>Title<input id="news-title" type="text" maxlength="120" value="${esc(item.title)}" /></label>
    <label>Body<textarea id="news-body" rows="6" maxlength="4000">${esc(item.body || '')}</textarea></label>
    <label>Tag<input id="news-tag" type="text" maxlength="24" value="${esc(item.tag || 'UPDATE')}" /></label>
    <label>Date<input id="news-date" type="text" maxlength="40" placeholder="today's date when left empty" value="${esc(item.date || '')}" /></label>
    <label>Image<select id="news-image">${options.join('')}</select></label>
    <div class="row">
      <button id="news-image-add" class="action small">Add image…</button>
      <button id="news-save" class="action go">Save</button>
      ${isNew ? '' : '<button id="news-delete" class="action small stop">Delete</button>'}
      <button id="news-cancel" class="action small">Cancel</button>
    </div>
    <div id="news-preview" class="muted"></div>`

  const preview = $('#news-preview')
  // The panel's CSP is default-src 'self', so the image itself cannot be shown here; the launcher is where it renders
  const showPreview = () => {
    const v = $('#news-image').value
    preview.textContent = v ? `The launcher loads this from ${v}` : 'No image: the card renders without one.'
  }
  $('#news-image').addEventListener('change', showPreview)

  $('#news-image-add').addEventListener('click', async () => {
    newsSetStatus('choosing…')
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
    newsSetStatus(`Added ${r.image}`)
  })

  $('#news-save').addEventListener('click', async () => {
    const entry = {
      title: $('#news-title').value,
      body:  $('#news-body').value,
      tag:   $('#news-tag').value,
      date:  $('#news-date').value,
      image: $('#news-image').value,
    }
    newsSetStatus('saving…')
    const r = await window.mgr.newsSave(isNew ? undefined : newsSelected, entry)
    if (!r.ok) return newsSetStatus(r.error, true)
    newsItems = r.items
    newsImages = r.images
    newsSelected = isNew ? 0 : newsSelected
    renderNews()
    newsSetStatus('Saved')
  })

  if (!isNew) {
    $('#news-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${item.title}"? The launcher stops showing it at once.`)) return
      newsSetStatus('deleting…')
      const r = await window.mgr.newsDelete(newsSelected)
      if (!r.ok) return newsSetStatus(r.error, true)
      newsItems = r.items
      newsImages = r.images
      newsSelected = null
      renderNews()
      newsSetStatus('Deleted')
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
  newsSetStatus('loading…')
  const r = await window.mgr.newsList()
  if (!r.ok) return newsSetStatus(r.error, true)
  newsItems = r.items
  newsImages = r.images
  renderNews()
  newsSetStatus(`${newsItems.length} ${newsItems.length === 1 ? 'entry' : 'entries'}`)
}

$('#news-refresh').addEventListener('click', loadNews)
$('#news-new').addEventListener('click', () => { newsSelected = 'new'; renderNews(); newsSetStatus('') })
