'use strict'

/**
 * Master API, called by the SkyMP game server (not the client directly).
 * Mounted in server.js:
 *   app.use('/api/servers', masterApiRoute)  -> GET/POST /api/servers/:key/…
 *
 * Endpoints:
 *   GET /api/servers/:key/sessions/:session
 *     Validates a session token. Returns: { user: { id, discordId, username } }
 *   GET /api/servers/:key/sessions/:session/balance
 *     Returns a player's coin balance: { user: { id, balance } }
 *   POST /api/servers/:key/sessions/:session/purchase  (X-Auth-Token)
 *     Spends a player's coins. Body: { balanceToSpend: number }  Returns: { balanceSpent, success }
 *   GET /api/servers/:key/profiles/:profileId/check
 *     Offline-mode profileId check, same lock/whitelist rules as session validation. Returns { allowed: true } or 403/404 { error }
 *   POST /api/servers/:key/connection-check  (X-Auth-Token)
 *     Game server reports a connecting player. Body: { profileId, ip }  Returns { allowed: true } or { allowed: false, reason: 'banned' }
 *   GET /api/servers/:key/players  (X-Auth-Token)
 *     Full player roster (identity fields only) for the in-game admin panel.
 *   POST /api/servers/:key/profiles/:profileId/factions  (X-Auth-Token)
 *     In-game faction appointment. Body: { requirementId, slot?, playerName?, notes?, by? }  slot null = every character
 *   DELETE /api/servers/:key/profiles/:profileId/factions/:assignmentId  (X-Auth-Token)
 *     Removes one official backend faction slot.
 *   GET /api/servers/:key/factions  (X-Auth-Token)
 *     Faction and rank definitions without member counts: { factions, requirements }; Express's ETag answers If-None-Match with 304
 *     Each faction carries its type (hold|military|guild), regencyEnabled and regents as [{ profileId, slot }] in regency order
 *   PUT /api/servers/:key/groups/:scope/:group/regency  (X-Auth-Token)
 *     Rewrites one faction's regency. Body: { enabled?, regents?: [{ profileId, slot }], by? }
 *   GET /api/servers/:key/groups/:scope/:group/roster  (X-Auth-Token)
 *     Every member of one faction, online or not: { members: [{ profileId, playerName, rank, rankSlug, slot }] }
 *   DELETE /api/servers/:key/profiles/:profileId/characters/:slot/factions  (X-Auth-Token)
 *     Removes a deleted or perma-dead character's ranks; ?accountWide=1 also removes the rows shared by every character
 *   PUT /api/servers/:key/profiles/:profileId/characters  (X-Auth-Token)
 *     Character names per slot for the dashboard. Body: { characters: [{ slot, name, dead }] }
 */

const router = require('express').Router()
const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')
const factionWhitelist = require('../sources/factionWhitelist')
const characters = require('../sources/characters')
const serverAccess = require('../sources/serverAccess')
const profiles = require('../sources/profiles')
const players  = require('../sources/players')
const bans     = require('../sources/bans')
const safeEqual = require('../sources/safeEqual')
const { readVersions } = require('../sources/versions')

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

function currentFilesVersion() {
  return readVersions().client || null
}

function recordLaunchCheck(token, check) {
  const entry = sessions.get(token)
  if (!entry) return false
  entry.launchCheck = { ...check, at: Date.now() }
  saveSessions()
  return true
}

// Stores the launcher-reported hardware id on the session for ban matching
function recordSessionHwid(token, hwid) {
  const entry = sessions.get(token)
  if (!entry) return false
  entry.hwid = hwid
  saveSessions()
  return true
}

// Returns { ok: true } or { ok: false, error } for the session-validation gate.
function launchGateStatus(entry) {
  if (!config.launchCheckEnforce) return { ok: true }
  // A launcher too old for the published install manifest, whatever files it reports
  if (entry.launchCheck && entry.launchCheck.schemaOk === false) return { ok: false, error: 'launcherOutdated' }
  const required = currentFilesVersion()
  if (!required) return { ok: true }   // no published package: can't compare
  const lc = entry.launchCheck
  if (!lc) return { ok: false, error: 'launchCheckMissing' }
  if (lc.filesVersion !== required) return { ok: false, error: 'clientOutdated' }
  if (lc.pluginsOk === false) return { ok: false, error: 'loadOrderMismatch' }
  return { ok: true }
}

// Helper: validate a game server's master key; sets req.server to that server. A read-only server may only read (and heartbeat)

function checkKey(req, res, { write = req.method !== 'GET' } = {}) {
  req.server = config.serverByKey(req.params.key)
  if (!req.server) {
    res.status(403).json({ error: 'Invalid master key.' })
    return false
  }
  if (write && req.server.readOnly) {
    res.status(403).json({ error: 'This server has read-only access.' })
    return false
  }
  return true
}

