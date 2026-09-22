import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { CaptureSystem, isBound, isCarried, isRestrained } from "./captureSystem";
import { BleedoutSystem } from "./bleedoutSystem";
import { FactionSystem } from "./factionSystem";
import { AfterlifeSystem } from "./afterlifeSystem";
import { toFormId } from "./formIdUtil";
import { baseIdOf, hex, isAlive, isNear, isStreamedTo, isWeaponDrawn, nameShownTo, notifyActor, userOf, weaponAnimType } from "./actorUtil";
import { appendLog, describeActor, logDirOf, sendJson, whereOf } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Finish off a downed player and behead a prisoner at a headsman's block, both a PK (docs_roleplay_survival_loop.md section 8)

// pa_KillMove1HMDecapBleedOut and pa_KillMove2HMDecapBleedOut (Skyrim.esm IDLE, no conditions), played on a kneeling victim
const KILLMOVE_ONE_HANDED = 0xf465d;
const KILLMOVE_TWO_HANDED = 0xf467f;
// The held weapon by its WEAP DNAM animation type: 1-4 in one hand or in both, 5 greatsword, 6 battleaxe and warhammer
type WeaponClass = "oneHanded" | "dual" | "twoHanded" | "twoHandedHeavy";
// Loose Skyrim.esm paired killmoves without conditions, none decapitating; type 6 has none, so it borrows the greatsword stab
const FINISHERS: Record<WeaponClass, number[]> = {
  oneHanded: [0xf469a, 0xf469b, 0xf469c, 0xf469d, 0x108a45],
  dual: [0xf469f],
  twoHanded: [0xf4687],
  twoHandedHeavy: [],
};
// pa_1HMKillMoveBleedOutKill (ENAM pa_KillingBlow, loose, non-decapitating), stabbed down into the kneeling victim; the finisher for every weapon when "finishOffStandUp" is false
const KILLMOVE_KNEELING = 0xf469e;
// Killmove tree records whose own or parent conditions the engine may refuse; added by "finishOffExtendedPool"
const EXTENDED_FINISHERS: Record<WeaponClass, number[]> = {
  oneHanded: [0x6440c, 0x5169f, 0x2ff92, 0x55706, 0x55707, 0x55708, 0x5570b, 0x5570c, 0x5570d],
  dual: [0x1bbc2, 0x0100082e, 0x0100082f],
  twoHanded: [0xd3648, 0x01000828, 0x01000829, 0x0100082a],
  twoHandedHeavy: [0x10d972, 0x01000824, 0x01000825],
};
// The victim of a finish off or an execution dies when a participant's client reports the end of the pair, or at this cap. Overridable via "finishOffMaxMs"
const DEFAULT_PAIR_MAX_MS = 9000;

// ExecutionerChoppingBlock, placed at Helgen, Solitude and in the city mods, and its unplaced two-seat twin. Overridable via "executionBlockBaseIds"
const DEFAULT_BLOCK_BASE_IDS = [0x2e8eb, 0xfe549];
// How close the executioner must stand to the block, in game units
const BLOCK_REACH = 300;
// Unmeasured starting point relative to the block. Overridable via "executionBlockOffset"
const DEFAULT_PRISONER_OFFSET: Offset = { forward: 0, right: 0, up: 0, yaw: 0 };
// The vanilla headsman idles are furniture-state clips that never play on the ground, so the prisoner kneels in the bleedout pose the killmove is built for
const PRISONER_KNEEL = "bleedOutStart";
const STATE_PACKET = "executionState";
// The pair beheads the prisoner on every client the moment it is sent, so nothing takes them off the block after that
const AXE_FALLING = "The axe is already falling.";
// { blockId, since } while a prisoner kneels at a block
const ON_BLOCK_PROP = "private.onBlock";
const PRISONER_CHECK_MS = 1000;

