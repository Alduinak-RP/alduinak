import { System, Log, SystemContext } from "./system";
import { CompanionSystem } from "./companionSystem";
import { spellEffects, SpellEffect, MgefArchetype, npcLevel, keywordConditionsPass } from "./espmMagic";
import { isPlayerActor, isNear, baseIdOf, hex } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Server-side Conjuration fed by the onSpellCast / onSpellHit gamemode events (ActionListener.cpp):
// SummonCreature spells place a summon, Reanimate spells raise a dead NPC within the level cap, Banish sends a summoned daedra away.

// Effects lasting this long are "until killed" (the Thralls)
const PERMANENT_SEC = 1e7;
const REANIMATE_RANGE = 4096;
const REANIMATE_LIFT = 16;
// A cast whose hit on a corpse never arrives picks the nearest valid corpse in front of the caster
const REANIMATE_FALLBACK_MS = 1500;
const REANIMATE_FALLBACK_RANGE = 2048;
const REANIMATE_FALLBACK_CONE_DEG = 20;
// A hit that arrives before its cast already handled that cast
const REANIMATE_HIT_FIRST_MS = 1000;

interface PendingReanimate {
  spellId: number;
  effect: SpellEffect;
  timer: ReturnType<typeof setTimeout>;
}

export class ConjurationSystem implements System {
  systemName = "ConjurationSystem";
  constructor(private log: Log, private companions: CompanionSystem) { }

