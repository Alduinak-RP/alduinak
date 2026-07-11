import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { showSystemNotification } from "./systemNotification";

// Server-sent one-line notices, e.g. the respawn system's "You cannot return
// here yet.". Without this handler those packets were silently dropped and
// server-side teleports looked like bugs.
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
