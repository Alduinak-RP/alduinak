import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, isGameInputBlocked, isMenuHotkeyBlocked, isPlayerDowned, isUiHidden, readMenuKeyCode, buttonEventKeyCode, onWidgetsCleared, armHeldMenu, claimHeldMenu, closeContainerMenu } from "./widgetMenuUtil";
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
import { ActivationService } from "./activationService";
import { ItemService } from "./itemService";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;
const PLAYER_FORM_ID = 0x14;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
// Skyrim.esm weapBasicKnife01, the knife the server asks of a skinner
const HUNTING_KNIFE_ID = 0x0001f25a;
// The menu waits up to this long for the server's answer so no row moves under the cursor; an older server never answers
const MENU_STATE_WAIT_MS = 500;

// Server-spawned NPCs share the dynamic id space; only player characters carry an appearance
export const isPlayerCharacterId = (controller: CombinedController, remoteId: number): boolean =>
  remoteId >= FIRST_DYNAMIC_REMOTE_ID && !!controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === remoteId)?.appearance;

interface PlayerAction {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

// Character interaction menu, kept intentionally small (Trade is a dedicated button above these).
const ACTIONS: PlayerAction[] = [
  { id: 'givePotion', label: 'Give Potion' },
  { id: 'introduce', label: 'Introduce' },
  { id: 'search', label: 'Search' },
  { id: 'capture', label: 'Restrain', danger: true },
  { id: 'carry', label: 'Carry' },
  { id: 'release', label: 'Release' },
  { id: 'finishOff', label: 'Finish Off', danger: true },
  { id: 'prepareExecution', label: 'Prepare Execution', danger: true },
  { id: 'execute', label: 'Execute', danger: true },
  { id: 'assassinate', label: 'Assassinate', danger: true },
  { id: 'factionRecruit', label: 'Recruit' },
];

// A player-placed item; the server's itemMenuState says which apply
const ITEM_PICKUP: PlayerAction = { id: 'itemPickup', label: 'Pick Up' };
const ITEM_MOVE: PlayerAction = { id: 'itemMove', label: 'Move' };
const ITEM_NAIL: PlayerAction = { id: 'itemNail', label: 'Nail Down' };
const ITEM_PRY: PlayerAction = { id: 'itemPry', label: 'Pry Free' };

// Every action goes to the server systems as a custom packet (by server form id).
const PACKET_ACTIONS: Record<string, string> = {
  introduce: 'introduceRequest',
  search: 'searchRequest',
  capture: 'captureRequest',
  carry: 'carryRequest',
  release: 'releaseRequest',
  givePotion: 'givePotionRequest',
  finishOff: 'finishOffRequest',
  prepareExecution: 'prepareExecutionRequest',
  execute: 'executeRequest',
  assassinate: 'assassinateRequest',
  factionRecruit: 'factionRecruitRequest',
};

// Actions shown only when the server's playerMenuState flag for this target says they apply; Release keeps its older flag name
const SERVER_FLAGS: Record<string, string> = {
  release: 'canRelease',
  givePotion: 'givePotion',
  finishOff: 'finishOff',
  prepareExecution: 'prepareExecution',
  execute: 'execute',
  assassinate: 'assassinate',
};

// A dead player's body a hunter may skin (the server's playerMenuState skin flag) opens these instead of the search window
const BODY_SEARCH: PlayerAction = { id: 'search', label: 'Search' };
const BODY_SKIN: PlayerAction = { id: 'skin', label: 'Skin' };
const BODY_SKIN_TIRED: PlayerAction = { id: 'skin', label: 'Skin (too tired)', disabled: true };

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
 * player interaction menu on a living player character and search a body (the
 * server refuses others' pets); a dead player's body opens a Search and Skin
 * menu instead when the player holds a hunting knife and the server's
 * playerMenuState says they may skin it; a living server NPC is only taunted, which does
 * nothing yet; the InteractionPromptService blocks the clone's engine activation
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
    onCustomPacket(this.controller, ["itemMenuState", "playerMenuState"], (content) => this.onCustomPacketMessage(content));
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
      if (isInteract && this.holdMode && this.menuWaitHeld) armHeldMenu(this.sp, this.controller, this.interactKey);
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
    this.menuWaitHeld = isInteract && this.holdMode;
    this.containerAsked = false;

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
    // Any other living server NPC is taunted, which does nothing yet; its body is searched once it is dead
    if (ref && actor && remoteId >= FIRST_DYNAMIC_REMOTE_ID) {
      try { ref.blockActivation(true); } catch { /* unloaded ref */ }
      return;
    }
    if (isActivate) return;
    // A menu left open without focus (F6) is still on screen
    if (housing.isOpen || personal.isOpen || pets.isOpen) return;
    // The server opens the strongbox for the hold's managers and answers everyone else with a notice
    if (ref && this.controller.lookupListener(InteractionPromptService).isBoard(ref)) {
      sendCustomPacket(this.controller, { customPacketType: "bountyBoardManage", board: localIdToRemoteId(ref.getFormID()) });
      this.containerAsked = true;
      return;
    }
    if (ref && isPropertyRef(ref)) {
      housing.requestMenuFor(ref);
      return;
    }
    if (ref && this.controller.lookupListener(ItemService).isItem(ref)) {
      this.interactWithItem(ref);
      return;
    }
    const load = this.controller.lookupListener(JobService).load;
    if (load) {
      this.openLoadMenu(load);
      return;
    }
    if (claimHeldMenu(() => personal.isOpen, () => personal.closeMenu())) personal.open();
  }

