import { Settings } from "../settings";
import { System, Log, SystemContext, Content, WORLD_LOADED_EVENT } from "./system";
import { espmRefrFieldId, toFormId } from "./formIdUtil";
import { appendLog, describeActor, displayNameOf, logDirOf, profileIdOf, sanitize, sendJson, titledName } from "./playerText";
import { GOLD_BASE_ID, addGold, baseTypeOf } from "./actorUtil";
import { containerDesc, placeAtMe } from "./npcPlacement";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Bounty boards: public notices pinned in the hold capitals ─────────────────
//
// The Missives mod places its board activator in every hold capital. Activating
// a board opens a menu of the notices pinned there; anyone may read them, and
// posting one costs gold. A notice stays up for a week and then fades. The five
// walled cities have two copies of the same physical board (one in the city
// worldspace, one in Tamriel for the exterior view); both resolve to one
// canonical reference so they always show the same notices.
//
// Each board keeps a strongbox, a container placed at the canonical board the
// first time it is needed; the posting fees pile up in it and only the ranks
// that manage the hold's property (canManage) may open it.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "bountyBoardOpenRequest" }
//     { customPacketType: "bountyBoardPost", board: <refrId>, text }
//     { customPacketType: "bountyBoardRemove", board: <refrId>, id }
//     { customPacketType: "bountyBoardManage", board: <refrId> }
//     { customPacketType: "bountyBoardClose" }
//   Server -> Client:
//     { customPacketType: "bountyBoardMenu", board, boardName, reason,
//       costGold, gold, maxTextLen, maxNotes, expiryDays,
//       canRemove, notes: [{ id, author, text, ageHours }] }
//     { customPacketType: "bountyBoardNotice", text }
//
// Persistence: `private.bountyBoard` on the canonical board reference, which
// rides the changeform into Mongo and comes back on restart. Notices expire
// lazily on every read plus a slow sweep, so correctness does not depend on
// the sweep having run. The strongbox id rides along as `stash`.
//
// Every post and expiry is appended to bounty.log in the shared log directory.
//
// server-settings.json keys (all optional):
//   bountyBoardCostGold     price of pinning a notice, default 25
//   bountyBoardExpiryDays   days a notice stays up, default 7
//   bountyBoardMaxNotes     notices one board holds, default 40
//   bountyBoardMaxTextLen   characters per notice, default 500
//   bountyBoardMaxDistance  posting reach in game units, default 512
//   bountyBoardStashBase    CONT base of the strongbox, default c674b:Skyrim.esm

const BOARD_PROP = "private.bountyBoard";

// The board comes as two bases: the named, visible activator players actually
// hit with the crosshair (_M_MissiveBoard, "Missive Board") and the invisible
// script primitive singleplayer uses (_M_ActivatorBoard). Both are boards.
const BOARD_BASE_DESCS = ["12cb:Missives.esp", "d65:Missives.esp"];

const DEFAULT_COST_GOLD = 25;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_MAX_NOTES = 40;
const DEFAULT_MAX_TEXT_LEN = 500;
const DEFAULT_MAX_DISTANCE = 512;
// The vanilla ash pile: a CONT with no base items and a flat mesh at the board's foot
const DEFAULT_STASH_BASE = "c674b:Skyrim.esm";
const NOT_MANAGER_NOTICE = "Only the hold's steward or jarl may open the board's strongbox.";

const POST_COOLDOWN_MS = 5000;
const OPEN_COOLDOWN_MS = 1000;
const SWEEP_INTERVAL_MS = 60 * 60000;
const MAX_ESPM_CACHE = 4096;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;

