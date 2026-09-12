import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { espmFieldFormIds, espmLinkedRefId, readVmadScripts } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Tool check, yield and depletion of chopping blocks and ore veins; their vanilla scripts wait on animation events the server never receives.
//
// server-settings.json keys (all optional):
//   gatheringStrikeSeconds       seconds of work per chop or pickaxe strike, default 5
//   gatheringVeinRespawnMinutes  how long a depleted vein stays empty, default 1440

const VEIN_PROP = "private.gathering";
const SEAT_CLOSE_EVENT = "onPapyrusEvent:SkympOnActivateClose";
// Shown by the client's masteryService; gathering is profession work.
const NOTICE_PACKET = "masteryNotice";

const DEFAULT_STRIKE_SECONDS = 5;
const DEFAULT_VEIN_RESPAWN_MINUTES = 1440;
// Engine furniture reach is 256; a wall marker stands a little off its vein.
const SEAT_REACH = 400;
// Nobody works one sitting this long; a stuck session is dropped.
const MAX_SESSION_MS = 15 * 60000;
const DENY_NOTICE_MS = 1000;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;

// Papyrus defaults of the vanilla scripts, used when a record leaves a property unset.
const CHOP_DEFAULT_COUNT = 1;
const CHOP_DEFAULT_MAX = 6;
const VEIN_DEFAULT_COUNT = 1;
const VEIN_DEFAULT_TOTAL = 3;
const VEIN_DEFAULT_STRIKES = 1;

type StationKind = "chop" | "vein" | "marker";

interface Station {
  kind: StationKind;
  props: Record<string, number>;
}

interface Session {
  actorId: number;
  furnitureId: number;
  kind: "chop" | "mine";
  veinId: number;
  resource: number;
  perStrike: number;
  // Chopping: most resources one sitting hands out. Mining: ore collections a full vein holds.
  cap: number;
  given: number;
  strikesPer: number;
  strikesLeft: number;
  exitIdle: number;
  startedAt: number;
  nextAt: number;
}

interface VeinState {
  left: number;
  resetAt: number;
}

// Undefined: not a gathering station. False: refused. A function: run once the activation went through.
type Verdict = undefined | false | (() => void);

export class GatheringSystem implements System {
  systemName = "GatheringSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    const strike = Number(all?.["gatheringStrikeSeconds"]);
    if (Number.isFinite(strike) && strike > 0) this.strikeMs = strike * 1000;
    const respawn = Number(all?.["gatheringVeinRespawnMinutes"]);
    if (Number.isFinite(respawn) && respawn >= 0) this.respawnMs = respawn * 60000;

