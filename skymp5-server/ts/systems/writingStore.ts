import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./fileUtil";

// Storage of written documents behind an interface, so the JSON files can later move to MongoDB

export type WritingKind = "letter" | "journal" | "book";

export const WRITING_KINDS: WritingKind[] = ["letter", "journal", "book"];

// The id rides in the item name, so it is checked before it ever names a file
export const WRITING_ID = /^W[0-9A-Z]{5}$/;

export interface WritingPerson {
  actorId: number;
  profileId: number;
  realName: string;
  // The name others saw at the time, mask respected
  shownName: string;
  // The Show Title prefix at the time, empty for none
  title: string;
  // The faction whose mark the signature or seal carries, empty for none
  factionId: string;
}

export interface WritingSeal extends WritingPerson {
  at: number;
}

export interface BrokenSeal {
  // actorId 0 for a seal nobody recorded
  seal: WritingSeal;
  brokenAt: number;
  brokenBy: WritingPerson;
}

export interface WritingDoc {
  v: 1;
  id: string;
  kind: WritingKind;
  title: string;
  pages: string[];
  signed: boolean;
  finished: boolean;
  author: WritingPerson;
  // Who made this document: the author, or whoever copied the book
  scribe: WritingPerson;
  // The original's id for a copy, else empty
  copyOf: string;
  createdAt: number;
  updatedAt: number;
  seal: WritingSeal | null;
  brokenSeals: BrokenSeal[];
  // Destroyed documents are flagged, never deleted, so staff can still read them
  destroyedAt: number;
  destroyedBy: string;
}

export interface WritingStore {
  load(id: string): WritingDoc | null;
  exists(id: string): boolean;
  // Throws when the document cannot be written
  save(doc: WritingDoc): void;
}

const CACHE_SIZE = 256;
// Loose bounds for a hand-edited file; the system applies the configured limits on every write
const MAX_TEXT = 20000;
const MAX_PAGES = 500;
const MAX_SEALS = 64;

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

function person(raw: any): WritingPerson {
  return {
    actorId: num(raw?.actorId) >>> 0,
    profileId: Number.isFinite(Number(raw?.profileId)) ? Number(raw.profileId) : -1,
    realName: text(raw?.realName, 100),
    shownName: text(raw?.shownName, 100),
    title: text(raw?.title, 64),
    factionId: text(raw?.factionId, 64),
  };
}

// Callers edit what they load, so the cache never hands out its own objects
const copyOf = (doc: WritingDoc): WritingDoc => JSON.parse(JSON.stringify(doc));

const seal = (raw: any): WritingSeal => ({ ...person(raw), at: num(raw?.at) });

export function normaliseDoc(raw: any, id: string): WritingDoc | null {
  if (!raw || typeof raw !== "object" || raw.id !== id || !WRITING_KINDS.includes(raw.kind)) return null;
  return {
    v: 1,
    id,
    kind: raw.kind,
    title: text(raw.title, 100),
    pages: Array.isArray(raw.pages) ? raw.pages.slice(0, MAX_PAGES).map((p: unknown) => text(p, MAX_TEXT)) : [],
    signed: raw.signed === true,
    finished: raw.finished === true,
    author: person(raw.author),
    scribe: person(raw.scribe ?? raw.author),
    copyOf: typeof raw.copyOf === "string" && WRITING_ID.test(raw.copyOf) ? raw.copyOf : "",
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    seal: raw.seal && typeof raw.seal === "object" ? seal(raw.seal) : null,
    brokenSeals: Array.isArray(raw.brokenSeals)
      ? raw.brokenSeals.slice(0, MAX_SEALS).filter((b: any) => b && typeof b === "object")
        .map((b: any) => ({ seal: seal(b.seal), brokenAt: num(b.brokenAt), brokenBy: person(b.brokenBy) }))
      : [],
    destroyedAt: num(raw.destroyedAt),
    destroyedBy: text(raw.destroyedBy, 200),
  };
}

// One <id>.json per document, with the most recently used ones kept in memory
export class JsonWritingStore implements WritingStore {
  constructor(private dir: string, private log: (line: string) => void) { }

  load(id: string): WritingDoc | null {
    if (!WRITING_ID.test(id)) return null;
    const hit = this.cache.get(id);
    if (hit) {
      this.remember(hit);
      return copyOf(hit);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.fileOf(id), "utf8");
    } catch {
      return null;
    }
    try {
      const doc = normaliseDoc(JSON.parse(raw), id);
      if (!doc) this.log(`[writing] ${this.fileOf(id)} is not a valid document`);
      else this.remember(copyOf(doc));
      return doc;
    } catch (e) {
      this.log(`[writing] ${this.fileOf(id)} is unreadable: ${e}`);
      return null;
    }
  }

  exists(id: string): boolean {
    return this.cache.has(id) || fs.existsSync(this.fileOf(id));
  }

  save(doc: WritingDoc): void {
    if (!WRITING_ID.test(doc.id)) throw new Error(`bad writing id ${doc.id}`);
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.fileOf(doc.id), JSON.stringify(doc, null, 1));
    this.remember(copyOf(doc));
  }

  private fileOf(id: string): string {
    return path.join(this.dir, id + ".json");
  }

  private remember(doc: WritingDoc): void {
    this.cache.delete(doc.id);
    this.cache.set(doc.id, doc);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
  }

  private cache = new Map<string, WritingDoc>();
}
