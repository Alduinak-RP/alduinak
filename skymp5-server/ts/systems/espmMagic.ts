import { espmFieldFormIds, readFormIdField } from "./formIdUtil";
import { baseIdOf } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// MGEF DATA archetypes (offset 0x40)
export const MgefArchetype = {
  SummonCreature: 18,
  Reanimate: 22,
  Banish: 42,
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

const CTDA_HAS_KEYWORD = 560;
const CTDA_USE_GLOBAL = 0x04;
const ACBS_PC_LEVEL_MULT = 0x80;
const TEMPLATE_USE_TRAITS = 0x0001;
const TEMPLATE_USE_STATS = 0x0002;
const TEMPLATE_USE_KEYWORDS = 0x1000;
const MAX_TEMPLATE_DEPTH = 16;

const effectCache = new Map<number, SpellEffect[]>();
const conditionCache = new Map<number, KeywordCondition[]>();

const fieldData = (lookup: any, type: string): Uint8Array | null => {
  const fields = lookup?.record?.fields;
  if (!Array.isArray(fields)) return null;
  const f = fields.find((x: any) => x && x.type === type && x.data instanceof Uint8Array);
  return f ? f.data : null;
};

const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

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

// Effects of a SPEL or SCRL record in order; cached, plugin data never changes at runtime
export const spellEffects = (mp: Mp, spellId: number): SpellEffect[] => {
  const cached = effectCache.get(spellId);
  if (cached) return cached;
  const out: SpellEffect[] = [];
  const spell = lookup(mp, spellId);
  const type = spell?.record?.type;
  if (type === "SPEL" || type === "SCRL") {
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

const keywordConditions = (mp: Mp, mgefId: number): KeywordCondition[] => {
  const cached = conditionCache.get(mgefId);
  if (cached) return cached;
  const out: KeywordCondition[] = [];
  const mgef = lookup(mp, mgefId);
  for (const f of mgef?.record?.fields ?? []) {
    if (f?.type !== "CTDA" || !(f.data instanceof Uint8Array) || f.data.byteLength < 24) continue;
    const v = view(f.data);
    const op = v.getUint8(0);
    // Subject (runOn 0) HasKeyword against a literal value
    if (v.getUint16(8, true) !== CTDA_HAS_KEYWORD || v.getUint32(20, true) !== 0 || op & CTDA_USE_GLOBAL) continue;
    out.push({ keywordId: toGlobal(mgef, v.getUint32(12, true)), compare: op >> 5, value: v.getFloat32(4, true) });
  }
  conditionCache.set(mgefId, out);
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
