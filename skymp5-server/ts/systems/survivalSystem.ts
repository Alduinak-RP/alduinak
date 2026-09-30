import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT, CREATION_FINISHED_EVENT } from "./system";
import { isEditorId, resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { ActorValue, SpellType, abilityResist, actorRaceId, fieldData, hasCureDisease, learnedSpells, potionHealing, spellEffects, spellInfo, view } from "./espmMagic";
import { baseIdOf, chainMpHook, hex, isAlive, isCreationPending, removeSpellFrom, userOf } from "./actorUtil";
import { sendJson } from "./playerText";
import { NeedsModifierSource, attributePenaltyShare } from "./needsSystem";
import { RacialSystem } from "./racialSystem";
import { HuntingSystem } from "./huntingSystem";
import { WeatherSystem } from "./weatherSystem";
import { gameHourNow } from "./timeSystem";
import { AbilityGroup, LOAD_PACKETS, StageAbilityTracker } from "./stageAbilities";
import { HEAT_INTERIORS, HEAT_SOURCE_INPUTS, HEAT_WORLDS } from "./heatSources";
import {
  AreaClass, COLD_MAX, COLD_STAGE_NAMES, ColdConfig, WeatherAdd, WornArmor, areaOf, coldCapOf, coldLevelOf, coldRatePerSec, coldStageOf, gearWarmth,
  isFreezingWater, isNight, nearHeatPoint, parseColdSettings, stepCold, temperatureLevelOf, warmthReduction, weatherAddOf,
} from "./survivalClimate";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Survival: the server keeps every Survival Mode rule (no Survival Papyrus runs on a client): the body rules, raw meat food poisoning,
// the cure, the shrines and cold.
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
// Cold runs 0 to 1000 on Survival Mode's stages (survivalClimate.ts): every COLD_TICK_MS the character's area (cold lists, world and
// region tables, height), night, the region's weather and freezing water give a cold level that caps how far cold rises and how fast,
// slowed by warmth (worn clothing ratings, a torch, the race's warmth, a hot meal) and times the race's coldRateMult; above the cap it
// falls unless the character fought in the last FIGHT_MS. Standing at a heat source (heatSources.ts) warms, frost spells and venom chill,
// fire spells and hot food warm. The stage ability Survival_ColdStage0..5 follows the stage and the client takes the maximum health
// penalty from survivalState. Cold falls while logged out and starts over at a respawn.
//
// Wire protocol - CustomPacket JSON:
//   Client -> Server: { customPacketType: "survivalRequest" }  state again; it, needsRequest, weatherRequest and gameTimeRequest schedule the login re-send
//                     { customPacketType: "survivalReport", swimming, flameCloak, engineWarmth? }  on change, engineWarmth after equipment changes
//   Server -> Client: { customPacketType: "survivalState", cold, coldStage, coldStageName, coldPenalty, temperatureLevel, warmth, freezingArea,
//                       afflictions: [name], diseases: [{ name, stage }] }
//                     cold 0-1000 and coldStage 0-5, both -1 with cold off; coldPenalty is the 0-1 share of maximum health removed;
//                     temperatureLevel sets Survival_TemperatureLevel (0 neutral, 1 near heat, 2 warming, 3 cooling, 4 freezing);
//                     freezingArea sets AldSurvival_FreezingArea
//                     { customPacketType: "masteryNotice", text }
//
// Persistence: private.survival = { v, at, body: { spells: [desc], respawn }, foodPoisonUntil, foodPoisonSpell: desc, cold, coldSpell: desc,
// warmBonus, warmUntil } on the character's actor form; spells are stored as "id:Plugin" descs, never raw form ids. Written at stage changes,
// events, logout and every SAVE_MS while cold moves. private.healthScale (1 - the penalty) only with survivalColdHealthScale.
//
// server-settings.json keys (all optional):
//   survivalEnabled               true runs survival, default false; one of the manager's PROTECTED_SETTINGS, so Migrate settings leaves it
//   survivalRespawnHealth         health share a respawn wakes with, in (0, 1], default 0.01; 1 turns the rule off
//   survivalCarryWeightSpell      editor id or desc of the carry weight ability, default "Survival_abLowerCarryWeightSpell"; "" turns it off
//   survivalNoHealthRegen         false grants no AldSurvival_AbNoHealthRegen, default true
//   survivalFreezingWater         false grants no AldSurvival_FreezingWaterDamage and no freezing water cold, default true
//   survivalFoodPoisoningChance   chance raw meat poisons before disease resistance, 0 to 1, default 0.5; 0 turns it off
//   survivalFoodPoisoningHours    real hours food poisoning lasts, offline included, default 24
//   survivalRawMeatExtra          editor ids, hex ids or descs of more raw meat, default []
//   survivalCure                  "cureDiseaseOrHealth" (default) or "cureDisease" (Cure Disease potions only)
//   survivalCureMinHealth         health a potion must restore to cure under cureDiseaseOrHealth, default 25
//   survivalColdEnabled           false stops cold and warmth, default true
//   survivalColdHoursToNumb       real hours in which cold level 20 with no warmth fills the bar, default 1.3334
//   survivalColdLevelMult         Survival_ColdLevelMult, default 50
//   survivalColdStages            cold at which stages 1-5 begin, default [50, 120, 300, 500, 800]
//   survivalColdStart             cold of a new character and after a respawn, default 55
//   survivalColdLevels            { warm, cool, freezing, chillyInterior, warmNight, coolNight, freezingNight, rain, snow, blizzard, freezingWater },
//                                 default { 0, 3, 6, 6, 1, 2, 4, 3, 6, 10, 30 }
//   survivalColdLevelCaps         cold level that lets cold reach stages 1-5, default [1, 4, 7, 10, 13]
//   survivalNightHours            [after, before], default [19, 7]
//   survivalRegionClimate         { "<weather region id>": "warm" | "cool" | "freezing" | "none" } over the defaults of survivalClimate.ts
//   survivalWorldClimate          { "<worldspace editor id>": class } over the defaults (the walled cities, the realms)
//   survivalHighAltitude          { freezingZ: 19000, "<weather region id>": height }: freezing above, default { freezingZ 19000, fallForest 15150 }
//   survivalColdWarmPerMinute     fall per minute above the level's cap, default 40
//   survivalColdOfflineWarmPerHour  fall per hour logged out, down to survivalColdStart, default 1000
//   survivalHeatRadius / survivalHeatRestore / survivalHeatCheckSeconds / survivalHeatStillUnits  default 580 / 75 / 6 / 48
//   survivalHeatExtraBases / survivalHeatKeywords  read by misc/gen-heat-sources.py; the boot line says when heatSources.ts was made from others
//   survivalWarmth                { normal, warm, cold: [body, head, hands, feet], torch, cloak, max, maxReduction }, default
//                                 { [27, 18, 13, 13], [54, 29, 24, 24], [17, 8, 7, 7], 50, 0, 206, 0.85 }
//   survivalHotFoodWarmth / survivalHotFoodWarmthMinutes  warmth of a hot meal and for how long, default 25 / 100
//   survivalSpellHitCold          cold of a frost spell hit (up to stage 4) and warmth of a fire one (down to stage 2), default 30
//   survivalColdOnHit             { "<race editor id fragment>": cold } for hits by those races, default { frostbitespider: 30, falmer: 30 }
//   survivalColdKills             true kills at 1000, default false
//   survivalColdStageAbilities    false grants no Survival_ColdStage abilities, default true
//   survivalColdHealthPenalty     false sends no maximum health penalty, default true
//   survivalColdMaxHealthPenalty  largest share of maximum health cold takes, default 0.8
//   survivalColdHealthScale       true also writes private.healthScale for the native health scale, default false
//   survivalFreezingWaterWorlds   worldspace editor ids whose water always freezes, default ["DLC1HunterHQWorld"]

const SURVIVAL_PROP = "private.survival";
const HEALTH_SCALE_PROP = "private.healthScale";
const NOTICE_PACKET = "masteryNotice";
const STATE_PACKET = "survivalState";
const REQUEST_PACKET = "survivalRequest";
const REPORT_PACKET = "survivalReport";
const NEEDS_REQUEST_PACKET = "needsRequest";
const HIT_EVENT = "onPapyrusEvent:OnHit";
const POLL_MS = 1000;
const TICK_MS = 60000;
const COLD_TICK_MS = 15000;
const SAVE_MS = 5 * 60000;
// A hit given or taken this recently stops cold falling above the cap
const FIGHT_MS = 10000;
const REPORT_GAP_MS = 250;
const SHRINE_NOTICE_GAP_MS = 60000;
const HOUR_MS = 3600000;
const GRID = 4096;
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
const COLD_SPELLS = COLD_STAGE_NAMES.map((_, i) => `Survival_ColdStage${i}`);
const COLD_LISTS = {
  oblivion: "Survival_OblivionAreas",
  interiorAreas: "Survival_InteriorAreas",
  coldCells: "Survival_ColdInteriorCells",
  coldLocations: "Survival_ColdInteriorLocations",
  blizzard: "Survival_BlizzardWeather",
  ash: "Survival_AshWeather",
};
const COLD_KEYWORDS = { warm: "Survival_ArmorWarm", cold: "Survival_ArmorCold", bodyAndHead: "Survival_BodyAndHead", frost: "MagicDamageFrost", fire: "MagicDamageFire" };
const COLD_EFFECTS = { restoreCold: "Survival_FoodRestoreCold", warmth: "Survival_FoodFortifyWarmth" };
// ALCH ENIT flags at offset 4
const ENIT_FOOD = 0x2;
const ENIT_POISON = 0x20000;

export type CureMode = "cureDisease" | "cureDiseaseOrHealth";
const CURE_MODES: CureMode[] = ["cureDisease", "cureDiseaseOrHealth"];

// Emitted on SystemContext.gm (actorId, by, done(ok)) by the admin panel: an online character loses food poisoning, starts over at the
// new-character cold and gets its body rules again
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
  cold: number;
  // Desc of the cold stage ability held, "" for none
  coldSpell: string;
  // Survival's hasBonus: set when warming reaches 0, cleared once cold reaches the stage 1 value
  warmBonus: boolean;
  // Epoch ms a hot meal's warmth runs out
  warmUntil: number;
}

