// ── Player-to-player trading / barter — gamemode-owned ────────────────────────
//
// A lightweight, server-authoritative barter system. One player looks at another
// and picks "Trade" from the interact (Y) menu; the other player is prompted and,
// on accept, both open a trade window. Each side fills an "offer" box from their
// own inventory, both LOCK, both ACCEPT, and the server swaps the two offers
// atomically. Changing your offer clears both locks, so a deal is only ever
// sealed on terms both players currently see.
//
// The server is the only authority: offers are re-validated against live
// inventories at lock time and again at the instant of the swap, so a desynced
// or hacked client can never conjure or duplicate items. Item movement is done
// through the read/write `inventory` property binding (mp.get/mp.set), which
// fires the engine's normal inventory sync back to each owner.
//
// Only "simple" items (no enchantment, tempering, charge, poison, custom name,
// soul, or worn/equipped state) may be offered. That covers gold, ingredients,
// potions, food, ingots, ammo and plain gear — everything with a meaningful
// stack count — while sidestepping the per-instance bookkeeping that unique
// items would need. The client hides non-simple entries from the offer list.
//
// Works with the SHIPPING engine (scam_native.node): only uses `customPacket`,
// `disconnect`, `getUserActor`, `getUserByActor`, `isConnected`, `getActorName`,
// `getActorPos`, `getActorCellOrWorld`, `sendCustomPacket`, and the `inventory`
// property — no native rebuild.
//
// Protocol — every message is a CustomPacket whose JSON carries a
// `customPacketType`. Item lists are `[{ baseId, count }]`.
//
//   Client -> Server
//     { customPacketType: "tradeRequest", recipient: <remoteActorFormId> }
//     { customPacketType: "tradeRespond", accept: <bool> }
//     { customPacketType: "tradeSetOffer", items: [{ baseId, count }] }
//     { customPacketType: "tradeLock" }
//     { customPacketType: "tradeUnlock" }
//     { customPacketType: "tradeAccept" }
//     { customPacketType: "tradeCancel" }
//
//   Server -> Client
//     { customPacketType: "tradeInvite", fromName }              // -> invitee
//     { customPacketType: "tradeState", partnerName, myOffer, theirOffer,
//         myLocked, theirLocked, bothLocked, iAccepted, theyAccepted } // both
//     { customPacketType: "tradeCompleted" }                     // -> both
//     { customPacketType: "tradeCancelled", reason }             // -> a side
//     { customPacketType: "tradeNotice", text }                  // corner toast
//
// Wiring (gamemode entry init, alongside the other *.init calls):
//   import * as trade from './systems/trade';
//   trade.init(mp);

// ── Tuning ────────────────────────────────────────────────────────────────────

const MAX_TRADE_DISTANCE = 1024; // game units; both must stay within this range
const GOLD_BASE_ID = 0x0000000f; // septims — a normal stackable item

// ── Types ──────────────────────────────────────────────────────────────────────

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
}

// Each connected user is in at most one session; both participants point at the
// same Session object so either side can be looked up in O(1).
const sessions = new Map<number, Session>();

// ── Inventory helpers (operate on the JSON shape from the inventory binding) ────

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

