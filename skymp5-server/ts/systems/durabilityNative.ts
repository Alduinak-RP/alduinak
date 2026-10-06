import { Log } from "./system";
import { loc } from "../loc";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// What server TS reads of alduinakDamageFormulaSettings.durability, and the adapters for the native settleWear(actorId) and getDurability(actorId) of scam_native.node.
// The repairs name the native functions and the settings keys here only, so a rename is changed in this file.
const SETTINGS_BLOCK = "alduinakDamageFormulaSettings";
const NATIVE_SETTLE = "settleWear";
const DEFAULT_BROKEN_LABEL = loc("durability.brokenLabel");

// How a copy's condition shows in its name: "Steel Sword (97%)", "(Broken)" at 0
export interface DurabilityTags {
  enabled: boolean;
  showAtFull: boolean;
  brokenLabel: string;
}

// durability.enabled stands on its own: the wear rules also run with the rebalance formula off
// The broken label is kept as written, since the native reads it back from item names character by character
export const durabilityTags = (allSettings: Record<string, unknown> | null | undefined): DurabilityTags => {
  const block = allSettings?.[SETTINGS_BLOCK] as { durability?: { enabled?: unknown; nameTag?: { showAtFull?: unknown; brokenLabel?: unknown } } } | undefined;
  const durability = block && typeof block === "object" ? block.durability : undefined;
  const label = durability?.nameTag?.brokenLabel;
  return {
    enabled: durability?.enabled === true,
    showAtFull: durability?.nameTag?.showAtFull !== false,
    brokenLabel: typeof label === "string" && label ? label : DEFAULT_BROKEN_LABEL,
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

const NATIVE_DURABILITY = "getDurability";

export const hasDurableCopies = (mp: Mp): boolean => typeof mp?.[NATIVE_DURABILITY] === "function";

// One durable copy of an inventory as the native getDurability(actorId) lists it
export interface DurableCopy {
  // Place of the copy in the inventory entries, -1 when the native names none
  index: number;
  baseId: number;
  // weapon, bow, crossbow, armor or shield; "" when the native names none
  kind: string;
  // Settings row of the item, "" when the native names none
  row: string;
  // HP of the copy at full condition (the native's maxHp; its hp is the points left), 0 when the native sends none
  maxHp: number;
  // Covers the body slot; null when the native names no slot
  cuirass: boolean | null;
  // Share from 0 to 1, 1 for a copy that never wore
  condition: number;
  worn: boolean;
  wornLeft: boolean;
  // The row's material of durability.repair.fallbackMaterial as the native resolved it, 0 without one
  fallbackMaterial: number;
}

const CUIRASS_SLOTS = ["cuirass", "body", "32"];

const copyOf = (entry: unknown): DurableCopy | null => {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const baseId = Number(e["baseId"]);
  if (!Number.isFinite(baseId) || baseId <= 0) return null;
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const maxHp = e["maxHp"];
  const slots = [e["slot"], e["slots"]].flatMap((v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])).map((v) => String(v).toLowerCase());
  const condition = e["condition"];
  const whole = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : -1);
  return {
    index: whole(e["index"]),
    baseId: baseId >>> 0,
    kind: text(e["kind"]).toLowerCase(),
    row: text(e["row"]),
    maxHp: typeof maxHp === "number" && Number.isFinite(maxHp) && maxHp > 0 ? maxHp : 0,
    cuirass: slots.length ? slots.some((s) => CUIRASS_SLOTS.indexOf(s) !== -1) : null,
    condition: typeof condition === "number" && Number.isFinite(condition) ? Math.min(1, Math.max(0, condition)) : 1,
    worn: e["worn"] === true,
    wornLeft: e["wornLeft"] === true,
    fallbackMaterial: Math.max(0, whole(e["fallbackMaterial"])) >>> 0,
  };
};

// Every durable copy the actor holds, null when the native has none to give or the call fails
export const durableCopies = (mp: Mp, actorId: number): DurableCopy[] | null => {
  try {
    const raw = hasDurableCopies(mp) ? mp[NATIVE_DURABILITY](actorId) : null;
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
    return list ? (list as unknown[]).map(copyOf).filter((c): c is DurableCopy => c !== null) : null;
  } catch {
    return null;
  }
};

// False when the native answers null for an actor: durability is off there, as after a settings block it rejected
export const nativeDurabilityOn = (mp: Mp, actorId: number): boolean => {
  try {
    return !hasDurableCopies(mp) || mp[NATIVE_DURABILITY](actorId) !== null;
  } catch {
    return true;
  }
};

// alduinakDamageFormulaSettings.durability.repair as server TS reads it
export interface RepairSettings {
  // Share of the durability one set of materials restores, per item class
  unitsPerMissing: { weapon: number; cuirass: number; other: number };
  // Kind ("weapon", "bow", "crossbow", "armor"; "" for a table without kinds), then row, then form key
  fallbackMaterial: Record<string, Record<string, string>>;
  requireProfessionRank: boolean;
  // Crafts of fatigue one repaired item costs at the bench, 0 for none
  fatigue: number;
  anyBench: boolean;
  menuOnActivate: boolean;
  // Empty for no chat command
  chatCommand: string;
  lowNoticeBelow: number;
}

export const repairSettings = (allSettings: Record<string, unknown> | null | undefined): RepairSettings => {
  const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const repair = object(object(object(allSettings?.[SETTINGS_BLOCK])["durability"])["repair"]);
  const units = object(repair["unitsPerMissing"]);
  const share = (v: unknown, fallback: number): number => (typeof v === "number" && v > 0 && v <= 1 ? v : fallback);
  const fallbackMaterial: Record<string, Record<string, string>> = {};
  for (const [name, value] of Object.entries(object(repair["fallbackMaterial"]))) {
    const [kind, rows] = typeof value === "string" ? ["", { [name]: value }] : [name, object(value)];
    for (const [row, key] of Object.entries(rows)) {
      if (typeof key === "string" && key.trim()) (fallbackMaterial[kind] ||= {})[row] = key.trim();
    }
  }
  const fatigue = repair["fatigue"];
  const low = repair["lowNoticeBelow"];
  const command = repair["chatCommand"];
  return {
    unitsPerMissing: { weapon: share(units["weapon"], 0.5), cuirass: share(units["cuirass"], 0.5), other: share(units["other"], 1) },
    fallbackMaterial,
    requireProfessionRank: repair["requireProfessionRank"] === true,
    fatigue: typeof fatigue === "number" && fatigue > 0 ? fatigue : 0,
    anyBench: repair["anyBench"] === true,
    menuOnActivate: repair["menuOnActivate"] !== false,
    chatCommand: typeof command === "string" ? command.trim().toLowerCase().replace(/^\//, "") : "repair",
    lowNoticeBelow: typeof low === "number" && low >= 0 && low <= 1 ? low : 0.25,
  };
};
