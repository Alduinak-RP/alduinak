'use strict'

// Migration M1 of the syncing Stage 2 native builds: each step plans in the dry run and applies in order with --apply

const fs = require('fs')
const path = require('path')
const C = require('./strip-common')
const config = require(path.join(C.SM, 'config'))
const formIds = require(path.join(C.SM, 'formIds'))
const modsync = require(path.join(C.SM, 'modsync'))
const { gameServerBlocker } = require(path.join(C.SM, 'serviceCheck'))

const USAGE = [
  'usage: node deploy/mongodb/trim-changeforms.js [--test] [--apply]',
  '  a dry run by default: what each step would change',
  '  --apply backs up the documents it deletes, then runs every step; the game server must be stopped',
  '  --test works on the Test Server and its database instead of the Main Server',
].join('\n')

const SPEC = { defaultMode: 'run', bools: { '--test': 'test', '--apply': 'apply' }, valued: {}, allowed: { run: ['test', 'apply'] } }
const INFO_FILE = 'trim-backup.json'

// Characters stay flagged (owner decision D3); the server deletes every other flagged form itself
const PURGE = { isDeleted: true, profileId: { $not: { $gte: 0 } } }
const KEPT = { $nor: [PURGE] }

const purge = {
  name: 'purge',
  async plan(col) {
    const groups = await col.aggregate([
      { $match: PURGE },
      { $group: { _id: { actor: { $eq: ['$recType', 1] }, ff: { $eq: [{ $indexOfCP: ['$formDesc', ':'] }, -1] } }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray()
    const count = groups.reduce((sum, g) => sum + g.n, 0)
    const kept = await col.countDocuments({ isDeleted: true, profileId: { $gte: 0 } })
    const parts = groups.map(g => `${g.n} ${g._id.ff ? 'FF' : 'ESP'} ${g._id.actor ? 'actors' : 'refs'}`)
    return { count, text: `${C.plural(count, 'flagged document', 'flagged documents')} to delete${parts.length ? ` (${parts.join(', ')})` : ''}, ${C.plural(kept, 'deleted character stays', 'deleted characters stay')} flagged` }
  },
  async apply(col, plan, ctx) {
    const docs = await col.find(PURGE, { promoteValues: false }).toArray()
    const dir = path.join(C.BACKUP_ROOT, `rollback-trim-${ctx.settings.databaseName}-${C.stamp()}`)
    const text = C.canonical(docs)
    C.writeNew(path.join(dir, C.DOCS_FILE), text)
    C.writeNew(path.join(dir, INFO_FILE), JSON.stringify({ databaseName: ctx.settings.databaseName, step: 'purge', filter: PURGE, count: docs.length, docsSha256: C.sha256(text), createdAt: new Date().toISOString() }, null, 2))
    ctx.out(`  backed up ${C.plural(docs.length, 'document', 'documents')} to ${dir}`)
    const res = await col.deleteMany({ ...PURGE, _id: { $in: docs.map(d => d._id) } })
    return `deleted ${res.deletedCount} of ${docs.length}, ${await col.countDocuments(PURGE)} flagged left`
  },
}

// Read as 0 by the server, which then skips a second parse of the equipment
const NO_NUM_CHANGES = { equipmentDump: { $type: 'object' }, 'equipmentDump.numChanges': { $exists: false } }

const numChanges = {
  name: 'numChanges',
  async plan(col) {
    const count = await col.countDocuments({ ...NO_NUM_CHANGES, ...KEPT })
    return { count, text: `${C.plural(count, 'equipment dump', 'equipment dumps')} without numChanges` }
  },
  async apply(col) {
    const res = await col.updateMany(NO_NUM_CHANGES, { $set: { 'equipmentDump.numChanges': new (C.requireDriver().BSON.Int32)(0) } })
    return `set numChanges 0 on ${res.modifiedCount}, ${await col.countDocuments(NO_NUM_CHANGES)} left`
  },
}

// The last chat line a recipient got: no gamemode registers it, so the server would send it to every neighbour
const CHAT_MSG = 'dynamicFields.ff_chatMsg'
const HAS_CHAT_MSG = { [CHAT_MSG]: { $exists: true } }

const chatMsg = {
  name: 'chatMsg',
  async plan(col) {
    const count = await col.countDocuments({ ...HAS_CHAT_MSG, ...KEPT })
    return { count, text: `${C.plural(count, 'document holds', 'documents hold')} a stored ff_chatMsg to unset` }
  },
  async apply(col) {
    const res = await col.updateMany(HAS_CHAT_MSG, { $unset: { [CHAT_MSG]: '' } })
    return `unset ff_chatMsg on ${res.modifiedCount}, ${await col.countDocuments(HAS_CHAT_MSG)} left`
  },
}

// The game server ensures the same two at every start (MongoDatabase::EnsureIndexes)
const INDEXES = [
  { name: 'formDesc_1', key: { formDesc: 1 }, unique: true },
  { name: 'profileId_1_formDesc_1', key: { profileId: 1, formDesc: 1 }, partialFilterExpression: { profileId: { $gte: 0 } } },
]
const OLD_KEYS = [{ worldOrCellDesc: 1 }, { profileId: 1 }].map(k => JSON.stringify(k))
const NAMESPACE_NOT_FOUND = 26
const MAX_LISTED = 20

const keyOf = index => JSON.stringify(index.key)
const optionsOf = index => JSON.stringify([!!index.unique, index.partialFilterExpression || null])
const matches = (have, want) => have.name === want.name && keyOf(have) === keyOf(want) && optionsOf(have) === optionsOf(want)
const createOptions = want => ({ name: want.name, ...(want.unique && { unique: true }), ...(want.partialFilterExpression && { partialFilterExpression: want.partialFilterExpression }) })
const label = index => `${index.name}${index.unique ? ' (unique)' : ''}${index.partialFilterExpression ? ' (partial)' : ''}`
const labels = list => list.map(label).join(', ')

// drop: old single-field indexes and any holding a wanted name or key with other options; create: wanted ones missing
async function planIndexes(col) {
  let have
  try { have = await col.indexes() }
  catch (err) { if (err && err.code === NAMESPACE_NOT_FOUND) have = []; else throw err }
  have = have.filter(i => i.name !== '_id_')
  const drop = have.filter(i => OLD_KEYS.includes(keyOf(i)) || INDEXES.some(w => (w.name === i.name || keyOf(w) === keyOf(i)) && !matches(i, w)))
  const create = INDEXES.filter(w => !have.some(i => matches(i, w)))
  return { drop, create }
}

// Creates the missing ones whose name and key are free (a fresh or restored collection); one line
async function ensureIndexes(col) {
  const { drop, create } = await planIndexes(col)
  const held = create.filter(w => drop.some(i => i.name === w.name || keyOf(i) === keyOf(w)))
  const made = create.filter(w => !held.includes(w))
  for (const w of made) await col.createIndex(w.key, createOptions(w))
  const head = made.length ? `changeForms indexes created: ${labels(made)}` : `changeForms indexes ${held.length ? 'not created' : 'present'}`
  return held.length ? `${head}; ${labels(held)} held by an older index, run deploy/mongodb/trim-changeforms.js --apply` : head
}

const indexes = {
  name: 'indexes',
  async plan(col) {
    const { drop, create } = await planIndexes(col)
    const dups = create.some(w => w.unique)
      ? await col.aggregate([{ $match: KEPT }, { $group: { _id: '$formDesc', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $sort: { _id: 1 } }]).toArray()
      : []
    const count = drop.length + create.length
    const text = count ? `drop ${labels(drop) || 'nothing'}; create ${labels(create) || 'nothing'}` : `${labels(INDEXES)} present`
    const blocker = dups.length
      ? `${C.plural(dups.length, 'formDesc is', 'formDescs are')} on more than one document, so the unique index cannot be built: ${dups.slice(0, MAX_LISTED).map(d => `${d._id} (${d.n})`).join(', ')}${dups.length > MAX_LISTED ? ', ...' : ''}`
      : null
    return { count, text, blocker, drop, create }
  },
  async apply(col, plan) {
    for (const i of plan.drop) await col.dropIndex(i.name)
    for (const w of plan.create) await col.createIndex(w.key, createOptions(w))
    const left = await planIndexes(col)
    if (left.drop.length || left.create.length) throw new Error(`indexes still differ after the swap: drop ${labels(left.drop) || 'nothing'}, create ${labels(left.create) || 'nothing'}`)
    return `dropped ${labels(plan.drop) || 'nothing'}, created ${labels(plan.create) || 'nothing'}`
  },
}

const HOUSING = 'private.housing'
// The neighbour-visible marker housingSystem.write keeps on each half of a live claim
const DECOR = 'ff_decor'
// housingSystem.ts SIDED_LOCKS and EXIT_LOCKS: one lock shuts both halves; with sided locks no half shows an exit lock
const SIDED_LOCKS = false
const EXIT_LOCKS = false
const RECORD_HEADER = 24
const RECORD_DELETED = 0x20

const n = v => formIds.num(v) || 0
const lowerDesc = (id, masters, owner) => `${(id & 0xFFFFFF).toString(16)}:${(id >>> 24) < masters.length ? masters[id >>> 24] : owner}`.toLowerCase()

function mastersOf(head) {
  const masters = []
  for (let i = 0; i + 6 <= head.length;) {
    const size = head.readUInt16LE(i + 4)
    if (head.toString('latin1', i, i + 4) === 'MAST') masters.push(head.toString('latin1', i + 6, i + 6 + size).split('\0')[0])
    i += 6 + size
  }
  return masters
}

// Worldspace descs of the plugins, lower case: a ref whose worldOrCellDesc is one is outdoors (holdOf.ts isOutdoors)
function worldDescsOf(files) {
  const worlds = new Set()
  for (const file of files) {
    const fd = fs.openSync(file, 'r')
    try {
      const read = (pos, len) => {
        const buf = Buffer.alloc(len)
        if (fs.readSync(fd, buf, 0, len, pos) !== len) throw new Error(`${file} ends inside a record`)
        return buf
      }
      const size = fs.fstatSync(fd).size
      const headSize = read(0, RECORD_HEADER).readUInt32LE(4)
      const masters = mastersOf(read(RECORD_HEADER, headSize))
      const owner = path.basename(file)
      for (let pos = RECORD_HEADER + headSize; pos + RECORD_HEADER <= size;) {
        const group = read(pos, RECORD_HEADER)
        const end = pos + group.readUInt32LE(4)
        if (end <= pos) throw new Error(`${file} has an empty top group at ${pos}`)
        // WRLD records sit between their World Children groups, which are skipped whole
        if (group.toString('latin1', 8, 12) === 'WRLD') {
          for (let at = pos + RECORD_HEADER; at + RECORD_HEADER <= end;) {
            const rec = read(at, RECORD_HEADER)
            const type = rec.toString('latin1', 0, 4)
            if (type === 'WRLD') {
              const desc = lowerDesc(rec.readUInt32LE(12), masters, owner)
              if (rec.readUInt32LE(8) & RECORD_DELETED) worlds.delete(desc)
              else worlds.add(desc)
            }
            at += type === 'GRUP' ? Math.max(rec.readUInt32LE(4), RECORD_HEADER) : RECORD_HEADER + rec.readUInt32LE(4)
          }
        }
        pos = end
      }
    } finally { fs.closeSync(fd) }
  }
  return worlds
}

// Slots and worldspaces of the server's load order, read from the plugins in dataDir
function readLoadOrder(settings) {
  const names = C.arr(settings.loadOrder).map(formIds.basename)
  if (!names.length || !settings.dataDir) throw new Error('server-settings.json needs loadOrder and dataDir')
  const slots = formIds.computeSlots(names, formIds.flagsOf(modsync.readPluginFlags(names, { dataDir: settings.dataDir }), 'light'))
  return { slots, worlds: worldDescsOf(names.map(name => path.join(settings.dataDir, name))) }
}

// housingSystem's read: a record from before the entrance and exit keeps its one lock on both
function claimOf(housing) {
  if (!housing || typeof housing !== 'object' || n(housing.primary) || !n(housing.owner)) return null
  const legacy = housing.locked === true
  return {
    name: typeof housing.name === 'string' && housing.name ? housing.name : null,
    lockedEntrance: typeof housing.lockedEntrance === 'boolean' ? housing.lockedEntrance : legacy,
    lockedExit: typeof housing.lockedExit === 'boolean' ? housing.lockedExit : legacy,
    partner: n(housing.partner),
  }
}

// housingSystem's decorOf: with sided locks and one half outdoors, the other indoors, the outdoor half shows the entrance lock
function decorOf(rec, here, there) {
  const side = !SIDED_LOCKS || here === null || there === null || here === there ? '' : here ? 'outside' : 'inside'
  const locked = side === 'outside' ? rec.lockedEntrance : side === 'inside' ? EXIT_LOCKS && rec.lockedExit : rec.lockedEntrance || rec.lockedExit
  return { name: rec.name, locked }
}

const decor = {
  name: 'decor',
  async plan(col, ctx) {
    const docs = await col.aggregate([
      { $match: { recType: 0, isDeleted: { $ne: true }, dynamicFields: { $type: 'object' } } },
      { $project: { formDesc: 1, worldOrCellDesc: 1, housing: { $getField: { field: HOUSING, input: '$dynamicFields' } }, decor: { $getField: { field: DECOR, input: '$dynamicFields' } } } },
      { $match: { housing: { $type: 'object' } } },
    ]).toArray()
    const claims = docs.map(doc => ({ doc, rec: claimOf(doc.housing) })).filter(c => c.rec)
    if (!claims.length) return { count: 0, text: 'no live claims' }
    let order
    try { order = readLoadOrder(ctx.settings) }
    catch (err) { return { count: 0, text: 'not planned', blocker: `the halves of ${C.plural(claims.length, 'claim', 'claims')} cannot be told apart without the plugins: ${err.message}` } }
    const byDesc = new Map(docs.map(d => [String(d.formDesc).toLowerCase(), d]))
    const outdoors = doc => (typeof doc.worldOrCellDesc === 'string' && doc.worldOrCellDesc ? order.worlds.has(doc.worldOrCellDesc.toLowerCase()) : null)
    const updates = []
    const missing = []
    const want = (doc, value) => {
      const cur = doc.decor
      if (!cur || typeof cur !== 'object' || cur.name !== value.name || cur.locked !== value.locked) updates.push({ formDesc: doc.formDesc, value })
    }
    for (const { doc, rec } of claims) {
      const partnerDesc = rec.partner ? formIds.descOf(rec.partner, order.slots) : null
      const partner = partnerDesc ? byDesc.get(partnerDesc.toLowerCase()) : null
      if (rec.partner && !partner) missing.push(`${partnerDesc || C.hex(rec.partner)} (pair of ${doc.formDesc})`)
      const here = outdoors(doc)
      const there = partner ? outdoors(partner) : null
      want(doc, decorOf(rec, here, there))
      if (partner) want(partner, decorOf(rec, there, here))
    }
    const details = missing.length
      ? [`${C.plural(missing.length, 'pair half has', 'pair halves have')} no housing document, housingSystem marks it at the next change: ${missing.slice(0, MAX_LISTED).join(', ')}${missing.length > MAX_LISTED ? ', ...' : ''}`]
      : []
    return { count: updates.length, text: `${C.plural(updates.length, 'claim half', 'claim halves')} to mark with ${DECOR} (${C.plural(claims.length, 'live claim', 'live claims')})`, details, updates }
  },
  async apply(col, plan) {
    const res = await col.bulkWrite(plan.updates.map(u => ({ updateOne: { filter: { formDesc: u.formDesc }, update: { $set: { [`dynamicFields.${DECOR}`]: u.value } } } })), { ordered: false })
    return `set ${DECOR} on ${res.modifiedCount} of ${plan.updates.length}`
  },
}

// Applied in this order; a plan returns { count, text, details?, blocker? }
const STEPS = [purge, numChanges, chatMsg, indexes, decor]

async function main(argv, { open, blocker = gameServerBlocker, out = console.log } = {}) {
  if (argv.includes('--help')) return out(USAGE)
  const { flags } = C.parseArgs(argv, SPEC)
  const profile = config.profiles[flags.test ? 'test' : 'live']
  const settings = C.loadSettings(profile.serverSettings)
  out(`trim-changeforms on ${settings.databaseName} (${profile.label})${flags.apply ? '' : ', dry run'}`)
  if (flags.apply) {
    const reason = await blocker(profile.key)
    if (reason) throw new C.Refusal(reason)
  }
  const ctx = { settings, profile, out }
  await C.withCol(settings, async col => {
    const plans = []
    for (const step of STEPS) {
      const plan = await step.plan(col, ctx)
      plans.push(plan)
      out(`  ${step.name}: ${plan.text}`)
      for (const line of plan.details || []) out(`    ${line}`)
    }
    const blocked = STEPS.map((s, i) => plans[i].blocker && `${s.name}: ${plans[i].blocker}`).filter(Boolean)
    if (blocked.length) throw new C.Refusal(`nothing written, resolve first:\n  ${blocked.join('\n  ')}`)
    if (!flags.apply) return out('\n[dry run] re-run with --apply, with the game server stopped')
    if (!plans.some(p => p.count)) return out('\nnothing to do')
    for (let i = 0; i < STEPS.length; i++) {
      if (plans[i].count) out(`  ${STEPS[i].name}: ${await STEPS[i].apply(col, plans[i], ctx)}`)
    }
    out('\ndone')
  }, open)
}

module.exports = { main, STEPS, PURGE, KEPT, NO_NUM_CHANGES, INDEXES, planIndexes, ensureIndexes, worldDescsOf, decorOf }

if (require.main === module) C.runCli(() => main(process.argv.slice(2)), USAGE)
