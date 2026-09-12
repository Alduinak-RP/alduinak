import { logTrace } from "../../logging";
import { ClientListener, Sp, CombinedController } from "./clientListener";

// A stagger drops the player out of furniture inside the seat collision and havok launches them upward
const blockedWhileSeatedAnims = ["staggerStart"];

export class BlockedAnimationsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();

        const blockedAnims: string[] = [];

        const self = this;

        blockedAnims.forEach(blockedAnim => {
            this.sp.hooks.sendAnimationEvent.add({
                enter(ctx) {
                    logTrace(self, `blocking animation event`, ctx.animEventName);
                    ctx.animEventName = "";
                },
                leave() { }
            }, 0x14, 0x14, blockedAnim);
        });

        // Script functions are unavailable inside hooks, so the seated state is sampled per frame
        this.controller.on("update", () => {
            this.isPlayerSeated = !!this.sp.Game.getPlayer()?.getFurnitureReference();
        });

        blockedWhileSeatedAnims.forEach(blockedAnim => {
            this.sp.hooks.sendAnimationEvent.add({
                enter: (ctx) => {
                    if (!this.isPlayerSeated) {
                        return;
                    }
                    logTrace(this, `blocking animation event while seated`, ctx.animEventName);
                    ctx.animEventName = "";
                },
                leave() { }
            }, 0x14, 0x14, blockedAnim);
        });
    }

    private isPlayerSeated = false;
};
