import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

export interface Profession {
  id: string;
  label: string;
  title: string;
  blurbs?: string[];
}

// The server's masteryMenu reply, rendered by the Personal Menu's Skills tab.
export interface MasteryInfo {
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  professions: Profession[];
}

export function parseMasteryMenu(content: Record<string, unknown>): MasteryInfo {
  const professions = Array.isArray(content["professions"]) ? content["professions"] : [];
  const rankHours = Array.isArray(content["rankHours"]) ? content["rankHours"] : [];
  return {
    profession: typeof content["profession"] === "string" ? content["profession"] as string : null,
    rank: Number(content["rank"]) || 0,
    hours: Number(content["hours"]) || 0,
    rankHours: rankHours as number[],
    professions: professions as Profession[],
  };
}

/**
 * Mastery: one profession per character, ranked by time played. There is no
 * key and no standalone screen; the Personal Menu's Skills tab
 * (AdminMenuService) requests masteryMenu, renders it with parseMasteryMenu
 * and sends the one-time choice. This service shows the server's feedback.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "masteryInfoRequest" }
 *   Server -> Client: { "customPacketType": "masteryMenu", "profession", "rank",
 *                       "hours", "rankHours", "professions" }
 *   Client -> Server: { "customPacketType": "masteryChoose", "profession" }
 *   Server -> Client: { "customPacketType": "masteryNotice", "text" }
 */
export class MasteryService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content && content["customPacketType"] === "masteryNotice" && typeof content["text"] === "string") {
      notifyNextUpdate(this.controller, this.sp, content["text"]);
    }
  }
}
