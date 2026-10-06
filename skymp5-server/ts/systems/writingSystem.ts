import * as crypto from "crypto";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";
import { resolveEditorIds } from "./espmEditorIds";
import { guardMpHook, hex, isIntroduced, onlineActors } from "./actorUtil";
import { adminAudit } from "./discordAlerts";
import { AdminRoleConfig, adminTierOf, missingCap, readAdminRoleConfig } from "./adminRoles";
import { FactionSystem } from "./factionSystem";
import { InventoryEntry, Item, addEntries, isNamedItemBase, namedItemBaseIds, readInventory, registerNamedItemBases, sameExtras } from "./inventoryExtras";
import { appendLog, describeActor, displayNameOf, logDirOf, profileIdOf, realNameOf, sanitize, sendJson, titledName } from "./playerText";
import { JsonWritingStore, WRITING_ID, WritingDoc, WritingKind, WritingPerson, WritingSeal, WritingStore } from "./writingStore";
import { loc } from "../loc";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Letters, journals and books whose text stays on the server and whose id rides in the item name; rules and protocol in docs/docs_roleplay_writing.md

export const BLANK_BOOK_EDID = "AldWritingBookBlank";

const EDITOR_IDS = {
  letterBlank: "AldWritingParchmentBlank",
  letter: "AldWritingLetter",
  sealed: "AldWritingLetterSealed",
  journalBlank: "AldWritingJournalBlank",
  journal: "AldWritingJournal",
  bookBlank: BLANK_BOOK_EDID,
  book: "AldWritingBook",
  wax: "AldSealingWax",
};
type BaseKey = keyof typeof EDITOR_IDS;

const KIND_OF: Partial<Record<BaseKey, WritingKind>> = {
  letterBlank: "letter", letter: "letter", sealed: "letter",
  journalBlank: "journal", journal: "journal",
  bookBlank: "book", book: "book",
};
const WRITTEN_OF: Record<WritingKind, BaseKey> = { letter: "letter", journal: "journal", book: "book" };
const WRITTEN_KEYS: BaseKey[] = ["letter", "sealed", "journal", "book"];
const KIND_LABEL: Record<WritingKind, string> = { letter: "Letter", journal: "Journal", book: "Book" };
const BLANK_LABEL: Record<WritingKind, string> = { letter: "Blank Parchment", journal: "Blank Journal", book: "Blank Book" };

const DEFAULTS = {
  writingTitleMaxLen: 40,
  writingLetterMaxLen: 2000,
  writingPageMaxLen: 1500,
  writingJournalMaxPages: 50,
  writingBookMaxPages: 100,
  writingMaxDocuments: 200,
  writingDocumentDays: 30,
  writingMaxPerDay: 20,
};

const WRITINGS_DIR = "./writings";
const COUNTER_PROP = "private.writings";
const LOG_FILE = "writing.log";
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TAG = /\((W[0-9A-Z]{5})\)$/;
// The list row that writes on a blank of the base read; never a document id
const NEW_ROW_ID = "new";
const OPEN_COOLDOWN_MS = 1000;
const SAVE_COOLDOWN_MS = 2000;
const DAY_MS = 24 * 3600000;
const MAX_PINNABLE_LISTED = 100;
const CHANGE_FAILED = loc("writing.changeFailed");

// Factions with a mark in skymp5-front/src/img/seals
const SEAL_FACTIONS = [
  "faction:dark-brotherhood", "faction:college-of-winterhold", "faction:imperial-legion",
  "hold:haafingar", "hold:the-reach", "hold:falkreath", "hold:hjaalmarch", "hold:eastmarch",
  "hold:winterhold", "hold:the-rift", "hold:the-pale", "hold:whiterun",
  "faction:house-telvanni", "faction:house-redoran", "faction:house-dres", "faction:house-indoril",
  "faction:house-sadras", "faction:morag-tong",
  // The Great Houses as territories after deploy/mongodb/migrate-morrowind-houses.js
  "hold:telvanni", "hold:redoran", "hold:dres", "hold:indoril", "hold:sadras",
];

// The front's markup tags (skymp5-front/src/features/writing/markup.tsx TAG); those its parser honours do not count toward a page's length
const MARKUP_TAG = /\[(\/?)(b|bold|i|italic|u|s|color|head|bullet|font|fancy|center|right|hr)(?:=("?)([^\]"\n]{1,24})\3)?\/?\]/gi;
// Room for tags on top of the visible characters, and a bound on how many a page may carry
const MARKUP_ROOM = 2;
const MAX_TAGS_PER_PAGE = 400;
// The front parser's rules (markup.tsx parse): depth, aliases, ink keys, and font keys and labels compared as letters only
const MARKUP_MAX_DEPTH = 8;
const MARKUP_ALIAS: Record<string, string> = { bold: "b", italic: "i" };
const MARKUP_INKS = new Set(["black", "brown", "red", "blue", "green", "purple", "gold", "grey", "gray"]);
const MARKUP_FONTS = new Set(["hand", "handwritten", "book", "plain", "daedric", "dragon", "dwemer", "falmer", "mage", "magescript", "unreadable", "symbols"]);

const markupKey = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

const markupArgOk = (tag: string, raw: string | undefined): boolean => {
  if (tag === "color") return raw !== undefined && (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.trim()) || MARKUP_INKS.has(markupKey(raw)));
  if (tag === "head") return raw !== undefined && /^[1-3]$/.test(raw);
  if (tag === "font") return raw !== undefined && MARKUP_FONTS.has(markupKey(raw));
  return raw === undefined;
};

