import { requiredVersion } from "../../version";
import { logToPlatformLog } from "../../logging";
import { ClientListener, Sp, CombinedController } from "./clientListener";
import { loc } from "../../loc";

export class SpVersionCheckService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.once("update", () => this.onceUpdate());
    }

    private onceUpdate() {
        const realVersion = this.sp.getPlatformVersion();

        if (!requiredVersion.includes(realVersion)) {
            logToPlatformLog(this, `SkyrimPlatform ${realVersion} is not ${requiredVersion}, quitting to the main menu`);
            this.sp.Debug.messageBox(loc("platform.versionMismatch", { required: JSON.stringify(requiredVersion), current: realVersion }));
            this.sp.Utility.waitMenuMode(0.5).then(() => {
                this.controller.on('update', () => {
                    if (!this.sp.Ui.isMenuOpen('MessageBoxMenu')) {
                        this.sp.Game.quitToMainMenu();
                    }
                });
            });
        }
    }
}
