import { Actor } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { releaseCloneMovement, suspendCloneMovement } from "../../sync/mountApply";
import { playOnCopy } from "../../sync/animation";
import { logToPlatformLog } from "../../logging";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";

const PLAYER_FORM_ID = 0x14;
// Global wildcards of the vanilla MT behaviour into Executioner_State and Executionee_State; each plays a 1.5 s enter clip, then the idle
const HEADSMAN_STANCE = "IdleExecutionerIdle";
const PRISONER_KNEEL = "IdleExecutioneeIdle";
// Taken only from those idles: AOExecutionerChop on the headsman, AOExecutioneeChop on the prisoner (Decapitate at 11.8 s, KillActor at 16.6 s)
const CHOP = "IdleExecutionerChop";
// The headsman's exit plays only from his stance idle; the forced default state skips the clip that puts the axe prop away
const HEADSMAN_EXIT = "IdleChairExitStart";
const IDLE_EXIT = "IdleForceDefaultState";
const STEP_PACKET = "executionStep";
const POSES = new Set([HEADSMAN_STANCE, PRISONER_KNEEL]);
// Long enough for an enter clip to reach its idle
const SETTLE_MS = 1700;
// The player's block pose is tried once more when the graph took none of its sends this long after the first
const POSE_CHECK_MS = 1500;
const EXIT_RETRY_MS = 500;
const EXIT_TRIES = 6;
const EXIT_WINDOW_MS = 10000;

interface Spot {
  pos: number[];
  rot: number[];
}

interface Scene {
  seq: number;
  prisonerRemoteId: number;
  // Local ids, 0 when this client has no copy
  headsmanId: number;
  prisonerId: number;
  headsmanSpot: Spot | null;
  prisonerSpot: Spot | null;
  // This client plays one of the two, so it reports its graph's answers to the server
  participant: boolean;
  resendAt: number;
  chopAt: number;
  endAt: number;
  resent: boolean;
  chopped: boolean;
  // Actors whose graph took the chop, from this service or the animation sync
  chopTaken: Set<number>;
  // Actors that refused this service's chop, with when their one retry goes out
  retries: Map<number, number>;
  retried: Set<number>;
  // The relayed event that took the headsman's copy out of the scene, such as his bleedout kneel
  headsmanLeftFor: string;
}

// A headsman's exit until his graph takes it, on this player or a copy
interface ExitWatch {
  until: number;
  tries: number;
  refusedAt: number;
}

// The player's own block pose as RestraintService sends it; done once taken or reported
interface PoseWatch {
  anim: string;
  since: number;
  taken: boolean;
  retried: boolean;
  done: boolean;
}

const hex = (id: number): string => (id >>> 0).toString(16);

const isSceneEvent = (anim: string): boolean => anim.toLowerCase().startsWith("idleexecut") || anim === HEADSMAN_EXIT;

const spotOf = (raw: unknown): Spot | null => {
  const o = raw as Partial<Spot> | null;
  const ok = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
  return o && ok(o.pos) && ok(o.rot) ? { pos: o.pos, rot: o.rot } : null;
};

