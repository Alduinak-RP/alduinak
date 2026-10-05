import { Sp } from "./clientListener";

export const FIRST_PERSON_CAMERA = 0;
// Set by the vanilla graph while a furniture or interaction idle (a kneel, a sit, the hoe) moves the actor
export const ANIM_DRIVEN_VAR = "bAnimationDriven";

const holders = new Set<string>();

const lockPov = (sp: Sp): void => {
  if (sp.Game.getCameraState() === FIRST_PERSON_CAMERA) sp.Game.forceThirdPerson();
  // Arguments: movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType
  if (sp.Game.isCamSwitchControlsEnabled()) sp.Game.disablePlayerControls(false, false, true, false, false, false, false, false, 0);
};

// An animation-driven idle moves the player without collision once the camera is first person, so a pose holds third person and switches the POV key off; must run on update
export const holdPoseCamera = (sp: Sp, holder: string): void => {
  holders.add(holder);
  lockPov(sp);
};

// The POV key comes back with the last holder; other services switch controls on again, so a hold that remains is put back
export const releasePoseCamera = (sp: Sp, holder: string): void => {
  const held = holders.delete(holder);
  if (holders.size) lockPov(sp);
  else if (held) sp.Game.enablePlayerControls(false, false, true, false, false, false, false, false, 0);
};

// Must run on update
export const assertPoseCamera = (sp: Sp): void => {
  if (holders.size) lockPov(sp);
};

// "emote+restraint", "" while no pose holds the camera
export const poseCameraHolders = (): string => Array.from(holders).join("+");
