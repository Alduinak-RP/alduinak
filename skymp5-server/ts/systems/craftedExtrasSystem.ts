import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { chainMpHook } from "./actorUtil";
import { espmFieldFormIds, readFormIdField, toFormId } from "./formIdUtil";
import { MasterySystem, RANK_NAMES } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";
import { LEGENDARY_STEP, TemperRecipe, espmRecordIds, qualityName, recipesAt, temperCapStep, temperRecipesOf } from "./temperRecipes";
import {
  EnchantmentEffect, Inventory, InventoryEntry, Item, addEntries, byNearestCondition, copyValidExtras, describeExtras, healthStep,
  isEnchanted, isSet, readInventory, sameBase, sameEffects, sameFloat, sameItem, withCount,
} from "./inventoryExtras";
import { conditionTagPattern, durabilityTags } from "./durabilityNative";
import { loc } from "../loc";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Records extras players make in vanilla, paid for from the server's own copies and clamped to vanilla limits; souls are soul trap's
// A temper follows the native CraftService: the recipe's rank gates, the rank cap of the recipe's profession and one craft of fatigue
// Condition (durability) is the server's alone: a result keeps the condition of the copy it was made from and a reported one only says which copy is meant
//
// Client -> Server: { customPacketType: "craftedExtras", workbench, gained: Entry[], lost: Entry[] }
//   gained: local copies the server lacks; lost: server copies the player no longer has (the sources and inputs)
//   workbench: remote id of the crafting furniture the player used last, 0 if none
// Server -> Client: { customPacketType: "notification", text } when a crafted change is refused
// Server -> Client: { customPacketType: "craftedExtrasRefused", baseIds } so the client reverts those items to the server copy
//
// server-settings.json: craftedExtrasTemperRules, true or false; not set, the rules are on while alduinakDamageFormulaSettings has
// enabled or durability.enabled true. Off tempers by materials alone, up to Legendary and free of fatigue

const PACKET = "craftedExtras";
const NOTICE_PACKET = "notification";
const REFUSED_PACKET = "craftedExtrasRefused";
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
const MAX_GAINED = 32;
const MAX_LOST = 64;
const MAX_UNITS = 16;
const MIN_REPORT_GAP_MS = 200;
const NOTICE_GAP_MS = 60 * 1000;
// Charge a soul gives by soul size (GMST iSoulLevelValuePetty..Grand); a black soul counts as Grand
const SOUL_CHARGE = [0, 250, 500, 1000, 2000, 3000];
// Soul Squeezer adds magicka when recharging
const RECHARGE_MARGIN = 2;
// Twice the strongest plugin enchantment of an effect covers skill, perks and Fortify Enchanting potions
const ENCHANT_MARGIN = 2;
// Extra Effect perk
const MAX_EFFECTS = 2;
// Concentrated Poison perk
const MAX_POISON_USES = 2;
// Sanity band around the Creation Kit effect cost formula, which vanilla only roughly follows
const COST_BAND = [0.05, 20];
const STATION_RANGE = 1024;
// An explicit 0 charge re-applies as a full one (AddItemEx skips ExtraCharge 0)
const MIN_CHARGE = 0.01;
// FURN WBDT bench types
const BENCH_SMITHING_WEAPON = 2;
const BENCH_ENCHANTING = 3;
const BENCH_ENCHANTING_EXPERIMENT = 4;
const BENCH_SMITHING_ARMOR = 7;
const KEYWORD_DISALLOW_ENCHANTING = 0x000c27bd;
const KEYWORD_REUSABLE_SOUL_GEM = 0x000ed2f1;
// ENCH ENIT enchant type; weapon enchantments are fire and forget on contact, armor ones constant on self
const ENCH_TYPE_ENCHANTMENT = 6;
// ALCH ENIT flag
const FLAG_POISON = 0x20000;
const TEMPER_SUFFIX = /\s\((Fine|Superior|Exquisite|Flawless|Epic|Legendary)\)$/;
// A poison OnEquip consumed stays claimable this long, since the report can wait for the inventory menu to close
const POISON_CREDIT_MS = 10 * 60 * 1000;
const MAX_POISON_CREDITS = 8;
// Concentrated Poison puts a second dose on the weapon the apply already poisoned, reported soon after
const POISON_RAISE_MS = 15 * 1000;
// A report built before the inventory of a native temper reached the client arrives within this long of the craft
const NATIVE_TEMPER_MS = 3000;
const MAX_NATIVE_TEMPERS = 8;

interface Cap {
  magnitude: number;
  area: number;
  duration: number;
}

interface ItemInfo {
  type: string;
  baseEnchantment: number;
  baseCharge: number;
  enchantable: boolean;
}

interface Station {
  enchanting: boolean;
  temperBenches: number[];
}

// A server copy the report says left the player, and how much of it is still unspent
interface PoolEntry {
  index: number;
  entry: InventoryEntry;
  claimed: number;
  left: number;
}

interface SoulSource {
  size: number;
  from: PoolEntry;
  used: boolean;
  // A reusable gem (Azura's Star) stays behind empty
  emptied?: InventoryEntry;
}

interface Reservation {
  pool: PoolEntry;
  count: number;
}

