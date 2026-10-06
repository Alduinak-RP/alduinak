import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { DeathService } from "./deathService";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { releaseCloneMovement, stopMoving, suspendCloneMovement } from "../../sync/mountApply";
import { logToPlatformLog } from "../../logging";

const PLAYER_FORM_ID = 0x14;
const BLEEDOUT_ANIM_START = "bleedOutStart";
const BLEEDOUT_ANIM_STOP = "bleedOutStop";
// A standing pair starts once the victim's get-up has settled: the graph quiet twice in a row after this long, or at the cap regardless
const SETTLE_MIN_MS = 1200;
const SETTLE_MAX_MS = 3000;
// A kneeling pair plays this long after the packet on every client, time for a kneel sent again to land, so both participants end together
const KNEEL_RESEND_MS = 1200;
const POLL_MS = 100;
// The engine's paired-animation flag, set on both actors while the pair plays
const SYNCED_VAR = "bIsSynced";
// Set while an animation-driven clip such as the bleedout get-up moves the actor
const ANIM_DRIVEN_VAR = "bAnimationDriven";
// Over once neither actor is synced or in a killmove any more, seen twice in a row and never this early
const MIN_PAIR_MS = 1500;
const QUIET_POLLS = 2;
// A pair the graph never showed as started is taken as over at the old fixed length
const UNSEEN_PAIR_MS = 4500;
// A graph that refused the pair (a step still finishing, a translation under way) is asked again at each poll this long
const RETRY_MS = 1500;

interface Pair {
  attackerId: number;
  targetId: number;
  targetRemoteId: number;
  idleId: number;
  seq: number;
  ms: number;
  // This client plays one of the two, so it reports the end to the server
  participant: boolean;
  standUp: boolean;
  requestedAt: number;
  // Not before this, and not later than playBy
  playAt: number;
  playBy: number;
  // This client's own player is held still for the pair
  holdsPlayer: boolean;
  // 0 until the pair was first asked of the graph
  startedAt: number;
  played: boolean;
  tries: number;
  nextPollAt: number;
  sawSynced: boolean;
  sawKillMove: boolean;
  quietPolls: number;
}

const flag = (actor: Actor | null, name: string): boolean => !!actor?.getAnimationVariableBool(name);

