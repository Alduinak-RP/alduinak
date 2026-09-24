import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, WORLD_LOADED_EVENT } from "./system";
import { NEVER_RESPAWN } from "./npcPlacement";
import { looseEntries } from "./companionSystem";
import { isNamedItemBase } from "./inventoryExtras";
import { destroyRef, hex, isAlive } from "./actorUtil";
import { markDeathAlerted } from "./discordAlerts";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// A PK leaves a lootable body: a clone of the victim at the spot of death holding their pack, while the victim comes back empty (docs_roleplay_survival_loop.md section 8)

// Neighbor-visible flag (registered in the gamemode) telling clients the dead copy is a body to create
const BODY_PROP = "ff_body";
const REGISTRY_FILE = "./bodies.json";
const CHECK_MS = 2000;
// The victim's own dead actor is respawned this long after the body is left, so two bodies never lie side by side
const VICTIM_RESPAWN_MS = 4000;
// Seconds a body lies at most, overridable via "bodyMaxSeconds"; 0 keeps it until it is emptied
const DEFAULT_MAX_SEC = 0;
// Seconds a body lies after its last take or put, overridable via "bodyIdleSeconds"; 0 keeps it; an untouched body is not affected
const DEFAULT_IDLE_SEC = 7200;
// An emptied body is left this long, so a victim with nothing to loot still leaves one to see
const EMPTY_GRACE_MS = 60000;
// A second death of the same victim within this window (a finish off then a soul trap) leaves no second body
const REPEAT_MS = 30000;

interface Body {
  id: number;
  victimId: number;
  // The victim's account, whose other characters may not loot the body; -1 when unknown
  profileId: number;
  at: number;
  // Last take or put, 0 while nobody has touched the pack
  touchedAt: number;
}

