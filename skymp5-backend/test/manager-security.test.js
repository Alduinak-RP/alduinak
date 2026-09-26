'use strict'
// Security tests for the web Server Manager; run through test/run-manager-tests.js, which executes this file inside a temporary copy

const test   = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const http   = require('http')
const path   = require('path')
const crypto = require('crypto')

const ROOT = process.env.ALDUINAK_MANAGER_TEST_ROOT
if (!ROOT || !path.resolve(__dirname).startsWith(path.resolve(ROOT))) {
  console.error('run these tests with: node test/run-manager-tests.js')
  process.exit(1)
}

const BACKEND = path.resolve(__dirname, '..')
const MANAGER = path.join(ROOT, 'server-manager', 'src')
const LOGS = path.join(ROOT, 'logs')
const DASHBOARD = 'https://dashboard.test.invalid'
const ENV_ADMIN = '100000000000000001'
const ROLE_ADMIN = '1510646026028060782'      // Admin: permissions.manage without admin.*
const ROLE_DEVELOPER = '1510645625568628828'
const ROLE_STAFF = '1514075803934261419'      // Staff: admin.*

const SECRETS = {
  agent: crypto.randomBytes(32).toString('hex'),
  masterToken: 'master-token-' + crypto.randomBytes(12).toString('hex'),
  relay: 'relay-secret-' + crypto.randomBytes(12).toString('hex'),
  // Not a Discord host, so the audit mirror never posts anywhere during tests
  webhook: 'https://webhook.test.invalid/api/webhooks/1/' + crypto.randomBytes(12).toString('hex'),
  botToken: 'bot-token-' + crypto.randomBytes(12).toString('hex'),
  livekit: 'livekit-secret-' + crypto.randomBytes(12).toString('hex'),
  metrics: 'metrics-pass-' + crypto.randomBytes(12).toString('hex'),
  github: 'gh-remote-' + crypto.randomBytes(12).toString('hex'),
  mongo: 'mongodb://skymp:' + crypto.randomBytes(8).toString('hex') + '@127.0.0.1:27017',
}

function writeEnv(agentPort) {
  fs.writeFileSync(path.join(BACKEND, '.env'), [
    `DASHBOARD_PUBLIC_URL=${DASHBOARD}`,
    'DASHBOARD_API_BASE_URL=https://api.test.invalid',
    'WEBSITE_URL=https://website.test.invalid',
    `DASHBOARD_DISCORD_IDS=${ENV_ADMIN}`,
    `MANAGER_AGENT_SECRET=${SECRETS.agent}`,
    `MANAGER_AGENT_PORT=${agentPort}`,
    `MANAGER_LOG_DIR=${path.join(LOGS, 'manager')}`,
    `MASTER_API_AUTH_TOKEN=${SECRETS.masterToken}`,
    `RELAY_SECRET=${SECRETS.relay}`,
    `MANAGER_AUDIT_WEBHOOK_URL=${SECRETS.webhook}`,
    'SERVER_MASTER_KEY=public-key',
    'CUSTOM_API_TOKEN=unknown-key-secret-value',
    '',
  ].join('\n'))
}

fs.mkdirSync(path.join(ROOT, 'server'), { recursive: true })
fs.mkdirSync(path.join(ROOT, 'nginx'), { recursive: true })
fs.mkdirSync(LOGS, { recursive: true })
fs.writeFileSync(process.env.ALDUINAK_SERVER_SETTINGS, JSON.stringify({
  name: 'Test', gamemodePath: './gamemode.js', masterApiAuthToken: SECRETS.masterToken, databaseUri: SECRETS.mongo,
  voiceChat: { enabled: true, apiKey: 'livekit-key-12345678', apiSecret: SECRETS.livekit },
  discordAuth: { botToken: SECRETS.botToken, guilds: [{ guildId: '1' }] },
  metricsAuth: { user: 'metrics', password: SECRETS.metrics },
  additionalServerSettings: [{ type: 'github', repo: 'x/y', token: SECRETS.github }],
  unknownBlock: { sessionCookie: 'cookie-value-123456789', note: `uri ${SECRETS.mongo}` },
}))
fs.writeFileSync(path.join(LOGS, 'gameserver.log'), [
  'boot ok',
  `connecting with ${SECRETS.masterToken}`,
  '__PLAYERSJSON__[{"profileId":1}]',
  `db ${SECRETS.mongo}/skymp`,
  'last line',
  '',
].join('\n'))
fs.writeFileSync(path.join(ROOT, 'nginx', 'access.log'), '1.2.3.4 GET /\n')
writeEnv(1)

