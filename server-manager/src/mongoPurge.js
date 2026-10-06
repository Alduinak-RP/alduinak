'use strict'

// Deletes changeForms of removed plugins and re-encodes ids whose slot moved; run only while the game server is stopped, it re-upserts loaded forms

const fs = require('fs')
const path = require('path')
const { MongoClient, Int32, Long, Double, BSON } = require('mongodb')
const { basename, keyOf, num, flagsOf, unknownFlags, computeSlots, decodeId, encodeId, descOf, diffSlots } = require('./formIds')
const { loc } = require('./loc')

const { EJSON } = BSON
const INT32_MAX = 2147483647
const DESC_RE = /^([0-9a-fA-F]{1,8}):(.+\.es[pml])$/i
const PROGRESS_EVERY = 250
// Inventory extras that only mean something next to the id they describe
const EXTRA_IDS = [['enchantmentId', ['enchantmentId', 'maxCharge', 'chargePercent', 'removeEnchantmentOnUnequip']], ['poisonId', ['poisonId', 'poisonCount']]]
// Equipped spell slots on equipmentDump (0 = none)
const SPELL_SLOTS = ['leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell']
// Form ids inside dynamicFields records (0 = none): single ids and id arrays per literal dotted key
const DYNAMIC_IDS = {
  'private.housing': { refs: ['primary', 'partner'], lists: [] },
  'private.mastery': { refs: [], lists: ['granted'] },
  'private.masterySlots': { refs: [], lists: ['granted'] },
  'private.needs': { refs: ['stageSpell', 'fatigueSpell'], lists: [] },
}

function hex8(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0') }
function typed(v) { return v > INT32_MAX ? Long.fromNumber(v) : new Int32(v) }
function arr(v) { return Array.isArray(v) ? v : [] }
function has(v) { return v !== undefined && v !== null }
function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !v._bsontype }

function parseDesc(value) {
  const m = typeof value === 'string' && DESC_RE.exec(value)
  return m ? { local: parseInt(m[1], 16), plugin: m[2], key: m[2].toLowerCase() } : null
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false
  return a.every((n, i) => keyOf(n) === keyOf(b[i]))
}

function sanitize(err, settings) {
  let s = String(err && err.message ? err.message : err)
  const uri = settings && settings.databaseUri
  if (typeof uri === 'string' && uri) s = s.split(uri).join('<databaseUri>')
  return s.replace(/mongodb(\+srv)?:\/\/\S+/gi, '<databaseUri>')
}

function isPlayer(doc) {
  const profileId = num(doc.profileId)
  return num(doc.recType) === 1 && Number.isFinite(profileId) && profileId >= 0
}

function nameOf(doc) {
  return doc.appearanceDump && typeof doc.appearanceDump.name === 'string' ? doc.appearanceDump.name : ''
}

function resolveStartPoint(startPoints, newSlots) {
  const sp = arr(startPoints)[0]
  if (!sp) return null
  const raw = String(has(sp.worldOrCell) ? sp.worldOrCell : '').trim()
  let desc = null
  const parsed = parseDesc(raw)
  if (parsed) {
    if (!newSlots.has(parsed.key)) throw new Error(loc('purge.start.notInOrder', { raw }))
    desc = raw
  } else {
    // The server reads it with a unary plus: "0x..." is hex, a plain digit string is decimal
    const id = raw === '' ? NaN : Number(raw)
    if (!Number.isInteger(id) || id < 0) throw new Error(loc('purge.start.badValue', { raw }))
    desc = descOf(id, newSlots)
    if (!desc || !desc.includes(':')) throw new Error(loc('purge.start.unresolved', { raw }))
  }
  const pos = arr(sp.pos).map(Number)
  if (pos.length !== 3 || pos.some(n => !Number.isFinite(n))) throw new Error(loc('purge.start.badPos'))
  return { desc, pos, angleZ: Number(sp.angleZ) || 0 }
}

function doubles(values) { return values.map(v => new Double(num(v))) }