function readInventory(mp: any, actorId: number): Inventory {
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

// ── Session helpers ────────────────────────────────────────────────────────────

function isA(s: Session, userId: number): boolean {
  return s.a === userId;
}

function partnerOf(s: Session, userId: number): number {
  return isA(s, userId) ? s.b : s.a;
}

function offerOf(s: Session, userId: number): Item[] {
  return isA(s, userId) ? s.offerA : s.offerB;
}

function lockedOf(s: Session, userId: number): boolean {
  return isA(s, userId) ? s.lockedA : s.lockedB;
}

function acceptedOf(s: Session, userId: number): boolean {
  return isA(s, userId) ? s.acceptedA : s.acceptedB;
}

function setOffer(s: Session, userId: number, offer: Item[]): void {
  if (isA(s, userId)) { s.offerA = offer; } else { s.offerB = offer; }
}

function setLocked(s: Session, userId: number, v: boolean): void {
  if (isA(s, userId)) { s.lockedA = v; } else { s.lockedB = v; }
}

function setAccepted(s: Session, userId: number, v: boolean): void {
  if (isA(s, userId)) { s.acceptedA = v; } else { s.acceptedB = v; }
}

// Any change to the terms of the deal voids both players' commitments.
function resetCommitments(s: Session): void {
  s.lockedA = false;
  s.lockedB = false;
  s.acceptedA = false;
  s.acceptedB = false;
}

// ── Messaging ──────────────────────────────────────────────────────────────────

function send(mp: any, userId: number, payload: Record<string, unknown>): void {
  try {
    mp.sendCustomPacket(userId, JSON.stringify(payload));
  } catch (err: any) {
    console.error('[trade] send failed: ' + (err && err.message));
  }
}

function notice(mp: any, userId: number, text: string): void {
  send(mp, userId, { customPacketType: 'tradeNotice', text });
}

function actorOf(mp: any, userId: number): number {
  try {
    return mp.getUserActor(userId);
  } catch {
    return 0;
  }
}

function nameOf(mp: any, userId: number): string {
  const actorId = actorOf(mp, userId);
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
function sendStateTo(mp: any, s: Session, userId: number): void {
  const partner = partnerOf(s, userId);
  const bothLocked = s.lockedA && s.lockedB;
  send(mp, userId, {
    customPacketType: 'tradeState',
    partnerName: nameOf(mp, partner),
    myOffer: offerOf(s, userId),
    theirOffer: offerOf(s, partner),
    myLocked: lockedOf(s, userId),
    theirLocked: lockedOf(s, partner),
    bothLocked,
    iAccepted: acceptedOf(s, userId),
    theyAccepted: acceptedOf(s, partner),
  });
}

function broadcastState(mp: any, s: Session): void {
  sendStateTo(mp, s, s.a);
  sendStateTo(mp, s, s.b);
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

function endSession(s: Session): void {
  sessions.delete(s.a);
  sessions.delete(s.b);
}

function cancel(mp: any, s: Session, reason: string, blame?: number): void {
  endSession(s);
  for (const userId of [s.a, s.b]) {
    if (userId === blame) {
      continue;
    }
    send(mp, userId, { customPacketType: 'tradeCancelled', reason });
  }
}

// A disconnecting player drops any trade they were part of.
function onDisconnect(mp: any, userId: number): void {
  const s = sessions.get(userId);
  if (s) {
    cancel(mp, s, 'Your trading partner left.', userId);
  }
}

function bothConnected(mp: any, s: Session): boolean {
  try {
    return mp.isConnected(s.a) && mp.isConnected(s.b);
  } catch {
    return false;
  }
}

function withinRange(mp: any, s: Session): boolean {
  const aId = actorOf(mp, s.a);
  const bId = actorOf(mp, s.b);
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

// ── Packet handlers ─────────────────────────────────────────────────────────────

function onRequest(mp: any, userId: number, content: any): void {
  if (sessions.has(userId)) {
    notice(mp, userId, 'You are already in a trade.');
    return;
  }
  const recipientActorId = Number(content.recipient);
  if (!Number.isFinite(recipientActorId) || recipientActorId <= 0) {
    return;
  }
  // getUserByActor doesn't throw for userless actors; it returns the
  // Networking::InvalidUserId sentinel (0xffff), which isConnected rejects.
  let targetUserId: number;
  try {
    targetUserId = mp.getUserByActor(recipientActorId);
  } catch {
    targetUserId = -1;
  }
  if (targetUserId < 0 || targetUserId === userId || !mp.isConnected(targetUserId)) {
    notice(mp, userId, 'That is not someone you can trade with.');
    return;
  }
  if (sessions.has(targetUserId)) {
    notice(mp, userId, nameOf(mp, targetUserId) + ' is busy with another trade.');
    return;
  }
  const s: Session = {
    a: userId, b: targetUserId,
    offerA: [], offerB: [],
    lockedA: false, lockedB: false,
    acceptedA: false, acceptedB: false,
    active: false,
  };
  if (!withinRange(mp, s)) {
    notice(mp, userId, 'You are too far away to trade.');
    return;
  }
  sessions.set(userId, s);
  sessions.set(targetUserId, s);
  send(mp, targetUserId, { customPacketType: 'tradeInvite', fromName: nameOf(mp, userId) });
  notice(mp, userId, 'Trade request sent to ' + nameOf(mp, targetUserId) + '.');
}

function onRespond(mp: any, userId: number, content: any): void {
  const s = sessions.get(userId);
  // Only the (still-pending) invitee may answer, and only once.
  if (!s || s.active || s.b !== userId) {
    return;
  }
  if (!content.accept) {
    cancel(mp, s, nameOf(mp, userId) + ' declined the trade.', userId);
    return;
  }
  if (!bothConnected(mp, s) || !withinRange(mp, s)) {
    cancel(mp, s, 'The trade could not start.');
    return;
  }
  s.active = true;
  broadcastState(mp, s); // first state push tells both clients to open the window
}

function onSetOffer(mp: any, userId: number, content: any): void {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  const offer = normalizeOffer(content.items);
  const inv = readInventory(mp, actorOf(mp, userId));
  if (!offerIsAffordable(inv, offer)) {
    // Client and server disagree on holdings — resync rather than trust it.
    notice(mp, userId, 'You no longer have all of those items.');
    sendStateTo(mp, s, userId);
    return;
  }
  setOffer(s, userId, offer);
  resetCommitments(s); // the terms changed; everyone must re-lock
  broadcastState(mp, s);
}

function onLock(mp: any, userId: number): void {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  // Guard the lock with a fresh affordability check.
  const inv = readInventory(mp, actorOf(mp, userId));
  if (!offerIsAffordable(inv, offerOf(s, userId))) {
    notice(mp, userId, 'You no longer have all of those items.');
    setOffer(s, userId, []);
    resetCommitments(s);
    broadcastState(mp, s);
    return;
  }
  setLocked(s, userId, true);
  broadcastState(mp, s);
}

function onUnlock(mp: any, userId: number): void {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  setLocked(s, userId, false);
  setAccepted(s, userId, false);
  broadcastState(mp, s);
}

function onAccept(mp: any, userId: number): void {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  // Accept is only meaningful once both sides have locked their offers.
  if (!(s.lockedA && s.lockedB)) {
    return;
  }
  setAccepted(s, userId, true);
  if (s.acceptedA && s.acceptedB) {
    completeTrade(mp, s);
  } else {
    broadcastState(mp, s);
  }
}

function onCancel(mp: any, userId: number): void {
  const s = sessions.get(userId);
  if (s) {
    cancel(mp, s, nameOf(mp, partnerOf(s, userId)) + ' cancelled the trade.', userId);
  }
}

// ── The swap ─────────────────────────────────────────────────────────────────

function completeTrade(mp: any, s: Session): void {
  if (!bothConnected(mp, s)) {
    cancel(mp, s, 'Your trading partner left.');
    return;
  }
  if (!withinRange(mp, s)) {
    cancel(mp, s, 'You moved too far apart to finish the trade.');
    return;
  }

  const aId = actorOf(mp, s.a);
  const bId = actorOf(mp, s.b);
  const invA = readInventory(mp, aId);
  const invB = readInventory(mp, bId);

  // Final authority check: re-validate both offers against live inventories.
  if (!offerIsAffordable(invA, s.offerA) || !offerIsAffordable(invB, s.offerB)) {
    cancel(mp, s, 'The trade failed — an item was no longer available.');
    return;
  }

  removeOffer(invA, s.offerA);
  addOffer(invA, s.offerB);
  removeOffer(invB, s.offerB);
  addOffer(invB, s.offerA);

  try {
    mp.set(aId, 'inventory', invA);
    mp.set(bId, 'inventory', invB);
  } catch (err: any) {
    console.error('[trade] swap write failed: ' + (err && err.message));
    cancel(mp, s, 'The trade failed unexpectedly.');
    return;
  }

  endSession(s);
  send(mp, s.a, { customPacketType: 'tradeCompleted' });
  send(mp, s.b, { customPacketType: 'tradeCompleted' });
  console.log('[trade] ' + nameOf(mp, s.a) + ' <-> ' + nameOf(mp, s.b) + ' completed');
}

// ── Routing & init ──────────────────────────────────────────────────────────────

function route(mp: any, userId: number, content: any): void {
  switch (content.customPacketType) {
    case 'tradeRequest': onRequest(mp, userId, content); break;
    case 'tradeRespond': onRespond(mp, userId, content); break;
    case 'tradeSetOffer': onSetOffer(mp, userId, content); break;
    case 'tradeLock': onLock(mp, userId); break;
    case 'tradeUnlock': onUnlock(mp, userId); break;
    case 'tradeAccept': onAccept(mp, userId); break;
    case 'tradeCancel': onCancel(mp, userId); break;
    default: break;
  }
}

export function init(mp: any): void {
  console.log('[trade] Initializing');

  mp.on('customPacket', (userId: number, rawContent: string) => {
    let content: any;
    try {
      content = JSON.parse(rawContent);
    } catch {
      return;
    }
    if (!content || typeof content.customPacketType !== 'string'
        || content.customPacketType.indexOf('trade') !== 0) {
      return;
    }
    try {
      route(mp, userId, content);
    } catch (err: any) {
      console.error('[trade] handler error: ' + (err && err.message));
    }
  });

  mp.on('disconnect', (userId: number) => {
    try {
      onDisconnect(mp, userId);
    } catch (err: any) {
      console.error('[trade] disconnect error: ' + (err && err.message));
    }
  });

  console.log('[trade] Started');
}

// Exported for unit/manual testing of the pure inventory math.
export const __test = {
  hasExtras, simpleCount, normalizeOffer, offerIsAffordable, removeOffer, addOffer,
  GOLD_BASE_ID,
};
