import { espmFieldFormIds, readFormIdField, readVmadScripts } from "./formIdUtil";
import { baseIdOf } from "./actorUtil";
import { effectiveRaceId, npcChainOf } from "./npcTemplate";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// MGEF DATA archetypes (offset 0x40)
export const MgefArchetype = {
  ValueModifier: 0,
  CureDisease: 3,
  SummonCreature: 18,
  Reanimate: 22,
  PeakValueModifier: 34,
  Banish: 42,
} as const;

// Actor value indices, as MGEF DATA names them at 0x44
export const ActorValue = {
  Health: 24,
  PoisonResist: 40,
  FireResist: 41,
  ElectricResist: 42,
  FrostResist: 43,
  MagicResist: 44,
  DiseaseResist: 45,
} as const;

export interface SpellEffect {
  mgefId: number;
  archetype: number;
  // MGEF associated item: the NPC_ a SummonCreature effect conjures
  assocId: number;
  magnitude: number;
  area: number;
  durationSec: number;
}

interface KeywordCondition {
  keywordId: number;
  compare: number;
  value: number;
}

interface Ctda {
  // Low five bits of the operator byte: 0x01 OR, 0x04 use global
  flags: number;
  compare: number;
  value: number;
  fn: number;
  // Parameter 1 mapped to a global form id through the record that holds the condition
  formParam: number;
  // 0 subject, 1 target
  runOn: number;
}

interface ResistEffect {
  av: number;
  // Negative for a detrimental effect
  magnitude: number;
  // The magic effect's conditions and the spell effect's, each list with its own OR groups
  conditions: Ctda[][];
}

// Whose keywords and race a condition reads; actorId 0 for a race alone
interface Subject {
  raceId: number;
  actorId: number;
}

// Script effect of Reanimate Corpse, Revenant and Dread Zombie that turns the zombie to ash; Dead Thrall has none
const ASH_PILE_SCRIPT = "reanimateashpile";
const CTDA_GET_IS_RACE = 69;
const CTDA_HAS_SPELL = 264;
const CTDA_HAS_PERK = 448;
const CTDA_HAS_KEYWORD = 560;
const CTDA_OR = 0x01;
const CTDA_USE_GLOBAL = 0x04;
const ACBS_PC_LEVEL_MULT = 0x80;
const TEMPLATE_USE_TRAITS = 0x0001;
const TEMPLATE_USE_STATS = 0x0002;
const TEMPLATE_USE_SPELL_LIST = 0x0008;
const TEMPLATE_USE_KEYWORDS = 0x1000;
const MAX_TEMPLATE_DEPTH = 16;
// fPlayerMaxResistance, the cap GetResistMult applies
export const RESIST_CAP = 85;
const LEARNED_TTL_MS = 2000;
const MAX_CACHED_ACTORS = 1024;

const effectCache = new Map<number, SpellEffect[]>();
const conditionCache = new Map<number, KeywordCondition[]>();
const ashCache = new Map<number, boolean>();
const cureCache = new Map<number, boolean>();
const spellConditionCache = new Map<number, number[]>();
const resistCache = new Map<number, ResistEffect[]>();
const raceResistCache = new Map<string, number>();
const learnedCache = new Map<number, { at: number; ids: number[] }>();

export const fieldData = (lookup: any, type: string): Uint8Array | null => {
  const fields = lookup?.record?.fields;
  if (!Array.isArray(fields)) return null;
  const f = fields.find((x: any) => x && x.type === type && x.data instanceof Uint8Array);
  return f ? f.data : null;
};

export const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

const toGlobal = (lookup: any, localId: number): number => {
  if (!localId || typeof lookup?.toGlobalRecordId !== "function") return 0;
  try {
    return lookup.toGlobalRecordId(localId) >>> 0;
  } catch {
    return 0;
  }
};

const lookup = (mp: Mp, id: number): any => {
  try {
    return id ? mp.lookupEspmRecordById(id) : null;
  } catch {
    return null;
  }
};

