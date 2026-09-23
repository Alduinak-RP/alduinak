// @ts-expect-error (TODO: Remove in 2.10.0)
import { Actor, Form, FormType, Menu, interruptCast, castSpellImmediate, printConsole, applyAnimationVariablesToActor, ActorAnimationVariables } from 'skyrimPlatform';
import {
  Cell,
  Debug,
  EquipEvent,
  Game,
  ObjectReference,
  TESModPlatform,
  Ui,
  Utility,
  WorldSpace,
  on, // TODO: use this.controller.on instead
  once, // TODO: use this.controller.once instead
  storage, // TODO: use this.sp.storage instead
} from 'skyrimPlatform';

import * as messages from '../../messages';

/* eslint-disable @typescript-eslint/no-empty-function */
import { ObjectReferenceEx } from '../../extensions/objectReferenceEx';
import { IdManager } from '../../lib/idManager';
import { nameof } from '../../lib/nameof';
import { setActorValuePercentage } from '../../sync/actorvalues';
import { applyAppearanceToPlayer } from '../../sync/appearance';
import { applyEquipment, isBadMenuShown, syncSpellEquipment, SpellType } from '../../sync/equipment';
import { Inventory, applyInventory, getDiff, getInventory, isBoundItem, removeSimpleItemsAsManyAsPossible } from '../../sync/inventory';
import { Movement } from '../../sync/movement';
import { applyWeapDrawn } from '../../sync/movementApply';
import { dropUnlistedBaseSpells, learnSpells, removeAllSpells, SpellListNatives, syncRaceAbilities } from '../../sync/spell';
import { ModelApplyUtils } from '../../view/modelApplyUtils';
import { FormModel, WorldModel } from '../../view/model';
import { LoadGameService } from './loadGameService';
import { UpdateMovementMessage } from '../messages/updateMovementMessage';
import { ChangeValuesMessage } from '../messages/changeValuesMessage';
import { UpdateAnimationMessage } from '../messages/updateAnimationMessage';
import { UpdateEquipmentMessage } from '../messages/updateEquipmentMessage';
import { RagdollService } from './ragdollService';
import { RestraintService } from './restraintService';
import { MountService } from './mountService';
import { CloneSpellGuardService } from './cloneSpellGuardService';
import { LastInvService } from './lastInvService';
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
} from '../../view/worldViewMisc';
import { TimeService } from './timeService';
import { logTrace, logError, logToPlatformLog } from '../../logging';
import { countWorn, equipEntries, Equipment, getPlayerWorn, getUnwornSaved, resyncHandGraph } from '../../sync/equipment';
import { isRiderClone } from '../../sync/mountApply';

import { SpellCastMessage } from '../messages/spellCastMessage';
import { UpdateAnimVariablesMessage } from '../messages/updateAnimVariablesMessage';
import { MsgType } from '../../messages';
import { CustomPacketMessage } from '../messages/customPacketMessage';
import { parseCustomPacket } from './customPacketUtil';

export const getPcInventory = (): Inventory | undefined => {
  const res = storage['pcInv'];
  if (typeof res === 'object' && (res as any)['entries']) {
    return res as Inventory;
  }
  return undefined;
};

const setPcInventory = (inv: Inventory): void => {
  storage['pcInv'] = inv;
};

const CONSUME_APPLY_HOLD_MS = 10000;

let pcInvLastApply = 0;
let pcInvHoldUntil = 0;
let encumbranceRefreshPending = false;

// Holds the periodic re-apply while the server has not seen a local change yet
export const holdPcInventoryApply = (ms: number): void => {
  pcInvHoldUntil = Math.max(pcInvHoldUntil, Date.now() + ms);
};

