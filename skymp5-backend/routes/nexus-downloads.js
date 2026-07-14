const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')

const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'install-manifest.json')
const GAME = 'skyrimspecialedition'

// Minimal HTML escaping for archive names embedded in the page.
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// File-pinned Nexus link so free users grab the exact version the manifest expects (the Engine Fixes preloader now ships in the client zip, not here)
const linkFor = (modId, fileId) =>
  `https://www.nexusmods.com/${GAME}/mods/${modId}?tab=files${fileId ? `&file_id=${fileId}` : ''}`

const page = body => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alduinak mod downloads</title>
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
  .open-all {
    background:#31437a; color:#e9e9ee; border:1px solid #4a5da0; border-radius:6px;
    padding:.5rem 1rem; font-size:1rem; cursor:pointer;
  }
  .open-all:hover { background:#3b4f8d; }
  .open-all:disabled { opacity:.55; cursor:default; }
  .open-all:disabled:hover { background:#31437a; }
  .open-all-hint { display:block; margin-top:.5rem; font-size:.85rem; color:#9a9aa5; }
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`

// HTML page of every Nexus archive's download link; free accounts can't use the API, so players Ctrl+click links (about 5 at a time) to start Mod Manager Downloads
router.get('/', (_req, res) => {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (err) {
    return res.status(404).type('text/html').send(page(
      `<h1>Mod downloads aren't ready yet</h1>` +
      `<p class="empty">The install manifest has not been built on the server.</p>`))
  }

  // One link per unique Nexus file (modId+fileId) from the manifest's archives.
  const seen  = new Set()
  const items = []
  const add = (name, modId, fileId) => {
    if (!modId) return
    const key = `${modId}-${fileId || 'any'}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ name, modId, fileId: fileId || null })
  }
  for (const a of manifest.archives || []) {
    if (a.source && a.source.type === 'nexus') add(a.name, a.source.modId, a.source.fileId)
  }

  const rows = items.map(it =>
    `<li><a href="${linkFor(it.modId, it.fileId)}" target="_blank" rel="noopener">${esc(it.name)}</a></li>`
  ).join('\n')

  res.type('text/html').send(page(`
  <h1>Alduinak mod downloads</h1>
  <div class="note">
    <p><strong>Ctrl+click</strong> (Cmd+click on macOS) each link below to open it in a background tab, then click
    <strong>Slow Download</strong> on each Nexus page. Do about <strong>5 at a time</strong> so Nexus doesn't throttle you.</p>
    <p>Move every zip/7z archive you download into your <code>Alduinak/downloads</code> folder, which the launcher opened for you.</p>
    ${items.length ? `<p>
      <button class="open-all" id="open-batch">Open the first ${Math.min(5, items.length)} links</button>
      <span class="open-all-hint">Opens 5 tabs per click, working down the list, so Nexus never gets hit all at once.
      Your browser will ask you to allow pop-ups for this site the first time.</span>
    </p>` : ''}
  </div>
  ${items.length ? `<ol>\n${rows}\n</ol>` : `<p class="empty">No Nexus mods in the current manifest.</p>`}
  <script>
    var batchBtn = document.getElementById('open-batch')
    if (batchBtn) {
      var BATCH = 5
      var links = document.querySelectorAll('ol a')
      var next  = 0
      batchBtn.addEventListener('click', function () {
        // Synchronous loop on purpose: pop-up blockers only honour window.open calls
        // made directly inside the click gesture, so each click opens one small batch.
        var stop = Math.min(next + BATCH, links.length)
        var blocked = false
        while (next < stop) {
          // No 'noopener' feature: it makes window.open return null even on success,
          // which would hide blocked pop-ups. Sever the opener by hand instead.
          var win = window.open(links[next].href, '_blank')
          if (!win) { blocked = true; break }
          win.opener = null
          next++
        }
        if (blocked) {
          batchBtn.textContent = 'Pop-ups blocked - allow them for this site, then click again (' +
            next + ' of ' + links.length + ' opened)'
        } else if (next >= links.length) {
          batchBtn.disabled    = true
          batchBtn.textContent = 'All ' + links.length + ' links opened'
        } else {
          batchBtn.textContent = 'Open the next ' + Math.min(BATCH, links.length - next) +
            ' links (' + next + ' of ' + links.length + ' opened)'
        }
      })
    }
  </script>`))
})

module.exports = router
