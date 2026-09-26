'use strict'

const fs = require('fs')
const path = require('path')
const config = require('../../config')
const discordBot = require('../discord/bot')
const permissions = require('../permissions')

const WHITELIST_PATH = path.join(__dirname, '..', '..', 'data', 'whitelist.json')

const mainServer = () => config.servers[0]

function uniq(values) {
  return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))]
}

function readSettingsFile(server) {
  try { return JSON.parse(fs.readFileSync(server.settingsPath, 'utf8')) } catch { return null }
}

// The server-settings.json "access" block, in the field names used here
function fromBlock(block) {
  const out = {}
  if (!block || typeof block !== 'object') return out
  if ('locked' in block) out.serverLocked = block.locked
  for (const k of ['lockedRoleIds', 'lockedDiscordIds', 'whitelistRoleId', 'bannedRoleId', 'staffOnlyRoleIds']) if (k in block) out[k] = block[k]
  return out
}

function toBlock(s) {
  return {
    locked: s.serverLocked, lockedRoleIds: s.lockedRoleIds, lockedDiscordIds: s.lockedDiscordIds,
    whitelistRoleId: s.whitelistRoleId, bannedRoleId: s.bannedRoleId, staffOnlyRoleIds: s.staffOnlyRoleIds,
  }
}

// A server's rules, from the access block of its server-settings.json
function load(server = mainServer()) {
  return normalize(fromBlock((readSettingsFile(server) || {}).access))
}

function save(data, server) {
  const settings = readSettingsFile(server)
  if (!settings) {
    const err = new Error(`${server.settingsPath} is missing or unreadable`)
    err.status = 404
    throw err
  }
  settings.access = toBlock(normalize(data))
  fs.writeFileSync(server.settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

function normalize(data) {
  return {
    serverLocked: data.serverLocked === true,
    lockedRoleIds: uniq(data.lockedRoleIds),
    lockedDiscordIds: uniq(data.lockedDiscordIds),
    whitelistRoleId: String(data.whitelistRoleId || '').trim(),
    bannedRoleId: String(data.bannedRoleId || '').trim(),
    staffOnlyRoleIds: uniq(data.staffOnlyRoleIds),
  }
}

// The bot adds and removes these roles for anyone with players.manage, so they must never carry privileged permissions
function assertAssignableRole(roleId, label) {
  const privileged = roleId ? permissions.privilegedPermissionsOfRole(roleId) : []
  if (!privileged.length) return
  const err = new Error(`the ${label} role ${roleId} holds ${privileged.join(', ')}, so the whitelist and bans may not assign it`)
  err.status = 403
  throw err
}

/** Role id fields an update would change; changing them needs an admin. */
function changedRoleFields(input, server = mainServer()) {
  const current = load(server)
  const next = normalize({ ...current, ...(input || {}) })
  return ['whitelistRoleId', 'bannedRoleId'].filter(k => next[k] !== current[k])
}

function update(input, server = mainServer()) {
  const current = load(server)
  const next = normalize({
    ...current,
    ...(input || {}),
    lockedRoleIds: input && input.lockedRoleIds !== undefined ? input.lockedRoleIds : current.lockedRoleIds,
    lockedDiscordIds: input && input.lockedDiscordIds !== undefined ? input.lockedDiscordIds : current.lockedDiscordIds,
    staffOnlyRoleIds: input && input.staffOnlyRoleIds !== undefined ? input.staffOnlyRoleIds : current.staffOnlyRoleIds,
  })
  if (next.whitelistRoleId !== current.whitelistRoleId) assertAssignableRole(next.whitelistRoleId, 'whitelist')
  if (next.bannedRoleId !== current.bannedRoleId) assertAssignableRole(next.bannedRoleId, 'banned')
  save(next, server)
  return next
}

function loadFileWhitelist() {
  try { return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8')) }
  catch { return [] }
}

function saveFileWhitelist(discordIds) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(uniq(discordIds), null, 2) + '\n')
}

function hasAnyRole(memberRoleIds, requiredRoleIds) {
  const roles = new Set(memberRoleIds || [])
  return (requiredRoleIds || []).some(roleId => roles.has(roleId))
}

// A staff-only server (the test server) admits only holders of one of its staffOnlyRoleIds, and nobody when there are none
function allowedOnServer(server, settings, roles) {
  if (!settings.staffOnlyRoleIds.length) return !(server && server.staffOnly)
  return hasAnyRole(roles, settings.staffOnlyRoleIds)
}

async function getDiscordAccess(discordId, server = mainServer()) {
  const settings = load(server)
  const roles = await discordBot.getMemberRoles(discordId)

  if (settings.bannedRoleId && roles.includes(settings.bannedRoleId)) {
    return { allowed: false, error: 'banned', roles, settings }
  }
  if (!allowedOnServer(server, settings, roles)) {
    return { allowed: false, error: 'staffOnly', roles, settings }
  }

  if (settings.serverLocked) {
    if (settings.lockedDiscordIds.includes(discordId) || hasAnyRole(roles, settings.lockedRoleIds)) {
      return { allowed: true, roles, settings }
    }
    return { allowed: false, error: 'serverLocked', roles, settings }
  }

  if (settings.whitelistRoleId) {
    if (!roles.includes(settings.whitelistRoleId)) {
      return { allowed: false, error: 'notWhitelisted', roles, settings }
    }
    return { allowed: true, roles, settings }
  }

  const fileWhitelist = loadFileWhitelist()
  if (fileWhitelist.length > 0 && !fileWhitelist.includes(discordId)) {
    return { allowed: false, error: 'notWhitelisted', roles, settings }
  }

  return { allowed: true, roles, settings }
}

function publicState(server = mainServer()) {
  const settings = load(server)
  return {
    server: server.id,
    ...settings,
    legacyFileWhitelistCount: loadFileWhitelist().length,
  }
}

// Whitelist and ban roles are Discord roles, so these act on the main server's role ids
async function setWhitelisted(discordId, enabled) {
  const settings = load()
  if (settings.whitelistRoleId) {
    assertAssignableRole(settings.whitelistRoleId, 'whitelist')
    if (enabled) await discordBot.addMemberRole(discordId, settings.whitelistRoleId)
    else await discordBot.removeMemberRole(discordId, settings.whitelistRoleId)
    return { source: 'discord-role', roleId: settings.whitelistRoleId, whitelisted: enabled }
  }

  const current = new Set(loadFileWhitelist())
  if (enabled) current.add(discordId)
  else current.delete(discordId)
  saveFileWhitelist([...current])
  return { source: 'file', roleId: null, whitelisted: enabled }
}

async function setBanned(discordId, enabled) {
  const settings = load()
  if (!settings.bannedRoleId) {
    const err = new Error('bannedRoleId is not configured')
    err.status = 400
    throw err
  }
  assertAssignableRole(settings.bannedRoleId, 'banned')
  if (enabled) await discordBot.addMemberRole(discordId, settings.bannedRoleId)
  else await discordBot.removeMemberRole(discordId, settings.bannedRoleId)
  return { source: 'discord-role', roleId: settings.bannedRoleId, banned: enabled }
}

module.exports = {
  load,
  update,
  changedRoleFields,
  publicState,
  getDiscordAccess,
  hasAnyRole,
  setWhitelisted,
  setBanned,
}
