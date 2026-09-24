import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT, CREATION_FINISHED_EVENT } from "./system";
import { resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds, readVmadScripts } from "./formIdUtil";
import { keywordConditionsPass } from "./espmMagic";
import { addSpellTo, removeSpellFrom, hex, chainMpHook, isAlive, isBleedingOut, isCreationPending, sendStagger, userOf } from "./actorUtil";
import { MasterySystem, stringList } from "./masterySystem";
import { IMPERIAL_RACES } from "./charCreatorData";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Hunger and crafting fatigue, kept by the server on Survival Mode's scales and with Survival Mode's penalties.
//
// Hunger runs from 0 (full) to 1000 and drains only while the character is online and past character creation; eating a food takes it down by the
// amount needsFoodHunger gives its Survival hunger effect, or else the effect's Survival_HungerRestoreEffectScript AmountToRestore global.
// Fatigue is a bar from 0 to 1 that every accepted recipe draws on, by the crafter's rank in the profession owning the
// recipe's bench (Novice outside it, members pay half, Imperials less on own-profession work), and that a kill draws on too (needsKillFatigue, less for warriors); it refills at a
// flat rate online and offline and maps onto Survival's exhaustion scale as (1 - fatigue) * 960. A craft the bar cannot pay for is refused before the native craft runs, and the
// client's local craft is undone by resending its inventory. The craft that leaves the bar short of another closes the menu, so rapid clicks make nothing to undo.
// Each need holds the Survival stage ability of its stage (screen effects stripped by AlduinakCreations.esp) and reduces a
// maximum like Survival_NeedBase.ApplyAttributePenalty: hunger max stamina, fatigue max magicka, by
// clamp((value - (stage 2 value - 1)) / (max - (stage 2 value - 1)), 0, 1) of the total. The server sends that share and
// the client applies it (NeedsService). Every decision is made inside the native hooks from memory; writes, Papyrus calls
// and packets run right after the hook returns (setImmediate), and updateAsync drains anything left.
//
// Wire protocol - CustomPacket JSON:
//   Client -> Server: { customPacketType: "needsRequest" }
//   Server -> Client: { customPacketType: "needsState", hunger, stage, stageName, fatigue, fatigueStage, fatigueStageName,
//                       staminaPenalty, magickaPenalty, survivalMode, closeCrafting? }
//                     hunger and fatigue are 0-100 (100 = full stomach, rested); the penalties are the 0-1 share of the
//                     maximum removed; survivalMode sets the client's Survival_ModeToggle; closeCrafting closes the Crafting Menu
//                     { customPacketType: "masteryNotice", text }
//
// Persistence: `private.needs` = { v, hunger, fatigue, at, stageSpell, fatigueSpell, wellFed } on the character's actor form.
//
// server-settings.json keys (all optional):
//   needsEnabled                  false switches hunger and fatigue off, default true
//   needsHungerDrainPerHour       hunger points per online hour, default 125 (full to starving in about 8 hours)
//   needsHungerOffline            true drains hunger while logged out too, default false
//   needsHungerStart              hunger of a new character, default 145 (Survival's starting value, Satisfied)
//   needsHungerStages             hunger at which stages 1-5 begin, default [80, 160, 340, 520, 770]
//   needsHungerStageAbilities     false grants no Survival hunger stage abilities, default true
//   needsFoodHunger               { "<hunger effect editor id>": hunger points } merged over DEFAULT_FOOD_HUNGER
//   needsFatigueCraftsPerHour     crafts one full bar pays for by rank [Novice, Adept, Expert, Master], default [6, 12, 18, 24]
//   needsFatigueMemberMult        what a member of the bench's profession pays of that cost, default 0.5
//   needsFatigueImperialMult      what an Imperial pays of any own-profession fatigue cost, default 0.75
//   needsFatigueRegenPerMinute    bar fraction refilled per minute, default 0.016
//   needsFatigueOfflineRegen      false refills only while online, default true
//   needsFatigueFreeKeywords      bench keywords whose recipes cost nothing, default ["AldCraftingMead"]
//   needsFatigueRecipeMult        { "<recipe editor id>": share of its bench's craft cost } merged over { AldRecipeKiln_Charcoal: 0.5 }; 0 is free
//   needsFatigueStages            exhaustion at which stages 1-5 begin, default [80, 160, 340, 560, 800]
//   needsFatigueStageAbilities    false grants no Survival exhaustion stage abilities, default true
//   needsExhaustionMax            exhaustion of an empty fatigue bar, default 960 (Survival_ExhaustionNeedMaxValue)
//   needsKillFatigue              exhaustion a kill costs, in the same points as the stages, default 10
//   needsKillFatigueWarrior       what a warrior pays instead, default 5
//   needsChopWoodPerBar           firewood one full bar chops [non-woodworker, Novice, Adept, Expert, Master], default [12, 24, 48, 72, 96]
//   needsMineFatigue              exhaustion one ore off a vein costs, default 20
//   needsMineFatigueMiner         what a miner pays instead, default 10
//   needsPickFatigue              exhaustion harvesting a plant or nirnroot costs, default 10
//   needsAttributePenalties       false sends no max stamina or max magicka penalty, default true
//   needsSurvivalModeFlag         true sets the client's Survival_ModeToggle (SRVT, esl 0x828) to 1, the global HUDMenu polls each frame to draw the penalty segments, default true
//   blockStaminaCost              share of max stamina a blocked weapon hit costs the blocker, default 0.10; works with needs off
//   blockStaminaCostWarrior       what a warrior pays instead, default 0.05
//   blockStaggerWithoutStamina    a blocker whose stamina is below the cost is staggered, default true
//   blockStaggerMagnitude         staggerMagnitude of that stagger (0.1 to 1), default 0.5

