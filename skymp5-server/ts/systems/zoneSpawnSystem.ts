import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Configurable NPC spawn zones: a zone populates its NPCs (server-side PlaceAtMe) when a player enters the radius and despawns them after the zone stays empty.
// Spawned ids persist in a sidecar file so leftovers from a crash are removed on the next boot.
//
// server-settings.json:
//   "npcSpawnZones": [{
//     "name": "riverwood-bandits",
//     "cellOrWorldDesc": "3c:Skyrim.esm",
//     "pos": [x, y, z],
//     "radius": 2000,
//     "npcs": [{ "base": "39f67:Skyrim.esm", "count": 2, "pos": [x,y,z], "rot": [0,0,0] }],
//     "respawnSeconds": 600,
//     "despawnSeconds": 300
//   }]
// npc.base is a form desc "hexLocalId:Plugin.esp" or a hex id from the load order; npc.pos/rot default to the zone pos.
// respawnSeconds drives the engine spawnDelay of dead zone NPCs; despawnSeconds removes NPCs once no player is near (0 keeps them forever).

const POLL_MS = 2000;
const SPAWNS_FILE = "./zone-spawns.json";
const DESPAWN_HYSTERESIS = 1.5;

interface ZoneNpc {
  baseDesc: string;
  count: number;
  pos: number[] | null;
  rot: number[] | null;
}

interface Zone {
  name: string;
  cellOrWorldDesc: string;
  cellOrWorldId: number;
  pos: number[];
  radius: number;
  npcs: ZoneNpc[];
  respawnSeconds: number;
  despawnSeconds: number;
  spawnedIds: number[];
  emptySince: number;
}

export class ZoneSpawnSystem implements System {
  systemName = "ZoneSpawnSystem";
  constructor(private log: Log) { }

