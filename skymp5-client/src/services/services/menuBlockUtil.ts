import { CombinedController, Sp } from "./clientListener";

// Closes the menus as they open, with a per-update backstop for one opened before the listener existed or reopened between events
export function keepMenusClosed(sp: Sp, controller: CombinedController, menus: string[], onBlocked?: () => void): void {
  const close = (menu: string) => sp.callNative("TESModPlatform", "CloseMenu", undefined, menu);
  // menuOpen arrives as an update task, so Papyrus natives are allowed here
  controller.on("menuOpen", (e) => {
    if (!menus.includes(e.name)) return;
    close(e.name);
    onBlocked?.();
  });
  controller.on("update", () => menus.forEach((menu) => {
    if (sp.Ui.isMenuOpen(menu)) close(menu);
  }));
}
