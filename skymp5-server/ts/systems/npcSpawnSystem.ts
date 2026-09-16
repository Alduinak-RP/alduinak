import * as fs from "fs";
import * as chokidar from "chokidar";
import { Settings } from "../settings";
import { System, Log, SystemContext, WORLD_LOADED_EVENT } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { placeNpc, HOSTILE_PROP } from "./npcPlacement";
import { Hostable } from "./hostingSystem";
import { destroyLeftovers } from "./actorUtil";
import { loadNavmeshSpots, randomPointOn, NavmeshTarget, SpotKind, Spots } from "./navmeshSpots";
import { writeFileAtomic } from "./fileUtil";

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
const SLOT_SPACING = 96;
// Random navmesh spots tried per placement before the best of them is taken
const PLACE_ATTEMPTS = 24;
// A fresh NPC stands at least this far from every player in the zone's cell or worldspace when the navmesh allows it
const PLAYER_CLEARANCE = 768;
// Spawn height above POS so an NPC drops onto an uneven floor instead of starting inside it
const SPAWN_LIFT = 64;
const RETRY_MS = 30000;
const RELOAD_DEBOUNCE_MS = 500;
const TAG_PROP = "private.npcSpawner";
// ACBS template flags: the race or the AI data comes from the TPLT template
const TEMPLATE_USE_TRAITS = 0x01;
const TEMPLATE_USE_AI_DATA = 0x10;
// RACE DATA flags and size (0 small .. 3 extra large)
const RACE_FLAGS_OFFSET = 32;
const RACE_SIZE_OFFSET = 64;
const RACE_SIZE_LARGE = 2;
const RACE_SWIMS = 0x40;
const RACE_WALKS = 0x100;
const MAX_TEMPLATE_DEPTH = 8;
// Slot cooldown marker for Respawn 0: the slot stays empty until the zone despawns or an admin resets it
const NEVER_READY = -1;
// A corpse is removed this long after death, whatever its zone does. Overridable via "npcCorpseSeconds".
const DEFAULT_CORPSE_SECONDS = 300;

interface ZoneNpc {
  baseDesc: string;
  count: number;
}

interface Spawned {
  id: number;
  slot: number;
  diedAt: number;
  pos: number[];
}

interface Zone {
  name: string;
  cellOrWorldDesc: string;
  cellOrWorldId: number;
  pos: number[];
  radius: number;
  // Radius of the navmesh area NPCs scatter over, Size when unset; 0 keeps rings of slots around pos
  spread?: number;
  // Walkable navmesh within reach of pos: undefined while it is scanned, null when there is none
  spots?: Spots | null;
  npcs: ZoneNpc[];
  // One entry per NPC to place; slot i rings at slotPos(i)
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
  spread?: number;
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

type EspmField = { type: string; data: Uint8Array };

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

const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const isHexId = (text: string): boolean => /^0x[0-9a-f]{1,8}$/i.test(text) || /^[0-9a-f]{1,8}$/i.test(text);

// ID forms: "1a26f:Skyrim.esm" desc, "0x0001A26F" / "0001A26F" load-order id, anything else an editor id

const entryName = (raw: unknown): string => String(pick(raw, "name") ?? "").trim().toLowerCase();

export class NpcSpawnSystem implements System {
  systemName = "NpcSpawnSystem";
  constructor(private log: Log) { }

  private mp: Mp = null;
  private zones: Zone[] = [];
  // Ids placed by the previous run, destroyed once the world DB has loaded
  private leftovers: number[] = [];
  private ready = false;
  private loading = false;
  // Loads run one at a time, whether the watcher or the admin panel asks
  private loadChain: Promise<void> = Promise.resolve();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  // Dead NPC actorId -> epoch ms when its corpse is destroyed
  private corpses = new Map<number, number>();
  private corpseMs = DEFAULT_CORPSE_SECONDS * 1000;
  // Navmesh spots by area for the whole run, since plugins only change with a restart
  private spotCache = new Map<string, Spots | null>();
  private scanning = new Set<string>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const rawCorpse = Number(all?.["npcCorpseSeconds"]);
    if (Number.isFinite(rawCorpse) && rawCorpse > 0) this.corpseMs = rawCorpse * 1000;
    this.cleanupLeftovers(this.mp);
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.removeLeftovers());
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
      this.attachSpots(mp);
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

