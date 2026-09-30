import { RaceEntry, RACE_GROUPS, buildRaceCatalog } from "./raceCatalog";
import { LogFn } from "./espmEditorIds";
import { userOf } from "./actorUtil";
import { sendJson } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Admin Polymorph: swaps a character's appearance race and sends its owner { customPacketType: "polymorph", on, raceId, gearOff, worn } so PolymorphService switches the skeleton

// Original look of a transformed character, kept on the actor so a logout, crash or restart puts it back
const RECORD_PROP = "private.polymorph";
// Indexed so a restart finds every character left transformed
const INDEX_PROP = "private.indexed.polymorph";
const INDEX_ON = "on";
const MORPH_COUNT = 19;
const PRESET_COUNT = 4;
// Gear comes back once the other players' copies rebuilt the original body
const REDRESS_DELAY_MS = 1500;

type Look = Record<string, any>;

interface PolymorphRecord {
  appearance: Look;
  // What was worn when a creature form took the gear off, null while the gear stayed on
  equipment: Look | null;
  race: string;
  since: number;
  by: number;
}

// One row of the adminRaces packet: desc, name, editor id, group, crash risk, male and female skeletons
export interface RaceRow {
  d: string;
  n: string;
  e: string;
  g: string;
  r: string;
  m: boolean;
  f: boolean;
}

export interface Transformed {
  entry: RaceEntry;
  from: string;
  female: boolean;
  swapped: boolean;
  gearOff: boolean;
  face: string;
}

const zeros = (n: number): number[] => new Array(n).fill(0);
const wornOf = (equipment: Look | null): Look[] =>
  (Array.isArray(equipment?.inv?.entries) ? equipment!.inv.entries : []).filter((e: Look) => e?.worn || e?.wornLeft);

export class Polymorph {
  constructor(private log: LogFn, private dataDir: string, private loadOrder: string[]) { }

  private races: RaceEntry[] | null = null;
  private byDesc = new Map<string, RaceEntry>();
  private byId: Map<number, RaceEntry> | null = null;
  private build: Promise<void> | null = null;

  get ready(): boolean {
    return !!this.races;
  }

  // Built once in the background on first use; a failed build is retried on the next call
  ensureCatalog(onReady?: () => void): void {
    if (this.races) return;
    if (!this.build) {
      const started = Date.now();
      this.build = buildRaceCatalog(this.dataDir, this.loadOrder, this.log)
        .then((races) => {
          this.races = races;
          this.byDesc = new Map(races.map((r) => [r.desc.toLowerCase(), r]));
          const groups = RACE_GROUPS.map((g) => `${races.filter((r) => r.group === g).length} ${g}`).join(", ");
          const refused = races.filter((r) => !r.male.usable && !r.female.usable).length;
          this.log(`AdminSystem: race catalog ${races.length} race(s) (${groups}), ${refused} refused without a skeleton, ${races.filter((r) => r.risk).length} marked as crash risks and refused, in ${Date.now() - started} ms`);
        })
        .catch((e) => this.log(`AdminSystem: race catalog build failed: ${e}`))
        .finally(() => { this.build = null; });
    }
    if (onReady) this.build.then(() => { if (this.races) onReady(); });
  }

  rows(): RaceRow[] {
    return (this.races ?? []).map((r) => ({ d: r.desc, n: r.name, e: r.edid, g: r.group, r: r.risk, m: r.male.usable, f: r.female.usable }));
  }

  recordOf(mp: Mp, actorId: number): PolymorphRecord | null {
    let raw: any = null;
    try { raw = mp.get(actorId, RECORD_PROP) ?? null; } catch { }
    return raw && typeof raw === "object" && raw.appearance && typeof raw.appearance === "object" ? raw as PolymorphRecord : null;
  }

  // The race name for a transformed character's row, its desc before the catalog is built
  raceName(desc: string): string {
    const entry = this.byDesc.get(desc.toLowerCase());
    return entry ? `${entry.name} (${entry.edid})` : desc;
  }

  // The first transform stores the original look; a second one keeps it, so Revert always goes back to the character's own race
  transform(mp: Mp, actorId: number, desc: string, byProfile: number): Transformed | string {
    if (!this.races) {
      this.ensureCatalog();
      return "The race list is still loading, try again shortly";
    }
    const entry = this.byDesc.get(desc.toLowerCase());
    if (!entry) return "Unknown race";
    if (!entry.male.usable && !entry.female.usable) return `${entry.edid} has no skeleton or behaviour graph, refused`;
    if (entry.risk) return `${entry.name} (${entry.edid}) is marked as a crash risk (${entry.risk}), refused`;
    const raceId = this.idOf(mp, entry.desc);
    if (!raceId) return `${entry.desc} is not in the server load order`;
    let current: Look | null = null;
    try { current = mp.get(actorId, "appearance") ?? null; } catch { }
    if (!current || typeof current !== "object") return "That character has no appearance to transform";
    const prev = this.recordOf(mp, actorId);
    const original = prev ? prev.appearance : current;
    if (raceId === (original.raceId >>> 0)) return prev ? "That is the character's own race, use Revert" : "The character already is that race";
    const female = !!original.isFemale;
    const swapped = !(female ? entry.female : entry.male).usable;
    const { look, face } = this.lookFor(mp, entry, original, raceId, swapped ? !female : female);
    look.name = current.name;
    const gearOff = entry.group === "creature";
    let equipment = prev?.equipment ?? null;
    if (gearOff && !equipment) {
      try { equipment = mp.get(actorId, "equipment") ?? null; } catch { }
      if (equipment) equipment = { ...equipment, inv: { entries: wornOf(equipment) } };
    }
    const record: PolymorphRecord = { appearance: original, equipment, race: entry.desc, since: prev?.since ?? Date.now(), by: byProfile };
    mp.set(actorId, RECORD_PROP, record);
    mp.set(actorId, INDEX_PROP, INDEX_ON);
    // Copies of other players drop the gear before the creature body arrives, so no weapon lands on a skeleton without its nodes
    if (gearOff) mp.set(actorId, "equipment", { inv: { entries: [] }, numChanges: 0 });
    mp.set(actorId, "appearance", look);
    sendJson(mp, userOf(mp, actorId), { customPacketType: "polymorph", on: true, raceId, gearOff, worn: [] });
    return { entry, from: this.nameOfId(mp, original.raceId >>> 0), female: !!look.isFemale, swapped, gearOff, face };
  }

