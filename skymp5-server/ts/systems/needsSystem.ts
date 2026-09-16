import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { addSpellTo, removeSpellFrom, hex } from "./actorUtil";
import { MasterySystem } from "./masterySystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Hunger and crafting fatigue, kept by the server on Survival Mode's scales.
//
// Hunger runs from 0 (full) to 1000 and drains only while the character is online; eating a food carrying a Survival
// hunger effect takes it back down. Its stage (Well Fed to Starving at Survival's thresholds) holds one Survival stage
// ability, whose screen effects AlduinakCreations.esp strips. Death leaves hunger alone and new characters start Satisfied.
// Fatigue is a bar from 0 to 1 that every accepted recipe draws on, by the crafter's rank in the profession owning the
// recipe's bench (Novice outside it), and that refills at a flat rate online and offline. A craft the bar cannot pay
// for is refused before the native craft runs, and the client's local craft is undone by resending its inventory.
// Every decision is made inside the native hooks from memory; writes, Papyrus calls and packets wait for updateAsync.
//
// Wire protocol - CustomPacket JSON:
//   Client -> Server: { customPacketType: "needsRequest" }
//   Server -> Client: { customPacketType: "needsState", hunger, stage, stageName, fatigue, closeCrafting? }
//                     hunger and fatigue are 0-100 (100 = full stomach, rested); closeCrafting closes the Crafting Menu
//                     { customPacketType: "masteryNotice", text }
//
// Persistence: `private.needs` = { v, hunger, fatigue, at, stageSpell } on the character's actor form.
//
// server-settings.json keys (all optional):
//   needsEnabled                  false switches hunger and fatigue off, default true
//   needsHungerDrainPerHour       hunger points per online hour, default 125 (full to starving in about 8 hours)
//   needsHungerOffline            true drains hunger while logged out too, default false
//   needsHungerStart              hunger of a new character, default 145 (Survival's starting value, Satisfied)
//   needsHungerStages             hunger at which stages 1-5 begin, default [80, 160, 340, 520, 770]
//   needsHungerStageAbilities     false grants no Survival stage abilities, default true
//   needsFoodRestore              { VerySmall, Small, Medium, Large, LargeVampire } hunger removed per Survival
//                                 food effect, default 2 / 18 / 220 / 380 / 380
//   needsFatigueCraftsPerHour     crafts one full bar pays for by rank [Novice, Adept, Expert, Master], default [6, 12, 18, 24]
//   needsFatigueRegenPerMinute    bar fraction refilled per minute, default 0.016
//   needsFatigueOfflineRegen      false refills only while online, default true
//   needsFatigueFreeKeywords      bench keywords whose recipes cost nothing, default ["AldCraftingMead"]

const NEEDS_PROP = "private.needs";
const STATE_PACKET = "needsState";
const REQUEST_PACKET = "needsRequest";
const NOTICE_PACKET = "masteryNotice";

const HUNGER_MAX = 1000;
const POLL_MS = 1000;
const TICK_MS = 60000;
// The client wipes and re-applies learnedSpells about a second after spawn; a stage ability change has to land after that
const LOGIN_SYNC_DELAY_MS = 5000;
const NOTICE_GAP_MS = 2000;
const MAX_QUEUED = 4096;
const EPSILON = 1e-6;

const STAGE_NAMES = ["Well Fed", "Satisfied", "Peckish", "Hungry", "Famished", "Starving"];
const STAGE_SPELLS = STAGE_NAMES.map((_, i) => `Survival_HungerStage${i}`);
const FOOD_EFFECTS: Record<string, string> = {
  VerySmall: "Survival_FoodRestoreHungerVerySmall",
  Small: "Survival_FoodRestoreHungerSmall",
  Medium: "Survival_FoodRestoreHungerMedium",
  Large: "Survival_FoodRestoreHungerLarge",
  LargeVampire: "Survival_FoodRestoreHungerLargeVampire",
};
const DEFAULT_FOOD_RESTORE: Record<string, number> = { VerySmall: 2, Small: 18, Medium: 220, Large: 380, LargeVampire: 380 };
const DEFAULT_STAGES = [80, 160, 340, 520, 770];
// Survival_HungerNeedValue, the hunger Survival Mode starts a new game with
const DEFAULT_HUNGER_START = 145;
const DEFAULT_CRAFTS_PER_HOUR = [6, 12, 18, 24];

interface NeedsRecord {
  v: number;
  hunger: number;
  fatigue: number;
  // Epoch ms the values above were last brought up to date
  at: number;
  // Stage ability this character holds, 0 for none
  stageSpell: number;
}

