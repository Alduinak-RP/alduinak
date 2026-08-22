import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Housing: claims, locks and keys ───────────────────────────────────────────
//
// Players claim any unowned door or container by looking at it and pressing the
// housing key. Owners lock it, name it, cut keys, hand ownership over, or give
// it up. Locks are enforced here (activation is refused server-side); the
// client's RefDecorService only mirrors them into the engine so the player sees
// a "Requires Key" door instead of one that silently does nothing.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "propertyInfoRequest", target: <refrId> }
//     { customPacketType: "propertyRequest", action, target, recipient?, name? }
//       action: claim | abandon | lock | unlock | rename | transfer
//             | revoke | createkey | revokekeys | grantcontainer
//   Server -> Client:
//     { customPacketType: "propertyMenu", target, view, owned, name, locked,
//       hasKeys, canGrantContainers, ownerName }
//     { customPacketType: "propertyNotice", text }
//     { customPacketType: "refDecor", full?, refs: [{refId,name,locked,keyName,access}] }
//
// Persistence. The record lives on the reference itself as a `private.` dynamic
// field, so it rides the engine's changeform into MongoDB and comes back on
// restart (lazily, the first time the ref is touched). `housing.json` is only an
// index of claimed ids so the boot pass knows which refs to touch; the
// changeform stays the source of truth.
//
// Teleport doors are claimed as a pair. The record lives on the lower of the two
// form ids (the "primary"); the far side stores a pointer to it, so locking a
// house from the inside locks the outside too.

const HOUSING_PROP = "private.housing";
const OWNER_INDEX_PROP = "private.indexed.housingOwner";
const REVOKED_KEYS_PROP = "ff_revoked_keys";
const REGISTRY_FILE = "./housing.json";

// Vanilla key form; the name extra carries the credential.
const KEY_BASE_ID = 0x000db0e2;

const MAX_USER_SLOTS = 1024;
const MAX_NAME_LEN = 32;
const DEFAULT_MAX_CLAIMS = 8;
const DECOR_PUSH_INTERVAL_MS = 4000;

// Hold ranks that may manage property in their own hold; ported from the
// permission matrix in server_guest_lib/HoldClaims.cpp.
const MANAGER_RANKS = ["jarl", "steward"];

// Interior cells that belong to a hold, from HoldClaims::GetHoldCells().
// Only these can resolve a hold manager; everything else is owner + admin only.
const HOLD_CELLS: Record<number, string> = {
  0x000165a8: "whiterun",   // Breezehome
  0x0001b131: "whiterun",   // Dragonsreach Dungeon
  0x0003480e: "eastmarch",  // Hjerim
  0x000d7b12: "eastmarch",  // Windhelm Barracks
  0x000c9f1a: "rift",       // Honeyside
  0x0008bfe6: "rift",       // Riften Jail
  0x00017013: "reach",      // Vlindrel Hall
  0x00018b22: "reach",      // Hall of Justice
  0x000165a0: "haafingar",  // Proudspire Manor
  0x000136c9: "haafingar",  // Castle Dour Dungeon
  0x0301ab54: "pale",       // Heljarchen Hall
  0x0001620b: "pale",       // Dawnstar jail
  0x0300307b: "falkreath",  // Lakeview Manor
  0x000fa3d9: "falkreath",  // Falkreath jail
  0x0300307e: "hjaalmarch", // Windstad Manor
  0x00038a92: "hjaalmarch", // Morthal jail
  0x0001e7e0: "winterhold", // College quarters
  0x0001e7e2: "winterhold", // Winterhold jail
};

// One claimed property. Stored on the primary reference.
interface PropertyRecord {
  owner: number;
  ownerName: string;
  name: string | null;
  locked: boolean;
  serial: number;
  partner: number;
  containers: number[];
}

// The far half of a teleport pair just points at the primary.
interface PrimaryPointer {
  primary: number;
}

const emptyRecord = (): PropertyRecord => ({
  owner: 0, ownerName: "", name: null, locked: false,
  serial: 1, partner: 0, containers: [],
});

export class HousingSystem implements System {
  systemName = "HousingSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const maxClaims = Number(all?.["housingMaxClaims"]);
    if (Number.isFinite(maxClaims) && maxClaims > 0) this.maxClaims = maxClaims;

