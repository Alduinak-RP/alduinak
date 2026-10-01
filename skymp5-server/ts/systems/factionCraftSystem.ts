import { Settings } from "../settings";
import { System, Log, SystemContext, ACCESS_REFRESHED_EVENT } from "./system";
import { resolveEditorIds } from "./espmEditorIds";
import { addSpellTo, hex, removeSpellFrom } from "./actorUtil";
import { FactionSystem } from "./factionSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Faction crafting markers ──────────────────────────────────────────────────
//
// Faction gear is gated the way ranked gear is: the plugin gives every craft
// faction an Ability spell AldFaction_<Id> (proficiency-patcher, `factions` in
// spec.json) and its recipes carry a HasSpell condition on it, which the
// crafting menu and the server's CraftService both honour. Membership itself
// lives in the backend, never in the game's own factions, so this system is
// what ties the two together: it hands a character the marker of every faction
// whose rank carries the craft permission and takes back the rest. Hold
// uniforms are never issued: only the ranks the editor gives craft (the
// Captain, and the Jarl and an acting regent through leader authority) make the
// guard armour, helmet, shield and cloaks, and the recipe's profession tier
// still applies on top of the marker.
//
// Log: "[factionCraft] <actor> at login|after a rank reload holds the craft
// marker of <faction ids>[, granted <ids>][, revoked <ids>]", at login and on
// every change.
//
// The editor id drops the punctuation of the faction id, so "hold:the-rift"
// becomes AldFaction_holdtherift, exactly as the patcher writes it.
//
// Persistence: `private.factionMarkers`, the marker ids the character holds, on
// the actor form. A marker already in the changeform rides the spawn message
// down on its own; a new one has to wait out the client's spawn-time
// removeUnlistedSpells, the same delay the mastery system uses.
//
// server-settings.json keys (all optional):
//   factionCraftEnabled   false grants no markers, default true
//   factionCraftFactions  the faction ids that have a marker, default DEFAULT_FACTIONS

const MARKER_PROP = "private.factionMarkers";
// The client wipes and re-applies learnedSpells about a second after spawn.
const LOGIN_GRANT_DELAY_MS = 5000;

// The ids of faction-whitelist.json, mirroring `factions.list` in the patcher spec.
const DEFAULT_FACTIONS = [
  "hold:haafingar", "hold:the-reach", "hold:falkreath", "hold:hjaalmarch", "hold:eastmarch",
  "hold:winterhold", "hold:the-rift", "hold:the-pale", "hold:whiterun",
  "faction:companions", "faction:thalmor", "faction:imperial-legion", "faction:stormcloaks",
  "faction:thieves-guild", "faction:dark-brotherhood", "faction:college-of-winterhold",
  // No roster of their own yet; their markers are in the plugin, so their gear is ready to be handed out
  "faction:dawnguard", "faction:forsworn", "faction:morag-tong", "faction:skaal",
  // Created in the dashboard; a marker the plugin does not carry yet is skipped at boot
  "faction:synod", "faction:crowns", "faction:temple-of-the-divines",
  "faction:blades", "faction:camonna-tong", "faction:silver-hand", "faction:greybeards",
  "faction:psijic", "faction:mythic-dawn",
  "faction:house-redoran", "faction:house-indoril", "faction:house-telvanni",
  // The Great Houses as territories, after deploy/mongodb/migrate-morrowind-houses.js
  "hold:redoran", "hold:indoril", "hold:telvanni",
];

// The Great Houses' guild ids from before the migration to territories take the plugin's hold markers
const MARKER_ALIASES: Record<string, string> = {
  "faction:house-redoran": "hold:redoran",
  "faction:house-indoril": "hold:indoril",
  "faction:house-telvanni": "hold:telvanni",
};
const markerFactionOf = (factionId: string): string => MARKER_ALIASES[factionId] ?? factionId;

export const markerEdidOf = (factionId: string): string =>
  "AldFaction_" + factionId.replace(/[^A-Za-z0-9]/g, "");

export class FactionCraftSystem implements System {
  systemName = "FactionCraftSystem";

