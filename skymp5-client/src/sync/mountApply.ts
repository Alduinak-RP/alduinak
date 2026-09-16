import * as sp from "skyrimPlatform";
import { Actor, Game, NetImmerse, ObjectReference } from "skyrimPlatform";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { remoteIdToLocalId } from "../view/worldViewMisc";
import { FormModel } from "../view/model";
import { NiPoint3 } from "./movement";
import { logToPlatformLog } from "../logging";

// Observer side of horse riding: a remote player's model carries ff_mount (the horse's server id) and the engine is asked to seat the
// rider clone on the horse clone, by the native mountActor where the client has one and by the horse's activation otherwise. A refused
// seat leaves the clone attached to the horse instead, never back on normal movement sync. The rider's own client is services/mountService.ts.

export interface MountState {
  // The ride is remembered even while the horse has no local copy, so the clone is always let go of when ff_mount clears
  horseRemoteId: number;
  horseLocalId: number;
  mounted: boolean;
  pending: boolean;
  // The clone is walking to the mounting spot; the seat is asked for once it is there
  parking: boolean;
  parkTarget: NiPoint3;
  parkedAt: number;
  // Carried by the horse clone because the engine refused the saddle
  attached: boolean;
  lastFollowMs: number;
  // The clone's own walk was dropped for as long as it is left to the engine
  halted: boolean;
  tries: number;
  lastTryMs: number;
  // Set when the clone was told to dismount; movement apply resumes once it is off the horse or after the grace
  dismountAt: number;
  gaveUp: boolean;
  logged: string[];
}

export const makeMountState = (): MountState => ({
  horseRemoteId: 0, horseLocalId: 0, mounted: false, pending: false, parking: false, parkTarget: [0, 0, 0], parkedAt: 0,
  attached: false, lastFollowMs: 0, halted: false, tries: 0, lastTryMs: 0, dismountAt: 0, gaveUp: false, logged: [],
});

const RETRY_MS = 1500;
const MAX_TRIES = 6;
const DISMOUNT_GRACE_MS = 2000;
const SYNTHETIC_TTL_MS = 2000;
// The engine mounts from the horse's left flank, so the rider is parked there
const PARK_SIDE_OFFSET = 64;
const PARK_TIME_S = 0.2;
const PARK_MIN_SPEED = 100;
const PARK_ARRIVED_UNITS = 16;
const PARK_WAIT_MS = 400;
// The horse clone is left alone while the rider walks up to it and just after the seat is asked for, never for a whole retry wait
const SEAT_WINDOW_MS = 500;
// A suspension lapses on its own, so a rider view that stops applying cannot freeze a horse
const SUSPEND_MS = 1000;
const SADDLE_NODE = "SaddleBone";
const ATTACH_DRIFT_UNITS = 48;
const FOLLOW_MS = 130;

// Rider clones being seated, seated, attached or climbing off, by local id, with their horse's local id
const ridingClones = new Map<number, number>();

// Horse clones left to the engine while it is asked to seat a rider, by local id, with the moment the wait lapses
const seatingHorses = new Map<number, number>();

const syntheticActivations: { caster: number; target: number; at: number }[] = [];

export const isRiderClone = (localId: number): boolean => ridingClones.has(localId);

// A horse being mounted must not be translated or offset by its own movement apply, or the seat starts while it slides
export const isMountSuspended = (localId: number): boolean => (seatingHorses.get(localId) || 0) > Date.now();

// The forced activate raises the observer's activate event with the rider clone as caster; ActivationService drops it
export const takeSyntheticActivation = (casterLocalId: number, targetLocalId: number): boolean => {
  const now = Date.now();
  const i = syntheticActivations.findIndex((s) => s.caster === casterLocalId && s.target === targetLocalId && now - s.at <= SYNTHETIC_TTL_MS);
  if (i < 0) {
    return false;
  }
  syntheticActivations.splice(i, 1);
  return true;
};

const mountOf = (model: FormModel): number => {
  const v = (model as Record<string, unknown>)["ff_mount"];
  return typeof v === "number" && v > 0 ? v : 0;
};

// One line per ride and outcome, in skyrim-platform.log where a tester can read it back
const logOnce = (state: MountState, text: string): void => {
  if (state.logged.indexOf(text) >= 0) {
    return;
  }
  state.logged.push(text);
  logToPlatformLog("mountApply", text);
};

