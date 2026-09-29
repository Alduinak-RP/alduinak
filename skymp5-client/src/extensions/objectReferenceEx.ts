import * as sp from "skyrimPlatform";
import { Flora, Form, FormType, ObjectReference } from "skyrimPlatform";
import { NiPoint3 } from "../sync/movement";
import { FormTypeEx } from "./formTypeEx";

// BlackFallsBarrow02, door isn't opening via SetOpen so we're hacking it.
// Not blocking activation & asking parent to activate until will be in the correct state
// See also modelApplyUtils.ts
const caveGSecretDoor01 = 0x6f703;

export class ObjectReferenceEx {
  static getWorldOrCell(self: ObjectReference): number {
    let world = self.getWorldSpace();
    if (world) {
      return world.getFormID();
    }

    let cell = self.getParentCell();
    if (cell) {
      return cell.getFormID();
    }

    return 0;
  }

  static getPos(self: ObjectReference): NiPoint3 {
    return [self.getPositionX(), self.getPositionY(), self.getPositionZ()];
  };

  static getDistance(a: NiPoint3, b: NiPoint3) {
    const deltaX = a[0] - b[0];
    const deltaY = a[1] - b[1];
    const deltaZ = a[2] - b[2];
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
  };

  static getDistanceNoZ(a: NiPoint3, b: NiPoint3) {
    const deltaX = a[0] - b[0];
    const deltaY = a[1] - b[1];
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  };

  // Coin purses: flora whose produce is a leveled gold list (SKSE getIngredient always returns the produce)
  static isLeveledFlora(base: Form): boolean {
    return base.getType() === FormType.Flora
      && Flora.from(base)?.getIngredient()?.getType() === FormType.LeveledItem;
  }

  // Sent by the server's UntouchableSystem on connect
  static setUntouchableBaseIds(ids: number[]): void {
    ObjectReferenceEx.untouchableBaseIds = new Set(ids.map((id) => id >>> 0));
  }

  static isUntouchable(base: Form): boolean {
    return ObjectReferenceEx.untouchableBaseIds.has(base.getFormID() >>> 0)
      || ObjectReferenceEx.isLeveledFlora(base);
  }

  private static untouchableBaseIds = new Set<number>();

  // Engine activation stays off for everything the server processes; the SP activate event still fires
  static wantsActivationBlock(base: Form): boolean {
    const t = base.getType();
    // Flora waits for the server too, so a refused harvest never happens locally; an approved one arrives as activate(player, true)
    return t === FormType.Furniture
      || t === FormType.Flora
      || t === FormType.Tree
      || t === FormType.Activator
      || t === FormType.Container
      || FormTypeEx.isItem(t)
      || t === FormType.NPC
      || (t === FormType.Door && base.getFormID() !== caveGSecretDoor01)
      || ObjectReferenceEx.isUntouchable(base);
  }

  // SkyrimPlatform keeps runtime items dynamic, as engine drops must stay, unless they are the client's copies of server items
  static markServerCopy(refrId: number, serverCopy: boolean): void {
    const native = (sp as any).markServerCopy;
    if (typeof native === "function") native(refrId, serverCopy);
  }

  // Havok objects are keyframed natively (SkyrimPlatform StaticFreeze.cpp), server copies by SpawnProcess too
  static dealWithRef(self: ObjectReference, base: Form): void {
    self.blockActivation(ObjectReferenceEx.wantsActivationBlock(base));

    if (self.isLocked()) {
      self.lock(false, false);
    }
  }
}
