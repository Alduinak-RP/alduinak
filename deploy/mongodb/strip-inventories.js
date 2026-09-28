'use strict'

// One-time strip of gear above Adept, jewelry, tomes, scrolls, staves, enchanted gear and learned spells from characters and claimed containers

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SM = path.join(__dirname, '..', '..', 'server-manager', 'src')
const config = require(path.join(SM, 'config'))
const formIds = require(path.join(SM, 'formIds'))
const modsync = require(path.join(SM, 'modsync'))
const { gameServerBlocker } = require(path.join(SM, 'serviceCheck'))

const USAGE = [
  'usage: node deploy/mongodb/strip-inventories.js [mode] [flags]',
  '  plan    [--list <forbidden-items.json>] [--report <file>] [--no-containers] [--faction-gear]',
  '          read-only (the default): counts per reason, per character summary, writes a report file',
  '  backup  [--out <dir>] [--list <file>] [--no-containers] [--faction-gear]',
  '          dump every changeForm the strip would change',
  '  apply   --backup <dir> [--apply] [--list <file>] [--no-containers] [--faction-gear]',
  '          a dry run unless --apply; refuses unless the game server is stopped and the backup matches the live documents',
  '  restore --backup <dir> [--apply]',
  '          put the backed up documents back; a dry run unless --apply',
  '--faction-gear also strips faction uniforms whose recipe needs a rank above Adept (kept by default)',
  'the list comes from: python deploy/mongodb/forbidden-items.py --plugin <staged AlduinakAdditions.esp>',
].join('\n')

const CF = 'changeForms'
const LIST_FILE = path.join(__dirname, 'forbidden-items.json')
const BACKUP_ROOT = process.env.ALDUINAK_WIPE_BACKUP_ROOT || 'C:\\Users\\Administrator\\Desktop\\alduinak-overnight-2026-09-11'
const INFO_FILE = 'strip-backup.json'
const DOCS_FILE = 'changeforms.ejson'
const HOUSING_PROP = 'private.housing'
const SPELL_SLOTS = ['leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell']
const TOP = 25

class Refusal extends Error {}
class UsageError extends Error {}

let settings = null
let purge = null
let BSON = null

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }
function hex(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0') }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex') }
function arr(v) { return Array.isArray(v) ? v : [] }

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function loadSettings() {
  let s
  try { ({ settings: s } = modsync.readSettingsFile(config.paths.serverSettings)) }
  catch (err) { throw new Refusal(`cannot read ${config.paths.serverSettings}: ${err.code || err.message}`) }
  if (s.databaseDriver !== 'mongodb') throw new Refusal(`databaseDriver is "${s.databaseDriver}", this script only handles mongodb`)
  if (!s.databaseUri || !s.databaseName) throw new Refusal('server-settings.json needs databaseUri and databaseName')
  return s
}

// The driver ships with server-manager, so it loads only after npm install there
function requireDriver() {
  try {
    purge = require(path.join(SM, 'mongoPurge'))
    BSON = require(require.resolve('mongodb', { paths: [SM] })).BSON
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && /'mongodb'/.test(err.message)) throw new Refusal('mongodb driver not found: run npm install in server-manager (or set NODE_PATH to its node_modules)')
    throw err
  }
}

// The list is only valid for the load order it was computed against
function loadList(file, factionGear) {
  let list
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (err) { throw new Refusal(`cannot read ${file} (${err.code || 'not valid JSON'}): run deploy/mongodb/forbidden-items.py first`) }
  const live = arr(settings.loadOrder).map(n => modsync.basename(n).toLowerCase())
  const theirs = arr(list.loadOrder).map(n => String(n).toLowerCase())
  if (live.join('|') !== theirs.join('|')) throw new Refusal(`${file} was computed for another load order, run forbidden-items.py again`)
  const slots = formIds.computeSlots(list.plugins.map(p => p.name), Object.fromEntries(list.plugins.map(p => [p.name, p.light])))
  const items = new Map(list.items.filter(i => factionGear || !i.factionGear).map(i => [i.globalId >>> 0, i]))
  const spells = new Map(list.spells.map(s => [s.globalId >>> 0, s]))
  return { file, sha: sha256(fs.readFileSync(file)), factionGear, slots, items, spells, replacedPlugin: list.replacedPlugin }
}

