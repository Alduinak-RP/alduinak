'use strict'

// Pre-deploy world wipe with backup, verify, apply and restore modes; the runbook is docs/docs_database_wipe.md

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')

const SM = path.join(__dirname, '..', '..', 'server-manager', 'src')
const config = require(path.join(SM, 'config'))
const formIds = require(path.join(SM, 'formIds'))
const modsync = require(path.join(SM, 'modsync'))
const { nssm, nativeModuleLocked } = require(path.join(SM, 'serviceCheck'))

const USAGE = [
  'usage: node deploy/mongodb/wipe-world.js <mode> [flags]',
  '  backup  [--out <dir>] [--backend-running]',
  '          dump MongoDB and copy the state files; the game server must be stopped',
  '  verify  [--backup <dir>] [--order <plugins.txt | order.json>]',
  '          read-only: collections, state files, form ids in shifting slots, the purge stamp',
  '  apply   [--backup <dir>] [--apply] [--backend-running]',
  '          drop changeForms and reset the state files; a dry run unless --apply',
  '  restore --backup <dir> [--test | --apply [--with-settings]] [--backend-running]',
  '          put a backup back; a dry run unless --apply, which first backs up the live data;',
  '          --test restores into a throwaway collection',
  'runbook: docs/docs_database_wipe.md',
].join('\n')

const CF = 'changeForms'
const RESTORE_CHECK = 'wipeRestoreCheck'
const BACKUP_ROOT = process.env.ALDUINAK_WIPE_BACKUP_ROOT || 'C:\\Users\\Administrator\\Desktop\\alduinak-overnight-2026-09-11'
const BACKUP_PREFIX = 'rollback-wipe-'
// Live data saved by restore --apply before it overwrites anything; apply never picks these
const PRE_RESTORE_PREFIX = 'pre-restore-'
const INFO_FILE = 'wipe-backup.json'
const SUMS_FILE = 'SHA256SUMS.txt'
const DUMP_DIR = 'mongodump'
const SERVER_COPY = 'server'
const BACKEND_COPY = 'backend-data'
const POST_SYNC_DIFF = 'post-sync/manifest-diff.json'
const TOOLS_DIR = process.env.ALDUINAK_MONGO_TOOLS || 'C:\\Program Files\\MongoDB\\Tools\\100\\bin'
const BOM = String.fromCharCode(0xfeff)

// Collections apply drops or keeps; any other collection makes apply refuse until it is listed here
const DB_DROP = [CF]
const DB_KEEP = []

// Server folder registries of character and runtime ids, each reset to the value its loader reads as empty
const SERVER_RESET = {
  'housing.json': [],
  'zone-spawns.json': [],
  'companions.json': { active: [], corpses: [], stored: [] },
  'pets.json': { active: [], released: [] },
  'starter-grants.json': {},
}
// One file per written document; new ids restart with the wiped private.writings counter
const WRITINGS_DIR = 'writings'
// Settings and definitions copied into the backup and never changed by apply
const SERVER_DEFINITIONS = ['server-settings.json', 'NPC-Spawns.json', 'Jobs.json', 'faction-access.json']
// Server folder entries apply leaves alone (lower case); anything unlisted makes apply refuse
const SERVER_KEEP = new Set(['world', 'gamemode.js', 'gamemode_extensions', 'plugins', 'dist_back', 'scam_native.node', 'data', 'sign-gamemode.js', 'signing-private.pem', 'install-services.bat', 'launch_server.bat', 'readme.md', 'npc-spawns.json', 'jobs.json', 'faction-access.json', 'alert-keywords.json'])
// Settings copies, timestamped purge and delete backups, interrupted atomic writes
const SERVER_KEEP_RE = [/^server-settings[.-]/i, /-\d{13}\.json$/i, /\.tmp$/i]

// Live login tokens: never copied, reset or restored
const SESSION_FILES = new Set(['sessions.json', 'auth-states.json', 'dashboard-sessions.json'])
// Old manual copies and interrupted writes stay out of the backup
const BACKEND_SKIP_RE = [/\.bak/i, /\.tmp$/i, /^\.gitkeep$/i]
// Character names per profile slot, all of them wiped characters
const BACKEND_RESET = { 'characters.json': {} }
// Faction definitions and requirements stay; rank assignments go with the characters
const FACTIONS_FILE = 'faction-whitelist.json'
// Manifest state restore --with-settings puts back together with the old load order
const MANIFEST_STATE = ['install-manifest.json', 'install-manifest.json.prev', 'manifest-diff.json', 'manifest-sources.json', 'modlist.json', 'data-sync.json', 'files-version.json']
// Logs naming character and profile ids; service stdout and stderr logs stay
const MODERATION_LOGS = ['admin.log', 'ban.log', 'bounty.log', 'chat.log', 'faction.log', 'pk.log', 'pvp.log', 'trading.log']
// The manager files rotated logs under <logDir>\YYYY-MM
const LOG_MONTH_RE = /^\d{4}-\d{2}$/

// Credential keys in server-settings.json are never scanned or printed
const SECRET_KEY_RE = /^(databaseUri|masterKey|masterApiAuthToken|discordAuth|metricsAuth|voiceChat)$|token|secret|password|apikey/i
const HEX_SETTING_RE = /^0x([0-9a-f]{1,8})$/i
const HEX_PLAIN_RE = /^(?:0x)?([0-9a-f]{8})(\s.*)?$/i
const NUMERIC_ID_MIN = 0x01000000
const NUMERIC_ID_MAX = 0xFEFFFFFF
const CLASS_ORDER = ['player characters', 'runtime actors', 'plugin actors', 'runtime objects', 'plugin references']

class Refusal extends Error {}
class UsageError extends Error {}

let settings = null
let purge = null
const tempConfigs = new Set()

// ── Helpers ──────────────────────────────────────────────────────────────────

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}` }

function stamp(withSeconds = false) {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${withSeconds ? p(d.getSeconds()) : ''}`
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

// Resolves short 8.3 names and case through the nearest existing ancestor
function realPath(p) {
  let base = path.resolve(p)
  const tail = []
  while (!fs.existsSync(base) && path.dirname(base) !== base) {
    tail.unshift(path.basename(base))
    base = path.dirname(base)
  }
  try { base = fs.realpathSync.native(base) } catch {}
  return path.join(base, ...tail)
}

function isInside(child, parent) {
  const rel = path.relative(realPath(parent), realPath(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function listFiles(root, dir = root, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listFiles(root, p, out)
    else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'))
  }
  return out.sort()
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)) } catch { return false }
}

function sameTree(a, b) {
  if (!isDir(a) || !isDir(b)) return false
  const left = listFiles(a)
  const right = listFiles(b)
  return left.length === right.length && left.every((rel, i) => rel === right[i] && sameBytes(path.join(a, rel), path.join(b, rel)))
}

function emptyDir(dir) {
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
}

function copyAtomic(src, dest) {
  const tmp = `${dest}.tmp`
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dest)
}

