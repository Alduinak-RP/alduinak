'use strict'

// The admin panel's disease control from the packet on: AdminSystem's cap check and target, SurvivalSystem's answer, the adminMenu catalog
// and what goes to admin.log and the Discord admin line: node tools/test-admin-survival.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const SYSTEMS = path.join(__dirname, '..', 'ts', 'systems')
const AUDIT_HEAD = 'export function adminAudit(text: string, alert = true): void {'

// adminAudit records its arguments instead of writing admin.log and queueing the Discord post
const auditRecorder = {
  name: 'audit-recorder',
  setup: (build) => build.onLoad({ filter: /discordAlerts\.ts$/ }, (args) => {
    const source = fs.readFileSync(args.path, 'utf8')
    assert.ok(source.includes(AUDIT_HEAD), 'discordAlerts.ts no longer declares adminAudit(text, alert = true)')
    return { contents: source.replace(AUDIT_HEAD, `${AUDIT_HEAD}\n  (globalThis as any).__adminAudit.push([text, alert]);\n  return;`), loader: 'ts' }
  }),
}

// One bundle, so both systems share the event names
const load = async () => {
  const entry = ['adminSystem', 'survivalSystem', 'adminRoles', 'survivalDiseases', 'stageAbilities'].map((f) => `export * from "./${f}";`).join('\n')
  const { outputFiles } = await esbuild.build({ stdin: { contents: entry, resolveDir: SYSTEMS, sourcefile: 'entry.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error', plugins: [auditRecorder] })
  const file = path.join(SYSTEMS, 'entry.js')
  const compiled = new Module(file)
  compiled.paths = Module._nodeModulePaths(SYSTEMS)
  compiled._compile(outputFiles[0].text, file)
  return compiled.exports
}

const T0 = 2e12
const HOUR = 3600000
const NORD_RACE = 0x13746
const KHAJIIT_RACE = 0x13745
const ROLE_DEV = '111'
const ROLE_GM = '222'

const field = (type, data) => ({ type, data })
const record = (type, editorId, fields = []) => ({ record: { type, editorId, fields }, toGlobalRecordId: (id) => id })
const spit = (type) => { const b = new Uint8Array(36); new DataView(b.buffer).setUint32(8, type, true); return b }
const desc = (id) => `${(id >>> 0).toString(16)}:Test.esp`
const hex = (id) => (id >>> 0).toString(16)

const clock = { now: T0 }
const realNow = Date.now
const realTimeout = global.setTimeout
const tick = () => new Promise((r) => setImmediate(r))

// Actors with a user, a profile, a name and Discord roles; Papyrus spell calls, packets and audit lines recorded
const makeWorld = (X, survivalOn = true) => {
  const records = new Map([[NORD_RACE, record('RACE', 'NordRace')], [KHAJIIT_RACE, record('RACE', 'KhajiitRace')]])
  const spellIds = new Map()
  Object.values(X.defaultDiseases()).forEach((d, i) => d.spells.forEach((edid, s) => {
    const id = 0x41341 + i * 3 + s
    spellIds.set(edid, id)
    records.set(id, record('SPEL', edid, [field('SPIT', spit(1))]))
  }))
  const props = new Map()
  const learned = new Map()
  const users = new Map()
  const calls = []
  const packets = []
  const logs = []
  const known = (id) => { if (!learned.has(id)) learned.set(id, new Set()); return learned.get(id) }
  const mp = {
    get: (id, key) => (id === 0 && key === 'onlinePlayers' ? [...users.keys()] : props.get(`${id >>> 0}:${key}`)),
    set: (id, key, v) => { props.set(`${id >>> 0}:${key}`, v) },
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => desc(id),
    getUserByActor: (id) => users.get(id >>> 0) ?? 65535,
    getActorCellOrWorld: () => { throw new Error('not in the world') },
    getActorPos: () => [0, 0, 0],
    getActorName: (id) => props.get(`${id >>> 0}:appearance`)?.name,
    getUserActor: (userId) => { for (const [a, u] of users) if (u === userId) return a; return 0 },
    isConnected: (userId) => Array.from(users.values()).includes(userId),
    findFormsByPropertyValue: () => [],
    sendCustomPacket: (userId, text) => { packets.push([userId, JSON.parse(text)]) },
    callPapyrusFunction: (_kind, _cls, method, self, args) => {
      const actor = parseInt(self.desc, 16) >>> 0
      const spells = known(actor)
      if (method === 'GetSpellCount') return spells.size
      if (method === 'GetNthSpell') return { desc: desc(Array.from(spells)[args[0]]) }
      const id = parseInt(args[0].desc, 16) >>> 0
      calls.push(`${hex(actor)} ${method === 'AddSpell' ? '+' : '-'}${records.get(id).record.editorId}`)
      if (method === 'AddSpell') { if (spells.has(id)) return false; spells.add(id); return true }
      spells.delete(id)
    },
  }
  const handlers = new Map()
  const gm = { on: (name, f) => handlers.set(name, f), emit: (name, ...args) => handlers.get(name)?.(...args) }
  const ctx = { svr: mp, gm }
  const log = (l) => logs.push(String(l))

  const racial = { traits: () => ({ raceEdid: 'NordRace', rawMeatSafe: false, coldRateMult: 1, warmth: 0 }), maxHealth: () => 100 }
  const weather = { regionOf: () => 'coast', currentWeatherOf: () => ({ id: 0, edid: 'Weather', kind: 'clear' }) }
  const survival = new X.SurvivalSystem(log, racial, { rawMeatIds: () => [] }, weather)
  survival.configure({ survivalEnabled: true, survivalColdEnabled: false, survivalAfflictions: false })
  for (const d of Object.values(survival.dis.diseases)) survival.diseaseSpells.set(d.id, d.spells.map((edid) => spellIds.get(edid)))
  survival.mp = mp
  if (survivalOn) {
    // The two handlers SurvivalSystem.initAsync registers for the panel
    gm.on(X.SURVIVAL_ADMIN_EVENT, (actorId, by, request, done) => done?.(survival.adminRequest(ctx, actorId >>> 0, by, request)))
    gm.on(X.SURVIVAL_RESET_EVENT, (actorId, by, done) => done?.(survival.resetBy(ctx, actorId >>> 0, by)))
  }

  const admin = new X.AdminSystem(log, { listZones: () => [] }, { summaryOf: () => null })
  admin.roleCfg = X.readAdminRoleConfig({ adminRoles: { developer: [ROLE_DEV], gm: [ROLE_GM] }, adminTierCaps: { gm: { players: false } } })

  const join = (actorId, userId, profileId, name, roles = []) => {
    users.set(actorId, userId)
    mp.set(actorId, 'profileId', profileId)
    mp.set(actorId, 'appearance', { raceId: NORD_RACE, name })
    mp.set(actorId, 'private.discordRoles', roles)
    mp.set(actorId, 'respawnPercentages', { health: 1, magicka: 1, stamina: 1 })
    mp.set(actorId, 'type', 'MpActor')
    mp.set(actorId, 'isDead', false)
    survival.onActorAssigned(ctx, userId, actorId)
  }
  const settle = async () => { clock.now += X.LOGIN_SYNC_DELAY_MS; survival.poll(ctx) }
  // Sends one panel packet and returns the packets the admin's client got for it
  const send = async (userId, type, content = {}) => {
    const from = packets.length
    admin.customPacket(userId, type, content, ctx)
    await tick()
    await tick()
    return packets.slice(from).filter(([u]) => u === userId).map(([, p]) => p)
  }
  const act = async (userId, action, target, fields = {}) => (await send(userId, 'adminAction', { action, target: hex(target), ...fields })).filter((p) => p.customPacketType === 'adminActionResult').map((p) => [p.ok, p.text])
  const notices = (actorId) => packets.filter(([u, p]) => u === users.get(actorId) && p.customPacketType === 'masteryNotice').map(([, p]) => p.text)
  return { mp, logs, calls, packets, survival, admin, join, settle, send, act, notices, rec: (id) => mp.get(id, 'private.survival') }
}

const OWNER = 0xff000014
const TESTER = 0xff000021
const GM = 0xff000022
const PLAYER = 0xff000023
const [OWNER_USER, TESTER_USER, GM_USER, PLAYER_USER] = [0, 1, 2, 3]

const results = []
async function test(name, fn) {
  globalThis.__adminAudit = []
  try {
    await fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

// The owner's Test session: a developer, a tester, a GM whose rank lost the players cap and a player without a staff role
const session = async (X, survivalOn = true) => {
  const w = makeWorld(X, survivalOn)
  w.join(OWNER, OWNER_USER, 20, 'catgirl', [ROLE_DEV])
  w.join(TESTER, TESTER_USER, 7, 'testie testerson')
  w.join(GM, GM_USER, 62, 'dude man', [ROLE_GM])
  w.join(PLAYER, PLAYER_USER, 1, 'Quentis Valentis')
  await w.settle()
  w.logs.length = 0
  w.calls.length = 0
  globalThis.__adminAudit.length = 0
  return w
}

async function main() {
  const X = await load()
  Date.now = () => clock.now
  global.setTimeout = (f) => setImmediate(f)
  const audit = () => globalThis.__adminAudit
  const mmdd = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }

  await test('adminMenu: a rank with the players cap gets the catalog of all 27 diseases and each settled row its sickness', async () => {
    const w = await session(X)
    const [menu] = await w.send(OWNER_USER, 'adminMenuRequest')
    assert.equal(menu.customPacketType, 'adminMenu')
    assert.equal(menu.tier, 'developer')
    assert.equal(menu.survival.diseases.length, 27)
    const byId = new Map(menu.survival.diseases.map((d) => [d.id, d]))
    assert.deepEqual(byId.get('ataxia'), { id: 'ataxia', name: 'Ataxia', contagious: true }, "one of Skyrim's")
    assert.deepEqual(byId.get('collywobbles'), { id: 'collywobbles', name: 'Collywobbles', contagious: true }, "one of Oblivion's")
    assert.deepEqual(byId.get('witbane'), { id: 'witbane', name: 'Witbane', contagious: false })
    const row = menu.players.find((p) => p.a === hex(TESTER))
    assert.deepEqual([row.n, row.p, row.online, row.sv.diseases], ['testie testerson', 7, true, []])
    assert.deepEqual(audit(), [], 'opening the panel is not audited')
  })

  await test('Give: the picked disease at the picked stage, on another player and on oneself, logged and audited with the Discord alert on', async () => {
    const w = await session(X)
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease: 'collywobbles', stage: 2 }), [[true, 'testie testerson: now has Collywobbles (advanced)']])
    assert.deepEqual(audit(), [['profile 20 gave a disease to testie testerson (profile 7): now has Collywobbles (advanced)', true]])
    assert.deepEqual(w.logs, [`[survival] ${hex(TESTER)} given collywobbles stage 2 by profile 20, stage 3 at ${mmdd(clock.now + 84 * HOUR)}`])
    assert.deepEqual(w.calls, [`${hex(TESTER)} +AldDisease_Collywobbles2`])
    assert.equal(w.notices(TESTER).pop(), 'You have caught Collywobbles (advanced): you hunger faster and your stamina recovers more slowly. A Cure Disease potion or a healing potion cures it.')
    assert.deepEqual(w.rec(TESTER).diseases.map((d) => [d.id, d.stage, d.from]), [['collywobbles', 2, 'admin profile 20']])
    // The front sends the catalog id; a name typed by hand and no stage work too
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', OWNER, { disease: 'Bone Break Fever' }), [[true, 'catgirl: now has Bone Break Fever']])
    assert.equal(audit().pop()[0], 'profile 20 gave a disease to catgirl (profile 20): now has Bone Break Fever')
    const [menu] = (await w.send(OWNER_USER, 'adminMenuRequest')).filter((p) => p.customPacketType === 'adminMenu')
    assert.deepEqual(menu.players.find((p) => p.a === hex(TESTER)).sv.diseases, [{ id: 'collywobbles', name: 'Collywobbles', stage: 2, nextAt: clock.now + 84 * HOUR }])
    assert.deepEqual(menu.players.find((p) => p.a === hex(OWNER)).sv.diseases.map((d) => [d.id, d.stage]), [['boneBreakFever', 1]])
  })

  await test('Set stage: a held disease moves to the picked stage with its spell swapped', async () => {
    const w = await session(X)
    await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease: 'rockjoint', stage: 1 })
    w.calls.length = 0
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease: 'rockjoint', stage: 3 }), [[true, 'testie testerson: now has Rockjoint (severe)']])
    assert.deepEqual(w.calls, [`${hex(TESTER)} -AldDisease_Rockjoint1`, `${hex(TESTER)} +AldDisease_Rockjoint3`])
    assert.equal(w.logs.pop(), `[survival] ${hex(TESTER)} given rockjoint stage 3 by profile 20 (held, stage set), stays until cured`)
    assert.equal(audit().pop()[0], 'profile 20 gave a disease to testie testerson (profile 7): now has Rockjoint (severe)')
    assert.equal(w.notices(TESTER).pop(), 'Your Rockjoint is now Rockjoint (severe). A Cure Disease potion or a healing potion cures it.')
  })

  await test('Cure and Cure all: one disease or every one, named in the answer and the audit line', async () => {
    const w = await session(X)
    for (const [disease, stage] of [['rockjoint', 3], ['ataxia', 1], ['chills', 2]]) await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease, stage })
    globalThis.__adminAudit.length = 0
    w.calls.length = 0
    assert.deepEqual(await w.act(OWNER_USER, 'survivalCure', TESTER, { disease: 'rockjoint' }), [[true, 'testie testerson: cured Rockjoint (severe)']])
    assert.deepEqual(audit(), [['profile 20 cured testie testerson (profile 7): cured Rockjoint (severe)', true]])
    assert.deepEqual(w.calls, [`${hex(TESTER)} -AldDisease_Rockjoint3`])
    assert.equal(w.logs.pop(), `[survival] ${hex(TESTER)} cured by profile 20 (admin): AldDisease_Rockjoint3`)
    assert.deepEqual(w.rec(TESTER).diseases.map((d) => d.id), ['ataxia', 'chills'])
    assert.deepEqual(await w.act(OWNER_USER, 'survivalCure', TESTER), [[true, 'testie testerson: cured Ataxia, Chills (advanced)']])
    assert.equal(audit().pop()[0], 'profile 20 cured testie testerson (profile 7): cured Ataxia, Chills (advanced)')
    assert.deepEqual(w.rec(TESTER).diseases, [])
    assert.equal(w.notices(TESTER).pop(), 'You are cured of your sickness.')
    assert.deepEqual(await w.act(OWNER_USER, 'survivalCure', TESTER), [[true, 'testie testerson: had no sickness']])
  })

  await test('refusals: a wrong disease, stage or target changes nothing and is not audited', async () => {
    const w = await session(X)
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease: 'plague' }), [[false, "testie testerson: no disease called 'plague'"]])
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease: 'ataxia', stage: 4 }), [[false, 'testie testerson: the stage must be 1 to 3']])
    assert.deepEqual(await w.act(OWNER_USER, 'survivalCure', TESTER, { disease: 'witbane' }), [[false, 'testie testerson: does not have Witbane']])
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', 0xff000999, { disease: 'ataxia' }), [[false, 'Target is no longer online']])
    assert.deepEqual([audit(), w.calls, w.rec(TESTER).diseases], [[], [], []])
  })

  await test('capability: a rank without the players cap is refused and audited, a player without a staff role gets no answer', async () => {
    const w = await session(X)
    assert.deepEqual(await w.act(GM_USER, 'survivalDisease', TESTER, { disease: 'ataxia', stage: 1 }), [[false, 'Your rank cannot use players']])
    assert.deepEqual(await w.act(GM_USER, 'survivalCure', TESTER), [[false, 'Your rank cannot use players']])
    assert.deepEqual(audit(), [['profile 62 (gm) was refused survivalDisease: no players permission', true], ['profile 62 (gm) was refused survivalCure: no players permission', true]])
    const [menu] = await w.send(GM_USER, 'adminMenuRequest')
    assert.deepEqual([menu.survival, menu.players], [null, []], 'no catalog, so the panel draws no disease row')
    globalThis.__adminAudit.length = 0
    assert.deepEqual(await w.send(PLAYER_USER, 'adminAction', { action: 'survivalDisease', target: hex(TESTER), disease: 'ataxia' }), [])
    assert.ok(w.logs.some((l) => l.startsWith(`AdminSystem: refused 'adminAction' from actor ${hex(PLAYER)} (not an admin)`)), w.logs.join('\n'))
    assert.deepEqual([audit(), w.calls, w.rec(TESTER).diseases], [[], [], []])
  })

  await test('survival off: the menu carries no catalog and an action says so', async () => {
    const w = await session(X, false)
    const [menu] = await w.send(OWNER_USER, 'adminMenuRequest')
    assert.equal(menu.survival, null)
    assert.equal(menu.players.find((p) => p.a === hex(TESTER)).sv, undefined)
    assert.deepEqual(await w.act(OWNER_USER, 'survivalDisease', TESTER, { disease: 'ataxia' }), [[false, 'Survival is switched off on this server']])
    assert.deepEqual(audit(), [])
  })

  Date.now = realNow
  global.setTimeout = realTimeout
  let failed = 0
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) { failed++; console.log(err && err.stack ? err.stack : err) }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
