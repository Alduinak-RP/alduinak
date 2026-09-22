import { ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { addSendToGraphHook } from "../../sync/animation";
import { logError, logTrace } from "../../logging";

// Furniture whose own behaviour graph the engine drives from its user's animation, a link a player's copy never gets
interface FurnitureSlave {
  // Enter events of the furniture's idle, lower case
  enter: string[];
  start: string;
  stop: string;
  // How far from the copy the furniture is looked for
  radius: number;
}

const FURNITURE_SLAVES: Record<number, FurnitureSlave> = {
  // GrainMill: the wheel turns while the user pushes
  0x0009c6df: { enter: ["idlegrainmillenter", "idlegrainmillenterinstant"], start: "SlavePush", stop: "SlaveIdle", radius: 160 },
};

const TICK_MS = 500;
// A copy this far from the furniture has left it, whatever its graph says
const LEAVE_DISTANCE = 96;
// Sends of the start event before a furniture whose 3D never arrives is given up
const MAX_TRIES = 20;

interface Link {
  copyId: number;
  furnitureId: number;
  slave: FurnitureSlave;
  tries: number;
  started: boolean;
}

/**
 * Replays furniture animations for observers. A remote player's copy only receives its player's animation
 * events, so the mill it grinds at never gets the slave events the engine sends from a real furniture user.
 * When a copy plays an enter event of the table, the nearest such furniture gets the start event; any later
 * event of that copy, or the copy walking away or unloading, sends the stop event.
 */
export class FurnitureAnimationsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    addSendToGraphHook((refr, animEventName) => this.onCopyAnimation(refr, animEventName));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCopyAnimation(refr: ObjectReference, animEventName: string): void {
    try {
      const copyId = refr.getFormID();
      const name = animEventName.toLowerCase();
      const entry = Object.entries(FURNITURE_SLAVES).find(([, slave]) => slave.enter.includes(name));
      if (!entry) {
        const link = this.links.get(copyId);
        if (link) this.release(link, `event ${animEventName}`);
        return;
      }
      const [baseId, slave] = entry;
      const base = this.sp.Game.getFormEx(Number(baseId));
      const furniture = base && this.sp.Game.findClosestReferenceOfType(base, refr.getPositionX(), refr.getPositionY(), refr.getPositionZ(), slave.radius);
      if (!furniture) {
        logTrace(this, `no ${Number(baseId).toString(16)} within ${slave.radius} of copy ${copyId.toString(16)} for ${animEventName}`);
        return;
      }
      const link: Link = { copyId, furnitureId: furniture.getFormID(), slave, tries: 0, started: false };
      this.links.set(copyId, link);
      this.drive(link);
    } catch (err) {
      logError(this, `copy animation failed: ${err}`);
    }
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextTickAt) return;
    this.nextTickAt = now + TICK_MS;
    for (const link of Array.from(this.links.values())) {
      try {
        const copy = this.sp.ObjectReference.from(this.sp.Game.getFormEx(link.copyId));
        const furniture = this.furnitureOf(link);
        if (!copy || !copy.is3DLoaded() || !furniture) {
          this.release(link, "copy or furniture gone");
          continue;
        }
        const distance = Math.hypot(copy.getPositionX() - furniture.getPositionX(), copy.getPositionY() - furniture.getPositionY(), copy.getPositionZ() - furniture.getPositionZ());
        if (distance > LEAVE_DISTANCE) {
          this.release(link, `copy ${Math.round(distance)} units away`);
          continue;
        }
        if (!link.started) this.drive(link);
      } catch (err) {
        this.links.delete(link.copyId);
        logError(this, `tick failed: ${err}`);
      }
    }
  }

  // The furniture graph takes events once its 3D is in; both entry points are used since the mill's graph is a behaviour, not a sequence
  private drive(link: Link): void {
    const furniture = this.furnitureOf(link);
    if (!furniture || !furniture.is3DLoaded()) {
      if (++link.tries >= MAX_TRIES) this.release(link, "furniture 3D never loaded");
      return;
    }
    const played = furniture.playAnimation(link.slave.start);
    this.sp.Debug.sendAnimationEvent(furniture, link.slave.start);
    link.started = true;
    logTrace(this, `${link.slave.start} sent to ${link.furnitureId.toString(16)} for copy ${link.copyId.toString(16)} (playAnimation ${played})`);
  }

  private release(link: Link, why: string): void {
    this.links.delete(link.copyId);
    if (!link.started) return;
    const furniture = this.furnitureOf(link);
    if (furniture?.is3DLoaded()) {
      furniture.playAnimation(link.slave.stop);
      this.sp.Debug.sendAnimationEvent(furniture, link.slave.stop);
    }
    logTrace(this, `${link.slave.stop} sent to ${link.furnitureId.toString(16)}: ${why}`);
  }

  private furnitureOf(link: Link): ObjectReference | null {
    return this.sp.ObjectReference.from(this.sp.Game.getFormEx(link.furnitureId));
  }

  private links = new Map<number, Link>();
  private nextTickAt = 0;
}
