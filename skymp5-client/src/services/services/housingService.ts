import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

// House claiming as a server packet protocol (see docs_roleplay_property_factions).
// Look at a door or container and press the housing key (default H) to open a
// small Manage menu for that reference; each action is a `propertyRequest`
// packet the gamemode resolves to the interior cell (the house) and enforces
// against hold rank / ownership. Feedback returns as a `propertyNotice`.
//
//   Client -> Server:
//     { "customPacketType": "propertyRequest", "action": "claim"|"abandon"
//       |"lock"|"unlock"|"transfer", "target": <serverFormId>, "recipient"?: <serverFormId> }
//   Server -> Client:
//     { "customPacketType": "propertyNotice", "text": "You now own this property." }
//
// Transfer is two-step: pick "transfer", then look at the new owner and press
// the housing key again. Inert until the key is pressed; never opens for a person.
const events = {
  claim: 'housing:claim',
  abandon: 'housing:abandon',
  lock: 'housing:lock',
  unlock: 'housing:unlock',
  transfer: 'housing:transfer',
  cancel: 'housing:cancel',
};

const WIDGET_ID = 8;

// Module-level so the browser-side widget setter can read it (runtime injection).
let targetName = '';

export class HousingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));

    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && typeof settings["housingMenuKeyCode"] === "number") {
        this.menuKey = settings["housingMenuKeyCode"];
      }
    } catch {
      // default key
    }
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.code !== this.menuKey || !e.isDown) {
      return;
    }
    if (this.sp.browser.isFocused() || this.menuOpen) {
      return;
    }

    const ref = this.sp.Game.getCurrentCrosshairRef();

    // Second step of a transfer: this press picks the new owner (a player).
    if (this.pendingTransfer !== null) {
      const transferTarget = this.pendingTransfer;
      this.pendingTransfer = null;
      const recipient = ref && Actor.from(ref) ? ref : null;
      if (!recipient) {
        notifyNextUpdate(this.controller, this.sp, "Transfer cancelled - that is not a person.");
        return;
      }
      this.sendRequest({
        action: "transfer",
        target: transferTarget,
        recipient: localIdToRemoteId(recipient.getFormID()),
      });
      return;
    }

    // Otherwise open the Manage menu for the door/container under the crosshair.
    if (!ref || Actor.from(ref)) {
      notifyNextUpdate(this.controller, this.sp, "Look at a door or container to manage it.");
      return;
    }
    this.target = localIdToRemoteId(ref.getFormID());
    targetName = (ref.getName() || "this").trim() || "this";
    logTrace(this, `Opening housing menu for`, targetName, `(${this.target})`);
    this.openMenu();
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] === "propertyNotice" && typeof content["text"] === "string") {
      notifyNextUpdate(this.controller, this.sp, content["text"] as string);
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("housing:") || !this.menuOpen) {
      return;
    }
    const target = this.target;

    // claim / abandon / lock / unlock share one request shape; the action name
    // is the key suffix after 'housing:'.
    const action = key.slice("housing:".length);
    if (["claim", "abandon", "lock", "unlock"].includes(action)) {
      this.sendRequest({ action, target });
      this.closeMenu();
      return;
    }

    switch (key) {
      case events.transfer:
        // Defer to a second key press where the player looks at the new owner.
        this.pendingTransfer = target;
        this.closeMenu();
        notifyNextUpdate(this.controller, this.sp, "Look at the new owner and press the housing key.");
        break;
      case events.cancel:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private sendRequest(payload: Record<string, unknown>): void {
    sendCustomPacket(this.controller, { customPacketType: "propertyRequest", ...payload });
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({ events, targetName, WIDGET_ID })
    );
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    // Remove only our widget; leave SkyMP's chat (and anything else) intact.
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==8;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private browsersideWidgetSetter = () => {
    const elements: any[] = [];
    elements.push({ type: "text", text: "Manage: " + targetName, tags: [] });
    const actions: [string, string][] = [
      ["claim", events.claim],
      ["abandon", events.abandon],
      ["lock", events.lock],
      ["unlock", events.unlock],
      ["transfer", events.transfer],
    ];
    for (let i = 0; i < actions.length; i++) {
      elements.push({ type: "button", text: actions[i][0], tags: [], click: () => window.skyrimPlatform.sendMessage(actions[i][1]) });
    }
    elements.push({ type: "button", text: "cancel", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.cancel) });

    const widget = { type: "form", id: WIDGET_ID, caption: "Property", elements: elements };
    // Preserve SkyMP's chat widget and anything else; only replace ours.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.H;
  private menuOpen = false;
  private target = 0;
  private pendingTransfer: number | null = null;
}
