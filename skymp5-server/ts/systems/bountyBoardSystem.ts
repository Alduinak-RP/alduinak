import * as fs from "fs";
import * as path from "path";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";

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
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "bountyBoardOpenRequest" }
//     { customPacketType: "bountyBoardPost", board: <refrId>, text }
//     { customPacketType: "bountyBoardClose" }
//   Server -> Client:
//     { customPacketType: "bountyBoardMenu", board, boardName, reason,
//       costGold, gold, maxTextLen, maxNotes, expiryDays,
//       notes: [{ id, author, text, ageHours }] }
//     { customPacketType: "bountyBoardNotice", text }
//
// Persistence: `private.bountyBoard` on the canonical board reference, which
// rides the changeform into Mongo and comes back on restart. Notices expire
// lazily on every read plus a slow sweep, so correctness does not depend on
// the sweep having run.
//
// Every post and expiry is appended to bounty.log in the shared log directory.
//
// server-settings.json keys (all optional):
//   bountyBoardCostGold     price of pinning a notice, default 25
//   bountyBoardExpiryDays   days a notice stays up, default 7
//   bountyBoardMaxNotes     notices one board holds, default 40
//   bountyBoardMaxTextLen   characters per notice, default 500
//   bountyBoardMaxDistance  posting reach in game units, default 512

const BOARD_PROP = "private.bountyBoard";

// The board comes as two bases: the named, visible activator players actually
// hit with the crosshair (_M_MissiveBoard, "Missive Board") and the invisible
// script primitive singleplayer uses (_M_ActivatorBoard). Both are boards.
const BOARD_BASE_DESCS = ["12cb:Missives.esp", "d65:Missives.esp"];

const GOLD_BASE_ID = 0x0000000f;

