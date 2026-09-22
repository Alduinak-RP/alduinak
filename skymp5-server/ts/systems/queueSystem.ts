import { Settings } from "../settings";
import { System, Log, SystemContext, LOGIN_VERIFIED_EVENT } from "./system";
import { readAdminRoleConfig, adminTierFor } from "./adminRoles";
import { userOf } from "./actorUtil";
import { sendJson } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Login queue. A verified login (Login's loginVerified) becomes spawnAllowed at once while play slots are free, else it waits in arrival order.
// A slot is held from admission until the connection ends, so a player parked in the character select is never overtaken. A disconnect keeps
// the slot (admitted) or the queue place (waiting) for queueGraceMs, so a crash inside it skips the queue on the way back. Staff (adminRoles
// tiers, adminRoleIds, adminProfileIds) never wait, may exceed playerSlots up to maxPlayers and count against neither. Everything lives in
// memory: a restart re-queues the players in reconnect order.
//
// server-settings.json keys:
//   playerSlots   verified logins that may play at once (default maxPlayers, queue off); the difference to maxPlayers is the queue room
//   queueGraceMs  how long a disconnected player keeps their slot or queue place (default 120000)
//
// Server -> Client while waiting, every 5 s and on every change (the packet also keeps the idle RakNet link alive):
//   { customPacketType: "queueStatus", position, total, waitedSec, etaSec | null }
// position and total count the connected entries; a place kept for a dropped player is invisible until they are back.

const TICK_MS = 2000;
const STATUS_EVERY_MS = 5000;
const ETA_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_GRACE_MS = 2 * 60 * 1000;

interface Entry {
  profileId: number;
  // Both undefined while the player is disconnected inside the grace
  userId?: number;
  guid?: string;
  detachedAt?: number;
  joinedAt: number;
  // roles, discordId, access as Login sent them
  args: unknown[];
  staff: boolean;
  lastStatus?: string;
  lastStatusAt?: number;
}

// playerSlots clamped to maxPlayers; absent or invalid means every connection may play
export function readPlayerSlots(all: Record<string, unknown> | null, maxPlayers: number): number {
  const slots = Number(all?.["playerSlots"]);
  return Number.isInteger(slots) && slots > 0 ? Math.min(slots, maxPlayers) : maxPlayers;
}

export class QueueSystem implements System {
  systemName = "QueueSystem";
  constructor(private log: Log) { }

  private playerSlots = 0;
  private graceMs = DEFAULT_GRACE_MS;
  private roleCfg = readAdminRoleConfig(null);
  private queue: Entry[] = [];
  // userId -> the login holding a play slot, from admission to disconnect; staff hold none
  private admitted = new Map<number, { profileId: number; guid: string; staff: boolean }>();
  // Profiles last admitted as staff, whose actors take no play slot
  private staffProfiles = new Set<number>();
  // profileId -> when a disconnected player's kept slot expires
  private reservations = new Map<number, number>();
  // Times the queue moved, for the wait estimate
  private admissions: number[] = [];

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    this.playerSlots = readPlayerSlots(all, s.maxPlayers);
    const grace = Number(all?.["queueGraceMs"]);
    if (Number.isInteger(grace) && grace >= 0) this.graceMs = grace;
    this.roleCfg = readAdminRoleConfig(all);
    (ctx.svr as any).getQueueLength = () => this.waiting().length;
    ctx.gm.on(LOGIN_VERIFIED_EVENT, (userId: number, profileId: number, ...args: unknown[]) => this.onLoginVerified(ctx, userId, profileId, args));
    this.log(`QueueSystem: ${this.playerSlots} play slots of ${s.maxPlayers} connections, ${this.graceMs / 1000} s grace`);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, TICK_MS));
    this.tick(ctx, Date.now());
  }

  disconnect(userId: number): void {
    const held = this.admitted.get(userId);
    if (held) {
      this.admitted.delete(userId);
      if (held.staff) return;
      if (this.graceMs > 0) this.reservations.set(held.profileId, Date.now() + this.graceMs);
      const waiting = this.waiting().length;
      if (waiting) this.log(`[queue] profile ${held.profileId} left, slot kept for ${this.graceMs / 1000} s, ${waiting} waiting`);
      return;
    }
    const entry = this.queue.find((e) => e.userId === userId);
    if (entry) {
      const position = this.positionOf(entry);
      this.detach(entry, Date.now());
      this.log(`[queue] profile ${entry.profileId} dropped at ${position}, place kept for ${this.graceMs / 1000} s`);
    }
  }

  // Also driven directly by the harness with a fake clock
  tick(ctx: SystemContext, now: number): void {
    for (const [profileId, until] of this.reservations) {
      if (until <= now) this.reservations.delete(profileId);
    }
    if (!this.queue.length) return;
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.userId !== undefined || (e.detachedAt ?? 0) + this.graceMs > now);
    if (this.queue.length !== before) this.log(`[queue] ${before - this.queue.length} place(s) expired, ${this.waiting().length} waiting`);
    while (this.admissions.length && this.admissions[0] < now - ETA_WINDOW_MS) this.admissions.shift();
    // A detached head keeps its place and is skipped, never blocks
    while (this.freeSlots(ctx.svr as Mp) > 0) {
      const idx = this.queue.findIndex((e) => e.userId !== undefined);
      if (idx < 0) break;
      const [entry] = this.queue.splice(idx, 1);
      if (this.admit(ctx, entry, now, "slot freed")) {
        this.admissions.push(now);
      } else {
        this.detach(entry, now);
        this.queue.splice(idx, 0, entry);
      }
    }
    for (const entry of this.queue) {
      if (entry.userId !== undefined) this.sendStatus(ctx.svr as Mp, entry, now);
    }
  }

  private onLoginVerified(ctx: SystemContext, userId: number, profileId: number, args: unknown[]): void {
    const now = Date.now();
    const mp = ctx.svr as Mp;
    const guid = this.guidOf(ctx, userId);
    if (guid === null) return;
    const roles = Array.isArray(args[0]) ? (args[0] as string[]) : [];
    const staff = adminTierFor(profileId, roles, this.roleCfg) !== null;
    const entry: Entry = { profileId, userId, guid, joinedAt: now, args, staff };
    const held = this.admitted.get(userId);
    if (held && held.profileId === profileId) {
      this.spawnAllowed(ctx, entry);
      return;
    }
    // A second connection of a playing profile takes the slot over; the old one frees nothing when RakNet finally drops it
    let takeover = false;
    for (const [otherUser, other] of this.admitted) {
      if (other.profileId === profileId) {
        this.admitted.delete(otherUser);
        takeover = true;
      }
    }
    if (takeover || this.hasOnlineActor(mp, profileId)) {
      this.admit(ctx, entry, now, "takeover");
    } else if (this.reservations.has(profileId)) {
      this.reservations.delete(profileId);
      this.admit(ctx, entry, now, "kept slot");
    } else if (staff) {
      this.admit(ctx, entry, now, "staff");
    } else {
      const waiting = this.queue.find((e) => e.profileId === profileId);
      if (waiting) {
        waiting.userId = userId;
        waiting.guid = guid;
        waiting.detachedAt = undefined;
        waiting.args = args;
        waiting.staff = staff;
        waiting.lastStatus = undefined;
        this.log(`[queue] profile ${profileId} back at ${this.positionOf(waiting)} of ${this.waiting().length}`);
        this.sendStatus(mp, waiting, now);
      } else if (this.freeSlots(mp) > 0 && !this.queue.some((e) => e.userId !== undefined)) {
        this.admit(ctx, entry, now, "free slot");
      } else {
        this.queue.push(entry);
        this.log(`[queue] profile ${profileId} queued at ${this.positionOf(entry)}`);
        this.sendStatus(mp, entry, now);
      }
    }
  }

  private admit(ctx: SystemContext, entry: Entry, now: number, why: string): boolean {
    const { userId, profileId } = entry;
    if (userId === undefined || entry.guid === undefined || this.guidOf(ctx, userId) !== entry.guid) return false;
    this.admitted.set(userId, { profileId, guid: entry.guid, staff: entry.staff });
    if (entry.staff) this.staffProfiles.add(profileId); else this.staffProfiles.delete(profileId);
    const waited = Math.round((now - entry.joinedAt) / 1000);
    const waiting = this.waiting().length;
    if (waited > 0 || waiting) this.log(`[queue] profile ${profileId} admitted (${why}) after ${waited} s, ${waiting} waiting`);
    this.spawnAllowed(ctx, entry);
    return true;
  }

  private spawnAllowed(ctx: SystemContext, entry: Entry): void {
    ctx.gm.emit("spawnAllowed", entry.userId, entry.profileId, ...entry.args);
  }

  private detach(entry: Entry, now: number): void {
    entry.userId = undefined;
    entry.guid = undefined;
    entry.detachedAt = now;
  }

  // Connected entries, in arrival order; detached places are skipped
  private waiting(): Entry[] {
    return this.queue.filter((e) => e.userId !== undefined);
  }

  private positionOf(entry: Entry): number {
    return this.waiting().indexOf(entry) + 1;
  }

  private sendStatus(mp: Mp, entry: Entry, now: number): void {
    if (entry.userId === undefined) return;
    const position = this.positionOf(entry);
    const total = this.waiting().length;
    const etaSec = this.etaSec(position, now);
    const key = `${position}/${total}/${etaSec}`;
    if (key === entry.lastStatus && now - (entry.lastStatusAt ?? 0) < STATUS_EVERY_MS) return;
    entry.lastStatus = key;
    entry.lastStatusAt = now;
    sendJson(mp, entry.userId, {
      customPacketType: "queueStatus",
      position,
      total,
      waitedSec: Math.max(0, Math.floor((now - entry.joinedAt) / 1000)),
      etaSec,
    });
  }

  // Slots freed per second over the last window; unknown until the queue has moved twice
  private etaSec(position: number, now: number): number | null {
    const n = this.admissions.length;
    if (n < 2) return null;
    const spanSec = Math.max(60, (now - this.admissions[0]) / 1000);
    return Math.round(position * spanSec / n);
  }

  // Play slots not taken by admitted logins, players spawned past this bookkeeping, or kept for a disconnected player; staff take none
  private freeSlots(mp: Mp): number {
    const profiles = new Set<number>();
    for (const held of this.admitted.values()) {
      if (!held.staff) profiles.add(held.profileId);
    }
    let actors: number[] = [];
    try { actors = mp.get(0, "onlinePlayers"); } catch { /* not attached yet */ }
    for (const actorId of actors) {
      const userId = userOf(mp, actorId);
      if (userId === -1 || this.admitted.has(userId)) continue;
      let profileId = -actorId;
      try { profileId = Number(mp.get(actorId, "profileId")); } catch { /* no profile yet */ }
      if (!this.staffProfiles.has(profileId)) profiles.add(profileId);
    }
    let reserved = 0;
    for (const profileId of this.reservations.keys()) {
      if (!profiles.has(profileId)) reserved++;
    }
    return this.playerSlots - profiles.size - reserved;
  }

  private hasOnlineActor(mp: Mp, profileId: number): boolean {
    try {
      return (mp.getActorsByProfileId(profileId) as number[]).some((actorId) => userOf(mp, actorId) !== -1);
    } catch {
      return false;
    }
  }

  private guidOf(ctx: SystemContext, userId: number): string | null {
    try {
      return ctx.svr.isConnected(userId) ? ctx.svr.getUserGuid(userId) : null;
    } catch {
      return null;
    }
  }
}
