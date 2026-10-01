import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logToPlatformLog, logTrace } from "../../logging";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { Movement } from "../../sync/movement";
import { setCarrierClone } from "../../sync/movementApply";
import { SHEATHE_MAX_POLLS, SHEATHE_POLL_S, isInSitPose, needsEmptyHands, setRefrCollision } from "../../sync/animation";
import { CarryPose, DEFAULT_CARRY_POSE, describeCarryNodes, describeHold, finiteOr, holdOnCarrier, makeHoldState, readCarryPose, releaseHold, restartHold } from "../../sync/carryHold";
import { isPlayerCharacterId } from "./playerActionService";
import { MountService } from "./mountService";
import { SendInputsService } from "./sendInputsService";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";

// Vanilla behaviour-graph "offset" overlay events (no ESP required), cleared with OffsetStop.
// All three are whitelisted in sync/animation.ts (forcedSyncAnims) so the poses sync to other players.
// Server-overridden pose names (settings.captiveAnimEvent / carrierAnimEvent) must also be whitelisted.
const BOUND_HANDS_ANIM_START = "OffsetBoundStandingStart";
const CARRY_HOLD_ANIM_START = "OffsetCarryBasketStart";
const OFFSET_STOP_ANIM = "OffsetStop";
// Vanilla chair sit idle; it plays without furniture, as on remote copies of seated players, and has no enter clip for a re-send to restart
const CARRIED_ANIM_START = "IdleChairEnterInstant";
const IDLE_EXIT_ANIM = "IdleForceDefaultState";
// Vanilla bleedout kneel (IDLE 13ECC / 13ECE), its own graph layer with its own exit; whitelisted in sync/animation.ts
const BLEEDOUT_ANIM_START = "bleedOutStart";
const BLEEDOUT_ANIM_STOP = "bleedOutStop";
// Relayed to the player's copies through the animation sync, which lets a relayed stagger through
const STAGGER_ANIM = "staggerStart";
const CARRY_OVERLOAD = 10000;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
const PLAYER_FORM_ID = 0x14;

// Lowercase: BSFixedString pools are case-insensitive, so the engine's spelling can vary
const JUMP_START_EVENTS = new Set(["jumpstandingstart", "jumpdirectionalstart"]);

const TICK_MS = 100;
const POSE_REAPPLY_MIN_MS = 500;
// After a pair ends the kill has this long to land before a surviving victim kneels again
const PAIR_END_GRACE_MS = 1500;
// Lets the single-slot animation sync relay a layer exit before the next pose
const POSE_SWAP_DELAY_S = 0.1;
// A server move reattaches the player's 3D a few frames after the packet; the held pose is sent again once that settled
const TELEPORT_SETTLE_S = 0.5;
// Master graph variable set while an idle plays
const IDLE_PLAYING_VAR = "bIdlePlaying";
// An action lock's pose waits at most this long for the player to stand, sheathe and turn to third person
const LOCK_PREP_MAX_MS = SHEATHE_MAX_POLLS * SHEATHE_POLL_S * 1000;
// Each attempt at an action lock's pose is checked this long after it was sent
const LOCK_POSE_VERIFY_S = 0.5;
// A pose seen playing that stops before its lock ends is sent again at most this many times
const LOCK_POSE_MAX_RESTARTS = 2;
// Skyrim.esm IDLE IdleKneelingEnter, the kneel played through the engine's idle path
const KNEEL_ANIM = "IdleKneelingEnter";
const KNEEL_IDLE_ID = 0xe8e52;
// Set by the vanilla graph while a furniture or interaction idle (the kneel, the hoe) plays, and while the bleedout kneel plays
const ANIM_DRIVEN_VAR = "bAnimationDriven";
const BLEEDING_OUT_VAR = "IsBleedingOut";
// The first-person camera a lock left comes back this long after its exit
const LOCK_CAMERA_RESTORE_S = 1;
// A lock pose the graph still holds gets its exit again this long after the last one, this many exits at most
const LOCK_EXIT_RESEND_MS = 1000;
const LOCK_EXIT_MAX_SENDS = 5;
// Checks in a row that find the bleedout kneel at rest, no fall or get-up clip moving it, before its exit is sent again
const LOCK_EXIT_REST_TICKS = 3;
// A bleedout kneel every exit left standing is ended this long after the last one by the engine's knock-down
const LOCK_EXIT_KNOCKDOWN_MS = 2500;
const FIRST_PERSON_CAMERA = 0;

const CARRIER_COLLISION_REFRESH_MS = 1000;
// A lifted body can read as falling, so a carried idle pose is re-sent when no idle plays this long after it was sent instead of after a landing
const CARRIED_IDLE_CHECK_MS = 1000;
// Re-sends in a row that bring no idle back mean the graph variable does not follow this pose; the check stops for the carry
const CARRIED_IDLE_MAX_RESENDS = 3;
// The server's short hop of a carried body takes up to 0.35 s; the hold waits for it to land
const CARRIED_HOP_MS = 500;
const CARRY_NODES_LOG_MS = 1500;

// A carrier's forced sheathe is retried this often; the carry pose waits for the sheathe to blend out
const SHEATHE_RETRY_MS = 1000;
const SHEATHE_SETTLE_MS = 300;

// What the carried client's summary line reports when the carry ends
interface CarryStats {
  startMs: number;
  frames: number;
  // Pose ticks while carried, and those that found the player in the jump or fall state
  ticks: number;
  inAirTicks: number;
  poseResends: number;
  serverMoves: number;
  shortHops: number;
  nodesLogged: boolean;
}

interface PoseAttempt {
  anim: string;
  exit: string;
  // Played with Actor.playIdle instead of the graph event when set
  idleFormId: number;
}

interface ActionLock {
  since: number;
  until: number;
  attempts: PoseAttempt[];
  attempt: number;
  // The graph's answer to the attempt last sent, its pose's variable just before, and whether the pose was then seen playing
  accepted: boolean;
  varBefore: boolean;
  idleResult: boolean;
  playing: boolean;
  // The attempt first seen playing and when, for the lock's summary line
  playedAs: string;
  playedAtMs: number;
  sends: number;
  quietTicks: number;
  restarts: number;
  // The last other event the player's graph took during the lock, named when a playing pose stops
  lastEvent: string;
}

// The exit of an action lock's pose, watched until the graph has left the pose
interface LockExit {
  anim: string;
  exit: string;
  sinceMs: number;
  lastSendMs: number;
  checkedMs: number;
  sends: number;
  restTicks: number;
  clearTicks: number;
  // Another event the graph took since, which ends the watch of a pose read from bAnimationDriven
  otherEvent: string;
}