// Forward along the block's facing, right across it, up, and a yaw added to its own
interface Offset {
  forward: number;
  right: number;
  up: number;
  yaw: number;
}

interface Prisoner {
  blockId: number;
  // Set while the axe falls
  executorId?: number;
  timers: ReturnType<typeof setTimeout>[];
}

// A killmove under way on a victim; done runs once, when a participant's client reports the end
interface Pair {
  attackerId: number;
  seq: number;
  sentAt: number;
  until: number;
  ended: boolean;
  done: () => void;
}

const offsetOf = (raw: unknown, fallback: Offset): Offset => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof Offset): number => typeof o[key] === "number" && Number.isFinite(o[key]) ? o[key] as number : fallback[key];
  return { forward: pick("forward"), right: pick("right"), up: pick("up"), yaw: pick("yaw") };
};

export class ExecutionSystem implements System {
  systemName = "ExecutionSystem";

  constructor(
    private log: Log,
    private capture: CaptureSystem,
    private bleedout: BleedoutSystem,
    private factions: FactionSystem,
    private afterlife: AfterlifeSystem,
  ) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.ctx = ctx;
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    this.logDir = logDirOf(all);
    const bases = all?.["executionBlockBaseIds"];
    if (Array.isArray(bases)) {
      const ids = bases.map((v) => toFormId(v, 0)).filter((id) => id > 0);
      if (ids.length) this.blockBases = new Set(ids);
    }
    this.prisonerOffset = offsetOf(all?.["executionBlockOffset"], DEFAULT_PRISONER_OFFSET);
    const pairMaxMs = Number(all?.["finishOffMaxMs"]);
    if (Number.isFinite(pairMaxMs) && pairMaxMs > 0) this.pairMaxMs = pairMaxMs;
    this.extendedPool = all?.["finishOffExtendedPool"] === true;
    this.standUp = all?.["finishOffStandUp"] !== false;

