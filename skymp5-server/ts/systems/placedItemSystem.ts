import { MongoClient } from "mongodb";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT, WORLD_LOADED_EVENT } from "./system";
import { baseIdOf, baseTypeOf, chainMpHook, countItem, destroyRef, hex, notifyActor, onlineActors, sendActionLock, takeItemFrom, userOf } from "./actorUtil";
import { sendJson } from "./playerText";
import { AdminRoleConfig, adminTierOf, readAdminRoleConfig } from "./adminRoles";
import { formIdFromConfig, toFormId } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// World items carried, nailed and swept by the server, which owns their tilt and rest height; packets in docs_roleplay_interaction_prompts.md
const PLACED_AT_PROP = "private.placedAt";
const NAILED_BY_PROP = "private.nailedBy";
// Seen by every client, which shows Admire and offers no pickup
const NAILED_PROP = "ff_nailed";
// Set on a plugin-placed item once moved, so clients that load it later take the server's position over the plugin's
const MOVED_PROP = "ff_moved";
// The carrier's actor id while someone carries the item, else 0; every other copy stays hidden however it is spawned
const CARRIED_PROP = "ff_carried";
const NAIL_DESC = "0300F:HearthFires.esm";
const HAMMER_DESC = "5CAE1:Skyrim.esm";
const SWEEP_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
// The client's surface reach (350) plus slack for the server's lagging copy of the player's position
const REACH = 400;
const NAIL_ANIM = "IdleHammerTableEnter";
const NAIL_SECONDS = 2;
// A carry the client never ends is given back after this long
const GRAB_TTL_MS = 2 * 60 * 1000;
// A drop point serves the drops that follow it this closely, a multi-item drop included
const DROP_POINT_MS = 2000;
// Shield models lie face down; a half turn on Y shows the front
const SHIELD_FLIP_Y = 180;
const SHIELD_SLOT = 1 << 9;
const ITEM_TYPES = new Set(["MISC", "WEAP", "ARMO", "BOOK", "INGR", "ALCH", "KEYM", "SLGM", "SCRL", "LIGH", "AMMO"]);

const field = (name: string) => ({ $getField: { field: name, input: "$dynamicFields" } });
const fmt = (v: number[]) => v.map((n) => n.toFixed(1)).join(",");

