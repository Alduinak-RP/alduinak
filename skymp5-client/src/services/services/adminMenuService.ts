import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";

declare const window: any;

// Admin menu (default Insert, launcher-configurable via adminMenuKeyCode).
// The server decides who is an admin (Discord roles / profile ids); non-admin
// requests are ignored server-side, so the menu simply never opens for them.
// Item spawning is via the in-game console the server grants admins.

const WIDGET_ID = 23;

const events = {
  tp: "admin::tp",
  summon: "admin::summon",
  kick: "admin::kick",
  ban: "admin::ban",
  refresh: "admin::refresh",
  close: "admin::close",
};

// Injected into the browser-side widget setter (module scope, not this.*)
let players: unknown[] = [];

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
    if (this.sp.browser.isFocused()) return;
    sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    if (content["customPacketType"] === "adminMenu") {
      players = Array.isArray(content["players"]) ? content["players"] : [];
      this.showMenu();
    } else if (content["customPacketType"] === "adminActionResult") {
      notifyNextUpdate(this.controller, this.sp, String(content["text"] ?? ""));
    }
  }

  private showMenu(): void {
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, players, WIDGET_ID });
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
    if (kind !== events.tp && kind !== events.summon && kind !== events.kick && kind !== events.ban) return;
    const target = String(e.arguments[1] ?? "");
    const action =
      kind === events.tp ? "teleportTo" :
      kind === events.summon ? "summon" :
      kind === events.kick ? "kick" : "ban";
    sendCustomPacket(this.controller, { customPacketType: "adminAction", action, target });
    // Kick/ban changes the roster; drop the stale menu
    if (action === "kick" || action === "ban") this.closeMenu();
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  // No spread syntax: it breaks after FunctionInfo stringification.
  private browsersideWidgetSetter = () => {
    const widget: any = {
      type: "form",
      id: WIDGET_ID,
      caption: "Admin",
      elements: [] as any[],
    };
    if (players.length === 0) {
      widget.elements.push({ type: "text", text: "No other players online", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
    }
    for (let i = 0; i < players.length; i++) {
      const pl: any = players[i];
      widget.elements.push({
        type: "text",
        text: pl.n + "  (profile " + pl.p + ")",
        tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      });
      widget.elements.push({
        type: "button",
        text: "TP to",
        tags: ["ELEMENT_SAME_LINE"],
        click: () => window.skyrimPlatform.sendMessage(events.tp, pl.a),
      });
      widget.elements.push({
        type: "button",
        text: "Summon",
        tags: ["ELEMENT_SAME_LINE"],
        click: () => window.skyrimPlatform.sendMessage(events.summon, pl.a),
      });
      widget.elements.push({
        type: "button",
        text: "Kick",
        tags: ["ELEMENT_SAME_LINE"],
        click: () => window.skyrimPlatform.sendMessage(events.kick, pl.a),
      });
      widget.elements.push({
        type: "button",
        text: "Ban",
        tags: ["ELEMENT_SAME_LINE"],
        click: () => window.skyrimPlatform.sendMessage(events.ban, pl.a),
      });
    }
    widget.elements.push({
      type: "text",
      text: "Items: use the console (~), e.g. AddItem 0x0000000f 100",
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
    });
    widget.elements.push({
      type: "button",
      text: "Refresh",
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.refresh),
    });
    widget.elements.push({
      type: "button",
      text: "Close",
      tags: ["ELEMENT_SAME_LINE"],
      click: () => window.skyrimPlatform.sendMessage(events.close),
    });
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode;
  private menuOpen = false;
}
