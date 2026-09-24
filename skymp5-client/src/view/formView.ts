import { Actor, ActorBase, createText, destroyText, Form, FormType, Game, Keyword, NetImmerse, ObjectReference, once, printConsole, setTextPos, setTextSize, setTextString, storage, TESModPlatform, Utility, worldPointToScreenPoint } from "skyrimPlatform";
import { setDefaultAnimsDisabled, applyAnimation, restoreSitCollisionIfMoving } from "../sync/animation";
import { Appearance, applyAppearance } from "../sync/appearance";
import { isBadMenuShown, applyEquipment, resyncHandGraph, wearsExactly } from "../sync/equipment";
import { logToPlatformLog } from "../logging";
import { RespawnNeededError } from "../lib/errors";
import { FormModel } from "./model";
import { applyMovement } from "../sync/movementApply";
import { applyMount, isCloneMovementSuspended, isMountSuspended, makeMountState, releaseRiderClone, dismountRiderOf } from "../sync/mountApply";
import { Movement } from "../sync/movement";
import { SpawnProcess } from "./spawnProcess";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { PlayerCharacterDataHolder } from "./playerCharacterDataHolder";
import { lastTryHost, tryHost } from "./hostAttempts";
import { ModelApplyUtils } from "./modelApplyUtils";
import { isModelHostedByOther, knowsCharacter, localIdToRemoteId } from "./worldViewMisc";
import { SpApiInteractor } from "../services/spApiInteractor";
import { WorldCleanerService } from "../services/services/worldCleanerService";
import { GamemodeUpdateService } from "../services/services/gamemodeUpdateService";
import { isOwnCompanion, keepsOwnOffset } from "../services/services/companionService";
import { adminGhostAlpha, setAdminGhostShader } from "./adminGhostLook";

export interface ScreenResolution {
  width: number;
  height: number;
}

type AdminView = "visible" | "hidden" | "ghost";

let _screenResolution: ScreenResolution | undefined;
export const getScreenResolution = (): ScreenResolution => {
  if (!_screenResolution) {
    _screenResolution = {
      width: Utility.getINIInt("iSize W:Display"),
      height: Utility.getINIInt("iSize H:Display"),
    }
  }
  return _screenResolution;
}

export class FormView {
  constructor(private remoteRefrId?: number) { }

