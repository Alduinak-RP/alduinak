import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT, CREATION_FINISHED_EVENT, AFTERLIFE_REVIVED_EVENT } from "./system";
import { isEditorId, resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { ActorValue, RESIST_CAP, SpellType, abilityResist, actorRaceId, fieldData, hasCureDisease, learnedSpells, potionHealing, spellEffects, spellInfo, view } from "./espmMagic";
import { baseIdOf, chainMpHook, hasAdminMode, hex, isAlive, isCreationPending, isPlayerActor, removeSpellFrom, userOf } from "./actorUtil";
import { afterlifeOf } from "./afterlifeSystem";
import { describeActor, sendJson } from "./playerText";
import { NEEDS_STAGE_EVENT, NeedsModifierSource, attributePenaltyShare } from "./needsSystem";
import { RacialSystem } from "./racialSystem";
import { HuntingSystem } from "./huntingSystem";
import { WeatherSystem } from "./weatherSystem";
import { gameHourNow } from "./timeSystem";
import { AbilityGroup, LOAD_PACKETS, StageAbilityTracker } from "./stageAbilities";
import { HEAT_INTERIORS, HEAT_SOURCE_INPUTS, HEAT_WORLDS } from "./heatSources";
import { ARMOR_WARMTH } from "./armorWarmth";
import { every } from "./timers";
import {
  AreaClass, COLD_MAX, COLD_STAGE_NAMES, ColdConfig, RATED_SLOTS, WeatherAdd, WornArmor, areaOf, areaRateOf, coldCapOf, coldLevelOf, coldRatePerSec, coldStageOf, freezingWaterDrain,
  gearWarmth, isFreezingWater, isNight, nearHeatPoint, parseColdSettings, stepCold, temperatureLevelOf, warmthReduction, weatherAddOf,
} from "./survivalClimate";
import {
  DISEASE_STAGES, DiseaseConfig, DiseaseFactor, HeldDisease, carrierOf, diseaseFactor, exposureGapMs, factorLine, nextStageAt, parseDiseaseSettings,
  pickDisease, resistedChance, stageAt, stageName,
} from "./survivalDiseases";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Survival: the server keeps every Survival Mode rule (no Survival Papyrus runs on a client): the body rules, raw meat food poisoning,
// the cure, the shrines and cold.
//
// Body rules, at each login once the client's load settled and at creation finish: respawnPercentages.health = survivalRespawnHealthPoints
// (1) of the race's base health, which the client is sent right after each native respawn and afterlife revive (the character wakes with
// 1 health point), and the abilities AldSurvival_AbNoHealthRegen (slow health regeneration on the client) and the one
// survivalCarryWeightSpell names (none by default, so carry weight stays 300) through the StageAbilityTracker, each with its own switch; a
// record the plugin lacks is skipped with a log line. With survivalEnabled false, or a switch off, what an earlier session granted is
// undone at login, and so is an ability no rule grants any more (AldSurvival_FreezingWaterDamage, whose damage the server deals now).
// Raw meat (Survival_FoodRawMeat, HuntingSystem's meats, survivalRawMeatExtra) gives Survival_DiseaseFoodPoisoning at
// survivalFoodPoisoningChance x (1 - disease resist / 100) for survivalFoodPoisoningHours of wall clock, never to a race whose
// racialPassives entry is rawMeatSafe and never twice at once.
// Cure: a Cure Disease potion, or with survivalCure "cureDiseaseOrHealth" a potion restoring survivalCureMinHealth health or more, clears
// food poisoning and the three affliction abilities; a healing potion also removes every Disease spell, which the native cure only does
// for the Cure Disease effect. Shrines (Survival_BlessingAltars) cure nothing and say so, once a minute per player.
// Cold runs 0 to 1000 on Survival Mode's stages (survivalClimate.ts): every COLD_TICK_MS the character's area (cold lists, world and
// region tables, height), night, the region's weather and freezing water give a cold level that caps how far cold rises and how fast,
// slowed by warmth (worn clothing ratings, a torch, the race's warmth, a hot meal), times the area's survivalColdAreaRate (not in freezing
// water) and the race's coldRateMult; above the cap it falls unless the character fought in the last FIGHT_MS. Standing at a heat source
// (heatSources.ts) warms, frost spells and venom chill, fire spells and hot food warm. The stage ability Survival_ColdStage0..5 follows
// the stage and the client takes the maximum health penalty from survivalState. Cold falls while logged out and starts over at a respawn.
// Freezing water (swimming without a flame cloak, as the client reports, in a freezing area, a cold interior or a survivalFreezingWaterWorlds
// world) raises cold to the stage 3 value at once and takes survivalFreezingWaterDamage health points a second off the base maximum, less
// the frost resistance (the larger of the race's and abilities' from the records and the FrostResist value the client reports with the swim,
// capped at RESIST_CAP), written to percentages every WATER_TICK_MS and on leaving the water, so the native bleedout and death rules apply;
// health that crept up between two ticks by what the regeneration rate allows (base HealRate x healthRegenerationMultiplier over a tick plus
// the client's 2 s report gap) is taken back, a larger rise is healing and stays; never in creation, dead or with the god, ghost or invis
// admin mode. Each write stamps the native regeneration clock of every attribute, so a magicka report arriving right after one is cropped
// against that shorter time: magicka regenerates a little slower and may step back while swimming there, a known cost of the 5 s tick.
// Afflictions, Survival's conditions: at a need's stage 5 (hunger Starving from NEEDS_STAGE_EVENT, cold Numb) a
// character not holding its affliction rolls at most once per tickMinutes, like Survival's need update, so leaving stage 5 and coming
// back inside that time rolls nothing: Weakened (hunger, 20% every 15 min), Frostbitten (cold, 16% every 5 min). The affliction ability
// lasts survivalAfflictionHours of wall clock, offline included, or until cured like food poisoning. A stored affliction that has no
// definition (Addled, which fatigue gave) is taken back at login.
// Diseases (survivalDiseases.ts): a weapon or unarmed hit a player takes from a carrier creature (the attacker's race editor id holds a
// survivalDiseaseCarriers fragment; never a player, a pet, a blocked hit or a spell) rolls the carrier's chance x (1 - disease resist / 100)
// once and gives one of its diseases the character lacks, at most survivalMaxDiseases at once; each is the plugin's AldDisease_<Id>1..3 at
// its stage and worsens by wall clock, stage 2 after survivalDiseaseStageHours[0] and stage 3 after [1] more, offline included, where it
// stays until cured. Contagion (the diseases Oblivion's beggars spread) is found by the clients, so the server does no proximity scan: the
// player's ff_contagious lists the contagious diseases they carry (written at login, a catch and a cure, only when it changes), each client
// looks at the players it has loaded every survivalContagionCheckSeconds and reports those within survivalContagionRange (the chat whisper
// range) carrying a disease it lacks, and the server checks the report (one per player per exposureGapMs; the disease contagious, the source
// carries it, the reporter does not; nobody in creation, dead, in an afterlife realm or with the god, ghost or invis admin mode on either
// side; below survivalMaxDiseases) and rolls survivalContagionChance x (1 - disease resist / 100) once per disease, at most once per disease
// and pair every survivalContagionCooldownMinutes (kept in memory on the reporter's session). A client that skips its reports only spares
// itself: a report can never give anyone but the reporter a disease. Chills, Collywobbles, Gutworm and Brown Rot also scale cold gain, the
// hunger drain, food and the fatigue refill (the needs modifier source).
//
// Wire protocol - CustomPacket JSON:
//   Client -> Server: { customPacketType: "survivalRequest" }  state again; it, needsRequest, weatherRequest and gameTimeRequest schedule the login re-send
//                     { customPacketType: "survivalReport", swimming, flameCloak, frostResist?, engineWarmth? }  on change, frostResist with a swim, engineWarmth after equipment changes
//                     { customPacketType: "survivalExposure", sources: [{ actorId, diseases: [id] }] }  at a contagion check with a carrier in range
//   Server -> Client: { customPacketType: "survivalState", cold, coldStage, coldStageName, coldPenalty, temperatureLevel, warmth, freezingArea,
//                       afflictions: [name], diseases: [{ name, stage }], contagion: { seconds, range } | null }
//                     cold 0-1000 and coldStage 0-5, both -1 with cold off; coldPenalty is the 0-1 share of maximum health removed;
//                     temperatureLevel sets Survival_TemperatureLevel (0 neutral, 1 near heat, 2 warming, 3 cooling, 4 freezing);
//                     freezingArea is where the client reads and reports swimming; diseases name each held disease with its stage 1-3, food poisoning
//                     first as { "Food poisoning", 1 } while it runs; contagion is the client's check interval and range, null when off
//                     { customPacketType: "masteryNotice", text }
//   Actor property ff_contagious (registered in gamemode.js, seen by the owner and neighbours): [contagious disease id] or null
//
// Persistence: private.survival = { v, at, body: { spells: [desc], respawn }, foodPoisonUntil, foodPoisonSpell: desc, cold, coldSpell: desc,
// warmBonus, warmUntil, afflictions: { <key>: { until, spell: desc } }, lastRoll: { <key>: epoch ms },
// diseases: [{ id, stage, nextAt, since, from, spell: desc }] } on the character's actor form; ids are catalog ids and spells "id:Plugin"
// descs, never raw form ids. Written at stage changes, events, logout and every SAVE_MS while cold moves.
// private.healthScale (1 - the penalty) only with survivalColdHealthScale: the native counts health damage and healing against the base maximum times it.
//
// server-settings.json keys (all optional):
//   survivalEnabled               true runs survival, default false; one of the manager's PROTECTED_SETTINGS, so Migrate settings leaves it
//   survivalRespawnHealthPoints   health points a respawn wakes with, default 1; 0 uses the share below
//   survivalRespawnHealth         share used with 0 points or an unreadable race, in (0, 1], default 0.01; 1 turns the respawn rule off
//   survivalCarryWeightSpell      editor id or desc of a carry weight ability to grant, default "" (none, carry weight stays 300);
//                                 "Survival_abLowerCarryWeightSpell" is Survival's 150
//   survivalNoHealthRegen         false grants no AldSurvival_AbNoHealthRegen, default true
//   survivalFreezingWater         false: no freezing water cold or damage, default true
//   survivalFreezingWaterDamage   health points a real second of swimming in freezing water takes before frost resistance, default 0.25
//                                 (Survival's 5 at our 1:1 clock, 20 times slower like the cold rate); 0 for none
//   survivalFoodPoisoningChance   chance raw meat poisons before disease resistance, 0 to 1, default 0.5; 0 turns it off
//   survivalFoodPoisoningHours    real hours food poisoning lasts, offline included, default 24
//   survivalRawMeatExtra          editor ids, hex ids or descs of more raw meat, default []
//   survivalCure                  "cureDiseaseOrHealth" (default) or "cureDisease" (Cure Disease potions only)
//   survivalCureMinHealth         health a potion must restore to cure under cureDiseaseOrHealth, default 25
//   survivalColdEnabled           false stops cold and warmth, default true
//   survivalColdHoursToNumb       real hours in which cold level 20 with no warmth fills the bar, default 1.3334
//   survivalColdLevelMult         Survival_ColdLevelMult, default 50
//   survivalColdAreaRate          { warm, cool, freezing, chillyInterior }: cold gain multiplier of the area class, not in freezing water,
//                                 default { 1, 1, 0.6667, 0.6667 }: a freezing night in a blizzard (level 20) takes an hour from 0 to Freezing
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
//   survivalWarmthTable           false counts Survival keywords only; default true, armorWarmth.ts (misc/gen-armor-warmth.py) rates the pieces without one
//   survivalHotFoodWarmth / survivalHotFoodWarmthMinutes  warmth of a hot meal and for how long, default 25 / 100
//   survivalSpellHitCold          cold of a frost spell hit (up to stage 4) and warmth of a fire one (down to stage 2), default 30
//   survivalColdOnHit             { "<race editor id fragment>": cold } for hits by those races, default { frostbitespider: 30, falmer: 30 }
//   survivalColdKills             true kills at 1000, default false
//   survivalColdStageAbilities    false grants no Survival_ColdStage abilities, default true
//   survivalColdHealthPenalty     false sends no maximum health penalty, default true
//   survivalColdMaxHealthPenalty  largest share of maximum health cold takes, default 0.8
//   survivalColdHealthScale       true also writes private.healthScale, so the native counts damage and healing against the shrunk maximum, default false
//   survivalFreezingWaterWorlds   worldspace editor ids whose water always freezes, default ["DLC1HunterHQWorld"]
//   survivalAfflictions           { weakened, frostbitten: { chance, tickMinutes } | false } over the defaults, or false for none, default
//                                 { weakened: { 0.2, 15 }, frostbitten: { 0.16, 5 } }
//   survivalAfflictionHours       real hours an affliction lasts, offline included, default 24
//   survivalDiseasesEnabled       false gives no disease and removes those held at login, default true
//   survivalDiseases              { "<id>": false | { name, contagious, stageHours } } over the catalog of survivalDiseases.ts
//   survivalDiseaseCarriers       { "<race editor id fragment>": false | { chance, diseases: [id] } } over the default carriers
//   survivalDiseaseCarrierExclude race editor id fragments no carrier matches, default ["werewolf", "werebear"]
//   survivalDiseaseStageHours     real hours from stage 1 to 2 and from 2 to 3, offline included, default [84, 84]
//   survivalMaxDiseases           diseases a character can hold at once, default 4
//   survivalContagionChance       chance per reported disease before disease resistance, default 0.05; 0 turns contagion off
//   survivalContagionCheckSeconds seconds between one client's checks, default 60; the server accepts a report every exposureGapMs (55 s)
//   survivalContagionRange        units, default chatRanges.whisper (150 when unset), the chat whisper range
//   survivalContagionCooldownMinutes minutes before the same disease and pair roll again, default 30

const SURVIVAL_PROP = "private.survival";
const HEALTH_SCALE_PROP = "private.healthScale";
const CONTAGIOUS_PROP = "ff_contagious";
const NOTICE_PACKET = "masteryNotice";
const STATE_PACKET = "survivalState";
const REQUEST_PACKET = "survivalRequest";
const REPORT_PACKET = "survivalReport";
const EXPOSURE_PACKET = "survivalExposure";
// Sources and diseases per source an exposure report may name; more are ignored
const EXPOSURE_MAX_SOURCES = 8;
const EXPOSURE_MAX_DISEASES = 32;
// One line per player this often for a report naming nothing catchable
const EXPOSURE_LOG_MS = 10 * 60000;
const NEEDS_REQUEST_PACKET = "needsRequest";
const HIT_EVENT = "onPapyrusEvent:OnHit";
const POLL_MS = 1000;
const TICK_MS = 60000;
const COLD_TICK_MS = 15000;
const WATER_TICK_MS = 5000;
const WATER_NOTICE_GAP_MS = 60000;
// A rise between two water ticks of up to what the regeneration rate yields in this many seconds (a tick plus the client's 2 s report gap) is regeneration, more is healing
const WATER_REGEN_SECONDS = WATER_TICK_MS / 1000 + 2;
// The player's HealRate actor value, percent of the bar a second before healthRegenerationMultiplier
const BASE_HEAL_RATE_PCT = 0.7;
const SAVE_MS = 5 * 60000;
// A hit given or taken this recently stops cold falling above the cap
const FIGHT_MS = 10000;
const REPORT_GAP_MS = 250;
const SHRINE_NOTICE_GAP_MS = 60000;
const HOUR_MS = 3600000;
const GRID = 4096;
const EPSILON = 1e-4;

const DEFAULT_RESPAWN_HEALTH = 0.01;
const DEFAULT_RESPAWN_POINTS = 1;
const NO_REGEN_SPELL = "AldSurvival_AbNoHealthRegen";
const DEFAULT_POISON_CHANCE = 0.5;
const DEFAULT_POISON_HOURS = 24;
const DEFAULT_CURE_MIN_HEALTH = 25;
const FOOD_POISONING_SPELL = "Survival_DiseaseFoodPoisoning";
const FOOD_POISONING_NAME = "Food poisoning";
// Survival_AfflictionHungerChance and ...ColdChance; the need update intervals at our 1:1 clock
const AFFLICTION_DEFS = [
  { key: "weakened", spell: "Survival_AfflictionWeakened", name: "Weakened", worst: "starving", chance: 0.2, tickMinutes: 15, notice: "Starving has weakened you: your one-handed, two-handed and block skills suffer" },
  { key: "frostbitten", spell: "Survival_AfflictionFrostbitten", name: "Frostbitten", worst: "numb", chance: 0.16, tickMinutes: 5, notice: "The cold has frostbitten you: your archery, lockpicking and pickpocketing suffer" },
];
const DEFAULT_AFFLICTION_HOURS = 24;
const WORST_STAGE = 5;
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
const PET_PROP = "private.pet";
// Staff in these admin modes neither spread nor catch a disease
const UNSEEN_MODES = ["god", "ghost", "invis"];

export type CureMode = "cureDisease" | "cureDiseaseOrHealth";
const CURE_MODES: CureMode[] = ["cureDisease", "cureDiseaseOrHealth"];

// Emitted on SystemContext.gm (actorId, by, done(ok)) by the admin panel: an online character loses food poisoning, starts over at the
// new-character cold and gets its body rules again
export const SURVIVAL_RESET_EVENT = "survivalReset";

// Emitted on SystemContext.gm (actorId, by, request, done(result)) by the admin panel and answered at once; no answer means survival is off.
// request.op: "catalog" (actorId 0) | "summary" | "setCold" (cold 0-1000) | "giveDisease" (disease id or name, stage 1-3) | "cure" (disease, "" for every sickness)
export const SURVIVAL_ADMIN_EVENT = "survivalAdmin";

export interface SurvivalAdminRequest {
  op: string;
  cold?: unknown;
  disease?: unknown;
  stage?: unknown;
}

// An online character's survival state for the admin panel; cold -1 and stage "" with cold off, area "" until the first cold step
export interface SurvivalSummary {
  cold: number;
  stage: string;
  area: string;
  level: number;
  warmth: number;
  freezingArea: boolean;
  diseases: Array<{ id: string; name: string; stage: number; nextAt: number }>;
  afflictions: Array<{ name: string; until: number }>;
  foodPoisonUntil: number;
}

// What the admin panel may give: the diseases in the plugin, and the cold scale
export interface SurvivalCatalog {
  diseases: Array<{ id: string; name: string; contagious: boolean }>;
  coldMax: number;
  coldStages: number[];
}

export interface SurvivalAdminResult {
  ok: boolean;
  text: string;
  summary?: SurvivalSummary;
  catalog?: SurvivalCatalog;
}

type BodyKey = "carry" | "regen";

interface BodySpell {
  key: BodyKey;
  label: string;
  // Editor id or desc named by the settings, "" when switched off
  name: string;
  id: number;
}

interface Affliction {
  key: string;
  spell: string;
  name: string;
  // The stage 5 name of its need, for the log
  worst: string;
  chance: number;
  tickMs: number;
  notice: string;
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
  // Afflictions held, by key, with the epoch ms they run out and the spell desc granted
  afflictions: Record<string, { until: number; spell: string }>;
  // Epoch ms of each affliction's last roll
  lastRoll: Record<string, number>;
  diseases: HeldDisease[];
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
  // The FrostResist actor value the client reported with the swim, 0..RESIST_CAP
  frostResist: number;
  inFreezingWater: boolean;
  // Health was last taken for freezing water then, 0 out of it, and the share it left, -1 before the first tick
  waterAt: number;
  waterHealth: number;
  waterNoticeAt: number;
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
  // The worn pieces by keyword only, what the engine's Warmth total shows
  engineGear: number;
  wornKey: string;
  // Offline warming applied at login, for the login line
  offline: string;
  sent: string;
  savedAt: number;
  savedCold: number;
  engineSeen: string;
  healthScale: number;
  killed: boolean;
  // Epoch ms of the last accepted exposure report and of the last unusable report line
  exposureAt: number;
  exposureLogAt: number;
  // "source:disease" -> epoch ms of its last contagion roll
  exposureRolls: Map<string, number>;
  // The ff_contagious ids last written, joined; null until compared with the stored value
  contagious: string | null;
}

interface ArmorInfo {
  armor: WornArmor | null;
  // The piece by its own keywords, as the engine's Warmth total counts it
  engine: WornArmor | null;
  torch: boolean;
}

interface TableRow {
  kind?: "warm" | "cold";
  extra?: number;
}

// "<local id hex>:<plugin file, lower case>" -> the armorWarmth.ts rating
const WARMTH_TABLE = new Map<string, TableRow>();
for (const [plugin, t] of Object.entries(ARMOR_WARMTH)) {
  const key = (id: number): string => `${id.toString(16)}:${plugin.toLowerCase()}`;
  for (const id of t.warm || []) WARMTH_TABLE.set(key(id), { kind: "warm" });
  for (const id of t.cold || []) WARMTH_TABLE.set(key(id), { kind: "cold" });
  for (const [id, points] of t.extra || []) WARMTH_TABLE.set(key(id), { extra: points });
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const round = (v: number): number => Math.round(v * 100) / 100;
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
const emptyRecord = (cold: number): SurvivalRecord => ({ v: 1, at: Date.now(), body: { spells: [], respawn: 1 }, foodPoisonUntil: 0, foodPoisonSpell: "", cold, coldSpell: "", warmBonus: false, warmUntil: 0, afflictions: {}, lastRoll: {}, diseases: [] });
// Local month, day and time, for disease stages days away
const when = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(ms)}`;
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class SurvivalSystem implements System, NeedsModifierSource {
  systemName = "SurvivalSystem";
  label = "survival";

  constructor(private log: Log, private racial: RacialSystem, private hunting: HuntingSystem, private weather: WeatherSystem) {
    this.abilities = new StageAbilityTracker("survival", log);
  }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const { problems, extraMeat } = this.configure((s.allSettings || {}) as Record<string, unknown>);
    this.mp = ctx.svr as Mp;
    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));
    every("survival", POLL_MS, () => this.poll(ctx));
    if (!this.enabled) {
      this.log(`[survival] off (survivalEnabled false): no survival rule runs; the body abilities, the respawn health, food poisoning and the cold stage ability an earlier session granted are undone at each character's login${problems.length ? `; ignored: ${problems.join("; ")}` : ""}`);
      return;
    }
    const counts = await this.resolveForms(ctx, extraMeat, s.dataDir, s.loadOrder, problems);
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => this.onCreationFinished(actorId >>> 0));
    ctx.gm.on(AFTERLIFE_REVIVED_EVENT, (actorId: number) => this.wake(ctx.svr as Mp, actorId >>> 0, "revived"));
    ctx.gm.on(SURVIVAL_RESET_EVENT, (actorId: number, by: string, done?: (ok: boolean) => void) => done?.(this.resetBy(ctx, actorId >>> 0, by)));
    ctx.gm.on(SURVIVAL_ADMIN_EVENT, (actorId: number, by: string, request: SurvivalAdminRequest, done?: (result: SurvivalAdminResult) => void) => done?.(this.adminRequest(ctx, actorId >>> 0, by, request)));
    ctx.gm.on(NEEDS_STAGE_EVENT, (actorId: number, hunger: number) => this.onNeedsStage(ctx, actorId >>> 0, hunger));
    this.installHooks(ctx);
    const heat = this.buildHeatIndex(ctx.svr as Mp);
    const bodyLine = this.body.map((b) => `${b.label} ${!b.name ? "off" : b.id ? `${b.name} (${hex(b.id)})` : `${b.name} not in the load order, skipped`}`).join(", ");
    const cureLine = this.cureMode === "cureDiseaseOrHealth" ? `Cure Disease potions and potions restoring ${this.cureMinHealth}+ health (those also remove every Disease spell)` : "Cure Disease potions only";
    this.log(`[survival] ready: body rules respawn health ${this.respawnLine()}, ${bodyLine}; raw meat ${this.rawMeat.size} foods (${counts.list} ${RAW_MEAT_LIST}, ${counts.hunting} hunting, ${counts.extra} extra), food poisoning ${pct(this.poisonChance)} x (1 - disease resist) for ${this.poisonMs / HOUR_MS} h ${this.foodPoison ? `(${hex(this.foodPoison)})` : "(spell not in the load order, never given)"}, races safe from raw meat per racialPassives rawMeatSafe; cure by ${cureLine}, clearing food poisoning and ${this.afflictions.filter((a) => a.id).length} affliction abilities; shrines ${this.altars.size} altar bases, no cure, a notice at most once a minute; afflictions ${this.afflictionLine()}`);
    this.log(this.coldLine(heat));
    this.log(this.diseaseLine());
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
    this.respawnPoints = num("survivalRespawnHealthPoints", DEFAULT_RESPAWN_POINTS, (v) => v >= 0);
    this.poisonChance = num("survivalFoodPoisoningChance", DEFAULT_POISON_CHANCE, (v) => v >= 0 && v <= 1);
    this.poisonMs = num("survivalFoodPoisoningHours", DEFAULT_POISON_HOURS, (v) => v > 0) * HOUR_MS;
    this.cureMinHealth = num("survivalCureMinHealth", DEFAULT_CURE_MIN_HEALTH, (v) => v >= 0);
    const cure = all["survivalCure"];
    if (cure !== undefined && CURE_MODES.indexOf(cure as CureMode) === -1) problems.push(`survivalCure ${JSON.stringify(cure)} is not ${CURE_MODES.join(" or ")}, cureDiseaseOrHealth is used`);
    this.cureMode = CURE_MODES.indexOf(cure as CureMode) !== -1 ? cure as CureMode : "cureDiseaseOrHealth";
    const carry = all["survivalCarryWeightSpell"];
    if (carry !== undefined && typeof carry !== "string") problems.push(`survivalCarryWeightSpell ${JSON.stringify(carry)} is not a string, no carry weight ability is granted`);
    this.body = [
      { key: "carry", label: "carry weight", name: typeof carry === "string" ? carry.trim() : "", id: 0 },
      { key: "regen", label: "no regen", name: all["survivalNoHealthRegen"] !== false ? NO_REGEN_SPELL : "", id: 0 },
    ];
    const extra = all["survivalRawMeatExtra"];
    if (extra !== undefined && !(Array.isArray(extra) && extra.every((x) => typeof x === "string"))) problems.push("survivalRawMeatExtra is not a list of strings, none are added");
    const extraMeat = Array.isArray(extra) ? extra.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
    this.cold = parseColdSettings(all, problems);
    // The native crop allows HealRate x this x seconds; a rise under that between two water ticks is regeneration, not healing
    const regenMult = all["healthRegenerationMultiplier"] !== undefined ? num("healthRegenerationMultiplier", 1, (v) => v >= 0) : num("regenerationMultiplier", 1, (v) => v >= 0);
    this.waterRegenShare = BASE_HEAL_RATE_PCT / 100 * regenMult * WATER_REGEN_SECONDS;
    this.afflictionMs = num("survivalAfflictionHours", DEFAULT_AFFLICTION_HOURS, (v) => v > 0) * HOUR_MS;
    this.afflictions = this.parseAfflictions(all["survivalAfflictions"], problems);
    this.dis = parseDiseaseSettings(all, problems);
    return { problems, extraMeat };
  }

  // survivalAfflictions over the defaults: false switches one or all off
  private parseAfflictions(raw: unknown, problems: string[]): Affliction[] {
    if (raw !== undefined && raw !== false && !isObject(raw)) problems.push(`survivalAfflictions ${JSON.stringify(raw)} is not an object or false, the defaults are used`);
    return AFFLICTION_DEFS.map((d) => {
      const v = raw === false ? false : isObject(raw) ? raw[d.key] : undefined;
      let chance = d.chance;
      let tickMinutes = d.tickMinutes;
      if (v === false) chance = 0;
      else if (isObject(v)) {
        if (typeof v.chance === "number" && v.chance >= 0 && v.chance <= 1) chance = v.chance;
        else if (v.chance !== undefined) problems.push(`survivalAfflictions.${d.key}.chance ${JSON.stringify(v.chance)} is not between 0 and 1, ${chance} is used`);
        if (typeof v.tickMinutes === "number" && v.tickMinutes > 0) tickMinutes = v.tickMinutes;
        else if (v.tickMinutes !== undefined) problems.push(`survivalAfflictions.${d.key}.tickMinutes ${JSON.stringify(v.tickMinutes)} is not above 0, ${tickMinutes} is used`);
      } else if (v !== undefined) {
        problems.push(`survivalAfflictions.${d.key} ${JSON.stringify(v)} is not an object or false, the default is used`);
      }
      return { key: d.key, spell: d.spell, name: d.name, worst: d.worst, chance, tickMs: tickMinutes * 60000, notice: d.notice, id: 0 };
    });
  }

  private afflictionLine(): string {
    const list = this.afflictions.map((a) => `${a.key} ${!a.id ? `(${a.spell} not in the load order, never given)` : a.chance > 0 ? `${pct(a.chance)} when ${a.worst}, rolled at most once every ${a.tickMs / 60000} min there (${hex(a.id)})` : "off"}`);
    return `${list.join(", ")}; each lasts ${this.afflictionMs / HOUR_MS} h, offline included, or until cured`;
  }

  private diseaseLine(): string {
    const d = this.dis;
    if (!d.enabled) return "[survival] diseases off (survivalDiseasesEnabled false): none is caught and those held are removed at login";
    const defs = Object.values(d.diseases);
    const ready = defs.filter((x) => this.hasDisease(x.id));
    const missing = defs.filter((x) => !this.hasDisease(x.id)).map((x) => x.id);
    if (!ready.length) return `[survival] diseases: 0 of ${defs.length} in the plugin (the AldDisease_* spells come with plugin r27a), none is given`;
    const hours = (h: number[]): string => h.join("/");
    const own = ready.filter((x) => hours(x.stageHours) !== hours(d.stageHours)).map((x) => `${x.id} ${hours(x.stageHours)} h`);
    const c = d.contagion;
    const carriers = Object.entries(d.carriers).map(([k, v]) => `${k} ${pct(v.chance)} ${v.diseases.filter((id) => this.hasDisease(id)).join("/") || "none in the plugin"}`);
    return `[survival] diseases: ${ready.length} of ${defs.length} in the plugin (${ready.filter((x) => x.contagious).length} contagious)${missing.length ? `, not in the plugin: ${missing.join(", ")}` : ""}; ` +
      `stage 2 after ${d.stageHours[0]} h and stage 3 after ${d.stageHours[1]} h more${own.length ? ` (${own.join(", ")})` : ""}, offline included, stage 3 stays until cured; at most ${d.max} at once; ` +
      `carriers by race editor id, longest fragment first${d.exclude.length ? `, never ${d.exclude.join("/")}` : ""}: ${carriers.join(", ") || "none"}, one roll per weapon or unarmed hit x (1 - disease resist), none from a player, a pet, a blocked hit or a spell; ` +
      `contagion ${c.chance > 0 ? `by client report: each client checks the players it has loaded every ${c.checkSeconds} s (the first at a random second) and reports those within ${c.range} units (${c.rangeFrom}) whose ${CONTAGIOUS_PROP} names a disease it lacks; ` +
        `the server takes one report per player per ${exposureGapMs(c.checkSeconds) / 1000} s and rolls ${pct(c.chance)} x (1 - disease resist) once per disease it confirms (contagious, carried by the source, not by the reporter)` +
        `${c.cooldownMinutes > 0 ? ` and at most once per disease and pair every ${c.cooldownMinutes} min` : " at every report"}, players only, never in creation, dead, in an afterlife realm or with ${UNSEEN_MODES.join("/")}, and no roll at ${d.max} diseases` : "off"}; ` +
      `server factors ${factorLine(d.diseases) || "none"}`;
  }

  // Body spells, food poisoning, afflictions, raw meat, altars and the cold records; returns the raw meat counts by source
  private async resolveForms(ctx: SystemContext, extraMeat: string[], dataDir: string, loadOrder: string[], problems: string[]): Promise<{ list: number; hunting: number; extra: number }> {
    const mp = ctx.svr as Mp;
    const coldNames = [...COLD_SPELLS, ...Object.values(COLD_LISTS), ...Object.values(COLD_KEYWORDS), ...Object.values(COLD_EFFECTS)];
    const diseaseNames = Object.values(this.dis.diseases).flatMap((d) => d.spells);
    const names = [...this.body.map((b) => b.name).filter((n) => n && isEditorId(n)), FOOD_POISONING_SPELL, ...AFFLICTION_DEFS.map((d) => d.spell), RAW_MEAT_LIST, ALTAR_LIST, ...extraMeat.filter(isEditorId), ...coldNames, ...diseaseNames];
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
    for (const a of this.afflictions) a.id = idOf(a.spell);
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
    for (const d of Object.values(this.dis.diseases)) this.diseaseSpells.set(d.id, d.spells.map(idOf));
    const missing = [FOOD_POISONING_SPELL, ...AFFLICTION_DEFS.map((d) => d.spell), RAW_MEAT_LIST, ALTAR_LIST, ...coldNames].filter((n) => !idOf(n));
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
    const drain = c.freezingWaterDamage > 0 ? `${c.freezingWaterDamage} health a second while swimming (less the larger of the records' and the client's frost resistance, up to ${RESIST_CAP}%; a rise under ${pct(this.waterRegenShare)} of the bar between two ${WATER_TICK_MS / 1000} s ticks is regeneration and is taken back)` : "no health damage";
    if (!c.enabled) return `[survival] cold off (survivalColdEnabled false): no cold, warmth or stage abilities; freezing water ${c.freezingWater ? `still takes ${drain}` : "off"}`;
    const l = c.levels;
    const w = c.warmth;
    const classes: Record<string, number> = {};
    for (const cls of Object.values(c.regionClimate)) classes[cls] = (classes[cls] || 0) + 1;
    const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    const genNote = same(c.heatKeywords, HEAT_SOURCE_INPUTS.keywords) && same(c.heatExtraBases, HEAT_SOURCE_INPUTS.extraBases) ? "" :
      `; heatSources.ts was made from keywords ${HEAT_SOURCE_INPUTS.keywords.join("/") || "none"} and extra bases ${HEAT_SOURCE_INPUTS.extraBases.join("/") || "none"}, not survivalHeatKeywords ${c.heatKeywords.join("/") || "none"} and survivalHeatExtraBases ${c.heatExtraBases.join("/") || "none"}: rerun misc/gen-heat-sources.py`;
    const spells = this.coldSpells.filter((id) => id).length;
    const r = c.areaRate;
    return `[survival] cold: +${c.levelMult} x level per ${c.hoursToNumb} h (level 20 bare fills the bar) times the area rate warm x${r.warm}, cool x${r.cool}, freezing x${r.freezing}, cold interior x${r.chillyInterior} (x1 in freezing water), stages ${c.stages.join("/")}, start ${c.start}; levels warm ${l.warm}, cool ${l.cool}, freezing ${l.freezing}, cold interior ${l.chillyInterior}, night +${l.warmNight}/+${l.coolNight}/+${l.freezingNight} (${c.night[0]}-${c.night[1]} h), rain +${l.rain}, snow +${l.snow}, blizzard +${l.blizzard} (${this.blizzard.size} blizzard weathers, ${this.ash.size} ash weathers count as no snow), freezing water ${l.freezingWater}${c.freezingWater ? ` (freezing areas, cold interiors, worlds ${c.freezingWaterWorlds.join("/") || "none"}), up to ${c.stages[2]} at once, ${drain}` : " off"}; caps at levels ${c.caps.join("/")}; falls ${c.warmPerMinute}/min above the cap unless fighting in the last ${FIGHT_MS / 1000} s, ${c.offlineWarmPerHour}/h offline down to ${c.start}; ` +
      `areas: ${this.oblivionAreas.size} Oblivion worlds none, ${this.interiorAreas.size} worlds as interiors, ${this.coldCells.size} cold cells and ${this.coldLocations.size} cold locations, worlds ${Object.entries(c.worldClimate).map(([k, v]) => `${k} ${v}`).join(", ")}, above ${c.freezingZ} freezing, regions ${Object.entries(classes).map(([k, n]) => `${n} ${k}`).join(", ")}, heights ${Object.entries(c.highRegions).map(([k, z]) => `${k} ${z}`).join(", ") || "none"}, anything else cool; ` +
      `heat ${heat.points} sources (${heat.interiors} interiors, ${heat.worlds} worlds${heat.unknown ? `, ${heat.unknown} cells or worlds not in the load order` : ""}) within ${c.heatRadius} warm ${c.heatRestore} every ${c.heatCheckSeconds} s to a character standing (moved under ${c.heatStillUnits} units)${genNote}; ` +
      `warmth normal ${w.normal.join("/")}, warm ${w.warm.join("/")}, cold ${w.cold.join("/")}, torch ${w.torch}, cloak ${w.cloak}, ${c.warmthTable ? `armorWarmth.ts rates ${WARMTH_TABLE.size} more pieces` : "armorWarmth.ts off (survivalWarmthTable false)"}, up to ${w.max} for ${pct(w.maxReduction)} less cold, race per racialPassives warmth, hot meal ${c.hotFoodWarmth} for ${c.hotFoodMinutes} min; ` +
      `spell hits ${c.spellHitCold} (frost up to ${c.stages[3]}, fire down to ${c.stages[1]}), hits by ${Object.entries(c.coldOnHit).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ` +
      `stage abilities ${c.stageAbilities ? `on (${spells} of 6 in the load order)` : "off"}, health penalty ${c.healthPenalty ? `from ${c.stages[1]}, at most ${pct(c.maxHealthPenalty)}` : "off"}, health scale ${c.healthScale ? "written to private.healthScale" : "off"}, death at ${COLD_MAX} ${c.kills ? "on" : "off"}; weather regions ${this.weather?.regionOf ? "read" : "unavailable"}`;
  }

  // ── Native hooks: decide from memory, never write here ────────────────────

  private installHooks(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    chainMpHook(mp, "onEatItem", (actorId: number, baseId: number) => {
      try {
        this.onEat(ctx, Number(actorId) >>> 0, Number(baseId) >>> 0);
      } catch (e) {
        this.log(`[survival] food check failed: ${e}`);
      }
    });
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
    if (target.bodyDue) return;
    const sourceId = this.formIdOf(mp, args[2]);
    const blocked = args[7] === true;
    if (this.dis.enabled && !blocked && aggressorId && !aggressor) setImmediate(() => this.hitDisease(ctx, targetId, aggressorId, sourceId));
    if (!this.cold.enabled) return;
    const spell = this.spellColdOf(mp, sourceId);
    const venom = !spell && !blocked && aggressorId ? this.venomColdOf(mp, aggressorId) : null;
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
    if (!this.enabled && !(stored && (stored.body.spells.length || stored.body.respawn < 1 || stored.foodPoisonUntil || stored.coldSpell || Object.keys(stored.afflictions).length || stored.diseases.length)) && !this.scaled(mp, actorId)) return;
    const rec = stored || emptyRecord(this.cold.start);
    const now = Date.now();
    const entry: Online = {
      actorId, userId, rec, bodyDue: !isCreationPending(mp, actorId), revoked: [], coldAt: 0, heatAt: 0, heatPos: null, nearHeat: false, heatFrom: -1,
      swimming: false, flameCloak: false, frostResist: 0, inFreezingWater: false, waterAt: 0, waterHealth: -1, waterNoticeAt: 0, reportAt: 0, fightAt: 0, area: "", areaWhy: "", freezingArea: false, level: 0, levelParts: [],
      temperature: 0, warmth: 0, gear: 0, engineGear: 0, wornKey: "", offline: "", sent: "", savedAt: now, savedCold: rec.cold, engineSeen: "", healthScale: -1, killed: false,
      exposureAt: 0, exposureLogAt: 0, exposureRolls: new Map(), contagious: null,
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
    if (type === EXPOSURE_PACKET) return this.onExposure(ctx.svr as Mp, userId, content || {});
    if (type !== REQUEST_PACKET && type !== NEEDS_REQUEST_PACKET && !LOAD_PACKETS.has(type)) return;
    for (const [actorId, entry] of this.online) {
      if (entry.userId !== userId) continue;
      this.abilities.scheduleResend(actorId);
      if (type === REQUEST_PACKET && entry.coldAt) this.sendState(ctx.svr as Mp, entry, true);
    }
  }

  // Swimming, a flame cloak and the frost resistance, as the client's engine sees them, stepped at once on a change (two reports bunched by a
  // retransmit must both step, or the water flags and the drain would stay on until the next cold step); engineWarmth, the inventory's Warmth
  // total, is checked at most once per REPORT_GAP_MS
  private onReport(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    const now = Date.now();
    for (const entry of this.online.values()) {
      if (entry.userId !== userId || !entry.coldAt) continue;
      const swimming = content["swimming"] === true;
      const flameCloak = content["flameCloak"] === true;
      const resist = Number(content["frostResist"]);
      const changed = swimming !== entry.swimming || flameCloak !== entry.flameCloak;
      entry.swimming = swimming;
      entry.flameCloak = flameCloak;
      entry.frostResist = swimming && Number.isFinite(resist) ? clamp(resist, 0, RESIST_CAP) : 0;
      if (changed) this.step(ctx, entry.actorId, entry, now);
      if (now - entry.reportAt < REPORT_GAP_MS) continue;
      entry.reportAt = now;
      const engineWarmth = content["engineWarmth"];
      if (typeof engineWarmth === "number" && Number.isFinite(engineWarmth)) this.checkWarmth(mp, entry, engineWarmth, now);
    }
  }

  poll(ctx: SystemContext): void {
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
            if (entry.waterAt && now - entry.waterAt >= WATER_TICK_MS) this.drainInWater(mp, entry, now);
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
    } else {
      if (rec.foodPoisonUntil) {
        this.clearFoodPoisoning(mp, actorId, entry);
        removed.push(FOOD_POISONING_SPELL);
      }
      for (const a of this.afflictions) {
        const id = this.dropAffliction(mp, entry, a);
        if (id) removed.push(this.edidOf(mp, id));
      }
    }
    for (const key of Object.keys(rec.afflictions).filter((k) => !this.afflictions.some((a) => a.key === k))) {
      const id = this.dropAffliction(mp, entry, { key, id: 0 });
      removed.push(id ? this.edidOf(mp, id) : key);
    }
    removed.push(...this.dropDiseases(mp, entry, (d) => !(this.enabled && this.dis.enabled && this.hasDisease(d.id))));
    this.publishContagious(mp, entry);
    const heldCold = this.idOfDesc(mp, rec.coldSpell);
    if (rec.coldSpell && !(this.enabled && this.cold.enabled && this.cold.stageAbilities)) {
      if (heldCold) this.abilities.swap(mp, actorId, heldCold, 0, "cold stage");
      removed.push(heldCold ? this.edidOf(mp, heldCold) : rec.coldSpell);
      rec.coldSpell = "";
    }
    if (!(this.enabled && this.cold.enabled && this.cold.healthScale)) this.setHealthScale(mp, entry, 1);
    const { share: respawn, text: respawnText } = this.respawnRule(actorId);
    const respawnChanged = this.setRespawn(mp, actorId, respawn);
    rec.body = { spells: wantDescs, respawn };
    if (this.enabled) this.expire(ctx, actorId, entry, now);
    this.save(mp, entry);
    if (!this.enabled) {
      this.log(`[survival] ${hex(actorId)} body rules off: respawn 100%${respawnChanged ? "" : " (already)"}, abilities removed: ${removed.join(", ") || "none"}`);
      return;
    }
    const poisoned = rec.foodPoisonUntil ? `food poisoning until ${clock(rec.foodPoisonUntil)}` : "no food poisoning";
    const afflicted = this.afflictions.filter((a) => rec.afflictions[a.key]).map((a) => `, ${a.key} until ${clock(rec.afflictions[a.key].until)}`).join("");
    const sick = rec.diseases.map((d) => `, ${d.id} ${d.stage} (${d.nextAt ? `stage ${d.stage + 1} at ${when(d.nextAt)}` : "until cured"})`).join("");
    const cold = this.startCold(ctx, actorId, entry, now);
    this.log(`[survival] ${hex(actorId)} body: ${parts.join(", ")}, respawn health ${respawnText}${respawnChanged ? " (set)" : ""}${removed.length ? `, removed ${removed.join(", ")}` : ""}, ${poisoned}${afflicted}${sick}; ${cold}`);
  }

  // The health share a respawn wakes with and how the log names it: the points of the race's base health, else the share; 1 when off
  private respawnRule(actorId: number, scale = 1): { share: number; text: string } {
    if (!this.enabled || this.respawnHealth >= 1) return { share: 1, text: "100%" };
    const max = this.respawnPoints > 0 ? this.racial.maxHealth(actorId) * scale : 0;
    if (max > 0) return { share: Math.min(1, this.respawnPoints / max), text: `${this.respawnPoints} of ${round(max)}` };
    return { share: this.respawnHealth, text: pct(this.respawnHealth) };
  }

  private respawnLine(): string {
    if (this.respawnHealth >= 1) return "100% (off)";
    return this.respawnPoints > 0 ? `${this.respawnPoints} point(s) of the race's base health` : pct(this.respawnHealth);
  }

  // The native respawn tells the client full health and sends only a changed value, so full is written first and then the respawn health
  private wake(mp: Mp, actorId: number, why: string): void {
    const { share, text } = this.respawnRule(actorId, this.healthScaleOf(actorId));
    if (share >= 1 || !this.online.has(actorId) || !isAlive(mp, actorId)) return;
    try {
      const held = mp.get(actorId, "percentages");
      mp.set(actorId, "percentages", { ...held, health: 1 });
      mp.set(actorId, "percentages", { ...held, health: share });
      this.setRespawn(mp, actorId, this.respawnRule(actorId).share);
      const was = Number(held?.health);
      this.log(`[survival] ${hex(actorId)} ${why}: health ${text} sent to the client${Math.abs(was - share) > EPSILON ? ` (was ${pct(was)})` : ""}`);
    } catch (e) {
      this.log(`[survival] ${hex(actorId)} ${why}: setting the respawn health failed: ${e}`);
    }
  }

  // True when the stored share changed; magicka and stamina keep theirs
  private setRespawn(mp: Mp, actorId: number, health: number): boolean {
    const current = mp.get(actorId, "respawnPercentages") || {};
    if (Math.abs(Number(current.health ?? 1) - health) < EPSILON) return false;
    mp.set(actorId, "respawnPercentages", { health, magicka: Number(current.magicka ?? 1), stamina: Number(current.stamina ?? 1) });
    return true;
  }

  // Food poisoning and afflictions past their time are removed, offline time included
  private expire(ctx: SystemContext, actorId: number, entry: Online, now: number): void {
    const mp = ctx.svr as Mp;
    const lines: string[] = [];
    const until = entry.rec.foodPoisonUntil;
    if (until && now >= until) {
      this.clearFoodPoisoning(mp, actorId, entry);
      lines.push(`food poisoning ran out at ${clock(until)}`);
      this.notice(mp, actorId, "Your stomach settles: the food poisoning has passed.");
    }
    for (const a of this.afflictions) {
      const held = entry.rec.afflictions[a.key];
      if (!held || now < held.until) continue;
      this.dropAffliction(mp, entry, a);
      lines.push(`${a.key} ran out at ${clock(held.until)}`);
      this.notice(mp, actorId, `You recover: you are no longer ${a.key}.`);
    }
    this.progressDiseases(mp, entry, now, lines);
    if (!lines.length) return;
    this.save(mp, entry);
    for (const line of lines) this.log(`[survival] ${hex(actorId)} ${line}`);
    if (entry.coldAt) this.sendState(mp, entry, false);
  }

  // Removes a held affliction's ability and record; returns the spell removed, 0 when none was held
  private dropAffliction(mp: Mp, entry: Online, a: Pick<Affliction, "key" | "id">): number {
    const held = entry.rec.afflictions[a.key];
    if (!held) return 0;
    const id = this.idOfDesc(mp, held.spell) || a.id;
    if (id && this.abilities.swap(mp, entry.actorId, id, 0, a.key)) entry.revoked.push(id);
    delete entry.rec.afflictions[a.key];
    return id;
  }

  // NEEDS_STAGE_EVENT: Weakened at hunger stage 5
  private onNeedsStage(ctx: SystemContext, actorId: number, hunger: number): void {
    const entry = this.online.get(actorId);
    if (!entry || !entry.coldAt) return;
    setImmediate(() => {
      if (this.online.get(actorId) === entry) this.rollAffliction(ctx.svr as Mp, entry, "weakened", Number(hunger) >= WORST_STAGE, Date.now());
    });
  }

  // Survival's affliction roll: at stage 5, at most once per tickMinutes whether the need stayed there or left and came back,
  // never while the affliction is held, in creation, dead or where cold does not run (the realms)
  private rollAffliction(mp: Mp, entry: Online, key: string, atWorst: boolean, now: number): void {
    const a = this.afflictions.find((x) => x.key === key);
    const rec = entry.rec;
    if (!a || !atWorst || !a.id || a.chance <= 0 || rec.afflictions[key] || entry.area === "none" || isCreationPending(mp, entry.actorId) || !isAlive(mp, entry.actorId)) return;
    const last = rec.lastRoll[key] || 0;
    if (now - last < a.tickMs) return;
    rec.lastRoll[key] = now;
    const roll = Math.random();
    const what = `[survival] ${hex(entry.actorId)} ${a.worst}: ${key} ${pct(a.chance)}, roll ${roll.toFixed(3)}`;
    if (roll >= a.chance) {
      this.log(`${what}, spared`);
      return;
    }
    this.abilities.grant(mp, entry.actorId, a.id, a.key);
    rec.afflictions[key] = { until: now + this.afflictionMs, spell: this.descOf(mp, a.id) };
    this.save(mp, entry);
    const hours = Math.round(this.afflictionMs / HOUR_MS * 10) / 10;
    this.log(`${what}, ${key} for ${hours} h until ${clock(rec.afflictions[key].until)}`);
    this.notice(mp, entry.actorId, `${a.notice} for ${hours} hours. ${this.cureHint()}`);
    this.sendState(mp, entry, false);
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
    if (entry.coldAt) this.sendState(mp, entry, false);
  }

  // Clears food poisoning, the afflictions and the diseases; a healing potion also takes every other Disease spell, which the native cure does for Cure Disease
  private cure(ctx: SystemContext, actorId: number, potionId: number, kind: "cureDisease" | "health"): void {
    const entry = this.online.get(actorId);
    if (!entry) return;
    const mp = ctx.svr as Mp;
    const cured = this.clearSickness(mp, entry, kind === "health");
    if (!cured.length && kind === "health") return;
    this.save(mp, entry);
    const how = kind === "cureDisease" ? "Cure Disease" : `restores ${Math.round(potionHealing(mp, potionId))} health`;
    this.log(`[survival] ${hex(actorId)} cured by ${this.edidOf(mp, potionId)} (${how}): ${cured.join(", ") || "nothing survival tracks"}${kind === "cureDisease" ? ", the native cure took every Disease spell" : ""}`);
    if (cured.length) this.notice(mp, actorId, "The potion cures your sickness.");
    if (entry.coldAt) this.sendState(mp, entry, false);
  }

  // Food poisoning, the afflictions and the diseases held, and with allDiseases every other Disease spell learned; returns what went
  private clearSickness(mp: Mp, entry: Online, allDiseases: boolean): string[] {
    const actorId = entry.actorId;
    const cured: string[] = [];
    const done = new Set<number>();
    if (entry.rec.foodPoisonUntil) {
      done.add(this.idOfDesc(mp, entry.rec.foodPoisonSpell) || this.foodPoison);
      this.clearFoodPoisoning(mp, actorId, entry);
      cured.push("food poisoning");
    }
    for (const a of this.afflictions) {
      const id = this.dropAffliction(mp, entry, a);
      if (!id) continue;
      done.add(id);
      cured.push(this.edidOf(mp, id));
    }
    cured.push(...this.dropDiseases(mp, entry, () => true, done));
    for (const id of learnedSpells(mp, actorId)) {
      if (done.has(id) || !(this.afflictions.some((a) => a.id === id) || (allDiseases && spellInfo(mp, id).type === SpellType.Disease))) continue;
      try {
        removeSpellFrom(mp, actorId, id);
        entry.revoked.push(id);
        cured.push(this.edidOf(mp, id));
      } catch (e) {
        this.log(`[survival] ${hex(actorId)} could not remove ${hex(id)}: ${e}`);
      }
    }
    return cured;
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
    for (const a of this.afflictions) this.dropAffliction(mp, entry, a);
    const dropped = this.dropDiseases(mp, entry, () => true);
    Object.assign(entry.rec, { cold: this.cold.start, warmBonus: false, warmUntil: 0, lastRoll: {} });
    this.save(mp, entry);
    entry.bodyDue = true;
    this.log(`[survival] ${hex(actorId)} reset by ${by}${dropped.length ? `, removed ${dropped.join(", ")}` : ""}`);
    return true;
  }

  // ── Diseases ───────────────────────────────────────────────────────────────

  // A carrier creature's weapon or unarmed hit: one roll for one of its diseases the character lacks
  private hitDisease(ctx: SystemContext, targetId: number, aggressorId: number, sourceId: number): void {
    const mp = ctx.svr as Mp;
    const entry = this.online.get(targetId);
    if (!entry || !entry.coldAt || !this.exposed(mp, targetId)) return;
    const sourceType = sourceId ? String(this.lookup(mp, sourceId)?.record?.type ?? "") : "";
    if (sourceType && sourceType !== "WEAP") return;
    if (isPlayerActor(mp, aggressorId) || this.isPet(mp, aggressorId)) return;
    const carrier = this.carrierOfActor(mp, aggressorId);
    const c = carrier.key ? this.dis.carriers[carrier.key] : undefined;
    if (!c || c.chance <= 0) return;
    const held = entry.rec.diseases.map((d) => d.id);
    const candidates = c.diseases.filter((id) => this.hasDisease(id) && held.indexOf(id) === -1);
    if (!candidates.length) return;
    this.rollDisease(mp, entry, candidates, c.chance, `${hex(targetId)} hit by ${carrier.edid} ${hex(aggressorId)}: ${carrier.key}`, `${carrier.key} ${carrier.edid}`, "");
  }

  // The race's editor id and the carrier it matches, cached per race
  private carrierOfActor(mp: Mp, actorId: number): { edid: string; key: string } {
    const raceId = actorRaceId(mp, actorId);
    let hit = this.carrierCache.get(raceId);
    if (!hit) {
      const edid = raceId ? this.edidOf(mp, raceId) : "";
      hit = { edid: edid || "unknown race", key: carrierOf(edid, this.dis.carriers, this.dis.exclude) };
      this.carrierCache.set(raceId, hit);
    }
    return hit;
  }

  // Alive, out of creation and not hidden by an admin mode
  private exposed(mp: Mp, actorId: number): boolean {
    return !isCreationPending(mp, actorId) && isAlive(mp, actorId) && !hasAdminMode(mp, actorId, UNSEEN_MODES);
  }

  private isPet(mp: Mp, actorId: number): boolean {
    try {
      return !!mp.get(actorId, PET_PROP);
    } catch {
      return false;
    }
  }

  // One roll at chance x (1 - disease resist); a success gives one of the candidates, unless the character already holds survivalMaxDiseases
  private rollDisease(mp: Mp, entry: Online, candidates: string[], chance: number, what: string, from: string, how: string, logSpared = true): void {
    const resist = abilityResist(mp, entry.actorId, ActorValue.DiseaseResist);
    const odds = resistedChance(chance, resist);
    const roll = Math.random();
    const line = `[survival] ${what} ${pct(chance)} x (1 - disease resist ${resist}%) = ${pct(odds)}, roll ${roll.toFixed(3)}`;
    if (roll >= odds) {
      if (logSpared) this.log(`${line}, spared`);
      return;
    }
    const id = pickDisease(candidates, entry.rec.diseases.map((d) => d.id), Math.random());
    const def = this.dis.diseases[id];
    if (!def) return;
    if (entry.rec.diseases.length >= this.dis.max) {
      this.log(`${line}, ${id} refused: already sick with ${entry.rec.diseases.length} (survivalMaxDiseases ${this.dis.max})`);
      return;
    }
    const d = this.infect(mp, entry, id, 1, from, Date.now());
    if (!d) return;
    this.log(`${line}, caught ${id} (${this.edidOf(mp, this.idOfDesc(mp, d.spell))}), stage 2 at ${when(d.nextAt)}`);
    this.notice(mp, entry.actorId, `You have caught ${def.name}${how}: ${def.effect}. It worsens over the coming days. ${this.cureHint()}`);
  }

  // Grants the disease at the stage and records it; null when its stage spell is missing
  private infect(mp: Mp, entry: Online, id: string, stage: number, from: string, now: number): HeldDisease | null {
    const def = this.dis.diseases[id];
    const spell = this.diseaseSpells.get(id)?.[stage - 1] || 0;
    if (!def || !spell) return null;
    this.abilities.grant(mp, entry.actorId, spell, id);
    const d: HeldDisease = { id, stage, nextAt: nextStageAt(stage, now, def.stageHours), since: now, from, spell: this.descOf(mp, spell) };
    entry.rec.diseases.push(d);
    this.save(mp, entry);
    this.sendState(mp, entry, false);
    this.publishContagious(mp, entry);
    return d;
  }

  // Swaps the held stage spell for the stage's; false when the stage spell is missing or the swap failed
  private setDiseaseStage(mp: Mp, entry: Online, d: HeldDisease, stage: number): boolean {
    const want = this.diseaseSpells.get(d.id)?.[stage - 1] || 0;
    const held = this.idOfDesc(mp, d.spell);
    if (!want || (held !== want && !this.abilities.swap(mp, entry.actorId, held, want, d.id))) return false;
    d.stage = stage;
    d.spell = this.descOf(mp, want);
    return true;
  }

  // Every stage due by now, offline time included; one line and one notice per disease that worsened
  private progressDiseases(mp: Mp, entry: Online, now: number, lines: string[]): void {
    if (!this.dis.enabled) return;
    for (const d of entry.rec.diseases) {
      const def = this.dis.diseases[d.id];
      if (!def || d.stage >= DISEASE_STAGES) continue;
      const due = d.nextAt;
      const from = d.stage;
      const next = stageAt(d.stage, d.nextAt, now, def.stageHours);
      if (next.stage === from || !this.setDiseaseStage(mp, entry, d, next.stage)) continue;
      d.nextAt = next.nextAt;
      lines.push(`${d.id} worsened ${from} -> ${d.stage} (${this.edidOf(mp, this.idOfDesc(mp, d.spell))}, due ${when(due)}), ${d.nextAt ? `stage ${d.stage + 1} at ${when(d.nextAt)}` : "stays until cured"}`);
      this.notice(mp, entry.actorId, `Your ${def.name} has worsened to its ${d.stage === DISEASE_STAGES ? "severe" : "advanced"} stage. ${this.cureHint()}`);
    }
  }

  // Removes the held diseases pick chooses and their stage spells; returns the spells removed, adding their ids to done
  private dropDiseases(mp: Mp, entry: Online, pick: (d: HeldDisease) => boolean, done?: Set<number>): string[] {
    const removed: string[] = [];
    entry.rec.diseases = entry.rec.diseases.filter((d) => {
      if (!pick(d)) return true;
      const id = this.idOfDesc(mp, d.spell);
      if (id && this.abilities.swap(mp, entry.actorId, id, 0, d.id)) entry.revoked.push(id);
      if (id) done?.add(id);
      removed.push(id ? this.edidOf(mp, id) : d.spell);
      return false;
    });
    if (removed.length) this.publishContagious(mp, entry);
    return removed;
  }

  private contagionOn(): boolean {
    return this.enabled && this.dis.enabled && this.dis.contagion.chance > 0;
  }

  // ff_contagious for the clients' contagion check: the contagious diseases held, null for none; written only when it changes
  private publishContagious(mp: Mp, entry: Online): void {
    const ids = this.contagionOn() ? entry.rec.diseases.filter((d) => this.dis.diseases[d.id]?.contagious && this.hasDisease(d.id)).map((d) => d.id) : [];
    const key = ids.join(",");
    if (entry.contagious === key) return;
    try {
      const stored = entry.contagious === null ? mp.get(entry.actorId, CONTAGIOUS_PROP) : undefined;
      if (entry.contagious !== null || (Array.isArray(stored) ? stored.join(",") : "") !== key) mp.set(entry.actorId, CONTAGIOUS_PROP, ids.length ? ids : null);
      entry.contagious = key;
    } catch (e) {
      if (!this.contagiousFailed) this.log(`[survival] ${CONTAGIOUS_PROP} could not be written, so no client sees who is contagious (makeProperty in gamemode.js?): ${e}`);
      this.contagiousFailed = true;
    }
  }

  // A client's survivalExposure, checked against the records but never the distance; one roll per disease and pair per cooldown
  private onExposure(mp: Mp, userId: number, content: Content): void {
    const entry = Array.from(this.online.values()).find((e) => e.userId === userId);
    if (!entry || !this.contagionOn()) return;
    const c = this.dis.contagion;
    const now = Date.now();
    if (now - entry.exposureAt < exposureGapMs(c.checkSeconds)) return;
    entry.exposureAt = now;
    if (entry.rec.diseases.length >= this.dis.max || !this.canSpreadOrCatch(mp, entry)) return;
    for (const [key, at] of entry.exposureRolls) if (now - at >= c.cooldownMinutes * 60000) entry.exposureRolls.delete(key);
    const picked = new Map<string, number>();
    const refused: string[] = [];
    let cooling = false;
    const sources = Array.isArray(content["sources"]) ? (content["sources"] as unknown[]).slice(0, EXPOSURE_MAX_SOURCES) : [];
    for (const raw of sources) {
      const s = isObject(raw) ? raw : {};
      const sourceId = Number(s.actorId) >>> 0;
      const src = this.online.get(sourceId);
      const away = !src || src === entry ? "from no other online player" : !this.canSpreadOrCatch(mp, src) ? "from a hidden, dead, fallen or unsettled player" : "";
      for (const id of Array.isArray(s.diseases) ? s.diseases.slice(0, EXPOSURE_MAX_DISEASES).map(String) : []) {
        if (picked.has(id)) continue;
        const def = this.dis.diseases[id];
        const why = !def ? "unknown" : away || (!def.contagious || !this.hasDisease(id) ? "not contagious" : !src!.rec.diseases.some((d) => d.id === id) ? "not carried"
          : entry.rec.diseases.some((d) => d.id === id) ? "held already" : "");
        if (why) refused.push(`${hex(sourceId)} ${def ? id : "?"} ${why}`);
        else if (entry.exposureRolls.has(`${sourceId}:${id}`)) cooling = true;
        else picked.set(id, sourceId);
      }
    }
    if (!picked.size && !cooling && refused.length && now - entry.exposureLogAt >= EXPOSURE_LOG_MS) {
      entry.exposureLogAt = now;
      this.log(`[survival] contagion report from ${hex(entry.actorId)} named nothing catchable: ${refused.slice(0, 4).join(", ")}${refused.length > 4 ? ", ..." : ""}`);
    }
    for (const [id, sourceId] of picked) {
      if (entry.rec.diseases.length >= this.dis.max) break;
      entry.exposureRolls.set(`${sourceId}:${id}`, now);
      const what = `contagion ${hex(entry.actorId)} from ${hex(sourceId)} ${describeActor(mp, sourceId)}: ${id}`;
      this.rollDisease(mp, entry, [id], c.chance, what, `contagion ${hex(sourceId)}`, " from someone near you", false);
    }
  }

  // Settled, alive, out of creation, outside the afterlife realms and not hidden by an admin mode
  private canSpreadOrCatch(mp: Mp, entry: Online): boolean {
    return !!entry.coldAt && this.exposed(mp, entry.actorId) && !afterlifeOf(mp, entry.actorId);
  }

  // Every stage spell of the disease is in the load order
  private hasDisease(id: string): boolean {
    const spells = this.diseaseSpells.get(id);
    return !!this.dis.diseases[id] && !!spells && spells.length === DISEASE_STAGES && spells.every((s) => s);
  }

  private diseaseName(id: string): string {
    return this.dis.diseases[id]?.name || id;
  }

  // A catalog id or name, any case, spaces and hyphens ignored; "" for none
  private diseaseIdOf(raw: unknown): string {
    const key = String(raw ?? "").toLowerCase().replace(/[\s-]/g, "");
    if (!key) return "";
    return Object.values(this.dis.diseases).find((d) => d.id.toLowerCase() === key || d.name.toLowerCase().replace(/[\s-]/g, "") === key)?.id || "";
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  // SURVIVAL_ADMIN_EVENT: the admin panel's survival row
  private adminRequest(ctx: SystemContext, actorId: number, by: string, request: SurvivalAdminRequest): SurvivalAdminResult {
    const mp = ctx.svr as Mp;
    const op = String(request?.op ?? "");
    if (op === "catalog") return { ok: true, text: "", catalog: this.catalog() };
    const entry = this.online.get(actorId);
    if (!entry || !entry.coldAt) return { ok: false, text: "survival has not settled on this character yet (just logged in or still in creation)" };
    if (op === "summary") return { ok: true, text: this.readout(entry), summary: this.summaryOf(entry) };
    if (op === "setCold") return this.adminCold(mp, entry, by, request.cold);
    if (op === "giveDisease") return this.adminDisease(mp, entry, by, request.disease, request.stage);
    if (op === "cure") return this.adminCure(mp, entry, by, request.disease);
    return { ok: false, text: `unknown survival request '${op}'` };
  }

  private adminCold(mp: Mp, entry: Online, by: string, raw: unknown): SurvivalAdminResult {
    if (!this.cold.enabled) return { ok: false, text: "cold is switched off (survivalColdEnabled false)" };
    const value = raw === "" || raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > COLD_MAX) return { ok: false, text: `cold must be a number from 0 to ${COLD_MAX}` };
    const before = entry.rec.cold;
    this.setCold(mp, entry.actorId, entry, value, `cold set by ${by}`);
    this.save(mp, entry);
    this.sendState(mp, entry, false);
    return { ok: true, text: `cold ${Math.round(before)} -> ${Math.round(entry.rec.cold)} (${COLD_STAGE_NAMES[this.stageOf(entry)]})`, summary: this.summaryOf(entry) };
  }

  // Gives the disease at the stage, or sets the stage of one held; survivalMaxDiseases does not bind an admin
  private adminDisease(mp: Mp, entry: Online, by: string, rawId: unknown, rawStage: unknown): SurvivalAdminResult {
    if (!this.dis.enabled) return { ok: false, text: "diseases are switched off (survivalDiseasesEnabled false)" };
    const id = this.diseaseIdOf(rawId);
    const def = this.dis.diseases[id];
    if (!def) return { ok: false, text: `no disease called '${String(rawId ?? "")}'` };
    if (!this.hasDisease(id)) return { ok: false, text: `${def.name} is not in the plugin yet` };
    const stage = rawStage === undefined || rawStage === null || rawStage === "" ? 1 : Number(rawStage);
    if (!Number.isInteger(stage) || stage < 1 || stage > DISEASE_STAGES) return { ok: false, text: `the stage must be 1 to ${DISEASE_STAGES}` };
    const now = Date.now();
    const held = entry.rec.diseases.find((d) => d.id === id);
    if (held) {
      if (!this.setDiseaseStage(mp, entry, held, stage)) return { ok: false, text: `${def.name} could not be set to stage ${stage}, see the server log` };
      held.nextAt = nextStageAt(stage, now, def.stageHours);
      this.save(mp, entry);
      this.sendState(mp, entry, false);
    } else if (!this.infect(mp, entry, id, stage, `admin ${by}`, now)) {
      return { ok: false, text: `${def.name} could not be given, see the server log` };
    }
    const d = entry.rec.diseases.find((x) => x.id === id)!;
    this.log(`[survival] ${hex(entry.actorId)} given ${id} stage ${stage} by ${by}${held ? " (held, stage set)" : ""}, ${d.nextAt ? `stage ${stage + 1} at ${when(d.nextAt)}` : "stays until cured"}`);
    this.notice(mp, entry.actorId, held ? `Your ${def.name} is now ${stageName(def.name, stage)}. ${this.cureHint()}` : `You have caught ${stageName(def.name, stage)}: ${def.effect}. ${this.cureHint()}`);
    return { ok: true, text: `now has ${stageName(def.name, stage)}`, summary: this.summaryOf(entry) };
  }

  // One disease, or with none named every sickness as a healing potion would cure it
  private adminCure(mp: Mp, entry: Online, by: string, rawId: unknown): SurvivalAdminResult {
    let cured: string[];
    if (String(rawId ?? "").trim()) {
      const id = this.diseaseIdOf(rawId);
      if (!entry.rec.diseases.some((d) => d.id === id)) return { ok: false, text: `does not have ${id ? this.diseaseName(id) : `'${String(rawId)}'`}` };
      cured = this.dropDiseases(mp, entry, (d) => d.id === id);
    } else {
      cured = this.clearSickness(mp, entry, true);
    }
    this.save(mp, entry);
    this.sendState(mp, entry, false);
    this.log(`[survival] ${hex(entry.actorId)} cured by ${by} (admin): ${cured.join(", ") || "nothing"}`);
    if (cured.length) this.notice(mp, entry.actorId, "You are cured of your sickness.");
    return { ok: true, text: cured.length ? `cured ${cured.map((c) => this.sicknessLabel(c)).join(", ")}` : "had no sickness", summary: this.summaryOf(entry) };
  }

  // "Rockjoint (severe)" for AldDisease_Rockjoint3 and an affliction's name for its spell; anything else as it came
  private sicknessLabel(edid: string): string {
    for (const d of Object.values(this.dis.diseases)) {
      const stage = d.spells.indexOf(edid) + 1;
      if (stage) return stageName(d.name, stage);
    }
    return this.afflictions.find((a) => a.spell === edid)?.name || edid;
  }

  private catalog(): SurvivalCatalog {
    const diseases = this.dis.enabled ? Object.values(this.dis.diseases).filter((d) => this.hasDisease(d.id)) : [];
    return { diseases: diseases.map((d) => ({ id: d.id, name: d.name, contagious: d.contagious })), coldMax: COLD_MAX, coldStages: this.cold.stages.slice() };
  }

  private summaryOf(entry: Online): SurvivalSummary {
    const on = this.cold.enabled;
    const rec = entry.rec;
    return {
      cold: on ? Math.round(rec.cold) : -1,
      stage: on ? COLD_STAGE_NAMES[this.stageOf(entry)] : "",
      area: entry.area,
      level: entry.level,
      warmth: Math.round(entry.warmth),
      freezingArea: entry.freezingArea,
      diseases: rec.diseases.map((d) => ({ id: d.id, name: this.diseaseName(d.id), stage: d.stage, nextAt: d.nextAt })),
      afflictions: this.afflictions.filter((a) => rec.afflictions[a.key]).map((a) => ({ name: a.name, until: rec.afflictions[a.key].until })),
      foodPoisonUntil: rec.foodPoisonUntil,
    };
  }

  // The admin panel's readout: cold, the place and what the character is sick with
  private readout(entry: Online): string {
    const rec = entry.rec;
    const cold = this.cold.enabled ? `cold ${Math.round(rec.cold)} (${COLD_STAGE_NAMES[this.stageOf(entry)]})` : "cold off";
    const place = entry.area ? `area ${entry.area}, ${this.climateNote(entry)}, freezing water area ${entry.freezingArea ? "yes" : "no"}` : "area not known yet";
    const sick = [
      ...rec.diseases.map((d) => `${stageName(this.diseaseName(d.id), d.stage)}${d.nextAt ? ` (worse at ${when(d.nextAt)})` : ""}`),
      ...this.afflictions.filter((a) => rec.afflictions[a.key]).map((a) => `${a.name} until ${when(rec.afflictions[a.key].until)}`),
      ...(rec.foodPoisonUntil ? [`food poisoning until ${when(rec.foodPoisonUntil)}`] : []),
    ];
    return `${cold}; ${place}; ${sick.join(", ") || "no sickness"}`;
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
    if (!this.climate(mp, actorId, entry, now)) return;
    if (this.cold.enabled && !isCreationPending(mp, actorId) && isAlive(mp, actorId)) {
      const rec = entry.rec;
      const before = rec.cold;
      const mult = this.racial.traits(actorId).coldRateMult * this.diseaseMult(entry, "cold");
      entry.warmth = this.warmthOf(mp, actorId, entry, now);
      let cold = before;
      if (entry.inFreezingWater && cold < this.cold.stages[2]) cold += (this.cold.stages[2] - cold) * clamp(mult, 0, 1);
      if (entry.area !== "none" && !entry.nearHeat) {
        const rate = coldRatePerSec(entry.level, entry.warmth, mult * areaRateOf(entry.area as AreaClass, entry.inFreezingWater, this.cold.areaRate), this.cold);
        cold = stepCold(cold, seconds, coldCapOf(entry.level, this.cold), rate, this.cold.warmPerMinute / 60, now - entry.fightAt < FIGHT_MS);
      }
      entry.temperature = temperatureLevelOf(before, cold, entry.level, entry.nearHeat, entry.area as AreaClass, this.cold.caps);
      if (cold !== before) this.setCold(mp, actorId, entry, cold, "");
      this.rollAffliction(mp, entry, "frostbitten", this.stageOf(entry) >= WORST_STAGE, now);
      if (now - entry.savedAt >= SAVE_MS && Math.abs(rec.cold - entry.savedCold) >= 1) this.save(mp, entry);
    }
    this.sendState(mp, entry, force);
  }

  // Area, cold level and freezing water; logs a change of area or of freezing water; false when the character is in no known place
  private climate(mp: Mp, actorId: number, entry: Online, now: number): boolean {
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
    if (inWater !== entry.inFreezingWater) {
      const drain = this.cold.freezingWaterDamage;
      const health = inWater ? -1 : this.drainInWater(mp, entry, now);
      Object.assign(entry, { waterAt: inWater ? now : 0, waterHealth: -1 });
      this.log(`[survival] ${hexId} ${inWater ? "swimming in" : "out of the"} freezing water: level ${level}, cold ${Math.round(entry.rec.cold)}` +
        `${inWater ? `, health -${drain} a second x (1 - frost resist ${this.frostResistOf(mp, entry)}%, client ${entry.frostResist}%)` : health >= 0 ? `, health ${pct(health)}` : ""}`);
      if (inWater && drain > 0 && now - entry.waterNoticeAt >= WATER_NOTICE_GAP_MS && this.exposed(mp, actorId)) {
        entry.waterNoticeAt = now;
        this.notice(mp, actorId, "The water is freezing: it drains your health while you swim in it.");
      }
    }
    Object.assign(entry, { area, areaWhy: why, freezingArea, inFreezingWater: inWater, level, levelParts: parts });
    return true;
  }

  // The race's and abilities' frost resistance from the records, or the client's reported FrostResist value when that is larger (worn gear, potions)
  private frostResistOf(mp: Mp, entry: Online): number {
    return Math.max(abilityResist(mp, entry.actorId, ActorValue.FrostResist), entry.frostResist);
  }

  // Takes the health the time since waterAt cost and the regeneration since the last tick; returns the share of the bar left, -1 when unread
  private drainInWater(mp: Mp, entry: Online, now: number): number {
    const actorId = entry.actorId;
    // A stalled server counts two ticks at most
    const seconds = entry.waterAt ? Math.min(now - entry.waterAt, 2 * WATER_TICK_MS) / 1000 : 0;
    const last = entry.waterHealth;
    Object.assign(entry, { waterAt: now, waterHealth: -1 });
    try {
      const held = mp.get(actorId, "percentages");
      const health = Number(held?.health);
      if (!(health > 0) || !this.exposed(mp, actorId)) return Number.isFinite(health) ? health : -1;
      const share = freezingWaterDrain(this.cold.freezingWaterDamage, seconds, this.racial.maxHealth(actorId) * this.healthScaleOf(actorId), this.frostResistOf(mp, entry));
      if (share <= 0) return health;
      const from = last >= 0 && health > last && health - last <= this.waterRegenShare ? last : health;
      entry.waterHealth = Math.max(0, from - share);
      mp.set(actorId, "percentages", { ...held, health: entry.waterHealth });
      return entry.waterHealth;
    } catch (e) {
      this.log(`[survival] freezing water health of ${hex(actorId)} failed: ${e}`);
      return -1;
    }
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
      const torch = infos.some((i) => i.torch);
      entry.gear = gearWarmth(infos.map((i) => i.armor).filter((a): a is WornArmor => !!a), torch, this.cold.warmth);
      entry.engineGear = gearWarmth(infos.map((i) => i.engine).filter((a): a is WornArmor => !!a), torch, this.cold.warmth);
    }
    return entry.gear + this.racial.traits(actorId).warmth + (entry.rec.warmUntil > now ? this.cold.hotFoodWarmth : 0);
  }

  // Slots and warmth of an ARMO by its keyword, else by the armorWarmth.ts table, or a carried light; cached per base
  private armorInfo(mp: Mp, baseId: number): ArmorInfo {
    let info = this.armorCache.get(baseId);
    if (info) return info;
    let rec: any = null;
    try { rec = mp.lookupEspmRecordById(baseId); } catch { rec = null; }
    const type = String(rec?.record?.type ?? "");
    info = { armor: null, engine: null, torch: type === "LIGH" };
    if (type === "ARMO") {
      const bod = fieldData(rec, "BOD2") || fieldData(rec, "BODT");
      const kws = espmFieldFormIds(rec, "KWDA");
      const has = (id: number): boolean => !!id && kws.indexOf(id) !== -1;
      const own: WornArmor = {
        slots: bod && bod.byteLength >= 4 ? view(bod).getUint32(0, true) : 0,
        kind: has(this.keywords.warm) ? "warm" : has(this.keywords.cold) ? "cold" : "normal",
        bodyAndHead: has(this.keywords.bodyAndHead),
      };
      const rated = (own.slots & RATED_SLOTS) !== 0;
      const row = this.cold.warmthTable && (!rated || own.kind === "normal") ? this.tableRow(mp, baseId) : undefined;
      info.engine = own;
      info.armor = row && rated && row.kind ? { ...own, kind: row.kind } : row && !rated && row.extra ? { ...own, extra: row.extra } : own;
    }
    this.armorCache.set(baseId, info);
    return info;
  }

  private tableRow(mp: Mp, baseId: number): TableRow | undefined {
    let desc = "";
    try { desc = String(mp.getDescFromId(baseId) || ""); } catch { desc = ""; }
    return WARMTH_TABLE.get(desc.toLowerCase());
  }

  // The engine's Warmth total against the server's keyword gear and race sum (a hot meal may count or not); one line per differing pair
  private checkWarmth(mp: Mp, entry: Online, engine: number, now: number): void {
    const gear = entry.engineGear;
    const table = entry.gear === gear ? "" : `; gear ${entry.gear} with armorWarmth.ts`;
    const race = this.racial.traits(entry.actorId).warmth;
    const food = entry.rec.warmUntil > now ? this.cold.hotFoodWarmth : 0;
    const server = gear + race;
    if (Math.abs(engine - server) <= 1 || (food && Math.abs(engine - server - food) <= 1)) return;
    const key = `${Math.round(engine)}/${Math.round(server)}`;
    if (entry.engineSeen === key) return;
    entry.engineSeen = key;
    this.log(`[survival] ${hex(entry.actorId)} warmth mismatch: engine ${round(engine)}, server ${round(server)} (gear ${gear}, race ${race}${food ? `, hot meal ${food} not counted` : ""}${table}), worn ${entry.wornKey.split(",").filter((x) => x).map((id) => this.edidOf(mp, Number(id))).join(", ") || "nothing"}`);
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
    if (amount > 0 && before < s[3]) cold = Math.min(s[3], before + amount * this.racial.traits(actorId).coldRateMult * this.diseaseMult(entry, "cold"));
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

  // A respawn wakes at the new-character cold and with the respawn health, written once the state has lifted the cold penalty on the client
  private onRespawn(ctx: SystemContext, actorId: number): void {
    const entry = this.online.get(actorId);
    const mp = ctx.svr as Mp;
    if (!entry) return;
    Object.assign(entry, { swimming: false, inFreezingWater: false, waterAt: 0 });
    if (entry.coldAt && this.cold.enabled) {
      const before = entry.rec.cold;
      entry.rec.warmBonus = false;
      entry.killed = false;
      this.setCold(mp, actorId, entry, this.cold.start, "");
      this.save(mp, entry);
      this.log(`[survival] ${hex(actorId)} respawned: cold ${Math.round(before)} -> ${this.cold.start}`);
      this.sendState(mp, entry, true);
    }
    this.wake(mp, actorId, "respawned");
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
      afflictions: this.afflictions.filter((a) => entry.rec.afflictions[a.key]).map((a) => a.name),
      diseases: (entry.rec.foodPoisonUntil ? [{ name: FOOD_POISONING_NAME, stage: 1 }] : [])
        .concat(entry.rec.diseases.map((d) => ({ name: this.diseaseName(d.id), stage: d.stage }))),
      contagion: this.contagionOn() ? { seconds: this.dis.contagion.checkSeconds, range: this.dis.contagion.range } : null,
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

  // The scale this session wrote, within the bounds the native keeps it in (HealthScale::FromDump); 1 with the switch off
  private healthScaleOf(actorId: number): number {
    const scale = this.cold.healthScale ? this.online.get(actorId)?.healthScale ?? 1 : 1;
    return scale < 0 ? 1 : Math.min(100, Math.max(0.01, scale));
  }

  private scaled(mp: Mp, actorId: number): boolean {
    try {
      const v = mp.get(actorId, HEALTH_SCALE_PROP);
      return typeof v === "number" && v !== 1;
    } catch {
      return false;
    }
  }

  // The body spells, the cold stages, each disease's stages and what else is held or was removed this session, for the login re-send
  private groupsOf(mp: Mp, entry: Online): AbilityGroup[] {
    const held = new Set(entry.rec.body.spells.map((d) => this.idOfDesc(mp, d)));
    if (entry.rec.foodPoisonUntil) held.add(this.idOfDesc(mp, entry.rec.foodPoisonSpell) || this.foodPoison);
    for (const a of this.afflictions) if (entry.rec.afflictions[a.key]) held.add(this.idOfDesc(mp, entry.rec.afflictions[a.key].spell) || a.id);
    const coldSpells = this.coldSpells.filter((id) => id);
    const diseases = entry.rec.diseases.map((d) => ({ what: d.id, held: this.idOfDesc(mp, d.spell), stages: (this.diseaseSpells.get(d.id) || []).filter((id) => id) }));
    const ids = new Set([...this.body.map((b) => b.id), ...entry.revoked, ...held]);
    ids.delete(0);
    for (const id of [...coldSpells, ...diseases.flatMap((g) => g.stages)]) ids.delete(id);
    const groups = [...Array.from(ids).map((id) => ({ what: this.edidOf(mp, id), held: held.has(id) ? id : 0, stages: [id] })), ...diseases];
    return coldSpells.length ? [...groups, { what: "cold stage", held: this.idOfDesc(mp, entry.rec.coldSpell), stages: coldSpells }] : groups;
  }

  describe(): string {
    const line = factorLine(this.dis.diseases);
    return line ? `diseases ${line} by stage, while survivalEnabled and survivalDiseasesEnabled` : "no factors in force";
  }

  hungerDrainMult(actorId: number): number {
    return this.factorFor(actorId, "hunger");
  }

  foodHungerMult(actorId: number): number {
    return this.factorFor(actorId, "food");
  }

  fatigueRegenMult(actorId: number): number {
    return this.factorFor(actorId, "rest");
  }

  // A character survival does not follow yet (NeedsSystem's login runs first) counts at the stages its record held at logout
  private factorFor(actorId: number, kind: DiseaseFactor): number {
    if (!this.enabled || !this.dis.enabled) return 1;
    const entry = this.online.get(actorId);
    const held = entry ? entry.rec.diseases : this.mp ? this.read(this.mp, actorId)?.diseases ?? [] : [];
    return diseaseFactor(this.dis.diseases, held, kind);
  }

  private diseaseMult(entry: Online, kind: DiseaseFactor): number {
    return this.dis.enabled ? diseaseFactor(this.dis.diseases, entry.rec.diseases, kind) : 1;
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

  private lookup(mp: Mp, id: number): any {
    try { return id ? mp.lookupEspmRecordById(id) : null; } catch { return null; }
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
      const afflictions: Record<string, { until: number; spell: string }> = {};
      const lastRoll: Record<string, number> = {};
      // A key without a definition is kept for applyBody to take back
      for (const [key, held] of Object.entries(isObject(raw.afflictions) ? raw.afflictions : {})) {
        if (isObject(held) && Number(held.until) > 0 && typeof held.spell === "string") afflictions[key] = { until: Number(held.until), spell: held.spell };
      }
      for (const { key } of AFFLICTION_DEFS) if (Number(raw.lastRoll?.[key]) > 0) lastRoll[key] = Number(raw.lastRoll[key]);
      const diseases: HeldDisease[] = [];
      for (const d of Array.isArray(raw.diseases) ? raw.diseases : []) {
        const stage = Number(d?.stage);
        if (typeof d?.id !== "string" || !d.id || typeof d.spell !== "string" || !Number.isInteger(stage) || stage < 1 || stage > DISEASE_STAGES || diseases.some((x) => x.id === d.id)) continue;
        const nextAt = Number(d.nextAt) > 0 || stage === DISEASE_STAGES ? Math.max(0, Number(d.nextAt) || 0) : nextStageAt(stage, Date.now(), this.dis.diseases[d.id]?.stageHours ?? this.dis.stageHours);
        diseases.push({ id: d.id, stage, nextAt: stage === DISEASE_STAGES ? 0 : nextAt, since: Number(d.since) || 0, from: typeof d.from === "string" ? d.from : "", spell: d.spell });
      }
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
        afflictions,
        lastRoll,
        diseases,
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
  private respawnPoints = DEFAULT_RESPAWN_POINTS;
  private poisonChance = DEFAULT_POISON_CHANCE;
  private poisonMs = DEFAULT_POISON_HOURS * HOUR_MS;
  private cureMode: CureMode = "cureDiseaseOrHealth";
  private cureMinHealth = DEFAULT_CURE_MIN_HEALTH;
  private body: BodySpell[] = [];
  private foodPoison = 0;
  private afflictions: Affliction[] = [];
  private afflictionMs = DEFAULT_AFFLICTION_HOURS * HOUR_MS;
  private rawMeat = new Set<number>();
  private altars = new Set<number>();
  private cold: ColdConfig = parseColdSettings({}, []);
  // Share of the bar the regeneration rate yields in WATER_REGEN_SECONDS
  private waterRegenShare = BASE_HEAL_RATE_PCT / 100 * WATER_REGEN_SECONDS;
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
  private dis: DiseaseConfig = parseDiseaseSettings({}, []);
  // Stage spell ids per disease, 0 for one the plugin lacks
  private diseaseSpells = new Map<string, number[]>();
  // Race id -> its editor id and the carrier fragment it matches, "" for none
  private carrierCache = new Map<number, { edid: string; key: string }>();
  // Set once ff_contagious failed (not registered in gamemode.js), so it is logged once
  private contagiousFailed = false;
  private mp: Mp = null;
}
