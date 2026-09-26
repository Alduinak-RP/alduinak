'use strict'
// Players tab data: the backend's records and the hours played straight from MongoDB (read only), joined with the characters
// from the changeForms store. Writes to backend records go through the backend API, which is their only writer.

const RACES = {
  0x13740: 'Argonian', 0x13741: 'Breton', 0x13742: 'Dunmer', 0x13743: 'Altmer', 0x13744: 'Imperial',
  0x13745: 'Khajiit', 0x13746: 'Nord', 0x13747: 'Orsimer', 0x13748: 'Redguard', 0x13749: 'Bosmer',
  // Vampire variants
  0x8883a: 'Argonian', 0x8883c: 'Breton', 0x8883d: 'Dunmer', 0x88840: 'Altmer', 0x88844: 'Imperial',
  0x88845: 'Khajiit', 0x88794: 'Nord', 0xa82b9: 'Orsimer', 0x88846: 'Redguard', 0x88884: 'Bosmer',
}
const RACE_NAMES = ['Nord', 'Imperial', 'Redguard', 'Breton', 'Altmer', 'Dunmer', 'Orsimer', 'Bosmer', 'Khajiit', 'Argonian']
const GM_ROLE_ID = '1521259484859863190'
const DEV_ROLE_ID = '1521259396481421475'
const GOLD_BASE_ID = 0xf

const raceOf = raceId => RACES[Number(raceId) >>> 0] || 'Other'
const goldOf = inventory => (inventory || []).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === GOLD_BASE_ID ? Number(e.count) || 0 : 0), 0)

// Every value of a hwid or ip history, including records from before the lists existed
function history(list, latest) {
  const out = Array.isArray(list) ? list.map(e => ({ value: e.value, firstSeen: e.firstSeen || null, lastSeen: e.lastSeen || null })) : []
  if (latest && !out.some(e => e.value === latest)) out.push({ value: latest, firstSeen: null, lastSeen: null })
  return out
}

async function readBackend(settings) {
  const { MongoClient } = require('mongodb')
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    const db = client.db(settings.databaseName || 'skymp')
    const all = name => db.collection(name).find().toArray()
    const [players, profiles, bans, playtime, factions] = await Promise.all(['players', 'profiles', 'bans', 'playtime', 'factions'].map(all))
    return {
      players: new Map(players.map(p => [String(p._id), p])),
      profiles: new Map(profiles.map(p => [String(p._id), Number(p.profileId)])),
      bannedIds: new Set(bans.map(b => String(b._id))),
      playtime: new Map(playtime.map(p => [Number(p._id), p])),
      whitelist: factions.find(f => f._id === 'whitelist') || { factions: [], requirements: [], assignments: [] },
    }
  } finally { await client.close() }
}

// One row per profile: account fields, hours and the characters (with race, gender, gold, profession and time played)
function buildRows(backend, charsByProfile, whitelistRoleId) {
  const rows = []
  for (const [discordId, profileId] of backend.profiles) {
    const p = backend.players.get(discordId) || {}
    const time = backend.playtime.get(profileId) || {}
    const played = time.characters || {}
    const characters = (charsByProfile.get(profileId) || []).map(c => {
      const a = c.appearance || {}
      const t = played[String(c.formDesc).toLowerCase()] || {}
      return {
        ...c,
        race: raceOf(a.raceId),
        female: !!a.isFemale,
        gold: goldOf(c.inventory),
        seconds: t.seconds || 0,
        lastPlayedAt: t.lastPlayedAt || 0,
      }
    })
    const roles = new Set(characters.flatMap(c => c.roles || []))
    const last = characters.reduce((best, c) => (!best || c.lastPlayedAt > best.lastPlayedAt ? c : best), null)
    rows.push({
      profileId,
      discordId,
      name: p.displayName || p.username || `Player ${profileId}`,
      username: p.username || '',
      createdAt: p.createdAt || null,
      lastSeenAt: p.lastSeenAt || (time.lastSeenAt ? new Date(time.lastSeenAt).toISOString() : null),
      seconds: time.seconds || 0,
      banned: backend.bannedIds.has(discordId),
      gm: roles.has(GM_ROLE_ID),
      dev: roles.has(DEV_ROLE_ID),
      whitelisted: !!whitelistRoleId && roles.has(whitelistRoleId),
      ips: history(p.ips, p.lastIp),
      hwids: history(p.hwids, p.hwid),
      gold: characters.reduce((n, c) => n + c.gold, 0),
      lastPlayed: last && last.lastPlayedAt ? last.name : (characters[0] ? characters[0].name : ''),
      characters,
    })
  }
  return rows.sort((a, b) => a.profileId - b.profileId)
}

// The account's faction ranks, named from the definitions
function assignmentsOf(whitelist, discordId) {
  const reqs = new Map((whitelist.requirements || []).map(r => [r.id, r]))
  const factions = new Map((whitelist.factions || []).map(f => [f.id, f]))
  return (whitelist.assignments || []).filter(a => a.discordId === discordId).map(a => {
    const req = reqs.get(a.requirementId) || {}
    const factionId = String(a.requirementId).split(':').slice(0, 2).join(':')
    const faction = factions.get(factionId) || {}
    return { id: a.id, requirementId: a.requirementId, slot: a.slot ?? null, faction: faction.name || req.group || factionId, rank: req.rank || a.requirementId }
  })
}

// Faction and rank choices for the character popup
function factionChoices(whitelist) {
  const ranks = (whitelist.requirements || []).filter(r => r && r.id)
  return (whitelist.factions || []).map(f => ({
    id: f.id,
    name: f.name || f.id,
    ranks: ranks.filter(r => r.id.startsWith(f.id + ':')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(r => ({ id: r.id, rank: r.rank || r.id })),
  }))
}

const HOUR_BRACKETS = [[0, 1, 'Under 1 hour'], [1, 4, '1 to 3 hours'], [4, 12, '4 to 11'], [12, 24, '12 to 23'], [24, 48, '24 to 47'], [48, 128, '48 to 127'], [128, 400, '128 to 399'], [400, 1200, '400 to 1199'], [1200, Infinity, '1200+']]
const GOLD_BRACKETS = [[0, 50, 'Under 50 gold'], [50, 500, '50 to 499'], [500, 5000, '500 to 4999'], [5000, 50001, '5000 to 50000'], [50001, Infinity, 'Over 50000']]

function stats(rows) {
  const count = (list, key) => list.reduce((m, x) => (m[key(x)] = (m[key(x)] || 0) + 1, m), {})
  const bracket = (value, brackets) => brackets.find(([lo, hi]) => value >= lo && value < hi)[2]
  const chars = rows.flatMap(r => r.characters.filter(c => !c.fallen))
  const wealth = rows.reduce((n, r) => n + r.gold, 0)
  return {
    players: rows.length,
    characters: chars.length,
    races: count(chars, c => c.race),
    genders: count(chars, c => (c.female ? 'Female' : 'Male')),
    professions: count(chars, c => c.profession || 'None'),
    hours: count(rows, r => bracket(r.seconds / 3600, HOUR_BRACKETS)),
    hourOrder: HOUR_BRACKETS.map(b => b[2]),
    totalWealth: wealth,
    averageWealth: rows.length ? Math.round(wealth / rows.length) : 0,
    wealth: count(rows, r => bracket(r.gold, GOLD_BRACKETS)),
    wealthOrder: GOLD_BRACKETS.map(b => b[2]),
  }
}

module.exports = { RACE_NAMES, readBackend, buildRows, assignmentsOf, factionChoices, stats }
