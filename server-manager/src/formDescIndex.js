'use strict'

// The changeForms { formDesc: 1 } index the game server's saves filter on; ensuring it reports one line and never throws

const KEY = { formDesc: 1 }
const NAME = 'formDesc_1'
const TIMEOUT_MS = 15000
const NAMESPACE_NOT_FOUND = 26
const TIMEOUT = Symbol('timeout')

const line = (outcome, db, rest) => `[index] changeForms.formDesc ${outcome} on ${db || '(no databaseName)'}${rest}`
const notEnsured = (db, reason) => line('not ensured', db, `: ${reason}`)

// Any index keyed on formDesc alone counts, whatever its name or options
function isFormDescIndex(index) {
  const key = Object.entries((index && index.key) || {})
  return key.length === 1 && key[0][0] === 'formDesc' && Number(key[0][1]) === 1
}

// 'present' or 'created'; a missing collection is created with the index
async function ensureOn(col) {
  let list
  try { list = await col.indexes() }
  catch (err) { if (err && err.code === NAMESPACE_NOT_FOUND) list = []; else throw err }
  if (list.some(isFormDescIndex)) return 'present'
  await col.createIndex(KEY, { name: NAME })
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
  const work = (async () => {
    const opened = await (open || purge.openChangeForms)(settings)
    client = opened.client
    return ensureOn(opened.col)
  })()
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, TIMEOUT) })
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

module.exports = { KEY, NAME, TIMEOUT_MS, isFormDescIndex, ensureOn, ensureFormDescIndex, notEnsured }
