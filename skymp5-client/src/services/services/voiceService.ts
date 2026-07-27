import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { readMenuKeyCode } from "./widgetMenuUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { RemoteServer } from "./remoteServer";
import { BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
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

export class VoiceService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.voiceKey = readMenuKeyCode(sp, "voicePushToTalkKeyCode", DxScanCode.V);
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private voiceKey: DxScanCode;
  private disabledByServer = false;
  private connectedForRefrId = 0;
  private rangeUnits = 2000;
  private pttDown = false;
  private micDeniedShown = false;
  private nextTokenAttemptAt = 0;
  private nextPeersAt = 0;

  private onButtonEvent(e: ButtonEvent) {
    if (e.code !== this.voiceKey) return;
    if (e.isDown && !this.pttDown) {
      if (this.sp.browser.isFocused()) return; // typing in chat
      this.pttDown = true;
      this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.setPtt(true)`);
    } else if (e.isUp && this.pttDown) {
      this.releasePtt();
    }
  }

  private releasePtt() {
    this.pttDown = false;
    this.sp.browser.executeJavaScript(`window.__alduinakVoice && window.__alduinakVoice.setPtt(false)`);
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const kind = e.arguments[0];
    if (kind === "voice::micDenied") {
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
    const range = Number(content["rangeUnits"]);
    if (Number.isFinite(range) && range > 0) this.rangeUnits = range;

    this.connectedForRefrId = this.myRefrId();
    this.sp.browser.executeJavaScript(
      `window.__alduinakVoice && window.__alduinakVoice.connect(${JSON.stringify(url)}, ${JSON.stringify(token)}, ${this.rangeUnits})`
    );
  }

  private myRefrId(): number {
    return this.controller.lookupListener(RemoteServer).getMyRemoteRefrId();
  }

  private onUpdate() {
    if (this.disabledByServer) return;
    const now = Date.now();
    const myRefr = this.myRefrId();

    // Chat focus steals the key-up event, so drop the mic when typing starts
    if (this.pttDown && this.sp.browser.isFocused()) this.releasePtt();

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

    const includeWithin = this.rangeUnits * 1.5;
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
