import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { kickWithReason } from "./kickUtil";
import { userSlotCount, isCreationPending, chainMpHook, userOf, hex } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// AFK autokick. Active = a move past MOVE_UNITS or a turn past TURN_DEGREES since the last counted sample (movement packets
// never reach TS, so position polling stands in), a CustomPacket the client only sends on a key press or a menu click
// (ACTIVE_PACKET_TYPES), a chat line, a craft, or an activation of a new target. Everything the client sends on its own
// (seat claims, craft reports, weather, needs, time, admin, mastery, faction and debug requests, teleport reports, anim
// results, knowledge) counts for nothing, and neither does the drift of a looped animation: while the client holds a seat
// claim (crafting stations, chopping blocks, mining markers, chairs) the position is not compared at all.
// Kick leaves the body enabled so the normal logout grace parks it.
//
// server-settings.json keys:
//   afkKickMinutes  minutes of inactivity before the kick, 0 disables (default 20)
//   afkWarnMinutes  minutes before the kick to warn the player (default 1)
//   afkDebug        true logs what keeps a user alive once they have been idle DEBUG_AFTER_MS, and the last channel on the kick line (default false)

const POLL_MS = 15000;
// Less than this since the last counted sample is jitter, a snap or a looped animation, not a player
const MOVE_UNITS = 32;
const TURN_DEGREES = 10;
// A seat claim whose holder stands this far from where they sat is over (FurnitureSeatSystem's own rule)
const LEFT_SEAT_DISTANCE = 48;
const DEBUG_AFTER_MS = 10 * 60000;
// A second activation of the same target this soon is a client loop, not a player pressing E again
const ACTIVATE_REPEAT_MS = 2000;
// The chat line arrives without a customPacketType (index.ts reads it as "undefined") and names itself in content.type
const CHAT_PACKET_TYPE = "cef::chat:send";

// Packets the client sends only on a key press or a menu click
const ACTIVE_PACKET_TYPES = new Set([
  "afkPing", "adminAction",
  "tradeRequest", "tradeRespond", "tradeSetOffer", "tradeLock", "tradeUnlock", "tradeAccept", "tradeCancel",
  "propertyRequest", "propertyInfoRequest", "petRequest", "companionCommand", "jobStart", "jobPutDown",
  "bountyBoardOpenRequest", "bountyBoardPost", "bountyBoardRemove", "bountyBoardManage", "bountyBoardClose",
  "writingCreate", "writingSave", "writingUse", "writingFinish", "writingSeal", "writingBreak", "writingCopy", "writingBurn", "writingOpen", "writingClose",
  "searchRequest", "searchConsentResult", "searchEnd", "introduceRequest",
  "captureRequest", "carryRequest", "releaseRequest", "putdownRequest", "captureConsentResult",
  "givePotionRequest", "finishOffRequest", "prepareExecutionRequest", "executeRequest", "assassinateRequest", "factionRecruitRequest",
  "deathChoice", "charCreatorResult", "characterSelectResult", "characterSelectMenuRequest",
  "masteryChoose", "masteryResetRequest", "factionRequest", "playerMenuRequest", "loadDoorQuery",
]);

interface Location {
  cell: string;
  pos: number[];
  yaw: number;
}

interface AfkState {
  lastActivity: number;
  // What last counted as activity, for afkDebug and the kick line
  lastChannel: string;
  // The location the last counted move was measured from
  last: Location | null;
  // Where the actor sat when the client claimed a seat, null once released or left
  seat: { furniture: number; pos: number[] } | null;
  lastActivate: { target: number; at: number };
  warned: boolean;
}

const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// Smallest angle between two headings in degrees
const turn = (a: number, b: number): number => Math.abs(((a - b) % 360 + 540) % 360 - 180);

export class AfkSystem implements System {
  systemName = "AfkSystem";
  constructor(private log: Log) { }

