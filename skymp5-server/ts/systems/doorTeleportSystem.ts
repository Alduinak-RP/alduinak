import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { formIdFromConfig } from "./formIdUtil";
import { hex, userOf } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Door teleport overrides ───────────────────────────────────────────────────
//
// The engine never teleports through a load door here: the client blocks door
// activation and reports it, and the native server reads the door's XTEL,
// resolves the twin on the far side and sends the player there itself. A door
// whose vanilla pair misbehaves in game is redirected here instead, which needs
// no ESP rebuild.
//
// Overridable via "doorTeleportOverrides", one entry per door, replacing the
// defaults below; `[]` turns the system off. Docs in
// docs_server_configuration_reference.md.
//
//   "doorTeleportOverrides": [
//     { "door": "7C98E:Skyrim.esm", "cellOrWorldDesc": "3c:Skyrim.esm",
//       "pos": [-79858.25, 114377.65, -2273.45], "rot": [0, 0, 159.95] }
//   ]
//
// The hook is installed before every other system's, so it runs last in the
// activation chain: a door refused for a lock, a faction or a job never reaches
// it, and the native side has already refused a caster outside the door's cell.
// Only the connected player who pressed the door is moved; a pet or a companion
// following through keeps the native path.

// Thalmor Embassy party room, south west door: its pair leaves the player in the room, so it hands over to the courtyard outside the front door
const DEFAULT_OVERRIDES: Record<string, unknown>[] = [
  {
    door: "7C98E:Skyrim.esm",
    cellOrWorldDesc: "3c:Skyrim.esm",
    pos: [-79858.25, 114377.65, -2273.45],
    rot: [0, 0, 159.95],
  },
];

// A held activate key fires repeatedly; one move per player per second is plenty.
const MOVE_COOLDOWN_MS = 1000;

// Client teleport reports are logged at most this often per user
const LATE_REPORT_EVERY_MS = 30000;
const STUCK_REPORT_EVERY_MS = 10000;

interface DoorDestination {
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

const vec3 = (v: unknown, fallback: number[] | null = null): number[] | null => {
  if (!Array.isArray(v)) return fallback;
  const out = v.map(Number);
  return out.length === 3 && out.every(Number.isFinite) ? out : null;
};

export class DoorTeleportSystem implements System {
  systemName = "DoorTeleportSystem";

  constructor(private log: Log) { }

  private destinations = new Map<number, DoorDestination>();
  private lastMoveMs = new Map<number, number>();
  private lastLateReportMs = new Map<number, number>();
  private lastStuckReportMs = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const raw = ((await Settings.get()).allSettings as Record<string, unknown> | null)?.["doorTeleportOverrides"];
    const entries = Array.isArray(raw) ? raw : DEFAULT_OVERRIDES;
    for (const entry of entries as Record<string, unknown>[]) this.add(ctx.svr as Mp, entry);
    if (this.destinations.size === 0) {
      this.log("DoorTeleportSystem: no doors overridden");
      return;
    }
    this.installActivationHook(ctx);
    this.log(`DoorTeleportSystem: ${this.destinations.size} door(s) redirected`);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "teleportReport") return;
    const stuck = content.outcome === "stuck";
    const lastReportMs = stuck ? this.lastStuckReportMs : this.lastLateReportMs;
    const now = Date.now();
    if (now - (lastReportMs.get(userId) || 0) < (stuck ? STUCK_REPORT_EVERY_MS : LATE_REPORT_EVERY_MS)) return;
    lastReportMs.set(userId, now);
    let actorId = 0;
    let name = "";
    try {
      actorId = ctx.svr.getUserActor(userId);
      name = String(ctx.svr.getActorName(actorId) ?? "");
    } catch { /* no actor */ }
    const what = stuck ? "did not follow a teleport and was sent to character select" : "followed a teleport late";
    this.log(`[doors] ${hex(actorId)} (${name}) ${what}: target ${hex(Number(content.worldOrCell))}, client in ${hex(Number(content.clientWorldOrCell))}, ${Number(content.moves)} move(s), ragdoll wait ${content.ragdollReturned === false ? "failed or timed out" : "returned"}, race menu seen ${content.raceMenuSeen === true}, ${Number(content.sinceLoadS)} s since load`);
  }

  disconnect(userId: number): void {
    this.lastLateReportMs.delete(userId);
    this.lastStuckReportMs.delete(userId);
  }

  // An entry naming a door or a destination the load order has no form for is skipped and logged
  private add(mp: Mp, entry: Record<string, unknown>): void {
    const door = formIdFromConfig(mp, entry?.["door"]);
    const destination = formIdFromConfig(mp, entry?.["cellOrWorldDesc"]);
    const pos = vec3(entry?.["pos"]);
    const rot = vec3(entry?.["rot"], [0, 0, 0]);
    let cellOrWorldDesc = "";
    if (destination) {
      try { cellOrWorldDesc = String(mp.getDescFromId(destination)); } catch { /* not a loaded form */ }
    }
    if (!door || !cellOrWorldDesc || !pos || !rot) {
      this.log(`DoorTeleportSystem: skipped ${JSON.stringify(entry)}, needs door, cellOrWorldDesc and pos of three numbers`);
      return;
    }
    this.destinations.set(door, { cellOrWorldDesc, pos, rot });
  }

  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let allowed = true;
      if (previous) {
        try { allowed = previous.call(mp, targetId, casterId) !== false; } catch { allowed = true; }
      }
      if (!allowed) return false;
      let handled = false;
      try {
        handled = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[doors] override of ${hex(targetId >>> 0)} failed: ${e}`);
      }
      // The move replaces the door's own teleport, so the native path must not run as well
      return !handled;
    };
  }

  // True once the override has taken the activation over, move or no move
  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const destination = this.destinations.get(targetId);
    if (!destination) return false;
    const mp = ctx.svr as Mp;
    if (userOf(mp, casterId) < 0) return false;

    const now = Date.now();
    if (now - (this.lastMoveMs.get(casterId) || 0) < MOVE_COOLDOWN_MS) return true;
    this.lastMoveMs.set(casterId, now);

    mp.set(casterId, "locationalData", {
      cellOrWorldDesc: destination.cellOrWorldDesc,
      pos: destination.pos,
      rot: destination.rot,
    });
    this.log(`[doors] ${hex(casterId)} through ${hex(targetId)} to ${destination.cellOrWorldDesc} ${destination.pos.join(", ")}`);
    return true;
  }
}