    this.capture.menuFlagProviders.push((requesterId, targetId) => ({
      finishOff: !this.finishOffRefusal(requesterId, targetId),
      prepareExecution: !this.prepareRefusal(requesterId, targetId),
      execute: !this.executeRefusal(requesterId, targetId),
    }));
    this.capture.onBlock = (actorId) => this.prisoners.has(actorId);
    this.capture.blockRefusal = (actorId) => this.prisoners.get(actorId)?.executorId ? AXE_FALLING : "";
    this.capture.releaseFromBlock = (actorId) => this.leaveBlock(actorId);
    // The block state does not outlive a restart, so a leftover mirror is cleared
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      try {
        if (!this.prisoners.has(actorId >>> 0) && this.mp.get(actorId, ON_BLOCK_PROP)) this.mp.set(actorId, ON_BLOCK_PROP, null);
      } catch { /* form gone */ }
    });
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.onLeave(actorId >>> 0));
  }

  // A prisoner who died, left, lost their cuffs or was moved away is off the block; while the axe falls only death or a logout ends it early
  async updateAsync(): Promise<void> {
    if (this.prisoners.size === 0) return;
    const now = Date.now();
    if (now < this.nextCheckAt) return;
    this.nextCheckAt = now + PRISONER_CHECK_MS;
    const mp = this.mp;
    for (const [prisonerId, prisoner] of Array.from(this.prisoners)) {
      const gone = !isAlive(mp, prisonerId) || userOf(mp, prisonerId) < 0;
      if (prisoner.executorId) {
        if (gone) this.chop(prisonerId, prisoner.executorId);
      } else if (gone || !isBound(mp, prisonerId) || this.distanceTo(prisonerId, prisoner.blockId) > BLOCK_REACH) {
        this.leaveBlock(prisonerId);
      }
    }
  }

  disconnect(userId: number): void {
    const actorId = this.actorOf(userId);
    if (actorId) this.onLeave(actorId);
  }

  // A prisoner who leaves while the axe falls is still executed
  private onLeave(prisonerId: number): void {
    const executorId = this.prisoners.get(prisonerId)?.executorId;
    if (executorId) this.chop(prisonerId, executorId);
  }

  customPacket(userId: number, type: string, content: Content): void {
    const targetId = toFormId(content.target, 0);
    if (type === "finishOffRequest") this.onFinishOffRequest(userId, targetId);
    else if (type === "prepareExecutionRequest") this.onPrepareRequest(userId, targetId);
    else if (type === "executeRequest") this.onExecuteRequest(userId, targetId);
    else if (type === "pairedIdleDone") this.onPairedIdleDone(userId, targetId, Number(content.seq));
  }

  // Why the killer may not finish the victim off, "" when they may; the weapon is checked on the request
  private finishOffRefusal(killerId: number, victimId: number): string {
    const mp = this.mp;
    if (!this.bleedout.isDowned(victimId) || killerId === victimId) return "They are not bleeding out.";
    if (!this.factions.canExecute(killerId)) return "You do not have the right to execute.";
    if (!this.isAble(killerId)) return "You cannot do that now.";
    if (!isNear(mp, killerId, victimId, this.capture.interactRange)) return "They are out of reach.";
    return "";
  }

  private onFinishOffRequest(userId: number, victimId: number): void {
    const mp = this.mp;
    const killerId = this.actorOf(userId);
    if (!killerId) return;
    const idle = this.pickFinisher(killerId);
    const refusal = this.finishOffRefusal(killerId, victimId) ||
      (idle ? "" : "You need a melee weapon in hand to finish them off.") ||
      (isWeaponDrawn(mp, killerId) ? "" : "Draw your weapon first.") ||
      this.bleedout.hold(victimId, killerId, this.pairMaxMs, () => this.slay(victimId, killerId, "finished off"), true);
    if (refusal) {
      notifyActor(mp, killerId, refusal);
      return;
    }
    this.playPair(killerId, victimId, idle, this.standUp, () => this.bleedout.completeHold(victimId, killerId));
    notifyActor(mp, victimId, `${nameShownTo(mp, victimId, killerId)} is finishing you off.`);
    this.log(`[execution] ${hex(killerId)} finishes off ${hex(victimId)}`);
  }

  // Why the executor may not lead the prisoner to a block, "" when they may
  private prepareRefusal(executorId: number, prisonerId: number): string {
    const mp = this.mp;
    if (!isBound(mp, prisonerId) || prisonerId === executorId) return "Only a prisoner in cuffs can be led to the block.";
    if (!this.factions.canExecute(executorId)) return "You do not have the right to execute.";
    if (!this.isAble(executorId)) return "You cannot do that now.";
    if (this.prisoners.has(prisonerId)) return "They are already at the block.";
    if (isCarried(mp, prisonerId) || this.bleedout.isDowned(prisonerId)) return "They cannot be led to the block now.";
    if (!isNear(mp, executorId, prisonerId, this.capture.interactRange)) return "They are out of reach.";
    if (!this.blockNear(executorId)) return "There is no execution block here.";
    return "";
  }

  // Why the executor may not behead the prisoner, "" when they may
  private executeRefusal(executorId: number, prisonerId: number): string {
    const prisoner = this.prisoners.get(prisonerId);
    if (!prisoner) return "They are not at the block.";
    if (!this.factions.canExecute(executorId)) return "You do not have the right to execute.";
    if (!this.isAble(executorId) || prisonerId === executorId) return "You cannot do that now.";
    if (prisoner.executorId) return AXE_FALLING;
    if (this.distanceTo(executorId, prisoner.blockId) > BLOCK_REACH) return "Stand at the block to execute them.";
    return "";
  }

  private onPrepareRequest(userId: number, prisonerId: number): void {
    const mp = this.mp;
    const executorId = this.actorOf(userId);
    if (!executorId) return;
    const refusal = this.prepareRefusal(executorId, prisonerId);
    const blockId = refusal ? 0 : this.blockNear(executorId);
    const spot = blockId ? this.spotBy(blockId, this.prisonerOffset) : null;
    if (!spot) {
      notifyActor(mp, executorId, refusal || "There is no execution block here.");
      return;
    }
    try {
      mp.set(prisonerId, "locationalData", spot);
      mp.set(prisonerId, ON_BLOCK_PROP, { blockId, since: Date.now() });
    } catch (e) {
      this.log(`[execution] placing ${hex(prisonerId)} at block ${hex(blockId)} failed: ${e}`);
      return;
    }
    this.prisoners.set(prisonerId, { blockId, timers: [] });
    this.sendPose(prisonerId, PRISONER_KNEEL);
    notifyActor(mp, executorId, `You force ${nameShownTo(mp, executorId, prisonerId)} down onto the block.`);
    notifyActor(mp, prisonerId, `${nameShownTo(mp, prisonerId, executorId)} forces you down onto the block.`);
    this.log(`[execution] ${hex(executorId)} puts ${hex(prisonerId)} on block ${hex(blockId)}`);
  }

  private onExecuteRequest(userId: number, prisonerId: number): void {
    const mp = this.mp;
    const executorId = this.actorOf(userId);
    if (!executorId) return;
    const idle = this.killMoveOf(executorId);
    const refusal = this.executeRefusal(executorId, prisonerId) ||
      (idle ? "" : "You need a melee weapon in hand to execute them.") ||
      (isWeaponDrawn(mp, executorId) ? "" : "Draw your weapon first.");
    const prisoner = this.prisoners.get(prisonerId);
    if (refusal || !prisoner) {
      notifyActor(mp, executorId, refusal);
      return;
    }
    // The pair aligns the two actors itself from wherever the executioner stands in reach; the respawn rebuilds the body
    prisoner.executorId = executorId;
    this.playPair(executorId, prisonerId, idle, false, () => this.chop(prisonerId, executorId));
    prisoner.timers.push(setTimeout(() => this.chop(prisonerId, executorId), this.pairMaxMs));
    notifyActor(mp, prisonerId, `${nameShownTo(mp, prisonerId, executorId)} raises the axe.`);
    this.log(`[execution] ${hex(executorId)} executes ${hex(prisonerId)}`);
  }

  // The axe lands whatever became of the executioner meanwhile; a prisoner already dead by other means is only taken off the block
  private chop(prisonerId: number, executorId: number): void {
    const prisoner = this.prisoners.get(prisonerId);
    if (!prisoner || prisoner.executorId !== executorId) return;
    prisoner.timers.forEach(clearTimeout);
    prisoner.timers = [];
    prisoner.executorId = undefined;
    if (isAlive(this.mp, prisonerId)) this.slay(prisonerId, executorId, "executed");
    this.leaveBlock(prisonerId);
    if (this.ctx) this.capture.freeCaptive(this.ctx, prisonerId);
  }

  // Off the block: the prisoner falls back to the bound pose, the cuffs stay on
  private leaveBlock(prisonerId: number): void {
    const prisoner = this.prisoners.get(prisonerId);
    if (!prisoner) return;
    prisoner.timers.forEach(clearTimeout);
    this.prisoners.delete(prisonerId);
    try {
      this.mp.set(prisonerId, ON_BLOCK_PROP, null);
    } catch { /* form gone */ }
    this.sendPose(prisonerId, "");
    this.log(`[execution] ${hex(prisonerId)} left block ${hex(prisoner.blockId)}`);
  }

  private sendPose(prisonerId: number, pose: string): void {
    sendJson(this.mp, userOf(this.mp, prisonerId), { customPacketType: STATE_PACKET, pose });
  }

  // The nearest execution block within reach, 0 when there is none
  private blockNear(actorId: number): number {
    const mp = this.mp;
    let near: unknown[] = [];
    try {
      near = mp.getNeighborsByPosition(String(mp.get(actorId, "worldOrCellDesc")), mp.get(actorId, "pos")) ?? [];
    } catch {
      return 0;
    }
    let best = 0;
    let bestDistance = BLOCK_REACH;
    for (const raw of near) {
      const refId = Number(raw) >>> 0;
      if (!this.blockBases.has(baseIdOf(mp, refId))) continue;
      const distance = this.distanceTo(actorId, refId);
      if (distance <= bestDistance) {
        best = refId;
        bestDistance = distance;
      }
    }
    return best;
  }

  // Infinity when the reference is in another cell or worldspace
  private distanceTo(actorId: number, refId: number): number {
    const mp = this.mp;
    try {
      if (String(mp.get(actorId, "worldOrCellDesc")) !== String(mp.get(refId, "worldOrCellDesc"))) return Infinity;
      const a = mp.get(actorId, "pos") as number[];
      const b = mp.get(refId, "pos") as number[];
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    } catch {
      return Infinity;
    }
  }

  // Skyrim yaw runs clockwise from north, so forward is (sin, cos) and right is (cos, -sin)
  private spotBy(blockId: number, offset: Offset): { cellOrWorldDesc: string; pos: number[]; rot: number[] } | null {
    const mp = this.mp;
    try {
      const pos = mp.get(blockId, "pos") as number[];
      const yawDeg = Number(mp.get(blockId, "angle")?.[2]) || 0;
      const yaw = yawDeg * Math.PI / 180;
      return {
        cellOrWorldDesc: String(mp.get(blockId, "worldOrCellDesc")),
        pos: [
          pos[0] + Math.sin(yaw) * offset.forward + Math.cos(yaw) * offset.right,
          pos[1] + Math.cos(yaw) * offset.forward - Math.sin(yaw) * offset.right,
          pos[2] + offset.up,
        ],
        rot: [0, 0, yawDeg + offset.yaw],
      };
    } catch {
      return null;
    }
  }

  // A PK: a kill the gate never sees, then the soul goes to Sovngarde
  private slay(victimId: number, killerId: number, how: string): void {
    const mp = this.mp;
    const rights = this.factions.factionsWith(killerId, "execute");
    const line = `${describeActor(mp, killerId)} ${how} ${describeActor(mp, victimId)}, ${whereOf(mp, victimId)}` +
      ` (${rights.length ? `execute right of ${rights.join(", ")}` : "staff"})`;
    (globalThis as any).__alduinakMarkDeathAlerted?.(victimId);
    this.bleedout.die(victimId, how, killerId);
    this.afterlife.sendToSovngarde(victimId, `${how} by ${hex(killerId)}`);
    appendLog(this.logDir, "pk.log", line);
    (globalThis as any).__alduinakDiscordAlert?.("execute", line);
    notifyActor(mp, killerId, `You ${how} ${nameShownTo(mp, killerId, victimId)}.`);
    this.log(`[execution] ${line}`);
  }

  // Both players see the pair, and so does everyone whose client has a copy of the victim; a standing pair stands the victim up first
  private playPair(attackerId: number, targetId: number, idle: number, standUp: boolean, done: () => void): void {
    const mp = this.mp;
    const now = Date.now();
    this.pairs.forEach((pair, id) => { if (now > pair.until) this.pairs.delete(id); });
    const seq = ++this.pairSeq;
    this.pairs.set(targetId, { attackerId, seq, sentAt: now, until: now + this.pairMaxMs, ended: false, done });
    const payload = { customPacketType: "pairedIdle", attacker: attackerId, target: targetId, idle, ms: this.pairMaxMs, standUp, seq };
    let online: unknown[] = [];
    try { online = mp.get(0, "onlinePlayers") ?? []; } catch { /* no players */ }
    for (const raw of online) {
      const viewerId = Number(raw) >>> 0;
      if (viewerId === attackerId || viewerId === targetId || isStreamedTo(mp, targetId, viewerId)) {
        sendJson(mp, userOf(mp, viewerId), payload);
      }
    }
  }

  // The end of the pair as either participant's client saw it; the first report wins, both are logged with their elapsed time
  private onPairedIdleDone(userId: number, targetId: number, seq: number): void {
    const pair = this.pairs.get(targetId);
    const reporterId = this.actorOf(userId);
    if (!pair || pair.seq !== seq || (reporterId !== pair.attackerId && reporterId !== targetId)) {
      this.log(`[execution] stale pair report from ${hex(reporterId)} on ${hex(targetId)} seq ${seq}`);
      return;
    }
    const now = Date.now();
    this.log(`[execution] pair ${seq} on ${hex(targetId)} ${pair.ended ? "also " : ""}ended by ${hex(reporterId)} after ${now - pair.sentAt} ms`);
    if (pair.ended) return;
    pair.ended = true;
    if (now <= pair.until) pair.done();
  }

  // A random finisher of the pool for the weapon in hand, 0 without a melee weapon; the kneeling stab when the victim is not stood up
  private pickFinisher(actorId: number): number {
    const held = this.weaponClassOf(actorId);
    if (!held) return 0;
    if (!this.standUp) return KILLMOVE_KNEELING;
    let pool = this.extendedPool ? [...FINISHERS[held], ...EXTENDED_FINISHERS[held]] : FINISHERS[held];
    if (!pool.length) pool = FINISHERS.twoHanded;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // The bleedout killmove for the weapon in hand, 0 without a melee weapon
  private killMoveOf(actorId: number): number {
    const held = this.weaponClassOf(actorId);
    return held === "oneHanded" || held === "dual" ? KILLMOVE_ONE_HANDED : held ? KILLMOVE_TWO_HANDED : 0;
  }

  // By the melee weapon in hand, the right hand first; "" without one
  private weaponClassOf(actorId: number): WeaponClass | "" {
    let entries: any[] = [];
    try { entries = this.mp.get(actorId, "equipment")?.inv?.entries ?? []; } catch { return ""; }
    const animIn = (hand: "worn" | "wornLeft"): number =>
      entries.filter((e) => e[hand]).map((e) => weaponAnimType(this.mp, Number(e.baseId))).find((anim) => anim >= 1) ?? -1;
    const oneHanded = (anim: number): boolean => anim >= 1 && anim <= 4;
    const right = animIn("worn");
    const left = animIn("wornLeft");
    if (oneHanded(right) && oneHanded(left)) return "dual";
    for (const anim of [right, left]) {
      if (oneHanded(anim)) return "oneHanded";
      if (anim === 5) return "twoHanded";
      if (anim === 6) return "twoHandedHeavy";
    }
    return "";
  }

  // Alive, on their feet, hands free
  private isAble(actorId: number): boolean {
    const mp = this.mp;
    return isAlive(mp, actorId) && !this.bleedout.isDowned(actorId) && !isRestrained(mp, actorId) && !this.capture.carriedOf(actorId);
  }

  private actorOf(userId: number): number {
    try {
      return this.mp.getUserActor(userId) >>> 0;
    } catch {
      return 0;
    }
  }

  private ctx: SystemContext | null = null;
  private mp: Mp = null;
  private logDir = "";
  private blockBases = new Set(DEFAULT_BLOCK_BASE_IDS);
  private prisonerOffset = DEFAULT_PRISONER_OFFSET;
  private pairMaxMs = DEFAULT_PAIR_MAX_MS;
  private extendedPool = false;
  // The finish off stands the victim up for a standing killmove; off, the kneeling stab plays at once
  private standUp = true;
  private nextCheckAt = 0;
  // prisonerId -> the block they kneel at
  private prisoners = new Map<number, Prisoner>();
  // victimId -> the killmove playing on them
  private pairs = new Map<number, Pair>();
  private pairSeq = 0;
}