const express = require('express')
const sessions = require('../sources/dashboardSessions')
const discordBot = require('../sources/discordBot')
const permissions = require('../sources/permissions')
const safeEqual = require('../sources/safeEqual')
const { adminSessionExpired } = require('../sources/dashboardAuth')
const { managerDenial } = require('../middleware/requireManager')
const { audienceFor } = require('../routes/dashboard-auth')
const protocol = require('../sources/manager/protocol')
const { verifyAuditFile } = require('../sources/manager/audit')
const { checkWriteToken } = require('../routes/master-api')
const { maskSettings, redactText, secretValues } = require(path.join(MANAGER, 'settingsMask'))
const { createAgent, gitProblem } = require(path.join(MANAGER, 'agent'))
const { Builder } = require(path.join(MANAGER, 'build'))
const managerLock = require(path.join(MANAGER, 'managerLock'))
const serverAccess = require('../sources/serverAccess')
const backendConfig = require('../config')

// Discord member roles as the bot would report them; undefined means Discord is unreachable
const discordRoles = {}
discordBot.lookupMemberRoles = async id => (id in discordRoles ? discordRoles[id] : null)
const roleMutations = []
discordBot.addMemberRole = async (id, roleId) => { roleMutations.push(['add', id, roleId]) }
discordBot.removeMemberRole = async (id, roleId) => { roleMutations.push(['remove', id, roleId]) }

const relaySent = []
const fakeRelay = { connected: true, connect() {}, command(text) { relaySent.push(text); return { ok: true } } }
const serviceCalls = []
const git = { ok: true, branch: 'main', head: 'a'.repeat(40), merging: false, dirty: [] }

const agent = createAgent({
  statusAll: async () => ({ nginx: 'SERVICE_RUNNING', backend: 'SERVICE_RUNNING', livekit: 'SERVICE_RUNNING', game: 'SERVICE_STOPPED' }),
  serviceAction: async verb => { serviceCalls.push(verb); return { ok: true, steps: [`Game: ${verb} ok`] } },
  purgePending: () => null,
  // The real Builder concatenates gamemode_extensions; only the TypeScript server build is faked
  builder: log => Object.assign(new Builder(log), {
    buildServer: async () => { log(`server built with ${SECRETS.masterToken}\n`); return { ok: true } },
  }),
  gitState: async () => ({ ...git }),
  discoverLogTargets: async () => [
    { file: path.join(LOGS, 'gameserver.log'), label: 'Game' },
    { file: path.join(ROOT, 'nginx', 'access.log'), label: 'Nginx (access)' },
  ],
  logDirs: () => [LOGS],
  relay: fakeRelay,
})

let agentServer, backendServer, api
const sessionOf = {}

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function login(name, { roles = [], discordId = crypto.randomInt(1e9, 2e9).toString(), aud = 'dashboard', mfa = true } = {}) {
  const perms = permissions.effectivePermissions(discordId, roles)
  const token = sessions.create(discordId, name, null, roles, perms, { aud, mfa })
  sessionOf[name] = { token, discordId }
  return token
}

const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra })
const fromDashboard = token => auth(token, { Origin: DASHBOARD })
const poll = token => auth(token, { 'X-Dashboard-Poll': '1' })

async function waitForJob(token, id) {
  let job
  for (let i = 0; i < 100; i++) {
    job = (await api('GET', `/api/manager/jobs/${id}`, { headers: auth(token) })).json
    if (job.status !== 'running') break
    await new Promise(r => setTimeout(r, 50))
  }
  return job
}

test.before(async () => {
  agentServer = await agent.listen(0)
  writeEnv(agentServer.address().port)
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/auth/dashboard', require('../routes/dashboard-auth'))
  app.use('/api/role-permissions', require('../routes/role-permissions'))
  app.use('/api/server-access', require('../routes/server-access'))
  app.use('/api/manager', require('../routes/manager'))
  await new Promise(resolve => { backendServer = app.listen(0, '127.0.0.1', resolve) })
  api = (method, urlPath, opts) => request(backendServer.address().port, method, urlPath, opts)
})

test.after(() => {
  agentServer.close()
  backendServer.close()
})

