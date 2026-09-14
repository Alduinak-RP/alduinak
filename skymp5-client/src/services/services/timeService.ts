import { Menu, MenuOpenEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

// Game time is the server box's local wall clock at 1:1, taken from the server's gameTime packet (TimeSystem)

const GAME_YEAR = 0x35;
const GAME_MONTH = 0x36;
const GAME_DAY = 0x37;
const GAME_HOUR = 0x38;
const GAME_DAYS_PASSED = 0x39;
const TIME_SCALE = 0x3a;
const SYNC_MS = 2000;
const DAY_MS = 86400000;
const DEFAULT_YEAR = 226;
// About five real seconds
const MAX_DRIFT_HOURS = 5 / 3600;
// A Sunday, so floor(GameDaysPassed) % 7 is the real weekday (the engine counts Sundas as 0)
const DAYS_PASSED_EPOCH = Date.UTC(2026, 0, 4) / DAY_MS;

interface ServerClock {
  offsetMs: number;
  tzOffsetMin: number;
  year: number;
  timeScale: number;
}

export class TimeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    controller.on("update", () => this.onUpdate());
    controller.on("loadGame", () => this.onLoadGame());
    controller.on("menuOpen", (e) => this.onMenuOpen(e));
    controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  // The date's UTC fields read as the server's local wall clock
  public getTime() {
    const date = new Date(Date.now() + this.clock.offsetMs - this.clock.tzOffsetMin * 60000);
    return { newGameHourValue: (date.getTime() % DAY_MS) / 3600000, date };
  }

  public getLoadGameTime() {
    const { date } = this.getTime();
    return { hours: date.getUTCHours(), minutes: date.getUTCMinutes(), seconds: date.getUTCSeconds() };
  }

  // Natives throw in the packet-handler context, so only the clock is stored here
  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "gameTime") return;
    const serverTime = Number(content["serverTime"]);
    if (!Number.isFinite(serverTime)) return;
    this.clock = {
      offsetMs: serverTime - Date.now(),
      tzOffsetMin: Number(content["tzOffsetMin"]) || 0,
      year: Number(content["year"]) || DEFAULT_YEAR,
      timeScale: Number(content["timeScale"]) || 1,
    };
    this.nextSyncAt = 0;
  }

  // The template save carries its own calendar, so the first pass after a load replaces all of it
  private onLoadGame(): void {
    this.rebaseDaysPassed = true;
    this.nextSyncAt = 0;
    sendCustomPacket(this.controller, { customPacketType: "gameTimeRequest" });
  }

  // Waiting or sleeping (beds included) would push this client's clock ahead of the server's
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Sleep) return;
    this.sp.callNative("TESModPlatform", "CloseMenu", undefined, Menu.Sleep);
    showSystemNotification(this.sp, "Time follows the realm's clock, so waiting and sleeping are unavailable.");
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_MS;
    this.sync();
  }

  private sync(): void {
    const global = (id: number) => this.sp.GlobalVariable.from(this.sp.Game.getFormEx(id));
    const [year, month, day, hour, daysPassed, timeScale] = [GAME_YEAR, GAME_MONTH, GAME_DAY, GAME_HOUR, GAME_DAYS_PASSED, TIME_SCALE].map(global);
    if (!year || !month || !day || !hour || !daysPassed || !timeScale) return;

    const { newGameHourValue, date } = this.getTime();
    if (timeScale.getValue() !== this.clock.timeScale) timeScale.setValue(this.clock.timeScale);
    if (Math.abs(hour.getValue() - newGameHourValue) >= MAX_DRIFT_HOURS) hour.setValue(newGameHourValue);
    // The engine rolls the date (and the year) at midnight itself, so every field is checked on every pass
    if (day.getValue() !== date.getUTCDate()) day.setValue(date.getUTCDate());
    if (month.getValue() !== date.getUTCMonth()) month.setValue(date.getUTCMonth());
    if (year.getValue() !== this.clock.year) year.setValue(this.clock.year);

    // Only ever raised so game-time timers never run backwards
    const target = date.getTime() / DAY_MS - DAYS_PASSED_EPOCH;
    if (this.rebaseDaysPassed || target - daysPassed.getValue() >= MAX_DRIFT_HOURS / 24) {
      daysPassed.setValue(target);
      this.rebaseDaysPassed = false;
    }
  }

  // Until the server answers, the client's own local clock stands in
  private clock: ServerClock = { offsetMs: 0, tzOffsetMin: new Date().getTimezoneOffset(), year: DEFAULT_YEAR, timeScale: 1 };
  private nextSyncAt = 0;
  private rebaseDaysPassed = true;
}