  update(model: FormModel): void {
    // Other players mutate into PC clones when moving to another location
    if (model.movement) {
      if (!this.lastWorldOrCell)
        this.lastWorldOrCell = model.movement.worldOrCell;
      if (this.lastWorldOrCell !== model.movement.worldOrCell) {
        printConsole(
          `[1] worldOrCell changed, destroying FormView ${this.lastWorldOrCell.toString(
            16
          )} => ${model.movement.worldOrCell.toString(16)}`
        );
        this.lastWorldOrCell = model.movement.worldOrCell;
        this.destroy();
        this.refrId = 0;
        this.appearanceBasedBaseId = 0;
        return;
      }
    }



    // Dead players stay hidden until they respawn; NPC corpses spawn and are killed on the first apply
    if (model.isDead && this.refrId === 0 && model.appearance) {
      return;
    }

    // Players with different worldOrCell should be invisible
    if (model.movement) {
      const worldOrCell = ObjectReferenceEx.getWorldOrCell(Game.getPlayer() as Actor);
      if (
        worldOrCell !== 0 &&
        model.movement.worldOrCell !== worldOrCell
      ) {
        this.destroy();
        this.refrId = 0;
        return;
      }
    }

    // Apply appearance before base form selection to prevent double-spawn
    if (model.appearance || (!model.appearance && this.appearanceState.appearance)) {
      if (
        !this.appearanceState.appearance ||
        model.numAppearanceChanges !== this.appearanceState.lastNumChanges
      ) {

        // Both non-null
        if (model.appearance && this.appearanceState.appearance) {
          const modelAppearanceCopy: Appearance = JSON.parse(JSON.stringify(model.appearance));
          const stateAppearanceCopy: Appearance = JSON.parse(JSON.stringify(this.appearanceState.appearance));
          modelAppearanceCopy.name = "";
          stateAppearanceCopy.name = "";
          const equalWithoutNames = JSON.stringify(modelAppearanceCopy) === JSON.stringify(stateAppearanceCopy);

          if (equalWithoutNames) {
            // Change name inplace
            const refr = ObjectReference.from(Game.getFormEx(this.refrId));
            refr?.getBaseObject()?.setName(model.appearance.name);
            refr?.setDisplayName(model.appearance.name, true);
            // Recreate the floating tag so watchers see the new name (/mask)
            this.removeNickname();
            //printConsole("Appearance updated, changing name inplace");
          } else {
            // Force re-apply appearance on the next getAppearanceBasedBase call
            this.appearanceBasedBaseId = 0;
            //printConsole("Appearance updated");
          }
        } else {
          // Force re-apply appearance on the next getAppearanceBasedBase call
          this.appearanceBasedBaseId = 0;
          //printConsole("Appearance updated");
        }

        this.appearanceState.appearance = model.appearance || null;
        this.appearanceState.lastNumChanges = model.numAppearanceChanges as number;
      }
    }

    const refId =
      model.refrId && model.refrId < 0xff000000 ? model.refrId : undefined;
    if (refId) {
      if (this.refrId !== refId) {
        this.destroy();
        this.refrId = model.refrId as number;
        this.ready = true;
        // dealWithRef waits in applyAll until the ref exists (spawn, teleport: cells attach after the server streams them)
        this.dealtWithRef = false;
      }
    } else {
      let templateChain = model.templateChain;

      // There is no place for random/leveling in 1-sized chain
      // Just spawn an NPC, do not generate a temporary TESNPC form
      if (templateChain?.length === 1) {
        templateChain = undefined;
      }

      // TODO: getLeveledBase crashes too often ATM
      let base = null; //Game.getFormEx(this.getLeveledBase(templateChain));
      if (base === null) {
        base = Game.getFormEx(model.baseId || NaN);
      }
      if (base === null) {
        base = Game.getFormEx(this.getAppearanceBasedBase());
      }
      if (base === null) {
        return;
      }

      let refr = ObjectReference.from(Game.getFormEx(this.refrId));

      let respawnRequired = false;
      if (!refr) {
        respawnRequired = true;
      } else if (!refr.getBaseObject()) {
        respawnRequired = true;
      } else if ((refr.getBaseObject() as Form).getFormID() !== base.getFormID()) {
        respawnRequired = true;
      }

      if (respawnRequired) {
        this.destroy();

        const player = Game.getPlayer() as Actor;

        const spawnMethodOriginal = {
          spawn(baseForm: Form, _spawnPosition: [number, number, number], _spawnRotation: [number, number, number]): ObjectReference {
            return player.placeAtMe(
              baseForm,
              1,
              true,
              true
            ) as ObjectReference;
          },

          triggerSpawnProcess(spawningRefr: ObjectReference, spawnPosition: [number, number, number], appearance: Appearance | null, callback: () => void) {
            new SpawnProcess(
              appearance,
              spawnPosition,
              spawningRefr.getFormID(),
              callback
            );
          }
        };

        const spawnMethodStub = {
          spawn(baseForm: Form, spawnPosition: [number, number, number], spawnRotation: [number, number, number]): ObjectReference {
            const f = storage["formViewFunc1"] as Function;
            const ref: ObjectReference = f(baseForm, spawnPosition, spawnRotation);
            return ref;
          },

          triggerSpawnProcess(spawningRefr: ObjectReference, spawnPosition: [number, number, number], appearance: Appearance | null, callback: () => void) {
            const f = storage["formViewFunc2"] as Function;
            f(spawningRefr, spawnPosition, appearance, callback);
          }
        };

        const spawnUsingStubMethod = base.getType() === FormType.NPC
          && !this.appearanceState.appearance
          && storage["formViewFunc1Set"] === true
          && storage["formViewFunc2Set"] === true;
        const spawnMethod = spawnUsingStubMethod ? spawnMethodStub : spawnMethodOriginal;

        if (model.movement) {
          refr = spawnMethod.spawn(base, model.movement.pos, model.movement.rot);
        } else {
          printConsole("model.movement was " + model.movement);
        }

        this.state = {};
        delete this.wasHostedByOther;
        if (base.getType() !== FormType.NPC) {
          refr?.setAngle(
            model.movement?.rot[0] || 0,
            model.movement?.rot[1] || 0,
            model.movement?.rot[2] || 0
          );
        } else {
          const actor = Actor.from(refr);
          if (actor) {
            this.applyHostility(actor, model);
          }
        }

        if (refr !== null) {
          SpApiInteractor.getControllerInstance().lookupListener(WorldCleanerService).modWcProtection(refr.getFormID(), 1);
        }

        // TODO: reset all states?
        this.eqState = this.getDefaultEquipState();
        this.animState = this.getDefaultAnimState();

        this.ready = false;

        let spawnPos;
        if (model.movement) {
          spawnPos = model.movement.pos;
          // printConsole("Spawn NPC at movement.pos");
        } else {
          spawnPos = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
          printConsole("Spawn NPC at player pos");
        }

        if (refr) {
          spawnMethod.triggerSpawnProcess(refr, spawnPos, model.appearance || null, () => {
            this.ready = true;
            this.spawnMoment = Date.now();
          });
        } else {
          printConsole("Unable to triggerSpawnProcess for null refr");
        }

        if (model.appearance && model.appearance.name) {
          refr?.setDisplayName("" + model.appearance.name, true);
        }
        Actor.from(refr)?.setActorValue("attackDamageMult", 0);
      }
      this.refrId = (refr as ObjectReference).getFormID();
    }

    if (!this.ready) {
      return;
    }

    const refr = ObjectReference.from(Game.getFormEx(this.refrId));
    if (refr) {
      const actor = Actor.from(refr);
      if (actor && !this.localImmortal) {
        actor.startDeferredKill();
        actor.setActorValue("health", 1000000);
        actor.setActorValue("magicka", 1000000);
        this.localImmortal = true;
      }
      if (actor && !refId) {
        this.applyHostility(actor, model);
      }
      this.applyAll(refr, model);

      const gamemodeUpdateService = SpApiInteractor.getControllerInstance().lookupListener(GamemodeUpdateService);
      gamemodeUpdateService.updateNeighbor(refr, model, this.state);
    }
  }

