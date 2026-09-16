import { CombinedController, Sp } from "./clientListener";

// Papyrus natives are allowed only inside update tasks such as menuOpen or update handlers
export function closeGameMenu(sp: Sp, menu: string): void {
  sp.callNative("TESModPlatform", "CloseMenu", undefined, menu);
}

// Closes the menus as they open, with a per-update backstop for one opened before the listener existed or reopened between events
export function keepMenusClosed(sp: Sp, controller: CombinedController, menus: string[], onBlocked?: () => void): void {
  const close = (menu: string) => closeGameMenu(sp, menu);
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
