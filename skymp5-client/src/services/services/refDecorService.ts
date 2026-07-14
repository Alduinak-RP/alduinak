import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { getInventory } from "../../sync/inventory";
import { ObjectReference } from "skyrimPlatform";

const KEY_BASE_ID = 0x000DB0E2; // TODO: Replace with mod key when ESP is made
const REQUIRES_KEY_LOCK_LEVEL = 255;
const APPLY_EVERY_N_UPDATES = 90;

// One claimed reference's presentation, as sent by the server. `access` is
// personalized: true when this player passes by rank/ownership; key holders
// are detected locally so a traded key works immediately.
interface RefDecor {
  refId: number;
  name: string | null;
  locked: boolean;
  keyName: string | null;
  access: boolean;
}

/**
 * Applies claim state to the actual game world. Locks are enforced server-side
 * regardless; this service makes them visible and physical on each client:
 *
 *   Server -> Client: { "customPacketType": "refDecor", "refs": [
 *     { "refId", "name", "locked", "keyName", "access" } ] }
 *
 * - name: setDisplayName so the crosshair shows the claim's name.
 * - locked && !access && !holding key: vanilla "Requires Key" lock via
 *   setLockLevel(255) + lock(true).
 * Entries re-apply on a slow tick so refs that load later (cell changes) and
 * key pickups/losses converge without extra packets.
 */
export class RefDecorService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
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
      this.applied.forEach((state, refId) => {
        if (!incoming.has(refId) && state.engineLocked) {
          this.decor.set(refId, { refId, name: null, locked: false, keyName: null, access: true });
          this.applied.delete(refId);
        }
      });
      this.decor.forEach((_d, refId) => {
        if (!incoming.has(refId)) {
          this.decor.set(refId, { refId, name: null, locked: false, keyName: null, access: true });
        }
      });
    }
    for (const raw of content["refs"] as any[]) {
      const refId = Number(raw?.refId) >>> 0;
      if (!refId) {
        continue;
      }
      this.decor.set(refId, {
        refId,
        name: typeof raw.name === "string" && raw.name ? raw.name : null,
        locked: raw.locked === true,
        keyName: typeof raw.keyName === "string" && raw.keyName ? raw.keyName : null,
        access: raw.access === true,
      });
      // Force re-evaluation on the next tick.
      this.applied.delete(refId);
    }
  }

  private onUpdate(): void {
    if (this.decor.size === 0 || ++this.updateCounter < APPLY_EVERY_N_UPDATES) {
      return;
    }
    this.updateCounter = 0;
    const heldKeys = this.heldKeyNames();
    this.decor.forEach((d) => this.apply(d, heldKeys));
  }

  private apply(d: RefDecor, heldKeys: Set<string>): void {
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
      return; // not loaded yet; retried on a later tick
    }

    const prev = this.applied.get(d.refId) || {};
    if (d.name && prev.name !== d.name) {
      refr.setDisplayName(d.name, true);
      prev.name = d.name;
    }
    const shouldLock = d.locked && !d.access && !(d.keyName !== null && heldKeys.has(d.keyName));
    if (prev.engineLocked !== shouldLock) {
      if (shouldLock) {
        refr.setLockLevel(REQUIRES_KEY_LOCK_LEVEL);
        refr.lock(true, false);
      } else {
        refr.lock(false, false);
      }
      prev.engineLocked = shouldLock;
    }
    this.applied.set(d.refId, prev);
  }

  // Names of all property keys currently in the player's inventory.
  private heldKeyNames(): Set<string> {
    const held = new Set<string>();
    try {
      const player = this.sp.Game.getPlayer() as ObjectReference | null;
      if (!player) {
        return held;
      }
      for (const e of getInventory(player).entries) {
        if ((e.baseId >>> 0) === KEY_BASE_ID && typeof e.name === "string" && e.name && e.count > 0) {
          held.add(e.name);
        }
      }
    } catch (e) {
      // inventory unavailable during loads; keys re-check next tick
    }
    return held;
  }

  private decor = new Map<number, RefDecor>();
  private applied = new Map<number, { name?: string; engineLocked?: boolean }>();
  private updateCounter = 0;
}
