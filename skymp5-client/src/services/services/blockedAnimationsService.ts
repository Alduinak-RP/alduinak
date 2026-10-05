import { HitEvent } from "skyrimPlatform";
import { logTrace } from "../../logging";
import { ClientListener, Sp, CombinedController } from "./clientListener";
import { isPlayerSeated } from "./furnitureSeatService";

// A stagger drops the player out of furniture inside the seat collision and havok launches them upward
const blockedWhileSeatedAnims = ["staggerStart"];

// Skyrim.esm ExitChair idle group (engine picks front/left/right/back) and IdleStoolExit
const seatExitIdleIds = [0x13972, 0x4739b];
const standUpRetryMs = 1500;

export class BlockedAnimationsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();

        this.controller.on("update", () => {
            if (this.standUpRequested) {
                this.standUp();
            }
        });

        this.controller.on("hit", (e) => this.onHit(e));

        // The seated player stands up with the furniture exit instead of being staggered out of the seat
        blockedWhileSeatedAnims.forEach(blockedAnim => {
            this.sp.hooks.sendAnimationEvent.add({
                enter: (ctx) => {
                    if (!isPlayerSeated()) {
                        return;
                    }
                    logTrace(this, `blocking animation event while seated`, ctx.animEventName);
                    ctx.animEventName = "";
                    this.standUpRequested = true;
                },
                leave() { }
            }, 0x14, 0x14, blockedAnim);
        });
    }

    requestStandUp(): void {
        this.standUpRequested = true;
    }

    private onHit(e: HitEvent): void {
        if (!isPlayerSeated() || e.target?.getFormID() !== 0x14) {
            return;
        }
        const aggressor = e.aggressor?.getFormID();
        if (!aggressor || aggressor === 0x14) {
            return;
        }
        const spell = this.sp.Spell.from(e.source);
        if (!this.sp.Weapon.from(e.source) && !spell?.isHostile()) {
            return;
        }
        this.standUpRequested = true;
    }

    private standUp(): void {
        const player = this.sp.Game.getPlayer();
        // Sit state 4 is already getting up; a second exit idle would restart or cancel it
        if (!player || !player.getFurnitureReference() || player.getSitState() === 4) {
            this.standUpRequested = false;
            return;
        }
        const now = Date.now();
        if (now < this.nextStandUpMs) {
            return;
        }
        this.nextStandUpMs = now + standUpRetryMs;
        this.standUpRequested = false;
        for (const id of seatExitIdleIds) {
            if (player.playIdle(this.sp.Idle.from(this.sp.Game.getFormEx(id)))) {
                logTrace(this, `standing up after a hit with idle`, id.toString(16));
                return;
            }
        }
        logTrace(this, `no furniture exit idle accepted, staying seated`);
    }

    private standUpRequested = false;
    private nextStandUpMs = 0;
};
