import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT, CREATION_FINISHED_EVENT } from "./system";
import { isEditorId, resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { ActorValue, SpellType, abilityResist, fieldData, hasCureDisease, learnedSpells, potionHealing, spellInfo, view } from "./espmMagic";
import { baseIdOf, chainMpHook, hex, isCreationPending, removeSpellFrom, userOf } from "./actorUtil";
import { sendJson } from "./playerText";
import { NeedsModifierSource } from "./needsSystem";
import { RacialSystem } from "./racialSystem";
import { HuntingSystem } from "./huntingSystem";
import { WeatherSystem } from "./weatherSystem";
import { AbilityGroup, LOAD_PACKETS, StageAbilityTracker } from "./stageAbilities";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Survival: the server keeps every Survival Mode rule (no Survival Papyrus runs on a client). This part holds the body rules, raw meat food
// poisoning, the cure and the shrines; cold, afflictions and diseases build on it.
//
// Body rules, at each login once the client's load settled and at creation finish: respawnPercentages.health = survivalRespawnHealth
// (the native respawn wakes the character at 1%), and the abilities Survival_abLowerCarryWeightSpell (carry weight 300 -> 150),
// AldSurvival_AbNoHealthRegen (no health regeneration on the client) and AldSurvival_FreezingWaterDamage (freezing water damage while
// swimming, inert until the client sets AldSurvival_FreezingArea) through the StageAbilityTracker, each with its own switch; a record the
// plugin lacks is skipped with a log line. With survivalEnabled false, or a switch off, what an earlier session granted is undone at login.
// Raw meat (Survival_FoodRawMeat, HuntingSystem's meats, survivalRawMeatExtra) gives Survival_DiseaseFoodPoisoning at
// survivalFoodPoisoningChance x (1 - disease resist / 100) for survivalFoodPoisoningHours of wall clock, never to a race whose
// racialPassives entry is rawMeatSafe and never twice at once.
// Cure: a Cure Disease potion, or with survivalCure "cureDiseaseOrHealth" a potion restoring survivalCureMinHealth health or more, clears
// food poisoning and the three affliction abilities; a healing potion also removes every Disease spell, which the native cure only does
// for the Cure Disease effect. Shrines (Survival_BlessingAltars) cure nothing and say so, once a minute per player.
//
// Wire protocol - CustomPacket JSON:
//   Client -> Server: needsRequest, weatherRequest, gameTimeRequest and survivalRequest each schedule the login re-send of changed abilities
//   Server -> Client: { customPacketType: "masteryNotice", text }
//
// Persistence: private.survival = { v, at, body: { spells: [desc], respawn }, foodPoisonUntil, foodPoisonSpell: desc } on the character's
// actor form; spells are stored as "id:Plugin" descs, never raw form ids.
//
// server-settings.json keys (all optional):
//   survivalEnabled               true runs survival, default false; one of the manager's PROTECTED_SETTINGS, so Migrate settings leaves it
//   survivalRespawnHealth         health share a respawn wakes with, in (0, 1], default 0.01; 1 turns the rule off
//   survivalCarryWeightSpell      editor id or desc of the carry weight ability, default "Survival_abLowerCarryWeightSpell"; "" turns it off
//   survivalNoHealthRegen         false grants no AldSurvival_AbNoHealthRegen, default true
//   survivalFreezingWater         false grants no AldSurvival_FreezingWaterDamage, default true
//   survivalFoodPoisoningChance   chance raw meat poisons before disease resistance, 0 to 1, default 0.5; 0 turns it off
//   survivalFoodPoisoningHours    real hours food poisoning lasts, offline included, default 24
//   survivalRawMeatExtra          editor ids, hex ids or descs of more raw meat, default []
//   survivalCure                  "cureDiseaseOrHealth" (default) or "cureDisease" (Cure Disease potions only)
//   survivalCureMinHealth         health a potion must restore to cure under cureDiseaseOrHealth, default 25

const SURVIVAL_PROP = "private.survival";
const NOTICE_PACKET = "masteryNotice";
const REQUEST_PACKET = "survivalRequest";
const NEEDS_REQUEST_PACKET = "needsRequest";
const POLL_MS = 1000;
const TICK_MS = 60000;
const SHRINE_NOTICE_GAP_MS = 60000;
const HOUR_MS = 3600000;
const EPSILON = 1e-4;

const DEFAULT_RESPAWN_HEALTH = 0.01;
const DEFAULT_CARRY_SPELL = "Survival_abLowerCarryWeightSpell";
const NO_REGEN_SPELL = "AldSurvival_AbNoHealthRegen";
const FREEZING_WATER_SPELL = "AldSurvival_FreezingWaterDamage";
const DEFAULT_POISON_CHANCE = 0.5;
const DEFAULT_POISON_HOURS = 24;
const DEFAULT_CURE_MIN_HEALTH = 25;
const FOOD_POISONING_SPELL = "Survival_DiseaseFoodPoisoning";
const AFFLICTION_SPELLS = ["Survival_AfflictionWeakened", "Survival_AfflictionAddled", "Survival_AfflictionFrostbitten"];
const RAW_MEAT_LIST = "Survival_FoodRawMeat";
const ALTAR_LIST = "Survival_BlessingAltars";
// ALCH ENIT flags at offset 4
const ENIT_FOOD = 0x2;
const ENIT_POISON = 0x20000;

export type CureMode = "cureDisease" | "cureDiseaseOrHealth";
const CURE_MODES: CureMode[] = ["cureDisease", "cureDiseaseOrHealth"];

// Emitted on SystemContext.gm (actorId, by, done(ok)) by the admin panel: an online character loses food poisoning and gets its body rules again
export const SURVIVAL_RESET_EVENT = "survivalReset";

type BodyKey = "carry" | "regen" | "water";

interface BodySpell {
  key: BodyKey;
  label: string;
  // Editor id or desc named by the settings, "" when switched off
  name: string;
  id: number;
}

interface SurvivalRecord {
  v: number;
  at: number;
  // What the body rules granted: ability descs and the respawn health share set
  body: { spells: string[]; respawn: number };
  // Epoch ms food poisoning runs out, 0 when not poisoned, and the desc of the spell granted for it
  foodPoisonUntil: number;
  foodPoisonSpell: string;
}

interface Online {
  actorId: number;
  userId: number;
  rec: SurvivalRecord;
  // The body rules wait for the login delay, or for a pending creation to finish
  bodyDue: boolean;
  // Spells removed this session, replayed as not held by the login re-send
  revoked: number[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
const emptyRecord = (): SurvivalRecord => ({ v: 1, at: Date.now(), body: { spells: [], respawn: 1 }, foodPoisonUntil: 0, foodPoisonSpell: "" });

export class SurvivalSystem implements System, NeedsModifierSource {
  systemName = "SurvivalSystem";
  label = "survival";

  // weather feeds the cold core
  constructor(private log: Log, private racial: RacialSystem, private hunting: HuntingSystem, private weather: WeatherSystem) {
    this.abilities = new StageAbilityTracker("survival", log);
  }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const { problems, extraMeat } = this.configure((s.allSettings || {}) as Record<string, unknown>);
    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));
    if (!this.enabled) {
      this.log(`[survival] off (survivalEnabled false): no survival rule runs; the body abilities, the respawn health and food poisoning an earlier session granted are undone at each character's login${problems.length ? `; ignored: ${problems.join("; ")}` : ""}`);
      return;
    }
    const counts = await this.resolveForms(ctx, extraMeat, s.dataDir, s.loadOrder, problems);
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => this.onCreationFinished(actorId >>> 0));
    ctx.gm.on(SURVIVAL_RESET_EVENT, (actorId: number, by: string, done?: (ok: boolean) => void) => done?.(this.resetBy(ctx, actorId >>> 0, by)));
    this.installHooks(ctx);
    const bodyLine = this.body.map((b) => `${b.label} ${!b.name ? "off" : b.id ? `${b.name} (${hex(b.id)})` : `${b.name} not in the load order, skipped`}`).join(", ");
    const cureLine = this.cureMode === "cureDiseaseOrHealth" ? `Cure Disease potions and potions restoring ${this.cureMinHealth}+ health (those also remove every Disease spell)` : "Cure Disease potions only";
    this.log(`[survival] ready: body rules respawn health ${pct(this.respawnHealth)}, ${bodyLine}; raw meat ${this.rawMeat.size} foods (${counts.list} ${RAW_MEAT_LIST}, ${counts.hunting} hunting, ${counts.extra} extra), food poisoning ${pct(this.poisonChance)} x (1 - disease resist) for ${this.poisonMs / HOUR_MS} h ${this.foodPoison ? `(${hex(this.foodPoison)})` : "(spell not in the load order, never given)"}, races safe from raw meat per racialPassives rawMeatSafe; cure by ${cureLine}, clearing food poisoning and ${this.afflictions.length} affliction abilities; shrines ${this.altars.size} altar bases, no cure, a notice at most once a minute`);
    if (problems.length) this.log(`[survival] settings ignored: ${problems.join("; ")}`);
  }

  // Reads the survival keys; returns the ignored values and the extra raw meat names
  configure(all: Record<string, unknown>): { problems: string[]; extraMeat: string[] } {
    const problems: string[] = [];
    const num = (key: string, fallback: number, ok: (v: number) => boolean): number => {
      if (all[key] === undefined) return fallback;
      const v = Number(all[key]);
      if (Number.isFinite(v) && ok(v)) return v;
      problems.push(`${key} ${JSON.stringify(all[key])} is out of range, ${fallback} is used`);
      return fallback;
    };
    this.enabled = all["survivalEnabled"] === true;
    this.respawnHealth = num("survivalRespawnHealth", DEFAULT_RESPAWN_HEALTH, (v) => v > 0 && v <= 1);
    this.poisonChance = num("survivalFoodPoisoningChance", DEFAULT_POISON_CHANCE, (v) => v >= 0 && v <= 1);
    this.poisonMs = num("survivalFoodPoisoningHours", DEFAULT_POISON_HOURS, (v) => v > 0) * HOUR_MS;
    this.cureMinHealth = num("survivalCureMinHealth", DEFAULT_CURE_MIN_HEALTH, (v) => v >= 0);
    const cure = all["survivalCure"];
    if (cure !== undefined && CURE_MODES.indexOf(cure as CureMode) === -1) problems.push(`survivalCure ${JSON.stringify(cure)} is not ${CURE_MODES.join(" or ")}, cureDiseaseOrHealth is used`);
    this.cureMode = CURE_MODES.indexOf(cure as CureMode) !== -1 ? cure as CureMode : "cureDiseaseOrHealth";
    const carry = all["survivalCarryWeightSpell"];
    if (carry !== undefined && typeof carry !== "string") problems.push(`survivalCarryWeightSpell ${JSON.stringify(carry)} is not a string, ${DEFAULT_CARRY_SPELL} is used`);
    this.body = [
      { key: "carry", label: "carry weight", name: typeof carry === "string" ? carry.trim() : DEFAULT_CARRY_SPELL, id: 0 },
      { key: "regen", label: "no regen", name: all["survivalNoHealthRegen"] !== false ? NO_REGEN_SPELL : "", id: 0 },
      { key: "water", label: "freezing water", name: all["survivalFreezingWater"] !== false ? FREEZING_WATER_SPELL : "", id: 0 },
    ];
    const extra = all["survivalRawMeatExtra"];
    if (extra !== undefined && !(Array.isArray(extra) && extra.every((x) => typeof x === "string"))) problems.push("survivalRawMeatExtra is not a list of strings, none are added");
    const extraMeat = Array.isArray(extra) ? extra.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
    return { problems, extraMeat };
  }

  // Body spells, food poisoning, afflictions, raw meat and altars; returns the raw meat counts by source
  private async resolveForms(ctx: SystemContext, extraMeat: string[], dataDir: string, loadOrder: string[], problems: string[]): Promise<{ list: number; hunting: number; extra: number }> {
    const mp = ctx.svr as Mp;
    const names = [...this.body.map((b) => b.name).filter((n) => n && isEditorId(n)), FOOD_POISONING_SPELL, ...AFFLICTION_SPELLS, RAW_MEAT_LIST, ALTAR_LIST, ...extraMeat.filter(isEditorId)];
    const scan = await resolveEditorIds(names, dataDir, loadOrder, this.log, ["SPEL", "FLST", "ALCH", "INGR"]);
    const idOf = (name: string): number => {
      try {
        if (name.includes(":")) return mp.getIdFromDesc(name) >>> 0;
        if (!isEditorId(name)) return parseInt(name, 16) >>> 0;
        const desc = scan.resolved.get(name.toLowerCase());
        return desc ? mp.getIdFromDesc(desc) >>> 0 : 0;
      } catch {
        return 0;
      }
    };
    const lookup = (id: number): any => { try { return id ? mp.lookupEspmRecordById(id) : null; } catch { return null; } };
    for (const b of this.body) b.id = b.name ? idOf(b.name) : 0;
    this.foodPoison = idOf(FOOD_POISONING_SPELL);
    this.afflictions = AFFLICTION_SPELLS.map(idOf).filter((id) => id);
    const listed = espmFieldFormIds(lookup(idOf(RAW_MEAT_LIST)), "LNAM");
    const hunted = this.hunting.rawMeatIds();
    const extra = extraMeat.map(idOf);
    extraMeat.forEach((name, i) => { if (!extra[i]) problems.push(`survivalRawMeatExtra ${name} is not in the load order`); });
    this.rawMeat = new Set([...listed, ...hunted, ...extra.filter((id) => id)]);
    this.altars = new Set(espmFieldFormIds(lookup(idOf(ALTAR_LIST)), "LNAM"));
    const missing = [FOOD_POISONING_SPELL, ...AFFLICTION_SPELLS, RAW_MEAT_LIST, ALTAR_LIST].filter((n) => !idOf(n));
    if (missing.length) this.log(`[survival] not in the load order, ignored: ${missing.join(", ")}`);
    return { list: listed.length, hunting: hunted.length, extra: extra.filter((id) => id).length };
  }

  // ── Native hooks: decide from memory, never write here ────────────────────

  private installHooks(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previousEat = typeof mp.onEatItem === "function" ? mp.onEatItem : null;
    mp.onEatItem = (...args: unknown[]) => {
      const verdict = previousEat ? previousEat.apply(mp, args) : undefined;
      try {
        if (verdict !== false) this.onEat(ctx, Number(args[0]) >>> 0, Number(args[1]) >>> 0);
      } catch (e) {
        this.log(`[survival] food check failed: ${e}`);
      }
      return verdict;
    };
    chainMpHook(mp, "onActivate", (targetId: number, casterId: number) => {
      if (this.online.has(casterId >>> 0) && this.altars.has(baseIdOf(mp, targetId >>> 0))) setImmediate(() => this.shrineNotice(ctx, casterId >>> 0, targetId >>> 0));
    });
  }

  private onEat(ctx: SystemContext, actorId: number, baseId: number): void {
    if (!this.online.has(actorId)) return;
    const mp = ctx.svr as Mp;
    if (this.rawMeat.has(baseId)) setImmediate(() => this.rollFoodPoisoning(ctx, actorId, baseId));
    const cure = this.cureKindOf(mp, baseId);
    if (cure) setImmediate(() => this.cure(ctx, actorId, baseId, cure));
  }

  // A Cure Disease item, or under cureDiseaseOrHealth a potion (not a food or poison) restoring cureMinHealth or more; "" otherwise
  private cureKindOf(mp: Mp, baseId: number): "cureDisease" | "health" | "" {
    if (hasCureDisease(mp, baseId)) return "cureDisease";
    if (this.cureMode !== "cureDiseaseOrHealth" || potionHealing(mp, baseId) < this.cureMinHealth) return "";
    let enit: Uint8Array | null = null;
    try { enit = fieldData(mp.lookupEspmRecordById(baseId), "ENIT"); } catch { enit = null; }
    const flags = enit && enit.byteLength >= 8 ? view(enit).getUint32(4, true) : 0;
    return flags & (ENIT_FOOD | ENIT_POISON) ? "" : "health";
  }

  // ── Online bookkeeping ─────────────────────────────────────────────────────

  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    for (const [otherActor, entry] of Array.from(this.online.entries())) {
      if (entry.userId === userId && otherActor !== actorId) this.goOffline(ctx, otherActor);
    }
    const mp = ctx.svr as Mp;
    if (!this.isPlayerCharacter(mp, actorId)) return;
    const stored = this.read(mp, actorId);
    // Off: only a character with something to undo is followed
    if (!this.enabled && !(stored && (stored.body.spells.length || stored.body.respawn < 1 || stored.foodPoisonUntil))) return;
    this.online.set(actorId, { actorId, userId, rec: stored || emptyRecord(), bodyDue: !isCreationPending(mp, actorId), revoked: [] });
    this.abilities.begin(actorId);
  }

  private onCreationFinished(actorId: number): void {
    const entry = this.online.get(actorId);
    if (entry) entry.bodyDue = true;
  }

  disconnect(userId: number, ctx: SystemContext): void {
    for (const [actorId, entry] of Array.from(this.online.entries())) {
      if (entry.userId === userId) this.goOffline(ctx, actorId);
    }
    this.lastShrineAt.delete(userId);
  }

  private goOffline(ctx: SystemContext, actorId: number): void {
    if (!this.online.delete(actorId)) return;
    this.abilities.end(actorId);
  }

  // A once-per-load packet schedules the re-send of anything changed inside the login window
  customPacket(userId: number, type: string, _content: Content, _ctx: SystemContext): void {
    if (type !== REQUEST_PACKET && type !== NEEDS_REQUEST_PACKET && !LOAD_PACKETS.has(type)) return;
    for (const [actorId, entry] of this.online) {
      if (entry.userId === userId) this.abilities.scheduleResend(actorId);
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const now = Date.now();
    const tick = now >= this.nextTickAt;
    if (tick) this.nextTickAt = now + TICK_MS;
    const mp = ctx.svr as Mp;
    for (const [actorId, entry] of Array.from(this.online.entries())) {
      try {
        if (tick && !this.stillPlaying(mp, entry.userId, actorId)) {
          this.goOffline(ctx, actorId);
          continue;
        }
        if (!this.abilities.waiting(actorId, now)) {
          if (entry.bodyDue) this.applyBody(ctx, actorId, entry, now);
          else if (tick) this.expire(ctx, actorId, entry, now);
        }
        if (this.abilities.takeResend(actorId, now)) this.abilities.resend(mp, actorId, this.groupsOf(mp, entry));
        if (tick) this.abilities.expire(actorId, now);
      } catch (e) {
        this.log(`[survival] update for ${hex(actorId)} failed: ${e}`);
      }
    }
  }

  // ── Rules ──────────────────────────────────────────────────────────────────

  // The body rules in force now, undoing what the record holds and the settings no longer ask for; one line per login
  private applyBody(ctx: SystemContext, actorId: number, entry: Online, now: number): void {
    const mp = ctx.svr as Mp;
    entry.bodyDue = false;
    const rec = entry.rec;
    const want = this.enabled ? this.body.filter((b) => b.id) : [];
    const wantDescs = want.map((b) => this.descOf(mp, b.id));
    const parts: string[] = [];
    const removed: string[] = [];
    for (const desc of rec.body.spells) {
      if (wantDescs.indexOf(desc) !== -1) continue;
      const id = this.idOfDesc(mp, desc);
      if (id && this.abilities.swap(mp, actorId, id, 0, this.edidOf(mp, id))) entry.revoked.push(id);
      removed.push(id ? this.edidOf(mp, id) : desc);
    }
    if (this.enabled) {
      for (const b of this.body) {
        if (!b.name) parts.push(`${b.label} off`);
        else if (!b.id) parts.push(`${b.label} ${b.name} not in the plugin yet, skipped`);
        else parts.push(`${b.label} ${this.edidOf(mp, b.id)} ${this.abilities.grant(mp, actorId, b.id, b.label) ? "granted" : "held"}`);
      }
    } else if (rec.foodPoisonUntil) {
      this.clearFoodPoisoning(mp, actorId, entry);
      removed.push(FOOD_POISONING_SPELL);
    }
    const respawn = this.enabled ? this.respawnHealth : 1;
    const respawnChanged = this.setRespawn(mp, actorId, respawn);
    rec.body = { spells: wantDescs, respawn };
    if (this.enabled) this.expire(ctx, actorId, entry, now);
    this.write(mp, actorId, rec);
    if (!this.enabled) {
      this.log(`[survival] ${hex(actorId)} body rules off: respawn 100%${respawnChanged ? "" : " (already)"}, abilities removed: ${removed.join(", ") || "none"}`);
      return;
    }
    const poisoned = rec.foodPoisonUntil ? `food poisoning until ${clock(rec.foodPoisonUntil)}` : "no food poisoning";
    this.log(`[survival] ${hex(actorId)} body: ${parts.join(", ")}, respawn health ${pct(respawn)}${respawnChanged ? " (set)" : ""}${removed.length ? `, removed ${removed.join(", ")}` : ""}, ${poisoned}`);
  }

  // True when the stored share changed; magicka and stamina keep theirs
  private setRespawn(mp: Mp, actorId: number, health: number): boolean {
    const current = mp.get(actorId, "respawnPercentages") || {};
    if (Math.abs(Number(current.health ?? 1) - health) < EPSILON) return false;
    mp.set(actorId, "respawnPercentages", { health, magicka: Number(current.magicka ?? 1), stamina: Number(current.stamina ?? 1) });
    return true;
  }

  // Food poisoning past its time is removed, offline time included
  private expire(ctx: SystemContext, actorId: number, entry: Online, now: number): void {
    const until = entry.rec.foodPoisonUntil;
    if (!until || now < until) return;
    const mp = ctx.svr as Mp;
    this.clearFoodPoisoning(mp, actorId, entry);
    this.write(mp, actorId, entry.rec);
    this.log(`[survival] ${hex(actorId)} food poisoning ran out at ${clock(until)}`);
    this.notice(mp, actorId, "Your stomach settles: the food poisoning has passed.");
  }

  private clearFoodPoisoning(mp: Mp, actorId: number, entry: Online): void {
    const id = this.idOfDesc(mp, entry.rec.foodPoisonSpell) || this.foodPoison;
    if (id && this.abilities.swap(mp, actorId, id, 0, "food poisoning")) entry.revoked.push(id);
    entry.rec.foodPoisonUntil = 0;
    entry.rec.foodPoisonSpell = "";
  }

  // Raw meat: the chance falls with disease resistance; a race safe from raw meat, a character already sick or in creation is spared
  private rollFoodPoisoning(ctx: SystemContext, actorId: number, baseId: number): void {
    const entry = this.online.get(actorId);
    const mp = ctx.svr as Mp;
    if (!entry || !this.foodPoison || this.poisonChance <= 0 || isCreationPending(mp, actorId)) return;
    const what = `${hex(actorId)} ate raw ${this.edidOf(mp, baseId)}`;
    const traits = this.racial.traits(actorId);
    if (traits.rawMeatSafe) {
      this.log(`[survival] ${what}: ${traits.raceEdid} is safe from raw meat`);
      return;
    }
    if (entry.rec.foodPoisonUntil) {
      this.log(`[survival] ${what}: already has food poisoning until ${clock(entry.rec.foodPoisonUntil)}`);
      return;
    }
    const resist = abilityResist(mp, actorId, ActorValue.DiseaseResist);
    const chance = clamp(this.poisonChance * (1 - resist / 100), 0, 1);
    const roll = Math.random();
    const outcome = `food poisoning ${pct(this.poisonChance)} x (1 - disease resist ${resist}%) = ${pct(chance)}, roll ${roll.toFixed(3)}`;
    if (roll >= chance) {
      this.log(`[survival] ${what}: ${outcome}, spared`);
      return;
    }
    this.abilities.grant(mp, actorId, this.foodPoison, "food poisoning");
    entry.rec.foodPoisonUntil = Date.now() + this.poisonMs;
    entry.rec.foodPoisonSpell = this.descOf(mp, this.foodPoison);
    this.write(mp, actorId, entry.rec);
    const hours = Math.round(this.poisonMs / HOUR_MS * 10) / 10;
    this.log(`[survival] ${what}: ${outcome}, poisoned for ${hours} h until ${clock(entry.rec.foodPoisonUntil)}`);
    this.notice(mp, actorId, `You feel sick: food poisoning slows your magicka and stamina recovery for ${hours} hours. ${this.cureHint()}`);
  }

  // Clears food poisoning and the afflictions; a healing potion also takes every Disease spell, which the native cure does for Cure Disease
  private cure(ctx: SystemContext, actorId: number, potionId: number, kind: "cureDisease" | "health"): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    const mp = ctx.svr as Mp;
    const cured: string[] = [];
    const done = new Set<number>();
    if (entry.rec.foodPoisonUntil) {
      done.add(this.idOfDesc(mp, entry.rec.foodPoisonSpell) || this.foodPoison);
      this.clearFoodPoisoning(mp, actorId, entry);
      cured.push("food poisoning");
    }
    const drop = (id: number): void => {
      try {
        removeSpellFrom(mp, actorId, id);
        entry.revoked.push(id);
        cured.push(this.edidOf(mp, id));
      } catch (e) {
        this.log(`[survival] ${hex(actorId)} could not remove ${hex(id)}: ${e}`);
      }
    };
    for (const id of learnedSpells(mp, actorId)) {
      if (done.has(id)) continue;
      if (this.afflictions.indexOf(id) !== -1 || (kind === "health" && spellInfo(mp, id).type === SpellType.Disease)) drop(id);
    }
    if (!cured.length && kind === "health") return;
    this.write(mp, actorId, entry.rec);
    const how = kind === "cureDisease" ? "Cure Disease" : `restores ${Math.round(potionHealing(mp, potionId))} health`;
    this.log(`[survival] ${hex(actorId)} cured by ${this.edidOf(mp, potionId)} (${how}): ${cured.join(", ") || "nothing survival tracks"}${kind === "cureDisease" ? ", the native cure took every Disease spell" : ""}`);
    if (cured.length) this.notice(mp, actorId, "The potion cures your sickness.");
  }

  private shrineNotice(ctx: SystemContext, actorId: number, shrineId: number): void {
    const mp = ctx.svr as Mp;
    const userId = userOf(mp, actorId);
    const now = Date.now();
    if (userId < 0 || now - (this.lastShrineAt.get(userId) || 0) < SHRINE_NOTICE_GAP_MS) return;
    this.lastShrineAt.set(userId, now);
    this.log(`[survival] ${hex(actorId)} prayed at ${this.edidOf(mp, baseIdOf(mp, shrineId))} ${hex(shrineId)}: no cure, notice sent`);
    this.notice(mp, actorId, `The shrine offers comfort, but no cure. ${this.cureHint()}`);
  }

  private cureHint(): string {
    return this.cureMode === "cureDiseaseOrHealth" ? "A Cure Disease potion or a healing potion cures it." : "A Cure Disease potion cures it.";
  }

  private resetBy(ctx: SystemContext, actorId: number, by: string): boolean {
    const entry = this.online.get(actorId);
    if (!entry) return false;
    const mp = ctx.svr as Mp;
    if (entry.rec.foodPoisonUntil) this.clearFoodPoisoning(mp, actorId, entry);
    this.write(mp, actorId, entry.rec);
    entry.bodyDue = true;
    this.log(`[survival] ${hex(actorId)} reset by ${by}`);
    return true;
  }

  // The body spells, and what else is held or was removed this session, for the login re-send
  private groupsOf(mp: Mp, entry: Online): AbilityGroup[] {
    const held = new Set(entry.rec.body.spells.map((d) => this.idOfDesc(mp, d)));
    if (entry.rec.foodPoisonUntil) held.add(this.idOfDesc(mp, entry.rec.foodPoisonSpell) || this.foodPoison);
    const ids = new Set([...this.body.map((b) => b.id), ...entry.revoked, ...held]);
    ids.delete(0);
    return Array.from(ids).map((id) => ({ what: this.edidOf(mp, id), held: held.has(id) ? id : 0, stages: [id] }));
  }

  describe(): string {
    return "no factors in force";
  }

  private notice(mp: Mp, actorId: number, text: string): void {
    sendJson(mp, userOf(mp, actorId), { customPacketType: NOTICE_PACKET, text });
  }

  private stillPlaying(mp: Mp, userId: number, actorId: number): boolean {
    try { return mp.isConnected(userId) && (mp.getUserActor(userId) >>> 0) === actorId; } catch { return false; }
  }

  private isPlayerCharacter(mp: Mp, actorId: number): boolean {
    try { return !!actorId && Number(mp.get(actorId, "profileId")) >= 0; } catch { return false; }
  }

  private descOf(mp: Mp, id: number): string {
    try { return String(mp.getDescFromId(id)); } catch { return hex(id); }
  }

  private idOfDesc(mp: Mp, desc: string): number {
    try { return desc ? mp.getIdFromDesc(desc) >>> 0 : 0; } catch { return 0; }
  }

  private edidOf(mp: Mp, id: number): string {
    try { return String(mp.lookupEspmRecordById(id)?.record?.editorId || hex(id)); } catch { return hex(id); }
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  private read(mp: Mp, actorId: number): SurvivalRecord | null {
    try {
      const raw = mp.get(actorId, SURVIVAL_PROP);
      if (!raw || typeof raw !== "object") return null;
      const spells = Array.isArray(raw.body?.spells) ? raw.body.spells.filter((d: unknown): d is string => typeof d === "string" && !!d) : [];
      const respawn = Number(raw.body?.respawn);
      return {
        v: 1,
        at: Number(raw.at) || Date.now(),
        body: { spells, respawn: respawn > 0 && respawn <= 1 ? respawn : 1 },
        foodPoisonUntil: Math.max(0, Number(raw.foodPoisonUntil) || 0),
        foodPoisonSpell: typeof raw.foodPoisonSpell === "string" ? raw.foodPoisonSpell : "",
      };
    } catch {
      return null;
    }
  }

  private write(mp: Mp, actorId: number, rec: SurvivalRecord): void {
    rec.at = Date.now();
    try {
      mp.set(actorId, SURVIVAL_PROP, rec);
    } catch (e) {
      this.log(`[survival] write failed for ${hex(actorId)}: ${e}`);
    }
  }

  private enabled = false;
  private respawnHealth = DEFAULT_RESPAWN_HEALTH;
  private poisonChance = DEFAULT_POISON_CHANCE;
  private poisonMs = DEFAULT_POISON_HOURS * HOUR_MS;
  private cureMode: CureMode = "cureDiseaseOrHealth";
  private cureMinHealth = DEFAULT_CURE_MIN_HEALTH;
  private body: BodySpell[] = [];
  private foodPoison = 0;
  private afflictions: number[] = [];
  private rawMeat = new Set<number>();
  private altars = new Set<number>();
  private online = new Map<number, Online>();
  private abilities: StageAbilityTracker;
  private lastShrineAt = new Map<number, number>();
  private nextTickAt = 0;
}
