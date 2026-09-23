import * as crypto from "crypto";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";
import { resolveEditorIds } from "./espmEditorIds";
import { hex, isIntroduced, userSlotCount } from "./actorUtil";
import { adminAudit } from "./discordAlerts";
import { AdminRoleConfig, adminTierOf, missingCap, readAdminRoleConfig } from "./adminRoles";
import { FactionSystem } from "./factionSystem";
import { InventoryEntry, Item, addEntries, isNamedItemBase, namedItemBaseIds, readInventory, registerNamedItemBases, sameExtras } from "./inventoryExtras";
import { appendLog, describeActor, displayNameOf, logDirOf, profileIdOf, realNameOf, sanitize, sendJson, titledName } from "./playerText";
import { JsonWritingStore, WRITING_ID, WritingDoc, WritingKind, WritingPerson, WritingSeal, WritingStore } from "./writingStore";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Letters, journals and books whose text stays on the server and whose id rides in the item name; rules and protocol in docs/docs_roleplay_writing.md

const EDITOR_IDS = {
  letterBlank: "AldWritingParchmentBlank",
  letter: "AldWritingLetter",
  sealed: "AldWritingLetterSealed",
  journalBlank: "AldWritingJournalBlank",
  journal: "AldWritingJournal",
  bookBlank: "AldWritingBookBlank",
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
const OPEN_COOLDOWN_MS = 1000;
const SAVE_COOLDOWN_MS = 2000;
const DAY_MS = 24 * 3600000;

// Factions with a mark in skymp5-front/src/img/seals, guilds and the Legion before the hold courts
const SEAL_FACTIONS = [
  "faction:dark-brotherhood", "faction:college-of-winterhold", "faction:imperial-legion",
  "hold:haafingar", "hold:the-reach", "hold:falkreath", "hold:hjaalmarch", "hold:eastmarch",
  "hold:winterhold", "hold:the-rift", "hold:the-pale", "hold:whiterun",
];

type View = "compose" | "read" | "sealed" | "list";

interface Session {
  view: View;
  kind?: WritingKind;
  // The blank base the composer writes on
  blank?: number;
}

interface Carried {
  entry: InventoryEntry;
  id: string;
  key: BaseKey;
}

// Creation times: made keeps documents within the window that still exist, recent every document of the last day
interface Counter {
  made: number[];
  recent: number[];
}

const tagOf = (name: unknown): string => {
  const m = typeof name === "string" ? TAG.exec(name) : null;
  return m ? m[1] : "";
};

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
      if (type === "writingUse") this.notice(mp, userId, "Writing is not available yet.");
      return;
    }
    const id = String(content["id"] ?? "");
    switch (type) {
      case "writingUse": return this.onUse(mp, userId, actorId, toFormId(content["baseId"]));
      case "writingOpen": return this.cooled(this.lastOpenMs, userId, OPEN_COOLDOWN_MS) ? this.openDoc(mp, userId, actorId, id) : undefined;
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
    const previous = typeof mp.onDropItem === "function" ? mp.onDropItem : null;
    mp.onDropItem = (actorId: number, baseId: number, count: number): boolean => {
      if (isNamedItemBase(baseId >>> 0)) return false;
      if (!previous) return true;
      try {
        return previous.call(mp, actorId, baseId, count) !== false;
      } catch {
        return true;
      }
    };
  }

  // ── Opening ─────────────────────────────────────────────────────────────────

  private onUse(mp: Mp, userId: number, actorId: number, baseId: number): void {
    const key = this.keyOf.get(baseId);
    const kind = key ? KIND_OF[key] : undefined;
    if (!key || !kind || !this.cooled(this.lastOpenMs, userId, OPEN_COOLDOWN_MS)) return;
    if (this.plainCount(mp, actorId, baseId) > 0 && !this.carried(mp, actorId).some((c) => c.entry.baseId >>> 0 === baseId)) {
      this.openCompose(mp, userId, kind, baseId);
      return;
    }
    const written = this.carried(mp, actorId).filter((c) => c.entry.baseId >>> 0 === baseId);
    if (written.length === 1) this.openDoc(mp, userId, actorId, written[0].id);
    else if (written.length > 1) this.openList(mp, userId, written);
  }

  // A written item without a name counts as a blank of its kind
  private openCompose(mp: Mp, userId: number, kind: WritingKind, blank: number): void {
    this.sessions.set(userId, { view: "compose", kind, blank });
    this.sendMenu(mp, userId, { view: "compose", compose: { kind, blankName: BLANK_LABEL[kind] } });
  }

  private openList(mp: Mp, userId: number, written: Carried[]): void {
    this.sessions.set(userId, { view: "list" });
    this.sendMenu(mp, userId, {
      view: "list",
      list: written.map((c) => {
        const kind = KIND_OF[c.key] || "letter";
        const sealed = c.key === "sealed";
        return { id: c.id, kind, title: sealed ? "Sealed Letter" : this.store.load(c.id)?.title || KIND_LABEL[kind], sealed };
      }),
    });
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
      this.notice(mp, userId, "You no longer carry that writing.");
      return null;
    }
    const doc = this.store.load(id);
    if (!doc) {
      this.notice(mp, userId, "The ink has faded beyond reading.");
      this.log(`[writing] ${hex(actorId)} carries ${id}, which has no document`);
      return null;
    }
    const sealed = carried.key === "sealed";
    if (doc.destroyedAt) {
      this.rewrite(mp, actorId, [[carried.entry, carried.entry.count]], []);
      this.notice(mp, userId, "The writing crumbles to dust.");
      return null;
    }
    if (doc.kind !== KIND_OF[carried.key]) {
      this.notice(mp, userId, "The writing is illegible.");
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
      this.notice(mp, userId, `You have no ${BLANK_LABEL[kind]} left.`);
      return;
    }
    const me = this.person(mp, actorId);
    const doc = this.newDoc(kind, title, pages, content["signed"] === true, me, me);
    if (!doc) return this.notice(mp, userId, "Your writing could not be kept.");
    const item: Item = { baseId: this.base(WRITTEN_OF[kind]), count: 1, name: this.nameOf(doc, false) };
    if (!this.rewrite(mp, actorId, [[plain(blank), 1]], [item])) return;
    if (!this.persist(doc)) {
      this.rewrite(mp, actorId, [[item, 1]], [plain(blank)]);
      return this.notice(mp, userId, "Your writing could not be kept.");
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
    if (!this.canEdit(actorId, doc, carried)) return this.notice(mp, userId, "You cannot change this writing.");
    const title = cleanTitle(content["title"], this.cfg.writingTitleMaxLen);
    const pages = this.readPages(mp, userId, doc.kind, content["pages"]);
    if (!pages) return;
    const changed = pages.map((p, i) => (p !== doc.pages[i] ? i : -1)).filter((i) => i >= 0);
    for (let i = pages.length; i < doc.pages.length; i++) changed.push(i);
    const retitled = title !== doc.title;
    if (!changed.length && !retitled) return this.openDoc(mp, userId, actorId, id);
    doc.title = title;
    doc.pages = pages;
    doc.updatedAt = Date.now();
    if (retitled && !this.rewrite(mp, actorId, [[carried.entry, 1]], [{ ...carried.entry, count: 1, name: this.nameOf(doc, false) }])) return;
    if (!this.persist(doc)) return this.notice(mp, userId, "Your changes could not be kept.");
    const pageLines = changed.map((i) => `page ${i + 1}: ${JSON.stringify(pages[i] ?? "")}`).join(", ");
    this.appendLog(`${describeActor(mp, actorId)} edited ${doc.kind} ${id} ${JSON.stringify(title)}${pageLines ? " " + pageLines : ""}`);
    this.openDoc(mp, userId, actorId, id);
  }

  private onFinish(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found) return;
    const { doc, carried } = found;
    if (doc.kind !== "book" || !this.canEdit(actorId, doc, carried)) return;
    doc.finished = true;
    doc.updatedAt = Date.now();
    if (!this.persist(doc)) return this.notice(mp, userId, "The book could not be finished.");
    this.appendLog(`${describeActor(mp, actorId)} finished book ${id} ${JSON.stringify(doc.title)}`);
    this.notice(mp, userId, "The book is finished. Its pages are fixed now.");
    this.openDoc(mp, userId, actorId, id);
  }

  // ── Seals ───────────────────────────────────────────────────────────────────

  private onSeal(mp: Mp, userId: number, actorId: number, id: string): void {
    const found = this.reconcile(mp, userId, actorId, id);
    if (!found || found.carried.key !== "letter") return;
    const { doc, carried } = found;
    const wax = this.base("wax");
    if (this.plainCount(mp, actorId, wax) < 1) return this.notice(mp, userId, "Sealing a letter takes Sealing Wax.");
    const sealed: Item = { baseId: this.base("sealed"), count: 1, name: this.nameOf(doc, true) };
    if (!this.rewrite(mp, actorId, [[carried.entry, 1], [plain(wax), 1]], [sealed])) return;
    doc.seal = { ...this.person(mp, actorId), at: Date.now() };
    this.persist(doc);
    this.appendLog(`${describeActor(mp, actorId)} sealed letter ${id} ${JSON.stringify(doc.title)}${doc.seal.factionId ? ` as ${doc.seal.factionId}` : ""}`);
    this.notice(mp, userId, "You press your seal into the wax.");
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
    if (doc.kind !== "book" || !doc.finished) return this.notice(mp, userId, "Only a finished book can be copied.");
    const blank = this.base("bookBlank");
    if (this.plainCount(mp, actorId, blank) < 1) return this.notice(mp, userId, "Copying a book takes a Blank Book.");
    if (!this.roomToWrite(mp, userId, actorId)) return;
    const copy = this.newDoc("book", doc.title, doc.pages, doc.signed, doc.author, this.person(mp, actorId));
    if (!copy) return this.notice(mp, userId, "The copy could not be kept.");
    copy.finished = true;
    copy.copyOf = doc.copyOf || doc.id;
    const item: Item = { baseId: this.base("book"), count: 1, name: this.nameOf(copy, false) };
    if (!this.rewrite(mp, actorId, [[plain(blank), 1]], [item])) return;
    if (!this.persist(copy)) {
      this.rewrite(mp, actorId, [[item, 1]], [plain(blank)]);
      return this.notice(mp, userId, "The copy could not be kept.");
    }
    this.count(mp, actorId, copy.createdAt, true);
    this.appendLog(`${describeActor(mp, actorId)} copied book ${id} ${JSON.stringify(doc.title)} as ${copy.id}`);
    this.notice(mp, userId, `You copy ${doc.title || "the book"} onto a blank book.`);
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
    this.notice(mp, userId, "The writing burns away.");
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
    if (missingCap("players", this.roleCfg.tierCaps[tier])) return reply(false, "Your rank cannot moderate writings");
    const op = String(content["op"] ?? "");
    const id = String(content["id"] ?? "").trim().toUpperCase();
    const doc = WRITING_ID.test(id) ? this.store.load(id) : null;
    if (!doc) return reply(false, `No writing ${id || "without an id"}`);
    const staff = `profile ${profileIdOf(mp, actorId)} (${tier})`;
    const what = `${doc.kind} ${id} ${JSON.stringify(doc.title)} by ${JSON.stringify(doc.author.realName)} (profile ${doc.author.profileId})`;
    if (op === "read") {
      this.sessions.set(userId, { view: "read" });
      this.sendDoc(mp, userId, actorId, doc, null, true);
      this.adminLog(`${staff} read ${what}`);
      return reply(true, `Opened ${id}`);
    }
    if (op === "rename") {
      const title = cleanTitle(content["title"], this.cfg.writingTitleMaxLen);
      if (!title) return reply(false, "The new title is empty");
      doc.title = title;
      doc.updatedAt = Date.now();
      if (!this.persist(doc)) return reply(false, "Rename failed, see server log");
      const held = this.renameOnline(mp, doc);
      this.adminLog(`${staff} renamed ${what} to ${JSON.stringify(title)}`);
      this.appendLog(`staff ${staff} renamed ${id} to ${JSON.stringify(title)}`);
      return reply(true, `Renamed ${id}${held ? `, ${held} carried cop${held === 1 ? "y" : "ies"} updated` : ""}`);
    }
    if (op === "destroy") {
      if (doc.destroyedAt) return reply(false, `${id} is already destroyed`);
      this.destroy(mp, doc, `staff ${staff}`);
      const held = this.removeOnline(mp, id);
      this.adminLog(`${staff} destroyed ${what}`);
      this.appendLog(`staff ${staff} destroyed ${id}`);
      return reply(true, `Destroyed ${id}${held ? `, removed from ${held} pack${held === 1 ? "" : "s"}` : ""}`);
    }
    reply(false, `Unknown writing action '${op}'`);
  }

  // Copies in chests and offline packs catch up when they are next read
  private renameOnline(mp: Mp, doc: WritingDoc): number {
    return this.onlineActors(mp).filter((actorId) => {
      const c = this.carried(mp, actorId).find((x) => x.id === doc.id && x.key !== "sealed");
      return !!c && this.rewrite(mp, actorId, [[c.entry, c.entry.count]], [{ ...c.entry, name: this.nameOf(doc, false) }]);
    }).length;
  }

  private removeOnline(mp: Mp, id: string): number {
    return this.onlineActors(mp).filter((actorId) => {
      const c = this.carried(mp, actorId).find((x) => x.id === id);
      return !!c && this.rewrite(mp, actorId, [[c.entry, c.entry.count]], []);
    }).length;
  }

  private onlineActors(mp: Mp): number[] {
    const out: number[] = [];
    for (let userId = 0; userId < userSlotCount(); userId++) {
      try {
        if (!mp.isConnected(userId)) continue;
        const actorId = mp.getUserActor(userId) >>> 0;
        if (actorId) out.push(actorId);
      } catch { /* slot gone */ }
    }
    return out;
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

  // What this reader may see and do; staff see real names and never act on the item
  private sendDoc(mp: Mp, userId: number, actorId: number, doc: WritingDoc, carried: Carried | null, staff: boolean): void {
    const sealed = carried?.key === "sealed";
    const hidden = sealed && !staff;
    const nameFor = (who: WritingPerson): string => {
      if (staff) return `${who.realName || "someone unrecorded"} (profile ${who.profileId})`;
      const known = who.actorId === actorId || (!!who.actorId && isIntroduced(mp, actorId, who.actorId));
      return known ? titledName(who.title, who.shownName) : "";
    };
    const sealName = (seal: WritingSeal): string => {
      const name = nameFor(seal);
      return name ? `the seal of ${name}` : "an unfamiliar seal";
    };
    const author = doc.signed ? nameFor(doc.author) : "";
    const byline = !doc.signed ? "" : author ? `Signed, ${author}` : "Signed in an unfamiliar hand";
    const staffLines = staff ? [
      `Scribe: ${describePerson(doc.scribe)}`,
      `Written ${new Date(doc.createdAt).toISOString()}, last changed ${new Date(doc.updatedAt).toISOString()}`,
      doc.seal ? `Sealed by ${describePerson(doc.seal)}` : "",
      doc.destroyedAt ? `Destroyed ${new Date(doc.destroyedAt).toISOString()} by ${doc.destroyedBy}` : "",
    ].filter((l) => l) : [];
    const editable = !!carried && !staff && this.canEdit(actorId, doc, carried);
    this.sendMenu(mp, userId, {
      view: hidden ? "sealed" : "read",
      doc: {
        id: doc.id,
        kind: doc.kind,
        title: hidden ? "Sealed Letter" : doc.title || KIND_LABEL[doc.kind],
        pages: hidden ? [] : doc.pages,
        byline: hidden ? "" : staff ? `${doc.signed ? "Signed" : "Unsigned"}, by ${nameFor(doc.author)}` : byline,
        copy: !!doc.copyOf,
        finished: doc.finished,
        sealText: hidden ? `Closed with ${sealName(doc.seal || { ...this.nobody(), at: 0 })}.` : "",
        // Heraldry is public: the marks show to every reader, only the names follow the introductions rule
        sealFaction: hidden ? doc.seal?.factionId || "" : "",
        signFaction: !hidden && doc.signed ? doc.author.factionId : "",
        brokenSeals: doc.brokenSeals.map((b) => capitalise(`${sealName(b.seal)} was broken.`)),
        canEdit: editable,
        canFinish: editable && doc.kind === "book",
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

  // Letters until the first seal, journals always, books until finished; only the author, and never a copy
  private canEdit(actorId: number, doc: WritingDoc, carried: Carried): boolean {
    if (doc.author.actorId !== actorId || doc.copyOf || carried.key === "sealed") return false;
    if (doc.kind === "letter") return !doc.seal && doc.brokenSeals.length === 0;
    if (doc.kind === "book") return !doc.finished;
    return true;
  }

  private readPages(mp: Mp, userId: number, kind: WritingKind, raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const maxPages = kind === "letter" ? 1 : kind === "journal" ? this.cfg.writingJournalMaxPages : this.cfg.writingBookMaxPages;
    const maxLen = kind === "letter" ? this.cfg.writingLetterMaxLen : this.cfg.writingPageMaxLen;
    if (raw.length > maxPages) {
      this.notice(mp, userId, `A ${KIND_LABEL[kind].toLowerCase()} holds ${maxPages} page${maxPages === 1 ? "" : "s"} at most.`);
      return null;
    }
    const pages: string[] = [];
    for (const page of raw) {
      // Bound the work before sanitize walks the payload
      if (typeof page !== "string" || page.length > maxLen * 4) return null;
      const text = sanitize(page);
      if (text.length > maxLen) {
        this.notice(mp, userId, `A page holds ${maxLen} characters at most.`);
        return null;
      }
      pages.push(text);
    }
    while (pages.length && !pages[pages.length - 1]) pages.pop();
    if (!pages.length) {
      this.notice(mp, userId, "The page is still blank.");
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
      this.notice(mp, userId, `You have made ${max} writings in the last ${this.cfg.writingDocumentDays} days. Burn one of them, or wait ${days} day${days === 1 ? "" : "s"}.`);
      return false;
    }
    if (c.recent.length >= this.cfg.writingMaxPerDay) {
      this.notice(mp, userId, "Your hand is tired. Write again tomorrow.");
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
      v: 1, id, kind, title, pages: pages.slice(), signed, finished: false, author, scribe, copyOf: "",
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

  // The faction whose title the character shows, else the first of theirs with a mark
  private sealFactionOf(actorId: number): string {
    const mine = this.factions.membershipsOfActor(actorId).map((m) => m.factionId);
    const shown = this.factions.titleFactionOf(actorId);
    if (SEAL_FACTIONS.includes(shown) && mine.includes(shown)) return shown;
    return SEAL_FACTIONS.find((id) => mine.includes(id)) || "";
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
