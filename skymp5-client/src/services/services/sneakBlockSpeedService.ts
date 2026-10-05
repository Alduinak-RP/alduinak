import { ActiveEffectApplyRemoveEvent, Actor, Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logToPlatformLog } from "../../logging";
import { refreshMovement } from "../../sync/actorvalues";
import { addPlayerAnimationListener } from "../../sync/animation";

// Block Runner's graph variable: the block state machine starts in BlockShieldChargeState (iState 17) when it is true
const SHIELD_CHARGE_VAR = "bPerkShieldCharge";
const BLOCK_RUNNER_PERK = 0x106253;
const PLAYER_ID = 0x14;
// Checks after a perk or graph change, spaced so a graph still being built is caught
const PERK_CHECKS = 3;
const PERK_CHECK_MS = 1000;
const HOLD_CHECK_MS = 1000;
// Checks go on this long after a sneak or block event or a sneak block's end, as the graph may apply an event late or resume a block
const WATCH_MS = 1000;
const SPEED_MULT_TOLERANCE = 0.5;

// The graph's iState picks the movement type: a block state (4 or 17, priority 15 or 16) outranks the sneak state (2, priority 12)
const ISTATE_SNEAKING = 2;
const ISTATE_BLOCKING = 4;
// Skyrim.esm MOVT speeds at SpeedMult 100: side walk, side run, forward walk, forward run, back walk, back run
const SNEAK_SPEEDS = [41.44, 200, 47.2, 222, 43.38, 150];
const BLOCK_SPEEDS = [81, 81, 81, 81, 71, 71];
// NPC_Blocking_ShieldCharge_MT, at least as fast as any other movement type a sneak block could land in
const FAST_SPEEDS = [81, 370, 81, 370, 71, 205.25];

// Share of SpeedMult a sneak block keeps so that no direction beats NPC_Sneaking_MT
export const sneakBlockSpeedFactor = (iState: number, running: boolean): number => {
  if (iState === ISTATE_SNEAKING) return 1;
  const speeds = iState === ISTATE_BLOCKING ? BLOCK_SPEEDS : FAST_SPEEDS;
  const column = running ? 1 : 0;
  return Math.min(1, ...[0, 2, 4].map((i) => SNEAK_SPEEDS[i + column] / speeds[i + column]));
};

