import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { closeWidget, readMenuKeyCode } from "./widgetMenuUtil";
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
  online?: boolean;
}

// Regent info block sent alongside the roster.
interface RegentInfo {
  line: { profileId: number; name?: string }[];
  activeProfileId: number | null;
  actingName: string | null;
  canManage: boolean;
}

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  add: 'faction:add',
  remove: 'faction:remove',
  promote: 'faction:promote',
  demote: 'faction:demote',
  regentAdd: 'faction:regentadd',
  regentRemove: 'faction:regentremove',
  regentUp: 'faction:regentup',
  regencyGrant: 'faction:regencygrant',
  regencyRevoke: 'faction:regencyrevoke',
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
    offline: 'оффлайн',
    actingLeader: 'Действующий лидер',
    regentLine: 'Линия регентов',
    regentAdd: 'в регенты',
    regentUp: 'выше',
    regencyGrant: 'дать регентство',
    regencyRevoke: 'снять регентство',
    activeRegent: 'регент',
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
    offline: 'offline',
    actingLeader: 'Acting leader',
    regentLine: 'Regent line',
    regentAdd: 'make regent',
    regentUp: 'move up',
    regencyGrant: 'grant regency',
    regencyRevoke: 'revoke regency',
    activeRegent: 'regent',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// Module-level state shared with the browser-side widget setter via runtime injection
let strings: TranslationStrings = translations['en'];
let title = '';
let members: FactionMember[] = [];
let regents: RegentInfo = { line: [], activeProfileId: null, actingName: null, canManage: false };

/**
 * Hold (faction) management for the fixed-holds model. Press the faction key
 * (default G) to ask the server for your hold's roster; the server validates
 * that you may manage a hold and replies with the member list plus regent info.
 *
 * Protocol - all messages are {@link MsgType.CustomPacket} with a JSON dump.
 *
 *   Client -> Server, open my hold roster:
 *     { "customPacketType": "factionMenuRequest" }
 *
 *   Server -> Client, the roster (server validated permission):
 *     { "customPacketType": "factionMenu",
 *       "title": "Whiterun Hold",
 *       "members": [ { "name": "Lydia", "profileId": 7, "rank": "guard", "online": true } ],
 *       "regents": { "line": [{ "profileId": 7, "name": "Lydia" }],
 *                    "activeProfileId": null, "actingName": null, "canManage": true } }
 *
 *   Client -> Server, management actions:
 *     { "customPacketType": "factionRequest", "action": "add",           "recipient": 134669556 }
 *     { "customPacketType": "factionRequest", "action": "remove",        "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "promote",       "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "demote",        "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "regentadd",     "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "regentremove",  "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "regentup",      "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "regencygrant",  "profileId": 7 }
 *     { "customPacketType": "factionRequest", "action": "regencyrevoke" }
 *
 *   Server -> Client, feedback (corner notification):
 *     { "customPacketType": "factionNotice", "text": "Lydia is now a guard." }
 *
 * After a change, the server re-sends "factionMenu" to refresh the list.
 * Inert until the player presses the key.
 */
