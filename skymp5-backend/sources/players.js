'use strict'

const db               = require('./db')
const profiles         = require('./profiles')
const security         = require('./security')
const factionWhitelist = require('./factionWhitelist')
const characters       = require('./characters')

// MongoDB players: one document per Discord id
const store = db.store('players')

function load() {
  return store.toObject()
}

function save(data) {
  store.replaceAll(data)
}

function upsertFromDiscordUser(discordUser) {
  if (!discordUser || !discordUser.id) throw new Error('discordUser.id is required')
  const discordId = String(discordUser.id)
  const profileId = profiles.getOrCreateProfileId(discordId)
  const data = load()
  const existing = data[discordId] || {}
  const now = new Date().toISOString()

  data[discordId] = {
    profileId,
    discordId,
    username: discordUser.username || existing.username || '',
    displayName: discordUser.global_name || discordUser.displayName || discordUser.username || existing.displayName || '',
    avatar: discordUser.avatar || existing.avatar || null,
    notes: existing.notes || '',
    hwid: existing.hwid || null,
    lastIp: existing.lastIp || null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastSeenAt: now,
  }

  save(data)
  return data[discordId]
}

function createManual(input) {
  const discordId = String(input.discordId || '').trim()
  if (!discordId) {
    const err = new Error('discordId is required')
    err.status = 400
    throw err
  }
  const profileId = profiles.getOrCreateProfileId(discordId)
  const data = load()
  const existing = data[discordId] || {}
  const now = new Date().toISOString()

  data[discordId] = {
    profileId,
    discordId,
    username: String(input.username || existing.username || '').trim(),
    displayName: String(input.displayName || existing.displayName || input.username || '').trim(),
    avatar: existing.avatar || null,
    notes: String(input.notes || existing.notes || '').trim(),
    hwid: existing.hwid || null,
    lastIp: existing.lastIp || null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastSeenAt: existing.lastSeenAt || null,
  }

  save(data)
  return decorate(data[discordId])
}

const MAX_IDENTITIES = 50

// Every value seen, with when it was first and last seen; hwid/lastIp keep the latest one
function remember(list, value, now) {
  const out = Array.isArray(list) ? list : []
  const hit = out.find(e => e.value === value)
  if (hit) hit.lastSeen = now
  else out.push({ value, firstSeen: now, lastSeen: now })
  return out.slice(-MAX_IDENTITIES)
}

// Every hwid and ip a player was seen with, including records from before the lists existed
function identities(record) {
  const values = (list, latest) => [...new Set([...(Array.isArray(list) ? list.map(e => e.value) : []), latest].filter(Boolean))]
  return { hwids: values(record && record.hwids, record && record.hwid), ips: values(record && record.ips, record && record.lastIp) }
}

// A hwid or ip shared with another Discord account is a possible ban evasion; banned is whether that account is banned
function checkShared(data, discordId, kind, value) {
  const others = Object.values(data).filter(p => p.discordId !== discordId && identities(p)[kind === 'hwid' ? 'hwids' : 'ips'].includes(value))
  if (!others.length) return
  const bans = require('./bans')
  const accounts = [data[discordId], ...others].map(p => ({
    discordId: p.discordId,
    profileId: p.profileId,
    name: p.displayName || p.username || '',
    banned: !!bans.isBanned({ discordId: p.discordId }),
  }))
  const ids = accounts.map(a => a.discordId).sort().join(',')
  security.raise('banEvasion', `${kind}:${value}:${ids}`, { kind, value, accounts })
}

// Records the latest hwid and/or ip for a player; empty values never overwrite stored ones
function updateIdentity(discordId, { hwid, ip } = {}) {
  const id = String(discordId || '').trim()
  if (!id) return null
  const data = load()
  const now = new Date().toISOString()
  const current = data[id] || {
    profileId: profiles.getOrCreateProfileId(id),
    discordId: id,
    username: '',
    displayName: '',
    avatar: null,
    notes: '',
    createdAt: now,
    updatedAt: now,
    lastSeenAt: null,
  }
  let changed = !data[id]
  const cleanHwid = String(hwid || '').trim()
  const cleanIp = String(ip || '').trim()
  const known = identities(current)
  const newHwid = cleanHwid && !known.hwids.includes(cleanHwid)
  const newIp = cleanIp && !known.ips.includes(cleanIp)
  if (cleanHwid) { current.hwids = remember(current.hwids, cleanHwid, now); current.hwid = cleanHwid; changed = true }
  if (cleanIp) { current.ips = remember(current.ips, cleanIp, now); current.lastIp = cleanIp; changed = true }
  if (changed) {
    current.updatedAt = now
    data[id] = current
    save(data)
  }
  if (newHwid) checkShared(data, id, 'hwid', cleanHwid)
  if (newIp) checkShared(data, id, 'ip', cleanIp)
  return current
}

function updateByProfileId(profileId, patch) {
  const discordId = profiles.getDiscordIdByProfileId(profileId)
  if (!discordId) {
    const err = new Error('player not found')
    err.status = 404
    throw err
  }

  const data = load()
  const current = data[discordId] || { profileId: Number(profileId), discordId }
  if (patch.username !== undefined) current.username = String(patch.username || '').trim()
  if (patch.displayName !== undefined) current.displayName = String(patch.displayName || '').trim()
  if (patch.notes !== undefined) current.notes = String(patch.notes || '').trim()
  current.updatedAt = new Date().toISOString()
  data[discordId] = current
  save(data)
  return decorate(current)
}

function list() {
  const data = load()
  return profiles.list().map(profile => {
    const row = data[profile.discordId] || {
      profileId: profile.profileId,
      discordId: profile.discordId,
      username: '',
      displayName: '',
      avatar: null,
      notes: '',
      createdAt: null,
      updatedAt: null,
      lastSeenAt: null,
    }
    return decorate(row)
  })
}

function getByProfileId(profileId) {
  const discordId = profiles.getDiscordIdByProfileId(profileId)
  if (!discordId) return null
  const data = load()
  return decorate(data[discordId] || { profileId: Number(profileId), discordId })
}

// Removes the player record AND the profile mapping; the same Discord user
// gets a fresh profile id on their next login.
function deleteByProfileId(profileId) {
  const discordId = profiles.getDiscordIdByProfileId(profileId)
  if (!discordId) {
    const err = new Error('player not found')
    err.status = 404
    throw err
  }
  const data = load()
  delete data[discordId]
  save(data)
  profiles.deleteByDiscordId(discordId)
  return { discordId }
}

function decorate(player) {
  return {
    ...player,
    profileId: Number(player.profileId),
    assignments: factionWhitelist.getPlayerAssignments(player.discordId),
    factionPermissions: factionWhitelist.getPlayerFactionPermissions(player.discordId),
    gameFactions: factionWhitelist.getPlayerGameFactions(player.discordId),
    characters: characters.forProfile(player.profileId),
  }
}

module.exports = {
  load,
  save,
  identities,
  list,
  getByProfileId,
  upsertFromDiscordUser,
  createManual,
  updateByProfileId,
  updateIdentity,
  deleteByProfileId,
}
