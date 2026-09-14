import { logError } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { keepMenusClosed } from "./menuBlockUtil";
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
    keepMenusClosed(this.sp, this.controller, CONSOLE_MENUS);
  }

  // Papyrus natives never dispatch through these entries, so admin God and NoClip keep working
  private blockCommands(): void {
    for (const name of BLOCKED_COMMANDS) {
      const command = this.sp.findConsoleCommand(name);
      if (command) command.execute = () => false;
      else logError(this, `command`, name, `was null in blockCommands`);
    }
  }
}
