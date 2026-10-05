'use strict'

// The third-person hold of a pose (skymp5-client poseCamera.ts, emoteService.ts, restraintService.ts) against a stub of the engine's camera, controls and graph: node tools/test-pose-camera.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const client = path.join(__dirname, '..', '..', 'skymp5-client', 'src')

const FIRST = 0
const THIRD = 9
const KEYS = { Escape: 1, W: 17, A: 30, S: 31, D: 32, B: 48, Spacebar: 57 }
const KNEEL = 'IdleKneelingEnter'
const WAVE = 'IdleWave'
const EXIT = 'IdleForceDefaultState'
// Idles the stub graph knows, and the pose among them it plays animation-driven
const IDLES = [KNEEL, WAVE]
const DRIVEN = [KNEEL]
const FRAME_MS = 16
// Frames the stub body takes to come back from first person
const SWITCH_FRAMES = 3

let clock = 1000000
Date.now = () => clock

const engine = {
  camera: THIRD, pending: null, pendingFrames: 0, camSwitch: true, movement: true, driven: false, sitState: 0, mounted: false,
  acceptExit: true, events: [], exposedFrames: 0,
}
const test = global.__poseTest = { log: [], notices: [], packetHandlers: [] }
const hooks = []
const handlers = { update: [], buttonEvent: [], browserMessage: [], cameraStateChanged: [] }
let onceUpdate = []
let waits = []

const setCamera = (state) => {
  if (state === engine.camera) return
  const e = { oldStateId: engine.camera, newStateId: state }
  engine.camera = state
  handlers.cameraStateChanged.forEach((cb) => cb(e))
}

const player = {
  getFormID: () => 0x14,
  isDead: () => false,
  isOnMount: () => engine.mounted,
  isSwimming: () => false,
  isSneaking: () => false,
  isWeaponDrawn: () => false,
  isGhost: () => false,
  isInKillMove: () => false,
  getSitState: () => engine.sitState,
  getEquippedItemType: () => 0,
  getFurnitureReference: () => null,
  getAnimationVariableBool: (name) => name === 'bAnimationDriven' && engine.driven,
  setAnimationVariableFloat: () => {},
  setDontMove: () => {},
  setGhost: () => {},
  sheatheWeapon: () => {},
  modActorValue: () => {},
  pushActorAway: () => {},
  playIdle: () => false,
}

// The stub graph: an idle plays only with the body in third person, and the exit leaves a pose only while acceptExit is set
const sendAnimationEvent = (actor, name) => {
  const ctx = { animEventName: name, animationSucceeded: false }
  hooks.forEach((h) => h.enter(ctx))
  if (!ctx.animEventName) return
  if (ctx.animEventName === EXIT) {
    ctx.animationSucceeded = engine.acceptExit
    if (engine.acceptExit) engine.driven = false
  } else if (ctx.animEventName === 'OffsetStop') {
    ctx.animationSucceeded = true
  } else if (IDLES.includes(ctx.animEventName) && engine.camera === THIRD) {
    ctx.animationSucceeded = true
    engine.driven = DRIVEN.includes(ctx.animEventName)
  }
  engine.events.push({ name: ctx.animEventName, camera: engine.camera, ok: ctx.animationSucceeded })
  hooks.forEach((h) => h.leave(ctx))
}

const controls = (enable) => (movement, fighting, camSwitch) => {
  if (movement) engine.movement = enable
  if (camSwitch) engine.camSwitch = enable
}

const platform = {
  DxScanCode: KEYS,
  Game: {
    getPlayer: () => player,
    getFormEx: () => null,
    getCameraState: () => engine.camera,
    forceThirdPerson: () => {
      if (engine.camera === THIRD || engine.pending === THIRD) return
      engine.pending = THIRD
      engine.pendingFrames = SWITCH_FRAMES
    },
    forceFirstPerson: () => { engine.pending = null; setCamera(FIRST) },
    disablePlayerControls: controls(false),
    enablePlayerControls: controls(true),
    isCamSwitchControlsEnabled: () => engine.camSwitch,
    isFightingControlsEnabled: () => true,
  },
  Debug: { sendAnimationEvent },
  Utility: { wait: (seconds) => ({ then: (cb) => { waits.push({ at: clock + seconds * 1000, cb }) } }) },
  Idle: { from: () => null },
  Actor: { from: () => null },
  ObjectReference: { from: () => null },
  hooks: { sendAnimationEvent: { add: (h) => hooks.push(h) } },
}
test.platform = platform

