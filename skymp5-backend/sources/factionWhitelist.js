'use strict'

const crypto     = require('crypto')
const fs         = require('fs')
const path       = require('path')
const auditLog   = require('./auditLog')
const characters = require('./characters')
const profiles   = require('./profiles')

// Definitions (factions, requirements, retired ids) and memberships (assignments) share one file; the pre-launch wipe clears only assignments
const FILE = process.env.FACTION_WHITELIST_FILE || path.join(__dirname, '..', 'data', 'faction-whitelist.json')
const AUDIT_FILE = 'faction.log'

// characterSelectMaxCharacters allows 1-10 characters, so slots run 0-9
const MAX_SLOT = 9
const SCOPES = ['hold', 'faction']
// What the game groups factions by; a character joins at most one faction of each type. scope stays the id prefix
const TYPES = ['hold', 'military', 'guild']
const ZONES = ['', 'west', 'east', 'neutral']
// Hold keys as housing names them; a court's group may carry the article, as in the-rift
const HOLDS = ['haafingar', 'reach', 'falkreath', 'hjaalmarch', 'eastmarch', 'winterhold', 'rift', 'pale', 'whiterun']
// Hold ranks that manage property when the rank carries no housing flag
const HOLD_MANAGER_RANKS = ['jarl', 'steward']
// recruit: the ranks a holder may bring outsiders in at; promote: the ranks it may move a lower member to
const RANK_LISTS = ['recruit', 'promote']
// leader carries every permission of its faction, and nobody leads two factions at once
const RANK_FLAGS = ['leader', 'remove', 'craft', 'housing', 'arrest', 'execute', 'factionAccess']
const MAX_REGENTS = 10
const COLOR_RE = /^[0-9a-f]{6}$/
const MAX_TEXT = 48
const MAX_FACTIONS = 64
const MAX_RANKS = 30
const MAX_CAPACITY = 999
const MEMBER_SAMPLE = 10

let unreadableLogged = false

function fail(status, message, extra) {
  const err = new Error(message)
  err.status = status
  if (extra) err.extra = extra
  return err
}

const arr = value => (Array.isArray(value) ? value : [])

// A rank's permission string is its id with dots, so it can never copy another rank's or outlive a retired id
const permissionOf = requirementId => String(requirementId || '').split(':').join('.')

// Ordered leader stand-ins of one faction; a row that is no longer a member is ignored when the ladder is read
function normalizeRegents(raw) {
  const out = []
  for (const entry of arr(raw)) {
    const discordId = normalizeDiscordId(entry && entry.discordId)
    if (!discordId) continue
    const slot = entry && Number.isInteger(entry.slot) ? entry.slot : null
    if (out.some(r => r.discordId === discordId && r.slot === slot)) continue
    out.push({ discordId, slot })
    if (out.length >= MAX_REGENTS) break
  }
  return out
}

// Unknown top-level keys survive a write
function normalize(data) {
  const retired = data.retired && typeof data.retired === 'object' ? data.retired : {}
  return {
    ...data,
    factions: arr(data.factions),
    requirements: arr(data.requirements).map(req => (req && typeof req.id === 'string' ? { ...req, permission: permissionOf(req.id) } : req)),
    assignments: arr(data.assignments),
    retired: { factions: arr(retired.factions).map(String), ranks: arr(retired.ranks).map(String) },
  }
}

// A missing file reads as empty; an unreadable one reads as empty for member lookups but refuses writes and definition reads, so a typo never wipes the table
function load(strict = false) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('top level is not an object')
  } catch (err) {
    if (err.code === 'ENOENT') return normalize({})
    if (!unreadableLogged) {
      unreadableLogged = true
      console.error(`[factionWhitelist] data/faction-whitelist.json is unreadable, factions are disabled until it is fixed: ${err.message}`)
    }
    if (strict) throw fail(500, 'faction-whitelist.json is unreadable; fix the file before using factions')
    return normalize({})
  }
  unreadableLogged = false
  return normalize(data)
}

function save(data) {
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, FILE)
}

// Copy kept next to the file before a delete removes memberships
function backup() {
  try {
    fs.copyFileSync(FILE, FILE + '.bak')
  } catch (err) {
    if (err.code !== 'ENOENT') throw fail(500, `could not back up faction-whitelist.json: ${err.message}`)
  }
}

function getRequirement(data, requirementId) {
  return data.requirements.find(req => req.id === requirementId)
}

function normalizeDiscordId(discordId) {
  return String(discordId || '').trim()
}

