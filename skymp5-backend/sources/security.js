'use strict'

// Security alerts for the manager's Security tab, in MongoDB securityAlerts. The manager reads them and marks them read;
// one document per key, so the same finding raised again adds nothing.

const db = require('./db')

const TYPES = new Set(['banEvasion', 'goldSpawn'])

function raise(type, key, details) {
  if (!TYPES.has(type)) return false
  const col = db.collection('securityAlerts')
  if (!col) return false
  col.updateOne(
    { _id: `${type}:${key}` },
    { $setOnInsert: { type, details, createdAt: new Date(), read: false } },
    { upsert: true },
  ).catch(err => console.error(`[security] could not record a ${type} alert: ${err.message}`))
  return true
}

module.exports = { raise, TYPES }