const listeners = {}
const controller = {
  on: (name, cb) => (handlers[name] ||= []).push(cb),
  once: (name, cb) => { assert.equal(name, 'update'); onceUpdate.push(cb) },
  emitter: { on: () => {} },
  lookupListener: (cls) => listeners[cls.name],
}

const frame = () => {
  clock += FRAME_MS
  if (engine.pending !== null && --engine.pendingFrames <= 0) {
    const state = engine.pending
    engine.pending = null
    setCamera(state)
  }
  const due = waits.filter((w) => w.at <= clock)
  waits = waits.filter((w) => w.at > clock)
  due.forEach((w) => w.cb())
  const once = onceUpdate
  onceUpdate = []
  once.forEach((cb) => cb())
  handlers.update.forEach((cb) => cb())
  if (engine.camera === FIRST && engine.driven && !engine.sitState && !engine.mounted) engine.exposedFrames++
}
const run = (ms) => { for (let t = 0; t < ms; t += FRAME_MS) frame() }

// The player's own POV key, which the engine ignores while the switch is off
const pressPov = () => { if (engine.camSwitch) setCamera(engine.camera === FIRST ? THIRD : FIRST) }
const press = (code) => handlers.buttonEvent.forEach((cb) => cb({ code, isDown: true }))
const playEmote = (anim) => {
  press(KEYS.B)
  handlers.browserMessage.forEach((cb) => cb({ arguments: ['emote:play', anim] }))
}
const packet = (content) => test.packetHandlers.forEach((h) => h(content))
const sent = (name) => engine.events.filter((e) => e.name === name)
const logged = (text) => test.log.some((line) => line.includes(text))
const reset = (camera) => {
  assert.equal(engine.camSwitch, true, 'the POV key is back before the next case')
  Object.assign(engine, { camera, pending: null, driven: false, sitState: 0, mounted: false, acceptExit: true, events: [], exposedFrames: 0 })
  test.log.length = 0
  test.notices.length = 0
}

const stubs = {
  name: 'stubs',
  setup (build) {
    const stub = (filter, contents) => {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }))
      build.onLoad({ filter, namespace: 'stub' }, () => ({ contents, loader: 'js' }))
    }
    stub(/^(skyrimPlatform|@skyrim-platform\/skyrim-platform)$/, 'module.exports = global.__poseTest.platform')
    stub(/^\.\/clientListener$/, 'exports.ClientListener = class {}')
    stub(/^\.\/customPacketUtil$/, 'exports.onCustomPacket = (controller, types, handler) => global.__poseTest.packetHandlers.push(handler); exports.notifyNextUpdate = (controller, sp, text) => global.__poseTest.notices.push(text); exports.sendCustomPacket = () => {}')
    stub(/^\.\/widgetMenuUtil$/, `exports.openFormMenu = () => {}; exports.refreshFormMenu = () => {}; exports.closeFormMenu = () => {}; exports.readMenuKeyCode = (sp, name, fallback) => fallback;
      exports.isMenuHotkeyBlocked = () => false; exports.isGameInputBlocked = () => false; exports.buttonEventKeyCode = (e) => e.code; exports.domKeyCode = () => ""; exports.armHeldMenu = () => {}; exports.claimHeldMenu = () => false`)
    stub(/^\.\/sendInputsService$/, 'exports.SendInputsService = class SendInputsService { relayPlayerAnimEvent() {} }')
    stub(/^\.\/mountService$/, 'exports.MountService = class MountService { dismountNow() {} }')
    stub(/^\.\/remoteServer$/, 'exports.getPcInventory = () => undefined')
    stub(/^\.\/playerActionService$/, 'exports.isPlayerCharacterId = () => false')
    stub(/logging$/, 'exports.logTrace = () => {}; exports.logError = () => {}; exports.logToPlatformLog = (service, ...rest) => global.__poseTest.log.push(rest.join(" "))')
    stub(/sync\/animation$/, 'exports.SHEATHE_MAX_POLLS = 15; exports.SHEATHE_POLL_S = 0.2; exports.SHEATHE_SETTLE_S = 0.3; exports.isInSitPose = () => false; exports.needsEmptyHands = () => true; exports.setRefrCollision = () => {}')
    stub(/sync\/movementApply$/, 'exports.setCarrierClone = () => {}')
    stub(/sync\/carryHold$/, `exports.DEFAULT_CARRY_POSE = {}; exports.describeCarryNodes = () => ""; exports.describeHold = () => ""; exports.finiteOr = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
      exports.holdOnCarrier = () => {}; exports.makeHoldState = () => ({}); exports.readCarryPose = (content, pose) => pose; exports.releaseHold = () => {}; exports.restartHold = () => {}`)
    stub(/worldViewMisc$/, 'exports.formIdFromDesc = () => 0; exports.remoteIdToLocalId = (id) => id')
    stub(/objectReferenceEx$/, 'exports.ObjectReferenceEx = { getWorldOrCell: () => 0 }')
  },
}

