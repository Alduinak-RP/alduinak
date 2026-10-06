import { ClientListener, CombinedController, Sp } from "./clientListener";
import { SinglePlayerService } from "./singlePlayerService";
import { FormModel } from "../../view/model";
import { MsgType } from "../../messages";
import { getMovement, MovementProbe, probeChanged, probeFlagsDiffer, probeMovement } from "../../sync/movementGet";

// TODO: refactor this out
import * as worldViewMisc from "../../view/worldViewMisc";

import { AnimationSource, getCopyAnimationSource, needsReliableSend, playerAnimationSource } from "../../sync/animation";
import { Actor, EquipEvent, FormType, HitEvent, Menu, MenuCloseEvent } from "skyrimPlatform";
import { getAppearance } from "../../sync/appearance";
import { ActorValues, getActorValues } from "../../sync/actorvalues";
import { countWorn, getEquipment } from "../../sync/equipment";
import { takeWornTwinRename } from "../../sync/durabilityNames";
import { nextHostAttempt } from "../../view/hostAttempts";
import { SkympClient } from "./skympClient";
import { MessageWithRefrId } from "../events/sendMessageWithRefrIdEvent";
import { UpdateMovementMessage } from "../messages/updateMovementMessage";
import { ChangeValuesMessage } from "../messages/changeValuesMessage";
import { RemoteDamageGuardService } from "./remoteDamageGuardService";
import { UpdateAnimationMessage } from "../messages/updateAnimationMessage";
import { UpdateEquipmentMessage } from "../messages/updateEquipmentMessage";
import { UpdateAppearanceMessage } from "../messages/updateAppearanceMessage";
import { RemoteServer, setFormMovement, settleSpawnEquipment } from "./remoteServer";
import { DeathService } from "./deathService";
import { RestraintService } from "./restraintService";
import { MountService } from "./mountService";
import { PolymorphService } from "./polymorphService";
import { MagicSyncService } from "./magicSyncService";
import { Movement, RunMode } from "../../sync/movement";
import { logTrace, logToPlatformLog } from "../../logging";

const playerFormId = 0x14;
const MOVEMENT_PROBE_MS = 130;
const DISABLED_COPIES_LOGGED_LIMIT = 256;
// An unchanged actor is still reported this often (D10)
const MOVEMENT_KEEPALIVE_MS = 1000;
const ACTOR_VALUES_READ_MS = 250;
// Changed values go out at most this often unless a landing or death forces a report
const ACTOR_VALUES_SEND_GAP_MS = 2000;

// Menus named in a zero-worn report, the ones that undress or re-dress the player or hide the engine's equips
const REPORT_MENUS = [Menu.Inventory, Menu.Container, Menu.Crafting, Menu.RaceSex, Menu.Loading, Menu.Favorites, Menu.Magic, Menu.Barter, Menu.Gift];
const ZERO_WORN_LOG_GAP_MS = 2000;

// One owned actor's movement reports; the player is remote id 0
interface MovementSendState {
    probedAt: number;
    sentAt: number;
    // The probe, engine run mode and animation event count behind the last report
    sent?: MovementProbe;
    sentRunMode?: RunMode;
    sentEvents: number;
    // A stop or a flag change is reported once more, since a lost unreliable report would stand until the keepalive
    followUp: boolean;
}

