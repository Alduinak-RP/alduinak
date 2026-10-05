import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";
import { afterlifeLookOf, setAdminGhostShader } from "../../view/adminGhostLook";
import { logToPlatformLog } from "../../logging";
import { TimersService } from "./timersService";

const AFTERLIFE_PROP = "ff_afterlife";
const DEAD_RETRY_MS = 1000;
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
    this.controller.emitter.on("ownerModelReset", () => this.queueCheck(0));
    this.controller.emitter.on("ownerPropertyChanged", (e) => {
      if (e.propName === AFTERLIFE_PROP) this.queueCheck(0);
    });
    this.controller.emitter.on("applyDeathStateEvent", (e) => this.onApplyDeathState(e));
    this.controller.emitter.on("connectionDisconnect", () => this.onDisconnect());
    if (this.sp.storage["ownerModelSet"] === true) this.controller.once("update", () => this.check());
  }

  private onApplyDeathState(e: ApplyDeathStateEvent): void {
    if (e.isDead || e.actor.getFormID() !== PLAYER_FORM_ID) return;
    if (this.shaderId) this.replayAt = Date.now() + SHADER_REPLAY_DELAY_MS;
    this.queueCheck(SHADER_REPLAY_DELAY_MS);
  }

  // A pending check would bring back the old model's look
  private onDisconnect(): void {
    this.checkAt = 0;
    this.controller.once("update", () => this.apply(0, 1));
  }

  // One pending check at a time; an earlier request replaces a later one
  private queueCheck(delayMs: number): void {
    const at = Date.now() + delayMs;
    if (this.checkAt !== 0 && this.checkAt <= at) return;
    this.checkAt = at;
    this.controller.lookupListener(TimersService).setTimeoutOnUpdate(() => {
      if (this.checkAt !== at) return;
      this.checkAt = 0;
      this.check();
    }, delayMs);
  }

  private check(): void {
    const now = Date.now();
    if (this.replayAt > 0) {
      if (now < this.replayAt) {
        this.queueCheck(this.replayAt - now);
      } else {
        this.replayAt = 0;
        const player = this.sp.Game.getPlayer();
        if (this.shaderId && player) setAdminGhostShader(player, true, this.shaderId, this.alpha);
      }
    }
    if (this.sp.storage["ownerModelSet"] !== true) return;
    const { shaderId, alpha } = afterlifeLookOf(this.sp.storage["ownerModel"] as Record<string, unknown> | undefined);
    if (shaderId === this.shaderId && alpha === this.alpha) return;
    // The realm is written while the victim still lies dead; the look waits for the respawn
    const own = this.sp.Game.getPlayer();
    if (!own || own.isDead()) {
      this.queueCheck(DEAD_RETRY_MS);
      return;
    }
    this.apply(shaderId, alpha);
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
  private checkAt = 0;
}
