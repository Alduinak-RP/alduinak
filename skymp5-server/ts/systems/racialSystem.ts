import { Settings } from "../settings";
import { System, Log, SystemContext, Content, CREATION_FINISHED_EVENT, USER_MENU_QUIT_EVENT } from "./system";
import { NeedsModifierSource } from "./needsSystem";
import { resolveEditorIds } from "./espmEditorIds";
import { espmFieldFormIds, toFormId } from "./formIdUtil";
import { ActorValue, SpellType, actorRaceId, fieldData, raceAbilityResist, spellEffects, spellInfo, view } from "./espmMagic";
import { GOLD_BASE_ID, addGold, addItemTo, chainMpHook, cleanDisplayName, formatWait, hex, isCreationPending, isPlayerActor, userOf } from "./actorUtil";
import { claimStarterGrant, parseStartingItems } from "./spawn";
import { sendJson } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Racial passives: the racialPassives server setting is the only place race numbers live. traits(actorId) resolves the character's
// race (the appearance race, cached per actor until its next assign, creation finish or accepted race menu) through the aliases to
// its entry; a character in creation, a race without an entry or racialPassives.enabled false get neutral traits. NeedsSystem reads the
// hunger and fatigue factors as a modifier source; the survival lane reads cold, warmth, freezing water and raw meat. baseBonus is the
// race's starting health, magicka and stamina above the common 50, from the winning RACE record. Resistances, stats, claws and powers
// stay in the plugin; the boot report prints one line per playable race with what the plugin and the settings give it.
// A race's startingItems are given once when its character's creation finishes, on top of the kit, once per profile and slot through
// starter-grants.json ("<profileId>:<slot>:race"), and recorded in private.racial.startItems; private.starterGold is never set, so the
// profession kit's gold rule is unchanged. A character created since startItemsSince that never got them gets them at its next login.
// Self-check (racialPassives.selfCheck, off by default): the client reports its race abilities after each race check; the server
// compares the report with the appearance race, that race's spell list without the withheld greater powers and the base values (RACE
// start plus the Player NPC_ offsets, magicka as MasterySystem last sent it), logs "check ok" or "MISMATCH" and, with "resync", sends
// one racialResync per spawn when the race sync can fix what differs (a wrong race, a missing, unheld or stopped spell, another race's
// spell); an extra spell or a base value means another plugin on the client, which only the log can show. A character a GM polymorph
// holds (private.polymorph) is neither checked nor cached, so its traits follow the race it wears.
// Base values: the createActor of a character in creation carries the Player NPC_ race's health, magicka and stamina, so once its race
// menu is accepted the client gets the new race's base health and stamina (racialBase); magicka stays MasterySystem's.
//
// Client -> Server: { customPacketType: "racialReport", reason, baseRace, engineRace, spells: [{ id, held, state }], stray: [id],
//                     base: { health, magicka, stamina }, masteryMagicka }
//   reason: what ran the check (spawn, load, resurrect, race menu, resync); baseRace, engineRace: ActorBase.getRace() and
//   Actor.getRace() form ids; spells: the base race's spell list as the client's plugin has it, state "on", "off" or "power";
//   stray: other races' spells running or held; base: base Health, Magicka and Stamina; masteryMagicka: the base Magicka the
//   client's MasteryService last wrote, null when it wrote none
// Server -> Client: { customPacketType: "racialResync", raceId, spells, problems }  spells: the race spells the server expects held
//                   { customPacketType: "racialBase", raceId, health, stamina }  after an accepted race menu or a finished creation
// Power gate: a player's cast of a power in racialPassives.powers is refused with a notice while its cooldown runs; the cooldown is
// wall-clock time from the last use, so it counts offline, across relogs, deaths and restarts. A power with an effect block
// (commandAnimal) is refused until that effect is built; a used one is stamped only when its effect worked, or on a miss with
// consumeOnMiss; a power with no effect block is stamped at every cast. NPC casters are never gated.
// Server -> Client: { customPacketType: "racialState", powers: [{ spellId, name, readyInMs, available }] }  the character's rationed
//   powers (its race's, or any it used), never sent without one; at login, after each racialReport, use and refusal; readyInMs is
//   relative, so the PC clock does not matter; available false while the power's effect is not built
//
// server-settings.json (all optional; a missing multiplier is 1, a missing warmth 0 and a missing flag false):
//   racialPassives.enabled          false makes every trait neutral, grants nothing and refuses no power, default true
//   racialPassives.aliases          { "<race editor id>": "<entry race editor id>" } over the built-in vampire and child race map
//   racialPassives.races            { "<race editor id>": { coldRateMult, warmth, freezingWaterImmune, hungerRateMult, fatigueCostMult,
//                                   rawMeatSafe, startingItems } }
//   racialPassives.powers           { "<SPEL editor id>": { cooldownHours, consumeOnMiss, commandAnimal } }; cooldownHours default 0 (none),
//                                   consumeOnMiss default false, commandAnimal the Command Animal effect's block
//   racialPassives.startItemsSince  epoch ms or a date string; characters created since then are backfilled, default the 1.0 launch
//   racialPassives.selfCheck        "off" (default: reports are not compared), "log" (compared and logged) or "resync" (also resynced)
//
// Persistence: private.racial = { v, powers, startItems?: { race, items, at, via, slot, note? } } on the character's actor form.

