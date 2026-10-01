'use strict'

// Rebuilds every Morrowind house guild as a territory through the backend API; a member of both Windhelm and House Indoril leaves Windhelm

const fs = require('fs')
const path = require('path')

const USAGE = [
  'usage: node deploy/mongodb/migrate-morrowind-houses.js [mode] [flags]',
  '  plan    read-only (the default): every house guild, the territory it becomes, its ranks, members and clashes',
  '  backup  [--out <file>]',
  '          writes every faction, rank and member roster the backend serves to a JSON file',
  '  apply   --backup <file> [--apply]',
  '          a dry run unless --apply; refuses unless the backup matches the live factions and the plan is safe',
  'the backend (AlduinakBackend, with the J14 code) must run on this machine and server-settings.json must carry masterApiAuthToken',
].join('\n')

const BACKUP_DIR = process.env.ALDUINAK_HOUSES_BACKUP || 'C:\\Users\\Administrator\\Desktop\\alduinak-r13\\rollback-houses'
// The owner's one known double membership: a Windhelm member who belongs in House Indoril
const RELEASE_RULES = [{ house: 'hold:indoril', from: 'hold:eastmarch', label: 'Windhelm (hold:eastmarch)', max: 1 }]
const TYPE = 'hold'

class Refusal extends Error {}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const slotText = slot => (slot === null || slot === undefined ? 'every character' : `character ${Number(slot) + 1}`)
const pathOf = id => '/' + id.split(':').join('/')
const capital = word => word.charAt(0).toUpperCase() + word.slice(1)
const who = m => `${m.playerName || 'Unknown'} (discord ${m.discordId || '?'}, ${slotText(m.slot)})`

// "faction:house-indoril" or a guild named "House Indoril" -> "indoril"
function houseKey(faction) {
  const byId = /^faction:house-([a-z0-9-]+)$/.exec(faction.id)
  if (byId) return byId[1]
  const byName = /^(?:great\s+)?house\s+([a-z0-9][a-z0-9 -]*)$/i.exec(String(faction.name || '').trim())
  return byName ? byName[1].toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''
}

async function call(api, method, subPath, body) {
  const res = await api(method, subPath, body)
  if (!res.ok) {
    const err = new Refusal(`${method} /api/factions${subPath}: ${res.error}`)
    err.status = res.status
    err.data = res.data
    throw err
  }
  return res.data
}

// The live state and what each house would become, asked of the backend as a dry run so its own rules decide
async function makePlan(api) {
  const defs = await call(api, 'GET', '')
  const factions = defs.factions || []
  const houses = []
  const skipped = []
  for (const f of factions) {
    const key = houseKey(f)
    if (!key) continue
    if (f.type === TYPE) { skipped.push(`${f.id} (${f.name}) is already a territory`); continue }
    if (f.province !== 'Morrowind') { skipped.push(`${f.id} (${f.name}) is in ${f.province}, not Morrowind`); continue }
    houses.push({ faction: f, key, to: `${TYPE}:${key}`, group: key.split('-').map(capital).join(' ') })
  }
  for (const house of houses) {
    house.members = (await call(api, 'GET', `${pathOf(house.faction.id)}/members`)).members || []
    try {
      house.report = await call(api, 'POST', `${pathOf(house.faction.id)}/convert`, {
        dryRun: true, rev: house.faction.rev, type: TYPE, group: house.group, name: house.faction.name, expectedMembers: house.faction.members,
      })
    } catch (err) {
      if (err.status === 404 && !(err.data && err.data.error)) {
        throw new Refusal(`the backend has no convert route: restart AlduinakBackend with the J14 code first (${err.message})`)
      }
      house.refusal = err.message
      continue
    }
    const rule = RELEASE_RULES.find(r => r.house === house.report.to)
    house.release = []
    house.unsafe = []
    for (const c of house.report.clashes) {
      if (rule && c.factionId === rule.from) house.release.push(c)
      else house.unsafe.push(`${who(c)} is ${c.rank} of ${c.faction} (${c.factionId}), and a character belongs to one territory; settle it in the Factions tab first`)
    }
    if (rule && house.release.length > rule.max) {
      house.unsafe.push(`${plural(house.release.length, 'member')} of ${house.faction.name} also belong to ${rule.label}, the owner named ${rule.max}; remove the extra by hand first`)
    }
    for (const c of house.release) {
      const slots = house.members.filter(m => m.discordId === c.discordId).map(m => m.slot ?? null)
      if ((c.slot ?? null) !== null || slots.includes(null)) continue
      house.unsafe.push(`${who(c)} is ${c.rank} of ${c.faction}, but in ${house.faction.name} only as ${slots.map(slotText).join(', ')}; removing the row takes the account's other characters out of ${c.faction} too, so give them rows of their own in the Factions tab first`)
    }
  }
  for (const house of houses) {
    const twins = houses.filter(h => h !== house && h.to === house.to)
    if (twins.length && house.unsafe) house.unsafe.push(`${twins.map(h => `${h.faction.id} (${h.faction.name})`).join(', ')} would become ${house.to} too, and only one can; merge or rename them first`)
  }
  return { factions, houses, skipped }
}

