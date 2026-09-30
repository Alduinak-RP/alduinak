'use strict'

// Gives back what strip-inventories.js took beyond ebony gear, spell tomes, learned spells, Falmer chest armour and jewelry, never twice and never taking anything

const fs = require('fs')
const path = require('path')
const S = require('./strip-common')

const formIds = require(path.join(S.SM, 'formIds'))
const modsync = require(path.join(S.SM, 'modsync'))
const { gameServerBlocker } = require(path.join(S.SM, 'serviceCheck'))
const { Refusal, UsageError, plural, hex, sha256, arr, stamp, writeNew, canonical, nameOf, planDoc, ownerLabel, DOCS_FILE } = S

const USAGE = [
  'usage: node deploy/mongodb/restore-stripped-items.js [mode] [flags]',
  '  preview [--report <file>]',
  '          offline, no database: what comes back if nothing was returned since the strip (the upper bound)',
  '  plan    [--report <file>]',
  '          read-only (the default): reads the live documents, writes a report and a text summary beside it',
  '  backup  [--out <dir>]',
  '          dump every changeForm the apply would change',
  '  apply   --backup <dir> [--apply]',
  '          a dry run unless --apply; refuses unless the game server is stopped and the backup matches the live documents',
  '  restore --backup <dir> [--apply] [--skip-changed]',
  '          roll an apply back to the backed up inventories; a dry run unless --apply; --skip-changed leaves the documents changed since as they are',
  'all but restore also take [--strip <strip backup dir>] [--intent <strip-intent.json>] [--strip-plan <strip-inventories-plan-*.json>]',
  "  [--also-keep '0x...,0x...'] (keep these removed base ids removed too) [--also-give '0x...,0x...'] (return these although the intent keeps them; never spells)",
  "  [--ignore-held '0x...,0x...'] (give these ids back in full: a copy held now was crafted, looted or bought, not returned)",
  '  [--per-document] (count returns per document only, not across the characters and claimed containers of a profile)',
  '  ids are hex with 0x; quote a list in PowerShell, and give each flag once',
].join('\n')

const STRIP_DIR = process.env.ALDUINAK_STRIP_BACKUP || 'C:\\Users\\Administrator\\Desktop\\alduinak-r13\\rollback-strip'
const RESTORE_ROOT = process.env.ALDUINAK_RESTORE_ROOT || 'C:\\Users\\Administrator\\Desktop\\alduinak-r13\\restore-strip'
const INTENT_FILE = path.join(__dirname, 'strip-intent.json')
const INFO_FILE = 'restore-backup.json'
const APPLIED_FILE = 'restore-applied.json'
const ROLLED_BACK_FILE = 'restore-applied.rolled-back.json'
const LOG_FILE = 'restore-applied.log'
const ROLLED_BACK_LOG = 'restore-applied.rolled-back.log'
const INTENTS = { ebony: 'ebony equipment', 'spell tome': 'spell tomes', 'falmer cuirass': 'Falmer chest armour', jewelry: 'jewelry' }
const JEWELRY_KINDS = { ring: 'rings', necklace: 'necklaces/amulets', circlet: 'circlets', earrings: 'earrings', other: 'other jewelry' }
const GROUPS = { jewelry: 'jewelry', scroll: 'scrolls', enchanted: 'enchanted gear', staff: 'staves', 'spell tome': 'spell tomes', 'enchanted entry': 'player-enchanted gear' }
const WORN = ['worn', 'wornLeft']
const OVERRIDES = { alsoKeep: '--also-keep', alsoGive: '--also-give', ignoreHeld: '--ignore-held' }
const PETS_PROP = 'private.pets'

function readJson(file, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (err) { throw new Refusal(`cannot read ${what} ${file} (${err.code || 'not valid JSON'})`) }
}

// PowerShell 5.1 hands an unquoted comma list of 0x ids to node as decimals, so the prefix is required
function idList(text, flag) {
  const ids = new Set()
  for (const s of String(text || '').split(',').map(x => x.trim()).filter(Boolean)) {
    if (!/^0x[0-9a-f]{1,8}$/i.test(s)) throw new UsageError(`${flag} takes hex base ids with 0x such as 0x0002AC61, not ${s}; quote a list: ${flag} '0x000139BF,0x0002AC61'`)
    ids.add(parseInt(s, 16) >>> 0)
  }
  return ids
}

function checkRemoved(ids, flag, classes) {
  const bad = [...ids].filter(id => !classes.has(id))
  if (bad.length) throw new UsageError(`${flag} ${bad.map(hex).join(', ')}: not an item the strip removed`)
}

function byHex(obj) { return new Map(Object.entries(obj || {}).map(([k, v]) => [parseInt(k, 16) >>> 0, v])) }

// The Data folder must still hold what the intent was read from: the same light flags (the backup's form ids) and the same plugins behind the removed items
async function checkPlugins(raw, settings, file) {
  const again = 'run python deploy/mongodb/strip-intent.py to sort the removed items again from the plugins as they are now, then take a new backup'
  if (!settings.dataDir) throw new Refusal('server-settings.json has no dataDir, so the plugins behind strip-intent.json cannot be checked')
  if (!raw.sourceSha256 || arr(raw.plugins).some(p => !p.sha256)) throw new Refusal(`${file} carries no plugin hashes: ${again}`)
  const flags = modsync.readPluginFlags(raw.plugins.map(p => p.name), { dataDir: settings.dataDir })
  const missing = raw.plugins.filter(p => typeof flags[p.name].light !== 'boolean').map(p => p.name)
  if (missing.length) throw new Refusal(`cannot read ${missing.join(', ')} in ${settings.dataDir}`)
  const flipped = raw.plugins.filter(p => (flags[p.name].light || /[.]esl$/i.test(p.name)) !== p.light)
  if (flipped.length) throw new Refusal(`the light flag of ${flipped.map(p => p.name).join(', ')} changed since the strip, so the backup's form ids no longer mean the same records`)
  const changed = []
  for (const [name, sha] of Object.entries(raw.sourceSha256)) {
    if (await modsync.sha256File(path.join(settings.dataDir, name)).catch(() => null) !== sha) changed.push(name)
  }
  if (changed.length) throw new Refusal(`${changed.join(', ')} changed since ${file} was made: ${again}`)
}

