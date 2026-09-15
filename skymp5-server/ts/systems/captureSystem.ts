import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";
import { nameShownTo } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Arrest / capture / carry ──────────────────────────────────────────────────
//
// Server-authoritative restraint feature built on the `mp` JS API (no engine
// changes). Two restraint states, both reflected on the captive's client by the
// server-driven RestraintService:
//   - boundHands ("arrest"): Helgen bound-hands pose; can walk and chat, cannot
//     fight, sneak or use hands.
//   - carried: fully immobilised; the captive's client follows the carrier's
//     clone and the server snaps the body back when it drifts. Camera stays free.
// Flows: arresting needs the configured "manacles" item (settings.manaclesFormId)
// in the captor's inventory, carrying needs no item. A conscious target must
// accept a Yes/No consent prompt. A DOWNED (bleeding-out) target is
// captured/carried instantly with no prompt, and doing so STOPS their bleedout
// (mp.set isDead=false stands them up instead of a temple respawn).
// A restrained (bound) target is carried with no prompt as well and is told who carries them.
// Texts name players as SearchSystem does: "A stranger" until introduced.
//
// Wire protocol: all packets are MsgType.CustomPacket carrying JSON.
//   Client -> Server:
//     { customPacketType: "captureRequest",  target: <actorFormId> }
//     { customPacketType: "carryRequest",    target: <actorFormId> }
//     { customPacketType: "putdownRequest",  target: <actorFormId> }   // stop carrying, keep any binding (older clients' Put down)
//     { customPacketType: "releaseRequest",  target: <actorFormId> }   // one step per press: set a carried captive down, else free their binds (captor or last carrier)
//     { customPacketType: "captureConsentResult", requestId, accepted } // from the prompted target
//     { customPacketType: "playerMenuRequest", target: <actorFormId> }  // the player menu opened on target
//   Server -> Client:
//     { customPacketType: "playerMenuState", target, canRelease }       // -> the requester only: whether their Release applies
//     { customPacketType: "restraintState",  boundHands, carried, carrier, anim, carriedAnim, carryForward, carryUp, carryYaw } // -> captive's RestraintService (carrier = actor id or 0)
//     { customPacketType: "carryState",      carrying, anim }              // -> carrier's RestraintService (pose only)
//     { customPacketType: "captureConsentRequest", requestId, text }       // -> target's CaptureConsentService
//     { customPacketType: "captureNotice",   text }                        // -> corner notification

const RESTRAINT_PACKET = "restraintState";
const CARRY_PACKET = "carryState";
const CONSENT_REQUEST = "captureConsentRequest";
const NOTICE_PACKET = "captureNotice";
const MENU_STATE_PACKET = "playerMenuState";

// Mirrors the captive's restraint state so the gamemode can gate its own logic
// on it (e.g. skip its temple pass-out for a bound or carried player):
//   mp.get(actorId, "private.restrained") -> { boundHands, carried, captorActorId, carrierActorId } | null
const RESTRAINED_PROP = "private.restrained";

// Bound or carried, for systems that gate on restraint
export function isRestrained(mp: Mp, actorId: number): boolean {
  try {
    const r = mp.get(actorId, RESTRAINED_PROP);
    return !!r && (r.boundHands === true || r.carried === true);
  } catch {
    return false;
  }
}

// 0 = no item requirement; set manaclesFormId in server-settings.json to gate arrests behind a carryable item
const DEFAULT_MANACLES = 0;

// Carry re-snap interval and min carrier movement (squared game units); throttling keeps reliable Teleport packets and rubber-banding to a minimum
const CARRY_FOLLOW_INTERVAL_MS = 350;
const CARRY_FOLLOW_MIN_MOVE_SQ = 96 * 96;
const CARRY_MAX_DRIFT_SQ = 256 * 256;

// Carried pose: a vanilla chair sit idle held across the carrier's arms. Overridable via "carriedAnimEvent", "carryOffsetForward", "carryOffsetUp", "carryYawOffset"
const DEFAULT_CARRIED_ANIM = "IdleChairEnterInstant";
const DEFAULT_CARRY_FORWARD = 30;
const DEFAULT_CARRY_UP = 40;
const DEFAULT_CARRY_YAW = 90;

// A consent prompt lapses if the target doesn't answer in time. Overridable via "captureConsentTimeoutMs".
const DEFAULT_CONSENT_TIMEOUT_MS = 20000;

// The same (captor, target) pair may only be prompted this often. Overridable via "captureConsentCooldownMs".
const DEFAULT_CONSENT_COOLDOWN_MS = 15000;

// Server-side backstop for the client's "look at a player" rule: max capture/carry initiation range in game units (~activate range). Overridable via "captureInteractMaxDistance".
const DEFAULT_INTERACT_MAX_DISTANCE = 256;

// A refused carry or carrier attack is logged at most this often per actor
const REFUSAL_LOG_MS = 5000;

