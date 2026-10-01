import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logToPlatformLog } from "../../logging";

// Block Runner's graph variable: its block state uses NPC_Blocking_ShieldCharge_MT (run 370), which also replaces the sneak movement type (run 222)
const SHIELD_CHARGE_VAR = "bPerkShieldCharge";
const BLOCK_RUNNER_PERK = 0x106253;
const PERK_CHECK_MS = 1000;

export class SneakBlockSpeedService extends ClientListener {
  private sneaking: boolean | undefined;
  private hadPerk: boolean | undefined;
  private nextCheckMs = 0;
  private topSpeed = -1;
  private wasBlocking = false;
  private raisedStanding = false;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
  }

  // The engine sets the variable only when the graph is built, so the client keeps it to the perk held and off while sneaking
  private onUpdate(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    const sneaking = player.isSneaking();
    this.trackSneakBlock(player, sneaking);
    const now = Date.now();
    if (sneaking === this.sneaking && now < this.nextCheckMs) return;
    this.sneaking = sneaking;
    this.nextCheckMs = now + PERK_CHECK_MS;
    const perk = this.sp.Perk.from(this.sp.Game.getFormEx(BLOCK_RUNNER_PERK));
    const hasPerk = !!perk && player.hasPerk(perk);
    const perkChanged = hasPerk !== this.hadPerk;
    this.hadPerk = hasPerk;
    const want = hasPerk && !sneaking;
    if (player.getAnimationVariableBool(SHIELD_CHARGE_VAR) === want) return;
    player.setAnimationVariableBool(SHIELD_CHARGE_VAR, want);
    if (perkChanged) logToPlatformLog(this, `${SHIELD_CHARGE_VAR} ${want}: Block Runner ${hasPerk ? "held" : "not held"}, sneaking ${sneaking}`);
  }

  // One line per sneak block with movement: its top speed against the movement types' run speeds
  // this.sneaking still holds the last frame's value here, so a block up on a standing frame was raised before the crouch
  private trackSneakBlock(player: Actor, sneaking: boolean): void {
    const blocking = player.getAnimationVariableBool("IsBlocking");
    const wasBlocking = this.wasBlocking;
    this.wasBlocking = blocking;
    if (sneaking && blocking) {
      if (this.topSpeed < 0) this.raisedStanding = wasBlocking && this.sneaking === false;
      this.topSpeed = Math.max(this.topSpeed, player.getAnimationVariableFloat("SpeedSampled"));
      return;
    }
    if (this.topSpeed > 0) {
      const speedMult = player.getActorValue("SpeedMult").toFixed(0);
      logToPlatformLog(this, `sneak block top speed ${this.topSpeed.toFixed(0)} at SpeedMult ${speedMult}, ${SHIELD_CHARGE_VAR} ${player.getAnimationVariableBool(SHIELD_CHARGE_VAR)}, block raised before the crouch ${this.raisedStanding} (run at SpeedMult 100: sneak 222, block 81, Block Runner block 370)`);
    }
    this.topSpeed = -1;
  }
}
