'use strict'

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

const FILE = path.join(__dirname, '..', 'data', 'faction-whitelist.json')

// characterSelectMaxCharacters allows 1-10 characters, so slots run 0-9
const MAX_SLOT = 9
const ZONES = ['', 'west', 'east', 'neutral']
const SCOPE_RE = /^[a-z][a-z0-9-]{0,31}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const COLOR_RE = /^[0-9a-f]{6}$/
const PERMISSION_RE = /^[A-Za-z0-9._*-]{1,64}$/
const MAX_TEXT = 48
const MAX_UNIFORM_ITEMS = 16
const MAX_UNIFORM_COUNT = 100

let unreadableLogged = false

function fail(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// A missing file reads as empty; an unreadable one reads as empty for lookups but refuses writes, so a typo never wipes the table
function load(forWrite = false) {
  const empty = { factions: [], requirements: [], assignments: [] }
  let data
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (!data || typeof data !== 'object') throw new Error('top level is not an object')
  } catch (err) {
    if (err.code === 'ENOENT') return empty
    if (!unreadableLogged) {
      unreadableLogged = true
      console.error(`[factionWhitelist] data/faction-whitelist.json is unreadable, factions are disabled until it is fixed: ${err.message}`)
    }
    if (forWrite) throw fail(500, 'faction-whitelist.json is unreadable; fix the file before changing factions')
    return empty
  }
  unreadableLogged = false
  return {
    factions: Array.isArray(data.factions) ? data.factions : [],
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  }
}

function save(data) {
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, FILE)
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

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// "hold:the-rift:jarl" -> "hold:the-rift"
function factionIdOf(requirementId) {
  const parts = String(requirementId || '').split(':')
  return parts.length === 3 ? `${parts[0]}:${parts[1]}` : ''
}

function normalizeUniform(raw) {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw)) throw fail(400, 'uniform must be a list of { item, count }')
  if (raw.length > MAX_UNIFORM_ITEMS) throw fail(400, `a uniform holds at most ${MAX_UNIFORM_ITEMS} items`)
  return raw.map(entry => {
    const item = cleanText(entry && entry.item, 96)
    const count = entry && entry.count !== undefined ? Number(entry.count) : 1
    if (!item) throw fail(400, 'every uniform item needs an item id, e.g. 0x0001391E or 13ED9:Skyrim.esm')
    if (!Number.isInteger(count) || count < 1 || count > MAX_UNIFORM_COUNT) throw fail(400, `uniform counts run from 1 to ${MAX_UNIFORM_COUNT}`)
    return { item, count }
  })
}

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
    return {
      ...req,
      capacity: Number.isInteger(req.capacity) && req.capacity > 0 ? req.capacity : null,
      order: Number.isInteger(req.order) && req.order >= 0 ? req.order : position,
      appoints: Array.isArray(req.appoints) ? req.appoints.map(String) : null,
      issuesUniform: req.issuesUniform === true,
      uniform: Array.isArray(req.uniform) ? req.uniform : null,
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
    byId.set(f.id, {
      id: f.id,
      scope: String(f.scope || f.id.split(':')[0]),
      group: String(f.group || ''),
      name: String(f.name || f.group || f.id),
      zone: ZONES.includes(f.zone) ? f.zone : '',
      color: COLOR_RE.test(String(f.color || '')) ? f.color : '',
      uniform: Array.isArray(f.uniform) ? f.uniform : [],
    })
  }
  for (const req of data.requirements) {
    const id = factionIdOf(req.id)
    if (!id || byId.has(id)) continue
    byId.set(id, { id, scope: String(req.scope || id.split(':')[0]), group: String(req.group || ''), name: String(req.group || id), zone: '', color: '', uniform: [] })
  }
  return [...byId.values()]
}

function list() {
  const data = load()
  return {
    factions: effectiveFactions(data),
    requirements: decorateRequirements(data),
    assignments: data.assignments,
  }
}

