import * as fs from "fs";
import * as chokidar from "chokidar";
import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds } from "./espmEditorIds";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// File-driven NPC spawner: ./NPC-Spawns.json (server cwd) lists zones that populate when a player walks in and clean up after the last one leaves.
// Format, id rules and the state machine are documented in docs/docs_roleplay_npc_spawns.md.
// The admin panel's NPCs tab (adminSystem.ts) lists, adds, resets and deletes zones through the public methods at the end of the class.

const POLL_MS = 2000;
const ZONES_FILE = "./NPC-Spawns.json";
const SPAWNS_FILE = "./zone-spawns.json";
const DESPAWN_HYSTERESIS = 1.5;
const DEFAULT_SIZE = 2000;
const DEFAULT_DESPAWN = 120;
const DEFAULT_RESPAWN = 1800;
const MAX_COUNT = 20;
const MAX_TOTAL = 40;
const MAX_NAME = 64;
const RING_RADIUS = 64;
const RETRY_MS = 30000;
const RELOAD_DEBOUNCE_MS = 500;
// Keeps the engine from reviving spawner NPCs; delays past ~1e9 s overflow its timer and fire at once
const NEVER_RESPAWN = 1e9;
const TAG_PROP = "private.npcSpawner";
// Slot cooldown marker for Respawn 0: the corpse stays until the zone despawns or an admin resets it
const NEVER_READY = -1;

interface ZoneNpc {
  baseDesc: string;
  count: number;
}

interface Spawned {
  id: number;
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
  // One entry per NPC to place; slot i stands at slotPos(i)
  slots: ZoneNpc[];
  total: number;
  despawnSeconds: number;
  respawnSeconds: number;
  // Per slot: 0 = may spawn now, epoch ms = cooldown end, NEVER_READY = not until reset
  slotReadyAt: number[];
  // Everything that defines the zone; a reload keeps zones whose signature did not change
  signature: string;
  spawned: Spawned[];
  emptySince: number;
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

export interface ZoneSummary {
  name: string;
  active: boolean;
  alive: number;
  total: number;
  inside: number;
  // Seconds until every slot may spawn: 0 = ready, -1 = never until reset
  readyInSec: number;
}

type Reject = (msg: string) => void;

// The parsed zone file; root and key are set when the array sits under a wrapper object
interface ZoneFile {
  list: unknown[];
  root: Record<string, unknown> | null;
  key: string;
  missing: boolean;
}

// Field names in the file are matched case-insensitively; key must be lower case
const pickKey = (raw: unknown, key: string): string | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  return Object.keys(raw).find((x) => x.toLowerCase() === key);
};

