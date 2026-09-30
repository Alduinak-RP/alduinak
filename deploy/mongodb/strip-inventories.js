'use strict'

// One-time strip of gear above Adept, jewelry, tomes, scrolls, staves, enchanted gear and learned spells from characters and claimed containers

const fs = require('fs')
const path = require('path')
const S = require('./strip-common')

const formIds = require(path.join(S.SM, 'formIds'))
const { gameServerBlocker } = require(path.join(S.SM, 'serviceCheck'))
const { Refusal, plural, hex, sha256, stamp, writeNew, findTargets, planDoc, nameOf, canonical, BACKUP_ROOT, INFO_FILE, DOCS_FILE } = S

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

const LIST_FILE = path.join(__dirname, 'forbidden-items.json')
const TOP = 25

let settings = null
let BSON = null

function withCol(fn) { return S.withCol(settings, fn) }
function readBackup(dir) { return S.readBackup(dir, settings) }

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

const ARGS = {
  defaultMode: 'plan',
  bools: { '--apply': 'apply', '--no-containers': 'noContainers', '--faction-gear': 'factionGear' },
  valued: { '--out': 'out', '--backup': 'backup', '--list': 'list', '--report': 'report' },
  allowed: {
    plan: ['list', 'report', 'noContainers', 'factionGear'],
    backup: ['out', 'list', 'noContainers', 'factionGear'],
    apply: ['backup', 'apply', 'list', 'noContainers', 'factionGear'],
    restore: ['backup', 'apply'],
  },
  required: { apply: ['--backup'], restore: ['--backup'] },
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return }
  const { mode, flags } = S.parseArgs(argv, ARGS)
  settings = S.loadSettings()
  BSON = S.requireDriver().BSON
  if (mode === 'restore') return restoreMode(flags)
  const list = S.loadList(path.resolve(flags.list || LIST_FILE), flags.factionGear, settings)
  await { plan: planMode, backup: backupMode, apply: applyMode }[mode](flags, list)
}

S.runCli(main, USAGE)
