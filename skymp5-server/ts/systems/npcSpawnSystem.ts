import * as fs from "fs";
import * as chokidar from "chokidar";
import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds } from "./espmEditorIds";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// File-driven NPC spawner: ./NPC-Spawns.json (server cwd) lists zones that populate when a player walks in and clean up after the last one leaves.
// Format, id rules and the state machine are documented in docs/docs_roleplay_npc_spawns.md.

const POLL_MS = 2000;
const ZONES_FILE = "./NPC-Spawns.json";
const SPAWNS_FILE = "./zone-spawns.json";
const DESPAWN_HYSTERESIS = 1.5;
const DEFAULT_SIZE = 2000;
const DEFAULT_DESPAWN = 120;
const DEFAULT_RESPAWN = 1800;
const MAX_COUNT = 20;
const RING_RADIUS = 64;
const RETRY_MS = 30000;
const RELOAD_DEBOUNCE_MS = 500;
// Keeps the engine from reviving spawner NPCs; delays past ~1e9 s overflow its timer and fire at once
const NEVER_RESPAWN = 1e9;
const TAG_PROP = "private.npcSpawner";

interface ZoneNpc {
  baseDesc: string;
  count: number;
}

interface Spawned {
  id: number;
  npc: ZoneNpc;
  slot: number;
  diedAt: number;
}

interface Zone {
  name: string;
  cellOrWorldDesc: string;
  cellOrWorldId: number;
  pos: number[];
  radius: number;
  npcs: ZoneNpc[];
  total: number;
  despawnSeconds: number;
  respawnSeconds: number;
  spawned: Spawned[];
  emptySince: number;
  retryAt: number;
  inside: Set<number>;
}

// A file entry with its fields checked but the location and NPC bases not yet resolved
interface Draft {
  name: string;
  locator: string;
  pos: number[];
  radius: number;
  npcs: { id: string; count: number }[];
  despawnSeconds: number;
  respawnSeconds: number;
}

// Field names in the file are matched case-insensitively; key must be lower case
const pick = (raw: unknown, key: string): unknown => {
  if (!raw || typeof raw !== "object") return undefined;
  const k = Object.keys(raw).find((x) => x.toLowerCase() === key);
  return k === undefined ? undefined : (raw as Record<string, unknown>)[k];
};

const num = (v: unknown, fallback: number): number => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const hex = (id: number): string => id.toString(16);

const isHexId = (text: string): boolean => /^0x[0-9a-f]{1,8}$/i.test(text) || /^[0-9a-f]{1,8}$/i.test(text);

// ID forms: "1a26f:Skyrim.esm" desc, "0x0001A26F" / "0001A26F" load-order id, anything else an editor id
const isEditorId = (locator: string): boolean =>
  !locator.includes(":") && !/^0x[0-9a-f]+$/i.test(locator) && !/^[0-9a-f]{8}$/i.test(locator);

export class NpcSpawnSystem implements System {
  systemName = "NpcSpawnSystem";
  constructor(private log: Log) { }