// The strip's list as far as the backup touches it, with the owner's intent per base id (strip-intent.py)
async function loadIntent(file, info, settings) {
  const raw = readJson(file, 'intent file')
  if (raw.docsSha256 !== info.docsSha256) throw new Refusal(`${file} was made for another strip backup, run strip-intent.py for this one`)
  if (raw.listSha256 !== info.listSha256) throw new Refusal(`${file} was made from another forbidden-items.json than the one the strip ran with`)
  if (Boolean(raw.factionGear) !== Boolean(info.factionGear)) throw new Refusal(`${file} disagrees with the backup about --faction-gear`)
  S.checkOrder(raw.stripLoadOrder, settings, file, true)
  await checkPlugins(raw, settings, file)
  const classes = byHex(raw.items)
  const list = { sha: raw.listSha256, slots: S.slotsOf(raw.plugins), items: new Map([...classes].filter(([, v]) => v.listed)), spells: byHex(raw.spells) }
  return { file, sha: sha256(fs.readFileSync(file)), classes, list }
}

// The strip's own plan report: the newest one made with the same list before the backup, unless named
function loadStripPlan(file, info) {
  let chosen = file
  if (!chosen) {
    const names = fs.existsSync(S.BACKUP_ROOT) ? fs.readdirSync(S.BACKUP_ROOT).filter(n => /^strip-inventories-plan-.+\.json$/.test(n)).sort().reverse() : []
    chosen = names.map(n => path.join(S.BACKUP_ROOT, n)).find(f => {
      const r = readJson(f, 'strip plan report')
      return r.list && r.list.sha256 === info.listSha256 && String(r.createdAt) <= String(info.createdAt)
    })
    if (!chosen) throw new Refusal(`no strip-inventories-plan-*.json in ${S.BACKUP_ROOT} was made with this strip's list, pass --strip-plan <file>`)
  }
  const r = readJson(chosen, 'strip plan report')
  if (!r.list || r.list.sha256 !== info.listSha256 || r.databaseName !== info.databaseName) throw new Refusal(`${chosen} is not a plan of this strip`)
  return { file: chosen, holders: new Map(arr(r.holders).map(h => [h.formDesc, h])) }
}

// The last event per document in an apply's write log (writing, wrote, not written, rolling back, rolled back); null when the apply never started writing
function readLog(dir) {
  const file = path.join(dir, LOG_FILE)
  if (!fs.existsSync(file)) return null
  const last = new Map()
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^(writing|wrote|not written|rolling back|rolled back) (\S+)$/.exec(l.trim())
    if (m) last.set(m[2], m[1])
  }
  return last
}

function appendLog(dir, event, id) {
  const fd = fs.openSync(path.join(dir, LOG_FILE), 'a')
  try {
    fs.writeSync(fd, `${event} ${id}\n`)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

// Apply records of this strip's restore that were not rolled back, with their write logs
function earlierApplies(stripSha) {
  const out = []
  if (!fs.existsSync(RESTORE_ROOT)) return out
  for (const d of fs.readdirSync(RESTORE_ROOT)) {
    const dir = path.join(RESTORE_ROOT, d)
    const file = path.join(dir, APPLIED_FILE)
    if (!fs.existsSync(file)) continue
    const rec = readJson(file, 'apply record')
    if (rec.stripDocsSha256 === stripSha) out.push({ dir, rec, log: readLog(dir) })
  }
  return out
}

const NO_EARLIER = { byDoc: new Map(), summaries: [] }

// The base ids each earlier apply settled per document it reached; a document it or its rollback was writing when it stopped is judged by its inventory now
function resolveEarlier(records, live, settings) {
  const byDoc = new Map()
  const summaries = []
  for (const { dir, rec, log } of records) {
    const sum = { dir, createdAt: rec.createdAt, writes: 0, written: 0, unsure: [] }
    let pre = null
    for (const d of arr(rec.docs)) {
      let reached = true
      if (d.write) {
        sum.writes++
        const ev = log ? log.get(d.id) : 'writing'
        if (ev === 'writing' || ev === 'rolling back') {
          pre = pre || new Map(S.readBackup(dir, settings, INFO_FILE).docs.map(x => [String(x._id), x]))
          const now = live.get(d.id)
          const items = now && itemsSha(now.inv && now.inv.entries)
          const before = pre.get(d.id)
          if (items !== d.itemsSha256 && now && before && items === itemsSha(before.inv && before.inv.entries)) reached = false
          else if (items !== d.itemsSha256) sum.unsure.push(d.who)
        } else reached = ev === 'wrote'
        if (reached) sum.written++
      }
      if (!reached) continue
      const settled = byDoc.get(d.id) || new Set()
      for (const id of arr(d.settled)) settled.add(parseInt(id, 16) >>> 0)
      byDoc.set(d.id, settled)
    }
    summaries.push(sum)
  }
  return { byDoc, summaries }
}

async function loadInputs(flags, settings) {
  const ov = Object.fromEntries(Object.entries(OVERRIDES).map(([k, flag]) => [k, idList(flags[k], flag)]))
  const keep = ov.alsoKeep
  const give = ov.alsoGive
  const both = [...keep].filter(id => give.has(id))
  if (both.length) throw new UsageError(`${both.map(hex).join(', ')} is in both --also-keep and --also-give`)
  const dir = path.resolve(flags.strip || STRIP_DIR)
  const strip = S.readBackup(dir, settings)
  const intent = await loadIntent(path.resolve(flags.intent || INTENT_FILE), strip.info, settings)
  for (const [k, flag] of Object.entries(OVERRIDES)) checkRemoved(ov[k], flag, intent.classes)
  const stripPlan = loadStripPlan(flags.stripPlan && path.resolve(flags.stripPlan), strip.info)
  const { purge, BSON } = S.requireDriver()
  return { dir, strip, intent, stripPlan, keep, give, ignore: ov.ignoreHeld, settings, records: earlierApplies(strip.info.docsSha256), earlier: NO_EARLIER, isPlayer: purge.isPlayer, BSON, owners: null, profiles: null, actors: null, pool: !flags.perDocument }
}

// ── The restore rule ─────────────────────────────────────────────────────────

function idOf(e) { return formIds.num(e.baseId) >>> 0 }
function countOf(e) { return formIds.num(e.count) || 1 }
function totalOf(entries, id) { return entries.reduce((n, e) => n + (idOf(e) === id ? countOf(e) : 0), 0) }
function isWorn(e) { return Boolean(e.worn || e.wornLeft) }

function plain(v) {
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') {
    if (v._bsontype) return Number.isNaN(formIds.num(v)) ? String(v) : formIds.num(v)
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, plain(v[k])]))
  }
  return v
}