const SETTINGS_KEY = "racialPassives";
const MAGIC_ENTRIES_KEY = "damageMultConditionalFormulaSettings";
const RACIAL_PROP = "private.racial";
// The 1.0 launch, 2026-10-01 16:00 on the server box (UTC-7)
const DEFAULT_START_ITEMS_SINCE = Date.parse("2026-10-01T16:00:00-07:00");
// Where a character's creation time can be read: the intro's start location, the character creator, the kit's gold
const CREATED_AT_PROPS: Array<[string, string]> = [["private.startLocation", "at"], ["private.rp", "createdAt"], ["private.starterGold", "at"]];
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
const REPORT_PACKET = "racialReport";
const RESYNC_PACKET = "racialResync";
const BASE_PACKET = "racialBase";
const SELF_CHECK_MODES = ["off", "log", "resync"];
// Main's polymorph.ts record, set while a GM transform holds the character in another race
const POLYMORPH_PROP = "private.polymorph";
// A report this soon after the character's last one is dropped
const REPORT_MIN_GAP_MS = 2000;
const MAX_REPORT_SPELLS = 64;
// A base value this close to the expected one matches
const BASE_TOLERANCE = 0.5;
const BASE_LABELS = ["H", "M", "S"];
const STATE_PACKET = "racialState";
const NOTICE_PACKET = "masteryNotice";
const POWER_KEYS = new Set(["cooldownHours", "consumeOnMiss", "commandAnimal"]);
// Settings keys that hold a power's effect block
const POWER_EFFECT_KEYS = ["commandAnimal"];
const HOUR_MS = 3600000;
// A refused power is noticed and logged at most this often per character
const REFUSAL_GAP_MS = 3000;
const POWER_PREFIX = "AldPower";

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
  // The effect block's settings key, "" for a power that is only rationed
  effect: string;
}

// A rationed power resolved in the load order
export interface PowerEntry {
  edid: string;
  spellId: number;
  // The private.racial.powers key
  desc: string;
  name: string;
  power: RacialPower;
}

// Runs a power's effect after a cast; true when it worked
type PowerEffect = (casterId: number, entry: PowerEntry) => boolean;

export interface RacialConfig {
  present: boolean;
  enabled: boolean;
  aliases: Record<string, string>;
  races: Map<string, RaceEntry>;
  powers: Map<string, RacialPower>;
  startItemsSince: number;
  selfCheck: string;
}

interface StartItemsRecord {
  race: string;
  items: { baseId: number; count: number }[];
  at: number;
  via: "creation" | "login";
  slot: number;
  // Why nothing was given
  note?: string;
}

interface RacialRecord {
  v: number;
  // Spell desc -> epoch ms of the last use
  powers: Record<string, number>;
  startItems?: StartItemsRecord;
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

interface ReportedSpell {
  // null when the client did not say
  held: boolean | null;
  state: string;
}

interface CheckState {
  at: number;
  resynced: boolean;
}

const reportedList = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw.slice(0, MAX_REPORT_SPELLS) : []);

