import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Mastery: one profession per character, ranked by hours of work ────────────
//
// A character picks a single profession and keeps it. Rank comes from hours
// spent at the craft: every server-observed activity that belongs to the
// character's profession is worth one point, and the next point cannot be
// earned until an hour has passed since the last one. One point is one hour,
// so 40/100/180 points make Adept/Expert/Master. Nothing polls: this system
// chains the native onCraft/onActivate/onEatItem hooks on `mp` (the way
// HousingSystem does) and the gamemode relays onDeath/onHitDamage through
// globalThis.__alduinakMasteryEvent (gamemode_extensions/62_mastery.js, which
// re-owns those two handlers on every hot reload). Every event is validated
// by the C++ server before it fires and re-checked here for reach and
// ownership, so a modified client cannot mint points. Each rank grants a marker spell;
// recipes in the Alduinak plugin carry a HasSpell condition for the marker,
// which is the one gate the engine honours on both sides: the vanilla crafting
// menu hides recipes the player cannot make, and the server independently
// refuses a forged craft packet for them.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "masteryInfoRequest" }
//     { customPacketType: "masteryChoose", profession: "<id>" }
//   Server -> Client:
//     { customPacketType: "masteryMenu", profession, rank, hours, rankHours, professions: [...] }
//     { customPacketType: "masteryNotice", text }
//
// Persistence: `private.mastery` on the character's actor form, which rides the
// changeform into Mongo. Hours are per character by design - an alt starts at
// Novice - so the record belongs on the actor, never on the profile.
//
// server-settings.json keys (all optional):
//   masteryRankHours             [adept, expert, master] thresholds, default [40, 100, 180]
//   masteryPointIntervalMinutes  minimum gap between two points, default 60
//   masterySpells                { "<professionId>": [noviceSpell, adept, expert, master] }
//                                form ids from the Alduinak plugin; professions absent
//                                from the map simply grant no spell.
//   masteryActivities            { "<professionId>": { craftKeywords, activatePrefixes,
//                                activateTypes, eatIngredient, killKeywords,
//                                hitKeywords } } overriding
//                                DEFAULT_ACTIVITIES key by key. Keywords take an
//                                editor id ("CraftingSmithingForge"), a hex id
//                                ("0x88105") or a desc ("88105:Skyrim.esm").

const MASTERY_PROP = "private.mastery";

const DEFAULT_RANK_HOURS = [40, 100, 180];
const DEFAULT_POINT_INTERVAL_MINUTES = 60;
const CHOOSE_COOLDOWN_MS = 1000;
// Admin grants are for testing and corrections, never a bulk import.
export const MAX_GRANT = 1000;
// Events queue up between ticks; anything past this is a runaway loop.
const MAX_QUEUED_EVENTS = 4096;
// The C++ only checks that an activator shares the target's world and never
// asks where a crafter stands, so a forged packet from across Tamriel would
// otherwise count as work. Generous next to the engine's own reach so a tall
// vein or a wide forge still qualifies.
const ACTIVATE_REACH = 600;
// Bow and crossbow hits skip the engine's distance check, and the engine lets
// melee land from a cell away; the reach the engine means for each is used
// instead, with room for the biggest creature bounds.
const RANGED_REACH = 8192;
const MELEE_REACH = 400;
// WEAP DNAM animation types that shoot.
const ANIM_BOW = 7;
const ANIM_CROSSBOW = 9;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
// The client wipes and re-applies learnedSpells about a second after spawn;
// a login backfill has to land after that.
const LOGIN_GRANT_DELAY_MS = 5000;

export const RANK_NAMES = ["Novice", "Adept", "Expert", "Master"];

interface Profession {
  id: string;
  label: string;
  title: string;
}

// Order matches the menu's left-hand column.
const PROFESSIONS: Profession[] = [
  { id: "alchemist", label: "Alchemist", title: "The Patient Hand" },
  { id: "blacksmith", label: "Blacksmith", title: "The Forge-Bound" },
  { id: "cook", label: "Cook", title: "The Hearthkeeper" },
  { id: "hunter", label: "Hunter", title: "The Far Tracker" },
  { id: "miner", label: "Miner", title: "The Deep Delver" },
  { id: "tailor", label: "Tailor", title: "The Fine Thread" },
  { id: "warrior", label: "Warrior", title: "The Steadfast Guardian" },
  { id: "woodworker", label: "Woodworker", title: "The Grain Reader" },
];

const PROFESSION_IDS = PROFESSIONS.map((p) => p.id);

