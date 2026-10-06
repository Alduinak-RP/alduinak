import { ObjectReference, Actor, Game, FormType, TextureSet, NetImmerse } from "skyrimPlatform";
import { Inventory, applyInventory } from "../sync/inventory";
import { logError, logTrace } from "../logging";
import { SetNodeScaleEntry, SetNodeTextureSetEntry } from "src/services/messages/createActorMessage";

const MASTER_LOCK_LEVEL = 100;
// Refs a claim named, given back their base's name once no claim names them
const decorNamed = new Set<number>();

// For 0xff000000+ used from FormView
// For objects from master files used directly from remoteServer.ts
export class ModelApplyUtils {
  static applyModelInventory(refr: ObjectReference, inventory: Inventory) {
    applyInventory(refr, inventory, false, true);
  }

  // Open (1) or opening (2) in the engine's open state
  static isOpenOrOpening(refr: ObjectReference): boolean {
    const state = refr.getOpenState();
    return state === 1 || state === 2;
  }

  static applyModelIsOpen(refr: ObjectReference, isOpen: boolean) {
    refr.setOpen(isOpen);

    const caveGSecretDoor01 = 0x6f703;

    // TODO: add more activators to support more cells
    const parentActivatorId = 0x460ca;

    if (refr.getBaseObject()?.getFormID() === caveGSecretDoor01) {
      const openOrOpening = ModelApplyUtils.isOpenOrOpening(refr);
      if (openOrOpening) {
        if (!isOpen) {
          refr.activate(ObjectReference.from(Game.getForm(parentActivatorId)), false);
        }
      }
      if (!openOrOpening) {
        if (isOpen) {
          refr.activate(ObjectReference.from(Game.getForm(parentActivatorId)), false);
        }
      }
    }
  }

  // Housing's ff_decor {name, locked} on a claimed door or container; any other lock is cleared, since the server decides every activation
  static applyModelDecor(refr: ObjectReference, decor: unknown): void {
    const d: Record<string, unknown> = decor && typeof decor === "object" ? decor as Record<string, unknown> : {};
    if (d["locked"] === true) {
      if (!refr.isLocked() || refr.getLockLevel() !== MASTER_LOCK_LEVEL) {
        refr.setLockLevel(MASTER_LOCK_LEVEL);
        refr.lock(true, false);
      }
    } else if (refr.isLocked()) {
      refr.lock(false, false);
    }
    const name = d["name"];
    if (typeof name === "string" && name) {
      refr.setDisplayName(name, true);
      decorNamed.add(refr.getFormID());
    } else if (decorNamed.size && decorNamed.delete(refr.getFormID())) {
      refr.setDisplayName(refr.getBaseObject()?.getName() || "", true);
    }
  }

  static applyModelIsDisabled(refr: ObjectReference, disabled: boolean): void {
    const wasDisabled: boolean = refr.isDisabled();
    if (wasDisabled == disabled) {
      return;
    }

    if (disabled) {
      refr.disable(false);
    } else {
      refr.enable(true);
    }
  }

  static isFloraOrTree(refr: ObjectReference): boolean {
    const t = refr.getBaseObject()?.getType();
    return t === FormType.Tree || t === FormType.Flora;
  }

  // The harvested look of a plant, whose 3D refreshes through a disable; a hidden plant is left disabled
  static applyModelIsHarvested(refr: ObjectReference, isHarvested: boolean, hidden = false) {
    if (!ModelApplyUtils.isFloraOrTree(refr)) return;
    if (isHarvested == refr.isHarvested()) return;
    let ac: Actor | null = null;
    if (isHarvested) {
      for (let i = 0; i < 20; ++i) {
        ac = Game.findRandomActor(refr.getPositionX(), refr.getPositionY(), refr.getPositionZ(), 10000);
        if (ac && ac.getFormID() !== 0x14) break;
      }
    }
    if (isHarvested && ac && ac.getFormID() !== 0x14) {
      refr.activate(ac, true);
      return;
    }
    refr.setHarvested(isHarvested);
    const id = refr.getFormID();
    refr.disable(false).then(() => {
      const restoredRefr = ObjectReference.from(Game.getFormEx(id));
      if (restoredRefr && !hidden) restoredRefr.enable(false);
    });
  }

  // One enabled state from every server flag that hides a ref (disabled, carried by another player, an item taken); a plant shows its harvested look instead
  static applyModelVisibility(refr: ObjectReference, harvested: boolean, hidden: boolean): void {
    if (ModelApplyUtils.isFloraOrTree(refr)) ModelApplyUtils.applyModelIsHarvested(refr, harvested, hidden);
    else hidden = hidden || harvested;
    ModelApplyUtils.applyModelIsDisabled(refr, hidden);
  }

  static applyModelNodeTextureSet(refr: ObjectReference, setNodeTextureSet?: SetNodeTextureSetEntry[]) {
    if (setNodeTextureSet) {
      setNodeTextureSet.forEach(element => {
        const firstPerson = false;

        const textureSet = TextureSet.from(Game.getFormEx(element.textureSetId));
        if (textureSet !== null) {
          NetImmerse.setNodeTextureSet(refr, element.nodeName, textureSet, firstPerson);
          logTrace("ModelApplyUtils", refr.getFormID().toString(16), `Applied texture set`, element.textureSetId.toString(16), `to`, element.nodeName);
        } else {
          logError("ModelApplyUtils", refr.getFormID().toString(16), `Failed to apply texture set`, element.textureSetId.toString(16), `to`, element.nodeName);
        }
      });
    }
  }

  static applyModelNodeScale(refr: ObjectReference, setNodeScale?: SetNodeScaleEntry[]) {
    if (setNodeScale) {
      setNodeScale.forEach(element => {
        const firstPerson = false;
        NetImmerse.setNodeScale(refr, element.nodeName, element.scale, firstPerson);
        logTrace("ModelApplyUtils", refr.getFormID().toString(16), `Applied node scale`, element.scale, `to`, element.nodeName);
      });
    }
  }
}
