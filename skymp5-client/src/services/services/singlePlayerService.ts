import { ClientListener, CombinedController, Sp } from "./clientListener";
import { GameLoadEvent } from "../events/gameLoadEvent";
import { NetworkingService } from "./networkingService";
import { loc } from "../../loc";

export class SinglePlayerService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.emitter.on("gameLoad", (e) => this.onGameLoad(e));
    }

    get isSinglePlayer() {
        return this._isSinglePlayer;
    }

    private onGameLoad(event: GameLoadEvent) {
        if (!event.isCausedBySkyrimPlatform && !this._isSinglePlayer) {
            this.sp.Debug.messageBox(loc("platform.saveLoaded"));
            this.controller.lookupListener(NetworkingService).close();
            this._isSinglePlayer = true;
            this.sp.Game.setInChargen(false, false, false);
        }
    }

    private _isSinglePlayer = false;
}