async function withCol(fn) {
  const { client, col } = await purge.openChangeForms(settings)
  try { return await fn(col) } finally { await client.close().catch(() => {}) }
}

function housingOf(doc) {
  const rec = doc.dynamicFields && doc.dynamicFields[HOUSING_PROP]
  return rec && typeof rec === 'object' && formIds.num(rec.owner) > 0 ? rec : null
}

// Players, and containers of a live housing claim (the claimed ref itself and its listed containers)
async function findTargets(col, list, withContainers) {
  const players = []
  const claims = []
  const owned = new Map()
  for await (const doc of col.find({}, { promoteValues: false })) {
    if (purge.isPlayer(doc)) players.push(doc)
    else if (withContainers) {
      const rec = housingOf(doc)
      if (!rec) continue
      claims.push(doc)
      const owner = `${rec.ownerName || '?'} (profile ${formIds.num(rec.owner)})`
      owned.set(doc.formDesc, owner)
      for (const id of arr(rec.containers)) {
        const desc = formIds.descOf(id, list.slots)
        if (desc) owned.set(desc, owner)
      }
    }
  }
  const containers = []
  if (withContainers && owned.size) {
    for await (const doc of col.find({ formDesc: { $in: [...owned.keys()] } }, { promoteValues: false })) {
      if (!purge.isPlayer(doc) && arr(doc.inv && doc.inv.entries).length) containers.push({ doc, owner: owned.get(doc.formDesc) })
    }
  }
  return { players, containers, claims: claims.length }
}

function entryReason(e, list) {
  const item = list.items.get(formIds.num(e.baseId) >>> 0)
  if (item) return item
  if (e.enchantmentId !== undefined && e.enchantmentId !== null) return { reason: 'enchanted entry', edid: '' }
  return null
}

// What the strip changes in one document; null when nothing
function planDoc(doc, list) {
  const removed = []
  const keep = arr(doc.inv && doc.inv.entries).filter(e => {
    const hit = entryReason(e, list)
    if (hit) removed.push({ baseId: formIds.num(e.baseId) >>> 0, count: formIds.num(e.count) || 1, reason: hit.reason, edid: hit.edid || e.name || '' })
    return !hit
  })
  const eq = doc.equipmentDump
  const eqEntries = arr(eq && eq.inv && eq.inv.entries)
  const eqKeep = eqEntries.filter(e => !entryReason(e, list))
  const spells = []
  const spellKeep = arr(doc.learnedSpells).filter(id => {
    const s = list.spells.get(formIds.num(id) >>> 0)
    if (s) spells.push({ id: formIds.num(id) >>> 0, edid: s.edid, kind: s.kind })
    return !s
  })
  const gone = new Set(spells.map(s => s.id))
  const slots = eq ? SPELL_SLOTS.filter(k => {
    const v = formIds.num(eq[k]) >>> 0
    return v && (gone.has(v) || list.items.has(v))
  }) : []
  if (!removed.length && !spells.length && eqKeep.length === eqEntries.length && !slots.length) return null
  const set = {}
  if (removed.length) set['inv.entries'] = keep
  if (eqKeep.length !== eqEntries.length) set['equipmentDump.inv.entries'] = eqKeep
  if (spells.length) set.learnedSpells = spellKeep
  for (const k of slots) set[`equipmentDump.${k}`] = new BSON.Int32(0)
  return { removed, spells, unequipped: eqEntries.length - eqKeep.length, slots, set }
}

function nameOf(doc) {
  return doc.appearanceDump && typeof doc.appearanceDump.name === 'string' ? doc.appearanceDump.name : ''
}

