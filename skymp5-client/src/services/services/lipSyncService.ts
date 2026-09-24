import { Actor, BrowserMessageEvent, Game } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { RemoteServer } from "./remoteServer";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { FormView } from "../../view/formView";
import { logError, logToPlatformLog, logTrace } from "../../logging";

// Drives Actor.setExpressionPhoneme from the front's voice::speaking reports, contract in docs/alduinak_voice_chat.md

const TICK_MS = 90;
const REPORT_TTL_MS = 600;
const PLAYER_FORM_ID = 0x14;
// The own face is unseen in first person and while the camera moves between views
const FIRST_PERSON_CAMERA = 0;
const TRANSITION_CAMERA = 6;
// Open-mouth phoneme slots of Actor.setExpressionPhoneme: Aah, BigAah, Eee, Eh, I, Oh, OohQ
const MOUTH_PHONEMES = [0, 1, 5, 6, 8, 11, 12];
// SKSE runs each expression native as a task from a 10-slot pool refilled once per frame and drops the rest silently, so an update hands it at most this many
const MAX_WRITES_PER_UPDATE = 8;
// A queue deeper than this when an update starts is logged once
const QUEUE_LOG_DEPTH = 10;
// A face that stops talking is reset again after this, once any blend toward the last shape has settled
const RESET_REPEAT_MS = 400;
// Bridges LiveKit's gaps between words so the name tag glyph does not flicker
const SPEAKING_HOLD_MS = 500;
// A face this service wrote is closed again once a second after its mouth left, this many times, then trusted shut
const SWEEP_MS = 1000;
const SWEEP_CLOSES = 3;
// One visible copy face without a talk report is zeroed this often, in turn, whatever wrote to it
const SWEEP_ALL_MS = 1500;
const FIRST_DYNAMIC_REMOTE_ID = 0xff000000;
// A mouth the report keeps at level 0 this long is a lingering report, logged once
const LINGER_MS = 5000;
// A report entry with no local actor this long is logged once
const UNMAPPED_MS = 2000;

interface Mouth {
  localId: number;
  phoneme: number;
  level: number;
  // When the level fell to 0, 0 while it is above
  zeroSince: number;
  lingerLogged: boolean;
}

// A face this service wrote to; the sweep re-closes it until it is trusted shut
interface Touched {
  remoteId: number;
  lastWriteAt: number;
  closes: number;
}

// One expression native waiting for a frame with room, run on the actor resolved then
interface Write {
  localId: number;
  what: string;
  run: (actor: Actor) => void;
}

