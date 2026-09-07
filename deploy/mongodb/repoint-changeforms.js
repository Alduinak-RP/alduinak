'use strict'

/**
 * Repoints saved changeForms from one plugin filename to another, keeping the
 * local FormID. Use when a plugin is renamed or replaced but the records inside
 * it keep their ids - the alternative, clean-orphan-changeforms.js, deletes the
 * changeForm and loses whatever state it carried (inventory, position, faction).
 *
 * The server resolves every saved descriptor against the loaded plugin list at
 * boot and dies with "<Plugin>.esp not found in loaded files" if one is missing,
 * so a stale descriptor stops the server booting at all.
 *
 * Run with the game server STOPPED - a running server re-upserts loaded forms:
 *   node deploy/mongodb/repoint-changeforms.js "Old.esp" "New.esp"           # dry run
 *   node deploy/mongodb/repoint-changeforms.js "Old.esp" "New.esp" --apply   # back up + update
 *
 * Rewrites every descriptor-bearing field, not just formDesc: baseDesc,
 * worldOrCellDesc, spawnPoint_cellOrWorldDesc, templateChain[] and
 * factions.entries[].formDesc all carry "<hex>:<Plugin.esp>" strings.
 */

const fs = require('fs')
const path = require('path')

const SETTINGS = process.env.ALDUINAK_SERVER_SETTINGS ||
  path.join(__dirname, '..', '..', 'build', 'dist', 'server', 'server-settings.json')
const APPLY = process.argv.includes('--apply')
const args = process.argv.slice(2).filter(a => !a.startsWith('--'))

if (args.length !== 2) {
  console.error('usage: node deploy/mongodb/repoint-changeforms.js "<Old.esp>" "<New.esp>" [--apply]')
  process.exit(1)
}
const [OLD, NEW] = args

const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
if (settings.databaseDriver !== 'mongodb') {
  console.error(`databaseDriver is "${settings.databaseDriver}", this script only handles mongodb`)
  process.exit(1)
}

// The driver ships with server-manager; fall back to it when run elsewhere
function requireMongo() {
  const candidates = ['mongodb', path.join(__dirname, '..', '..', 'server-manager', 'node_modules', 'mongodb')]
  for (const c of candidates) {
    try { return require(c) } catch { /* try next */ }
  }
  throw new Error('mongodb driver not found: run npm install in server-manager')
}
const { MongoClient } = requireMongo()

const DESC = /^([0-9a-fA-F]{1,8}):(.+\.es[pml])$/

// Rewrite descriptors in place, returning how many strings changed
function rewrite(value, from, to, changed) {
  if (typeof value === 'string') {
    const m = DESC.exec(value)
    if (m && m[2].toLowerCase() === from.toLowerCase()) {
      changed.n++
      return m[1] + ':' + to
    }
    return value
  }
  if (Array.isArray(value)) return value.map(v => rewrite(v, from, to, changed))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = rewrite(value[k], from, to, changed)
    return out
  }
  return value
}

;(async () => {
  const loaded = new Set(settings.loadOrder.map(p => path.basename(p).toLowerCase()))
  if (!loaded.has(NEW.toLowerCase())) {
    console.error(`refusing: "${NEW}" is not in the server loadOrder - fix server-settings.json first`)
    process.exit(1)
  }
  if (loaded.has(OLD.toLowerCase())) {
    console.error(`refusing: "${OLD}" is still in the server loadOrder - nothing is orphaned yet`)
    process.exit(1)
  }

  const client = new MongoClient(settings.databaseUri)
  await client.connect()
  const col = client.db(settings.databaseName).collection('changeForms')

  const touched = []
  for await (const doc of col.find({})) {
    const changed = { n: 0 }
    const next = rewrite(doc, OLD, NEW, changed)
    if (changed.n > 0) touched.push({ _id: doc._id, before: doc, after: next, fields: changed.n })
  }

  console.log(`changeForms referencing "${OLD}": ${touched.length}`)
  for (const t of touched) {
    console.log(`   ${t.before.formDesc}  ->  ${t.after.formDesc}   (${t.fields} field(s), recType=${t.before.recType}, profileId=${t.before.profileId})`)
  }
  if (!touched.length) { console.log('nothing to do'); await client.close(); return }

  const players = touched.filter(t => t.before.profileId !== undefined && t.before.profileId !== -1)
  if (players.length) console.log(`\nNOTE: ${players.length} of these are player characters (profileId != -1)`)

  if (!APPLY) { console.log('\ndry run - pass --apply'); await client.close(); return }

  const backup = path.join(__dirname, `changeforms-backup-${Date.now()}.json`)
  fs.writeFileSync(backup, JSON.stringify(touched.map(t => t.before), null, 2))
  console.log(`\nbacked up ${touched.length} document(s) to ${backup}`)

  let n = 0
  for (const t of touched) {
    const { _id, ...rest } = t.after
    const r = await col.replaceOne({ _id: t._id }, rest)
    n += r.modifiedCount
  }
  console.log(`updated ${n} document(s)`)

  let left = 0
  for await (const doc of col.find({})) {
    const changed = { n: 0 }
    rewrite(doc, OLD, NEW, changed)
    if (changed.n) left++
  }
  console.log(`remaining referencing "${OLD}": ${left}`)

  await client.close()
})().catch(e => { console.error('ERROR ' + e.message); process.exit(1) })
