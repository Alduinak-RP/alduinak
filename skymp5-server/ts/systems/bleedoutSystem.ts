import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { CaptureSystem, isRestrained } from "./captureSystem";
import { toFormId } from "./formIdUtil";
import { BLEEDOUT_PROP, addItemTo, chainMpHook, hex, isAlive, isNear, isPlayerActor, nameShownTo, notifyActor, sendActionLock, userOf } from "./actorUtil";
import { appendLog, describeActor, logDirOf, sendJson } from "./playerText";
import { deathAlert, markDeathAlerted } from "./discordAlerts";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Bleedout ──────────────────────────────────────────────────────────────────
//
// Before a player dies at 0 health the native gate (MpActor::TryBleedout) fires
// onKillAttempt; refusing it holds them at 1% health instead. A downed player
// kneels and cannot move, fight, cast, activate or open menus. They die to a
// further hit from a player, to damage over time, to a logout, or when the
// timer runs out. Healing them to bleedoutHealedHealth stands them up, and a
// capture or carry (CaptureSystem.rescueDowned) ends the bleedout at once.
// NPC hits on a downed player are refused. Deliberate kills use
// mp.set isDead, which the gate never sees.
// Stabilize (X menu) lets anyone tend a downed player without magic: the
// rescuer kneels for 5 s while the victim's timer waits, then the victim
// stands at 10% health. The rescuer going down, dying or leaving cancels it.
//
// Wire protocol:
//   Client -> Server: { customPacketType: "stabilizeRequest", target }
//   Server -> the downed player's RestraintService:
//     { customPacketType: "bleedoutState", downed: true, seconds }
//     { customPacketType: "bleedoutState", downed: false, died }   // died: no stand-up animation
//   Server -> the rescuer: actionLock (sendActionLock)
//   Server -> the requester: playerMenuState flag "stabilize" (CaptureSystem.menuFlagProviders)

const STATE_PACKET = "bleedoutState";

// Overridable via "bleedoutSeconds" and "bleedoutHealedHealth"
const DEFAULT_BLEEDOUT_SECONDS = 15;
const DEFAULT_HEALED_HEALTH = 0.25;

// Health the native gate holds a downed player at (kBleedoutHealth in MpActor.cpp)
const BLEEDOUT_HEALTH = 0.01;
// A report of 0 without an aggressor this soon after the downing is the victim client's stale value, not a new wound
const GRACE_MS = 1000;
// A reported drop this large while downed is damage over time
const DOT_DROP = 0.005;
const TICK_MS = 250;

const STABILIZE_SECONDS = 5;
const STABILIZED_HEALTH = 0.1;
// The rescuer's vanilla kneel (IDLE FB90B CheckCorpse)
const STABILIZE_ANIM = "IdleKneeling";

interface Downed {
  deadline: number;
  graceUntil: number;
  lastHealth: number;
  downerId: number;
  // When a hold paused the timer, 0 while it runs
  pausedAt: number;
  hold?: Hold;
}

// Someone working on a downed player: the timer waits, and the tick completes or cancels the work
interface Hold {
  actorId: number;
  until: number;
  done: () => void;
}

export class BleedoutSystem implements System {
  systemName = "BleedoutSystem";

  constructor(private log: Log, private capture: CaptureSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const seconds = Number(all?.["bleedoutSeconds"]);
    if (Number.isFinite(seconds) && seconds > 0) this.bleedoutMs = seconds * 1000;
    const healed = Number(all?.["bleedoutHealedHealth"]);
    if (Number.isFinite(healed) && healed > BLEEDOUT_HEALTH && healed <= 1) this.healedHealth = healed;
    this.logDir = logDirOf(all);

    const mp = this.mp;
    chainMpHook(mp, "onKillAttempt", (actorId: number, killerId: number) => this.onKillAttempt(actorId >>> 0, killerId >>> 0));
    // A downed player neither fights, casts nor uses anything
    for (const event of ["onHitAttempt", "onSpellCastAttempt"]) {
      chainMpHook(mp, event, (actorId: number) => !this.downed.has(actorId >>> 0));
    }
    chainMpHook(mp, "onActivate", (_targetId: number, casterId: number) => !this.downed.has(casterId >>> 0));
    chainMpHook(mp, "onEatItem", (actorId: number, baseId: number) => this.onEatItem(actorId >>> 0, baseId >>> 0));
    chainMpHook(mp, "onHitDamageAttempt", (aggressorId: number, targetId: number, _sourceId: number, damage: number) =>
      this.onHitDamageAttempt(aggressorId >>> 0, targetId >>> 0, damage));

    this.capture.rescueDowned = (actorId) => this.end(actorId, "rescued");
    this.capture.menuFlagProviders.push((requesterId, targetId) => ({ stabilize: !this.stabilizeRefusal(requesterId, targetId) }));
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => this.onActorAssigned(actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.onLeave(actorId >>> 0));
  }

