import { Movement } from "../sync/movement";
import { Animation } from "../sync/animation";
import { Appearance } from "../sync/appearance";
import { Equipment } from "../sync/equipment";
import { Inventory } from "../sync/inventory";
import { CreateActorMessageMainProps, CreateActorMessageAdditionalProps } from "src/services/messages/createActorMessage";

// Own properties (not inherited) are being assigned locally
export interface FormModel extends CreateActorMessageAdditionalProps, CreateActorMessageMainProps{
  idx?: number;
  movement?: Movement;
  numMovementChanges?: number;
  numAppearanceChanges?: number;
  isMyClone?: boolean;
  // Local time until which a PK body stands in for this player's own dead copy
  bodyLeftUntil?: number;
}

export interface WorldModel {
  forms: Array<FormModel | undefined>;
  playerCharacterFormIdx: number;
  playerCharacterRefrId: number;
}
