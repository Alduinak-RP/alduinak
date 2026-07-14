import { CombinedController, Sp } from "./clientListener";
import { showSystemNotification } from "./systemNotification";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";

// Shared by the widget menu services: same reliable CustomPacket shape, notifications deferred to next update.

export function sendCustomPacket(controller: CombinedController, payload: Record<string, unknown>): void {
  const message: CustomPacketMessage = {
    t: MsgType.CustomPacket,
    contentJsonDump: JSON.stringify(payload),
  };
  controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
}

export function notifyNextUpdate(controller: CombinedController, sp: Sp, text: string): void {
  controller.once("update", () => {
    showSystemNotification(sp, text);
  });
}