export const requestPcInventoryApply = (): void => {
  pcInvLastApply = 0;
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

const SPAWN_EQUIPMENT_SETTLE_MS = 2500;
let spawnEquipment: Equipment | undefined;
let spawnEquipmentSettleUntil = 0;
let spawnEquipmentRedressed = false;
let spawnEquipmentMenuUsed = false;

const applySpawnEquipment = (player: Actor, eq: Equipment): void => {
  spawnEquipment = eq;
  spawnEquipmentSettleUntil = Date.now() + SPAWN_EQUIPMENT_SETTLE_MS;
  spawnEquipmentRedressed = false;
  spawnEquipmentMenuUsed = false;
  applyEquipment(player, eq);
};

// Reports taken while the spawn apply strips and re-dresses the player read naked
export const settleSpawnEquipment = (player: Actor): boolean => {
  if (!spawnEquipment) {
    return false;
  }
  // In these menus the player picks their own outfit
  if (isBadMenuShown()) {
    spawnEquipmentMenuUsed = true;
    return true;
  }
  // The race menu undresses the player on purpose until it closes
  if (Date.now() < spawnEquipmentSettleUntil || Ui.isMenuOpen('RaceSex Menu')) {
    return true;
  }
  const unworn = getUnwornSaved(player, spawnEquipment);
  const redress = !spawnEquipmentRedressed && !spawnEquipmentMenuUsed && unworn.length > 0;
  logToPlatformLog("RemoteServer", `spawn outfit settled: ${unworn.length} of ${getPlayerWorn(spawnEquipment).length} saved not worn, worn ${countWorn(getInventory(player))}, menu used ${spawnEquipmentMenuUsed},`, redress ? "re-dressing" : "done");
  if (!redress) {
    spawnEquipment = undefined;
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

on('update', () => {
  if (isBadMenuShown()) {
    return;
  }
  const player = Game.getPlayer()!;
  if (encumbranceRefreshPending) {
    encumbranceRefreshPending = false;
    // Any CarryWeight change makes the engine re-check encumbrance
    player.modActorValue("CarryWeight", 1);
    player.modActorValue("CarryWeight", -1);
  }
  // Snapshots sent before the server saw a quick run of consumes would re-add them
  if (Date.now() < pcInvHoldUntil) {
    return;
  }
  if (Date.now() - pcInvLastApply > 5000) {
    pcInvLastApply = Date.now();
    const pcInv = getPcInventory();
    if (pcInv) {
      // applyInventory keeps summoned bound items, so their pending removal is not a change
      encumbranceRefreshPending = getDiff(pcInv, getInventory(player), true, "apply").entries.some((e) => {
        const f = e.count < 0 ? Game.getFormEx(e.baseId) : null;
        return !f || !isBoundItem(f);
      });
      applyInventory(player, pcInv, false, true);
      requestWornEnchantmentReapply();
    }
  }
});

// The spawn save dresses the player in the Player record's default outfit
const unequipDefaultOutfit = () => {
  Game.getPlayer()?.unequipAll();
};

export class RemoteServer extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("hostStartMessage", (e) => this.onHostStartMessage(e));
    this.controller.emitter.on("hostStopMessage", (e) => this.onHostStopMessage(e));
    this.controller.emitter.on("setInventoryMessage", (e) => this.onSetInventoryMessage(e));
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

    this.controller.on("update", () => this.sweepCloneCasts());
    // Diagnostic: whether the diagnosed clone's graph took the replayed cast event
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        if (this.cloneCastReport && ctx.selfId === this.cloneCastReport.cloneId) {
          this.cloneCastReport.text += ` ${ctx.animEventName}=${ctx.animationSucceeded}`;
        }
      },
    }, 0xff000000, 0xffffffff, "BeginCast*");
    // Diagnostic: more spellCast events than the replay itself raises means BeginCast made the clone cast again
    this.controller.on("spellCast", (e) => {
      if (this.cloneCastReport && e.caster?.getFormID() === this.cloneCastReport.cloneId) {
        this.cloneCastReport.spellCasts++;
      }
    });
    this.controller.on("equip", (e) => this.onPlayerConsume(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onPotionRefused(e));
    // The engine loses worn enchantment abilities on scripted equips, inventory changes and stray dispels
    this.controller.on("equip", (e) => this.onPlayerWornChange(e.actor));
    this.controller.on("containerChanged", (e) => this.onPlayerWornChange(e.oldContainer, e.newContainer));
    this.controller.on("effectFinish", (e) => this.onPlayerWornChange(e.target));
    this.controller.on("update", () => this.reapplyWornEnchantments());
  }

  private onPlayerWornChange(...refs: (ObjectReference | null | undefined)[]): void {
    if (refs.some((ref) => ref?.getFormID() === 0x14)) {
      requestWornEnchantmentReapply();
    }
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
  }

  private onSetInventoryMessage(event: ConnectionMessage<SetInventoryMessage>): void {
    this.numSetInventory++;

    const msg = event.message;
    once('update', () => {
      setPcInventory(msg.inventory);

      let blocked = false;

      this.controller.emitter.emit('queryBlockSetInventoryEvent', {
        block: () => blocked = true
      });

      if (!blocked) {
        pcInvLastApply = 0;
      }
    });
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

  // The server refunds a potion or food within 10 s of the last one of its kind and blocks its effects
  private onPotionRefused(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "potionRefused") {
      return;
    }
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
      Debug.notification(isFood ? "You must wait before having more food or drink." : "You must wait before drinking another potion.");
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

      refr.activate(Game.getPlayer(), true);

      const baseObject = refr.getBaseObject();
      const baseType = baseObject?.getType();

      let functionChecker: (() => boolean) | null = null;
      let factName = "";
      let delaySeconds = -1.0;
      if (baseType === FormType.Container) {
        functionChecker = () => Ui.isMenuOpen("ContainerMenu");
        factName = "'ContainerMenu open'";
        delaySeconds = 0.0;
      } else if (baseType === FormType.Furniture) {
        functionChecker = () => !!Game.getPlayer()?.getFurnitureReference();
        factName = "'getFurnitureReference not null'";
        delaySeconds = 1.0;
      }

      if (functionChecker === null) {
        logTrace(this, "onOpenContainerMesage - not a container or furniture", baseType);
        return;
      }

      // SkyMP containers have a 2nd, closing activation under the hood, unlike Skyrim's single activation.

      (async () => {
        logTrace(this, "onOpenContainerMesage - waiting for", factName, "to be true");
        while (!functionChecker()) await Utility.wait(0.1);

        logTrace(this, "onOpenContainerMesage - waiting for", factName, "to be false");
        while (functionChecker()) await Utility.wait(0.1);

        logTrace(this, "onOpenContainerMesage - menu closed", factName);
        if (baseType === FormType.Container) {
          // The closing frame's containerChanged events drain after this continuation, so check one tick later
          await Utility.wait(0.1);
          this.traceContainerResidual();
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

          logTrace(this, "onOpenContainerMesage - sent ActivateMessage", message);
        });
      })();
    });
  }

  // A move that never reached ContainersService leaves lastInv out of step with the real inventory
  private traceContainerResidual(): void {
    const lastInv = this.controller.lookupListener(LastInvService).lastInv;
    const player = Game.getPlayer();
    if (!lastInv || !player) return;
    const residual = getDiff(lastInv, getInventory(player), false).entries;
    if (residual.length > 0) logTrace(this, "container residual", JSON.stringify(residual));
  }

  private onTeleportMessage(event: ConnectionMessage<TeleportMessage> | ConnectionMessage<TeleportMessage2>): void {
    const msg = event.message;
    once('update', () => {
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
          refr.setAngle(msg.rot[0], msg.rot[1], msg.rot[2]);
          refr.translateTo(
            msg.pos[0], msg.pos[1], msg.pos[2],
            msg.rot[0], msg.rot[1], msg.rot[2],
            Math.max(dist / 0.35, 100), 0,
          );
          return;
        }
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
        if (refrId === 0x14) this.controller.lookupListener(RestraintService).onTeleported();
      };
      const actor = Actor.from(refr);
      if (actor /*&& actor.getFormID() === 0x14*/) {
        ragdollService.safeRemoveRagdollFromWorld(actor, removeRagdollCallback);
      } else {
        removeRagdollCallback();
      }
    });
  }

  private onCreateActorMessage(event: ConnectionMessage<CreateActorMessage>): void {
    const msg = event.message;
    if (this.skipFormViewCreation(msg)) {
      const refrId = msg.refrId!;
      this.onceLoad(refrId, (refr: ObjectReference) => {
        if (refr) {
          ObjectReferenceEx.dealWithRef(refr, refr.getBaseObject() as Form);
          if (msg.props) {
            if (msg.props.inventory) {
              ModelApplyUtils.applyModelInventory(refr, msg.props.inventory);
            }
            ModelApplyUtils.applyModelIsOpen(refr, !!msg.props['isOpen']);
            ModelApplyUtils.applyModelIsHarvested(
              refr,
              !!msg.props['isHarvested'],
            );

            ModelApplyUtils.applyModelNodeScale(refr, msg.props.setNodeScale);

            ModelApplyUtils.applyModelNodeTextureSet(refr, msg.props.setNodeTextureSet);

            ModelApplyUtils.applyModelIsDisabled(refr, !!(msg.props.isDisabled || msg.props['disabled']));

            // TODO: move to a separate module
            const animation = msg.props.lastAnimation;
            if (typeof animation === "string") {
              const refrid = refr.getFormID();

              (async () => {
                for (let i = 0; i < 5; i++) {
                  // retry. pillars in bleakfalls are not reliable for some reason
                  let res2 = ObjectReference.from(Game.getFormEx(refrid))?.playAnimation(animation);
                  if (res2) {
                    break;
                  }
                  await Utility.wait(2);
                }
              })();
            }


            let displayName = msg.props.displayName;

            // keep in sync with spSnippetService.ts
            if (typeof displayName === "string") {

              const replaceValue = refr.getBaseObject()?.getName();

              if (replaceValue !== undefined) {
                displayName = displayName.replace(/%original_name%/g, replaceValue);
              } else {
                logError(this, "Couldn't get a replaceValue for SetDisplayName, refr.getFormID() was", refr.getFormID().toString(16));
              }

              refr.setDisplayName(displayName, true);
              logTrace(this, `calling setDisplayName`, displayName, `for`, refr.getFormID().toString(16));
            }
          }
        } else {
          logError(this, 'Failed to apply model to', refrId.toString(16));
        }
      });
      return;
    }

    logTrace(this, "Create actor");

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

    msg.customPropsJsonDumps.forEach(element => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(element.propValueJsonDump);
      } catch (e) {
        if (e instanceof SyntaxError) {
          logError(this, "createActor", msg.refrId?.toString(16), "failed to parse custom prop", element.propName, element.propValueJsonDump, e.message);
        } else {
          throw e;
        }
      }
      (form as Record<string, unknown>)[element.propName] = parsed;
    });

    if (msg.isMe) {
      this.worldModel.playerCharacterFormIdx = i;
      this.worldModel.playerCharacterRefrId = msg.refrId || 0;
    }

    // A failed load leaves our 'update' callbacks queued; a newer spawn of ours drops them
    const spawnSeq = msg.isMe ? ++this.playerSpawnSeq : this.playerSpawnSeq;

    // TODO: move to a separate module

    if (msg.props && !msg.props.isHostedByOther) {
    }

    if (msg.props && msg.props.isRaceMenuOpen && msg.isMe) {
      this.onSetRaceMenuOpenMessage({ message: { t: MsgType.SetRaceMenuOpen, open: true } });
    }

    const numSetInventory = this.numSetInventory;

    const applyPcInv = () => {
      const skipInventory = numSetInventory !== this.numSetInventory;
      if (msg.equipment) {
        applySpawnEquipment(Game.getPlayer()!, msg.equipment);
        logToPlatformLog(this, `spawn outfit applied: worn ${getPlayerWorn(msg.equipment).length} of ${msg.equipment.inv.entries.length} saved (numChanges ${msg.equipment.numChanges}), inventory apply skipped:`, skipInventory);
      }

      if (skipInventory) {
        logTrace(this, 'Skipping inventory apply due to newer setInventory message');
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
      const learnedSpells = msg.props.learnedSpells;

      once('update', () => {
        if (spawnSeq !== this.playerSpawnSeq) return;
        Utility.wait(1).then(() => {
          const player = Game.getPlayer();

          if (player) {
            dropUnlistedBaseSpells(this.sp as unknown as SpellListNatives, player, learnedSpells);
            removeAllSpells(player);
            learnSpells(player, learnedSpells);
            syncRaceAbilities(player, learnedSpells);
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
            isDead: true
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
                      this.controller.lookupListener(CloneSpellGuardService).onServerHealth(value);
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
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);
    this.worldModel.forms[i] = undefined;
    getViewFromStorage()?.syncFormArray(this.worldModel);

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

    this.getIdManager().freeIdFor(msg.idx);
  }

  private onUpdateMovementMessage(event: ConnectionMessage<UpdateMovementMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateMovementMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.movement = msg.data;
    if (!form.numMovementChanges) {
      form.numMovementChanges = 0;
    }
    form.numMovementChanges++;
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

    const newAppearance = msg.data;

    if (i === this.getMyActorIndex() && newAppearance) {
      this.controller.once("update", () => {
        applyAppearanceToPlayer(newAppearance);
        const player = Game.getPlayer();
        if (player) {
          syncRaceAbilities(player, []);
        }
        logTrace(this, "Applied appearance to the player");
      });
    }
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

  private onUpdatePropertyMessage(event: ConnectionMessage<UpdatePropertyMessage>): void {
    const msg = event.message;
    const msgData = this.extractUpdatePropertyMessageData(msg);

    if (this.skipFormViewCreation(msg)) {
      const refrId = msg.refrId;
      once('update', () => {
        const refr = ObjectReference.from(Game.getFormEx(refrId));
        if (!refr) {
          logError(this, 'UpdateProperty: refr not found');
          return;
        }
        if (msg.propName === 'inventory') {
          ModelApplyUtils.applyModelInventory(refr, msgData as Inventory);
        } else if (msg.propName === 'isOpen') {
          ModelApplyUtils.applyModelIsOpen(refr, !!msgData);
        } else if (msg.propName === 'isHarvested') {
          ModelApplyUtils.applyModelIsHarvested(refr, !!msgData);
        } else if (msg.propName === 'disabled') {
          ModelApplyUtils.applyModelIsDisabled(refr, !!msgData);
        }
      });
      return;
    }
    const i = this.getIdManager().getId(msg.idx);
    const form = this.worldModel.forms[i];
    (form as Record<string, unknown>)[msg.propName] = msgData;

    // Sent after the race menu, whose race switch brings the new race's spells
    if (msg.propName === 'learnedSpells' && i === this.worldModel.playerCharacterFormIdx && Array.isArray(msgData)) {
      once('update', () => {
        const player = Game.getPlayer();
        if (player) {
          dropUnlistedBaseSpells(this.sp as unknown as SpellListNatives, player, msgData as number[]);
          syncRaceAbilities(player, msgData as number[]);
        }
      });
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
            isDead: msgData
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
    this.worldModel.playerCharacterFormIdx = -1;
    this.worldModel.playerCharacterRefrId = 0;

    logTrace(this, "Handle connection accepted");
  }

  private onChangeValuesMessage(event: ConnectionMessage<ChangeValuesMessage>): void {
    const msg = event.message;

    once('update', () => {
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
          this.controller.lookupListener(CloneSpellGuardService).onServerHealth(health);
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
      // wait 0.3s to avoid visual bugs when teleporting and showing this menu at the same time in onConnect
      once('update', () => {
        if (spawnSeq !== this.playerSpawnSeq) return;
        Utility.wait(0.3).then(() => {
          unequipDefaultOutfit();
          Game.showRaceMenu();
        });
      });
    } else {
      // TODO: Implement closeMenu in SkyrimPlatform
    }
  }

  /** Packet handlers end **/

  getWorldModel(): WorldModel {
    return this.worldModel;
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

  private onceLoad(
    refrId: number,
    callback: (refr: ObjectReference) => void,
    maxAttempts: number = 120,
  ) {
    once('update', () => {
      const refr = ObjectReference.from(Game.getFormEx(refrId));
      if (refr) {
        callback(refr);
      } else {
        maxAttempts--;
        if (maxAttempts > 0) {
          once('update', () => this.onceLoad(refrId, callback, maxAttempts));
        } else {
          logError(this, 'Failed to load object reference ' + refrId.toString(16));
        }
      }
    });
  };

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

    once('update', () => {
      const ac = Actor.from(Game.getFormEx(remoteIdToLocalId(msg.data.caster)));
      if (!ac) {
        // A throw from this callback reaches skyrim-platform.log, printConsole does not
        if (!msg.data.interruptCast && !msg.data.keepAlive) {
          throw new Error(`spell ${msg.data.spell.toString(16)} of ${msg.data.caster.toString(16)} not replayed, caster not loaded`);
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
      const cloneSpellGuard = this.controller.lookupListener(CloneSpellGuardService);

      // Keep-alives and recasts of a running channel at any target only refresh the clone, recasting would stack concentration casts
      const watch = this.cloneCastWatch.get(key);
      const sameChannel = watch !== undefined && spellId !== undefined && watch.spellId === spellId
        && this.isConcentrationSpell(spellId);
      if (watch && (msg.data.keepAlive || sameChannel)) {
        watch.expiresAt = now + this.cloneCastTimeoutMs;
        if (spellId) {
          cloneSpellGuard.guardHostileReplay(ac.getFormID(), spellId, this.cloneCastTimeoutMs);
        }
        return;
      }
      // A keep-alive overtaking its own stop must not restart the clone
      if (msg.data.keepAlive && now - (this.cloneCastStoppedAt.get(key) ?? 0) < this.cloneCastStopMemoryMs) {
        return;
      }
      this.cloneCastStoppedAt.delete(key);

      // Casters refresh channeled casts every ~3s; a clone whose refresh and
      // stop both got lost is interrupted by sweepCloneCasts
      this.cloneCastWatch.set(key, {
        casterRemoteId: msg.data.caster,
        expiresAt: now + this.cloneCastTimeoutMs,
        castingSource: msg.data.castingSource,
        animVars: actorAnimationVariables,
        wasDrawn: ac.isWeaponDrawn(),
        spellId: spellId ?? 0,
      });

      if (spellId) {
        const hands = this.readyCloneHands(ac, spellId, msg.data.castingSource, msg.data.isDualCasting);
        // The platform only casts Fire Storm or Blizzard on the clone when told the observer is guarded
        const replayedHostileSelf = castSpellImmediate(ac.getFormID(), msg.data.castingSource, spellId, remoteIdToLocalId(msg.data.target),
          msg.data.aimAngle, msg.data.aimHeading, actorAnimationVariables, true) === true;
        if (replayedHostileSelf) {
          cloneSpellGuard.guardClone(ac.getFormID(), spellId);
        } else {
          cloneSpellGuard.guardHostileReplay(ac.getFormID(), spellId, this.cloneCastTimeoutMs);
        }
        // castSpellImmediate plays no cast animation, the vanilla graph starts one on BeginCastLeft or BeginCastRight
        hands.forEach((hand) => Debug.sendAnimationEvent(ac, hand === SpellType.Left ? "BeginCastLeft" : "BeginCastRight"));
        this.startCloneCastReport(ac, spellId, msg.data.target, hands);
      }
    });
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
    return this.sp.Spell.from(Game.getFormEx(spellId))?.getNthEffectMagicEffect(0)?.getCastingType() === this.concentrationCasting;
  }

  // At most one report per 10 s, sweepCloneCasts sends it once the clone had time to react
  private startCloneCastReport(ac: Actor, spellId: number, target: number, hands: SpellType[]): void {
    const now = Date.now();
    if (now - this.lastCloneCastReportAt < 10000) {
      return;
    }
    this.lastCloneCastReportAt = now;
    this.cloneCastReport = {
      cloneId: ac.getFormID(),
      at: now,
      spellCasts: 0,
      text: `clone cast diagnostic: spell ${spellId.toString(16)} on ${ac.getFormID().toString(16)} hands [${hands}]`
        + ` target is clone ${remoteIdToLocalId(target) === ac.getFormID()}`,
    };
  }

  private sweepCloneCasts(): void {
    const now = Date.now();
    if (now - this.lastCloneCastSweep < 250) {
      return;
    }
    this.lastCloneCastSweep = now;
    const report = this.cloneCastReport;
    if (report && now - report.at > 1000) {
      this.cloneCastReport = undefined;
      const clone = Actor.from(Game.getFormEx(report.cloneId));
      const state = clone
        ? ` held ${clone.getEquippedSpell(SpellType.Left)?.getFormID().toString(16)}/${clone.getEquippedSpell(SpellType.Right)?.getFormID().toString(16)}`
          + ` drawn ${clone.isWeaponDrawn()} IsCastingLeft ${clone.getAnimationVariableBool("IsCastingLeft")}`
          + ` IsCastingRight ${clone.getAnimationVariableBool("IsCastingRight")}`
        : " clone gone";
      // A throw from its own update reaches skyrim-platform.log, printConsole does not
      this.controller.once("update", () => { throw new Error(`${report.text}${state} spellCasts ${report.spellCasts}`); });
    }
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
      }
    });
  }

  private cloneCastWatch = new Map<string, { casterRemoteId: number, expiresAt: number, castingSource: number, animVars: ActorAnimationVariables, wasDrawn: boolean, spellId: number }>();
  private cloneCastStoppedAt = new Map<string, number>();
  private readonly cloneCastTimeoutMs = 8000;
  private readonly cloneCastStopMemoryMs = 2000;
  private readonly concentrationCasting = 2;
  private lastCloneCastSweep = 0;
  private cloneCastReport: { cloneId: number, at: number, text: string, spellCasts: number } | undefined = undefined;
  private lastCloneCastReportAt = 0;
  private playerSpawnSeq = 0;
  private numSetInventory = 0;
}
