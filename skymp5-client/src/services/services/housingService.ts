import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { closeWidget, readMenuKeyCode } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 8;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  claim: 'housing:claim',
  abandon: 'housing:abandon',
  revoke: 'housing:revoke',
  lock: 'housing:lock',
  unlock: 'housing:unlock',
  transfer: 'housing:transfer',
  rename: 'housing:rename',
  createKey: 'housing:createkey',
  revokeKeys: 'housing:revokekeys',
  grantContainer: 'housing:grantcontainer',
  cancel: 'housing:cancel',
};

// The server's propertyMenu reply that drives which menu we render.
interface PropertyMenuInfo {
  target: number;
  view: 'owner' | 'manager' | 'claimable' | 'denied';
  name: string | null;
  locked: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
}

// Module-level state shared with the browser-side widget setter via runtime injection
let info: PropertyMenuInfo = {
  target: 0, view: 'denied', name: null, locked: false,
  hasKeys: false, canGrantContainers: false, ownerName: null,
};
let targetLabel = '';

/**
 * Property menu on the housing key (default H). Aim at a door or container and
 * press the key: the client asks the server what it may do there and renders
 * the matching menu.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "propertyInfoRequest", "target": <id> }
 *   Server -> Client: { "customPacketType": "propertyMenu", "target", "view",
 *                       "name", "locked", "hasKeys", "canGrantContainers", "ownerName" }
 *   Client -> Server: { "customPacketType": "propertyRequest", "action", "target",
 *                       "recipient"?, "name"? }
 *   Server -> Client: { "customPacketType": "propertyNotice", "text" }
 *
 * Views: 'denied' shows only "You don't own this"; 'claimable' adds a claim
 * button; 'owner' offers rename/keys/lock/transfer/abandon; 'manager'
 * (steward, jarl, regent, or the surrounding house's owner) offers
 * grant/revoke/lock/rename. Transfer and grant-container are two-step: pick
 * the action, then look at the recipient and press the housing key again.
 */
