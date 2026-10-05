import { ClientListener, CombinedController, Sp } from "./clientListener";
import { SinglePlayerService } from "./singlePlayerService";
import { FormModel } from "../../view/model";
import { MsgType } from "../../messages";
import { getMovement } from "../../sync/movementGet";

// TODO: refactor this out
import * as worldViewMisc from "../../view/worldViewMisc";

import { AnimationSource, getCopyAnimationSource, needsReliableSend, playerAnimationSource } from "../../sync/animation";
import { Actor, EquipEvent, FormType, HitEvent, Menu } from "skyrimPlatform";
import { getAppearance } from "../../sync/appearance";
import { ActorValues, getActorValues } from "../../sync/actorvalues";
import { countWorn, getEquipment } from "../../sync/equipment";
import { takeWornTwinRename } from "../../sync/durabilityNames";
import { nextHostAttempt } from "../../view/hostAttempts";
import { SkympClient } from "./skympClient";
import { MessageWithRefrId } from "../events/sendMessageWithRefrIdEvent";
import { UpdateMovementMessage } from "../messages/updateMovementMessage";
import { ChangeValuesMessage } from "../messages/changeValuesMessage";
import { CloneSpellGuardService } from "./cloneSpellGuardService";
import { UpdateAnimationMessage } from "../messages/updateAnimationMessage";
import { UpdateEquipmentMessage } from "../messages/updateEquipmentMessage";
import { UpdateAppearanceMessage } from "../messages/updateAppearanceMessage";
import { RemoteServer, settleSpawnEquipment } from "./remoteServer";
import { DeathService } from "./deathService";
import { RestraintService } from "./restraintService";
import { MountService } from "./mountService";
import { PolymorphService } from "./polymorphService";
import { MagicSyncService } from "./magicSyncService";
import { Movement } from "../../sync/movement";
import { logTrace, logToPlatformLog } from "../../logging";

const playerFormId = 0x14;
const ACTOR_VALUES_READ_MS = 250;
// Changed values go out at most this often unless a landing or death forces a report
const ACTOR_VALUES_SEND_GAP_MS = 2000;

// Menus named in a zero-worn report, the ones that undress or re-dress the player or hide the engine's equips
const REPORT_MENUS = [Menu.Inventory, Menu.Container, Menu.Crafting, Menu.RaceSex, Menu.Loading, Menu.Favorites, Menu.Magic, Menu.Barter, Menu.Gift];
const ZERO_WORN_LOG_GAP_MS = 2000;

// TODO: split this service into EquipmentService, MovementService, AnimationService, ActorValueService, HostAttemptsService
export class SendInputsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("equip", (e) => this.onEquip(e));
        this.controller.on("unequip", (e) => this.onUnequip(e));
        this.controller.on("loadGame", () => this.onLoadGame());
        this.controller.on("hit", (e) => this.onHit(e));
        this.controller.emitter.on("connectionAccepted", () => this.lastSendMovementMoment.clear());
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
        // Slot ids left/right/voice/instant (SpellType enum not exported here)
        const sig = [0, 1, 2, 3]
            .map(t => player.getEquippedSpell(t as never)?.getFormID() ?? 0)
            .join(',');
        if (this.lastSpellSignature === undefined) {
            this.lastSpellSignature = sig;
        } else if (sig !== this.lastSpellSignature) {
            this.lastSpellSignature = sig;
            this.equipmentChanged = true;
        }
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
        this.sendMovement(undefined, playerForm, () => player);
        this.sendAnimation(playerAnimationSource);
        this.sendAppearance(player);
        this.sendEquipment(player);
        this.sendActorValuePercentage(player, playerForm);

        // A hosted actor resolves through the id maps, and natively only when its movement report is due
        const hosted = this.sp.storage['hosted'];
        if (Array.isArray(hosted)) {
            (hosted as number[]).forEach((remoteId) => {
                const localId = worldViewMisc.remoteIdToLocalId(remoteId);
                if (!localId) {
                    return;
                }
                this.sendMovement(remoteId, modelSource.getFormByRefrId(remoteId), () => this.sp.Actor.from(this.sp.Game.getFormEx(localId)));
                this.sendAnimation(getCopyAnimationSource(localId, remoteId));
            });
        }
        this.sendHostAttempts();
    }

    private sendMovement(_refrId: number | undefined, form: FormModel | undefined, getOwner: () => Actor | null) {
        const refrIdStr = `${_refrId}`;
        const sendMovementRateMs = 130;
        const now = Date.now();
        const last = this.lastSendMovementMoment.get(refrIdStr);
        if (!last || now - last > sendMovementRateMs) {
            const owner = getOwner();
            if (!owner) {
                return;
            }
            const movement = getMovement(owner, form);
            const message: MessageWithRefrId<UpdateMovementMessage> = {
                t: MsgType.UpdateMovement,
                data: _refrId ? movement : this.filterOwnMovement(movement),
                _refrId
            };
            this.controller.emitter.emit("sendMessageWithRefrId", {
                message,
                reliability: "unreliable"
            });
            this.lastSendMovementMoment.set(refrIdStr, now);
        }
    }

    // A held pose or a saddle owns the player's locomotion, observers must not replay it on the clone
    private filterOwnMovement(movement: Movement): Movement {
        const restrained = this.controller.lookupListener(RestraintService).filterOwnMovement(movement);
        return this.controller.lookupListener(MountService).filterOwnMovement(restrained);
    }

    // The server applies ChangeValues to the sender's own actor whatever idx says, so hosted NPCs report none
    private sendActorValuePercentage(player: Actor, form?: FormModel) {
        const canSend = form && (form.isDead ?? false) === false;
        if (!canSend) {
          return;
        }

        // A clone's replayed hostile spell must not lower the reported health
        this.controller.lookupListener(CloneSpellGuardService).enforce();

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

    private sendAppearance(player: Actor) {
        const shown = this.sp.Ui.isMenuOpen('RaceSex Menu');
        if (shown != this.isRaceSexMenuShown) {
            this.isRaceSexMenuShown = shown;
            if (!shown) {
                this.sp.printConsole('Exited from race menu');

                const appearance = getAppearance(player);
                // TODO: log appearance contents to debug appearance issues?
                const message: MessageWithRefrId<UpdateAppearanceMessage> = {
                    t: MsgType.UpdateAppearance,
                    data: appearance,
                    _refrId: undefined
                };
                this.controller.emitter.emit("sendMessageWithRefrId", {
                    message,
                    reliability: "reliable"
                });
            }
        }
    }

    private sendEquipment(player: Actor) {
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

    private lastSendMovementMoment = new Map<string, number>();
    private actorValuesNeedUpdate = false;
    private actorValuesReadAt = 0;
    private isRaceSexMenuShown = false;
    private equipmentChanged = false;
    private lastSpellSignature?: string;
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
