'use strict'

// Persistent ban snapshots: data/bans.json holds one entry per banned discordId
// with the hwid/ip captured at ban time so alt accounts can be matched later.

const fs   = require('fs')
const path = require('path')

const FILE    = path.join(__dirname, '..', 'data', 'bans.json')
const LOG_DIR = process.env.BAN_LOG_DIR || 'C:\\Users\\Administrator\\Desktop\\logs'

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
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

// Appends a timestamped line to ban.log; logging failures must never break the ban flow
function logBan(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'ban.log'), `${new Date().toISOString()} ${line}\n`)
  } catch (e) {
    console.error('[bans] failed to write ban.log:', e.message)
  }
}

module.exports = {
  list,
  isBanned,
  add,
  removeByDiscordId,
  logBan,
}
