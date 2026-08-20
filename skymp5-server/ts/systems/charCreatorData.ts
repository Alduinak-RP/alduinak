// Server-side mirror of skymp5-front/src/features/charCreator/data/races.js.
// Slugs and form ids MUST stay in sync with that file; change them together.

const NORD = 0x13746;
const IMPERIAL = 0x13744;
const REDGUARD = 0x13748;
const BRETON = 0x13741;
const HIGHELF = 0x13743;
const DARKELF = 0x13742;
const WOODELF = 0x13749;
const ORC = 0x13747;
const KHAJIIT = 0x13745;
const ARGONIAN = 0x13740;
const DREMORA = 0x131f0;
const FALMER = 0x131f4;
const GIANT = 0x131f9;
const RIEKLING = 0x04017f44;

const NORD_CHILD = 0x2c65b;
const IMPERIAL_CHILD = 0x2c659;
const REDGUARD_CHILD = 0x2c658;
const BRETON_CHILD = 0x2c65c;

export interface RaceEntry {
  speciesId: string;
  raceId: number;
  childRaceId?: number;
  faceGen: boolean;
}

export const RACES: Record<string, RaceEntry> = {
  nord: { speciesId: "human", raceId: NORD, childRaceId: NORD_CHILD, faceGen: true },
  nibenese: { speciesId: "human", raceId: IMPERIAL, childRaceId: IMPERIAL_CHILD, faceGen: true },
  colovian: { speciesId: "human", raceId: IMPERIAL, childRaceId: IMPERIAL_CHILD, faceGen: true },
  redguard: { speciesId: "human", raceId: REDGUARD, childRaceId: REDGUARD_CHILD, faceGen: true },
  breton: { speciesId: "human", raceId: BRETON, childRaceId: BRETON_CHILD, faceGen: true },
  reachfolk: { speciesId: "human", raceId: BRETON, childRaceId: BRETON_CHILD, faceGen: true },
  akaviri: { speciesId: "human", raceId: IMPERIAL, childRaceId: IMPERIAL_CHILD, faceGen: true },
  giant: { speciesId: "human", raceId: GIANT, faceGen: false },
  altmer: { speciesId: "mer", raceId: HIGHELF, faceGen: true },
  dunmer: { speciesId: "mer", raceId: DARKELF, faceGen: true },
  bosmer: { speciesId: "mer", raceId: WOODELF, faceGen: true },
  orsimer: { speciesId: "mer", raceId: ORC, faceGen: true },
  maormer: { speciesId: "mer", raceId: HIGHELF, faceGen: true },
  falmer: { speciesId: "mer", raceId: FALMER, faceGen: false },
  dremora: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  aureal: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  mazken: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  xivkyn: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  xivilai: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  huntsman: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  shrike: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  auroran: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  heme: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  skaafin: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  spiderkith: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  havocrel: { speciesId: "daedra", raceId: DREMORA, faceGen: true },
  cathay: { speciesId: "khajiit", raceId: KHAJIIT, faceGen: true },
  suthay: { speciesId: "khajiit", raceId: KHAJIIT, faceGen: true },
  tojay: { speciesId: "khajiit", raceId: KHAJIIT, faceGen: true },
  pahmar: { speciesId: "khajiit", raceId: KHAJIIT, faceGen: true },
  senche: { speciesId: "khajiit", raceId: KHAJIIT, faceGen: true },
  alfiq: { speciesId: "khajiit", raceId: KHAJIIT, faceGen: true },
  saxhleel: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  agaceph: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  hapsleet: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  mihuitleel: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  naga: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  nakadesh: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  paatru: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  sarpa: { speciesId: "argonian", raceId: ARGONIAN, faceGen: true },
  goblin: { speciesId: "other", raceId: RIEKLING, faceGen: false },
  riekling: { speciesId: "other", raceId: RIEKLING, faceGen: false },
};

export const AGE_IDS = ["child", "adolescent", "adult", "midlife", "elder"];