// Classifies one numeric id against the old slots; counters live on ctx
function mapId(id, ctx, out, label) {
  const v = num(id)
  if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) { ctx.unresolvedIds++; return { kind: 'unresolved', value: v } }
  if (v >>> 24 === 0xFF) { ctx.dynamicIds++; return { kind: 'dynamic', value: v } }
  const d = decodeId(v, ctx.oldSlots)
  if (!d) { ctx.unresolvedIds++; return { kind: 'unresolved', value: v } }
  if (ctx.removed.has(d.key)) return { kind: 'drop', value: v, plugin: d.plugin }
  if (!ctx.shifted.has(d.key)) return { kind: 'keep', value: v, plugin: d.plugin }
  let next
  try { next = encodeId(d.plugin, d.local, ctx.newSlots) } catch (err) {
    out.warnings.push(loc('purge.reencodeFailed', { label, id: hex8(v), error: err.message }))
    return { kind: 'drop', value: v, plugin: d.plugin }
  }
  return next === v ? { kind: 'keep', value: v, plugin: d.plugin } : { kind: 'remap', value: v, next, plugin: d.plugin }
}

// Inventory entries: drop removed baseIds, re-encode shifted ones, map the enchantment and poison ids, keep other extras verbatim
function planEntries(entries, ctx, out, label) {
  const drops = new Map()
  const rewritten = []
  let rewrites = 0
  for (const e of entries) {
    if (!e || typeof e !== 'object') { rewritten.push(e); continue }
    const m = mapId(e.baseId, ctx, out, label)
    if (m.kind === 'drop') {
      const d = drops.get(m.value) || { plugin: m.plugin, count: 0 }
      d.count += Number.isFinite(num(e.count)) ? num(e.count) : 1
      drops.set(m.value, d)
      continue
    }
    let entry = e
    if (m.kind === 'remap') {
      rewrites++
      entry = { ...e, baseId: typed(m.next) }
      out.changes.push(loc('purge.change.remapped', { label, from: hex8(m.value), to: hex8(m.next), plugin: m.plugin }))
    }
    for (const [idKey, keys] of EXTRA_IDS) {
      if (!has(entry[idKey])) continue
      const x = mapId(entry[idKey], ctx, out, `${label} ${idKey}`)
      if (x.kind === 'remap') {
        rewrites++
        entry = { ...entry, [idKey]: typed(x.next) }
        out.changes.push(loc('purge.change.remappedExtra', { label, key: idKey, from: hex8(x.value), to: hex8(x.next), item: hex8(num(entry.baseId)), plugin: x.plugin }))
      } else if (x.kind === 'drop') {
        rewrites++
        entry = { ...entry }
        for (const k of keys) delete entry[k]
        out.changes.push(loc('purge.change.droppedExtra', { label, key: idKey, id: hex8(x.value), plugin: x.plugin, item: hex8(num(entry.baseId)) }))
      }
    }
    rewritten.push(entry)
  }
  for (const [id, d] of drops) out.changes.push(loc('purge.change.droppedStack', { label, count: d.count, id: hex8(id), plugin: d.plugin }))
  if (!drops.size && !rewrites) return null
  return rewrites ? { set: rewritten } : { pull: { baseId: { $in: [...drops.keys()] } } }
}

// Plain id arrays (learnedSpells, headpartIds)
function planIds(values, ctx, out, label) {
  const drops = new Map()
  const rewritten = []
  let remaps = 0
  for (const v of values) {
    const m = mapId(v, ctx, out, label)
    if (m.kind === 'drop') { drops.set(m.value, m.plugin); continue }
    if (m.kind === 'remap') {
      remaps++
      rewritten.push(typed(m.next))
      out.changes.push(loc('purge.change.remapped', { label, from: hex8(m.value), to: hex8(m.next), plugin: m.plugin }))
      continue
    }
    rewritten.push(v)
  }
  for (const [id, plugin] of drops) out.changes.push(loc('purge.change.dropped', { label, id: hex8(id), plugin }))
  if (!drops.size && !remaps) return null
  return remaps ? { set: rewritten } : { pull: { $in: [...drops.keys()] } }
}

function applyPlan(plan, out, field) {
  if (!plan) return
  if (plan.set) out.set[field] = plan.set
  else out.pull[field] = plan.pull
}