// Faction and rank definitions without members, for the game server
function listDefinitions() {
  const data = load()
  return { factions: effectiveFactions(data), requirements: decorateRequirements(data) }
}

function upsertFaction(input, actorId) {
  const data = load(true)
  const now = new Date().toISOString()
  const name = cleanText(input.name)
  const zone = input.zone === undefined ? undefined : String(input.zone || '')
  if (zone !== undefined && !ZONES.includes(zone)) throw fail(400, 'zone must be west, east, neutral or empty')
  const color = input.color === undefined ? undefined : String(input.color || '').replace(/^#/, '').toLowerCase()
  if (color && !COLOR_RE.test(color)) throw fail(400, 'color must be six hex digits, e.g. c9a36b')
  const uniform = input.uniform === undefined ? undefined : (normalizeUniform(input.uniform) || [])

  const existingId = String(input.id || '')
  const effective = effectiveFactions(data).find(f => f.id === existingId)
  if (existingId && effective) {
    let record = data.factions.find(f => f && f.id === existingId)
    if (!record) {
      record = { id: effective.id, scope: effective.scope, group: effective.group, name: effective.name, zone: '', color: '', uniform: [], createdAt: now, createdBy: actorId || null }
      data.factions.push(record)
    }
    if (name) record.name = name
    if (zone !== undefined) record.zone = zone
    if (color !== undefined) record.color = color
    if (uniform !== undefined) record.uniform = uniform
    record.updatedAt = now
    record.updatedBy = actorId || null
    save(data)
    return record
  }
  if (existingId) throw fail(404, 'faction not found')

  const scope = String(input.scope || '').trim().toLowerCase()
  const group = cleanText(input.group)
  if (!SCOPE_RE.test(scope)) throw fail(400, 'scope must be a short lower-case word such as hold or faction')
  if (!group || !slug(group)) throw fail(400, 'group name is required')
  const id = `${scope}:${slug(group)}`
  if (effectiveFactions(data).some(f => f.id === id)) throw fail(409, `faction ${id} already exists`)
  const record = {
    id, scope, group,
    name: name || group,
    zone: zone || '',
    color: color || '',
    uniform: uniform || [],
    createdAt: now, createdBy: actorId || null, updatedAt: now, updatedBy: actorId || null,
  }
  data.factions.push(record)
  save(data)
  return record
}

// Refused while anyone holds a rank, so a click cannot strip a whole court
function deleteFaction(id) {
  const data = load(true)
  const prefix = `${id}:`
  if (!effectiveFactions(data).some(f => f.id === id)) throw fail(404, 'faction not found')
  if (data.assignments.some(a => String(a.requirementId || '').startsWith(prefix))) throw fail(409, 'remove every member before deleting the faction')
  data.factions = data.factions.filter(f => !f || f.id !== id)
  data.requirements = data.requirements.filter(req => !String(req.id || '').startsWith(prefix))
  save(data)
}

// Ids never change once created, so renaming a rank keeps its holders
function upsertRequirement(input) {
  const data = load(true)
  const capacity = input.capacity === undefined ? undefined
    : (input.capacity === null || input.capacity === '' || Number(input.capacity) === 0 ? null : Number(input.capacity))
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) throw fail(400, 'capacity must be empty (open) or a whole number')
  const order = input.order === undefined || input.order === '' ? undefined : Number(input.order)
  if (order !== undefined && (!Number.isInteger(order) || order < 0 || order > 99)) throw fail(400, 'order must be a whole number from 0 (leader) to 99')
  const appoints = input.appoints === undefined ? undefined
    : input.appoints === null ? null
      : Array.isArray(input.appoints) ? [...new Set(input.appoints.map(s => String(s || '').trim().toLowerCase()).filter(s => SLUG_RE.test(s)))] : undefined
  if (input.appoints !== undefined && input.appoints !== null && !Array.isArray(input.appoints)) throw fail(400, 'appoints must be a list of rank ids')
  const uniform = input.uniform === undefined ? undefined : normalizeUniform(input.uniform)
  const rank = input.rank === undefined ? undefined : cleanText(input.rank)
  const permission = input.permission === undefined ? undefined : String(input.permission || '').trim()
  if (permission && !PERMISSION_RE.test(permission)) throw fail(400, 'permission may hold letters, digits, dots, dashes, underscores and *')

  const apply = req => {
    if (rank) req.rank = rank
    if (permission) req.permission = permission
    if (capacity !== undefined) req.capacity = capacity
    if (order !== undefined) req.order = order
    if (appoints !== undefined) req.appoints = appoints
    if (input.issuesUniform !== undefined) req.issuesUniform = input.issuesUniform === true
    if (uniform !== undefined) req.uniform = uniform
  }

  const existingId = String(input.id || '')
  if (existingId) {
    const req = getRequirement(data, existingId)
    if (!req) throw fail(404, 'rank not found')
    apply(req)
    save(data)
    return req
  }

  const faction = effectiveFactions(data).find(f => f.id === String(input.factionId || ''))
  if (!faction) throw fail(400, 'pick an existing faction for the new rank')
  if (!rank || !slug(rank)) throw fail(400, 'rank name is required')
  const id = `${faction.id}:${slug(rank)}`
  if (getRequirement(data, id)) throw fail(409, `rank ${id} already exists`)
  const groupSlug = faction.id.split(':')[1]
  const req = {
    id,
    scope: faction.scope,
    group: faction.group,
    rank,
    capacity: null,
    permission: `${faction.scope}.${groupSlug}.${slug(rank)}`,
    order: data.requirements.filter(r => factionIdOf(r.id) === faction.id).length,
    appoints: [],
    issuesUniform: false,
  }
  apply(req)
  data.requirements.push(req)
  save(data)
  return req
}

