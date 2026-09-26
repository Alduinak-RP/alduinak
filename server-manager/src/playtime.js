'use strict'
// Hours played, counted from a game server log when it is archived at the next server start (and once per log, by its first line and size).
// A session runs from "Server Login: Server Slot N ... Master API P" to "disconnect N"; "PartOne::SetUserActor N <actor>" says which character.
// Sessions still open at a server boot or at the end of the log end at the last line seen before it.
// MongoDB playtime: { _id: profileId, seconds, lastSeenAt, characters: { <actor hex>: { seconds, lastPlayedAt } } }

const fs = require('fs')
const readline = require('readline')

const STAMP_RE  = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\]/
const LOGIN_RE  = /Server Login: Server Slot (\d+),.*Master API (\d+)/
const ACTOR_RE  = /PartOne::SetUserActor (\d+) ([0-9a-f]+)/
const LEAVE_RE  = /\] disconnect (\d+)\s*$/
const BOOT_RE   = /QueueSystem: \d+ play slots/

function stampOf(line) {
  const m = STAMP_RE.exec(line)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() : null
}

// { profileId: { seconds, lastSeenAt, characters: { actor: { seconds, lastPlayedAt } } } } for one log
async function parseLog(file) {
  const totals = {}
  const open = new Map()   // slot -> { profileId, since, actor, actorSince }
  let last = null
  let first = null

  const charTime = (s, until) => {
    if (!s.actor || s.actor === '0') return
    const t = totals[s.profileId].characters[s.actor] ||= { seconds: 0, lastPlayedAt: 0 }
    t.seconds += Math.max(0, until - s.actorSince) / 1000
    t.lastPlayedAt = Math.max(t.lastPlayedAt, until)
  }
  const close = (slot, until) => {
    const s = open.get(slot)
    if (!s) return
    open.delete(slot)
    const t = totals[s.profileId]
    t.seconds += Math.max(0, until - s.since) / 1000
    t.lastSeenAt = Math.max(t.lastSeenAt, until)
    charTime(s, until)
  }
  const closeAll = until => { for (const slot of [...open.keys()]) close(slot, until) }

  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (first === null && line) first = line
    const at = stampOf(line)
    if (at === null) continue
    if (BOOT_RE.test(line)) { closeAll(last ?? at); last = at; continue }
    let m
    if ((m = LOGIN_RE.exec(line))) {
      const slot = m[1]
      close(slot, at)
      const profileId = m[2]
      totals[profileId] ||= { seconds: 0, lastSeenAt: 0, characters: {} }
      open.set(slot, { profileId, since: at, actor: null, actorSince: at })
    } else if ((m = ACTOR_RE.exec(line))) {
      const s = open.get(m[1])
      if (s && s.actor !== m[2]) {
        charTime(s, at)
        s.actor = m[2]
        s.actorSince = at
      }
    } else if ((m = LEAVE_RE.exec(line))) {
      close(m[1], at)
    }
    last = at
  }
  if (last !== null) closeAll(last)
  return { totals, first: first || '' }
}

async function withDb(settings, fn) {
  const { MongoClient } = require('mongodb')
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    return await fn(client.db(settings.databaseName || 'skymp'))
  } finally { await client.close() }
}

// Adds one log's sessions to the totals; returns the number of profiles touched, or 0 when the log was counted before
async function addFromLog(file, settings) {
  if (settings.databaseDriver !== 'mongodb' || !settings.databaseUri) return 0
  let size
  try { size = fs.statSync(file).size } catch { return 0 }
  if (!size) return 0
  const { totals, first } = await parseLog(file)
  const key = `${first.slice(0, 64)}|${size}`
  return withDb(settings, async db => {
    const counted = db.collection('playtimeLogs')
    if (await counted.findOne({ _id: key })) return 0
    const ops = Object.entries(totals).map(([profileId, t]) => {
      const inc = { seconds: Math.round(t.seconds) }
      const max = { lastSeenAt: t.lastSeenAt }
      for (const [actor, c] of Object.entries(t.characters)) {
        inc[`characters.${actor}.seconds`] = Math.round(c.seconds)
        max[`characters.${actor}.lastPlayedAt`] = c.lastPlayedAt
      }
      return { updateOne: { filter: { _id: Number(profileId) }, update: { $inc: inc, $max: max }, upsert: true } }
    })
    if (ops.length) await db.collection('playtime').bulkWrite(ops, { ordered: false })
    await counted.insertOne({ _id: key, file, countedAt: new Date() })
    return ops.length
  })
}

async function readAll(settings) {
  if (settings.databaseDriver !== 'mongodb' || !settings.databaseUri) return new Map()
  return withDb(settings, async db => new Map((await db.collection('playtime').find().toArray()).map(d => [Number(d._id), d])))
}

module.exports = { parseLog, addFromLog, readAll }

// Backfill from archived logs, once: node src/playtime.js <gameserver log>...
if (require.main === module) {
  const { readSettingsFile } = require('./modsync')
  const config = require('./config')
  const settings = readSettingsFile(config.paths.serverSettings).settings
  ;(async () => {
    for (const file of process.argv.slice(2)) console.log(`${file}: ${await addFromLog(file, settings)} profile(s) updated`)
  })().catch(err => { console.error(err.message); process.exit(1) })
}
