import { Settings } from "../settings";
import { System, Log, SystemContext, CREATION_FINISHED_EVENT, USER_MENU_QUIT_EVENT } from "./system";
import { NeedsModifierSource } from "./needsSystem";
import { resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { ActorValue, SpellType, actorRaceId, fieldData, raceAbilityResist, spellEffects, spellInfo, view } from "./espmMagic";
import { chainMpHook, hex, isCreationPending } from "./actorUtil";
import { parseStartingItems } from "./spawn";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Racial passives: the racialPassives server setting is the only place race numbers live. traits(actorId) resolves the character's
// race (the appearance race, cached per actor until its next assign, creation finish or accepted race menu) through the aliases to
// its entry; a character in creation, a race without an entry or racialPassives.enabled false get neutral traits. NeedsSystem reads the
// hunger and fatigue factors as a modifier source; the survival lane reads cold, warmth, freezing water and raw meat. baseBonus is the
// race's starting health, magicka and stamina above the common 50, from the winning RACE record. Resistances, stats, claws and powers
// stay in the plugin; the boot report prints one line per playable race with what the plugin and the settings give it.
//
// server-settings.json (all optional; a missing multiplier is 1, a missing warmth 0 and a missing flag false):
//   racialPassives.enabled   false makes every trait neutral, default true
//   racialPassives.aliases   { "<race editor id>": "<entry race editor id>" } over the built-in vampire and child race map
//   racialPassives.races     { "<race editor id>": { coldRateMult, warmth, freezingWaterImmune, hungerRateMult, fatigueCostMult,
//                            rawMeatSafe, startingItems } }
//   racialPassives.powers    { "<SPEL editor id>": { cooldownHours, consumeOnMiss, commandAnimal } }, read but not acted on yet

const SETTINGS_KEY = "racialPassives";
const MAGIC_ENTRIES_KEY = "damageMultConditionalFormulaSettings";
// Skyrim.esm playable races with their vampire forms
const RACES = [
  { edid: "ArgonianRace", id: 0x13740, vampire: 0x8883a },
  { edid: "BretonRace", id: 0x13741, vampire: 0x8883c },
  { edid: "DarkElfRace", id: 0x13742, vampire: 0x8883d },
  { edid: "HighElfRace", id: 0x13743, vampire: 0x88840 },
  { edid: "ImperialRace", id: 0x13744, vampire: 0x88844 },
  { edid: "KhajiitRace", id: 0x13745, vampire: 0x88845 },
  { edid: "NordRace", id: 0x13746, vampire: 0x88794 },
  { edid: "OrcRace", id: 0x13747, vampire: 0xa82b9 },
  { edid: "RedguardRace", id: 0x13748, vampire: 0x88846 },
  { edid: "WoodElfRace", id: 0x13749, vampire: 0x88884 },
];
const DEFAULT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(RACES.map((r) => [`${r.edid}Vampire`, r.edid])),
  ImperialRaceChild: "ImperialRace",
  NordRaceChild: "NordRace",
  RedguardRaceChild: "RedguardRace",
  BretonRaceChild: "BretonRace",
  BretonRaceChildVampire: "BretonRace",
};
// The Imperial has no racial ability of its own
const NO_ABILITY = new Set(["ImperialRace"]);
const ABILITY_PREFIX = "AldRacial_";
const SPEED_PREFIX = "AldRaceSpeed_";
const WARMTH_EFFECT = "survival_fortifywarmthconstant";
const PLAYER_NPC = 0x7;
// Starting health, magicka and stamina in RACE DATA, unarmed damage after them
const DATA_START_HEALTH = 36;
const DATA_UNARMED = 96;
// NPC_ ACBS offsets of magicka, stamina and health
const ACBS_MAGICKA = 4;
const ACBS_STAMINA = 6;
const ACBS_HEALTH = 20;
const COMMON_START = 50;
const MAX_CACHED_ACTORS = 4096;
const RESISTS: Array<[string, number]> = [
  ["fire", ActorValue.FireResist], ["frost", ActorValue.FrostResist], ["shock", ActorValue.ElectricResist],
  ["poison", ActorValue.PoisonResist], ["disease", ActorValue.DiseaseResist], ["magic", ActorValue.MagicResist],
];
const ENTRY_KEYS = new Set(["coldRateMult", "warmth", "freezingWaterImmune", "hungerRateMult", "fatigueCostMult", "rawMeatSafe", "startingItems"]);