// JSON parse errors quote the file text, so only a generic reason is ever reported
function readJsonState(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (err) { return err.code === 'ENOENT' ? { missing: true } : { error: `unreadable (${err.code || 'error'})` } }
  try { return { value: JSON.parse(text.startsWith(BOM) ? text.slice(1) : text) } }
  catch { return { error: 'not valid JSON' } }
}

// Array length, or the entries under an object's keys (registries hold arrays or flag maps)
function entryCount(value) {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 1
  return Object.values(value).reduce((n, v) => n + (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 1), 0)
}

function arrLen(v) { return Array.isArray(v) ? v.length : 0 }

function keyPathLabel(keys) {
  return keys.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : String(k)), '')
}

function valueAt(value, keys) {
  return keys.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), value)
}

function logDir() {
  return process.env.ALDUINAK_LOG_DIR || settings.logDir || config.logDir
}

// Active moderation logs plus their rotated <base>-<digits> copies in the log root and its YYYY-MM archives, relative to dir
function moderationLogs(dir) {
  const isLog = name => {
    const lower = name.toLowerCase()
    return MODERATION_LOGS.some(log => {
      const ext = path.extname(log)
      const base = path.basename(log, ext)
      return lower === log || (lower.startsWith(`${base}-`) && lower.endsWith(ext) && /^\d/.test(lower.slice(base.length + 1)))
    })
  }
  const found = []
  const scan = rel => {
    let entries = []
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile() && isLog(e.name)) found.push(rel ? `${rel}/${e.name}` : e.name)
      else if (!rel && e.isDirectory() && LOG_MONTH_RE.test(e.name)) scan(e.name)
    }
  }
  scan('')
  return found.sort()
}

function describeLogs(logs) {
  const active = logs.filter(rel => !rel.includes('/'))
  const archived = logs.filter(rel => rel.includes('/'))
  const months = [...new Set(archived.map(rel => rel.split('/')[0]))]
  return [...active, ...(archived.length ? [`${plural(archived.length, 'archived copy', 'archived copies')} in ${months.join(', ')}`] : [])].join(', ')
}

function gitHead() {
  return new Promise(resolve => {
    execFile('git', ['-C', config.repoRoot, 'rev-parse', 'HEAD'], { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? null : String(out).trim()))
  })
}

// ── Settings, load orders, services ──────────────────────────────────────────

function loadSettings() {
  let s
  try { ({ settings: s } = modsync.readSettingsFile(config.paths.serverSettings)) }
  catch (err) { throw new Refusal(err instanceof SyntaxError ? `${config.paths.serverSettings} is not valid JSON` : `cannot read ${config.paths.serverSettings}: ${err.code || err.message}`) }
  if (s.databaseDriver !== 'mongodb') throw new Refusal(`databaseDriver is "${s.databaseDriver}", this script only handles mongodb`)
  if (!s.databaseUri || !s.databaseName) throw new Refusal('server-settings.json needs databaseUri and databaseName')
  return s
}

// The driver ships with server-manager, so mongoPurge loads only after npm install there
function requirePurge() {
  try { return require(path.join(SM, 'mongoPurge')) }
  catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && /'mongodb'/.test(err.message)) throw new Refusal('mongodb driver not found: run npm install in server-manager')
    throw err
  }
}

function liveOrder() {
  return (Array.isArray(settings.loadOrder) ? settings.loadOrder : []).map(modsync.basename)
}

// light reads the copy deployed in Data first; lightNext prefers what the current manifest deploys
function flagsFor(names, key) {
  let diff = null
  try { diff = modsync.readDiff() } catch {}
  let manifest = null
  if (key === 'lightNext') try { manifest = modsync.readManifestLight(modsync.paths.manifest) } catch {}
  const flags = modsync.readPluginFlags(names, { dataDir: settings.dataDir, mo2Root: config.mo2Root, previous: diff, manifests: manifest ? [manifest] : [] })
  return names.map(name => ({ name, light: flags[name] ? flags[name][key] : null }))
}

function slotsOf(order) {
  return formIds.computeSlots(order.map(o => o.name), Object.fromEntries(order.map(o => [o.name, o.light])))
}

// MO2 plugins.txt ("*Name.esp" is enabled) gets the vanilla masters in front as Sync server settings does; JSON is an array or { loadOrder }
function readOrderFile(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (err) { throw new Refusal(`cannot read ${file}: ${err.code || err.message}`) }
  if (text.startsWith(BOM)) text = text.slice(1)
  let names
  if (/\.json$/i.test(file)) {
    let v
    try { v = JSON.parse(text) } catch { throw new Refusal(`${file} is not valid JSON`) }
    names = Array.isArray(v) ? v : v && Array.isArray(v.loadOrder) ? v.loadOrder : null
    if (!names) throw new Refusal(`${file} holds neither an array nor a loadOrder array`)
    names = names.map(modsync.basename)
  } else {
    names = [...modsync.VANILLA_PLUGINS, ...modsync.enabledPlugins({ plugins: text.split(/\r?\n/) })]
  }
  const seen = new Set()
  return names.map(n => String(n).trim()).filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
}

function scStatus(name) {
  return new Promise(resolve => {
    execFile('sc.exe', ['query', name], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const m = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(String(stdout || ''))
      resolve(m ? `SERVICE_${m[1]}` : null)
    })
  })
}

// nssm under the canonical then legacy names, then sc query
async function serviceStatus(key) {
  const svc = config.services.find(s => s.key === key)
  for (const name of [svc.name, ...(svc.legacyNames || [])]) {
    const status = await nssm('status', name)
    if (/^SERVICE_/.test(status)) return { name, status }
  }
  return { name: svc.name, status: await scStatus(svc.name) }
}

// A running game server re-upserts every loaded form and rewrites its registries
async function gameServerBlocker() {
  const { name, status } = await serviceStatus('game')
  if (status !== 'SERVICE_STOPPED') return `${name} is ${status || 'in an unknown state (neither nssm nor sc could query it)'}, stop it first`
  return nativeModuleLocked()
}

async function backendBlocker(flags) {
  if (flags.backendRunning) return null
  const { name, status } = await serviceStatus('backend')
  return status && status !== 'SERVICE_STOPPED' ? `${name} is ${status}, stop it so bans, profiles and faction files hold still (or pass --backend-running)` : null
}

// ── MongoDB ──────────────────────────────────────────────────────────────────

async function withDb(fn) {
  const { client } = await purge.openChangeForms(settings)
  try { return await fn(client.db(settings.databaseName)) }
  finally { await client.close().catch(() => {}) }
}

