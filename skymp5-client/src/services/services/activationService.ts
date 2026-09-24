import { ActivateEvent, Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getInventory } from "../../sync/inventory";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";

// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { LastInvService } from "./lastInvService";
import { logError, logToPlatformLog, logTrace } from "../../logging";
import { takeSyntheticActivation } from "../../sync/mountApply";

// A press on a door mid-swing is dropped, but a door stuck between states would never take one, so it goes through after this long
const STUCK_PRESS_MS = 1500;

// An ignored press older than this no longer counts toward STUCK_PRESS_MS
const IGNORED_PRESS_TTL_MS = 5000;

// A load door answer arriving later than this does not send the dropped press
const LOAD_DOOR_ANSWER_MS = 3000;

// Runtime refs never carry a teleport, so only plugin doors are asked about
const FIRST_RUNTIME_ID = 0xff000000;

export class ActivationService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("activate", (e) => this.onActivate(e));
        this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    }

    private firstIgnoredMs = new Map<number, number>();

    // The server's answer per plugin door: a press on a load door teleports and never reverses a swing
    private loadDoors = new Map<number, boolean>();
    private pendingLoadDoorPress = new Map<number, { caster: number, at: number }>();

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

        const openState = e.target.getOpenState();

        // TODO: add this to skyrimPlatform.ts
        const enum OpenState {
            None,
            Open,
            Opening,
            Closed,
            Closing,
        }

        if ((openState === OpenState.Opening || openState === OpenState.Closing) && !this.loadDoors.get(target)) {
            if (target < FIRST_RUNTIME_ID && !this.loadDoors.has(target)) {
                this.askLoadDoor(caster, target);
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

    private askLoadDoor(caster: number, target: number) {
        const asked = this.pendingLoadDoorPress.has(target);
        this.pendingLoadDoorPress.set(target, { caster, at: Date.now() });
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
        if (loadDoor && pending && Date.now() - pending.at < LOAD_DOOR_ANSWER_MS) {
            logTrace(this, "Sending the press dropped on load door", target.toString(16));
            this.sendActivation(pending.caster, target);
        }
    }

    private sendActivation(caster: number, target: number) {
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