const isStateIdle = (anim: string): boolean => anim.toLowerCase().startsWith("idle");

// Poses on different graph layers are left one at a time, each with its own exit
const layerOf = (anim: string): string => anim === BLEEDOUT_ANIM_START ? "bleedout" : isStateIdle(anim) ? "idle" : "offset";

const exitOf = (anim: string): string => anim === BLEEDOUT_ANIM_START ? BLEEDOUT_ANIM_STOP : isStateIdle(anim) ? IDLE_EXIT_ANIM : OFFSET_STOP_ANIM;

// The kneel is a local wildcard of the vanilla MT behaviour, refused with a weapon or spell out; the bleedout kneel is taken by the root graph in any state
const lockAttemptsFor = (anim: string, exit: string): PoseAttempt[] => [
  { anim, exit, idleFormId: 0 },
  { anim: KNEEL_ANIM, exit: IDLE_EXIT_ANIM, idleFormId: KNEEL_IDLE_ID },
  { anim: BLEEDOUT_ANIM_START, exit: BLEEDOUT_ANIM_STOP, idleFormId: 0 },
].filter((a, i, all) => all.findIndex((b) => b.anim === a.anim && b.idleFormId === a.idleFormId) === i);

const playingVarOf = (anim: string): string => anim === BLEEDOUT_ANIM_START ? BLEEDING_OUT_VAR : ANIM_DRIVEN_VAR;

const describeAttempt = (lock: ActionLock): string => {
  const a = lock.attempts[lock.attempt];
  return `${a.anim}${a.idleFormId ? ` (idle ${a.idleFormId.toString(16)})` : ""}, attempt ${lock.attempt + 1} of ${lock.attempts.length}`;
};

/**
 * Applies the local player's restraint state (bound hands, being carried,
 * bleeding out, and the captor's carry-hold pose) to controls and animation.
 * Server-authoritative: CaptureSystem owns who may bind/carry whom and consent,
 * BleedoutSystem owns the bleedout timer and death; this service only reflects
 * the resulting state on the local client.
 *
 * Protocol: Server -> Client, {@link MsgType.CustomPacket} with a JSON dump.
 * Fields are optional; only the ones present are changed:
 *
 *   // The restrained player (captive); carrier is the carrier's server actor id, 0 when not carried:
 *   { "customPacketType": "restraintState", "boundHands": true }
 *   { "customPacketType": "restraintState", "carried": true, "carrier": 4278190090, "anim": "OffsetBoundStandingStart",
 *     "carriedAnim": "IdleChairEnterInstant", "carryForward": 16, "carryUp": 40, "carryYaw": 45 }
 *   { "customPacketType": "restraintState", "boundHands": false, "carried": false, "carrier": 0 }
 *
 *   // The carrier (pose only, no control change); target is the carried actor's server id, an NPC's clone is posed here, 0 for a passive job load:
 *   { "customPacketType": "carryState", "carrying": true, "anim": "OffsetCarryBasketStart", "target": 4278190090,
 *     "carriedAnim": "IdleChairEnterInstant", "carryForward": 16, "carryUp": 40, "carryYaw": 45 }
 *   { "customPacketType": "carryState", "carrying": false }
 *
 *   // A player at 0 health (BleedoutSystem); died skips the stand-up:
 *   { "customPacketType": "bleedoutState", "downed": true, "seconds": 15 }
 *   { "customPacketType": "bleedoutState", "downed": false, "died": false }
 *
 *   // A prisoner or a headsman at an execution block (ExecutionSystem), with the pose's own exit when it has one; "" leaves the block:
 *   { "customPacketType": "executionState", "pose": "IdleExecutioneeIdle" }
 *   { "customPacketType": "executionState", "pose": "IdleExecutionerIdle", "exit": "IdleChairExitStart" }
 *
 *   // Timed work such as harvesting (actorUtil.sendActionLock); a new lock replaces the old one:
 *   { "customPacketType": "actionLock", "anim": "IdleKneelingEnter", "seconds": 5, "exitAnim": "IdleForceDefaultState" }
 *
 *   // A stagger the server decided, such as a block without the stamina for it (actorUtil.sendStagger):
 *   { "customPacketType": "stagger", "magnitude": 0.5 }
 *
 * Effects on the local player:
 *   - boundHands: plays the bound-hands pose and disables fighting/sneaking/
 *     activation. Movement stays enabled so the prisoner can be marched/walked.
 *   - carried: plays a seated pose held carryForward ahead of and carryUp above
 *     the carrier's clone every frame (sync/carryHold.ts: SkyrimPlatform's
 *     frame-start hold where the client has it), turned carryYaw degrees from
 *     the carrier's facing and turning with it. Fully immobilised in third
 *     person; the camera can still orbit. The carrier's clone stops colliding
 *     with the player meanwhile. The carrier and observers hold their copy of
 *     the body on their own copy of the carrier (ff_carriedBy). One summary
 *     line per carry goes to the Platform log.
 *   - carrying: plays the carry-hold pose; fighting is disabled and a drawn
 *     weapon, fists or spell is sheathed. The carrier can still walk.
 *   - downed: kneels in the bleedout pose, cannot move, fight, sneak, activate
 *     or open menus, and is a ghost locally so no local hit lands; held in
 *     third person for the whole bleedout, the camera can still orbit.
 *     Carried wins over downed, downed over bound.
 *   - executionState: takes the block pose (the prisoner's kneel or the
 *     headsman's stance) in third person, held in place like a downed player
 *     but with menus and a free camera, and leaves it through its exit; wins
 *     over bound, the cuffs stay on.
 *   - standForPair (PairedIdleService, a finish off with standUp): the kneel is
 *     left for the length of the pair while the controls stay locked; a victim
 *     who survives it kneels again shortly after pairEnded, or when it lapses.
 *   - actionLock: plays anim and holds the player still without fighting,
 *     sneaking or activation for the seconds, then plays exitAnim. The pose
 *     waits (up to 3 s) until the player has stood up from a sneak, sheathed a
 *     weapon (when its copies would sheathe) and turned to third person, since
 *     the graph refuses an idle in any of those and a first-person camera
 *     shows none; a first-person camera comes back 1 s after the exit. Each
 *     attempt is checked 0.5 s after it was sent (the graph's answer and the
 *     graph variable the pose sets); one that shows nothing moves on to the
 *     kneel through the engine's idle path (Skyrim.esm IdleKneelingEnter,
 *     relayed to the copies by hand), then to the bleedout kneel, which the
 *     root graph takes in any state. A player already in the pose (the emote
 *     kneel) keeps it. A pose that stops playing before the lock ends is sent again, twice at
 *     most. Going down or dying ends it early, every other pose wins over it,
 *     and a mounted or swimming player or one another pose already holds
 *     ignores it. Every attempt, wait and stop is logged to the Platform log.
 *     After the exit the pose's graph variable is read every 0.1 s: while the
 *     graph still holds the pose the exit goes out again 1 s after the last
 *     one, 5 exits at most (the bleedout kneel only while it rests, since its
 *     fall and get-up are clips), and a bleedout kneel that outlasts them all
 *     is ended by the engine's knock-down and get-up. The first-person camera
 *     comes back only once the pose is left.
 *   - stagger: plays staggerStart with the magnitude on the player, whose
 *     copies relay it; skipped while dead, mounted, seated or posed.
 *   - any of the above: jumping is blocked and the pose is re-applied after a
 *     fall and after a server move (onTeleported), whose 3D reattach can
 *     swallow a pose sent around it. A carried idle pose is re-applied when no
 *     idle plays instead of after a fall, since a lifted body can read as falling.
 *
 * A capture or carry ends a downed target's bleedout server-side, so carried and
 * downed never last together.
 *
 * The service is inert until the server sends a packet.
 */
