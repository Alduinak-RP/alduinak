import { ActivateEvent, FormType } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { notifyNextUpdate, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { RestraintService } from "./restraintService";

// TODO: refactor this out
import { formProp, isRemoteHostedByMe, localIdToRemoteId } from "../../view/worldViewMisc";

import { logError, logToPlatformLog, logTrace } from "../../logging";
import { takeSyntheticActivation } from "../../sync/mountApply";
import { ItemService } from "./itemService";
import { loc } from "../../loc";

// A press on a door mid-swing is dropped, but a door stuck between states would never take one, so it goes through after this long
const STUCK_PRESS_MS = 1500;

// An ignored press older than this no longer counts toward STUCK_PRESS_MS
const IGNORED_PRESS_TTL_MS = 5000;

const SEAT_RELEASE_LOG_GAP_MS = 5000;

// Read by a carrier holding a player at a load door, at most this often; CaptureSystem words its own refusal the same
const CARRY_DOOR_NOTICE = loc("carry.doorBlocked");
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
const seatWaits = new Set<number>();

export const startSeatWait = (remoteTarget: number): void => {
    seatWaits.add(remoteTarget);
};

export const endSeatWait = (remoteTarget: number): void => {
    seatWaits.delete(remoteTarget);
};

export class ActivationService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("activate", (e) => this.onActivate(e));
        // A load can leave a wait's closing delay hanging
        this.controller.on("loadGame", () => seatWaits.clear());
        onCustomPacket(this.controller, "loadDoorOverrides", (content) => this.onLoadDoorOverrides(content));
    }

    private firstIgnoredMs = new Map<number, number>();
    private lastSeatReleaseLog = 0;
    private lastFurniturePress = { target: 0, at: 0 };

    // The doors the server's doorTeleportOverrides redirect, sent once per connect
    private overrideDoors = new Set<number>();
    private lastCarryDoorNotice = 0;

    private onActivate(e: ActivateEvent) {
        const casterLocalId = e.caster ? e.caster.getFormID() : 0;
        const targetLocalId = e.target ? e.target.getFormID() : 0;

        if (!targetLocalId || !casterLocalId) {
          return;
        }

        // The observer's own seating of a rider clone on its horse is not the rider's activation
        if (takeSyntheticActivation(casterLocalId, targetLocalId)) {
          logTrace(this, "Dropped the synthetic mount activation of", targetLocalId.toString(16));
          return;
        }

        // The server takes only the player's own and its hosted NPCs' activations; actors never have non-ff ids locally in skymp
        const caster = casterLocalId === 0x14 ? 0x14 : casterLocalId >= 0xff000000 ? localIdToRemoteId(casterLocalId) : 0;
        if (caster !== 0x14 && !isRemoteHostedByMe(caster)) {
          return;
        }

        const target = localIdToRemoteId(targetLocalId);
        if (!target) {
            logError(this, 'localIdToRemoteId returned 0 (target) in on(\'activate\')');
            return;
        }

        if (casterLocalId === 0x14) {
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

        if (casterLocalId === 0x14 && this.refusedForCarry(target)) {
            return;
        }

        if (swinging && !this.isLoadDoor(target)) {
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
        if (repeated || seatWaits.has(target)) {
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

    // A carrier holding a player does not go through a load door
    private refusedForCarry(target: number): boolean {
        if (!this.isCarryingPlayer() || !this.isLoadDoor(target)) {
            return false;
        }
        this.refuseCarrier(target);
        return true;
    }

    // A plugin door with an XTEL arrives with ff_loadDoor; a press on a load door teleports and never reverses a swing
    private isLoadDoor(target: number): boolean {
        return this.overrideDoors.has(target) || formProp(target, "ff_loadDoor") === true;
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

    private onLoadDoorOverrides(content: CustomPacketContent) {
        const doors = content["doors"];
        this.overrideDoors = new Set(Array.isArray(doors) ? doors.map((id) => Number(id) >>> 0) : []);
    }

    sendActivation(caster: number, target: number) {
        this.firstIgnoredMs.delete(target);

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
