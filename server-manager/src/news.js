'use strict'

// The launcher's Latest News: reads and writes skymp5-backend/data/news.json and the images beside it.
// The backend re-reads the file on every request (routes/news.js), so a save here reaches the launcher
// without restarting the service.

const fs     = require('fs')
const path   = require('path')
const config = require('./config')

const FILE    = path.join(config.repoRoot, 'skymp5-backend', 'data', 'news.json')
const IMG_DIR = path.join(config.repoRoot, 'skymp5-backend', 'public', 'images')
// What the launcher's news card renders; anything else in an entry is kept as it stands
const FIELDS  = ['title', 'body', 'date', 'tag', 'image']
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const MAX_TITLE = 120
const MAX_BODY  = 4000
const MAX_ITEMS = 100

const trim = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+$/, '').slice(0, max)

function readAll() {
  try {
    const items = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(items) ? items : []
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw new Error(`news.json is not valid JSON, refusing to touch it: ${err.message}`)
  }
}

function writeAll(items) {
  const tmp = FILE + '.tmp'
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FILE)
}

// "Sep 18, 2026", the spelling the existing entries use
function today() {
  const d = new Date()
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${month} ${d.getDate()}, ${d.getFullYear()}`
}

// A stored image is "/images/<name>"; an http(s) url is kept whole
function cleanImage(value) {
  const v = String(value || '').trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v.slice(0, 500)
  const name = path.basename(v)
  if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) throw new Error(`${name} is not an image the launcher can show`)
  return '/images/' + name
}

function list() {
  return { ok: true, items: readAll(), images: images() }
}

// The images already sitting in the backend's public folder, for the picker
function images() {
  try {
    return fs.readdirSync(IMG_DIR)
      .filter(n => IMAGE_EXT.has(path.extname(n).toLowerCase()))
      .sort()
      .map(n => '/images/' + n)
  } catch {
    return []
  }
}

// index null appends, otherwise replaces that entry in place
function save(index, entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'no entry to save' }
  const title = trim(entry.title, MAX_TITLE)
  if (!title) return { ok: false, error: 'a news entry needs a title' }
  let image
  try { image = cleanImage(entry.image) } catch (err) { return { ok: false, error: err.message } }

  const items = readAll()
  const at = index === null || index === undefined ? -1 : Number(index)
  if (at !== -1 && (!Number.isInteger(at) || at < 0 || at >= items.length)) return { ok: false, error: 'that entry is gone; refresh and try again' }
  if (at === -1 && items.length >= MAX_ITEMS) return { ok: false, error: `the launcher only ever shows a handful; ${MAX_ITEMS} entries is enough` }

  const next = {
    ...(at === -1 ? {} : items[at]),
    title,
    body: trim(entry.body, MAX_BODY),
    date: trim(entry.date, 40) || (at === -1 ? today() : items[at].date || today()),
    tag:  trim(entry.tag, 24).toUpperCase() || 'UPDATE',
    image,
  }
  if (!next.image) delete next.image
  // Newest first: that is the order the launcher renders them in
  if (at === -1) items.unshift(next)
  else items[at] = next
  writeAll(items)
  return { ok: true, items, images: images() }
}

function remove(index) {
  const items = readAll()
  const at = Number(index)
  if (!Number.isInteger(at) || at < 0 || at >= items.length) return { ok: false, error: 'that entry is gone; refresh and try again' }
  items.splice(at, 1)
  writeAll(items)
  return { ok: true, items, images: images() }
}

// Copies a picked file into the backend's public images folder and returns its "/images/<name>" path
function addImage(sourcePath) {
  const src = String(sourcePath || '')
  if (!src) return { ok: false, error: 'no file chosen' }
  const name = path.basename(src)
  if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) return { ok: false, error: `${name} is not a png, jpg, gif or webp` }
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true })
    fs.copyFileSync(src, path.join(IMG_DIR, name))
  } catch (err) {
    return { ok: false, error: `could not copy the image: ${err.message}` }
  }
  return { ok: true, image: '/images/' + name, images: images() }
}

module.exports = { list, save, remove, addImage, FILE, IMG_DIR }
