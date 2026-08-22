import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
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
  owned: boolean;
  name: string | null;
  locked: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
}

// Module-level state shared with the browser-side widget setter via runtime injection
let info: PropertyMenuInfo = {
  target: 0, view: 'denied', owned: false, name: null, locked: false,
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
    // Gamepad idCodes are bitmasks that alias onto keyboard scancodes
    if (e.device !== InputDeviceType.Keyboard) return;
    // Escape closes an open menu.
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey || !e.isDown) {
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) {
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
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "propertyMenu": {
        const view = content["view"];
        info = {
          target: Number(content["target"]) || this.target,
          view: view === 'owner' || view === 'manager' || view === 'claimable' ? view : 'denied',
          owned: content["owned"] === true,
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
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("housing:") || !this.menuOpen) {
      return;
    }
    const target = info.target || this.target;

    switch (key) {
      // State-changing actions leave the menu open; the server re-sends
      // propertyMenu on success so the new state shows in place.
      case events.claim:
      case events.abandon:
      case events.revoke:
      case events.lock:
      case events.unlock:
      case events.createKey:
      case events.revokeKeys: {
        const action = key.slice("housing:".length);
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action, target });
        break;
      }
      case events.rename: {
        const name = typeof e.arguments[1] === "string" ? (e.arguments[1] as string).trim() : "";
        if (name) {
          sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action: "rename", target, name });
        }
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
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, targetLabel, WIDGET_ID });
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "housing",
      id: WIDGET_ID,
      targetLabel: targetLabel,
      view: info.view,
      owned: info.owned,
      name: info.name,
      locked: info.locked,
      hasKeys: info.hasKeys,
      canGrantContainers: info.canGrantContainers,
      ownerName: info.ownerName,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.H;
  private menuOpen = false;
  private target = 0;
  private pendingRecipient: { action: string; target: number } | null = null;
}
