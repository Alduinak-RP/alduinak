'use strict'

// Shared by strip-inventories.js and restore-stripped-items.js: settings, driver, forbidden list, backups and the strip's per-document rule

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SM = path.join(__dirname, '..', '..', 'server-manager', 'src')
const config = require(path.join(SM, 'config'))
const formIds = require(path.join(SM, 'formIds'))
const modsync = require(path.join(SM, 'modsync'))

const BACKUP_ROOT = process.env.ALDUINAK_WIPE_BACKUP_ROOT || 'C:\\Users\\Administrator\\Desktop\\alduinak-overnight-2026-09-11'
const INFO_FILE = 'strip-backup.json'
const DOCS_FILE = 'changeforms.ejson'
const HOUSING_PROP = 'private.housing'
const SPELL_SLOTS = ['leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell']

class Refusal extends Error {}
class UsageError extends Error {}

const driver = { purge: null, BSON: null }
let current = null

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }
function hex(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0') }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex') }
function arr(v) { return Array.isArray(v) ? v : [] }

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function writeNew(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { flag: 'wx' })
}

function loadSettings() {
  let s
  try { ({ settings: s } = modsync.readSettingsFile(config.paths.serverSettings)) }
  catch (err) { throw new Refusal(`cannot read ${config.paths.serverSettings}: ${err.code || err.message}`) }
  if (s.databaseDriver !== 'mongodb') throw new Refusal(`databaseDriver is "${s.databaseDriver}", this script only handles mongodb`)
  if (!s.databaseUri || !s.databaseName) throw new Refusal('server-settings.json needs databaseUri and databaseName')
  current = s
  return s
}

// The driver ships with server-manager, so it loads only after npm install there
function requireDriver() {
  if (driver.BSON) return driver
  try {
    driver.purge = require(path.join(SM, 'mongoPurge'))
    driver.BSON = require(require.resolve('mongodb', { paths: [SM] })).BSON
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && /'mongodb'/.test(err.message)) throw new Refusal('mongodb driver not found: run npm install in server-manager (or set NODE_PATH to its node_modules)')
    throw err
  }
  return driver
}

// Form ids are only valid for the load order they were computed against; appended accepts plugins added after it, which shift no ids
function checkOrder(order, settings, file, appended) {
  const live = arr(settings.loadOrder).map(n => modsync.basename(n).toLowerCase())
  const theirs = arr(order).map(n => String(n).toLowerCase())
  if (appended ? theirs.every((n, i) => live[i] === n) : live.join('|') === theirs.join('|')) return
  throw new Refusal(appended ? `the load order changed under ${file} (a plugin was removed or inserted), its form ids no longer match the live ones` : `${file} was computed for another load order, run forbidden-items.py again`)
}

function slotsOf(plugins) { return formIds.computeSlots(plugins.map(p => p.name), Object.fromEntries(plugins.map(p => [p.name, p.light]))) }

function loadList(file, factionGear, settings) {
  let list
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (err) { throw new Refusal(`cannot read ${file} (${err.code || 'not valid JSON'}): run deploy/mongodb/forbidden-items.py first`) }
  checkOrder(list.loadOrder, settings, file, false)
  const items = new Map(list.items.filter(i => factionGear || !i.factionGear).map(i => [i.globalId >>> 0, i]))
  const spells = new Map(list.spells.map(s => [s.globalId >>> 0, s]))
  return { file, sha: sha256(fs.readFileSync(file)), factionGear, slots: slotsOf(list.plugins), items, spells, replacedPlugin: list.replacedPlugin }
}

async function withCol(settings, fn, open) {
  const { client, col } = await (open || requireDriver().purge.openChangeForms)(settings)
  try { return await fn(col) } finally { await client.close().catch(() => {}) }
}

// A personal claim (owner profile above 0) or a faction claim (owner -1 and the faction id)
function housingOf(doc) {
  const rec = doc.dynamicFields && doc.dynamicFields[HOUSING_PROP]
  if (!rec || typeof rec !== 'object') return null
  const owner = formIds.num(rec.owner)
  return owner > 0 || (owner === -1 && typeof rec.faction === 'string' && rec.faction) ? rec : null
}

// A faction claim is labelled by its faction id, with profile -1
function claimOwner(rec) {
  const profile = formIds.num(rec.owner)
  return { name: profile === -1 ? rec.faction : rec.ownerName, profile }
}

function ownerLabel(o) { return `${o.name || '?'} (profile ${o.profile})` }

