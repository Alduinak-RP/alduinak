import { Settings } from "../settings";
import { chainMpHook, guardMpHook, hex, isAlive, isBleedingOut, recordTypeOf, userOf, weaponAnimType } from "./actorUtil";
import {
  DurabilityTags, DurableCopy, RepairSettings, SettleWear, conditionTagPattern, durabilityTags, durableCopies, hasDurableCopies, hasSettleWear,
  nativeDurabilityOn, repairSettings, wearSettler,
} from "./durabilityNative";
import { fieldData, view } from "./espmMagic";
import { formIdFromConfig, toFormId } from "./formIdUtil";
import {
  Inventory, InventoryEntry, addEntries, conditionOf, conditionPercent, hasIdentityExtras, healthStep, lineKey, readInventory, sameCondition,
} from "./inventoryExtras";
import { MasterySystem } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";
import { sendJson } from "./playerText";
import { Content, Log, System, SystemContext } from "./system";
import { ARMOR_TABLE, FINE_STEP, SHARPENING_WHEEL, TemperRecipe, qualityName, recipesAt, temperRecipesOf } from "./temperRecipes";
import { every } from "./timers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Durability: repairs at the armor workbench (armor, shields) and the grindstone (weapons, bows, crossbows), the wear notices and the
// client's condition tag settings. Wear itself is the native's (scam_native.node); this system only reads and resets the condition.
//
// Activating a bench while carrying damaged gear of its kind opens the repair menu instead of the bench; its "Improve items" button
// and a bench activated without damaged gear give the vanilla menu. Anyone may repair to 100%; a repair costs the item's temper recipe
// inputs and gives no mastery credit.
//
// The gamemode part 87_repair.js passes the chat command to globalThis.__alduinakRepairOpen(actorId), which returns the line to show
// when no menu opened. The function exists only while repairs are on, so without it the command stays unknown.
//
// server-settings.json, alduinakDamageFormulaSettings.durability:
//   enabled                         true switches the system on; it needs a scam_native.node with getDurability
//   nameTag.showAtFull, brokenLabel sent to the client as durabilityConfig at login
//   repair.unitsPerMissing          {weapon, cuirass, other}: share of the durability one set of materials restores (0.5, 0.5, 1)
//   repair.fallbackMaterial         {kind: {row: form key}}: the material of an item without a temper recipe
//   repair.requireProfessionRank    true asks for the rank the item's temper recipe is gated by (false)
//   repair.fatigue                  crafts of fatigue one repaired item costs (0)
//   repair.anyBench                 true lets either bench repair everything (false)
//   repair.menuOnActivate           false leaves the benches alone, the chat command still opens the menu (true)
//   repair.chatCommand              name of the chat command, empty for none ("repair")
//   repair.lowNoticeBelow           a worn item falling below this share warns its owner (0.25)
//
// Client -> Server packets (the bench of the open menu is kept per user):
//   durabilityRepair  { bench, keys: [key] } or { bench, all: true }
//   durabilityImprove { bench }
//   durabilityClose   {}
// Server -> Client packets:
//   durabilityConfig  { enabled, showAtFull, brokenLabel }
//   repairMenu        { bench, kind, title, reason: "open" | "refresh", rows: [{ key, baseId, name, percent, hp, maxHp, worn, cost: [{ baseId, name, need, have }] }] }
//   repairNotice      { text }

export type BenchKind = "armor" | "weapon";

const BENCH_REACH = 600;
const BYPASS_MS = 5000;
const OPEN_COOLDOWN_MS = 1000;
const REPAIR_COOLDOWN_MS = 300;
const WEAR_POLL_MS = 10000;
const BROKEN_NOTICE_GAP_MS = 30000;
const MAX_KEYS = 64;
const MAX_KEY_LENGTH = 512;
// BOD2 bit of biped slot 32, the body
const BODY_SLOT_BIT = 1 << 2;
const BOW_ANIM_TYPE = 7;
const CROSSBOW_ANIM_TYPE = 9;
// The native's kinds by the bench that repairs them
const KIND_BENCH: Record<string, BenchKind> = { weapon: "weapon", bow: "weapon", crossbow: "weapon", armor: "armor", shield: "armor" };
const BENCH_KEYWORD: Record<BenchKind, number> = { armor: ARMOR_TABLE, weapon: SHARPENING_WHEEL };
const BENCH_NAME: Record<BenchKind, string> = { armor: "Workbench", weapon: "Grindstone" };
const NO_BENCH_LINE = "There is no workbench or grindstone within reach.";

