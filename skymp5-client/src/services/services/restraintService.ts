import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { Movement, NiPoint3 } from "../../sync/movement";
import { setRefrCollision } from "../../sync/animation";

// Vanilla behaviour-graph "offset" overlay events (no ESP required), cleared with OffsetStop.
// All three are whitelisted in sync/animation.ts (forcedSyncAnims) so the poses sync to other players.
// Server-overridden pose names (settings.captiveAnimEvent / carrierAnimEvent) must also be whitelisted.
const BOUND_HANDS_ANIM_START = "OffsetBoundStandingStart";
const CARRY_HOLD_ANIM_START = "OffsetCarryBasketStart";
const OFFSET_STOP_ANIM = "OffsetStop";
// Vanilla chair sit idle; it plays without furniture, as on remote copies of seated players
const CARRIED_ANIM_START = "IdleChairEnterInstant";
const IDLE_EXIT_ANIM = "IdleForceDefaultState";
const CARRY_OVERLOAD = 10000;

// Lowercase: BSFixedString pools are case-insensitive, so the engine's spelling can vary
const JUMP_START_EVENTS = new Set(["jumpstandingstart", "jumpdirectionalstart"]);

const TICK_MS = 100;
const POSE_REAPPLY_MIN_MS = 500;
// Lets the single-slot animation sync relay a layer exit before the next pose
const POSE_SWAP_DELAY_S = 0.1;

// Carried body is held ahead of and above the carrier, turned across their arms; the server may override these
const CARRY_FORWARD = 30;
const CARRY_UP = 40;
const CARRY_YAW = 90;

// Carried body chases the carrier's clone locally; the server's drift snap is only a backstop
const CARRY_FOLLOW_TIME_S = 0.2;
const CARRY_FOLLOW_DEADZONE = 4;
const CARRY_FOLLOW_YAW_DEADZONE = 3;
const CARRY_FOLLOW_MIN_SPEED = 50;
const CARRY_FOLLOW_MAX_DIST = 2048;
const CARRIER_COLLISION_REFRESH_MS = 1000;

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isStateIdle = (anim: string): boolean => anim.toLowerCase().startsWith("idle");

