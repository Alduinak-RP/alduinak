// Survival cold rules as pure functions and their default tables, from Survival Mode's Survival_NeedCold, Survival_PlayerLocationInfo
// and Survival_HeatCheck scripts with the rate taken in real hours; SurvivalSystem feeds them what the server knows of a character.

export const COLD_MAX = 1000;
export const COLD_STAGE_NAMES = ["Warm", "Comfortable", "Chilly", "Very Cold", "Freezing", "Numb"];

// "interior" is a warm interior; "none" skips cold (Oblivion planes, afterlife realms)
export type AreaClass = "none" | "interior" | "chillyInterior" | "warm" | "cool" | "freezing";
const OUTDOOR: AreaClass[] = ["warm", "cool", "freezing"];
const CLIMATE_CLASSES: AreaClass[] = ["none", "warm", "cool", "freezing"];

export type WeatherAdd = "blizzard" | "snow" | "rain" | "";

export interface ColdLevels {
  warm: number;
  cool: number;
  freezing: number;
  chillyInterior: number;
  warmNight: number;
  coolNight: number;
  freezingNight: number;
  rain: number;
  snow: number;
  blizzard: number;
  freezingWater: number;
}

export interface WarmthTable {
  // Body, head, hands, feet
  normal: number[];
  warm: number[];
  cold: number[];
  torch: number;
  cloak: number;
  max: number;
  maxReduction: number;
}

export interface ColdConfig {
  enabled: boolean;
  hoursToNumb: number;
  levelMult: number;
  // Cold at which stages 1 to 5 begin
  stages: number[];
  start: number;
  levels: ColdLevels;
  // Cold level that unlocks each of the stages 1 to 5 as a maximum
  caps: number[];
  // Night after the first hour and before the second
  night: number[];
  regionClimate: Record<string, AreaClass>;
  worldClimate: Record<string, AreaClass>;
  freezingZ: number;
  // Weather region id -> height above which it counts as freezing
  highRegions: Record<string, number>;
  warmPerMinute: number;
  offlineWarmPerHour: number;
  heatRadius: number;
  heatRestore: number;
  heatCheckSeconds: number;
  heatStillUnits: number;
  heatExtraBases: string[];
  heatKeywords: string[];
  warmth: WarmthTable;
  // armorWarmth.ts rates the pieces the engine leaves plain or unrated
  warmthTable: boolean;
  hotFoodWarmth: number;
  hotFoodMinutes: number;
  spellHitCold: number;
  // Aggressor race editor id fragment -> cold a hit adds
  coldOnHit: Record<string, number>;
  kills: boolean;
  stageAbilities: boolean;
  healthPenalty: boolean;
  maxHealthPenalty: number;
  healthScale: boolean;
  freezingWater: boolean;
  freezingWaterWorlds: string[];
}

export const DEFAULT_COLD_LEVELS: ColdLevels = { warm: 0, cool: 3, freezing: 6, chillyInterior: 6, warmNight: 1, coolNight: 2, freezingNight: 4, rain: 3, snow: 6, blizzard: 10, freezingWater: 30 };
// Aggressor race editor id fragment -> cold, vanilla's frostbite venom (Survival_FrostbitePoisonEffects)
export const DEFAULT_COLD_ON_HIT: Record<string, number> = { frostbitespider: 30, falmer: 30 };
export const DEFAULT_WARMTH: WarmthTable = { normal: [27, 18, 13, 13], warm: [54, 29, 24, 24], cold: [17, 8, 7, 7], torch: 50, cloak: 0, max: 206, maxReduction: 0.85 };

const regions = (cls: AreaClass, ids: string[]): Record<string, AreaClass> => Object.fromEntries(ids.map((id) => [id, cls]));

// Weather region ids of weatherRegions.ts, classed like Survival_RegionInfoSpell's region conditions
export const DEFAULT_REGION_CLIMATE: Record<string, AreaClass> = {
  ...regions("warm", ["pineForest", "fallForest", "fallForestNoPrecip", "ffRiften", "falkreath", "fallowstone", "ravenRock01", "volcanicAsh01", "volcanicAsh02"]),
  ...regions("cool", ["tundra", "tundraNoPrecip", "reach", "deepwoodRedoubt", "karthspireRedoubt", "darklightTower", "volcanicTundra", "volcanicTundraNoPrecip", "blackreachRegion", "dlc01Grove"]),
  ...regions("freezing", ["snow", "snowNoPrecip", "coast", "coastFog", "mountains", "mountainsNoPrecip", "tundraMarsh", "tundraMarshNoPrecip", "winterhold", "labyrinthian",
    "labyrinthianMaze", "japhetsFolly", "da02", "skaalVillage01", "dlc2SolstheimMtns", "dlc2SolstheimSnow", "dlc2SolstheimSnowHeavy", "dlc01VampCastleStorm", "dlc01Canyon",
    "dlc01Ice", "dlc01Playground", "dlc01fvBoss"]),
  ...regions("none", ["bluePalaceWing", "bluePalaceWingFEAR", "bluePalaceWingNMARE", "bluePalaceWingARENA"]),
};

