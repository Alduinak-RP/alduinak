import { scanRecords, espmDesc, cstr, LogFn, EspmRecord } from "./espmEditorIds";

// Playable hair from mod plugins for the character creator; vanilla hair already ships in skymp5-front's headparts.json.

const VANILLA_PLUGINS = new Set(["skyrim.esm", "update.esm", "dawnguard.esm", "hearthfires.esm", "dragonborn.esm"]);
const HDPT_TYPE_HAIR = 3;
const HDPT_PLAYABLE = 0x01;
const HDPT_MALE = 0x02;
const HDPT_FEMALE = 0x04;
const HDPT_EXTRA = 0x08;

export interface ModHair {
  // "hex:Plugin"; the client resolves it against its own load order
  desc: string;
  label: string;
  male: boolean;
  female: boolean;
  // Index into ModHairCatalog.raceSets
  races: number;
  extras: string[];
}

export interface ModHairCatalog {
  // Race editor ids, shared because most hair mods reuse one vanilla FormList
  raceSets: string[][];
  hairs: ModHair[];
}

interface HairDraft {
  desc: string;
  label: string;
  flags: number;
  racesDesc: string;
  extras: string[];
}

const u32 = (b: Buffer): number => (b.length >= 4 ? b.readUInt32LE(0) : 0);
const fieldOf = (rec: EspmRecord, type: string): Buffer | undefined => rec.fields.find((f) => f.type === type)?.data;
const descOf = (rec: EspmRecord, formId: number): string => espmDesc(formId, rec.masters, rec.owner);
const pluginOf = (desc: string): string => desc.slice(desc.indexOf(":") + 1).toLowerCase();

export async function scanModHair(dataDir: string, loadOrder: string[], log: LogFn): Promise<ModHairCatalog> {
  // Keyed by lower-case desc; later plugins overwrite, matching engine override order
  const raceEditorIds = new Map<string, string>();
  const formLists = new Map<string, string[]>();
  const drafts = new Map<string, HairDraft>();

  await scanRecords(dataDir, loadOrder, ["RACE", "FLST", "HDPT"], log, (rec) => {
    const desc = descOf(rec, rec.formId);
    const key = desc.toLowerCase();
    if (rec.type === "RACE") {
      const edid = fieldOf(rec, "EDID");
      if (edid) raceEditorIds.set(key, cstr(edid));
    } else if (rec.type === "FLST") {
      formLists.set(key, rec.fields.filter((f) => f.type === "LNAM").map((f) => descOf(rec, u32(f.data)).toLowerCase()));
    } else {
      const pnam = fieldOf(rec, "PNAM");
      const data = fieldOf(rec, "DATA");
      const rnam = fieldOf(rec, "RNAM");
      if (VANILLA_PLUGINS.has(pluginOf(desc)) || !pnam || u32(pnam) !== HDPT_TYPE_HAIR || !data || !rnam) {
        drafts.delete(key);
        return;
      }
      const edid = cstr(fieldOf(rec, "EDID") ?? Buffer.alloc(0));
      const full = fieldOf(rec, "FULL");
      drafts.set(key, {
        desc,
        label: (!rec.localized && full && cstr(full)) || edid,
        flags: data[0],
        racesDesc: descOf(rec, u32(rnam)).toLowerCase(),
        extras: rec.fields.filter((f) => f.type === "HNAM").map((f) => descOf(rec, u32(f.data))),
      });
    }
  });

  const raceSets: string[][] = [];
  const raceSetIndex = new Map<string, number>();
  const hairs: ModHair[] = [];
  for (const d of drafts.values()) {
    if (!(d.flags & HDPT_PLAYABLE) || (d.flags & HDPT_EXTRA)) continue;
    const races = (formLists.get(d.racesDesc) ?? [])
      .map((r) => raceEditorIds.get(r))
      .filter((r): r is string => !!r);
    if (!races.length) continue;
    const setKey = races.join("|");
    let setIndex = raceSetIndex.get(setKey);
    if (setIndex === undefined) {
      setIndex = raceSets.push(races) - 1;
      raceSetIndex.set(setKey, setIndex);
    }
    hairs.push({
      desc: d.desc,
      label: d.label,
      male: !!(d.flags & HDPT_MALE),
      female: !!(d.flags & HDPT_FEMALE),
      races: setIndex,
      extras: d.extras,
    });
  }
  return { raceSets, hairs };
}
