import { CombinedController, Sp } from "./clientListener";
import { showSystemNotification } from "./systemNotification";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";

// Shared by the housing / faction / player-action services, which all emit the
// same reliable CustomPacket shape and defer notifications to the next update.

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
