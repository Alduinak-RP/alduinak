import { Actor, Game, HitEvent, ObjectReference, Spell } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { DeathService } from "./deathService";
import { setActorValuePercentage } from "../../sync/actorvalues";
import { isHostedByMe } from "../../view/worldViewMisc";

interface CloneGuard {
    floorUntil: number;
    dispelUntil: number;
}

// Hostile casts replayed on a remote caster's clone are visual, the real caster reports every hit
export class CloneSpellGuardService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("hit", (e) => this.onHit(e));
        this.controller.on("update", () => this.enforce());
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
            launchedFromClone = launchedFromClone || effect.getDeliveryType() !== this.selfDelivery;
            concentration = concentration || effect.getCastingType() === this.concentrationCasting;
            // Slows, fear and paralysis restore their value when they end and never lower health
            const harmful = effect.isEffectFlagSet(this.hostileFlag) || effect.isEffectFlagSet(this.detrimentalFlag);
            if (harmful && !effect.isEffectFlagSet(this.recoverFlag)) {
                damageSec = Math.max(damageSec, spell.getNthEffectDuration(i));
            }
        }
        // The server applies a hit's magnitude once, so damage over time (Ignite, Chaurus spit) only lands through the replay
        if (damageSec < 0 || damageSec > 1 || !launchedFromClone) {
            return;
        }
        // A channel whose stop got lost keeps streaming until remoteServer sweeps it
        const channelMs = concentration ? channelTimeoutMs + this.guardMarginSec * 1000 : 0;
        this.addGuard(cloneLocalId, Math.max((damageSec + this.guardMarginSec) * 1000, channelMs), false);
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
        const health = player.getActorValuePercentage("health");
        if (health < this.healthFloor) {
            setActorValuePercentage(player, "health", this.healthFloor);
        } else {
            this.healthFloor = health;
        }
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

    private onHit(e: HitEvent) {
        const targetId = e.target?.getFormID();
        if (targetId === undefined || !this.isDispelledReplayHit(e.aggressor)) {
            return;
        }
        if (targetId !== this.playerId && !isHostedByMe(targetId)) {
            return;
        }
        const spellId = this.sp.Spell.from(e.source)?.getFormID();
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
        if (!aggressor || !Actor.from(aggressor)) {
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
        return (seconds + this.guardMarginSec) * 1000;
    }

    private readonly playerId = 0x14;
    // Covers the longest vanilla damage projectile flight, 4 s for Firebolt and Ice Spike at full range
    private readonly guardMarginSec = 5;
    private readonly hostileFlag = 0x1;
    private readonly recoverFlag = 0x2;
    private readonly detrimentalFlag = 0x4;
    private readonly selfDelivery = 0;
    private readonly concentrationCasting = 2;
    private guardedClones = new Map<number, CloneGuard>();
    private healthFloor: number | undefined = undefined;
}
