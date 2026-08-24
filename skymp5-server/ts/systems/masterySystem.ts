import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { AfkSystem } from "./afkSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Mastery: one profession per character, ranked by time played ──────────────
//
// A character picks a single profession and keeps it. Rank comes from time
// actually played on that character - not from XP, not from grinding an action -
// so the ladder rewards showing up and roleplaying rather than farming. Each
// rank grants a marker spell; recipes in the Alduinak plugin carry a HasSpell
// condition for the marker, which is the one gate the engine honours on both
// sides: the vanilla crafting menu hides recipes the player cannot make, and
// the server independently refuses a forged craft packet for them.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "masteryInfoRequest" }
//     { customPacketType: "masteryChoose", profession: "<id>" }
//   Server -> Client:
//     { customPacketType: "masteryMenu", profession, rank, hours, professions: [...] }
//     { customPacketType: "masteryNotice", text }
//
// Persistence: `private.mastery` on the character's actor form, which rides the
// changeform into Mongo. Playtime is per character by design - an alt starts at
// Novice - so the record belongs on the actor, never on the profile.
//
// server-settings.json keys (all optional):
//   masteryRankHours     [adept, expert, master] thresholds, default [10, 40, 100]
//   masteryIdleMinutes   idle minutes that stop accrual, default 5
//   masterySpells        { "<professionId>": [noviceSpell, adept, expert, master] }
//                        form ids from the Alduinak plugin; professions absent
//                        from the map simply grant no spell.

const MASTERY_PROP = "private.mastery";

const ACCRUE_INTERVAL_MS = 60000;
const DEFAULT_RANK_HOURS = [10, 40, 100];
const DEFAULT_IDLE_MINUTES = 5;

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

interface MasteryRecord {
  profession: string | null;
  seconds: number;
  rank: number;
}

const emptyRecord = (): MasteryRecord => ({ profession: null, seconds: 0, rank: 0 });

export class MasterySystem implements System {
  systemName = "MasterySystem";

