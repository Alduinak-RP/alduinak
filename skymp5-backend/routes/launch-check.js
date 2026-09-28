'use strict'

/**
 * POST /api/launch-check: called by the launcher right before starting the game.
 *   Headers: { x-session: <play-session token> }
 *   Body:    { filesVersion: string, plugins: string[], server?: string }  (plugins in load order; server id, main when missing)
 * Compares the report against what the backend publishes for that server and records the
 * result on the session; session validation (master-api.js) refuses sessions whose last check
 * is missing, stale or made for another server, so out-of-date clients can't bypass the launcher's gate.
 * Returns 200 { ok, filesOk, pluginsOk, requiredVersion, playToken }; ok false means update/repair.
 * playToken (when ok) replaces the session in the game's login; unredeemed it expires in 15 minutes.
 */

const router = require('express').Router()
const path   = require('path')
const config = require('../config')
const { lookupSession, recordLaunchCheck, currentFilesVersion } = require('./master-api')
const { getGameLoadOrder } = require('./serverinfo')

// Vanilla masters ship with the game and are excluded from the comparison (mirrors the launcher's own list)
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

  const { filesVersion, plugins, server: serverId } = req.body || {}
  const server = config.serverOrMain(serverId)

  const requiredVersion = currentFilesVersion(server.id)
  // A launcher that cannot read the published manifest schema is sent back to update, where the manifest route names the fix
  const filesOk = !requiredVersion || filesVersion === requiredVersion

  // Load order: enforced only when the game server's manifest is available.
  const expected = normalizePlugins(await getGameLoadOrder(server))
  const reported = normalizePlugins(plugins)
  const pluginsOk = expected.length === 0 || expected.join('|') === reported.join('|')

  const playToken = recordLaunchCheck(token, { filesVersion: filesVersion || '', filesOk, pluginsOk, server: server.id })

  res.json({ ok: filesOk && pluginsOk, filesOk, pluginsOk, requiredVersion, playToken })
})

module.exports = router