const NEEDS_PROP = "private.needs";
const STATE_PACKET = "needsState";
const REQUEST_PACKET = "needsRequest";
const NOTICE_PACKET = "masteryNotice";

// Survival_HungerNeedMaxValue
const HUNGER_MAX = 1000;
const POLL_MS = 1000;
const TICK_MS = 60000;
// The client wipes and re-applies learnedSpells about a second after spawn; a stage ability change has to land after that
const LOGIN_SYNC_DELAY_MS = 5000;
const NOTICE_GAP_MS = 2000;
const MAX_QUEUED = 4096;
const EPSILON = 1e-6;

const HUNGER_STAGE_NAMES = ["Well Fed", "Satisfied", "Peckish", "Hungry", "Famished", "Starving"];
const HUNGER_SPELLS = HUNGER_STAGE_NAMES.map((_, i) => `Survival_HungerStage${i}`);
// Stage 0 is the Rested bonus Survival only grants after sleeping, so an idle bar sits in Refreshed
const FATIGUE_STAGE_NAMES = ["Well Rested", "Refreshed", "Drained", "Tired", "Weary", "Debilitated"];
const FATIGUE_SPELLS = FATIGUE_STAGE_NAMES.map((_, i) => (i ? `Survival_ExhaustionStage${i}` : ""));
const HUNGER_RESTORE_SCRIPT = "survival_hungerrestoreeffectscript";
const HUNGER_RESTORE_PROPERTY = "amounttorestore";
// Read at boot to report whether the load order still carries the restore amounts
const PROBE_EFFECT = "Survival_FoodRestoreHungerSmall";
const FOOD_EFFECT_PREFIX = "Survival_FoodRestoreHunger";
// Survival's globals give 2/18/220/380, so drinks and raw food barely moved the bar; the meals keep Survival's amounts
const DEFAULT_FOOD_HUNGER: Record<string, number> = {
  Survival_FoodRestoreHungerVerySmall: 40,
  Survival_FoodRestoreHungerSmall: 100,
  Survival_FoodRestoreHungerMedium: 220,
  Survival_FoodRestoreHungerLarge: 380,
};
const DEFAULT_STAGES = [80, 160, 340, 520, 770];
const DEFAULT_FATIGUE_STAGES = [80, 160, 340, 560, 800];
// Survival_HungerNeedValue, the hunger Survival Mode starts a new game with
const DEFAULT_HUNGER_START = 145;
const DEFAULT_EXHAUSTION_MAX = 960;
// Exhaustion a kill adds, in stage points; the fatigue meter players read is a percentage of the max above
const DEFAULT_KILL_FATIGUE = 10;
const DEFAULT_KILL_FATIGUE_WARRIOR = 5;
// Mining is heavier work than a kill, and miners pay half.
const DEFAULT_WORK_FATIGUE = 20;
const DEFAULT_WORK_FATIGUE_OWN_TRADE = 10;
const DEFAULT_PICK_FATIGUE = 10;
// Firewood a full bar chops, outside the woodworker profession first, then by woodworker rank
const DEFAULT_CHOP_WOOD_PER_BAR = [12, 24, 48, 72, 96];
const DEFAULT_CRAFTS_PER_HOUR = [6, 12, 18, 24];
const DEFAULT_FREE_KEYWORDS = ["AldCraftingMead"];
// Charcoal is simple smelter work: half a craft
const DEFAULT_RECIPE_MULT: Record<string, number> = { AldRecipeKiln_Charcoal: 0.5 };
const STAGGER_COOLDOWN_MS = 1000;

