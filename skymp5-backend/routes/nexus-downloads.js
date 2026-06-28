const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')

const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'install-manifest.json')
const GAME = 'skyrimspecialedition'

// Minimal HTML escaping for archive names embedded in the page.
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// File-pinned Nexus link so free users grab the exact version the manifest expects.
const linkFor = (modId, fileId) =>
  `https://www.nexusmods.com/${GAME}/mods/${modId}?tab=files&file_id=${fileId}`

// Nexus root components installed outside the mod manifest (mirrors skymp5-launcher ENGINE_FIXES) so the page covers every browser download.
const ROOT_NEXUS = [
  { name: 'SSE Engine Fixes (Part 2)', modId: 17230, fileId: 725261 },
]

const page = body => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkyRP mod downloads</title>
<style>
  body { font-family: system-ui, sans-serif; background:#1b1b1f; color:#e9e9ee; margin:0; padding:2rem; line-height:1.5; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; }
  ol { padding-left: 1.4rem; }
  li { margin: .35rem 0; }
  a { color:#8ab4ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .note { background:#26262c; border:1px solid #36363e; border-radius:8px; padding:1rem 1.2rem; margin:1rem 0 1.5rem; }
  code { background:#000; padding:.1rem .35rem; border-radius:4px; }
  .empty { color:#bbb; }
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`

// HTML page listing every Nexus archive's direct download link. Free Nexus
// accounts can't fetch archives through the API, so players open this page and
// Ctrl+click each link (about 5 at a time) to start the Mod Manager Downloads.
router.get('/', (_req, res) => {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (err) {
    return res.status(404).type('text/html').send(page(
      `<h1>Mod downloads aren't ready yet</h1>` +
      `<p class="empty">The install manifest has not been built on the server.</p>`))
  }

  // One link per unique Nexus file (modId+fileId): manifest mods first, then root components.
  const seen  = new Set()
  const items = []
  const add = (name, modId, fileId) => {
    if (!modId || !fileId) return
    const key = `${modId}-${fileId}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ name, modId, fileId })
  }
  for (const a of manifest.archives || []) {
    if (a.source && a.source.type === 'nexus') add(a.name, a.source.modId, a.source.fileId)
  }
  for (const r of ROOT_NEXUS) add(r.name, r.modId, r.fileId)

  const rows = items.map(it =>
    `<li><a href="${linkFor(it.modId, it.fileId)}" target="_blank" rel="noopener">${esc(it.name)}</a></li>`
  ).join('\n')

  res.type('text/html').send(page(`
  <h1>SkyRP mod downloads</h1>
  <div class="note">
    <p><strong>Ctrl+click</strong> (Cmd+click on macOS) each link below to open it in a background tab, then click
    <strong>Slow Download</strong> on each Nexus page. Do about <strong>5 at a time</strong> so Nexus doesn't throttle you.</p>
    <p>Move every zip/7z archive you download into your <code>SkyRP/downloads</code> folder, which the launcher opened for you.</p>
  </div>
  ${items.length ? `<ol>\n${rows}\n</ol>` : `<p class="empty">No Nexus mods in the current manifest.</p>`}`))
})

module.exports = router
