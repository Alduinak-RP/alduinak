import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Player search ─────────────────────────────────────────────────────────────
//
// Lets one player go through another's inventory with consent, using the
// VANILLA container window: on accept the server marks the searcher as the
// target actor's inventory occupant (setInventoryOccupant native), which is
// what authorizes the engine's PutItem/TakeItem messages, and tells the
// searcher's client to open the target's inventory. Item moves then ride the
// normal container-sync path (ContainersService -> TakeItem/PutItem), fully
// server-validated. If the pair separates, the session ends and the client is
// told to close the window.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "searchRequest", target: <actorFormId> }
//     { customPacketType: "searchConsentResult", requestId, accepted }
//   Server -> Client:
//     { customPacketType: "searchConsentRequest", requestId, text }  // -> target
//     { customPacketType: "searchApproved", target }                 // -> searcher: open the window
//     { customPacketType: "searchClose" }                            // -> searcher: close it
//     { customPacketType: "searchNotice", text }                     // corner toast

// Defaults; overridable via "searchConsentTimeoutMs" / "searchConsentCooldownMs".
const DEFAULT_CONSENT_TIMEOUT_MS = 20000;
const DEFAULT_CONSENT_COOLDOWN_MS = 15000;

// Initiation range mirrors CaptureSystem's activate-range backstop. Overridable via "searchStartMaxDistance".
const DEFAULT_START_MAX_DISTANCE = 256;
// The window closes when the pair drifts further apart than this. Overridable via "searchKeepMaxDistance".
const DEFAULT_KEEP_MAX_DISTANCE = 512;
// Distance re-check cadence.
const WATCH_INTERVAL_MS = 500;

interface PendingConsent {
  searcherActorId: number;
  targetActorId: number;
  timer: ReturnType<typeof setTimeout>;
}

interface SearchSession {
  searcherActorId: number;
  targetActorId: number;
}

const toFormId = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v >>> 0;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) {
      return n >>> 0;
    }
  }
  return 0;
};

export class SearchSystem implements System {
  systemName = "SearchSystem";
  constructor(private log: Log) { }

  // targetActorId -> session (a target is searched by at most one player)
  private sessions = new Map<number, SearchSession>();
  // searcherActorId -> targetActorId (reverse lookup)
  private searching = new Map<number, number>();
  // requestId -> outstanding consent prompt
  private pending = new Map<number, PendingConsent>();
  // "searcherActorId:targetActorId" -> last prompt timestamp (spam guard)
  private consentCooldown = new Map<string, number>();
  private nextRequestId = 1;
  private lastWatchMs = 0;
  private warnedNoNative = false;
  private consentTimeoutMs = DEFAULT_CONSENT_TIMEOUT_MS;
  private consentCooldownMs = DEFAULT_CONSENT_COOLDOWN_MS;
  private startMaxDistance = DEFAULT_START_MAX_DISTANCE;
  private keepMaxDistance = DEFAULT_KEEP_MAX_DISTANCE;

