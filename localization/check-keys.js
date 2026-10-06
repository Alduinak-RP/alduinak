'use strict'

// Usage: node localization/check-keys.js [--unused]
// Lists loc() keys used in code that are missing from en_loc.json, and with --unused the keys nothing uses.

const fs   = require('fs')
const path = require('path')

const repo = path.join(__dirname, '..')
const table = JSON.parse(fs.readFileSync(path.join(__dirname, 'en_loc.json'), 'utf8'))

const roots = [
  { dir: 'build/dist/testserver/gamemode_extensions', section: 'gamemode' },
  { dir: 'skymp5-server/ts', section: 'server' },
  { dir: 'skymp5-client/src', section: 'client' },
  { dir: 'skymp5-front/src', section: 'front' },
  { dir: 'skymp5-backend/public/dashboard', section: 'dashboard' },
  { dir: 'skymp5-backend', section: 'backend', skip: ['public', 'node_modules', 'data', 'test'] },
  { dir: 'skymp5-launcher-tauri/ui', section: 'launcher' },
  { dir: 'skymp5-launcher-tauri/src-tauri/src', section: 'launcher' },
  { dir: 'server-manager/src', section: 'manager' },
]

const exts = new Set(['.js', '.jsx', '.ts', '.tsx', '.html', '.rs'])
const callRe = /\b(dashLoc|loc)\(\s*(['"`])([\w.]+)\2/g
const attrRe = /data-loc(?:-html|-title|-placeholder)?=["']([\w.]+)["']/g

const walk = (dir, skip = []) => {
  let out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(ent.name) || ent.name === 'node_modules') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out = out.concat(walk(p))
    else if (exts.has(path.extname(ent.name))) out.push(p)
  }
  return out
}

const lookup = (section, key) => key.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), table[section])

const used = new Set()
let missing = 0
for (const root of roots) {
  const abs = path.join(repo, root.dir)
  if (!fs.existsSync(abs)) continue
  for (const file of walk(abs, root.skip)) {
    const src = fs.readFileSync(file, 'utf8')
    const hits = []
    for (const m of src.matchAll(callRe)) hits.push({ section: m[1] === 'dashLoc' ? 'dashboard' : root.section, key: m[3], at: m.index })
    for (const m of src.matchAll(attrRe)) hits.push({ section: root.section, key: m[1], at: m.index })
    for (const h of hits) {
      used.add(`${h.section}.${h.key}`)
      if (typeof lookup(h.section, h.key) !== 'string') {
        const line = src.slice(0, h.at).split('\n').length
        console.log(`missing ${h.section}.${h.key}  ${path.relative(repo, file)}:${line}`)
        missing++
      }
    }
  }
}

if (process.argv.includes('--unused')) {
  const leaves = (node, prefix) => Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]))
  for (const key of leaves(table, '')) if (!used.has(key)) console.log(`unused ${key}`)
}

console.log(missing ? `${missing} missing key(s)` : 'all used keys exist')
process.exitCode = missing ? 1 : 0