function scanDynamicFields(value, removed, keyPath, hits) {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    for (const [key, name] of removed) if (lower.includes(key)) hits.push(loc('purge.references', { path: keyPath, name }))
    return
  }
  if (Array.isArray(value)) value.forEach((v, i) => scanDynamicFields(v, removed, `${keyPath}[${i}]`, hits))
  else if (value && typeof value === 'object' && !value._bsontype) {
    for (const k of Object.keys(value)) scanDynamicFields(value[k], removed, `${keyPath}.${k}`, hits)
  }
}

// ctx.startPoint() resolves startPoints[0] on first use and may throw on a bad configuration
function classifyDoc(doc, ctx) {
  const out = { action: 'none', reason: '', set: {}, unset: {}, pull: {}, changes: [], warnings: [], playerHit: null, error: null }
  const player = isPlayer(doc)
  const who = player ? loc('purge.who', { formDesc: doc.formDesc, name: nameOf(doc), profileId: num(doc.profileId) }) : String(doc.formDesc)
  // A descriptor naming a plugin outside the new order is treated as removed; one in neither order is warned about once
  const foreign = ctx.foreign || (ctx.foreign = new Map())
  const removedIn = value => {
    const d = parseDesc(value)
    if (!d || ctx.newSlots.has(d.key)) return null
    if (!ctx.oldSlots.has(d.key) && !foreign.has(d.key)) {
      foreign.set(d.key, d.plugin)
      out.warnings.push(loc('purge.foreignPlugin', { plugin: d.plugin }))
    }
    return d.plugin
  }
  let start
  const startPoint = () => (start === undefined ? (start = ctx.startPoint()) : start)

  const hits = []
  for (const k of ['formDesc', 'baseDesc']) {
    const p = removedIn(doc[k])
    if (p) hits.push(loc('purge.inRemoved', { field: k, value: doc[k], plugin: p }))
  }
  for (const t of arr(doc.templateChain)) {
    const p = removedIn(t)
    if (p) hits.push(loc('purge.inRemoved', { field: 'templateChain', value: t, plugin: p }))
  }
  if (hits.length) {
    if (player) { out.playerHit = `${who}: ${hits.join('; ')}`; return out }
    out.action = 'delete'
    out.reason = hits.join('; ')
    return out
  }

  const cellPlugin = removedIn(doc.worldOrCellDesc)
  if (cellPlugin && !player) {
    out.action = 'delete'
    out.reason = loc('purge.inRemoved', { field: 'worldOrCellDesc', value: doc.worldOrCellDesc, plugin: cellPlugin })
    return out
  }

  const spawnPlugin = removedIn(doc.spawnPoint_cellOrWorldDesc)
  const spawnPos = arr(doc.spawnPoint_pos).map(num)
  const spawnOk = !spawnPlugin && spawnPos.length === 3 && spawnPos.every(Number.isFinite)
  if (spawnPlugin) {
    const sp = startPoint()
    if (!sp) { out.error = loc('purge.spawnNoStart', { who, spawn: doc.spawnPoint_cellOrWorldDesc, plugin: spawnPlugin }); return out }
    out.set.spawnPoint_cellOrWorldDesc = sp.desc
    out.set.spawnPoint_pos = doubles(sp.pos)
    out.set.spawnPoint_rot = doubles([0, 0, sp.angleZ])
    out.changes.push(loc('purge.change.spawnReset', { to: sp.desc, from: doc.spawnPoint_cellOrWorldDesc }))
    if (!player) out.warnings.push(loc('purge.spawnWasRemoved', { who, plugin: spawnPlugin, to: sp.desc }))
  }
  if (cellPlugin) {
    const sp = spawnOk ? null : startPoint()
    if (spawnOk) {
      out.set.worldOrCellDesc = doc.spawnPoint_cellOrWorldDesc
      out.set.position = doubles(spawnPos)
      const rot = arr(doc.spawnPoint_rot).map(num)
      if (rot.length === 3 && rot.every(Number.isFinite)) out.set.angle = doubles(rot)
      out.changes.push(loc('purge.change.toSpawn', { to: doc.spawnPoint_cellOrWorldDesc }))
    } else if (sp) {
      out.set.worldOrCellDesc = sp.desc
      out.set.position = doubles(sp.pos)
      out.set.angle = doubles([0, 0, sp.angleZ])
      out.changes.push(loc('purge.change.toStart', { to: sp.desc }))
    } else {
      out.error = loc('purge.cellNoStart', { who, cell: doc.worldOrCellDesc, plugin: cellPlugin })
      return out
    }
  }

  const factions = doc.factions && arr(doc.factions.entries)
  const badFactions = factions ? factions.filter(f => f && removedIn(f.formDesc)) : []
  if (badFactions.length) {
    out.pull['factions.entries'] = { formDesc: { $in: badFactions.map(f => f.formDesc) } }
    for (const f of badFactions) out.changes.push(loc('purge.change.faction', { formDesc: f.formDesc }))
  }

  if (doc.inv) applyPlan(planEntries(arr(doc.inv.entries), ctx, out, 'inv'), out, 'inv.entries')
  const eq = doc.equipmentDump
  if (isPlainObject(eq)) {
    if (eq.inv) applyPlan(planEntries(arr(eq.inv.entries), ctx, out, 'equipment'), out, 'equipmentDump.inv.entries')
    for (const slot of SPELL_SLOTS) {
      if (!has(eq[slot]) || num(eq[slot]) === 0) continue
      const m = mapId(eq[slot], ctx, out, `equipment ${slot}`)
      if (m.kind === 'drop') {
        out.set[`equipmentDump.${slot}`] = new Int32(0)
        out.changes.push(loc('purge.change.slotCleared', { slot, id: hex8(m.value), plugin: m.plugin }))
      } else if (m.kind === 'remap') {
        out.set[`equipmentDump.${slot}`] = typed(m.next)
        out.changes.push(loc('purge.change.slotRemapped', { slot, from: hex8(m.value), to: hex8(m.next), plugin: m.plugin }))
      }
    }
  }
  applyPlan(planIds(arr(doc.learnedSpells), ctx, out, 'learnedSpells'), out, 'learnedSpells')

  // Texture set overrides are descriptors, so shifted plugins need no rewrite; dropped ones leave the object or unset it
  const nodes = doc.setNodeTextureSet
  if (isPlainObject(nodes)) {
    const kept = {}
    let dropped = 0
    for (const node of Object.keys(nodes)) {
      const p = removedIn(nodes[node])
      if (p) { dropped++; out.changes.push(loc('purge.change.textureSet', { node, value: nodes[node], plugin: p })) }
      else kept[node] = nodes[node]
    }
    if (dropped && Object.keys(kept).length) out.set.setNodeTextureSet = kept
    else if (dropped) out.unset.setNodeTextureSet = ''
  }

  const ap = doc.appearanceDump
  if (ap && typeof ap === 'object') {
    applyPlan(planIds(arr(ap.headpartIds), ctx, out, 'headparts'), out, 'appearanceDump.headpartIds')
    if (has(ap.headTextureSetId)) {
      const m = mapId(ap.headTextureSetId, ctx, out, 'headTextureSetId')
      if (m.kind === 'drop') {
        out.set['appearanceDump.headTextureSetId'] = new Int32(0)
        out.changes.push(loc('purge.change.headTextureZero', { id: hex8(m.value), plugin: m.plugin }))
        out.warnings.push(loc('purge.headTextureZero', { who, id: hex8(m.value), plugin: m.plugin }))
      } else if (m.kind === 'remap') {
        out.set['appearanceDump.headTextureSetId'] = typed(m.next)
        out.changes.push(loc('purge.change.remapped', { label: 'headTextureSetId', from: hex8(m.value), to: hex8(m.next), plugin: m.plugin }))
      }
    }
    if (has(ap.raceId)) {
      const m = mapId(ap.raceId, ctx, out, 'raceId')
      if (m.kind === 'drop') {
        out.warnings.push(loc('purge.raceRemoved', { who, id: hex8(m.value), plugin: m.plugin }))
      } else if (m.kind === 'remap') {
        out.set['appearanceDump.raceId'] = typed(m.next)
        out.changes.push(loc('purge.change.remapped', { label: 'raceId', from: hex8(m.value), to: hex8(m.next), plugin: m.plugin }))
      }
    }
  }

  // Active effects expire on their own, so a stale effectId is reported rather than rewritten
  for (const ef of arr(doc.effects)) {
    if (!ef || typeof ef !== 'object' || !has(ef.effectId)) continue
    const m = mapId(ef.effectId, ctx, out, 'effects')
    if (m.kind === 'drop') out.warnings.push(loc('purge.effectRemoved', { who, id: hex8(m.value), plugin: m.plugin }))
    else if (m.kind === 'remap') out.warnings.push(loc('purge.effectShifted', { who, id: hex8(m.value), plugin: m.plugin }))
  }

  const dyn = []
  scanDynamicFields(doc.dynamicFields, ctx.removed, 'dynamicFields', dyn)
  for (const hit of dyn) out.warnings.push(loc('purge.dynamicHit', { who, hit }))

  // The keys are literal dotted names, so every remap lands in one rewrite of the whole dynamicFields object (other values keep their BSON types)
  const dynamic = {}
  for (const [key, ids] of Object.entries(DYNAMIC_IDS)) {
    const record = isPlainObject(doc.dynamicFields) ? doc.dynamicFields[key] : null
    if (!isPlainObject(record)) continue
    const label = key.replace('private.', '')
    let rewritten = null
    for (const ref of ids.refs) {
      if (!has(record[ref]) || num(record[ref]) === 0) continue
      const m = mapId(record[ref], ctx, out, `${label} ${ref}`)
      if (m.kind === 'drop') out.warnings.push(loc('purge.refRemoved', { who, label, ref, id: hex8(m.value), plugin: m.plugin }))
      else if (m.kind === 'remap') {
        rewritten = rewritten || { ...record }
        rewritten[ref] = typed(m.next)
        out.changes.push(loc('purge.change.refRemapped', { label, ref, from: hex8(m.value), to: hex8(m.next), plugin: m.plugin }))
      }
    }
    for (const list of ids.lists) {
      const plan = planIds(arr(record[list]), ctx, out, `${label} ${list}`)
      if (!plan) continue
      rewritten = rewritten || { ...record }
      rewritten[list] = plan.set || arr(record[list]).filter(v => !plan.pull.$in.includes(num(v)))
    }
    if (rewritten) dynamic[key] = rewritten
  }
  if (Object.keys(dynamic).length) out.set.dynamicFields = { ...doc.dynamicFields, ...dynamic }

  if (Object.keys(out.set).length || Object.keys(out.unset).length || Object.keys(out.pull).length) out.action = 'update'
  return out
}

