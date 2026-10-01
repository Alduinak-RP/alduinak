import { Settings } from "../settings";
import { hex } from "./actorUtil";
import { GearStats, NO_ATTACK_KIND, armorWeightOf, combatStats, hasCombatStats, totalDtOf, weaponsOf, wornPiecesOf } from "./combatStats";
import { Log, System, SystemContext } from "./system";
import { FINE_STEP, qualityName } from "./temperRecipes";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// /armor: what a player wears and holds with the DT, temper and condition of each piece
//
// The gamemode part 86_combat_readout.js answers the chat command with the lines of globalThis.__alduinakArmorReport(actorId).
// The function is registered only when a readout exists, so without it the command stays unknown as before.
//
// server-settings.json:
//   alduinakDamageFormulaSettings.enabled              true gives the DT lines, read from the native getCombatStats
//   alduinakDamageFormulaSettings.durability.enabled   true gives the condition, read from the native getDurability
//   alduinakDamageFormulaSettings.durability.nameTag.brokenLabel   the word for a copy at 0, default "Broken"

const DEFAULT_BROKEN_LABEL = "Broken";

// Adapter for the native getDurability(actorId) of scam_native.node, which exists only in a build with the durability core.
const DURABILITY_FUNCTION = "getDurability";

export const hasDurability = (mp: Mp): boolean => typeof mp?.[DURABILITY_FUNCTION] === "function";

// One durable copy in an inventory
export interface DurableCopy {
  baseId: number;
  // Share from 0 to 1, 1 for a copy that never wore
  condition: number;
  // HP of the copy at full condition, null when the native sends none
  maxHp: number | null;
  worn: boolean;
  // Worn in the left hand: a second weapon or a shield
  left: boolean;
}

const copyOf = (entry: unknown): DurableCopy | null => {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const baseId = Number(e["baseId"]);
  if (!Number.isFinite(baseId) || baseId <= 0) return null;
  const condition = typeof e["condition"] === "number" && Number.isFinite(e["condition"]) ? Math.min(1, Math.max(0, e["condition"])) : 1;
  // hp is the full HP of the row unless the native also sends maxHp
  const maxHp = [e["maxHp"], e["hp"]].find((v) => typeof v === "number" && Number.isFinite(v) && v > 0) as number | undefined;
  return { baseId: baseId >>> 0, condition, maxHp: maxHp ?? null, worn: e["worn"] === true || e["wornLeft"] === true, left: e["wornLeft"] === true };
};

// Every durable copy the actor holds, null when the native has none to give or the call fails
export const durableCopies = (mp: Mp, actorId: number): DurableCopy[] | null => {
  try {
    const raw = hasDurability(mp) ? mp[DURABILITY_FUNCTION](actorId) : null;
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
    return list ? (list as unknown[]).map(copyOf).filter((c): c is DurableCopy => c !== null) : null;
  } catch {
    return null;
  }
};

// The percent of the name tag, the native ConditionPercent: rounded down, 1 for anything above 0
export const conditionPercent = (condition: number): number =>
  condition <= 0 ? 0 : Math.max(1, Math.floor(Math.min(1, condition) * 100 + 1e-6));

// "97% (340/350)", "Broken (0/350)" or "97%" without the HP
export const conditionText = (condition: number, maxHp: number | null, brokenLabel: string): string => {
  const label = condition <= 0 ? brokenLabel : `${conditionPercent(condition)}%`;
  if (maxHp === null) return label;
  const max = Math.round(maxHp);
  const now = condition <= 0 ? 0 : Math.min(max, Math.max(1, Math.round(condition * maxHp)));
  return `${label} (${now}/${max})`;
};

// At most two decimals, "8.1" and "13"
const num = (v: number): string => String(Math.round(v * 100) / 100);

export interface ReadoutConfig {
  // The rebalance prices hits, so worn gear has DT
  formula: boolean;
  durability: boolean;
  brokenLabel: string;
}

// What alduinakDamageFormulaSettings switches on; both false without the block
export const readoutConfig = (block: unknown): ReadoutConfig => {
  const b = block && typeof block === "object" ? block as Record<string, any> : {};
  const label = b["durability"]?.["nameTag"]?.["brokenLabel"];
  return {
    formula: b["enabled"] === true,
    durability: b["durability"]?.["enabled"] === true,
    brokenLabel: typeof label === "string" && label.trim() ? label.trim() : DEFAULT_BROKEN_LABEL,
  };
};

