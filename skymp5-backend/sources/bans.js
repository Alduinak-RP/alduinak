'use strict'

// MongoDB bans: one document per banned discordId with hwid/ip captured at ban time, so alt accounts can be matched later

const db       = require('./db')
const auditLog = require('./auditLog')

const store = db.store('bans')

function load() {
  return Object.values(store.toObject())
}

function save(data) {
  store.replaceAll(Object.fromEntries(data.map(entry => [String(entry.discordId), entry])))
}

function list() {
  return load()
}

// Returns the first entry matching ANY given identifier (empty/null ones are ignored), or null
function isBanned({ discordId, hwid, ip } = {}) {
  const id   = String(discordId || '').trim()
  const hw   = String(hwid || '').trim()
  const addr = String(ip || '').trim()
  if (!id && !hw && !addr) return null
  return load().find(entry =>
    (id && entry.discordId && String(entry.discordId) === id) ||
    (hw && entry.hwid && String(entry.hwid) === hw) ||
    (addr && entry.ip && String(entry.ip) === addr)
  ) || null
}

// Adds a ban entry; an existing entry for the same discordId is replaced
function add(input) {
  const discordId = String((input && input.discordId) || '').trim()
  if (!discordId) throw new Error('discordId is required')
  const entry = {
    discordId,
    hwid: input.hwid || null,
    ip: input.ip || null,
    reason: String(input.reason || ''),
    bannedAt: input.bannedAt || new Date().toISOString(),
    bannedBy: input.bannedBy || null,
  }
  const data = load().filter(e => String(e.discordId) !== discordId)
  data.push(entry)
  save(data)
  return entry
}

function removeByDiscordId(discordId) {
  const id = String(discordId || '').trim()
  const data = load()
  const next = data.filter(e => String(e.discordId) !== id)
  if (next.length === data.length) return false
  save(next)
  return true
}

function logBan(line) {
  auditLog.append('ban.log', line)
}

module.exports = {
  list,
  isBanned,
  add,
  removeByDiscordId,
  logBan,
}
