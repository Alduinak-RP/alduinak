import { loc } from '../../../loc';

// Face slider definitions matching the skymp Appearance wire format.
// `options` is the 19-float FaceGen morph array (NPC record NAM9, applied via
// setFaceMorph); index 18 is unused by the engine UI and stays 0.
// `presets` is the 4-int face part array (NPC record NAMA, setFacePreset).

export const FACE_MORPHS = [
  { index: 0, name: loc('charCreator.morph.noseLength') },
  { index: 1, name: loc('charCreator.morph.noseHeight') },
  { index: 2, name: loc('charCreator.morph.jawHeight') },
  { index: 3, name: loc('charCreator.morph.jawWidth') },
  { index: 4, name: loc('charCreator.morph.jawForward') },
  { index: 5, name: loc('charCreator.morph.cheekboneHeight') },
  { index: 6, name: loc('charCreator.morph.cheekboneDepth') },
  { index: 7, name: loc('charCreator.morph.eyeHeight') },
  { index: 8, name: loc('charCreator.morph.eyeWidth') },
  { index: 9, name: loc('charCreator.morph.browHeight') },
  { index: 10, name: loc('charCreator.morph.browWidth') },
  { index: 11, name: loc('charCreator.morph.browDepth') },
  { index: 12, name: loc('charCreator.morph.lipHeight') },
  { index: 13, name: loc('charCreator.morph.lipDepth') },
  { index: 14, name: loc('charCreator.morph.chinWidth') },
  { index: 15, name: loc('charCreator.morph.chinHeight') },
  { index: 16, name: loc('charCreator.morph.chinUnderbite') },
  { index: 17, name: loc('charCreator.morph.eyeDepth') }
];

export const MORPH_MIN = -1;
export const MORPH_MAX = 1;

export const FACE_PRESETS = [
  { index: 0, name: loc('charCreator.preset.nose'), max: 31 },
  { index: 1, name: loc('charCreator.preset.brow'), max: 23 },
  { index: 2, name: loc('charCreator.preset.eye'), max: 23 },
  { index: 3, name: loc('charCreator.preset.mouth'), max: 23 }
];

// Tint mask types as stored in the RACE records (tints.json `type` field).
export const TINT_TYPES = {
  LIPS: 1,
  CHEEKS: 2,
  EYELINER: 4,
  EYE_SOCKET_LOWER: 5,
  SKIN_TONE: 6,
  WARPAINT: 7,
  FROWN_LINES: 8,
  CHEEKS_LOWER: 9,
  NOSE: 10,
  CHIN: 11,
  NECK: 12,
  FOREHEAD: 13
};

export function defaultMorphs() {
  return new Array(19).fill(0);
}

export function defaultPresets() {
  return [0, 0, 0, 0];
}

// 0xAARRGGBB tint color from rgb array + 0-255 alpha.
export function argb(rgb, alpha) {
  return (((alpha & 0xff) << 24) | ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff)) | 0;
}

// 0x00RRGGBB for hairColor / skinColor fields.
export function rgbInt(rgb) {
  return ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff);
}