function normalizeSlot(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > MAX_SLOT) {
    // Reject rather than coerce to null: null means "all characters" and would silently widen a per-character grant
    throw fail(400, `slot must be empty or an integer from 0 to ${MAX_SLOT}`)
  }
  return n
}

// null names every character of the account, so it overlaps any character's own rows
const overlapsSlot = (a, b) => a === null || a === undefined || b === null || b === undefined || a === b

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// "hold:the-rift:jarl" -> "hold:the-rift"
function factionIdOf(requirementId) {
  const parts = String(requirementId || '').split(':')
  return parts.length === 3 ? `${parts[0]}:${parts[1]}` : ''
}

// "hold:the-rift:jarl" -> "jarl"
function rankSlugOf(requirementId) {
  const parts = String(requirementId || '').split(':')
  return parts.length === 3 ? parts[2] : ''
}

const holdKey = groupSlug => String(groupSlug || '').replace(/^the-/, '')

// Factions written before types existed: a court is a hold, anything else a guild until it is set
const defaultType = scope => (String(scope) === 'hold' ? 'hold' : 'guild')

// Ranks without an order keep their position in the file, which is ladder order
function decorateRequirements(data) {
  const counts = data.assignments.reduce((acc, a) => {
    acc[a.requirementId] = (acc[a.requirementId] || 0) + 1
    return acc
  }, {})
  const positions = {}
  return data.requirements.map(req => {
    const fid = factionIdOf(req.id)
    const position = positions[fid] = (positions[fid] ?? -1) + 1
    const assigned = counts[req.id] || 0
    const order = Number.isInteger(req.order) && req.order >= 0 ? req.order : position
    return {
      ...req,
      capacity: Number.isInteger(req.capacity) && req.capacity > 0 ? req.capacity : null,
      order,
      leader: typeof req.leader === 'boolean' ? req.leader : order === 0,
      ...Object.fromEntries(RANK_LISTS.map(key => [key, Array.isArray(req[key]) ? req[key].map(String) : []])),
      remove: req.remove === true,
      craft: req.craft === true,
      housing: typeof req.housing === 'boolean' ? req.housing : fid.startsWith('hold:') && HOLD_MANAGER_RANKS.includes(rankSlugOf(req.id)),
      arrest: req.arrest === true,
      execute: req.execute === true,
      factionAccess: req.factionAccess !== false,
      title: cleanText(req.title) || null,
      titleFemale: cleanText(req.titleFemale) || null,
      factionId: fid,
      assigned,
      remaining: Number.isInteger(req.capacity) && req.capacity > 0 ? Math.max(0, req.capacity - assigned) : null,
    }
  })
}

// Explicit faction records first; a group that only has ranks still shows as a faction named after the group
function effectiveFactions(data) {
  const byId = new Map()
  for (const f of data.factions) {
    if (!f || typeof f.id !== 'string') continue
    const scope = String(f.scope || f.id.split(':')[0])
    byId.set(f.id, {
      id: f.id,
      scope,
      type: TYPES.includes(f.type) ? f.type : defaultType(scope),
      group: String(f.group || ''),
      name: String(f.name || f.group || f.id),
      zone: ZONES.includes(f.zone) ? f.zone : '',
      color: COLOR_RE.test(String(f.color || '')) ? f.color : '',
      regencyEnabled: f.regencyEnabled === true,
      regents: normalizeRegents(f.regents),
      rev: Number.isInteger(f.rev) ? f.rev : 0,
    })
  }
  for (const req of data.requirements) {
    const id = factionIdOf(req.id)
    if (!id || byId.has(id)) continue
    const scope = String(req.scope || id.split(':')[0])
    byId.set(id, { id, scope, type: defaultType(scope), group: String(req.group || ''), name: String(req.group || id), zone: '', color: '', regencyEnabled: false, regents: [], rev: 0 })
  }
  return [...byId.values()]
}

function factionView(data, faction, decorated = decorateRequirements(data)) {
  const prefix = `${faction.id}:`
  return {
    ...faction,
    members: data.assignments.filter(a => String(a.requirementId || '').startsWith(prefix)).length,
    ranks: decorated.filter(r => r.factionId === faction.id).sort((a, b) => a.order - b.order),
  }
}

function list() {
  const data = load()
  return {
    factions: effectiveFactions(data),
    requirements: decorateRequirements(data),
    assignments: data.assignments,
  }
}