  // Puts the stored look back with the current name, so a /mask made while transformed stays; notify false spares a client heading to the main menu
  revert(mp: Mp, actorId: number, reason: string, notify = true): PolymorphRecord | null {
    const rec = this.recordOf(mp, actorId);
    if (!rec) return null;
    let name: unknown = rec.appearance.name;
    try { name = mp.get(actorId, "appearance")?.name ?? name; } catch { }
    const worn = this.wornStillHeld(mp, actorId, rec.equipment);
    try {
      mp.set(actorId, "appearance", { ...rec.appearance, name });
      mp.set(actorId, RECORD_PROP, null);
      mp.set(actorId, INDEX_PROP, null);
    } catch (e) {
      this.log(`AdminSystem: polymorph revert of ${actorId.toString(16)} ${reason} failed: ${e}`);
      return null;
    }
    const raceId = rec.appearance.raceId >>> 0;
    if (notify) sendJson(mp, userOf(mp, actorId), { customPacketType: "polymorph", on: false, raceId, gearOff: false, worn });
    if (rec.equipment) {
      setTimeout(() => {
        if (this.recordOf(mp, actorId)) return;
        try { mp.set(actorId, "equipment", { ...rec.equipment, inv: { entries: worn } }); } catch { }
      }, REDRESS_DELAY_MS);
    }
    const held = rec.equipment ? `, ${worn.length} worn item(s) put back` : "";
    this.log(`AdminSystem: polymorph revert ${actorId.toString(16)} ${reason}: ${this.raceName(rec.race)} back to ${this.nameOfId(mp, raceId)}, transformed ${Math.round((Date.now() - rec.since) / 1000)} s by profile ${rec.by}${held}`);
    return rec;
  }

  // Every character a restart found still transformed
  transformedActors(mp: Mp): number[] {
    try {
      const ids = mp.findFormsByPropertyValue(INDEX_PROP, INDEX_ON);
      return Array.isArray(ids) ? ids.map((id: unknown) => Number(id) >>> 0) : [];
    } catch {
      return [];
    }
  }

  // Keeps the face for the character's own race and its vampire form, else the race's default head, and none for a race without FaceGen
  private lookFor(mp: Mp, entry: RaceEntry, original: Look, raceId: number, female: boolean): { look: Look; face: string } {
    const originalId = original.raceId >>> 0;
    const vampireBaseOf = (e: RaceEntry | undefined): number => (e && e.group === "vampire" ? this.idOf(mp, e.morph) : 0);
    if (female === !!original.isFemale && (vampireBaseOf(entry) === originalId || vampireBaseOf(this.entryById(mp, originalId)) === raceId)) {
      return { look: { ...original, raceId }, face: "own face kept" };
    }
    const base: Look = { ...original, raceId, isFemale: female, headpartIds: [], headTextureSetId: 0, options: zeros(MORPH_COUNT), presets: zeros(PRESET_COUNT), tints: [] };
    if (!entry.faceGen) return { look: { ...base, skinColor: 0, hairColor: 0 }, face: "no FaceGen head" };
    const sex = female ? entry.female : entry.male;
    const headpartIds = sex.head.map((d) => this.idOf(mp, d)).filter((id) => id !== 0);
    return { look: { ...base, headpartIds, headTextureSetId: this.idOf(mp, sex.faceTexture) }, face: `race default head (${headpartIds.length} part(s))` };
  }

  // Worn entries of the stored equipment whose item the character still carries
  private wornStillHeld(mp: Mp, actorId: number, equipment: Look | null): Look[] {
    let held: Look[] = [];
    try { held = mp.get(actorId, "inventory")?.entries ?? []; } catch { }
    const has = new Set(held.filter((e) => Number(e?.count) > 0).map((e) => Number(e.baseId) >>> 0));
    return wornOf(equipment).filter((e) => has.has(Number(e.baseId) >>> 0));
  }

  private idOf(mp: Mp, desc: string): number {
    if (!desc) return 0;
    try { return Number(mp.getIdFromDesc(desc)) >>> 0; } catch { return 0; }
  }

  private entryById(mp: Mp, id: number): RaceEntry | undefined {
    if (!this.byId && this.races) this.byId = new Map(this.races.map((r) => [this.idOf(mp, r.desc), r]));
    return this.byId?.get(id);
  }

  private nameOfId(mp: Mp, id: number): string {
    const entry = this.entryById(mp, id);
    return entry ? `${entry.name} (${entry.edid})` : `race ${id.toString(16)}`;
  }
}