  // A wrapper object keeps its other keys
  private writeZoneFile(file: ZoneFile, list: unknown[]): void {
    if (file.root) file.root[file.key] = list;
    writeFileAtomic(ZONES_FILE, JSON.stringify(file.root ?? list, null, 2));
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
    // Blank scatters over the whole Size, 0 keeps the rings
    const spreadRaw = num(pick(raw, "spread"), NaN);
    const spread = spreadRaw === 0 ? 0 : spreadRaw > 0 ? Math.min(radius, spreadRaw) : undefined;
    return {
      name, locator, pos, radius, spread, npcs,
      despawnSeconds: Math.max(0, num(pick(raw, "despawn"), DEFAULT_DESPAWN)),
      respawnSeconds: Math.max(0, num(pick(raw, "respawn"), DEFAULT_RESPAWN)),
    };
  }

  private spotKey(zone: Zone): string {
    return [zone.cellOrWorldId, zone.pos.join(","), zone.spread || zone.radius].join("|");
  }

  private awaitingSpots(zone: Zone): boolean {
    return zone.spread !== 0 && zone.spots === undefined;
  }

  // Cached areas apply at once; the rest are scanned in the background, never twice at the same time
  private attachSpots(mp: Mp): void {
    const targets = new Map<string, NavmeshTarget>();
    for (const zone of this.zones) {
      if (zone.spread === 0) continue;
      const key = this.spotKey(zone);
      if (this.spotCache.has(key)) zone.spots = this.spotCache.get(key);
      else if (!this.scanning.has(key)) targets.set(key, { key, cellOrWorldId: zone.cellOrWorldId, pos: zone.pos, radius: zone.spread || zone.radius });
    }
    if (!targets.size) return;
    for (const key of targets.keys()) this.scanning.add(key);
    void this.scanSpots(mp, Array.from(targets.values()));
  }

