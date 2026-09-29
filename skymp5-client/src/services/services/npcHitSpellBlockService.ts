import { Actor, Game, HitEvent, MagicEffect, MagicEffectApplyEvent, ObjectReference, Spell } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { DeathService } from "./deathService";
import { getMaximumActorValue, setActorValuePercentage } from "../../sync/actorvalues";
import { isHostedByMe } from "../../view/worldViewMisc";
import { logToPlatformLog } from "../../logging";

const PLAYER_ID = 0x14;
const FIRST_RUNTIME_ID = 0xff000000;
// The weapon hit and the hit spell it casts queue in the same frame, so a pair is never further apart than this
const PAIR_WINDOW_MS = 250;
const DELIVERY_CONTACT = 1;
const CASTING_FIRE_AND_FORGET = 1;
const HOSTILE_FLAG = 0x1;
const DETRIMENTAL_FLAG = 0x4;
const POISON_RESIST = "PoisonResist";
// A blocked swing lands from the front, the server's ShouldBeBlocked arc of 1 rad
const BLOCK_ARC_DEG = 57.3;
const LOG_GAP_MS = 5000;

// magicEffectApply names the effect and dispelSpell needs the SPEL: the Falmer poison spells behind crFalmerFFContact
const HIT_SPELLS_BY_EFFECT = new Map<number, number[]>([[0x109d7c, [0x109d7b, 0x109d7e, 0x109d7f, 0x109d80, 0x109d81]]]);
const DAWNGUARD_FALMER_POISON = { id: 0x015cad, plugin: "Dawnguard.esm" };

interface PendingSpells {
  spellIds: number[];
  at: number;
  healthBefore: number;
  source: string;
  // IsBlocking and facing when the spell landed, the verdict when no weapon hit pairs with it
  blockingPose: boolean;
}

interface Swing {
  at: number;
  blocked: boolean;
}

