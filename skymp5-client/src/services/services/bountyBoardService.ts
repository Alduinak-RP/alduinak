import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 26;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  post: 'bountyBoard:post',
  close: 'bountyBoard:close',
};

interface BoardNote {
  id: number;
  author: string;
  text: string;
  ageHours: number;
}

// The server's bountyBoardMenu reply, mirrored into the widget.
interface BoardInfo {
  board: number;
  boardName: string;
  costGold: number;
  gold: number;
  maxTextLen: number;
  maxNotes: number;
  expiryDays: number;
  notes: BoardNote[];
}

// Module-level so the browser-side widget setter can read it (runtime injection).
let info: BoardInfo = {
  board: 0, boardName: "", costGold: 100, gold: 0,
  maxTextLen: 500, maxNotes: 40, expiryDays: 7, notes: [],
};

/**
 * Bounty board menu (default N, at a board). The Missives board activator is
 * an unnamed primitive the engine will not offer an activate prompt for, so
 * the key asks the server to open whichever board is within reach; the server
 * checks proximity and pushes the menu. Reading is free; pinning a notice
 * costs gold, taken server-side.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "bountyBoardOpenRequest" }
 *   Server -> Client: { "customPacketType": "bountyBoardMenu", "board",
 *                       "boardName", "reason", "costGold", "gold",
 *                       "maxTextLen", "maxNotes", "expiryDays", "notes" }
 *   Client -> Server: { "customPacketType": "bountyBoardPost", "board", "text" }
 *   Client -> Server: { "customPacketType": "bountyBoardClose" }
 *   Server -> Client: { "customPacketType": "bountyBoardNotice", "text" }
 */
export class BountyBoardService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // A front reload drops the widget without a close message; the server
    // still holds a board session, so close that too.
    this.controller.emitter.on("browserWindowLoaded", () => {
      if (!this.menuOpen) return;
      this.menuOpen = false;
      sendCustomPacket(this.controller, { customPacketType: "bountyBoardClose" });
    });

    this.menuKey = readMenuKeyCode(this.sp, "bountyBoardMenuKeyCode", DxScanCode.N);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // Gamepad idCodes are bitmasks that alias onto keyboard scancodes
    if (e.device !== InputDeviceType.Keyboard) return;
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) return;
    if (isMenuHotkeyBlocked(this.sp, this.controller)) return;
    sendCustomPacket(this.controller, { customPacketType: "bountyBoardOpenRequest" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "bountyBoardMenu": {
        const notes = Array.isArray(content["notes"]) ? content["notes"] : [];
        info = {
          board: Number(content["board"]) || 0,
          boardName: typeof content["boardName"] === "string" ? content["boardName"] as string : "",
          costGold: Number(content["costGold"]) || 0,
          gold: Number(content["gold"]) || 0,
          maxTextLen: Number(content["maxTextLen"]) || 500,
          maxNotes: Number(content["maxNotes"]) || 40,
          expiryDays: Number(content["expiryDays"]) || 7,
          notes: notes as BoardNote[],
        };
        // A refresh (someone posted) updates the open menu but must never
        // force a closed one open; only an activation reply opens it.
        if (content["reason"] === "open") {
          logTrace(this, `Opening board`, info.boardName);
          this.openMenu();
        } else if (this.menuOpen) {
          this.openMenu();
        }
        break;
      }
      case "bountyBoardNotice":
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
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("bountyBoard:") || !this.menuOpen) return;

    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.post) {
      const text = typeof e.arguments[1] === "string" ? (e.arguments[1] as string).trim() : "";
      if (text) {
        sendCustomPacket(this.controller, { customPacketType: "bountyBoardPost", board: info.board, text });
      }
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, WIDGET_ID });
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
    // The server keeps a per-player board session; tell it we walked away.
    sendCustomPacket(this.controller, { customPacketType: "bountyBoardClose" });
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "bountyBoard",
      id: WIDGET_ID,
      boardName: info.boardName,
      costGold: info.costGold,
      gold: info.gold,
      maxTextLen: info.maxTextLen,
      maxNotes: info.maxNotes,
      expiryDays: info.expiryDays,
      notes: info.notes,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.N;
  private menuOpen = false;
}