const reportedSpells = (raw: unknown): Map<number, ReportedSpell> => {
  const out = new Map<number, ReportedSpell>();
  for (const item of reportedList(raw)) {
    const v = objectOf(item);
    const id = toFormId(v.id);
    if (id) out.set(id, { held: typeof v.held === "boolean" ? v.held : null, state: typeof v.state === "string" ? v.state : "" });
  }
  return out;
};

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
    for (const key of Object.keys(v)) if (!POWER_KEYS.has(key)) problems.push(`powers.${edid}.${key} is not a known key`);
    for (const key of POWER_EFFECT_KEYS) {
      if (v[key] !== undefined && !(v[key] && typeof v[key] === "object" && !Array.isArray(v[key]))) problems.push(`powers.${edid}.${key} is not an object, the power has no effect`);
    }
    const commandAnimal = v.commandAnimal && typeof v.commandAnimal === "object" && !Array.isArray(v.commandAnimal) ? objectOf(v.commandAnimal) : null;
    powers.set(edid, {
      cooldownHours: Number.isFinite(hours) && hours >= 0 ? hours : 0,
      consumeOnMiss: v.consumeOnMiss === true,
      commandAnimal,
      effect: commandAnimal ? "commandAnimal" : "",
    });
  }
  let startItemsSince = DEFAULT_START_ITEMS_SINCE;
  if (block.startItemsSince !== undefined) {
    const since = typeof block.startItemsSince === "number" ? block.startItemsSince : Date.parse(String(block.startItemsSince));
    if (Number.isFinite(since)) startItemsSince = since;
    else problems.push(`startItemsSince ${JSON.stringify(block.startItemsSince)} is not a time, the 1.0 launch is used`);
  }
  let selfCheck = "off";
  if (block.selfCheck !== undefined) {
    if (SELF_CHECK_MODES.indexOf(String(block.selfCheck)) !== -1) selfCheck = String(block.selfCheck);
    else problems.push(`selfCheck ${JSON.stringify(block.selfCheck)} is not ${SELF_CHECK_MODES.join(", ")}, off is used`);
  }
  return { config: { present: raw !== undefined && raw !== null, enabled: block.enabled !== false, aliases, races, powers, startItemsSince, selfCheck }, problems };
};

