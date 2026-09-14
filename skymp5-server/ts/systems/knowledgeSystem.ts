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
const RATE_WINDOW_MS = 1000;
// A client sends adds every 1.5 s and drains a backlog in a few packets
const MAX_ADDS_PER_WINDOW = 5;

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

  // Real forms only, keyed by kind + form id, so the load order bounds it
  private verdicts = new Map<string, Resolved>();
  // Per packet type and user: start of the current window and packets seen in it
  private windows = new Map<string, { at: number; n: number }>();

  disconnect(userId: number): void {
    this.windows.delete(`knowledgeRequest|${userId}`);
    this.windows.delete(`knowledgeAdd|${userId}`);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "knowledgeRequest" && type !== "knowledgeAdd") return;
    const mp = ctx.svr as Mp;
    let actorId = 0;
    try { actorId = mp.getUserActor(userId) >>> 0; } catch { }
    if (!actorId || !this.allow(userId, type)) return;

    if (type === "knowledgeRequest") {
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

  // One request and MAX_ADDS_PER_WINDOW adds per user per window
  private allow(userId: number, type: string): boolean {
    const now = Date.now();
    const key = `${type}|${userId}`;
    const w = this.windows.get(key);
    if (w && now - w.at < RATE_WINDOW_MS) return ++w.n <= (type === "knowledgeAdd" ? MAX_ADDS_PER_WINDOW : 1);
    this.windows.set(key, { at: now, n: 1 });
    return true;
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
    try {
      const id = mp.getIdFromDesc(raw) >>> 0;
      const key = kind + id;
      const hit = this.verdicts.get(key);
      if (hit) return hit;
      let res: Resolved | null = null;
      if (kind === "marker") {
        if (espmRefrFieldId(mp, id, "NAME") === MAP_MARKER_BASE) res = { desc: mp.getDescFromId(id), bits: MARKER_FLAG_BITS };
      } else {
        const rec = mp.lookupEspmRecordById(id);
        const effects = Math.min(MAX_EFFECTS, espmFieldFormIds(rec, "EFID").length);
        if (rec?.record?.type === "INGR" && effects) res = { desc: mp.getDescFromId(id), bits: effects };
      }
      if (res) this.verdicts.set(key, res);
      return res;
    } catch {
      return null; // plugin not loaded or not an espm record
    }
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