  destroy(): void {
    this.isOnScreen = false;
    this.lastNiNodeUpdateMs = 0;
    this.spawnMoment = 0;
    this.loaded3DMoment = 0;
    this.dealtWithRef = false;
    const refrId = this.refrId;
    this.mountState = makeMountState();
    once("update", () => {
      if (refrId >= 0xff000000) {
        const refr = ObjectReference.from(Game.getFormEx(refrId));
        if (refr) {
          // A horse leaving throws its rider first; a rider leaving lets go of its saddle
          dismountRiderOf(refrId);
          releaseRiderClone(refrId);
          refr.delete();
        }
        SpApiInteractor.getControllerInstance().lookupListener(WorldCleanerService).modWcProtection(refrId, -1);
        const ac = Actor.from(refr);
        if (ac) {
          TESModPlatform.setWeaponDrawnMode(ac, -1);
        }
      }
    })

    this.localImmortal = false;
    this.hostilityApplied = false;
    this.aggressionBeforeRaise = undefined;
    this.adminView = "visible";
    this.adminShaderOn = false;
    this.adminShaderReplayAt = 0;
    this.adminGhostFlag = false;
    this.removeNickname();
  }

  private lastHarvestedApply = 0;
  private lastOpenApply = 0;
  private dealtWithRef = false;
  private isSetNodeTextureSetApplied = false;
  private isSetNodeScaleApplied = false;

