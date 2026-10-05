import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { closeGameMenu } from "./menuBlockUtil";
import { BrowserService } from "./browserService";
import { WRITTEN_KEYWORD } from "../../sync/inventory";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, EquipEvent, Form, Menu } from "skyrimPlatform";
import { logToPlatformLog } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 33;
const PLAYER_FORM_ID = 0x14;
const BLANK_KEYWORD = "AldWritingBlank";
// The vanilla Book Menu opens just before or just after the equip event
const BOOK_MENU_WINDOW_MS = 1500;
// The widget waits this long for the inventory to close before giving up
const OPEN_WAIT_MS = 5000;
// Vanilla menus that hide the browser and are closed for the widget
const COVERING_MENUS: string[] = [Menu.Book, Menu.Inventory, Menu.Tween];
// SkyUI's inventory list selection; formId is the base, text the item's name
const SELECTED_ENTRY = "_root.Menu_mc.inventoryLists.itemList.selectedEntry";

const events = {
  create: "writing:create",
  save: "writing:save",
  finish: "writing:finish",
  seal: "writing:seal",
  breakSeal: "writing:break",
  copy: "writing:copy",
  burn: "writing:burn",
  open: "writing:open",
  close: "writing:close",
};

// Browser events that only carry a document id, by the packet they become
const ID_PACKETS: Record<string, string> = {
  [events.finish]: "writingFinish",
  [events.seal]: "writingSeal",
  [events.breakSeal]: "writingBreak",
  [events.copy]: "writingCopy",
  [events.burn]: "writingBurn",
  [events.open]: "writingOpen",
};

// Module-level so the browser-side widget setter can read it (runtime injection)
let menu: Record<string, unknown> = {};

// Reading a writing in the pack asks writingSystem.ts for its view and shows it in the 'writing' widget; protocol in docs/docs_roleplay_writing.md
export class WritingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("equip", (e) => this.onEquip(e));
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Book && Date.now() < this.closeBookUntil) closeGameMenu(this.sp, Menu.Book);
    });
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    onCustomPacket(this.controller, ["writingMenu", "writingClosed"], (content) => this.onCustomPacketMessage(content));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
    onWidgetsCleared(this.controller, () => {
      if (!this.menuOpen) return;
      this.menuOpen = false;
      sendCustomPacket(this.controller, { customPacketType: "writingClose" });
    });
  }

  private onEquip(e: EquipEvent): void {
    let baseId = 0;
    try {
      if (e.actor && e.baseObj && e.actor.getFormID() === PLAYER_FORM_ID && this.isWriting(e.baseObj)) baseId = e.baseObj.getFormID();
    } catch {
      // stale event object
    }
    if (!baseId) return;
    const fromChest = this.sp.Ui.isMenuOpen(Menu.Container);
    this.closeBookUntil = Date.now() + BOOK_MENU_WINDOW_MS;
    this.controller.once("update", () => {
      closeGameMenu(this.sp, Menu.Book);
      if (fromChest) {
        notifyNextUpdate(this.controller, this.sp, "Take the writing into your pack to read it.");
      }
    });
    if (fromChest) return;
    const name = this.pickedName(baseId);
    logToPlatformLog(this, `reading ${baseId.toString(16)} from the pack, ${name ? `selected entry ${JSON.stringify(name)}` : "selected entry unread"}`);
    sendCustomPacket(this.controller, { customPacketType: "writingUse", baseId, name });
  }

  // The inventory list entry the player read, so the server opens that copy; "" when the list shows another form or cannot be read
  private pickedName(baseId: number): string {
    try {
      const ui = this.sp.Ui;
      if (!ui.isMenuOpen(Menu.Inventory) || ui.getInt(Menu.Inventory, `${SELECTED_ENTRY}.formId`) >>> 0 !== baseId >>> 0) return "";
      return ui.getString(Menu.Inventory, `${SELECTED_ENTRY}.text`) || "";
    } catch {
      return "";
    }
  }

  // Blank or written: reading one is this service's, never the vanilla Book Menu's
  isWriting(form: Form): boolean {
    const id = form.getFormID();
    let known = this.writingBases.get(id);
    if (known === undefined) {
      known = [WRITTEN_KEYWORD, BLANK_KEYWORD].some((name) => {
        const keyword = this.sp.Keyword.getKeyword(name);
        return !!keyword && form.hasKeyword(keyword);
      });
      this.writingBases.set(id, known);
    }
    return known;
  }

  // A reply opens the widget once the inventory and the vanilla book are out of the way
  private onUpdate(): void {
    if (!this.pendingSince) return;
    if (Date.now() - this.pendingSince > OPEN_WAIT_MS) {
      this.pendingSince = 0;
      return;
    }
    const covering = COVERING_MENUS.filter((name) => this.sp.Ui.isMenuOpen(name));
    if (covering.length) {
      covering.forEach((name) => closeGameMenu(this.sp, name));
      return;
    }
    if (this.controller.lookupListener(BrowserService).isBlockingMenuOpen()) return;
    this.pendingSince = 0;
    this.openMenu();
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.isDown && this.menuOpen && buttonEventKeyCode(e) === DxScanCode.Escape) this.closeMenu();
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    if (content["customPacketType"] === "writingMenu") {
      // The front ends an edit on the reply that follows a save
      menu = { ...content, seq: ++this.menuSeq };
      if (this.menuOpen) this.openMenu();
      else this.pendingSince = Date.now();
    } else if (content["customPacketType"] === "writingClosed") {
      this.pendingSince = 0;
      if (this.menuOpen) this.closeMenu();
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("writing:") || !this.menuOpen) return;
    const arg = (i: number): string => (typeof e.arguments[i] === "string" ? e.arguments[i] as string : "");
    if (key === events.close) {
      this.closeMenu();
    } else if (key === events.create) {
      sendCustomPacket(this.controller, { customPacketType: "writingCreate", title: arg(1), pages: this.pagesOf(arg(2)), signed: e.arguments[3] === true });
    } else if (key === events.save) {
      sendCustomPacket(this.controller, { customPacketType: "writingSave", id: arg(1), title: arg(2), pages: this.pagesOf(arg(3)) });
    } else if (ID_PACKETS[key]) {
      sendCustomPacket(this.controller, { customPacketType: ID_PACKETS[key], id: arg(1) });
    }
  }

  // The front sends the pages as a JSON string; anything else is an empty writing the server refuses
  private pagesOf(json: string): string[] {
    try {
      const pages = JSON.parse(json);
      return Array.isArray(pages) ? pages.filter((p) => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, menu, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
    sendCustomPacket(this.controller, { customPacketType: "writingClose" });
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget = { type: "writing", id: WIDGET_ID, menu: menu, events: events };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private writingBases = new Map<number, boolean>();
  private menuOpen = false;
  private menuSeq = 0;
  private pendingSince = 0;
  private closeBookUntil = 0;
}
