import { ClientListener, CombinedController, Sp } from "./clientListener";
import * as sp from "skyrimPlatform";
import { ButtonEvent, DxScanCode, ObjectReference } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { buttonEventKeyCode } from "./widgetMenuUtil";
import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { RemoteServer } from "./remoteServer";
import { ActivationService } from "./activationService";
import { logToPlatformLog } from "../../logging";

// Set by the server's PlacedItemSystem on a nailed item
export const NAILED_PROP = "ff_nailed";
// A press held this long carries the item instead of taking it
const HOLD_MS = 400;
// Where a carried item floats when the crosshair finds no surface: units ahead of the player and above the feet
const HOLD_DISTANCE = 120;
const HOLD_HEIGHT = 100;
// A surface further than this is ignored and the item lands at the feet
const PLACE_REACH = 350;
// Degrees one mouse wheel step turns a carried item
const TURN_STEP = 15;

interface Carry {
  localId: number;
  remoteId: number;
  // Started from the menu: Escape or Activate puts it down, not the key's release
  fromMenu: boolean;
  // The server granted the carry; until then nothing moves
  granted: boolean;
  yaw: number;
}

// World items: a tap of Activate takes one; a held Activate or the menu's Move carries it with no physics and no collision, shown
// on the surface under the crosshair, while the server hides it from everyone else; only the release is sent
export class ItemService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  isItem(ref: ObjectReference): boolean {
    const base = ref.getBaseObject();
    return !!base && FormTypeEx.isItem(base.getType()) && localIdToRemoteId(ref.getFormID()) !== 0;
  }

  isNailed(remoteId: number): boolean {
    const form = this.controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === remoteId);
    return (form as Record<string, unknown> | undefined)?.[NAILED_PROP] === true;
  }

  // True when the press is ours; the tap's pickup is sent once the key is let go in time
  onActivatePress(ref: ObjectReference, remoteId: number): boolean {
    if (!this.isItem(ref)) return false;
    if (this.carry || this.isNailed(remoteId)) return true;
    this.pending = { localId: ref.getFormID(), remoteId, at: Date.now() };
    return true;
  }

  startMove(ref: ObjectReference): void {
    const remoteId = localIdToRemoteId(ref.getFormID());
    if (remoteId && !this.carry && !this.isNailed(remoteId)) this.request(ref.getFormID(), remoteId, true);
  }

  private request(localId: number, remoteId: number, fromMenu: boolean): void {
    const ref = ObjectReference.from(this.sp.Game.getFormEx(localId));
    this.carry = { localId, remoteId, fromMenu, granted: false, yaw: ref?.getAngleZ() ?? 0 };
    sendCustomPacket(this.controller, { customPacketType: "itemGrab", target: remoteId });
  }

  // Sent right before a drop: the surface the crosshair last found, which the menu leaves as it was, else the feet
  sendDropPoint(): void {
    const player = this.sp.Game.getPlayer();
    sendCustomPacket(this.controller, { customPacketType: "itemDropPoint", pos: player ? this.surfacePoint(player) : null });
  }

  // Idle, this reads nothing from the game
  private onUpdate(): void {
    if (!this.pending && !this.carry) return;
    const pending = this.pending;
    if (pending && !this.activateHeld()) {
      this.pending = null;
      this.controller.lookupListener(ActivationService).sendActivation(0x14, pending.remoteId);
    } else if (pending && Date.now() - pending.at >= HOLD_MS) {
      this.pending = null;
      this.request(pending.localId, pending.remoteId, false);
    }
    const carry = this.carry;
    if (!carry) return;
    const ref = ObjectReference.from(this.sp.Game.getFormEx(carry.localId));
    const player = this.sp.Game.getPlayer();
    if (!ref || !player) {
      this.drop(null, false);
      return;
    }
    if (!carry.fromMenu && !this.activateHeld()) {
      this.drop(ref, carry.granted);
      return;
    }
    if (!carry.granted) return;
    const surface = this.surfacePoint(player);
    if (surface) {
      ref.setPosition(surface[0], surface[1], surface[2]);
    } else {
      const yaw = player.getAngleZ() * Math.PI / 180;
      const pitch = player.getAngleX() * Math.PI / 180;
      const ahead = Math.cos(pitch) * HOLD_DISTANCE;
      ref.setPosition(player.getPositionX() + Math.sin(yaw) * ahead, player.getPositionY() + Math.cos(yaw) * ahead,
        player.getPositionZ() + HOLD_HEIGHT - Math.sin(pitch) * HOLD_DISTANCE);
    }
    ref.setAngle(ref.getAngleX(), ref.getAngleY(), carry.yaw);
  }

  private onButtonEvent(e: ButtonEvent): void {
    const carry = this.carry;
    if (!e.isDown || !carry?.granted) return;
    const code = buttonEventKeyCode(e);
    if (code === DxScanCode.MouseWheelUp || code === DxScanCode.MouseWheelDown) {
      carry.yaw = (carry.yaw + (code === DxScanCode.MouseWheelUp ? TURN_STEP : -TURN_STEP) + 360) % 360;
    } else if (carry.fromMenu && (code === DxScanCode.Escape || e.userEventName === "Activate")) {
      this.drop(ObjectReference.from(this.sp.Game.getFormEx(carry.localId)), true);
    }
  }

  // Sends where the item's bottom goes: the surface under the crosshair, else the player's feet
  private drop(ref: ObjectReference | null, place: boolean): void {
    const carry = this.carry!;
    this.carry = null;
    if (ref && carry.granted) this.setCollision(carry.localId, true);
    if (!ref || !place || !carry.granted) {
      sendCustomPacket(this.controller, { customPacketType: "itemRelease", target: carry.remoteId });
      return;
    }
    const player = this.sp.Game.getPlayer()!;
    const pos = this.surfacePoint(player) ?? [player.getPositionX(), player.getPositionY(), player.getPositionZ()];
    sendCustomPacket(this.controller, { customPacketType: "itemMove", target: carry.remoteId, pos, rot: [ref.getAngleX(), ref.getAngleY(), carry.yaw] });
  }

  private surfacePoint(player: { getPositionX(): number; getPositionY(): number; getPositionZ(): number }): number[] | null {
    // Newer than the typings package; an older SkyrimPlatform has no pick point and every item lands at the feet
    const pick = (sp as unknown as { getCrosshairPickPoint?: () => number[] | null }).getCrosshairPickPoint;
    const point = typeof pick === "function" ? pick() : null;
    if (!point) return null;
    const far = Math.hypot(point[0] - player.getPositionX(), point[1] - player.getPositionY(), point[2] - player.getPositionZ());
    if (!this.pickLogged) {
      this.pickLogged = true;
      logToPlatformLog(this, `first crosshair pick ${point.map((v) => v.toFixed(1)).join(",")}, ${far.toFixed(1)} units from the player`);
    }
    return far <= PLACE_REACH ? point : null;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    const type = content?.["customPacketType"];
    const target = Number(content?.["target"]);
    if (type === "itemGrabState" && this.carry?.remoteId === target) {
      if (content!["ok"] !== true) {
        this.carry = null;
        return;
      }
      this.carry.granted = true;
      const localId = this.carry.localId;
      // Native calls are unsafe in the packet handler; the pick ray must pass through the carried item
      this.controller.once("update", () => this.setCollision(localId, false));
    } else if (type === "itemGrabbed" && this.carry?.remoteId !== target) {
      this.controller.once("update", () => ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(target)))?.disable(false));
    } else if (type === "itemMoved" && this.carry?.remoteId !== target) {
      const pos = content!["pos"] as number[], rot = content!["rot"] as number[];
      if (!Array.isArray(pos) || !Array.isArray(rot)) return;
      this.controller.once("update", () => {
        const ref = ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(target)));
        if (!ref) return;
        ref.setPosition(pos[0], pos[1], pos[2]);
        ref.setAngle(rot[0], rot[1], rot[2]);
        ref.enable(false);
      });
    }
  }

  // Newer than the typings package, like the pick point
  private setCollision(localId: number, on: boolean): void {
    (sp as unknown as { setCollision: (id: number, on: boolean) => void }).setCollision(localId, on);
  }

  private activateHeld(): boolean {
    const code = this.sp.Input.getMappedKey("Activate", 0);
    return code > 0 && this.sp.Input.isKeyPressed(code);
  }

  private pending: { localId: number; remoteId: number; at: number } | null = null;
  private pickLogged = false;
  private carry: Carry | null = null;
}
