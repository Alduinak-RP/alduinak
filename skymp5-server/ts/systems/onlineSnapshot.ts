import { onlineActors } from "./actorUtil";
import { SystemContext } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

const MAX_AGE_MS = 500;
// Bucket edge for range queries only; it does not mirror the native streaming grid
const CHUNK = 4096;
// How far a player may have moved since the snapshot was taken
const MAX_DRIFT = 1024;
const NO_POS: readonly number[] = Object.freeze([NaN, NaN, NaN]);

export interface OnlinePlayer {
  readonly actorId: number;
  // -1 when the actor has no valid user
  readonly userId: number;
  // Cell or worldspace form id, 0 when it could not be read
  readonly cell: number;
  readonly pos: readonly number[];
  // Read on first use, then kept for this snapshot
  readonly name: string;
  // Read on first use, then kept until the actor is assigned again
  readonly profileId: number;
}

export interface OnlineSnapshot {
  // In user id order
  readonly players: readonly OnlinePlayer[];
  readonly byActor: ReadonlyMap<number, OnlinePlayer>;
  readonly byCell: ReadonlyMap<number, readonly OnlinePlayer[]>;
  // Players in the cell or worldspace within range of pos, by their snapshot positions
  near(cell: number, pos: readonly number[], range: number): OnlinePlayer[];
  // As near, by each candidate's live cell and position, so the range is exact for anyone already in that cell at the snapshot
  nearNow(cell: number, pos: readonly number[], range: number): OnlinePlayer[];
}

const profiles = new Map<number, number>();
// Disconnected users until their id connects again; their actors still show in onlinePlayers while the disconnect handlers run
const leaving = new Set<number>();
let current: Snapshot | null = null;
let builtAt = 0;

const chunkOf = (v: number): number => Math.floor(v / CHUNK);
const chunkKey = (cx: number, cy: number): number => cx * 65536 + cy;

const distanceSq = (a: readonly number[], b: readonly number[]): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

const playerOf = (mp: Mp, actorId: number, userId: number, cell: number, pos: readonly number[]): OnlinePlayer => {
  let name: string | undefined;
  return {
    actorId, userId, cell, pos,
    get name(): string {
      if (name === undefined) {
        try { name = String(mp.getActorName(actorId) || ""); } catch { name = ""; }
      }
      return name;
    },
    get profileId(): number {
      let id = profiles.get(actorId);
      if (id === undefined) {
        try {
          const v = mp.get(actorId, "profileId");
          id = v === undefined || v === null ? -1 : Number(v);
        } catch {
          id = -1;
        }
        profiles.set(actorId, id);
      }
      return id;
    },
  };
};

class Snapshot implements OnlineSnapshot {
  readonly byActor = new Map<number, OnlinePlayer>();
  readonly byCell = new Map<number, OnlinePlayer[]>();
  private readonly chunks = new Map<number, Map<number, OnlinePlayer[]>>();

  constructor(readonly mp: Mp, readonly players: readonly OnlinePlayer[]) {
    for (const p of players) {
      this.byActor.set(p.actorId, p);
      if (!p.cell) continue;
      pushTo(this.byCell, p.cell, p);
      let grid = this.chunks.get(p.cell);
      if (!grid) this.chunks.set(p.cell, grid = new Map());
      pushTo(grid, chunkKey(chunkOf(p.pos[0]), chunkOf(p.pos[1])), p);
    }
  }

  near(cell: number, pos: readonly number[], range: number): OnlinePlayer[] {
    const all = this.byCell.get(cell);
    if (!all) return [];
    const inRange = (p: OnlinePlayer): boolean => distanceSq(p.pos, pos) <= range * range;
    const [x0, x1] = [chunkOf(pos[0] - range), chunkOf(pos[0] + range)];
    const [y0, y1] = [chunkOf(pos[1] - range), chunkOf(pos[1] + range)];
    if (!((x1 - x0 + 1) * (y1 - y0 + 1) < all.length)) return all.filter(inRange);
    const grid = this.chunks.get(cell);
    const out: OnlinePlayer[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (const p of grid?.get(chunkKey(cx, cy)) ?? []) if (inRange(p)) out.push(p);
      }
    }
    return out;
  }

  nearNow(cell: number, pos: readonly number[], range: number): OnlinePlayer[] {
    return this.near(cell, pos, range + MAX_DRIFT).filter((p) => {
      try {
        return this.mp.getActorCellOrWorld(p.actorId) >>> 0 === cell && distanceSq(this.mp.getActorPos(p.actorId), pos) <= range * range;
      } catch {
        return false;
      }
    });
  }
}

const build = (mp: Mp): Snapshot => {
  const players: OnlinePlayer[] = [];
  for (const actorId of onlineActors(mp)) {
    let userId = -1;
    try {
      const u = mp.getUserByActor(actorId);
      if (typeof u === "number" && u >= 0 && u < 0xffff) userId = u;
    } catch { /* no user */ }
    if (leaving.has(userId)) continue;
    let cell = 0;
    let pos = NO_POS;
    try {
      const c = mp.getActorCellOrWorld(actorId) >>> 0;
      const p = mp.getActorPos(actorId);
      if (Array.isArray(p)) [cell, pos] = [c, p];
    } catch { /* listed without a place */ }
    players.push(playerOf(mp, actorId, userId, cell, pos));
  }
  const snapshot = new Snapshot(mp, Object.freeze(players));
  for (const id of profiles.keys()) if (!snapshot.byActor.has(id)) profiles.delete(id);
  return snapshot;
};

// Every online player as of at most 500 ms ago; a disconnect or actor assign takes a new one on the next read
export const onlineSnapshot = (mp: Mp): OnlineSnapshot => {
  const now = Date.now();
  if (!current || current.mp !== mp || now - builtAt >= MAX_AGE_MS) {
    current = build(mp);
    builtAt = now;
  }
  return current;
};

const invalidate = (): void => { current = null; };

// Registered before the systems' handlers; also gives the gamemode g.__alduinakOnline
export const trackOnline = (ctx: SystemContext): void => {
  const server = ctx.svr as Mp;
  server.on("connect", (userId: number) => { leaving.delete(userId); });
  server.on("disconnect", (userId: number) => { leaving.add(userId); invalidate(); });
  ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
    leaving.delete(userId);
    profiles.delete(actorId >>> 0);
    invalidate();
  });
  (globalThis as any).__alduinakOnline = () => onlineSnapshot(server);
};
