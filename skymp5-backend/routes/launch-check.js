'use strict'

/**
 * POST /api/launch-check
 *
 * Called by the launcher right before starting the game.
 *   Headers: { x-session: <play-session token> }
 *   Body:    { filesVersion: string, plugins: string[] }  (plugins in load order)
 *
 * Compares the reported client-files version and plugin list against what the
 * backend currently publishes, and records the result on the session. The
 * game server's session validation (master-api.js) refuses sessions whose
 * last launch check is missing or stale, so out-of-date clients cannot
 * connect even if they bypass the launcher's own gate.
 *
 * Returns 200 { ok, filesOk, pluginsOk, requiredVersion } - `ok` false means
 * the launcher should update/repair instead of launching.
 */

const router = require('express').Router()
const path   = require('path')
const { lookupSession, recordLaunchCheck, currentFilesVersion } = require('./master-api')
const { getGameLoadOrder } = require('./serverinfo')

// Vanilla masters ship with the game; they are not distributed by the server
// and are excluded from the comparison (mirrors the launcher's own list).
const VANILLA_MASTERS = new Set([
  'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm', '_resourcepack.esl',
])

function normalizePlugins(list) {
  return (Array.isArray(list) ? list : [])
    .map(f => path.basename(String(f)).toLowerCase())
    .filter(f => f && !VANILLA_MASTERS.has(f))
}

router.post('/', async (req, res) => {
  const token = req.headers['x-session']
  if (!token) return res.status(401).json({ error: 'Missing x-session header.' })

  const entry = lookupSession(token)
  if (!entry) return res.status(401).json({ error: 'Invalid or expired session.' })

  const { filesVersion, plugins } = req.body || {}

  const requiredVersion = currentFilesVersion()
  const filesOk = !requiredVersion || filesVersion === requiredVersion

  // Load order: enforced only when the game server's manifest is available.
  const expected = normalizePlugins(await getGameLoadOrder())
  const reported = normalizePlugins(plugins)
  const pluginsOk = expected.length === 0 || expected.join('|') === reported.join('|')

  recordLaunchCheck(token, { filesVersion: filesVersion || '', filesOk, pluginsOk })

  res.json({ ok: filesOk && pluginsOk, filesOk, pluginsOk, requiredVersion })
})

module.exports = router
