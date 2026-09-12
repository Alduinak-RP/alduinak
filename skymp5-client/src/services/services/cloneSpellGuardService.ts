import { Actor, Game, HitEvent, Spell } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { DeathService } from "./deathService";
import { setActorValuePercentage } from "../../sync/actorvalues";
import { isHostedByMe } from "../../view/worldViewMisc";

// Remote Fire Storm and Blizzard replay on the caster's clone for their visuals, the real caster reports every hit
export class CloneSpellGuardService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("hit", (e) => this.onHit(e));
        this.controller.on("update", () => this.enforce());
    }

    // Must run before the queued replay executes, so the floor is the health before the clone's hits
    public guardClone(cloneLocalId: number, spellId: number) {
        const player = Game.getPlayer();
        if (!player || player.isDead()) {
            return;
        }
        if (this.healthFloor === undefined) {
            this.healthFloor = player.getActorValuePercentage("health");
        }
        const expiresAt = Date.now() + this.getGuardMs(spellId);
        this.guardedClones.set(cloneLocalId, Math.max(expiresAt, this.guardedClones.get(cloneLocalId) ?? 0));
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
        this.guardedClones.forEach((expiresAt, cloneLocalId) => {
            if (now >= expiresAt) {
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

    private onHit(e: HitEvent) {
        const aggressorId = e.aggressor?.getFormID();
        const targetId = e.target?.getFormID();
        if (aggressorId === undefined || targetId === undefined || !this.guardedClones.has(aggressorId)) {
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
    private readonly guardMarginSec = 5;
    private guardedClones = new Map<number, number>();
    private healthFloor: number | undefined = undefined;
}
