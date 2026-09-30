// Survival diseases as pure rules and their default tables (survival.md 2.3): the 27 staged diseases of Skyrim, Survival Mode and
// Oblivion, the creatures that carry them with their chance per hit, and the contagious ones Oblivion's beggars spread; SurvivalSystem
// feeds them what the server knows of a character.

export const DISEASE_STAGES = 3;
export const STAGE_SUFFIX = ["", " (advanced)", " (severe)"];

// Server rules a disease adds per stage, beside its spell's effects
export type DiseaseFactor = "cold" | "hunger" | "food" | "rest";

export interface DiseaseDef {
  id: string;
  name: string;
  contagious: boolean;
  // What the stage spells do, for the notices
  effect: string;
  // Editor ids of the stage spells, stage 1 first
  spells: string[];
  // Real hours from stage 1 to 2 and from 2 to 3
  stageHours: number[];
  // Per stage: cold gain, hunger drain, a food's hunger restore, the fatigue refill
  factors: Partial<Record<DiseaseFactor, number[]>>;
}

export interface Carrier {
  chance: number;
  diseases: string[];
}

export interface ContagionConfig {
  chance: number;
  range: number;
  checkSeconds: number;
  cooldownMinutes: number;
}

export interface DiseaseConfig {
  enabled: boolean;
  diseases: Record<string, DiseaseDef>;
  carriers: Record<string, Carrier>;
  exclude: string[];
  stageHours: number[];
  max: number;
  contagion: ContagionConfig;
}

// A disease a character holds: stage 1 to 3, the epoch ms of the next stage (0 at stage 3), since when, what gave it and the stage spell's desc
export interface HeldDisease {
  id: string;
  stage: number;
  nextAt: number;
  since: number;
  from: string;
  spell: string;
}

export const FACTOR_NAMES: Record<DiseaseFactor, string> = { cold: "cold gain", hunger: "hunger drain", food: "food", rest: "fatigue refill" };

const WORSE = [1.25, 1.5, 1.75];
const SLOWER = [0.75, 0.5, 0.25];

// id, name, contagious (an Oblivion beggar carried it), effect for the notices, server factors
const CATALOG: Array<[string, string, boolean, string, Partial<Record<DiseaseFactor, number[]>>?]> = [
  ["ataxia", "Ataxia", true, "picking locks and pockets is harder"],
  ["boneBreakFever", "Bone Break Fever", true, "your maximum stamina is lower"],
  ["brainRot", "Brain Rot", true, "your maximum magicka is lower"],
  ["rattles", "Rattles", true, "your stamina recovers more slowly"],
  ["rockjoint", "Rockjoint", true, "your melee attacks are weaker"],
  ["witbane", "Witbane", false, "your magicka recovers more slowly"],
  ["droops", "Droops", false, "your melee attacks are weaker"],
  ["brownRot", "Brown Rot", true, "your armor skills suffer and your fatigue refills more slowly", { rest: SLOWER }],
  ["greenspore", "Greenspore", false, "your speech suffers and your stamina recovers more slowly"],
  ["gutworm", "Gutworm", false, "your stamina recovers more slowly and food fills you less", { food: SLOWER }],
  ["astralVapors", "Astral Vapors", false, "your magicka is lower and recovers more slowly"],
  ["blackHeartBlight", "Black-Heart Blight", true, "you carry less and your stamina is lower"],
  ["bloodLung", "Blood Lung", true, "your stamina recovers more slowly"],
  ["chanthraxBlight", "Chanthrax Blight", false, "you move slower and picking locks and pockets is harder"],
  ["chills", "Chills", true, "the cold bites harder and your magicka recovers more slowly", { cold: WORSE }],
  ["collywobbles", "Collywobbles", true, "you hunger faster and your stamina recovers more slowly", { hunger: WORSE }],
  ["dampworm", "Dampworm", false, "you move slower"],
  ["feebleLimb", "Feeble Limb", false, "you carry less and your melee attacks are weaker"],
  ["helljoint", "Helljoint", true, "you move slower and your stamina is lower"],
  ["redRage", "Red Rage", true, "your magicka recovers more slowly and you carry less"],
  ["rustChancre", "Rust Chancre", true, "your speech suffers and you move slower"],
  ["serpiginousDementia", "Serpiginous Dementia", true, "your magicka is lower and your speech suffers"],
  ["shakes", "Shakes", true, "picking locks and pockets is harder and your archery suffers"],
  ["swampFever", "Swamp Fever", true, "your stamina is lower and you carry less"],
  ["wither", "Wither", true, "your stamina is lower, you carry less and your melee attacks are weaker"],
  ["witlessPox", "Witless Pox", true, "your maximum magicka is lower"],
  ["yellowTick", "Yellow Tick", true, "you move slower and carry less"],
];

