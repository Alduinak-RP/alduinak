import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, CHARACTER_LIST_EVENT, CHARACTER_RETIRED_EVENT, ACCESS_REFRESHED_EVENT, AFTERLIFE_EVENT, CharacterListEntry } from "./system";
import { AccessPayload, FactionBackend, RosterRow, factionBackendOf, filterAccessForSlot } from "../backendFactionApi";
import { AdminRoleConfig, readAdminRoleConfig, adminTierOf } from "./adminRoles";
import { addItemTo, isNear, isPlayerActor, nameShownTo, userOf } from "./actorUtil";
import { formIdFromConfig } from "./formIdUtil";
import { ITEM_TYPES } from "./itemCatalog";
import { HousingSystem } from "./housingSystem";
import { isFallen } from "./afterlifeSystem";
import * as rules from "./factionRules";
import { adminAudit } from "./discordAlerts";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Factions: hold courts, armies and guilds whose ranks live in the backend (skymp5-backend data/faction-whitelist.json, one row per
// character and slot). A character joins at most one faction of each type, leads at most one faction anywhere, and shows at most one
// faction title. This system runs the rules in game: the Personal Menu Faction tabs, recruiting with consent, rank changes, removals,
// regency, uniforms, faction-only doors and containers, and releasing a deleted or perma-dead character's ranks.
// Docs: docs/docs_roleplay_property_factions.md section 6.
//
// Client -> server:
//   factionMenuRequest {factionId?}                          -> factionMenu
//   factionRecruitRequest {target}                           the interaction menu's Recruit, prompts the target
//   factionRequest {action, factionId, ...}
//     recruit {target}                                       consent prompt, then the lowest rank the actor may recruit to
//     promote {profileId, slot, rank}                        any rank the actor may move that member to, up or down
//     remove | uniform {profileId, slot}                     slot null = the row shared by every character
//     regentAdd | regentRemove {profileId, slot}
//     regentOrder {order: [{profileId, slot}]}               regency order, first in line first
//     regency {enabled}                                      leader's regent-status switch
//     title {}                                               show this faction's title, or none when factionId is already shown
//     leave
//     adminAdd {target, rank} | adminRemove {target}         staff only
//   captureConsentResult {requestId, accepted}               ids from CONSENT_ID_BASE up are ours
// Server -> client:
//   factionMenu {available, staff, main, byType, factions, selected, detail, regency, titleFactionId}
//   factionState {factions: [{id, name, type}], canRecruit}  drives the interaction menu's Recruit entry
//   factionNotice {text}, captureConsentRequest {requestId, text}
// Titles: the actor property ff_factionTitle carries the prefix Show Title puts before a character's name; clients read it for the
// floating name tag, and it is registered in the gamemode next to the other ff_ properties.
// Live file ./faction-access.json (server folder, optional, re-read when it changes; seed in skymp5-server/seeds):
//   { "refs": [{ "ref": "0x0001A6F4" | "1A6F4:Skyrim.esm", "label"?, "factions": ["hold:haafingar"], "ranks"?: ["jarl"] | { "<factionId>": ["jarl"] } }] }
// Settings (optional): factionInviteMaxDistance (default 1024), factionUniformCooldownHours (default 24).

const ACCESS_FILE = "./faction-access.json";
// Disjoint from the capture counter (from 1) and the pet range (from 1e9)
const CONSENT_ID_BASE = 2_000_000_000;
const CONSENT_TIMEOUT_MS = 20000;
const INVITE_COOLDOWN_MS = 15000;
const DEFAULT_INVITE_DISTANCE = 1024;
const DEFAULT_UNIFORM_COOLDOWN_HOURS = 24;
// Definition edits from the dashboard or the Server Manager reach the game this often, a 304 when nothing changed
const DEFINITIONS_TTL_MS = 20000;
const DEFINITIONS_RETRY_MS = 15000;
const ROSTER_TTL_MS = 3000;
const ACCESS_FILE_CHECK_MS = 10000;
// How often a leader logging out hands the seat to the next regent in line
const REGENCY_CHECK_MS = 5000;
const RELEASE_RETRIES = 5;
const RELEASE_RETRY_MS = 30000;
const MAX_QUEUED = 3;
const MAX_USER_SLOTS = 1024;
const UNIFORM_PROP = "private.factionUniformAt";
const TITLE_PROP = "private.factionTitle";
const TITLE_FF = "ff_factionTitle";
const RELEASED_PROP = "private.factionsReleased";

// Acting through staff powers rather than a rank of their own
const staffOnly = (auth: rules.Authority): boolean => auth.staff && !auth.rank;

interface OnlineActor {
  userId: number;
  actorId: number;
  profileId: number;
  slot: number;
}

interface PendingInvite {
  inviterId: number;
  targetId: number;
  factionId: string;
  rankSlug: string;
  timer: ReturnType<typeof setTimeout>;
}

interface AccessEntry {
  label: string;
  factions: string[];
  ranks: string[] | Record<string, string[]> | null;
}

interface MemberView {
  key: string;
  profileId: number;
  slot: number | null;
  name: string;
  rankSlug: string;
  rankName: string;
  online: boolean;
  self: boolean;
  tenure: string;
  regent: boolean;
  acting: boolean;
  // Ranks this viewer may move them to, both directions
  promote: Array<{ slug: string; name: string }>;
  canRemove: boolean;
  canUniform: boolean;
  canRegent: boolean;
}

const noticeText = (err: unknown): string => {
  const msg = String((err as Error)?.message || err);
  if (msg.includes("slot is already filled")) return "That rank is full.";
  if (msg.includes("already has this rank")) return "They already hold that rank.";
  if (msg.includes("nobody leads two factions")) return "They already lead another faction.";
  if (msg.includes("cannot also lead")) return "They are a regent of another faction.";
  if (msg.includes("belongs to one")) return "They already belong to a faction of that type.";
  return "The faction records are unavailable, try again shortly.";
};

// "3 days", "2 months"; whole units, rounded down
const tenureText = (since: number): string => {
  if (!since) return "Unknown";
  const days = Math.floor((Date.now() - since) / 86400000);
  if (days < 1) return "Today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months`;
  return `${Math.floor(days / 365)} years`;
};

export class FactionSystem implements System {
  systemName = "FactionSystem";

  constructor(private log: Log, private housing: HousingSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.ctx = ctx;
    this.mp = ctx.svr as Mp;
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    const distance = Number(all?.["factionInviteMaxDistance"]);
    if (Number.isFinite(distance) && distance > 0) this.inviteDistance = distance;
    const hours = Number(all?.["factionUniformCooldownHours"]);
    if (Number.isFinite(hours) && hours >= 0) this.uniformCooldownMs = hours * 3600 * 1000;
    this.roleCfg = readAdminRoleConfig(all);

    this.housing.factionGate = (actorId, refrId) => this.gate(actorId, refrId);
    this.housing.factionDef = (factionId) => (this.definitionsLoaded ? this.defs.get(factionId) ?? null : undefined);

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => { void this.onAssign(userId, actorId >>> 0); });
    ctx.gm.on(CHARACTER_LIST_EVENT, (profileId: number, entries: CharacterListEntry[]) => this.onCharacterList(profileId, entries));
    ctx.gm.on(CHARACTER_RETIRED_EVENT, (profileId: number, slot: number, actorId: number) => this.release(profileId, slot, actorId, this.realName(actorId), "deletion", 0));
    ctx.gm.on(AFTERLIFE_EVENT, (profileId: number, slot: number, actorId: number) => {
      if (profileId > 0 && slot >= 0) this.release(profileId, slot, actorId, this.realName(actorId), "perma-death", 0);
    });

    this.loadAccessFile();
    this.log(`[factions] ready, ${this.accessByRef.size} faction-only door(s) and container(s)`);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "factionMenuRequest": void this.queued(userId, () => this.sendMenu(userId, String(content["factionId"] ?? ""))); break;
      case "factionRecruitRequest": void this.queued(userId, () => this.recruitFromCrosshair(userId, content)); break;
      case "factionRequest": void this.queued(userId, () => this.onRequest(userId, content)); break;
      case "captureConsentResult": this.onConsentResult(userId, content); break;
      default: break;
    }
  }

  async updateAsync(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAccessCheck >= ACCESS_FILE_CHECK_MS) {
      this.lastAccessCheck = now;
      this.loadAccessFile();
    }
    if (this.backend() && now >= this.definitionsDueAt && !this.definitionsLoading) {
      this.ensureDefinitions().catch(() => undefined);
    }
    if (now - this.lastRegencyCheck >= REGENCY_CHECK_MS) {
      this.lastRegencyCheck = now;
      this.refreshTitles();
    }
  }

  disconnect(userId: number): void {
    this.queues.delete(userId);
    this.queueDepth.delete(userId);
    this.acting.clear();
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  // A player's requests run one after another and each re-checks its rights, so a double click cannot act on stale data
  private queued(userId: number, job: () => Promise<void>): Promise<void> {
    const depth = this.queueDepth.get(userId) || 0;
    if (depth >= MAX_QUEUED) return Promise.resolve();
    this.queueDepth.set(userId, depth + 1);
    const run = async () => {
      try {
        await job();
      } catch (e) {
        this.log(`[factions] request failed: ${e}`);
        this.notice(userId, noticeText(e));
      } finally {
        const left = (this.queueDepth.get(userId) || 1) - 1;
        if (left > 0) this.queueDepth.set(userId, left);
        else this.queueDepth.delete(userId);
      }
    };
    const next = (this.queues.get(userId) || Promise.resolve()).then(run);
    this.queues.set(userId, next);
    return next;
  }

  private async onRequest(userId: number, content: Content): Promise<void> {
    const actorId = this.actorOf(userId);
    const backend = this.backend();
    if (!actorId || !backend) return this.notice(userId, "Factions are unavailable right now.");
    await this.ensureDefinitions();
    const action = String(content["action"] ?? "");
    const faction = this.defs.get(String(content["factionId"] ?? ""));
    if (!faction) return this.notice(userId, "That faction no longer exists.");
    const access = await this.refreshActorAccess(actorId);
    const auth = this.authorityOf(actorId, faction, access);

    switch (action) {
      case "recruit": await this.recruit(userId, actorId, faction, auth, Number(content["target"]) >>> 0); return;
      case "adminAdd":
      case "adminRemove": await this.adminMemberAction(userId, actorId, faction, action, content); break;
      case "leave": await this.leave(userId, actorId, faction, access); break;
      case "title": this.setTitle(userId, actorId, faction, access); break;
      case "regency":
      case "regentAdd":
      case "regentRemove":
      case "regentOrder": await this.regencyAction(userId, actorId, faction, auth, action, content); break;
      case "promote":
      case "remove":
      case "uniform": await this.memberAction(userId, actorId, faction, auth, action, content); break;
      default: return;
    }
    await this.sendMenu(userId, faction.id);
  }

  private async adminMemberAction(userId: number, actorId: number, faction: rules.FactionDef, action: string, content: Content): Promise<void> {
    if (!this.isStaff(actorId)) return this.notice(userId, "You cannot manage factions.");
    const target = this.onlineByActor(Number(content["target"]) >>> 0);
    if (!target) return this.notice(userId, "Select an online player.");
    const backend = this.backend()!;
    const name = this.realName(target.actorId);
    if (action === "adminAdd") {
      const rank = rules.rankOf(faction, String(content["rank"] ?? ""));
      if (!rank) return this.notice(userId, "Choose a faction role.");
      if (rank.capacity !== null && (await this.roster(faction.id, true)).filter((m) => m.rankSlug === rank.slug).length >= rank.capacity) {
        return this.notice(userId, `${rank.name} is full.`);
      }
      const payload = await backend.assign(target.profileId, rank.id, name, target.slot, this.who(actorId));
      this.applyAccess(target.profileId, payload);
      this.invalidateRoster(faction.id);
      this.notice(target.userId, `You are now ${rank.name} of ${faction.name}.`);
      this.notice(userId, `${name} is now ${rank.name} of ${faction.name}.`);
      this.staffLog(`${this.who(actorId)} added ${this.who(target.actorId)} to ${faction.name} as ${rank.name}`, true);
      return;
    }
    // An account-wide rank is stored with slot null, so each membership is removed with the slot it was granted on
    const rows = (await this.roster(faction.id, true)).filter((m) => m.profileId === target.profileId && (m.slot === null || m.slot === target.slot));
    if (!rows.length) return this.notice(userId, `${name} is not in ${faction.name}.`);
    let payload: AccessPayload | null = null;
    for (const row of rows) {
      const rank = rules.rankOf(faction, row.rankSlug);
      payload = await backend.remove(target.profileId, rank ? rank.id : `${faction.id}:${row.rankSlug}`, row.slot);
    }
    if (payload) this.applyAccess(target.profileId, payload);
    this.invalidateRoster(faction.id);
    this.notice(target.userId, `You were removed from ${faction.name}.`);
    this.notice(userId, `${name} was removed from ${faction.name}.`);
    this.staffLog(`${this.who(actorId)} removed ${this.who(target.actorId)} from ${faction.name}`, true);
  }

  // The interaction menu's Recruit: the actor's own faction of whichever type they may recruit for
  private async recruitFromCrosshair(userId: number, content: Content): Promise<void> {
    const actorId = this.actorOf(userId);
    if (!actorId) return;
    if (!this.backend()) return this.notice(userId, "Factions are unavailable right now.");
    const targetId = Number(content["target"]) >>> 0;
    const refusal = this.inviteTargetRefusal(actorId, targetId);
    if (refusal) return this.notice(userId, refusal);
    await this.ensureDefinitions();
    const access = await this.refreshActorAccess(actorId);
    const faction = this.recruitingFaction(actorId, access);
    if (!faction) return this.notice(userId, "You cannot recruit anyone.");
    await this.recruit(userId, actorId, faction, this.authorityOf(actorId, faction, access), targetId);
  }

  // The first faction the actor may recruit into; a character belongs to one faction of each type, so this is unambiguous in practice
  private recruitingFaction(actorId: number, access: unknown): rules.FactionDef | null {
    const mine = rules.membershipsOf(access).map((m) => this.defs.get(m.factionId)).filter((f): f is rules.FactionDef => !!f);
    const shown = this.isStaff(actorId) ? Array.from(this.defs.values()) : mine;
    return shown.find((f) => rules.recruitRankFor(f, this.authorityOf(actorId, f, access))) || null;
  }

  private async recruit(userId: number, actorId: number, faction: rules.FactionDef, auth: rules.Authority, targetId: number): Promise<void> {
    const rank = rules.recruitRankFor(faction, auth);
    if (!rank) return this.notice(userId, `You cannot recruit anyone into ${faction.name}.`);
    const refusal = this.inviteTargetRefusal(actorId, targetId);
    if (refusal) return this.notice(userId, refusal);
    for (const p of this.invites.values()) {
      if (p.targetId === targetId || p.inviterId === actorId) return this.notice(userId, "An invitation is already waiting for an answer.");
    }
    const cooldownKey = `${actorId}:${targetId}`;
    const now = Date.now();
    if (now - (this.inviteCooldown.get(cooldownKey) ?? 0) < INVITE_COOLDOWN_MS) return this.notice(userId, "Wait a moment before inviting them again.");

    const target = this.onlineByActor(targetId)!;
    const targetAccess = filterAccessForSlot(await this.backend()!.fetchAccess(target.profileId), target.slot);
    const held = rules.membershipsOf(targetAccess);
    if (held.some((m) => m.factionId === faction.id)) {
      return this.notice(userId, `They already belong to ${faction.name}.`);
    }
    const sameType = held.map((m) => this.defs.get(m.factionId)).find((f) => f && f.type === faction.type);
    if (sameType) return this.notice(userId, `They already belong to ${sameType.name}; nobody joins two ${faction.type} factions.`);
    if (rank.capacity !== null && (await this.roster(faction.id, true)).filter((m) => m.rankSlug === rank.slug).length >= rank.capacity) {
      return this.notice(userId, `${rank.name} is full.`);
    }

    this.inviteCooldown.set(cooldownKey, now);
    if (this.inviteCooldown.size > 512) {
      for (const [k, t] of Array.from(this.inviteCooldown)) if (now - t >= INVITE_COOLDOWN_MS) this.inviteCooldown.delete(k);
    }
    const requestId = this.nextConsentId++;
    const timer = setTimeout(() => {
      if (this.invites.delete(requestId)) this.notice(userOf(this.mp, actorId), `${nameShownTo(this.mp, actorId, targetId)} did not answer.`);
    }, CONSENT_TIMEOUT_MS);
    this.invites.set(requestId, { inviterId: actorId, targetId, factionId: faction.id, rankSlug: rank.slug, timer });
    this.send(target.userId, {
      customPacketType: "captureConsentRequest",
      requestId,
      text: `${nameShownTo(this.mp, targetId, actorId)} recruits you into ${faction.name} as ${rank.name}. Accept?`,
    });
    this.notice(userId, `Waiting for ${nameShownTo(this.mp, actorId, targetId)} to accept…`);
  }

  // A player standing close, connected, and not the recruiter
  private inviteTargetRefusal(actorId: number, targetId: number): string {
    if (!targetId || targetId === actorId || !isPlayerActor(this.mp, targetId) || !this.onlineByActor(targetId)) return "Look at the player you want to recruit.";
    if (!isNear(this.mp, actorId, targetId, this.inviteDistance)) return "They are too far away.";
    return "";
  }

  private onConsentResult(userId: number, content: Content): void {
    const requestId = Number(content["requestId"]);
    const invite = this.invites.get(requestId);
    if (!invite) return;
    // The answer must come from the player who was prompted
    if (this.actorOf(userId) !== invite.targetId) return;
    this.invites.delete(requestId);
    clearTimeout(invite.timer);
    const inviterUser = userOf(this.mp, invite.inviterId);
    if (content["accepted"] !== true) {
      this.notice(inviterUser, `${nameShownTo(this.mp, invite.inviterId, invite.targetId)} declined.`);
      return;
    }
    void this.queued(userId, () => this.acceptInvite(userId, invite));
  }

  private async acceptInvite(userId: number, invite: PendingInvite): Promise<void> {
    const inviterUser = userOf(this.mp, invite.inviterId);
    const backend = this.backend();
    const faction = this.defs.get(invite.factionId);
    const rank = faction && rules.rankOf(faction, invite.rankSlug);
    const target = this.onlineByActor(invite.targetId);
    if (!backend || !faction || !rank || !target) return this.notice(userId, "The invitation can no longer be accepted.");
    // The recruiter may have lost the rank while the prompt was open
    const inviter = this.onlineByActor(invite.inviterId);
    const inviterAuth = inviter ? this.authorityOf(invite.inviterId, faction, await this.refreshActorAccess(invite.inviterId)) : null;
    if (!inviterAuth || rules.recruitRankFor(faction, inviterAuth)?.slug !== rank.slug) return this.notice(userId, "The invitation is no longer valid.");

    const payload = await backend.assign(target.profileId, rank.id, this.realName(target.actorId), target.slot, this.who(invite.inviterId));
    this.applyAccess(target.profileId, payload);
    this.invalidateRoster(faction.id);
    this.notice(userId, `You joined ${faction.name} as ${rank.name}.`);
    this.notice(inviterUser, `${this.realName(target.actorId)} joined ${faction.name} as ${rank.name}.`);
    const asStaff = staffOnly(inviterAuth);
    this.staffLog(`${this.who(invite.inviterId)} recruited ${this.who(target.actorId)} into ${faction.name} as ${rank.name}${asStaff ? " (staff)" : ""}`, asStaff);
    if (inviterUser >= 0) await this.sendMenu(inviterUser, faction.id);
  }

  private async memberAction(userId: number, actorId: number, faction: rules.FactionDef, auth: rules.Authority, action: string, content: Content): Promise<void> {
    const backend = this.backend()!;
    const profileId = Number(content["profileId"]);
    const slot = Number.isInteger(content["slot"]) ? (content["slot"] as number) : null;
    const member = (await this.roster(faction.id, true)).find((m) => m.profileId === profileId && m.slot === slot);
    const memberRank = member && rules.rankOf(faction, member.rankSlug);
    if (!member || !memberRank) return this.notice(userId, "They are no longer in the faction.");
    const self = this.onlineByActor(actorId);
    if (self && self.profileId === profileId && (slot === null || slot === self.slot) && action !== "uniform") return this.notice(userId, "Use Leave to step down.");
    const everyone = this.online();
    const name = this.memberName(member, everyone);
    const online = this.onlineMember(member, everyone);

    if (action === "uniform") return this.issueUniform(userId, actorId, faction, auth, name, memberRank, online);

    if (action === "remove") {
      if (!rules.canRemove(faction, auth, memberRank)) return this.notice(userId, "You cannot remove them.");
      const payload = await backend.remove(profileId, memberRank.id, slot);
      this.applyAccess(profileId, payload);
      this.invalidateRoster(faction.id);
      if (online) this.notice(online.userId, `You were removed from ${faction.name}.`);
      this.notice(userId, `${name} was removed from ${faction.name}.`);
      this.staffLog(`${this.who(actorId)} removed ${name} (profile ${profileId}${slot === null ? "" : `, character ${slot + 1}`}) from ${faction.name}, was ${memberRank.name}`, staffOnly(auth));
      return;
    }

    const target = rules.rankOf(faction, String(content["rank"] ?? ""));
    if (!target || !rules.canSetRank(faction, auth, memberRank, target)) {
      return this.notice(userId, "You cannot give them that rank.");
    }
    if (target.capacity !== null && (await this.roster(faction.id, true)).filter((m) => m.rankSlug === target.slug).length >= target.capacity) {
      return this.notice(userId, `${target.name} is full.`);
    }
    const payload = await backend.assign(profileId, target.id, name, slot, this.who(actorId));
    this.applyAccess(profileId, payload);
    this.invalidateRoster(faction.id);
    if (online) this.notice(online.userId, `You are now ${target.name} of ${faction.name}.`);
    this.notice(userId, `${name} is now ${target.name}.`);
    this.staffLog(`${this.who(actorId)} made ${name} (profile ${profileId}${slot === null ? "" : `, character ${slot + 1}`}) ${target.name} of ${faction.name}, was ${memberRank.name}`, staffOnly(auth));
  }

  private issueUniform(userId: number, actorId: number, faction: rules.FactionDef, auth: rules.Authority, name: string, memberRank: rules.RankDef, online: OnlineActor | null): void {
    if (!rules.canIssueUniform(faction, auth)) return this.notice(userId, "You cannot issue uniforms.");
    if (!online) return this.notice(userId, "They must be in the world to receive a uniform.");
    const items = rules.uniformFor(faction, memberRank);
    if (!items.length) return this.notice(userId, `No uniform is set for ${memberRank.name} of ${faction.name}.`);
    let issued: Record<string, number> = {};
    try {
      const raw = this.mp.get(online.actorId, UNIFORM_PROP);
      if (raw && typeof raw === "object") issued = { ...raw };
    } catch { /* actor gone */ }
    const last = Number(issued[faction.id]) || 0;
    const waitMs = last + this.uniformCooldownMs - Date.now();
    if (waitMs > 0) return this.notice(userId, `${name} was issued a uniform recently, try again in ${Math.ceil(waitMs / 3600000)} hour(s).`);

    const given: string[] = [];
    for (const u of items) {
      const itemId = formIdFromConfig(this.mp, u.item);
      let type = "";
      try { type = String(this.mp.lookupEspmRecordById(itemId)?.record?.type ?? ""); } catch { /* unknown form */ }
      if (!itemId || !ITEM_TYPES.includes(type)) {
        this.log(`[factions] uniform item ${u.item} of ${faction.id} is not an item, skipped`);
        continue;
      }
      addItemTo(this.mp, online.actorId, itemId, u.count);
      given.push(`${u.count}x ${u.item}`);
    }
    if (!given.length) return this.notice(userId, "The uniform list holds no valid items; ask staff to fix it.");
    issued[faction.id] = Date.now();
    try { this.mp.set(online.actorId, UNIFORM_PROP, issued); } catch { /* actor gone */ }
    this.notice(online.userId, `You received the ${faction.name} uniform.`);
    if (online.userId !== userId) this.notice(userId, `Uniform issued to ${name}.`);
    this.staffLog(`${this.who(actorId)} issued the ${faction.name} uniform to ${this.who(online.actorId)}: ${given.join(", ")}`, staffOnly(auth));
  }

  private async leave(userId: number, actorId: number, faction: rules.FactionDef, access: unknown): Promise<void> {
    const self = this.onlineByActor(actorId);
    const rows = rules.membershipsOf(access).filter((m) => m.factionId === faction.id);
    if (!self || !rows.length) return this.notice(userId, `You are not in ${faction.name}.`);
    let payload: AccessPayload | null = null;
    for (const row of rows) payload = await this.backend()!.remove(self.profileId, `${faction.id}:${row.rankSlug}`, row.slot);
    if (payload) this.applyAccess(self.profileId, payload);
    this.invalidateRoster(faction.id);
    if (this.titleFactionOf(actorId) === faction.id) this.storeTitleChoice(actorId, "");
    this.notice(userId, `You left ${faction.name}.`);
    this.staffLog(`${this.who(actorId)} left ${faction.name}, was ${rows.map((r) => rules.rankOf(faction, r.rankSlug)?.name || r.rankSlug).join(", ")}`);
  }

  // Show Title is a single choice: picking the faction already shown turns it off again
  private setTitle(userId: number, actorId: number, faction: rules.FactionDef, access: unknown): void {
    if (!rules.membershipsOf(access).some((m) => m.factionId === faction.id)) return this.notice(userId, `You are not in ${faction.name}.`);
    const next = this.titleFactionOf(actorId) === faction.id ? "" : faction.id;
    this.storeTitleChoice(actorId, next);
    this.notice(userId, next ? `Your ${faction.name} title is shown with your name.` : "Your title is hidden.");
  }

  // ── Regency ─────────────────────────────────────────────────────────────────

  private async regencyAction(userId: number, actorId: number, faction: rules.FactionDef, auth: rules.Authority, action: string, content: Content): Promise<void> {
    if (!rules.canManageRegency(auth)) return this.notice(userId, "Only the leader seats regents.");
    const backend = this.backend()!;
    const seats = faction.regents.slice();
    const sameSeat = (a: rules.RegentSeat, b: rules.RegentSeat) => a.profileId === b.profileId && a.slot === b.slot;
    let enabled: boolean | undefined;
    let next: rules.RegentSeat[] | undefined;

    if (action === "regency") {
      enabled = content["enabled"] === true;
    } else if (action === "regentOrder") {
      const wanted = this.seatList(content["order"]);
      // A reorder may only shuffle the seats that are already there
      if (wanted.length !== seats.length || !wanted.every((s) => seats.some((o) => sameSeat(o, s)))) return this.notice(userId, "The regency list changed, reopen the tab.");
      next = wanted;
    } else {
      const seat: rules.RegentSeat = { profileId: Number(content["profileId"]), slot: Number.isInteger(content["slot"]) ? (content["slot"] as number) : null };
      if (!seat.profileId) return this.notice(userId, "Pick a member.");
      if (action === "regentAdd") {
        if (seats.some((o) => sameSeat(o, seat))) return this.notice(userId, "They already hold a regency seat.");
        const member = (await this.roster(faction.id, true)).find((m) => m.profileId === seat.profileId && m.slot === seat.slot);
        if (!member) return this.notice(userId, "They are no longer in the faction.");
        next = seats.concat([seat]);
      } else {
        next = seats.filter((o) => !sameSeat(o, seat));
        if (next.length === seats.length) return this.notice(userId, "They do not hold a regency seat.");
      }
    }

    await backend.setRegency(faction.id, { enabled, regents: next }, this.who(actorId));
    if (enabled !== undefined) faction.regencyEnabled = enabled;
    if (next) faction.regents = next;
    this.acting.clear();
    this.refreshTitles();
    this.notice(userId, enabled !== undefined
      ? `Regency is ${enabled ? "on" : "off"} for ${faction.name}.`
      : `The regency of ${faction.name} was updated.`);
    this.staffLog(`${this.who(actorId)} changed the regency of ${faction.name}: ${action}${enabled === undefined ? "" : ` ${enabled}`}, ${(next || seats).length} seat(s)`, staffOnly(auth));
  }

  private seatList(raw: unknown): rules.RegentSeat[] {
    return (Array.isArray(raw) ? raw : [])
      .map((r) => r as Record<string, unknown>)
      .filter((r) => Number.isInteger(r?.profileId) && (r.profileId as number) > 0)
      .map((r) => ({ profileId: r.profileId as number, slot: Number.isInteger(r.slot) ? (r.slot as number) : null }));
  }

  // The regent standing in for an absent leader: the first seat in line whose character is online, while no leader is
  private actingRegent(faction: rules.FactionDef): OnlineActor | null {
    if (!faction.regencyEnabled || !faction.regents.length) return null;
    const cached = this.acting.get(faction.id);
    if (cached !== undefined) return cached;
    const everyone = this.online();
    const rankOfActor = (o: OnlineActor) => {
      const m = this.membershipsOfActor(o.actorId).find((x) => x.factionId === faction.id);
      return m ? rules.rankOf(faction, m.rankSlug) : null;
    };
    let found: OnlineActor | null = null;
    if (!everyone.some((o) => rankOfActor(o)?.leader)) {
      for (const seat of faction.regents) {
        const online = everyone.find((o) => o.profileId === seat.profileId && (seat.slot === null || seat.slot === o.slot));
        if (online && rankOfActor(online)) {
          found = online;
          break;
        }
      }
    }
    this.acting.set(faction.id, found);
    return found;
  }

  // ── Titles ──────────────────────────────────────────────────────────────────

  private titleFactionOf(actorId: number): string {
    try { return String(this.mp.get(actorId, TITLE_PROP) ?? ""); } catch { return ""; }
  }

  private storeTitleChoice(actorId: number, factionId: string): void {
    try { this.mp.set(actorId, TITLE_PROP, factionId); } catch { return; }
    this.applyTitle(actorId);
  }

  // ff_factionTitle is what clients prefix to the floating name; empty means no title is shown
  private applyTitle(actorId: number): void {
    const factionId = this.titleFactionOf(actorId);
    const faction = factionId ? this.defs.get(factionId) : null;
    let title = "";
    if (faction) {
      const membership = this.membershipsOfActor(actorId).find((m) => m.factionId === faction.id);
      const rank = membership && rules.rankOf(faction, membership.rankSlug);
      if (rank) title = rules.titleOf(faction, rank, this.actingRegent(faction)?.actorId === actorId, this.isFemale(actorId));
    }
    if (this.titles.get(actorId) === title) return;
    this.titles.set(actorId, title);
    try { this.mp.set(actorId, TITLE_FF, title); } catch { this.titles.delete(actorId); }
  }

  // A leader logging in or out moves the regency, which changes what every member of that faction is called
  private refreshTitles(): void {
    this.acting.clear();
    const live = new Set<number>();
    for (const o of this.online()) {
      live.add(o.actorId);
      this.applyTitle(o.actorId);
    }
    for (const actorId of Array.from(this.titles.keys())) if (!live.has(actorId)) this.titles.delete(actorId);
  }

  private isFemale(actorId: number): boolean {
    try { return this.mp.get(actorId, "appearance")?.isFemale === true; } catch { return false; }
  }

  // The title shown next to a character's name in server-built lists, "" when none
  titleOfActor(actorId: number): string {
    return this.titles.get(actorId) || "";
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  // A backend failure shows the tab as unavailable without a notice, the menu opens on every interact key press
  private async sendMenu(userId: number, wanted: string): Promise<void> {
    const actorId = this.actorOf(userId);
    if (!actorId) return;
    const unavailable = { customPacketType: "factionMenu", available: false, staff: false, main: [] as unknown[], byType: {}, factions: [] as unknown[], selected: "", detail: null as unknown, regency: null as unknown, titleFactionId: "" };
    if (!this.backend()) return this.send(userId, unavailable);
    try {
      await this.ensureDefinitions();
      const access = await this.refreshActorAccess(actorId);
      const mine = rules.membershipsOf(access).filter((m) => this.defs.has(m.factionId));
      const staff = this.isStaff(actorId);
      const shown = staff ? Array.from(this.defs.values()) : mine.map((m) => this.defs.get(m.factionId)!).filter((f, i, all) => all.indexOf(f) === i);
      const selected = shown.find((f) => f.id === wanted) || shown.find((f) => f.id === mine[0]?.factionId) || shown[0] || null;
      const byType: Record<string, string> = {};
      for (const m of mine) byType[this.defs.get(m.factionId)!.type] = m.factionId;
      const rankName = (f: rules.FactionDef) => {
        const m = mine.find((x) => x.factionId === f.id);
        return m ? rules.rankOf(f, m.rankSlug)?.name || m.rankSlug : "";
      };
      const main = [];
      for (const m of mine) main.push(await this.column(actorId, this.defs.get(m.factionId)!, m));
      this.send(userId, {
        customPacketType: "factionMenu",
        available: true,
        staff,
        titleFactionId: this.titleFactionOf(actorId),
        main,
        byType,
        factions: shown.map((f) => ({ id: f.id, name: f.name, type: f.type, zone: f.zone, color: f.color, rank: rankName(f) })),
        selected: selected ? selected.id : "",
        detail: selected ? await this.detail(actorId, selected, access, staff) : null,
        regency: await this.regencyView(access),
      });
      this.menuError = "";
    } catch (e) {
      if (String(e) !== this.menuError) this.log(`[factions] faction menu unavailable: ${e}`);
      this.menuError = String(e);
      this.send(userId, unavailable);
    }
  }

  // One Main tab column: the standing of this character in one faction
  private async column(actorId: number, faction: rules.FactionDef, membership: rules.Membership): Promise<Record<string, unknown>> {
    const roster = await this.roster(faction.id, false);
    const everyone = this.online();
    const acting = this.actingRegent(faction);
    const leaders = roster.filter((row) => rules.rankOf(faction, row.rankSlug)?.leader);
    const rank = rules.rankOf(faction, membership.rankSlug);
    return {
      id: faction.id,
      name: faction.name,
      type: faction.type,
      zone: faction.zone,
      color: faction.color,
      rankName: rank ? rank.name : membership.rankSlug,
      title: rank ? rules.titleOf(faction, rank, acting?.actorId === actorId, this.isFemale(actorId)) : "",
      leaderName: leaders.length
        ? leaders.map((row) => this.memberName(row, everyone)).join(", ")
        : acting
          ? `${this.realName(acting.actorId)} (${rules.titleOf(faction, faction.ranks[0], true, false)})`
          : "Vacant",
      members: roster.length,
      tenure: tenureText(membership.since),
      titleShown: this.titleFactionOf(actorId) === faction.id,
    };
  }

  private async detail(actorId: number, faction: rules.FactionDef, access: unknown, staff: boolean): Promise<Record<string, unknown>> {
    const auth = this.authorityOf(actorId, faction, access);
    const self = this.onlineByActor(actorId);
    const roster = await this.roster(faction.id, false);
    const everyone = this.online();
    const acting = this.actingRegent(faction);
    const seated = (row: RosterRow) => faction.regents.some((seat) => seat.profileId === row.profileId && seat.slot === row.slot);
    const members: MemberView[] = roster
      .map((row) => {
        const rank = rules.rankOf(faction, row.rankSlug);
        const isSelf = !!self && row.profileId === self.profileId && (row.slot === null || row.slot === self.slot);
        const online = this.onlineMember(row, everyone);
        return {
          key: `${row.profileId}:${row.slot === null ? "all" : row.slot}`,
          profileId: row.profileId ?? 0,
          slot: row.slot,
          name: this.memberName(row, everyone),
          rankSlug: row.rankSlug,
          rankName: rank ? rank.name : row.rank || row.rankSlug,
          online: !!online,
          self: isSelf,
          tenure: tenureText(Date.parse(String(row.since || "")) || 0),
          regent: seated(row),
          acting: !!acting && !!online && acting.actorId === online.actorId,
          promote: rank && !isSelf ? rules.promoteTargets(faction, auth, rank).map((r) => ({ slug: r.slug, name: r.name })) : [],
          canRemove: !!rank && !isSelf && rules.canRemove(faction, auth, rank),
          canUniform: !!rank && rules.canIssueUniform(faction, auth) && rules.uniformFor(faction, rank).length > 0,
          canRegent: !!rank && !isSelf && !rank.leader && !seated(row) && rules.canManageRegency(auth),
        };
      })
      .filter((m) => m.profileId > 0)
      .sort((a, b) => (rules.rankOf(faction, a.rankSlug)?.order ?? 99) - (rules.rankOf(faction, b.rankSlug)?.order ?? 99) || a.name.localeCompare(b.name));
    const recruitRank = rules.recruitRankFor(faction, auth);
    // Players close enough to recruit who are not in the faction yet
    const nearby = !recruitRank ? [] : everyone
      .filter((o) => o.actorId !== actorId && isNear(this.mp, actorId, o.actorId, this.inviteDistance))
      .filter((o) => !roster.some((row) => row.profileId === o.profileId && (row.slot === null || row.slot === o.slot)))
      .map((o) => ({ target: o.actorId, name: nameShownTo(this.mp, actorId, o.actorId) }));
    return {
      id: faction.id,
      name: faction.name,
      type: faction.type,
      zone: faction.zone,
      color: faction.color,
      myRank: auth.rank ? auth.rank.name : "",
      acting: auth.acting,
      staff,
      ranks: faction.ranks.map((r) => ({ slug: r.slug, name: r.name, capacity: r.capacity, count: roster.filter((m) => m.rankSlug === r.slug).length })),
      members,
      canLeave: !!auth.rank,
      recruitRank: recruitRank ? { slug: recruitRank.slug, name: recruitRank.name } : null,
      nearby,
    };
  }

  // The Regency tab, shown only to the leader of a faction; nobody leads two, so there is at most one
  private async regencyView(access: unknown): Promise<Record<string, unknown> | null> {
    let led: rules.FactionDef | null = null;
    for (const m of rules.membershipsOf(access)) {
      const faction = this.defs.get(m.factionId);
      if (faction && rules.rankOf(faction, m.rankSlug)?.leader) {
        led = faction;
        break;
      }
    }
    if (!led) return null;
    const roster = await this.roster(led.id, false);
    const everyone = this.online();
    const acting = this.actingRegent(led);
    const seats = led.regents
      .map((seat) => {
        const row = roster.find((m) => m.profileId === seat.profileId && m.slot === seat.slot);
        if (!row) return null;
        const online = this.onlineMember(row, everyone);
        return {
          key: `${seat.profileId}:${seat.slot === null ? "all" : seat.slot}`,
          profileId: seat.profileId,
          slot: seat.slot,
          name: this.memberName(row, everyone),
          rankName: rules.rankOf(led, row.rankSlug)?.name || row.rankSlug,
          online: !!online,
          acting: !!acting && !!online && acting.actorId === online.actorId,
        };
      })
      .filter(Boolean);
    return {
      factionId: led.id,
      name: led.name,
      type: led.type,
      enabled: led.regencyEnabled,
      regentTitle: rules.titleOf(led, led.ranks[0], true, false),
      seats,
    };
  }

  private sendState(userId: number, actorId: number): void {
    if (userId < 0) return;
    let access: unknown = null;
    try { access = this.mp.get(actorId, "private.skympAccess"); } catch { return; }
    const mine = rules.membershipsOf(access).filter((m, i, all) => all.findIndex((x) => x.factionId === m.factionId) === i);
    const staff = this.isStaff(actorId);
    const canRecruit = Array.from(this.defs.values()).some((f) => (staff || mine.some((m) => m.factionId === f.id)) && !!rules.recruitRankFor(f, this.authorityOf(actorId, f, access)));
    this.send(userId, {
      customPacketType: "factionState",
      factions: mine.map((m) => ({ id: m.factionId, name: this.defs.get(m.factionId)?.name || m.factionId, type: this.defs.get(m.factionId)?.type || "" })),
      canRecruit,
    });
  }

  // ── Doors and containers ────────────────────────────────────────────────────

  // Either half of a teleport pair names the faction; players outside it are refused, NPCs pass
  private gate(actorId: number, refrId: number): { name: string; allowed: boolean } | null {
    if (!this.accessByRef.size) return null;
    const entry = this.housing.doorSides(this.ctx, refrId).map((id) => this.accessByRef.get(id)).find(Boolean);
    if (!entry) return null;
    const name = entry.label || entry.factions.map((id) => this.defs.get(id)?.name || id).join(" or ");
    if (!isPlayerActor(this.mp, actorId)) return { name, allowed: true };
    // A rank list on the entry names who may pass; without one every rank with the faction access flag may
    const allowed = this.membershipsOfActor(actorId).some((m) => {
      if (!entry.factions.includes(m.factionId)) return false;
      const ranks = Array.isArray(entry.ranks) ? entry.ranks : entry.ranks ? entry.ranks[m.factionId] : null;
      if (ranks) return ranks.includes(m.rankSlug);
      if (!this.definitionsLoaded) return true;
      const faction = this.defs.get(m.factionId);
      return !!faction && !!rules.rankOf(faction, m.rankSlug)?.factionAccess;
    });
    return { name, allowed };
  }

  private loadAccessFile(): void {
    let mtime = 0;
    try { mtime = fs.statSync(ACCESS_FILE).mtimeMs; } catch { /* absent */ }
    if (mtime === this.accessMtime) return;
    this.accessMtime = mtime;
    if (!mtime) {
      if (this.accessByRef.size) this.log(`[factions] ${ACCESS_FILE} removed, no faction-only doors or containers`);
      this.accessByRef.clear();
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    } catch (e) {
      this.log(`[factions] ${ACCESS_FILE} is unreadable, keeping the previous doors and containers: ${e}`);
      return;
    }
    const next = new Map<number, AccessEntry>();
    const refs: unknown[] = Array.isArray(parsed?.refs) ? parsed.refs : [];
    for (const raw of refs) {
      const r = raw as Record<string, unknown>;
      const refId = formIdFromConfig(this.mp, r?.ref);
      const factions = Array.isArray(r?.factions) ? (r.factions as unknown[]).map(String).filter((id) => id.includes(":")) : [];
      const ranks = Array.isArray(r?.ranks) ? (r.ranks as unknown[]).map(String)
        : r?.ranks && typeof r.ranks === "object" ? Object.fromEntries(Object.entries(r.ranks as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]))
          : null;
      if (!refId || !factions.length) {
        this.log(`[factions] ${ACCESS_FILE} entry ${JSON.stringify(raw)} skipped, needs a ref and at least one faction id`);
        continue;
      }
      next.set(refId, { label: typeof r.label === "string" ? r.label.slice(0, 48) : "", factions, ranks });
    }
    this.accessByRef = next;
    this.log(`[factions] ${ACCESS_FILE} loaded, ${next.size} faction-only door(s) and container(s)`);
  }

  // ── Characters ──────────────────────────────────────────────────────────────

  private async onAssign(userId: number, actorId: number): Promise<void> {
    if (this.backend()) {
      try {
        await this.ensureDefinitions();
        await this.refreshActorAccess(actorId);
      } catch (e) {
        this.log(`[factions] could not refresh ranks at spawn: ${e}`);
      }
    }
    this.acting.clear();
    this.refreshTitles();
    this.sendState(userId, actorId);
  }

  private onCharacterList(profileId: number, entries: CharacterListEntry[]): void {
    const backend = this.backend();
    if (!backend) return;
    const characters = entries.map((e) => ({ slot: e.slot, name: this.realName(e.actorId), dead: e.dead }));
    const key = JSON.stringify(characters);
    if (this.reported.get(profileId) !== key) {
      backend.reportCharacters(profileId, characters)
        .then(() => this.reported.set(profileId, key))
        .catch((e) => this.log(`[factions] character names for profile ${profileId} not stored: ${e}`));
    }
    for (const e of entries) {
      let released = false;
      try { released = this.mp.get(e.actorId, RELEASED_PROP) === true; } catch { continue; }
      if (e.dead && !released) this.release(profileId, e.slot, e.actorId, this.realName(e.actorId), "perma-death", 0);
    }
  }

  // Ranks of a deleted or perma-dead character; the rows shared by every character go too once no living character is left
  private release(profileId: number, slot: number, actorId: number, name: string, reason: string, attempt: number): void {
    const backend = this.backend();
    if (!backend) return;
    const key = `${profileId}:${slot}`;
    if (attempt === 0 && this.releasing.has(key)) return;
    this.releasing.add(key);
    let othersAlive = false;
    try {
      othersAlive = (this.mp.getActorsByProfileId(profileId) as number[]).some((a) => a >>> 0 !== actorId && !isFallen(this.mp, a));
    } catch { /* keep the shared rows */ othersAlive = true; }
    backend.releaseCharacter(profileId, slot, !othersAlive)
      .then(({ removed, payload }) => {
        this.releasing.delete(key);
        if (reason === "perma-death") {
          try { this.mp.set(actorId, RELEASED_PROP, true); } catch { /* body gone */ }
        }
        if (!removed.length) return;
        this.applyAccess(profileId, payload);
        this.rosters.clear();
        this.staffLog(`faction ranks of ${name} (profile ${profileId}, character ${slot + 1}) removed after ${reason}: ${removed.map((r) => `${r.group || "?"} ${r.rank || r.requirementId}`).join(", ")}`);
      })
      .catch((e) => {
        if (attempt + 1 < RELEASE_RETRIES) {
          setTimeout(() => this.release(profileId, slot, actorId, name, reason, attempt + 1), RELEASE_RETRY_MS * (attempt + 1));
          return;
        }
        this.releasing.delete(key);
        this.staffLog(`faction ranks of ${name} (profile ${profileId}, character ${slot + 1}) could not be removed after ${reason}, remove them from the dashboard: ${e}`);
      });
  }

  // ── Backend state ───────────────────────────────────────────────────────────

  private backend(): FactionBackend | null {
    return factionBackendOf(this.mp);
  }

  private ensureDefinitions(): Promise<void> {
    if (this.definitionsLoading) return this.definitionsLoading;
    if (this.defs.size && Date.now() < this.definitionsDueAt) return Promise.resolve();
    const backend = this.backend();
    if (!backend) return Promise.resolve();
    this.definitionsLoading = backend.fetchDefinitions()
      .then((raw) => {
        this.definitionsDueAt = Date.now() + DEFINITIONS_TTL_MS;
        this.definitionsError = "";
        if (!raw) return;
        const had = this.defs.size;
        const signature = JSON.stringify(raw);
        const changed = signature !== this.definitionsSignature;
        this.definitionsSignature = signature;
        const reload = this.definitionsLoaded && changed;
        this.defs = rules.buildFactions(raw);
        this.definitionsLoaded = true;
        this.acting.clear();
        if (had !== this.defs.size) this.log(`[factions] ${this.defs.size} faction(s) loaded from the backend`);
        if (reload) this.refreshOnlineAccess();
      })
      .catch((e) => {
        this.definitionsDueAt = Date.now() + DEFINITIONS_RETRY_MS;
        // Logged once per distinct failure, the retry runs every few seconds
        if (String(e) !== this.definitionsError) this.log(`[factions] faction definitions unavailable: ${e}`);
        this.definitionsError = String(e);
        if (!this.defs.size) throw e;
      })
      .finally(() => { this.definitionsLoading = null; });
    return this.definitionsLoading;
  }

  // A definition edit can delete ranks and their members, so every online character reloads its ranks without a relog
  private refreshOnlineAccess(): void {
    this.rosters.clear();
    const backend = this.backend();
    if (!backend) return;
    const profileIds = Array.from(new Set(this.online().map((o) => o.profileId)));
    this.log(`[factions] faction definitions changed, reloading the ranks of ${profileIds.length} online account(s)`);
    void (async () => {
      for (const profileId of profileIds) {
        try {
          this.applyAccess(profileId, await backend.fetchAccess(profileId));
        } catch (e) {
          this.log(`[factions] ranks not reloaded after the definition change, they refresh at the next menu or login: ${e}`);
          return;
        }
      }
    })();
  }

  private async roster(factionId: string, fresh: boolean): Promise<RosterRow[]> {
    const cached = this.rosters.get(factionId);
    if (!fresh && cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.rows;
    const rows = (await this.backend()!.fetchRoster(factionId)).map((r) => ({ ...r, slot: Number.isInteger(r.slot) ? r.slot : null }));
    this.rosters.set(factionId, { at: Date.now(), rows });
    return rows;
  }

  private invalidateRoster(factionId: string): void {
    this.rosters.delete(factionId);
  }

  // The backend is the authority; the copy on the character only serves lookups between requests
  private async refreshActorAccess(actorId: number): Promise<unknown> {
    const self = this.onlineByActor(actorId);
    if (!self) return this.cachedAccess(actorId);
    this.applyAccess(self.profileId, await this.backend()!.fetchAccess(self.profileId));
    return this.cachedAccess(actorId);
  }

  // Every online character of the profile gets its narrowed copy; Spawn keeps the full payload for the next character select
  private applyAccess(profileId: number, payload: AccessPayload): void {
    for (const o of this.online()) {
      if (o.profileId !== profileId) continue;
      try { this.mp.set(o.actorId, "private.skympAccess", filterAccessForSlot(payload, o.slot)); } catch { continue; }
      this.sendState(o.userId, o.actorId);
    }
    this.acting.clear();
    this.refreshTitles();
    this.ctx.gm.emit(ACCESS_REFRESHED_EVENT, profileId, payload);
  }

  private cachedAccess(actorId: number): unknown {
    try { return this.mp.get(actorId, "private.skympAccess"); } catch { return null; }
  }

  private membershipsOfActor(actorId: number): rules.Membership[] {
    return rules.membershipsOf(this.cachedAccess(actorId));
  }

  private authorityOf(actorId: number, faction: rules.FactionDef, access: unknown): rules.Authority {
    const own = rules.membershipsOf(access)
      .filter((m) => m.factionId === faction.id)
      .map((m) => rules.rankOf(faction, m.rankSlug))
      .filter((r): r is rules.RankDef => !!r)
      .sort((a, b) => a.order - b.order)[0] || null;
    return { staff: this.isStaff(actorId), rank: own, acting: !!own && this.actingRegent(faction)?.actorId === actorId };
  }

  private isStaff(actorId: number): boolean {
    const tier = adminTierOf(this.mp, actorId, this.roleCfg);
    return !!tier && this.roleCfg.tierCaps[tier].factions === true;
  }

  // Whether the character carries one faction permission anywhere; other systems gate on it
  hasFactionPermission(actorId: number, key: rules.Permission): boolean {
    return this.factionsWith(actorId, key).length > 0;
  }

  // Staff count as holding the execute permission
  canExecute(actorId: number): boolean {
    return this.isStaff(actorId) || this.hasFactionPermission(actorId, "execute");
  }

  // The factions whose rank gives this character the permission; FactionCraftSystem gates the craft markers on it
  factionsWith(actorId: number, key: rules.Permission): string[] {
    const access = this.cachedAccess(actorId);
    // Definitions not in yet: no permission is granted rather than all of them
    return rules.membershipsOf(access)
      .filter((m) => {
        const faction = this.defs.get(m.factionId);
        return !!faction && rules.hasPermission(this.authorityOf(actorId, faction, access), key);
      })
      .map((m) => m.factionId);
  }

  canRemoveBoardPosts(actorId: number, boardName: string): boolean {
    const holdByBoard: Record<string, string> = {
      Dawnstar: "the-pale", Falkreath: "falkreath", Markarth: "the-reach", Morthal: "hjaalmarch",
      Riften: "the-rift", Solitude: "haafingar", Whiterun: "whiterun", Windhelm: "eastmarch", Winterhold: "winterhold",
    };
    const hold = holdByBoard[boardName];
    if (!hold) return false;
    if (this.isStaff(actorId)) return true;
    const faction = this.defs.get(`hold:${hold}`);
    // The lowest rank of the hold is its citizenry; every rank above it may clear the board
    const lowest = faction && faction.ranks.length ? faction.ranks[faction.ranks.length - 1].slug : "citizen";
    return rules.membershipsOf(this.cachedAccess(actorId)).some((m) => m.factionId === `hold:${hold}` && m.rankSlug !== lowest);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private online(): OnlineActor[] {
    const out: OnlineActor[] = [];
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (!this.mp.isConnected(userId)) continue; } catch { continue; }
      const actorId = this.actorOf(userId);
      if (!actorId) continue;
      let profileId = 0;
      try { profileId = Number(this.mp.get(actorId, "profileId")); } catch { continue; }
      if (profileId > 0) out.push({ userId, actorId, profileId, slot: this.slotOf(actorId) });
    }
    return out;
  }

  private onlineByActor(actorId: number): OnlineActor | null {
    const userId = userOf(this.mp, actorId);
    if (userId < 0 || this.actorOf(userId) !== actorId) return null;
    let profileId = 0;
    try { profileId = Number(this.mp.get(actorId, "profileId")); } catch { return null; }
    return profileId > 0 ? { userId, actorId, profileId, slot: this.slotOf(actorId) } : null;
  }

  private onlineMember(row: RosterRow, everyone: OnlineActor[]): OnlineActor | null {
    return everyone.find((o) => o.profileId === row.profileId && (row.slot === null || row.slot === o.slot)) || null;
  }

  // Inside the faction everyone goes by their real name, masked or not
  private memberName(row: RosterRow, everyone: OnlineActor[]): string {
    const online = this.onlineMember(row, everyone);
    return online ? this.realName(online.actorId) : row.playerName || "Unknown";
  }

  private realName(actorId: number): string {
    try {
      const masked = this.mp.get(actorId, "maskName");
      if (typeof masked === "string" && masked.trim()) return masked.trim();
    } catch { /* no mask */ }
    try {
      const name = this.mp.getActorName(actorId);
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch { /* no name */ }
    return "Unknown";
  }

  private who(actorId: number): string {
    let profileId = 0;
    try { profileId = Number(this.mp.get(actorId, "profileId")); } catch { /* gone */ }
    return `${this.realName(actorId)} (profile ${profileId})`;
  }

  // Character select stores the slot; the single-character flow has only slot 0
  private slotOf(actorId: number): number {
    try {
      const slot = this.mp.get(actorId, "private.charSlot");
      return Number.isInteger(slot) ? slot : 0;
    } catch {
      return 0;
    }
  }

  private actorOf(userId: number): number {
    if (userId < 0) return 0;
    try { return this.mp.getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private send(userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { this.mp.sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(userId: number, text: string): void {
    this.send(userId, { customPacketType: "factionNotice", text });
  }

  // Also posted to Discord when staff authority did it
  private staffLog(text: string, asStaff = false): void {
    this.log(`[factions] ${text}`);
    adminAudit(`[faction] ${text}`, asStaff);
  }

  private ctx!: SystemContext;
  private mp: Mp;
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private inviteDistance = DEFAULT_INVITE_DISTANCE;
  private uniformCooldownMs = DEFAULT_UNIFORM_COOLDOWN_HOURS * 3600 * 1000;
  private defs = new Map<string, rules.FactionDef>();
  private definitionsDueAt = 0;
  private definitionsLoading: Promise<void> | null = null;
  private definitionsLoaded = false;
  private definitionsSignature = "";
  private definitionsError = "";
  private menuError = "";
  private rosters = new Map<string, { at: number; rows: RosterRow[] }>();
  private accessByRef = new Map<number, AccessEntry>();
  private accessMtime = -1;
  private lastAccessCheck = 0;
  private lastRegencyCheck = 0;
  // factionId -> the regent acting for an absent leader, cleared whenever memberships or logins change
  private acting = new Map<string, OnlineActor | null>();
  private titles = new Map<number, string>();
  private invites = new Map<number, PendingInvite>();
  private inviteCooldown = new Map<string, number>();
  private nextConsentId = CONSENT_ID_BASE;
  private queues = new Map<number, Promise<void>>();
  private queueDepth = new Map<number, number>();
  private reported = new Map<number, string>();
  private releasing = new Set<string>();
}
