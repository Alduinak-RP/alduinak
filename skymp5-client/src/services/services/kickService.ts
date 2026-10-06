import { BrowserMessageEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu } from "./widgetMenuUtil";
import { NetworkingService } from "./networkingService";
import { logTrace } from "../../logging";
import { loc } from "../../loc";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 28;
const EXIT_DELAY_MS = 10000;

const events = {
  quit: 'kicked:quit',
};

const strings = {
  disconnected: loc("kick.disconnected"),
  quit: loc("menu.quitGame"),
};

let reason = '';
let closing = '';

// Server kick (AFK, admin, ban) or a lost server: stay disconnected, show why, then close the game so the player must relaunch.
// Server -> Client: { "customPacketType": "kicked", "reason": "..." }
export class KickService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    onCustomPacket(this.controller, "kicked", (content) => this.onCustomPacketMessage(content));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    // "tick" keeps firing while a pausing menu is open, unlike "update"
    this.controller.on("tick", () => this.onTick());
    // The hide UI key drops focus; the dialog must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.exitAt) this.sp.browser.setFocused(true); });
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const kickReason = typeof content["reason"] === "string" ? content["reason"] : "";
    logTrace(this, `Kicked by the server:`, kickReason);
    this.showDisconnectedAndExit(kickReason);
  }

  // Blocks reconnects, shows the countdown dialog and closes the game when it runs out
  showDisconnectedAndExit(why: string): void {
    if (this.exitAt) return;
    reason = why;
    this.controller.lookupListener(NetworkingService).closeAfterKick();
    this.exitAt = Date.now() + EXIT_DELAY_MS;
    this.shownSeconds = this.secondsLeft();
    closing = loc("kick.closing", { s: this.shownSeconds });
    openFormMenu(this.sp, this.browsersideWidgetSetter, { reason, closing, strings, events, WIDGET_ID }, this.controller);
  }

  private onTick(): void {
    if (!this.exitAt) return;
    const seconds = this.secondsLeft();
    if (seconds <= 0) return this.quitGame();
    if (seconds === this.shownSeconds) return;
    this.shownSeconds = seconds;
    closing = loc("kick.closing", { s: seconds });
    refreshFormMenu(this.sp, this.browsersideWidgetSetter, { reason, closing, strings, events, WIDGET_ID });
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (this.exitAt && e.arguments[0] === events.quit) this.quitGame();
  }

  private quitGame(): void {
    logTrace(this, 'closing the game after kick');
    this.exitAt = 0;
    this.sp.win32.exitProcess();
  }

  private secondsLeft(): number {
    return Math.max(0, Math.ceil((this.exitAt - Date.now()) / 1000));
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "form",
      id: WIDGET_ID,
      caption: strings.disconnected,
      elements: [
        { type: "text", text: reason, tags: [] },
        { type: "text", text: closing, tags: [] },
        {
          type: "button",
          text: strings.quit,
          tags: ["BUTTON_STYLE_FRAME", "ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.quit),
        },
      ],
    };

    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w && w.type !== "form");
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private exitAt = 0;
  private shownSeconds = 0;
}