export class BodySystem implements System {
  systemName = "BodySystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const maxSec = Number(all?.["bodyMaxSeconds"]);
    if (Number.isFinite(maxSec) && maxSec >= 0) this.maxSec = maxSec;
    const idleSec = Number(all?.["bodyIdleSeconds"]);
    if (Number.isFinite(idleSec) && idleSec >= 0) this.idleSec = idleSec;
    this.loadRegistry();
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.adoptLeftovers());
  }

  async updateAsync(): Promise<void> {
    const now = Date.now();
    if (!this.bodies.size || now < this.nextCheckAt) return;
    this.nextCheckAt = now + CHECK_MS;
    for (const body of Array.from(this.bodies.values())) {
      const entries = this.entriesOf(body.id);
      const left = entries && this.lootLeft(entries);
      if (entries) this.noteTouch(body, entries, now);
      const idle = this.idleSec > 0 && body.touchedAt > 0 && now - body.touchedAt > this.idleSec * 1000;
      const reason = left === null ? "gone" : left === 0 && now - body.at > EMPTY_GRACE_MS ? "emptied" : this.maxSec > 0 && now - body.at > this.maxSec * 1000 ? "lay too long" : idle ? "left alone" : "";
      if (reason) this.remove(body, reason);
    }
  }

  // The clone wears the victim's look and gear and holds their pack; the victim keeps only named items (property keys and writings) and respawns shortly after. 0 when no body could be left
  leaveBody(victimId: number, why: string): number {
    const mp = this.mp;
    const recent = Array.from(this.bodies.values()).find((b) => b.victimId === victimId && Date.now() - b.at < REPEAT_MS);
    if (recent) return recent.id;
    let loc: any, appearance: unknown, equipment: unknown, inventory: any, profileId = -1;
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
    const entries: any[] = Array.isArray(inventory?.entries) ? inventory.entries : [];
    const named = (e: any): boolean => isNamedItemBase(Number(e?.baseId));
    const loot = looseEntries({ entries: entries.filter((e) => !named(e)) });
    let cloneId = 0;
    let step = "creating the clone";
    // The victim is stripped last, so a body that fails to stand leaves their pack where it was
    try {
      cloneId = mp.createActor(0, loc.pos, Number(loc.rot?.[2]) || 0, mp.getIdFromDesc(String(loc.cellOrWorldDesc))) >>> 0;
      mp.set(cloneId, "spawnDelay", NEVER_RESPAWN);
      if (appearance) mp.set(cloneId, "appearance", appearance);
      // Throws on a native build without the equipment setter; the body then lies naked
      try { mp.set(cloneId, "equipment", equipment); } catch { }
      step = `setting ${BODY_PROP} (registered in gamemode.js?)`;
      mp.set(cloneId, BODY_PROP, true);
      // The clone uses the Player base, so the gamemode's onDeath would post a [Death] line for it
      markDeathAlerted(cloneId);
      step = "filling the body";
      mp.set(cloneId, "inventory", { entries: loot });
      mp.set(cloneId, "isDead", true);
      step = "placing the body";
      this.placeOnGrid(cloneId, loc);
      step = "stripping the victim";
      mp.set(victimId, "inventory", { entries: entries.filter(named) });
    } catch (e) {
      this.log(`[body] leaving a body for ${hex(victimId)} failed ${step}, pack kept: ${e}`);
      if (cloneId) {
        try { destroyRef(mp, cloneId); } catch { }
      }
      return 0;
    }
    this.bodies.set(cloneId, { id: cloneId, victimId, profileId, at: Date.now(), touchedAt: 0 });
    this.save();
    setTimeout(() => {
      try {
        if (!isAlive(mp, victimId)) mp.respawnActor(victimId);
      } catch (e) {
        this.log(`[body] respawning ${hex(victimId)} failed: ${e}`);
      }
    }, VICTIM_RESPAWN_MS);
    this.log(`[body] ${hex(victimId)} ${why}: body ${hex(cloneId)} holds ${loot.length} stack(s)`);
    return cloneId;
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

  // Stacks a searcher can still take
  private lootLeft(entries: any[]): number {
    return entries.filter((e) => e && e.count > 0 && !isNamedItemBase(Number(e.baseId))).length;
  }

  // Any change to the pack since the last check is a take or a put; the first check of a run only records it
  private noteTouch(body: Body, entries: any[], now: number): void {
    const sig = entries.filter((e) => e && e.count > 0).map((e) => `${Number(e.baseId) >>> 0}:${e.count}`).sort().join(",");
    const last = this.packSigs.get(body.id);
    this.packSigs.set(body.id, sig);
    if (last === undefined || last === sig) return;
    body.touchedAt = now;
    this.save();
  }

  private remove(body: Body, reason: string): void {
    this.bodies.delete(body.id);
    this.packSigs.delete(body.id);
    try { destroyRef(this.mp, body.id); } catch { }
    this.save();
    this.log(`[body] ${hex(body.id)} of ${hex(body.victimId)} removed: ${reason}`);
  }

  private loadRegistry(): void {
    let saved: { bodies?: unknown } = {};
    try { saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) ?? {}; } catch { }
    this.leftovers = (Array.isArray(saved.bodies) ? saved.bodies : [])
      .map((b: any) => ({ id: Number(b?.id) >>> 0, victimId: Number(b?.victimId) >>> 0, profileId: Number.isInteger(b?.profileId) ? b.profileId : -1, at: Number(b?.at) || 0, touchedAt: Number(b?.touchedAt) || 0 }))
      .filter((b: Body) => b.id > 0);
  }

  // The world DB loads after every system's init (attachSaveStorage in index.ts); bodies still standing are watched again, the rest are forgotten
  private adoptLeftovers(): void {
    const mp = this.mp;
    let kept = 0;
    for (const body of this.leftovers) {
      let exists = false;
      try { exists = mp.get(body.id, "type") === "MpActor"; } catch { }
      if (!exists) continue;
      try {
        this.placeOnGrid(body.id, mp.get(body.id, "locationalData"));
      } catch (e) {
        this.log(`[body] placing ${hex(body.id)} failed: ${e}`);
      }
      this.bodies.set(body.id, body);
      kept++;
    }
    if (this.leftovers.length) this.log(`[body] ${kept}/${this.leftovers.length} body(ies) of the previous run kept`);
    this.leftovers = [];
    this.save();
  }

  private save(): void {
    const registry = { bodies: Array.from(this.bodies.values()).concat(this.leftovers) };
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry)); }
    catch (e) { this.log(`[body] ${REGISTRY_FILE} write failed: ${e}`); }
  }

  private mp: Mp = null;
  private maxSec = DEFAULT_MAX_SEC;
  private idleSec = DEFAULT_IDLE_SEC;
  private nextCheckAt = 0;
  // bodyId -> the body lying in the world
  private bodies = new Map<number, Body>();
  // bodyId -> the pack as last checked
  private packSigs = new Map<number, string>();
  // Registry entries of the previous run, adopted once the world loads
  private leftovers: Body[] = [];
}
