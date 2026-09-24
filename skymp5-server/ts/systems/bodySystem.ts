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
// A body lies this long at most; overridable via "bodyMaxSeconds", 0 keeps it until it is emptied
const DEFAULT_MAX_SEC = 3600;
// An emptied body is left this long, so a victim with nothing to loot still leaves one to see
const EMPTY_GRACE_MS = 60000;
// A second death of the same victim within this window (a finish off then a soul trap) leaves no second body
const REPEAT_MS = 30000;

interface Body {
  id: number;
  victimId: number;
  at: number;
}

export class BodySystem implements System {
  systemName = "BodySystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const maxSec = Number(all?.["bodyMaxSeconds"]);
    if (Number.isFinite(maxSec) && maxSec >= 0) this.maxSec = maxSec;
    this.loadRegistry();
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.adoptLeftovers());
  }

  async updateAsync(): Promise<void> {
    const now = Date.now();
    if (!this.bodies.size || now < this.nextCheckAt) return;
    this.nextCheckAt = now + CHECK_MS;
    for (const body of Array.from(this.bodies.values())) {
      const left = this.lootLeft(body.id);
      const reason = left === null ? "gone" : left === 0 && now - body.at > EMPTY_GRACE_MS ? "emptied" : this.maxSec > 0 && now - body.at > this.maxSec * 1000 ? "lay too long" : "";
      if (reason) this.remove(body, reason);
    }
  }

  // The clone wears the victim's look and gear and holds their pack, and the victim respawns shortly after; 0 when no body could be left
  leaveBody(victimId: number, why: string): number {
    const mp = this.mp;
    const recent = Array.from(this.bodies.values()).find((b) => b.victimId === victimId && Date.now() - b.at < REPEAT_MS);
    if (recent) return recent.id;
    let loc: any, appearance: unknown, equipment: unknown, inventory: any;
    try {
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
    let cloneId = 0;
    try {
      cloneId = mp.createActor(0, loc.pos, Number(loc.rot?.[2]) || 0, mp.getIdFromDesc(String(loc.cellOrWorldDesc))) >>> 0;
      mp.set(cloneId, "spawnDelay", NEVER_RESPAWN);
      if (appearance) mp.set(cloneId, "appearance", appearance);
    } catch (e) {
      this.log(`[body] leaving a body for ${hex(victimId)} failed: ${e}`);
      if (cloneId) {
        try { mp.destroyActor(cloneId); } catch { }
      }
      return 0;
    }
    // Throws on a native build without the equipment setter; the body then lies naked
    try { mp.set(cloneId, "equipment", equipment); } catch { }
    // Registration lives in gamemode.js; without it late arrivals never see the body, but it is still lootable
    try {
      mp.set(cloneId, BODY_PROP, true);
    } catch (e) {
      this.log(`[body] ${BODY_PROP} on ${hex(cloneId)} failed (property registered in gamemode.js?): ${e}`);
    }
    const loot = looseEntries({ entries: entries.filter((e) => !named(e)) });
    // The clone uses the Player base, so the gamemode's onDeath would post a [Death] line for it
    markDeathAlerted(cloneId);
    try {
      mp.set(cloneId, "inventory", { entries: loot });
      mp.set(cloneId, "isDead", true);
    } catch (e) {
      this.log(`[body] filling ${hex(cloneId)} with the pack of ${hex(victimId)} failed: ${e}`);
    }
    this.bodies.set(cloneId, { id: cloneId, victimId, at: Date.now() });
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

  // Stacks a searcher can still take; null when the form is gone
  private lootLeft(bodyId: number): number | null {
    let entries: any[];
    try {
      entries = this.mp.get(bodyId, "inventory")?.entries ?? [];
    } catch {
      return null;
    }
    return entries.filter((e) => e && e.count > 0 && !isNamedItemBase(Number(e.baseId))).length;
  }

  private remove(body: Body, reason: string): void {
    this.bodies.delete(body.id);
    try { destroyRef(this.mp, body.id); } catch { }
    this.save();
    this.log(`[body] ${hex(body.id)} of ${hex(body.victimId)} removed: ${reason}`);
  }

  private loadRegistry(): void {
    let saved: { bodies?: unknown } = {};
    try { saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) ?? {}; } catch { }
    this.leftovers = (Array.isArray(saved.bodies) ? saved.bodies : [])
      .map((b: any) => ({ id: Number(b?.id) >>> 0, victimId: Number(b?.victimId) >>> 0, at: Number(b?.at) || 0 }))
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
  private nextCheckAt = 0;
  // bodyId -> the body lying in the world
  private bodies = new Map<number, Body>();
  // Registry entries of the previous run, adopted once the world loads
  private leftovers: Body[] = [];
}
