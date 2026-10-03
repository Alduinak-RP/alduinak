import { MongoClient } from "mongodb";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { baseIdOf, baseTypeOf, chainMpHook, countItem, destroyRef, hex, isNear, notifyActor, sendActionLock, takeItemFrom, userOf, userSlotCount } from "./actorUtil";
import { sendJson } from "./playerText";
import { AdminRoleConfig, adminTierOf, readAdminRoleConfig } from "./adminRoles";
import { formIdFromConfig, toFormId } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// World items: carried by one player at a time, nailed down with a hammer and a nail; player drops are removed two hours after
// their last placement unless nailed. Packets: itemMenuRequest {target} -> itemMenuState {target, nailed, canPry, canNail};
// itemGrab {target} -> itemGrabState {target, ok}, itemGrabbed {target} to the cell; itemMove {target, pos (the surface point
// under the item), rot} or itemRelease {target} -> itemMoved {target, pos, rot} to the cell; itemNail {target}; itemPry {target}.
// State lives on each item's changeForm; the sweep finds old ones in the changeForms collection and checks them against the live world.
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
// A carry the client never ends is given back after this long
const GRAB_TTL_MS = 2 * 60 * 1000;
const ITEM_TYPES = new Set(["MISC", "WEAP", "ARMO", "BOOK", "INGR", "ALCH", "KEYM", "SLGM", "SCRL", "LIGH", "AMMO"]);

const field = (name: string) => ({ $getField: { field: name, input: "$dynamicFields" } });