// Worldspace editor id -> class, before the regions: the walled cities and the realms
export const DEFAULT_WORLD_CLIMATE: Record<string, AreaClass> = {
  ...regions("cool", ["WhiterunWorld", "WindhelmWorld", "SolitudeWorld", "MarkarthWorld"]),
  RiftenWorld: "warm",
  ...regions("none", ["Sovngarde", "DLC01SoulCairn", "DLC01Boneyard", "DLC2ApocryphaWorld", "BluePalaceWingWorld"]),
};

const DEFAULTS: Omit<ColdConfig, "levels" | "warmth" | "regionClimate" | "worldClimate" | "highRegions" | "coldOnHit"> = {
  enabled: true,
  hoursToNumb: 1.3334,
  levelMult: 50,
  stages: [50, 120, 300, 500, 800],
  start: 55,
  caps: [1, 4, 7, 10, 13],
  night: [19, 7],
  freezingZ: 19000,
  warmPerMinute: 40,
  offlineWarmPerHour: 1000,
  heatRadius: 580,
  heatRestore: 75,
  heatCheckSeconds: 6,
  heatStillUnits: 48,
  heatExtraBases: [],
  heatKeywords: ["CraftingCookpot", "AldCraftingKiln"],
  warmthTable: true,
  hotFoodWarmth: 25,
  hotFoodMinutes: 100,
  spellHitCold: 30,
  kills: false,
  stageAbilities: true,
  healthPenalty: true,
  maxHealthPenalty: 0.8,
  healthScale: false,
  freezingWater: true,
  freezingWaterWorlds: ["DLC1HunterHQWorld"],
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Reads the cold keys over the defaults; an unusable value keeps its default and is named in problems
export const parseColdSettings = (all: Record<string, unknown>, problems: string[]): ColdConfig => {
  const bad = (key: string, why: string): void => { problems.push(`${key} ${JSON.stringify(all[key])} ${why}, the default is used`); };
  const num = (key: string, fallback: number, ok: (v: number) => boolean): number => {
    if (all[key] === undefined) return fallback;
    const v = Number(all[key]);
    if (typeof all[key] === "number" && Number.isFinite(v) && ok(v)) return v;
    bad(key, "is out of range");
    return fallback;
  };
  const list = (key: string, fallback: number[], length: number, ok: (v: number[]) => boolean): number[] => {
    const v = all[key];
    if (v === undefined) return fallback.slice();
    if (Array.isArray(v) && v.length === length && v.every((x) => typeof x === "number" && Number.isFinite(x)) && ok(v as number[])) return (v as number[]).slice();
    bad(key, `is not ${length} numbers in order`);
    return fallback.slice();
  };
  const strings = (key: string, fallback: string[]): string[] => {
    const v = all[key];
    if (v === undefined) return fallback.slice();
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).map((x) => x.trim()).filter((x) => x);
    bad(key, "is not a list of strings");
    return fallback.slice();
  };
  // { key: number } merged key by key over the defaults; anyKey takes keys the defaults lack
  const numbers = <T extends object>(key: string, defaults: T, ok: (v: number) => boolean, anyKey = false): T => {
    const out = { ...defaults } as Record<string, number>;
    const v = all[key];
    if (v === undefined) return out as T;
    if (!isObject(v)) {
      bad(key, "is not an object");
      return out as T;
    }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "number" && Number.isFinite(x) && ok(x) && (anyKey || k in defaults)) out[k] = x;
      else problems.push(`${key}.${k} ${JSON.stringify(x)} is not usable, ignored`);
    }
    return out as T;
  };
  const classes = (key: string, defaults: Record<string, AreaClass>): Record<string, AreaClass> => {
    const out = { ...defaults };
    const v = all[key];
    if (v === undefined) return out;
    if (!isObject(v)) {
      bad(key, "is not an object");
      return out;
    }
    for (const [k, x] of Object.entries(v)) {
      if (CLIMATE_CLASSES.indexOf(x as AreaClass) !== -1) out[k] = x as AreaClass;
      else problems.push(`${key}.${k} ${JSON.stringify(x)} is not ${CLIMATE_CLASSES.join(", ")}, ignored`);
    }
    return out;
  };
  const ascending = (v: number[]): boolean => v.every((x, i) => x >= 0 && (i === 0 || x > v[i - 1]));
  const flag = (key: string, fallback: boolean): boolean => {
    if (all[key] === undefined) return fallback;
    if (typeof all[key] === "boolean") return all[key] as boolean;
    bad(key, "is not true or false");
    return fallback;
  };

  const stages = list("survivalColdStages", DEFAULTS.stages, 5, (v) => ascending(v) && v[4] < COLD_MAX);
  const { freezingZ, ...highRegions } = numbers("survivalHighAltitude", { freezingZ: DEFAULTS.freezingZ, fallForest: 15150 } as Record<string, number>, () => true, true);
  const warmthRaw = all["survivalWarmth"];
  const warmth: WarmthTable = { ...DEFAULT_WARMTH, normal: DEFAULT_WARMTH.normal.slice(), warm: DEFAULT_WARMTH.warm.slice(), cold: DEFAULT_WARMTH.cold.slice() };
  if (warmthRaw !== undefined && !isObject(warmthRaw)) bad("survivalWarmth", "is not an object");
  for (const [k, x] of Object.entries(isObject(warmthRaw) ? warmthRaw : {})) {
    const row = k === "normal" || k === "warm" || k === "cold";
    if (row && Array.isArray(x) && x.length === 4 && x.every((n) => typeof n === "number" && n >= 0)) warmth[k] = (x as number[]).slice();
    else if (!row && k in warmth && typeof x === "number" && x >= 0 && (k !== "maxReduction" || x <= 1) && (k !== "max" || x > 0)) (warmth as unknown as Record<string, number>)[k] = x;
    else problems.push(`survivalWarmth.${k} ${JSON.stringify(x)} is not usable, ignored`);
  }
  return {
    enabled: flag("survivalColdEnabled", DEFAULTS.enabled),
    hoursToNumb: num("survivalColdHoursToNumb", DEFAULTS.hoursToNumb, (v) => v > 0),
    levelMult: num("survivalColdLevelMult", DEFAULTS.levelMult, (v) => v >= 0),
    stages,
    start: num("survivalColdStart", DEFAULTS.start, (v) => v >= 0 && v < COLD_MAX),
    levels: numbers("survivalColdLevels", DEFAULT_COLD_LEVELS, (v) => v >= 0),
    caps: list("survivalColdLevelCaps", DEFAULTS.caps, 5, ascending),
    night: list("survivalNightHours", DEFAULTS.night, 2, (v) => v.every((h) => h >= 0 && h <= 24)),
    regionClimate: classes("survivalRegionClimate", DEFAULT_REGION_CLIMATE),
    worldClimate: classes("survivalWorldClimate", DEFAULT_WORLD_CLIMATE),
    freezingZ,
    highRegions,
    warmPerMinute: num("survivalColdWarmPerMinute", DEFAULTS.warmPerMinute, (v) => v >= 0),
    offlineWarmPerHour: num("survivalColdOfflineWarmPerHour", DEFAULTS.offlineWarmPerHour, (v) => v >= 0),
    heatRadius: num("survivalHeatRadius", DEFAULTS.heatRadius, (v) => v >= 0),
    heatRestore: num("survivalHeatRestore", DEFAULTS.heatRestore, (v) => v >= 0),
    heatCheckSeconds: num("survivalHeatCheckSeconds", DEFAULTS.heatCheckSeconds, (v) => v >= 1),
    heatStillUnits: num("survivalHeatStillUnits", DEFAULTS.heatStillUnits, (v) => v >= 0),
    heatExtraBases: strings("survivalHeatExtraBases", DEFAULTS.heatExtraBases),
    heatKeywords: strings("survivalHeatKeywords", DEFAULTS.heatKeywords),
    warmth,
    warmthTable: flag("survivalWarmthTable", DEFAULTS.warmthTable),
    hotFoodWarmth: num("survivalHotFoodWarmth", DEFAULTS.hotFoodWarmth, (v) => v >= 0),
    hotFoodMinutes: num("survivalHotFoodWarmthMinutes", DEFAULTS.hotFoodMinutes, (v) => v >= 0),
    spellHitCold: num("survivalSpellHitCold", DEFAULTS.spellHitCold, (v) => v >= 0),
    coldOnHit: numbers("survivalColdOnHit", DEFAULT_COLD_ON_HIT, (v) => v >= 0, true),
    kills: flag("survivalColdKills", DEFAULTS.kills),
    stageAbilities: flag("survivalColdStageAbilities", DEFAULTS.stageAbilities),
    healthPenalty: flag("survivalColdHealthPenalty", DEFAULTS.healthPenalty),
    maxHealthPenalty: num("survivalColdMaxHealthPenalty", DEFAULTS.maxHealthPenalty, (v) => v >= 0 && v <= 1),
    healthScale: flag("survivalColdHealthScale", DEFAULTS.healthScale),
    freezingWater: flag("survivalFreezingWater", DEFAULTS.freezingWater),
    freezingWaterWorlds: strings("survivalFreezingWaterWorlds", DEFAULTS.freezingWaterWorlds),
  };
};