// What counts as work, per profession. Every list is optional; an empty list
// never matches. Keywords are resolved to global form ids at boot.
interface ActivityRules {
  // Recipe (COBJ) workbench keyword of a server-validated craft.
  craftKeywords: string[];
  // Editor id prefix of the activated reference's base object.
  activatePrefixes: string[];
  // Record type of the activated reference's base object (FLOR, TREE...).
  activateTypes: string[];
  // Eating a raw ingredient to learn its effects.
  eatIngredient: boolean;
  // Keywords on the victim's base or race when this character lands the kill.
  killKeywords: string[];
  // Keywords on the target's base or race when this character lands a hit.
  hitKeywords: string[];
}

const ACTOR_TYPES = ["ActorTypeNPC", "ActorTypeCreature", "ActorTypeUndead", "ActorTypeDaedra", "ActorTypeDwarven", "ActorTypeDragon", "ActorTypeGiant", "ActorTypeTroll"];

// Player actors have no base record; their race is always a playable one.
const PLAYER_KEYWORD = "ActorTypeNPC";

const DEFAULT_ACTIVITIES: Record<string, Partial<ActivityRules>> = {
  // Potion brewing is client-side (and cooked food is an ALCH record too), so
  // the lab, the herbs and the tasting are what count.
  alchemist: { activateTypes: ["FLOR", "TREE"], activatePrefixes: ["CraftingAlchemyWorkbench"], eatIngredient: true },
  // Tempering never reaches the server as a craft, so the grindstone and the
  // workbench cannot count.
  blacksmith: { craftKeywords: ["CraftingSmithingForge", "CraftingSmelter", "CraftingSmithingSkyforge", "DLC2CraftingSmithingSkaalForge"] },
  cook: { craftKeywords: ["CraftingCookpot", "BYOHCraftingOven"] },
  hunter: { killKeywords: ["ActorTypeAnimal"] },
  // Veins hand the swing to a linked PickaxeMining*Marker furniture.
  miner: { activatePrefixes: ["MineOre", "PickaxeMining"] },
  // MoreCraftableEquipment clothes and cloaks are woven at its loom.
  tailor: { craftKeywords: ["CraftingTanningRack", "MCE_CraftingLoom"] },
  warrior: { hitKeywords: ACTOR_TYPES },
  // Hearthfire recipes name BYOHBuildingCarpenter; the bench also carries BYOHCarpenterTable.
  woodworker: { activatePrefixes: ["WoodChoppingBlock", "DLC2WoodChoppingBlock"], craftKeywords: ["BYOHCarpenterTable", "BYOHBuildingCarpenter"] },
};

const ACTIVITY_KINDS = ["craft", "activate", "eat", "kill", "hit"] as const;
type ActivityKind = typeof ACTIVITY_KINDS[number];

interface ActivityEvent {
  kind: ActivityKind;
  actorId: number;
  detail: Record<string, number>;
}

// Rules with every keyword resolved to a global form id and types upper-cased.
interface ResolvedRules {
  craftKeywords: Set<number>;
  activatePrefixes: string[];
  activateTypes: Set<string>;
  eatIngredient: boolean;
  killKeywords: Set<number>;
  hitKeywords: Set<number>;
}

interface MasteryRecord {
  profession: string | null;
  points: number;
  // Epoch ms of the last point; 0 when none has been earned yet.
  lastPointAt: number;
  rank: number;
  // Marker spells already handed to this character, so a login does not
  // re-grant them into the client's spawn-time spell wipe.
  granted: number[];
}

// What the admin panel shows for one character.
export interface MasterySummary {
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
}

interface BaseInfo {
  id: number;
  type: string;
  editorId: string;
}

interface Location {
  cell: string;
  pos: number[];
}

const emptyRecord = (): MasteryRecord => ({ profession: null, points: 0, lastPointAt: 0, rank: 0, granted: [] });

const stringList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];

export class MasterySystem implements System {
  systemName = "MasterySystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const hours = all?.["masteryRankHours"];
    if (Array.isArray(hours) && hours.length === 3 && hours.every((h) => Number.isFinite(Number(h)))) {
      this.rankHours = hours.map((h) => Number(h));
    }
    const interval = Number(all?.["masteryPointIntervalMinutes"]);
    if (Number.isFinite(interval) && interval > 0) this.intervalMs = interval * 60000;

    const spells = all?.["masterySpells"];
    if (spells && typeof spells === "object") {
      for (const id of PROFESSION_IDS) {
        const list = (spells as Record<string, unknown>)[id];
        if (Array.isArray(list) && list.length === RANK_NAMES.length) {
          this.spells[id] = list.map((v) => Number(v) >>> 0);
        }
      }
    }

    await this.loadRules(ctx, all?.["masteryActivities"], s.dataDir, s.loadOrder);