  private zones: Zone[] = [];
  private ready = false;
  private loading = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    this.cleanupLeftovers(mp);
    await this.load(mp, "boot");
    this.watchFile(mp);
    this.ready = true;
  }

  private async load(mp: Mp, reason: string): Promise<void> {
    this.loading = true;
    try {
      let text: string;
      try {
        text = fs.readFileSync(ZONES_FILE, "utf8");
      } catch (e: any) {
        if (e?.code !== "ENOENT") {
          this.log(`NpcSpawnSystem: ${ZONES_FILE} unreadable, keeping ${this.zones.length} zone(s): ${e}`);
          return;
        }
        this.log(`NpcSpawnSystem: ${ZONES_FILE} not found, no zones (${reason})`);
        this.replaceZones(mp, []);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        this.log(`NpcSpawnSystem: ${ZONES_FILE} is not valid JSON, keeping ${this.zones.length} zone(s): ${e}`);
        return;
      }
      const list = Array.isArray(parsed) ? parsed : pick(parsed, "zones");
      if (!Array.isArray(list)) {
        this.log(`NpcSpawnSystem: ${ZONES_FILE} must be an array or { "zones": [...] }, keeping ${this.zones.length} zone(s)`);
        return;
      }

      const drafts: Draft[] = [];
      for (const raw of list) {
        const draft = this.parseDraft(raw);
        if (draft) drafts.push(draft);
      }
      const editorIds = drafts.map((d) => d.locator).filter(isEditorId);
      const s = await Settings.get();
      const scan = await resolveEditorIds(editorIds, s.dataDir, s.loadOrder, this.log);
      if (editorIds.length) {
        const missing = scan.unresolved.length ? `, unresolved: ${scan.unresolved.join(", ")}` : "";
        this.log(`NpcSpawnSystem: resolved ${editorIds.length - scan.unresolved.length}/${editorIds.length} editor id(s) in ${scan.scannedMs} ms${missing}`);
      }
      const zones: Zone[] = [];
      for (const draft of drafts) {
        const zone = this.buildZone(mp, draft, scan.resolved);
        if (zone) zones.push(zone);
      }
      this.replaceZones(mp, zones);
      this.log(`NpcSpawnSystem: ${zones.length}/${list.length} zone(s) loaded from ${ZONES_FILE} (${reason})`);
    } finally {
      this.loading = false;
    }
  }

  private replaceZones(mp: Mp, zones: Zone[]): void {
    for (const zone of this.zones) {
      if (zone.spawned.length) this.despawn(mp, zone);
    }
    this.zones = zones;
  }

  private parseDraft(raw: unknown): Draft | null {
    const name = String(pick(raw, "name") ?? "").trim();
    if (!name) {
      this.log("NpcSpawnSystem: entry without a Name skipped");
      return null;
    }
    const locator = String(pick(raw, "id") ?? "").trim();
    const pos = this.parsePos(pick(raw, "pos"));
    const radius = num(pick(raw, "size"), DEFAULT_SIZE);
    const npcs = this.parseNpcs(pick(raw, "npc"));
    if (!locator || !pos || !(radius > 0) || !npcs.length) {
      this.log(`NpcSpawnSystem: '${name}' skipped, needs ID, POS {x,y,z}, a positive Size and at least one NPC`);
      return null;
    }
    return {
      name, locator, pos, radius, npcs,
      despawnSeconds: Math.max(0, num(pick(raw, "despawn"), DEFAULT_DESPAWN)),
      respawnSeconds: Math.max(0, num(pick(raw, "respawn"), DEFAULT_RESPAWN)),
    };
  }

  // {x,y,z}, [x,y,z] or "x, y, z"
  private parsePos(raw: unknown): number[] | null {
    let parts: unknown[] | null = null;
    if (Array.isArray(raw)) parts = raw;
    else if (typeof raw === "string") parts = raw.split(/[,\s]+/).filter(Boolean);
    else if (raw && typeof raw === "object") parts = [pick(raw, "x"), pick(raw, "y"), pick(raw, "z")];
    if (!parts || parts.length !== 3) return null;
    const pos = parts.map((v) => num(v, NaN));
    return pos.every((v) => Number.isFinite(v)) ? pos : null;
  }

  // "00023A99 4", "23a99:Skyrim.esm 4" or { id, count }; count defaults to 1
  private parseNpcs(raw: unknown): { id: string; count: number }[] {
    const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const out: { id: string; count: number }[] = [];
    for (const item of list) {
      let id = "";
      let count = 1;
      if (typeof item === "string") {
        const m = item.trim().match(/^(.+?)(?:\s+(\d+))?$/);
        if (m) {
          id = m[1];
          count = num(m[2], 1);
        }
      } else if (item && typeof item === "object") {
        id = String(pick(item, "id") ?? "").trim();
        count = num(pick(item, "count"), 1);
      }
      if (id) out.push({ id, count: Math.max(1, Math.min(MAX_COUNT, Math.round(count))) });
    }
    return out;
  }

  private buildZone(mp: Mp, draft: Draft, editorIds: Map<string, string>): Zone | null {
    let cellOrWorldDesc = "";
    let cellOrWorldId = 0;
    try {
      cellOrWorldDesc = this.toLocatorDesc(mp, draft.locator, editorIds);
      cellOrWorldId = cellOrWorldDesc ? mp.getIdFromDesc(cellOrWorldDesc) : 0;
    } catch {
      cellOrWorldDesc = "";
    }
    if (!cellOrWorldDesc) {
      this.log(`NpcSpawnSystem: '${draft.name}' skipped, ID '${draft.locator}' is not a known cell or worldspace`);
      return null;
    }
    const npcs: ZoneNpc[] = [];
    for (const n of draft.npcs) {
      const baseDesc = this.toNpcDesc(mp, n.id);
      if (!baseDesc) {
        this.log(`NpcSpawnSystem: '${draft.name}' NPC '${n.id}' is not an NPC_ record, skipped`);
        continue;
      }
      npcs.push({ baseDesc, count: n.count });
    }
    if (!npcs.length) {
      this.log(`NpcSpawnSystem: '${draft.name}' skipped, no valid NPC`);
      return null;
    }
    return {
      name: draft.name, cellOrWorldDesc, cellOrWorldId, pos: draft.pos, radius: draft.radius, npcs,
      total: npcs.reduce((sum, n) => sum + n.count, 0),
      despawnSeconds: draft.despawnSeconds,
      respawnSeconds: draft.respawnSeconds,
      spawned: [], emptySince: 0, retryAt: 0, inside: new Set(),
    };
  }

  private toLocatorDesc(mp: Mp, locator: string, editorIds: Map<string, string>): string {
    if (locator.includes(":")) return locator;
    if (!isEditorId(locator)) return mp.getDescFromId(parseInt(locator, 16));
    return editorIds.get(locator.toLowerCase()) ?? "";
  }

  // Base forms: "23a99:Skyrim.esm" desc or a load-order hex id; must point at an NPC_ record
  private toNpcDesc(mp: Mp, text: string): string {
    try {
      let desc = text;
      if (!text.includes(":")) {
        if (!isHexId(text)) return "";
        desc = mp.getDescFromId(parseInt(text, 16));
      }
      const rec = mp.lookupEspmRecordById(mp.getIdFromDesc(desc));
      return rec?.record?.type === "NPC_" ? desc : "";
    } catch {
      return "";
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.ready || this.loading || !this.zones.length) return;
    const mp = ctx.svr as Mp;

    let playerIds: number[] = [];
    try { playerIds = mp.get(0, "onlinePlayers") ?? []; } catch { return; }
    const now = Date.now();

    for (const zone of this.zones) {
      this.updateInside(mp, zone, playerIds);
      const occupied = zone.inside.size > 0;
      if (zone.spawned.length) this.checkDeaths(mp, zone, now, occupied);
      if (occupied) {
        zone.emptySince = 0;
        if (!zone.spawned.length && now >= zone.retryAt) this.populate(mp, zone, now);
      } else if (zone.spawned.length && zone.despawnSeconds > 0) {
        if (!zone.emptySince) zone.emptySince = now;
        if (now - zone.emptySince >= zone.despawnSeconds * 1000) this.despawn(mp, zone);
      }
    }
  }

  private updateInside(mp: Mp, zone: Zone, playerIds: number[]): void {
    const inside = new Set<number>();
    for (const id of playerIds) {
      // Hysteresis: a player already inside only counts as gone beyond 1.5x the trigger radius
      const reach = zone.inside.has(id) ? zone.radius * DESPAWN_HYSTERESIS : zone.radius;
      try {
        if (mp.getActorCellOrWorld(id) !== zone.cellOrWorldId) continue;
        const pos = mp.getActorPos(id);
        const dx = pos[0] - zone.pos[0];
        const dy = pos[1] - zone.pos[1];
        const dz = pos[2] - zone.pos[2];
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      } catch {
        continue;
      }
      inside.add(id);
      if (!zone.inside.has(id)) this.log(`NpcSpawnSystem: '${zone.name}' entered by ${this.actorLabel(mp, id)}`);
    }
    zone.inside = inside;
  }

  private actorLabel(mp: Mp, id: number): string {
    let name = "";
    try { name = String(mp.getActorName(id) ?? ""); } catch { }
    return `${name || hex(id)} (${hex(id)})`;
  }

  // PlaceAtMe needs a self ref; a player standing in the zone keeps the new actor in the right cell from the start
  private anchorIn(zone: Zone): number | undefined {
    return zone.inside.values().next().value;
  }

  private populate(mp: Mp, zone: Zone, now: number): void {
    const anchor = this.anchorIn(zone);
    if (anchor === undefined) return;
    let slot = 0;
    for (const npc of zone.npcs) {
      for (let i = 0; i < npc.count; i++, slot++) {
        const id = this.spawnOne(mp, zone, npc, slot, anchor);
        if (id !== null) zone.spawned.push({ id, npc, slot, diedAt: 0 });
      }
    }
    if (!zone.spawned.length) {
      zone.retryAt = now + RETRY_MS;
      return;
    }
    const summary = zone.npcs.map((n) => `${n.baseDesc} x${n.count}`).join(", ");
    this.log(`NpcSpawnSystem: '${zone.name}' spawned ${zone.spawned.length}/${zone.total} npc(s): ${summary}`);
    this.saveSpawns();
  }

  private spawnOne(mp: Mp, zone: Zone, npc: ZoneNpc, slot: number, anchorId: number): number | null {
    try {
      const self = { type: "form", desc: mp.getDescFromId(anchorId) };
      const res = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
        self, [{ type: "espm", desc: npc.baseDesc }, 1, false, false]);
      if (!res?.desc) throw new Error("PlaceAtMe returned no reference");
      const id = mp.getIdFromDesc(res.desc);
      const loc = { cellOrWorldDesc: zone.cellOrWorldDesc, pos: this.slotPos(zone, slot), rot: [0, 0, 0] };
      mp.set(id, "locationalData", loc);
      mp.set(id, "spawnPoint", loc);
      mp.set(id, "spawnDelay", NEVER_RESPAWN);
      try { mp.set(id, TAG_PROP, zone.name); } catch { }
      return id;
    } catch (e) {
      this.log(`NpcSpawnSystem: '${zone.name}' failed to spawn ${npc.baseDesc}: ${e}`);
      return null;
    }
  }

  // One NPC stands on POS; more are spread evenly on a ring so they do not stack
  private slotPos(zone: Zone, slot: number): number[] {
    if (zone.total < 2) return zone.pos;
    const angle = (2 * Math.PI * slot) / zone.total;
    return [zone.pos[0] + RING_RADIUS * Math.cos(angle), zone.pos[1] + RING_RADIUS * Math.sin(angle), zone.pos[2]];
  }

  private checkDeaths(mp: Mp, zone: Zone, now: number, occupied: boolean): void {
    let changed = false;
    for (const entry of zone.spawned) {
      if (!entry.diedAt) {
        let dead = false;
        // A throw means the form is gone, which counts as dead
        try { dead = mp.get(entry.id, "isDead") === true; } catch { dead = true; }
        if (dead) entry.diedAt = now;
        continue;
      }
      if (!occupied || zone.respawnSeconds <= 0 || now - entry.diedAt < zone.respawnSeconds * 1000) continue;
      const anchor = this.anchorIn(zone);
      if (anchor === undefined) continue;
      try { mp.destroyActor(entry.id); } catch { }
      const id = this.spawnOne(mp, zone, entry.npc, entry.slot, anchor);
      if (id === null) {
        entry.diedAt += RETRY_MS;
        continue;
      }
      this.log(`NpcSpawnSystem: '${zone.name}' respawned ${entry.npc.baseDesc} (${hex(entry.id)} -> ${hex(id)})`);
      entry.id = id;
      entry.diedAt = 0;
      changed = true;
    }
    if (changed) this.saveSpawns();
  }

  private despawn(mp: Mp, zone: Zone): void {
    for (const entry of zone.spawned) {
      try { mp.destroyActor(entry.id); } catch { }
    }
    this.log(`NpcSpawnSystem: '${zone.name}' despawned ${zone.spawned.length} npc(s)`);
    zone.spawned = [];
    zone.emptySince = 0;
    this.saveSpawns();
  }

  private watchFile(mp: Mp): void {
    const watcher = chokidar.watch(ZONES_FILE, { persistent: true, ignoreInitial: true, awaitWriteFinish: true });
    const schedule = () => this.scheduleReload(mp);
    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);
    watcher.on("error", (e: unknown) => this.log(`NpcSpawnSystem: watch error: ${e}`));
  }

  // Coalesces the burst of events one save produces into a single reload
  private scheduleReload(mp: Mp): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (this.loading) return this.scheduleReload(mp);
      this.load(mp, "file changed").catch((e) => this.log(`NpcSpawnSystem: reload failed: ${e}`));
    }, RELOAD_DEBOUNCE_MS);
  }

  // Spawned NPCs persist in the world DB, so ids from a previous run are destroyed on boot instead of leaking forever
  private cleanupLeftovers(mp: Mp): void {
    let ids: number[] = [];
    try { ids = JSON.parse(fs.readFileSync(SPAWNS_FILE, "utf8")); } catch { }
    if (!Array.isArray(ids) || !ids.length) return;
    let removed = 0;
    for (const id of ids) {
      try { mp.destroyActor(Number(id)); removed++; } catch { }
    }
    this.log(`NpcSpawnSystem: removed ${removed}/${ids.length} leftover npc(s) from the previous run`);
    this.saveSpawns();
  }

  private saveSpawns(): void {
    const ids = this.zones.flatMap((z) => z.spawned.map((e) => e.id));
    try { fs.writeFileSync(SPAWNS_FILE, JSON.stringify(ids)); }
    catch (e) { this.log(`NpcSpawnSystem: spawns file write failed: ${e}`); }
  }
}
