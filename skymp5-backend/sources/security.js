'use strict'

// Security alerts for the manager's Security tab, in MongoDB securityAlerts. The manager reads them and marks them read;
// one document per key, so the same finding raised again adds nothing.

const db = require('./db')
const { loc } = require('./loc')
const config = require('../config')

const TYPES = new Set(['banEvasion', 'goldSpawn'])

function raise(type, key, details) {
  if (!TYPES.has(type)) return false
  const col = db.collection('securityAlerts')
  if (!col) return false
  col.updateOne(
    { _id: `${type}:${key}` },
    { $setOnInsert: { type, details, createdAt: new Date(), read: false } },
    { upsert: true },
  ).then(r => { if (r.upsertedCount) announce(type, details) })
    .catch(err => console.error(`[security] could not record a ${type} alert: ${err.message}`))
  return true
}

function describe(type, d) {
  if (type === 'banEvasion') {
    const accounts = (d.accounts || []).map(a => {
      const account = loc('security.banEvasionAccount', { name: a.name || a.discordId, profileId: a.profileId, discordId: a.discordId })
      return a.banned ? loc('security.banEvasionBanned', { account }) : account
    }).join(', ')
    return loc('security.banEvasion', { kind: d.kind === 'hwid' ? 'HWID' : 'IP', value: d.value, accounts })
  }
  return loc('security.goldSpawn', { name: d.name || d.actorId, profileId: d.profileId, before: Number(d.before || 0).toLocaleString(), after: Number(d.after || 0).toLocaleString(), gain: Number(d.gain || 0).toLocaleString() })
}

// New alerts also go to the Discord channel named by securityAlertChannelId in server-settings.json
function announce(type, details) {
  const channelId = config.servers[0].settings.securityAlertChannelId
  if (!channelId) return
  require('./discord/bot').postToChannel(channelId, describe(type, details || {}))
}

module.exports = { raise, TYPES }
