import * as sp from "skyrimPlatform";
import { Actor, Game, NetImmerse, ObjectReference } from "skyrimPlatform";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { FormModel } from "../view/model";
import { localIdToRemoteId, remoteIdToLocalId } from "../view/worldViewMisc";
import { NiPoint3 } from "./movement";
import { wrappedAngleDiff } from "./movementApply";
import { stopMoving } from "./mountApply";

// Holds a carried body on the local copy of its carrier every frame, natively through setCarryHold where the export exists, else with a per-frame TranslateTo

// Ahead of and above the carrier's root, turned yaw degrees from the carrier's facing
export interface CarryPose {
  forward: number;
  up: number;
  yaw: number;
}

export const DEFAULT_CARRY_POSE: Readonly<CarryPose> = { forward: 16, up: 40, yaw: 45 };

// What SkyrimPlatform's frame-start hold (CarryHold.cpp) measured: drift is how far from its place on the carrier the body stood before each write
export interface NativeHoldStats {
  frames: number;
  skipped: number;
  snaps: number;
  sampled: number;
  meanDrift: number;
  maxDrift: number;
  worstSecond: number;
  maxYawDrift: number;
}

interface NativeCarryApi {
  setCarryHold?: (heldFormId: number, carrierFormId: number, forward: number, up: number, yaw: number) => boolean;
  clearCarryHold?: (heldFormId: number) => NativeHoldStats | null;
}

const nativeCarry = sp as unknown as NativeCarryApi;

export interface HoldState {
  // When the latent heading write in flight started, 0 when none
  headingPendingSince: number;
  lastHeadingMs: number;
  // Gaps and heading errors are recorded from here on, once the body caught up after a start or a server move
  settledAt: number;
  translates: number;
  headingWrites: number;
  maxHeadingError: number;
  maxGap: number;
  // The body the native hold places for this state, 0 when it holds none
  nativeHeld: number;
  // The native holds of this state so far, merged as each one ends
  native: NativeHoldStats;
}

const emptyNativeStats = (): NativeHoldStats => ({
  frames: 0, skipped: 0, snaps: 0, sampled: 0, meanDrift: 0, maxDrift: 0, worstSecond: 0, maxYawDrift: 0,
});

export const makeHoldState = (): HoldState => ({
  headingPendingSince: 0, lastHeadingMs: 0, settledAt: 0, translates: 0, headingWrites: 0, maxHeadingError: 0, maxGap: 0,
  nativeHeld: 0, native: emptyNativeStats(),
});

const mergeNativeStats = (into: NativeHoldStats, add: NativeHoldStats): void => {
  const sampled = into.sampled + add.sampled;
  into.meanDrift = sampled ? (into.meanDrift * into.sampled + add.meanDrift * add.sampled) / sampled : 0;
  into.sampled = sampled;
  into.frames += add.frames;
  into.skipped += add.skipped;
  into.snaps += add.snaps;
  into.maxDrift = Math.max(into.maxDrift, add.maxDrift);
  into.worstSecond = Math.max(into.worstSecond, add.worstSecond);
  into.maxYawDrift = Math.max(into.maxYawDrift, add.maxYawDrift);
};

// Ends this state's native hold and keeps what it measured; the body is then left where it is
export const releaseHold = (s: HoldState): void => {
  if (!s.nativeHeld) {
    return;
  }
  const stats = typeof nativeCarry.clearCarryHold === "function" ? nativeCarry.clearCarryHold(s.nativeHeld) : null;
  s.nativeHeld = 0;
  if (stats) {
    mergeNativeStats(s.native, stats);
  }
};

// Hands the frame's placement to the engine's frame start; false without the export or its hook, which leaves the script hold
const holdNatively = (held: Actor, carrier: ObjectReference, pose: CarryPose, s: HoldState): boolean => {
  if (typeof nativeCarry.setCarryHold !== "function") {
    return false;
  }
  const heldId = held.getFormID();
  if (s.nativeHeld !== heldId) {
    releaseHold(s);
  }
  if (!nativeCarry.setCarryHold(heldId, carrier.getFormID(), pose.forward, pose.up, pose.yaw)) {
    return false;
  }
  s.nativeHeld = heldId;
  return true;
};

