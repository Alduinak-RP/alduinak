'use strict'

/**
 * Master API, called by the SkyMP game server (not the client directly).
 * Mounted twice in server.js:
 *   app.use('/auth',        masterApiRoute)  -> POST /auth/session
 *   app.use('/api/servers', masterApiRoute)  -> GET/POST /api/servers/:key/…
 *
 * Endpoints:
 *   POST /auth/session
 *     Body: { discordUser: { id, username } }  Returns: { profileId, session }
 *     Called by the launcher after Discord login; the game client passes the session token to the game server.
 *   GET /api/servers/:key/sessions/:session
 *     Validates a session token. Returns: { user: { id, discordId, username } }
 *   GET /api/servers/:key/sessions/:session/balance
 *     Returns a player's coin balance: { user: { id, balance } }
 *   POST /api/servers/:key/sessions/:session/purchase  (X-Auth-Token)
 *     Spends a player's coins. Body: { balanceToSpend: number }  Returns: { balanceSpent, success }
 *   GET /api/servers/:key/profiles/:profileId/check
 *     Offline-mode profileId check, same lock/whitelist rules as session validation. Returns { allowed: true } or 403/404 { error }
 *   POST /api/servers/:key/profiles/:profileId/factions  (X-Auth-Token)
 *     In-game faction appointment. Body: { requirementId, playerName?, notes? }
 *   DELETE /api/servers/:key/profiles/:profileId/factions/:assignmentId  (X-Auth-Token)
 *     Removes one official backend faction slot.
 */

const router = require('express').Router()
const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')
const factionWhitelist = require('../sources/factionWhitelist')
const serverAccess = require('../sources/serverAccess')
const profiles = require('../sources/profiles')
const players  = require('../sources/players')

// Persistent balance store: profileId -> coin balance

const BALANCES_PATH = path.join(__dirname, '..', 'data', 'balances.json')

function loadBalances() {
  try { return JSON.parse(fs.readFileSync(BALANCES_PATH, 'utf8')) }
  catch { return {} }
}

function saveBalances(data) {
  try { fs.writeFileSync(BALANCES_PATH, JSON.stringify(data, null, 2) + '\n') }
  catch (e) { console.error('Failed to persist balances:', e) }
}

function getBalance(profileId) {
  const data = loadBalances()
  return typeof data[profileId] === 'number' ? data[profileId] : 0
}

function setBalance(profileId, balance) {
  const data = loadBalances()
  data[profileId] = balance
  saveBalances(data)
}

// In-memory session store, used for online-mode validation only

const sessions      = new Map()
const SESSION_TTL   = 24 * 60 * 60 * 1000  // 24 h
const SESSIONS_PATH = path.join(__dirname, '..', 'data', 'sessions.json')

function pruneExpired() {
  const now = Date.now()
  for (const [token, s] of sessions)
    if (s.expiresAt < now) sessions.delete(token)
}

function saveSessions() {
  const now     = Date.now()
  const entries = [...sessions.entries()].filter(([, s]) => s.expiresAt > now)
  try { fs.writeFileSync(SESSIONS_PATH, JSON.stringify(entries, null, 2) + '\n') }
  catch (e) { console.error('Failed to persist sessions:', e) }
}

function loadSessions() {
  try {
    const entries = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'))
    const now     = Date.now()
    for (const [token, s] of entries)
      if (s.expiresAt > now) sessions.set(token, s)
    console.log(`Loaded ${sessions.size} active session(s) from disk`)
  } catch { /* first run or file absent: start fresh */ }
}

loadSessions()

// Helper: look up a session entry (exported for serverinfo route)

function lookupSession(token) {
  pruneExpired()
  return sessions.get(token) || null
}

// Launch sanity check: the launcher reports files version + plugin list to POST /api/launch-check; the result is stored on the session so validation can refuse stale or launcher-skipping clients

const LAUNCH_VERSION_PATH = path.join(__dirname, '..', 'data', 'files-version.json')

function currentFilesVersion() {
  try { return JSON.parse(fs.readFileSync(LAUNCH_VERSION_PATH, 'utf8')).version || null }
  catch { return null }   // no package published yet: nothing to enforce
}

