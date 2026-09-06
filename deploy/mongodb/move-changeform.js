'use strict'

/**
 * Moves a saved changeForm to a new position, optionally into a different
 * cell or worldspace. Use to unstick a character standing somewhere that
 * crashes them on load.
 *
 * Run with the game server STOPPED (a running server re-upserts loaded forms):
 *   node deploy/mongodb/move-changeform.js 60 133857 -61130 14662           # dry run
 *   node deploy/mongodb/move-changeform.js 60 133857 -61130 14662 --apply
 *   node deploy/mongodb/move-changeform.js 60 --spawn --apply               # to its own spawn point
 *
 * Coordinates are written as BSON doubles. The driver would otherwise store a
 * whole number as int32 and the server refuses to load a position that is not
 * a double, which stops it booting at all.
 */

const fs = require('fs')
const path = require('path')

const SETTINGS = process.env.ALDUINAK_SERVER_SETTINGS ||
  path.join(__dirname, '..', '..', 'build', 'dist', 'server', 'server-settings.json')
const APPLY = process.argv.includes('--apply')
const SPAWN = process.argv.includes('--spawn')
const cellIdx = process.argv.indexOf('--cell')
const CELL = cellIdx === -1 ? null : process.argv[cellIdx + 1]
const args = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('--') && all[i - 1] !== '--cell')

if (!(SPAWN ? args.length === 1 : args.length === 4)) {
  console.error('usage: node deploy/mongodb/move-changeform.js <formDesc> <x> <y> <z> [--cell <desc>] [--apply]')
  console.error('       node deploy/mongodb/move-changeform.js <formDesc> --spawn [--apply]')
  process.exit(1)
}
const FORM_DESC = args[0]
const COORDS = SPAWN ? null : args.slice(1).map(Number)
if (COORDS && COORDS.some(n => !Number.isFinite(n))) {
  console.error(`bad coordinates: ${args.slice(1).join(' ')}`)
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
const { MongoClient, Double } = requireMongo()

async function main() {
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  try {
    const col = client.db(settings.databaseName).collection('changeForms')
    const docs = await col.find({ formDesc: FORM_DESC }).toArray()
    if (docs.length !== 1) {
      console.error(`ABORT: ${docs.length} document(s) for formDesc ${FORM_DESC}, expected exactly 1`)
      process.exitCode = 1
      return
    }
    const doc = docs[0]
    const target = COORDS || doc.spawnPoint_pos
    const cell = CELL || (SPAWN ? doc.spawnPoint_cellOrWorldDesc : doc.worldOrCellDesc)
    if (!Array.isArray(target) || target.length !== 3) {
      console.error('ABORT: no usable target position')
      process.exitCode = 1
      return
    }

    const [x, y, z] = doc.position || []
    const dist = Math.round(Math.hypot(target[0] - x, target[1] - y, target[2] - z))
    console.log(`formDesc=${doc.formDesc} _id=${doc._id} profileId=${doc.profileId} recType=${doc.recType}`)
    console.log(`name  : ${doc.appearanceDump && doc.appearanceDump.name}`)
    console.log(`from  : ${doc.worldOrCellDesc} ${JSON.stringify(doc.position)}`)
    console.log(`to    : ${cell} ${JSON.stringify(target)}`)
    console.log(`moves : ${dist} units`)

    if (!APPLY) {
      console.log('\n[dry run] re-run with --apply to back up and move')
      return
    }

    const backup = path.join(path.dirname(SETTINGS), `moved-changeform-${FORM_DESC}-${Date.now()}.json`)
    fs.writeFileSync(backup, JSON.stringify(doc, null, 2))
    console.log(`\nbacked up to ${backup}`)

    const update = { position: target.map(n => new Double(n)) }
    if (cell !== doc.worldOrCellDesc) update.worldOrCellDesc = cell

    const res = await col.updateOne({ _id: doc._id, formDesc: doc.formDesc }, { $set: update })
    if (res.matchedCount !== 1) throw new Error(`updateOne matched ${res.matchedCount} document(s)`)

    const check = await col.aggregate([
      { $match: { _id: doc._id } },
      { $project: { position: 1, worldOrCellDesc: 1,
        posTypes: { $map: { input: '$position', as: 'p', in: { $type: '$$p' } } } } }
    ]).toArray()
    const types = check[0].posTypes
    console.log(`now   : ${check[0].worldOrCellDesc} ${JSON.stringify(check[0].position)}`)
    console.log(`types : ${types.join(',')}`)
    if (types.some(t => t !== 'double')) throw new Error(`position is ${types.join(',')}, expected all double`)
    console.log('moved')
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
