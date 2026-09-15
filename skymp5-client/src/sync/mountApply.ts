import { Actor, Game, ObjectReference, printConsole } from "skyrimPlatform";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { remoteIdToLocalId } from "../view/worldViewMisc";
import { FormModel } from "../view/model";
import { NiPoint3 } from "./movement";

// Observer side of horse riding: a remote player's model carries ff_mount (the horse's server id) and the engine seats the
// rider clone on the horse clone through the horse's activation. The rider's own client is services/mountService.ts.

export interface MountState {
  horseLocalId: number;
  mounted: boolean;
  pending: boolean;
  tries: number;
  lastTryMs: number;
  // Set when the clone was told to dismount; movement apply resumes once it is off the horse or after the grace
  dismountAt: number;
  gaveUp: boolean;
}

export const makeMountState = (): MountState => ({
  horseLocalId: 0, mounted: false, pending: false, tries: 0, lastTryMs: 0, dismountAt: 0, gaveUp: false,
});

const RETRY_MS = 1500;
const MAX_TRIES = 6;
const DISMOUNT_GRACE_MS = 2000;
const SYNTHETIC_TTL_MS = 2000;
// The engine mounts from the horse's left flank, so the rider is parked there
const PARK_SIDE_OFFSET = 64;
const PARK_TIME_S = 0.2;
const PARK_MIN_SPEED = 100;

// Rider clones being seated, seated or climbing off, by local id, with their horse's local id
const ridingClones = new Map<number, number>();

let syntheticActivation: { caster: number; target: number; at: number } | undefined;

export const isRiderClone = (localId: number): boolean => ridingClones.has(localId);

// The forced activate raises the observer's activate event with the rider clone as caster; ActivationService drops it
export const takeSyntheticActivation = (casterLocalId: number, targetLocalId: number): boolean => {
  const s = syntheticActivation;
  if (!s || s.caster !== casterLocalId || s.target !== targetLocalId || Date.now() - s.at > SYNTHETIC_TTL_MS) {
    return false;
  }
  syntheticActivation = undefined;
  return true;
};

const mountOf = (model: FormModel): number => {
  const v = (model as Record<string, unknown>)["ff_mount"];
  return typeof v === "number" && v > 0 ? v : 0;
};

// Keeps the riding set in step with the state; the result is what the movement apply must treat as mounted
const track = (riderId: number, state: MountState): boolean => {
  const riding = state.pending || state.mounted || state.dismountAt > 0;
  if (riding) {
    ridingClones.set(riderId, state.horseLocalId);
  } else {
    ridingClones.delete(riderId);
  }
  return riding;
};

// The engine mounts an upright, loaded actor in the horse's cell onto a free horse
const canSeat = (rider: Actor, horse: Actor): boolean =>
  rider.is3DLoaded() && horse.is3DLoaded() && !rider.isDisabled() && !horse.isDisabled()
  && ObjectReferenceEx.getWorldOrCell(rider) === ObjectReferenceEx.getWorldOrCell(horse)
  && !rider.isDead() && !horse.isDead() && !horse.isBeingRidden() && !rider.isOnMount()
  && rider.getActorValue("Variable10") >= -999 && rider.getSitState() !== 3;

const park = (rider: Actor, horse: Actor): void => {
  rider.clearKeepOffsetFromActor();
  rider.stopTranslation();
  const yaw = horse.getAngleZ() * Math.PI / 180;
  const horsePos = ObjectReferenceEx.getPos(horse);
  const target: NiPoint3 = [
    horsePos[0] - Math.cos(yaw) * PARK_SIDE_OFFSET,
    horsePos[1] + Math.sin(yaw) * PARK_SIDE_OFFSET,
    horsePos[2],
  ];
  const dist = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(rider), target);
  rider.translateTo(
    target[0], target[1], target[2],
    rider.getAngleX(), rider.getAngleY(), horse.getAngleZ(),
    Math.max(dist / PARK_TIME_S, PARK_MIN_SPEED), 0,
  );
};

// ff_mount was cleared or points elsewhere, or the horse clone went away
const unseat = (rider: Actor, state: MountState, now: number): void => {
  const seated = rider.isOnMount();
  if (seated) {
    rider.dismount();
  }
  Object.assign(state, makeMountState(), { dismountAt: seated ? now : 0 });
};

// Runs every apply; true while the clone is left to the engine (seating, seated or climbing off)
export const applyMount = (refr: ObjectReference, model: FormModel, state: MountState): boolean => {
  const horseRemoteId = mountOf(model);
  if (!horseRemoteId && !state.horseLocalId && !state.dismountAt) {
    return false;
  }
  const rider = Actor.from(refr);
  if (!rider) {
    return false;
  }
  const riderId = rider.getFormID();
  const horseLocalId = horseRemoteId ? remoteIdToLocalId(horseRemoteId) : 0;
  const now = Date.now();

  if (state.horseLocalId && state.horseLocalId !== horseLocalId) {
    unseat(rider, state, now);
  }
  if (state.dismountAt) {
    if (now - state.dismountAt < DISMOUNT_GRACE_MS && rider.isOnMount()) {
      return track(riderId, state);
    }
    state.dismountAt = 0;
  }
  if (!horseLocalId || state.gaveUp) {
    return track(riderId, state);
  }

  if (state.mounted) {
    if (rider.isOnMount()) {
      return track(riderId, state);
    }
    // Thrown off by the engine; seated again below
    state.mounted = false;
  }
  if (state.pending) {
    if (rider.isOnMount()) {
      state.pending = false;
      state.mounted = true;
      state.tries = 0;
      printConsole(`[mount] ${riderId.toString(16)} seated on ${horseLocalId.toString(16)}`);
      return track(riderId, state);
    }
    if (now - state.lastTryMs < RETRY_MS) {
      return track(riderId, state);
    }
    state.pending = false;
    if (state.tries >= MAX_TRIES) {
      state.gaveUp = true;
      printConsole(`[mount] ${riderId.toString(16)} could not be seated on ${horseLocalId.toString(16)} after ${MAX_TRIES} tries`);
      return track(riderId, state);
    }
  }

  const horse = Actor.from(Game.getFormEx(horseLocalId));
  if (!horse || !canSeat(rider, horse)) {
    return track(riderId, state);
  }
  park(rider, horse);
  syntheticActivation = { caster: riderId, target: horseLocalId, at: now };
  horse.activate(rider, true);
  state.horseLocalId = horseLocalId;
  state.pending = true;
  state.tries++;
  state.lastTryMs = now;
  return track(riderId, state);
};

// A seated rider clone leaves the saddle before it is deleted or killed
export const releaseRiderClone = (riderLocalId: number): void => {
  if (!ridingClones.delete(riderLocalId)) {
    return;
  }
  const rider = Actor.from(Game.getFormEx(riderLocalId));
  if (rider && rider.isOnMount()) {
    rider.dismount();
  }
};

// A horse killed under a rider clone throws it first
export const dismountRiderOf = (horseLocalId: number): void => {
  ridingClones.forEach((horse, riderId) => {
    if (horse === horseLocalId) {
      releaseRiderClone(riderId);
    }
  });
};
