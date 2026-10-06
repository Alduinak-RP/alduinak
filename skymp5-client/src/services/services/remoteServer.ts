// @ts-expect-error (TODO: Remove in 2.10.0)
import { Actor, Form, FormType, Menu, interruptCast, castSpellImmediate, printConsole, applyAnimationVariablesToActor, ActorAnimationVariables } from 'skyrimPlatform';
import {
  ActorBase,
  Cell,
  Debug,
  EquipEvent,
  Game,
  ObjectReference,
  TESModPlatform,
  Ui,
  Utility,
  WorldSpace,
  once, // TODO: use this.controller.once instead
  storage, // TODO: use this.sp.storage instead
} from 'skyrimPlatform';

import * as messages from '../../messages';

/* eslint-disable @typescript-eslint/no-empty-function */
import { ObjectReferenceEx } from '../../extensions/objectReferenceEx';
import { IdManager } from '../../lib/idManager';
import { nameof } from '../../lib/nameof';
import { refreshMovement, setActorValuePercentage } from '../../sync/actorvalues';
import { Appearance, applyAppearanceToPlayer } from '../../sync/appearance';
import { applyEquipment, isBadMenuShown, syncSpellEquipment, SpellType } from '../../sync/equipment';
import { Entry, Inventory, applyInventory, getDiff, getInventory, getPlayerInventory, isBoundItem, patchInventory, removeSimpleItemsAsManyAsPossible } from '../../sync/inventory';
import { applyDurabilityNames } from '../../sync/durabilityNames';
import { Movement, NiPoint3 } from '../../sync/movement';
import { aimForShot, applyWeapDrawn } from '../../sync/movementApply';
import { describeLeftover, describeRaceAbilities, dropUnlistedBaseSpells, isConcentration, isSelfDelivered, learnSpells, LeftoverAbility, removeUnlistedSpells, resyncRaceAbilities, SpellListNatives, syncRaceAbilities } from '../../sync/spell';
import { ModelApplyUtils } from '../../view/modelApplyUtils';
import { FormView } from '../../view/formView';
import { forgetHostAttempts, resetHostAttempts } from '../../view/hostAttempts';
import { FormModel, WorldModel } from '../../view/model';
import { LoadGameService } from './loadGameService';
import { MasteryService } from './masteryService';
import { CharacterSelectService } from './characterSelectService';
import { CreationLightService } from './creationLightService';
import { isMenuShown } from './menuStateService';
import { endSeatWait, markLocalActivation, startSeatWait } from './activationService';
import { FurnitureSeatService } from './furnitureSeatService';
import { UpdateMovementMessage } from '../messages/updateMovementMessage';
import { ChangeValuesMessage } from '../messages/changeValuesMessage';
import { UpdateAnimationMessage } from '../messages/updateAnimationMessage';
import { UpdateEquipmentMessage } from '../messages/updateEquipmentMessage';
import { RagdollService } from './ragdollService';
import { RestraintService } from './restraintService';
import { MountService } from './mountService';
import { RemoteDamageGuardService } from './remoteDamageGuardService';
import { CellAnimationsService } from './cellAnimationsService';
import { WorldCleanerService } from './worldCleanerService';
import { UpdateAppearanceMessage } from '../messages/updateAppearanceMessage';
import { TeleportMessage } from '../messages/teleportMessage';
import { DeathStateContainerMessage } from '../messages/deathStateContainerMessage';
import { RespawnNeededError } from '../../lib/errors';
import { OpenContainerMessage } from '../messages/openContainerMessage';
import { ActivateMessage } from '../messages/activateMessage';
import { ClientListener, CombinedController, Sp } from './clientListener';
import { HostStartMessage } from '../messages/hostStartMessage';
import { HostStopMessage } from '../messages/hostStopMessage';
import { ConnectionMessage } from '../events/connectionMessage';
import { SetInventoryMessage } from '../messages/setInventoryMessage';
import { CreateActorMessage, CreateActorMessageAdditionalProps } from '../messages/createActorMessage';
import { DestroyActorMessage } from '../messages/destroyActorMessage';
import { SetRaceMenuOpenMessage } from '../messages/setRaceMenuOpenMessage';
import { UpdatePropertyMessage } from '../messages/updatePropertyMessage';
import { TeleportMessage2 } from '../messages/teleportMessage2';

// TODO: refactor worldViewMisc into service
import {
  getObjectReference,
  getViewFromStorage,
  isHostedByMe,
  remoteIdToLocalId,
  pluginRefs,
  PluginRef,
  carriedByOther,
  pluginRefHidden,
} from '../../view/worldViewMisc';
import { TimeService } from './timeService';
import { TimersService } from './timersService';
import { clientScriptStartedAt, logTrace, logError, logToPlatformLog } from '../../logging';
import { countWorn, equipEntries, Equipment, getPlayerWorn, getUnwornSaved, getWornOtherCopy, resyncHandGraph } from '../../sync/equipment';
import { isCloneMovementSuspended, isRiderClone } from '../../sync/mountApply';
import { probeCopyCast } from '../../sync/castProbe';
import { disposeCopyAnimationSources } from '../../sync/animation';

import { SpellCastMessage } from '../messages/spellCastMessage';
import { UpdateAnimVariablesMessage } from '../messages/updateAnimVariablesMessage';
import { MsgType } from '../../messages';
import { notifyNextUpdate, sendCustomPacket, CustomPacketContent, onCustomPacket } from './customPacketUtil';
import { loc } from "../../loc";

export const getPcInventory = (): Inventory | undefined => {
  const res = storage['pcInv'];
  if (typeof res === 'object' && (res as any)['entries']) {
    return res as Inventory;
  }
  return undefined;
};

const setPcInventory = (inv: Inventory | undefined): void => {
  storage['pcInv'] = inv;
};

const CONSUME_APPLY_HOLD_MS = 10000;
// How long a local change waits for the server's answer before the pack goes back to the server's snapshot
const PC_INV_SETTLE_MS = 5000;
// How long after the last apply a safety apply catches a local change no event reported
const PC_INV_SAFETY_MS = 60000;

let pcInvLastApply = 0;
// When the next apply is due, 0 while none is asked for
let pcInvApplyAt = 0;
let pcInvHoldUntil = 0;
let encumbranceRefreshPending = false;

// Holds the re-apply while the server has not seen a local change yet
export const holdPcInventoryApply = (ms: number): void => {
  pcInvHoldUntil = Math.max(pcInvHoldUntil, Date.now() + ms);
};

const schedulePcInventoryApply = (at: number): void => {
  pcInvApplyAt = pcInvApplyAt ? Math.min(pcInvApplyAt, at) : at;
};

export const requestPcInventoryApply = (): void => {
  schedulePcInventoryApply(Date.now());
};

// An apply already due stays due; a later one waits until the server could answer the change
const settlePcInventoryApply = (): void => {
  const now = Date.now();
  if (!pcInvApplyAt || pcInvApplyAt > now) {
    pcInvApplyAt = Math.max(pcInvApplyAt, now + PC_INV_SETTLE_MS);
  }
};

const WORN_ENCHANTMENT_REAPPLY_DELAY_MS = 1500;
const WORN_ENCHANTMENT_REAPPLY_MAX_WAIT_MS = 5000;
let wornEnchantmentReapplyAt = 0;
let wornEnchantmentReapplyDeadline = 0;

// Waits for a burst of changes to end so the engine's own equips and dispels have landed
const requestWornEnchantmentReapply = (): void => {
  const now = Date.now();
  if (!wornEnchantmentReapplyAt) {
    wornEnchantmentReapplyDeadline = now + WORN_ENCHANTMENT_REAPPLY_MAX_WAIT_MS;
  }
  wornEnchantmentReapplyAt = Math.min(now + WORN_ENCHANTMENT_REAPPLY_DELAY_MS, wornEnchantmentReapplyDeadline);
};

const PLAYER_TELEPORT_CHECK_MS = 3000;
const PLAYER_TELEPORT_MOVES = 3;
const PLAYER_TELEPORT_RAGDOLL_MS = 1000;
const PLAYER_TELEPORT_RESYNC_MS = 3000;
// The server's MovementValidation reach, so anything closer is accepted there
const PLAYER_TELEPORT_REACH = 4096;
// A repeat of the pending target, such as the TeleportMessage2 answering the first old-cell movement
const PLAYER_TELEPORT_SAME = 256;
const RACE_MENU_RETRY_MS = 5000;
const RACE_MENU_RETRIES = 3;
// How long the world runs after a spawn, load, resurrect or race menu, with no race menu or Magic menu up, before the race abilities are checked and logged
const RACE_CHECK_SETTLE_MS = 6000;
// The after snapshot waits out syncRaceAbilities' movement re-read
const RACE_CHECK_AFTER_S = 3;
// The Magic menu logs the race abilities on its first open per spawn, then at most this often
const RACE_MENU_LOG_MS = 60000;
// How long a furniture activation may take to seat the player before its seat is given back
const FURNITURE_SEAT_WAIT_MS = 15000;
// Plugin refs no load event named are polled at this rate for this long
const PLUGIN_REF_POLL_MS = 500;
const PLUGIN_REF_POLL_WINDOW_MS = 30000;
// UpdateProperty values applied to a loaded plugin ref; the record keeps the rest for its first apply
const PLUGIN_REF_PROPS_APPLIED = new Set(['inventory', 'isOpen', 'isHarvested', 'disabled', 'ff_carried', 'ff_decor']);

// How waiting plugin refs were applied, to compare the load events' coverage with the fallback poll
interface PluginRefApplies {
  atOnce: number;
  cellAttach: number;
  moveAttachDetach: number;
  fallback: number;
  lapsed: number;
}

interface PlayerTeleport {
  pos: NiPoint3;
  rot: NiPoint3;
  worldOrCell: number;
  moves: number;
  nextCheckAt: number;
  ragdollReturned: boolean;
}

// The race abilities check of the player's current spawn
interface RaceCheck {
  spawnSeq: number;
  formIdx: number;
  synced: boolean;
  settleFrom: number;
  // Why a check is waiting to run, undefined when none is
  due?: string;
  menuLoggedAt: number;
  // Vanilla racial abilities the race syncs of this spawn found and cleared, reported with each check
  leftovers: LeftoverAbility[];
}

const SPAWN_EQUIPMENT_SETTLE_MS = 2500;
// How long after a strip the settle waits for the spawn's inventory apply and top-up
const SPAWN_TOP_UP_MAX_WAIT_MS = 10000;
// A frame at least this long counts as a hitch in the spawn and race menu timing lines
const SLOW_FRAME_MS = 250;
let spawnEquipment: Equipment | undefined;
let spawnEquipmentSettleUntil = 0;
let spawnEquipmentRedressed = false;
let spawnEquipmentMenuUsed = false;
// The strip's dress lands first, then the inventory apply, then a top-up equips what the dress left unworn
let spawnTopUp: "none" | "dressing" | "apply" | "queued" | "landed" = "none";
let spawnTopUpUntil = 0;

interface FrameStats {
  frames: number;
  longest: number;
  slow: number;
}

const newFrameStats = (): FrameStats => ({ frames: 0, longest: 0, slow: 0 });

const noteFrame = (stats: FrameStats, gap: number): void => {
  stats.frames++;
  stats.longest = Math.max(stats.longest, gap);
  if (gap >= SLOW_FRAME_MS) stats.slow++;
};

const describeFrames = (stats: FrameStats): string =>
  `${stats.frames} frames, longest ${stats.longest} ms, ${stats.slow} over ${SLOW_FRAME_MS} ms`;

// One spawn's load timeline and the inventory and equip work it took, logged once its outfit settles
interface SpawnTiming {
  seq: number;
  createdAt: number;
  loadAt: number;
  loadedAt: number;
  dressedAt: number;
  inventoryAt: number;
  raceMenuMs: number;
  strips: number;
  topUps: number;
  topUpEquips: number;
  applies: number;
  added: number;
  removed: number;
  equips: number;
  unequips: number;
  frames: FrameStats;
}
let spawnTiming: SpawnTiming | undefined;

const after = (from: number, at: number): string => (at ? `+${at - from} ms` : "none");