// Race editor id fragments, the chance a hit carries a disease and the diseases it may be
export const DEFAULT_CARRIERS: Record<string, Carrier> = {
  skeever: { chance: 0.1, diseases: ["ataxia", "bloodLung", "feebleLimb", "redRage", "shakes", "witlessPox"] },
  wolf: { chance: 0.1, diseases: ["rockjoint", "helljoint"] },
  fox: { chance: 0.1, diseases: ["rockjoint"] },
  bear: { chance: 0.1, diseases: ["boneBreakFever", "yellowTick"] },
  chaurus: { chance: 0.1, diseases: ["rattles"] },
  sabrecat: { chance: 0.1, diseases: ["witbane", "wither"] },
  dog: { chance: 0.1, diseases: ["witbane"] },
  hagraven: { chance: 0.1, diseases: ["brainRot"] },
  ashhopper: { chance: 0.1, diseases: ["droops"] },
  goat: { chance: 0.1, diseases: ["droops"] },
  boar: { chance: 0.1, diseases: ["chanthraxBlight"] },
  mudcrab: { chance: 0.1, diseases: ["dampworm", "swampFever"] },
  icewraith: { chance: 0.1, diseases: ["chills"] },
  draugr: { chance: 0.03, diseases: ["brownRot", "rustChancre"] },
  slaughterfish: { chance: 0.05, diseases: ["greenspore"] },
  troll: { chance: 0.06, diseases: ["gutworm"] },
  skeleton: { chance: 0.05, diseases: ["blackHeartBlight", "chills", "collywobbles", "serpiginousDementia"] },
  ashspawn: { chance: 0.05, diseases: ["blackHeartBlight"] },
  wisp: { chance: 0.05, diseases: ["astralVapors"] },
  dragonpriest: { chance: 0.05, diseases: ["astralVapors"] },
};

