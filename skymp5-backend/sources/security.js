'use strict'

// Security alerts for the manager's Security tab, in MongoDB securityAlerts. The manager reads them and marks them read;
// one document per key, so the same finding raised again adds nothing.

const db = require('./db')
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
    const accounts = (d.accounts || []).map(a => `${a.name || a.discordId} (profile ${a.profileId}, <@${a.discordId}>)${a.banned ? ' BANNED' : ''}`).join(', ')
    return `**Ban evasion?** ${d.kind === 'hwid' ? 'HWID' : 'IP'} \`${d.value}\` is shared by ${accounts}`
  }
  return `**Gold spawning?** ${d.name || d.actorId} (profile ${d.profileId}) went from ${Number(d.before || 0).toLocaleString()} to ${Number(d.after || 0).toLocaleString()} gold (+${Number(d.gain || 0).toLocaleString()})`
}

// New alerts also go to the Discord channel named by securityAlertChannelId in server-settings.json
function announce(type, details) {
  const channelId = config.servers[0].settings.securityAlertChannelId
  if (!channelId) return
  require('./discord/bot').postToChannel(channelId, describe(type, details || {}))
}

module.exports = { raise, TYPES }
