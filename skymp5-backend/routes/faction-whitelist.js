'use strict'

const { Router }        = require('express')
const requirePermission = require('../middleware/requirePermission')
const whitelist         = require('../sources/factionWhitelist')

const router = Router()

router.get('/', requirePermission('factions.view'), (_req, res) => {
  res.json(whitelist.list())
})

router.get('/players/:discordId', requirePermission('factions.view'), (req, res) => {
  res.json({
    discordId: req.params.discordId,
    permissions: whitelist.getPlayerFactionPermissions(req.params.discordId),
    gameFactions: whitelist.getPlayerGameFactions(req.params.discordId),
    assignments: whitelist.getPlayerAssignments(req.params.discordId),
  })
})

const handle = (fallback, fn) => (req, res) => {
  try {
    fn(req, res)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || fallback })
  }
}

// Faction records: { id?, scope, group, name, zone, color, uniform }; an id updates, no id creates
router.put('/factions', requirePermission('factions.manage'), handle('failed to save faction', (req, res) => {
  res.json(whitelist.upsertFaction(req.body || {}, req.session.discordId))
}))

router.delete('/factions/:id', requirePermission('factions.manage'), handle('failed to delete faction', (req, res) => {
  whitelist.deleteFaction(req.params.id)
  res.json({ ok: true })
}))

// Ranks: { id?, factionId, rank, capacity, order, appoints, issuesUniform, uniform }; an id updates, no id creates
router.put('/requirements', requirePermission('factions.manage'), handle('failed to save rank', (req, res) => {
  res.json(whitelist.upsertRequirement(req.body || {}))
}))

router.delete('/requirements/:id', requirePermission('factions.manage'), handle('failed to delete rank', (req, res) => {
  whitelist.deleteRequirement(req.params.id)
  res.json({ ok: true })
}))

router.post('/assignments', requirePermission('factions.manage'), (req, res) => {
  try {
    const assignment = whitelist.createAssignment(req.body || {}, req.session.discordId)
    res.status(201).json(assignment)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to create assignment' })
  }
})

router.put('/assignments/:id', requirePermission('factions.manage'), (req, res) => {
  try {
    res.json(whitelist.updateAssignment(req.params.id, req.body || {}, req.session.discordId))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to update assignment' })
  }
})

router.delete('/assignments/:id', requirePermission('factions.manage'), (req, res) => {
  try {
    whitelist.deleteAssignment(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to delete assignment' })
  }
})

module.exports = router
