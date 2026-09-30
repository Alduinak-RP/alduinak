import { ActiveEffectApplyRemoveEvent, Actor, Form, Game, HitEvent, MagicEffect, MagicEffectApplyEvent, ObjectReference, Spell, Weapon } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { DeathService } from "./deathService";
import { getMaximumActorValue, setActorValuePercentage } from "../../sync/actorvalues";
import { isHostedByMe, remoteIdToLocalId } from "../../view/worldViewMisc";
import { logToPlatformLog } from "../../logging";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

const PLAYER_ID = 0x14;
const FIRST_RUNTIME_ID = 0xff000000;
// The weapon hit and the hit spell it casts queue in the same frame, so a pair is never further apart than this
const PAIR_WINDOW_MS = 250;
// The server's verdict on a swing comes a round trip after its poison landed here
const SERVER_VERDICT_WINDOW_MS = 3000;
// Longer than the longest creature hit poison, DLC1crFalmerPoisonedWeapon06's 4 s
const LANDED_TTL_MS = 5000;
const DELIVERY_CONTACT = 1;
const CASTING_FIRE_AND_FORGET = 1;
const HOSTILE_FLAG = 0x1;
const DETRIMENTAL_FLAG = 0x4;
const POISON_RESIST = "PoisonResist";
// A blocked swing lands from the front, the server's ShouldBeBlocked arc of 1 rad
const BLOCK_ARC_DEG = 57.3;
const WEAPON_TYPE_BOW = 7;
const WEAPON_TYPE_CROSSBOW = 9;
const LOG_GAP_MS = 5000;

// crFalmerFFContact, the one effect of every Falmer poison spell
const FALMER_POISON_EFFECT = 0x109d7c;
// magicEffectApply names the effect and dispelSpell needs the SPEL: the Falmer poison spells behind crFalmerFFContact
const HIT_SPELLS_BY_EFFECT = new Map<number, number[]>([[FALMER_POISON_EFFECT, [0x109d7b, 0x109d7e, 0x109d7f, 0x109d80, 0x109d81]]]);
const DAWNGUARD_FALMER_POISON = { id: 0x015cad, plugin: "Dawnguard.esm" };

interface Landed {
  spellIds: number[];
  at: number;
  healthBefore: number;
  source: string;
  // IsBlocking and facing when the spell landed, the verdict when no weapon hit pairs with it
  blockingPose: boolean;
  verdict: "pending" | "kept" | "dispelled";
}

interface Swing {
  at: number;
  // Why the swing counts as blocked, empty for a hit that lands
  reason: string;
}

