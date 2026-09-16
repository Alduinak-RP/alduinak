'use strict'

// The Factions tab IPC proxy: only /api/factions paths pass, and the token reaches a local backend copy on a temp seed: node tools/test-factions-proxy.js

const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faction-proxy-test-'))
const TOKEN = 'test-proxy-token-0123456789'
process.env.FACTION_WHITELIST_FILE = path.join(tmp, 'faction-whitelist.json')
process.env.BAN_LOG_DIR = tmp
process.env.MASTER_API_AUTH_TOKEN = TOKEN

const backendDir = path.join(__dirname, '..', '..', 'skymp5-backend')
fs.copyFileSync(path.join(backendDir, 'seeds', 'faction-whitelist.json'), process.env.FACTION_WHITELIST_FILE)

const config = require('../src/config')
const { factionsPathAllowed, factionsRequest } = require('../src/backendApi')
const express = require(require.resolve('express', { paths: [backendDir] }))

const ALLOWED = ['', '/hold/whiterun', '/hold/the-rift/members', '/faction/thieves-guild/ranks', '/hold/whiterun/ranks/captain-of-the-guard']
const REFUSED = [
  '/', '/hold', '/hold/', '/hold/whiterun/', '//hold/whiterun', '/../servers/key/players', '/hold/..', '/hold/whiterun/ranks/..',
  '/hold/%2e%2e', '/hold/whiterun?rev=1', '/hold/whiterun#x', '/HOLD/whiterun', '/hold/whiterun/ranks/jarl/extra', 'hold/whiterun',
  '/hold/whiterun/assignments', '/hold/white run', '/hold/whiterun\n', null, 7,
]

async function run() {
  for (const p of ALLOWED) assert.equal(factionsPathAllowed('GET', p), true, `allowed ${p}`)
  for (const p of REFUSED) assert.equal(factionsPathAllowed('GET', p), false, `refused ${JSON.stringify(p)}`)
  for (const m of ['OPTIONS', 'HEAD', 'get', 'TRACE']) assert.equal(factionsPathAllowed(m, ''), false, `method ${m}`)
  console.log('pass  path and method allow-list')

  let hits = 0
  const app = express()
  app.use((_req, _res, next) => { hits++; next() })
  app.use(express.json())
  app.use('/api/factions', require(path.join(backendDir, 'routes', 'factions')))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  config.backendApi = { port: server.address().port, token: TOKEN, key: '' }

  const list = await factionsRequest('GET', '')
  assert.equal(list.ok, true, list.error)
  assert.equal(list.data.canDefine, true)
  assert.equal(list.data.factions.length, 16)

  const before = hits
  assert.equal((await factionsRequest('GET', '/../servers/key/players')).ok, false)
  assert.equal((await factionsRequest('DELETE', '/hold/whiterun', [1])).ok, false)
  assert.equal(hits, before, 'refused calls never reach the backend')

  const rev = list.data.factions.find(f => f.id === 'faction:thalmor').rev
  const stale = await factionsRequest('PATCH', '/faction/thalmor', { rev: rev + 1, color: '112233' })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.stale, true)
  const saved = await factionsRequest('PATCH', '/faction/thalmor', { rev, color: '112233' })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.data.faction.color, '112233')
  assert.ok(fs.readFileSync(path.join(tmp, 'faction.log'), 'utf8').includes('actor=server-manager action=faction.update'))

  config.backendApi = { port: server.address().port, token: 'wrong-token', key: '' }
  const wrong = await factionsRequest('GET', '')
  assert.equal(wrong.status, 403)
  config.backendApi = { port: server.address().port, token: '', key: '' }
  assert.match((await factionsRequest('GET', '')).error, /MASTER_API_AUTH_TOKEN/)
  console.log('pass  token requests against a local backend copy')

  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

run().then(() => process.exit(0)).catch(err => {
  console.error('FAIL ', err)
  process.exit(1)
})
