import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { TimersService } from "./timersService";
import { MsgType } from "../../messages";
import { BrowserMessageEvent } from "skyrimPlatform";
import { logTrace, logError } from "../../logging";

// Failsafe: if the server's hide packet never arrives, dismiss this long after the countdown so input returns.
const FAILSAFE_GRACE_MS = 15000;

// Death screen UI.
//
// Server → client custom packets:
//   { "customPacketType": "deathScreen", "show": true, "seconds": 60 }
//   { "customPacketType": "deathScreen", "hide": true }
//
// Client → server (on a confirmed choice):
//   { "customPacketType": "deathChoice", "choice": "permadeath"|"resurrect"|"temple" }
//
// The `death` widget is rendered by skymp5-front; this service shows/hides it and relays the choice.
export class DeathScreenService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] !== "deathScreen") {
      return;
    }
    if (content["hide"] === true) {
      this.hide();
    } else {
      const seconds = typeof content["seconds"] === "number" ? content["seconds"] : 60;
      this.show(seconds);
    }
  }

  private show(seconds: number): void {
    logTrace(this, `show death screen (${seconds}s)`);
    const js =
      "(function(){" +
      "if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;" +
      "var send=function(key){if(window.skyrimPlatform.sendMessage)window.skyrimPlatform.sendMessage('deathChoice',key);};" +
      "var others=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=='death';});" +
      `window.skyrimPlatform.widgets.set([{type:'death',seconds:${Math.max(0, Math.floor(seconds))},onChoice:send}].concat(others));` +
      "})();";
    try {
      this.sp.browser.executeJavaScript(js);
      this.sp.browser.setVisible(true);
      this.sp.browser.setFocused(true); // let the player click the buttons
    } catch (e) {
      logError(this, `failed to show death screen: ${e}`);
    }
    const timers = this.controller.lookupListener(TimersService);
    if (this.failsafeTimer !== undefined) {
      timers.clearTimeout(this.failsafeTimer);
    }
    this.failsafeTimer = timers.setTimeout(() => {
      this.failsafeTimer = undefined;
      logTrace(this, "death screen failsafe dismiss");
      this.hide();
    }, Math.max(0, Math.floor(seconds)) * 1000 + FAILSAFE_GRACE_MS);
  }

  private hide(): void {
    logTrace(this, "hide death screen");
    if (this.failsafeTimer !== undefined) {
      this.controller.lookupListener(TimersService).clearTimeout(this.failsafeTimer);
      this.failsafeTimer = undefined;
    }
    const js =
      "(function(){" +
      "if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;" +
      "window.skyrimPlatform.widgets.set((window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=='death';}));" +
      "})();";
    try {
      this.sp.browser.executeJavaScript(js);
      this.sp.browser.setFocused(false); // hand control back to the game
    } catch (e) {
      logError(this, `failed to hide death screen: ${e}`);
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] !== "deathChoice") {
      return;
    }
    const choice = String(e.arguments[1] ?? "");
    if (choice !== "permadeath" && choice !== "resurrect" && choice !== "temple") {
      return;
    }
    logTrace(this, `death choice: ${choice}`);
    this.controller.emitter.emit("sendMessage", {
      message: {
        t: MsgType.CustomPacket,
        contentJsonDump: JSON.stringify({ customPacketType: "deathChoice", choice }),
      },
      reliability: "reliable",
    });
  }

  private failsafeTimer?: number;
}
