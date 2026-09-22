import { System, Log, SystemContext } from "./system";
import { BleedoutSystem } from "./bleedoutSystem";
import { hex, isAlive, isPlayerActor } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// A player falling through a hole in the world dies once below the floor of its space and respawns in a temple, instead of falling again on every login

const POLL_MS = 500;

// Lowest legitimate Z per worldspace or cell; Tamriel's terrain bottoms out near -37000, every other space found stays above -16000
const FLOORS: Record<string, number> = { "3c:Skyrim.esm": -40000 };
const DEFAULT_FLOOR = -30000;

export class WorldFloorSystem implements System {
  systemName = "WorldFloorSystem";

  constructor(private log: Log, private bleedout: BleedoutSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
  }

  async updateAsync(): Promise<void> {
    const now = Date.now();
    if (now < this.nextPollAt) return;
    this.nextPollAt = now + POLL_MS;
    const mp = this.mp;
    let players: unknown[] = [];
    try { players = mp.get(0, "onlinePlayers") ?? []; } catch { return; }
    for (const raw of players) {
      const actorId = Number(raw) >>> 0;
      try {
        if (!isPlayerActor(mp, actorId) || !isAlive(mp, actorId)) continue;
        const loc = mp.get(actorId, "locationalData");
        if (!loc || !Array.isArray(loc.pos)) continue;
        const z = Number(loc.pos[2]);
        if (!(z < (FLOORS[String(loc.cellOrWorldDesc)] ?? DEFAULT_FLOOR))) continue;
        this.log(`[floor] ${hex(actorId)} at z ${Math.round(z)} in ${loc.cellOrWorldDesc}`);
        this.bleedout.die(actorId, "fell out of the world");
      } catch (e) {
        this.log(`[floor] check of ${hex(actorId)} failed: ${e}`);
      }
    }
  }

  private mp: Mp = null;
  private nextPollAt = 0;
}