export class HousingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));

    this.menuKey = readMenuKeyCode(this.sp, "housingMenuKeyCode", DxScanCode.H);
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.code !== this.menuKey || !e.isDown) {
      return;
    }
    if (this.sp.browser.isFocused()) {
      return;
    }

    // Second step of transfer / grant-container: this press picks the player.
    if (this.pendingRecipient !== null) {
      const pending = this.pendingRecipient;
      this.pendingRecipient = null;
      const ref = this.sp.Game.getCurrentCrosshairRef();
      const recipient = ref && Actor.from(ref) ? ref : null;
      if (!recipient || recipient.getFormID() === 0x14) {
        notifyNextUpdate(this.controller, this.sp, "Cancelled - that is not a person.");
        return;
      }
      sendCustomPacket(this.controller, {
        customPacketType: "propertyRequest",
        action: pending.action,
        target: pending.target,
        recipient: localIdToRemoteId(recipient.getFormID()),
      });
      return;
    }

    if (this.menuOpen) {
      return;
    }

    const ref = this.sp.Game.getCurrentCrosshairRef();
    if (!ref || Actor.from(ref)) {
      notifyNextUpdate(this.controller, this.sp, "Look at a door or container.");
      return;
    }
    this.target = localIdToRemoteId(ref.getFormID());
    targetLabel = (ref.getName() || "Property").trim() || "Property";
    logTrace(this, `Requesting property info for`, targetLabel, `(${this.target})`);
    sendCustomPacket(this.controller, { customPacketType: "propertyInfoRequest", target: this.target });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }

    switch (content["customPacketType"]) {
      case "propertyMenu": {
        const view = content["view"];
        info = {
          target: Number(content["target"]) || this.target,
          view: view === 'owner' || view === 'manager' || view === 'claimable' ? view : 'denied',
          name: typeof content["name"] === "string" ? content["name"] as string : null,
          locked: content["locked"] === true,
          hasKeys: content["hasKeys"] === true,
          canGrantContainers: content["canGrantContainers"] === true,
          ownerName: typeof content["ownerName"] === "string" ? content["ownerName"] as string : null,
        };
        this.openMenu();
        break;
      }
      case "propertyNotice":
        if (typeof content["text"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["text"]);
        }
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("housing:") || !this.menuOpen) {
      return;
    }
    const target = info.target || this.target;

    switch (key) {
      case events.claim:
      case events.abandon:
      case events.revoke:
      case events.lock:
      case events.unlock:
      case events.createKey:
      case events.revokeKeys: {
        const action = key.slice("housing:".length);
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action, target });
        this.closeMenu();
        break;
      }
      case events.rename: {
        const name = typeof e.arguments[1] === "string" ? (e.arguments[1] as string).trim() : "";
        if (name) {
          sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action: "rename", target, name });
        }
        this.closeMenu();
        break;
      }
      case events.transfer:
      case events.grantContainer: {
        this.pendingRecipient = {
          action: key === events.transfer ? "transfer" : "grantcontainer",
          target,
        };
        this.closeMenu();
        notifyNextUpdate(this.controller, this.sp, "Look at the recipient and press the housing key.");
        break;
      }
      case events.cancel:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    const text = new FunctionInfo(this.browsersideWidgetSetter).getText({ events, info, targetLabel, WIDGET_ID });
    // Debug breadcrumb: pairs with the CEF-side "widget set" line to locate render failures.
    notifyNextUpdate(this.controller, this.sp, `[debug] property menu: injecting ${text.length} chars, view=${info.view}`);
    this.sp.browser.executeJavaScript(text);
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeWidget(this.sp, WIDGET_ID);
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    try {
    const displayName = info.name || targetLabel;
    const widget: any = {
      type: "form",
      id: WIDGET_ID,
      caption: "Manage: " + displayName,
      elements: [] as any[],
    };
    const pushButton = (text: string, event: string, sameLine: boolean) => {
      widget.elements.push({
        type: "button",
        text,
        tags: sameLine ? ["ELEMENT_SAME_LINE"] : [],
        click: () => window.skyrimPlatform.sendMessage(event),
      });
    };

    if (info.view === "denied" || info.view === "claimable") {
      widget.elements.push({ type: "text", text: "You don't own this", tags: [] });
      if (info.ownerName) {
        widget.elements.push({ type: "text", text: "Owner: " + info.ownerName, tags: [] });
      }
      if (info.view === "claimable") {
        pushButton("claim", events.claim, false);
      }
    } else {
      widget.elements.push({
        type: "text",
        text: (info.view === "owner" ? "Yours" : "Managed") + (info.locked ? " - locked" : " - unlocked"),
        tags: [],
      });
      if (info.ownerName && info.view === "manager") {
        widget.elements.push({ type: "text", text: "Owner: " + info.ownerName, tags: [] });
      }

      pushButton(info.locked ? "unlock" : "lock", info.locked ? events.unlock : events.lock, false);

      if (info.view === "owner") {
        pushButton("create key", events.createKey, true);
        if (info.hasKeys) {
          pushButton("void all keys", events.revokeKeys, true);
        }
        pushButton("transfer", events.transfer, false);
        pushButton("abandon", events.abandon, true);
      } else {
        pushButton("grant ownership", events.transfer, false);
        pushButton("revoke ownership", events.revoke, true);
        if (info.hasKeys) {
          pushButton("void all keys", events.revokeKeys, true);
        }
      }
      if (info.canGrantContainers) {
        pushButton("grant this container", events.grantContainer, false);
      }

      // Rename: type a name, then save.
      let renameValue = info.name || "";
      widget.elements.push({
        type: "inputText",
        placeholder: "name this property",
        initialValue: renameValue,
        tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
        onInput: (e: any) => { renameValue = e && e.target ? e.target.value : renameValue; },
      });
      widget.elements.push({
        type: "button",
        text: "save name",
        tags: ["ELEMENT_SAME_LINE"],
        click: () => window.skyrimPlatform.sendMessage(events.rename, renameValue),
      });
    }

    widget.elements.push({
      type: "button",
      text: "close",
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.cancel),
    });

    // Preserve any other widgets
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
    if (window.__skyrpAddSystem) window.__skyrpAddSystem("[debug] property menu set: " + widget.elements.length + " elements, " + window.skyrimPlatform.widgets.get().length + " widgets total");
    } catch (err: any) {
      if (window.__skyrpAddSystem) window.__skyrpAddSystem("[debug] property menu FAILED in CEF: " + (err && err.message));
    }
  };

  private menuKey: DxScanCode = DxScanCode.H;
  private menuOpen = false;
  private target = 0;
  private pendingRecipient: { action: string; target: number } | null = null;
}
