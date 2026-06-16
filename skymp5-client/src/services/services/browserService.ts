
// TODO: send event instead of direct dependency on FormView class
import { FormView } from "../../view/formView";
import { QueryKeyCodeBindings } from "../events/queryKeyCodeBindings";

import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, DxScanCode, Menu, MenuCloseEvent, MenuOpenEvent } from "skyrimPlatform";

const unfocusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserUnfocused', {}))`;
const focusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserFocused', {}))`;

export class BrowserService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.sp.browser.setVisible(false);

    // Key bindings are configurable from the launcher's client settings so
    // server owners can rebind them. Defaults: F6 frees/locks the cursor,
    // Enter and T focus the chat widget for typing.
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings) {
        if (typeof settings["freeCursorKeyCode"] === "number") {
          this.freeCursorKey = settings["freeCursorKeyCode"];
        }
        if (Array.isArray(settings["chatFocusKeyCodes"])) {
          const codes = settings["chatFocusKeyCodes"].filter((c: unknown) => typeof c === "number");
          if (codes.length > 0) {
            this.chatFocusKeys = codes as DxScanCode[];
          }
        }
      }
    } catch {
      // fall back to defaults
    }

    this.controller.emitter.on("queryKeyCodeBindings", (e) => this.onQueryKeyCodeBindings(e));
    this.controller.once("update", () => this.onceUpdate());
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.on("menuClose", (e) => this.onMenuClose(e));
  }

  // TODO: keycodes should be configurable
  private onQueryKeyCodeBindings(e: QueryKeyCodeBindings) {
    if (e.isDown([DxScanCode.F1])) {
      FormView.isDisplayingNicknames = !FormView.isDisplayingNicknames;
    }
    if (e.isDown([DxScanCode.F2])) {
      this.sp.browser.setVisible(!this.sp.browser.isVisible());
    }
    if (this.badMenusOpen.size === 0 && e.isDown([this.freeCursorKey])) {
      const newState = !this.sp.browser.isFocused();
      this.sp.browser.setFocused(newState);
      if (newState) {
        this.sp.browser.executeJavaScript(focusEventString);
      } else {
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
    }
    if (this.badMenusOpen.size === 0 && !this.sp.browser.isFocused() &&
        this.chatFocusKeys.some((key) => e.isDown([key]))) {
      this.sp.browser.setFocused(true);
      this.sp.browser.executeJavaScript(focusEventString);
    }
    if (e.isDown([DxScanCode.Escape])) {
      if (this.sp.browser.isFocused()) {
        this.sp.browser.setFocused(false);
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
    }
  }

  private onceUpdate() {
    this.sp.browser.setVisible(true);
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const onFrontLoadedEventKey = "front-loaded";

    if (e.arguments[0] === onFrontLoadedEventKey) {
      this.controller.emitter.emit("browserWindowLoaded", {});
    }
  }

  private onMenuOpen(e: MenuOpenEvent) {
    if (this.isBadMenu(e.name)) {
      this.sp.browser.setVisible(false);
      this.badMenusOpen.add(e.name);
    } else if (e.name === Menu.HUD) {
      this.sp.browser.setVisible(true);
    }
  }

  private onMenuClose(e: MenuCloseEvent) {
    if (this.badMenusOpen.delete(e.name)) {
      if (this.badMenusOpen.size === 0) {
        this.sp.browser.setVisible(true);
      }
    }

    if (e.name === Menu.HUD) {
      this.sp.browser.setVisible(false);
    }
  }

  private isBadMenu(menu: string) {
    return this.badMenus.includes(menu as Menu);
  }

  private badMenusOpen = new Set<string>();

  private freeCursorKey: DxScanCode = DxScanCode.F6;
  private chatFocusKeys: DxScanCode[] = [DxScanCode.Enter, DxScanCode.T];

  private readonly badMenus: Menu[] = [
    Menu.Barter,
    Menu.Book,
    Menu.Container,
    Menu.Crafting,
    Menu.Gift,
    Menu.Inventory,
    Menu.Journal,
    Menu.Lockpicking,
    Menu.Loading,
    Menu.Map,
    Menu.RaceSex,
    Menu.Stats,
    Menu.Tween,
    Menu.Console,
    Menu.Main,
  ];
}
