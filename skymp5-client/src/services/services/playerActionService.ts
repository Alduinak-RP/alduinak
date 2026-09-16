import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate, parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, isGameInputBlocked, isMenuHotkeyBlocked, isUiHidden, readMenuKeyCode, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { HousingService, isPropertyRef } from "./housingService";
import { FactionService } from "./factionService";
import { AdminMenuService } from "./adminMenuService";
import { isFreeCamera } from "./adminModeService";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, ObjectReference } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { TimersService } from "./timersService";
import { PetService } from "./petService";
import { MountService } from "./mountService";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;
const PLAYER_FORM_ID = 0x14;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
// The menu waits up to this long for the server's Release answer so no row moves under the cursor; an older server never answers
const MENU_STATE_WAIT_MS = 500;

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
  { id: 'release', label: 'Release' },
];

// Every action goes to the server systems as a custom packet (by server form id).
const PACKET_ACTIONS: Record<string, string> = {
  introduce: 'introduceRequest',
  search: 'searchRequest',
  capture: 'captureRequest',
  carry: 'carryRequest',
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
 * dialogue fires underneath. On a living pet or own summon the interact key
 * opens the pet menu and Activate uses it (PetService). In the saddle Activate
 * always dismounts (MountService), whatever the crosshair found. Activate leaves
 * everything else to normal activation. The interact key also completes a
 * pending housing hand-over, faction add-member or pet transfer pick first,
 * asks HousingService for the property menu on a door or container, and opens
 * the Personal Menu (AdminMenuService) on anything else or nothing. Drives the
 * gamemode through its existing contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
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
    if ((!isActivate && !isInteract) || this.menuOpen || this.menuWait) return;
    if (isGameInputBlocked(this.sp, this.controller)) return;
    // A hidden interface must not trap a rider, so the saddle is checked before the rest of the hotkey block
    const mount = this.controller.lookupListener(MountService);
    if (isActivate && mount.isMounted) {
      mount.dismountByKey();
      return;
    }
    if (isUiHidden(this.controller)) return;

    const housing = this.controller.lookupListener(HousingService);
    const personal = this.controller.lookupListener(AdminMenuService);
    const pets = this.controller.lookupListener(PetService);
    // The crosshair ref is stale in free camera, so X there always opens the Personal Menu, the only way out of Freecam
    const ref = isFreeCamera(this.sp) ? null : this.sp.Game.getCurrentCrosshairRef();
    const actor = ref && ref.getFormID() !== PLAYER_FORM_ID ? Actor.from(ref) : null;
    const remoteId = ref && actor ? localIdToRemoteId(ref.getFormID()) : 0;
    if (isInteract && (housing.takePendingPick() || this.controller.lookupListener(FactionService).takePendingPick() || pets.takePendingPick(remoteId))) return;

    if (ref && actor && (actor.isDead() ? remoteId >= FIRST_DYNAMIC_REMOTE_ID : isPlayerCharacterId(this.controller, remoteId))) {
      this.interactWithPlayer(ref, actor, remoteId);
      return;
    }
    // A dead pet took the Search path above
    if (ref && actor && !actor.isDead() && pets.kindOf(remoteId)) {
      if (isInteract) pets.openMenu(remoteId, ref);
      else pets.use(remoteId, ref);
      return;
    }
    if (isActivate) return;
    // A menu left open without focus (F6) is still on screen
    if (housing.isOpen || personal.isOpen || pets.isOpen) return;
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
    // Release appears only when the server confirms it applies to this target
    this.canRelease = false;
    sendCustomPacket(this.controller, { customPacketType: "playerMenuRequest", target: remoteId });
    // Names stay hidden until introduced (ff_knownIds owner prop)
    if (!targetName || !this.knowsTarget(this.playerTarget)) {
      targetName = "Stranger";
    }
    logTrace(this, `Opening player-action menu for`, targetName);
    const wait = this.menuWait = ++this.menuWaitSeq;
    this.controller.lookupListener(TimersService).setTimeout(() => this.openWaitingMenu(wait), MENU_STATE_WAIT_MS);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "playerMenuState" || content["target"] !== this.playerTarget) return;
    const canRelease = content["canRelease"] === true;
    const changed = canRelease !== this.canRelease;
    this.canRelease = canRelease;
    const wait = this.menuWait;
    if (wait) {
      // Native calls are unsafe in the packet handler
      this.controller.once("update", () => this.openWaitingMenu(wait));
    } else if (changed && this.menuOpen) {
      refreshFormMenu(this.sp, this.playerWidgetSetter, this.menuArgs());
    }
  }

  // Opens once the Release answer is in or the wait ran out, unless another screen took over meanwhile
  private openWaitingMenu(wait: number): void {
    if (wait !== this.menuWait) return;
    this.menuWait = 0;
    if (!this.menuOpen && !isMenuHotkeyBlocked(this.sp, this.controller)) this.openMenu();
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
    openFormMenu(this.sp, this.playerWidgetSetter, this.menuArgs(), this.controller);
  }

  private menuArgs(): Record<string, unknown> {
    // No carry chains and no bound carriers: a carrying, carried or bound player is never offered Carry
    const noCarry = this.controller.lookupListener(RestraintService).isPoseLocked;
    const actions = ACTIONS.filter((a) => (a.id !== 'carry' || !noCarry) && (a.id !== 'release' || this.canRelease));
    return { ACTIONS: actions, targetName, events, WIDGET_ID };
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
  private canRelease = false;
  // Token of the open waiting for the server's Release answer, 0 when none
  private menuWait = 0;
  private menuWaitSeq = 0;
  private interactKey: number;
}