export interface RaceEntry {
  coldRateMult: number;
  warmth: number;
  freezingWaterImmune: boolean;
  hungerRateMult: number;
  fatigueCostMult: number;
  rawMeatSafe: boolean;
  startingItems: { baseId: number; count: number }[];
}

export interface RacialPower {
  cooldownHours: number;
  consumeOnMiss: boolean;
  commandAnimal: Record<string, unknown> | null;
}

export interface RacialConfig {
  present: boolean;
  enabled: boolean;
  aliases: Record<string, string>;
  races: Map<string, RaceEntry>;
  powers: Map<string, RacialPower>;
}

export interface RacialTraits extends Omit<RaceEntry, "startingItems"> {
  // The character's race editor id, "" in creation or when unknown
  raceEdid: string;
  // The racialPassives.races entry in force, "" for none
  key: string;
}

export interface BaseBonus {
  health: number;
  magicka: number;
  stamina: number;
}

const NEUTRAL: RaceEntry = { coldRateMult: 1, warmth: 0, freezingWaterImmune: false, hungerRateMult: 1, fatigueCostMult: 1, rawMeatSafe: false, startingItems: [] };
const NO_BONUS: BaseBonus = { health: 0, magicka: 0, stamina: 0 };

const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const round = (v: number): number => Math.round(v * 1000) / 1000;

// The racialPassives block; problems names every value that was ignored
export const parseRacialPassives = (raw: unknown): { config: RacialConfig; problems: string[] } => {
  const problems: string[] = [];
  const block = objectOf(raw);
  const aliases = { ...DEFAULT_ALIASES };
  for (const [from, to] of Object.entries(objectOf(block.aliases))) {
    if (typeof to === "string" && to) aliases[from] = to; else problems.push(`aliases.${from} is not a race editor id`);
  }
  const races = new Map<string, RaceEntry>();
  for (const [edid, value] of Object.entries(objectOf(block.races))) {
    const v = objectOf(value);
    const mult = (key: string, allowZero: boolean): number => {
      if (v[key] === undefined) return 1;
      const n = Number(v[key]);
      if (Number.isFinite(n) && (allowZero ? n >= 0 : n > 0)) return n;
      problems.push(`races.${edid}.${key} ${JSON.stringify(v[key])} is not a ${allowZero ? "non-negative" : "positive"} number, 1 is used`);
      return 1;
    };
    const warmth = v.warmth === undefined ? 0 : Number(v.warmth);
    if (!Number.isFinite(warmth)) problems.push(`races.${edid}.warmth ${JSON.stringify(v.warmth)} is not a number, 0 is used`);
    const items = v.startingItems === undefined ? [] : parseStartingItems(v.startingItems);
    if (!items) problems.push(`races.${edid}.startingItems is not a list of { baseId, count }, none are given`);
    for (const key of Object.keys(v)) if (!ENTRY_KEYS.has(key)) problems.push(`races.${edid}.${key} is not a known key`);
    races.set(edid, {
      coldRateMult: mult("coldRateMult", true),
      warmth: Number.isFinite(warmth) ? warmth : 0,
      freezingWaterImmune: v.freezingWaterImmune === true,
      hungerRateMult: mult("hungerRateMult", false),
      fatigueCostMult: mult("fatigueCostMult", false),
      rawMeatSafe: v.rawMeatSafe === true,
      startingItems: items || [],
    });
  }
  const powers = new Map<string, RacialPower>();
  for (const [edid, value] of Object.entries(objectOf(block.powers))) {
    const v = objectOf(value);
    const hours = Number(v.cooldownHours);
    if (v.cooldownHours !== undefined && !(Number.isFinite(hours) && hours >= 0)) problems.push(`powers.${edid}.cooldownHours is not a non-negative number, 0 is used`);
    powers.set(edid, {
      cooldownHours: Number.isFinite(hours) && hours >= 0 ? hours : 0,
      consumeOnMiss: v.consumeOnMiss === true,
      commandAnimal: v.commandAnimal && typeof v.commandAnimal === "object" ? objectOf(v.commandAnimal) : null,
    });
  }
  return { config: { present: raw !== undefined && raw !== null, enabled: block.enabled !== false, aliases, races, powers }, problems };
};

