import { Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";

// Read from the engine when the service starts and on a load; any other menu is known from its first menuOpen
const SEEDED_MENUS: string[] = [
  Menu.Inventory, Menu.Favorites, Menu.Magic, Menu.Container, Menu.Crafting, Menu.RaceSex, Menu.Loading, Menu.Main,
];

const openMenus = new Set<string>();

// One update behind the engine, since menuOpen and menuClose arrive as update tasks
export function isMenuShown(name: string): boolean {
  return openMenus.has(name);
}

// Registered first, so every other menu handler and update callback reads the state already changed
export class MenuStateService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("menuOpen", (e) => openMenus.add(e.name));
    this.controller.on("menuClose", (e) => openMenus.delete(e.name));
    // Services are built on tick, where natives are unsafe
    this.controller.once("update", () => this.resync());
    // A load may close menus without a menuClose
    this.controller.on("loadGame", () => this.resync());
  }

  private resync(): void {
    const names = new Set(SEEDED_MENUS.concat(Array.from(openMenus)));
    names.forEach((name) => {
      if (this.sp.Ui.isMenuOpen(name)) openMenus.add(name);
      else openMenus.delete(name);
    });
  }
}
