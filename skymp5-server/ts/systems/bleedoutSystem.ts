import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { CaptureSystem, isRestrained } from "./captureSystem";
import { toFormId } from "./formIdUtil";
import { BLEEDOUT_PROP, addItemTo, chainMpHook, hex, isAlive, isNear, isPlayerActor, nameShownTo, notifyActor, userOf } from "./actorUtil";
import { potionHealing } from "./espmMagic";
import { readInventory, withCount } from "./inventoryExtras";
import { appendLog, describeActor, logDirOf, profileIdOf, sendJson } from "./playerText";
import { deathAlert } from "./discordAlerts";
import { NEVER_RESPAWN } from "./npcPlacement";
import { every } from "./timers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Players at 0 health kneel until healed, rescued, finished off or bled out (docs_roleplay_survival_loop.md section 8)

const STATE_PACKET = "bleedoutState";

// Overridable via "bleedoutSeconds" and "bleedoutHealedHealth"
const DEFAULT_BLEEDOUT_SECONDS = 15;
const DEFAULT_HEALED_HEALTH = 0.25;

// Health the native gate holds a downed player at (kBleedoutHealth in MpActor.cpp)
const BLEEDOUT_HEALTH = 0.01;
// A report of 0 without an aggressor this soon after the downing is the victim client's stale value, not a new wound; the client throttles reports to one per 2 s
const GRACE_MS = 3000;
// A reported drop this large while downed is damage over time
const DOT_DROP = 0.005;
const TICK_MS = 250;

interface Downed {
  deadline: number;
  graceUntil: number;
  lastHealth: number;
  downerId: number;
  // When a hold paused the timer, 0 while it runs
  pausedAt: number;
  hold?: Hold;
}

// A kill die() is making, read by the onDeath hook inside that mp.set
interface Dying {
  how: string;
  killerId: number;
  downerId: number;
  alert: boolean;
}

// Someone working on a downed player: the timer waits, and the tick completes or cancels the work
interface Hold {
  actorId: number;
  until: number;
  done: () => void;
  // The work kills (finish off): nothing else touches the victim, and it lands even if they die or leave first
  fatal: boolean;
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
    chainMpHook(mp, "onDeath", (actorId: number, killerId: number) => this.onDeath(actorId >>> 0, killerId >>> 0));

