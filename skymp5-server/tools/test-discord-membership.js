'use strict'

// The login's Discord member check helpers: answer classification, the 429/5xx retry rules and the request pacer: node tools/test-discord-membership.js

const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')
const esbuild = require('esbuild')

const SYSTEMS = path.join(__dirname, '..', 'ts', 'systems')

const load = async () => {
  const { outputFiles } = await esbuild.build({
    stdin: { contents: 'export * from "./discordMembership";', resolveDir: SYSTEMS, sourcefile: 'entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error',
  })
  const file = path.join(SYSTEMS, 'entry.js')
  const compiled = new Module(file)
  compiled.paths = Module._nodeModulePaths(SYSTEMS)
  compiled._compile(outputFiles[0].text, file)
  return compiled.exports
}

const main = async () => {
  const { classifyDiscordAnswer, discordRetryOptions, RequestPacer, DISCORD_RETRIES, UNKNOWN_MEMBER_CODE, UNKNOWN_USER_CODE } = await load()

  // Classification: only a 2xx with a JSON body is a member, only Discord's unknown member and unknown user codes are a non-member
  assert.deepEqual(classifyDiscordAnswer(200, { roles: ['1', '2', 5] }), { kind: 'member', roles: ['1', '2'] })
  assert.deepEqual(classifyDiscordAnswer(200, {}), { kind: 'member', roles: [] })
  assert.deepEqual(classifyDiscordAnswer(200, null), { kind: 'unavailable', status: 200, detail: 'no JSON body' }, 'a body cut off by the deadline is no member answer')
  assert.deepEqual(classifyDiscordAnswer(404, { code: UNKNOWN_MEMBER_CODE, message: 'Unknown Member' }), { kind: 'notMember' })
  assert.deepEqual(classifyDiscordAnswer(404, { code: UNKNOWN_USER_CODE, message: 'Unknown User' }), { kind: 'notMember' }, 'a deleted Discord account is a non-member')
  assert.deepEqual(classifyDiscordAnswer(404, { code: 10004, message: 'Unknown Guild' }), { kind: 'unavailable', status: 404, detail: 'code 10004: Unknown Guild' }, 'unknown guild is a config problem, not a refusal')
  assert.deepEqual(classifyDiscordAnswer(404, null), { kind: 'unavailable', status: 404, detail: '' })
  assert.deepEqual(classifyDiscordAnswer(429, { message: 'You are being rate limited.', retry_after: 1.2 }), { kind: 'unavailable', status: 429, detail: 'You are being rate limited.' })
  assert.deepEqual(classifyDiscordAnswer(502, null), { kind: 'unavailable', status: 502, detail: '' })
  assert.deepEqual(classifyDiscordAnswer(401, { message: '401: Unauthorized', code: 0 }), { kind: 'unavailable', status: 401, detail: 'code 0: 401: Unauthorized' })

  // Retry rules: 429 and 5xx and network errors retry up to the cap, 2xx and 404 do not
  const logged = []
  const opts = discordRetryOptions('test', (t) => logged.push(t))
  const res = (status, retryAfter) => ({ status, headers: { get: (n) => (n === 'retry-after' ? retryAfter : null) } })
  assert.equal(opts.retryOn(0, null, res(429, '0.5')), true)
  assert.equal(opts.retryOn(0, null, res(503, null)), true)
  assert.equal(opts.retryOn(0, new Error('fetch failed'), null), true)
  assert.equal(opts.retryOn(0, null, res(200, null)), false)
  assert.equal(opts.retryOn(0, null, res(404, null)), false)
  assert.equal(opts.retryOn(DISCORD_RETRIES, null, res(429, '1')), false, 'the cap stops retries')
  assert.equal(logged.length, 3)
  assert.match(logged[0], /retrying request .*"status":429/)
  assert.equal(opts.retryDelay(0, null, res(429, '0.5')), 600, 'Retry-After in seconds plus a margin')
  assert.equal(opts.retryDelay(0, null, res(429, '2')), 2100)
  assert.equal(opts.retryDelay(0, null, res(503, null)), 1000)
  assert.equal(opts.retryDelay(2, null, res(503, null)), 3000)
  assert.equal(opts.retryDelay(9, new Error('x'), null), 5000, 'backoff is capped')
  assert.equal(opts.retryDelay(0, null, res(429, '120')), 10000, 'Retry-After is capped')
  // The deadline: fetch rejects with the signal's TimeoutError, which must not be retried
  assert.ok(opts.signal instanceof AbortSignal && !opts.signal.aborted, 'one deadline covers every attempt')
  assert.equal(opts.retryOn(1, Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), null), false, 'an abort is final')
  assert.equal(logged.length, 3, 'the abort is not logged as a retry')

  // Pacer: 4 slots per window, the fifth waits for the window, order is kept
  let now = 0
  const sleeps = []
  const pacer = new RequestPacer(4, 1100, () => now, async (ms) => { sleeps.push(ms); now += ms })
  const order = []
  await Promise.all([1, 2, 3, 4, 5, 6].map((i) => pacer.acquire().then(() => order.push([i, now]))))
  assert.deepEqual(order.map(([i]) => i), [1, 2, 3, 4, 5, 6], 'slots are handed out in call order')
  assert.deepEqual(order.slice(0, 4).map(([, t]) => t), [0, 0, 0, 0], 'four requests go out at once')
  assert.ok(order[4][1] >= 1100 && order[5][1] >= 1100, 'the fifth and sixth wait for the window')
  assert.equal(sleeps.length, 1, 'one sleep covers the burst')
  // A later window is free again
  now += 2000
  const t0 = now
  await pacer.acquire()
  assert.equal(now, t0, 'no wait once the window has passed')

  console.log('test-discord-membership: all checks passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
