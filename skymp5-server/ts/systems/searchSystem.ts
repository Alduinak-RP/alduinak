import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";
import { isNamedItemBase } from "./inventoryExtras";
import { isBound, isRestrained } from "./captureSystem";
import { baseIdOf, guardMpHook, isAlive, isBleedingOut, isPlayerActor, nameShownTo } from "./actorUtil";
import { fieldData, view } from "./espmMagic";
import { HostingSystem } from "./hostingSystem";
import { SettleWear, wearSettler } from "./durabilityNative";
import { every } from "./timers";
import { loc } from "../loc";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Player search ─────────────────────────────────────────────────────────────
//
// Consent-gated search of another player's inventory via the VANILLA container window: on accept the server marks the searcher as the target's inventory occupant (setInventoryOccupant native), which authorizes the engine's PutItem/TakeItem, and tells the searcher's client to open the target's inventory.
// Item moves ride the normal server-validated container-sync path; if the pair separates, the session ends and the client closes the window.
// Dead bodies (players or spawned NPCs) open at once without consent; the searcher may take and put items like vanilla looting.
// A bound player is searched without consent too; startSession tells them who is searching, and such a search ends once they are freed. A player who is only carried is asked as usual.
// A restrained (bound or carried) player cannot search anyone.
// A dead player's body gives up a limited number of distinct items (a stack counts once); the take that reaches the limit closes the window and respawns the player, which removes the body.
// Property keys and writings stay put in every window but a PK body's (BodySystem), which lists them by name so they move like any other item.
// A living server NPC is never searched: only its body is. Its owner is pointed at the pet menu, anyone else is refused.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "searchRequest", target: <actorFormId> }   // skin: the interact menu's choice on a body, true Skin and false Search (bodyAction's chosen)
//     { customPacketType: "searchConsentResult", requestId, accepted }
//     { customPacketType: "searchEnd" }                              // searcher closed the window
//   Server -> Client:
//     { customPacketType: "searchConsentRequest", requestId, text }  // -> target
//     { customPacketType: "searchApproved", target, body, entries }  // -> searcher: open the window; entries [{ baseId, count, name? }]
//     { customPacketType: "searchClose" }                            // -> searcher: close it
//     { customPacketType: "searchNotice", text }                     // corner toast

// Defaults; overridable via "searchConsentTimeoutMs" / "searchConsentCooldownMs".
const DEFAULT_CONSENT_TIMEOUT_MS = 20000;
const DEFAULT_CONSENT_COOLDOWN_MS = 15000;

// Initiation range mirrors CaptureSystem's activate-range backstop. Overridable via "searchStartMaxDistance".
const DEFAULT_START_MAX_DISTANCE = 256;
// The window closes when the pair drifts further apart than this. Overridable via "searchKeepMaxDistance".
const DEFAULT_KEEP_MAX_DISTANCE = 512;
// A dead NPC adds the half length of its base's bounds (OBND) to both reaches, or this when the base has none
const DEFAULT_BODY_EXTRA_REACH = 128;
const MAX_BODY_EXTRA_REACH = 512;
// Distance re-check cadence.
const WATCH_INTERVAL_MS = 500;
// Distinct items a dead player's body gives up before it is removed. Overridable via "searchPlayerBodyTakeLimit" (0 = no limit).
const DEFAULT_PLAYER_BODY_TAKE_LIMIT = 2;
// Refused takes within this window share one inventory resync
const RESYNC_DELAY_MS = 200;

interface PendingConsent {
  searcherActorId: number;
  targetActorId: number;
  timer: ReturnType<typeof setTimeout>;
}

interface SearchSession {
  searcherActorId: number;
  targetActorId: number;
  body: boolean;
  // Started without consent because the target was bound
  auto: boolean;
  // A pet's inventory opened by its owner
  pet: boolean;
}

export class SearchSystem implements System {
  systemName = "SearchSystem";
  constructor(private log: Log, private hosting: HostingSystem) { }

