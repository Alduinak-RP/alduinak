// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { Actor, ContainerChangedEvent, Menu, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { Inventory, getInventory } from "../../sync/inventory";
import { MsgType } from "../../messages";
import { CraftItemMessage } from "../messages/craftItemMessage";
import { logTrace, logError } from "../../logging";

type FurnitureId = number;

// Workbench (0xadb78) and grinder (0x88108) bench keywords
const TEMPER_KEYWORDS = ["ArmorTable", "SharpeningWheel"];

export class CraftService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
        // Each crafting session starts with no leftover removals
        controller.on('menuOpen', (e) => {
            if (e.name === Menu.Crafting) this.furnitureStreak.clear();
        });
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const oldContainerId = e.oldContainer ? e.oldContainer.getFormID() : 0;
        const newContainerId = e.newContainer ? e.newContainer.getFormID() : 0;
        const baseObjId = e.baseObj ? e.baseObj.getFormID() : 0;
        if (oldContainerId !== 0x14 && newContainerId !== 0x14) {
          return;
        }
        // Inventory syncs and key re-adds while seated are not crafts
        if (!this.sp.Ui.isMenuOpen(Menu.Crafting)) {
          return;
        }

        const furnitureRef = (this.sp.Game.getPlayer() as Actor).getFurnitureReference();
        if (!furnitureRef) {
          return;
        }

        const furnitureId = furnitureRef.getFormID();

        if (oldContainerId === 0x14 && newContainerId === 0) {
            let craftInputObjects = this.furnitureStreak.get(furnitureId);
            if (!craftInputObjects) {
                craftInputObjects = { entries: [] };
            }
            craftInputObjects.entries.push({
                baseId: baseObjId,
                count: e.numItems,
            });
            this.furnitureStreak.set(furnitureId, craftInputObjects);
            logTrace(this,
                `Adding baseObjId`, baseObjId.toString(16), `numItems`, e.numItems, `to craft`,
            );
        } else if (oldContainerId === 0 && newContainerId === 0x14) {
            logTrace(this, 'Finishing craft');
            const craftInputObjects = this.furnitureStreak.get(furnitureId);
            if (craftInputObjects && craftInputObjects.entries.length) {
                this.furnitureStreak.delete(furnitureId);
                const workbench = localIdToRemoteId(furnitureId);
                if (!workbench) {
                    logError(this, `localIdToRemoteId returned 0 for furnitureId`, furnitureId);
                    return;
                }

                const resultObjectId = baseObjId;

                if (!this.isTemperBench(furnitureRef)) {
                    this.sendCraft({ workbench, craftInputObjects, resultObjectId });
                    return;
                }
                // The improved entry's extra data is readable once the frame ends
                this.controller.once("update", () => {
                    const temperHealth = this.temperHealthOf(resultObjectId);
                    if (temperHealth === undefined) {
                        logError(this, `No tempered entry found for`, resultObjectId.toString(16));
                        return;
                    }
                    this.sendCraft({ workbench, craftInputObjects, resultObjectId, temperHealth });
                });
            }
        }
    }

    private sendCraft(data: CraftItemMessage["data"]) {
        logTrace(this, `Sending craft`, JSON.stringify(data));
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.CraftItem, data },
            reliability: "reliable"
        });
    }

    private isTemperBench(furnitureRef: ObjectReference): boolean {
        const base = furnitureRef.getBaseObject();
        return !!base && TEMPER_KEYWORDS.some((name) => {
            const keyword = this.sp.Keyword.getKeyword(name);
            return !!keyword && base.hasKeyword(keyword);
        });
    }

    // Highest tempered entry of that base, the one just improved
    private temperHealthOf(baseId: number): number | undefined {
        let best: number | undefined;
        for (const entry of getInventory(this.sp.Game.getPlayer() as Actor).entries) {
            if (entry.baseId !== baseId || !entry.health || entry.health <= 1) continue;
            if (best === undefined || entry.health > best) best = entry.health;
        }
        return best;
    }

    private furnitureStreak = new Map<FurnitureId, Inventory>();
}
