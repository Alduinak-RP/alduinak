import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { CaptureSystem, isRestrained } from "./captureSystem";
import { BleedoutSystem } from "./bleedoutSystem";
import { FactionSystem } from "./factionSystem";
import { AfterlifeSystem } from "./afterlifeSystem";
import { toFormId } from "./formIdUtil";
import { hex, isAlive, isNear, isStreamedTo, nameShownTo, notifyActor, userOf, weaponAnimType } from "./actorUtil";
import { appendLog, describeActor, logDirOf, sendJson, whereOf } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Finish off a downed player, a PK that sends them to Sovngarde (docs_roleplay_survival_loop.md section 8)

// pa_KillMove1HMDecapBleedOut and pa_KillMove2HMDecapBleedOut (Skyrim.esm IDLE, no conditions)
const KILLMOVE_ONE_HANDED = 0xf465d;
const KILLMOVE_TWO_HANDED = 0xf467f;
const FINISH_OFF_MS = 4500;

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
    this.mp = ctx.svr as Mp;
    this.logDir = logDirOf((await Settings.get()).allSettings as Record<string, unknown> | null);
    this.capture.menuFlagProviders.push((requesterId, targetId) => ({ finishOff: !this.finishOffRefusal(requesterId, targetId) }));
  }

  customPacket(userId: number, type: string, content: Content): void {
    if (type === "finishOffRequest") this.onFinishOffRequest(userId, toFormId(content.target, 0));
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
    const idle = this.killMoveOf(killerId);
    const refusal = this.finishOffRefusal(killerId, victimId) ||
      (idle ? "" : "You need a melee weapon in hand to finish them off.") ||
      this.bleedout.hold(victimId, killerId, FINISH_OFF_MS, () => this.slay(victimId, killerId, "finished off"), true);
    if (refusal) {
      notifyActor(mp, killerId, refusal);
      return;
    }
    this.playPair(killerId, victimId, idle, FINISH_OFF_MS);
    notifyActor(mp, victimId, `${nameShownTo(mp, victimId, killerId)} is finishing you off.`);
    this.log(`[execution] ${hex(killerId)} finishes off ${hex(victimId)}`);
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

  // Both players see the pair, and so does everyone whose client has a copy of the victim
  private playPair(attackerId: number, targetId: number, idle: number, ms: number): void {
    const mp = this.mp;
    const payload = { customPacketType: "pairedIdle", attacker: attackerId, target: targetId, idle, ms };
    let online: unknown[] = [];
    try { online = mp.get(0, "onlinePlayers") ?? []; } catch { /* no players */ }
    for (const raw of online) {
      const viewerId = Number(raw) >>> 0;
      if (viewerId === attackerId || viewerId === targetId || isStreamedTo(mp, targetId, viewerId)) {
        sendJson(mp, userOf(mp, viewerId), payload);
      }
    }
  }

  // The bleedout killmove for the weapon in hand (right hand first), 0 without a melee weapon
  private killMoveOf(actorId: number): number {
    let entries: any[] = [];
    try { entries = this.mp.get(actorId, "equipment")?.inv?.entries ?? []; } catch { return 0; }
    const held = entries.filter((e) => e.worn || e.wornLeft).sort((a, b) => Number(!!b.worn) - Number(!!a.worn));
    for (const entry of held) {
      const anim = weaponAnimType(this.mp, Number(entry.baseId));
      if (anim >= 1 && anim <= 4) return KILLMOVE_ONE_HANDED;
      if (anim === 5 || anim === 6) return KILLMOVE_TWO_HANDED;
    }
    return 0;
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

  private mp: Mp = null;
  private logDir = "";
}