// The hold part of a carry summary line
export const describeHold = (s: HoldState): string => {
  const n = s.native;
  return n.frames
    ? `native hold ${n.frames} frames (${n.skipped} skipped, ${n.snaps} snaps), drift before each write mean ${n.meanDrift.toFixed(1)} ` +
      `max ${n.maxDrift.toFixed(1)} worst second ${n.worstSecond.toFixed(1)} units, heading drift max ${n.maxYawDrift.toFixed(1)}`
    : `script hold ${s.translates} translates, ${s.headingWrites} heading writes, largest heading error ${s.maxHeadingError.toFixed(1)}, ` +
      `largest gap ${Math.round(s.maxGap)} units`;
};

// The translate arrives within about three frames
const HOLD_LEAD_S = 0.05;
const HOLD_MIN_SPEED = 30;
const HOLD_EPSILON = 1;
// A posed body ignores TranslateTo's angle, so the latent SetAngle is written past this error, one at a time and at most four a second
const HEADING_DEADZONE = 5;
const HEADING_MIN_MS = 250;
// A write that never answered stops blocking the next one
const HEADING_PENDING_MAX_MS = 2000;
const HOLD_SETTLE_MS = 1000;
const HOLD_MAX_DIST = 2048;

const CARRIED_BY_PROP = "ff_carriedBy";

export const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

// The carryForward, carryUp and carryYaw keys of a restraintState or carryState packet and of ff_carriedBy
export const readCarryPose = (content: Record<string, unknown>, fallback: CarryPose): CarryPose => ({
  forward: finiteOr(content["carryForward"], fallback.forward),
  up: finiteOr(content["carryUp"], fallback.up),
  yaw: finiteOr(content["carryYaw"], fallback.yaw),
});

export const carryTarget = (carrier: ObjectReference, pose: CarryPose): { pos: NiPoint3; yaw: number } => {
  const carrierYaw = carrier.getAngleZ();
  const yawRad = carrierYaw * Math.PI / 180;
  const p = ObjectReferenceEx.getPos(carrier);
  return {
    pos: [p[0] + Math.sin(yawRad) * pose.forward, p[1] + Math.cos(yawRad) * pose.forward, p[2] + pose.up],
    yaw: carrierYaw + pose.yaw,
  };
};

// Gaps and heading errors in the first second after from are catch-up and are not recorded
export const restartHold = (s: HoldState, from: number): void => {
  s.settledAt = from + HOLD_SETTLE_MS;
};

// Runs every frame; a body farther than HOLD_MAX_DIST from its place is left alone
export const holdOnCarrier = (held: Actor, carrier: ObjectReference, pose: CarryPose, s: HoldState, now: number): void => {
  if (holdNatively(held, carrier, pose, s)) {
    return;
  }
  const target = carryTarget(carrier, pose);
  const dist = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(held), target.pos);
  if (dist > HOLD_MAX_DIST) {
    return;
  }
  if (!s.settledAt) {
    restartHold(s, now);
  }
  const headingError = wrappedAngleDiff(target.yaw, held.getAngleZ());
  if (now >= s.settledAt) {
    s.maxGap = Math.max(s.maxGap, dist);
    s.maxHeadingError = Math.max(s.maxHeadingError, headingError);
  }
  if (s.headingPendingSince && now - s.headingPendingSince > HEADING_PENDING_MAX_MS) {
    s.headingPendingSince = 0;
  }
  if (!s.headingPendingSince && now - s.lastHeadingMs >= HEADING_MIN_MS && headingError >= HEADING_DEADZONE) {
    s.headingPendingSince = now;
    s.lastHeadingMs = now;
    s.headingWrites++;
    const done = () => {
      if (s.headingPendingSince === now) s.headingPendingSince = 0;
    };
    // The full angle, so no X or Y from an earlier ragdoll stays
    held.setAngle(0, 0, target.yaw).then(done, done);
  }
  if (dist >= HOLD_EPSILON) {
    held.translateTo(
      target.pos[0], target.pos[1], target.pos[2],
      0, 0, target.yaw,
      Math.max(dist / HOLD_LEAD_S, HOLD_MIN_SPEED), 0,
    );
    s.translates++;
  }
};