  async updateAsync(): Promise<void> {
    if (this.downed.size === 0) return;
    const now = Date.now();
    if (now < this.nextTickAt) return;
    this.nextTickAt = now + TICK_MS;
    for (const [actorId, state] of Array.from(this.downed)) {
      try {
        this.tick(actorId, state, now);
      } catch (e) {
        this.log(`[bleedout] tick of ${hex(actorId)} failed: ${e}`);
      }
    }
  }

  customPacket(userId: number, type: string, content: Content): void {
    if (type === "stabilizeRequest") this.onStabilizeRequest(userId, toFormId(content.target, 0));
  }

  disconnect(userId: number): void {
    let actorId = 0;
    try { actorId = this.mp.getUserActor(userId) >>> 0; } catch { return; }
    if (actorId) this.onLeave(actorId);
  }

  // Returning false refuses the death: the gate holds the player at BLEEDOUT_HEALTH
  private onKillAttempt(actorId: number, killerId: number): boolean {
    const mp = this.mp;
    if (!isPlayerActor(mp, actorId)) return true;
    const now = Date.now();
    const state = this.downed.get(actorId);
    // Another player's hit finishes at once; a report without one waits out the grace, so damage over time still kills
    if (state) return (killerId !== 0 && killerId !== actorId) || now >= state.graceUntil;
    // God and ghost admins never go down, and a smite kills outright
    if (this.isImmune(actorId)) return false;
    if (this.hasMode(killerId, "smite")) return true;
    this.downed.set(actorId, { deadline: now + this.bleedoutMs, graceUntil: now + GRACE_MS, lastHealth: BLEEDOUT_HEALTH, downerId: killerId, pausedAt: 0 });
    // Outside the native hit call stack
    setTimeout(() => this.announceDown(actorId, killerId), 0);
    return false;
  }

  // Nor eats or drinks: the effects are refused, and the item OnEquip removes anyway is handed back
  private onEatItem(actorId: number, baseId: number): boolean {
    if (!this.downed.has(actorId)) return true;
    setTimeout(() => {
      try {
        addItemTo(this.mp, actorId, baseId, 1, true);
      } catch (e) {
        this.log(`[bleedout] returning ${hex(baseId)} to ${hex(actorId)} failed: ${e}`);
      }
    }, 0);
    notifyActor(this.mp, actorId, "You cannot eat or drink while bleeding out.");
    return false;
  }

  private onHitDamageAttempt(aggressorId: number, targetId: number, damage: number): boolean {
    if (this.downed.has(aggressorId)) return false;
    const downed = this.downed.has(targetId);
    if (isPlayerActor(this.mp, targetId) && !this.isImmune(targetId)) {
      if (this.hasMode(aggressorId, "smite")) {
        setTimeout(() => { if (isAlive(this.mp, targetId)) this.die(targetId, "was smitten", aggressorId); }, 0);
        return true;
      }
      if (downed && this.hasMode(aggressorId, "healhit")) {
        setTimeout(() => this.standUp(targetId, "healed", 1), 0);
        return false;
      }
    }
    if (!downed) return true;
    // Only another player finishes a downed player; NPCs leave them be
    if (!isPlayerActor(this.mp, aggressorId)) return false;
    if (damage > 0) {
      const before = this.healthOf(targetId);
      setTimeout(() => this.afterHit(targetId, aggressorId, before), 0);
    }
    return true;
  }

  // A hit that reached 0 already killed through the gate; a lighter one still finishes them
  private afterHit(targetId: number, aggressorId: number, healthBefore: number): void {
    if (!this.downed.has(targetId)) return;
    let dead = false;
    try { dead = this.mp.get(targetId, "isDead") === true; } catch { return; }
    if (dead) this.finish(targetId, true);
    else if (this.healthOf(targetId) < healthBefore) this.die(targetId, "was finished off", aggressorId);
  }