// OBND corners around the base's origin, and whether it is a shield
interface BaseInfo {
  min: number[];
  max: number[];
  shield: boolean;
}

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
  private bases = new Map<number, BaseInfo>();
  private dropPoints = new Map<number, { pos: number[]; at: number }>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    this.roleCfg = readAdminRoleConfig(all);
    this.nailId = formIdFromConfig(mp, NAIL_DESC);
    this.hammerId = formIdFromConfig(mp, HAMMER_DESC);
    if (all?.["databaseDriver"] === "mongodb" && typeof all["databaseUri"] === "string" && typeof all["databaseName"] === "string") {
      this.db = { uri: all["databaseUri"], name: all["databaseName"] };
    }
    chainMpHook(mp, "onItemPlaced", (actorId: number, refId: number) => this.onPlaced(mp, Number(actorId) >>> 0, Number(refId) >>> 0));
    chainMpHook(mp, "onActivate", (targetId: number, casterId: number) => this.onActivate(mp, Number(targetId) >>> 0, Number(casterId) >>> 0));
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.releaseBy(mp, actorId >>> 0));
    // After the saves load and gamemode.js declares ff_carried, which the emit is followed by synchronously
    ctx.gm.once(WORLD_LOADED_EVENT, () => setImmediate(() => {
      if (this.db) this.clearStaleCarries(mp).catch((e) => this.log(`[placed] stale carry check failed: ${e}`));
    }));
    this.log(`[placed] nail ${hex(this.nailId)}, hammer ${hex(this.hammerId)}; ${this.db ? "old drops are swept every 30 min" : "no mongodb, old drops are never swept"}`);
  }

  disconnect(userId: number, ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = Number(mp.getUserActor(userId)) >>> 0; } catch { return; }
    if (!actorId) return;
    this.releaseBy(mp, actorId);
    this.dropPoints.delete(actorId);
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
    if (!["itemMenuRequest", "itemGrab", "itemMove", "itemRelease", "itemNail", "itemPry", "itemDropPoint"].includes(type)) return;
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = Number(mp.getUserActor(userId)) >>> 0; } catch { return; }
    if (!actorId) return;
    if (type === "itemDropPoint") return this.setDropPoint(mp, actorId, content["pos"]);
    const target = toFormId(content["target"]);
    const grab = this.grabs.get(target);
    const mine = grab?.by === actorId;
    // The carrier's own release is judged by where it puts the item, not by where it picked it up
    const ending = mine && (type === "itemMove" || type === "itemRelease");
    // A carry request always gets an answer, so the client never waits on one
    if (!this.isItem(mp, target) || (!ending && !this.isNear(mp, actorId, target))) {
      if (type === "itemGrab") sendJson(mp, userId, { customPacketType: "itemGrabState", target, ok: false });
      return;
    }
    const nailedBy = this.nailedBy(mp, target);
    if (type === "itemMenuRequest") {
      sendJson(mp, userId, { customPacketType: "itemMenuState", target, nailed: !!nailedBy, canPry: this.canPry(mp, actorId, nailedBy),
        canNail: !nailedBy && !grab && this.hasTools(mp, actorId) });
    } else if (type === "itemGrab") {
      this.grab(mp, userId, actorId, target, !nailedBy && (!grab || mine));
    } else if (type === "itemMove" && mine) {
      this.move(mp, actorId, target, content);
    } else if (type === "itemRelease" && mine) {
      this.release(mp, target);
    } else if (type === "itemNail" && !nailedBy && !grab) {
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

  private setDropPoint(mp: Mp, actorId: number, pos: unknown): void {
    if (!this.isVector(pos)) {
      this.dropPoints.delete(actorId);
      return;
    }
    const away = this.distanceTo(mp, actorId, pos);
    if (away > REACH) {
      this.dropPoints.delete(actorId);
      this.log(`[placed] drop point from ${hex(actorId)} out of reach, ${away.toFixed(0)} away`);
      return;
    }
    this.dropPoints.set(actorId, { pos, at: Date.now() });
  }

  // The carrier's client shows the item turned and raised as it will rest
  private grab(mp: Mp, userId: number, actorId: number, target: number, ok: boolean): void {
    if (!ok) return sendJson(mp, userId, { customPacketType: "itemGrabState", target, ok });
    this.grabs.set(target, { by: actorId, at: Date.now() });
    this.setCarried(mp, target, actorId);
    const info = this.baseInfo(mp, target);
    const loc = mp.get(target, "locationalData");
    const rot = this.restRot(info, loc.rot, loc.rot[2]);
    sendJson(mp, userId, { customPacketType: "itemGrabState", target, ok, tilt: [rot[0], rot[1]], lift: this.restLift(info, rot) });
    this.toCell(mp, target, { customPacketType: "itemGrabbed", target }, userId);
  }

  private move(mp: Mp, actorId: number, target: number, content: Content): void {
    const surface = content["pos"];
    const yaw = Array.isArray(content["rot"]) ? Number((content["rot"] as unknown[])[2]) : NaN;
    const loc = mp.get(target, "locationalData");
    const refused = !this.isVector(surface) || !Number.isFinite(yaw) ? "bad packet"
      : !this.sameCell(mp, actorId, loc.cellOrWorldDesc) ? "other cell"
        : this.distanceTo(mp, actorId, surface) > REACH ? `${this.distanceTo(mp, actorId, surface).toFixed(0)} away` : "";
    if (refused) {
      this.log(`[placed] move of ${hex(target)} by ${hex(actorId)} refused: ${refused}`);
      return this.release(mp, target);
    }
    const info = this.baseInfo(mp, target);
    const rot = this.restRot(info, loc.rot, yaw);
    const pos = [surface[0], surface[1], surface[2] + this.restLift(info, rot)];
    // Flag and turn first: a move across a grid border sends create messages at once, which must carry both
    if (target < 0xff000000) this.markMoved(mp, target);
    this.endGrab(mp, target);
    mp.set(target, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos: loc.pos, rot });
    mp.set(target, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos, rot });
    if (this.isPlaced(mp, target)) this.setPlacedAt(mp, target);
    this.toCell(mp, target, { customPacketType: "itemMoved", target, pos, rot });
    this.log(`[placed] ${hex(target)} moved by ${hex(actorId)} to ${fmt(pos)} rot ${fmt(rot)}`);
  }

  // Ends a carry where the item already is, so the other clients show it again
  private release(mp: Mp, target: number): void {
    this.endGrab(mp, target);
    try {
      const loc = mp.get(target, "locationalData");
      this.toCell(mp, target, { customPacketType: "itemMoved", target, pos: loc.pos, rot: loc.rot });
    } catch { /* the item is gone */ }
  }

  // Copies already spawned never read a refr's position again, so its cell is told
  private toCell(mp: Mp, target: number, packet: Record<string, unknown>, exceptUser = -1): void {
    let cell = 0;
    try { cell = mp.getIdFromDesc(mp.get(target, "locationalData").cellOrWorldDesc) >>> 0; } catch { return; }
    for (const actorId of onlineActors(mp)) {
      try {
        if ((Number(mp.getActorCellOrWorld(actorId)) >>> 0) !== cell) continue;
      } catch { continue; }
      const userId = userOf(mp, actorId);
      if (userId !== exceptUser) sendJson(mp, userId, packet);
    }
  }

  private endGrab(mp: Mp, target: number): void {
    if (this.grabs.delete(target)) this.setCarried(mp, target, 0);
  }

  private releaseBy(mp: Mp, actorId: number): void {
    for (const [target, grab] of Array.from(this.grabs)) {
      if (grab.by === actorId) this.release(mp, target);
    }
  }

  private setCarried(mp: Mp, target: number, by: number): boolean {
    try {
      mp.set(target, CARRIED_PROP, by);
      return true;
    } catch (e) {
      this.log(`[placed] ${CARRIED_PROP} not written on ${hex(target)}: ${e}`);
      return false;
    }
  }

  // Carries live in memory, so flags a restart or crash left saved are cleared once at boot
  private async clearStaleCarries(mp: Mp): Promise<void> {
    this.client ??= await new MongoClient(this.db!.uri).connect();
    const docs = await this.client.db(this.db!.name).collection("changeForms").find({
      isDeleted: { $ne: true }, $expr: { $gt: [field(CARRIED_PROP), 0] },
    }, { projection: { formDesc: 1 } }).toArray();
    let cleared = 0;
    for (const doc of docs) {
      const desc = String(doc.formDesc ?? "");
      const id = desc.includes(":") ? formIdFromConfig(mp, desc) : (0xff000000 | parseInt(desc, 16)) >>> 0;
      if (!id || this.grabs.has(id) || !this.setCarried(mp, id, 0)) continue;
      cleared++;
      // Plugin-placed copies are shown again only by itemMoved
      try {
        if (!mp.get(id, "isDisabled")) {
          const loc = mp.get(id, "locationalData");
          this.toCell(mp, id, { customPacketType: "itemMoved", target: id, pos: loc.pos, rot: loc.rot });
        }
      } catch { /* gone */ }
    }
    if (cleared) this.log(`[placed] cleared ${cleared} carry flags left by the last run`);
  }

  private baseInfo(mp: Mp, refId: number): BaseInfo {
    const baseId = baseIdOf(mp, refId);
    let info = this.bases.get(baseId);
    if (!info) {
      info = { min: [0, 0, 0], max: [0, 0, 0], shield: false };
      try {
        const record = mp.lookupEspmRecordById(baseId)?.record;
        const fields: any[] = record?.fields ?? [];
        const obnd = fields.find((f) => f?.type === "OBND")?.data as Uint8Array | undefined;
        if (obnd && obnd.byteLength >= 12) {
          const view = new DataView(obnd.buffer, obnd.byteOffset, obnd.byteLength);
          const a = [0, 2, 4].map((o) => view.getInt16(o, true)), b = [6, 8, 10].map((o) => view.getInt16(o, true));
          info.min = a.map((v, i) => Math.min(v, b[i]));
          info.max = a.map((v, i) => Math.max(v, b[i]));
        }
        // BOD2, or BODT in older plugins, starts with the biped slots; bit 9 is slot 39, the shield
        const body = record?.type === "ARMO" ? fields.find((f) => f?.type === "BOD2" || f?.type === "BODT")?.data as Uint8Array | undefined : undefined;
        info.shield = !!body && body.byteLength >= 4 && (new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true) & SHIELD_SLOT) !== 0;
      } catch { /* unknown base */ }
      this.bases.set(baseId, info);
    }
    return info;
  }

  private restRot(info: BaseInfo, stored: number[], yaw: number): number[] {
    return info.shield ? [0, SHIELD_FLIP_Y, yaw] : [stored[0], stored[1], yaw];
  }

  // How far the origin sits above the surface so the lowest of the turned bounds' corners touches it
  private restLift(info: BaseInfo, rot: number[]): number {
    const rad = Math.PI / 180;
    const [sx, cx, sy, cy] = [Math.sin(rot[0] * rad), Math.cos(rot[0] * rad), Math.sin(rot[1] * rad), Math.cos(rot[1] * rad)];
    // World z of a local point; yaw never changes it
    const row = [sy, -sx * cy, cx * cy];
    let low = Infinity;
    for (const x of [info.min[0], info.max[0]]) for (const y of [info.min[1], info.max[1]]) for (const z of [info.min[2], info.max[2]]) {
      low = Math.min(low, x * row[0] + y * row[1] + z * row[2]);
    }
    return -low;
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

  // Runs while the drop is still disabled, so the create message clients get carries this pose
  private onPlaced(mp: Mp, actorId: number, refId: number): void {
    this.setPlacedAt(mp, refId);
    const point = this.dropPoints.get(actorId);
    const onSurface = !!point && Date.now() - point.at <= DROP_POINT_MS;
    try {
      const info = this.baseInfo(mp, refId);
      const loc = mp.get(refId, "locationalData");
      const rot = this.restRot(info, loc.rot, loc.rot[2]);
      // DropItem raised the item off the feet by its lowest point; that is undone here
      const spot = onSurface ? point!.pos : [loc.pos[0], loc.pos[1], loc.pos[2] + info.min[2]];
      const pos = [spot[0], spot[1], spot[2] + this.restLift(info, rot)];
      mp.set(refId, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos, rot });
      this.log(`[placed] drop ${hex(refId)} by ${hex(actorId)} ${onSurface ? "on surface" : "at feet"}, at ${fmt(pos)} rot ${fmt(rot)}`);
    } catch (e) {
      this.log(`[placed] could not place drop ${hex(refId)}: ${e}`);
    }
  }

  private markMoved(mp: Mp, target: number): void {
    try { mp.set(target, MOVED_PROP, true); } catch (e) { this.log(`[placed] ${MOVED_PROP} not written on ${hex(target)} (makeProperty in gamemode.js?): ${e}`); }
  }

  // isNear reads actors only; items are compared by their locational data
  private isNear(mp: Mp, actorId: number, target: number): boolean {
    try {
      const b = mp.get(target, "locationalData");
      return this.sameCell(mp, actorId, b.cellOrWorldDesc) && this.distanceTo(mp, actorId, b.pos) <= REACH;
    } catch {
      return false;
    }
  }

  private sameCell(mp: Mp, actorId: number, cellOrWorldDesc: string): boolean {
    try { return mp.get(actorId, "locationalData").cellOrWorldDesc === cellOrWorldDesc; } catch { return false; }
  }

  private distanceTo(mp: Mp, actorId: number, point: number[]): number {
    try {
      const me = mp.get(actorId, "pos") as number[];
      return Math.hypot(point[0] - me[0], point[1] - me[1], point[2] - me[2]);
    } catch {
      return Infinity;
    }
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
