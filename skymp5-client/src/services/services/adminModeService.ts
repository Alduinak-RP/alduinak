import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

/**
 * Applies admin mode toggles pushed by the server's AdminSystem:
 *   { customPacketType: "adminMode", mode, on }
 * god/noclip/ghost/invis map to local natives; smite/healhit are fully
 * server-side; freecam has no SkyrimPlatform native (tfc stays a console
 * command for admins, who already hold consoleCommandsAllowed).
 */
export class AdminModeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "adminMode") return;
    const mode = String(content["mode"] ?? "");
    const on = !!content["on"];
    // Natives throw in the packet-handler context; defer to update
    this.controller.once("update", () => this.apply(mode, on));
  }

  private apply(mode: string, on: boolean): void {
    const player = this.sp.Game.getPlayer();
    switch (mode) {
      case "god":
        this.sp.Debug.setGodMode(on);
        break;
      case "noclip":
        // toggleCollisions is a toggle; track local state so repeated packets stay in sync
        if (this.collisionsDisabled !== on) {
          this.sp.Debug.toggleCollisions();
          this.collisionsDisabled = on;
        }
        break;
      case "ghost":
        player?.setGhost(on);
        break;
      case "invis":
        player?.setAlpha(on ? 0 : 1, true);
        break;
      case "freecam":
        showSystemNotification(this.sp, on
          ? "Freecam has no hotkey: open the console (~) and type tfc"
          : "Freecam off; if the camera is still free, type tfc in the console (~) again");
        break;
      case "smite":
        showSystemNotification(this.sp, on ? "Smite enabled" : "Smite disabled");
        break;
      case "healhit":
        showSystemNotification(this.sp, on ? "Heal-on-hit enabled" : "Heal-on-hit disabled");
        break;
      default:
        break;
    }
  }

  private collisionsDisabled = false;
}
