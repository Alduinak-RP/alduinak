import { FormModel } from '../view/model';
import { ObjectReference, Actor, TESModPlatform } from "skyrimPlatform";
import { NiPoint3, Movement, RunMode } from "./movement";
import { ObjectReferenceEx } from '../extensions/objectReferenceEx';
import { logToPlatformLog } from '../logging';
import { wrappedAngleDiff } from './movementApply';
import { PlayerCharacterDataHolder } from '../view/playerCharacterDataHolder';

// A probe that moved, turned or changed health by less than this is not worth a report
const MIN_MOVE_UNITS = 4;
const MIN_TURN_DEGREES = 2;
const MIN_HEALTH_CHANGE = 0.01;

// Hosted copies already logged as dead in their own engine while the server holds them alive
const engineDeadLogged = new Set<number>();
const ENGINE_DEAD_LOGGED_LIMIT = 256;

const noteEngineDeadHosted = (refr: ObjectReference, pos: NiPoint3): void => {
  const id = refr.getFormID();
  if (engineDeadLogged.has(id)) return;
  if (engineDeadLogged.size >= ENGINE_DEAD_LOGGED_LIMIT) engineDeadLogged.clear();
  engineDeadLogged.add(id);
  logToPlatformLog("movementGet", `hosted ${id.toString(16)} engine-dead while the server says alive: 3D ${refr.is3DLoaded()}, z ${Math.round(pos[2])}`);
};

class PlayerCharacterSpeedCalculator {
  // Sampled at every probe, so the first report after standing still measures one probe interval
  static sample(pos: NiPoint3, worldOrCell: number): number {
    const speed = this.getSpeed(pos, worldOrCell);
    this.savePosition(pos, worldOrCell);
    // It's unrealistic speed. It still may happen due to teleports
    return speed > 2000 ? 0 : speed;
  }

  private static savePosition(pos: NiPoint3, worldOrCell: number) {
    this.lastPcPos = pos;
    this.lastPcPosCheck = Date.now();
    this.lastPcWorldOrCell = worldOrCell;
  }

  private static getSpeed(currentPos: NiPoint3, worldOrCell: number) {
    if (this.lastPcPosCheck === -1) {
      return 0;
    }

    const timeDeltaSec = (Date.now() - this.lastPcPosCheck) / 1000;
    if (timeDeltaSec > 5) return 0; // Too inaccurate
    if (timeDeltaSec === 0) return 0; // Division by zero
    if (worldOrCell !== this.lastPcWorldOrCell) {
      return 0;
    }

    const distance = ObjectReferenceEx.getDistance(currentPos, this.lastPcPos);
    return distance / timeDeltaSec;
  }

  private static lastPcPos: NiPoint3 = [0, 0, 0];
  private static lastPcPosCheck = -1;
  private static lastPcWorldOrCell = 0;
}

// The cheap values read at every probe; a full report is built only when they say one is due
export interface MovementProbe {
  pos: NiPoint3;
  pitch: number;
  yaw: number;
  health: number;
  isInJumpState: boolean;
  isSneaking: boolean;
  isBlocking: boolean;
  isWeapDrawn: boolean;
  // The server's death state, from the model
  isDead: boolean;
  // Measured for the player only; copies report SpeedSampled
  speed?: number;
}

export const probeMovement = (refr: ObjectReference, form?: FormModel): MovementProbe => {
  const ac = Actor.from(refr);
  const pos = ObjectReferenceEx.getPos(refr);
  return {
    pos,
    pitch: refr.getAngleX(),
    yaw: refr.getAngleZ(),
    health: (ac && ac.getActorValuePercentage("health")) || 0,
    isInJumpState: !!(ac && ac.getAnimationVariableBool("bInJumpState")),
    isSneaking: !!(ac && isSneaking(ac)),
    isBlocking: !!(ac && ac.getAnimationVariableBool("IsBlocking")),
    isWeapDrawn: !!(ac && ac.isWeaponDrawn()),
    isDead: form?.isDead ?? false,
    // Real players often run into the wall, where SpeedSampled stays high
    speed: refr.getFormID() === 0x14 ? PlayerCharacterSpeedCalculator.sample(pos, PlayerCharacterDataHolder.getWorldOrCell()) : undefined,
  };
};

