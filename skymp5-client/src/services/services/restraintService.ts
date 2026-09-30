import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logToPlatformLog, logTrace } from "../../logging";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { Movement } from "../../sync/movement";
import { setCarrierClone } from "../../sync/movementApply";
import { isInSitPose, needsEmptyHands, setRefrCollision } from "../../sync/animation";
import { CarryPose, DEFAULT_CARRY_POSE, describeCarryNodes, finiteOr, holdOnCarrier, makeHoldState, readCarryPose, restartHold } from "../../sync/carryHold";
import { isPlayerCharacterId } from "./playerActionService";
import { MountService } from "./mountService";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";

// Vanilla behaviour-graph "offset" overlay events (no ESP required), cleared with OffsetStop.
// All three are whitelisted in sync/animation.ts (forcedSyncAnims) so the poses sync to other players.
// Server-overridden pose names (settings.captiveAnimEvent / carrierAnimEvent) must also be whitelisted.
const BOUND_HANDS_ANIM_START = "OffsetBoundStandingStart";
const CARRY_HOLD_ANIM_START = "OffsetCarryBasketStart";
const OFFSET_STOP_ANIM = "OffsetStop";
// Vanilla lying idle (the emote wheel's Lay Down); actors cannot pitch, so the lying look comes from the idle
const CARRIED_ANIM_START = "IdleLayDown";
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
// An action lock's pose should be playing this long after it was sent; one that is not is logged at most once a minute
const LOCK_POSE_CHECK_S = 1.5;
const LOCK_POSE_LOG_MS = 60000;
// Master graph variable set while an idle plays
const IDLE_PLAYING_VAR = "bIdlePlaying";

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
  poseResends: number;
  serverMoves: number;
  shortHops: number;
  nodesLogged: boolean;
}

interface ActionLock {
  anim: string;
  exitAnim: string;
  until: number;
}

const isStateIdle = (anim: string): boolean => anim.toLowerCase().startsWith("idle");

// Poses on different graph layers are left one at a time, each with its own exit
const layerOf = (anim: string): string => anim === BLEEDOUT_ANIM_START ? "bleedout" : isStateIdle(anim) ? "idle" : "offset";

