'use strict'

// Deletes changeForms of removed plugins and re-encodes ids whose slot moved; run only while the game server is stopped, it re-upserts loaded forms

const fs = require('fs')
const path = require('path')
const { MongoClient, Int32, Long, Double, BSON } = require('mongodb')
const { basename, keyOf, num, flagsOf, unknownFlags, computeSlots, decodeId, encodeId, descOf, diffSlots } = require('./formIds')

const { EJSON } = BSON
const INT32_MAX = 2147483647
const DESC_RE = /^([0-9a-fA-F]{1,8}):(.+\.es[pml])$/i
const PROGRESS_EVERY = 250
// Inventory extras that only mean something next to the id they describe
const EXTRA_IDS = [['enchantmentId', ['enchantmentId', 'maxCharge', 'chargePercent', 'removeEnchantmentOnUnequip']], ['poisonId', ['poisonId', 'poisonCount']]]
// Equipped spell slots on equipmentDump (0 = none)
const SPELL_SLOTS = ['leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell']
// Reference ids on dynamicFields["private.housing"] (0 = none)
const HOUSING_REFS = ['primary', 'partner']

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
    if (!newSlots.has(parsed.key)) throw new Error(`startPoints[0].worldOrCell ${raw} is not in the new load order`)
    desc = raw
  } else {
    // The server reads it with a unary plus: "0x..." is hex, a plain digit string is decimal
    const id = raw === '' ? NaN : Number(raw)
    if (!Number.isInteger(id) || id < 0) throw new Error(`startPoints[0].worldOrCell "${raw}" is neither a number nor a <hex>:<Plugin> descriptor`)
    desc = descOf(id, newSlots)
    if (!desc || !desc.includes(':')) throw new Error(`startPoints[0].worldOrCell ${raw} cannot be resolved in the new load order`)
  }
  const pos = arr(sp.pos).map(Number)
  if (pos.length !== 3 || pos.some(n => !Number.isFinite(n))) throw new Error('startPoints[0].pos must be three numbers')
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
    out.warnings.push(`${label}: ${hex8(v)} cannot be re-encoded (${err.message}), treated as removed`)
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
      out.changes.push(`${label}: remapped ${hex8(m.value)} -> ${hex8(m.next)} (${m.plugin})`)
    }
    for (const [idKey, keys] of EXTRA_IDS) {
      if (!has(entry[idKey])) continue
      const x = mapId(entry[idKey], ctx, out, `${label} ${idKey}`)
      if (x.kind === 'remap') {
        rewrites++
        entry = { ...entry, [idKey]: typed(x.next) }
        out.changes.push(`${label}: remapped ${idKey} ${hex8(x.value)} -> ${hex8(x.next)} on ${hex8(num(entry.baseId))} (${x.plugin})`)
      } else if (x.kind === 'drop') {
        rewrites++
        entry = { ...entry }
        for (const k of keys) delete entry[k]
        out.changes.push(`${label}: dropped ${idKey} ${hex8(x.value)} (${x.plugin}) from ${hex8(num(entry.baseId))}`)
      }
    }
    rewritten.push(entry)
  }
  for (const [id, d] of drops) out.changes.push(`${label}: dropped ${d.count} x ${hex8(id)} (${d.plugin})`)
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
      out.changes.push(`${label}: remapped ${hex8(m.value)} -> ${hex8(m.next)} (${m.plugin})`)
      continue
    }
    rewritten.push(v)
  }
  for (const [id, plugin] of drops) out.changes.push(`${label}: dropped ${hex8(id)} (${plugin})`)
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
    for (const [key, name] of removed) if (lower.includes(key)) hits.push(`${keyPath} references ${name}`)
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
  const who = player ? `${doc.formDesc} "${nameOf(doc)}" (profile ${num(doc.profileId)})` : String(doc.formDesc)
  // A descriptor naming a plugin outside the new order is treated as removed; one in neither order is warned about once
  const foreign = ctx.foreign || (ctx.foreign = new Map())
  const removedIn = value => {
    const d = parseDesc(value)
    if (!d || ctx.newSlots.has(d.key)) return null
    if (!ctx.oldSlots.has(d.key) && !foreign.has(d.key)) {
      foreign.set(d.key, d.plugin)
      out.warnings.push(`${d.plugin} is not in the old or new load order`)
    }
    return d.plugin
  }
  let start
  const startPoint = () => (start === undefined ? (start = ctx.startPoint()) : start)

  const hits = []
  for (const k of ['formDesc', 'baseDesc']) {
    const p = removedIn(doc[k])
    if (p) hits.push(`${k} ${doc[k]} is in removed plugin ${p}`)
  }
  for (const t of arr(doc.templateChain)) {
    const p = removedIn(t)
    if (p) hits.push(`templateChain ${t} is in removed plugin ${p}`)
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
    out.reason = `worldOrCellDesc ${doc.worldOrCellDesc} is in removed plugin ${cellPlugin}`
    return out
  }

  const spawnPlugin = removedIn(doc.spawnPoint_cellOrWorldDesc)
  const spawnPos = arr(doc.spawnPoint_pos).map(num)
  const spawnOk = !spawnPlugin && spawnPos.length === 3 && spawnPos.every(Number.isFinite)
  if (spawnPlugin) {
    const sp = startPoint()
    if (!sp) { out.error = `${who}: spawn point ${doc.spawnPoint_cellOrWorldDesc} is in removed plugin ${spawnPlugin} and no startPoints[0] is configured`; return out }
    out.set.spawnPoint_cellOrWorldDesc = sp.desc
    out.set.spawnPoint_pos = doubles(sp.pos)
    out.set.spawnPoint_rot = doubles([0, 0, sp.angleZ])
    out.changes.push(`spawn point reset to ${sp.desc} (was ${doc.spawnPoint_cellOrWorldDesc})`)
    if (!player) out.warnings.push(`${who}: spawn point was in removed plugin ${spawnPlugin}, reset to ${sp.desc}`)
  }
  if (cellPlugin) {
    const sp = spawnOk ? null : startPoint()
    if (spawnOk) {
      out.set.worldOrCellDesc = doc.spawnPoint_cellOrWorldDesc
      out.set.position = doubles(spawnPos)
      const rot = arr(doc.spawnPoint_rot).map(num)
      if (rot.length === 3 && rot.every(Number.isFinite)) out.set.angle = doubles(rot)
      out.changes.push(`relocated to spawn point ${doc.spawnPoint_cellOrWorldDesc}`)
    } else if (sp) {
      out.set.worldOrCellDesc = sp.desc
      out.set.position = doubles(sp.pos)
      out.set.angle = doubles([0, 0, sp.angleZ])
      out.changes.push(`relocated to start point ${sp.desc}`)
    } else {
      out.error = `${who}: worldOrCellDesc ${doc.worldOrCellDesc} is in removed plugin ${cellPlugin}, its spawn point is unusable and no startPoints[0] is configured`
      return out
    }
  }

  const factions = doc.factions && arr(doc.factions.entries)
  const badFactions = factions ? factions.filter(f => f && removedIn(f.formDesc)) : []
  if (badFactions.length) {
    out.pull['factions.entries'] = { formDesc: { $in: badFactions.map(f => f.formDesc) } }
    for (const f of badFactions) out.changes.push(`factions: dropped ${f.formDesc}`)
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
        out.changes.push(`equipment: cleared ${slot} ${hex8(m.value)} (${m.plugin})`)
      } else if (m.kind === 'remap') {
        out.set[`equipmentDump.${slot}`] = typed(m.next)
        out.changes.push(`equipment: remapped ${slot} ${hex8(m.value)} -> ${hex8(m.next)} (${m.plugin})`)
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
      if (p) { dropped++; out.changes.push(`setNodeTextureSet: dropped ${node} ${nodes[node]} (${p})`) }
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
        out.changes.push(`headTextureSetId ${hex8(m.value)} (${m.plugin}) set to 0`)
        out.warnings.push(`${who}: headTextureSetId ${hex8(m.value)} belonged to removed plugin ${m.plugin}, set to 0`)
      } else if (m.kind === 'remap') {
        out.set['appearanceDump.headTextureSetId'] = typed(m.next)
        out.changes.push(`headTextureSetId: remapped ${hex8(m.value)} -> ${hex8(m.next)} (${m.plugin})`)
      }
    }
    if (has(ap.raceId)) {
      const m = mapId(ap.raceId, ctx, out, 'raceId')
      if (m.kind === 'drop') {
        out.warnings.push(`WARNING ${who}: raceId ${hex8(m.value)} belongs to removed plugin ${m.plugin} and was left unchanged, this character will not load correctly`)
      } else if (m.kind === 'remap') {
        out.set['appearanceDump.raceId'] = typed(m.next)
        out.changes.push(`raceId: remapped ${hex8(m.value)} -> ${hex8(m.next)} (${m.plugin})`)
      }
    }
  }

  // Active effects expire on their own, so a stale effectId is reported rather than rewritten
  for (const ef of arr(doc.effects)) {
    if (!ef || typeof ef !== 'object' || !has(ef.effectId)) continue
    const m = mapId(ef.effectId, ctx, out, 'effects')
    if (m.kind === 'drop') out.warnings.push(`${who}: active effect ${hex8(m.value)} belongs to removed plugin ${m.plugin} (left unchanged)`)
    else if (m.kind === 'remap') out.warnings.push(`${who}: active effect ${hex8(m.value)} belongs to shifted plugin ${m.plugin} (left unchanged)`)
  }

  const dyn = []
  scanDynamicFields(doc.dynamicFields, ctx.removed, 'dynamicFields', dyn)
  for (const hit of dyn) out.warnings.push(`${who}: ${hit} (left unchanged)`)

  // "private.housing" is a literal dotted key, so a remap rewrites the whole dynamicFields object (other values keep their BSON types)
  const housing = isPlainObject(doc.dynamicFields) ? doc.dynamicFields['private.housing'] : null
  if (isPlainObject(housing)) {
    let rewritten = null
    for (const ref of HOUSING_REFS) {
      if (!has(housing[ref]) || num(housing[ref]) === 0) continue
      const m = mapId(housing[ref], ctx, out, `housing ${ref}`)
      if (m.kind === 'drop') out.warnings.push(`${who}: housing ${ref} ${hex8(m.value)} belongs to removed plugin ${m.plugin} (left unchanged)`)
      else if (m.kind === 'remap') {
        rewritten = rewritten || { ...housing }
        rewritten[ref] = typed(m.next)
        out.changes.push(`housing: remapped ${ref} ${hex8(m.value)} -> ${hex8(m.next)} (${m.plugin})`)
      }
    }
    if (rewritten) out.set.dynamicFields = { ...doc.dynamicFields, 'private.housing': rewritten }
  }

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
  return `DELETE ${doc.formDesc} (recType ${num(doc.recType)}, profileId ${num(doc.profileId)}, base ${doc.baseDesc}): ${reason}`
}