export function raceIdFor(entry: RaceEntry, age: string): number {
  if (age === "child" && entry.childRaceId) return entry.childRaceId;
  return entry.raceId;
}

export interface CharCreatorConfig {
  allowChildren: boolean;
  disabledRaces: string[];
  statPool: number;
}

const ATTRIBUTE_KEYS = [
  "strength", "endurance", "agility", "speed",
  "intelligence", "willpower", "personality", "luck",
];
const STAT_MIN = 10;
const STAT_MAX = 100;
const STAT_START = 40;

const MAX_HEADPARTS = 16;
const MAX_TINTS = 40;
const MAX_TINT_TYPE = 20;
const MAX_TEXTURE_PATH = 128;
const MORPH_COUNT = 19;
const PRESET_COUNT = 4;
const NAME_MIN = 2;
const NAME_MAX = 30;
const MAX_BACKSTORY = 4000;
const MAX_DESCRIPTION = 1000;

// At least one real letter; apostrophes, spaces, and hyphens alone are not a name
const NAME_RE = /^(?=.*\p{L})[\p{L}' -]+$/u;
const MAX_RAW_NAME = 256;

const stripControl = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

// Multi-line text keeps tabs and newlines
const stripControlKeepBreaks = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

const isUint32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

const isIntIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// Colors arrive as signed or unsigned 32-bit ints depending on how the front packed them
const toInt32 = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < -0x80000000 || v > 0xffffffff) return null;
  return v | 0;
};

export interface CleanTint { texturePath: string; argb: number; type: number }

export interface CleanAppearance {
  isFemale: boolean;
  raceId: number;
  weight: number;
  skinColor: number;
  hairColor: number;
  headpartIds: number[];
  headTextureSetId: number;
  options: number[];
  presets: number[];
  tints: CleanTint[];
  name: string;
}

export interface CleanResult {
  species: string;
  race: string;
  sex: string;
  age: string;
  stats: Record<string, number>;
  bodyExtras: { muscle: number; fat: number };
  name: string;
  backstory: string;
  description: string;
  appearance: CleanAppearance;
}

export type ValidateOutcome = { ok: true; clean: CleanResult } | { ok: false; error: string };

const fail = (error: string): ValidateOutcome => ({ ok: false, error });

