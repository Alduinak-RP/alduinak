#!/usr/bin/env node
// Generates src/data/mapMarkerRefs.ts: every map marker REFR of the server load order as [localId, plugin] pairs.
// Usage: node scripts/gen-map-markers.js [--data <dir>] [--load-order <json file | comma list>] [--out <file>]
// Without arguments the load order and data dir come from ../../build/dist/server/server-settings.json.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const HEADER_SIZE = 24;
const FLAG_DELETED = 0x00000020;
const FLAG_COMPRESSED = 0x00040000;
const MARKER_LOCAL_ID = 0x10;
const MARKER_PLUGIN = "skyrim.esm";
const tag = (s) => Buffer.from(s, "latin1").readUInt32LE(0);
const TAG_TES4 = tag("TES4");
const TAG_GRUP = tag("GRUP");
const TAG_CELL = tag("CELL");
const TAG_WRLD = tag("WRLD");
const TAG_REFR = tag("REFR");
const TAG_NAME = tag("NAME");
const TAG_MAST = tag("MAST");
const TAG_XXXX = tag("XXXX");

const cstr = (b) => b.toString("latin1").replace(/\0+$/, "");

function eachSubrecord(data, cb) {
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

function readMasters(buf) {
  const masters = [];
  if (buf.length < HEADER_SIZE || buf.readUInt32LE(0) !== TAG_TES4) return masters;
  const dataSize = buf.readUInt32LE(4);
  eachSubrecord(buf.subarray(HEADER_SIZE, HEADER_SIZE + dataSize), (type, body) => {
    if (type === TAG_MAST) masters.push(cstr(body));
    return false;
  });
  return masters;
}

// Base form of a REFR, read from its NAME subrecord (0 when absent or unreadable)
function readBaseId(buf, dataOff, dataSize, flags) {
  let data = buf.subarray(dataOff, dataOff + dataSize);
  if (flags & FLAG_COMPRESSED) {
    try { data = zlib.inflateSync(data.subarray(4)); } catch { return 0; }
  }
  let baseId = 0;
  eachSubrecord(data, (type, body) => {
    if (type !== TAG_NAME) return false;
    if (body.length >= 4) baseId = body.readUInt32LE(0);
    return true;
  });
  return baseId;
}

// Visits every REFR under the CELL and WRLD trees: visit(formId, flags, dataOff, dataSize)
function walkGroup(buf, start, end, depth, visit) {
  let off = start;
  while (off + HEADER_SIZE <= end) {
    const type = buf.readUInt32LE(off);
    if (type === TAG_GRUP) {
      const size = buf.readUInt32LE(off + 4);
      if (size < HEADER_SIZE) return;
      const label = buf.readUInt32LE(off + 8);
      if (depth > 0 || label === TAG_CELL || label === TAG_WRLD) {
        walkGroup(buf, off + HEADER_SIZE, Math.min(off + size, end), depth + 1, visit);
      }
      off += size;
    } else {
      const dataSize = buf.readUInt32LE(off + 4);
      if (type === TAG_REFR) {
        visit(buf.readUInt32LE(off + 12), buf.readUInt32LE(off + 8), off + HEADER_SIZE, dataSize);
      }
      off += HEADER_SIZE + dataSize;
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; ++i) {
    if (!argv[i].startsWith("--")) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    ++i;
  }
  return args;
}

// A relative dataDir in a settings file is relative to that file, as the server resolves it from its own directory
function readSettings(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.dataDir) parsed.dataDir = path.resolve(path.dirname(file), parsed.dataDir);
  return parsed;
}

function readLoadOrder(args) {
  const settingsPath = path.join(__dirname, "..", "..", "build", "dist", "server", "server-settings.json");
  let loadOrder;
  let dataDir = args.data;
  if (args["load-order"]) {
    const value = args["load-order"];
    if (fs.existsSync(value)) {
      const parsed = readSettings(value);
      if (Array.isArray(parsed)) {
        loadOrder = parsed;
      } else {
        loadOrder = parsed.loadOrder;
        dataDir = dataDir || parsed.dataDir;
      }
    } else {
      loadOrder = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if ((!loadOrder || !dataDir) && fs.existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    loadOrder = loadOrder || settings.loadOrder;
    dataDir = dataDir || settings.dataDir;
  }
  if (!Array.isArray(loadOrder) || !loadOrder.length) {
    throw new Error(`no load order: pass --load-order, or build the server so ${settingsPath} exists`);
  }
  return { loadOrder, dataDir: dataDir || "." };
}

function collectMarkers(loadOrder, dataDir, log) {
  // desc "hex:Plugin" -> [localId, plugin]; a later override without the marker base (or deleted) drops it
  const markers = new Map();
  const names = loadOrder.map((entry) => path.basename(entry));
  // MAST names can differ in case from the load order, so descs and ranks use the load-order spelling
  const canon = (name) => names.find((p) => p.toLowerCase() === name.toLowerCase()) || name;
  for (let i = 0; i < loadOrder.length; ++i) {
    const file = path.isAbsolute(loadOrder[i]) ? loadOrder[i] : path.join(dataDir, loadOrder[i]);
    const owner = names[i];
    let buf;
    try { buf = fs.readFileSync(file); }
    catch {
      if (i === 0 || owner.toLowerCase() === MARKER_PLUGIN) throw new Error(`${owner}: not readable at ${file}`);
      log(`${owner}: not readable at ${file}, skipped`);
      continue;
    }
    if (buf.length < HEADER_SIZE) continue;
    const masters = readMasters(buf).map(canon);
    const pluginOf = (id) => { const high = id >>> 24; return high < masters.length ? masters[high] : owner; };
    let own = 0, overrides = 0, dropped = 0;
    walkGroup(buf, HEADER_SIZE + buf.readUInt32LE(4), buf.length, 0, (formId, flags, dataOff, dataSize) => {
      const plugin = pluginOf(formId);
      const localId = formId & 0xffffff;
      const desc = localId.toString(16) + ":" + plugin;
      const baseId = flags & FLAG_DELETED ? 0 : readBaseId(buf, dataOff, dataSize, flags);
      const isMarker = baseId !== 0 && (baseId & 0xffffff) === MARKER_LOCAL_ID && pluginOf(baseId).toLowerCase() === MARKER_PLUGIN;
      if (isMarker) {
        if (plugin === owner) ++own; else ++overrides;
        markers.set(desc, [localId, plugin]);
      } else if (markers.delete(desc)) {
        ++dropped;
      }
    });
    log(`${owner}: ${own} own markers, ${overrides} overrides of master markers, ${dropped} dropped by override`);
  }
  const rank = (plugin) => { const i = names.indexOf(plugin); return i < 0 ? names.length : i; };
  return Array.from(markers.values()).sort((a, b) => rank(a[1]) - rank(b[1]) || a[0] - b[0]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { loadOrder, dataDir } = readLoadOrder(args);
  const out = args.out || path.join(__dirname, "..", "src", "data", "mapMarkerRefs.ts");
  const log = (line) => console.log(line);
  const markers = collectMarkers(loadOrder, dataDir, log);
  if (!markers.length) throw new Error("no markers collected, check --data and --load-order");
  const perPlugin = new Map();
  for (const [, plugin] of markers) perPlugin.set(plugin, (perPlugin.get(plugin) || 0) + 1);
  console.log("---- markers per plugin (by owning plugin)");
  for (const [plugin, n] of perPlugin) console.log(`${plugin}: ${n}`);
  console.log(`total: ${markers.length}`);
  const lines = markers.map(([localId, plugin]) => `  [0x${localId.toString(16)}, ${JSON.stringify(plugin)}],`);
  const body = [
    "// Generated by scripts/gen-map-markers.js, do not edit by hand",
    "// [localId, plugin] of every REFR whose base is the MapMarker STAT (Skyrim.esm 0x10) in the server load order",
    "export const MAP_MARKER_REFS: Array<[number, string]> = [",
    ...lines,
    "];",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  console.log(`wrote ${out}`);
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { eachSubrecord, readMasters, walkGroup, collectMarkers, HEADER_SIZE, FLAG_COMPRESSED };