// One pass over the collection: players, and every formDesc a live housing claim owns (the claimed ref and its listed containers)
async function scanClaims(col, list, withContainers) {
  const { purge } = requireDriver()
  const players = []
  const owned = new Map()
  let claims = 0
  for await (const doc of col.find({}, { promoteValues: false })) {
    if (purge.isPlayer(doc)) players.push(doc)
    else if (withContainers) {
      const rec = housingOf(doc)
      if (!rec) continue
      claims++
      const owner = claimOwner(rec)
      owned.set(doc.formDesc, owner)
      for (const id of arr(rec.containers)) {
        const desc = formIds.descOf(id, list.slots)
        if (desc) owned.set(desc, owner)
      }
    }
  }
  return { players, owned, claims }
}

// Players, and containers of a live housing claim that hold items
async function findTargets(col, list, withContainers) {
  const { purge } = requireDriver()
  const { players, owned, claims } = await scanClaims(col, list, withContainers)
  const containers = []
  if (withContainers && owned.size) {
    for await (const doc of col.find({ formDesc: { $in: [...owned.keys()] } }, { promoteValues: false })) {
      const o = owned.get(doc.formDesc)
      if (!purge.isPlayer(doc) && arr(doc.inv && doc.inv.entries).length) containers.push({ doc, owner: ownerLabel(o), profile: o.profile })
    }
  }
  return { players, containers, claims, owned }
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
    if (hit) removed.push({ baseId: formIds.num(e.baseId) >>> 0, count: formIds.num(e.count) || 1, reason: hit.reason, edid: hit.edid || e.name || '', entry: e })
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
  for (const k of slots) set[`equipmentDump.${k}`] = new (requireDriver().BSON.Int32)(0)
  return { removed, spells, unequipped: eqEntries.length - eqKeep.length, slots, set }
}

function nameOf(doc) {
  return doc.appearanceDump && typeof doc.appearanceDump.name === 'string' ? doc.appearanceDump.name : ''
}

function readBackup(dir, settings, infoFile = INFO_FILE) {
  const { BSON } = requireDriver()
  let info
  let text
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, infoFile), 'utf8'))
    text = fs.readFileSync(path.join(dir, DOCS_FILE), 'utf8')
  } catch (err) { throw new Refusal(`${dir} is not a ${infoFile === INFO_FILE ? 'strip' : 'restore'} backup (${err.code || 'not valid JSON'})`) }
  if (sha256(text) !== info.docsSha256) throw new Refusal(`${DOCS_FILE} in ${dir} does not match its checksum`)
  if (info.databaseName !== settings.databaseName) throw new Refusal(`the backup is of database ${info.databaseName}, not ${settings.databaseName}`)
  const docs = BSON.EJSON.parse(text, { relaxed: false })
  if (docs.length !== info.count) throw new Refusal(`the backup holds ${docs.length} documents, its info says ${info.count}`)
  return { info, docs }
}

function canonical(doc) { return requireDriver().BSON.EJSON.stringify(doc, { relaxed: false }) }

// spec: bools and valued map flags to keys, allowed lists the keys per mode, required names the flags a mode needs
function parseArgs(argv, spec) {
  const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : spec.defaultMode
  const rest = mode === argv[0] ? argv.slice(1) : argv
  const flags = {}
  for (const k of Object.values(spec.bools)) flags[k] = false
  for (const k of Object.values(spec.valued)) flags[k] = null
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (spec.bools[a]) flags[spec.bools[a]] = true
    else if (spec.valued[a]) {
      const v = rest[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      if (flags[spec.valued[a]] !== null) throw new UsageError(`${a} is given twice, give it once`)
      flags[spec.valued[a]] = v
    } else throw new UsageError(`unknown argument ${a}`)
  }
  if (!spec.allowed[mode]) throw new UsageError(`unknown mode ${mode}`)
  for (const [key, v] of Object.entries(flags)) if (v && !spec.allowed[mode].includes(key)) throw new UsageError(`${key} does not apply to ${mode}`)
  for (const flag of (spec.required && spec.required[mode]) || []) if (!flags[spec.valued[flag]]) throw new UsageError(`${mode} needs ${flag} <dir>`)
  return { mode, flags }
}

function runCli(main, usage) {
  return main().catch(err => {
    const text = driver.purge ? driver.purge.sanitize(err, current) : String(err && err.message ? err.message : err)
    if (err instanceof UsageError) console.error(`${text}\n\n${usage}`)
    else console.error(`\n${err instanceof Refusal ? 'REFUSED' : 'FAILED'}: ${text}`)
    process.exitCode = 1
  })
}

module.exports = {
  SM, BACKUP_ROOT, INFO_FILE, DOCS_FILE, Refusal, UsageError,
  plural, hex, sha256, arr, stamp, writeNew, loadSettings, requireDriver, checkOrder, slotsOf, loadList, withCol,
  housingOf, ownerLabel, scanClaims, findTargets, entryReason, planDoc, nameOf, readBackup, canonical, parseArgs, runCli,
}
