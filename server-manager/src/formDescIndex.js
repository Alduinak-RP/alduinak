'use strict'

// The changeForms indexes: formDesc, which the game server's saves filter on, and the zone (worldOrCellDesc) and player
// (profileId) a form belongs to; ensuring them reports one line and never throws

const FIELDS = ['formDesc', 'worldOrCellDesc', 'profileId']
const KEY = { formDesc: 1 }
const NAME = 'formDesc_1'
const TIMEOUT_MS = 15000
const NAMESPACE_NOT_FOUND = 26
const TIMEOUT = Symbol('timeout')

const line = (outcome, db, rest) => `[index] changeForms ${FIELDS.join(', ')} ${outcome} on ${db || '(no databaseName)'}${rest}`
const notEnsured = (db, reason) => line('not ensured', db, `: ${reason}`)

// Any ascending index on the field alone counts, whatever its name or options
function isIndexOn(index, field) {
  const key = Object.entries((index && index.key) || {})
  return key.length === 1 && key[0][0] === field && Number(key[0][1]) === 1
}

const isFormDescIndex = index => isIndexOn(index, 'formDesc')

// 'present' when every index exists, else 'created'; a missing collection is created with them; abandoned() true skips createIndex
async function ensureOn(col, abandoned = () => false) {
  let list
  try { list = await col.indexes() }
  catch (err) { if (err && err.code === NAMESPACE_NOT_FOUND) list = []; else throw err }
  const missing = FIELDS.filter(field => !list.some(index => isIndexOn(index, field)))
  if (!missing.length) return 'present'
  for (const field of missing) {
    if (abandoned()) return TIMEOUT
    await col.createIndex({ [field]: 1 }, { name: `${field}_1` })
  }
  return 'created'
}

// { ok, outcome, line }; open(settings) -> { client, col } defaults to mongoPurge.openChangeForms
async function ensureFormDescIndex(settings, { open, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now()
  const db = settings && settings.databaseName
  const fail = reason => ({ ok: false, outcome: 'not ensured', line: notEnsured(db, reason) })
  const driver = (settings && settings.databaseDriver) || 'file'
  if (driver !== 'mongodb') return fail(`databaseDriver is "${driver}", only mongodb has indexes`)
  if (!settings.databaseUri) return fail('server-settings.json has no databaseUri')
  let purge
  try { purge = require('./mongoPurge') }
  catch (err) { return fail(err && err.code === 'MODULE_NOT_FOUND' ? 'mongodb module not installed in server-manager, run npm install' : String(err && err.message)) }

  let client = null
  let timer = null
  // Set once the cap wins, so work answering late never builds the index while the game boots
  let late = false
  const work = (async () => {
    const opened = await (open || purge.openChangeForms)(settings)
    client = opened.client
    return late ? TIMEOUT : ensureOn(opened.col, () => late)
  })()
  const timeout = new Promise(resolve => { timer = setTimeout(() => { late = true; resolve(TIMEOUT) }, timeoutMs) })
  let outcome = null
  let error = null
  try { outcome = await Promise.race([work, timeout]) } catch (err) { error = err }
  clearTimeout(timer)
  // Closed whenever the work settles, so a late connection after a timeout is closed too
  work.catch(() => {}).then(() => client && client.close()).catch(() => {})
  if (error) return fail(purge.sanitize(error, settings))
  if (outcome === TIMEOUT) return fail(`no answer within ${timeoutMs / 1000} s`)
  return { ok: true, outcome, line: line(outcome, db, ` (${Date.now() - started} ms)`) }
}

module.exports = { FIELDS, KEY, NAME, TIMEOUT_MS, isIndexOn, isFormDescIndex, ensureOn, ensureFormDescIndex, notEnsured }
