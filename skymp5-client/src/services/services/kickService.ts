import { BrowserMessageEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, readMenuLanguage } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { NetworkingService } from "./networkingService";
import { logTrace } from "../../logging";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 28;
const EXIT_DELAY_MS = 10000;

const events = {
  quit: 'kicked:quit',
};

const translations = {
  "ru": {
    disconnected: 'Отключено',
    closing: 'Игра закроется через {s} с. Перезапустите её из лаунчера, чтобы вернуться.',
    quit: 'Выйти из игры',
    unreachable: 'Не удалось переподключиться к Alduinak за минуту.',
  },
  "en": {
    disconnected: 'Disconnected',
    closing: 'The game will close in {s} s. Restart it from the launcher to play again.',
    quit: 'Quit game',
    unreachable: 'Could not reconnect to Alduinak for a minute.',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['en']]: string };

let strings: TranslationStrings = translations['en'];
let reason = '';
let closing = '';

// Server kick (AFK, admin, ban) or a lost server: stay disconnected, show why, then close the game so the player must relaunch.
// Server -> Client: { "customPacketType": "kicked", "reason": "..." }
export class KickService extends ClientListener {
  get strings() {
    return strings;
  }

  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    // "tick" keeps firing while a pausing menu is open, unlike "update"
    this.controller.on("tick", () => this.onTick());
    // The hide UI key drops focus; the dialog must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.exitAt) this.sp.browser.setFocused(true); });

    const lang = readMenuLanguage(this.sp);
    if (lang in translations) {
      strings = translations[lang as keyof typeof translations];
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "kicked") return;

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
    closing = strings.closing.replace('{s}', String(this.shownSeconds));
    openFormMenu(this.sp, this.browsersideWidgetSetter, { reason, closing, strings, events, WIDGET_ID }, this.controller);
  }

  private onTick(): void {
    if (!this.exitAt) return;
    const seconds = this.secondsLeft();
    if (seconds <= 0) return this.quitGame();
    if (seconds === this.shownSeconds) return;
    this.shownSeconds = seconds;
    closing = strings.closing.replace('{s}', String(seconds));
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