async function collectionNames(db) {
  return (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort()
}

function docClass(doc) {
  const plugin = typeof doc.formDesc === 'string' && doc.formDesc.includes(':')
  if (purge.isPlayer(doc)) return 'player characters'
  if (formIds.num(doc.recType) === 1) return plugin ? 'plugin actors' : 'runtime actors'
  return plugin ? 'plugin references' : 'runtime objects'
}

async function changeFormStats(db) {
  const stats = { total: 0, classes: {}, profiles: 0, deleted: 0, fields: {} }
  const profiles = new Set()
  const docs = await db.collection(CF).find({}, { projection: { formDesc: 1, recType: 1, profileId: 1, isDeleted: 1, dynamicFields: 1 } }).toArray()
  for (const doc of docs) {
    const cls = docClass(doc)
    stats.total++
    stats.classes[cls] = (stats.classes[cls] || 0) + 1
    if (cls === 'player characters') profiles.add(formIds.num(doc.profileId))
    if (doc.isDeleted === true) stats.deleted++
    if (doc.dynamicFields && typeof doc.dynamicFields === 'object') {
      for (const k of Object.keys(doc.dynamicFields)) stats.fields[k] = (stats.fields[k] || 0) + 1
    }
  }
  stats.profiles = profiles.size
  return stats
}

function printStats(stats, indent) {
  for (const cls of CLASS_ORDER) {
    if (stats.classes[cls]) console.log(`${indent}  ${cls.padEnd(18)} ${stats.classes[cls]}${cls === 'player characters' ? ` on ${plural(stats.profiles, 'profile', 'profiles')}` : ''}`)
  }
  if (stats.deleted) console.log(`${indent}  ${'flagged isDeleted'.padEnd(18)} ${stats.deleted}`)
  const fields = Object.entries(stats.fields).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (fields.length) console.log(`${indent}  dynamic fields: ${fields.map(([k, n]) => `${k} ${n}`).join(', ')}`)
}

// Each BSON document starts with its int32 total length
function bsonCount(file) {
  const buf = fs.readFileSync(file)
  let off = 0
  let n = 0
  while (off < buf.length) {
    const len = off + 4 <= buf.length ? buf.readInt32LE(off) : -1
    if (len < 5 || off + len > buf.length) throw new Error(`${file} has a broken document at byte ${off}`)
    off += len
    n++
  }
  return n
}

function dumpCount(dir, info, collection) {
  const file = path.join(dir, DUMP_DIR, info.databaseName, `${collection}.bson`)
  return fs.existsSync(file) ? bsonCount(file) : 0
}

// The tools refuse a database in the URI next to --db, so the path database moves into authSource
function toolUri(uri) {
  const u = new URL(uri)
  const db = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
  if (db && !u.searchParams.has('authSource')) u.searchParams.set('authSource', db)
  u.pathname = '/'
  return u.href
}

// mongodump and mongorestore read the URI from a --config file in %TEMP%, never from a command line or the backup folder
async function withToolConfig(fn) {
  const file = path.join(os.tmpdir(), `wipe-world-${process.pid}-${crypto.randomBytes(8).toString('hex')}.yaml`)
  tempConfigs.add(file)
  try {
    fs.writeFileSync(file, `uri: ${JSON.stringify(toolUri(settings.databaseUri))}\n`, { flag: 'wx', mode: 0o600 })
    return await fn(file)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
    tempConfigs.delete(file)
  }
}

function toolPath(name) {
  const exe = path.join(TOOLS_DIR, `${name}.exe`)
  return fs.existsSync(exe) ? exe : name
}

// Tool output goes through sanitize line by line
function runTool(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath(name), args, { windowsHide: true })
    const relay = stream => {
      let rest = ''
      const print = line => { if (line.trim()) console.log(`    [${name}] ${purge.sanitize(line.trim(), settings)}`) }
      stream.on('data', d => {
        const lines = (rest + d).split(/\r?\n/)
        rest = lines.pop()
        lines.forEach(print)
      })
      stream.on('end', () => print(rest))
    }
    relay(child.stdout)
    relay(child.stderr)
    child.on('error', err => reject(new Error(`${name} could not start (${err.code || err.message}); set ALDUINAK_MONGO_TOOLS to the MongoDB Database Tools bin folder`)))
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${name} exited with code ${code}`))))
  })
}

// Restores the changeForms dump into a throwaway collection, compares it with the backup and the live _ids, then drops it
async function restoreTest(db, dir, info) {
  const expected = info.collections[CF]
  if (expected === undefined) throw new Refusal(`the backup holds no ${CF} dump`)
  const check = db.collection(RESTORE_CHECK)
  if ((await collectionNames(db)).includes(RESTORE_CHECK)) await check.drop()
  try {
    await withToolConfig(cfg => runTool('mongorestore', ['--config', cfg, '--nsInclude', `${info.databaseName}.${CF}`, '--nsFrom', `${info.databaseName}.${CF}`, '--nsTo', `${settings.databaseName}.${RESTORE_CHECK}`, '--dir', path.join(dir, DUMP_DIR)]))
    const got = await check.countDocuments()
    if (got !== expected) throw new Error(`restore test: ${RESTORE_CHECK} holds ${got} document(s), the backup ${expected}`)
    let compared = ''
    if ((await collectionNames(db)).includes(CF)) {
      const ids = async col => new Set((await col.find({}, { projection: { _id: 1 } }).toArray()).map(d => String(d._id)))
      const live = await ids(db.collection(CF))
      const restored = await ids(check)
      const missing = [...live].filter(id => !restored.has(id)).length
      if (missing || live.size !== restored.size) throw new Error(`restore test: ${missing} live _id(s) missing from the restored copy (${restored.size} restored, ${live.size} live)`)
      compared = `, the same ${live.size} _ids as the live ${CF}`
    }
    console.log(`  restore test ok: ${plural(got, 'document', 'documents')} restored${compared}`)
  } finally {
    if ((await collectionNames(db)).includes(RESTORE_CHECK)) await check.drop()
  }
}

// ── Backup folder ────────────────────────────────────────────────────────────

async function writeSums(dir) {
  const lines = []
  for (const rel of listFiles(dir).filter(r => r !== SUMS_FILE)) lines.push(`${await modsync.sha256File(path.join(dir, rel))}  ${rel}`)
  fs.writeFileSync(path.join(dir, SUMS_FILE), lines.join('\n') + '\n')
  return lines.length
}

async function appendSum(dir, rel) {
  fs.appendFileSync(path.join(dir, SUMS_FILE), `${await modsync.sha256File(path.join(dir, rel))}  ${rel}\n`)
}

async function checkSums(dir) {
  let text
  try { text = fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8') }
  catch { throw new Refusal(`${dir} has no ${SUMS_FILE}, the backup did not finish`) }
  const listed = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!m) throw new Refusal(`${SUMS_FILE} has a malformed line`)
    listed.set(m[2], m[1])
  }
  const present = new Set(listFiles(dir).filter(r => r !== SUMS_FILE))
  const problems = []
  for (const [rel, hash] of listed) {
    if (!present.has(rel)) problems.push(`missing ${rel}`)
    else if (await modsync.sha256File(path.join(dir, rel)) !== hash) problems.push(`changed ${rel}`)
  }
  for (const rel of present) if (!listed.has(rel)) problems.push(`not in ${SUMS_FILE}: ${rel}`)
  if (problems.length) throw new Refusal(`backup ${dir} fails its checksums: ${problems.join(', ')}`)
  return listed.size
}

function readInfo(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, INFO_FILE), 'utf8')) }
  catch { throw new Refusal(`${dir} is not a finished wipe backup (no readable ${INFO_FILE})`) }
}

function resolveBackup(flags) {
  if (flags.backup) return path.resolve(flags.backup)
  let names = []
  try { names = fs.readdirSync(BACKUP_ROOT).filter(n => n.startsWith(BACKUP_PREFIX) && fs.existsSync(path.join(BACKUP_ROOT, n, INFO_FILE))).sort() } catch {}
  if (!names.length) throw new Refusal(`no backup under ${BACKUP_ROOT}: run backup first or pass --backup <dir>`)
  return path.join(BACKUP_ROOT, names[names.length - 1])
}

// ── backup ───────────────────────────────────────────────────────────────────

function backupDirProblem(dir) {
  if (isInside(dir, config.repoRoot)) return `${dir} is inside the repository; the backup holds player data and secrets and must stay out of git`
  if (isInside(dir, config.paths.serverDir)) return `${dir} is inside the server folder, which Build server prunes`
  if (fs.existsSync(dir) && (!isDir(dir) || fs.readdirSync(dir).length)) return `${dir} already exists and is not an empty folder`
  return null
}

async function takeBackup(dir, flags) {
  const problem = backupDirProblem(dir)
  if (problem) throw new Refusal(problem)
  const blockers = [await gameServerBlocker(), await backendBlocker(flags)].filter(Boolean)
  if (blockers.length) throw new Refusal(blockers.join('\n  '))

  const serverDir = config.paths.serverDir
  const info = {
    createdAt: new Date().toISOString(), head: await gitHead(), databaseName: settings.databaseName,
    collections: {}, changeForms: null, loadOrder: flagsFor(liveOrder(), 'light'),
    server: { copied: [], absent: [] }, backend: { copied: [], leftOut: [] },
  }
  console.log(`backup into ${dir}`)
  console.log('\n[1/4] MongoDB')
  await withDb(async db => {
    for (const name of await collectionNames(db)) if (name !== RESTORE_CHECK) info.collections[name] = await db.collection(name).countDocuments()
    if (CF in info.collections) info.changeForms = await changeFormStats(db)
  })
  for (const [name, count] of Object.entries(info.collections)) console.log(`  ${name}: ${plural(count, 'document', 'documents')}`)
  if (info.changeForms) printStats(info.changeForms, '  ')
  fs.mkdirSync(dir, { recursive: true })
  await withToolConfig(cfg => runTool('mongodump', ['--config', cfg, '--db', settings.databaseName, '--excludeCollection', RESTORE_CHECK, '--out', path.join(dir, DUMP_DIR)]))
  for (const [name, count] of Object.entries(info.collections)) {
    const n = dumpCount(dir, info, name)
    if (n !== count) throw new Error(`the dump of ${name} holds ${n} document(s) but the collection holds ${count}`)
  }
  console.log(`  dump counted: ${Object.entries(info.collections).map(([n, c]) => `${n} ${c}`).join(', ') || 'no collections'}`)

  console.log('\n[2/4] server state files')
  for (const name of [...Object.keys(SERVER_RESET), WRITINGS_DIR, ...SERVER_DEFINITIONS]) {
    const src = path.join(serverDir, name)
    if (!fs.existsSync(src)) { info.server.absent.push(name); continue }
    fs.cpSync(src, path.join(dir, SERVER_COPY, name), { recursive: true, errorOnExist: true, force: false })
    info.server.copied.push(name)
  }
  console.log(`  copied: ${info.server.copied.join(', ') || 'nothing'}`)
  if (info.server.absent.length) console.log(`  absent: ${info.server.absent.join(', ')}`)

  console.log('\n[3/4] backend data')
  const dataDir = config.paths.dataDir
  const skipped = name => SESSION_FILES.has(name.toLowerCase()) || BACKEND_SKIP_RE.some(re => re.test(name))
  if (isDir(dataDir)) {
    info.backend.leftOut = fs.readdirSync(dataDir).filter(skipped).sort()
    fs.cpSync(dataDir, path.join(dir, BACKEND_COPY), { recursive: true, errorOnExist: true, force: false, filter: src => path.resolve(src) === path.resolve(dataDir) || !skipped(path.basename(src)) })
    info.backend.copied = isDir(path.join(dir, BACKEND_COPY)) ? listFiles(path.join(dir, BACKEND_COPY)) : []
  }
  console.log(`  copied: ${info.backend.copied.join(', ') || 'nothing'}`)
  if (info.backend.leftOut.length) console.log(`  left out (sessions, old copies): ${info.backend.leftOut.join(', ')}`)

  console.log('\n[4/4] load order and checksums')
  const unknown = info.loadOrder.filter(o => typeof o.light !== 'boolean').map(o => o.name)
  console.log(`  load order: ${plural(info.loadOrder.length, 'plugin', 'plugins')}${unknown.length ? `, WARNING unknown light flag for ${unknown.join(', ')}` : ''}`)
  fs.writeFileSync(path.join(dir, INFO_FILE), JSON.stringify(info, null, 2) + '\n')
  const summed = await writeSums(dir)
  const bytes = listFiles(dir).reduce((n, rel) => n + fs.statSync(path.join(dir, rel)).size, 0)
  console.log(`\nbackup complete: ${dir}`)
  console.log(`  ${plural(summed, 'file', 'files')} in ${SUMS_FILE}, ${(bytes / 1048576).toFixed(1)} MB`)
}

async function backupMode(flags) {
  const dir = path.resolve(flags.out || path.join(BACKUP_ROOT, BACKUP_PREFIX + stamp()))
  await takeBackup(dir, flags)
  console.log(`next: node deploy/mongodb/wipe-world.js restore --backup "${dir}" --test`)
}

// ── verify ───────────────────────────────────────────────────────────────────

function registryState(file) {
  const s = readJsonState(file)
  if (s.missing) return 'absent (reads as empty)'
  if (s.error) return s.error
  const n = entryCount(s.value)
  return n ? `${plural(n, 'entry', 'entries')}, not reset` : 'reset'
}

function stateReport() {
  const serverDir = config.paths.serverDir
  const dataDir = config.paths.dataDir
  for (const name of Object.keys(SERVER_RESET)) console.log(`  ${name}: ${registryState(path.join(serverDir, name))}`)
  const wdir = path.join(serverDir, WRITINGS_DIR)
  const wcount = isDir(wdir) ? listFiles(wdir).length : null
  console.log(`  ${WRITINGS_DIR}/: ${wcount === null ? 'absent' : wcount ? `${plural(wcount, 'file', 'files')}, not reset` : 'reset'}`)
  for (const name of Object.keys(BACKEND_RESET)) console.log(`  backend ${name}: ${registryState(path.join(dataDir, name))}`)
  const f = readJsonState(path.join(dataDir, FACTIONS_FILE))
  const assigned = f.value ? arrLen(f.value.assignments) : 0
  console.log(`  backend ${FACTIONS_FILE}: ${f.missing ? 'absent' : f.error ? f.error : `${plural(arrLen(f.value.factions), 'faction', 'factions')} and ${plural(arrLen(f.value.requirements), 'requirement', 'requirements')} kept, ${plural(assigned, 'assignment', 'assignments')}${assigned ? ', not reset' : ', reset'}`}`)
  for (const name of SERVER_DEFINITIONS.slice(1)) {
    const s = readJsonState(path.join(serverDir, name))
    console.log(`  ${name}: ${s.missing ? 'absent' : s.error ? s.error : `${plural(entryCount(s.value), 'entry', 'entries')}, kept`}`)
  }
  const logs = moderationLogs(logDir())
  console.log(`  moderation logs in ${logDir()}: ${logs.length ? describeLogs(logs) : 'none (moved or not written yet)'}`)
}

// Hex form id strings with their key path; settings also yield large integers
function scanIds(value, keys, settingsStyle, hits) {
  if (typeof value === 'string') {
    const m = (settingsStyle ? HEX_SETTING_RE : HEX_PLAIN_RE).exec(value)
    if (m) hits.push({ keys, raw: value, id: parseInt(m[1], 16) })
  } else if (typeof value === 'number') {
    if (settingsStyle && Number.isInteger(value) && value >= NUMERIC_ID_MIN && value <= NUMERIC_ID_MAX) hits.push({ keys, raw: value, id: value })
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanIds(v, [...keys, i], settingsStyle, hits))
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) if (!(settingsStyle && SECRET_KEY_RE.test(k))) scanIds(value[k], [...keys, k], settingsStyle, hits)
  }
}

function idOf(raw, settingsStyle) {
  if (typeof raw === 'number') return raw
  const m = typeof raw === 'string' && (settingsStyle ? HEX_SETTING_RE : HEX_PLAIN_RE).exec(raw)
  return m ? parseInt(m[1], 16) : null
}

// Keeps the 0x prefix, digit count, letter case and any trailing text of the original value
function renderLike(raw, id) {
  if (typeof raw === 'number') return String(id)
  const m = /^(0x)?([0-9a-f]+)(.*)$/i.exec(raw)
  const hex = id.toString(16).padStart(m[2].length, '0')
  return `${m[1] || ''}${/[a-f]/.test(m[2]) && !/[A-F]/.test(m[2]) ? hex : hex.toUpperCase()}${m[3]}`
}

function shiftReport(info, backupDir, flags) {
  let oldOrder = info ? info.loadOrder : flagsFor(liveOrder(), 'light')
  const oldLabel = info ? `backup ${path.basename(backupDir)}` : 'the live server-settings.json loadOrder'
  const newOrder = flags.order ? flagsFor(readOrderFile(flags.order), 'lightNext') : flagsFor(liveOrder(), 'light')
  const newLabel = flags.order ? flags.order : 'the live server-settings.json loadOrder'
  if (!Array.isArray(oldOrder)) oldOrder = []
  console.log(`  from ${oldLabel} (${plural(oldOrder.length, 'plugin', 'plugins')}) to ${newLabel} (${plural(newOrder.length, 'plugin', 'plugins')})`)
  let oldSlots
  let newSlots
  try {
    oldSlots = slotsOf(oldOrder)
    newSlots = slotsOf(newOrder)
  } catch (err) {
    console.log(`  cannot compute: ${err.message} (put the plugin in Data or MO2 first)`)
    return
  }
  const { removed, shifted } = formIds.diffSlots(oldSlots, newSlots)
  if (!removed.size && !shifted.size) { console.log('  no plugin changes slot, every form id stays valid'); return }
  console.log(`  ${plural(shifted.size, 'plugin changes', 'plugins change')} slot${removed.size ? `; removed: ${[...removed.values()].join(', ')}` : ''}`)
  let edits = 0
  let found = 0
  for (const name of SERVER_DEFINITIONS) {
    const settingsStyle = name === 'server-settings.json'
    const livePath = path.join(config.paths.serverDir, name)
    const copied = info && Array.isArray(info.server && info.server.copied) && info.server.copied.includes(name)
    const source = readJsonState(copied ? path.join(backupDir, SERVER_COPY, name) : livePath)
    const live = readJsonState(livePath)
    if (source.missing) continue
    if (source.error || live.error) { console.log(`  ${name}: ${source.error || live.error}, not scanned`); continue }
    const hits = []
    scanIds(source.value, [], settingsStyle, hits)
    for (const hit of hits) {
      const d = formIds.decodeId(hit.id, oldSlots)
      if (!d || (!shifted.has(d.key) && !removed.has(d.key))) continue
      found++
      const where = `${name} ${keyPathLabel(hit.keys)}`
      const local = `${d.plugin} local 0x${d.local.toString(16).toUpperCase()}`
      const liveRaw = live.missing ? undefined : valueAt(live.value, hit.keys)
      if (removed.has(d.key)) {
        edits++
        console.log(`  EDIT ${where}: ${hit.raw} is ${local}, which left the load order; replace it by hand`)
        continue
      }
      const next = formIds.encodeId(d.plugin, d.local, newSlots)
      const ok = idOf(liveRaw, settingsStyle) === next
      if (!ok) edits++
      console.log(`  ${ok ? 'ok  ' : 'EDIT'} ${where}: ${hit.raw} is ${local}, must be ${renderLike(hit.raw, next)}; live value ${liveRaw === undefined ? 'missing' : JSON.stringify(liveRaw)}`)
    }
  }
  if (!found) console.log('  no stored form id sits in a shifted or removed slot')
  else console.log(edits ? `  ${plural(edits, 'value still needs', 'values still need')} an edit before the first boot` : '  every stored form id matches the new load order')
}

function gateReport() {
  let diff
  try { diff = modsync.readDiff() } catch (err) { console.log(`  ${err.message}`); return }
  if (!diff) { console.log('  no manifest-diff.json, nothing gates the game server start'); return }
  console.log(`  manifest built ${diff.builtAt}; purgeNeeded ${diff.purgeNeeded}; syncedSettingsAt ${diff.syncedSettingsAt}; purgedAt ${diff.purgedAt}`)
  if (diff.purgeStartedAt && !diff.purgedAt) console.log(`  WARNING: a purge started at ${diff.purgeStartedAt} and never finished`)
  if (modsync.purgePending(diff)) console.log('  NEEDS STAMP: the manager refuses to start the game server; with changeForms empty, run Purge MongoDB (dry run, then apply) to stamp purgedAt')
  else if (diff.purgeNeeded && !diff.syncedSettingsAt) console.log('  the load order changes but Sync server settings has not run; the purge stamp comes after it')
  else if (diff.purgeNeeded) console.log('  stamped, the start gate is open')
  else console.log('  no purge needed for this manifest, the start gate is open')
  let manifest = null
  try { manifest = modsync.readManifestLight(modsync.paths.manifest) } catch {}
  if (manifest) {
    const target = [...modsync.VANILLA_PLUGINS, ...modsync.enabledPlugins(manifest)].map(n => n.toLowerCase())
    const same = target.join('|') === liveOrder().map(n => n.toLowerCase()).join('|')
    console.log(same ? '  server-settings.json loadOrder matches the manifest' : '  server-settings.json loadOrder differs from the manifest; Purge MongoDB refuses until Sync server settings runs')
  }
}

async function verifyMode(flags) {
  const backupDir = flags.backup ? path.resolve(flags.backup) : null
  const info = backupDir ? readInfo(backupDir) : null
  console.log('services')
  for (const key of ['game', 'backend']) {
    const { name, status } = await serviceStatus(key)
    const lock = key === 'game' ? nativeModuleLocked() : null
    console.log(`  ${name}: ${status || 'unknown'}${lock ? `; ${lock}` : ''}`)
  }

  console.log('\nMongoDB')
  let liveSlots = null
  try { liveSlots = slotsOf(flagsFor(liveOrder(), 'light')) } catch (err) { console.log(`  descriptor check skipped: ${err.message}`) }
  try {
    await withDb(async db => {
      const names = await collectionNames(db)
      if (!names.length) console.log(`  ${settings.databaseName} has no collections`)
      for (const name of names) {
        const count = await db.collection(name).countDocuments()
        const backed = info && info.collections && name in info.collections ? ` (backup ${info.collections[name]})` : ''
        console.log(`  ${name}: ${plural(count, 'document', 'documents')}${backed}`)
      }
      if (!names.includes(CF)) return
      printStats(await changeFormStats(db), '  ')
      if (!liveSlots) return
      let bad = 0
      const sample = []
      for (const doc of await db.collection(CF).find({}).toArray()) {
        const hits = []
        purge.foreignDescriptors(doc, liveSlots, '', hits)
        if (hits.length && bad++ < 5) sample.push(`${doc.formDesc}: ${hits.slice(0, 3).join(', ')}`)
      }
      console.log(bad ? `  ${plural(bad, 'document names', 'documents name')} a plugin outside the live load order: ${sample.join(' | ')}` : '  every descriptor names a plugin in the live load order')
    })
  } catch (err) {
    console.log(`  could not read: ${purge.sanitize(err, settings)}`)
  }

  console.log('\nstate files')
  stateReport()
  console.log('\nform ids in shifting slots')
  shiftReport(info, backupDir, flags)
  console.log('\nstart gate')
  gateReport()
}

// ── apply ────────────────────────────────────────────────────────────────────

// Resets a JSON file only when it still equals its backup copy or already reads as reset
function planJson(plan, { file, copy, label, done, target, describe, needsValue = false }) {
  const state = readJsonState(file)
  if (state.missing) { console.log(`  ${label}: absent, nothing to reset`); return }
  if (!state.error && done(state.value)) { console.log(`  ${label}: already reset`); return }
  if (!sameBytes(file, copy)) { plan.blockers.push(`${label} differs from its backup copy (something wrote since the backup), take a new backup`); return }
  if (state.error && needsValue) { plan.blockers.push(`${label} is ${state.error}, fix it first`); return }
  const next = target(state.value)
  console.log(`  ${label}: ${state.error || describe(state.value)}`)
  plan.actions.push({ label: `reset ${label}`, run: () => modsync.writeJsonAtomic(file, next) })
}

async function applyMode(flags) {
  const dir = resolveBackup(flags)
  const info = readInfo(dir)
  const serverDir = config.paths.serverDir
  const dataDir = config.paths.dataDir
  const plan = { blockers: [], actions: [] }
  console.log(`${flags.apply ? 'wipe' : 'dry run of the wipe'} with backup ${dir}`)
  console.log(`  checksums ok: ${plural(await checkSums(dir), 'file', 'files')}, backup taken ${info.createdAt}`)
  if (info.databaseName !== settings.databaseName) plan.blockers.push(`the backup is of database ${info.databaseName}, server-settings.json names ${settings.databaseName}`)
  for (const [name, count] of Object.entries(info.collections || {})) {
    const n = dumpCount(dir, info, name)
    if (n !== count) plan.blockers.push(`the dump of ${name} holds ${n} document(s) but ${INFO_FILE} records ${count}`)
  }
  for (const b of [await gameServerBlocker(), await backendBlocker(flags)]) if (b) plan.blockers.push(b)

  const postSync = path.join(dir, POST_SYNC_DIFF)
  if (fs.existsSync(modsync.paths.diff) && !fs.existsSync(postSync)) {
    plan.actions.push({
      label: `copy the current manifest-diff.json into the backup as ${POST_SYNC_DIFF}`,
      run: async () => {
        fs.mkdirSync(path.dirname(postSync), { recursive: true })
        fs.copyFileSync(modsync.paths.diff, postSync)
        await appendSum(dir, POST_SYNC_DIFF)
      },
    })
  }

  console.log('\nMongoDB')
  const live = await withDb(async db => {
    const names = await collectionNames(db)
    const counts = {}
    for (const name of names) counts[name] = await db.collection(name).countDocuments()
    return { names, counts, stats: names.includes(CF) ? await changeFormStats(db) : null }
  })
  const unknown = live.names.filter(n => !DB_DROP.includes(n) && !DB_KEEP.includes(n) && n !== RESTORE_CHECK)
  if (unknown.length) plan.blockers.push(`unclassified collection(s) ${unknown.join(', ')}: list them in DB_DROP or DB_KEEP in wipe-world.js`)
  for (const name of DB_KEEP.filter(n => live.names.includes(n))) console.log(`  ${name}: kept`)
  if (live.names.includes(CF)) {
    console.log(`  ${CF}: ${plural(live.counts[CF], 'document', 'documents')}`)
    printStats(live.stats, '  ')
    if (live.counts[CF] !== info.collections[CF]) plan.blockers.push(`${CF} holds ${live.counts[CF]} document(s), the backup ${CF in info.collections ? info.collections[CF] : 'none'}: something wrote since the backup (a game server boot?), take a new backup`)
    plan.actions.push({ label: `restore test of the dump into ${RESTORE_CHECK}`, run: () => withDb(db => restoreTest(db, dir, info)) })
    plan.actions.push({
      label: `drop ${settings.databaseName}.${CF} (${plural(live.counts[CF], 'document', 'documents')})`,
      run: () => withDb(async db => {
        await db.collection(CF).drop()
        if ((await collectionNames(db)).includes(CF)) throw new Error(`${CF} still exists after the drop`)
      }),
    })
  } else {
    console.log(`  ${CF}: already dropped`)
    if (live.names.includes(RESTORE_CHECK)) plan.actions.push({ label: `drop the leftover ${RESTORE_CHECK}`, run: () => withDb(db => db.collection(RESTORE_CHECK).drop()) })
  }

  console.log('\nserver folder')
  const extraKeep = new Set((process.env.ALDUINAK_SERVER_KEEP || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const resetNames = new Set([...Object.keys(SERVER_RESET), WRITINGS_DIR].map(n => n.toLowerCase()))
  const entries = isDir(serverDir) ? fs.readdirSync(serverDir) : []
  const unclassified = entries.filter(n => !resetNames.has(n.toLowerCase()) && !SERVER_KEEP.has(n.toLowerCase()) && !extraKeep.has(n.toLowerCase()) && !SERVER_KEEP_RE.some(re => re.test(n)))
  if (unclassified.length) plan.blockers.push(`unclassified entries in ${serverDir}: ${unclassified.join(', ')}; list them in SERVER_RESET or SERVER_KEEP in wipe-world.js, or name keeps in ALDUINAK_SERVER_KEEP`)
  for (const [name, empty] of Object.entries(SERVER_RESET)) {
    planJson(plan, {
      file: path.join(serverDir, name), copy: path.join(dir, SERVER_COPY, name), label: name,
      done: v => entryCount(v) === 0, target: () => empty, describe: v => `${plural(entryCount(v), 'entry', 'entries')} -> ${JSON.stringify(empty)}`,
    })
  }
  const wdir = path.join(serverDir, WRITINGS_DIR)
  if (!isDir(wdir)) console.log(`  ${WRITINGS_DIR}/: absent`)
  else if (!fs.readdirSync(wdir).length) console.log(`  ${WRITINGS_DIR}/: already empty`)
  else if (!sameTree(wdir, path.join(dir, SERVER_COPY, WRITINGS_DIR))) plan.blockers.push(`${WRITINGS_DIR}/ differs from its backup copy (something wrote since the backup), take a new backup`)
  else {
    console.log(`  ${WRITINGS_DIR}/: ${plural(listFiles(wdir).length, 'file', 'files')} -> empty folder`)
    plan.actions.push({ label: `empty ${WRITINGS_DIR}/`, run: () => emptyDir(wdir) })
  }
  console.log(`  kept: ${SERVER_DEFINITIONS.filter(n => fs.existsSync(path.join(serverDir, n))).join(', ')}`)

  console.log('\nbackend data')
  for (const [name, empty] of Object.entries(BACKEND_RESET)) {
    planJson(plan, {
      file: path.join(dataDir, name), copy: path.join(dir, BACKEND_COPY, name), label: name,
      done: v => entryCount(v) === 0, target: () => empty, describe: v => `${plural(entryCount(v), 'entry', 'entries')} -> ${JSON.stringify(empty)}`,
    })
  }
  planJson(plan, {
    file: path.join(dataDir, FACTIONS_FILE), copy: path.join(dir, BACKEND_COPY, FACTIONS_FILE), label: FACTIONS_FILE, needsValue: true,
    done: v => arrLen(v && v.assignments) === 0,
    target: v => ({ ...v, assignments: [] }),
    describe: v => `${plural(arrLen(v.assignments), 'assignment', 'assignments')} cleared, ${plural(arrLen(v.factions), 'faction', 'factions')} and ${plural(arrLen(v.requirements), 'requirement', 'requirements')} kept`,
  })
  const touched = new Set([...Object.keys(BACKEND_RESET), FACTIONS_FILE])
  const backendKept = (isDir(dataDir) ? fs.readdirSync(dataDir) : []).filter(n => !touched.has(n) && !SESSION_FILES.has(n.toLowerCase()) && !BACKEND_SKIP_RE.some(re => re.test(n)))
  console.log(`  kept: ${backendKept.join(', ') || 'nothing else'}`)
  console.log(`  never touched: ${[...SESSION_FILES].join(', ')}`)

  console.log('\nlogs')
  const ldir = logDir()
  const logs = moderationLogs(ldir)
  const logDest = path.join(ldir, `pre-wipe-${stamp()}`)
  if (!logs.length) console.log(`  no moderation logs in ${ldir}`)
  else {
    console.log(`  ${describeLogs(logs)} -> ${logDest}`)
    plan.actions.push({
      label: `move ${plural(logs.length, 'moderation log', 'moderation logs')} into ${logDest}`,
      run: () => {
        for (const rel of logs) {
          const dest = path.join(logDest, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.renameSync(path.join(ldir, rel), dest)
        }
      },
    })
  }

  console.log('\nplan')
  if (!plan.actions.length) console.log('  nothing to do')
  plan.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`))
  if (plan.blockers.length) throw new Refusal(plan.blockers.join('\n  '))
  if (!flags.apply) { console.log('\n[dry run] nothing was changed; re-run with --apply to wipe'); return }

  for (const [i, a] of plan.actions.entries()) {
    console.log(`\n[${i + 1}/${plan.actions.length}] ${a.label}`)
    await a.run()
  }

  const problems = []
  if ((await withDb(collectionNames)).includes(CF)) problems.push(`${CF} still exists`)
  for (const name of Object.keys(SERVER_RESET)) if (!/^(reset|absent)/.test(registryState(path.join(serverDir, name)))) problems.push(`${name} is not reset`)
  for (const name of Object.keys(BACKEND_RESET)) if (!/^(reset|absent)/.test(registryState(path.join(dataDir, name)))) problems.push(`${name} is not reset`)
  if (isDir(wdir) && fs.readdirSync(wdir).length) problems.push(`${WRITINGS_DIR}/ is not empty`)
  const factions = readJsonState(path.join(dataDir, FACTIONS_FILE))
  if (factions.value && arrLen(factions.value.assignments)) problems.push(`${FACTIONS_FILE} still has assignments`)
  if (problems.length) throw new Error(`re-read after the wipe: ${problems.join(', ')}`)
  console.log('\nwipe done and re-read')
  console.log('next:')
  console.log(`  1. node deploy/mongodb/wipe-world.js verify --backup "${dir}" and fix every EDIT line`)
  console.log('  2. Purge MongoDB (dry run, then apply) on the empty collection to stamp purgedAt')
  console.log('  3. start AlduinakBackend, then the game server from the manager')
}

