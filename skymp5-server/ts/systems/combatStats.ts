// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Adapter for the native getCombatStats(actorId) of scam_native.node, which exists only in a build with the rebalance formula.
// Server TS reads the native through these functions only, so a renamed function or field is changed here.
const NATIVE_FUNCTION = "getCombatStats";
// Names the worn armor weight may carry, the first one present wins
const WEIGHT_FIELDS = ["armorWeight", "wornArmorWeight", "wornWeight"];

export const hasCombatStats = (mp: Mp): boolean => typeof mp?.[NATIVE_FUNCTION] === "function";

// Null when the native has no stats for the actor (formula off, unknown actor) or the call fails
export const combatStats = (mp: Mp, actorId: number): Record<string, unknown> | null => {
  try {
    const stats = hasCombatStats(mp) ? mp[NATIVE_FUNCTION](actorId) : null;
    return stats && typeof stats === "object" ? stats : null;
  } catch {
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
