import { DxScanCode, Game, Menu, MenuCloseEvent, MenuOpenEvent, ObjectReference, Ui } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserService } from "./browserService";
import { closeWidget, isConsoleOpen, keyLabel, readMenuKeyCode, refreshFormMenu } from "./widgetMenuUtil";
import { logToPlatformLog } from "../../logging";

// Skyrim.esm LIGH MagicLightLightSpell01, the light Candlelight and Magelight carry (radius 450)
const LIGHT_BASE = 0x3fa58;
// In front of the face and above it, the side the race menu camera looks from
const LIGHT_FORWARD = 90;
const LIGHT_UP = 150;
// The race menu pauses the engine, so the light is placed this long before it opens and its 3D loads while the game still runs
const LIGHT_SETTLE_MS = 400;
const HINT_WIDGET_ID = 41;

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

// Module-level so the browser-side widget setter can read it (runtime injection)
let hintText = "";

// A light for character creation at night: a light reference is placed in front of the player before the vanilla race menu opens,
// on by default, toggled with the creation light key (launcher creationLightKeyCode, F5) and deleted on every exit path, and a hint
// in the bottom right corner names the key while the menu is open. A spell effect on the player would not start under the paused
// menu, a placed light needs no actor update. Nothing reaches the server.
export class CreationLightService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.key = readMenuKeyCode(sp, "creationLightKeyCode", DxScanCode.F5);
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.on("menuClose", (e) => this.onMenuClose(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("createActorMessage", (e) => { if (e.message.isMe) this.controller.once("update", () => this.end("spawn")); });
    this.controller.emitter.on("connectionDisconnect", () => this.controller.once("update", () => this.end("disconnect")));
    // A load replaces the world, placed references included
    this.controller.emitter.on("gameLoad", () => { this.lightId = 0; });
  }

  get keyCode(): number {
    return this.key;
  }

  // RemoteServer hands over the race menu opening, which runs once the light had time to load, and whether its creation is still pending
  placeBeforeMenu(openMenu: () => void, pending: () => boolean): void {
    this.on = true;
    this.place("before menu");
    this.openMenu = openMenu;
    this.openAt = Date.now() + LIGHT_SETTLE_MS;
    this.pending = pending;
  }

  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.RaceSex) return;
    this.menuOpen = true;
    this.on = true;
    this.keyWasDown = this.sp.Input.isKeyPressed(this.key);
    if (!this.lightRef()) this.place("menu open");
    this.showHint(true);
    this.log("race menu open");
  }

  private onMenuClose(e: MenuCloseEvent): void {
    if (e.name !== Menu.RaceSex) return;
    this.menuOpen = false;
    this.end("menu close");
  }

  // The page never has focus under the race menu, so the key is polled from the update loop with edge detection
  private onUpdate(): void {
    // A creation dropped before its menu opened (retries given up, the server's close) takes its light along
    if (this.pending && !this.menuOpen && !this.pending()) this.end("creation dropped");
    if (this.openMenu && Date.now() >= this.openAt) {
      const open = this.openMenu;
      this.openMenu = null;
      open();
    }
    if (!this.menuOpen) return;
    const down = this.sp.Input.isKeyPressed(this.key);
    if (down && !this.keyWasDown && !this.sp.browser.isFocused() && !isConsoleOpen(this.sp)) {
      this.on = !this.on;
      const light = this.lightRef();
      if (this.on && !light) this.place("toggled on");
      else if (this.on) light?.enableNoWait(false);
      else light?.disableNoWait(false);
      this.log(this.on ? "toggled on" : "toggled off");
    }
    this.keyWasDown = down;
  }

  private place(why: string): void {
    const player = Game.getPlayer();
    const base = Game.getFormEx(LIGHT_BASE);
    if (!player || !base) return;
    let light = this.lightRef();
    if (!light) {
      light = player.placeAtMe(base, 1, false, false);
      if (!light) {
        this.log(`light not placed (${why})`);
        return;
      }
      this.lightId = light.getFormID();
    }
    const angle = player.getAngleZ() * Math.PI / 180;
    light.setPosition(player.getPositionX() + Math.sin(angle) * LIGHT_FORWARD, player.getPositionY() + Math.cos(angle) * LIGHT_FORWARD, player.getPositionZ() + LIGHT_UP);
    light.enableNoWait(false);
    this.log(`light placed (${why})`);
  }

  private end(why: string): void {
    this.on = false;
    this.openMenu = null;
    this.pending = null;
    this.showHint(false);
    const light = this.lightRef();
    if (!light) return;
    this.log(`light removed (${why})`);
    light.disableNoWait(false);
    light.delete();
    this.lightId = 0;
  }

  private lightRef(): ObjectReference | null {
    if (!this.lightId) return null;
    const light = ObjectReference.from(Game.getFormEx(this.lightId));
    if (!light || light.isDeleted()) {
      this.lightId = 0;
      return null;
    }
    return light;
  }

  // The page stays hidden under the race menu except for this hint
  private showHint(show: boolean): void {
    if (show === this.hintShown) return;
    this.hintShown = show;
    if (show) {
      hintText = `Press ${keyLabel(this.key)} to toggle the light`;
      refreshFormMenu(this.sp, this.hintWidgetSetter, { hintText, HINT_WIDGET_ID });
    } else {
      closeWidget(this.sp, HINT_WIDGET_ID);
    }
    this.controller.lookupListener(BrowserService).setVisibleOver(Menu.RaceSex, show);
  }

  // Runs inside the CEF browser; only the injected vars and window exist here, no spread syntax
  private hintWidgetSetter = () => {
    const widget = { type: "creationHint", id: HINT_WIDGET_ID, text: hintText };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== HINT_WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private log(text: string): void {
    const light = this.lightRef();
    const state = light ? `3D ${light.is3DLoaded()}, disabled ${light.isDisabled()}` : "no light";
    logToPlatformLog(this, `${text}, race menu ${Ui.isMenuOpen(Menu.RaceSex)}, on ${this.on}, ${state}`);
  }

  private readonly key: number;
  private on = false;
  private menuOpen = false;
  private keyWasDown = false;
  private lightId = 0;
  private hintShown = false;
  private openMenu: (() => void) | null = null;
  private openAt = 0;
  private pending: (() => boolean) | null = null;
}
