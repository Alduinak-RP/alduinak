import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { CaptureSystem, isBound, isCarried, isRestrained } from "./captureSystem";
import { BleedoutSystem } from "./bleedoutSystem";
import { FactionSystem } from "./factionSystem";
import { AfterlifeSystem, isFallen } from "./afterlifeSystem";
import { BodySystem } from "./bodySystem";
import { toFormId } from "./formIdUtil";
import { FurnitureSeatSystem } from "./furnitureSeatSystem";
import { baseIdOf, hex, isAlive, isBehind, isMounted, isNear, isPlayerActor, isSneaking, isStreamedTo, isWeaponDrawn, nameShownTo, notifyActor, recordTypeOf, userOf, weaponAnimType } from "./actorUtil";
import { appendLog, describeActor, logDirOf, sendJson, whereOf } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Finish off a downed player and behead a prisoner at a headsman's block, both a PK (docs_roleplay_survival_loop.md section 8)

// The held weapon by its WEAP DNAM animation type, dual when both hands hold a 1-4; empty hands are unarmed, a bow, staff or crossbow is no melee weapon
type WeaponType = "sword" | "dagger" | "axe" | "mace" | "greatsword" | "battleaxe" | "unarmed" | "dual";
const WEAPON_TYPES: Record<number, WeaponType> = { 1: "sword", 2: "dagger", 3: "axe", 4: "mace", 5: "greatsword", 6: "battleaxe" };
type FinisherTable = Record<WeaponType, number[]>;
// Loose Skyrim.esm paired killmoves without conditions, none decapitating, split by weapon as the vanilla killmove tree splits their clips
// KillMoveShortBlade (sword or dagger): pa_1HMKillMoveShortB, ShortD and ShortJ
const BLADE_FINISHERS = [0xf469b, 0xf469d, 0x108a45];
// KillMoveShortAxeMace (war axe or mace): pa_1HMKillMoveShortA and ShortC
const AXE_MACE_FINISHERS = [0xf469a, 0xf469c];
// pa_1HMKillMoveDualWieldA and pa_2HMKillMoveStabA; no loose non-decapitating two-handed axe pair exists, so a battleaxe borrows the stab. Overridable via "executionFinishers"
const FINISHERS: FinisherTable = {
  sword: BLADE_FINISHERS,
  dagger: BLADE_FINISHERS,
  axe: AXE_MACE_FINISHERS,
  mace: AXE_MACE_FINISHERS,
  dual: [0xf469f],
  greatsword: [0xf4687],
  battleaxe: [],
  unarmed: [],
};
// pa_1HMSneakKillBackA and pa_1HMKillMoveBackStab, the loose clips of the vanilla sneak and back killmoves, for every one-handed weapon
const SNEAK_BACK_PAIRS = [0xf4679, 0xf465a];
// Two-handed sneak kills exist only as conditioned Update.esm tree records, so those weapons keep the standing pool. Overridable via "executionSneakFinishers"
const SNEAK_FINISHERS: FinisherTable = {
  ...FINISHERS,
  sword: SNEAK_BACK_PAIRS,
  dagger: SNEAK_BACK_PAIRS,
  axe: SNEAK_BACK_PAIRS,
  mace: SNEAK_BACK_PAIRS,
  dual: SNEAK_BACK_PAIRS,
};
// pa_1HMKillMoveBleedOutKill (ENAM pa_KillingBlow, loose, non-decapitating), stabbed down into the kneeling victim; the finisher for every weapon when "finishOffStandUp" is false
const KILLMOVE_KNEELING = 0xf469e;
// Killmove tree records whose own or parent conditions the engine may refuse; added by "finishOffExtendedPool"
const ONE_HANDED_EXTENDED = [0x6440c, 0x5169f, 0x2ff92, 0x55706, 0x55707, 0x55708, 0x5570b, 0x5570c, 0x5570d];
const EXTENDED_FINISHERS: FinisherTable = {
  sword: ONE_HANDED_EXTENDED,
  dagger: ONE_HANDED_EXTENDED,
  axe: ONE_HANDED_EXTENDED,
  mace: ONE_HANDED_EXTENDED,
  dual: [0x1bbc2, 0x0100082e, 0x0100082f],
  greatsword: [0xd3648, 0x01000828, 0x01000829, 0x0100082a],
  battleaxe: [0x10d972, 0x01000824, 0x01000825],
  unarmed: [],
};
// The victim of a finish off or an assassination dies when a participant's client reports the end of the pair, or at this cap. Overridable via "finishOffMaxMs"
const DEFAULT_PAIR_MAX_MS = 9000;