// A server with roleIds (the test server) admits only holders of one of them
function allowedOnServer(server, roles) {
  return !server || !server.roleIds || server.roleIds.some(id => (roles || []).includes(id))
}

function checkWriteToken(req, res) {
  if (!safeEqual(req.headers['x-auth-token'], config.masterApiAuthToken)) {
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

// Session creation helper (used by the discord-auth callback)

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
  if (!allowedOnServer(req.server, access.roles)) {
    return res.status(403).json({ error: 'staffOnly' })
  }

  // Ban snapshots: refuse by discordId or hardware id even if the discord role is gone
  const playerRecord = players.load()[entry.discordId] || {}
  const hwid = entry.hwid || playerRecord.hwid || null
  const ban = bans.isBanned({ discordId: entry.discordId, hwid })
  if (ban) {
    bans.logBan(`refused session: ${entry.username || entry.profileId} discordId=${entry.discordId} hwid=${hwid || 'none'} reason=${ban.reason || 'banned'}`)
    return res.status(403).json({ error: 'banned' })
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
  if (!allowedOnServer(req.server, access.roles)) {
    return res.status(403).json({ error: 'staffOnly' })
  }

  res.json({
    allowed: true,
    roles: access.roles,
    ...getProfileFactionPayload(discordId),
  })
})

// POST /api/servers/:key/connection-check
// Called by the game server at login: records the connecting ip and refuses banned discordId/hwid/ip.

router.post('/:key/connection-check', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const { profileId, ip } = req.body || {}
  const id = parseInt(profileId, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid profileId.' })

  const discordId = profiles.getDiscordIdByProfileId(id)
  if (!discordId) return res.status(404).json({ error: 'profileNotFound' })

  const cleanIp = typeof ip === 'string' ? ip.trim().slice(0, 64) : ''
  const player = players.updateIdentity(discordId, { ip: cleanIp }) || {}

  const ban = bans.isBanned({ discordId, hwid: player.hwid, ip: cleanIp })
  if (ban) {
    const matched = String(ban.discordId) === discordId ? 'discordId'
      : (ban.hwid && ban.hwid === player.hwid ? 'hwid' : 'ip')
    bans.logBan(`refused connection: profileId=${id} discordId=${discordId} ip=${cleanIp || 'none'} matched=${matched} reason=${ban.reason || 'banned'}`)
    return res.json({ allowed: false, reason: 'banned' })
  }

  res.json({ allowed: true })
})

// POST /api/servers/:key/ban  (X-Auth-Token)
// In-game admin ban: snapshots the player's identity (discordId/hwid/ip) into the ban list so connection-check refuses them.

router.post('/:key/ban', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const { profileId, reason, bannedBy } = req.body || {}
  const id = parseInt(profileId, 10)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid profileId.' })

  const discordId = profiles.getDiscordIdByProfileId(id)
  if (!discordId) return res.status(404).json({ error: 'profileNotFound' })

  const player = players.getByProfileId(id) || {}
  const entry = bans.add({
    discordId,
    hwid: player.hwid || null,
    ip: player.lastIp || null,
    reason: String(reason || 'in-game admin ban').slice(0, 200),
    bannedBy: String(bannedBy || 'in-game admin').slice(0, 100),
  })
  bans.logBan(`in-game ban: profileId=${id} discordId=${discordId} hwid=${entry.hwid || 'none'} ip=${entry.ip || 'none'} by=${entry.bannedBy} reason=${entry.reason}`)
  res.json({ ok: true })
})

// DELETE /api/servers/:key/sessions-by-discord/:discordId  (X-Auth-Token)
// Drops every session of one Discord user, so a deleted player cannot rejoin
// on a cached launcher token under a stale profile id (the TTL slides 24h).

router.delete('/:key/sessions-by-discord/:discordId', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return
  const discordId = String(req.params.discordId || '').trim()
  if (!discordId) return res.status(400).json({ error: 'Invalid discordId.' })
  let dropped = 0
  for (const [token, s] of sessions) {
    if (String(s.discordId) === discordId) { sessions.delete(token); dropped++ }
  }
  if (dropped) saveSessions()
  res.json({ ok: true, dropped })
})

// GET /api/servers/:key/players  (X-Auth-Token)
// Full player roster for the in-game admin panel; the game server masks ips before showing them.

router.get('/:key/players', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  try {
    const rows = players.list().map(p => ({
      profileId: p.profileId,
      discordId: p.discordId,
      username: p.username || '',
      displayName: p.displayName || '',
      hwid: p.hwid || null,
      lastIp: p.lastIp || null,
    }))
    res.json({ players: rows })
  } catch (err) {
    res.status(500).json({ error: err.message || 'failed to load players' })
  }
})