interface Place {
  interior: boolean;
  chilly: boolean;
  oblivion: boolean;
  worldEdid: string;
}

interface Online {
  actorId: number;
  userId: number;
  rec: SurvivalRecord;
  // The body rules wait for the login delay, or for a pending creation to finish
  bodyDue: boolean;
  // Spells removed this session, replayed as not held by the login re-send
  revoked: number[];
  // Cold stepped and heat checked then; 0 until the body rules ran
  coldAt: number;
  heatAt: number;
  heatPos: number[] | null;
  nearHeat: boolean;
  // Cold when a warm-up at a heat source began, -1 when not warming
  heatFrom: number;
  swimming: boolean;
  flameCloak: boolean;
  inFreezingWater: boolean;
  reportAt: number;
  fightAt: number;
  area: AreaClass | "";
  areaWhy: string;
  freezingArea: boolean;
  level: number;
  levelParts: string[];
  temperature: number;
  warmth: number;
  gear: number;
  wornKey: string;
  // Offline warming applied at login, for the login line
  offline: string;
  sent: string;
  savedAt: number;
  savedCold: number;
  engineSeen: string;
  healthScale: number;
  killed: boolean;
}

interface ArmorInfo {
  armor: WornArmor | null;
  torch: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const round = (v: number): number => Math.round(v * 100) / 100;
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
const emptyRecord = (cold: number): SurvivalRecord => ({ v: 1, at: Date.now(), body: { spells: [], respawn: 1 }, foodPoisonUntil: 0, foodPoisonSpell: "", cold, coldSpell: "", warmBonus: false, warmUntil: 0 });

export class SurvivalSystem implements System, NeedsModifierSource {
  systemName = "SurvivalSystem";
  label = "survival";