test('timing-safe compare rejects empty, different and prefix values', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('ab', 'abc'), false)
  assert.equal(safeEqual('', ''), false)
  assert.equal(safeEqual(undefined, 'abc'), false)
  const res = { status() { return this }, json() { return this } }
  assert.equal(checkWriteToken({ headers: { 'x-auth-token': SECRETS.masterToken } }, res), true)
  assert.equal(checkWriteToken({ headers: { 'x-auth-token': SECRETS.masterToken.slice(0, -1) } }, res), false)
  assert.equal(checkWriteToken({ headers: {} }, res), false)
})

test('escalation guard: privileged permissions are detected on add and remove', () => {
  assert.deepEqual(permissions.privilegedChanges(['players.view'], ['players.view', 'admin.*']), ['admin.*'])
  assert.deepEqual(permissions.privilegedChanges(['admin.*', 'lore.write'], ['lore.write']), ['admin.*'])
  assert.deepEqual(permissions.privilegedChanges([], ['manager.view', 'factions.define', 'admin.proxy']), ['admin.proxy', 'factions.define', 'manager.view'])
  assert.deepEqual(permissions.privilegedChanges(['admin.*'], ['admin.*', 'lore.write']), [])
  assert.deepEqual(permissions.privilegedChanges(['players.manage'], ['players.manage', 'server.access.manage', 'permissions.manage']), ['permissions.manage', 'server.access.manage'])
  assert.deepEqual(permissions.privilegedPermissionsOfRole(ROLE_STAFF), ['admin.*', 'permissions.manage', 'server.access.manage'])
  assert.deepEqual(permissions.privilegedPermissionsOfRole(ROLE_DEVELOPER), [])
})

test('escalation guard: a non-admin permissions.manage holder cannot grant or remove admin, manager or faction definition rights', async () => {
  const adminRole = login('admin-role', { roles: [ROLE_ADMIN] })
  const before = fs.readFileSync(path.join(BACKEND, 'data', 'role-permissions.json'), 'utf8')
  for (const grant of ['admin.*', 'manager.view', 'factions.define']) {
    const r = await api('PUT', `/api/role-permissions/${ROLE_ADMIN}`, { headers: auth(adminRole), body: { name: 'Admin', permissions: ['dashboard.access', 'permissions.manage', grant] } })
    assert.equal(r.status, 403, `${grant} must be refused`)
    assert.match(r.json.error, /only admins can grant or remove/)
  }
  const lateral = await api('PUT', `/api/role-permissions/${ROLE_DEVELOPER}`, { headers: fromDashboard(adminRole), body: { name: 'Developer', permissions: ['dashboard.access', 'server.access.manage'] } })
  assert.equal(lateral.status, 403, 'server.access.manage picks the roles the bot hands out, so only admins grant it')
  const del = await api('DELETE', `/api/role-permissions/${ROLE_STAFF}`, { headers: auth(adminRole) })
  assert.equal(del.status, 403, 'deleting the role that holds admin.* is a removal')
  const strip = await api('PUT', `/api/role-permissions/${ROLE_STAFF}`, { headers: auth(adminRole), body: { name: 'Staff', permissions: ['dashboard.access'] } })
  assert.equal(strip.status, 403)
  assert.equal(fs.readFileSync(path.join(BACKEND, 'data', 'role-permissions.json'), 'utf8'), before, 'role file unchanged')
})

test('escalation guard: a non-privileged edit works and revokes only the sessions whose permissions changed', async () => {
  const adminRole = login('admin-role-2', { roles: [ROLE_ADMIN] })
  const developer = login('developer', { roles: [ROLE_DEVELOPER] })
  const bystander = login('bystander', { roles: [ROLE_ADMIN] })
  const r = await api('PUT', `/api/role-permissions/${ROLE_DEVELOPER}`, { headers: auth(adminRole), body: { name: 'Developer', permissions: ['dashboard.access', 'players.view', 'server.access.view', 'factions.view', 'staff.whitelist_info', 'lore.write'] } })
  assert.equal(r.status, 200)
  assert.equal((await api('GET', '/auth/dashboard/me', { headers: auth(developer) })).status, 401, 'developer session invalidated at once')
  assert.equal((await api('GET', '/auth/dashboard/me', { headers: auth(bystander) })).status, 200, 'unaffected session kept')
})