// What the server knows of where a character stands
export interface Place {
  // Oblivion plane or afterlife realm (Survival_OblivionAreas)
  oblivion: boolean;
  // An interior cell, or a worldspace Survival_InteriorAreas lists
  interior: boolean;
  // Interior whose cell or location is on Survival's cold lists
  chilly: boolean;
  worldEdid: string;
  z: number;
  regionId: string | null;
}

// Survival_PlayerLocationInfo.GetCurrentAreaType order: interiors, then the world table, the height, the region and its height rule; anything else is cool
export const areaOf = (p: Place, cfg: ColdConfig): { area: AreaClass; why: string } => {
  if (p.oblivion) return { area: "none", why: `world ${p.worldEdid}` };
  if (p.interior) return p.chilly ? { area: "chillyInterior", why: "cold interior" } : { area: "interior", why: "interior" };
  const world = cfg.worldClimate[p.worldEdid];
  if (world) return { area: world, why: `world ${p.worldEdid}` };
  if (p.z >= cfg.freezingZ) return { area: "freezing", why: `height ${Math.round(p.z)}` };
  if (p.regionId) {
    const high = cfg.highRegions[p.regionId];
    if (high !== undefined && p.z >= high) return { area: "freezing", why: `region ${p.regionId} above ${high}` };
    const cls = cfg.regionClimate[p.regionId];
    if (cls) return { area: cls, why: `region ${p.regionId}` };
  }
  return { area: "cool", why: p.regionId ? `region ${p.regionId} unlisted` : "no region" };
};

