import { System, Log, SystemContext } from "./system";
import { Settings } from "../settings";
import { BleedoutSystem } from "./bleedoutSystem";
import { hex, isAlive, notifyActor } from "./actorUtil";
import { DEFAULT_START_LOCATIONS, parseStartLocations } from "./startLocations";
import { Locational, loadWorldBorders, outsideBorderAt, noteInside, insideSpot } from "./worldBorder";
import { every } from "./timers";
import { onlineSnapshot } from "./onlineSnapshot";
import { formIdFromConfig } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// A fall below the floor of a space is a death, and a player outside the border of their worldspace is put back inside

const POLL_MS = 500;

// Lowest legitimate Z per worldspace or cell; Tamriel's terrain bottoms out near -37000, every other space found stays above -16000
const FLOORS: Record<string, number> = { "3c:Skyrim.esm": -40000 };
const DEFAULT_FLOOR = -30000;

export class WorldFloorSystem implements System {
  systemName = "WorldFloorSystem";

  constructor(private log: Log, private bleedout: BleedoutSystem) { }

  // Players it returns true for may stay outside the border
  exempt: ((mp: Mp, actorId: number) => boolean) | null = null;

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    this.floors = new Map(Object.entries(FLOORS).map(([desc, z]) => [formIdFromConfig(this.mp, desc), z]));
    const s = await Settings.get();
    const parsed = parseStartLocations(s.allSettings?.["startLocations"]);
    if (parsed?.length) this.starts = parsed;
    await loadWorldBorders(this.mp, s.dataDir, s.loadOrder, (line) => this.log(line))
      .catch((e) => this.log(`[border] scan failed, no server-side border: ${e}`));
    every("worldFloor", POLL_MS, () => this.poll());
  }

  // Only a player the snapshot shows below the floor or outside the border is read live and judged
  poll(): void {
    const mp = this.mp;
    const online = onlineSnapshot(mp).byActor;
    for (const id of this.outside) if (!online.has(id)) this.outside.delete(id);
    for (const { actorId, cell, pos } of online.values()) {
      try {
        if (!cell || this.settled(actorId, cell, pos) || !isAlive(mp, actorId)) continue;
        const loc = mp.get(actorId, "locationalData");
        if (!loc || !Array.isArray(loc.pos)) continue;
        const world = formIdFromConfig(mp, String(loc.cellOrWorldDesc));
        if (this.settled(actorId, world, loc.pos)) continue;
        const z = Number(loc.pos[2]);
        if (this.belowFloor(world, z)) {
          this.log(`[floor] ${hex(actorId)} at z ${Math.round(z)} in ${loc.cellOrWorldDesc}`);
          this.bleedout.die(actorId, "fell out of the world");
          continue;
        }
        this.checkBorder(mp, actorId, loc);
      } catch (e) {
        this.log(`[floor] check of ${hex(actorId)} failed: ${e}`);
      }
    }
  }

  // Above the floor and inside the border, which records the spot as the last one inside
  private settled(actorId: number, world: number, pos: readonly number[]): boolean {
    if (this.belowFloor(world, Number(pos[2])) || outsideBorderAt(world, pos)) return false;
    noteInside(actorId, world, pos);
    this.outside.delete(actorId);
    return true;
  }

  private belowFloor(world: number, z: number): boolean {
    return z < (this.floors.get(world) ?? DEFAULT_FLOOR);
  }

  // A single poll at the wall is ignored, so pressing into the vanilla border never pulls anyone back
  private checkBorder(mp: Mp, actorId: number, loc: Locational): void {
    if (this.exempt?.(mp, actorId)) return;
    if (!this.outside.has(actorId)) {
      this.outside.add(actorId);
      return;
    }
    const spot = insideSpot(mp, actorId, loc, this.starts);
    if (!spot) return;
    this.log(`[border] ${hex(actorId)} outside the border at ${Math.round(loc.pos[0])},${Math.round(loc.pos[1])} in ${loc.cellOrWorldDesc}, back to ${spot.pos.map(Math.round).join(",")}`);
    mp.set(actorId, "locationalData", spot);
    notifyActor(mp, actorId, "You cannot go that way.");
    this.outside.delete(actorId);
  }

  private mp: Mp = null;
  // Floors by worldspace or cell id
  private floors = new Map<number, number>();
  private outside = new Set<number>();
  private starts = DEFAULT_START_LOCATIONS;
}
