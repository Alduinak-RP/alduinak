import { Actor, BrowserMessageEvent, Game } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { RemoteServer } from "./remoteServer";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { logError, logTrace } from "../../logging";

// Drives Actor.setExpressionPhoneme from the front's voice::speaking reports, contract in docs/alduinak_voice_chat.md

const TICK_MS = 90;
const REPORT_TTL_MS = 600;
const PLAYER_FORM_ID = 0x14;
const FIRST_PERSON_CAMERA = 0;
// Open-mouth phoneme slots of Actor.setExpressionPhoneme: Aah, BigAah, Eee, Eh, I, Oh, OohQ
const MOUTH_PHONEMES = [0, 1, 5, 6, 8, 11, 12];

interface Mouth {
  localId: number;
  phoneme: number;
  level: number;
}

export class LipSyncService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("connectionAccepted", () => this.reset());
    this.controller.emitter.on("connectionFailed", () => this.reset());
    this.controller.emitter.on("connectionDenied", () => this.reset());
  }

  // remote actor id -> animated mouth
  private mouths = new Map<number, Mouth>();
  private pending: Map<number, number> | undefined;
  private lastReportAt = 0;
  private nextTickAt = 0;

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] !== "voice::speaking") return;
    try {
      const raw = JSON.parse(String(e.arguments[1] ?? "[]"));
      const report = new Map<number, number>();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const id = parseInt(String(entry?.id ?? entry), 16);
          const level = Number(entry?.level);
          if (Number.isFinite(id) && id > 0) report.set(id, Number.isFinite(level) ? level : 0);
        }
      }
      // Applied on the next update, natives throw in the browser message context
      this.pending = report;
    } catch (err) {
      logError(this, `bad voice::speaking payload: ${err}`);
    }
  }

  private reset(): void {
    this.pending = new Map();
  }

  private onUpdate(): void {
    try {
      const now = Date.now();
      if (this.pending) {
        const report = this.pending;
        this.pending = undefined;
        this.lastReportAt = now;
        this.reconcile(report);
      } else if (this.mouths.size > 0 && now - this.lastReportAt > REPORT_TTL_MS) {
        this.reconcile(new Map());
      }
      if (now < this.nextTickAt || this.mouths.size === 0) return;
      this.nextTickAt = now + TICK_MS;
      this.mouths.forEach((mouth, remoteId) => this.animate(remoteId, mouth));
    } catch (err) {
      logError(this, `onUpdate failed: ${err}`);
    }
  }

  private reconcile(report: Map<number, number>): void {
    this.mouths.forEach((mouth, remoteId) => {
      if (report.has(remoteId)) return;
      this.closeMouth(mouth);
      this.mouths.delete(remoteId);
    });
    report.forEach((level, remoteId) => {
      const existing = this.mouths.get(remoteId);
      if (existing) {
        existing.level = level;
        return;
      }
      const localId = this.localIdFor(remoteId);
      if (!localId) return;
      this.mouths.set(remoteId, { localId, phoneme: -1, level });
      logTrace(this, `lips on for ${remoteId.toString(16)}`);
    });
  }

  private localIdFor(remoteId: number): number {
    const me = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId();
    if (remoteId === me) return PLAYER_FORM_ID;
    return remoteIdToLocalId(remoteId);
  }

  private actorOf(mouth: Mouth): Actor | null {
    return Actor.from(Game.getFormEx(mouth.localId));
  }

  private animate(remoteId: number, mouth: Mouth): void {
    const actor = this.actorOf(mouth);
    if (!actor) {
      // Clone despawned mid-sentence; the next report re-adds it if it comes back
      this.mouths.delete(remoteId);
      return;
    }
    if (mouth.phoneme >= 0) actor.setExpressionPhoneme(mouth.phoneme, 0);
    // A clone can respawn under a new local id while still speaking
    const localId = this.localIdFor(remoteId);
    if (localId && localId !== mouth.localId) {
      mouth.localId = localId;
      mouth.phoneme = -1;
      return;
    }
    // Own mouth is invisible in first person
    if (mouth.localId === PLAYER_FORM_ID && this.sp.Game.getCameraState() === FIRST_PERSON_CAMERA) {
      mouth.phoneme = -1;
      return;
    }
    // Short closed beats between shapes read as speech rather than a held yawn
    if (Math.random() < 0.2) {
      mouth.phoneme = -1;
      return;
    }
    // LiveKit audio levels sit around 0.05-0.3 for normal speech
    const strength = Math.min(0.9, 0.25 + mouth.level * 2.5) * (0.7 + Math.random() * 0.3);
    mouth.phoneme = MOUTH_PHONEMES[Math.floor(Math.random() * MOUTH_PHONEMES.length)];
    actor.setExpressionPhoneme(mouth.phoneme, strength);
  }

  private closeMouth(mouth: Mouth): void {
    if (mouth.phoneme < 0) return;
    try {
      this.actorOf(mouth)?.setExpressionPhoneme(mouth.phoneme, 0);
    } catch (err) {
      logTrace(this, `closeMouth failed: ${err}`);
    }
  }
}
