import { Actor, ContainerChangedEvent, printConsole } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getPcInventory } from "./remoteServer";
import { Inventory, getInventory, getDiff, hasExtras, removeSimpleItemsAsManyAsPossible, sumInventories } from "../../sync/inventory";
import { LastInvService } from "./lastInvService";

import { PutItemMessage } from "../messages/putItemMessage";
import { TakeItemMessage } from "../messages/takeItemMessage";
import { SweetTaffySweetCantDropService } from "./sweetTaffySweetCantDropService";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logError, logTrace } from "../../logging";

export class ContainersService extends ClientListener {
    // baseId -> signed count the diffs of this tick already cover, so a later event of the same tick does not resend it
    private covered = new Map<number, number>();

    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('update', () => this.covered.clear());
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
    }

    // One tick's diffs already cover its later events, so each event adds only what no diff covered
    private addMissedMove(e: ContainerChangedEvent, diff: Inventory): void {
        diff.entries.forEach((entry) => this.covered.set(entry.baseId, (this.covered.get(entry.baseId) ?? 0) + entry.count));
        const baseId = e.baseObj ? e.baseObj.getFormID() : 0;
        if (!baseId || !(e.numItems > 0)) return;
        const put = e.oldContainer.getFormID() === 0x14;
        const want = put ? e.numItems : -e.numItems;
        let rest = (this.covered.get(baseId) ?? 0) - want;
        if (rest * want < 0) {
            const count = Math.sign(want) * Math.min(Math.abs(rest), e.numItems);
            logTrace(this, "Diff missed", baseId.toString(16), "x" + e.numItems, put ? "put" : "take");
            diff.entries.push({ baseId, count });
            rest += count;
        }
        this.covered.set(baseId, rest);
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const sweetCantDropService = this.controller.lookupListener(SweetTaffySweetCantDropService);

        if (e.oldContainer && e.newContainer) {
            if (
                e.oldContainer.getFormID() === 0x14 ||
                e.newContainer.getFormID() === 0x14
            ) {
                const lastInvService = this.controller.lookupListener(LastInvService);

                if (!lastInvService.lastInv) {
                    lastInvService.lastInv = getPcInventory();
                }
                if (lastInvService.lastInv) {
                    // 'ignoreWorn = true' produces excess diff, see https://github.com/skyrim-multiplayer/issue-tracker/issues/43
                    const ignoreWorn = false;
                    let diff: Inventory = { entries: [] };
                    try {
                        const newInv = getInventory(this.sp.Game.getPlayer() as Actor);
                        diff = getDiff(lastInvService.lastInv, newInv, ignoreWorn);
                    } catch (err) {
                        logError(this, "diff failed", err);
                    }

                    printConsole('diff:');
                    for (let i = 0; i < diff.entries.length; ++i) {
                        printConsole(`[${i}] ${JSON.stringify(diff.entries[i])}`);
                    }
                    this.addMissedMove(e, diff);
                    const msgs = diff.entries
                        .filter((entry) => {
                            // TODO: review this condition, seems to be incorrect
                            const allowed = entry.count > 0 ? sweetCantDropService.canDropOrPutItem(entry.baseId) : true;
                            if (!allowed) {
                                logTrace(this, "Not putting", entry.baseId.toString(16), "x" + entry.count);
                            }
                            return allowed;
                        })
                        .filter((entry) => entry.count !== 0)
                        .map((entry) => {
                            const entryCopy = JSON.parse(JSON.stringify(entry)) as typeof entry;
                            const msg: PutItemMessage | TakeItemMessage = {
                                ...entryCopy,
                                t: entry.count > 0 ? MsgType.PutItem : MsgType.TakeItem,
                                target: e.oldContainer.getFormID() === 0x14
                                    ? localIdToRemoteId(e.newContainer.getFormID())
                                    : localIdToRemoteId(e.oldContainer.getFormID())
                            };
                            msg.count = Math.abs(msg.count);
                            if (this.sp.Game.getFormEx(entry.baseId)?.getName() === msg.name) {
                                delete msg.name;
                            }
                            return msg;
                        });

                    msgs.forEach((msg) => {
                        logTrace(this, msg.t === MsgType.PutItem ? "Put" : "Take", msg.baseId.toString(16), "x" + msg.count, "target", msg.target.toString(16));
                        this.controller.emitter.emit("sendMessage", {
                            message: msg,
                            reliability: "reliable"
                        });
                    });

                    // Turn 1,2,3,4,5 changes into 1,1,1,1,1 when moving items one by one
                    diff.entries.forEach((entry) => {
                        if (lastInvService.lastInv && hasExtras(entry)) {
                            lastInvService.lastInv = getDiff(lastInvService.lastInv, { entries: [entry] }, ignoreWorn);
                        } else if (lastInvService.lastInv) {
                            const put = entry.count > 0;
                            const take = entry.count < 0;
                            if (put) {
                                lastInvService.lastInv = removeSimpleItemsAsManyAsPossible(
                                    lastInvService.lastInv,
                                    entry.baseId,
                                    entry.count,
                                );
                            } else if (take) {
                                const add = { entries: [entry] };
                                add.entries[0].count *= -1;
                                lastInvService.lastInv = sumInventories(lastInvService.lastInv, add);
                            }
                        }
                    });
                }
            }
        }
    }
}
