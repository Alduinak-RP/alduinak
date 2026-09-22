import { BrowserMessageEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, readMenuLanguage, onWidgetsCleared } from "./widgetMenuUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { ConnectionDenied } from "../events/connectionDenied";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 37;
// The client retries a refused connection with no delay, so the full-server notice is rate limited
const FULL_NOTICE_MS = 10000;

const events = {
  quit: 'queue:quit',
};

const translations = {
  "ru": {
    caption: 'Сервер полон',
    position: 'Вы {position} из {total} в очереди',
    waited: 'Ожидание: {t}',
    eta: 'Примерно осталось: {t}',
    etaUnknown: 'Примерно осталось: неизвестно',
    sec: '{n} с',
    min: '{n} мин',
    quit: 'Выйти из игры',
    full: 'Сервер полон, повторная попытка...',
  },
  "en": {
    caption: 'Server full',
    position: 'You are {position} of {total} in the queue',
    waited: 'Waiting for {t}',
    eta: 'Estimated wait: about {t}',
    etaUnknown: 'Estimated wait: unknown',
    sec: '{n} s',
    min: '{n} min',
    quit: 'Quit game',
    full: 'The server is full, retrying...',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['en']]: string };

let strings: TranslationStrings = translations['en'];
let lines: string[] = [];

// Login queue page, shown instead of the character select while the server holds the login (QueueSystem).
// Server -> Client: { "customPacketType": "queueStatus", position, total, waitedSec, etaSec | null }
export class QueueService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionDenied", (e) => this.onConnectionDenied(e));
    // The reconnect logs in again and the server re-sends the place, which reopens the page
    this.controller.emitter.on("connectionDisconnect", () => this.close());
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    onWidgetsCleared(this.controller, () => { this.open = false; });
    // The hide UI key drops focus; the page must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.open) this.sp.browser.setFocused(true); });

    const lang = readMenuLanguage(this.sp);
    if (lang in translations) {
      strings = translations[lang as keyof typeof translations];
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
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
      strings.position.replace('{position}', String(position)).replace('{total}', String(total)),
      strings.waited.replace('{t}', this.duration(num(content["waitedSec"], 0))),
      typeof etaSec === "number" ? strings.eta.replace('{t}', this.duration(etaSec)) : strings.etaUnknown,
    ];
    const args = { lines, strings, events, WIDGET_ID };
    if (this.open) {
      refreshFormMenu(this.sp, this.browsersideWidgetSetter, args);
      return;
    }
    this.open = true;
    logTrace(this, `Queued at ${position} of ${total}`);
    openFormMenu(this.sp, this.browsersideWidgetSetter, args, this.controller);
  }

  private duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return s < 60 ? strings.sec.replace('{n}', String(s)) : strings.min.replace('{n}', String(Math.max(1, Math.round(s / 60))));
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
