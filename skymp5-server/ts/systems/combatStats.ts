// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Adapter for the native getCombatStats(actorId) of scam_native.node, which exists only in a build with the rebalance formula.
// Server TS reads the native through these functions only, so a renamed function or field is changed here.
const NATIVE_FUNCTION = "getCombatStats";
// Names the worn armor weight may carry, the first one present wins; the native's armorWeight leaves the shield out
const WEIGHT_FIELDS = ["armorWeight", "wornArmorWeight", "wornWeight"];

export const hasCombatStats = (mp: Mp): boolean => typeof mp?.[NATIVE_FUNCTION] === "function";

// Null when the native has no stats for the actor (formula off or block rejected, unknown actor) or the call fails; failed gets what a call threw
export const combatStats = (mp: Mp, actorId: number, failed?: (error: unknown) => void): Record<string, unknown> | null => {
  try {
    const stats = hasCombatStats(mp) ? mp[NATIVE_FUNCTION](actorId) : null;
    return stats && typeof stats === "object" ? stats : null;
  } catch (e) {
    failed?.(e);
    return null;
  }
};

// Weight of the armor the actor wears, null when the stats carry none
export const armorWeightOf = (stats: Record<string, unknown>): number | null => {
  for (const field of WEIGHT_FIELDS) {
    const v = stats[field];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
};

// Names the other fields may carry, the native's own first; the first one present wins
const TOTAL_DT_FIELDS = ["wornDT", "dt", "totalDT"];
const PIECE_LIST_FIELDS = ["pieces", "armor", "worn"];
// The native lists one entry per hand; a single object is read as well
const WEAPON_LIST_FIELDS = ["weapons"];
const WEAPON_FIELDS = ["weapon"];
const KIND_FIELD = "kind";
const HAND_FIELD = "hand";
const LEFT_HAND = "left";
// Kind of a weapon the formula prices no attack for: a staff, a dummy row
export const NO_ATTACK_KIND = "none";
const PIECE_DT_FIELDS = ["dt"];
const PIECE_DT_COUNTED_FIELDS = ["countedDT"];
const TEMPER_FIELDS = ["temperStep", "temper"];
const DAMAGE_FIELDS = ["damage"];
const CONDITION_FIELDS = ["condition"];

// A worn armor piece, a shield or the weapon in hand as the stats give it
export interface GearStats {
  baseId: number;
  // Armor, shield or attack kind as the stats name it, null when they carry none
  kind: string | null;
  // Held in the left hand; false for armor and for stats without a hand
  left: boolean;
  // DT the piece gives now, at its temper and condition; null for a weapon
  dt: number | null;
  // Part of the DT in the total: less when a better piece covers the same slots, null when the stats carry none
  countedDt: number | null;
  // Damage of the weapon at its temper and condition, null for armor
  damage: number | null;
  // Temper steps above the plain item, 0 to 6
  temperStep: number;
  // Share from 0 to 1, null when the stats carry none
  condition: number | null;
}

const numberIn = (o: Record<string, unknown>, fields: string[]): number | null => {
  for (const field of fields) {
    const v = o[field];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
};

const gearOf = (entry: unknown): GearStats | null => {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const baseId = numberIn(e, ["baseId"]);
  if (baseId === null || baseId <= 0) return null;
  const condition = numberIn(e, CONDITION_FIELDS);
  return {
    baseId: baseId >>> 0,
    kind: typeof e[KIND_FIELD] === "string" ? e[KIND_FIELD] as string : null,
    left: e[HAND_FIELD] === LEFT_HAND,
    dt: numberIn(e, PIECE_DT_FIELDS),
    countedDt: numberIn(e, PIECE_DT_COUNTED_FIELDS),
    damage: numberIn(e, DAMAGE_FIELDS),
    temperStep: Math.max(0, Math.floor(numberIn(e, TEMPER_FIELDS) ?? 0)),
    condition: condition === null ? null : Math.min(1, Math.max(0, condition)),
  };
};

// Worn armor pieces and shield in the order the native lists them
export const wornPiecesOf = (stats: Record<string, unknown>): GearStats[] => {
  const list = PIECE_LIST_FIELDS.map((field) => stats[field]).find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).map(gearOf).filter((p): p is GearStats => p !== null);
};

// The weapons, bows, crossbows and staves in hand, the right hand first; empty for fists
export const weaponsOf = (stats: Record<string, unknown>): GearStats[] => {
  const list = WEAPON_LIST_FIELDS.map((field) => stats[field]).find(Array.isArray) as unknown[] | undefined;
  const held = (list ?? WEAPON_FIELDS.map((field) => stats[field])).map(gearOf).filter((w): w is GearStats => w !== null);
  return held.sort((a, b) => Number(a.left) - Number(b.left));
};

// DT of everything worn; the sum of the pieces when the stats carry no total
export const totalDtOf = (stats: Record<string, unknown>): number | null => {
  const total = numberIn(stats, TOTAL_DT_FIELDS);
  if (total !== null) return total;
  const pieces = wornPiecesOf(stats).filter((p) => p.dt !== null);
  return pieces.length ? pieces.reduce((sum, p) => sum + (p.dt as number), 0) : null;
};