    this.capture.rescueDowned = (actorId) => this.end(actorId, "rescued");
    this.capture.rescueRefusal = (actorId) => this.downed.get(actorId)?.hold?.fatal ? "They are being finished off." : "";
    this.capture.menuFlagProviders.push((requesterId, targetId) => ({
      givePotion: this.downed.has(targetId) && targetId !== requesterId,
      hasPotion: !!this.smallestPotion(requesterId),
    }));
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => this.onActorAssigned(actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.onLeave(actorId >>> 0));
    every("bleedout", TICK_MS, () => this.poll());
  }

  poll(): void {
    if (this.downed.size === 0) return;
    const now = Date.now();
    for (const [actorId, state] of Array.from(this.downed)) {
      try {
        this.tick(actorId, state, now);
      } catch (e) {
        this.log(`[bleedout] tick of ${hex(actorId)} failed: ${e}`);
      }
    }
  }

  isDowned(actorId: number): boolean {
    return this.downed.has(actorId >>> 0);
  }

  customPacket(userId: number, type: string, content: Content): void {
    if (type === "givePotionRequest") this.onGivePotionRequest(userId, toFormId(content.target, 0));
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
    if (state) return !state.hold?.fatal && ((killerId !== 0 && killerId !== actorId) || now >= state.graceUntil);
    // God and ghost admins never go down, and a smite kills outright
    if (this.isImmune(actorId)) return false;
    if (killerId && this.hasMode(killerId, "smite")) return true;
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
    const target = this.downed.get(targetId);
    if (target?.hold?.fatal) return false;
    if (isPlayerActor(this.mp, targetId) && !this.isImmune(targetId)) {
      if (this.hasMode(aggressorId, "smite")) {
        setTimeout(() => { if (isAlive(this.mp, targetId)) this.die(targetId, "was smitten", aggressorId); }, 0);
        return true;
      }
      if (target && this.hasMode(aggressorId, "healhit")) {
        setTimeout(() => this.standUp(targetId, "healed", 1), 0);
        return false;
      }
    }
    if (!target) return true;
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
      if (state.hold?.fatal) this.complete(state, now);
      else this.finish(actorId, true);
      return;
    }
    if (state.hold) {
      this.tickHold(actorId, state, now);
      if (!this.downed.has(actorId) || state.hold?.fatal) return;
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

  // Timed work on a downed player (finish off): the timer waits and done runs when it completes; the refusal, or "" once started
  hold(victimId: number, actorId: number, ms: number, done: () => void, fatal = false): string {
    const refusal = this.holdRefusal(victimId, actorId);
    if (refusal) return refusal;
    const now = Date.now();
    const state = this.downed.get(victimId)!;
    state.hold = { actorId, until: now + ms, done, fatal };
    state.pausedAt = now;
    return "";
  }

  // The work ended early, such as a finish off whose animation is over; done runs now if actorId still holds the victim
  completeHold(victimId: number, actorId: number): void {
    const state = this.downed.get(victimId);
    if (state?.hold?.actorId === actorId) this.complete(state, Date.now());
  }

  private holdRefusal(victimId: number, actorId: number): string {
    const state = this.downed.get(victimId);
    if (!state || victimId === actorId) return "They are not bleeding out.";
    if (state.hold) return "Someone is already tending to them.";
    if (Array.from(this.downed.values()).some((s) => s.hold?.actorId === actorId)) return "You are already busy.";
    return "";
  }

  // The worker must stay connected, alive, on their feet and close until the work is done
  private tickHold(victimId: number, state: Downed, now: number): void {
    const hold = state.hold!;
    const mp = this.mp;
    if (userOf(mp, hold.actorId) < 0 || !isAlive(mp, hold.actorId) || this.downed.has(hold.actorId) ||
      !isNear(mp, hold.actorId, victimId, this.capture.interactRange * 2)) {
      this.resume(state, now);
      notifyActor(mp, victimId, "Nobody is tending to your wounds any more.");
      this.log(`[bleedout] ${hex(hold.actorId)} stopped tending to ${hex(victimId)}`);
      return;
    }
    if (now < hold.until) return;
    this.complete(state, now);
  }

  private complete(state: Downed, now: number): void {
    const hold = state.hold!;
    this.resume(state, now);
    hold.done();
  }

  private resume(state: Downed, now: number): void {
    if (state.pausedAt) state.deadline += now - state.pausedAt;
    state.pausedAt = 0;
    state.hold = undefined;
  }

  // Why the giver may not give the target a potion, "" when they may
  private givePotionRefusal(giverId: number, targetId: number): string {
    const mp = this.mp;
    if (!this.downed.has(targetId) || targetId === giverId) return "They are not bleeding out.";
    if (!isAlive(mp, giverId) || this.downed.has(giverId) || isRestrained(mp, giverId) || this.capture.carriedOf(giverId)) {
      return "You cannot do that now.";
    }
    if (!isNear(mp, giverId, targetId, this.capture.interactRange)) return "They are out of reach.";
    if (this.downed.get(targetId)!.hold) return "Someone is already tending to them.";
    return "";
  }

  // The healing potion that restores the least health, 0 when the actor carries none
  private smallestPotion(actorId: number): number {
    let best = 0;
    let bestHealing = Infinity;
    try {
      for (const e of readInventory(this.mp, actorId).entries) {
        const baseId = e.baseId >>> 0;
        const healing = e.count > 0 ? potionHealing(this.mp, baseId) : 0;
        if (healing > 0 && healing < bestHealing) {
          best = baseId;
          bestHealing = healing;
        }
      }
    } catch { /* form gone */ }
    return best;
  }

  private onGivePotionRequest(userId: number, targetId: number): void {
    const mp = this.mp;
    let giverId = 0;
    try { giverId = mp.getUserActor(userId) >>> 0; } catch { return; }
    if (!giverId) return;
    const potion = this.smallestPotion(giverId);
    const refusal = this.givePotionRefusal(giverId, targetId) || (potion ? "" : "You have no healing potion.");
    if (refusal) {
      notifyActor(mp, giverId, refusal);
      return;
    }
    try {
      const inv = readInventory(mp, giverId);
      const index = inv.entries.findIndex((e) => (e.baseId >>> 0) === potion && e.count > 0);
      const entries = inv.entries.map((e, i) => (i === index ? withCount(e, e.count - 1) : e)).filter((e) => e.count > 0);
      mp.set(giverId, "inventory", { ...inv, entries });
      mp.callPapyrusFunction("method", "Actor", "RestoreActorValue", { type: "form", desc: mp.getDescFromId(targetId) }, ["Health", potionHealing(mp, potion)]);
    } catch (e) {
      this.log(`[bleedout] ${hex(giverId)} giving potion ${hex(potion)} to ${hex(targetId)} failed: ${e}`);
      return;
    }
    this.standUp(targetId, "healed", this.healedHealth);
    notifyActor(mp, targetId, `${nameShownTo(mp, targetId, giverId)} gave you a healing potion.`);
    notifyActor(mp, giverId, `You gave ${nameShownTo(mp, giverId, targetId)} a healing potion.`);
    this.log(`[bleedout] ${hex(giverId)} gave potion ${hex(potion)} to ${hex(targetId)}`);
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

  // Healed or rescued: the player stands up where they knelt
  private end(actorId: number, reason: "healed" | "rescued"): void {
    const state = this.downed.get(actorId);
    if (!state) return;
    if (state.hold) notifyActor(this.mp, state.hold.actorId, `${nameShownTo(this.mp, state.hold.actorId, actorId)} no longer needs your help.`);
    this.finish(actorId, false);
    if (reason === "healed") notifyActor(this.mp, actorId, "Your wounds close and you get back up.");
    this.log(`[bleedout] ${hex(actorId)} ${reason}`);
  }

  private standUp(actorId: number, reason: "healed", health: number): void {
    this.end(actorId, reason);
    try {
      const values = this.mp.get(actorId, "percentages");
      if (!(Number(values?.health) >= health)) this.mp.set(actorId, "percentages", { ...values, health });
    } catch (e) {
      this.log(`[bleedout] raising the health of ${hex(actorId)} failed: ${e}`);
    }
  }

  // A kill the gate never sees, downed or not; SetIsDead carries no killer, so onDeath takes how and the killer from dying; alert false when the caller posts its own line
  die(actorId: number, how: string, killerId = 0, alert = true): void {
    const state = this.downed.get(actorId);
    const mp = this.mp;
    this.dying.set(actorId, { how, killerId, downerId: state?.downerId ?? 0, alert });
    try {
      mp.set(actorId, "isDead", true);
    } catch (e) {
      this.log(`[bleedout] killing ${hex(actorId)} failed: ${e}`);
    } finally {
      this.dying.delete(actorId);
    }
    if (state) this.finish(actorId, true);
    this.log(`[bleedout] ${hex(actorId)} ${how}`);
  }

  // Player deaths go to the staff alerts and kills by a player to pvp.log; killed NPCs stay dead unless a script chose a respawn delay (zone spawns set their own)
  private onDeath(actorId: number, killerId: number): void {
    const mp = this.mp;
    if (profileIdOf(mp, actorId) < 0) {
      this.keepDead(actorId);
      return;
    }
    const dying = this.dying.get(actorId);
    const how = dying?.how ?? "died";
    const killer = dying ? dying.killerId : killerId;
    if (dying?.alert !== false) deathAlert(mp, actorId, killer, how);
    const downer = dying && dying.downerId && dying.downerId !== actorId && isPlayerActor(mp, dying.downerId) ? dying.downerId : 0;
    if (killer && isPlayerActor(mp, killer)) {
      appendLog(this.logDir, "pvp.log", `${describeActor(mp, killer)} killed ${describeActor(mp, actorId)}`);
    } else if (downer) {
      appendLog(this.logDir, "pvp.log", `${describeActor(mp, actorId)} ${how}, downed by ${describeActor(mp, downer)}`);
    }
  }

  // Written inside the hook, before the native respawn reads it; delays past NEVER_RESPAWN overflow the engine timer, so the old 1e12 is repaired too
  private keepDead(actorId: number): void {
    try {
      const delay = Number(this.mp.get(actorId, "spawnDelay") ?? 0);
      if (delay <= 60 || delay > NEVER_RESPAWN) this.mp.set(actorId, "spawnDelay", NEVER_RESPAWN);
    } catch { /* form gone */ }
  }

  private finish(actorId: number, died: boolean): void {
    this.downed.delete(actorId);
    try {
      this.mp.set(actorId, BLEEDOUT_PROP, null);
    } catch { /* form gone */ }
    this.send(actorId, { downed: false, died });
  }

  // Logging out or leaving for character select while downed is a death, never an escape; a finish off under way lands
  private onLeave(actorId: number): void {
    const state = this.downed.get(actorId);
    if (state?.hold?.fatal) this.complete(state, Date.now());
    else if (state) this.die(actorId, "logged out while bleeding out");
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
  // actorId -> bleedout in progress
  private downed = new Map<number, Downed>();
  private dying = new Map<number, Dying>();
}
