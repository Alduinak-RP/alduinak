import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";

declare const window: any;

// Tabbed admin panel (default Insert, launcher-configurable via adminMenuKeyCode); item spawning is via the server-granted in-game console.
// The server decides who is admin (Discord roles / profile ids); non-admin requests are ignored server-side.
// Renders as the dedicated 'adminPanel' widget (skymp5-front features/adminPanel), trade-style: pure data in, sendMessage events out.

const WIDGET_ID = 23;

const events = {
  tp: "admin::tp",
  summon: "admin::summon",
  kick: "admin::kick",
  ban: "admin::ban",
  tpLoc: "admin::tploc",
  mode: "admin::mode",
  refresh: "admin::refresh",
  close: "admin::close",
};

// Injected into the browser-side widget setter (module scope, not this.*)
let panelData: any = { players: [], locations: [], modes: [], events };

export class AdminMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.menuKey = readMenuKeyCode(sp, "adminMenuKeyCode", DxScanCode.Insert);
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onButtonEvent(e: ButtonEvent) {
    if (e.device !== InputDeviceType.Keyboard || !e.isDown) return;
    if (e.code === DxScanCode.Escape && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey) return;
    if (this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) return;
    sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    if (content["customPacketType"] === "adminMenu") {
      panelData = {
        players: Array.isArray(content["players"]) ? content["players"] : [],
        locations: Array.isArray(content["locations"]) ? content["locations"] : [],
        modes: Array.isArray(content["modes"]) ? content["modes"] : [],
        events,
      };
      this.showMenu();
    } else if (content["customPacketType"] === "adminMode") {
      // Keep the Modes tab highlight in sync without a full roster refresh
      const mode = String(content["mode"] ?? "");
      const on = !!content["on"];
      for (const m of Array.isArray(panelData.modes) ? panelData.modes : []) {
        if (m && m.id === mode) m.active = on;
      }
      if (this.menuOpen) this.showMenu();
    } else if (content["customPacketType"] === "adminActionResult") {
      notifyNextUpdate(this.controller, this.sp, String(content["text"] ?? ""));
    }
  }

  private showMenu(): void {
    openFormMenu(this.sp, this.browsersideWidgetSetter, { panelData, WIDGET_ID });
    this.menuOpen = true;
  }

  private closeMenu(): void {
    closeFormMenu(this.sp, WIDGET_ID);
    this.menuOpen = false;
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const kind = e.arguments[0];
    if (kind === events.close || (kind === "menu:escape" && this.menuOpen)) {
      this.closeMenu();
      return;
    }
    if (kind === events.refresh) {
      sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
      return;
    }
    if (kind === events.tpLoc) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "teleportLoc", target: String(e.arguments[1] ?? "") });
      return;
    }
    if (kind === events.mode) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "toggleMode", mode: String(e.arguments[1] ?? "") });
      return;
    }
    if (kind !== events.tp && kind !== events.summon && kind !== events.kick && kind !== events.ban) return;
    const target = String(e.arguments[1] ?? "");
    const action =
      kind === events.tp ? "teleportTo" :
      kind === events.summon ? "summon" :
      kind === events.kick ? "kick" : "ban";
    sendCustomPacket(this.controller, { customPacketType: "adminAction", action, target });
    // Kick/ban changes the roster; ask for a fresh one
    if (action === "kick" || action === "ban") {
      sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
    }
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  // No spread syntax: it breaks after FunctionInfo stringification.
  private browsersideWidgetSetter = () => {
    const widget: any = Object.assign({ type: "adminPanel", id: WIDGET_ID }, panelData);
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode;
  private menuOpen = false;
}
