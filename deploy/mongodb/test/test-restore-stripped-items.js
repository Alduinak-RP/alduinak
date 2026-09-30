'use strict'

// restore-stripped-items.js against real strip backup documents and stubbed live states: node deploy/mongodb/test/test-restore-stripped-items.js

const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const FIX = path.join(__dirname, 'fixtures', 'restore')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-stripped-'))
const ROOT = path.join(TMP, 'root')
const DATA = path.join(TMP, 'data')
const INTENT = path.join(TMP, 'strip-intent.json')

// A Data folder of stand-in plugins with the fixture's light flags, and the fixture intent's hashes pointed at them
const fixIntent = JSON.parse(fs.readFileSync(path.join(FIX, 'strip-intent.json'), 'utf8'))
const fixSettings = JSON.parse(fs.readFileSync(path.join(FIX, 'settings.json'), 'utf8'))
const lightOf = new Map(fixIntent.plugins.map(p => [p.name.toLowerCase(), p.light]))
function writePlugin(name, light = lightOf.get(name.toLowerCase()) === true, body = name) {
  const head = Buffer.alloc(12)
  head.write('TES4', 0, 'latin1')
  head.writeUInt32LE(light ? 0x200 : 0, 8)
  fs.writeFileSync(path.join(DATA, name), Buffer.concat([head, Buffer.from(body)]))
}
const shaOf = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, name))).digest('hex')
fs.mkdirSync(DATA, { recursive: true })
for (const n of new Set([...fixSettings.loadOrder, ...Object.keys(fixIntent.sourceSha256)])) writePlugin(n)
fs.writeFileSync(INTENT, JSON.stringify({
  ...fixIntent,
  plugins: fixIntent.plugins.map(p => ({ ...p, sha256: shaOf(p.name) })),
  sourceSha256: Object.fromEntries(Object.keys(fixIntent.sourceSha256).map(n => [n, shaOf(n)])),
}))
fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({ ...fixSettings, dataDir: DATA }))
process.env.ALDUINAK_SERVER_SETTINGS = path.join(TMP, 'settings.json')
process.env.ALDUINAK_STRIP_BACKUP = path.join(FIX, 'strip')
process.env.ALDUINAK_WIPE_BACKUP_ROOT = FIX
process.env.ALDUINAK_RESTORE_ROOT = ROOT

const S = require('../strip-common')
const R = require('../restore-stripped-items')
const formIds = require(path.join(S.SM, 'formIds'))
const { BSON } = S.requireDriver()
const { EJSON, Int32, Long, Double, ObjectId } = BSON

const intent = JSON.parse(fs.readFileSync(INTENT, 'utf8'))
const byHex = o => new Map(Object.entries(o).map(([k, v]) => [parseInt(k, 16) >>> 0, v]))
const list = { items: new Map([...byHex(intent.items)].filter(([, v]) => v.listed)), spells: byHex(intent.spells) }
const slots = S.slotsOf(intent.plugins)
const backup = EJSON.parse(fs.readFileSync(path.join(FIX, 'strip', 'changeforms.ejson'), 'utf8'), { relaxed: false })

const clone = v => EJSON.parse(EJSON.stringify(v, { relaxed: false }), { relaxed: false })
const id = e => formIds.num(e.baseId) >>> 0
const total = (doc, base) => doc.inv.entries.reduce((n, e) => n + (id(e) === base ? formIds.num(e.count) : 0), 0)
const quiet = () => {}

const RING = 0x0003B97C
const BOLT = 0x0200D099
const EINHERJAR_BOOTS = 0xFE00C80E
const IRON = 0x00012EB7
const NEW = 0x00ABCDE1

function setPath(doc, key, value) {
  const parts = key.split('.')
  let o = doc
  for (const p of parts.slice(0, -1)) o = o[p] || (o[p] = {})
  o[parts[parts.length - 1]] = value
}

// A backup document as the strip left it
function stripped(formDesc) {
  const d = clone(backup.find(x => x.formDesc === formDesc))
  const p = S.planDoc(d, list)
  if (p) for (const [k, v] of Object.entries(p.set)) setPath(d, k, clone(v))
  return d
}

function claim(n, profile, name, formDescs) {
  const containers = formDescs.map(fd => {
    const [local, plugin] = fd.split(/:(.+)/)
    const v = formIds.encodeId(plugin, parseInt(local, 16), slots)
    return v > 0x7FFFFFFF ? Long.fromNumber(v) : new Int32(v)
  })
  return { _id: new ObjectId(`6ac0000000000000000000${String(n).padStart(2, '0')}`), formDesc: `${(0x900 + n).toString(16)}:Skyrim.esm`, recType: new Int32(3), dynamicFields: { 'private.housing': { owner: new Int32(profile), ownerName: name, containers } } }
}

