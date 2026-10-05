import {
  ObjectReference,
  Actor,
  Game,
  TESModPlatform,
  Debug
} from "skyrimPlatform";
import { RespawnNeededError } from "../lib/errors";
import { Movement, RunMode, AnimationVariables, Transform, NiPoint3 } from "./movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { SpApiInteractor } from "../services/spApiInteractor";
import { isInSitPose } from "./animation";

const sqr = (x: number) => x * x;

export const normalizeAngle = (deg: number): number => ((deg % 360) + 540) % 360 - 180;

export const wrappedAngleDiff = (a: number, b: number): number => Math.abs(normalizeAngle(a - b));

// A standing actor this far above or below the reported height sank or floated locally
const standingMaxDeltaZ = 64;
// Cached values and a resting copy go back to the engine this often, which corrects drift from the copy's own AI or a push
const engineRecheckMs = 2000;
// Smoothed health stops once the copy is this close to the reported value
const healthConvergedDelta = 0.01;

// What the applies left on one copy, so an unchanged value is neither read nor sent again
export interface AppliedMovement {
  // Values the engine already had at the last read; undefined is read again
  sprinting?: boolean;
  blocking?: boolean;
  sneaking?: boolean;
  weapDrawn?: boolean;
  // 0 while head tracking is off
  lookAtId?: number;
  // The reported health the copy converged to
  health?: number;
  // Cached values hold until then; 0 reads the engine at the next apply
  recheckAt: number;
  // The packet the copy rests at: standing on its spot, facing its way, with nothing left to apply
  rest?: Movement;
}

export const makeAppliedMovement = (): AppliedMovement => ({ recheckAt: 0 });

// A riding clone is carried by its horse, and a horse being mounted is left to the engine: no translation, offset or locomotion events reach either
// ownOffset leaves the keep-offset to the service that drives this copy (own companions, steered pets)
export const applyMovement = (refr: ObjectReference, m: Movement, isMyClone?: boolean, mounted?: boolean, ownOffset?: boolean, state: AppliedMovement = makeAppliedMovement()): void => {
  const loaded = refr.is3DLoaded();
  teleportIfNeed(refr, m, loaded);

  const now = Date.now();
  const trusted = loaded && !mounted && now < state.recheckAt;
  if (!trusted) {
    state.recheckAt = loaded && !mounted ? now + engineRecheckMs : 0;
  }

  // A repeated packet changes nothing on a copy resting at it
  if (trusted && state.rest && isSamePacket(state.rest, m) && isNearStandingSpot(ObjectReferenceEx.getPos(refr), m.pos)) {
    return;
  }
  state.rest = undefined;

  let settled = false;
  if (!mounted) {
    // Z axis isn't useful here
    const acX = refr.getPositionX();
    const acY = refr.getPositionY();
    const lagUnitsNoZ = Math.round(Math.sqrt(sqr(m.pos[0] - acX) + sqr(m.pos[1] - acY)));

    if (isMyClone === true) {
      SpApiInteractor.getControllerInstance().emitter.emit("newLocalLagValueCalculated", { lagUnitsNoZ });
    }

    settled = translateTo(refr, m);
  }

  const ac = Actor.from(refr);
  if (!ac) {
    return;
  }

  applyHeadTracking(ac, m, state, trusted);

  let faces = false;
  if (!mounted) {
    if (!ownOffset) {
      faces = keepOffsetFromActor(ac, m);
    }

    const sprinting = m.runMode === "Sprinting";
    if (!trusted || state.sprinting !== sprinting) {
      state.sprinting = applySprinting(ac, sprinting) ? sprinting : undefined;
    }
    if (!trusted || state.blocking !== m.isBlocking) {
      state.blocking = applyBlocking(ac, m) ? m.isBlocking : undefined;
    }
    if (!trusted || state.sneaking !== m.isSneaking) {
      state.sneaking = applySneaking(ac, m.isSneaking) ? m.isSneaking : undefined;
    }
    if (!trusted || state.weapDrawn !== m.isWeapDrawn) {
      state.weapDrawn = applyWeapDrawn(ac, m.isWeapDrawn) ? m.isWeapDrawn : undefined;
    }
  }
  if (!trusted || state.health !== m.healthPercentage) {
    state.health = applyHealthPercentage(ac, m.healthPercentage) ? m.healthPercentage : undefined;
  }

  if (settled && faces && state.sprinting !== undefined && state.blocking !== undefined && state.sneaking !== undefined
    && state.weapDrawn !== undefined && state.health !== undefined) {
    state.rest = { ...m, pos: [m.pos[0], m.pos[1], m.pos[2]], rot: [m.rot[0], m.rot[1], m.rot[2]] };
  }
};