export class SneakBlockSpeedService extends ClientListener {
  private hadPerk: boolean | undefined;
  private perkChecksLeft = PERK_CHECKS;
  private nextPerkCheckMs = 0;
  private watchPending = true;
  private watchUntil = 0;
  private sneakBlocking = false;
  private factor = 1;
  private cut = 0;
  private heldSpeedMult = 0;
  private nextHoldCheckMs = 0;
  private topSpeed = -1;
  private lastBlock = "";

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    addPlayerAnimationListener((animEventName) => this.onPlayerAnimation(animEventName));
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("loadGame", () => this.onGraphRebuilt());
    this.controller.on("switchRaceComplete", (e) => {
      if (e.subject?.getFormID() === PLAYER_ID) this.onGraphRebuilt();
    });
    // Perks are taken in the stats menu, added from an admin's console, or carried by a mastery ability's effect
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.Stats || e.name === Menu.Console) this.queuePerkChecks();
    });
    this.controller.on("effectStart", (e) => this.onEffect(e));
    this.controller.on("effectFinish", (e) => this.onEffect(e));
  }

  private onEffect(e: ActiveEffectApplyRemoveEvent): void {
    if (e.target?.getFormID() === PLAYER_ID && e.effect?.getPerk()?.getFormID() === BLOCK_RUNNER_PERK) this.queuePerkChecks();
  }

  private onPlayerAnimation(animEventName: string): void {
    const lower = animEventName.toLowerCase();
    if (lower.startsWith("sneak") || lower.startsWith("block")) this.watchPending = true;
  }

  private onGraphRebuilt(): void {
    this.watchPending = true;
    this.queuePerkChecks();
  }

  private queuePerkChecks(): void {
    this.perkChecksLeft = PERK_CHECKS;
    this.nextPerkCheckMs = 0;
  }

  private onUpdate(): void {
    const now = Date.now();
    if (this.watchPending) {
      this.watchPending = false;
      this.watchUntil = now + WATCH_MS;
    }
    const watching = this.sneakBlocking || now < this.watchUntil;
    const perkDue = this.perkChecksLeft > 0 && now >= this.nextPerkCheckMs;
    if (!watching && !perkDue) return;
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    if (watching) this.holdSneakBlockSpeed(player, player.isSneaking(), now);
    if (perkDue) this.checkBlockRunner(player, now);
  }

  // The engine sets the variable only when the graph is built, so the client keeps it to the perk held
  private checkBlockRunner(player: Actor, now: number): void {
    this.perkChecksLeft--;
    this.nextPerkCheckMs = now + PERK_CHECK_MS;
    const perk = this.sp.Perk.from(this.sp.Game.getFormEx(BLOCK_RUNNER_PERK));
    const hasPerk = !!perk && player.hasPerk(perk);
    const perkChanged = hasPerk !== this.hadPerk;
    this.hadPerk = hasPerk;
    if (player.getAnimationVariableBool(SHIELD_CHARGE_VAR) === hasPerk) return;
    player.setAnimationVariableBool(SHIELD_CHARGE_VAR, hasPerk);
    if (perkChanged) logToPlatformLog(this, `${SHIELD_CHARGE_VAR} ${hasPerk}: Block Runner ${hasPerk ? "held" : "not held"}`);
  }

  // No block movement type knows about sneaking, so a sneak block's SpeedMult is damaged down to the sneak speeds and restored after it
  private holdSneakBlockSpeed(player: Actor, sneaking: boolean, now: number): void {
    if (!sneaking || !player.getAnimationVariableBool("IsBlocking")) {
      if (this.sneakBlocking) this.watchUntil = now + WATCH_MS;
      this.sneakBlocking = false;
      this.setSpeedFactor(player, 1);
      if (this.topSpeed > 0) logToPlatformLog(this, `sneak block top speed ${this.topSpeed.toFixed(0)}: ${this.lastBlock} (walk and run at SpeedMult 100: sneak 47 and 222, iState 4 block 81 and 81, iState 17 Block Runner block 81 and 370)`);
      this.topSpeed = -1;
      return;
    }
    this.sneakBlocking = true;
    const iState = player.getAnimationVariableInt("iState");
    // The engine walks an over-encumbered actor whatever the run flag says
    const running = (this.sp.TESModPlatform.isPlayerRunningEnabled() || player.isRunning()) && player.getActorValue("CarryWeight") >= player.getTotalItemWeight();
    this.setSpeedFactor(player, sneakBlockSpeedFactor(iState, running));
    const speed = player.getAnimationVariableFloat("Speed");
    if (speed <= this.topSpeed) return;
    this.topSpeed = speed;
    const speedMult = player.getActorValue("SpeedMult");
    this.lastBlock = `iState ${iState}, ${running ? "running" : "walking"}, SpeedMult ${speedMult.toFixed(0)} of ${(speedMult + this.cut).toFixed(0)}`;
  }

  private setSpeedFactor(player: Actor, factor: number): void {
    const now = Date.now();
    if (factor === this.factor) {
      if (factor === 1 || now < this.nextHoldCheckMs) return;
      this.nextHoldCheckMs = now + HOLD_CHECK_MS;
      if (Math.abs(player.getActorValue("SpeedMult") - this.heldSpeedMult) < SPEED_MULT_TOLERANCE) return;
    }
    if (this.cut > 0) player.restoreActorValue("SpeedMult", this.cut);
    this.cut = factor < 1 ? player.getActorValue("SpeedMult") * (1 - factor) : 0;
    if (this.cut > 0) player.damageActorValue("SpeedMult", this.cut);
    this.heldSpeedMult = player.getActorValue("SpeedMult");
    this.factor = factor;
    this.nextHoldCheckMs = now + HOLD_CHECK_MS;
    refreshMovement(player);
  }
}