// Faction and rank definitions without member counts, so the game server's ETag changes only when a definition does
function listDefinitions() {
  const data = load(true)
  return {
    factions: effectiveFactions(data),
    requirements: decorateRequirements(data).map(({ assigned, remaining, ...req }) => req),
  }
}

// Every faction with its ladder and member counts, plus the catalogue the editor offers
function definitions() {
  const data = load(true)
  const decorated = decorateRequirements(data)
  return {
    factions: effectiveFactions(data).map(f => factionView(data, f, decorated)),
    retired: data.retired,
    scopes: SCOPES,
    zones: ZONES,
    holds: HOLDS,
  }
}

// ── Definition writes ─────────────────────────────────────────────────────────

const auditValue = value => {
  if (typeof value !== 'string') return JSON.stringify(value)
  return /^[\w.:@#/,-]*$/.test(value) ? value : JSON.stringify(value)
}

function audit(actor, action, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${auditValue(v)}`)
  auditLog.append(AUDIT_FILE, [`actor=${auditValue(actor || 'unknown')}`, `action=${action}`, ...parts].join(' '))
}

function auditRemovals(actor, removed, reason) {
  for (const a of removed) {
    audit(actor, 'member.remove', { requirement: a.requirementId, discordId: a.discordId, slot: a.slot ?? 'all', player: a.playerName, reason })
  }
}

function changesBetween(before, after) {
  const changes = {}
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = [before[key], after[key]]
  }
  return changes
}

function findFaction(data, id) {
  const faction = effectiveFactions(data).find(f => f.id === id)
  if (!faction) throw fail(404, 'faction not found')
  return faction
}

function findRank(data, rankId) {
  const req = getRequirement(data, rankId)
  if (!req) throw fail(404, 'rank not found')
  return req
}

// Every write names the revision it was made against, so two editors never overwrite each other
function checkRev(data, faction, rev) {
  if (rev === undefined || rev === null || rev === '') throw fail(400, 'rev is required; reload the faction first')
  if (Number(rev) !== faction.rev) {
    throw fail(409, 'this faction changed since it was loaded; it has been reloaded, apply the change again', { stale: true, faction: factionView(data, faction) })
  }
}

// Ranks of a faction taken from ranks alone get a record on their first edit
function recordFor(data, faction, actor, now) {
  let record = data.factions.find(f => f && f.id === faction.id)
  if (!record) {
    record = { id: faction.id, scope: faction.scope, group: faction.group, name: faction.name, zone: '', color: '', createdAt: now, createdBy: actor || null }
    data.factions.push(record)
  }
  return record
}

function bump(record, actor, now) {
  record.rev = (Number.isInteger(record.rev) ? record.rev : 0) + 1
  record.updatedAt = now
  record.updatedBy = actor || null
}

function retire(data, kind, ids) {
  data.retired[kind] = [...new Set([...data.retired[kind], ...ids])]
}

function requireName(value, what) {
  const name = cleanText(value)
  if (!name) throw fail(400, `${what} is required`)
  return name
}

function normalizeZone(value) {
  const zone = String(value || '')
  if (!ZONES.includes(zone)) throw fail(400, 'zone must be west, east, neutral or empty')
  return zone
}

function normalizeColor(value) {
  const color = String(value || '').replace(/^#/, '').toLowerCase()
  if (color && !COLOR_RE.test(color)) throw fail(400, 'color must be six hex digits, e.g. c9a36b')
  return color
}

function normalizeCapacity(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > MAX_CAPACITY) throw fail(400, `capacity must be empty (open) or a whole number up to ${MAX_CAPACITY}`)
  return n === 0 ? null : n
}

const truthy = value => value === true || value === 1 || value === '1' || value === 'true'

function rosterRows(data, assignments) {
  return assignments.map(a => {
    const req = getRequirement(data, a.requirementId)
    return {
      assignmentId: a.id,
      discordId: a.discordId,
      playerName: a.playerName || '',
      slot: a.slot ?? null,
      rank: req ? req.rank : null,
      rankSlug: rankSlugOf(a.requirementId),
      since: a.createdAt || null,
    }
  })
}

// A plain delete is refused while anyone holds a rank; the confirmed delete must name the member count the admin was shown
function confirmCascade(data, members, input) {
  if (!members.length) return
  const extra = {
    hasMembers: true,
    members: members.length,
    sample: namedRoster(rosterRows(data, members.slice(0, MEMBER_SAMPLE))).map(({ playerName, slot, rank }) => ({ playerName, slot, rank })),
  }
  if (!truthy(input.removeMembers)) throw fail(409, `${members.length} membership(s) still hold these ranks`, extra)
  if (Number(input.expectedMembers) !== members.length) throw fail(409, 'the member count changed since the list was shown, check it again', extra)
}

function createFaction(input, actor) {
  const data = load(true)
  const type = String(input.type || '').trim().toLowerCase()
  if (!TYPES.includes(type)) throw fail(400, `type must be ${TYPES.join(', ')}`)
  // Hold courts keep the hold: prefix the housing tables read; armies and guilds share the faction: one
  const scope = type === 'hold' ? 'hold' : 'faction'
  const group = requireName(input.group, 'group name')
  const groupSlug = slug(group)
  if (!groupSlug) throw fail(400, 'group name needs letters or digits')
  const id = `${scope}:${groupSlug}`
  const live = effectiveFactions(data)
  if (live.some(f => f.id === id)) throw fail(409, `faction ${id} already exists`)
  // the-rift and rift name one hold, so a deleted court blocks both spellings
  const sameCourt = retiredId => scope === 'hold' && retiredId.startsWith('hold:') && holdKey(retiredId.split(':')[1]) === holdKey(groupSlug)
  const retiredId = data.retired.factions.find(r => r === id || sameCourt(r))
  if (retiredId) {
    throw fail(409, `${retiredId} belonged to a deleted faction and ids are never reused${scope === 'hold' ? ', so that hold cannot get a new court' : '; pick another group name'}`)
  }
  if (scope === 'hold') {
    if (!HOLDS.includes(holdKey(groupSlug))) throw fail(400, `a hold court's group must name one of the nine holds: ${HOLDS.join(', ')}`)
    const court = live.find(f => f.scope === 'hold' && holdKey(f.id.split(':')[1]) === holdKey(groupSlug))
    if (court) throw fail(409, `${court.name} is already the court of that hold`)
  }
  if (live.length >= MAX_FACTIONS) throw fail(400, `at most ${MAX_FACTIONS} factions`)
  const name = cleanText(input.name) || group
  if (live.some(f => f.name.toLowerCase() === name.toLowerCase())) throw fail(409, `another faction is already named ${name}`)

  const now = new Date().toISOString()
  data.factions.push({
    id, scope, type, group, name,
    zone: normalizeZone(input.zone),
    regencyEnabled: false,
    regents: [],
    color: normalizeColor(input.color),
    rev: 1,
    createdAt: now, createdBy: actor || null, updatedAt: now, updatedBy: actor || null,
  })
  save(data)
  audit(actor, 'faction.create', { faction: id, name })
  return { faction: factionView(data, findFaction(data, id)) }
}

