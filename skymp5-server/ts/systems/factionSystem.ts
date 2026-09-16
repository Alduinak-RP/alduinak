import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, CHARACTER_LIST_EVENT, CHARACTER_RETIRED_EVENT, ACCESS_REFRESHED_EVENT, CharacterListEntry } from "./system";
import { AccessPayload, FactionBackend, RosterRow, factionBackendOf, filterAccessForSlot } from "../backendFactionApi";
import { AdminRoleConfig, readAdminRoleConfig, adminTierOf } from "./adminRoles";
import { addItemTo, isNear, isPlayerActor, nameShownTo, userOf } from "./actorUtil";
import { formIdFromConfig } from "./formIdUtil";
import { ITEM_TYPES } from "./itemCatalog";
import { HousingSystem } from "./housingSystem";
import * as rules from "./factionRules";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Factions: hold courts, armies and guilds whose ranks live in the backend (skymp5-backend data/faction-whitelist.json, one row per
// character and slot). This system runs the rules in game: the Personal Menu Faction tab, invitations with consent, rank changes,
// uniforms, faction chat, faction-only doors and containers, and removing a deleted or perma-dead character's ranks.
// Docs: docs/docs_roleplay_property_factions.md section 6.
//
// Client -> server:
//   factionMenuRequest {factionId?}                          -> factionMenu
//   factionInviteOptionsRequest {target}                     -> factionInviteOptions (the interaction menu's Invite to faction)
//   factionRequest {action, factionId, ...}
//     invite {target, rank}                                  consent prompt to the target, then the rank is granted
//     promote | demote | remove | uniform {profileId, slot}  slot null = the row shared by every character
//     setRank {profileId, slot, rank}
//     leave | chat                                           chat: the faction /f speaks to
//   captureConsentResult {requestId, accepted}               ids from CONSENT_ID_BASE up are ours
// Server -> client:
//   factionMenu {available, factions: [{id, name, zone, color, rank}], selected, chat, detail}   detail: roster with per-member rights, inviteRanks, nearby
//   factionInviteOptions {target, targetName, options: [{factionId, name, ranks: [{slug, name}]}]}
//   factionState {factions: [{id, name}], chat, canInvite}   drives the chat tab and the interaction menu
//   factionNotice {text}, captureConsentRequest {requestId, text}
// Chat: the Alduinak/faction-chat plugin calls globalThis.__alduinakFactionChat(actorId, text) and delivers the [[F]] line it returns.
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
const DEFINITIONS_TTL_MS = 60000;
const DEFINITIONS_RETRY_MS = 15000;
const ROSTER_TTL_MS = 3000;
const ACCESS_FILE_CHECK_MS = 10000;
const RELEASE_RETRIES = 5;
const RELEASE_RETRY_MS = 30000;
const MAX_QUEUED = 3;
const MAX_USER_SLOTS = 1024;
const UNIFORM_PROP = "private.factionUniformAt";
const CHAT_PROP = "private.factionChat";
const RELEASED_PROP = "private.factionsReleased";

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
  promote: string;
  demote: string;
  setRanks: string[];
  canRemove: boolean;
  canUniform: boolean;
}

const noticeText = (err: unknown): string => {
  const msg = String((err as Error)?.message || err);
  if (msg.includes("slot is already filled")) return "That rank is full.";
  if (msg.includes("already has this rank")) return "They already hold that rank.";
  return "The faction records are unavailable, try again shortly.";
};

