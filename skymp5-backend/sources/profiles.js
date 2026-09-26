'use strict'

const db = require('./db')

// MongoDB profiles: { _id: discordId, profileId }; the next free id lives in meta
const store = db.store('profiles')
const meta  = db.store('meta')

function load() {
  const map = {}
  for (const [discordId, doc] of Object.entries(store.toObject())) map[discordId] = doc.profileId
  const next = (meta.get('profiles') || {}).nextId
  return { nextId: Number.isInteger(next) ? next : Math.max(0, ...Object.values(map)) + 1, map }
}

function save(data) {
  const docs = {}
  for (const [discordId, profileId] of Object.entries(data.map)) docs[discordId] = { profileId }
  store.replaceAll(docs)
  meta.set('profiles', { nextId: data.nextId })
}

function getOrCreateProfileId(discordId) {
  const id = String(discordId || '').trim()
  if (!id) throw new Error('discordId is required')

  const data = load()
  if (!data.map[id]) {
    data.map[id] = data.nextId++
    save(data)
  }
  return data.map[id]
}

function getDiscordIdByProfileId(profileId) {
  const id = Number(profileId)
  const entry = Object.entries(load().map).find(([, value]) => value === id)
  return entry ? entry[0] : null
}

function list() {
  return Object.entries(load().map)
    .map(([discordId, profileId]) => ({ discordId, profileId }))
    .sort((a, b) => a.profileId - b.profileId)
}

// nextId is never rewound, so a deleted profile id is not handed to a new player
function deleteByDiscordId(discordId) {
  const id = String(discordId || '').trim()
  const data = load()
  if (!(id in data.map)) return false
  delete data.map[id]
  save(data)
  return true
}

module.exports = {
  load,
  save,
  list,
  getOrCreateProfileId,
  getDiscordIdByProfileId,
  deleteByDiscordId,
}
