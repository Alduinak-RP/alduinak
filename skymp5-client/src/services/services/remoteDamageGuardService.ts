import { ActiveEffectApplyRemoveEvent, Actor, Form, Game, HitEvent, MagicEffect, MagicEffectApplyEvent, ObjectReference, Spell, Weapon } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { DeathService } from "./deathService";
import { getMaximumActorValue, setActorValuePercentage } from "../../sync/actorvalues";
import { CASTING_CONCENTRATION, CASTING_FIRE_AND_FORGET, DELIVERY_CONTACT, DELIVERY_SELF, EFFECT_FLAG_RECOVER, isHarmfulEffect } from "../../sync/spell";
import { isHostedByMe, remoteIdToLocalId } from "../../view/worldViewMisc";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { logToPlatformLog } from "../../logging";
import { CustomPacketContent, onCustomPacket } from "./customPacketUtil";

const PLAYER_ID = 0x14;
const FIRST_RUNTIME_ID = 0xff000000;
// Covers the longest vanilla damage projectile flight, 4 s for Firebolt and Ice Spike at full range
const GUARD_MARGIN_SEC = 5;
// The weapon hit and the hit spell it casts queue in the same frame, so a pair is never further apart than this
const PAIR_WINDOW_MS = 250;
// The server's verdict on a swing comes a round trip after its poison landed here
const SERVER_VERDICT_WINDOW_MS = 3000;
// Longer than the longest creature hit poison, DLC1crFalmerPoisonedWeapon06's 4 s
const LANDED_TTL_MS = 5000;
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

interface CloneGuard {
  floorUntil: number;
  dispelUntil: number;
}

interface NativeDispel {
  dispelSpellFrom?: (actorFormId: number, spellFormId: number, casterFormId: number) => void;
}

interface Landed {
  spellIds: number[];
  at: number;
  healthBefore: number;
  source: string;
  // IsBlocking and facing when the spell landed, the verdict when no weapon hit pairs with it
  blockingPose: boolean;
  // Spared: blocked, but dispelSpell would also take another NPC's unblocked copy still running
  verdict: "pending" | "kept" | "dispelled" | "spared";
}

interface Swing {
  at: number;
  // Why the swing counts as blocked, empty for a hit that lands
  reason: string;
}