interface RestraintInfo {
  boundHands: boolean;   // arrested
  carried: boolean;
  captorActorId: number; // who applied it: release authority + disconnect cleanup
  offlineCarrierActorId?: number; // who was carrying them when they logged out
  lastCarrierActorId?: number; // who carried them last in this restraint: may free the binds until they disconnect
  addedShackle?: boolean; // a pair was moved captor -> captive, remove it on release
}

interface PendingConsent {
  kind: "capture" | "carry";
  captorActorId: number;
  targetActorId: number;
  timer: ReturnType<typeof setTimeout>;
}

export class CaptureSystem implements System {
  systemName = "CaptureSystem";
  constructor(private log: Log) { }

  private manaclesFormId = DEFAULT_MANACLES;
  private captiveAnim = "OffsetBoundStandingStart";
  private carrierAnim = "OffsetCarryBasketStart";
  private carriedAnim = DEFAULT_CARRIED_ANIM;
  private carryForward = DEFAULT_CARRY_FORWARD;
  private carryUp = DEFAULT_CARRY_UP;
  private carryYaw = DEFAULT_CARRY_YAW;
  private interactMaxDistance = DEFAULT_INTERACT_MAX_DISTANCE;
  private consentTimeoutMs = DEFAULT_CONSENT_TIMEOUT_MS;
  private consentCooldownMs = DEFAULT_CONSENT_COOLDOWN_MS;

