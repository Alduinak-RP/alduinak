import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { focusEventString } from "./browserService";
import { showUi } from "./widgetMenuUtil";
import { BrowserMessageEvent, Menu, MenuOpenEvent } from "skyrimPlatform";
import { logTrace, logError, logToPlatformLog } from "../../logging";
import { applyAppearanceToPlayer, Appearance } from "../../sync/appearance";
import { formIdFromDesc } from "../../view/worldViewMisc";

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
// the server sends charCreatorOpen. The open, close and failure lines go to
// skyrim-platform.log (logToPlatformLog), so a creator that never showed can be
// told apart from one the player never submitted.
export class CharCreatorService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    // A game load can wipe the widget tree under an open creator; put it back
    this.controller.emitter.on("gameLoad", () => {
      if (!this.menuOpen) return;
      logToPlatformLog(this, 'reopening character creator after a game load');
      this.inject();
    });
  }

  // A character switch respawns the player and authService wipes the widgets;
  // close locally so controls and state never go stale. If the new character
  // still has the creator pending, the server re-sends charCreatorOpen.
  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>): void {
    if (e.message.isMe && this.menuOpen) this.close('createActor');
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
    this.close('main menu');
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case 'charCreatorOpen':
        this.open(content["config"]);
        break;
      case 'charCreatorClose':
        if (this.menuOpen) this.close('accepted by the server');
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
    logToPlatformLog(this, 'opening character creator');
    this.inject();
  }

  // Replaces any creator widget already in the tree; safe to run again after a reload
  private inject(): void {
    // Native game-thread calls throw from the packet handler; defer to update.
    this.controller.once("update", () => {
      if (!this.menuOpen) return;
      const js =
        "(function(){" +
        "if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;" +
        "var others=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=='charCreator';});" +
        "window.skyrimPlatform.widgets.set(others.concat([{type:'charCreator',config:" + JSON.stringify(this.withModHair(this.config ?? {})) + "}]));" +
        "})();";
      try {
        showUi(this.controller);
        this.sp.browser.executeJavaScript(js);
        this.sp.browser.setVisible(true);
        this.sp.browser.setFocused(true);
      } catch (e) {
        logToPlatformLog(this, `failed to show character creator: ${e}`);
      }
      try {
        this.sp.Game.forceThirdPerson();
        // (movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType)
        this.sp.Game.disablePlayerControls(false, true, false, false, false, true, false, false, 0);
        this.controlsDisabled = true;
      } catch (e) {
        logToPlatformLog(this, `failed to lock controls: ${e}`);
      }
    });
  }

  private close(reason: string): void {
    this.menuOpen = false;
    this.config = undefined;
    logToPlatformLog(this, `closing character creator: ${reason}`);
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
      case 'charCreator:mountError':
        // The front's error boundary caught a render throw; the wizard shows its failure box and never submits
        logToPlatformLog(this, `character creator failed to render: ${String(e.arguments[1] ?? '')}`);
        break;
      case 'cef::browser:unfocus':
      case 'menu:escape':
        // Chat Escape/Enter and BrowserService's Escape poll drop focus; re-assert it next update so the wizard stays usable
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

  // Swaps the server's mod hair descs for runtime ids; hair from plugins this client lacks is dropped
  private withModHair(config: object): object {
    const { modHair, ...rest } = config as { modHair?: { raceSets?: unknown; hairs?: unknown } };
    if (!modHair || !Array.isArray(modHair.raceSets) || !Array.isArray(modHair.hairs)) return rest;
    const raceSets = modHair.raceSets as unknown[];
    const modParts: object[] = [];
    const modExtras: Record<string, number[]> = {};
    for (const h of modHair.hairs as { desc?: unknown; label?: unknown; male?: unknown; female?: unknown; races?: unknown; extras?: unknown }[]) {
      const id = formIdFromDesc(h?.desc);
      const races = typeof h?.races === 'number' ? raceSets[h.races] : undefined;
      if (!id || !Array.isArray(races)) continue;
      modParts.push({ id, label: String(h.label ?? ''), kind: 'hair', male: h.male === true, female: h.female === true, races });
      const extras = (Array.isArray(h.extras) ? h.extras : []).map((d) => formIdFromDesc(d)).filter((x) => x !== 0);
      if (extras.length) modExtras[String(id)] = extras;
    }
    logTrace(this, `resolved ${modParts.length}/${modHair.hairs.length} mod hairs`);
    return { ...rest, modParts, modExtras };
  }

  private menuOpen = false;
  private controlsDisabled = false;
  private config?: object;
}
