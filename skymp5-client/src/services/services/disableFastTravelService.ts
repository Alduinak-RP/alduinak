import { Menu } from "skyrimPlatform";
import { ClientListener, Sp, CombinedController } from "./clientListener";

// Fast travel starts only from the map, so it is switched off on a load and whenever the map opens
export class DisableFastTravelService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.once("update", () => this.disable());
        this.controller.on("loadGame", () => this.disable());
        this.controller.on("menuOpen", (e) => {
            if (e.name === Menu.Map) this.disable();
        });
    }

    private disable() {
        this.sp.Game.enableFastTravel(false);
    }
}