async function buildPlan(col, list, withContainers) {
  const t = await findTargets(col, list, withContainers)
  const rows = []
  for (const doc of t.players) {
    const p = planDoc(doc, list)
    if (p) rows.push({ kind: 'character', who: `${doc.formDesc} "${nameOf(doc)}" (profile ${formIds.num(doc.profileId)})`, doc, ...p })
  }
  for (const { doc, owner } of t.containers) {
    const p = planDoc(doc, list)
    if (p && (p.removed.length || p.unequipped)) rows.push({ kind: 'container', who: `${doc.formDesc} (${doc.baseDesc || '?'}) of ${owner}`, doc, ...p })
  }
  return { rows, players: t.players.length, containers: t.containers.length, claims: t.claims }
}

function summarize(plan) {
  const reasons = {}
  const edids = new Map()
  const spellKinds = {}
  const spellEdids = new Map()
  for (const r of plan.rows) {
    for (const e of r.removed) {
      const s = reasons[e.reason] || (reasons[e.reason] = { entries: 0, items: 0, holders: new Set() })
      s.entries++
      s.items += e.count
      s.holders.add(r.doc.formDesc)
      const k = `${e.edid || hex(e.baseId)} [${e.reason}]`
      edids.set(k, (edids.get(k) || 0) + e.count)
    }
    for (const s of r.spells) {
      spellKinds[s.kind] = (spellKinds[s.kind] || 0) + 1
      spellEdids.set(s.edid, (spellEdids.get(s.edid) || 0) + 1)
    }
  }
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)
  return {
    reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, { entries: v.entries, items: v.items, holders: v.holders.size }])),
    spells: spellKinds,
    topItems: top(edids),
    topSpells: top(spellEdids),
  }
}

function printPlan(plan, list) {
  const chars = plan.rows.filter(r => r.kind === 'character')
  const conts = plan.rows.filter(r => r.kind === 'container')
  const sum = summarize(plan)
  console.log(`list ${list.file} (${list.items.size} items, ${list.spells.size} spells, sha256 ${list.sha.slice(0, 12)})`)
  console.log(`scanned ${plural(plan.players, 'character', 'characters')}, ${plural(plan.containers, 'claimed container', 'claimed containers')} with items (${plural(plan.claims, 'claim', 'claims')})`)
  console.log(`would change ${plural(chars.length, 'character', 'characters')} and ${plural(conts.length, 'container', 'containers')}`)
  console.log('\nremoved per reason (inventory entries / items / holders):')
  for (const [k, v] of Object.entries(sum.reasons).sort((a, b) => b[1].items - a[1].items)) console.log(`  ${k.padEnd(16)} ${String(v.entries).padStart(5)} / ${String(v.items).padStart(6)} / ${v.holders}`)
  console.log(`learned spells removed: ${Object.entries(sum.spells).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} (abilities, such as the rank and faction markers, stay)`)
  console.log('\ntop items:')
  for (const [k, v] of sum.topItems) console.log(`  ${String(v).padStart(6)}  ${k}`)
  console.log('\ntop spells:')
  for (const [k, v] of sum.topSpells) console.log(`  ${String(v).padStart(6)}  ${k}`)
  console.log('\nper holder:')
  for (const r of plan.rows) {
    const n = r.removed.reduce((a, e) => a + e.count, 0)
    console.log(`  ${r.who}: ${plural(n, 'item', 'items')} in ${plural(r.removed.length, 'entry', 'entries')}, ${plural(r.spells.length, 'spell', 'spells')}, ${r.unequipped} equipmentDump entries${r.slots.length ? `, cleared ${r.slots.join(' ')}` : ''}`)
  }
  return sum
}