function updateLine(doc, changes) {
  return `UPDATE ${doc.formDesc} "${nameOf(doc)}" (profileId ${num(doc.profileId)}): ${changes.join('; ')}`
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
  const warn = w => { report.warnings.push(w); log(`warning: ${w}`) }

  if (!settings || settings.databaseDriver !== 'mongodb') return fail(`databaseDriver is "${settings && settings.databaseDriver}", only mongodb is supported`)
  if (!diff) return fail('no manifest diff: rebuild the manifest first')
  if (diff.purgedAt && !dryRun) return fail(`this diff was already purged at ${diff.purgedAt}`)
  const oldOrder = arr(diff.settingsLoadOrder).map(n => basename(n).trim()).filter(Boolean)
  if (!oldOrder.length) return fail('diff.settingsLoadOrder is empty: nothing recorded the load order the data was written under')
  const newOrder = arr(newLoadOrder).map(n => basename(n).trim()).filter(Boolean)
  if (!newOrder.length) return fail('newLoadOrder is empty')
  const oldFlags = flagsOf(diff.pluginFlags, 'light')
  const newFlags = flagsOf(diff.pluginFlags, 'lightNext')
  const unknown = [...new Set([...unknownFlags(oldOrder, oldFlags), ...unknownFlags(newOrder, newFlags)])]
  if (unknown.length) return fail(`unknown light flag for: ${unknown.join(', ')} (rebuild the manifest)`)

  let client = null
  try {
    const oldSlots = computeSlots(oldOrder, oldFlags)
    const newSlots = computeSlots(newOrder, newFlags)
    const { removed, shifted } = diffSlots(oldSlots, newSlots)
    report.removedPlugins = [...removed.values()]
    report.addedPlugins = [...newSlots.values()].filter(s => !oldSlots.has(s.name.toLowerCase())).map(s => s.name)
    report.shiftedPlugins = [...shifted.values()]

    const count = slots => { let light = 0; for (const s of slots.values()) if (s.light) light++; return `${slots.size} plugins (${slots.size - light} full, ${light} light)` }
    log(`${dryRun ? 'dry run, nothing will be written' : 'applying purge'}`)
    log(`old order: ${count(oldSlots)}, new order: ${count(newSlots)}`)
    log(`removed: ${report.removedPlugins.length ? report.removedPlugins.join(', ') : 'none'}`)
    log(`added: ${report.addedPlugins.length ? report.addedPlugins.join(', ') : 'none'}`)
    log(`shifted: ${report.shiftedPlugins.length ? report.shiftedPlugins.map(s => `${s.name} ${s.from} -> ${s.to}`).join(', ') : 'none'}`)

    // A dry run only reports these; a real run refuses
    const blockers = []
    if (Array.isArray(currentLoadOrder) ? !sameOrder(currentLoadOrder.map(basename), newOrder) : !dryRun) {
      blockers.push('server-settings.json loadOrder does not match the target order yet: run Sync server settings first')
    }
    if (diff.purgeStartedAt && !diff.purgedAt) blockers.push(`a previous purge did not finish, restore ${diff.purgeBackup || 'its backup'} first`)
    for (const b of blockers) warn(b)
    if (!dryRun && blockers.length) return fail(blockers.join(' | '))
    if (!removed.size && !shifted.size) {
      log('nothing to purge: no plugin was removed or shifted')
      report.nothingToDo = true
      return { ok: true, report }
    }

    let startPoint
    const ctx = {
      removed, shifted, oldSlots, newSlots, foreign: new Map(), unresolvedIds: 0, dynamicIds: 0,
      startPoint: () => {
        if (startPoint === undefined) {
          startPoint = resolveStartPoint(opts.startPoints || settings.startPoints, newSlots)
          if (startPoint) log(`start point: ${startPoint.desc} [${startPoint.pos.join(', ')}]`)
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
      if (report.scanned % PROGRESS_EVERY === 0) log(`scanned ${report.scanned}`)
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
    log(`scanned ${report.scanned}: ${deletes.length} to delete, ${updates.length} to update, ${report.warnings.length} warning(s), ${ctx.unresolvedIds} unresolved id(s), ${ctx.dynamicIds} dynamic id(s) left alone`)

    if (playerHits.length) {
      for (const h of playerHits) log(`ABORT: ${h}`)
      return fail(`${playerHits.length} player character(s) reference removed plugins and are never deleted: ${playerHits.join(' | ')}`)
    }
    if (errors.length) {
      for (const e of errors) log(`ABORT: ${e}`)
      return fail(errors.join(' | '))
    }
    if (dryRun) return { ok: true, report }
    if (!deletes.length && !updates.length) {
      log('nothing to write')
      report.nothingToDo = true
      report.verified = true
      return { ok: true, report }
    }

    if (!backupDir) return fail('backupDir is required to apply the purge')
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
    log(`backed up ${deletes.length + updates.length} document(s) to ${backupFile}`)
    if (typeof opts.onWriteStart === 'function') await opts.onWriteStart({ backupFile })

    report.writesStarted = true
    let updated = 0
    for (const u of updates) {
      const res = await col.updateOne({ _id: u.doc._id }, u.ops)
      if (num(res.matchedCount) !== 1) throw new Error(`updateOne matched ${num(res.matchedCount)} document(s) for ${u.doc.formDesc}, is the game server still running?`)
      updated++
      if (updated % PROGRESS_EVERY === 0) log(`updated ${updated}`)
    }
    log(`updated ${updated} document(s)`)
    if (deletes.length) {
      const ids = deletes.map(d => d.doc._id)
      const res = await col.deleteMany({ _id: { $in: ids } })
      if (num(res.deletedCount) !== ids.length) throw new Error(`deleteMany removed ${num(res.deletedCount)} of ${ids.length} document(s), is the game server still running?`)
      log(`deleted ${num(res.deletedCount)} document(s)`)
    }

    const problems = []
    if (deletes.length) {
      const left = num(await col.countDocuments({ _id: { $in: deletes.map(d => d.doc._id) } }))
      if (left) problems.push(`${left} deleted document(s) still present`)
    }
    if (updates.length) {
      const after = await col.find({ _id: { $in: updates.map(u => u.doc._id) } }, { promoteValues: false }).toArray()
      if (after.length !== updates.length) problems.push(`re-read ${after.length} of ${updates.length} updated document(s)`)
      for (const doc of after) {
        const hits = []
        foreignDescriptors(doc, newSlots, '', hits)
        if (hits.length) problems.push(`${doc.formDesc}: ${hits.join(', ')}`)
      }
    }
    if (problems.length) throw new Error(`verification failed: ${problems.join(' | ')}`)
    report.verified = true
    log(`verified: no descriptor outside the new load order remains in the ${updates.length} updated document(s)`)
    return { ok: true, report }
  } catch (err) {
    const error = sanitize(err, settings)
    log(`FAILED: ${error}`)
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

  if (!settings || settings.databaseDriver !== 'mongodb') return fail(`databaseDriver is "${settings && settings.databaseDriver}", only mongodb is supported`)
  if (!backupFile) return fail('no purge backup file recorded')
  let text
  try { text = fs.readFileSync(backupFile, 'utf8') }
  catch (err) { return fail(`cannot read ${backupFile}: ${err.message}`) }
  let backup
  try { backup = EJSON.parse(text, { relaxed: false }) }
  catch (err) { return fail(`${basename(backupFile)} is not a valid purge backup: ${err.message}`) }
  const docs = [...arr(backup && backup.deleted), ...arr(backup && backup.updated)].filter(d => d && typeof d === 'object' && has(d._id))
  if (!docs.length) return fail(`${basename(backupFile)} holds no documents to restore`)

  let client = null
  try {
    let col
    ;({ client, col } = await openChangeForms(settings))
    log(`restoring ${docs.length} document(s) from ${backupFile} (${arr(backup.deleted).length} deleted, ${arr(backup.updated).length} updated)`)
    for (const doc of docs) {
      const res = await col.replaceOne({ _id: doc._id }, doc, { upsert: true })
      if (num(res.upsertedCount)) inserted++
      else if (num(res.matchedCount)) replaced++
      else throw new Error(`replaceOne neither matched nor inserted ${doc.formDesc}`)
      if ((inserted + replaced) % PROGRESS_EVERY === 0) log(`restored ${inserted + replaced}`)
    }
    const present = num(await col.countDocuments({ _id: { $in: docs.map(d => d._id) } }))
    if (present !== docs.length) throw new Error(`verification failed: ${present} of ${docs.length} restored document(s) present`)
    log(`restored ${docs.length} document(s): ${inserted} re-inserted, ${replaced} replaced`)
    return { ok: true, inserted, replaced }
  } catch (err) {
    const error = sanitize(err, settings)
    log(`FAILED: ${error}`)
    return fail(error)
  } finally {
    if (client) await client.close().catch(() => {})
  }
}

module.exports = { purgeRemovedMods, restorePurge, computeSlots, decodeId, encodeId, descOf, classifyDoc, basename }
