'use strict'

const { Router }        = require('express')
const requirePermission = require('../middleware/requirePermission')
const serverAccess      = require('../sources/serverAccess')
const { guardPrivilegedChange } = require('../middleware/requireManager')
const config            = require('../config')

const router = Router()

// ?server=<id> picks a server; the main one by default
function pickServer(req, res) {
  const server = req.query.server ? config.serverById(req.query.server) : config.servers[0]
  if (!server) res.status(404).json({ error: 'unknown server' })
  return server
}

router.get('/', requirePermission('server.access.view'), (req, res) => {
  const server = pickServer(req, res)
  if (server) res.json(serverAccess.publicState(server))
})

// The whitelist and banned roles are handed out by the bot, so choosing them is an admin change
router.put('/', requirePermission('server.access.manage'), async (req, res) => {
  const server = pickServer(req, res)
  if (!server) return
  const changed = serverAccess.changedRoleFields(req.body || {}, server)
  if (changed.length && !await guardPrivilegedChange(req, res, { action: 'server-access.put', target: changed.join(','), what: `change ${changed.join(' and ')}` })) return
  try {
    res.json(serverAccess.update(req.body || {}, server))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to save server access' })
  }
})

router.get('/check/:discordId', requirePermission('server.access.view'), async (req, res) => {
  const server = pickServer(req, res)
  if (!server) return
  try {
    const result = await serverAccess.getDiscordAccess(req.params.discordId, server)
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