function printPlan(plan, out) {
  if (!plan.houses.length) out('no Morrowind house guild is left to convert')
  for (const line of plan.skipped) out(`skip    ${line}`)
  for (const h of plan.houses) {
    const f = h.faction
    out('')
    out(`${f.name}: ${f.id} (${f.type}, ${f.province}, rev ${f.rev}) -> ${h.to} (territory, group "${h.group}", name "${f.name}")`)
    if (h.refusal) { out(`  REFUSED by the backend: ${h.refusal}`); continue }
    if (!h.report.faction.land) out('  no land in Skyrim: no territory border limits its ranks until it is given land')
    out(`  ${plural(h.report.ranks.length, 'rank')}, the same permissions, titles, capacities and order:`)
    const flagsOf = r => ['leader', 'remove', 'craft', 'housing', 'arrest', 'execute', 'factionAccess'].filter(k => r[k]).join(', ') || 'no permissions'
    for (const r of h.report.ranks) {
      const rank = h.report.faction.ranks.find(x => x.id === r.to) || {}
      out(`    ${r.from} -> ${r.to}: ${r.rank} (${flagsOf(rank)}; capacity ${rank.capacity === null || rank.capacity === undefined ? 'open' : rank.capacity}), ${plural(r.members, 'member')}`)
    }
    out(`  ${plural(h.report.moved.length, 'member')} ${h.report.moved.length === 1 ? 'moves' : 'move'} with their rank and join date:`)
    for (const m of h.report.moved) out(`    ${who(m)} as ${m.rank}`)
    if (h.report.faction.regencyEnabled || h.report.faction.regents.length) out(`  regency ${h.report.faction.regencyEnabled ? 'on' : 'off'}, ${plural(h.report.faction.regents.length, 'seat')} kept`)
    for (const c of h.release) out(`  REMOVE from ${c.faction}: ${who(c)}, ${c.rank} (assignment ${c.assignmentId}), so they can be in ${f.name}`)
    for (const line of h.unsafe) out(`  UNSAFE: ${line}`)
    out(`  then ${f.id} and its rank ids are retired for good, and claims, titles and faction doors under ${f.id} follow to ${h.to}`)
  }
  for (const rule of RELEASE_RULES) {
    const house = plan.houses.find(h => h.to === rule.house)
    if (house && house.release && !house.release.length) out(`\nnote: no member of ${house.faction.name} is also in ${rule.label}; nothing to remove there`)
  }
}

const isSafe = plan => plan.houses.every(h => !h.refusal && !h.unsafe.length)

// What apply compares with the backup: every faction's revision, and the rosters of the houses and the factions they clash with
function fingerprint(plan, rosters) {
  return {
    factions: plan.factions.map(f => [f.id, f.rev]).sort(),
    rosters: Object.fromEntries(Object.entries(rosters).sort().map(([id, rows]) => [id, rows.map(m => [m.discordId, m.slot ?? null, m.rankSlug]).sort()])),
  }
}

async function rostersOf(api, ids) {
  const out = {}
  for (const id of ids) out[id] = (await call(api, 'GET', `${pathOf(id)}/members`)).members || []
  return out
}

function involved(plan) {
  return [...new Set(plan.houses.flatMap(h => [h.faction.id, ...((h.report && h.report.clashes) || []).map(c => c.factionId)]))]
}

