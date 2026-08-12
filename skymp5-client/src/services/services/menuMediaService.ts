import { BrowserMessageEvent, Menu, MenuOpenEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";

// Drives the main-menu background video + music in the CEF front
// (window.__alduinakMenuMedia): shown while the player sits in the login /
// character-select phase, hidden once actually in the world, shown again on a
// quit back to the main menu. The mute choice persists like chat settings.

const SETTINGS_PLUGIN_NAME = "menu-media-settings-no-load";

export class MenuMediaService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("browserWindowLoaded", () => this.onBrowserWindowLoaded());
    this.controller.emitter.on("createActorMessage", (e) => {
      if (e.message.isMe) this.hide();
    });
    this.controller.once("update", () => { this.sawGameplay = true; });
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
  }

  private sawGameplay = false;
  private frontLoaded = false;

  private onBrowserWindowLoaded(): void {
    this.frontLoaded = true;
    if (!this.sawGameplay) this.show();
  }

  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Main) return;
    if (!this.sawGameplay) return; // initial boot: browserWindowLoaded drives it
    // menuOpen events can arrive late (queued into SP update tasks); only act
    // when the main menu is REALLY open right now (stale-event guard).
    try {
      if (!this.sp.Ui.isMenuOpen(Menu.Main)) return;
    } catch (err) {
      return;
    }
    this.show();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] !== "cef::menuMedia:saveSettings") return;
    const json = String(e.arguments[1] ?? "");
    if (!json) return;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object") return;
      this.sp.writePlugin(
        SETTINGS_PLUGIN_NAME,
        "//" + JSON.stringify(parsed),
        // @ts-expect-error (TODO: Remove in 2.10.0)
        "PluginsNoLoad"
      );
    } catch (err) { /* corrupt input from the UI */ }
  }

  private readSettings(): string {
    try {
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(SETTINGS_PLUGIN_NAME, "PluginsNoLoad");
      if (!data) return "{}";
      const parsed = JSON.parse(data.slice(2));
      if (!parsed || typeof parsed !== "object") return "{}";
      return JSON.stringify(parsed);
    } catch (err) {
      return "{}";
    }
  }

  private show(): void {
    if (!this.frontLoaded) return;
    logTrace(this, "Showing main menu media");
    this.sp.browser.executeJavaScript(
      `window.__alduinakMenuMedia && window.__alduinakMenuMedia.show(${this.readSettings()})`
    );
  }

  private hide(): void {
    logTrace(this, "Hiding main menu media");
    this.sp.browser.executeJavaScript(
      "window.__alduinakMenuMedia && window.__alduinakMenuMedia.hide()"
    );
  }
}
