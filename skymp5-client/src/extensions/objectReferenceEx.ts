import { Actor, ObjectReference } from "skyrimPlatform";
import { NiPoint3 } from "../sync/movement";

export class ObjectReferenceEx {
  // For a reference an engine event names: Actor.from throws on one whose form type has no Papyrus type, a placed hazard or projectile
  static asActor(self: ObjectReference | null | undefined): Actor | null {
    if (!self) {
      return null;
    }
    try {
      return Actor.from(self);
    } catch {
      return null;
    }
  }

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
}