    this.installHooks(ctx);
    this.log(`[gathering] ready, one strike per ${this.strikeMs / 1000} s, veins refill after ${this.respawnMs / 60000} min`);
  }

  // Chained like HousingSystem: a refusal never reaches the furniture, and a
  // session only starts once every other handler let the activation through.
  private installHooks(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let verdict: Verdict;
      try {
        verdict = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[gathering] activation check failed: ${e}`);
      }
      if (verdict === false) return false;
      let allowed = true;
      if (previous) {
        try { allowed = previous.call(mp, targetId, casterId) !== false; } catch { allowed = true; }
      }
      if (allowed && verdict) verdict();
      return allowed;
    };

    const previousClose = typeof mp[SEAT_CLOSE_EVENT] === "function" ? mp[SEAT_CLOSE_EVENT] : null;
    mp[SEAT_CLOSE_EVENT] = (...args: unknown[]) => {
      this.endSessionsAt(Number(args[0]) >>> 0);
      return previousClose ? previousClose.apply(mp, args) : undefined;
    };
  }

  disconnect(userId: number, ctx: SystemContext): void {
    const actorId = this.actorOf(ctx, userId);
    if (actorId) this.sessions.delete(actorId);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    // Papyrus calls run here, outside the native activation call stack.
    for (const p of this.pendingSeats.splice(0, this.pendingSeats.length)) this.activateFor(ctx, p.markerId, p.actorId);
    if (!this.sessions.size) return;
    const now = Date.now();
    for (const s of Array.from(this.sessions.values())) {
      if (now < s.nextAt) continue;
      if (!this.stillWorking(ctx, s, now)) {
        this.sessions.delete(s.actorId);
        continue;
      }
      s.nextAt = now + this.strikeMs;
      try {
        if (s.kind === "chop") this.chopStrike(ctx, s);
        else this.mineStrike(ctx, s, now);
      } catch (e) {
        this.log(`[gathering] strike failed for ${s.actorId.toString(16)}: ${e}`);
        this.sessions.delete(s.actorId);
      }
    }
  }

  // ── Activation ──────────────────────────────────────────────────────────────

  private onActivate(ctx: SystemContext, targetId: number, casterId: number): Verdict {
    if (!this.isPlayer(ctx, casterId)) return undefined;
    const station = this.stationOf(ctx, targetId);
    if (!station) return undefined;
    switch (station.kind) {
      case "chop": return this.onChoppingBlock(ctx, targetId, casterId, station.props);
      case "vein": return this.onVein(ctx, targetId, casterId, station.props);
      case "marker": return this.onMiningMarker(ctx, targetId, casterId, station.props);
      default: return undefined;
    }
  }

  private onChoppingBlock(ctx: SystemContext, blockId: number, actorId: number, props: Record<string, number>): Verdict {
    if (!this.holdsTool(ctx, actorId, props["requireditemlist"])) {
      return this.deny(ctx, actorId, "You need a woodcutter's axe to chop wood.");
    }
    if (!this.seatFree(ctx, blockId, actorId)) return this.deny(ctx, actorId, "Someone is already using this.");
    const resource = props["resource"] || 0;
    if (!resource || this.sessions.get(actorId)?.furnitureId === blockId) return undefined;
    const max = props["maxresourceperactivation"] > 0 ? props["maxresourceperactivation"] : CHOP_DEFAULT_MAX;
    return () => this.startSession({
      actorId, furnitureId: blockId, kind: "chop", veinId: 0, resource,
      perStrike: Math.max(1, props["resourcecount"] || CHOP_DEFAULT_COUNT),
      cap: max, given: 0, strikesPer: 1, strikesLeft: 1,
      exitIdle: props["idlewoodchopexit"] || 0, startedAt: 0, nextAt: 0,
    });
  }

  // The vein itself only checks the tool and hands the player to its linked marker, as MineOreScript does.
  private onVein(ctx: SystemContext, veinId: number, actorId: number, props: Record<string, number>): Verdict {
    const refused = this.veinRefusal(ctx, veinId, actorId, props);
    if (refused !== undefined) return refused;
    const markerId = espmLinkedRefId(this.lookup(ctx, veinId));
    if (!markerId) return undefined;
    this.markerVein.set(markerId, veinId);
    return () => this.pendingSeats.push({ markerId, actorId });
  }

  private onMiningMarker(ctx: SystemContext, markerId: number, actorId: number, markerProps: Record<string, number>): Verdict {
    const veinId = this.veinOfMarker(ctx, markerId);
    // Scripted mines (Cidhna Mine) have no vein behind the marker; leave them be.
    if (!veinId) return undefined;
    const vein = this.stationOf(ctx, veinId);
    if (!vein || vein.kind !== "vein") return undefined;
    const refused = this.veinRefusal(ctx, veinId, actorId, vein.props);
    if (refused !== undefined) return refused;
    if (!this.seatFree(ctx, markerId, actorId)) return this.deny(ctx, actorId, "Someone is already mining here.");
    const ore = vein.props["ore"] || 0;
    if (!ore || this.sessions.get(actorId)?.furnitureId === markerId) return undefined;
    const strikes = Math.max(1, vein.props["strikesbeforecollection"] || VEIN_DEFAULT_STRIKES);
    return () => this.startSession({
      actorId, furnitureId: markerId, kind: "mine", veinId, resource: ore,
      perStrike: Math.max(1, vein.props["resourcecount"] || VEIN_DEFAULT_COUNT),
      cap: this.veinTotal(vein.props), given: 0, strikesPer: strikes, strikesLeft: strikes,
      exitIdle: markerProps["pickaxeexit"] || 0, startedAt: 0, nextAt: 0,
    });
  }

  private veinRefusal(ctx: SystemContext, veinId: number, actorId: number, props: Record<string, number>): false | undefined {
    if (!this.holdsTool(ctx, actorId, props["mineoretoolslist"])) {
      return this.deny(ctx, actorId, "You need a pickaxe to mine this vein.");
    }
    if (this.veinState(ctx, veinId, this.veinTotal(props)).left <= 0) {
      return this.deny(ctx, actorId, "This vein is depleted.");
    }
    return undefined;
  }

  // One worker per station, like the engine's own furniture occupancy.
  private seatFree(ctx: SystemContext, furnitureId: number, actorId: number): boolean {
    for (const s of this.sessions.values()) {
      if (s.furnitureId === furnitureId && s.actorId !== actorId && this.stillWorking(ctx, s, Date.now())) return false;
    }
    return true;
  }

  private startSession(s: Session): void {
    const now = Date.now();
    s.startedAt = now;
    s.nextAt = now + this.strikeMs;
    this.sessions.set(s.actorId, s);
  }

  private endSessionsAt(furnitureId: number): void {
    for (const s of Array.from(this.sessions.values())) {
      if (s.furnitureId === furnitureId) this.sessions.delete(s.actorId);
    }
  }

  // ── Work ────────────────────────────────────────────────────────────────────

  private chopStrike(ctx: SystemContext, s: Session): void {
    const count = Math.min(s.perStrike, s.cap - s.given);
    if (count > 0) {
      this.addItem(ctx, s.actorId, s.resource, count);
      s.given += count;
    }
    if (s.given >= s.cap) this.finish(ctx, s, "");
  }

  private mineStrike(ctx: SystemContext, s: Session, now: number): void {
    const state = this.veinState(ctx, s.veinId, s.cap);
    if (state.left <= 0) return this.finish(ctx, s, "This vein is depleted.");
    s.strikesLeft -= 1;
    if (s.strikesLeft > 0) return;
    s.strikesLeft = s.strikesPer;
    this.addItem(ctx, s.actorId, s.resource, s.perStrike);
    state.left -= 1;
    if (state.left <= 0) state.resetAt = now + this.respawnMs;
    this.writeVein(ctx, s.veinId, state);
    if (state.left <= 0) this.finish(ctx, s, "The vein is depleted.");
  }

  // Stand the worker up the way the vanilla scripts do, with the station's exit idle.
  private finish(ctx: SystemContext, s: Session, text: string): void {
    this.sessions.delete(s.actorId);
    if (text) this.notice(ctx, this.userOf(ctx, s.actorId), text);
    const anim = this.idleEvent(ctx, s.exitIdle);
    if (!anim) return;
    const mp = ctx.svr as Mp;
    try {
      const actor = { type: "form", desc: mp.getDescFromId(s.actorId) };
      mp.callPapyrusFunction("global", "Debug", "SendAnimationEvent", null, [actor, anim]);
    } catch (e) {
      this.log(`[gathering] exit idle failed for ${s.actorId.toString(16)}: ${e}`);
    }
  }

  // Actor.PlayIdle needs a Papyrus stack that calls from JS lack, so the idle's animation event (ENAM) is sent instead.
  private idleEvent(ctx: SystemContext, idleId: number): string {
    const fields = this.lookup(ctx, idleId)?.record.fields || [];
    const f = fields.find((x: any) => x && x.type === "ENAM" && x.data instanceof Uint8Array);
    return f ? String.fromCharCode(...f.data).split("\0")[0] : "";
  }

  private stillWorking(ctx: SystemContext, s: Session, now: number): boolean {
    if (now - s.startedAt > MAX_SESSION_MS) return false;
    if (this.userOf(ctx, s.actorId) < 0) return false;
    const mp = ctx.svr as Mp;
    try {
      if (mp.get(s.actorId, "isDead")) return false;
      const loc = mp.get(s.actorId, "locationalData");
      if (!loc || String(loc.cellOrWorldDesc) !== String(mp.get(s.furnitureId, "worldOrCellDesc"))) return false;
      const pos = mp.get(s.furnitureId, "pos");
      const d = Math.hypot(loc.pos[0] - pos[0], loc.pos[1] - pos[1], loc.pos[2] - pos[2]);
      return Number.isFinite(d) && d <= SEAT_REACH;
    } catch {
      return false;
    }
  }

  // ── Veins ───────────────────────────────────────────────────────────────────

  private veinTotal(props: Record<string, number>): number {
    return Math.max(1, props["resourcecounttotal"] || VEIN_DEFAULT_TOTAL);
  }

  // Remaining collections ride the vein's changeform, so a restart keeps a mined-out vein empty.
  private veinState(ctx: SystemContext, veinId: number, total: number): VeinState {
    let raw: any = null;
    try { raw = (ctx.svr as Mp).get(veinId, VEIN_PROP); } catch { /* never mined */ }
    const left = raw && Number.isFinite(Number(raw.left)) ? Number(raw.left) : total;
    const resetAt = raw ? Number(raw.resetAt) || 0 : 0;
    if (left <= 0 && Date.now() >= resetAt) return { left: total, resetAt: 0 };
    return { left: Math.min(left, total), resetAt };
  }

  private writeVein(ctx: SystemContext, veinId: number, state: VeinState): void {
    try {
      (ctx.svr as Mp).set(veinId, VEIN_PROP, state);
    } catch (e) {
      this.log(`[gathering] vein write failed for ${veinId.toString(16)}: ${e}`);
    }
  }

  // Veins link to their marker, never the other way, so a marker finds its vein among its neighbours.
  private veinOfMarker(ctx: SystemContext, markerId: number): number {
    const hit = this.markerVein.get(markerId);
    if (hit !== undefined) return hit;
    const mp = ctx.svr as Mp;
    let near: unknown = null;
    try { near = mp.getNeighborsByPosition(String(mp.get(markerId, "worldOrCellDesc")), mp.get(markerId, "pos")); } catch { /* unloaded */ }
    if (!Array.isArray(near)) return 0;
    let found = 0;
    for (const id of near) {
      const refrId = Number(id) >>> 0;
      if (this.stationOf(ctx, refrId)?.kind === "vein" && espmLinkedRefId(this.lookup(ctx, refrId)) === markerId) {
        found = refrId;
        break;
      }
    }
    // A miss is not cached: the vein may sit in a grid cell that is not loaded yet.
    if (found) this.markerVein.set(markerId, found);
    return found;
  }

  // ── Records ─────────────────────────────────────────────────────────────────

  private stationOf(ctx: SystemContext, refrId: number): Station | null {
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(refrId, "baseDesc"))) >>> 0; } catch { return null; }
    if (!baseId) return null;
    const hit = this.stationCache.get(baseId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, baseId);
    const type = res ? String(res.record.type || "") : "";
    const scripts = res ? readVmadScripts(res) : new Map<string, Record<string, number>>();
    let station: Station | null = null;
    if (type === "FURN" && scripts.has("resourcefurniturescript")) station = { kind: "chop", props: scripts.get("resourcefurniturescript")! };
    else if (type === "ACTI" && scripts.has("mineorescript")) station = { kind: "vein", props: scripts.get("mineorescript")! };
    else if (type === "FURN" && scripts.has("mineorefurniturescript")) station = { kind: "marker", props: scripts.get("mineorefurniturescript")! };
    this.stationCache.set(baseId, station);
    return station;
  }

  // A station without a tool list asks for nothing.
  private holdsTool(ctx: SystemContext, actorId: number, listId: number | undefined): boolean {
    if (!listId) return true;
    let tools = this.toolCache.get(listId);
    if (!tools) {
      tools = new Set(espmFieldFormIds(this.lookup(ctx, listId), "LNAM"));
      this.toolCache.set(listId, tools);
    }
    if (!tools.size) return true;
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries.some((e: any) => tools!.has(Number(e.baseId) >>> 0) && Number(e.count) > 0);
    } catch {
      return false;
    }
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

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private addItem(ctx: SystemContext, actorId: number, itemId: number, count: number): void {
    const mp = ctx.svr as Mp;
    const self = { type: "form", desc: mp.getDescFromId(actorId) };
    mp.callPapyrusFunction("method", "ObjectReference", "AddItem", self, [{ type: "espm", desc: mp.getDescFromId(itemId) }, count, false]);
  }

  // Seats the player through the engine's own furniture path, which also records the occupant.
  private activateFor(ctx: SystemContext, markerId: number, actorId: number): void {
    const mp = ctx.svr as Mp;
    try {
      const self = { type: "form", desc: mp.getDescFromId(markerId) };
      mp.callPapyrusFunction("method", "ObjectReference", "Activate", self, [{ type: "form", desc: mp.getDescFromId(actorId) }, false]);
    } catch (e) {
      this.log(`[gathering] could not seat ${actorId.toString(16)} at marker ${markerId.toString(16)}: ${e}`);
    }
  }

  private deny(ctx: SystemContext, actorId: number, text: string): false {
    // A held activate key fires repeatedly.
    const userId = this.userOf(ctx, actorId);
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) > DENY_NOTICE_MS) {
      this.lastDenyMs.set(userId, now);
      this.notice(ctx, userId, text);
    }
    return false;
  }

  private isPlayer(ctx: SystemContext, actorId: number): boolean {
    try { return Number((ctx.svr as Mp).get(actorId, "profileId")) >= 0; } catch { return false; }
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      const userId = (ctx.svr as Mp).getUserByActor(actorId);
      return userId === INVALID_USER_ID ? -1 : userId;
    } catch {
      return -1;
    }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify({ customPacketType: NOTICE_PACKET, text })); } catch { /* user gone */ }
  }

  private strikeMs = DEFAULT_STRIKE_SECONDS * 1000;
  private respawnMs = DEFAULT_VEIN_RESPAWN_MINUTES * 60000;
  private sessions = new Map<number, Session>();
  private pendingSeats: Array<{ markerId: number; actorId: number }> = [];
  private lastDenyMs = new Map<number, number>();
  private markerVein = new Map<number, number>();
  private stationCache = new Map<number, Station | null>();
  private toolCache = new Map<number, Set<number>>();
}