// The live collection right after the strip: every backup document stripped, plus the housing claims of the containers
function world() {
  const docs = backup.map(d => stripped(d.formDesc))
  docs.push(claim(1, 69, 'Fixture A', ['c0cee:Skyrim.esm', 'c0cd4:Skyrim.esm']))
  docs.push(claim(2, 23, 'Fixture E', ['c4bd5:Skyrim.esm']))
  docs.push(claim(3, 7, 'Fixture F', ['b36b:The Great City of Solitude.esp']))
  return docs
}
const doc = (docs, formDesc) => docs.find(d => d.formDesc === formDesc)
const addEntry = (d, base, count, extra = {}) => d.inv.entries.push({ baseId: base > 0x7FFFFFFF ? Long.fromNumber(base) : new Int32(base), count: new Int32(count), ...extra })

// An in-memory changeForms collection with the queries the tools use; beforeWrite plays a concurrent writer
function stub(docs, { failAt = 0, beforeWrite = null } = {}) {
  const store = docs.map(clone)
  const writes = []
  const key = (k, v) => (k === '_id' ? String(v) : v)
  const at = (d, k) => k.split('.').reduce((o, p) => (o === null || o === undefined ? undefined : o[p]), d)
  const same = (a, b) => EJSON.stringify(a === undefined ? null : a) === EJSON.stringify(b === undefined ? null : b)
  const match = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.map(x => key(k, x)).includes(key(k, at(d, k)))
    return Array.isArray(v) || v === null ? same(v, at(d, k)) : key(k, v) === key(k, at(d, k))
  })
  const col = {
    find(q) {
      const out = store.filter(d => match(d, q)).map(clone)
      return (async function* () { yield* out })()
    },
    async updateOne(filter, update) {
      if (beforeWrite) beforeWrite(store, filter)
      if (writes.length + 1 === failAt) { failAt = 0; throw new Error('connection reset') }
      writes.push(clone({ filter, update }))
      const d = store.find(x => match(x, filter))
      if (!d) return { matchedCount: 0 }
      for (const [k, v] of Object.entries(update.$set)) setPath(d, k, clone(v))
      return { matchedCount: 1 }
    },
  }
  return { store, writes, open: async () => ({ client: { close: async () => {} }, col }) }
}

let n = 0
async function plan(docs, extra = []) {
  const s = stub(docs)
  const file = path.join(TMP, `plan-${++n}.json`)
  await R.run(['plan', '--report', file, '--intent', INTENT, ...extra], { open: s.open, log: quiet })
  const rep = JSON.parse(fs.readFileSync(file, 'utf8'))
  const h = formDesc => rep.holders.find(x => x.formDesc === formDesc)
  const given = (formDesc, base) => (h(formDesc).give.find(g => g.baseId === S.hex(base)) || { count: 0 }).count
  return { rep, h, given, s, text: fs.readFileSync(file.replace(/json$/, 'txt'), 'utf8') }
}

function refused(re) { return err => err instanceof S.Refusal && re.test(err.message) }