export class FactionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));

    this.menuKey = readMenuKeyCode(this.sp, "factionMenuKeyCode", DxScanCode.G);
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && settings["language"] && settings["language"] in translations) {
        strings = translations[settings["language"] as keyof typeof translations];
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
      notifyNextUpdate(this.controller, this.sp, "Faction menu: press Escape to leave the chat box, then G.");
      return;
    }

    // If an "add member" is pending, this press picks the player to add.
    if (this.pendingAdd) {
      this.pendingAdd = false;
      const ref = this.sp.Game.getCurrentCrosshairRef();
      const recipient = ref && Actor.from(ref) ? ref : null;
      if (!recipient || recipient.getFormID() === 0x14) {
        notifyNextUpdate(this.controller, this.sp, strings.addCancelled);
        return;
      }
      this.sendRequest({ action: "add", recipient: localIdToRemoteId(recipient.getFormID()) });
      return;
    }

    if (this.menuOpen) {
      return;
    }
    // Ask the server for the roster; it decides whether we may manage a hold.
    notifyNextUpdate(this.controller, this.sp, "Requesting your hold roster…");
    sendCustomPacket(this.controller, { customPacketType: "factionMenuRequest" });
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
        // Sanitize the roster: skip non-objects, coerce profileId to number so the setter cannot throw.
        const rawMembers = Array.isArray(content["members"]) ? content["members"] : [];
        members = [];
        for (let i = 0; i < rawMembers.length; i++) {
          const m: any = rawMembers[i];
          if (!m || typeof m !== "object") {
            continue;
          }
          const profileId = Number(m.profileId);
          if (isNaN(profileId)) {
            continue;
          }
          members.push({
            profileId,
            name: String(m.name ?? ''),
            rank: typeof m.rank === "string" ? m.rank : undefined,
            online: m.online !== false,
          });
        }
        regents = this.sanitizeRegents(content["regents"]);
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
          notifyNextUpdate(this.controller, this.sp, content["text"]);
        }
        break;
      default:
        break;
    }
  }

  private sanitizeRegents(raw: unknown): RegentInfo {
    const r: any = raw && typeof raw === "object" ? raw : {};
    const line: { profileId: number; name?: string }[] = [];
    if (Array.isArray(r.line)) {
      for (const e of r.line) {
        const profileId = Number(e && e.profileId);
        if (!isNaN(profileId) && profileId) {
          line.push({ profileId, name: String((e && e.name) ?? '') });
        }
      }
    }
    return {
      line,
      activeProfileId: Number(r.activeProfileId) || null,
      actingName: typeof r.actingName === "string" ? r.actingName : null,
      canManage: r.canManage === true,
    };
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
        notifyNextUpdate(this.controller, this.sp, strings.lookAtNewMember);
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
      case events.regentAdd:
        this.sendRequest({ action: "regentadd", profileId });
        break;
      case events.regentRemove:
        this.sendRequest({ action: "regentremove", profileId });
        break;
      case events.regentUp:
        this.sendRequest({ action: "regentup", profileId });
        break;
      case events.regencyGrant:
        this.sendRequest({ action: "regencygrant", profileId });
        break;
      case events.regencyRevoke:
        this.sendRequest({ action: "regencyrevoke" });
        break;
      case events.close:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private sendRequest(payload: Record<string, unknown>): void {
    sendCustomPacket(this.controller, { customPacketType: "factionRequest", ...payload });
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({ events, strings, title, members, regents })
    );
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeWidget(this.sp, 9);
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  // No spread syntax: it breaks after FunctionInfo stringification (see commit 8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget: any = {
      type: "form",
      id: 9,
      caption: title || strings.title,
      elements: [] as any[],
    };
    const inLine = (profileId: number) => {
      for (let i = 0; i < regents.line.length; i++) {
        if (regents.line[i].profileId === profileId) return true;
      }
      return false;
    };

    widget.elements.push({
      type: "button",
      text: strings.addMember,
      tags: [],
      click: () => window.skyrimPlatform.sendMessage(events.add),
    });

    if (regents.actingName) {
      widget.elements.push({ type: "text", text: strings.actingLeader + ": " + regents.actingName, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
    }

    if (members.length === 0) {
      widget.elements.push({ type: "text", text: strings.empty, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
    } else {
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        let label = (m.name || `#${m.profileId}`) + (m.rank ? ` - ${m.rank}` : "");
        if (m.online === false) label += ` (${strings.offline})`;
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
        if (regents.canManage && !inLine(m.profileId)) {
          widget.elements.push({
            type: "button",
            text: strings.regentAdd,
            tags: ["ELEMENT_SAME_LINE"],
            click: () => window.skyrimPlatform.sendMessage(events.regentAdd, m.profileId),
          });
        }
      }
    }

    if (regents.line.length > 0) {
      widget.elements.push({ type: "text", text: strings.regentLine + ":", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
      for (let i = 0; i < regents.line.length; i++) {
        const r = regents.line[i];
        const active = regents.activeProfileId === r.profileId;
        let label = (i + 1) + ". " + (r.name || `#${r.profileId}`);
        if (active) label += " (" + strings.activeRegent + ")";
        widget.elements.push({ type: "text", text: label, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
        if (regents.canManage) {
          widget.elements.push({
            type: "button",
            text: strings.regentUp,
            tags: [],
            click: () => window.skyrimPlatform.sendMessage(events.regentUp, r.profileId),
          });
          widget.elements.push({
            type: "button",
            text: strings.remove,
            tags: ["ELEMENT_SAME_LINE"],
            click: () => window.skyrimPlatform.sendMessage(events.regentRemove, r.profileId),
          });
          widget.elements.push({
            type: "button",
            text: active ? strings.regencyRevoke : strings.regencyGrant,
            tags: ["ELEMENT_SAME_LINE"],
            click: () => window.skyrimPlatform.sendMessage(active ? events.regencyRevoke : events.regencyGrant, r.profileId),
          });
        }
      }
    }

    widget.elements.push({
      type: "button",
      text: strings.close,
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.close),
    });

    // Preserve any other widgets
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== 9);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.G;
  private menuOpen = false;
  private pendingAdd = false;
}
