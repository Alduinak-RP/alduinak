import { Flora, Form, FormType, MotionType, ObjectReference } from "skyrimPlatform";
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

  // Engine activation stays off for everything the server processes; the SP activate event still fires
  static wantsActivationBlock(base: Form): boolean {
    const t = base.getType();
    // You can also block for t === FormType.Flora || t === FormType.Tree, but I don't think it's necessary.
    return t === FormType.Furniture
      || t === FormType.Activator
      || t === FormType.Container
      || FormTypeEx.isItem(t)
      || t === FormType.NPC
      || (t === FormType.Door && base.getFormID() !== caveGSecretDoor01)
      || ObjectReferenceEx.isLeveledFlora(base);
  }

  static dealWithRef(self: ObjectReference, base: Form): void {
    const t = base.getType();
    const isItem = FormTypeEx.isItem(t);

    self.blockActivation(ObjectReferenceEx.wantsActivationBlock(base));

    if (self.isLocked()) {
      self.lock(false, false);
    }

    if (isItem) {
      self.setMotionType(MotionType.Keyframed, false);
    }

    // https://github.com/skyrim-multiplayer/issue-tracker/issues/36
    // Coin purses are flora with havok, so every flora is frozen, not only the ingredient kind
    if (t === FormType.Flora) {
      self.setMotionType(MotionType.Keyframed, false);
    }
  }
}