const DEFAULTS = {
  // DLC2WerebearBeastRace would match bear as WerewolfBeastRace matches wolf
  exclude: ["werewolf", "werebear"],
  stageHours: [84, 84],
  max: 4,
  contagion: { chance: 0.05, range: 300, checkSeconds: 60, cooldownMinutes: 30 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// AldDisease_Rockjoint1 for rockjoint at stage 1, as the patcher names them
export const diseaseSpellEdid = (id: string, stage: number): string => `AldDisease_${id.charAt(0).toUpperCase()}${id.slice(1)}${stage}`;

export const stageName = (name: string, stage: number): string => `${name}${STAGE_SUFFIX[clamp(stage, 1, DISEASE_STAGES) - 1]}`;

export const defaultDiseases = (stageHours: number[] = DEFAULTS.stageHours): Record<string, DiseaseDef> => {
  const out: Record<string, DiseaseDef> = {};
  for (const [id, name, contagious, effect, factors] of CATALOG) {
    out[id] = { id, name, contagious, effect, spells: [1, 2, 3].map((n) => diseaseSpellEdid(id, n)), stageHours: stageHours.slice(), factors: factors || {} };
  }
  return out;
};

// Reads the disease keys over the defaults; an unusable value keeps its default and is named in problems
export const parseDiseaseSettings = (all: Record<string, unknown>, problems: string[]): DiseaseConfig => {
  const bad = (key: string, why: string): void => { problems.push(`${key} ${JSON.stringify(all[key])} ${why}, the default is used`); };
  const num = (key: string, fallback: number, ok: (v: number) => boolean): number => {
    if (all[key] === undefined) return fallback;
    const v = all[key];
    if (typeof v === "number" && Number.isFinite(v) && ok(v)) return v;
    bad(key, "is out of range");
    return fallback;
  };
  const hoursOk = (v: unknown): v is number[] => Array.isArray(v) && v.length === DISEASE_STAGES - 1 && v.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  let enabled = true;
  if (all["survivalDiseasesEnabled"] !== undefined) {
    if (typeof all["survivalDiseasesEnabled"] === "boolean") enabled = all["survivalDiseasesEnabled"] as boolean;
    else bad("survivalDiseasesEnabled", "is not true or false");
  }
  let stageHours = DEFAULTS.stageHours.slice();
  if (all["survivalDiseaseStageHours"] !== undefined) {
    if (hoursOk(all["survivalDiseaseStageHours"])) stageHours = (all["survivalDiseaseStageHours"] as number[]).slice();
    else bad("survivalDiseaseStageHours", `is not ${DISEASE_STAGES - 1} hours above 0`);
  }
  const diseases = defaultDiseases(stageHours);
  const overrides = all["survivalDiseases"];
  if (overrides !== undefined && !isObject(overrides)) bad("survivalDiseases", "is not an object");
  for (const [id, v] of Object.entries(isObject(overrides) ? overrides : {})) {
    const def = diseases[id];
    if (!def) {
      problems.push(`survivalDiseases.${id} is no catalog disease, ignored`);
      continue;
    }
    if (v === false) {
      delete diseases[id];
      continue;
    }
    if (!isObject(v)) {
      problems.push(`survivalDiseases.${id} ${JSON.stringify(v)} is not an object or false, ignored`);
      continue;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === "name" && typeof x === "string" && x.trim()) def.name = x.trim();
      else if (k === "contagious" && typeof x === "boolean") def.contagious = x;
      else if (k === "stageHours" && hoursOk(x)) def.stageHours = x.slice();
      else problems.push(`survivalDiseases.${id}.${k} ${JSON.stringify(x)} is not usable, ignored`);
    }
  }
  const carriers: Record<string, Carrier> = {};
  for (const [k, c] of Object.entries(DEFAULT_CARRIERS)) carriers[k] = { chance: c.chance, diseases: c.diseases.slice() };
  const carrierRaw = all["survivalDiseaseCarriers"];
  if (carrierRaw !== undefined && !isObject(carrierRaw)) bad("survivalDiseaseCarriers", "is not an object");
  for (const [k, v] of Object.entries(isObject(carrierRaw) ? carrierRaw : {})) {
    const key = k.trim().toLowerCase();
    if (v === false) {
      delete carriers[key];
      continue;
    }
    const chance = isObject(v) ? v.chance : undefined;
    const list = isObject(v) ? v.diseases : undefined;
    if (!key || !isObject(v) || typeof chance !== "number" || !(chance >= 0 && chance <= 1) || !Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      problems.push(`survivalDiseaseCarriers.${k} ${JSON.stringify(v)} is not { chance 0 to 1, diseases [ids] } or false, ignored`);
      continue;
    }
    const unknown = (list as string[]).filter((id) => !diseases[id]);
    if (unknown.length) problems.push(`survivalDiseaseCarriers.${k} names ${unknown.join(", ")}, no disease in force, left out`);
    carriers[key] = { chance, diseases: (list as string[]).filter((id) => diseases[id]) };
  }
  for (const c of Object.values(carriers)) c.diseases = c.diseases.filter((id) => diseases[id]);
  let exclude = DEFAULTS.exclude.slice();
  const ex = all["survivalDiseaseCarrierExclude"];
  if (ex !== undefined) {
    if (Array.isArray(ex) && ex.every((x) => typeof x === "string")) exclude = (ex as string[]).map((x) => x.trim().toLowerCase()).filter((x) => x);
    else bad("survivalDiseaseCarrierExclude", "is not a list of strings");
  }
  const c = DEFAULTS.contagion;
  return {
    enabled,
    diseases,
    carriers,
    exclude,
    stageHours,
    max: num("survivalMaxDiseases", DEFAULTS.max, (v) => Number.isInteger(v) && v >= 1),
    contagion: {
      chance: num("survivalContagionChance", c.chance, (v) => v >= 0 && v <= 1),
      range: num("survivalContagionRange", c.range, (v) => v > 0),
      checkSeconds: num("survivalContagionCheckSeconds", c.checkSeconds, (v) => v >= 1),
      cooldownMinutes: num("survivalContagionCooldownMinutes", c.cooldownMinutes, (v) => v >= 0),
    },
  };
};

// The carrier fragment a race editor id matches, longest first, "" for none or an excluded race
export const carrierOf = (raceEdid: string, carriers: Record<string, Carrier>, exclude: string[]): string => {
  const edid = raceEdid.toLowerCase();
  if (!edid || exclude.some((x) => edid.includes(x))) return "";
  return Object.keys(carriers).sort((a, b) => b.length - a.length).find((k) => edid.includes(k)) || "";
};

// One of the candidates the character does not hold, chosen by roll in [0, 1); "" when none is left
export const pickDisease = (candidates: string[], held: string[], roll: number): string => {
  const left = candidates.filter((id) => held.indexOf(id) === -1);
  return left.length ? left[Math.min(left.length - 1, Math.floor(roll * left.length))] : "";
};

export const resistedChance = (chance: number, resist: number): number => clamp(chance * (1 - resist / 100), 0, 1);

// The stage and next stage time once every stage due by now has come, offline time included; stage 3 stays
export const stageAt = (stage: number, nextAt: number, now: number, stageHours: number[]): { stage: number; nextAt: number } => {
  let s = clamp(Math.round(stage), 1, DISEASE_STAGES);
  let next = s < DISEASE_STAGES ? nextAt : 0;
  while (s < DISEASE_STAGES && next > 0 && now >= next) {
    s++;
    next = s < DISEASE_STAGES ? next + stageHours[s - 1] * 3600000 : 0;
  }
  return { stage: s, nextAt: next };
};

// When a disease caught or set at this stage now reaches the next one, 0 at stage 3
export const nextStageAt = (stage: number, now: number, stageHours: number[]): number => stage < DISEASE_STAGES ? now + stageHours[stage - 1] * 3600000 : 0;

// Product of the factor over the diseases held, each at its stage
export const diseaseFactor = (defs: Record<string, DiseaseDef>, held: Array<{ id: string; stage: number }>, kind: DiseaseFactor): number => {
  let mult = 1;
  for (const d of held) {
    const f = defs[d.id]?.factors[kind];
    if (f) mult *= f[clamp(d.stage, 1, DISEASE_STAGES) - 1] ?? 1;
  }
  return mult;
};

// "Chills cold gain x1.25/1.5/1.75, ..." for the boot lines
export const factorLine = (defs: Record<string, DiseaseDef>): string =>
  Object.values(defs).flatMap((d) => (Object.keys(d.factors) as DiseaseFactor[]).map((k) => `${d.name} ${FACTOR_NAMES[k]} x${(d.factors[k] || []).join("/")}`)).join(", ");