// Blind to entry order and number types, so a re-save that changes only those still matches
function itemsSha(entries) { return sha256(JSON.stringify(arr(entries).map(e => JSON.stringify(plain(e))).sort())) }

// An entry's identity without its count and worn state: enchantment, tempering, poison, charge, name and the rest
function variantOf(e) {
  const rest = { ...e }
  for (const k of ['count', ...WORN]) delete rest[k]
  return JSON.stringify(plain(rest))
}

// Adds n of the group's base id from the backup's own entries, variants the document lacks first; only appends or raises counts
function giveEntries(next, g, n, BSON) {
  const have = new Set(next.filter(e => idOf(e) === g.baseId).map(variantOf))
  const order = [...g.entries.filter(e => !have.has(variantOf(e))), ...g.entries.filter(e => have.has(variantOf(e)))]
  let variants = 0
  for (const e of order) {
    if (!n) break
    const k = Math.min(n, countOf(e))
    n -= k
    variants++
    const key = variantOf(e)
    const i = next.findIndex(x => idOf(x) === g.baseId && !isWorn(x) && variantOf(x) === key)
    if (i >= 0) { next[i] = { ...next[i], count: new BSON.Int32(countOf(next[i]) + k) }; continue }
    const copy = BSON.EJSON.parse(canonical(e), { relaxed: false })
    for (const w of WORN) delete copy[w]
    next.push({ ...copy, count: new BSON.Int32(k) })
  }
  return variants
}

function groupOf(reason, cls) {
  if (cls && cls.staff) return GROUPS.staff
  if (reason === 'material') return `material: ${(cls && cls.material) || '?'}`
  if (reason === 'rank') return `above Adept (${(cls && cls.rank) || '?'} recipe)`
  return GROUPS[reason] || reason
}

// The strip plan names a container "<formDesc> (<baseDesc>) of <owner> (profile <n>)", and formDescs can hold " of " themselves
function stripOwnerOf(holder, doc) {
  const prefix = `${doc.formDesc} (${doc.baseDesc || '?'}) of `
  const m = holder && holder.who.startsWith(prefix) && /^(.*) \(profile (-?\d+)\)$/.exec(holder.who.slice(prefix.length))
  return m ? { name: m[1], profile: Number(m[2]) } : null
}

function statusOf(doc, live, row, ctx) {
  if (!live) return 'the document no longer exists'
  if (live.formDesc !== doc.formDesc) return `the document is now ${live.formDesc}`
  if (row.kind === 'character') {
    if (live.isDeleted) return 'the character was deleted'
    if (formIds.num(live.profileId) !== formIds.num(doc.profileId)) return `the character now belongs to profile ${formIds.num(live.profileId)}`
    return 'ok'
  }
  if (!row.owner) return 'the strip plan report does not name the container owner'
  if (!ctx.owners) return 'ok'
  const now = ctx.owners.get(doc.formDesc)
  if (!now) return `the housing claim of ${ownerLabel(row.owner)} is gone`
  if (now.profile !== row.owner.profile) return `the claim changed hands: ${ownerLabel(row.owner)} then, ${ownerLabel(now)} now`
  return 'ok'
}

function sameRemoval(p, holder) {
  const mine = p.removed.map(e => `${hex(e.baseId)}x${e.count}:${e.reason}`).join(',')
  const theirs = arr(holder.removed).map(e => `${e.baseId}x${e.count}:${e.reason}`).join(',')
  return mine === theirs && p.spells.length === arr(holder.spells).length
}

// One strip backup document against its live copy (null when gone): what it lost and how much of each base id it would get back on its own
function assess(doc, live, ctx) {
  const { list, classes } = ctx.intent
  const p = planDoc(doc, list) || { removed: [], spells: [] }
  const holder = ctx.stripPlan.holders.get(doc.formDesc)
  const kind = ctx.isPlayer(doc) ? 'character' : 'container'
  const owner = kind === 'container' ? stripOwnerOf(holder, doc) : null
  const who = kind === 'character'
    ? `${nameOf(doc) || '?'} (character ${doc.formDesc}, profile ${formIds.num(doc.profileId)})`
    : `container ${doc.formDesc} (${doc.baseDesc || '?'}) of ${owner ? ownerLabel(owner) : '?'}`
  const profile = kind === 'character' ? formIds.num(doc.profileId) : owner ? owner.profile : null
  const row = { kind, who, formDesc: doc.formDesc, id: String(doc._id), owner, profile, give: [], back: [], stays: [], skipped: [], wants: [], spells: p.spells, problems: [], live, set: null }
  if (!holder) row.problems.push('not in the strip plan report')
  else if (!sameRemoval(p, holder)) row.problems.push('the strip plan report lists other removals than the strip rule gives for the backup')
  row.status = statusOf(doc, live, row, ctx)

  const groups = new Map()
  for (const r of p.removed) {
    const g = groups.get(r.baseId) || { baseId: r.baseId, edid: r.edid, reason: r.reason, entries: [], removed: 0 }
    g.entries.push(r.entry)
    g.removed += r.count
    groups.set(r.baseId, g)
  }
  const backupEntries = heldEntries(doc, null)
  const liveEntries = live ? heldEntries(live, ctx.actors) : []
  const settled = ctx.earlier.byDoc.get(row.id) || new Set()
  for (const g of groups.values()) {
    const cls = classes.get(g.baseId)
    const base = { baseId: hex(g.baseId), edid: (cls && cls.edid) || g.edid, name: (cls && cls.name) || '', craftable: Boolean(cls && cls.craftable), group: groupOf(g.reason, cls), removed: g.removed }
    if (!cls || cls.intent === 'unknown') { row.skipped.push({ ...base, count: g.removed, unclassified: true, why: `cannot classify: ${cls ? cls.evidence : 'not in the intent file'}` }); continue }
    const kept = ctx.give.has(g.baseId) ? '' : cls.intent ? INTENTS[cls.intent] : ctx.keep.has(g.baseId) ? 'kept by --also-keep' : ''
    if (kept) { row.stays.push({ ...base, count: g.removed, why: kept, evidence: cls.evidence || '', ...(cls.jewelry && { jewelry: cls.jewelry }) }); continue }
    if (row.status !== 'ok') { row.skipped.push({ ...base, count: g.removed, why: row.status }); continue }
    const current = totalOf(liveEntries, g.baseId)
    const counted = ctx.ignore.has(g.baseId) ? 0 : current
    const done = settled.has(g.baseId)
    const want = done ? 0 : Math.max(0, Math.min(g.removed, totalOf(backupEntries, g.baseId) - counted))
    row.wants.push({ g, base, current, done, want, elsewhere: 0 })
  }
  return row
}

