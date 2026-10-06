import { Actor, ActorBase, createText, destroyText, FormType, Game, Keyword, NetImmerse, ObjectReference, once, setTextColor, setTextRefr, setTextRefrNode, setTextRefrOffset, setTextRefrScreenOffset, setTextSize, setTextString, storage, TESModPlatform, Utility, worldPointToScreenPoint } from "skyrimPlatform";
import { setDefaultAnimsDisabled, applyAnimation, restoreSitCollisionIfMoving, isCastStartEvent, isShotEvent } from "../sync/animation";
import { probeCopyCast } from "../sync/castProbe";
import { Appearance, applyAppearance } from "../sync/appearance";
import { isBadMenuShown, isBadMenuShownNow, applyEquipment, countWorn, equipEntries, Equipment, getMissingWorn, getWornLight, resyncHandGraph, wearsExactly } from "../sync/equipment";
import { Entry } from "../sync/inventory";
import { logToPlatformLog } from "../logging";
import { RespawnNeededError } from "../lib/errors";
import { FormModel } from "./model";
import { aimForShot, applyMovement, forgetGroundSample, isCarrierCloneId, makeAppliedMovement, noteMovementArrival, recheckTurn } from "../sync/movementApply";
import { applyMount, isCloneMovementSuspended, isMountSuspended, makeMountState, releaseCloneOnEvent, releaseRiderClone, dismountRiderOf } from "../sync/mountApply";
import { applyCarried, makeCarriedViewState, releaseHold } from "../sync/carryHold";
import { Movement, NiPoint3 } from "../sync/movement";
import { SpawnProcess } from "./spawnProcess";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { FormTypeEx } from "../extensions/formTypeEx";
import { PlayerCharacterDataHolder } from "./playerCharacterDataHolder";
import { lastTryHost, tryHost } from "./hostAttempts";
import { ModelApplyUtils } from "./modelApplyUtils";
import { carriedByOther, disabledByServer, isModelHostedByOther, isRemoteHostedByMe, knowsCharacter, shortRemoteId } from "./worldViewMisc";
import { SpApiInteractor } from "../services/spApiInteractor";
import { WorldCleanerService } from "../services/services/worldCleanerService";
import { isOwnCompanion, keepsOwnOffset } from "../services/services/companionService";
import { adminGhostAlpha, afterlifeLookOf, setAdminGhostShader } from "./adminGhostLook";

export interface ScreenResolution {
  width: number;
  height: number;
}

type AdminView = "visible" | "hidden" | "ghost";

// An admin's account name and staff tier, streamed as ff_adminTag while their Show account name mode is on
interface AdminTag {
  n: string;
  t: string;
}

const DEFAULT_TAG_COLOR = [1, 1, 1, 0.8];
const TIER_TAG_COLORS: Record<string, number[]> = {
  senior: [1, 0.25, 0.25, 0.9],
  developer: [0.3, 0.55, 1, 0.9],
  gm: [0.3, 0.9, 0.3, 0.9],
};

// Every invisibility effect carries MagicInvisibility, the spell and the potion alike; its form id, 0 when the keyword is missing
let magicInvisibilityId: number | undefined;

const HEAD_NODE = "NPC Head [Head]";
// Name tags sit this many units above the head node
const TAG_HEAD_OFFSET = 32;
const MAX_TAG_DISTANCE = 1000;
// A fresh NPC copy further than this from its spawn point once its spawn finished is logged
const SPAWN_OFF_UNITS = 32;

const fmtPos = (pos: readonly number[]): string => pos.map(Math.round).join(",");

// The platform moves the text over the ref's head every frame until it is destroyed
export const createHeadText = (refrId: number, text: string, color: number[], size: number, heightOffset: number, screenOffsetY = 0): number => {
  const id = createText(-1000, -1000, text, color);
  setTextSize(id, size);
  setTextRefr(id, refrId);
  setTextRefrNode(id, HEAD_NODE);
  setTextRefrOffset(id, [0, 0, heightOffset]);
  if (screenOffsetY) {
    setTextRefrScreenOffset(id, [0, screenOffsetY]);
  }
  return id;
};

