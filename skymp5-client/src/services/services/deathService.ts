import { Actor, EquipEvent } from "skyrimPlatform";
import { ApplyDeathStateEvent } from "../events/applyDeathStateEvent";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { RespawnNeededError } from "../../lib/errors";
import { AnimationEventName, consumeAllowedAnim } from "../../sync/animation";
import { dismountRiderOf, releaseRiderClone, stopMoving } from "../../sync/mountApply";
import { RagdollService } from "./ragdollService";
import { MountService } from "./mountService";
import { logToPlatformLog } from "../../logging";
import { NiPoint3 } from "../../sync/movement";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";

// The get-up has blended in by then; the 3D rebuild restores a head an execution took
const RESTORE_BODY_S = 1.5;
const IDLE_EXIT_ANIM = "IdleForceDefaultState";
// The ragdoll removal's latent call may never return, so the get-up goes ahead without it
const RESURRECT_RAGDOLL_MS = 2000;
// The ragdoll has come to rest by then, so the second height tells whether the corpse sank
const CORPSE_RECHECK_S = 3;
const CORPSE_LOG_GAP_MS = 1000;
// Spawn.installRespawnHook takes the worn weapons off 3 s after the server's respawn; an unequip this soon after the resurrect is that one
const RESPAWN_UNEQUIP_WINDOW_MS = 10000;
// The get-up and the body rebuild are over by then
const HANDS_SETTLED_MS = 5000;
// Seconds between the put back on and the take off, like a player doing it by hand
const HAND_CYCLE_S = 1;

interface RespawnWeapon {
  baseId: number;
  left: boolean;
}

