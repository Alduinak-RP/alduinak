import { Actor } from "skyrimPlatform";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { RespawnNeededError } from "../../lib/errors";
import { AnimationEventName, consumeAllowedAnim } from "../../sync/animation";
import { dismountRiderOf, releaseRiderClone } from "../../sync/mountApply";
import { RagdollService } from "./ragdollService";
import { MountService } from "./mountService";
import { logToPlatformLog } from "../../logging";

// The get-up has blended in by then; the 3D rebuild restores a head an execution took
const RESTORE_BODY_S = 1.5;
const IDLE_EXIT_ANIM = "IdleForceDefaultState";

export class DeathService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    controller.once("update", () => this.onceUpdate());
    controller.emitter.on("applyDeathStateEvent", (e) => this.onApplyDeathState(e));
    this.hookDisableKillMoves();
    this.hookDisableStagger();
    this.hookDisableBlockedAnims();
  }

  public isBusy() {
    return this.playerDead || this.busyForOtherReasonsCounter > 0;
  }

  private onceUpdate() {
    const player = this.sp.Game.getPlayer();
    player?.startDeferredKill();
  }

  private onApplyDeathState(e: ApplyDeathStateEvent) {
    this.applyDeathState(e.actor, e.isDead);
  }

  private hookDisableKillMoves() {
    this.sp.hooks.sendAnimationEvent.add(
      {
        enter(ctx) {
          ctx.animEventName = "";
        },
        leave() { },
      },
      0xff000000,
      0xffffffff,
      "KillMove*"
    );
  }

  // Copies deal no damage, so a stagger their engine starts is phantom; one the sync relayed from the player is kept
  private hookDisableStagger() {
    this.sp.hooks.sendAnimationEvent.add(
      {
        enter(ctx) {
          if (consumeAllowedAnim(ctx.selfId, ctx.animEventName)) return;
          ctx.animEventName = "";
        },
        leave() { },
      },
      0xff000000,
      0xffffffff,
      "staggerStart"
    );
  }

  private hookDisableBlockedAnims() {
    this.sp.hooks.sendAnimationEvent.add(
      {
        enter: (ctx) => {
          if (this.allowedPlayerAnimations === null) {
            return;
          }
          if (!this.allowedPlayerAnimations.includes(ctx.animEventName)) {
            ctx.animEventName = "";
          }
        },
        leave() { },
      },
      this.playerActorId,
      this.playerActorId
    );
  }

  private applyDeathState = (actor: Actor, isDead: boolean) => {
    if (actor.isDead() === isDead && this.isPlayer(actor) === false) {
      return;
    }
    if (isDead === true) {
      this.killActor(actor, null);
    } else {
      this.resurrectActor(actor);
    }
  };

  private killActor = (actor: Actor, killer: Actor | null = null): void => {
    if (this.isPlayer(actor) === true) {
      // The ragdoll starts from the ground, not the saddle
      this.controller.lookupListener(MountService).dismountNow("death");
      this.playerDead = true;
      this.busyForOtherReasonsCounter++;
      this.sp.Utility.wait(7.5).then(() => this.busyForOtherReasonsCounter--);
      this.allowedPlayerAnimations = [];
      actor.setDontMove(true);
      this.killWithPush(actor);
    } else {
      // A seated rider clone leaves the saddle and a ridden horse throws its rider before the kill
      releaseRiderClone(actor.getFormID());
      dismountRiderOf(actor.getFormID());
      actor.endDeferredKill();
      actor.kill(killer);
    }
  };

  private resurrectActor = (actor: Actor): void => {
    if (this.isPlayer(actor) === true) {
      this.playerDead = false;
      this.busyForOtherReasonsCounter++;
      this.sp.Utility.wait(7.5).then(() => this.busyForOtherReasonsCounter--);
      this.allowedPlayerAnimations = null;
      actor.setDontMove(false);
      this.restoreLimbs(actor);
      this.ressurectWithPushKill(actor);
    } else {
      throw new RespawnNeededError("needs to be respawned");
    }
  };

  // A killmove decapitation persists as dismembered-limb extra data that no respawn step clears; a whole body makes this a no-op
  private restoreLimbs(actor: Actor): void {
    let limbReset = "ok";
    try {
      actor.resetHealthAndLimbs();
    } catch (e) {
      limbReset = `err ${e}`;
    }
    logToPlatformLog(this, `restoreBody inKillMove=${actor.isInKillMove()} limbReset=${limbReset}`);
  }

  // DoReset3D rebuilds the head from the base's head parts, as the appearance apply does; a killmove flag the ragdoll cut short is cleared
  private rebuildBody(formId: number): void {
    const actor = Actor.from(this.sp.Game.getFormEx(formId));
    if (!actor || this.playerDead) return;
    actor.queueNiNodeUpdate();
    if (actor.isInKillMove()) this.sp.Debug.sendAnimationEvent(actor, IDLE_EXIT_ANIM);
  }

  private killWithPush = (actor: Actor): void => {
    this.allowedPlayerAnimations?.push(AnimationEventName.Ragdoll);
    actor.pushActorAway(actor, 0);
  };

  private ressurectWithPushKill = (act: Actor): void => {
    const formId = act.getFormID();
    const ragdollService = this.controller.lookupListener(RagdollService);
    ragdollService.safeRemoveRagdollFromWorld(act, () => {
      const actor = Actor.from(this.sp.Game.getFormEx(formId));
      if (!actor) {
        return;
      }
      // TODO: should use actor variable instead of getPlayer?
      // TODO: use different iGetUpType if ressurecting under water
      this.sp.Game.getPlayer()!.setAnimationVariableInt("iGetUpType", 1);
      this.sp.Debug.sendAnimationEvent(actor, AnimationEventName.GetUpBegin);
      this.sp.Utility.wait(RESTORE_BODY_S).then(() => this.controller.once("update", () => this.rebuildBody(formId)));
    });
  };

  private isPlayer = (actor: Actor): boolean => {
    return actor.getFormID() === this.playerActorId;
  };

  // Null to allow all animations. Empty array to disallow all
  private allowedPlayerAnimations: string[] | null = null;

  private readonly playerActorId = 0x14;

  private playerDead = false;

  private busyForOtherReasonsCounter = 0;
}
