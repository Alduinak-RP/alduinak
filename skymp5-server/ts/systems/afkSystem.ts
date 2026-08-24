import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// AFK autokick. Active = locationalData changed or any player-driven CustomPacket; movement packets never reach TS, so position polling stands in.
// Kick uses svr.kick alone so the normal logout grace parks the body.
//
// server-settings.json keys:
//   afkKickMinutes  minutes of inactivity before the kick, 0 disables (default 20)
//   afkWarnMinutes  minutes before the kick to warn the player (default 2)

const POLL_MS = 30000;
const MAX_USER_SLOTS = 1024;

// Automatic client packets that fire without player input
const IDLE_PACKET_TYPES = new Set(["voiceTokenRequest"]);

interface AfkState {
  lastActivity: number;
  lastSample: string;
  warned: boolean;
}

export class AfkSystem implements System {
  systemName = "AfkSystem";
  constructor(private log: Log) { }

  private kickMs = 20 * 60 * 1000;
  private warnMs = 2 * 60 * 1000;
  private states = new Map<number, AfkState>();
  private nextPollAt = 0;

  async initAsync(): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const kickMinutes = Number(all?.["afkKickMinutes"]);
    if (Number.isFinite(kickMinutes) && kickMinutes >= 0) this.kickMs = kickMinutes * 60 * 1000;
    const warnMinutes = Number(all?.["afkWarnMinutes"]);
    if (Number.isFinite(warnMinutes) && warnMinutes > 0) this.warnMs = warnMinutes * 60 * 1000;
    this.log(this.kickMs
      ? `AfkSystem: kicking after ${this.kickMs / 60000} min, warning ${this.warnMs / 60000} min before`
      : "AfkSystem: disabled (afkKickMinutes is 0)");
  }

  // Milliseconds since this user last did something. Other systems (mastery
  // playtime) reuse this rather than sampling position a second time.
  idleMsOf(userId: number): number {
    const st = this.states.get(userId);
    return st ? Date.now() - st.lastActivity : 0;
  }

  connect(userId: number): void {
    this.states.set(userId, { lastActivity: Date.now(), lastSample: "", warned: false });
  }

  disconnect(userId: number): void {
    this.states.delete(userId);
  }

  customPacket(userId: number, type: string, _content: Content): void {
    if (IDLE_PACKET_TYPES.has(type)) return;
    this.touch(userId);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const mp = ctx.svr as Mp;
    const now = Date.now();

    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (!mp.isConnected(userId)) continue; } catch { continue; }
      const state = this.states.get(userId);
      if (!state) continue;

      let actorId = 0;
      try { actorId = mp.getUserActor(userId); } catch { }
      if (!actorId) {
        // Login/character select flows have their own pacing
        this.touch(userId);
        continue;
      }

      const sample = this.sampleLocation(mp, actorId);
      if (sample && sample !== state.lastSample) {
        state.lastSample = sample;
        this.touch(userId);
        continue;
      }

      const idleMs = now - state.lastActivity;
      // The idle clock keeps running with kicking off: MasterySystem reads it.
      if (!this.kickMs) continue;
      if (idleMs >= this.kickMs) {
        this.log(`AfkSystem: kicking user ${userId} (actor ${actorId.toString(16)}) after ${Math.round(idleMs / 60000)} min idle`);
        try { mp.kick(userId); } catch (e) { this.log(`AfkSystem: kick failed: ${e}`); }
      } else if (!state.warned && idleMs >= this.kickMs - this.warnMs) {
        state.warned = true;
        const minutesLeft = Math.max(1, Math.round((this.kickMs - idleMs) / 60000));
        try {
          mp.sendCustomPacket(userId, JSON.stringify({
            customPacketType: "notification",
            text: `You will be kicked for inactivity in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}. Move or chat to stay connected.`,
          }));
        } catch { }
      }
    }
  }

  // Rounded so physics micro-jitter does not count as movement
  private sampleLocation(mp: Mp, actorId: number): string {
    try {
      const loc = mp.get(actorId, "locationalData");
      if (!loc) return "";
      const pos = Array.isArray(loc.pos) ? loc.pos.map(Math.round) : [];
      const rot = Array.isArray(loc.rot) ? loc.rot.map(Math.round) : [];
      return JSON.stringify([loc.cellOrWorldDesc, pos, rot]);
    } catch {
      return "";
    }
  }

  private touch(userId: number): void {
    const state = this.states.get(userId);
    if (!state) return;
    state.lastActivity = Date.now();
    state.warned = false;
  }
}
