import { ContainerChangedEvent, FurnitureEvent, Game, HitEvent, Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { getPcInventory, holdPcInventoryApply, requestPcInventoryApply } from "./remoteServer";
import {
  Entry, Inventory, getDiff, getPlayerInventory, healthStep, isBoundItem, isNamedItemBase, revertLocalExtras, sameEffects, sameItem,
} from "../../sync/inventory";
import { splitTag, stripTag, tagFor } from "../../sync/durabilityNames";
import { getRecentSeat } from "./furnitureSeatService";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// Reports extras the player made locally and the charge and poison hits used up, for craftedExtrasSystem.ts; souls are soul trap's
//
// Client -> Server: { customPacketType: "craftedExtras", workbench, gained: Entry[], lost: Entry[] }
// Server -> Client: { customPacketType: "craftedExtrasRefused", baseIds: number[] }

const AFTER_CHANGE_MS = 300;
// Charge and poison drain every hit, so their reports are batched
const USE_REPORT_MS = 10000;
const REPEAT_MS = 30000;
const AWAIT_MS = 3000;
const HOLD_MS = 2000;
const WORKBENCH_MEMORY_MS = 15000;
const MAX_GAINED = 32;
const MAX_LOST = 64;
// Closing these ends enchanting, tempering, a poison apply or a recharge
const CRAFT_MENUS: string[] = [Menu.Crafting, Menu.Inventory, Menu.Favorites];

interface CraftReport {
  gained: Entry[];
  lost: Entry[];
  urgent: boolean;
}

const hasCraftedExtras = (e: Entry): boolean =>
  healthStep(e.health) > 10 || !!(e.enchantmentEffects && e.enchantmentEffects.length) || !!e.poisonId;

// Charge or poison that a hit uses up
const isUsedByHits = (e: Entry): boolean =>
  typeof e.chargePercent === "number" || !!e.maxCharge || !!e.enchantmentId || !!(e.enchantmentEffects && e.enchantmentEffects.length) || !!e.poisonId;

const withoutWorn = (e: Entry): Entry => {
  const copy: Entry = { ...e };
  delete copy.worn;
  delete copy.wornLeft;
  return copy;
};

// A local name carries the condition tag, which is display and never part of the name the server records
const withoutTag = (e: Entry): Entry => (typeof e.name === "string" ? { ...e, name: stripTag(e.name) } : e);

// Of copies that differ only by condition the one the player changed is the one at its tag, so the server claims that copy
const claimTaggedCopy = (g: Entry, sources: Entry[], server: Inventory): void => {
  const tag = typeof g.name === "string" ? splitTag(g.name).tag : "";
  if (!tag || sources.some((l) => tagFor(l.condition) === tag)) return;
  for (const s of server.entries) {
    const source = s.baseId === g.baseId && tagFor(s.condition) === tag ? sources.find((l) => l.count === 1 && sameItem(l, s)) : undefined;
    if (!source) continue;
    if (s.condition === undefined) delete source.condition;
    else source.condition = s.condition;
    return;
  }
};

// A change vanilla pays for (enchanting, tempering, a new poison) rather than wear from use
const isCraft = (g: Entry, sources: Entry[]): boolean =>
  (!!g.enchantmentEffects && !sources.some((s) => sameEffects(s.enchantmentEffects, g.enchantmentEffects))) ||
  healthStep(g.health) > Math.max(10, ...sources.map((s) => healthStep(s.health))) ||
  (!!g.poisonId && !sources.some((s) => s.poisonId === g.poisonId));

// Local copies with extras the server lacks, the server copies the player no longer has, and charge that changed
export const getCraftReport = (server: Inventory, local: Inventory): CraftReport | null => {
  const diff = getDiff(server, local, true, "exact").entries;
  const lost = diff.filter((e) => e.count > 0);
  const gained: Entry[] = [];
  let urgent = false;

  for (const e of diff) {
    if (e.count >= 0) continue;
    const g: Entry = { ...e, count: -e.count };
    const form = Game.getFormEx(g.baseId);
    const sources = lost.filter((l) => l.baseId === g.baseId);
    // A soul the engine put in a gem is the soul trap system's to record, and only the server names keys and writings
    if ((form && isBoundItem(form)) || (g.soul && !hasCraftedExtras(g)) || (!sources.length && !hasCraftedExtras(g)) || isNamedItemBase(g.baseId)) {
      continue;
    }
    claimTaggedCopy(g, sources, server);
    gained.push(withoutTag(withoutWorn(g)));
    urgent = urgent || isCraft(g, sources);
  }

  for (const l of local.entries) {
    if (l.count !== 1 || typeof l.chargePercent !== "number") continue;
    const same = server.entries.filter((s) => s.count === 1 && sameItem(s, l));
    if (same.length !== 1) continue;
    const from = same[0].chargePercent;
    if (typeof from === "number" && Math.abs(from - l.chargePercent) < 1) continue;
    gained.push(withoutTag(withoutWorn(l)));
    lost.push({ ...same[0], count: 1 });
    urgent = urgent || (typeof from === "number" && l.chargePercent > from + 1);
  }

  if (!gained.length) {
    return null;
  }
  const related = (e: Entry) => gained.some((g) => g.baseId === e.baseId);
  lost.sort((a, b) => Number(related(b)) - Number(related(a)));
  return { gained: gained.slice(0, MAX_GAINED), lost: lost.slice(0, MAX_LOST).map(withoutWorn), urgent };
};

export class CraftedExtrasService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("containerChanged", (e) => this.onContainerChanged(e));
    this.controller.on("hit", (e) => this.onHit(e));
    this.controller.on("furnitureExit", (e) => this.onFurnitureExit(e));
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Crafting) this.noteCraftingBench(true);
    });
    this.controller.on("menuClose", (e) => this.onMenuClose(e.name));
    // remoteServer stores the new snapshot on the next update, so check shortly after
    this.controller.emitter.on("setInventoryMessage", () => {
      this.awaitingUntil = 0;
      this.checkAt = Date.now() + AFTER_CHANGE_MS;
    });
    onCustomPacket(this.controller, "craftedExtrasRefused", (content) => this.onCustomPacketMessage(content));
  }

  // The server kept its own copies of these items, so their unrecorded local extras go back to them
  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (!Array.isArray(content["baseIds"])) {
      return;
    }
    const baseIds = (content["baseIds"] as unknown[]).map(Number).filter((id) => Number.isInteger(id) && id > 0);
    // After the SetInventory sent before it has stored its snapshot
    this.controller.once("update", () => {
      this.awaitingUntil = 0;
      revertLocalExtras(baseIds);
      requestPcInventoryApply();
      this.scheduleCheck(Date.now() + AFTER_CHANGE_MS);
    });
  }

  // Crafting and consuming move items between the player and nowhere
  private onContainerChanged(e: ContainerChangedEvent): void {
    const oldId = e.oldContainer ? e.oldContainer.getFormID() : 0;
    const newId = e.newContainer ? e.newContainer.getFormID() : 0;
    if ((oldId === 0x14 && newId === 0) || (oldId === 0 && newId === 0x14)) {
      this.scheduleCheck(Date.now() + AFTER_CHANGE_MS);
      holdPcInventoryApply(HOLD_MS);
    }
  }

  // One check USE_REPORT_MS after the first hit covers the hits that follow it
  private onHit(e: HitEvent): void {
    if (this.useCheckAt || e.aggressor.getFormID() !== 0x14 || !this.holdsWeaponUsedByHits()) {
      return;
    }
    this.useCheckAt = Date.now() + USE_REPORT_MS;
    this.scheduleCheck(this.useCheckAt);
  }

  // A weapon in either hand with a base enchantment, or whose server copies carry charge or poison
  private holdsWeaponUsedByHits(): boolean {
    const player = this.sp.Game.getPlayer();
    const pcInv = getPcInventory();
    return [false, true].some((left) => {
      const weapon = player?.getEquippedWeapon(left);
      if (!weapon) return false;
      if (weapon.getEnchantment()) return true;
      const baseId = weapon.getFormID();
      return !!pcInv && pcInv.entries.some((e) => e.baseId === baseId && isUsedByHits(e));
    });
  }

  private onFurnitureExit(e: FurnitureEvent): void {
    if (e.actor?.getFormID() === 0x14) {
      this.scheduleCheck(Date.now() + AFTER_CHANGE_MS);
    }
  }

  private onMenuClose(name: string): void {
    if (name === Menu.Crafting) this.noteCraftingBench(false);
    if (CRAFT_MENUS.includes(name)) this.scheduleCheck(Date.now() + AFTER_CHANGE_MS);
  }

  // The station of a Crafting Menu the seat tracker missed, kept while the menu is open and like a seat after it closes
  private noteCraftingBench(open: boolean): void {
    if (open || !this.menuBench) {
      const furniture = getRecentSeat(0) ? null : this.sp.Game.getPlayer()?.getFurnitureReference();
      this.menuBench = furniture ? localIdToRemoteId(furniture.getFormID()) : 0;
    }
    this.menuBenchUntil = open ? Infinity : Date.now() + WORKBENCH_MEMORY_MS;
  }

  private getWorkbench(now: number): number {
    return getRecentSeat(0) || (now < this.menuBenchUntil ? this.menuBench : 0) || getRecentSeat(WORKBENCH_MEMORY_MS);
  }

  private scheduleCheck(at: number): void {
    this.checkAt = this.checkAt ? Math.min(this.checkAt, at) : at;
  }

  private onUpdate(): void {
    if (!this.checkAt) {
      return;
    }
    const now = Date.now();
    if (now < this.checkAt || now < this.awaitingUntil) {
      return;
    }
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    this.checkAt = 0;
    this.useCheckAt = 0;
    const pcInv = getPcInventory();
    const report = pcInv ? getCraftReport(pcInv, getPlayerInventory(player)) : null;
    if (!report) {
      return;
    }
    if (!report.urgent && now - this.lastUseReportAt < USE_REPORT_MS) {
      this.useCheckAt = this.lastUseReportAt + USE_REPORT_MS;
      this.scheduleCheck(this.useCheckAt);
      return;
    }
    const key = JSON.stringify([report.gained, report.lost]);
    if (key === this.lastKey && now - this.lastSentAt < REPEAT_MS) {
      return;
    }
    this.lastKey = key;
    this.lastSentAt = now;
    if (!report.urgent) {
      this.lastUseReportAt = now;
    }
    const workbench = this.getWorkbench(now);
    logTrace(this, "Reporting crafted extras", key);
    sendCustomPacket(this.controller, { customPacketType: "craftedExtras", workbench, gained: report.gained, lost: report.lost });
    this.awaitingUntil = now + AWAIT_MS;
    if (report.urgent) {
      holdPcInventoryApply(HOLD_MS);
    }
  }

  // When the next check is due, 0 while none is
  private checkAt = 0;
  // When the check armed for charge and poison use is due, 0 while none is
  private useCheckAt = 0;
  private menuBench = 0;
  private menuBenchUntil = 0;
  private awaitingUntil = 0;
  private lastUseReportAt = 0;
  private lastSentAt = 0;
  private lastKey = "";
}
