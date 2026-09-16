'use strict'
// Reads skymp5-backend/.env on demand so allow-lists and manager keys apply without a restart

const fs     = require('fs')
const path   = require('path')
const dotenv = require('dotenv')

const FILE = path.join(__dirname, '..', '.env')

let cache = { mtimeMs: -1, values: null }

// The file is the source of truth, so a key deleted from it stops applying; without a file the process environment is used
function values() {
  let mtimeMs
  try { mtimeMs = fs.statSync(FILE).mtimeMs } catch { return process.env }
  if (mtimeMs !== cache.mtimeMs) {
    try { cache = { mtimeMs, values: dotenv.parse(fs.readFileSync(FILE)) } }
    catch { cache = { mtimeMs, values: {} } }
  }
  return cache.values
}

function get(key) {
  return String(values()[key] || '').trim()
}

function list(key) {
  return get(key).split(',').map(s => s.trim()).filter(Boolean)
}

function all() {
  return { ...values() }
}

module.exports = { get, list, all, FILE }