export class RestraintService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());

    // Jumping ends the offset pose; block it while a pose is held
    this.sp.hooks.sendAnimationEvent.add({
      enter: (ctx) => {
        if (this.isPoseLocked && JUMP_START_EVENTS.has(ctx.animEventName.toLowerCase())) {
          ctx.animEventName = "";
        }
      },
      leave: (ctx) => {
        if (ctx.animationSucceeded && isStateIdle(ctx.animEventName)) this.lastStateIdle = ctx.animEventName.toLowerCase();
        if (this.lockExit && ctx.animationSucceeded && ctx.animEventName.toLowerCase() !== this.lockExit.exit.toLowerCase()) this.lockExit.otherEvent = ctx.animEventName;
        if (!this.lock) return;
        if (ctx.animEventName.toLowerCase() === this.lockPose.toLowerCase()) this.lock.accepted = ctx.animationSucceeded;
        else if (ctx.animationSucceeded) this.lock.lastEvent = ctx.animEventName;
      },
    }, 0x14, 0x14);

    // A game reload wipes the pose; restore it
    this.controller.emitter.on("gameLoad", () => {
      if (this.isPoseLocked) {
        this.controller.once("update", () => this.reapplyPoses());
      }
    });

    // The server ends a disconnected carrier's carry and kills a disconnected downed player but cannot tell this client; a surviving restraint is re-sent on login
    this.controller.emitter.on("connectionDisconnect", () => {
      if (this.carrying) {
        this.carrying = false;
        this.applyCarryAnim();
      }
      if (this.downed || this.lock || this.executionPose || this.carried || this.boundHands) {
        this.downed = false;
        this.lock = null;
        this.executionPose = "";
        this.pairedUntil = 0;
        this.carried = false;
        this.carrierId = 0;
        this.boundHands = false;
        this.applyState();
      }
    });

    this.controller.emitter.on("applyDeathStateEvent", (e) => this.onApplyDeathState(e));
  }

  // True while a restraint, carry, bleedout, execution or action pose owns the player's animation.
  get isPoseLocked(): boolean {
    return this.boundHands || this.carried || this.carrying || this.downed || !!this.executionPose || !!this.lock;
  }

  get isCarried(): boolean {
    return this.carried;
  }

  get isDowned(): boolean {
    return this.downed;
  }

  get isCarrying(): boolean {
    return this.carrying;
  }

  // The pose last sent to the player, "" before any
  get currentPose(): string {
    return this.appliedPose;
  }

  // The action lock's current attempt, "" without a lock
  private get lockPose(): string {
    return this.lock ? this.lock.attempts[this.lock.attempt].anim : "";
  }

  // Must run on update, right after the move; a pose the reattach swallowed is never re-sent otherwise
  onTeleported(): void {
    if (this.carried) this.pauseHold(TELEPORT_SETTLE_S * 1000, false);
    if (!this.isPoseLocked) return;
    this.sp.Utility.wait(TELEPORT_SETTLE_S).then(() => {
      this.controller.once("update", () => {
        if (!this.isPoseLocked) return;
        this.reapplyPoses();
        logToPlatformLog(this, `pose ${this.appliedPose} re-sent after teleport`);
      });
    });
  }

  // The server's short same-cell hop of the carried player (a put-down or a door arrival) lands before the hold resumes
  onCarriedHop(): void {
    if (this.carried) this.pauseHold(CARRIED_HOP_MS, true);
  }

  private pauseHold(ms: number, shortHop: boolean): void {
    this.holdPausedUntil = Date.now() + ms;
    releaseHold(this.holdState);
    restartHold(this.holdState, this.holdPausedUntil);
    if (this.carryStats) {
      this.carryStats.serverMoves++;
      if (shortHop) this.carryStats.shortHops++;
    }
  }

  // Must run on update: the kneel is left for the pair, the controls stay locked
  standForPair(ms: number): void {
    this.pairedUntil = Date.now() + ms;
    this.applyStateNow();
  }

  // The pair is over on this client; the tick kneels a survivor again once the kill had its chance
  pairEnded(): void {
    if (this.pairedUntil) this.pairedUntil = Math.min(this.pairedUntil, Date.now() + PAIR_END_GRACE_MS);
  }

  private get paired(): boolean {
    return Date.now() < this.pairedUntil;
  }

  // Observers must see a held pose: no locomotion, and the server keeps the last animation only for Standing
  filterOwnMovement(movement: Movement): Movement {
    if (this.carried || this.downed || this.executionPose || this.lock) {
      movement.runMode = "Standing";
      movement.direction = 0;
      movement.isInJumpState = false;
      movement.speed = 0;
    }
    return movement;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }

    const type = content["customPacketType"];
    if (type === "restraintState") {
      if (typeof content["boundHands"] === "boolean") {
        this.boundHands = content["boundHands"];
      }
      if (typeof content["carried"] === "boolean") {
        this.carried = content["carried"];
      }
      if (typeof content["carrier"] === "number") {
        this.carrierId = content["carrier"];
      }
      if (!this.carried) {
        this.carrierId = 0;
      }
      if (typeof content["anim"] === "string" && content["anim"]) {
        this.captiveAnim = content["anim"] as string;
      }
      if (typeof content["carriedAnim"] === "string" && content["carriedAnim"]) {
        this.carriedAnim = content["carriedAnim"] as string;
      }
      this.readCarryOffsets(content);
      logTrace(this, `restraintState boundHands=${this.boundHands} carried=${this.carried} carrier=${this.carrierId.toString(16)}`);
      this.applyState();
    } else if (type === "carryState") {
      if (typeof content["carrying"] === "boolean") {
        this.carrying = content["carrying"];
      }
      if (typeof content["anim"] === "string" && content["anim"]) {
        this.carrierAnim = content["anim"] as string;
      }
      if (typeof content["carriedAnim"] === "string" && content["carriedAnim"]) {
        this.carriedAnim = content["carriedAnim"] as string;
      }
      this.readCarryOffsets(content);
      // A carried player poses itself through restraintState; only an NPC's clone is posed by the carrier
      const target = typeof content["target"] === "number" ? content["target"] as number : 0;
      this.carriedNpcId = this.carrying && target >= FIRST_DYNAMIC_REMOTE_ID && !isPlayerCharacterId(this.controller, target) ? target : 0;
      logTrace(this, `carryState carrying=${this.carrying} npc=${this.carriedNpcId.toString(16)}`);
      this.applyCarryAnim();
    } else if (type === "executionState" && typeof content["pose"] === "string") {
      this.executionPose = content["pose"];
      this.executionExit = typeof content["exit"] === "string" ? content["exit"] : "";
      logTrace(this, `executionState pose=${this.executionPose} exit=${this.executionExit}`);
      this.applyState();
    } else if (type === "actionLock" && typeof content["anim"] === "string" && content["anim"]) {
      const anim = content["anim"];
      const seconds = finiteOr(content["seconds"], 0);
      const exitAnim = typeof content["exitAnim"] === "string" && content["exitAnim"] ? content["exitAnim"] : IDLE_EXIT_ANIM;
      logTrace(this, `actionLock ${anim} for ${seconds} s`);
      this.controller.once("update", () => this.startLock(anim, seconds, exitAnim));
    } else if (type === "stagger") {
      const magnitude = Math.min(1, Math.max(0.1, finiteOr(content["magnitude"], 0.5)));
      this.controller.once("update", () => this.stagger(magnitude));
    } else if (type === "bleedoutState" && typeof content["downed"] === "boolean") {
      this.downed = content["downed"];
      if (this.downed) this.lock = null;
      // A death ends the kneel in a ragdoll, so no stand-up is sent
      if (!this.downed && content["died"] === true && this.appliedPose === BLEEDOUT_ANIM_START) {
        this.appliedPose = OFFSET_STOP_ANIM;
      }
      logTrace(this, `bleedoutState downed=${this.downed}`);
      if (this.downed) {
        this.controller.once("update", () => this.controller.lookupListener(MountService).dismountNow("bleedout"));
      }
      this.applyState();
    }
  }

  // A rider, a swimmer, a dead player or one another pose holds skips the lock; the server's side of the work goes on
  private startLock(anim: string, seconds: number, exitAnim: string): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    if (seconds > 0 && (player.isDead() || player.isOnMount() || player.isSwimming() || this.boundHands || this.carried || this.carrying || this.downed)) return;
    const now = Date.now();
    this.lock = seconds > 0 ? {
      since: now, until: now + seconds * 1000, attempts: lockAttemptsFor(anim, exitAnim), attempt: 0,
      accepted: false, varBefore: false, idleResult: false, playing: false, playedAs: "", playedAtMs: 0, sends: 0, quietTicks: 0, restarts: 0, lastEvent: "",
    } : null;
    this.lockBlockedMs = 0;
    this.lockWaits.clear();
    this.applyStateNow();
  }

  private stagger(magnitude: number): void {
    const player = this.sp.Game.getPlayer();
    if (!player || player.isDead() || player.isOnMount() || this.isPoseLocked || player.getFurnitureReference()) return;
    logTrace(this, `stagger ${magnitude}`);
    player.setAnimationVariableFloat("staggerMagnitude", magnitude);
    this.sp.Debug.sendAnimationEvent(player, STAGGER_ANIM);
  }

  // Death ends a bleedout, an execution pose or an action lock without the stand-up
  private onApplyDeathState(e: ApplyDeathStateEvent): void {
    if (!e.isDead || !(this.downed || this.lock || this.executionPose) || e.actor.getFormID() !== PLAYER_FORM_ID) return;
    if ([BLEEDOUT_ANIM_START, this.lockPose, this.executionPose].includes(this.appliedPose)) this.appliedPose = OFFSET_STOP_ANIM;
    this.downed = false;
    this.lock = null;
    this.executionPose = "";
    this.pairedUntil = 0;
    this.applyState();
  }

  // The carry holds run every frame; landing detection (event-name independent), locks and pose checks are throttled
  private onUpdate(): void {
    this.trackCarry();
    this.watchLockExit();
    if (!this.isPoseLocked) {
      this.wasInJump = false;
      this.poseDirty = false;
      return;
    }
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    const now = Date.now();
    if (this.carrying) {
      this.moveCarriedNpc(player, now);
    }
    if (this.carried && this.carrierId && now >= this.holdPausedUntil) {
      this.followCarrier(player, now);
    }
    if (now - this.lastTickMs < TICK_MS) {
      return;
    }
    this.lastTickMs = now;

    if (this.lock && now >= this.lock.until) {
      this.logLockSummary(this.lock, now);
      this.lock = null;
      this.applyStateNow();
    }
    this.watchLockPose(player, now);
    // The pair lapsed without a death: a downed victim kneels again
    if (this.pairedUntil && now >= this.pairedUntil) {
      this.pairedUntil = 0;
      this.applyStateNow();
    }

    const inJump = player.getAnimationVariableBool("bInJumpState");
    if (this.carried && this.carryStats) {
      this.carryStats.ticks++;
      if (inJump) this.carryStats.inAirTicks++;
    }
    const idleCheck = this.carried && isStateIdle(this.carriedAnim) && !this.idleCheckOff;
    if (this.wasInJump && !inJump && !idleCheck) {
      this.poseDirty = true;
    }
    this.wasInJump = inJump;
    if (idleCheck) {
      this.checkCarriedIdle(player, now);
    }
    if (this.carrying) {
      this.holdCarrierFightLock(player, now);
      this.poseCarriedNpc();
    }
    if (this.poseDirty && (!inJump || idleCheck) && now >= this.nextPoseReapplyMs) {
      this.poseDirty = false;
      this.nextPoseReapplyMs = now + POSE_REAPPLY_MIN_MS;
      if (this.carried && this.carryStats) this.carryStats.poseResends++;
      this.reapplyPoses();
    }
    if (this.carryStats && !this.carryStats.nodesLogged && now - this.carryStats.startMs >= CARRY_NODES_LOG_MS) {
      this.carryStats.nodesLogged = true;
      logToPlatformLog(this, describeCarryNodes(player, this.sp.ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(this.carrierId)))));
    }
  }

  // Held on the carrier's clone, which stops colliding with the player
  private followCarrier(player: Actor, now: number): void {
    const carrierLocalId = remoteIdToLocalId(this.carrierId);
    const carrier = this.sp.ObjectReference.from(this.sp.Game.getFormEx(carrierLocalId));
    if (!carrier || !carrier.is3DLoaded() ||
      ObjectReferenceEx.getWorldOrCell(carrier) !== ObjectReferenceEx.getWorldOrCell(player)) {
      releaseHold(this.holdState);
      return;
    }
    this.keepCarrierCollisionOff(carrierLocalId);
    setCarrierClone(carrierLocalId);
    holdOnCarrier(player, carrier, this.carryPose, this.holdState, now);
  }

  // The carrier hosts the carried NPC, so moving its clone here moves it for everyone
  private moveCarriedNpc(player: Actor, now: number): void {
    const npc = this.posedNpcLocalId ? this.sp.Actor.from(this.sp.Game.getFormEx(this.posedNpcLocalId)) : null;
    if (!npc || !npc.is3DLoaded() || ObjectReferenceEx.getWorldOrCell(npc) !== ObjectReferenceEx.getWorldOrCell(player)) {
      releaseHold(this.npcHoldState);
      return;
    }
    this.keepCarrierCollisionOff(this.posedNpcLocalId);
    holdOnCarrier(npc, player, this.carryPose, this.npcHoldState, now);
  }

  // A pose the graph variable cannot see is re-sent only a few times, then left alone for the carry
  private checkCarriedIdle(player: Actor, now: number): void {
    if (this.poseDirty || now - this.poseSentMs < CARRIED_IDLE_CHECK_MS) {
      return;
    }
    if (player.getAnimationVariableBool(IDLE_PLAYING_VAR)) {
      this.idleResends = 0;
      return;
    }
    if (this.idleResends >= CARRIED_IDLE_MAX_RESENDS) {
      this.idleCheckOff = true;
      logToPlatformLog(this, `carried pose ${this.carriedAnim}: no idle playing after ${this.idleResends} re-sends, idle check off for this carry`);
      return;
    }
    this.idleResends++;
    this.poseDirty = true;
  }

  // One summary line per carry, so a test says what the hold cost and how close it stayed
  private trackCarry(): void {
    if (this.carried && !this.carryStats) {
      this.carryStats = { startMs: Date.now(), frames: 0, ticks: 0, inAirTicks: 0, poseResends: 0, serverMoves: 0, shortHops: 0, nodesLogged: false };
      releaseHold(this.holdState);
      this.holdState = makeHoldState();
      this.idleResends = 0;
      this.idleCheckOff = false;
    } else if (!this.carried && this.carryStats) {
      const c = this.carryStats;
      releaseHold(this.holdState);
      const seconds = (Date.now() - c.startMs) / 1000;
      logToPlatformLog(this, `carry summary: ${seconds.toFixed(1)} s held, ${Math.round(c.frames / Math.max(seconds, 0.001))} fps average while carried, ` +
        `${describeHold(this.holdState)}, ${c.poseResends} pose re-sends (${this.carriedAnim}), ${c.inAirTicks} of ${c.ticks} checks in the jump or fall state, ` +
        `${c.serverMoves} server moves (${c.shortHops} short hops)`);
      this.carryStats = null;
    }
    if (this.carryStats) this.carryStats.frames++;
  }

  private readCarryOffsets(content: Record<string, unknown>): void {
    this.carryPose = readCarryPose(content, this.carryPose);
  }

  // Re-asserted periodically: a respawned clone or a synced get-up animation turns collision back on
  private keepCarrierCollisionOff(localId: number): void {
    const now = Date.now();
    if (localId === this.collisionOffId && now < this.nextCollisionRefreshMs) {
      return;
    }
    if (localId !== this.collisionOffId) {
      this.restoreCarrierCollision();
    }
    try {
      setRefrCollision(localId, false);
    } catch (e) {
      return;
    }
    this.collisionOffId = localId;
    this.nextCollisionRefreshMs = now + CARRIER_COLLISION_REFRESH_MS;
  }

  private restoreCarrierCollision(): void {
    const id = this.collisionOffId;
    this.collisionOffId = 0;
    setCarrierClone(0);
    // A carrier clone that sat down meanwhile keeps the sit sync's collision off
    if (!id || !this.sp.Game.getFormEx(id) || isInSitPose(id)) {
      return;
    }
    try {
      setRefrCollision(id, true);
    } catch (e) {
      // clone went away
    }
  }

  // Must run on update; forces every held pose to be sent again
  reapplyPoses(): void {
    if (this.boundHands || this.carried || this.downed || this.executionPose || this.lock) {
      // A pair under way owns the animation; only the controls are re-asserted
      if (!this.paired) this.appliedPose = "";
      this.applyStateNow();
    }
    if (this.carrying) {
      this.appliedCarrierAnim = "";
      this.posedNpcLocalId = 0;
      this.applyCarryAnimNow();
    }
  }

  private applyState(): void {
    // Native game-thread calls throw "can't be called in this context" from the packet handler; defer to update.
    this.controller.once("update", () => this.applyStateNow());
  }

  private applyStateNow(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }

    // Carried shows the sitting pose, downed the bleedout kneel (left for a pair), then the execution pose, bound the captive pose, then an action lock's pose, otherwise clear it; only fire on transition.
    const desiredPose = this.carried ? this.carriedAnim : this.paired && (this.downed || this.executionPose) ? OFFSET_STOP_ANIM
      : this.downed ? BLEEDOUT_ANIM_START : this.executionPose ? this.executionPose
      : this.boundHands ? this.captiveAnim : this.lock ? this.lockPose : OFFSET_STOP_ANIM;
    if (this.lock && desiredPose === this.lockPose && desiredPose !== this.appliedPose && !this.lockPoseReady(player, this.lock)) {
      // The tick poses once the player stands sheathed in third person
      this.poseDirty = true;
      this.nextPoseReapplyMs = Date.now() + SHEATHE_SETTLE_MS;
    } else if (desiredPose !== this.appliedPose) {
      this.setPose(player, desiredPose);
    }
    this.restoreLockCamera();
    this.applyDownedGhost(player);

    // Recompute the control lock each time. Argument order:
    // (movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType).
    if (this.carried) {
      // First person would sit inside the pose and fight the forced heading, so third person is locked; re-forced after a reload
      this.sp.Game.forceThirdPerson();
      this.carriedControlsApplied = true;
      this.sp.Game.disablePlayerControls(true, true, true, false, true, false, true, false, 0);
      player.setDontMove(true);
      return;
    }

    this.restoreCarrierCollision();
    if (this.carriedControlsApplied) {
      this.carriedControlsApplied = false;
      this.sp.Game.enablePlayerControls(true, false, true, false, false, false, false, false, 0);
    }
    if (this.downed || this.executionPose || this.lock) {
      // Held in place: no walking, fighting, sneaking or activation; downed also loses menus and is kept in third person, a block pose starts in it and keeps the camera free like an action lock
      if (this.downed || this.executionPose) {
        this.sp.Game.forceThirdPerson();
      }
      if (!this.downed && this.downedControlsApplied) {
        this.sp.Game.enablePlayerControls(false, false, true, false, false, true, false, false, 0);
      }
      this.downedControlsApplied = this.downed;
      this.stillControlsApplied = true;
      this.sp.Game.disablePlayerControls(true, true, this.downed, false, true, this.downed, true, false, 0);
      player.setDontMove(true);
      return;
    }
    if (this.stillControlsApplied) {
      this.stillControlsApplied = false;
      this.downedControlsApplied = false;
      this.sp.Game.enablePlayerControls(true, false, true, false, false, true, false, false, 0);
    }
    if (this.boundHands) {
      // Can still walk / be marched, but can't fight, sneak or use hands.
      player.setDontMove(false);
      this.sp.Game.disablePlayerControls(false, true, false, false, true, false, true, false, 0);
    } else {
      player.setDontMove(false);
      // A carrier's fighting stays locked
      this.sp.Game.enablePlayerControls(true, !this.carrying, true, true, true, true, true, true, 0);
    }
  }

  // Overlays, state idles and the bleedout kneel live on separate graph layers: the old one is left first, alone, so the sync relays both
  private setPose(player: Actor, desired: string): void {
    const previous = this.appliedPose;
    const previousExit = this.appliedExit;
    const previousByLock = this.appliedByLock;
    const lockPose = !!this.lock && desired === this.lockPose;
    if (lockPose) this.logLockWaits(desired);
    this.appliedByLock = lockPose;
    this.lockExit = null;
    this.appliedPose = desired;
    this.appliedExit = lockPose && this.lock ? this.lock.attempts[this.lock.attempt].exit
      : desired === this.executionPose && this.executionExit ? this.executionExit : exitOf(desired);
    this.poseSentMs = Date.now();
    const token = ++this.poseToken;
    // A pose with its own exit (an action lock's exitAnim) leaves through it even on the same layer
    const crossesLayer = !!previous && previous !== OFFSET_STOP_ANIM &&
      (layerOf(previous) !== layerOf(desired) || (!!previousExit && previousExit !== exitOf(previous)));
    if (!crossesLayer) {
      this.sendPose(player, desired);
      return;
    }
    const exit = previousExit || exitOf(previous);
    this.sp.Debug.sendAnimationEvent(player, exit);
    if (desired === OFFSET_STOP_ANIM) {
      const now = Date.now();
      if (previousByLock) this.lockExit = { anim: previous, exit, sinceMs: now, lastSendMs: now, checkedMs: now, sends: 1, restTicks: 0, clearTicks: 0, otherEvent: "" };
      return;
    }
    this.sp.Utility.wait(POSE_SWAP_DELAY_S).then(() => {
      this.controller.once("update", () => {
        const p = this.sp.Game.getPlayer();
        if (p && token === this.poseToken) {
          this.sendPose(p, desired);
        }
      });
    });
  }

  // An action lock's attempt may go through the engine's idle path, and is checked shortly after it was sent
  private sendPose(player: Actor, anim: string): void {
    const lock = this.lock;
    if (!lock || anim !== this.lockPose) {
      this.sp.Debug.sendAnimationEvent(player, anim);
      return;
    }
    const attempt = lock.attempts[lock.attempt];
    lock.accepted = false;
    lock.idleResult = false;
    lock.playing = false;
    lock.quietTicks = 0;
    lock.sends++;
    lock.varBefore = player.getAnimationVariableBool(playingVarOf(anim));
    const idle = attempt.idleFormId ? this.sp.Idle.from(this.sp.Game.getFormEx(attempt.idleFormId)) : null;
    if (idle) lock.idleResult = player.playIdle(idle);
    else this.sp.Debug.sendAnimationEvent(player, anim);
    const token = ++this.lockPoseToken;
    this.sp.Utility.wait(LOCK_POSE_VERIFY_S).then(() => this.controller.once("update", () => this.verifyLockPose(token)));
  }

  // The graph's answer and the variable the pose sets decide whether the next attempt goes out
  private verifyLockPose(token: number): void {
    const lock = this.lock;
    const player = this.sp.Game.getPlayer();
    if (!player || !lock || token !== this.lockPoseToken || this.appliedPose !== this.lockPose) return;
    const playingVar = playingVarOf(this.lockPose);
    const varValue = player.getAnimationVariableBool(playingVar);
    // Some poses report a refusal while they play, so a variable that only now turned true is proof enough
    const proven = !lock.varBefore || lock.accepted || lock.idleResult;
    // The graph refuses an idle to itself, so a player already in it (the emote kneel) holds the pose
    const alreadyIn = !proven && this.lastStateIdle === this.lockPose.toLowerCase() && player.getSitState() === 0;
    lock.playing = varValue && (proven || alreadyIn);
    if (lock.playing && !lock.playedAtMs) {
      lock.playedAs = `${describeAttempt(lock)}${alreadyIn ? " (already in the pose)" : ""}`;
      lock.playedAtMs = Date.now();
    }
    const viaIdle = !!lock.attempts[lock.attempt].idleFormId;
    // An idle played through Actor.playIdle never reaches the send hook, so the animation sync is told here
    const relayed = lock.playing && viaIdle;
    if (relayed) this.controller.lookupListener(SendInputsService).relayPlayerAnimEvent(this.lockPose);
    const hasNext = lock.attempt + 1 < lock.attempts.length;
    const idle = viaIdle ? `, playIdle returned ${lock.idleResult}` : "";
    const next = lock.playing ? `playing${alreadyIn ? ", already in the pose before the send" : ""}${relayed ? ", relayed to other players" : ""}`
      : hasNext ? `trying ${lock.attempts[lock.attempt + 1].anim} next` : "no fallback left";
    logToPlatformLog(this, `action lock pose ${describeAttempt(lock)}: graph accepted ${lock.accepted}${idle}, ${playingVar} ${lock.varBefore} before and ${varValue} ${LOCK_POSE_VERIFY_S} s later, ${next}; ${this.describePlayer(player)}`);
    if (lock.playing || !hasNext) return;
    const previous = this.lockPose;
    lock.attempt++;
    // A different pose leaves the refused one through its exit first; the same pose is simply sent again
    if (this.lockPose === previous) this.appliedPose = "";
    this.applyStateNow();
  }

  // A pose seen playing that stops before the lock ends is logged with the event the graph took last, and sent again
  private watchLockPose(player: Actor, now: number): void {
    const lock = this.lock;
    if (!lock || !lock.playing || this.appliedPose !== this.lockPose) return;
    const playingVar = playingVarOf(this.lockPose);
    if (player.getAnimationVariableBool(playingVar)) {
      lock.quietTicks = 0;
      return;
    }
    if (++lock.quietTicks < 2) return;
    lock.playing = false;
    const again = lock.restarts < LOCK_POSE_MAX_RESTARTS;
    logToPlatformLog(this, `action lock pose ${describeAttempt(lock)} stopped playing ${now - lock.since} ms into the lock (${playingVar} false), ` +
      `last event the graph took: ${lock.lastEvent || "none"}, ${again ? "sending it again" : "not sent again"}; ${this.describePlayer(player)}`);
    if (!again) return;
    lock.restarts++;
    this.appliedPose = "";
    this.applyStateNow();
  }

  // An exit the graph swallowed would leave the player in the lock's pose for good, so it is sent again while the pose holds
  private watchLockExit(): void {
    const x = this.lockExit;
    const now = Date.now();
    if (!x || now - x.checkedMs < TICK_MS) return;
    x.checkedMs = now;
    const player = this.sp.Game.getPlayer();
    const bleedout = x.anim === BLEEDOUT_ANIM_START;
    // Another pose, a death, or for the kneel any other event the graph took owns the animation now
    if (!player || player.isDead() || this.isPoseLocked || this.appliedPose !== OFFSET_STOP_ANIM || (!bleedout && x.otherEvent)) {
      this.endLockExit("");
      return;
    }
    const playingVar = playingVarOf(x.anim);
    if (!player.getAnimationVariableBool(playingVar)) {
      if (++x.clearTicks < 2) return;
      this.endLockExit(bleedout || x.sends > 1 ? `${x.anim} left ${now - x.sinceMs} ms after the lock, ${x.sends} exit(s) sent` : "");
      return;
    }
    x.clearTicks = 0;
    // The bleedout's fall to the knees and its get-up are animation-driven clips, the kneel between them is not
    const resting = !bleedout || !player.getAnimationVariableBool(ANIM_DRIVEN_VAR);
    x.restTicks = resting ? x.restTicks + 1 : 0;
    if (x.restTicks < LOCK_EXIT_REST_TICKS || now - x.lastSendMs < LOCK_EXIT_RESEND_MS) return;
    const state = `${x.anim} still held ${now - x.sinceMs} ms after the lock (${playingVar} true) after ${x.sends} exit(s)`;
    if (x.sends < LOCK_EXIT_MAX_SENDS) {
      x.sends++;
      x.lastSendMs = now;
      x.restTicks = 0;
      this.sp.Debug.sendAnimationEvent(player, x.exit);
      logToPlatformLog(this, `action lock exit: ${state}, ${x.exit} sent again; ${this.describePlayer(player)}`);
    } else if (!bleedout) {
      this.endLockExit(`${state}, not sent again`);
    } else if (now - x.lastSendMs >= LOCK_EXIT_KNOCKDOWN_MS) {
      // The knock-down's get-up returns the root graph to its default state
      player.pushActorAway(player, 0);
      this.endLockExit(`${state}, the player is knocked down so the get-up ends the kneel`);
    }
  }

  private endLockExit(line: string): void {
    this.lockExit = null;
    if (line) logToPlatformLog(this, `action lock exit: ${line}`);
    this.restoreLockCamera();
  }

  // One line per lock, so a test says which attempt played and for how long
  private logLockSummary(lock: ActionLock, now: number): void {
    const played = lock.playedAtMs ? `${lock.playedAs} played from ${lock.playedAtMs - lock.since} ms` : `no attempt seen playing (${lock.sends} sent)`;
    logToPlatformLog(this, `action lock summary: ${lock.attempts[0].anim} held ${now - lock.since} ms, ${played}, ${lock.restarts} restart(s)`);
  }

  private describePlayer(player: Actor): string {
    return `weapon drawn ${player.isWeaponDrawn()}, sneaking ${player.isSneaking()}, camera ${this.sp.Game.getCameraState()}, sit state ${player.getSitState()}, ` +
      `left hand ${player.getEquippedItemType(0)}, in jump ${player.getAnimationVariableBool("bInJumpState")}`;
  }

  // Names what the pose waited for before it was sent
  private logLockWaits(anim: string): void {
    if (!this.lock || !this.lockWaits.size) return;
    logToPlatformLog(this, `action lock pose ${anim} sent ${Date.now() - this.lock.since} ms after the lock, waited for ${Array.from(this.lockWaits).join(", ")}`);
    this.lockWaits.clear();
  }

  // A sneaking or drawn graph refuses an idle and a first-person camera shows none, so those go first and the pose waits out the sheathe's blend
  private lockPoseReady(player: Actor, lock: ActionLock): boolean {
    const now = Date.now();
    const waits: string[] = [];
    // The lock's disabled sneak controls stand the player up
    if (player.isSneaking()) waits.push("the stand-up");
    if (this.sp.Game.getCameraState() === FIRST_PERSON_CAMERA) {
      this.sp.Game.forceThirdPerson();
      this.lockCameraRestore = true;
      waits.push("third person");
    }
    if (needsEmptyHands(lock.attempts[lock.attempt].anim) && player.isWeaponDrawn()) {
      player.sheatheWeapon();
      waits.push("the sheathe");
    }
    waits.forEach((w) => this.lockWaits.add(w));
    if (waits.length) this.lockBlockedMs = -1;
    else if (this.lockBlockedMs < 0) this.lockBlockedMs = now;
    if (now - lock.since >= LOCK_PREP_MAX_MS) {
      if (waits.length) this.lockWaits.add("the time limit");
      return true;
    }
    return !waits.length && now - this.lockBlockedMs >= SHEATHE_SETTLE_MS;
  }

  // Once no pose holds the player and the graph has left the lock's pose, the first-person camera a lock turned away from comes back
  private restoreLockCamera(): void {
    if (this.downed || this.carried) this.lockCameraRestore = false;
    if (!this.lockCameraRestore || this.isPoseLocked || this.lockExit || this.cameraRestoreQueued) return;
    this.cameraRestoreQueued = true;
    this.sp.Utility.wait(LOCK_CAMERA_RESTORE_S).then(() => {
      this.controller.once("update", () => {
        this.cameraRestoreQueued = false;
        const player = this.sp.Game.getPlayer();
        if (!player || !this.lockCameraRestore || this.isPoseLocked || this.lockExit) return;
        this.lockCameraRestore = false;
        if (!player.isDead() && player.getSitState() === 0 && !player.isOnMount()) this.sp.Game.forceFirstPerson();
      });
    });
  }

  // The carrier's carry-hold pose plus over-encumbrance; deferred like applyState.
  private applyCarryAnim(): void {
    this.controller.once("update", () => this.applyCarryAnimNow());
  }

  private applyCarryAnimNow(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    this.holdCarrierFightLock(player, Date.now());
    const desired = this.carrying ? this.carrierAnim : OFFSET_STOP_ANIM;
    // A drawn weapon is sheathed first; the tick sends the pose once the sheathe has settled
    if (desired !== this.appliedCarrierAnim && !(this.carrying && player.isWeaponDrawn())) {
      // A bound, carried or downed pose applied meanwhile owns the player's animation, so ending the carry must not stop it
      if (this.carrying || !(this.boundHands || this.carried || this.downed)) this.sp.Debug.sendAnimationEvent(player, desired);
      this.appliedCarrierAnim = desired;
    }
    // Carrying a body over-encumbers: blocks sprint/jump and forces walk.
    // Delta-based so fortify effects survive; guarded so re-sends can't stack.
    if (this.carrying && !this.encumbranceApplied) {
      player.modActorValue("CarryWeight", -CARRY_OVERLOAD);
      this.encumbranceApplied = true;
    } else if (!this.carrying && this.encumbranceApplied) {
      player.modActorValue("CarryWeight", CARRY_OVERLOAD);
      this.encumbranceApplied = false;
    }
    this.poseCarriedNpc();
  }

  // The carried NPC's clone sits still in the carrier's arms while the server moves it; re-posed when its local copy changes
  private poseCarriedNpc(): void {
    const localId = this.carriedNpcId ? remoteIdToLocalId(this.carriedNpcId) : 0;
    if (localId === this.posedNpcLocalId) {
      return;
    }
    releaseHold(this.npcHoldState);
    if (this.posedNpcLocalId) {
      const previous = this.sp.Actor.from(this.sp.Game.getFormEx(this.posedNpcLocalId));
      if (previous) {
        previous.setDontMove(false);
        this.sp.Debug.sendAnimationEvent(previous, IDLE_EXIT_ANIM);
      }
      this.restoreCarrierCollision();
      this.posedNpcLocalId = 0;
    }
    const npc = localId ? this.sp.Actor.from(this.sp.Game.getFormEx(localId)) : null;
    if (!npc || !npc.is3DLoaded()) {
      return;
    }
    npc.setDontMove(true);
    this.sp.Debug.sendAnimationEvent(npc, this.carriedAnim);
    this.posedNpcLocalId = localId;
    this.npcHoldState = makeHoldState();
  }

  // Hits on a downed player are the server's to judge, so local NPC swings and clone hits pass through; an admin's own ghost mode is left alone
  private applyDownedGhost(player: Actor): void {
    if (this.downed && !this.ghostApplied && !player.isGhost()) {
      player.setGhost(true);
      this.ghostApplied = true;
    } else if (!this.downed && this.ghostApplied) {
      player.setGhost(false);
      this.ghostApplied = false;
    }
  }

  // A carrier cannot raise a weapon, fists or a spell; re-asserted every tick because other services re-enable controls
  private holdCarrierFightLock(player: Actor, now: number): void {
    if (!this.carrying) {
      if (this.fightLockApplied) {
        this.fightLockApplied = false;
        // Bound, carried and downed keep their own fighting lock
        if (!this.boundHands && !this.carried && !this.downed) {
          this.sp.Game.enablePlayerControls(false, true, false, false, false, false, false, false, 0);
        }
      }
      return;
    }
    this.fightLockApplied = true;
    if (this.sp.Game.isFightingControlsEnabled()) {
      this.sp.Game.disablePlayerControls(false, true, false, false, false, false, false, false, 0);
    }
    if (player.isWeaponDrawn()) {
      if (now >= this.nextSheatheMs) {
        player.sheatheWeapon();
        this.nextSheatheMs = now + SHEATHE_RETRY_MS;
      }
      this.poseDirty = true;
      this.nextPoseReapplyMs = now + SHEATHE_SETTLE_MS;
    }
  }

  private boundHands = false;
  private carried = false;
  private carrierId = 0;
  private captiveAnim = BOUND_HANDS_ANIM_START;
  private carriedAnim = CARRIED_ANIM_START;
  private carryPose: CarryPose = { ...DEFAULT_CARRY_POSE };
  private holdState = makeHoldState();
  private npcHoldState = makeHoldState();
  private holdPausedUntil = 0;
  private carryStats: CarryStats | null = null;
  private idleResends = 0;
  private idleCheckOff = false;
  private appliedPose = "";
  private appliedExit = "";
  private poseSentMs = 0;
  private poseToken = 0;
  private carriedControlsApplied = false;
  private downed = false;
  private executionPose = "";
  private executionExit = "";
  private pairedUntil = 0;
  private lock: ActionLock | null = null;
  // Whether the pose last sent was an action lock's, and that pose's exit while the graph may still hold it
  private appliedByLock = false;
  private lockExit: LockExit | null = null;
  // Tells a stale attempt check from the current one
  private lockPoseToken = 0;
  // Lowercase name of the last state idle the player's graph took (an emote kneel among them)
  private lastStateIdle = "";
  // When the lock's pose first found nothing to wait for (-1 while it waits), and what it waited for since it was last sent
  private lockBlockedMs = 0;
  private lockWaits = new Set<string>();
  // Set when a lock turned a first-person camera to third person
  private lockCameraRestore = false;
  private cameraRestoreQueued = false;
  private stillControlsApplied = false;
  // The bleedout's camera and menu lock, which a disable call with false never lifts
  private downedControlsApplied = false;
  private ghostApplied = false;
  private collisionOffId = 0;
  private nextCollisionRefreshMs = 0;

  private carrying = false;
  private carrierAnim = CARRY_HOLD_ANIM_START;
  private appliedCarrierAnim = "";
  private carriedNpcId = 0;
  private posedNpcLocalId = 0;
  private encumbranceApplied = false;
  private fightLockApplied = false;
  private nextSheatheMs = 0;

  private lastTickMs = 0;
  private wasInJump = false;
  private poseDirty = false;
  private nextPoseReapplyMs = 0;
}
