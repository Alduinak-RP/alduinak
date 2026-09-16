import { scanRecords, espmDesc, LogFn, EspmRecord } from "./espmEditorIds";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Walkable spots for zone NPCs from the plugins' navmesh (docs/docs_roleplay_npc_spawns.md, Placement)

// NVNM starts with version, crc, worldspace, parent cell (or grid when in a worldspace), then the vertex count and x,y,z floats
const NVNM_WORLD = 8;
const NVNM_CELL = 12;
const NVNM_VERTEX_COUNT = 16;
const VERTEX_SIZE = 12;
// Three vertex indices, three edges, flags, cover
const TRIANGLE_SIZE = 16;
const TRIANGLE_FLAGS = 12;
// Type, navmesh form id, triangle index
const LINK_SIZE = 10;
const LINK_PORTAL = 0;
const RECORD_DELETED = 0x20;
// Low bits shared by the local and global id of a record, light plugins included
const LOW_ID_MASK = 0xfff;
// Triangle flag bits 0..2 mark an edge that indexes the edge link list instead of a triangle of the same mesh
const TRI_NO_LARGE = 0x0010;
const TRI_WATER = 0x0200;
const TRI_DOOR = 0x0400;

export interface NavmeshTarget {
  key: string;
  cellOrWorldId: number;
  pos: number[];
  radius: number;
}

// "large" also skips triangles marked for no large creatures, "water" is for bases that only swim
export type SpotKind = "land" | "large" | "water";

type PoolName = SpotKind | "any";

interface Pool {
  index: Uint32Array;
  cumArea: Float64Array;
}

export interface Spots {
  // Three x,y,z corners per triangle
  corners: Float32Array;
  flags: Uint16Array;
  pools: Map<PoolName, Pool | null>;
}

export interface NavmeshScan {
  spots: Map<string, Spots | null>;
  // False when a plugin could not be read, so the result is partial
  complete: boolean;
}

interface Link {
  mesh: string;
  tri: number;
}

interface Mesh {
  parentId: number;
  min: number[];
  max: number[];
  verts: Float32Array;
  // v0, v1, v2, e0, e1, e2 per triangle
  tris: Int32Array;
  flags: Uint16Array;
  // Portal links only; ledge links need a jump
  links: (Link | null)[];
}

const POOL_TESTS: Record<PoolName, (flags: number) => boolean> = {
  land: (f) => !(f & (TRI_WATER | TRI_DOOR)),
  large: (f) => !(f & (TRI_WATER | TRI_DOOR | TRI_NO_LARGE)),
  water: (f) => (f & TRI_WATER) !== 0,
  any: () => true,
};

// Tried in order until one has any area
const POOL_ORDER: Record<SpotKind, PoolName[]> = {
  land: ["land", "any"],
  large: ["large", "land", "any"],
  water: ["water", "any"],
};

const touches = (min: number[], max: number[], t: NavmeshTarget): boolean => {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(min[k] - t.pos[k], 0, t.pos[k] - max[k]);
    d2 += d * d;
  }
  return d2 <= t.radius * t.radius;
};

const centroidDistSq = (m: Mesh, tri: number, p: number[]): number => {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const c = (m.verts[m.tris[tri * 6] * 3 + k] + m.verts[m.tris[tri * 6 + 1] * 3 + k] + m.verts[m.tris[tri * 6 + 2] * 3 + k]) / 3;
    d2 += (c - p[k]) * (c - p[k]);
  }
  return d2;
};

// Height difference when the triangle lies under or over p, else the distance to its centroid
function standDistance(m: Mesh, tri: number, p: number[]): number {
  const [a, b, c] = [m.tris[tri * 6] * 3, m.tris[tri * 6 + 1] * 3, m.tris[tri * 6 + 2] * 3];
  const v = m.verts;
  const det = (v[b + 1] - v[c + 1]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 1] - v[c + 1]);
  if (det !== 0) {
    const u = ((v[b + 1] - v[c + 1]) * (p[0] - v[c]) + (v[c] - v[b]) * (p[1] - v[c + 1])) / det;
    const w = ((v[c + 1] - v[a + 1]) * (p[0] - v[c]) + (v[a] - v[c]) * (p[1] - v[c + 1])) / det;
    if (u >= 0 && w >= 0 && u + w <= 1) return Math.abs(p[2] - (u * v[a + 2] + w * v[b + 2] + (1 - u - w) * v[c + 2]));
  }
  return Math.sqrt(centroidDistSq(m, tri, p));
}

