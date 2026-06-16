import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;

// Actions map to Frostfall chat commands that target a player by name. The
// server enforces permissions (leader/staff/player), so we can show them all —
// unauthorized use just gets a "No permission" reply in chat. <n> = target name.
//
// NOTE: Frostfall parses command args on whitespace and matches the player by
// the FIRST token, so only single-word character names resolve (a Frostfall
// limitation, not ours).
interface PlayerAction {
  id: string;
  label: string;
  group: string;
  tmpl: string; // '<n>' is replaced with the target's name
}

const ACTIONS: PlayerAction[] = [
  { id: 'arrest', label: 'Arrest', group: 'Justice', tmpl: '/arrest <n>' },
  { id: 'sentence_release', label: 'Sentence: release', group: 'Justice', tmpl: '/sentence <n> release' },
  { id: 'sentence_banish', label: 'Sentence: banish', group: 'Justice', tmpl: '/sentence <n> banish' },
  { id: 'capture', label: 'Capture', group: 'Captivity', tmpl: '/capture <n>' },
  { id: 'release', label: 'Release', group: 'Captivity', tmpl: '/release <n>' },
  { id: 'down', label: 'Down', group: 'Combat', tmpl: '/down <n>' },
  { id: 'rise', label: 'Rise', group: 'Combat', tmpl: '/rise <n>' },
  { id: 'bounty', label: 'Check bounty', group: 'Info', tmpl: '/bounty check <n>' },
  { id: 'slots', label: 'Faction slots', group: 'Info', tmpl: '/faction slots <n>' },
  { id: 'sober', label: 'Sober', group: 'Staff', tmpl: '/sober <n>' },
  { id: 'feed', label: 'Feed', group: 'Staff', tmpl: '/feed <n>' },
  { id: 'nvfl', label: 'Clear NVFL', group: 'Staff', tmpl: '/nvfl clear <n>' },
];

const events = {
  action: 'pa:action',
  close: 'pa:close',
};

// Module-level so the browser-side widget setter can read it (runtime injection).
let targetName = '';

/**
 * Player-interaction menu for the Frostfall backend. Look at a player, press the
 * interact key (default Y), and pick an action — each fires the matching
 * Frostfall chat command (/arrest, /capture, /down, …) against that player.
 * Feedback comes back through chat. Drives Frostfall through its existing
 * cef::chat:send contract; invents no new server packets.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && typeof settings["interactMenuKeyCode"] === "number") {
        this.menuKey = settings["interactMenuKeyCode"];
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
    const ref = this.sp.Game.getCurrentCrosshairRef();
    const actor = ref ? Actor.from(ref) : null;
    if (!ref || !actor || ref.getFormID() === 0x14) {
      this.notify("Look at a player to interact");
      return;
    }
    targetName = (ref.getName() || "").trim();
    if (!targetName) {
      this.notify("That target has no name");
      return;
    }
    logTrace(this, `Opening player-action menu for`, targetName);
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("pa:") || !this.menuOpen) {
      return;
    }
    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.action) {
      const actionId = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      const action = ACTIONS.find((a) => a.id === actionId);
      if (action && targetName) {
        this.sendCommand(action.tmpl.replace("<n>", targetName));
      }
      this.closeMenu();
    }
  }

  private sendCommand(text: string): void {
    logTrace(this, `Player-action command:`, text);
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ type: "cef::chat:send", data: text }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private notify(text: string): void {
    // Native UI calls throw if made straight from an input handler; defer.
    this.controller.once("update", () => {
      try {
        this.sp.Debug.notification(text);
      } catch (e) {
        // ignore
      }
    });
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({ ACTIONS, targetName, events, WIDGET_ID })
    );
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==10;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private browsersideWidgetSetter = () => {
    const elements: any[] = [];
    let lastGroup = "";
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i];
      if (a.group !== lastGroup) {
        lastGroup = a.group;
        elements.push({ type: "text", text: a.group, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
      }
      elements.push({ type: "button", text: a.label, tags: [], click: () => window.skyrimPlatform.sendMessage(events.action, a.id) });
    }
    elements.push({ type: "button", text: "close", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.close) });

    const widget = { type: "form", id: WIDGET_ID, caption: "Actions: " + targetName, elements: elements };
    // Preserve Frostfall's chat widget and anything else; only replace ours.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.Y;
  private menuOpen = false;
}
