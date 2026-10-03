import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ButtonEvent, DxScanCode, ObjectReference } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { buttonEventKeyCode } from "./widgetMenuUtil";
import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { RemoteServer } from "./remoteServer";
import { ActivationService } from "./activationService";

// Set by the server's PlacedItemSystem on a nailed item
export const NAILED_PROP = "ff_nailed";
// A press held this long moves the item instead of taking it
const HOLD_MS = 400;
// Where a moved item floats: units ahead of the player and above the feet
const HOLD_DISTANCE = 120;
const HOLD_HEIGHT = 100;

interface Grab {
  localId: number;
  remoteId: number;
  // Started from the menu: Escape or Activate lets go, not the key's release
  fromMenu: boolean;
}

// Player-placed items: a tap of Activate takes one, a held Activate or the menu's Move carries it with no physics until let go
export class ItemService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  isPlacedItem(ref: ObjectReference): boolean {
    const base = ref.getBaseObject();
    return ref.getFormID() >= 0xff000000 && !!base && FormTypeEx.isItem(base.getType()) && localIdToRemoteId(ref.getFormID()) >= 0xff000000;
  }

  isNailed(remoteId: number): boolean {
    const form = this.controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === remoteId);
    return (form as Record<string, unknown> | undefined)?.[NAILED_PROP] === true;
  }

  // True when the press is ours; the tap's pickup is sent once the key is let go in time
  onActivatePress(ref: ObjectReference, remoteId: number): boolean {
    if (!this.isPlacedItem(ref)) return false;
    if (this.grab || this.isNailed(remoteId)) return true;
    this.pending = { localId: ref.getFormID(), remoteId, at: Date.now() };
    return true;
  }

  startMove(ref: ObjectReference): void {
    const remoteId = localIdToRemoteId(ref.getFormID());
    if (remoteId && !this.isNailed(remoteId)) this.grab = { localId: ref.getFormID(), remoteId, fromMenu: true };
  }

  private onUpdate(): void {
    const pending = this.pending;
    if (pending && !this.activateHeld()) {
      this.pending = null;
      this.controller.lookupListener(ActivationService).sendActivation(0x14, pending.remoteId);
    } else if (pending && Date.now() - pending.at >= HOLD_MS) {
      this.pending = null;
      this.grab = { localId: pending.localId, remoteId: pending.remoteId, fromMenu: false };
    }
    if (!this.grab) return;
    const ref = ObjectReference.from(this.sp.Game.getFormEx(this.grab.localId));
    const player = this.sp.Game.getPlayer();
    if (!ref || !player) {
      this.grab = null;
      return;
    }
    if (!this.grab.fromMenu && !this.activateHeld()) {
      this.release(ref);
      return;
    }
    const yaw = player.getAngleZ() * Math.PI / 180;
    const pitch = player.getAngleX() * Math.PI / 180;
    const ahead = Math.cos(pitch) * HOLD_DISTANCE;
    ref.setPosition(player.getPositionX() + Math.sin(yaw) * ahead, player.getPositionY() + Math.cos(yaw) * ahead,
      player.getPositionZ() + HOLD_HEIGHT - Math.sin(pitch) * HOLD_DISTANCE);
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!e.isDown || !this.grab?.fromMenu) return;
    if (buttonEventKeyCode(e) !== DxScanCode.Escape && e.userEventName !== "Activate") return;
    const ref = ObjectReference.from(this.sp.Game.getFormEx(this.grab.localId));
    if (ref) this.release(ref);
    else this.grab = null;
  }

  private release(ref: ObjectReference): void {
    const target = this.grab!.remoteId;
    this.grab = null;
    sendCustomPacket(this.controller, { customPacketType: "itemMove", target,
      pos: [ref.getPositionX(), ref.getPositionY(), ref.getPositionZ()], rot: [ref.getAngleX(), ref.getAngleY(), ref.getAngleZ()] });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "itemMoved") return;
    const target = Number(content["target"]);
    const pos = content["pos"] as number[], rot = content["rot"] as number[];
    if (this.grab?.remoteId === target || !Array.isArray(pos) || !Array.isArray(rot)) return;
    // Native calls are unsafe in the packet handler
    this.controller.once("update", () => {
      const ref = ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(target)));
      if (!ref) return;
      ref.setPosition(pos[0], pos[1], pos[2]);
      ref.setAngle(rot[0], rot[1], rot[2]);
    });
  }

  private activateHeld(): boolean {
    const code = this.sp.Input.getMappedKey("Activate", 0);
    return code > 0 && this.sp.Input.isKeyPressed(code);
  }

  private pending: { localId: number; remoteId: number; at: number } | null = null;
  private grab: Grab | null = null;
}