test('escalation guard: whitelist and banned roles cannot be pointed at a privileged role or changed by non-admins', async () => {
  const accessFile = path.join(BACKEND, 'data', 'server-access.json')
  const adminRole = login('access-admin-role', { roles: [ROLE_ADMIN] })
  const admin = login('access-env-admin', { discordId: ENV_ADMIN })
  const put = (token, body) => api('PUT', '/api/server-access', { headers: fromDashboard(token), body })

  for (const field of ['whitelistRoleId', 'bannedRoleId']) {
    const r = await put(adminRole, { [field]: ROLE_DEVELOPER })
    assert.equal(r.status, 403, `${field} is admin-only`)
    assert.equal(r.json.reason, 'admin')
  }
  assert.equal((await put(adminRole, { serverLocked: true, whitelistRoleId: '' })).status, 200, 'other access settings stay open to server.access.manage')
  assert.equal((await put(admin, { whitelistRoleId: ROLE_STAFF })).status, 403, 'a role holding admin.* is never the whitelist role')
  assert.equal((await put(login('access-no-mfa', { discordId: ENV_ADMIN, mfa: false }), { bannedRoleId: ROLE_DEVELOPER })).json.reason, 'mfa')
  assert.equal((await put(admin, { whitelistRoleId: ROLE_DEVELOPER, serverLocked: false })).status, 200)

  // A privileged role set outside the dashboard (.env or the file) is still never assigned or removed by the bot
  fs.writeFileSync(accessFile, JSON.stringify({ whitelistRoleId: ROLE_STAFF, bannedRoleId: ROLE_STAFF }))
  roleMutations.length = 0
  await assert.rejects(serverAccess.setWhitelisted('200000000000000001', true), err => err.status === 403 && /admin\.\*/.test(err.message))
  await assert.rejects(serverAccess.setWhitelisted('200000000000000002', false), err => err.status === 403)
  await assert.rejects(serverAccess.setBanned('200000000000000001', true), err => err.status === 403)
  assert.deepEqual(roleMutations, [])

  fs.writeFileSync(accessFile, JSON.stringify({ whitelistRoleId: ROLE_DEVELOPER }))
  await serverAccess.setWhitelisted('200000000000000001', true)
  assert.deepEqual(roleMutations, [['add', '200000000000000001', ROLE_DEVELOPER]])
  fs.rmSync(accessFile, { force: true })
})

test('escalation guard: privileged grants need admin.* confirmed by Discord, a dashboard login with 2FA and the dashboard Origin', async () => {
  const staff = login('staff', { roles: [ROLE_STAFF] })
  const adminRole = login('admin-role-3', { roles: [ROLE_ADMIN] })
  const staffId = sessionOf.staff.discordId
  const grant = { name: 'Admin', permissions: ['dashboard.access', 'permissions.manage', 'players.view', 'players.manage', 'server.access.view', 'server.access.manage', 'factions.view', 'factions.manage', 'staff.whitelist_info', 'admin.*'] }

  const unavailable = await api('PUT', `/api/role-permissions/${ROLE_ADMIN}`, { headers: fromDashboard(staff), body: grant })
  assert.equal(unavailable.status, 503, 'no grant while Discord cannot confirm the caller')

  discordRoles[staffId] = [ROLE_STAFF]
  const noOrigin = await api('PUT', `/api/role-permissions/${ROLE_ADMIN}`, { headers: auth(staff), body: grant })
  assert.equal(noOrigin.json.reason, 'origin')
  for (const [name, opts, reason] of [['staff-website', { aud: 'website' }, 'audience'], ['staff-no-mfa', { mfa: false }, 'mfa']]) {
    const token = login(name, { roles: [ROLE_STAFF], ...opts })
    discordRoles[sessionOf[name].discordId] = [ROLE_STAFF]
    const r = await api('PUT', `/api/role-permissions/${ROLE_ADMIN}`, { headers: fromDashboard(token), body: grant })
    assert.equal(r.status, 403, `${reason} refused`)
    assert.equal(r.json.reason, reason)
  }

  const ok = await api('PUT', `/api/role-permissions/${ROLE_ADMIN}`, { headers: fromDashboard(staff), body: grant })
  assert.equal(ok.status, 200)
  assert.equal((await api('GET', '/auth/dashboard/me', { headers: auth(adminRole) })).status, 401, 'sessions of the changed role must log in again')

  const staff2 = login('staff-2', { roles: [ROLE_STAFF] })
  discordRoles[sessionOf['staff-2'].discordId] = []
  const lost = await api('PUT', `/api/role-permissions/${ROLE_ADMIN}`, { headers: fromDashboard(staff2), body: { name: 'Admin', permissions: ['dashboard.access'] } })
  assert.equal(lost.status, 401, 'a caller removed from Staff in Discord is refused')
  assert.equal((await api('GET', '/auth/dashboard/me', { headers: auth(staff2) })).status, 401, 'and that stale session is revoked')
})

