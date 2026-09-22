import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { releaseCloneMovement, suspendCloneMovement } from "../../sync/mountApply";
import { logToPlatformLog, logTrace } from "../../logging";

const PLAYER_FORM_ID = 0x14;
const BLEEDOUT_ANIM_START = "bleedOutStart";
const BLEEDOUT_ANIM_STOP = "bleedOutStop";
// The stand-up out of the bleedout kneel blends out before the pair starts
const STAND_UP_MS = 700;
// A kneel sent again at pair start has this long to land before the pair plays on it
const KNEEL_RESEND_MS = 1200;
const POLL_MS = 100;
// The engine's paired-animation flag, set on both actors while the pair plays
const SYNCED_VAR = "bIsSynced";
// Over once neither actor is synced or in a killmove any more, seen twice in a row and never this early
const MIN_PAIR_MS = 1500;
const QUIET_POLLS = 2;
// A pair the graph never showed as started is taken as over at the old fixed length
const UNSEEN_PAIR_MS = 4500;

interface Pair {
  attackerId: number;
  targetId: number;
  targetRemoteId: number;
  idleId: number;
  seq: number;
  ms: number;
  // This client plays one of the two, so it reports the end to the server
  participant: boolean;
  // Not before this
  playAt: number;
  // 0 until the pair was played
  startedAt: number;
  nextPollAt: number;
  sawSynced: boolean;
  sawKillMove: boolean;
  quietPolls: number;
}

// Plays the finish off killmove on this client's copies of both actors, out of the movement sync until it ends
export class PairedIdleService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "pairedIdle") return;
    const attacker = Number(content["attacker"]) >>> 0;
    const target = Number(content["target"]) >>> 0;
    const idle = Number(content["idle"]) >>> 0;
    const ms = Number(content["ms"]);
    const seq = Number(content["seq"]) || 0;
    const standUp = content["standUp"] === true;
    if (!attacker || !target || !idle || !(ms > 0)) return;
    // Native calls are unsafe in the packet handler
    this.controller.once("update", () => this.start(attacker, target, idle, ms, seq, standUp));
  }

  // A kneeling victim plays at once; a standing pair waits for the stand-up
  private start(attackerRemoteId: number, targetRemoteId: number, idleId: number, ms: number, seq: number, standUp: boolean): void {
    const attackerId = this.localIdOf(attackerRemoteId);
    const targetId = this.localIdOf(targetRemoteId);
    const attacker = this.actorOf(attackerId);
    const target = this.actorOf(targetId);
    if (!attacker || !target || !attacker.is3DLoaded() || !target.is3DLoaded()) return;
    for (const id of [attackerId, targetId]) {
      if (id !== PLAYER_FORM_ID) suspendCloneMovement(id, ms);
    }
    const now = Date.now();
    const pair: Pair = {
      attackerId, targetId, targetRemoteId, idleId, seq, ms,
      participant: attackerId === PLAYER_FORM_ID || targetId === PLAYER_FORM_ID,
      playAt: now, startedAt: 0, nextPollAt: 0, sawSynced: false, sawKillMove: false, quietPolls: 0,
    };
    const restraint = this.controller.lookupListener(RestraintService);
    if (standUp) {
      if (targetId === PLAYER_FORM_ID) restraint.standForPair(ms);
      else this.sp.Debug.sendAnimationEvent(target, BLEEDOUT_ANIM_STOP);
      pair.playAt = now + STAND_UP_MS;
    } else if (targetId === PLAYER_FORM_ID && restraint.currentPose !== BLEEDOUT_ANIM_START) {
      // The reattach after a server move can swallow the kneel; it is sent again and the pair waits for it
      logToPlatformLog(this, `kneel missing at pair start, pose ${restraint.currentPose || "none"}`);
      restraint.reapplyPoses();
      pair.playAt = now + KNEEL_RESEND_MS;
    }
    this.pairs.push(pair);
    if (pair.playAt <= now) this.play(pair);
  }

  private play(pair: Pair): void {
    const attacker = this.actorOf(pair.attackerId);
    const target = this.actorOf(pair.targetId);
    const idle = this.sp.Idle.from(this.sp.Game.getFormEx(pair.idleId));
    if (!attacker || !target || !idle) {
      this.drop(pair);
      return;
    }
    const played = attacker.playIdleWithTarget(idle, target);
    logTrace(this, `pairedIdle ${pair.idleId.toString(16)} ${pair.attackerId.toString(16)} -> ${pair.targetId.toString(16)}: ${played}`);
    if (!played) logToPlatformLog(this, `pairedIdle ${pair.idleId.toString(16)} refused on ${pair.attackerId.toString(16)}`);
    pair.startedAt = Date.now();
  }

  private onUpdate(): void {
    if (!this.pairs.length) return;
    const now = Date.now();
    for (const pair of this.pairs.slice()) {
      if (now < pair.nextPollAt) continue;
      pair.nextPollAt = now + POLL_MS;
      if (!pair.startedAt) {
        if (now >= pair.playAt) this.play(pair);
        continue;
      }
      const elapsed = now - pair.startedAt;
      const actors = [this.actorOf(pair.attackerId), this.actorOf(pair.targetId)];
      const synced = actors.some((actor) => actor?.getAnimationVariableBool(SYNCED_VAR));
      const inKillMove = actors.some((actor) => actor?.isInKillMove());
      pair.sawSynced = pair.sawSynced || synced;
      pair.sawKillMove = pair.sawKillMove || inKillMove;
      pair.quietPolls = synced || inKillMove ? 0 : pair.quietPolls + 1;
      const seen = pair.sawSynced || pair.sawKillMove;
      const over = seen ? pair.quietPolls >= QUIET_POLLS && elapsed >= MIN_PAIR_MS : elapsed >= UNSEEN_PAIR_MS;
      if (over || elapsed >= pair.ms || actors.some((actor) => !actor)) this.end(pair, elapsed);
    }
  }

  private end(pair: Pair, elapsed: number): void {
    this.drop(pair);
    if (pair.participant) {
      sendCustomPacket(this.controller, { customPacketType: "pairedIdleDone", target: pair.targetRemoteId, seq: pair.seq });
    }
    logToPlatformLog(this, `pairEnd ${pair.idleId.toString(16)} after ${elapsed} ms, synced seen ${pair.sawSynced}, killmove seen ${pair.sawKillMove}`);
  }

  private drop(pair: Pair): void {
    this.pairs.splice(this.pairs.indexOf(pair), 1);
    for (const id of [pair.attackerId, pair.targetId]) {
      if (id !== PLAYER_FORM_ID) releaseCloneMovement(id);
    }
    if (pair.targetId === PLAYER_FORM_ID) this.controller.lookupListener(RestraintService).pairEnded();
  }

  private actorOf(localId: number): Actor | null {
    return this.sp.Actor.from(this.sp.Game.getFormEx(localId));
  }

  private localIdOf(remoteId: number): number {
    const myId = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0;
    return remoteId === myId ? PLAYER_FORM_ID : remoteIdToLocalId(remoteId);
  }

  private pairs: Pair[] = [];
}
