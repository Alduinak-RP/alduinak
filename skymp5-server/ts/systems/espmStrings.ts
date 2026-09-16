import * as fs from "fs";
import * as path from "path";
import { LogFn } from "./espmEditorIds";

// Localized names from <plugin>_english.strings (loose Data/Strings, the plugin's own archive, then Skyrim - Interface.bsa); port of misc/gen-map-marker-teleports.py

const INTERFACE_BSA = "Skyrim - Interface.bsa";
const BSA_HEADER_SIZE = 36;
const ARCHIVE_COMPRESSED = 0x4;
const SIZE_COMPRESSION_TOGGLE = 0x40000000;
const SIZE_MASK = 0x3fffffff;

export interface BsaEntry {
  pos: number;
  size: number;
  compressed: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const cp1252 = new TextDecoder("windows-1252");

const decode = (b: Buffer): string => {
  try { return utf8.decode(b); } catch { return cp1252.decode(b); }
};

function readAt(file: string, pos: number, size: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size);
    const got = fs.readSync(fd, buf, 0, size, pos);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// Header, folder records, folder blocks and file names; the file data after them is never read here
function bsaIndexSize(head: Buffer): number {
  const rec = head.readUInt32LE(4) === 105 ? 24 : 16;
  const nfold = head.readUInt32LE(16);
  return head.readUInt32LE(8) + nfold * (rec + 1) + head.readUInt32LE(24) + head.readUInt32LE(20) * 16 + head.readUInt32LE(28);
}

// Lower-case "folder\name" -> entry; buf holds the archive from offset 0 through its file name block
export function readBsaIndex(buf: Buffer): Map<string, BsaEntry> {
  if (buf.length < BSA_HEADER_SIZE || buf.toString("latin1", 0, 4) !== "BSA\0") throw new Error("not a BSA archive");
  const ver = buf.readUInt32LE(4);
  if (ver !== 104 && ver !== 105) throw new Error(`unsupported BSA version ${ver}`);
  const off = buf.readUInt32LE(8);
  const archiveFlags = buf.readUInt32LE(12);
  const nfold = buf.readUInt32LE(16);
  const totalNames = buf.readUInt32LE(28);
  const rec = ver === 105 ? 24 : 16;
  const entries: { folder: string; size: number; pos: number }[] = [];
  let i = off + nfold * rec;
  for (let f = 0; f < nfold; f++) {
    const count = buf.readUInt32LE(off + f * rec + 8);
    const n = buf[i];
    const folder = buf.toString("latin1", i + 1, i + n).replace(/\0+$/, "");
    i += 1 + n;
    for (let k = 0; k < count; k++) {
      entries.push({ folder, size: buf.readUInt32LE(i + 8), pos: buf.readUInt32LE(i + 12) });
      i += 16;
    }
  }
  const names = buf.toString("latin1", i, i + totalNames).split("\0");
  const files = new Map<string, BsaEntry>();
  entries.forEach((e, k) => {
    if (k >= names.length) return;
    const compressed = !!(archiveFlags & ARCHIVE_COMPRESSED) !== !!(e.size & SIZE_COMPRESSION_TOGGLE);
    files.set(`${e.folder}\\${names[k]}`.toLowerCase(), { pos: e.pos, size: e.size & SIZE_MASK, compressed });
  });
  return files;
}

// String id -> text
export function parseStrings(raw: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  const count = raw.readUInt32LE(0);
  const base = 8 + count * 8;
  for (let k = 0; k < count; k++) {
    const id = raw.readUInt32LE(8 + k * 8);
    const start = base + raw.readUInt32LE(12 + k * 8);
    const end = raw.indexOf(0, start);
    out.set(id, decode(raw.subarray(start, end < 0 ? raw.length : end)));
  }
  return out;
}

// A missing or compressed table reads as empty and is logged once per plugin
export function createStringsReader(dataDir: string, log: LogFn): { lookup(plugin: string, id: number): string } {
  const tables = new Map<string, Map<number, string>>();
  const indexes = new Map<string, Map<string, BsaEntry> | null>();

  const fromBsa = (archive: string, name: string): Buffer | null => {
    const bsaPath = path.join(dataDir, archive);
    if (!indexes.has(archive)) {
      try {
        indexes.set(archive, fs.existsSync(bsaPath) ? readBsaIndex(readAt(bsaPath, 0, bsaIndexSize(readAt(bsaPath, 0, BSA_HEADER_SIZE)))) : null);
      } catch (e) {
        log(`espm strings: ${archive} unreadable: ${e}`);
        indexes.set(archive, null);
      }
    }
    const hit = indexes.get(archive)?.get(name);
    if (!hit) return null;
    if (hit.compressed) throw new Error(`${name} is compressed in ${archive}`);
    return readAt(bsaPath, hit.pos, hit.size);
  };

  const table = (plugin: string): Map<number, string> => {
    const key = path.basename(plugin, path.extname(plugin)).toLowerCase();
    let t = tables.get(key);
    if (t) return t;
    t = new Map();
    const file = `${key}_english.strings`;
    try {
      const loose = path.join(dataDir, "Strings", file);
      // Creation Club plugins carry their strings in an archive of their own name
      const raw = fs.existsSync(loose) ? fs.readFileSync(loose) : fromBsa(`${key}.bsa`, `strings\\${file}`) || fromBsa(INTERFACE_BSA, `strings\\${file}`);
      if (raw) t = parseStrings(raw);
      else log(`espm strings: ${file} is in neither Strings, ${key}.bsa nor ${INTERFACE_BSA}, its names fall back to editor ids`);
    } catch (e) {
      log(`espm strings: ${file} unreadable (${e}), its names fall back to editor ids`);
    }
    tables.set(key, t);
    return t;
  };

  return { lookup: (plugin, id) => table(plugin).get(id) ?? "" };
}