export function validateResult(data: unknown, config: CharCreatorConfig): ValidateOutcome {
  if (!data || typeof data !== "object") return fail("Malformed result");
  const d = data as Record<string, unknown>;

  const race = typeof d.race === "string" ? d.race : "";
  const entry = RACES[race];
  if (!entry) return fail("Unknown race");
  if (config.disabledRaces.includes(race)) return fail("This race is disabled on this server");

  const age = typeof d.age === "string" ? d.age : "";
  if (!AGE_IDS.includes(age)) return fail("Invalid age");
  if (age === "child" && !config.allowChildren) return fail("Child characters are not allowed on this server");

  const sex = d.sex;
  if (sex !== "male" && sex !== "female") return fail("Invalid sex");

  const app = d.appearance;
  if (!app || typeof app !== "object") return fail("Missing appearance");
  const a = app as Record<string, unknown>;

  if (a.raceId !== raceIdFor(entry, age)) return fail("Appearance race does not match the chosen race");
  if (a.isFemale !== (sex === "female")) return fail("Appearance sex does not match the chosen sex");

  const weight = a.weight;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 100) {
    return fail("Invalid weight");
  }

  const options = a.options;
  if (!Array.isArray(options) || options.length !== MORPH_COUNT ||
    !options.every(v => typeof v === "number" && Number.isFinite(v) && v >= -1 && v <= 1)) {
    return fail("Invalid face morphs");
  }

  const presets = a.presets;
  if (!Array.isArray(presets) || presets.length !== PRESET_COUNT ||
    !presets.every(v => isIntIn(v, 0, 255))) {
    return fail("Invalid face presets");
  }

  const headpartIds = a.headpartIds;
  if (!Array.isArray(headpartIds) || headpartIds.length > MAX_HEADPARTS ||
    !headpartIds.every(isUint32)) {
    return fail("Invalid headparts");
  }

  if (!isUint32(a.headTextureSetId)) return fail("Invalid head texture set");

  const tints = a.tints;
  if (!Array.isArray(tints) || tints.length > MAX_TINTS) return fail("Invalid tints");
  const cleanTints: CleanTint[] = [];
  for (const t of tints) {
    if (!t || typeof t !== "object") return fail("Invalid tint entry");
    const tt = t as Record<string, unknown>;
    if (typeof tt.texturePath !== "string" || tt.texturePath.length > MAX_TEXTURE_PATH) {
      return fail("Invalid tint texture path");
    }
    const argb = toInt32(tt.argb);
    if (argb === null) return fail("Invalid tint color");
    if (!isIntIn(tt.type, 0, MAX_TINT_TYPE)) return fail("Invalid tint type");
    cleanTints.push({ texturePath: stripControl(tt.texturePath), argb, type: tt.type });
  }

  if (!entry.faceGen && (headpartIds.length > 0 || cleanTints.length > 0)) {
    return fail("This race does not support face customization");
  }

  const skinColor = toInt32(a.skinColor) ?? 0;
  const hairColor = toInt32(a.hairColor) ?? 0;

  const rawName = typeof d.name === "string" ? d.name : "";
  if (rawName.length > MAX_RAW_NAME) {
    return fail("Names are 2-30 characters: letters, spaces, apostrophes, and hyphens");
  }
  const name = stripControl(rawName).trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) {
    return fail("Names are 2-30 characters: letters, spaces, apostrophes, and hyphens");
  }

  const rawBackstory = typeof d.backstory === "string" ? d.backstory : "";
  if (rawBackstory.length > MAX_BACKSTORY) return fail("Backstory is too long");
  const rawDescription = typeof d.description === "string" ? d.description : "";
  if (rawDescription.length > MAX_DESCRIPTION) return fail("Description is too long");
  const backstory = stripControlKeepBreaks(rawBackstory).trim();
  const description = stripControlKeepBreaks(rawDescription).trim();

  const rawStats = d.stats;
  if (!rawStats || typeof rawStats !== "object" || Array.isArray(rawStats)) {
    return fail("Invalid stats");
  }
  const statsObj = rawStats as Record<string, unknown>;
  const statKeys = Object.keys(statsObj);
  if (statKeys.length !== ATTRIBUTE_KEYS.length || !ATTRIBUTE_KEYS.every(k => statKeys.includes(k))) {
    return fail("Invalid stats");
  }
  const stats: Record<string, number> = {};
  let spent = 0;
  for (const k of ATTRIBUTE_KEYS) {
    const v = statsObj[k];
    if (!isIntIn(v, STAT_MIN, STAT_MAX)) return fail("Invalid stats");
    stats[k] = v;
    spent += v - STAT_START;
  }
  if (spent > config.statPool) return fail("Too many stat points spent");

  const rawExtras = d.bodyExtras;
  if (!rawExtras || typeof rawExtras !== "object") return fail("Invalid body sliders");
  const extras = rawExtras as Record<string, unknown>;
  const muscle = extras.muscle;
  const fat = extras.fat;
  if (!isIntIn(muscle, 0, 100) || !isIntIn(fat, 0, 100)) return fail("Invalid body sliders");

  const appearance: CleanAppearance = {
    isFemale: sex === "female",
    raceId: raceIdFor(entry, age),
    weight,
    skinColor,
    hairColor,
    headpartIds: headpartIds.map(v => v as number),
    headTextureSetId: a.headTextureSetId as number,
    options: options.map(v => v as number),
    presets: presets.map(v => v as number),
    tints: cleanTints,
    name,
  };

  return {
    ok: true,
    clean: {
      species: entry.speciesId,
      race,
      sex,
      age,
      stats,
      bodyExtras: { muscle, fat },
      name,
      backstory,
      description,
      appearance,
    },
  };
}