// Plays the finish off killmove on this client's copies of both actors, out of the movement sync until it ends
export class PairedIdleService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    onCustomPacket(this.controller, "pairedIdle", (content) => this.onCustomPacketMessage(content));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const attacker = Number(content["attacker"]) >>> 0;
    const target = Number(content["target"]) >>> 0;
    const idle = Number(content["idle"]) >>> 0;
    const ms = Number(content["ms"]);
    const seq = Number(content["seq"]) || 0;
    const standUp = content["standUp"] === true;
    // An older server sends no kneel flag: its pairs without a stand-up are all on a kneeling victim
    const kneel = typeof content["kneel"] === "boolean" ? content["kneel"] : !standUp;
    if (!attacker || !target || !idle || !(ms > 0)) return;
    // Native calls are unsafe in the packet handler
    this.controller.once("update", () => this.start(attacker, target, idle, ms, seq, standUp, kneel));
  }

  // A kneeling pair waits for the kneel on every client alike; a standing pair waits for the stand-up to settle; a standing victim plays at once
  private start(attackerRemoteId: number, targetRemoteId: number, idleId: number, ms: number, seq: number, standUp: boolean, kneel: boolean): void {
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
      attackerId, targetId, targetRemoteId, idleId, seq, ms, standUp,
      participant: attackerId === PLAYER_FORM_ID || targetId === PLAYER_FORM_ID,
      holdsPlayer: false, requestedAt: now, playAt: now, playBy: now, startedAt: 0, played: false, tries: 0,
      nextPollAt: 0, sawSynced: false, sawKillMove: false, quietPolls: 0,
    };
    const restraint = this.controller.lookupListener(RestraintService);
    if (standUp) {
      if (targetId === PLAYER_FORM_ID) restraint.standForPair(ms);
      else this.sp.Debug.sendAnimationEvent(target, BLEEDOUT_ANIM_STOP);
      pair.playAt = now + SETTLE_MIN_MS;
      pair.playBy = now + SETTLE_MAX_MS;
    } else if (kneel) {
      if (targetId !== PLAYER_FORM_ID) {
        // A copy rebuilt by the move onto the block stands until the next relayed kneel
        this.sp.Debug.sendAnimationEvent(target, BLEEDOUT_ANIM_START);
        logToPlatformLog(this, `kneel re-sent to copy ${targetId.toString(16)} at pair start`);
      } else if (restraint.currentPose !== BLEEDOUT_ANIM_START) {
        // The reattach after a server move can swallow the kneel
        logToPlatformLog(this, `kneel missing at pair start, pose ${restraint.currentPose || "none"}`);
        restraint.reapplyPoses();
      }
      pair.playAt = pair.playBy = now + KNEEL_RESEND_MS;
    }
    this.holdPlayer(pair, restraint);
    this.pairs.push(pair);
    if (pair.playAt <= now) this.play(pair);
  }

  // A participant walking on would move out of the pair, and the graph refuses one for a moving actor; a pose lock already holds the player
  private holdPlayer(pair: Pair, restraint: RestraintService): void {
    const player = pair.participant ? this.sp.Game.getPlayer() : null;
    if (!player || player.isDead() || restraint.isPoseLocked) return;
    player.setDontMove(true);
    pair.holdsPlayer = true;
  }

  // Let go once no pair holds the player and nothing else has taken them over; a dead player's flag is DeathService's until its resurrect
  private releasePlayer(): void {
    if (this.pairs.some((pair) => pair.holdsPlayer)) return;
    const player = this.sp.Game.getPlayer();
    if (!player || this.controller.lookupListener(RestraintService).isPoseLocked || this.controller.lookupListener(DeathService).isPlayerDead()) return;
    player.setDontMove(false);
  }

  // The get-up is over once the target's graph is neither animation driven nor synced, twice in a row
  private settle(pair: Pair, now: number): void {
    if (pair.standUp) {
      const target = this.actorOf(pair.targetId);
      const busy = flag(target, ANIM_DRIVEN_VAR) || flag(target, SYNCED_VAR);
      pair.quietPolls = busy ? 0 : pair.quietPolls + 1;
    }
    const settled = !pair.standUp || pair.quietPolls >= QUIET_POLLS;
    if ((settled && now >= pair.playAt) || now >= pair.playBy) this.play(pair);
  }

  // The graph answers false while either actor is mid-step, so a refused pair is asked again at each poll until RETRY_MS, the copies' translations stopped first
  private play(pair: Pair): void {
    const attacker = this.actorOf(pair.attackerId);
    const target = this.actorOf(pair.targetId);
    const idle = this.sp.Idle.from(this.sp.Game.getFormEx(pair.idleId));
    if (!attacker || !target || !idle) {
      this.drop(pair);
      return;
    }
    const first = pair.tries === 0;
    if (!first) {
      for (const actor of [attacker, target]) {
        if (actor.getFormID() !== PLAYER_FORM_ID) stopMoving(actor);
      }
    }
    const a = `synced=${flag(attacker, SYNCED_VAR)},killmove=${attacker.isInKillMove()},drawn=${attacker.isWeaponDrawn()}`;
    const pose = pair.targetId === PLAYER_FORM_ID ? `,pose=${this.controller.lookupListener(RestraintService).currentPose || "none"}` : "";
    const t = `synced=${flag(target, SYNCED_VAR)},killmove=${target.isInKillMove()},animDriven=${flag(target, ANIM_DRIVEN_VAR)}${pose}`;
    pair.played = attacker.playIdleWithTarget(idle, target);
    pair.tries++;
    const now = Date.now();
    if (first || pair.played) pair.startedAt = now;
    pair.quietPolls = 0;
    if (first || pair.played) {
      logToPlatformLog(this, `pair ${pair.idleId.toString(16)} ${first ? "start" : `try ${pair.tries}`} a=${pair.attackerId.toString(16)} t=${pair.targetId.toString(16)}` +
        ` played=${pair.played} waited=${now - pair.requestedAt} a[${a}] t[${t}]`);
    }
    if (!pair.played && first) {
      logToPlatformLog(this, `pair ${pair.idleId.toString(16)} refused: ${this.describeRefusal(attacker, target)}`);
    }
  }

  // What the graph may have held against the pair, read only when it refused
  private describeRefusal(attacker: Actor, target: Actor): string {
    const describe = (actor: Actor): string =>
      `sneaking=${actor.isSneaking()},attacking=${flag(actor, "IsAttacking")},jump=${flag(actor, "bInJumpState")},speed=${Math.round(actor.getAnimationVariableFloat("SpeedSampled"))}` +
      `,sit=${actor.getSitState()},dead=${actor.isDead()},swimming=${actor.isSwimming()},mount=${actor.isOnMount()}`;
    return `a[${describe(attacker)}] t[${describe(target)}] distance=${Math.round(attacker.getDistance(target))} heading=${Math.round(attacker.getHeadingAngle(target))} camera=${this.sp.Game.getCameraState()}`;
  }

  private onUpdate(): void {
    if (!this.pairs.length) return;
    const now = Date.now();
    for (const pair of this.pairs.slice()) {
      if (now < pair.nextPollAt) continue;
      pair.nextPollAt = now + POLL_MS;
      if (!pair.startedAt) {
        this.settle(pair, now);
        continue;
      }
      if (!pair.played && now - pair.startedAt < RETRY_MS) {
        this.play(pair);
        if (!this.pairs.includes(pair)) continue;
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
    logToPlatformLog(this, `pairEnd ${pair.idleId.toString(16)} after ${elapsed} ms, played=${pair.played} in ${pair.tries} tr${pair.tries === 1 ? "y" : "ies"}, synced seen ${pair.sawSynced}, killmove seen ${pair.sawKillMove}`);
  }

  private drop(pair: Pair): void {
    this.pairs.splice(this.pairs.indexOf(pair), 1);
    for (const id of [pair.attackerId, pair.targetId]) {
      if (id !== PLAYER_FORM_ID) releaseCloneMovement(id);
    }
    if (pair.targetId === PLAYER_FORM_ID) this.controller.lookupListener(RestraintService).pairEnded();
    if (pair.holdsPlayer) this.releasePlayer();
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
