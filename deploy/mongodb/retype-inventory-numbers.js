'use strict'

/**
 * Rewrites inventory baseId/count values that are stored as BSON doubles back
 * to the integer types the game server expects: int32 below 2^31, int64 above.
 *
 * A doubled baseId stops the server booting with "failed to call Serialize
 * (type in:d out:adapter unsigned int -> unsigned __int64) INCORRECT_TYPE",
 * naming only the array index, not the document. The usual cause is a script
 * that $set an entries array instead of $pull-ing one element, because the
 * driver serializes every JS number above 2^31 as a double.
 *
 * Safe to run against a crash-looping server: it dies during changeForm load,
 * before it can write anything back.
 *
 *   node deploy/mongodb/retype-inventory-numbers.js           # dry run, lists offenders
 *   node deploy/mongodb/retype-inventory-numbers.js --apply   # back up + fix
 */

const fs = require('fs')
const path = require('path')

const SETTINGS = process.env.ALDUINAK_SERVER_SETTINGS ||
  path.join(__dirname, '..', '..', 'build', 'dist', 'server', 'server-settings.json')
const APPLY = process.argv.includes('--apply')

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
const { MongoClient, Int32, Long } = requireMongo()

const INT32_MAX = 2147483647
const PATHS = ['inv.entries', 'equipmentDump.inv.entries']

function typed(v) {
  return v > INT32_MAX ? Long.fromNumber(v) : new Int32(v)
}

function entriesAt(doc, p) {
  return p.split('.').reduce((o, k) => (o == null ? o : o[k]), doc) || []
}

async function main() {
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  try {
    const col = client.db(settings.databaseName).collection('changeForms')

    // $type reports the stored BSON type; the driver hides it behind a JS number
    const project = { formDesc: 1 }
    for (const p of PATHS) {
      project[p.replace(/\./g, '_') + '_types'] = {
        $map: { input: { $ifNull: ['$' + p, []] }, as: 'e', in: [{ $type: '$$e.baseId' }, { $type: '$$e.count' }] }
      }
    }
    const scanned = await col.aggregate([{ $project: project }]).toArray()
    const bad = scanned.filter(d => PATHS.some(p =>
      (d[p.replace(/\./g, '_') + '_types'] || []).some(t => t.includes('double'))))

    console.log(`${scanned.length} changeForms scanned, ${bad.length} with double-typed inventory numbers`)
    for (const d of bad) console.log(`  formDesc=${d.formDesc}`)
    if (!bad.length) return

    if (!APPLY) {
      console.log('\n[dry run] re-run with --apply to back up and fix')
      return
    }

    const descs = bad.map(d => d.formDesc)
    const docs = await col.find({ formDesc: { $in: descs } }).toArray()
    const backup = path.join(path.dirname(SETTINGS), `retyped-changeforms-${Date.now()}.json`)
    fs.writeFileSync(backup, JSON.stringify(docs, null, 2))
    console.log(`\nbacked up to ${backup}`)

    for (const doc of docs) {
      const update = {}
      for (const p of PATHS) {
        const entries = entriesAt(doc, p)
        if (!entries.length) continue
        update[p] = entries.map(e => {
          const out = { ...e }
          if (typeof e.baseId === 'number') out.baseId = typed(e.baseId)
          if (typeof e.count === 'number') out.count = typed(e.count)
          return out
        })
      }
      const res = await col.updateOne({ _id: doc._id, formDesc: doc.formDesc }, { $set: update })
      if (res.matchedCount !== 1) throw new Error(`updateOne matched ${res.matchedCount} document(s) for ${doc.formDesc}`)
      console.log(`retyped ${doc.formDesc}`)
    }

    const after = await col.aggregate([{ $match: { formDesc: { $in: descs } } }, { $project: project }]).toArray()
    const left = after.filter(d => PATHS.some(p =>
      (d[p.replace(/\./g, '_') + '_types'] || []).some(t => t.includes('double'))))
    if (left.length) throw new Error(`still double-typed: ${left.map(d => d.formDesc).join(', ')}`)
    console.log('no double-typed inventory numbers remain')
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