// The characters a reader sees: a tag the front shows as written counts like any text; test-writing-markup.js holds it to the front's plainText
export const markupVisibleLength = (text: string): number => {
  const open: string[] = [];
  const re = new RegExp(MARKUP_TAG.source, "gi");
  let hidden = 0;
  let tags = 0;
  let fancySeen = false;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (++tags > MAX_TAGS_PER_PAGE) break;
    const tag = MARKUP_ALIAS[m[2].toLowerCase()] || m[2].toLowerCase();
    const raw = m[4];
    let done = false;
    if (m[1] === "/") {
      const i = open.lastIndexOf(tag);
      if (i >= 0) open.splice(i, 1);
      done = i >= 0 || (tag === "fancy" && fancySeen);
    } else if (tag === "bullet" || tag === "hr") {
      done = raw === undefined;
    } else if (tag === "fancy") {
      if (raw === undefined && /[a-z]/i.test(text.charAt(re.lastIndex))) {
        re.lastIndex += 1;
        fancySeen = done = true;
      }
    } else if (markupArgOk(tag, raw) && open.length < MARKUP_MAX_DEPTH && !(tag === "head" && open.includes("head"))) {
      open.push(tag);
      done = true;
    }
    if (done) hidden += m[0].length;
  }
  return text.length - hidden;
};

type View = "compose" | "read" | "sealed" | "list";

interface Session {
  view: View;
  kind?: WritingKind;
  // The blank base the composer, or the list's new row, writes on
  blank?: number;
}

interface Carried {
  entry: InventoryEntry;
  id: string;
  key: BaseKey;
}

// A letter pinned to a door as one viewer reads it in the housing menu
export interface PinnedNoteView {
  title: string;
  text: string;
  byline: string;
  signFaction: string;
  brokenSeals: string[];
}

// Why a pinned letter can no longer be read
type NoteGone = "missing" | "destroyed";

// Creation times: made keeps documents within the window that still exist, recent every document of the last day
interface Counter {
  made: number[];
  recent: number[];
}

const tagOf = (name: unknown): string => {
  const m = typeof name === "string" ? TAG.exec(name) : null;
  return m ? m[1] : "";
};

// The id anywhere in a name the client read off its inventory list; titles hold no brackets
const pickedTag = (name: string): string => /\((W[0-9A-Z]{5})\)/.exec(name)?.[1] || "";