const exitOf = (anim: string): string => anim === BLEEDOUT_ANIM_START ? BLEEDOUT_ANIM_STOP : isStateIdle(anim) ? IDLE_EXIT_ANIM : OFFSET_STOP_ANIM;

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
 *     "carriedAnim": "IdleLayDown", "carryForward": 16, "carryUp": 40, "carryYaw": 45 }
 *   { "customPacketType": "restraintState", "boundHands": false, "carried": false, "carrier": 0 }
 *
 *   // The carrier (pose only, no control change); target is the carried actor's server id, an NPC's clone is posed here, 0 for a passive job load:
 *   { "customPacketType": "carryState", "carrying": true, "anim": "OffsetCarryBasketStart", "target": 4278190090,
 *     "carryForward": 16, "carryUp": 40, "carryYaw": 45 }
 *   { "customPacketType": "carryState", "carrying": false }
 *
 *   // A player at 0 health (BleedoutSystem); died skips the stand-up:
 *   { "customPacketType": "bleedoutState", "downed": true, "seconds": 15 }
 *   { "customPacketType": "bleedoutState", "downed": false, "died": false }
 *
 *   // A prisoner at an execution block (ExecutionSystem); "" leaves the block:
 *   { "customPacketType": "executionState", "pose": "bleedOutStart" }
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
 *   - carried: plays a lying pose held carryForward ahead of and carryUp above
 *     the carrier's clone every frame (sync/carryHold.ts), turned carryYaw
 *     degrees from the carrier's facing and turning with it. Fully immobilised
 *     in third person; the camera can still orbit. The carrier's clone stops
 *     colliding with the player meanwhile. The carrier and observers hold their
 *     copy of the body on their own copy of the carrier (ff_carriedBy). One
 *     summary line per carry goes to the Platform log.
 *   - carrying: plays the carry-hold pose; fighting is disabled and a drawn
 *     weapon, fists or spell is sheathed. The carrier can still walk.
 *   - downed: kneels in the bleedout pose, cannot move, fight, sneak, activate
 *     or open menus, and is a ghost locally so no local hit lands; held in
 *     third person for the whole bleedout, the camera can still orbit.
 *     Carried wins over downed, downed over bound.
 *   - executionState: kneels at the block in the given pose, held in place like
 *     a downed player but with menus and a free camera; wins over bound, the
 *     cuffs stay on.
 *   - standForPair (PairedIdleService, a finish off with standUp): the kneel is
 *     left for the length of the pair while the controls stay locked; a victim
 *     who survives it kneels again shortly after pairEnded, or when it lapses.
 *   - actionLock: plays anim (hands emptied first when its copies would sheathe)
 *     and holds the player still without fighting, sneaking or activation for
 *     the seconds, then plays exitAnim. Going down or dying ends it early,
 *     every other pose wins over it, and a mounted or swimming player or one
 *     another pose already holds ignores it. A pose with no idle playing
 *     1.5 s after it was sent is logged (once a minute) to the Platform log.
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
        if (this.lock && ctx.animEventName === this.lock.anim) this.lockPoseAccepted = ctx.animationSucceeded;
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
      this.readCarryOffsets(content);
      // A carried player poses itself through restraintState; only an NPC's clone is posed by the carrier
      const target = typeof content["target"] === "number" ? content["target"] as number : 0;
      this.carriedNpcId = this.carrying && target >= FIRST_DYNAMIC_REMOTE_ID && !isPlayerCharacterId(this.controller, target) ? target : 0;
      logTrace(this, `carryState carrying=${this.carrying} npc=${this.carriedNpcId.toString(16)}`);
      this.applyCarryAnim();
    } else if (type === "executionState" && typeof content["pose"] === "string") {
      this.executionPose = content["pose"];
      logTrace(this, `executionState pose=${this.executionPose}`);
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
    this.lock = seconds > 0 ? { anim, exitAnim, until: Date.now() + seconds * 1000 } : null;
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
    if ([BLEEDOUT_ANIM_START, this.lock?.anim, this.executionPose].includes(this.appliedPose)) this.appliedPose = OFFSET_STOP_ANIM;
    this.downed = false;
    this.lock = null;
    this.executionPose = "";
    this.pairedUntil = 0;
    this.applyState();
  }

  // The carry holds run every frame; landing detection (event-name independent), locks and pose checks are throttled
  private onUpdate(): void {
    this.trackCarry();
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
      this.lock = null;
      this.applyStateNow();
    }
    // The pair lapsed without a death: a downed victim kneels again
    if (this.pairedUntil && now >= this.pairedUntil) {
      this.pairedUntil = 0;
      this.applyStateNow();
    }

    const inJump = player.getAnimationVariableBool("bInJumpState");
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
      this.carryStats = { startMs: Date.now(), frames: 0, poseResends: 0, serverMoves: 0, shortHops: 0, nodesLogged: false };
      this.holdState = makeHoldState();
      this.idleResends = 0;
      this.idleCheckOff = false;
    } else if (!this.carried && this.carryStats) {
      const c = this.carryStats;
      const s = this.holdState;
      const seconds = (Date.now() - c.startMs) / 1000;
      logToPlatformLog(this, `carry summary: ${seconds.toFixed(1)} s held, ${Math.round(c.frames / Math.max(seconds, 0.001))} fps average while carried, ` +
        `${s.translates} translates, ${s.headingWrites} heading writes, largest heading error ${s.maxHeadingError.toFixed(1)}, ` +
        `${c.poseResends} pose re-sends, ${c.serverMoves} server moves (${c.shortHops} short hops), largest gap ${Math.round(s.maxGap)} units`);
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
      : this.boundHands ? this.captiveAnim : this.lock ? this.lock.anim : OFFSET_STOP_ANIM;
    if (desiredPose === this.lock?.anim && needsEmptyHands(desiredPose) && player.isWeaponDrawn()) {
      // The tick poses once the sheathe has settled
      player.sheatheWeapon();
      this.poseDirty = true;
      this.nextPoseReapplyMs = Date.now() + SHEATHE_SETTLE_MS;
    } else if (desiredPose !== this.appliedPose) {
      this.setPose(player, desiredPose);
    }
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
      // Held in place: no walking, fighting, sneaking or activation; downed also loses menus and is kept in third person, the block kneel and action locks keep the camera free
      if (this.downed) {
        this.sp.Game.forceThirdPerson();
      } else if (this.downedControlsApplied) {
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
    if (desired === this.lock?.anim) this.checkLockPose(desired);
    this.appliedPose = desired;
    this.appliedExit = desired === this.lock?.anim ? this.lock.exitAnim : exitOf(desired);
    this.poseSentMs = Date.now();
    const token = ++this.poseToken;
    // A pose with its own exit (an action lock's exitAnim) leaves through it even on the same layer
    const crossesLayer = !!previous && previous !== OFFSET_STOP_ANIM &&
      (layerOf(previous) !== layerOf(desired) || (!!previousExit && previousExit !== exitOf(previous)));
    if (!crossesLayer) {
      this.sp.Debug.sendAnimationEvent(player, desired);
      return;
    }
    this.sp.Debug.sendAnimationEvent(player, previousExit || exitOf(previous));
    if (desired === OFFSET_STOP_ANIM) {
      return;
    }
    this.sp.Utility.wait(POSE_SWAP_DELAY_S).then(() => {
      this.controller.once("update", () => {
        const p = this.sp.Game.getPlayer();
        if (p && token === this.poseToken) {
          this.sp.Debug.sendAnimationEvent(p, desired);
        }
      });
    });
  }

  // Diagnostic for a work pose that shows nothing: whether the graph took the event and an idle still plays
  private checkLockPose(anim: string): void {
    this.lockPoseAccepted = false;
    this.sp.Utility.wait(LOCK_POSE_CHECK_S).then(() => {
      this.controller.once("update", () => {
        const player = this.sp.Game.getPlayer();
        const now = Date.now();
        if (!player || this.lock?.anim !== anim || now - this.lastLockPoseLogMs < LOCK_POSE_LOG_MS) return;
        if (player.getAnimationVariableBool(IDLE_PLAYING_VAR)) return;
        this.lastLockPoseLogMs = now;
        logToPlatformLog(this, `action lock pose ${anim}: graph accepted ${this.lockPoseAccepted}, no idle playing ${LOCK_POSE_CHECK_S} s later, weapon drawn ${player.isWeaponDrawn()}`);
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
  private pairedUntil = 0;
  private lock: ActionLock | null = null;
  private lockPoseAccepted = false;
  private lastLockPoseLogMs = 0;
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