function recordLaunchCheck(token, check) {
  const entry = sessions.get(token)
  if (!entry) return false
  entry.launchCheck = { ...check, at: Date.now() }
  saveSessions()
  return true
}

// Returns { ok: true } or { ok: false, error } for the session-validation gate.
function launchGateStatus(entry) {
  if (!config.launchCheckEnforce) return { ok: true }
  const required = currentFilesVersion()
  if (!required) return { ok: true }   // no published package: can't compare
  const lc = entry.launchCheck
  if (!lc) return { ok: false, error: 'launchCheckMissing' }
  if (lc.filesVersion !== required) return { ok: false, error: 'clientOutdated' }
  if (lc.pluginsOk === false) return { ok: false, error: 'loadOrderMismatch' }
  return { ok: true }
}

// Helper: validate server master key

function checkKey(req, res) {
  if (req.params.key !== config.serverMasterKey) {
    res.status(403).json({ error: 'Invalid master key.' })
    return false
  }
  return true
}

function checkWriteToken(req, res) {
  const authToken = req.headers['x-auth-token']
  if (!authToken || authToken !== config.masterApiAuthToken) {
    res.status(403).json({ error: 'Invalid auth token.' })
    return false
  }
  return true
}

function getProfileDiscordId(req, res) {
  const profileId = parseInt(req.params.profileId, 10)
  if (isNaN(profileId)) {
    res.status(400).json({ error: 'Invalid profileId.' })
    return null
  }

  const discordId = profiles.getDiscordIdByProfileId(profileId)
  if (!discordId) {
    res.status(404).json({ error: 'profileNotFound' })
    return null
  }

  return discordId
}

function getProfileFactionPayload(discordId) {
  return {
    permissions: factionWhitelist.getPlayerFactionPermissions(discordId),
    gameFactions: factionWhitelist.getPlayerGameFactions(discordId),
    factions: factionWhitelist.getPlayerAssignments(discordId),
  }
}

// Session creation helper (used by POST /auth/session and discord-auth callback)

function createSession(discordUser) {
  pruneExpired()
  const player = players.upsertFromDiscordUser(discordUser)
  const profileId = player.profileId
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, {
    profileId,
    discordId: discordUser.id,
    username:  discordUser.username || '',
    expiresAt: Date.now() + SESSION_TTL,
  })
  saveSessions()
  return { profileId, session: token }
}

// POST /auth/session

router.post('/session', (req, res) => {
  const { discordUser } = req.body || {}
  if (!discordUser || !discordUser.id)
    return res.status(400).json({ error: 'Missing discordUser.id' })

  const result = createSession(discordUser)
  res.json(result)
})

// GET /api/servers/:key/sessions/:session

router.get('/:key/sessions/:session', async (req, res) => {
  if (!checkKey(req, res)) return

  pruneExpired()
  const entry = sessions.get(req.params.session)
  if (!entry)
    return res.status(404).json({ error: 'Session not found or expired.' })

  let access
  try {
    access = await serverAccess.getDiscordAccess(entry.discordId)
  } catch (err) {
    console.error('[master-api] access role check failed:', err.message)
    return res.status(503).json({ error: 'accessUnavailable' })
  }

  if (!access.allowed) {
    return res.status(403).json({ error: access.error || 'accessDenied' })
  }

  // Refuse clients whose files/load order weren't verified by the launcher right before this game start
  const gate = launchGateStatus(entry)
  if (!gate.ok) {
    console.log(`[master-api] refused session for ${entry.username || entry.profileId}: ${gate.error}`)
    return res.status(403).json({ error: gate.error })
  }

  // Sliding expiration
  entry.expiresAt = Date.now() + SESSION_TTL
  saveSessions()

  res.json({
    user: {
      id:        entry.profileId,
      discordId: entry.discordId,
      username:  entry.username,
      roles:     access.roles,
      permissions: factionWhitelist.getPlayerFactionPermissions(entry.discordId),
      gameFactions: factionWhitelist.getPlayerGameFactions(entry.discordId),
      factions: factionWhitelist.getPlayerAssignments(entry.discordId),
    },
  })
})

// GET /api/servers/:key/profiles/:profileId/check
// Used by the game server in offline mode to verify a profileId is allowed.

