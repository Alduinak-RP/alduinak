import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate, parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, isGameInputBlocked, isMenuHotkeyBlocked, isPlayerDowned, isUiHidden, readMenuKeyCode, buttonEventKeyCode, onWidgetsCleared, armHeldMenu, claimHeldMenu } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { HousingService, isPropertyRef } from "./housingService";
import { FactionService } from "./factionService";
import { AdminMenuService } from "./adminMenuService";
import { isFreeCamera } from "./adminModeService";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, Menu, MenuOpenEvent, ObjectReference } from "skyrimPlatform";
import { introducedName, localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { TimersService } from "./timersService";
import { PetService } from "./petService";
import { MountService } from "./mountService";
import { JobService } from "./jobService";
import { InteractionPromptService } from "./interactionPromptService";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;
const PLAYER_FORM_ID = 0x14;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
// The menu waits up to this long for the server's answer so no row moves under the cursor; an older server never answers
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
  { id: 'stabilize', label: 'Stabilize' },
  { id: 'finishOff', label: 'Finish Off' },
  { id: 'prepareExecution', label: 'Prepare Execution' },
  { id: 'execute', label: 'Execute' },
  { id: 'assassinate', label: 'Assassinate' },
  { id: 'factionRecruit', label: 'Recruit' },
];

// Every action goes to the server systems as a custom packet (by server form id).
const PACKET_ACTIONS: Record<string, string> = {
  introduce: 'introduceRequest',
  search: 'searchRequest',
  capture: 'captureRequest',
  carry: 'carryRequest',
  release: 'releaseRequest',
  stabilize: 'stabilizeRequest',
  finishOff: 'finishOffRequest',
  prepareExecution: 'prepareExecutionRequest',
  execute: 'executeRequest',
  assassinate: 'assassinateRequest',
  factionRecruit: 'factionRecruitRequest',
};

// Actions shown only when the server's playerMenuState flag for this target says they apply; Release keeps its older flag name
const SERVER_FLAGS: Record<string, string> = {
  release: 'canRelease',
  stabilize: 'stabilize',
  finishOff: 'finishOff',
  prepareExecution: 'prepareExecution',
  execute: 'execute',
  assassinate: 'assassinate',
};

// While a passive job load is carried: Put down joins the menu, and the interact key on nothing opens this one first
const PUT_DOWN: PlayerAction = { id: 'putDown', label: 'Put down' };
const LOAD_ACTIONS: PlayerAction[] = [PUT_DOWN, { id: 'personal', label: 'Personal Menu' }];

const events = {
  action: 'pa:action',
  close: 'pa:close',
  trade: 'pa:trade',
};

// Module-level so the browser-side widget setter can read it (runtime injection).
let targetName = '';
let hideTrade = false;

