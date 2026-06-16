import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";

// Vanilla Skyrim behaviour-graph events (no ESP required). The bound-hands pose
// is an "offset" overlay started with OffsetBoundStandingStart and cleared with
// OffsetStop — the same family the carry system uses (OffsetCarryBasketStart).
// Both are whitelisted in sync/animation.ts (forcedSyncAnims) so the pose is
// visible to other players, not just locally.
const BOUND_HANDS_ANIM_START = "OffsetBoundStandingStart";
const OFFSET_STOP_ANIM = "OffsetStop";

/**
 * Applies the local player's restraint state — bound hands (arrest) and being
 * carried — to controls and animation. Server-authoritative: the gamemode owns
 * who may bind/carry whom, consent, bleedout timers and respawn; this service
 * only reflects the resulting state on the local client.
 *
 * Protocol — Server -> Client, {@link MsgType.CustomPacket} with a JSON dump.
 * Fields are optional; only the ones present are changed:
 *
 *   { "customPacketType": "restraintState", "boundHands": true }
 *   { "customPacketType": "restraintState", "carried": true }
 *   { "customPacketType": "restraintState", "boundHands": false, "carried": false }
 *
 * Effects on the local player:
 *   - boundHands: plays the bound-hands pose and disables fighting/sneaking/
 *     activation. Movement stays enabled so the prisoner can be marched/walked.
 *   - carried: fully immobilises the player (so the server can move the body)
 *     while leaving the camera free to look around.
 *
 * "Carry stops the respawn process" (feature 10) is enforced server-side by the
 * gamemode pausing the bleedout timer while carried; see the survival-loop doc.
 *
 * The service is inert until the server sends "restraintState".
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

    if (content["customPacketType"] !== "restraintState") {
      return;
    }

    if (typeof content["boundHands"] === "boolean") {
      this.boundHands = content["boundHands"];
    }
    if (typeof content["carried"] === "boolean") {
      this.carried = content["carried"];
    }

    logTrace(this, `restraintState boundHands=${this.boundHands} carried=${this.carried}`);
    this.applyState();
  }

  private applyState(): void {
    // These are native game-thread calls; running them straight from the packet
    // handler throws "can't be called in this context". Defer to the next update
    // tick (matching AuthService's disablePlayerControls usage).
    this.controller.once("update", () => this.applyStateNow());
  }

  private applyStateNow(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }

    // Start/stop the bound-hands pose only on transition to avoid re-triggering
    // the animation every update.
    if (this.boundHands !== this.appliedBoundHands) {
      this.sp.Debug.sendAnimationEvent(player, this.boundHands ? BOUND_HANDS_ANIM_START : OFFSET_STOP_ANIM);
      this.appliedBoundHands = this.boundHands;
    }

    // Recompute the control lock from scratch each time. Argument order:
    // (movement, fighting, camSwitch, looking, sneaking, menu, activate,
    //  journalTabs, disablePOVType).
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

  private boundHands = false;
  private carried = false;
  private appliedBoundHands = false;
}