export class PlacedItemSystem implements System {
  systemName = "PlacedItemSystem";
  constructor(private log: Log) { }

  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private nailId = 0;
  private hammerId = 0;
  private sweptAt = Date.now();
  private db: { uri: string; name: string } | null = null;
  private client: MongoClient | null = null;
  // item -> who carries it and since when
  private grabs = new Map<number, { by: number; at: number }>();
  private minZ = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    this.roleCfg = readAdminRoleConfig(all);
    this.nailId = formIdFromConfig(mp, NAIL_DESC);
    this.hammerId = formIdFromConfig(mp, HAMMER_DESC);
    if (all?.["databaseDriver"] === "mongodb" && typeof all["databaseUri"] === "string" && typeof all["databaseName"] === "string") {
      this.db = { uri: all["databaseUri"], name: all["databaseName"] };
    }
    chainMpHook(mp, "onItemPlaced", (_actorId: number, refId: number) => this.setPlacedAt(mp, Number(refId) >>> 0));
    chainMpHook(mp, "onActivate", (targetId: number, casterId: number) => this.onActivate(mp, Number(targetId) >>> 0, Number(casterId) >>> 0));
    this.log(`[placed] nail ${hex(this.nailId)}, hammer ${hex(this.hammerId)}; ${this.db ? "old drops are swept every 30 min" : "no mongodb, old drops are never swept"}`);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, 60000));
    const mp = ctx.svr as Mp;
    for (const [target, grab] of Array.from(this.grabs)) {
      if (Date.now() - grab.at > GRAB_TTL_MS || userOf(mp, grab.by) < 0) this.release(mp, target);
    }
    if (!this.db || Date.now() - this.sweptAt < SWEEP_MS) return;
    this.sweptAt = Date.now();
    try {
      await this.sweep(ctx.svr as Mp);
    } catch (e) {
      this.log(`[placed] sweep failed: ${e}`);
    }
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!["itemMenuRequest", "itemGrab", "itemMove", "itemRelease", "itemNail", "itemPry"].includes(type)) return;
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = Number(mp.getUserActor(userId)) >>> 0; } catch { return; }
    const target = toFormId(content["target"]);
    if (!actorId || !this.isItem(mp, target) || !isNear(mp, actorId, target, REACH)) return;
    const nailedBy = this.nailedBy(mp, target);
    const grab = this.grabs.get(target);
    const mine = grab?.by === actorId;
    if (type === "itemMenuRequest") {
      sendJson(mp, userId, { customPacketType: "itemMenuState", target, nailed: !!nailedBy, canPry: this.canPry(mp, actorId, nailedBy),
        canNail: !nailedBy && this.hasTools(mp, actorId) });
    } else if (type === "itemGrab") {
      const ok = !nailedBy && (!grab || mine);
      if (ok) this.grabs.set(target, { by: actorId, at: Date.now() });
      sendJson(mp, userId, { customPacketType: "itemGrabState", target, ok });
      if (ok) this.toCell(mp, target, { customPacketType: "itemGrabbed", target }, userId);
    } else if (type === "itemMove" && mine) {
      this.move(mp, actorId, target, content);
    } else if (type === "itemRelease" && mine) {
      this.release(mp, target);
    } else if (type === "itemNail" && !nailedBy) {
      this.nail(mp, actorId, target);
    } else if (type === "itemPry" && this.canPry(mp, actorId, nailedBy)) {
      this.setNailed(mp, target, 0);
      this.setPlacedAt(mp, target);
    }
  }

  private onActivate(mp: Mp, targetId: number, casterId: number): boolean {
    const by = this.grabs.get(targetId)?.by;
    if (by !== undefined && by !== casterId) return false;
    if (!this.nailedBy(mp, targetId)) return true;
    notifyActor(mp, casterId, "It is nailed down.");
    return false;
  }

  private move(mp: Mp, actorId: number, target: number, content: Content): void {
    const surface = content["pos"], rot = content["rot"];
    if (!this.isVector(surface) || !this.isVector(rot)) return this.release(mp, target);
    const me = mp.get(actorId, "pos") as number[];
    if (Math.hypot(surface[0] - me[0], surface[1] - me[1], surface[2] - me[2]) > REACH) return this.release(mp, target);
    // The item's bottom rests on the surface point
    const pos = [surface[0], surface[1], surface[2] - this.boundsMinZ(mp, target)];
    const loc = mp.get(target, "locationalData");
    mp.set(target, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos, rot });
    if (this.isPlaced(mp, target)) this.setPlacedAt(mp, target);
    this.grabs.delete(target);
    this.toCell(mp, target, { customPacketType: "itemMoved", target, pos, rot });
  }

  // Ends a carry where the item already is, so the other clients show it again
  private release(mp: Mp, target: number): void {
    this.grabs.delete(target);
    try {
      const loc = mp.get(target, "locationalData");
      this.toCell(mp, target, { customPacketType: "itemMoved", target, pos: loc.pos, rot: loc.rot });
    } catch { /* the item is gone */ }
  }

  // Copies already spawned never read a refr's position again, so its cell is told
  private toCell(mp: Mp, target: number, packet: Record<string, unknown>, exceptUser = -1): void {
    let cell = 0;
    try { cell = mp.getIdFromDesc(mp.get(target, "locationalData").cellOrWorldDesc) >>> 0; } catch { return; }
    for (let userId = 0; userId < userSlotCount(); userId++) {
      if (userId === exceptUser || !mp.isConnected(userId)) continue;
      try {
        if ((Number(mp.getActorCellOrWorld(mp.getUserActor(userId))) >>> 0) === cell) sendJson(mp, userId, packet);
      } catch { /* no actor yet */ }
    }
  }

  // OBND's lowest z below the base's origin, 0 without bounds
  private boundsMinZ(mp: Mp, target: number): number {
    const baseId = baseIdOf(mp, target);
    let z = this.minZ.get(baseId);
    if (z === undefined) {
      z = 0;
      try {
        const obnd = (mp.lookupEspmRecordById(baseId)?.record?.fields ?? []).find((f: any) => f?.type === "OBND")?.data as Uint8Array | undefined;
        if (obnd && obnd.byteLength >= 12) {
          const view = new DataView(obnd.buffer, obnd.byteOffset, obnd.byteLength);
          z = Math.min(view.getInt16(4, true), view.getInt16(10, true));
        }
      } catch { /* unknown base */ }
      this.minZ.set(baseId, z);
    }
    return z;
  }

  private nail(mp: Mp, actorId: number, target: number): void {
    if (!this.hasTools(mp, actorId) || !takeItemFrom(mp, actorId, this.nailId, 1)) {
      notifyActor(mp, actorId, "You need a hammer and a nail.");
      return;
    }
    this.setNailed(mp, target, actorId);
    sendActionLock(mp, actorId, NAIL_ANIM, NAIL_SECONDS);
  }

  // The changeForms collection lags the world, so each candidate is checked live before it goes
  private async sweep(mp: Mp): Promise<void> {
    this.client ??= await new MongoClient(this.db!.uri).connect();
    const cutoff = Date.now() - MAX_AGE_MS;
    const docs = await this.client.db(this.db!.name).collection("changeForms").find({
      isDeleted: { $ne: true },
      $expr: { $and: [{ $isNumber: field(PLACED_AT_PROP) }, { $lt: [field(PLACED_AT_PROP), cutoff] }, { $not: [{ $gt: [field(NAILED_BY_PROP), 0] }] }] },
    }, { projection: { formDesc: 1 } }).toArray();
    let removed = 0;
    for (const doc of docs) {
      const desc = String(doc.formDesc ?? "");
      const id = desc.includes(":") ? 0 : (0xff000000 | parseInt(desc, 16)) >>> 0;
      const at = this.placedAt(mp, id);
      if (!id || at === null || at >= cutoff || this.nailedBy(mp, id)) continue;
      try {
        destroyRef(mp, id);
        removed++;
      } catch (e) {
        this.log(`[placed] could not remove ${hex(id)}: ${e}`);
      }
    }
    this.log(`[placed] sweep removed ${removed} of ${docs.length} old drops`);
  }

  // Placing, moving or prying starts the two hours again
  private setPlacedAt(mp: Mp, refId: number): void {
    try { mp.set(refId, PLACED_AT_PROP, Date.now()); } catch { /* the ref is gone already */ }
  }

  private setNailed(mp: Mp, target: number, by: number): void {
    mp.set(target, NAILED_BY_PROP, by);
    mp.set(target, NAILED_PROP, by !== 0);
  }

  private placedAt(mp: Mp, id: number): number | null {
    try {
      if (mp.get(id, "isDisabled")) return null;
      const at = mp.get(id, PLACED_AT_PROP);
      return typeof at === "number" ? at : null;
    } catch {
      return null;
    }
  }

  private isPlaced(mp: Mp, id: number): boolean {
    return this.placedAt(mp, id) !== null;
  }

  private isItem(mp: Mp, id: number): boolean {
    try {
      return !mp.get(id, "isDisabled") && ITEM_TYPES.has(baseTypeOf(mp, id));
    } catch {
      return false;
    }
  }

  private nailedBy(mp: Mp, id: number): number {
    try { return Number(mp.get(id, NAILED_BY_PROP)) >>> 0; } catch { return 0; }
  }

  private canPry(mp: Mp, actorId: number, nailedBy: number): boolean {
    return !!nailedBy && (nailedBy === actorId || adminTierOf(mp, actorId, this.roleCfg) !== null);
  }

  private hasTools(mp: Mp, actorId: number): boolean {
    return countItem(mp, actorId, this.nailId) > 0 && countItem(mp, actorId, this.hammerId) > 0;
  }

  private isVector(v: unknown): v is number[] {
    return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
  }
}