function updateOps(out) {
  const ops = {}
  if (Object.keys(out.set).length) ops.$set = out.set
  if (Object.keys(out.unset).length) ops.$unset = out.unset
  if (Object.keys(out.pull).length) ops.$pull = out.pull
  return ops
}

// Descriptors naming a plugin outside the new order anywhere outside dynamicFields (setNodeTextureSet included)
function foreignDescriptors(value, newSlots, keyPath, hits) {
  if (typeof value === 'string') {
    const d = parseDesc(value)
    if (d && !newSlots.has(d.key)) hits.push(`${keyPath}=${value}`)
    return
  }
  if (Array.isArray(value)) value.forEach((v, i) => foreignDescriptors(v, newSlots, `${keyPath}[${i}]`, hits))
  else if (value && typeof value === 'object' && !value._bsontype) {
    for (const k of Object.keys(value)) {
      if (keyPath === '' && k === 'dynamicFields') continue
      foreignDescriptors(value[k], newSlots, keyPath ? `${keyPath}.${k}` : k, hits)
    }
  }
}

function deleteLine(doc, reason) {
  return loc('purge.deleteLine', { formDesc: doc.formDesc, recType: num(doc.recType), profileId: num(doc.profileId), base: doc.baseDesc, reason })
}

function updateLine(doc, changes) {
  return loc('purge.updateLine', { formDesc: doc.formDesc, name: nameOf(doc), profileId: num(doc.profileId), changes: changes.join('; ') })
}