test('audience: only logins that returned to the dashboard origin may use the manager', async () => {
  assert.equal(audienceFor(`${DASHBOARD}/`), 'dashboard')
  assert.equal(audienceFor('https://website.test.invalid/dashboard'), 'website')
  assert.equal(audienceFor('https://dashboard.test.invalid.evil.example/'), 'website')
  const website = login('website-admin', { discordId: ENV_ADMIN, aud: 'website' })
  const r = await api('GET', '/api/manager/me', { headers: auth(website) })
  assert.equal(r.status, 403)
  assert.equal(r.json.reason, 'audience')
})

test('MFA: an admin without Discord 2FA is refused, the same admin with 2FA gets in', async () => {
  const noMfa = login('no-mfa', { discordId: ENV_ADMIN, mfa: false })
  const denied = await api('GET', '/api/manager/me', { headers: auth(noMfa) })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.reason, 'mfa')
  assert.equal(managerDenial({ permissions: ['admin.*'], aud: 'dashboard', mfa: 'true' }).reason, 'mfa', 'only a literal true counts')

  const withMfa = login('with-mfa', { discordId: ENV_ADMIN })
  const ok = await api('GET', '/api/manager/me', { headers: auth(withMfa) })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json.consoleVerbs, ['say', 'notify', 'kick', 'players', 'status'])
})

test('non-admins never reach the manager, and admin sessions end after 30 idle minutes or 12 hours', async () => {
  const developer = login('developer-2', { roles: [ROLE_DEVELOPER] })
  assert.equal((await api('GET', '/api/manager/services', { headers: auth(developer) })).json.reason, 'admin')

  const now = Date.now()
  assert.equal(adminSessionExpired({ permissions: ['admin.*'], createdAt: now - 60000, lastUsedAt: now - 31 * 60000 }, now), true)
  assert.equal(adminSessionExpired({ permissions: ['admin.*'], createdAt: now - 13 * 3600000, lastUsedAt: now }, now), true)
  assert.equal(adminSessionExpired({ permissions: ['players.view'], createdAt: now - 13 * 3600000, lastUsedAt: now - 31 * 60000 }, now), false)

  const idle = login('idle-admin', { discordId: ENV_ADMIN })
  sessions.validate(idle).lastUsedAt = Date.now() - 31 * 60000
  assert.equal((await api('GET', '/api/manager/me', { headers: auth(idle) })).status, 401)
  assert.equal(sessions.validate(idle), null, 'idle admin session revoked')
})

test('idle timeout: 30 minutes of Server tab polling alone ends the session, input keeps it alive', async () => {
  const unattended = login('poll-admin', { discordId: ENV_ADMIN })
  const session = sessions.validate(unattended)
  const pollPaths = ['/api/manager/services', '/api/manager/health', '/api/manager/console', '/api/manager/jobs?limit=5']
  let status = 200
  let minutes = 0
  // Each step moves the idle clock back three minutes, as ten polls three minutes apart would
  while (status === 200 && minutes < 40) {
    session.lastUsedAt -= 3 * 60000
    session.createdAt -= 3 * 60000
    minutes += 3
    status = (await api('GET', pollPaths[minutes % pollPaths.length], { headers: poll(unattended) })).status
  }
  assert.equal(status, 401)
  assert.ok(minutes >= 30 && minutes <= 33, `polling kept the session for ${minutes} minutes`)

  const attended = login('input-admin', { discordId: ENV_ADMIN })
  const active = sessions.validate(attended)
  active.lastUsedAt = Date.now() - 29 * 60000
  assert.equal((await api('GET', '/api/manager/services', { headers: poll(attended) })).status, 200)
  assert.ok(Date.now() - active.lastUsedAt >= 29 * 60000, 'a poll leaves the idle clock alone')
  assert.equal((await api('GET', '/api/manager/logs', { headers: auth(attended) })).status, 200)
  assert.ok(Date.now() - active.lastUsedAt < 5000, 'a request after input resets it')
})

test('writes need the dashboard Origin', async () => {
  const admin = login('origin-admin', { discordId: ENV_ADMIN })
  const r = await api('POST', '/api/manager/console', { headers: auth(admin, { Origin: 'https://website.test.invalid' }), body: { text: 'players' } })
  assert.equal(r.status, 403)
  assert.equal(r.json.reason, 'origin')
})

