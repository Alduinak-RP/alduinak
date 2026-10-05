// TODO: refactor this out
import { formProp, isHostedByMe, localIdToRemoteId } from "../../view/worldViewMisc";

import { FormType, HitEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { Hit } from "../messages/hitMessage";
import { logToPlatformLog } from "../../logging";

const NPC_SPELL_HIT_LOG_GAP_MS = 5000;

export class HitService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('hit', (e) => this.onHit(e));
    }

    private onHit(e: HitEvent) {
        // TODO: add more logging in case of 'return'
        // TODO: allow non-weapon sources
        const aggressor = e.aggressor.getFormID();
        if (aggressor < 0xff000000 && aggressor !== 0x14) return; // all skymp npcs are FF+

        this.logNpcSpellHit(e, aggressor);

        if (aggressor >= 0xff000000 && !isHostedByMe(aggressor)) {
            return;
        }

        const base = e.target.getBaseObject();
        const type = base?.getType();

        if (type === FormType.Static || type === FormType.MovableStatic) {
            return;
        }

        const isWeapon = this.sp.Weapon.from(e.source);
        const isSpell = !isWeapon && this.sp.Spell.from(e.source);
        const isScroll = !isWeapon && !isSpell && this.sp.Scroll.from(e.source);

        if (!isWeapon && !isSpell && !isScroll) {
            return;
        }

        // The model's isDead, not the engine's: a local hit can kill a copy the server still has alive
        if (isWeapon && formProp(localIdToRemoteId(e.target.getFormID(), true), "isDead") === true) {
            return;
        }

        // prevent double hit that happens for some reason with magic projectiles
        // Keyed per target: area spells hit every target in the same frame
        if (isSpell || isScroll) {
            const key = `${e.aggressor.getFormID()}:${e.target.getFormID()}`;
            const now = Date.now();

            const lastHitTime = this.recentMagicHits.get(key);
            if (lastHitTime && now - lastHitTime < this.magicHitDedupMs) {
                return;
            }

            this.recentMagicHits.set(key, now);
            this.pruneRecentMagicHits(now);
        }

        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.OnHit, data: this.getHitData(e) },
            reliability: "reliable"
        });
    }

    private getHitData(e: HitEvent): Hit {
        const hitData: Hit = {
            aggressor: localIdToRemoteId(e.aggressor.getFormID()),
            isBashAttack: e.isBashAttack,
            isHitBlocked: e.isHitBlocked,
            isPowerAttack: e.isPowerAttack,
            isSneakAttack: e.isSneakAttack,
            projectile: e.projectile ? e.projectile.getFormID() : 0,
            source: e.source ? e.source.getFormID() : 0,
            target: localIdToRemoteId(e.target.getFormID())
        }
        return hitData;
    }

    // Whether the engine raises a hit event for a creature's hit spell (perk or race attack) on the player, per source
    private logNpcSpellHit(e: HitEvent, aggressor: number) {
        if (aggressor === 0x14 || e.target.getFormID() !== 0x14 || !e.source || this.sp.Weapon.from(e.source)) return;
        const sourceId = e.source.getFormID();
        const now = Date.now();
        if (now - (this.npcSpellHitLoggedAt.get(sourceId) ?? 0) < NPC_SPELL_HIT_LOG_GAP_MS) return;
        this.npcSpellHitLoggedAt.set(sourceId, now);
        logToPlatformLog(this, `npc ${aggressor.toString(16)} (hosted ${isHostedByMe(aggressor)}) hit the player with source ${sourceId.toString(16)} type ${e.source.getType()}, blocked ${e.isHitBlocked}`);
    }

    private pruneRecentMagicHits(now: number) {
        if (this.recentMagicHits.size <= 64) {
            return;
        }
        this.recentMagicHits.forEach((time, key) => {
            if (now - time >= this.magicHitDedupMs) {
                this.recentMagicHits.delete(key);
            }
        });
    }

    private readonly magicHitDedupMs = 100;
    private recentMagicHits: Map<string, number> = new Map();
    private npcSpellHitLoggedAt: Map<number, number> = new Map();
}