;(async () => {
  const entry = path.join(__dirname, 'pose-camera-entry.ts')
  const { outputFiles } = await esbuild.build({
    stdin: {
      contents: 'export { EmoteService } from "./services/services/emoteService"; export { RestraintService } from "./services/services/restraintService"; export * as poseCamera from "./services/services/poseCamera";',
      resolveDir: client, sourcefile: entry, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [stubs], logLevel: 'error',
  })
  const compiled = new Module(entry)
  compiled._compile(outputFiles[0].text, entry)
  const { EmoteService, RestraintService, poseCamera } = compiled.exports
  listeners.SendInputsService = { relayPlayerAnimEvent: () => {} }
  listeners.MountService = { dismountNow: () => {} }
  listeners.RestraintService = new RestraintService(platform, controller)
  listeners.EmoteService = new EmoteService(platform, controller)
  run(100)

  // A pose emote from third person: the POV key is off at once and stays off while the graph holds the pose
  playEmote(KNEEL)
  run(100)
  assert.equal(sent(KNEEL).length, 1)
  assert.equal(engine.camSwitch, false, 'the emote switches the POV key off')
  assert.equal(poseCamera.poseCameraHolders(), 'emote')
  pressPov()
  assert.equal(engine.camera, THIRD)
  // Another service switched the key back on and the player used it
  engine.camSwitch = true
  pressPov()
  assert.equal(engine.camera, FIRST)
  run(200)
  assert.equal(engine.camera, THIRD, 'first person under a held pose is turned back')
  assert.equal(engine.camSwitch, false)
  assert.ok(logged('pose camera: first person under a held pose (emote), third person forced'))
  // The movement key ends the emote, but the graph refuses the exit: the hold outlasts the emote
  engine.acceptExit = false
  press(KEYS.W)
  run(1500)
  assert.ok(sent(EXIT).length >= 1)
  assert.equal(engine.driven, true)
  assert.equal(engine.camSwitch, false, 'a pose the graph still holds keeps the POV key off')
  pressPov()
  assert.equal(engine.camera, THIRD)
  run(5000)
  assert.ok(logged('emote camera: the graph still reads bAnimationDriven 5000 ms after IdleKneelingEnter ended'))
  engine.driven = false
  run(600)
  assert.equal(engine.camSwitch, true, 'the POV key comes back two checks after the pose is gone')
  assert.equal(poseCamera.poseCameraHolders(), '')

  // From first person: third person first, the idle only once the body is back
  reset(FIRST)
  playEmote(KNEEL)
  run(2 * FRAME_MS)
  assert.equal(sent(KNEEL).length, 0, 'no idle goes to the graph under a first-person camera')
  assert.equal(engine.camSwitch, false)
  run(800)
  assert.deepEqual(sent(KNEEL).map((e) => [e.camera, e.ok]), [[THIRD, true]])
  assert.equal(engine.exposedFrames, 0)
  press(KEYS.W)
  run(800)
  assert.equal(engine.driven, false)
  assert.equal(engine.camSwitch, true)

  // A one-shot keeps the emote active until a movement key; a chair taken meanwhile owns the camera
  reset(THIRD)
  playEmote(WAVE)
  run(300)
  assert.equal(engine.camSwitch, false)
  engine.sitState = 3
  run(300)
  assert.equal(engine.camSwitch, true, 'seated: the POV key is free')
  engine.sitState = 0
  run(300)
  assert.equal(engine.camSwitch, false, 'stood up with the emote still active: held again')
  // Another pose's state change switches every control on; the emote's hold is put back in the same update
  packet({ customPacketType: 'restraintState', boundHands: false })
  run(2 * FRAME_MS)
  assert.equal(engine.camSwitch, false)
  press(KEYS.W)
  run(800)
  assert.equal(engine.camSwitch, true)

  // An action lock from first person: third person and no POV key until the graph has left the kneel, then first person again
  reset(FIRST)
  packet({ customPacketType: 'actionLock', anim: KNEEL, seconds: 2 })
  run(200)
  assert.equal(engine.camera, THIRD)
  assert.equal(engine.camSwitch, false, 'a lock switches the POV key off')
  run(1000)
  assert.deepEqual(sent(KNEEL).map((e) => [e.camera, e.ok]), [[THIRD, true]])
  pressPov()
  assert.equal(engine.camera, THIRD)
  run(1000)
  assert.equal(sent(EXIT).length, 1, 'the lock ended and sent its exit')
  run(400)
  assert.equal(engine.camSwitch, true, 'the POV key comes back once the kneel is left')
  assert.equal(poseCamera.poseCameraHolders(), '')
  run(1200)
  assert.equal(engine.camera, FIRST, 'the first-person camera of before the lock comes back')
  assert.equal(engine.exposedFrames, 0)

  // A kneel that swallows every exit: five exits, then third person stays held for as long as the graph reads the pose
  reset(THIRD)
  engine.acceptExit = false
  packet({ customPacketType: 'actionLock', anim: KNEEL, seconds: 1 })
  run(1500)
  assert.equal(sent(EXIT).length, 1)
  assert.equal(engine.movement, true, 'the lock is over and the player may move')
  assert.equal(engine.camSwitch, false, 'but not in first person while the kneel shows')
  run(8000)
  assert.equal(sent(EXIT).length, 5)
  assert.ok(logged('not sent again, third person held while the graph reads the pose'))
  assert.equal(test.log.filter((line) => line.includes('not sent again')).length, 1)
  pressPov()
  assert.equal(engine.camera, THIRD)
  assert.equal(engine.camSwitch, false)
  engine.driven = false
  run(400)
  assert.equal(engine.camSwitch, true)
  assert.equal(engine.exposedFrames, 0)

  // The same kneel left for a chair: the furniture owns the camera
  reset(THIRD)
  engine.acceptExit = false
  packet({ customPacketType: 'actionLock', anim: KNEEL, seconds: 1 })
  run(1500)
  assert.equal(engine.camSwitch, false)
  engine.sitState = 3
  run(200)
  assert.equal(engine.camSwitch, true)

  // An animation-driven graph in first person without a hold is logged and left alone
  reset(THIRD)
  engine.driven = true
  pressPov()
  run(100)
  assert.equal(engine.camera, FIRST)
  assert.ok(logged('pose camera: first person with an animation-driven graph and no camera hold, left alone'))
  engine.driven = false
  pressPov()

  console.log('ok: pose camera')
})().catch((e) => { console.error(e); process.exitCode = 1 })