  private applyAll(refr: ObjectReference, model: FormModel) {
    let forcedWeapDrawn: boolean | null = null;

    if (PlayerCharacterDataHolder.getCrosshairRefId() === this.refrId) {
      this.lastHarvestedApply = 0;
      this.lastOpenApply = 0;
    }
    const now = Date.now();
    if (now - this.lastHarvestedApply > 666) {
      this.lastHarvestedApply = now;
      ModelApplyUtils.applyModelIsHarvested(refr, !!model.isHarvested);
    }
    if (!this.dealtWithRef) {
      const base = refr.getBaseObject();
      if (base) {
        ObjectReferenceEx.dealWithRef(refr, base);
        this.dealtWithRef = true;
      }
    }
    if (now - this.lastOpenApply > 133) {
      this.lastOpenApply = now;
      // A door set before its 3D is in can stick between open and closed, so the server's state waits for the model
      if (refr.is3DLoaded()) {
        ModelApplyUtils.applyModelIsOpen(refr, !!model.isOpen);
      }
      // A reloaded cell recreates the ref without its activation block, so doors would open locally again
      if (!refr.isActivationBlocked()) {
        const base = refr.getBaseObject();
        if (base && ObjectReferenceEx.wantsActivationBlock(base)) {
          refr.blockActivation(true);
        }
      }
    }
    if (!this.isSetNodeScaleApplied) {
      this.isSetNodeScaleApplied = true;
      ModelApplyUtils.applyModelNodeScale(refr, model.setNodeScale);
    }
    if (!this.isSetNodeTextureSetApplied) {
      this.isSetNodeTextureSetApplied = true;
      ModelApplyUtils.applyModelNodeTextureSet(refr, model.setNodeTextureSet);
    }

    if (
      model.inventory &&
      PlayerCharacterDataHolder.getCrosshairRefId() == this.refrId &&
      !isBadMenuShown()
    ) {
      // Do not let actors breaking their equipment via inventory apply
      // However, actually, actors do not have inventory in their models
      // Except your clone.
      if (!Actor.from(refr)) {
        ModelApplyUtils.applyModelInventory(refr, model.inventory);
        model.inventory = undefined;
      }
    }

    if (model.animation) {
      if (model.animation.animEventName === "SkympFakeUnequip") {
        forcedWeapDrawn = false;
      } else if (model.animation.animEventName === "SkympFakeEquip") {
        forcedWeapDrawn = true;
      }
    }

    // TODO: make host service
    const hosted = storage['hosted'];
    let alreadyHosted = false;
    if (Array.isArray(hosted)) {
      const remoteId = localIdToRemoteId(this.refrId);

      if (hosted.includes(remoteId) || hosted.includes(remoteId + 0x100000000)) {
        alreadyHosted = true;
      }
    }
    setDefaultAnimsDisabled(this.refrId, alreadyHosted ? false : true);

    // Own companions and steered pets keep the follow offset their service gives them
    if (alreadyHosted && !keepsOwnOffset(this.remoteRefrId)) {
      Actor.from(refr)?.clearKeepOffsetFromActor();
    }

    // A rider clone is left to the engine while it rides, and so is a horse clone while the engine is asked to seat one or a clone in a killmove
    const mounted = !model.isMyClone &&
      (applyMount(refr, model, this.mountState) || isMountSuspended(this.refrId) || isCloneMovementSuspended(this.refrId));

    if (model.movement) {
      let ac = Actor.from(refr);
      if (
        this.movState.lastApply &&
        Date.now() - this.movState.lastApply > 1500
      ) {
        if (Date.now() - this.movState.lastRehost > 1000) {
          this.movState.lastRehost = Date.now();
          const remoteId = this.remoteRefrId;
          if (ac && ac.is3DLoaded()) {
            this.tryHostIfNeed(ac, remoteId as number);
            printConsole("tryHostIfNeed - reason: not seeing movement for long time");
          }
        }
      }

      const isNewMovement = +(model.numMovementChanges as number) !== this.movState.lastNumChanges;
      if (isNewMovement || Date.now() - this.movState.lastApply > 2000) {
        this.movState.lastApply = Date.now();
        const hostedByOther = isModelHostedByOther(model);
        if (hostedByOther || !this.movState.everApplied) {
          const backup = model.movement.isWeapDrawn;
          const isDeadBackup = model.movement.isDead;
          if (forcedWeapDrawn === true || forcedWeapDrawn === false) {
            model.movement.isWeapDrawn = forcedWeapDrawn;
          }
          // A copy this client does not run is not drawn or sheathed while its skeleton settles
          if (ac && !alreadyHosted && this.isSettling(ac)) {
            model.movement.isWeapDrawn = ac.isWeaponDrawn();
          }
          // The server's death state wins over a host that never saw the death
          if (model.isDead) {
            model.movement.isDead = true;
          }
          try {
            // A sender silent for 2 s (paused game, Steam overlay) settles at the copy's own height instead of running in place or hanging mid-air
            const movement: Movement = mounted || isNewMovement || !this.movState.everApplied || !ac
              ? model.movement
              : { ...model.movement, runMode: "Standing", isInJumpState: false, pos: [model.movement.pos[0], model.movement.pos[1], refr.getPositionZ()] };
            // The first apply also runs on the host, where a self offset would replace the follow its service just issued
            const ownOffset = !hostedByOther && keepsOwnOffset(this.remoteRefrId);
            applyMovement(refr, movement, !!model.isMyClone, mounted, ownOffset);
            if (!mounted) {
              restoreSitCollisionIfMoving(refr, movement);
            }
          } catch (e) {
            if (e instanceof RespawnNeededError) {
              this.lastWorldOrCell = model.movement.worldOrCell;
              this.destroy();
              this.refrId = 0;
              this.appearanceBasedBaseId = 0;
              return;
            } else {
              throw e;
            }
          } finally {
            model.movement.isWeapDrawn = backup;
            model.movement.isDead = isDeadBackup;
          }

          this.movState.lastNumChanges = +(model.numMovementChanges as number);
          this.movState.everApplied = true;
        } else {
          const remoteId = this.remoteRefrId;
          if (ac && remoteId && ac.is3DLoaded()) {
            if (!keepsOwnOffset(remoteId)) {
              ac.clearKeepOffsetFromActor();
            }

            // TODO: make host service
            const hosted = storage['hosted'];
            let alreadyHosted = false;
            if (Array.isArray(hosted)) {
              const remoteId = localIdToRemoteId(ac.getFormID());
              if (hosted.includes(remoteId) || hosted.includes(remoteId + 0x100000000)) {
                alreadyHosted = true;
              }
            }

            if (!alreadyHosted) {
              if (this.tryHostIfNeed(ac, remoteId)) {

                // previously, we did this cleanup on each update
                // but I guess it's too expensive and can possibly hurt FPS
                TESModPlatform.setWeaponDrawnMode(ac, -1);
              }
            }
          }
        }
      }
    }

    // Hosts skip applyMovement, so a copy still standing after the server's death is killed here
    if (model.isDead) {
      const ac = Actor.from(refr);
      if (ac && !ac.isDead()) {
        SpApiInteractor.getControllerInstance().emitter.emit("applyDeathStateEvent", { actor: ac, isDead: true });
      }
    }

    if (refr.is3DLoaded()) {
      if (model.animation) {
        applyAnimation(refr, model.animation, this.animState, mounted, !!model.appearance);
      }
      // Use them only once, for spawning actors with correct animations
      this.animState.useAnimOverrides = false;
    }

    this.applyAdminView(refr, model);


    if (model.appearance) {
      const actor = Actor.from(refr);
      if (actor && !PlayerCharacterDataHolder.isInJumpState()) {
        if (PlayerCharacterDataHolder.getWorldOrCell()) {
          if (
            this.lastPcWorldOrCell &&
            PlayerCharacterDataHolder.getWorldOrCell() !== this.lastPcWorldOrCell
          ) {
            // Redraw tints if PC world/cell changed
            this.isOnScreen = false;
            this.lastNiNodeUpdateMs = 0;
          }
          this.lastPcWorldOrCell = PlayerCharacterDataHolder.getWorldOrCell();
        }

        const headPos = [
          NetImmerse.getNodeWorldPositionX(actor, "NPC Head [Head]", false),
          NetImmerse.getNodeWorldPositionY(actor, "NPC Head [Head]", false),
          NetImmerse.getNodeWorldPositionZ(actor, "NPC Head [Head]", false),
        ];
        const [screenPoint] = worldPointToScreenPoint(headPos);
        const isOnScreen =
          screenPoint[0] > 0 &&
          screenPoint[1] > 0 &&
          screenPoint[2] > 0 &&
          screenPoint[0] < 1 &&
          screenPoint[1] < 1 &&
          screenPoint[2] < 1;
        if (isOnScreen != this.isOnScreen) {
          this.isOnScreen = isOnScreen;
          if (isOnScreen && Date.now() - this.lastNiNodeUpdateMs >= FormView.niNodeUpdateMinIntervalMs) {
            this.lastNiNodeUpdateMs = Date.now();
            actor.queueNiNodeUpdate();
            // The rebuilt 3D drops effect shaders
            if (this.adminShaderOn) {
              this.adminShaderReplayAt = this.lastNiNodeUpdateMs + FormView.adminShaderReplayDelayMs;
            }
          }
        }
      }
    }

    if (model.equipment) {
      if (this.eqState.lastNumChanges !== model.equipment.numChanges) {
        const ac = Actor.from(refr);
        // If we do not block inventory here, we will be able to reproduce the bug:
        // 1. Place ~90 bots and force them to reequip iron swords to the left hand (rate should be ~50ms)
        // 2. Open your inventory and reequip different items fast
        // 3. After 1-2 minutes close your inventory and see that HUD disappeared
        if (
          ac &&
          !isBadMenuShown() &&
          Date.now() - this.eqState.lastEqMoment > 500 &&
          Date.now() - this.spawnMoment > -1 &&
          this.spawnMoment > 0
        ) {
          //if (this.spawnMoment > 0 && Date.now() - this.spawnMoment > 5000) {
          // Stripping and re-equipping an NPC copy races the engine's skeleton update, so a copy already wearing the set is left alone
          if (!model.appearance && wearsExactly(ac, model.equipment)) {
            this.eqState.lastNumChanges = model.equipment.numChanges;
            this.eqState.resyncAt = Date.now() + FormView.handGraphCheckDelayMs;
          } else if (applyEquipment(ac, model.equipment)) {
            this.eqState.lastNumChanges = model.equipment.numChanges;
            this.eqState.resyncAt = Date.now() + FormView.handGraphCheckDelayMs;
          }
          this.eqState.lastEqMoment = Date.now();
          //}
          //const res: boolean = applyEquipment(ac, model.equipment);
          //if (res) this.eqState.lastNumChanges = model.equipment.numChanges;
        }
      }
    }

    // A recreated copy can hold its weapon while the graph still swings fists, once per equipment change after the apply settled
    if (this.eqState.resyncAt && Date.now() >= this.eqState.resyncAt && !model.isMyClone && !mounted && !alreadyHosted) {
      const ac = Actor.from(refr);
      if (ac && refr.is3DLoaded() && !this.isSettling(ac)) {
        this.eqState.resyncAt = 0;
        resyncHandGraph(ac, (text) => logToPlatformLog("FormView", `${(this.remoteRefrId ?? 0).toString(16)} ${text}`));
      }
    }

    const showTag = FormView.isDisplayingNicknames || FormView.isSpeaking(this.getRemoteRefrId());
    if (showTag && this.refrId && model.appearance?.name) {
      const headPart = "NPC Head [Head]";
      const maxNicknameDrawDistance = 1000;
      const playerActor = Game.getPlayer()!;
      const isVisibleByPlayer = !model.movement?.isSneaking
        && playerActor.getDistance(refr) <= maxNicknameDrawDistance
        && playerActor.hasLOS(refr)
        && !this.isSweetHidePerson(refr)
        && !this.isInvisible(refr)
        && FormView.adminViewOf(model) !== "hidden";
      if (isVisibleByPlayer) {
        const headScreenPos = worldPointToScreenPoint([
          NetImmerse.getNodeWorldPositionX(refr, headPart, false),
          NetImmerse.getNodeWorldPositionY(refr, headPart, false),
          NetImmerse.getNodeWorldPositionZ(refr, headPart, false) + 32
        ])[0];
        const resolution = getScreenResolution();
        const textXPos = Math.round(headScreenPos[0] * resolution.width);
        const textYPos = Math.round((1 - headScreenPos[1]) * resolution.height);

        if (!this.textNameId && headScreenPos[2] > 0) {
          this.createdTagName = this.tagName(refr, model);
          this.createdActorIdLine = FormView.showsActorIdLine();
          this.textNameId = createText(textXPos, textYPos, this.createdTagName, [1, 1, 1, 0.8]);
          setTextSize(this.textNameId, 0.5);
          // Local (ffxxxxxx) actor id on a second line under the name
          if (this.createdActorIdLine) {
            this.textActorIdId = createText(
              textXPos,
              textYPos + FormView.actorIdLineOffset,
              this.refrId.toString(16).toUpperCase().padStart(8, "0"),
              [1, 1, 1, 0.6]
            );
            setTextSize(this.textActorIdId, 0.4);
          }
          SpApiInteractor.getControllerInstance().emitter.emit("nicknameCreate", {
            remoteRefrId: this.getRemoteRefrId(),
            textId: this.textNameId
          });
        } else {
          const deleteNickname = headScreenPos[2] < 0;
          if (deleteNickname) {
            this.removeNickname();
          }
          // Rename (/mask), a fresh introduction or a toggled id line: recreate
          if (this.textNameId
            && (this.tagName(refr, model) !== this.createdTagName || this.createdActorIdLine !== FormView.showsActorIdLine())) {
            this.removeNickname();
          }
          if (this.textNameId) {
            setTextPos(this.textNameId, textXPos, textYPos);
          }
          if (this.textActorIdId) {
            setTextPos(this.textActorIdId, textXPos, textYPos + FormView.actorIdLineOffset);
          }
        }
      } else {
        this.removeNickname();
      }
    } else {
      this.removeNickname();
    }
  }