// Each city's board is a cluster of references: the visible mesh activator
// (what players activate) plus the invisible primitive, and the walled cities
// carry the whole pair twice (city worldspace and the Tamriel exterior twin).
// Notes live on the first desc listed; every other ref is an alias of it.
const BOARDS: Array<{ name: string; descs: string[] }> = [
  { name: "Whiterun", descs: ["d66:Missives.esp", "12cc:Missives.esp", "21846:Missives.esp", "21847:Missives.esp"] },
  { name: "Riften", descs: ["9492:Missives.esp", "9491:Missives.esp", "21844:Missives.esp", "21845:Missives.esp"] },
  { name: "Windhelm", descs: ["9478:Missives.esp", "9477:Missives.esp", "2183a:Missives.esp", "2183f:Missives.esp"] },
  { name: "Markarth", descs: ["94a3:Missives.esp", "94a2:Missives.esp", "21840:Missives.esp", "21841:Missives.esp"] },
  { name: "Solitude", descs: ["9490:Missives.esp", "948f:Missives.esp", "21838:Missives.esp", "21839:Missives.esp"] },
  { name: "Dawnstar", descs: ["94b1:Missives.esp", "94ae:Missives.esp"] },
  { name: "Winterhold", descs: ["94b5:Missives.esp", "94b2:Missives.esp"] },
  { name: "Morthal", descs: ["94ad:Missives.esp", "94aa:Missives.esp"] },
  { name: "Falkreath", descs: ["94a9:Missives.esp", "94a6:Missives.esp"] },
];

// Riften and Windhelm once kept their notices on each other's primary; the swap runs once, marked on the first
const SWAPPED_PRIMARIES = ["9492:Missives.esp", "9478:Missives.esp"];
const SWAP_DONE_PROP = "private.bountyBoardSwapped";

interface BoardNote {
  id: number;
  author: string;
  // Poster's account, kept for the audit trail; never sent to clients.
  profileId: number;
  text: string;
  createdAt: number;
}

interface BoardRecord {
  nextId: number;
  notes: BoardNote[];
  // The strongbox reference, once placed
  stash?: number;
}

interface BoardSession {
  // Canonical reference the record lives on.
  primary: number;
  // The copy the player actually stood at; reach is checked against it.
  refr: number;
  name: string;
}

const emptyRecord = (): BoardRecord => ({ nextId: 1, notes: [] });

export class BountyBoardSystem implements System {
  systemName = "BountyBoardSystem";

  constructor(private log: Log) { }

  canRemove = (_actorId: number, _boardName: string): boolean => false;
  canManage = (_actorId: number, _boardName: string): boolean => false;
  titleOf = (_actorId: number): string => "";

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const cost = Number(all?.["bountyBoardCostGold"]);
    if (Number.isFinite(cost) && cost >= 0) this.costGold = Math.floor(cost);
    const days = Number(all?.["bountyBoardExpiryDays"]);
    if (Number.isFinite(days) && days > 0) this.expiryDays = days;
    const maxNotes = Number(all?.["bountyBoardMaxNotes"]);
    if (Number.isFinite(maxNotes) && maxNotes > 0) this.maxNotes = Math.floor(maxNotes);
    const maxLen = Number(all?.["bountyBoardMaxTextLen"]);
    if (Number.isFinite(maxLen) && maxLen > 0) this.maxTextLen = Math.floor(maxLen);
    const maxDistance = Number(all?.["bountyBoardMaxDistance"]);
    if (Number.isFinite(maxDistance) && maxDistance > 0) this.maxDistance = maxDistance;

    this.logDir = logDirOf(all);

    const mp = ctx.svr as Mp;
    this.stashDesc = containerDesc(mp, all?.["bountyBoardStashBase"] ?? DEFAULT_STASH_BASE);
    if (!this.stashDesc) this.log(`[bounty] bountyBoardStashBase is not a CONT record, the posting fee is lost`);
    for (const desc of BOARD_BASE_DESCS) {
      try {
        this.boardBaseIds.add(mp.getIdFromDesc(desc) >>> 0);
      } catch { /* base missing from this load order */ }
    }
    if (!this.boardBaseIds.size) {
      this.log(`[bounty] Missives.esp is not in the load order, boards disabled`);
      return;
    }
    for (const board of BOARDS) {
      let primary = 0;
      for (const desc of board.descs) {
        let refrId = 0;
        try { refrId = mp.getIdFromDesc(desc) >>> 0; } catch { continue; }
        if (!primary) primary = refrId;
        this.knownBoards.set(refrId, { primary, name: board.name });
      }
    }

