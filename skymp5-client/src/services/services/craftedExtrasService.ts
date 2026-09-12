import { Actor, ContainerChangedEvent, Game } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { getPcInventory, holdPcInventoryApply } from "./remoteServer";
import { Entry, Inventory, getDiff, getInventory, healthStep, isBoundItem, sameEffects, sameItem } from "../../sync/inventory";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// Reports the extras the player made locally (enchanting, tempering, recharging, poisoning a weapon) and the charge and
// poison that hits used up, so the server records them (craftedExtrasSystem.ts). Soul gems the engine fills are left to
// the server's soul trap system.
//
// Client -> Server: { customPacketType: "craftedExtras", workbench, gained: Entry[], lost: Entry[] }

const CHECK_MS = 1000;
const AFTER_CHANGE_MS = 300;
// Charge and poison drain every hit, so their reports are batched
const USE_REPORT_MS = 10000;
const REPEAT_MS = 30000;
const AWAIT_MS = 3000;
const HOLD_MS = 2000;
const WORKBENCH_MEMORY_MS = 15000;
const MAX_GAINED = 32;
const MAX_LOST = 64;

interface CraftReport {
  gained: Entry[];
  lost: Entry[];
  urgent: boolean;
}

const hasCraftedExtras = (e: Entry): boolean =>
  healthStep(e.health) > 10 || !!(e.enchantmentEffects && e.enchantmentEffects.length) || !!e.poisonId;

const withoutWorn = (e: Entry): Entry => {
  const copy: Entry = { ...e };
  delete copy.worn;
  delete copy.wornLeft;
  return copy;
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
    // A soul the engine put in a gem is the soul trap system's to record
    if ((form && isBoundItem(form)) || (g.soul && !hasCraftedExtras(g)) || (!sources.length && !hasCraftedExtras(g))) {
      continue;
    }
    gained.push(withoutWorn(g));
    urgent = urgent || isCraft(g, sources);
  }

  for (const l of local.entries) {
    if (l.count !== 1 || typeof l.chargePercent !== "number") continue;
    const same = server.entries.filter((s) => s.count === 1 && sameItem(s, l));
    if (same.length !== 1) continue;
    const from = same[0].chargePercent;
    if (typeof from === "number" && Math.abs(from - l.chargePercent) < 1) continue;
    gained.push(withoutWorn(l));
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
    // remoteServer stores the new snapshot on the next update, so check shortly after
    this.controller.emitter.on("setInventoryMessage", () => {
      this.awaitingUntil = 0;
      this.nextCheckAt = Date.now() + AFTER_CHANGE_MS;
    });
  }

  // Crafting and consuming move items between the player and nowhere
  private onContainerChanged(e: ContainerChangedEvent): void {
    const oldId = e.oldContainer ? e.oldContainer.getFormID() : 0;
    const newId = e.newContainer ? e.newContainer.getFormID() : 0;
    if ((oldId === 0x14 && newId === 0) || (oldId === 0 && newId === 0x14)) {
      this.nextCheckAt = Math.min(this.nextCheckAt, Date.now() + AFTER_CHANGE_MS);
    }
  }

  private onUpdate(): void {
    const player = this.sp.Game.getPlayer() as Actor | null;
    if (!player) {
      return;
    }
    const now = Date.now();
    const furniture = player.getFurnitureReference();
    if (furniture) {
      this.workbench = localIdToRemoteId(furniture.getFormID());
      this.workbenchAt = now;
    }
    if (now < this.nextCheckAt || now < this.awaitingUntil) {
      return;
    }
    this.nextCheckAt = now + CHECK_MS;
    const pcInv = getPcInventory();
    const report = pcInv ? getCraftReport(pcInv, getInventory(player)) : null;
    if (!report || (!report.urgent && now - this.lastUseReportAt < USE_REPORT_MS)) {
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
    const workbench = now - this.workbenchAt < WORKBENCH_MEMORY_MS ? this.workbench : 0;
    logTrace(this, "Reporting crafted extras", key);
    sendCustomPacket(this.controller, { customPacketType: "craftedExtras", workbench, gained: report.gained, lost: report.lost });
    this.awaitingUntil = now + AWAIT_MS;
    if (report.urgent) {
      holdPcInventoryApply(HOLD_MS);
    }
  }

  private nextCheckAt = 0;
  private awaitingUntil = 0;
  private lastUseReportAt = 0;
  private lastSentAt = 0;
  private lastKey = "";
  private workbench = 0;
  private workbenchAt = 0;
}
