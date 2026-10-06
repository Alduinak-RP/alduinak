import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, isGameInputBlocked, isMenuHotkeyBlocked, isPlayerDowned, isUiHidden, isConsoleOpen, readMenuKeyCode, buttonEventKeyCode, onWidgetsCleared, armHeldMenu, claimHeldMenu, closeContainerMenu, keyLabel } from "./widgetMenuUtil";
import { HousingService, isPropertyRef } from "./housingService";
import { FactionService } from "./factionService";
import { AdminMenuService, hex } from "./adminMenuService";
import { isFreeCamera } from "./adminModeService";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, FormType, Menu, MenuOpenEvent, ObjectReference } from "skyrimPlatform";
import { introducedName, localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { ModelApplyUtils } from "../../view/modelApplyUtils";
import { logTrace, logToPlatformLog } from "../../logging";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { TimersService } from "./timersService";
import { PetService } from "./petService";
import { MountService } from "./mountService";
import { JobService } from "./jobService";
import { InteractionPromptService } from "./interactionPromptService";
import { ActivationService } from "./activationService";
import { ItemService } from "./itemService";
import { loc } from "../../loc";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;
const PLAYER_FORM_ID = 0x14;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
// Skyrim.esm weapBasicKnife01, the knife the server asks of a skinner
const HUNTING_KNIFE_ID = 0x0001f25a;
// The menu waits up to this long for the server's answer so no row moves under the cursor; an older server never answers
const MENU_STATE_WAIT_MS = 500;
// The close reason of a menu a held interact key let go of
const HELD_RELEASE = "the held key was let go";

// Server-spawned NPCs share the dynamic id space; only player characters carry an appearance
export const isPlayerCharacterId = (controller: CombinedController, remoteId: number): boolean =>
  remoteId >= FIRST_DYNAMIC_REMOTE_ID && !!controller.lookupListener(RemoteServer).getFormByRefrId(remoteId)?.appearance;

interface PlayerAction {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

// Character interaction menu, kept intentionally small (Trade is a dedicated button above these).
const ACTIONS: PlayerAction[] = [
  { id: 'givePotion', label: loc("playerAction.menu.givePotion") },
  { id: 'introduce', label: loc("playerAction.menu.introduce") },
  { id: 'search', label: loc("playerAction.menu.search") },
  { id: 'capture', label: loc("playerAction.menu.capture"), danger: true },
  { id: 'carry', label: loc("playerAction.menu.carry") },
  { id: 'release', label: loc("playerAction.menu.release") },
  { id: 'finishOff', label: loc("playerAction.menu.finishOff"), danger: true },
  { id: 'prepareExecution', label: loc("playerAction.menu.prepareExecution"), danger: true },
  { id: 'execute', label: loc("playerAction.menu.execute"), danger: true },
  { id: 'assassinate', label: loc("playerAction.menu.assassinate"), danger: true },
  { id: 'factionRecruit', label: loc("playerAction.menu.factionRecruit") },
];

// A player-placed item; the server's itemMenuState says which apply
const ITEM_PICKUP: PlayerAction = { id: 'itemPickup', label: loc("playerAction.menu.itemPickup") };
const ITEM_MOVE: PlayerAction = { id: 'itemMove', label: loc("playerAction.menu.itemMove") };
const ITEM_NAIL: PlayerAction = { id: 'itemNail', label: loc("playerAction.menu.itemNail") };
const ITEM_PRY: PlayerAction = { id: 'itemPry', label: loc("playerAction.menu.itemPry") };

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
const BODY_SEARCH: PlayerAction = { id: 'search', label: loc("playerAction.menu.search") };
const BODY_SKIN: PlayerAction = { id: 'skin', label: loc("playerAction.menu.skin") };
const BODY_SKIN_TIRED: PlayerAction = { id: 'skin', label: loc("playerAction.menu.skinTired"), disabled: true };

// While a passive job load is carried: Put down joins the menu, and the interact key on nothing opens this one first
const PUT_DOWN: PlayerAction = { id: 'putDown', label: loc("playerAction.menu.putDown") };
const LOAD_ACTIONS: PlayerAction[] = [PUT_DOWN, { id: 'personal', label: loc("playerAction.menu.personal") }];

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
    this.controller.emitter.on("openContainerMessage", (e) => this.onOpenContainer(e.message.target));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu("the interface was hidden"); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; });
    this.launcherInteractKeyCode = readMenuKeyCode(this.sp, "altInteractKeyCode", DxScanCode.X) || DxScanCode.X;
    this.interactKey = this.launcherInteractKeyCode;
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!e.isDown) return;
    const code = buttonEventKeyCode(e);
    if (code === DxScanCode.Escape && this.menuOpen) {
      this.closeMenu("Escape");
      return;
    }
    // When one key is both, the Activate rules win
    const isActivate = e.userEventName === "Activate";
    const isInteract = !isActivate && code === this.interactKey;
    if (!isActivate && !isInteract) return;
    const outcome = this.routePress(isActivate, isInteract);
    // One line per interact press, so a key that seems dead reads from skyrim-platform.log; in hold mode the release closes the menu
    if (isInteract) logToPlatformLog(this, `${keyLabel(code)} press${this.holdMode ? " (hold mode)" : ""}: ${outcome}`);
  }

  // Returns what the press did, or why it was ignored
  private routePress(isActivate: boolean, isInteract: boolean): string {
    if (this.menuOpen) return "ignored, the interaction menu is open";
    if (this.menuWait) {
      // A second press during the wait is the one the waiting menu follows
      if (isInteract && this.holdMode && this.menuWaitHeld) armHeldMenu(this.sp, this.controller, this.interactKey);
      return "ignored, a menu is waiting for the server's answer";
    }
    if (isGameInputBlocked(this.sp, this.controller)) {
      return `ignored, ${this.sp.browser.isFocused() ? "the page has focus" : isConsoleOpen(this.sp) ? "the console is open" : "a vanilla menu is open"}`;
    }
    if (isPlayerDowned(this.controller)) return "ignored, the player is down";
    // A hidden interface must not trap a rider, so the saddle is checked before the rest of the hotkey block
    const mount = this.controller.lookupListener(MountService);
    if (isActivate && mount.isMounted) {
      mount.dismountByKey();
      return "dismount";
    }
    if (isUiHidden(this.controller)) return "ignored, the interface is hidden";
    // Every press replaces the armed one, so a menu Activate opens is never taken for a held one
    armHeldMenu(this.sp, this.controller, isInteract && this.holdMode ? this.interactKey : 0);
    this.menuWaitHeld = isInteract && this.holdMode;
    this.containerAsked = false;
    this.strongboxAsked = false;

    const housing = this.controller.lookupListener(HousingService);
    const personal = this.controller.lookupListener(AdminMenuService);
    const pets = this.controller.lookupListener(PetService);
    // The crosshair ref is stale in free camera, so X there always opens the Personal Menu, the only way out of Freecam
    const ref = isFreeCamera(this.sp) ? null : this.sp.Game.getCurrentCrosshairRef();
    const actor = ref && ref.getFormID() !== PLAYER_FORM_ID ? Actor.from(ref) : null;
    const remoteId = ref && actor ? localIdToRemoteId(ref.getFormID()) : 0;
    if (isInteract && (housing.takePendingPick() || pets.takePendingPick(remoteId))) return "completed a pending pick";
    // Command mode owns Activate on a living target and on the commanded pet itself; the interact key keeps opening the menus
    if (isActivate && ref && actor && !actor.isDead() && (pets.orderFollow(remoteId, ref) || pets.orderAttack(remoteId, ref))) return "pet order";

    if (ref && actor && (actor.isDead() ? remoteId >= FIRST_DYNAMIC_REMOTE_ID : isPlayerCharacterId(this.controller, remoteId))) {
      return this.interactWithPlayer(ref, actor, remoteId);
    }
    // A dead pet took the Search path above
    if (ref && actor && !actor.isDead() && pets.kindOf(remoteId)) {
      if (isInteract) {
        pets.openMenu(remoteId, ref);
        return `pet menu for ${hex(remoteId)}`;
      }
      pets.use(remoteId, ref);
      return "pet use";
    }
    // Any other living server NPC is taunted, which does nothing yet; its body is searched once it is dead
    if (ref && actor && remoteId >= FIRST_DYNAMIC_REMOTE_ID) {
      try { ref.blockActivation(true); } catch { /* unloaded ref */ }
      return `taunt of npc ${hex(remoteId)}`;
    }
    if (isActivate) return "left to the game";
    // A menu left open without focus (F6) is still on screen
    if (housing.isOpen || personal.isOpen || pets.isOpen) {
      return `ignored, the ${housing.isOpen ? "property" : personal.isOpen ? "Personal" : "pet"} menu is already open`;
    }
    // The server opens the strongbox for the hold's managers and answers everyone else with a notice
    if (ref && this.controller.lookupListener(InteractionPromptService).isBoard(ref)) {
      const board = localIdToRemoteId(ref.getFormID());
      sendCustomPacket(this.controller, { customPacketType: "bountyBoardManage", board });
      this.containerAsked = true;
      this.strongboxAsked = true;
      return `bountyBoardManage sent for ${hex(board)}`;
    }
    if (ref && isPropertyRef(ref)) {
      housing.requestMenuFor(ref);
      return `property menu requested for ${hex(localIdToRemoteId(ref.getFormID()))}`;
    }
    if (ref && this.controller.lookupListener(ItemService).isItem(ref)) {
      this.interactWithItem(ref);
      return `itemMenuRequest sent for ${hex(this.itemTarget)}`;
    }
    const load = this.controller.lookupListener(JobService).load;
    if (load) {
      this.openLoadMenu(load);
      return "load menu";
    }
    if (!claimHeldMenu(() => personal.isOpen, () => personal.closeMenu(HELD_RELEASE))) return "ignored, the held key was already let go";
    personal.open();
    return "Personal Menu opened";
  }

  // FormView gives a container the server's inventory only under the crosshair, which this press left on the board: the strongbox gets it here, before RemoteServer opens it
  private onOpenContainer(target: number): void {
    if (!this.strongboxAsked) return;
    this.strongboxAsked = false;
    this.controller.once("update", () => {
      const form = this.controller.lookupListener(RemoteServer).getFormByRefrId(target);
      const box = ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(target)));
      if (!form?.inventory || box?.getBaseObject()?.getType() !== FormType.Container) return;
      ModelApplyUtils.applyModelInventory(box, form.inventory);
      form.inventory = undefined;
    });
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
    this.openedAt = Date.now();
    openFormMenu(this.sp, this.playerWidgetSetter, { ACTIONS: LOAD_ACTIONS, targetName, hideTrade: true, events, WIDGET_ID }, this.controller);
  }

  private interactWithItem(ref: ObjectReference): void {
    targetName = ref.getDisplayName() || loc("playerAction.defaultItem");
    this.playerTarget = 0;
    this.bodyTarget = false;
    this.itemTarget = localIdToRemoteId(ref.getFormID());
    this.itemLocalId = ref.getFormID();
    this.itemState = null;
    sendCustomPacket(this.controller, { customPacketType: "itemMenuRequest", target: this.itemTarget });
    this.startMenuWait();
  }

  private interactWithPlayer(ref: ObjectReference, actor: Actor, remoteId: number): string {
    this.itemTarget = 0;
    // Belt and braces next to the prompt service's block: no clone dialogue.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    // Bodies skip the menu and open their inventory through the server search, unless the server offers the skinning too
    this.bodyTarget = actor.isDead();
    if (this.bodyTarget && !this.holdsSkinningKnife(remoteId)) {
      this.requestSearch(remoteId);
      return `searchRequest sent for body ${hex(remoteId)}`;
    }
    targetName = introducedName(ref, remoteId, this.bodyTarget);
    this.playerTarget = remoteId;
    this.skin = "";
    // Flagged actions appear only when the server confirms they apply to this target
    this.menuFlags = {};
    this.hasPotion = false;
    sendCustomPacket(this.controller, { customPacketType: "playerMenuRequest", target: remoteId });
    logTrace(this, `Opening player-action menu for`, targetName);
    this.startMenuWait();
    return `playerMenuRequest sent for ${this.bodyTarget ? "body " : ""}${hex(remoteId)} (${targetName})`;
  }

  // The menu opens on the server's answer or when the wait runs out, whichever comes first
  private startMenuWait(): void {
    this.menuAnswered = false;
    const wait = this.menuWait = ++this.menuWaitSeq;
    this.controller.lookupListener(TimersService).setTimeout(() => this.openWaitingMenu(wait, true), MENU_STATE_WAIT_MS);
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (content["customPacketType"] === "itemMenuState") {
      if (content["target"] !== this.itemTarget) return;
      this.itemState = { nailed: content["nailed"] === true, canPry: content["canPry"] === true, canNail: content["canNail"] === true };
      const wait = this.menuWait;
      if (wait) {
        this.menuAnswered = true;
        this.controller.once("update", () => this.openWaitingMenu(wait));
      }
      return;
    }
    if (content["target"] !== this.playerTarget) return;
    if (this.menuWait) this.menuAnswered = true;
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
  private openWaitingMenu(wait: number, timedOut = false): void {
    if (wait !== this.menuWait) return;
    this.menuWait = 0;
    // A nailed item its viewer may not pry offers nothing, and an unanswered item request opens nothing
    const offersNothing = !!this.itemTarget && !(this.menuArgs().ACTIONS as PlayerAction[]).length;
    // A body nobody may skin, or an older server's silence, is searched as before
    if (this.bodyTarget && !this.skin) this.requestSearch(this.playerTarget);
    else if (!offersNothing && !this.menuOpen && !isMenuHotkeyBlocked(this.sp, this.controller)) this.openMenu();
    if (!timedOut || this.menuAnswered) return;
    // A silent server side is the usual reason a menu "does nothing", so the unanswered packet is named in the log
    const packet = this.itemTarget ? "itemMenuRequest" : "playerMenuRequest";
    const result = this.bodyTarget && !this.skin ? "the body is searched" : this.menuOpen ? "the menu opened with the actions that need no answer" : "nothing opened";
    logToPlatformLog(this, `${packet} for ${hex(this.itemTarget || this.playerTarget)} unanswered after ${MENU_STATE_WAIT_MS} ms, ${result}`);
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
      if (this.menuOpen) this.closeMenu("Escape in the page");
      return;
    }
    if (typeof key !== "string" || !key.startsWith("pa:") || !this.menuOpen) {
      return;
    }
    if (key === events.close) {
      this.closeMenu("the page's close");
      return;
    }
    if (key === events.trade) {
      if (this.playerTarget) {
        sendCustomPacket(this.controller, { customPacketType: "tradeRequest", recipient: this.playerTarget });
      }
      this.closeMenu("Trade");
      return;
    }
    if (key === events.action) {
      const actionId = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      if (actionId === PUT_DOWN.id) {
        this.controller.lookupListener(JobService).putDown();
        this.closeMenu(`the ${actionId} action`);
        return;
      }
      if (actionId === "personal") {
        this.closeMenu(`the ${actionId} action`);
        // The Personal Menu reads the game as it opens, which only the update context allows
        this.controller.once("update", () => this.controller.lookupListener(AdminMenuService).open());
        return;
      }
      if (this.itemTarget) {
        this.itemAction(actionId);
        this.closeMenu(`the ${actionId} action`);
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
        notifyNextUpdate(this.controller, this.sp, loc("playerAction.lookAtPlayer"));
      }
      this.closeMenu(`the ${actionId} action`);
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
    this.openedAt = Date.now();
    openFormMenu(this.sp, this.playerWidgetSetter, this.menuArgs(), this.controller);
  }

  // A held interact key closes the menu on release, and one already let go keeps it shut
  private claimHeld(): boolean {
    return claimHeldMenu(() => this.menuOpen, () => this.closeMenu(HELD_RELEASE));
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

  // The reason and the age tell a menu that flashed from one that was used
  private closeMenu(reason: string): void {
    logToPlatformLog(this, `interaction menu closed ${Date.now() - this.openedAt} ms after the open, ${reason}`);
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
  private openedAt = 0;
  // Every menu the interact key opens is held open instead of toggled
  private holdMode = false;
  // The last press asked the server for a bounty board's strongbox or a search window
  private containerAsked = false;
  // The last press asked for a board's strongbox, whose open message has not come yet
  private strongboxAsked = false;
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
  // Token of the open waiting for the server's answer, 0 when none, and whether that answer came
  private menuWait = 0;
  private menuWaitSeq = 0;
  private menuAnswered = false;
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
