import { System, Log, SystemContext } from "./system";
import { espmFieldFormIds, readFormIdField } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Soul Trap: a hit carrying a soul trap effect marks its target, and a death before the effect ends fills one of the caster's soul gems.
// Players have black souls, so only an empty black soul gem takes them, and a player whose soul was taken respawns once in the Soul Cairn.

const HIT_EVENT = "onPapyrusEvent:OnHit";
const TRAPPED_PROP = "private.soulTrapped";
const NOTICE_PACKET = "notification";
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
// Only marked actors are polled, and a respawn takes seconds.
const DEATH_POLL_MS = 100;

// MGEF archetype Soul Trap; the Soul Trap spell (SoulTrapFFActor) and weapon enchantments (EnchSoulTrapFFContact) use Script-archetype effects.
const ARCHETYPE_SOUL_TRAP = 23;
const SCRIPT_SOUL_TRAP_EFFECTS = new Set([0x0004dba3, 0x0005b452]);
// libespm NPC_::TemplateFlags
const USE_TRAITS = 0x01;
const USE_STATS = 0x02;
const KEYWORD_ACTOR_TYPE_NPC = 0x00013794;
const KEYWORD_NO_SOUL_TRAP = 0x00103ad2;
// SLGM record flag "Can Hold NPC Soul": black soul gems and the Black Star.
const FLAG_CAN_HOLD_NPC_SOUL = 0x20000;
// ACBS flag: the level is a multiple of the player's.
const FLAG_PC_LEVEL_MULT = 0x80;
// GMST iLesserSoulActorLevel, iCommonSoulActorLevel, iGreaterSoulActorLevel, iGrandSoulActorLevel.
const SOUL_ACTOR_LEVELS = [4, 16, 28, 38];
const SOUL_GRAND = 5;
// Empty vanilla gems and their filled forms; the stars and a smaller soul keep the soul as entry extra data.
const FILLED_GEMS = new Map<number, number>([
  [0x0002e4e2, 0x0002e4e3], // Petty
  [0x0002e4e4, 0x0002e4e5], // Lesser
  [0x0002e4e6, 0x0002e4f3], // Common
  [0x0002e4f4, 0x0002e4fb], // Greater
  [0x0002e4fc, 0x0002e4ff], // Grand
  [0x0002e500, 0x0002e504], // Black
]);
// Where the Castle Volkihar portal (Dawnguard.esm door 0200289B) sets the player down in DLC01SoulCairn.
const SOUL_CAIRN_ARRIVAL = {
  cellOrWorldDesc: "1408:Dawnguard.esm",
  pos: [-19965.66, -15986.51, 2079.48],
  rot: [0, 0, 77.35],
};

interface Trap {
  casterId: number;
  expiresAt: number;
}

interface Soul {
  size: number;
  black: boolean;
}

interface Gem {
  capacity: number;
  empty: boolean;
  black: boolean;
}

interface GemEntry {
  baseId: number;
  count: number;
  soul?: number;
  worn?: boolean;
  wornLeft?: boolean;
}

const hex = (id: number): string => (id >>> 0).toString(16);
const viewOf = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);

export class SoulTrapSystem implements System {
  systemName = "SoulTrapSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const previousHit = typeof mp[HIT_EVENT] === "function" ? mp[HIT_EVENT] : null;
    mp[HIT_EVENT] = (...args: unknown[]) => {
      try {
        this.onHit(ctx, Number(args[0]) >>> 0, args[1], args[2]);
      } catch (e) {
        this.log(`[soultrap] hit check failed: ${e}`);
      }
      return previousHit ? previousHit.apply(mp, args) : undefined;
    };

