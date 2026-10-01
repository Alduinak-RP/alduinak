import { scanRecords, espmDesc, cstr, LogFn, EspmRecord } from "./espmEditorIds";
import { createStringsReader } from "./espmStrings";
import { fieldOf, fullName } from "./itemCatalog";

// Races of the server load order for the admin Polymorph tab; the last override of each record wins, like in game

export type RaceGroup = "playable" | "vampire" | "people" | "creature";

export const RACE_GROUPS: RaceGroup[] = ["playable", "vampire", "people", "creature"];

export interface RaceSex {
  // Skeleton and behaviour graph both set for this sex
  usable: boolean;
  // Default head parts with their extra parts, as descs
  head: string[];
  faceTexture: string;
}

export interface RaceEntry {
  desc: string;
  edid: string;
  name: string;
  group: RaceGroup;
  faceGen: boolean;
  // Desc of the morph race (NAM8), the base race of a vampire form; "" when none
  morph: string;
  // Why the race is a known crash risk, "" when none is known
  risk: string;
  // False without a shield biped object: the engine's weapon draw then reads before the player's biped slots and crashes
  shield: boolean;
  // Attack events of the race's attack data (ATKE) a creature form attacks with: no bashes, power attacks only when it has nothing else
  attacks: string[];
  male: RaceSex;
  female: RaceSex;
}

// RACE DATA flags follow the skill boosts, heights and weights
const FLAGS_OFFSET = 32;
// Shield Biped Object, -1 for none
const SHIELD_OFFSET = 80;
const MAX_ATTACKS = 8;
const PLAYABLE = 0x1;
const FACEGEN = 0x2;
const CHILD = 0x4;
const SWIMS = 0x40;
const FLIES = 0x80;
const WALKS = 0x100;
const IMMOBILE = 0x200;
const FLAG_DELETED = 0x20;

const PROP_RACES = /^(defaultrace|testrace|testdraugrrace|invisiblerace|manakinrace|dunmiddenemptyrace)$|rigidskeleton|fakecoffin|duninstruments|magicanomaly|swarm|wisp|witchlight|ballista/i;
const BEAST_FORMS = /werewolfbeast|werebearbeast|vampirebeast/i;

interface SexDraft {
  skeleton: boolean;
  graph: boolean;
  head: string[];
  faceTexture: string;
}

interface RaceDraft {
  desc: string;
  edid: string;
  name: string;
  flags: number;
  morph: string;
  keywords: string[];
  shield: boolean;
  attacks: string[];
  male: SexDraft;
  female: SexDraft;
}

const u32 = (b: Buffer): number => (b.length >= 4 ? b.readUInt32LE(0) : 0);
const emptySex = (): SexDraft => ({ skeleton: false, graph: false, head: [], faceTexture: "" });

// Skeletons sit between DATA and NAM1, behaviour graphs under NAM3 and default heads under NAM0; MNAM and FNAM open each sex
function readSexes(rec: EspmRecord, descOf: (id: number) => string): { male: SexDraft; female: SexDraft } {
  const out = { male: emptySex(), female: emptySex() };
  let section = "";
  let sex: SexDraft | null = null;
  for (const f of rec.fields) {
    if (f.type === "DATA" || f.type === "NAM1" || f.type === "NAM3" || f.type === "NAM0" || f.type === "NAM4") {
      section = f.type;
      sex = null;
    } else if (f.type === "MNAM") sex = out.male;
    else if (f.type === "FNAM") sex = out.female;
    else if (f.type === "DFTM") out.male.faceTexture = descOf(u32(f.data));
    else if (f.type === "DFTF") out.female.faceTexture = descOf(u32(f.data));
    else if (!sex) continue;
    else if (section === "DATA" && f.type === "ANAM") sex.skeleton = cstr(f.data).length > 0;
    else if (section === "NAM3" && f.type === "MODL") sex.graph = cstr(f.data).length > 0;
    else if (section === "NAM0" && f.type === "HEAD") sex.head.push(descOf(u32(f.data)));
  }
  return out;
}

function groupOf(d: RaceDraft, drafts: Map<string, RaceDraft>): RaceGroup {
  if (d.flags & PLAYABLE) return "playable";
  const base = d.morph ? drafts.get(d.morph.toLowerCase()) : undefined;
  if (base && (base.flags & PLAYABLE) && d.keywords.includes("vampire")) return "vampire";
  return (d.flags & FACEGEN) || d.keywords.includes("actortypenpc") ? "people" : "creature";
}

