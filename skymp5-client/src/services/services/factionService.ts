import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 9;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  invite: "faction:invite",
  close: "faction:close",
};

interface InviteOption {
  factionId: string;
  name: string;
  ranks: { slug: string; name: string }[];
}

// Module-level state shared with the browser-side widget setter via runtime injection
let inviteTitle = "";
let inviteOptions: InviteOption[] = [];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Faction membership on the client. The Personal Menu's Faction tab (AdminMenuService) shows rosters and rank actions; this
 * service keeps the player's faction state, which unlocks the chat's Faction tab and the interaction menu's Invite to faction,
 * opens the rank picker for an invitation and shows faction notices. Server side: skymp5-server factionSystem.ts.
 *
 *   Server -> Client:
 *     { "customPacketType": "factionState", "factions": [{ "id", "name" }], "chat": "hold:whiterun", "canInvite": true }
 *     { "customPacketType": "factionInviteOptions", "target", "targetName", "options": [{ "factionId", "name", "ranks": [{ "slug", "name" }] }] }
 *     { "customPacketType": "factionNotice", "text": "Lydia is now Guard." }
 *   Client -> Server:
 *     { "customPacketType": "factionRequest", "action": "invite", "factionId", "rank", "target" }
 */
export class FactionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; });
  }

  get canInvite(): boolean {
    return this.inviteAllowed;
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.isDown && this.menuOpen && buttonEventKeyCode(e) === DxScanCode.Escape) {
      this.closeMenu();
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "factionState": {
        this.inviteAllowed = content["canInvite"] === true;
        const member = Array.isArray(content["factions"]) && content["factions"].length > 0;
        // Native calls are unsafe in the packet handler
        this.controller.once("update", () => this.sp.browser.executeJavaScript(`window.__alduinakFaction = ${member ? "true" : "false"};`));
        break;
      }
      case "factionInviteOptions": {
        const raw = Array.isArray(content["options"]) ? content["options"] : [];
        inviteOptions = raw
          .filter((o: any) => o && typeof o === "object" && Array.isArray(o.ranks))
          .map((o: any) => ({
            factionId: str(o.factionId),
            name: str(o.name),
            ranks: o.ranks.filter((r: any) => r && typeof r.slug === "string").map((r: any) => ({ slug: r.slug, name: str(r.name) || r.slug })),
          }))
          .filter((o: InviteOption) => o.factionId && o.ranks.length);
        this.target = Number(content["target"]) || 0;
        inviteTitle = `Invite ${str(content["targetName"]) || "them"}`;
        if (this.target && inviteOptions.length) this.controller.once("update", () => this.openMenu());
        break;
      }
      case "factionNotice":
        if (typeof content["text"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["text"]);
        }
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (key === "menu:escape" || key === events.close) {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (key !== events.invite || !this.menuOpen) return;
    sendCustomPacket(this.controller, {
      customPacketType: "factionRequest",
      action: "invite",
      factionId: str(e.arguments[1]),
      rank: str(e.arguments[2]),
      target: this.target,
    });
    this.closeMenu();
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, inviteTitle, inviteOptions, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  // No spread syntax: it breaks after FunctionInfo stringification (see commit 8d7c0c05).
  private browsersideWidgetSetter = () => {
    const elements: any[] = [];
    for (let i = 0; i < inviteOptions.length; i++) {
      const option = inviteOptions[i];
      elements.push({ type: "text", text: option.name, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
      for (let j = 0; j < option.ranks.length; j++) {
        const rank = option.ranks[j];
        elements.push({
          type: "button",
          text: rank.name,
          tags: [],
          click: () => window.skyrimPlatform.sendMessage(events.invite, option.factionId, rank.slug),
        });
      }
    }
    elements.push({ type: "button", text: "Cancel", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.close) });
    const widget = { type: "form", id: WIDGET_ID, caption: inviteTitle, elements };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private target = 0;
  private inviteAllowed = false;
}