// Effects of a SPEL, SCRL or ALCH record in order; cached, plugin data never changes at runtime
export const spellEffects = (mp: Mp, spellId: number): SpellEffect[] => {
  const cached = effectCache.get(spellId);
  if (cached) return cached;
  const out: SpellEffect[] = [];
  const spell = lookup(mp, spellId);
  const type = spell?.record?.type;
  if (type === "SPEL" || type === "SCRL" || type === "ALCH") {
    let mgefId = 0;
    for (const f of spell.record.fields) {
      if (!(f?.data instanceof Uint8Array)) continue;
      if (f.type === "EFID" && f.data.byteLength >= 4) {
        mgefId = toGlobal(spell, view(f.data).getUint32(0, true));
      } else if (f.type === "EFIT" && mgefId && f.data.byteLength >= 12) {
        const efit = view(f.data);
        const mgef = lookup(mp, mgefId);
        const data = fieldData(mgef, "DATA");
        const mgefView = data && data.byteLength >= 0x44 ? view(data) : null;
        out.push({
          mgefId,
          archetype: mgefView ? mgefView.getUint32(0x40, true) : -1,
          assocId: mgefView ? toGlobal(mgef, mgefView.getUint32(0x08, true)) : 0,
          magnitude: efit.getFloat32(0, true),
          area: efit.getUint32(4, true),
          durationSec: efit.getUint32(8, true),
        });
        mgefId = 0;
      }
    }
  }
  effectCache.set(spellId, out);
  return out;
};

const MGEF_DETRIMENTAL = 0x4;
const healingCache = new Map<number, number>();

// Health an ALCH restores through non-detrimental value modifiers of Health, 0 for any other item
export const potionHealing = (mp: Mp, itemId: number): number => {
  const cached = healingCache.get(itemId);
  if (cached !== undefined) return cached;
  let total = 0;
  if (lookup(mp, itemId)?.record?.type === "ALCH") {
    for (const e of spellEffects(mp, itemId)) {
      const data = fieldData(lookup(mp, e.mgefId), "DATA");
      if (!data || data.byteLength < 0x48) continue;
      const v = view(data);
      if (v.getUint32(0, true) & MGEF_DETRIMENTAL) continue;
      if (v.getUint32(0x40, true) === MgefArchetype.ValueModifier && v.getUint32(0x44, true) === ActorValue.Health) total += e.magnitude;
    }
  }
  healingCache.set(itemId, total);
  return total;
};

// True for an ALCH carrying a Cure Disease effect
export const hasCureDisease = (mp: Mp, itemId: number): boolean => {
  const cached = cureCache.get(itemId);
  if (cached !== undefined) return cached;
  const result = lookup(mp, itemId)?.record?.type === "ALCH" && spellEffects(mp, itemId).some((e) => e.archetype === MgefArchetype.CureDisease);
  cureCache.set(itemId, result);
  return result;
};

// SPIT types
export const SpellType = { Spell: 0, Disease: 1, Power: 2, LesserPower: 3, Ability: 4 } as const;
export const CastType = { Concentration: 2 } as const;

export interface SpellInfo {
  // SPIT type and cast type, -1 when the record is no SPEL
  type: number;
  castType: number;
  // 1 Novice (and Apprentice), 2 Adept, 3 Expert, 4 Master: from the highest MGEF minimum skill
  tier: number;
}

const infoCache = new Map<number, SpellInfo>();

export const spellInfo = (mp: Mp, spellId: number): SpellInfo => {
  const cached = infoCache.get(spellId);
  if (cached) return cached;
  const spell = lookup(mp, spellId);
  const spit = spell?.record?.type === "SPEL" ? fieldData(spell, "SPIT") : null;
  const minSkill = Math.max(0, ...spellEffects(mp, spellId).map((e) => {
    const data = fieldData(lookup(mp, e.mgefId), "DATA");
    return data && data.byteLength >= 0x2c ? view(data).getUint32(0x28, true) : 0;
  }));
  const info = {
    type: spit && spit.byteLength >= 20 ? view(spit).getUint32(8, true) : -1,
    castType: spit && spit.byteLength >= 20 ? view(spit).getUint32(16, true) : -1,
    tier: minSkill >= 100 ? 4 : minSkill >= 75 ? 3 : minSkill >= 50 ? 2 : 1,
  };
  infoCache.set(spellId, info);
  return info;
};

