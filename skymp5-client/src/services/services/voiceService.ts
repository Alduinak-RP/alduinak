import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { readMenuKeyCode, isConsoleOpen } from "./widgetMenuUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { RemoteServer } from "./remoteServer";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";

// Proximity voice chat: push-to-talk (default V, launcher-configurable via voicePushToTalkKeyCode) + LiveKit room managed by VoiceManager in the skymp5-front CEF page.
// This service owns the game side: room token requests, peer distances to the browser, and the PTT key; audibility is distance vs the server-provided range (chat "say" range by default), same-world only.

const PEERS_INTERVAL_MS = 400;
const TOKEN_RETRY_MS = 5000;
const AFK_PING_INTERVAL_MS = 60000;
const PLAYER_ID_SPACE = 0xff000000;

const MODE_PERSIST_DELAY_MS = 1000;
const VOICE_SETTINGS_PLUGIN = "voice-settings-no-load";

interface VoiceMode { key: string; label: string; units: number }

// Fallbacks; the server sends the real list with the token
const DEFAULT_MODES: VoiceMode[] = [
  { key: "whisper", label: "Whisper", units: 140 },
  { key: "talk", label: "Talk", units: 840 },
  { key: "shout", label: "Shout", units: 3150 },
];

export class VoiceService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.voiceKey = readMenuKeyCode(sp, "voicePushToTalkKeyCode", DxScanCode.V);
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
    // Fresh game connection = fresh voice session; also kills ghost rooms that would outlive a disconnect back to the main menu
    this.controller.emitter.on("connectionAccepted", () => this.resetSession());
    this.controller.emitter.on("connectionFailed", () => this.resetSession());
    this.controller.emitter.on("connectionDenied", () => this.resetSession());
  }

  private voiceKey: DxScanCode;
  private disabledByServer = false;
  private connectedForRefrId = 0;
  private pendingRefrId = 0;
  private modes: VoiceMode[] = DEFAULT_MODES;
  private mode = "";        // "" = not yet initialized from settings/packet
  private modePersistAt = 0;
  private altDown = false;
  private pttDown = false;
  private micDeniedShown = false;
  private nextTokenAttemptAt = 0;
  private nextPeersAt = 0;
  private nextAfkPingAt = 0;

  // A throw here would abort the shared event dispatch chain, taking input and movement processing down with it; voice must never do that
  private onButtonEvent(e: ButtonEvent) {
    try {
      this.onButtonEventImpl(e);
    } catch (err) {
      logTrace(this, `onButtonEvent failed: ${err}`);
    }
  }

  private onButtonEventImpl(e: ButtonEvent) {
    if (e.device !== InputDeviceType.Keyboard) return;

    // Track Alt so Alt+V can mean "cycle mode" instead of "talk"
    if (e.code === DxScanCode.LeftAlt || e.code === DxScanCode.RightAlt) {
      if (e.isDown) this.altDown = true;
      else if (e.isUp) this.altDown = false;
      return;
    }
    if (e.code !== this.voiceKey) return;

    // isHeld frames let a V hold that outlives the Alt+V cycle start transmitting once Alt releases (isDown fires only on the press frame)
    if ((e.isDown || e.isHeld) && !this.pttDown) {
      // Typing in chat or the console must not open the mic; other menus may
      if (this.sp.browser.isFocused() || isConsoleOpen(this.sp)) return;
      if (this.altDown) {
        if (e.isDown) this.cycleMode();
        return;
      }
      this.pttDown = true;
      this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.setPtt(true)`);
      this.sendAfkPing();
    } else if (e.isUp && this.pttDown) {
      this.releasePtt();
    }
  }

  // Alt+V steps whisper -> talk -> shout -> whisper
  private cycleMode() {
    if (!this.mode) return; // not initialized yet
    const idx = this.modes.findIndex(m => m.key === this.mode);
    const next = this.modes[(idx + 1) % this.modes.length];
    if (!next) return;
    this.applyMode(next.key);
  }

  private applyMode(key: string) {
    if (!this.modes.some(m => m.key === key) || key === this.mode) return;
    this.mode = key;
    this.modePersistAt = Date.now() + MODE_PERSIST_DELAY_MS;
    this.sp.browser.executeJavaScript(
      `window.__alduinakVoice && window.__alduinakVoice.setMode(${JSON.stringify(key)})`
    );
  }

  private currentRangeUnits(): number {
    const m = this.modes.find(x => x.key === this.mode);
    return m ? m.units : 840;
  }

  // Chosen mode survives relaunches, same mechanism as chat settings
  private readPersistedMode(): string {
    try {
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(VOICE_SETTINGS_PLUGIN, "PluginsNoLoad");
      if (!data) return "";
      const parsed = JSON.parse(data.slice(2));
      return typeof parsed?.mode === "string" ? parsed.mode : "";
    } catch (e) {
      return "";
    }
  }

  private persistMode(): void {
    try {
      this.sp.writePlugin(
        VOICE_SETTINGS_PLUGIN,
        "//" + JSON.stringify({ mode: this.mode }),
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
      // Only the front's ack marks the session healthy; a connect call landing on an unloaded page never acks and the 5s loop retries
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
    // Voice modes come from the server so admins can retune them centrally
    const rawModes = content["modes"];
    if (Array.isArray(rawModes) && rawModes.length) {
      const parsed: VoiceMode[] = [];
      for (const m of rawModes) {
        const key = String((m as VoiceMode)?.key ?? "");
        const units = Number((m as VoiceMode)?.units);
        if (key && Number.isFinite(units) && units > 0) {
          parsed.push({ key, label: String((m as VoiceMode)?.label ?? key), units });
        }
      }
      if (parsed.length) this.modes = parsed;
    }
    if (!this.mode || !this.modes.some(m => m.key === this.mode)) {
      const persisted = this.readPersistedMode();
      this.mode = this.modes.some(m => m.key === persisted)
        ? persisted
        : (this.modes.find(m => m.key === "talk") || this.modes[0]).key;
    }

    const cfg = { modes: this.modes, mode: this.mode };
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

    // Alt-Tab can swallow the Alt keyup, leaving V stuck in cycle mode
    if (this.altDown
      && !this.sp.Input.isKeyPressed(DxScanCode.LeftAlt)
      && !this.sp.Input.isKeyPressed(DxScanCode.RightAlt)) {
      this.altDown = false;
    }

    // Chat focus steals the key-up event, so drop the mic when typing starts; same when our actor despawns (character park, connection loss)
    if (this.pttDown && (this.sp.browser.isFocused() || isConsoleOpen(this.sp) || !myRefr)) this.releasePtt();

    // Write the chosen mode to disk shortly after it changes
    if (this.modePersistAt && now >= this.modePersistAt) {
      this.modePersistAt = 0;
      this.persistMode();
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

    if (this.pttDown && now >= this.nextAfkPingAt) this.sendAfkPing();
  }

  // Talking counts as activity for the server's AFK autokick
  private sendAfkPing() {
    this.nextAfkPingAt = Date.now() + AFK_PING_INTERVAL_MS;
    sendCustomPacket(this.controller, { customPacketType: "afkPing" });
  }

  // Distances in game units keyed by refrId hex = the LiveKit identity scheme
  private pushPeers() {
    const worldModel = this.controller.lookupListener(RemoteServer).getWorldModel();
    if (!worldModel || !Array.isArray(worldModel.forms)) return;
    const me = worldModel.forms[worldModel.playerCharacterFormIdx];
    const myMovement = me?.movement;
    if (!myMovement || !Array.isArray(myMovement.pos)) return;

    // Speakers pick their own mode, so feed distances out to the loudest mode: a shouter at 3000 units must still be audible
    const maxUnits = this.modes.reduce((a, m) => Math.max(a, m.units), 0) || 3150;
    const includeWithin = maxUnits * 1.2;
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
