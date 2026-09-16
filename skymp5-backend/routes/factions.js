'use strict'

// Faction and rank definitions for the dashboard and the Server Manager Factions tab; API in docs/docs_roleplay_property_factions.md section 6

const { Router }          = require('express')
const managerOrPermission = require('../middleware/managerOrPermission')
const { hasPermission }   = require('../sources/permissions')
const store               = require('../sources/factionWhitelist')

const router = Router()
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const canView = managerOrPermission('factions.view')
const canDefine = managerOrPermission('factions.define')

for (const name of ['scope', 'group', 'rank']) {
  router.param(name, (_req, res, next, value) => (SLUG_RE.test(value) ? next() : res.status(404).json({ error: 'not found' })))
}

const factionId = req => `${req.params.scope}:${req.params.group}`
const rankId = req => `${factionId(req)}:${req.params.rank}`
const body = req => (req.body && typeof req.body === 'object' ? req.body : {})

const reply = (status, fn) => (req, res) => {
  try {
    res.status(status).json(fn(req))
  } catch (err) {
    if (!err.status) console.error('[factions]', err)
    res.status(err.status || 500).json({ error: err.message || 'faction change failed', ...(err.extra || {}) })
  }
}

router.get('/', canView, reply(200, req => ({
  ...store.definitions(),
  canDefine: req.session ? hasPermission(req.session.permissions || [], 'factions.define') : true,
})))

router.get('/:scope/:group/members', canView, reply(200, req => ({ members: store.namedRoster(store.getFactionRoster(factionId(req)), true) })))

router.post('/', canDefine, reply(201, req => store.createFaction(body(req), req.actor)))
router.patch('/:scope/:group', canDefine, reply(200, req => store.updateFaction(factionId(req), body(req), req.actor)))
router.delete('/:scope/:group', canDefine, reply(200, req => store.deleteFaction(factionId(req), body(req), req.actor)))

router.post('/:scope/:group/ranks', canDefine, reply(201, req => store.createRank(factionId(req), body(req), req.actor)))
router.put('/:scope/:group/ranks', canDefine, reply(200, req => store.reorderRanks(factionId(req), body(req), req.actor)))
router.patch('/:scope/:group/ranks/:rank', canDefine, reply(200, req => store.updateRank(rankId(req), body(req), req.actor)))
router.delete('/:scope/:group/ranks/:rank', canDefine, reply(200, req => store.deleteRank(rankId(req), body(req), req.actor)))

module.exports = router