// True when an effect of the spell runs the vanilla ReanimateAshPile script (MGEF VMAD)
export const turnsToAsh = (mp: Mp, spellId: number): boolean => {
  const cached = ashCache.get(spellId);
  if (cached !== undefined) return cached;
  const result = spellEffects(mp, spellId).some((e) => readVmadScripts(lookup(mp, e.mgefId)).has(ASH_PILE_SCRIPT));
  ashCache.set(spellId, result);
  return result;
};

// The NPC_ record that supplies a template-controlled part, walking the actor's template chain like EvaluateTemplate.h
const npcFor = (mp: Mp, actorId: number, templateFlag: number): any => {
  let chain: number[] = [];
  try {
    const raw = mp.get(actorId, "templateChain");
    if (Array.isArray(raw)) chain = raw.map((x) => Number(x) >>> 0);
  } catch { }
  let rec = lookup(mp, chain.length ? chain[0] : baseIdOf(mp, actorId));
  if (rec?.record?.type !== "NPC_") return null;
  for (let i = 0; i < MAX_TEMPLATE_DEPTH; i++) {
    const acbs = fieldData(rec, "ACBS");
    const flags = acbs && acbs.byteLength >= 20 ? view(acbs).getUint16(18, true) : 0;
    const tplt = readFormIdField(rec, "TPLT");
    if (!tplt || !(flags & templateFlag)) return rec;
    const next = lookup(mp, i + 1 < chain.length ? chain[i + 1] : toGlobal(rec, tplt));
    // A leveled list the server did not evaluate: this record is the best answer
    if (next?.record?.type !== "NPC_") return rec;
    rec = next;
  }
  return rec;
};

// ACBS level; NPCs leveled with the player count at their calculated minimum
export const npcLevel = (mp: Mp, actorId: number): number => {
  const acbs = fieldData(npcFor(mp, actorId, TEMPLATE_USE_STATS), "ACBS");
  if (!acbs || acbs.byteLength < 14) return 1;
  const v = view(acbs);
  const level = v.getUint32(0, true) & ACBS_PC_LEVEL_MULT ? v.getUint16(10, true) : v.getUint16(8, true);
  return Math.max(1, level);
};

// Own or template keywords plus the race's, like HasKeyword on an actor
export const npcHasKeyword = (mp: Mp, actorId: number, keywordId: number): boolean => {
  if (espmFieldFormIds(npcFor(mp, actorId, TEMPLATE_USE_KEYWORDS), "KWDA").includes(keywordId)) return true;
  const traits = npcFor(mp, actorId, TEMPLATE_USE_TRAITS);
  const race = lookup(mp, toGlobal(traits, readFormIdField(traits, "RNAM")));
  return espmFieldFormIds(race, "KWDA").includes(keywordId);
};

const readCtda = (owner: any, data: Uint8Array): Ctda | null => {
  if (data.byteLength < 24) return null;
  const v = view(data);
  const op = v.getUint8(0);
  return { flags: op & 0x1f, compare: op >> 5, value: v.getFloat32(4, true), fn: v.getUint16(8, true), formParam: toGlobal(owner, v.getUint32(12, true)), runOn: v.getUint32(20, true) };
};

// Every CTDA of a record in order
const ctdasOf = (owner: any): Ctda[] =>
  (owner?.record?.fields ?? [])
    .filter((f: any) => f?.type === "CTDA" && f.data instanceof Uint8Array)
    .map((f: any) => readCtda(owner, f.data))
    .filter((c: Ctda | null): c is Ctda => !!c);

// A subject condition compared against a literal value
const literalOnSubject = (c: Ctda): boolean => c.runOn === 0 && !(c.flags & CTDA_USE_GLOBAL);

