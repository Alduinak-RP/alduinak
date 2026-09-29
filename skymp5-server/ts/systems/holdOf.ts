import { scanRecords, espmDesc, cstr, LogFn, EspmRecord } from "./espmEditorIds";
import { createStringsReader } from "./espmStrings";
import { formIdFromConfig } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// The hold a placed reference lies in: its cell's location (XLCN) walked up the parent locations (PNAM) to the location
// carrying the LocTypeHold keyword. An exterior cell without one takes its worldspace's location (the walled cities), then
// the hold most located cells share on the nearest ring of cells around it, up to NEAREST_CELLS out.

export interface Hold {
  // As housing and the court factions name holds: "whiterun", "rift", "reach"
  key: string;
  // The hold location's name, capitalized: "Whiterun", "The Pale"
  name: string;
}

const HOLD_KEYWORD = "LocTypeHold";
const RECORD_DELETED = 0x20;
const CELL_INTERIOR = 0x01;
const CELL_UNITS = 4096;
const NEAREST_CELLS = 3;
const MAX_PARENT_DEPTH = 16;

interface LocationRec {
  edid: string;
  name: string;
  parent: string;
  keywords: string[];
}

// Cell and worldspace ids -> hold, filled once the plugins are scanned
const interiorHolds = new Map<number, Hold>();
// World id -> "x,y" cell grid -> hold
const exteriorHolds = new Map<number, Map<string, Hold>>();
const worldHolds = new Map<number, Hold>();

const fieldOf = (rec: EspmRecord, type: string): Buffer | undefined => rec.fields.find((f) => f.type === type)?.data;

// "WhiterunHoldLocation" -> "whiterun", "DLC2SolstheimLocation" -> "solstheim"
const holdKeyOf = (edid: string): string => edid.toLowerCase().replace(/^dlc\d+/, "").replace(/(hold)?location$/, "");

// Scans the load order once; until it finishes every reference reads as outside any hold
export async function loadHolds(mp: Mp, dataDir: string, loadOrder: string[], log: LogFn): Promise<void> {
  const started = Date.now();
  const strings = createStringsReader(dataDir, log);
  const locations = new Map<string, LocationRec>();
  const cells = new Map<string, string>();
  const exteriors = new Map<string, { world: string; grid: string; loc: string }>();
  const worlds = new Map<string, string>();
  let holdKeyword = "";
  await scanRecords(dataDir, loadOrder, ["KYWD", "LCTN", "CELL", "WRLD"], log, (rec) => {
    const desc = espmDesc(rec.formId, rec.masters, rec.owner).toLowerCase();
    const ref = (data?: Buffer): string => (data && data.length >= 4 ? espmDesc(data.readUInt32LE(0), rec.masters, rec.owner).toLowerCase() : "");
    const deleted = (rec.flags & RECORD_DELETED) !== 0;
    if (rec.type === "KYWD") {
      if (!deleted && cstr(fieldOf(rec, "EDID") ?? Buffer.alloc(0)) === HOLD_KEYWORD) holdKeyword = desc;
    } else if (rec.type === "LCTN" && deleted) {
      locations.delete(desc);
    } else if (rec.type === "LCTN") {
      const kwda = fieldOf(rec, "KWDA");
      const full = fieldOf(rec, "FULL");
      const edid = cstr(fieldOf(rec, "EDID") ?? Buffer.alloc(0));
      locations.set(desc, {
        edid,
        name: !full ? "" : !rec.localized ? cstr(full) : full.length >= 4 ? strings.lookup(rec.owner, full.readUInt32LE(0)) : "",
        parent: ref(fieldOf(rec, "PNAM")),
        keywords: kwda ? Array.from({ length: kwda.length >> 2 }, (_, i) => ref(kwda.subarray(i * 4, i * 4 + 4))) : [],
      });
    } else if (rec.type === "WRLD") {
      worlds.set(desc, deleted ? "" : ref(fieldOf(rec, "XLCN")));
    } else if (rec.type === "CELL") {
      // A later override without a location clears the earlier one
      const loc = deleted ? "" : ref(fieldOf(rec, "XLCN"));
      const data = fieldOf(rec, "DATA");
      const xclc = fieldOf(rec, "XCLC");
      cells.delete(desc);
      exteriors.delete(desc);
      if (!loc) return;
      if (data && data.length && (data[0] & CELL_INTERIOR)) cells.set(desc, loc);
      else if (rec.world && xclc && xclc.length >= 8) {
        exteriors.set(desc, { world: espmDesc(rec.world, rec.masters, rec.owner).toLowerCase(), grid: `${xclc.readInt32LE(0)},${xclc.readInt32LE(4)}`, loc });
      }
    }
  });

  const resolved = new Map<string, Hold | null>();
  const holdOfLocation = (desc: string): Hold | null => {
    const hit = resolved.get(desc);
    if (hit !== undefined) return hit;
    let hold: Hold | null = null;
    let at = desc;
    for (let depth = 0; at && depth < MAX_PARENT_DEPTH; depth++) {
      const loc = locations.get(at);
      if (!loc) break;
      if (holdKeyword && loc.keywords.includes(holdKeyword)) {
        const key = holdKeyOf(loc.edid);
        const name = loc.name || key;
        hold = { key, name: name.charAt(0).toUpperCase() + name.slice(1) };
        break;
      }
      at = loc.parent;
    }
    resolved.set(desc, hold);
    return hold;
  };
  const ids = new Map<string, number>();
  const idOf = (desc: string): number => {
    let id = ids.get(desc);
    if (id === undefined) {
      id = formIdFromConfig(mp, desc);
      ids.set(desc, id);
    }
    return id;
  };

  interiorHolds.clear();
  exteriorHolds.clear();
  worldHolds.clear();
  for (const [desc, loc] of cells) {
    const hold = holdOfLocation(loc);
    const id = hold ? idOf(desc) : 0;
    if (id) interiorHolds.set(id, hold!);
  }
  for (const { world, grid, loc } of exteriors.values()) {
    const hold = holdOfLocation(loc);
    const worldId = hold ? idOf(world) : 0;
    if (!worldId) continue;
    let byGrid = exteriorHolds.get(worldId);
    if (!byGrid) exteriorHolds.set(worldId, byGrid = new Map());
    byGrid.set(grid, hold!);
  }
  for (const [desc, loc] of worlds) {
    const hold = loc ? holdOfLocation(loc) : null;
    const id = hold ? idOf(desc) : 0;
    if (id) worldHolds.set(id, hold!);
  }
  const located = Array.from(exteriorHolds.values()).reduce((n, m) => n + m.size, 0);
  log(`[holds] ${holdKeyword ? "" : `no ${HOLD_KEYWORD} keyword, `}${interiorHolds.size} interior cell(s), ${located} exterior cell(s) and ${worldHolds.size} worldspace(s) in a hold, from ${locations.size} location(s) in ${Date.now() - started} ms`);
}