    const configured = Object.keys(this.spells).length;
    this.log(`[mastery] ready, ranks at ${this.rankHours.join("/")}h, one point per ${this.intervalMs / 60000} min, ${configured}/${PROFESSION_IDS.length} professions have marker spells`);
    if (configured < PROFESSION_IDS.length) {
      this.log(`[mastery] professions without masterySpells grant no recipes yet`);
    }

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
      this.onActorAssigned(ctx, userId, actorId >>> 0);
    });

    // Events are only queued so every property write and Papyrus call runs
    // outside the native event call stack.
    (globalThis as any).__alduinakMasteryEvent = (kind: string, actorId: number, detail: unknown) => {
      this.enqueue(kind, actorId, detail);
    };
    this.hookNativeEvents(ctx);
  }

  // Chain onto whatever already owns these `mp` hooks (housing and the bounty
  // board wrap onActivate the same way) and never change their verdict.
  private hookNativeEvents(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const chain = (name: string, kind: ActivityKind, pick: (args: unknown[]) => [unknown, Record<string, unknown>]) => {
      const previous = typeof mp[name] === "function" ? mp[name] : null;
      mp[name] = (...args: unknown[]) => {
        const verdict = previous ? previous(...args) : undefined;
        // A handler that returns false blocked the action, so nothing was done.
        if (verdict !== false) {
          const [actorId, detail] = pick(args);
          this.enqueue(kind, actorId, detail);
        }
        return verdict;
      };
    };
    // The inputs are consumed the moment the hook returns, so ownership is read here.
    chain("onCraft", "craft", ([actorId, , , recipeId]) =>
      [actorId, { recipeId, held: this.holdsInputs(ctx, Number(actorId) >>> 0, Number(recipeId) >>> 0) ? 1 : 0 }]);
    chain("onActivate", "activate", ([refrId, casterId]) => [casterId, { refrId }]);
    chain("onEatItem", "eat", ([actorId, baseId]) => [actorId, { baseId }]);
  }

  private enqueue(kind: string, actorId: unknown, detail: unknown): void {
    if (ACTIVITY_KINDS.indexOf(kind as ActivityKind) === -1) return;
    const numeric: Record<string, number> = {};
    if (detail && typeof detail === "object") {
      for (const [k, v] of Object.entries(detail as Record<string, unknown>)) numeric[k] = Number(v) >>> 0;
    }
    if (this.events.length >= MAX_QUEUED_EVENTS) this.events.shift();
    this.events.push({ kind: kind as ActivityKind, actorId: Number(actorId) >>> 0, detail: numeric });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "masteryInfoRequest": this.sendMenu(ctx, userId); break;
      case "masteryChoose": this.onChoose(ctx, userId, content); break;
      default: break;
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    this.flushPendingGrants(ctx);
    if (!this.events.length) return;
    const batch = this.events.splice(0, this.events.length);
    for (const ev of batch) {
      try {
        this.creditActivity(ctx, ev);
      } catch (e) {
        this.log(`[mastery] ${ev.kind} credit failed for ${ev.actorId.toString(16)}: ${e}`);
      }
    }
  }

  // ── Worked hours ────────────────────────────────────────────────────────────

  private creditActivity(ctx: SystemContext, ev: ActivityEvent): void {
    const rec = this.read(ctx, ev.actorId);
    if (!rec || !rec.profession) return;
    // Cheap gate first: hits arrive constantly and most fall inside the hour.
    const now = Date.now();
    const elapsed = now - rec.lastPointAt;
    if (elapsed >= 0 && elapsed < this.intervalMs) return;
    const rules = this.rules[rec.profession];
    if (!rules || !this.matches(ctx, rules, ev)) return;

    rec.points += 1;
    rec.lastPointAt = now;
    this.write(ctx, ev.actorId, rec);
    const userId = this.userOf(ctx, ev.actorId);
    this.notice(ctx, userId, `Your work as a ${this.labelOf(rec.profession)} is counted: ${rec.points} ${rec.points === 1 ? "hour" : "hours"} at the craft.`);
    this.syncRank(ctx, ev.actorId, rec, userId);
  }

  private matches(ctx: SystemContext, rules: ResolvedRules, ev: ActivityEvent): boolean {
    switch (ev.kind) {
      case "craft": {
        const bench = this.recipeBench(ctx, ev.detail["recipeId"]);
        return !!ev.detail["held"] && !!bench && rules.craftKeywords.has(bench) && this.benchInReach(ctx, ev.actorId, bench);
      }
      case "activate": {
        const refrId = ev.detail["refrId"];
        const loc = this.locationOf(ctx, ev.actorId);
        if (!loc || !this.inReach(ctx, loc, refrId) || this.isDisabled(ctx, refrId)) return false;
        const base = this.baseOf(ctx, refrId);
        if (!base) return false;
        if (rules.activateTypes.has(base.type)) return true;
        const edid = base.editorId.toLowerCase();
        return rules.activatePrefixes.some((p) => edid.startsWith(p));
      }
      case "eat":
        return rules.eatIngredient && this.recordType(ctx, ev.detail["baseId"]) === "INGR";
      case "kill":
        return this.combatCounts(ctx, ev.actorId, ev.detail["victimId"], rules.killKeywords, RANGED_REACH);
      case "hit": {
        const targetId = ev.detail["targetId"];
        const reach = this.hitReach(ctx, ev.detail["sourceId"]);
        return reach > 0 && !this.isDead(ctx, targetId) && this.combatCounts(ctx, ev.actorId, targetId, rules.hitKeywords, reach);
      }
      default:
        return false;
    }
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  summaryOf(ctx: SystemContext, actorId: number): MasterySummary {
    const rec = this.read(ctx, actorId) || emptyRecord();
    return {
      profession: rec.profession,
      label: rec.profession ? this.labelOf(rec.profession) : "",
      rank: rec.rank,
      rankName: RANK_NAMES[rec.rank],
      hours: rec.points,
    };
  }

  // Adds (or with a negative amount removes) worked hours; rank and marker
  // spells follow. Returns null for an amount the system refuses.
  grantPoints(ctx: SystemContext, actorId: number, amount: number): MasterySummary | null {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GRANT) return null;
    const rec = this.read(ctx, actorId) || emptyRecord();
    rec.points = Math.max(0, rec.points + amount);
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    if (rec.profession) {
      this.notice(ctx, userId, `Your hours as a ${this.labelOf(rec.profession)} now stand at ${rec.points}.`);
    }
    this.syncRank(ctx, actorId, rec, userId);
    return this.summaryOf(ctx, actorId);
  }

  // Admin escape hatch: clears the choice so the character may pick again.
  // Returns false when the character had nothing to clear.
  resetCharacter(ctx: SystemContext, actorId: number): boolean {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return false;
    this.revokeSpells(ctx, actorId, rec);
    // Hours belong to the craft, so a fresh choice starts from nothing.
    rec.profession = null;
    rec.points = 0;
    rec.lastPointAt = 0;
    rec.rank = 0;
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, "Your mastery has been set aside. You may choose again.");
    this.sendMenu(ctx, userId);
    return true;
  }

  // ── Login ───────────────────────────────────────────────────────────────────

  // Re-check on login: thresholds can be retuned under a character's feet, a
  // rank earned before a restart still needs its spell, and the actor may
  // have been wiped and recreated.
  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return;
    const corrected = this.rankFor(rec.points);
    if (corrected < rec.rank) this.revokeAbove(ctx, actorId, rec, corrected);
    rec.rank = corrected;
    // Always written back so a legacy playtime record settles into hours.
    this.write(ctx, actorId, rec);
    // Spells already in the changeform ride the spawn message down on their
    // own; only a gap (new config, retuned rank) needs granting, and it has to
    // wait out the client's spawn-time removeAllSpells.
    if (this.missingSpells(rec).length) {
      this.pendingGrants.set(actorId, Date.now() + LOGIN_GRANT_DELAY_MS);
    }
  }

  private flushPendingGrants(ctx: SystemContext): void {
    if (!this.pendingGrants.size) return;
    const now = Date.now();
    this.pendingGrants.forEach((dueAt, actorId) => {
      if (now < dueAt) return;
      this.pendingGrants.delete(actorId);
      const rec = this.read(ctx, actorId);
      if (rec && rec.profession) this.applySpells(ctx, actorId, rec);
    });
  }

  private onChoose(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastChooseMs.get(userId) || 0) < CHOOSE_COOLDOWN_MS) return;
    this.lastChooseMs.set(userId, now);
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const professionId = String(content["profession"] || "");
    if (PROFESSION_IDS.indexOf(professionId) === -1) return;

    const rec = this.read(ctx, actorId) || emptyRecord();
    if (rec.profession) {
      this.notice(ctx, userId, `You have already given yourself to the ${this.labelOf(rec.profession)}.`);
      return;
    }
    rec.profession = professionId;
    rec.rank = this.rankFor(rec.points);
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec);
    this.notice(ctx, userId, `You take up the craft of the ${this.labelOf(professionId)}.`);
    this.sendMenu(ctx, userId);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number): void {
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    this.send(ctx, userId, {
      customPacketType: "masteryMenu",
      profession: rec.profession,
      rank: rec.rank,
      hours: rec.points,
      rankHours: [0].concat(this.rankHours),
      professions: PROFESSIONS,
    });
  }

  // ── Ranks and marker spells ─────────────────────────────────────────────────

  private rankFor(points: number): number {
    let rank = 0;
    for (let i = 0; i < this.rankHours.length; i++) {
      if (points >= this.rankHours[i]) rank = i + 1;
    }
    return rank;
  }

  // Rank follows points and the marker spells follow rank, both ways.
  private syncRank(ctx: SystemContext, actorId: number, rec: MasteryRecord, userId: number): void {
    const oldRank = rec.rank;
    const newRank = this.rankFor(rec.points);
    if (newRank < oldRank) this.revokeAbove(ctx, actorId, rec, newRank);
    rec.rank = newRank;
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec);
    if (newRank === oldRank || !rec.profession) return;
    const label = this.labelOf(rec.profession);
    this.notice(ctx, userId, newRank > oldRank
      ? `You are now ${RANK_NAMES[newRank]} of the ${label}.`
      : `Your standing has fallen to ${RANK_NAMES[newRank]} of the ${label}.`);
  }

  // Markers the character should hold but does not yet.
  private missingSpells(rec: MasteryRecord): number[] {
    if (!rec.profession) return [];
    const list = this.spells[rec.profession];
    if (!list) return [];
    const out: number[] = [];
    for (let i = 0; i <= rec.rank && i < list.length; i++) {
      const spellId = list[i];
      if (spellId && rec.granted.indexOf(spellId) === -1) out.push(spellId);
    }
    return out;
  }

  // Every marker up to the current rank; the plugin's recipes condition on the
  // exact rank they belong to, so a Master still needs the Novice marker.
  private applySpells(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    const missing = this.missingSpells(rec);
    if (!missing.length) return;
    for (const spellId of missing) {
      this.addSpell(ctx, actorId, spellId);
      rec.granted.push(spellId);
    }
    this.write(ctx, actorId, rec);
  }

  // Take back the markers above keepRank after a rank loss.
  private revokeAbove(ctx: SystemContext, actorId: number, rec: MasteryRecord, keepRank: number): void {
    if (!rec.profession) return;
    const list = this.spells[rec.profession];
    if (!list) return;
    for (let i = keepRank + 1; i < list.length; i++) {
      const spellId = list[i];
      const at = rec.granted.indexOf(spellId);
      if (spellId && at !== -1) {
        this.removeSpell(ctx, actorId, spellId);
        rec.granted.splice(at, 1);
      }
    }
  }

  private revokeSpells(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    for (const spellId of rec.granted.slice()) this.removeSpell(ctx, actorId, spellId);
    rec.granted = [];
  }

  // AddSpell through Papyrus so the server records it in learnedSpells (which
  // HasSpell reads) and the client learns it live; a console addspell would be
  // client-local and lost on the next actor sync.
  private addSpell(ctx: SystemContext, actorId: number, spellId: number): void {
    if (!spellId) return;
    const mp = ctx.svr as Mp;
    try {
      const self = { type: "form", desc: mp.getDescFromId(actorId) };
      const spell = { type: "espm", desc: mp.getDescFromId(spellId) };
      mp.callPapyrusFunction("method", "Actor", "AddSpell", self, [spell, false]);
    } catch (e) {
      this.log(`[mastery] could not grant spell ${spellId.toString(16)}: ${e}`);
    }
  }

  private removeSpell(ctx: SystemContext, actorId: number, spellId: number): void {
    if (!spellId) return;
    const mp = ctx.svr as Mp;
    try {
      const self = { type: "form", desc: mp.getDescFromId(actorId) };
      const spell = { type: "espm", desc: mp.getDescFromId(spellId) };
      mp.callPapyrusFunction("method", "Actor", "RemoveSpell", self, [spell]);
    } catch (e) {
      this.log(`[mastery] could not revoke spell ${spellId.toString(16)}: ${e}`);
    }
  }

  // ── Activity rules ──────────────────────────────────────────────────────────

  private async loadRules(ctx: SystemContext, raw: unknown, dataDir: string, loadOrder: string[]): Promise<void> {
    const overrides = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const merged: Record<string, ActivityRules> = {};
    const wanted = new Set<string>([PLAYER_KEYWORD]);
    for (const id of PROFESSION_IDS) {
      const def = DEFAULT_ACTIVITIES[id] || {};
      const o = overrides[id] && typeof overrides[id] === "object" ? overrides[id] as Record<string, unknown> : {};
      const pick = (key: keyof ActivityRules): string[] => stringList(key in o ? o[key] : def[key]);
      const rules: ActivityRules = {
        craftKeywords: pick("craftKeywords"),
        activatePrefixes: pick("activatePrefixes"),
        activateTypes: pick("activateTypes"),
        eatIngredient: "eatIngredient" in o ? !!o["eatIngredient"] : !!def.eatIngredient,
        killKeywords: pick("killKeywords"),
        hitKeywords: pick("hitKeywords"),
      };
      merged[id] = rules;
      for (const k of rules.craftKeywords.concat(rules.killKeywords, rules.hitKeywords)) wanted.add(k);
    }

    const ids = new Map<string, number>();
    const names = Array.from(wanted);
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, ["KYWD"]);
    const mp = ctx.svr as Mp;
    const unresolved: string[] = [];
    for (const name of names) {
      let id = 0;
      try {
        if (name.includes(":")) id = mp.getIdFromDesc(name) >>> 0;
        else if (!isEditorId(name)) id = parseInt(name, 16) >>> 0;
        else {
          const desc = scan.resolved.get(name.toLowerCase());
          if (desc) id = mp.getIdFromDesc(desc) >>> 0;
        }
      } catch { id = 0; }
      if (id) ids.set(name, id);
      else unresolved.push(name);
    }
    this.playerKeyword = ids.get(PLAYER_KEYWORD) || 0;
    this.log(`[mastery] resolved ${ids.size}/${names.length} keyword(s) in ${scan.scannedMs} ms${unresolved.length ? `, unresolved: ${unresolved.join(", ")}` : ""}`);

    const toIds = (list: string[]): Set<number> => new Set(list.map((n) => ids.get(n) || 0).filter((v) => v));
    const toTypes = (list: string[]): Set<string> => new Set(list.map((t) => t.toUpperCase()));
    for (const id of PROFESSION_IDS) {
      const r = merged[id];
      this.rules[id] = {
        craftKeywords: toIds(r.craftKeywords),
        activatePrefixes: r.activatePrefixes.map((p) => p.toLowerCase()),
        activateTypes: toTypes(r.activateTypes),
        eatIngredient: r.eatIngredient,
        killKeywords: toIds(r.killKeywords),
        hitKeywords: toIds(r.hitKeywords),
      };
    }
  }

  private locationOf(ctx: SystemContext, actorId: number): Location | null {
    try {
      const loc = (ctx.svr as Mp).get(actorId, "locationalData");
      if (!loc || !Array.isArray(loc.pos) || loc.pos.length !== 3) return null;
      return { cell: String(loc.cellOrWorldDesc), pos: loc.pos.map(Number) };
    } catch {
      return null;
    }
  }

  private isDisabled(ctx: SystemContext, refrId: number): boolean {
    try { return !!(ctx.svr as Mp).get(refrId, "isDisabled"); } catch { return true; }
  }

  // Corpses never despawn here, so a parked one must not be an hourly target.
  private isDead(ctx: SystemContext, actorId: number): boolean {
    try { return !!(ctx.svr as Mp).get(actorId, "isDead"); } catch { return true; }
  }

  private inReach(ctx: SystemContext, loc: Location, refrId: number, reach = ACTIVATE_REACH): boolean {
    const mp = ctx.svr as Mp;
    try {
      if (loc.cell !== String(mp.get(refrId, "worldOrCellDesc"))) return false;
      const pos = mp.get(refrId, "pos");
      if (!Array.isArray(pos)) return false;
      const d = Math.hypot(loc.pos[0] - pos[0], loc.pos[1] - pos[1], loc.pos[2] - pos[2]);
      return Number.isFinite(d) && d <= reach;
    } catch {
      return false;
    }
  }

  // Hitting yourself is not work, and neither is a forged blow at an actor
  // further away than the weapon carries.
  private combatCounts(ctx: SystemContext, actorId: number, targetId: number, keywords: Set<number>, reach: number): boolean {
    if (!targetId || targetId === actorId || !keywords.size) return false;
    const loc = this.locationOf(ctx, actorId);
    if (!loc || !this.inReach(ctx, loc, targetId, reach)) return false;
    return this.actorHasAny(ctx, targetId, keywords);
  }

  // How far a hit from this source may land: 0 when the source is no weapon or spell.
  private hitReach(ctx: SystemContext, sourceId: number): number {
    const hit = this.reachCache.get(sourceId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, sourceId);
    const type = res ? String(res.record.type || "") : "";
    let reach = 0;
    if (type === "SPEL") reach = RANGED_REACH;
    else if (type === "WEAP") {
      const dnam = (res.record.fields || []).find((f: any) => f.type === "DNAM" && f.data instanceof Uint8Array && f.data.byteLength);
      const anim = dnam ? dnam.data[0] : -1;
      reach = anim === ANIM_BOW || anim === ANIM_CROSSBOW ? RANGED_REACH : MELEE_REACH;
    }
    this.reachCache.set(sourceId, reach);
    return reach;
  }

  // The C++ matches the recipe against the packet's ingredient list, not the
  // inventory, so a craft with nothing in the bag must not count.
  private holdsInputs(ctx: SystemContext, actorId: number, recipeId: number): boolean {
    const needed = this.recipeInputs(ctx, recipeId);
    if (!needed.length) return false;
    let held: Map<number, number>;
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory");
      held = new Map();
      for (const e of (inv && Array.isArray(inv.entries)) ? inv.entries : []) {
        const baseId = Number(e.baseId) >>> 0;
        held.set(baseId, (held.get(baseId) || 0) + (Number(e.count) || 0));
      }
    } catch {
      return false;
    }
    return needed.every((n) => (held.get(n.baseId) || 0) >= n.count);
  }

  // The craft packet names no workbench, so look for a station carrying the
  // recipe's keyword next to the crafter; a craft from the wilderness earns nothing.
  private benchInReach(ctx: SystemContext, actorId: number, bench: number): boolean {
    const loc = this.locationOf(ctx, actorId);
    if (!loc) return false;
    let near: unknown;
    try {
      near = (ctx.svr as Mp).getNeighborsByPosition(loc.cell, loc.pos);
    } catch (e) {
      if (!this.neighborsFailed) this.log(`[mastery] getNeighborsByPosition failed, crafts cannot be credited: ${e}`);
      this.neighborsFailed = true;
      return false;
    }
    if (!Array.isArray(near)) return false;
    for (const id of near) {
      const refrId = Number(id) >>> 0;
      if (!refrId || !this.inReach(ctx, loc, refrId)) continue;
      const base = this.baseOf(ctx, refrId);
      if (!base || (base.type !== "FURN" && base.type !== "ACTI")) continue;
      if (this.baseKeywords(ctx, base.id).has(bench)) return true;
    }
    return false;
  }

  // ── Espm lookups (cached: plugins only change with a restart) ──────────────

  private lookup(ctx: SystemContext, formId: number): any {
    if (!formId) return null;
    try {
      const res = (ctx.svr as Mp).lookupEspmRecordById(formId >>> 0);
      return res && res.record ? res : null;
    } catch {
      return null;
    }
  }

  // Form ids stored in a field are local to the record's plugin.
  private fieldFormIds(res: any, fieldType: string): number[] {
    const out: number[] = [];
    if (!res || typeof res.toGlobalRecordId !== "function") return out;
    for (const f of res.record.fields || []) {
      if (f.type !== fieldType || !(f.data instanceof Uint8Array)) continue;
      const view = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
      for (let off = 0; off + 4 <= f.data.byteLength; off += 4) {
        try { out.push(res.toGlobalRecordId(view.getUint32(off, true)) >>> 0); } catch { /* unmapped master */ }
      }
    }
    return out;
  }

  private recordType(ctx: SystemContext, formId: number): string {
    const info = this.baseInfo(ctx, formId);
    return info ? info.type : "";
  }

  // Workbench keyword of a recipe, 0 when unknown.
  private recipeBench(ctx: SystemContext, recipeId: number): number {
    const hit = this.benchCache.get(recipeId);
    if (hit !== undefined) return hit;
    const bench = this.fieldFormIds(this.lookup(ctx, recipeId), "BNAM")[0] || 0;
    this.benchCache.set(recipeId, bench);
    return bench;
  }

  // CNTO entries of a recipe: an item id followed by a count, eight bytes each.
  private recipeInputs(ctx: SystemContext, recipeId: number): Array<{ baseId: number; count: number }> {
    const hit = this.inputCache.get(recipeId);
    if (hit) return hit;
    const out: Array<{ baseId: number; count: number }> = [];
    const res = this.lookup(ctx, recipeId);
    if (res && typeof res.toGlobalRecordId === "function") {
      for (const f of res.record.fields || []) {
        if (f.type !== "CNTO" || !(f.data instanceof Uint8Array) || f.data.byteLength < 8) continue;
        const view = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
        try {
          out.push({ baseId: res.toGlobalRecordId(view.getUint32(0, true)) >>> 0, count: view.getUint32(4, true) });
        } catch { /* unmapped master */ }
      }
    }
    this.inputCache.set(recipeId, out);
    return out;
  }

  // Base object behind a placed or runtime reference.
  private baseOf(ctx: SystemContext, refrId: number): BaseInfo | null {
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(refrId, "baseDesc"))) >>> 0; } catch { return null; }
    return baseId ? this.baseInfo(ctx, baseId) : null;
  }

  private baseInfo(ctx: SystemContext, formId: number): BaseInfo | null {
    const hit = this.baseCache.get(formId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, formId);
    const info = res ? { id: formId, type: String(res.record.type || ""), editorId: String(res.record.editorId || "") } : null;
    this.baseCache.set(formId, info);
    return info;
  }

  // Keywords of the NPC_ records in the actor's template chain and their race.
  private actorHasAny(ctx: SystemContext, actorId: number, keywords: Set<number>): boolean {
    if (!keywords.size || !actorId) return false;
    const mp = ctx.svr as Mp;
    let profileId = -1;
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { /* not an actor */ }
    if (profileId >= 0) return keywords.has(this.playerKeyword);
    for (const baseId of this.baseChain(mp, actorId)) {
      for (const k of this.baseKeywords(ctx, baseId)) {
        if (keywords.has(k)) return true;
      }
    }
    return false;
  }

  private baseChain(mp: Mp, actorId: number): number[] {
    const chain: number[] = [];
    try { chain.push(mp.getIdFromDesc(String(mp.get(actorId, "baseDesc"))) >>> 0); } catch { /* no base */ }
    try {
      const tpl = mp.get(actorId, "templateChain");
      if (Array.isArray(tpl)) for (const id of tpl) chain.push(Number(id) >>> 0);
    } catch { /* not an actor */ }
    return chain.filter((id, i) => id && chain.indexOf(id) === i);
  }

  // Keywords of any base record, plus its race's for an NPC_.
  private baseKeywords(ctx: SystemContext, baseId: number): Set<number> {
    const hit = this.keywordCache.get(baseId);
    if (hit) return hit;
    const out = new Set<number>();
    const rec = this.lookup(ctx, baseId);
    if (rec) {
      for (const k of this.fieldFormIds(rec, "KWDA")) out.add(k);
      const raceId = String(rec.record.type) === "NPC_" ? this.fieldFormIds(rec, "RNAM")[0] : 0;
      if (raceId) for (const k of this.fieldFormIds(this.lookup(ctx, raceId), "KWDA")) out.add(k);
    }
    this.keywordCache.set(baseId, out);
    return out;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  private read(ctx: SystemContext, actorId: number): MasteryRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, MASTERY_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Partial<MasteryRecord> & { seconds?: number };
      const profession = typeof r.profession === "string" && PROFESSION_IDS.indexOf(r.profession) !== -1
        ? r.profession
        : null;
      // Records from the playtime era carry seconds; a full hour of it is worth a point once.
      const points = r.points === undefined ? Math.floor(Math.max(0, Number(r.seconds) || 0) / 3600) : Number(r.points);
      return {
        profession,
        points: Math.max(0, Math.floor(points) || 0),
        lastPointAt: Math.max(0, Number(r.lastPointAt) || 0),
        rank: Math.min(RANK_NAMES.length - 1, Math.max(0, Number(r.rank) || 0)),
        granted: Array.isArray(r.granted) ? r.granted.map((v) => Number(v) >>> 0).filter((v) => v) : [],
      };
    } catch {
      return null;
    }
  }

  private write(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    try {
      (ctx.svr as Mp).set(actorId, MASTERY_PROP, rec);
    } catch (e) {
      this.log(`[mastery] write failed for ${actorId.toString(16)}: ${e}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private labelOf(professionId: string): string {
    const p = PROFESSIONS.filter((x) => x.id === professionId)[0];
    return p ? p.label : professionId;
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      const userId = (ctx.svr as Mp).getUserByActor(actorId);
      return userId === INVALID_USER_ID ? -1 : userId;
    } catch {
      return -1;
    }
  }

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "masteryNotice", text });
  }

  private rankHours = DEFAULT_RANK_HOURS.slice();
  private intervalMs = DEFAULT_POINT_INTERVAL_MINUTES * 60000;
  private spells: Record<string, number[]> = {};
  private rules: Record<string, ResolvedRules> = {};
  private playerKeyword = 0;
  private neighborsFailed = false;
  private events: ActivityEvent[] = [];
  private lastChooseMs = new Map<number, number>();
  private pendingGrants = new Map<number, number>();

  private benchCache = new Map<number, number>();
  private reachCache = new Map<number, number>();
  private inputCache = new Map<number, Array<{ baseId: number; count: number }>>();
  private baseCache = new Map<number, BaseInfo | null>();
  private keywordCache = new Map<number, Set<number>>();
}
