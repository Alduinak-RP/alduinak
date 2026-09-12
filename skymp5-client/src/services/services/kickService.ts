import { BrowserMessageEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuLanguage } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { NetworkingService } from "./networkingService";
import { logTrace } from "../../logging";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 28;

const events = {
  reconnect: 'kicked:reconnect',
  quit: 'kicked:quit',
};

const translations = {
  "ru": {
    disconnected: 'Отключено',
    reconnect: 'Переподключиться',
    quit: 'Выйти из игры',
  },
  "en": {
    disconnected: 'Disconnected',
    reconnect: 'Reconnect',
    quit: 'Quit game',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['en']]: string };

let strings: TranslationStrings = translations['en'];
let reason = '';

// Server kick (AFK, admin, ban): stay disconnected and show why instead of auto-rejoining.
// Server -> Client: { "customPacketType": "kicked", "reason": "..." }
export class KickService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    // The hide UI key drops focus; the dialog must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.menuOpen) this.sp.browser.setFocused(true); });

    const lang = readMenuLanguage(this.sp);
    if (lang in translations) {
      strings = translations[lang as keyof typeof translations];
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "kicked") return;

    reason = typeof content["reason"] === "string" ? content["reason"] : "";
    logTrace(this, `Kicked by the server:`, reason);
    this.controller.lookupListener(NetworkingService).closeAfterKick();
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { reason, strings, events, WIDGET_ID }, this.controller);
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (!this.menuOpen) return;

    switch (e.arguments[0]) {
      case events.reconnect:
        logTrace(this, 'reconnect requested after kick');
        this.menuOpen = false;
        closeFormMenu(this.sp, WIDGET_ID);
        this.controller.lookupListener(NetworkingService).reconnect();
        break;
      case events.quit:
        logTrace(this, 'quit requested after kick');
        this.sp.win32.exitProcess();
        break;
      default:
        break;
    }
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "form",
      id: WIDGET_ID,
      caption: strings.disconnected,
      elements: [
        { type: "text", text: reason, tags: [] },
        {
          type: "button",
          text: strings.reconnect,
          tags: ["BUTTON_STYLE_FRAME", "ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.reconnect),
        },
        {
          type: "button",
          text: strings.quit,
          tags: ["ELEMENT_SAME_LINE"],
          click: () => window.skyrimPlatform.sendMessage(events.quit),
        },
      ],
    };

    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w && w.type !== "form");
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
}
