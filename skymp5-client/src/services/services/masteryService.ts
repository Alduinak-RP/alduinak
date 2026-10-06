import { ClientListener, CombinedController, Sp } from "./clientListener";
import { notifyNextUpdate, CustomPacketContent, onCustomPacket } from "./customPacketUtil";

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

// The character's hour clock and shared bank (masterySystem.ts BankSummary); times are ms left when the packet arrived
export interface MasteryBank {
  // Bank places
  max: number;
  intervalMs: number;
  // The pay clock also runs while logged out
  offline: boolean;
  // Until work counts an hour again, 0 when it counts now
  countedMs: number;
  // Profession of the hour counting now, null when none is
  counted: string | null;
  // Until the first banked hour is counted, 0 with none banked
  payMs: number;
  // The profession each banked hour pays, in pay order
  queue: string[];
  // Local epoch ms the packet arrived, the mark its countdowns run from
  at: number;
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
  // Null from a server that sends none
  bank: MasteryBank | null;
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

const parseBank = (raw: unknown): MasteryBank | null => {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const queue = Array.isArray(b["queue"]) ? b["queue"] : [];
  return {
    max: Number(b["max"]) || 0,
    intervalMs: Number(b["intervalMs"]) || 0,
    offline: b["offline"] === true,
    countedMs: Number(b["countedMs"]) || 0,
    counted: text(b["counted"]) || null,
    payMs: Number(b["payMs"]) || 0,
    queue: queue.filter((p): p is string => typeof p === "string" && !!p),
    at: Date.now(),
  };
};

// The primary's fields, the same in masteryMenu and professionState
const parsePrimary = (content: Record<string, unknown>) => ({
  profession: typeof content["profession"] === "string" ? content["profession"] as string : null,
  rank: Number(content["rank"]) || 0,
  hours: Number(content["hours"]) || 0,
});

export function parseMasteryMenu(content: Record<string, unknown>): MasteryInfo {
  const professions = Array.isArray(content["professions"]) ? content["professions"] : [];
  const rankHours = Array.isArray(content["rankHours"]) ? content["rankHours"] : [];
  return {
    ...parsePrimary(content),
    rankHours: rankHours as number[],
    resetsLeft: Number(content["resetsLeft"]) || 0,
    professions: professions as Profession[],
    slots: parseSlots(content["slots"]),
    bank: parseBank(content["bank"]),
  };
}

// A professionState laid over the open menu: the hours, ranks and bank it carries
export function applyProfessionState(info: MasteryInfo, content: Record<string, unknown>): MasteryInfo {
  const slots = parseSlots(content["slots"]);
  return { ...info, ...parsePrimary(content), slots: slots.length ? slots : info.slots, bank: parseBank(content["bank"]) || info.bank };
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
 *                       "hours", "rankHours", "resetsLeft", "professions", "slots", "bank" }
 *   Client -> Server: { "customPacketType": "masteryChoose", "profession", "slot"? }
 *   Client -> Server: { "customPacketType": "masteryResetRequest", "profession"? }
 *   Server -> Client: { "customPacketType": "masteryNotice", "text" }
 *   Server -> Client: { "customPacketType": "professionState", "profession", "rank",
 *                       "rankName", "hours", "skills": { <av>: level }, "magicka", "slots", "bank" }
 *   skills and magicka already fold in every slot, so applyState reads no slot.
 *   bank is the character's hour clock and the banked hours in pay order; a professionState
 *   follows every counted or banked hour, and AdminMenuService lays it over an open Skills tab.
 */
export class MasteryService extends ClientListener {
  // The base Magicka applyState last wrote since the player's spawn, null when it wrote none; the racialReport carries it
  writtenMagicka: number | null = null;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    onCustomPacket(this.controller, ["masteryNotice", "professionState"], (content) => this.onCustomPacketMessage(content));
    // A spawn loads base values afresh
    this.controller.emitter.on("createActorMessage", (e) => { if (e.message.isMe) this.writtenMagicka = null; });
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (content["customPacketType"] === "masteryNotice" && typeof content["text"] === "string") {
      notifyNextUpdate(this.controller, this.sp, content["text"]);
    }
    if (content["customPacketType"] === "professionState") {
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
    if (magicka === null) return;
    if (player.getBaseActorValue("Magicka") !== magicka) player.setActorValue("Magicka", magicka);
    this.writtenMagicka = magicka;
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
