import { Actor, ContainerChangedEvent, EquipEvent, FormType } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";

import { MsgType } from "../../messages";
import { SweetTaffySweetCantDropService } from "./sweetTaffySweetCantDropService";
import { WorldCleanerService } from "./worldCleanerService";
import { logToPlatformLog, logTrace } from "../../logging";
import { notifyNextUpdate } from "./customPacketUtil";
import { PROPERTY_KEY_BASE_ID, getDiff, getInventory, hasItemExtras, isNamedItemBase } from "../../sync/inventory";
import { droppedName, getDurabilityConfig } from "../../sync/durabilityNames";
import { getPcInventory } from "./remoteServer";

const DROP_SCAN_RADIUS = 2000;
// Eating, drinking or poisoning from the inventory takes the item out with no container or world reference, like a drop, and equips it in the same frame
const CONSUMABLE_TYPES = new Set<number>([FormType.Potion, FormType.Ingredient]);
const CONSUME_WINDOW_MS = 1000;

export class DropItemService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
        controller.on('equip', (e) => this.onEquip(e));
    }

    private onEquip(e: EquipEvent) {
        if (!e.actor || !e.baseObj || e.actor.getFormID() !== 0x14 || !CONSUMABLE_TYPES.has(e.baseObj.getType())) return;
        const baseId = e.baseObj.getFormID();
        const now = Date.now();
        const prev = this.consumed.get(baseId);
        this.consumed.set(baseId, { count: prev && now - prev.at <= CONSUME_WINDOW_MS ? prev.count + 1 : 1, at: now });
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const sweetCantDropService = this.controller.lookupListener(SweetTaffySweetCantDropService);

        const pl = this.sp.Game.getPlayer() as Actor;
        const isPlayer: boolean =
            pl && e.oldContainer && pl.getFormID() === e.oldContainer.getFormID();
        const noContainer: boolean =
            e.newContainer === null || e.newContainer === undefined;
        if (e.newContainer && e.newContainer.getFormID() === pl.getFormID())
            return;
        if (!this.sp.Ui.isMenuOpen("InventoryMenu"))
            return;
        if (!isPlayer || !noContainer || !sweetCantDropService.canDropOrPutItem(e.baseObj.getFormID()))
            return;
        const baseId = e.baseObj.getFormID();
        const count = e.numItems;
        // SkyrimPlatform reports a missing world reference as undefined
        const reference = e.reference ? e.reference.getFormID() : 0;
        if (reference || !CONSUMABLE_TYPES.has(e.baseObj.getType())) {
            this.drop(baseId, count, reference);
            return;
        }
        const name = e.baseObj.getName();
        // The equip of an eaten item may be delivered right after this event
        this.controller.once("update", () => {
            if (!this.wasConsumed(baseId, name)) this.drop(baseId, count, reference);
        });
    }

    private wasConsumed(baseId: number, name: string): boolean {
        const eaten = this.consumed.get(baseId);
        const apart = eaten === undefined ? Infinity : Date.now() - eaten.at;
        if (!eaten || apart > CONSUME_WINDOW_MS) return false;
        if (--eaten.count <= 0) this.consumed.delete(baseId);
        const player = this.sp.Game.getPlayer() as Actor;
        const near = this.sp.Game.findClosestReferenceOfType(this.sp.Game.getFormEx(baseId), player.getPositionX(), player.getPositionY(), player.getPositionZ(), DROP_SCAN_RADIUS);
        const nearText = near ? `the nearest ${name} in the world ${Math.round(player.getDistance(near))} units away was left alone` : `no ${name} in the world within ${DROP_SCAN_RADIUS} units`;
        logToPlatformLog(this, `consumed, not dropped: ${name} ${baseId.toString(16)} left the pack with no world reference ${apart} ms from its equip${eaten.count > 0 ? `, ${eaten.count} more equip(s) of it still to match` : ""}; ${nearText}`);
        return true;
    }

    private drop(baseId: number, count: number, reference: number) {
        const player = this.sp.Game.getPlayer() as Actor;

        let set = new Set<number>();
        for (let i = 0; i < 200; i++) {
            const refrId = this.sp.Game.findRandomReferenceOfType(
                this.sp.Game.getFormEx(baseId),
                player.getPositionX(),
                player.getPositionY(),
                player.getPositionZ(),
                DROP_SCAN_RADIUS
            )?.getFormID();
            if (refrId) {
                set.add(refrId);
            } else {
                break;
            }
        }

        let numFound = 0;
        // Read before the local copy of the dropped reference is deleted
        const worldName = (getDurabilityConfig().enabled && reference && this.sp.ObjectReference.from(this.sp.Game.getFormEx(reference))?.getDisplayName()) || "";

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

        // The server keeps a dropped key or writing in the pack; they move by trade or chest
        if (isNamedItemBase(baseId)) {
            const what = (baseId >>> 0) === PROPERTY_KEY_BASE_ID ? "Keys" : "Writings";
            notifyNextUpdate(this.controller, this.sp, `${what} cannot be dropped. Trade them or leave them in a chest.`);
            return;
        }

        logToPlatformLog(this, `dropped ${baseId.toString(16)} x${count}: world reference ${reference ? reference.toString(16) : "none"}, ${numFound} local copies removed`);
        const t = MsgType.DropItem;
        this.controller.emitter.emit("sendMessage", {
            message: {
                ...this.droppedExtras(baseId), ...this.droppedCondition(baseId, count, worldName), t, baseId, count,
            },
            reliability: "reliable"
        });
    }

    // Copies that differ only by condition are told apart by the tag in the name, which the server reads to drop that copy
    private droppedCondition(baseId: number, count: number, worldName: string): Record<string, unknown> {
        const name = droppedName(this.sp.Game.getPlayer() as Actor, getPcInventory(), baseId, count, worldName);
        return name ? { name, condition: undefined } : {};
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

    // baseId -> equips (eats, drinks, poison applies) not yet matched to a removal, and the last one's time
    private consumed = new Map<number, { count: number; at: number }>();
}