  // Real name once introduced to the local player, else "Stranger"; Show Title puts the faction title in front of it, and a talking player gets the VOIP glyph (the glyph alone while names are hidden)
  private tagName(refr: ObjectReference, model: FormModel): string {
    const remoteId = this.getRemoteRefrId();
    if (!FormView.isDisplayingNicknames) return FormView.voipGlyph;
    const voip = FormView.isSpeaking(remoteId) ? `${FormView.voipGlyph} ` : "";
    if (!knowsCharacter(remoteId)) return `${voip}Stranger`;
    const name = refr.getDisplayName();
    const title = (model as Record<string, unknown>)["ff_factionTitle"];
    return voip + (typeof title === "string" && title ? `${title} ${name}` : name);
  }

  // Every invisibility effect carries MagicInvisibility, the spell and the potion alike
  private isInvisible(refr: ObjectReference): boolean {
    const actor = Actor.from(refr);
    return !!actor && actor.hasMagicEffectWithKeyword(Keyword.getKeyword('MagicInvisibility'));
  }

  private isSweetHidePerson(refr: ObjectReference): boolean {
    const actor = Actor.from(refr)
    if (!actor) {
      return false;
    }
    const keyword = Keyword.getKeyword('SweetHidePerson');
    return actor.wornHasKeyword(keyword);
  }

