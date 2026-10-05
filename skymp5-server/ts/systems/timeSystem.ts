import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { connectedUsers } from "./actorUtil";
import { every } from "./timers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Game time is this box's local wall clock plus three hours at 1:1; the client applies it to the calendar globals.
// Pushed on connect, on request, every minute against client clock drift, and within one poll of a UTC offset change.
//
//   Server -> Client: { customPacketType: "gameTime", serverTime, tzOffsetMin, year, timeScale }  serverTime: epoch ms, tzOffsetMin: Date.getTimezoneOffset()
//   Client -> Server: { customPacketType: "gameTimeRequest" }
//
// server-settings.json keys:
//   gameYear             in-game year of every date, never rolls over (default 210)
//   gameTimeOffsetHours  hours the game clock runs ahead of the box clock (default 3, may be negative)

const DEFAULT_YEAR = 210;
const TIME_SCALE = 1;
const DEFAULT_OFFSET_HOURS = 3;
const POLL_MS = 5000;
const BROADCAST_MS = 60000;
const DAY_MS = 24 * 3600000;

let offsetMs = DEFAULT_OFFSET_HOURS * 60 * 60 * 1000;

// The clock every game-facing timestamp uses, so the Debug tab and the calendar never disagree
export const gameTimeNow = (): number => Date.now() + offsetMs;

// The hour of day, with fractions, the client calendar shows: the box's local wall clock of gameTimeNow
export const gameHourNow = (): number => {
  const local = gameTimeNow() - new Date().getTimezoneOffset() * 60000;
  return (((local % DAY_MS) + DAY_MS) % DAY_MS) / 3600000;
};

export class TimeSystem implements System {
  systemName = "TimeSystem";
  constructor(private log: Log) { }

  private year = DEFAULT_YEAR;
  private tzOffsetMin = new Date().getTimezoneOffset();
  private nextBroadcastAt = 0;

  async initAsync(ctx: SystemContext): Promise<void> {
    const all = (await Settings.get()).allSettings as Record<string, any> | null;
    const year = Number(all?.["gameYear"]);
    if (Number.isInteger(year) && year > 0) this.year = year;
    const hours = Number(all?.["gameTimeOffsetHours"]);
    if (Number.isFinite(hours) && Math.abs(hours) <= 24) offsetMs = hours * 60 * 60 * 1000;
    this.log(`TimeSystem: box clock ${new Date().toString()}, game time ${offsetMs / 3600000}h ahead, year ${this.year}, timescale ${TIME_SCALE}`);
    every("time", POLL_MS, () => this.poll(ctx));
  }

  connect(userId: number, ctx: SystemContext): void {
    this.send(ctx.svr, userId);
  }

  customPacket(userId: number, type: string, _content: Content, ctx: SystemContext): void {
    if (type === "gameTimeRequest") this.send(ctx.svr, userId);
  }

  poll(ctx: SystemContext): void {
    const tz = new Date().getTimezoneOffset();
    const now = Date.now();
    if (tz === this.tzOffsetMin && now < this.nextBroadcastAt) return;
    if (tz !== this.tzOffsetMin) this.log(`TimeSystem: UTC offset changed from ${-this.tzOffsetMin} to ${-tz} min, resyncing clients`);
    this.tzOffsetMin = tz;
    this.nextBroadcastAt = now + BROADCAST_MS;
    const mp = ctx.svr as Mp;
    for (const userId of connectedUsers()) {
      try { if (mp.isConnected(userId)) this.send(mp, userId); } catch { /* user gone */ }
    }
  }

  private send(mp: Mp, userId: number): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "gameTime",
        serverTime: gameTimeNow(),
        tzOffsetMin: new Date().getTimezoneOffset(),
        year: this.year,
        timeScale: TIME_SCALE,
      }));
    } catch { /* user gone */ }
  }
}
