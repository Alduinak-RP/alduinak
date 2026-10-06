import { FurnitureEvent, Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { notifyNextUpdate, sendCustomPacket, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { BlockedAnimationsService } from "./blockedAnimationsService";
import { isMenuShown } from "./menuStateService";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logToPlatformLog, logTrace } from "../../logging";
import { loc } from "../../loc";

// Sit state 3 is fully seated, so the engine has settled on a marker
const SIT_STATE_SEATED = 3;
const SIT_STATE_STANDING = 4;
// FURN MNAM can enable at most 24 markers
const MAX_MARKERS = 24;
const TICK_MS = 250;
// furnitureEnter may come before the engine reports the furniture, so an empty read clears a fresh seat only after this long
const ENTER_GRACE_MS = 2000;
// A seat wait reads the Crafting Menu from the engine this often, in case its menu events were missed
const WAIT_FALLBACK_MS = 2500;

export type SeatWaitOutcome = "left" | "timeout" | "load";

interface SeatWait {
  deadline: number;
  seated: boolean;
  done: (outcome: SeatWaitOutcome) => void;
}

// The local player's furniture (local id), from furnitureEnter and furnitureExit and the engine reads while seated
const seat = { localId: 0, since: 0, lastRemoteId: 0, leftAt: 0 };

// Plain state, so hooks can read it where script functions are unavailable
export const isPlayerSeated = (): boolean => seat.localId !== 0;

// Remote id of the furniture the player is in or left less than withinMs ago, else 0
export const getRecentSeat = (withinMs: number): number => {
  if (seat.localId) return localIdToRemoteId(seat.localId);
  return Date.now() - seat.leftAt < withinMs ? seat.lastRemoteId : 0;
};

/**
 * Claims the furniture marker the engine seated the local player on (server FurnitureSeatSystem).
 * Remote seated players are only a sit idle here, so the engine may pick their marker;
 * a taken marker is refused and the player stands back up, free markers stay usable.
 */
export class FurnitureSeatService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("furnitureEnter", (e) => this.onFurnitureEvent(e, true));
    this.controller.on("furnitureExit", (e) => this.onFurnitureEvent(e, false));
    this.controller.on("menuOpen", (e) => this.onMenuEvent(e.name));
    this.controller.on("menuClose", (e) => this.onMenuEvent(e.name));
    this.controller.on("loadGame", () => this.onLoadGame());
    // Services are built on tick, where natives are unsafe
    this.controller.once("update", () => this.sample(true));
    this.controller.on("update", () => this.onUpdate());
    onCustomPacket(this.controller, "seatTaken", (content) => this.onCustomPacketMessage(content));
  }

  // Ends once the player sat or opened the Crafting Menu, which a station opens before the sit shows, and is out of both again
  waitSeatCycle(timeoutMs: number): Promise<SeatWaitOutcome> {
    return new Promise((resolve) => {
      this.waits.push({ deadline: Date.now() + timeoutMs, seated: false, done: resolve });
      this.checkWaits();
    });
  }

  private onFurnitureEvent(e: FurnitureEvent, entered: boolean): void {
    if (e.actor?.getFormID() !== 0x14) return;
    if (entered && e.target) this.setSeat(e.target.getFormID());
    const sitState = this.sample(!entered);
    const name = entered ? "furnitureEnter" : "furnitureExit";
    logTrace(this, name, seat.localId.toString(16), `sit state`, sitState);
    // The engine's event order against the sit states is undocumented, so the first of each is logged
    if (!this.timingLogged.has(name)) {
      this.timingLogged.add(name);
      logToPlatformLog(this, `first ${name} came ${sitState < 0 ? "with the engine reporting no furniture" : `at sit state ${sitState}`}`);
    }
    this.checkWaits();
  }

  private onMenuEvent(name: string): void {
    if (name !== Menu.Crafting) return;
    this.craftingRead = undefined;
    if (!this.waits.length) return;
    // A sit made while the menu was open may not have reached the tracker yet
    if (!seat.localId) this.sample(false);
    this.checkWaits();
  }

  private onLoadGame(): void {
    this.craftingRead = undefined;
    this.sample(true);
    // A seat granted before the load is never taken now
    this.waits = this.waits.filter((w) => {
      if (!w.seated) w.done("load");
      return w.seated;
    });
    this.checkWaits();
  }

  private onUpdate(): void {
    if (!seat.localId && !this.waits.length) return;
    const now = Date.now();
    if (now < this.nextTickMs) return;
    this.nextTickMs = now + TICK_MS;
    this.sample(false);
    if (this.waits.length && now >= this.nextFallbackMs) {
      this.nextFallbackMs = now + WAIT_FALLBACK_MS;
      this.craftingRead = this.sp.Ui.isMenuOpen(Menu.Crafting);
    }
    this.checkWaits();
  }

  // Reads the engine's seat, claims at sit state 3 and releases as the exit starts; returns the sit state, -1 out of furniture
  private sample(clearNow: boolean): number {
    const player = this.sp.Game.getPlayer();
    const furniture = player?.getFurnitureReference();
    if (!player || !furniture) {
      this.release();
      if (clearNow || Date.now() - seat.since >= ENTER_GRACE_MS) this.setSeat(0);
      return -1;
    }
    const localId = furniture.getFormID();
    this.setSeat(localId);
    const sitState = player.getSitState();
    // Released as the exit starts, so the server stops counting a chopping swing at once
    if (sitState === SIT_STATE_STANDING) {
      this.release();
      return sitState;
    }

    const furnitureId = localIdToRemoteId(localId);
    if (!furnitureId || furnitureId === this.claimedFurniture || sitState !== SIT_STATE_SEATED) return sitState;
    this.claimedFurniture = furnitureId;

    // Only the local player is ever really in furniture on this client, so the used marker is ours
    let marker = -1;
    for (let i = 0; i < MAX_MARKERS && marker < 0; i++) {
      if (furniture.isFurnitureMarkerInUse(i, false)) marker = i;
    }
    sendCustomPacket(this.controller, { customPacketType: "seatClaim", furniture: furnitureId, marker });
    logTrace(this, `claimed seat`, furnitureId.toString(16), `marker`, marker);
    return sitState;
  }

  private setSeat(localId: number): void {
    if (localId === seat.localId) return;
    const now = Date.now();
    if (seat.localId) {
      seat.lastRemoteId = localIdToRemoteId(seat.localId);
      seat.leftAt = now;
    }
    seat.localId = localId;
    seat.since = now;
  }

  private release(): void {
    if (!this.claimedFurniture) return;
    this.claimedFurniture = 0;
    sendCustomPacket(this.controller, { customPacketType: "seatRelease" });
  }

  private checkWaits(): void {
    if (!this.waits.length) return;
    const busy = !!seat.localId || (this.craftingRead ?? isMenuShown(Menu.Crafting));
    const now = Date.now();
    this.waits = this.waits.filter((w) => {
      if (busy) {
        w.seated = true;
        return true;
      }
      if (!w.seated && now < w.deadline) return true;
      w.done(w.seated ? "left" : "timeout");
      return false;
    });
    if (!this.waits.length) this.craftingRead = undefined;
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (content.furniture !== this.claimedFurniture) return;
    logTrace(this, `seat taken, standing up`);
    this.controller.lookupListener(BlockedAnimationsService).requestStandUp();
    notifyNextUpdate(this.controller, this.sp, loc("seat.taken"));
  }

  private claimedFurniture = 0;
  private nextTickMs = 0;
  private nextFallbackMs = 0;
  private waits = new Array<SeatWait>();
  // The last engine read of the Crafting Menu, until its next menu event or the last wait ends
  private craftingRead?: boolean;
  private timingLogged = new Set<string>();
}
