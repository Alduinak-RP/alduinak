import { System, Log, SystemContext, Content } from "./system";
import { espmFieldFormIds, readFormIdField, toFormId } from "./formIdUtil";
import {
  EnchantmentEffect, Inventory, InventoryEntry, addEntries, copyValidExtras, describeExtras, healthStep,
  isEnchanted, isSet, readInventory, sameBase, sameEffects, sameFloat, sameItem, withCount,
} from "./inventoryExtras";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Crafted extras: what players make on their own items in vanilla (enchanting, tempering, recharging, poisoning a
// weapon, and the charge and poison that hits use up) becomes part of the server inventory, so it persists and moves
// with the item. The client reports how its inventory differs from the server's; the server accepts a change only when
// it can pay for it from its own copies (the item, a filled soul gem, the temper materials, the poison), clamps it to
// vanilla limits and never creates an extra from nothing. Soul gems filling up is left to the soul trap system.
//
// Client -> Server: { customPacketType: "craftedExtras", workbench, gained: Entry[], lost: Entry[] }
//   gained: local copies the server lacks; lost: server copies the player no longer has (the sources and inputs)
//   workbench: remote id of the crafting furniture the player used last, 0 if none
// Server -> Client: { customPacketType: "notification", text } when a crafted change is refused

const PACKET = "craftedExtras";
const NOTICE_PACKET = "notification";
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
// Legendary; vanilla has no bound beyond it only through potion loops
const MAX_HEALTH_STEP = 16;
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

interface Cap {
  magnitude: number;
  area: number;
  duration: number;
}

interface TemperRecipe {
  bench: number;
  inputs: { id: number; count: number }[];
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

interface Plan {
  entry: InventoryEntry;
  reserve: Reservation[];
  soul: SoulSource | null;
  notes: string[];
}

const NO_STATION: Station = { enchanting: false, temperBenches: [] };
const hex = (id: number): string => (id >>> 0).toString(16);
const viewOf = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const chargeOf = (e: InventoryEntry): number => (typeof e.chargePercent === "number" ? e.chargePercent : 0);

// Creation Kit effect cost; area is ignored, as it is for every vanilla enchantment
const formulaCost = (baseCost: number, e: EnchantmentEffect): number =>
  baseCost * Math.pow(Math.max(e.magnitude, 1), 1.1) * Math.pow(Math.max(e.duration / 10, 1), 1.1);

const cleanName = (name: unknown): string | undefined => {
  if (typeof name !== "string") return undefined;
  const text = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(TEMPER_SUFFIX, "").trim().slice(0, 128);
  return text || undefined;
};

export class CraftedExtrasSystem implements System {
  systemName = "CraftedExtrasSystem";

  constructor(private log: Log) { }

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

    const added: InventoryEntry[] = [];
    let refused = false;
    for (const g of gained) {
      if (emptiedGems.has(g)) continue;
      for (let unit = 0; unit < Math.min(g.count, MAX_UNITS); unit++) {
        const plan = this.findPlan(ctx, g, pool, souls, station);
        if (!plan) {
          refused = refused || this.isCraftClaim(g, pool);
          break;
        }
        this.commit(plan, added);
        this.log(`[crafted] ${hex(actorId)} ${hex(plan.entry.baseId)}: ${plan.notes.join(", ")} {${describeExtras(plan.entry).join(", ")}}`);
      }
    }

    if (added.length) {
      const counts = inv.entries.map((e) => e.count);
      for (const p of pool) counts[p.index] -= p.claimed - p.left;
      const rest: Inventory = { entries: inv.entries.map((e, j) => ({ ...e, count: counts[j] })).filter((e) => e.count > 0) };
      mp.set(actorId, "inventory", addEntries(rest, added));
    }
    if (refused) {
      this.notify(ctx, userId, "The server did not accept that change to your item, so it keeps its previous state.");
    }
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

  // Each lost line claims the server's own copies: the same copy first, then any copy of the same item
  private resolveLost(inv: Inventory, lost: InventoryEntry[]): PoolEntry[] {
    const avail = inv.entries.map((e) => e.count);
    const pool: PoolEntry[] = [];
    for (const l of lost) {
      let need = l.count;
      const take = (fits: (e: InventoryEntry) => boolean): void => {
        inv.entries.forEach((e, index) => {
          if (need <= 0 || avail[index] <= 0 || !fits(e)) return;
          const n = Math.min(need, avail[index]);
          avail[index] -= n;
          need -= n;
          pool.push({ index, entry: e, claimed: n, left: n });
        });
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

  private findPlan(ctx: SystemContext, g: InventoryEntry, pool: PoolEntry[], souls: SoulSource[], station: Station): Plan | null {
    for (const p of pool) {
      if (p.left <= 0 || !sameBase(p.entry, g)) continue;
      const plan = this.plan(ctx, p, g, pool, souls, station);
      if (plan) return plan;
    }
    return null;
  }

  private commit(plan: Plan, added: InventoryEntry[]): void {
    for (const r of plan.reserve) r.pool.left -= r.count;
    if (plan.soul) {
      plan.soul.used = true;
      plan.soul.from.left -= 1;
      if (plan.soul.emptied) added.push(plan.soul.emptied);
    }
    added.push(plan.entry);
  }

  // The server copy source becoming g, paid for from the pool; null when vanilla could not have made it
  private plan(ctx: SystemContext, source: PoolEntry, g: InventoryEntry, pool: PoolEntry[], souls: SoulSource[], station: Station): Plan | null {
    const s = source.entry;
    const info = this.itemInfo(ctx, s.baseId);
    const out = withCount(s, 1);
    const reserve: Reservation[] = [{ pool: source, count: 1 }];
    const notes: string[] = [];
    let soul: SoulSource | null = null;

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
      const name = cleanName(g.name);
      if (name) out.name = name;
      else delete out.name;
      notes.push(`enchanted with a size ${soul.size} soul`);
    } else if (!sameFloat(s.maxCharge || 0, g.maxCharge || 0)) {
      return null;
    }

    const fromStep = healthStep(s.health);
    const toStep = healthStep(g.health);
    if (toStep !== fromStep) {
      if (toStep < fromStep || !this.reserveTemper(ctx, s.baseId, station, pool, reserve)) return null;
      out.health = Math.min(toStep, MAX_HEALTH_STEP) / 10;
      notes.push(`tempered to ${out.health}`);
    }

    const fromPoison = s.poisonId || 0;
    const toPoison = g.poisonId || 0;
    const fromUses = s.poisonCount || 0;
    const toUses = g.poisonCount || 0;
    if (fromPoison !== toPoison || fromUses !== toUses) {
      if (!fromPoison && toPoison) {
        const poison = info.type === "WEAP" && this.isPoison(ctx, toPoison)
          ? this.reserveUnit(pool, reserve, (e) => (e.baseId >>> 0) === toPoison && !isSet(e.poisonId))
          : false;
        if (!poison) return null;
        out.poisonId = toPoison;
        out.poisonCount = Math.max(1, Math.min(toUses || 1, MAX_POISON_USES));
        notes.push(`poisoned with ${hex(toPoison)}`);
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

    return notes.length ? { entry: out, reserve, soul, notes } : null;
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

  // Materials of a temper recipe this station offers for the item
  private reserveTemper(ctx: SystemContext, baseId: number, station: Station, pool: PoolEntry[], reserve: Reservation[]): boolean {
    for (const recipe of this.temperRecipes(ctx).get(baseId >>> 0) || []) {
      if (!station.temperBenches.includes(recipe.bench)) continue;
      const trial = [...reserve];
      const ok = recipe.inputs.every((input) =>
        this.reserveUnit(pool, trial, (e) => (e.baseId >>> 0) === input.id && !isSet(e.enchantmentEffects), input.count));
      if (ok) {
        reserve.splice(0, reserve.length, ...trial);
        return true;
      }
    }
    return false;
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

  private recordIds(ctx: SystemContext, type: string): number[] {
    const mp = ctx.svr as Mp;
    if (typeof mp.getEspmRecordIdsByType !== "function") {
      this.log(`[crafted] the server native has no getEspmRecordIdsByType, so ${type} records cannot be read`);
      return [];
    }
    try {
      return Array.from(mp.getEspmRecordIdsByType(type) as ArrayLike<number>, (id) => Number(id) >>> 0);
    } catch (e) {
      this.log(`[crafted] reading ${type} records failed: ${e}`);
      return [];
    }
  }

  // Strongest effect of each kind in any plugin enchantment, keyed "w" or "a" plus the MGEF id
  private enchantmentCaps(ctx: SystemContext): Map<string, Cap> {
    if (this.caps) return this.caps;
    const caps = new Map<string, Cap>();
    for (const id of this.recordIds(ctx, "ENCH")) {
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

  // Constructible objects by created item: bench keyword and ingredients
  private temperRecipes(ctx: SystemContext): Map<number, TemperRecipe[]> {
    if (this.recipes) return this.recipes;
    const recipes = new Map<number, TemperRecipe[]>();
    for (const id of this.recordIds(ctx, "COBJ")) {
      const res = this.lookup(ctx, id);
      const toGlobal = (local: number): number => {
        try { return res.toGlobalRecordId(local) >>> 0; } catch { return 0; }
      };
      const created = toGlobal(readFormIdField(res, "CNAM"));
      const bench = toGlobal(readFormIdField(res, "BNAM"));
      if (!created || !bench) continue;
      const inputs: { id: number; count: number }[] = [];
      for (const f of res.record.fields || []) {
        if (f.type !== "CNTO" || !(f.data instanceof Uint8Array) || f.data.byteLength < 8) continue;
        const v = viewOf(f.data);
        const input = toGlobal(v.getUint32(0, true));
        const count = v.getInt32(4, true);
        if (input && count > 0) inputs.push({ id: input, count });
      }
      const list = recipes.get(created) || [];
      list.push({ bench, inputs });
      recipes.set(created, list);
    }
    this.recipes = recipes;
    return recipes;
  }

  private notify(ctx: SystemContext, userId: number, text: string): void {
    const now = Date.now();
    if (now - (this.lastNoticeAt.get(userId) || 0) < NOTICE_GAP_MS) return;
    this.lastNoticeAt.set(userId, now);
    try {
      if (userId >= 0 && userId < INVALID_USER_ID) {
        ctx.svr.sendCustomPacket(userId, JSON.stringify({ customPacketType: NOTICE_PACKET, text }));
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

  private lastReportAt = new Map<number, number>();
  private lastNoticeAt = new Map<number, number>();
  private itemCache = new Map<number, ItemInfo>();
  private keywordCache = new Map<number, number[]>();
  private caps: Map<string, Cap> | null = null;
  private recipes: Map<number, TemperRecipe[]> | null = null;
}
