// The Actor calls a max attribute penalty needs; skyrimPlatform's Actor satisfies it
export interface PenaltyActor {
  getActorValue(av: string): number;
  setActorValue(av: string, value: number): void;
  getActorValueMax(av: string): number;
  getActorValuePercentage(av: string): number;
  modActorValue(av: string, amount: number): void;
  restoreActorValue(av: string, amount: number): void;
  damageActorValue(av: string, amount: number): void;
}

// Survival_GlobalFunctions.HungerStaminaPenaltyAV and ExhaustionMagickaPenaltyAV: the player keeps the applied penalty in them
export const HUNGER_PENALTY_AV = "Variable02";
export const EXHAUSTION_PENALTY_AV = "Variable03";

// A permanent modifier moves the current value by the same amount; the rest keeps the percentage the server holds
const modMaximum = (actor: PenaltyActor, av: string, delta: number): void => {
  const percentage = actor.getActorValuePercentage(av);
  const keep = Number.isFinite(percentage) ? Math.max(0, Math.min(1, percentage)) : 1;
  actor.modActorValue(av, delta);
  const adjust = -delta * (1 - keep);
  if (adjust > 0) actor.restoreActorValue(av, adjust);
  else if (adjust < 0) actor.damageActorValue(av, -adjust);
};

// Survival_NeedBase.ApplyAttributePenalty with a permanent modifier in place of its penalty spell; returns the penalty now applied
export const applyAttributePenalty = (actor: PenaltyActor, av: string, penaltyAv: string, share: number): number => {
  const applied = actor.getActorValue(penaltyAv);
  const total = actor.getActorValueMax(av) + applied;
  // One point is kept: skymp syncs these values as percentages of the maximum
  const target = Math.max(0, Math.min(total - 1, total * Math.max(0, Math.min(1, share))));
  const delta = target - applied;
  if (Math.abs(delta) < 0.01) return applied;
  modMaximum(actor, av, -delta);
  actor.setActorValue(penaltyAv, target);
  return target;
};

// An admin's permanent max attribute change; the caller tracks what it applied to the actor it holds
export const applyAttributeBonus = (actor: PenaltyActor, av: string, applied: number, bonus: number): number => {
  const delta = Math.max(bonus - applied, 1 - actor.getActorValueMax(av));
  if (Math.abs(delta) < 0.01) return applied;
  modMaximum(actor, av, delta);
  return applied + delta;
};

export const applyNeedsPenalties = (actor: PenaltyActor, staminaShare: number, magickaShare: number): void => {
  applyAttributePenalty(actor, "Stamina", HUNGER_PENALTY_AV, staminaShare);
  applyAttributePenalty(actor, "Magicka", EXHAUSTION_PENALTY_AV, magickaShare);
};