// Normalized screen point of the head node; z is 0 or less behind the camera
const headScreenPoint = (refr: ObjectReference): number[] => worldPointToScreenPoint([
  NetImmerse.getNodeWorldPositionX(refr, HEAD_NODE, false),
  NetImmerse.getNodeWorldPositionY(refr, HEAD_NODE, false),
  NetImmerse.getNodeWorldPositionZ(refr, HEAD_NODE, false),
])[0];

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
  constructor(private remoteRefrId?: number, private readonly onLocalIdChange?: (view: FormView, previous: number) => void) { }

  update(model: FormModel, tagPass = false): void {
    // Other players mutate into PC clones when moving to another location
    if (model.movement) {
      if (!this.lastWorldOrCell)
        this.lastWorldOrCell = model.movement.worldOrCell;
      if (this.lastWorldOrCell !== model.movement.worldOrCell) {
        this.lastWorldOrCell = model.movement.worldOrCell;
        this.respawn("its world or cell changed");
        return;
      }
    }



    // A PK body stands in for this dead player, whose own copy goes once no pair or chop scene plays on it here
    if (Date.now() < (model.bodyLeftUntil ?? 0) && !isCloneMovementSuspended(this.refrId)) {
      if (this.refrId !== 0) {
        logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} hidden: a PK body stands in for the dead copy ${this.refrId.toString(16)}`);
        this.destroy();
        this.refrId = 0;
      }
      return;
    }

    // Dead players stay hidden until they respawn; NPC corpses and the bodies a PK leaves (ff_body) spawn and are killed on the first apply
    if (model.isDead && this.refrId === 0 && model.appearance && (model as Record<string, unknown>)["ff_body"] !== true) {
      return;
    }

    // Players with different worldOrCell should be invisible
    if (model.movement) {
      const worldOrCell = PlayerCharacterDataHolder.getWorldOrCell();
      if (
        worldOrCell !== 0 &&
        model.movement.worldOrCell !== worldOrCell
      ) {
        if (this.refrId !== 0) this.spawnReason = "the player left its world or cell";
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
          } else {
            // Force re-apply appearance on the next getAppearanceBasedBase call
            this.appearanceBasedBaseId = 0;
          }
        } else {
          // Force re-apply appearance on the next getAppearanceBasedBase call
          this.appearanceBasedBaseId = 0;
        }

        this.appearanceState.appearance = model.appearance || null;
        this.appearanceState.lastNumChanges = model.numAppearanceChanges as number;
      }
    }

    const refId =
      model.refrId && model.refrId < 0xff000000 ? model.refrId : undefined;
    if (refId && this.refrId !== refId) {
      this.destroy();
      this.refrId = refId;
      this.ready = true;
    }

    let refr = ObjectReference.from(Game.getFormEx(this.refrId));
    if (!refId && (!refr || !this.isBaseChecked(model))) {
      const checked = this.spawnIfNeeded(refr, model);
      if (!checked) {
        return;
      }
      refr = checked;
    }

    if (!this.ready || !refr) {
      return;
    }

    const loaded = refr.is3DLoaded();
    const loadedNow = loaded && !this.was3DLoaded;
    this.was3DLoaded = loaded;
    // A freed FF id can go to another ref, which loads its own 3D, so the base is compared again
    if (loadedNow && !refId) {
      this.checkedModelBaseId = null;
    }

    const actor = this.isActor === false ? null : Actor.from(refr);
    if (this.isActor === undefined) {
      this.isActor = !!actor;
      // Blocked once per copy, so a world NPC that PetService unblocks stays talkable
      actor?.blockActivation(true);
    }
    // The engine keeps the deferred kill in the process data an actor only has once its 3D is in, so it is set then and again after each 3D load; never on a corpse
    if (actor && loaded && !model.isDead && (!this.localImmortal || loadedNow)) {
      FormView.makeImmortal(actor);
      this.localImmortal = true;
    }
    if (actor && !refId) {
      this.applyHostility(actor, model);
    }
    this.applyAll(refr, actor, model, loaded, loadedNow, tagPass);
  }

  // The model's base and the appearance base the copy was last checked against
  private isBaseChecked(model: FormModel): boolean {
    return model.baseId === this.checkedModelBaseId && this.appearanceBasedBaseId === this.checkedAppearanceBaseId;
  }

  // The copy, spawned again when it is gone or its base is not the chosen one; undefined while no base resolves
  private spawnIfNeeded(existing: ObjectReference | null, model: FormModel): ObjectReference | undefined {
    let base = Game.getFormEx(model.baseId || NaN);
    if (base === null) {
      base = Game.getFormEx(this.getAppearanceBasedBase());
    }
    if (base === null) {
      return undefined;
    }

    let refr = existing;
    if (!refr || refr.getBaseObject()?.getFormID() !== base.getFormID()) {
      if (refr) this.spawnReason = "its base changed";
      this.destroy();

      if (model.movement) {
        refr = (Game.getPlayer() as Actor).placeAtMe(base, 1, true, true) as ObjectReference;
      }

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
      this.torchState.numChanges = -1;
      this.animState = this.getDefaultAnimState();

      this.ready = false;

      const spawnPos = model.movement ? model.movement.pos : ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
      // NPC copies are placed at the player and moved by the spawn; each placement and a spawn that left one off its spot are logged
      const npcCopy = !!model.movement && !model.appearance;
      const localId = refr?.getFormID() ?? 0;
      if (npcCopy && refr) {
        this.logCopyPlacement(localId, spawnPos);
      }

      if (refr) {
        new SpawnProcess(model.appearance || null, spawnPos, refr.getFormID(), () => {
          this.ready = true;
          this.spawnMoment = Date.now();
          // The spawn's resurrect resets the actor, so the deferred kill is set again at the next update
          this.localImmortal = false;
          if (npcCopy && this.refrId === localId) this.logSpawnOff(localId, spawnPos);
        }, !!model.isDead);
      }

      if (model.appearance && model.appearance.name) {
        refr?.setDisplayName("" + model.appearance.name, true);
      }
      const spawned = Actor.from(refr);
      if (spawned) {
        spawned.setActorValue("attackDamageMult", 0);
        // A copy just placed has no process data, where the deferred kill lives, so update sets it once the 3D is in
        if (!model.isDead) FormView.makeImmortal(spawned);
        this.localImmortal = false;
      }
    }
    this.refrId = (refr as ObjectReference).getFormID();
    this.checkedModelBaseId = model.baseId;
    this.checkedAppearanceBaseId = this.appearanceBasedBaseId;
    return refr as ObjectReference;
  }

  // Spawned again at the next update, its appearance base included; the reason goes into the placement line
  private respawn(reason: string): void {
    this.spawnReason = reason;
    this.destroy();
    this.refrId = 0;
    this.appearanceBasedBaseId = 0;
  }

  private logCopyPlacement(localId: number, spawnPos: readonly number[]): void {
    const placedAt = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
    const away = Math.round(ObjectReferenceEx.getDistance(placedAt, spawnPos as NiPoint3));
    // Kept from the view's first placement: a respawn's target is only the last relayed report, the ragdoll spot after an engine death
    const first = this.spawnPoint ? `, first placed for ${fmtPos(this.spawnPoint)}` : "";
    if (!this.spawnPoint) this.spawnPoint = [spawnPos[0], spawnPos[1], spawnPos[2]];
    logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} copy ${localId.toString(16)} placed at the player ${fmtPos(placedAt)} for ${fmtPos(spawnPos)} (${away} units away)${first}, hosted here ${isRemoteHostedByMe(this.remoteRefrId ?? 0)}, ${this.spawnReason}`);
    this.spawnReason = "fresh";
  }

  // The spawn moved, enabled and resurrected the copy; one that still stands away from its spawn point is the evidence for a copy left at the player
  private logSpawnOff(localId: number, spawnPos: readonly number[]): void {
    const refr = ObjectReference.from(Game.getFormEx(localId));
    if (!refr) return;
    const pos = ObjectReferenceEx.getPos(refr);
    const off = Math.round(ObjectReferenceEx.getDistanceNoZ(pos, spawnPos as NiPoint3));
    if (off <= SPAWN_OFF_UNITS) return;
    const player = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
    logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} copy ${localId.toString(16)} stands ${off} units from its spawn point after the spawn, at ${fmtPos(pos)}, ${Math.round(ObjectReferenceEx.getDistance(pos, player))} units from the player, disabled ${refr.isDisabled()}, 3D ${refr.is3DLoaded()}`);
  }

  destroy(): void {
    this.redrawTints();
    this.spawnMoment = 0;
    this.loaded3DMoment = 0;
    this.was3DLoaded = false;
    this.checkedModelBaseId = null;
    this.objectState = this.getDefaultObjectState();
    this.isActor = undefined;
    this.offsetCleared = false;
    this.appliedMovement = makeAppliedMovement();
    const refrId = this.refrId;
    forgetGroundSample(refrId);
    if (refrId >= 0xff000000) {
      PlayerCharacterDataHolder.forgetCrosshairRef(refrId);
    }
    this.mountState = makeMountState();
    // Before the id can go to another copy
    releaseHold(this.carriedState.hold);
    this.carriedState = makeCarriedViewState();
    once("update", () => {
      if (refrId >= 0xff000000) {
        const refr = ObjectReference.from(Game.getFormEx(refrId));
        if (refr) {
          // A horse leaving throws its rider first; a rider leaving lets go of its saddle
          dismountRiderOf(refrId);
          releaseRiderClone(refrId);
          const ac = Actor.from(refr);
          if (ac) {
            TESModPlatform.setWeaponDrawnMode(ac, -1);
          }
          refr.disable(false).then(() => {
            ObjectReference.from(Game.getFormEx(refrId))?.delete();
          });
        }
        SpApiInteractor.getControllerInstance().lookupListener(WorldCleanerService).modWcProtection(refrId, -1);
      }
    })

    this.localImmortal = false;
    this.killApplied = false;
    this.engineDeadSince = 0;
    this.hostilityApplied = false;
    this.aggressionBeforeRaise = undefined;
    this.adminView = "visible";
    this.adminShaderOn = false;
    this.adminShaderReplayAt = 0;
    this.adminGhostFlag = false;
    this.afterlifeShaderId = 0;
    this.afterlifeShaderReplayAt = 0;
    this.removeNickname();
  }

  // An open or close the engine ran on its own (local AI, a script) is checked against the model at the next update
  noteOpenClose(): void {
    this.objectState.openCheck = true;
  }

  // A loaded game rebuilds every ref, so the next update with the 3D in counts as a 3D load
  forgetLoaded3D(): void {
    this.was3DLoaded = false;
    // The loaded game brought back the plugin's enabled ref, so the next update disables it again
    if (this.objectState.disabled) this.objectState.disabled = undefined;
  }

  private isSetNodeTextureSetApplied = false;
  private isSetNodeScaleApplied = false;

  // Actors skip these, whose inventory apply would break a copy's equipment; open, harvested and carried state and a claim's name and lock go to the engine on a model change or a 3D load, a plugin door's disabled state on a model change or a loaded game
  private applyObjectModel(refr: ObjectReference, model: FormModel, loaded: boolean, loadedNow: boolean): void {
    const o = this.objectState;
    // A copy another player carries (PlacedItemSystem's ff_carried) stays hidden, however it was spawned
    const carriedAway = carriedByOther((model as Record<string, unknown>)["ff_carried"]);
    const harvested = !!model.isHarvested;
    const disabled = disabledByServer(model);
    const changed = carriedAway !== o.carriedAway || harvested !== o.harvested || disabled !== o.disabled;
    if (loadedNow || changed) {
      o.carriedAway = carriedAway;
      o.harvested = harvested;
      o.disabled = disabled;
      // A disabled door that loads its 3D with no model change was enabled here (a Papyrus snippet) and is left alone
      if (carriedAway || !disabled || changed) ModelApplyUtils.applyModelVisibility(refr, harvested, () => !!(o.carriedAway || o.disabled));
    }
    const decor = (model as Record<string, unknown>)["ff_decor"];
    if (loadedNow || decor !== o.decor) {
      o.decor = decor;
      ModelApplyUtils.applyModelDecor(refr, decor);
    }
    // A door set before its 3D is in can stick between open and closed, so the server's state waits for the 3D
    if (loaded) {
      const open = !!model.isOpen;
      const now = Date.now();
      const changed = loadedNow || open !== o.open || (o.openCheck && ModelApplyUtils.isOpenOrOpening(refr) !== open);
      const repeat = o.openReapplyAt > 0 && now >= o.openReapplyAt;
      if (changed || repeat) {
        o.openReapplyAt = changed ? now + FormView.openReapplyMs : 0;
        o.open = open;
        ModelApplyUtils.applyModelIsOpen(refr, open);
      }
    }
    o.openCheck = false;
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
      ModelApplyUtils.applyModelInventory(refr, model.inventory);
      model.inventory = undefined;
    }
  }

  private applyAll(refr: ObjectReference, actor: Actor | null, model: FormModel, loaded: boolean, loadedNow: boolean, tagPass: boolean) {
    let forcedWeapDrawn: boolean | null = null;

    if (!this.isActor) {
      this.applyObjectModel(refr, model, loaded, loadedNow);
    }

    if (model.animation) {
      if (model.animation.animEventName === "SkympFakeUnequip") {
        forcedWeapDrawn = false;
      } else if (model.animation.animEventName === "SkympFakeEquip") {
        forcedWeapDrawn = true;
      }
    }

    const alreadyHosted = isRemoteHostedByMe(this.remoteRefrId ?? 0);
    setDefaultAnimsDisabled(this.refrId, alreadyHosted ? false : true);

    // The engine runs a copy hosted here, so the next applied packet reads the copy again
    if (alreadyHosted) {
      this.appliedMovement.recheckAt = 0;
    }

    if (model.animation && model.animation.numChanges !== this.animState.lastNumChanges) releaseCloneOnEvent(this.refrId, model.animation.animEventName);
    // A rider clone is left to the engine while it rides, and so is a horse clone while the engine is asked to seat one or a clone in a killmove
    const mounted = !model.isMyClone &&
      (applyMount(refr, model, this.mountState) || isMountSuspended(this.refrId) || isCloneMovementSuspended(this.refrId));
    // A carried copy this client neither is nor runs is held on the local copy of its carrier every frame; its own packets move nothing while it is
    const held = applyCarried(refr, model, this.carriedState, !model.isMyClone && !mounted && !alreadyHosted);
    const movementHeld = mounted || held;

    if (model.movement) {
      const now = Date.now();
      // A copy silent this long may have lost its host
      if (this.movState.lastApply && now - this.movState.lastApply > FormView.movementStallMs) {
        if (now - this.movState.lastRehost > 1000) {
          this.movState.lastRehost = now;
          const remoteId = this.remoteRefrId;
          if (actor && loaded) {
            this.tryHostIfNeed(actor, remoteId as number, model);
          }
        }
      }

      const isNewMovement = +(model.numMovementChanges as number) !== this.movState.lastNumChanges;
      if (isNewMovement || now - this.movState.lastApply > FormView.movementStallMs) {
        this.movState.lastApply = now;
        const hostedByOther = isModelHostedByOther(model);
        if (hostedByOther || !this.movState.everApplied) {
          if (isNewMovement) {
            noteMovementArrival(this.appliedMovement, model.movement);
          }
          const backup = model.movement.isWeapDrawn;
          if (forcedWeapDrawn === true || forcedWeapDrawn === false) {
            model.movement.isWeapDrawn = forcedWeapDrawn;
          }
          // A copy this client does not run is not drawn or sheathed while its skeleton settles
          if (actor && !alreadyHosted && this.isSettling(loaded)) {
            model.movement.isWeapDrawn = actor.isWeaponDrawn();
          }
          try {
            // A sender silent for 3 s (paused game, Steam overlay) settles at the copy's own height instead of running in place or hanging mid-air
            const movement: Movement = movementHeld || isNewMovement || !this.movState.everApplied || !actor
              ? model.movement
              : { ...model.movement, runMode: "Standing", isInJumpState: false, pos: [model.movement.pos[0], model.movement.pos[1], refr.getPositionZ()] };
            // The first apply also runs on the host, where a self offset would replace the follow its service just issued
            const ownOffset = !hostedByOther && keepsOwnOffset(this.remoteRefrId);
            this.offsetCleared = false;
            applyMovement(refr, movement, !!model.isMyClone, movementHeld, ownOffset, this.appliedMovement);
            if (!movementHeld) {
              restoreSitCollisionIfMoving(refr, movement);
            }
            this.takeEngineDeathRead();
          } catch (e) {
            if (e instanceof RespawnNeededError) {
              this.lastWorldOrCell = model.movement.worldOrCell;
              this.respawn("its packet named another cell");
              return;
            } else {
              throw e;
            }
          } finally {
            model.movement.isWeapDrawn = backup;
          }

          this.movState.lastNumChanges = +(model.numMovementChanges as number);
          this.movState.everApplied = true;
        } else {
          const remoteId = this.remoteRefrId;
          if (actor && remoteId && loaded) {
            this.releaseKeepOffset(actor);

            if (!alreadyHosted) {
              if (this.tryHostIfNeed(actor, remoteId, model)) {

                // previously, we did this cleanup on each update
                // but I guess it's too expensive and can possibly hurt FPS
                TESModPlatform.setWeaponDrawnMode(actor, -1);
              }
            }
          }
        }
      } else if (actor && loaded && !alreadyHosted && !movementHeld) {
        recheckTurn(actor, this.appliedMovement);
      }
    }

    if (this.applyDeathState(actor, model, loaded)) {
      return;
    }

    if (loaded) {
      if (model.animation) {
        if (actor && !alreadyHosted && !mounted && model.animation.numChanges !== this.animState.lastNumChanges) {
          const event = model.animation.animEventName;
          const castStart = isCastStartEvent(event);
          // A staff cast has no SpellCast replay, so its start event is the copy's only cue and the copy is aimed here as before a shot
          if (castStart || isShotEvent(event)) {
            aimForShot(actor, model.movement, model.movement?.rot[0] ?? 0, event);
          }
          if (castStart) {
            probeCopyCast("staff", actor, `staff cast event ${event}`, true);
          }
        }
        applyAnimation(refr, model.animation, this.animState, mounted, !!model.appearance);
      }
      // Use them only once, for spawning actors with correct animations
      this.animState.useAnimOverrides = false;
      if (alreadyHosted) {
        this.releaseKeepOffset(actor);
      }
    } else {
      // Cleared and read from the engine again once the 3D is back
      this.offsetCleared = false;
      this.appliedMovement.recheckAt = 0;
    }

    this.applyAdminView(actor, loaded, model);
    this.applyAfterlifeView(actor, loaded, model);

    if (tagPass || (this.tintDue && model.appearance && actor)) {
      this.updateTagAndTint(refr, actor, model, loaded, held, tagPass);
    }

    if (model.equipment) {
      if (this.eqState.lastNumChanges !== model.equipment.numChanges) {
        // If we do not block inventory here, we will be able to reproduce the bug:
        // 1. Place ~90 bots and force them to reequip iron swords to the left hand (rate should be ~50ms)
        // 2. Open your inventory and reequip different items fast
        // 3. After 1-2 minutes close your inventory and see that HUD disappeared
        // An apply before the 3D is in strips and re-dresses a copy without a skeleton; lastNumChanges stays unset so the next update retries
        if (
          actor &&
          loaded &&
          Date.now() - this.eqState.lastEqMoment > 500 &&
          this.spawnMoment > 0 &&
          !isBadMenuShownNow()
        ) {
          // Stripping and re-equipping an NPC copy races the engine's skeleton update, so a copy already wearing the set is left alone
          if (!model.appearance && wearsExactly(actor, model.equipment)) {
            this.eqState.lastNumChanges = model.equipment.numChanges;
            this.eqState.resyncAt = Date.now() + FormView.handGraphCheckDelayMs;
          } else if (applyEquipment(actor, model.equipment)) {
            this.eqState.lastNumChanges = model.equipment.numChanges;
            this.eqState.resyncAt = Date.now() + FormView.handGraphCheckDelayMs;
            this.redrawTints();
          }
          this.eqState.verifyNumChanges = model.equipment.numChanges;
          this.eqState.lastEqMoment = Date.now();
        }
      }
    }

    // Once per equipment change after the apply settled: the engine drops equips from that routine, so the outfit is checked and completed,
    // and a recreated copy can hold its weapon while the graph still swings fists
    if (this.eqState.resyncAt && Date.now() >= this.eqState.resyncAt && !model.isMyClone && !mounted) {
      if (actor && loaded && !this.isSettling(loaded)) {
        this.eqState.resyncAt = 0;
        if (model.equipment && model.equipment.numChanges === this.eqState.verifyNumChanges) {
          this.verifyCopyOutfit(actor, model.equipment, !!model.appearance);
        }
        if (!alreadyHosted) {
          resyncHandGraph(actor, (text) => logToPlatformLog("FormView", `${(this.remoteRefrId ?? 0).toString(16)} ${text}`));
        }
      }
    }

    if (model.equipment && model.appearance && !model.isMyClone && !mounted && !this.eqState.resyncAt
      && this.eqState.lastNumChanges === model.equipment.numChanges) {
      this.keepTorch(actor, loaded, model.equipment);
    }
  }

  // Kills a copy once its 3D is in so the ragdoll finds the ground, and respawns a dead one only when the server revives it; true when respawned
  private applyDeathState(actor: Actor | null, model: FormModel, loaded: boolean): boolean {
    const isDead = !!model.isDead;
    const revived = this.modelWasDead && !isDead;
    this.modelWasDead = isDead;
    if (!actor) {
      return false;
    }
    const emitter = SpApiInteractor.getControllerInstance().emitter;
    if (isDead) {
      this.engineDeadSince = 0;
      if (loaded && !this.killApplied) {
        if (actor.isDead()) {
          this.killApplied = true;
        } else {
          emitter.emit("applyDeathStateEvent", { actor, isDead: true, trigger: "model", serverPos: model.movement?.pos });
        }
      }
      return false;
    }
    this.killApplied = false;
    if (revived) {
      // A copy only ragdolled by the relayed Ragdoll event has no engine death for DeathService to undo, so it is spawned again here
      if (actor.getActorValue("Variable10") < -999) {
        this.respawn("the server revived it while it lay ragdolled");
        return true;
      }
      try {
        emitter.emit("applyDeathStateEvent", { actor, isDead: false, trigger: "model" });
      } catch (e) {
        if (!(e instanceof RespawnNeededError)) {
          throw e;
        }
        this.respawn("the server revived it");
        return true;
      }
      return false;
    }
    // A copy in a paired scene (a killmove, the block) dies in the engine at the strike while the server's verdict comes at the scene's end, so its grace runs from the end
    if (this.engineDeadSince && isCloneMovementSuspended(this.refrId)) {
      this.engineDeadSince = Date.now();
      return false;
    }
    // The server's own verdict on the hit arrives within the grace; past it the engine's kill was its own and the copy follows the server
    if (this.engineDeadSince && Date.now() - this.engineDeadSince >= FormView.engineDeathGraceMs) {
      const killer = this.engineKillerId ? ` by ${this.engineKillerId.toString(16)}` : " with no killer";
      logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} copy ${this.refrId.toString(16)} died in the engine${killer} while the server has it alive, ${this.describeCorpse(actor, model)}, spawned again`);
      this.respawn("it died in the engine");
      return true;
    }
    return false;
  }

  // Where and when the engine's own kill happened: the cause is read from the height against the spawn point and the time since the spawn; the health is the last report in the model, the host's own after its engine death
  private describeCorpse(actor: Actor, model: FormModel): string {
    const pos = ObjectReferenceEx.getPos(actor);
    const player = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
    const sinceSpawn = this.spawnMoment ? `${Date.now() - this.spawnMoment} ms after its spawn` : "before its spawn finished";
    const fromSpawn = this.spawnPoint ? `, ${Math.round(ObjectReferenceEx.getDistanceNoZ(pos, this.spawnPoint))} units from its first spawn point and ${Math.round(pos[2] - this.spawnPoint[2])} in height` : "";
    const health = model.movement ? `, last reported health ${Math.round((model.movement.healthPercentage ?? 0) * 100)}%` : "";
    return `${sinceSpawn} at ${fmtPos(pos)}${fromSpawn}, ${Math.round(ObjectReferenceEx.getDistance(pos, player))} units from the player, 3D ${actor.is3DLoaded()}, hosted here ${isRemoteHostedByMe(this.remoteRefrId ?? 0)}${health}`;
  }

  // From the engine's death events on this copy's local id
  noteEngineDeath(killerId: number): void {
    if (!this.engineDeadSince) {
      this.engineDeadSince = Date.now();
      this.engineKillerId = killerId;
    }
  }

  // The dead flag applyMovement read back with the copy's other cached values
  private takeEngineDeathRead(): void {
    const dead = this.appliedMovement.engineDead;
    if (dead === undefined) {
      return;
    }
    this.appliedMovement.engineDead = undefined;
    if (dead) {
      this.noteEngineDeath(0);
    } else {
      this.engineDeadSince = 0;
    }
  }

  // A deferred kill holds a copy at 0 health instead of killing it, so only the server's isDead kills it; a huge pool keeps local hits from reaching 0 at all
  private static makeImmortal(actor: Actor): void {
    actor.startDeferredKill();
    actor.setActorValue("health", 1000000);
    actor.setActorValue("magicka", 1000000);
  }

  // One head projection serves the tint on-screen trigger and the name tag; the tint also runs on the update after a reset
  private updateTagAndTint(refr: ObjectReference, actor: Actor | null, model: FormModel, loaded: boolean, held: boolean, tagPass: boolean): void {
    let head: number[] | undefined;
    if (model.appearance && actor && !PlayerCharacterDataHolder.isInJumpState()) {
      this.tintDue = false;
      head = headScreenPoint(actor);
      const isOnScreen = head[0] > 0 && head[1] > 0 && head[2] > 0 && head[0] < 1 && head[1] < 1 && head[2] < 1;
      // The carry partner's head sits at the camera for the whole carry, so it is rebuilt only after its tints were reset
      const carryPartner = (held && this.carriedState.onPlayer) || isCarrierCloneId(this.refrId);
      if (isOnScreen !== this.isOnScreen) {
        this.isOnScreen = isOnScreen;
        // A dead copy's head stays as it is: the engine's face morph job can read a head rebuilt under it (crash report 2026-10-02)
        if (isOnScreen && !actor.isDead() && Date.now() - this.lastNiNodeUpdateMs >= FormView.niNodeUpdateMinIntervalMs && !(carryPartner && this.lastNiNodeUpdateMs)) {
          this.lastNiNodeUpdateMs = Date.now();
          actor.queueNiNodeUpdate();
          // The rebuilt 3D drops effect shaders
          if (this.adminShaderOn) {
            this.adminShaderReplayAt = this.lastNiNodeUpdateMs + FormView.adminShaderReplayDelayMs;
          }
          if (this.afterlifeShaderId) {
            this.afterlifeShaderReplayAt = this.lastNiNodeUpdateMs + FormView.adminShaderReplayDelayMs;
          }
        }
      }
    }
    if (!tagPass) {
      return;
    }

    const identifies = !!FormView.adminTagOf(model);
    const showTag = FormView.isDisplayingNicknames || FormView.isSpeaking(this.getRemoteRefrId()) || identifies;
    // An admin tag shows through sneaking and invisibility
    if (!showTag || !loaded || !model.appearance?.name || FormView.adminViewOf(model) === "hidden"
      || (!identifies && (model.movement?.isSneaking || this.isInvisible(actor)))) {
      this.removeNickname();
      return;
    }
    const player = Game.getPlayer()!;
    if (player.getDistance(refr) > MAX_TAG_DISTANCE || (head ?? headScreenPoint(refr))[2] <= 0 || !player.hasLOS(refr)) {
      this.removeNickname();
      return;
    }
    this.showNickname(refr, model);
  }

  // Created once while shown; a new name, colour or id line is written into the shown texts
  private showNickname(refr: ObjectReference, model: FormModel): void {
    const name = this.tagName(refr, model);
    const color = this.tagColor(model);
    if (!this.textNameId) {
      this.textNameId = createHeadText(this.refrId, name, color, 0.5, TAG_HEAD_OFFSET);
    } else {
      if (name !== this.shownTagName) setTextString(this.textNameId, name);
      if (color !== this.shownTagColor) setTextColor(this.textNameId, color);
    }
    this.shownTagName = name;
    this.shownTagColor = color;
    // The server's actor id (a player's character id, a PK body's own id) on a second line under the name
    const serverId = FormView.showsActorIdLine() ? shortRemoteId(this.remoteRefrId ?? 0) : 0;
    if (serverId && !this.textActorIdId) {
      const idText = serverId.toString(16).toUpperCase().padStart(8, "0");
      this.textActorIdId = createHeadText(this.refrId, idText, [1, 1, 1, 0.6], 0.4, TAG_HEAD_OFFSET, FormView.actorIdLineOffset);
    } else if (!serverId && this.textActorIdId) {
      destroyText(this.textActorIdId);
      this.textActorIdId = undefined;
    }
  }

  // Real name once introduced to the local player, else "Stranger"; Show Title puts the faction title in front of it, and a talking player gets the VOIP glyph (the glyph alone while names are hidden)
  private tagName(refr: ObjectReference, model: FormModel): string {
    const remoteId = this.getRemoteRefrId();
    const voip = FormView.isSpeaking(remoteId) ? `${FormView.voipGlyph} ` : "";
    // An admin acting as staff shows the account name in place of the character, introductions and the chat toggle aside
    const adminTag = FormView.adminTagOf(model);
    if (adminTag) return voip + adminTag.n;
    if (!FormView.isDisplayingNicknames) return FormView.voipGlyph;
    if (!knowsCharacter(remoteId)) return `${voip}Stranger`;
    const name = refr.getDisplayName();
    const title = (model as Record<string, unknown>)["ff_factionTitle"];
    return voip + (typeof title === "string" && title ? `${title} ${name}` : name);
  }

  // The missing pieces are equipped without the strip that races the skeleton; a player copy's head is rebuilt through the tint pass so it keeps its own tints
  private verifyCopyOutfit(ac: Actor, eq: Equipment, isPlayerCopy: boolean): void {
    const missing = getMissingWorn(ac, eq);
    if (missing.length === 0) return;
    const total = countWorn(eq.inv);
    logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} copy outfit after settle: ${total - missing.length} of ${total} worn, re-dressing ${missing.map((e) => e.baseId.toString(16)).join("/")}`);
    equipEntries(ac, missing);
    if (isPlayerCopy) this.redrawTints();
    else if (!ac.isDead()) ac.queueNiNodeUpdate();
  }

  // The engine's torch check for NPCs unequips a copy's torch where it is not dark, so a player copy's held torch is equipped again
  private keepTorch(ac: Actor | null, loaded: boolean, eq: Equipment): void {
    const t = this.torchState;
    if (t.numChanges !== eq.numChanges) {
      t.numChanges = eq.numChanges;
      t.entry = getWornLight(eq);
      t.tries = 0;
      t.heldSince = 0;
      t.logged = false;
    }
    const now = Date.now();
    if (!t.entry || now < t.checkAt) return;
    t.checkAt = now + FormView.torchCheckMs;
    const form = Game.getFormEx(t.entry.baseId);
    // On a seat or a bed the engine puts a torch away every frame
    if (!ac || !form || !loaded || ac.isDead() || ac.getSitState() !== 0 || ac.getSleepState() !== 0 || isBadMenuShown()) return;
    const drawn = ac.isWeaponDrawn();
    if (drawn !== t.drawn) {
      t.drawn = drawn;
      t.tries = 0;
      t.logged = false;
    }
    const state = () => `weapon drawn ${drawn}, light level ${Math.round(ac.getLightLevel())}, left hand graph type ${ac.getAnimationVariableInt("iLeftHandType")}`;
    const id = `${this.getRemoteRefrId().toString(16)} torch ${t.entry.baseId.toString(16)}`;
    if (ac.isEquipped(form)) {
      if (!t.heldSince) t.heldSince = now;
      else if (now - t.heldSince >= FormView.torchSteadyMs) t.tries = 0;
      if (!t.logged) {
        t.logged = true;
        logToPlatformLog("FormView", `${id} is in the copy's hand: ${state()}`);
      }
      return;
    }
    t.heldSince = 0;
    if (t.tries >= FormView.torchMaxTries) return;
    t.tries++;
    if (ac.getItemCount(form) <= 0) ac.addItem(form, 1, true);
    equipEntries(ac, [t.entry]);
    const last = t.tries === FormView.torchMaxTries ? `, the last until it stays ${FormView.torchSteadyMs / 1000} s, the weapon is drawn or sheathed or new equipment arrives` : "";
    logToPlatformLog("FormView", `${id} was off the copy and is equipped again, try ${t.tries} of ${FormView.torchMaxTries}${last}: ${state()}`);
  }

  // The shared arrays double as identity keys for the change check
  private tagColor(model: FormModel): number[] {
    const tier = FormView.adminTagOf(model)?.t;
    return (tier && TIER_TAG_COLORS[tier]) || DEFAULT_TAG_COLOR;
  }

  // A SkyrimPlatform object lasts one update, so only the keyword's id is kept
  private isInvisible(actor: Actor | null): boolean {
    if (!actor) {
      return false;
    }
    if (magicInvisibilityId === undefined) {
      magicInvisibilityId = Keyword.getKeyword("MagicInvisibility")?.getFormID() ?? 0;
    }
    const keyword = magicInvisibilityId ? Keyword.from(Game.getFormEx(magicInvisibilityId)) : null;
    return !!keyword && actor.hasMagicEffectWithKeyword(keyword);
  }

  // A copy the engine runs here drops the keep-offset of its last applied packet; own companions and steered pets keep the one their service gives them
  private releaseKeepOffset(actor: Actor | null): void {
    this.appliedMovement.turn = undefined;
    if (keepsOwnOffset(this.remoteRefrId)) {
      this.offsetCleared = false;
    } else if (!this.offsetCleared) {
      actor?.clearKeepOffsetFromActor();
      this.offsetCleared = true;
    }
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
  private applyAdminView(actor: Actor | null, loaded: boolean, model: FormModel): void {
    const view = FormView.adminViewOf(model);
    if (view === "visible" && this.adminView === "visible") {
      return;
    }
    if (!actor || !loaded) {
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
        logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} admin view ${view}`);
      }
      actor.setAlpha(view === "hidden" ? 0 : view === "ghost" ? adminGhostAlpha : 1, false);
      this.adminView = view;
      this.lastAdminHideApply = now;
    }
  }

  // A fallen character's realm look rides the neighbor-visible ff_afterlife prop; the alpha yields to a hidden or ghost admin view
  private applyAfterlifeView(actor: Actor | null, loaded: boolean, model: FormModel): void {
    const { shaderId, alpha } = afterlifeLookOf(model as Record<string, unknown>);
    if (!shaderId && !this.afterlifeShaderId) {
      return;
    }
    if (!actor || !loaded) {
      this.afterlifeShaderId = 0;
      return;
    }
    const now = Date.now();
    const replay = this.afterlifeShaderReplayAt > 0 && now >= this.afterlifeShaderReplayAt;
    if (shaderId === this.afterlifeShaderId && !replay) {
      return;
    }
    if (this.afterlifeShaderId && this.afterlifeShaderId !== shaderId) {
      setAdminGhostShader(actor, false, this.afterlifeShaderId);
    }
    const ownAlpha = this.adminView === "visible" ? (shaderId ? alpha : 1) : undefined;
    if (shaderId) {
      setAdminGhostShader(actor, true, shaderId, ownAlpha);
    } else if (ownAlpha !== undefined) {
      actor.setAlpha(ownAlpha, false);
    }
    if (shaderId !== this.afterlifeShaderId) {
      logToPlatformLog("FormView", `${this.getRemoteRefrId().toString(16)} afterlife look ${shaderId ? shaderId.toString(16) : "off"}`);
    }
    this.afterlifeShaderId = shaderId;
    this.afterlifeShaderReplayAt = 0;
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

  // True until the copy's 3D has stayed loaded for copySettleMs
  private isSettling(loaded: boolean): boolean {
    if (!loaded) {
      this.loaded3DMoment = 0;
      return true;
    }
    if (!this.loaded3DMoment) {
      this.loaded3DMoment = Date.now();
      this.redrawTints();
    }
    return Date.now() - this.loaded3DMoment < FormView.copySettleMs;
  }

  // Every copy's base holds form id 7, so a head the engine rebuilds on its own (3D reload, helmet swap) carries the local player's tints until the on-screen check queues the copy's own
  private redrawTints(): void {
    this.isOnScreen = false;
    this.lastNiNodeUpdateMs = 0;
    this.tintDue = true;
  }

  private getDefaultEquipState() {
    return { lastNumChanges: 0, lastEqMoment: 0, resyncAt: 0, verifyNumChanges: -1 };
  };

  private getDefaultAppearanceState() {
    return { lastNumChanges: 0, appearance: null as (null | Appearance) };
  };

  private getDefaultAnimState() {
    return { lastNumChanges: 0, useAnimOverrides: true };
  };

  // What the engine was last given; undefined until the first apply
  private getDefaultObjectState() {
    return { open: undefined as boolean | undefined, harvested: undefined as boolean | undefined, carriedAway: undefined as boolean | undefined, disabled: undefined as boolean | undefined, openCheck: false, openReapplyAt: 0, decor: undefined as unknown };
  };

  private tryHostIfNeed(ac: Actor, remoteId: number, model: FormModel) {
    // Players and PK bodies carry an appearance and are never hosted by a claim
    if (model.appearance) {
      return false;
    }
    const last = lastTryHost[remoteId];
    if (!last || Date.now() - last >= 1000) {
      lastTryHost[remoteId] = Date.now();

      if (ObjectReferenceEx.getWorldOrCell(ac) === PlayerCharacterDataHolder.getWorldOrCell()) {
        tryHost(remoteId);
        return true;
      }
    }
    return false;
  };

  getLocalRefrId(): number {
    return this.localRefrId;
  }

  getRemoteRefrId(): number {
    return this.remoteRefrId as number;
  }

  private get refrId(): number {
    return this.localRefrId;
  }

  // Re-indexed on every change so id lookups later in the same update see the new copy
  private set refrId(id: number) {
    const previous = this.localRefrId;
    if (id === previous) {
      return;
    }
    this.localRefrId = id;
    this.onLocalIdChange?.(this, previous);
  }

  private localRefrId = 0;
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
  private isOnScreen = false;
  // A tint reset is checked on the next update instead of the next pass
  private tintDue = false;
  private lastNiNodeUpdateMs = 0;
  // A head at the camera (a carried player inside their carrier) flickers on and off screen; each rebuild is a hitch
  private static readonly niNodeUpdateMinIntervalMs = 5000;
  private lastWorldOrCell = 0;
  private spawnMoment = 0;
  // Why the next placement happens, for its log line
  private spawnReason = "fresh";
  // The server position of the view's first NPC copy placement, the spawn spot when this client saw the spawn
  private spawnPoint: NiPoint3 | undefined;
  private loaded3DMoment = 0;
  private was3DLoaded = false;
  private objectState = this.getDefaultObjectState();
  // null until the base was checked
  private checkedModelBaseId: number | undefined | null = null;
  private checkedAppearanceBaseId = 0;
  private static readonly copySettleMs = 1000;
  // Senders report at least once a second, so this is three missed keepalives
  private static readonly movementStallMs = 3000;
  // A door mid-swing or with its graph still loading can drop an apply, so each one is repeated after about a swing
  private static readonly openReapplyMs = 2000;
  private static readonly handGraphCheckDelayMs = 1500;
  private torchState = { numChanges: -1, entry: undefined as Entry | undefined, drawn: false, checkAt: 0, tries: 0, heldSince: 0, logged: false };
  private static readonly torchCheckMs = 2000;
  private static readonly torchMaxTries = 3;
  private static readonly torchSteadyMs = 30000;
  // Known from the first update of a ready copy
  private isActor: boolean | undefined = undefined;
  private offsetCleared = false;
  private appliedMovement = makeAppliedMovement();
  private mountState = makeMountState();
  private carriedState = makeCarriedViewState();
  private localImmortal = false;
  // The model's isDead at the last apply, so a revive is acted on once
  private modelWasDead = false;
  // This copy read dead after the server's death, so it is not read again until it is respawned or revived
  private killApplied = false;
  // When the engine reported this copy dead while the model said alive, 0 otherwise
  private engineDeadSince = 0;
  private engineKillerId = 0;
  // Longer than a hit's round trip, so a death the server confirms is not undone first
  private static readonly engineDeathGraceMs = 1500;
  private hostilityApplied = false;
  private hostileFlagSeen: unknown = undefined;
  private aggressionBeforeRaise: number | undefined = undefined;
  private adminView: AdminView = "visible";
  private adminShaderOn = false;
  private adminShaderReplayAt = 0;
  private adminGhostFlag = false;
  private lastAdminHideApply = 0;
  private afterlifeShaderId = 0;
  private afterlifeShaderReplayAt = 0;
  private textNameId: number | undefined = undefined;
  private textActorIdId: number | undefined = undefined;
  private shownTagName = "";
  private shownTagColor: number[] = DEFAULT_TAG_COLOR;

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

  private static adminTagOf(model: FormModel): AdminTag | undefined {
    const tag = (model as Record<string, unknown>)["ff_adminTag"] as Record<string, unknown> | null | undefined;
    if (!tag || typeof tag !== "object" || typeof tag["n"] !== "string" || !tag["n"] || typeof tag["t"] !== "string") return undefined;
    return { n: tag["n"], t: tag["t"] };
  }

  // The id line never shows without the name above it, and only to staff since a character's id would follow a mask or a Stranger
  private static showsActorIdLine(): boolean {
    return FormView.isDisplayingNicknames && FormView.isDisplayingActorIds && FormView.viewerIsAdmin();
  }
}
