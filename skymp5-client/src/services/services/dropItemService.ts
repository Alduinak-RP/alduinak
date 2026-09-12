import { Actor, ContainerChangedEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";

import { MsgType } from "../../messages";
import { SweetTaffySweetCantDropService } from "./sweetTaffySweetCantDropService";
import { WorldCleanerService } from "./worldCleanerService";
import { logTrace } from "../../logging";
import { notifyNextUpdate } from "./customPacketUtil";
import { PROPERTY_KEY_BASE_ID, getDiff, getInventory, hasItemExtras } from "../../sync/inventory";
import { getPcInventory } from "./remoteServer";

export class DropItemService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const sweetCantDropService = this.controller.lookupListener(SweetTaffySweetCantDropService);

        const pl = this.sp.Game.getPlayer() as Actor;
        const isPlayer: boolean =
            pl && e.oldContainer && pl.getFormID() === e.oldContainer.getFormID();
        const noContainer: boolean =
            e.newContainer === null || e.newContainer === undefined;
        const isReference: boolean = e.reference !== null;
        if (e.newContainer && e.newContainer.getFormID() === pl.getFormID())
            return;
        if (!this.sp.Ui.isMenuOpen("InventoryMenu"))
            return;
        if (
            isPlayer &&
            isReference &&
            noContainer &&
            sweetCantDropService.canDropOrPutItem(e.baseObj.getFormID())
        ) {
            const radius: number = 2000;
            const baseId = e.baseObj.getFormID();

            const player = this.sp.Game.getPlayer() as Actor;

            let set = new Set<number>();
            for (let i = 0; i < 200; i++) {
                const refrId = this.sp.Game.findRandomReferenceOfType(
                    this.sp.Game.getFormEx(baseId),
                    player.getPositionX(),
                    player.getPositionY(),
                    player.getPositionZ(),
                    radius
                )?.getFormID();
                if (refrId) {
                    set.add(refrId);
                } else {
                    break;
                }
            }

            let numFound = 0;

            const worldCleanerService = this.controller.lookupListener(WorldCleanerService);

            set.forEach((refrId) => {
                const ref = this.sp.ObjectReference.from(this.sp.Game.getFormEx(refrId));
                if (ref !== null && ref.isDeleted() === false) {
                    const refrId = ref.getFormID();

                    if (worldCleanerService.getWcProtection(refrId) === 0) {
                        ref.delete();
                        ++numFound;
                        logTrace(this, "Found and deleted reference " + refrId.toString(16));
                    } else {
                        logTrace(this, "Found reference " + refrId.toString(16) + " but it's protected");
                    }
                }
            });

            if (!numFound) {
                return logTrace(this, "Ignoring item drop as false positive");
            }

            // The server keeps a dropped property key in the pack; keys move by trade or chest
            if ((baseId >>> 0) === PROPERTY_KEY_BASE_ID) {
                notifyNextUpdate(this.controller, this.sp, "Keys cannot be dropped. Trade them or leave them in a chest.");
                return;
            }

            const t = MsgType.DropItem;
            const count = e.numItems;
            this.controller.emitter.emit("sendMessage", {
                message: {
                    ...this.droppedExtras(baseId), t, baseId, count,
                },
                reliability: "reliable"
            });
        }
    }

    // The copy the server still holds but the player no longer has is the one on the ground
    private droppedExtras(baseId: number): Record<string, unknown> {
        const pcInv = getPcInventory();
        if (!pcInv) {
            return {};
        }
        const dropped = getDiff(pcInv, getInventory(this.sp.Game.getPlayer() as Actor), true, "exact").entries
            .find((x) => x.baseId === baseId && x.count > 0 && hasItemExtras(x));
        if (!dropped) {
            return {};
        }
        const extras: Record<string, unknown> = { ...dropped };
        delete extras.baseId;
        delete extras.count;
        delete extras.worn;
        delete extras.wornLeft;
        return extras;
    }
}
