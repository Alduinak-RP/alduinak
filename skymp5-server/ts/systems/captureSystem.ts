import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Arrest / capture / carry ──────────────────────────────────────────────────
//
// Server-authoritative restraint feature, built entirely on the `mp` JS API
// (no engine changes). Two restraint states, both reflected on the captive's
// client by the (server-driven) RestraintService:
//
//   • boundHands ("arrest"): the Helgen bound-hands pose. The captive can still
//     walk and chat, but cannot fight, sneak or use their hands.
//   • carried: fully immobilised; the server snaps the body onto the carrier
//     every tick (like a horse passenger). Camera stays free.
//
// Flows
//   - A captor needs the configured "manacles" item (settings.manaclesFormId) in
//     their inventory to arrest. Carrying needs no item.
//   - A conscious target is asked to consent (a Yes/No prompt on their client);
//     the restraint is only applied if they accept.
//   - A DOWNED target (first death-state / bleeding out) is captured/carried
//     INSTANTLY with no prompt — they can't answer one — and doing so STOPS
//     their bleedout (mp.set isDead=false stands them up in place instead of
//     letting the engine respawn them at a temple).
//
// Wire protocol — all packets are MsgType.CustomPacket carrying JSON.
//   Client -> Server:
//     { customPacketType: "captureRequest",  target: <actorFormId> }
//     { customPacketType: "carryRequest",    target: <actorFormId> }
//     { customPacketType: "putdownRequest",  target: <actorFormId> }   // stop carrying, keep any binding
//     { customPacketType: "releaseRequest",  target: <actorFormId> }   // fully free
//     { customPacketType: "captureConsentResult", requestId, accepted } // from the prompted target
//   Server -> Client:
//     { customPacketType: "restraintState",  boundHands, carried, anim }   // -> captive's RestraintService
//     { customPacketType: "carryState",      carrying, anim }              // -> carrier's RestraintService (pose only)
//     { customPacketType: "captureConsentRequest", requestId, text }       // -> target's CaptureConsentService
//     { customPacketType: "captureNotice",   text }                        // -> corner notification

const RESTRAINT_PACKET = "restraintState";
const CARRY_PACKET = "carryState";
const CONSENT_REQUEST = "captureConsentRequest";
const NOTICE_PACKET = "captureNotice";

// Server-side property mirroring the captive's restraint state, so the gamemode
// script (which cannot see this system's memory) can gate its own logic on it —
// e.g. skip its temple pass-out for a player someone has bound or picked up.
//   mp.get(actorId, "private.restrained")
//     -> { boundHands, carried, captorActorId, carrierActorId } | null
const RESTRAINED_PROP = "private.restrained";

// Vanilla prisoner cuffs (ARMO) — the placeholder default for manaclesFormId.
const DEFAULT_MANACLES = 0x0005dc02;

// How often a carried body is re-snapped onto its carrier, and how far (squared,
// game units) the carrier must move before we bother re-teleporting. Throttling
// keeps the reliable Teleport packets — and any rubber-banding — to a minimum.
const CARRY_FOLLOW_INTERVAL_MS = 120;
const CARRY_FOLLOW_MIN_MOVE_SQ = 16 * 16;

// A consent prompt lapses if the target doesn't answer in time.
const CONSENT_TIMEOUT_MS = 20000;

// The same (captor, target) pair may only be prompted this often.
const CONSENT_COOLDOWN_MS = 15000;

// Server-side backstop for the client's "look at a player" rule: capture/carry
// may only be initiated within this many game units (~activate range).
const INTERACT_MAX_DISTANCE = 256;

interface RestraintInfo {
  boundHands: boolean;   // arrested
  carried: boolean;      // being carried
  captorActorId: number; // who applied it — release authority + disconnect cleanup
  offlineCarrierActorId?: number; // who was carrying them when they logged out
}

interface PendingConsent {
  kind: "capture" | "carry";
  captorActorId: number;
  targetActorId: number;
  timer: ReturnType<typeof setTimeout>;
}

