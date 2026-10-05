import { Settings } from "../settings";
import { System, Log, SystemContext, Content, WORLD_LOADED_EVENT } from "./system";
import { chainMpHook, onlineActors, isCreationPending, hex } from "./actorUtil";
import { espmContainerEntries } from "./formIdUtil";
import { every } from "./timers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Gold watch: samples every online character's gold and flags a rise above the threshold between two samples
// (looting, trades, console spawns and dupes alike) as a goldSpawn alert in the manager's Security tab.
// The first sample of a character only sets its baseline, so logging in rich flags nothing.
// Inventory watch (B14, B24): the same samples log every drop of gold and every drop of Salt Pile the actor's own
// crafts, eats, puts, drops and takes in the interval do not explain, with those tallies and the trade and bounty
// packets seen, so a reported disappearance lands next to its cause or stands out as unexplained.
// A drop of the item the actor just ate is logged, the trace of an eat the client also sent as a drop (G9).
// Every other accepted drop is logged too (K5): the native side logs drops at trace level only, and a drop is the one
// way a player's own client takes items out of the pack without a craft, put, trade or eat line.
// packSummary is the pack as spawn.ts logs it at logout, the grace despawn and login.
//
// server-settings.json keys:
//   goldAlertThreshold  gold gained between two samples that raises an alert, 0 disables the alert; the drop lines stay (default 5000)

const POLL_MS = 10000;
const GOLD_BASE_ID = 0xf;
// Skyrim.esm SaltPile
const SALT_BASE_ID = 0x00034cdf;
const WATCHED: Array<{ baseId: number; label: string }> = [{ baseId: GOLD_BASE_ID, label: "gold" }, { baseId: SALT_BASE_ID, label: "salt" }];
// Packets that move items the hooks never see
const MOVE_PACKETS = new Set(["tradeAccept", "bountyBoardPost"]);
// The false drop arrives right behind the eat's OnEquip
const EAT_DROP_WINDOW_MS = 2000;

// What the hooks saw an actor do with one watched item since the last sample
interface Tally {
  crafts: number;
  eats: number;
  puts: number;
  drops: number;
  takes: number;
}

const emptyTally = (): Tally => ({ crafts: 0, eats: 0, puts: 0, drops: 0, takes: 0 });

// Count per base id of an inventory, gold apart; the items read "<id> x<count>" in id order
export const packSummary = (entries: unknown): { gold: number; items: string[] } => {
  const totals = new Map<number, number>();
  for (const e of Array.isArray(entries) ? entries : []) {
    const baseId = Number(e?.baseId) >>> 0;
    totals.set(baseId, (totals.get(baseId) || 0) + (Number(e?.count) || 0));
  }
  const gold = totals.get(GOLD_BASE_ID) || 0;
  totals.delete(GOLD_BASE_ID);
  const items = Array.from(totals).filter(([, n]) => n > 0).sort(([a], [b]) => a - b).map(([id, n]) => `${hex(id)} x${n}`);
  return { gold, items };
};

export class GoldWatchSystem implements System {
  systemName = "GoldWatchSystem";
  constructor(private log: Log) { }