const pick = (raw: unknown, key: string): unknown => {
  const k = pickKey(raw, key);
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

const entryName = (raw: unknown): string => String(pick(raw, "name") ?? "").trim().toLowerCase();

export class NpcSpawnSystem implements System {
  systemName = "NpcSpawnSystem";
  constructor(private log: Log) { }

  private mp: Mp = null;
  private zones: Zone[] = [];
  private ready = false;
  private loading = false;
  // Loads run one at a time, whether the watcher or the admin panel asks
  private loadChain: Promise<void> = Promise.resolve();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    this.cleanupLeftovers(this.mp);
    await this.queueLoad("boot");
    this.watchFile();
    this.ready = true;
  }

  private queueLoad(reason: string): Promise<void> {
    this.loadChain = this.loadChain
      .then(() => this.load(this.mp, reason))
      .catch((e) => this.log(`NpcSpawnSystem: load failed (${reason}): ${e}`));
    return this.loadChain;
  }

  private async load(mp: Mp, reason: string): Promise<void> {
    this.loading = true;
    try {
      const file = this.readZoneFile();
      if (typeof file === "string") {
        this.log(`NpcSpawnSystem: ${file}, keeping ${this.zones.length} zone(s)`);
        return;
      }
      if (file.missing) {
        this.log(`NpcSpawnSystem: ${ZONES_FILE} not found, no zones (${reason})`);
        this.replaceZones(mp, []);
        return;
      }
      const list = file.list;

      const drafts: Draft[] = [];
      const names = new Set<string>();
      for (const raw of list) {
        const draft = this.parseDraft(raw);
        if (!draft) continue;
        const key = draft.name.toLowerCase();
        if (names.has(key)) {
          this.log(`NpcSpawnSystem: '${draft.name}' skipped, duplicate zone name`);
          continue;
        }
        names.add(key);
        drafts.push(draft);
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
      const carried = this.replaceZones(mp, zones);
      this.log(`NpcSpawnSystem: ${zones.length}/${list.length} zone(s) loaded from ${ZONES_FILE} (${reason}), carried ${carried} zone(s)`);
    } finally {
      this.loading = false;
    }
  }

  // A missing file reads as an empty list; a string names what is wrong with an existing one
  private readZoneFile(): ZoneFile | string {
    let text: string;
    try {
      text = fs.readFileSync(ZONES_FILE, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return { list: [], root: null, key: "", missing: true };
      return `${ZONES_FILE} unreadable: ${e}`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return `${ZONES_FILE} is not valid JSON: ${e}`;
    }
    if (Array.isArray(parsed)) return { list: parsed, root: null, key: "", missing: false };
    const key = pickKey(parsed, "zones");
    const list = key === undefined ? undefined : (parsed as Record<string, unknown>)[key];
    if (key === undefined || !Array.isArray(list)) return `${ZONES_FILE} must be an array or { "zones": [...] }`;
    return { list, root: parsed as Record<string, unknown>, key, missing: false };
  }

  // Temp file plus rename so an interrupted write cannot truncate the zone list; a wrapper object keeps its other keys
  private writeZoneFile(file: ZoneFile, list: unknown[]): void {
    const tmp = ZONES_FILE + ".tmp";
    if (file.root) file.root[file.key] = list;
    fs.writeFileSync(tmp, JSON.stringify(file.root ?? list, null, 2));
    fs.renameSync(tmp, ZONES_FILE);
  }

  // Zones whose name and definition did not change keep their NPCs, timers and players; the rest are despawned
  private replaceZones(mp: Mp, zones: Zone[]): number {
    const old = new Map(this.zones.map((z) => [z.name.toLowerCase(), z]));
    const carried = new Set<Zone>();
    for (const zone of zones) {
      const prev = old.get(zone.name.toLowerCase());
      if (!prev || prev.signature !== zone.signature) continue;
      zone.spawned = prev.spawned;
      zone.slotReadyAt = prev.slotReadyAt;
      zone.emptySince = prev.emptySince;
      zone.inside = prev.inside;
      carried.add(prev);
    }
    for (const gone of this.zones) {
      if (!carried.has(gone) && gone.spawned.length) this.despawn(mp, gone);
    }
    this.zones = zones;
    return carried.size;
  }

  private parseDraft(raw: unknown, reject: Reject = (msg) => this.log(`NpcSpawnSystem: ${msg}`)): Draft | null {
    const name = String(pick(raw, "name") ?? "").trim();
    if (!name) {
      reject("entry without a Name skipped");
      return null;
    }
    if (name.length > MAX_NAME) {
      reject(`'${name.slice(0, MAX_NAME)}...' skipped, Name longer than ${MAX_NAME} characters`);
      return null;
    }
    const locator = String(pick(raw, "id") ?? "").trim();
    const pos = this.parsePos(pick(raw, "pos"));
    const radius = num(pick(raw, "size"), DEFAULT_SIZE);
    const npcs = this.parseNpcs(pick(raw, "npc"));
    if (!locator || !pos || !(radius > 0) || !npcs.length) {
      reject(`'${name}' skipped, needs ID, POS {x,y,z}, a positive Size and at least one NPC`);
      return null;
    }
    if (npcs.reduce((sum, n) => sum + n.count, 0) > MAX_TOTAL) {
      reject(`'${name}' skipped, more than ${MAX_TOTAL} NPCs`);
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

  private buildZone(mp: Mp, draft: Draft, editorIds: Map<string, string>, reject: Reject = (msg) => this.log(`NpcSpawnSystem: ${msg}`)): Zone | null {
    let cellOrWorldDesc = "";
    let cellOrWorldId = 0;
    try {
      cellOrWorldDesc = this.toLocatorDesc(mp, draft.locator, editorIds);
      cellOrWorldId = cellOrWorldDesc ? mp.getIdFromDesc(cellOrWorldDesc) : 0;
    } catch {
      cellOrWorldDesc = "";
    }
    if (!cellOrWorldDesc) {
      reject(`'${draft.name}' skipped, ID '${draft.locator}' is not a known cell or worldspace`);
      return null;
    }
    const npcs: ZoneNpc[] = [];
    for (const n of draft.npcs) {
      const baseDesc = this.toNpcDesc(mp, n.id);
      if (!baseDesc) {
        reject(`'${draft.name}' NPC '${n.id}' is not an NPC_ record, skipped`);
        continue;
      }
      npcs.push({ baseDesc, count: n.count });
    }
    if (!npcs.length) {
      reject(`'${draft.name}' skipped, no valid NPC`);
      return null;
    }
    const slots = npcs.flatMap((n) => Array<ZoneNpc>(n.count).fill(n));
    return {
      name: draft.name, cellOrWorldDesc, cellOrWorldId, pos: draft.pos, radius: draft.radius, npcs, slots,
      total: slots.length,
      despawnSeconds: draft.despawnSeconds,
      respawnSeconds: draft.respawnSeconds,
      slotReadyAt: slots.map(() => 0),
      signature: JSON.stringify([cellOrWorldDesc, draft.pos, draft.radius, slots.map((n) => n.baseDesc), draft.despawnSeconds, draft.respawnSeconds]),
      spawned: [], emptySince: 0, inside: new Set(),
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
      if (zone.spawned.length) this.checkDeaths(mp, zone, now);
      if (occupied) {
        zone.emptySince = 0;
        this.fillSlots(mp, zone, now);
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

  // Places every slot that is empty or holds a corpse once its cooldown has run out
  private fillSlots(mp: Mp, zone: Zone, now: number): void {
    const before = zone.spawned.length;
    let changed = false;
    for (let slot = 0; slot < zone.total; slot++) {
      const entry = zone.spawned.find((e) => e.slot === slot);
      if (entry && !entry.diedAt) continue;
      const at = zone.slotReadyAt[slot];
      if (at < 0 || at > now) continue;
      const anchor = this.anchorIn(zone);
      if (anchor === undefined) break;
      const npc = zone.slots[slot];
      const id = this.spawnOne(mp, zone, npc, slot, anchor);
      if (id === null) {
        zone.slotReadyAt[slot] = now + RETRY_MS;
        continue;
      }
      if (entry) {
        try { mp.destroyActor(entry.id); } catch { }
        this.log(`NpcSpawnSystem: '${zone.name}' respawned ${npc.baseDesc} (${hex(entry.id)} -> ${hex(id)})`);
        entry.id = id;
        entry.diedAt = 0;
      } else {
        zone.spawned.push({ id, slot, diedAt: 0 });
      }
      zone.slotReadyAt[slot] = 0;
      changed = true;
    }
    if (!changed) return;
    if (!before) {
      const summary = zone.npcs.map((n) => `${n.baseDesc} x${n.count}`).join(", ");
      this.log(`NpcSpawnSystem: '${zone.name}' spawned ${zone.spawned.length}/${zone.total} npc(s): ${summary}`);
    }
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

  // A death starts the slot's Respawn cooldown; the corpse stays until the slot is refilled or the zone despawns
  private checkDeaths(mp: Mp, zone: Zone, now: number): void {
    for (const entry of zone.spawned) {
      if (entry.diedAt) continue;
      let dead = false;
      // A throw means the form is gone, which counts as dead
      try { dead = mp.get(entry.id, "isDead") === true; } catch { dead = true; }
      if (!dead) continue;
      entry.diedAt = now;
      zone.slotReadyAt[entry.slot] = zone.respawnSeconds > 0 ? now + zone.respawnSeconds * 1000 : NEVER_READY;
    }
  }

  // Cooldowns still running survive the despawn so leaving and coming back cannot skip Respawn; reset clears them
  private despawn(mp: Mp, zone: Zone, reset = false): void {
    for (const entry of zone.spawned) {
      try { mp.destroyActor(entry.id); } catch { }
    }
    this.log(`NpcSpawnSystem: '${zone.name}' despawned ${zone.spawned.length} npc(s)`);
    zone.spawned = [];
    zone.emptySince = 0;
    const now = Date.now();
    zone.slotReadyAt = zone.slotReadyAt.map((at) => reset || at < 0 || at <= now ? 0 : at);
    this.saveSpawns();
  }

  private watchFile(): void {
    const watcher = chokidar.watch(ZONES_FILE, { persistent: true, ignoreInitial: true, awaitWriteFinish: true });
    const schedule = () => this.scheduleReload();
    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);
    watcher.on("error", (e: unknown) => this.log(`NpcSpawnSystem: watch error: ${e}`));
  }

  // Coalesces the burst of events one save produces into a single reload
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.queueLoad("file changed");
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

  private findZone(name: string): Zone | undefined {
    const key = name.trim().toLowerCase();
    return this.zones.find((z) => z.name.toLowerCase() === key);
  }

  private readyInSec(zone: Zone, now: number): number {
    let wait = 0;
    for (const at of zone.slotReadyAt) {
      if (at < 0) return NEVER_READY;
      wait = Math.max(wait, at - now);
    }
    return Math.ceil(wait / 1000);
  }

  // ── Admin panel API ──────────────────────────────────────────────────────────

  listZones(): ZoneSummary[] {
    const now = Date.now();
    return this.zones.map((z) => ({
      name: z.name,
      active: z.spawned.length > 0,
      alive: z.spawned.filter((e) => !e.diedAt).length,
      total: z.total,
      inside: z.inside.size,
      readyInSec: this.readyInSec(z, now),
    }));
  }

  // Validates like a file load, then appends the entry in the documented field names; null on success, else the reason
  async addZone(raw: unknown): Promise<string | null> {
    const reasons: string[] = [];
    const reject: Reject = (msg) => reasons.push(msg);
    const draft = this.parseDraft(raw, reject);
    if (!draft) return reasons[0];
    const s = await Settings.get();
    const scan = await resolveEditorIds(isEditorId(draft.locator) ? [draft.locator] : [], s.dataDir, s.loadOrder, this.log);
    this.buildZone(this.mp, draft, scan.resolved, reject);
    if (reasons.length) return reasons[0];
    const file = this.readZoneFile();
    if (typeof file === "string") return file;
    if (file.list.some((e) => entryName(e) === draft.name.toLowerCase())) return `'${draft.name}' already exists`;
    file.list.push({
      Name: draft.name,
      ID: draft.locator,
      POS: { x: draft.pos[0], y: draft.pos[1], z: draft.pos[2] },
      Size: draft.radius,
      NPC: draft.npcs.map((n) => n.count > 1 ? `${n.id} ${n.count}` : n.id),
      Despawn: draft.despawnSeconds,
      Respawn: draft.respawnSeconds,
    });
    try {
      this.writeZoneFile(file, file.list);
    } catch (e) {
      this.log(`NpcSpawnSystem: ${ZONES_FILE} write failed: ${e}`);
      return `${ZONES_FILE} write failed, see server log`;
    }
    this.log(`NpcSpawnSystem: '${draft.name}' appended to ${ZONES_FILE} by admin`);
    await this.queueLoad("admin add");
    return null;
  }

  // Rewrites the file without the entry; the reload that follows despawns it
  async deleteZone(name: string): Promise<boolean> {
    const file = this.readZoneFile();
    if (typeof file === "string") {
      this.log(`NpcSpawnSystem: ${file}, delete refused`);
      return false;
    }
    const key = name.trim().toLowerCase();
    const kept = file.list.filter((e) => entryName(e) !== key);
    if (kept.length === file.list.length) return false;
    try {
      this.writeZoneFile(file, kept);
    } catch (e) {
      this.log(`NpcSpawnSystem: ${ZONES_FILE} write failed: ${e}`);
      return false;
    }
    this.log(`NpcSpawnSystem: '${name}' removed from ${ZONES_FILE} by admin`);
    await this.queueLoad("admin delete");
    return true;
  }

  // Destroys the zone's NPCs and clears every cooldown; it repopulates on the next poll with a player inside
  resetZone(name: string): boolean {
    const zone = this.findZone(name);
    if (!zone) return false;
    this.despawn(this.mp, zone, true);
    return true;
  }

  teleportTarget(name: string): { cellOrWorldDesc: string; pos: number[] } | null {
    const zone = this.findZone(name);
    return zone ? { cellOrWorldDesc: zone.cellOrWorldDesc, pos: zone.pos } : null;
  }
}
