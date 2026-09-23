import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, FormType, ObjectReference } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 8;
const PET_LIST_WIDGET_ID = 30;

// A hand-over waits for one more interact-key press; it must not wait forever.
const PENDING_RECIPIENT_MS = 30000;
const REPLY_WAIT_MS = 5000;

const NOT_PROPERTY_TEXT = "That cannot be claimed.";

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
  pets: 'housing:pets',
  cancel: 'housing:cancel',
};

// Event keys of the pet list the Pets option opens
const petListEvents = {
  summon: 'housing:petsummon',
  close: 'housing:petclose',
};

// The server's propertyMenu reply that drives which menu we render.
interface PropertyMenuInfo {
  target: number;
  view: 'owner' | 'manager' | 'keyholder' | 'claimable' | 'denied';
  owned: boolean;
  name: string | null;
  locked: boolean;
  canLock: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
  // "stable" | "farm" | "house" when pets are kept at this door, else ""
  pets: string;
}

// The server's petList reply: the pets storable at a door
interface PetListInfo {
  door: number;
  category: string;
  pets: unknown[];
}

// Module-level state shared with the browser-side widget setter via runtime injection
let info: PropertyMenuInfo = {
  target: 0, view: 'denied', owned: false, name: null, locked: false,
  canLock: false, hasKeys: false, canGrantContainers: false, ownerName: null, pets: '',
};
let targetLabel = '';
let petList: PetListInfo = { door: 0, category: '', pets: [] };

// Doors and containers are the bases the server can claim
export function isPropertyRef(ref: ObjectReference): boolean {
  if (Actor.from(ref)) return false;
  const base = ref.getBaseObject();
  if (!base || ObjectReferenceEx.isUntouchable(base)) return false;
  const type = base.getType();
  return type === FormType.Door || type === FormType.Container;
}

/**
 * Property menu on the interact key (default X, routed by PlayerActionService).
 * Aim at a door or container and press the key: the client asks the server
 * what it may do there and renders the matching menu. Anything the server does
 * not treat as property gets a "That cannot be claimed." notice instead.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "propertyInfoRequest", "target": <id> }
 *   Server -> Client: { "customPacketType": "propertyMenu", "target", "view", "owned",
 *                       "name", "locked", "canLock", "hasKeys", "canGrantContainers", "ownerName", "pets" }
 *   Client -> Server: { "customPacketType": "propertyRequest", "action", "target",
 *                       "recipient"?, "name"? }
 *   Server -> Client: { "customPacketType": "propertyNotice", "text" }
 *   Client -> Server: { "customPacketType": "petRequest", "action": "list", "door" }
 *   Server -> Client: { "customPacketType": "petList", "door", "category", "pets" }
 *   Client -> Server: { "customPacketType": "petRequest", "action": "summon", "uid", "door" }
 *
 * Views: 'denied' shows only "You don't own this" ('denied' with owned false
 * means not property); 'claimable' adds a claim button; 'owner' offers
 * rename/keys/lock/transfer/abandon; 'manager' (admin, jarl or steward) offers
 * grant/revoke/rename, and lock only when canLock is set; 'keyholder' offers
 * lock/unlock. Transfer and grant-container are two-step: pick the action,
 * then look at the recipient and press the interact key again. A non-empty
 * pets category adds the Pets option: it swaps the menu for the petList widget
 * of the pets kept at that door, each with a Summon button.
 */
