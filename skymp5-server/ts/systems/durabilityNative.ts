import { Log } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// What server TS reads of alduinakDamageFormulaSettings.durability, and the adapter for the native settleWear(actorId) of scam_native.node.
// Server TS names the native function and the settings keys here only, so a rename is changed in this file.
const SETTINGS_BLOCK = "alduinakDamageFormulaSettings";
const NATIVE_SETTLE = "settleWear";
const DEFAULT_BROKEN_LABEL = "Broken";

// How a copy's condition shows in its name: "Steel Sword (97%)", "(Broken)" at 0
export interface DurabilityTags {
  enabled: boolean;
  showAtFull: boolean;
  brokenLabel: string;
}

// durability.enabled stands on its own: the wear rules also run with the rebalance formula off
export const durabilityTags = (allSettings: Record<string, unknown> | null | undefined): DurabilityTags => {
  const block = allSettings?.[SETTINGS_BLOCK] as { durability?: { enabled?: unknown; nameTag?: { showAtFull?: unknown; brokenLabel?: unknown } } } | undefined;
  const durability = block && typeof block === "object" ? block.durability : undefined;
  const label = durability?.nameTag?.brokenLabel;
  return {
    enabled: durability?.enabled === true,
    showAtFull: durability?.nameTag?.showAtFull !== false,
    brokenLabel: typeof label === "string" && label.trim() ? label.trim() : DEFAULT_BROKEN_LABEL,
  };
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The trailing " (97%)" or " (Broken)" of a name
export const conditionTagPattern = (brokenLabel: string): RegExp =>
  new RegExp(`\\s\\((?:\\d{1,3}%|${[DEFAULT_BROKEN_LABEL, brokenLabel].filter((l, i, all) => all.indexOf(l) === i).map(escapeRegExp).join("|")})\\)$`);

export const hasSettleWear = (mp: Mp): boolean => typeof mp?.[NATIVE_SETTLE] === "function";

// Writes the wear a fight still holds in memory into the actor's copies, called before server TS reads or moves that actor's items
export type SettleWear = (actorId: number) => void;

const NO_SETTLE: SettleWear = () => { };
let missingLogged = false;
let failureLogged = false;

// A no-op with durability off or on a scam_native.node without the call, which is reported once
export const wearSettler = (mp: Mp, allSettings: Record<string, unknown> | null | undefined, log: Log): SettleWear => {
  if (!durabilityTags(allSettings).enabled) return NO_SETTLE;
  if (!hasSettleWear(mp)) {
    if (!missingLogged) {
      missingLogged = true;
      log(`[durability] wear is not settled before items change hands: this scam_native.node has no ${NATIVE_SETTLE}, an item traded or taken right after a fight keeps the condition it last showed`);
    }
    return NO_SETTLE;
  }
  return (actorId: number): void => {
    try {
      mp[NATIVE_SETTLE](actorId);
    } catch (e) {
      if (failureLogged) return;
      failureLogged = true;
      log(`[durability] ${NATIVE_SETTLE} failed for ${(actorId >>> 0).toString(16)}, later failures are not logged: ${e}`);
    }
  };
};
