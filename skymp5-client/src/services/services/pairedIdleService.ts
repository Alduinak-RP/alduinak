import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { suspendCloneMovement } from "../../sync/mountApply";
import { logTrace } from "../../logging";

const PLAYER_FORM_ID = 0x14;

// Plays the finish off killmove on this client's copies of both actors, out of the movement sync for its length
export class PairedIdleService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "pairedIdle") return;
    const attacker = Number(content["attacker"]) >>> 0;
    const target = Number(content["target"]) >>> 0;
    const idle = Number(content["idle"]) >>> 0;
    const ms = Number(content["ms"]);
    if (!attacker || !target || !idle || !(ms > 0)) return;
    // Native calls are unsafe in the packet handler
    this.controller.once("update", () => this.play(attacker, target, idle, ms));
  }

  private play(attackerRemoteId: number, targetRemoteId: number, idleId: number, ms: number): void {
    const attackerId = this.localIdOf(attackerRemoteId);
    const targetId = this.localIdOf(targetRemoteId);
    const attacker = this.sp.Actor.from(this.sp.Game.getFormEx(attackerId));
    const target = this.sp.Actor.from(this.sp.Game.getFormEx(targetId));
    const idle = this.sp.Idle.from(this.sp.Game.getFormEx(idleId));
    if (!attacker || !target || !idle || !attacker.is3DLoaded() || !target.is3DLoaded()) return;
    for (const id of [attackerId, targetId]) {
      if (id !== PLAYER_FORM_ID) suspendCloneMovement(id, ms);
    }
    const played = attacker.playIdleWithTarget(idle, target);
    logTrace(this, `pairedIdle ${idleId.toString(16)} ${attackerId.toString(16)} -> ${targetId.toString(16)}: ${played}`);
  }

  private localIdOf(remoteId: number): number {
    const myId = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0;
    return remoteId === myId ? PLAYER_FORM_ID : remoteIdToLocalId(remoteId);
  }
}