  private zones: Zone[] = [];
  private ready = false;

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const rawZones = all?.["npcSpawnZones"];
    if (Array.isArray(rawZones)) {
      for (const raw of rawZones) {
        const zone = this.parseZone(mp, raw);
        if (zone) this.zones.push(zone);
      }
    }
    this.cleanupLeftovers(mp);
    this.ready = true;
    this.log(`ZoneSpawnSystem: ${this.zones.length} zone(s) configured`);
  }

  private parseZone(mp: Mp, raw: any): Zone | null {
    try {
      const name = String(raw?.name ?? "");
      const cellOrWorldDesc = String(raw?.cellOrWorldDesc ?? "");
      const pos = Array.isArray(raw?.pos) ? raw.pos.map(Number) : null;
      const radius = Number(raw?.radius);
      if (!name || !cellOrWorldDesc || !pos || pos.length !== 3 || !(radius > 0)) {
        this.log(`ZoneSpawnSystem: zone '${name || "?"}' skipped, needs name/cellOrWorldDesc/pos/radius`);
        return null;
      }
      const npcs: ZoneNpc[] = [];
      for (const n of Array.isArray(raw?.npcs) ? raw.npcs : []) {
        const baseDesc = this.toFormDesc(mp, n?.base);
        if (!baseDesc) {
          this.log(`ZoneSpawnSystem: zone '${name}' npc base '${n?.base}' not resolvable, skipped`);
          continue;
        }
        npcs.push({
          baseDesc,
          count: Math.max(1, Math.min(20, Number(n?.count) || 1)),
          pos: Array.isArray(n?.pos) && n.pos.length === 3 ? n.pos.map(Number) : null,
          rot: Array.isArray(n?.rot) && n.rot.length === 3 ? n.rot.map(Number) : null,
        });
      }
      if (!npcs.length) {
        this.log(`ZoneSpawnSystem: zone '${name}' has no valid npcs, skipped`);
        return null;
      }
      return {
        name, cellOrWorldDesc, pos, radius, npcs,
        cellOrWorldId: mp.getIdFromDesc(cellOrWorldDesc),
        respawnSeconds: Number(raw?.respawnSeconds) > 0 ? Number(raw.respawnSeconds) : 600,
        despawnSeconds: Number(raw?.despawnSeconds) >= 0 ? Number(raw.despawnSeconds) : 300,
        spawnedIds: [],
        emptySince: 0,
      };
    } catch (e) {
      this.log(`ZoneSpawnSystem: bad zone entry skipped: ${e}`);
      return null;
    }
  }

  private toFormDesc(mp: Mp, base: unknown): string {
    const text = String(base ?? "").trim();
    if (!text) return "";
    if (text.includes(":")) return text;
    const id = parseInt(text, 16);
    if (!Number.isFinite(id) || id <= 0) return "";
    try { return mp.getDescFromId(id); } catch { return ""; }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.ready || !this.zones.length) return;
    const mp = ctx.svr as Mp;

    let playerIds: number[] = [];
    try { playerIds = mp.get(0, "onlinePlayers") ?? []; } catch { return; }
    const now = Date.now();

    for (const zone of this.zones) {
      const occupied = this.zoneOccupied(mp, zone, playerIds);
      if (occupied) {
        zone.emptySince = 0;
        if (!zone.spawnedIds.length) this.populate(mp, zone, playerIds);
      } else if (zone.spawnedIds.length && zone.despawnSeconds > 0) {
        if (!zone.emptySince) zone.emptySince = now;
        if (now - zone.emptySince >= zone.despawnSeconds * 1000) this.despawn(ctx, zone);
      }
    }
  }

  private zoneOccupied(mp: Mp, zone: Zone, playerIds: number[]): boolean {
    // Hysteresis keeps NPCs alive while players hover at the edge
    const reach = zone.spawnedIds.length ? zone.radius * DESPAWN_HYSTERESIS : zone.radius;
    for (const actorId of playerIds) {
      try {
        if (mp.getActorCellOrWorld(actorId) !== zone.cellOrWorldId) continue;
        const pos = mp.getActorPos(actorId);
        const dx = pos[0] - zone.pos[0];
        const dy = pos[1] - zone.pos[1];
        const dz = pos[2] - zone.pos[2];
        if (dx * dx + dy * dy + dz * dz <= reach * reach) return true;
      } catch { }
    }
    return false;
  }

  private populate(mp: Mp, zone: Zone, playerIds: number[]): void {
    // PlaceAtMe needs an existing ref as self; any online player works
    const anchorId = playerIds.find(id => {
      try { return typeof mp.getDescFromId(id) === "string"; } catch { return false; }
    });
    if (!anchorId) return;
    const self = { type: "form", desc: mp.getDescFromId(anchorId) };

    for (const npc of zone.npcs) {
      const loc = {
        cellOrWorldDesc: zone.cellOrWorldDesc,
        pos: npc.pos ?? zone.pos,
        rot: npc.rot ?? [0, 0, 0],
      };
      for (let i = 0; i < npc.count; i++) {
        try {
          const res = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
            self, [{ type: "espm", desc: npc.baseDesc }, 1, false, false]);
          if (!res?.desc) continue;
          const spawnedId = mp.getIdFromDesc(res.desc);
          mp.set(spawnedId, "locationalData", loc);
          mp.set(spawnedId, "spawnPoint", loc);
          mp.set(spawnedId, "spawnDelay", zone.respawnSeconds);
          zone.spawnedIds.push(spawnedId);
        } catch (e) {
          this.log(`ZoneSpawnSystem: spawn of ${npc.baseDesc} in '${zone.name}' failed: ${e}`);
        }
      }
    }
    this.log(`ZoneSpawnSystem: '${zone.name}' populated with ${zone.spawnedIds.length} npc(s)`);
    this.saveSpawns();
  }

  private despawn(ctx: SystemContext, zone: Zone): void {
    for (const id of zone.spawnedIds) {
      try { ctx.svr.destroyActor(id); } catch { }
    }
    this.log(`ZoneSpawnSystem: '${zone.name}' despawned ${zone.spawnedIds.length} npc(s)`);
    zone.spawnedIds = [];
    zone.emptySince = 0;
    this.saveSpawns();
  }

  // Zone NPCs persist in the world DB, so ids from a previous run are destroyed on boot instead of leaking forever
  private cleanupLeftovers(mp: Mp): void {
    let ids: number[] = [];
    try { ids = JSON.parse(fs.readFileSync(SPAWNS_FILE, "utf8")); } catch { }
    if (!Array.isArray(ids) || !ids.length) return;
    let removed = 0;
    for (const id of ids) {
      try { mp.destroyActor(Number(id)); removed++; } catch { }
    }
    this.log(`ZoneSpawnSystem: removed ${removed}/${ids.length} leftover npc(s) from the previous run`);
    this.saveSpawns();
  }

  private saveSpawns(): void {
    const ids = this.zones.flatMap(z => z.spawnedIds);
    try { fs.writeFileSync(SPAWNS_FILE, JSON.stringify(ids)); }
    catch (e) { this.log(`ZoneSpawnSystem: spawns file write failed: ${e}`); }
  }
}