// Water freezes in freezing areas, cold interiors and the listed worlds
export const isFreezingWater = (area: AreaClass, worldEdid: string, cfg: ColdConfig): boolean =>
  cfg.freezingWater && (area === "freezing" || area === "chillyInterior" || cfg.freezingWaterWorlds.indexOf(worldEdid) !== -1);

export const isNight = (hour: number, night: number[]): boolean =>
  night[0] > night[1] ? hour >= night[0] || hour < night[1] : hour >= night[0] && hour < night[1];

// Blizzard list first, then a snow classification that is not ash, then rain
export const weatherAddOf = (kind: string, blizzard: boolean, ash: boolean): WeatherAdd =>
  blizzard ? "blizzard" : kind === "snow" && !ash ? "snow" : kind === "rainy" ? "rain" : "";

// Survival_NeedCold.UpdateColdLevel: night and weather count outdoors only; freezing water replaces everything
export const coldLevelOf = (area: AreaClass, night: boolean, weather: WeatherAdd, freezingWater: boolean, levels: ColdLevels): { level: number; parts: string[] } => {
  if (freezingWater) return { level: levels.freezingWater, parts: ["freezing water"] };
  if (area === "none") return { level: 0, parts: ["no cold here"] };
  if (area === "interior") return { level: levels.warm, parts: ["interior"] };
  if (area === "chillyInterior") return { level: levels.chillyInterior, parts: ["cold interior"] };
  let level = levels[area];
  const parts: string[] = [area];
  if (night) {
    level += area === "warm" ? levels.warmNight : area === "cool" ? levels.coolNight : levels.freezingNight;
    parts.push("night");
  }
  if (weather && OUTDOOR.indexOf(area) !== -1) {
    level += levels[weather];
    parts.push(weather);
  }
  return { level, parts };
};