export interface ReadoutSources {
  // Read getCombatStats
  stats: boolean;
  // Read getDurability
  wear: boolean;
  brokenLabel: string;
  nameOf: (baseId: number) => string;
}

// The lines /armor shows for the actor; null when neither native has anything for it
export const armorReport = (mp: Mp, actorId: number, o: ReadoutSources): string[] | null => {
  const stats = o.stats ? combatStats(mp, actorId) : null;
  const copies = o.wear ? durableCopies(mp, actorId) : null;
  if (!stats && !copies) return null;

  // A worn copy is matched to one piece only, so two copies of a base keep their own condition
  const free = (copies ?? []).filter((c) => c.worn);
  // left names the hand of a weapon, whose copy in that hand is taken before any other of its base
  const takeCopy = (baseId: number, left?: boolean): DurableCopy | null => {
    const inHand = left === undefined ? -1 : free.findIndex((c) => c.baseId === baseId && c.left === left);
    const i = inHand < 0 ? free.findIndex((c) => c.baseId === baseId) : inHand;
    return i < 0 ? null : free.splice(i, 1)[0];
  };
  // Temper and condition of a piece; the condition needs durability on and a value from either native
  const tail = (gear: GearStats, left?: boolean): string[] => {
    const copy = takeCopy(gear.baseId, left);
    const condition = gear.condition ?? copy?.condition ?? null;
    return [
      gear.temperStep > 0 ? qualityName(FINE_STEP - 1 + gear.temperStep) : "",
      o.wear && condition !== null ? conditionText(condition, copy?.maxHp ?? null, o.brokenLabel) : "",
    ];
  };
  const line = (baseId: number, parts: string[], fallback: string): string => `${o.nameOf(baseId)}: ${parts.filter(Boolean).join(", ") || fallback}`;

  const lines: string[] = [];
  if (stats) {
    const pieces = wornPiecesOf(stats);
    const total = totalDtOf(stats);
    const weight = armorWeightOf(stats);
    if (!pieces.length) lines.push("You wear no armor: DT 0, every weapon hit lands in full.");
    else lines.push(`Armor: DT ${num(total ?? 0)} (taken off each weapon hit)${weight !== null ? `, weight ${num(weight)}` : ""}`);
    for (const p of pieces) {
      const dt = p.dt === null ? "" : `DT ${num(p.dt)}${p.fullDt !== null && p.fullDt > p.dt + 0.005 ? ` of ${num(p.fullDt)}` : ""}`;
      lines.push(line(p.baseId, [dt, ...tail(p)], "no DT"));
    }
    for (const w of weaponsOf(stats)) {
      const damage = w.kind === NO_ATTACK_KIND ? "no weapon damage" : w.damage === null ? "" : `damage ${num(w.damage)}`;
      lines.push(line(w.baseId, [damage, ...tail(w, w.left)], "in hand"));
    }
  }
  // What the stats did not name: everything worn when only durability is on
  for (const c of free.splice(0)) lines.push(`${o.nameOf(c.baseId)}: ${conditionText(c.condition, c.maxHp, o.brokenLabel)}`);
  if (!lines.length) lines.push("Nothing you wear or hold wears down.");
  return lines;
};

export class CombatReadoutSystem implements System {
  systemName = "CombatReadoutSystem";

  constructor(private log: Log) {}

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const config = readoutConfig((await Settings.get()).allSettings?.["alduinakDamageFormulaSettings"]);
    if (!config.formula && !config.durability) return;
    const stats = config.formula && hasCombatStats(mp);
    const wear = config.durability && hasDurability(mp);
    const missing = [config.formula && !stats ? "getCombatStats (no DT lines)" : "", config.durability && !wear ? "getDurability (no condition)" : ""].filter(Boolean);
    if (missing.length) this.log(`[combat] this scam_native.node has no ${missing.join(" and no ")}${stats || wear ? "" : ", /armor is off"}`);
    if (!stats && !wear) return;
    const g = globalThis as any;
    const nameOf = (baseId: number): string => String(g.__alduinakItemName?.(baseId) || "") || `item ${hex(baseId)}`;
    g.__alduinakArmorReport = (actorId: number): string[] | null =>
      armorReport(mp, Number(actorId) >>> 0, { stats, wear, brokenLabel: config.brokenLabel, nameOf });
    this.log(`[combat] /armor shows ${[stats ? "DT and temper per worn piece" : "", wear ? "condition" : ""].filter(Boolean).join(" and ")}`);
  }
}