router.get('/:key/profiles/:profileId/check', async (req, res) => {
  if (!checkKey(req, res)) return

  const discordId = getProfileDiscordId(req, res)
  if (!discordId) return

  let access
  try {
    access = await serverAccess.getDiscordAccess(discordId)
  } catch (err) {
    console.error('[master-api] offline access role check failed:', err.message)
    return res.status(503).json({ error: 'accessUnavailable' })
  }

  if (!access.allowed) {
    return res.status(403).json({ error: access.error || 'accessDenied' })
  }

  res.json({
    allowed: true,
    roles: access.roles,
    ...getProfileFactionPayload(discordId),
  })
})

// GET /api/servers/:key/holds/:holdSlug/roster
// Full member list of one hold (online or not) for the in-game faction menu.

router.get('/:key/holds/:holdSlug/roster', (req, res) => {
  if (!checkKey(req, res)) return

  try {
    // Read-only profile lookup, and discordIds stay out of the response
    const profileMap = profiles.load().map
    const members = factionWhitelist.getHoldRoster(req.params.holdSlug).map(member => ({
      profileId: profileMap[member.discordId] || null,
      playerName: member.playerName,
      rank: member.rank,
      rankSlug: member.rankSlug,
      slot: member.slot,
    }))
    res.json({ hold: req.params.holdSlug, members })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to load roster' })
  }
})

// POST /api/servers/:key/profiles/:profileId/factions

router.post('/:key/profiles/:profileId/factions', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const discordId = getProfileDiscordId(req, res)
  if (!discordId) return

  try {
    const assignment = factionWhitelist.createAssignment({
      ...req.body,
      discordId,
    }, 'skymp-server')
    res.status(201).json({
      assignment,
      ...getProfileFactionPayload(discordId),
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to assign faction' })
  }
})

// DELETE /api/servers/:key/profiles/:profileId/factions/:assignmentId

router.delete('/:key/profiles/:profileId/factions/:assignmentId', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const discordId = getProfileDiscordId(req, res)
  if (!discordId) return

  try {
    const belongsToPlayer = factionWhitelist
      .getPlayerAssignments(discordId)
      .some(assignment => assignment.id === req.params.assignmentId)
    if (!belongsToPlayer) return res.status(404).json({ error: 'assignment not found for player' })

    factionWhitelist.deleteAssignment(req.params.assignmentId)
    res.json({
      ok: true,
      ...getProfileFactionPayload(discordId),
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to remove faction' })
  }
})

// GET /api/servers/:key/sessions/:session/balance

router.get('/:key/sessions/:session/balance', (req, res) => {
  if (!checkKey(req, res)) return

  pruneExpired()
  const entry = sessions.get(req.params.session)
  if (!entry)
    return res.status(404).json({ error: 'Session not found or expired.' })

  const balance = getBalance(entry.profileId)
  res.json({ user: { id: entry.profileId, balance } })
})

// POST /api/servers/:key/sessions/:session/purchase

router.post('/:key/sessions/:session/purchase', (req, res) => {
  if (!checkKey(req, res)) return

  if (!checkWriteToken(req, res)) return

  pruneExpired()
  const entry = sessions.get(req.params.session)
  if (!entry)
    return res.status(404).json({ error: 'Session not found or expired.' })

  const { balanceToSpend } = req.body || {}
  if (typeof balanceToSpend !== 'number' || balanceToSpend < 0)
    return res.status(400).json({ error: 'balanceToSpend must be a non-negative number.' })

  const current = getBalance(entry.profileId)
  if (current < balanceToSpend)
    return res.json({ balanceSpent: 0, success: false })

  setBalance(entry.profileId, current - balanceToSpend)
  res.json({ balanceSpent: balanceToSpend, success: true })
})

// Wraps getDiscordAccess for the serverinfo routes.
async function isDiscordWhitelisted(discordId) {
  const result = await serverAccess.getDiscordAccess(discordId)
  return result.allowed === true
}

module.exports = router
module.exports.lookupSession  = lookupSession
module.exports.createSession  = createSession
module.exports.isDiscordWhitelisted = isDiscordWhitelisted
module.exports.recordLaunchCheck    = recordLaunchCheck
module.exports.currentFilesVersion  = currentFilesVersion