// ── restore ──────────────────────────────────────────────────────────────────

function planCopyBack(plan, { src, dest, label, keepPrevious = false }) {
  const inBackup = fs.existsSync(src)
  if (!inBackup) {
    if (fs.existsSync(dest)) console.log(`  ${label}: not in the backup, left as is`)
    return
  }
  if (isDir(src)) {
    if (sameTree(src, dest)) { console.log(`  ${label}: matches the backup`); return }
    console.log(`  ${label}: replaced by the backup copy (${plural(listFiles(src).length, 'file', 'files')})`)
    plan.actions.push({
      label: `restore ${label}`,
      run: () => {
        fs.mkdirSync(dest, { recursive: true })
        emptyDir(dest)
        fs.cpSync(src, dest, { recursive: true })
        if (!sameTree(src, dest)) throw new Error(`${label} does not match the backup after the copy`)
      },
    })
    return
  }
  if (sameBytes(src, dest)) { console.log(`  ${label}: matches the backup`); return }
  const previous = `${dest}.pre-restore-${stamp()}`
  console.log(`  ${label}: replaced by the backup copy${keepPrevious && fs.existsSync(dest) ? `, the live file kept as ${path.basename(previous)}` : ''}`)
  plan.actions.push({
    label: `restore ${label}`,
    run: () => {
      if (keepPrevious && fs.existsSync(dest)) fs.copyFileSync(dest, previous)
      copyAtomic(src, dest)
      if (!sameBytes(src, dest)) throw new Error(`${label} does not match the backup after the copy`)
    },
  })
}

