import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

// One row in the hold-management menu, as sent by the server.
interface FactionMember {
  name?: string;
  profileId: number;
  rank?: string;
}

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  add: 'faction:add',
  remove: 'faction:remove',
  promote: 'faction:promote',
  demote: 'faction:demote',
  close: 'faction:close',
};

const translations = {
  "ru": {
    title: 'Управление холдом',
    addMember: 'добавить',
    remove: 'убрать',
    promote: 'повысить',
    demote: 'понизить',
    close: 'закрыть',
    empty: 'Нет членов',
    lookAtNewMember: 'Наведитесь на нового члена и нажмите клавишу',
    addCancelled: 'Добавление отменено',
  },
  "en": {
    title: 'Manage Hold',
    addMember: 'add member',
    remove: 'remove',
    promote: 'promote',
    demote: 'demote',
    close: 'close',
    empty: 'No members',
    lookAtNewMember: 'Look at the new member and press the faction key',
    addCancelled: 'Add cancelled',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// Module-level state shared with the browser-side widget setter via runtime
// injection (same pattern as HousingService / CharacterSelectService).
let strings: TranslationStrings = translations['en'];
let title = '';
let members: FactionMember[] = [];

/**
 * Hold (faction) management for the fixed-holds model: a Jarl/leader manages
 * who belongs to their hold and their rank. Press the faction key (default G)
 * to ask the server for your hold's roster; the server validates that you may
 * manage a hold and replies with the member list.
 *
 * Protocol — all messages are {@link MsgType.CustomPacket} with a JSON dump.
 *
 *   Client -> Server, open my hold roster:
 *     { "customPacketType": "factionMenuRequest" }
 *
 *   Server -> Client, the roster (server validated permission):
 *     { "customPacketType": "factionMenu",
 *       "title": "Whiterun Hold",
 *       "members": [ { "name": "Lydia", "profileId": 7, "rank": "guard" } ] }
 *
 *   Client -> Server, a management action:
 *     { "customPacketType": "factionRequest", "action": "add",     "recipient": 134669556 }
 *     { "customPacketType": "factionRequest", "action": "remove",  "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "promote", "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "demote",  "profileId": 7 }
 *
 *   Server -> Client, feedback (corner notification):
 *     { "customPacketType": "factionNotice", "text": "Lydia is now a guard." }
 *
 * After a change, the server should re-send "factionMenu" to refresh the list.
 * Inert until the player presses the key.
 */
export class FactionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));

    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings) {
        if (typeof settings["factionMenuKeyCode"] === "number") {
          this.menuKey = settings["factionMenuKeyCode"];
        }
        if (settings["language"] && settings["language"] in translations) {
          strings = translations[settings["language"] as keyof typeof translations];
        }
      }
    } catch {
      // fall back to defaults
    }
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.code !== this.menuKey || !e.isDown) {
      return;
    }
    if (this.sp.browser.isFocused()) {
      return;
    }

    // If an "add member" is pending, this press picks the player to add.
    if (this.pendingAdd) {
      this.pendingAdd = false;
      const ref = this.sp.Game.getCurrentCrosshairRef();
      const recipient = ref && Actor.from(ref) ? ref : null;
      if (!recipient || recipient.getFormID() === 0x14) {
        this.sp.Debug.notification(strings.addCancelled);
        return;
      }
      this.sendRequest({ action: "add", recipient: localIdToRemoteId(recipient.getFormID()) });
      return;
    }

    if (this.menuOpen) {
      return;
    }
    // Ask the server for the roster; it decides whether we may manage a hold.
    this.sendPacket({ customPacketType: "factionMenuRequest" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }

    switch (content["customPacketType"]) {
      case "factionMenu":
        title = typeof content["title"] === "string" ? content["title"] as string : strings.title;
        members = Array.isArray(content["members"]) ? content["members"] as FactionMember[] : [];
        logTrace(this, `Opening faction menu`, title, `(${members.length} members)`);
        this.openMenu();
        break;
      case "factionMenuClose":
        if (this.menuOpen) {
          this.closeMenu();
        }
        break;
      case "factionNotice":
        if (typeof content["text"] === "string") {
          this.sp.Debug.notification(content["text"]);
        }
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("faction:") || !this.menuOpen) {
      return;
    }
    const profileId = Number(e.arguments[1]);

    switch (key) {
      case events.add:
        // Defer to a second key press where the player looks at the new member.
        this.pendingAdd = true;
        this.closeMenu();
        this.sp.Debug.notification(strings.lookAtNewMember);
        break;
      case events.remove:
        this.sendRequest({ action: "remove", profileId });
        // Leave the menu open; the server re-sends factionMenu to refresh it.
        break;
      case events.promote:
        this.sendRequest({ action: "promote", profileId });
        break;
      case events.demote:
        this.sendRequest({ action: "demote", profileId });
        break;
      case events.close:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private sendRequest(payload: Record<string, unknown>): void {
    this.sendPacket({ customPacketType: "factionRequest", ...payload });
  }

  private sendPacket(payload: Record<string, unknown>): void {
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify(payload),
    };
    this.controller.emitter.emit("sendMessage", {
      message,
      reliability: "reliable",
    });
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({ events, strings, title, members })
    );
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==9;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only the injected variables (events, strings,
  // title, members) and `window` are available here.
  private browsersideWidgetSetter = () => {
    const widget: any = {
      type: "form",
      id: 9,
      caption: title || strings.title,
      elements: [] as any[],
    };

    widget.elements.push({
      type: "button",
      text: strings.addMember,
      tags: [],
      click: () => window.skyrimPlatform.sendMessage(events.add),
    });

    if (members.length === 0) {
      widget.elements.push({ type: "text", text: strings.empty, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
    } else {
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const label = (m.name || `#${m.profileId}`) + (m.rank ? ` — ${m.rank}` : "");
        widget.elements.push({ type: "text", text: label, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
        widget.elements.push({
          type: "button",
          text: strings.promote,
          tags: [],
          click: () => window.skyrimPlatform.sendMessage(events.promote, m.profileId),
        });
        widget.elements.push({
          type: "button",
          text: strings.demote,
          tags: ["ELEMENT_SAME_LINE"],
          click: () => window.skyrimPlatform.sendMessage(events.demote, m.profileId),
        });
        widget.elements.push({
          type: "button",
          text: strings.remove,
          tags: ["ELEMENT_SAME_LINE"],
          click: () => window.skyrimPlatform.sendMessage(events.remove, m.profileId),
        });
      }
    }

    widget.elements.push({
      type: "button",
      text: strings.close,
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.close),
    });

    // Preserve any other widgets (e.g. the persistent chat) — only replace ours.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== 9);
    window.skyrimPlatform.widgets.set([...others, widget]);
  };

  private menuKey: DxScanCode = DxScanCode.G;
  private menuOpen = false;
  private pendingAdd = false;
}
