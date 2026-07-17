import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { closeWidget } from "./widgetMenuUtil";
import { TimersService } from "./timersService";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, DxScanCode } from "skyrimPlatform";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { logTrace, logError } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 16;

// Matches the server's SearchSystem CONSENT_TIMEOUT_MS.
const CONSENT_TIMEOUT_MS = 20000;

const events = {
  yes: "search:yes",
  no: "search:no",
};

// Module-level so the browser-side widget setter can read it via runtime injection.
let promptText = "";

/**
 * Consent prompt + window plumbing for the player-search feature. When another
 * player asks to search this player, the server sends `searchConsentRequest`
 * and we pop a Yes/No widget. When WE are the approved searcher, the server
 * sends `searchApproved` and we open the target's inventory with the VANILLA
 * container window (the server has authorized TakeItem/PutItem for the pair);
 * `searchClose` force-closes it again (target moved away or logged off).
 *
 * Protocol: {@link MsgType.CustomPacket} with a JSON dump.
 *   Server -> Client:
 *     { "customPacketType": "searchConsentRequest", "requestId": 4, "text": "X wants to search you. Allow?" }
 *     { "customPacketType": "searchApproved", "target": <actorFormId> }
 *     { "customPacketType": "searchClose" }
 *     { "customPacketType": "searchNotice", "text": "..." }
 *   Client -> Server:
 *     { "customPacketType": "searchConsentResult", "requestId": 4, "accepted": true }
 */
export class SearchService extends ClientListener {
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
      case "searchConsentRequest":
        this.pendingRequestId = typeof content["requestId"] === "number"
          ? (content["requestId"] as number) : null;
        promptText = typeof content["text"] === "string"
          ? (content["text"] as string) : "Allow this?";
        if (this.pendingRequestId !== null) {
          logTrace(this, `Search consent request`, this.pendingRequestId);
          this.openPrompt();
        }
        break;
      case "searchApproved":
        if (typeof content["target"] === "number") {
          this.openTargetInventory(content["target"] as number);
        }
        break;
      case "searchClose":
        this.closeTargetInventory();
        break;
      case "searchNotice":
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
    if (typeof key !== "string" || !key.startsWith("search:") || !this.promptOpen) {
      return;
    }
    const accepted = key === events.yes;
    if (this.pendingRequestId !== null) {
      sendCustomPacket(this.controller, {
        customPacketType: "searchConsentResult",
        requestId: this.pendingRequestId,
        accepted,
      });
    }
    this.pendingRequestId = null;
    this.closePrompt();
  }

  // The vanilla container window on the target's synced body; item moves ride
  // the normal ContainersService PutItem/TakeItem sync, which the server has
  // just authorized for this pair.
  private openTargetInventory(remoteId: number): void {
    this.controller.once("update", () => {
      const localId = remoteIdToLocalId(remoteId);
      const actor = Actor.from(this.sp.Game.getFormEx(localId));
      if (!actor) {
        logError(this, `searchApproved - target actor not found`, remoteId.toString(16));
        return;
      }
      this.searchWindowOpen = true;
      actor.openInventory(true);
    });
  }

  private closeTargetInventory(): void {
    if (!this.searchWindowOpen) {
      return;
    }
    this.searchWindowOpen = false;
    this.controller.once("update", () => {
      // No close-menu API in SkyrimPlatform: tap the cancel key while the
      // container window is up, which is exactly the player's own close.
      if (this.sp.Ui.isMenuOpen("ContainerMenu")) {
        this.sp.Input.tapKey(DxScanCode.Tab);
      }
    });
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
    closeWidget(this.sp, WIDGET_ID);
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser; only the injected vars (events, promptText, WIDGET_ID) and window exist here.
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "form",
      id: WIDGET_ID,
      caption: "Search Request",
      elements: [
        { type: "text", text: promptText, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] },
        { type: "button", text: "Allow", tags: [], click: () => window.skyrimPlatform.sendMessage(events.yes) },
        { type: "button", text: "Refuse", tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.no) },
      ],
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private promptOpen = false;
  private pendingRequestId: number | null = null;
  private expiryTimer?: number;
  private searchWindowOpen = false;
}
