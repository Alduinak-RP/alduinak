import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, WORLD_LOADED_EVENT } from "./system";
import { NEVER_RESPAWN } from "./npcPlacement";
import { looseEntries } from "./companionSystem";
import { InventoryEntry, addEntries, isNamedItemBase, readInventory } from "./inventoryExtras";
import { SettleWear, wearSettler } from "./durabilityNative";
import { destroyRef, hex, isAlive, userOf } from "./actorUtil";
import { sendJson } from "./playerText";
import { markDeathAlerted } from "./discordAlerts";
import { every } from "./timers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// A PK leaves a lootable body: a clone of the victim at the spot of death holding their whole pack, while the victim comes back empty (docs_roleplay_survival_loop.md section 8)

// Neighbor-visible flag (registered in the gamemode) telling clients the dead copy is a body to create
const BODY_PROP = "ff_body";
const REGISTRY_FILE = "./bodies.json";
// The body's own record and index, so a restart finds every body even when bodies.json lost it
const RECORD_PROP = "private.pkBody";
const INDEX_PROP = "private.indexed.pkBody";
const INDEX_ON = "on";
const CHECK_MS = 2000;
// The victim's own dead actor is respawned this long after the body is left, time for its client to end the killmove and fall
const VICTIM_RESPAWN_MS = 4000;
// Clients holding a copy of that actor keep it out of sight this long, past the respawn that takes it from them, so two bodies never lie side by side
const VICTIM_HIDDEN_MS = VICTIM_RESPAWN_MS + 2000;
// A body lies until it is emptied, and an emptied one is left this long, so a victim with nothing to loot still leaves one to see
const EMPTY_GRACE_MS = 60000;
// A second death of the same victim within this window (a finish off then a soul trap) leaves no second body
const REPEAT_MS = 30000;

interface Body {
  id: number;
  victimId: number;
  // The victim's account, whose other characters may not loot the body; -1 when unknown
  profileId: number;
  at: number;
}

const packSig = (entries: any[]): string =>
  entries.filter((e) => e && e.count > 0).map((e) => `${Number(e.baseId) >>> 0}:${e.count}`).sort().join(",");

const stacksOf = (entries: any[]): any[] => entries.filter((e) => e && Number(e.count) > 0);

const isNamed = (e: any): boolean => isNamedItemBase(Number(e?.baseId));

// "N item(s) in M stack(s)"
const sizeOf = (entries: any[]): string => {
  const stacks = stacksOf(entries);
  return `${stacks.reduce((n, e) => n + Number(e.count), 0)} item(s) in ${stacks.length} stack(s)`;
};

// "f x120, db0e2 "Breezehome Key (H1A2B/3)" x1": the record staff restore from
const itemList = (entries: any[]): string => stacksOf(entries)
  .map((e) => `${hex(Number(e.baseId))}${isNamed(e) && e.name ? ` ${JSON.stringify(String(e.name))}` : ""} x${e.count}`).join(", ") || "nothing";

const wornOf = (equipment: any): any[] =>
  stacksOf(Array.isArray(equipment?.inv?.entries) ? equipment.inv.entries : []).filter((e) => e.worn || e.wornLeft);