// ExecutionerChoppingBlock, placed at Helgen, Solitude and in the city mods, and its unplaced two-seat twin. Overridable via "executionBlockBaseIds"
const DEFAULT_BLOCK_BASE_IDS = [0x2e8eb, 0xfe549];
// How close the executioner must stand to the block, in game units
const BLOCK_REACH = 300;
// Furniture\HeadChoppingBlock.nif markers: 0, the isExecutioner keyword's, on the block's origin facing its yaw
const HEADSMAN_MARK: Offset = { forward: 0, right: 0, up: 0, yaw: 0 };
// Marker 1, the prisoner's, 87.7 ahead and 68.8 right turned 270 degrees, head over the block in front of the headsman. Overridable via "executionBlockOffset"
const DEFAULT_PRISONER_OFFSET: Offset = { forward: 87.7, right: 68.8, up: 0, yaw: 270 };
// Global wildcards of the vanilla MT behaviour into Executionee_State and Executioner_State, the block clips Helgen and Solitude play through the furniture
const PRISONER_KNEEL = "IdleExecutioneeIdle";
const HEADSMAN_STANCE = "IdleExecutionerIdle";
// The stance's enter clip played backwards, which puts away the axe the stance drew (AnimObjectExecutionerAxe)
const HEADSMAN_EXIT = "IdleChairExitStart";
const IDLE_EXIT = "IdleForceDefaultState";
// For a prisoner whose graph never took the block kneel
const BLEEDOUT_KNEEL = "bleedOutStart";
const BLEEDOUT_STAND = "bleedOutStop";
// Every client sends IdleExecutionerChop to both actors this long after the chop packet: the headsman's move settles and his 1.5 s stance enter plays out
const CHOP_LEAD_MS = 3000;
// AOExecutioneeChop.hkx (20 s) fires Decapitate at 11.84 s and KillActor at 16.61 s; AOExecutionerChop.hkx goes back to the stance at 19.5 s
const CHOP_KILL_MS = 16610;
const CHOP_DONE_MS = 21000;
const STATE_PACKET = "executionState";
const CHOP_PACKET = "executionChop";
const STEP_PACKET = "executionStep";
const STEP_MAX_CHARS = 300;
// The chop beheads the prisoner on every client once it is sent, so nothing takes them off the block after that
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
  // The block kneel, or the bleedout kneel when their graph refused it
  pose: string;
  // Set while the axe falls
  executorId?: number;
  timers: ReturnType<typeof setTimeout>[];
}

// An assassination pair under way on a victim, who dies when it ends or at the cap timer
interface Assassination {
  killerId: number;
  timer: ReturnType<typeof setTimeout>;
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

// A settings table { type: [idle form ids] } laid over the defaults, one weapon type at a time
const finisherTableOf = (raw: unknown, defaults: FinisherTable): FinisherTable => {
  const table = { ...defaults };
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const type of Object.keys(table) as WeaponType[]) {
    const ids = o[type];
    if (Array.isArray(ids)) table[type] = ids.map((v) => toFormId(v, 0)).filter((id) => id > 0);
  }
  return table;
};

const offsetOf = (raw: unknown, fallback: Offset): Offset => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof Offset): number => typeof o[key] === "number" && Number.isFinite(o[key]) ? o[key] as number : fallback[key];
  return { forward: pick("forward"), right: pick("right"), up: pick("up"), yaw: pick("yaw") };
};

