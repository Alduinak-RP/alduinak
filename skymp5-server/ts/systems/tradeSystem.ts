import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import {
  Item, InventoryEntry, Inventory, isKeyItem, sameBase, hasIdentityExtras, sameItem, lineKey,
  readInventory, copyValidExtras, withCount, addEntries, describeExtras,
} from "./inventoryExtras";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Player-to-player trade ────────────────────────────────────────────────────
//
// Server-authoritative barter between two players; lives in server core so it survives gamemode hot reloads. The shipped client TradeService speaks exactly this protocol.
//
// Flow: tradeRequest -> tradeInvite accept/decline -> both edit offers (tradeSetOffer resets locks) -> both tradeLock -> both tradeAccept, then the server swaps the items atomically.
// Every item trades; an offer line names one inventory entry by baseId plus its extras, and the swap moves the server's own entries with their extras intact.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server
//     { customPacketType: "tradeRequest", recipient: <remoteActorFormId> }
//     { customPacketType: "tradeRespond", accept: <bool> }
//     { customPacketType: "tradeSetOffer", items: [{ baseId, count, name?, health?, enchantmentId?, maxCharge?,
//         removeEnchantmentOnUnequip?, chargePercent?, soul?, poisonId?, poisonCount?, enchantmentEffects? }] }
//     { customPacketType: "tradeLock" | "tradeUnlock" | "tradeAccept" | "tradeCancel" }
//   Server -> Client
//     { customPacketType: "tradeInvite", fromName }
//     { customPacketType: "tradeState", partnerName, myOffer, theirOffer,
//         myLocked, theirLocked, bothLocked, iAccepted, theyAccepted }
//       myOffer echoes my lines (plain: true when the server holds no copy with those extras);
//       theirOffer lists the server entries that will actually arrive
//     { customPacketType: "tradeCompleted" } | { customPacketType: "tradeCancelled", reason }
//     { customPacketType: "tradeNotice", text }

// Defaults; overridable via "tradeMaxDistance" / "tradeInviteTtlMs" / "tradeInviteCooldownMs".
const DEFAULT_MAX_TRADE_DISTANCE = 1024;      // game units; both must stay within this range
const DEFAULT_INVITE_TTL_MS = 60 * 1000;      // pending invites auto-cancel after this
const DEFAULT_INVITE_COOLDOWN_MS = 30 * 1000; // min gap between invites per initiator->target

// Which server entries an offer draws on; plain[i] marks a line the server only holds without its extras
interface Resolution {
  ok: boolean;
  moved: InventoryEntry[];
  rest: Inventory;
  plain: boolean[];
}

interface Session {
  a: number; // initiator userId
  b: number; // partner userId
  offerA: Item[];
  offerB: Item[];
  lockedA: boolean;
  lockedB: boolean;
  acceptedA: boolean;
  acceptedB: boolean;
  active: boolean; // false while the invite is still pending the partner's reply
  inviteSeq: number; // bumped per (re-)invite so stale TTL timers no-op
}

// ── Pure inventory helpers (operate on the JSON shape of the inventory binding; identity lives in inventoryExtras.ts) ─

// Collapse an offer to positive, integer, de-duplicated lines with validated extras.
function normalizeOffer(items: unknown): Item[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const byLine = new Map<string, Item>();
  for (const raw of items) {
    const baseId = Number((raw as Item)?.baseId);
    const count = Math.floor(Number((raw as Item)?.count));
    if (!Number.isInteger(baseId) || !Number.isInteger(count) || count <= 0) {
      continue;
    }
    const item: Item = { baseId: baseId >>> 0, count };
    copyValidExtras(raw, item);
    const key = lineKey(item);
    const line = byLine.get(key);
    if (line) {
      line.count += count;
    } else {
      byLine.set(key, item);
    }
  }
  return Array.from(byLine.values());
}

