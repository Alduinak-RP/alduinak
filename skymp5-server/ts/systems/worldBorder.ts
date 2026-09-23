import { scanRecords, espmDesc, EspmRecord, LogFn } from "./espmEditorIds";
import { StartLocation, arrivalPos } from "./startLocations";
import { formIdFromConfig } from "./formIdUtil";
import { pointInPolygon } from "./weatherSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// The world border of the load order's REGN records, which the engine enforces only on each player's own client

// REGN record header flag the engine tests for its border
const REGION_BORDER = 0x40;
const RECORD_DELETED = 0x20;
const MIN_AREA_POINTS = 3;

export interface Locational {
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

// World id -> border areas, each a list of x,y points
const areasByWorld = new Map<number, number[][][]>();
const lastInside = new Map<number, Locational>();

// Field buffers alias the plugin file, so the points are copied out
function readBorder(mp: Mp, rec: EspmRecord): { world: number; areas: number[][][] } | null {
  if (rec.flags & RECORD_DELETED || !(rec.flags & REGION_BORDER)) return null;
  const wnam = rec.fields.find((f) => f.type === "WNAM")?.data;
  const areas = rec.fields
    .filter((f) => f.type === "RPLD")
    .map(({ data }) => Array.from({ length: data.length >> 3 }, (_, i) => [data.readFloatLE(i * 8), data.readFloatLE(i * 8 + 4)]))
    .filter((a) => a.length >= MIN_AREA_POINTS);
  if (!wnam || wnam.length < 4 || !areas.length) return null;
  const world = formIdFromConfig(mp, espmDesc(wnam.readUInt32LE(0), rec.masters, rec.owner));
  return world ? { world, areas } : null;
}

export async function loadWorldBorders(mp: Mp, dataDir: string, loadOrder: string[], log: LogFn): Promise<void> {
  // Keyed by region desc, so a later override replaces an earlier one
  const regions = new Map<string, { world: number; areas: number[][][] } | null>();
  await scanRecords(dataDir, loadOrder, ["REGN"], log, (rec) => {
    regions.set(espmDesc(rec.formId, rec.masters, rec.owner).toLowerCase(), readBorder(mp, rec));
  });
  areasByWorld.clear();
  let count = 0;
  for (const region of regions.values()) {
    if (!region) continue;
    count++;
    areasByWorld.set(region.world, [...(areasByWorld.get(region.world) ?? []), ...region.areas]);
  }
  log(`[border] ${count} border region(s) over ${areasByWorld.size} worldspace(s)`);
}

// False in interiors, in worldspaces without a border and for unknown descs
export function isOutsideBorder(mp: Mp, loc: Locational): boolean {
  const areas = areasByWorld.get(formIdFromConfig(mp, String(loc.cellOrWorldDesc)));
  if (!areas) return false;
  const x = Number(loc.pos[0]);
  const y = Number(loc.pos[1]);
  return !areas.some((a) => pointInPolygon(a, x, y));
}

export function noteInside(actorId: number, loc: Locational): void {
  lastInside.set(actorId, { cellOrWorldDesc: String(loc.cellOrWorldDesc), pos: [...loc.pos], rot: [...loc.rot] });
}

// The actor's last spot inside in the same worldspace, else the nearest start location there, else null
export function insideSpot(mp: Mp, actorId: number, loc: Locational, starts: StartLocation[]): Locational | null {
  const desc = String(loc.cellOrWorldDesc);
  const last = lastInside.get(actorId);
  if (last && last.cellOrWorldDesc.toLowerCase() === desc.toLowerCase()) return last;
  const world = formIdFromConfig(mp, desc);
  const distance = (s: StartLocation): number => Math.hypot(s.pos[0] - loc.pos[0], s.pos[1] - loc.pos[1]);
  const start = starts
    .filter((s) => s.worldOrCell >>> 0 === world)
    .reduce<StartLocation | null>((best, s) => (!best || distance(s) < distance(best) ? s : best), null);
  if (!start) return null;
  return { cellOrWorldDesc: mp.getDescFromId(start.worldOrCell), pos: arrivalPos(start), rot: [0, 0, start.angleZ] };
}
