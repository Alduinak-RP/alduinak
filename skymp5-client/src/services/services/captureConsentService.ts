import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { TimersService } from "./timersService";
import { FunctionInfo } from "../../lib/functionInfo";
import { BrowserMessageEvent } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 12;

// Matches the server's consent window (captureSystem CONSENT_TIMEOUT_MS): once
// it lapses server-side, answering is a no-op, so dismiss the prompt too.
const CONSENT_TIMEOUT_MS = 20000;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  yes: "consent:yes",
  no: "consent:no",
};

// Module-level so the browser-side widget setter can read it (runtime injection,
// same pattern as FactionService / PlayerActionService).
let promptText = "";

/**
 * Consent prompt for the arrest/capture/carry feature. When another player asks
 * to restrain or carry this player, the server sends a `captureConsentRequest`
 * and we pop a Yes/No widget; the player's choice is returned as a
 * `captureConsentResult`. Also routes `captureNotice` feedback into the chat's
 * System tab. Server-authoritative — inert until the server sends a packet.
 *
 * Protocol — {@link MsgType.CustomPacket} with a JSON dump:
 *   Server -> Client:
 *     { "customPacketType": "captureConsentRequest", "requestId": 4, "text": "X wants to restrain you. Allow?" }
 *     { "customPacketType": "captureNotice", "text": "You restrained Y." }
 *   Client -> Server:
 *     { "customPacketType": "captureConsentResult", "requestId": 4, "accepted": true }
 */
export class CaptureConsentService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }

    switch (content["customPacketType"]) {
      case "captureConsentRequest":
        this.pendingRequestId = typeof content["requestId"] === "number"
          ? (content["requestId"] as number) : null;
        promptText = typeof content["text"] === "string"
          ? (content["text"] as string) : "Allow this?";
        if (this.pendingRequestId !== null) {
          logTrace(this, `Consent request`, this.pendingRequestId);
          this.openPrompt();
        }
        break;
      case "captureNotice":
        if (typeof content["text"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["text"] as string);
        }
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("consent:") || !this.promptOpen) {
      return;
    }
    const accepted = key === events.yes;
    if (this.pendingRequestId !== null) {
      sendCustomPacket(this.controller, {
        customPacketType: "captureConsentResult",
        requestId: this.pendingRequestId,
        accepted,
      });
    }
    this.pendingRequestId = null;
    this.closePrompt();
  }

  private openPrompt(): void {
    this.controller.once("update", () => {
      this.promptOpen = true;
      this.sp.browser.executeJavaScript(
        new FunctionInfo(this.browsersideWidgetSetter).getText({ events, promptText, WIDGET_ID })
      );
      this.sp.browser.setVisible(true);
      this.sp.browser.setFocused(true);
      const timers = this.controller.lookupListener(TimersService);
      if (this.expiryTimer !== undefined) {
        timers.clearTimeout(this.expiryTimer);
      }
      this.expiryTimer = timers.setTimeout(() => {
        this.expiryTimer = undefined;
        this.pendingRequestId = null;
        this.closePrompt();
      }, CONSENT_TIMEOUT_MS);
    });
  }

  private closePrompt(): void {
    if (this.expiryTimer !== undefined) {
      this.controller.lookupListener(TimersService).clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.promptOpen = false;
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==12;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only the injected variables (events, promptText,
  // WIDGET_ID) and `window` are available here.
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "form",
      id: WIDGET_ID,
      caption: "Restraint Request",
      elements: [
        { type: "text", text: promptText, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] },
        { type: "button", text: "Allow", tags: [], click: () => window.skyrimPlatform.sendMessage(events.yes) },
        { type: "button", text: "Refuse", tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.no) },
      ],
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set([...others, widget]);
  };

  private promptOpen = false;
  private pendingRequestId: number | null = null;
  private expiryTimer?: number;
}