const isSamePoint = (a: NiPoint3 | undefined, b: NiPoint3 | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

// Within a unit of the same spot, with the same facing, flags, health and look target
const isSamePacket = (a: Movement, b: Movement): boolean =>
  a.worldOrCell === b.worldOrCell && ObjectReferenceEx.getDistance(a.pos, b.pos) <= 1 && isSamePoint(a.rot, b.rot)
  && a.runMode === b.runMode && a.isInJumpState === b.isInJumpState && a.isSneaking === b.isSneaking
  && a.isBlocking === b.isBlocking && a.isWeapDrawn === b.isWeapDrawn
  && a.healthPercentage === b.healthPercentage && isSamePoint(a.lookAt, b.lookAt);

// A standing copy this close to the reported spot needs no translation
const isNearStandingSpot = (pos: NiPoint3, target: NiPoint3): boolean =>
  ObjectReferenceEx.getDistanceNoZ(pos, target) <= 8 && Math.abs(pos[2] - target[2]) <= standingMaxDeltaZ;

const applyHeadTracking = (ac: Actor, m: Movement, state: AppliedMovement, trusted: boolean) => {
  let lookAt = null;
  if (m.lookAt) {
    try {
      lookAt = Game.findClosestActor(
        m.lookAt[0],
        m.lookAt[1],
        m.lookAt[2],
        128
      );
    } catch (e) {
      lookAt = null;
    }
  }

  const lookAtId = lookAt ? lookAt.getFormID() : 0;
  if (trusted && state.lookAtId === lookAtId) {
    return;
  }
  state.lookAtId = lookAtId;
  if (lookAt) {
    ac.setHeadTracking(true);
    ac.setLookAt(lookAt, false);
  } else {
    ac.setHeadTracking(false);
  }
};

// The carried player's carrier clone by local id, 0 while not carried; the body in its arms follows this copy's yaw
let carrierCloneId = 0;

export const setCarrierClone = (localId: number): void => {
  carrierCloneId = localId;
};

export const isCarrierCloneId = (localId: number): boolean => carrierCloneId !== 0 && localId === carrierCloneId;

// True when a standing copy already faces the reported way, so the offset holds it still
const keepOffsetFromActor = (ac: Actor, m: Movement): boolean => {
  let offsetAngle = m.rot[2] - ac.getAngleZ();
  // Wider deadzone when standing: 130ms-stale idle angle noise makes the offset hunt visibly; the carrier clone turns all the way so the body in its arms does
  const deadzone = isCarrierCloneId(ac.getFormID()) ? 0 : m.runMode === "Standing" ? 12 : 5;
  if (Math.abs(offsetAngle) < deadzone) {
    offsetAngle = 0;
  }

  if (m.runMode === "Standing") {
    ac.keepOffsetFromActor(ac, 0, 0, 0, 0, 0, offsetAngle, 1, 1);
    return offsetAngle === 0;
  }
  const offset = [
    3 * Math.sin((m.direction / 180) * Math.PI),
    3 * Math.cos((m.direction / 180) * Math.PI),
    getOffsetZ(m.runMode),
  ];

  ac.keepOffsetFromActor(
    ac,
    offset[0],
    offset[1],
    offset[2],
    0,
    0,
    offsetAngle,
    m.runMode === "Walking" ? 2048 : 1,
    1,
  );
  return false;
};

const getOffsetZ = (runMode: RunMode) => {
  switch (runMode) {
    case "Walking":
      return -512;
    case "Running":
      return -1024;
  }
  return 0;
};

// The flag applies return true when the engine already had the value and nothing was sent
const applySprinting = (ac: Actor, isSprinting: boolean): boolean => {
  if (ac.isSprinting() == isSprinting) {
    return true;
  }
  Debug.sendAnimationEvent(ac, isSprinting ? "SprintStart" : "SprintStop");
  return false;
};

const applyBlocking = (ac: Actor, m: AnimationVariables): boolean => {
  if (ac.getAnimationVariableBool("IsBlocking") == m.isBlocking) {
    return true;
  }
  Debug.sendAnimationEvent(ac, m.isBlocking ? "BlockStart" : "BlockStop");
  Debug.sendAnimationEvent(ac, m.isSneaking ? "SneakStart" : "SneakStop");
  return false;
};

const applySneaking = (ac: Actor, isSneaking: boolean): boolean => {
  const currentIsSneaking =
    ac.isSneaking() || ac.getAnimationVariableBool("IsSneaking");
  if (currentIsSneaking == isSneaking) {
    return true;
  }
  Debug.sendAnimationEvent(ac, isSneaking ? "SneakStart" : "SneakStop");
  return false;
};

export const applyWeapDrawn = (ac: Actor, isWeapDrawn: boolean): boolean => {
  if (ac.isWeaponDrawn() === isWeapDrawn) {
    return true;
  }
  TESModPlatform.setWeaponDrawnMode(ac, isWeapDrawn ? 1 : 0);
  return false;
};

// True once the copy was within healthConvergedDelta of the reported value
const applyHealthPercentage = (ac: Actor, healthPercentage: number): boolean => {
  const currentPercentage = ac.getActorValuePercentage('health');
  if (currentPercentage === healthPercentage) {
    return true;
  }

  const currentMax = ac.getBaseActorValue('health');
  const deltaPercentage = healthPercentage - currentPercentage;
  const k = 0.25;
  if (deltaPercentage > 0) {
    ac.restoreActorValue('health', deltaPercentage * currentMax * k);
  } else if (deltaPercentage < 0) {
    ac.damageActorValue('health', deltaPercentage * currentMax * k);
  }
  return Math.abs(deltaPercentage) < healthConvergedDelta;
};

// Use global temp var to avoid allocation of an array on each translateTo
const gTempTargetPos: NiPoint3 = [0, 0, 0];

interface GroundSample {
  pos: NiPoint3;
  isInJumpState: boolean;
  grade: number;
  // Height change since the previous sample, the most the extrapolation may add or remove
  dz: number;
}

// Last received position per clone and the ground grade (dz per horizontal unit) it implies
const groundSamples = new Map<number, GroundSample>();
const maxGroundGrade = 1.2;
// Over a shorter step the height noise outweighs the slope, so the previous grade is kept
const minGradeDistance = 16;

const getGroundSample = (refrId: number, m: Movement): GroundSample => {
  const prev = groundSamples.get(refrId);
  let grade = 0;
  if (prev && !prev.isInJumpState && !m.isInJumpState) {
    const dxy = ObjectReferenceEx.getDistanceNoZ(prev.pos, m.pos);
    if (dxy < minGradeDistance) {
      grade = prev.grade;
    } else if (dxy <= 512) {
      const rawGrade = (m.pos[2] - prev.pos[2]) / dxy;
      grade = Math.max(-maxGroundGrade, Math.min(maxGroundGrade, rawGrade));
    }
  }
  const sample: GroundSample = {
    pos: [m.pos[0], m.pos[1], m.pos[2]],
    isInJumpState: m.isInJumpState,
    grade,
    dz: prev ? Math.abs(m.pos[2] - prev.pos[2]) : 0,
  };
  groundSamples.set(refrId, sample);
  return sample;
};

export const forgetGroundSample = (localId: number): void => {
  groundSamples.delete(localId);
};

// True when the copy already stands at the target
const translateTo = (refr: ObjectReference, m: Movement): boolean => {
  let time = 0.2;
  if (m.isInJumpState || m.runMode !== "Standing") {
    time = 0.2;
  }

  const ground = getGroundSample(refr.getFormID(), m);

  // Local lag compensation
  // TODO: Remove "|| 0" hack (added to support old MpClientPlugin)
  // Clamped so a stale speed sample can't fling the clone past the target
  const distanceAdd = Math.min((m.speed || 0) * time, 128);
  const direction = m.rot[2] + m.direction;
  gTempTargetPos[0] = m.pos[0];
  gTempTargetPos[1] = m.pos[1];
  gTempTargetPos[2] = m.pos[2];

  // We do not want to add pos in case of standing-jumping
  if (m.runMode !== "Standing") {
    gTempTargetPos[0] += Math.sin(direction / 180 * Math.PI) * distanceAdd;
    gTempTargetPos[1] += Math.cos(direction / 180 * Math.PI) * distanceAdd;
    // Keep the extrapolated point on the slope instead of inside the hill
    gTempTargetPos[2] += Math.max(-ground.dz, Math.min(ground.dz, ground.grade * distanceAdd));
  }

  const refrRealPos = ObjectReferenceEx.getPos(refr);
  const distance = ObjectReferenceEx.getDistance(refrRealPos, gTempTargetPos);

  const speed = distance / time;

  const angleDiff = Math.abs(m.rot[2] - refr.getAngleZ());
  if (
    m.runMode !== "Standing" ||
    m.isInJumpState ||
    !isNearStandingSpot(refrRealPos, gTempTargetPos) ||
    angleDiff > 80 ||
    Actor.from(refr)?.getSitState() === 3 ||
    (isInSitPose(refr.getFormID()) && distance > 1)
  ) {
    const actor = Actor.from(refr);
    if (actor && actor.getActorValue("Variable10") < -999) {
      return false;
    }

    if (!actor || !actor.isDead()) {
      // TranslateTo's angle does not turn an actor posed in a sit idle
      if (isInSitPose(refr.getFormID()) && wrappedAngleDiff(m.rot[2], refr.getAngleZ()) > 3) {
        refr.setAngle(refr.getAngleX(), refr.getAngleY(), m.rot[2]);
      }
      refr.translateTo(
        gTempTargetPos[0],
        gTempTargetPos[1],
        gTempTargetPos[2],
        m.rot[0],
        m.rot[1],
        m.rot[2],
        speed,
        0
      );
    }
    return false;
  }
  return true;
};

// A loaded copy is in the player's world or cell, which FormView already matched against the packet
const teleportIfNeed = (refr: ObjectReference, m: Transform, loaded: boolean): void => {
  if (!loaded && (isInDifferentWorldOrCell(refr, m.worldOrCell) || isInDifferentExteriorCell(refr, m.pos))) {
    throw new RespawnNeededError("needs to be respawned");
  }
};

const cellWidth = 4096;

const isInDifferentExteriorCell = (refr: ObjectReference, pos: NiPoint3) => {
  const currentPos = ObjectReferenceEx.getPos(refr);
  const playerPos = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
  const targetDistanceToPlayer = ObjectReferenceEx.getDistance(playerPos, pos);
  const currentDistanceToPlayer = ObjectReferenceEx.getDistance(playerPos, currentPos);
  return currentDistanceToPlayer > cellWidth && targetDistanceToPlayer <= cellWidth;
};

const isInDifferentWorldOrCell = (
  refr: ObjectReference,
  worldOrCell: number
) => {
  return worldOrCell !== ObjectReferenceEx.getWorldOrCell(refr);
};