  // ff_hostile can arrive in an UpdateProperty after the copy spawned, so a changed flag is checked again
  private applyHostility(actor: Actor, model: FormModel): void {
    const flag = (model as Record<string, unknown>)["ff_hostile"];
    if (this.hostilityApplied && flag === this.hostileFlagSeen) {
      return;
    }
    this.hostilityApplied = true;
    this.hostileFlagSeen = flag;
    if (FormView.attacksEveryone(actor, model, this.remoteRefrId)) {
      if (this.aggressionBeforeRaise === undefined) {
        this.aggressionBeforeRaise = actor.getActorValue("Aggression");
      }
      actor.setActorValue("Aggression", 2);
    } else if (this.aggressionBeforeRaise !== undefined && flag === false && !isOwnCompanion(this.remoteRefrId)) {
      // Raised before the server's false flag arrived (PlaceAtMe sends the copy first), so it goes back; CompanionService sets up own companions
      actor.setActorValue("Aggression", this.aggressionBeforeRaise);
      this.aggressionBeforeRaise = undefined;
    }
  }

  // Remote players' copies are neutral to every NPC, so NPCs that attack players on sight are raised to attack neutrals too
  private static attacksEveryone(actor: Actor, model: FormModel, remoteId: number | undefined): boolean {
    const hostile = (model as Record<string, unknown>)["ff_hostile"];
    // Companions are flagged false by the server, and CompanionService sets up the player's own ones
    if (hostile === false || isOwnCompanion(remoteId)) {
      return false;
    }
    if (FormView.ambushRaces.includes(actor.getRace()?.getFormID() ?? 0)) {
      return true;
    }
    if (model.appearance || actor.getActorValue("Aggression") >= 2) {
      return false;
    }
    // Allies and friends of the player (followers, housecarls) never turn on anyone
    const player = Game.getPlayer();
    if (player && actor.getFactionReaction(player) >= 2) {
      return false;
    }
    // Without the server's flag, fall back to the plugin's own aggression
    return typeof hostile === "boolean" ? hostile : actor.getActorValue("Aggression") >= 1;
  }

