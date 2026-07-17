import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Player-to-player trade ────────────────────────────────────────────────────
//
// Server-authoritative barter between two players, ported from the WIP
// build/dist/server/trade.ts gamemode module into a server-core System so it
// survives gamemode hot reloads and ships with the TS bundle. The shipped
// client TradeService speaks exactly this protocol.
//
// Flow: A sends tradeRequest -> B gets tradeInvite and accepts/declines ->
// both edit offers (tradeSetOffer resets locks) -> both tradeLock -> only then
// tradeAccept counts; when both accept the server swaps the items atomically.
// Only "simple" stacks trade (no enchanted/named/worn extras).
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server
//     { customPacketType: "tradeRequest", recipient: <remoteActorFormId> }
//     { customPacketType: "tradeRespond", accept: <bool> }
//     { customPacketType: "tradeSetOffer", items: [{ baseId, count }] }
//     { customPacketType: "tradeLock" | "tradeUnlock" | "tradeAccept" | "tradeCancel" }
//   Server -> Client
//     { customPacketType: "tradeInvite", fromName }
//     { customPacketType: "tradeState", partnerName, myOffer, theirOffer,
//         myLocked, theirLocked, bothLocked, iAccepted, theyAccepted }
//     { customPacketType: "tradeCompleted" } | { customPacketType: "tradeCancelled", reason }
//     { customPacketType: "tradeNotice", text }

const MAX_TRADE_DISTANCE = 1024;      // game units; both must stay within this range
const INVITE_TTL_MS = 60 * 1000;      // pending invites auto-cancel after this
const INVITE_COOLDOWN_MS = 30 * 1000; // min gap between invites per initiator->target

interface Item {
  baseId: number;
  count: number;
}

interface InventoryEntry extends Item {
  // Any of these present => the entry is "non-simple" and cannot be traded.
  health?: number;
  enchantmentId?: number;
  maxCharge?: number;
  chargePercent?: number;
  name?: string;
  soul?: number;
  poisonId?: number;
  poisonCount?: number;
  worn?: boolean;
  wornLeft?: boolean;
  removeEnchantmentOnUnequip?: boolean;
}

interface Inventory {
  entries: InventoryEntry[];
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

// ── Pure inventory helpers (operate on the JSON shape of the inventory binding) ─

const EXTRA_KEYS: (keyof InventoryEntry)[] = [
  'health', 'enchantmentId', 'maxCharge', 'chargePercent', 'name',
  'soul', 'poisonId', 'poisonCount', 'worn', 'wornLeft',
  'removeEnchantmentOnUnequip',
];

function hasExtras(e: InventoryEntry): boolean {
  for (const k of EXTRA_KEYS) {
    const v = e[k];
    if (v !== undefined && v !== null && v !== false) {
      return true;
    }
  }
  return false;
}

function readInventory(mp: Mp, actorId: number): Inventory {
  const inv = mp.get(actorId, 'inventory');
  if (inv && Array.isArray(inv.entries)) {
    return inv as Inventory;
  }
  return { entries: [] };
}

// How many of `baseId` the actor owns as plain, tradeable stacks.
function simpleCount(inv: Inventory, baseId: number): number {
  let total = 0;
  for (const e of inv.entries) {
    if (e.baseId === baseId && !hasExtras(e)) {
      total += e.count;
    }
  }
  return total;
}

// Collapse an offer to positive, integer, de-duplicated stacks.
function normalizeOffer(items: unknown): Item[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const byBase = new Map<number, number>();
  for (const raw of items) {
    const baseId = Number((raw as Item)?.baseId);
    const count = Math.floor(Number((raw as Item)?.count));
    if (!Number.isFinite(baseId) || !Number.isInteger(count) || count <= 0) {
      continue;
    }
    byBase.set(baseId, (byBase.get(baseId) || 0) + count);
  }
  return Array.from(byBase, ([baseId, count]) => ({ baseId, count }));
}

// True only if every offered stack is fully backed by simple inventory.
function offerIsAffordable(inv: Inventory, offer: Item[]): boolean {
  for (const item of offer) {
    if (simpleCount(inv, item.baseId) < item.count) {
      return false;
    }
  }
  return true;
}

// Remove an offer from a working inventory copy (simple stacks only).
function removeOffer(inv: Inventory, offer: Item[]): void {
  for (const item of offer) {
    let remaining = item.count;
    for (const e of inv.entries) {
      if (remaining <= 0) {
        break;
      }
      if (e.baseId === item.baseId && !hasExtras(e)) {
        const take = Math.min(e.count, remaining);
        e.count -= take;
        remaining -= take;
      }
    }
  }
  inv.entries = inv.entries.filter((e) => e.count > 0);
}

// Add an offer into a working inventory copy, merging onto an existing stack.
function addOffer(inv: Inventory, offer: Item[]): void {
  for (const item of offer) {
    const stack = inv.entries.find((e) => e.baseId === item.baseId && !hasExtras(e));
    if (stack) {
      stack.count += item.count;
    } else {
      inv.entries.push({ baseId: item.baseId, count: item.count });
    }
  }
}

export class TradeSystem implements System {
  systemName = "TradeSystem";
  constructor(private log: Log) { }

  // Each connected user is in at most one session; both participants point at
  // the same Session object so either side can be looked up in O(1).
  private sessions = new Map<number, Session>();
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