  constructor(private log: Log, private factions: FactionSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    if (all?.["factionCraftEnabled"] === false) {
      this.log("[factionCraft] disabled by factionCraftEnabled");
      return;
    }
    const configured = all?.["factionCraftFactions"];
    const ids = Array.isArray(configured)
      ? (configured as unknown[]).filter((v) => typeof v === "string") as string[]
      : DEFAULT_FACTIONS;

    const scan = await resolveEditorIds(ids.map((id) => markerEdidOf(markerFactionOf(id))), s.dataDir, s.loadOrder, this.log, ["SPEL"]);
    const mp = ctx.svr as Mp;
    for (const id of ids) {
      const desc = scan.resolved.get(markerEdidOf(markerFactionOf(id)).toLowerCase());
      if (!desc) continue;
      try { this.spells.set(id, mp.getIdFromDesc(desc) >>> 0); } catch { /* not in this plugin */ }
    }
    this.enabled = this.spells.size > 0;
    this.log(`[factionCraft] ready, ${this.spells.size}/${ids.length} faction marker spell(s) found in ${scan.scannedMs} ms`);
    if (!this.enabled) this.log("[factionCraft] no markers in the load order, faction recipes stay ungated");

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
      this.online.set(userId, actorId >>> 0);
      this.pending.set(actorId >>> 0, Date.now() + LOGIN_GRANT_DELAY_MS);
    });
    // applyAccess writes every online character's own copy before it fires
    ctx.gm.on(ACCESS_REFRESHED_EVENT, () => {
      for (const actorId of this.online.values()) this.sync(ctx, actorId, "after a rank reload");
    });
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    if (!this.pending.size) return;
    const now = Date.now();
    for (const [actorId, dueAt] of Array.from(this.pending)) {
      if (now < dueAt) continue;
      this.pending.delete(actorId);
      this.sync(ctx, actorId, "at login");
    }
  }

  disconnect(userId: number): void {
    const actorId = this.online.get(userId);
    this.online.delete(userId);
    if (actorId !== undefined) this.pending.delete(actorId);
  }

  // Hand over the markers of every faction whose rank may craft, take back the rest; logged at login and on every change
  private sync(ctx: SystemContext, actorId: number, when: string): void {
    if (!this.enabled) return;
    const mp = ctx.svr as Mp;
    let wanted: Set<number>;
    try {
      wanted = new Set(this.factions.factionsWith(actorId, "craft")
        .map((id) => this.spells.get(id))
        .filter((id): id is number => !!id));
    } catch {
      return;
    }
    const held = this.read(ctx, actorId);
    const keep: number[] = [];
    const revoked: number[] = [];
    const granted: number[] = [];
    // A failed call keeps the old state, so the next sync tries again
    for (const spellId of held) {
      if (wanted.has(spellId) || !this.cast(ctx, actorId, spellId, false)) keep.push(spellId);
      else revoked.push(spellId);
    }
    for (const spellId of wanted) {
      if (keep.indexOf(spellId) === -1 && this.cast(ctx, actorId, spellId, true)) {
        keep.push(spellId);
        granted.push(spellId);
      }
    }
    const changed = granted.length > 0 || revoked.length > 0;
    if (changed) {
      try { mp.set(actorId, MARKER_PROP, keep); } catch { /* actor gone */ }
    }
    if (changed || (when === "at login" && keep.length)) {
      this.log(`[factionCraft] ${hex(actorId)} ${when} holds the craft marker of ${this.factionsOf(keep)}` +
        (granted.length ? `, granted ${this.factionsOf(granted)}` : "") + (revoked.length ? `, revoked ${this.factionsOf(revoked)}` : ""));
    }
  }

  private factionsOf(spellIds: number[]): string {
    if (!spellIds.length) return "nothing";
    return spellIds.map((spellId) => {
      for (const [factionId, id] of this.spells) if (id === spellId) return markerFactionOf(factionId);
      return hex(spellId);
    }).join(", ");
  }

  private read(ctx: SystemContext, actorId: number): number[] {
    try {
      const raw = (ctx.svr as Mp).get(actorId, MARKER_PROP);
      return Array.isArray(raw) ? raw.map((v: unknown) => Number(v) >>> 0).filter((v: number) => v) : [];
    } catch {
      return [];
    }
  }

  // A console addspell would be client-local and lost on the next actor sync.
  private cast(ctx: SystemContext, actorId: number, spellId: number, grant: boolean): boolean {
    try {
      if (grant) addSpellTo(ctx.svr as Mp, actorId, spellId);
      else removeSpellFrom(ctx.svr as Mp, actorId, spellId);
      return true;
    } catch (e) {
      this.log(`[factionCraft] could not ${grant ? "grant" : "revoke"} ${hex(spellId)} ${grant ? "to" : "from"} ${hex(actorId)}: ${e}`);
      return false;
    }
  }

  private enabled = false;
  private spells = new Map<string, number>();
  private online = new Map<number, number>();
  private pending = new Map<number, number>();
}
