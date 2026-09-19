import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

/**
 * Faction membership on the client. The Personal Menu's Faction tabs (AdminMenuService) show the columns, rosters and the Regency
 * tab; this service keeps the player's faction state, which unlocks the interaction menu's Recruit entry, and shows faction
 * notices. Server side: skymp5-server factionSystem.ts.
 *
 *   Server -> Client:
 *     { "customPacketType": "factionState", "factions": [{ "id", "name", "type" }], "canRecruit": true }
 *     { "customPacketType": "factionNotice", "text": "Lydia is now Guard." }
 *   Client -> Server (PlayerActionService):
 *     { "customPacketType": "factionRecruitRequest", "target": <server form id> }
 */
export class FactionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  get canRecruit(): boolean {
    return this.recruitAllowed;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "factionState":
        this.recruitAllowed = content["canRecruit"] === true;
        break;
      case "factionNotice":
        if (typeof content["text"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["text"]);
        }
        break;
      default:
        break;
    }
  }

  private recruitAllowed = false;
}
