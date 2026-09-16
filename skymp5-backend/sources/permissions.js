'use strict'
// Maps Discord role IDs to flat permission strings using data/role-permissions.json

const fs   = require('fs')
const path = require('path')
const liveEnv = require('./liveEnv')

// ROLE_PERMISSIONS_FILE lets tests use their own role map instead of the live one
const FILE = process.env.ROLE_PERMISSIONS_FILE || path.join(__dirname, '..', 'data', 'role-permissions.json')

function _load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return { roles: {} }
  }
}

function _save(config) {
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n')
}

function listRolePermissions() {
  return _load()
}

function setRolePermissions(roleId, name, permissions) {
  const normalizedRoleId = String(roleId || '').trim()
  if (!normalizedRoleId) {
    const err = new Error('roleId is required')
    err.status = 400
    throw err
  }
  if (!Array.isArray(permissions)) {
    const err = new Error('permissions must be an array')
    err.status = 400
    throw err
  }

  const config = _load()
  if (!config.roles) config.roles = {}
  config.roles[normalizedRoleId] = {
    name: String(name || normalizedRoleId).trim(),
    permissions: [...new Set(permissions.map(p => String(p || '').trim()).filter(Boolean))],
  }
  _save(config)
  return config.roles[normalizedRoleId]
}

function deleteRolePermissions(roleId) {
  const config = _load()
  if (config.roles) delete config.roles[String(roleId || '').trim()]
  _save(config)
}

/** Resolves Discord role IDs to a deduplicated flat array of permission strings. */
function resolvePermissions(roleIds) {
  const config = _load()
  const perms  = new Set()
  for (const roleId of roleIds) {
    const entry = config.roles[roleId]
    if (entry) entry.permissions.forEach(p => perms.add(p))
  }
  return [...perms]
}

/** True if the permissions array grants `required`; 'admin.*' is a wildcard granting everything. */
function hasPermission(permissions, required) {
  if (permissions.includes('admin.*')) return true
  return permissions.includes(required)
}

// Role permissions plus admin.* for the live DASHBOARD_DISCORD_IDS allow-list, sorted so snapshots compare
function effectivePermissions(discordId, roleIds) {
  const perms = new Set(resolvePermissions(roleIds || []))
  if (discordId && liveEnv.list('DASHBOARD_DISCORD_IDS').includes(String(discordId))) perms.add('admin.*')
  return [...perms].sort()
}

// Grants only admins may add or remove; server.access.manage picks the roles the bot hands out
const PRIVILEGED_EXACT = ['factions.define', 'permissions.manage', 'server.access.manage']

function isPrivilegedPermission(permission) {
  const p = String(permission || '')
  return p.startsWith('admin.') || p.startsWith('manager.') || PRIVILEGED_EXACT.includes(p)
}

/** Privileged permissions a Discord role holds in role-permissions.json. */
function privilegedPermissionsOfRole(roleId) {
  const entry = (_load().roles || {})[String(roleId || '').trim()]
  return ((entry && entry.permissions) || []).filter(isPrivilegedPermission)
}

/** Privileged permissions a role change adds or removes. */
function privilegedChanges(before, after) {
  const was = new Set(before || [])
  const now = new Set(after || [])
  return [...new Set([...was, ...now])].filter(p => isPrivilegedPermission(p) && was.has(p) !== now.has(p)).sort()
}

module.exports = {
  listRolePermissions,
  setRolePermissions,
  deleteRolePermissions,
  resolvePermissions,
  hasPermission,
  effectivePermissions,
  isPrivilegedPermission,
  privilegedPermissionsOfRole,
  privilegedChanges,
}
