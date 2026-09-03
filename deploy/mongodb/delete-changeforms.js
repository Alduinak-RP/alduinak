'use strict'

/**
 * Deletes specific saved changeForms by formDesc, e.g. console-spawned NPCs
 * that must not come back on the next boot.
 *
 * Run with the game server STOPPED (a running server re-upserts loaded forms):
 *   node deploy/mongodb/delete-changeforms.js 62 63            # dry run
 *   node deploy/mongodb/delete-changeforms.js 62 63 --apply    # back up + delete
 *
 * Player characters (profileId other than -1) and non-actor records are
 * refused unless --allow-any is given.
 */

const fs = require('fs')
const path = require('path')

const SETTINGS = process.env.ALDUINAK_SERVER_SETTINGS ||
  path.join(__dirname, '..', '..', 'build', 'dist', 'server', 'server-settings.json')
const APPLY = process.argv.includes('--apply')
const ALLOW_ANY = process.argv.includes('--allow-any')
const targets = process.argv.slice(2).filter(a => !a.startsWith('--'))

if (targets.length === 0) {
  console.error('usage: node delete-changeforms.js <formDesc> [<formDesc>...] [--apply] [--allow-any]')
  process.exit(1)
}

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

async function main() {
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  try {
    const col = client.db(settings.databaseName).collection('changeForms')
    const before = await col.countDocuments()
    const docs = await col.find({ formDesc: { $in: targets } }).toArray()
    console.log(`${before} changeForms, ${docs.length} document(s) match ${targets.length} target(s)`)
    for (const d of docs) {
      console.log(`  ${d.formDesc} _id=${d._id} base=${d.baseDesc} cell=${d.worldOrCellDesc} pos=${JSON.stringify(d.position)} isDead=${d.isDead} profileId=${d.profileId} recType=${d.recType}`)
    }

    const missing = targets.filter(t => !docs.some(d => d.formDesc === t))
    if (missing.length) {
      console.error(`ABORT: not found: ${missing.join(', ')}`)
      process.exitCode = 1
      return
    }
    const dupes = targets.filter(t => docs.filter(d => d.formDesc === t).length > 1)
    if (dupes.length) {
      console.error(`ABORT: more than one document for: ${dupes.join(', ')}`)
      process.exitCode = 1
      return
    }
    const guarded = docs.filter(d => (d.profileId !== undefined && d.profileId !== -1) || d.recType !== 1)
    if (guarded.length && !ALLOW_ANY) {
      console.error(`ABORT: ${guarded.length} target(s) are player characters or non-actor records; pass --allow-any to delete them anyway`)
      process.exitCode = 1
      return
    }

    if (!APPLY) {
      console.log('\n[dry run] re-run with --apply to back up and delete')
      return
    }

    const backup = path.join(path.dirname(SETTINGS), `deleted-changeforms-${Date.now()}.json`)
    fs.writeFileSync(backup, JSON.stringify(docs, null, 2))
    console.log(`\nbacked up to ${backup}`)
    for (const d of docs) {
      const res = await col.deleteOne({ _id: d._id, formDesc: d.formDesc })
      if (res.deletedCount !== 1) throw new Error(`deleteOne removed ${res.deletedCount} document(s) for ${d.formDesc}`)
      console.log(`deleted ${d.formDesc}`)
    }
    console.log(`remaining ${await col.countDocuments()} (was ${before})`)
  } finally {
    await client.close()
  }
}

// Driver parse errors embed the connection string, so keep credentials out of the console
main().catch(err => {
  const uri = settings.databaseUri
  const msg = typeof uri === 'string' && uri ? String(err.message).split(uri).join('<databaseUri>') : err.message
  console.error('FAILED:', msg)
  process.exit(1)
})