/**
 * Applies the local player's restraint state (bound hands, being carried, and
 * the captor's carry-hold pose) to controls and animation.
 * Server-authoritative: the gamemode's CaptureSystem owns who may bind/carry
 * whom, consent, bleedout timers and respawn; this service only reflects the
 * resulting state on the local client.
 *
 * Protocol: Server -> Client, {@link MsgType.CustomPacket} with a JSON dump.
 * Fields are optional; only the ones present are changed:
 *
 *   // The restrained player (captive); carrier is the carrier's server actor id, 0 when not carried:
 *   { "customPacketType": "restraintState", "boundHands": true }
 *   { "customPacketType": "restraintState", "carried": true, "carrier": 4278190090, "anim": "OffsetBoundStandingStart",
 *     "carriedAnim": "IdleChairEnterInstant", "carryForward": 30, "carryUp": 40, "carryYaw": 90 }
 *   { "customPacketType": "restraintState", "boundHands": false, "carried": false, "carrier": 0 }
 *
 *   // The carrier (pose only, no control change):
 *   { "customPacketType": "carryState", "carrying": true, "anim": "OffsetCarryBasketStart" }
 *   { "customPacketType": "carryState", "carrying": false }
 *
 * Effects on the local player:
 *   - boundHands: plays the bound-hands pose and disables fighting/sneaking/
 *     activation. Movement stays enabled so the prisoner can be marched/walked.
 *   - carried: plays a sitting pose held carryForward ahead of and carryUp above
 *     the carrier's clone, turned carryYaw degrees from the carrier's facing.
 *     Fully immobilised in third person; the camera can still orbit. The
 *     carrier's clone stops colliding with the player meanwhile.
 *   - carrying: plays the carry-hold pose; controls are untouched so the carrier
 *     can walk the captive around.
 *   - any of the above: jumping is blocked and the pose is re-applied after a fall.
 *
 * "Carry stops the respawn process" is enforced server-side (CaptureSystem stops
 * a downed target's bleedout when it captures/carries them).
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
      leave: () => { },
    }, 0x14, 0x14);

    // A game reload wipes the pose; restore it
    this.controller.emitter.on("gameLoad", () => {
      if (this.isPoseLocked) {
        this.controller.once("update", () => this.reapplyPoses());
      }
    });
  }

  // True while a restraint or carry pose owns the player's animation.
  get isPoseLocked(): boolean {
    return this.boundHands || this.carried || this.carrying;
  }

  get isCarried(): boolean {
    return this.carried;
  }

  // Observers must see a held pose: no locomotion, and the server keeps the last animation only for Standing
  filterOwnMovement(movement: Movement): Movement {
    if (this.carried) {
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
      this.carryForward = finiteOr(content["carryForward"], this.carryForward);
      this.carryUp = finiteOr(content["carryUp"], this.carryUp);
      this.carryYaw = finiteOr(content["carryYaw"], this.carryYaw);
      logTrace(this, `restraintState boundHands=${this.boundHands} carried=${this.carried} carrier=${this.carrierId.toString(16)}`);
      this.applyState();
    } else if (type === "carryState") {
      if (typeof content["carrying"] === "boolean") {
        this.carrying = content["carrying"];
      }
      if (typeof content["anim"] === "string" && content["anim"]) {
        this.carrierAnim = content["anim"] as string;
      }
      logTrace(this, `carryState carrying=${this.carrying}`);
      this.applyCarryAnim();
    }
  }

  // Throttled: landing detection (event-name independent) and the carried follow
  private onUpdate(): void {
    if (!this.isPoseLocked) {
      this.wasInJump = false;
      this.poseDirty = false;
      return;
    }
    const now = Date.now();
    if (now - this.lastTickMs < TICK_MS) {
      return;
    }
    this.lastTickMs = now;

    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }

    const inJump = player.getAnimationVariableBool("bInJumpState");
    if (this.wasInJump && !inJump) {
      this.poseDirty = true;
    }
    this.wasInJump = inJump;
    if (this.poseDirty && !inJump && now >= this.nextPoseReapplyMs) {
      this.poseDirty = false;
      this.nextPoseReapplyMs = now + POSE_REAPPLY_MIN_MS;
      this.reapplyPoses();
    }

    if (this.carried && this.carrierId) {
      this.followCarrier(player);
    }
  }

  private followCarrier(player: Actor): void {
    const carrierLocalId = remoteIdToLocalId(this.carrierId);
    const carrier = this.sp.ObjectReference.from(this.sp.Game.getFormEx(carrierLocalId));
    if (!carrier || !carrier.is3DLoaded() ||
      ObjectReferenceEx.getWorldOrCell(carrier) !== ObjectReferenceEx.getWorldOrCell(player)) {
      return;
    }
    this.keepCarrierCollisionOff(carrierLocalId);

    const carrierYaw = carrier.getAngleZ();
    const yawRad = carrierYaw * Math.PI / 180;
    const carrierPos = ObjectReferenceEx.getPos(carrier);
    const target: NiPoint3 = [
      carrierPos[0] + Math.sin(yawRad) * this.carryForward,
      carrierPos[1] + Math.cos(yawRad) * this.carryForward,
      carrierPos[2] + this.carryUp,
    ];
    const targetYaw = carrierYaw + this.carryYaw;
    const yawDiff = Math.abs(((targetYaw - player.getAngleZ()) % 360 + 540) % 360 - 180);
    const dist = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(player), target);
    if (dist > CARRY_FOLLOW_MAX_DIST || (dist < CARRY_FOLLOW_DEADZONE && yawDiff < CARRY_FOLLOW_YAW_DEADZONE)) {
      return;
    }
    player.translateTo(
      target[0], target[1], target[2],
      player.getAngleX(), player.getAngleY(), targetYaw,
      Math.max(dist / CARRY_FOLLOW_TIME_S, CARRY_FOLLOW_MIN_SPEED), 0,
    );
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
    if (!id || !this.sp.Game.getFormEx(id)) {
      return;
    }
    try {
      setRefrCollision(id, true);
    } catch (e) {
      // clone went away
    }
  }

  // Must run on update; forces every held pose to be sent again
  private reapplyPoses(): void {
    if (this.boundHands || this.carried) {
      this.appliedPose = "";
      this.applyStateNow();
    }
    if (this.carrying) {
      this.appliedCarrierAnim = "";
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

    // Carried shows the sitting pose, bound the captive pose, otherwise clear it; only fire on transition.
    const desiredPose = this.carried ? this.carriedAnim : this.boundHands ? this.captiveAnim : OFFSET_STOP_ANIM;
    if (desiredPose !== this.appliedPose) {
      this.setPose(player, desiredPose);
    }

    // Recompute the control lock each time. Argument order:
    // (movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType).
    if (this.carried) {
      // First person would sit inside the pose and fight the forced heading, so third person is locked
      if (!this.carriedControlsApplied) {
        this.sp.Game.forceThirdPerson();
        this.carriedControlsApplied = true;
      }
      this.sp.Game.disablePlayerControls(true, true, true, false, true, false, true, false, 0);
      player.setDontMove(true);
      return;
    }

    this.restoreCarrierCollision();
    if (this.carriedControlsApplied) {
      this.carriedControlsApplied = false;
      this.sp.Game.enablePlayerControls(true, false, true, false, false, false, false, false, 0);
    }
    if (this.boundHands) {
      // Can still walk / be marched, but can't fight, sneak or use hands.
      player.setDontMove(false);
      this.sp.Game.disablePlayerControls(false, true, false, false, true, false, true, false, 0);
    } else {
      player.setDontMove(false);
      this.sp.Game.enablePlayerControls(true, true, true, true, true, true, true, true, 0);
    }
  }

  // Overlays and state idles live on separate graph layers: the old one is left first, alone, so the sync relays both
  private setPose(player: Actor, desired: string): void {
    const previous = this.appliedPose;
    this.appliedPose = desired;
    const token = ++this.poseToken;
    const crossesLayer = !!previous && previous !== OFFSET_STOP_ANIM && isStateIdle(previous) !== isStateIdle(desired);
    if (!crossesLayer) {
      this.sp.Debug.sendAnimationEvent(player, desired);
      return;
    }
    this.sp.Debug.sendAnimationEvent(player, isStateIdle(previous) ? IDLE_EXIT_ANIM : OFFSET_STOP_ANIM);
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

  // The carrier's carry-hold pose plus over-encumbrance; deferred like applyState.
  private applyCarryAnim(): void {
    this.controller.once("update", () => this.applyCarryAnimNow());
  }

  private applyCarryAnimNow(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    const desired = this.carrying ? this.carrierAnim : OFFSET_STOP_ANIM;
    if (desired !== this.appliedCarrierAnim) {
      this.sp.Debug.sendAnimationEvent(player, desired);
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
  }

  private boundHands = false;
  private carried = false;
  private carrierId = 0;
  private captiveAnim = BOUND_HANDS_ANIM_START;
  private carriedAnim = CARRIED_ANIM_START;
  private carryForward = CARRY_FORWARD;
  private carryUp = CARRY_UP;
  private carryYaw = CARRY_YAW;
  private appliedPose = "";
  private poseToken = 0;
  private carriedControlsApplied = false;
  private collisionOffId = 0;
  private nextCollisionRefreshMs = 0;

  private carrying = false;
  private carrierAnim = CARRY_HOLD_ANIM_START;
  private appliedCarrierAnim = "";
  private encumbranceApplied = false;

  private lastTickMs = 0;
  private wasInJump = false;
  private poseDirty = false;
  private nextPoseReapplyMs = 0;
}