// Earliest creation time the character carries, 0 when none is known
const createdAtOf = (mp: Mp, actorId: number): number => {
  const times = CREATED_AT_PROPS.map(([prop, field]) => {
    try { return Number(mp.get(actorId, prop)?.[field]); } catch { return NaN; }
  }).filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? Math.min(...times) : 0;
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

  // The base Magicka MasterySystem writes on the client, null when it writes none; unset, a client's reported mastery write is not checked
  writtenMagicka: ((actorId: number) => number | null) | null = null;

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = (s.allSettings || {}) as Record<string, unknown>;
    this.mp = ctx.svr as Mp;
    const problems = this.configure(all[SETTINGS_KEY]);
    this.magicEntries = magicDamageEntries(all[MAGIC_ENTRIES_KEY]);
    const forget = (actorId: number) => this.forget(actorId >>> 0);
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      forget(actorId);
      this.backfillStartItems(actorId >>> 0);
      this.sendPowerState(actorId >>> 0);
    });
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => forget(actorId));
    // Emitted inside the appearance hook, after the kit trim; the items follow once it returns
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => {
      forget(actorId);
      this.queueBase(actorId >>> 0, "creation");
      setImmediate(() => this.grantStartItems(actorId >>> 0, "creation"));
    });
    // An accepted race menu may change the race; the native side has stored the new appearance before this fires
    chainMpHook(this.mp, "onUpdateAppearanceAttempt", (actorId: number, _appearance: unknown, isAllowed: boolean) => {
      if (!isAllowed) return;
      forget(actorId);
      this.queueBase(actorId >>> 0, "race menu");
    });
    // A power is refused inside the native cast; its use is stamped once the native call returns
    chainMpHook(this.mp, "onSpellCastAttempt", (casterId: number, spellId: number) => this.powerAttempt(casterId >>> 0, spellId >>> 0));
    chainMpHook(this.mp, "onSpellCast", (casterId: number, spellId: number) => {
      setImmediate(() => this.powerCast(casterId >>> 0, spellId >>> 0));
    });
    await this.report(s.dataDir, s.loadOrder, problems);
  }

  // A new spawn or a possible race change: the cached race and the spawn's self-check start over
  private forget(actorId: number): void {
    this.raceCache.delete(actorId);
    this.checks.delete(actorId);
  }

  // Creation finish and the race menu both fire for one creation, so a single racialBase goes out once both returned
  private queueBase(actorId: number, why: string): void {
    if (this.baseDue.has(actorId)) return;
    this.baseDue.add(actorId);
    setImmediate(() => {
      this.baseDue.delete(actorId);
      this.sendBase(actorId, why);
    });
  }

  // The accepted race's base health and stamina, which the client still holds from the Player NPC_ race of the creation spawn
  private sendBase(actorId: number, why: string): void {
    const mp = this.mp;
    if (!mp || !this.config.present || !this.config.enabled) return;
    const who = `[racial] ${hex(actorId)}`;
    try {
      const userId = userOf(mp, actorId);
      if (userId < 0 || isCreationPending(mp, actorId)) return;
      const raceId = this.raceOf(actorId);
      const want = this.baseValues(raceId);
      if (!want) {
        this.log(`${who} base values after ${why} not sent: race ${hex(raceId)} unreadable`);
        return;
      }
      sendJson(mp, userId, { customPacketType: BASE_PACKET, raceId, health: want[0], stamina: want[2] });
      this.log(`${who} base values sent after ${why}: ${this.edidOf(raceId) || hex(raceId)} H/S ${round(want[0])}/${round(want[2])}, magicka left to MasterySystem`);
    } catch (e) {
      this.log(`${who} base values after ${why} failed: ${e}`);
    }
  }

  private polymorphed(actorId: number): boolean {
    try { return !!this.mp.get(actorId, POLYMORPH_PROP); } catch { return false; }
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

  // The character's base health as the server's damage math reads it (GetBaseActorValues), 0 when its race is unreadable or in creation
  maxHealth(actorId: number): number {
    const base = this.baseValues(this.raceOf(actorId >>> 0));
    return base && base[0] > 0 ? base[0] : 0;
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

  customPacket(userId: number, type: string, content: Content): void {
    if (type !== REPORT_PACKET || !this.mp) return;
    let actorId = 0;
    try { actorId = this.mp.getUserActor(userId) >>> 0; } catch { return; }
    if (!actorId) return;
    const now = Date.now();
    const state = this.checks.get(actorId) || { at: 0, resynced: false };
    if (now - state.at < REPORT_MIN_GAP_MS) return;
    state.at = now;
    if (this.checks.size >= MAX_CACHED_ACTORS) this.checks.clear();
    this.checks.set(actorId, state);
    if (this.checkMode() !== "off") this.selfCheck(actorId, userId, content, state);
    this.sendPowerState(actorId);
  }

  // The self-check mode in force: off without a block or with racialPassives.enabled false
  private checkMode(): string {
    return this.config.present && this.config.enabled ? this.config.selfCheck : "off";
  }

  // Compares a client's racialReport with the server's race, spells and base values; one resync per spawn for what the race sync fixes
  private selfCheck(actorId: number, userId: number, report: Content, state: CheckState): void {
    const mp = this.mp;
    const who = `[racial] ${hex(actorId)}`;
    const reason = cleanDisplayName(report.reason, 40) || "an unnamed check";
    if (isCreationPending(mp, actorId)) {
      this.log(`${who} race check after ${reason} skipped: creation pending`);
      return;
    }
    if (this.polymorphed(actorId)) {
      this.log(`${who} race check after ${reason} skipped: a polymorph holds the character (${POLYMORPH_PROP})`);
      return;
    }
    const baseRace = toFormId(report.baseRace);
    const engineRace = toFormId(report.engineRace);
    if (!baseRace) {
      this.log(`${who} race check after ${reason} ignored: the report names no race`);
      return;
    }
    const raceId = this.raceOf(actorId);
    const name = (id: number): string => (id ? this.edidOf(id) || hex(id) : "none");
    const expected = this.raceSpells(raceId).filter((id) => spellInfo(mp, id).type !== SpellType.Power);
    const problems: string[] = [];
    let fixable = false;
    // A race record with spells the server's lacks comes from another plugin, which no resync fixes
    let otherPlugin = false;
    const fix = (ids: number[], label: string, suffix = ""): void => {
      if (!ids.length) return;
      problems.push(`${label} ${ids.map(name).join(", ")}${suffix}`);
      fixable = true;
    };
    if (baseRace !== raceId || engineRace !== raceId) {
      problems.push(`engine ${name(engineRace)} base ${name(baseRace)} server ${name(raceId)}, spells not compared`);
      fixable = true;
    } else {
      const spells = reportedSpells(report.spells);
      fix(expected.filter((id) => !spells.has(id)), "missing");
      fix(expected.filter((id) => spells.get(id)?.held === false), "not held");
      fix(expected.filter((id) => spells.get(id)?.state === "off"), "off");
      const extra = Array.from(spells.keys()).filter((id) => expected.indexOf(id) === -1 && spellInfo(mp, id).type !== SpellType.Power);
      if (extra.length) problems.push(`extra ${extra.map(name).join(", ")} on the client's race record, another plugin`);
      otherPlugin = extra.length > 0;
    }
    fix(reportedList(report.stray).map((v) => toFormId(v)).filter((id) => id), "other races'", " running or held");
    const base = objectOf(report.base);
    const got = [base.health, base.magicka, base.stamina].map((v) => (v === null || v === undefined ? NaN : Number(v)));
    const want = this.baseValues(raceId);
    const why = ["race", "race", "race"];
    let magickaChecked = true;
    if (this.writtenMagicka) {
      const written = this.writtenMagicka(actorId);
      if (want && typeof written === "number" && Number.isFinite(written)) {
        want[1] = written;
        why[1] = "mastery";
      }
    } else if (report.masteryMagicka !== null && report.masteryMagicka !== undefined && Number.isFinite(Number(report.masteryMagicka))) {
      magickaChecked = false;
    }
    for (let i = 0; want && i < 3; i++) {
      if ((i !== 1 || magickaChecked) && Number.isFinite(got[i]) && Math.abs(got[i] - want[i]) > BASE_TOLERANCE) {
        problems.push(`base ${BASE_LABELS[i]} ${round(got[i])} expected ${round(want[i])} (${why[i]})`);
      }
    }
    const baseText = `base H/M/S ${got.map((v) => (Number.isFinite(v) ? round(v) : "?")).join("/")}${magickaChecked ? "" : ", magicka from the mage rank not checked"}`;
    if (!problems.length) {
      this.log(`${who} check ok ${name(raceId)} after ${reason}: ${expected.length} race spells held (${expected.map(name).join(", ") || "none"}), ${baseText}`);
      return;
    }
    let resync = "no resync, the race sync cannot fix a plugin or base value difference";
    if (!fixable || otherPlugin) {
      if (otherPlugin) resync = "no resync, the client's plugins differ from the server's";
    } else if (this.config.selfCheck !== "resync") {
      resync = `no resync, racialPassives.selfCheck is ${this.config.selfCheck}`;
    } else if (state.resynced) {
      resync = "resync already sent this spawn";
    } else {
      state.resynced = true;
      sendJson(mp, userId, { customPacketType: RESYNC_PACKET, raceId, spells: expected, problems });
      resync = "racialResync sent";
    }
    this.log(`${who} MISMATCH ${name(raceId)} after ${reason}: ${problems.join("; ")}; ${baseText}; ${resync}`);
  }

  // Epoch ms of the power's last use, 0 for never
  private lastUse(actorId: number, entry: PowerEntry): number {
    const last = Number(this.readRecord(actorId).powers[entry.desc]);
    return last > 0 ? last : 0;
  }

  // Milliseconds until the power is ready again; a use stamped in the future counts as a full cooldown
  readyInMs(actorId: number, entry: PowerEntry, now = Date.now()): number {
    const cooldown = entry.power.cooldownHours * HOUR_MS;
    const last = this.lastUse(actorId, entry);
    return cooldown > 0 && last ? Math.max(0, Math.min(cooldown, last + cooldown - now)) : 0;
  }

  // Rationed powers of the character: its race's, and any it has a use stamped for
  private powersOf(actorId: number): PowerEntry[] {
    const onRace = this.raceSpells(this.raceOf(actorId));
    const used = this.readRecord(actorId).powers;
    return Array.from(this.powerById.values()).filter((e) => onRace.indexOf(e.spellId) !== -1 || used[e.desc] !== undefined);
  }

  private effectReady(entry: PowerEntry): boolean {
    return !entry.power.effect || !!this.powerEffects[entry.power.effect];
  }

  // Sent only to a character with a rationed power
  private sendPowerState(actorId: number): void {
    if (!this.config.enabled || !this.powerById.size || !this.mp) return;
    const userId = userOf(this.mp, actorId);
    const powers = userId < 0 ? [] : this.powersOf(actorId);
    if (!powers.length) return;
    sendJson(this.mp, userId, {
      customPacketType: STATE_PACKET,
      powers: powers.map((e) => ({ spellId: e.spellId, name: e.name, readyInMs: this.readyInMs(actorId, e), available: this.effectReady(e) })),
    });
  }

  // A player's rationed power inside its cooldown, or one whose effect is not built yet, is refused
  private powerAttempt(casterId: number, spellId: number): boolean {
    const entry = this.powerById.get(spellId);
    if (!entry || !this.config.enabled || !isPlayerActor(this.mp, casterId)) return true;
    if (!this.effectReady(entry)) {
      this.refuse(casterId, entry, `${entry.name} is not available yet.`, `its ${entry.power.effect} effect is not built yet`);
      return false;
    }
    const readyIn = this.readyInMs(casterId, entry);
    if (readyIn <= 0) return true;
    const wait = formatWait(readyIn);
    this.refuse(casterId, entry, `${entry.name} is ready again in ${wait}.`, `ready again in ${wait}, last used ${new Date(this.lastUse(casterId, entry)).toISOString()}`);
    return false;
  }

  // The notice, log line and racialState follow once the native call returns, at most once per REFUSAL_GAP_MS per character and power
  private refuse(casterId: number, entry: PowerEntry, notice: string, why: string): void {
    const key = `${casterId}:${entry.spellId}`;
    const now = Date.now();
    if (now - (this.refusedAt.get(key) || 0) < REFUSAL_GAP_MS) return;
    if (this.refusedAt.size >= MAX_CACHED_ACTORS) this.refusedAt.clear();
    this.refusedAt.set(key, now);
    setImmediate(() => {
      this.log(`[racial] ${hex(casterId)} ${entry.edid} refused: ${why}`);
      sendJson(this.mp, userOf(this.mp, casterId), { customPacketType: NOTICE_PACKET, text: notice });
      this.sendPowerState(casterId);
    });
  }

  // After a cast went through: the power's effect runs, and a used power is stamped
  private powerCast(casterId: number, spellId: number): void {
    const entry = this.powerById.get(spellId);
    if (!entry || !this.config.enabled || !isPlayerActor(this.mp, casterId) || !this.effectReady(entry)) return;
    const who = `[racial] ${hex(casterId)} ${entry.edid}`;
    const run = entry.power.effect ? this.powerEffects[entry.power.effect] : null;
    let worked = true;
    if (run) {
      try {
        worked = run(casterId, entry) === true;
      } catch (e) {
        worked = false;
        this.log(`${who} effect failed: ${e}`);
      }
    }
    if (!worked && !entry.power.consumeOnMiss) {
      this.log(`${who} cast with no effect, the power stays ready`);
      return;
    }
    if (!(entry.power.cooldownHours > 0)) {
      this.log(`${who} used, no cooldown`);
      return;
    }
    const now = Date.now();
    this.writeRecord(casterId, { powers: { ...this.readRecord(casterId).powers, [entry.desc]: now } });
    this.log(`${who} used${worked ? "" : " with no effect (consumeOnMiss)"}, ready again at ${new Date(now + entry.power.cooldownHours * HOUR_MS).toISOString()} (${round(entry.power.cooldownHours)} h, counting offline)`);
    this.sendPowerState(casterId);
  }

  // The race's startingItems once per profile and slot, whatever race a recreated character picks
  private grantStartItems(actorId: number, via: "creation" | "login"): void {
    const mp = this.mp;
    try {
      const t = this.traits(actorId);
      const items = this.entryOf(t.raceEdid)?.startingItems ?? [];
      const profileId = Number(mp.get(actorId, "profileId"));
      if (!items.length || !(profileId >= 0) || this.readRecord(actorId).startItems) return;
      const rawSlot = mp.get(actorId, "private.charSlot");
      const slot = Number.isInteger(rawSlot) && rawSlot >= 0 ? rawSlot as number : 0;
      const record: StartItemsRecord = { race: t.key, items: [], at: Date.now(), via, slot };
      if (!claimStarterGrant(`${profileId}:${slot}:race`, this.log)) {
        this.writeRecord(actorId, { startItems: { ...record, note: "slot already granted" } });
        this.log(`[racial] ${hex(actorId)} ${t.key} start items: none, slot ${slot} of profile ${profileId} had them already (${via})`);
        return;
      }
      for (const i of items) {
        if (i.baseId === GOLD_BASE_ID) addGold(mp, actorId, i.count);
        else addItemTo(mp, actorId, i.baseId, i.count, true);
      }
      this.writeRecord(actorId, { startItems: { ...record, items } });
      this.log(`[racial] ${hex(actorId)} ${t.key} start items: ${items.map((i) => `${i.count} ${i.baseId === GOLD_BASE_ID ? "gold" : hex(i.baseId)}`).join(" + ")} (slot ${slot}, ${via})`);
    } catch (e) {
      this.log(`[racial] ${hex(actorId)} start items failed (${via}): ${e}`);
    }
  }

  // A character created since startItemsSince that never got its race's items gets them at login
  private backfillStartItems(actorId: number): void {
    const mp = this.mp;
    try {
      if (!this.config.enabled || isCreationPending(mp, actorId)) return;
      const t = this.traits(actorId);
      if (!this.entryOf(t.raceEdid)?.startingItems.length || this.readRecord(actorId).startItems) return;
      const created = createdAtOf(mp, actorId);
      if (created && created < this.config.startItemsSince) return;
      if (!created) {
        this.writeRecord(actorId, { startItems: { race: t.key, items: [], at: Date.now(), via: "login", slot: -1, note: "creation time unknown" } });
        this.log(`[racial] ${hex(actorId)} ${t.key} start items: none, creation time unknown`);
        return;
      }
      this.grantStartItems(actorId, "login");
    } catch (e) {
      this.log(`[racial] ${hex(actorId)} start items backfill failed: ${e}`);
    }
  }

  private readRecord(actorId: number): RacialRecord {
    const raw = objectOf(this.mp.get(actorId, RACIAL_PROP));
    const startItems = raw.startItems && typeof raw.startItems === "object" ? raw.startItems as StartItemsRecord : undefined;
    return { v: 1, powers: objectOf(raw.powers) as Record<string, number>, ...(startItems ? { startItems } : {}) };
  }

  private writeRecord(actorId: number, patch: Partial<Omit<RacialRecord, "v">>): void {
    this.mp.set(actorId, RACIAL_PROP, { ...this.readRecord(actorId), ...patch });
  }

  // Race id of the actor, 0 while its creation is pending; cached until it is forgotten, read afresh while a polymorph holds it
  private raceOf(actorId: number): number {
    const mp = this.mp;
    if (!mp || !actorId) return 0;
    if (this.polymorphed(actorId)) return actorRaceId(mp, actorId);
    const hit = this.raceCache.get(actorId);
    if (hit !== undefined) return hit;
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

  // Player NPC_ ACBS offsets of health, magicka and stamina
  private playerOffsets(): number[] {
    if (!this.offsets) {
      const acbs = fieldData(this.lookup(PLAYER_NPC), "ACBS");
      this.offsets = acbs && acbs.byteLength >= 24
        ? [ACBS_HEALTH, ACBS_MAGICKA, ACBS_STAMINA].map((o) => view(acbs).getInt16(o, true))
        : [COMMON_START, COMMON_START, COMMON_START];
    }
    return this.offsets;
  }

  // A player's base health, magicka and stamina of this race, as GetBaseActorValues computes them; null when unreadable
  private baseValues(raceId: number): number[] | null {
    const start = raceId ? this.startValues(raceId) : null;
    const offsets = this.playerOffsets();
    return start ? start.map((v, i) => v + offsets[i]) : null;
  }

  // The winning RACE record's spell list
  private raceSpells(raceId: number): number[] {
    let ids = this.spellsByRace.get(raceId);
    if (!ids) {
      ids = raceId ? espmFieldFormIds(this.lookup(raceId), "SPLO") : [];
      this.spellsByRace.set(raceId, ids);
    }
    return ids;
  }

  private lookup(id: number): any {
    try { return id && this.mp ? this.mp.lookupEspmRecordById(id >>> 0) : null; } catch { return null; }
  }

  // One line per playable race, the magic damage entries and every warning, so the numbers can be checked without playing
  private async report(dataDir: string, loadOrder: string[], problems: string[]): Promise<void> {
    const mp = this.mp;
    const warnings = problems.map((p) => `racialPassives.${p}`);
    const abilityNames = RACES.filter((r) => !NO_ABILITY.has(r.edid)).map((r) => ABILITY_PREFIX + r.edid.replace(/Race$/, ""));
    const spells = await resolveEditorIds(abilityNames.concat(Array.from(this.config.powers.keys())), dataDir, loadOrder, this.log, ["SPEL"]);
    const knownRaces = new Set([...RACES.map((r) => r.edid), ...Object.keys(this.config.aliases)]);
    const otherKeys = Array.from(this.config.races.keys()).filter((k) => !knownRaces.has(k));
    if (otherKeys.length) {
      const scan = await resolveEditorIds(otherKeys, dataDir, loadOrder, this.log, ["RACE"]);
      for (const k of scan.unresolved) warnings.push(`racialPassives.races.${k} names no RACE in the load order`);
    }
    const offsets = this.playerOffsets();
    const powers = Array.from(this.config.powers).map(([k, p]) => `${k} ${round(p.cooldownHours)} h`);
    const powersLine = this.resolvePowers(spells.resolved, warnings);
    const mode = this.checkMode();
    const selfCheck = mode === "off" ? `self-check off (racialPassives.selfCheck ${this.config.selfCheck}${this.config.present && this.config.enabled ? "" : ", racial passives off"})` :
      `self-check ${mode} on racialReport (base values within ${BASE_TOLERANCE}, one report per ${REPORT_MIN_GAP_MS / 1000} s, ` +
      `${mode === "resync" ? "one racialResync per spawn" : "never resynced"}, mage magicka ${this.writtenMagicka ? "from MasterySystem" : "not checked while the client reports a mastery write"}, ` +
      `polymorphed characters skipped)`;
    const baseLine = this.config.present && this.config.enabled ? "racialBase with the race's base health and stamina after an accepted race menu" : "no racialBase";
    this.log(`[racial] ready: ${!this.config.present ? "no racialPassives block, every race neutral" : `${this.config.enabled ? "on" : "off (enabled false), every race neutral"}, ${this.config.races.size} race entries (${Array.from(this.config.races.keys()).join(", ") || "none"}), ${Object.keys(this.config.aliases).length} aliases, powers ${powers.join(", ") || "none"}, start items once per slot, backfilled at login for characters created since ${new Date(this.config.startItemsSince).toISOString().slice(0, 16)}Z`}; ${selfCheck}; ${baseLine}; Player NPC_ offsets H/M/S ${offsets.join("/")}`);
    this.log(`[racial] powers: ${powersLine}`);
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

  // Resolves the rationed powers in the load order; returns what each one does and which races carry it
  private resolvePowers(resolved: Map<string, string>, warnings: string[]): string {
    const mp = this.mp;
    this.powerById.clear();
    const parts: string[] = [];
    for (const [edid, power] of this.config.powers) {
      const scanned = resolved.get(edid.toLowerCase());
      let spellId = 0;
      try { spellId = scanned ? mp.getIdFromDesc(scanned) >>> 0 : 0; } catch { spellId = 0; }
      const effect = !power.effect ? "no effect" : `effect ${power.effect}${this.powerEffects[power.effect] ? "" : " not built yet, so casts are refused"}`;
      const rules = `${power.cooldownHours > 0 ? `cooldown ${round(power.cooldownHours)} h of real time, counting offline` : "no cooldown"}, ` +
        `${power.consumeOnMiss ? "a miss uses it" : "a miss is free"}, ${effect}`;
      if (!spellId) {
        parts.push(`${edid} not in the load order yet (${rules})`);
        continue;
      }
      const type = spellInfo(mp, spellId).type;
      if (type !== SpellType.LesserPower && type !== SpellType.Power) warnings.push(`racialPassives.powers.${edid} is not a power (spell type ${type})`);
      let desc = scanned || "";
      try { desc = String(mp.getDescFromId(spellId)) || desc; } catch { /* keep the scanned desc */ }
      const entry: PowerEntry = { edid, spellId, desc, name: this.spellName(spellId, edid), power };
      this.powerById.set(spellId, entry);
      const races = RACES.flatMap((r) => [r.id, r.vampire]).filter((id) => this.raceSpells(id).indexOf(spellId) !== -1).map((id) => this.edidOf(id) || hex(id));
      parts.push(`${edid} ${hex(spellId)} "${entry.name}" on ${races.join(", ") || "no race"} (${rules})`);
    }
    const unrationed = new Map<string, string[]>();
    for (const raceId of RACES.flatMap((r) => [r.id, r.vampire])) {
      for (const id of this.raceSpells(raceId)) {
        const edid = this.edidOf(id);
        if (edid.startsWith(POWER_PREFIX) && !this.powerById.has(id)) unrationed.set(edid, (unrationed.get(edid) || []).concat(this.edidOf(raceId) || hex(raceId)));
      }
    }
    for (const [edid, races] of unrationed) warnings.push(`${edid} is on ${races.join(", ")} but racialPassives.powers has no entry for it, so its casts are not rationed`);
    if (!this.config.enabled) return `off (enabled false), none refused${parts.length ? `; configured ${parts.join("; ")}` : ""}`;
    return parts.join("; ") || "none rationed";
  }

  // The spell's in-game name, else its editor id spelled out
  private spellName(spellId: number, edid: string): string {
    const full = fieldData(this.lookup(spellId), "FULL");
    const text = full ? Buffer.from(full).toString("utf8").replace(/\0+$/, "") : "";
    return /^[\x20-\x7e]+$/.test(text) ? text : edid.replace(new RegExp(`^${POWER_PREFIX}`), "").replace(/([a-z])([A-Z])/g, "$1 $2");
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
  private spellsByRace = new Map<number, number[]>();
  private offsets: number[] | null = null;
  // actorId -> the self-check of its current spawn
  private checks = new Map<number, CheckState>();
  private powerById = new Map<number, PowerEntry>();
  // Built power effects by settings key; a power whose effect is missing here is refused
  private powerEffects: Record<string, PowerEffect> = {};
  // "<actorId>:<spellId>" -> when its last refusal was noticed
  private refusedAt = new Map<string, number>();
  // Actors with a racialBase queued for the next turn
  private baseDue = new Set<number>();
}
