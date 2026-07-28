import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { readMenuKeyCode } from "./widgetMenuUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { RemoteServer } from "./remoteServer";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";

// Proximity voice chat: push-to-talk (default V, launcher-configurable via
// voicePushToTalkKeyCode) + LiveKit room managed by the CEF page (VoiceManager
// in skymp5-front). This service owns the game-side halves: requesting the
// room token from the server, feeding peer distances to the browser, and the
// PTT key. Who is audible is decided by distance against the server-provided
// range (chat "say" range by default), same-world only.

const PEERS_INTERVAL_MS = 400;
const TOKEN_RETRY_MS = 5000;
const PLAYER_ID_SPACE = 0xff000000;

// Mouse wheel arrives as buttonEvent with device Mouse and these id codes
const MOUSE_WHEEL_UP = 8;
const MOUSE_WHEEL_DOWN = 9;
const RANGE_STEP = 1.25; // multiplicative per wheel notch
const RANGE_PERSIST_DELAY_MS = 1000;
const VOICE_SETTINGS_PLUGIN = "voice-settings-no-load";

export class VoiceService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.voiceKey = readMenuKeyCode(sp, "voicePushToTalkKeyCode", DxScanCode.V);
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
    // Fresh game connection = fresh voice session; also kills ghost rooms
    // that would otherwise outlive a disconnect back to the main menu
    this.controller.emitter.on("connectionAccepted", () => this.resetSession());
    this.controller.emitter.on("connectionFailed", () => this.resetSession());
    this.controller.emitter.on("connectionDenied", () => this.resetSession());
  }

  private voiceKey: DxScanCode;
  private disabledByServer = false;
  private connectedForRefrId = 0;
  private pendingRefrId = 0;
  private rangeUnits = 2000;
  private minRangeUnits = 150;
  private maxRangeUnits = 10000;
  private tiers: unknown[] = [];
  private talkRange = 0; // 0 = not yet initialized from settings/packet
  private rangePersistAt = 0;
  private pttDown = false;
  private micDeniedShown = false;
  private nextTokenAttemptAt = 0;
  private nextPeersAt = 0;

  // A throw here would abort the shared event dispatch chain and take input
  // and movement processing down with it; voice must never do that
  private onButtonEvent(e: ButtonEvent) {
    try {
      this.onButtonEventImpl(e);
    } catch (err) {
      logTrace(this, `onButtonEvent failed: ${err}`);
    }
  }

  private onButtonEventImpl(e: ButtonEvent) {
    // V + mousewheel adjusts the talk range (whisper..shout); talkRange 0
    // means not initialized yet, adjusting then would clobber the saved value
    if (this.pttDown && this.talkRange > 0 && e.device === InputDeviceType.Mouse && e.isDown &&
        ((e.code as number) === MOUSE_WHEEL_UP || (e.code as number) === MOUSE_WHEEL_DOWN)) {
      const factor = (e.code as number) === MOUSE_WHEEL_UP ? RANGE_STEP : 1 / RANGE_STEP;
      this.applyTalkRange(this.talkRange * factor);
      return;
    }
    if (e.device !== InputDeviceType.Keyboard || e.code !== this.voiceKey) return;
    if (e.isDown && !this.pttDown) {
      if (this.sp.browser.isFocused()) return; // typing in chat
      this.pttDown = true;
      this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.setPtt(true)`);
    } else if (e.isUp && this.pttDown) {
      this.releasePtt();
    }
  }

  private applyTalkRange(units: number) {
    const clamped = Math.min(this.maxRangeUnits, Math.max(this.minRangeUnits, Math.round(units)));
    if (clamped === this.talkRange) return;
    this.talkRange = clamped;
    this.rangePersistAt = Date.now() + RANGE_PERSIST_DELAY_MS;
    this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.setTalkRange(${clamped})`);
  }

  // Chosen range survives relaunches, same mechanism as chat settings
  private readPersistedRange(): number {
    try {
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(VOICE_SETTINGS_PLUGIN, "PluginsNoLoad");
      if (!data) return 0;
      const parsed = JSON.parse(data.slice(2));
      const r = Number(parsed?.talkRange);
      return Number.isFinite(r) && r > 0 ? r : 0;
    } catch (e) {
      return 0;
    }
  }

  private persistRange(): void {
    try {
      this.sp.writePlugin(
        VOICE_SETTINGS_PLUGIN,
        "//" + JSON.stringify({ talkRange: this.talkRange }),
        // @ts-expect-error (TODO: Remove in 2.10.0)
        "PluginsNoLoad"
      );
    } catch (e) { }
  }

  private releasePtt() {
    this.pttDown = false;
    this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.setPtt(false)`);
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const kind = e.arguments[0];
    if (kind === "voice::ready") {
      // Only the front's ack marks the session healthy; a connect call that
      // lands on an unloaded page simply never acks and the 5s loop retries
      this.connectedForRefrId = this.pendingRefrId;
    } else if (kind === "voice::micDenied") {
      if (!this.micDeniedShown) {
        this.micDeniedShown = true;
        this.controller.once("update", () => {
          showSystemNotification(this.sp, "Voice: microphone unavailable");
        });
      }
    } else if (kind === "voice::error") {
      // Room dropped: forget the session and ask for a fresh token shortly
      this.connectedForRefrId = 0;
      this.nextTokenAttemptAt = Date.now() + TOKEN_RETRY_MS;
      logTrace(this, `voice error from front: ${e.arguments[1]}`);
    }
  }

  private resetSession() {
    if (this.pttDown) this.releasePtt();
    this.connectedForRefrId = 0;
    this.pendingRefrId = 0;
    this.disabledByServer = false;
    this.nextTokenAttemptAt = 0;
    this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.disconnect()`);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] !== "voiceToken") return;

    if (content["enabled"] !== true) {
      this.disabledByServer = true;
      logTrace(this, "voice disabled by server");
      return;
    }
    const url = content["url"];
    const token = content["token"];
    if (typeof url !== "string" || typeof token !== "string") return;
    const num = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    this.rangeUnits = num(content["rangeUnits"], this.rangeUnits);
    this.minRangeUnits = num(content["minRangeUnits"], this.minRangeUnits);
    this.maxRangeUnits = num(content["maxRangeUnits"], this.maxRangeUnits);
    if (Array.isArray(content["tiers"])) this.tiers = content["tiers"];
    if (!this.talkRange) {
      const persisted = this.readPersistedRange();
      this.talkRange = Math.min(this.maxRangeUnits, Math.max(this.minRangeUnits, persisted || this.rangeUnits));
    }

    const cfg = {
      talk: this.talkRange,
      min: this.minRangeUnits,
      max: this.maxRangeUnits,
      def: this.rangeUnits,
      tiers: this.tiers,
    };
    this.pendingRefrId = this.myRefrId();
    this.sp.browser.executeJavaScript(
      `window.__alduinakVoice && window.__alduinakVoice.connect(${JSON.stringify(url)}, ${JSON.stringify(token)}, ${JSON.stringify(cfg)})`
    );
  }

  private myRefrId(): number {
    return this.controller.lookupListener(RemoteServer).getMyRemoteRefrId();
  }

  private onUpdate() {
    try {
      this.onUpdateImpl();
    } catch (err) {
      logTrace(this, `onUpdate failed: ${err}`);
    }
  }

  private onUpdateImpl() {
    if (this.disabledByServer) return;
    const now = Date.now();
    const myRefr = this.myRefrId();

    // Chat focus steals the key-up event, so drop the mic when typing starts;
    // same when our actor despawns (character park, connection loss)
    if (this.pttDown && (this.sp.browser.isFocused() || !myRefr)) this.releasePtt();

    // Write the chosen range to disk once the wheel settles
    if (this.rangePersistAt && now >= this.rangePersistAt) {
      this.rangePersistAt = 0;
      this.persistRange();
    }

    if (!myRefr) return; // not spawned yet

    // New character/actor (or a dropped room): (re)request a token
    if (this.connectedForRefrId !== myRefr && now >= this.nextTokenAttemptAt) {
      this.nextTokenAttemptAt = now + TOKEN_RETRY_MS;
      sendCustomPacket(this.controller, { customPacketType: "voiceTokenRequest" });
      return;
    }

    if (this.connectedForRefrId === myRefr && now >= this.nextPeersAt) {
      this.nextPeersAt = now + PEERS_INTERVAL_MS;
      this.pushPeers();
    }
  }

  // Distances in game units keyed by refrId hex = the LiveKit identity scheme
  private pushPeers() {
    const worldModel = this.controller.lookupListener(RemoteServer).getWorldModel();
    if (!worldModel || !Array.isArray(worldModel.forms)) return;
    const me = worldModel.forms[worldModel.playerCharacterFormIdx];
    const myMovement = me?.movement;
    if (!myMovement || !Array.isArray(myMovement.pos)) return;

    // Speakers choose their own range up to the max, so feed distances out to
    // the max tier: a shouter 9000 units away must still be audible
    const includeWithin = this.maxRangeUnits * 1.2;
    const peers: Record<string, number> = {};
    for (let i = 0; i < worldModel.forms.length; i++) {
      if (i === worldModel.playerCharacterFormIdx) continue;
      const form = worldModel.forms[i];
      if (!form || typeof form.refrId !== "number" || form.refrId < PLAYER_ID_SPACE) continue;
      if (!form.appearance || !form.movement || !Array.isArray(form.movement.pos)) continue;
      if (form.movement.worldOrCell !== myMovement.worldOrCell) continue;
      const dx = form.movement.pos[0] - myMovement.pos[0];
      const dy = form.movement.pos[1] - myMovement.pos[1];
      const dz = form.movement.pos[2] - myMovement.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= includeWithin) peers[form.refrId.toString(16)] = Math.round(dist);
    }
    this.sp.browser.executeJavaScript(
      `window.__alduinakVoice && window.__alduinakVoice.setPeers(${JSON.stringify(peers)})`
    );
  }
}
