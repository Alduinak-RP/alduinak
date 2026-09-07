'use strict'

// Numeric form ids the way libespm's Combiner assigns them: full plugins index<<24, light plugins 0xFE|slot<<12

function basename(p) { return String(p).split(/[\\/]/).pop() }
function keyOf(name) { return basename(name).trim().toLowerCase() }

// Plain numbers and BSON wrappers (Int32, Long, Double) both read as numbers
function num(v) {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && v._bsontype) return Number(v)
  return NaN
}

// { name: boolean|null } from a Map, a boolean map or a diff pluginFlags object (key picks light or lightNext)
function flagsOf(flags, key = 'light') {
  const map = new Map()
  const entries = flags instanceof Map ? flags : Object.entries(flags || {})
  for (const [name, v] of entries) {
    const light = v && typeof v === 'object' ? v[key] : v
    map.set(keyOf(name), light === true || light === false ? light : null)
  }
  return map
}

function unknownFlags(order, flags) {
  const map = flagsOf(flags)
  return order.map(n => basename(n).trim()).filter(n => typeof map.get(n.toLowerCase()) !== 'boolean')
}

function computeSlots(order, flagsByName) {
  const lights = flagsOf(flagsByName)
  const slots = new Map()
  let nextFull = 0
  let nextLight = 0
  for (const entry of order) {
    const name = basename(entry).trim()
    const key = name.toLowerCase()
    if (slots.has(key)) throw new Error(`${name} appears twice in the load order`)
    const light = lights.get(key)
    if (light !== true && light !== false) throw new Error(`unknown light flag for ${name}`)
    if (light && nextLight > 0xFFF) throw new Error('too many light plugins (max 4096)')
    if (!light && nextFull > 0xFD) throw new Error('too many full plugins (max 254)')
    slots.set(key, { name, light, index: light ? nextLight++ : nextFull++ })
  }
  return slots
}

const reverseCache = new WeakMap()
function bySlot(slots) {
  let r = reverseCache.get(slots)
  if (!r) {
    r = { full: new Map(), light: new Map() }
    for (const s of slots.values()) (s.light ? r.light : r.full).set(s.index, s)
    reverseCache.set(slots, r)
  }
  return r
}

// null for dynamic (0xFF) ids, out-of-range values and vacant slots
function decodeId(id, slots) {
  const v = num(id)
  if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) return null
  const high = v >>> 24
  if (high === 0xFF) return null
  const r = bySlot(slots)
  const slot = high === 0xFE ? r.light.get((v >>> 12) & 0xFFF) : r.full.get(high)
  if (!slot) return null
  const local = high === 0xFE ? v & 0xFFF : v & 0xFFFFFF
  return { plugin: slot.name, key: slot.name.toLowerCase(), local, light: slot.light, index: slot.index }
}

function encodeId(plugin, local, slots) {
  const slot = slots.get(keyOf(plugin))
  if (!slot) throw new Error(`${basename(plugin)} is not in the load order`)
  if (slot.light && local > 0xFFF) throw new Error(`${slot.name} is a light plugin but local id 0x${local.toString(16)} does not fit 12 bits`)
  return slot.light
    ? (0xFE000000 | ((slot.index & 0xFFF) << 12) | (local & 0xFFF)) >>> 0
    : (((slot.index & 0xFF) << 24) | (local & 0xFFFFFF)) >>> 0
}

// Server descriptor style: lower-case hex, dynamic ids as their offset from 0xFF000000
function descOf(id, slots) {
  const v = num(id)
  if (Number.isInteger(v) && v >>> 24 === 0xFF) return (v - 0xFF000000).toString(16)
  const d = decodeId(v, slots)
  return d ? `${d.local.toString(16)}:${d.plugin}` : null
}

function slotLabel(slot) {
  return slot.light
    ? `light 0x${slot.index.toString(16).toUpperCase().padStart(3, '0')}`
    : `full 0x${slot.index.toString(16).toUpperCase().padStart(2, '0')}`
}

// removed: key -> name gone from the new order; shifted: key -> { name, from, to } for slots that moved
function diffSlots(oldSlots, newSlots) {
  const removed = new Map()
  const shifted = new Map()
  for (const [key, slot] of oldSlots) {
    const next = newSlots.get(key)
    if (!next) removed.set(key, slot.name)
    else if (next.light !== slot.light || next.index !== slot.index) shifted.set(key, { name: slot.name, from: slotLabel(slot), to: slotLabel(next) })
  }
  return { removed, shifted }
}

// Plugins present in both orders whose slot differs (light flags are per order)
function shiftedBetween(oldOrder, oldFlags, newOrder, newFlags) {
  return [...diffSlots(computeSlots(oldOrder, oldFlags), computeSlots(newOrder, newFlags)).shifted.values()]
}

module.exports = { basename, keyOf, num, flagsOf, unknownFlags, computeSlots, decodeId, encodeId, descOf, slotLabel, diffSlots, shiftedBetween }