const toFormId = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v >>> 0;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) {
      return n >>> 0;
    }
  }
  return fallback;
};

export class CaptureSystem implements System {
  systemName = "CaptureSystem";
  constructor(private log: Log) { }

  private manaclesFormId = DEFAULT_MANACLES;
  private captiveAnim = "OffsetBoundStandingStart";
  private carrierAnim = "OffsetCarryBasketStart";

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

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    this.manaclesFormId = toFormId(s.manaclesFormId, DEFAULT_MANACLES);
    if (typeof s.captiveAnimEvent === "string" && s.captiveAnimEvent) {
      this.captiveAnim = s.captiveAnimEvent;
    }
    if (typeof s.carrierAnimEvent === "string" && s.carrierAnimEvent) {
      this.carrierAnim = s.carrierAnimEvent;
    }
    if (this.manaclesFormId === DEFAULT_MANACLES) {
      this.log(`[capture] WARNING: manaclesFormId is not configured, defaulting to ` +
        `0x${DEFAULT_MANACLES.toString(16)} (Helgen prisoner cuffs — worn ARMO that ` +
        `players never hold in inventory). The bind/arrest path will NOT work until ` +
        `"manaclesFormId" in server-settings.json points to a real carryable item.`);
    } else {
      this.log(`[capture] manacles item = 0x${this.manaclesFormId.toString(16)}`);
    }
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      this.onActorAssigned(ctx, actorId);
    });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "captureRequest": this.onCaptureRequest(ctx, userId, content); break;
      case "carryRequest": this.onCarryRequest(ctx, userId, content); break;
      case "putdownRequest": this.onPutdownRequest(ctx, userId, content); break;
      case "releaseRequest": this.onReleaseRequest(ctx, userId, content); break;
      case "captureConsentResult": this.onConsentResult(ctx, userId, content); break;
      default: break;
    }
  }

  // Snap every carried body onto its carrier. Runs from the per-system update
  // loop (~1ms); we self-throttle to CARRY_FOLLOW_INTERVAL_MS.
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
        const loc = mp.get(carrierActorId, "locationalData");
        if (!loc || !Array.isArray(loc.pos)) {
          continue;
        }
        const [x, y, z] = loc.pos as number[];
        const prev = this.lastCarryPos.get(carriedActorId);
        if (prev) {
          const dx = x - prev[0], dy = y - prev[1], dz = z - prev[2];
          if (dx * dx + dy * dy + dz * dz < CARRY_FOLLOW_MIN_MOVE_SQ) {
            continue; // carrier hasn't moved enough to bother
          }
        }
        mp.set(carriedActorId, "locationalData", {
          cellOrWorldDesc: loc.cellOrWorldDesc,
          pos: loc.pos,
          rot: loc.rot,
        });
        this.lastCarryPos.set(carriedActorId, [x, y, z]);
      } catch (e) {
        // carrier or carried vanished mid-carry — free the pair entirely so no
        // stale restraint record / private.restrained survives
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
    // Release anyone they had captured.
    for (const [tid, info] of Array.from(this.restraints)) {
      if (info.captorActorId === actorId) {
        this.releaseTarget(ctx, tid);
      }
    }
    // Their own restraint record is intentionally KEPT: relogging must not be
    // an escape. onActorAssigned re-applies or cleans it up on reconnect.
    this.dropPendingFor(actorId);
  }

  // Fired by the Spawn system whenever a user gets an actor (login / character
  // select). Re-applies a restraint that survived the captive's relog, or
  // clears a stale persisted private.restrained (e.g. after a server restart).
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
      if (this.userOf(ctx, carrier) >= 0 && !this.carrying.has(carrier) &&
        !this.carriedBy.has(actorId)) {
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
      this.notice(ctx, userId, `${this.nameOf(ctx, targetActorId)} is already restrained.`);
      return;
    }
    if (!this.hasManacles(mp, captorActorId)) {
      this.notice(ctx, userId, "You need manacles to restrain someone.");
      return;
    }
    // A downed (bleeding-out) target can't answer a prompt: capture instantly and
    // stop their bleedout so the engine doesn't whisk them to a temple.
    if (this.isDowned(mp, targetActorId)) {
      this.stopBleedout(mp, targetActorId);
      this.applyCapture(ctx, targetActorId, captorActorId);
      this.notice(ctx, userId, `You restrained ${this.nameOf(ctx, targetActorId)}.`);
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
    if (this.carrying.has(carrierActorId)) {
      this.notice(ctx, userId, "You are already carrying someone.");
      return;
    }
    if (this.carriedBy.has(targetActorId)) {
      this.notice(ctx, userId, `${this.nameOf(ctx, targetActorId)} is already being carried.`);
      return;
    }
    if (this.isDowned(mp, targetActorId)) {
      this.stopBleedout(mp, targetActorId);
      this.applyCarry(ctx, targetActorId, carrierActorId);
      this.notice(ctx, userId, `You picked up ${this.nameOf(ctx, targetActorId)}.`);
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
    this.notice(ctx, userId, `You set ${this.nameOf(ctx, targetActorId)} down.`);
  }

  private onReleaseRequest(ctx: SystemContext, userId: number, content: Content): void {
    const requesterActorId = this.resolveActor(ctx, userId);
    if (requesterActorId === null) {
      return;
    }
    const targetActorId = toFormId(content.target, 0);
    const info = this.restraints.get(targetActorId);
    if (!info) {
      this.notice(ctx, userId, "They are not restrained.");
      return;
    }
    // Only the captor (or whoever is carrying them) may release — prevents griefing.
    const carrier = this.carriedBy.get(targetActorId);
    if (info.captorActorId !== requesterActorId && carrier !== requesterActorId) {
      this.notice(ctx, userId, "Only their captor can release them.");
      return;
    }
    this.releaseTarget(ctx, targetActorId);
    this.notice(ctx, userId, `You released ${this.nameOf(ctx, targetActorId)}.`);
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
    if (content.accepted !== true) {
      this.notice(ctx, captorUser, `${this.nameOf(ctx, pend.targetActorId)} refused.`);
      return;
    }
    if (captorUser < 0) {
      return; // captor left while we waited
    }
    // They may have moved apart (or perma-died) while the prompt was open.
    if (!this.validTarget(ctx, pend.captorActorId, pend.targetActorId)) {
      this.notice(ctx, captorUser, `${this.nameOf(ctx, pend.targetActorId)} is out of reach.`);
      return;
    }

    if (pend.kind === "capture") {
      if (!this.hasManacles(ctx.svr as Mp, pend.captorActorId)) {
        this.notice(ctx, captorUser, "You no longer have manacles.");
        return;
      }
      this.applyCapture(ctx, pend.targetActorId, pend.captorActorId);
      this.notice(ctx, captorUser, `${this.nameOf(ctx, pend.targetActorId)} accepted — restrained.`);
    } else {
      if (this.carrying.has(pend.captorActorId) || this.carriedBy.has(pend.targetActorId)) {
        return; // state changed while waiting
      }
      this.applyCarry(ctx, pend.targetActorId, pend.captorActorId);
      this.notice(ctx, captorUser, `${this.nameOf(ctx, pend.targetActorId)} accepted — carrying.`);
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
    const now = Date.now();
    const cooldownKey = `${captorActorId}:${targetActorId}`;
    const lastPrompt = this.consentCooldown.get(cooldownKey);
    if (lastPrompt !== undefined && now - lastPrompt < CONSENT_COOLDOWN_MS) {
      this.notice(ctx, this.userOf(ctx, captorActorId),
        `Wait before asking ${this.nameOf(ctx, targetActorId)} again.`);
      return;
    }
    if (this.consentCooldown.size > 512) {
      for (const [k, t] of Array.from(this.consentCooldown)) {
        if (now - t >= CONSENT_COOLDOWN_MS) {
          this.consentCooldown.delete(k);
        }
      }
    }
    this.consentCooldown.set(cooldownKey, now);

    const requestId = this.nextRequestId++;
    const timer = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        this.notice(ctx, this.userOf(ctx, captorActorId),
          `${this.nameOf(ctx, targetActorId)} did not respond.`);
      }
    }, CONSENT_TIMEOUT_MS);
    this.pending.set(requestId, { kind, captorActorId, targetActorId, timer });

    const captorName = this.nameOf(ctx, captorActorId) || "Someone";
    const verb = kind === "capture" ? "restrain" : "carry";
    ctx.svr.sendCustomPacket(targetUser, JSON.stringify({
      customPacketType: CONSENT_REQUEST,
      requestId,
      text: `${captorName} wants to ${verb} you. Allow?`,
    }));
    this.notice(ctx, this.userOf(ctx, captorActorId),
      `Waiting for ${this.nameOf(ctx, targetActorId)} to accept…`);
  }

  // Reflect the captive's current restraint record into RESTRAINED_PROP.
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
    this.log(`[capture] ${targetActorId.toString(16)} bound by ${captorActorId.toString(16)}`);
  }

  private applyCarry(ctx: SystemContext, targetActorId: number, carrierActorId: number): void {
    const info = this.restraints.get(targetActorId)
      ?? { boundHands: false, carried: false, captorActorId: carrierActorId };
    info.carried = true;
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
    this.restraints.delete(targetActorId);
    this.mirrorState(ctx, targetActorId);
    this.sendRestraint(ctx, targetActorId, { boundHands: false, carried: false, captorActorId: 0 });
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
      anim: this.captiveAnim,
    }));
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

  // Same cell/worldspace and within INTERACT_MAX_DISTANCE. The target id is
  // client-supplied, so this is what keeps a modified client from grabbing
  // players across the map.
  private nearEnough(ctx: SystemContext, selfActorId: number, targetActorId: number): boolean {
    try {
      if (ctx.svr.getActorCellOrWorld(selfActorId) !==
        ctx.svr.getActorCellOrWorld(targetActorId)) {
        return false;
      }
      const a = ctx.svr.getActorPos(selfActorId);
      const b = ctx.svr.getActorPos(targetActorId);
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz <= INTERACT_MAX_DISTANCE * INTERACT_MAX_DISTANCE;
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

  private hasManacles(mp: Mp, actorId: number): boolean {
    try {
      const inv = mp.get(actorId, "inventory");
      const entries: any[] = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries.some((e) => (e.baseId >>> 0) === this.manaclesFormId && e.count > 0);
    } catch {
      return false;
    }
  }

  // For players, isDead===true means "bleeding out" (they always respawn), i.e.
  // the first death-state we may instant-capture.
  private isDowned(mp: Mp, actorId: number): boolean {
    try {
      return mp.get(actorId, "isDead") === true;
    } catch {
      return false;
    }
  }

  // Stand a bleeding-out player back up in place (SetIsDead(false) -> Respawn
  // without teleport), cancelling the temple respawn.
  private stopBleedout(mp: Mp, actorId: number): void {
    if (this.isPermaDead(mp, actorId)) {
      return; // permadeath is final — never resurrect a locked corpse
    }
    try {
      mp.set(actorId, "isDead", false);
    } catch { /* already up / form gone */ }
  }

  private resolveActor(ctx: SystemContext, userId: number): number | null {
    try {
      const a = ctx.svr.getUserActor(userId);
      return a ? a : null;
    } catch {
      return null;
    }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      return ctx.svr.getUserByActor(actorId);
    } catch {
      return -1;
    }
  }

  private nameOf(ctx: SystemContext, actorId: number): string {
    try {
      const n = ctx.svr.getActorName(actorId);
      return typeof n === "string" ? n.trim() : "";
    } catch {
      return "";
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