export class HousingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden) this.closeOpen(); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; this.listOpen = false; });
  }

  get isOpen(): boolean {
    return this.menuOpen || this.listOpen;
  }

  // Second step of transfer / grant-container: consumes the pending pick with the crosshair's player
  takePendingPick(): boolean {
    if (this.pendingRecipient === null) return false;
    const pending = this.pendingRecipient;
    this.pendingRecipient = null;
    if (Date.now() > pending.expiresAt) {
      notifyNextUpdate(this.controller, this.sp, "That hand-over expired.");
      return true;
    }
    const ref = this.sp.Game.getCurrentCrosshairRef();
    const recipient = ref && Actor.from(ref) ? ref : null;
    if (!recipient || recipient.getFormID() === 0x14) {
      notifyNextUpdate(this.controller, this.sp, "Cancelled - that is not a person.");
      return true;
    }
    sendCustomPacket(this.controller, {
      customPacketType: "propertyRequest",
      action: pending.action,
      target: pending.target,
      recipient: localIdToRemoteId(recipient.getFormID()),
    });
    return true;
  }

  requestMenuFor(ref: ObjectReference): void {
    this.target = localIdToRemoteId(ref.getFormID());
    if (!this.target) {
      notifyNextUpdate(this.controller, this.sp, NOT_PROPERTY_TEXT);
      return;
    }
    targetLabel = (ref.getDisplayName() || "").trim() || "Property";
    logTrace(this, `Requesting property info for`, targetLabel, `(${this.target})`);
    this.awaitingAt = Date.now();
    sendCustomPacket(this.controller, { customPacketType: "propertyInfoRequest", target: this.target });
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.isDown && this.isOpen && buttonEventKeyCode(e) === DxScanCode.Escape) {
      this.closeOpen();
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "propertyMenu": {
        const target = Number(content["target"]) || this.target;
        // The reply names the pair's primary door, not always the side that was asked about
        const requested = Date.now() - this.awaitingAt < REPLY_WAIT_MS;
        this.awaitingAt = 0;
        // Only a refresh of the open menu or the reply to the last request shows, never over a screen that took focus meanwhile
        if (!this.menuOpen && (!requested || this.sp.browser.isFocused())) break;
        const view = content["view"];
        const owned = content["owned"] === true;
        if (view === 'denied' && !owned) {
          if (this.menuOpen) this.closeMenu();
          notifyNextUpdate(this.controller, this.sp, NOT_PROPERTY_TEXT);
          break;
        }
        info = {
          target,
          view: view === 'owner' || view === 'manager' || view === 'keyholder' || view === 'claimable' ? view : 'denied',
          owned,
          name: typeof content["name"] === "string" ? content["name"] as string : null,
          locked: content["locked"] === true,
          // An older server sends no canLock; its view alone decides then
          canLock: content["canLock"] !== false,
          hasKeys: content["hasKeys"] === true,
          canGrantContainers: content["canGrantContainers"] === true,
          ownerName: typeof content["ownerName"] === "string" ? content["ownerName"] as string : null,
          pets: typeof content["pets"] === "string" ? content["pets"] as string : "",
        };
        this.openMenu();
        break;
      }
      case "petList": {
        const requested = Date.now() - this.listAwaitingAt < REPLY_WAIT_MS;
        this.listAwaitingAt = 0;
        if (!this.listOpen && (!requested || this.sp.browser.isFocused())) break;
        petList = {
          door: Number(content["door"]) || 0,
          category: typeof content["category"] === "string" ? content["category"] as string : "",
          pets: Array.isArray(content["pets"]) ? content["pets"] : [],
        };
        this.openPetList();
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
      this.closeOpen();
      return;
    }
    if (key === petListEvents.summon || key === petListEvents.close) {
      if (!this.listOpen) return;
      if (key === petListEvents.summon) {
        const uid = typeof e.arguments[1] === "string" ? e.arguments[1] as string : "";
        if (uid) sendCustomPacket(this.controller, { customPacketType: "petRequest", action: "summon", uid, door: petList.door });
      }
      this.closePetList();
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
          expiresAt: Date.now() + PENDING_RECIPIENT_MS,
        };
        this.closeMenu();
        notifyNextUpdate(this.controller, this.sp, "Look at the recipient and press the interact key.");
        break;
      }
      case events.pets:
        this.closeMenu();
        this.listAwaitingAt = Date.now();
        sendCustomPacket(this.controller, { customPacketType: "petRequest", action: "list", door: target });
        break;
      case events.cancel:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, targetLabel, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  private openPetList(): void {
    this.listOpen = true;
    openFormMenu(this.sp, this.petListWidgetSetter, { petListEvents, petList, PET_LIST_WIDGET_ID }, this.controller);
  }

  private closePetList(): void {
    this.listOpen = false;
    closeFormMenu(this.sp, PET_LIST_WIDGET_ID);
  }

  // Whichever of the property menu and the pet list is open
  private closeOpen(): void {
    if (this.menuOpen) this.closeMenu();
    if (this.listOpen) this.closePetList();
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
      canLock: info.canLock,
      hasKeys: info.hasKeys,
      canGrantContainers: info.canGrantContainers,
      ownerName: info.ownerName,
      pets: info.pets,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  // Runs inside the CEF browser. Only injected vars + window are available.
  private petListWidgetSetter = () => {
    const widget = {
      type: "petList",
      id: PET_LIST_WIDGET_ID,
      category: petList.category,
      pets: petList.pets,
      events: petListEvents,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== PET_LIST_WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private listOpen = false;
  private target = 0;
  private awaitingAt = 0;
  private listAwaitingAt = 0;
  private pendingRecipient: { action: string; target: number; expiresAt: number } | null = null;
}
