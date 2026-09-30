import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

export interface Profession {
  id: string;
  label: string;
  type?: string;
  title: string;
  blurbs?: string[];
}

// One configured craft slot (0 primary, 1 secondary, 2 tertiary); profession is null while the slot is empty
export interface MasterySlot {
  slot: number;
  name: string;
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
  cap: number;
  capName: string;
  // Hours for each rank indexed by rank, Free first
  rankHours: number[];
}

// The server's masteryMenu reply, rendered by the Personal Menu's Skills tab; the top-level fields are the primary's.
export interface MasteryInfo {
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  resetsLeft: number;
  professions: Profession[];
  // Empty from a server without craft slots
  slots: MasterySlot[];
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const parseSlots = (raw: unknown): MasterySlot[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s === "object" && Number.isInteger(s["slot"])).map((s: Record<string, unknown>) => ({
    slot: s["slot"] as number,
    name: text(s["name"]),
    profession: text(s["profession"]) || null,
    label: text(s["label"]),
    rank: Number(s["rank"]) || 0,
    rankName: text(s["rankName"]),
    hours: Number(s["hours"]) || 0,
    cap: Number(s["cap"]) || 0,
    capName: text(s["capName"]),
    rankHours: Array.isArray(s["rankHours"]) ? (s["rankHours"] as unknown[]).map((h) => Number(h) || 0) : [],
  }));
};

export function parseMasteryMenu(content: Record<string, unknown>): MasteryInfo {
  const professions = Array.isArray(content["professions"]) ? content["professions"] : [];
  const rankHours = Array.isArray(content["rankHours"]) ? content["rankHours"] : [];
  return {
    profession: typeof content["profession"] === "string" ? content["profession"] as string : null,
    rank: Number(content["rank"]) || 0,
    hours: Number(content["hours"]) || 0,
    rankHours: rankHours as number[],
    resetsLeft: Number(content["resetsLeft"]) || 0,
    professions: professions as Profession[],
    slots: parseSlots(content["slots"]),
  };
}

/**
 * Mastery: a primary profession per character, and a secondary and a tertiary
 * craft when the server configures craft slots, ranked by time played. There is
 * no key and no standalone screen; the Personal Menu's Skills tab
 * (AdminMenuService) requests masteryMenu, renders it with parseMasteryMenu
 * and sends the choices. This service shows the server's feedback.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "masteryInfoRequest" }
 *   Server -> Client: { "customPacketType": "masteryMenu", "profession", "rank",
 *                       "hours", "rankHours", "resetsLeft", "professions", "slots" }
 *   Client -> Server: { "customPacketType": "masteryChoose", "profession", "slot"? }
 *   Client -> Server: { "customPacketType": "masteryResetRequest", "profession"? }
 *   Server -> Client: { "customPacketType": "masteryNotice", "text" }
 *   Server -> Client: { "customPacketType": "professionState", "profession", "rank",
 *                       "rankName", "hours", "skills": { <av>: level }, "magicka", "slots" }
 *   skills and magicka already fold in every slot, so applyState reads no slot.
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
    if (content && content["customPacketType"] === "professionState") {
      const skills = parseSkills(content["skills"]);
      const magicka = typeof content["magicka"] === "number" ? content["magicka"] as number : null;
      this.controller.once("update", () => this.applyState(skills, magicka));
    }
  }

  // setActorValue writes the base value without the skill level-up notification
  private applyState(skills: Record<string, number>, magicka: number | null): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    for (const av of Object.keys(skills)) {
      if (player.getBaseActorValue(av) !== skills[av]) player.setActorValue(av, skills[av]);
    }
    if (magicka !== null && player.getBaseActorValue("Magicka") !== magicka) player.setActorValue("Magicka", magicka);
  }
}

const parseSkills = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [av, level] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[A-Za-z]+$/.test(av) && typeof level === "number" && isFinite(level)) out[av] = level;
  }
  return out;
};
