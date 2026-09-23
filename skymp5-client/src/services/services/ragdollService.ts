import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { TimersService } from "./timersService";
import { logToPlatformLog } from "../../logging";

export class RagdollService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.once("update", () => this.onceUpdate());
    }

    // TODO: think about tracking ragdoll state of player
    public safeRemoveRagdollFromWorld = (
        actor: Actor,
        afterRemoveCallback: (returned: boolean) => void,
        deadlineMs?: number
    ) => {
        let done = false;
        const finish = (returned: boolean) => {
            if (done) return;
            done = true;
            this.setLocalDamageMult(this.defaultLocalDamageMult);
            afterRemoveCallback(returned);
        };
        this.setLocalDamageMult(0);
        actor.forceRemoveRagdollFromWorld().then(
            () => this.controller.once("update", () => finish(true)),
            (e) => {
                logToPlatformLog(this, `forceRemoveRagdollFromWorld failed: ${e}`);
                this.controller.once("update", () => finish(false));
            },
        );
        if (deadlineMs !== undefined) {
            this.controller.lookupListener(TimersService).setTimeout(() => this.controller.once("update", () => finish(false)), deadlineMs);
        }
    };

    private onceUpdate() {
        this.setLocalDamageMult(this.defaultLocalDamageMult);
    }

    private setLocalDamageMult(damageMult: number) {
        this.sp.Game.setGameSettingFloat("fDiffMultHPToPCE", damageMult);
        this.sp.Game.setGameSettingFloat("fDiffMultHPToPCH", damageMult);
        this.sp.Game.setGameSettingFloat("fDiffMultHPToPCL", damageMult);
        this.sp.Game.setGameSettingFloat("fDiffMultHPToPCN", damageMult);
        this.sp.Game.setGameSettingFloat("fDiffMultHPToPCVE", damageMult);
        this.sp.Game.setGameSettingFloat("fDiffMultHPToPCVH", damageMult);
    }

    private readonly defaultLocalDamageMult = 1;
}