// The last normal apply left a self offset that keeps a clone walking, and a suppressed clone gets no translation to correct it
const stopMoving = (ac: Actor): void => {
  ac.clearKeepOffsetFromActor();
  ac.stopTranslation();
};

// Keeps the riding and seating sets in step with the state; the result is what the movement apply must treat as mounted
const track = (rider: Actor, riderId: number, state: MountState, riding: boolean, now: number): boolean => {
  if (riding) {
    if (!state.halted) {
      state.halted = true;
      stopMoving(rider);
    }
    ridingClones.set(riderId, state.horseLocalId);
  } else {
    state.halted = false;
    ridingClones.delete(riderId);
  }
  if (state.horseLocalId) {
    if (riding && (state.parking || (state.pending && now - state.lastTryMs < SEAT_WINDOW_MS))) {
      seatingHorses.set(state.horseLocalId, now + SUSPEND_MS);
    } else {
      seatingHorses.delete(state.horseLocalId);
    }
  }
  return riding;
};

// The engine mounts an upright, loaded actor in the horse's cell onto a free horse; the text says which clause refused
const seatRefusal = (rider: Actor, horse: Actor): string => {
  if (!rider.is3DLoaded() || !horse.is3DLoaded()) return "3d not loaded";
  if (rider.isDisabled() || horse.isDisabled()) return "disabled";
  if (ObjectReferenceEx.getWorldOrCell(rider) !== ObjectReferenceEx.getWorldOrCell(horse)) return "another cell";
  if (rider.isDead() || horse.isDead()) return "dead";
  if (horse.isBeingRidden()) return "the horse already carries someone";
  if (rider.isOnMount()) return "the rider is on another mount";
  if (rider.getActorValue("Variable10") < -999) return "ragdolled";
  if (rider.getSitState() === 3) return "sitting";
  return "";
};

const park = (rider: Actor, horse: Actor, state: MountState, now: number): void => {
  stopMoving(rider);
  state.halted = true;
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
  state.parkTarget = target;
  state.parkedAt = now;
  state.parking = true;
};

// Asks the engine for the saddle with both actors standing still; the native export answers at once, the activation later
const seat = (rider: Actor, horse: Actor, state: MountState, now: number): void => {
  const riderId = rider.getFormID();
  const horseId = horse.getFormID();
  rider.stopTranslation();
  horse.stopTranslation();
  horse.clearKeepOffsetFromActor();
  state.tries++;
  state.lastTryMs = now;

  const native = (sp as any).mountActor;
  if (typeof native === "function") {
    if (native(rider, horse) === true) {
      state.mounted = true;
      logOnce(state, `${riderId.toString(16)} seated on ${horseId.toString(16)} by mountActor`);
    } else {
      state.gaveUp = true;
      logOnce(state, `mountActor refused ${riderId.toString(16)} on ${horseId.toString(16)}`);
    }
    return;
  }
  // Marks of seats that raised no event expire
  for (let i = syntheticActivations.length - 1; i >= 0; i--) {
    if (now - syntheticActivations[i].at > SYNTHETIC_TTL_MS) syntheticActivations.splice(i, 1);
  }
  syntheticActivations.push({ caster: riderId, target: horseId, at: now });
  horse.activate(rider, true);
  state.pending = true;
};

const saddlePos = (horse: Actor): NiPoint3 => {
  if (NetImmerse.hasNode(horse, SADDLE_NODE, false)) {
    return [
      NetImmerse.getNodeWorldPositionX(horse, SADDLE_NODE, false),
      NetImmerse.getNodeWorldPositionY(horse, SADDLE_NODE, false),
      NetImmerse.getNodeWorldPositionZ(horse, SADDLE_NODE, false),
    ];
  }
  return ObjectReferenceEx.getPos(horse);
};

// The engine refused the saddle, so the clone rides along carried by the horse clone instead of walking
const attach = (rider: Actor, horse: Actor, state: MountState, now: number): void => {
  if (!state.attached) {
    stopMoving(rider);
    state.halted = true;
    rider.setVehicle(horse);
    state.attached = true;
    state.lastFollowMs = now;
    return;
  }
  if (now - state.lastFollowMs < FOLLOW_MS) {
    return;
  }
  state.lastFollowMs = now;
  // The vehicle carries it on its own where the engine honours that; otherwise the clone is put back on the saddle node
  if (ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(rider), saddlePos(horse)) > ATTACH_DRIFT_UNITS) {
    rider.moveToNode(horse, SADDLE_NODE).catch(() => { /* clone vanished */ });
  }
};