// Null when the mesh cannot belong to any target area
function readMesh(rec: EspmRecord, b: Buffer, targets: NavmeshTarget[], targetIds: Set<number>, lowIds: Set<number>, idOf: (formId: number) => number): Mesh | null {
  if (b.length < NVNM_VERTEX_COUNT + 4) return null;
  const world = b.readUInt32LE(NVNM_WORLD);
  const cell = b.readUInt32LE(NVNM_CELL);
  if (!world && !lowIds.has(cell & LOW_ID_MASK)) return null;
  const parentId = idOf(world || cell);
  // A worldspace mesh may still belong to a target cell inside that worldspace, which is only known once the scan ends
  if (!parentId || (!world && !targetIds.has(parentId))) return null;
  const vertexCount = b.readUInt32LE(NVNM_VERTEX_COUNT);
  let off = NVNM_VERTEX_COUNT + 4;
  if (off + vertexCount * VERTEX_SIZE + 4 > b.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const verts = new Float32Array(vertexCount * 3);
  for (let i = 0; i < verts.length; i++) {
    const value = b.readFloatLE(off + i * 4);
    verts[i] = value;
    min[i % 3] = Math.min(min[i % 3], value);
    max[i % 3] = Math.max(max[i % 3], value);
  }
  if (!targets.some((t) => (world !== 0 || t.cellOrWorldId === parentId) && touches(min, max, t))) return null;
  off += vertexCount * VERTEX_SIZE;
  const triCount = b.readUInt32LE(off);
  off += 4;
  if (off + triCount * TRIANGLE_SIZE + 4 > b.length) return null;
  const tris = new Int32Array(triCount * 6);
  const flags = new Uint16Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const o = off + t * TRIANGLE_SIZE;
    for (let k = 0; k < 3; k++) {
      const vertex = b.readUInt16LE(o + k * 2);
      if (vertex >= vertexCount) return null;
      tris[t * 6 + k] = vertex;
      tris[t * 6 + 3 + k] = b.readInt16LE(o + 6 + k * 2);
    }
    flags[t] = b.readUInt16LE(o + TRIANGLE_FLAGS);
  }
  off += triCount * TRIANGLE_SIZE;
  const linkCount = b.readUInt32LE(off);
  off += 4;
  if (off + linkCount * LINK_SIZE > b.length) return null;
  const links: (Link | null)[] = [];
  for (let i = 0; i < linkCount; i++) {
    const o = off + i * LINK_SIZE;
    const portal = b.readUInt32LE(o) === LINK_PORTAL;
    links.push(portal ? { mesh: espmDesc(b.readUInt32LE(o + 4), rec.masters, rec.owner).toLowerCase(), tri: b.readInt16LE(o + 8) } : null);
  }
  return { parentId, min, max, verts, tris, flags, links };
}

// Triangles reachable from the one POS stands on without leaving the target's radius
function buildSpots(target: NavmeshTarget, meshes: Map<string, Mesh>, worldId: number | undefined): Spots | null {
  const area = new Map<string, Mesh>();
  for (const [key, m] of meshes) {
    if ((m.parentId === target.cellOrWorldId || m.parentId === worldId) && touches(m.min, m.max, target)) area.set(key, m);
  }
  let start: Mesh | null = null;
  let startTri = -1;
  let best = Infinity;
  for (const m of area.values()) {
    for (let t = 0; t < m.flags.length; t++) {
      const d = standDistance(m, t, target.pos);
      if (d < best) [start, startTri, best] = [m, t, d];
    }
  }
  if (!start || best > target.radius) return null;
  const radiusSq = target.radius * target.radius;
  const seen = new Map<Mesh, Uint8Array>();
  const mark = (m: Mesh, t: number): boolean => {
    let s = seen.get(m);
    if (!s) seen.set(m, (s = new Uint8Array(m.flags.length)));
    if (s[t]) return false;
    s[t] = 1;
    return true;
  };
  const corners: number[] = [];
  const flags: number[] = [];
  const queue: [Mesh, number][] = [[start, startTri]];
  mark(start, startTri);
  while (queue.length) {
    const [m, t] = queue.pop()!;
    for (let k = 0; k < 3; k++) {
      const v = m.tris[t * 6 + k] * 3;
      corners.push(m.verts[v], m.verts[v + 1], m.verts[v + 2]);
    }
    flags.push(m.flags[t]);
    for (let e = 0; e < 3; e++) {
      const edge = m.tris[t * 6 + 3 + e];
      let next: Mesh | undefined = m;
      let nextTri = edge;
      if (m.flags[t] & (1 << e)) {
        const link = m.links[edge];
        next = link ? area.get(link.mesh) : undefined;
        nextTri = link ? link.tri : -1;
      }
      if (!next || nextTri < 0 || nextTri >= next.flags.length || !mark(next, nextTri)) continue;
      if (centroidDistSq(next, nextTri, target.pos) <= radiusSq) queue.push([next, nextTri]);
    }
  }
  return { corners: Float32Array.from(corners), flags: Uint16Array.from(flags), pools: new Map() };
}