async function restoreMode(flags) {
  const dir = path.resolve(flags.backup)
  const info = readInfo(dir)
  console.log(`backup ${dir}: checksums ok, ${plural(await checkSums(dir), 'file', 'files')}, taken ${info.createdAt}`)
  if (info.databaseName !== settings.databaseName) throw new Refusal(`the backup is of database ${info.databaseName}, server-settings.json names ${settings.databaseName}`)
  if (flags.test) {
    await withDb(db => restoreTest(db, dir, info))
    return
  }
  const plan = { blockers: [], actions: [] }
  for (const b of [await gameServerBlocker(), await backendBlocker(flags)]) if (b) plan.blockers.push(b)
  const serverDir = config.paths.serverDir
  const dataDir = config.paths.dataDir
  const preRestore = path.join(BACKUP_ROOT, PRE_RESTORE_PREFIX + stamp(true))
  const preProblem = backupDirProblem(preRestore)
  if (preProblem) plan.blockers.push(`cannot back up the live data first: ${preProblem}`)
  plan.actions.push({ label: `back up the live data into ${preRestore}`, run: () => takeBackup(preRestore, flags) })

  console.log(`\n${flags.apply ? 'restore' : 'dry run of the restore'}`)
  console.log('\nMongoDB')
  const live = await withDb(async db => {
    const counts = {}
    for (const name of await collectionNames(db)) counts[name] = await db.collection(name).countDocuments()
    return counts
  })
  for (const [name, count] of Object.entries(info.collections)) console.log(`  ${name}: ${name in live ? live[name] : 'absent'} -> ${count}`)
  const extra = Object.keys(live).filter(n => !(n in info.collections) && n !== RESTORE_CHECK)
  if (extra.length) console.log(`  not in the backup, left as is: ${extra.join(', ')}`)
  plan.actions.push({
    label: `mongorestore --drop of ${Object.keys(info.collections).join(', ') || 'nothing'}`,
    run: async () => {
      await withToolConfig(cfg => runTool('mongorestore', ['--config', cfg, '--drop', '--nsInclude', `${info.databaseName}.*`, '--dir', path.join(dir, DUMP_DIR)]))
      await withDb(async db => {
        for (const [name, count] of Object.entries(info.collections)) {
          const got = await db.collection(name).countDocuments()
          if (got !== count) throw new Error(`after the restore ${name} holds ${got} document(s), the backup ${count}`)
        }
      })
      console.log('  counts match the backup')
    },
  })
  const sameOrder = liveOrder().map(n => n.toLowerCase()).join('|') === (info.loadOrder || []).map(o => o.name.toLowerCase()).join('|')
  if (!sameOrder && !flags.withSettings) {
    console.log('  WARNING: the live loadOrder differs from the backup; the dump only fits the backup order, so also put back the old plugins with --with-settings, or migrate with Purge MongoDB')
  }

  console.log('\nserver folder')
  for (const name of [...Object.keys(SERVER_RESET), WRITINGS_DIR]) planCopyBack(plan, { src: path.join(dir, SERVER_COPY, name), dest: path.join(serverDir, name), label: name })
  if (flags.withSettings) planCopyBack(plan, { src: path.join(dir, SERVER_COPY, 'server-settings.json'), dest: config.paths.serverSettings, label: 'server-settings.json', keepPrevious: true })

  console.log('\nbackend data')
  for (const name of [...Object.keys(BACKEND_RESET), FACTIONS_FILE, ...(flags.withSettings ? MANIFEST_STATE : [])]) {
    planCopyBack(plan, { src: path.join(dir, BACKEND_COPY, name), dest: path.join(dataDir, name), label: name })
  }
  console.log(`  never restored: ${[...SESSION_FILES].join(', ')} (players log in again)`)

  console.log('\nplan')
  plan.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`))
  if (plan.blockers.length) throw new Refusal(plan.blockers.join('\n  '))
  if (!flags.apply) { console.log('\n[dry run] nothing was changed; re-run with --apply to restore'); return }
  for (const [i, a] of plan.actions.entries()) {
    console.log(`\n[${i + 1}/${plan.actions.length}] ${a.label}`)
    await a.run()
  }
  console.log('\nrestore done')
  console.log(`the live data from before the restore is in ${preRestore}`)
  if (!sameOrder && !flags.withSettings) console.log('next: put back the plugins the backup was written under, or run Purge MongoDB, before starting the game server')
  else console.log('next: start AlduinakBackend, then the game server from the manager')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [mode, ...rest] = argv
  const flags = { apply: false, backendRunning: false, withSettings: false, test: false, out: null, backup: null, order: null }
  const bools = { '--apply': 'apply', '--backend-running': 'backendRunning', '--with-settings': 'withSettings', '--test': 'test' }
  const valued = { '--out': 'out', '--backup': 'backup', '--order': 'order' }
  const names = Object.fromEntries([...Object.entries(bools), ...Object.entries(valued)].map(([flag, key]) => [key, flag]))
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
    backup: ['out', 'backendRunning'],
    verify: ['backup', 'order'],
    apply: ['backup', 'apply', 'backendRunning'],
    restore: ['backup', 'apply', 'test', 'withSettings', 'backendRunning'],
  }
  if (!allowed[mode]) throw new UsageError(mode ? `unknown mode ${mode}` : 'no mode given')
  for (const [key, v] of Object.entries(flags)) if (v && !allowed[mode].includes(key)) throw new UsageError(`${names[key]} does not apply to ${mode}`)
  if (mode === 'restore' && !flags.backup) throw new UsageError('restore needs --backup <dir>')
  if (flags.test && (flags.apply || flags.withSettings)) throw new UsageError('--test runs alone, without --apply or --with-settings')
  return { mode, flags }
}

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    if (!argv.length) process.exitCode = 1
    return
  }
  const { mode, flags } = parseArgs(argv)
  settings = loadSettings()
  purge = requirePurge()
  await { backup: backupMode, verify: verifyMode, apply: applyMode, restore: restoreMode }[mode](flags)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    for (const file of tempConfigs) try { fs.rmSync(file, { force: true }) } catch {}
    process.exit(130)
  })
}

main().catch(err => {
  const text = purge ? purge.sanitize(err, settings) : String(err && err.message ? err.message : err)
  if (err instanceof UsageError) console.error(`${text}\n\n${USAGE}`)
  else console.error(`\n${err instanceof Refusal ? 'REFUSED' : 'FAILED'}: ${text}`)
  process.exitCode = 1
})
