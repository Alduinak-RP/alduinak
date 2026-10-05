'use strict'

// StageAbilityTracker and NeedsSystem's use of it: the login delay, swaps, permanent grants and the login window re-send: node tools/test-stage-abilities.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const load = (file) => {
  const source = path.join(__dirname, '..', 'ts', 'systems', file)
  const { outputFiles } = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'error' })
  const compiled = new Module(source)
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const { StageAbilityTracker, LOGIN_SYNC_DELAY_MS, RESYNC_DELAY_MS, LOGIN_WINDOW_MS } = load('stageAbilities.ts')
const { NeedsSystem } = load('needsSystem.ts')

const A = 0xff000001
const T0 = 1e12

// Papyrus AddSpell and RemoveSpell on one actor's learned list, every call recorded
const makeMp = (failOn = 0) => {
  const learned = new Set()
  const calls = []
  const props = new Map([[`${A}:profileId`, 1]])
  return {
    learned, calls, props,
    get: (id, k) => props.get(`${id >>> 0}:${k}`),
    set: (id, k, v) => { props.set(`${id >>> 0}:${k}`, v) },
    sendCustomPacket: () => {},
    lookupEspmRecordById: () => ({}),
    getDescFromId: (id) => id.toString(16),
    isConnected: () => true,
    getUserActor: () => A,
    callPapyrusFunction: (_kind, _cls, method, _self, args) => {
      const spell = parseInt(args[0].desc, 16)
      if (spell === failOn) throw new Error('unknown form')
      calls.push(`${method === 'AddSpell' ? '+' : '-'}${spell.toString(16)}`)
      if (method === 'AddSpell') {
        if (learned.has(spell)) return false
        learned.add(spell)
        return true
      }
      learned.delete(spell)
    },
  }
}

const withClock = async (fn) => {
  const realNow = Date.now
  const realTimeout = global.setTimeout
  const clock = { now: T0 }
  Date.now = () => clock.now
  global.setTimeout = (f) => setImmediate(f)
  try {
    await fn(clock)
  } finally {
    Date.now = realNow
    global.setTimeout = realTimeout
  }
}

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (err) {
    results.push([false, name, err])
  }
}