test('console allow-list: only say, notify, kick, players and status reach the game', async () => {
  const ok = [['say hello there', 'say hello there'], ['NOTIFY all restart soon', 'notify all restart soon'], ['kick Bob', 'kick Bob'], ['players', 'players'], ['status', 'status']]
  for (const [input, command] of ok) assert.equal(protocol.parseConsoleCommand(input).command, command)
  for (const input of ['grantspell Bob 92c48', 'revokespell Bob 92c48', 'admin add 5', 'start game', 'build server', '__playersjson', 'say __PLAYERSJSON__[]', 'say', 'notify all', 'players now', 'x'.repeat(501), 'help']) {
    assert.equal(protocol.parseConsoleCommand(input).ok, false, input)
  }

  const admin = login('console-admin', { discordId: ENV_ADMIN })
  relaySent.length = 0
  const refused = await api('POST', '/api/manager/console', { headers: fromDashboard(admin), body: { text: 'grantspell Bob 92c48' } })
  assert.equal(refused.status, 400)
  const sent = await api('POST', '/api/manager/console', { headers: fromDashboard(admin), body: { text: 'say hello\u0007 world' } })
  assert.equal(sent.status, 200)
  assert.deepEqual(relaySent, ['say hello world'])

  agent.pushConsole('__PLAYERSJSON__[{"profileId":1}]\nplayers online: 1', 'output')
  const out = await api('GET', '/api/manager/console', { headers: auth(admin) })
  assert.equal(out.status, 200)
  assert.ok(out.text.includes('players online: 1'))
  assert.ok(!out.text.includes('__PLAYERSJSON__'), 'internal replies filtered')
})

test('secret masking: settings views carry no secret values, only whether they are set', async () => {
  const admin = login('settings-admin', { discordId: ENV_ADMIN })
  const server = await api('GET', '/api/manager/settings/serverSettings', { headers: auth(admin) })
  const env = await api('GET', '/api/manager/settings/backendEnv', { headers: auth(admin) })
  assert.equal(server.status, 200)
  assert.equal(env.status, 200)
  for (const secret of [...Object.values(SECRETS), 'livekit-key-12345678', 'cookie-value-123456789', 'unknown-key-secret-value']) {
    assert.ok(!server.text.includes(secret), `server settings leak ${secret.slice(0, 16)}`)
    assert.ok(!env.text.includes(secret), `backend env leaks ${secret.slice(0, 16)}`)
  }
  const field = (res, key) => [...res.json.fields, ...res.json.extra].find(f => f.key === key)
  assert.equal(field(server, 'masterApiAuthToken').secretSet, true)
  assert.equal(field(server, 'databaseUri').secretSet, true)
  assert.equal(field(server, 'gamemodePath').locked, true)
  assert.deepEqual(field(server, 'voiceChat').value.apiSecret, { secretSet: true })
  assert.deepEqual(field(server, 'additionalServerSettings').value[0].token, { secretSet: true })
  assert.equal(field(env, 'MANAGER_AGENT_SECRET').secretSet, true)
  assert.equal(field(env, 'MANAGER_AUDIT_WEBHOOK_URL').secret, true)
  assert.equal(field(env, 'CUSTOM_API_TOKEN').secret, true)
  assert.equal(field(env, 'DASHBOARD_DISCORD_IDS').locked, true)

  const masked = maskSettings('backendEnv', { RELAY_SECRET: '' })
  assert.equal(masked.fields.find(f => f.key === 'RELAY_SECRET').secretSet, false)
  assert.equal(redactText(`x ${SECRETS.relay} y`, secretValues({}, { RELAY_SECRET: SECRETS.relay })), 'x [redacted] y')
})

test('logs: listed by server-side id without nginx access.log, redacted and without internal lines', async () => {
  const admin = login('logs-admin', { discordId: ENV_ADMIN })
  const list = await api('GET', '/api/manager/logs', { headers: auth(admin) })
  assert.equal(list.status, 200)
  assert.ok(!list.text.includes('access.log'))
  const game = list.json.logs.find(l => l.name === 'gameserver.log')
  assert.ok(game)
  const tail = await api('GET', `/api/manager/logs/${game.id}`, { headers: auth(admin) })
  assert.equal(tail.status, 200)
  assert.ok(tail.json.text.includes('boot ok') && tail.json.text.includes('last line'))
  assert.ok(!tail.text.includes(SECRETS.masterToken) && !tail.text.includes(SECRETS.mongo) && !tail.text.includes('__PLAYERSJSON__'))
  assert.equal((await api('GET', '/api/manager/logs/..%2F..%2Fsecret', { headers: auth(admin) })).status, 400)
  assert.equal((await api('GET', `/api/manager/logs/${game.id}?from=-1`, { headers: auth(admin) })).status, 400)
})

