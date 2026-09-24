import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { isPlayerActor, isAlive, isBleedingOut, hex, userOf } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// An NPC's AI runs on the client that hosts it. This audit moves hosting to the player the NPC is fighting,
// to a companion's owner, or to the nearest player, so no NPC is left with a client that unloaded it.
// Documented in docs/docs_roleplay_npc_spawns.md (Hosting).

export interface Hostable {
  id: number;
  // Only this actor hosts it (companions, pets); nobody while the owner is away
  owner?: number;
  // Hosting stays where it is: a ridden or carried pet
  locked?: boolean;
}

export type HostableProvider = () => Hostable[];

const AUDIT_MS = 1500;
// Farther than this a player is not chosen as a new host; overridable via "npcHostRange"
const DEFAULT_HOST_RANGE = 8192;
// Aggro outlives the last hit exchanged with a player this long; overridable via "npcAggroHostSeconds"
const DEFAULT_AGGRO_SEC = 30;
// A host still eligible keeps the NPC this long after a switch or a client's claim
const SWITCH_COOLDOWN_MS = 5000;
// Without aggro, a nearer player takes over only when this much nearer than the current host
const NEARER_FACTOR = 0.5;
// A client that sent no movement for its own player this long is paused, alt-tabbed or loading; the C++ takeover rule uses 2 s too
const LIVE_MS = 2000;
// The current host stays a candidate this long after its last movement, so a load screen does not cost it the NPC
const HOST_KEEP_MS = 6000;
// A player who entered the NPC's cell this recently does not take it from a host that is still a candidate
const ARRIVAL_MS = 3000;
// A live host that lost the NPC to another client's claim did not run it; it is not given that NPC back for this long
const SILENT_MS = 60000;
// A dead or downed client keeps claiming every second, so its refusals are logged once per player this often
const REFUSAL_LOG_MS = 30000;

interface Located {
  id: number;
  cell: number;
  pos: number[];
}

interface Nearby {
  id: number;
  d2: number;
}

interface Silent {
  playerId: number;
  until: number;
}

interface InCell {
  cell: number;
  since: number;
}

export class HostingSystem implements System {
  systemName = "HostingSystem";
  constructor(private log: Log) { }