  constructor(private log: Log, private racial: RacialSystem, private hunting: HuntingSystem, private weather: WeatherSystem) {
    this.abilities = new StageAbilityTracker("survival", log);
  }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const { problems, extraMeat } = this.configure((s.allSettings || {}) as Record<string, unknown>);
    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));
    if (!this.enabled) {
      this.log(`[survival] off (survivalEnabled false): no survival rule runs; the body abilities, the respawn health, food poisoning and the cold stage ability an earlier session granted are undone at each character's login${problems.length ? `; ignored: ${problems.join("; ")}` : ""}`);
      return;
    }
    const counts = await this.resolveForms(ctx, extraMeat, s.dataDir, s.loadOrder, problems);
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => this.onCreationFinished(actorId >>> 0));
    ctx.gm.on(SURVIVAL_RESET_EVENT, (actorId: number, by: string, done?: (ok: boolean) => void) => done?.(this.resetBy(ctx, actorId >>> 0, by)));
    this.installHooks(ctx);
    const heat = this.buildHeatIndex(ctx.svr as Mp);
    const bodyLine = this.body.map((b) => `${b.label} ${!b.name ? "off" : b.id ? `${b.name} (${hex(b.id)})` : `${b.name} not in the load order, skipped`}`).join(", ");
    const cureLine = this.cureMode === "cureDiseaseOrHealth" ? `Cure Disease potions and potions restoring ${this.cureMinHealth}+ health (those also remove every Disease spell)` : "Cure Disease potions only";
    this.log(`[survival] ready: body rules respawn health ${pct(this.respawnHealth)}, ${bodyLine}; raw meat ${this.rawMeat.size} foods (${counts.list} ${RAW_MEAT_LIST}, ${counts.hunting} hunting, ${counts.extra} extra), food poisoning ${pct(this.poisonChance)} x (1 - disease resist) for ${this.poisonMs / HOUR_MS} h ${this.foodPoison ? `(${hex(this.foodPoison)})` : "(spell not in the load order, never given)"}, races safe from raw meat per racialPassives rawMeatSafe; cure by ${cureLine}, clearing food poisoning and ${this.afflictions.length} affliction abilities; shrines ${this.altars.size} altar bases, no cure, a notice at most once a minute`);
    this.log(this.coldLine(heat));
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
    this.cold = parseColdSettings(all, problems);
    return { problems, extraMeat };
  }

  // Body spells, food poisoning, afflictions, raw meat, altars and the cold records; returns the raw meat counts by source
  private async resolveForms(ctx: SystemContext, extraMeat: string[], dataDir: string, loadOrder: string[], problems: string[]): Promise<{ list: number; hunting: number; extra: number }> {
    const mp = ctx.svr as Mp;
    const coldNames = [...COLD_SPELLS, ...Object.values(COLD_LISTS), ...Object.values(COLD_KEYWORDS), ...Object.values(COLD_EFFECTS)];
    const names = [...this.body.map((b) => b.name).filter((n) => n && isEditorId(n)), FOOD_POISONING_SPELL, ...AFFLICTION_SPELLS, RAW_MEAT_LIST, ALTAR_LIST, ...extraMeat.filter(isEditorId), ...coldNames];
    const scan = await resolveEditorIds(names, dataDir, loadOrder, this.log, ["SPEL", "FLST", "ALCH", "INGR", "KYWD", "MGEF"]);
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
    const listOf = (name: string): Set<number> => new Set(espmFieldFormIds(lookup(idOf(name)), "LNAM"));
    for (const b of this.body) b.id = b.name ? idOf(b.name) : 0;
    this.foodPoison = idOf(FOOD_POISONING_SPELL);
    this.afflictions = AFFLICTION_SPELLS.map(idOf).filter((id) => id);
    const listed = espmFieldFormIds(lookup(idOf(RAW_MEAT_LIST)), "LNAM");
    const hunted = this.hunting.rawMeatIds();
    const extra = extraMeat.map(idOf);
    extraMeat.forEach((name, i) => { if (!extra[i]) problems.push(`survivalRawMeatExtra ${name} is not in the load order`); });
    this.rawMeat = new Set([...listed, ...hunted, ...extra.filter((id) => id)]);
    this.altars = listOf(ALTAR_LIST);
    this.coldSpells = COLD_SPELLS.map(idOf);
    this.oblivionAreas = listOf(COLD_LISTS.oblivion);
    this.interiorAreas = listOf(COLD_LISTS.interiorAreas);
    this.coldCells = listOf(COLD_LISTS.coldCells);
    this.coldLocations = listOf(COLD_LISTS.coldLocations);
    this.blizzard = listOf(COLD_LISTS.blizzard);
    this.ash = listOf(COLD_LISTS.ash);
    this.keywords = { warm: idOf(COLD_KEYWORDS.warm), cold: idOf(COLD_KEYWORDS.cold), bodyAndHead: idOf(COLD_KEYWORDS.bodyAndHead), frost: idOf(COLD_KEYWORDS.frost), fire: idOf(COLD_KEYWORDS.fire) };
    this.coldEffects = { restoreCold: idOf(COLD_EFFECTS.restoreCold), warmth: idOf(COLD_EFFECTS.warmth) };
    const missing = [FOOD_POISONING_SPELL, ...AFFLICTION_SPELLS, RAW_MEAT_LIST, ALTAR_LIST, ...coldNames].filter((n) => !idOf(n));
    if (missing.length) this.log(`[survival] not in the load order, ignored: ${missing.join(", ")}`);
    return { list: listed.length, hunting: hunted.length, extra: extra.filter((id) => id).length };
  }

  // Heat source positions by cell and world id; returns the counts for the boot line
  private buildHeatIndex(mp: Mp): { interiors: number; worlds: number; points: number; unknown: number } {
    const idOf = (desc: string): number => { try { return mp.getIdFromDesc(desc) >>> 0; } catch { return 0; } };
    let points = 0;
    let unknown = 0;
    for (const [desc, list] of Object.entries(HEAT_INTERIORS)) {
      const id = idOf(desc);
      if (!id) { unknown++; continue; }
      this.heatInteriors.set(id, list);
      points += list.length;
    }
    for (const [desc, grids] of Object.entries(HEAT_WORLDS)) {
      const id = idOf(desc);
      if (!id) { unknown++; continue; }
      this.heatWorlds.set(id, new Map(Object.entries(grids)));
      for (const list of Object.values(grids)) points += list.length;
    }
    return { interiors: this.heatInteriors.size, worlds: this.heatWorlds.size, points, unknown };
  }

  private coldLine(heat: { interiors: number; worlds: number; points: number; unknown: number }): string {
    const c = this.cold;
    if (!c.enabled) return `[survival] cold off (survivalColdEnabled false): no cold, warmth or stage abilities; freezing water area ${c.freezingWater ? "still sent for the water damage" : "off"}`;
    const l = c.levels;
    const w = c.warmth;
    const classes: Record<string, number> = {};
    for (const cls of Object.values(c.regionClimate)) classes[cls] = (classes[cls] || 0) + 1;
    const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    const genNote = same(c.heatKeywords, HEAT_SOURCE_INPUTS.keywords) && same(c.heatExtraBases, HEAT_SOURCE_INPUTS.extraBases) ? "" :
      `; heatSources.ts was made from keywords ${HEAT_SOURCE_INPUTS.keywords.join("/") || "none"} and extra bases ${HEAT_SOURCE_INPUTS.extraBases.join("/") || "none"}, not survivalHeatKeywords ${c.heatKeywords.join("/") || "none"} and survivalHeatExtraBases ${c.heatExtraBases.join("/") || "none"}: rerun misc/gen-heat-sources.py`;
    const spells = this.coldSpells.filter((id) => id).length;
    return `[survival] cold: +${c.levelMult} x level per ${c.hoursToNumb} h (level 20 bare fills the bar), stages ${c.stages.join("/")}, start ${c.start}; levels warm ${l.warm}, cool ${l.cool}, freezing ${l.freezing}, cold interior ${l.chillyInterior}, night +${l.warmNight}/+${l.coolNight}/+${l.freezingNight} (${c.night[0]}-${c.night[1]} h), rain +${l.rain}, snow +${l.snow}, blizzard +${l.blizzard} (${this.blizzard.size} blizzard weathers, ${this.ash.size} ash weathers count as no snow), freezing water ${l.freezingWater}${c.freezingWater ? ` (freezing areas, cold interiors, worlds ${c.freezingWaterWorlds.join("/") || "none"}), up to ${c.stages[2]} at once` : " off"}; caps at levels ${c.caps.join("/")}; falls ${c.warmPerMinute}/min above the cap unless fighting in the last ${FIGHT_MS / 1000} s, ${c.offlineWarmPerHour}/h offline down to ${c.start}; ` +
      `areas: ${this.oblivionAreas.size} Oblivion worlds none, ${this.interiorAreas.size} worlds as interiors, ${this.coldCells.size} cold cells and ${this.coldLocations.size} cold locations, worlds ${Object.entries(c.worldClimate).map(([k, v]) => `${k} ${v}`).join(", ")}, above ${c.freezingZ} freezing, regions ${Object.entries(classes).map(([k, n]) => `${n} ${k}`).join(", ")}, heights ${Object.entries(c.highRegions).map(([k, z]) => `${k} ${z}`).join(", ") || "none"}, anything else cool; ` +
      `heat ${heat.points} sources (${heat.interiors} interiors, ${heat.worlds} worlds${heat.unknown ? `, ${heat.unknown} cells or worlds not in the load order` : ""}) within ${c.heatRadius} warm ${c.heatRestore} every ${c.heatCheckSeconds} s to a character standing (moved under ${c.heatStillUnits} units)${genNote}; ` +
      `warmth normal ${w.normal.join("/")}, warm ${w.warm.join("/")}, cold ${w.cold.join("/")}, torch ${w.torch}, cloak ${w.cloak}, up to ${w.max} for ${pct(w.maxReduction)} less cold, race per racialPassives warmth, hot meal ${c.hotFoodWarmth} for ${c.hotFoodMinutes} min; ` +
      `spell hits ${c.spellHitCold} (frost up to ${c.stages[3]}, fire down to ${c.stages[1]}), hits by ${Object.entries(c.coldOnHit).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ` +
      `stage abilities ${c.stageAbilities ? `on (${spells} of 6 in the load order)` : "off"}, health penalty ${c.healthPenalty ? `from ${c.stages[1]}, at most ${pct(c.maxHealthPenalty)}` : "off"}, health scale ${c.healthScale ? "written to private.healthScale" : "off"}, death at ${COLD_MAX} ${c.kills ? "on" : "off"}; weather regions ${this.weather?.regionOf ? "read" : "unavailable"}`;
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
    chainMpHook(mp, HIT_EVENT, (...args: unknown[]) => this.onHit(ctx, args));
    chainMpHook(mp, "onRespawn", (rawId: number) => {
      const actorId = Number(rawId) >>> 0;
      if (this.online.has(actorId)) setImmediate(() => this.onRespawn(ctx, actorId));
    });
  }

  private onEat(ctx: SystemContext, actorId: number, baseId: number): void {
    if (!this.online.has(actorId)) return;
    const mp = ctx.svr as Mp;
    if (this.rawMeat.has(baseId)) setImmediate(() => this.rollFoodPoisoning(ctx, actorId, baseId));
    const cure = this.cureKindOf(mp, baseId);
    if (cure) setImmediate(() => this.cure(ctx, actorId, baseId, cure));
    const hot = this.cold.enabled ? this.hotFoodOf(mp, baseId) : null;
    if (hot) setImmediate(() => this.eatHot(ctx, actorId, baseId, hot));
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

  // Cold a hot meal takes off (Survival_FoodRestoreCold's magnitude) and whether it warms (Survival_FoodFortifyWarmth); null for other food
  private hotFoodOf(mp: Mp, baseId: number): { restore: number; warms: boolean } | null {
    let hot = this.hotFoodCache.get(baseId);
    if (hot === undefined) {
      const effects = spellEffects(mp, baseId);
      const restore = effects.filter((e) => e.mgefId && e.mgefId === this.coldEffects.restoreCold).reduce((s, e) => s + e.magnitude, 0);
      const warms = effects.some((e) => e.mgefId && e.mgefId === this.coldEffects.warmth);
      hot = restore > 0 || warms ? { restore, warms } : null;
      this.hotFoodCache.set(baseId, hot);
    }
    return hot;
  }

  // Marks the fight for both sides and, for an online target, the cold a frost or fire spell or a venomous race's hit brings
  private onHit(ctx: SystemContext, args: unknown[]): void {
    const mp = ctx.svr as Mp;
    const targetId = Number(args[0]) >>> 0;
    const aggressorId = this.formIdOf(mp, args[1]);
    const now = Date.now();
    const target = this.online.get(targetId);
    const aggressor = aggressorId ? this.online.get(aggressorId) : undefined;
    if (aggressor) aggressor.fightAt = now;
    if (!target) return;
    target.fightAt = now;
    if (!this.cold.enabled || target.bodyDue) return;
    const spell = this.spellColdOf(mp, this.formIdOf(mp, args[2]));
    const venom = !spell && args[7] !== true && aggressorId ? this.venomColdOf(mp, aggressorId) : null;
    const hit = spell || venom;
    if (hit) setImmediate(() => this.hitCold(ctx, targetId, hit.amount, hit.why));
  }

  // +cold for a frost spell, -cold for a fire one, from the effects' MagicDamageFrost and MagicDamageFire keywords
  private spellColdOf(mp: Mp, sourceId: number): { amount: number; why: string } | null {
    if (!sourceId || !this.cold.spellHitCold) return null;
    let sign = this.spellColdCache.get(sourceId);
    if (sign === undefined) {
      sign = 0;
      if (spellInfo(mp, sourceId).type !== -1) {
        for (const e of spellEffects(mp, sourceId)) {
          let kws: number[] = [];
          try { kws = espmFieldFormIds(mp.lookupEspmRecordById(e.mgefId), "KWDA"); } catch { kws = []; }
          if (this.keywords.frost && kws.indexOf(this.keywords.frost) !== -1) sign = 1;
          else if (this.keywords.fire && kws.indexOf(this.keywords.fire) !== -1 && !sign) sign = -1;
        }
      }
      this.spellColdCache.set(sourceId, sign);
    }
    return sign ? { amount: sign * this.cold.spellHitCold, why: `${sign > 0 ? "frost" : "fire"} spell ${this.edidOf(mp, sourceId)}` } : null;
  }

  // survivalColdOnHit by the aggressor's race editor id, longest fragment first
  private venomColdOf(mp: Mp, aggressorId: number): { amount: number; why: string } | null {
    const raceId = actorRaceId(mp, aggressorId);
    if (!raceId) return null;
    let hit = this.venomCache.get(raceId);
    if (hit === undefined) {
      const edid = this.edidOf(mp, raceId);
      const key = Object.keys(this.cold.coldOnHit).sort((a, b) => b.length - a.length).find((k) => edid.toLowerCase().includes(k.toLowerCase()));
      hit = key && this.cold.coldOnHit[key] > 0 ? { amount: this.cold.coldOnHit[key], why: `hit by ${edid}` } : null;
      this.venomCache.set(raceId, hit);
    }
    return hit;
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
    if (!this.enabled && !(stored && (stored.body.spells.length || stored.body.respawn < 1 || stored.foodPoisonUntil || stored.coldSpell)) && !this.scaled(mp, actorId)) return;
    const rec = stored || emptyRecord(this.cold.start);
    const now = Date.now();
    const entry: Online = {
      actorId, userId, rec, bodyDue: !isCreationPending(mp, actorId), revoked: [], coldAt: 0, heatAt: 0, heatPos: null, nearHeat: false, heatFrom: -1,
      swimming: false, flameCloak: false, inFreezingWater: false, reportAt: 0, fightAt: 0, area: "", areaWhy: "", freezingArea: false, level: 0, levelParts: [],
      temperature: 0, warmth: 0, gear: 0, wornKey: "", offline: "", sent: "", savedAt: now, savedCold: rec.cold, engineSeen: "", healthScale: -1, killed: false,
    };
    if (stored && this.enabled && this.cold.enabled && rec.cold > this.cold.start) {
      const hours = Math.max(0, now - stored.at) / HOUR_MS;
      const before = rec.cold;
      rec.cold = Math.max(this.cold.start, rec.cold - this.cold.offlineWarmPerHour * hours);
      if (rec.cold !== before) entry.offline = `, warmed offline ${Math.round(hours * 10) / 10} h: ${Math.round(before)} -> ${Math.round(rec.cold)}`;
    }
    this.online.set(actorId, entry);
    this.abilities.begin(actorId);
  }

  private onCreationFinished(actorId: number): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    entry.bodyDue = true;
    Object.assign(entry.rec, { cold: this.cold.start, warmBonus: false, warmUntil: 0 });
  }

  disconnect(userId: number, ctx: SystemContext): void {
    for (const [actorId, entry] of Array.from(this.online.entries())) {
      if (entry.userId === userId) this.goOffline(ctx, actorId);
    }
    this.lastShrineAt.delete(userId);
  }

  private goOffline(ctx: SystemContext, actorId: number): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    if (this.enabled && entry.coldAt) this.save(ctx.svr as Mp, entry);
    this.online.delete(actorId);
    this.abilities.end(actorId);
  }

  // A once-per-load packet schedules the re-send of anything changed inside the login window; a request also sends the state again
  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type === REPORT_PACKET) return this.onReport(ctx, userId, content || {});
    if (type !== REQUEST_PACKET && type !== NEEDS_REQUEST_PACKET && !LOAD_PACKETS.has(type)) return;
    for (const [actorId, entry] of this.online) {
      if (entry.userId !== userId) continue;
      this.abilities.scheduleResend(actorId);
      if (type === REQUEST_PACKET && entry.coldAt) this.sendState(ctx.svr as Mp, entry, true);
    }
  }

  // Swimming and a flame cloak, as the client's engine sees them, applied at once unless reports come faster than REPORT_GAP_MS;
  // engineWarmth is the inventory's Warmth total
  private onReport(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    const now = Date.now();
    for (const entry of this.online.values()) {
      if (entry.userId !== userId || !entry.coldAt) continue;
      const swimming = content["swimming"] === true;
      const flameCloak = content["flameCloak"] === true;
      const changed = swimming !== entry.swimming || flameCloak !== entry.flameCloak;
      entry.swimming = swimming;
      entry.flameCloak = flameCloak;
      if (now - entry.reportAt < REPORT_GAP_MS) continue;
      entry.reportAt = now;
      const engineWarmth = content["engineWarmth"];
      if (typeof engineWarmth === "number" && Number.isFinite(engineWarmth)) this.checkWarmth(mp, entry, engineWarmth, now);
      if (changed) this.step(ctx, entry.actorId, entry, now);
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
          else {
            if (tick) this.expire(ctx, actorId, entry, now);
            if (this.enabled && now - entry.heatAt >= this.cold.heatCheckSeconds * 1000) this.heatCheck(ctx, actorId, entry, now);
            if (this.enabled && now - entry.coldAt >= COLD_TICK_MS) this.step(ctx, actorId, entry, now);
          }
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
    const heldCold = this.idOfDesc(mp, rec.coldSpell);
    if (rec.coldSpell && !(this.enabled && this.cold.enabled && this.cold.stageAbilities)) {
      if (heldCold) this.abilities.swap(mp, actorId, heldCold, 0, "cold stage");
      removed.push(heldCold ? this.edidOf(mp, heldCold) : rec.coldSpell);
      rec.coldSpell = "";
    }
    if (!(this.enabled && this.cold.enabled && this.cold.healthScale)) this.setHealthScale(mp, entry, 1);
    const respawn = this.enabled ? this.respawnHealth : 1;
    const respawnChanged = this.setRespawn(mp, actorId, respawn);
    rec.body = { spells: wantDescs, respawn };
    if (this.enabled) this.expire(ctx, actorId, entry, now);
    this.save(mp, entry);
    if (!this.enabled) {
      this.log(`[survival] ${hex(actorId)} body rules off: respawn 100%${respawnChanged ? "" : " (already)"}, abilities removed: ${removed.join(", ") || "none"}`);
      return;
    }
    const poisoned = rec.foodPoisonUntil ? `food poisoning until ${clock(rec.foodPoisonUntil)}` : "no food poisoning";
    const cold = this.startCold(ctx, actorId, entry, now);
    this.log(`[survival] ${hex(actorId)} body: ${parts.join(", ")}, respawn health ${pct(respawn)}${respawnChanged ? " (set)" : ""}${removed.length ? `, removed ${removed.join(", ")}` : ""}, ${poisoned}; ${cold}`);
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
    this.save(mp, entry);
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
    this.save(mp, entry);
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
    this.save(mp, entry);
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
    Object.assign(entry.rec, { cold: this.cold.start, warmBonus: false, warmUntil: 0 });
    this.save(mp, entry);
    entry.bodyDue = true;
    this.log(`[survival] ${hex(actorId)} reset by ${by}`);
    return true;
  }

  // ── Cold ───────────────────────────────────────────────────────────────────

  // After the body rules: the stage ability and the first step; returns the cold part of the login line
  private startCold(ctx: SystemContext, actorId: number, entry: Online, now: number): string {
    const mp = ctx.svr as Mp;
    entry.coldAt = now;
    entry.heatAt = now;
    this.step(ctx, actorId, entry, now, true);
    const where = entry.area ? `, freezing water area ${entry.freezingArea ? "yes" : "no"}` : ", place not known yet";
    if (!this.cold.enabled) return `cold off${where}`;
    this.syncColdStage(mp, actorId, entry);
    const offline = entry.offline;
    entry.offline = "";
    const ability = this.edidOf(mp, this.idOfDesc(mp, entry.rec.coldSpell)) || "none";
    return `cold ${Math.round(entry.rec.cold)} (${COLD_STAGE_NAMES[this.stageOf(entry)]})${offline}${entry.area ? `, ${this.climateNote(entry)}` : ""}${where}, cold ability ${ability}`;
  }

  // Climate, warmth and cold for the time since the last step; sends the state when it changed
  private step(ctx: SystemContext, actorId: number, entry: Online, now: number, force = false): void {
    const mp = ctx.svr as Mp;
    const seconds = Math.max(0, now - entry.coldAt) / 1000;
    entry.coldAt = now;
    if (!this.climate(mp, actorId, entry)) return;
    if (this.cold.enabled && !isCreationPending(mp, actorId) && isAlive(mp, actorId)) {
      const rec = entry.rec;
      const before = rec.cold;
      const mult = this.racial.traits(actorId).coldRateMult;
      entry.warmth = this.warmthOf(mp, actorId, entry, now);
      let cold = before;
      if (entry.inFreezingWater && cold < this.cold.stages[2]) cold += (this.cold.stages[2] - cold) * clamp(mult, 0, 1);
      if (entry.area !== "none" && !entry.nearHeat) {
        const rate = coldRatePerSec(entry.level, entry.warmth, mult, this.cold);
        cold = stepCold(cold, seconds, coldCapOf(entry.level, this.cold), rate, this.cold.warmPerMinute / 60, now - entry.fightAt < FIGHT_MS);
      }
      entry.temperature = temperatureLevelOf(before, cold, entry.level, entry.nearHeat, entry.area as AreaClass, this.cold.caps);
      if (cold !== before) this.setCold(mp, actorId, entry, cold, "");
      if (now - entry.savedAt >= SAVE_MS && Math.abs(rec.cold - entry.savedCold) >= 1) this.save(mp, entry);
    }
    this.sendState(mp, entry, force);
  }

  // Area, cold level and freezing water; logs a change of area or of freezing water; false when the character is in no known place
  private climate(mp: Mp, actorId: number, entry: Online): boolean {
    let placeId = 0;
    let pos: number[] = [];
    try {
      placeId = mp.getActorCellOrWorld(actorId) >>> 0;
      pos = mp.getActorPos(actorId);
    } catch {
      return false;
    }
    if (!placeId || !Array.isArray(pos) || pos.length < 3) return false;
    const place = this.placeOf(mp, placeId);
    let regionId: string | null = null;
    try { regionId = !place.interior && this.weather?.regionOf ? this.weather.regionOf(mp, actorId) : null; } catch { regionId = null; }
    const { area, why } = areaOf({ ...place, z: Number(pos[2]) || 0, regionId }, this.cold);
    const freezingArea = isFreezingWater(area, place.worldEdid, this.cold);
    const inWater = freezingArea && entry.swimming && !entry.flameCloak;
    let weather: WeatherAdd = "";
    if (regionId && (area === "warm" || area === "cool" || area === "freezing")) {
      const w = this.weather.currentWeatherOf ? this.weather.currentWeatherOf(regionId) : null;
      if (w) weather = weatherAddOf(w.kind, this.blizzard.has(w.id), this.ash.has(w.id));
    }
    const { level, parts } = coldLevelOf(area, isNight(gameHourNow(), this.cold.night), weather, inWater, this.cold.levels);
    const hexId = hex(actorId);
    if (entry.area && (area !== entry.area || freezingArea !== entry.freezingArea)) {
      this.log(`[survival] ${hexId} area ${area} (${why}, world ${place.worldEdid || "interior"}, z ${Math.round(Number(pos[2]) || 0)})${freezingArea !== entry.freezingArea ? `, freezing water ${freezingArea ? "yes" : "no"}` : ""}`);
    }
    if (this.cold.enabled && inWater !== entry.inFreezingWater) {
      this.log(`[survival] ${hexId} ${inWater ? "swimming in freezing water: level" : "out of the freezing water: level"} ${level}, cold ${Math.round(entry.rec.cold)}`);
    }
    Object.assign(entry, { area, areaWhy: why, freezingArea, inFreezingWater: inWater, level, levelParts: parts });
    return true;
  }

  // Interior or world, the cold lists and Oblivion; cached per cell or world
  private placeOf(mp: Mp, placeId: number): Place {
    let place = this.placeCache.get(placeId);
    if (place) return place;
    let rec: any = null;
    try { rec = mp.lookupEspmRecordById(placeId); } catch { rec = null; }
    const type = String(rec?.record?.type ?? "");
    const location = espmFieldFormIds(rec, "XLCN")[0] || 0;
    const coldLocation = !!location && this.coldLocations.has(location);
    if (type === "WRLD") {
      const interior = this.interiorAreas.has(placeId);
      place = { interior, chilly: interior && coldLocation, oblivion: this.oblivionAreas.has(placeId), worldEdid: String(rec?.record?.editorId || hex(placeId)) };
    } else {
      place = { interior: true, chilly: this.coldCells.has(placeId) || coldLocation, oblivion: false, worldEdid: "" };
    }
    this.placeCache.set(placeId, place);
    return place;
  }

  // Worn clothing by engine rating, a torch, the race's warmth and a hot meal
  private warmthOf(mp: Mp, actorId: number, entry: Online, now: number): number {
    let entries: any[] = [];
    try { entries = mp.get(actorId, "equipment")?.inv?.entries ?? []; } catch { entries = []; }
    const worn = entries.filter((e) => e && (e.worn || e.wornLeft)).map((e) => Number(e.baseId) >>> 0).sort((a, b) => a - b);
    const key = worn.join(",");
    if (key !== entry.wornKey) {
      entry.wornKey = key;
      const infos = worn.map((id) => this.armorInfo(mp, id));
      entry.gear = gearWarmth(infos.map((i) => i.armor).filter((a): a is WornArmor => !!a), infos.some((i) => i.torch), this.cold.warmth);
    }
    return entry.gear + this.racial.traits(actorId).warmth + (entry.rec.warmUntil > now ? this.cold.hotFoodWarmth : 0);
  }

  // Slots and warmth keyword of an ARMO, or a carried light; cached per base
  private armorInfo(mp: Mp, baseId: number): ArmorInfo {
    let info = this.armorCache.get(baseId);
    if (info) return info;
    let rec: any = null;
    try { rec = mp.lookupEspmRecordById(baseId); } catch { rec = null; }
    const type = String(rec?.record?.type ?? "");
    info = { armor: null, torch: type === "LIGH" };
    if (type === "ARMO") {
      const bod = fieldData(rec, "BOD2") || fieldData(rec, "BODT");
      const kws = espmFieldFormIds(rec, "KWDA");
      const has = (id: number): boolean => !!id && kws.indexOf(id) !== -1;
      info.armor = {
        slots: bod && bod.byteLength >= 4 ? view(bod).getUint32(0, true) : 0,
        kind: has(this.keywords.warm) ? "warm" : has(this.keywords.cold) ? "cold" : "normal",
        bodyAndHead: has(this.keywords.bodyAndHead),
      };
    }
    this.armorCache.set(baseId, info);
    return info;
  }

  // The engine's Warmth total against the server's gear and race sum (a hot meal may count or not); one line per differing pair
  private checkWarmth(mp: Mp, entry: Online, engine: number, now: number): void {
    const gear = entry.gear;
    const race = this.racial.traits(entry.actorId).warmth;
    const food = entry.rec.warmUntil > now ? this.cold.hotFoodWarmth : 0;
    const server = gear + race;
    if (Math.abs(engine - server) <= 1 || (food && Math.abs(engine - server - food) <= 1)) return;
    const key = `${Math.round(engine)}/${Math.round(server)}`;
    if (entry.engineSeen === key) return;
    entry.engineSeen = key;
    this.log(`[survival] ${hex(entry.actorId)} warmth mismatch: engine ${round(engine)}, server ${round(server)} (gear ${gear}, race ${race}${food ? `, hot meal ${food} not counted` : ""}), worn ${entry.wornKey.split(",").filter((x) => x).map((id) => this.edidOf(mp, Number(id))).join(", ") || "nothing"}`);
  }

  // Every heatCheckSeconds: a character standing still at a heat source warms by heatRestore
  private heatCheck(ctx: SystemContext, actorId: number, entry: Online, now: number): void {
    entry.heatAt = now;
    if (!this.cold.enabled || entry.area === "none") return;
    const mp = ctx.svr as Mp;
    let placeId = 0;
    let pos: number[] = [];
    try {
      placeId = mp.getActorCellOrWorld(actorId) >>> 0;
      pos = mp.getActorPos(actorId);
    } catch {
      return;
    }
    const last = entry.heatPos;
    entry.heatPos = pos;
    const still = !!last && Math.hypot(pos[0] - last[0], pos[1] - last[1], pos[2] - last[2]) < this.cold.heatStillUnits;
    const near = still && this.nearHeat(placeId, pos);
    if (near && !entry.nearHeat) entry.heatFrom = entry.rec.cold;
    if (!near && entry.nearHeat && entry.heatFrom >= 0) {
      this.log(`[survival] ${hex(actorId)} warmed at a fire: cold ${Math.round(entry.heatFrom)} -> ${Math.round(entry.rec.cold)}`);
      entry.heatFrom = -1;
    }
    entry.nearHeat = near;
    if (!near) return;
    const before = entry.rec.cold;
    if (before > 0 && isAlive(mp, actorId)) this.setCold(mp, actorId, entry, before - this.cold.heatRestore, "");
    entry.temperature = temperatureLevelOf(before, entry.rec.cold, entry.level, true, entry.area as AreaClass, this.cold.caps);
    this.sendState(mp, entry, false);
  }

  private nearHeat(placeId: number, pos: number[]): boolean {
    const r = this.cold.heatRadius;
    const interior = this.heatInteriors.get(placeId);
    if (interior) return nearHeatPoint(interior, pos, r);
    const grids = this.heatWorlds.get(placeId);
    if (!grids) return false;
    const gx = Math.floor(pos[0] / GRID);
    const gy = Math.floor(pos[1] / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (nearHeatPoint(grids.get(`${gx + dx},${gy + dy}`), pos, r)) return true;
      }
    }
    return false;
  }

  // Frost spells and venom add up to the stage 4 value times the race multiplier, fire spells take off down to the stage 2 value
  private hitCold(ctx: SystemContext, actorId: number, amount: number, why: string): void {
    const entry = this.online.get(actorId);
    const mp = ctx.svr as Mp;
    if (!entry || !entry.coldAt || entry.area === "none") return;
    const before = entry.rec.cold;
    const s = this.cold.stages;
    let cold = before;
    if (amount > 0 && before < s[3]) cold = Math.min(s[3], before + amount * this.racial.traits(actorId).coldRateMult);
    else if (amount < 0 && before > s[1]) cold = Math.max(s[1], before + amount);
    if (cold === before) return;
    this.setCold(mp, actorId, entry, cold, why);
    this.sendState(mp, entry, false);
  }

  // A hot meal takes off its cold down to the stage 1 value and warms for survivalHotFoodWarmthMinutes
  private eatHot(ctx: SystemContext, actorId: number, baseId: number, hot: { restore: number; warms: boolean }): void {
    const entry = this.online.get(actorId);
    const mp = ctx.svr as Mp;
    if (!entry || !entry.coldAt) return;
    const before = entry.rec.cold;
    const warms = hot.warms && this.cold.hotFoodWarmth > 0;
    const now = Date.now();
    if (warms) entry.rec.warmUntil = now + this.cold.hotFoodMinutes * 60000;
    const floor = this.cold.stages[0];
    if (hot.restore > 0 && before > floor) this.setCold(mp, actorId, entry, Math.max(floor, before - hot.restore), "");
    entry.warmth = this.warmthOf(mp, actorId, entry, now);
    this.save(mp, entry);
    this.log(`[survival] ${hex(actorId)} ate hot ${this.edidOf(mp, baseId)}: cold ${Math.round(before)} -> ${Math.round(entry.rec.cold)}${warms ? `, warmth +${this.cold.hotFoodWarmth} until ${clock(entry.rec.warmUntil)}` : ""}`);
    this.sendState(mp, entry, false);
  }

  // A respawn wakes at the new-character cold
  private onRespawn(ctx: SystemContext, actorId: number): void {
    const entry = this.online.get(actorId);
    const mp = ctx.svr as Mp;
    if (!entry || !entry.coldAt || !this.cold.enabled) return;
    const before = entry.rec.cold;
    entry.rec.warmBonus = false;
    entry.killed = false;
    entry.swimming = false;
    this.setCold(mp, actorId, entry, this.cold.start, "");
    this.save(mp, entry);
    this.log(`[survival] ${hex(actorId)} respawned: cold ${Math.round(before)} -> ${this.cold.start}`);
    this.sendState(mp, entry, true);
  }

  // Sets cold with Survival's warm bonus, swaps the stage ability and tells the player when the stage changed, and kills at the maximum when asked
  private setCold(mp: Mp, actorId: number, entry: Online, value: number, why: string): void {
    const rec = entry.rec;
    const before = rec.cold;
    const stageBefore = this.stageOf(entry);
    rec.cold = clamp(value, 0, COLD_MAX);
    if (rec.cold <= 0 && before > 0) rec.warmBonus = true;
    if (rec.cold >= this.cold.stages[0]) rec.warmBonus = false;
    const stage = this.stageOf(entry);
    if (why) this.log(`[survival] ${hex(actorId)} ${why}: cold ${Math.round(before)} -> ${Math.round(rec.cold)}`);
    if (stage !== stageBefore) {
      this.syncColdStage(mp, actorId, entry);
      this.save(mp, entry);
      this.log(`[survival] ${hex(actorId)} cold ${Math.round(before)} -> ${Math.round(rec.cold)} (${COLD_STAGE_NAMES[stage]}), ${this.climateNote(entry)}`);
      if (stage > stageBefore && stage >= 2) {
        const penalty = this.cold.healthPenalty ? " Your maximum health is reduced." : "";
        this.notice(mp, actorId, `You are ${stage === 5 ? "numb with cold" : COLD_STAGE_NAMES[stage].toLowerCase()}:${penalty} Find warmth or a fire.`);
      } else if (stage === 0) {
        this.notice(mp, actorId, "You are warm.");
      }
    }
    if (this.cold.kills && rec.cold >= COLD_MAX && !entry.killed && isAlive(mp, actorId)) {
      entry.killed = true;
      this.log(`[survival] ${hex(actorId)} died of cold at ${COLD_MAX}`);
      try { mp.set(actorId, "isDead", true); } catch (e) { this.log(`[survival] killing ${hex(actorId)} failed: ${e}`); }
    }
  }

  private climateNote(entry: Online): string {
    const w = entry.warmth;
    return `level ${entry.level} (${entry.levelParts.join(", ")}; ${entry.areaWhy}), warmth ${round(w)} (${pct(warmthReduction(w, this.cold.warmth))} less cold)`;
  }

  private stageOf(entry: Online): number {
    return coldStageOf(entry.rec.cold, entry.rec.warmBonus, this.cold.stages);
  }

  // The stage ability of the stage now, or none with cold or its abilities off
  private syncColdStage(mp: Mp, actorId: number, entry: Online): void {
    const want = this.cold.enabled && this.cold.stageAbilities ? this.coldSpells[this.stageOf(entry)] || 0 : 0;
    const held = this.idOfDesc(mp, entry.rec.coldSpell);
    if (want === held || !this.abilities.swap(mp, actorId, held, want, "cold stage")) return;
    entry.rec.coldSpell = want ? this.descOf(mp, want) : "";
  }

  // Share of maximum health the cold takes, capped by survivalColdMaxHealthPenalty
  private penaltyOf(entry: Online): number {
    if (!this.cold.enabled || !this.cold.healthPenalty) return 0;
    return Math.min(this.cold.maxHealthPenalty, attributePenaltyShare(entry.rec.cold, this.cold.stages[1], COLD_MAX));
  }

  private sendState(mp: Mp, entry: Online, force: boolean): void {
    const on = this.cold.enabled;
    const penalty = Math.round(this.penaltyOf(entry) * 100) / 100;
    const stage = on ? this.stageOf(entry) : -1;
    const payload = {
      customPacketType: STATE_PACKET,
      cold: on ? Math.round(entry.rec.cold) : -1,
      coldStage: stage,
      coldStageName: on ? COLD_STAGE_NAMES[stage] : "",
      coldPenalty: penalty,
      temperatureLevel: on ? entry.temperature : 0,
      warmth: on ? Math.round(entry.warmth) : 0,
      freezingArea: entry.freezingArea,
      afflictions: [] as string[],
      diseases: [] as Array<{ name: string; stage: number }>,
    };
    if (this.cold.healthScale) this.setHealthScale(mp, entry, 1 - penalty);
    const key = JSON.stringify(payload);
    if (!force && key === entry.sent) return;
    entry.sent = key;
    sendJson(mp, entry.userId, payload);
  }

  // private.healthScale for the native health scale, written only when it changes
  private setHealthScale(mp: Mp, entry: Online, value: number): void {
    if (entry.healthScale === value) return;
    if (entry.healthScale < 0 && value === 1 && !this.scaled(mp, entry.actorId)) {
      entry.healthScale = 1;
      return;
    }
    entry.healthScale = value;
    try { mp.set(entry.actorId, HEALTH_SCALE_PROP, value); } catch (e) { this.log(`[survival] health scale for ${hex(entry.actorId)} failed: ${e}`); }
  }

  private scaled(mp: Mp, actorId: number): boolean {
    try {
      const v = mp.get(actorId, HEALTH_SCALE_PROP);
      return typeof v === "number" && v !== 1;
    } catch {
      return false;
    }
  }

  // The body spells, the cold stages and what else is held or was removed this session, for the login re-send
  private groupsOf(mp: Mp, entry: Online): AbilityGroup[] {
    const held = new Set(entry.rec.body.spells.map((d) => this.idOfDesc(mp, d)));
    if (entry.rec.foodPoisonUntil) held.add(this.idOfDesc(mp, entry.rec.foodPoisonSpell) || this.foodPoison);
    const coldSpells = this.coldSpells.filter((id) => id);
    const ids = new Set([...this.body.map((b) => b.id), ...entry.revoked, ...held]);
    ids.delete(0);
    for (const id of coldSpells) ids.delete(id);
    const groups = Array.from(ids).map((id) => ({ what: this.edidOf(mp, id), held: held.has(id) ? id : 0, stages: [id] }));
    return coldSpells.length ? [...groups, { what: "cold stage", held: this.idOfDesc(mp, entry.rec.coldSpell), stages: coldSpells }] : groups;
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

  private formIdOf(mp: Mp, obj: unknown): number {
    const desc = obj && typeof obj === "object" ? (obj as { desc?: unknown }).desc : undefined;
    return typeof desc === "string" ? this.idOfDesc(mp, desc) : 0;
  }

  private descOf(mp: Mp, id: number): string {
    try { return String(mp.getDescFromId(id)); } catch { return hex(id); }
  }

  private idOfDesc(mp: Mp, desc: string): number {
    try { return desc ? mp.getIdFromDesc(desc) >>> 0 : 0; } catch { return 0; }
  }

  private edidOf(mp: Mp, id: number): string {
    if (!id) return "";
    try { return String(mp.lookupEspmRecordById(id)?.record?.editorId || hex(id)); } catch { return hex(id); }
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  private read(mp: Mp, actorId: number): SurvivalRecord | null {
    try {
      const raw = mp.get(actorId, SURVIVAL_PROP);
      if (!raw || typeof raw !== "object") return null;
      const spells = Array.isArray(raw.body?.spells) ? raw.body.spells.filter((d: unknown): d is string => typeof d === "string" && !!d) : [];
      const respawn = Number(raw.body?.respawn);
      const cold = Number(raw.cold);
      return {
        v: 1,
        at: Number(raw.at) || Date.now(),
        body: { spells, respawn: respawn > 0 && respawn <= 1 ? respawn : 1 },
        foodPoisonUntil: Math.max(0, Number(raw.foodPoisonUntil) || 0),
        foodPoisonSpell: typeof raw.foodPoisonSpell === "string" ? raw.foodPoisonSpell : "",
        cold: raw.cold !== undefined && Number.isFinite(cold) ? clamp(cold, 0, COLD_MAX) : this.cold.start,
        coldSpell: typeof raw.coldSpell === "string" ? raw.coldSpell : "",
        warmBonus: raw.warmBonus === true,
        warmUntil: Math.max(0, Number(raw.warmUntil) || 0),
      };
    } catch {
      return null;
    }
  }

  private save(mp: Mp, entry: Online): void {
    entry.rec.at = Date.now();
    entry.savedAt = entry.rec.at;
    entry.savedCold = entry.rec.cold;
    try {
      mp.set(entry.actorId, SURVIVAL_PROP, entry.rec);
    } catch (e) {
      this.log(`[survival] write failed for ${hex(entry.actorId)}: ${e}`);
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
  private cold: ColdConfig = parseColdSettings({}, []);
  private coldSpells: number[] = [];
  private oblivionAreas = new Set<number>();
  private interiorAreas = new Set<number>();
  private coldCells = new Set<number>();
  private coldLocations = new Set<number>();
  private blizzard = new Set<number>();
  private ash = new Set<number>();
  private keywords = { warm: 0, cold: 0, bodyAndHead: 0, frost: 0, fire: 0 };
  private coldEffects = { restoreCold: 0, warmth: 0 };
  private heatInteriors = new Map<number, number[][]>();
  private heatWorlds = new Map<number, Map<string, number[][]>>();
  private placeCache = new Map<number, Place>();
  private armorCache = new Map<number, ArmorInfo>();
  private hotFoodCache = new Map<number, { restore: number; warms: boolean } | null>();
  private spellColdCache = new Map<number, number>();
  private venomCache = new Map<number, { amount: number; why: string } | null>();
  private online = new Map<number, Online>();
  private abilities: StageAbilityTracker;
  private lastShrineAt = new Map<number, number>();
  private nextTickAt = 0;
}