// The pets a character keeps (private.pets), with the form description of each one out in the world
function petsOf(doc) {
  const rec = doc && doc.dynamicFields && doc.dynamicFields[PETS_PROP]
  return arr(rec && rec.list).filter(p => p && typeof p === 'object').map(p => {
    const actorId = formIds.num(p.actorId) >>> 0
    return { pet: p, actorDesc: actorId >>> 24 === 0xFF ? formIds.descOf(actorId, null) : null }
  })
}

// What a document holds: its inventory and, for a character, its pets' saddlebags (an active pet's actor when it is in actors, else its stored copy)
function heldEntries(doc, actors) {
  const pets = petsOf(doc).flatMap(({ pet, actorDesc }) => {
    const actor = actors && actorDesc ? actors.get(actorDesc) : null
    return arr(actor ? actor.inv && actor.inv.entries : pet.inventory && pet.inventory.entries)
  })
  return [...arr(doc && doc.inv && doc.inv.entries), ...pets]
}

// Listed base ids held now per profile, over its characters, their pets and the containers it claims (the strip left none of them there)
function profileTotals(targets, list, actors) {
  const out = new Map()
  const add = (profile, entries) => {
    const m = out.get(profile) || out.set(profile, new Map()).get(profile)
    for (const e of entries) if (list.items.has(idOf(e))) m.set(idOf(e), (m.get(idOf(e)) || 0) + countOf(e))
  }
  for (const d of targets.players) if (!d.isDeleted) add(formIds.num(d.profileId), heldEntries(d, actors))
  for (const c of targets.containers) add(c.profile, arr(c.doc.inv && c.doc.inv.entries))
  return out
}

// A profile never gets more of a listed base id back than it lost less what it holds anywhere now, so a return put in a chest or on another character counts too
function capByProfile(rows, ctx) {
  if (!ctx.profiles) return
  const pools = new Map()
  for (const r of rows) {
    if (r.status !== 'ok' || r.profile === null) continue
    for (const w of r.wants) {
      if (!ctx.intent.list.items.has(w.g.baseId) || ctx.ignore.has(w.g.baseId)) continue
      const key = `${r.profile}|${w.g.baseId}`
      pools.set(key, [...(pools.get(key) || []), { w, profile: r.profile }])
    }
  }
  for (const ws of pools.values()) {
    const held = (ctx.profiles.get(ws[0].profile) || new Map()).get(ws[0].w.g.baseId) || 0
    let left = Math.max(0, ws.reduce((n, x) => n + x.w.g.removed, 0) - held)
    for (const { w } of ws) {
      const k = Math.min(w.want, left)
      w.elsewhere = w.want - k
      w.want = k
      left -= k
    }
  }
}

function giveRow(row, ctx) {
  const next = row.live ? arr(row.live.inv && row.live.inv.entries).slice() : []
  for (const w of row.wants) {
    const back = w.g.removed - w.want
    if (back) row.back.push({ ...w.base, count: back, current: w.current, byEarlierRestore: w.done ? back : 0, elsewhere: w.elsewhere })
    if (w.want) row.give.push({ ...w.base, count: w.want, variants: giveEntries(next, w.g, w.want, ctx.BSON) })
  }
  row.decided = row.wants.filter(w => !w.done).map(w => w.base.baseId)
  delete row.wants
  if (row.give.length) row.set = { 'inv.entries': next }
  return row
}

// Strip backup documents paired with their live copies: what comes back, what is already back, what stays removed
function restoreRows(pairs, ctx) {
  const rows = pairs.map(({ doc, live }) => assess(doc, live, ctx))
  capByProfile(rows, ctx)
  return rows.map(r => giveRow(r, ctx))
}

// The document right after the strip, standing in for the live one when there is no database
function stripped(doc, list) {
  const p = planDoc(doc, list)
  return p && p.set['inv.entries'] ? { ...doc, inv: { ...doc.inv, entries: p.set['inv.entries'] } } : doc
}

// ── Reports ──────────────────────────────────────────────────────────────────

function sum(items) { return items.reduce((n, x) => n + x.count, 0) }

function tally(into, g, key, holder) {
  const s = into[key] || (into[key] = { items: 0, entries: 0, holders: new Set(), ids: new Map() })
  s.items += g.count
  s.entries++
  s.holders.add(holder)
  const x = s.ids.get(g.baseId) || s.ids.set(g.baseId, { baseId: g.baseId, edid: g.edid, name: g.name, count: 0 }).get(g.baseId)
  x.count += g.count
}

function label(g) { return g.name ? `${g.edid} "${g.name}"` : g.edid }

