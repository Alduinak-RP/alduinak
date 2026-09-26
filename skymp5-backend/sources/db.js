'use strict'

// The backend's records in MongoDB, in the game server's database (server-settings.json databaseUri and databaseName).
// Each collection is mirrored in memory at start, so reads stay synchronous; writes update the mirror and reach MongoDB
// in order shortly after. The backend is the only writer: other tools read MongoDB directly and write through its API.

const { MongoClient } = require('mongodb')
const config = require('../config')

// Loaded by init() before anything reads them
const COLLECTIONS = ['players', 'profiles', 'bans', 'characters', 'sessions', 'authStates', 'balances', 'factions', 'meta']
const FLUSH_MS = 25
const RETRY_MS = 5000

let client = null
let db = null
const stores = new Map()

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

class Store {
  constructor(name) {
    this.name = name
    this.docs = new Map()
    this.dirty = new Set()
    this.timer = null
    this.flushing = null
  }

  get(id) { return clone(this.docs.get(String(id))) }
  has(id) { return this.docs.has(String(id)) }
  get size() { return this.docs.size }

  set(id, doc) {
    const key = String(id)
    const next = clone(doc)
    if (JSON.stringify(this.docs.get(key)) === JSON.stringify(next)) return
    this.docs.set(key, next)
    this.mark(key)
  }

  delete(id) {
    const key = String(id)
    if (!this.docs.delete(key)) return false
    this.mark(key)
    return true
  }

  // The whole collection as { id: doc }, a copy the caller may change and hand back to replaceAll
  toObject() {
    const out = {}
    for (const [id, doc] of this.docs) out[id] = clone(doc)
    return out
  }

  // Writes only the documents that differ, and deletes the ones missing from obj
  replaceAll(obj) {
    for (const id of [...this.docs.keys()]) if (!(id in obj)) this.delete(id)
    for (const [id, doc] of Object.entries(obj)) this.set(id, doc)
  }

  mark(key) {
    this.dirty.add(key)
    if (!this.timer && db) this.timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  async flush() {
    this.timer = null
    if (this.flushing) await this.flushing
    if (!db || !this.dirty.size) return
    const ids = [...this.dirty]
    this.dirty.clear()
    const ops = ids.map(id => (this.docs.has(id)
      ? { replaceOne: { filter: { _id: id }, replacement: this.docs.get(id), upsert: true } }
      : { deleteOne: { filter: { _id: id } } }))
    this.flushing = db.collection(this.name).bulkWrite(ops, { ordered: true }).then(() => {}, err => {
      console.error(`[db] ${this.name}: ${ops.length} write(s) failed, retrying in ${RETRY_MS / 1000} s: ${err.message}`)
      for (const id of ids) this.dirty.add(id)
      if (!this.timer) this.timer = setTimeout(() => this.flush(), RETRY_MS)
    })
    await this.flushing
    this.flushing = null
  }

  async load() {
    this.docs.clear()
    for await (const { _id, ...doc } of db.collection(this.name).find()) this.docs.set(String(_id), doc)
  }
}

function store(name) {
  if (!stores.has(name)) stores.set(name, new Store(name))
  return stores.get(name)
}

// Connects and loads every collection; call it before requiring any module that reads a store. Without it (tests, scripts) the stores live in memory only
async function init() {
  const settings = config.servers[0].settings
  if (!settings.databaseUri) throw new Error(`databaseUri is missing from ${config.servers[0].settingsPath}`)
  client = new MongoClient(settings.databaseUri)
  await client.connect()
  db = client.db(settings.databaseName || 'skymp')
  for (const name of COLLECTIONS) await store(name).load()
  console.log(`[db] loaded ${[...stores.values()].map(s => `${s.name} ${s.size}`).join(', ')}`)
}

async function flushAll() {
  for (const s of stores.values()) await s.flush()
}

async function close() {
  await flushAll()
  if (client) await client.close()
  client = null
  db = null
}

// A collection the backend does not mirror (written by more than one process), or null without a connection
function collection(name) {
  return db ? db.collection(name) : null
}

module.exports = { store, collection, init, flushAll, close, get connected() { return !!db } }
