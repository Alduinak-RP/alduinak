'use strict'

// Clears every character's stored tertiary craft; a stored one refuses that craft as the Secondary where no Tertiary slot is configured

const fs = require('fs')
const path = require('path')

const SM = path.join(__dirname, '..', '..', 'server-manager', 'src')
const config = require(path.join(SM, 'config'))
const { gameServerBlocker } = require(path.join(SM, 'serviceCheck'))
const { openChangeForms } = require(path.join(SM, 'mongoPurge'))

const USAGE = [
  'usage: node deploy/mongodb/clear-tertiary-crafts.js [--test] [--apply]',
  '  a dry run by default: lists every character holding a tertiary craft',
  '  --apply backs them up into the server folder and clears them; the game server must be stopped',
  '  --test works on the Test Server and its database instead of the Main Server',
].join('\n')

const SLOTS = { $getField: { field: 'private.masterySlots', input: '$dynamicFields' } }
const TERTIARY = { $getField: { field: 'tertiary', input: SLOTS } }
const HELD = { $expr: { $eq: [{ $type: { $getField: { field: 'profession', input: TERTIARY } } }, 'string'] } }
// Rewritten in place by the server, so no other value round-trips through JS and changes BSON type
const CLEAR = [{ $set: { dynamicFields: { $setField: { field: 'private.masterySlots', input: '$dynamicFields', value: { $mergeObjects: [SLOTS, { tertiary: null }] } } } } }]

async function main(argv) {
  if (argv.includes('--help')) return console.log(USAGE)
  const profile = config.profiles[argv.includes('--test') ? 'test' : 'live']
  const settings = JSON.parse(fs.readFileSync(profile.serverSettings, 'utf8'))
  const { client, col } = await openChangeForms(settings)
  try {
    const docs = await col.aggregate([{ $match: HELD }, { $project: { formDesc: 1, profileId: 1, tertiary: TERTIARY } }]).toArray()
    for (const d of docs) console.log(`  ${d.formDesc} profile ${d.profileId}: ${d.tertiary.profession} ${d.tertiary.points}h`)
    console.log(`${docs.length} character(s) hold a tertiary craft in ${settings.databaseName}`)
    if (!docs.length) return
    if (!argv.includes('--apply')) return console.log('\n[dry run] re-run with --apply to back up and clear them')
    const blocker = await gameServerBlocker(profile.key)
    if (blocker) {
      console.error(`ABORT: ${blocker}`)
      process.exitCode = 1
      return
    }
    const backup = path.join(profile.serverDir, `tertiary-crafts-${Date.now()}.json`)
    fs.writeFileSync(backup, JSON.stringify(docs, null, 2))
    console.log(`\nbacked up to ${backup}`)
    const res = await col.updateMany({ ...HELD, _id: { $in: docs.map(d => d._id) } }, CLEAR)
    console.log(`cleared ${res.modifiedCount} of ${docs.length}, ${await col.countDocuments(HELD)} left`)
  } finally {
    await client.close()
  }
}

module.exports = { HELD, CLEAR }

// Driver parse errors embed the connection string, so keep credentials out of the console
if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error('FAILED:', String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/g, '<databaseUri>'))
    process.exit(1)
  })
}
