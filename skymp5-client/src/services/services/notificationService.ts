import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { showSystemNotification } from "./systemNotification";

// Server-sent one-line notices; without this handler those packets were silently dropped.
//
// Server -> client custom packet:
//   { "customPacketType": "notification", "text": "..." }
export class NotificationService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return; // other services validate their own packets
    }
    if (content["customPacketType"] !== "notification") return;
    const text = typeof content["text"] === "string" ? content["text"] : "";
    if (text) showSystemNotification(this.sp, text);
  }
}