  // Admin Invisible and Ghost ride the neighbor-visible ff_adminModes prop; 3D reloads reset alpha and shaders, so both are reapplied
  private applyAdminView(refr: ObjectReference, model: FormModel): void {
    const view = FormView.adminViewOf(model);
    if (view === "visible" && this.adminView === "visible") {
      return;
    }
    const actor = Actor.from(refr);
    if (!actor || !actor.is3DLoaded()) {
      this.adminShaderOn = false;
      return;
    }
    // Local weapons and spells pass through a Ghost admin's copy; the server refuses any hit that still lands
    const ghostFlag = FormView.adminModeOn(model, "ghost");
    if (ghostFlag !== this.adminGhostFlag) {
      actor.setGhost(ghostFlag);
      this.adminGhostFlag = ghostFlag;
    }
    const now = Date.now();
    const leavingGhost = this.adminView === "ghost" && view !== "ghost";
    const playShader = view === "ghost"
      && (!this.adminShaderOn || (this.adminShaderReplayAt > 0 && now >= this.adminShaderReplayAt));
    if (leavingGhost || playShader) {
      setAdminGhostShader(actor, playShader);
      this.adminShaderOn = playShader;
      this.adminShaderReplayAt = 0;
    }
    if (view !== this.adminView || now - this.lastAdminHideApply >= FormView.adminHideReapplyMs) {
      if (view !== this.adminView) {
        printConsole(`[admin] ${this.getRemoteRefrId().toString(16)} shown ${view}`);
      }
      actor.setAlpha(view === "hidden" ? 0 : view === "ghost" ? adminGhostAlpha : 1, false);
      this.adminView = view;
      this.lastAdminHideApply = now;
    }
  }

  // Invisible admins are hidden from players and shown to admins as ghosts; Ghost admins look ethereal to everyone
  private static adminViewOf(model: FormModel): AdminView {
    if (FormView.adminModeOn(model, "invis")) {
      return FormView.viewerIsAdmin() ? "ghost" : "hidden";
    }
    return FormView.adminModeOn(model, "ghost") ? "ghost" : "visible";
  }

  private static adminModeOn(model: FormModel, mode: string): boolean {
    const modes = (model as Record<string, unknown>)["ff_adminModes"];
    return !!modes && typeof modes === "object" && !!(modes as Record<string, unknown>)[mode];
  }

  private static viewerIsAdmin(): boolean {
    if (storage["ownerModelSet"] !== true) {
      return false;
    }
    const owner = storage["ownerModel"] as Record<string, unknown> | undefined;
    return !!owner && owner["isAdmin"] === true;
  }

  private removeNickname() {
    if (this.textNameId) {
      SpApiInteractor.getControllerInstance().emitter.emit("nicknameDestroy", {
        remoteRefrId: this.getRemoteRefrId(),
        textId: this.textNameId
      });
      destroyText(this.textNameId);
      this.textNameId = undefined;
    }
    if (this.textActorIdId) {
      destroyText(this.textActorIdId);
      this.textActorIdId = undefined;
    }
  }

  private getAppearanceBasedBase(): number {
    const base = ActorBase.from(Game.getFormEx(this.appearanceBasedBaseId));
    if (!base && this.appearanceState.appearance) {
      this.appearanceBasedBaseId = applyAppearance(this.appearanceState.appearance).getFormID();
    }
    return this.appearanceBasedBaseId;
  }

