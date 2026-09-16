import { ButtonEvent, DxScanCode } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { MountService } from "./mountService";

// Letter rows by their first scan code; no target means no vanilla key glyph, so the offer names the Activate key itself
const KEY_ROWS: Array<[number, string]> = [[DxScanCode.Q, "QWERTYUIOP"], [DxScanCode.A, "ASDFGHJKL"], [DxScanCode.Z, "ZXCVBNM"]];

interface JobOffer {
  job: string;
  verb: string;
  label: string;
}

// Client side of passive jobs (server jobSystem.ts, docs/docs_roleplay_jobs.md); the pose itself arrives as RestraintService's carryState.
//   Server -> Client: { customPacketType: "jobPrompt", job, verb, label }  job "" withdraws the offer
//                     { customPacketType: "jobState", carrying, title }
//   Client -> Server: { customPacketType: "jobStart", job }
//                     { customPacketType: "jobPutDown" }
export class JobService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.emitter.on("connectionDisconnect", () => {
      this.offer = null;
      this.loadTitle = "";
      this.offerVersion++;
    });
  }

  // The offer as one line, "[E] Carry hay (10 gold)", null without one or while riding
  get prompt(): { verb: string; label: string; line: boolean } | null {
    if (!this.offer || this.controller.lookupListener(MountService).isMounted) return null;
    const key = this.activateKey();
    const text = this.offer.label ? `${this.offer.verb} (${this.offer.label})` : this.offer.verb;
    return { verb: key ? `[${key}] ${text}` : text, label: "", line: true };
  }

  // Bumped whenever the offer changes, so the prompt refreshes without a crosshair change
  get promptVersion(): number {
    return this.offerVersion;
  }

  // The carried load and where it goes, "" when not on a trip
  get load(): string {
    return this.loadTitle;
  }

  putDown(): void {
    sendCustomPacket(this.controller, { customPacketType: "jobPutDown" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    if (content["customPacketType"] === "jobPrompt") {
      const job = typeof content["job"] === "string" ? content["job"] : "";
      this.offer = job ? { job, verb: String(content["verb"] ?? ""), label: String(content["label"] ?? "") } : null;
      this.offerVersion++;
    } else if (content["customPacketType"] === "jobState") {
      this.loadTitle = content["carrying"] === true && typeof content["title"] === "string" ? content["title"] : "";
    }
  }

  // Activate takes the work only while the offer is what the prompt shows: nothing under the crosshair
  private onButtonEvent(e: ButtonEvent): void {
    const offer = this.offer;
    if (!e.isDown || e.userEventName !== "Activate" || !offer || !this.prompt) return;
    if (isMenuHotkeyBlocked(this.sp, this.controller) || this.sp.Game.getCurrentCrosshairRef()) return;
    sendCustomPacket(this.controller, { customPacketType: "jobStart", job: offer.job });
  }

  // Keyboard binding of Activate as a letter, "" when it is bound elsewhere
  private activateKey(): string {
    try {
      const code = this.sp.Input.getMappedKey("Activate", 0);
      const row = KEY_ROWS.find(([first, keys]) => code >= first && code < first + keys.length);
      return row ? row[1].charAt(code - row[0]) : "";
    } catch {
      return "";
    }
  }

  private offer: JobOffer | null = null;
  private offerVersion = 0;
  private loadTitle = "";
}
