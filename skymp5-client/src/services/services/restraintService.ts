import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { remoteIdToLocalId } from "../../view/worldViewMisc";

// Vanilla behaviour-graph "offset" overlay events (no ESP required), cleared with OffsetStop.
// All three are whitelisted in sync/animation.ts (forcedSyncAnims) so the poses sync to other players.
// Server-overridden pose names (settings.captiveAnimEvent / carrierAnimEvent) must also be whitelisted.
const BOUND_HANDS_ANIM_START = "OffsetBoundStandingStart";
const CARRY_HOLD_ANIM_START = "OffsetCarryBasketStart";
const OFFSET_STOP_ANIM = "OffsetStop";
const CARRY_OVERLOAD = 10000;

// Lowercase: BSFixedString pools are case-insensitive, so the engine's spelling can vary
const JUMP_START_EVENTS = new Set(["jumpstandingstart", "jumpdirectionalstart"]);

const TICK_MS = 100;
const POSE_REAPPLY_MIN_MS = 500;

// Carried body chases the carrier's clone locally; the server's drift snap is only a backstop
const CARRY_FOLLOW_TIME_S = 0.2;
const CARRY_FOLLOW_DEADZONE = 16;
const CARRY_FOLLOW_MAX_DIST = 2048;

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
 *   { "customPacketType": "restraintState", "carried": true, "carrier": 4278190090, "anim": "OffsetBoundStandingStart" }
 *   { "customPacketType": "restraintState", "boundHands": false, "carried": false, "carrier": 0 }
 *
 *   // The carrier (pose only, no control change):
 *   { "customPacketType": "carryState", "carrying": true, "anim": "OffsetCarryBasketStart" }
 *   { "customPacketType": "carryState", "carrying": false }
 *
 * Effects on the local player:
 *   - boundHands: plays the bound-hands pose and disables fighting/sneaking/
 *     activation. Movement stays enabled so the prisoner can be marched/walked.
 *   - carried: fully immobilises the player and keeps them on the carrier's
 *     clone, while leaving the camera free to look around.
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
    const carrier = this.sp.ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(this.carrierId)));
    if (!carrier || !carrier.is3DLoaded() ||
      ObjectReferenceEx.getWorldOrCell(carrier) !== ObjectReferenceEx.getWorldOrCell(player)) {
      return;
    }
    const target = ObjectReferenceEx.getPos(carrier);
    const dist = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(player), target);
    if (dist < CARRY_FOLLOW_DEADZONE || dist > CARRY_FOLLOW_MAX_DIST) {
      return;
    }
    player.translateTo(
      target[0], target[1], target[2],
      player.getAngleX(), player.getAngleY(), player.getAngleZ(),
      dist / CARRY_FOLLOW_TIME_S, 0,
    );
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

    // Bound or carried shows the captive pose, otherwise clear it; only fire on transition.
    const desiredPose = (this.boundHands || this.carried) ? this.captiveAnim : OFFSET_STOP_ANIM;
    if (desiredPose !== this.appliedPose) {
      this.sp.Debug.sendAnimationEvent(player, desiredPose);
      this.appliedPose = desiredPose;
    }

    // Recompute the control lock each time. Argument order:
    // (movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType).
    if (this.carried) {
      // Immobilised so the server can move the body; camera/looking left free.
      this.sp.Game.disablePlayerControls(true, true, false, false, true, false, true, false, 0);
      player.setDontMove(true);
    } else if (this.boundHands) {
      // Can still walk / be marched, but can't fight, sneak or use hands.
      player.setDontMove(false);
      this.sp.Game.disablePlayerControls(false, true, false, false, true, false, true, false, 0);
    } else {
      player.setDontMove(false);
      this.sp.Game.enablePlayerControls(true, true, true, true, true, true, true, true, 0);
    }
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
  private appliedPose = "";

  private carrying = false;
  private carrierAnim = CARRY_HOLD_ANIM_START;
  private appliedCarrierAnim = "";
  private encumbranceApplied = false;

  private lastTickMs = 0;
  private wasInJump = false;
  private poseDirty = false;
  private nextPoseReapplyMs = 0;
}