// Local damage the server never prices: hostile casts replayed on a remote caster's clone and creature hit poisons the player's own engine casts
export class RemoteDamageGuardService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("hit", (e) => this.onHit(e));
    this.controller.on("magicEffectApply", (e: MagicEffectApplyEvent) => this.onEffect(e.effect, e.caster, e.target, "effect"));
    this.controller.on("effectStart", (e: ActiveEffectApplyRemoveEvent) => this.onEffect(e.effect, e.caster, e.target, "start"));
    this.controller.on("update", () => this.expireLanded());
    this.controller.once("update", () => this.resolveDawnguard());
    onCustomPacket(this.controller, "npcHitPoisonBlocked", (content) => this.onCustomPacketMessage(content));
  }

  // Must run before the queued replay executes, so the floor is the health before the clone's hits
  public guardClone(cloneLocalId: number, spellId: number) {
    this.addGuard(cloneLocalId, this.getGuardMs(spellId), true);
  }

  // Aimed, rune and concentration replays keep their slows and paralysis, only the health floor applies
  public guardHostileReplay(cloneLocalId: number, spellId: number, channelTimeoutMs: number) {
    // Only spell hits reach the server's OnSpellHit, scroll and staff replays stay the victim's only damage
    const spell = Spell.from(Game.getFormEx(spellId));
    if (!spell) {
      return;
    }
    let damageSec = -1;
    let launchedFromClone = false;
    let concentration = false;
    const numEffects = spell.getNumEffects();
    for (let i = 0; i < numEffects; i++) {
      const effect = spell.getNthEffectMagicEffect(i);
      if (!effect) {
        continue;
      }
      launchedFromClone = launchedFromClone || effect.getDeliveryType() !== DELIVERY_SELF;
      concentration = concentration || effect.getCastingType() === CASTING_CONCENTRATION;
      // Slows, fear and paralysis restore their value when they end and never lower health
      if (isHarmfulEffect(effect) && !effect.isEffectFlagSet(EFFECT_FLAG_RECOVER)) {
        damageSec = Math.max(damageSec, spell.getNthEffectDuration(i));
      }
    }
    // The server applies a hit's magnitude once, so damage over time (Ignite, Chaurus spit) only lands through the replay
    if (damageSec < 0 || damageSec > 1 || !launchedFromClone) {
      return;
    }
    // A channel whose stop got lost keeps streaming until remoteServer sweeps it
    const channelMs = concentration ? channelTimeoutMs + GUARD_MARGIN_SEC * 1000 : 0;
    this.addGuard(cloneLocalId, Math.max((damageSec + GUARD_MARGIN_SEC) * 1000, channelMs), false);
  }

  // Server health is authoritative while a replay may still hit the player
  public onServerHealth(health: number) {
    if (this.healthFloor !== undefined) {
      this.healthFloor = health;
    }
  }

  // Undoes the clone's local damage before it can be reported, the floor follows heals and regen
  public enforce() {
    if (this.healthFloor === undefined) {
      return;
    }
    const now = Date.now();
    this.guardedClones.forEach((guard, cloneLocalId) => {
      if (now >= guard.floorUntil) {
        this.guardedClones.delete(cloneLocalId);
      }
    });
    const player = Game.getPlayer();
    if (this.guardedClones.size === 0 || !player || player.isDead()) {
      this.guardedClones.clear();
      this.healthFloor = undefined;
      return;
    }
    if (this.controller.lookupListener(DeathService).isBusy()) {
      return;
    }
    const floored = this.floorHealth(player, this.healthFloor);
    if (!floored.restored) {
      this.healthFloor = floored.health;
    }
  }

  // Puts back a drop below the floor of at most maxDrop, health is the value read before
  private floorHealth(player: Actor, floor: number, maxDrop = Infinity): { health: number; restored: boolean } {
    const health = player.getActorValuePercentage("health");
    const restored = health < floor && floor - health <= maxDrop;
    if (restored) {
      setActorValuePercentage(player, "health", floor);
    }
    return { health, restored };
  }

  private addGuard(cloneLocalId: number, guardMs: number, dispelHits: boolean) {
    const player = Game.getPlayer();
    if (!player || player.isDead()) {
      return;
    }
    if (this.healthFloor === undefined) {
      this.healthFloor = player.getActorValuePercentage("health");
    }
    const expiresAt = Date.now() + guardMs;
    const guard = this.guardedClones.get(cloneLocalId) ?? { floorUntil: 0, dispelUntil: 0 };
    guard.floorUntil = Math.max(guard.floorUntil, expiresAt);
    if (dispelHits) {
      guard.dispelUntil = Math.max(guard.dispelUntil, expiresAt);
    }
    this.guardedClones.set(cloneLocalId, guard);
  }

  private onHit(e: HitEvent): void {
    const targetId = e.target?.getFormID();
    if (targetId === undefined) return;
    this.onReplayHit(e, targetId);
    this.onNpcHit(e, this.npcAggressorId(e.aggressor, targetId));
  }

  private onReplayHit(e: HitEvent, targetId: number): void {
    if (!this.isDispelledReplayHit(e.aggressor)) return;
    if (targetId !== PLAYER_ID && !isHostedByMe(targetId)) return;
    const spellId = Spell.from(e.source)?.getFormID();
    // Dispel removes the hazard's frost damage over time and slow, event context defers it to the update
    this.controller.once("update", () => {
      const target = Actor.from(Game.getFormEx(targetId));
      const spell = spellId ? Spell.from(Game.getFormEx(spellId)) : null;
      if (target && spell) {
        target.dispelSpell(spell);
      }
      this.enforce();
    });
  }

  // Hazard ticks may be blamed on the hazard reference or on no one instead of the clone
  private isDispelledReplayHit(aggressor: ObjectReference | null | undefined): boolean {
    const now = Date.now();
    if (!Array.from(this.guardedClones.values()).some((guard) => guard.dispelUntil > now)) {
      return false;
    }
    if (!aggressor || !ObjectReferenceEx.asActor(aggressor)) {
      return true;
    }
    return (this.guardedClones.get(aggressor.getFormID())?.dispelUntil ?? 0) > now;
  }

  // Longest effect (Blizzard's hazard inherits it) plus a margin for the last ticks
  private getGuardMs(spellId: number): number {
    const spell = Spell.from(Game.getFormEx(spellId));
    let seconds = 0;
    const numEffects = spell ? spell.getNumEffects() : 0;
    for (let i = 0; i < numEffects; i++) {
      seconds = Math.max(seconds, spell!.getNthEffectDuration(i));
    }
    return (seconds + GUARD_MARGIN_SEC) * 1000;
  }

  private resolveDawnguard(): void {
    const id = Game.getFormFromFile(DAWNGUARD_FALMER_POISON.id, DAWNGUARD_FALMER_POISON.plugin)?.getFormID();
    if (id) HIT_SPELLS_BY_EFFECT.get(FALMER_POISON_EFFECT)?.push(id);
  }

  // Creature hit poisons never reach the server, so a blocked swing's poison or a replayed swing's (the host reports its real hit) is dispelled here
  private onNpcHit(e: HitEvent, aggressorId: number): void {
    if (!aggressorId) return;
    const player = Game.getPlayer();
    if (!player) return;
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
    const aggressorId = this.npcAggressorId(caster, target?.getFormID());
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
    if (sameLanding && (previous.verdict === "kept" || previous.verdict === "spared")) {
      entry.verdict = previous.verdict;
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

  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (typeof content["aggressor"] !== "number") return;
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
    // No landing seen from it: a Falmer poison still on the player may be its
    const effect = MagicEffect.from(Game.getFormEx(FALMER_POISON_EFFECT));
    if (!effect || !player.hasMagicEffect(effect)) {
      this.logThrottled(`server-${aggressorId}`, `server blocked a hit of ${aggressorId.toString(16)}, no poison of it to dispel`);
      return;
    }
    const unseen: Landed = { spellIds: HIT_SPELLS_BY_EFFECT.get(FALMER_POISON_EFFECT) ?? [], at: now, healthBefore: player.getActorValuePercentage("health"), source: "server", blockingPose: false, verdict: "pending" };
    this.landed.set(aggressorId, unseen);
    this.dispel(aggressorId, unseen, "server blocked, unseen");
  }

  // dispelSpellFrom takes only this NPC's copy, plain dispelSpell would take every caster's
  private dispel(aggressorId: number, entry: Landed, reason: string): void {
    // Resolved in each update that uses them: a SkyrimPlatform object lasts only the update that made it
    const resolve = () => entry.spellIds.map((id) => Spell.from(Game.getFormEx(id))).filter((spell): spell is Spell => !!spell);
    const byCaster = (this.sp as unknown as NativeDispel).dispelSpellFrom;
    const running = byCaster ? 0 : this.runningPoisonOf(aggressorId, entry);
    if (running) {
      entry.verdict = "spared";
      this.logThrottled(`spared-${aggressorId}`, `left ${this.spellList(entry)} from ${aggressorId.toString(16)} (${reason}), dispelSpell would also take the unblocked poison of ${running.toString(16)}`);
      return;
    }
    entry.verdict = "dispelled";
    const remove = (player: Actor, list: Spell[]) => list.forEach((spell) => byCaster ? byCaster(player.getFormID(), spell.getFormID(), aggressorId) : player.dispelSpell(spell));
    this.controller.once("update", () => {
      const player = this.livePlayer();
      if (!player) return;
      remove(player, resolve());
      // A dispel that ran before the engine listed the effect misses it, so the next frame looks again; another caster's copy keeps the effect listed
      this.controller.once("update", () => {
        const player = this.livePlayer();
        if (!player) return;
        const spells = resolve();
        const missed = byCaster ? [] : spells.filter((spell) => this.poisonEffects(spell).some((effect) => player.hasMagicEffect(effect)));
        remove(player, byCaster ? spells : missed);
        // Only the poison's own first tick is undone, damage the server sent in the same frame stays
        const tick = Math.max(0, ...spells.map((spell) => this.poisonMax(spell, (i) => spell.getNthEffectMagnitude(i))));
        const maxHealth = getMaximumActorValue(player, "health") || 1;
        const { health: after, restored } = this.floorHealth(player, entry.healthBefore, tick / maxHealth + 0.001);
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

  private poisonMax(spell: Spell, value: (effectIndex: number) => number): number {
    let res = 0;
    for (let i = 0; i < spell.getNumEffects(); i++) {
      const effect = spell.getNthEffectMagicEffect(i);
      if (effect && this.isPoisonHitEffect(effect)) res = Math.max(res, value(i));
    }
    return res;
  }

  // Another NPC's kept landing of a shared spell whose poison still runs
  private runningPoisonOf(aggressorId: number, entry: Landed): number {
    const now = Date.now();
    let running = 0;
    this.landed.forEach((other, id) => {
      if (running || id === aggressorId || other.verdict !== "kept" || !other.spellIds.some((s) => entry.spellIds.includes(s))) return;
      const seconds = Math.max(0, ...other.spellIds.map((s) => Spell.from(Game.getFormEx(s))).map((spell) => spell ? this.poisonMax(spell, (i) => spell.getNthEffectDuration(i)) : 0));
      if (now - other.at < seconds * 1000) running = id;
    });
    return running;
  }

  private isPoisonHitSpell(spell: Spell): boolean {
    return this.poisonEffects(spell).length > 0;
  }

  // The Falmer poison by its id, other creature hit poisons by their shape
  private isPoisonHitEffect(effect: MagicEffect): boolean {
    return HIT_SPELLS_BY_EFFECT.has(effect.getFormID()) || (effect.getDeliveryType() === DELIVERY_CONTACT
      && effect.getCastingType() === CASTING_FIRE_AND_FORGET
      && isHarmfulEffect(effect)
      && effect.getResistance() === POISON_RESIST);
  }

  // The local player hit by an NPC copy: server NPCs and other players' copies alike carry runtime ids
  private npcAggressorId(aggressor: ObjectReference | null | undefined, targetId: number | undefined): number {
    if (targetId !== PLAYER_ID || !aggressor) return 0;
    const id = aggressor.getFormID();
    return id >= FIRST_RUNTIME_ID && id !== PLAYER_ID && ObjectReferenceEx.asActor(aggressor) ? id : 0;
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

  private guardedClones = new Map<number, CloneGuard>();
  private healthFloor: number | undefined = undefined;
  private landed = new Map<number, Landed>();
  private swings = new Map<number, Swing>();
  private loggedAt = new Map<string, number>();
}