function deleteRequirement(id) {
  const data = load(true)
  if (!getRequirement(data, id)) throw fail(404, 'rank not found')
  if (data.assignments.some(a => a.requirementId === id)) throw fail(409, 'remove everyone holding this rank first')
  data.requirements = data.requirements.filter(req => req.id !== id)
  save(data)
}

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
  return decorateAssignment(assignment, getRequirement(data, assignment.requirementId))
}

function deleteAssignment(id) {
  const data = load(true)
  const idx = data.assignments.findIndex(item => item.id === id)
  if (idx === -1) throw fail(404, 'assignment not found')
  data.assignments.splice(idx, 1)
  save(data)
}

// Rows of one character, plus the rows shared by every character when accountWide; returns what was removed
function releaseCharacter(discordId, slot, accountWide) {
  const normalized = normalizeDiscordId(discordId)
  const s = normalizeSlot(slot)
  if (s === null) throw fail(400, 'slot is required')
  const data = load(true)
  const removed = data.assignments.filter(a => a.discordId === normalized && ((a.slot ?? null) === s || (accountWide && (a.slot ?? null) === null)))
  if (removed.length) {
    data.assignments = data.assignments.filter(a => !removed.includes(a))
    save(data)
  }
  return removed.map(a => decorateAssignment(a, getRequirement(data, a.requirementId)))
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
  const byId = new Map(data.requirements.map(req => [req.id, req]))
  return data.assignments
    .filter(assignment => String(assignment.requirementId || '').startsWith(prefix))
    .map(assignment => {
      const req = byId.get(assignment.requirementId)
      return {
        assignmentId: assignment.id,
        discordId: assignment.discordId,
        playerName: assignment.playerName || '',
        slot: assignment.slot ?? null,
        rank: req ? req.rank : null,
        rankSlug: String(assignment.requirementId).slice(prefix.length),
      }
    })
}

function getHoldRoster(holdSlug) {
  return getFactionRoster(`hold:${slug(holdSlug)}`)
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
  upsertFaction,
  deleteFaction,
  upsertRequirement,
  deleteRequirement,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  releaseCharacter,
  getPlayerFactionPermissions,
  getPlayerGameFactions,
  getPlayerAssignments,
  getFactionRoster,
  getHoldRoster,
  slug,
}