// A poison the server already removed when the player applied it (OnEquip of a poison ALCH)
interface PoisonCredit {
  baseId: number;
  at: number;
  used: boolean;
  // Set when the apply poisoned the worn copy itself, so the perk's second dose may still raise it
  raiseUntil?: number;
}

// A temper the native craft was asked for, and the quality steps the actor's copies of the item held right before it
interface NativeTemper {
  baseId: number;
  at: number;
  steps: number;
}

// A temper the crafter's rank and fatigue bar allow: the health step it reaches and what it costs
interface Temper {
  recipe: TemperRecipe;
  step: number;
  // The rank cap cut the claimed step
  capped: boolean;
  // The craft of fatigue it costs, null with the temper rules off
  price: { rank: number; half: boolean } | null;
  note: string;
}

type TemperRefusal = "rank" | "tired";

// Who reports, and why the temper of the line being planned was refused
interface Crafter {
  actorId: number;
  refusals: Set<TemperRefusal>;
}

interface Plan {
  entry: InventoryEntry;
  reserve: Reservation[];
  soul: SoulSource | null;
  credit: PoisonCredit | null;
  temper: Temper | null;
  notes: string[];
}

const REFUSED_NOTICE = loc("crafted.refused");
const RANK_NOTICE = loc("crafted.rankCap");
const TIRED_NOTICE = loc("crafted.tired");

const NO_STATION: Station = { enchanting: false, temperBenches: [] };
const hex = (id: number): string => (id >>> 0).toString(16);
const viewOf = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const chargeOf = (e: InventoryEntry): number => (typeof e.chargePercent === "number" ? e.chargePercent : 0);

// Creation Kit effect cost; area is ignored, as it is for every vanilla enchantment
const formulaCost = (baseCost: number, e: EnchantmentEffect): number =>
  baseCost * Math.pow(Math.max(e.magnitude, 1), 1.1) * Math.pow(Math.max(e.duration / 10, 1), 1.1);

// Quality steps above plain over every copy of the item, which only a temper raises
const temperSteps = (inv: Inventory, baseId: number): number =>
  inv.entries.reduce((n, e) => ((e.baseId >>> 0) === (baseId >>> 0) ? n + (healthStep(e.health) - 10) * e.count : n), 0);

// craftedExtrasTemperRules when it is set, else on with the rebalance or durability
const temperRulesOn = (all: Record<string, unknown>): boolean => {
  const set = all["craftedExtrasTemperRules"];
  if (typeof set === "boolean") return set;
  return durabilityTags(all).enabled || (all["alduinakDamageFormulaSettings"] as { enabled?: unknown } | null | undefined)?.enabled === true;
};

// conditionTag is the " (97%)" or " (Broken)" a durability client shows after a name, null with durability off
const cleanName = (name: unknown, conditionTag: RegExp | null): string | undefined => {
  if (typeof name !== "string") return undefined;
  let text = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(TEMPER_SUFFIX, "");
  // The engine puts the quality after the tag ("Steel Sword (97%) (Fine)"), so both come off until neither is left
  while (conditionTag && (conditionTag.test(text) || TEMPER_SUFFIX.test(text))) {
    text = text.replace(conditionTag, "").replace(TEMPER_SUFFIX, "");
  }
  text = text.trim().slice(0, 128);
  return text || undefined;
};

export class CraftedExtrasSystem implements System {
  systemName = "CraftedExtrasSystem";

  constructor(private log: Log, private mastery: MasterySystem, private needs: NeedsSystem) { }

