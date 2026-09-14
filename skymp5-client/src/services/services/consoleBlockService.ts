import { logError } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CONSOLE_MENUS } from "./widgetMenuUtil";

// Refused when they run, which also covers a console open for a frame, the main menu, bat files, sStartingConsoleCommand and ConsoleUtil
const BLOCKED_COMMANDS = [
  "tgm", "tcl", "tfc", "tim", "tai", "tcai", "tdetect", "tm", "tfow", "tmm", "twf", "sgtm",
  "coc", "cow", "setgs", "setini", "setav", "modav", "forceav", "restoreav",
  "setlevel", "advlevel", "advskill", "incpcs", "psb", "addspell", "addperk", "addshout", "teachword", "unlockword",
  "removeitem", "removeallitems", "unlock", "lock", "kill", "killall", "resurrect", "setessential", "enable",
  "moveto", "setpos", "setangle", "setscale", "playidle", "sae", "bat", "fov", "sucsm",
  "sexchange", "setrace", "showracemenu", "enableplayercontrols",
];

// Nobody, admins included, may use the local ~ console; admin modes live in the Personal Menu
export class ConsoleBlockService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.blockCommands();
    // menuOpen arrives as an update task, so Papyrus natives are allowed here
    this.controller.on("menuOpen", (e) => this.close(e.name));
    // Backstop for a console opened before this listener existed or reopened between events
    this.controller.on("update", () => CONSOLE_MENUS.forEach((menu) => {
      if (this.sp.Ui.isMenuOpen(menu)) this.close(menu);
    }));
  }

  // Papyrus natives never dispatch through these entries, so admin God and NoClip keep working
  private blockCommands(): void {
    for (const name of BLOCKED_COMMANDS) {
      const command = this.sp.findConsoleCommand(name);
      if (command) command.execute = () => false;
      else logError(this, `command`, name, `was null in blockCommands`);
    }
  }

  private close(menu: string): void {
    if (!CONSOLE_MENUS.includes(menu)) return;
    this.sp.callNative("TESModPlatform", "CloseMenu", undefined, menu);
  }
}
