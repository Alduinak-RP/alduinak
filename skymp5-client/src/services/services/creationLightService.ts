import { DxScanCode, Game, MagicEffect, Menu, MenuCloseEvent, MenuOpenEvent, Spell, Ui } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { isConsoleOpen, readMenuKeyCode } from "./widgetMenuUtil";
import { logToPlatformLog } from "../../logging";

// Skyrim.esm SPEL Candlelight (self, fire and forget, 60 s) and its MGEF LightFFSelf
const CANDLELIGHT_SPELL = 0x43324;
const LIGHT_EFFECT = 0x1ea6c;
// Candlelight lasts 60 s; the race menu pauses the engine, so the refresh only counts while the game runs
const REAPPLY_MS = 50000;

// A light for character creation at night: Candlelight is applied locally while the vanilla race menu is open, on by default,
// toggled with the creation light key (launcher creationLightKeyCode, F5) and dispelled on every exit path. Nothing reaches the server:
// SkyrimPlatform only emits spellCast for a spell in the caster's hands, and the server refuses a cast of an unequipped spell anyway.
export class CreationLightService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.key = readMenuKeyCode(sp, "creationLightKeyCode", DxScanCode.F5);
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.on("menuClose", (e) => this.onMenuClose(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("createActorMessage", (e) => { if (e.message.isMe) this.controller.once("update", () => this.end("spawn")); });
    this.controller.emitter.on("connectionDisconnect", () => this.controller.once("update", () => this.end("disconnect")));
    // The template save replaces the player, so an effect applied before a load is gone with it
    this.controller.emitter.on("gameLoad", () => { this.appliedAt = 0; });
  }

  get keyCode(): number {
    return this.key;
  }

  // RemoteServer calls this right before Game.showRaceMenu, while the engine still runs
  onRaceMenuShowing(): void {
    this.on = true;
    this.apply("before menu");
  }

  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.RaceSex) return;
    this.menuOpen = true;
    this.on = true;
    this.keyWasDown = this.sp.Input.isKeyPressed(this.key);
    if (!this.appliedAt) this.apply("menu open");
  }

  private onMenuClose(e: MenuCloseEvent): void {
    if (e.name !== Menu.RaceSex) return;
    this.menuOpen = false;
    this.end("menu close");
  }

  // The page is hidden under the race menu, so the key is polled from the update loop with edge detection
  private onUpdate(): void {
    if (!this.menuOpen) return;
    const down = this.sp.Input.isKeyPressed(this.key);
    if (down && !this.keyWasDown && !this.sp.browser.isFocused() && !isConsoleOpen(this.sp)) {
      this.on = !this.on;
      if (this.on) this.apply("toggled on");
      else this.dispel("toggled off");
    }
    this.keyWasDown = down;
    if (this.on && this.appliedAt && Date.now() - this.appliedAt >= REAPPLY_MS) this.apply("refresh");
  }

  private apply(why: string): void {
    const player = Game.getPlayer();
    const spell = Spell.from(Game.getFormEx(CANDLELIGHT_SPELL));
    if (!player || !spell) return;
    player.doCombatSpellApply(spell, player);
    this.appliedAt = Date.now();
    this.log(`candlelight on (${why})`);
  }

  private dispel(why: string): void {
    const player = Game.getPlayer();
    const spell = Spell.from(Game.getFormEx(CANDLELIGHT_SPELL));
    if (!player || !spell) return;
    this.log(`candlelight off (${why})`);
    player.dispelSpell(spell);
    this.appliedAt = 0;
  }

  private end(why: string): void {
    this.on = false;
    if (this.appliedAt) this.dispel(why);
  }

  private log(text: string): void {
    const effect = MagicEffect.from(Game.getFormEx(LIGHT_EFFECT));
    logToPlatformLog(this, `${text}, race menu ${Ui.isMenuOpen(Menu.RaceSex)}, light effect ${!!Game.getPlayer()?.hasMagicEffect(effect)}`);
  }

  private readonly key: number;
  private on = false;
  private menuOpen = false;
  private keyWasDown = false;
  private appliedAt = 0;
}
