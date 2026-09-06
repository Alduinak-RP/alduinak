'use strict'

/**
 * Removes a single baseId from a saved changeForm's inv and equipmentDump
 * entries, leaving the rest of the record intact. Use when one item is
 * crashing clients but the character it belongs to must be kept - the
 * alternative, delete-changeforms.js, drops the whole document.
 *
 * Run with the game server STOPPED (a running server re-upserts loaded forms):
 *   node deploy/mongodb/strip-inventory-item.js 2 0xFE012881           # dry run
 *   node deploy/mongodb/strip-inventory-item.js 2 0xFE012881 --apply   # back up + strip
 *
 * baseId accepts hex (0x-prefixed) or decimal. The whole document is backed up
 * next to server-settings.json before anything is written.
 */

const fs = require('fs')
const path = require('path')

const SETTINGS = process.env.ALDUINAK_SERVER_SETTINGS ||
  path.join(__dirname, '..', '..', 'build', 'dist', 'server', 'server-settings.json')
const APPLY = process.argv.includes('--apply')
const args = process.argv.slice(2).filter(a => !a.startsWith('--'))

if (args.length !== 2) {
  console.error('usage: node deploy/mongodb/strip-inventory-item.js <formDesc> <baseId> [--apply]')
  process.exit(1)
}
const [FORM_DESC, BASE_ID_RAW] = args
const BASE_ID = Number(BASE_ID_RAW)
if (!Number.isInteger(BASE_ID) || BASE_ID < 0) {
  console.error(`bad baseId: ${BASE_ID_RAW}`)
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

const hex = n => '0x' + n.toString(16).toUpperCase()

function describe(entries, where) {
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.baseId === BASE_ID)
    .map(({ e, i }) => `  ${where}.entries[${i}] ${hex(e.baseId)} "${e.name || ''}" count=${e.count} worn=${!!e.worn}`)
}

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
    const inv = (doc.inv && doc.inv.entries) || []
    const equip = (doc.equipmentDump && doc.equipmentDump.inv && doc.equipmentDump.inv.entries) || []

    console.log(`formDesc=${doc.formDesc} _id=${doc._id} profileId=${doc.profileId} recType=${doc.recType}`)
    console.log(`name=${doc.appearanceDump && doc.appearanceDump.name}`)
    console.log(`inv ${inv.length} entries, equipmentDump ${equip.length} entries`)

    const found = [...describe(inv, 'inv'), ...describe(equip, 'equipmentDump.inv')]
    if (!found.length) {
      console.error(`ABORT: ${hex(BASE_ID)} not present in this changeForm`)
      process.exitCode = 1
      return
    }
    console.log(`matches for ${hex(BASE_ID)}:`)
    for (const line of found) console.log(line)

    if (!APPLY) {
      console.log('\n[dry run] re-run with --apply to back up and strip')
      return
    }

    const backup = path.join(path.dirname(SETTINGS), `stripped-changeform-${FORM_DESC}-${Date.now()}.json`)
    fs.writeFileSync(backup, JSON.stringify(doc, null, 2))
    console.log(`\nbacked up to ${backup}`)

    // $pull drops just the matching element. Never $set the whole array: the
    // driver rewrites every number as a BSON double and the server refuses to
    // load baseIds above 2^31, which stops it booting at all.
    const pull = {}
    if (doc.inv) pull['inv.entries'] = { baseId: BASE_ID }
    if (doc.equipmentDump && doc.equipmentDump.inv) pull['equipmentDump.inv.entries'] = { baseId: BASE_ID }

    const res = await col.updateOne({ _id: doc._id, formDesc: doc.formDesc }, { $pull: pull })
    if (res.matchedCount !== 1) throw new Error(`updateOne matched ${res.matchedCount} document(s)`)

    const after = await col.findOne({ _id: doc._id })
    const afterInv = (after.inv && after.inv.entries) || []
    const afterEquip = (after.equipmentDump && after.equipmentDump.inv && after.equipmentDump.inv.entries) || []
    console.log(`inv ${inv.length} -> ${afterInv.length}, equipmentDump ${equip.length} -> ${afterEquip.length}`)
    const left = [...describe(afterInv, 'inv'), ...describe(afterEquip, 'equipmentDump.inv')]
    if (left.length) throw new Error(`${hex(BASE_ID)} still present after the update`)
    console.log(`${hex(BASE_ID)} removed`)
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
