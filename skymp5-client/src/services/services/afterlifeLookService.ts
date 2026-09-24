import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";
import { afterlifeLookOf, setAdminGhostShader } from "../../view/adminGhostLook";
import { logToPlatformLog } from "../../logging";

const CHECK_MS = 1000;
const SHADER_REPLAY_DELAY_MS = 1000;
const PLAYER_FORM_ID = 0x14;

/**
 * Plays the realm look the server writes to the own model's ff_afterlife ({ realm, shader, alpha })
 * on the local player, the way AdminModeService plays the Ghost shader; a respawn drops effect
 * shaders, so it is played again shortly after one. Copies take it from FormView.
 */
export class AfterlifeLookService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("applyDeathStateEvent", (e) => this.onApplyDeathState(e));
    this.controller.emitter.on("connectionDisconnect", () => this.controller.once("update", () => this.apply(0, 1)));
  }

  private onApplyDeathState(e: ApplyDeathStateEvent): void {
    if (this.shaderId && !e.isDead && e.actor.getFormID() === PLAYER_FORM_ID) this.replayAt = Date.now() + SHADER_REPLAY_DELAY_MS;
  }

  private onUpdate(): void {
    const now = Date.now();
    if (this.replayAt > 0 && now >= this.replayAt) {
      this.replayAt = 0;
      const player = this.sp.Game.getPlayer();
      if (this.shaderId && player) setAdminGhostShader(player, true, this.shaderId, this.alpha);
    }
    if (now < this.nextCheckAt) return;
    this.nextCheckAt = now + CHECK_MS;
    if (this.sp.storage["ownerModelSet"] !== true) return;
    // The realm is written while the victim still lies dead; the look waits for the respawn
    const own = this.sp.Game.getPlayer();
    if (!own || own.isDead()) return;
    const { shaderId, alpha } = afterlifeLookOf(this.sp.storage["ownerModel"] as Record<string, unknown> | undefined);
    if (shaderId !== this.shaderId || alpha !== this.alpha) this.apply(shaderId, alpha);
  }

  private apply(shaderId: number, alpha: number): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    if (this.shaderId && this.shaderId !== shaderId) setAdminGhostShader(player, false, this.shaderId);
    if (shaderId) setAdminGhostShader(player, true, shaderId, alpha);
    else if (this.shaderId) player.setAlpha(1, false);
    if (shaderId !== this.shaderId) logToPlatformLog(this, `look ${shaderId ? shaderId.toString(16) : "off"}`);
    this.shaderId = shaderId;
    this.alpha = alpha;
    this.replayAt = 0;
  }

  private shaderId = 0;
  private alpha = 1;
  private replayAt = 0;
  private nextCheckAt = 0;
}
