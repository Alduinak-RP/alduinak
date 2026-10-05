import { CombinedController, Sp } from "./clientListener";

// Papyrus natives are allowed only inside update tasks such as menuOpen or update handlers
export function closeGameMenu(sp: Sp, menu: string): void {
  sp.callNative("TESModPlatform", "CloseMenu", undefined, menu);
}

// Closes the menus as they open, and at the first update for one opened before the listener existed; backstopMs polls for one that opens without a menuOpen
export function keepMenusClosed(sp: Sp, controller: CombinedController, menus: string[], options: { onBlocked?: () => void; backstopMs?: number } = {}): void {
  const closeOpen = () => menus.forEach((menu) => {
    if (sp.Ui.isMenuOpen(menu)) closeGameMenu(sp, menu);
  });
  // menuOpen arrives as an update task, so Papyrus natives are allowed here
  controller.on("menuOpen", (e) => {
    if (!menus.includes(e.name)) return;
    closeGameMenu(sp, e.name);
    options.onBlocked?.();
  });
  const { backstopMs } = options;
  if (!backstopMs) {
    controller.once("update", closeOpen);
    return;
  }
  let nextAt = 0;
  controller.on("update", () => {
    const now = Date.now();
    if (now < nextAt) return;
    nextAt = now + backstopMs;
    closeOpen();
  });
}
