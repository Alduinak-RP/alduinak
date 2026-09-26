'use strict'

// One-time move of the backend's JSON records into MongoDB. Stop the backend first: it is the only writer.
//   node scripts/import-json-to-mongo.js           dry run: what would be imported
//   node scripts/import-json-to-mongo.js --apply   imports into empty collections; a collection that already holds documents is skipped
// The JSON files are left in place as a backup.

const fs   = require('fs')
const path = require('path')
const db   = require('../sources/db')

const DATA  = path.join(__dirname, '..', 'data')
const apply = process.argv.includes('--apply')

function read(file) {
  const p = path.join(DATA, file)
  if (!fs.existsSync(p)) return undefined
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// collection -> { file, docs(json) -> { id: doc }, meta? }
const SOURCES = {
  players:    { file: 'players.json',    docs: json => json },
  profiles:   { file: 'profiles.json',   docs: json => Object.fromEntries(Object.entries(json.map || {}).map(([discordId, profileId]) => [discordId, { profileId }])) },
  bans:       { file: 'bans.json',       docs: json => Object.fromEntries(json.map(entry => [String(entry.discordId), entry])) },
  characters: { file: 'characters.json', docs: json => json },
  sessions:   { file: 'sessions.json',   docs: json => Object.fromEntries(json.filter(([, s]) => s.expiresAt > Date.now())) },
  authStates: { file: 'auth-states.json', docs: json => Object.fromEntries(json.filter(([, s]) => s.expiresAt > Date.now())) },
  balances:   { file: 'balances.json',   docs: json => Object.fromEntries(Object.entries(json).map(([profileId, balance]) => [profileId, { balance }])) },
  factions:   { file: 'faction-whitelist.json', docs: json => ({ whitelist: json }) },
}

async function main() {
  await db.init()
  for (const [name, src] of Object.entries(SOURCES)) {
    const json = read(src.file)
    if (json === undefined) { console.log(`${name}: no ${src.file}, nothing to import`); continue }
    const store = db.store(name)
    const docs = src.docs(json)
    if (store.size) { console.log(`${name}: already holds ${store.size} document(s), skipped`); continue }
    console.log(`${name}: ${Object.keys(docs).length} document(s) from ${src.file}${apply ? '' : ' (dry run)'}`)
    if (apply) store.replaceAll(docs)
  }
  const profiles = read('profiles.json')
  if (profiles && Number.isInteger(profiles.nextId) && !db.store('meta').has('profiles')) {
    console.log(`meta: next profile id ${profiles.nextId}${apply ? '' : ' (dry run)'}`)
    if (apply) db.store('meta').set('profiles', { nextId: profiles.nextId })
  }
  await db.close()
  console.log(apply ? 'import done' : 'dry run done; add --apply to import')
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
