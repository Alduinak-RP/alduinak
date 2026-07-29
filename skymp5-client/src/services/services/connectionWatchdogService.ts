import { ClientListener, CombinedController, Sp } from "./clientListener";
import { Menu } from "skyrimPlatform";
import { NetworkingService } from "./networkingService";
import { SinglePlayerService } from "./singlePlayerService";
import { showSystemNotification } from "./systemNotification";
import { logTrace } from "../../logging";

// Returns the player to the main menu when the server stays unreachable.
// NetworkingService auto-reconnects forever; this adds the give-up path so players are not stuck in a frozen world.

const QUIT_AFTER_MS = 60000;

export class ConnectionWatchdogService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("connectionDisconnect", () => this.onConnectionLost());
    this.controller.emitter.on("connectionFailed", () => this.onConnectionLost());
    this.controller.emitter.on("connectionAccepted", () => this.onConnectionRestored());
    this.controller.on("tick", () => this.onTick());
  }

  private downSince = 0;
  private quitQueued = false;

  private onConnectionLost() {
    if (this.downSince) return;
    this.downSince = Date.now();
    logTrace(this, "Connection lost, watchdog armed");
    showSystemNotification(this.sp, "Connection to the server lost, reconnecting...");
  }

  private onConnectionRestored() {
    if (this.downSince) showSystemNotification(this.sp, "Connection restored.");
    this.downSince = 0;
    this.quitQueued = false;
  }

  private onTick() {
    if (!this.downSince || this.quitQueued) return;
    if (Date.now() - this.downSince < QUIT_AFTER_MS) return;
    if (this.controller.lookupListener(SinglePlayerService).isSinglePlayer) return;
    this.quitQueued = true;
    // "update" doesn't fire in the main menu, so re-check everything on fire
    this.controller.once("update", () => {
      if (!this.downSince) return;
      if (this.controller.lookupListener(SinglePlayerService).isSinglePlayer) return;
      if (this.controller.lookupListener(NetworkingService).isConnected()) return;
      try {
        if (this.sp.Ui.isMenuOpen(Menu.Main)) return;
      } catch { }
      logTrace(this, "Server unreachable for 60s, quitting to main menu");
      showSystemNotification(this.sp, "Could not reach the server, returning to the main menu.");
      this.sp.Game.quitToMainMenu();
    });
  }
}
