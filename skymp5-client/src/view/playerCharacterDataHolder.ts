import { Game, ObjectReference } from "skyrimPlatform";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { PlayerWorldOrCellChangedEvent } from "../services/events/playerWorldOrCellChangedEvent";

export class PlayerCharacterDataHolder {
  // Returns the change when the player stands in another nonzero world or cell than at the last change
  static updateData(): PlayerWorldOrCellChangedEvent | undefined {
    const player = Game.getPlayer();
    if (!player) {
      return undefined;
    }

    this.inJumpState = player.getAnimationVariableBool("bInJumpState");
    this.worldOrCell = ObjectReferenceEx.getWorldOrCell(player);

    if (!this.worldOrCell || this.worldOrCell === this.lastWorldOrCell) {
      return undefined;
    }
    const previous = this.lastWorldOrCell;
    this.lastWorldOrCell = this.worldOrCell;
    return { worldOrCell: this.worldOrCell, previous, interior: !!player.getParentCell()?.isInterior() };
  }

  static setCrosshairRef(ref: ObjectReference | null | undefined) {
    this.crosshairRefId = ref ? ref.getFormID() : 0;
  }

  // crosshairRefChanged is dropped when its ref is gone by delivery, and a freed FF id goes to the next copy
  static forgetCrosshairRef(refrId: number) {
    if (this.crosshairRefId === refrId) {
      this.crosshairRefId = 0;
    }
  }

  static isInJumpState() {
    return this.inJumpState;
  }

  static getWorldOrCell() {
    return this.worldOrCell;
  }

  static getCrosshairRefId() {
    return this.crosshairRefId;
  }

  private static inJumpState = false;
  private static worldOrCell = 0;
  private static lastWorldOrCell = 0;
  private static crosshairRefId = 0;
}
