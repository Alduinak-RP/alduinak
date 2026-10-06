// Multiclass slot rules: the configured slots, their hour ladders and caps, pick order and what work counts; pure, no mp calls

export const RANK_NAMES = ["Free", "Novice", "Adept", "Expert", "Master", "Legendary"];
export const FREE = 0;
export const NOVICE = 1;
export const ADEPT = 2;
export const LEGENDARY = 5;

// Slot 0 is the primary (private.mastery), the others are sub-slots
export const SLOT_NAMES = ["Primary", "Secondary", "Tertiary"];
export const MAX_SLOTS = SLOT_NAMES.length;

export interface SlotConfig {
  name: string;
  // Highest rank the slot reaches, Novice to Legendary
  cap: number;
  // Hours for rank i + 1, Novice first, one per rank up to the cap
  rankHours: number[];
}

// Progress of one filled sub-slot; the primary keeps the same fields in private.mastery
export interface SlotRecord {
  profession: string;
  points: number;
  // Epoch ms of the slot's last counted hour, 0 before any
  lastPointAt: number;
  rank: number;
  // Hours banked for this slot alone, by a record from before the shared bank (2026-10-05) or kept while the slot was out of force; folded into the character's queue at load
  bank?: number;
}

// A slot as the rank readers see it; an empty slot has no profession
export interface HeldSlot {
  profession: string | null;
  rank: number;
}

// A HasSpell rank marker a recipe requires; several are an OR group
export interface RecipeGate {
  profession: string;
  rank: number;
}

export type ChooseRefusal = "not-configured" | "taken" | "held" | "out-of-order";

export interface ParsedSlots {
  slots: SlotConfig[];
  // Why the settings value was refused, null when it was absent or valid
  error: string | null;
}

// One primary on the existing ladder, which is multiclassing off
export const defaultSlots = (masteryRankHours: number[]): SlotConfig[] =>
  [{ name: SLOT_NAMES[0], cap: LEGENDARY, rankHours: [0].concat(masteryRankHours).slice(0, LEGENDARY) }];

export const multiclassOn = (slots: SlotConfig[]): boolean => slots.length > 1;

// A rank name in any case or a rank index, Novice to Legendary; 0 when neither
function capOf(v: unknown): number {
  const index = typeof v === "string" ? RANK_NAMES.findIndex((n) => n.toLowerCase() === v.trim().toLowerCase()) : v;
  return typeof index === "number" && Number.isInteger(index) && index >= NOVICE && index <= LEGENDARY ? index : 0;
}

// Finite hour counts of zero or more that never fall; null otherwise
function hoursOf(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every((h, i) => typeof h === "number" && Number.isFinite(h) && h >= 0 && (i === 0 || h >= v[i - 1]));
  return ok ? v.slice() : null;
}

// masterySlots from settings; absent keeps the default, malformed keeps it too and says why
export function parseSlots(raw: unknown, masteryRankHours: number[]): ParsedSlots {
  const fallback = defaultSlots(masteryRankHours);
  const refuse = (error: string): ParsedSlots => ({ slots: fallback, error });
  if (raw === undefined || raw === null) return { slots: fallback, error: null };
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_SLOTS) return refuse(`needs a list of 1 to ${MAX_SLOTS} slots`);
  const slots: SlotConfig[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return refuse(`slot ${i + 1} is not an object`);
    const e = entry as Record<string, unknown>;
    const cap = capOf(e["cap"]);
    if (!cap) return refuse(`slot ${i + 1} cap must be a rank from Novice to Legendary, by name or index`);
    // Only the primary may leave its ladder to masteryRankHours
    const hours = i === 0 && e["rankHours"] === undefined ? fallback[0].rankHours : hoursOf(e["rankHours"]);
    if (!hours || hours.length < cap) return refuse(`slot ${i + 1} rankHours needs ${cap} hour count(s) that never fall, Novice first`);
    const name = typeof e["name"] === "string" && e["name"].trim() ? e["name"].trim() : SLOT_NAMES[i];
    slots.push({ name, cap, rankHours: hours.slice(0, cap) });
  }
  return { slots, error: null };
}