// TODO: split this service into EquipmentService, MovementService, AnimationService, ActorValueService, HostAttemptsService
export class SendInputsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("equip", (e) => this.onEquip(e));
        this.controller.on("unequip", (e) => this.onUnequip(e));
        this.controller.on("loadGame", () => this.onLoadGame());
        this.controller.on("menuClose", (e) => this.onMenuClose(e));
        this.controller.on("hit", (e) => this.onHit(e));
        this.controller.emitter.on("connectionAccepted", () => this.movementSends.clear());
        // A new spawn or host reports at once
        this.controller.emitter.on("ownerModelReset", () => this.movementSends.delete(0));
        this.controller.emitter.on("hostStartMessage", (e) => this.movementSends.delete(e.message.target));
        this.controller.emitter.on("hostStopMessage", (e) => this.movementSends.delete(e.message.target));
    }

    private onUpdate() {
        if (this.singlePlayerService.isSinglePlayer) {
            return;
        }
        const player = this.sp.Game.getPlayer();
        if (player) {
            this.sendInputs(player);
            this.checkSpellEquipmentChanged(player);
        }
    }

    private onHit(event: HitEvent) {
        if (event.target?.getFormID() === playerFormId) {
            this.actorValuesReadAt = 0;
        }
    }

    // Spell-to-hand changes fire no TESEquipEvent, so poll them; otherwise clones keep the last weapon/spell loadout (desync S1/S3)
    private checkSpellEquipmentChanged(player: Actor) {
        const slots = this.controller.lookupListener(MagicSyncService).getPlayerSpellSlots(player);
        if (this.lastSpellSlots !== undefined && slots !== this.lastSpellSlots) {
            this.equipmentChanged = true;
        }
        this.lastSpellSlots = slots;
    }

    private onEquip(event: EquipEvent) {
        if (!event.actor || !event.baseObj) {
            return;
        }

        if (event.actor.getFormID() !== playerFormId) {
            return;
        }

        const type = event.baseObj.getType();
        if (type !== FormType.Book && type !== FormType.Potion && type !== FormType.Ingredient) {
            // Trigger UpdateEquipment only for equips that are not spell tomes, potions, ingredients
            this.equipmentChanged = true;
            this.lastEquip = { baseId: event.baseObj.getFormID(), at: Date.now() };
        }

        // Send OnEquip for all equips, else the server won't trigger spell learn, potion drink, eating, Papyrus
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.OnEquip, baseId: event.baseObj.getFormID() },
            reliability: "reliable"
        });
    }

    private onUnequip(event: EquipEvent) {
        if (!event.actor || !event.baseObj) {
            return;
        }

        if (event.actor.getFormID() === playerFormId) {
            this.equipmentChanged = true;
            this.lastUnequip = { baseId: event.baseObj.getFormID(), at: Date.now() };
        }
    }

    // A report that reads naked is what undresses the player for everyone once the server accepts it; the line names what was going on
    private logZeroWornReport(player: Actor, numChanges: number, entries: number) {
        const now = Date.now();
        if (now - this.lastZeroWornLog < ZERO_WORN_LOG_GAP_MS) return;
        this.lastZeroWornLog = now;
        const menus = REPORT_MENUS.filter((menu) => this.sp.Ui.isMenuOpen(menu)).join(",") || "none";
        const last = (e?: { baseId: number; at: number }) => e ? `${e.baseId.toString(16)} ${now - e.at} ms ago` : "none";
        logToPlatformLog(this, `zero-worn equipment report #${numChanges}: ${entries} entries, menus ${menus}, last equip ${last(this.lastEquip)}, last unequip ${last(this.lastUnequip)}, furniture ${player.getFurnitureReference()?.getFormID().toString(16) ?? "none"}, dead ${player.isDead()}, 3D ${player.is3DLoaded()}`);
    }

    private onLoadGame() {
        // Only armor is equipped after relogging (see remoteServer.ts); this hack re-sends equipment to the server
        this.sp.Utility.wait(3).then(() => (this.equipmentChanged = true));
    }

    private sendInputs(player: Actor) {
        const modelSource = this.controller.lookupListener(RemoteServer);
        const world = modelSource.getWorldModel();
        const playerForm = world.forms[world.playerCharacterFormIdx];
        this.sendMovement(0, playerForm, () => player, playerAnimationSource);
        this.sendAnimation(playerAnimationSource);
        this.sendEquipment(player, playerForm);
        this.sendActorValuePercentage(player, playerForm);

        // A hosted actor resolves through the id maps, and natively only when its movement probe is due
        const hosted = this.sp.storage['hosted'];
        if (Array.isArray(hosted)) {
            (hosted as number[]).forEach((remoteId) => {
                const localId = worldViewMisc.remoteIdToLocalId(remoteId);
                if (!localId) {
                    return;
                }
                const source = getCopyAnimationSource(localId, remoteId);
                this.sendMovement(remoteId, modelSource.getFormByRefrId(remoteId), () => this.sp.Actor.from(this.sp.Game.getFormEx(localId)), source);
                this.sendAnimation(source);
            });
        }
        this.sendHostAttempts();
    }

    // A cheap probe every 130 ms; the full report is built only when the probe finds it due
    private sendMovement(remoteId: number, form: FormModel | undefined, getOwner: () => Actor | null, source: AnimationSource) {
        const idx = form?.idx;
        if (!form || idx === undefined) {
            return;
        }
        const now = Date.now();
        let state = this.movementSends.get(remoteId);
        if (state && now - state.probedAt <= MOVEMENT_PROBE_MS) {
            return;
        }
        const owner = getOwner();
        if (!owner) {
            return;
        }
        // A hosted copy just placed stands disabled at the player until its spawn moves it, so a report now would put the NPC at the player for everyone
        if (remoteId && owner.isDisabled()) {
            this.logDisabledCopy(remoteId, owner);
            return;
        }
        if (!state) {
            state = { probedAt: 0, sentAt: 0, sentEvents: 0, followUp: false };
            this.movementSends.set(remoteId, state);
        }
        state.probedAt = now;

        const probe = probeMovement(owner, form);
        const events = source.getNumEvents();
        const sent = state.sent;
        if (
            sent && !state.followUp && state.sentRunMode === "Standing" && events === state.sentEvents &&
            now - state.sentAt < MOVEMENT_KEEPALIVE_MS && !probeChanged(probe, sent)
        ) {
            return;
        }

        const movement = getMovement(owner, probe);
        state.followUp = !!sent && ((movement.runMode === "Standing" && state.sentRunMode !== "Standing") || probeFlagsDiffer(probe, sent));
        state.sent = probe;
        state.sentRunMode = movement.runMode;
        state.sentEvents = events;
        state.sentAt = now;

        const message: UpdateMovementMessage = {
            t: MsgType.UpdateMovement,
            idx,
            data: remoteId ? movement : this.filterOwnMovement(movement)
        };
        this.controller.emitter.emit("sendMessage", {
            message,
            reliability: "unreliable"
        });
        // The own model holds each report itself, so the relay need not echo it to the sender
        setFormMovement(form, message.data);
    }

    // Once per copy, the evidence that a hosted NPC's report was skipped while its spawn had not moved it yet; the health is what that report would have carried
    private logDisabledCopy(remoteId: number, copy: Actor) {
        const localId = copy.getFormID();
        if (this.disabledCopiesLogged.has(localId)) {
            return;
        }
        if (this.disabledCopiesLogged.size >= DISABLED_COPIES_LOGGED_LIMIT) {
            this.disabledCopiesLogged.clear();
        }
        this.disabledCopiesLogged.add(localId);
        logToPlatformLog(this, `hosted ${remoteId.toString(16)} copy ${localId.toString(16)} is still disabled at the player, its report waits for the spawn; health ${Math.round(copy.getActorValuePercentage("health") * 100)}%, 3D ${copy.is3DLoaded()}`);
    }

    // A held pose or a saddle owns the player's locomotion, observers must not replay it on the clone
    private filterOwnMovement(movement: Movement): Movement {
        const restrained = this.controller.lookupListener(RestraintService).filterOwnMovement(movement);
        return this.controller.lookupListener(MountService).filterOwnMovement(restrained);
    }

    // The server applies ChangeValues to the sender's own actor whatever idx says, so hosted NPCs report none
    private sendActorValuePercentage(player: Actor, form?: FormModel) {
        // A clone's replayed hostile spell must not lower the reported health
        this.controller.lookupListener(RemoteDamageGuardService).enforce();

        const canSend = form && (form.isDead ?? false) === false;
        if (!canSend) {
          return;
        }

        const currentTime = Date.now();
        // Nothing goes out inside the send gap, so the read waits for it
        if (
            currentTime < this.actorValuesReadAt ||
            (this.actorValuesNeedUpdate === false && currentTime - this.prevActorValuesUpdateTime < ACTOR_VALUES_SEND_GAP_MS)
        ) {
            return;
        }
        this.actorValuesReadAt = currentTime + ACTOR_VALUES_READ_MS;

        const av = getActorValues(player);
        if (
            this.actorValuesNeedUpdate === false &&
            this.prevValues.health === av.health &&
            this.prevValues.stamina === av.stamina &&
            this.prevValues.magicka === av.magicka
        ) {
            return;
        }

        // Delaying actor values update due to casting
        // TODO: partial updates once the server supports it (keep health/stamina during casting, delay magicka)
        if (
            this.controller.lookupListener(MagicSyncService).isCastingRecently() &&
            av.health > 0 // don't delay death actor value update
        ) {
            return;
        }

        const deathService = this.controller.lookupListener(DeathService);
        if (deathService.isBusy()) {
            logTrace(this, "Not sending actor values, death service is busy");
            return;
        }

        const message: MessageWithRefrId<ChangeValuesMessage> = {
            t: MsgType.ChangeValues,
            data: av,
            _refrId: undefined
        };
        // A lost report is never repeated while the values stay put
        this.controller.emitter.emit("sendMessageWithRefrId", {
            message,
            reliability: "reliable"
        });
        this.actorValuesNeedUpdate = false;
        this.prevValues = av;
        this.prevActorValuesUpdateTime = currentTime;

    }

    private sendAnimation(source: AnimationSource) {
        const anim = source.getAnimation();

        if (
            !source.lastSent ||
            anim.numChanges !== source.lastSent.numChanges
        ) {
            // Drink potion anim from this mod https://www.nexusmods.com/skyrimspecialedition/mods/97660
            if (anim.animEventName !== '' && !anim.animEventName.startsWith("DrinkPotion_")) {
                source.lastSent = anim;
                if (source === playerAnimationSource) {
                    this.updateActorValuesAfterAnimation(anim.animEventName);
                }
                const message: MessageWithRefrId<UpdateAnimationMessage> = {
                    t: MsgType.UpdateAnimation,
                    data: anim,
                    _refrId: source.remoteId || undefined
                };
                this.controller.emitter.emit("sendMessageWithRefrId", {
                    message,
                    reliability: needsReliableSend(anim.animEventName) ? "reliable" : "unreliable"
                });
            }
        }
    }

    // As the engine wore them for the last equipment report, before the creature-form strip
    getReportedWornBases(): number[] {
        return this.reportedWornBases;
    }

    relayPlayerAnimEvent(animEventName: string): void {
        playerAnimationSource.relay(animEventName);
    }

    private onMenuClose(event: MenuCloseEvent) {
        if (event.name !== Menu.RaceSex || this.singlePlayerService.isSinglePlayer) {
            return;
        }
        const player = this.sp.Game.getPlayer();
        if (!player) {
            return;
        }
        this.sp.printConsole('Exited from race menu');

        const message: MessageWithRefrId<UpdateAppearanceMessage> = {
            t: MsgType.UpdateAppearance,
            data: getAppearance(player),
            _refrId: undefined
        };
        this.controller.emitter.emit("sendMessageWithRefrId", {
            message,
            reliability: "reliable"
        });
    }

    private sendEquipment(player: Actor, form?: FormModel) {
        // A report waits out the spawn outfit apply, and one follows it even when no equip event fires
        if (settleSpawnEquipment(player)) {
            this.equipmentChanged = true;
            this.spawnReportsToLog = 5;
            return;
        }
        if (takeWornTwinRename()) {
            this.equipmentChanged = true;
        }
        // Coalesce bursts: rapid re-equips flood the server with reliable updates whose forced-revert snippets can freeze the client (S2)
        if (this.equipmentChanged && Date.now() - this.lastEquipmentSentMs >= 300) {
            this.lastEquipmentSentMs = Date.now();
            this.equipmentChanged = false;

            ++this.numEquipmentChanges;

            const eq = getEquipment(
                player,
                this.numEquipmentChanges,
            );
            this.reportedWornBases = eq.inv.entries.filter((e) => e.worn).map((e) => e.baseId);
            // A creature form reports no worn gear, so no weapon reaches the other players' copies of its skeleton
            if (this.controller.lookupListener(PolymorphService).creatureForm) {
                const worn = countWorn(eq.inv);
                eq.inv = { entries: eq.inv.entries.filter((e) => !e.worn && !e.wornLeft) };
                if (worn) logToPlatformLog(this, `equipment report #${eq.numChanges} in a creature form: ${worn} worn item(s) left out`);
            } else if (this.spawnReportsToLog > 0) {
                this.spawnReportsToLog--;
                logToPlatformLog(this, `equipment report #${eq.numChanges} after spawn: worn ${countWorn(eq.inv)} of ${eq.inv.entries.length}`);
            } else if (countWorn(eq.inv) === 0) {
                this.logZeroWornReport(player, eq.numChanges, eq.inv.entries.length);
            }
            const message: MessageWithRefrId<UpdateEquipmentMessage> = {
                t: MsgType.UpdateEquipment,
                data: eq,
                _refrId: undefined
            };

            this.controller.emitter.emit("sendMessageWithRefrId", {
                message,
                reliability: "reliable"
            });
            if (form) {
                form.equipment = eq;
            }
        }
    }

    private sendHostAttempts() {
        const remoteId = nextHostAttempt();
        if (!remoteId) {
          return;
        }

        this.controller.emitter.emit("sendMessage", {
            message: {
                t: MsgType.Host,
                remoteId
            },
            reliability: "unreliable"
        });
    }

    private updateActorValuesAfterAnimation(animName: string) {
        if (
            animName === 'JumpLand' ||
            animName === 'JumpLandDirectional' ||
            animName === 'DeathAnim'
        ) {
            this.actorValuesNeedUpdate = true;
            this.actorValuesReadAt = 0;
        }
    }

    private get singlePlayerService() {
        return this.controller.lookupListener(SinglePlayerService);
    }

    private movementSends = new Map<number, MovementSendState>();
    private disabledCopiesLogged = new Set<number>();
    private actorValuesNeedUpdate = false;
    private actorValuesReadAt = 0;
    private equipmentChanged = false;
    private lastSpellSlots?: readonly number[];
    private lastEquipmentSentMs = 0;
    private numEquipmentChanges = 0;
    private reportedWornBases: number[] = [];
    private spawnReportsToLog = 0;
    private lastEquip?: { baseId: number; at: number };
    private lastUnequip?: { baseId: number; at: number };
    private lastZeroWornLog = 0;
    private prevValues: ActorValues = { health: 0, stamina: 0, magicka: 0 };
    private prevActorValuesUpdateTime = 0;
}