function updateFaction(id, input, actor) {
  const data = load(true)
  const faction = findFaction(data, id)
  checkRev(data, faction, input.rev)
  const now = new Date().toISOString()
  const record = recordFor(data, faction, actor, now)
  const before = { name: faction.name, type: faction.type, zone: faction.zone, color: faction.color }
  if (input.type !== undefined) {
    const type = String(input.type || '').trim().toLowerCase()
    if (!TYPES.includes(type)) throw fail(400, `type must be ${TYPES.join(', ')}`)
    if ((type === 'hold') !== (faction.scope === 'hold')) throw fail(400, 'a hold court cannot become an army or guild, nor the other way round')
    record.type = type
  }
  if (input.name !== undefined) {
    const name = requireName(input.name, 'name')
    if (effectiveFactions(data).some(f => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) throw fail(409, `another faction is already named ${name}`)
    record.name = name
  }
  if (input.zone !== undefined) record.zone = normalizeZone(input.zone)
  if (input.color !== undefined) record.color = normalizeColor(input.color)
  const changes = changesBetween(before, record)
  if (!Object.keys(changes).length) return { faction: factionView(data, faction) }
  bump(record, actor, now)
  save(data)
  audit(actor, 'faction.update', { faction: id, rev: record.rev, changes })
  return { faction: factionView(data, findFaction(data, id)) }
}

function deleteFaction(id, input, actor) {
  const data = load(true)
  const faction = findFaction(data, id)
  checkRev(data, faction, input.rev)
  const prefix = `${id}:`
  const members = data.assignments.filter(a => String(a.requirementId || '').startsWith(prefix))
  confirmCascade(data, members, input)
  if (members.length) backup()
  const rankIds = data.requirements.filter(req => String(req.id || '').startsWith(prefix)).map(req => req.id)
  data.assignments = data.assignments.filter(a => !members.includes(a))
  data.factions = data.factions.filter(f => !f || f.id !== id)
  data.requirements = data.requirements.filter(req => !rankIds.includes(req.id))
  retire(data, 'factions', [id])
  retire(data, 'ranks', rankIds)
  save(data)
  auditRemovals(actor, members, `faction ${id} deleted`)
  audit(actor, 'faction.delete', { faction: id, name: faction.name, ranks: rankIds.length, removedMembers: members.length })
  return { deleted: id, removedMembers: members.length }
}

// Validates and applies the rank fields present in input; ranks are the faction's decorated ladder including this rank
function applyRank(req, input, faction, ranks) {
  if (input.rank !== undefined) {
    const name = requireName(input.rank, 'rank name')
    if (ranks.some(r => r.id !== req.id && String(r.rank || '').toLowerCase() === name.toLowerCase())) throw fail(409, `${faction.name} already has a rank named ${name}`)
    req.rank = name
  }
  if (input.capacity !== undefined) req.capacity = normalizeCapacity(input.capacity)
  const permission = String(input.permission ?? '').trim()
  if (permission && permission !== req.permission) throw fail(400, `the permission string follows the rank id (${req.permission}) and cannot be changed`)
  const slugs = ranks.map(r => rankSlugOf(r.id))
  // Outsiders are never recruited straight into a leader seat; the ladder and staff place those
  const leaderSlugs = ranks.filter(r => r.leader === true || r.order === 0).map(r => rankSlugOf(r.id))
  for (const key of RANK_LISTS) {
    const value = input[key]
    if (value === undefined) continue
    if (value === null) {
      req[key] = []
      continue
    }
    if (!Array.isArray(value)) throw fail(400, `${key} must be a list of rank ids`)
    const unknown = value.map(String).filter(s => !slugs.includes(s))
    if (unknown.length) throw fail(400, `${key} names ranks ${faction.name} does not have: ${unknown.join(', ')}`)
    const wanted = [...new Set(value.map(String))]
    req[key] = key === 'recruit' ? wanted.filter(s => !leaderSlugs.includes(s)) : wanted
  }
  for (const key of RANK_FLAGS) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') throw fail(400, `${key} must be true or false`)
    if (key === 'housing' && input[key] && faction.scope !== 'hold') throw fail(400, 'only hold court ranks manage hold property')
    req[key] = input[key]
  }
  if (input.title !== undefined) req.title = cleanText(input.title) || undefined
  if (input.titleFemale !== undefined) req.titleFemale = cleanText(input.titleFemale) || undefined
}