async function backupMode(api, flags, out) {
  const plan = await makePlan(api)
  const rosters = await rostersOf(api, plan.factions.map(f => f.id))
  const file = flags.out || path.join(BACKUP_DIR, `factions-before-houses-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  if (fs.existsSync(file)) throw new Refusal(`${file} already exists; pick a new --out`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const defs = await call(api, 'GET', '')
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), definitions: defs, rosters, fingerprint: fingerprint(plan, rosters) }, null, 2))
  out(`backup of ${plural(plan.factions.length, 'faction')} and their rosters written to ${file}`)
  out('the backend also keeps the whole factions document as whitelist.bak in MongoDB before each conversion')
  out(`next: node deploy/mongodb/migrate-morrowind-houses.js apply --backup "${file}"`)
}

async function applyMode(api, flags, out) {
  let saved
  try { saved = JSON.parse(fs.readFileSync(flags.backup, 'utf8')) }
  catch (err) { throw new Refusal(`cannot read the backup ${flags.backup} (${err.code || 'not valid JSON'})`) }
  const plan = await makePlan(api)
  printPlan(plan, out)
  const ids = involved(plan)
  const live = fingerprint(plan, await rostersOf(api, ids))
  const then = saved.fingerprint || {}
  const rosterChanged = ids.some(id => JSON.stringify((then.rosters || {})[id]) !== JSON.stringify(live.rosters[id]))
  if (JSON.stringify(then.factions) !== JSON.stringify(live.factions) || rosterChanged) {
    throw new Refusal('the factions changed since the backup was taken (a definition, or the roster of a house or of a territory it clashes with); take a new backup and read the plan again')
  }
  if (!plan.houses.length) return
  if (!isSafe(plan)) throw new Refusal('the plan above is not safe (REFUSED or UNSAFE lines); nothing was changed')
  if (!flags.apply) {
    out(`\n[dry run] the backup matches and the plan is safe; re-run with --apply to convert ${plural(plan.houses.length, 'house')}`)
    return
  }
  for (const h of plan.houses) {
    const result = await call(api, 'POST', `${pathOf(h.faction.id)}/convert`, {
      rev: h.faction.rev, type: TYPE, group: h.group, name: h.faction.name, expectedMembers: h.faction.members, release: h.release.map(c => c.assignmentId),
    })
    out(`converted ${result.from.id} -> ${result.to}: ${plural(result.moved.length, 'member')} moved, ${plural(result.clashes.filter(c => c.released).length, 'row')} removed from other territories`)
  }
  out('\ndone; the game server picks the change up within about 20 seconds, online members reload their ranks on their own')
}

function parseArgs(argv) {
  const args = [...argv]
  const mode = args[0] && !args[0].startsWith('--') ? args.shift() : 'plan'
  const flags = {}
  while (args.length) {
    const a = args.shift()
    if (a === '--apply') flags.apply = true
    else if ((a === '--out' || a === '--backup') && args.length && !args[0].startsWith('--')) flags[a.slice(2)] = args.shift()
    else throw new Refusal(`unknown or incomplete flag ${a}\n${USAGE}`)
  }
  if (!['plan', 'backup', 'apply'].includes(mode)) throw new Refusal(USAGE)
  if (mode === 'apply' && !flags.backup) throw new Refusal(`apply needs --backup <file>; take one with: node deploy/mongodb/migrate-morrowind-houses.js backup\n${USAGE}`)
  if (mode !== 'apply' && (flags.apply || flags.backup)) throw new Refusal(USAGE)
  if (mode !== 'backup' && flags.out) throw new Refusal(USAGE)
  return { mode, flags }
}

async function main(argv, { api, out = console.log } = {}) {
  const { mode, flags } = parseArgs(argv)
  const request = api || require(path.join(__dirname, '..', '..', 'server-manager', 'src', 'backendApi')).factionsRequest
  if (mode === 'backup') return backupMode(request, flags, out)
  if (mode === 'apply') return applyMode(request, flags, out)
  const plan = await makePlan(request)
  printPlan(plan, out)
  out(`\n${isSafe(plan) ? 'plan is safe' : 'plan is NOT safe, apply will refuse'}; next: node deploy/mongodb/migrate-morrowind-houses.js backup`)
}

module.exports = { main, Refusal }

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Refusal ? err.message : err)
    process.exit(err instanceof Refusal ? 2 : 1)
  })
}
