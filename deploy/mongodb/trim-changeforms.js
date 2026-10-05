'use strict'

// Migration M1 of the syncing Stage 2 native builds: each step plans in the dry run and applies in order with --apply

const path = require('path')
const C = require('./strip-common')
const config = require(path.join(C.SM, 'config'))
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
    return { count, text: `${C.plural(count, 'flagged document', 'flagged documents')} to delete${parts.length ? ` (${parts.join(', ')})` : ''}, ${C.plural(kept, 'deleted character', 'deleted characters')} stay flagged` }
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

// Applied in this order; a plan returns { count, text, details?, blocker? }
const STEPS = [purge]

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
  await C.withCol(settings, async col => {
    const plans = []
    for (const step of STEPS) {
      const plan = await step.plan(col)
      plans.push(plan)
      out(`  ${step.name}: ${plan.text}`)
      for (const line of plan.details || []) out(`    ${line}`)
    }
    const blocked = STEPS.map((s, i) => plans[i].blocker && `${s.name}: ${plans[i].blocker}`).filter(Boolean)
    if (blocked.length) throw new C.Refusal(`nothing written, resolve first:\n  ${blocked.join('\n  ')}`)
    if (!flags.apply) return out('\n[dry run] re-run with --apply, with the game server stopped')
    if (!plans.some(p => p.count)) return out('\nnothing to do')
    const ctx = { settings, profile, out }
    for (let i = 0; i < STEPS.length; i++) {
      if (plans[i].count) out(`  ${STEPS[i].name}: ${await STEPS[i].apply(col, plans[i], ctx)}`)
    }
    out('\ndone')
  }, open)
}

module.exports = { main, STEPS, PURGE, KEPT }

if (require.main === module) C.runCli(() => main(process.argv.slice(2)), USAGE)