const keywordConditions = (mp: Mp, mgefId: number): KeywordCondition[] => {
  const cached = conditionCache.get(mgefId);
  if (cached) return cached;
  const out = ctdasOf(lookup(mp, mgefId))
    .filter((c) => c.fn === CTDA_HAS_KEYWORD && literalOnSubject(c))
    .map((c) => ({ keywordId: c.formParam, compare: c.compare, value: c.value }));
  conditionCache.set(mgefId, out);
  return out;
};

// Spells of every subject HasSpell == 1 condition of a record, such as a recipe's profession markers; cached
export const hasSpellConditions = (mp: Mp, recordId: number): number[] => {
  const cached = spellConditionCache.get(recordId);
  if (cached) return cached;
  const out = ctdasOf(lookup(mp, recordId))
    .filter((c) => c.fn === CTDA_HAS_SPELL && literalOnSubject(c) && c.compare === 0 && c.value === 1 && c.formParam)
    .map((c) => c.formParam);
  spellConditionCache.set(recordId, out);
  return out;
};

const compare = (actual: number, op: number, value: number): boolean => {
  switch (op) {
    case 0: return actual === value;
    case 1: return actual !== value;
    case 2: return actual > value;
    case 3: return actual >= value;
    case 4: return actual < value;
    case 5: return actual <= value;
    default: return true;
  }
};

// The effect's HasKeyword conditions on its target (MagicNoReanimate, ActorTypeNPC, ActorTypeDaedra); other conditions are not evaluated
export const keywordConditionsPass = (mp: Mp, mgefId: number, actorId: number): boolean =>
  keywordConditions(mp, mgefId).every((c) => compare(npcHasKeyword(mp, actorId, c.keywordId) ? 1 : 0, c.compare, c.value));

// A player's appearance race, else the race of the NPC_ that supplies the actor's traits, like MpActor::GetRaceId; 0 when unknown
export const actorRaceId = (mp: Mp, actorId: number): number => {
  try {
    const raceId = Number(mp.get(actorId, "appearance")?.raceId) >>> 0;
    if (raceId) return raceId;
  } catch { /* no appearance */ }
  return effectiveRaceId(mp, npcChainOf(mp, actorId));
};

// Spells the actor learned in play, through Papyrus; each call walks the base lists, so a result is kept briefly
export const learnedSpells = (mp: Mp, actorId: number): number[] => {
  const now = Date.now();
  const hit = learnedCache.get(actorId);
  if (hit && now - hit.at < LEARNED_TTL_MS) return hit.ids;
  const ids: number[] = [];
  try {
    const self = { type: "form", desc: mp.getDescFromId(actorId) };
    const count = Number(mp.callPapyrusFunction("method", "Actor", "GetSpellCount", self, [])) || 0;
    for (let i = 0; i < count; i++) {
      const spell = mp.callPapyrusFunction("method", "Actor", "GetNthSpell", self, [i]);
      if (typeof spell?.desc === "string") ids.push(mp.getIdFromDesc(spell.desc) >>> 0);
    }
  } catch { /* unknown form */ }
  if (learnedCache.size >= MAX_CACHED_ACTORS) learnedCache.clear();
  learnedCache.set(actorId, { at: now, ids });
  return ids;
};

// Value and peak value modifier effects of an Ability or Disease SPEL; cached
const resistEffects = (mp: Mp, spellId: number): ResistEffect[] => {
  const cached = resistCache.get(spellId);
  if (cached) return cached;
  const out: ResistEffect[] = [];
  const type = spellInfo(mp, spellId).type;
  if (type === SpellType.Ability || type === SpellType.Disease) {
    const spell = lookup(mp, spellId);
    let mgef: any = null;
    let current: ResistEffect | null = null;
    for (const f of spell?.record?.fields ?? []) {
      if (!(f?.data instanceof Uint8Array)) continue;
      if (f.type === "EFID" && f.data.byteLength >= 4) {
        mgef = lookup(mp, toGlobal(spell, view(f.data).getUint32(0, true)));
        current = null;
      } else if (f.type === "EFIT" && mgef && f.data.byteLength >= 12) {
        const data = fieldData(mgef, "DATA");
        const d = data && data.byteLength >= 0x48 ? view(data) : null;
        const archetype = d ? d.getUint32(0x40, true) : -1;
        if (d && (archetype === MgefArchetype.ValueModifier || archetype === MgefArchetype.PeakValueModifier)) {
          const magnitude = view(f.data).getFloat32(0, true);
          current = { av: d.getInt32(0x44, true), magnitude: d.getUint32(0, true) & MGEF_DETRIMENTAL ? -magnitude : magnitude, conditions: [ctdasOf(mgef), []] };
          out.push(current);
        }
        mgef = null;
      } else if (f.type === "CTDA" && current) {
        const c = readCtda(spell, f.data);
        if (c) current.conditions[1].push(c);
      }
    }
  }
  resistCache.set(spellId, out);
  return out;
};