/**
 * The one interact router. Both the game's own Activate control (default E;
 * every button event carries the live control map's user event name, so a
 * rebind applies at once on any device) and the interact key
 * (altInteractKeyCode, default X, launcher "Interact / Menus") open the
 * player interaction menu on a living player character and search a body or
 * a living server NPC (the server refuses others' pets, animals and NPCs in
 * combat); the InteractionPromptService blocks the clone's engine activation
 * so no dialogue fires underneath. On a living pet or own summon the interact key
 * opens the pet menu and Activate uses it (PetService). In the saddle Activate
 * always dismounts (MountService), whatever the crosshair found. Activate leaves
 * everything else to normal activation. The interact key also completes a
 * pending housing hand-over or pet transfer pick first,
 * asks the server to open a bounty board's strongbox, asks HousingService for
 * the property menu on a door or container, and opens the Personal Menu
 * (AdminMenuService) on anything else or nothing. Drives the gamemode through
 * its existing contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; });
    this.launcherInteractKeyCode = readMenuKeyCode(this.sp, "altInteractKeyCode", DxScanCode.X) || DxScanCode.X;
    this.interactKey = this.launcherInteractKeyCode;
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
    if (this.menuWait) {
      // A second press during the wait is the one the waiting menu follows
      if (isInteract && this.holdMode) armHeldMenu(this.sp, this.controller, this.interactKey);
      return;
    }
    if (isGameInputBlocked(this.sp, this.controller) || isPlayerDowned(this.controller)) return;
    // A hidden interface must not trap a rider, so the saddle is checked before the rest of the hotkey block
    const mount = this.controller.lookupListener(MountService);
    if (isActivate && mount.isMounted) {
      mount.dismountByKey();
      return;
    }
    if (isUiHidden(this.controller)) return;
    // Every press replaces the armed one, so a menu Activate opens is never taken for a held one
    armHeldMenu(this.sp, this.controller, isInteract && this.holdMode ? this.interactKey : 0);
    this.strongboxAsked = false;

    const housing = this.controller.lookupListener(HousingService);
    const personal = this.controller.lookupListener(AdminMenuService);
    const pets = this.controller.lookupListener(PetService);
    // The crosshair ref is stale in free camera, so X there always opens the Personal Menu, the only way out of Freecam
    const ref = isFreeCamera(this.sp) ? null : this.sp.Game.getCurrentCrosshairRef();
    const actor = ref && ref.getFormID() !== PLAYER_FORM_ID ? Actor.from(ref) : null;
    const remoteId = ref && actor ? localIdToRemoteId(ref.getFormID()) : 0;
    if (isInteract && (housing.takePendingPick() || pets.takePendingPick(remoteId))) return;
    // Command mode owns Activate on a living target and on the commanded pet itself; the interact key keeps opening the menus
    if (isActivate && ref && actor && !actor.isDead() && (pets.orderFollow(remoteId, ref) || pets.orderAttack(remoteId, ref))) return;

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
    // Any other living server NPC is searched like a body
    if (ref && actor && remoteId >= FIRST_DYNAMIC_REMOTE_ID) {
      try { ref.blockActivation(true); } catch { /* unloaded ref */ }
      sendCustomPacket(this.controller, { customPacketType: PACKET_ACTIONS.search, target: remoteId });
      return;
    }
    if (isActivate) return;
    // A menu left open without focus (F6) is still on screen
    if (housing.isOpen || personal.isOpen || pets.isOpen) return;
    // The server opens the strongbox for the hold's managers and answers everyone else with a notice
    if (ref && this.controller.lookupListener(InteractionPromptService).isBoard(ref)) {
      sendCustomPacket(this.controller, { customPacketType: "bountyBoardManage", board: localIdToRemoteId(ref.getFormID()) });
      this.strongboxAsked = true;
      return;
    }
    if (ref && isPropertyRef(ref)) {
      housing.requestMenuFor(ref);
      return;
    }
    const load = this.controller.lookupListener(JobService).load;
    if (load) {
      this.openLoadMenu(load);
      return;
    }
    if (claimHeldMenu(() => personal.isOpen, () => personal.closeMenu())) personal.open();
  }

  // The strongbox is the engine's container menu, which the server opens after bountyBoardManage
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Container || !this.strongboxAsked) return;
    this.strongboxAsked = false;
    const close = () => this.controller.once("update", () => {
      // No close-menu API in SkyrimPlatform: tap the container's cancel key, as SearchService does
      if (this.sp.Ui.isMenuOpen(Menu.Container)) this.sp.Input.tapKey(DxScanCode.Tab);
    });
    if (!claimHeldMenu(() => this.sp.Ui.isMenuOpen(Menu.Container), close)) close();
  }

  private openLoadMenu(title: string): void {
    targetName = title;
    this.playerTarget = 0;
    if (!this.claimHeld()) return;
    this.menuOpen = true;
    openFormMenu(this.sp, this.playerWidgetSetter, { ACTIONS: LOAD_ACTIONS, targetName, hideTrade: true, events, WIDGET_ID }, this.controller);
  }

  private interactWithPlayer(ref: ObjectReference, actor: Actor, remoteId: number): void {
    // Belt and braces next to the prompt service's block: no clone dialogue.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    // Bodies skip the menu and open their inventory through the server search
    if (actor.isDead()) {
      sendCustomPacket(this.controller, { customPacketType: PACKET_ACTIONS.search, target: remoteId });
      return;
    }
    targetName = introducedName(ref, remoteId, false);
    this.playerTarget = remoteId;
    // Flagged actions appear only when the server confirms they apply to this target
    this.menuFlags = {};
    sendCustomPacket(this.controller, { customPacketType: "playerMenuRequest", target: remoteId });
    logTrace(this, `Opening player-action menu for`, targetName);
    const wait = this.menuWait = ++this.menuWaitSeq;
    this.controller.lookupListener(TimersService).setTimeout(() => this.openWaitingMenu(wait), MENU_STATE_WAIT_MS);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "playerMenuState" || content["target"] !== this.playerTarget) return;
    const flags: Record<string, boolean> = {};
    for (const [id, key] of Object.entries(SERVER_FLAGS)) flags[id] = content[key] === true;
    const changed = Object.keys(flags).some((id) => flags[id] !== !!this.menuFlags[id]);
    this.menuFlags = flags;
    const wait = this.menuWait;
    if (wait) {
      // Native calls are unsafe in the packet handler
      this.controller.once("update", () => this.openWaitingMenu(wait));
    } else if (changed && this.menuOpen) {
      refreshFormMenu(this.sp, this.playerWidgetSetter, this.menuArgs());
    }
  }

  // Opens once the server's answer is in or the wait ran out, unless another screen took over or a held key was let go meanwhile
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
      if (actionId === PUT_DOWN.id) {
        this.controller.lookupListener(JobService).putDown();
        this.closeMenu();
        return;
      }
      if (actionId === "personal") {
        this.closeMenu();
        // The Personal Menu reads the game as it opens, which only the update context allows
        this.controller.once("update", () => this.controller.lookupListener(AdminMenuService).open());
        return;
      }
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

  private openMenu(): void {
    if (!this.claimHeld()) return;
    this.menuOpen = true;
    openFormMenu(this.sp, this.playerWidgetSetter, this.menuArgs(), this.controller);
  }

  // A held interact key closes the menu on release, and one already let go keeps it shut
  private claimHeld(): boolean {
    return claimHeldMenu(() => this.menuOpen, () => this.closeMenu());
  }

  private menuArgs(): Record<string, unknown> {
    // No carry chains and no bound carriers: a carrying, carried or bound player is never offered Carry
    const noCarry = this.controller.lookupListener(RestraintService).isPoseLocked;
    const canRecruit = this.controller.lookupListener(FactionService).canRecruit;
    const actions = ACTIONS.filter((a) => (a.id !== 'carry' || !noCarry) && (!(a.id in SERVER_FLAGS) || this.menuFlags[a.id]) &&
      (a.id !== 'factionRecruit' || canRecruit));
    if (this.controller.lookupListener(JobService).load) actions.push(PUT_DOWN);
    return { ACTIONS: actions, targetName, hideTrade: false, events, WIDGET_ID };
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
      hideTrade: hideTrade,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  // Every menu the interact key opens is held open instead of toggled
  private holdMode = false;
  // The last press asked the server for a bounty board's strongbox
  private strongboxAsked = false;
  private playerTarget = 0;
  // Action id -> whether the server's playerMenuState says it applies to the target
  private menuFlags: Record<string, boolean> = {};
  // Token of the open waiting for the server's answer, 0 when none
  private menuWait = 0;
  private menuWaitSeq = 0;
  private interactKey: number;

  get interactKeyCode(): number {
    return this.interactKey;
  }

  // The launcher's key, which an in-game rebind from the chat settings overrides
  readonly launcherInteractKeyCode: number;

  setInteractKey(override: number): void {
    this.interactKey = override || this.launcherInteractKeyCode;
  }

  setHoldMode(hold: boolean): void {
    this.holdMode = hold;
  }
}
