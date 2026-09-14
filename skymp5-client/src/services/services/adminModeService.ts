import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";
import { adminGhostAlpha, setAdminGhostShader } from "../../view/adminGhostLook";

const LOOK_REAPPLY_MS = 2000;
const SHADER_REPLAY_DELAY_MS = 1000;
const LOCAL_MODES = ["god", "noclip", "ghost", "invis"];

/**
 * Applies admin mode toggles pushed by the server's AdminSystem:
 *   { customPacketType: "adminMode", mode, on }
 * god/noclip/ghost/invis map to local natives; smite/healhit are fully
 * server-side; freecam has no SkyrimPlatform native (tfc stays a console
 * command for admins, who already hold consoleCommandsAllowed).
 * God and Ghost also hold server-side (AdminSystem refuses hit damage); FormView hides remote invis admins via ff_adminModes, shows them to admins as ghosts, and shows Ghost admins to everyone as ghosts.
 */
export class AdminModeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("applyDeathStateEvent", (e) => this.onApplyDeathState(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("connectionAccepted", () => this.controller.once("update", () => this.resetLocalModes()));
  }

  // A new session starts with every mode off; the server re-sends the active ones after login
  private resetLocalModes(): void {
    for (const mode of Array.from(this.localModes)) this.apply(mode, false, false);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "adminMode") return;
    const mode = String(content["mode"] ?? "");
    const on = !!content["on"];
    // Natives throw in the packet-handler context; defer to update
    this.controller.once("update", () => this.apply(mode, on));
  }

  private apply(mode: string, on: boolean, notify = true): void {
    const player = this.sp.Game.getPlayer();
    if (LOCAL_MODES.includes(mode)) {
      if (on) this.localModes.add(mode);
      else this.localModes.delete(mode);
    }
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
        this.ghost = on;
        player?.setGhost(on);
        if (player) setAdminGhostShader(player, on);
        this.applyAlpha(true);
        if (notify) showSystemNotification(this.sp, on ? "Ghost: everyone sees you as a ghost and hits pass through you" : "Ghost off");
        break;
      case "invis":
        this.invisible = on;
        this.applyAlpha(true);
        if (notify) showSystemNotification(this.sp, on ? "Invisible: players cannot see you, other admins see you as a ghost" : "Invisible off");
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

  // A respawned player drops effect shaders
  private onApplyDeathState(e: ApplyDeathStateEvent): void {
    if (this.ghost && !e.isDead && e.actor.getFormID() === 0x14) this.shaderReplayAt = Date.now() + SHADER_REPLAY_DELAY_MS;
  }

  private applyAlpha(fade: boolean): void {
    this.lastLookApply = Date.now();
    this.sp.Game.getPlayer()?.setAlpha(this.invisible ? 0 : this.ghost ? adminGhostAlpha : 1, fade);
  }

  // Respawn and 3D reloads reset the player's alpha
  private onUpdate(): void {
    const now = Date.now();
    if (this.shaderReplayAt > 0 && now >= this.shaderReplayAt) {
      this.shaderReplayAt = 0;
      const player = this.sp.Game.getPlayer();
      if (this.ghost && player) setAdminGhostShader(player, true);
    }
    if ((this.invisible || this.ghost) && now - this.lastLookApply >= LOOK_REAPPLY_MS) this.applyAlpha(false);
  }

  private collisionsDisabled = false;
  private invisible = false;
  private ghost = false;
  private lastLookApply = 0;
  private shaderReplayAt = 0;
  private localModes = new Set<string>();
}