export class BodySystem implements System {
  systemName = "BodySystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    this.loadRegistry();
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.adoptLeftovers());
    this.settleWear = wearSettler(this.mp, (await Settings.get()).allSettings as Record<string, unknown> | null, this.log);
    every("body", CHECK_MS, () => this.poll());
  }

  poll(): void {
    if (!this.bodies.size) return;
    const now = Date.now();
    for (const body of Array.from(this.bodies.values())) {
      const entries = this.entriesOf(body.id);
      const left = entries && this.lootLeft(entries);
      if (entries) this.noteTouch(body, entries);
      const reason = left === null ? "gone" : left === 0 && now - body.at > EMPTY_GRACE_MS ? "emptied" : "";
      if (reason) this.remove(body, reason, entries);
    }
  }

  // The clone wears the victim's look and worn gear and takes their whole pack, property keys and writings with their names; the victim respawns shortly after. 0 when no body could be left
  leaveBody(victimId: number, why: string): number {
    const mp = this.mp;
    const recent = this.recentBodyOf(victimId);
    if (recent) return recent.id;
    let loc: any, appearance: unknown, equipment: any, inventory: any, profileId = -1;
    // The wear of the last fight goes into the copies before they leave the victim
    this.settleWear(victimId);
    try {
      profileId = Number(mp.get(victimId, "profileId"));
      loc = mp.get(victimId, "locationalData");
      appearance = mp.get(victimId, "appearance");
      equipment = mp.get(victimId, "equipment");
      inventory = mp.get(victimId, "inventory");
    } catch (e) {
      this.log(`[body] reading ${hex(victimId)} failed: ${e}`);
      return 0;
    }
    const loot = looseEntries(inventory);
    const worn = wornOf(equipment);
    let cloneId = 0;
    let step = "creating the clone";
    let stripped = false;
    const at = Date.now();
    // The body stands empty first; the pack then leaves the victim before the body takes it, so it never has two owners
    try {
      cloneId = mp.createActor(0, loc.pos, Number(loc.rot?.[2]) || 0, mp.getIdFromDesc(String(loc.cellOrWorldDesc))) >>> 0;
      mp.set(cloneId, "spawnDelay", NEVER_RESPAWN);
      mp.set(cloneId, RECORD_PROP, { victimId, profileId, at });
      mp.set(cloneId, INDEX_PROP, INDEX_ON);
      if (appearance) mp.set(cloneId, "appearance", appearance);
      // Worn pieces only, no spells in its hands; throws on a native build without the equipment setter, and the body then lies naked
      try { mp.set(cloneId, "equipment", { inv: { entries: worn }, numChanges: 0 }); } catch { }
      step = `setting ${BODY_PROP} (registered in gamemode.js?)`;
      mp.set(cloneId, BODY_PROP, true);
      // The clone uses the Player base, so the gamemode's onDeath would post a [Death] line for it
      markDeathAlerted(cloneId);
      mp.set(cloneId, "isDead", true);
      step = "placing the body";
      this.placeOnGrid(cloneId, loc);
      step = "stripping the victim";
      mp.set(victimId, "inventory", { entries: [] });
      stripped = true;
      step = "filling the body";
      mp.set(cloneId, "inventory", { entries: loot });
    } catch (e) {
      let outcome = "pack kept";
      if (stripped) {
        try {
          mp.set(victimId, "inventory", inventory);
          outcome = "pack given back";
        } catch (e2) {
          outcome = `pack NOT given back (${e2}), staff must restore ${hex(victimId)}: ${itemList(loot)}`;
        }
      }
      this.log(`[body] leaving a body for ${hex(victimId)} failed ${step}, ${outcome}: ${e}`);
      if (cloneId) {
        try { destroyRef(mp, cloneId); } catch { }
      }
      return 0;
    }
    // Their copies would still wear what the body now holds; spells stay
    try { mp.set(victimId, "equipment", { ...equipment, inv: { entries: [] }, numChanges: 0 }); } catch { }
    this.bodies.set(cloneId, { id: cloneId, victimId, profileId, at });
    this.packSigs.set(cloneId, packSig(loot));
    this.save();
    setTimeout(() => {
      try {
        if (!isAlive(mp, victimId)) mp.respawnActor(victimId);
      } catch (e) {
        this.log(`[body] respawning ${hex(victimId)} failed: ${e}`);
      }
    }, VICTIM_RESPAWN_MS);
    const hiddenOn = this.hideVictim(victimId);
    this.log(`[body] ${hex(victimId)} ${why}: body ${hex(cloneId)} holds ${sizeOf(loot)} moved from the victim (${worn.length} shown worn, ${loot.filter(isNamed).length} named), their own dead actor hidden on ${hiddenOn} client(s); moved: ${itemList(loot)}`);
    return cloneId;
  }

  // Tells every other client that has a copy of the victim to drop it (FormView, bodyLeftUntil); the number of clients told
  private hideVictim(victimId: number): number {
    const mp = this.mp;
    let neighbors: unknown[] = [];
    try { neighbors = mp.get(victimId, "actorNeighbors") ?? []; } catch { /* form vanished */ }
    const users = neighbors.map((id) => Number(id) >>> 0).filter((id) => id !== victimId).map((id) => userOf(mp, id)).filter((user) => user >= 0);
    for (const user of users) sendJson(mp, user, { customPacketType: "bodyLeft", victim: victimId, ms: VICTIM_HIDDEN_MS });
    return users.length;
  }

  // A body left for the victim within REPEAT_MS; their own stripped actor respawns VICTIM_RESPAWN_MS after it
  hasBodyFor(victimId: number): boolean {
    return !!this.recentBodyOf(victimId);
  }

  // The victim and account a body stands for, undefined for any other actor
  bodyOf(bodyId: number): { victimId: number; profileId: number } | undefined {
    const body = this.bodies.get(bodyId);
    return body && { victimId: body.victimId, profileId: body.profileId };
  }

  // Everything the body holds goes to the actor, keys and writings under their names; "N item(s) in M stack(s)", "" when it held nothing, or throws and the body keeps it
  emptyInto(bodyId: number, actorId: number, why: string): string {
    const mp = this.mp;
    const body = this.bodies.get(bodyId);
    if (!body) throw new Error(`${hex(bodyId)} is no PK body`);
    const loot = looseEntries(mp.get(bodyId, "inventory")) as unknown as InventoryEntry[];
    if (!loot.length) return "";
    mp.set(bodyId, "inventory", { entries: [] });
    try {
      mp.set(actorId, "inventory", addEntries(readInventory(mp, actorId), loot));
    } catch (e) {
      let outcome = "the body keeps it";
      try { mp.set(bodyId, "inventory", { entries: loot }); } catch (e2) { outcome = `NOT given back (${e2}), staff must restore ${hex(bodyId)}: ${itemList(loot)}`; }
      this.log(`[body] ${hex(bodyId)} of ${hex(body.victimId)} ${why}: moving the pack to ${hex(actorId)} failed, ${outcome}: ${e}`);
      throw e;
    }
    this.log(`[body] ${hex(bodyId)} of ${hex(body.victimId)} ${why}: ${sizeOf(loot)} moved to ${hex(actorId)} (${loot.filter(isNamed).length} named); moved: ${itemList(loot)}`);
    return sizeOf(loot);
  }

  private recentBodyOf(victimId: number): Body | undefined {
    return Array.from(this.bodies.values()).find((b) => b.victimId === victimId && Date.now() - b.at < REPEAT_MS);
  }

  // createActor never streams an actor; setting its location puts it on the grid so nearby clients create it
  private placeOnGrid(id: number, loc: any): void {
    this.mp.set(id, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos: loc.pos, rot: loc.rot });
  }

  // Another character of the fallen player's account would undo the loss; "" when the searcher may open the body
  refusalFor(searcherId: number, bodyId: number): string {
    const profileId = this.bodies.get(bodyId)?.profileId ?? -1;
    if (!(profileId >= 0)) return "";
    let own = false;
    try { own = Number(this.mp.get(searcherId, "profileId")) === profileId; } catch { }
    return own ? "You cannot loot the body of your own fallen character." : "";
  }

  // null when the form is gone
  private entriesOf(bodyId: number): any[] | null {
    try {
      const entries = this.mp.get(bodyId, "inventory")?.entries;
      return Array.isArray(entries) ? entries : [];
    } catch {
      return null;
    }
  }

  // Stacks a searcher can still take; one whose base the load order lacks never shows in the window, so it cannot keep the body
  private lootLeft(entries: any[]): number {
    return stacksOf(entries).filter((e) => this.inLoadOrder(Number(e.baseId) >>> 0)).length;
  }

  private inLoadOrder(baseId: number): boolean {
    let known = this.knownBases.get(baseId);
    if (known === undefined) {
      try { known = !!this.mp.lookupEspmRecordById(baseId)?.record; } catch { known = true; }
      this.knownBases.set(baseId, known);
    }
    return known;
  }

  // Any change to the pack since the last check is a take or a put; the pack is recorded when the body is left or adopted
  private noteTouch(body: Body, entries: any[]): void {
    const sig = packSig(entries);
    const last = this.packSigs.get(body.id);
    this.packSigs.set(body.id, sig);
    if (last === undefined || last === sig) return;
    this.trimWorn(body.id, entries);
  }

  // A worn piece taken from the body stops showing on it; each shown piece needs one of its base still in the pack
  private trimWorn(bodyId: number, entries: any[]): void {
    let worn: any[] = [];
    try { worn = wornOf(this.mp.get(bodyId, "equipment")); } catch { return; }
    const left = new Map<number, number>();
    for (const e of stacksOf(entries)) left.set(Number(e.baseId) >>> 0, (left.get(Number(e.baseId) >>> 0) ?? 0) + Number(e.count));
    const shown = worn.filter((e) => {
      const base = Number(e.baseId) >>> 0;
      const n = left.get(base) ?? 0;
      left.set(base, n - 1);
      return n > 0;
    });
    if (shown.length === worn.length) return;
    try {
      this.mp.set(bodyId, "equipment", { inv: { entries: shown }, numChanges: 0 });
    } catch (e) {
      this.log(`[body] undressing ${hex(bodyId)} failed: ${e}`);
      return;
    }
    this.log(`[body] ${hex(bodyId)} no longer shows ${worn.length - shown.length} worn piece(s) taken from it, ${shown.length} still shown`);
  }

  private remove(body: Body, reason: string, entries: any[] | null): void {
    this.bodies.delete(body.id);
    this.packSigs.delete(body.id);
    try { destroyRef(this.mp, body.id); } catch { }
    this.save();
    this.log(`[body] ${hex(body.id)} of ${hex(body.victimId)} removed: ${reason}${entries && stacksOf(entries).length ? `, went with it: ${itemList(entries)}` : ""}`);
  }

  private loadRegistry(): void {
    let saved: { bodies?: unknown } = {};
    try { saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) ?? {}; } catch { }
    this.leftovers = (Array.isArray(saved.bodies) ? saved.bodies : [])
      .map((b: any) => ({ id: Number(b?.id) >>> 0, victimId: Number(b?.victimId) >>> 0, profileId: Number.isInteger(b?.profileId) ? b.profileId : -1, at: Number(b?.at) || 0 }))
      .filter((b: Body) => b.id > 0);
  }

  private exists(id: number): boolean {
    try { return this.mp.get(id, "type") === "MpActor"; } catch { return false; }
  }

  // Bodies bodies.json lost, found by their index; one without a readable record counts from now
  private unregisteredBodies(known: Body[]): Body[] {
    let ids: number[] = [];
    try { ids = (this.mp.findFormsByPropertyValue(INDEX_PROP, INDEX_ON) as unknown[]).map((id) => Number(id) >>> 0); } catch (e) { this.log(`[body] ${INDEX_PROP} lookup failed: ${e}`); }
    return ids.filter((id) => !known.some((b) => b.id === id) && this.exists(id)).map((id) => {
      let rec: any = null;
      try { rec = this.mp.get(id, RECORD_PROP); } catch { }
      return { id, victimId: Number(rec?.victimId) >>> 0, profileId: Number.isInteger(rec?.profileId) ? rec.profileId : -1, at: Number(rec?.at) || Date.now() };
    });
  }

  // The world DB loads after every system's init (attachSaveStorage in index.ts); bodies still standing are watched again, the rest are forgotten
  private adoptLeftovers(): void {
    const leftovers = this.leftovers.filter((b) => this.exists(b.id));
    const found = this.unregisteredBodies(leftovers);
    for (const body of leftovers.concat(found)) {
      try {
        this.placeOnGrid(body.id, this.mp.get(body.id, "locationalData"));
      } catch (e) {
        this.log(`[body] placing ${hex(body.id)} failed: ${e}`);
      }
      this.bodies.set(body.id, body);
      const entries = this.entriesOf(body.id);
      if (entries) this.packSigs.set(body.id, packSig(entries));
    }
    if (this.leftovers.length || found.length) {
      this.log(`[body] ${leftovers.length}/${this.leftovers.length} body(ies) of the previous run kept${found.length ? `, ${found.length} more missing from ${REGISTRY_FILE} found by ${INDEX_PROP}: ${found.map((b) => hex(b.id)).join(", ")}` : ""}`);
    }
    this.leftovers = [];
    this.save();
  }

  private save(): void {
    const registry = { bodies: Array.from(this.bodies.values()).concat(this.leftovers) };
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry)); }
    catch (e) { this.log(`[body] ${REGISTRY_FILE} write failed: ${e}`); }
  }

  private mp: Mp = null;
  private settleWear: SettleWear = () => { };
  // baseId -> whether the load order holds it
  private knownBases = new Map<number, boolean>();
  // bodyId -> the body lying in the world
  private bodies = new Map<number, Body>();
  // bodyId -> the pack as last checked
  private packSigs = new Map<number, string>();
  // Registry entries of the previous run, adopted once the world loads
  private leftovers: Body[] = [];
}