function totalsOf(rows) {
  const t = { characters: 0, containers: 0, receiving: 0, give: {}, stays: {}, jewelry: {}, back: 0, backCraftable: 0, earlier: 0, elsewhere: 0, skipped: 0, skippedDocs: 0, unclassified: 0, spells: 0, problems: 0 }
  for (const r of rows) {
    t[r.kind === 'character' ? 'characters' : 'containers']++
    if (r.give.length) t.receiving++
    for (const g of r.give) tally(t.give, g, g.group, r.formDesc)
    for (const g of r.stays) tally(t.stays, g, g.why, r.formDesc)
    for (const g of r.stays.filter(g => g.why === INTENTS.jewelry)) t.jewelry[g.jewelry || 'other'] = (t.jewelry[g.jewelry || 'other'] || 0) + g.count
    t.back += sum(r.back)
    t.backCraftable += sum(r.back.filter(g => g.craftable))
    t.earlier += r.back.reduce((n, x) => n + x.byEarlierRestore, 0)
    t.elsewhere += r.back.reduce((n, x) => n + x.elsewhere, 0)
    t.skipped += sum(r.skipped.filter(g => !g.unclassified))
    t.unclassified += sum(r.skipped.filter(g => g.unclassified))
    if (r.status !== 'ok') t.skippedDocs++
    t.spells += r.spells.length
    t.problems += r.problems.length
  }
  const flat = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1].items - a[1].items).map(([k, v]) => [k, { items: v.items, entries: v.entries, holders: v.holders.size, ids: [...v.ids.values()].sort((a, b) => b.count - a.count) }]))
  return { ...t, give: flat(t.give), stays: flat(t.stays), giveItems: Object.values(t.give).reduce((n, v) => n + v.items, 0), stayItems: Object.values(t.stays).reduce((n, v) => n + v.items, 0) }
}

// Removed ids whose classification the owner may want to overrule
function decisionsOf(rows, ctx) {
  const out = new Map()
  for (const r of rows) {
    const seen = new Map([...r.give, ...r.back, ...r.stays, ...r.skipped].map(g => [g.baseId, g]))
    for (const g of seen.values()) {
      const cls = ctx.intent.classes.get(parseInt(g.baseId, 16) >>> 0)
      if (!cls || !cls.note) continue
      const id = parseInt(g.baseId, 16) >>> 0
      const stays = !ctx.give.has(id) && (Boolean(cls.intent) || ctx.keep.has(id))
      const d = out.get(g.baseId) || { baseId: g.baseId, edid: g.edid, name: cls.name || '', intent: cls.intent, kind: cls.noteKind || '', note: cls.note, stays, count: 0, holders: 0 }
      d.count += g.removed
      d.holders++
      out.set(g.baseId, d)
    }
  }
  return [...out.values()]
}

function line(items, fmt) { return items.map(fmt).join(', ') }

function render(title, rows, t, meta) {
  const L = [title, '']
  L.push(`strip backup ${meta.strip} (${meta.stripCreatedAt}, ${plural(rows.length, 'document', 'documents')}, database ${meta.databaseName})`)
  L.push(`intent ${meta.intent} (list ${meta.listSha256.slice(0, 12)})`)
  L.push(`strip plan report ${meta.stripPlan}: the strip rule reproduces it for ${meta.reproduced} of ${rows.length} documents`)
  L.push(meta.poolByProfile ? "returns count per document and across each profile (its characters, their pets and its claimed containers)" : 'returns count per document only (--per-document)')
  L.push(`earlier applies are looked for in ${meta.restoreRoot}`)
  for (const r of meta.earlier) {
    L.push(`an earlier restore was applied ${r.createdAt} (${r.dir}): it wrote ${r.written} of ${plural(r.writes, 'document', 'documents')}${r.writes > r.written ? `, the ${r.writes - r.written} it never wrote are planned again` : ''}; what it settled is not given again`)
    for (const who of r.unsure) L.push(`  ! it stopped while writing ${who}, whose inventory changed since: counted as given, check it by hand`)
  }
  const given = Object.entries(OVERRIDES).filter(([k]) => meta[k].length)
  L.push(`overrides: ${given.map(([k, flag]) => `${flag} ${meta[k].join(',')}`).join('  ') || 'none'}`)
  L.push('', 'TOTALS')
  L.push(`  holders: ${plural(t.characters, 'character', 'characters')} and ${plural(t.containers, 'container', 'containers')}; ${t.receiving} get items back`)
  L.push(`  comes back: ${plural(t.giveItems, 'item', 'items')} (items / entries / holders)`)
  for (const [k, v] of Object.entries(t.give)) {
    L.push(`    ${k.padEnd(34)} ${String(v.items).padStart(5)} / ${String(v.entries).padStart(4)} / ${v.holders}`)
    const word = k.startsWith('material: ') && k.slice('material: '.length)
    if (word && v.ids.some(x => !`${x.edid} ${x.name}`.toLowerCase().includes(word))) L.push(`      the ${word} material keyword is on: ${line(v.ids, x => `${label(x)} x${x.count}`)}`)
  }
  L.push(`  counted as back, not given: ${plural(t.back, 'item', 'items')}${t.earlier ? `, ${t.earlier} of them settled by an earlier restore` : ''}${t.elsewhere ? `, ${t.elsewhere} held elsewhere on the same profile` : ''}${t.backCraftable ? `, ${t.backCraftable} of craftable ids` : ''}`)
  L.push(`    a copy held now in ${meta.poolByProfile ? "the profile's characters, their pets or its claimed containers" : "the document or a character's pets"} counts as returned, also one crafted,`)
  L.push("    looted or bought since the strip (--ignore-held '0x...' gives an id back in full); a return since sold, used, dropped,")
  L.push('    given away, or left in an unclaimed chest or on a deleted character is not seen and comes back again')
  L.push(`  stays removed: ${plural(t.stayItems, 'item', 'items')} (items / entries / holders)`)
  for (const [k, v] of Object.entries(t.stays)) L.push(`    ${k.padEnd(34)} ${String(v.items).padStart(5)} / ${String(v.entries).padStart(4)} / ${v.holders}`)
  L.push(`    ${'learned spells (never restored)'.padEnd(34)} ${String(t.spells).padStart(5)}`)
  const jewels = Object.keys(JEWELRY_KINDS).filter(k => t.jewelry[k])
  if (jewels.length) {
    L.push(`  jewelry: stays removed, ${plural(t.stays[INTENTS.jewelry].items, 'item', 'items')}: ${line(jewels, k => `${JEWELRY_KINDS[k]} ${t.jewelry[k]}`)} (--also-give '0x...' returns an id)`)
    L.push(`    --also-give '${t.stays[INTENTS.jewelry].ids.map(x => x.baseId).sort().join(',')}' returns all of it`)
  }
  L.push(`  not given: ${plural(t.skipped, 'item', 'items')} in ${plural(t.skippedDocs, 'document', 'documents')} since gone, deleted or changed hands`)
  L.push(`  cannot classify, not given: ${plural(t.unclassified, 'item', 'items')}`)
  if (t.problems) L.push(`  PROBLEMS: ${t.problems} (see the holders marked !); apply refuses until they are resolved`)
  if (meta.decisions.length) {
    L.push('', 'FOR THE OWNER TO DECIDE')
    const recipe = meta.decisions.filter(d => d.kind === 'ebony recipe' && !d.stays)
    for (const d of meta.decisions.filter(d => !recipe.includes(d))) {
      const now = d.stays
        ? d.intent ? `stays removed as ${INTENTS[d.intent]}; --also-give ${d.baseId} returns it` : 'stays removed by --also-keep'
        : d.intent ? 'comes back by --also-give' : `comes back; --also-keep ${d.baseId} keeps it removed`
      L.push(`  ${label(d)} ${d.baseId} (${d.note}), ${d.count} removed from ${plural(d.holders, 'holder', 'holders')}: ${now}`)
    }
    if (recipe.length) {
      L.push(`  Gear whose recipe takes ebony ingots but that carries no ebony material keyword comes back, ${plural(recipe.reduce((n, d) => n + d.count, 0), 'item', 'items')}:`)
      for (const d of recipe) L.push(`    ${label(d)} ${d.baseId}, ${d.count} removed from ${plural(d.holders, 'holder', 'holders')}: ${d.note}`)
      L.push(`    --also-keep '${recipe.map(d => d.baseId).join(',')}' keeps all of them removed`)
    }
  }
  L.push('', 'PER HOLDER')
  for (const r of rows) {
    L.push(`${r.problems.length ? '! ' : ''}${r.who}${r.status === 'ok' ? '' : ` [skipped: ${r.status}]`}`)
    for (const p of r.problems) L.push(`  ! ${p}`)
    if (r.give.length) L.push(`  comes back: ${line(r.give, g => `${g.edid} x${g.count} [${g.group}]`)}`)
    if (r.back.length) L.push(`  counted as back: ${line(r.back, g => `${g.edid} x${g.count} (holds ${g.current}${g.elsewhere ? `, ${g.elsewhere} held elsewhere on the profile` : ''}${g.craftable ? ', craftable' : ''})`)}`)
    if (r.stays.length) L.push(`  stays removed: ${line(r.stays, g => `${label(g)} x${g.count} [${g.why}]`)}`)
    if (r.skipped.length) L.push(`  not given: ${line(r.skipped, g => `${g.edid} x${g.count} [${g.group}]`)}`)
    if (r.spells.length) L.push(`  learned spells stay removed: ${line(r.spells, s => s.edid)}`)
  }
  return L.join('\n') + '\n'
}

