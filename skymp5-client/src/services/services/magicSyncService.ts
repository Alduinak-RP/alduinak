// TODO: refactor this out
import { isHostedByMe, localIdToRemoteId } from "../../view/worldViewMisc";
import { PlayerCharacterDataHolder } from "../../view/playerCharacterDataHolder";

// @ts-expect-error (TODO: Remove in 2.10.0)
import { SpellCastEvent, Actor, printConsole, Game, getAnimationVariablesFromActor, ActorAnimationVariables, SpellType, Spell, Debug } from 'skyrimPlatform'
import { ClientListener, CombinedController, Sp } from './clientListener';
import { MountService } from './mountService';
import { CustomPacketContent, onCustomPacket } from './customPacketUtil';
import { logTrace, logToPlatformLog } from '../../logging';
import { DELIVERY_SELF } from '../../sync/spell';

import { MsgType } from "../../messages";
import { SpellCastMsgData, SpellCastMessage } from "../messages/spellCastMessage";
import { UpdateAnimVariablesMessageMsgData } from "../messages/updateAnimVariablesMessage";

const CASTING_RECENT_MS = 500;
// The player's spell slots, and casting vars while no relayed cast reads them every frame, are read this often
const CASTING_SAMPLE_MS = 100;

// Racial greater powers are disabled on this server (form ids verified against Skyrim.esm on the reference install)
export const BLOCKED_POWER_IDS = new Set([
    0x000E40C3, // PowerNordBattleCry
    0x000E40C8, // PowerHighElfMagickaRegen (Highborn)
    0x000E40CA, // PowerImperialPacify (Voice of the Emperor)
    0x000E40CE, // PowerRedguardStaminaRegen (Adrenaline Rush)
    0x000E40CF, // PowerWoodElfCommandAnimal
    0x000E40D4, // PowerDarkElfFlameCloak (Ancestor's Wrath)
    0x000E40D5, // PowerArgonianHistskin
    0x000AA022, // PowerBretonAbsorbSpell (Dragonskin)
    0x000AA026, // RaceOrcBerserk (Berserker Rage)
]);

// A rationed racial power from the server's racialState: { powers: [{ spellId, name, readyInMs, available }] } (racialSystem.ts)
interface RationedPower {
    name: string;
    // Local clock time the server's relative readyInMs ends at
    readyAt: number;
    // False while the power's effect is not built on the server
    available: boolean;
}