interface NeedsRecord {
  v: number;
  hunger: number;
  fatigue: number;
  // Epoch ms the values above were last brought up to date
  at: number;
  // Hunger and exhaustion stage abilities this character holds, 0 for none
  stageSpell: number;
  fatigueSpell: number;
  // Survival's hasBonus: set when a meal empties hunger, cleared once hunger reaches the first stage value
  wellFed: boolean;
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
  | { kind: "spent"; actorId: number; cost: number }
  | { kind: "changed"; actorId: number };

const STOP_LOG = { refused: "craft refused", tired: "bench refused", spent: "bar spent, crafting closed" };

interface FoodEffect {
  mgefId: number;
  amount: number;
}

type AbilityField = "stageSpell" | "fatigueSpell";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): number => Math.round(v * 100);
const share = (v: number): number => Math.round(v * 10000) / 10000;
const numberList = (v: unknown, length: number): number[] | null =>
  Array.isArray(v) && v.length === length && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : null;
// A { name: number >= 0 } setting merged key by key over its defaults
const numberMap = (v: unknown, defaults: Record<string, number>): Record<string, number> => {
  const out = { ...defaults };
  for (const [k, x] of Object.entries(v && typeof v === "object" ? v as Record<string, unknown> : {})) {
    if (Number.isFinite(Number(x)) && Number(x) >= 0) out[k] = Number(x);
  }
  return out;
};
const lookup = (mp: Mp, id: number): any => {
  try { return id ? mp.lookupEspmRecordById(id) : null; } catch { return null; }
};