export const probeFlagsDiffer = (a: MovementProbe, b: MovementProbe): boolean =>
  a.isInJumpState !== b.isInJumpState || a.isSneaking !== b.isSneaking || a.isBlocking !== b.isBlocking
  || a.isWeapDrawn !== b.isWeapDrawn || a.isDead !== b.isDead;

// Pitch counts only with a weapon or spell out, where it aims the shot
export const probeChanged = (a: MovementProbe, b: MovementProbe): boolean =>
  probeFlagsDiffer(a, b)
  || ObjectReferenceEx.getDistance(a.pos, b.pos) > MIN_MOVE_UNITS
  || wrappedAngleDiff(a.yaw, b.yaw) > MIN_TURN_DEGREES
  || (a.isWeapDrawn && wrappedAngleDiff(a.pitch, b.pitch) > MIN_TURN_DEGREES)
  || Math.abs(a.health - b.health) >= MIN_HEALTH_CHANGE;

export const getMovement = (refr: ObjectReference, probe: MovementProbe): Movement => {
  const ac = Actor.from(refr);
  const isPlayer = refr.getFormID() === 0x14;

  // It is running for ObjectReferences because Standing
  // Doesn't lead to translateTo call
  const runMode = ac ? getRunMode(ac) : "Running";

  let lookAt: undefined | NiPoint3 = undefined;
  if (!isPlayer) {
    const combatTarget = ac?.getCombatTarget();
    if (combatTarget) {
      lookAt = [
        combatTarget.getPositionX(),
        combatTarget.getPositionY(),
        combatTarget.getPositionZ(),
      ];
    }
  }

  const speed = isPlayer ? probe.speed ?? 0 : refr.getAnimationVariableFloat("SpeedSampled");

  const worldOrCell = refr.getWorldSpace() || refr.getParentCell();

  // A hosted NPC's death is the server's to declare; its copy's own engine death (a fall before its collision loaded) is only logged
  const engineDead = !!(ac && ac.isDead());
  if (!isPlayer && engineDead && !probe.isDead) {
    noteEngineDeadHosted(refr, probe.pos);
  }

  return {
    worldOrCell: worldOrCell?.getFormID() || 0,
    pos: [probe.pos[0], probe.pos[1], probe.pos[2]],
    rot: [probe.pitch, refr.getAngleY(), probe.yaw],
    runMode: runMode,
    direction: runMode !== "Standing"
      ? 360 * refr.getAnimationVariableFloat("Direction")
      : 0,
    isInJumpState: probe.isInJumpState,
    isSneaking: probe.isSneaking,
    isBlocking: probe.isBlocking,
    isWeapDrawn: probe.isWeapDrawn,
    isDead: isPlayer ? probe.isDead || engineDead : probe.isDead,
    healthPercentage: engineDead ? 0 : probe.health,
    lookAt,
    speed
  };
}

const isSneaking = (ac: Actor) =>
  ac.isSneaking() || ac.getAnimationVariableBool("IsSneaking");

const getRunMode = (ac: Actor): RunMode => {
  if (ac.isSprinting()) {
    return "Sprinting";
  }

  const speed = ac.getAnimationVariableFloat("SpeedSampled");
  if (!speed) {
    return "Standing";
  }

  const furniture = ac.getFurnitureReference();
  if (furniture !== null) return "Standing"; // TODO: Sitting?

  // Slow effects lower the jog speed, so the jog threshold follows SpeedMult
  const speedMult = Math.min(Math.max(ac.getActorValue("SpeedMult"), 10), 100);
  const minRunSpeed = 150 * speedMult / 100;

  let isRunning = true;
  if (ac.getFormID() == 0x14) {
    // Engine run state is a fallback for the PlayerControls run flag
    const runEnabled = TESModPlatform.isPlayerRunningEnabled() || ac.isRunning();
    if (!runEnabled || speed < minRunSpeed)
      isRunning = false;
  } else {
    if (!ac.isRunning() || speed < minRunSpeed) {
      isRunning = false;
    }
  }

  if (ac.getAnimationVariableFloat("IsBlocking")) {
    isRunning = isSneaking(ac);
  }

  const carryWeight = ac.getActorValue("CarryWeight");
  const totalItemWeight = ac.getTotalItemWeight();
  if (carryWeight < totalItemWeight) {
    isRunning = false;
  }

  return isRunning ? "Running" : "Walking";
};