// Reads pass promoteValues:false per cursor; set on the collection it would also wrap the driver's own counters
function openChangeForms(settings) {
  const client = new MongoClient(settings.databaseUri, { serverSelectionTimeoutMS: 5000 })
  return client.connect().then(() => ({ client, col: client.db(settings.databaseName).collection('changeForms') }))
}

async function purgeRemovedMods(opts) {
  const { settings, diff, newLoadOrder, currentLoadOrder, backupDir } = opts || {}
  const dryRun = opts && opts.dryRun !== false
  const log = opts && typeof opts.log === 'function' ? opts.log : () => {}
  const report = {
    removedPlugins: [], addedPlugins: [], shiftedPlugins: [], scanned: 0,
    deletes: [], updates: [], warnings: [], unresolvedIds: 0, dynamicIds: 0,
    dryRun, nothingToDo: false, backupFile: null, writesStarted: false, verified: false,
  }
  const fail = error => ({ ok: false, error, report })
  const warn = w => { report.warnings.push(w); log(loc('purge.warning', { text: w })) }

  if (!settings || settings.databaseDriver !== 'mongodb') return fail(loc('purge.mongoOnly', { driver: settings && settings.databaseDriver }))
  if (!diff) return fail(loc('purge.noDiff'))
  if (diff.purgedAt && !dryRun) return fail(loc('purge.alreadyPurged', { at: diff.purgedAt }))
  const oldOrder = arr(diff.settingsLoadOrder).map(n => basename(n).trim()).filter(Boolean)
  if (!oldOrder.length) return fail(loc('purge.noOldOrder'))
  const newOrder = arr(newLoadOrder).map(n => basename(n).trim()).filter(Boolean)
  if (!newOrder.length) return fail(loc('purge.noNewOrder'))
  const oldFlags = flagsOf(diff.pluginFlags, 'light')
  const newFlags = flagsOf(diff.pluginFlags, 'lightNext')
  const unknown = [...new Set([...unknownFlags(oldOrder, oldFlags), ...unknownFlags(newOrder, newFlags)])]
  if (unknown.length) return fail(loc('purge.unknownFlags', { names: unknown.join(', ') }))

  let client = null
  try {
    const oldSlots = computeSlots(oldOrder, oldFlags)
    const newSlots = computeSlots(newOrder, newFlags)
    const { removed, shifted } = diffSlots(oldSlots, newSlots)
    report.removedPlugins = [...removed.values()]
    report.addedPlugins = [...newSlots.values()].filter(s => !oldSlots.has(s.name.toLowerCase())).map(s => s.name)
    report.shiftedPlugins = [...shifted.values()]

    const count = slots => { let light = 0; for (const s of slots.values()) if (s.light) light++; return loc('purge.orderCount', { n: slots.size, full: slots.size - light, light }) }
    log(dryRun ? loc('purge.dryRun') : loc('purge.applying'))
    log(loc('purge.orders', { old: count(oldSlots), new: count(newSlots) }))
    log(loc('purge.removed', { names: report.removedPlugins.length ? report.removedPlugins.join(', ') : loc('players.noneLower') }))
    log(loc('purge.added', { names: report.addedPlugins.length ? report.addedPlugins.join(', ') : loc('players.noneLower') }))
    log(loc('purge.shifted', { names: report.shiftedPlugins.length ? report.shiftedPlugins.map(s => `${s.name} ${s.from} -> ${s.to}`).join(', ') : loc('players.noneLower') }))

    // A dry run only reports these; a real run refuses
    const blockers = []
    if (Array.isArray(currentLoadOrder) ? !sameOrder(currentLoadOrder.map(basename), newOrder) : !dryRun) {
      blockers.push(loc('purge.orderMismatch'))
    }
    if (diff.purgeStartedAt && !diff.purgedAt) blockers.push(loc('purge.unfinished', { backup: diff.purgeBackup || loc('purge.itsBackup') }))
    for (const b of blockers) warn(b)
    if (!dryRun && blockers.length) return fail(blockers.join(' | '))
    if (!removed.size && !shifted.size) {
      log(loc('purge.nothingToPurge'))
      report.nothingToDo = true
      return { ok: true, report }
    }

    let startPoint
    const ctx = {
      removed, shifted, oldSlots, newSlots, foreign: new Map(), unresolvedIds: 0, dynamicIds: 0,
      startPoint: () => {
        if (startPoint === undefined) {
          startPoint = resolveStartPoint(opts.startPoints || settings.startPoints, newSlots)
          if (startPoint) log(loc('purge.startPoint', { desc: startPoint.desc, pos: startPoint.pos.join(', ') }))
        }
        return startPoint
      },
    }

    let col
    ;({ client, col } = await openChangeForms(settings))

    const deletes = []
    const updates = []
    const playerHits = []
    const errors = []
    for await (const doc of col.find({}, { promoteValues: false })) {
      report.scanned++
      if (report.scanned % PROGRESS_EVERY === 0) log(loc('purge.scannedProgress', { n: report.scanned }))
      const out = classifyDoc(doc, ctx)
      for (const w of out.warnings) warn(w)
      if (out.playerHit) { playerHits.push(out.playerHit); continue }
      if (out.error) { errors.push(out.error); continue }
      if (out.action === 'delete') {
        deletes.push({ doc, reason: out.reason })
        report.deletes.push({ formDesc: doc.formDesc, baseDesc: doc.baseDesc, recType: num(doc.recType), profileId: num(doc.profileId), reason: out.reason })
        log(deleteLine(doc, out.reason))
      } else if (out.action === 'update') {
        updates.push({ doc, ops: updateOps(out), changes: out.changes })
        report.updates.push({ formDesc: doc.formDesc, name: nameOf(doc), profileId: num(doc.profileId), changes: out.changes })
        log(updateLine(doc, out.changes))
      }
    }
    report.unresolvedIds = ctx.unresolvedIds
    report.dynamicIds = ctx.dynamicIds
    log(loc('purge.scanned', { n: report.scanned, deletes: deletes.length, updates: updates.length, warnings: report.warnings.length, unresolved: ctx.unresolvedIds, dynamic: ctx.dynamicIds }))

    if (playerHits.length) {
      for (const h of playerHits) log(loc('purge.abort', { text: h }))
      return fail(loc('purge.playerHits', { n: playerHits.length, hits: playerHits.join(' | ') }))
    }
    if (errors.length) {
      for (const e of errors) log(loc('purge.abort', { text: e }))
      return fail(errors.join(' | '))
    }
    if (dryRun) return { ok: true, report }
    if (!deletes.length && !updates.length) {
      log(loc('purge.nothingToWrite'))
      report.nothingToDo = true
      report.verified = true
      return { ok: true, report }
    }

    if (!backupDir) return fail(loc('purge.needBackupDir'))
    fs.mkdirSync(backupDir, { recursive: true })
    const backupFile = path.join(backupDir, `purged-changeforms-${Date.now()}.json`)
    const backup = {
      purgedAt: new Date().toISOString(),
      removedPlugins: report.removedPlugins,
      shiftedPlugins: report.shiftedPlugins,
      deleted: deletes.map(d => d.doc),
      updated: updates.map(u => u.doc),
    }
    fs.writeFileSync(backupFile, EJSON.stringify(backup, null, 2, { relaxed: false }))
    report.backupFile = backupFile
    log(loc('purge.backedUp', { n: deletes.length + updates.length, file: backupFile }))
    if (typeof opts.onWriteStart === 'function') await opts.onWriteStart({ backupFile })

    report.writesStarted = true
    let updated = 0
    for (const u of updates) {
      const res = await col.updateOne({ _id: u.doc._id }, u.ops)
      if (num(res.matchedCount) !== 1) throw new Error(loc('purge.updateMismatch', { n: num(res.matchedCount), formDesc: u.doc.formDesc }))
      updated++
      if (updated % PROGRESS_EVERY === 0) log(loc('purge.updatedProgress', { n: updated }))
    }
    log(loc('purge.updated', { n: updated }))
    if (deletes.length) {
      const ids = deletes.map(d => d.doc._id)
      const res = await col.deleteMany({ _id: { $in: ids } })
      if (num(res.deletedCount) !== ids.length) throw new Error(loc('purge.deleteMismatch', { n: num(res.deletedCount), total: ids.length }))
      log(loc('purge.deleted', { n: num(res.deletedCount) }))
    }

    const problems = []
    if (deletes.length) {
      const left = num(await col.countDocuments({ _id: { $in: deletes.map(d => d.doc._id) } }))
      if (left) problems.push(loc('purge.stillPresent', { n: left }))
    }
    if (updates.length) {
      const after = await col.find({ _id: { $in: updates.map(u => u.doc._id) } }, { promoteValues: false }).toArray()
      if (after.length !== updates.length) problems.push(loc('purge.reread', { n: after.length, total: updates.length }))
      for (const doc of after) {
        const hits = []
        foreignDescriptors(doc, newSlots, '', hits)
        if (hits.length) problems.push(`${doc.formDesc}: ${hits.join(', ')}`)
      }
    }
    if (problems.length) throw new Error(loc('purge.verifyFailed', { problems: problems.join(' | ') }))
    report.verified = true
    log(loc('purge.verified', { n: updates.length }))
    return { ok: true, report }
  } catch (err) {
    const error = sanitize(err, settings)
    log(loc('purge.failed', { error }))
    return fail(error)
  } finally {
    if (client) await client.close().catch(() => {})
  }
}