interface Online {
  userId: number;
  rec: NeedsRecord;
  // Last state sent to the client, so the minute tick only sends changes
  sent: string;
  syncStageAt: number;
}

type Queued =
  | { kind: "refused"; actorId: number; cost: number }
  | { kind: "tired"; actorId: number; cost: number }
  | { kind: "changed"; actorId: number };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): number => Math.round(v * 100);
const numberList = (v: unknown, length: number): number[] | null =>
  Array.isArray(v) && v.length === length && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : null;

export class NeedsSystem implements System {
  systemName = "NeedsSystem";

  constructor(private log: Log, private mastery: MasterySystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = (s.allSettings || {}) as Record<string, unknown>;
    this.enabled = all["needsEnabled"] !== false;
    const num = (key: string, fallback: number, min = 0): number => {
      const v = Number(all[key]);
      return all[key] !== undefined && Number.isFinite(v) && v >= min ? v : fallback;
    };
    this.drainPerHour = num("needsHungerDrainPerHour", 125);
    this.hungerOffline = all["needsHungerOffline"] === true;
    this.hungerStart = clamp(num("needsHungerStart", DEFAULT_HUNGER_START), 0, HUNGER_MAX);
    this.stages = numberList(all["needsHungerStages"], DEFAULT_STAGES.length) || DEFAULT_STAGES.slice();
    this.stageAbilities = all["needsHungerStageAbilities"] !== false;
    const restore = all["needsFoodRestore"] && typeof all["needsFoodRestore"] === "object" ? all["needsFoodRestore"] as Record<string, unknown> : {};
    for (const size of Object.keys(DEFAULT_FOOD_RESTORE)) {
      const v = Number(restore[size]);
      this.foodRestore[size] = restore[size] !== undefined && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FOOD_RESTORE[size];
    }
    const crafts = numberList(all["needsFatigueCraftsPerHour"], DEFAULT_CRAFTS_PER_HOUR.length);
    this.craftsPerHour = crafts && crafts.every((c) => c > 0) ? crafts : DEFAULT_CRAFTS_PER_HOUR.slice();
    this.regenPerMinute = num("needsFatigueRegenPerMinute", 0.016);
    this.fatigueOffline = all["needsFatigueOfflineRegen"] !== false;
    const free = Array.isArray(all["needsFatigueFreeKeywords"]) ? (all["needsFatigueFreeKeywords"] as unknown[]).filter((k) => typeof k === "string") as string[] : ["AldCraftingMead"];

    if (!this.enabled) {
      this.log("[needs] disabled by needsEnabled");
      return;
    }
    await this.resolveForms(ctx, free, s.dataDir, s.loadOrder);
    this.log(`[needs] ready, hunger ${this.drainPerHour}/h online${this.hungerOffline ? " and offline" : ""}, stages at ${this.stages.join("/")}, food ${Object.entries(this.foodRestore).map(([k, v]) => `${k} ${v}`).join(", ")}; fatigue ${this.craftsPerHour.join("/")} crafts per bar by rank, +${(this.regenPerMinute * 100).toFixed(1)}% per minute${this.fatigueOffline ? " also offline" : ""}, ${this.freeBenches.size} free bench keyword(s)`);

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));
    this.installHooks(ctx);
  }

  private async resolveForms(ctx: SystemContext, freeKeywords: string[], dataDir: string, loadOrder: string[]): Promise<void> {
    const mp = ctx.svr as Mp;
    const idOf = (scan: { resolved: Map<string, string> }, edid: string): number => {
      const desc = scan.resolved.get(edid.toLowerCase());
      try { return desc ? mp.getIdFromDesc(desc) >>> 0 : 0; } catch { return 0; }
    };
    const effects = await resolveEditorIds(Object.values(FOOD_EFFECTS), dataDir, loadOrder, this.log, ["MGEF"]);
    for (const [size, edid] of Object.entries(FOOD_EFFECTS)) {
      const id = idOf(effects, edid);
      if (id) this.foodEffects.set(id, size);
    }
    const spells = await resolveEditorIds(STAGE_SPELLS, dataDir, loadOrder, this.log, ["SPEL"]);
    this.stageSpells = STAGE_SPELLS.map((edid) => idOf(spells, edid));
    const keywords = await resolveEditorIds(freeKeywords, dataDir, loadOrder, this.log, ["KYWD"]);
    for (const edid of freeKeywords) {
      const id = idOf(keywords, edid);
      if (id) this.freeBenches.add(id);
    }
    const found = new Set(this.foodEffects.values());
    const missing = [...Object.keys(FOOD_EFFECTS).filter((size) => !found.has(size)).map((size) => FOOD_EFFECTS[size]),
      ...STAGE_SPELLS.filter((_, i) => !this.stageSpells[i]), ...freeKeywords.filter((k) => !keywords.resolved.has(k.toLowerCase()))];
    if (missing.length) this.log(`[needs] not in the load order, ignored: ${missing.join(", ")}`);
  }

  // ── Native hooks: decide from memory, never write here ────────────────────

  private installHooks(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previousCraft = typeof mp.onCraft === "function" ? mp.onCraft : null;
    mp.onCraft = (...args: unknown[]) => {
      const verdict = previousCraft ? previousCraft.apply(mp, args) : undefined;
      if (verdict === false) return false;
      try {
        if (!this.chargeCraft(ctx, Number(args[0]) >>> 0, Number(args[3]) >>> 0)) return false;
      } catch (e) {
        this.log(`[needs] craft check failed: ${e}`);
      }
      return verdict;
    };

    const previousActivate = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      try {
        if (this.tooTiredForBench(ctx, targetId >>> 0, casterId >>> 0)) return false;
      } catch (e) {
        this.log(`[needs] bench check failed: ${e}`);
      }
      return previousActivate ? previousActivate.call(mp, targetId, casterId) : true;
    };

    const previousEat = typeof mp.onEatItem === "function" ? mp.onEatItem : null;
    mp.onEatItem = (...args: unknown[]) => {
      const verdict = previousEat ? previousEat.apply(mp, args) : undefined;
      try {
        if (verdict !== false) this.eat(ctx, Number(args[0]) >>> 0, Number(args[1]) >>> 0);
      } catch (e) {
        this.log(`[needs] food check failed: ${e}`);
      }
      return verdict;
    };
  }

  // False refuses the craft; crafts without the inputs in the bag are left to the native side uncharged
  private chargeCraft(ctx: SystemContext, actorId: number, recipeId: number): boolean {
    const entry = this.online.get(actorId);
    if (!entry || !this.mastery.holdsInputs(ctx, actorId, recipeId)) return true;
    const bench = this.mastery.recipeBench(ctx, recipeId);
    if (this.freeBenches.has(bench)) return true;
    const cost = this.craftCost(ctx, actorId, bench);
    this.advance(entry.rec, Date.now(), true);
    if (entry.rec.fatigue + EPSILON < cost) {
      this.enqueue({ kind: "refused", actorId, cost });
      return false;
    }
    entry.rec.fatigue = clamp(entry.rec.fatigue - cost, 0, 1);
    this.enqueue({ kind: "changed", actorId });
    return true;
  }

  // A bench the character cannot pay one recipe at never opens its menu
  private tooTiredForBench(ctx: SystemContext, refrId: number, actorId: number): boolean {
    const entry = this.online.get(actorId);
    if (!entry) return false;
    const keywords = this.mastery.stationKeywords(ctx, refrId);
    if (!keywords.size || Array.from(keywords).some((k) => this.freeBenches.has(k))) return false;
    const bench = Array.from(keywords).filter((k) => this.mastery.professionOfBench(k))[0];
    if (!bench) return false;
    const cost = this.craftCost(ctx, actorId, bench);
    this.advance(entry.rec, Date.now(), true);
    if (entry.rec.fatigue + EPSILON >= cost) return false;
    this.enqueue({ kind: "tired", actorId, cost });
    return true;
  }

  private eat(ctx: SystemContext, actorId: number, baseId: number): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    let restore = 0;
    for (const effect of this.foodEffectsOf(ctx, baseId)) restore = Math.max(restore, this.foodRestore[effect] || 0);
    if (!restore) return;
    this.advance(entry.rec, Date.now(), true);
    entry.rec.hunger = clamp(entry.rec.hunger - restore, 0, HUNGER_MAX);
    this.enqueue({ kind: "changed", actorId });
  }

  private enqueue(q: Queued): void {
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(q);
  }

  // ── Online bookkeeping ─────────────────────────────────────────────────────

  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    for (const [otherActor, entry] of Array.from(this.online.entries())) {
      if (entry.userId === userId && otherActor !== actorId) this.goOffline(ctx, otherActor);
    }
    if (!this.isPlayerCharacter(ctx, actorId)) return;
    const now = Date.now();
    const stored = this.read(ctx, actorId);
    const rec = stored || { v: 1, hunger: this.hungerStart, fatigue: 1, at: now, stageSpell: 0 };
    if (stored) this.advance(rec, now, false);
    this.online.set(actorId, { userId, rec, sent: "", syncStageAt: now + LOGIN_SYNC_DELAY_MS });
    this.write(ctx, actorId, rec);
    this.sendState(ctx, actorId, false);
  }

  disconnect(userId: number, ctx: SystemContext): void {
    for (const [actorId, entry] of Array.from(this.online.entries())) {
      if (entry.userId === userId) this.goOffline(ctx, actorId);
    }
    this.lastNoticeAt.delete(userId);
  }

  private goOffline(ctx: SystemContext, actorId: number): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    this.advance(entry.rec, Date.now(), true);
    this.write(ctx, actorId, entry.rec);
    this.online.delete(actorId);
  }

  customPacket(userId: number, type: string, _content: Content, ctx: SystemContext): void {
    if (type !== REQUEST_PACKET || !this.enabled) return;
    for (const [actorId, entry] of this.online) {
      if (entry.userId === userId) this.sendState(ctx, actorId, false, true);
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.enabled) return;
    for (const q of this.queue.splice(0, this.queue.length)) {
      try {
        this.handle(ctx, q);
      } catch (e) {
        this.log(`[needs] ${q.kind} for ${hex(q.actorId)} failed: ${e}`);
      }
    }
    const now = Date.now();
    const tick = now >= this.nextTickAt;
    if (tick) this.nextTickAt = now + TICK_MS;
    for (const [actorId, entry] of Array.from(this.online.entries())) {
      try {
        if (tick) {
          if (!this.stillPlaying(ctx, entry.userId, actorId)) {
            this.goOffline(ctx, actorId);
            continue;
          }
          this.advance(entry.rec, now, true);
          this.write(ctx, actorId, entry.rec);
          this.syncStage(ctx, actorId, entry);
          this.sendState(ctx, actorId, false);
        } else if (entry.syncStageAt && now >= entry.syncStageAt) {
          entry.syncStageAt = 0;
          this.syncStage(ctx, actorId, entry);
        }
      } catch (e) {
        this.log(`[needs] update for ${hex(actorId)} failed: ${e}`);
      }
    }
  }

  private handle(ctx: SystemContext, q: Queued): void {
    const entry = this.online.get(q.actorId);
    if (!entry) return;
    const mp = ctx.svr as Mp;
    this.write(ctx, q.actorId, entry.rec);
    if (q.kind === "changed") {
      this.syncStage(ctx, q.actorId, entry);
      this.sendState(ctx, q.actorId, false);
      return;
    }
    if (q.kind === "refused") {
      // Closed first: the resent inventory undoes the recipe the vanilla menu already made locally
      this.sendState(ctx, q.actorId, true);
      mp.set(q.actorId, "inventory", mp.get(q.actorId, "inventory"));
    } else {
      this.sendState(ctx, q.actorId, false);
    }
    const now = Date.now();
    if (now - (this.lastNoticeAt.get(entry.userId) || 0) < NOTICE_GAP_MS) return;
    this.lastNoticeAt.set(entry.userId, now);
    const minutes = Math.max(1, Math.ceil((q.cost - entry.rec.fatigue) / Math.max(this.regenPerMinute, EPSILON)));
    this.notice(ctx, entry.userId, `You are too tired to craft: fatigue ${pct(entry.rec.fatigue)}%, this work needs ${pct(q.cost)}%. Rest about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
  }

  // ── Rules ──────────────────────────────────────────────────────────────────

  private advance(rec: NeedsRecord, now: number, online: boolean): void {
    const ms = Math.max(0, now - rec.at);
    if (online || this.hungerOffline) rec.hunger = clamp(rec.hunger + this.drainPerHour * ms / 3600000, 0, HUNGER_MAX);
    if (online || this.fatigueOffline) rec.fatigue = clamp(rec.fatigue + this.regenPerMinute * ms / 60000, 0, 1);
    rec.at = Math.max(rec.at, now);
  }

  private craftCost(ctx: SystemContext, actorId: number, bench: number): number {
    const profession = this.mastery.professionOfBench(bench);
    const rank = profession ? Math.max(0, this.mastery.rankOf(ctx, actorId, profession)) : 0;
    return 1 / this.craftsPerHour[Math.min(rank, this.craftsPerHour.length - 1)];
  }

  private stageOf(hunger: number): number {
    return this.stages.filter((threshold) => hunger >= threshold).length;
  }

  // Survival hunger effects of an ALCH or INGR, cached; plugins only change with a restart
  private foodEffectsOf(ctx: SystemContext, baseId: number): string[] {
    const hit = this.foodCache.get(baseId);
    if (hit) return hit;
    let res: any = null;
    try { res = (ctx.svr as Mp).lookupEspmRecordById(baseId); } catch { /* unknown form */ }
    const type = res && res.record ? String(res.record.type) : "";
    const sizes = type === "ALCH" || type === "INGR"
      ? espmFieldFormIds(res, "EFID").map((id) => this.foodEffects.get(id)).filter((size): size is string => !!size)
      : [];
    this.foodCache.set(baseId, sizes);
    return sizes;
  }

  private syncStage(ctx: SystemContext, actorId: number, entry: Online): void {
    const stage = this.stageOf(entry.rec.hunger);
    const want = this.stageAbilities ? this.stageSpells[stage] || 0 : 0;
    if (entry.rec.stageSpell === want || (entry.syncStageAt && Date.now() < entry.syncStageAt)) return;
    const mp = ctx.svr as Mp;
    const before = this.stageSpells.indexOf(entry.rec.stageSpell);
    try {
      if (entry.rec.stageSpell) removeSpellFrom(mp, actorId, entry.rec.stageSpell);
      if (want) addSpellTo(mp, actorId, want);
    } catch (e) {
      this.log(`[needs] stage ability swap failed for ${hex(actorId)}: ${e}`);
      return;
    }
    entry.rec.stageSpell = want;
    this.write(ctx, actorId, entry.rec);
    if (before >= 0 && stage > before && stage >= 2) this.notice(ctx, entry.userId, `You are ${STAGE_NAMES[stage].toLowerCase()}. Find something to eat.`);
  }

  private sendState(ctx: SystemContext, actorId: number, closeCrafting: boolean, force = false): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    const stage = this.stageOf(entry.rec.hunger);
    const payload = {
      customPacketType: STATE_PACKET,
      hunger: Math.round(100 - entry.rec.hunger * 100 / HUNGER_MAX),
      stage,
      stageName: STAGE_NAMES[stage],
      fatigue: pct(entry.rec.fatigue),
    };
    const key = JSON.stringify(payload);
    if (!closeCrafting && !force && key === entry.sent) return;
    entry.sent = key;
    try {
      (ctx.svr as Mp).sendCustomPacket(entry.userId, JSON.stringify(closeCrafting ? { ...payload, closeCrafting: true } : payload));
    } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify({ customPacketType: NOTICE_PACKET, text })); } catch { /* user gone */ }
  }

  private stillPlaying(ctx: SystemContext, userId: number, actorId: number): boolean {
    const mp = ctx.svr as Mp;
    try { return mp.isConnected(userId) && (mp.getUserActor(userId) >>> 0) === actorId; } catch { return false; }
  }

  private isPlayerCharacter(ctx: SystemContext, actorId: number): boolean {
    try { return !!actorId && Number((ctx.svr as Mp).get(actorId, "profileId")) >= 0; } catch { return false; }
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  private read(ctx: SystemContext, actorId: number): NeedsRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, NEEDS_PROP);
      if (!raw || typeof raw !== "object") return null;
      const at = Number(raw.at);
      return {
        v: 1,
        hunger: clamp(Number(raw.hunger) || 0, 0, HUNGER_MAX),
        fatigue: raw.fatigue === undefined ? 1 : clamp(Number(raw.fatigue) || 0, 0, 1),
        at: Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now(),
        stageSpell: Number(raw.stageSpell) >>> 0,
      };
    } catch {
      return null;
    }
  }

  private write(ctx: SystemContext, actorId: number, rec: NeedsRecord): void {
    try {
      (ctx.svr as Mp).set(actorId, NEEDS_PROP, rec);
    } catch (e) {
      this.log(`[needs] write failed for ${hex(actorId)}: ${e}`);
    }
  }

  private enabled = true;
  private drainPerHour = 125;
  private hungerOffline = false;
  private hungerStart = DEFAULT_HUNGER_START;
  private stages = DEFAULT_STAGES.slice();
  private stageAbilities = true;
  private foodRestore: Record<string, number> = {};
  private craftsPerHour = DEFAULT_CRAFTS_PER_HOUR.slice();
  private regenPerMinute = 0.016;
  private fatigueOffline = true;

  private foodEffects = new Map<number, string>();
  private stageSpells: number[] = [];
  private freeBenches = new Set<number>();
  private foodCache = new Map<number, string[]>();
  private online = new Map<number, Online>();
  private queue: Queued[] = [];
  private lastNoticeAt = new Map<number, number>();
  private nextTickAt = 0;
}
