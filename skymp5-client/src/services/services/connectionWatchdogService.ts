import { ClientListener, CombinedController, Sp } from "./clientListener";
import { KickService } from "./kickService";
import { NetworkingService } from "./networkingService";
import { SinglePlayerService } from "./singlePlayerService";
import { showSystemNotification } from "./systemNotification";
import { logTrace } from "../../logging";

// Paces reconnects after a lost connection: five attempts 10 s apart, then the game closes

const ATTEMPT_EVERY_MS = 10000;
const ATTEMPTS = 5;
const GIVE_UP_MS = 60000;

export class ConnectionWatchdogService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("connectionDisconnect", () => this.onConnectionLost());
    this.controller.emitter.on("connectionFailed", () => this.onConnectionLost());
    this.controller.emitter.on("connectionDenied", () => this.onConnectionLost());
    this.controller.emitter.on("connectionAccepted", () => this.onConnectionRestored());
    // "tick" keeps firing while a pausing menu is open, unlike "update"
    this.controller.on("tick", () => this.onTick());
  }

  private downSince = 0;
  private attemptsMade = 0;
  private everConnected = false;
  private gaveUp = false;

  // A failure inside an attempt's slot is not a new loss
  private onConnectionLost() {
    if (this.downSince) return;
    if (this.controller.lookupListener(NetworkingService).isAutoReconnectBlocked()) return;
    if (this.controller.lookupListener(SinglePlayerService).isSinglePlayer) return;
    this.downSince = Date.now();
    this.attemptsMade = 0;
    logTrace(this, `Connection ${this.everConnected ? "lost" : "not established"}, watchdog armed`);
  }

  private onConnectionRestored() {
    if (this.downSince) {
      logTrace(this, `Connection restored after ${this.attemptsMade} attempts`);
      if (this.attemptsMade > 0) showSystemNotification(this.sp, "Connection restored.");
    }
    this.everConnected = true;
    this.downSince = 0;
    this.attemptsMade = 0;
  }

  // The first attempt runs on the tick after the loss, so a denial blocked by another listener is never retried
  private onTick() {
    if (!this.downSince || this.gaveUp) return;
    const networking = this.controller.lookupListener(NetworkingService);
    // A kick or a permanent denial arrived while armed
    if (networking.isAutoReconnectBlocked()) {
      this.downSince = 0;
      return;
    }
    const elapsed = Date.now() - this.downSince;
    if (this.everConnected && elapsed >= GIVE_UP_MS) return this.giveUp();
    const due = Math.floor(elapsed / ATTEMPT_EVERY_MS) + 1;
    if (due <= this.attemptsMade || (this.everConnected && due > ATTEMPTS)) return;
    this.attemptsMade = due;
    showSystemNotification(this.sp, this.attemptText(due));
    logTrace(this, `Reconnect attempt ${due}`);
    networking.reconnect();
  }

  // A server that was never reached (startup with the server down) is retried without limit
  private attemptText(attempt: number) {
    if (!this.everConnected) return "Could not reach Alduinak. Retrying...";
    return attempt === 1
      ? `Connection to Alduinak lost. Reconnecting (1/${ATTEMPTS})...`
      : `Still reconnecting (${attempt}/${ATTEMPTS})...`;
  }

  private giveUp() {
    if (this.controller.lookupListener(NetworkingService).isConnected()) return;
    this.gaveUp = true;
    logTrace(this, "Server unreachable for a minute, closing the game");
    const kick = this.controller.lookupListener(KickService);
    kick.showDisconnectedAndExit(kick.strings.unreachable);
  }
}