// The headsman's chop at an execution block on this client's copies of both actors, and the checks on the player's own block pose
export class ExecutionChopService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        const selfId = ctx.selfId >>> 0;
        const anim = ctx.animEventName;
        const ok = ctx.animationSucceeded;
        this.controller.once("update", () => this.onGraphAnswer(selfId, anim, ok));
      },
    }, 0, 0xffffffff, "IdleExecut*");
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        const selfId = ctx.selfId >>> 0;
        const ok = ctx.animationSucceeded;
        if (this.exits.has(selfId)) this.controller.once("update", () => this.onExitAnswer(selfId, ok));
      },
    }, 0, 0xffffffff, HEADSMAN_EXIT);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.["customPacketType"] !== "executionChop") return;
    const executor = Number(content["executor"]) >>> 0;
    const prisoner = Number(content["prisoner"]) >>> 0;
    const seq = Number(content["seq"]) || 0;
    const inMs = Number(content["inMs"]);
    const ms = Number(content["ms"]);
    if (!executor || !prisoner || !(inMs >= 0) || !(ms > inMs)) return;
    const headsmanSpot = spotOf(content["headsmanSpot"]);
    const prisonerSpot = spotOf(content["prisonerSpot"]);
    // Native calls are unsafe in the packet handler
    this.controller.once("update", () => this.start(executor, prisoner, seq, inMs, ms, headsmanSpot, prisonerSpot));
  }

  private start(executor: number, prisoner: number, seq: number, inMs: number, ms: number, headsmanSpot: Spot | null, prisonerSpot: Spot | null): void {
    const now = Date.now();
    const headsmanId = this.localIdOf(executor);
    const prisonerId = this.localIdOf(prisoner);
    const scene: Scene = {
      seq, prisonerRemoteId: prisoner, headsmanId, prisonerId, headsmanSpot, prisonerSpot,
      participant: headsmanId === PLAYER_FORM_ID || prisonerId === PLAYER_FORM_ID,
      resendAt: now + Math.max(0, inMs - SETTLE_MS), chopAt: now + inMs, endAt: now + ms,
      resent: false, chopped: false, chopTaken: new Set(), retries: new Map(), retried: new Set(), headsmanLeftFor: "",
    };
    this.scenes.push(scene);
    // RestraintService sends this player's exit when the server releases the stance
    if (headsmanId === PLAYER_FORM_ID) this.exits.set(PLAYER_FORM_ID, { until: scene.endAt + EXIT_WINDOW_MS, tries: 0, refusedAt: 0 });
    this.log(scene, `chop in ${inMs} ms; headsman ${this.describe(headsmanId, headsmanSpot)}; prisoner ${this.describe(prisonerId, prisonerSpot)}`);
  }

  private onUpdate(): void {
    const now = Date.now();
    this.watchPose(now);
    this.exits.forEach((watch, id) => {
      if (now >= watch.until) this.exits.delete(id);
      else if (watch.refusedAt && now >= watch.refusedAt + EXIT_RETRY_MS) this.retryExit(id, watch);
    });
    for (const scene of this.scenes.slice()) {
      if (!scene.resent && now >= scene.resendAt) this.resettle(scene);
      if (!scene.chopped && now >= scene.chopAt) this.chop(scene, now);
      scene.retries.forEach((at, id) => {
        if (now < at) return;
        scene.retries.delete(id);
        if (id === scene.headsmanId && scene.headsmanLeftFor) return;
        this.log(scene, `${CHOP} sent again to the ${this.roleOf(scene, id)} ${hex(id)}`);
        this.send(id, CHOP);
      });
      if (now >= scene.endAt) this.end(scene);
    }
  }

  // A graph already in the pose ignores it; a copy posed late or rebuilt takes it now and reaches its idle before the chop
  private resettle(scene: Scene): void {
    scene.resent = true;
    const pose = this.controller.lookupListener(RestraintService).currentPose;
    if (scene.headsmanId !== PLAYER_FORM_ID || pose === HEADSMAN_STANCE) this.send(scene.headsmanId, HEADSMAN_STANCE);
    if (scene.prisonerId !== PLAYER_FORM_ID || pose === PRISONER_KNEEL) this.send(scene.prisonerId, PRISONER_KNEEL);
    this.log(scene, `stance and kneel sent again ${SETTLE_MS} ms before the chop; headsman ${this.describe(scene.headsmanId, scene.headsmanSpot)}; ` +
      `prisoner ${this.describe(scene.prisonerId, scene.prisonerSpot)}`);
  }

  // Both in the same frame, as the vanilla block script plays one event for the two linked graphs; any other event relayed for the headsman frees his copy to play it
  private chop(scene: Scene, now: number): void {
    scene.chopped = true;
    if (scene.headsmanId && scene.headsmanId !== PLAYER_FORM_ID) {
      suspendCloneMovement(scene.headsmanId, scene.endAt - now, (anim) => {
        if (isSceneEvent(anim)) return true;
        scene.headsmanLeftFor = anim;
        this.log(scene, `the headsman's copy ${hex(scene.headsmanId)} leaves the scene for the relayed ${anim}`);
        return false;
      });
    }
    if (scene.prisonerId && scene.prisonerId !== PLAYER_FORM_ID) suspendCloneMovement(scene.prisonerId, scene.endAt - now);
    const headsman = this.send(scene.headsmanId, CHOP);
    const prisoner = this.send(scene.prisonerId, CHOP);
    this.log(scene, `${CHOP} sent to the headsman${headsman ? "" : " (not loaded here)"} and the prisoner${prisoner ? "" : " (not loaded here)"} together`);
  }

  // The headsman's copy is sent his exit too, in case the relayed one came while its swing still played, unless a relayed event already took it out of the scene
  private end(scene: Scene): void {
    this.scenes.splice(this.scenes.indexOf(scene), 1);
    for (const id of [scene.headsmanId, scene.prisonerId]) {
      if (id && id !== PLAYER_FORM_ID) releaseCloneMovement(id);
    }
    const copy = scene.headsmanId !== PLAYER_FORM_ID && !scene.headsmanLeftFor ? scene.headsmanId : 0;
    // Watched before the send, since the graph answers inside it
    if (copy) this.exits.set(copy, { until: Date.now() + EXIT_WINDOW_MS, tries: 0, refusedAt: 0 });
    const exit = !!copy && this.send(copy, HEADSMAN_EXIT);
    if (copy && !exit) this.exits.delete(copy);
    const exitText = exit ? `, ${HEADSMAN_EXIT} sent to the headsman's copy` : scene.headsmanLeftFor ? `, no ${HEADSMAN_EXIT} for the headsman's copy (left for ${scene.headsmanLeftFor})` : "";
    this.log(scene, `over, chop taken by ${Array.from(scene.chopTaken).map(hex).join(", ") || "neither actor"}${exitText}`);
  }

  private onGraphAnswer(selfId: number, anim: string, ok: boolean): void {
    if (selfId === PLAYER_FORM_ID && POSES.has(anim)) this.notePose(anim, ok);
    const scene = this.scenes.find((s) => s.headsmanId === selfId || s.prisonerId === selfId);
    const role = scene ? this.roleOf(scene, selfId) : selfId === PLAYER_FORM_ID ? "player" : "copy";
    const already = anim === CHOP && !ok && !!scene?.chopTaken.has(selfId);
    if (anim === CHOP && ok) scene?.chopTaken.add(selfId);
    const answer = ok ? "taken" : already ? "ignored, already chopping" : POSES.has(anim) ? "not taken (already in it, or refused)" : "refused";
    const text = `${anim} on the ${role} ${hex(selfId)}${selfId === PLAYER_FORM_ID ? " (this player)" : ""}: ${answer}`;
    if (scene) this.log(scene, text);
    else logToPlatformLog(this, text);
    const retry = !!scene && anim === CHOP && !ok && !already && scene.chopped && !scene.retried.has(selfId);
    // A bystander's retried prisoner chop is reported too, so the server holds the kill until that head comes off
    if (selfId === PLAYER_FORM_ID || (scene?.participant && anim === CHOP) || (retry && selfId === scene?.prisonerId)) {
      this.report(scene ? scene.prisonerRemoteId : this.myRemoteId(), scene?.seq ?? 0, text);
    }
    if (scene && retry) this.retryChop(scene, selfId);
  }

  // Not yet in its block idle: the stance or kneel goes again and the chop follows once the enter clip is over
  private retryChop(scene: Scene, id: number): void {
    scene.retried.add(id);
    const pose = id === scene.headsmanId ? HEADSMAN_STANCE : PRISONER_KNEEL;
    this.send(id, pose);
    scene.retries.set(id, Date.now() + SETTLE_MS);
    this.log(scene, `fallback: the ${this.roleOf(scene, id)} ${hex(id)} refused ${CHOP}, ${pose} sent again and ${CHOP} again in ${SETTLE_MS} ms`);
  }

  private notePose(anim: string, ok: boolean): void {
    if (!this.pose || this.pose.anim !== anim) this.pose = { anim, since: Date.now(), taken: false, retried: false, done: false };
    if (!this.pose.done) this.pose.taken = this.pose.taken || ok;
  }

  // A block pose the graph never took is sent once more from the default state, then reported; the server kneels such a prisoner in the bleedout pose
  private watchPose(now: number): void {
    const watch = this.pose;
    if (!watch) return;
    if (this.controller.lookupListener(RestraintService).currentPose !== watch.anim) {
      this.pose = null;
      return;
    }
    if (watch.taken) watch.done = true;
    // Never stood up once the axe falls
    if (watch.done || now - watch.since < POSE_CHECK_MS || this.scenes.some((s) => s.participant && s.chopped)) return;
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    const restraint = this.controller.lookupListener(RestraintService);
    const state = this.describePlayer(player);
    if (watch.retried) {
      watch.done = true;
      logToPlatformLog(this, `${watch.anim} still not taken after the retry (${state}), reported to the server`);
      this.report(this.myRemoteId(), 0, `${watch.anim} never taken (${state})`, watch.anim === PRISONER_KNEEL ? "kneel" : "");
      return;
    }
    watch.retried = true;
    watch.since = now;
    if (player.isWeaponDrawn()) player.sheatheWeapon();
    this.sp.Game.forceThirdPerson();
    this.sp.Debug.sendAnimationEvent(player, IDLE_EXIT);
    this.sp.Utility.wait(0.3).then(() => this.controller.once("update", () => restraint.reapplyPoses()));
    logToPlatformLog(this, `${watch.anim} not taken ${POSE_CHECK_MS} ms after it was sent (${state}), sent again from ${IDLE_EXIT}`);
  }

  private onExitAnswer(id: number, ok: boolean): void {
    const watch = this.exits.get(id);
    if (!watch || Date.now() >= watch.until) return;
    logToPlatformLog(this, `${HEADSMAN_EXIT} on ${this.exitWho(id)}: ${ok ? "taken, the axe is put away" : `refused (try ${watch.tries + 1} of ${EXIT_TRIES})`}`);
    if (ok) this.exits.delete(id);
    else watch.refusedAt = Date.now();
  }

  // Refused while the chop clip still plays, so tried again until it is back in the stance, then the default state is forced; a downed player's kneel is left alone
  private retryExit(id: number, watch: ExitWatch): void {
    watch.refusedAt = 0;
    if (id === PLAYER_FORM_ID && this.controller.lookupListener(RestraintService).isDowned) {
      this.exits.delete(id);
      logToPlatformLog(this, `${HEADSMAN_EXIT} on this player: no retry, downed`);
      return;
    }
    if (++watch.tries < EXIT_TRIES) {
      if (!this.send(id, HEADSMAN_EXIT)) this.exits.delete(id);
      return;
    }
    this.exits.delete(id);
    if (!this.send(id, IDLE_EXIT)) return;
    logToPlatformLog(this, `fallback: ${HEADSMAN_EXIT} refused ${EXIT_TRIES} times on ${this.exitWho(id)}, ${IDLE_EXIT} sent; the axe prop may stay in hand until the next weapon draw`);
  }

  private exitWho(id: number): string {
    return id === PLAYER_FORM_ID ? "this player" : `the headsman's copy ${hex(id)}`;
  }

  private report(target: number, seq: number, step: string, fallback = ""): void {
    sendCustomPacket(this.controller, { customPacketType: STEP_PACKET, target, seq, step, ...(fallback ? { fallback } : {}) });
  }

  private roleOf(scene: Scene, localId: number): string {
    return localId === scene.headsmanId ? "headsman" : "prisoner";
  }

  // Where the actor stands against the mark the server put it on
  private describe(localId: number, spot: Spot | null): string {
    const actor = localId ? this.sp.Actor.from(this.sp.Game.getFormEx(localId)) : null;
    if (!actor || !actor.is3DLoaded()) return `${hex(localId)} not loaded here`;
    const who = `${localId === PLAYER_FORM_ID ? "this player" : "copy"} ${hex(localId)}, animDriven ${actor.getAnimationVariableBool("bAnimationDriven")}`;
    if (!spot) return who;
    const off = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(actor), [spot.pos[0], spot.pos[1], spot.pos[2]]);
    const turn = ((actor.getAngleZ() - spot.rot[2]) % 360 + 540) % 360 - 180;
    return `${who}, ${Math.round(off)} units from its mark, facing ${Math.round(turn)} degrees off`;
  }

  private describePlayer(player: Actor): string {
    return `weapon drawn ${player.isWeaponDrawn()}, sneaking ${player.isSneaking()}, camera ${this.sp.Game.getCameraState()}, ` +
      `left hand ${player.getEquippedItemType(0)}, mounted ${player.isOnMount()}`;
  }

  private send(localId: number, anim: string): boolean {
    const actor = localId ? this.sp.Actor.from(this.sp.Game.getFormEx(localId)) : null;
    if (!actor || !actor.is3DLoaded() || actor.isDead()) return false;
    if (localId === PLAYER_FORM_ID) this.sp.Debug.sendAnimationEvent(actor, anim);
    else playOnCopy(actor, anim);
    return true;
  }

  private log(scene: Scene, text: string): void {
    logToPlatformLog(this, `chop ${scene.seq}: ${text}`);
  }

  private myRemoteId(): number {
    return this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0;
  }

  private localIdOf(remoteId: number): number {
    return remoteId === this.myRemoteId() ? PLAYER_FORM_ID : remoteIdToLocalId(remoteId);
  }

  private scenes: Scene[] = [];
  private pose: PoseWatch | null = null;
  // By local id, this player's or a headsman copy's
  private exits = new Map<number, ExitWatch>();
}
