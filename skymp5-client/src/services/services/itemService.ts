import { ClientListener, CombinedController, Sp } from "./clientListener";
import * as sp from "skyrimPlatform";
import { ButtonEvent, DxScanCode, ObjectReference } from "skyrimPlatform";
import { sendCustomPacket, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { buttonEventKeyCode } from "./widgetMenuUtil";
import { formProp, localIdToRemoteId, pluginRefPose, remoteIdToLocalId } from "../../view/worldViewMisc";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { RemoteServer } from "./remoteServer";
import { ActivationService } from "./activationService";
import { logToPlatformLog } from "../../logging";
import { setAdminGhostShader } from "../../view/adminGhostLook";

// Set by the server's PlacedItemSystem on a nailed item
export const NAILED_PROP = "ff_nailed";
// A press held this long carries the item instead of taking it
const HOLD_MS = 400;
// How far from the player a surface can take an item
const PLACE_REACH = 350;
// Degrees one mouse wheel step turns a carried item
const TURN_STEP = 15;

interface Look {
  how: string;
  pos: number[] | null;
  refId: number;
  layer: number;
}

interface Carry {
  localId: number;
  remoteId: number;
  // Started from the menu: Escape or Activate puts it down, not the key's release
  fromMenu: boolean;
  // The server granted the carry; until then nothing moves
  granted: boolean;
  yaw: number;
  // X and Y rotation and the height above the surface the item will rest at, from the server
  tilt: number[];
  lift: number;
  // The last surface the item was shown on, which the release sends
  surface: number[] | null;
  look: Look | null;
  // Where it lay, shown again when the last surface falls out of reach
  origin: { pos: number[]; rot: number[] };
  // The carried copy shows translucent, as a preview of where it goes
  ghosted: boolean;
}

// Tap Activate to take a world item, hold it (or Move) to carry it on the surface in view; only the release is sent
export class ItemService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    onCustomPacket(this.controller, ["itemGrabState", "itemGrabbed", "itemMoved"], (content) => this.onCustomPacketMessage(content));
    // The server ends a disconnected carry itself and cannot tell this client
    this.controller.emitter.on("connectionDisconnect", () => this.controller.once("update", () => this.reset()));
  }

  isItem(ref: ObjectReference): boolean {
    const base = ref.getBaseObject();
    return !!base && FormTypeEx.isItem(base.getType()) && localIdToRemoteId(ref.getFormID()) !== 0;
  }

  isNailed(remoteId: number): boolean {
    return formProp(remoteId, NAILED_PROP) === true;
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

  // Sent right before a drop: the surface the player looks at; the server drops at the feet without one
  sendDropPoint(): void {
    const look = this.lookSurface(this.carry?.localId ?? 0);
    sendCustomPacket(this.controller, { customPacketType: "itemDropPoint", pos: look.pos });
    this.logLook("drop point", look);
  }

  private request(localId: number, remoteId: number, fromMenu: boolean): void {
    const ref = ObjectReference.from(this.sp.Game.getFormEx(localId));
    const rot = ref ? [ref.getAngleX(), ref.getAngleY(), ref.getAngleZ()] : [0, 0, 0];
    const pos = ref ? [ref.getPositionX(), ref.getPositionY(), ref.getPositionZ()] : [0, 0, 0];
    this.carry = { localId, remoteId, fromMenu, granted: false, yaw: rot[2], tilt: [rot[0], rot[1]], lift: 0, surface: null, look: null, origin: { pos, rot }, ghosted: false };
    sendCustomPacket(this.controller, { customPacketType: "itemGrab", target: remoteId });
  }

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
    if (!ref) {
      this.drop(null, false);
      return;
    }
    if (!carry.fromMenu && !this.activateHeld()) {
      this.drop(ref, true);
      return;
    }
    if (!carry.granted) return;
    if (!carry.ghosted) {
      carry.ghosted = true;
      setAdminGhostShader(ref, true);
    }
    // Without a surface the item stays where it was last shown, until that spot falls out of reach
    const look = this.lookSurface(carry.localId);
    carry.look = look;
    if (look.pos) {
      carry.surface = look.pos;
      ref.setPosition(look.pos[0], look.pos[1], look.pos[2] + carry.lift);
    } else if (carry.surface && this.distanceFromPlayer(carry.surface) > PLACE_REACH) {
      carry.surface = null;
      ref.setPosition(carry.origin.pos[0], carry.origin.pos[1], carry.origin.pos[2]);
    }
    if (carry.surface) ref.setAngle(carry.tilt[0], carry.tilt[1], carry.yaw);
    else ref.setAngle(carry.origin.rot[0], carry.origin.rot[1], carry.origin.rot[2]);
  }

  private onButtonEvent(e: ButtonEvent): void {
    const carry = this.carry;
    if (!e.isDown || !carry) return;
    const code = buttonEventKeyCode(e);
    // A menu carry always has a way out, granted or not
    if (carry.fromMenu && (code === DxScanCode.Escape || e.userEventName === "Activate")) {
      this.drop(ObjectReference.from(this.sp.Game.getFormEx(carry.localId)), true);
    } else if (carry.granted && (code === DxScanCode.MouseWheelUp || code === DxScanCode.MouseWheelDown)) {
      carry.yaw = (carry.yaw + (code === DxScanCode.MouseWheelUp ? TURN_STEP : -TURN_STEP) + 360) % 360;
    }
  }

  // Sends the surface the item was last shown on; with none, the server puts it back where it was
  private drop(ref: ObjectReference | null, place: boolean): void {
    const carry = this.carry!;
    this.carry = null;
    if (ref && carry.ghosted) setAdminGhostShader(ref, false);
    const surface = place && carry.granted ? carry.surface : null;
    if (ref && surface) {
      sendCustomPacket(this.controller, { customPacketType: "itemMove", target: carry.remoteId, pos: surface, rot: [carry.tilt[0], carry.tilt[1], carry.yaw] });
    } else {
      sendCustomPacket(this.controller, { customPacketType: "itemRelease", target: carry.remoteId });
    }
    if (carry.granted) this.logLook(`release ${carry.remoteId.toString(16)}${surface ? "" : ", put back"}`, carry.look ?? { how: "never looked", pos: null, refId: 0, layer: -1 });
  }

  // Puts a carried copy back unghosted where the server still has it, sending nothing
  private reset(): void {
    this.pending = null;
    const carry = this.carry;
    if (!carry) return;
    this.carry = null;
    const ref = ObjectReference.from(this.sp.Game.getFormEx(carry.localId));
    if (!ref) return;
    if (carry.ghosted) setAdminGhostShader(ref, false);
    if (carry.granted) {
      ref.setPosition(carry.origin.pos[0], carry.origin.pos[1], carry.origin.pos[2]);
      ref.setAngle(carry.origin.rot[0], carry.origin.rot[1], carry.origin.rot[2]);
    }
  }

  private lookSurface(ignoreLocalId: number): Look {
    // Newer than the typings package; an older SkyrimPlatform in Platform/ shows here as "missing"
    const native = (sp as unknown as { getLookSurface?: (ignore: number, reach: number) => Look }).getLookSurface;
    if (typeof native !== "function") return { how: "missing", pos: null, refId: 0, layer: -1 };
    return native(ignoreLocalId, PLACE_REACH);
  }

  private distanceFromPlayer(point: number[]): number {
    const player = this.sp.Game.getPlayer();
    return player ? Math.hypot(point[0] - player.getPositionX(), point[1] - player.getPositionY(), point[2] - player.getPositionZ()) : Infinity;
  }

  private logLook(what: string, look: Look): void {
    const away = look.pos ? this.distanceFromPlayer(look.pos).toFixed(0) : "-";
    logToPlatformLog(this, `${what}: ${look.how} ref ${look.refId.toString(16)} layer ${look.layer} at ${look.pos ? look.pos.map((v) => v.toFixed(1)).join(",") : "-"}, ${away} from player`);
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const type = content["customPacketType"];
    const target = Number(content["target"]);
    const own = this.carry?.granted === true && this.carry.remoteId === target;
    if (type === "itemGrabState" && this.carry?.remoteId === target) {
      if (content["ok"] !== true) {
        this.carry = null;
        return;
      }
      const tilt = content["tilt"];
      this.carry.granted = true;
      if (Array.isArray(tilt) && tilt.length === 2) this.carry.tilt = tilt.map(Number);
      this.carry.lift = Number(content["lift"]) || 0;
    } else if (type === "itemGrabbed" && !own) {
      this.controller.once("update", () => ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(target)))?.disable(false));
    } else if (type === "itemMoved") {
      const pos = content["pos"] as number[], rot = content["rot"] as number[];
      if (!Array.isArray(pos) || !Array.isArray(rot)) return;
      // During a granted carry only the server ending it (time out, refusal) sends this
      const unghost = own && this.carry!.ghosted;
      if (own) this.carry = null;
      if (target < 0xff000000) pluginRefPose.set(target, { pos: [pos[0], pos[1], pos[2]], rot: [rot[0], rot[1], rot[2]] });
      // The model is what a copy spawns from and what its first movement apply moves it back to
      const form = this.controller.lookupListener(RemoteServer).getFormByRefrId(target);
      if (form?.movement) form.movement = { ...form.movement, pos: [pos[0], pos[1], pos[2]], rot: [rot[0], rot[1], rot[2]] };
      // Native calls are unsafe in the packet handler
      this.controller.once("update", () => {
        const ref = ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(target)));
        if (!ref) return;
        if (unghost) setAdminGhostShader(ref, false);
        ref.setPosition(pos[0], pos[1], pos[2]);
        ref.setAngle(rot[0], rot[1], rot[2]);
        ref.enable(false);
      });
    }
  }

  private activateHeld(): boolean {
    const code = this.sp.Input.getMappedKey("Activate", 0);
    return code > 0 && this.sp.Input.isKeyPressed(code);
  }

  private pending: { localId: number; remoteId: number; at: number } | null = null;
  private carry: Carry | null = null;
}
