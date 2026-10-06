'use strict'

// WeatherSystem's packets: the poll, an admin's force and clear pushed at once without a fade, the weatherRequest answer, places with their own sky and the fade settings: node tools/test-weather-push.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const source = path.join(__dirname, '..', 'ts', 'systems', 'weatherSystem.ts')
const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
const compiled = new Module(source)
compiled.paths = Module._nodeModulePaths(path.dirname(source))
compiled._compile(outputFiles[0].text, source)
const { WeatherSystem } = compiled.exports

// weather-state.json is written to the working directory
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'weather-push-')))

const WORLD = 0x3c
const REALM = 0x2ee41
const TEMPLE = 0x165a7
const HALL = 0x95c44
const HALL_SKY_REGION = 0x10ff20
// The hall draws the sky of a region of the realm (CELL XCCM, REGN WNAM)
const formIdField = (type, id) => ({ type, data: new Uint8Array(new Uint32Array([id]).buffer) })
const records = new Map([
  [WORLD, { type: 'WRLD', fields: [] }],
  [REALM, { type: 'WRLD', fields: [] }],
  [TEMPLE, { type: 'CELL', fields: [] }],
  [HALL, { type: 'CELL', fields: [formIdField('XCCM', HALL_SKY_REGION)] }],
  [HALL_SKY_REGION, { type: 'REGN', fields: [formIdField('WNAM', REALM)] }],
])
// Actor -> user, cell and position; the first two stand in region a, the third in b
const players = new Map([
  [0xff000001, { user: 1, cell: WORLD, pos: [5000, 5000, 0] }],
  [0xff000002, { user: 2, cell: WORLD, pos: [6000, 6000, 0] }],
  [0xff000003, { user: 3, cell: WORLD, pos: [20000, 5000, 0] }],
])
const props = new Map()
const packets = []
const svr = {
  get: (id, key) => (id === 0 && key === 'onlinePlayers' ? [...players.keys()] : props.get(`${id}|${key}`)),
  set: (id, key, v) => props.set(`${id}|${key}`, v),
  getUserByActor: (actorId) => players.get(actorId).user,
  getUserActor: (userId) => [...players].find(([, p]) => p.user === userId)?.[0] ?? 0,
  getActorCellOrWorld: (actorId) => players.get(actorId).cell,
  getActorPos: (actorId) => [...players.get(actorId).pos],
  lookupEspmRecordById: (id) => ({ record: records.get(id), toGlobalRecordId: (local) => local }),
  sendCustomPacket: (userId, text) => packets.push({ userId, ...JSON.parse(text) }),
}
const ctx = { svr }

const logs = []
const ws = new WeatherSystem((line) => logs.push(line))
const weather = (desc, id) => ({ desc, edid: desc, kind: '', id, chance: 1 })
const mk = (id, list) => ({ def: { id, name: id, edid: id, priority: 0, areas: [], weathers: [] }, weathers: list, state: { weatherDesc: list[0].desc, weatherId: list[0].id, startedAt: 1, endsAt: 0, forced: false } })
const A = mk('a', [weather('wa', 1), weather('wa2', 2)])
const B = mk('b', [weather('wb', 3)])
ws.regions.set('a', A)
ws.regions.set('b', B)
for (const w of [...A.weathers, ...B.weathers, weather('storm', 9)]) ws.byDesc.set(w.desc, w)
ws.worldAreas.set(WORLD, [{ region: A, poly: [[0, 0], [10000, 0], [10000, 10000], [0, 10000]] }, { region: B, poly: null }])
ws.mp = svr

const sentSince = (from) => packets.slice(from).map(p => `${p.userId}:${p.region}:${p.weatherId ?? '-'}:${p.transition}`).sort()

// The poll: everyone gets their region's weather once, with the fade settings of the 1:1 clock
ws.poll(ctx)
assert.deepEqual(sentSince(0), ['1:a:1:accelerate', '2:a:1:accelerate', '3:b:3:accelerate'])
assert.deepEqual(packets[0].gameSettings, { fWeatherTransMin: 0.0005, fWeatherTransMax: 0.0125 })
let mark = packets.length
ws.poll(ctx)
assert.equal(packets.length, mark, 'an unchanged weather is not sent again')

