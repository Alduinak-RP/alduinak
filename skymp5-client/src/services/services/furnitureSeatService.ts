import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { notifyNextUpdate, parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { BlockedAnimationsService } from "./blockedAnimationsService";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// Sit state 3 is fully seated, so the engine has settled on a marker
const SIT_STATE_SEATED = 3;
// FURN MNAM can enable at most 24 markers
const MAX_MARKERS = 24;
const TICK_MS = 250;

/**
 * Claims the furniture marker the engine seated the local player on (server FurnitureSeatSystem).
 * Remote seated players are only a sit idle here, so the engine may pick their marker;
 * a taken marker is refused and the player stands back up, free markers stay usable.
 */
export class FurnitureSeatService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextTickMs) return;
    this.nextTickMs = now + TICK_MS;

    const player = this.sp.Game.getPlayer();
    const furniture = player?.getFurnitureReference();
    if (!player || !furniture) {
      if (this.claimedFurniture) {
        this.claimedFurniture = 0;
        sendCustomPacket(this.controller, { customPacketType: "seatRelease" });
      }
      return;
    }

    const furnitureId = localIdToRemoteId(furniture.getFormID());
    if (!furnitureId || furnitureId === this.claimedFurniture || player.getSitState() !== SIT_STATE_SEATED) return;
    this.claimedFurniture = furnitureId;

    // Only the local player is ever really in furniture on this client, so the used marker is ours
    let marker = -1;
    for (let i = 0; i < MAX_MARKERS && marker < 0; i++) {
      if (furniture.isFurnitureMarkerInUse(i, false)) marker = i;
    }
    sendCustomPacket(this.controller, { customPacketType: "seatClaim", furniture: furnitureId, marker });
    logTrace(this, `claimed seat`, furnitureId.toString(16), `marker`, marker);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.customPacketType !== "seatTaken" || content.furniture !== this.claimedFurniture) return;
    logTrace(this, `seat taken, standing up`);
    this.controller.lookupListener(BlockedAnimationsService).requestStandUp();
    notifyNextUpdate(this.controller, this.sp, "Someone is already sitting there. Try another seat.");
  }

  private claimedFurniture = 0;
  private nextTickMs = 0;
}