// Draw each line from the actor's own entries: exact extras first, then a plain copy for extras the server never saved
function resolveOffer(inv: Inventory, offer: Item[]): Resolution {
  const left = inv.entries.map((e) => e.count);
  const need = offer.map((i) => i.count);
  const moved: InventoryEntry[] = [];
  const draw = (i: number, fits: (e: InventoryEntry) => boolean): void => {
    inv.entries.forEach((e, j) => {
      if (need[i] <= 0 || left[j] <= 0 || !fits(e)) {
        return;
      }
      const n = Math.min(need[i], left[j]);
      left[j] -= n;
      need[i] -= n;
      moved.push(withCount(e, n));
    });
  };
  offer.forEach((item, i) => draw(i, (e) => sameItem(e, item)));
  const plain = offer.map((item, i) => {
    if (need[i] <= 0 || !hasIdentityExtras(item) || isKeyItem(item)) {
      return false;
    }
    const before = need[i];
    draw(i, (e) => sameBase(e, item) && !hasIdentityExtras(e));
    return need[i] < before;
  });
  return {
    ok: need.every((n) => n <= 0),
    moved,
    rest: { entries: inv.entries.map((e, j) => ({ ...e, count: left[j] })).filter((e) => e.count > 0) },
    plain,
  };
}

const offerIsAffordable = (inv: Inventory, offer: Item[]): boolean => resolveOffer(inv, offer).ok;

export class TradeSystem implements System {
  systemName = "TradeSystem";
  constructor(private log: Log) { }

  // Each connected user is in at most one session; both participants point at the same Session object for O(1) lookup from either side
  private sessions = new Map<number, Session>();

  private maxTradeDistance = DEFAULT_MAX_TRADE_DISTANCE;
  private inviteTtlMs = DEFAULT_INVITE_TTL_MS;
  private inviteCooldownMs = DEFAULT_INVITE_COOLDOWN_MS;

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    const rawDist = Number(all?.["tradeMaxDistance"]);
    if (Number.isFinite(rawDist) && rawDist > 0) this.maxTradeDistance = rawDist;
    const rawTtl = Number(all?.["tradeInviteTtlMs"]);
    if (Number.isInteger(rawTtl) && rawTtl > 0) this.inviteTtlMs = rawTtl;
    const rawCooldown = Number(all?.["tradeInviteCooldownMs"]);
    if (Number.isInteger(rawCooldown) && rawCooldown >= 0) this.inviteCooldownMs = rawCooldown;

