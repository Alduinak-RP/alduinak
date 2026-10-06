import { ClientListener, CombinedController, Sp } from "./clientListener";
import { RemoteServer } from "./remoteServer";
import { SpApiInteractor, frameClock } from "../spApiInteractor";
import { logToPlatformLog } from "../../logging";

// Play time one line covers
const WINDOW_MS = 60000;
// A window under SLOW_FPS is always logged, any other one in this many
const QUIET_WINDOWS = 5;
const SLOW_FPS = 30;
const SLOW_FRAME_MS = 1000 / SLOW_FPS;
const HITCH_MS = 100;
// A longer gap between two updates is a load or a pause, not a frame
const PAUSE_MS = 1000;
// Ticks go on while a menu pauses the updates, so more than this many between two updates is a menu, not a frame
const TICKS_PER_FRAME_MAX = 2;

interface Span {
  total: number;
  count: number;
  worst: number;
}

const newSpan = (): Span => ({ total: 0, count: 0, worst: 0 });
const average = (span: Span): number => (span.count ? span.total / span.count : 0);

/**
 * Frame times and the client script's share of them, for low FPS reports. skyrim-platform.log gets one line for the first
 * minute of play, one for every minute that averaged under SLOW_FPS, and one in QUIET_WINDOWS minutes otherwise:
 *   FrameStatsService: frame stats 60 s: 58.9 fps (17.0 ms a frame, worst 212 ms, 3 over 100 ms, 1.2% over 33 ms); client
 *   script 2.31 ms a frame (update 1.94, worst 18.2; tick 0.37, worst 3.1; hooks and native events not counted); 41 server forms
 * A frame is the time between two updates; a gap over PAUSE_MS (a load, a pause) or one the ticks show a menu in is left out.
 * The script time is what every update and tick dispatch of the controller takes (SpApiInteractor times the whole dispatch, the
 * once callbacks queued that frame included); animation and Papyrus hooks and callbacks on the native sp.on run outside it.
 */
export class FrameStatsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("tick", () => { this.ticksSinceUpdate++; });
    SpApiInteractor.watchDispatch((eventName, ms) => this.record(eventName === "update" ? this.update : this.tick, ms));
  }

  private onUpdate(): void {
    const now = frameClock();
    const gap = this.lastUpdateAt ? now - this.lastUpdateAt : 0;
    const ticks = this.ticksSinceUpdate;
    this.lastUpdateAt = now;
    this.ticksSinceUpdate = 0;
    if (gap <= 0 || gap > PAUSE_MS || ticks > TICKS_PER_FRAME_MAX) return;
    this.frames++;
    this.frameMs += gap;
    if (gap > this.worstFrame) this.worstFrame = gap;
    if (gap > SLOW_FRAME_MS) this.slowFrames++;
    if (gap > HITCH_MS) this.hitches++;
    if (this.frameMs >= WINDOW_MS) this.closeWindow();
  }

  private record(span: Span, ms: number): void {
    span.total += ms;
    span.count++;
    if (ms > span.worst) span.worst = ms;
  }

  private closeWindow(): void {
    const fps = this.frames * 1000 / this.frameMs;
    const slow = fps < SLOW_FPS;
    if (slow || ++this.quiet >= QUIET_WINDOWS) {
      this.quiet = 0;
      const [update, tick] = [average(this.update), average(this.tick)];
      logToPlatformLog(this, `frame stats ${Math.round(this.frameMs / 1000)} s${slow ? ", slow" : ""}: ${fps.toFixed(1)} fps ` +
        `(${(this.frameMs / this.frames).toFixed(1)} ms a frame, worst ${Math.round(this.worstFrame)} ms, ${this.hitches} over ${HITCH_MS} ms, ` +
        `${(100 * this.slowFrames / this.frames).toFixed(1)}% over ${Math.round(SLOW_FRAME_MS)} ms); client script ${(update + tick).toFixed(2)} ms a frame ` +
        `(update ${update.toFixed(2)}, worst ${this.update.worst.toFixed(1)}; tick ${tick.toFixed(2)}, worst ${this.tick.worst.toFixed(1)}; hooks and native events not counted); ` +
        `${this.serverForms()} server forms`);
    }
    this.frames = this.frameMs = this.worstFrame = this.slowFrames = this.hitches = 0;
    this.update = newSpan();
    this.tick = newSpan();
  }

  private serverForms(): number {
    try {
      return this.controller.lookupListener(RemoteServer).getWorldModel().forms.filter((form) => !!form).length;
    } catch {
      return 0;
    }
  }

  private update = newSpan();
  private tick = newSpan();
  private lastUpdateAt = 0;
  private ticksSinceUpdate = 0;
  private frames = 0;
  private frameMs = 0;
  private worstFrame = 0;
  private slowFrames = 0;
  private hitches = 0;
  // The first window is logged
  private quiet = QUIET_WINDOWS - 1;
}
