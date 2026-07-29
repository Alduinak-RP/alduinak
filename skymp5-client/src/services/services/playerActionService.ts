import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode } from "./widgetMenuUtil";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;

interface PlayerAction {
  id: string;
  label: string;
}

// Kept intentionally small: the character interaction menu (Trade is a
// dedicated button above these).
const ACTIONS: PlayerAction[] = [
  { id: 'introduce', label: 'Introduce' },
  { id: 'search', label: 'Search' },
  { id: 'capture', label: 'Restrain' },
  { id: 'carry', label: 'Carry' },
  { id: 'putdown', label: 'Put down' },
  { id: 'release', label: 'Release' },
];

// Every action goes to the server systems as a custom packet (by server form id).
const PACKET_ACTIONS: Record<string, string> = {
  introduce: 'introduceRequest',
  search: 'searchRequest',
  capture: 'captureRequest',
  carry: 'carryRequest',
  putdown: 'putdownRequest',
  release: 'releaseRequest',
};

const events = {
  action: 'pa:action',
  close: 'pa:close',
  trade: 'pa:trade',
};

// Module-level so the browser-side widget setter can read it (runtime injection).
let targetName = '';

/**
 * Look-at-target interaction menu (default Y). Looking at a player opens the
 * player-action / hold-appointment menu. Doors and containers are managed by
 * the housing key (HousingService). Drives the gamemode through its existing
 * contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

    this.menuKey = readMenuKeyCode(this.sp, "interactMenuKeyCode", DxScanCode.Y);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // Gamepad idCodes are bitmasks that alias onto keyboard scancodes
    if (e.device !== InputDeviceType.Keyboard) return;
    // Escape closes an open menu.
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (this.sp.browser.isFocused()) {
      return;
    }

    const ref = this.sp.Game.getCurrentCrosshairRef();
    if (!ref) {
      notifyNextUpdate(this.controller, this.sp, "Look at a player.");
      return;
    }

    const actor = Actor.from(ref);
    if (actor && ref.getFormID() !== 0x14) {
      targetName = (ref.getName() || "").trim();
      this.playerTarget = localIdToRemoteId(ref.getFormID());
      // Names stay hidden until introduced (ff_knownIds owner prop)
      if (!targetName || !this.knowsTarget(this.playerTarget)) {
        targetName = "Stranger";
      }
      logTrace(this, `Opening player-action menu for`, targetName);
      this.openMenu();
    } else if (!actor) {
      notifyNextUpdate(this.controller, this.sp, "Press H to manage doors and containers.");
    } else {
      notifyNextUpdate(this.controller, this.sp, "Look at a player.");
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("pa:") || !this.menuOpen) {
      return;
    }
    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.trade) {
      if (this.playerTarget) {
        sendCustomPacket(this.controller, { customPacketType: "tradeRequest", recipient: this.playerTarget });
      }
      this.closeMenu();
      return;
    }
    if (key === events.action) {
      const actionId = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      const packetType = PACKET_ACTIONS[actionId];
      if (packetType && this.playerTarget) {
        sendCustomPacket(this.controller, { customPacketType: packetType, target: this.playerTarget });
      } else if (packetType) {
        notifyNextUpdate(this.controller, this.sp, "Look at a player first.");
      }
      this.closeMenu();
      return;
    }
  }

  // True when the local player's ff_knownIds list contains the remote actor id.
  // A missing list (gamemode without the introduce feature) shows real names.
  private knowsTarget(remoteId: number): boolean {
    if (this.sp.storage["ownerModelSet"] !== true) {
      return true;
    }
    const owner = this.sp.storage["ownerModel"] as Record<string, unknown> | undefined;
    const known = owner ? owner["ff_knownIds"] : undefined;
    if (!Array.isArray(known)) {
      return true;
    }
    return known.includes(remoteId);
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.playerWidgetSetter, { ACTIONS, targetName, events, WIDGET_ID });
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private playerWidgetSetter = () => {
    const elements: any[] = [];
    elements.push({ type: "button", text: "Trade", tags: [], click: () => window.skyrimPlatform.sendMessage(events.trade) });
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i];
      elements.push({ type: "button", text: a.label, tags: [], click: () => window.skyrimPlatform.sendMessage(events.action, a.id) });
    }
    elements.push({ type: "button", text: "close", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.close) });

    const widget = { type: "form", id: WIDGET_ID, caption: "Actions: " + targetName, elements: elements };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.Y;
  private menuOpen = false;
  private playerTarget = 0;
}
