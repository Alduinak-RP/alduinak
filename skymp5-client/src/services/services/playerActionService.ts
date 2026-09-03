import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, isMenuHotkeyBlocked } from "./widgetMenuUtil";
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

// Character interaction menu, kept intentionally small (Trade is a dedicated button above these).
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
 * Look-at-target interaction menu on the game's own Activate control: every
 * button event carries the user event name the live control map gives it, so
 * a rebind (Settings > Controls or the launcher's Game Hotkeys) applies at
 * once, default E. Activating a player character opens the player-action /
 * hold-appointment menu; the InteractionPromptService blocks the clone's
 * engine activation so no dialogue fires underneath. Everything that is not
 * a player character passes through to normal activation. Doors and
 * containers are managed by the housing key (HousingService). Drives the
 * gamemode through its existing contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!e.isDown) return;
    // Escape closes an open menu; gamepad idCodes alias onto keyboard scancodes, so only the keyboard counts here
    if (e.device === InputDeviceType.Keyboard && e.code === DxScanCode.Escape && this.menuOpen) {
      this.closeMenu();
      return;
    }
    // The engine stamps the live control map's event name on every device, so a rebind applies at once
    if (e.userEventName !== "Activate" || this.menuOpen) {
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) {
      return;
    }

    // The activate key fires on everything; only player characters are ours,
    // the rest passes through to normal activation without a word.
    const ref = this.sp.Game.getCurrentCrosshairRef();
    if (!ref || ref.getFormID() === 0x14) return;
    const actor = Actor.from(ref);
    if (!actor) return;
    const remoteId = localIdToRemoteId(ref.getFormID());
    if (!remoteId || remoteId < 0xff000000) return;

    // Belt and braces next to the prompt service's block: no clone dialogue.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    targetName = (ref.getName() || "").trim();
    this.playerTarget = remoteId;
    // Names stay hidden until introduced (ff_knownIds owner prop)
    if (!targetName || !this.knowsTarget(this.playerTarget)) {
      targetName = "Stranger";
    }
    logTrace(this, `Opening player-action menu for`, targetName);
    this.openMenu();
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
    openFormMenu(this.sp, this.playerWidgetSetter, { ACTIONS, targetName, events, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private playerWidgetSetter = () => {
    const widget = {
      type: "contextMenu",
      id: WIDGET_ID,
      targetName: targetName,
      actions: ACTIONS,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private playerTarget = 0;
}
