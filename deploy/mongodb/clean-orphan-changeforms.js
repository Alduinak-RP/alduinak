'use strict'

/**
 * Deletes saved changeForms that reference plugins no longer in the server's
 * load order. The server refuses to boot with "<Plugin>.esp not found in loaded
 * files" when a mod is removed while its world objects are still saved.
 *
 * Run from anywhere in the repo:
 *   node deploy/mongodb/clean-orphan-changeforms.js            # dry run
 *   node deploy/mongodb/clean-orphan-changeforms.js --apply    # back up + delete
 *
 * Player characters are never deleted: the script aborts if any orphan carries
 * a profileId or is an ACHR record, so those get resolved by hand.
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

const { MongoClient } = requireMongo()

// "<hex>:<Plugin.esp>" descriptors appear in formDesc, worldOrCellDesc, baseDesc, ...
const DESC_RE = /\b[0-9a-fA-F]{1,8}:([^"'\s,}\]]+\.es[pml])\b/g

async function main() {
  const loaded = new Set(settings.loadOrder.map(p => p.split(/[\\/]/).pop().toLowerCase()))
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  try {
    const col = client.db(settings.databaseName).collection('changeForms')
    const all = await col.find({}).toArray()
    console.log(`scanned ${all.length} changeForms against ${loaded.size} loaded plugins`)

    const orphans = []
    const missing = new Map()
    for (const doc of all) {
      const text = JSON.stringify(doc)
      const bad = new Set()
      DESC_RE.lastIndex = 0
      let m
      while ((m = DESC_RE.exec(text)) !== null) {
        if (!loaded.has(m[1].toLowerCase())) bad.add(m[1])
      }
      if (bad.size) {
        orphans.push(doc)
        for (const p of bad) missing.set(p, (missing.get(p) || 0) + 1)
      }
    }

    console.log(`orphaned documents: ${orphans.length}`)
    for (const [p, n] of [...missing].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n}`)
    if (orphans.length === 0) return

    const playerData = orphans.filter(d => (d.profileId !== undefined && d.profileId !== -1) || d.recType === 1)
    if (playerData.length) {
      console.error(`\nABORT: ${playerData.length} orphan(s) are player characters or player-owned:`)
      playerData.slice(0, 10).forEach(d => console.error(`  formDesc=${d.formDesc} profileId=${d.profileId} recType=${d.recType}`))
      console.error('Restore the plugin or fix these by hand.')
      process.exitCode = 1
      return
    }

    if (!APPLY) {
      console.log('\n[dry run] re-run with --apply to back up and delete')
      return
    }

    const backup = path.join(path.dirname(SETTINGS), `orphan-changeforms-${Date.now()}.json`)
    fs.writeFileSync(backup, JSON.stringify(orphans, null, 2))
    const res = await col.deleteMany({ _id: { $in: orphans.map(d => d._id) } })
    console.log(`\nbacked up to ${backup}`)
    console.log(`deleted ${res.deletedCount}, remaining ${await col.countDocuments()}`)
  } finally {
    await client.close()
  }
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1) })
