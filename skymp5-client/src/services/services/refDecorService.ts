import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { ObjectReference } from "skyrimPlatform";
import { logTrace } from "../../logging";

const MASTER_LOCK_LEVEL = 100;
const APPLY_EVERY_N_UPDATES = 30;

// One claimed reference's presentation, as sent by the server.
interface RefDecor {
  refId: number;
  name: string | null;
  locked: boolean;
}

/**
 * Applies claim state to the actual game world. Locks are enforced server-side
 * regardless; this service makes them visible and physical on each client:
 *
 *   Server -> Client: { "customPacketType": "refDecor", "refs": [
 *     { "refId", "name", "locked" } ] }
 *
 * - name: setDisplayName so the crosshair shows the claim's name.
 * - locked: Master lock via setLockLevel(100) + lock(true) for every player;
 *   the server refuses activation until someone with access unlocks it.
 * Entries re-apply on a slow tick so refs that load later (cell changes)
 * converge without extra packets.
 */
export class RefDecorService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("gameLoad", () => this.onGameLoad());
  }

  // A save load resets every engine lock and display name
  private onGameLoad(): void {
    this.applied.clear();
    this.updateCounter = APPLY_EVERY_N_UPDATES;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] !== "refDecor" || !Array.isArray(content["refs"])) {
      return;
    }
    // Full syncs replace the set: refs we decorated that are gone from the
    // sync (abandoned claims) get a synthetic unlock entry so they revert.
    if (content["full"] === true) {
      const incoming = new Set((content["refs"] as any[]).map((r) => Number(r?.refId) >>> 0));
      this.decor.forEach((_d, refId) => {
        if (!incoming.has(refId)) {
          this.decor.set(refId, { refId, name: null, locked: false });
        }
      });
    }
    logTrace(this, `sync:`, (content["refs"] as any[]).length, `refs`);
    for (const raw of content["refs"] as any[]) {
      const refId = Number(raw?.refId) >>> 0;
      if (!refId) {
        continue;
      }
      this.decor.set(refId, {
        refId,
        name: typeof raw.name === "string" && raw.name ? raw.name : null,
        locked: raw.locked === true,
      });
      this.applied.delete(refId);
    }
    // Apply on the next update rather than the next slow tick
    this.updateCounter = APPLY_EVERY_N_UPDATES;
  }

  private onUpdate(): void {
    if (this.decor.size === 0 || ++this.updateCounter < APPLY_EVERY_N_UPDATES) {
      return;
    }
    this.updateCounter = 0;
    const stats = { names: 0, locks: 0, errors: 0, notLoaded: 0, firstError: "" };
    this.decor.forEach((d) => this.apply(d, stats));
    if (stats.names || stats.locks || stats.errors) {
      logTrace(this, `applied names=${stats.names} locks=${stats.locks} errors=${stats.errors} notloaded=${stats.notLoaded}${stats.firstError ? " | " + stats.firstError : ""}`);
    }
  }

  private apply(d: RefDecor, stats: { names: number; locks: number; errors: number; notLoaded: number; firstError: string }): void {
    let refr: ObjectReference | null = null;
    try {
      const localId = remoteIdToLocalId(d.refId);
      if (!localId) {
        return;
      }
      refr = ObjectReference.from(this.sp.Game.getFormEx(localId));
    } catch (e) {
      return;
    }
    if (!refr) {
      stats.notLoaded++;
      return; // not loaded yet; retried on a later tick
    }

    const prev = this.applied.get(d.refId) || {};
    if (d.name && prev.name !== d.name) {
      try {
        refr.setDisplayName(d.name, true);
        prev.name = d.name;
        stats.names++;
      } catch (e: any) {
        stats.errors++;
        if (!stats.firstError) stats.firstError = "name: " + (e && e.message);
      }
    }
    // A released claim hands the crosshair back to the base object's name
    if (!d.name && prev.name) {
      try {
        refr.setDisplayName(refr.getBaseObject()?.getName() || "", true);
        delete prev.name;
        stats.names++;
      } catch (e: any) {
        stats.errors++;
        if (!stats.firstError) stats.firstError = "name: " + (e && e.message);
      }
    }
    try {
      // Compared with the engine every pass, since a re-created view unlocks the ref behind this service's back
      if (refr.isLocked() !== d.locked) {
        if (d.locked) {
          refr.setLockLevel(MASTER_LOCK_LEVEL);
          refr.lock(true, false);
        } else {
          refr.lock(false, false);
        }
        stats.locks++;
      }
      if (!d.locked && !d.name) this.decor.delete(d.refId);
    } catch (e: any) {
      stats.errors++;
      if (!stats.firstError) stats.firstError = "lock: " + (e && e.message);
    }
    this.applied.set(d.refId, prev);
  }

  private decor = new Map<number, RefDecor>();
  private applied = new Map<number, { name?: string }>();
  private updateCounter = 0;
}