function pool(spots: Spots, name: PoolName): Pool | null {
  const cached = spots.pools.get(name);
  if (cached !== undefined) return cached;
  const index: number[] = [];
  const cum: number[] = [];
  let total = 0;
  const c = spots.corners;
  for (let t = 0; t < spots.flags.length; t++) {
    if (!POOL_TESTS[name](spots.flags[t])) continue;
    const o = t * 9;
    const [ux, uy, uz] = [c[o + 3] - c[o], c[o + 4] - c[o + 1], c[o + 5] - c[o + 2]];
    const [vx, vy, vz] = [c[o + 6] - c[o], c[o + 7] - c[o + 1], c[o + 8] - c[o + 2]];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(area > 0)) continue;
    total += area;
    index.push(t);
    cum.push(total);
  }
  const result = index.length ? { index: Uint32Array.from(index), cumArea: Float64Array.from(cum) } : null;
  spots.pools.set(name, result);
  return result;
}

// Uniform over the area of the triangles the kind may stand on
export function randomPointOn(spots: Spots, kind: SpotKind): number[] | null {
  let p: Pool | null = null;
  for (const name of POOL_ORDER[kind]) {
    p = pool(spots, name);
    if (p) break;
  }
  if (!p) return null;
  const pick = Math.random() * p.cumArea[p.cumArea.length - 1];
  let lo = 0;
  let hi = p.cumArea.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.cumArea[mid] > pick) hi = mid;
    else lo = mid + 1;
  }
  const o = p.index[lo] * 9;
  const c = spots.corners;
  let r1 = Math.random();
  let r2 = Math.random();
  if (r1 + r2 > 1) [r1, r2] = [1 - r1, 1 - r2];
  return [0, 1, 2].map((k) => c[o + k] + r1 * (c[o + 3 + k] - c[o + k]) + r2 * (c[o + 6 + k] - c[o + k]));
}

// One pass over the load order for every target; the last override of a navmesh wins and a deleted one drops out
export async function loadNavmeshSpots(mp: Mp, dataDir: string, loadOrder: string[], targets: NavmeshTarget[], log: LogFn): Promise<NavmeshScan> {
  const targetIds = new Set(targets.map((t) => t.cellOrWorldId));
  const lowIds = new Set(targets.map((t) => t.cellOrWorldId & LOW_ID_MASK));
  const worldOf = new Map<number, number>();
  const meshes = new Map<string, Mesh>();
  const ids = new Map<string, number>();
  // 0 when the server does not load the plugin
  const idOf = (rec: EspmRecord, formId: number): number => {
    const desc = espmDesc(formId, rec.masters, rec.owner);
    let id = ids.get(desc);
    if (id === undefined) {
      try { id = mp.getIdFromDesc(desc) >>> 0; } catch { id = 0; }
      ids.set(desc, id);
    }
    return id;
  };
  const skipped = await scanRecords(dataDir, loadOrder, ["CELL", "WRLD", "NAVM"], log, (rec) => {
    if (rec.type === "CELL") {
      if (!rec.world || !lowIds.has(rec.formId & LOW_ID_MASK)) return;
      const cellId = idOf(rec, rec.formId);
      if (targetIds.has(cellId)) worldOf.set(cellId, idOf(rec, rec.world));
      return;
    }
    if (rec.type !== "NAVM") return;
    const key = espmDesc(rec.formId, rec.masters, rec.owner).toLowerCase();
    const nvnm = rec.flags & RECORD_DELETED ? undefined : rec.fields.find((f) => f.type === "NVNM")?.data;
    const mesh = nvnm ? readMesh(rec, nvnm, targets, targetIds, lowIds, (formId) => idOf(rec, formId)) : null;
    if (mesh) meshes.set(key, mesh);
    else meshes.delete(key);
  });
  const spots = new Map<string, Spots | null>();
  for (const t of targets) {
    spots.set(t.key, buildSpots(t, meshes, worldOf.get(t.cellOrWorldId)));
    await new Promise<void>((r) => setImmediate(r));
  }
  return { spots, complete: skipped === 0 };
}
