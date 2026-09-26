'use strict'

// Factions tab: the backend's shared faction editor, mounted on first open and talking to /api/factions through the main process
;(function () {
  const tab = document.querySelector('.tab[data-tab="factions"]')
  const root = document.getElementById('faction-editor')
  let editor = null

  tab.addEventListener('click', () => {
    if (editor) return
    if (!window.FactionEditor) {
      root.innerHTML = '<p class="muted">The shared editor skymp5-backend/public/dashboard/faction-editor.js did not load; run the manager from the repo checkout.</p>'
      return
    }
    editor = window.FactionEditor.mount(root, {
      request: (method, path, body) => window.mgr.factionsApi(method, path, body),
      onSelectPlayer: discordId => {
        document.querySelector('.tab[data-tab="players"]').click()
        showPlayerByDiscordId(discordId)
      },
    })
    const split = root.querySelector('.fe-split')
    if (split) makeResizable(split, split.querySelector('.fe-list'), 'factionsListWidth')
  })
})()