const logSpawnTiming = (player: Actor): void => {
  const t = spawnTiming;
  if (!t) return;
  spawnTiming = undefined;
  const start = t.createdAt;
  const raceMenu = t.raceMenuMs ? `, race menu open ${t.raceMenuMs} ms of it` : "";
  logToPlatformLog("RemoteServer", `spawn timing (spawn ${t.seq}): createActor ${start - clientScriptStartedAt} ms after the client script started;`,
    `load requested ${after(start, t.loadAt)}, loaded ${after(start, t.loadedAt)}, outfit applied ${after(start, t.dressedAt)},`,
    `inventory applied ${after(start, t.inventoryAt)}, settled ${after(start, Date.now())}${raceMenu};`,
    `${t.strips} strip(s), ${t.topUps} top-up(s) equipping ${t.topUpEquips}, ${t.applies} inventory apply(ies) adding ${t.added} and removing ${t.removed} stack(s),`,
    `${t.equips} equip and ${t.unequips} unequip event(s); after the outfit apply ${describeFrames(t.frames)};`,
    `inventory ${getInventory(player).entries.length} entries, worn ${countWorn(getInventory(player))}`);
};

const applySpawnEquipment = (player: Actor, eq: Equipment): void => {
  spawnEquipment = eq;
  spawnEquipmentSettleUntil = Date.now() + SPAWN_EQUIPMENT_SETTLE_MS;
  spawnEquipmentRedressed = false;
  spawnEquipmentMenuUsed = false;
  spawnTopUp = "dressing";
  spawnTopUpUntil = Date.now() + SPAWN_TOP_UP_MAX_WAIT_MS;
  if (spawnTiming) spawnTiming.strips++;
  applyEquipment(player, eq);
};

// A spawn's later passes re-sync the inventory and top up the outfit without a strip, which would empty the pack until the next periodic apply
const resyncSpawnEquipment = (): void => {
  if (!spawnEquipment) return;
  if (spawnTopUp !== "dressing") spawnTopUp = "apply";
  spawnEquipmentSettleUntil = Date.now() + SPAWN_EQUIPMENT_SETTLE_MS;
  requestPcInventoryApply();
};

// Reports taken while the spawn apply strips and re-dresses the player read naked
export const settleSpawnEquipment = (player: Actor): boolean => {
  if (!spawnEquipment) {
    // A spawn with no saved outfit is timed up to the settle time after its first inventory apply
    if (spawnTiming?.inventoryAt && Date.now() - spawnTiming.inventoryAt >= SPAWN_EQUIPMENT_SETTLE_MS) logSpawnTiming(player);
    return false;
  }
  // In these menus the player picks their own outfit
  if (isBadMenuShown()) {
    spawnEquipmentMenuUsed = true;
    return true;
  }
  // The race menu undresses the player on purpose until it closes
  if (isMenuShown(Menu.RaceSex)) {
    return true;
  }
  if (spawnTopUp === "landed") {
    spawnTopUp = "none";
    const unworn = spawnEquipmentMenuUsed ? [] : getUnwornSaved(player, spawnEquipment);
    equipEntries(player, unworn);
    if (spawnTiming) {
      spawnTiming.topUps++;
      spawnTiming.topUpEquips += unworn.length;
    }
  }
  // The tempered and poisoned pieces come only with the spawn's inventory apply and its top-up
  if (spawnTopUp !== "none" && getPcInventory() && Date.now() < spawnTopUpUntil) {
    return true;
  }
  if (Date.now() < spawnEquipmentSettleUntil) {
    return true;
  }
  const unworn = getUnwornSaved(player, spawnEquipment);
  const redress = !spawnEquipmentRedressed && !spawnEquipmentMenuUsed && unworn.length > 0;
  const otherCopy = getWornOtherCopy(player, spawnEquipment).map((e) => e.baseId.toString(16));
  const otherCopyText = otherCopy.length ? ` worn as another copy ${otherCopy.join(" ")},` : "";
  logToPlatformLog("RemoteServer", `spawn outfit settled: ${unworn.length} of ${getPlayerWorn(spawnEquipment).length} saved not worn,${otherCopyText} worn ${countWorn(getInventory(player))}, menu used ${spawnEquipmentMenuUsed},`, redress ? "re-dressing" : "done");
  if (!redress) {
    spawnEquipment = undefined;
    spawnTopUp = "none";
    logSpawnTiming(player);
    // The report that follows lands inside the server's spawn guard like a manual re-equip
    resyncHandGraph(player, (text) => logToPlatformLog("RemoteServer", text));
    requestWornEnchantmentReapply();
    return false;
  }
  // The engine dropped some of the queued equips
  equipEntries(player, unworn);
  spawnEquipmentRedressed = true;
  spawnEquipmentSettleUntil = Date.now() + SPAWN_EQUIPMENT_SETTLE_MS;
  return true;
};

const reapplyPcInventory = () => {
  if (isBadMenuShown()) {
    return;
  }
  // The adds an apply queued land at the end of its frame
  if (spawnTopUp === "queued") {
    spawnTopUp = "landed";
  }
  // So does a strip's dress, so the spawn's apply skips this update whichever callback ran first
  const dressing = spawnTopUp === "dressing";
  if (dressing) {
    spawnTopUp = "apply";
    requestPcInventoryApply();
  }
  if (encumbranceRefreshPending) {
    encumbranceRefreshPending = false;
    refreshMovement(Game.getPlayer()!);
  }
  const now = Date.now();
  // Snapshots sent before the server saw a quick run of consumes would re-add them; the strip left no local change to protect
  if (dressing || (now < pcInvHoldUntil && spawnTopUp !== "apply")) {
    return;
  }
  // A settling change or a block keeps the safety re-apply waiting too
  if (pcInvApplyAt ? now >= pcInvApplyAt : now - pcInvLastApply >= PC_INV_SAFETY_MS) {
    pcInvApplyAt = 0;
    pcInvLastApply = now;
    const pcInv = getPcInventory();
    if (pcInv) {
      const player = Game.getPlayer()!;
      const diff = getDiff(pcInv, getPlayerInventory(player), true, "apply").entries;
      // applyInventory keeps summoned bound items, so their pending removal is not a change
      encumbranceRefreshPending = diff.some((e) => {
        const f = e.count < 0 ? Game.getFormEx(e.baseId) : null;
        return !f || !isBoundItem(f);
      });
      applyInventory(player, pcInv, false, true);
      // Condition tags follow the server without a remove and add of what is worn; a base this apply still changes waits for the next one
      applyDurabilityNames(player, pcInv, { skipBaseIds: new Set(diff.map((e) => e.baseId)), reAdd: !spawnEquipment && spawnTopUp === "none" });
      requestWornEnchantmentReapply();
      if (spawnTopUp === "apply") {
        spawnTopUp = "queued";
      }
      if (spawnTiming) {
        spawnTiming.inventoryAt = spawnTiming.inventoryAt || Date.now();
        spawnTiming.applies++;
        spawnTiming.added += diff.filter((e) => e.count > 0).length;
        spawnTiming.removed += diff.filter((e) => e.count < 0).length;
      }
    }
  }
};

// The spawn save dresses the player in the Player record's default outfit
const unequipDefaultOutfit = () => {
  Game.getPlayer()?.unequipAll();
};

// The server's relay and the client's own reports both write here; FormView applies on a new count
export const setFormMovement = (form: FormModel, movement: Movement): void => {
  form.movement = movement;
  form.numMovementChanges = (form.numMovementChanges || 0) + 1;
};