const detach = (rider: Actor, state: MountState): void => {
  if (!state.attached) {
    return;
  }
  state.attached = false;
  rider.setVehicle(null);
};

// ff_mount was cleared or points elsewhere, or the horse clone went away
const unseat = (rider: Actor, state: MountState, now: number): void => {
  const seated = rider.isOnMount();
  if (seated) {
    rider.dismount();
  }
  detach(rider, state);
  seatingHorses.delete(state.horseLocalId);
  Object.assign(state, makeMountState(), { dismountAt: seated ? now : 0 });
};

// Runs every apply; true while the clone is left to the engine (seating, seated, carried or climbing off)
export const applyMount = (refr: ObjectReference, model: FormModel, state: MountState): boolean => {
  const horseRemoteId = mountOf(model);
  if (!horseRemoteId && !state.horseRemoteId && !state.horseLocalId && !state.dismountAt) {
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
  state.horseRemoteId = horseRemoteId;
  if (state.dismountAt) {
    if (now - state.dismountAt < DISMOUNT_GRACE_MS && rider.isOnMount()) {
      return track(rider, riderId, state, true, now);
    }
    state.dismountAt = 0;
  }
  // The ride is the property, not the seat: a clone with ff_mount never goes back on normal movement sync
  if (!horseRemoteId) {
    return track(rider, riderId, state, false, now);
  }
  if (!horseLocalId) {
    logOnce(state, `${riderId.toString(16)} rides ${horseRemoteId.toString(16)}, which has no local horse`);
    return track(rider, riderId, state, true, now);
  }
  const horse = Actor.from(Game.getFormEx(horseLocalId));
  if (!horse) {
    logOnce(state, `${horseLocalId.toString(16)} is no local actor`);
    return track(rider, riderId, state, true, now);
  }
  state.horseLocalId = horseLocalId;

  if (state.mounted) {
    if (rider.isOnMount()) {
      return track(rider, riderId, state, true, now);
    }
    // Thrown off by the engine; seated again below
    state.mounted = false;
  }
  if (state.pending) {
    if (rider.isOnMount()) {
      state.pending = false;
      state.mounted = true;
      state.tries = 0;
      logOnce(state, `${riderId.toString(16)} seated on ${horseLocalId.toString(16)}`);
      return track(rider, riderId, state, true, now);
    }
    if (now - state.lastTryMs < RETRY_MS) {
      return track(rider, riderId, state, true, now);
    }
    state.pending = false;
    if (state.tries >= MAX_TRIES) {
      state.gaveUp = true;
      logOnce(state, `${riderId.toString(16)} was refused the saddle of ${horseLocalId.toString(16)} after ${MAX_TRIES} tries`);
    }
  }
  if (state.gaveUp) {
    if (rider.isOnMount()) {
      detach(rider, state);
      state.mounted = true;
      state.gaveUp = false;
      return track(rider, riderId, state, true, now);
    }
    attach(rider, horse, state, now);
    return track(rider, riderId, state, true, now);
  }
  if (state.parking) {
    const arrived = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(rider), state.parkTarget) <= PARK_ARRIVED_UNITS;
    if (!arrived && now - state.parkedAt < PARK_WAIT_MS) {
      return track(rider, riderId, state, true, now);
    }
    state.parking = false;
    seat(rider, horse, state, now);
    return track(rider, riderId, state, true, now);
  }

  const refusal = seatRefusal(rider, horse);
  if (refusal) {
    logOnce(state, `${riderId.toString(16)} cannot be seated on ${horseLocalId.toString(16)}: ${refusal}`);
    return track(rider, riderId, state, true, now);
  }
  park(rider, horse, state, now);
  return track(rider, riderId, state, true, now);
};

// A seated or carried rider clone lets go of its horse before it is deleted or killed
export const releaseRiderClone = (riderLocalId: number): void => {
  const horseLocalId = ridingClones.get(riderLocalId);
  if (horseLocalId === undefined) {
    return;
  }
  ridingClones.delete(riderLocalId);
  seatingHorses.delete(horseLocalId);
  const rider = Actor.from(Game.getFormEx(riderLocalId));
  if (!rider) {
    return;
  }
  rider.setVehicle(null);
  if (rider.isOnMount()) {
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