const DEFAULT_COST_GOLD = 25;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_MAX_NOTES = 40;
const DEFAULT_MAX_TEXT_LEN = 500;
const DEFAULT_MAX_DISTANCE = 512;

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
  { name: "Riften", descs: ["9478:Missives.esp", "9491:Missives.esp", "21844:Missives.esp", "2183f:Missives.esp"] },
  { name: "Windhelm", descs: ["9492:Missives.esp", "9477:Missives.esp", "2183a:Missives.esp", "21845:Missives.esp"] },
  { name: "Markarth", descs: ["94a3:Missives.esp", "94a2:Missives.esp", "21840:Missives.esp", "21841:Missives.esp"] },
  { name: "Solitude", descs: ["9490:Missives.esp", "948f:Missives.esp", "21838:Missives.esp", "21839:Missives.esp"] },
  { name: "Dawnstar", descs: ["94b1:Missives.esp", "94ae:Missives.esp"] },
  { name: "Winterhold", descs: ["94b5:Missives.esp", "94b2:Missives.esp"] },
  { name: "Morthal", descs: ["94ad:Missives.esp", "94aa:Missives.esp"] },
  { name: "Falkreath", descs: ["94a9:Missives.esp", "94a6:Missives.esp"] },
];

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

    this.logDir = process.env.ALDUINAK_LOG_DIR || String(all?.["logDir"] || "") || "C:\\logs";
    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* appendFile will complain */ }

    const mp = ctx.svr as Mp;
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

  // True when the target is a board and the menu was taken care of.
  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
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
    const primaries = new Set<number>();
    this.knownBoards.forEach((b) => primaries.add(b.primary));
    for (const primary of primaries) {
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
    const text = this.sanitize(rawText);
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

    const author = this.displayNameOf(ctx, actorId);
    rec.notes.push({
      id: rec.nextId,
      author,
      profileId: this.profileIdOf(ctx, actorId),
      text,
      createdAt: now,
    });
    rec.nextId += 1;
    if (!this.write(ctx, session.primary, rec)) {
      // The board cannot hold the record; give the fee back.
      this.giveGold(ctx, actorId, this.costGold);
      this.appendLog(`${this.describeActor(ctx, actorId)} failed to post on the ${session.name} board, fee refunded`);
      this.notice(ctx, userId, "The board would not take your notice.");
      return;
    }

    this.appendLog(`${this.describeActor(ctx, actorId)} posted on the ${session.name} board (-${this.costGold} gold): ${JSON.stringify(text)}`);
    this.notice(ctx, userId, "Your notice is pinned to the board.");
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

  private giveGold(ctx: SystemContext, actorId: number, amount: number): void {
    if (amount <= 0) return;
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries.slice() : [];
      const stack = entries.find((e: any) => (Number(e?.baseId) >>> 0) === GOLD_BASE_ID);
      if (stack) stack.count = (Number(stack.count) || 0) + amount;
      else entries.push({ baseId: GOLD_BASE_ID, count: amount });
      mp.set(actorId, "inventory", { entries });
    } catch (e) {
      this.log(`[bounty] could not refund gold to ${actorId.toString(16)}: ${e}`);
    }
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
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try {
      const refr = mp.lookupEspmRecordById(refrId);
      const local = this.readFormIdField(refr, "NAME");
      if (local && typeof refr.toGlobalRecordId === "function") {
        baseId = refr.toGlobalRecordId(local) >>> 0;
      }
    } catch { /* not an espm reference */ }
    // ESM data never changes, so overflow can just start the cache over.
    if (this.baseIdCache.size >= MAX_ESPM_CACHE) this.baseIdCache.clear();
    this.baseIdCache.set(refrId, baseId);
    return baseId;
  }

  // First four bytes of a field, little-endian: a plugin-local form id.
  private readFormIdField(lookup: any, fieldType: string): number {
    const fields = lookup && lookup.record && Array.isArray(lookup.record.fields) ? lookup.record.fields : [];
    const field = fields.filter((f: any) => f && f.type === fieldType)[0];
    if (!field || !field.data || field.data.length < 4) return 0;
    const b = field.data;
    return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
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
      return { nextId: Math.max(1, Number(r.nextId) || 1), notes };
    } catch {
      return null;
    }
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

  // ── Names and audit ─────────────────────────────────────────────────────────

  // While masked, appearance.name is already the placeholder and the real
  // name sits in maskName (40_chat_commands.js), so the actor name is the
  // name others see and a mask holds at the board.
  private displayNameOf(ctx: SystemContext, actorId: number): string {
    try { return String((ctx.svr as Mp).getActorName(actorId) || "Unknown"); } catch { return "Unknown"; }
  }

  // The stashed original while masked, for the audit trail only.
  private realNameOf(ctx: SystemContext, actorId: number): string {
    let stashed = "";
    try { stashed = String((ctx.svr as Mp).get(actorId, "maskName") || "").trim(); } catch { /* unmasked */ }
    return stashed || this.displayNameOf(ctx, actorId);
  }

  private profileIdOf(ctx: SystemContext, actorId: number): number {
    try {
      const profileId = Number((ctx.svr as Mp).get(actorId, "profileId"));
      return Number.isFinite(profileId) ? profileId : -1;
    } catch {
      return -1;
    }
  }

  // JSON-quoted real name plus a fixed-position profile id, so a crafted
  // character name cannot forge another player's line.
  private describeActor(ctx: SystemContext, actorId: number): string {
    const real = this.realNameOf(ctx, actorId);
    const shown = this.displayNameOf(ctx, actorId);
    const mask = shown !== real ? ` (as ${JSON.stringify(shown)})` : "";
    return `[profile ${this.profileIdOf(ctx, actorId)}] ${JSON.stringify(real)}${mask}`;
  }

  private appendLog(text: string): void {
    try {
      fs.appendFile(path.join(this.logDir, "bounty.log"), new Date().toISOString() + " " + text + "\n", () => { });
    } catch { /* log only */ }
  }

  // Keeps line breaks, drops every other control character.
  private sanitize(raw: unknown): string {
    if (typeof raw !== "string") return "";
    let out = "";
    for (const ch of raw) {
      const code = ch.charCodeAt(0);
      if (ch === "\n") { out += ch; continue; }
      if (code < 0x20 || code === 0x7f) continue;
      out += ch;
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
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
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
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
  private boardBaseIds = new Set<number>();
  private knownBoards = new Map<number, { primary: number; name: string }>();
  private baseIdCache = new Map<number, number>();
  private sessions = new Map<number, BoardSession>();
  private lastPostMs = new Map<number, number>();
  private lastOpenMs = new Map<number, number>();
  private spotCache = new Map<number, { pos: number[]; where: string } | null>();
  private lastSweepMs = 0;
}