export class DeathService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    controller.once("update", () => this.onceUpdate());
    controller.emitter.on("applyDeathStateEvent", (e) => this.onApplyDeathState(e));
    controller.on("unequip", (e) => this.onUnequip(e));
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
    this.applyDeathState(e.actor, e.isDead, e.trigger, e.serverPos);
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

  private applyDeathState = (actor: Actor, isDead: boolean, trigger?: string, serverPos?: NiPoint3) => {
    if (actor.isDead() === isDead && this.isPlayer(actor) === false) {
      return;
    }
    if (isDead === true) {
      this.killActor(actor, null, trigger, serverPos);
    } else {
      this.resurrectActor(actor);
    }
  };

  private killActor = (actor: Actor, killer: Actor | null = null, trigger?: string, serverPos?: NiPoint3): void => {
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
      // A ragdoll that starts while a translate still drags the copy and its follow package aims below it is dragged into the ground
      stopMoving(actor);
      this.logCorpse(actor, trigger, serverPos);
      actor.endDeferredKill();
      actor.kill(killer);
    }
  };

  // Where the copy died on this client against the server's position, and where its ragdoll came to rest
  private logCorpse(actor: Actor, trigger: string | undefined, serverPos: NiPoint3 | undefined): void {
    const now = Date.now();
    if (now - this.lastCorpseLog < CORPSE_LOG_GAP_MS) return;
    this.lastCorpseLog = now;
    const formId = actor.getFormID();
    const pos = ObjectReferenceEx.getPos(actor);
    const away = serverPos ? `${Math.round(ObjectReferenceEx.getDistanceNoZ(pos, serverPos))} units from the server pos, dz ${Math.round(pos[2] - serverPos[2])}` : "server pos unknown";
    logToPlatformLog(this, `kill ${formId.toString(16)} (${trigger ?? "unknown"}): 3D ${actor.is3DLoaded()}, z ${Math.round(pos[2])}, ${away}`);
    this.sp.Utility.wait(CORPSE_RECHECK_S).then(() => this.controller.once("update", () => {
      const corpse = Actor.from(this.sp.Game.getFormEx(formId));
      if (!corpse || !corpse.isDead()) return;
      const rest = ObjectReferenceEx.getPos(corpse);
      logToPlatformLog(this, `corpse ${formId.toString(16)} ${CORPSE_RECHECK_S} s later: z ${Math.round(rest[2])} (moved ${Math.round(rest[2] - pos[2])}), ${serverPos ? `dz to server pos ${Math.round(rest[2] - serverPos[2])}` : ""}, 3D ${corpse.is3DLoaded()}`);
    }));
  }

  private resurrectActor = (actor: Actor): void => {
    if (this.isPlayer(actor) === true) {
      this.playerDead = false;
      this.busyForOtherReasonsCounter++;
      this.sp.Utility.wait(7.5).then(() => this.busyForOtherReasonsCounter--);
      this.allowedPlayerAnimations = null;
      actor.setDontMove(false);
      this.noteRespawnWeapons(actor);
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

  private noteRespawnWeapons(actor: Actor): void {
    this.resurrectAt = Date.now();
    this.respawnWeapons = [false, true]
      .map((left) => ({ baseId: actor.getEquippedWeapon(left)?.getFormID() ?? 0, left }))
      .filter((w) => w.baseId !== 0);
    this.handsQueued = false;
  }

  // The server's unequip lands during the get-up and leaves the hands' graph reading a weapon with nothing in hand, so the player
  // could not draw again until they equipped and unequipped it; that cycle is run for them once the get-up is over
  private onUnequip(e: EquipEvent): void {
    if (!e.actor || e.actor.getFormID() !== this.playerActorId || !e.baseObj || this.handsQueued) return;
    const sinceResurrect = Date.now() - this.resurrectAt;
    if (sinceResurrect > RESPAWN_UNEQUIP_WINDOW_MS || !this.respawnWeapons.some((w) => w.baseId === e.baseObj.getFormID())) return;
    this.handsQueued = true;
    this.sp.Utility.wait(Math.max(HAND_CYCLE_S, (HANDS_SETTLED_MS - sinceResurrect) / 1000)).then(() => this.controller.once("update", () => this.cycleHands()));
  }

  private cycleHands(): void {
    const player = this.sp.Game.getPlayer();
    if (!player || player.isDead() || this.playerDead) return;
    const off = this.respawnWeapons.filter((w) => player.getEquippedWeapon(w.left)?.getFormID() !== w.baseId && player.getItemCount(this.sp.Game.getFormEx(w.baseId)) > 0);
    this.logHands(player, `respawn unequip settled, cycling ${off.length}`);
    if (!off.length) return;
    off.forEach((w) => player.equipItemEx(this.sp.Game.getFormEx(w.baseId), w.left ? 2 : 1, false, false));
    this.sp.Utility.wait(HAND_CYCLE_S).then(() => this.controller.once("update", () => {
      const actor = this.sp.Game.getPlayer();
      if (!actor || actor.isDead() || this.playerDead) return;
      off.forEach((w) => actor.unequipItemEx(this.sp.Game.getFormEx(w.baseId), w.left ? 2 : 1, false));
      this.sp.Utility.wait(HAND_CYCLE_S).then(() => this.controller.once("update", () => {
        const after = this.sp.Game.getPlayer();
        if (after) this.logHands(after, "respawn hands cycled");
      }));
    }));
  }

  private logHands(player: Actor, what: string): void {
    const worn = [false, true].map((left) => player.getEquippedWeapon(left)?.getFormID().toString(16) ?? "-").join("/");
    logToPlatformLog(this, `${what}: graph right ${player.getAnimationVariableInt("iRightHandType")} left ${player.getAnimationVariableInt("iLeftHandType")}, drawn ${player.isWeaponDrawn()}, worn ${worn}`);
  }

  private killWithPush = (actor: Actor): void => {
    this.allowedPlayerAnimations?.push(AnimationEventName.Ragdoll);
    actor.pushActorAway(actor, 0);
  };

  private ressurectWithPushKill = (act: Actor): void => {
    const formId = act.getFormID();
    const ragdollService = this.controller.lookupListener(RagdollService);
    ragdollService.safeRemoveRagdollFromWorld(act, (returned) => {
      const actor = Actor.from(this.sp.Game.getFormEx(formId));
      if (!returned) {
        logToPlatformLog(this, `resurrect ${formId.toString(16)}: ragdoll wait failed or timed out, getting up anyway`);
      }
      if (!actor) {
        return;
      }
      // TODO: should use actor variable instead of getPlayer?
      // TODO: use different iGetUpType if ressurecting under water
      this.sp.Game.getPlayer()!.setAnimationVariableInt("iGetUpType", 1);
      this.sp.Debug.sendAnimationEvent(actor, AnimationEventName.GetUpBegin);
      this.sp.Utility.wait(RESTORE_BODY_S).then(() => this.controller.once("update", () => this.rebuildBody(formId)));
    }, RESURRECT_RAGDOLL_MS);
  };

  private isPlayer = (actor: Actor): boolean => {
    return actor.getFormID() === this.playerActorId;
  };

  // Null to allow all animations. Empty array to disallow all
  private allowedPlayerAnimations: string[] | null = null;

  private readonly playerActorId = 0x14;

  private playerDead = false;

  private busyForOtherReasonsCounter = 0;

  private lastCorpseLog = 0;

  private resurrectAt = 0;
  private respawnWeapons: RespawnWeapon[] = [];
  private handsQueued = false;
}