  // The strongbox and the search window are the engine's container menu, which the server opens after the request
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Container || !this.containerAsked) return;
    this.containerAsked = false;
    const close = () => closeContainerMenu(this.sp, this.controller);
    if (!claimHeldMenu(() => this.sp.Ui.isMenuOpen(Menu.Container), close)) close();
  }

  // skin false is the body menu's Search, which never skins; without it a crouched hunter's request skins
  private requestSearch(remoteId: number, skin?: false): void {
    sendCustomPacket(this.controller, { customPacketType: PACKET_ACTIONS.search, target: remoteId, skin });
    this.containerAsked = true;
  }

  private openLoadMenu(title: string): void {
    targetName = title;
    this.playerTarget = 0;
    this.itemTarget = 0;
    if (!this.claimHeld()) return;
    this.menuOpen = true;
    openFormMenu(this.sp, this.playerWidgetSetter, { ACTIONS: LOAD_ACTIONS, targetName, hideTrade: true, events, WIDGET_ID }, this.controller);
  }

  private interactWithItem(ref: ObjectReference): void {
    targetName = ref.getDisplayName() || "Item";
    this.playerTarget = 0;
    this.bodyTarget = false;
    this.itemTarget = localIdToRemoteId(ref.getFormID());
    this.itemLocalId = ref.getFormID();
    this.itemState = null;
    sendCustomPacket(this.controller, { customPacketType: "itemMenuRequest", target: this.itemTarget });
    const wait = this.menuWait = ++this.menuWaitSeq;
    this.controller.lookupListener(TimersService).setTimeout(() => this.openWaitingMenu(wait), MENU_STATE_WAIT_MS);
  }

  private interactWithPlayer(ref: ObjectReference, actor: Actor, remoteId: number): void {
    this.itemTarget = 0;
    // Belt and braces next to the prompt service's block: no clone dialogue.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    // Bodies skip the menu and open their inventory through the server search, unless the server offers the skinning too
    this.bodyTarget = actor.isDead();
    if (this.bodyTarget && !this.holdsSkinningKnife(remoteId)) {
      this.requestSearch(remoteId);
      return;
    }
    targetName = introducedName(ref, remoteId, this.bodyTarget);
    this.playerTarget = remoteId;
    this.skin = "";
    // Flagged actions appear only when the server confirms they apply to this target
    this.menuFlags = {};
    this.hasPotion = false;
    sendCustomPacket(this.controller, { customPacketType: "playerMenuRequest", target: remoteId });
    logTrace(this, `Opening player-action menu for`, targetName);
    const wait = this.menuWait = ++this.menuWaitSeq;
    this.controller.lookupListener(TimersService).setTimeout(() => this.openWaitingMenu(wait), MENU_STATE_WAIT_MS);
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (content["customPacketType"] === "itemMenuState") {
      if (content["target"] !== this.itemTarget) return;
      this.itemState = { nailed: content["nailed"] === true, canPry: content["canPry"] === true, canNail: content["canNail"] === true };
      const wait = this.menuWait;
      if (wait) this.controller.once("update", () => this.openWaitingMenu(wait));
      return;
    }
    if (content["target"] !== this.playerTarget) return;
    const flags: Record<string, boolean> = {};
    for (const [id, key] of Object.entries(SERVER_FLAGS)) flags[id] = content[key] === true;
    const hasPotion = content["hasPotion"] === true;
    const skin = content["skin"] !== true ? "" : content["skinTired"] === true ? "tired" : "ready";
    const changed = hasPotion !== this.hasPotion || skin !== this.skin || Object.keys(flags).some((id) => flags[id] !== !!this.menuFlags[id]);
    this.menuFlags = flags;
    this.hasPotion = hasPotion;
    this.skin = skin;
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
    // A body nobody may skin, or an older server's silence, is searched as before
    if (this.bodyTarget && !this.skin) this.requestSearch(this.playerTarget);
    // A nailed item its viewer may not pry offers nothing, and an unanswered request opens nothing
    else if (this.itemTarget && !(this.menuArgs().ACTIONS as PlayerAction[]).length) return;
    else if (!this.menuOpen && !isMenuHotkeyBlocked(this.sp, this.controller)) this.openMenu();
  }

  // Only a player's body is skinned through the menu, and only with the knife, so every other body opens at once
  private holdsSkinningKnife(remoteId: number): boolean {
    if (!isPlayerCharacterId(this.controller, remoteId)) return false;
    try {
      const knife = this.sp.Game.getFormEx(HUNTING_KNIFE_ID);
      return !!knife && (this.sp.Game.getPlayer()?.getItemCount(knife) ?? 0) > 0;
    } catch {
      return false;
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
      if (this.itemTarget) {
        this.itemAction(actionId);
        this.closeMenu();
        return;
      }
      const packetType = PACKET_ACTIONS[actionId];
      if (this.bodyTarget && this.playerTarget) {
        // The search opens the engine's container menu; the server takes the same request with skin true as the skinning
        if (actionId === BODY_SKIN.id) sendCustomPacket(this.controller, { customPacketType: PACKET_ACTIONS.search, target: this.playerTarget, skin: true });
        else if (actionId === BODY_SEARCH.id) this.requestSearch(this.playerTarget, false);
      } else if (packetType && this.playerTarget) {
        sendCustomPacket(this.controller, { customPacketType: packetType, target: this.playerTarget });
      } else if (packetType) {
        notifyNextUpdate(this.controller, this.sp, "Look at a player first.");
      }
      this.closeMenu();
      return;
    }
  }

  private itemAction(actionId: string): void {
    const target = this.itemTarget;
    if (actionId === ITEM_PICKUP.id) {
      this.controller.lookupListener(ActivationService).sendActivation(PLAYER_FORM_ID, target);
    } else if (actionId === ITEM_MOVE.id) {
      const ref = ObjectReference.from(this.sp.Game.getFormEx(this.itemLocalId));
      if (ref) this.controller.lookupListener(ItemService).startMove(ref);
    } else if (actionId === ITEM_NAIL.id || actionId === ITEM_PRY.id) {
      sendCustomPacket(this.controller, { customPacketType: actionId === ITEM_NAIL.id ? "itemNail" : "itemPry", target });
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
    if (this.itemTarget) {
      const st = this.itemState;
      const actions = !st ? [] : st.nailed ? (st.canPry ? [ITEM_PRY] : []) : [ITEM_PICKUP, ITEM_MOVE, st.canNail ? ITEM_NAIL : { ...ITEM_NAIL, disabled: true }];
      return { ACTIONS: actions, targetName, hideTrade: true, events, WIDGET_ID };
    }
    if (this.bodyTarget) {
      return { ACTIONS: [BODY_SEARCH, this.skin === "tired" ? BODY_SKIN_TIRED : BODY_SKIN], targetName, hideTrade: true, events, WIDGET_ID };
    }
    // No carry chains and no bound carriers: a carrying, carried or bound player is never offered Carry
    const noCarry = this.controller.lookupListener(RestraintService).isPoseLocked;
    const canRecruit = this.controller.lookupListener(FactionService).canRecruit;
    const actions = ACTIONS.filter((a) => (a.id !== 'carry' || !noCarry) && (!(a.id in SERVER_FLAGS) || this.menuFlags[a.id]) &&
      (a.id !== 'factionRecruit' || canRecruit)).map((a) => a.id === 'givePotion' && !this.hasPotion ? { ...a, disabled: true } : a);
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
  // The last press asked the server for a bounty board's strongbox or a search window
  private containerAsked = false;
  private playerTarget = 0;
  // The placed item the menu is for, by server and local id, and what the server said about it
  private itemTarget = 0;
  private itemLocalId = 0;
  private itemState: { nailed: boolean; canPry: boolean; canNail: boolean } | null = null;
  // The menu's target is a dead player's body, and what the server said about skinning it: "", "ready" or "tired"
  private bodyTarget = false;
  private skin = "";
  // Action id -> whether the server's playerMenuState says it applies to the target
  private menuFlags: Record<string, boolean> = {};
  // Whether the server found a healing potion on this player for Give Potion
  private hasPotion = false;
  // Token of the open waiting for the server's answer, 0 when none
  private menuWait = 0;
  private menuWaitSeq = 0;
  // Whether the press the waiting menu answers was a held interact press
  private menuWaitHeld = false;
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
