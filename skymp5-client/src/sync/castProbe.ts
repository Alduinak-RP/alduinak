import { Actor, EquippedItemType, Game, Utility } from "skyrimPlatform";
import { logToPlatformLog } from "../logging";

const PROBE_GAP_MS = 10000;
// The graph is read again this long after the cast reached the copy
const PROBE_AFTER_S = 0.6;
const nextProbeAt: Record<string, number> = {};

const bit = (value: boolean): number => (value ? 1 : 0);

// GetEquippedItemType's hands are 0 left and 1 right
const handTypes = (ac: Actor): number[] => [ac.getEquippedItemType(0), ac.getEquippedItemType(1)];

// The graph variables a cast sets: the engine's request, and the graph's own casting state
export const describeCastGraph = (ac: Actor): string => {
  const read = (name: string) => bit(ac.getAnimationVariableBool(name));
  return `bWantCast ${read("bWantCastLeft")}/${read("bWantCastRight")}, IsCasting ${read("IsCastingLeft")}/${read("IsCastingRight")}/${read("IsCastingDual")}`;
};

export const describeCastHands = (ac: Actor): string => `drawn ${ac.isWeaponDrawn()}, hand types ${handTypes(ac).join("/")}`;

// What Actor::GetAimAngle reads when the actor's graph aims at a target; without one it reads the X angle
export const describeGraphAim = (ac: Actor): string =>
  `graph bAimActive ${ac.getAnimationVariableBool("bAimActive")}, AimPitchCurrent ${ac.getAnimationVariableFloat("AimPitchCurrent").toFixed(2)}`;

export const describeAim = (ac: Actor): string => `angle X ${Math.round(ac.getAngleX())}, ${describeGraphAim(ac)}`;

// Diagnostic, at most one line per kind every 10 s: a copy's hands and graph when a cast reaches it and shortly after
export const probeCopyCast = (kind: string, ac: Actor, what: string, staffOnly = false): void => {
  const now = Date.now();
  if (now < (nextProbeAt[kind] ?? 0)) {
    return;
  }
  if (staffOnly && !handTypes(ac).includes(EquippedItemType.Staff)) {
    return;
  }
  nextProbeAt[kind] = now + PROBE_GAP_MS;
  const id = ac.getFormID();
  const before = `${describeCastHands(ac)}, ${describeCastGraph(ac)}, ${describeAim(ac)}`;
  Utility.wait(PROBE_AFTER_S).then(() => {
    const copy = Actor.from(Game.getFormEx(id));
    const after = copy ? `${describeCastHands(copy)}, ${describeCastGraph(copy)}, ${describeAim(copy)}` : "copy gone";
    logToPlatformLog("CastProbe", `${what} on copy ${id.toString(16)}: ${before}; ${PROBE_AFTER_S} s later: ${after}`);
  });
};