// Boot text, for example "Primary to Legendary (0/40/100/180/6000 h), Secondary to Adept (20/60 h)"
export function describeSlots(slots: SlotConfig[]): string {
  const text = slots.map((s) => `${s.name} to ${RANK_NAMES[s.cap]} (${s.rankHours.join("/")} h)`).join(", ");
  return multiclassOn(slots) ? text : `${text}, multiclass off`;
}

// Rank of a filled slot: the last threshold its hours reached, never above the cap
export function slotRankFor(cfg: SlotConfig, points: number): number {
  let rank = FREE;
  for (let i = 0; i < cfg.cap && i < cfg.rankHours.length; i++) {
    if (points < cfg.rankHours[i]) break;
    rank = i + 1;
  }
  return rank;
}

// A slot at its cap earns no more hours
export const isCapped = (cfg: SlotConfig, points: number): boolean => slotRankFor(cfg, points) >= cfg.cap;

// The next rank, the hours it needs and how many are left; null at the cap
export function hoursToNext(cfg: SlotConfig, points: number): { rank: number; at: number; left: number } | null {
  const rank = slotRankFor(cfg, points);
  if (rank >= cfg.cap) return null;
  const at = cfg.rankHours[rank];
  return { rank: rank + 1, at, left: Math.max(0, at - points) };
}

// An ungated recipe counts for any slot; a gated one only through a marker of the slot's profession at a rank it holds
export function creditsCraft(profession: string, rank: number, gates: RecipeGate[]): boolean {
  return !gates.length || gates.some((g) => g.profession === profession && g.rank <= rank);
}

// The best ranked slot following one of the professions that also qualifies for the gates; the lower slot wins a tie
export function bestSlot(held: HeldSlot[], professionIds: string[], gates: RecipeGate[] = []): HeldSlot | null {
  let best: HeldSlot | null = null;
  for (const slot of held) {
    if (!slot.profession || professionIds.indexOf(slot.profession) === -1 || !creditsCraft(slot.profession, slot.rank, gates)) continue;
    if (!best || slot.rank > best.rank) best = slot;
  }
  return best;
}

// The first empty configured slot, -1 when all are filled
export function nextEmptySlot(professions: Array<string | null>, slotCount: number): number {
  for (let i = 0; i < slotCount; i++) {
    if (!professions[i]) return i;
  }
  return -1;
}

// Why a pick is refused, null when allowed; a stored slot beyond slotCount takes no pick but still holds its craft
export function chooseRefusal(professions: Array<string | null>, slotCount: number, profession: string, slot: number): ChooseRefusal | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= slotCount) return "not-configured";
  if (professions[slot]) return "taken";
  if (professions.indexOf(profession) !== -1) return "held";
  return slot === nextEmptySlot(professions, slotCount) ? null : "out-of-order";
}

// Slots whose profession a lower slot already holds; the lower one is kept
export function duplicateSlots(professions: Array<string | null>): number[] {
  return professions.map((p, i) => (p && professions.indexOf(p) < i ? i : -1)).filter((i) => i !== -1);
}

export const emptySlotRecord = (profession: string): SlotRecord =>
  ({ profession, points: 0, lastPointAt: 0, rank: FREE });

// A stored sub-slot with every field clamped, null when it holds no known profession; an old per-slot bank is kept for the fold, its onlineMs dropped
export function toSlotRecord(raw: unknown, isProfession: (id: string) => boolean): SlotRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const profession = r["profession"];
  if (typeof profession !== "string" || !isProfession(profession)) return null;
  const rec: SlotRecord = {
    profession,
    points: Math.max(0, Math.floor(Number(r["points"])) || 0),
    lastPointAt: Math.max(0, Number(r["lastPointAt"]) || 0),
    rank: Math.min(LEGENDARY, Math.max(FREE, Math.floor(Number(r["rank"])) || 0)),
  };
  const bank = Math.max(0, Math.floor(Number(r["bank"])) || 0);
  if (bank) rec.bank = bank;
  return rec;
}