    const roleIds = all?.["adminDiscordRoleIds"];
    if (Array.isArray(roleIds)) this.adminRoleIds = roleIds.map((r) => String(r));
    const profileIds = all?.["adminProfileIds"];
    if (Array.isArray(profileIds)) this.adminProfileIds = profileIds.map((p) => Number(p));

    this.claimed = this.loadRegistry();
    this.installActivationHook(ctx);
    ctx.gm.on("userAssignActor", (userId: number) => this.onActorAssigned(ctx, userId));
    this.log(`[housing] ready, ${this.claimed.length} claimed refs in the registry`);
  }

  // Locks are enforced here: a refused activation never reaches the door.
  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate.bind(mp) : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let allowed = true;
      try {
        allowed = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[housing] activation check failed: ${e}`);
      }
      if (!allowed) return false;
      // Chain, so another system's hook still gets its say.
      return previous ? previous(targetId, casterId) !== false : true;
    };
  }

  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const primary = this.primaryOf(ctx, targetId);
    if (!primary) return true;
    const rec = this.read(ctx, primary);
    if (!rec || !rec.locked) return true;
    if (this.hasAccess(ctx, primary, rec, casterId)) return true;

    const userId = this.userOf(ctx, casterId);
    this.notice(ctx, userId, rec.name ? `${rec.name} is locked.` : "This is locked.");
    return false;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "propertyInfoRequest": this.onInfoRequest(ctx, userId, content); break;
      case "propertyRequest": this.onPropertyRequest(ctx, userId, content); break;
      default: break;
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    if (now - this.lastDecorMs < DECOR_PUSH_INTERVAL_MS) return;
    this.lastDecorMs = now;
    if (!this.decorDirty) return;
    this.decorDirty = false;
    for (const userId of this.onlineUsers(ctx)) this.pushDecor(ctx, userId, true);
  }

  // A fresh actor needs the full picture: names and locks for every claim.
  private onActorAssigned(ctx: SystemContext, userId: number): void {
    this.pushDecor(ctx, userId, true);
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  private onInfoRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    if (!target) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    this.sendMenu(ctx, userId, actorId, target);
  }

  private onPropertyRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    const action = String(content["action"] || "");
    if (!target || !action) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;

    const primary = this.primaryOf(ctx, target);
    if (!primary) {
      this.notice(ctx, userId, "You cannot claim that.");
      return;
    }
    const rec = this.read(ctx, primary) || emptyRecord();
    const isOwner = rec.owner !== 0 && rec.owner === this.profileOf(ctx, actorId);
    const isManager = this.isManager(ctx, actorId, primary);

    switch (action) {
      case "claim": this.doClaim(ctx, userId, actorId, primary, rec); break;
      case "abandon": this.doAbandon(ctx, userId, primary, rec, isOwner, isManager); break;
      case "revoke": this.doRevoke(ctx, userId, primary, rec, isManager); break;
      case "lock": this.doLock(ctx, userId, primary, rec, isOwner, isManager, true); break;
      case "unlock": this.doLock(ctx, userId, primary, rec, isOwner, isManager, false); break;
      case "rename": this.doRename(ctx, userId, primary, rec, isOwner, isManager, content["name"]); break;
      case "createkey": this.doCreateKey(ctx, userId, actorId, primary, rec, isOwner); break;
      case "revokekeys": this.doRevokeKeys(ctx, userId, primary, rec, isOwner, isManager); break;
      case "transfer": this.doTransfer(ctx, userId, primary, rec, isOwner, isManager, content["recipient"]); break;
      case "grantcontainer": this.doGrantContainer(ctx, userId, primary, rec, isOwner, isManager, content["recipient"]); break;
      default: break;
    }
  }

  private doClaim(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord): void {
    if (rec.owner !== 0) {
      this.notice(ctx, userId, "Somebody already owns this.");
      return;
    }
    const profileId = this.profileOf(ctx, actorId);
    if (!profileId) {
      this.notice(ctx, userId, "You cannot claim anything right now.");
      return;
    }
    if (this.countClaims(ctx, profileId) >= this.maxClaims) {
      this.notice(ctx, userId, `You already hold ${this.maxClaims} properties.`);
      return;
    }
    rec.owner = profileId;
    rec.ownerName = this.nameOf(ctx, actorId);
    rec.partner = this.partnerOf(ctx, primary);
    this.write(ctx, primary, rec);
    this.notice(ctx, userId, "This is yours now.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doAbandon(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to give up.");
      return;
    }
    this.stripKeys(ctx, rec, primary);
    this.erase(ctx, primary, rec);
    this.notice(ctx, userId, "Given up.");
  }

  private doRevoke(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isManager: boolean): void {
    if (!isManager) {
      this.notice(ctx, userId, "You cannot revoke this.");
      return;
    }
    if (rec.owner === 0) {
      this.notice(ctx, userId, "Nobody owns this.");
      return;
    }
    const formerName = rec.ownerName || "the owner";
    this.stripKeys(ctx, rec, primary);
    this.erase(ctx, primary, rec);
    this.notice(ctx, userId, `Taken back from ${formerName}.`);
  }

  private doLock(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, locked: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to lock.");
      return;
    }
    if (rec.owner === 0) {
      this.notice(ctx, userId, "Claim it first.");
      return;
    }
    rec.locked = locked;
    this.write(ctx, primary, rec);
    this.notice(ctx, userId, locked ? "Locked." : "Unlocked.");
    const actorId = this.actorOf(ctx, userId);
    if (actorId) this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRename(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, raw: unknown): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to name.");
      return;
    }
    const name = this.cleanName(raw);
    if (!name) {
      this.notice(ctx, userId, "That name will not do.");
      return;
    }
    rec.name = name;
    this.write(ctx, primary, rec);
    this.notice(ctx, userId, `Now called ${name}.`);
    const actorId = this.actorOf(ctx, userId);
    if (actorId) this.sendMenu(ctx, userId, actorId, primary);
  }

  // Keys are real inventory items; the name extra is the credential, so a key
  // handed over in trade works immediately and needs no server bookkeeping.
  private doCreateKey(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean): void {
    if (!isOwner) {
      this.notice(ctx, userId, "Only the owner cuts keys.");
      return;
    }
    if (!this.giveKey(ctx, actorId, this.keyNameOf(primary, rec))) {
      this.notice(ctx, userId, "The key could not be cut.");
      return;
    }
    this.notice(ctx, userId, "A key is in your pack.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRevokeKeys(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to re-key.");
      return;
    }
    this.stripKeys(ctx, rec, primary);
    rec.serial += 1;
    this.write(ctx, primary, rec);
    this.notice(ctx, userId, "Every key turned to scrap.");
    const actorId = this.actorOf(ctx, userId);
    if (actorId) this.sendMenu(ctx, userId, actorId, primary);
  }

  private doTransfer(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to hand over.");
      return;
    }
    const recipientActor = toFormId(rawRecipient);
    const recipientProfile = recipientActor ? this.profileOf(ctx, recipientActor) : 0;
    if (!recipientProfile) {
      this.notice(ctx, userId, "That is nobody.");
      return;
    }
    if (recipientProfile === rec.owner) {
      this.notice(ctx, userId, "They already own it.");
      return;
    }
    if (this.countClaims(ctx, recipientProfile) >= this.maxClaims) {
      this.notice(ctx, userId, "They hold too much property already.");
      return;
    }
    // Old keys must not open a new owner's door.
    this.stripKeys(ctx, rec, primary);
    rec.serial += 1;
    rec.owner = recipientProfile;
    rec.ownerName = this.nameOf(ctx, recipientActor);
    rec.partner = this.partnerOf(ctx, primary);
    this.write(ctx, primary, rec);
    this.notice(ctx, userId, `Handed to ${rec.ownerName}.`);
    const recipientUser = this.userOf(ctx, recipientActor);
    this.notice(ctx, recipientUser, rec.name ? `${rec.name} is yours now.` : "You have been given a property.");
  }

  // Containers inside a claimed house can be handed to a lodger without giving
  // up the building; the container becomes its own claim.
  private doGrantContainer(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to grant.");
      return;
    }
    const recipientActor = toFormId(rawRecipient);
    const recipientProfile = recipientActor ? this.profileOf(ctx, recipientActor) : 0;
    if (!recipientProfile) {
      this.notice(ctx, userId, "That is nobody.");
      return;
    }
    const child = emptyRecord();
    child.owner = recipientProfile;
    child.ownerName = this.nameOf(ctx, recipientActor);
    child.name = rec.name ? `${rec.name} store` : null;
    this.write(ctx, primary, child);
    this.notice(ctx, userId, `${child.ownerName} may use it.`);
    this.notice(ctx, this.userOf(ctx, recipientActor), "You were given a container.");
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number, actorId: number, target: number): void {
    const primary = this.primaryOf(ctx, target);
    const rec = primary ? this.read(ctx, primary) : null;
    const profileId = this.profileOf(ctx, actorId);
    const isOwner = !!rec && rec.owner !== 0 && rec.owner === profileId;
    const isManager = !!primary && this.isManager(ctx, actorId, primary);

    let view: string;
    if (isOwner) view = "owner";
    else if (isManager) view = "manager";
    else if (primary && (!rec || rec.owner === 0)) view = "claimable";
    else view = "denied";

    this.send(ctx, userId, {
      customPacketType: "propertyMenu",
      target: primary || target,
      view,
      owned: !!rec && rec.owner !== 0,
      name: rec ? rec.name : null,
      locked: !!rec && rec.locked,
      hasKeys: !!rec && rec.owner !== 0,
      canGrantContainers: isOwner || isManager,
      ownerName: rec && rec.owner !== 0 ? (rec.ownerName || "Someone") : null,
    });
  }

  // ── Access ──────────────────────────────────────────────────────────────────

  private hasAccess(ctx: SystemContext, primary: number, rec: PropertyRecord, actorId: number): boolean {
    if (rec.owner === 0) return true;
    const profileId = this.profileOf(ctx, actorId);
    if (profileId && profileId === rec.owner) return true;
    if (this.isManager(ctx, actorId, primary)) return true;
    return this.holdsKey(ctx, actorId, this.keyNameOf(primary, rec));
  }

  private isManager(ctx: SystemContext, actorId: number, primary: number): boolean {
    if (this.isAdmin(ctx, actorId)) return true;
    const hold = this.holdOf(ctx, primary);
    if (!hold) return false;
    return this.holdRanks(ctx, actorId).some((r) => r.hold === hold && MANAGER_RANKS.indexOf(r.rank) !== -1);
  }

  private isAdmin(ctx: SystemContext, actorId: number): boolean {
    const mp = ctx.svr as Mp;
    try {
      const roles = mp.get(actorId, "private.discordRoles");
      if (Array.isArray(roles) && roles.some((r: unknown) => this.adminRoleIds.indexOf(String(r)) !== -1)) return true;
    } catch { }
    try {
      const profileId = Number(mp.get(actorId, "profileId"));
      if (this.adminProfileIds.indexOf(profileId) !== -1) return true;
    } catch { }
    return false;
  }

  // Backend faction rows are "hold:<slug>:<rank>".
  private holdRanks(ctx: SystemContext, actorId: number): Array<{ hold: string; rank: string }> {
    const out: Array<{ hold: string; rank: string }> = [];
    try {
      const access = (ctx.svr as Mp).get(actorId, "private.skympAccess");
      const rows = access && Array.isArray(access.factions) ? access.factions : [];
      for (const row of rows) {
        const parts = String(row?.requirementId || "").split(":");
        if (parts.length === 3 && parts[0] === "hold") out.push({ hold: parts[1], rank: parts[2] });
      }
    } catch { }
    return out;
  }

  // The hold a property answers to, via the interior cell it belongs to.
  private holdOf(ctx: SystemContext, primary: number): string | null {
    const cellId = this.cellOf(ctx, primary);
    return cellId ? (HOLD_CELLS[cellId] || null) : null;
  }

  private cellOf(ctx: SystemContext, refrId: number): number {
    const mp = ctx.svr as Mp;
    // A teleport door belongs to the cell it opens into, not the one it stands in.
    const partner = this.partnerOf(ctx, refrId);
    const subject = partner || refrId;
    try {
      const desc = mp.get(subject, "worldOrCellDesc");
      return desc ? (mp.getIdFromDesc(desc) >>> 0) : 0;
    } catch {
      return 0;
    }
  }

  // ── Keys ────────────────────────────────────────────────────────────────────

  // Readable, unique per property, and dead once the serial moves on.
  private keyNameOf(primary: number, rec: PropertyRecord): string {
    const label = rec.name || "Property";
    const tag = primary.toString(16).toUpperCase().slice(-4);
    return rec.serial > 1 ? `${label} Key (${tag}-${rec.serial})` : `${label} Key (${tag})`;
  }

  private giveKey(ctx: SystemContext, actorId: number, keyName: string): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory") || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.slice() : [];
      entries.push({ baseId: KEY_BASE_ID, count: 1, name: keyName });
      mp.set(actorId, "inventory", { entries });
      return true;
    } catch (e) {
      this.log(`[housing] could not give key: ${e}`);
      return false;
    }
  }

  private holdsKey(ctx: SystemContext, actorId: number, keyName: string): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      return entries.some((e: any) => (Number(e?.baseId) >>> 0) === KEY_BASE_ID && String(e?.name || "") === keyName);
    } catch {
      return false;
    }
  }

  // Pull the property's keys from everyone online; blacklist them for anyone
  // offline so the copies in their pack die at next login.
  private stripKeys(ctx: SystemContext, rec: PropertyRecord, primary: number): void {
    const mp = ctx.svr as Mp;
    const keyName = this.keyNameOf(primary, rec);
    for (const userId of this.onlineUsers(ctx)) {
      const actorId = this.actorOf(ctx, userId);
      if (!actorId) continue;
      try {
        const inv = mp.get(actorId, "inventory");
        const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
        const kept = entries.filter((e: any) => !((Number(e?.baseId) >>> 0) === KEY_BASE_ID && String(e?.name || "") === keyName));
        if (kept.length !== entries.length) mp.set(actorId, "inventory", { entries: kept });
      } catch { /* actor gone */ }
    }
    this.blacklistKey(ctx, keyName);
  }

  private blacklistKey(ctx: SystemContext, keyName: string): void {
    const mp = ctx.svr as Mp;
    for (const userId of this.onlineUsers(ctx)) {
      const actorId = this.actorOf(ctx, userId);
      if (!actorId) continue;
      try {
        const prev = mp.get(actorId, REVOKED_KEYS_PROP);
        const list = Array.isArray(prev) ? prev.slice() : [];
        if (list.indexOf(keyName) === -1) {
          list.push(keyName);
          mp.set(actorId, REVOKED_KEYS_PROP, list.slice(-64));
        }
      } catch { /* actor gone */ }
    }
  }

  // ── refDecor ────────────────────────────────────────────────────────────────

  // `access` is personalized, so each player gets their own view of the set.
  private pushDecor(ctx: SystemContext, userId: number, full: boolean): void {
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const refs: Array<Record<string, unknown>> = [];
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (!rec || rec.owner === 0) continue;
      const access = this.hasAccess(ctx, primary, rec, actorId);
      const keyName = this.keyNameOf(primary, rec);
      refs.push({ refId: primary, name: rec.name, locked: rec.locked, keyName, access });
      if (rec.partner) {
        refs.push({ refId: rec.partner, name: rec.name, locked: rec.locked, keyName, access });
      }
      for (const c of rec.containers) {
        refs.push({ refId: c, name: rec.name, locked: rec.locked, keyName, access });
      }
    }
    this.send(ctx, userId, { customPacketType: "refDecor", full, refs });
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  // Resolve any half of a pair (or a plain ref) to the id the record lives on.
  private primaryOf(ctx: SystemContext, refrId: number): number {
    if (!refrId) return 0;
    const mp = ctx.svr as Mp;
    let raw: any = null;
    try {
      raw = mp.get(refrId, HOUSING_PROP);
    } catch {
      return 0; // not a reference the server can hold state on
    }
    if (raw && typeof raw === "object" && Number(raw.primary)) return Number(raw.primary) >>> 0;
    if (raw && typeof raw === "object") return refrId;

    // Unclaimed: the pair's primary is the lower of the two ids.
    const partner = this.partnerOf(ctx, refrId);
    if (partner && partner < refrId) return partner;
    return refrId;
  }

  // The far side of a teleport door, read out of the ESM's XTEL field.
  private partnerOf(ctx: SystemContext, refrId: number): number {
    const cached = this.partnerCache.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let partner = 0;
    try {
      const rec = mp.lookupEspmRecordById(refrId);
      const fields = rec && rec.record && Array.isArray(rec.record.fields) ? rec.record.fields : [];
      const xtel = fields.filter((f: any) => f && f.type === "XTEL")[0];
      if (xtel && xtel.data && xtel.data.length >= 4) {
        const b = xtel.data;
        const local = ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
        if (local && typeof rec.toGlobalRecordId === "function") {
          partner = rec.toGlobalRecordId(local) >>> 0;
        }
      }
    } catch { /* not a door, or no espm record */ }
    this.partnerCache.set(refrId, partner);
    return partner;
  }

  private read(ctx: SystemContext, primary: number): PropertyRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(primary, HOUSING_PROP);
      if (!raw || typeof raw !== "object" || Number((raw as any).primary)) return null;
      const r = raw as Partial<PropertyRecord>;
      return {
        owner: Number(r.owner) || 0,
        ownerName: String(r.ownerName || ""),
        name: typeof r.name === "string" && r.name ? r.name : null,
        locked: r.locked === true,
        serial: Number(r.serial) || 1,
        partner: Number(r.partner) || 0,
        containers: Array.isArray(r.containers) ? r.containers.map((c) => Number(c) >>> 0) : [],
      };
    } catch {
      return null;
    }
  }

  private write(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    const mp = ctx.svr as Mp;
    try {
      mp.set(primary, HOUSING_PROP, rec);
      mp.set(primary, OWNER_INDEX_PROP, String(rec.owner));
      if (rec.partner) {
        const pointer: PrimaryPointer = { primary };
        mp.set(rec.partner, HOUSING_PROP, pointer);
      }
    } catch (e) {
      this.log(`[housing] write failed for ${primary.toString(16)}: ${e}`);
      return;
    }
    this.remember(primary);
    this.decorDirty = true;
  }

  private erase(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    const mp = ctx.svr as Mp;
    try {
      mp.set(primary, HOUSING_PROP, null);
      mp.set(primary, OWNER_INDEX_PROP, "0");
      if (rec.partner) mp.set(rec.partner, HOUSING_PROP, null);
      for (const c of rec.containers) mp.set(c, HOUSING_PROP, null);
    } catch (e) {
      this.log(`[housing] erase failed for ${primary.toString(16)}: ${e}`);
    }
    this.forget(primary);
    this.decorDirty = true;
  }

  private countClaims(ctx: SystemContext, profileId: number): number {
    let n = 0;
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (rec && rec.owner === profileId) n++;
    }
    return n;
  }

  // ── Registry file ───────────────────────────────────────────────────────────
  //
  // Only an index of which refs to touch on boot; the changeform holds the data.

  private loadRegistry(): number[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
      return Array.isArray(parsed) ? parsed.map((v) => Number(v) >>> 0).filter((v) => v) : [];
    } catch {
      return [];
    }
  }

  private saveRegistry(): void {
    try {
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(this.claimed));
    } catch (e) {
      this.log(`[housing] registry write failed: ${e}`);
    }
  }

  private remember(primary: number): void {
    if (this.claimed.indexOf(primary) !== -1) return;
    this.claimed.push(primary);
    this.saveRegistry();
  }

  private forget(primary: number): void {
    const i = this.claimed.indexOf(primary);
    if (i === -1) return;
    this.claimed.splice(i, 1);
    this.saveRegistry();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private cleanName(raw: unknown): string {
    return String(raw || "").replace(/[^A-Za-z0-9 '_-]/g, "").trim().slice(0, MAX_NAME_LEN);
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try { return (ctx.svr as Mp).getUserByActor(actorId); } catch { return -1; }
  }

  private profileOf(ctx: SystemContext, actorId: number): number {
    try { return Number((ctx.svr as Mp).get(actorId, "profileId")) || 0; } catch { return 0; }
  }

  private nameOf(ctx: SystemContext, actorId: number): string {
    try {
      const appearance = (ctx.svr as Mp).get(actorId, "appearance");
      return String((appearance && appearance.name) || "Someone");
    } catch {
      return "Someone";
    }
  }

  private onlineUsers(ctx: SystemContext): number[] {
    const mp = ctx.svr as Mp;
    const out: number[] = [];
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (mp.isConnected(userId)) out.push(userId); } catch { /* slot gone */ }
    }
    return out;
  }

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "propertyNotice", text });
  }

  private claimed: number[] = [];
  private partnerCache = new Map<number, number>();
  private adminRoleIds: string[] = [];
  private adminProfileIds: number[] = [];
  private maxClaims = DEFAULT_MAX_CLAIMS;
  private decorDirty = false;
  private lastDecorMs = 0;
}
