import { Actor } from "skyrimPlatform";

export interface ActorValues {
  health: number;
  stamina: number;
  magicka: number;
}

export const getActorValues = (ac: Actor): ActorValues => {
  if (!ac) {
    return { health: 0, stamina: 0, magicka: 0 };
  }
  // A zero maximum must not send NaN or Infinity to the server
  const finite = (v: number, fallback: number) => Number.isFinite(v) ? v : fallback;
  let healthPercentage = (ac.isDead()) ? 0 : finite(ac.getActorValuePercentage("health"), 1);
  const staminaPercentage = finite(ac.getActorValuePercentage("stamina"), 0);
  const magickaPercentage = finite(ac.getActorValuePercentage("magicka"), 0);

  const resultActorValue: ActorValues = {
    health: healthPercentage,
    stamina: staminaPercentage,
    magicka: magickaPercentage,
  };
  return resultActorValue;
}

// Any CarryWeight change makes the engine re-check encumbrance and re-read the movement speed
export const refreshMovement = (ac: Pick<Actor, "modActorValue">): void => {
  ac.modActorValue("CarryWeight", 1);
  ac.modActorValue("CarryWeight", -1);
};

// Float noise beside a whole maximum is rounded away; a fractional maximum (a cold or needs penalty) stays as it is
export const wholeWhenNear = (value: number): number => Math.abs(value - Math.round(value)) < 0.001 ? Math.round(value) : value;

export const getMaximumActorValue = (ac: Actor, avName: string): number => {
  const currentPercentage = ac.getActorValuePercentage(avName);
  return currentPercentage === 0 ?
    ac.getBaseActorValue(avName) :
    wholeWhenNear(ac.getActorValue(avName) / currentPercentage);
}

export const setActorValuePercentage = (ac: Actor, avName: string, percentage: number): void => {
  // Actor value percentage for health may be below zero (-1.8 for example, it means u have -180% health)
  const currentPercentage = ac.getActorValuePercentage(avName);
  if (currentPercentage === percentage || !Number.isFinite(currentPercentage) || !Number.isFinite(percentage)) {
    return;
  }

  const currentMaxValue = getMaximumActorValue(ac, avName);
  const deltaPercentage = percentage - currentPercentage;
  if (deltaPercentage > 0) {
    ac.restoreActorValue(avName, deltaPercentage * currentMaxValue);
  } else if (deltaPercentage < 0) {
    ac.damageActorValue(avName, deltaPercentage * currentMaxValue);
  }
};