// Puts every document of a purge backup back by _id (deleted ones re-inserted, updated ones replaced); other documents are never touched
async function restorePurge(opts) {
  const { settings, backupFile } = opts || {}
  const log = opts && typeof opts.log === 'function' ? opts.log : () => {}
  let inserted = 0
  let replaced = 0
  const fail = error => ({ ok: false, error, inserted, replaced })

  if (!settings || settings.databaseDriver !== 'mongodb') return fail(loc('purge.mongoOnly', { driver: settings && settings.databaseDriver }))
  if (!backupFile) return fail(loc('purge.restore.noFile'))
  let text
  try { text = fs.readFileSync(backupFile, 'utf8') }
  catch (err) { return fail(loc('purge.restore.unreadable', { file: backupFile, error: err.message })) }
  let backup
  try { backup = EJSON.parse(text, { relaxed: false }) }
  catch (err) { return fail(loc('purge.restore.invalid', { file: basename(backupFile), error: err.message })) }
  const docs = [...arr(backup && backup.deleted), ...arr(backup && backup.updated)].filter(d => d && typeof d === 'object' && has(d._id))
  if (!docs.length) return fail(loc('purge.restore.empty', { file: basename(backupFile) }))

  let client = null
  try {
    let col
    ;({ client, col } = await openChangeForms(settings))
    log(loc('purge.restore.start', { n: docs.length, file: backupFile, deleted: arr(backup.deleted).length, updated: arr(backup.updated).length }))
    for (const doc of docs) {
      const res = await col.replaceOne({ _id: doc._id }, doc, { upsert: true })
      if (num(res.upsertedCount)) inserted++
      else if (num(res.matchedCount)) replaced++
      else throw new Error(loc('purge.restore.replaceFailed', { formDesc: doc.formDesc }))
      if ((inserted + replaced) % PROGRESS_EVERY === 0) log(loc('purge.restore.progress', { n: inserted + replaced }))
    }
    const present = num(await col.countDocuments({ _id: { $in: docs.map(d => d._id) } }))
    if (present !== docs.length) throw new Error(loc('purge.restore.verifyFailed', { n: present, total: docs.length }))
    log(loc('purge.restore.done', { n: docs.length, inserted, replaced }))
    return { ok: true, inserted, replaced }
  } catch (err) {
    const error = sanitize(err, settings)
    log(loc('purge.failed', { error }))
    return fail(error)
  } finally {
    if (client) await client.close().catch(() => {})
  }
}

module.exports = { purgeRemovedMods, restorePurge, computeSlots, decodeId, encodeId, descOf, classifyDoc, basename, sanitize, isPlayer, foreignDescriptors, openChangeForms }
