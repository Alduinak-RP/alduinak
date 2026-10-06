import { loc } from '../../../loc';

// RPG attributes assigned on screen 3. Point-buy: every attribute starts at
// START and the pool on top is distributed freely within [MIN, MAX].
// Some attributes constrain the body sliders on screen 4 (see bodyRangesFor).

export const STAT_MIN = 10;
export const STAT_MAX = 100;
export const STAT_START = 40;
export const DEFAULT_STAT_POOL = 120;

export const ATTRIBUTES = [
  { id: 'strength', name: loc('charCreator.attr.strength'), desc: loc('charCreator.attr.strengthDesc') },
  { id: 'endurance', name: loc('charCreator.attr.endurance'), desc: loc('charCreator.attr.enduranceDesc') },
  { id: 'agility', name: loc('charCreator.attr.agility'), desc: loc('charCreator.attr.agilityDesc') },
  { id: 'speed', name: loc('charCreator.attr.speed'), desc: loc('charCreator.attr.speedDesc') },
  { id: 'intelligence', name: loc('charCreator.attr.intelligence'), desc: loc('charCreator.attr.intelligenceDesc') },
  { id: 'willpower', name: loc('charCreator.attr.willpower'), desc: loc('charCreator.attr.willpowerDesc') },
  { id: 'personality', name: loc('charCreator.attr.personality'), desc: loc('charCreator.attr.personalityDesc') },
  { id: 'luck', name: loc('charCreator.attr.luck'), desc: loc('charCreator.attr.luckDesc') }
];

export function defaultStats() {
  const stats = {};
  for (const a of ATTRIBUTES) stats[a.id] = STAT_START;
  return stats;
}

export function pointsSpent(stats) {
  return ATTRIBUTES.reduce((sum, a) => sum + ((stats[a.id] || STAT_START) - STAT_START), 0);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Allowed body slider ranges (0-100) implied by the chosen attributes.
// High strength raises the muscle floor, low strength caps it; endurance
// governs how heavy (fat) the frame may run.
export function bodyRangesFor(stats) {
  const str = stats.strength || STAT_START;
  const end = stats.endurance || STAT_START;
  return {
    muscle: {
      min: clamp(Math.round((str - 55) * 1.5), 0, 70),
      max: clamp(Math.round(str * 1.2 + 15), 25, 100)
    },
    fat: {
      min: 0,
      max: clamp(Math.round(end * 0.8 + 35), 40, 100)
    }
  };
}

// Vanilla Skyrim syncs a single weight axis; muscle and fat both push it up.
// The raw muscle/fat values are stored server-side for future body-morph mods.
export function toVanillaWeight(muscle, fat) {
  return clamp(Math.round(muscle * 0.55 + fat * 0.45), 0, 100);
}