  private getLeveledBase(templateChain: number[] | undefined): number {
    if (templateChain === undefined) {
      return 0;
    }

    const str = templateChain.join(',');

    if (this.leveledBaseId === 0) {
      // @ts-ignore
      const leveledBase = TESModPlatform.evaluateLeveledNpc(str);
      if (!leveledBase) {
        printConsole("Failed to evaluate leveled npc", str);
      }
      this.leveledBaseId = leveledBase?.getFormID() || 0;
    }

    return this.leveledBaseId;
  }

  // True until the copy's 3D has stayed loaded for copySettleMs
  private isSettling(ac: Actor): boolean {
    if (!ac.is3DLoaded()) {
      this.loaded3DMoment = 0;
      return true;
    }
    if (!this.loaded3DMoment) {
      this.loaded3DMoment = Date.now();
    }
    return Date.now() - this.loaded3DMoment < FormView.copySettleMs;
  }

  private getDefaultEquipState() {
    return { lastNumChanges: 0, lastEqMoment: 0, resyncAt: 0 };
  };

  private getDefaultAppearanceState() {
    return { lastNumChanges: 0, appearance: null as (null | Appearance) };
  };

  private getDefaultAnimState() {
    return { lastNumChanges: 0, useAnimOverrides: true };
  };

  private tryHostIfNeed(ac: Actor, remoteId: number) {
    const last = lastTryHost[remoteId];
    if (!last || Date.now() - last >= 1000) {
      lastTryHost[remoteId] = Date.now();

      if (
        ObjectReferenceEx.getWorldOrCell(ac) ===
        ObjectReferenceEx.getWorldOrCell(Game.getPlayer() as Actor)
      ) {
        tryHost(remoteId);
        return true;
      }
    }
    return false;
  };

  getLocalRefrId(): number {
    return this.refrId;
  }

  getRemoteRefrId(): number {
    return this.remoteRefrId as number;
  }

  private refrId = 0;
  private ready = false;
  private animState = this.getDefaultAnimState();
  private movState = {
    lastNumChanges: 0,
    lastApply: 0,
    lastRehost: 0,
    everApplied: false,
  };
  private appearanceState = this.getDefaultAppearanceState();
  private eqState = this.getDefaultEquipState();
  private appearanceBasedBaseId = 0;
  private leveledBaseId = 0;
  private isOnScreen = false;
  private lastNiNodeUpdateMs = 0;
  // A head at the camera (a carried player inside their carrier) flickers on and off screen; each rebuild is a hitch
  private static readonly niNodeUpdateMinIntervalMs = 5000;
  private lastPcWorldOrCell = 0;
  private lastWorldOrCell = 0;
  private spawnMoment = 0;
  private loaded3DMoment = 0;
  private static readonly copySettleMs = 1000;
  private static readonly handGraphCheckDelayMs = 1500;
  private wasHostedByOther: boolean | undefined = undefined;
  private state = {};
  private mountState = makeMountState();
  private localImmortal = false;
  private hostilityApplied = false;
  private hostileFlagSeen: unknown = undefined;
  private aggressionBeforeRaise: number | undefined = undefined;
  private adminView: AdminView = "visible";
  private adminShaderOn = false;
  private adminShaderReplayAt = 0;
  private adminGhostFlag = false;
  private lastAdminHideApply = 0;
  private textNameId: number | undefined = undefined;
  private textActorIdId: number | undefined = undefined;
  private createdTagName = "";
  private createdActorIdLine = false;

  // Screen-space pixels between the name line and the actor id line
  private static readonly actorIdLineOffset = 18;
  private static readonly adminHideReapplyMs = 1000;
  private static readonly adminShaderReplayDelayMs = 1000;
  // Draugr, falmer, chaurus, frostbite spiders, dwarven automatons, spriggans and wolves: ambush AI can start them passive
  private static readonly ambushRaces = [0xd53, 0x131f4, 0x131eb, 0x4e507, 0x53477, 0x131f1, 0x131f2, 0x131f3, 0x2013b77, 0xf3903, 0x13204, 0x401b644, 0x9aa44, 0x1320a];

  // Both off until the chat settings say otherwise, so a fresh player never sees a tag
  public static isDisplayingNicknames: boolean = false;
  public static isDisplayingActorIds: boolean = false;
  // remote id -> until when its name tag shows the VOIP glyph, fed by LipSyncService
  public static speakingUntil = new Map<number, number>();
  // Private-use glyph added to the Tavern font by misc/voip-glyph
  private static readonly voipGlyph = "\uE000";

  public static isSpeaking(remoteId: number): boolean {
    return (FormView.speakingUntil.get(remoteId) ?? 0) > Date.now();
  }

  // The id line never shows without the name above it
  private static showsActorIdLine(): boolean {
    return FormView.isDisplayingNicknames && FormView.isDisplayingActorIds;
  }
}