test('jobs: builds refuse a dirty or non-main checkout, run one at a time and record the commit', async () => {
  const admin = login('jobs-admin', { discordId: ENV_ADMIN })
  const start = kind => api('POST', '/api/manager/jobs', { headers: fromDashboard(admin), body: { kind } })

  assert.equal((await api('POST', '/api/manager/jobs', { headers: fromDashboard(admin), body: { kind: 'build.native' } })).status, 400)
  assert.equal((await api('POST', '/api/manager/jobs', { headers: fromDashboard(admin), body: { kind: 'build.server', native: true } })).status, 400)

  git.dirty = ['skymp5-server/ts/index.ts', 'skymp5-client/package.json']
  assert.equal((await start('build.server')).status, 409)
  git.dirty = []
  git.branch = 'feature'
  assert.equal((await start('build.gamemode')).status, 409)
  assert.match(gitProblem({ ...git, branch: 'main', merging: true }), /merge/)
  git.branch = 'main'
  git.dirty = ['skymp5-client/package.json', 'skymp5-backend/routes/version.js']

  const held = managerLock.acquire({ source: 'electron', kind: 'Build client', actor: 'local:Administrator' })
  assert.equal(held.ok, true)
  const busy = await start('build.server')
  assert.equal(busy.status, 409)
  assert.match(busy.json.error, /electron/)
  held.release()

  const started = await start('build.server')
  assert.equal(started.status, 202)
  assert.equal(started.json.commit, git.head)
  const job = await waitForJob(admin, started.json.jobId)
  assert.equal(job.status, 'ok')
  const log = await api('GET', `/api/manager/jobs/${started.json.jobId}/log?from=0`, { headers: auth(admin) })
  assert.ok(log.json.text.includes('server built with [redacted]'))
  assert.equal(managerLock.holder(), null, 'lock released')

  const restart = await start('game.restart')
  assert.equal(restart.status, 202)
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(serviceCalls, ['restart'])
})

test('jobs: a gamemode build records the sha256 of every untracked gamemode_extensions file', async () => {
  const admin = login('gamemode-admin', { discordId: ENV_ADMIN })
  const extDir = path.join(ROOT, 'server', 'gamemode_extensions')
  fs.mkdirSync(extDir, { recursive: true })
  const parts = { '10-first.js': 'globalThis.first = 1\r\n', '20-second.js': 'globalThis.second = 2\n' }
  for (const [name, text] of Object.entries(parts)) fs.writeFileSync(path.join(extDir, name), text)
  fs.writeFileSync(path.join(extDir, 'notes.txt'), 'not a part')
  const hash = data => crypto.createHash('sha256').update(data).digest('hex')
  const files = Object.entries(parts).map(([name, text]) => ({ name, sha256: hash(Buffer.from(text)) }))
  const combined = hash(files.map(f => `${f.sha256}  ${f.name}\n`).join(''))

  const started = await api('POST', '/api/manager/jobs', { headers: fromDashboard(admin), body: { kind: 'build.gamemode' } })
  assert.equal(started.status, 202)
  const job = await waitForJob(admin, started.json.jobId)
  assert.equal(job.status, 'ok')
  assert.deepEqual(job.gamemode, { sha256: combined, files })
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'gamemode.js'), 'utf8'), /globalThis\.first = 1\n\nglobalThis\.second = 2\n$/)
  const log = await api('GET', `/api/manager/jobs/${started.json.jobId}/log?from=0`, { headers: auth(admin) })
  assert.ok(log.json.text.includes(`extensions sha256 ${combined}`))
  const finish = fs.readFileSync(path.join(LOGS, 'manager', 'audit-agent.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .find(r => r.action === 'job.finish' && r.jobId === started.json.jobId)
  assert.equal(finish.gamemodeSha256, combined)
  assert.equal(finish.gamemodeFiles, 2)
})