const ladderOf = (data, factionId) => decorateRequirements(data).filter(r => r.factionId === factionId).sort((a, b) => a.order - b.order)

const rankSnapshot = req => Object.fromEntries(['rank', 'capacity', 'title', 'titleFemale', ...RANK_LISTS, ...RANK_FLAGS].map(key => [key, req[key] === undefined ? null : req[key]]))

function createRank(factionId, input, actor) {
  const data = load(true)
  const faction = findFaction(data, factionId)
  checkRev(data, faction, input.rev)
  const ladder = ladderOf(data, faction.id)
  if (ladder.length >= MAX_RANKS) throw fail(400, `a faction holds at most ${MAX_RANKS} ranks`)
  const name = requireName(input.rank, 'rank name')
  const rankSlug = slug(name)
  if (!rankSlug) throw fail(400, 'rank name needs letters or digits')
  const id = `${faction.id}:${rankSlug}`
  if (getRequirement(data, id)) throw fail(409, `rank ${id} already exists`)
  if (data.retired.ranks.includes(id)) throw fail(409, `${id} belonged to a deleted rank and ids are never reused; pick another name`)
  const req = {
    id,
    scope: faction.scope,
    group: faction.group,
    rank: name,
    capacity: null,
    permission: permissionOf(id),
    order: ladder.reduce((next, r) => Math.max(next, r.order + 1), 0),
    leader: false,
    recruit: [],
    promote: [],
  }
  applyRank(req, input, faction, [...ladder, req])
  data.requirements.push(req)
  const now = new Date().toISOString()
  const record = recordFor(data, faction, actor, now)
  bump(record, actor, now)
  save(data)
  audit(actor, 'rank.create', { rank: id, name: req.rank, rev: record.rev })
  return { faction: factionView(data, findFaction(data, faction.id)) }
}

