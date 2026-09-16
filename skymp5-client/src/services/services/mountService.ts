import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { notifyNextUpdate, parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { isRemoteHostedByMe, remoteIdToLocalId } from "../../view/worldViewMisc";
import { Movement } from "../../sync/movement";
import { RemoteServer } from "./remoteServer";
import { logError, logTrace } from "../../logging";

type Phase = "idle" | "waitHost" | "waitMount" | "mounted";

const POLL_MS = 130;
const HOST_WAIT_MS = 1500;
const MOUNT_WAIT_MS = 3000;
const HORSE_LOST_MS = 2000;
// How long the climb off the horse is given before another Dismount is sent
const DISMOUNT_WAIT_MS = 3000;

// Rider side of horse riding (skymp5-server petSystem.ts mount handshake): mounts the granted horse, reports mounted / dismounted,
// and dismounts before death, teleports and host loss. Observers seat the rider's clone from ff_mount (sync/mountApply.ts).
export class MountService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionAccepted", () => this.reset());
    this.controller.on("update", () => this.onUpdate());
  }

  get isMounted(): boolean {
    return this.phase === "mounted";
  }

  // The horse carries the rider in-engine, so observers must not walk the rider clone
  filterOwnMovement(movement: Movement): Movement {
    if (this.phase === "mounted") {
      movement.runMode = "Standing";
      movement.direction = 0;
      movement.isInJumpState = false;
      movement.isSneaking = false;
    }
    return movement;
  }

  // Leaves the saddle before a death ragdoll, a server teleport or after the horse was lost; must run on update
  dismountNow(reason: string): void {
    if (this.phase === "idle") {
      return;
    }
    const player = this.sp.Game.getPlayer();
    if (player && player.isOnMount() && player.dismount()) {
      this.leavingUntil = Date.now() + DISMOUNT_WAIT_MS;
    }
    logTrace(this, `dismount (${reason})`);
    this.report(false);
    this.reset();
  }

  // The activate key in the saddle; the mounted poll reports the ride's end once the player is off
  dismountByKey(): void {
    const player = this.phase === "mounted" ? this.sp.Game.getPlayer() : null;
    if (!player || !player.isOnMount() || Date.now() < this.leavingUntil) {
      return;
    }
    if (!player.dismount()) {
      notifyNextUpdate(this.controller, this.sp, "You cannot dismount here.");
      logTrace(this, "dismount (key) refused");
      return;
    }
    this.leavingUntil = Date.now() + DISMOUNT_WAIT_MS;
    logTrace(this, "dismount (key)");
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) {
      return;
    }
    const type = content["customPacketType"];
    const target = typeof content["target"] === "number" ? content["target"] : 0;
    // Natives cannot run from the packet handler
    if (type === "petMount" && target) {
      this.controller.once("update", () => this.onGranted(target, content["hosted"] === true));
    } else if (type === "petDismount") {
      this.controller.once("update", () => this.onForcedDismount(target));
    }
  }

  private onGranted(horseId: number, hosted: boolean): void {
    if (this.phase !== "idle") {
      this.dismountNow("new grant");
    }
    this.horseId = horseId;
    this.lostSince = 0;
    if (hosted || isRemoteHostedByMe(horseId)) {
      this.mount();
    } else {
      this.setPhase("waitHost");
    }
  }

  private onForcedDismount(target: number): void {
    if (this.phase === "idle" || (target && target !== this.horseId)) {
      return;
    }
    const player = this.sp.Game.getPlayer();
    if (player && player.isOnMount() && player.dismount()) {
      this.leavingUntil = Date.now() + DISMOUNT_WAIT_MS;
    }
    logTrace(this, "dismounted by the server");
    this.reset();
  }

  // The same forced activation the container path uses; the engine walks the player into the saddle
  private mount(): void {
    const refr = this.sp.ObjectReference.from(this.sp.Game.getFormEx(remoteIdToLocalId(this.horseId)));
    if (!refr) {
      logError(this, `horse ${this.horseId.toString(16)} has no local copy`);
      this.fail("no local horse");
      return;
    }
    refr.activate(this.sp.Game.getPlayer(), true);
    this.leavingUntil = 0;
    this.setPhase("waitMount");
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now - this.lastPollMs < POLL_MS) {
      return;
    }
    this.lastPollMs = now;
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    if (this.phase === "idle") {
      // A saddle reached after the handshake gave up has no rider server-side, but a dismount animation still runs
      if (player.isOnMount() && now >= this.leavingUntil) {
        player.dismount();
        logTrace(this, "left an untracked saddle");
      }
      return;
    }
    if (this.phase === "waitHost") {
      if (isRemoteHostedByMe(this.horseId)) {
        this.mount();
      } else if (now - this.phaseSince > HOST_WAIT_MS) {
        this.fail("host start never arrived");
      }
    } else if (this.phase === "waitMount") {
      if (player.isOnMount()) {
        this.setPhase("mounted");
        this.report(true);
        logTrace(this, `mounted ${this.horseId.toString(16)}`);
      } else if (now - this.phaseSince > MOUNT_WAIT_MS) {
        this.fail("not in the saddle in time");
      }
    } else if (!player.isOnMount()) {
      logTrace(this, "dismounted");
      this.leavingUntil = 0;
      this.report(false);
      this.reset();
    } else if (this.leavingUntil && now >= this.leavingUntil) {
      logTrace(this, "dismount by key did not take");
      this.leavingUntil = 0;
    } else if (this.horseLost(now)) {
      this.dismountNow("horse dead or hosted elsewhere");
    }
  }

  // The horse's model says it died or moved to another host; a HostStop counts the same
  private horseLost(now: number): boolean {
    const form = this.controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === this.horseId);
    const lost = !form || form.isDead === true || form.isHostedByOther === true || !isRemoteHostedByMe(this.horseId);
    if (!lost) {
      this.lostSince = 0;
      return false;
    }
    if (!this.lostSince) {
      this.lostSince = now;
    }
    return now - this.lostSince > HORSE_LOST_MS;
  }

  private fail(reason: string): void {
    logTrace(this, `mount of ${this.horseId.toString(16)} failed: ${reason}`);
    this.report(false);
    this.reset();
  }

  private report(mounted: boolean): void {
    sendCustomPacket(this.controller, { customPacketType: "petRequest", action: "mount", target: this.horseId, mounted });
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseSince = Date.now();
  }

  private reset(): void {
    this.phase = "idle";
    this.horseId = 0;
    this.lostSince = 0;
  }

  private phase: Phase = "idle";
  private phaseSince = 0;
  private horseId = 0;
  private lostSince = 0;
  private lastPollMs = 0;
  // While a dismount animation runs, so nothing sends Dismount again every poll
  private leavingUntil = 0;
}