const subjectHasKeyword = (mp: Mp, s: Subject, keywordId: number): boolean =>
  espmFieldFormIds(lookup(mp, s.raceId), "KWDA").includes(keywordId) ||
  (!!s.actorId && espmFieldFormIds(npcFor(mp, s.actorId, TEMPLATE_USE_KEYWORDS), "KWDA").includes(keywordId));

// As the native ConditionHolds: HasPerk fails, subject HasKeyword and GetIsRace are read, anything else holds
const ctdaHolds = (mp: Mp, c: Ctda, s: Subject): boolean => {
  if (c.fn === CTDA_HAS_PERK) return false;
  if ((c.flags & ~CTDA_OR) !== 0 || c.runOn !== 0) return true;
  if (c.fn === CTDA_HAS_KEYWORD) return compare(subjectHasKeyword(mp, s, c.formParam) ? 1 : 0, c.compare, c.value);
  if (c.fn === CTDA_GET_IS_RACE) return compare(c.formParam === s.raceId ? 1 : 0, c.compare, c.value);
  return true;
};

// CTDAs flagged OR join the next one into a group, and every group must hold
const conditionsHold = (mp: Mp, ctdas: Ctda[], s: Subject): boolean => {
  let group = false;
  for (let i = 0; i < ctdas.length; i++) {
    group = group || ctdaHolds(mp, ctdas[i], s);
    if (!(ctdas[i].flags & CTDA_OR) || i + 1 === ctdas.length) {
      if (!group) return false;
      group = false;
    }
  }
  return true;
};

const resistFrom = (mp: Mp, spellIds: number[], av: number, s: Subject): number => {
  let total = 0;
  for (const spellId of new Set(spellIds)) {
    for (const e of resistEffects(mp, spellId)) {
      if (e.av === av && e.conditions.every((list) => conditionsHold(mp, list, s))) total += e.magnitude;
    }
  }
  return total;
};

// What a race's own abilities put on the actor value, weaknesses subtracted, uncapped; cached
export const raceAbilityResist = (mp: Mp, raceId: number, av: number): number => {
  const key = `${raceId}:${av}`;
  const cached = raceResistCache.get(key);
  if (cached !== undefined) return cached;
  const total = resistFrom(mp, espmFieldFormIds(lookup(mp, raceId), "SPLO"), av, { raceId, actorId: 0 });
  raceResistCache.set(key, total);
  return total;
};

// Resistance on the actor value from the race, NPC_ and learned Ability and Disease spells, weaknesses subtracted and capped
// like the native GetResistMult; raceOnly counts the race's abilities alone
export const abilityResist = (mp: Mp, actorId: number, av: number, cap = RESIST_CAP, raceOnly = false): number => {
  const raceId = actorRaceId(mp, actorId);
  const total = raceOnly ? raceAbilityResist(mp, raceId, av) : resistFrom(mp, [
    ...espmFieldFormIds(lookup(mp, raceId), "SPLO"),
    ...espmFieldFormIds(npcFor(mp, actorId, TEMPLATE_USE_SPELL_LIST), "SPLO"),
    ...learnedSpells(mp, actorId),
  ], av, { raceId, actorId });
  return Math.min(total, cap);
};
