import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket } from "./customPacketUtil";
import { applyAttributeBonus } from "../../sync/attributePenalty";
import { logTrace } from "../../logging";

const AVS: Array<[string, "health" | "magicka" | "stamina"]> = [["Health", "health"], ["Magicka", "magicka"], ["Stamina", "stamina"]];

type Applied = Record<string, number>;

/**
 * Permanent max health, magicka and stamina change an admin set on this character (AdminSystem, Players tab).
 * The server stores it and re-sends it on every actor assign, because a spawn re-reads the base attributes
 * from the plugins. The needs penalties recompute against the new maximum on the next needsState.
 *
 *   Server -> Client: { "customPacketType": "attributeBonus", "health", "magicka", "stamina" }
 */
export class AttributeBonusService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
  }

  // A new actor comes with the plugins' base attributes, so nothing of ours is on it yet
  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>): void {
    if (!e.message.isMe) return;
    this.applied = {};
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "attributeBonus") return;
    const wanted: Applied = {};
    for (const [av, key] of AVS) wanted[av] = Number(content[key]) || 0;
    this.controller.once("update", () => this.apply(wanted));
  }

  private apply(wanted: Applied): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    for (const [av] of AVS) {
      const before = this.applied[av] || 0;
      const now = applyAttributeBonus(player, av, before, wanted[av]);
      if (now === before) continue;
      this.applied[av] = now;
      logTrace(this, `max ${av} changed by ${Math.round(now)}`);
    }
  }

  private applied: Applied = {};
}