  private threshold = 5000;
  private masterUrl = "";
  private masterKey = "";
  private authToken = "";
  private mp: Mp = null;
  // actorId -> baseId -> count at the last sample
  private lastCounts = new Map<number, Map<number, number>>();
  // actorId -> baseId -> what explained a change since the last sample
  private tallies = new Map<number, Map<number, Tally>>();
  // actorId -> trade and bounty packets since the last sample
  private packets = new Map<number, string[]>();
  private inputCache = new Map<number, Map<number, number>>();
  // actorId -> the last item the actor ate
  private lastEat = new Map<number, { baseId: number; at: number }>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const threshold = Number(all?.["goldAlertThreshold"]);
    if (Number.isFinite(threshold) && threshold >= 0) this.threshold = threshold;
    this.masterUrl = typeof s.master === "string" ? s.master.replace(/\/+$/, "") : "";
    this.masterKey = typeof s.masterKey === "string" ? s.masterKey : "";
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    this.mp = ctx.svr as Mp;
    // Installed last, so a craft, put, take, drop or eat another system refused is never counted as an explanation
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.installHooks());
    every("goldWatch", POLL_MS, () => this.poll(ctx));
    this.log(`GoldWatchSystem: ${this.threshold ? `alerting on gains above ${this.threshold} gold` : "gain alert disabled (goldAlertThreshold is 0)"}, logging drops of gold, unexplained drops of salt and every item dropped`);
  }

  private installHooks(): void {
    const mp = this.mp;
    const after = (event: string, note: (...args: number[]) => void): void => chainMpHook(mp, event, (...args: unknown[]) => {
      try { note(...args.map((a) => Number(a) >>> 0)); } catch (e) { this.log(`GoldWatchSystem: ${event} note failed: ${e}`); }
    });
    after("onCraft", (actorId, _craftedId, _count, recipeId) => {
      for (const [baseId, count] of this.recipeInputs(recipeId)) this.tally(actorId, baseId).crafts += count;
    });
    after("onEatItem", (actorId, baseId) => {
      this.lastEat.set(actorId, { baseId, at: Date.now() });
      if (this.watched(baseId)) this.tally(actorId, baseId).eats += 1;
    });
    after("onPutItem", (_targetId, actorId, baseId, count) => { if (this.watched(baseId)) this.tally(actorId, baseId).puts += count; });
    after("onTakeItem", (_sourceId, actorId, baseId, count) => { if (this.watched(baseId)) this.tally(actorId, baseId).takes += count; });
    after("onDropItem", (actorId, baseId, count) => {
      this.noteDrop(actorId, baseId, count);
      if (this.watched(baseId)) this.tally(actorId, baseId).drops += count;
    });
  }

  disconnect(userId: number): void {
    const actorId = this.actorOf(userId);
    if (!actorId) return;
    this.lastCounts.delete(actorId);
    this.tallies.delete(actorId);
    this.packets.delete(actorId);
    this.lastEat.delete(actorId);
  }

  customPacket(userId: number, type: string, _content: Content): void {
    if (!MOVE_PACKETS.has(type)) return;
    const actorId = this.actorOf(userId);
    if (!actorId) return;
    const seen = this.packets.get(actorId) || [];
    seen.push(type);
    this.packets.set(actorId, seen);
  }

  poll(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    for (const actorId of onlineActors(mp)) {
      if (isCreationPending(mp, actorId)) continue;
      const counts = this.countsOf(mp, actorId);
      const before = this.lastCounts.get(actorId);
      this.lastCounts.set(actorId, counts);
      const tallies = this.tallies.get(actorId);
      const packets = this.packets.get(actorId) || [];
      this.tallies.delete(actorId);
      this.packets.delete(actorId);
      if (!before) continue;
      for (const { baseId, label } of WATCHED) {
        const was = before.get(baseId) || 0;
        const now = counts.get(baseId) || 0;
        if (now > was) {
          if (baseId === GOLD_BASE_ID && this.threshold && now - was > this.threshold) this.alert(mp, actorId, was, now);
          continue;
        }
        if (now === was) continue;
        const t = tallies?.get(baseId) || emptyTally();
        const explained = t.crafts + t.eats + t.puts + t.drops - t.takes;
        const unexplained = was - now - explained;
        // Every gold drop is logged; salt only when the interval's own actions do not cover it
        if (baseId === SALT_BASE_ID && unexplained <= 0) continue;
        this.log(`[inv] ${this.who(mp, actorId)} ${label} ${was} -> ${now}${unexplained > 0 ? `, ${unexplained} unexplained` : ""} (interval: crafts ${t.crafts}, eats ${t.eats}, puts ${t.puts}, drops ${t.drops}, takes ${t.takes}${packets.length ? `, packets ${packets.join(" ")}` : ""})`);
      }
    }
  }

  private noteDrop(actorId: number, baseId: number, count: number): void {
    const eat = this.lastEat.get(actorId);
    const ms = eat && eat.baseId === baseId ? Date.now() - eat.at : Infinity;
    let edid = "";
    try { edid = String(this.mp.lookupEspmRecordById(baseId)?.record?.editorId || ""); } catch { }
    const item = `${edid || "item"} ${hex(baseId)} x${count}`;
    // The hook runs before the native removal, which still throws when the server holds none
    const held = this.countOf(actorId, baseId);
    setImmediate(() => {
      const who = this.who(this.mp, actorId);
      if (this.countOf(actorId, baseId) >= held) {
        this.log(`[inv] ${who} drop of ${item} refused natively: the server held ${held}${ms <= EAT_DROP_WINDOW_MS ? `, ${ms} ms after eating one` : ""}`);
      } else {
        this.log(ms <= EAT_DROP_WINDOW_MS
          ? `[inv] ${who} drop of ${item} ${ms} ms after eating one: the client sent the eat as a drop too`
          : `[inv] ${who} dropped ${item}`);
      }
    });
  }

  private watched(baseId: number): boolean {
    return WATCHED.some((w) => w.baseId === (baseId >>> 0));
  }

  private tally(actorId: number, baseId: number): Tally {
    let byBase = this.tallies.get(actorId);
    if (!byBase) {
      byBase = new Map();
      this.tallies.set(actorId, byBase);
    }
    let t = byBase.get(baseId);
    if (!t) {
      t = emptyTally();
      byBase.set(baseId, t);
    }
    return t;
  }

  // Watched inputs of a recipe (CNTO), cached: plugins only change with a restart
  private recipeInputs(recipeId: number): Map<number, number> {
    const hit = this.inputCache.get(recipeId);
    if (hit) return hit;
    const out = new Map<number, number>();
    try {
      for (const e of espmContainerEntries(this.mp.lookupEspmRecordById(recipeId))) {
        if (this.watched(e.baseId)) out.set(e.baseId, (out.get(e.baseId) || 0) + e.count);
      }
    } catch { /* not a recipe */ }
    this.inputCache.set(recipeId, out);
    return out;
  }

  private countOf(actorId: number, baseId: number): number {
    let n = 0;
    try {
      for (const e of this.mp.get(actorId, "inventory")?.entries || []) if ((Number(e.baseId) >>> 0) === baseId) n += Number(e.count) || 0;
    } catch { /* actor gone */ }
    return n;
  }

  private countsOf(mp: Mp, actorId: number): Map<number, number> {
    const out = new Map<number, number>();
    try {
      const entries: any[] = mp.get(actorId, "inventory")?.entries || [];
      for (const e of entries) {
        const baseId = Number(e.baseId) >>> 0;
        if (this.watched(baseId)) out.set(baseId, (out.get(baseId) || 0) + (Number(e.count) || 0));
      }
    } catch { /* actor gone */ }
    return out;
  }

  private actorOf(userId: number): number {
    try { return this.mp.getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private who(mp: Mp, actorId: number): string {
    let profileId = -1;
    let name = "";
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { }
    try { name = String(mp.get(actorId, "appearance")?.name || ""); } catch { }
    return `${name || hex(actorId)} (${hex(actorId)}, profile ${profileId})`;
  }

  private alert(mp: Mp, actorId: number, before: number, after: number): void {
    const id = hex(actorId);
    let profileId = -1;
    let name = "";
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { }
    try { name = String(mp.get(actorId, "appearance")?.name || ""); } catch { }
    this.log(`GoldWatchSystem: ${name || id} (profile ${profileId}) went from ${before} to ${after} gold`);
    if (!this.masterUrl || !this.masterKey || !this.authToken) return;
    const at = Date.now();
    fetch(`${this.masterUrl}/api/servers/${this.masterKey}/security-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": this.authToken },
      body: JSON.stringify({ type: "goldSpawn", key: `${id}:${at}`, details: { actorId: id, profileId, name, before, after, gain: after - before, at } }),
    }).catch((e) => this.log(`GoldWatchSystem: alert not delivered: ${e}`));
  }
}
