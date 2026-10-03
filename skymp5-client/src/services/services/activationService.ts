import { ActivateEvent, Actor, FormType } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getInventory } from "../../sync/inventory";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { notifyNextUpdate, parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { RestraintService } from "./restraintService";

// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { LastInvService } from "./lastInvService";
import { logError, logToPlatformLog, logTrace } from "../../logging";
import { takeSyntheticActivation } from "../../sync/mountApply";
import { ItemService } from "./itemService";

// A press on a door mid-swing is dropped, but a door stuck between states would never take one, so it goes through after this long
const STUCK_PRESS_MS = 1500;

// An ignored press older than this no longer counts toward STUCK_PRESS_MS
const IGNORED_PRESS_TTL_MS = 5000;

// A load door answer arriving later than this does not send the dropped press
const LOAD_DOOR_ANSWER_MS = 3000;

// Runtime refs never carry a teleport, so only plugin doors are asked about
const FIRST_RUNTIME_ID = 0xff000000;

const SEAT_RELEASE_LOG_GAP_MS = 5000;

// Read by a carrier holding a player at a load door, at most this often; CaptureSystem words its own refusal the same
const CARRY_DOOR_NOTICE = "Set them down before going through this door.";
const CARRY_DOOR_NOTICE_MS = 2000;

// The engine activations RemoteServer issues itself to open a server-approved container or furniture, by remote target id
const localActivations = new Map<number, number>();
const LOCAL_ACTIVATION_TTL_MS = 2000;

export const markLocalActivation = (remoteTarget: number): void => {
    localActivations.set(remoteTarget, Date.now());
};

const takeLocalActivation = (remoteTarget: number): boolean => {
    const at = localActivations.get(remoteTarget);
    if (at === undefined) return false;
    localActivations.delete(remoteTarget);
    return Date.now() - at <= LOCAL_ACTIVATION_TTL_MS;
};

// A repeated press on the same furniture within this long may be answered by a seat the player does not show yet
const SEAT_ANSWER_MS = 3000;

// Furniture whose seat RemoteServer is still waiting on, by remote target id; that wait sends the closing activation itself
const seatWaits = new Map<number, number>();
// The wait notes itself every 0.1 s, so one left hanging by a load stops counting after this long
const SEAT_WAIT_FRESH_MS = 3000;

export const noteSeatWait = (remoteTarget: number): void => {
    seatWaits.set(remoteTarget, Date.now());
};

export const endSeatWait = (remoteTarget: number): void => {
    seatWaits.delete(remoteTarget);
};

const isSeatWaiting = (remoteTarget: number): boolean => Date.now() - (seatWaits.get(remoteTarget) ?? 0) < SEAT_WAIT_FRESH_MS;

export class ActivationService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("activate", (e) => this.onActivate(e));
        this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    }

    private firstIgnoredMs = new Map<number, number>();
    private lastSeatReleaseLog = 0;
    private lastFurniturePress = { target: 0, at: 0 };

    // The server's answer per plugin door: a press on a load door teleports and never reverses a swing
    private loadDoors = new Map<number, boolean>();
    // plain: the press also goes out when the door turns out not to teleport
    private pendingLoadDoorPress = new Map<number, { caster: number, at: number, plain: boolean }>();
    private lastCarryDoorNotice = 0;

    private onActivate(e: ActivateEvent) {
        const lastInvService = this.controller.lookupListener(LastInvService);
        lastInvService.lastInv = getInventory(this.sp.Game.getPlayer() as Actor);

        let caster = e.caster ? e.caster.getFormID() : 0;
        let target = e.target ? e.target.getFormID() : 0;

        if (!target || !caster) {
          return;
        }

        // The observer's own seating of a rider clone on its horse is not the rider's activation
        if (takeSyntheticActivation(caster, target)) {
          logTrace(this, "Dropped the synthetic mount activation of", target.toString(16));
          return;
        }

        // Actors never have non-ff ids locally in skymp
        if (caster !== 0x14 && caster < 0xff000000) {
          return;
        }

        target = localIdToRemoteId(target);
        if (!target) {
            logError(this, 'localIdToRemoteId returned 0 (target) in on(\'activate\')');
            return;
        }

        caster = localIdToRemoteId(caster);
        if (!caster) {
            logError(this, 'localIdToRemoteId returned 0 (caster) in on(\'activate\')');
            return;
        }

        if (e.caster.getFormID() === 0x14) {
          if (this.controller.lookupListener(ItemService).onActivatePress(e.target, target)) return;
          this.releaseStaleSeat(e, target);
        }

        const openState = e.target.getOpenState();

        // TODO: add this to skyrimPlatform.ts
        const enum OpenState {
            None,
            Open,
            Opening,
            Closed,
            Closing,
        }

        const swinging = openState === OpenState.Opening || openState === OpenState.Closing;

        if (e.caster.getFormID() === 0x14 && this.heldForCarry(e, caster, target, !swinging)) {
            return;
        }

        if (swinging && !this.loadDoors.get(target)) {
            if (target < FIRST_RUNTIME_ID && !this.loadDoors.has(target)) {
                this.askLoadDoor(caster, target, false);
            }
            const now = Date.now();
            let firstIgnored = this.firstIgnoredMs.get(target);
            if (firstIgnored !== undefined && now - firstIgnored > IGNORED_PRESS_TTL_MS) {
                firstIgnored = undefined;
            }
            if (firstIgnored === undefined) {
                this.firstIgnoredMs.set(target, now);
            }
            if (firstIgnored === undefined || now - firstIgnored < STUCK_PRESS_MS) {
                logTrace(this, "Ignoring activation of door because it's already opening or closing");
                return;
            }
            logToPlatformLog(this, `door ${target.toString(16)} still ${openState === OpenState.Opening ? "opening" : "closing"} ${now - firstIgnored} ms after the first ignored press, sending the activation anyway`);
        }
        this.sendActivation(caster, target);
    }

    // The server keeps the player's seat on a bench until the client's closing activation, which a crash, a kick or a lost sit never sends,
    // and then refuses every later press ("already occupies it"); a press on furniture while the player sits nowhere releases that seat first,
    // a no-op on the server when it holds none, and the closing branch skips the activation hooks
    private releaseStaleSeat(e: ActivateEvent, target: number) {
        // The echo of RemoteServer's own activation follows the server's seat by a frame and must not give it back
        if (takeLocalActivation(target)) {
            return;
        }
        if (e.target.getBaseObject()?.getType() !== FormType.Furniture) {
            return;
        }
        const now = Date.now();
        const repeated = this.lastFurniturePress.target === target && now - this.lastFurniturePress.at < SEAT_ANSWER_MS;
        this.lastFurniturePress = { target, at: now };
        // A seat granted to an earlier press, still in flight or not shown yet, is not stale
        if (repeated || isSeatWaiting(target)) {
            return;
        }
        if (this.sp.Game.getPlayer()?.getFurnitureReference()) {
            return;
        }
        this.controller.emitter.emit("sendMessage", {
            message: {
                t: MsgType.Activate,
                data: { caster: 0x14, target, isSecondActivation: true }
            },
            reliability: "reliable"
        });
        if (now - this.lastSeatReleaseLog >= SEAT_RELEASE_LOG_GAP_MS) {
            this.lastSeatReleaseLog = now;
            logToPlatformLog(this, `released any seat on furniture ${target.toString(16)} before activating it`);
        }
    }

    // A carrier holding a player does not go through a load door: true when the press was refused or waits for the server to say whether the door teleports
    private heldForCarry(e: ActivateEvent, caster: number, target: number, plain: boolean): boolean {
        if (target >= FIRST_RUNTIME_ID || !this.isCarryingPlayer() || e.target.getBaseObject()?.getType() !== FormType.Door) {
            return false;
        }
        const loadDoor = this.loadDoors.get(target);
        if (loadDoor === undefined) {
            this.askLoadDoor(caster, target, plain);
            return true;
        }
        if (loadDoor) {
            this.refuseCarrier(target);
        }
        return loadDoor;
    }

    private isCarryingPlayer(): boolean {
        return this.controller.lookupListener(RestraintService).isCarryingPlayer;
    }

    private refuseCarrier(target: number) {
        const now = Date.now();
        if (now - this.lastCarryDoorNotice < CARRY_DOOR_NOTICE_MS) {
            return;
        }
        this.lastCarryDoorNotice = now;
        notifyNextUpdate(this.controller, this.sp, CARRY_DOOR_NOTICE);
        logToPlatformLog(this, `load door ${target.toString(16)} not used: the player carries someone`);
    }

    private askLoadDoor(caster: number, target: number, plain: boolean) {
        const asked = this.pendingLoadDoorPress.has(target);
        this.pendingLoadDoorPress.set(target, { caster, at: Date.now(), plain });
        if (!asked) {
            sendCustomPacket(this.controller, { customPacketType: "loadDoorQuery", target });
        }
    }

    private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>) {
        const content = parseCustomPacket(event);
        if (content?.["customPacketType"] !== "loadDoorAnswer") return;
        const target = Number(content["target"]) >>> 0;
        const loadDoor = content["loadDoor"] === true;
        this.loadDoors.set(target, loadDoor);
        const pending = this.pendingLoadDoorPress.get(target);
        this.pendingLoadDoorPress.delete(target);
        if (!pending || Date.now() - pending.at >= LOAD_DOOR_ANSWER_MS) return;
        if (loadDoor && this.isCarryingPlayer()) {
            this.refuseCarrier(target);
        } else if (loadDoor || pending.plain) {
            logTrace(this, "Sending the press held on door", target.toString(16));
            this.sendActivation(pending.caster, target);
        }
    }

    sendActivation(caster: number, target: number) {
        this.firstIgnoredMs.delete(target);
        this.pendingLoadDoorPress.delete(target);

        this.controller.emitter.emit("sendMessage", {
            message: {
                t: MsgType.Activate,
                data: { caster, target, isSecondActivation: false }
            },
            reliability: "reliable"
        });

        logTrace(this, `Sent activation for caster=`, caster.toString(16), `and target=`, target.toString(16));
    }
};