function reportOf(mode, rows, t, meta) {
  return {
    createdAt: new Date().toISOString(), mode, ...meta, totals: t,
    holders: rows.map(r => ({
      kind: r.kind, who: r.who, formDesc: r.formDesc, id: r.id, status: r.status, problems: r.problems,
      give: r.give, back: r.back, stays: r.stays, skipped: r.skipped,
      spells: r.spells.map(s => ({ id: hex(s.id), edid: s.edid, kind: s.kind })),
    })),
  }
}

function metaOf(ctx, settings, rows) {
  return {
    databaseName: settings.databaseName, strip: ctx.dir, stripCreatedAt: ctx.strip.info.createdAt, stripDocsSha256: ctx.strip.info.docsSha256,
    listSha256: ctx.strip.info.listSha256, intent: ctx.intent.file, intentSha256: ctx.intent.sha, stripPlan: ctx.stripPlan.file,
    reproduced: rows.filter(r => !r.problems.length).length, restoreRoot: path.resolve(RESTORE_ROOT), earlier: ctx.earlier.summaries,
    ...overridesOf(ctx), poolByProfile: ctx.pool, decisions: decisionsOf(rows, ctx),
  }
}

function writeReport(file, mode, rows, ctx, settings, log) {
  const t = totalsOf(rows)
  const meta = metaOf(ctx, settings, rows)
  const title = mode === 'preview'
    ? 'PREVIEW (no database): what the strip took that comes back if nothing was returned since, the upper bound plan lowers by returns'
    : `RESTORE ${mode.toUpperCase()} against the live documents`
  const text = render(title, rows, t, meta)
  log(text)
  const json = path.resolve(file || path.join(RESTORE_ROOT, `restore-${mode}-${stamp()}.json`))
  const txt = json.replace(/\.json$/i, '') + '.txt'
  writeNew(json, JSON.stringify(reportOf(mode, rows, t, meta), null, 1))
  writeNew(txt, text)
  log(`report: ${json}\nsummary: ${txt}`)
  return { t, meta, json, txt }
}

// ── Modes ────────────────────────────────────────────────────────────────────

async function liveRows(col, ctx) {
  const ids = ctx.strip.docs.map(d => d._id)
  const live = new Map()
  for await (const doc of col.find({ _id: { $in: ids } }, { promoteValues: false })) live.set(String(doc._id), doc)
  ctx.earlier = resolveEarlier(ctx.records, live, ctx.settings)
  const targets = await S.findTargets(col, ctx.intent.list, true)
  ctx.owners = targets.owned
  const descs = [...new Set(targets.players.flatMap(d => petsOf(d).map(p => p.actorDesc).filter(Boolean)))]
  ctx.actors = new Map()
  if (descs.length) for await (const doc of col.find({ formDesc: { $in: descs } }, { promoteValues: false })) ctx.actors.set(doc.formDesc, doc)
  ctx.profiles = ctx.pool ? profileTotals(targets, ctx.intent.list, ctx.actors) : null
  return restoreRows(ctx.strip.docs.map(doc => ({ doc, live: live.get(String(doc._id)) || null })), ctx)
}

