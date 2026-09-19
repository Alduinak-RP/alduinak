const fs     = require('fs')
const path   = require('path')
const router = require('express').Router()

// The Server Manager's News tab writes data/news.json while the backend is running, so the file is read
// from disk rather than require()d: a require would cache the first read and the launcher would show
// yesterday's news until the service restarted. The mtime check keeps that to one stat per request.
const FILE = path.join(__dirname, '..', 'data', 'news.json')

let cached = { mtimeMs: -1, items: [] }

function readNews() {
  let stat
  try { stat = fs.statSync(FILE) } catch { return [] }
  if (stat.mtimeMs === cached.mtimeMs) return cached.items
  try {
    const items = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    cached = { mtimeMs: stat.mtimeMs, items: Array.isArray(items) ? items : [] }
  } catch {
    // A half-written file is ignored; the last good read stands until it parses again
    return cached.items
  }
  return cached.items
}

router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`
  const items = readNews().map(item => ({
    ...item,
    image: item.image
      ? /^https?:\/\//i.test(item.image) ? item.image : `${base}${item.image}`
      : null,
  }))
  res.json(items)
})

module.exports = router