// An admin's force reaches the region's players before the next poll, without a fade, and nobody else
assert.equal(ws.force('a', 'storm', null), null)
assert.deepEqual(sentSince(mark), ['1:a:9:instant', '2:a:9:instant'])
assert.equal(logs[logs.length - 1], '[weather] a: storm set outright for 2 player(s)')
mark = packets.length
ws.poll(ctx)
assert.equal(packets.length, mark, 'the poll after a force has nothing left to send')

// So does the clear, which rolls one of the region's own weathers
assert.equal(ws.clear('a'), null)
const rolled = A.state.weatherId
assert.ok(rolled === 1 || rolled === 2)
assert.deepEqual(sentSince(mark), [`1:a:${rolled}:instant`, `2:a:${rolled}:instant`])
mark = packets.length

// A roll at the end of a weather's time goes out in the same poll, with the configured fade
A.state = { ...A.state, endsAt: Date.now() - 1 }
ws.poll(ctx)
assert.deepEqual(sentSince(mark), [`1:a:${A.state.weatherId}:accelerate`, `2:a:${A.state.weatherId}:accelerate`])
assert.notEqual(A.state.weatherId, rolled, 'a roll never repeats the weather')
mark = packets.length

// weatherRequest is answered at once, from the live position
ws.customPacket(3, 'weatherRequest', {}, ctx)
assert.deepEqual(sentSince(mark), ['3:b:3:accelerate'])
mark = packets.length

// A realm without a region releases the override and keeps the stored region
const moveTo = (cell) => {
  players.get(0xff000003).cell = cell
  mark = packets.length
  ws.customPacket(3, 'weatherRequest', {}, ctx)
  return sentSince(mark)
}
assert.deepEqual(moveTo(REALM), ['3:null:-:accelerate'])
assert.equal(props.get(`${0xff000003}|private.weatherRegion`), 'b')
// The realm's hall draws the realm's sky, so it has no region either
assert.deepEqual(moveTo(HALL), ['3:null:-:accelerate'])
// A revive into a temple gives the last region back at once, for the clear sky indoors
assert.deepEqual(moveTo(TEMPLE), ['3:b:3:accelerate'])
assert.deepEqual(moveTo(HALL), ['3:null:-:accelerate'])
// So does a relog there after the realm
assert.deepEqual(moveTo(REALM), ['3:null:-:accelerate'])
ws.disconnect(3, ctx)
assert.deepEqual(moveTo(TEMPLE), ['3:b:3:accelerate'])
assert.deepEqual(moveTo(WORLD), ['3:b:3:accelerate'])

// The poll sees the same places; each pass gets a snapshot of its own
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew
const pollAt = (cell) => {
  players.get(0xff000003).cell = cell
  mark = packets.length
  skew += 1000
  ws.poll(ctx)
  return sentSince(mark)
}
assert.deepEqual(pollAt(REALM), ['3:null:-:accelerate'])
assert.deepEqual(pollAt(REALM), [], 'standing in the realm keeps the release')
assert.deepEqual(pollAt(TEMPLE), ['3:b:3:accelerate'])
assert.deepEqual(pollAt(WORLD), [], 'out of the temple door the region is the one already sent')

// A character whose stored region a realm erased under the old code still holds the clear sky in a temple: a region of the world the
// temple's sky belongs to (or the first region) is sent, unstored; the realm's hall keeps its own sky and the first step outside stores the real one
props.set(`${0xff000003}|private.weatherRegion`, null)
ws.disconnect(3, ctx)
assert.deepEqual(pollAt(TEMPLE), ['3:a:' + A.state.weatherId + ':accelerate'])
assert.equal(props.get(`${0xff000003}|private.weatherRegion`), null, 'the fallback is not stored')
assert.deepEqual(pollAt(HALL), ['3:null:-:accelerate'])
players.get(0xff000003).pos = [20000, 5000, 0]
assert.deepEqual(pollAt(WORLD), ['3:b:3:accelerate'])
assert.equal(props.get(`${0xff000003}|private.weatherRegion`), 'b')
Date.now = realNow

// weatherGameSettings replaces single values of the default fade
const tuned = new WeatherSystem(() => {})
tuned.readSettings({ weatherGameSettings: { fWeatherTransMax: 0.004, fWeatherTransAccel: 9, other: 1 } })
assert.deepEqual(tuned.gameSettings, { fWeatherTransMin: 0.0005, fWeatherTransMax: 0.004, fWeatherTransAccel: 9 })

console.log('ok')