function previewMode(flags, ctx, env) {
  const rows = restoreRows(ctx.strip.docs.map(doc => ({ doc, live: stripped(doc, ctx.intent.list) })), ctx)
  writeReport(flags.report, 'preview', rows, ctx, env.settings, env.log)
  env.log('nothing was read from or written to the database')
}

async function planMode(flags, ctx, env) {
  await S.withCol(env.settings, async col => {
    const rows = await liveRows(col, ctx)
    writeReport(flags.report, 'plan', rows, ctx, env.settings, env.log)
    env.log('nothing was written to the database')
  }, env.open)
}

// A filter that matches only while the stored entries are still exactly the ones read
function unchanged(doc) {
  const e = doc.inv && doc.inv.entries
  return { _id: doc._id, formDesc: doc.formDesc, 'inv.entries': Array.isArray(e) ? e : null }
}

function overridesOf(ctx) { return { alsoKeep: [...ctx.keep].map(hex), alsoGive: [...ctx.give].map(hex), ignoreHeld: [...ctx.ignore].map(hex) } }

function infoMatches(info, ctx) {
  const same = (a, b) => [...arr(a)].sort().join(',') === [...b].sort().join(',')
  const mine = overridesOf(ctx)
  const said = Object.entries(OVERRIDES).map(([k, flag]) => `${flag} ${arr(info[k]).join(',') || '(none)'}`).join(' ')
  if (info.stripDocsSha256 !== ctx.strip.info.docsSha256) throw new Refusal('the backup belongs to another strip backup')
  if (info.intentSha256 !== ctx.intent.sha) throw new Refusal('strip-intent.json changed since the backup, take a new one')
  if (info.poolByProfile !== ctx.pool) throw new Refusal(`the backup was taken ${info.poolByProfile ? 'without' : 'with'} --per-document, pass the same`)
  if (Object.keys(OVERRIDES).some(k => !same(info[k], mine[k]))) throw new Refusal(`the backup was taken with ${said}, pass the same`)
}

// Apply records are looked up only in the folders directly under RESTORE_ROOT
function restoreDir(given) {
  const dir = path.resolve(given)
  if (path.dirname(dir).toLowerCase() !== path.resolve(RESTORE_ROOT).toLowerCase()) throw new Refusal(`${dir} is not directly under ${RESTORE_ROOT}: keep restore backups there and apply or roll them back from there, so later runs find their apply records`)
  return dir
}

async function backupMode(flags, ctx, env) {
  const dir = restoreDir(flags.out || path.join(RESTORE_ROOT, `rollback-${stamp()}`))
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Refusal(`${dir} is not empty`)
  await S.withCol(env.settings, async col => {
    const rows = (await liveRows(col, ctx)).filter(r => r.set)
    const text = ctx.BSON.EJSON.stringify(rows.map(r => r.live), { relaxed: false })
    writeNew(path.join(dir, DOCS_FILE), text)
    const info = {
      createdAt: new Date().toISOString(), databaseName: env.settings.databaseName, stripDocsSha256: ctx.strip.info.docsSha256, intentSha256: ctx.intent.sha,
      ...overridesOf(ctx), poolByProfile: ctx.pool, count: rows.length, docsSha256: sha256(text), ids: rows.map(r => r.id),
    }
    writeNew(path.join(dir, INFO_FILE), JSON.stringify(info, null, 1))
    env.log(`backed up ${plural(rows.length, 'changeForm', 'changeForms')} to ${dir}`)
  }, env.open)
}

async function applyMode(flags, ctx, env) {
  const dir = restoreDir(flags.backup)
  const { info, docs } = S.readBackup(dir, env.settings, INFO_FILE)
  infoMatches(info, ctx)
  if (fs.existsSync(path.join(dir, APPLIED_FILE))) throw new Refusal(`${dir} was already applied, take a new backup`)
  const blocker = await env.blocker()
  await S.withCol(env.settings, async col => {
    const all = await liveRows(col, ctx)
    const rows = all.filter(r => r.set)
    const backed = new Map(docs.map(d => [String(d._id), canonical(d)]))
    const problems = all.filter(r => r.problems.length).map(r => `${r.who}: ${r.problems.join('; ')}`)
    for (const r of rows) {
      const saved = backed.get(r.id)
      if (!saved) problems.push(`${r.who} is not in the backup`)
      else if (saved !== canonical(r.live)) problems.push(`${r.who} changed since the backup`)
    }
    if (rows.length !== docs.length) problems.push(`the apply changes ${rows.length} documents, the backup holds ${docs.length}`)
    const t = totalsOf(all)
    env.log(render(`RESTORE APPLY${flags.apply ? '' : ' (dry run)'}`, all, t, metaOf(ctx, env.settings, all)))
    if (problems.length) throw new Refusal(`the backup does not match the live documents, take a new one:\n  ${problems.slice(0, 20).join('\n  ')}`)
    if (!flags.apply) {
      env.log(`[dry run] backup ${dir} matches; ${blocker ? `apply would refuse: ${blocker}` : `re-run with --apply to give back ${plural(t.giveItems, 'item', 'items')} to ${t.receiving} holders`}`)
      return
    }
    const late = blocker || await env.blocker()
    if (late) throw new Refusal(late)
    // Every base id decided for a document is settled once the apply reaches it, even where nothing was given
    const record = {
      createdAt: new Date().toISOString(), stripDocsSha256: ctx.strip.info.docsSha256, backup: dir,
      docs: all.filter(r => r.decided && r.decided.length).map(r => ({
        id: r.id, formDesc: r.formDesc, who: r.who, write: Boolean(r.set),
        ...(r.set ? { entriesSha256: sha256(canonical(r.set['inv.entries'])), itemsSha256: itemsSha(r.set['inv.entries']) } : {}),
        given: r.give.map(g => ({ baseId: g.baseId, edid: g.edid, count: g.count })), settled: r.decided,
      })),
    }
    writeNew(path.join(dir, APPLIED_FILE), JSON.stringify(record, null, 1))
    const undo = `node deploy/mongodb/restore-stripped-items.js restore --backup "${dir}" --apply`
    for (const r of rows) {
      appendLog(dir, 'writing', r.id)
      const res = await col.updateOne(unchanged(r.live), { $set: r.set }).catch(err => { throw new Error(`${err.message}; stopped part way, roll back with: ${undo}`) })
      if (res.matchedCount !== 1) {
        appendLog(dir, 'not written', r.id)
        throw new Error(`${r.who} changed after it was read, nothing written to it; stopped part way, roll back with: ${undo}`)
      }
      appendLog(dir, 'wrote', r.id)
    }
    const wrote = new Map(record.docs.filter(d => d.write).map(d => [d.id, d.entriesSha256]))
    const bad = []
    for await (const doc of col.find({ _id: { $in: rows.map(r => r.live._id) } }, { promoteValues: false })) {
      if (sha256(canonical(arr(doc.inv && doc.inv.entries))) !== wrote.get(String(doc._id))) bad.push(doc.formDesc)
    }
    if (bad.length) throw new Error(`the inventories read back differ from what was written for ${bad.join(', ')}`)
    env.log(`\ngave back ${plural(t.giveItems, 'item', 'items')} to ${plural(rows.length, 'document', 'documents')}; roll back with: ${undo}`)
  }, env.open)
}