function updateRank(rankId, input, actor) {
  const data = load(true)
  const req = findRank(data, rankId)
  const faction = findFaction(data, factionIdOf(rankId))
  checkRev(data, faction, input.rev)
  const before = rankSnapshot(req)
  applyRank(req, input, faction, ladderOf(data, faction.id))
  const changes = changesBetween(before, rankSnapshot(req))
  if (!Object.keys(changes).length) return { faction: factionView(data, faction) }
  const now = new Date().toISOString()
  const record = recordFor(data, faction, actor, now)
  bump(record, actor, now)
  save(data)
  audit(actor, 'rank.update', { rank: rankId, rev: record.rev, changes })
  return { faction: factionView(data, findFaction(data, faction.id)) }
}

// Rewrites order 0..n-1 from a full list of rank ids, leader first
function reorderRanks(factionId, input, actor) {
  const data = load(true)
  const faction = findFaction(data, factionId)
  checkRev(data, faction, input.rev)
  const current = ladderOf(data, faction.id).map(r => rankSlugOf(r.id))
  const wanted = Array.isArray(input.ranks) ? input.ranks.map(String) : []
  if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every(s => current.includes(s))) {
    throw fail(400, 'ranks must list every rank of the faction exactly once, leader first')
  }
  wanted.forEach((rankSlug, order) => { getRequirement(data, `${faction.id}:${rankSlug}`).order = order })
  const now = new Date().toISOString()
  const record = recordFor(data, faction, actor, now)
  bump(record, actor, now)
  save(data)
  audit(actor, 'rank.reorder', { faction: faction.id, rev: record.rev, order: wanted.join(',') })
  return { faction: factionView(data, findFaction(data, faction.id)) }
}

function deleteRank(rankId, input, actor) {
  const data = load(true)
  findRank(data, rankId)
  const faction = findFaction(data, factionIdOf(rankId))
  checkRev(data, faction, input.rev)
  const members = data.assignments.filter(a => a.requirementId === rankId)
  confirmCascade(data, members, input)
  if (members.length) backup()
  const rankSlug = rankSlugOf(rankId)
  data.assignments = data.assignments.filter(a => !members.includes(a))
  pruneRegents(data)
  data.requirements = data.requirements.filter(req => req.id !== rankId)
  for (const other of data.requirements) {
    if (factionIdOf(other.id) !== faction.id) continue
    for (const key of RANK_LISTS) {
      if (Array.isArray(other[key])) other[key] = other[key].filter(s => s !== rankSlug)
    }
  }
  retire(data, 'ranks', [rankId])
  const now = new Date().toISOString()
  const record = recordFor(data, faction, actor, now)
  bump(record, actor, now)
  save(data)
  auditRemovals(actor, members, `rank ${rankId} deleted`)
  audit(actor, 'rank.delete', { rank: rankId, rev: record.rev, removedMembers: members.length })
  return { faction: factionView(data, findFaction(data, faction.id)), removedMembers: members.length }
}

// ── Memberships ───────────────────────────────────────────────────────────────

function createAssignment(input, actorId) {
  const data = load(true)
  const requirement = getRequirement(data, input.requirementId)
  if (!requirement) throw fail(400, 'unknown requirement')

  const discordId = normalizeDiscordId(input.discordId)
  if (!discordId) throw fail(400, 'discordId is required')

  const slot = normalizeSlot(input.slot)

  if (data.assignments.some(item => item.requirementId === requirement.id && item.discordId === discordId && (item.slot ?? null) === slot)) {
    throw fail(409, 'player already has this rank')
  }

  const factionId = factionIdOf(requirement.id)
  const byFactionId = new Map(effectiveFactions(data).map(f => [f.id, f]))
  const faction = byFactionId.get(factionId)
  const ranksById = new Map(decorateRequirements(data).map(r => [r.id, r]))
  // Rows of this character plus the account-wide ones that also cover it
  const held = data.assignments.filter(item => item.discordId === discordId && overlapsSlot(item.slot ?? null, slot))

  if (faction) {
    const clash = held.find(item => {
      const other = byFactionId.get(factionIdOf(item.requirementId))
      return other && other.id !== factionId && other.type === faction.type
    })
    if (clash) {
      throw fail(409, `already in ${byFactionId.get(factionIdOf(clash.requirementId)).name}; a character belongs to one ${faction.type} faction at a time`)
    }
  }

  if ((ranksById.get(requirement.id) || {}).leader) {
    const leads = held.find(item => factionIdOf(item.requirementId) !== factionId && (ranksById.get(item.requirementId) || {}).leader)
    if (leads) throw fail(409, `already leads ${(byFactionId.get(factionIdOf(leads.requirementId)) || {}).name || 'another faction'}; nobody leads two factions`)
    const regentOf = [...byFactionId.values()].find(f => f.id !== factionId && f.regents.some(r => r.discordId === discordId && overlapsSlot(r.slot, slot)))
    if (regentOf) throw fail(409, `a regent of ${regentOf.name} cannot also lead a faction`)
  }

  if (Number.isInteger(requirement.capacity) && requirement.capacity > 0) {
    const count = data.assignments.filter(item => item.requirementId === requirement.id).length
    if (count >= requirement.capacity) throw fail(409, 'slot is already filled')
  }

  const now = new Date().toISOString()
  const assignment = {
    id: crypto.randomUUID(),
    requirementId: requirement.id,
    discordId,
    slot,
    playerName: cleanText(input.playerName, 60),
    notes: String(input.notes || '').trim(),
    createdAt: now,
    createdBy: actorId || null,
    updatedAt: now,
    updatedBy: actorId || null,
  }

  data.assignments.push(assignment)
  save(data)
  audit(actorId, 'member.add', { requirement: requirement.id, discordId, slot: slot ?? 'all', player: assignment.playerName })
  return decorateAssignment(assignment, requirement)
}