// Material sets a repair costs: one per perUnit of the durability missing, counted on the percent the player sees
export const repairUnits = (percent: number, perUnit: number): number => {
  const missing = (100 - Math.min(100, Math.max(0, percent))) / 100;
  return missing <= 0 ? 0 : Math.max(1, Math.ceil(missing / (perUnit > 0 ? perUnit : 1) - 1e-9));
};

export interface Material {
  baseId: number;
  need: number;
}

// One way to pay a repair: the inputs of a temper recipe, or the fallback material with no recipe
export interface RepairOption {
  recipe: TemperRecipe | null;
  cost: Material[];
}

export interface RepairRow {
  key: string;
  // Index of the copy in the inventory the rows were built from
  index: number;
  entry: InventoryEntry;
  name: string;
  percent: number;
  hp: number;
  maxHp: number;
  worn: boolean;
  // In order of preference, never empty; the first one the pack covers pays
  options: RepairOption[];
}

// A stack that can pay for a repair: a plain, pristine item
const isMaterial = (e: InventoryEntry): boolean => e.count > 0 && !hasIdentityExtras(e) && conditionOf(e) >= 1;

// Plain items of the pack by base id
export const materialsHeld = (inv: Inventory): Map<number, number> => {
  const held = new Map<number, number>();
  for (const e of inv.entries) {
    if (isMaterial(e)) held.set(e.baseId >>> 0, (held.get(e.baseId >>> 0) || 0) + e.count);
  }
  return held;
};

const covers = (held: Map<number, number>, cost: Material[]): boolean => cost.every((m) => (held.get(m.baseId) || 0) >= m.need);

// The option the pack pays, the first one when it covers none
export const optionFor = (row: RepairRow, held: Map<number, number>): RepairOption => row.options.find((o) => covers(held, o.cost)) || row.options[0];

// The handle a client sends back: the copy's identity and its condition, so a copy that wore on in between no longer answers to it
export const rowKey = (e: InventoryEntry): string => `${lineKey(e)}|${Math.round(conditionOf(e) * 1e4)}`;

// The inventory after the repairs: materials taken from plain stacks, the condition cleared on the repaired copies, which rejoin a
// pristine stack of their kind unless worn; null when the pack does not hold the materials
export const applyRepairs = (inv: Inventory, repaired: number[], spent: Map<number, number>): Inventory | null => {
  const entries = inv.entries.map((e) => ({ ...e }));
  for (const [baseId, need] of spent) {
    let left = need;
    for (const e of entries) {
      if (left <= 0) break;
      if ((e.baseId >>> 0) !== baseId || !isMaterial(e)) continue;
      const take = Math.min(left, e.count);
      e.count -= take;
      left -= take;
    }
    if (left > 0) return null;
  }
  const fixed: InventoryEntry[] = [];
  const kept = entries.filter((e, i) => {
    if (repaired.indexOf(i) === -1) return e.count > 0;
    delete e.condition;
    if (e.worn || e.wornLeft) return true;
    fixed.push(e);
    return false;
  });
  return addEntries({ entries: kept }, fixed);
};

interface Session {
  bench: number;
  // Kind of the bench itself, which the title names
  kind: BenchKind;
  // Kinds of gear it repairs: both with repair.anyBench
  kinds: BenchKind[];
}

export class DurabilitySystem implements System {
  systemName = "DurabilitySystem";