// Puts the backed up inventories back where they still hold what the apply wrote (in any entry order and number types); ones it never wrote are left alone
async function rollbackMode(flags, env) {
  const dir = restoreDir(flags.backup)
  const { docs } = S.readBackup(dir, env.settings, INFO_FILE)
  const recFile = path.join(dir, APPLIED_FILE)
  if (!fs.existsSync(recFile)) throw new Refusal(`${dir} has no ${APPLIED_FILE}: it was never applied (or was rolled back already)`)
  const rec = new Map(arr(readJson(recFile, 'apply record').docs).map(d => [d.id, d]))
  const log = readLog(dir)
  const blocker = flags.apply ? await env.blocker() : null
  if (blocker) throw new Refusal(blocker)
  await S.withCol(env.settings, async col => {
    const live = new Map()
    for await (const doc of col.find({ _id: { $in: docs.map(d => d._id) } }, { promoteValues: false })) live.set(String(doc._id), doc)
    const changed = []
    const undo = []
    for (const d of docs) {
      const id = String(d._id)
      const r = rec.get(id)
      if (!r || !r.write || !['writing', 'wrote', 'rolling back'].includes(log ? log.get(id) : 'writing')) continue
      const now = live.get(id)
      const items = now && itemsSha(now.inv && now.inv.entries)
      if (items === r.itemsSha256) undo.push({ id, d, now })
      else if (!now || items !== itemsSha(d.inv && d.inv.entries)) changed.push(`${d.formDesc} ${r.who}: ${now ? 'its inventory changed since the apply' : 'the document no longer exists'}`)
    }
    env.log(`${plural(undo.length, 'document', 'documents')} of ${docs.length} in ${dir} hold what the apply wrote${changed.length ? `, ${changed.length} changed since` : ''}`)
    if (changed.length && !flags.skipChanged) throw new Refusal(`rolling back would lose changes made after the apply:\n  ${changed.slice(0, 20).join('\n  ')}\n--skip-changed rolls back the others and leaves these as they are, keeping what the apply gave`)
    if (changed.length) env.log(`left as they are, keeping what the apply gave:\n  ${changed.join('\n  ')}`)
    if (!flags.apply) { env.log('[dry run] re-run with --apply to put the backed up inventories back'); return }
    if (!log) for (const r of rec.values()) if (r.write) appendLog(dir, 'writing', r.id)
    for (const { id, d, now } of undo) {
      appendLog(dir, 'rolling back', id)
      const res = await col.updateOne(unchanged(now), { $set: { 'inv.entries': arr(d.inv && d.inv.entries) } })
      if (res.matchedCount !== 1) {
        appendLog(dir, 'wrote', id)
        throw new Error(`${d.formDesc} changed after it was read, nothing written to it; stopped part way`)
      }
      appendLog(dir, 'rolled back', id)
    }
    if (!changed.length) {
      fs.renameSync(recFile, path.join(dir, ROLLED_BACK_FILE))
      if (fs.existsSync(path.join(dir, LOG_FILE))) fs.renameSync(path.join(dir, LOG_FILE), path.join(dir, ROLLED_BACK_LOG))
    }
    env.log(`rolled back ${plural(undo.length, 'document', 'documents')}${changed.length ? `; the apply record stays for the ${changed.length} left as they are` : ''}`)
  }, env.open)
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const INPUTS = ['strip', 'intent', 'stripPlan', 'alsoKeep', 'alsoGive', 'ignoreHeld', 'perDocument']
const ARGS = {
  defaultMode: 'plan',
  bools: { '--apply': 'apply', '--per-document': 'perDocument', '--skip-changed': 'skipChanged' },
  valued: { '--out': 'out', '--backup': 'backup', '--report': 'report', '--strip': 'strip', '--intent': 'intent', '--strip-plan': 'stripPlan', '--also-keep': 'alsoKeep', '--also-give': 'alsoGive', '--ignore-held': 'ignoreHeld' },
  allowed: {
    preview: ['report', ...INPUTS],
    plan: ['report', ...INPUTS],
    backup: ['out', ...INPUTS],
    apply: ['backup', 'apply', ...INPUTS],
    restore: ['backup', 'apply', 'skipChanged'],
  },
  required: { apply: ['--backup'], restore: ['--backup'] },
}

// deps: open (a changeForms opener), blocker (the game server check) and log, for tests
async function run(argv, deps = {}) {
  const log = deps.log || (s => console.log(s))
  if (argv.includes('--help') || argv.includes('-h')) { log(USAGE); return }
  const { mode, flags } = S.parseArgs(argv, ARGS)
  const env = { settings: S.loadSettings(), open: deps.open, blocker: deps.blocker || gameServerBlocker, log }
  S.requireDriver()
  if (mode === 'restore') return rollbackMode(flags, env)
  const ctx = await loadInputs(flags, env.settings)
  if (mode === 'preview') return previewMode(flags, ctx, env)
  await { plan: planMode, backup: backupMode, apply: applyMode }[mode](flags, ctx, env)
}

if (require.main === module) S.runCli(() => run(process.argv.slice(2)), USAGE)

module.exports = { run, restoreRows, variantOf, USAGE }