  private tick(actorId: number, state: Downed, now: number): void {
    let dead = false;
    try {
      dead = this.mp.get(actorId, "isDead") === true;
    } catch {
      this.downed.delete(actorId);
      return;
    }
    if (dead) {
      this.finish(actorId, true);
      return;
    }
    if (state.hold) {
      this.tickHold(actorId, state, now);
      if (!this.downed.has(actorId)) return;
    }
    const health = this.healthOf(actorId);
    if (health >= this.healedHealth) {
      this.end(actorId, "healed");
      return;
    }
    if (now >= state.graceUntil && health < state.lastHealth - DOT_DROP) {
      this.die(actorId, "died of their wounds while bleeding out");
      return;
    }
    state.lastHealth = health;
    if (!state.pausedAt && now >= state.deadline) this.die(actorId, "bled out");
  }

  // Timed work on a downed player (stabilize, finish off): the timer waits and done runs when it completes; the refusal, or "" once started
  hold(victimId: number, actorId: number, ms: number, done: () => void): string {
    const refusal = this.holdRefusal(victimId, actorId);
    if (refusal) return refusal;
    const now = Date.now();
    const state = this.downed.get(victimId)!;
    state.hold = { actorId, until: now + ms, done };
    state.pausedAt = now;
    return "";
  }

  private holdRefusal(victimId: number, actorId: number): string {
    const state = this.downed.get(victimId);
    if (!state || victimId === actorId) return "They are not bleeding out.";
    if (state.hold) return "Someone is already tending to them.";
    if (Array.from(this.downed.values()).some((s) => s.hold?.actorId === actorId)) return "You are already busy.";
    return "";
  }

  // The worker must stay connected, alive and on their feet until the work is done
  private tickHold(victimId: number, state: Downed, now: number): void {
    const hold = state.hold!;
    const mp = this.mp;
    if (userOf(mp, hold.actorId) < 0 || !isAlive(mp, hold.actorId) || this.downed.has(hold.actorId)) {
      this.resume(state, now);
      notifyActor(mp, victimId, "Nobody is tending to your wounds any more.");
      this.log(`[bleedout] ${hex(hold.actorId)} stopped tending to ${hex(victimId)}`);
      return;
    }
    if (now < hold.until) return;
    this.resume(state, now);
    hold.done();
  }

  private resume(state: Downed, now: number): void {
    if (state.pausedAt) state.deadline += now - state.pausedAt;
    state.pausedAt = 0;
    state.hold = undefined;
  }

  // Why the rescuer may not stabilize the target, "" when they may
  private stabilizeRefusal(rescuerId: number, targetId: number): string {
    const mp = this.mp;
    if (!this.downed.has(targetId) || targetId === rescuerId) return "They are not bleeding out.";
    if (!isAlive(mp, rescuerId) || this.downed.has(rescuerId) || isRestrained(mp, rescuerId) || this.capture.carriedOf(rescuerId)) {
      return "You cannot do that now.";
    }
    if (!isNear(mp, rescuerId, targetId, this.capture.interactRange)) return "They are out of reach.";
    return this.holdRefusal(targetId, rescuerId);
  }

  private onStabilizeRequest(userId: number, targetId: number): void {
    const mp = this.mp;
    let rescuerId = 0;
    try { rescuerId = mp.getUserActor(userId) >>> 0; } catch { return; }
    if (!rescuerId) return;
    const refusal = this.stabilizeRefusal(rescuerId, targetId) ||
      this.hold(targetId, rescuerId, STABILIZE_SECONDS * 1000, () => this.stabilized(targetId, rescuerId));
    if (refusal) {
      notifyActor(mp, rescuerId, refusal);
      return;
    }
    sendActionLock(mp, rescuerId, STABILIZE_ANIM, STABILIZE_SECONDS);
    notifyActor(mp, rescuerId, `You tend to ${nameShownTo(mp, rescuerId, targetId)}'s wounds.`);
    notifyActor(mp, targetId, `${nameShownTo(mp, targetId, rescuerId)} is tending to your wounds.`);
    this.log(`[bleedout] ${hex(rescuerId)} stabilizes ${hex(targetId)}`);
  }

  private stabilized(victimId: number, rescuerId: number): void {
    const mp = this.mp;
    this.standUp(victimId, "stabilized", STABILIZED_HEALTH);
    notifyActor(mp, victimId, `${nameShownTo(mp, victimId, rescuerId)} stabilized you.`);
    notifyActor(mp, rescuerId, `You stabilized ${nameShownTo(mp, rescuerId, victimId)}.`);
  }

