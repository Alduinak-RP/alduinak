import { System, Log, SystemContext, Content } from "./system";
import { espmFieldFormIds, espmRefrFieldId } from "./formIdUtil";
import { hex } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Per-character map markers and learned ingredient effects; the client's CharacterProgressService captures and replays them.
//
//   Client -> Server: { customPacketType: "knowledgeRequest" }
//                     { customPacketType: "knowledgeAdd", actorId, markers: [[desc, flags]], ingredients: [[desc, effectMask]] }
//   Server -> Client: { customPacketType: "knowledgeState", actorId, markers: [[desc, flags]], ingredients: [[desc, effectMask]] }
//
// Marker flags: 1 shown on the map, 2 discovered. Stored as "hex:Plugin" descs so a load order change never points a saved id at another form.

// Skyrim.esm MapMarker STAT, the base of every map marker REFR
const MAP_MARKER_BASE = 0x10;
const MARKER_FLAG_BITS = 2;
const MAX_ITEMS_PER_PACKET = 256;
const MAX_DESC_LENGTH = 128;
const MAX_EFFECTS = 4;
const MAX_CACHED_VERDICTS = 20000;
const REQUEST_COOLDOWN_MS = 1000;

type Kind = "marker" | "ingredient";
type Pairs = [string, number][];

const STORES: Record<Kind, { prop: string; max: number }> = {
  marker: { prop: "private.knownMarkers", max: 2000 },
  ingredient: { prop: "private.knownIngredients", max: 1000 },
};

interface Resolved {
  desc: string;
  bits: number;
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
      const state = { markers: this.read(mp, actorId, "marker"), ingredients: this.read(mp, actorId, "ingredient") };
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "knowledgeState", actorId, ...state }));
      return;
    }

    // A flush right after a character switch still names the previous character of the same profile
    const target = Number(content.actorId) >>> 0;
    if (target !== actorId && !this.sameProfile(mp, actorId, target)) return;
    const markers = this.merge(mp, target, "marker", content.markers);
    const ingredients = this.merge(mp, target, "ingredient", content.ingredients);
    if (markers || ingredients) this.log(`KnowledgeSystem: ${hex(target)} +${markers} marker update(s), +${ingredients} ingredient update(s)`);
  }

  // Merges the new bits of every valid [desc, bits] pair into the stored field; returns how many entries changed
  private merge(mp: Mp, actorId: number, kind: Kind, raw: unknown): number {
    const valid: Pairs = [];
    for (const pair of list(raw)) {
      if (!Array.isArray(pair)) continue;
      const r = this.resolve(mp, kind, pair[0]);
      const bits = r ? (Number(pair[1]) >>> 0) & ((1 << r.bits) - 1) : 0;
      if (r && bits) valid.push([r.desc, bits]);
    }
    if (!valid.length) return 0;

    const { prop, max } = STORES[kind];
    const masks = new Map(this.read(mp, actorId, kind));
    let changed = 0;
    for (const [desc, bits] of valid) {
      const old = masks.get(desc) ?? 0;
      if (!(bits & ~old) || (!old && masks.size >= max)) continue;
      masks.set(desc, old | bits);
      changed++;
    }
    if (!changed) return 0;
    try {
      mp.set(actorId, prop, Array.from(masks));
    } catch (e) {
      this.log(`KnowledgeSystem: write failed for ${hex(actorId)}: ${e}`);
      return 0;
    }
    return changed;
  }

  private read(mp: Mp, actorId: number, kind: Kind): Pairs {
    let v: unknown;
    try { v = mp.get(actorId, STORES[kind].prop); } catch { }
    return Array.isArray(v) ? v.filter((p) => Array.isArray(p) && typeof p[0] === "string" && Number.isInteger(p[1])) : [];
  }

  // Canonical desc of a real map marker REFR or ingredient, with the number of flag bits it can carry
  private resolve(mp: Mp, kind: Kind, raw: unknown): Resolved | null {
    if (typeof raw !== "string" || raw.length > MAX_DESC_LENGTH || raw.indexOf(":") <= 0) return null;
    const key = kind + "|" + raw;
    const hit = this.verdicts.get(key);
    if (hit !== undefined) return hit;
    let res: Resolved | null = null;
    try {
      const id = mp.getIdFromDesc(raw) >>> 0;
      if (kind === "marker") {
        if (espmRefrFieldId(mp, id, "NAME") === MAP_MARKER_BASE) res = { desc: mp.getDescFromId(id), bits: MARKER_FLAG_BITS };
      } else {
        const rec = mp.lookupEspmRecordById(id);
        const effects = Math.min(MAX_EFFECTS, espmFieldFormIds(rec, "EFID").length);
        if (rec?.record?.type === "INGR" && effects) res = { desc: mp.getDescFromId(id), bits: effects };
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