  // Set by index.ts: items a looter may not have off this body. Asked again on every take, so the window and the server agree
  hidesItem?: (ctx: SystemContext, viewerActorId: number, targetActorId: number, baseId: number) => boolean;
  // Set by index.ts: the owner of a pet or companion (0 for none), and whether a living NPC is game, for the refusal's wording
  ownedBy?: (actorId: number) => number;
  isAnimal?: (ctx: SystemContext, actorId: number) => boolean;
  // Set by index.ts: true when the interaction with a body became something else (skinning), so it is not opened
  bodyAction?: (ctx: SystemContext, searcherActorId: number, bodyActorId: number, chosen?: boolean) => boolean;
  // Set by index.ts: why a searcher may not open this body, "" when they may
  bodyRefusal?: (searcherActorId: number, bodyActorId: number) => string;
  // Set by index.ts: true for a body whose window lists property keys and writings by name
  namedLoot?: (bodyActorId: number) => boolean;

  // targetActorId -> session (a target is searched by at most one player)
  private sessions = new Map<number, SearchSession>();
  // searcherActorId -> targetActorId (reverse lookup)
  private searching = new Map<number, number>();
  // requestId -> outstanding consent prompt
  private pending = new Map<number, PendingConsent>();
  // "searcherActorId:targetActorId" -> last prompt timestamp (spam guard)
  private consentCooldown = new Map<string, number>();
  // dead player actorId -> base forms taken from the current body
  private bodyTakes = new Map<number, Set<number>>();
  // searchers whose inventory resync is already scheduled
  private resyncing = new Set<number>();
  private nextRequestId = 1;
  private warnedNoNative = false;
  private warnedNoRespawn = false;
  private consentTimeoutMs = DEFAULT_CONSENT_TIMEOUT_MS;
  private consentCooldownMs = DEFAULT_CONSENT_COOLDOWN_MS;
  private startMaxDistance = DEFAULT_START_MAX_DISTANCE;
  private keepMaxDistance = DEFAULT_KEEP_MAX_DISTANCE;
  private playerBodyTakeLimit = DEFAULT_PLAYER_BODY_TAKE_LIMIT;
  private settleWear: SettleWear = () => { };
  // NPC base id -> extra reach of its body
  private bodyReachCache = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    const rawStart = Number(all?.["searchStartMaxDistance"]);
    if (Number.isFinite(rawStart) && rawStart > 0) this.startMaxDistance = rawStart;
    const rawKeep = Number(all?.["searchKeepMaxDistance"]);
    if (Number.isFinite(rawKeep) && rawKeep > 0) this.keepMaxDistance = rawKeep;
    const rawTimeout = Number(all?.["searchConsentTimeoutMs"]);
    if (Number.isInteger(rawTimeout) && rawTimeout > 0) this.consentTimeoutMs = rawTimeout;
    const rawCooldown = Number(all?.["searchConsentCooldownMs"]);
    if (Number.isInteger(rawCooldown) && rawCooldown >= 0) this.consentCooldownMs = rawCooldown;
    const rawLimit = Number(all?.["searchPlayerBodyTakeLimit"]);
    if (Number.isInteger(rawLimit) && rawLimit >= 0) this.playerBodyTakeLimit = rawLimit;
    this.settleWear = wearSettler(ctx.svr, all, this.log);
    this.installTakeHook(ctx);
    this.installPutHook(ctx);
    every("search", WATCH_INTERVAL_MS, () => this.poll(ctx));
  }

  // A window without names would move the wrong key or letter, so they stay put there, and a stack the window never showed is not there to move
  private stuck(ctx: SystemContext, targetActorId: number, actorId: number, baseId: number): boolean {
    return this.isSearching(targetActorId, actorId)
      && ((isNamedItemBase(baseId) && !this.namesListed(targetActorId)) || this.hidden(ctx, actorId, targetActorId, baseId));
  }

  private namesListed(targetActorId: number): boolean {
    return this.sessions.get(targetActorId)?.body === true && this.namedLoot?.(targetActorId) === true;
  }

  // A worn stack the searcher's copy still shows after another looter took it is not on the body
  private goneFromBody(ctx: SystemContext, targetActorId: number, actorId: number, baseId: number, count: number): boolean {
    return this.isSearching(targetActorId, actorId) && this.sessions.get(targetActorId)?.body === true
      && this.heldCount(ctx, targetActorId, baseId) < count;
  }

  // Chains mp.onTakeItem like the other systems' activation hooks; a refused take never leaves the body
  private installTakeHook(ctx: SystemContext): void {
    guardMpHook(ctx.svr as Mp, "onTakeItem", (sourceId: number, actorId: number, baseId: number, count: number) => {
      if (this.stuck(ctx, sourceId >>> 0, actorId >>> 0, baseId >>> 0) || this.goneFromBody(ctx, sourceId >>> 0, actorId >>> 0, baseId >>> 0, count)) {
        this.resyncInventory(ctx, actorId >>> 0);
        return false;
      }
      const taken = this.limitedTakes(ctx, sourceId >>> 0, actorId >>> 0);
      // More of a counted base form is free, so a take the server splits over several copies moves whole
      if (taken && taken.size >= this.playerBodyTakeLimit && !taken.has(baseId >>> 0)) {
        this.resyncInventory(ctx, actorId >>> 0);
        return false;
      }
      return () => {
        if (taken) this.recordTake(ctx, sourceId >>> 0, actorId >>> 0, taken, baseId >>> 0, count);
        if (!this.watchNamedMove(ctx, sourceId >>> 0, actorId >>> 0, baseId >>> 0, count, true)) {
          this.log(`[take] ${(actorId >>> 0).toString(16)} takes ${(baseId >>> 0).toString(16)} x${count} from ${(sourceId >>> 0).toString(16)}`);
        }
      };
    });
  }

  // The native side finds a PK body's key or writing by its name alone, so a move whose client sent none fails there; the mover's pack is resynced either way
  private watchNamedMove(ctx: SystemContext, bodyId: number, actorId: number, baseId: number, count: number, take: boolean): boolean {
    if (!isNamedItemBase(baseId) || !this.isSearching(bodyId, actorId) || !this.namesListed(bodyId)) return false;
    const held = this.heldCount(ctx, bodyId, baseId);
    this.resyncInventory(ctx, actorId);
    const [who, base, body] = [actorId, baseId, bodyId].map((id) => id.toString(16));
    setImmediate(() => {
      if (this.heldCount(ctx, bodyId, baseId) === held) {
        this.log(`[${take ? "take" : "put"}] ${who} ${take ? "take" : "put"} of ${base} x${count} ${take ? "from" : "into"} ${body} refused natively: no copy under the name the client sent, the pack is resynced`);
      } else if (take) {
        this.log(`[take] ${who} takes ${base} x${count} from ${body}`);
      }
    });
    return true;
  }

  // The same gate on the way in, so what a searcher may not take back never reaches the target
  private installPutHook(ctx: SystemContext): void {
    guardMpHook(ctx.svr as Mp, "onPutItem", (targetId: number, actorId: number, baseId: number, count: number) => {
      this.log(`[put] ${(actorId >>> 0).toString(16)} puts ${(baseId >>> 0).toString(16)} x${count} into ${(targetId >>> 0).toString(16)}`);
      if (this.stuck(ctx, targetId >>> 0, actorId >>> 0, baseId >>> 0)) {
        this.resyncInventory(ctx, actorId >>> 0);
        return false;
      }
      return () => { this.watchNamedMove(ctx, targetId >>> 0, actorId >>> 0, baseId >>> 0, count, false); };
    });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "searchRequest": this.onSearchRequest(ctx, userId, content); break;
      case "searchConsentResult": this.onConsentResult(ctx, userId, content); break;
      case "searchEnd": this.onSearchEnd(ctx, userId); break;
      default: break;
    }
  }

  // Watch every active pair; end the search when they drift apart.
  poll(ctx: SystemContext): void {
    if (this.sessions.size === 0 && this.bodyTakes.size === 0) {
      return;
    }
    // A respawned player's next death is a fresh body
    for (const id of Array.from(this.bodyTakes.keys())) {
      if (!this.isDead(ctx, id)) this.bodyTakes.delete(id);
    }
    for (const s of Array.from(this.sessions.values())) {
      // A side that lost its user (character switch, logout-grace park) ends the search
      if (this.userOf(ctx, s.searcherActorId) < 0 || (!s.body && !s.pet && this.userOf(ctx, s.targetActorId) < 0)) {
        this.endSession(ctx, s, "", "user gone");
        continue;
      }
      // Respawned, revived or despawned
      if (s.body && !this.isDead(ctx, s.targetActorId)) {
        this.endSession(ctx, s, loc("search.end.bodyGone"));
        continue;
      }
      if (s.pet && this.isDead(ctx, s.targetActorId)) {
        this.endSession(ctx, s, "");
        continue;
      }
      if (s.auto && !isBound(ctx.svr, s.targetActorId)) {
        this.endSession(ctx, s, loc("search.end.released"));
        continue;
      }
      if (!this.nearEnough(ctx, s.searcherActorId, s.targetActorId, this.keepMaxDistance + this.bodyReach(ctx, s.targetActorId))) {
        this.endSession(ctx, s, loc("search.end.movedAway"));
      }
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId); } catch { return; }
    if (!actorId) {
      return;
    }
    const targetOfMine = this.searching.get(actorId);
    if (targetOfMine !== undefined) {
      const s = this.sessions.get(targetOfMine);
      if (s) {
        this.endSession(ctx, s, "");
      }
    }
    const asTarget = this.sessions.get(actorId);
    if (asTarget) {
      this.endSession(ctx, asTarget, loc("search.end.disconnected"));
    }
    this.dropPending((pend) => pend.searcherActorId === actorId || pend.targetActorId === actorId);
  }

  private dropPending(match: (pend: PendingConsent) => boolean): void {
    for (const [id, pend] of Array.from(this.pending)) {
      if (match(pend)) {
        clearTimeout(pend.timer);
        this.pending.delete(id);
      }
    }
  }

  // A death voids a prompt: the body opens through a fresh request with its own checks, and the dead do not search
  private promptVoid(ctx: SystemContext, pend: PendingConsent): boolean {
    return this.isDead(ctx, pend.targetActorId) || this.isDead(ctx, pend.searcherActorId);
  }

  // ── Incoming requests ───────────────────────────────────────────────────────

  private onSearchRequest(ctx: SystemContext, userId: number, content: Content): void {
    const searcherActorId = this.resolveActor(ctx, userId);
    if (searcherActorId === null) {
      return;
    }
    if (!this.hasOccupantNative(ctx)) {
      this.notice(ctx, userId, loc("search.needsBuild"));
      if (!this.warnedNoNative) {
        this.warnedNoNative = true;
        this.log("[search] setInventoryOccupant native missing - rebuild the server (CI) to enable searches");
      }
      return;
    }
    if (this.isDead(ctx, searcherActorId) || isBleedingOut(ctx.svr, searcherActorId)) {
      return;
    }
    if (isRestrained(ctx.svr, searcherActorId)) {
      this.notice(ctx, userId, loc("search.whileRestrained"));
      return;
    }
    const targetActorId = toFormId(content.target);
    if (!this.validTarget(ctx, searcherActorId, targetActorId)) {
      if (targetActorId) {
        const d = this.distance(ctx, searcherActorId, targetActorId);
        this.log(`[search] ${searcherActorId.toString(16)} refused ${targetActorId.toString(16)}: dead ${this.isDead(ctx, targetActorId)}, distance ${Number.isFinite(d) ? Math.round(d) : "other cell"}, reach ${this.startMaxDistance + this.bodyReach(ctx, targetActorId)}`);
      }
      this.notice(ctx, userId, loc("search.lookAt"));
      return;
    }
    if (this.sessions.has(targetActorId)) {
      this.notice(ctx, userId, loc("search.alreadySearched", { name: nameShownTo(ctx.svr,searcherActorId, targetActorId) }));
      return;
    }
    if (this.searching.has(searcherActorId)) {
      this.notice(ctx, userId, loc("search.alreadySearching"));
      return;
    }
    this.dropPending((pend) => this.promptVoid(ctx, pend));
    for (const pend of this.pending.values()) {
      if (pend.targetActorId === targetActorId || pend.searcherActorId === searcherActorId) {
        this.notice(ctx, userId, loc("search.pending"));
        return;
      }
    }
    const body = this.isDead(ctx, targetActorId);
    if (!body && !this.isPlayerCharacter(ctx, targetActorId)) {
      this.notice(ctx, userId, this.npcRefusal(ctx, searcherActorId, targetActorId));
      this.log(`[search] ${searcherActorId.toString(16)} refused living npc ${targetActorId.toString(16)}`);
      return;
    }
    if (body && this.bodyAction?.(ctx, searcherActorId, targetActorId, typeof content.skin === "boolean" ? content.skin : undefined)) return;
    const bodyRefusal = body ? this.bodyRefusal?.(searcherActorId, targetActorId) : "";
    if (bodyRefusal) {
      this.notice(ctx, userId, bodyRefusal);
      return;
    }
    // Bodies and bound players are searched without a prompt
    if (body || isBound(ctx.svr, targetActorId)) {
      this.startSession(ctx, searcherActorId, targetActorId, body, !body);
      return;
    }
    const now = Date.now();
    const cooldownKey = `${searcherActorId}:${targetActorId}`;
    const lastPrompt = this.consentCooldown.get(cooldownKey);
    if (lastPrompt !== undefined && now - lastPrompt < this.consentCooldownMs) {
      this.notice(ctx, userId, loc("search.cooldown", { name: nameShownTo(ctx.svr,searcherActorId, targetActorId) }));
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

    const targetUser = this.userOf(ctx, targetActorId);
    if (targetUser < 0) {
      return;
    }
    const requestId = this.nextRequestId++;
    const timer = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        this.notice(ctx, this.userOf(ctx, searcherActorId),
          loc("search.noResponse", { name: nameShownTo(ctx.svr,searcherActorId, targetActorId) }));
      }
    }, this.consentTimeoutMs);
    this.pending.set(requestId, { searcherActorId, targetActorId, timer });

    const searcherName = nameShownTo(ctx.svr,targetActorId, searcherActorId);
    ctx.svr.sendCustomPacket(targetUser, JSON.stringify({
      customPacketType: "searchConsentRequest",
      requestId,
      text: loc("search.ask", { name: searcherName }),
    }));
    this.notice(ctx, userId, loc("search.waiting", { name: nameShownTo(ctx.svr,searcherActorId, targetActorId) }));
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

    const searcherUser = this.userOf(ctx, pend.searcherActorId);
    if (this.promptVoid(ctx, pend)) {
      this.log(`[search] ${pend.targetActorId.toString(16)} answered ${pend.searcherActorId.toString(16)}'s prompt after a death, ignored`);
      this.notice(ctx, searcherUser, loc("search.cannotAnswer", { name: nameShownTo(ctx.svr,pend.searcherActorId, pend.targetActorId) }));
      return;
    }
    if (content.accepted !== true) {
      this.notice(ctx, searcherUser, loc("search.refused", { name: nameShownTo(ctx.svr,pend.searcherActorId, pend.targetActorId) }));
      return;
    }
    if (searcherUser < 0) {
      return; // searcher left while we waited
    }
    if (!this.validTarget(ctx, pend.searcherActorId, pend.targetActorId)) {
      this.notice(ctx, searcherUser, loc("search.outOfReach", { name: nameShownTo(ctx.svr,pend.searcherActorId, pend.targetActorId) }));
      return;
    }
    if (this.sessions.has(pend.targetActorId) || this.searching.has(pend.searcherActorId) || isRestrained(ctx.svr, pend.searcherActorId)) {
      return; // state changed while waiting
    }
    this.startSession(ctx, pend.searcherActorId, pend.targetActorId, this.isDead(ctx, pend.targetActorId));
  }

  private onSearchEnd(ctx: SystemContext, userId: number): void {
    const searcherActorId = this.resolveActor(ctx, userId);
    const targetActorId = searcherActorId === null ? undefined : this.searching.get(searcherActorId);
    const s = targetActorId === undefined ? undefined : this.sessions.get(targetActorId);
    if (s) {
      this.endSession(ctx, s, "", "window closed");
    }
  }

  // Only the dead are searched; the wording tells a pet's owner where its inventory is
  private npcRefusal(ctx: SystemContext, searcherActorId: number, targetActorId: number): string {
    const owner = this.ownedBy?.(targetActorId) ?? 0;
    if (owner) return owner === searcherActorId ? loc("search.npc.usePetMenu") : loc("search.npc.companion");
    try {
      if (this.isAnimal?.(ctx, targetActorId)) return loc("search.lookAt");
    } catch (e) {
      this.log(`[search] animal check failed: ${e}`);
    }
    return loc("search.npc.onlyDead");
  }

  private startSession(ctx: SystemContext, searcherActorId: number, targetActorId: number, body: boolean, auto = false, pet = false): void {
    const searcherUser = this.userOf(ctx, searcherActorId);
    const taken = body ? this.bodyTakesOf(ctx, targetActorId) : undefined;
    if (taken && taken.size >= this.playerBodyTakeLimit) {
      this.notice(ctx, searcherUser, loc("search.bodyEmpty"));
      return;
    }
    if (!this.setOccupant(ctx, targetActorId, searcherActorId)) {
      this.notice(ctx, searcherUser, loc("search.couldNotStart"));
      return;
    }
    this.sessions.set(targetActorId, { searcherActorId, targetActorId, body, auto, pet });
    this.searching.set(searcherActorId, targetActorId);
    // What is taken from a searched player carries the wear of their last fight
    this.settleWear(targetActorId);
    ctx.svr.sendCustomPacket(searcherUser, JSON.stringify({
      customPacketType: "searchApproved",
      target: targetActorId,
      body,
      // Simple stacks of the real inventory: the searcher's local clone never holds it, so the client syncs the clone before opening the window
      entries: this.visibleEntriesOf(ctx, searcherActorId, targetActorId, body),
    }));
    this.notice(ctx, this.userOf(ctx, targetActorId),
      (body ? loc("search.searchingBody", { name: nameShownTo(ctx.svr,targetActorId, searcherActorId) }) : loc("search.searchingYou", { name: nameShownTo(ctx.svr,targetActorId, searcherActorId) })));
    this.log(`[search] ${searcherActorId.toString(16)} searches ${this.kindOf({ body })}${targetActorId.toString(16)}`);
  }

  private kindOf(s: { body: boolean }): string {
    return s.body ? "body " : "";
  }

  // Opens a pet's inventory for its owner in the vanilla container window; empty result on success, else the refusal
  openPetInventory(ctx: SystemContext, viewerActorId: number, targetActorId: number): string {
    if (!this.hasOccupantNative(ctx)) return loc("search.pet.needsBuild");
    if (this.isDead(ctx, viewerActorId) || isBleedingOut(ctx.svr, viewerActorId)) return loc("search.pet.cannotNow");
    if (isRestrained(ctx.svr, viewerActorId)) return loc("search.pet.whileRestrained");
    if (this.sessions.has(targetActorId)) return loc("search.pet.beingSearched");
    if (this.searching.has(viewerActorId)) return loc("search.alreadySearching");
    this.startSession(ctx, viewerActorId, targetActorId, false, false, true);
    return "";
  }

  // Closes a pet's inventory window when the pet leaves the world or its owner
  endPetInventory(ctx: SystemContext, petActorId: number): void {
    const s = this.sessions.get(petActorId);
    if (s?.pet) this.endSession(ctx, s, "");
  }

  // ── Session teardown ────────────────────────────────────────────────────────

  private endSession(ctx: SystemContext, s: SearchSession, reasonForSearcher: string, logReason = reasonForSearcher): void {
    this.log(`[search] ${s.searcherActorId.toString(16)} stops searching ${this.kindOf(s)}${s.targetActorId.toString(16)}: ${logReason || "ended"}`);
    this.sessions.delete(s.targetActorId);
    this.searching.delete(s.searcherActorId);
    this.setOccupant(ctx, s.targetActorId, 0);
    const searcherUser = this.userOf(ctx, s.searcherActorId);
    if (searcherUser >= 0) {
      try {
        ctx.svr.sendCustomPacket(searcherUser, JSON.stringify({ customPacketType: "searchClose" }));
      } catch { /* user gone */ }
      if (reasonForSearcher) {
        this.notice(ctx, searcherUser, reasonForSearcher);
      }
    }
  }

  // ── Player body looting limit ───────────────────────────────────────────────

  // Checked per take, so a consented search whose target died mid-session is limited too
  private limitedTakes(ctx: SystemContext, targetActorId: number, actorId: number): Set<number> | undefined {
    return this.isSearching(targetActorId, actorId) ? this.bodyTakesOf(ctx, targetActorId) : undefined;
  }

  private isSearching(targetActorId: number, actorId: number): boolean {
    const s = this.sessions.get(targetActorId);
    return !!s && s.searcherActorId === actorId;
  }

  // Base forms taken from a dead player's current body, shared by every session on it; undefined when unlimited
  private bodyTakesOf(ctx: SystemContext, targetActorId: number): Set<number> | undefined {
    if (this.playerBodyTakeLimit <= 0 || !this.isDead(ctx, targetActorId) || !this.isPlayerCharacter(ctx, targetActorId)) {
      return undefined;
    }
    let taken = this.bodyTakes.get(targetActorId);
    if (!taken) {
      taken = new Set<number>();
      this.bodyTakes.set(targetActorId, taken);
    }
    return taken;
  }

  // One entry per base form, so more of an already taken stack is free; a take the body cannot cover moves nothing and is not counted
  private recordTake(ctx: SystemContext, targetActorId: number, searcherActorId: number, taken: Set<number>, baseId: number, count: number): void {
    if (taken.has(baseId)) {
      return;
    }
    if (this.heldCount(ctx, targetActorId, baseId) < count) {
      return;
    }
    taken.add(baseId);
    if (taken.size >= this.playerBodyTakeLimit) {
      // Deferred so the engine finishes moving this item first
      setTimeout(() => this.finishBody(ctx, targetActorId, searcherActorId), 0);
    }
  }

  private finishBody(ctx: SystemContext, targetActorId: number, searcherActorId: number): void {
    const s = this.sessions.get(targetActorId);
    if (s) {
      this.endSession(ctx, s, loc("search.bodyLimit"));
    }
    if (!this.isDead(ctx, targetActorId)) {
      return;
    }
    const mp = ctx.svr as Mp;
    if (typeof mp.respawnActor !== "function") {
      if (!this.warnedNoRespawn) {
        this.warnedNoRespawn = true;
        this.log("[search] respawnActor native missing - looted player bodies stay until respawnSeconds; rebuild the server (CI)");
      }
      return;
    }
    try {
      mp.respawnActor(targetActorId);
      this.log(`[search] body ${targetActorId.toString(16)} looted by ${searcherActorId.toString(16)}, respawned`);
    } catch (e) {
      this.log(`[search] respawnActor failed: ${e}`);
    }
  }

  // The vanilla window already moved a refused item on the searcher's screen; the server's copy of their inventory puts it back
  private resyncInventory(ctx: SystemContext, actorId: number): void {
    if (this.resyncing.has(actorId)) {
      return;
    }
    this.resyncing.add(actorId);
    setTimeout(() => {
      this.resyncing.delete(actorId);
      const mp = ctx.svr as Mp;
      try {
        mp.set(actorId, "inventory", mp.get(actorId, "inventory"));
      } catch { /* form gone */ }
    }, RESYNC_DELAY_MS);
  }

  // ── Small helpers ───────────────────────────────────────────────────────────

  // Player characters carry a profile id; NPCs keep the default -1
  private isPlayerCharacter(ctx: SystemContext, actorId: number): boolean {
    try {
      return Number((ctx.svr as Mp).get(actorId, "profileId")) >= 0;
    } catch {
      return false;
    }
  }

  private hasOccupantNative(ctx: SystemContext): boolean {
    return typeof (ctx.svr as Mp).setInventoryOccupant === "function";
  }

  private setOccupant(ctx: SystemContext, targetActorId: number, occupantActorId: number): boolean {
    try {
      (ctx.svr as Mp).setInventoryOccupant(targetActorId, occupantActorId);
      return true;
    } catch (e) {
      this.log(`[search] setInventoryOccupant failed: ${e}`);
      return false;
    }
  }

  private validTarget(ctx: SystemContext, selfActorId: number, targetActorId: number): boolean {
    if (!targetActorId || targetActorId === selfActorId) {
      return false;
    }
    // Living targets must be connected players or server NPCs; any dead actor is a searchable body
    const mp = ctx.svr as Mp;
    if (this.userOf(ctx, targetActorId) < 0 && !this.isDead(ctx, targetActorId) && !(isAlive(mp, targetActorId) && !isPlayerActor(mp, targetActorId))) {
      return false;
    }
    if (this.isPermaDead(mp, targetActorId)) {
      return false;
    }
    return this.nearEnough(ctx, selfActorId, targetActorId, this.startMaxDistance + this.bodyReach(ctx, targetActorId));
  }

  private nearEnough(ctx: SystemContext, aActorId: number, bActorId: number, max: number): boolean {
    return this.distance(ctx, aActorId, bActorId) <= max;
  }

  // Between actor roots; Infinity across cells or worlds
  private distance(ctx: SystemContext, aActorId: number, bActorId: number): number {
    try {
      if (ctx.svr.getActorCellOrWorld(aActorId) !== ctx.svr.getActorCellOrWorld(bActorId)) {
        return Infinity;
      }
      const a = ctx.svr.getActorPos(aActorId);
      const b = ctx.svr.getActorPos(bActorId);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    } catch {
      return Infinity;
    }
  }

  // A big body's root sits far from the edge the searcher stands at, so dead NPCs reach further than players
  private bodyReach(ctx: SystemContext, targetActorId: number): number {
    if (!this.isDead(ctx, targetActorId) || this.isPlayerCharacter(ctx, targetActorId)) {
      return 0;
    }
    const mp = ctx.svr as Mp;
    const baseId = baseIdOf(mp, targetActorId);
    let reach = this.bodyReachCache.get(baseId);
    if (reach === undefined) {
      reach = DEFAULT_BODY_EXTRA_REACH;
      try {
        const obnd = fieldData(mp.lookupEspmRecordById(baseId), "OBND");
        if (obnd && obnd.byteLength >= 12) {
          const v = view(obnd);
          // Six int16 corners x1 y1 z1 x2 y2 z2; the largest horizontal one counts
          const half = Math.max(...[0, 2, 6, 8].map((off) => Math.abs(v.getInt16(off, true))));
          if (half > 0) reach = Math.min(half, MAX_BODY_EXTRA_REACH);
        }
      } catch { /* keep the default */ }
      this.bodyReachCache.set(baseId, reach);
    }
    return reach;
  }

  private isDead(ctx: SystemContext, actorId: number): boolean {
    try {
      return (ctx.svr as Mp).get(actorId, "isDead") === true;
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
      const u = ctx.svr.getUserByActor(actorId);
      if (typeof u !== "number" || u < 0 || u >= 0xffff || !ctx.svr.isConnected(u)) {
        return -1;
      }
      return u;
    } catch {
      return -1;
    }
  }

  // Plain {baseId, count} stacks without extra data, mirroring what TakeItem can move; with names, a key or writing keeps its name
  private simpleEntriesOf(ctx: SystemContext, actorId: number, names = false): { baseId: number, count: number, name?: string }[] {
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory");
      const entries: any[] = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries
        .filter((e) => e && typeof e.baseId === "number" && (e.count | 0) > 0)
        .map((e) => {
          const named = names && isNamedItemBase(e.baseId >>> 0) && typeof e.name === "string" && e.name !== "";
          return named ? { baseId: e.baseId >>> 0, count: e.count | 0, name: e.name } : { baseId: e.baseId >>> 0, count: e.count | 0 };
        });
    } catch {
      return [];
    }
  }

  private heldCount(ctx: SystemContext, actorId: number, baseId: number): number {
    return this.simpleEntriesOf(ctx, actorId).reduce((sum, e) => sum + (e.baseId === baseId ? e.count : 0), 0);
  }

  // On a body the client drops the stacks the server left out, so a hidden item is simply not in the window
  private visibleEntriesOf(ctx: SystemContext, searcherActorId: number, targetActorId: number, body: boolean): { baseId: number, count: number, name?: string }[] {
    const entries = this.simpleEntriesOf(ctx, targetActorId, this.namesListed(targetActorId));
    if (!body || !this.hidesItem) {
      return entries;
    }
    return entries.filter((e) => !this.hidden(ctx, searcherActorId, targetActorId, e.baseId));
  }

  private hidden(ctx: SystemContext, searcherActorId: number, targetActorId: number, baseId: number): boolean {
    if (!this.hidesItem) {
      return false;
    }
    try {
      return this.hidesItem(ctx, searcherActorId, targetActorId, baseId) === true;
    } catch (e) {
      this.log(`[search] item filter failed: ${e}`);
      return false;
    }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    if (userId < 0) {
      return;
    }
    try {
      ctx.svr.sendCustomPacket(userId, JSON.stringify({ customPacketType: "searchNotice", text }));
    } catch { /* user gone */ }
  }
}