  private mp: Mp = null;
  private pending = new Map<number, PendingReanimate>();
  private lastReanimateHit = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    this.hook("onSpellCast", (casterId, spellId) => this.onSpellCast(casterId, spellId));
    this.hook("onSpellHit", (aggressorId, targetId, spellId) => this.onSpellHit(aggressorId, targetId, spellId));
  }

  disconnect(userId: number, ctx: SystemContext): void {
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId) >>> 0; } catch { return; }
    this.clearPending(actorId);
    this.lastReanimateHit.delete(actorId);
  }

  // Handlers run after the native event returns: they may destroy the hit target, which the C++ hit path still uses
  private hook(event: string, handler: (...ids: number[]) => void): void {
    const mp = this.mp;
    const previous = typeof mp[event] === "function" ? mp[event] : null;
    mp[event] = (...args: unknown[]) => {
      const ids = args.map((x) => Number(x) >>> 0);
      setImmediate(() => {
        try {
          handler(...ids);
        } catch (e) {
          this.log(`ConjurationSystem: ${event} failed: ${e}`);
        }
      });
      if (!previous) return true;
      try {
        return previous.apply(mp, args) !== false;
      } catch {
        return true;
      }
    };
  }

  private onSpellCast(casterId: number, spellId: number): void {
    if (!isPlayerActor(this.mp, casterId)) return;
    const effects = spellEffects(this.mp, spellId);
    // The first summon effect is the unperked one; perk conditions are not evaluated server-side
    const summon = effects.find((e) => e.archetype === MgefArchetype.SummonCreature && e.assocId);
    if (summon) {
      this.companions.spawn(casterId, summon.assocId, { kind: "summon", durationSec: this.duration(summon), source: spellId });
      return;
    }
    const reanimate = effects.find((e) => e.archetype === MgefArchetype.Reanimate);
    if (reanimate && Date.now() - (this.lastReanimateHit.get(casterId) ?? 0) > REANIMATE_HIT_FIRST_MS) {
      this.clearPending(casterId);
      const timer = setTimeout(() => this.reanimateFallback(casterId), REANIMATE_FALLBACK_MS);
      this.pending.set(casterId, { spellId, effect: reanimate, timer });
    }
  }

  private onSpellHit(aggressorId: number, targetId: number, spellId: number): void {
    for (const effect of spellEffects(this.mp, spellId)) {
      if (effect.archetype === MgefArchetype.Banish) {
        this.banish(aggressorId, targetId, spellId, effect);
      } else if (effect.archetype === MgefArchetype.Reanimate && isPlayerActor(this.mp, aggressorId)) {
        this.clearPending(aggressorId);
        this.lastReanimateHit.set(aggressorId, Date.now());
        const refusal = this.reanimateRefusal(aggressorId, targetId, effect);
        if (refusal) this.log(`ConjurationSystem: ${hex(aggressorId)} cannot reanimate ${hex(targetId)} with ${hex(spellId)}: ${refusal}`);
        else this.reanimate(aggressorId, targetId, spellId, effect);
      }
    }
  }

  private duration(effect: SpellEffect): number {
    return effect.durationSec >= PERMANENT_SEC ? 0 : effect.durationSec;
  }

  private clearPending(casterId: number): void {
    const p = this.pending.get(casterId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(casterId);
  }

  // Empty when the corpse can be raised; player bodies, companions and their bodies never can
  private reanimateRefusal(casterId: number, corpseId: number, effect: SpellEffect): string {
    const mp = this.mp;
    let dead = false;
    try { dead = mp.get(corpseId, "isDead") === true; } catch { return "not an actor"; }
    if (!dead) return "not dead";
    // A plugin-placed actor cannot be destroyed (the world loads it again with its items), so only server-placed corpses rise
    if (corpseId < 0xff000000) return "a plugin-placed NPC";
    if (isPlayerActor(mp, corpseId)) return "a player body";
    if (this.companions.isCompanionActor(corpseId)) return "a companion";
    if (!isNear(mp, casterId, corpseId, REANIMATE_RANGE)) return "out of range";
    if (!keywordConditionsPass(mp, effect.mgefId, corpseId)) return "keyword conditions";
    const level = npcLevel(mp, corpseId);
    if (level > effect.magnitude) return `level ${level} over ${effect.magnitude}`;
    return "";
  }

  // A fresh actor of the corpse's base takes its place and inventory, so the old hoster and the zone spawner let go of it
  private reanimate(casterId: number, corpseId: number, spellId: number, effect: SpellEffect): void {
    const mp = this.mp;
    let loc: { pos: number[]; rot: number[] };
    let inventory: unknown;
    try {
      loc = mp.get(corpseId, "locationalData");
      inventory = mp.get(corpseId, "inventory");
    } catch {
      return;
    }
    const pos = [loc.pos[0], loc.pos[1], loc.pos[2] + REANIMATE_LIFT];
    const id = this.companions.spawn(casterId, baseIdOf(mp, corpseId),
      { kind: "reanimated", pos, rot: loc.rot, durationSec: this.duration(effect), source: spellId });
    if (id === null) return;
    try { mp.set(id, "inventory", inventory); } catch (e) { this.log(`ConjurationSystem: inventory copy to ${hex(id)} failed: ${e}`); }
    try { mp.destroyActor(corpseId); } catch { }
    this.log(`ConjurationSystem: ${hex(casterId)} reanimated ${hex(corpseId)} as ${hex(id)}`);
  }

  private reanimateFallback(casterId: number): void {
    const p = this.pending.get(casterId);
    if (!p) return;
    this.pending.delete(casterId);
    const mp = this.mp;
    let neighbors: number[] = [];
    let origin: number[];
    let heading = 0;
    try {
      neighbors = mp.get(casterId, "actorNeighbors") ?? [];
      origin = mp.getActorPos(casterId);
      heading = ((Number(mp.get(casterId, "angle")?.[2]) || 0) * Math.PI) / 180;
    } catch {
      return;
    }
    let best = 0;
    let bestDistance = REANIMATE_FALLBACK_RANGE;
    for (const raw of neighbors) {
      const id = Number(raw) >>> 0;
      let q: number[];
      try { q = mp.getActorPos(id); } catch { continue; }
      const dx = q[0] - origin[0], dy = q[1] - origin[1];
      const distance = Math.hypot(dx, dy);
      if (distance >= bestDistance) continue;
      const off = Math.atan2(Math.sin(Math.atan2(dx, dy) - heading), Math.cos(Math.atan2(dx, dy) - heading));
      if (Math.abs(off) * (180 / Math.PI) > REANIMATE_FALLBACK_CONE_DEG) continue;
      if (this.reanimateRefusal(casterId, id, p.effect)) continue;
      best = id;
      bestDistance = distance;
    }
    if (best) this.reanimate(casterId, best, p.spellId, p.effect);
  }

  // Vanilla Banish: a summoned daedra whose level is within the magnitude returns to Oblivion
  private banish(casterId: number, targetId: number, spellId: number, effect: SpellEffect): void {
    const info = this.companions.info(targetId);
    if (!info || info.kind !== "summon") return;
    if (!keywordConditionsPass(this.mp, effect.mgefId, targetId)) return;
    if (npcLevel(this.mp, targetId) > effect.magnitude) return;
    this.companions.dismiss(targetId, `banished by ${hex(casterId)} with ${hex(spellId)}`);
  }
}