// damageMultConditionalFormulaSettings entries with a magic multiplier and GetIsRace == 1 conditions on the target
export const magicDamageEntries = (raw: unknown): { key: string; mult: number; raceIds: number[] }[] =>
  Object.entries(objectOf(raw)).flatMap(([key, value]) => {
    const v = objectOf(value);
    const mult = Number(v.magicDamageMultiplier);
    if (v.magicDamageMultiplier === undefined || !Number.isFinite(mult)) return [];
    const raceIds = (Array.isArray(v.conditions) ? v.conditions : [])
      .map(objectOf)
      .filter((c) => c.function === "GetIsRace" && c.runsOn === "Target" && c.comparison === "==" && Number(c.value) === 1)
      .map((c) => {
        const p = String(c.parameter1 ?? "").trim();
        return (/^0x/i.test(p) ? parseInt(p.slice(2), 16) : parseInt(p, 10)) >>> 0;
      })
      .filter((id) => id);
    return raceIds.length ? [{ key, mult, raceIds }] : [];
  });

export class RacialSystem implements System, NeedsModifierSource {
  systemName = "RacialSystem";
  label = "race";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = (s.allSettings || {}) as Record<string, unknown>;
    this.mp = ctx.svr as Mp;
    const problems = this.configure(all[SETTINGS_KEY]);
    this.magicEntries = magicDamageEntries(all[MAGIC_ENTRIES_KEY]);
    const forget = (actorId: number) => this.raceCache.delete(actorId >>> 0);
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => forget(actorId));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => forget(actorId));
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => forget(actorId));
    // An accepted race menu may change the race; the native side has stored the new appearance before this fires
    chainMpHook(this.mp, "onUpdateAppearanceAttempt", (actorId: number, _appearance: unknown, isAllowed: boolean) => {
      if (isAllowed) forget(actorId);
    });
    await this.report(s.dataDir, s.loadOrder, problems);
  }

  // Reads the racialPassives block; returns the ignored values
  configure(raw: unknown): string[] {
    const { config, problems } = parseRacialPassives(raw);
    this.config = config;
    this.traitsByRace.clear();
    return problems;
  }

  traits(actorId: number): RacialTraits {
    const raceId = this.raceOf(actorId >>> 0);
    const hit = this.traitsByRace.get(raceId);
    if (hit) return hit;
    const raceEdid = raceId ? this.edidOf(raceId) : "";
    const key = this.keyOf(raceEdid);
    const e = (this.config.enabled && key ? this.config.races.get(key) : undefined) || NEUTRAL;
    const out: RacialTraits = {
      raceEdid, key: e === NEUTRAL ? "" : key, coldRateMult: e.coldRateMult, warmth: e.warmth, freezingWaterImmune: e.freezingWaterImmune,
      hungerRateMult: e.hungerRateMult, fatigueCostMult: e.fatigueCostMult, rawMeatSafe: e.rawMeatSafe,
    };
    this.traitsByRace.set(raceId, out);
    return out;
  }

  // The entry the race uses: its own, else the one its alias names
  entryOf(raceEdid: string): RaceEntry | undefined {
    return this.config.enabled ? this.config.races.get(this.keyOf(raceEdid)) : undefined;
  }

  // Starting health, magicka and stamina of the character's race above the common 50; zero in creation
  baseBonus(actorId: number): BaseBonus {
    const raceId = this.raceOf(actorId >>> 0);
    if (!raceId) return NO_BONUS;
    const start = this.startValues(raceId);
    return start ? { health: start[0] - COMMON_START, magicka: start[1] - COMMON_START, stamina: start[2] - COMMON_START } : NO_BONUS;
  }

  hungerDrainMult(actorId: number): number {
    return this.traits(actorId).hungerRateMult;
  }

  fatigueCostMult(actorId: number): number {
    return this.traits(actorId).fatigueCostMult;
  }

  describe(): string {
    if (!this.config.enabled) return "off, racialPassives.enabled is false";
    const list = (pick: (e: RaceEntry) => number): string =>
      Array.from(this.config.races).filter(([, e]) => pick(e) !== 1).map(([k, e]) => `${k} x${round(pick(e))}`).join(", ") || "none";
    return `hunger ${list((e) => e.hungerRateMult)}; fatigue ${list((e) => e.fatigueCostMult)}`;
  }

  // Race id of the actor, 0 while its creation is pending; cached until it is forgotten
  private raceOf(actorId: number): number {
    const hit = this.raceCache.get(actorId);
    if (hit !== undefined) return hit;
    const mp = this.mp;
    if (!mp || !actorId) return 0;
    const raceId = isCreationPending(mp, actorId) ? 0 : actorRaceId(mp, actorId);
    if (this.raceCache.size >= MAX_CACHED_ACTORS) this.raceCache.clear();
    this.raceCache.set(actorId, raceId);
    return raceId;
  }

  private edidOf(raceId: number): string {
    let edid = this.edidCache.get(raceId);
    if (edid === undefined) {
      edid = String(this.lookup(raceId)?.record?.editorId || "");
      this.edidCache.set(raceId, edid);
    }
    return edid;
  }

  private keyOf(raceEdid: string): string {
    if (!raceEdid || this.config.races.has(raceEdid)) return raceEdid;
    return this.config.aliases[raceEdid] || raceEdid;
  }

  // [health, magicka, stamina] starting values of the winning RACE record, null when unreadable
  private startValues(raceId: number): number[] | null {
    const data = fieldData(this.lookup(raceId), "DATA");
    if (!data || data.byteLength < DATA_START_HEALTH + 12) return null;
    const v = view(data);
    return [0, 4, 8].map((o) => v.getFloat32(DATA_START_HEALTH + o, true));
  }

  private lookup(id: number): any {
    try { return id && this.mp ? this.mp.lookupEspmRecordById(id >>> 0) : null; } catch { return null; }
  }

  // One line per playable race, the magic damage entries and every warning, so the numbers can be checked without playing
  private async report(dataDir: string, loadOrder: string[], problems: string[]): Promise<void> {
    const mp = this.mp;
    const warnings = problems.map((p) => `racialPassives.${p}`);
    const abilityNames = RACES.filter((r) => !NO_ABILITY.has(r.edid)).map((r) => ABILITY_PREFIX + r.edid.replace(/Race$/, ""));
    const spells = await resolveEditorIds(abilityNames, dataDir, loadOrder, this.log, ["SPEL"]);
    const knownRaces = new Set([...RACES.map((r) => r.edid), ...Object.keys(this.config.aliases)]);
    const otherKeys = Array.from(this.config.races.keys()).filter((k) => !knownRaces.has(k));
    if (otherKeys.length) {
      const scan = await resolveEditorIds(otherKeys, dataDir, loadOrder, this.log, ["RACE"]);
      for (const k of scan.unresolved) warnings.push(`racialPassives.races.${k} names no RACE in the load order`);
    }
    const playerAcbs = fieldData(this.lookup(PLAYER_NPC), "ACBS");
    const offsets = playerAcbs && playerAcbs.byteLength >= 24
      ? [ACBS_HEALTH, ACBS_MAGICKA, ACBS_STAMINA].map((o) => view(playerAcbs).getInt16(o, true))
      : [COMMON_START, COMMON_START, COMMON_START];
    const powers = Array.from(this.config.powers).map(([k, p]) => `${k} ${round(p.cooldownHours)} h`);
    this.log(`[racial] ready: ${!this.config.present ? "no racialPassives block, every race neutral" : `${this.config.enabled ? "on" : "off (enabled false), every race neutral"}, ${this.config.races.size} race entries (${Array.from(this.config.races.keys()).join(", ") || "none"}), ${Object.keys(this.config.aliases).length} aliases, powers ${powers.join(", ") || "none"} (read, not acted on yet)`}; Player NPC_ offsets H/M/S ${offsets.join("/")}`);
    this.log(`[racial] magic damage entries: ${this.magicEntries.map((e) => `${e.key} x${round(e.mult)} on ${e.raceIds.map((id) => this.edidOf(id) || hex(id)).join(", ")}`).join("; ") || "none"}`);
    const notInPlugin: string[] = [];
    for (const race of RACES) {
      try {
        this.log(`[racial] ${this.raceLine(mp, race, offsets, spells.resolved, notInPlugin, warnings)}`);
      } catch (e) {
        warnings.push(`${race.edid} could not be read: ${e}`);
      }
    }
    if (notInPlugin.length) this.log(`[racial] warning: ${notInPlugin.length} races have no AldRacial_* ability in the load order yet (${notInPlugin.join(", ")}); expected until plugin r27a`);
    for (const w of warnings) this.log(`[racial] warning: ${w}`);
  }

  private raceLine(mp: Mp, race: typeof RACES[number], offsets: number[], resolved: Map<string, string>, notInPlugin: string[], warnings: string[]): string {
    const rec = this.lookup(race.id);
    const data = fieldData(rec, "DATA");
    const start = this.startValues(race.id) || [0, 0, 0];
    const unarmed = data && data.byteLength >= DATA_UNARMED + 4 ? view(data).getFloat32(DATA_UNARMED, true) : 0;
    const splo = espmFieldFormIds(rec, "SPLO");
    const edidOfSpell = (id: number): string => String(this.lookup(id)?.record?.editorId || hex(id));
    const abilities = splo.filter((id) => spellInfo(mp, id).type === SpellType.Ability);
    const powers = splo.flatMap((id) => {
      const type = spellInfo(mp, id).type;
      return type === SpellType.Power || type === SpellType.LesserPower ? [`${edidOfSpell(id)} (${type === SpellType.Power ? "greater" : "lesser"})`] : [];
    });
    const resist = RESISTS.map(([label, av]) => [label, round(raceAbilityResist(mp, race.id, av))] as [string, number]).filter(([, v]) => v !== 0);
    const pluginWarmth = abilities.flatMap((id) => spellEffects(mp, id))
      .filter((e) => String(this.lookup(e.mgefId)?.record?.editorId || "").toLowerCase() === WARMTH_EFFECT)
      .reduce((sum, e) => sum + e.magnitude, 0);
    const entry = this.entryOf(race.edid);
    const t = entry || NEUTRAL;
    const magic = this.magicEntries.filter((e) => e.raceIds.includes(race.id));
    const magicResist = resist.find(([label]) => label === "magic")?.[1] || 0;
    if (magicResist > 0 && !magic.length) warnings.push(`${race.edid} abilities resist magic ${magicResist} but no ${MAGIC_ENTRIES_KEY} entry names it, so server spell damage is not reduced`);
    for (const e of magic) {
      if (!e.raceIds.includes(race.vampire)) warnings.push(`${MAGIC_ENTRIES_KEY}.${e.key} names ${race.edid} but not ${race.edid}Vampire`);
    }
    let ability = "";
    if (!NO_ABILITY.has(race.edid)) {
      const name = ABILITY_PREFIX + race.edid.replace(/Race$/, "");
      const onRace = abilities.some((id) => edidOfSpell(id) === name);
      if (onRace) {
        ability = `, ${name} on the race`;
        if (Math.abs(pluginWarmth - t.warmth) > 1e-6) warnings.push(`${race.edid} warmth ${t.warmth} in settings but ${round(pluginWarmth)} in the plugin's Survival_FortifyWarmthConstant`);
      } else if (resolved.has(name.toLowerCase())) {
        ability = `, ${name} in the plugin but NOT on the race`;
        warnings.push(`${name} is in the load order but ${race.edid} does not list it: a wrong or stale AlduinakAdditions.esp in the server Data folder`);
      } else {
        ability = `, ${name} not in plugin yet`;
        notInPlugin.push(race.edid);
      }
    }
    const items = t.startingItems.map((i) => `${i.count} ${i.baseId === 0xf ? "gold" : hex(i.baseId)}`).join(" + ") || "none";
    return `${race.edid}: resist ${resist.map(([l, v]) => `${l} ${v}`).join(", ") || "none"}, base H/M/S ${start.map((v, i) => round(v + offsets[i])).join("/")}` +
      `, cold x${round(t.coldRateMult)}${t.coldRateMult === 0 ? " (immune)" : ""}, freezing water ${t.freezingWaterImmune ? "immune" : "hurts"}` +
      `, fatigue x${round(t.fatigueCostMult)}, hunger x${round(t.hungerRateMult)}, warmth ${round(t.warmth)}${pluginWarmth ? ` (plugin ${round(pluginWarmth)})` : ""}` +
      `, raw meat ${t.rawMeatSafe ? "safe" : "unsafe"}, start items ${items}, claws ${round(unarmed)} (race unarmed)` +
      `, magic damage ${magic.map((e) => `x${round(e.mult)} (${e.key})`).join(" ") || "x1"}` +
      `, abilities ${abilities.map(edidOfSpell).join(" + ") || "-"}, powers ${powers.join(" + ") || "-"}${ability}${entry || !this.config.enabled || !this.config.present ? "" : ", no settings entry"}`;
  }

  private mp: Mp = null;
  private config: RacialConfig = parseRacialPassives(undefined).config;
  private magicEntries: { key: string; mult: number; raceIds: number[] }[] = [];
  // actorId -> race id, 0 while creation is pending
  private raceCache = new Map<number, number>();
  private edidCache = new Map<number, string>();
  private traitsByRace = new Map<number, RacialTraits>();
}