const describeSpot = (spot: { pos: number[]; rot: number[] }): string =>
  `(${spot.pos.map((v) => Math.round(v)).join(", ")}) yaw ${Math.round(spot.rot[2])}`;

export class ExecutionSystem implements System {
  systemName = "ExecutionSystem";

  constructor(
    private log: Log,
    private capture: CaptureSystem,
    private bleedout: BleedoutSystem,
    private factions: FactionSystem,
    private afterlife: AfterlifeSystem,
    private bodies: BodySystem,
    private seats: FurnitureSeatSystem,
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
    this.finishers = finisherTableOf(all?.["executionFinishers"], FINISHERS);
    this.sneakFinishers = finisherTableOf(all?.["executionSneakFinishers"], SNEAK_FINISHERS);

    this.capture.menuFlagProviders.push((requesterId, targetId) => ({
      finishOff: !this.finishOffRefusal(requesterId, targetId),
      prepareExecution: !this.prepareRefusal(requesterId, targetId),
      execute: !this.executeRefusal(requesterId, targetId),
      assassinate: !this.assassinateRefusal(requesterId, targetId),
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
    else if (type === "assassinateRequest") this.onAssassinateRequest(userId, targetId);
    else if (type === "pairedIdleDone") this.onPairedIdleDone(userId, targetId, Number(content.seq));
    else if (type === STEP_PACKET) this.onBlockStep(userId, targetId, content);
  }

  // Why the killer may not assassinate the victim, "" when they may; the weapon is checked on the request
  private assassinateRefusal(killerId: number, victimId: number): string {
    const mp = this.mp;
    if (killerId === victimId || !isPlayerActor(mp, victimId)) return "They cannot be assassinated.";
    if (!this.factions.canExecute(killerId)) return "You do not have the right to execute.";
    if (this.isKilling(killerId)) return "You cannot do that now.";
    if (this.assassinations.has(victimId)) return "They are already being assassinated.";
    const refusal = this.strikeRefusal(killerId, victimId);
    if (refusal) return refusal;
    if (!isSneaking(mp, killerId)) return "You must be sneaking.";
    if (!isBehind(mp, killerId, victimId)) return "You must be behind them.";
    return "";
  }

  // What must still hold when the kill lands, checked on the request and again at the strike
  private strikeRefusal(killerId: number, victimId: number): string {
    const mp = this.mp;
    if (!this.isAble(killerId)) return "You cannot do that now.";
    if (isMounted(mp, killerId)) return "Dismount first.";
    if (!isAlive(mp, victimId) || isFallen(mp, victimId) || this.bleedout.isDowned(victimId) || isRestrained(mp, victimId) ||
      isMounted(mp, victimId) || this.seats.seatOf(userOf(mp, victimId))) return "They cannot be assassinated now.";
    if (!isNear(mp, killerId, victimId, this.capture.interactRange)) return "They are out of reach.";
    return "";
  }

  // The victim stays standing under the pair; the kill lands when a participant's client reports the end, or at the cap
  private onAssassinateRequest(userId: number, victimId: number): void {
    const mp = this.mp;
    const killerId = this.actorOf(userId);
    if (!killerId) return;
    const held = this.weaponTypeOf(killerId);
    const idle = held ? this.pickFrom(this.sneakFinishers, held, null) : 0;
    const refusal = this.assassinateRefusal(killerId, victimId) ||
      this.factions.borderRefusal(killerId, "execute", "assassination") ||
      (idle ? "" : "You need a melee weapon in hand to assassinate them.") ||
      (isWeaponDrawn(mp, killerId) ? "" : "Draw your weapon first.");
    if (refusal) {
      notifyActor(mp, killerId, refusal);
      return;
    }
    const timer = setTimeout(() => this.strike(victimId, killerId), this.pairMaxMs);
    this.assassinations.set(victimId, { killerId, timer });
    this.playPair(killerId, victimId, idle, false, () => this.strike(victimId, killerId), false);
    this.log(`[execution] ${hex(killerId)} assassinates ${hex(victimId)} with ${held} idle ${hex(idle)}`);
  }

  // A killer who fell, was bound or mounted, or a victim who got away, went down or died meanwhile ends the attempt with no kill
  private strike(victimId: number, killerId: number): void {
    const mp = this.mp;
    const attempt = this.assassinations.get(victimId);
    if (!attempt || attempt.killerId !== killerId) return;
    clearTimeout(attempt.timer);
    this.assassinations.delete(victimId);
    const refusal = this.strikeRefusal(killerId, victimId) || this.pk(victimId, killerId, "assassinated");
    if (!refusal) return;
    this.log(`[execution] the assassination of ${hex(victimId)} by ${hex(killerId)} came to nothing: ${refusal}`);
    notifyActor(mp, killerId, `Your assassination of ${nameShownTo(mp, killerId, victimId)} failed.`);
    if (isAlive(mp, victimId)) notifyActor(mp, victimId, `${nameShownTo(mp, victimId, killerId)} failed to assassinate you.`);
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
    const held = this.weaponTypeOf(killerId);
    const idle = this.pickFinisher(held);
    const refusal = this.finishOffRefusal(killerId, victimId) ||
      this.factions.borderRefusal(killerId, "execute", "finish off") ||
      (idle ? "" : "You need a melee weapon in hand to finish them off.") ||
      (isWeaponDrawn(mp, killerId) ? "" : "Draw your weapon first.") ||
      this.bleedout.hold(victimId, killerId, this.pairMaxMs, () => this.slay(victimId, killerId, "finished off"), true);
    if (refusal) {
      notifyActor(mp, killerId, refusal);
      return;
    }
    this.playPair(killerId, victimId, idle, this.standUp, () => this.bleedout.completeHold(victimId, killerId));
    notifyActor(mp, victimId, `${nameShownTo(mp, victimId, killerId)} is finishing you off.`);
    this.log(`[execution] ${hex(killerId)} finishes off ${hex(victimId)} with ${held} idle ${hex(idle)}`);
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
    if (!this.isAble(executorId) || prisonerId === executorId || this.headsmen.has(executorId)) return "You cannot do that now.";
    if (prisoner.executorId) return AXE_FALLING;
    if (this.distanceTo(executorId, prisoner.blockId) > BLOCK_REACH) return "Stand at the block to execute them.";
    return "";
  }

  // The MT behaviour that holds the block states runs only on foot, upright and with empty hands, so the headsman's graph refuses the stance otherwise
  private stanceRefusal(executorId: number): string {
    const mp = this.mp;
    if (isMounted(mp, executorId)) return "Dismount first.";
    if (isWeaponDrawn(mp, executorId)) return "Sheathe your weapon first.";
    if (isSneaking(mp, executorId)) return "Stand up first.";
    if (this.wornEntriesOf(executorId).some((e) => recordTypeOf(mp, Number(e.baseId)) === "LIGH")) return "Put away your torch first.";
    return "";
  }

  private onPrepareRequest(userId: number, prisonerId: number): void {
    const mp = this.mp;
    const executorId = this.actorOf(userId);
    if (!executorId) return;
    const refusal = this.prepareRefusal(executorId, prisonerId) || this.factions.borderRefusal(executorId, "execute", "prepare execution");
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
    this.prisoners.set(prisonerId, { blockId, pose: PRISONER_KNEEL, timers: [] });
    this.sendPose(prisonerId, PRISONER_KNEEL);
    this.mirrorPose(prisonerId, PRISONER_KNEEL);
    notifyActor(mp, executorId, `You force ${nameShownTo(mp, executorId, prisonerId)} down onto the block.`);
    notifyActor(mp, prisonerId, `${nameShownTo(mp, prisonerId, executorId)} forces you down onto the block.`);
    this.log(`[execution] ${hex(executorId)} puts ${hex(prisonerId)} on block ${hex(blockId)} at the prisoner's mark ${describeSpot(spot)}, ${PRISONER_KNEEL}`);
  }

  // The headsman stands on his mark in the stance, then every client chops both actors at once; the kill lands at the clip's KillActor, the stance is left once the swing is over
  private onExecuteRequest(userId: number, prisonerId: number): void {
    const mp = this.mp;
    const executorId = this.actorOf(userId);
    if (!executorId) return;
    const refusal = this.executeRefusal(executorId, prisonerId) ||
      this.factions.borderRefusal(executorId, "execute", "execution") ||
      this.stanceRefusal(executorId);
    const prisoner = this.prisoners.get(prisonerId);
    const spot = !refusal && prisoner ? this.spotBy(prisoner.blockId, HEADSMAN_MARK) : null;
    if (refusal || !prisoner || !spot) {
      notifyActor(mp, executorId, refusal || "There is no execution block here.");
      return;
    }
    try {
      mp.set(executorId, "locationalData", spot);
    } catch (e) {
      this.log(`[execution] moving ${hex(executorId)} to the headsman's mark of block ${hex(prisoner.blockId)} failed: ${e}`);
      return;
    }
    const seq = ++this.pairSeq;
    prisoner.executorId = executorId;
    this.headsmen.set(executorId, prisonerId);
    sendJson(mp, userOf(mp, executorId), { customPacketType: STATE_PACKET, pose: HEADSMAN_STANCE, exit: HEADSMAN_EXIT });
    this.mirrorPose(executorId, HEADSMAN_STANCE);
    this.broadcast([executorId, prisonerId], {
      customPacketType: CHOP_PACKET, executor: executorId, prisoner: prisonerId, seq, inMs: CHOP_LEAD_MS, ms: CHOP_LEAD_MS + CHOP_DONE_MS,
      headsmanSpot: spot, prisonerSpot: this.spotBy(prisoner.blockId, this.prisonerOffset),
    });
    prisoner.timers.push(setTimeout(() => this.chop(prisonerId, executorId), CHOP_LEAD_MS + CHOP_KILL_MS));
    setTimeout(() => this.releaseHeadsman(executorId, prisonerId), CHOP_LEAD_MS + CHOP_DONE_MS);
    notifyActor(mp, prisonerId, `${nameShownTo(mp, prisonerId, executorId)} raises the axe.`);
    this.log(`[execution] ${hex(executorId)} executes ${hex(prisonerId)} at block ${hex(prisoner.blockId)}: headsman moved to his mark ${describeSpot(spot)}, ` +
      `${HEADSMAN_STANCE}; chop ${seq} on every client in ${CHOP_LEAD_MS} ms (prisoner in ${prisoner.pose}), the kill at +${CHOP_LEAD_MS + CHOP_KILL_MS} ms, ` +
      `${HEADSMAN_EXIT} at +${CHOP_LEAD_MS + CHOP_DONE_MS} ms`);
  }

  // The chop clip is back in the stance by now, the one state the headsman's exit plays from
  private releaseHeadsman(executorId: number, prisonerId: number): void {
    if (this.headsmen.get(executorId) !== prisonerId) return;
    this.headsmen.delete(executorId);
    sendJson(this.mp, userOf(this.mp, executorId), { customPacketType: STATE_PACKET, pose: "" });
    this.mirrorPose(executorId, HEADSMAN_EXIT);
    this.log(`[execution] ${hex(executorId)} steps off the block after the chop of ${hex(prisonerId)} (${HEADSMAN_EXIT})`);
  }

  // A participant's client names each answer of its graph; a prisoner whose graph never took the block kneel kneels in the bleedout pose instead
  private onBlockStep(userId: number, targetId: number, content: Content): void {
    const reporterId = this.actorOf(userId);
    if (!reporterId || (!this.prisoners.has(reporterId) && !this.headsmen.has(reporterId))) return;
    const seq = Number(content.seq) || 0;
    this.log(`[execution] block step from ${hex(reporterId)}'s client on ${hex(targetId)}${seq ? ` (chop ${seq})` : ""}: ${String(content.step ?? "").slice(0, STEP_MAX_CHARS)}`);
    const prisoner = this.prisoners.get(reporterId);
    if (content.fallback !== "kneel" || !prisoner || prisoner.executorId || prisoner.pose === BLEEDOUT_KNEEL) return;
    prisoner.pose = BLEEDOUT_KNEEL;
    this.sendPose(reporterId, BLEEDOUT_KNEEL);
    this.mirrorPose(reporterId, BLEEDOUT_KNEEL);
    this.log(`[execution] ${hex(reporterId)} kneels in ${BLEEDOUT_KNEEL} instead: their graph never took ${PRISONER_KNEEL}, so no chop clip will play on them`);
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
    this.mirrorPose(prisonerId, prisoner.pose === BLEEDOUT_KNEEL ? BLEEDOUT_STAND : IDLE_EXIT);
    this.log(`[execution] ${hex(prisonerId)} left block ${hex(prisoner.blockId)}`);
  }

  private sendPose(prisonerId: number, pose: string): void {
    sendJson(this.mp, userOf(this.mp, prisonerId), { customPacketType: STATE_PACKET, pose });
  }

  // The parked-body pose path: every copy that streams in plays the event, so late viewers see the pose; needs the native build that accepts lastAnimEvent
  private mirrorPose(actorId: number, anim: string): void {
    try {
      this.mp.set(actorId, "lastAnimEvent", anim);
    } catch (e) {
      this.log(`[execution] mirroring ${anim} on ${hex(actorId)} failed: ${e}`);
    }
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
        rot: [0, 0, yawDeg + offset.yaw - 360 * Math.floor((yawDeg + offset.yaw) / 360)],
      };
    } catch {
      return null;
    }
  }

  // The PK of a living player character without a killmove of its own (the staff PK, the end of an assassination); the refusal, "" once they are slain
  pk(victimId: number, killerId: number, how = "executed"): string {
    const mp = this.mp;
    if (!isPlayerActor(mp, victimId)) return "They are not a player character";
    if (!isAlive(mp, victimId)) return "They are already dead";
    if (isFallen(mp, victimId)) return "They are already fallen";
    this.slay(victimId, killerId, how);
    return "";
  }

  // A PK: a kill the gate never sees, a body left behind, then the soul goes to Sovngarde
  private slay(victimId: number, killerId: number, how: string): void {
    const mp = this.mp;
    const rights = this.factions.factionsWith(killerId, "execute", true);
    const line = `${describeActor(mp, killerId)} ${how} ${describeActor(mp, victimId)}, ${whereOf(mp, victimId)}` +
      ` (${rights.length ? `execute right of ${rights.join(", ")}` : "staff"})`;
    (globalThis as any).__alduinakMarkDeathAlerted?.(victimId);
    this.bleedout.die(victimId, how, killerId);
    // A fallen victim keeps the realm outfit
    if (!isFallen(mp, victimId)) this.bodies.leaveBody(victimId, `${how} by ${hex(killerId)}`);
    // Before the move, since a carried captive is set down at the carrier
    if (this.ctx) this.capture.freeCaptive(this.ctx, victimId);
    this.afterlife.sendToSovngarde(victimId, `${how} by ${hex(killerId)}`);
    appendLog(this.logDir, "pk.log", line);
    (globalThis as any).__alduinakDiscordAlert?.("execute", line);
    notifyActor(mp, killerId, `You ${how} ${nameShownTo(mp, killerId, victimId)}.`);
    this.log(`[execution] ${line}`);
  }

  // Both players see the pair, and so does everyone whose client has a copy of either; a standing pair stands the victim up first, a kneeling one waits for the kneel
  private playPair(attackerId: number, targetId: number, idle: number, standUp: boolean, done: () => void, kneel = !standUp): void {
    const now = Date.now();
    this.pairs.forEach((pair, id) => { if (now > pair.until) this.pairs.delete(id); });
    const seq = ++this.pairSeq;
    this.pairs.set(targetId, { attackerId, seq, sentAt: now, until: now + this.pairMaxMs, ended: false, done });
    this.broadcast([targetId, attackerId], { customPacketType: "pairedIdle", attacker: attackerId, target: targetId, idle, ms: this.pairMaxMs, standUp, kneel, seq });
  }

  // To the participants and to everyone whose client has a copy of one of them
  private broadcast(participants: number[], payload: Record<string, unknown>): void {
    const mp = this.mp;
    let online: unknown[] = [];
    try { online = mp.get(0, "onlinePlayers") ?? []; } catch { /* no players */ }
    for (const raw of online) {
      const viewerId = Number(raw) >>> 0;
      if (participants.some((id) => id === viewerId || isStreamedTo(mp, id, viewerId))) sendJson(mp, userOf(mp, viewerId), payload);
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

  // A random finisher of the pool for the weapon in hand, 0 without a melee weapon; the one-handed kneeling stab when the victim is not stood up
  private pickFinisher(held: WeaponType | ""): number {
    if (!held) return 0;
    if (!this.standUp) return held === "unarmed" ? 0 : KILLMOVE_KNEELING;
    return this.pickFrom(this.finishers, held, this.extendedPool ? EXTENDED_FINISHERS : null);
  }

  // A random idle of the pool for the weapon type; a battleaxe without one borrows the greatsword stab, any other empty pool gives 0
  private pickFrom(table: FinisherTable, held: WeaponType, extended: FinisherTable | null): number {
    let pool = extended ? [...table[held], ...extended[held]] : table[held];
    if (!pool.length && held === "battleaxe") {
      this.log("[execution] no battleaxe finisher, using the greatsword stab");
      pool = table.greatsword;
    }
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0;
  }

  private wornEntriesOf(actorId: number): any[] {
    try {
      return (this.mp.get(actorId, "equipment")?.inv?.entries ?? []).filter((e: any) => e.worn || e.wornLeft);
    } catch {
      return [];
    }
  }

  // By the weapon in hand, the right hand first: a melee type, unarmed with empty hands, "" with a bow, staff or crossbow
  private weaponTypeOf(actorId: number): WeaponType | "" {
    const entries = this.wornEntriesOf(actorId);
    const animIn = (hand: "worn" | "wornLeft"): number =>
      entries.filter((e) => e[hand]).map((e) => weaponAnimType(this.mp, Number(e.baseId))).find((anim) => anim >= 1) ?? -1;
    const oneHanded = (anim: number): boolean => anim >= 1 && anim <= 4;
    const right = animIn("worn");
    const left = animIn("wornLeft");
    if (oneHanded(right) && oneHanded(left)) return "dual";
    for (const anim of [right, left]) {
      if (WEAPON_TYPES[anim]) return WEAPON_TYPES[anim];
    }
    return right < 0 && left < 0 ? "unarmed" : "";
  }

  // Alive, on their feet, hands free
  private isAble(actorId: number): boolean {
    const mp = this.mp;
    return isAlive(mp, actorId) && !this.bleedout.isDowned(actorId) && !isRestrained(mp, actorId) && !this.capture.carriedOf(actorId);
  }

  // An assassination or a killmove of theirs still under way
  private isKilling(killerId: number): boolean {
    const now = Date.now();
    return Array.from(this.assassinations.values()).some((a) => a.killerId === killerId) ||
      Array.from(this.pairs.values()).some((pair) => pair.attackerId === killerId && !pair.ended && now <= pair.until);
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
  private finishers = FINISHERS;
  private sneakFinishers = SNEAK_FINISHERS;
  private nextCheckAt = 0;
  // prisonerId -> the block they kneel at
  private prisoners = new Map<number, Prisoner>();
  // executorId -> the prisoner whose chop they stand in the stance for
  private headsmen = new Map<number, number>();
  // victimId -> the assassination under way on them
  private assassinations = new Map<number, Assassination>();
  // victimId -> the killmove playing on them
  private pairs = new Map<number, Pair>();
  private pairSeq = 0;
}