  // A reload may replace the zones meanwhile, so results go to the current zones by key; a partial scan is used but not cached
  private async scanSpots(mp: Mp, targets: NavmeshTarget[]): Promise<void> {
    const started = Date.now();
    let found = new Map<string, Spots | null>();
    try {
      const s = await Settings.get();
      const scan = await loadNavmeshSpots(mp, s.dataDir, s.loadOrder, targets, this.log);
      found = scan.spots;
      if (scan.complete) for (const [key, spots] of found) this.spotCache.set(key, spots);
      else this.log("NpcSpawnSystem: navmesh scan missed unreadable plugins, it runs again on the next reload");
    } catch (e) {
      this.log(`NpcSpawnSystem: navmesh scan failed, zones use rings until the next reload: ${e}`);
    }
    const keys = new Set(targets.map((t) => t.key));
    for (const key of keys) this.scanning.delete(key);
    const rings: string[] = [];
    let matched = 0;
    for (const zone of this.zones) {
      const key = this.spotKey(zone);
      if (zone.spread === 0 || !keys.has(key)) continue;
      zone.spots = found.get(key) ?? null;
      matched++;
      if (!zone.spots) rings.push(zone.name);
    }
    const kept = rings.length ? `; rings kept for: ${rings.join(", ")}` : "";
    this.log(`NpcSpawnSystem: navmesh spots for ${matched - rings.length}/${matched} zone(s) in ${Date.now() - started} ms${kept}`);
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
      name: draft.name, cellOrWorldDesc, cellOrWorldId, pos: draft.pos, radius: draft.radius, spread: draft.spread, npcs, slots,
      total: slots.length,
      despawnSeconds: draft.despawnSeconds,
      respawnSeconds: draft.respawnSeconds,
      slotReadyAt: slots.map(() => 0),
      signature: JSON.stringify([cellOrWorldDesc, draft.pos, draft.radius, draft.spread, slots.map((n) => n.baseDesc), draft.despawnSeconds, draft.respawnSeconds]),
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
    if (!this.ready) return;
    const mp = ctx.svr as Mp;
    const now = Date.now();
    this.sweepCorpses(mp, now);
    if (this.loading || !this.zones.length) return;

    let playerIds: number[] = [];
    try { playerIds = mp.get(0, "onlinePlayers") ?? []; } catch { return; }

    for (const zone of this.zones) {
      this.updateInside(mp, zone, playerIds);
      const occupied = zone.inside.size > 0;
      if (zone.spawned.length) this.checkDeaths(mp, zone, now);
      if (occupied) {
        zone.emptySince = 0;
        if (!this.awaitingSpots(zone)) this.fillSlots(mp, zone, now);
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

  // Places every slot that is empty or holds a corpse once its cooldown has run out; force skips the cooldown and falls back to the given anchor
  private fillSlots(mp: Mp, zone: Zone, now: number, force = false, fallbackAnchor?: number): number {
    const before = zone.spawned.length;
    let placed = 0;
    for (let slot = 0; slot < zone.total; slot++) {
      const entry = zone.spawned.find((e) => e.slot === slot);
      if (entry && !entry.diedAt) continue;
      const at = zone.slotReadyAt[slot];
      if (!force && (at < 0 || at > now)) continue;
      const anchor = this.anchorIn(zone) ?? fallbackAnchor;
      if (anchor === undefined) break;
      const npc = zone.slots[slot];
      const fresh = this.spawnOne(mp, zone, npc, slot, anchor);
      if (fresh === null) {
        zone.slotReadyAt[slot] = now + RETRY_MS;
        continue;
      }
      if (entry) {
        this.removeNpc(mp, entry.id);
        this.log(`NpcSpawnSystem: '${zone.name}' respawned ${npc.baseDesc} (${hex(entry.id)} -> ${hex(fresh.id)})`);
        entry.id = fresh.id;
        entry.pos = fresh.pos;
        entry.diedAt = 0;
      } else {
        zone.spawned.push({ id: fresh.id, slot, diedAt: 0, pos: fresh.pos });
      }
      zone.slotReadyAt[slot] = 0;
      placed++;
    }
    if (!placed) return 0;
    if (!before) {
      const summary = zone.npcs.map((n) => `${n.baseDesc} x${n.count}`).join(", ");
      const layout = zone.spread !== 0 && zone.spots ? "navmesh" : "rings";
      this.log(`NpcSpawnSystem: '${zone.name}' spawned ${zone.spawned.length}/${zone.total} npc(s) (${layout}): ${summary}`);
    }
    this.saveSpawns();
    return placed;
  }

  private spawnOne(mp: Mp, zone: Zone, npc: ZoneNpc, slot: number, anchorId: number): { id: number; pos: number[] } | null {
    try {
      const pos = this.pickPos(mp, zone, slot, this.spotKind(mp, npc.baseDesc));
      const loc = { cellOrWorldDesc: zone.cellOrWorldDesc, pos, rot: [0, 0, 0] };
      const id = placeNpc(mp, anchorId, npc.baseDesc, loc);
      try { mp.set(id, TAG_PROP, zone.name); } catch { }
      try { mp.set(id, HOSTILE_PROP, this.isHostileBase(mp, npc.baseDesc)); } catch { }
      return { id, pos };
    } catch (e) {
      this.log(`NpcSpawnSystem: '${zone.name}' failed to spawn ${npc.baseDesc}: ${e}`);
      return null;
    }
  }

  private hostileByBase = new Map<string, boolean>();
  private kindByBase = new Map<string, SpotKind>();

  private isHostileBase(mp: Mp, baseDesc: string): boolean {
    let hostile = this.hostileByBase.get(baseDesc);
    if (hostile === undefined) {
      try { hostile = this.anyNpc(mp, mp.getIdFromDesc(baseDesc) >>> 0, TEMPLATE_USE_AI_DATA, (_res, fields) => this.aiDataHostile(fields)); } catch { hostile = false; }
      this.hostileByBase.set(baseDesc, hostile);
    }
    return hostile;
  }

  // Races that swim but cannot walk stand on water; large and extra large races skip navmesh marked for no large creatures
  private spotKind(mp: Mp, baseDesc: string): SpotKind {
    let kind = this.kindByBase.get(baseDesc);
    if (kind === undefined) {
      kind = "land";
      try {
        const id = mp.getIdFromDesc(baseDesc) >>> 0;
        const race = (test: (data: DataView) => boolean) => this.anyNpc(mp, id, TEMPLATE_USE_TRAITS, (res) => {
          const data = this.raceData(mp, res);
          return !!data && test(data);
        });
        if (race((data) => (data.getUint32(RACE_FLAGS_OFFSET, true) & (RACE_SWIMS | RACE_WALKS)) === RACE_SWIMS)) kind = "water";
        else if (race((data) => data.getUint32(RACE_SIZE_OFFSET, true) >= RACE_SIZE_LARGE)) kind = "large";
      } catch { }
      this.kindByBase.set(baseDesc, kind);
    }
    return kind;
  }

  private raceData(mp: Mp, npc: any): DataView | null {
    const raceId = espmFieldFormIds(npc, "RNAM")[0];
    const fields: any[] = (raceId && mp.lookupEspmRecordById(raceId)?.record?.fields) || [];
    const data = fields.find((f) => f?.type === "DATA" && f.data instanceof Uint8Array)?.data;
    return data && data.byteLength >= RACE_SIZE_OFFSET + 4 ? view(data) : null;
  }

  // True when test holds for an NPC_ the base resolves to, following leveled list entries and TPLT templates that supply templateFlag
  private anyNpc(mp: Mp, formId: number, templateFlag: number, test: (res: any, fields: EspmField[]) => boolean, depth = 0): boolean {
    const res = mp.lookupEspmRecordById(formId);
    const rec = res?.record;
    if (!rec || depth > MAX_TEMPLATE_DEPTH) return false;
    const fields: EspmField[] = (rec.fields || []).filter((f: any) => f && f.data instanceof Uint8Array);
    if (rec.type === "LVLN") {
      // LVLO: level, padding, then the entry's form id
      const entries: number[] = [];
      for (const f of fields) {
        if (f.type !== "LVLO" || f.data.byteLength < 8) continue;
        try { entries.push(res.toGlobalRecordId(view(f.data).getUint32(4, true)) >>> 0); } catch { }
      }
      return entries.some((id) => this.anyNpc(mp, id, templateFlag, test, depth + 1));
    }
    if (rec.type !== "NPC_") return false;
    const acbs = fields.find((f) => f.type === "ACBS")?.data;
    const templateFlags = acbs && acbs.byteLength >= 20 ? view(acbs).getUint16(18, true) : 0;
    const template = templateFlags & templateFlag ? espmFieldFormIds(res, "TPLT")[0] : 0;
    if (template) return this.anyNpc(mp, template, templateFlag, test, depth + 1);
    return test(res, fields);
  }

  // Vanilla attacks-on-sight test from AIDT: aggressive, or an aggro radius on a creature that is not cowardly
  private aiDataHostile(fields: EspmField[]): boolean {
    const aidt = fields.find((f) => f.type === "AIDT")?.data;
    if (!aidt || aidt.byteLength < 20) return false;
    const [aggression, confidence] = [aidt[0], aidt[1]];
    const aggroRadius = aidt[6] !== 0 && view(aidt).getUint32(16, true) > 0;
    return aggression >= 1 || (aggroRadius && confidence >= 1);
  }

  // Slot 0 stands on POS, the rest fill rings of 6, 12, 18... SLOT_SPACING apart so no two spawn inside each other
  private slotPos(zone: Zone, slot: number): number[] {
    let ring = 0;
    let first = 0;
    const ringSize = (r: number) => Math.max(1, 6 * r);
    while (slot >= first + ringSize(ring)) {
      first += ringSize(ring);
      ring++;
    }
    const size = Math.min(ringSize(ring), zone.total - first);
    const angle = (2 * Math.PI * (slot - first)) / size;
    const radius = ring * SLOT_SPACING;
    return [zone.pos[0] + radius * Math.cos(angle), zone.pos[1] + radius * Math.sin(angle), zone.pos[2] + SPAWN_LIFT];
  }

  // Random navmesh spot within reach of POS; SLOT_SPACING from living NPCs counts before PLAYER_CLEARANCE, and the best try wins when none fits both
  private pickPos(mp: Mp, zone: Zone, slot: number, kind: SpotKind): number[] {
    if (zone.spread === 0 || !zone.spots) return this.slotPos(zone, slot);
    const reach = zone.spread || zone.radius;
    const taken = zone.spawned.filter((e) => e.id && !e.diedAt).map((e) => e.pos);
    const players = this.playerPositions(mp, zone);
    let best: number[] | null = null;
    let bestScore = -1;
    for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
      const spot = randomPointOn(zone.spots, kind);
      if (!spot || distance(spot, zone.pos) > reach) continue;
      spot[2] += SPAWN_LIFT;
      const spaced = taken.every((t) => distance(t, spot) >= SLOT_SPACING);
      const clear = Math.min(PLAYER_CLEARANCE, ...players.map((p) => distance(p, spot)));
      const score = (spaced ? PLAYER_CLEARANCE + 1 : 0) + clear;
      if (score > bestScore) [best, bestScore] = [spot, score];
      if (spaced && clear >= PLAYER_CLEARANCE) break;
    }
    return best ?? this.slotPos(zone, slot);
  }

  // Every online player in the zone's cell or worldspace, admins included
  private playerPositions(mp: Mp, zone: Zone): number[][] {
    let ids: number[] = [];
    try { ids = mp.get(0, "onlinePlayers") ?? []; } catch { }
    const out: number[][] = [];
    for (const id of ids) {
      try { if (mp.getActorCellOrWorld(id) === zone.cellOrWorldId) out.push(mp.getActorPos(id)); } catch { }
    }
    return out;
  }

  // A death starts the slot's Respawn cooldown and the corpse's own removal timer
  private checkDeaths(mp: Mp, zone: Zone, now: number): void {
    for (const entry of zone.spawned) {
      if (entry.diedAt) continue;
      let dead = false;
      let gone = false;
      // A throw means the form is gone, which counts as dead
      try { dead = mp.get(entry.id, "isDead") === true; } catch { dead = gone = true; }
      if (!dead) continue;
      entry.diedAt = now;
      zone.slotReadyAt[entry.slot] = zone.respawnSeconds > 0 ? now + zone.respawnSeconds * 1000 : NEVER_READY;
      if (!gone) this.corpses.set(entry.id, now + this.corpseMs);
    }
  }

  // A corpse is left to its timer unless forced (admin reset); a death the poll has not seen yet starts its timer here
  private removeNpc(mp: Mp, id: number, force = false): void {
    if (!id) return;
    if (!force && !this.corpses.has(id)) {
      let dead = false;
      try { dead = mp.get(id, "isDead") === true; } catch { }
      if (dead) this.corpses.set(id, Date.now() + this.corpseMs);
    }
    if (!force && this.corpses.has(id)) return;
    this.corpses.delete(id);
    try { mp.destroyActor(id); } catch { }
  }

  private sweepCorpses(mp: Mp, now: number): void {
    let removed = 0;
    for (const [id, at] of Array.from(this.corpses)) {
      if (at > now) continue;
      this.corpses.delete(id);
      try { mp.destroyActor(id); } catch { }
      // The slot keeps its entry and cooldown; id 0 marks its corpse as gone
      for (const zone of this.zones) {
        for (const entry of zone.spawned) {
          if (entry.id === id) entry.id = 0;
        }
      }
      removed++;
    }
    if (!removed) return;
    this.log(`NpcSpawnSystem: removed ${removed} corpse(s) ${this.corpseMs / 1000} s after death`);
    this.saveSpawns();
  }

  // Cooldowns still running survive the despawn so leaving and coming back cannot skip Respawn; reset clears them and the corpses
  private despawn(mp: Mp, zone: Zone, reset = false): void {
    for (const entry of zone.spawned) {
      this.removeNpc(mp, entry.id, reset);
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

  // Spawned NPCs persist in the world DB, so ids from a previous run are read on boot and destroyed instead of leaking forever
  private cleanupLeftovers(_mp: Mp): void {
    let ids: unknown = [];
    try { ids = JSON.parse(fs.readFileSync(SPAWNS_FILE, "utf8")); } catch { }
    this.leftovers = Array.isArray(ids) ? ids.map((id) => Number(id) >>> 0).filter((id) => id > 0) : [];
  }

  // Saved forms load in attachSaveStorage after every system's init; NPCs this run placed are never touched
  private removeLeftovers(): void {
    const current = new Set(this.zones.flatMap((z) => z.spawned.map((e) => e.id)));
    const ids = this.leftovers.filter((id) => !current.has(id));
    this.leftovers = [];
    if (ids.length) {
      const removed = destroyLeftovers(this.mp, ids, (id) => !!this.mp.get(id, TAG_PROP));
      this.log(`NpcSpawnSystem: removed ${removed}/${ids.length} leftover npc(s) from the previous run`);
    }
    this.saveSpawns();
  }

  private saveSpawns(): void {
    const placed = this.zones.flatMap((z) => z.spawned.map((e) => e.id));
    const ids = Array.from(new Set([...placed, ...this.corpses.keys()])).filter((id) => id > 0);
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

  // Living zone NPCs, for the hosting audit
  liveNpcs(): Hostable[] {
    return this.zones.flatMap((z) => z.spawned.filter((e) => e.id && !e.diedAt).map((e) => ({ id: e.id })));
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
      Spread: draft.spread,
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

  // Places every slot without a living NPC now, cooldowns ignored; with nobody inside the admin anchors PlaceAtMe and the Despawn timer applies
  activateZone(name: string, adminActorId: number): number | null {
    const zone = this.findZone(name);
    return zone ? this.fillSlots(this.mp, zone, Date.now(), true, adminActorId) : null;
  }

  // Despawns the zone and starts every slot's Respawn cooldown as if its NPC had just been killed
  deactivateZone(name: string): boolean {
    const zone = this.findZone(name);
    if (!zone) return false;
    this.despawn(this.mp, zone);
    const until = zone.respawnSeconds > 0 ? Date.now() + zone.respawnSeconds * 1000 : NEVER_READY;
    zone.slotReadyAt = zone.slotReadyAt.map((at) => (until < 0 ? NEVER_READY : Math.max(at, until)));
    return true;
  }

  teleportTarget(name: string): { cellOrWorldDesc: string; pos: number[] } | null {
    const zone = this.findZone(name);
    return zone ? { cellOrWorldDesc: zone.cellOrWorldDesc, pos: zone.pos } : null;
  }
}