  async initAsync(_ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    const rawStart = Number(all?.["searchStartMaxDistance"]);
    if (Number.isFinite(rawStart) && rawStart > 0) this.startMaxDistance = rawStart;
    const rawKeep = Number(all?.["searchKeepMaxDistance"]);
    if (Number.isFinite(rawKeep) && rawKeep > 0) this.keepMaxDistance = rawKeep;
    const rawTimeout = Number(all?.["searchConsentTimeoutMs"]);
    if (Number.isInteger(rawTimeout) && rawTimeout > 0) this.consentTimeoutMs = rawTimeout;
    const rawCooldown = Number(all?.["searchConsentCooldownMs"]);
    if (Number.isInteger(rawCooldown) && rawCooldown >= 0) this.consentCooldownMs = rawCooldown;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "searchRequest": this.onSearchRequest(ctx, userId, content); break;
      case "searchConsentResult": this.onConsentResult(ctx, userId, content); break;
      default: break;
    }
  }

  // Watch every active pair; end the search when they drift apart.
  async updateAsync(ctx: SystemContext): Promise<void> {
    if (this.sessions.size === 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastWatchMs < WATCH_INTERVAL_MS) {
      return;
    }
    this.lastWatchMs = now;
    for (const s of Array.from(this.sessions.values())) {
      // A side that lost its user (character switch, logout-grace park) ends the search
      if (this.userOf(ctx, s.searcherActorId) < 0 || this.userOf(ctx, s.targetActorId) < 0) {
        this.endSession(ctx, s, "");
        continue;
      }
      if (!this.nearEnough(ctx, s.searcherActorId, s.targetActorId, this.keepMaxDistance)) {
        this.endSession(ctx, s, "They moved away.");
      }
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId); } catch { return; }
    if (!actorId) {
      return;
    }
    const targetOfMine = this.searching.get(actorId);
    if (targetOfMine !== undefined) {
      const s = this.sessions.get(targetOfMine);
      if (s) {
        this.endSession(ctx, s, "");
      }
    }
    const asTarget = this.sessions.get(actorId);
    if (asTarget) {
      this.endSession(ctx, asTarget, "They disconnected.");
    }
    for (const [id, pend] of Array.from(this.pending)) {
      if (pend.searcherActorId === actorId || pend.targetActorId === actorId) {
        clearTimeout(pend.timer);
        this.pending.delete(id);
      }
    }
  }

  // ── Incoming requests ───────────────────────────────────────────────────────

  private onSearchRequest(ctx: SystemContext, userId: number, content: Content): void {
    const searcherActorId = this.resolveActor(ctx, userId);
    if (searcherActorId === null) {
      return;
    }
    if (!this.hasOccupantNative(ctx)) {
      this.notice(ctx, userId, "Searching needs a newer server build.");
      if (!this.warnedNoNative) {
        this.warnedNoNative = true;
        this.log("[search] setInventoryOccupant native missing - rebuild the server (CI) to enable searches");
      }
      return;
    }
    const targetActorId = toFormId(content.target);
    if (!this.validTarget(ctx, searcherActorId, targetActorId)) {
      this.notice(ctx, userId, "Look at another player to search them.");
      return;
    }
    if (this.sessions.has(targetActorId)) {
      this.notice(ctx, userId, `${this.nameShownTo(ctx, searcherActorId, targetActorId)} is already being searched.`);
      return;
    }
    if (this.searching.has(searcherActorId)) {
      this.notice(ctx, userId, "You are already searching someone.");
      return;
    }
    for (const pend of this.pending.values()) {
      if (pend.targetActorId === targetActorId || pend.searcherActorId === searcherActorId) {
        this.notice(ctx, userId, "A search request is already pending.");
        return;
      }
    }
    const now = Date.now();
    const cooldownKey = `${searcherActorId}:${targetActorId}`;
    const lastPrompt = this.consentCooldown.get(cooldownKey);
    if (lastPrompt !== undefined && now - lastPrompt < this.consentCooldownMs) {
      this.notice(ctx, userId, `Wait before asking ${this.nameShownTo(ctx, searcherActorId, targetActorId)} again.`);
      return;
    }
    if (this.consentCooldown.size > 512) {
      for (const [k, t] of Array.from(this.consentCooldown)) {
        if (now - t >= this.consentCooldownMs) {
          this.consentCooldown.delete(k);
        }
      }
    }
    this.consentCooldown.set(cooldownKey, now);

    const targetUser = this.userOf(ctx, targetActorId);
    if (targetUser < 0) {
      return;
    }
    const requestId = this.nextRequestId++;
    const timer = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        this.notice(ctx, this.userOf(ctx, searcherActorId),
          `${this.nameShownTo(ctx, searcherActorId, targetActorId)} did not respond.`);
      }
    }, this.consentTimeoutMs);
    this.pending.set(requestId, { searcherActorId, targetActorId, timer });

    const searcherName = this.nameShownTo(ctx, targetActorId, searcherActorId);
    ctx.svr.sendCustomPacket(targetUser, JSON.stringify({
      customPacketType: "searchConsentRequest",
      requestId,
      text: `${searcherName} wants to search you. Allow?`,
    }));
    this.notice(ctx, userId, `Waiting for ${this.nameShownTo(ctx, searcherActorId, targetActorId)} to accept…`);
  }

  private onConsentResult(ctx: SystemContext, userId: number, content: Content): void {
    const requestId = Number(content.requestId);
    const pend = this.pending.get(requestId);
    if (!pend) {
      return;
    }
    // The answer must come from the player who was actually prompted.
    const responderActorId = this.resolveActor(ctx, userId);
    if (responderActorId !== pend.targetActorId) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pend.timer);

    const searcherUser = this.userOf(ctx, pend.searcherActorId);
    if (content.accepted !== true) {
      this.notice(ctx, searcherUser, `${this.nameShownTo(ctx, pend.searcherActorId, pend.targetActorId)} refused the search.`);
      return;
    }
    if (searcherUser < 0) {
      return; // searcher left while we waited
    }
    if (!this.validTarget(ctx, pend.searcherActorId, pend.targetActorId)) {
      this.notice(ctx, searcherUser, `${this.nameShownTo(ctx, pend.searcherActorId, pend.targetActorId)} is out of reach.`);
      return;
    }
    if (this.sessions.has(pend.targetActorId) || this.searching.has(pend.searcherActorId)) {
      return; // state changed while waiting
    }
    if (!this.setOccupant(ctx, pend.targetActorId, pend.searcherActorId)) {
      this.notice(ctx, searcherUser, "The search could not start.");
      return;
    }
    const session: SearchSession = {
      searcherActorId: pend.searcherActorId,
      targetActorId: pend.targetActorId,
    };
    this.sessions.set(pend.targetActorId, session);
    this.searching.set(pend.searcherActorId, pend.targetActorId);
    ctx.svr.sendCustomPacket(searcherUser, JSON.stringify({
      customPacketType: "searchApproved",
      target: pend.targetActorId,
      // Simple stacks of the real inventory: the searcher's local clone only
      // mirrors equipment, so the client tops it up before opening the window
      entries: this.simpleEntriesOf(ctx, pend.targetActorId),
    }));
    this.notice(ctx, this.userOf(ctx, pend.targetActorId),
      `${this.nameShownTo(ctx, pend.targetActorId, pend.searcherActorId)} is searching you.`);
    this.log(`[search] ${pend.searcherActorId.toString(16)} searches ${pend.targetActorId.toString(16)}`);
  }

  // ── Session teardown ────────────────────────────────────────────────────────

  private endSession(ctx: SystemContext, s: SearchSession, reasonForSearcher: string): void {
    this.sessions.delete(s.targetActorId);
    this.searching.delete(s.searcherActorId);
    this.setOccupant(ctx, s.targetActorId, 0);
    const searcherUser = this.userOf(ctx, s.searcherActorId);
    if (searcherUser >= 0) {
      try {
        ctx.svr.sendCustomPacket(searcherUser, JSON.stringify({ customPacketType: "searchClose" }));
      } catch { /* user gone */ }
      if (reasonForSearcher) {
        this.notice(ctx, searcherUser, reasonForSearcher);
      }
    }
  }

  // ── Small helpers ───────────────────────────────────────────────────────────

  private hasOccupantNative(ctx: SystemContext): boolean {
    return typeof (ctx.svr as Mp).setInventoryOccupant === "function";
  }

  private setOccupant(ctx: SystemContext, targetActorId: number, occupantActorId: number): boolean {
    try {
      (ctx.svr as Mp).setInventoryOccupant(targetActorId, occupantActorId);
      return true;
    } catch (e) {
      this.log(`[search] setInventoryOccupant failed: ${e}`);
      return false;
    }
  }

  private validTarget(ctx: SystemContext, selfActorId: number, targetActorId: number): boolean {
    if (!targetActorId || targetActorId === selfActorId) {
      return false;
    }
    if (this.userOf(ctx, targetActorId) < 0) {
      return false; // must be a connected player, not an NPC
    }
    if (this.isPermaDead(ctx.svr as Mp, targetActorId)) {
      return false;
    }
    return this.nearEnough(ctx, selfActorId, targetActorId, this.startMaxDistance);
  }

  private nearEnough(ctx: SystemContext, aActorId: number, bActorId: number, max: number): boolean {
    try {
      if (ctx.svr.getActorCellOrWorld(aActorId) !== ctx.svr.getActorCellOrWorld(bActorId)) {
        return false;
      }
      const a = ctx.svr.getActorPos(aActorId);
      const b = ctx.svr.getActorPos(bActorId);
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz <= max * max;
    } catch {
      return false;
    }
  }

  private isPermaDead(mp: Mp, actorId: number): boolean {
    try {
      return mp.get(actorId, "private.permaDead") === true;
    } catch {
      return false;
    }
  }

  private resolveActor(ctx: SystemContext, userId: number): number | null {
    try {
      const a = ctx.svr.getUserActor(userId);
      return a ? a : null;
    } catch {
      return null;
    }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      const u = ctx.svr.getUserByActor(actorId);
      if (typeof u !== "number" || u < 0 || u >= 0xffff || !ctx.svr.isConnected(u)) {
        return -1;
      }
      return u;
    } catch {
      return -1;
    }
  }

  private nameOf(ctx: SystemContext, actorId: number): string {
    try {
      const n = ctx.svr.getActorName(actorId);
      return typeof n === "string" ? n.trim() : "";
    } catch {
      return "";
    }
  }

  // The subject's name as the viewer may see it: real once introduced
  // (gamemode ff_knownIds), otherwise the anonymity placeholder.
  private nameShownTo(ctx: SystemContext, viewerActorId: number, subjectActorId: number): string {
    try {
      const known = (ctx.svr as Mp).get(viewerActorId, "ff_knownIds");
      if (Array.isArray(known) && !known.includes(subjectActorId)) {
        return "A stranger";
      }
    } catch { /* fall through to the real name */ }
    return this.nameOf(ctx, subjectActorId) || "Someone";
  }

  // Plain {baseId, count} stacks without extra data, mirroring what TakeItem can move
  private simpleEntriesOf(ctx: SystemContext, actorId: number): { baseId: number, count: number }[] {
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory");
      const entries: any[] = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries
        .filter((e) => e && typeof e.baseId === "number" && (e.count | 0) > 0)
        .map((e) => ({ baseId: e.baseId >>> 0, count: e.count | 0 }));
    } catch {
      return [];
    }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    if (userId < 0) {
      return;
    }
    try {
      ctx.svr.sendCustomPacket(userId, JSON.stringify({ customPacketType: "searchNotice", text }));
    } catch { /* user gone */ }
  }
}
