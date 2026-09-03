import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

// Pure TS scan of the TES5 plugins for CELL and WRLD editor ids, so a spawn file can name "Kagrenzel01" without a native lookup.
// Records resolve to "hex:Plugin.esm" descs (the form the server's getIdFromDesc understands); the first plugin in the load order defining an id wins.

const HEADER_SIZE = 24;
const FLAG_COMPRESSED = 0x00040000;
// Four-char record tags read as little-endian uint32, cheaper than a string per record
const tag = (s: string): number => Buffer.from(s, "latin1").readUInt32LE(0);
const TAG_TES4 = tag("TES4");
const TAG_GRUP = tag("GRUP");
const TAG_CELL = tag("CELL");
const TAG_WRLD = tag("WRLD");
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

// Plugins only change with a restart, so results survive spawn file reloads
const cache = new Map<string, string>();
const knownMissing = new Set<string>();

// Returns true from the visitor to stop the scan
type Visit = (formId: number, editorId: string) => boolean;

const cstr = (b: Buffer): string => b.toString("latin1").replace(/\0+$/, "");

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

// EDID is the first subrecord when present, so the walk ends almost immediately
function readEditorId(buf: Buffer, dataOff: number, dataSize: number, flags: number): string {
  let data = buf.subarray(dataOff, dataOff + dataSize);
  if (flags & FLAG_COMPRESSED) {
    try { data = zlib.inflateSync(data.subarray(4)); } catch { return ""; }
  }
  let edid = "";
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

function* walkGroup(buf: Buffer, start: number, end: number, depth: number, visit: Visit): Generator<void, boolean, void> {
  let off = start;
  while (off + HEADER_SIZE <= end) {
    const type = buf.readUInt32LE(off);
    if (type === TAG_GRUP) {
      const size = buf.readUInt32LE(off + 4);
      if (size < HEADER_SIZE) return false;
      const label = buf.readUInt32LE(off + 8);
      // Top-level groups are labelled by record type; only the CELL and WRLD trees matter
      if (depth > 0 || label === TAG_CELL || label === TAG_WRLD) {
        if (yield* walkGroup(buf, off + HEADER_SIZE, Math.min(off + size, end), depth + 1, visit)) return true;
        if (depth < YIELD_DEPTH) yield;
      }
      off += size;
    } else {
      const dataSize = buf.readUInt32LE(off + 4);
      if (type === TAG_CELL || type === TAG_WRLD) {
        const flags = buf.readUInt32LE(off + 8);
        const formId = buf.readUInt32LE(off + 12);
        if (visit(formId, readEditorId(buf, off + HEADER_SIZE, dataSize, flags))) return true;
      }
      off += HEADER_SIZE + dataSize;
    }
  }
  return false;
}

async function scanPlugin(buf: Buffer, visit: Visit): Promise<boolean> {
  if (buf.length < HEADER_SIZE) return false;
  const it = walkGroup(buf, HEADER_SIZE + buf.readUInt32LE(4), buf.length, 0, visit);
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

export async function resolveEditorIds(editorIds: string[], dataDir: string, loadOrder: string[], log: LogFn): Promise<EditorIdScan> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const id of editorIds) {
    const key = id.toLowerCase();
    const hit = cache.get(key);
    if (hit) resolved.set(key, hit);
    else if (!knownMissing.has(key)) pending.add(key);
  }
  const started = Date.now();
  for (const entry of loadOrder) {
    if (!pending.size) break;
    const file = path.isAbsolute(entry) ? entry : path.join(dataDir, entry);
    const owner = path.basename(entry);
    let buf: Buffer;
    try { buf = await fs.promises.readFile(file); }
    catch { log(`espm scan: plugin '${owner}' not readable at ${file}, skipped`); continue; }
    const masters = readMasters(buf);
    await scanPlugin(buf, (formId, editorId) => {
      const key = editorId.toLowerCase();
      if (!key || !pending.has(key)) return false;
      const high = formId >>> 24;
      const desc = (formId & 0xffffff).toString(16) + ":" + (high < masters.length ? masters[high] : owner);
      cache.set(key, desc);
      resolved.set(key, desc);
      pending.delete(key);
      return !pending.size;
    });
  }
  for (const key of pending) knownMissing.add(key);
  const unresolved = editorIds.filter((id) => !resolved.has(id.toLowerCase()));
  return { resolved, unresolved, scannedMs: Date.now() - started };
}
