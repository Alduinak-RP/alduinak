import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { chainMpHook, countItem, hex, notifyActor, recordTypeOf, takeItemFrom, unequipItemOf, userOf } from "./actorUtil";
import { describeActor } from "./playerText";
import { KeyedTimers, soon } from "./timers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// A held torch burns out after torchBurnMinutes of use, counted from the equipment reports while its holder plays; docs in docs_server_configuration_reference.md
const DEFAULT_BURN_MINUTES = 15;
// Milliseconds the character's torch has burned, kept across relogs until it burns out
const BURN_PROP = "private.torchBurnMs";

interface Lit {
  userId: number;
  baseId: number;
  since: number;
  burnedMs: number;
}

export class TorchSystem implements System {
  systemName = "TorchSystem";
  constructor(private log: Log) { }

  private limitMs = 0;
  private lit = new Map<number, Lit>();
  // actorId -> the lit torch's burn-out
  private burnOuts = new KeyedTimers<number>();
  // actorId -> burned milliseconds the next save writes
  private unsaved = new Map<number, number>();
  private saveQueued = false;
  private lightBases = new Map<number, boolean>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const raw = Number((s.allSettings as Record<string, unknown> | null)?.["torchBurnMinutes"] ?? DEFAULT_BURN_MINUTES);
    const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BURN_MINUTES;
    this.limitMs = minutes * 60000;
    if (!this.limitMs) {
      this.log("[torch] held torches never burn out (torchBurnMinutes 0)");
      return;
    }
    const mp = ctx.svr as Mp;
    chainMpHook(mp, "onUpdateEquipmentAttempt", (actorId: number, equipment: unknown, isAllowed: boolean) => {
      this.onEquipment(mp, Number(actorId) >>> 0, equipment, isAllowed);
    });
    // A switch to another character puts out the torch of the one left behind
    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.douseUser(mp, userId, actorId >>> 0));
    this.log(`[torch] a held torch burns out after ${minutes} min of use`);
  }

  // Character select stops the clock at the request itself, since spawn's guard skips the park event within its grace windows
  customPacket(userId: number, type: string, _content: Content, ctx: SystemContext): void {
    if (type !== "characterSelectMenuRequest") return;
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = Number(mp.getUserActor(userId)) >>> 0; } catch { return; }
    if (actorId) this.goOffline(mp, actorId);
  }

  private goOffline(mp: Mp, actorId: number): void {
    const lit = this.lit.get(actorId);
    if (!lit) return;
    this.douse(actorId, lit, Date.now(), "offline");
    this.save(mp);
  }

  disconnect(userId: number, ctx: SystemContext): void {
    this.douseUser(ctx.svr as Mp, userId);
  }

  // Every torch the user holds but the one on keepActorId
  private douseUser(mp: Mp, userId: number, keepActorId = 0): void {
    const now = Date.now();
    for (const [actorId, lit] of Array.from(this.lit)) {
      if (lit.userId === userId && actorId !== keepActorId) this.douse(actorId, lit, now, "offline");
    }
    this.save(mp);
  }

  // Inside the native hook, so the write waits for the next turn; a refused report keeps the server's equipment
  private onEquipment(mp: Mp, actorId: number, equipment: unknown, isAllowed: boolean): void {
    let worn = equipment;
    if (!isAllowed) {
      try { worn = mp.get(actorId, "equipment"); } catch { return; }
    }
    const baseId = this.heldLight(mp, worn);
    const lit = this.lit.get(actorId);
    const now = Date.now();
    if (lit && baseId) lit.baseId = baseId;
    else if (lit) {
      this.douse(actorId, lit, now, "unequipped");
      this.saveSoon(mp);
    } else if (baseId) this.light(mp, actorId, baseId, now);
  }

  // Base id of the light in hand, 0 when none; only carryable lights can be equipped
  private heldLight(mp: Mp, equipment: unknown): number {
    const entries = (equipment as { inv?: { entries?: unknown } })?.inv?.entries;
    if (!Array.isArray(entries)) return 0;
    for (const e of entries) {
      const baseId = Number(e?.baseId) >>> 0;
      if (baseId && (e.worn || e.wornLeft) && this.isLight(mp, baseId)) return baseId;
    }
    return 0;
  }

  private isLight(mp: Mp, baseId: number): boolean {
    let light = this.lightBases.get(baseId);
    if (light === undefined) {
      light = recordTypeOf(mp, baseId) === "LIGH";
      this.lightBases.set(baseId, light);
    }
    return light;
  }

  // A torch the server inventory lacks is being refused and unequipped, so it does not burn
  private light(mp: Mp, actorId: number, baseId: number, now: number): void {
    const userId = userOf(mp, actorId);
    if (userId < 0 || countItem(mp, actorId, baseId) <= 0) return;
    const burnedMs = this.unsaved.get(actorId) ?? this.stored(mp, actorId);
    this.lit.set(actorId, { userId, baseId, since: now, burnedMs });
    this.burnOuts.set(actorId, now + this.limitMs - burnedMs, () => this.burnOut(mp, actorId));
    this.log(`[torch] ${hex(actorId)} lights ${hex(baseId)}, ${this.minutes(burnedMs)} burned`);
  }

  private douse(actorId: number, lit: Lit, now: number, why: string): void {
    const burnedMs = lit.burnedMs + now - lit.since;
    this.lit.delete(actorId);
    this.burnOuts.clear(actorId);
    this.unsaved.set(actorId, burnedMs);
    this.log(`[torch] ${hex(actorId)} torch ${hex(lit.baseId)} ${why} at ${this.minutes(burnedMs)}`);
  }

  // "4.2 of 15 min"
  private minutes(ms: number): string {
    return `${Math.round(ms / 6000) / 10} of ${this.limitMs / 60000} min`;
  }

  // Unequipped too, since taking one of several copies would leave the hand lit; a body its user left is put out instead
  private burnOut(mp: Mp, actorId: number): void {
    const lit = this.lit.get(actorId);
    if (!lit) return;
    if (userOf(mp, actorId) !== lit.userId) {
      this.goOffline(mp, actorId);
      return;
    }
    this.lit.delete(actorId);
    this.unsaved.set(actorId, 0);
    const held = countItem(mp, actorId, lit.baseId);
    try {
      unequipItemOf(mp, actorId, lit.baseId);
    } catch (e) {
      this.log(`[torch] unequip ${hex(lit.baseId)} of ${hex(actorId)} failed: ${e}`);
    }
    const taken = takeItemFrom(mp, actorId, lit.baseId, 1);
    notifyActor(mp, actorId, "Your torch burns out.");
    this.log(`[torch] ${hex(actorId)} ${describeActor(mp, actorId)}: torch ${hex(lit.baseId)} burned out after ${this.limitMs / 60000} min of use, ${taken ? `${held - 1} left` : "none in the inventory to take"}`);
    this.save(mp);
  }

  private stored(mp: Mp, actorId: number): number {
    try {
      const ms = Number(mp.get(actorId, BURN_PROP));
      return Number.isFinite(ms) && ms > 0 ? ms : 0;
    } catch {
      return 0;
    }
  }

  private save(mp: Mp): void {
    for (const [actorId, ms] of this.unsaved) {
      try {
        mp.set(actorId, BURN_PROP, Math.round(ms));
      } catch (e) {
        this.log(`[torch] saving the burn of ${hex(actorId)} failed: ${e}`);
      }
    }
    this.unsaved.clear();
  }

  private saveSoon(mp: Mp): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    soon(() => {
      this.saveQueued = false;
      this.save(mp);
    });
  }
}
