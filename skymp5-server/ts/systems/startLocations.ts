import { toFormId } from "./formIdUtil";
import { loc } from "../loc";

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
  { id: "hammerfell-gate", label: "Hammerfell Gate - Falkreath", pos: [-51425.53, -99716.02, 1068.29], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "pale-pass", label: "Pale Pass - Helgen", pos: [27471, -115853, 20361], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "morrowind-gate", label: "Morrowind Gate - Riften", pos: [212996.14, -111249.54, 8059.13], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "solitude-docks", label: "Solitude Docks", pos: [-63893.07, 95463.61, -13936.59], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "dunmeth-pass", label: "Dunmeth Pass - Windhelm", pos: [174009.45, 38223.89, -9091.38], angleZ: 0, worldOrCell: TAMRIEL },
  { id: "druadach-pass", label: "Druadach Pass - High Rock", pos: [-159824, 94571, -8524], angleZ: 0, worldOrCell: TAMRIEL },
];

// Arrivals land up to this far from the point, lifted a little so a sloped offset never starts underground
const START_SPREAD_UNITS = 100;
const START_LIFT_Z = 64;

const welcomeLines = (): string[] => [
  loc("intro.welcome.voice"),
  loc("intro.welcome.emoteWheel"),
  loc("intro.welcome.releaseMouse"),
  loc("intro.welcome.hideInterface"),
  loc("intro.welcome.chat"),
];

const withArticle = (word: string): string => (/^[aeiou]/i.test(word) ? loc("intro.articleAn", { word: word.toLowerCase() }) : loc("intro.articleA", { word: word.toLowerCase() }));

// The profession line for the configured craft slots, for example "... a primary craft, then a secondary (up to Adept) and a tertiary (up to Novice)."
export function professionIntroLine(slots: Array<{ name: string; capName: string }>): string {
  const menuKeyLine = loc("intro.menuKeyLine");
  if (slots.length < 2) return loc("intro.professionOne", { menuKeyLine });
  const subs = slots.slice(1).map((s) => loc("intro.subCraft", { craft: withArticle(s.name), cap: s.capName }));
  return loc("intro.professionMany", { menuKeyLine, first: withArticle(slots[0].name), subs: subs.join(loc("intro.and")) });
}

// The client swaps each bracketed placeholder for the player's key binding and drops a line whose key is unbound
export const INTRO_PAGES: IntroPage[] = [
  {
    text: loc("intro.lore"),
  },
  {
    caption: loc("intro.welcomeCaption"),
    align: "left",
    text: [professionIntroLine([])].concat(welcomeLines()).join("\n"),
  },
];

// MasterySystem states its craft slots at boot; Spawn reads the pages at each intro
export function setIntroProfessions(slots: Array<{ name: string; capName: string }>): void {
  INTRO_PAGES[1].text = [professionIntroLine(slots)].concat(welcomeLines()).join("\n");
}

export const INTRO_QUESTION = loc("intro.question");

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
