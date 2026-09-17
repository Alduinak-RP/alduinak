import { toFormId } from "./formIdUtil";

export interface StartLocation {
  id: string;
  label: string;
  pos: [number, number, number];
  angleZ: number;
  worldOrCell: number;
}

export interface IntroPage {
  caption?: string;
  text: string;
  // "left" suits a page of separate lines; pages are centered otherwise
  align?: "left";
}

const TAMRIEL = 0x3c;

// New characters pick one of these on the intro screens; overridable with the "startLocations" server setting, [] turns the intro off
export const DEFAULT_START_LOCATIONS: StartLocation[] = [
  { id: "dawnstar-docks", label: "Dawnstar Docks", pos: [27167.60, 110262.89, -13909.25], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "pale-pass", label: "Pale Pass - Cyrodiil Border", pos: [-51425.53, -99716.02, 1068.29], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "morrowind-gate", label: "Morrowind Gate - Riften", pos: [212996.14, -111249.54, 8059.13], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "solitude-docks", label: "Solitude Docks", pos: [-63893.07, 95463.61, -13936.59], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "dunmeth-pass", label: "Dunmeth Pass - Windhelm", pos: [174009.45, 38223.89, -9091.38], angleZ: 0, worldOrCell: TAMRIEL },
];

// Arrivals land up to this far from the point, lifted a little so a sloped offset never starts underground
const START_SPREAD_UNITS = 100;
const START_LIFT_Z = 64;

// The client swaps each bracketed placeholder for the player's key binding and drops a line whose key is unbound
export const INTRO_PAGES: IntroPage[] = [
  {
    text: "In 4E 210, nearly a decade after the Dragon Crisis, Skyrim stands transformed. To combat the Aldmeri Dominion, former enemies united alongside Hammerfell to sign The Treaty of The Nine Holds, successfully expelling the Thalmor in the brutal Second Great War. Today, the victorious but scarred province is split into three political zones: the Western Imperial Legion, the Eastern Stormcloaks, and the neutral central hub of Whiterun. As this new era begins, Skyrim's ultimate fate remains undecided.",
  },
  {
    caption: "Welcome to Alduinak",
    align: "left",
    text: [
      "Use [get alt interaction button] to open your personal menu to pick a profession.",
      "Use [get voice key button] to speak to others. Alt + [get voice key button] changes your voice range.",
      "Use [get emote wheel button] to open the emote wheel.",
      "Use [get release mouse button] to hide/reveal the mouse",
      "Use [get hide interface button] to hide the UI for screenshots.",
      "Use [get activate chat button] to use the text chat, where you will also find additional settings.",
    ].join("\n"),
  },
];

export const INTRO_QUESTION = "Where will your journey begin?";

// Validates a "startLocations" setting; null when absent or malformed so the defaults apply
export function parseStartLocations(raw: unknown): StartLocation[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StartLocation[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    const id = typeof e?.id === "string" ? e.id.trim() : "";
    const label = typeof e?.label === "string" ? e.label.trim() : "";
    const pos = Array.isArray(e?.pos) ? (e.pos as unknown[]).map(Number) : [];
    const angleZ = e?.angleZ === undefined ? 0 : Number(e.angleZ);
    const worldOrCell = e?.worldOrCell === undefined ? TAMRIEL : toFormId(e.worldOrCell);
    if (!id || !label || out.some((l) => l.id === id)) return null;
    if (pos.length !== 3 || !pos.every(Number.isFinite) || !Number.isFinite(angleZ) || !worldOrCell) return null;
    out.push({ id, label, pos: pos as [number, number, number], angleZ, worldOrCell });
  }
  return out;
}

export function arrivalPos(loc: StartLocation): [number, number, number] {
  const r = START_SPREAD_UNITS * Math.sqrt(Math.random());
  const a = Math.random() * 2 * Math.PI;
  return [loc.pos[0] + r * Math.cos(a), loc.pos[1] + r * Math.sin(a), loc.pos[2] + START_LIFT_Z];
}
