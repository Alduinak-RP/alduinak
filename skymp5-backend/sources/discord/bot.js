'use strict'

const { Client, GatewayIntentBits } = require('discord.js')
const https = require('https')
const config = require('../../config')
const bans = require('../bans')
const players = require('../players')

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],
})

let ready = false

client.once('ready', () => {
  ready = true
  console.log(`[discord-bot] ready as ${client.user.tag}`)
})

client.on('error', err => {
  console.error('[discord-bot] error:', err.message)
})

// A real Discord guild ban snapshots the player's hwid/ip into bans.json
client.on('guildBanAdd', ban => {
  try {
    if (config.discordGuildId && ban.guild.id !== config.discordGuildId) return
    const discordId = ban.user.id
    const record = players.load()[discordId] || {}
    const entry = bans.add({
      discordId,
      hwid: record.hwid || null,
      ip: record.lastIp || null,
      reason: 'discord ban',
      bannedBy: 'discord',
    })
    bans.logBan(`discord ban: discordId=${discordId} username=${ban.user.username || 'unknown'} hwid=${entry.hwid || 'none'} ip=${entry.ip || 'none'}`)
    console.log(`[discord-bot] recorded guild ban for ${discordId}`)
  } catch (err) {
    console.error('[discord-bot] failed to record guild ban:', err.message)
  }
})

function ensureRoleLookupConfigured() {
  if (!config.discordBotToken || !config.discordGuildId) {
    throw new Error('discord bot role lookup is not configured')
  }
}

// Short-lived cache so launcher polling doesn't turn into a request spam
const ROLE_CACHE_TTL_MS = 60 * 1000
const roleCache = new Map() // discordId -> { roles, expiresAt }

async function getMemberRoles(discordId) {
  if (!discordId) return []
  if (!config.discordBotToken || !config.discordGuildId) return []

  const cached = roleCache.get(discordId)
  if (cached && cached.expiresAt > Date.now()) return cached.roles

  if (ready) {
    try {
      const guild = await client.guilds.fetch(config.discordGuildId)
      const member = await guild.members.fetch({ user: discordId, force: true })
      const roles = [...member.roles.cache.keys()]
      roleCache.set(discordId, { roles, expiresAt: Date.now() + ROLE_CACHE_TTL_MS })
      return roles
    } catch (err) {
      if (err && err.code === 10007) {
        roleCache.set(discordId, { roles: [], expiresAt: Date.now() + ROLE_CACHE_TTL_MS })
        return []  // genuinely not in server
      }
      console.warn('[discord-bot] guild fetch failed, falling back to HTTP:', err.message)
    }
  }

  try {
    const roles = await fetchMemberRoles(discordId)
    roleCache.set(discordId, { roles, expiresAt: Date.now() + ROLE_CACHE_TTL_MS })
    return roles
  } catch (err) {
    console.error('[discord-bot] HTTP fallback also failed:', err.message)
    return []  // not cached: allows quick recovery once Discord is reachable
  }
}

function isReady() {
  return ready && !!config.discordGuildId
}

async function memberHasRole(discordId, roleId) {
  if (!roleId) return false
  return (await getMemberRoles(discordId)).includes(roleId)
}

function fetchMemberRoles(discordId) {
  return new Promise((resolve, reject) => {
    try {
      ensureRoleLookupConfigured()
    } catch (err) {
      return reject(err)
    }

    const req = https.get({
      hostname: 'discord.com',
      path: `/api/guilds/${config.discordGuildId}/members/${discordId}`,
      headers: { Authorization: `Bot ${config.discordBotToken}` },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode === 404) return resolve([])
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`discord member lookup failed (${res.statusCode})`))
        }
        try {
          const json = JSON.parse(data)
          resolve(Array.isArray(json.roles) ? json.roles : [])
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
  })
}

async function getMembersWithRole(roleId) {
  if (!roleId) return []
  if (!isReady()) throw new Error('discord bot is not ready')

  const guild = await client.guilds.fetch(config.discordGuildId)
  const role = await guild.roles.fetch(roleId)
  if (!role) return []

  await guild.members.fetch()

  return guild.members.cache
    .filter(member => member.roles.cache.has(roleId))
    .map(member => ({
      discordId: member.user.id,
      username: member.user.username,
      displayName: member.displayName || member.user.globalName || member.user.username,
      avatar: member.user.displayAvatarURL({ size: 64 }),
      joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
      roles: [...member.roles.cache.keys()],
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

async function addMemberRole(discordId, roleId) {
  if (!roleId) throw new Error('roleId is required')
  return mutateMemberRole(discordId, roleId, 'PUT')
}

async function removeMemberRole(discordId, roleId) {
  if (!roleId) throw new Error('roleId is required')
  return mutateMemberRole(discordId, roleId, 'DELETE')
}

function mutateMemberRole(discordId, roleId, method) {
  return new Promise((resolve, reject) => {
    try {
      ensureRoleLookupConfigured()
    } catch (err) {
      return reject(err)
    }

    const req = https.request({
      hostname: 'discord.com',
      path: `/api/guilds/${config.discordGuildId}/members/${discordId}/roles/${roleId}`,
      method,
      headers: { Authorization: `Bot ${config.discordBotToken}` },
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          roleCache.delete(discordId)  // role changed; don't serve stale roles
          return resolve(true)
        }
        reject(new Error(`discord role update failed (${res.statusCode}): ${data}`))
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function start() {
  if (!config.discordBotToken) {
    console.warn('[discord-bot] DISCORD_BOT_TOKEN not set - role-based access checks will be unavailable')
    return
  }
  client.login(config.discordBotToken).catch(err => {
    console.error('[discord-bot] login failed:', err.message)
  })
}

module.exports = {
  start,
  getMemberRoles,
  isReady,
  memberHasRole,
  getMembersWithRole,
  addMemberRole,
  removeMemberRole,
}