// A node's offset from the reference's root in its own frame, as right/forward/up
const nodeOffset = (refr: ObjectReference, node: string): string => {
  if (!NetImmerse.hasNode(refr, node, false)) {
    return "none";
  }
  const p = ObjectReferenceEx.getPos(refr);
  const dx = NetImmerse.getNodeWorldPositionX(refr, node, false) - p[0];
  const dy = NetImmerse.getNodeWorldPositionY(refr, node, false) - p[1];
  const dz = NetImmerse.getNodeWorldPositionZ(refr, node, false) - p[2];
  const yaw = refr.getAngleZ() * Math.PI / 180;
  return [dx * Math.cos(yaw) - dy * Math.sin(yaw), dx * Math.sin(yaw) + dy * Math.cos(yaw), dz].map((v) => v.toFixed(1)).join("/");
};

// The numbers carryOffsetForward and carryOffsetUp are tuned from: where the carried pelvis sits and where the carrier's hands are
export const describeCarryNodes = (body: ObjectReference, carrier: ObjectReference | null): string =>
  `carry nodes (right/forward/up from the root): body pelvis ${nodeOffset(body, "NPC Pelvis [Pelv]")}, ` +
  `carrier left hand ${carrier ? nodeOffset(carrier, "NPC L Hand [LHnd]") : "none"}, right hand ${carrier ? nodeOffset(carrier, "NPC R Hand [RHnd]") : "none"}`;

interface CarriedBy extends CarryPose {
  carrier: number;
}

const carriedByOf = (model: FormModel): CarriedBy | null => {
  const v = (model as Record<string, unknown>)[CARRIED_BY_PROP];
  if (!v || typeof v !== "object") {
    return null;
  }
  const r = v as Record<string, unknown>;
  const carrier = typeof r["carrier"] === "number" ? r["carrier"] >>> 0 : 0;
  return carrier ? { carrier, ...readCarryPose(r, DEFAULT_CARRY_POSE) } : null;
};

export interface CarriedViewState {
  holding: boolean;
  // Held on the local player: this client is the carrier, so the body sits at its camera
  onPlayer: boolean;
  hold: HoldState;
}

export const makeCarriedViewState = (): CarriedViewState => ({ holding: false, onPlayer: false, hold: makeHoldState() });

// Runs every frame for a copy; true while it is held on the local copy of its carrier, the local player when that is the carrier
export const applyCarried = (refr: ObjectReference, model: FormModel, state: CarriedViewState, allowed: boolean): boolean => {
  const by = allowed ? carriedByOf(model) : null;
  const body = by ? Actor.from(refr) : null;
  let holding = false;
  if (by && body && body.is3DLoaded()) {
    const carrierLocalId = by.carrier === (localIdToRemoteId(0x14, true) >>> 0) ? 0x14 : remoteIdToLocalId(by.carrier);
    const carrier = carrierLocalId ? ObjectReference.from(Game.getFormEx(carrierLocalId)) : null;
    if (carrier && carrier.is3DLoaded() && ObjectReferenceEx.getWorldOrCell(carrier) === ObjectReferenceEx.getWorldOrCell(body) &&
      ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(carrier), ObjectReferenceEx.getPos(body)) <= HOLD_MAX_DIST) {
      const now = Date.now();
      if (!state.holding) {
        // The last normal apply left a self offset and a translate running
        stopMoving(body);
        restartHold(state.hold, now);
      }
      holdOnCarrier(body, carrier, by, state.hold, now);
      holding = true;
      state.onPlayer = carrierLocalId === 0x14;
    }
  }
  if (state.holding && !holding) {
    releaseHold(state.hold);
  }
  state.holding = holding;
  return holding;
};