// Cell id and position of a reference; null when it is not loaded
const whereIs = (mp: Mp, refrId: number): { cell: number; x: number; y: number } | null => {
  try {
    const cell = formIdFromConfig(mp, String(mp.get(refrId, "worldOrCellDesc")));
    const pos = mp.get(refrId, "pos");
    return cell ? { cell, x: Math.floor(Number(pos[0]) / CELL_UNITS), y: Math.floor(Number(pos[1]) / CELL_UNITS) } : null;
  } catch {
    return null;
  }
};

const exactHold = (mp: Mp, refrId: number): Hold | null => {
  const at = whereIs(mp, refrId);
  if (!at) return null;
  return interiorHolds.get(at.cell) ?? exteriorHolds.get(at.cell)?.get(`${at.x},${at.y}`) ?? worldHolds.get(at.cell) ?? null;
};

// The hold most located cells share on the nearest ring that has any
const nearbyHold = (mp: Mp, refrId: number): Hold | null => {
  const at = whereIs(mp, refrId);
  const byGrid = at ? exteriorHolds.get(at.cell) : undefined;
  if (!at || !byGrid) return null;
  for (let r = 1; r <= NEAREST_CELLS; r++) {
    const votes = new Map<string, { hold: Hold; n: number }>();
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const hold = byGrid.get(`${at.x + dx},${at.y + dy}`);
        if (!hold) continue;
        const vote = votes.get(hold.key);
        if (vote) vote.n++;
        else votes.set(hold.key, { hold, n: 1 });
      }
    }
    let best: { hold: Hold; n: number } | null = null;
    for (const vote of votes.values()) if (!best || vote.n > best.n) best = vote;
    if (best) return best.hold;
  }
  return null;
};

// Exact answers of every reference (both halves of a teleport door) before the nearest-ring guess of any
export function holdOfRefs(mp: Mp, refrIds: number[]): Hold | null {
  for (const id of refrIds) {
    const hold = exactHold(mp, id);
    if (hold) return hold;
  }
  for (const id of refrIds) {
    const hold = nearbyHold(mp, id);
    if (hold) return hold;
  }
  return null;
}
