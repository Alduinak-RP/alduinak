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
    const full = fieldOf(rec, "FULL");
    let name = "";
    if (full && rec.localized) name = full.length >= 4 ? strings.lookup(rec.owner, full.readUInt32LE(0)) : "";
    else if (full) name = cstr(full);
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

export const normaliseQuery = (query: unknown): string => String(query ?? "").trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);
export const normaliseKind = (kind: unknown): string => String(kind ?? "").trim().slice(0, MAX_QUERY_LENGTH);

// Every token must appear; ranks an exact name, then a name prefix, then a name word starting with the first token
export function searchItems(items: CatalogItem[], query: string, kind: string, limit = 50): { total: number; rows: CatalogItem[] } {
  const q = normaliseQuery(query);
  const type = normaliseKind(kind).toUpperCase();
  if (q.length < 2 && !type) return { total: 0, rows: [] };
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = items.filter((it) => (!type || it.type === type) && tokens.every((t) => it.hay.includes(t)));
  if (!tokens.length) return { total: matches.length, rows: matches.slice(0, limit) };
  const phrase = tokens.join(" ");
  const rank = (it: CatalogItem): number => {
    const name = it.name.toLowerCase();
    if (name === phrase) return 0;
    if (name.startsWith(phrase)) return 1;
    return name.split(/\W+/).some((w) => w.startsWith(tokens[0])) ? 2 : 3;
  };
  const ranked = matches.map((it) => ({ it, r: rank(it) }));
  ranked.sort((a, b) => a.r - b.r || a.it.name.length - b.it.name.length || collate(a.it.name, b.it.name));
  return { total: matches.length, rows: ranked.slice(0, limit).map((x) => x.it) };
}
