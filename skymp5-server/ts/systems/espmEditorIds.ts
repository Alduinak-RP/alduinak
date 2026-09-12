import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

// Pure TS scan of the TES5 plugins for editor ids of the requested record types (CELL and WRLD by default, KYWD for the mastery
// keyword lists), so a config file can name "Kagrenzel01" or "CraftingSmithingForge" without a native lookup.
// Records resolve to "hex:Plugin.esm" descs (the form the server's getIdFromDesc understands); the first plugin in the load order defining an id wins.

const HEADER_SIZE = 24;
const FLAG_COMPRESSED = 0x00040000;
const FLAG_LOCALIZED = 0x00000080;
// Four-char record tags read as little-endian uint32, cheaper than a string per record
const tag = (s: string): number => Buffer.from(s, "latin1").readUInt32LE(0);
const tagName = (t: number): string => Buffer.from([t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, t >>> 24]).toString("latin1");
const TAG_TES4 = tag("TES4");
const TAG_GRUP = tag("GRUP");
const TAG_EDID = tag("EDID");
const TAG_MAST = tag("MAST");
const TAG_XXXX = tag("XXXX");
// Groups this deep and shallower hand control back to the event loop so the game tick keeps running
const YIELD_DEPTH = 3;
const YIELD_MS = 20;

export type LogFn = (line: string) => void;

export interface EditorIdScan {
  // lower-case editor id -> desc
  resolved: Map<string, string>;
  unresolved: string[];
  scannedMs: number;
}

// Field buffers may alias the whole plugin file, so visitors copy out what they keep
export interface EspmRecord {
  owner: string;
  masters: string[];
  localized: boolean;
  type: string;
  formId: number;
  fields: { type: string; data: Buffer }[];
}

const DEFAULT_TYPES = ["CELL", "WRLD"];

// A locator that is neither a "hex:Plugin" desc nor a bare form id
export const isEditorId = (locator: string): boolean =>
  !locator.includes(":") && !/^0x[0-9a-f]+$/i.test(locator) && !/^[0-9a-f]{8}$/i.test(locator);

// Plugins only change with a restart, so results survive spawn file reloads
const cache = new Map<string, string>();
// Keyed by record types too: an id missing from the CELL tree may still be a KYWD
const knownMissing = new Set<string>();

// Returns true from the visitor to stop the scan
type Visit = (type: number, formId: number, data: Buffer | null) => boolean;

export const cstr = (b: Buffer): string => b.toString("latin1").replace(/\0+$/, "");

// Plugin-local form id to "hex:Plugin" using the masters of the plugin it was read from
export const espmDesc = (formId: number, masters: string[], owner: string): string => {
  const high = formId >>> 24;
  return (formId & 0xffffff).toString(16) + ":" + (high < masters.length ? masters[high] : owner);
};

// Walks the subrecords of one record body; the callback returns true to stop early
function eachSubrecord(data: Buffer, cb: (type: number, body: Buffer) => boolean): void {
  let off = 0;
  let oversize = 0;
  while (off + 6 <= data.length) {
    const type = data.readUInt32LE(off);
    let size = data.readUInt16LE(off + 4);
    off += 6;
    if (type === TAG_XXXX) {
      oversize = data.readUInt32LE(off);
      off += size;
      continue;
    }
    if (oversize) {
      size = oversize;
      oversize = 0;
    }
    if (cb(type, data.subarray(off, off + size))) return;
    off += size;
  }
}

function recordData(buf: Buffer, dataOff: number, dataSize: number, flags: number): Buffer | null {
  const data = buf.subarray(dataOff, dataOff + dataSize);
  if (!(flags & FLAG_COMPRESSED)) return data;
  try { return zlib.inflateSync(data.subarray(4)); } catch { return null; }
}

// EDID is the first subrecord when present, so the walk ends almost immediately
function readEditorId(data: Buffer | null): string {
  let edid = "";
  if (!data) return edid;
  eachSubrecord(data, (type, body) => {
    if (type === TAG_EDID) edid = cstr(body);
    return true;
  });
  return edid;
}

function readMasters(buf: Buffer): string[] {
  const masters: string[] = [];
  if (buf.length < HEADER_SIZE || buf.readUInt32LE(0) !== TAG_TES4) return masters;
  const dataSize = buf.readUInt32LE(4);
  eachSubrecord(buf.subarray(HEADER_SIZE, HEADER_SIZE + dataSize), (type, body) => {
    if (type === TAG_MAST) masters.push(cstr(body));
    return false;
  });
  return masters;
}

