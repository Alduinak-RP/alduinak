import { scanRecords, espmDesc, cstr, LogFn, EspmRecord } from "./espmEditorIds";
import { createStringsReader } from "./espmStrings";

// Spawnable items of the server load order for the admin Item Spawner; the last override of each record wins, like in game

export const ITEM_TYPES = ["WEAP", "ARMO", "AMMO", "ALCH", "INGR", "BOOK", "MISC", "KEYM", "SCRL", "SLGM", "LIGH"];
export const MAX_QUERY_LENGTH = 64;
export const ARMO_NON_PLAYABLE = 0x4;
const FLAG_DELETED = 0x20;
// LIGH DATA: time, radius, color, then flags
const LIGH_FLAGS_OFFSET = 12;
const LIGH_CARRIED = 0x2;

export interface CatalogItem {
  desc: string;
  name: string;
  edid: string;
  type: string;
  plugin: string;
  // lower-case name, edid and desc
  hay: string;
}

const fieldOf = (rec: EspmRecord, type: string): Buffer | undefined => rec.fields.find((f) => f.type === type)?.data;

// FULL of a record, read through the owner's string tables when the plugin is localized
const fullName = (rec: EspmRecord, strings: ReturnType<typeof createStringsReader>): string => {
  const full = fieldOf(rec, "FULL");
  if (!full) return "";
  if (!rec.localized) return cstr(full);
  return full.length >= 4 ? strings.lookup(rec.owner, full.readUInt32LE(0)) : "";
};

// "5a68:HearthFires.esm" and "005A68:hearthfires.esm" give the same key
export const descKey = (desc: string): string => {
  const at = desc.indexOf(":");
  return `${parseInt(desc.slice(0, at), 16)}:${desc.slice(at + 1).toLowerCase()}`;
};

const collate = new Intl.Collator("en", { sensitivity: "base" }).compare;

const isCarryableLight = (rec: EspmRecord): boolean => {
  const data = fieldOf(rec, "DATA");
  return !!data && data.length >= LIGH_FLAGS_OFFSET + 4 && (data.readUInt32LE(LIGH_FLAGS_OFFSET) & LIGH_CARRIED) !== 0;
};

export async function buildItemCatalog(dataDir: string, loadOrder: string[], log: LogFn): Promise<CatalogItem[]> {
  const strings = createStringsReader(dataDir, log);
  const byKey = new Map<string, CatalogItem>();
  await scanRecords(dataDir, loadOrder, ITEM_TYPES, log, (rec) => {
    const desc = espmDesc(rec.formId, rec.masters, rec.owner);
    const key = desc.toLowerCase();
    if ((rec.flags & FLAG_DELETED) || (rec.type === "ARMO" && (rec.flags & ARMO_NON_PLAYABLE)) || (rec.type === "LIGH" && !isCarryableLight(rec))) {
      byKey.delete(key);
      return;
    }
    const name = fullName(rec, strings);
    const prev = byKey.get(key);
    const first = prev?.desc ?? desc;
    byKey.set(key, {
      desc: first,
      name: name || prev?.name || "",
      edid: cstr(fieldOf(rec, "EDID") ?? Buffer.alloc(0)) || prev?.edid || "",
      type: rec.type,
      plugin: first.slice(first.indexOf(":") + 1),
      hay: "",
    });
  });
  const items: CatalogItem[] = [];
  for (const item of byKey.values()) {
    const name = item.name || item.edid;
    if (!name) continue;
    items.push({ ...item, name, hay: `${name} ${item.edid} ${item.desc}`.toLowerCase() });
  }
  return items.sort((a, b) => collate(a.name, b.name));
}

// Names of a few items by descKey, as the last override in the load order gives them; one scan of the given record types
export async function itemNames(descs: string[], types: string[], dataDir: string, loadOrder: string[], log: LogFn): Promise<Map<string, string>> {
  const wanted = new Set(descs.map(descKey));
  const names = new Map<string, string>();
  if (!wanted.size) return names;
  const strings = createStringsReader(dataDir, log);
  await scanRecords(dataDir, loadOrder, types, log, (rec) => {
    const key = descKey(espmDesc(rec.formId, rec.masters, rec.owner));
    const name = wanted.has(key) ? fullName(rec, strings) : "";
    if (name) names.set(key, name);
  });
  return names;
}

export const normaliseQuery = (query: unknown): string => String(query ?? "").trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);
export const normaliseKind = normaliseQuery;

// Every token must appear; ranks an exact name, then a name prefix, then a name word starting with the first token
export function searchItems(items: CatalogItem[], query: string, kind: string, limit = 50, offset = 0): { total: number; rows: CatalogItem[] } {
  const q = normaliseQuery(query);
  const type = normaliseKind(kind).toUpperCase();
  if (q.length < 2 && !type) return { total: 0, rows: [] };
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = items.filter((it) => (!type || it.type === type) && tokens.every((t) => it.hay.includes(t)));
  if (!tokens.length) return { total: matches.length, rows: matches.slice(offset, offset + limit) };
  const phrase = tokens.join(" ");
  const rank = (it: CatalogItem): number => {
    const name = it.name.toLowerCase();
    if (name === phrase) return 0;
    if (name.startsWith(phrase)) return 1;
    return name.split(/\W+/).some((w) => w.startsWith(tokens[0])) ? 2 : 3;
  };
  const ranked = matches.map((it) => ({ it, r: rank(it) }));
  ranked.sort((a, b) => a.r - b.r || a.it.name.length - b.it.name.length || collate(a.it.name, b.it.name));
  return { total: matches.length, rows: ranked.slice(offset, offset + limit).map((x) => x.it) };
}
