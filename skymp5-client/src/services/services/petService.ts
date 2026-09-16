import { Actor, ActivateEvent, BrowserMessageEvent, ButtonEvent, DxScanCode, FormType, ObjectReference, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, isMenuHotkeyBlocked, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { isRemoteHostedByMe, localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { CompanionService, isOwnCompanion, setDrivenPetIds } from "./companionService";
import { EmoteService } from "./emoteService";
import { RemoteServer } from "./remoteServer";
import { isPlayerCharacterId } from "./playerActionService";
import { logTrace } from "../../logging";

// for the browser-side widget setters (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 29;
const PROMPT_WIDGET_ID = 31;
const OWN_PET_IDS_KEY = "ownPetIds";
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
const PENDING_RECIPIENT_MS = 30000;
// A petMenu answer older than this belongs to an abandoned request
const MENU_ANSWER_MS = 3000;
const TICK_MS = 250;
// Leatherworking bench idle on the owner; the chair exit stands it up again
const PET_ANIM = "IdleTanningEnter";
const PET_ANIM_EXITS = ["IdleChairExitStart", "IdleForceDefaultState"];
// A fleeing pet keeps this far ahead of its downed owner
const FLEE_OFFSET = 2048;
const FLEE_RADIUS = 128;
// Command mode ends on its own after this, so a forgotten one never keeps the interact key
const COMMAND_MODE_MS = 30000;

export type PetKind = "horse" | "livestock" | "dog";

// The neighbor-visible ff_pet property on a pet actor
export interface PetProp {
  kind: PetKind;
  name: string;
  owner: number;
  dead?: boolean;
  flee?: boolean;
  carried?: number;
}

interface OwnPet {
  uid: string;
  id: number;
  name: string;
  kind: PetKind;
  home: string;
  homeName: string;
  out: boolean;
}

interface PetAction {
  id: string;
  label: string;
}

const events = {
  action: "pet:action",
  close: "pet:close",
  trade: "pet:trade",
};

const promptEvents = {
  ok: "pet:rename",
  cancel: "pet:renameCancel",
};

// Module-level so the browser-side widget setters can read them (runtime injection).
let petMenuTitle = "";
let petMenuActions: PetAction[] = [];
let petMenuHideTrade = false;
let promptCaption = "";
let promptValue = "";

// The engine must not talk to, loot or mount the clone under our key
const blockActivation = (ref: ObjectReference): void => {
  try { ref.blockActivation(true); } catch { /* unloaded ref */ }
};

/**
 * Owner side of the server pet system (skymp5-server petSystem.ts, docs/docs_roleplay_pets.md).
 * PlayerActionService routes the interact keys on a living pet here: X asks the server
 * for the pet menu and renders petMenu as sent (contextMenu widget), E uses the pet
 * (mount a horse, harvest own livestock, command an own dog or summon). Also runs the
 * rename prompt, the transfer pick, the petting idle, the command mode with its
 * attack order and its no-furniture rule for dogs, the flee of a downed owner's pets,
 * and feeds the out dogs to CompanionService so they follow and fight like summons.
 */
export class PetService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("activate", (e) => this.onActivate(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionAccepted", () => this.setPets([]));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden) this.closeAll(); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; this.promptOpen = false; });
  }

  get isOpen(): boolean {
    return this.menuOpen || this.promptOpen;
  }

  // The ff_pet property of a pet actor, undefined for anything else
  petOf(remoteId: number): PetProp | undefined {
    if (remoteId < FIRST_DYNAMIC_REMOTE_ID) return undefined;
    const form = this.controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === remoteId);
    const pet = form ? (form as Record<string, unknown>)["ff_pet"] as PetProp | undefined : undefined;
    return pet && typeof pet === "object" && typeof pet.kind === "string" ? pet : undefined;
  }

  // "companion" for an own summon, the ff_pet kind for an own pet, "horse-foreign" for anyone else's horse, else ""
  kindOf(remoteId: number): string {
    if (isOwnCompanion(remoteId)) return "companion";
    const pet = this.petOf(remoteId);
    if (!pet) return "";
    if ((pet.owner >>> 0) === this.myId()) return pet.kind;
    return pet.kind === "horse" ? "horse-foreign" : "";
  }

  openMenu(remoteId: number, ref: ObjectReference): void {
    if (this.isOpen) return;
    blockActivation(ref);
    this.menuTarget = remoteId;
    this.menuRequestedAt = Date.now();
    sendCustomPacket(this.controller, { customPacketType: "petRequest", action: "menu", target: remoteId });
  }

  // E on a pet: any horse is mounted (stealing included), own livestock harvested, an own dog or summon commanded
  use(remoteId: number, ref: ObjectReference): void {
    const kind = this.kindOf(remoteId);
    if (!kind) return;
    blockActivation(ref);
    const action = kind === "horse" || kind === "horse-foreign" ? "mount" : "use";
    sendCustomPacket(this.controller, { customPacketType: "petRequest", action, target: remoteId });
  }

  // Second step of Transfer: consumes the pending pick with the actor under the crosshair
  takePendingPick(remoteId: number): boolean {
    const pending = this.pendingTransfer;
    if (!pending) return false;
    this.pendingTransfer = null;
    if (Date.now() > pending.expiresAt) {
      notifyNextUpdate(this.controller, this.sp, "That hand-over expired.");
      return true;
    }
    if (!isPlayerCharacterId(this.controller, remoteId)) {
      notifyNextUpdate(this.controller, this.sp, "Cancelled - that is not a person.");
      return true;
    }
    sendCustomPacket(this.controller, { customPacketType: "petRequest", action: "transfer", target: pending.target, recipient: remoteId });
    return true;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    const target = typeof content["target"] === "number" ? content["target"] as number : 0;
    switch (content["customPacketType"]) {
      case "petState":
        this.setPets(Array.isArray(content["pets"]) ? content["pets"] as OwnPet[] : []);
        break;
      case "petMenu":
        if (target !== this.menuTarget || Date.now() - this.menuRequestedAt > MENU_ANSWER_MS) break;
        petMenuTitle = typeof content["title"] === "string" ? content["title"] as string : "Pet";
        petMenuActions = Array.isArray(content["actions"])
          ? (content["actions"] as PetAction[]).filter((a) => a && typeof a.id === "string" && typeof a.label === "string") : [];
        petMenuHideTrade = content["trade"] !== true;
        // Native calls are unsafe in the packet handler
        this.controller.once("update", () => this.openMenuWidget());
        break;
      case "petCommand":
        this.controller.once("update", () => this.enterCommandMode(target));
        break;
      case "petAction":
        if (content["action"] === "pet") this.controller.lookupListener(EmoteService).play(PET_ANIM, PET_ANIM_EXITS);
        break;
      default:
        break;
    }
  }

  private setPets(list: OwnPet[]): void {
    this.pets = list.filter((p) => p && typeof p.id === "number" && typeof p.kind === "string");
    storage[OWN_PET_IDS_KEY] = this.pets.filter((p) => p.out).map((p) => p.id);
    this.syncFollowers();
  }

  // Out dogs follow like summons unless they flee or are carried; the list is re-sent only when it changes
  private syncFollowers(): void {
    const ids = this.pets.filter((p) => p.out && p.kind === "dog" && !this.petOf(p.id)?.flee && !this.petOf(p.id)?.carried).map((p) => p.id);
    setDrivenPetIds(ids.concat(Array.from(this.fleeing)));
    const key = ids.join(",");
    if (key === this.followersKey) return;
    this.followersKey = key;
    this.controller.lookupListener(CompanionService).setExtraFollowers(ids);
  }

  // Throttled: the command-mode expiry, follower changes and the flee of a downed owner's hosted pets
  private onUpdate(): void {
    const now = Date.now();
    if (now - this.lastTickMs < TICK_MS) return;
    this.lastTickMs = now;
    if (this.commanded) this.commandingName();
    if (!this.pets.length) return;
    this.syncFollowers();
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    for (const pet of this.pets) {
      if (!pet.out || !isRemoteHostedByMe(pet.id)) continue;
      if (!this.petOf(pet.id)?.flee) {
        this.fleeing.delete(pet.id);
        continue;
      }
      if (this.fleeing.has(pet.id)) continue;
      const actor = Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(pet.id)));
      if (!actor || actor.isDead() || !actor.is3DLoaded()) continue;
      this.fleeing.add(pet.id);
      this.syncFollowers();
      actor.setDoingFavor(false);
      actor.keepOffsetFromActor(player, 0, FLEE_OFFSET, 0, 0, 0, 0, FLEE_RADIUS, FLEE_RADIUS);
    }
  }

  // The vanilla favor state on the copy, plus the state this service owns: the crosshair then reads "{pet} Attack"
  private enterCommandMode(remoteId: number): void {
    if (!isRemoteHostedByMe(remoteId)) {
      logTrace(this, `Command mode refused, not hosting`, remoteId.toString(16));
      return;
    }
    const actor = Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(remoteId)));
    if (!actor || actor.isDead()) return;
    if (this.commanded !== remoteId) this.endCommandMode();
    actor.setDoingFavor(true);
    this.commanded = remoteId;
    this.commandName = this.petOf(remoteId)?.name || (actor.getDisplayName() || "").trim() || "Companion";
    this.commandUntil = Date.now() + COMMAND_MODE_MS;
    logTrace(this, `Command mode on`, remoteId.toString(16));
  }

  // The commanded pet's name while the order is still open, else "" and the state is dropped
  commandingName(): string {
    if (!this.commanded) return "";
    const actor = Date.now() < this.commandUntil && isRemoteHostedByMe(this.commanded)
      ? Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(this.commanded)))
      : null;
    if (!actor || actor.isDead()) {
      this.endCommandMode();
      return "";
    }
    return this.commandName;
  }

  // Never yourself, the pet under command, or anything else of yours
  canAttack(remoteId: number): boolean {
    if (!this.commandingName() || !remoteId || remoteId === this.commanded || remoteId === this.myId()) return false;
    const kind = this.kindOf(remoteId);
    return kind === "" || kind === "horse-foreign";
  }

  canFollow(remoteId: number): boolean {
    return !!this.commandingName() && !!remoteId && remoteId === this.commanded;
  }

  // E on the commanded pet itself calls it off its fight and back to following
  orderFollow(remoteId: number, ref: ObjectReference): boolean {
    if (!this.canFollow(remoteId)) return false;
    blockActivation(ref);
    this.recall(remoteId);
    return true;
  }

  // Dogs and summons both drop their target through companionCommand, since a dog fights through CompanionSystem too
  private recall(remoteId: number): void {
    sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "follow", companionId: remoteId });
    this.controller.lookupListener(CompanionService).recall(remoteId);
    if (remoteId === this.commanded) this.endCommandMode();
    logTrace(this, `Follow ordered for`, remoteId.toString(16));
  }

  // E on a valid target while commanding; a summon is ordered through its own companionCommand
  orderAttack(remoteId: number, ref: ObjectReference): boolean {
    if (!this.canAttack(remoteId)) return false;
    const commanded = this.commanded;
    blockActivation(ref);
    // A player clone stays blocked as it always is; a world NPC must be talkable again on the next tick
    if (!isPlayerCharacterId(this.controller, remoteId)) {
      this.controller.once("update", () => { try { ref.blockActivation(false); } catch { /* unloaded ref */ } });
    }
    if (isOwnCompanion(commanded)) {
      sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "attack", targetId: remoteId, companionId: commanded });
    } else {
      sendCustomPacket(this.controller, { customPacketType: "petRequest", action: "attack", target: commanded, victim: remoteId });
    }
    this.endCommandMode();
    logTrace(this, `Attack ordered on`, remoteId.toString(16));
    return true;
  }

  // One order per command, like vanilla; also the way out on Escape and on the expiry
  private endCommandMode(): void {
    const id = this.commanded;
    this.commanded = 0;
    this.commandName = "";
    this.commandUntil = 0;
    if (!id) return;
    const actor = Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(id)));
    if (!actor) return;
    actor.setDoingFavor(false);
    actor.evaluatePackage();
  }

  // Dogs never sit: a favor that sends an own dog onto furniture is cancelled
  private onActivate(e: ActivateEvent): void {
    if (!e.caster || !e.target || e.caster.getFormID() < FIRST_DYNAMIC_REMOTE_ID) return;
    const remoteId = localIdToRemoteId(e.caster.getFormID());
    if (this.kindOf(remoteId) !== "dog" || !isRemoteHostedByMe(remoteId)) return;
    if (e.target.getBaseObject()?.getType() !== FormType.Furniture) return;
    const dog = Actor.from(e.caster);
    if (!dog) return;
    dog.setDoingFavor(false);
    dog.evaluatePackage();
    notifyNextUpdate(this.controller, this.sp, "Dogs do not sit.");
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!e.isDown || buttonEventKeyCode(e) !== DxScanCode.Escape) return;
    if (this.promptOpen) this.closePrompt();
    else if (this.menuOpen) this.closeMenu();
    else if (this.commanded) this.endCommandMode();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("pet:")) return;
    if (this.promptOpen) {
      this.closePrompt();
      const name = key === promptEvents.ok && typeof e.arguments[1] === "string" ? (e.arguments[1] as string).trim() : "";
      if (name) this.request("rename", { name });
      return;
    }
    if (!this.menuOpen) return;
    if (key === events.trade) {
      this.request("trade");
      this.closeMenu();
    } else if (key === events.action) {
      this.onMenuAction(typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "");
    } else if (key === events.close) {
      this.closeMenu();
    }
  }

  private onMenuAction(id: string): void {
    this.closeMenu();
    switch (id) {
      case "rename":
        promptCaption = "Rename";
        promptValue = petMenuTitle;
        this.openPrompt();
        break;
      case "transfer":
        this.pendingTransfer = { target: this.menuTarget, expiresAt: Date.now() + PENDING_RECIPIENT_MS };
        notifyNextUpdate(this.controller, this.sp, "Look at the player who should receive it and press the interact key.");
        break;
      case "follow":
        this.recall(this.menuTarget);
        break;
      case "pet":
      case "carry":
      case "unsummon":
      case "release":
        this.request(id);
        break;
      default:
        break;
    }
  }

  private request(action: string, extra: Record<string, unknown> = {}): void {
    sendCustomPacket(this.controller, { customPacketType: "petRequest", action, target: this.menuTarget, ...extra });
  }

  private myId(): number {
    return this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0;
  }

  private openMenuWidget(): void {
    if (this.isOpen || isMenuHotkeyBlocked(this.sp, this.controller)) return;
    this.menuOpen = true;
    logTrace(this, `Opening pet menu for`, petMenuTitle);
    openFormMenu(this.sp, this.menuWidgetSetter, { petMenuTitle, petMenuActions, petMenuHideTrade, events, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  private openPrompt(): void {
    this.promptOpen = true;
    openFormMenu(this.sp, this.promptWidgetSetter, { promptCaption, promptValue, promptEvents, PROMPT_WIDGET_ID }, this.controller);
  }

  private closePrompt(): void {
    this.promptOpen = false;
    closeFormMenu(this.sp, PROMPT_WIDGET_ID);
  }

  private closeAll(): void {
    if (this.promptOpen) this.closePrompt();
    if (this.menuOpen) this.closeMenu();
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private menuWidgetSetter = () => {
    const widget = {
      type: "contextMenu",
      id: WIDGET_ID,
      targetName: petMenuTitle,
      actions: petMenuActions,
      hideTrade: petMenuHideTrade,
      tradeLabel: "Trade",
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  // Runs inside the CEF browser. Only injected vars + window are available.
  private promptWidgetSetter = () => {
    const widget = {
      type: "petPrompt",
      id: PROMPT_WIDGET_ID,
      caption: promptCaption,
      value: promptValue,
      events: promptEvents,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== PROMPT_WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private pets: OwnPet[] = [];
  private followersKey = "";
  private fleeing = new Set<number>();
  private menuOpen = false;
  private promptOpen = false;
  private menuTarget = 0;
  private menuRequestedAt = 0;
  private pendingTransfer: { target: number; expiresAt: number } | null = null;
  private lastTickMs = 0;
  private commanded = 0;
  private commandName = "";
  private commandUntil = 0;
}
