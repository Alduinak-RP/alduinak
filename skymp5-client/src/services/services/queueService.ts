import { BrowserMessageEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, onWidgetsCleared } from "./widgetMenuUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionDenied } from "../events/connectionDenied";
import { logTrace, logToPlatformLog } from "../../logging";
import { loc } from "../../loc";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 37;
// The client retries a refused connection with no delay, so the full-server notice is rate limited
const FULL_NOTICE_MS = 10000;

const events = {
  quit: 'queue:quit',
};

const strings = {
  caption: loc("queue.caption"),
  etaUnknown: loc("queue.etaUnknown"),
  quit: loc("menu.quitGame"),
  full: loc("auth.serverFull"),
};

let lines: string[] = [];

// Login queue page, shown instead of the character select while the server holds the login (QueueSystem).
// Server -> Client: { "customPacketType": "queueStatus", position, total, waitedSec, etaSec | null }
export class QueueService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    onCustomPacket(this.controller, ["queueStatus", "characterSelectMenu", "kicked"], (content) => this.onCustomPacketMessage(content));
    this.controller.emitter.on("connectionDenied", (e) => this.onConnectionDenied(e));
    // The reconnect logs in again and the server re-sends the place, which reopens the page
    this.controller.emitter.on("connectionDisconnect", () => this.close());
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    onWidgetsCleared(this.controller, () => { this.open = false; });
    // The hide UI key drops focus; the page must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.open) this.sp.browser.setFocused(true); });
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const type = content["customPacketType"];
    if (type === "queueStatus") {
      this.show(content);
    } else if (type === "characterSelectMenu" || type === "kicked") {
      // Both replace every form widget, so the page is already gone
      this.open = false;
    }
  }

  private show(content: Record<string, unknown>): void {
    const num = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
    const position = num(content["position"], 1);
    const total = num(content["total"], 1);
    const etaSec = content["etaSec"];
    lines = [
      loc("queue.position", { position, total }),
      loc("queue.waited", { t: this.duration(num(content["waitedSec"], 0)) }),
      typeof etaSec === "number" ? loc("queue.eta", { t: this.duration(etaSec) }) : strings.etaUnknown,
    ];
    const args = { lines, strings, events, WIDGET_ID };
    if (this.open) {
      refreshFormMenu(this.sp, this.browsersideWidgetSetter, args);
      return;
    }
    this.open = true;
    // The skyrim-platform.log line is the proof the page rendered
    logToPlatformLog(this, `queue page opened at ${position} of ${total}`);
    openFormMenu(this.sp, this.browsersideWidgetSetter, args, this.controller);
  }

  private duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return s < 60 ? loc("queue.sec", { n: s }) : loc("queue.min", { n: Math.max(1, Math.round(s / 60)) });
  }

  private onConnectionDenied(e: ConnectionDenied): void {
    if (!String(e.error).toLowerCase().includes("no free incoming connections")) return;
    const now = Date.now();
    if (now - this.lastFullNoticeMs < FULL_NOTICE_MS) return;
    this.lastFullNoticeMs = now;
    logTrace(this, 'Connection refused, the server has no free connections');
    showSystemNotification(this.sp, strings.full);
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (this.open && e.arguments[0] === events.quit) {
      logTrace(this, 'leaving the queue, closing the game');
      this.sp.win32.exitProcess();
    }
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    logToPlatformLog(this, "queue page closed");
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "form",
      id: WIDGET_ID,
      caption: strings.caption,
      elements: lines.map((text: string) => ({ type: "text", text, tags: [] })).concat([
        {
          type: "button",
          text: strings.quit,
          tags: ["BUTTON_STYLE_FRAME", "ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.quit),
        } as any,
      ]),
    };

    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w && w.type !== "form");
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private open = false;
  private lastFullNoticeMs = 0;
}
