'use strict'
// Character names per profile and slot, reported by the game server so the dashboard and faction rosters can name characters

const db = require('./db')

// MongoDB characters: one document per profile id
const store = db.store('characters')
const MAX_SLOT = 9
const MAX_NAME = 60

function load() {
  return store.toObject()
}

function save(data) {
  store.replaceAll(data)
}

function toList(entry) {
  const slots = entry && entry.slots && typeof entry.slots === 'object' ? entry.slots : {}
  return Object.keys(slots)
    .map(Number)
    .filter(slot => Number.isInteger(slot) && slot >= 0 && slot <= MAX_SLOT)
    .sort((a, b) => a - b)
    .map(slot => ({ slot, name: String(slots[slot].name || ''), dead: slots[slot].dead === true }))
}

// Replaces the profile's list; unchanged lists are not rewritten
function setCharacters(profileId, list) {
  const id = Number(profileId)
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('invalid profileId')
    err.status = 400
    throw err
  }
  if (!Array.isArray(list)) {
    const err = new Error('characters must be a list of { slot, name, dead }')
    err.status = 400
    throw err
  }
  const slots = {}
  for (const c of list.slice(0, MAX_SLOT + 1)) {
    const slot = Number(c && c.slot)
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) continue
    slots[slot] = {
      name: String((c && c.name) || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_NAME),
      dead: !!(c && c.dead === true),
    }
  }
  const data = load()
  if (JSON.stringify((data[id] && data[id].slots) || {}) !== JSON.stringify(slots)) {
    data[id] = { slots, updatedAt: new Date().toISOString() }
    save(data)
  }
  return toList(data[id])
}

function forProfile(profileId) {
  return toList(load()[Number(profileId)])
}

// One read for a whole roster: (profileId, slot) -> reported name or ''
function nameLookup() {
  const data = load()
  return (profileId, slot) => {
    if (slot === null || slot === undefined) return ''
    const entry = toList(data[Number(profileId)]).find(c => c.slot === Number(slot))
    return entry ? entry.name : ''
  }
}

module.exports = { setCharacters, forProfile, nameLookup }
