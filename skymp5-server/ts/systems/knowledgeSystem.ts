import { System, Log, SystemContext, Content } from "./system";
import { espmFieldFormIds, espmRefrFieldId } from "./formIdUtil";
import { hex } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Per-character discovered map markers and learned ingredient effects; the client's CharacterProgressService captures and replays them.
//
//   Client -> Server: { customPacketType: "knowledgeRequest" }
//                     { customPacketType: "knowledgeAdd", actorId, markers: [desc], ingredients: [[desc, effectMask]] }
//   Server -> Client: { customPacketType: "knowledgeState", actorId, markers: [desc], ingredients: [[desc, effectMask]] }
//
// Stored as "hex:Plugin" descs so a load order change never points a saved id at another form.

const MARKERS_PROP = "private.knownMarkers";
const INGREDIENTS_PROP = "private.knownIngredients";
// Skyrim.esm MapMarker STAT, the base of every map marker REFR
const MAP_MARKER_BASE = 0x10;
const MAX_MARKERS = 2000;
const MAX_INGREDIENTS = 1000;
const MAX_ITEMS_PER_PACKET = 256;
const MAX_DESC_LENGTH = 128;
const MAX_EFFECTS = 4;
const MAX_CACHED_VERDICTS = 20000;
const REQUEST_COOLDOWN_MS = 1000;

interface Resolved {
  desc: string;
  effects: number;
}

interface Knowledge {
  markers: string[];
  ingredients: [string, number][];
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS_PER_PACKET) : []);

export class KnowledgeSystem implements System {
  systemName = "KnowledgeSystem";
  constructor(private log: Log) { }

  // Keyed by kind + raw desc; plugins never change at runtime
  private verdicts = new Map<string, Resolved | null>();
  private lastRequest = new Map<number, number>();

  disconnect(userId: number): void {
    this.lastRequest.delete(userId);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "knowledgeRequest" && type !== "knowledgeAdd") return;
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = mp.getUserActor(userId) >>> 0; } catch { }
    if (!actorId) return;

    if (type === "knowledgeRequest") {
      const now = Date.now();
      if (now - (this.lastRequest.get(userId) ?? 0) < REQUEST_COOLDOWN_MS) return;
      this.lastRequest.set(userId, now);
      const state = this.read(mp, actorId);
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "knowledgeState", actorId, ...state }));
      return;
    }

    // A flush right after a character switch still names the previous character of the same profile
    const target = Number(content.actorId) >>> 0;
    if (target !== actorId && !this.sameProfile(mp, actorId, target)) return;
    this.add(mp, target, content);
  }

  private add(mp: Mp, actorId: number, content: Content): void {
    const state = this.read(mp, actorId);
    const markers = new Set(state.markers);
    const masks = new Map(state.ingredients);
    let newMarkers = 0;
    let newEffects = 0;

    for (const raw of list(content.markers)) {
      if (markers.size >= MAX_MARKERS) break;
      const r = this.resolve(mp, "marker", raw);
      if (!r || markers.has(r.desc)) continue;
      markers.add(r.desc);
      newMarkers++;
    }

    for (const pair of list(content.ingredients)) {
      if (!Array.isArray(pair)) continue;
      const r = this.resolve(mp, "ingredient", pair[0]);
      if (!r) continue;
      const old = masks.get(r.desc) ?? 0;
      const bits = (Number(pair[1]) >>> 0) & ((1 << r.effects) - 1) & ~old;
      if (!bits || (!old && masks.size >= MAX_INGREDIENTS)) continue;
      masks.set(r.desc, old | bits);
      newEffects++;
    }

    try {
      if (newMarkers) mp.set(actorId, MARKERS_PROP, Array.from(markers));
      if (newEffects) mp.set(actorId, INGREDIENTS_PROP, Array.from(masks));
    } catch (e) {
      this.log(`KnowledgeSystem: write failed for ${hex(actorId)}: ${e}`);
      return;
    }
    if (newMarkers || newEffects) this.log(`KnowledgeSystem: ${hex(actorId)} +${newMarkers} marker(s), +${newEffects} ingredient update(s)`);
  }

  private read(mp: Mp, actorId: number): Knowledge {
    let markers: unknown;
    let ingredients: unknown;
    try {
      markers = mp.get(actorId, MARKERS_PROP);
      ingredients = mp.get(actorId, INGREDIENTS_PROP);
    } catch { }
    return {
      markers: Array.isArray(markers) ? markers.filter((d) => typeof d === "string") : [],
      ingredients: Array.isArray(ingredients)
        ? ingredients.filter((p) => Array.isArray(p) && typeof p[0] === "string" && Number.isInteger(p[1]))
        : [],
    };
  }

  // Canonical desc of a real map marker REFR or ingredient, with the ingredient's effect count
  private resolve(mp: Mp, kind: "marker" | "ingredient", raw: unknown): Resolved | null {
    if (typeof raw !== "string" || raw.length > MAX_DESC_LENGTH || raw.indexOf(":") <= 0) return null;
    const key = kind + "|" + raw;
    const hit = this.verdicts.get(key);
    if (hit !== undefined) return hit;
    let res: Resolved | null = null;
    try {
      const id = mp.getIdFromDesc(raw) >>> 0;
      if (kind === "marker") {
        if (espmRefrFieldId(mp, id, "NAME") === MAP_MARKER_BASE) res = { desc: mp.getDescFromId(id), effects: 0 };
      } else {
        const rec = mp.lookupEspmRecordById(id);
        const effects = Math.min(MAX_EFFECTS, espmFieldFormIds(rec, "EFID").length);
        if (rec?.record?.type === "INGR" && effects) res = { desc: mp.getDescFromId(id), effects };
      }
    } catch { /* plugin not loaded or not an espm record */ }
    if (this.verdicts.size < MAX_CACHED_VERDICTS) this.verdicts.set(key, res);
    return res;
  }

  private sameProfile(mp: Mp, a: number, b: number): boolean {
    try {
      const profile = Number(mp.get(a, "profileId"));
      return profile >= 0 && Number(mp.get(b, "profileId")) === profile;
    } catch {
      return false;
    }
  }
}
