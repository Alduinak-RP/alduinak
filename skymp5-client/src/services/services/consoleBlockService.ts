import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CONSOLE_MENUS } from "./widgetMenuUtil";

// Nobody, admins included, may use the local ~ console; admin modes live in the Personal Menu
export class ConsoleBlockService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    // menuOpen arrives as an update task, so Papyrus natives are allowed here
    this.controller.on("menuOpen", (e) => this.close(e.name));
    // Backstop for a console opened before this listener existed or reopened between events
    this.controller.on("update", () => CONSOLE_MENUS.forEach((menu) => {
      if (this.sp.Ui.isMenuOpen(menu)) this.close(menu);
    }));
  }

  private close(menu: string): void {
    if (!CONSOLE_MENUS.includes(menu)) return;
    this.sp.callNative("TESModPlatform", "CloseMenu", undefined, menu);
  }
}