function updateAssignment(id, input, actorId) {
  const data = load(true)
  const idx = data.assignments.findIndex(item => item.id === id)
  if (idx === -1) throw fail(404, 'assignment not found')

  const assignment = data.assignments[idx]
  if (input.playerName !== undefined) assignment.playerName = cleanText(input.playerName, 60)
  if (input.notes !== undefined) assignment.notes = String(input.notes || '').trim()
  if (input.discordId !== undefined) {
    const discordId = normalizeDiscordId(input.discordId)
    if (!discordId) throw fail(400, 'discordId is required')
    const newSlot = input.slot !== undefined ? normalizeSlot(input.slot) : (assignment.slot ?? null)
    const duplicate = data.assignments.some(item =>
      item.id !== id && item.requirementId === assignment.requirementId && item.discordId === discordId && (item.slot ?? null) === newSlot
    )
    if (duplicate) throw fail(409, 'player already has this rank')
    assignment.discordId = discordId
  }

  if (input.slot !== undefined) assignment.slot = normalizeSlot(input.slot)
  assignment.updatedAt = new Date().toISOString()
  assignment.updatedBy = actorId || null
  save(data)
  audit(actorId, 'member.update', { requirement: assignment.requirementId, discordId: assignment.discordId, slot: assignment.slot ?? 'all', player: assignment.playerName })
  return decorateAssignment(assignment, getRequirement(data, assignment.requirementId))
}

function deleteAssignment(id, actorId) {
  const data = load(true)
  const idx = data.assignments.findIndex(item => item.id === id)
  if (idx === -1) throw fail(404, 'assignment not found')
  const [removed] = data.assignments.splice(idx, 1)
  pruneRegents(data)
  save(data)
  auditRemovals(actorId, [removed], 'removed')
}

// Rows of one character, plus the rows shared by every character when accountWide; returns what was removed
function releaseCharacter(discordId, slot, accountWide, actorId) {
  const normalized = normalizeDiscordId(discordId)
  const s = normalizeSlot(slot)
  if (s === null) throw fail(400, 'slot is required')
  const data = load(true)
  const removed = data.assignments.filter(a => a.discordId === normalized && ((a.slot ?? null) === s || (accountWide && (a.slot ?? null) === null)))
  if (removed.length) {
    data.assignments = data.assignments.filter(a => !removed.includes(a))
    pruneRegents(data)
    save(data)
    auditRemovals(actorId, removed, 'character deleted or perma-dead')
  }
  return removed.map(a => decorateAssignment(a, getRequirement(data, a.requirementId)))
}

// Regency seats whose holder left the faction are dropped wherever memberships disappear
function pruneRegents(data) {
  for (const record of data.factions) {
    if (!record || typeof record.id !== 'string' || !Array.isArray(record.regents)) continue
    const prefix = `${record.id}:`
    const kept = normalizeRegents(record.regents).filter(regent =>
      data.assignments.some(a => a.discordId === regent.discordId && (a.slot ?? null) === regent.slot && String(a.requirementId || '').startsWith(prefix)))
    if (kept.length !== record.regents.length) record.regents = kept
  }
}

