// TODO: refactor this out
import { isHostedByMe, localIdToRemoteId } from "../../view/worldViewMisc";

// @ts-expect-error (TODO: Remove in 2.10.0)
import { SpellCastEvent, Actor, printConsole, Game, getAnimationVariablesFromActor, ActorAnimationVariables, SpellType, SlotType, EquippedItemType, Spell, Debug } from 'skyrimPlatform'
import { ClientListener, CombinedController, Sp } from './clientListener';
import { logTrace } from '../../logging';

import { MsgType } from "../../messages";
import { SpellCastMsgData, SpellCastMessage } from "../messages/spellCastMessage";
import { UpdateAnimVariablesMessageMsgData } from "../messages/updateAnimVariablesMessage";

// Racial greater powers are disabled on this server (form ids verified against Skyrim.esm on the reference install)
const BLOCKED_POWER_IDS = new Set([
    0x000E40C3, // PowerNordBattleCry
    0x000E40C8, // PowerHighElfMagickaRegen (Highborn)
    0x000E40CA, // PowerImperialPacify (Voice of the Emperor)
    0x000E40CE, // PowerRedguardStaminaRegen (Adrenaline Rush)
    0x000E40CF, // PowerWoodElfCommandAnimal
    0x000E40D4, // PowerDarkElfFlameCloak (Ancestor's Wrath)
    0x000E40D5, // PowerArgonianHistskin
    0x000AA01D, // PowerKhajiitNightEye
    0x000AA022, // PowerBretonAbsorbSpell (Dragonskin)
    0x000AA026, // RaceOrcBerserk (Berserker Rage)
]);

// A relayed cast, tracked per caster and hand until its stop and echoes are sent
interface RelayedCast {
    msg: SpellCastMsgData;
    // The player's remote id has no form view, so the caster is never mapped back from msg.caster
    casterLocalId: number;
    startedMs: number;
    lastKeepAliveMs: number;
    seenCasting: boolean;
    stopEchoAt: number[];
}