function* walkGroup(buf: Buffer, start: number, end: number, depth: number, tags: Set<number>, visit: Visit): Generator<void, boolean, void> {
  let off = start;
  while (off + HEADER_SIZE <= end) {
    const type = buf.readUInt32LE(off);
    if (type === TAG_GRUP) {
      const size = buf.readUInt32LE(off + 4);
      if (size < HEADER_SIZE) return false;
      const label = buf.readUInt32LE(off + 8);
      // Top-level groups are labelled by record type; only the requested trees matter
      if (depth > 0 || tags.has(label)) {
        if (yield* walkGroup(buf, off + HEADER_SIZE, Math.min(off + size, end), depth + 1, tags, visit)) return true;
        if (depth < YIELD_DEPTH) yield;
      }
      off += size;
    } else {
      const dataSize = buf.readUInt32LE(off + 4);
      if (tags.has(type)) {
        const flags = buf.readUInt32LE(off + 8);
        const formId = buf.readUInt32LE(off + 12);
        if (visit(type, formId, recordData(buf, off + HEADER_SIZE, dataSize, flags))) return true;
      }
      off += HEADER_SIZE + dataSize;
    }
  }
  return false;
}

async function scanPlugin(buf: Buffer, tags: Set<number>, visit: Visit): Promise<boolean> {
  if (buf.length < HEADER_SIZE) return false;
  const it = walkGroup(buf, HEADER_SIZE + buf.readUInt32LE(4), buf.length, 0, tags, visit);
  let lastYield = Date.now();
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
    if (Date.now() - lastYield >= YIELD_MS) {
      await new Promise<void>((r) => setImmediate(r));
      lastYield = Date.now();
    }
  }
}

async function readPlugin(entry: string, dataDir: string, log: LogFn): Promise<{ buf: Buffer; owner: string } | null> {
  const file = path.isAbsolute(entry) ? entry : path.join(dataDir, entry);
  const owner = path.basename(entry);
  try { return { buf: await fs.promises.readFile(file), owner }; }
  catch { log(`espm scan: plugin '${owner}' not readable at ${file}, skipped`); return null; }
}

// Visits every record of the given types, plugin by plugin in load order, so later overrides arrive last
export async function scanRecords(dataDir: string, loadOrder: string[], types: string[], log: LogFn, visit: (rec: EspmRecord) => void): Promise<void> {
  const tags = new Set(types.map(tag));
  for (const entry of loadOrder) {
    const plugin = await readPlugin(entry, dataDir, log);
    if (!plugin) continue;
    const { buf, owner } = plugin;
    const masters = readMasters(buf);
    const localized = buf.length >= HEADER_SIZE && (buf.readUInt32LE(8) & FLAG_LOCALIZED) !== 0;
    await scanPlugin(buf, tags, (type, formId, data) => {
      if (!data) return false;
      const fields: EspmRecord["fields"] = [];
      eachSubrecord(data, (t, body) => { fields.push({ type: tagName(t), data: body }); return false; });
      visit({ owner, masters, localized, type: tagName(type), formId, fields });
      return false;
    });
  }
}

export async function resolveEditorIds(editorIds: string[], dataDir: string, loadOrder: string[], log: LogFn, types: string[] = DEFAULT_TYPES): Promise<EditorIdScan> {
  const tags = new Set(types.map(tag));
  const missingKey = (key: string) => types.join(",") + "|" + key;
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const id of editorIds) {
    const key = id.toLowerCase();
    const hit = cache.get(key);
    if (hit) resolved.set(key, hit);
    else if (!knownMissing.has(missingKey(key))) pending.add(key);
  }
  const started = Date.now();
  for (const entry of loadOrder) {
    if (!pending.size) break;
    const plugin = await readPlugin(entry, dataDir, log);
    if (!plugin) continue;
    const masters = readMasters(plugin.buf);
    await scanPlugin(plugin.buf, tags, (_type, formId, data) => {
      const key = readEditorId(data).toLowerCase();
      if (!key || !pending.has(key)) return false;
      const desc = espmDesc(formId, masters, plugin.owner);
      cache.set(key, desc);
      resolved.set(key, desc);
      pending.delete(key);
      return !pending.size;
    });
  }
  for (const key of pending) knownMissing.add(missingKey(key));
  const unresolved = editorIds.filter((id) => !resolved.has(id.toLowerCase()));
  return { resolved, unresolved, scannedMs: Date.now() - started };
}