test('busy lock: polling never removes a lock, and a late stale cleanup puts back a lock taken meanwhile', () => {
  const file = path.join(LOGS, 'manager', 'busy.lock')
  const crashed = JSON.stringify({ pid: 99999999, procStart: 1, source: 'electron', kind: 'crashed build', startedAt: '2026-01-01T00:00:00.000Z' })
  fs.writeFileSync(file, crashed)
  assert.equal(managerLock.holder(), null, 'a dead holder reads as free')
  assert.ok(fs.existsSync(file), 'but only acquire may remove its file')
  const stale = managerLock.readLock(file)

  // Another process clears the stale lock and takes its own before this one's cleanup runs
  fs.unlinkSync(file)
  const other = managerLock.acquire({ source: 'electron', kind: 'Build client' })
  assert.equal(other.ok, true)
  const otherRaw = fs.readFileSync(file, 'utf8')
  managerLock.clearStale(file, stale)
  assert.equal(fs.readFileSync(file, 'utf8'), otherRaw, 'the newer lock survives')
  const second = managerLock.acquire({ source: 'web', kind: 'build.server' })
  assert.equal(second.ok, false, 'so a second build is still refused')
  assert.equal(second.holder.kind, 'Build client')
  other.release()

  fs.writeFileSync(file, crashed)
  const taken = managerLock.acquire({ source: 'web', kind: 'build.gamemode' })
  assert.equal(taken.ok, true, 'acquire clears a stale lock')
  taken.release()
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.stale')), [])
})

test('agent: refuses unsigned, tampered, replayed and proxied calls', async () => {
  const port = agentServer.address().port
  const signed = (method, urlPath, body = '') => protocol.signedHeaders(SECRETS.agent, { method, path: urlPath, actor: { discordId: ENV_ADMIN, username: 't' }, body })
  assert.equal((await request(port, 'GET', '/services')).status, 401)
  assert.equal((await request(port, 'GET', '/logs', { headers: signed('GET', '/services') })).status, 401, 'signature bound to the path')
  assert.equal((await request(port, 'GET', '/jobs?limit=5', { headers: signed('GET', '/jobs?limit=1') })).status, 401, 'signature bound to the query')
  const headers = signed('GET', '/health')
  assert.equal((await request(port, 'GET', '/health', { headers })).status, 200)
  assert.equal((await request(port, 'GET', '/health', { headers })).status, 401, 'nonce replay')
  await assert.rejects(request(port, 'GET', '/health', { headers: { ...signed('GET', '/health'), 'X-Forwarded-For': '8.8.8.8' } }))
  const body = JSON.stringify({ text: 'admin add 1' })
  const direct = await request(port, 'POST', '/console', { headers: { ...signed('POST', '/console', body) }, body: { text: 'admin add 1' } })
  assert.equal(direct.status, 400, 'the agent re-checks the allow-list')
  assert.equal(protocol.isLoopback('10.0.0.5'), false)
  assert.equal(protocol.verifySigned('short', { method: 'GET', path: '/', headers: {}, nonces: new Map() }).status, 503)
})

test('rate limit: actions have their own per-session budget', async () => {
  const admin = login('rate-admin', { discordId: ENV_ADMIN })
  let limited = false
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await api('POST', '/api/manager/console', { headers: fromDashboard(admin), body: { text: 'players' } })
    limited = r.status === 429
  }
  assert.equal(limited, true)
  assert.equal((await api('GET', '/api/manager/me', { headers: auth(admin) })).status, 200, 'reads still work')
})

test('audit: denials and actions are written to hash-chained files', () => {
  const backendAudit = path.join(LOGS, 'manager', 'audit-backend.jsonl')
  const agentAudit = path.join(LOGS, 'manager', 'audit-agent.jsonl')
  for (const file of [backendAudit, agentAudit]) assert.equal(verifyAuditFile(file).ok, true, file)
  const text = fs.readFileSync(backendAudit, 'utf8')
  assert.ok(text.includes('"detail":"mfa"') && text.includes('"detail":"audience"') && text.includes('"action":"role-permissions.put"'))
  for (const secret of Object.values(SECRETS)) assert.ok(!text.includes(secret))
  const lines = fs.readFileSync(backendAudit, 'utf8').split('\n')
  const tampered = backendAudit + '.tampered'
  fs.writeFileSync(tampered, lines.map((l, i) => (i === 1 ? l.replace('"outcome":"', '"outcome":"x') : l)).join('\n'))
  assert.equal(verifyAuditFile(tampered).ok, false)
})