  private mp: Mp = null;
  private providers: HostableProvider[] = [];
  private hostables = new Map<number, Hostable>();
  // Per NPC: when each player last exchanged a damaging hit with it
  private aggro = new Map<number, Map<number, number>>();
  private switchedAt = new Map<number, number>();
  // Per NPC: the hoster the audit last saw or set, to spot claims clients made in between
  private lastHoster = new Map<number, number>();
  private silent = new Map<number, Silent>();
  // Per NPC: its hoster when a host attempt found that hoster paused, since it may resume before the audit sees the claim
  private pausedHost = new Map<number, number>();
  // Per online player: the cell the audit last saw it in and since when
  private inCell = new Map<number, InCell>();
  // Per player: when a refused claim of theirs was last logged
  private refusalLoggedAt = new Map<number, number>();
  private hostRange = DEFAULT_HOST_RANGE;
  private aggroMs = DEFAULT_AGGRO_SEC * 1000;
  private supported = false;
  private liveness = false;

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const range = Number(all?.["npcHostRange"]);
    if (Number.isFinite(range) && range > 0) this.hostRange = range;
    const sec = Number(all?.["npcAggroHostSeconds"]);
    if (Number.isFinite(sec) && sec >= 0) this.aggroMs = sec * 1000;
    this.supported = typeof this.mp.setHoster === "function" && typeof this.mp.getHoster === "function";
    if (!this.supported) this.log("HostingSystem: scam_native has no setHoster/getHoster, hosting stays client-driven");
    this.liveness = typeof this.mp.getMovementAgeMs === "function";
    if (this.supported && !this.liveness) this.log("HostingSystem: scam_native has no getMovementAgeMs, a paused player is skipped as host only after another client claims its NPC");
    this.installHooks();
  }

  async updateAsync(): Promise<void> {
    await new Promise((r) => setTimeout(r, AUDIT_MS));
    if (!this.supported) return;
    try {
      this.audit();
    } catch (e) {
      this.log(`HostingSystem: audit failed: ${e}`);
    }
  }

  addProvider(provider: HostableProvider): void {
    this.providers.push(provider);
  }

  // Moves hosting now (a fresh companion to its owner); false when unsupported, the hoster is offline or the actor is gone
  assign(actorId: number, hosterId: number, reason = "assigned"): boolean {
    if (!this.supported) return false;
    return this.switchTo(actorId >>> 0, hosterId >>> 0, reason);
  }

  // Only hits the other handlers let through and that deal damage count; the companion owner veto wraps the host attempt check
  private installHooks(): void {
    const mp = this.mp;
    const chain = (previous: ((...args: unknown[]) => unknown) | null, args: unknown[]): boolean => {
      if (!previous) return true;
      try {
        return previous.apply(mp, args) !== false;
      } catch {
        return true;
      }
    };

    const previousHit = typeof mp.onHitDamageAttempt === "function" ? mp.onHitDamageAttempt : null;
    mp.onHitDamageAttempt = (aggressorId: number, targetId: number, sourceId: number, damage: number): boolean => {
      const allowed = chain(previousHit, [aggressorId, targetId, sourceId, damage]);
      if (allowed && damage > 0) {
        try {
          this.noteHit(aggressorId >>> 0, targetId >>> 0);
        } catch { }
      }
      return allowed;
    };

    const previousHost = typeof mp.onHostAttempt === "function" ? mp.onHostAttempt : null;
    mp.onHostAttempt = (requesterId: number, actorId: number): boolean =>
      this.mayHost(requesterId >>> 0, actorId >>> 0) && chain(previousHost, [requesterId, actorId]);
  }

  // A hit between a player and an unowned NPC keeps that player engaged with the NPC
  private noteHit(aggressorId: number, targetId: number): void {
    const target = this.hostables.get(targetId);
    if (target && !target.owner && isPlayerActor(this.mp, aggressorId)) {
      this.engage(targetId, aggressorId);
      return;
    }
    const aggressor = this.hostables.get(aggressorId);
    if (aggressor && !aggressor.owner && isPlayerActor(this.mp, targetId)) this.engage(aggressorId, targetId);
  }

  // Whether a player exchanged a damaging hit with the NPC within the aggro window
  inCombat(npcId: number): boolean {
    const hits = this.aggro.get(npcId >>> 0);
    if (!hits) return false;
    const since = Date.now() - this.aggroMs;
    return Array.from(hits.values()).some((at) => at >= since);
  }

  private engage(npcId: number, playerId: number): void {
    let hits = this.aggro.get(npcId);
    if (!hits) this.aggro.set(npcId, (hits = new Map()));
    hits.set(playerId, Date.now());
  }

  // A managed NPC only goes to a live client the server streams it to; every other NPC stays first come
  private mayHost(requesterId: number, npcId: number): boolean {
    // A parked player body has no AI to run and keeps its logout pose; hits on it are server-resolved
    if (isAlive(this.mp, npcId) && isPlayerActor(this.mp, npcId) && userOf(this.mp, npcId) < 0) return false;
    const h = this.hostables.get(npcId);
    // A dead or downed client still reports its body and so counts as live, but its AI would only stand over that body; companions and pets stay with a downed owner
    const unfit = !isAlive(this.mp, requesterId) ? "dead" : !h?.owner && isBleedingOut(this.mp, requesterId) ? "downed" : "";
    if (unfit) {
      this.logRefusal(requesterId, npcId, unfit);
      return false;
    }
    if (!h) return true;
    this.noteAttempt(npcId);
    let ids: unknown[] = [];
    try {
      ids = this.mp.get(npcId, "actorNeighbors") ?? [];
    } catch {
      return true;
    }
    return ids.some((id) => Number(id) >>> 0 === requesterId) && this.isLive(requesterId);
  }

  private logRefusal(requesterId: number, npcId: number, why: string): void {
    const now = Date.now();
    if (now - (this.refusalLoggedAt.get(requesterId) ?? 0) < REFUSAL_LOG_MS) return;
    this.refusalLoggedAt.set(requesterId, now);
    this.log(`HostingSystem: ${hex(npcId)} refused to ${hex(requesterId)} (${why})`);
  }

  private audit(): void {
    const mp = this.mp;
    const now = Date.now();
    this.collect();
    if (!this.hostables.size) return;
    let playerIds: number[] = [];
    try {
      playerIds = (mp.get(0, "onlinePlayers") ?? []).map((id: unknown) => Number(id) >>> 0);
    } catch {
      return;
    }
    const players = playerIds.map((id) => this.locate(id)).filter((p): p is Located => !!p);
    this.noteCells(players, now);
    const alive = players.filter((p) => isAlive(mp, p.id));
    const downed = new Set(alive.filter((p) => isBleedingOut(mp, p.id)).map((p) => p.id));
    const ready = new Set(alive.filter((p) => this.isLive(p.id)).map((p) => p.id));
    const keeping = new Set(alive.filter((p) => this.isLive(p.id, HOST_KEEP_MS)).map((p) => p.id));
    const streamers = this.streamers(players);
    const range2 = this.hostRange * this.hostRange;
    for (const h of this.hostables.values()) {
      if (!isAlive(mp, h.id) || h.locked) continue;
      const at = this.locate(h.id);
      if (!at) continue;
      let current = 0;
      try {
        current = Number(mp.getHoster(h.id)) >>> 0;
      } catch {
        continue;
      }
      this.noteClaim(h.id, current, now);
      const listening = streamers.get(h.id);
      const silent = this.silent.get(h.id);
      const near: Nearby[] = [];
      for (const p of players) {
        // Only a client the server streams the NPC to can run its AI
        if (p.cell !== at.cell || !listening?.has(p.id) || !(p.id === current ? keeping : ready).has(p.id)) continue;
        // A downed player's AI would stand over their own body while the others fight; only their companions and pets stay
        if (!h.owner && downed.has(p.id)) continue;
        if (silent && silent.playerId === p.id && silent.until > now) continue;
        const dx = p.pos[0] - at.pos[0];
        const dy = p.pos[1] - at.pos[1];
        const dz = p.pos[2] - at.pos[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= range2) near.push({ id: p.id, d2 });
      }
      // A paused, dead or downed host is no candidate, so it loses the NPC without the cooldown
      const currentEligible = near.some((p) => p.id === current);
      const candidates = currentEligible && !h.owner ? near.filter((p) => p.id === current || !this.arrivedRecently(p.id, now)) : near;
      const { hoster, reason } = this.choose(h, candidates, current, now);
      if (hoster === current) continue;
      // Unhosting a host that still streams the NPC would only let its client claim it straight back
      if (!hoster && listening?.has(current)) continue;
      if (hoster && currentEligible && now - (this.switchedAt.get(h.id) ?? 0) < SWITCH_COOLDOWN_MS) continue;
      this.switchTo(h.id, hoster, reason);
    }
  }

  private choose(h: Hostable, near: Nearby[], current: number, now: number): { hoster: number; reason: string } {
    if (h.owner) return { hoster: near.some((p) => p.id === h.owner) ? h.owner : 0, reason: "owner" };
    const hits = this.aggro.get(h.id);
    const lastHit = (id: number) => hits?.get(id) ?? -Infinity;
    const engaged = near.filter((p) => now - lastHit(p.id) <= this.aggroMs);
    // A host still fighting the NPC keeps it, so a group fight does not bounce the AI between clients
    if (engaged.some((p) => p.id === current)) return { hoster: current, reason: "aggro" };
    if (engaged.length) {
      const latest = engaged.reduce((a, b) => (lastHit(b.id) > lastHit(a.id) ? b : a));
      return { hoster: latest.id, reason: "aggro" };
    }
    if (!near.length) return { hoster: 0, reason: "nobody in range" };
    let best = near[0];
    for (const p of near) if (p.d2 < best.d2) best = p;
    const cur = near.find((p) => p.id === current);
    // A host still in range keeps the NPC unless the nearest player is much nearer
    if (cur && best.d2 > cur.d2 * NEARER_FACTOR * NEARER_FACTOR) return { hoster: current, reason: "kept" };
    return { hoster: best.id, reason: "nearest" };
  }

  // A host change the audit did not make is a client's claim: it gets the switch cooldown, and a host live when the claim arrived had not run the NPC
  private noteClaim(npcId: number, current: number, now: number): void {
    const last = this.lastHoster.get(npcId);
    if (last === current) return;
    this.lastHoster.set(npcId, current);
    const pausedAtClaim = this.pausedHost.get(npcId) === last;
    this.pausedHost.delete(npcId);
    if (!current) return;
    this.switchedAt.set(npcId, now);
    if (last && !pausedAtClaim && this.isLive(last)) this.silent.set(npcId, { playerId: last, until: now + SILENT_MS });
  }

  // The successful claim's own attempt is the last one seen for the host it replaces
  private noteAttempt(npcId: number): void {
    let hoster = 0;
    try {
      hoster = Number(this.mp.getHoster(npcId)) >>> 0;
    } catch {
      return;
    }
    if (!hoster) return;
    if (!this.isLive(hoster)) this.pausedHost.set(npcId, hoster);
    else if (this.pausedHost.get(npcId) === hoster) this.pausedHost.delete(npcId);
  }

  // Without getMovementAgeMs everyone counts as live and a lost claim is the only sign of a paused host
  private isLive(playerId: number, maxAgeMs = LIVE_MS): boolean {
    if (!this.liveness) return true;
    try {
      const age = Number(this.mp.getMovementAgeMs(playerId));
      return age >= 0 && age <= maxAgeMs;
    } catch {
      return true;
    }
  }

  // A player first seen by the audit counts as just arrived
  private noteCells(players: Located[], now: number): void {
    const next = new Map<number, InCell>();
    for (const p of players) {
      const seen = this.inCell.get(p.id);
      next.set(p.id, seen && seen.cell === p.cell ? seen : { cell: p.cell, since: now });
    }
    this.inCell = next;
  }

  private arrivedRecently(playerId: number, now: number): boolean {
    return now - (this.inCell.get(playerId)?.since ?? -Infinity) < ARRIVAL_MS;
  }

  private switchTo(actorId: number, hosterId: number, reason: string): boolean {
    try {
      this.mp.setHoster(actorId, hosterId);
    } catch (e) {
      this.log(`HostingSystem: ${hex(actorId)} -> ${hosterId ? hex(hosterId) : "nobody"} failed: ${e}`);
      return false;
    }
    this.switchedAt.set(actorId, Date.now());
    this.lastHoster.set(actorId, hosterId);
    this.log(`HostingSystem: ${hex(actorId)} hosted by ${hosterId ? hex(hosterId) : "nobody"} (${reason})`);
    return true;
  }

  // NPC id to the players the server streams it to (its 3x3 grid of 4096-unit cells), read from each player's neighbours
  private streamers(players: Located[]): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>();
    for (const p of players) {
      let ids: unknown[] = [];
      try {
        ids = this.mp.get(p.id, "actorNeighbors") ?? [];
      } catch {
        continue;
      }
      for (const raw of ids) {
        const id = Number(raw) >>> 0;
        if (!this.hostables.has(id)) continue;
        let set = out.get(id);
        if (!set) out.set(id, (set = new Set()));
        set.add(p.id);
      }
    }
    return out;
  }

  private collect(): void {
    const next = new Map<number, Hostable>();
    for (const provider of this.providers) {
      let list: Hostable[] = [];
      try {
        list = provider();
      } catch (e) {
        this.log(`HostingSystem: provider failed: ${e}`);
      }
      for (const h of list) if (h && h.id) next.set(h.id >>> 0, h);
    }
    this.hostables = next;
    for (const map of [this.aggro, this.switchedAt, this.lastHoster, this.silent, this.pausedHost] as Map<number, unknown>[]) {
      for (const id of Array.from(map.keys())) if (!next.has(id)) map.delete(id);
    }
  }

  private locate(id: number): Located | null {
    try {
      const pos = this.mp.getActorPos(id);
      const cell = Number(this.mp.getActorCellOrWorld(id)) >>> 0;
      if (!Array.isArray(pos) || pos.length < 3) return null;
      return { id, cell, pos: [Number(pos[0]), Number(pos[1]), Number(pos[2])] };
    } catch {
      return null;
    }
  }
}