async function main() {
  // Preview: the strip rule on the real backup documents reproduces the strip plan report, ebony and the Falmer cuirass stay, spells never come back
  const pv = path.join(TMP, 'preview.json')
  await R.run(['preview', '--report', pv, '--intent', INTENT], { log: quiet })
  const p = JSON.parse(fs.readFileSync(pv, 'utf8'))
  assert.equal(p.reproduced, backup.length)
  const pvText = fs.readFileSync(pv.replace(/json$/, 'txt'), 'utf8')
  assert.ok(pvText.includes('FOR THE OWNER TO DECIDE'))
  // Labels: what a material keyword covers when the names do not say it, in-game names of what stays, one decision for gear made from ebony ingots
  assert.match(pvText, /the nordic material keyword is on: ArmorEinherjar\w+ "Einherjar [^"]+" x\d+/)
  assert.match(pvText, /TH_Ebony2Cuirass "Gilded Ebony Armor" x1 \[ebony equipment\]/)
  assert.match(pvText, /EbonyArrow "Ebony Arrow" 0x000139BF \(ammunition\), 1 removed from 1 holder: stays removed as ebony equipment/)
  const recipeKeep = /--also-keep '(0x[0-9A-F]{8}(?:,0x[0-9A-F]{8})*)' keeps all of them removed/.exec(pvText)
  assert.ok(pvText.includes('Gear whose recipe takes ebony ingots but that carries no ebony material keyword comes back') && recipeKeep)
  assert.match(pvText, /ArmorEinherjarBoots "Einherjar Boots" 0xFE00C80E, 47 removed from 2 holders: recipe .*IngotEbony/)
  const keptAll = await plan(world(), ['--also-keep', recipeKeep[1]])
  assert.ok(!keptAll.text.includes('Gear whose recipe takes ebony ingots'))
  assert.match(keptAll.text, /ArmorEinherjarBoots "Einherjar Boots" 0xFE00C80E .*: stays removed by --also-keep/)
  assert.equal(keptAll.given('c0cee:Skyrim.esm', EINHERJAR_BOOTS), 0)
  const ph = fd => p.holders.find(x => x.formDesc === fd)
  assert.deepEqual(ph('29a').stays.map(g => g.edid), ['ArmorFalmerCuirass'])
  assert.deepEqual(ph('29a').give.map(g => g.edid).sort(), ['ArmorFalmerBoots', 'ArmorFalmerGauntlets', 'JewelryRingSilver', 'OrcishArrow', 'OrcishBow'])
  assert.ok(ph('11').stays.every(g => g.why === 'ebony equipment') && ph('11').stays.length === 5)
  assert.equal(ph('14').spells.length, 52)
  assert.deepEqual(ph('c4bd5:Skyrim.esm').give, [])
  assert.equal(ph('d03').status, 'the character was deleted')
  assert.equal(ph('b36b:The Great City of Solitude.esp').status, 'ok')
  assert.match(ph('b36b:The Great City of Solitude.esp').who, / of Fixture F \(profile 7\)$/)
  assert.equal(p.totals.unclassified, 1)
  assert.deepEqual(ph('f00d').skipped.map(g => g.edid), ['MissingThing'])

  // Untouched since the strip: plan gives what preview gives
  let r = await plan(world())
  for (const h of p.holders) assert.deepEqual(r.h(h.formDesc).give, h.give, h.who)
  assert.equal(r.given('11', BOLT), 41)
  assert.equal(r.given('c0cee:Skyrim.esm', EINHERJAR_BOOTS), 46)

  // Fully returned: nothing comes back, everything shows as already back
  let w = world()
  for (const g of ph('29a').give) addEntry(doc(w, '29a'), parseInt(g.baseId, 16), g.count)
  r = await plan(w)
  assert.deepEqual(r.h('29a').give, [])
  assert.equal(r.h('29a').back.reduce((a, g) => a + g.count, 0), 7)

  // Partly returned: only the rest comes back
  w = world()
  addEntry(doc(w, '11'), RING, 2)
  addEntry(doc(w, '11'), BOLT, 40)
  r = await plan(w)
  assert.equal(r.given('11', RING), 3)
  assert.equal(r.given('11', BOLT), 1)

  // Returned plain vs enchanted: totals count every variant, so a plain return is not given again enchanted
  w = world()
  addEntry(doc(w, 'f00d'), IRON, 1)
  r = await plan(w)
  assert.equal(r.given('f00d', IRON), 2)
  const enchanted = backup.find(d => d.formDesc === 'f00d').inv.entries.filter(e => id(e) === IRON && e.enchantmentId)
  let s = stub(w)
  await R.run(['backup', '--out', path.join(ROOT, 'enchant'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'enchant'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  let after = doc(s.store, 'f00d')
  assert.equal(total(after, IRON), 4)
  const a = after.inv.entries.find(e => formIds.num(e.enchantmentId) === 0xFF000A01)
  const b = after.inv.entries.find(e => formIds.num(e.enchantmentId) === 0xFF000A02)
  assert.equal(formIds.num(a.count), 1)
  assert.equal(a.worn, undefined, 'a returned item comes back unequipped')
  assert.equal(formIds.num(a.maxCharge), 1200)
  assert.equal(formIds.num(b.count), 1)
  assert.equal(formIds.num(b.health), formIds.num(enchanted[1].health))
  assert.equal(formIds.num(b.maxCharge), 900)
  fs.rmSync(ROOT, { recursive: true })

  // A variant the document already has comes last: with enchantment A back, B is given first
  w = world()
  doc(w, 'f00d').inv.entries.push(clone(enchanted[0]))
  r = await plan(w)
  assert.equal(r.given('f00d', IRON), 2)
  s = stub(w)
  await R.run(['backup', '--out', path.join(ROOT, 'variant'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'variant'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  after = doc(s.store, 'f00d')
  assert.equal(after.inv.entries.filter(e => formIds.num(e.enchantmentId) === 0xFF000A01).reduce((x, e) => x + formIds.num(e.count), 0), 1)
  assert.equal(after.inv.entries.filter(e => formIds.num(e.enchantmentId) === 0xFF000A02).reduce((x, e) => x + formIds.num(e.count), 0), 2)
  fs.rmSync(ROOT, { recursive: true })

  // Plain sword returned four times over: nothing
  w = world()
  addEntry(doc(w, 'f00d'), IRON, 3)
  r = await plan(w)
  assert.equal(r.given('f00d', IRON), 0)

  // Consumed since: the kept plain sword was sold, still only the three the strip took come back; the poisoned ebony sword stays removed
  w = world()
  doc(w, 'f00d').inv.entries = doc(w, 'f00d').inv.entries.filter(e => id(e) !== IRON)
  doc(w, '14').inv.entries = doc(w, '14').inv.entries.slice(3)
  r = await plan(w)
  assert.equal(r.given('f00d', IRON), 3)
  assert.deepEqual(r.h('f00d').stays.map(g => g.edid), ['EbonySword'])
  assert.deepEqual(r.h('14').give, ph('14').give)

  // New items gained and deleted characters: every live entry stays at least as it was, gone documents are skipped
  w = world().filter(d => d.formDesc !== '75d')
  addEntry(doc(w, '11'), NEW, 7)
  addEntry(doc(w, '11'), RING, 1, { worn: true })
  doc(w, 'd03').isDeleted = true
  s = stub(w)
  const before = clone(doc(w, '11').inv.entries)
  await R.run(['backup', '--out', path.join(ROOT, 'b1'), '--intent', INTENT], { open: s.open, log: quiet })
  r = await plan(w)
  assert.equal(r.h('75d').status, 'the document no longer exists')
  assert.equal(r.given('11', RING), 4)

  // Apply: a dry run writes nothing, a running server refuses, a document changed after the backup refuses
  await R.run(['apply', '--backup', path.join(ROOT, 'b1'), '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  assert.equal(s.writes.length, 0)
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'b1'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => 'AlduinakGameServer is SERVICE_RUNNING, stop it first', log: quiet }), refused(/SERVICE_RUNNING/))
  assert.equal(s.writes.length, 0)
  addEntry(doc(s.store, '11'), NEW, 1)
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'b1'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet }), refused(/changed since the backup/))
  assert.equal(s.writes.length, 0)

  // Apply for real: only $set of inv.entries, never lowering an entry, typed numbers, equipmentDump and spells untouched
  await R.run(['backup', '--out', path.join(ROOT, 'b2'), '--intent', INTENT], { open: s.open, log: quiet })
  const pre = new Map(s.store.map(d => [String(d._id), clone(d)]))
  await R.run(['apply', '--backup', path.join(ROOT, 'b2'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  assert.ok(s.writes.length > 0)
  for (const x of s.writes) {
    assert.deepEqual(Object.keys(x.update), ['$set'])
    assert.deepEqual(Object.keys(x.update.$set), ['inv.entries'])
    assert.deepEqual(Object.keys(x.filter), ['_id', 'formDesc', 'inv.entries'])
  }
  for (const d of s.store) {
    const old = pre.get(String(d._id))
    assert.equal(EJSON.stringify(d.equipmentDump), EJSON.stringify(old.equipmentDump))
    assert.equal(EJSON.stringify(d.learnedSpells), EJSON.stringify(old.learnedSpells))
    const oldEntries = (old.inv && old.inv.entries) || []
    oldEntries.forEach((e, i) => {
      const now = d.inv.entries[i]
      assert.equal(id(now), id(e))
      assert.ok(formIds.num(now.count) >= formIds.num(e.count), `${d.formDesc} entry ${i} lowered`)
    })
    const touched = ((d.inv && d.inv.entries) || []).filter((e, i) => i >= oldEntries.length || formIds.num(e.count) !== formIds.num(oldEntries[i].count))
    for (const e of touched) {
      assert.ok(e.baseId._bsontype === 'Int32' || e.baseId._bsontype === 'Long', `${d.formDesc} baseId type`)
      assert.equal(e.count._bsontype, 'Int32')
      assert.equal(e.worn, undefined)
    }
  }
  after = doc(s.store, '11')
  assert.equal(total(after, RING), 5)
  assert.ok(after.inv.entries.find(e => id(e) === RING && e.worn), 'the worn ring stays as it was')
  assert.equal(total(after, NEW), 8)
  assert.equal(after.inv.entries.length, before.length + 1 + 5 - 0)
  const bootsEntry = doc(s.store, 'c0cee:Skyrim.esm').inv.entries.find(e => id(e) === EINHERJAR_BOOTS)
  assert.equal(bootsEntry.baseId._bsontype, 'Long')
  assert.equal(formIds.num(bootsEntry.count), 46)
  assert.ok(fs.existsSync(path.join(ROOT, 'b2', 'restore-applied.json')))

  // Afterwards plan gives nothing more, and a second apply of the same backup refuses
  r = await plan(s.store)
  assert.equal(r.rep.totals.giveItems, 0)
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'b2'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet }), refused(/already applied/))

  // Rollback: a dry run writes nothing, --apply puts the backed up inventories back and retires the apply record
  const writes = s.writes.length
  await R.run(['restore', '--backup', path.join(ROOT, 'b2')], { open: s.open, blocker: async () => null, log: quiet })
  assert.equal(s.writes.length, writes)
  await R.run(['restore', '--backup', path.join(ROOT, 'b2'), '--apply'], { open: s.open, blocker: async () => null, log: quiet })
  for (const d of s.store) {
    const old = pre.get(String(d._id))
    assert.equal(EJSON.stringify(d.inv), EJSON.stringify(old.inv), d.formDesc)
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'b2', 'restore-applied.json')))
  assert.ok(fs.existsSync(path.join(ROOT, 'b2', 'restore-applied.rolled-back.json')))
  fs.rmSync(ROOT, { recursive: true })

  // Rollback refuses once an inventory moved on after the apply
  s = stub(world())
  await R.run(['backup', '--out', path.join(ROOT, 'b3'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'b3'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  addEntry(doc(s.store, '29a'), NEW, 1)
  await assert.rejects(R.run(['restore', '--backup', path.join(ROOT, 'b3'), '--apply'], { open: s.open, blocker: async () => null, log: quiet }), refused(/changed since the apply/))

  // An earlier apply counts even when what it gave was used up since: the consumed-kept case is not given twice
  const w2 = s.store.map(clone)
  doc(w2, 'f00d').inv.entries = doc(w2, 'f00d').inv.entries.filter(e => id(e) !== IRON || !e.enchantmentId)
  r = await plan(w2)
  assert.equal(r.given('f00d', IRON), 0)

  // --skip-changed rolls back the others and keeps the apply record for the changed one, which stays settled; the rest come back in the next plan
  const fresh = world()
  await R.run(['restore', '--backup', path.join(ROOT, 'b3'), '--apply', '--skip-changed'], { open: s.open, blocker: async () => null, log: quiet })
  for (const d of s.store) if (d.formDesc !== '29a') assert.equal(EJSON.stringify(d.inv), EJSON.stringify(doc(fresh, d.formDesc).inv), d.formDesc)
  assert.equal(total(doc(s.store, '29a'), NEW), 1)
  assert.ok(fs.existsSync(path.join(ROOT, 'b3', 'restore-applied.json')))
  r = await plan(s.store)
  for (const h of p.holders) assert.deepEqual(r.h(h.formDesc).give, h.formDesc === '29a' ? [] : h.give, h.who)
  await assert.rejects(R.run(['restore', '--backup', path.join(ROOT, 'b3'), '--apply'], { open: s.open, blocker: async () => null, log: quiet }), refused(/--skip-changed/))
  fs.rmSync(ROOT, { recursive: true })

  // A re-save that only reorders entries or changes number types does not block the rollback
  s = stub(world())
  await R.run(['backup', '--out', path.join(ROOT, 'b4'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'b4'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  const resaved = doc(s.store, '11').inv.entries.reverse()
  resaved[0].count = new Double(formIds.num(resaved[0].count))
  await R.run(['restore', '--backup', path.join(ROOT, 'b4'), '--apply'], { open: s.open, blocker: async () => null, log: quiet })
  for (const d of s.store) assert.equal(EJSON.stringify(d.inv), EJSON.stringify(doc(world(), d.formDesc).inv), d.formDesc)
  fs.rmSync(ROOT, { recursive: true })

  // An apply that stopped part way, finished by a second backup and apply: the first rolls back alone, and what it gave comes back in the next plan
  s = stub(world(), { failAt: 3 })
  await R.run(['backup', '--out', path.join(ROOT, 'first'), '--intent', INTENT], { open: s.open, log: quiet })
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'first'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet }), /stopped part way/)
  const firstIds = new Set(s.writes.map(x => String(x.filter._id)))
  await R.run(['backup', '--out', path.join(ROOT, 'second'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'second'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  assert.equal((await plan(s.store)).rep.totals.giveItems, 0)
  await R.run(['restore', '--backup', path.join(ROOT, 'first'), '--apply'], { open: s.open, blocker: async () => null, log: quiet })
  r = await plan(s.store)
  for (const h of p.holders) assert.deepEqual(r.h(h.formDesc).give, firstIds.has(h.id) ? h.give : [], h.who)
  fs.rmSync(ROOT, { recursive: true })

  // An apply that stops part way can still be rolled back: written documents go back, the rest are left alone
  const half = stub(world(), { failAt: 3 })
  await R.run(['backup', '--out', path.join(ROOT, 'half'), '--intent', INTENT], { open: half.open, log: quiet })
  const halfPre = half.store.map(clone)
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'half'), '--apply', '--intent', INTENT], { open: half.open, blocker: async () => null, log: quiet }), /stopped part way, roll back with/)
  assert.equal(half.writes.length, 2)
  await R.run(['restore', '--backup', path.join(ROOT, 'half'), '--apply'], { open: half.open, blocker: async () => null, log: quiet })
  half.store.forEach((d, i) => assert.equal(EJSON.stringify(d.inv), EJSON.stringify(halfPre[i].inv), d.formDesc))
  assert.equal(half.writes.length, 4)
  fs.rmSync(ROOT, { recursive: true })

  // An apply that stops part way settles only the documents it wrote: the next plan gives the others again and says so
  const full = await plan(world())
  const cut = stub(world(), { failAt: 3 })
  await R.run(['backup', '--out', path.join(ROOT, 'cut'), '--intent', INTENT], { open: cut.open, log: quiet })
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'cut'), '--apply', '--intent', INTENT], { open: cut.open, blocker: async () => null, log: quiet }), /stopped part way/)
  const reached = new Set(cut.writes.map(x => String(x.filter._id)))
  assert.equal(reached.size, 2)
  r = await plan(cut.store)
  for (const h of full.rep.holders) assert.deepEqual(r.h(h.formDesc).give.map(g => [g.baseId, g.count]), reached.has(h.id) ? [] : h.give.map(g => [g.baseId, g.count]), h.who)
  assert.ok(r.rep.totals.giveItems > 0)
  assert.match(r.text, /it wrote 2 of \d+ documents, the \d+ it never wrote are planned again/)
  fs.rmSync(ROOT, { recursive: true })

  // A write whose log line is missing is judged by the inventory: what the apply wrote counts as given, a later change is flagged and still counts
  s = stub(world())
  await R.run(['backup', '--out', path.join(ROOT, 'log'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'log'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  const logFile = path.join(ROOT, 'log', 'restore-applied.log')
  const events = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)
  assert.ok(events.at(-1).startsWith('wrote '))
  fs.writeFileSync(logFile, events.slice(0, -1).join('\n') + '\n')
  r = await plan(s.store)
  assert.equal(r.rep.totals.giveItems, 0)
  assert.deepEqual(r.rep.earlier[0].unsure, [])
  addEntry(s.store.find(d => String(d._id) === events.at(-1).split(' ')[1]), NEW, 1)
  r = await plan(s.store)
  assert.equal(r.rep.totals.giveItems, 0)
  assert.equal(r.rep.earlier[0].unsure.length, 1)
  assert.match(r.text, /! it stopped while writing .*counted as given/)
  fs.rmSync(logFile)
  r = await plan(s.store)
  assert.equal(r.rep.totals.giveItems, 0)
  assert.equal(r.rep.earlier[0].written, r.rep.earlier[0].writes)
  fs.rmSync(ROOT, { recursive: true })

  // What an apply settled stays settled: returns it counted and that were sold since, and a document that needed no write, are not given again; a later --also-give id still comes back
  const arrows = (await plan(world(), ['--also-give', '0x000139BF'])).rep.holders.reduce((n, h) => n + h.give.filter(g => g.baseId === '0x000139BF').reduce((a, g) => a + g.count, 0), 0)
  assert.ok(arrows > 0)
  w = world()
  addEntry(doc(w, '11'), RING, 2)
  const back29a = new Set(ph('29a').give.map(g => parseInt(g.baseId, 16) >>> 0))
  for (const g of ph('29a').give) addEntry(doc(w, '29a'), parseInt(g.baseId, 16), g.count)
  s = stub(w)
  await R.run(['backup', '--out', path.join(ROOT, 'settle'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'settle'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  assert.equal(total(doc(s.store, '11'), RING), 5)
  assert.ok(!s.writes.some(x => String(x.filter._id) === String(doc(w, '29a')._id)))
  doc(s.store, '11').inv.entries = doc(s.store, '11').inv.entries.filter(e => id(e) !== RING)
  doc(s.store, '29a').inv.entries = doc(s.store, '29a').inv.entries.filter(e => !back29a.has(id(e)))
  r = await plan(s.store)
  assert.equal(r.rep.totals.giveItems, 0)
  assert.equal(r.h('11').back.find(g => g.baseId === S.hex(RING)).byEarlierRestore, 5)
  assert.equal(r.h('29a').back.reduce((n, g) => n + g.byEarlierRestore, 0), 7)
  r = await plan(s.store, ['--also-give', '0x000139BF'])
  assert.equal(r.rep.totals.giveItems, arrows)
  fs.rmSync(ROOT, { recursive: true })

  // A write between the read and the update is never overwritten: the apply stops there and the rest can be rolled back
  let raced = null
  let gold = 0
  const race = stub(world(), {
    beforeWrite(store, filter) {
      if (raced) return
      raced = String(filter._id)
      const d = store.find(x => String(x._id) === raced)
      gold = total(d, 0xF)
      d.inv.entries.push({ baseId: new Int32(0xF), count: new Int32(999) })
    },
  })
  await R.run(['backup', '--out', path.join(ROOT, 'race'), '--intent', INTENT], { open: race.open, log: quiet })
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'race'), '--apply', '--intent', INTENT], { open: race.open, blocker: async () => null, log: quiet }), /changed after it was read, nothing written to it; stopped part way/)
  assert.equal(total(race.store.find(x => String(x._id) === raced), 0xF), gold + 999)
  assert.equal(race.writes.length, 1)
  r = await plan(race.store)
  assert.ok(r.rep.holders.find(h => h.id === raced).give.length > 0, 'a document the apply could not write is planned again')
  assert.deepEqual(r.rep.earlier[0].unsure, [])
  fs.rmSync(ROOT, { recursive: true })

  // The game server check runs again right before the first write
  let checks = 0
  s = stub(world())
  await R.run(['backup', '--out', path.join(ROOT, 'late'), '--intent', INTENT], { open: s.open, log: quiet })
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'late'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => (++checks > 1 ? 'AlduinakGameServer is SERVICE_START_PENDING, stop it first' : null), log: quiet }), refused(/START_PENDING/))
  assert.equal(s.writes.length, 0)
  assert.ok(!fs.existsSync(path.join(ROOT, 'late', 'restore-applied.json')))
  fs.rmSync(ROOT, { recursive: true })

  // Containers: a claim that changed hands or is gone is skipped
  w = world()
  w.find(d => d.formDesc === '902:Skyrim.esm').dynamicFields['private.housing'].owner = new Int32(5)
  r = await plan(w.filter(d => d.formDesc !== '903:Skyrim.esm'))
  assert.match(r.h('c4bd5:Skyrim.esm').status, /changed hands/)
  assert.match(r.h('b36b:The Great City of Solitude.esp').status, /claim of Fixture F \(profile 7\) is gone/)
  assert.equal(r.h('c0cee:Skyrim.esm').status, 'ok')

  // Stacked return into the same chest merges into the admin's entry instead of adding a second stack
  w = world()
  addEntry(doc(w, 'c0cee:Skyrim.esm'), EINHERJAR_BOOTS, 40)
  s = stub(w)
  await R.run(['backup', '--out', path.join(ROOT, 'stack'), '--intent', INTENT], { open: s.open, log: quiet })
  await R.run(['apply', '--backup', path.join(ROOT, 'stack'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet })
  const boots = doc(s.store, 'c0cee:Skyrim.esm').inv.entries.filter(e => id(e) === EINHERJAR_BOOTS)
  assert.equal(boots.length, 1)
  assert.equal(formIds.num(boots[0].count), 46)
  fs.rmSync(ROOT, { recursive: true })

  // Profile pooling: rings handed to another character of the same profile count as returned for the whole profile
  w = world()
  const alt = { _id: new ObjectId('6ac0000000000000000000aa'), formDesc: 'a17', recType: new Int32(1), profileId: new Int32(69), appearanceDump: { name: 'Fixture A Alt' }, inv: { entries: [] } }
  addEntry(alt, RING, 5)
  w.push(alt)
  r = await plan(w)
  assert.equal(r.given('11', RING), 5)
  assert.equal(r.given('c0cd4:Skyrim.esm', RING), 2)
  assert.equal(r.h('c0cd4:Skyrim.esm').back.find(g => g.baseId === S.hex(RING)).elsewhere, 5)
  r = await plan(w, ['--per-document'])
  assert.equal(r.given('c0cd4:Skyrim.esm', RING), 7)

  // Pets: a return kept in a pet's saddlebags counts as held, an active pet by its actor's inventory rather than its stale stored copy
  const pet = (uid, actorId, rings) => ({ uid, kind: 'horse', name: uid, actorId: new Int32(actorId | 0), inventory: { entries: [{ baseId: new Int32(RING), count: new Int32(rings) }] } })
  w = world()
  doc(w, '11').dynamicFields = { 'private.pets': { list: [pet('stored', 0, 3)] } }
  r = await plan(w)
  assert.equal(r.given('11', RING), 2)
  r = await plan(w, ['--per-document'])
  assert.equal(r.given('11', RING), 2)
  doc(w, '11').dynamicFields['private.pets'].list.push(pet('out', 0xFF0000A0, 4))
  w.push({ _id: new ObjectId('6ac0000000000000000000bb'), formDesc: 'a0', recType: new Int32(1), profileId: new Int32(-1), inv: { entries: [{ baseId: new Int32(RING), count: new Int32(1) }] } })
  r = await plan(w)
  assert.equal(r.given('11', RING), 1)
  alt.dynamicFields = { 'private.pets': { list: [pet('alt', 0, 2)] } }
  w.push(alt)
  r = await plan(w)
  assert.equal(r.given('11', RING) + r.given('c0cd4:Skyrim.esm', RING), 1)
  assert.equal(r.given('c0cd4:Skyrim.esm', RING), 0)

  // A copy crafted since the strip counts as a return, per document too; --ignore-held gives the id in full, and the backup must be taken with it
  w = world()
  addEntry(doc(w, '11'), RING, 3)
  r = await plan(w)
  assert.equal(r.given('11', RING), 2)
  r = await plan(w, ['--per-document'])
  assert.equal(r.given('11', RING), 2)
  w.push(alt)
  r = await plan(w, ['--ignore-held', '0x0003B97C'])
  assert.equal(r.given('11', RING), 5)
  assert.equal(r.given('c0cd4:Skyrim.esm', RING), 7)
  s = stub(w)
  await R.run(['backup', '--out', path.join(ROOT, 'held'), '--intent', INTENT, '--ignore-held', '0x0003B97C'], { open: s.open, log: quiet })
  await assert.rejects(R.run(['apply', '--backup', path.join(ROOT, 'held'), '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet }), refused(/--ignore-held 0x0003B97C/))
  fs.rmSync(ROOT, { recursive: true })

  // Owner overrides: --also-give returns an intended removal, --also-keep keeps a return, never both
  r = await plan(world(), ['--also-give', '0x000139BF', '--also-keep', '0x3B97C'])
  assert.equal(r.given('c4bd5:Skyrim.esm', 0x000139BF), 1)
  assert.equal(r.given('11', RING), 0)
  assert.equal(r.h('11').stays.find(g => g.baseId === S.hex(RING)).why, 'kept by --also-keep')
  const usage = re => err => err instanceof S.UsageError && re.test(err.message)
  await assert.rejects(plan(world(), ['--also-give', '0x3B97C', '--also-keep', '0x0003B97C']), usage(/in both/))
  // PowerShell 5.1 turns an unquoted 0x000139BF,0x0002AC61 into 80319,175201; a repeated flag would keep only its last value
  await assert.rejects(plan(world(), ['--also-give', '80319,175201']), usage(/with 0x/))
  await assert.rejects(plan(world(), ['--also-keep', `0x${NEW.toString(16)}`]), usage(/not an item the strip removed/))
  await assert.rejects(plan(world(), ['--also-give', '0x000139BF', '--also-give', '0x0002AC61']), usage(/given twice/))

  // Refusals: an intent file of another backup, a load order that shifted the ids, a bad id list
  const bad = path.join(TMP, 'bad-intent.json')
  fs.writeFileSync(bad, JSON.stringify({ ...intent, docsSha256: '0'.repeat(64) }))
  await assert.rejects(R.run(['preview', '--report', path.join(TMP, 'x1.json'), '--intent', bad], { log: quiet }), refused(/another strip backup/))
  const order = [...intent.stripLoadOrder]
  order.splice(5, 0, 'Inserted.esp')
  fs.writeFileSync(bad, JSON.stringify({ ...intent, stripLoadOrder: order }))
  await assert.rejects(R.run(['preview', '--report', path.join(TMP, 'x2.json'), '--intent', bad], { log: quiet }), refused(/load order changed/))
  await assert.rejects(R.run(['plan', '--also-keep', 'ebony'], { log: quiet }), err => err instanceof S.UsageError)

  // Refusals: a plugin whose light flag flipped since the strip, a plugin behind the removed items that changed, an intent without hashes
  const mid = intent.plugins.find(p => !p.light && !/^(skyrim|update)[.]esm$/i.test(p.name)).name
  writePlugin(mid, true)
  await assert.rejects(R.run(['preview', '--report', path.join(TMP, 'x3.json'), '--intent', INTENT], { log: quiet }), refused(new RegExp(`light flag of ${mid.replace(/[.]/g, '[.]')} changed`)))
  writePlugin(mid)
  const source = Object.keys(intent.sourceSha256).at(-1)
  writePlugin(source, undefined, 'a record dropped')
  await assert.rejects(R.run(['preview', '--report', path.join(TMP, 'x4.json'), '--intent', INTENT], { log: quiet }), refused(/changed since .* was made: run python deploy[/]mongodb[/]strip-intent[.]py/))
  writePlugin(source)
  fs.writeFileSync(bad, JSON.stringify({ ...intent, sourceSha256: undefined }))
  await assert.rejects(R.run(['preview', '--report', path.join(TMP, 'x5.json'), '--intent', bad], { log: quiet }), refused(/carries no plugin hashes/))
  await R.run(['preview', '--report', path.join(TMP, 'x6.json'), '--intent', INTENT], { log: quiet })
  await assert.rejects(R.run(['backup', '--out', path.join(TMP, 'elsewhere'), '--intent', INTENT], { open: stub(world()).open, log: quiet }), refused(/directly under/))
  // A copy of a backup outside the root is neither applied nor rolled back, so its apply record cannot hide from later runs
  s = stub(world())
  await R.run(['backup', '--out', path.join(ROOT, 'orig'), '--intent', INTENT], { open: s.open, log: quiet })
  fs.cpSync(path.join(ROOT, 'orig'), path.join(TMP, 'copy'), { recursive: true })
  await assert.rejects(R.run(['apply', '--backup', path.join(TMP, 'copy'), '--apply', '--intent', INTENT], { open: s.open, blocker: async () => null, log: quiet }), refused(/directly under/))
  await assert.rejects(R.run(['restore', '--backup', path.join(TMP, 'copy'), '--apply'], { open: s.open, blocker: async () => null, log: quiet }), refused(/directly under/))
  assert.equal(s.writes.length, 0)

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('restore-stripped-items: all tests passed')
}

main().catch(err => { console.error(err); process.exitCode = 1 })