  private kickMs = 20 * 60 * 1000;
  private warnMs = 1 * 60 * 1000;
  private debug = false;
  private states = new Map<number, AfkState>();
  private mp: Mp = null;

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const kickMinutes = Number(all?.["afkKickMinutes"]);
    if (Number.isFinite(kickMinutes) && kickMinutes >= 0) this.kickMs = kickMinutes * 60 * 1000;
    const warnMinutes = Number(all?.["afkWarnMinutes"]);
    if (Number.isFinite(warnMinutes) && warnMinutes > 0) this.warnMs = warnMinutes * 60 * 1000;
    this.debug = all?.["afkDebug"] === true;
    this.mp = ctx.svr as Mp;
    chainMpHook(this.mp, "onCraft", (actorId: number) => this.touchActor(Number(actorId) >>> 0, "craft"));
    chainMpHook(this.mp, "onActivate", (targetId: number, casterId: number) => this.onActivate(Number(targetId) >>> 0, Number(casterId) >>> 0));
    this.log(this.kickMs
      ? `AfkSystem: kicking after ${this.kickMs / 60000} min, warning ${this.warnMs / 60000} min before, a move of ${MOVE_UNITS} units or ${TURN_DEGREES} degrees, a click-driven packet, a chat line, a craft or an activation counts${this.debug ? ", afkDebug on" : ""}`
      : "AfkSystem: disabled (afkKickMinutes is 0)");
  }

  connect(userId: number): void {
    this.states.set(userId, { lastActivity: Date.now(), lastChannel: "connect", last: null, seat: null, lastActivate: { target: 0, at: 0 }, warned: false });
  }

  disconnect(userId: number): void {
    this.states.delete(userId);
  }

  customPacket(userId: number, type: string, content: Content): void {
    const state = this.states.get(userId);
    if (!state) return;
    if (type === "seatClaim") {
      state.seat = this.seatOf(userId, Number(content["furniture"]) >>> 0);
      return;
    }
    if (type === "seatRelease") {
      state.seat = null;
      return;
    }
    if (ACTIVE_PACKET_TYPES.has(type)) this.touch(userId, type);
    else if (type === "undefined" && content["type"] === CHAT_PACKET_TYPE) this.touch(userId, "chat");
  }

  private seatOf(userId: number, furniture: number): AfkState["seat"] {
    try {
      const pos = this.mp.get(this.mp.getUserActor(userId), "pos");
      return Array.isArray(pos) ? { furniture, pos: pos.map(Number) } : null;
    } catch {
      return null;
    }
  }

  private onActivate(targetId: number, casterId: number): void {
    const userId = userOf(this.mp, casterId);
    const state = userId >= 0 ? this.states.get(userId) : undefined;
    if (!state) return;
    const now = Date.now();
    if (state.lastActivate.target === targetId && now - state.lastActivate.at < ACTIVATE_REPEAT_MS) return;
    state.lastActivate = { target: targetId, at: now };
    this.touch(userId, `activate ${hex(targetId)}`);
  }

  private touchActor(actorId: number, channel: string): void {
    const userId = userOf(this.mp, actorId);
    if (userId >= 0) this.touch(userId, channel);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const mp = ctx.svr as Mp;
    const now = Date.now();

    for (let userId = 0; userId < userSlotCount(); userId++) {
      try { if (!mp.isConnected(userId)) continue; } catch { continue; }
      const state = this.states.get(userId);
      if (!state) continue;

      let actorId = 0;
      try { actorId = mp.getUserActor(userId); } catch { }
      if (!actorId || isCreationPending(mp, actorId)) {
        // Login, character select and character creation have their own pacing
        this.touch(userId, "menu");
        continue;
      }

      const loc = this.readLocation(mp, actorId);
      if (loc) {
        const moved = this.movement(state, loc);
        if (moved) {
          state.last = loc;
          this.touch(userId, moved);
          continue;
        }
        if (!state.last) state.last = loc;
      }

      if (!this.kickMs) continue;
      const idleMs = now - state.lastActivity;
      if (idleMs >= this.kickMs) {
        this.log(`AfkSystem: kicking user ${userId} (actor ${hex(actorId)}) after ${Math.round(idleMs / 60000)} min idle, last activity ${state.lastChannel} at ${new Date(state.lastActivity).toISOString().slice(11, 19)}${state.seat ? `, seated at ${hex(state.seat.furniture)}` : ""}`);
        try {
          kickWithReason(mp, userId, `You were disconnected after ${Math.round(this.kickMs / 60000)} minutes of inactivity.`);
        } catch (e) { this.log(`AfkSystem: kick failed: ${e}`); }
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

  // The move that counts since the last counted sample, "" for none; a held seat claim stands in for the animation's drift until the actor leaves it
  private movement(state: AfkState, loc: Location): string {
    if (state.seat) {
      if (distance(loc.pos, state.seat.pos) <= LEFT_SEAT_DISTANCE) return "";
      state.seat = null;
    }
    if (!state.last) return "";
    if (loc.cell !== state.last.cell) return "cell change";
    const units = distance(loc.pos, state.last.pos);
    if (units >= MOVE_UNITS) return `move ${Math.round(units)} units`;
    const degrees = turn(loc.yaw, state.last.yaw);
    return degrees >= TURN_DEGREES ? `turn ${Math.round(degrees)} degrees` : "";
  }

  private readLocation(mp: Mp, actorId: number): Location | null {
    try {
      const loc = mp.get(actorId, "locationalData");
      if (!loc || !Array.isArray(loc.pos) || loc.pos.length < 3) return null;
      const rot = Array.isArray(loc.rot) ? loc.rot : [0, 0, 0];
      return { cell: String(loc.cellOrWorldDesc), pos: loc.pos.map(Number), yaw: Number(rot[2]) || 0 };
    } catch {
      return null;
    }
  }

  private touch(userId: number, channel: string): void {
    const state = this.states.get(userId);
    if (!state) return;
    const now = Date.now();
    if (this.debug && now - state.lastActivity >= DEBUG_AFTER_MS) {
      let actorId = 0;
      try { actorId = this.mp.getUserActor(userId); } catch { }
      this.log(`AfkSystem: user ${userId} (actor ${hex(actorId)}) kept alive after ${Math.round((now - state.lastActivity) / 60000)} min by ${channel}`);
    }
    state.lastActivity = now;
    state.lastChannel = channel;
    state.warned = false;
  }
}
