import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Game time is this box's local wall clock plus three hours at 1:1; the client applies it to the calendar globals.
// Pushed on connect, on request, every minute against client clock drift, and within one poll of a UTC offset change.
//
//   Server -> Client: { customPacketType: "gameTime", serverTime, tzOffsetMin, year, timeScale }  serverTime: epoch ms, tzOffsetMin: Date.getTimezoneOffset()
//   Client -> Server: { customPacketType: "gameTimeRequest" }
//
// server-settings.json keys:
//   gameYear  in-game year of every date, never rolls over (default 210)

const DEFAULT_YEAR = 210;
const TIME_SCALE = 1;
const TIME_OFFSET_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 5000;
const BROADCAST_MS = 60000;
const MAX_USER_SLOTS = 1024;

export class TimeSystem implements System {
  systemName = "TimeSystem";
  constructor(private log: Log) { }

  private year = DEFAULT_YEAR;
  private tzOffsetMin = new Date().getTimezoneOffset();
  private nextBroadcastAt = 0;

  async initAsync(): Promise<void> {
    const all = (await Settings.get()).allSettings as Record<string, any> | null;
    const year = Number(all?.["gameYear"]);
    if (Number.isInteger(year) && year > 0) this.year = year;
    this.log(`TimeSystem: game time follows ${new Date(Date.now() + TIME_OFFSET_MS).toString()}, year ${this.year}, timescale ${TIME_SCALE}`);
  }

  connect(userId: number, ctx: SystemContext): void {
    this.send(ctx.svr, userId);
  }

  customPacket(userId: number, type: string, _content: Content, ctx: SystemContext): void {
    if (type === "gameTimeRequest") this.send(ctx.svr, userId);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const tz = new Date().getTimezoneOffset();
    const now = Date.now();
    if (tz === this.tzOffsetMin && now < this.nextBroadcastAt) return;
    if (tz !== this.tzOffsetMin) this.log(`TimeSystem: UTC offset changed from ${-this.tzOffsetMin} to ${-tz} min, resyncing clients`);
    this.tzOffsetMin = tz;
    this.nextBroadcastAt = now + BROADCAST_MS;
    const mp = ctx.svr as Mp;
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (mp.isConnected(userId)) this.send(mp, userId); } catch { /* slot gone */ }
    }
  }

  private send(mp: Mp, userId: number): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "gameTime",
        serverTime: Date.now() + TIME_OFFSET_MS,
        tzOffsetMin: new Date().getTimezoneOffset(),
        year: this.year,
        timeScale: TIME_SCALE,
      }));
    } catch { /* user gone */ }
  }
}