// Survival_NeedBase.ApplyAttributePenalty: the share of the maximum lost, from the stage 2 value up to the need's maximum
export const attributePenaltyShare = (value: number, stage2Value: number, max: number): number =>
  clamp((value - (stage2Value - 1)) / Math.max(EPSILON, max - (stage2Value - 1)), 0, 1);

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
    const strings = (key: string, fallback: string[]): string[] => Array.isArray(all[key]) ? stringList(all[key]) : fallback;
    this.drainPerHour = num("needsHungerDrainPerHour", 125);
    this.hungerOffline = all["needsHungerOffline"] === true;
    this.hungerStart = clamp(num("needsHungerStart", DEFAULT_HUNGER_START), 0, HUNGER_MAX);
    this.stages = numberList(all["needsHungerStages"], DEFAULT_STAGES.length) || DEFAULT_STAGES.slice();
    this.stageAbilities = all["needsHungerStageAbilities"] !== false;
    const foodHunger = numberMap(all["needsFoodHunger"], DEFAULT_FOOD_HUNGER);
    const crafts = numberList(all["needsFatigueCraftsPerHour"], DEFAULT_CRAFTS_PER_HOUR.length);
    this.craftsPerHour = crafts && crafts.every((c) => c > 0) ? crafts : DEFAULT_CRAFTS_PER_HOUR.slice();
    this.memberMult = num("needsFatigueMemberMult", 0.5);
    this.imperialMult = num("needsFatigueImperialMult", 0.75);
    this.regenPerMinute = num("needsFatigueRegenPerMinute", 0.016);
    this.fatigueOffline = all["needsFatigueOfflineRegen"] !== false;
    this.fatigueStages = numberList(all["needsFatigueStages"], DEFAULT_FATIGUE_STAGES.length) || DEFAULT_FATIGUE_STAGES.slice();
    this.fatigueAbilities = all["needsFatigueStageAbilities"] !== false;
    this.exhaustionMax = num("needsExhaustionMax", DEFAULT_EXHAUSTION_MAX, 1);
    this.killFatigue = num("needsKillFatigue", DEFAULT_KILL_FATIGUE, 0);
    this.killFatigueWarrior = num("needsKillFatigueWarrior", DEFAULT_KILL_FATIGUE_WARRIOR, 0);
    const wood = numberList(all["needsChopWoodPerBar"], DEFAULT_CHOP_WOOD_PER_BAR.length);
    this.chopWoodPerBar = wood && wood.every((w) => w > 0) ? wood : DEFAULT_CHOP_WOOD_PER_BAR.slice();
    this.mineFatigue = num("needsMineFatigue", DEFAULT_WORK_FATIGUE, 0);
    this.mineFatigueOwn = num("needsMineFatigueMiner", DEFAULT_WORK_FATIGUE_OWN_TRADE, 0);
    this.pickFatigue = num("needsPickFatigue", DEFAULT_PICK_FATIGUE, 0);
    this.penalties = all["needsAttributePenalties"] !== false;
    this.survivalModeFlag = all["needsSurvivalModeFlag"] !== false;
    const freeKeywords = strings("needsFatigueFreeKeywords", DEFAULT_FREE_KEYWORDS);
    const recipeMult = numberMap(all["needsFatigueRecipeMult"], DEFAULT_RECIPE_MULT);

    this.installBlockStamina(ctx, num("blockStaminaCost", 0.1), num("blockStaminaCostWarrior", 0.05),
      all["blockStaggerWithoutStamina"] !== false ? clamp(num("blockStaggerMagnitude", 0.5), 0.1, 1) : 0);

    if (!this.enabled) {
      this.log("[needs] disabled by needsEnabled");
      return;
    }
    const probe = await this.resolveForms(ctx, freeKeywords, recipeMult, foodHunger, s.dataDir, s.loadOrder);
    const recipeLine = Object.entries(recipeMult).map(([edid, m]) => `${edid} x${m}`).join(", ");
    const foodLine = Object.entries(foodHunger).map(([edid, v]) => `${edid.replace(FOOD_EFFECT_PREFIX, "")} ${v}`).join(", ");
    this.log(`[needs] ready, hunger ${this.drainPerHour}/h online${this.hungerOffline ? " and offline" : ""}, stages at ${this.stages.join("/")}, food hunger ${foodLine}, other effects from the records (${PROBE_EFFECT} record ${probe || "none"}); fatigue ${this.craftsPerHour.join("/")} crafts per bar by rank (members x${this.memberMult}, Imperials x${this.imperialMult}), +${(this.regenPerMinute * 100).toFixed(1)}% per minute${this.fatigueOffline ? " also offline" : ""}, exhaustion stages at ${this.fatigueStages.join("/")} of ${this.exhaustionMax}; attribute penalties ${this.penalties ? "on" : "off"}, ${this.freeBenches.size} free bench keyword(s), recipe costs ${recipeLine || "none"}, firewood per bar ${this.chopWoodPerBar.join("/")} (outside the trade, then by woodworker rank)`);

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => this.startFresh(ctx, actorId >>> 0));
    this.installHooks(ctx);
  }

  // Resolves the stage abilities, free bench keywords, recipe costs and food effects; returns the probe effect's record amount, 0 when the records carry none
  private async resolveForms(ctx: SystemContext, freeKeywords: string[], recipeMult: Record<string, number>, foodHunger: Record<string, number>, dataDir: string, loadOrder: string[]): Promise<number> {
    const mp = ctx.svr as Mp;
    const idOf = (scan: { resolved: Map<string, string> }, edid: string): number => {
      const desc = edid ? scan.resolved.get(edid.toLowerCase()) : undefined;
      try { return desc ? mp.getIdFromDesc(desc) >>> 0 : 0; } catch { return 0; }
    };
    const spellNames = [...HUNGER_SPELLS, ...FATIGUE_SPELLS.filter((n) => n)];
    const spells = await resolveEditorIds(spellNames, dataDir, loadOrder, this.log, ["SPEL"]);
    this.hungerSpells = HUNGER_SPELLS.map((edid) => idOf(spells, edid));
    this.fatigueSpells = FATIGUE_SPELLS.map((edid) => idOf(spells, edid));
    const recipes = Object.keys(recipeMult);
    const free = await resolveEditorIds([...freeKeywords, ...recipes], dataDir, loadOrder, this.log, ["KYWD", "COBJ"]);
    this.freeBenches = new Set(freeKeywords.map((edid) => idOf(free, edid)).filter((id) => id));
    for (const edid of recipes) {
      const id = idOf(free, edid);
      if (!id) continue;
      this.recipeMult.set(id, recipeMult[edid]);
      const bench = this.mastery.recipeBench(ctx, id);
      if (bench) this.benchMult.set(bench, Math.min(this.benchMult.get(bench) ?? 1, recipeMult[edid]));
    }
    const foodEdids = Object.keys(foodHunger);
    const effectNames = Array.from(new Set([PROBE_EFFECT, ...foodEdids]));
    const effects = await resolveEditorIds(effectNames, dataDir, loadOrder, this.log, ["MGEF"]);
    this.foodHunger = new Map(foodEdids.map((edid) => [idOf(effects, edid), foodHunger[edid]] as [number, number]).filter(([id]) => id));
    const probe = this.restoreAmountOf(mp, idOf(effects, PROBE_EFFECT));
    const missing = [...spellNames.filter((edid) => !spells.resolved.has(edid.toLowerCase())),
      ...freeKeywords.concat(recipes).filter((k) => !free.resolved.has(k.toLowerCase())),
      ...effectNames.filter((edid) => !effects.resolved.has(edid.toLowerCase()))];
    if (effects.resolved.has(PROBE_EFFECT.toLowerCase()) && !probe) this.log(`[needs] ${PROBE_EFFECT} carries no ${HUNGER_RESTORE_SCRIPT} amount in the load order: hunger effects outside needsFoodHunger restore nothing (AlduinakCreations.esp must keep Survival's effect edits)`);
    if (missing.length) this.log(`[needs] not in the load order, ignored: ${missing.join(", ")}`);
    return probe;
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

  // OnHit fires before the native hit writes the percentages it copied earlier, so the drain waits a tick.
  // A blocker who cannot pay the cost still blocks that hit but is staggered (staggerMagnitude 0 = off), at most once a second
  private installBlockStamina(ctx: SystemContext, cost: number, warriorCost: number, staggerMagnitude: number): void {
    const mp = ctx.svr as Mp;
    if (cost <= 0 && warriorCost <= 0) return;
    const lastStagger = new Map<number, number>();
    chainMpHook(mp, "onPapyrusEvent:OnHit", (...args: unknown[]) => {
      if (args[7] !== true) return;
      const desc = (args[2] as { desc?: unknown } | null)?.desc;
      if (typeof desc !== "string") return;
      // Ward blocks send a SPEL source
      const type = String(lookup(mp, mp.getIdFromDesc(desc) >>> 0)?.record?.type ?? "");
      if (type !== "WEAP" && type !== "ARMO") return;
      const targetId = Number(args[0]) >>> 0;
      setImmediate(() => {
        try {
          if (!isAlive(mp, targetId)) return;
          const drain = this.mastery.rankOf(ctx, targetId, "warrior") >= 0 ? warriorCost : cost;
          const p = mp.get(targetId, "percentages");
          if (!p || drain <= 0) return;
          const short = Number(p.stamina) < drain;
          mp.set(targetId, "percentages", { ...p, stamina: Math.max(0, Number(p.stamina) - drain) });
          const now = Date.now();
          if (!short || staggerMagnitude <= 0 || isBleedingOut(mp, targetId) || userOf(mp, targetId) < 0 ||
            now - (lastStagger.get(targetId) ?? 0) < STAGGER_COOLDOWN_MS) return;
          lastStagger.set(targetId, now);
          sendStagger(mp, targetId, staggerMagnitude);
          this.log(`[needs] ${hex(targetId)} staggered: blocked without stamina`);
        } catch (e) {
          this.log(`[needs] block stamina for ${hex(targetId)} failed: ${e}`);
        }
      });
    });
  }

  // False refuses the craft; crafts without the inputs in the bag are left to the native side uncharged
  private chargeCraft(ctx: SystemContext, actorId: number, recipeId: number): boolean {
    const entry = this.online.get(actorId);
    const mult = this.recipeMult.get(recipeId) ?? 1;
    if (!entry || mult <= 0 || !this.mastery.holdsInputs(ctx, actorId, recipeId)) return true;
    const bench = this.mastery.recipeBench(ctx, recipeId);
    if (this.freeBenches.has(bench)) return true;
    const cost = this.craftCost(ctx, actorId, bench) * mult;
    this.advance(entry.rec, Date.now(), true);
    if (entry.rec.fatigue + EPSILON < cost) {
      this.enqueue(ctx, { kind: "refused", actorId, cost });
      return false;
    }
    entry.rec.fatigue = clamp(entry.rec.fatigue - cost, 0, 1);
    // Closing now keeps the next click from making a craft the server would undo
    this.enqueue(ctx, entry.rec.fatigue + EPSILON < cost ? { kind: "spent", actorId, cost } : { kind: "changed", actorId });
    return true;
  }

  // A bench never opens its menu to a character who cannot pay its cheapest recipe
  private tooTiredForBench(ctx: SystemContext, refrId: number, actorId: number): boolean {
    const entry = this.online.get(actorId);
    if (!entry) return false;
    const keywords = Array.from(this.mastery.stationKeywords(ctx, refrId));
    if (!keywords.length || keywords.some((k) => this.freeBenches.has(k))) return false;
    const bench = keywords.filter((k) => this.mastery.professionOfBench(k))[0];
    if (!bench) return false;
    const cost = this.craftCost(ctx, actorId, bench) * Math.min(1, ...keywords.map((k) => this.benchMult.get(k) ?? 1));
    if (cost <= 0) return false;
    this.advance(entry.rec, Date.now(), true);
    if (entry.rec.fatigue + EPSILON >= cost) return false;
    this.enqueue(ctx, { kind: "tired", actorId, cost });
    return true;
  }

  // Every hunger effect whose HasKeyword conditions pass restores its amount, as each would run its own script
  private eat(ctx: SystemContext, actorId: number, baseId: number): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    const mp = ctx.svr as Mp;
    const restore = this.foodEffectsOf(mp, baseId)
      .filter((e) => keywordConditionsPass(mp, e.mgefId, actorId))
      .reduce((sum, e) => sum + e.amount, 0);
    if (!restore) return;
    this.advance(entry.rec, Date.now(), true);
    entry.rec.hunger = clamp(entry.rec.hunger - restore, 0, HUNGER_MAX);
    if (entry.rec.hunger <= 0) entry.rec.wellFed = true;
    this.enqueue(ctx, { kind: "changed", actorId });
  }

  // Handled once the native hook has returned, so a close reaches the client before the next click
  private enqueue(ctx: SystemContext, q: Queued): void {
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(q);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.drainQueue(ctx);
    });
  }

  private drainQueue(ctx: SystemContext): void {
    for (const q of this.queue.splice(0, this.queue.length)) {
      try {
        this.handle(ctx, q);
      } catch (e) {
        this.log(`[needs] ${q.kind} for ${hex(q.actorId)} failed: ${e}`);
      }
    }
  }

  // ── Online bookkeeping ─────────────────────────────────────────────────────

  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    for (const [otherActor, entry] of Array.from(this.online.entries())) {
      if (entry.userId === userId && otherActor !== actorId) this.goOffline(ctx, otherActor);
    }
    if (!this.isPlayerCharacter(ctx, actorId)) return;
    const now = Date.now();
    const stored = this.read(ctx, actorId);
    const rec = stored || { v: 2, hunger: this.hungerStart, fatigue: 1, at: now, stageSpell: 0, fatigueSpell: 0, wellFed: false };
    if (stored) this.advance(rec, now, false);
    this.online.set(actorId, { userId, rec, sent: "", syncStageAt: now + LOGIN_SYNC_DELAY_MS });
    this.write(ctx, actorId, rec);
    this.sendState(ctx, actorId, false);
  }

  // A finished character starts from the new-character values, whatever the creation wait did
  private startFresh(ctx: SystemContext, actorId: number): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    Object.assign(entry.rec, { hunger: this.hungerStart, fatigue: 1, at: Date.now(), wellFed: false });
    this.write(ctx, actorId, entry.rec);
    this.syncStages(ctx, actorId, entry);
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

  // A kill costs exhaustion points off the same bar crafting spends; warriors pay the smaller price
  applyKillFatigue(ctx: SystemContext, actorId: number, warrior: boolean): void {
    this.applyExhaustion(ctx, actorId, warrior ? this.killFatigueWarrior * this.professionMult(ctx, actorId) : this.killFatigue, "kill");
  }

  // Firewood off a chopping block, priced by the woodworker rank (-1 outside the profession)
  applyChopFatigue(ctx: SystemContext, actorId: number, rank: number, wood: number): void {
    this.applyExhaustion(ctx, actorId, this.chopPoints(ctx, actorId, rank, wood), "chop");
  }

  // One ore off a vein; miners pay the smaller price
  applyMineFatigue(ctx: SystemContext, actorId: number, miner: boolean): void {
    this.applyExhaustion(ctx, actorId, this.minePoints(ctx, actorId, miner), "ore");
  }

  // Harvesting a plant or nirnroot
  applyPickFatigue(ctx: SystemContext, actorId: number): void {
    this.applyExhaustion(ctx, actorId, this.pickFatigue, "harvest");
  }

  // Whether the bar can still pay for one swing's firewood
  canChop(ctx: SystemContext, actorId: number, rank: number, wood: number): boolean {
    return this.canAfford(actorId, this.chopPoints(ctx, actorId, rank, wood));
  }

  canMine(ctx: SystemContext, actorId: number, miner: boolean): boolean {
    return this.canAfford(actorId, this.minePoints(ctx, actorId, miner));
  }

  // A full bar is exhaustionMax points and chops chopWoodPerBar firewood at the rank
  private chopPoints(ctx: SystemContext, actorId: number, rank: number, wood: number): number {
    const perBar = this.chopWoodPerBar[clamp(rank + 1, 0, this.chopWoodPerBar.length - 1)];
    return this.exhaustionMax * wood / perBar * (rank >= 0 ? this.professionMult(ctx, actorId) : 1);
  }

  private minePoints(ctx: SystemContext, actorId: number, miner: boolean): number {
    return miner ? this.mineFatigueOwn * this.professionMult(ctx, actorId) : this.mineFatigue;
  }

  // The Imperial racial passive: less fatigue for work in their own profession
  private professionMult(ctx: SystemContext, actorId: number): number {
    try {
      return IMPERIAL_RACES.has(Number((ctx.svr as Mp).get(actorId, "appearance")?.raceId) >>> 0) ? this.imperialMult : 1;
    } catch {
      return 1;
    }
  }

  canPick(ctx: SystemContext, actorId: number): boolean {
    return this.canAfford(actorId, this.pickFatigue);
  }

  // An offline character or a server with needs switched off is never refused
  private canAfford(actorId: number, points: number): boolean {
    const entry = this.online.get(actorId);
    if (!entry || !this.enabled || points <= 0) return true;
    this.advance(entry.rec, Date.now(), true);
    return entry.rec.fatigue + EPSILON >= points / this.exhaustionMax;
  }

  // Exhaustion points off the bar crafting spends, on the stage scale; what names the work for the log
  private applyExhaustion(ctx: SystemContext, actorId: number, points: number, what: string): void {
    const entry = this.online.get(actorId);
    if (!entry || !this.enabled || points <= 0) return;
    this.advance(entry.rec, Date.now(), true);
    entry.rec.fatigue = clamp(entry.rec.fatigue - points / this.exhaustionMax, 0, 1);
    this.log(`[needs] ${hex(actorId)} ${what}: -${Math.round(points * 10) / 10} pts, fatigue ${pct(entry.rec.fatigue)}%`);
    this.write(ctx, actorId, entry.rec);
    this.syncStages(ctx, actorId, entry);
    this.sendState(ctx, actorId, false);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.enabled) return;
    this.drainQueue(ctx);
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
          // The race menu or creator can stay open for hours
          if (isCreationPending(ctx.svr as Mp, actorId)) {
            entry.rec.at = now;
            continue;
          }
          this.advance(entry.rec, now, true);
          this.write(ctx, actorId, entry.rec);
          this.syncStages(ctx, actorId, entry);
          this.sendState(ctx, actorId, false);
        } else if (entry.syncStageAt && now >= entry.syncStageAt) {
          entry.syncStageAt = 0;
          this.syncStages(ctx, actorId, entry);
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
      this.syncStages(ctx, q.actorId, entry);
      this.sendState(ctx, q.actorId, false);
      return;
    }
    this.log(`[needs] ${STOP_LOG[q.kind]} for ${hex(q.actorId)}: fatigue ${pct(entry.rec.fatigue)}%, needs ${pct(q.cost)}%`);
    if (q.kind === "refused") {
      // Closed first: the resent inventory undoes the recipe the vanilla menu already made locally
      this.sendState(ctx, q.actorId, true);
      mp.set(q.actorId, "inventory", mp.get(q.actorId, "inventory"));
    } else if (q.kind === "spent") {
      this.syncStages(ctx, q.actorId, entry);
      this.sendState(ctx, q.actorId, true);
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
    if (rec.hunger >= this.stages[0]) rec.wellFed = false;
    rec.at = Math.max(rec.at, now);
  }

  private craftCost(ctx: SystemContext, actorId: number, bench: number): number {
    const profession = this.mastery.professionOfBench(bench);
    const rank = profession ? this.mastery.rankOf(ctx, actorId, profession) : -1;
    const base = 1 / this.craftsPerHour[clamp(rank, 0, this.craftsPerHour.length - 1)];
    return rank >= 0 ? base * this.memberMult * this.professionMult(ctx, actorId) : base;
  }

  // Survival_NeedHunger.ApplyHungerStage: Well Fed only while the bonus lasts, otherwise Satisfied below the stage 2 value
  private hungerStage(rec: NeedsRecord): number {
    return rec.wellFed ? 0 : Math.max(1, this.stages.filter((threshold) => rec.hunger >= threshold).length);
  }

  // Rounded so a bar spent in whole crafts lands on Survival's stage values instead of a hair below them
  private exhaustion(rec: NeedsRecord): number {
    return Math.round((1 - rec.fatigue) * this.exhaustionMax * 1e6) / 1e6;
  }

  private fatigueStage(rec: NeedsRecord): number {
    return Math.max(1, this.fatigueStages.filter((threshold) => this.exhaustion(rec) >= threshold).length);
  }

  // Hunger effects of an ALCH or INGR with their restore amounts, cached; plugins only change with a restart
  private foodEffectsOf(mp: Mp, baseId: number): FoodEffect[] {
    const hit = this.foodCache.get(baseId);
    if (hit) return hit;
    const res = lookup(mp, baseId);
    const type = res && res.record ? String(res.record.type) : "";
    const effects = type === "ALCH" || type === "INGR"
      ? espmFieldFormIds(res, "EFID").map((mgefId) => ({ mgefId, amount: this.foodHunger.get(mgefId) ?? this.restoreAmountOf(mp, mgefId) })).filter((e) => e.amount > 0)
      : [];
    this.foodCache.set(baseId, effects);
    return effects;
  }

  // The value of the global a magic effect's hunger restore script names, 0 for any other effect
  private restoreAmountOf(mp: Mp, mgefId: number): number {
    const hit = this.amountCache.get(mgefId);
    if (hit !== undefined) return hit;
    let amount = 0;
    const mgef = lookup(mp, mgefId);
    if (mgef?.record?.type === "MGEF") {
      const glob = lookup(mp, readVmadScripts(mgef).get(HUNGER_RESTORE_SCRIPT)?.[HUNGER_RESTORE_PROPERTY] || 0);
      const fltv = glob?.record?.type === "GLOB" ? (glob.record.fields || []).find((f: any) => f && f.type === "FLTV" && f.data instanceof Uint8Array && f.data.byteLength >= 4) : null;
      if (fltv) amount = Math.max(0, new DataView(fltv.data.buffer, fltv.data.byteOffset, 4).getFloat32(0, true));
    }
    this.amountCache.set(mgefId, amount);
    return amount;
  }

  private syncStages(ctx: SystemContext, actorId: number, entry: Online): void {
    if (entry.syncStageAt && Date.now() < entry.syncStageAt) return;
    const stage = this.hungerStage(entry.rec);
    const fatigueStage = this.fatigueStage(entry.rec);
    const hungerBefore = this.hungerSpells.indexOf(entry.rec.stageSpell);
    const fatigueBefore = this.fatigueSpells.indexOf(entry.rec.fatigueSpell);
    if (this.swapAbility(ctx, actorId, entry, "stageSpell", this.stageAbilities ? this.hungerSpells[stage] || 0 : 0)
      && hungerBefore >= 0 && stage > hungerBefore && stage >= 2) {
      this.notice(ctx, entry.userId, `You are ${HUNGER_STAGE_NAMES[stage].toLowerCase()}: your stamina is reduced. Find something to eat.`);
    }
    if (this.swapAbility(ctx, actorId, entry, "fatigueSpell", this.fatigueAbilities ? this.fatigueSpells[fatigueStage] || 0 : 0)
      && fatigueBefore >= 0 && fatigueStage > fatigueBefore && fatigueStage >= 2) {
      this.notice(ctx, entry.userId, `You feel ${FATIGUE_STAGE_NAMES[fatigueStage].toLowerCase()}: your magicka is reduced until you rest from crafting.`);
    }
  }

  // True when the held ability changed
  private swapAbility(ctx: SystemContext, actorId: number, entry: Online, field: AbilityField, want: number): boolean {
    if (entry.rec[field] === want) return false;
    const mp = ctx.svr as Mp;
    try {
      if (entry.rec[field]) removeSpellFrom(mp, actorId, entry.rec[field]);
      if (want) addSpellTo(mp, actorId, want);
    } catch (e) {
      this.log(`[needs] ${field} swap failed for ${hex(actorId)}: ${e}`);
      return false;
    }
    entry.rec[field] = want;
    this.write(ctx, actorId, entry.rec);
    return true;
  }

  private sendState(ctx: SystemContext, actorId: number, closeCrafting: boolean, force = false): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    const stage = this.hungerStage(entry.rec);
    const fatigueStage = this.fatigueStage(entry.rec);
    const payload = {
      customPacketType: STATE_PACKET,
      hunger: Math.round(100 - entry.rec.hunger * 100 / HUNGER_MAX),
      stage,
      stageName: HUNGER_STAGE_NAMES[stage],
      fatigue: pct(entry.rec.fatigue),
      fatigueStage,
      fatigueStageName: FATIGUE_STAGE_NAMES[fatigueStage],
      staminaPenalty: this.penalties ? share(attributePenaltyShare(entry.rec.hunger, this.stages[1], HUNGER_MAX)) : 0,
      magickaPenalty: this.penalties ? share(attributePenaltyShare(this.exhaustion(entry.rec), this.fatigueStages[1], this.exhaustionMax)) : 0,
      survivalMode: this.survivalModeFlag,
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
        v: 2,
        hunger: clamp(Number(raw.hunger) || 0, 0, HUNGER_MAX),
        fatigue: raw.fatigue === undefined ? 1 : clamp(Number(raw.fatigue) || 0, 0, 1),
        at: Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now(),
        stageSpell: Number(raw.stageSpell) >>> 0,
        fatigueSpell: Number(raw.fatigueSpell) >>> 0,
        wellFed: raw.wellFed === true,
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
  private craftsPerHour = DEFAULT_CRAFTS_PER_HOUR.slice();
  private memberMult = 0.5;
  private imperialMult = 0.75;
  private regenPerMinute = 0.016;
  private fatigueOffline = true;
  private fatigueStages = DEFAULT_FATIGUE_STAGES.slice();
  private fatigueAbilities = true;
  private exhaustionMax = DEFAULT_EXHAUSTION_MAX;
  private killFatigue = DEFAULT_KILL_FATIGUE;
  private killFatigueWarrior = DEFAULT_KILL_FATIGUE_WARRIOR;
  private chopWoodPerBar = DEFAULT_CHOP_WOOD_PER_BAR.slice();
  private mineFatigue = DEFAULT_WORK_FATIGUE;
  private mineFatigueOwn = DEFAULT_WORK_FATIGUE_OWN_TRADE;
  private pickFatigue = DEFAULT_PICK_FATIGUE;
  private penalties = true;
  private survivalModeFlag = true;

  private hungerSpells: number[] = [];
  private fatigueSpells: number[] = [];
  private freeBenches = new Set<number>();
  // Recipe id -> share of its bench's craft cost, and bench keyword -> the smallest share of its recipes
  private recipeMult = new Map<number, number>();
  private benchMult = new Map<number, number>();
  // Hunger effect id -> hunger points, from needsFoodHunger
  private foodHunger = new Map<number, number>();
  private foodCache = new Map<number, FoodEffect[]>();
  private amountCache = new Map<number, number>();
  private online = new Map<number, Online>();
  private queue: Queued[] = [];
  private flushScheduled = false;
  private lastNoticeAt = new Map<number, number>();
  private nextTickAt = 0;
}
