import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";

// Vanilla behaviour-graph "offset" overlay events (no ESP required), cleared with OffsetStop.
// All three are whitelisted in sync/animation.ts (forcedSyncAnims) so the poses sync to other players.
// Server-overridden pose names (settings.captiveAnimEvent / carrierAnimEvent) must also be whitelisted.
const BOUND_HANDS_ANIM_START = "OffsetBoundStandingStart";
const CARRY_HOLD_ANIM_START = "OffsetCarryBasketStart";
const OFFSET_STOP_ANIM = "OffsetStop";

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
 *   // The restrained player (captive):
 *   { "customPacketType": "restraintState", "boundHands": true }
 *   { "customPacketType": "restraintState", "carried": true, "anim": "OffsetBoundStandingStart" }
 *   { "customPacketType": "restraintState", "boundHands": false, "carried": false }
 *
 *   // The carrier (pose only, no control change):
 *   { "customPacketType": "carryState", "carrying": true, "anim": "OffsetCarryBasketStart" }
 *   { "customPacketType": "carryState", "carrying": false }
 *
 * Effects on the local player:
 *   - boundHands: plays the bound-hands pose and disables fighting/sneaking/
 *     activation. Movement stays enabled so the prisoner can be marched/walked.
 *   - carried: fully immobilises the player (so the server can move the body)
 *     while leaving the camera free to look around.
 *   - carrying: plays the carry-hold pose; controls are untouched so the carrier
 *     can walk the captive around.
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
      if (typeof content["anim"] === "string" && content["anim"]) {
        this.captiveAnim = content["anim"] as string;
      }
      logTrace(this, `restraintState boundHands=${this.boundHands} carried=${this.carried}`);
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

  // The carrier's carry-hold pose only, no control change; deferred like applyState.
  private applyCarryAnim(): void {
    this.controller.once("update", () => {
      const player = this.sp.Game.getPlayer();
      if (!player) {
        return;
      }
      const desired = this.carrying ? this.carrierAnim : OFFSET_STOP_ANIM;
      if (desired !== this.appliedCarrierAnim) {
        this.sp.Debug.sendAnimationEvent(player, desired);
        this.appliedCarrierAnim = desired;
      }
    });
  }

  private boundHands = false;
  private carried = false;
  private captiveAnim = BOUND_HANDS_ANIM_START;
  private appliedPose = "";

  private carrying = false;
  private carrierAnim = CARRY_HOLD_ANIM_START;
  private appliedCarrierAnim = "";
}