// The server's formatWait wording
const formatWait = (ms: number): string => {
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

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
        onCustomPacket(this.controller, "racialState", (content) => this.onRacialState(content));
        this.controller.emitter.on("connectionDisconnect", () => {
            this.rationedPowers.clear();
            this.streamingAnimVariables = false;
        });

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
        this.samplePlayerCasting();
        this.syncAnimVariables();
    }

    // A charge that never casts has no relayed cast, so the sample covers it
    private samplePlayerCasting() {
        if (Date.now() - this.playerCastingReadAt < CASTING_SAMPLE_MS) {
            return;
        }
        const player = Game.getPlayer();
        if (player) {
            this.readCastingVars(player, this.playerId);
        }
    }

    // True from the first read that saw a hand casting until CASTING_RECENT_MS after the first read that saw it stop
    isCastingRecently(): boolean {
        return Date.now() - this.playerCastingAt < CASTING_RECENT_MS;
    }

    // Spell ids in the left, right, voice and instant slots, a new array only when one changed
    getPlayerSpellSlots(player: Actor): readonly number[] {
        const now = Date.now();
        if (now - this.playerSlotsReadAt >= CASTING_SAMPLE_MS) {
            this.playerSlotsReadAt = now;
            const slots: number[] = [SpellType.Left, SpellType.Right, SpellType.Voise, SpellType.Instant]
                .map((slot: number) => player.getEquippedSpell(slot)?.getFormID() ?? 0);
            if (slots.some((id, i) => id !== this.playerSlots[i])) {
                this.playerSlots = slots;
            }
        }
        return this.playerSlots;
    }

    private readCastingVars(ac: Actor, actorId: number) {
        const left = ac.getAnimationVariableBool("IsCastingLeft");
        const right = ac.getAnimationVariableBool("IsCastingRight");
        const dual = ac.getAnimationVariableBool("IsCastingDual");
        if (actorId === this.playerId) {
            const now = Date.now();
            const casting = left || right || dual;
            if (casting || this.playerCasting) {
                this.playerCastingAt = now;
            }
            this.playerCasting = casting;
            this.playerCastingReadAt = now;
        }
        return { left, right, dual };
    }

    // Observers' clones follow the player's graph only while a drawn hand casts, and the snapshot after it goes reliable
    private syncAnimVariables() {
        const now = Date.now();
        if (now - this.lastSendUpdateAnimationVariables <= this.sendUpdateAnimationVariablesRateMs) {
            return;
        }

        const castingRecently = this.isCastingRecently();
        if (!castingRecently && !this.streamingAnimVariables) {
            return;
        }

        // A rider's snapshot carries riding and locomotion state that would unseat the observers' clone
        if (this.controller.lookupListener(MountService).isMounted) {
            this.streamingAnimVariables = false;
            return;
        }

        const ac = Game.getPlayer();
        if (!ac) {
            return;
        }

        const streaming = castingRecently && ac.isWeaponDrawn();
        if (!streaming && !this.streamingAnimVariables) {
            return;
        }
        this.streamingAnimVariables = streaming;
        this.lastSendUpdateAnimationVariables = now;

        const animVariables = this.getAnimationVariablesFromActorConverted(ac.getFormID());
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.UpdateAnimVariables, data: this.getUpdateAnimVariablesEventData(ac, animVariables) },
            reliability: streaming ? "unreliable" : "reliable"
        });
    }

    // Each racialState lists every rationed power of the character, so it replaces the last one
    private onRacialState(content: CustomPacketContent) {
        if (!Array.isArray(content["powers"])) {
            return;
        }
        const now = Date.now();
        this.rationedPowers.clear();
        const lines = new Array<string>();
        for (const raw of content["powers"] as unknown[]) {
            const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
            const spellId = Number(p["spellId"]) >>> 0;
            if (!spellId) continue;
            const readyInMs = Math.max(0, Number(p["readyInMs"]) || 0);
            const power = { name: typeof p["name"] === "string" ? p["name"] : "", readyAt: now + readyInMs, available: p["available"] !== false };
            this.rationedPowers.set(spellId, power);
            lines.push(`${power.name || "unnamed"} ${spellId.toString(16)} ${!power.available ? "not available yet" : readyInMs > 0 ? `ready in ${formatWait(readyInMs)}` : "ready"}`);
        }
        logToPlatformLog(this, `racialState: ${lines.join(", ") || "no rationed powers"}`);
    }

    // The server's refusal text for a rationed power it would refuse now, "" when the cast may go through
    private powerRefusal(spellId: number, spellName: string): string {
        const power = this.rationedPowers.get(spellId);
        if (!power) return "";
        const name = power.name || spellName;
        if (!power.available) return `${name} is not available yet.`;
        const wait = power.readyAt - Date.now();
        return wait > 0 ? `${name} is ready again in ${formatWait(wait)}.` : "";
    }

    // A cast the server would refuse: dispelled locally with a notification and never relayed
    private refuseLocally(spellId: number, text: string) {
        this.controller.once('update', () => {
            const player = Game.getPlayer();
            const spell = Spell.from(Game.getFormEx(spellId));
            if (player && spell) {
                player.dispelSpell(spell);
            }
            Debug.notification(text);
        });
    }

    private onSpellCast(event: SpellCastEvent) {
        // Blocked racial powers, and rationed ones the server would refuse now: dispel locally, tell the player, do not relay
        if (event.caster && event.caster.getFormID() === this.playerId && event.spell) {
            const spellId = event.spell.getFormID();
            if (BLOCKED_POWER_IDS.has(spellId)) {
                this.refuseLocally(spellId, "Racial powers are disabled on this server.");
                return;
            }
            const refusal = this.powerRefusal(spellId, event.spell.getName());
            if (refusal) {
                logToPlatformLog(this, `power ${spellId.toString(16)} refused before the relay: ${refusal}`);
                this.refuseLocally(spellId, refusal);
                return;
            }
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
        const { left, right, dual } = this.readCastingVars(ac, cast.casterLocalId);
        const spellId = cast.msg.spell;
        const [leftSpell, rightSpell] = cast.casterLocalId === this.playerId
            ? this.getPlayerSpellSlots(ac)
            : [ac.getEquippedSpell(SpellType.Left)?.getFormID(), ac.getEquippedSpell(SpellType.Right)?.getFormID()];
        // The platform reports a spell held in both hands as right-handed, so either hand counts
        const inBothHands = !!spellId && leftSpell === spellId && rightSpell === spellId;
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
            target: localIdToRemoteId(this.getReplayTargetId(e.caster.getFormID(), e.target ? e.target.getFormID() : 0, e.spell), true),
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

    // The platform names the caster as every cast's target, so the player's non-self casts name the crosshair actor
    private getReplayTargetId(casterId: number, targetId: number, spell: Spell | null | undefined): number {
        if (casterId !== this.playerId || targetId !== casterId) {
            return targetId;
        }
        const crosshairId = PlayerCharacterDataHolder.getCrosshairRefId();
        if (!crosshairId || !Actor.from(Game.getFormEx(crosshairId))) {
            return targetId;
        }
        const isSelf = spell?.getNthEffectMagicEffect(0)?.getDeliveryType() === DELIVERY_SELF;
        return isSelf ? targetId : crosshairId;
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

    private playerId = 0x14;
    private sendUpdateAnimationVariablesRateMs = 500;
    private castKeepAliveRateMs = 3000;
    private castStartGraceMs = 250;
    private readonly castStopEchoDelaysMs = [1000, 3500];
    private relayedCasts = new Map<string, RelayedCast>();
    private rationedPowers = new Map<number, RationedPower>();
    private lastSendUpdateAnimationVariables: number = 0;
    private streamingAnimVariables = false;
    private playerCasting = false;
    private playerCastingAt = 0;
    private playerCastingReadAt = 0;
    private playerSlots: number[] = [];
    private playerSlotsReadAt = 0;
}
