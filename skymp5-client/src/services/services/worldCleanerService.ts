import { ClientListener, CombinedController, Sp } from "./clientListener";
import { NiPoint3 } from "../../sync/movement";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { Actor, ObjectReference } from "skyrimPlatform";
import { logTrace } from "../../logging";

export class WorldCleanerService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("gameLoad", () => this.onGameLoad());
    // Summons appear in cells that are already attached
    this.controller.on("spellCast", () => this.sweepFast());
    this.controller.emitter.on("spellCastMessage", () => this.sweepFast());
  }

  modWcProtection(actorId: number, mod: number): void {
    const protection = (this.protection.get(actorId) || 0) + mod;
    if (protection > 0) {
      this.protection.set(actorId, protection);
    } else {
      this.protection.delete(actorId);
    }
  }

  getWcProtection(actorId: number): number {
    return this.protection.get(actorId) || 0;
  }

  // Faster sweeps for a while, so an engine summon replaced by a server companion goes at once
  sweepBurst(durationMs: number): void {
    this.burstUntil = Math.max(this.burstUntil, Date.now() + durationMs);
  }

  // Called from RemoteServer's shared cellAttach and moveAttachDetach handler
  cleanAttached(refr: ObjectReference, cellAttached: boolean): void {
    // Engine spawns of a new cell may come after its attach
    if (cellAttached) {
      this.sweepFast();
    }
    const actor = ObjectReferenceEx.asActor(refr);
    if (actor !== null) {
      this.clean(actor, actor.getFormID());
    }
  }

  private sweepFast(): void {
    this.fastUntil = Date.now() + WorldCleanerService.fastSweepMs;
  }

  private onGameLoad() {
    let player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }

    this.initialPos = ObjectReferenceEx.getPos(player);
    this.initialCellOrWorld = ObjectReferenceEx.getWorldOrCell(player);
  }

  private onUpdate() {
    const now = Date.now();
    if (now < this.burstUntil) {
      for (let i = 0; i < WorldCleanerService.burstActorsPerUpdate; i++) {
        this.processOneActor();
      }
      return;
    }
    if (now >= this.fastUntil && this.idlePicks >= WorldCleanerService.idlePicksBeforeSlow) {
      if (now < this.nextSlowPickAt) {
        return;
      }
      this.nextSlowPickAt = now + WorldCleanerService.slowPickMs;
    }
    this.processOneActor();
  }

  private processOneActor() {
    const pc = this.sp.Game.getPlayer();
    if (pc === null) {
      return;
    }

    const actor = this.sp.Game.findRandomActor(
      pc.getPositionX(),
      pc.getPositionY(),
      pc.getPositionZ(),
      8192
    );
    const found = actor !== null && this.clean(actor, actor.getFormID());
    this.idlePicks = found ? 0 : this.idlePicks + 1;
  }

  // True when the actor was a stray and is being removed
  private clean(actor: Actor, actorId: number): boolean {
    const currentProtection = this.protection.get(actorId) || 0;
    if (currentProtection > 0) {
      return false;
    }

    if (actorId === 0x14 || actor.isDisabled() || actor.isDeleted()) {
      return false;
    }

    if (this.isActorInDialogue(actor)) {
      // Deleting an actor in dialogue crashes Skyrim: https://github.com/skyrim-multiplayer/issue-tracker/issues/13
      actor.setPosition(0, 0, 0);
      actor.disableNoWait(true); // Seems to not crash
      return true;
    }

    // Keep vanila pre-placed bodies, but delete player bodies
    if (actor.isDead() && actorId < 0xff000000) {
      actor.blockActivation(true);
      return false;
    }

    const pos = ObjectReferenceEx.getPos(actor);
    const cellOrWorld = ObjectReferenceEx.getWorldOrCell(actor);

    const chickenRace = 0xa919d;

    // Anomaly chickens fail to Disable if we load the game near them. Refs: 106C22, 106C23
    if (actorId < 0xff000000 && actor.getRace()?.getFormID() === chickenRace) {
      if (this.initialPos && ObjectReferenceEx.getDistanceNoZ(pos, this.initialPos) < 4096) {
        if (cellOrWorld === this.initialCellOrWorld) {
          if (this.isActorInDialogue(actor)) {
            return false;
          }
          logTrace(this, `Deleting chicken anomaly`, actorId.toString(16));
          actor.killSilent(null);
          actor.blockActivation(true);
          actor.disableNoWait(false);
          actor.setAlpha(0, false);
          return true;
        }
      }
    }

    actor.disable(false).then(() => {
      const ac = this.sp.Actor.from(this.sp.Game.getFormEx(actorId));
      if (!ac || this.isActorInDialogue(ac)) {
        return;
      }
      ac.delete();
    });
    return true;
  }

  private isActorInDialogue(ac: Actor) {
    return ac.isInDialogueWithPlayer() || ac.getDialogueTarget() !== null;
  }

  private protection = new Map<number, number>();
  private burstUntil = 0;
  private fastUntil = 0;
  private nextSlowPickAt = 0;
  // Picks in a row that found no stray
  private idlePicks = 0;
  private static readonly burstActorsPerUpdate = 8;
  private static readonly fastSweepMs = 10000;
  private static readonly idlePicksBeforeSlow = 20;
  private static readonly slowPickMs = 250;
  private initialPos?: NiPoint3;
  private initialCellOrWorld?: number;
}