// Creature poison hit spells (the Falmer perk's crFalmerPoisonedWeapon, spider and chaurus bites) are cast by the victim's own engine and never reach the server,
// so a blocked swing still poisons; a hit from a copy this client does not host is a replayed swing whose real hit the host reports.
// Both are dispelled here and the health floored to the value before the effect, keyed to NPC aggressors and Contact-delivery poison effects only.
export class NpcHitSpellBlockService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("hit", (e) => this.onHit(e));
    this.controller.on("magicEffectApply", (e) => this.onMagicEffectApply(e));
    this.controller.on("update", () => this.expirePending());
    this.controller.once("update", () => this.resolveDawnguard());
  }

  private resolveDawnguard(): void {
    const id = Game.getFormFromFile(DAWNGUARD_FALMER_POISON.id, DAWNGUARD_FALMER_POISON.plugin)?.getFormID();
    if (id) HIT_SPELLS_BY_EFFECT.get(0x109d7c)?.push(id);
  }

  private onHit(e: HitEvent): void {
    const aggressorId = this.npcAggressorId(e.aggressor, e.target);
    if (!aggressorId) return;
    const now = Date.now();
    const spell = Spell.from(e.source);
    if (spell) {
      if (!this.isPoisonHitSpell(spell)) return;
      this.record(aggressorId, [spell.getFormID()], now, "hit");
      return;
    }
    // A weapon or unarmed swing: blocked, replayed by a copy another client runs, or a hit the engine let through
    const reason = e.isHitBlocked ? "blocked" : !isHostedByMe(aggressorId) ? "not hosted" : "";
    this.prune(now);
    this.swings.set(aggressorId, { at: now, blocked: !!reason });
    const pending = this.pending.get(aggressorId);
    if (!pending || now - pending.at > PAIR_WINDOW_MS) return;
    this.pending.delete(aggressorId);
    if (reason) this.dispel(aggressorId, pending, `${reason}, ${pending.source}`);
  }

  private onMagicEffectApply(e: MagicEffectApplyEvent): void {
    const aggressorId = this.npcAggressorId(e.caster, e.target);
    if (!aggressorId || !e.effect || !this.isPoisonHitEffect(e.effect)) return;
    const effectId = e.effect.getFormID();
    const spellIds = HIT_SPELLS_BY_EFFECT.get(effectId);
    if (!spellIds) {
      // The hit event carries the SPEL for race attack spells; a perk hit spell outside the table needs a row here
      this.logThrottled(`effect-${effectId}`, `contact poison effect ${effectId.toString(16)} from ${aggressorId.toString(16)} has no spell table row`);
      return;
    }
    this.record(aggressorId, spellIds, Date.now(), "effect");
  }

  // The paired weapon hit decides, whichever of the two events comes first; the pose only decides when no weapon hit comes
  private record(aggressorId: number, spellIds: number[], now: number, source: string): void {
    const player = Game.getPlayer();
    if (!player) return;
    const entry: PendingSpells = { spellIds, at: now, healthBefore: player.getActorValuePercentage("health"), source, blockingPose: false };
    if (!isHostedByMe(aggressorId)) {
      this.dispel(aggressorId, entry, `not hosted, ${source}`);
      return;
    }
    const swing = this.swings.get(aggressorId);
    if (swing && now - swing.at <= PAIR_WINDOW_MS) {
      if (swing.blocked) this.dispel(aggressorId, entry, `blocked, ${source}`);
      return;
    }
    entry.blockingPose = this.isBlockingToward(player, aggressorId);
    this.pending.set(aggressorId, entry);
  }

  private expirePending(): void {
    if (this.pending.size === 0) return;
    const now = Date.now();
    this.pending.forEach((entry, id) => {
      if (now - entry.at <= PAIR_WINDOW_MS) return;
      this.pending.delete(id);
      if (entry.blockingPose) this.dispel(id, entry, `blocking pose, ${entry.source}`);
    });
  }

  private dispel(aggressorId: number, entry: PendingSpells, reason: string): void {
    this.controller.once("update", () => {
      const player = Game.getPlayer();
      if (!player || player.isDead() || this.controller.lookupListener(DeathService).isBusy()) return;
      let tick = 0;
      for (const id of entry.spellIds) {
        const spell = Spell.from(Game.getFormEx(id));
        if (!spell) continue;
        tick = Math.max(tick, this.healthTick(spell));
        player.dispelSpell(spell);
      }
      // Only the poison's own first tick is undone, damage the server sent in the same frame stays
      const after = player.getActorValuePercentage("health");
      const maxHealth = getMaximumActorValue(player, "health") || 1;
      const restored = after < entry.healthBefore && entry.healthBefore - after <= tick / maxHealth + 0.001;
      if (restored) setActorValuePercentage(player, "health", entry.healthBefore);
      this.logThrottled(`dispel-${aggressorId}`, `dispelled ${entry.spellIds.map((id) => id.toString(16)).join("/")} from ${aggressorId.toString(16)} (${reason}), health ${entry.healthBefore.toFixed(3)} -> ${after.toFixed(3)}${restored ? ", restored" : ""}`);
    });
  }

  private healthTick(spell: Spell): number {
    let tick = 0;
    for (let i = 0; i < spell.getNumEffects(); i++) {
      if (spell.getNthEffectMagicEffect(i)?.getResistance() === POISON_RESIST) tick = Math.max(tick, spell.getNthEffectMagnitude(i));
    }
    return tick;
  }

  private isPoisonHitSpell(spell: Spell): boolean {
    for (let i = 0; i < spell.getNumEffects(); i++) {
      const effect = spell.getNthEffectMagicEffect(i);
      if (effect && this.isPoisonHitEffect(effect)) return true;
    }
    return false;
  }

  private isPoisonHitEffect(effect: MagicEffect): boolean {
    return effect.getDeliveryType() === DELIVERY_CONTACT
      && effect.getCastingType() === CASTING_FIRE_AND_FORGET
      && (effect.isEffectFlagSet(HOSTILE_FLAG) || effect.isEffectFlagSet(DETRIMENTAL_FLAG))
      && effect.getResistance() === POISON_RESIST;
  }

  // The local player hit by an NPC copy: server NPCs and other players' copies alike carry runtime ids
  private npcAggressorId(aggressor: ObjectReference | null | undefined, target: ObjectReference | null | undefined): number {
    if (!target || target.getFormID() !== PLAYER_ID || !aggressor) return 0;
    const id = aggressor.getFormID();
    return id >= FIRST_RUNTIME_ID && id !== PLAYER_ID && Actor.from(aggressor) ? id : 0;
  }

  private isBlockingToward(player: Actor, aggressorId: number): boolean {
    if (!player.getAnimationVariableBool("IsBlocking")) return false;
    const aggressor = Actor.from(Game.getFormEx(aggressorId));
    return !!aggressor && Math.abs(player.getHeadingAngle(aggressor)) < BLOCK_ARC_DEG;
  }

  private prune(now: number): void {
    this.swings.forEach((swing, id) => { if (now - swing.at > PAIR_WINDOW_MS) this.swings.delete(id); });
  }

  private logThrottled(key: string, text: string): void {
    const now = Date.now();
    if (now - (this.loggedAt.get(key) ?? 0) < LOG_GAP_MS) return;
    this.loggedAt.set(key, now);
    logToPlatformLog(this, text);
  }

  private pending = new Map<number, PendingSpells>();
  private swings = new Map<number, Swing>();
  private loggedAt = new Map<string, number>();
}