export class LipSyncService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("connectionAccepted", () => this.reset());
    this.controller.emitter.on("connectionFailed", () => this.reset());
    this.controller.emitter.on("connectionDenied", () => this.reset());
    this.controller.emitter.on("gameLoad", () => this.reset());
  }

  // remote actor id -> animated mouth
  private mouths = new Map<number, Mouth>();
  private pending: Map<number, number> | undefined;
  // remote ids the front reported stopped, closed on the next update
  private stopped = new Set<number>();
  private lastReportAt = 0;
  private nextTickAt = 0;
  private nextSweepAt = 0;
  private nextSweepAllAt = 0;
  private sweepAllCursor = 0;
  // Natives not yet handed to SKSE, closes at the front
  private writes: Write[] = [];
  private playerFaceOpen = false;
  private playerCloseOwed = false;
  // local id -> when its face gets the repeated reset
  private resetsDue = new Map<number, number>();
  // local id -> face this service wrote to
  private touched = new Map<number, Touched>();
  private wasFirstPerson = false;
  private lastCellId = 0;
  // remote id -> since when the report names it without a local actor
  private unmapped = new Map<number, number>();
  // ids already logged this session, one line each
  private unmappedLogged = new Set<number>();
  // log keys such as "<kind>:<local id>" already written this session, one line each
  private failedLogged = new Set<string>();

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const kind = e.arguments[0];
    if (kind === "voice::stopped") {
      const id = parseInt(String(e.arguments[1] ?? ""), 16);
      if (Number.isFinite(id) && id > 0) this.stopped.add(id);
      return;
    }
    if (kind !== "voice::speaking") return;
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

  // Every mouth closes and every face this service wrote is re-closed by the next sweep
  private reset(): void {
    this.pending = new Map();
    this.writes = [];
    this.touched.forEach((face) => { face.closes = 0; });
    this.nextSweepAt = 0;
    this.nextSweepAllAt = 0;
    this.unmapped.clear();
    this.unmappedLogged.clear();
    this.failedLogged.clear();
  }

  private onUpdate(): void {
    try {
      const now = Date.now();
      this.drainWrites();
      if (this.pending) {
        const report = this.pending;
        this.pending = undefined;
        this.lastReportAt = now;
        this.reconcile(report, now);
      } else if (this.mouths.size > 0 && now - this.lastReportAt > REPORT_TTL_MS) {
        this.reconcile(new Map(), now);
      }
      if (this.stopped.size > 0) this.applyStopped();
      if (now >= this.nextSweepAt) {
        this.nextSweepAt = now + SWEEP_MS;
        this.sweep(now);
      }
      if (now >= this.nextSweepAllAt) {
        this.nextSweepAllAt = now + SWEEP_ALL_MS;
        this.sweepAll();
      }
      if (now < this.nextTickAt || (this.mouths.size === 0 && !this.playerCloseOwed && this.resetsDue.size === 0)) return;
      this.nextTickAt = now + TICK_MS;
      if (this.playerCloseOwed && !this.isFirstPerson()) {
        logToPlatformLog(this, "owed player close in third person");
        this.closeFace(PLAYER_FORM_ID);
      }
      this.mouths.forEach((mouth, remoteId) => this.animate(remoteId, mouth));
      this.runDueResets(now);
    } catch (err) {
      logError(this, `onUpdate failed: ${err}`);
    }
  }

  private reconcile(report: Map<number, number>, now: number): void {
    this.markSpeakers(report);
    this.mouths.forEach((mouth, remoteId) => {
      if (report.has(remoteId)) return;
      this.closeFace(mouth.localId, mouth.phoneme);
      this.mouths.delete(remoteId);
    });
    this.unmapped.forEach((_since, remoteId) => {
      if (!report.has(remoteId)) this.unmapped.delete(remoteId);
    });
    report.forEach((level, remoteId) => {
      const existing = this.mouths.get(remoteId);
      if (existing) {
        existing.level = level;
        if (level > 0) existing.zeroSince = 0;
        else if (!existing.zeroSince) existing.zeroSince = now;
        else if (!existing.lingerLogged && now - existing.zeroSince > LINGER_MS) {
          existing.lingerLogged = true;
          logToPlatformLog(this, `report keeps ${remoteId.toString(16)} at level 0 for over ${LINGER_MS} ms`);
        }
        return;
      }
      const localId = this.localIdFor(remoteId);
      if (!localId) {
        this.noteUnmapped(remoteId, now);
        return;
      }
      this.unmapped.delete(remoteId);
      this.mouths.set(remoteId, { localId, phoneme: -1, level, zeroSince: 0, lingerLogged: false });
      logTrace(this, `lips on for ${remoteId.toString(16)}`);
    });
  }

  // A talker with no copy on this client is normal out of range; one that lasts is logged once
  private noteUnmapped(remoteId: number, now: number): void {
    const since = this.unmapped.get(remoteId) ?? now;
    this.unmapped.set(remoteId, since);
    if (now - since > UNMAPPED_MS && !this.unmappedLogged.has(remoteId)) {
      this.unmappedLogged.add(remoteId);
      logToPlatformLog(this, `report names ${remoteId.toString(16)} with no local actor for over ${UNMAPPED_MS} ms`);
    }
  }

  // The front's explicit stop closes the mouth without waiting for the next report
  private applyStopped(): void {
    this.stopped.forEach((remoteId) => {
      const mouth = this.mouths.get(remoteId);
      if (!mouth) return;
      this.mouths.delete(remoteId);
      this.closeFace(mouth.localId, mouth.phoneme);
      logTrace(this, `voice stopped for ${remoteId.toString(16)}`);
    });
    this.stopped.clear();
  }

  // A face whose mouth is gone is closed again until trusted shut; a cell change or a camera flip re-closes every face written, a copy re-created under a new id is closed there instead, and a gone actor is forgotten after one close
  private sweep(now: number): void {
    const firstPerson = this.isFirstPerson();
    const cellId = Game.getPlayer()?.getParentCell()?.getFormID() ?? 0;
    const all = firstPerson !== this.wasFirstPerson || cellId !== this.lastCellId;
    this.wasFirstPerson = firstPerson;
    this.lastCellId = cellId;
    this.touched.forEach((face, localId) => {
      const present = !!this.actorOf(localId);
      const current = this.localIdFor(face.remoteId);
      if (current !== localId) {
        this.touched.delete(localId);
        if (current) this.touched.set(current, { ...face, closes: 0 });
        if (present) this.closeFace(localId);
        logToPlatformLog(this, `copy of ${face.remoteId.toString(16)} changed ${localId.toString(16)} -> ${current.toString(16)}, old actor ${present ? "present" : "gone"}`);
        return;
      }
      if (all) face.closes = 0;
      if (Array.from(this.mouths.values()).some((mouth) => mouth.localId === localId)) return;
      if (face.closes >= SWEEP_CLOSES || !present && face.closes > 0) {
        this.touched.delete(localId);
        return;
      }
      face.closes++;
      this.closeFace(localId);
      if (face.closes === 1) {
        logToPlatformLog(this, `sweep re-close ${localId.toString(16)} ${now - face.lastWriteAt} ms after the last write, actor ${present ? "present" : "gone"}, ${firstPerson ? "first" : "third"} person${all ? ", all faces" : ""}`);
      }
    });
  }

  // One visible copy of a player without a mouth of its own is zeroed per call, round robin, whatever wrote to it; the own face is in the round outside first person
  private sweepAll(): void {
    const open = new Set(Array.from(this.mouths.values()).map((mouth) => mouth.localId));
    const ids = this.isFirstPerson() ? [] : [PLAYER_FORM_ID];
    for (const form of this.controller.lookupListener(RemoteServer).getWorldModel().forms) {
      if (!form || form.isMyClone || !form.appearance || (form.refrId ?? 0) < FIRST_DYNAMIC_REMOTE_ID) continue;
      const localId = remoteIdToLocalId(form.refrId!);
      if (localId) ids.push(localId);
    }
    const faces = ids.filter((localId) => !open.has(localId) && this.actorOf(localId)?.is3DLoaded());
    if (faces.length === 0) return;
    const localId = faces[this.sweepAllCursor++ % faces.length];
    MOUTH_PHONEMES.forEach((phoneme) => this.enqueue(localId, "close", (actor) => actor.setExpressionPhoneme(phoneme, 0)));
  }

  private enqueue(localId: number, what: string, run: (actor: Actor) => void): void {
    this.writes.push({ localId, what, run });
  }

  // Hands SKSE at most a pool's worth per frame, the actor resolved at that moment
  private drainWrites(): void {
    if (this.writes.length > QUEUE_LOG_DEPTH) {
      this.logOnce("queue", `expression writes queued ${this.writes.length}, draining ${MAX_WRITES_PER_UPDATE} per frame`);
    }
    for (const write of this.writes.splice(0, MAX_WRITES_PER_UPDATE)) {
      const actor = this.actorOf(write.localId);
      if (!actor) {
        this.logOnce(`${write.what}:${write.localId}:gone`, `${write.what} ${write.localId.toString(16)}: no actor`);
        continue;
      }
      this.guarded(write.localId, write.what, () => write.run(actor));
    }
  }

  // A native that throws on one face must not cost the others their tick; logged once per face and kind
  private guarded(localId: number, what: string, work: () => void): void {
    try {
      work();
    } catch (err) {
      this.logOnce(`${what}:${localId}`, `${what} failed ${localId.toString(16)}: ${err}`);
    }
  }

  private logOnce(key: string, text: string): void {
    if (this.failedLogged.has(key)) return;
    this.failedLogged.add(key);
    logToPlatformLog(this, text);
  }

  private markSpeakers(report: Map<number, number>): void {
    const now = Date.now();
    const me = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId();
    FormView.speakingUntil.forEach((until, remoteId) => {
      if (until <= now) FormView.speakingUntil.delete(remoteId);
    });
    report.forEach((_level, remoteId) => {
      if (remoteId !== me) FormView.speakingUntil.set(remoteId, now + SPEAKING_HOLD_MS);
    });
  }

  private localIdFor(remoteId: number): number {
    const me = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId();
    if (remoteId === me) return PLAYER_FORM_ID;
    return remoteIdToLocalId(remoteId);
  }

  private actorOf(localId: number): Actor | null {
    return Actor.from(Game.getFormEx(localId));
  }

  private isFirstPerson(): boolean {
    const state = this.sp.Game.getCameraState();
    return state === FIRST_PERSON_CAMERA || state === TRANSITION_CAMERA;
  }

  private animate(remoteId: number, mouth: Mouth): void {
    if (!this.actorOf(mouth.localId)) {
      // Clone despawned mid-sentence; the next report re-adds it if it comes back
      this.resetsDue.set(mouth.localId, Date.now() + RESET_REPEAT_MS);
      this.mouths.delete(remoteId);
      return;
    }
    const previous = mouth.phoneme;
    if (previous >= 0) this.enqueue(mouth.localId, "phoneme write", (actor) => actor.setExpressionPhoneme(previous, 0));
    // A clone can respawn under a new local id while still speaking
    const localId = this.localIdFor(remoteId);
    if (localId && localId !== mouth.localId) {
      this.closeFace(mouth.localId, previous);
      mouth.localId = localId;
      mouth.phoneme = -1;
      return;
    }
    // Own mouth is invisible in first person
    if (mouth.localId === PLAYER_FORM_ID && this.isFirstPerson()) {
      if (mouth.phoneme >= 0) this.playerCloseOwed = true;
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
    const phoneme = MOUTH_PHONEMES[Math.floor(Math.random() * MOUTH_PHONEMES.length)];
    mouth.phoneme = phoneme;
    this.enqueue(mouth.localId, "phoneme write", (actor) => actor.setExpressionPhoneme(phoneme, strength));
    this.touched.set(mouth.localId, { remoteId, lastWriteAt: Date.now(), closes: 0 });
    if (mouth.localId === PLAYER_FORM_ID) this.playerFaceOpen = true;
  }

  // Zeroes the slot known open, or every slot this service opens, and resets the face, ahead of anything else queued; an open player face is redone after first person, where the write may miss the body's face
  private closeFace(localId: number, lastPhoneme = -1): void {
    if (localId === PLAYER_FORM_ID) this.playerFaceOpen = this.playerCloseOwed = this.playerFaceOpen && this.isFirstPerson();
    this.resetsDue.set(localId, Date.now() + RESET_REPEAT_MS);
    // A queued animation write for this face never landed, so which slots are open is unknown
    const dropped = this.writes.some((write) => write.localId === localId && write.what === "phoneme write");
    this.writes = this.writes.filter((write) => write.localId !== localId);
    const slots = lastPhoneme >= 0 && !dropped ? [lastPhoneme] : MOUTH_PHONEMES;
    this.writes.unshift(
      ...slots.map((phoneme): Write => ({ localId, what: "close", run: (actor) => actor.setExpressionPhoneme(phoneme, 0) })),
      { localId, what: "close", run: (actor) => actor.resetExpressionOverrides() },
    );
  }

  // A face that started talking again is left to the animation, a gone one to the sweep
  private runDueResets(now: number): void {
    this.resetsDue.forEach((dueAt, localId) => {
      if (now < dueAt) return;
      this.resetsDue.delete(localId);
      if (Array.from(this.mouths.values()).some((mouth) => mouth.localId === localId)) return;
      if (!this.actorOf(localId)) return;
      this.enqueue(localId, "reset", (actor) => actor.resetExpressionOverrides());
    });
  }
}