    this.installActivationHook(ctx);
    // Placed forms exist only once the world DB has loaded; the strongboxes of the previous run are guarded from then on
    ctx.gm.once(WORLD_LOADED_EVENT, () => {
      this.worldLoaded = true;
      this.swapMisfiledNotes(ctx);
      for (const primary of this.primaries()) {
        const rec = this.read(ctx, primary);
        if (rec?.stash && this.isStash(ctx, rec.stash)) this.stashes.set(rec.stash, primary);
      }
    });
    // A character switch mid-connection voids the session, same as trade.
    ctx.gm.on("userAssignActor", (userId: number) => {
      this.sessions.delete(userId);
    });
    // The gamemode's /board chat command opens the menu through this bridge,
    // same globalThis pattern as the trade log.
    (globalThis as any).__alduinakBountyOpen = (actorId: number) => {
      const userId = this.userOf(ctx, Number(actorId) >>> 0);
      if (userId >= 0) this.onOpenRequest(ctx, userId);
    };
    this.log(`[bounty] ready, ${BOARDS.length} boards, ${this.costGold} gold a notice, ${this.expiryDays} days on the board`);
  }

  // Activating a board opens the menu instead of the vanilla activation.
  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let isBoard = false;
      try {
        isBoard = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[bounty] activation check failed: ${e}`);
      }
      if (isBoard) return false;
      // Chain, so another handler still gets its say.
      if (!previous) return true;
      try {
        return previous.call(mp, targetId, casterId) !== false;
      } catch {
        return true;
      }
    };
  }

  // True when the target is a board and the menu was taken care of, or a strongbox refused.
  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const stashOwner = this.stashes.get(targetId);
    if (stashOwner) {
      // A manager's activation runs the vanilla container open
      if (this.canManage(casterId, this.boardNameOf(stashOwner))) return false;
      const userId = this.userOf(ctx, casterId);
      if (userId >= 0) this.notice(ctx, userId, NOT_MANAGER_NOTICE);
      return true;
    }
    const board = this.boardOf(ctx, targetId);
    if (!board) return false;
    const userId = this.userOf(ctx, casterId);
    if (userId < 0) return true;
    this.sessions.set(userId, { primary: board.primary, refr: targetId, name: board.name });
    this.sendMenu(ctx, userId, "open");
    return true;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "bountyBoardOpenRequest": this.onOpenRequest(ctx, userId); break;
      case "bountyBoardPost": this.onPost(ctx, userId, content); break;
      case "bountyBoardRemove": this.onRemove(ctx, userId, content); break;
      case "bountyBoardManage": this.onManage(ctx, userId, content); break;
      case "bountyBoardClose": this.sessions.delete(userId); break;
      default: break;
    }
  }

  // Notices expire lazily on read; the sweep only covers boards nobody reads.
  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    const sinceLast = now - this.lastSweepMs;
    if (sinceLast >= 0 && sinceLast < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    for (const primary of this.primaries()) {
      const rec = this.read(ctx, primary);
      if (rec && this.prune(ctx, primary, rec)) this.write(ctx, primary, rec);
    }
  }

  disconnect(userId: number): void {
    this.sessions.delete(userId);
    this.lastPostMs.delete(userId);
    this.lastOpenMs.delete(userId);
  }

  // ── Opening ─────────────────────────────────────────────────────────────────

  // Activating the visible board opens the menu through onActivate; this is
  // the other road in, for the N hotkey and the /board command. Reach is
  // checked here.
  private onOpenRequest(ctx: SystemContext, userId: number): void {
    const now = Date.now();
    if (now - (this.lastOpenMs.get(userId) || 0) < OPEN_COOLDOWN_MS) return;
    this.lastOpenMs.set(userId, now);
    if (!this.boardBaseIds.size) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const board = this.nearestBoard(ctx, actorId);
    if (!board) {
      this.notice(ctx, userId, "There is no notice board within reach.");
      return;
    }
    this.sessions.set(userId, { primary: board.primary, refr: board.refr, name: board.name });
    this.sendMenu(ctx, userId, "open");
  }

  private nearestBoard(ctx: SystemContext, actorId: number): { primary: number; refr: number; name: string } | null {
    const mp = ctx.svr as Mp;
    let pos: any;
    try { pos = mp.get(actorId, "pos"); } catch { return null; }
    if (!Array.isArray(pos)) return null;
    let where = "";
    try { where = String(mp.get(actorId, "worldOrCellDesc") || ""); } catch { /* distance check only */ }
    let best: { primary: number; refr: number; name: string } | null = null;
    let bestD2 = this.maxDistance * this.maxDistance;
    this.knownBoards.forEach((board, refrId) => {
      const spot = this.boardSpot(ctx, refrId);
      // Interiors have their own coordinate origins; only compare inside
      // the same world or cell.
      if (!spot || (where && spot.where && spot.where !== where)) return;
      const dx = Number(pos[0]) - spot.pos[0];
      const dy = Number(pos[1]) - spot.pos[1];
      const dz = Number(pos[2]) - spot.pos[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (Number.isFinite(d2) && d2 <= bestD2) {
        bestD2 = d2;
        best = { primary: board.primary, refr: refrId, name: board.name };
      }
    });
    return best;
  }

  // Boards never move, so position and world resolve once per refr.
  private boardSpot(ctx: SystemContext, refrId: number): { pos: number[]; where: string } | null {
    const cached = this.spotCache.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let spot: { pos: number[]; where: string } | null = null;
    try {
      const pos = mp.get(refrId, "pos");
      if (Array.isArray(pos)) {
        spot = {
          pos: [Number(pos[0]), Number(pos[1]), Number(pos[2])],
          where: String(mp.get(refrId, "worldOrCellDesc") || ""),
        };
      }
    } catch { /* reference the server cannot resolve */ }
    this.spotCache.set(refrId, spot);
    return spot;
  }

  // ── Posting ─────────────────────────────────────────────────────────────────

  private onPost(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastPostMs.get(userId) || 0) < POST_COOLDOWN_MS) {
      this.notice(ctx, userId, "The pin is still warm; give it a moment.");
      return;
    }
    this.lastPostMs.set(userId, now);

    const session = this.sessions.get(userId);
    const board = toFormId(content["board"]);
    if (!session || !board || session.primary !== board) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    if (!this.withinReach(ctx, actorId, session.refr)) {
      this.notice(ctx, userId, "You are too far from the board.");
      return;
    }

    const rawText = content["text"];
    if (typeof rawText !== "string") return;
    // Bound the work before sanitize walks the payload.
    if (rawText.length > this.maxTextLen * 4) {
      this.notice(ctx, userId, `A notice holds ${this.maxTextLen} characters at most.`);
      return;
    }
    const text = sanitize(rawText);
    if (!text) return;
    if (text.length > this.maxTextLen) {
      this.notice(ctx, userId, `A notice holds ${this.maxTextLen} characters at most.`);
      return;
    }

    const rec = this.read(ctx, session.primary) || emptyRecord();
    const pruned = this.prune(ctx, session.primary, rec);
    if (rec.notes.length >= this.maxNotes) {
      if (pruned) this.write(ctx, session.primary, rec);
      this.notice(ctx, userId, "The board is full. Older notices must fade first.");
      return;
    }

    // The fee is taken only once everything else has passed.
    if (this.costGold > 0 && !this.takeGold(ctx, actorId, this.costGold)) {
      if (pruned) this.write(ctx, session.primary, rec);
      this.notice(ctx, userId, `Pinning a notice costs ${this.costGold} gold, and you do not have it.`);
      return;
    }
    const stash = this.costGold > 0 ? this.stashOf(ctx, session.primary, rec) : 0;

    const author = titledName(this.titleOf(actorId), displayNameOf(ctx.svr, actorId));
    rec.notes.push({
      id: rec.nextId,
      author,
      profileId: profileIdOf(ctx.svr, actorId),
      text,
      createdAt: now,
    });
    rec.nextId += 1;
    if (!this.write(ctx, session.primary, rec)) {
      // The board cannot hold the record; give the fee back.
      try { addGold(ctx.svr, actorId, this.costGold); }
      catch (e) { this.log(`[bounty] could not refund gold to ${actorId.toString(16)}: ${e}`); }
      this.appendLog(`${describeActor(ctx.svr, actorId)} failed to post on the ${session.name} board, fee refunded`);
      this.notice(ctx, userId, "The board would not take your notice.");
      return;
    }

    if (stash) {
      try { addGold(ctx.svr, stash, this.costGold); }
      catch (e) { this.log(`[bounty] could not put the fee in strongbox ${stash.toString(16)}: ${e}`); }
    }
    const fee = stash ? `${this.costGold} gold to the board strongbox` : `-${this.costGold} gold`;
    this.appendLog(`${describeActor(ctx.svr, actorId)} posted on the ${session.name} board (${fee}): ${JSON.stringify(text)}`);
    this.notice(ctx, userId, "Your notice is pinned to the board.");
    this.refreshViewers(ctx, session.primary);
  }

  private onRemove(ctx: SystemContext, userId: number, content: Content): void {
    const session = this.sessions.get(userId);
    const id = Number(content["id"]);
    if (!session || !Number.isInteger(id) || id < 1 || toFormId(content["board"]) !== session.primary) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId || !this.withinReach(ctx, actorId, session.refr)) return;
    if (!this.canRemove(actorId, session.name)) return this.notice(ctx, userId, "Only non-citizen members of this hold may remove notices.");
    const rec = this.read(ctx, session.primary) || emptyRecord();
    const at = rec.notes.findIndex((note) => note.id === id);
    if (at < 0) return this.notice(ctx, userId, "That notice is no longer on this board.");
    const [note] = rec.notes.splice(at, 1);
    if (!this.write(ctx, session.primary, rec)) return this.notice(ctx, userId, "The board would not remove that notice.");
    this.appendLog(`${describeActor(ctx.svr, actorId)} removed note ${note.id} from the ${session.name} board: ${JSON.stringify(note.text)}`);
    this.refreshViewers(ctx, session.primary);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number, reason: "open" | "refresh"): void {
    const session = this.sessions.get(userId);
    if (!session) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const rec = this.read(ctx, session.primary) || emptyRecord();
    if (this.prune(ctx, session.primary, rec)) this.write(ctx, session.primary, rec);
    const now = Date.now();
    this.send(ctx, userId, {
      customPacketType: "bountyBoardMenu",
      board: session.primary,
      boardName: session.name,
      reason,
      costGold: this.costGold,
      gold: this.goldOf(ctx, actorId),
      maxTextLen: this.maxTextLen,
      maxNotes: this.maxNotes,
      expiryDays: this.expiryDays,
      canRemove: this.canRemove(actorId, session.name),
      notes: rec.notes.map((n) => ({
        id: n.id,
        author: n.author,
        text: n.text,
        ageHours: Math.max(0, Math.floor((now - n.createdAt) / 3600000)),
      })),
    });
  }

  // A new notice shows up for everyone standing at that board.
  private refreshViewers(ctx: SystemContext, primary: number): void {
    this.sessions.forEach((session, userId) => {
      if (session.primary === primary) this.sendMenu(ctx, userId, "refresh");
    });
  }

  // ── Expiry ──────────────────────────────────────────────────────────────────

  // Drops notes past their week, logging each; true when anything fell off.
  private prune(ctx: SystemContext, primary: number, rec: BoardRecord): boolean {
    const cutoff = Date.now() - this.expiryDays * 24 * 3600000;
    const kept: BoardNote[] = [];
    let dropped = false;
    for (const note of rec.notes) {
      if (note.createdAt > cutoff) {
        kept.push(note);
        continue;
      }
      dropped = true;
      const name = this.boardNameOf(primary);
      this.appendLog(`note ${note.id} by [profile ${note.profileId}] ${JSON.stringify(note.author)} faded from the ${name} board: ${JSON.stringify(note.text)}`);
    }
    rec.notes = kept;
    return dropped;
  }

  private primaries(): Set<number> {
    const primaries = new Set<number>();
    this.knownBoards.forEach((b) => primaries.add(b.primary));
    return primaries;
  }

  private boardNameOf(primary: number): string {
    const board = this.knownBoards.get(primary);
    return board ? board.name : "Missive";
  }

  // ── Gold ────────────────────────────────────────────────────────────────────

  private goldOf(ctx: SystemContext, actorId: number): number {
    const mp = ctx.svr as Mp;
    let total = 0;
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      for (const e of entries) {
        if ((Number(e?.baseId) >>> 0) === GOLD_BASE_ID) total += Number(e?.count) || 0;
      }
    } catch { /* actor gone */ }
    return total;
  }

  // False when the actor cannot pay; nothing is taken then.
  private takeGold(ctx: SystemContext, actorId: number, amount: number): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries.slice() : [];
      let held = 0;
      for (const e of entries) {
        if ((Number(e?.baseId) >>> 0) === GOLD_BASE_ID) held += Number(e?.count) || 0;
      }
      if (held < amount) return false;
      let remaining = amount;
      for (const e of entries) {
        if (remaining <= 0) break;
        if ((Number(e?.baseId) >>> 0) !== GOLD_BASE_ID) continue;
        const take = Math.min(Number(e.count) || 0, remaining);
        e.count -= take;
        remaining -= take;
      }
      if (remaining > 0) return false;
      mp.set(actorId, "inventory", { entries: entries.filter((e: any) => (Number(e?.count) || 0) > 0) });
      return true;
    } catch (e) {
      this.log(`[bounty] could not take gold from ${actorId.toString(16)}: ${e}`);
      return false;
    }
  }

  // ── Strongbox ───────────────────────────────────────────────────────────────

  // X on a board: a manager opens the strongbox through the engine's own container path, which records the occupant
  private onManage(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const refr = toFormId(content["board"]);
    const board = this.boardOf(ctx, refr);
    if (!board) return;
    if (!this.withinReach(ctx, actorId, refr)) return this.notice(ctx, userId, "You are too far from the board.");
    if (!this.canManage(actorId, board.name)) return this.notice(ctx, userId, NOT_MANAGER_NOTICE);
    const stash = this.stashOf(ctx, board.primary, this.read(ctx, board.primary) || emptyRecord());
    if (!stash) return this.notice(ctx, userId, "This board has no strongbox.");
    try {
      // The Tamriel twin of a walled city is another worldspace, and the engine refuses an activation across worldspaces
      if (mp.get(actorId, "worldOrCellDesc") !== mp.get(stash, "worldOrCellDesc")) {
        return this.notice(ctx, userId, "Open the strongbox from the board inside the city.");
      }
      const self = { type: "form", desc: mp.getDescFromId(stash) };
      mp.callPapyrusFunction("method", "ObjectReference", "Activate", self, [{ type: "form", desc: mp.getDescFromId(actorId) }, false]);
    } catch (e) {
      this.log(`[bounty] could not open the ${board.name} board strongbox for ${actorId.toString(16)}: ${e}`);
      return;
    }
    this.appendLog(`${describeActor(ctx.svr, actorId)} opened the ${board.name} board strongbox`);
  }

  // The board's strongbox, placed at the canonical board on first use; 0 when none can be had
  private stashOf(ctx: SystemContext, primary: number, rec: BoardRecord): number {
    const mp = ctx.svr as Mp;
    if (rec.stash && this.isStash(ctx, rec.stash)) {
      this.stashes.set(rec.stash, primary);
      return rec.stash;
    }
    if (!this.worldLoaded || !this.stashDesc) return 0;
    let stash = 0;
    try {
      stash = placeAtMe(mp, primary, this.stashDesc) >>> 0;
      mp.set(stash, "inventory", { entries: [] });
    } catch (e) {
      this.log(`[bounty] could not place the ${this.boardNameOf(primary)} board strongbox: ${e}`);
      return 0;
    }
    rec.stash = stash;
    if (!this.write(ctx, primary, rec)) return 0;
    this.stashes.set(stash, primary);
    this.log(`[bounty] placed the ${this.boardNameOf(primary)} board strongbox ${stash.toString(16)}`);
    return stash;
  }

  // A stale id from an earlier run is no strongbox
  private isStash(ctx: SystemContext, refrId: number): boolean {
    return baseTypeOf(ctx.svr as Mp, refrId) === "CONT";
  }

  // ── Board resolution ────────────────────────────────────────────────────────

  // Known placements resolve from the table; anything else is checked against
  // the Missives activator base, so a patch may add boards without code work.
  private boardOf(ctx: SystemContext, refrId: number): { primary: number; name: string } | null {
    if (!this.boardBaseIds.size || !refrId) return null;
    const known = this.knownBoards.get(refrId);
    if (known) return known;
    if (!this.boardBaseIds.has(this.baseIdOf(ctx, refrId))) return null;
    const board = { primary: refrId, name: "Missive" };
    this.knownBoards.set(refrId, board);
    return board;
  }

  // The base object behind a placed reference, from the ESM's NAME field.
  private baseIdOf(ctx: SystemContext, refrId: number): number {
    const cached = this.baseIdCache.get(refrId);
    if (cached !== undefined) return cached;
    const baseId = espmRefrFieldId(ctx.svr as Mp, refrId, "NAME");
    // ESM data never changes, so overflow can just start the cache over.
    if (this.baseIdCache.size >= MAX_ESPM_CACHE) this.baseIdCache.clear();
    this.baseIdCache.set(refrId, baseId);
    return baseId;
  }

  // Posting has to happen at the board, not from a form id typed into a packet.
  private withinReach(ctx: SystemContext, actorId: number, refrId: number): boolean {
    const mp = ctx.svr as Mp;
    let a: any, b: any;
    try {
      a = mp.get(actorId, "pos");
      b = mp.get(refrId, "pos");
    } catch {
      return true; // position unavailable: do not block a legitimate action
    }
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    const dz = Number(a[2]) - Number(b[2]);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(d2)) return true;
    return d2 <= this.maxDistance * this.maxDistance;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  // Re-validates and re-bounds everything: a changeform edited by hand must
  // not be amplified to every viewer or wedge the board.
  private read(ctx: SystemContext, primary: number): BoardRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(primary, BOARD_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Partial<BoardRecord>;
      const now = Date.now();
      const notes: BoardNote[] = [];
      if (Array.isArray(r.notes)) {
        for (const n of r.notes) {
          if (notes.length >= this.maxNotes) break;
          if (!n || typeof n !== "object") continue;
          const text = typeof n.text === "string" ? n.text.slice(0, this.maxTextLen) : "";
          if (!text) continue;
          notes.push({
            id: Number(n.id) || 0,
            author: typeof n.author === "string" ? n.author.slice(0, 100) : "Unknown",
            profileId: Number.isFinite(Number(n.profileId)) ? Number(n.profileId) : -1,
            text,
            // A future stamp would make the note immortal.
            createdAt: Math.min(Number(n.createdAt) || 0, now),
          });
        }
      }
      const rec: BoardRecord = { nextId: Math.max(1, Number(r.nextId) || 1), notes };
      if (Number(r.stash) > 0) rec.stash = Number(r.stash) >>> 0;
      return rec;
    } catch {
      return null;
    }
  }

  // Notices and ids trade places; each strongbox stays with the primary it was placed at
  private swapMisfiledNotes(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    let a = 0, b = 0;
    try {
      [a, b] = SWAPPED_PRIMARIES.map((desc) => mp.getIdFromDesc(desc) >>> 0);
      if (mp.get(a, SWAP_DONE_PROP)) return;
    } catch { return; }
    const ra = this.read(ctx, a) || emptyRecord();
    const rb = this.read(ctx, b) || emptyRecord();
    const na: BoardRecord = { nextId: rb.nextId, notes: rb.notes, ...(ra.stash ? { stash: ra.stash } : {}) };
    const nb: BoardRecord = { nextId: ra.nextId, notes: ra.notes, ...(rb.stash ? { stash: rb.stash } : {}) };
    if (!this.write(ctx, a, na)) return;
    if (!this.write(ctx, b, nb)) {
      this.write(ctx, a, ra);
      return;
    }
    try { mp.set(a, SWAP_DONE_PROP, true); }
    catch (e) { this.log(`[bounty] could not mark the Riften and Windhelm swap done: ${e}`); }
    this.log(`[bounty] moved ${rb.notes.length} notices to Riften and ${ra.notes.length} to Windhelm`);
  }

  private write(ctx: SystemContext, primary: number, rec: BoardRecord): boolean {
    try {
      (ctx.svr as Mp).set(primary, BOARD_PROP, rec);
      return true;
    } catch (e) {
      this.log(`[bounty] write failed for ${primary.toString(16)}: ${e}`);
      return false;
    }
  }

  private appendLog(text: string): void {
    appendLog(this.logDir, "bounty.log", text);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
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

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    sendJson(ctx.svr, userId, payload);
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "bountyBoardNotice", text });
  }

  private costGold = DEFAULT_COST_GOLD;
  private expiryDays = DEFAULT_EXPIRY_DAYS;
  private maxNotes = DEFAULT_MAX_NOTES;
  private maxTextLen = DEFAULT_MAX_TEXT_LEN;
  private maxDistance = DEFAULT_MAX_DISTANCE;
  private logDir = "C:\\logs";
  private stashDesc = "";
  private worldLoaded = false;
  // Strongbox reference to the canonical board it belongs to
  private stashes = new Map<number, number>();
  private boardBaseIds = new Set<number>();
  private knownBoards = new Map<number, { primary: number; name: string }>();
  private baseIdCache = new Map<number, number>();
  private sessions = new Map<number, BoardSession>();
  private lastPostMs = new Map<number, number>();
  private lastOpenMs = new Map<number, number>();
  private spotCache = new Map<number, { pos: number[]; where: string } | null>();
  private lastSweepMs = 0;
}