  constructor(private log: Log, private mastery: MasterySystem, private needs: NeedsSystem) {}

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings;
    this.tags = durabilityTags(all);
    if (!this.tags.enabled) return;
    if (!hasDurableCopies(mp) && !hasSettleWear(mp)) {
      this.log("[durability] alduinakDamageFormulaSettings.durability.enabled is true but this scam_native.node has no durability (no getDurability, no settleWear): no condition tags, no repairs");
      return;
    }
    this.tagPattern = conditionTagPattern(this.tags.brokenLabel);
    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
      this.sessions.delete(userId);
      if (nativeDurabilityOn(mp, actorId >>> 0)) {
        sendJson(mp, userId, { customPacketType: "durabilityConfig", enabled: true, showAtFull: this.tags.showAtFull, brokenLabel: this.tags.brokenLabel });
      } else if (!this.nativeOffLogged) {
        this.nativeOffLogged = true;
        this.log("[durability] the native runs without durability although the settings enable it (see its alduinakDamageFormulaSettings lines at boot): no condition tags are sent to clients");
      }
    });
    if (!hasDurableCopies(mp)) {
      this.log("[durability] repairs and wear notices are off: this scam_native.node has no getDurability");
      return;
    }
    this.config = repairSettings(all);
    this.settle = wearSettler(mp, all, this.log);
    const unresolved = this.loadFallbackMaterials(mp);
    this.on = true;
    every("durability", WEAR_POLL_MS, () => this.poll(ctx));

    this.installActivationHook(ctx);
    chainMpHook(mp, "onItemBroken", (actorId: number, baseId: number) => { this.onItemBroken(ctx, Number(actorId) >>> 0, Number(baseId) >>> 0); });
    (globalThis as any).__alduinakRepairOpen = (actorId: number): string => this.onCommand(ctx, Number(actorId) >>> 0);

    const c = this.config;
    const pct = (share: number): number => Math.round(share * 100);
    this.log(`[durability] repairs on: ${c.anyBench ? "either bench repairs everything" : "workbench armor and shields, grindstone weapons"}, `
      + `one set of temper materials per ${pct(c.unitsPerMissing.weapon)}% of a weapon, ${pct(c.unitsPerMissing.cuirass)}% of a cuirass, ${pct(c.unitsPerMissing.other)}% of another piece, `
      + `${this.fallbackMaterials.size} fallback materials${unresolved.length ? ` (${unresolved.length} not in the load order: ${unresolved.slice(0, 5).join(", ")})` : ""}, `
      + `${c.requireProfessionRank ? "the recipe's rank is required" : "anyone repairs"}, fatigue ${c.fatigue}, `
      + `${c.menuOnActivate ? "menu on activation" : "no menu on activation"}, ${c.chatCommand ? `/${c.chatCommand}` : "no chat command"}, low notice below ${pct(c.lowNoticeBelow)}%`);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!this.on) return;
    switch (type) {
      case "durabilityRepair": this.onRepair(ctx, userId, content); break;
      case "durabilityImprove": this.onImprove(ctx, userId, content); break;
      case "durabilityClose": this.sessions.delete(userId); break;
      default: break;
    }
  }

  disconnect(userId: number): void {
    this.sessions.delete(userId);
    this.lastOpenMs.delete(userId);
    this.lastRepairMs.delete(userId);
  }

  // The wear notices: a worn item that fell below repair.lowNoticeBelow or broke since the last look
  poll(ctx: SystemContext): void {
    if (!this.on) return;
    const now = Date.now();
    const mp = ctx.svr as Mp;
    let players: number[] = [];
    try { players = Array.from(mp.get(0, "onlinePlayers") ?? [], (id) => Number(id) >>> 0); } catch { return; }
    const online = new Set(players);
    for (const actorId of Array.from(this.wornSeen.keys())) {
      if (!online.has(actorId)) this.wornSeen.delete(actorId);
    }
    for (const actorId of players) this.watchWear(ctx, actorId, now);
  }

  // ── Notices ─────────────────────────────────────────────────────────────────

  private watchWear(ctx: SystemContext, actorId: number, now: number): void {
    const mp = ctx.svr as Mp;
    const copies = durableCopies(mp, actorId) || [];
    const before = this.wornSeen.get(actorId);
    const seen = new Map<string, number>();
    for (const c of copies) {
      if (!c.worn && !c.wornLeft) continue;
      const slot = `${c.baseId}:${c.wornLeft ? "left" : "right"}`;
      seen.set(slot, c.condition);
      const was = before?.get(slot);
      if (was === undefined || c.condition >= was) continue;
      // The copy seen last time still lies in the pack as it was, so another copy took the slot and nothing wore
      if (copies.some((o) => o !== c && o.baseId === c.baseId && sameCondition({ condition: o.condition }, { condition: was }))) continue;
      if (c.condition <= 0) this.noticeBroken(ctx, actorId, c.baseId, now);
      else if (was >= this.config.lowNoticeBelow && c.condition < this.config.lowNoticeBelow) {
        this.notice(mp, userOf(mp, actorId), `Your ${this.baseName(c.baseId)} is badly worn (${conditionPercent(c.condition)}%).`);
      }
    }
    this.wornSeen.set(actorId, seen);
  }

  private onItemBroken(ctx: SystemContext, actorId: number, baseId: number): void {
    if (actorId && baseId) this.noticeBroken(ctx, actorId, baseId, Date.now());
  }

  // Once per item and fight, whichever of the native event and the poll sees the break first
  private noticeBroken(ctx: SystemContext, actorId: number, baseId: number, now: number): void {
    const mp = ctx.svr as Mp;
    const slot = `${actorId}:${baseId}`;
    if (now - (this.brokenNoticedMs.get(slot) || 0) < BROKEN_NOTICE_GAP_MS) return;
    if (this.brokenNoticedMs.size > 4096) this.brokenNoticedMs.clear();
    this.brokenNoticedMs.set(slot, now);
    this.notice(mp, userOf(mp, actorId), `Your ${this.baseName(baseId)} has broken.`);
  }

  private notice(mp: Mp, userId: number, text: string): void {
    sendJson(mp, userId, { customPacketType: "repairNotice", text });
  }

  // ── Opening ─────────────────────────────────────────────────────────────────

  // The repair menu takes the activation of a bench from a player carrying damaged gear of its kind, before the checks of the vanilla bench
  private installActivationHook(ctx: SystemContext): void {
    guardMpHook(ctx.svr as Mp, "onActivate", (targetId: number, casterId: number) => {
      try {
        if (this.onActivate(ctx, targetId >>> 0, casterId >>> 0)) return false;
      } catch (e) {
        this.log(`[durability] activation check failed: ${e}`);
      }
    });
  }

  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const mp = ctx.svr as Mp;
    const bypass = this.bypass.get(casterId);
    if (bypass && bypass.bench === targetId) {
      this.bypass.delete(casterId);
      if (Date.now() < bypass.until) return false;
    }
    if (!this.config.menuOnActivate) return false;
    const userId = userOf(mp, casterId);
    if (userId < 0) return false;
    const session = this.sessionAt(ctx, targetId);
    // A downed or dead player's activation is the other systems' to refuse
    if (!session || !isAlive(mp, casterId) || isBleedingOut(mp, casterId)) return false;
    return this.open(ctx, userId, casterId, session);
  }

  // What the bench repairs, null for anything that is no workbench or grindstone
  private sessionAt(ctx: SystemContext, refrId: number): Session | null {
    const keywords = this.mastery.stationKeywords(ctx, refrId);
    const own = (["armor", "weapon"] as BenchKind[]).filter((k) => keywords.has(BENCH_KEYWORD[k]));
    return own.length ? { bench: refrId, kind: own[0], kinds: this.config.anyBench ? ["armor", "weapon"] : own } : null;
  }

  // False when nothing the player carries needs this bench
  private open(ctx: SystemContext, userId: number, actorId: number, session: Session): boolean {
    const { rows, inv } = this.rowsOf(ctx, actorId, session);
    if (!rows.length) return false;
    this.sessions.set(userId, session);
    this.sendMenu(ctx, userId, session, rows, inv, "open");
    return true;
  }

  // The chat command: the menu of the nearest bench in reach that has work; the returned line is shown when none opened
  private onCommand(ctx: SystemContext, actorId: number): string {
    const mp = ctx.svr as Mp;
    const userId = userOf(mp, actorId);
    if (userId < 0) return "";
    const now = Date.now();
    if (now - (this.lastOpenMs.get(userId) || 0) < OPEN_COOLDOWN_MS) return "";
    this.lastOpenMs.set(userId, now);
    if (!isAlive(mp, actorId) || isBleedingOut(mp, actorId)) return "You cannot repair anything right now.";
    const benches = this.benchesInReach(ctx, actorId);
    if (!benches.length) return NO_BENCH_LINE;
    for (const session of benches) {
      if (this.open(ctx, userId, actorId, session)) return "";
    }
    return "Nothing you carry needs repair at this bench.";
  }

  private benchesInReach(ctx: SystemContext, actorId: number): Session[] {
    const mp = ctx.svr as Mp;
    let near: unknown;
    let pos: number[];
    try {
      pos = mp.get(actorId, "pos");
      near = mp.getNeighborsByPosition(String(mp.get(actorId, "worldOrCellDesc")), pos);
    } catch {
      return [];
    }
    if (!Array.isArray(near)) return [];
    const found: { session: Session; distance: number }[] = [];
    for (const id of near) {
      const refrId = Number(id) >>> 0;
      const distance = refrId ? this.distanceTo(mp, actorId, refrId) : Infinity;
      if (distance > BENCH_REACH) continue;
      const session = this.sessionAt(ctx, refrId);
      if (session) found.push({ session, distance });
    }
    return found.sort((a, b) => a.distance - b.distance).map((f) => f.session);
  }

  // Infinity for another cell or worldspace and for a form without a position
  private distanceTo(mp: Mp, actorId: number, refrId: number): number {
    try {
      if (String(mp.get(actorId, "worldOrCellDesc")) !== String(mp.get(refrId, "worldOrCellDesc"))) return Infinity;
      const a = mp.get(actorId, "pos");
      const b = mp.get(refrId, "pos");
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return Number.isFinite(d) ? d : Infinity;
    } catch {
      return Infinity;
    }
  }

  // ── Rows ────────────────────────────────────────────────────────────────────

  // The damaged copies the bench repairs, worn ones first, then the most worn; the wear of the last fight is written first
  private rowsOf(ctx: SystemContext, actorId: number, session: Session): { rows: RepairRow[]; inv: Inventory } {
    const mp = ctx.svr as Mp;
    this.settle(actorId);
    const inv = readInventory(mp, actorId);
    const copies = durableCopies(mp, actorId) || [];
    let equipped: InventoryEntry[] = [];
    try { equipped = (mp.get(actorId, "equipment")?.inv?.entries || []).filter((e: InventoryEntry) => e && (e.worn || e.wornLeft)); } catch { /* shown as unworn */ }
    const rows: RepairRow[] = [];
    inv.entries.forEach((entry, index) => {
      const percent = conditionPercent(conditionOf(entry));
      if (!(entry.count > 0) || percent >= 100) return;
      const baseId = entry.baseId >>> 0;
      // The native's own entry of this copy, else any copy of the base, which has the same row
      const own = copies.find((c) => c.index === index && c.baseId === baseId) || null;
      const info = own || copies.find((c) => c.baseId === baseId) || null;
      const kind = this.kindOf(mp, baseId, info);
      const bench = KIND_BENCH[kind];
      if (!bench || session.kinds.indexOf(bench) === -1) return;
      const maxHp = Math.round(info?.maxHp || 0);
      const perUnit = bench === "weapon" ? this.config.unitsPerMissing.weapon
        : this.isCuirass(mp, baseId, kind, info) ? this.config.unitsPerMissing.cuirass : this.config.unitsPerMissing.other;
      rows.push({
        key: rowKey(entry),
        index,
        entry,
        name: this.entryName(entry),
        percent,
        hp: percent <= 0 ? 0 : Math.min(maxHp, Math.max(1, Math.round(conditionOf(entry) * maxHp))),
        maxHp,
        worn: entry.worn === true || entry.wornLeft === true
          || (own ? own.worn || own.wornLeft : equipped.some((w) => (w.baseId >>> 0) === baseId && sameCondition(w, entry))),
        options: this.optionsOf(mp, baseId, bench, kind, info, repairUnits(percent, perUnit) * entry.count),
      });
    });
    rows.sort((a, b) => Number(b.worn) - Number(a.worn) || a.percent - b.percent || a.name.localeCompare(b.name));
    return { rows, inv };
  }

  // The native's kind, else the record's: weapon, bow, crossbow or armor; "" for anything else
  private kindOf(mp: Mp, baseId: number, info: DurableCopy | null): string {
    if (info && KIND_BENCH[info.kind]) return info.kind;
    const type = recordTypeOf(mp, baseId);
    if (type === "ARMO") return "armor";
    if (type !== "WEAP") return "";
    const anim = weaponAnimType(mp, baseId);
    return anim === BOW_ANIM_TYPE ? "bow" : anim === CROSSBOW_ANIM_TYPE ? "crossbow" : "weapon";
  }

  private isCuirass(mp: Mp, baseId: number, kind: string, info: DurableCopy | null): boolean {
    if (kind !== "armor") return false;
    if (info && info.cuirass !== null) return info.cuirass;
    const hit = this.cuirassCache.get(baseId);
    if (hit !== undefined) return hit;
    let body = false;
    try {
      const rec = mp.lookupEspmRecordById(baseId);
      const bod = fieldData(rec, "BOD2") || fieldData(rec, "BODT");
      body = !!bod && bod.byteLength >= 4 && (view(bod).getUint32(0, true) & BODY_SLOT_BIT) !== 0;
    } catch { /* counted as another piece */ }
    this.cuirassCache.set(baseId, body);
    return body;
  }

  // The item's temper recipes at its own bench first, then at the other; without one the fallback material of its row, else a free repair
  private optionsOf(mp: Mp, baseId: number, bench: BenchKind, kind: string, info: DurableCopy | null, units: number): RepairOption[] {
    const row = info?.row || "";
    const own = recipesAt(mp, baseId, [BENCH_KEYWORD[bench]], this.log);
    const recipes = (own.length ? own : temperRecipesOf(mp, baseId, this.log)).filter((r) => r.inputs.length);
    if (recipes.length) return recipes.map((recipe) => ({ recipe, cost: recipe.inputs.map((i) => ({ baseId: i.id >>> 0, need: i.count * units })) }));
    const material = info?.fallbackMaterial || this.fallbackMaterials.get(`${kind === "shield" ? "armor" : kind}/${row}`) || this.fallbackMaterials.get(`/${row}`) || 0;
    if (!material && !this.freeLogged.has(baseId)) {
      this.freeLogged.add(baseId);
      this.log(`[durability] ${hex(baseId)} (${this.baseName(baseId)}) has no temper recipe and no repair.fallbackMaterial for ${kind} row "${row}": it is repaired for free`);
    }
    return [{ recipe: null, cost: material ? [{ baseId: material, need: units }] : [] }];
  }

  // Form ids of repair.fallbackMaterial by "kind/row"; returns the keys that are not in the load order
  private loadFallbackMaterials(mp: Mp): string[] {
    const unresolved: string[] = [];
    for (const [kind, rows] of Object.entries(this.config.fallbackMaterial)) {
      for (const [row, key] of Object.entries(rows)) {
        const id = formIdFromConfig(mp, key);
        if (id && recordTypeOf(mp, id)) this.fallbackMaterials.set(`${kind}/${row}`, id);
        else unresolved.push(`${kind || "any"} ${row} ${key}`);
      }
    }
    return unresolved;
  }

  private baseName(baseId: number): string {
    return String((globalThis as any).__alduinakItemName?.(baseId) || "") || `item ${hex(baseId)}`;
  }

  // "Steel Sword (Superior)", "Steel Sword x2": the copy's own name without its condition tag, the temper quality after it
  private entryName(entry: InventoryEntry): string {
    let name = typeof entry.name === "string" ? entry.name.trim() : "";
    while (this.tagPattern.test(name)) name = name.replace(this.tagPattern, "");
    name ||= this.baseName(entry.baseId);
    const quality = qualityName(healthStep(entry.health));
    if (healthStep(entry.health) >= FINE_STEP && quality && !name.endsWith(`(${quality})`)) name += ` (${quality})`;
    return entry.count > 1 ? `${name} x${entry.count}` : name;
  }

  private sendMenu(ctx: SystemContext, userId: number, session: Session, rows: RepairRow[], inv: Inventory, reason: "open" | "refresh"): void {
    const held = materialsHeld(inv);
    const what = session.kinds.length > 1 ? "gear" : session.kinds[0] === "armor" ? "armor" : "weapons";
    sendJson(ctx.svr, userId, {
      customPacketType: "repairMenu",
      bench: session.bench,
      kind: session.kind,
      title: `${BENCH_NAME[session.kind]}: repair ${what}`,
      reason,
      rows: rows.map((r) => ({
        key: r.key,
        baseId: r.entry.baseId >>> 0,
        name: r.name,
        percent: r.percent,
        hp: r.hp,
        maxHp: r.maxHp,
        worn: r.worn,
        cost: optionFor(r, held).cost.map((m) => ({ baseId: m.baseId, name: this.baseName(m.baseId), need: m.need, have: held.get(m.baseId) || 0 })),
      })),
    });
  }

  // ── Repair ──────────────────────────────────────────────────────────────────

  // The session of the user when the packet names its bench and the player still stands at it
  private sessionOf(ctx: SystemContext, userId: number, actorId: number, content: Content): Session | null {
    const session = this.sessions.get(userId);
    if (!session || toFormId(content["bench"]) !== session.bench) return null;
    if (this.distanceTo(ctx.svr, actorId, session.bench) <= BENCH_REACH) return session;
    this.notice(ctx.svr, userId, "You are too far from the bench.");
    return null;
  }

  private onRepair(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = mp.getUserActor(userId) >>> 0; } catch { return; }
    const now = Date.now();
    if (!actorId || now - (this.lastRepairMs.get(userId) || 0) < REPAIR_COOLDOWN_MS) return;
    this.lastRepairMs.set(userId, now);
    const session = this.sessionOf(ctx, userId, actorId, content);
    if (!session) return;
    const { rows, inv } = this.rowsOf(ctx, actorId, session);
    const keys: unknown[] = Array.isArray(content["keys"]) ? content["keys"].slice(0, MAX_KEYS) : [];
    const all = content["all"] === true;
    const asked = all ? rows : keys.map((k) => rows.find((r) => typeof k === "string" && k.length <= MAX_KEY_LENGTH && r.key === k));
    const wanted = asked.filter((r, i): r is RepairRow => !!r && asked.indexOf(r) === i);

    const held = materialsHeld(inv);
    const spent = new Map<number, number>();
    const done: { row: RepairRow; cost: Material[] }[] = [];
    const refusals: string[] = [];
    const slot = this.mastery.craftSlot(ctx, actorId, BENCH_KEYWORD[session.kind]);
    const half = this.mastery.halfCostBench(BENCH_KEYWORD[session.kind]);
    for (const row of wanted) {
      const option = optionFor(row, held);
      const short = option.cost.filter((m) => (held.get(m.baseId) || 0) < m.need);
      if (short.length) {
        refusals.push(`You lack ${short.map((m) => `${m.need - (held.get(m.baseId) || 0)} ${this.baseName(m.baseId)}`).join(" and ")} to repair ${row.name}.`);
      } else if (this.config.requireProfessionRank && option.recipe && !this.mastery.temperCap(ctx, actorId, option.recipe.id)) {
        refusals.push(`You lack the profession rank to repair ${row.name}.`);
      } else if (this.config.fatigue > 0 && !this.needs.canPay(actorId, "craft", slot.rank, half, this.config.fatigue * (done.length + 1))) {
        refusals.push(`You are too tired to repair ${row.name}.`);
      } else {
        for (const m of option.cost) {
          held.set(m.baseId, (held.get(m.baseId) || 0) - m.need);
          spent.set(m.baseId, (spent.get(m.baseId) || 0) + m.need);
        }
        done.push({ row, cost: option.cost });
      }
    }
    if (asked.length > wanted.length && !all) refusals.push("That item is no longer in the condition shown.");

    const repaired = done.length ? applyRepairs(inv, done.map((d) => d.row.index), spent) : null;
    if (repaired) {
      try {
        mp.set(actorId, "inventory", repaired);
      } catch (e) {
        this.log(`[durability] repair of ${hex(actorId)} failed, nothing was taken: ${e}`);
        return this.notice(mp, userId, "The repair failed, nothing was taken.");
      }
      // After the write, so the native can take the repaired condition for the worn entries at once
      this.settle(actorId);
      if (this.config.fatigue > 0) this.needs.pay(ctx, actorId, "craft", slot.rank, `repair of ${done.length} item(s)`, half, this.config.fatigue * done.length);
      for (const d of done) {
        this.log(`[durability] ${hex(actorId)} repaired ${hex(d.row.entry.baseId)} (${d.row.name}) ${d.row.percent}% -> 100% for ${this.costText(d.cost, "x", ", ") || "nothing"}`);
      }
    }
    const paid = done.length === 1 ? this.costText(done[0].cost, "", " and ") : "";
    const fixed = !repaired ? "" : done.length === 1 ? `Repaired ${done[0].row.name}${paid ? ` for ${paid}` : ""}.` : `Repaired ${done.length} items.`;
    const refused = refusals.length > 1 && all ? `${refusals.length} items were left: ${refusals[0]}` : refusals[0] || "";
    const text = [fixed, refused].filter(Boolean).join(" ");
    if (text) this.notice(mp, userId, text);
    const after = this.rowsOf(ctx, actorId, session);
    this.sendMenu(ctx, userId, session, after.rows, after.inv, "refresh");
  }

  // "2x Steel Ingot, 1x Leather Strips"
  private costText(cost: Material[], times: string, joint: string): string {
    return cost.map((m) => `${m.need}${times} ${this.baseName(m.baseId)}`).join(joint);
  }

  // "Improve items": the vanilla bench, through the engine's own activation so every other check of the bench still runs
  private onImprove(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = mp.getUserActor(userId) >>> 0; } catch { return; }
    const session = actorId ? this.sessionOf(ctx, userId, actorId, content) : null;
    this.sessions.delete(userId);
    if (!session) return;
    this.bypass.set(actorId, { bench: session.bench, until: Date.now() + BYPASS_MS });
    try {
      const self = { type: "form", desc: mp.getDescFromId(session.bench) };
      mp.callPapyrusFunction("method", "ObjectReference", "Activate", self, [{ type: "form", desc: mp.getDescFromId(actorId) }, false]);
    } catch (e) {
      this.bypass.delete(actorId);
      this.log(`[durability] could not open the bench ${hex(session.bench)} for ${hex(actorId)}: ${e}`);
    }
  }

  private on = false;
  private nativeOffLogged = false;
  private tags: DurabilityTags = { enabled: false, showAtFull: true, brokenLabel: "Broken" };
  private tagPattern = conditionTagPattern("Broken");
  private config: RepairSettings = repairSettings(null);
  private settle: SettleWear = () => { };
  private fallbackMaterials = new Map<string, number>();
  private sessions = new Map<number, Session>();
  // One vanilla activation the menu lets through, by actor
  private bypass = new Map<number, { bench: number; until: number }>();
  private lastOpenMs = new Map<number, number>();
  private lastRepairMs = new Map<number, number>();
  // Condition of each worn copy at the last poll, by actor and then by base and hand
  private wornSeen = new Map<number, Map<string, number>>();
  private brokenNoticedMs = new Map<string, number>();
  private cuirassCache = new Map<number, boolean>();
  private freeLogged = new Set<number>();
}