// Highest cold the level lets a character reach (GetColdStageMaximum and GetMaxStageValue)
export const coldCapOf = (level: number, cfg: Pick<ColdConfig, "caps" | "stages">): number => {
  const maxStage = cfg.caps.filter((c) => level >= c).length;
  return maxStage >= 5 ? COLD_MAX : cfg.stages[maxStage] - 1;
};

// Warm only with the bonus a warm-up to 0 gives, else Comfortable below the stage 2 value
export const coldStageOf = (cold: number, warmBonus: boolean, stages: number[]): number =>
  warmBonus ? 0 : 1 + stages.slice(1).filter((s) => cold >= s).length;

export const warmthReduction = (warmth: number, w: WarmthTable): number => w.maxReduction * clamp(warmth, 0, w.max) / w.max;

// Cold gained per real second at the level, lowered by warmth, times the race and other multipliers
export const coldRatePerSec = (level: number, warmth: number, mult: number, cfg: Pick<ColdConfig, "levelMult" | "hoursToNumb" | "warmth">): number =>
  cfg.levelMult * level / (cfg.hoursToNumb * 3600) * (1 - warmthReduction(warmth, cfg.warmth)) * Math.max(0, mult);

// One step: above the cap cold falls (not while fighting), below it rises up to the cap
export const stepCold = (cold: number, seconds: number, cap: number, ratePerSec: number, fallPerSec: number, fighting: boolean): number => {
  if (cold > cap) return fighting ? cold : Math.max(cap, cold - fallPerSec * seconds);
  return Math.min(cap, cold + ratePerSec * seconds);
};

// Compass thermometer (Survival_TemperatureLevel): 0 neutral, 1 near heat, 2 warming, 3 cooling, 4 cooling in a level that reaches Numb
export const temperatureLevelOf = (before: number, after: number, level: number, nearHeat: boolean, area: AreaClass, caps: number[]): number => {
  if (area === "none") return 0;
  if (nearHeat) return after > 0 ? 1 : 0;
  if (after < before) return 2;
  if (after > before) return level >= caps[4] ? 4 : 3;
  return 0;
};

// Biped slot bits of BOD2: 30 head, 31 hair, 32 body, 33 hands, 37 feet, 40 and 46 cloaks, 42 circlet
const SLOT = (n: number): number => 1 << (n - 30);
const HEAD = SLOT(30) | SLOT(31) | SLOT(42);
const CLOAK = SLOT(40) | SLOT(46);
// Slots the engine rates
export const RATED_SLOTS = HEAD | SLOT(32) | SLOT(33) | SLOT(37);

export interface WornArmor {
  slots: number;
  kind: "normal" | "warm" | "cold";
  // Survival_BodyAndHead: a hooded body piece warms the head too
  bodyAndHead: boolean;
  // armorWarmth.ts points of a piece on no rated slot (cloak, cape, collar, scarf, mask)
  extra?: number;
}

// Warmth of the worn pieces: body, head, hands and feet once each at the warmest piece, table points once for the back and once for the neck or face, a torch and a cloak add
export const gearWarmth = (worn: WornArmor[], torch: boolean, w: WarmthTable): number => {
  const best = [0, 0, 0, 0];
  const extra = [0, 0];
  let cloak = false;
  for (const a of worn) {
    const group = (a.slots & CLOAK) !== 0 ? 0 : 1;
    extra[group] = Math.max(extra[group], a.extra || 0);
    const row = w[a.kind];
    const body = (a.slots & SLOT(32)) !== 0;
    const covers = [body, (a.slots & HEAD) !== 0 || (body && a.bodyAndHead), (a.slots & SLOT(33)) !== 0, (a.slots & SLOT(37)) !== 0];
    covers.forEach((on, i) => { if (on) best[i] = Math.max(best[i], row[i]); });
    if (!body && (a.slots & CLOAK) !== 0) cloak = true;
  }
  return best.reduce((s, v) => s + v, 0) + extra[0] + extra[1] + (torch ? w.torch : 0) + (cloak ? w.cloak : 0);
};

// A heat source within radius on each axis
export const nearHeatPoint = (points: number[][] | undefined, pos: number[], radius: number): boolean =>
  !!points && points.some((p) => Math.abs(p[0] - pos[0]) <= radius && Math.abs(p[1] - pos[1]) <= radius && Math.abs(p[2] - pos[2]) <= radius);