export class RemoteServer extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    // The world model outlives a hot reload
    this.worldModel.forms.forEach((form, i) => {
      if (form?.refrId) {
        this.formIdxByRefrId.set(form.refrId, i);
      }
    });

    this.controller.emitter.on("hostStartMessage", (e) => this.onHostStartMessage(e));
    this.controller.emitter.on("hostStopMessage", (e) => this.onHostStopMessage(e));
    this.controller.emitter.on("setInventoryMessage", (e) => this.onSetInventoryMessage(e));
    onCustomPacket(this.controller, "inventoryPatch", (content) => this.onInventoryPatch(content));
    this.controller.emitter.on("openContainerMessage", (e) => this.onOpenContainerMessage(e));
    this.controller.emitter.on("updateMovementMessage", (e) => this.onUpdateMovementMessage(e));
    this.controller.emitter.on("updateAnimationMessage", (e) => this.onUpdateAnimationMessage(e));
    this.controller.emitter.on("updateEquipmentMessage", (e) => this.onUpdateEquipmentMessage(e));
    this.controller.emitter.on("changeValuesMessage", (e) => this.onChangeValuesMessage(e));
    this.controller.emitter.on("updateAppearanceMessage", (e) => this.onUpdateAppearanceMessage(e));
    this.controller.emitter.on("teleportMessage", (e) => this.onTeleportMessage(e));
    this.controller.emitter.on("teleportMessage2", (e) => this.onTeleportMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.emitter.on("destroyActorMessage", (e) => this.onDestroyActorMessage(e));
    this.controller.emitter.on("setRaceMenuOpenMessage", (e) => this.onSetRaceMenuOpenMessage(e));
    this.controller.emitter.on("updatePropertyMessage", (e) => this.onUpdatePropertyMessage(e));
    this.controller.emitter.on("deathStateContainerMessage", (e) => this.onDeathStateContainerMessage(e));

    this.controller.emitter.on("connectionAccepted", () => this.handleConnectionAccepted());

    this.controller.emitter.on("spellCastMessage", (e) => this.onSpellCastMessage(e));
    this.controller.emitter.on("updateAnimVariablesMessage", (e) => this.onUpdateAnimVariablesMessage(e));

    this.controller.on("update", reapplyPcInventory);
    this.controller.on("loadGame", () => requestPcInventoryApply());
    this.controller.on("loadGame", () => this.requeuePluginRefs());
    this.controller.on("update", () => this.sweepCloneCasts());
    this.controller.on("update", () => this.checkPlayerTeleport());
    this.controller.on("update", () => this.checkRaceMenu());
    this.controller.on("update", () => this.checkRaceAbilities());
    this.controller.on("update", () => this.updatePluginRefs());
    this.controller.on("cellAttach", (e) => this.onRefAttached(e.refr, "cellAttach"));
    this.controller.on("moveAttachDetach", (e) => {
      if (e.isCellAttached) this.onRefAttached(e.movedRef, "moveAttachDetach");
    });
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.RaceSex) {
        this.raceMenuSeen = true;
        this.raceMenuFrames = { ...newFrameStats(), openedAt: Date.now(), switches: 0 };
        logToPlatformLog(this, `RaceSex Menu opened, creation pending ${this.raceMenuPending}`);
      }
      if (e.name === Menu.Magic) this.logRaceAbilitiesInMagicMenu();
    });
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.RaceSex) {
        const stats = this.raceMenuFrames;
        this.raceMenuFrames = undefined;
        const openMs = stats ? Date.now() - stats.openedAt : 0;
        if (spawnTiming) spawnTiming.raceMenuMs += openMs;
        const frames = stats ? `, open ${openMs} ms, ${stats.switches} race switch(es), ${describeFrames(stats)}` : "";
        logToPlatformLog(this, `RaceSex Menu closed, creation pending ${this.raceMenuPending}, loading ${Ui.isMenuOpen(Menu.Loading)}${frames}`);
        this.raceMenuPending = false;
        this.queueRaceCheck("race menu closed");
      }
    });
    this.controller.on("switchRaceComplete", (e) => {
      if (this.raceMenuFrames && e.subject?.getFormID() === 0x14) this.raceMenuFrames.switches++;
    });
    // Frame gaps measured on tick, which runs in every menu
    this.controller.on("tick", () => this.noteFrameGap());
    // Every service constructor has run by the next tick
    this.controller.once("tick", () => logToPlatformLog(this, `startup: client services ready ${Date.now() - clientScriptStartedAt} ms after the client script started`));
    this.controller.emitter.on("browserWindowLoaded", () => {
      if (this.frontLoadedLogged) return;
      this.frontLoadedLogged = true;
      logToPlatformLog(this, `startup: front page loaded ${Date.now() - clientScriptStartedAt} ms after the client script started`);
    });
    this.controller.on("equip", (e) => this.noteSpawnEquipEvent(e.actor, true));
    this.controller.on("unequip", (e) => this.noteSpawnEquipEvent(e.actor, false));
    this.controller.emitter.on("gameLoad", () => {
      this.lastLoadAt = Date.now();
      if (spawnTiming && !spawnTiming.loadedAt) spawnTiming.loadedAt = this.lastLoadAt;
      this.queueRaceCheck("load");
    });
    this.controller.emitter.on("applyDeathStateEvent", (e) => {
      if (!e.isDead && e.actor.getFormID() === 0x14) this.queueRaceCheck("resurrect");
    });
    this.controller.emitter.on("connectionDisconnect", () => { this.playerTeleport = undefined; this.raceMenuPending = false; });
    this.controller.on("equip", (e) => this.onPlayerConsume(e));
    onCustomPacket(this.controller, "potionRefused", (content) => this.onPotionRefused(content));
    onCustomPacket(this.controller, "racialResync", (content) => this.onRacialResync(content));
    onCustomPacket(this.controller, "racialBase", (content) => this.onRacialBase(content));
    this.controller.on("update", () => this.applyRaceBase());
    onCustomPacket(this.controller, "bodyLeft", (content) => this.onBodyLeft(content));
    // The engine loses worn enchantment abilities on scripted equips, inventory changes and stray dispels
    this.controller.on("equip", (e) => this.onPlayerWornChange(e.actor));
    this.controller.on("containerChanged", (e) => {
      if (this.onPlayerWornChange(e.oldContainer, e.newContainer)) settlePcInventoryApply();
    });
    this.controller.on("effectFinish", (e) => this.onPlayerWornChange(e.target));
    this.controller.on("update", () => this.reapplyWornEnchantments());
  }

  // True when the player was one of the refs
  private onPlayerWornChange(...refs: (ObjectReference | null | undefined)[]): boolean {
    if (!refs.some((ref) => ref?.getFormID() === 0x14)) {
      return false;
    }
    requestWornEnchantmentReapply();
    return true;
  }

  private noteFrameGap(): void {
    const now = Date.now();
    const gap = this.lastTickAt ? now - this.lastTickAt : 0;
    this.lastTickAt = now;
    if (!gap) return;
    if (spawnTiming?.dressedAt) noteFrame(spawnTiming.frames, gap);
    if (this.raceMenuFrames) noteFrame(this.raceMenuFrames, gap);
  }

  private noteSpawnEquipEvent(actor: ObjectReference | null | undefined, equip: boolean): void {
    if (!spawnTiming || actor?.getFormID() !== 0x14) return;
    if (equip) spawnTiming.equips++;
    else spawnTiming.unequips++;
  }

  // Menus hold inventory entries, so the check waits for them to close
  private reapplyWornEnchantments(): void {
    if (!wornEnchantmentReapplyAt || Date.now() < wornEnchantmentReapplyAt || isBadMenuShown()) {
      return;
    }
    wornEnchantmentReapplyAt = 0;
    const natives = this.sp as unknown as {
      reapplyWornEnchantments?: (actorFormId: number) => void;
    };
    natives.reapplyWornEnchantments?.(0x14);
  }

  private onHostStartMessage(event: ConnectionMessage<HostStartMessage>) {
    const msg = event.message;
    const target = msg.target;

    let hosted = storage['hosted'];
    if (typeof hosted !== typeof []) {
      // if switching to Set, check .concat usage: it compiles but doesn't work as expected
      hosted = new Array<number>();
      storage['hosted'] = hosted;
    }

    if (!(hosted as Array<unknown>).includes(target)) {
      (hosted as Array<unknown>).push(target);
    }
  }

  private onHostStopMessage(event: ConnectionMessage<HostStopMessage>) {
    const msg = event.message;
    const target = msg.target;
    logTrace(this, 'hostStop ' + target.toString(16));

    const hosted = storage['hosted'] as Array<number>;
    if (typeof hosted === typeof []) {
      storage['hosted'] = hosted.filter((x) => x !== target);
    }
    disposeCopyAnimationSources(target);
  }

  private onSetInventoryMessage(event: ConnectionMessage<SetInventoryMessage>): void {
    this.numSetInventory++;

    const msg = event.message;
    this.serverInventory = msg.inventory;
    once('update', () => {
      setPcInventory(msg.inventory);

      // A blocked snapshot goes on when the last block ends
      let applyAt = Date.now();
      this.controller.emitter.emit('queryBlockSetInventoryEvent', {
        block: (until) => { applyAt = Math.max(applyAt, until); }
      });
      schedulePcInventoryApply(applyAt);
    });
  }

  // Rebuilds the full inventory the server would have sent, so every SetInventory listener gets it
  private onInventoryPatch(content: CustomPacketContent): void {
    const entries = content["entries"];
    const valid = Array.isArray(entries) && entries.every((e) => typeof e?.baseId === "number" && typeof e.count === "number");
    if (!valid || !this.serverInventory) {
      logToPlatformLog(this, `inventory patch dropped: ${valid ? "no full inventory to patch" : "bad entries"}`);
      return;
    }
    const inventory = patchInventory(this.serverInventory, entries as Entry[]);
    this.controller.emitter.emit("setInventoryMessage", { message: { t: MsgType.SetInventory, inventory } });
  }

  // Mirror the server's removal so an apply before its SetInventory arrives can't re-add the item
  private onPlayerConsume(e: EquipEvent): void {
    if (!e.actor || !e.baseObj || e.actor.getFormID() !== 0x14) {
      return;
    }
    const type = e.baseObj.getType();
    if (type !== FormType.Potion && type !== FormType.Ingredient) {
      return;
    }
    pcInvHoldUntil = Date.now() + CONSUME_APPLY_HOLD_MS;
    const pcInv = getPcInventory();
    if (pcInv) {
      setPcInventory(removeSimpleItemsAsManyAsPossible(pcInv, e.baseObj.getFormID(), 1));
    }
  }

  // A PK left a body copy of this player: FormView drops their own dead copy for the ms, by when the respawn has taken them away
  private onBodyLeft(content: CustomPacketContent): void {
    const victim = Number(content["victim"]) >>> 0;
    const ms = Number(content["ms"]);
    const form = this.getFormByRefrId(victim);
    if (form && ms > 0) {
      form.bodyLeftUntil = Date.now() + ms;
    }
  }

  // The server refunds a potion or food within 10 s of the last one of its kind and blocks its effects
  private onPotionRefused(content: CustomPacketContent): void {
    const baseId = Number(content["baseId"]);
    const acceptedBaseId = Number(content["acceptedBaseId"]);
    const acceptedSecondsAgo = Number(content["acceptedSecondsAgo"]);
    const isFood = content["isFood"] === true;
    this.controller.once("update", () => {
      const player = Game.getPlayer();
      const potion = Game.getFormEx(baseId);
      if (!player || !potion) {
        return;
      }
      // A named-only stack gets its refund from the next inventory apply, the way it was created
      const held = getInventory(player).entries.filter((e) => e.baseId === baseId);
      if (!held.length || held.some((e) => !e.name)) {
        player.addItem(potion, 1, true);
      }
      const natives = this.sp as unknown as {
        dispelPotionEffects?: (actorFormId: number, potionFormId: number) => void;
        agePotionEffects?: (actorFormId: number, potionFormId: number, seconds: number) => void;
      };
      if (baseId !== acceptedBaseId) {
        natives.dispelPotionEffects?.(player.getFormID(), baseId);
      } else if (acceptedSecondsAgo > 0) {
        // A repeat of the accepted potion refreshed its effects, so roll them back to the first drink
        natives.agePotionEffects?.(player.getFormID(), baseId, acceptedSecondsAgo);
      }
      Debug.notification(loc(isFood ? "consume.foodCooldown" : "consume.potionCooldown"));
    });
  }

  private onOpenContainerMessage(event: ConnectionMessage<OpenContainerMessage>): void {
    once('update', async () => {
      await Utility.wait(0.1); // Give a chance to update inventory

      const remoteId = event.message.target;
      const localId = remoteIdToLocalId(remoteId);
      const refr = ObjectReference.from(Game.getFormEx(localId));

      if (refr === null) {
        logError(this, 'onOpenContainerMessage - refr not found', 'remoteId', remoteId.toString(16), 'localId', localId.toString(16));
        return;
      }

      markLocalActivation(remoteId);
      refr.activate(Game.getPlayer(), true);

      const baseObject = refr.getBaseObject();
      const baseType = baseObject?.getType();
      const isFurniture = baseType === FormType.Furniture;

      if (baseType !== FormType.Container && !isFurniture) {
        logTrace(this, "onOpenContainerMesage - not a container or furniture", baseType);
        return;
      }
      if (isFurniture) {
        startSeatWait(remoteId);
      }
      const delaySeconds = isFurniture ? 1.0 : 0.0;

      // SkyMP containers have a 2nd, closing activation under the hood, unlike Skyrim's single activation.

      (async () => {
        if (isFurniture) {
          logTrace(this, "onOpenContainerMesage - waiting for the seat or the Crafting Menu");
          const outcome = await this.controller.lookupListener(FurnitureSeatService).waitSeatCycle(FURNITURE_SEAT_WAIT_MS);
          if (outcome === "timeout") {
            logToPlatformLog(this, `furniture ${remoteId.toString(16)} never seated the player within ${FURNITURE_SEAT_WAIT_MS} ms, releasing the seat`);
          } else if (outcome === "load") {
            logToPlatformLog(this, `furniture ${remoteId.toString(16)} lost its seat wait to a load, releasing the seat`);
          }
          logTrace(this, "onOpenContainerMesage - seat wait ended", outcome);
        } else {
          const factName = "'ContainerMenu open'";
          logTrace(this, "onOpenContainerMesage - waiting for", factName, "to be true");
          while (!Ui.isMenuOpen("ContainerMenu")) await Utility.wait(0.1);
          logTrace(this, "onOpenContainerMesage - waiting for", factName, "to be false");
          while (Ui.isMenuOpen("ContainerMenu")) await Utility.wait(0.1);
          logTrace(this, "onOpenContainerMesage - menu closed", factName);
          // The closing frame's containerChanged events drain after this continuation, and their moves reach the server before the closing activation
          await Utility.wait(0.1);
        }

        const message: ActivateMessage = {
          t: messages.MsgType.Activate,
          data: {
            caster: 0x14, target: event.message.target, isSecondActivation: true
          }
        };

        logTrace(this, "onOpenContainerMesage - waiting", delaySeconds, "seconds before sending ActivateMessage");

        Utility.waitMenuMode(delaySeconds).then(() => {
          this.controller.emitter.emit("sendMessage", {
            message: message,
            reliability: "reliable"
          });
          if (isFurniture) endSeatWait(remoteId);

          logTrace(this, "onOpenContainerMesage - sent ActivateMessage", message);
        });
      })();
    });
  }

  private onTeleportMessage(event: ConnectionMessage<TeleportMessage> | ConnectionMessage<TeleportMessage2>): void {
    const msg = event.message;
    this.onceInSession(() => {
      const id = ("idx" in msg && typeof msg.idx === "number") ? this.getIdManager().getId(msg.idx) : this.getMyActorIndex();
      const refr = id === this.getMyActorIndex() ? Game.getPlayer() : getObjectReference(id);
      logTrace(this,
        `Teleporting id`, id, `refrId`, refr?.getFormID().toString(16), `...`,
        msg.pos,
        'cell/world is',
        msg.worldOrCell.toString(16),
      );
      const ragdollService = this.controller.lookupListener(RagdollService);

      const refrId = refr?.getFormID();

      // A server move of a rider starts from the ground
      if (refrId === 0x14) {
        this.controller.lookupListener(MountService).dismountNow("teleport");
      }

      // Carry follow rides the cheap havok translate; doors and every other teleport need a real move
      if (refr && refrId === 0x14 && this.controller.lookupListener(RestraintService).isCarried &&
        ObjectReferenceEx.getWorldOrCell(refr) === msg.worldOrCell) {
        const dist = ObjectReferenceEx.getDistance(
          ObjectReferenceEx.getPos(refr), [msg.pos[0], msg.pos[1], msg.pos[2]]);
        if (dist < 2048) {
          this.controller.lookupListener(RestraintService).onCarriedHop();
          refr.setAngle(msg.rot[0], msg.rot[1], msg.rot[2]);
          refr.translateTo(
            msg.pos[0], msg.pos[1], msg.pos[2],
            msg.rot[0], msg.rot[1], msg.rot[2],
            Math.max(dist / 0.35, 100), 0,
          );
          return;
        }
      }

      if (refrId === 0x14) {
        this.beginPlayerTeleport(msg, Actor.from(refr));
        return;
      }

      const removeRagdollCallback = () => {
        TESModPlatform.moveRefrToPosition(
          ObjectReference.from(Game.getFormEx(refrId || 0)),
          Cell.from(Game.getFormEx(msg.worldOrCell)),
          WorldSpace.from(Game.getFormEx(msg.worldOrCell)),
          msg.pos[0],
          msg.pos[1],
          msg.pos[2],
          msg.rot[0],
          msg.rot[1],
          msg.rot[2],
        );
      };
      const actor = Actor.from(refr);
      if (actor /*&& actor.getFormID() === 0x14*/) {
        ragdollService.safeRemoveRagdollFromWorld(actor, removeRagdollCallback);
      } else {
        removeRagdollCallback();
      }
    });
  }

  private beginPlayerTeleport(msg: TeleportMessage | TeleportMessage2, player: Actor | null): void {
    if (this.resyncing || !player) {
      return;
    }
    const pos: NiPoint3 = [msg.pos[0], msg.pos[1], msg.pos[2]];
    const pending = this.playerTeleport;
    if (pending && pending.worldOrCell === msg.worldOrCell && ObjectReferenceEx.getDistance(pending.pos, pos) < PLAYER_TELEPORT_SAME) {
      return;
    }
    const target: PlayerTeleport = {
      pos,
      rot: [msg.rot[0], msg.rot[1], msg.rot[2]],
      worldOrCell: msg.worldOrCell,
      moves: 0,
      nextCheckAt: Infinity,
      ragdollReturned: true,
    };
    this.playerTeleport = target;
    this.controller.lookupListener(RagdollService).safeRemoveRagdollFromWorld(player, (returned) => {
      if (this.playerTeleport !== target) {
        return;
      }
      target.ragdollReturned = returned;
      this.movePlayerTo(target);
    }, PLAYER_TELEPORT_RAGDOLL_MS);
  }

  private movePlayerTo(target: PlayerTeleport): void {
    target.moves++;
    target.nextCheckAt = Date.now() + PLAYER_TELEPORT_CHECK_MS;
    const place = Game.getFormEx(target.worldOrCell);
    TESModPlatform.moveRefrToPosition(
      Game.getPlayer(),
      Cell.from(place),
      WorldSpace.from(place),
      target.pos[0],
      target.pos[1],
      target.pos[2],
      target.rot[0],
      target.rot[1],
      target.rot[2],
    );
    this.controller.lookupListener(RestraintService).onTeleported();
  }

  private checkPlayerTeleport(): void {
    const target = this.playerTeleport;
    if (!target || target.moves === 0) {
      return;
    }
    if (isMenuShown(Menu.Loading) || isMenuShown(Menu.RaceSex)) {
      target.nextCheckAt = Date.now() + PLAYER_TELEPORT_CHECK_MS;
      return;
    }
    if (Date.now() < target.nextCheckAt) {
      return;
    }
    const player = Game.getPlayer();
    if (!player) {
      return;
    }
    const at = ObjectReferenceEx.getWorldOrCell(player);
    const pos = ObjectReferenceEx.getPos(player);
    if (at === target.worldOrCell && ObjectReferenceEx.getDistance(pos, target.pos) < PLAYER_TELEPORT_REACH) {
      this.playerTeleport = undefined;
      if (target.moves > 1 || !target.ragdollReturned) {
        this.reportPlayerTeleport('recovered', target, at);
      }
      return;
    }
    if (target.moves < PLAYER_TELEPORT_MOVES) {
      logToPlatformLog(this, `teleport to ${target.worldOrCell.toString(16)} did not take, player in ${at.toString(16)} at ${pos.map((v) => Math.round(v)).join(',')}, move ${target.moves + 1}`);
      this.movePlayerTo(target);
      return;
    }
    this.playerTeleport = undefined;
    this.resyncing = true;
    this.reportPlayerTeleport('stuck', target, at);
    notifyNextUpdate(this.controller, this.sp, loc("sync.positionLost"));
    this.controller.lookupListener(TimersService).setTimeoutOnUpdate(() => { if (this.resyncing) Game.quitToMainMenu(); }, PLAYER_TELEPORT_RESYNC_MS);
  }

  private reportPlayerTeleport(outcome: 'recovered' | 'stuck', target: PlayerTeleport, at: number): void {
    const sinceLoadS = this.lastLoadAt ? Math.round((Date.now() - this.lastLoadAt) / 1000) : -1;
    logToPlatformLog(this, `teleport ${outcome}: to ${target.worldOrCell.toString(16)}, player in ${at.toString(16)}, ${target.moves} move(s), ragdoll wait ${target.ragdollReturned ? 'returned' : 'failed or timed out'}, race menu seen ${this.raceMenuSeen}, ${sinceLoadS} s since load`);
    sendCustomPacket(this.controller, {
      customPacketType: 'teleportReport',
      outcome,
      worldOrCell: target.worldOrCell,
      clientWorldOrCell: at,
      moves: target.moves,
      ragdollReturned: target.ragdollReturned,
      raceMenuSeen: this.raceMenuSeen,
      sinceLoadS,
    });
  }

  private onCreateActorMessage(event: ConnectionMessage<CreateActorMessage>): void {
    const msg = event.message;
    if (this.skipFormViewCreation(msg)) {
      const refrId = msg.refrId!;
      // An idx names a plugin ref or a form, never both
      if (this.getIdManager().getId(msg.idx) !== -1) {
        this.removeForm(msg.idx);
        this.getIdManager().freeIdFor(msg.idx);
      }
      this.dropPluginRef(msg.idx);
      const old = pluginRefs.get(refrId);
      if (old) this.dropPluginRef(old.idx);
      this.pluginRefByIdx.set(msg.idx, refrId);
      pluginRefs.set(refrId, {
        idx: msg.idx,
        props: msg.props ? { ...msg.props } : {},
        custom: this.parseCustomProps(msg),
        pose: msg.transform ? { pos: msg.transform.pos, rot: msg.transform.rot } : undefined,
        applied: false,
        changed: new Set(),
      });
      this.pluginRefsDue.add(refrId);
      return;
    }

    logTrace(this, "Create actor");

    // An idx names a plugin ref or a form, never both
    this.dropPluginRef(msg.idx);

    if (this.getIdManager().getId(msg.idx) !== -1) {
      logToPlatformLog(this, `repeated CreateActor for idx ${msg.idx} (refr ${(msg.refrId ?? 0).toString(16)}), model and view replaced`);
      this.removeForm(msg.idx);
    }
    const i = this.getIdManager().allocateIdFor(msg.idx);
    if (this.worldModel.forms.length <= i) {
      this.worldModel.forms.length = i + 1;
    }

    let movement: Movement | undefined = undefined;
    // TODO: better check if it is an npc (not an object reference)
    if (msg.refrId !== undefined && msg.refrId >= 0xff000000) {
      movement = {
        pos: msg.transform.pos,
        rot: msg.transform.rot,
        worldOrCell: msg.transform.worldOrCell,
        runMode: 'Standing',
        direction: 0,
        isInJumpState: false,
        isSneaking: false,
        isBlocking: false,
        isWeapDrawn: false,
        isDead: false,
        healthPercentage: 1.0,
        speed: 0,
      };
    }

    const form: FormModel = {
      idx: msg.idx,
      movement,
      numMovementChanges: 0,
      numAppearanceChanges: 0,
      baseId: msg.baseId,
      refrId: msg.refrId,
      isMyClone: msg.isMe,
    };
    this.worldModel.forms[i] = form;
    if (msg.refrId) {
      this.formIdxByRefrId.set(msg.refrId, i);
    }

    if (msg.appearance) {
      form.appearance = msg.appearance;
    }

    if (msg.equipment) {
      form.equipment = msg.equipment;
    }

    if (msg.isDead) {
      form.isDead = msg.isDead;
    }

    if (msg.animation) {
      form.animation = msg.animation;
    }

    if (msg.props) {
      for (const propName in msg.props) {
        (form as Record<string, unknown>)[propName] = msg.props[propName as keyof CreateActorMessageAdditionalProps];
      }
    }

    Object.assign(form as Record<string, unknown>, this.parseCustomProps(msg));

    if (msg.isMe) {
      this.worldModel.playerCharacterFormIdx = i;
      this.worldModel.playerCharacterRefrId = msg.refrId || 0;
      this.playerTeleport = undefined;
      this.resyncing = false;
      storage["ownerModel"] = form;
      storage["ownerModelSet"] = true;
      this.controller.emitter.emit("ownerModelReset", { model: form });
    }

    // A failed load leaves our 'update' callbacks queued; a newer spawn of ours drops them
    const spawnSeq = msg.isMe ? ++this.playerSpawnSeq : this.playerSpawnSeq;
    if (msg.isMe) {
      this.raceCheck = { spawnSeq, formIdx: i, synced: false, settleFrom: 0, due: "spawn", menuLoggedAt: 0, leftovers: [] };
      spawnTiming = {
        seq: spawnSeq, createdAt: Date.now(), loadAt: 0, loadedAt: 0, dressedAt: 0, inventoryAt: 0, raceMenuMs: 0,
        strips: 0, topUps: 0, topUpEquips: 0, applies: 0, added: 0, removed: 0, equips: 0, unequips: 0, frames: newFrameStats(),
      };
      // The previous character's pack is never applied to this one before its own arrives
      setPcInventory(undefined);
      this.serverInventory = msg.props?.inventory;
      spawnEquipment = undefined;
      spawnTopUp = "none";
    }

    // A creation request that reached us before our own spawn is re-issued for it; a finished one stays closed
    const carryRaceMenu = msg.isMe && this.raceMenuPending;
    if (msg.isMe) {
      this.raceMenuPending = false;
    }
    if (msg.isMe && (carryRaceMenu || (msg.props && msg.props.isRaceMenuOpen))) {
      if (carryRaceMenu) logToPlatformLog(this, `race menu request carried over to spawn ${spawnSeq}`);
      this.onSetRaceMenuOpenMessage({ message: { t: MsgType.SetRaceMenuOpen, open: true } });
    }

    const numSetInventory = this.numSetInventory;
    let dressed = false;

    const applyPcInv = () => {
      if (spawnSeq !== this.playerSpawnSeq) return;
      if (dressed) {
        resyncSpawnEquipment();
        return;
      }
      dressed = true;
      if (spawnTiming?.seq === spawnSeq) spawnTiming.dressedAt = Date.now();
      const skipInventory = numSetInventory !== this.numSetInventory;
      if (msg.equipment) {
        applySpawnEquipment(Game.getPlayer()!, msg.equipment);
        logToPlatformLog(this, `spawn outfit applied: worn ${getPlayerWorn(msg.equipment).length} of ${msg.equipment.inv.entries.length} saved (numChanges ${msg.equipment.numChanges}), inventory apply skipped:`, skipInventory);
      }

      if (skipInventory) {
        logTrace(this, 'Skipping inventory apply due to newer setInventory message');
        // The strip emptied the pack, so the newer inventory goes on again
        requestPcInventoryApply();
        return;
      }

      if (msg.props && msg.props.inventory) {
        this.onSetInventoryMessage({
          message: {
            t: MsgType.SetInventory,
            inventory: msg.props.inventory
          }
        });
      }
    };

    if (msg.isMe && msg.props && msg.props.learnedSpells) {
      const spawnSpells = msg.props.learnedSpells;

      once('update', () => {
        if (spawnSeq !== this.playerSpawnSeq) return;
        Utility.wait(1).then(() => {
          // The race menu pauses this wait, so the list the server sent last is the one to apply
          const learnedSpells = this.worldModel.forms[i]?.learnedSpells ?? spawnSpells;
          const player = Game.getPlayer();

          if (player && spawnSeq === this.playerSpawnSeq && i === this.worldModel.playerCharacterFormIdx) {
            const leftovers = this.applySpawnSpells(player, learnedSpells);
            if (this.raceCheck?.spawnSeq === spawnSeq) {
              this.raceCheck.synced = true;
              this.noteLeftovers(this.raceCheck, leftovers);
            }
            if (leftovers.length) logToPlatformLog(this, `spawn race sync cleared vanilla leftovers: ${leftovers.map(describeLeftover).join(", ")}`);
            logTrace(this,
              `player learnedSpells:`, JSON.stringify(learnedSpells),
            );
          }
        });
      });
    }

    if (msg.isMe) {
      if (msg.props?.isDead) {
        once("update", () => {
          if (spawnSeq !== this.playerSpawnSeq) return;
          this.controller.emitter.emit("applyDeathStateEvent", {
            actor: Game.getPlayer()!,
            isDead: true,
            trigger: "spawn"
          });
        });
      }
    }

    if (msg.isMe) {
      const spawnTask = { running: false };
      once('update', () => {
        if (spawnSeq !== this.playerSpawnSeq) return;
        // Use MoveRefrToPosition to spawn if possible (not in main menu); essential after a lost connection
        if (!spawnTask.running) {
          spawnTask.running = true;
          logTrace(this, 'Using moveRefrToPosition to spawn player');
          (async () => {
            while (true) {
              logTrace(this, 'Spawning...');
              TESModPlatform.moveRefrToPosition(
                Game.getPlayer(),
                Cell.from(Game.getFormEx(msg.transform.worldOrCell)),
                WorldSpace.from(Game.getFormEx(msg.transform.worldOrCell)),
                msg.transform.pos[0],
                msg.transform.pos[1],
                msg.transform.pos[2],
                msg.transform.rot[0],
                msg.transform.rot[1],
                msg.transform.rot[2],
              );
              await Utility.wait(1);
              const pl = Game.getPlayer();
              if (!pl) {
                break;
              }
              const pos = [
                pl.getPositionX(),
                pl.getPositionY(),
                pl.getPositionZ(),
              ];
              const sqr = (x: number) => x * x;
              const distance = Math.sqrt(
                sqr(pos[0] - msg.transform.pos[0]) +
                sqr(pos[1] - msg.transform.pos[1]),
              );
              if (distance < 256) {
                break;
              }
            }
          })();
          // Unfortunatelly it requires two calls to work
          Utility.wait(1).then(applyPcInv);
          Utility.wait(1.3).then(applyPcInv);
          // Note: appearance part was copy-pasted
          if (msg.appearance) {
            applyAppearanceToPlayer(msg.appearance);
          }
        }

        if (msg.props) {
          const baseActorValues = new Map<string, unknown>([
            ['healRate', msg.props.healRate],
            ['healRateMult', msg.props.healRateMult],
            ['health', msg.props.health],
            ['magickaRate', msg.props.magickaRate],
            ['magickaRateMult', msg.props.magickaRateMult],
            ['magicka', msg.props.magicka],
            ['staminaRate', msg.props.staminaRate],
            ['staminaRateMult', msg.props.staminaRateMult],
            ['stamina', msg.props.stamina],
            ['healthPercentage', msg.props.healthPercentage],
            ['staminaPercentage', msg.props.staminaPercentage],
            ['magickaPercentage', msg.props.magickaPercentage],
          ]);

          const player = Game.getPlayer();
          if (player) {
            baseActorValues.forEach((value, key) => {
              if (typeof value === 'number') {
                if (key.includes('Percentage')) {
                  const subKey = key.replace('Percentage', '');
                  const subValue = baseActorValues.get(subKey);
                  if (typeof subValue === 'number') {
                    setActorValuePercentage(player, subKey, value);
                    if (subKey === 'health') {
                      this.controller.lookupListener(RemoteDamageGuardService).onServerHealth(value);
                    }
                  }
                } else {
                  player.setActorValue(key, value);
                }
              }
            });
          }
        }
      });
      once('tick', () => {
        once('tick', () => {
          if (!spawnTask.running) {
            spawnTask.running = true;

            let loadOrder = new Array<string>();
            for (let i = 0; i < this.sp.Game.getModCount(); ++i) {
              loadOrder.push(this.sp.Game.getModName(i));
            }

            logTrace(this, `loading game in world/cell`, msg.transform.worldOrCell.toString(16));
            if (spawnTiming?.seq === spawnSeq) spawnTiming.loadAt = Date.now();
            const loadGameService = this.controller.lookupListener(LoadGameService);
            if (!loadGameService.loadGame(
              msg.transform.pos,
              msg.transform.rot,
              msg.transform.worldOrCell,
              msg.appearance
                ? {
                  name: msg.appearance.name,
                  raceId: msg.appearance.raceId,

                  // TODO: In types, isFemale is under face, but in the reality SP expects it here. Fix required.
                  // @ts-expect-error
                  isFemale: msg.appearance.isFemale,

                  face: {
                    hairColor: msg.appearance.hairColor,
                    bodySkinColor: msg.appearance.skinColor,
                    headTextureSetId: msg.appearance.headTextureSetId,
                    headPartIds: msg.appearance.headpartIds,
                    presets: msg.appearance.presets
                  },
                }
                : undefined,
              loadOrder,
              this.controller.lookupListener(TimeService).getLoadGameTime()
            )) return;
            once('update', () => {
              applyPcInv();
              Utility.wait(0.3).then(applyPcInv);
              // Note: appearance part was copy-pasted
              if (msg.appearance) {
                applyAppearanceToPlayer(msg.appearance);
              }
            });
          }
        });
      });
    }
  }

  private onDestroyActorMessage(event: ConnectionMessage<DestroyActorMessage>): void {
    const idx = event.message.idx;
    if (this.dropPluginRef(idx) || this.getIdManager().getId(idx) === -1) return;
    this.removeForm(idx);
    this.getIdManager().freeIdFor(idx);
  }

  // Drops the model at this idx and destroys its view; the idx keeps its id
  private removeForm(idx: number): void {
    const i = this.getIdManager().getId(idx);
    const refrId = this.worldModel.forms[i]?.refrId;
    // Another form with this refrId may own the entry
    if (refrId && this.formIdxByRefrId.get(refrId) === i) {
      this.formIdxByRefrId.delete(refrId);
      forgetHostAttempts(refrId);
    }
    this.worldModel.forms[i] = undefined;
    getViewFromStorage()?.getFormViews().destroyForm(i);

    // Shrink to fit
    while (1) {
      const length = this.worldModel.forms.length;
      if (!length) {
        break;
      }
      if (this.worldModel.forms[length - 1]) {
        break;
      }
      this.worldModel.forms.length = length - 1;
    }

    if (this.worldModel.playerCharacterFormIdx === i) {
      this.worldModel.playerCharacterFormIdx = -1;
      this.worldModel.playerCharacterRefrId = 0;

      // TODO: move to a separate module
      // "update" doesn't fire in the main menu, so this can trigger long after queueing;
      // re-check on fire since the server may have re-created our actor by then.
      once('update', () => {
        if (this.worldModel.playerCharacterFormIdx === -1) {
          logToPlatformLog(this, "own actor destroyed, quitting to the main menu");
          Game.quitToMainMenu();
        }
      });
    }
  }

  private onUpdateMovementMessage(event: ConnectionMessage<UpdateMovementMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateMovementMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    setFormMovement(form, msg.data);
  }

  private onUpdateAnimationMessage(event: ConnectionMessage<UpdateAnimationMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateAnimationMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.animation = msg.data;
  }

  private onUpdateAppearanceMessage(event: ConnectionMessage<UpdateAppearanceMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateAppearanceMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.appearance = msg.data || undefined;
    if (!form.numAppearanceChanges) {
      form.numAppearanceChanges = 0;
    }
    form.numAppearanceChanges++;
    this.emitOwnerPropertyChanged(i, "appearance", form.appearance);

    const newAppearance = msg.data;

    if (i === this.getMyActorIndex() && newAppearance) {
      this.controller.once("update", () => {
        if (this.ownAppearanceHeld) {
          this.heldOwnAppearance = newAppearance;
          return;
        }
        this.applyOwnAppearance(newAppearance);
      });
    }
  }

  private applyOwnAppearance(appearance: Appearance): void {
    applyAppearanceToPlayer(appearance);
    const player = Game.getPlayer();
    if (player) {
      syncRaceAbilities(player, []);
    }
    logTrace(this, "Applied appearance to the player");
  }

  // PolymorphService holds the own look back while its race switch waits for a weapon to be put away
  holdOwnAppearance(): void {
    this.ownAppearanceHeld = true;
  }

  // Ends the hold: a held look of that race goes on (must run on update), any other is dropped
  releaseOwnAppearance(raceId = 0): void {
    const look = this.heldOwnAppearance;
    this.ownAppearanceHeld = false;
    this.heldOwnAppearance = undefined;
    if (look && look.raceId >>> 0 === raceId) this.applyOwnAppearance(look);
  }

  private onUpdateEquipmentMessage(event: ConnectionMessage<UpdateEquipmentMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateEquipmentMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.equipment = msg.data;
  }

  private parseCustomProps(msg: CreateActorMessage): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    msg.customPropsJsonDumps.forEach(element => {
      try {
        out[element.propName] = JSON.parse(element.propValueJsonDump);
      } catch (e) {
        if (e instanceof SyntaxError) {
          logError(this, "createActor", msg.refrId?.toString(16), "failed to parse custom prop", element.propName, element.propValueJsonDump, e.message);
        } else {
          throw e;
        }
      }
    });
    return out;
  }

  private onUpdatePropertyMessage(event: ConnectionMessage<UpdatePropertyMessage>): void {
    const msg = event.message;
    const msgData = this.extractUpdatePropertyMessageData(msg);

    if (this.skipFormViewCreation(msg)) {
      this.onPluginRefProperty(msg, msgData);
      return;
    }
    const i = this.getIdManager().getId(msg.idx);
    const form = this.worldModel.forms[i];
    if (form === undefined) {
      logError(this, `onUpdatePropertyMessage - Form with idx`, msg.idx, `not found for`, msg.propName);
      return;
    }
    (form as Record<string, unknown>)[msg.propName] = msgData;
    this.emitOwnerPropertyChanged(i, msg.propName, msgData);

    // Sent after the race menu, whose race switch brings the new race's spells
    if (msg.propName === 'learnedSpells' && i === this.worldModel.playerCharacterFormIdx && Array.isArray(msgData)) {
      once('update', () => {
        const player = Game.getPlayer();
        if (player) {
          dropUnlistedBaseSpells(this.sp as unknown as SpellListNatives, player, msgData as number[]);
          learnSpells(player, msgData as number[]);
          this.noteLeftovers(this.currentRaceCheck(), syncRaceAbilities(player, msgData as number[]));
        }
      });
    }
  }

  // Listeners may run inside a packet handler, so they defer natives to an update
  private emitOwnerPropertyChanged(i: number, propName: string, value: unknown): void {
    if (i === this.worldModel.playerCharacterFormIdx) {
      this.controller.emitter.emit("ownerPropertyChanged", { propName, value });
    }
  }

  private onDeathStateContainerMessage(event: ConnectionMessage<DeathStateContainerMessage>): void {
    const msg = event.message;

    logTrace(this, `Received death state:`, JSON.stringify(msg.tIsDead));

    const id = this.getIdManager().getId(msg.tIsDead.idx);
    const form = this.worldModel.forms[id];

    if (form === undefined) {
      logError(this, `onDeathStateContainerMessage - Form with idx`, msg.tIsDead.idx, `not found`);
      return;
    }

    if (msg.tIsDead.propName !== nameof<FormModel>('isDead')) {
      logError(this, `onDeathStateContainerMessage - Invalid propName`, msg.tIsDead.propName);
      return;
    }

    const msgData = this.extractUpdatePropertyMessageData(msg.tIsDead);
    if (typeof msgData !== 'boolean') {
      logError(this, `onDeathStateContainerMessage - Invalid data`, msgData);
      return;
    }

    if (msg.tChangeValues) {
      this.onChangeValuesMessage({ message: msg.tChangeValues });
    }
    once('update', () => this.onUpdatePropertyMessage({ message: msg.tIsDead }));

    if (msg.tTeleport) {
      this.onTeleportMessage({ message: msg.tTeleport });
    }

    once('update', () => {
      const actor =
        id === this.getWorldModel().playerCharacterFormIdx
          ? Game.getPlayer()!
          : Actor.from(Game.getFormEx(remoteIdToLocalId(form.refrId ?? 0)));
      if (actor) {
        try {
          this.controller.emitter.emit("applyDeathStateEvent", {
            actor: actor,
            isDead: msgData,
            trigger: "container",
            serverPos: form.movement?.pos
          });
        } catch (e) {
          if (e instanceof RespawnNeededError) {
            actor.disableNoWait(false);
            actor.delete();
          } else {
            throw e;
          }
        }
      }
    });
  }

  private handleConnectionAccepted(): void {
    this.worldModel.forms = [];
    this.formIdxByRefrId.clear();
    this.worldModel.playerCharacterFormIdx = -1;
    this.worldModel.playerCharacterRefrId = 0;
    this.playerTeleport = undefined;
    this.resyncing = false;
    this.serverInventory = undefined;
    // Views are indexed by these ids, so a new id must never reach an old view
    storage['idManager'] = new IdManager();
    getViewFromStorage()?.resetFormViews();
    storage['hosted'] = [];
    disposeCopyAnimationSources();
    resetHostAttempts();
    this.resetPluginRefs();
    this.cloneCastWatch.clear();
    this.cloneCastStoppedAt.clear();
    FormView.speakingUntil.clear();

    logTrace(this, "Handle connection accepted");
  }

  private onChangeValuesMessage(event: ConnectionMessage<ChangeValuesMessage>): void {
    const msg = event.message;

    this.onceInSession(() => {
      const id = this.getIdManager().getId(msg.idx);
      const isMe = id === this.getMyActorIndex();
      const refr = isMe ? Game.getPlayer() : getObjectReference(id);
      const ac = Actor.from(refr);
      if (!ac) {
        return;
      }

      const { health, stamina, magicka } = msg.data;
      if (typeof health === "number") {
        setActorValuePercentage(ac, 'health', health);
        if (isMe) {
          this.controller.lookupListener(RemoteDamageGuardService).onServerHealth(health);
        }
      }
      if (typeof stamina === "number") {
        setActorValuePercentage(ac, 'stamina', stamina);
      }
      if (typeof magicka === "number") {
        setActorValuePercentage(ac, 'magicka', magicka);
      }
    });
  }

  private onSetRaceMenuOpenMessage(event: ConnectionMessage<SetRaceMenuOpenMessage>): void {
    const msg = event.message;

    if (msg.open) {
      const spawnSeq = this.playerSpawnSeq;
      this.raceMenuPending = true;
      this.raceMenuRetries = 0;
      this.raceMenuSettledAt = 0;
      logToPlatformLog(this, `race menu requested for spawn ${spawnSeq}`);
      // wait 0.3s to avoid visual bugs when teleporting and showing this menu at the same time in onConnect
      once('update', () => {
        if (spawnSeq !== this.playerSpawnSeq) {
          logToPlatformLog(this, `race menu request dropped: spawn ${spawnSeq} replaced by ${this.playerSpawnSeq}`);
          return;
        }
        Utility.wait(0.3).then(() => this.showRaceMenu('first call'));
      });
    } else {
      this.raceMenuPending = false;
      // TODO: Implement closeMenu in SkyrimPlatform
    }
  }

  private showRaceMenu(why: string): void {
    if (!this.raceMenuPending || Ui.isMenuOpen(Menu.RaceSex)) {
      return;
    }
    logToPlatformLog(this, `showRaceMenu (${why}), loading ${Ui.isMenuOpen(Menu.Loading)}`);
    unequipDefaultOutfit();
    // Lit before the menu pauses the engine
    this.controller.lookupListener(CreationLightService).placeBeforeMenu(() => {
      if (this.raceMenuPending && !Ui.isMenuOpen(Menu.RaceSex)) Game.showRaceMenu();
    }, () => this.raceMenuPending);
  }

  // A pending creation whose menu never opened calls it again once no loading screen or focused page is up
  private checkRaceMenu(): void {
    if (!this.raceMenuPending || isMenuShown(Menu.RaceSex) || isMenuShown(Menu.Loading) || isMenuShown(Menu.Main) ||
        this.sp.browser.isFocused() || this.controller.lookupListener(CharacterSelectService).isMenuOpen()) {
      this.raceMenuSettledAt = 0;
      return;
    }
    const now = Date.now();
    if (!this.raceMenuSettledAt) {
      this.raceMenuSettledAt = now;
      return;
    }
    if (now - this.raceMenuSettledAt < RACE_MENU_RETRY_MS) {
      return;
    }
    this.raceMenuSettledAt = now;
    if (this.raceMenuRetries >= RACE_MENU_RETRIES) {
      logToPlatformLog(this, `race menu never opened after ${RACE_MENU_RETRIES} retries, giving up`);
      this.raceMenuPending = false;
      return;
    }
    this.raceMenuRetries++;
    this.showRaceMenu(`not open ${RACE_MENU_RETRY_MS} ms after the spawn settled, retry ${this.raceMenuRetries}/${RACE_MENU_RETRIES}`);
  }

  // Returns the vanilla racial leftovers the race sync cleared
  private applySpawnSpells(player: Actor, learnedSpells: number[]): LeftoverAbility[] {
    dropUnlistedBaseSpells(this.sp as unknown as SpellListNatives, player, learnedSpells);
    removeUnlistedSpells(player, learnedSpells);
    learnSpells(player, learnedSpells);
    return syncRaceAbilities(player, learnedSpells);
  }

  private currentRaceCheck(): RaceCheck | undefined {
    const check = this.raceCheck;
    if (check && (check.spawnSeq !== this.playerSpawnSeq || check.formIdx !== this.worldModel.playerCharacterFormIdx)) {
      this.raceCheck = undefined;
      return undefined;
    }
    return check;
  }

  private queueRaceCheck(reason: string): void {
    const check = this.currentRaceCheck();
    if (!check) {
      return;
    }
    check.due = check.due ?? reason;
    check.settleFrom = 0;
  }

  private listedSpellsOf(check: RaceCheck): number[] {
    const learned = this.worldModel.forms[check.formIdx]?.learnedSpells;
    return Array.isArray(learned) ? learned : [];
  }

  // A later sync's result for the same ability replaces the earlier one
  private noteLeftovers(check: RaceCheck | undefined, found: LeftoverAbility[]): void {
    if (!check || !found.length) {
      return;
    }
    check.leftovers = [...check.leftovers.filter((l) => !found.some((f) => f.id === l.id)), ...found];
  }

  // After a spawn, load, resurrect or race menu the race abilities are applied again (the whole spawn sync if it never ran) and logged before and after
  private checkRaceAbilities(): void {
    const check = this.currentRaceCheck();
    if (!check || !check.due) {
      return;
    }
    if (this.raceMenuPending || isMenuShown(Menu.RaceSex) || isMenuShown(Menu.Loading) || isMenuShown(Menu.Main) || isMenuShown(Menu.Magic)) {
      check.settleFrom = 0;
      return;
    }
    const now = Date.now();
    if (!check.settleFrom) {
      check.settleFrom = now;
      return;
    }
    const player = Game.getPlayer();
    if (now - check.settleFrom < RACE_CHECK_SETTLE_MS || !player) {
      return;
    }
    const reason = check.due;
    check.due = undefined;
    check.settleFrom = 0;
    const listed = this.listedSpellsOf(check);
    const before = describeRaceAbilities(player, listed, check.leftovers);
    const runSpawnSync = !check.synced && listed.length > 0;
    if (runSpawnSync) {
      this.noteLeftovers(check, this.applySpawnSpells(player, listed));
      check.synced = true;
    } else {
      this.noteLeftovers(check, syncRaceAbilities(player, listed));
    }
    const spawnSync = check.synced ? (runSpawnSync ? "missing, ran now" : "ran") : "missing, no list";
    // Read after syncRaceAbilities re-reads the movement speed
    Utility.wait(RACE_CHECK_AFTER_S).then(() => {
      const pc = Game.getPlayer();
      if (pc && this.currentRaceCheck() === check) {
        const after = describeRaceAbilities(pc, listed, check.leftovers);
        const masteryMagicka = this.controller.lookupListener(MasteryService).writtenMagicka;
        sendCustomPacket(this.controller, { customPacketType: "racialReport", reason, ...after.data, masteryMagicka });
        logToPlatformLog(this, `race abilities after ${reason}, spawn ${check.spawnSeq}, spawn sync ${spawnSync}, server listed ${listed.length}: ` +
          `before ${before.text} | after ${after.text} | racialReport sent, mastery magicka ${masteryMagicka ?? "none"}`);
      }
    });
  }

  // The server found the race abilities amiss (racialSystem.ts, once per spawn): a base race other than the server's gets the server's appearance again, then the race sync runs keeping the server's race spells
  private onRacialResync(content: CustomPacketContent): void {
    const raceId = Number(content["raceId"]) >>> 0;
    const expected = Array.isArray(content["spells"]) ? (content["spells"] as unknown[]).map((id) => Number(id) >>> 0).filter((id) => id) : [];
    const problems = Array.isArray(content["problems"]) ? (content["problems"] as unknown[]).map(String).join("; ") : "";
    this.controller.once("update", () => {
      const player = Game.getPlayer();
      if (!player || !raceId) {
        return;
      }
      const hex = (id: number) => id.toString(16);
      const baseRace = ActorBase.from(player.getBaseObject())?.getRace()?.getFormID() ?? 0;
      const appearance = this.worldModel.forms[this.worldModel.playerCharacterFormIdx]?.appearance;
      let race = `base race ${hex(baseRace)} is the server's`;
      if (baseRace !== raceId && this.ownAppearanceHeld) {
        race = `base race ${hex(baseRace)} kept, a polymorph holds the own look back`;
      } else if (baseRace !== raceId && appearance?.raceId === raceId) {
        applyAppearanceToPlayer(appearance);
        race = `base race ${hex(baseRace)} set to the server's ${hex(raceId)} from its appearance`;
      } else if (baseRace !== raceId) {
        race = `base race ${hex(baseRace)} kept, the server's ${hex(raceId)} is not the stored appearance's`;
      }
      const check = this.currentRaceCheck();
      const listed = check ? this.listedSpellsOf(check) : this.worldModel.forms[this.worldModel.playerCharacterFormIdx]?.learnedSpells ?? [];
      const added = resyncRaceAbilities(player, listed, expected);
      logToPlatformLog(this, `racialResync from the server (${problems || "no problems named"}): ${race}; race sync ran keeping ${expected.map(hex).join(", ") || "none"}, ` +
        `added from outside the race record ${added.map(hex).join(", ") || "none"}; ${check ? `checked again ${RACE_CHECK_SETTLE_MS / 1000} s after the world settles` : "no race check of this spawn to repeat"}`);
      this.queueRaceCheck("resync");
    });
  }

  // The server's racialBase after an accepted race menu: the creation spawn carried the Player NPC_ race's base values
  private onRacialBase(content: CustomPacketContent): void {
    const value = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    this.raceBase = { raceId: Number(content["raceId"]) >>> 0, spawnSeq: this.playerSpawnSeq, health: value(content["health"]), stamina: value(content["stamina"]) };
  }

  // Written once the race menu and loading are over, with the current percentages kept as the server syncs shares of the maximum
  private applyRaceBase(): void {
    const pending = this.raceBase;
    if (!pending || this.raceMenuPending || isMenuShown(Menu.RaceSex) || isMenuShown(Menu.Loading)) {
      return;
    }
    this.raceBase = undefined;
    const player = Game.getPlayer();
    if (!player || pending.spawnSeq !== this.playerSpawnSeq) {
      return;
    }
    const changes = new Array<string>();
    for (const [av, value] of [["Health", pending.health], ["Stamina", pending.stamina]] as Array<[string, number]>) {
      const before = player.getBaseActorValue(av);
      if (!value || Math.abs(before - value) < 0.5) {
        continue;
      }
      const share = player.getActorValuePercentage(av);
      player.setActorValue(av, value);
      setActorValuePercentage(player, av, share);
      changes.push(`${av.toLowerCase()} ${Math.round(before)} -> ${Math.round(value)}`);
    }
    logToPlatformLog(this, `racialBase for race ${pending.raceId.toString(16)}: ${changes.length ? `${changes.join(", ")} (percentages kept)` : "health and stamina already the race's"}`);
  }

  // What the owner sees in Active Effects and Powers, on the Magic menu's first open per spawn and then at most once a minute; anything amiss is applied again once the menu closes
  private logRaceAbilitiesInMagicMenu(): void {
    const check = this.currentRaceCheck();
    const player = Game.getPlayer();
    const now = Date.now();
    if (!check || !player || (check.menuLoggedAt && now - check.menuLoggedAt < RACE_MENU_LOG_MS)) {
      return;
    }
    check.menuLoggedAt = now;
    const listed = this.listedSpellsOf(check);
    const report = describeRaceAbilities(player, listed, check.leftovers);
    logToPlatformLog(this, `race abilities in the Magic menu, spawn ${check.spawnSeq}, server listed ${listed.length}: ${report.text}`);
    if (report.problems.length) {
      this.queueRaceCheck("the Magic menu");
    }
  }

  /** Packet handlers end **/

  getWorldModel(): WorldModel {
    return this.worldModel;
  }

  // The newest form the server streamed with this refrId (64-bit for plugin actors)
  getFormByRefrId(refrId: number): FormModel | undefined {
    const i = this.formIdxByRefrId.get(refrId);
    return i === undefined ? undefined : this.worldModel.forms[i];
  }

  getMyActorIndex(): number {
    return this.worldModel.playerCharacterFormIdx;
  }

  getMyRemoteRefrId(): number {
    return this.worldModel.playerCharacterRefrId;
  }

  getIdManager() {
    return this.idManager_;
  }

  private get worldModel(): WorldModel {
    if (typeof storage["worldModel"] === "function") {
      storage["worldModel"] = { forms: [], playerCharacterFormIdx: -1, playerCharacterRefrId: 0 };
    }
    return storage["worldModel"] as WorldModel;
  }

  private get idManager_(): IdManager {
    if (typeof storage["idManager"] === "function") {
      // Note: full IdManager object preserved across hot-reloads, including methods.
      storage["idManager"] = new IdManager();
    }
    return storage["idManager"] as IdManager;
  }

  // Across a reconnect an unknown idx and the unset own index both read -1, so a deferred packet would land on the player
  private onceInSession(callback: () => void): void {
    const ids = this.getIdManager();
    once('update', () => {
      if (ids === this.getIdManager()) callback();
    });
  }

  // Returns false when the idx is not a plugin ref
  private dropPluginRef(idx: number): boolean {
    const refrId = this.pluginRefByIdx.get(idx);
    if (refrId === undefined) return false;
    this.pluginRefByIdx.delete(idx);
    if (pluginRefs.get(refrId)?.idx === idx) {
      pluginRefs.delete(refrId);
      this.pluginRefsWaiting.delete(refrId);
      this.pluginRefsPolled.delete(refrId);
    }
    return true;
  }

  private resetPluginRefs(): void {
    pluginRefs.clear();
    this.pluginRefByIdx.clear();
    this.pluginRefsDue.clear();
    this.pluginRefsWaiting.clear();
    this.pluginRefsPolled.clear();
  }

  private updatePluginRefs(): void {
    if (this.pluginRefsDue.size) {
      this.pluginRefsDue.forEach((refrId) => {
        if (!pluginRefs.has(refrId)) return;
        const refr = ObjectReference.from(Game.getFormEx(refrId));
        if (refr) this.applyPluginRef(refrId, refr, "atOnce");
        else this.waitForPluginRef(refrId);
      });
      this.pluginRefsDue.clear();
    }
    if (!this.pluginRefsPolling) return;
    const now = Date.now();
    if (now < this.pluginRefPollAt) return;
    this.pluginRefPollAt = now + PLUGIN_REF_POLL_MS;
    this.pluginRefsPolled.forEach((since, refrId) => {
      if (now - since >= PLUGIN_REF_POLL_WINDOW_MS) {
        this.pluginRefsPolled.delete(refrId);
        this.pluginRefApplies.lapsed++;
        return;
      }
      if (now - since < PLUGIN_REF_POLL_MS) return;
      const refr = ObjectReference.from(Game.getFormEx(refrId));
      if (refr) this.applyPluginRef(refrId, refr, "fallback");
    });
    if (this.pluginRefsPolled.size) return;
    this.pluginRefsPolling = false;
    const a = this.pluginRefApplies;
    logToPlatformLog(this, `plugin refs since start: ${a.atOnce} applied at once, ${a.cellAttach} on cellAttach, ${a.moveAttachDetach} on moveAttachDetach, ${a.fallback} by the fallback poll, ${a.lapsed} not loaded within ${PLUGIN_REF_POLL_WINDOW_MS / 1000} s`);
  }

  private waitForPluginRef(refrId: number): void {
    this.pluginRefsWaiting.add(refrId);
    if (!this.pluginRefsPolled.has(refrId)) this.pluginRefsPolled.set(refrId, Date.now());
    this.pluginRefsPolling = true;
  }

  // One subscription per event for the plugin ref records and the world cleaner
  private onRefAttached(refr: ObjectReference | null | undefined, how: "cellAttach" | "moveAttachDetach"): void {
    if (!refr) return;
    this.onPluginRefAttached(refr, how);
    this.controller.lookupListener(WorldCleanerService).cleanAttached(refr, how === "cellAttach");
  }

  private onPluginRefAttached(refr: ObjectReference, how: "cellAttach" | "moveAttachDetach"): void {
    if (!this.pluginRefsWaiting.size) return;
    const refrId = refr.getFormID();
    if (this.pluginRefsWaiting.has(refrId)) this.applyPluginRef(refrId, refr, how);
  }

  private applyPluginRef(refrId: number, refr: ObjectReference, how: Exclude<keyof PluginRefApplies, "lapsed">): void {
    const rec = pluginRefs.get(refrId);
    if (!rec) return;
    if (this.pluginRefsWaiting.delete(refrId) || !rec.applied) this.pluginRefApplies[how]++;
    this.pluginRefsPolled.delete(refrId);
    if (rec.applied) {
      rec.changed.forEach((prop) => this.applyPluginRefProp(refr, rec, prop));
      rec.changed.clear();
      return;
    }
    rec.applied = true;
    rec.changed.clear();
    const { props, custom } = rec;
    this.applyPluginRefPose(refr, rec);
    if (props.inventory) {
      ModelApplyUtils.applyModelInventory(refr, props.inventory);
    }
    ModelApplyUtils.applyModelIsOpen(refr, !!props.isOpen);
    ModelApplyUtils.applyModelNodeScale(refr, props.setNodeScale);
    ModelApplyUtils.applyModelNodeTextureSet(refr, props.setNodeTextureSet);
    this.applyPluginRefVisibility(refr, rec);

    const animation = props.lastAnimation;
    if (typeof animation === "string") {
      this.controller.lookupListener(CellAnimationsService).queue(refrId, animation);
    }

    let displayName = props.displayName;
    // keep in sync with spSnippetService.ts
    if (typeof displayName === "string") {
      const replaceValue = refr.getBaseObject()?.getName();
      if (replaceValue !== undefined) {
        displayName = displayName.replace(/%original_name%/g, replaceValue);
      } else {
        logError(this, "Couldn't get a replaceValue for SetDisplayName, refr.getFormID() was", refrId.toString(16));
      }
      refr.setDisplayName(displayName, true);
      logTrace(this, `calling setDisplayName`, displayName, `for`, refrId.toString(16));
    }
    ModelApplyUtils.applyModelDecor(refr, custom["ff_decor"]);
  }

  private onPluginRefProperty(msg: UpdatePropertyMessage, value: unknown): void {
    const { refrId, propName } = msg;
    let rec = pluginRefs.get(refrId);
    // No CreateActor seen, as for a ref streamed before a hot reload
    if (!rec) {
      this.dropPluginRef(msg.idx);
      rec = { idx: msg.idx, props: {}, custom: {}, applied: true, changed: new Set() };
      pluginRefs.set(refrId, rec);
      this.pluginRefByIdx.set(msg.idx, refrId);
    }
    if (propName.startsWith("ff_")) rec.custom[propName] = value;
    else (rec.props as Record<string, unknown>)[propName] = value;
    if (!rec.applied || !PLUGIN_REF_PROPS_APPLIED.has(propName)) return;
    // The end of a carry comes with itemMoved, which shows the item at its new spot
    if (propName === 'ff_carried' && !carriedByOther(value)) return;
    this.queuePluginRefProp(refrId, rec, propName);
  }

  private queuePluginRefProp(refrId: number, rec: PluginRef, prop: string): void {
    // The last change is applied last, as the packets came
    rec.changed.delete(prop);
    rec.changed.add(prop);
    if (!this.pluginRefsWaiting.has(refrId)) this.pluginRefsDue.add(refrId);
  }

  // A loaded game puts back every plugin ref as the plugin placed it: shown, unharvested, at the plugin's spot, with its own lock and name
  private requeuePluginRefs(): void {
    pluginRefs.forEach((rec, refrId) => {
      if (!rec.applied) return;
      if (rec.custom["ff_moved"] === true && rec.pose) this.queuePluginRefProp(refrId, rec, 'ff_moved');
      if (rec.custom["ff_decor"]) this.queuePluginRefProp(refrId, rec, 'ff_decor');
      if (rec.props.isHarvested || pluginRefHidden(rec)) this.queuePluginRefProp(refrId, rec, 'isHarvested');
    });
  }

  // A plugin item the server moved; untouched ones keep the plugin's placement
  private applyPluginRefPose(refr: ObjectReference, rec: PluginRef): void {
    const pose = rec.pose;
    if (rec.custom["ff_moved"] !== true || !pose) return;
    refr.setPosition(pose.pos[0], pose.pos[1], pose.pos[2]);
    refr.setAngle(pose.rot[0], pose.rot[1], pose.rot[2]);
  }

  private applyPluginRefVisibility(refr: ObjectReference, rec: PluginRef): void {
    ModelApplyUtils.applyModelVisibility(refr, !!rec.props.isHarvested, () => pluginRefHidden(rec));
  }

  private applyPluginRefProp(refr: ObjectReference, rec: PluginRef, prop: string): void {
    const props = rec.props;
    if (prop === 'inventory') {
      ModelApplyUtils.applyModelInventory(refr, props.inventory as Inventory);
    } else if (prop === 'isOpen') {
      ModelApplyUtils.applyModelIsOpen(refr, !!props.isOpen);
    } else if (prop === 'isHarvested' || prop === 'disabled' || prop === 'ff_carried') {
      this.applyPluginRefVisibility(refr, rec);
    } else if (prop === 'ff_moved') {
      this.applyPluginRefPose(refr, rec);
    } else if (prop === 'ff_decor') {
      ModelApplyUtils.applyModelDecor(refr, rec.custom["ff_decor"]);
    }
  }

  private skipFormViewCreation(
    msg: UpdatePropertyMessage | CreateActorMessage,
  ) {
    // Optimization added in #1186, however it doesn't work for doors for some reason
    return msg.refrId && msg.refrId < 0xff000000 && msg.baseRecordType !== 'DOOR';
  };

  private extractUpdatePropertyMessageData(updatePropertyMessage: UpdatePropertyMessage) {
    let msgData: unknown = updatePropertyMessage.data;

    if (updatePropertyMessage.dataDump !== undefined) {
      try {
        msgData = JSON.parse(updatePropertyMessage.dataDump);
      } catch (e) {
        if (e instanceof SyntaxError) {
          logError(this, 'extractUpdatePropertyMessageData - Failed to parse dataDump', updatePropertyMessage.dataDump);
          return;
        } else {
          throw e;
        }
      }
    }

    return msgData;
  }

  private onSpellCastMessage(event: ConnectionMessage<SpellCastMessage>): void {
    const msg = event.message;
    // The server echoes the player's own casts
    if (msg.data.caster === this.getMyRemoteRefrId()) {
      return;
    }

    once('update', () => {
      const ac = Actor.from(Game.getFormEx(remoteIdToLocalId(msg.data.caster)));
      if (!ac) {
        if (!msg.data.interruptCast && !msg.data.keepAlive) {
          logToPlatformLog(this, `spell ${msg.data.spell.toString(16)} of ${msg.data.caster.toString(16)} not replayed, caster not loaded`);
        }
        return;
      }
      // The host runs its own NPC's real cast, a replay of the relayed copy would cast and hit twice
      if (isHostedByMe(ac.getFormID())) {
        return;
      }

      const actorAnimationVariables: ActorAnimationVariables = {
        booleans: new Uint8Array(msg.data.actorAnimationVariables.booleans),
        floats: new Uint8Array(msg.data.actorAnimationVariables.floats),
        integers: new Uint8Array(msg.data.actorAnimationVariables.integers)
      };

      const key = `${msg.data.caster}:${msg.data.castingSource}`;
      const now = Date.now();

      if (msg.data.interruptCast) {
        this.cloneCastWatch.delete(key);
        this.cloneCastStoppedAt.set(key, now);
        this.stopCloneCast(ac, msg.data.caster, msg.data.castingSource, actorAnimationVariables);
        return;
      }

      // Prefer the spell id in the message; the clone's equipped spell can be stale (spell swaps fire no equip event)
      const transmitted = msg.data.spell ? Game.getFormEx(msg.data.spell) : null;
      const spellId = transmitted ? msg.data.spell : ac.getEquippedSpell(msg.data.castingSource)?.getFormID();
      const damageGuard = this.controller.lookupListener(RemoteDamageGuardService);

      // Keep-alives and recasts of a running channel at any target only refresh the clone, recasting would stack concentration casts
      const channel = spellId !== undefined && this.isConcentrationSpell(spellId);
      const watch = this.cloneCastWatch.get(key);
      const sameChannel = channel && watch !== undefined && watch.spellId === spellId;
      if (watch && (msg.data.keepAlive || sameChannel)) {
        watch.expiresAt = now + this.cloneCastTimeoutMs;
        if (spellId) {
          damageGuard.guardHostileReplay(ac.getFormID(), spellId, this.cloneCastTimeoutMs);
        }
        return;
      }
      // A keep-alive overtaking its own stop must not restart the clone
      if (msg.data.keepAlive && now - (this.cloneCastStoppedAt.get(key) ?? 0) < this.cloneCastStopMemoryMs) {
        return;
      }
      this.cloneCastStoppedAt.delete(key);

      // sweepCloneCasts ends a fire-and-forget replay, which gets no stop, and a channel whose refresh and stop both got lost
      this.cloneCastWatch.set(key, {
        casterRemoteId: msg.data.caster,
        expiresAt: now + (channel ? this.cloneCastTimeoutMs : this.cloneReplayTimeoutMs),
        castingSource: msg.data.castingSource,
        animVars: actorAnimationVariables,
        wasDrawn: ac.isWeaponDrawn(),
        spellId: spellId ?? 0,
      });

      if (spellId) {
        const hands = this.readyCloneHands(ac, spellId, msg.data.castingSource, msg.data.isDualCasting);
        // The replayed projectile takes aimAngle itself; a cast or channel the clone fires from its own graph takes its X angle
        // A clone on a horse or in a paired scene is placed by the engine, and the translation that aims it would pull it out
        if (hands.length > 0 && !isRiderClone(ac.getFormID()) && !isCloneMovementSuspended(ac.getFormID())) {
          aimForShot(ac, this.getFormByRefrId(msg.data.caster)?.movement, msg.data.aimAngle * 180 / Math.PI, `spell ${spellId.toString(16)}`);
        }
        const targetLocalId = this.getReplayTargetLocalId(msg.data.caster, msg.data.target, spellId);
        // The platform only casts Fire Storm or Blizzard on the clone when told the observer is guarded
        const replayedHostileSelf = castSpellImmediate(ac.getFormID(), msg.data.castingSource, spellId, targetLocalId,
          msg.data.aimAngle, msg.data.aimHeading, actorAnimationVariables, true) === true;
        if (replayedHostileSelf) {
          damageGuard.guardClone(ac.getFormID(), spellId);
        } else {
          damageGuard.guardHostileReplay(ac.getFormID(), spellId, this.cloneCastTimeoutMs);
        }
        // castSpellImmediate plays no cast animation, the vanilla graph starts one on BeginCastLeft or BeginCastRight
        hands.forEach((hand) => Debug.sendAnimationEvent(ac, hand === SpellType.Left ? "BeginCastLeft" : "BeginCastRight"));
        probeCopyCast("replay", ac, `spell ${spellId.toString(16)} replay (${channel ? "channel" : "one cast"}, source ${msg.data.castingSource}, target ${targetLocalId.toString(16)})`);
      }
    });
  }

  // The local player has no form view to map its own id through, and a target actor spell (Healing Hands, Soul Trap) replayed without its target never reaches it on the target's own screen
  // A sender with no actor under its crosshair names itself: such a cast flies where it was aimed, only a self spell is cast on its caster
  private getReplayTargetLocalId(casterRemoteId: number, targetRemoteId: number, spellId: number): number {
    if (targetRemoteId === this.getMyRemoteRefrId()) {
      return 0x14;
    }
    if (targetRemoteId === casterRemoteId && !isSelfDelivered(this.sp.Spell.from(Game.getFormEx(spellId)))) {
      return 0;
    }
    return remoteIdToLocalId(targetRemoteId);
  }

  // Papyrus InterruptCast ends castSpellImmediate concentration casts FinishCast may miss, but stops every hand
  private stopCloneCast(ac: Actor, casterRemoteId: number, castingSource: number, animVars: ActorAnimationVariables): void {
    interruptCast(ac.getFormID(), castingSource, animVars);
    const otherHandCasting = Array.from(this.cloneCastWatch.values()).some((watch) => watch.casterRemoteId === casterRemoteId);
    if (!otherHandCasting) {
      ac.interruptCast();
    }
  }

  // A clone shows the cast only with the spell drawn in the casting hand
  private readyCloneHands(ac: Actor, spellId: number, castingSource: number, isDualCasting: boolean): SpellType[] {
    const isHand = castingSource === SpellType.Left || castingSource === SpellType.Right;
    if (!isHand || !this.sp.Spell.from(Game.getFormEx(spellId))) {
      return [];
    }
    const hands = isDualCasting ? [SpellType.Left, SpellType.Right] : [castingSource as SpellType];
    hands.forEach((hand) => {
      if (ac.getEquippedSpell(hand)?.getFormID() !== spellId) {
        syncSpellEquipment(ac, spellId, hand);
      }
    });
    applyWeapDrawn(ac, true);
    return hands;
  }

  private isConcentrationSpell(spellId: number): boolean {
    return isConcentration(this.sp.Spell.from(Game.getFormEx(spellId)));
  }

  private sweepCloneCasts(): void {
    if (!this.cloneCastWatch.size && !this.cloneCastStoppedAt.size) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCloneCastSweep < 250) {
      return;
    }
    this.lastCloneCastSweep = now;
    for (const [key, stoppedAt] of Array.from(this.cloneCastStoppedAt)) {
      if (now - stoppedAt > this.cloneCastStopMemoryMs) {
        this.cloneCastStoppedAt.delete(key);
      }
    }
    for (const [key, watch] of Array.from(this.cloneCastWatch)) {
      const ac = Actor.from(Game.getFormEx(remoteIdToLocalId(watch.casterRemoteId)));
      if (!ac) {
        this.cloneCastWatch.delete(key);
        continue;
      }
      const drawn = ac.isWeaponDrawn();
      watch.wasDrawn = watch.wasDrawn || drawn;
      // Stowed magic cannot keep casting, so a sheathe after the draw ends the clone cast like a timeout
      if (now < watch.expiresAt && (drawn || !watch.wasDrawn)) {
        continue;
      }
      this.cloneCastWatch.delete(key);
      logTrace(this, `Clone cast swept for remote caster`, watch.casterRemoteId.toString(16));
      this.stopCloneCast(ac, watch.casterRemoteId, watch.castingSource, watch.animVars);
    }
  }

  private onUpdateAnimVariablesMessage(event: ConnectionMessage<UpdateAnimVariablesMessage>): void {
    const msg = event.message;

    once('update', () => {
      const ac = Actor.from(Game.getFormEx(remoteIdToLocalId(msg.data.actorRemoteId)));
      if (!ac) {
        return;
      }

      // The snapshot carries locomotion and riding state the engine owns on a seated rider clone
      if (isRiderClone(ac.getFormID())) {
        return;
      }

      const actorAnimationVariables: ActorAnimationVariables = {
        booleans: new Uint8Array(msg.data.actorAnimationVariables.booleans),
        floats: new Uint8Array(msg.data.actorAnimationVariables.floats),
        integers: new Uint8Array(msg.data.actorAnimationVariables.integers)
      };

      const isApplyed = applyAnimationVariablesToActor(ac.getFormID(), actorAnimationVariables);

      if (!isApplyed) {
        logError(this, 'Failed apply AnimationVariables to actor with id: ' + ac.getFormID().toString(16));
        return;
      }

      // A replay that ends without a stop gets the caster's newest snapshot, not its cast-time one
      this.cloneCastWatch.forEach((watch) => {
        if (watch.casterRemoteId === msg.data.actorRemoteId) {
          watch.animVars = actorAnimationVariables;
        }
      });
    });
  }

  private cloneCastWatch = new Map<string, { casterRemoteId: number, expiresAt: number, castingSource: number, animVars: ActorAnimationVariables, wasDrawn: boolean, spellId: number }>();
  private cloneCastStoppedAt = new Map<string, number>();
  private readonly cloneCastTimeoutMs = 8000;
  private readonly cloneReplayTimeoutMs = 600;
  private readonly cloneCastStopMemoryMs = 2000;
  private lastCloneCastSweep = 0;
  private playerSpawnSeq = 0;
  private ownAppearanceHeld = false;
  private heldOwnAppearance: Appearance | undefined = undefined;
  private numSetInventory = 0;
  // The server's last full inventory at packet time, which its patches apply to (pcInv lags a frame); a hot reload starts from pcInv
  private serverInventory = getPcInventory();
  private playerTeleport?: PlayerTeleport;
  private resyncing = false;
  private raceMenuSeen = false;
  private raceMenuPending = false;
  private raceMenuRetries = 0;
  private raceMenuSettledAt = 0;
  private lastLoadAt = 0;
  private raceCheck?: RaceCheck;
  private raceBase?: { raceId: number; spawnSeq: number; health: number; stamina: number };
  private lastTickAt = 0;
  private raceMenuFrames?: FrameStats & { openedAt: number; switches: number };
  private frontLoadedLogged = false;
  private readonly formIdxByRefrId = new Map<number, number>();
  private readonly pluginRefByIdx = new Map<number, number>();
  // Tried on the next update: new records and changed props of loaded refs
  private readonly pluginRefsDue = new Set<number>();
  // Not loaded when last tried, applied by cellAttach, moveAttachDetach or the poll
  private readonly pluginRefsWaiting = new Set<number>();
  // When each waiting ref started waiting, while the poll still tries it
  private readonly pluginRefsPolled = new Map<number, number>();
  private pluginRefsPolling = false;
  private pluginRefPollAt = 0;
  private readonly pluginRefApplies: PluginRefApplies = { atOnce: 0, cellAttach: 0, moveAttachDetach: 0, fallback: 0, lapsed: 0 };
}