// Creature poison hit spells (the Falmer perk's crFalmerPoisonedWeapon, spider and chaurus bites) are cast by the victim's own engine and never reach the server,
// so a blocked swing still poisons; a hit from a copy this client does not host is a replayed swing whose real hit the host reports.
// Both are dispelled here and the health floored to the value before the effect, keyed to NPC aggressors and Contact-delivery poison effects only.
// The server names every Falmer swing it resolves as blocked (npcHitPoisonBlocked), and that verdict dispels the landing too.
export class NpcHitSpellBlockService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("hit", (e) => this.onHit(e));
    this.controller.on("magicEffectApply", (e: MagicEffectApplyEvent) => this.onEffect(e.effect, e.caster, e.target, "effect"));
    this.controller.on("effectStart", (e: ActiveEffectApplyRemoveEvent) => this.onEffect(e.effect, e.caster, e.target, "start"));
    this.controller.on("update", () => this.expireLanded());
    this.controller.once("update", () => this.resolveDawnguard());
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private resolveDawnguard(): void {
    const id = Game.getFormFromFile(DAWNGUARD_FALMER_POISON.id, DAWNGUARD_FALMER_POISON.plugin)?.getFormID();
    if (id) HIT_SPELLS_BY_EFFECT.get(FALMER_POISON_EFFECT)?.push(id);
  }

  private onHit(e: HitEvent): void {
    const aggressorId = this.npcAggressorId(e.aggressor, e.target);
    const player = Game.getPlayer();
    if (!aggressorId || !player) return;
    const now = Date.now();
    const spell = Spell.from(e.source);
    if (spell) {
      if (this.isPoisonHitSpell(spell)) this.record(aggressorId, [spell.getFormID()], now, "hit");
      return;
    }
    // The server zeroes a swing its client flags blocked or that meets a raised block, so the poison follows the same rule
    const reason = e.isHitBlocked ? "blocked" : !isHostedByMe(aggressorId) ? "not hosted" : this.isBlockingToward(player, aggressorId, e.source) ? "blocking pose" : "";
    this.prune(now);
    this.swings.set(aggressorId, { at: now, reason });
    const landed = this.landed.get(aggressorId);
    if (landed?.verdict === "pending" && now - landed.at <= PAIR_WINDOW_MS) this.decide(aggressorId, landed, reason);
  }

  private onEffect(effect: MagicEffect | null | undefined, caster: ObjectReference | null | undefined, target: ObjectReference | null | undefined, source: string): void {
    const aggressorId = this.npcAggressorId(caster, target);
    if (!aggressorId || !effect || !this.isPoisonHitEffect(effect)) return;
    const effectId = effect.getFormID();
    const spellIds = HIT_SPELLS_BY_EFFECT.get(effectId);
    if (!spellIds) {
      // The hit event carries the SPEL for race attack spells; a perk hit spell outside the table needs a row here
      this.logThrottled(`effect-${effectId}`, `contact poison effect ${effectId.toString(16)} from ${aggressorId.toString(16)} has no spell table row`);
      return;
    }
    this.record(aggressorId, spellIds, Date.now(), source);
  }

  // magicEffectApply, effectStart and the spell's hit event report one landing; the paired weapon hit decides, whichever comes first
  private record(aggressorId: number, spellIds: number[], now: number, source: string): void {
    const player = Game.getPlayer();
    if (!player) return;
    const previous = this.landed.get(aggressorId);
    const sameLanding = previous && now - previous.at <= PAIR_WINDOW_MS;
    const entry: Landed = {
      spellIds: sameLanding ? previous.spellIds.concat(spellIds.filter((id) => !previous.spellIds.includes(id))) : spellIds,
      at: sameLanding ? previous.at : now,
      healthBefore: sameLanding ? previous.healthBefore : player.getActorValuePercentage("health"),
      source: sameLanding ? `${previous.source}+${source}` : source,
      blockingPose: false,
      verdict: "pending",
    };
    this.landed.set(aggressorId, entry);
    if (sameLanding && previous.verdict === "kept") {
      entry.verdict = "kept";
      return;
    }
    // A later report of a dispelled landing dispels again, the effect may not have been listed at the first try
    if (sameLanding && previous.verdict === "dispelled") return this.dispel(aggressorId, entry, `again, ${source}`);
    if (!isHostedByMe(aggressorId)) return this.dispel(aggressorId, entry, `not hosted, ${source}`);
    const swing = this.swings.get(aggressorId);
    if (swing && now - swing.at <= PAIR_WINDOW_MS) return this.decide(aggressorId, entry, swing.reason);
    entry.blockingPose = this.isBlockingToward(player, aggressorId, null);
  }

  private decide(aggressorId: number, entry: Landed, reason: string): void {
    if (reason) return this.dispel(aggressorId, entry, `${reason}, ${entry.source}`);
    entry.verdict = "kept";
    this.logThrottled(`kept-${aggressorId}`, `kept ${this.spellList(entry)} from ${aggressorId.toString(16)} (unblocked, ${entry.source})`);
  }

  private expireLanded(): void {
    if (this.landed.size === 0) return;
    const now = Date.now();
    this.landed.forEach((entry, id) => {
      if (now - entry.at > LANDED_TTL_MS) this.landed.delete(id);
      else if (entry.verdict === "pending" && now - entry.at > PAIR_WINDOW_MS) this.decide(id, entry, entry.blockingPose ? "blocking pose" : "");
    });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "npcHitPoisonBlocked" || typeof content["aggressor"] !== "number") return;
    const remoteId = content["aggressor"];
    this.controller.once("update", () => this.onServerBlocked(remoteId));
  }

  // The server resolved this NPC's swing as blocked and refused its damage, so the poison it carried goes too
  private onServerBlocked(remoteId: number): void {
    const player = Game.getPlayer();
    const aggressorId = remoteIdToLocalId(remoteId);
    if (!player || !aggressorId) return;
    const now = Date.now();
    const entry = this.landed.get(aggressorId);
    if (entry && now - entry.at <= SERVER_VERDICT_WINDOW_MS) {
      if (entry.verdict !== "dispelled") this.dispel(aggressorId, entry, `server blocked, ${entry.source}`);
      return;
    }
    // No landing seen from it: a Falmer poison still on the player is its, unless another Falmer's unblocked hit poisoned the player too
    const effect = MagicEffect.from(Game.getFormEx(FALMER_POISON_EFFECT));
    const keptElsewhere = Array.from(this.landed.values()).some((other) => other.verdict === "kept");
    if (!effect || keptElsewhere || !player.hasMagicEffect(effect)) {
      this.logThrottled(`server-${aggressorId}`, `server blocked a hit of ${aggressorId.toString(16)}, no poison of it to dispel`);
      return;
    }
    const unseen: Landed = { spellIds: HIT_SPELLS_BY_EFFECT.get(FALMER_POISON_EFFECT) ?? [], at: now, healthBefore: player.getActorValuePercentage("health"), source: "server", blockingPose: false, verdict: "pending" };
    this.landed.set(aggressorId, unseen);
    this.dispel(aggressorId, unseen, "server blocked, unseen");
  }

  private dispel(aggressorId: number, entry: Landed, reason: string): void {
    entry.verdict = "dispelled";
    const spells = entry.spellIds.map((id) => Spell.from(Game.getFormEx(id))).filter((spell): spell is Spell => !!spell);
    this.controller.once("update", () => {
      const player = this.livePlayer();
      if (!player) return;
      spells.forEach((spell) => player.dispelSpell(spell));
      // A dispel that ran before the engine listed the effect misses it, so the next frame looks again
      this.controller.once("update", () => {
        const player = this.livePlayer();
        if (!player) return;
        const missed = spells.filter((spell) => this.poisonEffects(spell).some((effect) => player.hasMagicEffect(effect)));
        missed.forEach((spell) => player.dispelSpell(spell));
        // Only the poison's own first tick is undone, damage the server sent in the same frame stays
        const tick = Math.max(0, ...spells.map((spell) => this.healthTick(spell)));
        const after = player.getActorValuePercentage("health");
        const maxHealth = getMaximumActorValue(player, "health") || 1;
        const restored = after < entry.healthBefore && entry.healthBefore - after <= tick / maxHealth + 0.001;
        if (restored) setActorValuePercentage(player, "health", entry.healthBefore);
        this.logThrottled(`dispel-${aggressorId}`, `dispelled ${this.spellList(entry)} from ${aggressorId.toString(16)} (${reason}), health ${entry.healthBefore.toFixed(3)} -> ${after.toFixed(3)}${restored ? ", restored" : ""}${missed.length ? `, ${missed.length} still active after the first dispel` : ""}`);
      });
    });
  }

  private spellList(entry: Landed): string {
    return entry.spellIds.map((id) => id.toString(16)).join("/");
  }

  private livePlayer(): Actor | null {
    const player = Game.getPlayer();
    return player && !player.isDead() && !this.controller.lookupListener(DeathService).isBusy() ? player : null;
  }

  private poisonEffects(spell: Spell): MagicEffect[] {
    const effects: MagicEffect[] = [];
    for (let i = 0; i < spell.getNumEffects(); i++) {
      const effect = spell.getNthEffectMagicEffect(i);
      if (effect && this.isPoisonHitEffect(effect)) effects.push(effect);
    }
    return effects;
  }

  private healthTick(spell: Spell): number {
    let tick = 0;
    for (let i = 0; i < spell.getNumEffects(); i++) {
      const effect = spell.getNthEffectMagicEffect(i);
      if (effect && this.isPoisonHitEffect(effect)) tick = Math.max(tick, spell.getNthEffectMagnitude(i));
    }
    return tick;
  }

  private isPoisonHitSpell(spell: Spell): boolean {
    return this.poisonEffects(spell).length > 0;
  }

  // The Falmer poison by its id, other creature hit poisons by their shape
  private isPoisonHitEffect(effect: MagicEffect): boolean {
    return HIT_SPELLS_BY_EFFECT.has(effect.getFormID()) || (effect.getDeliveryType() === DELIVERY_CONTACT
      && effect.getCastingType() === CASTING_FIRE_AND_FORGET
      && (effect.isEffectFlagSet(HOSTILE_FLAG) || effect.isEffectFlagSet(DETRIMENTAL_FLAG))
      && effect.getResistance() === POISON_RESIST);
  }

  // The local player hit by an NPC copy: server NPCs and other players' copies alike carry runtime ids
  private npcAggressorId(aggressor: ObjectReference | null | undefined, target: ObjectReference | null | undefined): number {
    if (!target || target.getFormID() !== PLAYER_ID || !aggressor) return 0;
    const id = aggressor.getFormID();
    return id >= FIRST_RUNTIME_ID && id !== PLAYER_ID && Actor.from(aggressor) ? id : 0;
  }

  // The server's raised-shield rule: holding a block with the aggressor in the frontal arc, and a shield against arrows and bolts
  private isBlockingToward(player: Actor, aggressorId: number, source: Form | null): boolean {
    if (!player.getAnimationVariableBool("IsBlocking")) return false;
    const aggressor = Actor.from(Game.getFormEx(aggressorId));
    if (!aggressor || Math.abs(player.getHeadingAngle(aggressor)) >= BLOCK_ARC_DEG) return false;
    const weaponType = Weapon.from(source)?.getWeaponType();
    return (weaponType !== WEAPON_TYPE_BOW && weaponType !== WEAPON_TYPE_CROSSBOW) || !!player.getEquippedShield();
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

  private landed = new Map<number, Landed>();
  private swings = new Map<number, Swing>();
  private loggedAt = new Map<string, number>();
}