function reportOf(plan, list, sum) {
  return {
    createdAt: new Date().toISOString(),
    databaseName: settings.databaseName,
    list: { file: list.file, sha256: list.sha, replacedPlugin: list.replacedPlugin, factionGear: list.factionGear },
    scanned: { characters: plan.players, containers: plan.containers, claims: plan.claims },
    summary: sum,
    holders: plan.rows.map(r => ({
      kind: r.kind, who: r.who, formDesc: r.doc.formDesc,
      removed: r.removed.map(e => ({ baseId: hex(e.baseId), edid: e.edid, count: e.count, reason: e.reason })),
      spells: r.spells.map(s => ({ id: hex(s.id), edid: s.edid, kind: s.kind })),
      equipmentDumpEntries: r.unequipped, clearedSlots: r.slots,
    })),
  }
}

function writeNew(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { flag: 'wx' })
}

// ── Modes ────────────────────────────────────────────────────────────────────

async function planMode(flags, list) {
  await withCol(async col => {
    const plan = await buildPlan(col, list, !flags.noContainers)
    const sum = printPlan(plan, list)
    const file = path.resolve(flags.report || path.join(BACKUP_ROOT, `strip-inventories-plan-${stamp()}.json`))
    writeNew(file, JSON.stringify(reportOf(plan, list, sum), null, 1))
    console.log(`\nreport: ${file}`)
    console.log('nothing was written to the database')
  })
}

async function backupMode(flags, list) {
  const dir = path.resolve(flags.out || path.join(BACKUP_ROOT, `rollback-strip-${stamp()}`))
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Refusal(`${dir} is not empty`)
  await withCol(async col => {
    const plan = await buildPlan(col, list, !flags.noContainers)
    const docs = plan.rows.map(r => r.doc)
    const text = BSON.EJSON.stringify(docs, { relaxed: false })
    writeNew(path.join(dir, DOCS_FILE), text)
    const info = { createdAt: new Date().toISOString(), databaseName: settings.databaseName, listSha256: list.sha, factionGear: list.factionGear, withContainers: !flags.noContainers, count: docs.length, docsSha256: sha256(text), ids: docs.map(d => String(d._id)) }
    writeNew(path.join(dir, INFO_FILE), JSON.stringify(info, null, 1))
    console.log(`backed up ${plural(docs.length, 'changeForm', 'changeForms')} to ${dir}`)
  })
}

function readBackup(dir) {
  let info
  let text
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, INFO_FILE), 'utf8'))
    text = fs.readFileSync(path.join(dir, DOCS_FILE), 'utf8')
  } catch (err) { throw new Refusal(`${dir} is not a strip backup (${err.code || 'not valid JSON'})`) }
  if (sha256(text) !== info.docsSha256) throw new Refusal(`${DOCS_FILE} in ${dir} does not match its checksum`)
  if (info.databaseName !== settings.databaseName) throw new Refusal(`the backup is of database ${info.databaseName}, not ${settings.databaseName}`)
  const docs = BSON.EJSON.parse(text, { relaxed: false })
  if (docs.length !== info.count) throw new Refusal(`the backup holds ${docs.length} documents, its info says ${info.count}`)
  return { info, docs }
}

function canonical(doc) { return BSON.EJSON.stringify(doc, { relaxed: false }) }