// Names and labels inside a chat line cannot open tags or colours
const chatSafe = (text: string): string =>
  text.replace(/\p{Cc}/gu, " ").replace(/#\{/g, "# {").replace(/\[\[/g, "[ [").replace(/\|/g, "/").trim().slice(0, 60);

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
    (globalThis as any).__alduinakFactionChat = (actorId: number, text: string) => this.chat(actorId >>> 0, String(text ?? "").trim());

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => { void this.onAssign(userId, actorId >>> 0); });
    ctx.gm.on(CHARACTER_LIST_EVENT, (profileId: number, entries: CharacterListEntry[]) => this.onCharacterList(profileId, entries));
    ctx.gm.on(CHARACTER_RETIRED_EVENT, (profileId: number, slot: number, actorId: number) => this.release(profileId, slot, actorId, this.realName(actorId), "deletion", 0));

    this.loadAccessFile();
    this.log(`[factions] ready, ${this.accessByRef.size} faction-only door(s) and container(s)`);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "factionMenuRequest": void this.queued(userId, () => this.sendMenu(userId, String(content["factionId"] ?? ""))); break;
      case "factionInviteOptionsRequest": void this.queued(userId, () => this.sendInviteOptions(userId, content)); break;
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
  }

  disconnect(userId: number): void {
    this.queues.delete(userId);
    this.queueDepth.delete(userId);
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
      case "invite": await this.invite(userId, actorId, faction, auth, content); return;
      case "leave": await this.leave(userId, actorId, faction, access); break;
      case "chat": this.setChat(userId, actorId, faction, access); break;
      case "promote":
      case "demote":
      case "setRank":
      case "remove":
      case "uniform": await this.memberAction(userId, actorId, faction, auth, action, content); break;
      default: return;
    }
    await this.sendMenu(userId, faction.id);
  }

  private async invite(userId: number, actorId: number, faction: rules.FactionDef, auth: rules.Authority, content: Content): Promise<void> {
    const rank = rules.rankOf(faction, String(content["rank"] ?? ""));
    const targetId = Number(content["target"]) >>> 0;
    if (!rank || !rules.canAppoint(faction, auth, rank)) return this.notice(userId, "You cannot invite anyone to that rank.");
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
    if (rules.membershipsOf(targetAccess).some((m) => m.factionId === faction.id)) {
      return this.notice(userId, `They already belong to ${faction.name}. Change their rank from the Faction tab.`);
    }
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
      text: `${nameShownTo(this.mp, targetId, actorId)} invites you to join ${faction.name} as ${rank.name}. Accept?`,
    });
    this.notice(userId, `Waiting for ${nameShownTo(this.mp, actorId, targetId)} to accept…`);
  }

  // A player standing close, connected, and not the inviter
  private inviteTargetRefusal(actorId: number, targetId: number): string {
    if (!targetId || targetId === actorId || !isPlayerActor(this.mp, targetId) || !this.onlineByActor(targetId)) return "Look at the player you want to invite.";
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
    // The inviter may have lost the rank while the prompt was open
    const inviter = this.onlineByActor(invite.inviterId);
    const inviterAuth = inviter ? this.authorityOf(invite.inviterId, faction, await this.refreshActorAccess(invite.inviterId)) : null;
    if (!inviterAuth || !rules.canAppoint(faction, inviterAuth, rank)) return this.notice(userId, "The invitation is no longer valid.");

    const payload = await backend.assign(target.profileId, rank.id, this.realName(target.actorId), target.slot, this.who(invite.inviterId));
    this.applyAccess(target.profileId, payload);
    this.invalidateRoster(faction.id);
    this.notice(userId, `You joined ${faction.name} as ${rank.name}.`);
    this.notice(inviterUser, `${this.realName(target.actorId)} joined ${faction.name} as ${rank.name}.`);
    this.staffLog(`${this.who(invite.inviterId)} brought ${this.who(target.actorId)} into ${faction.name} as ${rank.name}${inviterAuth.staff && !inviterAuth.rank ? " (staff)" : ""}`);
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
      if (!rules.canManage(faction, auth, memberRank)) return this.notice(userId, "You cannot remove them.");
      const payload = await backend.remove(profileId, memberRank.id, slot);
      this.applyAccess(profileId, payload);
      this.invalidateRoster(faction.id);
      if (online) this.notice(online.userId, `You were removed from ${faction.name}.`);
      this.notice(userId, `${name} was removed from ${faction.name}.`);
      this.staffLog(`${this.who(actorId)} removed ${name} (profile ${profileId}${slot === null ? "" : `, character ${slot + 1}`}) from ${faction.name}, was ${memberRank.name}`);
      return;
    }

    const target = action === "promote" ? rules.promotionFor(faction, auth, memberRank)
      : action === "demote" ? rules.demotionFor(faction, auth, memberRank)
        : rules.rankOf(faction, String(content["rank"] ?? ""));
    if (!target || target.slug === memberRank.slug || !rules.canManage(faction, auth, memberRank) || !rules.canAppoint(faction, auth, target)) {
      return this.notice(userId, "You cannot give them that rank.");
    }
    const payload = await backend.assign(profileId, target.id, name, slot, this.who(actorId));
    this.applyAccess(profileId, payload);
    this.invalidateRoster(faction.id);
    if (online) this.notice(online.userId, `You are now ${target.name} of ${faction.name}.`);
    this.notice(userId, `${name} is now ${target.name}.`);
    this.staffLog(`${this.who(actorId)} made ${name} (profile ${profileId}${slot === null ? "" : `, character ${slot + 1}`}) ${target.name} of ${faction.name}, was ${memberRank.name}`);
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
    this.staffLog(`${this.who(actorId)} issued the ${faction.name} uniform to ${this.who(online.actorId)}: ${given.join(", ")}`);
  }

  private async leave(userId: number, actorId: number, faction: rules.FactionDef, access: unknown): Promise<void> {
    const self = this.onlineByActor(actorId);
    const rows = rules.membershipsOf(access).filter((m) => m.factionId === faction.id);
    if (!self || !rows.length) return this.notice(userId, `You are not in ${faction.name}.`);
    let payload: AccessPayload | null = null;
    for (const row of rows) payload = await this.backend()!.remove(self.profileId, `${faction.id}:${row.rankSlug}`, row.slot);
    if (payload) this.applyAccess(self.profileId, payload);
    this.invalidateRoster(faction.id);
    this.notice(userId, `You left ${faction.name}.`);
    this.staffLog(`${this.who(actorId)} left ${faction.name}, was ${rows.map((r) => rules.rankOf(faction, r.rankSlug)?.name || r.rankSlug).join(", ")}`);
  }

  private setChat(userId: number, actorId: number, faction: rules.FactionDef, access: unknown): void {
    if (!rules.membershipsOf(access).some((m) => m.factionId === faction.id)) return this.notice(userId, `You are not in ${faction.name}.`);
    try { this.mp.set(actorId, CHAT_PROP, faction.id); } catch { return; }
    this.notice(userId, `/f now speaks to ${faction.name}.`);
    this.sendState(userId, actorId);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  // A backend failure shows the tab as unavailable without a notice, the menu opens on every interact key press
  private async sendMenu(userId: number, wanted: string): Promise<void> {
    const actorId = this.actorOf(userId);
    if (!actorId) return;
    const unavailable = { customPacketType: "factionMenu", available: false, factions: [] as unknown[], selected: "", chat: "", detail: null as unknown };
    if (!this.backend()) return this.send(userId, unavailable);
    try {
      await this.ensureDefinitions();
      const access = await this.refreshActorAccess(actorId);
      const mine = rules.membershipsOf(access).filter((m) => this.defs.has(m.factionId));
      const staff = this.isStaff(actorId);
      const shown = staff ? Array.from(this.defs.values()) : mine.map((m) => this.defs.get(m.factionId)!).filter((f, i, all) => all.indexOf(f) === i);
      const selected = shown.find((f) => f.id === wanted) || shown.find((f) => f.id === mine[0]?.factionId) || shown[0] || null;
      const rankName = (f: rules.FactionDef) => {
        const m = mine.find((x) => x.factionId === f.id);
        return m ? rules.rankOf(f, m.rankSlug)?.name || m.rankSlug : "";
      };
      this.send(userId, {
        customPacketType: "factionMenu",
        available: true,
        factions: shown.map((f) => ({ id: f.id, name: f.name, zone: f.zone, color: f.color, rank: rankName(f) })),
        selected: selected ? selected.id : "",
        chat: this.chatFactionOf(actorId, mine),
        detail: selected ? await this.detail(actorId, selected, access, staff) : null,
      });
      this.menuError = "";
    } catch (e) {
      if (String(e) !== this.menuError) this.log(`[factions] faction menu unavailable: ${e}`);
      this.menuError = String(e);
      this.send(userId, unavailable);
    }
  }

  private async detail(actorId: number, faction: rules.FactionDef, access: unknown, staff: boolean): Promise<Record<string, unknown>> {
    const auth = this.authorityOf(actorId, faction, access);
    const self = this.onlineByActor(actorId);
    const roster = await this.roster(faction.id, false);
    const everyone = this.online();
    const members: MemberView[] = roster
      .map((row) => {
        const rank = rules.rankOf(faction, row.rankSlug);
        const isSelf = !!self && row.profileId === self.profileId && (row.slot === null || row.slot === self.slot);
        const manage = !!rank && !isSelf && rules.canManage(faction, auth, rank);
        return {
          key: `${row.profileId}:${row.slot === null ? "all" : row.slot}`,
          profileId: row.profileId ?? 0,
          slot: row.slot,
          name: this.memberName(row, everyone),
          rankSlug: row.rankSlug,
          rankName: rank ? rank.name : row.rank || row.rankSlug,
          online: !!this.onlineMember(row, everyone),
          self: isSelf,
          promote: rank && !isSelf ? rules.promotionFor(faction, auth, rank)?.slug || "" : "",
          demote: rank && !isSelf ? rules.demotionFor(faction, auth, rank)?.slug || "" : "",
          setRanks: manage ? rules.appointableRanks(faction, auth).filter((r) => r.slug !== row.rankSlug).map((r) => r.slug) : [],
          canRemove: manage,
          canUniform: !!rank && rules.canIssueUniform(faction, auth) && rules.uniformFor(faction, rank).length > 0,
        };
      })
      .filter((m) => m.profileId > 0)
      .sort((a, b) => (rules.rankOf(faction, a.rankSlug)?.order ?? 99) - (rules.rankOf(faction, b.rankSlug)?.order ?? 99) || a.name.localeCompare(b.name));
    const inviteRanks = rules.appointableRanks(faction, auth).map((r) => ({ slug: r.slug, name: r.name }));
    // Players close enough to invite who are not in the faction yet
    const nearby = !inviteRanks.length ? [] : everyone
      .filter((o) => o.actorId !== actorId && isNear(this.mp, actorId, o.actorId, this.inviteDistance))
      .filter((o) => !roster.some((row) => row.profileId === o.profileId && (row.slot === null || row.slot === o.slot)))
      .map((o) => ({ target: o.actorId, name: nameShownTo(this.mp, actorId, o.actorId) }));
    return {
      id: faction.id,
      name: faction.name,
      zone: faction.zone,
      color: faction.color,
      myRank: auth.rank ? auth.rank.name : "",
      staff,
      ranks: faction.ranks.map((r) => ({ slug: r.slug, name: r.name, capacity: r.capacity, count: roster.filter((m) => m.rankSlug === r.slug).length })),
      members,
      canLeave: !!auth.rank,
      inviteRanks,
      nearby,
    };
  }

  private async sendInviteOptions(userId: number, content: Content): Promise<void> {
    const actorId = this.actorOf(userId);
    if (!actorId) return;
    if (!this.backend()) return this.notice(userId, "Factions are unavailable right now.");
    const targetId = Number(content["target"]) >>> 0;
    const refusal = this.inviteTargetRefusal(actorId, targetId);
    if (refusal) return this.notice(userId, refusal);
    await this.ensureDefinitions();
    const access = await this.refreshActorAccess(actorId);
    const staff = this.isStaff(actorId);
    const mine = new Set(rules.membershipsOf(access).map((m) => m.factionId));
    const options = Array.from(this.defs.values())
      .filter((f) => staff || mine.has(f.id))
      .map((f) => ({ factionId: f.id, name: f.name, ranks: rules.appointableRanks(f, this.authorityOf(actorId, f, access)).map((r) => ({ slug: r.slug, name: r.name })) }))
      .filter((o) => o.ranks.length > 0);
    if (!options.length) return this.notice(userId, "You cannot invite anyone to a faction.");
    this.send(userId, { customPacketType: "factionInviteOptions", target: targetId, targetName: nameShownTo(this.mp, actorId, targetId), options });
  }

  private sendState(userId: number, actorId: number): void {
    if (userId < 0) return;
    let access: unknown = null;
    try { access = this.mp.get(actorId, "private.skympAccess"); } catch { return; }
    const mine = rules.membershipsOf(access).filter((m, i, all) => all.findIndex((x) => x.factionId === m.factionId) === i);
    const staff = this.isStaff(actorId);
    const canInvite = Array.from(this.defs.values()).some((f) => (staff || mine.some((m) => m.factionId === f.id)) && rules.appointableRanks(f, this.authorityOf(actorId, f, access)).length > 0);
    this.send(userId, {
      customPacketType: "factionState",
      factions: mine.map((m) => ({ id: m.factionId, name: this.defs.get(m.factionId)?.name || m.factionId })),
      chat: this.chatFactionOf(actorId, mine),
      canInvite,
    });
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  private chat(actorId: number, text: string): { error?: string; recipients?: number[]; line?: string } {
    const mine = this.membershipsOfActor(actorId);
    if (!mine.length) return { error: "You are not in a faction." };
    const chatId = this.chatFactionOf(actorId, mine);
    const faction = this.defs.get(chatId);
    const label = faction ? faction.name : chatId;
    if (!text) return { error: `Usage: /f <message> speaks to ${label}. Pick another faction in the Personal Menu Faction tab.` };
    const own = mine.find((m) => m.factionId === chatId)!;
    const rank = faction ? rules.rankOf(faction, own.rankSlug) : null;
    const recipients = this.online()
      .filter((o) => this.membershipsOfActor(o.actorId).some((m) => m.factionId === chatId))
      .map((o) => o.actorId);
    const speaker = `${rank ? chatSafe(rank.name) + " " : ""}${chatSafe(this.realName(actorId))}`;
    return { recipients, line: `[[F]]#{${faction ? faction.color : "c9a36b"}}[${chatSafe(label)}] ${speaker}: ${text}` };
  }

  // The chosen faction while still a member, otherwise the first one
  private chatFactionOf(actorId: number, mine: rules.Membership[]): string {
    let chosen = "";
    try { chosen = String(this.mp.get(actorId, CHAT_PROP) ?? ""); } catch { /* actor gone */ }
    return mine.some((m) => m.factionId === chosen) ? chosen : mine[0]?.factionId || "";
  }

  // ── Doors and containers ────────────────────────────────────────────────────

  // Either half of a teleport pair names the faction; players outside it are refused, NPCs pass
  private gate(actorId: number, refrId: number): { name: string; allowed: boolean } | null {
    if (!this.accessByRef.size) return null;
    const entry = this.housing.doorSides(this.ctx, refrId).map((id) => this.accessByRef.get(id)).find(Boolean);
    if (!entry) return null;
    const name = entry.label || entry.factions.map((id) => this.defs.get(id)?.name || id).join(" or ");
    if (!isPlayerActor(this.mp, actorId)) return { name, allowed: true };
    const allowed = this.membershipsOfActor(actorId).some((m) => {
      if (!entry.factions.includes(m.factionId)) return false;
      const ranks = Array.isArray(entry.ranks) ? entry.ranks : entry.ranks ? entry.ranks[m.factionId] : null;
      return !ranks || ranks.includes(m.rankSlug);
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
      othersAlive = (this.mp.getActorsByProfileId(profileId) as number[]).some((a) => {
        if (a >>> 0 === actorId) return false;
        try { return this.mp.get(a, "private.permaDead") !== true; } catch { return false; }
      });
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
        const had = this.defs.size;
        this.defs = rules.buildFactions(raw);
        this.definitionsDueAt = Date.now() + DEFINITIONS_TTL_MS;
        this.definitionsError = "";
        if (had !== this.defs.size) this.log(`[factions] ${this.defs.size} faction(s) loaded from the backend`);
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
    return { staff: this.isStaff(actorId), rank: own };
  }

  private isStaff(actorId: number): boolean {
    const tier = adminTierOf(this.mp, actorId, this.roleCfg);
    return !!tier && this.roleCfg.tierCaps[tier].factions === true;
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

  private staffLog(text: string): void {
    this.log(`[factions] ${text}`);
    try { (globalThis as any).__alduinakAdminLog?.(`[faction] ${text}`); } catch { /* gamemode not loaded */ }
  }

  private ctx!: SystemContext;
  private mp: Mp;
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private inviteDistance = DEFAULT_INVITE_DISTANCE;
  private uniformCooldownMs = DEFAULT_UNIFORM_COOLDOWN_HOURS * 3600 * 1000;
  private defs = new Map<string, rules.FactionDef>();
  private definitionsDueAt = 0;
  private definitionsLoading: Promise<void> | null = null;
  private definitionsError = "";
  private menuError = "";
  private rosters = new Map<string, { at: number; rows: RosterRow[] }>();
  private accessByRef = new Map<number, AccessEntry>();
  private accessMtime = -1;
  private lastAccessCheck = 0;
  private invites = new Map<number, PendingInvite>();
  private inviteCooldown = new Map<string, number>();
  private nextConsentId = CONSENT_ID_BASE;
  private queues = new Map<number, Promise<void>>();
  private queueDepth = new Map<number, number>();
  private reported = new Map<number, string>();
  private releasing = new Set<string>();
}
