'use strict'

// Line at the dotted key of a section of en_loc.json with {placeholders} filled; a missing key returns the key
function locLookup(section, key, vars) {
  let node = section
  for (const part of key.split('.')) node = node && typeof node === 'object' ? node[part] : undefined
  if (typeof node !== 'string') return key
  return vars ? node.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : node
}

module.exports = { locLookup }
