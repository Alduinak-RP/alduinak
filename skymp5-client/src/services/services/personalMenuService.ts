import { ClientListener, CombinedController, Sp } from "./clientListener";
import { closeWidget, readMenuKeyCode } from "./widgetMenuUtil";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { FunctionInfo } from "../../lib/functionInfo";
import { BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 11;

// SkyMP's trainable skills and the factions that publish a BBB document.
const SKILLS = ['destruction', 'restoration', 'alteration', 'conjuration', 'illusion', 'smithing', 'enchanting', 'alchemy'];
const FACTION_DOCS = ['collegeOfWinterhold', 'companions', 'eastEmpireCompany', 'thievesGuild', 'bardsCollege'];

const events = {
  run: 'pm:run',   // arg = full command text to send
  nav: 'pm:nav',   // arg = view name
  switchChar: 'pm:switchchar',
  close: 'pm:close',
};

// Module-level so the browser-side widget setter can read it (runtime injection).
let view = 'main';

/**
 * Personal RP hub for the SkyMP backend. Press the personal-menu key
 * (default U) to open a menu of self-targeted commands: help, your skills,
 * bounties, properties, and lecture/training/faction-doc submenus. Each button
 * fires the matching SkyMP chat command via the cef::chat:send contract;
 * output appears in chat. Invents no new server packets.
 */
export class PersonalMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

    this.menuKey = readMenuKeyCode(this.sp, "personalMenuKeyCode", DxScanCode.U);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // Escape closes an open menu.
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (this.sp.browser.isFocused()) {
      return;
    }
    view = 'main';
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("pm:") || !this.menuOpen) {
      return;
    }
    const arg = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";

    switch (key) {
      case events.run:
        if (arg) {
          this.sendCommand(arg);
        }
        this.closeMenu();
        break;
      case events.nav:
        view = arg || 'main';
        this.renderMenu();
        break;
      case events.switchChar: {
        // Reopens character select in-world; the server parks this body (logout
        // grace) and assigns the picked character, no main-menu round trip.
        const message: CustomPacketMessage = {
          t: MsgType.CustomPacket,
          contentJsonDump: JSON.stringify({ customPacketType: "characterSelectMenuRequest" }),
        };
        this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
        this.closeMenu();
        break;
      }
      case events.close:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private sendCommand(text: string): void {
    logTrace(this, `Personal command:`, text);
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
      new FunctionInfo(this.browsersideWidgetSetter).getText({ SKILLS, FACTION_DOCS, view, events, WIDGET_ID })
    );
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeWidget(this.sp, WIDGET_ID);
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private browsersideWidgetSetter = () => {
    const elements: any[] = [];
    const btn = (text: string, ev: string, arg?: string) =>
      elements.push({ type: "button", text: text, tags: [], click: () => window.skyrimPlatform.sendMessage(ev, arg) });

    if (view === 'lecture') {
      elements.push({ type: "text", text: "Lectures", tags: [] });
      btn("start lecture", events.run, "/lecture start");
      btn("end lecture", events.run, "/lecture end");
      btn("back", events.nav, "main");
    } else if (view === 'training') {
      elements.push({ type: "text", text: "Start training", tags: [] });
      for (let i = 0; i < SKILLS.length; i++) {
        btn(SKILLS[i], events.run, "/train start " + SKILLS[i]);
      }
      elements.push({ type: "button", text: "end training", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.run, "/train end") });
      btn("back", events.nav, "main");
    } else if (view === 'factions') {
      elements.push({ type: "text", text: "Faction docs (BBB)", tags: [] });
      for (let i = 0; i < FACTION_DOCS.length; i++) {
        btn(FACTION_DOCS[i], events.run, "/faction bbb " + FACTION_DOCS[i]);
      }
      btn("back", events.nav, "main");
    } else {
      elements.push({ type: "text", text: "Personal", tags: [] });
      btn("help", events.run, "/help");
      btn("my skills", events.run, "/skill");
      btn("my bounties", events.run, "/bounty");
      btn("my properties", events.run, "/property list");
      elements.push({ type: "button", text: "lectures", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.nav, "lecture") });
      btn("training", events.nav, "training");
      btn("faction docs", events.nav, "factions");
      elements.push({ type: "button", text: "switch character", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.switchChar) });
      elements.push({ type: "button", text: "close", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.close) });
    }

    const widget = { type: "form", id: WIDGET_ID, caption: "Menu", elements: elements };
    // Preserve SkyMP's chat widget and anything else; only replace ours.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.U;
  private menuOpen = false;
}
