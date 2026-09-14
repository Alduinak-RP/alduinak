import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, isMenuHotkeyBlocked, readMenuKeyCode, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { HousingService, isPropertyRef } from "./housingService";
import { FactionService } from "./factionService";
import { AdminMenuService } from "./adminMenuService";
import { isFreeCamera } from "./adminModeService";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, ObjectReference } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;
const PLAYER_FORM_ID = 0x14;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;

// Server-spawned NPCs share the dynamic id space; only player characters carry an appearance
export const isPlayerCharacterId = (controller: CombinedController, remoteId: number): boolean =>
  remoteId >= FIRST_DYNAMIC_REMOTE_ID && !!controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === remoteId)?.appearance;

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
 * The one interact router. Both the game's own Activate control (default E;
 * every button event carries the live control map's user event name, so a
 * rebind applies at once on any device) and the interact key
 * (altInteractKeyCode, default X, launcher "Interact / Menus") open the
 * player interaction menu on a living player character and search a body;
 * the InteractionPromptService blocks the clone's engine activation so no
 * dialogue fires underneath. Activate leaves everything else to normal
 * activation. The interact key also completes a pending housing hand-over or
 * faction add-member pick first, asks HousingService for the property menu on
 * a door or container, and opens the Personal Menu (AdminMenuService) on
 * anything else or nothing. Drives the gamemode through its existing contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; });
    this.interactKey = readMenuKeyCode(this.sp, "altInteractKeyCode", DxScanCode.X) || DxScanCode.X;
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!e.isDown) return;
    const code = buttonEventKeyCode(e);
    if (code === DxScanCode.Escape && this.menuOpen) {
      this.closeMenu();
      return;
    }
    // When one key is both, the Activate rules win
    const isActivate = e.userEventName === "Activate";
    const isInteract = !isActivate && code === this.interactKey;
    if ((!isActivate && !isInteract) || this.menuOpen) return;
    if (isMenuHotkeyBlocked(this.sp, this.controller)) return;

    const housing = this.controller.lookupListener(HousingService);
    const personal = this.controller.lookupListener(AdminMenuService);
    if (isInteract && (housing.takePendingPick() || this.controller.lookupListener(FactionService).takePendingPick())) return;

    // The crosshair ref is stale in free camera, so X there always opens the Personal Menu, the only way out of Freecam
    const ref = isFreeCamera(this.sp) ? null : this.sp.Game.getCurrentCrosshairRef();
    const actor = ref && ref.getFormID() !== PLAYER_FORM_ID ? Actor.from(ref) : null;
    const remoteId = ref && actor ? localIdToRemoteId(ref.getFormID()) : 0;
    if (ref && actor && (actor.isDead() ? remoteId >= FIRST_DYNAMIC_REMOTE_ID : isPlayerCharacterId(this.controller, remoteId))) {
      this.interactWithPlayer(ref, actor, remoteId);
      return;
    }
    if (isActivate) return;
    // A menu left open without focus (F6) is still on screen
    if (housing.isOpen || personal.isOpen) return;
    if (ref && isPropertyRef(ref)) {
      housing.requestMenuFor(ref);
      return;
    }
    personal.open();
  }

  private interactWithPlayer(ref: ObjectReference, actor: Actor, remoteId: number): void {
    // Belt and braces next to the prompt service's block: no clone dialogue.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    // Bodies skip the menu and open their inventory through the server search
    if (actor.isDead()) {
      sendCustomPacket(this.controller, { customPacketType: PACKET_ACTIONS.search, target: remoteId });
      return;
    }
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
    const restraint = this.controller.lookupListener(RestraintService);
    // No carry chains: a carrier or a carried player is never offered Carry
    const actions = restraint.isCarrying || restraint.isCarried ? ACTIONS.filter((a) => a.id !== 'carry') : ACTIONS;
    openFormMenu(this.sp, this.playerWidgetSetter, { ACTIONS: actions, targetName, events, WIDGET_ID }, this.controller);
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
  private interactKey: number;
}
