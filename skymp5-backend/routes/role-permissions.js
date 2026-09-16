'use strict'

const { Router }        = require('express')
const requirePermission = require('../middleware/requirePermission')
const permissions       = require('../sources/permissions')
const { revokeStaleSessions } = require('../sources/dashboardAuth')
const { guardPrivilegedChange } = require('../middleware/requireManager')

const router = Router()

const KNOWN_PERMISSIONS = [
  'admin.*',
  'dashboard.access',
  'permissions.manage',
  'players.view',
  'players.manage',
  'server.access.view',
  'server.access.manage',
  'factions.view',
  'factions.manage',
  'factions.define',
  'lore.write',
  'rules.write',
  'staff.whitelist_info',
]

function currentPermissions(roleId) {
  const role = (permissions.listRolePermissions().roles || {})[String(roleId || '').trim()]
  return (role && role.permissions) || []
}

// Adding or removing a privileged permission passes the same gate as the server manager
async function guardPrivileged(req, res, before, after) {
  const changed = permissions.privilegedChanges(before, after)
  if (!changed.length) return true
  return guardPrivilegedChange(req, res, { action: `role-permissions.${req.method.toLowerCase()}`, target: req.params.roleId, what: `grant or remove ${changed.join(', ')}` })
}

router.get('/', requirePermission('permissions.manage'), (_req, res) => {
  res.json({
    roles: permissions.listRolePermissions().roles || {},
    knownPermissions: KNOWN_PERMISSIONS,
  })
})

router.put('/:roleId', requirePermission('permissions.manage'), async (req, res) => {
  try {
    const { name, permissions: rolePermissions } = req.body || {}
    if (!Array.isArray(rolePermissions)) return res.status(400).json({ error: 'permissions must be an array' })
    const next = rolePermissions.map(p => String(p || '').trim()).filter(Boolean)
    if (!await guardPrivileged(req, res, currentPermissions(req.params.roleId), next)) return
    const role = permissions.setRolePermissions(req.params.roleId, name, next)
    revokeStaleSessions()
    res.json(role)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to save role permissions' })
  }
})

router.delete('/:roleId', requirePermission('permissions.manage'), async (req, res) => {
  if (!await guardPrivileged(req, res, currentPermissions(req.params.roleId), [])) return
  permissions.deleteRolePermissions(req.params.roleId)
  revokeStaleSessions()
  res.json({ ok: true })
})

module.exports = router
