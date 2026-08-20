// RPG attributes assigned on screen 3. Point-buy: every attribute starts at
// START and the pool on top is distributed freely within [MIN, MAX].
// Some attributes constrain the body sliders on screen 4 (see bodyRangesFor).

export const STAT_MIN = 10;
export const STAT_MAX = 100;
export const STAT_START = 40;
export const DEFAULT_STAT_POOL = 120;

export const ATTRIBUTES = [
  { id: 'strength', name: 'Strength', desc: 'Raw muscle. A mighty build demands a muscular body; a weak one forbids it.' },
  { id: 'endurance', name: 'Endurance', desc: 'Toughness and bulk. Shapes how heavy a frame you can carry.' },
  { id: 'agility', name: 'Agility', desc: 'Balance, finesse, and sleight of hand.' },
  { id: 'speed', name: 'Speed', desc: 'Footwork and reflexes.' },
  { id: 'intelligence', name: 'Intelligence', desc: 'Reason, memory, and magical theory.' },
  { id: 'willpower', name: 'Willpower', desc: 'Focus and resistance of mind.' },
  { id: 'personality', name: 'Personality', desc: 'Presence, charm, and force of character.' },
  { id: 'luck', name: 'Luck', desc: 'The favor of fate. Touches everything, governs nothing.' }
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
