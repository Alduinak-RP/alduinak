import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ChangeFormNpc } from "skyrimPlatform";
import { logToPlatformLog } from "../../logging";
import { CharacterSelectService } from "./characterSelectService";

export class LoadGameService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("loadGame", () => this.onLoadGame());
    }

    public loadGame(pos: number[], rot: number[], worldOrCell: number, changeFormNpc?: ChangeFormNpc, loadOrder?: string[], time?: { seconds: number, minutes: number, hours: number }): boolean {
        try {
            try {
                // @ts-ignore
                this.sp.loadGame(pos, rot, worldOrCell, changeFormNpc, loadOrder, time);
            } catch (e) {
                // Hotfix non-vanilla headparts bug
                // @ts-ignore
                this.sp.loadGame(pos, rot, worldOrCell, undefined, loadOrder, time);
            }
        } catch (e) {
            logToPlatformLog(this, "spawn load failed:", e);
            this.controller.lookupListener(CharacterSelectService).showLoadFailure(String(e));
            return false;
        }
        this._isCausedBySkyrimPlatform = true;
        return true;
    }

    private onLoadGame() {
        try {
            const gameLoadEvent = {
                isCausedBySkyrimPlatform: this._isCausedBySkyrimPlatform
            };
            this.controller.emitter.emit("gameLoad", gameLoadEvent);
        } catch (e) {
            this.controller.once("tick", () => {
                this._isCausedBySkyrimPlatform = false;
            });
            throw e;
        }
        this.controller.once("tick", () => {
            this._isCausedBySkyrimPlatform = false;
        });
    }

    private _isCausedBySkyrimPlatform = false;
}