  // Applying a poison sends OnEquip, which eats and removes the poison before the craft report arrives
  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const all = ((await Settings.get()).allSettings || {}) as Record<string, unknown>;
    this.temperRules = temperRulesOn(all);
    const tags = durabilityTags(all);
    this.conditionTag = tags.enabled ? conditionTagPattern(tags.brokenLabel) : null;
    const why = typeof all["craftedExtrasTemperRules"] === "boolean" ? `craftedExtrasTemperRules is ${this.temperRules}`
      : `craftedExtrasTemperRules is not set and alduinakDamageFormulaSettings is ${this.temperRules ? "on" : "absent or off"}`;
    this.log(`[crafted] a reported temper ${this.temperRules ? "follows its recipe's rank gates and rank cap and costs a craft of fatigue" : "takes materials only"}: ${why}`);
    if (this.temperRules) {
      chainMpHook(mp, "onCraft", (actorId: number, craftedId: number, _count: number, recipeId: number) => {
        this.noteNativeTemper(ctx, Number(actorId) >>> 0, Number(craftedId) >>> 0, Number(recipeId) >>> 0);
      });
    }
    chainMpHook(mp, "onEatItem", (rawActorId: number, rawBaseId: number) => {
      let poison = false;
      try {
        const baseId = Number(rawBaseId) >>> 0;
        poison = this.isPoison(ctx, baseId);
        if (poison) {
          const actorId = Number(rawActorId) >>> 0;
          this.addPoisonCredit(actorId, baseId);
          setImmediate(() => this.applyPoisonToWorn(ctx, actorId, baseId));
        }
      } catch (e) {
        this.log(`[crafted] poison credit failed: ${e}`);
      }
      // A blocked eat skips only the effects, OnEquip still removes the poison
      return poison ? false : undefined;
    });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== PACKET) return;
    const now = Date.now();
    if (now - (this.lastReportAt.get(userId) || 0) < MIN_REPORT_GAP_MS) return;
    this.lastReportAt.set(userId, now);
    try {
      this.onReport(ctx, userId, content);
    } catch (e) {
      this.log(`[crafted] report of user ${userId} failed: ${e}`);
    }
  }

  disconnect(userId: number): void {
    this.lastReportAt.delete(userId);
    this.lastNoticeAt.delete(userId);
  }

  private onReport(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try {
      actorId = mp.getUserActor(userId) >>> 0;
    } catch {
      return;
    }
    const gained = this.normalize(content.gained, MAX_GAINED);
    if (!actorId || !gained.length) return;

    const inv = readInventory(mp, actorId);
    const pool = this.resolveLost(inv, this.normalize(content.lost, MAX_LOST));
    const station = this.stationOf(ctx, actorId, toFormId(content.workbench));
    const souls = this.soulSources(ctx, pool);
    const emptiedGems = this.pairEmptiedGems(ctx, gained, souls);
    const credits = this.creditsOf(actorId);
    const crafter: Crafter = { actorId, refusals: new Set() };
    const reasons = new Set<TemperRefusal>();

    const added: InventoryEntry[] = [];
    const refused = new Set<number>();
    const capped = new Map<number, number>();
    for (const g of gained) {
      if (emptiedGems.has(g)) continue;
      for (let unit = 0; unit < Math.min(g.count, MAX_UNITS); unit++) {
        crafter.refusals.clear();
        if (this.takeNativeTemper(actorId, inv, g, pool)) {
          this.log(`[crafted] ${hex(actorId)} ${hex(g.baseId)}: the reported temper is the one the craft already recorded, nothing changed`);
          continue;
        }
        const plan = this.findPlan(ctx, crafter, g, pool, souls, station, credits);
        if (!plan) {
          if (this.isCraftClaim(g, pool)) {
            refused.add(g.baseId >>> 0);
            crafter.refusals.forEach((r) => reasons.add(r));
            const sources = pool.filter((p) => sameBase(p.entry, g)).map((p) => `{${describeExtras(p.entry).join(", ")}}`);
            const why = crafter.refusals.size ? ` (${Array.from(crafter.refusals).join(", ")})` : "";
            this.log(`[crafted] ${hex(actorId)} ${hex(g.baseId)}: refused {${describeExtras(g).join(", ")}} from ${sources.join(" ") || "nothing"}${why}`);
          }
          break;
        }
        this.commit(plan, added);
        const t = plan.temper;
        // Paid at once, so the next unit of the report is checked against the bar that is left
        if (t?.price) this.needs.pay(ctx, actorId, "craft", t.price.rank, `temper ${hex(plan.entry.baseId)} by ${hex(t.recipe.id)} r${t.price.rank}${t.price.half ? " half" : ""} (crafted extras)`, t.price.half);
        if (t?.capped) capped.set(plan.entry.baseId >>> 0, t.step);
        if (t) this.forgetNativeTempers(actorId, plan.entry.baseId);
        this.log(`[crafted] ${hex(actorId)} ${hex(plan.entry.baseId)}: ${plan.notes.join(", ")} {${describeExtras(plan.entry).join(", ")}}`);
      }
    }
    this.creditsOf(actorId);

    if (added.length) {
      const counts = inv.entries.map((e) => e.count);
      for (const p of pool) counts[p.index] -= p.claimed - p.left;
      const rest: Inventory = { entries: inv.entries.map((e, j) => ({ ...e, count: counts[j] })).filter((e) => e.count > 0) };
      mp.set(actorId, "inventory", addEntries(rest, added));
    }
    // A capped temper reverts too: the local copy shows the quality the client made, the server's the one the rank allows
    const revert = new Set([...refused, ...capped.keys()]);
    if (!revert.size) return;
    this.send(ctx, userId, { customPacketType: REFUSED_PACKET, baseIds: Array.from(revert) });
    if (!refused.size) this.notify(ctx, userId, loc("crafted.capped", { quality: qualityName(Math.max(...capped.values())) }));
    else this.notify(ctx, userId, reasons.has("tired") ? TIRED_NOTICE : reasons.has("rank") ? RANK_NOTICE : REFUSED_NOTICE);
  }

  private normalize(raw: unknown, max: number): InventoryEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: InventoryEntry[] = [];
    for (const r of raw.slice(0, max)) {
      const baseId = Number(r?.baseId);
      const count = Math.floor(Number(r?.count));
      if (!Number.isInteger(baseId) || baseId <= 0 || !Number.isInteger(count) || count <= 0 || count > 65535) continue;
      const item: InventoryEntry = { baseId: baseId >>> 0, count };
      copyValidExtras(r, item);
      out.push(item);
    }
    return out;
  }

  // Each lost line claims the server's own copies: the same copy first, then any copy of the same item, the one nearest to the line's condition before the others
  private resolveLost(inv: Inventory, lost: InventoryEntry[]): PoolEntry[] {
    const avail = inv.entries.map((e) => e.count);
    const pool: PoolEntry[] = [];
    for (const l of lost) {
      let need = l.count;
      const order = byNearestCondition(inv.entries, l.condition);
      const take = (fits: (e: InventoryEntry) => boolean): void => {
        for (const index of order) {
          const e = inv.entries[index];
          if (need <= 0) return;
          if (avail[index] <= 0 || !fits(e)) continue;
          const n = Math.min(need, avail[index]);
          avail[index] -= n;
          need -= n;
          pool.push({ index, entry: e, claimed: n, left: n });
        }
      };
      take((e) => sameItem(e, l) && sameFloat(chargeOf(e), chargeOf(l)));
      take((e) => sameItem(e, l));
    }
    return pool;
  }

  // Filled gems the player no longer has; each unit is one soul
  private soulSources(ctx: SystemContext, pool: PoolEntry[]): SoulSource[] {
    const sources: SoulSource[] = [];
    for (const p of pool) {
      const size = this.soulIn(ctx, p.entry);
      for (let i = 0; size && i < p.left; i++) {
        sources.push({ size, from: p, used: false });
      }
    }
    return sources;
  }

  // A reported copy of a reusable gem without its soul is that gem, emptied by the craft
  private pairEmptiedGems(ctx: SystemContext, gained: InventoryEntry[], souls: SoulSource[]): Set<InventoryEntry> {
    const paired = new Set<InventoryEntry>();
    for (const g of gained) {
      if (g.soul || !this.keywordsOf(ctx, g.baseId).includes(KEYWORD_REUSABLE_SOUL_GEM)) continue;
      const src = souls.find((s) => !s.emptied && sameBase(s.from.entry, g) && s.from.entry.soul);
      if (src) {
        const empty = withCount(src.from.entry, 1);
        delete empty.soul;
        src.emptied = empty;
        paired.add(g);
      }
    }
    return paired;
  }

  private findPlan(ctx: SystemContext, crafter: Crafter, g: InventoryEntry, pool: PoolEntry[], souls: SoulSource[], station: Station, credits: PoisonCredit[]): Plan | null {
    for (const p of pool) {
      if (p.left <= 0 || !sameBase(p.entry, g)) continue;
      const plan = this.plan(ctx, crafter, p, g, pool, souls, station, credits);
      if (plan) return plan;
    }
    return null;
  }

  private commit(plan: Plan, added: InventoryEntry[]): void {
    for (const r of plan.reserve) r.pool.left -= r.count;
    if (plan.credit) {
      plan.credit.used = true;
      delete plan.credit.raiseUntil;
    }
    if (plan.soul) {
      plan.soul.used = true;
      plan.soul.from.left -= 1;
      if (plan.soul.emptied) added.push(plan.soul.emptied);
    }
    added.push(plan.entry);
  }

  // The server copy source becoming g, paid for from the pool; null when vanilla could not have made it
  private plan(ctx: SystemContext, crafter: Crafter, source: PoolEntry, g: InventoryEntry, pool: PoolEntry[], souls: SoulSource[], station: Station, credits: PoisonCredit[]): Plan | null {
    const s = source.entry;
    const info = this.itemInfo(ctx, s.baseId);
    const out = withCount(s, 1);
    const reserve: Reservation[] = [{ pool: source, count: 1 }];
    const notes: string[] = [];
    let soul: SoulSource | null = null;
    let credit: PoisonCredit | null = null;
    let temper: Temper | null = null;

    // Souls only arrive through the soul trap system, and plugin enchantments never change
    if ((g.soul || 0) !== (s.soul || 0) || (g.enchantmentId || 0) !== (s.enchantmentId || 0)) return null;
    if (!!g.removeEnchantmentOnUnequip !== !!s.removeEnchantmentOnUnequip) return null;

    const enchanting = !sameEffects(s.enchantmentEffects, g.enchantmentEffects);
    if (enchanting) {
      if (!station.enchanting || !info.enchantable || isEnchanted(s) || !g.enchantmentEffects) return null;
      const weapon = info.type === "WEAP";
      const effects = this.validEnchantment(ctx, g.enchantmentEffects, weapon);
      soul = effects ? this.takeSoul(souls, weapon ? g.maxCharge || 0 : Infinity) : null;
      if (!effects || !soul) return null;
      out.enchantmentEffects = effects;
      if (weapon) {
        const cap = SOUL_CHARGE[soul.size];
        out.maxCharge = g.maxCharge && g.maxCharge > 0 ? Math.min(g.maxCharge, cap) : cap;
        out.chargePercent = Math.max(Math.min(typeof g.chargePercent === "number" ? g.chargePercent : out.maxCharge, out.maxCharge), MIN_CHARGE);
      } else {
        delete out.maxCharge;
        delete out.chargePercent;
      }
      const name = cleanName(g.name, this.conditionTag);
      if (name) out.name = name;
      else delete out.name;
      notes.push(`enchanted with a size ${soul.size} soul`);
    } else if (!sameFloat(s.maxCharge || 0, g.maxCharge || 0)) {
      return null;
    }

    const fromStep = healthStep(s.health);
    const toStep = healthStep(g.health);
    if (toStep !== fromStep) {
      temper = toStep > fromStep ? this.planTemper(ctx, crafter, s.baseId, fromStep, toStep, station, pool, reserve) : null;
      if (!temper) return null;
      out.health = temper.step / 10;
      notes.push(`tempered to ${out.health} (${temper.note})`);
    }

    const fromPoison = s.poisonId || 0;
    const toPoison = g.poisonId || 0;
    const fromUses = s.poisonCount || 0;
    const toUses = g.poisonCount || 0;
    if (fromPoison !== toPoison || fromUses !== toUses) {
      // A poison OnEquip already consumed pays first, so a stale lost line never costs a second one
      const findCredit = (): PoisonCredit | null => credits.find((c) => !c.used && c.baseId === toPoison) || null;
      if (toPoison && toPoison !== fromPoison) {
        if (info.type !== "WEAP" || !this.isPoison(ctx, toPoison)) return null;
        credit = findCredit();
        if (!credit && !this.reserveUnit(pool, reserve, (e) => (e.baseId >>> 0) === toPoison && !isSet(e.poisonId))) return null;
        out.poisonId = toPoison;
        out.poisonCount = Math.max(1, Math.min(toUses || 1, MAX_POISON_USES));
        notes.push(`${fromPoison ? "poison replaced with" : "poisoned with"} ${hex(toPoison)}`);
      } else if (fromPoison && toPoison === fromPoison && toUses > fromUses) {
        credit = findCredit() || credits.find((c) => c.baseId === toPoison && (c.raiseUntil || 0) > Date.now()) || null;
        if (!credit) return null;
        out.poisonCount = Math.min(toUses, MAX_POISON_USES);
        notes.push(`poison up to ${out.poisonCount}${credit.used ? " (perk)" : ""}`);
      } else if (fromPoison && !toPoison) {
        delete out.poisonId;
        delete out.poisonCount;
        notes.push("poison used up");
      } else if (fromPoison && toPoison === fromPoison && toUses >= 1 && toUses < fromUses) {
        out.poisonCount = toUses;
        notes.push(`poison down to ${toUses}`);
      } else {
        return null;
      }
    }

    const fullCharge = s.maxCharge || info.baseCharge;
    const hasCharge = info.type === "WEAP" && fullCharge > 0 && (isEnchanted(s) || info.baseEnchantment);
    if (!enchanting && hasCharge && typeof g.chargePercent === "number") {
      const from = typeof s.chargePercent === "number" ? s.chargePercent : fullCharge;
      const to = g.chargePercent;
      if (to < from - 0.5) {
        out.chargePercent = Math.max(to, MIN_CHARGE);
        notes.push(`charge down to ${Math.round(to)}`);
      } else if (to > from + 0.5) {
        soul = this.takeSoul(souls, (to - from) / RECHARGE_MARGIN);
        if (!soul) return null;
        out.chargePercent = Math.min(to, fullCharge, from + SOUL_CHARGE[soul.size] * RECHARGE_MARGIN);
        notes.push(`recharged with a size ${soul.size} soul`);
      }
    }

    // A craft never repairs: the result keeps the wear of the server copy, whatever the report says
    if (typeof s.condition === "number") out.condition = s.condition;
    else delete out.condition;

    return notes.length ? { entry: out, reserve, soul, credit, temper, notes } : null;
  }

  // The engine poisons the right hand weapon, else the left, so the server's copy of it takes the poison OnEquip consumed
  private applyPoisonToWorn(ctx: SystemContext, actorId: number, poisonId: number): void {
    const mp = ctx.svr as Mp;
    const extras = (i: Item): string => `${hex(i.baseId)} {${describeExtras(i).join(", ")}}`;
    const skip = (why: string): void => this.log(`[crafted] ${hex(actorId)}: poison ${hex(poisonId)} not applied at apply, ${why}`);
    try {
      const worn: InventoryEntry[] = (mp.get(actorId, "equipment")?.inv?.entries || [])
        .filter((e: InventoryEntry) => this.itemInfo(ctx, e.baseId).type === "WEAP");
      const hand = worn.find((e) => e.worn) || worn.find((e) => e.wornLeft);
      if (!hand) return skip("no worn weapon");
      const inv = readInventory(mp, actorId);
      const bare = (i: Item): Item => ({ ...i, poisonId: undefined, poisonCount: undefined });
      // Of copies that differ only by wear the worn one is the one at the equipment entry's condition
      const order = byNearestCondition(inv.entries, hand.condition);
      let index = order.find((i) => sameItem(inv.entries[i], hand)) ?? -1;
      if (index < 0) index = order.find((i) => !isSet(inv.entries[i].poisonId) && sameItem(bare(inv.entries[i]), bare(hand))) ?? -1;
      if (index < 0) return skip(`no inventory copy of worn ${extras(hand)}`);
      const source = inv.entries[index];
      if ((source.poisonId || 0) === poisonId) return skip(`${extras(source)} already carries it`);
      const credit = this.creditsOf(actorId).find((c) => !c.used && c.baseId === poisonId);
      if (!credit) return skip(`no credit for ${extras(source)}`);

      const entries = inv.entries.map((e, i) => (i === index ? withCount(e, e.count - 1) : e)).filter((e) => e.count > 0);
      mp.set(actorId, "inventory", addEntries({ entries }, [{ ...withCount(source, 1), poisonId, poisonCount: 1 }]));
      credit.used = true;
      credit.raiseUntil = Date.now() + POISON_RAISE_MS;
      this.log(`[crafted] ${hex(actorId)} ${hex(source.baseId)}: poisoned at apply with ${hex(poisonId)}`);
    } catch (e) {
      this.log(`[crafted] poisoning the worn weapon of ${hex(actorId)} failed: ${e}`);
    }
  }

  // The craft hook runs before the native tempers, so whether it did is read from the copies when the report comes
  private noteNativeTemper(ctx: SystemContext, actorId: number, baseId: number, recipeId: number): void {
    const mp = ctx.svr as Mp;
    if (!temperRecipesOf(mp, baseId, this.log).some((r) => r.id === recipeId)) return;
    const now = Date.now();
    const list = (this.nativeTempers.get(actorId) || []).filter((t) => now - t.at < NATIVE_TEMPER_MS);
    list.push({ baseId, at: now, steps: temperSteps(readInventory(mp, actorId), baseId) });
    this.nativeTempers.set(actorId, list.slice(-MAX_NATIVE_TEMPERS));
  }

  // True once per temper the native craft just recorded, for a line that claims a temper of that item: the report predates that craft's inventory
  private takeNativeTemper(actorId: number, inv: Inventory, g: InventoryEntry, pool: PoolEntry[]): boolean {
    const noted = this.nativeTempers.get(actorId);
    if (!noted || healthStep(g.health) <= 10) return false;
    if (pool.some((p) => p.left > 0 && sameBase(p.entry, g) && healthStep(p.entry.health) === healthStep(g.health))) return false;
    const now = Date.now();
    const list = noted.filter((t) => now - t.at < NATIVE_TEMPER_MS);
    const at = list.findIndex((t) => t.baseId === (g.baseId >>> 0) && temperSteps(inv, g.baseId) > t.steps);
    if (at !== -1) list.splice(at, 1);
    if (list.length) this.nativeTempers.set(actorId, list);
    else this.nativeTempers.delete(actorId);
    return at !== -1;
  }

  // A temper this system records raises the steps as well, so older notes of the item no longer tell the two apart
  private forgetNativeTempers(actorId: number, baseId: number): void {
    const list = (this.nativeTempers.get(actorId) || []).filter((t) => t.baseId !== (baseId >>> 0));
    if (list.length) this.nativeTempers.set(actorId, list);
    else this.nativeTempers.delete(actorId);
  }

  // Something vanilla pays for (an enchantment, tempering, a new poison) rather than wear from use or Soul Siphon charge
  private isCraftClaim(g: InventoryEntry, pool: PoolEntry[]): boolean {
    const sources = pool.filter((p) => sameBase(p.entry, g)).map((p) => p.entry);
    return (isSet(g.enchantmentEffects) && !sources.some((s) => sameEffects(s.enchantmentEffects, g.enchantmentEffects))) ||
      healthStep(g.health) > Math.max(10, ...sources.map((s) => healthStep(s.health))) ||
      (isSet(g.poisonId) && !sources.some((s) => s.poisonId === g.poisonId));
  }

  // Smallest unused soul worth at least the charge, else the largest; the caller clamps to what it gives
  private takeSoul(souls: SoulSource[], charge: number): SoulSource | null {
    const free = souls.filter((s) => !s.used);
    if (!free.length) return null;
    const covering = free.filter((s) => SOUL_CHARGE[s.size] >= charge * (1 - 1e-3));
    const pool = covering.length ? covering : free;
    return pool.reduce((a, b) => ((covering.length ? b.size < a.size : b.size > a.size) ? b : a));
  }

  private reserveUnit(pool: PoolEntry[], reserve: Reservation[], fits: (e: InventoryEntry) => boolean, count = 1): boolean {
    const picked: Reservation[] = [];
    let need = count;
    for (const p of pool) {
      const held = reserve.filter((r) => r.pool === p).reduce((n, r) => n + r.count, 0);
      const free = p.left - held;
      if (need <= 0 || free <= 0 || !fits(p.entry)) continue;
      const n = Math.min(need, free);
      picked.push({ pool: p, count: n });
      need -= n;
    }
    if (need > 0) return false;
    reserve.push(...picked);
    return true;
  }

  // The first recipe this station offers for the item that the pool, the crafter's rank and their fatigue bar can pay
  private planTemper(ctx: SystemContext, crafter: Crafter, baseId: number, fromStep: number, toStep: number, station: Station, pool: PoolEntry[], reserve: Reservation[]): Temper | null {
    const refusals = new Set<TemperRefusal>();
    for (const recipe of recipesAt(ctx.svr, baseId, station.temperBenches, this.log)) {
      const trial = [...reserve];
      if (!recipe.inputs.every((input) =>
        this.reserveUnit(pool, trial, (e) => (e.baseId >>> 0) === input.id && !isSet(e.enchantmentEffects), input.count))) continue;
      if (!this.temperRules) {
        reserve.splice(0, reserve.length, ...trial);
        return { recipe, step: Math.min(toStep, LEGENDARY_STEP), capped: false, price: null, note: `recipe ${hex(recipe.id)}` };
      }
      // Null when the recipe asks for a rank marker the crafter does not hold
      const cap = this.mastery.temperCap(ctx, crafter.actorId, recipe.id);
      const step = cap ? Math.min(toStep, temperCapStep(cap.rank)) : 0;
      if (!cap || step <= fromStep) {
        refusals.add("rank");
        continue;
      }
      const price = this.mastery.craftCost(ctx, crafter.actorId, recipe.id);
      if (!this.needs.canPay(crafter.actorId, "craft", price.rank, price.half)) {
        refusals.add("tired");
        continue;
      }
      reserve.splice(0, reserve.length, ...trial);
      const note = `recipe ${hex(recipe.id)}, cap ${RANK_NAMES[cap.rank]}${cap.profession ? ` ${cap.profession}` : ""}${step < toStep ? `, asked ${toStep / 10}` : ""}`;
      return { recipe, step, capped: step < toStep, price: { rank: price.rank, half: price.half }, note };
    }
    refusals.forEach((r) => crafter.refusals.add(r));
    return null;
  }

  // Effects of a player enchantment, clamped to twice the strongest plugin enchantment of the same kind
  private validEnchantment(ctx: SystemContext, effects: EnchantmentEffect[], weapon: boolean): EnchantmentEffect[] | null {
    if (effects.length > MAX_EFFECTS || new Set(effects.map((e) => e.effectId)).size !== effects.length) return null;
    const caps = this.enchantmentCaps(ctx);
    const out: EnchantmentEffect[] = [];
    for (const e of effects) {
      const cap = caps.get((weapon ? "w" : "a") + (e.effectId >>> 0));
      if (!cap) return null;
      const clamped: EnchantmentEffect = {
        effectId: e.effectId >>> 0,
        magnitude: Math.min(e.magnitude, cap.magnitude * ENCHANT_MARGIN),
        area: Math.min(e.area, Math.floor(cap.area * ENCHANT_MARGIN)),
        duration: Math.min(e.duration, Math.floor(cap.duration * ENCHANT_MARGIN)),
        cost: e.cost,
      };
      const estimate = formulaCost(this.baseCostOf(ctx, clamped.effectId), clamped);
      if (estimate > 0) {
        clamped.cost = Math.min(Math.max(e.cost, estimate * COST_BAND[0]), estimate * COST_BAND[1]);
      }
      out.push(clamped);
    }
    return out;
  }

  // The crafting furniture, when the player is at it
  private stationOf(ctx: SystemContext, actorId: number, workbenchId: number): Station {
    if (!workbenchId) return NO_STATION;
    const mp = ctx.svr as Mp;
    try {
      if (mp.get(workbenchId, "worldOrCellDesc") !== mp.get(actorId, "worldOrCellDesc")) return NO_STATION;
      const a = mp.getActorPos(actorId);
      const b = mp.get(workbenchId, "pos");
      const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (!(d2 <= STATION_RANGE * STATION_RANGE)) return NO_STATION;
      const res = this.lookup(ctx, mp.getIdFromDesc(String(mp.get(workbenchId, "baseDesc"))) >>> 0);
      if (!res || res.record.type !== "FURN") return NO_STATION;
      const wbdt = this.fieldData(res, "WBDT");
      const bench = wbdt && wbdt.byteLength ? wbdt[0] : 0;
      return {
        enchanting: bench === BENCH_ENCHANTING || bench === BENCH_ENCHANTING_EXPERIMENT,
        temperBenches: bench === BENCH_SMITHING_WEAPON || bench === BENCH_SMITHING_ARMOR ? espmFieldFormIds(res, "KWDA") : [],
      };
    } catch {
      return NO_STATION;
    }
  }

  private itemInfo(ctx: SystemContext, baseId: number): ItemInfo {
    const hit = this.itemCache.get(baseId >>> 0);
    if (hit) return hit;
    const res = this.lookup(ctx, baseId);
    const type = res ? String(res.record.type) : "";
    const eitm = readFormIdField(res, "EITM");
    let baseEnchantment = 0;
    try { baseEnchantment = eitm ? res.toGlobalRecordId(eitm) >>> 0 : 0; } catch { baseEnchantment = eitm; }
    const eamt = type === "WEAP" ? this.fieldData(res, "EAMT") : null;
    const info: ItemInfo = {
      type,
      baseEnchantment,
      baseCharge: eamt && eamt.byteLength >= 2 ? viewOf(eamt).getUint16(0, true) : 0,
      enchantable: (type === "WEAP" || type === "ARMO") && !baseEnchantment &&
        !this.keywordsOf(ctx, baseId).includes(KEYWORD_DISALLOW_ENCHANTING),
    };
    this.itemCache.set(baseId >>> 0, info);
    return info;
  }

  // Soul size a gem copy holds: its soul extra, or the soul of a filled base form
  private soulIn(ctx: SystemContext, e: InventoryEntry): number {
    const res = this.lookup(ctx, e.baseId);
    if (!res || res.record.type !== "SLGM") return 0;
    if (e.soul) return Math.min(e.soul, 5);
    const soul = this.fieldData(res, "SOUL");
    return soul && soul.byteLength ? Math.min(soul[0], 5) : 0;
  }

  private isPoison(ctx: SystemContext, id: number): boolean {
    const res = this.lookup(ctx, id);
    const enit = res && res.record.type === "ALCH" ? this.fieldData(res, "ENIT") : null;
    return !!enit && enit.byteLength >= 8 && (viewOf(enit).getUint32(4, true) & FLAG_POISON) !== 0;
  }

  private baseCostOf(ctx: SystemContext, mgefId: number): number {
    const data = this.fieldData(this.lookup(ctx, mgefId), "DATA");
    return data && data.byteLength >= 8 ? viewOf(data).getFloat32(4, true) : 0;
  }

  private keywordsOf(ctx: SystemContext, formId: number): number[] {
    const hit = this.keywordCache.get(formId >>> 0);
    if (hit) return hit;
    const keywords = espmFieldFormIds(this.lookup(ctx, formId), "KWDA");
    this.keywordCache.set(formId >>> 0, keywords);
    return keywords;
  }

  // Strongest effect of each kind in any plugin enchantment, keyed "w" or "a" plus the MGEF id
  private enchantmentCaps(ctx: SystemContext): Map<string, Cap> {
    if (this.caps) return this.caps;
    const caps = new Map<string, Cap>();
    for (const id of espmRecordIds(ctx.svr, "ENCH", this.log)) {
      const res = this.lookup(ctx, id);
      const enit = this.fieldData(res, "ENIT");
      if (!enit || enit.byteLength < 24) continue;
      const view = viewOf(enit);
      const cast = view.getUint32(8, true);
      const delivery = view.getUint32(16, true);
      if (view.getUint32(20, true) !== ENCH_TYPE_ENCHANTMENT) continue;
      const kind = cast === 1 && delivery === 1 ? "w" : cast === 0 && delivery === 0 ? "a" : "";
      if (!kind) continue;
      let effect = 0;
      for (const f of res.record.fields || []) {
        if (!(f.data instanceof Uint8Array)) continue;
        if (f.type === "EFID" && f.data.byteLength >= 4) {
          try { effect = res.toGlobalRecordId(viewOf(f.data).getUint32(0, true)) >>> 0; } catch { effect = 0; }
        } else if (f.type === "EFIT" && effect && f.data.byteLength >= 12) {
          const v = viewOf(f.data);
          const key = kind + effect;
          const cap = caps.get(key) || { magnitude: 0, area: 0, duration: 0 };
          caps.set(key, {
            magnitude: Math.max(cap.magnitude, v.getFloat32(0, true)),
            area: Math.max(cap.area, v.getUint32(4, true)),
            duration: Math.max(cap.duration, v.getUint32(8, true)),
          });
        }
      }
    }
    this.caps = caps;
    this.log(`[crafted] ${caps.size} enchantment effects known`);
    return caps;
  }

  // Unused or still raisable, unexpired credits; the live list, so a committed plan marks its credit used
  private creditsOf(actorId: number): PoisonCredit[] {
    const now = Date.now();
    const list = (this.poisonCredits.get(actorId) || []).filter((c) => (!c.used || (c.raiseUntil || 0) > now) && now - c.at < POISON_CREDIT_MS);
    if (list.length) this.poisonCredits.set(actorId, list);
    else this.poisonCredits.delete(actorId);
    return list;
  }

  private addPoisonCredit(actorId: number, baseId: number): void {
    const list = this.creditsOf(actorId);
    list.push({ baseId, at: Date.now(), used: false });
    this.poisonCredits.set(actorId, list.slice(-MAX_POISON_CREDITS));
  }

  private notify(ctx: SystemContext, userId: number, text: string): void {
    const now = Date.now();
    if (now - (this.lastNoticeAt.get(userId) || 0) < NOTICE_GAP_MS) return;
    this.lastNoticeAt.set(userId, now);
    this.send(ctx, userId, { customPacketType: NOTICE_PACKET, text });
  }

  private send(ctx: SystemContext, userId: number, content: Record<string, unknown>): void {
    try {
      if (userId >= 0 && userId < INVALID_USER_ID) {
        ctx.svr.sendCustomPacket(userId, JSON.stringify(content));
      }
    } catch { /* offline */ }
  }

  private fieldData(res: any, type: string): Uint8Array | null {
    const fields = res && res.record && Array.isArray(res.record.fields) ? res.record.fields : [];
    const f = fields.find((x: any) => x && x.type === type && x.data instanceof Uint8Array);
    return f ? f.data : null;
  }

  private lookup(ctx: SystemContext, formId: number): any {
    if (!formId) return null;
    try {
      const res = (ctx.svr as Mp).lookupEspmRecordById(formId >>> 0);
      return res && res.record ? res : null;
    } catch {
      return null;
    }
  }

  private temperRules = true;
  private conditionTag: RegExp | null = null;
  private lastReportAt = new Map<number, number>();
  private lastNoticeAt = new Map<number, number>();
  private poisonCredits = new Map<number, PoisonCredit[]>();
  private nativeTempers = new Map<number, NativeTemper[]>();
  private itemCache = new Map<number, ItemInfo>();
  private keywordCache = new Map<number, number[]>();
  private caps: Map<string, Cap> | null = null;
}

// Exported for unit testing of the name rules.
export const __test = { cleanName, temperRulesOn };