    // A character switch mid-trade would swap items out of the NEW body; void the deal instead
    ctx.gm.on("userAssignActor", (userId: number) => {
      const s = this.sessions.get(userId);
      if (s && s.active) {
        this.cancel(ctx.svr as Mp, s, 'The trade was interrupted.');
      }
    });
  }
  // "initiatorUserId:targetUserId" -> last invite timestamp (anti focus-steal)
  private inviteCooldowns = new Map<string, number>();

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    switch (type) {
      case 'tradeRequest': this.onRequest(mp, userId, content); break;
      case 'tradeRespond': this.onRespond(mp, userId, content); break;
      case 'tradeSetOffer': this.onSetOffer(mp, userId, content); break;
      case 'tradeLock': this.onLock(mp, userId); break;
      case 'tradeUnlock': this.onUnlock(mp, userId); break;
      case 'tradeAccept': this.onAccept(mp, userId); break;
      case 'tradeCancel': this.onCancel(mp, userId); break;
      default: break;
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    const s = this.sessions.get(userId);
    if (s) {
      this.cancel(ctx.svr as Mp, s, 'Your trading partner left.', userId);
    }
  }

  // ── Messaging ───────────────────────────────────────────────────────────────

  private send(mp: Mp, userId: number, payload: Record<string, unknown>): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify(payload));
    } catch (err: any) {
      this.log('[trade] send failed: ' + (err && err.message));
    }
  }

  private notice(mp: Mp, userId: number, text: string): void {
    this.send(mp, userId, { customPacketType: 'tradeNotice', text });
  }

  private actorOf(mp: Mp, userId: number): number {
    try {
      return mp.getUserActor(userId);
    } catch {
      return 0;
    }
  }

  private nameOf(mp: Mp, userId: number): string {
    const actorId = this.actorOf(mp, userId);
    if (!actorId) {
      return 'Player';
    }
    try {
      return mp.getActorName(actorId) || 'Player';
    } catch {
      return 'Player';
    }
  }

  // The subject's name as the viewer may see it: real once introduced (gamemode ff_knownIds), otherwise the anonymity placeholder
  private nameShownTo(mp: Mp, viewerUserId: number, subjectUserId: number): string {
    const viewerActorId = this.actorOf(mp, viewerUserId);
    const subjectActorId = this.actorOf(mp, subjectUserId);
    try {
      const known = mp.get(viewerActorId, 'ff_knownIds');
      if (Array.isArray(known) && !known.includes(subjectActorId)) {
        return 'A stranger';
      }
    } catch { /* fall through to the real name */ }
    return this.nameOf(mp, subjectUserId);
  }

  // Push the current deal to one participant, framed from their point of view.
  private sendStateTo(mp: Mp, s: Session, userId: number): void {
    const me = s.a === userId;
    const partner = me ? s.b : s.a;
    const bothLocked = s.lockedA && s.lockedB;
    const myOffer = me ? s.offerA : s.offerB;
    const mine = resolveOffer(readInventory(mp, this.actorOf(mp, userId)), myOffer);
    const theirs = resolveOffer(readInventory(mp, this.actorOf(mp, partner)), me ? s.offerB : s.offerA);
    this.send(mp, userId, {
      customPacketType: 'tradeState',
      partnerName: this.nameShownTo(mp, userId, partner),
      myOffer: myOffer.map((i, n) => (mine.plain[n] ? { ...i, plain: true } : i)),
      theirOffer: addEntries({ entries: [] }, theirs.moved).entries,
      myLocked: me ? s.lockedA : s.lockedB,
      theirLocked: me ? s.lockedB : s.lockedA,
      bothLocked,
      iAccepted: me ? s.acceptedA : s.acceptedB,
      theyAccepted: me ? s.acceptedB : s.acceptedA,
    });
  }

  private broadcastState(mp: Mp, s: Session): void {
    this.sendStateTo(mp, s, s.a);
    this.sendStateTo(mp, s, s.b);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private endSession(s: Session): void {
    s.inviteSeq++; // invalidate any outstanding invite-TTL timer
    this.sessions.delete(s.a);
    this.sessions.delete(s.b);
  }

  private cancel(mp: Mp, s: Session, reason: string, blame?: number): void {
    this.endSession(s);
    for (const userId of [s.a, s.b]) {
      if (userId === blame) {
        continue;
      }
      this.send(mp, userId, { customPacketType: 'tradeCancelled', reason });
    }
  }

  private bothConnected(mp: Mp, s: Session): boolean {
    try {
      return mp.isConnected(s.a) && mp.isConnected(s.b);
    } catch {
      return false;
    }
  }

  private withinRange(mp: Mp, s: Session): boolean {
    const aId = this.actorOf(mp, s.a);
    const bId = this.actorOf(mp, s.b);
    if (!aId || !bId) {
      return false;
    }
    try {
      if (mp.getActorCellOrWorld(aId) !== mp.getActorCellOrWorld(bId)) {
        return false;
      }
      const pa = mp.getActorPos(aId);
      const pb = mp.getActorPos(bId);
      const dx = pa[0] - pb[0];
      const dy = pa[1] - pb[1];
      const dz = pa[2] - pb[2];
      return dx * dx + dy * dy + dz * dz <= this.maxTradeDistance * this.maxTradeDistance;
    } catch {
      return false;
    }
  }

  // Why a player may not trade right now, or null if they may: engine isDead (bleeding out) plus CaptureSystem's private.restrained mirror
  private tradeBlockReason(mp: Mp, userId: number): string | null {
    const actorId = this.actorOf(mp, userId);
    if (!actorId) {
      return 'not ready';
    }
    try {
      if (mp.get(actorId, 'isDead') === true) {
        return 'dead';
      }
    } catch {
      /* form not loaded yet */
    }
    try {
      const r = mp.get(actorId, 'private.restrained');
      if (r && (r.boundHands || r.carried)) {
        return 'restrained';
      }
    } catch {
      /* form not loaded yet */
    }
    return null;
  }

  // ── Invite spam brake ───────────────────────────────────────────────────────

  private onInviteCooldown(a: number, b: number): boolean {
    const last = this.inviteCooldowns.get(a + ':' + b) || 0;
    return Date.now() - last < this.inviteCooldownMs;
  }

  private markInviteCooldown(a: number, b: number): void {
    const now = Date.now();
    // Opportunistic prune so the map can't grow without bound.
    this.inviteCooldowns.forEach((ts, key) => {
      if (now - ts >= this.inviteCooldownMs) {
        this.inviteCooldowns.delete(key);
      }
    });
    this.inviteCooldowns.set(a + ':' + b, now);
  }

  // (Re-)send the invite prompt and arm the expiry timer; the timer re-checks it is still the CURRENT invite of a still-pending session, so stale timers are harmless
  private sendInvite(mp: Mp, s: Session): void {
    s.inviteSeq++;
    const seq = s.inviteSeq;
    this.markInviteCooldown(s.a, s.b);
    this.send(mp, s.b, { customPacketType: 'tradeInvite', fromName: this.nameShownTo(mp, s.b, s.a) });
    this.notice(mp, s.a, 'Trade request sent to ' + this.nameShownTo(mp, s.a, s.b) + '.');
    setTimeout(() => {
      try {
        if (this.sessions.get(s.a) !== s || s.active || s.inviteSeq !== seq) {
          return; // answered, cancelled, re-invited, or superseded meanwhile
        }
        this.cancel(mp, s, 'The trade request expired.');
      } catch (err: any) {
        this.log('[trade] invite expiry error: ' + (err && err.message));
      }
    }, this.inviteTtlMs);
  }

  // ── Packet handlers ─────────────────────────────────────────────────────────

  private onRequest(mp: Mp, userId: number, content: Content): void {
    const recipientActorId = Number(content.recipient);
    if (!Number.isFinite(recipientActorId) || recipientActorId <= 0) {
      return;
    }
    // getUserByActor returns the InvalidUserId sentinel (0xffff) for userless actors, which isConnected rejects
    let targetUserId: number;
    try {
      targetUserId = mp.getUserByActor(recipientActorId);
    } catch {
      targetUserId = -1;
    }
    if (targetUserId === undefined || targetUserId === null) {
      targetUserId = -1;
    }
    if (targetUserId < 0 || targetUserId === userId || !mp.isConnected(targetUserId)) {
      this.notice(mp, userId, 'That is not someone you can trade with.');
      return;
    }

    const existing = this.sessions.get(userId);
    if (existing) {
      if (existing.active || existing.a !== userId) {
        this.notice(mp, userId, 'You are already in a trade.');
        return;
      }
      // Our own invite is still pending: same target again -> re-invite; a different target -> drop the stale invite and start over
      if (existing.b === targetUserId) {
        if (this.onInviteCooldown(userId, targetUserId)) {
          this.notice(mp, userId, 'Please wait before sending another trade request.');
          return;
        }
        this.sendInvite(mp, existing);
        return;
      }
      this.cancel(mp, existing, this.nameShownTo(mp, existing.b === userId ? existing.a : existing.b, userId) + ' cancelled the trade.', userId);
    }

    if (this.sessions.has(targetUserId)) {
      this.notice(mp, userId, this.nameShownTo(mp, userId, targetUserId) + ' is busy with another trade.');
      return;
    }
    if (this.onInviteCooldown(userId, targetUserId)) {
      this.notice(mp, userId, 'Please wait before sending another trade request.');
      return;
    }
    if (this.tradeBlockReason(mp, userId)) {
      this.notice(mp, userId, 'You cannot trade right now.');
      return;
    }
    if (this.tradeBlockReason(mp, targetUserId)) {
      this.notice(mp, userId, this.nameShownTo(mp, userId, targetUserId) + ' cannot trade right now.');
      return;
    }
    const s: Session = {
      a: userId, b: targetUserId,
      offerA: [], offerB: [],
      lockedA: false, lockedB: false,
      acceptedA: false, acceptedB: false,
      active: false,
      inviteSeq: 0,
    };
    if (!this.withinRange(mp, s)) {
      this.notice(mp, userId, 'You are too far away to trade.');
      return;
    }
    this.sessions.set(userId, s);
    this.sessions.set(targetUserId, s);
    this.sendInvite(mp, s);
  }

  private onRespond(mp: Mp, userId: number, content: Content): void {
    const s = this.sessions.get(userId);
    // Only the (still-pending) invitee may answer, and only once.
    if (!s || s.active || s.b !== userId) {
      return;
    }
    if (!content.accept) {
      // A decline also refreshes the brake so the initiator can't immediately re-seize the decliner's browser focus with a fresh invite
      this.markInviteCooldown(s.a, s.b);
      this.cancel(mp, s, this.nameShownTo(mp, s.a === userId ? s.b : s.a, userId) + ' declined the trade.', userId);
      return;
    }
    if (!this.bothConnected(mp, s) || !this.withinRange(mp, s)) {
      this.cancel(mp, s, 'The trade could not start.');
      return;
    }
    if (this.tradeBlockReason(mp, s.a) || this.tradeBlockReason(mp, s.b)) {
      this.cancel(mp, s, 'The trade could not start.');
      return;
    }
    s.active = true;
    this.broadcastState(mp, s); // first state push tells both clients to open the window
  }

  private onSetOffer(mp: Mp, userId: number, content: Content): void {
    const s = this.sessions.get(userId);
    if (!s || !s.active) {
      return;
    }
    const offer = normalizeOffer(content.items);
    const inv = readInventory(mp, this.actorOf(mp, userId));
    const res = resolveOffer(inv, offer);
    if (!res.ok) {
      // Client and server disagree on holdings - resync rather than trust it.
      this.notice(mp, userId, 'You no longer have all of those items.');
      this.sendStateTo(mp, s, userId);
      return;
    }
    const oldOffer = s.a === userId ? s.offerA : s.offerB;
    const oldPlain = resolveOffer(inv, oldOffer).plain;
    const wasPlain = new Set(oldOffer.filter((_, n) => oldPlain[n]).map(lineKey));
    if (offer.some((i, n) => res.plain[n] && !wasPlain.has(lineKey(i)))) {
      this.notice(mp, userId, 'The server has no saved enchantment, tempering, soul or poison on that item, so it will trade as a plain copy.');
    }
    if (s.a === userId) { s.offerA = offer; } else { s.offerB = offer; }
    this.resetCommitments(s); // the terms changed; everyone must re-lock
    this.broadcastState(mp, s);
  }

  private onLock(mp: Mp, userId: number): void {
    const s = this.sessions.get(userId);
    if (!s || !s.active) {
      return;
    }
    // Guard the lock with a fresh affordability check.
    const inv = readInventory(mp, this.actorOf(mp, userId));
    const myOffer = s.a === userId ? s.offerA : s.offerB;
    if (!offerIsAffordable(inv, myOffer)) {
      this.notice(mp, userId, 'You no longer have all of those items.');
      if (s.a === userId) { s.offerA = []; } else { s.offerB = []; }
      this.resetCommitments(s);
      this.broadcastState(mp, s);
      return;
    }
    if (s.a === userId) { s.lockedA = true; } else { s.lockedB = true; }
    this.broadcastState(mp, s);
  }

  private onUnlock(mp: Mp, userId: number): void {
    const s = this.sessions.get(userId);
    if (!s || !s.active) {
      return;
    }
    if (s.a === userId) { s.lockedA = false; s.acceptedA = false; }
    else { s.lockedB = false; s.acceptedB = false; }
    this.broadcastState(mp, s);
  }

  private onAccept(mp: Mp, userId: number): void {
    const s = this.sessions.get(userId);
    if (!s || !s.active) {
      return;
    }
    // Accept is only meaningful once both sides have locked their offers.
    if (!(s.lockedA && s.lockedB)) {
      return;
    }
    if (s.a === userId) { s.acceptedA = true; } else { s.acceptedB = true; }
    if (s.acceptedA && s.acceptedB) {
      this.completeTrade(mp, s);
    } else {
      this.broadcastState(mp, s);
    }
  }

  private onCancel(mp: Mp, userId: number): void {
    const s = this.sessions.get(userId);
    if (s) {
      // Blame the canceller: the packet goes to the PARTNER, so the name shown must be the canceller's own
      this.cancel(mp, s, this.nameShownTo(mp, s.a === userId ? s.b : s.a, userId) + ' cancelled the trade.', userId);
    }
  }

  // Any change to the terms of the deal voids both players' commitments.
  private resetCommitments(s: Session): void {
    s.lockedA = false;
    s.lockedB = false;
    s.acceptedA = false;
    s.acceptedB = false;
  }

  // ── The swap ────────────────────────────────────────────────────────────────

  private completeTrade(mp: Mp, s: Session): void {
    if (!this.bothConnected(mp, s)) {
      this.cancel(mp, s, 'Your trading partner left.');
      return;
    }
    if (!this.withinRange(mp, s)) {
      this.cancel(mp, s, 'You moved too far apart to finish the trade.');
      return;
    }
    if (this.tradeBlockReason(mp, s.a) || this.tradeBlockReason(mp, s.b)) {
      this.cancel(mp, s, 'The trade was interrupted.');
      return;
    }

    const aId = this.actorOf(mp, s.a);
    const bId = this.actorOf(mp, s.b);
    const invA = readInventory(mp, aId);
    const invB = readInventory(mp, bId);

    // Final authority check: re-resolve both offers against live inventories.
    const resA = resolveOffer(invA, s.offerA);
    const resB = resolveOffer(invB, s.offerB);
    if (!resA.ok || !resB.ok) {
      this.cancel(mp, s, 'The trade failed - an item was no longer available.');
      return;
    }

    // invA stays untouched, so a failure of the second write can restore the first
    const preSwapA = invA;
    const newA = addEntries(resA.rest, resB.moved);
    const newB = addEntries(resB.rest, resA.moved);

    let wroteA = false;
    try {
      mp.set(aId, 'inventory', newA);
      wroteA = true;
      mp.set(bId, 'inventory', newB);
    } catch (err: any) {
      this.log('[trade] swap write failed: ' + (err && err.message));
      if (wroteA) {
        try {
          mp.set(aId, 'inventory', preSwapA);
          this.log('[trade] rolled back ' + this.nameOf(mp, s.a) + "'s inventory after failed swap");
        } catch (rollbackErr: any) {
          this.log('[trade] ROLLBACK FAILED for ' + this.nameOf(mp, s.a) + ' (' + aId.toString(16) + '): '
            + (rollbackErr && rollbackErr.message) + ' - pre-swap inventory: ' + JSON.stringify(preSwapA));
        }
      }
      this.cancel(mp, s, 'The trade failed unexpectedly.'); // no blame: both are told
      return;
    }

    this.endSession(s);
    this.send(mp, s.a, { customPacketType: 'tradeCompleted' });
    this.send(mp, s.b, { customPacketType: 'tradeCompleted' });
    const summary = '[trade] ' + this.describeParty(mp, s.a) + ' gave [' + this.describeOffer(resA.moved)
      + '] to ' + this.describeParty(mp, s.b) + ' for [' + this.describeOffer(resB.moved) + ']';
    this.log(summary);
    // trading.log via the gamemode's shared appender (same pattern as adminLog)
    try { (globalThis as any).__alduinakTradeLog?.(summary); } catch { /* log only */ }
  }

  // JSON-quoted name plus fixed-position ids, so a crafted character name
  // cannot forge another player's trade line.
  private describeParty(mp: Mp, userId: number): string {
    const actorId = this.actorOf(mp, userId);
    let profileId = -1;
    try { profileId = Number(mp.get(actorId, 'profileId')); } catch { /* form gone */ }
    return JSON.stringify(this.nameOf(mp, userId)) + ' (profile ' + profileId + ', actor ' + actorId.toString(16) + ')';
  }

  private describeOffer(moved: InventoryEntry[]): string {
    const offer = addEntries({ entries: [] }, moved).entries;
    if (!offer.length) {
      return 'nothing';
    }
    const nameOf = (globalThis as any).__alduinakItemName;
    const hex = (v: unknown): string => '0x' + (Number(v) >>> 0).toString(16);
    return offer.map((i) => {
      let label = i.count + 'x ' + hex(i.baseId);
      if (i.name) {
        label += ' ' + JSON.stringify(i.name);
      } else {
        try {
          const n = nameOf?.(i.baseId);
          if (n) label += ' ' + JSON.stringify(n);
        } catch { /* hex id is enough */ }
      }
      const extras = describeExtras(i);
      return extras.length ? label + ' {' + extras.join(', ') + '}' : label;
    }).join(', ');
  }
}

// Exported for unit/manual testing of the pure inventory math.
export const __test = {
  lineKey, normalizeOffer, resolveOffer, offerIsAffordable, addEntries,
};