// The ordered stand-ins of one faction and whether they may act; written from the game's Regency tab
function setRegency(factionId, input, actor) {
  const data = load(true)
  const faction = findFaction(data, factionId)
  const now = new Date().toISOString()
  const record = recordFor(data, faction, actor, now)
  const before = { regencyEnabled: faction.regencyEnabled, regents: faction.regents }
  if (input.enabled !== undefined) record.regencyEnabled = truthy(input.enabled)
  if (input.regents !== undefined) {
    const prefix = `${faction.id}:`
    const ranksById = new Map(decorateRequirements(data).map(r => [r.id, r]))
    const wanted = normalizeRegents(input.regents)
    for (const regent of wanted) {
      const row = data.assignments.find(a => a.discordId === regent.discordId && (a.slot ?? null) === regent.slot && String(a.requirementId || '').startsWith(prefix))
      if (!row) throw fail(400, 'a regent must already be a member of the faction')
      if ((ranksById.get(row.requirementId) || {}).leader) throw fail(400, 'the leader does not need a regency seat')
      const leads = data.assignments.find(a => a.discordId === regent.discordId && overlapsSlot(a.slot ?? null, regent.slot) && (ranksById.get(a.requirementId) || {}).leader)
      if (leads) throw fail(409, 'a faction leader cannot be a regent')
    }
    record.regents = wanted
  }
  const changes = changesBetween(before, { regencyEnabled: record.regencyEnabled, regents: record.regents })
  if (!Object.keys(changes).length) return { faction: factionView(data, faction) }
  bump(record, actor, now)
  save(data)
  audit(actor, 'faction.regency', { faction: faction.id, rev: record.rev, enabled: record.regencyEnabled, regents: record.regents.length })
  return { faction: factionView(data, findFaction(data, faction.id)) }
}

function decorateAssignment(assignment, requirement) {
  return {
    ...assignment,
    requirement: requirement || null,
    permission: requirement ? requirement.permission : null,
  }
}

function getPlayerFactionPermissions(discordId) {
  const data = load()
  const normalized = normalizeDiscordId(discordId)
  const byId = new Map(data.requirements.map(req => [req.id, req]))
  return data.assignments
    .filter(assignment => assignment.discordId === normalized)
    .map(assignment => byId.get(assignment.requirementId))
    .filter(Boolean)
    .map(req => req.permission)
}

function getPlayerGameFactions(discordId) {
  return getPlayerAssignments(discordId)
    .filter(assignment => assignment.requirement)
    .map(assignment => {
      const req = assignment.requirement
      return {
        factionId: `${req.scope}:${slug(req.group)}`,
        rank: req.capacity === 1 ? 100 : 0,
        title: req.rank,
        permission: req.permission,
        scope: req.scope,
        group: req.group,
        slot: assignment.slot ?? null,
      }
    })
}

function getPlayerAssignments(discordId) {
  const data = load()
  const normalized = normalizeDiscordId(discordId)
  const byId = new Map(data.requirements.map(req => [req.id, req]))
  return data.assignments
    .filter(assignment => assignment.discordId === normalized)
    .map(assignment => decorateAssignment(assignment, byId.get(assignment.requirementId)))
}

// All assignments of one faction ("<scope>:<group-slug>"), online or not
function getFactionRoster(factionId) {
  const data = load()
  const prefix = `${factionId}:`
  return rosterRows(data, data.assignments.filter(assignment => String(assignment.requirementId || '').startsWith(prefix)))
}

function getHoldRoster(holdSlug) {
  return getFactionRoster(`hold:${slug(holdSlug)}`)
}

// Roster rows with profile ids and the game server's character names; a reported name wins over the name stored at appointment
function namedRoster(rows, withDiscordId = false) {
  const profileMap = profiles.load().map
  const nameOf = characters.nameLookup()
  return rows.map(member => {
    const profileId = profileMap[member.discordId] || null
    return {
      ...(withDiscordId ? { discordId: member.discordId } : {}),
      profileId,
      playerName: (profileId && nameOf(profileId, member.slot)) || member.playerName,
      rank: member.rank,
      rankSlug: member.rankSlug,
      slot: member.slot,
      since: member.since,
    }
  })
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

module.exports = {
  list,
  listDefinitions,
  definitions,
  createFaction,
  updateFaction,
  deleteFaction,
  createRank,
  updateRank,
  reorderRanks,
  deleteRank,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  releaseCharacter,
  getPlayerFactionPermissions,
  getPlayerGameFactions,
  getPlayerAssignments,
  getFactionRoster,
  getHoldRoster,
  setRegency,
  TYPES,
  namedRoster,
  slug,
}