async function applyMode(flags, list) {
  const dir = path.resolve(flags.backup)
  const { info, docs } = readBackup(dir)
  if (info.listSha256 !== list.sha) throw new Refusal('the backup was taken with another forbidden-items.json, take a new backup')
  if (info.factionGear !== list.factionGear) throw new Refusal(`the backup was taken ${info.factionGear ? 'with' : 'without'} --faction-gear, pass the same choice`)
  if (info.withContainers !== !flags.noContainers) throw new Refusal(`the backup was taken ${info.withContainers ? 'with' : 'without'} containers, pass the same --no-containers choice`)
  const blocker = await gameServerBlocker()
  await withCol(async col => {
    const plan = await buildPlan(col, list, !flags.noContainers)
    const backed = new Map(docs.map(d => [String(d._id), canonical(d)]))
    const problems = []
    for (const r of plan.rows) {
      const saved = backed.get(String(r.doc._id))
      if (!saved) problems.push(`${r.who} is not in the backup`)
      else if (saved !== canonical(r.doc)) problems.push(`${r.who} changed since the backup`)
    }
    if (plan.rows.length !== docs.length) problems.push(`the plan changes ${plan.rows.length} documents, the backup holds ${docs.length}`)
    printPlan(plan, list)
    if (problems.length) throw new Refusal(`the backup does not match the live documents, take a new one:\n  ${problems.slice(0, 20).join('\n  ')}`)
    if (!flags.apply) {
      console.log(`\n[dry run] backup ${dir} matches; ${blocker ? `apply would refuse: ${blocker}` : 're-run with --apply to strip'}`)
      return
    }
    if (blocker) throw new Refusal(blocker)
    for (const r of plan.rows) {
      const res = await col.updateOne({ _id: r.doc._id, formDesc: r.doc.formDesc }, { $set: r.set })
      if (res.matchedCount !== 1) throw new Error(`updateOne matched ${res.matchedCount} documents for ${r.who}`)
    }
    const left = (await buildPlan(col, list, !flags.noContainers)).rows.length
    if (left) throw new Error(`${plural(left, 'document', 'documents')} still hold forbidden entries after the strip`)
    console.log(`\nstripped ${plural(plan.rows.length, 'document', 'documents')}; restore with: node deploy/mongodb/strip-inventories.js restore --backup "${dir}" --apply`)
  })
}

async function restoreMode(flags) {
  const dir = path.resolve(flags.backup)
  const { docs } = readBackup(dir)
  console.log(`${plural(docs.length, 'document', 'documents')} in ${dir}`)
  if (!flags.apply) { console.log('[dry run] re-run with --apply to put them back'); return }
  const blocker = await gameServerBlocker()
  if (blocker) throw new Refusal(blocker)
  await withCol(async col => {
    for (const doc of docs) {
      const res = await col.replaceOne({ _id: doc._id }, doc)
      if (res.matchedCount !== 1) throw new Error(`replaceOne matched ${res.matchedCount} documents for ${doc.formDesc}`)
    }
    console.log(`restored ${plural(docs.length, 'document', 'documents')}`)
  })
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan'
  const rest = mode === argv[0] ? argv.slice(1) : argv
  const flags = { apply: false, noContainers: false, factionGear: false, out: null, backup: null, list: null, report: null }
  const bools = { '--apply': 'apply', '--no-containers': 'noContainers', '--faction-gear': 'factionGear' }
  const valued = { '--out': 'out', '--backup': 'backup', '--list': 'list', '--report': 'report' }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (bools[a]) flags[bools[a]] = true
    else if (valued[a]) {
      const v = rest[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      flags[valued[a]] = v
    } else throw new UsageError(`unknown argument ${a}`)
  }
  const allowed = {
    plan: ['list', 'report', 'noContainers', 'factionGear'],
    backup: ['out', 'list', 'noContainers', 'factionGear'],
    apply: ['backup', 'apply', 'list', 'noContainers', 'factionGear'],
    restore: ['backup', 'apply'],
  }
  if (!allowed[mode]) throw new UsageError(`unknown mode ${mode}`)
  for (const [key, v] of Object.entries(flags)) if (v && !allowed[mode].includes(key)) throw new UsageError(`${key} does not apply to ${mode}`)
  if ((mode === 'apply' || mode === 'restore') && !flags.backup) throw new UsageError(`${mode} needs --backup <dir>`)
  return { mode, flags }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return }
  const { mode, flags } = parseArgs(argv)
  settings = loadSettings()
  requireDriver()
  if (mode === 'restore') return restoreMode(flags)
  const list = loadList(path.resolve(flags.list || LIST_FILE), flags.factionGear)
  await { plan: planMode, backup: backupMode, apply: applyMode }[mode](flags, list)
}

main().catch(err => {
  const text = purge ? purge.sanitize(err, settings) : String(err && err.message ? err.message : err)
  if (err instanceof UsageError) console.error(`${text}\n\n${USAGE}`)
  else console.error(`\n${err instanceof Refusal ? 'REFUSED' : 'FAILED'}: ${text}`)
  process.exitCode = 1
})
