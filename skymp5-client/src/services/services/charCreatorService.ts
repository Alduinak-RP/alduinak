import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { focusEventString } from "./browserService";
import { showUi } from "./widgetMenuUtil";
import { BrowserMessageEvent, Menu, MenuOpenEvent } from "skyrimPlatform";
import { logTrace, logError } from "../../logging";
import { applyAppearanceToPlayer, Appearance } from "../../sync/appearance";

// Preview payloads larger than this are ignored (malformed or hostile page state).
const MAX_PREVIEW_JSON = 32 * 1024;

// Character creator bridge.
//
// Server → client custom packets:
//   { "customPacketType": "charCreatorOpen", "config": { ... } }
//   { "customPacketType": "charCreatorClose" }
//   { "customPacketType": "charCreatorError", "message": "..." }
//
// Client → server (on finish):
//   { "customPacketType": "charCreatorResult", "data": { ... } }
//
// The `charCreator` widget is rendered by skymp5-front; this service shows/hides
// it, applies local appearance previews and relays the final result. Inert until
// the server sends charCreatorOpen.
export class CharCreatorService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
  }

  // A character switch respawns the player and authService wipes the widgets;
  // close locally so controls and state never go stale. If the new character
  // still has the creator pending, the server re-sends charCreatorOpen.
  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>): void {
    if (e.message.isMe && this.menuOpen) this.close();
  }

  // Quitting to the main menu opens character select; the creator must not overlay it.
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Main || !this.menuOpen) return;
    // menuOpen events can arrive late; only act when the menu is really open (stale-event guard).
    try {
      if (!this.sp.Ui.isMenuOpen(Menu.Main)) return;
    } catch {
      return;
    }
    this.close();
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case 'charCreatorOpen':
        this.open(content["config"]);
        break;
      case 'charCreatorClose':
        if (this.menuOpen) this.close();
        break;
      case 'charCreatorError':
        if (this.menuOpen) this.forwardError(String(content["message"] ?? ""));
        break;
      default:
        break;
    }
  }

  private open(config: unknown): void {
    this.config = config && typeof config === 'object' ? config : {};
    this.menuOpen = true;
    logTrace(this, 'opening character creator');
    const js =
      "(function(){" +
      "if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;" +
      "var others=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=='charCreator';});" +
      "window.skyrimPlatform.widgets.set(others.concat([{type:'charCreator',config:" + JSON.stringify(this.config) + "}]));" +
      "})();";
    try {
      showUi(this.controller);
      this.sp.browser.executeJavaScript(js);
      this.sp.browser.setVisible(true);
      this.sp.browser.setFocused(true);
    } catch (e) {
      logError(this, `failed to show character creator: ${e}`);
    }
    // Native game-thread calls throw from the packet handler; defer to update.
    this.controller.once("update", () => {
      try {
        this.sp.Game.forceThirdPerson();
        // (movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType)
        this.sp.Game.disablePlayerControls(false, true, false, false, false, true, false, false, 0);
        this.controlsDisabled = true;
      } catch (e) {
        logError(this, `failed to lock controls: ${e}`);
      }
    });
  }

  private close(): void {
    this.menuOpen = false;
    this.config = undefined;
    logTrace(this, 'closing character creator');
    const js =
      "(function(){" +
      "if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;" +
      "window.skyrimPlatform.widgets.set((window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=='charCreator';}));" +
      "})();";
    try {
      this.sp.browser.executeJavaScript(js);
      this.sp.browser.setFocused(false);
    } catch (e) {
      logError(this, `failed to hide character creator: ${e}`);
    }
    if (this.controlsDisabled) {
      this.controller.once("update", () => {
        try {
          this.sp.Game.enablePlayerControls(false, true, false, false, false, true, false, false, 0);
        } catch (e) {
          logError(this, `failed to unlock controls: ${e}`);
        }
      });
      this.controlsDisabled = false;
    }
  }

  private forwardError(message: string): void {
    const js =
      "window.dispatchEvent(new CustomEvent('charCreator:error',{detail:" + JSON.stringify(message) + "}));";
    try {
      this.sp.browser.executeJavaScript(js);
    } catch (e) {
      logError(this, `failed to forward error: ${e}`);
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const eventKey = e.arguments[0];
    if (typeof eventKey !== 'string') return;
    if (!this.menuOpen) return;

    switch (eventKey) {
      case 'charCreator:save':
        this.onSave(e.arguments[1]);
        break;
      case 'charCreator:preview':
        this.onPreview(e.arguments[1]);
        break;
      case 'menu:escape':
        // The front handles back-navigation itself, but BrowserService's key
        // poll unfocuses the browser on Escape; re-assert focus next update so
        // the mouse-driven wizard stays usable.
        this.controller.once("update", () => {
          if (!this.menuOpen) return;
          try {
            this.sp.browser.setFocused(true);
            this.sp.browser.executeJavaScript(focusEventString);
          } catch (e2) {
            logError(this, `failed to refocus browser: ${e2}`);
          }
        });
        break;
      default:
        break;
    }
  }

  private onSave(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      logError(this, 'charCreator:save is not valid JSON');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      logError(this, 'charCreator:save is not an object');
      return;
    }
    logTrace(this, 'sending charCreatorResult');
    sendCustomPacket(this.controller, { customPacketType: 'charCreatorResult', data });
  }

  private onPreview(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_PREVIEW_JSON) return;
    let appearance: Appearance;
    try {
      appearance = JSON.parse(raw);
    } catch {
      logError(this, 'charCreator:preview is not valid JSON');
      return;
    }
    if (!appearance || typeof appearance !== 'object'
      || typeof appearance.raceId !== 'number' || !Array.isArray(appearance.headpartIds)) {
      logError(this, 'charCreator:preview is not an Appearance');
      return;
    }
    this.controller.once("update", () => {
      if (!this.menuOpen) return;
      try {
        applyAppearanceToPlayer(appearance);
        logTrace(this, 'applied preview appearance');
      } catch (e) {
        logError(this, `failed to apply preview appearance: ${e}`);
      }
    });
  }

  private menuOpen = false;
  private controlsDisabled = false;
  private config?: object;
}
