'use strict'

const { Router }        = require('express')
const managerOrPermission = require('../middleware/managerOrPermission')
const profiles          = require('../sources/profiles')
const players           = require('../sources/players')
const serverAccess      = require('../sources/access/serverAccess')
const factions          = require('../sources/factionWhitelist')
const bans              = require('../sources/bans')

const router = Router()

router.get('/', managerOrPermission('players.view'), async (_req, res) => {
  res.json({ players: await enrichPlayers(players.list()) })
})

router.post('/', managerOrPermission('players.manage'), async (req, res) => {
  try {
    const player = players.createManual(req.body || {})
    res.status(201).json(await enrichPlayer(player))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to create player' })
  }
})

router.get('/:profileId', managerOrPermission('players.view'), async (req, res) => {
  const player = players.getByProfileId(req.params.profileId)
  if (!player) return res.status(404).json({ error: 'player not found' })
  res.json(await enrichPlayer(player))
})

router.put('/:profileId', managerOrPermission('players.manage'), async (req, res) => {
  try {
    res.json(await enrichPlayer(players.updateByProfileId(req.params.profileId, req.body || {})))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to update player' })
  }
})

// Removes the player record and profile mapping and ends their sessions; a returning player gets a fresh profile id
router.delete('/:profileId', managerOrPermission('players.manage'), (req, res) => {
  try {
    const { discordId } = players.deleteByProfileId(req.params.profileId)
    res.json({ ok: true, discordId, droppedSessions: require('./master-api').dropSessionsByDiscord(discordId) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to delete player' })
  }
})

router.put('/:profileId/whitelist', managerOrPermission('players.manage'), async (req, res) => {
  await mutateAccess(req, res, 'whitelist')
})

router.put('/:profileId/ban', managerOrPermission('players.manage'), async (req, res) => {
  await mutateAccess(req, res, 'ban')
})

router.post('/:profileId/factions', managerOrPermission('factions.manage'), (req, res) => {
  try {
    const discordId = requireDiscordId(req.params.profileId)
    const assignment = factions.createAssignment({
      ...req.body,
      discordId,
    }, req.actor)
    res.status(201).json(assignment)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to assign faction' })
  }
})

router.delete('/:profileId/factions/:assignmentId', managerOrPermission('factions.manage'), (req, res) => {
  try {
    const discordId = requireDiscordId(req.params.profileId)
    const belongsToPlayer = factions
      .getPlayerAssignments(discordId)
      .some(assignment => assignment.id === req.params.assignmentId)
    if (!belongsToPlayer) {
      const err = new Error('assignment not found for player')
      err.status = 404
      throw err
    }
    factions.deleteAssignment(req.params.assignmentId, req.actor)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to remove faction' })
  }
})

async function mutateAccess(req, res, type) {
  try {
    const discordId = requireDiscordId(req.params.profileId)
    const enabled = req.body && req.body.enabled === true
    let result
    if (type === 'whitelist') {
      result = await serverAccess.setWhitelisted(discordId, enabled)
    } else {
      // bans.json snapshot is the source of truth; capture hwid/ip so alts can be matched
      const record = players.load()[discordId] || {}
      const actor = (req.session && (req.session.username || req.session.discordId)) || req.actor || null
      if (enabled) {
        const entry = bans.add({ discordId, hwid: record.hwid || null, ip: record.lastIp || null, reason: 'dashboard ban', bannedBy: actor })
        bans.logBan(`banned: discordId=${discordId} hwid=${entry.hwid || 'none'} ip=${entry.ip || 'none'} by=${actor || 'unknown'}`)
      } else {
        bans.removeByDiscordId(discordId)
        bans.logBan(`unbanned: discordId=${discordId} by=${actor || 'unknown'}`)
      }
      // Discord role toggle is best effort: it throws when bannedRoleId is unconfigured
      try {
        result = await serverAccess.setBanned(discordId, enabled)
      } catch (err) {
        console.warn('[players] discord ban role toggle failed:', err.message)
        result = { source: 'bans-file', roleId: null, banned: enabled }
      }
    }
    res.json({ ok: true, ...result, player: await enrichPlayer(players.getByProfileId(req.params.profileId)) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to update access' })
  }
}

function requireDiscordId(profileId) {
  const discordId = profiles.getDiscordIdByProfileId(profileId)
  if (!discordId) {
    const err = new Error('player not found')
    err.status = 404
    throw err
  }
  return discordId
}

async function enrichPlayers(list) {
  return Promise.all(list.map(enrichPlayer))
}

async function enrichPlayer(player) {
  if (!player) return null
  let access = null
  try {
    const result = await serverAccess.getDiscordAccess(player.discordId)
    access = {
      allowed: result.allowed,
      error: result.error || null,
      roles: result.roles,
    }
  } catch (err) {
    access = { allowed: false, error: 'accessUnavailable', roles: [] }
  }
  // Ban snapshot (bans.json) matched on any stored identifier; hwid/lastIp ride along in ...player
  const ban = bans.isBanned({ discordId: player.discordId, hwid: player.hwid, ip: player.lastIp })
  return { ...player, access, ban: ban ? { reason: ban.reason, bannedAt: ban.bannedAt, bannedBy: ban.bannedBy } : null }
}

module.exports = router
