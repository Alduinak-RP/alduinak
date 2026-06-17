import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { FunctionInfo } from "../../lib/functionInfo";
import { BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

// Frostfall drives housing through chat commands (`/property …`). We send those
// commands the same way the chat box does: a customPacket the gamemode reads as
// { type: 'cef::chat:send', data: '<text>' }. Feedback comes back through chat.
//
// The property list is static in Frostfall (a fixed registry), so we embed it
// here to build a real picker; live ownership status still shows via the
// "/property list" chat reply.
const HOLDS: { id: string, name: string }[] = [
  { id: 'whiterun', name: 'Whiterun' },
  { id: 'eastmarch', name: 'Eastmarch' },
  { id: 'rift', name: 'The Rift' },
  { id: 'reach', name: 'The Reach' },
  { id: 'haafingar', name: 'Haafingar' },
  { id: 'pale', name: 'The Pale' },
  { id: 'falkreath', name: 'Falkreath' },
  { id: 'hjaalmarch', name: 'Hjaalmarch' },
  { id: 'winterhold', name: 'Winterhold' },
];

const PROPERTIES: { id: string, name: string, holdId: string, type: string }[] = [
  { id: 'wrun_breezehome', name: 'Breezehome', holdId: 'whiterun', type: 'home' },
  { id: 'wrun_breezeannex', name: 'Breezehome Annex', holdId: 'whiterun', type: 'business' },
  { id: 'east_hjerim', name: 'Hjerim', holdId: 'eastmarch', type: 'home' },
  { id: 'east_windhelm_shop', name: 'Windhelm Market Stall', holdId: 'eastmarch', type: 'business' },
  { id: 'rift_honeyside', name: 'Honeyside', holdId: 'rift', type: 'home' },
  { id: 'rift_riften_shop', name: 'Riften Stall', holdId: 'rift', type: 'business' },
  { id: 'reach_vlindrel', name: 'Vlindrel Hall', holdId: 'reach', type: 'home' },
  { id: 'reach_markarth_shop', name: 'Markarth Stall', holdId: 'reach', type: 'business' },
  { id: 'haaf_proudspire', name: 'Proudspire Manor', holdId: 'haafingar', type: 'home' },
  { id: 'haaf_solitude_shop', name: 'Solitude Market', holdId: 'haafingar', type: 'business' },
  { id: 'pale_dawnstar_home', name: 'Dawnstar Cottage', holdId: 'pale', type: 'home' },
  { id: 'pale_dawnstar_shop', name: 'Dawnstar Stall', holdId: 'pale', type: 'business' },
  { id: 'falk_lakeview', name: 'Lakeview Manor', holdId: 'falkreath', type: 'home' },
  { id: 'falk_falkreath_shop', name: 'Falkreath Stall', holdId: 'falkreath', type: 'business' },
  { id: 'hjaal_windstad', name: 'Windstad Manor', holdId: 'hjaalmarch', type: 'home' },
  { id: 'wint_college_quarters', name: 'College Quarters', holdId: 'winterhold', type: 'home' },
];

const events = {
  hold: 'housing:hold',
  back: 'housing:back',
  list: 'housing:list',
  request: 'housing:request',
  approve: 'housing:approve',
  deny: 'housing:deny',
  revoke: 'housing:revoke',
  close: 'housing:close',
};

const WIDGET_ID = 8;

// Module-level so the browser-side widget setter can read it (runtime injection).
let selectedHold: string | null = null;

/**
 * In-game panel for Frostfall's housing. Press the housing key (default H) to
 * pick a hold, then a property, and request/approve/deny/revoke it. Each action
 * is sent as a Frostfall chat command (`/property …`); results appear in chat.
 *
 * This drives the Frostfall gamemode through its existing `cef::chat:send`
 * contract — it does not invent new server packets.
 */
export class HousingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && typeof settings["housingMenuKeyCode"] === "number") {
        this.menuKey = settings["housingMenuKeyCode"];
      }
    } catch {
      // default key
    }
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (this.sp.browser.isFocused()) {
      return;
    }
    selectedHold = null;
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("housing:") || !this.menuOpen) {
      return;
    }
    const arg = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";

    switch (key) {
      case events.hold:
        selectedHold = arg;
        this.renderMenu();
        break;
      case events.back:
        selectedHold = null;
        this.renderMenu();
        break;
      case events.list:
        this.sendCommand("/property list");
        this.closeMenu();
        break;
      case events.request:
        this.sendCommand(`/property request ${arg}`);
        this.closeMenu();
        break;
      case events.approve:
        this.sendCommand(`/property approve ${arg}`);
        this.closeMenu();
        break;
      case events.deny:
        this.sendCommand(`/property deny ${arg}`);
        this.closeMenu();
        break;
      case events.revoke:
        this.sendCommand(`/property revoke ${arg}`);
        this.closeMenu();
        break;
      case events.close:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  // Sends text to the gamemode exactly like the chat box does.
  private sendCommand(text: string): void {
    logTrace(this, `Housing command:`, text);
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ type: "cef::chat:send", data: text }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.renderMenu();
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private renderMenu(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({ HOLDS, PROPERTIES, selectedHold, events, WIDGET_ID })
    );
  }

  private closeMenu(): void {
    this.menuOpen = false;
    // Remove only our widget; leave Frostfall's chat (and anything else) intact.
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==8;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private browsersideWidgetSetter = () => {
    const elements: any[] = [];

    if (!selectedHold) {
      elements.push({ type: "text", text: "Select a hold", tags: [] });
      for (let i = 0; i < HOLDS.length; i++) {
        const h = HOLDS[i];
        elements.push({ type: "button", text: h.name, tags: [], click: () => window.skyrimPlatform.sendMessage(events.hold, h.id) });
      }
      elements.push({ type: "button", text: "show my hold (/property list)", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.list) });
      elements.push({ type: "button", text: "close", tags: [], click: () => window.skyrimPlatform.sendMessage(events.close) });
    } else {
      const hold = HOLDS.filter(function (h) { return h.id === selectedHold; })[0];
      elements.push({ type: "text", text: (hold ? hold.name : selectedHold) + " properties", tags: [] });
      const list = PROPERTIES.filter(function (p) { return p.holdId === selectedHold; });
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        elements.push({ type: "text", text: p.name + " [" + p.type + "]", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
        elements.push({ type: "button", text: "request", tags: [], click: () => window.skyrimPlatform.sendMessage(events.request, p.id) });
        elements.push({ type: "button", text: "approve", tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.approve, p.id) });
        elements.push({ type: "button", text: "deny", tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.deny, p.id) });
        elements.push({ type: "button", text: "revoke", tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.revoke, p.id) });
      }
      elements.push({ type: "button", text: "back", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.back) });
      elements.push({ type: "button", text: "close", tags: [], click: () => window.skyrimPlatform.sendMessage(events.close) });
    }

    const widget = { type: "form", id: WIDGET_ID, caption: "Property", elements: elements };
    // Preserve Frostfall's chat widget and anything else; only replace ours.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.H;
  private menuOpen = false;
}
