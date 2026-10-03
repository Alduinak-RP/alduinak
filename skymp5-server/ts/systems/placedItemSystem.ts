import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { chainMpHook, countItem, destroyRef, hex, isNear, notifyActor, sendActionLock, takeItemFrom, userSlotCount } from "./actorUtil";
import { sendJson } from "./playerText";
import { AdminRoleConfig, adminTierOf, readAdminRoleConfig } from "./adminRoles";
import { formIdFromConfig, toFormId } from "./formIdUtil";
import { writeFileAtomic } from "./fileUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Items players drop: moved by hand, nailed down with a hammer and a nail, and removed two hours after their last placement unless nailed.
// Packets: itemMenuRequest {target} -> itemMenuState {target, nailed, canPry, canNail}; itemMove {target, pos, rot} -> itemMoved {target, pos, rot} to everyone;
// itemNail {target}; itemPry {target}.
// State: ./placed-items.json { refId: { at, nailedBy? } }, rewritten atomically on every change.
const STATE_FILE = "./placed-items.json";
const PLACED_AT_PROP = "private.placedAt";
const NAILED_BY_PROP = "private.nailedBy";
// Seen by every client, which shows Admire and offers no pickup
const NAILED_PROP = "ff_nailed";
const NAIL_DESC = "0300F:HearthFires.esm";
const HAMMER_DESC = "5CAE1:Skyrim.esm";
const SWEEP_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const REACH = 400;
const NAIL_ANIM = "IdleHammerTableEnter";
const NAIL_SECONDS = 2;

interface Placed {
  at: number;
  nailedBy?: number;
}

export class PlacedItemSystem implements System {
  systemName = "PlacedItemSystem";
  constructor(private log: Log) { }

  private placed = new Map<number, Placed>();
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private nailId = 0;
  private hammerId = 0;
  private sweptAt = Date.now();

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const s = await Settings.get();
    this.roleCfg = readAdminRoleConfig(s.allSettings);
    this.nailId = formIdFromConfig(mp, NAIL_DESC);
    this.hammerId = formIdFromConfig(mp, HAMMER_DESC);
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, Placed>;
      for (const [id, p] of Object.entries(saved)) this.placed.set(Number(id) >>> 0, p);
    } catch { /* first start */ }
    chainMpHook(mp, "onItemPlaced", (_actorId: number, refId: number) => this.onPlaced(mp, Number(refId) >>> 0));
    chainMpHook(mp, "onActivate", (targetId: number, casterId: number) => this.onActivate(mp, Number(targetId) >>> 0, Number(casterId) >>> 0));
    this.log(`[placed] ${this.placed.size} placed items tracked; nail ${hex(this.nailId)}, hammer ${hex(this.hammerId)}`);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, 60000));
    if (Date.now() - this.sweptAt < SWEEP_MS) return;
    this.sweptAt = Date.now();
    this.sweep(ctx.svr as Mp);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!["itemMenuRequest", "itemMove", "itemNail", "itemPry"].includes(type)) return;
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = Number(mp.getUserActor(userId)) >>> 0; } catch { return; }
    const target = toFormId(content["target"]);
    const item = this.placed.get(target);
    if (!actorId || !item || !this.exists(mp, target) || !isNear(mp, actorId, target, REACH)) return;
    if (type === "itemMenuRequest") {
      sendJson(mp, userId, { customPacketType: "itemMenuState", target, nailed: !!item.nailedBy, canPry: this.canPry(mp, actorId, item),
        canNail: !item.nailedBy && this.hasTools(mp, actorId) });
    } else if (type === "itemMove") {
      this.move(mp, actorId, target, item, content);
    } else if (type === "itemNail") {
      this.nail(mp, actorId, target, item);
    } else {
      this.pry(mp, actorId, target, item);
    }
  }

  private onPlaced(mp: Mp, refId: number): void {
    const at = Date.now();
    this.placed.set(refId, { at });
    try { mp.set(refId, PLACED_AT_PROP, at); } catch { /* the ref is gone already */ }
    this.save();
  }

  private onActivate(mp: Mp, targetId: number, casterId: number): boolean {
    if (!this.placed.get(targetId)?.nailedBy) return true;
    notifyActor(mp, casterId, "It is nailed down.");
    return false;
  }

  private move(mp: Mp, actorId: number, target: number, item: Placed, content: Content): void {
    const pos = content["pos"], rot = content["rot"];
    if (item.nailedBy || !this.isVector(pos) || !this.isVector(rot)) return;
    const me = mp.get(actorId, "pos") as number[];
    if (Math.hypot(pos[0] - me[0], pos[1] - me[1], pos[2] - me[2]) > REACH) return;
    const loc = mp.get(target, "locationalData");
    mp.set(target, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos, rot });
    this.touch(mp, target, item);
    // Copies already spawned never read a refr's position again
    for (let userId = 0; userId < userSlotCount(); userId++) {
      if (mp.isConnected(userId)) sendJson(mp, userId, { customPacketType: "itemMoved", target, pos, rot });
    }
  }

  private nail(mp: Mp, actorId: number, target: number, item: Placed): void {
    if (item.nailedBy) return;
    if (!this.hasTools(mp, actorId) || !takeItemFrom(mp, actorId, this.nailId, 1)) {
      notifyActor(mp, actorId, "You need a hammer and a nail.");
      return;
    }
    item.nailedBy = actorId;
    this.setNailed(mp, target, actorId);
    sendActionLock(mp, actorId, NAIL_ANIM, NAIL_SECONDS);
    this.save();
  }

  private pry(mp: Mp, actorId: number, target: number, item: Placed): void {
    if (!item.nailedBy || !this.canPry(mp, actorId, item)) return;
    delete item.nailedBy;
    this.setNailed(mp, target, 0);
    this.touch(mp, target, item);
  }

  private sweep(mp: Mp): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, item] of Array.from(this.placed)) {
      if (!this.exists(mp, id)) {
        this.placed.delete(id);
      } else if (!item.nailedBy && now - item.at > MAX_AGE_MS) {
        try { destroyRef(mp, id); } catch (e) { this.log(`[placed] could not remove ${hex(id)}: ${e}`); }
        this.placed.delete(id);
        removed++;
      }
    }
    this.log(`[placed] sweep removed ${removed}, ${this.placed.size} left`);
    this.save();
  }

  // Moving or prying restarts the two hours
  private touch(mp: Mp, target: number, item: Placed): void {
    item.at = Date.now();
    try { mp.set(target, PLACED_AT_PROP, item.at); } catch { /* gone */ }
    this.save();
  }

  private setNailed(mp: Mp, target: number, by: number): void {
    mp.set(target, NAILED_BY_PROP, by);
    mp.set(target, NAILED_PROP, by !== 0);
  }

  private canPry(mp: Mp, actorId: number, item: Placed): boolean {
    return !!item.nailedBy && (item.nailedBy === actorId || adminTierOf(mp, actorId, this.roleCfg) !== null);
  }

  private hasTools(mp: Mp, actorId: number): boolean {
    return countItem(mp, actorId, this.nailId) > 0 && countItem(mp, actorId, this.hammerId) > 0;
  }

  private exists(mp: Mp, id: number): boolean {
    try { return mp.get(id, "type") !== undefined && !mp.get(id, "isDisabled"); } catch { return false; }
  }

  private isVector(v: unknown): v is number[] {
    return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
  }

  private save(): void {
    writeFileAtomic(STATE_FILE, JSON.stringify(Object.fromEntries(this.placed)));
  }
}