// Bashes need a shield or weapon, and a race with plain attacks keeps its power attacks for the AI
function attackEvents(rec: EspmRecord): string[] {
  const events = rec.fields.filter((f) => f.type === "ATKE").map((f) => cstr(f.data)).filter((e) => e.length > 0 && !/bash/i.test(e));
  const plain = events.filter((e) => !/power/i.test(e));
  return (plain.length ? plain : events).slice(0, MAX_ATTACKS);
}

function riskOf(d: RaceDraft): string {
  if (PROP_RACES.test(d.edid)) return "placeholder, prop or effect race without a playable body";
  if (d.flags & FLIES) return "flying race: players cannot fly it and dragon forms are known to crash";
  if (d.flags & IMMOBILE) return "immobile race";
  if ((d.flags & SWIMS) && !(d.flags & WALKS)) return "water-only race";
  if (BEAST_FORMS.test(d.edid)) return "beast form without its transform quest: its powers and HUD may break";
  if (d.keywords.includes("actortypehorse")) return "horse: other players may try to mount it";
  return "";
}

export async function buildRaceCatalog(dataDir: string, loadOrder: string[], log: LogFn): Promise<RaceEntry[]> {
  const strings = createStringsReader(dataDir, log);
  const keywordIds = new Map<string, string>();
  const extras = new Map<string, string[]>();
  const drafts = new Map<string, RaceDraft>();
  await scanRecords(dataDir, loadOrder, ["KYWD", "HDPT", "RACE"], log, (rec) => {
    const descOf = (id: number): string => espmDesc(id, rec.masters, rec.owner);
    const key = descOf(rec.formId).toLowerCase();
    const edid = cstr(fieldOf(rec, "EDID") ?? Buffer.alloc(0));
    if (rec.type === "KYWD") {
      keywordIds.set(key, edid.toLowerCase());
      return;
    }
    if (rec.type === "HDPT") {
      extras.set(key, rec.fields.filter((f) => f.type === "HNAM").map((f) => descOf(u32(f.data))));
      return;
    }
    const data = fieldOf(rec, "DATA");
    const flags = data && data.length >= FLAGS_OFFSET + 4 ? data.readUInt32LE(FLAGS_OFFSET) : 0;
    if ((rec.flags & FLAG_DELETED) || (flags & CHILD)) {
      drafts.delete(key);
      return;
    }
    const kwda = fieldOf(rec, "KWDA");
    const keywords: string[] = [];
    for (let i = 0; kwda && i + 4 <= kwda.length; i += 4) keywords.push(descOf(kwda.readUInt32LE(i)).toLowerCase());
    const nam8 = fieldOf(rec, "NAM8");
    const prev = drafts.get(key);
    drafts.set(key, {
      desc: prev?.desc ?? descOf(rec.formId),
      edid,
      name: fullName(rec, strings) || prev?.name || "",
      flags,
      morph: nam8 ? descOf(u32(nam8)) : "",
      keywords,
      shield: !!data && data.length >= SHIELD_OFFSET + 4 && data.readInt32LE(SHIELD_OFFSET) >= 0,
      attacks: attackEvents(rec),
      ...readSexes(rec, descOf),
    });
  });

  const withExtras = (head: string[]): string[] => {
    const out = [...head];
    for (const part of head) out.push(...(extras.get(part.toLowerCase()) ?? []));
    return Array.from(new Set(out));
  };
  const sexOf = (s: SexDraft): RaceSex => ({ usable: s.skeleton && s.graph, head: withExtras(s.head), faceTexture: s.faceTexture });
  const races: RaceEntry[] = [];
  for (const d of drafts.values()) {
    d.keywords = d.keywords.map((k) => keywordIds.get(k) ?? k);
    races.push({
      desc: d.desc,
      edid: d.edid,
      name: d.name || d.edid,
      group: groupOf(d, drafts),
      faceGen: !!(d.flags & FACEGEN),
      morph: d.morph,
      risk: riskOf(d),
      shield: d.shield,
      attacks: d.attacks,
      male: sexOf(d.male),
      female: sexOf(d.female),
    });
  }
  return races.sort((a, b) => RACE_GROUPS.indexOf(a.group) - RACE_GROUPS.indexOf(b.group) || a.name.localeCompare(b.name) || a.edid.localeCompare(b.edid));
}