  constructor(private log: Log, private afk: AfkSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const hours = all?.["masteryRankHours"];
    if (Array.isArray(hours) && hours.length === 3 && hours.every((h) => Number.isFinite(Number(h)))) {
      this.rankHours = hours.map((h) => Number(h));
    }
    const idle = Number(all?.["masteryIdleMinutes"]);
    if (Number.isFinite(idle) && idle > 0) this.idleMs = idle * 60000;

    const spells = all?.["masterySpells"];
    if (spells && typeof spells === "object") {
      for (const id of PROFESSION_IDS) {
        const list = (spells as Record<string, unknown>)[id];
        if (Array.isArray(list) && list.length === RANK_NAMES.length) {
          this.spells[id] = list.map((v) => Number(v) >>> 0);
        }
      }
    }

    const configured = Object.keys(this.spells).length;
    this.log(`[mastery] ready, ranks at ${this.rankHours.join("/")}h, ${configured}/${PROFESSION_IDS.length} professions have marker spells`);
    if (configured < PROFESSION_IDS.length) {
      this.log(`[mastery] professions without masterySpells grant no recipes yet`);
    }

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
      this.onActorAssigned(ctx, userId, actorId >>> 0);
    });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "masteryInfoRequest": this.sendMenu(ctx, userId); break;
      case "masteryChoose": this.onChoose(ctx, userId, content); break;
      default: break;
    }
  }

  // Credit a minute of play to everyone who is present and not idle.
  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    if (now - this.lastAccrualMs < ACCRUE_INTERVAL_MS) return;
    const elapsedMs = this.lastAccrualMs === 0 ? 0 : now - this.lastAccrualMs;
    this.lastAccrualMs = now;
    if (!elapsedMs) return;

    const seconds = Math.round(elapsedMs / 1000);
    for (const userId of this.onlineUsers(ctx)) {
      if (this.afk.idleMsOf(userId) >= this.idleMs) continue;
      const actorId = this.actorOf(ctx, userId);
      if (!actorId) continue;
      const rec = this.read(ctx, actorId);
      // Time only counts once a profession has been chosen.
      if (!rec || !rec.profession) continue;
      rec.seconds += seconds;
      const newRank = this.rankFor(rec.seconds);
      const rankUp = newRank > rec.rank;
      rec.rank = newRank;
      this.write(ctx, actorId, rec);
      if (rankUp) {
        this.applySpells(ctx, actorId, rec);
        this.notice(ctx, userId, `You are now ${RANK_NAMES[newRank]} of the ${this.labelOf(rec.profession)}.`);
        this.sendMenu(ctx, userId);
      }
    }
  }

  // Re-apply on login: a rank earned before a restart still needs its spell,
  // and the actor may have been wiped and recreated.
  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return;
    const corrected = this.rankFor(rec.seconds);
    if (corrected !== rec.rank) {
      rec.rank = corrected;
      this.write(ctx, actorId, rec);
    }
    this.applySpells(ctx, actorId, rec);
  }

  private onChoose(ctx: SystemContext, userId: number, content: Content): void {
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
    rec.rank = this.rankFor(rec.seconds);
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec);
    this.notice(ctx, userId, `You take up the craft of the ${this.labelOf(professionId)}.`);
    this.sendMenu(ctx, userId);
  }

  // Admin escape hatch: clears the choice so the character may pick again.
  // Returns false when the character had nothing to clear.
  resetCharacter(ctx: SystemContext, actorId: number): boolean {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return false;
    this.revokeSpells(ctx, actorId, rec.profession);
    this.write(ctx, actorId, emptyRecord());
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, "Your mastery has been set aside. You may choose again.");
    this.sendMenu(ctx, userId);
    return true;
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
      hours: Math.floor(rec.seconds / 3600),
      rankHours: [0].concat(this.rankHours),
      professions: PROFESSIONS,
    });
  }

  // ── Ranks and marker spells ─────────────────────────────────────────────────

  private rankFor(seconds: number): number {
    const hours = seconds / 3600;
    let rank = 0;
    for (let i = 0; i < this.rankHours.length; i++) {
      if (hours >= this.rankHours[i]) rank = i + 1;
    }
    return rank;
  }

  // Every marker up to the current rank; the plugin's recipes condition on the
  // exact rank they belong to, so a Master still needs the Novice marker.
  private applySpells(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    if (!rec.profession) return;
    const list = this.spells[rec.profession];
    if (!list) return;
    for (let i = 0; i <= rec.rank && i < list.length; i++) {
      this.addSpell(ctx, actorId, list[i]);
    }
  }

  private revokeSpells(ctx: SystemContext, actorId: number, professionId: string): void {
    const list = this.spells[professionId];
    if (!list) return;
    for (const spellId of list) this.removeSpell(ctx, actorId, spellId);
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

  // ── Storage ─────────────────────────────────────────────────────────────────

  private read(ctx: SystemContext, actorId: number): MasteryRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, MASTERY_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Partial<MasteryRecord>;
      const profession = typeof r.profession === "string" && PROFESSION_IDS.indexOf(r.profession) !== -1
        ? r.profession
        : null;
      return {
        profession,
        seconds: Math.max(0, Number(r.seconds) || 0),
        rank: Math.min(RANK_NAMES.length - 1, Math.max(0, Number(r.rank) || 0)),
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

  private onlineUsers(ctx: SystemContext): number[] {
    const mp = ctx.svr as Mp;
    const out: number[] = [];
    try {
      const actors = mp.get(0, "onlinePlayers");
      if (Array.isArray(actors)) {
        for (const actorId of actors) {
          const userId = this.userOf(ctx, Number(actorId) >>> 0);
          if (userId >= 0) out.push(userId);
        }
      }
    } catch { /* binding unavailable */ }
    return out;
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try { return (ctx.svr as Mp).getUserByActor(actorId); } catch { return -1; }
  }

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "masteryNotice", text });
  }

  private rankHours = DEFAULT_RANK_HOURS.slice();
  private idleMs = DEFAULT_IDLE_MINUTES * 60000;
  private spells: Record<string, number[]> = {};
  private lastAccrualMs = 0;
}
