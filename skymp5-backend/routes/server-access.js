'use strict'

const { Router }        = require('express')
const requirePermission = require('../middleware/requirePermission')
const serverAccess      = require('../sources/serverAccess')
const { guardPrivilegedChange } = require('../middleware/requireManager')

const router = Router()

router.get('/', requirePermission('server.access.view'), (_req, res) => {
  res.json(serverAccess.publicState())
})

// The whitelist and banned roles are handed out by the bot, so choosing them is an admin change
router.put('/', requirePermission('server.access.manage'), async (req, res) => {
  const changed = serverAccess.changedRoleFields(req.body || {})
  if (changed.length && !await guardPrivilegedChange(req, res, { action: 'server-access.put', target: changed.join(','), what: `change ${changed.join(' and ')}` })) return
  try {
    res.json(serverAccess.update(req.body || {}))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to save server access' })
  }
})

router.get('/check/:discordId', requirePermission('server.access.view'), async (req, res) => {
  try {
    const result = await serverAccess.getDiscordAccess(req.params.discordId)
    res.json({
      discordId: req.params.discordId,
      allowed: result.allowed,
      error: result.error || null,
      roles: result.roles,
    })
  } catch (err) {
    res.status(503).json({ error: err.message || 'access check unavailable' })
  }
})

module.exports = router
