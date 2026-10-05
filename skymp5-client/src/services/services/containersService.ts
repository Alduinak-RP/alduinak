import { Actor, ContainerChangedEvent, Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getPcInventory } from "./remoteServer";
import { isMenuShown } from "./menuStateService";
import { Entry, Inventory, getInventory, getDiff, getPlayerInventory, hasExtras, removeSimpleItemsAsManyAsPossible, sumInventories } from "../../sync/inventory";
import { movedNames, noteCopies, splitTag } from "../../sync/durabilityNames";

import { PutItemMessage } from "../messages/putItemMessage";
import { TakeItemMessage } from "../messages/takeItemMessage";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logError, logTrace } from "../../logging";

// Menus in which the player moves items to and from another reference
const SESSION_MENUS: string[] = [Menu.Container, Menu.Barter, Menu.Gift];

// One containerChanged between the player and another reference
interface Move {
    put: boolean;
    other: number;
    baseId: number;
    numItems: number;
}

export class ContainersService extends ClientListener {
    // The pack as this session's moves told the server, from the menu's open to its close
    private lastInv: Inventory | undefined;
    private moves = new Array<Move>();

    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('update', () => this.sendMoves());
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
        controller.on('menuOpen', (e) => { if (SESSION_MENUS.includes(e.name)) this.startSession(); });
        controller.on('menuClose', (e) => { if (SESSION_MENUS.includes(e.name)) this.endSession(); });
        // A load replaces the pack, so neither the queue nor the snapshot describes it any more
        controller.on('loadGame', () => {
            this.moves = [];
            this.lastInv = undefined;
        });
    }

    private startSession(): void {
        // Moves made before the menu opened still count against what came before it
        this.sendMoves();
        try {
            this.lastInv = getInventory(this.sp.Game.getPlayer() as Actor);
        } catch (err) {
            logError(this, "pack not read at the menu's open", err);
        }
        this.noteDurableCopies();
    }

    private endSession(): void {
        if (SESSION_MENUS.some((menu) => isMenuShown(menu))) return;
        // The closing frame's moves are queued before the close
        this.sendMoves();
        this.traceResidual();
        this.lastInv = undefined;
    }

    // A stack still out of step at the close is a move the engine never reported to JS
    private traceResidual(): void {
        if (!this.lastInv) return;
        try {
            const residual = getDiff(this.lastInv, getPlayerInventory(this.sp.Game.getPlayer() as Actor), false).entries;
            if (residual.length > 0) logTrace(this, "container residual", JSON.stringify(residual));
        } catch (err) {
            logError(this, "residual not read", err);
        }
    }

    // What the pack holds copy by copy, so a move can tell the server which condition went
    private noteDurableCopies(): void {
        try {
            noteCopies(this.sp.Game.getPlayer() as Actor);
        } catch (err) {
            logError(this, "durable copies not read", err);
        }
    }

    // Copies of one item differ by condition only in their name tag, which a merged diff entry has lost: one message per tag
    private splitByCondition<T extends PutItemMessage | TakeItemMessage>(msg: T, entry: Entry): T[] {
        let names: string[] | undefined;
        try {
            names = movedNames(this.sp.Game.getPlayer() as Actor, entry, entry.count > 0, getPcInventory());
        } catch (err) {
            logError(this, "moved copies not read", err);
        }
        if (!names) return [msg];
        const msgs: T[] = [];
        const keys: string[] = [];
        names.forEach((name) => {
            // A copy without a tag keeps the name the message had, which is none for the form's own name
            const key = splitTag(name).tag ? name : "";
            const at = keys.indexOf(key);
            if (at >= 0) {
                msgs[at].count++;
                return;
            }
            // The tag is the one hint: the merged entry's own condition may be another copy's
            const part: T = { ...msg, count: 1 };
            if (key) part.name = name;
            delete (part as { condition?: number }).condition;
            keys.push(key);
            msgs.push(part);
        });
        return msgs;
    }

    // The diff covers the moves first, so each move adds only what no diff entry covered
    private addMissedMoves(moves: Move[], diff: Inventory): void {
        const covered = new Map<number, number>();
        diff.entries.forEach((entry) => covered.set(entry.baseId, (covered.get(entry.baseId) ?? 0) + entry.count));
        moves.forEach((move) => {
            if (!move.baseId || !(move.numItems > 0)) return;
            const want = move.put ? move.numItems : -move.numItems;
            let rest = (covered.get(move.baseId) ?? 0) - want;
            if (rest * want < 0) {
                const count = Math.sign(want) * Math.min(Math.abs(rest), move.numItems);
                logTrace(this, "Diff missed", move.baseId.toString(16), "x" + move.numItems, move.put ? "put" : "take");
                diff.entries.push({ baseId: move.baseId, count });
                rest += count;
            }
            covered.set(move.baseId, rest);
        });
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        if (!e.oldContainer || !e.newContainer) return;
        const oldId = e.oldContainer.getFormID();
        const newId = e.newContainer.getFormID();
        if (oldId !== 0x14 && newId !== 0x14) return;
        const put = oldId === 0x14;
        this.moves.push({ put, other: put ? newId : oldId, baseId: e.baseObj ? e.baseObj.getFormID() : 0, numItems: e.numItems });
    }

    // One diff per update covers every move since the last one, a Take All included
    private sendMoves(): void {
        if (!this.moves.length) return;
        const moves = this.moves;
        this.moves = [];

        // Outside a menu the diff runs against the server's snapshot and keeps only the stacks the events named
        const session = !!this.lastInv;
        const pcInv = getPcInventory();
        const base = this.lastInv ?? (pcInv ? JSON.parse(JSON.stringify(pcInv)) as Inventory : undefined);
        if (!base) return;

        // 'ignoreWorn = true' produces excess diff, see https://github.com/skyrim-multiplayer/issue-tracker/issues/43
        const ignoreWorn = false;
        let diff: Inventory = { entries: [] };
        try {
            diff = getDiff(base, getPlayerInventory(this.sp.Game.getPlayer() as Actor), ignoreWorn);
        } catch (err) {
            logError(this, "diff failed", err);
        }
        if (!session && moves.every((move) => move.baseId)) {
            diff.entries = diff.entries.filter((entry) => moves.some((move) => move.baseId === entry.baseId));
        }
        this.addMissedMoves(moves, diff);

        const others = new Map<number, number>();
        moves.forEach((move) => { if (!others.has(move.baseId)) others.set(move.baseId, move.other); });
        const msgs = diff.entries
            .filter((entry) => entry.count !== 0)
            .map((entry) => {
                const entryCopy = JSON.parse(JSON.stringify(entry)) as typeof entry;
                const msg: PutItemMessage | TakeItemMessage = {
                    ...entryCopy,
                    t: entry.count > 0 ? MsgType.PutItem : MsgType.TakeItem,
                    target: localIdToRemoteId(others.get(entry.baseId) ?? moves[0].other)
                };
                msg.count = Math.abs(msg.count);
                if (this.sp.Game.getFormEx(entry.baseId)?.getName() === msg.name) {
                    delete msg.name;
                }
                return this.splitByCondition(msg, entry);
            })
            .reduce((all, part) => all.concat(part), [] as (PutItemMessage | TakeItemMessage)[]);
        this.noteDurableCopies();

        msgs.forEach((msg) => {
            logTrace(this, msg.t === MsgType.PutItem ? "Put" : "Take", msg.baseId.toString(16), "x" + msg.count, "target", msg.target.toString(16));
            this.controller.emitter.emit("sendMessage", {
                message: msg,
                reliability: "reliable"
            });
        });

        if (!session) return;
        // Turn 1,2,3,4,5 changes into 1,1,1,1,1 when moving items one by one
        let inv = base;
        diff.entries.forEach((entry) => {
            if (hasExtras(entry)) {
                inv = getDiff(inv, { entries: [entry] }, ignoreWorn);
            } else if (entry.count > 0) {
                inv = removeSimpleItemsAsManyAsPossible(inv, entry.baseId, entry.count);
            } else if (entry.count < 0) {
                const add = { entries: [entry] };
                add.entries[0].count *= -1;
                inv = sumInventories(inv, add);
            }
        });
        this.lastInv = inv;
    }
}