// Printable Latin-1 without the brackets the name tag relies on
const cleanTitle = (raw: unknown, max: number): string =>
  String(raw ?? "").replace(/[^\x20-\x7e\xa0-\xff]|[()[\]<>&]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

const plain = (baseId: number): Item => ({ baseId, count: 1 });

export class WritingSystem implements System {
  systemName = "WritingSystem";
  constructor(private log: Log, private factions: FactionSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      const n = Number(all?.[key]);
      if (Number.isInteger(n) && n > 0) this.cfg[key] = n;
    }
    this.enabled = all?.["writingEnabled"] === true;
    this.logDir = logDirOf(all);
    this.roleCfg = readAdminRoleConfig(all);
    this.store = new JsonWritingStore(WRITINGS_DIR, (line) => this.log(line));

    const mp = ctx.svr as Mp;
    this.installDropHook(mp);
    const scan = await resolveEditorIds(Object.values(EDITOR_IDS), s.dataDir, s.loadOrder, this.log, ["BOOK", "MISC"]);
    for (const [key, edid] of Object.entries(EDITOR_IDS) as [BaseKey, string][]) {
      const desc = scan.resolved.get(edid.toLowerCase());
      try {
        if (desc) this.bases.set(key, mp.getIdFromDesc(desc) >>> 0);
      } catch { /* not in the load order */ }
    }
    this.bases.forEach((id, key) => this.keyOf.set(id, key));
    registerNamedItemBases(WRITTEN_KEYS.map((k) => this.bases.get(k) || 0).filter((id) => id));
    if (typeof mp.setNamedItemBases === "function") {
      mp.setNamedItemBases(namedItemBaseIds());
    } else {
      this.log("[writing] setNamedItemBases native missing: rebuild the server natives so containers tell writings apart by name");
    }

    ctx.gm.on("userAssignActor", (userId: number) => this.sessions.delete(userId));
    const missing = (Object.keys(EDITOR_IDS) as BaseKey[]).filter((k) => !this.bases.has(k)).map((k) => EDITOR_IDS[k]);
    this.ready = missing.length === 0;
    if (!this.ready) this.log(`[writing] records missing from the load order (${missing.join(", ")}), writings disabled`);
    else if (!this.enabled) this.log("[writing] records found, writings off until writingEnabled is true");
    else this.log(`[writing] ready, per character ${this.cfg.writingMaxDocuments} documents in ${this.cfg.writingDocumentDays} days and ${this.cfg.writingMaxPerDay} new a day`);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!type.startsWith("writing")) return;
    const mp = ctx.svr as Mp;
    if (type === "writingClose") {
      this.sessions.delete(userId);
      return;
    }
    let actorId = 0;
    try { actorId = mp.getUserActor(userId) >>> 0; } catch { return; }
    if (!actorId) return;
    if (type === "writingStaff" && this.ready) {
      this.onStaff(mp, userId, actorId, content);
      return;
    }
    if (!this.enabled || !this.ready) {
      if (type === "writingUse") this.notice(mp, userId, loc("writing.unavailable"));
      return;
    }
    const id = String(content["id"] ?? "");
    switch (type) {
      case "writingUse": return this.onUse(mp, userId, actorId, toFormId(content["baseId"]), content["name"]);
      case "writingOpen": return this.cooled(this.lastOpenMs, userId, OPEN_COOLDOWN_MS) ? this.onOpen(mp, userId, actorId, id) : undefined;
      case "writingCreate": return this.onCreate(mp, userId, actorId, content);
      case "writingSave": return this.onSave(mp, userId, actorId, id, content);
      case "writingFinish": return this.onFinish(mp, userId, actorId, id);
      case "writingSeal": return this.onSeal(mp, userId, actorId, id);
      case "writingBreak": return this.onBreak(mp, userId, actorId, id);
      case "writingCopy": return this.onCopy(mp, userId, actorId, id);
      case "writingBurn": return this.onBurn(mp, userId, actorId, id);
      default: return;
    }
  }

  disconnect(userId: number): void {
    this.sessions.delete(userId);
    this.lastOpenMs.delete(userId);
    this.lastSaveMs.delete(userId);
  }

  // Dropped items vanish after two minutes and lose their name on a restart, so named items stay in the pack
  private installDropHook(mp: Mp): void {
    guardMpHook(mp, "onDropItem", (_actorId: number, baseId: number) => isNamedItemBase(baseId >>> 0) ? false : undefined);
  }

  // ── Opening ─────────────────────────────────────────────────────────────────

  // picked is the inventory entry the player read as the client names it, absent when the client cannot tell
  private onUse(mp: Mp, userId: number, actorId: number, baseId: number, picked: unknown): void {
    const key = this.keyOf.get(baseId);
    const kind = key ? KIND_OF[key] : undefined;
    if (!key || !kind || !this.cooled(this.lastOpenMs, userId, OPEN_COOLDOWN_MS)) return;
    const name = typeof picked === "string" ? picked.slice(0, 256) : "";
    const tag = pickedTag(name);
    const blanks = this.plainCount(mp, actorId, baseId);
    const written = this.carried(mp, actorId).filter((c) => c.entry.baseId >>> 0 === baseId);
    // An entry read without an id is a blank; unnamed, a lone written copy opens only when no blank shares its base
    const open = written.find((c) => c.id === tag)?.id || (written.length === 1 && !blanks ? written[0].id : "");
    const compose = !open && !tag && blanks > 0 && (!!name || !written.length);
    if (open) this.openDoc(mp, userId, actorId, open);
    else if (compose) this.openCompose(mp, userId, kind, baseId);
    else if (written.length) this.openList(mp, userId, written, kind, blanks > 0 ? baseId : 0);
    const shown = open || (compose ? "the composer" : written.length ? `a list of ${written.length}${blanks > 0 ? " and a new one" : ""}` : "nothing");
    this.log(`[writing] ${hex(actorId)} reads ${hex(baseId)} ${JSON.stringify(name)}: ${shown}, carrying ${blanks} blank and ${written.length} written of that base`);
  }

  // A written item without a name counts as a blank of its kind
  private openCompose(mp: Mp, userId: number, kind: WritingKind, blank: number): void {
    this.sessions.set(userId, { view: "compose", kind, blank });
    this.sendMenu(mp, userId, { view: "compose", compose: { kind, blankName: BLANK_LABEL[kind] } });
  }

  // The written copies of one base, led by a row that writes on a blank of it when one is carried
  private openList(mp: Mp, userId: number, written: Carried[], kind: WritingKind, blank: number): void {
    this.sessions.set(userId, { view: "list", kind, blank });
    const rows = written.map((c) => {
      const rowKind = KIND_OF[c.key] || "letter";
      const sealed = c.key === "sealed";
      return { id: c.id, kind: rowKind, title: sealed ? "Sealed Letter" : this.store.load(c.id)?.title || KIND_LABEL[rowKind], sealed };
    });
    if (blank) rows.unshift({ id: NEW_ROW_ID, kind, title: loc("writing.list.writeNew", { kind: KIND_LABEL[kind].toLowerCase() }), sealed: false });
    this.sendMenu(mp, userId, { view: "list", list: rows });
  }

  private onOpen(mp: Mp, userId: number, actorId: number, id: string): void {
    if (id !== NEW_ROW_ID) return this.openDoc(mp, userId, actorId, id);
    const session = this.sessions.get(userId);
    if (session?.view !== "list" || !session.kind || !session.blank) return;
    if (this.plainCount(mp, actorId, session.blank) < 1) return this.notice(mp, userId, loc("writing.noBlank", { blank: BLANK_LABEL[session.kind] }));
    this.openCompose(mp, userId, session.kind, session.blank);
  }

  private openDoc(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return;
    const view: View = found.carried.key === "sealed" ? "sealed" : "read";
    this.sessions.set(userId, { view });
    this.sendDoc(mp, userId, actorId, found.doc, found.carried, false);
  }

  // The carried item and its document, brought back in step after a crash, a staff rename or a duplicate
  private reconcile(mp: Mp, userId: number, actorId: number, id: string): { doc: WritingDoc; carried: Carried } | null {
    const carried = WRITING_ID.test(id) ? this.carried(mp, actorId).find((c) => c.id === id) : undefined;
    if (!carried) {
      this.notice(mp, userId, loc("writing.notCarried"));
      return null;
    }
    const doc = this.store.load(id);
    if (!doc) {
      this.notice(mp, userId, loc("writing.faded"));
      this.log(`[writing] ${hex(actorId)} carries ${id}, which has no document`);
      return null;
    }
    const sealed = carried.key === "sealed";
    if (doc.destroyedAt) {
      this.rewrite(mp, actorId, [[carried.entry, carried.entry.count]], []);
      this.notice(mp, userId, loc("writing.crumbles"));
      return null;
    }
    if (doc.kind !== KIND_OF[carried.key]) {
      this.notice(mp, userId, loc("writing.illegible"));
      this.log(`[writing] ${hex(actorId)} carries ${id} as ${carried.key}, the document is a ${doc.kind}`);
      return null;
    }
    // The item decides whether the seal is whole; the document may be ahead of a changeform lost in a crash
    if (sealed !== !!doc.seal) {
      doc.seal = sealed ? { ...this.nobody(), at: doc.updatedAt } : null;
      this.persist(doc);
    }
    const name = this.nameOf(doc, sealed);
    if (carried.entry.count > 1) this.appendLog(`${describeActor(mp, actorId)} carried ${carried.entry.count} copies of ${id}, kept one`);
    if (carried.entry.count > 1 || carried.entry.name !== name) {
      const one: InventoryEntry = { ...carried.entry, count: 1, name };
      if (this.rewrite(mp, actorId, [[carried.entry, carried.entry.count]], [one])) carried.entry = one;
    }
    return { doc, carried };
  }

  // ── Writing ─────────────────────────────────────────────────────────────────

  private onCreate(mp: Mp, userId: number, actorId: number, content: Content): void {
    const session = this.sessions.get(userId);
    const kind = session?.kind;
    const blank = session?.blank || 0;
    if (!session || session.view !== "compose" || !kind || !this.cooled(this.lastSaveMs, userId, SAVE_COOLDOWN_MS)) return;
    const title = cleanTitle(content["title"], this.cfg.writingTitleMaxLen);
    const pages = this.readPages(mp, userId, kind, content["pages"]);
    if (!pages || !this.roomToWrite(mp, userId, actorId)) return;
    if (this.plainCount(mp, actorId, blank) < 1) {
      this.notice(mp, userId, loc("writing.noBlank", { blank: BLANK_LABEL[kind] }));
      return;
    }
    const me = this.person(mp, actorId);
    const doc = this.newDoc(kind, title, pages, content["signed"] === true, me, me);
    if (!doc) return this.notice(mp, userId, loc("writing.notKept"));
    const item: Item = { baseId: this.base(WRITTEN_OF[kind]), count: 1, name: this.nameOf(doc, false) };
    if (!this.rewrite(mp, actorId, [[plain(blank), 1]], [item])) return;
    if (!this.persist(doc)) {
      this.rewrite(mp, actorId, [[item, 1]], [plain(blank)]);
      return this.notice(mp, userId, loc("writing.notKept"));
    }
    this.count(mp, actorId, doc.createdAt, true);
    this.appendLog(`${describeActor(mp, actorId)} wrote ${kind} ${doc.id} ${JSON.stringify(title)}${doc.signed ? " (signed)" : ""}: ${JSON.stringify(pages)}`);
    this.openDoc(mp, userId, actorId, doc.id);
  }

  private onSave(mp: Mp, userId: number, actorId: number, id: string, content: Content): void {
    if (!this.cooled(this.lastSaveMs, userId, SAVE_COOLDOWN_MS)) return;
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return;
    const { doc, carried } = found;
    if (!this.canEdit(actorId, doc, carried)) return this.notice(mp, userId, loc("writing.cannotChange"));
    const title = doc.fixedPages ? doc.title : cleanTitle(content["title"], this.cfg.writingTitleMaxLen);
    const sent = this.readPages(mp, userId, doc.kind, content["pages"]);
    if (!sent) return;
    // The finished pages stay as stored, whatever the client sent for them
    const pages = doc.pages.slice(0, doc.fixedPages).concat(sent.slice(doc.fixedPages));
    const changed = pages.map((p, i) => (p !== doc.pages[i] ? i : -1)).filter((i) => i >= 0);
    for (let i = pages.length; i < doc.pages.length; i++) changed.push(i);
    const retitled = title !== doc.title;
    if (!changed.length && !retitled) return this.openDoc(mp, userId, actorId, id);
    doc.title = title;
    doc.pages = pages;
    doc.updatedAt = Date.now();
    if (retitled && !this.rewrite(mp, actorId, [[carried.entry, 1]], [{ ...carried.entry, count: 1, name: this.nameOf(doc, false) }])) return;
    if (!this.persist(doc)) return this.notice(mp, userId, loc("writing.changesNotKept"));
    const pageLines = changed.map((i) => `page ${i + 1}: ${JSON.stringify(pages[i] ?? "")}`).join(", ");
    this.appendLog(`${describeActor(mp, actorId)} edited ${doc.kind} ${id} ${JSON.stringify(title)}${pageLines ? " " + pageLines : ""}`);
    this.openDoc(mp, userId, actorId, id);
  }

  private onFinish(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return;
    const { doc, carried } = found;
    if (!this.canFinish(actorId, doc, carried)) return;
    doc.finished = true;
    doc.fixedPages = doc.pages.length;
    doc.updatedAt = Date.now();
    if (!this.persist(doc)) return this.notice(mp, userId, loc("writing.book.notFinished"));
    this.appendLog(`${describeActor(mp, actorId)} finished book ${id} ${JSON.stringify(doc.title)} up to page ${doc.fixedPages}`);
    this.notice(mp, userId, loc("writing.book.finished"));
    this.openDoc(mp, userId, actorId, id);
  }

  // ── Seals ───────────────────────────────────────────────────────────────────

  private onSeal(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found || found.carried.key !== "letter") return;
    const { doc, carried } = found;
    const wax = this.base("wax");
    if (this.plainCount(mp, actorId, wax) < 1) return this.notice(mp, userId, loc("writing.seal.needWax"));
    const sealed: Item = { baseId: this.base("sealed"), count: 1, name: this.nameOf(doc, true) };
    if (!this.rewrite(mp, actorId, [[carried.entry, 1], [plain(wax), 1]], [sealed])) return;
    doc.seal = { ...this.person(mp, actorId), at: Date.now() };
    this.persist(doc);
    this.appendLog(`${describeActor(mp, actorId)} sealed letter ${id} ${JSON.stringify(doc.title)}${doc.seal.factionId ? ` as ${doc.seal.factionId}` : ""}`);
    this.notice(mp, userId, doc.seal.title ? loc("writing.seal.pressed") : loc("writing.seal.plain"));
    this.openDoc(mp, userId, actorId, id);
  }

  // Anyone holding a sealed letter may break it; every broken seal stays on the letter
  private onBreak(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found || found.carried.key !== "sealed") return;
    const { doc, carried } = found;
    const letter: Item = { baseId: this.base("letter"), count: 1, name: this.nameOf(doc, false) };
    if (!this.rewrite(mp, actorId, [[carried.entry, 1]], [letter])) return;
    const now = Date.now();
    doc.brokenSeals.push({ seal: doc.seal || { ...this.nobody(), at: 0 }, brokenAt: now, brokenBy: this.person(mp, actorId) });
    doc.seal = null;
    doc.updatedAt = now;
    this.persist(doc);
    this.appendLog(`${describeActor(mp, actorId)} broke the seal on letter ${id} ${JSON.stringify(doc.title)}`);
    this.openDoc(mp, userId, actorId, id);
  }

  // ── Copies and burning ──────────────────────────────────────────────────────

  private onCopy(mp: Mp, userId: number, actorId: number, id: string): void {
    if (!this.cooled(this.lastSaveMs, userId, SAVE_COOLDOWN_MS)) return;
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return;
    const { doc } = found;
    if (doc.kind !== "book" || !doc.finished) return this.notice(mp, userId, loc("writing.copy.notFinished"));
    const blank = this.base("bookBlank");
    if (this.plainCount(mp, actorId, blank) < 1) return this.notice(mp, userId, loc("writing.copy.needBlank"));
    if (!this.roomToWrite(mp, userId, actorId)) return;
    // Pages after fixedPages are the author's unfinished writing
    const copy = this.newDoc("book", doc.title, doc.pages.slice(0, doc.fixedPages), doc.signed, doc.author, this.person(mp, actorId));
    if (!copy) return this.notice(mp, userId, loc("writing.copy.notKept"));
    copy.finished = true;
    copy.fixedPages = copy.pages.length;
    copy.copyOf = doc.copyOf || doc.id;
    const item: Item = { baseId: this.base("book"), count: 1, name: this.nameOf(copy, false) };
    if (!this.rewrite(mp, actorId, [[plain(blank), 1]], [item])) return;
    if (!this.persist(copy)) {
      this.rewrite(mp, actorId, [[item, 1]], [plain(blank)]);
      return this.notice(mp, userId, loc("writing.copy.notKept"));
    }
    this.count(mp, actorId, copy.createdAt, true);
    this.appendLog(`${describeActor(mp, actorId)} copied book ${id} ${JSON.stringify(doc.title)} as ${copy.id}`);
    this.notice(mp, userId, loc("writing.copy.done", { title: doc.title || loc("writing.copy.theBook") }));
    this.openDoc(mp, userId, actorId, id);
  }

  private onBurn(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return;
    const { doc, carried } = found;
    if (!this.rewrite(mp, actorId, [[carried.entry, carried.entry.count]], [])) return;
    this.destroy(mp, doc, describeActor(mp, actorId));
    this.appendLog(`${describeActor(mp, actorId)} burned ${doc.kind} ${id} ${JSON.stringify(doc.title)}`);
    this.sessions.delete(userId);
    sendJson(mp, userId, { customPacketType: "writingClosed" });
    this.notice(mp, userId, loc("writing.burned"));
  }

  private destroy(mp: Mp, doc: WritingDoc, by: string): void {
    doc.destroyedAt = Date.now();
    doc.destroyedBy = by;
    this.persist(doc);
    this.count(mp, doc.scribe.actorId, doc.createdAt, false);
  }

  // ── Staff ───────────────────────────────────────────────────────────────────

  // Moderation from the Personal Menu's Writings tab; every use lands in admin.log
  private onStaff(mp: Mp, userId: number, actorId: number, content: Content): void {
    const tier = adminTierOf(mp, actorId, this.roleCfg);
    if (!tier) {
      this.log(`[writing] refused a staff request from ${hex(actorId)} (not an admin)`);
      return;
    }
    const reply = (ok: boolean, text: string) => sendJson(mp, userId, { customPacketType: "adminActionResult", ok, text });
    if (missingCap("players", this.roleCfg.tierCaps[tier])) return reply(false, loc("writing.staff.noCap"));
    const op = String(content["op"] ?? "");
    const id = String(content["id"] ?? "").trim().toUpperCase();
    const doc = WRITING_ID.test(id) ? this.store.load(id) : null;
    if (!doc) return reply(false, loc("writing.staff.noWriting", { id: id || loc("writing.staff.withoutId") }));
    const staff = loc("writing.staff.who", { profileId: profileIdOf(mp, actorId), tier });
    const what = loc("writing.staff.what", { kind: doc.kind, id, title: JSON.stringify(doc.title), author: JSON.stringify(doc.author.realName), profileId: doc.author.profileId });
    if (op === "read") {
      this.sessions.set(userId, { view: "read" });
      this.sendDoc(mp, userId, actorId, doc, null, true);
      this.adminLog(loc("writing.audit.read", { staff, what }));
      return reply(true, loc("writing.staff.opened", { id }));
    }
    if (op === "rename") {
      const title = cleanTitle(content["title"], this.cfg.writingTitleMaxLen);
      if (!title) return reply(false, loc("writing.staff.emptyTitle"));
      doc.title = title;
      doc.updatedAt = Date.now();
      if (!this.persist(doc)) return reply(false, loc("writing.staff.renameFailed"));
      const held = this.renameOnline(mp, doc);
      this.adminLog(loc("writing.audit.renamed", { staff, what, title: JSON.stringify(title) }));
      this.appendLog(`staff ${staff} renamed ${id} to ${JSON.stringify(title)}`);
      return reply(true, loc("writing.staff.renamed", { id, held: !held ? "" : held === 1 ? loc("writing.staff.heldOne", { n: held }) : loc("writing.staff.heldMany", { n: held }) }));
    }
    if (op === "destroy") {
      if (doc.destroyedAt) return reply(false, loc("writing.staff.alreadyDestroyed", { id }));
      this.destroy(mp, doc, loc("writing.staff.destroyedBy", { staff }));
      const held = this.removeOnline(mp, id);
      this.adminLog(loc("writing.audit.destroyed", { staff, what }));
      this.appendLog(`staff ${staff} destroyed ${id}`);
      return reply(true, loc("writing.staff.destroyed", { id, held: !held ? "" : held === 1 ? loc("writing.staff.removedOne", { n: held }) : loc("writing.staff.removedMany", { n: held }) }));
    }
    reply(false, loc("writing.staff.unknownAction", { op }));
  }

  // Copies in chests and offline packs catch up when they are next read
  private renameOnline(mp: Mp, doc: WritingDoc): number {
    return onlineActors(mp).filter((actorId) => {
      const c = this.carried(mp, actorId).find((x) => x.id === doc.id && x.key !== "sealed");
      return !!c && this.rewrite(mp, actorId, [[c.entry, c.entry.count]], [{ ...c.entry, name: this.nameOf(doc, false) }]);
    }).length;
  }

  private removeOnline(mp: Mp, id: string): number {
    return onlineActors(mp).filter((actorId) => {
      const c = this.carried(mp, actorId).find((x) => x.id === id);
      return !!c && this.rewrite(mp, actorId, [[c.entry, c.entry.count]], []);
    }).length;
  }

  // ── Door notes (HousingSystem) ──────────────────────────────────────────────

  available(): boolean {
    return this.enabled && this.ready;
  }

  // Unsealed written letters the character carries, titled as the pack shows them
  lettersOf(mp: Mp, actorId: number): Array<{ id: string; title: string }> {
    if (!this.available()) return [];
    return this.carried(mp, actorId).filter((c) => c.key === "letter").slice(0, MAX_PINNABLE_LISTED)
      .map((c) => ({ id: c.id, title: String(c.entry.name || "").replace(TAG, "").trim() || KIND_LABEL.letter }));
  }

  // Takes one carried open letter out of the pack for a door; null once the player was told why not
  takeLetterToPin(mp: Mp, userId: number, actorId: number, id: string): { id: string; title: string } | null {
    if (!this.available()) {
      this.notice(mp, userId, loc("writing.unavailable"));
      return null;
    }
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return null;
    if (found.carried.key !== "letter") {
      this.notice(mp, userId, found.carried.key === "sealed" ? loc("writing.pin.notOpen") : loc("writing.pin.notLetter"));
      return null;
    }
    if (!this.rewrite(mp, actorId, [[found.carried.entry, 1]], [])) {
      this.notice(mp, userId, CHANGE_FAILED);
      return null;
    }
    return { id, title: found.doc.title || KIND_LABEL.letter };
  }

  // Puts a pinned letter into a pack under its current title
  returnPinnedLetter(mp: Mp, actorId: number, id: string): "given" | "failed" | NoteGone {
    if (!this.available()) return "failed";
    const doc = this.pinnedDoc(id);
    if (typeof doc === "string") return doc;
    return this.rewrite(mp, actorId, [], [{ baseId: this.base("letter"), count: 1, name: this.nameOf(doc, false) }]) ? "given" : "failed";
  }

  // A pinned letter as this viewer reads it, null while writing is off
  pinnedNoteView(mp: Mp, viewerId: number, id: string): PinnedNoteView | NoteGone | null {
    if (!this.available()) return null;
    const doc = this.pinnedDoc(id);
    if (typeof doc === "string") return doc;
    const { byline, brokenSeals } = this.readerLines(mp, viewerId, doc, false);
    return { title: doc.title || KIND_LABEL.letter, text: doc.pages[0] || "", byline, signFaction: doc.signed ? doc.author.factionId : "", brokenSeals };
  }

  logDoorNote(text: string): void {
    this.appendLog(text);
  }

  private pinnedDoc(id: string): WritingDoc | NoteGone {
    const doc = WRITING_ID.test(id) ? this.store.load(id) : null;
    if (!doc || doc.kind !== "letter") return "missing";
    return doc.destroyedAt ? "destroyed" : doc;
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(mp: Mp, userId: number, body: Record<string, unknown>): void {
    sendJson(mp, userId, {
      customPacketType: "writingMenu",
      limits: {
        title: this.cfg.writingTitleMaxLen,
        letter: this.cfg.writingLetterMaxLen,
        page: this.cfg.writingPageMaxLen,
        journalPages: this.cfg.writingJournalMaxPages,
        bookPages: this.cfg.writingBookMaxPages,
      },
      ...body,
    });
  }

  // A book's signature reads the same to every reader; a letter's, a journal's and a seal follow the introductions rule; staff see real names and profiles
  private readerLines(mp: Mp, viewerId: number, doc: WritingDoc, staff: boolean) {
    const nameFor = (who: WritingPerson): string => {
      if (staff) return loc("writing.read.staffName", { name: who.realName || loc("writing.read.unrecorded"), profileId: who.profileId });
      const known = who.actorId === viewerId || (!!who.actorId && isIntroduced(mp, viewerId, who.actorId));
      return known ? titledName(who.title, who.shownName) : "";
    };
    const sealName = (seal: WritingSeal): string => {
      const name = nameFor(seal);
      return name ? loc("writing.read.sealOf", { name }) : loc("writing.read.unfamiliarSeal");
    };
    const signer = staff || doc.kind !== "book" ? nameFor(doc.author) : doc.author.shownName ? titledName(doc.author.title, doc.author.shownName) : "";
    return {
      nameFor,
      sealName,
      byline: !doc.signed ? "" : signer ? loc("writing.read.signed", { name: signer }) : loc("writing.read.signedUnknown"),
      brokenSeals: doc.brokenSeals.map((b) => capitalise(loc("writing.read.sealBroken", { seal: sealName(b.seal) }))),
    };
  }

  // What this reader may see and do; staff see real names and never act on the item
  private sendDoc(mp: Mp, userId: number, actorId: number, doc: WritingDoc, carried: Carried | null, staff: boolean): void {
    const sealed = carried?.key === "sealed";
    const hidden = sealed && !staff;
    const { nameFor, sealName, byline, brokenSeals } = this.readerLines(mp, actorId, doc, staff);
    const staffLines = staff ? [
      loc("writing.read.scribe", { who: describePerson(doc.scribe) }),
      loc("writing.read.written", { created: new Date(doc.createdAt).toISOString(), changed: new Date(doc.updatedAt).toISOString() }),
      doc.seal ? loc("writing.read.sealedBy", { who: describePerson(doc.seal) }) : "",
      doc.destroyedAt ? loc("writing.read.destroyed", { at: new Date(doc.destroyedAt).toISOString(), by: doc.destroyedBy }) : "",
    ].filter((l) => l) : [];
    const editable = !!carried && !staff && this.canEdit(actorId, doc, carried);
    this.sendMenu(mp, userId, {
      view: hidden ? "sealed" : "read",
      doc: {
        id: doc.id,
        kind: doc.kind,
        title: hidden ? "Sealed Letter" : doc.title || KIND_LABEL[doc.kind],
        pages: hidden ? [] : doc.pages,
        byline: hidden ? "" : staff ? (doc.signed ? loc("writing.read.staffSigned", { name: nameFor(doc.author) }) : loc("writing.read.staffUnsigned", { name: nameFor(doc.author) })) : byline,
        copy: !!doc.copyOf,
        finished: doc.finished,
        fixedPages: hidden ? 0 : doc.fixedPages,
        sealText: hidden ? loc("writing.read.closedWith", { seal: sealName(doc.seal || { ...this.nobody(), at: 0 }) }) : "",
        // Heraldry is public: the marks show to every reader, only the names follow the introductions rule
        sealFaction: hidden ? doc.seal?.factionId || "" : "",
        signFaction: !hidden && doc.signed ? doc.author.factionId : "",
        brokenSeals,
        canEdit: editable,
        canFinish: !!carried && !staff && this.canFinish(actorId, doc, carried),
        canSeal: !staff && carried?.key === "letter",
        canBreak: !staff && sealed,
        canCopy: !staff && !!carried && doc.kind === "book" && doc.finished,
        canBurn: !staff && !!carried,
        hasWax: this.plainCount(mp, actorId, this.base("wax")) > 0,
        blankBooks: this.plainCount(mp, actorId, this.base("bookBlank")),
        staff,
        staffLines,
      },
    });
  }

  // ── Rules and limits ────────────────────────────────────────────────────────

  // Letters until the first seal, journals always, books while a page is open or free after the finished ones; only the author, and never a copy
  private canEdit(actorId: number, doc: WritingDoc, carried: Carried): boolean {
    if (doc.author.actorId !== actorId || doc.copyOf || carried.key === "sealed") return false;
    if (doc.kind === "letter") return !doc.seal && doc.brokenSeals.length === 0;
    if (doc.kind === "book") return doc.fixedPages < this.cfg.writingBookMaxPages;
    return true;
  }

  // Finishing fixes every page written so far, the first time and after each continuation
  private canFinish(actorId: number, doc: WritingDoc, carried: Carried): boolean {
    return doc.kind === "book" && doc.pages.length > doc.fixedPages && this.canEdit(actorId, doc, carried);
  }

  private readPages(mp: Mp, userId: number, kind: WritingKind, raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const maxPages = kind === "letter" ? 1 : kind === "journal" ? this.cfg.writingJournalMaxPages : this.cfg.writingBookMaxPages;
    const maxLen = kind === "letter" ? this.cfg.writingLetterMaxLen : this.cfg.writingPageMaxLen;
    if (raw.length > maxPages) {
      this.notice(mp, userId, (maxPages === 1 ? loc("writing.limit.pagesOne", { kind: KIND_LABEL[kind].toLowerCase(), n: maxPages }) : loc("writing.limit.pagesMany", { kind: KIND_LABEL[kind].toLowerCase(), n: maxPages })));
      return null;
    }
    const pages: string[] = [];
    for (const page of raw) {
      // Bound the work before sanitize walks the payload
      if (typeof page !== "string" || page.length > maxLen * 4) return null;
      const text = sanitize(page);
      const tags = text.match(MARKUP_TAG)?.length ?? 0;
      if (text.length > maxLen * MARKUP_ROOM || tags > MAX_TAGS_PER_PAGE) {
        this.notice(mp, userId, loc("writing.limit.formatting"));
        return null;
      }
      if (markupVisibleLength(text) > maxLen) {
        this.notice(mp, userId, loc("writing.limit.chars", { n: maxLen }));
        return null;
      }
      pages.push(text);
    }
    while (pages.length && !pages[pages.length - 1]) pages.pop();
    if (!pages.length) {
      this.notice(mp, userId, loc("writing.limit.blankPage"));
      return null;
    }
    return pages;
  }

  private roomToWrite(mp: Mp, userId: number, actorId: number): boolean {
    const c = this.counterOf(mp, actorId);
    const max = this.cfg.writingMaxDocuments;
    if (c.made.length >= max) {
      const made = c.made.slice().sort((a, b) => a - b);
      const days = Math.max(1, Math.ceil((made[made.length - max] + this.windowMs() - Date.now()) / DAY_MS));
      this.notice(mp, userId, (days === 1 ? loc("writing.limit.madeDay", { max, window: this.cfg.writingDocumentDays, days }) : loc("writing.limit.madeDays", { max, window: this.cfg.writingDocumentDays, days })));
      return false;
    }
    if (c.recent.length >= this.cfg.writingMaxPerDay) {
      this.notice(mp, userId, loc("writing.limit.tired"));
      return false;
    }
    return true;
  }

  // Slots age out, so documents given away stop counting after the window
  private counterOf(mp: Mp, actorId: number): Counter {
    let raw: any = null;
    try { raw = mp.get(actorId, COUNTER_PROP); } catch { /* no counter yet */ }
    const now = Date.now();
    const within = (list: unknown, ms: number): number[] =>
      (Array.isArray(list) ? list : []).map(Number).filter((t) => t <= now && now - t < ms);
    return { made: within(raw?.made, this.windowMs()), recent: within(raw?.recent, DAY_MS) };
  }

  // Records a new document, or frees the slot of a destroyed one while it still counts
  private count(mp: Mp, actorId: number, createdAt: number, made: boolean): void {
    if (!actorId) return;
    const c = this.counterOf(mp, actorId);
    if (made) {
      c.made.push(createdAt);
      c.recent.push(createdAt);
    } else {
      const i = c.made.indexOf(createdAt);
      if (i < 0) return;
      c.made.splice(i, 1);
    }
    try { mp.set(actorId, COUNTER_PROP, c); } catch { /* character gone */ }
  }

  private windowMs(): number {
    return this.cfg.writingDocumentDays * DAY_MS;
  }

  // ── Items ───────────────────────────────────────────────────────────────────

  private carried(mp: Mp, actorId: number): Carried[] {
    const out: Carried[] = [];
    for (const entry of readInventory(mp, actorId).entries) {
      const key = this.keyOf.get(Number(entry?.baseId) >>> 0);
      const id = tagOf(entry?.name);
      if (key && WRITTEN_KEYS.includes(key) && id && (entry.count | 0) > 0) out.push({ entry, id, key });
    }
    return out;
  }

  private plainCount(mp: Mp, actorId: number, baseId: number): number {
    if (!baseId) return 0;
    return readInventory(mp, actorId).entries.reduce((n, e) => n + (sameExtras(e, plain(baseId)) ? (e.count | 0) : 0), 0);
  }

  // Takes the counts of those exact copies and adds the new entries in one inventory write; false when a copy is short
  private rewrite(mp: Mp, actorId: number, take: Array<[Item, number]>, add: Item[]): boolean {
    const entries = readInventory(mp, actorId).entries.map((e) => ({ ...e }));
    for (const [item, count] of take) {
      let left = count;
      for (const e of entries) {
        if (left <= 0) break;
        if (e.worn || e.wornLeft || !sameExtras(e, item)) continue;
        const n = Math.min(left, e.count | 0);
        e.count -= n;
        left -= n;
      }
      if (left > 0) return false;
    }
    const kept = { entries: entries.filter((e) => e.count > 0) };
    try {
      mp.set(actorId, "inventory", addEntries(kept, add.map((i) => ({ ...i }))));
      return true;
    } catch (e) {
      this.log(`[writing] inventory write for ${hex(actorId)} failed: ${e}`);
      return false;
    }
  }

  private nameOf(doc: WritingDoc, sealed: boolean): string {
    return `${sealed ? "Sealed Letter" : doc.title || KIND_LABEL[doc.kind]} (${doc.id})`;
  }

  // ── Documents ───────────────────────────────────────────────────────────────

  private newDoc(kind: WritingKind, title: string, pages: string[], signed: boolean, author: WritingPerson, scribe: WritingPerson): WritingDoc | null {
    let id = "";
    for (let tries = 0; tries < 20 && !id; tries++) {
      let candidate = "W";
      for (let i = 0; i < 5; i++) candidate += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
      if (!this.store.exists(candidate)) id = candidate;
    }
    if (!id) return null;
    const now = Date.now();
    return {
      v: 1, id, kind, title, pages: pages.slice(), signed, finished: false, fixedPages: 0, author, scribe, copyOf: "",
      createdAt: now, updatedAt: now, seal: null, brokenSeals: [], destroyedAt: 0, destroyedBy: "",
    };
  }

  private persist(doc: WritingDoc): boolean {
    try {
      this.store.save(doc);
      return true;
    } catch (e) {
      this.log(`[writing] could not save ${doc.id}: ${e}`);
      return false;
    }
  }

  private person(mp: Mp, actorId: number): WritingPerson {
    return {
      actorId, profileId: profileIdOf(mp, actorId), realName: realNameOf(mp, actorId), shownName: displayNameOf(mp, actorId),
      title: this.factions.titleOfActor(actorId), factionId: this.sealFactionOf(actorId),
    };
  }

  private nobody(): WritingPerson {
    return { actorId: 0, profileId: -1, realName: "", shownName: "", title: "", factionId: "" };
  }

  // The faction of the title the character shows, "" with no title shown or a title of a faction without a mark
  private sealFactionOf(actorId: number): string {
    const shown = this.factions.titleOfActor(actorId) ? this.factions.titleFactionOf(actorId) : "";
    return SEAL_FACTIONS.includes(shown) && this.factions.membershipsOfActor(actorId).some((m) => m.factionId === shown) ? shown : "";
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private base(key: BaseKey): number {
    return this.bases.get(key) || 0;
  }

  // True, and the clock restarted, when the cooldown has passed
  private cooled(map: Map<number, number>, userId: number, ms: number): boolean {
    const now = Date.now();
    if (now - (map.get(userId) || 0) < ms) return false;
    map.set(userId, now);
    return true;
  }

  private notice(mp: Mp, userId: number, text: string): void {
    sendJson(mp, userId, { customPacketType: "notification", text });
  }

  private appendLog(text: string): void {
    appendLog(this.logDir, LOG_FILE, text);
  }

  private adminLog(text: string): void {
    adminAudit(text);
    this.log(`[writing] ${text}`);
  }

  private cfg = { ...DEFAULTS };
  private enabled = false;
  private ready = false;
  private logDir = "C:\\logs";
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private store: WritingStore = new JsonWritingStore(WRITINGS_DIR, () => { });
  private bases = new Map<BaseKey, number>();
  private keyOf = new Map<number, BaseKey>();
  private sessions = new Map<number, Session>();
  private lastOpenMs = new Map<number, number>();
  private lastSaveMs = new Map<number, number>();
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const describePerson = (p: WritingPerson): string =>
  `${JSON.stringify(p.realName)} (profile ${p.profileId}${p.shownName && p.shownName !== p.realName ? `, shown as ${JSON.stringify(p.shownName)}` : ""})${p.factionId ? ` as ${p.factionId}` : ""}`;