  // Push the current deal to one participant, framed from their point of view.
  private sendStateTo(mp: Mp, s: Session, userId: number): void {
    const me = s.a === userId;
    const bothLocked = s.lockedA && s.lockedB;
    this.send(mp, userId, {
      customPacketType: 'tradeState',
      partnerName: this.nameOf(mp, me ? s.b : s.a),
      myOffer: me ? s.offerA : s.offerB,
      theirOffer: me ? s.offerB : s.offerA,
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
      return dx * dx + dy * dy + dz * dz <= MAX_TRADE_DISTANCE * MAX_TRADE_DISTANCE;
    } catch {
      return false;
    }
  }

  // Why a player may not trade right now, or null if they may. Gates on the
  // engine isDead (bleeding out) plus CaptureSystem's private.restrained mirror.
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
    return Date.now() - last < INVITE_COOLDOWN_MS;
  }

  private markInviteCooldown(a: number, b: number): void {
    const now = Date.now();
    // Opportunistic prune so the map can't grow without bound.
    this.inviteCooldowns.forEach((ts, key) => {
      if (now - ts >= INVITE_COOLDOWN_MS) {
        this.inviteCooldowns.delete(key);
      }
    });
    this.inviteCooldowns.set(a + ':' + b, now);
  }

  // (Re-)send the invite prompt and arm the expiry timer. The timer re-checks
  // it is still the CURRENT invite of a still-pending session, so stale timers
  // are harmless.
  private sendInvite(mp: Mp, s: Session): void {
    s.inviteSeq++;
    const seq = s.inviteSeq;
    this.markInviteCooldown(s.a, s.b);
    this.send(mp, s.b, { customPacketType: 'tradeInvite', fromName: this.nameOf(mp, s.a) });
    this.notice(mp, s.a, 'Trade request sent to ' + this.nameOf(mp, s.b) + '.');
    setTimeout(() => {
      try {
        if (this.sessions.get(s.a) !== s || s.active || s.inviteSeq !== seq) {
          return; // answered, cancelled, re-invited, or superseded meanwhile
        }
        this.cancel(mp, s, 'The trade request expired.');
      } catch (err: any) {
        this.log('[trade] invite expiry error: ' + (err && err.message));
      }
    }, INVITE_TTL_MS);
  }

  // ── Packet handlers ─────────────────────────────────────────────────────────

  private onRequest(mp: Mp, userId: number, content: Content): void {
    const recipientActorId = Number(content.recipient);
    if (!Number.isFinite(recipientActorId) || recipientActorId <= 0) {
      return;
    }
    // getUserByActor returns the InvalidUserId sentinel (0xffff) for userless
    // actors, which isConnected rejects.
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
      // Our own invite is still pending. Same target again -> re-invite; a
      // different target -> drop the stale invite and start over.
      if (existing.b === targetUserId) {
        if (this.onInviteCooldown(userId, targetUserId)) {
          this.notice(mp, userId, 'Please wait before sending another trade request.');
          return;
        }
        this.sendInvite(mp, existing);
        return;
      }
      this.cancel(mp, existing, this.nameOf(mp, userId) + ' cancelled the trade.', userId);
    }

    if (this.sessions.has(targetUserId)) {
      this.notice(mp, userId, this.nameOf(mp, targetUserId) + ' is busy with another trade.');
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
      this.notice(mp, userId, this.nameOf(mp, targetUserId) + ' cannot trade right now.');
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
      // A decline also refreshes the brake so the initiator can't immediately
      // re-seize the decliner's browser focus with a fresh invite.
      this.markInviteCooldown(s.a, s.b);
      this.cancel(mp, s, this.nameOf(mp, userId) + ' declined the trade.', userId);
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
    if (!offerIsAffordable(inv, offer)) {
      // Client and server disagree on holdings - resync rather than trust it.
      this.notice(mp, userId, 'You no longer have all of those items.');
      this.sendStateTo(mp, s, userId);
      return;
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
      // Blame the canceller: the packet goes to the PARTNER, so the name shown
      // must be the canceller's own.
      this.cancel(mp, s, this.nameOf(mp, userId) + ' cancelled the trade.', userId);
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

    // Final authority check: re-validate both offers against live inventories.
    if (!offerIsAffordable(invA, s.offerA) || !offerIsAffordable(invB, s.offerB)) {
      this.cancel(mp, s, 'The trade failed - an item was no longer available.');
      return;
    }

    // Snapshot A's pre-swap inventory BEFORE mutating, so a failure of the
    // second write can restore the first.
    const preSwapA: Inventory = JSON.parse(JSON.stringify(invA));

    removeOffer(invA, s.offerA);
    addOffer(invA, s.offerB);
    removeOffer(invB, s.offerB);
    addOffer(invB, s.offerA);

    let wroteA = false;
    try {
      mp.set(aId, 'inventory', invA);
      wroteA = true;
      mp.set(bId, 'inventory', invB);
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
    this.log('[trade] ' + this.nameOf(mp, s.a) + ' <-> ' + this.nameOf(mp, s.b) + ' completed');
  }
}

// Exported for unit/manual testing of the pure inventory math.
export const __test = {
  hasExtras, simpleCount, normalizeOffer, offerIsAffordable, removeOffer, addOffer,
};