async function main() {
  await test('the login delay holds changes back and releases them once', () => {
    const t = new StageAbilityTracker('test', () => {})
    t.begin(A, T0)
    assert.equal(t.waiting(A, T0 + LOGIN_SYNC_DELAY_MS - 1), true)
    assert.equal(t.takeLoginSync(A, T0 + LOGIN_SYNC_DELAY_MS - 1), false)
    assert.equal(t.takeLoginSync(A, T0 + LOGIN_SYNC_DELAY_MS), true)
    assert.equal(t.takeLoginSync(A, T0 + LOGIN_SYNC_DELAY_MS + 1), false)
    assert.equal(t.waiting(A, T0 + LOGIN_SYNC_DELAY_MS), false)
    t.end(A)
    assert.equal(t.waiting(A, T0), false)
  })

  await test('a swap removes the held spell and learns the wanted one; the same spell or a failure changes nothing', async () => {
    await withClock(async () => {
      const lines = []
      const mp = makeMp(0x999)
      const t = new StageAbilityTracker('test', (l) => lines.push(l))
      t.begin(A)
      assert.equal(t.swap(mp, A, 0x101, 0x101, 'stageSpell'), false)
      assert.equal(t.swap(mp, A, 0x101, 0x103, 'stageSpell'), true)
      assert.deepEqual(mp.calls, ['-101', '+103'])
      assert.equal(t.swap(mp, A, 0x103, 0x999, 'stageSpell'), false)
      assert.deepEqual(lines, ['[test] stageSpell swap failed for ff000001: Error: unknown form'])
    })
  })

  await test('a permanent grant counts only when the spell was not known', async () => {
    await withClock(async () => {
      const mp = makeMp()
      const t = new StageAbilityTracker('test', () => {})
      t.begin(A)
      mp.learned.add(0x887)
      assert.equal(t.grant(mp, A, 0x887, 'carry weight'), false)
      assert.equal(t.swappedSinceLogin(A), false)
      assert.equal(t.grant(mp, A, 0x900, 'no regen'), true)
      assert.equal(t.swappedSinceLogin(A), true)
      assert.equal(t.grant(mp, A, 0, 'missing'), false)
    })
  })

  await test('a re-send is due RESYNC_DELAY_MS after a load packet and replays each group; nothing once the window passed', async () => {
    await withClock(async (clock) => {
      const lines = []
      const mp = makeMp()
      const t = new StageAbilityTracker('test', (l) => lines.push(l))
      t.begin(A)
      t.resend(mp, A, [{ what: 'stageSpell', held: 0x101, stages: [0x100, 0x101] }])
      assert.deepEqual(mp.calls, [], 'nothing changed yet, nothing to re-send')
      t.swap(mp, A, 0, 0x101, 'stageSpell')
      t.grant(mp, A, 0x887, 'carry weight')
      mp.calls.length = 0
      t.scheduleResend(A)
      assert.equal(t.takeResend(A, clock.now + RESYNC_DELAY_MS - 1), false)
      assert.equal(t.takeResend(A, clock.now + RESYNC_DELAY_MS), true)
      assert.equal(t.takeResend(A, clock.now + RESYNC_DELAY_MS), false)
      t.resend(mp, A, [
        { what: 'stageSpell', held: 0x101, stages: [0, 0x100, 0x101, 0x102] },
        { what: 'carry weight', held: 0x887, stages: [0x887] },
        { what: 'food poisoning', held: 0, stages: [0x918] },
      ])
      assert.deepEqual(mp.calls, ['+100', '-100', '+102', '-102', '-101', '+101', '-887', '+887', '+918', '-918'])
      assert.deepEqual(lines, [
        '[test] ff000001 ability resent after login 101, other stages cleared',
        '[test] ff000001 ability resent after login 887, other stages cleared',
        '[test] ff000001 food poisoning stages cleared after login',
      ])
      t.expire(A, clock.now + LOGIN_WINDOW_MS)
      assert.equal(t.swappedSinceLogin(A), true, 'still inside the window')
      t.expire(A, clock.now + LOGIN_WINDOW_MS + 1)
      assert.equal(t.swappedSinceLogin(A), false)
      clock.now += LOGIN_WINDOW_MS + 1
      t.swap(mp, A, 0x101, 0x102, 'stageSpell')
      assert.equal(t.swappedSinceLogin(A), false, 'a change past the window needs no re-send')
    })
  })

  await test('NeedsSystem: the stage ability waits out the login delay, a load packet re-sends it, the window then closes', async () => {
    await withClock(async (clock) => {
      const mp = makeMp()
      mp.props.set(`${A}:private.needs`, { hunger: 400, fatigue: 1, at: T0, stageSpell: 0x101, fatigueSpell: 0x201 })
      const mastery = { rankOf: () => 1, rankIn: () => 1, holdsInputs: () => true, craftCost: () => ({ rank: 1, half: false }) }
      const lines = []
      const sys = new NeedsSystem((l) => lines.push(String(l)), mastery)
      sys.hungerSpells = [0x100, 0x101, 0x102, 0x103, 0x104, 0x105]
      sys.fatigueSpells = [0, 0x201, 0x202, 0x203, 0x204, 0x205]
      const ctx = { svr: mp, gm: { on: () => {}, emit: () => {} } }
      sys.onActorAssigned(ctx, 1, A)
      sys.poll(ctx)
      assert.deepEqual(mp.calls, [], 'held back by the login delay')
      clock.now += LOGIN_SYNC_DELAY_MS
      sys.poll(ctx)
      assert.deepEqual(mp.calls, ['-101', '+103'], 'hunger 400 is Hungry')
      mp.calls.length = 0
      sys.customPacket(1, 'weatherRequest', {}, ctx)
      clock.now += RESYNC_DELAY_MS
      sys.poll(ctx)
      assert.deepEqual(mp.calls, ['+100', '-100', '+101', '-101', '+102', '-102', '+104', '-104', '+105', '-105', '-103', '+103',
        '+202', '-202', '+203', '-203', '+204', '-204', '+205', '-205', '-201', '+201'])
      assert.equal(mp.props.get(`${A}:private.needs`).stageSpell, 0x103)
      mp.calls.length = 0
      clock.now += LOGIN_WINDOW_MS
      sys.poll(ctx)
      sys.customPacket(1, 'gameTimeRequest', {}, ctx)
      clock.now += RESYNC_DELAY_MS
      sys.poll(ctx)
      assert.deepEqual(mp.calls, [], 'past the login window a load packet re-sends nothing')
    })
  })

  let failed = 0
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) {
      failed++
      console.log(`     ${err && err.message}`)
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main()
