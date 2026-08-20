// Face slider definitions matching the skymp Appearance wire format.
// `options` is the 19-float FaceGen morph array (NPC record NAM9, applied via
// setFaceMorph); index 18 is unused by the engine UI and stays 0.
// `presets` is the 4-int face part array (NPC record NAMA, setFacePreset).

export const FACE_MORPHS = [
  { index: 0, name: 'Nose Length' },
  { index: 1, name: 'Nose Height' },
  { index: 2, name: 'Jaw Height' },
  { index: 3, name: 'Jaw Width' },
  { index: 4, name: 'Jaw Forward' },
  { index: 5, name: 'Cheekbone Height' },
  { index: 6, name: 'Cheekbone Depth' },
  { index: 7, name: 'Eye Height' },
  { index: 8, name: 'Eye Width' },
  { index: 9, name: 'Brow Height' },
  { index: 10, name: 'Brow Width' },
  { index: 11, name: 'Brow Depth' },
  { index: 12, name: 'Lip Height' },
  { index: 13, name: 'Lip Depth' },
  { index: 14, name: 'Chin Width' },
  { index: 15, name: 'Chin Height' },
  { index: 16, name: 'Chin Underbite' },
  { index: 17, name: 'Eye Depth' }
];

export const MORPH_MIN = -1;
export const MORPH_MAX = 1;

export const FACE_PRESETS = [
  { index: 0, name: 'Nose Shape', max: 31 },
  { index: 1, name: 'Brow Shape', max: 23 },
  { index: 2, name: 'Eye Shape', max: 23 },
  { index: 3, name: 'Mouth Shape', max: 23 }
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
