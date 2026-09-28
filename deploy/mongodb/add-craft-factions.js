'use strict'

// Creates the craft factions the proficiency patcher gates gear on but the backend does not define yet, each with a Leader and a Member rank that may craft

const path = require('path')

const { factionsRequest } = require(path.join(__dirname, '..', '..', 'server-manager', 'src', 'backendApi'))

const USAGE = [
  'usage: node deploy/mongodb/add-craft-factions.js [--apply]',
  '  a dry run by default: lists the factions and ranks it would create through the backend API (/api/factions)',
  '  --apply creates them; the backend must be running on this machine and server-settings.json must carry masterApiAuthToken',
].join('\n')

// id must match the patcher's factions.list id (or its alias in factionCraftSystem.ts); group slugs to the id's second part
const FACTIONS = [
  { id: 'faction:skaal', group: 'Skaal', name: 'The Skaal', type: 'guild' },
  { id: 'faction:blades', group: 'Blades', name: 'The Blades', type: 'military' },
  { id: 'faction:silver-hand', group: 'Silver Hand', name: 'The Silver Hand', type: 'military' },
  { id: 'faction:camonna-tong', group: 'Camonna Tong', name: 'Camonna Tong', type: 'guild' },
  { id: 'faction:psijic', group: 'Psijic', name: 'The Psijic Order', type: 'guild' },
  { id: 'faction:mythic-dawn', group: 'Mythic Dawn', name: 'Mythic Dawn', type: 'guild' },
  { id: 'faction:greybeards', group: 'Greybeards', name: 'The Greybeards', type: 'guild' },
  // A hold court must be one of the nine holds, so the Great Houses are guilds; factionCraftSystem maps them to the hold:<house> markers
  { id: 'faction:house-redoran', group: 'House Redoran', name: 'House Redoran', type: 'guild' },
  { id: 'faction:house-indoril', group: 'House Indoril', name: 'House Indoril', type: 'guild' },
  { id: 'faction:house-telvanni', group: 'House Telvanni', name: 'House Telvanni', type: 'guild' },
]

const RANKS = [
  { rank: 'Leader', leader: true, craft: true },
  { rank: 'Member', craft: true },
]

const pathOf = id => '/' + id.split(':').join('/')

async function call(method, subPath, body) {
  const res = await factionsRequest(method, subPath, body)
  if (!res.ok) throw new Error(`${method} /api/factions${subPath}: ${res.error}`)
  return res.data
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(a => a !== '--apply')) {
    console.error(USAGE)
    process.exit(2)
  }
  const apply = args.includes('--apply')
  const live = await call('GET', '')
  const have = new Set((live.factions || []).map(f => f.id))
  const missing = FACTIONS.filter(f => !have.has(f.id))
  for (const f of FACTIONS.filter(f => have.has(f.id))) console.log(`exists  ${f.id}`)
  for (const f of missing) console.log(`${apply ? 'create' : 'would create'}  ${f.id} (${f.type}, "${f.name}") ranks ${RANKS.map(r => r.rank).join(', ')}`)
  if (!apply) {
    console.log(`dry run: ${missing.length} faction(s) missing; pass --apply to create them`)
    return
  }
  for (const f of missing) {
    let { faction } = await call('POST', '', { type: f.type, group: f.group, name: f.name })
    if (faction.id !== f.id) throw new Error(`${f.group} became ${faction.id}, not ${f.id}; delete it in the Factions tab and fix the group name`)
    for (const r of RANKS) ({ faction } = await call('POST', `${pathOf(f.id)}/ranks`, { ...r, rev: faction.rev }))
    console.log(`created ${f.id} with ${faction.ranks.map(r => r.rank).join(', ')}`)
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
