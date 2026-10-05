import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { showSystemNotification } from "./systemNotification";

// Server-sent one-line notices; without this handler those packets were silently dropped.
//
// Server -> client custom packet:
//   { "customPacketType": "notification", "text": "..." }
export class NotificationService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    onCustomPacket(this.controller, "notification", (content) => this.onCustomPacketMessage(content));
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const text = typeof content["text"] === "string" ? content["text"] : "";
    if (text) showSystemNotification(this.sp, text);
  }
}
