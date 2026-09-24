import { ActivateEvent, Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getInventory } from "../../sync/inventory";

// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { LastInvService } from "./lastInvService";
import { logError, logToPlatformLog, logTrace } from "../../logging";
import { takeSyntheticActivation } from "../../sync/mountApply";

// A press on a door mid-swing is dropped, but a door stuck between states would never take one, so it goes through after this long
const STUCK_PRESS_MS = 1500;

export class ActivationService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("activate", (e) => this.onActivate(e));
    }

    private firstIgnoredMs = new Map<number, number>();

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

        if (openState === OpenState.Opening || openState === OpenState.Closing) {
            const now = Date.now();
            const firstIgnored = this.firstIgnoredMs.get(target);
            if (firstIgnored === undefined) {
                this.firstIgnoredMs.set(target, now);
            }
            if (firstIgnored === undefined || now - firstIgnored < STUCK_PRESS_MS) {
                logTrace(this, "Ignoring activation of door because it's already opening or closing");
                return;
            }
            logToPlatformLog(this, `door ${target.toString(16)} still ${openState === OpenState.Opening ? "opening" : "closing"} ${now - firstIgnored} ms after the first ignored press, sending the activation anyway`);
        }
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