// GET /api/servers/:key/factions

router.get('/:key/factions', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  try {
    const definitions = factionWhitelist.listDefinitions()
    const profileMap = profiles.load().map
    // The game server knows profile ids, never discord ids, so regency seats are translated here
    definitions.factions = definitions.factions.map(faction => ({
      ...faction,
      regents: (faction.regents || [])
        .map(regent => ({ profileId: profileMap[regent.discordId] || null, slot: regent.slot ?? null }))
        .filter(regent => regent.profileId),
    }))
    res.json(definitions)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to load factions' })
  }
})

// PUT /api/servers/:key/groups/:scope/:group/regency

router.put('/:key/groups/:scope/:group/regency', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  try {
    const factionId = `${factionWhitelist.slug(req.params.scope)}:${factionWhitelist.slug(req.params.group)}`
    const body = req.body || {}
    const input = { enabled: body.enabled }
    if (body.regents !== undefined) {
      if (!Array.isArray(body.regents)) return res.status(400).json({ error: 'regents must be a list' })
      input.regents = body.regents.map(regent => ({
        discordId: profiles.getDiscordIdByProfileId(parseInt(regent && regent.profileId, 10)) || '',
        slot: regent && Number.isInteger(regent.slot) ? regent.slot : null,
      }))
      if (input.regents.some(regent => !regent.discordId)) return res.status(404).json({ error: 'profileNotFound' })
    }
    const by = String(body.by || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 80)
    const result = factionWhitelist.setRegency(factionId, input, by ? `skymp-server (${by})` : 'skymp-server')
    res.json({ ok: true, regencyEnabled: result.faction.regencyEnabled, regents: result.faction.regents.length })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to set regency' })
  }
})

// GET /api/servers/:key/groups/:scope/:group/roster

router.get('/:key/groups/:scope/:group/roster', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  try {
    const factionId = `${factionWhitelist.slug(req.params.scope)}:${factionWhitelist.slug(req.params.group)}`
    res.json({ factionId, members: factionWhitelist.namedRoster(factionWhitelist.getFactionRoster(factionId)) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to load roster' })
  }
})

// DELETE /api/servers/:key/profiles/:profileId/characters/:slot/factions

router.delete('/:key/profiles/:profileId/characters/:slot/factions', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const discordId = getProfileDiscordId(req, res)
  if (!discordId) return

  try {
    const removed = factionWhitelist.releaseCharacter(discordId, req.params.slot, req.query.accountWide === '1', 'skymp-server')
    res.json({
      ok: true,
      removed: removed.map(row => ({ requirementId: row.requirementId, rank: row.requirement ? row.requirement.rank : null, group: row.requirement ? row.requirement.group : null, slot: row.slot ?? null })),
      ...getProfileFactionPayload(discordId),
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to release character' })
  }
})

// PUT /api/servers/:key/profiles/:profileId/characters

router.put('/:key/profiles/:profileId/characters', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  if (!getProfileDiscordId(req, res)) return

  try {
    res.json({ characters: characters.setCharacters(req.params.profileId, req.body && req.body.characters) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to store characters' })
  }
})

// POST /api/servers/:key/profiles/:profileId/factions

router.post('/:key/profiles/:profileId/factions', (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const discordId = getProfileDiscordId(req, res)
  if (!discordId) return

  try {
    const by = String((req.body && req.body.by) || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 80)
    const assignment = factionWhitelist.createAssignment({
      ...req.body,
      discordId,
    }, by ? `skymp-server (${by})` : 'skymp-server')
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

    factionWhitelist.deleteAssignment(req.params.assignmentId, 'skymp-server')
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

// Launcher hints for the serverinfo routes: the lock state and, when X-Session is sent, whether that player may join the server
async function sessionHints(token, server) {
  const locked = serverAccess.load().serverLocked
  if (!token) return { locked, sessionValid: false, allowed: true }
  const entry = lookupSession(token)
  if (!entry) return { locked, sessionValid: false, allowed: false }
  let allowed = false
  try {
    const access = await serverAccess.getDiscordAccess(entry.discordId)
    allowed = access.allowed === true && allowedOnServer(server, access.roles)
  } catch {}
  return { locked, sessionValid: true, allowed }
}

module.exports = router
module.exports.lookupSession  = lookupSession
module.exports.createSession  = createSession
module.exports.sessionHints         = sessionHints
module.exports.recordLaunchCheck    = recordLaunchCheck
module.exports.recordSessionHwid    = recordSessionHwid
module.exports.currentFilesVersion  = currentFilesVersion
module.exports.checkKey             = checkKey
module.exports.checkWriteToken      = checkWriteToken