    const previousRespawn = typeof mp.onRespawn === "function" ? mp.onRespawn : null;
    mp.onRespawn = (...args: unknown[]) => {
      const result = previousRespawn ? previousRespawn.apply(mp, args) : undefined;
      if (result !== false) {
        try {
          this.routeToSoulCairn(ctx, Number(args[0]) >>> 0);
        } catch (e) {
          this.log(`[soultrap] Soul Cairn respawn failed: ${e}`);
        }
      }
      return result;
    };
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    if (!this.traps.size || now < this.nextPollAt) return;
    this.nextPollAt = now + DEATH_POLL_MS;
    const mp = ctx.svr as Mp;
    for (const [targetId, trap] of Array.from(this.traps)) {
      let dead = false;
      try {
        dead = mp.get(targetId, "isDead") === true;
      } catch {
        this.traps.delete(targetId);
        continue;
      }
      if (dead) {
        this.traps.delete(targetId);
        try {
          this.capture(ctx, targetId, trap.casterId);
        } catch (e) {
          this.log(`[soultrap] capture of ${hex(targetId)} failed: ${e}`);
        }
      } else if (now > trap.expiresAt) {
        this.traps.delete(targetId);
      }
    }
  }

  private onHit(ctx: SystemContext, targetId: number, aggressor: unknown, source: unknown): void {
    const mp = ctx.svr as Mp;
    const seconds = this.trapSeconds(ctx, this.idOf(mp, source));
    if (!seconds) return;
    const casterId = this.idOf(mp, aggressor);
    if (!casterId || casterId === targetId) return;
    if (mp.get(targetId, "type") !== "MpActor" || mp.get(targetId, "isDead") === true) return;
    if (!this.isPlayer(mp, targetId) && this.npcKeywords(ctx, targetId).has(KEYWORD_NO_SOUL_TRAP)) return;
    // The latest soul trap on a target decides whose gem its soul goes to
    this.traps.set(targetId, { casterId, expiresAt: Date.now() + seconds * 1000 });
  }

  private capture(ctx: SystemContext, targetId: number, casterId: number): void {
    const mp = ctx.svr as Mp;
    const player = this.isPlayer(mp, targetId);
    const soul = this.soulOf(ctx, targetId, player);
    const gemId = this.fillGem(ctx, casterId, soul);
    const kind = soul.black ? "black" : `size ${soul.size}`;
    if (!gemId) {
      this.log(`[soultrap] ${hex(targetId)} died soul trapped by ${hex(casterId)}, no empty gem holds its ${kind} soul`);
      return;
    }
    this.notify(ctx, casterId, "Soul captured!");
    if (player) {
      mp.set(targetId, TRAPPED_PROP, true);
      this.notify(ctx, targetId, "Your soul was trapped in a black soul gem.");
    }
    this.log(`[soultrap] ${hex(casterId)} trapped the ${kind} soul of ${hex(targetId)} in gem ${hex(gemId)}`);
  }

  // The engine reads the respawn point right after this hook, so the Soul Cairn stands in for this one respawn only
  private routeToSoulCairn(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as Mp;
    if (mp.get(actorId, TRAPPED_PROP) !== true) return;
    mp.set(actorId, TRAPPED_PROP, false);
    const home = mp.get(actorId, "spawnPoint");
    mp.set(actorId, "spawnPoint", SOUL_CAIRN_ARRIVAL);
    setTimeout(() => {
      try {
        mp.set(actorId, "spawnPoint", home);
      } catch (e) {
        this.log(`[soultrap] restoring the spawn point of ${hex(actorId)} failed: ${e}`);
      }
    }, 0);
    this.log(`[soultrap] ${hex(actorId)} respawns in the Soul Cairn`);
  }

  // Smallest empty gem that holds the soul: black souls need a gem that can hold NPC souls, white souls a regular one
  private fillGem(ctx: SystemContext, casterId: number, soul: Soul): number {
    const mp = ctx.svr as Mp;
    let entries: GemEntry[];
    try {
      const inv = mp.get(casterId, "inventory");
      entries = (inv && Array.isArray(inv.entries) ? inv.entries : []).map((e: GemEntry) => ({ ...e }));
    } catch {
      return 0;
    }
    let best: GemEntry | null = null;
    let bestRank = Infinity;
    for (const e of entries) {
      if ((Number(e.count) || 0) <= 0 || e.soul) continue;
      const gem = this.gemOf(ctx, Number(e.baseId) >>> 0);
      if (!gem || !gem.empty || gem.black !== soul.black || gem.capacity < soul.size) continue;
      // Ties go to a regular gem so the reusable stars stay free
      const rank = gem.capacity * 2 + (FILLED_GEMS.has(Number(e.baseId) >>> 0) ? 0 : 1);
      if (rank < bestRank) {
        best = e;
        bestRank = rank;
      }
    }
    if (!best) return 0;

    const baseId = Number(best.baseId) >>> 0;
    best.count -= 1;
    const filledId = soul.size === this.gemOf(ctx, baseId)?.capacity ? FILLED_GEMS.get(baseId) : undefined;
    const filled: GemEntry = filledId ? { baseId: filledId, count: 1 } : { baseId, count: 1, soul: soul.size };
    const stack = entries.find((e) => (Number(e.baseId) >>> 0) === filled.baseId && (e.soul || 0) === (filled.soul || 0) &&
      e.count > 0 && !e.worn && !e.wornLeft);
    if (stack) stack.count += 1;
    else entries.push(filled);
    try {
      mp.set(casterId, "inventory", { entries: entries.filter((e) => e.count > 0) });
    } catch {
      return 0;
    }
    return filled.baseId;
  }

  private soulOf(ctx: SystemContext, actorId: number, player: boolean): Soul {
    if (player || this.npcKeywords(ctx, actorId).has(KEYWORD_ACTOR_TYPE_NPC)) return { size: SOUL_GRAND, black: true };
    const level = this.levelOf(ctx, actorId);
    return { size: 1 + SOUL_ACTOR_LEVELS.filter((l) => level >= l).length, black: false };
  }

  // ACBS level; a level relative to the player counts at its minimum since there is no single player to scale by
  private levelOf(ctx: SystemContext, actorId: number): number {
    const acbs = this.fieldData(this.templateNpc(ctx, actorId, USE_STATS), "ACBS");
    if (!acbs || acbs.byteLength < 12) return 1;
    const view = viewOf(acbs);
    return view.getUint32(0, true) & FLAG_PC_LEVEL_MULT ? Math.max(1, view.getUint16(10, true)) : view.getUint16(8, true);
  }

  // Keywords of the actor's NPC_ records and of the race its traits come from
  private npcKeywords(ctx: SystemContext, actorId: number): Set<number> {
    const out = new Set<number>();
    for (const id of this.templateChain(ctx.svr as Mp, actorId)) {
      for (const k of this.keywordsOf(ctx, id)) out.add(k);
    }
    const traits = this.templateNpc(ctx, actorId, USE_TRAITS);
    const raceId = traits ? espmFieldFormIds(traits, "RNAM")[0] || 0 : 0;
    for (const k of this.keywordsOf(ctx, raceId)) out.add(k);
    return out;
  }

  // The chain the server rolled for the actor (see EvaluateTemplate), or its base alone
  private templateChain(mp: Mp, actorId: number): number[] {
    try {
      const tpl = mp.get(actorId, "templateChain");
      if (Array.isArray(tpl) && tpl.length) return tpl.map((id) => Number(id) >>> 0);
    } catch { /* not an actor */ }
    try {
      return [mp.getIdFromDesc(String(mp.get(actorId, "baseDesc"))) >>> 0];
    } catch {
      return [];
    }
  }

  // First NPC_ in the chain that supplies the data a template flag covers
  private templateNpc(ctx: SystemContext, actorId: number, flag: number): any {
    for (const id of this.templateChain(ctx.svr as Mp, actorId)) {
      const res = this.lookup(ctx, id);
      if (!res || res.record.type !== "NPC_") return null;
      const acbs = this.fieldData(res, "ACBS");
      const templateFlags = acbs && acbs.byteLength >= 20 ? viewOf(acbs).getUint16(18, true) : 0;
      if (!readFormIdField(res, "TPLT") || !(templateFlags & flag)) return res;
    }
    return null;
  }

  // Longest unconditioned soul trap effect a hit applies: a spell, scroll, enchantment or a weapon's base enchantment
  private trapSeconds(ctx: SystemContext, sourceId: number): number {
    if (!sourceId) return 0;
    const hit = this.trapSecondsCache.get(sourceId);
    if (hit !== undefined) return hit;
    let res = this.lookup(ctx, sourceId);
    if (res && res.record.type === "WEAP") res = this.lookup(ctx, espmFieldFormIds(res, "EITM")[0] || 0);
    let seconds = 0;
    if (res && ["SPEL", "SCRL", "ENCH"].includes(String(res.record.type))) {
      const effects: Array<{ id: number; seconds: number; conditioned: boolean }> = [];
      for (const f of res.record.fields || []) {
        if (!(f.data instanceof Uint8Array)) continue;
        const current = effects[effects.length - 1];
        if (f.type === "EFID" && f.data.byteLength >= 4) {
          let id = 0;
          try { id = res.toGlobalRecordId(viewOf(f.data).getUint32(0, true)) >>> 0; } catch { /* unmapped master */ }
          effects.push({ id, seconds: 0, conditioned: false });
        } else if (f.type === "EFIT" && current && f.data.byteLength >= 12) {
          current.seconds = viewOf(f.data).getUint32(8, true);
        } else if (f.type === "CTDA" && current) {
          // Conditions (the Soul Stealer perk on bound weapons) are not evaluated server-side
          current.conditioned = true;
        }
      }
      for (const e of effects) {
        if (!e.conditioned && this.isSoulTrapEffect(ctx, e.id)) seconds = Math.max(seconds, e.seconds);
      }
    }
    this.trapSecondsCache.set(sourceId, seconds);
    return seconds;
  }

  private isSoulTrapEffect(ctx: SystemContext, mgefId: number): boolean {
    if (SCRIPT_SOUL_TRAP_EFFECTS.has(mgefId)) return true;
    const hit = this.effectCache.get(mgefId);
    if (hit !== undefined) return hit;
    const data = this.fieldData(this.lookup(ctx, mgefId), "DATA");
    const result = !!data && data.byteLength >= 0x44 && viewOf(data).getUint32(0x40, true) === ARCHETYPE_SOUL_TRAP;
    this.effectCache.set(mgefId, result);
    return result;
  }

  private gemOf(ctx: SystemContext, baseId: number): Gem | null {
    const hit = this.gemCache.get(baseId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, baseId);
    let gem: Gem | null = null;
    if (res && res.record.type === "SLGM") {
      const soul = this.fieldData(res, "SOUL");
      const capacity = this.fieldData(res, "SLCP");
      gem = {
        capacity: capacity && capacity.byteLength ? capacity[0] : 0,
        empty: !(soul && soul.byteLength && soul[0]),
        black: !!(Number(res.record.flags) & FLAG_CAN_HOLD_NPC_SOUL),
      };
    }
    this.gemCache.set(baseId, gem);
    return gem;
  }

  private keywordsOf(ctx: SystemContext, formId: number): number[] {
    if (!formId) return [];
    const hit = this.keywordCache.get(formId);
    if (hit) return hit;
    const keywords = espmFieldFormIds(this.lookup(ctx, formId), "KWDA");
    this.keywordCache.set(formId, keywords);
    return keywords;
  }

  private isPlayer(mp: Mp, actorId: number): boolean {
    try {
      return Number(mp.get(actorId, "profileId")) >= 0;
    } catch {
      return false;
    }
  }

  private idOf(mp: Mp, obj: unknown): number {
    const desc = obj && typeof obj === "object" ? (obj as { desc?: unknown }).desc : undefined;
    if (typeof desc !== "string") return 0;
    try {
      return mp.getIdFromDesc(desc) >>> 0;
    } catch {
      return 0;
    }
  }

  private notify(ctx: SystemContext, actorId: number, text: string): void {
    try {
      const userId = ctx.svr.getUserByActor(actorId);
      if (userId >= 0 && userId < INVALID_USER_ID) {
        ctx.svr.sendCustomPacket(userId, JSON.stringify({ customPacketType: NOTICE_PACKET, text }));
      }
    } catch { /* offline */ }
  }

  private fieldData(res: any, type: string): Uint8Array | null {
    const fields = res && res.record && Array.isArray(res.record.fields) ? res.record.fields : [];
    const f = fields.find((x: any) => x && x.type === type && x.data instanceof Uint8Array);
    return f ? f.data : null;
  }

  private lookup(ctx: SystemContext, formId: number): any {
    if (!formId) return null;
    try {
      const res = (ctx.svr as Mp).lookupEspmRecordById(formId >>> 0);
      return res && res.record ? res : null;
    } catch {
      return null;
    }
  }

  private traps = new Map<number, Trap>();
  private nextPollAt = 0;
  private trapSecondsCache = new Map<number, number>();
  private effectCache = new Map<number, boolean>();
  private gemCache = new Map<number, Gem | null>();
  private keywordCache = new Map<number, number[]>();
}
