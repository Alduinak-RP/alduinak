import { Log } from "./system";
import { espmContainerEntries, espmFieldFormIds } from "./formIdUtil";
import { loc } from "../loc";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Constructible objects by the item they make or improve, read once per server and shared by crafted extras and repairs

// Skyrim.esm CraftingSmithingArmorTable and CraftingSmithingSharpeningWheel, the only bench keywords the native CraftService tempers at
export const ARMOR_TABLE = 0x000adb78;
export const SHARPENING_WHEEL = 0x00088108;
export const TEMPER_BENCHES = [ARMOR_TABLE, SHARPENING_WHEEL];
// Health steps in tenths: Fine, the cap of a Free character, up to Legendary; each profession rank adds one
export const FINE_STEP = 11;
export const LEGENDARY_STEP = 16;
export const QUALITY_NAMES = [loc("temper.quality.fine"), loc("temper.quality.superior"), loc("temper.quality.exquisite"), loc("temper.quality.flawless"), loc("temper.quality.epic"), loc("temper.quality.legendary")];

export interface RecipeInput {
  id: number;
  count: number;
}

export interface TemperRecipe {
  // The COBJ record, which the rank readers of MasterySystem take
  id: number;
  // Bench keyword
  bench: number;
  inputs: RecipeInput[];
}

const indexes = new WeakMap<object, Map<number, TemperRecipe[]>>();

const lookup = (mp: Mp, id: number): any => {
  try {
    const res = id ? mp.lookupEspmRecordById(id >>> 0) : null;
    return res && res.record ? res : null;
  } catch {
    return null;
  }
};

// Record ids of one type in load order, empty with a log line when the native cannot list them
export const espmRecordIds = (mp: Mp, type: string, log: Log): number[] => {
  if (typeof mp.getEspmRecordIdsByType !== "function") {
    log(`[espm] the server native has no getEspmRecordIdsByType, so ${type} records cannot be read`);
    return [];
  }
  try {
    return Array.from(mp.getEspmRecordIdsByType(type) as ArrayLike<number>, (id) => Number(id) >>> 0);
  } catch (e) {
    log(`[espm] reading ${type} records failed: ${e}`);
    return [];
  }
};

const build = (mp: Mp, log: Log): Map<number, TemperRecipe[]> => {
  const index = new Map<number, TemperRecipe[]>();
  for (const id of espmRecordIds(mp, "COBJ", log)) {
    const res = lookup(mp, id);
    const created = espmFieldFormIds(res, "CNAM")[0] || 0;
    const bench = espmFieldFormIds(res, "BNAM")[0] || 0;
    if (!created || !bench) continue;
    const inputs = espmContainerEntries(res).filter((e) => e.baseId && e.count > 0 && e.count < 0x80000000).map((e) => ({ id: e.baseId, count: e.count }));
    const list = index.get(created) || [];
    list.push({ id, bench, inputs });
    index.set(created, list);
  }
  return index;
};

// Every recipe that makes or improves the item, in load order
export const recipesOf = (mp: Mp, baseId: number, log: Log): TemperRecipe[] => {
  let index = indexes.get(mp);
  if (!index) {
    index = build(mp, log);
    indexes.set(mp, index);
  }
  return index.get(baseId >>> 0) || [];
};

// The recipes of the item a station with these bench keywords offers
export const recipesAt = (mp: Mp, baseId: number, benches: Iterable<number>, log: Log): TemperRecipe[] => {
  const offered = new Set(Array.from(benches, (k) => k >>> 0));
  return recipesOf(mp, baseId, log).filter((r) => offered.has(r.bench));
};

// The item's temper recipes at the workbench and the grindstone
export const temperRecipesOf = (mp: Mp, baseId: number, log: Log): TemperRecipe[] => recipesAt(mp, baseId, TEMPER_BENCHES, log);

// Highest health step a profession rank tempers to: Free Fine (1.1) up to Legendary (1.6), the native TemperCap::HealthOfRank
export const temperCapStep = (rank: number): number => Math.min(LEGENDARY_STEP, FINE_STEP + Math.max(0, Math.floor(rank)));

// "Superior" for step 12; empty below Fine
export const qualityName = (step: number): string => QUALITY_NAMES[Math.min(step, LEGENDARY_STEP) - FINE_STEP] || "";
