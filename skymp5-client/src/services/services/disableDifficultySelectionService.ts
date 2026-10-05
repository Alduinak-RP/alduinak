import { Menu } from "skyrimPlatform";
import { ClientListener, Sp, CombinedController } from "./clientListener";

// Set on a load and when the Journal, whose settings page can change it, closes
export class DisableDifficultySelectionService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.once("update", () => this.apply());
        this.controller.on("loadGame", () => this.apply());
        this.controller.on("menuClose", (e) => {
            if (e.name === Menu.Journal) this.apply();
        });
    }

    private apply() {
        this.sp.Utility.setINIInt("iDifficulty:GamePlay", this.difficulty);
    }

    private readonly difficulty = 5;
}