  private announceDown(actorId: number, downerId: number): void {
    if (!this.downed.has(actorId)) return;
    const mp = this.mp;
    try {
      mp.set(actorId, BLEEDOUT_PROP, { since: Date.now(), downerId });
    } catch { /* form gone */ }
    const seconds = Math.round(this.bleedoutMs / 1000);
    this.send(actorId, { downed: true, seconds });
    notifyActor(mp, actorId, `You are bleeding out. Without help you die in ${seconds} seconds.`);
    if (downerId && downerId !== actorId && isPlayerActor(mp, downerId)) {
      notifyActor(mp, downerId, `${nameShownTo(mp, downerId, actorId)} is bleeding out.`);
    }
    this.log(`[bleedout] ${hex(actorId)} downed by ${hex(downerId)}`);
  }

  // Healed, rescued or stabilized: the player stands up where they knelt
  private end(actorId: number, reason: "healed" | "rescued" | "stabilized"): void {
    if (!this.downed.has(actorId)) return;
    this.finish(actorId, false);
    if (reason === "healed") notifyActor(this.mp, actorId, "Your wounds close and you get back up.");
    this.log(`[bleedout] ${hex(actorId)} ${reason}`);
  }

  private standUp(actorId: number, reason: "healed" | "stabilized", health: number): void {
    this.end(actorId, reason);
    try {
      const values = this.mp.get(actorId, "percentages");
      if (!(Number(values?.health) >= health)) this.mp.set(actorId, "percentages", { ...values, health });
    } catch (e) {
      this.log(`[bleedout] raising the health of ${hex(actorId)} failed: ${e}`);
    }
  }

  // A kill the gate never sees, downed or not; SetIsDead carries no killer, so a death caused by a player is written to pvp.log here
  private die(actorId: number, how: string, killerId = 0): void {
    const state = this.downed.get(actorId);
    const mp = this.mp;
    // Posted before the kill, so the gamemode's [Death] line for it is skipped
    deathAlert(mp, actorId, killerId, how);
    markDeathAlerted(actorId);
    try {
      mp.set(actorId, "isDead", true);
    } catch (e) {
      this.log(`[bleedout] killing ${hex(actorId)} failed: ${e}`);
    }
    if (state) this.finish(actorId, true);
    const downer = state && state.downerId !== actorId && isPlayerActor(mp, state.downerId) ? state.downerId : 0;
    if (killerId && isPlayerActor(mp, killerId)) {
      appendLog(this.logDir, "pvp.log", `${describeActor(mp, killerId)} killed ${describeActor(mp, actorId)}`);
    } else if (downer) {
      appendLog(this.logDir, "pvp.log", `${describeActor(mp, actorId)} ${how}, downed by ${describeActor(mp, downer)}`);
    }
    this.log(`[bleedout] ${hex(actorId)} ${how}`);
  }

  private finish(actorId: number, died: boolean): void {
    this.downed.delete(actorId);
    try {
      this.mp.set(actorId, BLEEDOUT_PROP, null);
    } catch { /* form gone */ }
    this.send(actorId, { downed: false, died });
  }

  // Logging out or leaving for character select while downed is a death, never an escape
  private onLeave(actorId: number): void {
    if (this.downed.has(actorId)) this.die(actorId, "logged out while bleeding out");
  }

  // The in-memory state does not outlive a restart, so a leftover mirror is cleared
  private onActorAssigned(actorId: number): void {
    if (this.downed.has(actorId)) return;
    try {
      if (this.mp.get(actorId, BLEEDOUT_PROP)) this.mp.set(actorId, BLEEDOUT_PROP, null);
    } catch { /* form gone */ }
  }

  private isImmune(actorId: number): boolean {
    return this.hasMode(actorId, "god") || this.hasMode(actorId, "ghost");
  }

  // The admin mode mirror AdminSystem writes
  private hasMode(actorId: number, mode: string): boolean {
    try {
      return !!this.mp.get(actorId, "ff_adminModes")?.[mode];
    } catch {
      return false;
    }
  }

  private healthOf(actorId: number): number {
    try {
      const health = Number(this.mp.get(actorId, "percentages")?.health);
      return Number.isFinite(health) ? health : 0;
    } catch {
      return 0;
    }
  }

  private send(actorId: number, payload: Record<string, unknown>): void {
    sendJson(this.mp, userOf(this.mp, actorId), { customPacketType: STATE_PACKET, ...payload });
  }

  private mp: Mp = null;
  private bleedoutMs = DEFAULT_BLEEDOUT_SECONDS * 1000;
  private healedHealth = DEFAULT_HEALED_HEALTH;
  private logDir = "";
  private nextTickAt = 0;
  // actorId -> bleedout in progress
  private downed = new Map<number, Downed>();
}