  // targetActorId -> restraint state
  private restraints = new Map<number, RestraintInfo>();
  // carrierActorId -> carriedActorId (a carrier holds at most one body)
  private carrying = new Map<number, number>();
  // carriedActorId -> carrierActorId (reverse lookup)
  private carriedBy = new Map<number, number>();
  // carriedActorId -> last carrier pos we snapped them to (spam/jitter guard)
  private lastCarryPos = new Map<number, [number, number, number]>();
  // requestId -> outstanding consent prompt
  private pending = new Map<number, PendingConsent>();
  // "captorActorId:targetActorId" -> last prompt timestamp (spam guard)
  private consentCooldown = new Map<string, number>();
  private nextRequestId = 1;
  private lastFollowMs = 0;
  // actorId -> last refusal log timestamp
  private refusalLogAt = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    this.manaclesFormId = toFormId(s.manaclesFormId, DEFAULT_MANACLES);
    // Fail closed: a set-but-unparseable manaclesFormId must not disable the
    // item requirement, so pin it to a form nobody can hold. Explicit "0"/"0x0" is a legitimate disable, not a parse failure.
    const rawManacles = String(s.manaclesFormId ?? "").trim();
    if (rawManacles && rawManacles !== "0" && rawManacles !== "0x0" && this.manaclesFormId === 0) {
      this.manaclesFormId = 0xffffffff;
      this.log(`[capture] ERROR: manaclesFormId "${s.manaclesFormId}" is not a valid form id — arrests disabled until fixed`);
    }
    if (typeof s.captiveAnimEvent === "string" && s.captiveAnimEvent) {
      this.captiveAnim = s.captiveAnimEvent;
    }
    if (typeof s.carrierAnimEvent === "string" && s.carrierAnimEvent) {
      this.carrierAnim = s.carrierAnimEvent;
    }
    const all = s.allSettings as Record<string, unknown> | null;
    const rawDist = Number(all?.["captureInteractMaxDistance"]);
    if (Number.isFinite(rawDist) && rawDist > 0) this.interactMaxDistance = rawDist;
    const rawTimeout = Number(all?.["captureConsentTimeoutMs"]);
    if (Number.isInteger(rawTimeout) && rawTimeout > 0) this.consentTimeoutMs = rawTimeout;
    const rawCooldown = Number(all?.["captureConsentCooldownMs"]);
    if (Number.isInteger(rawCooldown) && rawCooldown >= 0) this.consentCooldownMs = rawCooldown;
    const rawCarriedAnim = all?.["carriedAnimEvent"];
    if (typeof rawCarriedAnim === "string" && rawCarriedAnim) this.carriedAnim = rawCarriedAnim;
    this.carryForward = this.finiteSetting(all, "carryOffsetForward", DEFAULT_CARRY_FORWARD);
    this.carryUp = this.finiteSetting(all, "carryOffsetUp", DEFAULT_CARRY_UP);
    this.carryYaw = this.finiteSetting(all, "carryYawOffset", DEFAULT_CARRY_YAW);
    if (this.manaclesFormId === 0) {
      this.log(`[capture] manaclesFormId not configured — arrests need no item`);
    } else {
      this.log(`[capture] manacles item = 0x${this.manaclesFormId.toString(16)}`);
    }
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      this.onActorAssigned(ctx, actorId);
    });
    this.installCarrierFightBlock(ctx.svr as Mp);
  }

  // A carrier cannot fight; onHitAttempt and onSpellCastAttempt need the native build, onHitDamageAttempt works on any
  private installCarrierFightBlock(mp: Mp): void {
    for (const event of ["onHitAttempt", "onHitDamageAttempt", "onSpellCastAttempt"]) {
      const previous = typeof mp[event] === "function" ? mp[event] : null;
      mp[event] = (actorId: number, ...rest: unknown[]): boolean => {
        if (this.carrying.has(actorId >>> 0)) {
          this.logRefusal(actorId >>> 0, event);
          return false;
        }
        if (!previous) return true;
        try {
          return previous.call(mp, actorId, ...rest) !== false;
        } catch {
          return true;
        }
      };
    }
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "captureRequest": this.onCaptureRequest(ctx, userId, content); break;
      case "carryRequest": this.onCarryRequest(ctx, userId, content); break;
      case "putdownRequest": this.onPutdownRequest(ctx, userId, content); break;
      case "releaseRequest": this.onReleaseRequest(ctx, userId, content); break;
      case "captureConsentResult": this.onConsentResult(ctx, userId, content); break;
      case "playerMenuRequest": this.onMenuRequest(ctx, userId, content); break;
      default: break;
    }
  }

  // Snap every carried body onto its carrier; runs from the ~1ms update loop, self-throttled to CARRY_FOLLOW_INTERVAL_MS
  async updateAsync(ctx: SystemContext): Promise<void> {
    if (this.carrying.size === 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastFollowMs < CARRY_FOLLOW_INTERVAL_MS) {
      return;
    }
    this.lastFollowMs = now;

    const mp = ctx.svr as Mp;
    for (const [carrierActorId, carriedActorId] of Array.from(this.carrying)) {
      try {
        // A dead carrier drops the body; a dead body slips free
        if (this.isDowned(mp, carrierActorId)) {
          this.stopCarry(ctx, carriedActorId);
          this.notice(ctx, this.userOf(ctx, carriedActorId), "Your carrier collapsed.");
          continue;
        }
        if (this.isDowned(mp, carriedActorId)) {
          this.stopCarry(ctx, carriedActorId);
          continue;
        }
        const loc = mp.get(carrierActorId, "locationalData");
        if (!loc || !Array.isArray(loc.pos)) {
          continue;
        }
        const carrierYaw = Array.isArray(loc.rot) ? Number(loc.rot[2]) || 0 : 0;
        const [x, y, z] = this.carryTarget(loc.pos as number[], carrierYaw);
        // Each snap is a full engine teleport on the carried client; only
        // resend when the body actually drifted or changed cell
        const carriedLoc = mp.get(carriedActorId, "locationalData");
        if (carriedLoc && Array.isArray(carriedLoc.pos) &&
          carriedLoc.cellOrWorldDesc === loc.cellOrWorldDesc) {
          const dx = x - carriedLoc.pos[0], dy = y - carriedLoc.pos[1], dz = z - carriedLoc.pos[2];
          if (dx * dx + dy * dy + dz * dz < CARRY_MAX_DRIFT_SQ) {
            continue;
          }
        } else {
          const prev = this.lastCarryPos.get(carriedActorId);
          if (prev && carriedLoc && carriedLoc.cellOrWorldDesc === loc.cellOrWorldDesc) {
            const dx = x - prev[0], dy = y - prev[1], dz = z - prev[2];
            if (dx * dx + dy * dy + dz * dz < CARRY_FOLLOW_MIN_MOVE_SQ) {
              continue;
            }
          }
        }
        mp.set(carriedActorId, "locationalData", {
          cellOrWorldDesc: loc.cellOrWorldDesc,
          pos: [x, y, z],
          rot: [0, 0, carrierYaw + this.carryYaw],
        });
        this.lastCarryPos.set(carriedActorId, [x, y, z]);
      } catch (e) {
        // carrier or carried vanished mid-carry: free the pair so no stale restraint record survives
        this.releaseTarget(ctx, carriedActorId);
      }
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId); } catch { return; }
    if (!actorId) {
      return;
    }
    // If they were carrying someone, set that body down (keeping any binding).
    const carried = this.carrying.get(actorId);
    if (carried !== undefined) {
      this.stopCarry(ctx, carried);
    }
    // If they were being carried, tell their carrier to stop.
    const carrier = this.carriedBy.get(actorId);
    if (carrier !== undefined) {
      this.carrying.delete(carrier);
      this.carriedBy.delete(actorId);
      this.lastCarryPos.delete(actorId);
      this.sendCarryState(ctx, carrier, false);
      const own = this.restraints.get(actorId);
      if (own) {
        own.offlineCarrierActorId = carrier;
      }
    }
    // Release anyone they had captured; a carrier leaving loses the right to free
    for (const [tid, info] of Array.from(this.restraints)) {
      if (info.captorActorId === actorId) {
        this.releaseTarget(ctx, tid);
      } else if (info.lastCarrierActorId === actorId) {
        info.lastCarrierActorId = undefined;
      }
    }
    // Their own restraint record is intentionally KEPT: relogging must not be an escape; onActorAssigned re-applies or cleans up on reconnect
    this.dropPendingFor(actorId);
  }

  // Fired by Spawn when a user gets an actor: re-applies a restraint that survived the captive's relog, or clears a stale persisted private.restrained (e.g. after a server restart)
  private onActorAssigned(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as Mp;
    const info = this.restraints.get(actorId);
    if (!info) {
      try {
        if (mp.get(actorId, RESTRAINED_PROP)) {
          mp.set(actorId, RESTRAINED_PROP, null);
        }
      } catch { /* form gone */ }
      return;
    }
    if (this.userOf(ctx, info.captorActorId) < 0) {
      this.releaseTarget(ctx, actorId);
      return;
    }
    if (info.carried) {
      const carrier = info.offlineCarrierActorId ?? info.captorActorId;
      info.offlineCarrierActorId = undefined;
      if (this.userOf(ctx, carrier) >= 0 && !this.isDowned(mp, carrier) &&
        !this.carryRefusal(ctx, carrier, actorId)) {
        this.applyCarry(ctx, actorId, carrier);
        return;
      }
      info.carried = false;
      if (!info.boundHands) {
        this.releaseTarget(ctx, actorId);
        return;
      }
    }
    this.mirrorState(ctx, actorId);
    this.sendRestraint(ctx, actorId, info);
    if (info.boundHands) {
      this.equipShackles(ctx, actorId); // relog must not shed the cuffs
    }
  }

  // ── Incoming requests ──────────────────────────────────────────────────────

  private onCaptureRequest(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    const captorActorId = this.resolveActor(ctx, userId);
    if (captorActorId === null) {
      return;
    }
    const targetActorId = toFormId(content.target, 0);
    if (!this.validTarget(ctx, captorActorId, targetActorId)) {
      this.notice(ctx, userId, "Look at another player to restrain them.");
      return;
    }
    if (this.restraints.get(targetActorId)?.boundHands) {
      this.notice(ctx, userId, `${nameShownTo(mp, captorActorId, targetActorId)} is already restrained.`);
      return;
    }
    if (!this.hasManacles(mp, captorActorId)) {
      this.notice(ctx, userId, "You need manacles to restrain someone.");
      return;
    }
    // A downed target can't answer a prompt: capture instantly and stop bleedout so the engine doesn't whisk them to a temple
    if (this.isDowned(mp, targetActorId)) {
      this.stopBleedout(ctx, targetActorId);
      this.applyCapture(ctx, targetActorId, captorActorId);
      this.notice(ctx, userId, `You restrained ${nameShownTo(mp, captorActorId, targetActorId)}.`);
      return;
    }
    this.requestConsent(ctx, "capture", captorActorId, targetActorId);
  }

  private onCarryRequest(ctx: SystemContext, userId: number, content: Content): void {
    const mp = ctx.svr as Mp;
    const carrierActorId = this.resolveActor(ctx, userId);
    if (carrierActorId === null) {
      return;
    }
    const targetActorId = toFormId(content.target, 0);
    if (!this.validTarget(ctx, carrierActorId, targetActorId)) {
      this.notice(ctx, userId, "Look at another player to carry them.");
      return;
    }
    const refusal = this.carryRefusal(ctx, carrierActorId, targetActorId);
    if (refusal) {
      this.notice(ctx, userId, refusal);
      return;
    }
    const downed = this.isDowned(mp, targetActorId);
    // Downed and restrained targets are picked up without a prompt
    if (downed || this.restraints.has(targetActorId)) {
      if (downed) this.stopBleedout(ctx, targetActorId);
      this.applyCarry(ctx, targetActorId, carrierActorId);
      this.notice(ctx, userId, `You picked up ${nameShownTo(mp, carrierActorId, targetActorId)}.`);
      this.notice(ctx, this.userOf(ctx, targetActorId), `${nameShownTo(mp, targetActorId, carrierActorId)} is carrying you.`);
      return;
    }
    this.requestConsent(ctx, "carry", carrierActorId, targetActorId);
  }

  private onPutdownRequest(ctx: SystemContext, userId: number, content: Content): void {
    const requesterActorId = this.resolveActor(ctx, userId);
    if (requesterActorId === null) {
      return;
    }
    const targetActorId = toFormId(content.target, 0);
    const carrier = this.carriedBy.get(targetActorId);
    if (carrier === undefined) {
      this.notice(ctx, userId, "They are not being carried.");
      return;
    }
    if (carrier !== requesterActorId) {
      this.notice(ctx, userId, "You are not carrying them.");
      return;
    }
    this.stopCarry(ctx, targetActorId);
    this.notice(ctx, userId, `You set ${nameShownTo(ctx.svr, requesterActorId, targetActorId)} down.`);
  }

  private onReleaseRequest(ctx: SystemContext, userId: number, content: Content): void {
    const requesterActorId = this.resolveActor(ctx, userId);
    if (requesterActorId === null) {
      return;
    }
    const targetActorId = toFormId(content.target, 0);
    if (!this.restraints.has(targetActorId) && !this.carriedBy.has(targetActorId)) {
      this.notice(ctx, userId, "They are not restrained.");
      return;
    }
    const step = this.releaseStep(requesterActorId, targetActorId);
    if (!step) {
      this.notice(ctx, userId, "Only their captor or carrier can release them.");
      return;
    }
    const name = nameShownTo(ctx.svr, requesterActorId, targetActorId);
    if (step === "putdown") {
      this.stopCarry(ctx, targetActorId);
      this.notice(ctx, userId, `You set ${name} down.`);
      return;
    }
    this.releaseTarget(ctx, targetActorId);
    this.notice(ctx, userId, `You released ${name}.`);
  }

  // Only the requester's own release permission is revealed, never the target's restraint details
  private onMenuRequest(ctx: SystemContext, userId: number, content: Content): void {
    const requesterActorId = this.resolveActor(ctx, userId);
    const targetActorId = toFormId(content.target, 0);
    if (requesterActorId === null || !targetActorId) {
      return;
    }
    try {
      ctx.svr.sendCustomPacket(userId, JSON.stringify({
        customPacketType: MENU_STATE_PACKET,
        target: targetActorId,
        canRelease: this.releaseStep(requesterActorId, targetActorId) !== null,
      }));
    } catch { /* user gone */ }
  }

  // What the requester's next Release does: a carried captive is set down first, their binds come off on a later press by the captor or last carrier; null when not theirs to release
  private releaseStep(requesterActorId: number, targetActorId: number): "putdown" | "release" | null {
    const info = this.restraints.get(targetActorId);
    const isCaptor = info?.captorActorId === requesterActorId;
    const carrier = this.carriedBy.get(targetActorId);
    if (carrier !== undefined) {
      return carrier === requesterActorId || isCaptor ? "putdown" : null;
    }
    return isCaptor || info?.lastCarrierActorId === requesterActorId ? "release" : null;
  }

  private onConsentResult(ctx: SystemContext, userId: number, content: Content): void {
    const requestId = Number(content.requestId);
    const pend = this.pending.get(requestId);
    if (!pend) {
      return;
    }
    // The answer must come from the player who was actually prompted.
    const responderActorId = this.resolveActor(ctx, userId);
    if (responderActorId !== pend.targetActorId) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pend.timer);

    const captorUser = this.userOf(ctx, pend.captorActorId);
    const targetName = nameShownTo(ctx.svr, pend.captorActorId, pend.targetActorId);
    if (content.accepted !== true) {
      this.notice(ctx, captorUser, `${targetName} refused.`);
      return;
    }
    if (captorUser < 0) {
      return; // captor left while we waited
    }
    // They may have moved apart (or perma-died) while the prompt was open.
    if (!this.validTarget(ctx, pend.captorActorId, pend.targetActorId)) {
      this.notice(ctx, captorUser, `${targetName} is out of reach.`);
      return;
    }

    if (pend.kind === "capture") {
      if (!this.hasManacles(ctx.svr as Mp, pend.captorActorId)) {
        this.notice(ctx, captorUser, "You no longer have manacles.");
        return;
      }
      this.applyCapture(ctx, pend.targetActorId, pend.captorActorId);
      this.notice(ctx, captorUser, `${targetName} accepted — restrained.`);
    } else {
      const refusal = this.carryRefusal(ctx, pend.captorActorId, pend.targetActorId);
      if (refusal) {
        this.notice(ctx, captorUser, refusal);
        this.notice(ctx, userId, `${nameShownTo(ctx.svr, pend.targetActorId, pend.captorActorId)} can no longer carry you.`);
        return;
      }
      this.applyCarry(ctx, pend.targetActorId, pend.captorActorId);
      this.notice(ctx, captorUser, `${targetName} accepted — carrying.`);
    }
  }

  // ── State transitions ──────────────────────────────────────────────────────

  private requestConsent(ctx: SystemContext, kind: "capture" | "carry",
    captorActorId: number, targetActorId: number): void {
    const targetUser = this.userOf(ctx, targetActorId);
    if (targetUser < 0) {
      return;
    }
    for (const pend of this.pending.values()) {
      if (pend.targetActorId === targetActorId || pend.captorActorId === captorActorId) {
        this.notice(ctx, this.userOf(ctx, captorActorId),
          "A consent request is already pending.");
        return;
      }
    }
    const targetName = nameShownTo(ctx.svr, captorActorId, targetActorId);
    const now = Date.now();
    const cooldownKey = `${captorActorId}:${targetActorId}`;
    const lastPrompt = this.consentCooldown.get(cooldownKey);
    if (lastPrompt !== undefined && now - lastPrompt < this.consentCooldownMs) {
      this.notice(ctx, this.userOf(ctx, captorActorId),
        `Wait before asking ${targetName} again.`);
      return;
    }
    if (this.consentCooldown.size > 512) {
      for (const [k, t] of Array.from(this.consentCooldown)) {
        if (now - t >= this.consentCooldownMs) {
          this.consentCooldown.delete(k);
        }
      }
    }
    this.consentCooldown.set(cooldownKey, now);

    const requestId = this.nextRequestId++;
    const timer = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        this.notice(ctx, this.userOf(ctx, captorActorId),
          `${targetName} did not respond.`);
      }
    }, this.consentTimeoutMs);
    this.pending.set(requestId, { kind, captorActorId, targetActorId, timer });

    const captorName = nameShownTo(ctx.svr, targetActorId, captorActorId);
    const verb = kind === "capture" ? "restrain" : "carry";
    ctx.svr.sendCustomPacket(targetUser, JSON.stringify({
      customPacketType: CONSENT_REQUEST,
      requestId,
      text: `${captorName} wants to ${verb} you. Allow?`,
    }));
    this.notice(ctx, this.userOf(ctx, captorActorId),
      `Waiting for ${targetName} to accept…`);
  }

  // Reflect the captive's current restraint record into RESTRAINED_PROP
  private mirrorState(ctx: SystemContext, targetActorId: number): void {
    const info = this.restraints.get(targetActorId);
    const value = info
      ? {
        boundHands: info.boundHands,
        carried: info.carried,
        captorActorId: info.captorActorId,
        carrierActorId: this.carriedBy.get(targetActorId) ?? 0,
      }
      : null;
    try {
      (ctx.svr as Mp).set(targetActorId, RESTRAINED_PROP, value);
    } catch { /* form gone */ }
  }

  private applyCapture(ctx: SystemContext, targetActorId: number, captorActorId: number): void {
    const info = this.restraints.get(targetActorId)
      ?? { boundHands: false, carried: false, captorActorId };
    info.boundHands = true;
    info.captorActorId = captorActorId;
    this.restraints.set(targetActorId, info);
    this.mirrorState(ctx, targetActorId);
    this.sendRestraint(ctx, targetActorId, info);
    if (this.equipShackles(ctx, targetActorId, captorActorId)) {
      info.addedShackle = true;
    }
    this.log(`[capture] ${targetActorId.toString(16)} bound by ${captorActorId.toString(16)}`);
  }

  private applyCarry(ctx: SystemContext, targetActorId: number, carrierActorId: number): void {
    const info = this.restraints.get(targetActorId)
      ?? { boundHands: false, carried: false, captorActorId: carrierActorId };
    info.carried = true;
    info.lastCarrierActorId = carrierActorId;
    this.restraints.set(targetActorId, info);
    this.carrying.set(carrierActorId, targetActorId);
    this.carriedBy.set(targetActorId, carrierActorId);
    this.lastCarryPos.delete(targetActorId);
    this.mirrorState(ctx, targetActorId);
    this.sendRestraint(ctx, targetActorId, info);
    this.sendCarryState(ctx, carrierActorId, true);
    this.log(`[carry] ${carrierActorId.toString(16)} carries ${targetActorId.toString(16)}`);
  }

  // Stop a carry while preserving any arrest (boundHands) the captive still has.
  private stopCarry(ctx: SystemContext, targetActorId: number): void {
    const carrier = this.carriedBy.get(targetActorId);
    if (carrier === undefined) {
      return;
    }
    this.carrying.delete(carrier);
    this.carriedBy.delete(targetActorId);
    this.lastCarryPos.delete(targetActorId);
    this.sendCarryState(ctx, carrier, false);

    const info = this.restraints.get(targetActorId);
    if (info) {
      info.carried = false;
      if (info.boundHands) {
        this.sendRestraint(ctx, targetActorId, info);
      } else {
        this.restraints.delete(targetActorId);
        this.sendRestraint(ctx, targetActorId, { boundHands: false, carried: false, captorActorId: carrier });
      }
    }
    this.mirrorState(ctx, targetActorId);
  }

  // Fully free a captive: clear arrest + carry and restore their controls.
  private releaseTarget(ctx: SystemContext, targetActorId: number): void {
    const carrier = this.carriedBy.get(targetActorId);
    if (carrier !== undefined) {
      this.carrying.delete(carrier);
      this.carriedBy.delete(targetActorId);
      this.lastCarryPos.delete(targetActorId);
      this.sendCarryState(ctx, carrier, false);
    }
    const info = this.restraints.get(targetActorId);
    this.restraints.delete(targetActorId);
    this.mirrorState(ctx, targetActorId);
    this.sendRestraint(ctx, targetActorId, { boundHands: false, carried: false, captorActorId: 0 });
    if (info?.boundHands === true) {
      this.removeShackles(ctx, targetActorId, info.addedShackle === true);
    }
  }

  // ── Packet senders ─────────────────────────────────────────────────────────

  private sendRestraint(ctx: SystemContext, targetActorId: number, info: RestraintInfo): void {
    const u = this.userOf(ctx, targetActorId);
    if (u < 0) {
      return;
    }
    ctx.svr.sendCustomPacket(u, JSON.stringify({
      customPacketType: RESTRAINT_PACKET,
      boundHands: info.boundHands,
      carried: info.carried,
      carrier: this.carriedBy.get(targetActorId) ?? 0,
      anim: this.captiveAnim,
      carriedAnim: this.carriedAnim,
      carryForward: this.carryForward,
      carryUp: this.carryUp,
      carryYaw: this.carryYaw,
    }));
  }

  // Where the carried body is held: ahead of and above the carrier, matching the captive client's follow
  private carryTarget(carrierPos: number[], carrierYawDeg: number): [number, number, number] {
    const yaw = carrierYawDeg * Math.PI / 180;
    return [
      carrierPos[0] + Math.sin(yaw) * this.carryForward,
      carrierPos[1] + Math.cos(yaw) * this.carryForward,
      carrierPos[2] + this.carryUp,
    ];
  }

  private finiteSetting(all: Record<string, unknown> | null, key: string, fallback: number): number {
    const raw = all?.[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private sendCarryState(ctx: SystemContext, carrierActorId: number, carrying: boolean): void {
    const u = this.userOf(ctx, carrierActorId);
    if (u < 0) {
      return;
    }
    ctx.svr.sendCustomPacket(u, JSON.stringify({
      customPacketType: CARRY_PACKET,
      carrying,
      anim: this.carrierAnim,
    }));
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    if (userId < 0) {
      return;
    }
    try {
      ctx.svr.sendCustomPacket(userId, JSON.stringify({ customPacketType: NOTICE_PACKET, text }));
    } catch { /* user gone */ }
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  // No carry chains and no bound carriers: a carrier cannot be carried, a carried or bound player cannot carry; empty when allowed
  private carryRefusal(ctx: SystemContext, carrierActorId: number, targetActorId: number): string {
    const refusal = this.carrying.has(carrierActorId) ? "You are already carrying someone."
      : this.carriedBy.has(carrierActorId) ? "You cannot carry anyone while being carried."
      : this.restraints.get(carrierActorId)?.boundHands ? "You cannot carry anyone while bound."
      : this.carrying.has(targetActorId) ? `${nameShownTo(ctx.svr, carrierActorId, targetActorId)} is carrying someone.`
      : this.carriedBy.has(targetActorId) ? `${nameShownTo(ctx.svr, carrierActorId, targetActorId)} is already being carried.`
      : "";
    if (refusal) this.logRefusal(carrierActorId, `carry of ${targetActorId.toString(16)}`);
    return refusal;
  }

  private logRefusal(actorId: number, what: string): void {
    const now = Date.now();
    if (now - (this.refusalLogAt.get(actorId) ?? 0) < REFUSAL_LOG_MS) return;
    this.refusalLogAt.set(actorId, now);
    this.log(`[carry] refused ${what} by ${actorId.toString(16)}`);
  }

  private validTarget(ctx: SystemContext, selfActorId: number, targetActorId: number): boolean {
    if (!targetActorId || targetActorId === selfActorId) {
      return false;
    }
    if (this.userOf(ctx, targetActorId) < 0) {
      return false; // must be a connected player, not an NPC
    }
    if (this.isPermaDead(ctx.svr as Mp, targetActorId)) {
      return false; // a permadead corpse stays in-world but is untouchable
    }
    return this.nearEnough(ctx, selfActorId, targetActorId);
  }

  // Same cell/worldspace and within interactMaxDistance; the target id is client-supplied, so this stops a modified client grabbing players across the map
  private nearEnough(ctx: SystemContext, selfActorId: number, targetActorId: number): boolean {
    try {
      if (ctx.svr.getActorCellOrWorld(selfActorId) !==
        ctx.svr.getActorCellOrWorld(targetActorId)) {
        return false;
      }
      const a = ctx.svr.getActorPos(selfActorId);
      const b = ctx.svr.getActorPos(targetActorId);
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz <= this.interactMaxDistance * this.interactMaxDistance;
    } catch {
      return false;
    }
  }

  private isPermaDead(mp: Mp, actorId: number): boolean {
    try {
      return mp.get(actorId, "private.permaDead") === true;
    } catch {
      return false;
    }
  }

  private countShackles(mp: Mp, actorId: number): number {
    try {
      const inv = mp.get(actorId, "inventory");
      const entries: any[] = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries.reduce((n, e) => (e.baseId >>> 0) === this.manaclesFormId ? n + (e.count | 0) : n, 0);
    } catch {
      return 0;
    }
  }

  // Adjust an actor's cuff count by +-1 via the inventory property.
  private moveShackle(mp: Mp, actorId: number, delta: number): boolean {
    try {
      const inv = mp.get(actorId, "inventory");
      const entries: any[] = (inv && Array.isArray(inv.entries) ? inv.entries : []).map((e: any) => ({ ...e }));
      const stack = entries.find((e) => (e.baseId >>> 0) === this.manaclesFormId && !e.worn && !e.wornLeft);
      if (delta > 0) {
        if (stack) { stack.count += delta; } else { entries.push({ baseId: this.manaclesFormId, count: delta }); }
      } else {
        const any = entries.find((e) => (e.baseId >>> 0) === this.manaclesFormId && e.count > 0);
        if (!any) { return false; }
        any.count += delta;
      }
      mp.set(actorId, "inventory", { entries: entries.filter((e) => e.count > 0) });
      return true;
    } catch {
      return false;
    }
  }

  // On initial capture one pair is MOVED from the captor so cuffs are conserved, never minted; a relog re-apply only re-equips.
  // Returns true when a pair was moved.
  private equipShackles(ctx: SystemContext, targetActorId: number, captorActorId?: number): boolean {
    if (this.manaclesFormId === 0 || this.manaclesFormId === 0xffffffff) {
      return false;
    }
    const mp = ctx.svr as Mp;
    let transferred = false;
    if (captorActorId && this.countShackles(mp, targetActorId) === 0) {
      if (this.moveShackle(mp, captorActorId, -1)) {
        this.moveShackle(mp, targetActorId, +1);
        transferred = true;
      }
    }
    if (this.countShackles(mp, targetActorId) === 0) {
      return transferred; // nothing to equip and EquipItem must not mint one
    }
    try {
      const self = { type: "form", desc: mp.getDescFromId(targetActorId) };
      const item = { type: "espm", desc: mp.getDescFromId(this.manaclesFormId) };
      // EquipItem(akItem, abPreventRemoval, abSilent)
      mp.callPapyrusFunction("method", "Actor", "EquipItem", self, [item, true, true]);
    } catch (e) {
      this.log(`[capture] equip shackles failed: ${e}`);
    }
    return transferred;
  }

  // Unequip always; destroy only the one transferred pair, a captive's pre-owned cuffs are never touched.
  private removeShackles(ctx: SystemContext, targetActorId: number, removeOne: boolean): void {
    if (this.manaclesFormId === 0 || this.manaclesFormId === 0xffffffff) {
      return;
    }
    const mp = ctx.svr as Mp;
    try {
      const self = { type: "form", desc: mp.getDescFromId(targetActorId) };
      const item = { type: "espm", desc: mp.getDescFromId(this.manaclesFormId) };
      // UnequipItem(akItem, abPreventEquip, abSilent)
      mp.callPapyrusFunction("method", "Actor", "UnequipItem", self, [item, false, true]);
    } catch (e) {
      this.log(`[capture] unequip shackles failed: ${e}`);
    }
    if (removeOne) {
      this.moveShackle(mp, targetActorId, -1);
    }
  }

  private hasManacles(mp: Mp, actorId: number): boolean {
    if (this.manaclesFormId === 0) {
      return true; // no item requirement configured
    }
    try {
      const inv = mp.get(actorId, "inventory");
      const entries: any[] = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries.some((e) => (e.baseId >>> 0) === this.manaclesFormId && e.count > 0);
    } catch {
      return false;
    }
  }

  // For players, isDead===true means "bleeding out" (they always respawn), the death-state we may instant-capture
  private isDowned(mp: Mp, actorId: number): boolean {
    try {
      return mp.get(actorId, "isDead") === true;
    } catch {
      return false;
    }
  }

  // Stand a bleeding-out player up in place (isDead=false, no teleport), cancelling temple respawn; also closes the death screen and clears the pending death choice right away instead of waiting on the respawn hook
  private stopBleedout(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as Mp;
    if (this.isPermaDead(mp, actorId)) {
      return; // permadeath is final: never resurrect a locked corpse
    }
    try {
      mp.set(actorId, "isDead", false);
    } catch { /* already up / form gone */ }
    try {
      mp.set(actorId, "private.deathChoicePending", false);
    } catch { /* form gone */ }
    const u = this.userOf(ctx, actorId);
    if (u >= 0) {
      try {
        ctx.svr.sendCustomPacket(u, JSON.stringify({ customPacketType: "deathScreen", hide: true }));
      } catch { /* user gone */ }
    }
  }

  private resolveActor(ctx: SystemContext, userId: number): number | null {
    try {
      const a = ctx.svr.getUserActor(userId);
      return a ? a : null;
    } catch {
      return null;
    }
  }

  // getUserByActor returns Networking::InvalidUserId (65535) for userless
  // actors (NPCs, logout-grace parked bodies), so normalize to -1 here.
  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      const u = ctx.svr.getUserByActor(actorId);
      if (typeof u !== "number" || u < 0 || u >= 0xffff || !ctx.svr.isConnected(u)) {
        return -1;
      }
      return u;
    } catch {
      return -1;
    }
  }

  private dropPendingFor(actorId: number): void {
    for (const [id, pend] of Array.from(this.pending)) {
      if (pend.captorActorId === actorId || pend.targetActorId === actorId) {
        clearTimeout(pend.timer);
        this.pending.delete(id);
      }
    }
  }
}