export class MagicSyncService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("spellCast", (e) => this.onSpellCast(e));

        const self = this;


        this.sp.hooks.sendAnimationEvent.add({
            enter: (ctx) => { },
            leave: (ctx) => {
                self.onSendAnimationEventLeave(ctx);
            }
        }, this.playerId, this.playerId);
    }

    private onUpdate() {
        this.syncRelayedCasts();

        if (this.isAnyMagicStuffEquiped() === false) {
            return;
        }

        if (Date.now() - this.lastSendUpdateAnimationVariables <= this.sendUpdateAnimationVariablesRateMs) {
            return;
        }

        this.lastSendUpdateAnimationVariables = Date.now();

        this.controller.once('update', () => {
            const ac = Game.getPlayer();

            if (!ac) {
                return;
            }

            const animVariables = this.getAnimationVariablesFromActorConverted(ac.getFormID());

            this.controller.emitter.emit("sendMessage", {
                message: { t: MsgType.UpdateAnimVariables, data: this.getUpdateAnimVariablesEventData(ac, animVariables) },
                reliability: "reliable"
            });
        });

    }

    private onSpellCast(event: SpellCastEvent) {
        // Blocked racial powers: dispel locally, tell the player, do not relay
        if (event.caster && event.caster.getFormID() === this.playerId &&
            event.spell && BLOCKED_POWER_IDS.has(event.spell.getFormID())) {
            const spellId = event.spell.getFormID();
            this.controller.once('update', () => {
                const player = Game.getPlayer();
                const spell = Spell.from(Game.getFormEx(spellId));
                if (player && spell) {
                    player.dispelSpell(spell);
                }
                Debug.notification("Racial powers are disabled on this server.");
            });
            return;
        }

        // Clone replays fire this event too, but the server only accepts our own and hosted casters
        const casterLocalId = event.caster.getFormID();
        if (casterLocalId !== this.playerId && !isHostedByMe(casterLocalId)) {
            return;
        }

        const msg: SpellCastMsgData = this.getSpellCastEventData(event, false);
        this.sendSpellCast(msg);

        const now = Date.now();
        this.relayedCasts.set(this.getCastKey(casterLocalId, msg.castingSource), {
            msg,
            casterLocalId,
            startedMs: now,
            lastKeepAliveMs: now,
            seenCasting: false,
            stopEchoAt: [],
        });
    }

    private onSendAnimationEventLeave(ctx: { animEventName: string, animationSucceeded: boolean }) {
        const source = this.getEquippedAnimSource(ctx.animEventName);
        if (source === undefined) {
            return;
        }

        // Hook context cannot touch game state, so the stop waits for the next update
        this.controller.once('update', () => {
            const cast = this.relayedCasts.get(this.getCastKey(this.playerId, source));
            if (cast && !this.isCastSourceCasting(cast)) {
                this.sendCastStop(cast);
            }
        });
    }

    // Shared stop path: marks the cast, sends it and arms the echoes
    private sendCastStop(cast: RelayedCast) {
        const msg = cast.msg;
        if (msg.interruptCast) {
            return;
        }
        msg.interruptCast = true;
        msg.keepAlive = false;
        if (Actor.from(Game.getFormEx(cast.casterLocalId))) {
            msg.actorAnimationVariables = this.getAnimationVariablesFromActorConverted(cast.casterLocalId);
        }
        this.sendSpellCast(msg);
        // Echoes cover a keep-alive or cast landing after the stop, client to server reliable is unordered
        const now = Date.now();
        cast.stopEchoAt = this.castStopEchoDelaysMs.map(delay => now + delay);
    }

    private sendSpellCast(msg: SpellCastMsgData) {
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.SpellCast, data: msg },
            reliability: "reliable"
        });
    }

    private isCastSourceCasting(cast: RelayedCast): boolean {
        const ac = Actor.from(Game.getFormEx(cast.casterLocalId));
        // Stowed magic cannot be casting, whatever the anim vars say
        if (!ac || !ac.isWeaponDrawn()) {
            return false;
        }
        const left = ac.getAnimationVariableBool("IsCastingLeft");
        const right = ac.getAnimationVariableBool("IsCastingRight");
        const dual = ac.getAnimationVariableBool("IsCastingDual");
        const spellId = cast.msg.spell;
        // The platform reports a spell held in both hands as right-handed, so either hand counts
        const inBothHands = ac.getEquippedSpell(SpellType.Left)?.getFormID() === spellId
            && ac.getEquippedSpell(SpellType.Right)?.getFormID() === spellId;
        if (dual || inBothHands) {
            return left || right || dual;
        }
        if (cast.msg.castingSource === SpellType.Left) {
            return left;
        }
        return cast.msg.castingSource === SpellType.Right && right;
    }

    private getSpellCastEventData(e: SpellCastEvent, isInterruptCast: boolean): SpellCastMsgData {
        const spellCastData: SpellCastMsgData = {
            caster: localIdToRemoteId(e.caster.getFormID(), true),
            // @ts-expect-error (TODO: Remove in 2.10.0)
            target: e.target ? localIdToRemoteId(e.target.getFormID(), true) : 0,
            spell: e.spell ? e.spell.getFormID() : 0,
            interruptCast: isInterruptCast,
            keepAlive: false,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            isDualCasting: e.isDualCasting,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            castingSource: e.castingSource,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimAngle: e.aimAngle,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimHeading: e.aimHeading,
            actorAnimationVariables: this.getAnimationVariablesFromActorConverted(e.caster.getFormID()),
        }
        return spellCastData;
    }

    private getAnimationVariablesFromActorConverted(actorId: number) {
        const animVars = getAnimationVariablesFromActor(actorId);
        const booleans: ArrayBuffer = animVars.booleans;
        const floats: ArrayBuffer = animVars.floats;
        const integers: ArrayBuffer = animVars.integers;
        return {
            booleans: Array.from(new Uint8Array(booleans)),
            floats: Array.from(new Uint8Array(floats)),
            integers: Array.from(new Uint8Array(integers)),
        }
    }

    private getUpdateAnimVariablesEventData(ac: Actor, animVariables: ActorAnimationVariables): UpdateAnimVariablesMessageMsgData {
        const animVarsData: UpdateAnimVariablesMessageMsgData = {
            actorRemoteId: localIdToRemoteId(ac.getFormID(), true),
            actorAnimationVariables: animVariables,
        }
        return animVarsData;
    }

    // Concentration release fires no event, so each relayed cast polls its hand for the stop and keep-alives
    private syncRelayedCasts() {
        const now = Date.now();
        for (const [key, cast] of Array.from(this.relayedCasts)) {
            const msg = cast.msg;
            const casting = this.isCastSourceCasting(cast);
            if (!msg.interruptCast) {
                cast.seenCasting = cast.seenCasting || casting;
                // Casting vars can lag the cast event, so a hand never seen casting gets a grace period
                if (!casting && (cast.seenCasting || now - cast.startedMs > this.castStartGraceMs)) {
                    this.sendCastStop(cast);
                } else if (casting && now - cast.lastKeepAliveMs > this.castKeepAliveRateMs) {
                    // Keep-alive while channeling so the server channel and observer clones can time out a lost stop
                    cast.lastKeepAliveMs = now;
                    msg.keepAlive = true;
                    this.sendSpellCast(msg);
                }
                continue;
            }
            if (casting) {
                // The hand is casting again and its next cast event replaces this record
                cast.stopEchoAt = [];
            } else if (cast.stopEchoAt.length > 0 && now >= cast.stopEchoAt[0]) {
                cast.stopEchoAt.shift();
                this.sendSpellCast(msg);
            }
            if (cast.stopEchoAt.length === 0) {
                this.relayedCasts.delete(key);
            }
        }
    }

    private getCastKey(casterLocalId: number, castingSource: number): string {
        return `${casterLocalId}:${castingSource}`;
    }

    private getEquippedAnimSource(animEventName: string): number | undefined {
        const eventName = animEventName.toLowerCase();
        if (eventName === "mlh_equipped_event") {
            return SpellType.Left;
        }
        if (eventName === "mrh_equipped_event") {
            return SpellType.Right;
        }
        return undefined;
    }

    private isSpellCastAnim(animEventName: string): boolean {
        const eventName = animEventName.toLowerCase();

        const isSpellCastAnimForLeftHand = eventName === "mlh_spellaimedconcentrationstart" || eventName === "mlh_spellaimedstart" || eventName === "mlh_spellready_event" ||
            eventName === "mlh_spellrelease_event" || eventName === "mlh_equipped_event";

        const isSpellCastAnimForRightHand = eventName === "mrh_spellaimedconcentrationstart" || eventName === "mrh_spellaimedstart" || eventName === "mrh_spellready_event" ||
            eventName === "mrh_spellrelease_event" || eventName === "mrh_equipped_event";

        return isSpellCastAnimForLeftHand || isSpellCastAnimForRightHand;
    };

    private isAnyMagicStuffEquiped(): boolean {
        const ac = Game.getPlayer();

        if (!ac) {
            return false;
        }

        if (ac.getEquippedSpell(SpellType.Left) || ac.getEquippedSpell(SpellType.Right)) {
            return true;
        }

        if (ac.getEquippedSpell(SpellType.Voise) || ac.getEquippedSpell(SpellType.Instant)) {
            return true;
        }

        const leftHandEquipmentType = ac.getEquippedItemType(SlotType.Left);
        const rightHandEquipmentType = ac.getEquippedItemType(SlotType.Right);

        if (leftHandEquipmentType === 9 || leftHandEquipmentType === EquippedItemType.Staff ||
            rightHandEquipmentType === 9 || rightHandEquipmentType === EquippedItemType.Staff) {
            return true;
        }

        return false;
    }

    private playerId = 0x14;
    private sendUpdateAnimationVariablesRateMs = 500;
    private castKeepAliveRateMs = 3000;
    private castStartGraceMs = 250;
    private readonly castStopEchoDelaysMs = [1000, 3500];
    private relayedCasts = new Map<string, RelayedCast>();
    private lastSendUpdateAnimationVariables: number = 0;
}
