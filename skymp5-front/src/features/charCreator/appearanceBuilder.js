// Turns creator state into the skymp Appearance JSON (see docs/character-creator.md).

import headparts from './data/headparts.json';
import tints from './data/tints.json';
import { findRace, raceIdFor } from './data/races';
import { TINT_TYPES, defaultMorphs, defaultPresets, argb, rgbInt } from './data/face';
import { bodyRangesFor, toVanillaWeight } from './data/stats';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function editorIdFor (race, age) {
  if (age === 'child' && race.childRaceId) return race.raceEditorId + 'Child';
  return race.raceEditorId;
}

export function raceDefaultsFor (race, age, sex) {
  const byRace = headparts.raceDefaults[editorIdFor(race, age)];
  return (byRace && byRace[sex]) || {};
}

export function partsFor (kind, race, age, sex) {
  const editorId = editorIdFor(race, age);
  return headparts.parts.filter(p => p.kind === kind && p[sex] && p.races.includes(editorId));
}

export function tintsFor (race, age, sex, type) {
  const byRace = tints[editorIdFor(race, age)];
  const list = (byRace && byRace[sex]) || [];
  return list.filter(t => t.type === type);
}

export function defaultParts (race, age, sex) {
  const defaults = raceDefaultsFor(race, age, sex);
  return {
    hair: defaults.hair !== undefined ? defaults.hair : null,
    eyes: defaults.eyes !== undefined ? defaults.eyes : null,
    brows: defaults.brows !== undefined ? defaults.brows : null,
    facialHair: null,
    scars: null
  };
}

export function defaultSkinRgb (race, age, sex) {
  const skin = tintsFor(race, age, sex, TINT_TYPES.SKIN_TONE)[0];
  return (skin && skin.presets[0]) || [128, 128, 128];
}

export function defaultLook (race, age, sex) {
  const look = {
    parts: { hair: null, eyes: null, brows: null, facialHair: null, scars: null },
    presets: defaultPresets(),
    morphs: defaultMorphs(),
    skinRgb: [128, 128, 128],
    hairRgb: (headparts.hairColors[0] && headparts.hairColors[0].rgb) || [56, 59, 44],
    lipRgb: null,
    warpaint: null,
    muscle: 50,
    fat: 25
  };
  if (race && race.faceGen) {
    look.parts = defaultParts(race, age, sex);
    look.skinRgb = defaultSkinRgb(race, age, sex);
  }
  return look;
}

export function clampedBody (state) {
  const ranges = bodyRangesFor(state.stats);
  return {
    muscle: clamp(state.look.muscle, ranges.muscle.min, ranges.muscle.max),
    fat: clamp(state.look.fat, ranges.fat.min, ranges.fat.max)
  };
}

export function buildAppearance (state) {
  const found = findRace(state.race);
  const race = found.race;
  const look = state.look;
  const body = clampedBody(state);
  const base = {
    isFemale: state.sex === 'female',
    raceId: raceIdFor(race, state.age),
    weight: toVanillaWeight(body.muscle, body.fat),
    skinColor: 0,
    hairColor: 0,
    headpartIds: [],
    headTextureSetId: 0,
    options: defaultMorphs(),
    presets: defaultPresets(),
    tints: [],
    name: state.name || ' '
  };
  if (!race.faceGen) return base;

  const defaults = raceDefaultsFor(race, state.age, state.sex);
  const ids = [];
  if (defaults.head !== undefined) ids.push(defaults.head);
  if (defaults.mouth !== undefined) ids.push(defaults.mouth);
  for (const kind of ['eyes', 'brows', 'hair']) {
    const chosen = look.parts[kind];
    if (typeof chosen === 'number') ids.push(chosen);
    else if (chosen === undefined && defaults[kind] !== undefined) ids.push(defaults[kind]);
  }
  for (const kind of ['facialHair', 'scars']) {
    if (typeof look.parts[kind] === 'number') ids.push(look.parts[kind]);
  }
  for (const id of [...ids]) {
    for (const extra of headparts.extras[String(id)] || []) ids.push(extra);
  }
  base.headpartIds = [...new Set(ids)];

  const morphs = look.morphs.slice(0, 19);
  while (morphs.length < 19) morphs.push(0);
  morphs[18] = 0;
  base.options = morphs;
  base.presets = look.presets.slice(0, 4).map(v => v | 0);

  base.skinColor = rgbInt(look.skinRgb);
  base.hairColor = rgbInt(look.hairRgb);
  const skinTint = tintsFor(race, state.age, state.sex, TINT_TYPES.SKIN_TONE)[0];
  if (skinTint) {
    base.tints.push({ texturePath: skinTint.file, argb: argb(look.skinRgb, 255), type: TINT_TYPES.SKIN_TONE });
  }
  if (look.lipRgb) {
    const lipTint = tintsFor(race, state.age, state.sex, TINT_TYPES.LIPS)[0];
    if (lipTint) {
      base.tints.push({ texturePath: lipTint.file, argb: argb(look.lipRgb, 255), type: TINT_TYPES.LIPS });
    }
  }
  if (look.warpaint) {
    const alpha = clamp(Math.round(look.warpaint.opacity * 2.55), 0, 255);
    base.tints.push({ texturePath: look.warpaint.file, argb: argb(look.warpaint.rgb, alpha), type: TINT_TYPES.WARPAINT });
  }
  return base;
}
