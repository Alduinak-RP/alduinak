import { EventHandle } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { RemoteServer } from "./remoteServer";
import { logToPlatformLog } from "../../logging";

// Play time one line covers
const WINDOW_MS = 60000;
// A window under SLOW_FPS is always logged, any other one in this many
const QUIET_WINDOWS = 5;
const SLOW_FPS = 30;
const SLOW_FRAME_MS = 1000 / SLOW_FPS;
const HITCH_MS = 100;
// A longer gap between two updates is a menu, a load or a pause, not a frame
const PAUSE_MS = 1000;

// The engine's sub-millisecond clock when it has one
const precise = (globalThis as { performance?: { now(): number } }).performance;
const clock = (): number => (precise ? precise.now() : Date.now());

interface Span {
  startedAt: number;
  total: number;
  count: number;
  worst: number;
}

const newSpan = (): Span => ({ startedAt: 0, total: 0, count: 0, worst: 0 });
const average = (span: Span): number => (span.count ? span.total / span.count : 0);

/**
 * Frame times and the client script's share of them, for low FPS reports. skyrim-platform.log gets one line for the first
 * minute of play, one for every minute that averaged under SLOW_FPS, and one in QUIET_WINDOWS minutes otherwise:
 *   FrameStatsService: frame stats 60 s: 58.9 fps (17.0 ms a frame, worst 212 ms, 3 over 100 ms, 1.2% over 33 ms); client
 *   script 2.31 ms a frame (update 1.94, worst 18.2; tick 0.37, worst 3.1); 41 server forms
 * A frame is the time between two updates, and a gap over PAUSE_MS (a menu, a load) is left out. The script time is what the
 * update and tick callbacks of every service take together: this service is built first, so its opening callbacks run ahead
 * of the others, and its closing ones are moved behind them again at every window.
 */
export class FrameStatsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdateStart());
    this.controller.on("tick", () => { this.tick.startedAt = clock(); });
    // Every service is built by the next tick
    this.controller.once("tick", () => this.closeLast());
  }

  private onUpdateStart(): void {
    const now = clock();
    const gap = this.update.startedAt ? now - this.update.startedAt : 0;
    this.update.startedAt = now;
    if (gap <= 0 || gap > PAUSE_MS) return;
    this.frames++;
    this.frameMs += gap;
    if (gap > this.worstFrame) this.worstFrame = gap;
    if (gap > SLOW_FRAME_MS) this.slowFrames++;
    if (gap > HITCH_MS) this.hitches++;
    if (this.frameMs >= WINDOW_MS) this.closeWindow();
  }

  private closeSpan(span: Span): void {
    if (!span.startedAt) return;
    const ms = clock() - span.startedAt;
    span.total += ms;
    span.count++;
    if (ms > span.worst) span.worst = ms;
  }

  // Behind every callback registered so far
  private closeLast(): void {
    for (const handle of this.closers) this.controller.unsubscribe(handle);
    this.closers = [
      this.controller.on("update", () => this.closeSpan(this.update)),
      this.controller.on("tick", () => this.closeSpan(this.tick)),
    ];
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
        `(update ${update.toFixed(2)}, worst ${this.update.worst.toFixed(1)}; tick ${tick.toFixed(2)}, worst ${this.tick.worst.toFixed(1)}); ` +
        `${this.serverForms()} server forms`);
    }
    this.frames = this.frameMs = this.worstFrame = this.slowFrames = this.hitches = 0;
    this.update = { ...newSpan(), startedAt: this.update.startedAt };
    this.tick = { ...newSpan(), startedAt: this.tick.startedAt };
    this.closeLast();
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
  private closers: EventHandle[] = [];
  private frames = 0;
  private frameMs = 0;
  private worstFrame = 0;
  private slowFrames = 0;
  private hitches = 0;
  // The first window is logged
  private quiet = QUIET_WINDOWS - 1;
}
