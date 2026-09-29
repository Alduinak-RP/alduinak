import { espmFieldFormIds } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ACBS template flags: with Use Traits the race comes from the TPLT template, and the CK leaves a placeholder
// race (FoxRace, DefaultRace) on the record itself
export const TEMPLATE_USE_TRAITS = 0x01;
const MAX_TEMPLATE_DEPTH = 8;

const lookup = (mp: Mp, id: number): any => {
  try { return id ? mp.lookupEspmRecordById(id >>> 0) : null; } catch { return null; }
};

// ACBS template flags of an NPC_ lookup, 0 when absent
export const templateFlagsOf = (res: any): number => {
  const acbs = (res?.record?.fields || []).find((f: any) => f?.type === "ACBS" && f.data instanceof Uint8Array && f.data.byteLength >= 20)?.data;
  return acbs ? new DataView(acbs.buffer, acbs.byteOffset, acbs.byteLength).getUint16(18, true) : 0;
};

// The actor's base id followed by its template chain, without duplicates
export const npcChainOf = (mp: Mp, actorId: number): number[] => {
  const chain: number[] = [];
  try { chain.push(mp.getIdFromDesc(String(mp.get(actorId, "baseDesc"))) >>> 0); } catch { /* no base */ }
  try {
    const tpl = mp.get(actorId, "templateChain");
    if (Array.isArray(tpl)) for (const id of tpl) chain.push(Number(id) >>> 0);
  } catch { /* not an actor */ }
  return chain.filter((id, i) => id && chain.indexOf(id) === i);
};

// RNAM race of the first NPC_ in the chain that keeps its own traits; a Use Traits record without a stored chain
// is followed through its TPLT while that is an NPC_. 0 when the race cannot be told (a leveled template left unresolved)
export const effectiveRaceId = (mp: Mp, chain: number[]): number => {
  const pending = chain.slice();
  const seen = new Set<number>();
  while (pending.length && seen.size <= MAX_TEMPLATE_DEPTH) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const res = lookup(mp, id);
    if (res?.record?.type !== "NPC_") continue;
    if (!(templateFlagsOf(res) & TEMPLATE_USE_TRAITS)) return espmFieldFormIds(res, "RNAM")[0] || 0;
    const template = espmFieldFormIds(res, "TPLT")[0] || 0;
    if (!template) return espmFieldFormIds(res, "RNAM")[0] || 0;
    if (!pending.includes(template) && lookup(mp, template)?.record?.type === "NPC_") pending.unshift(template);
  }
  return 0;
};
