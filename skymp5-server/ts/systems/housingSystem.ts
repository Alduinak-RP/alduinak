import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { toFormId } from "./formIdUtil";
import { AdminRoleConfig, readAdminRoleConfig, adminTierOf } from "./adminRoles";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Housing: claims, locks and keys ───────────────────────────────────────────
//
// Players claim any unowned door or container they are standing at by pressing
// the housing key. Owners lock it, name it, cut keys, hand ownership over, or
// give it up. Locks are enforced here (activation is refused server-side); the
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
// index of claimed ids so a boot pass knows which refs to touch; the changeform
// stays the source of truth. Giving a property up leaves an ownerless stub
// behind rather than deleting the record, so the key serial survives and a
// re-claim cannot mint a credential that old copies already answer to.
//
// Teleport doors are claimed as a pair. The record lives on the lower of the two
// form ids (the "primary"); the far side stores a pointer to it, so locking a
// house from the inside locks the outside too.

const HOUSING_PROP = "private.housing";
const OWNER_INDEX_PROP = "private.indexed.housingOwner";
const REGISTRY_FILE = "./housing.json";

// Vanilla key form; the name extra carries the credential.
const KEY_BASE_ID = 0x000db0e2;

const MAX_USER_SLOTS = 1024;
const MAX_NAME_LEN = 32;
const MAX_KEYS_CARRIED = 64;
const MAX_ESPM_CACHE = 4096;
const DEFAULT_MAX_CLAIMS = 8;
const DEFAULT_MAX_DISTANCE = 512;
const DECOR_PUSH_INTERVAL_MS = 4000;
const REQUEST_COOLDOWN_MS = 500;

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

// One claimed property. Stored on the primary reference. owner 0 is an
// ownerless stub kept only to carry `serial` forward.
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

// Everything an access decision needs about one actor, read once per sweep.
interface ViewerAccess {
  profileId: number;
  admin: boolean;
  ranks: Array<{ hold: string; rank: string }>;
  keys: Set<string>;
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
    const maxDistance = Number(all?.["housingMaxDistance"]);
    if (Number.isFinite(maxDistance) && maxDistance > 0) this.maxDistance = maxDistance;

    this.roleCfg = readAdminRoleConfig(all);

    this.claimed = this.loadRegistry();
    this.installActivationHook(ctx);
    ctx.gm.on("userAssignActor", (userId: number) => this.onActorAssigned(ctx, userId));
    this.log(`[housing] ready, ${this.claimed.length} claimed refs in the registry`);
  }

  // Locks are enforced here: a refused activation never reaches the door.
  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let allowed = true;
      try {
        allowed = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[housing] activation check failed: ${e}`);
      }
      if (!allowed) return false;
      // Chain, so another handler still gets its say.
      if (!previous) return true;
      try {
        return previous.call(mp, targetId, casterId) !== false;
      } catch {
        return true;
      }
    };
  }

  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const primary = this.primaryOf(ctx, targetId);
    if (!primary) return true;
    const rec = this.read(ctx, primary);
    if (!rec || rec.owner === 0 || !rec.locked) return true;
    if (this.hasAccess(ctx, primary, rec, casterId)) return true;

    // One notice per player per second; a held activate key fires repeatedly.
    const userId = this.userOf(ctx, casterId);
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) > 1000) {
      this.lastDenyMs.set(userId, now);
      this.notice(ctx, userId, rec.name ? `${rec.name} is locked.` : "This is locked.");
    }
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
    this.pushDecorToAll(ctx);
  }

  // A fresh actor needs the full picture: names and locks for every claim.
  private onActorAssigned(ctx: SystemContext, userId: number): void {
    this.pushDecor(ctx, userId);
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  private onInfoRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    if (!target) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    if (!this.withinReach(ctx, actorId, target)) {
      this.notice(ctx, userId, "That is too far away.");
      return;
    }
    this.sendMenu(ctx, userId, actorId, target);
  }

  private onPropertyRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    const action = String(content["action"] || "");
    if (!target || !action) return;

    const now = Date.now();
    if (now - (this.lastRequestMs.get(userId) || 0) < REQUEST_COOLDOWN_MS) return;
    this.lastRequestMs.set(userId, now);

    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    if (!this.withinReach(ctx, actorId, target)) {
      this.notice(ctx, userId, "That is too far away.");
      return;
    }

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
      case "abandon": this.doAbandon(ctx, userId, actorId, primary, rec, isOwner, isManager); break;
      case "revoke": this.doRevoke(ctx, userId, actorId, primary, rec, isManager); break;
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

  private doAbandon(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to give up.");
      return;
    }
    this.release(ctx, primary, rec);
    this.notice(ctx, userId, "Given up.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRevoke(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isManager: boolean): void {
    if (!isManager) {
      this.notice(ctx, userId, "You cannot revoke this.");
      return;
    }
    if (rec.owner === 0) {
      this.notice(ctx, userId, "Nobody owns this.");
      return;
    }
    const formerName = rec.ownerName || "the owner";
    this.release(ctx, primary, rec);
    this.notice(ctx, userId, `Taken back from ${formerName}.`);
    this.sendMenu(ctx, userId, actorId, primary);
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
      this.notice(ctx, userId, "You are carrying too many keys.");
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
    this.reKey(ctx, primary, rec);
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
    this.reKey(ctx, primary, rec);
    rec.owner = recipientProfile;
    rec.ownerName = this.nameOf(ctx, recipientActor);
    rec.partner = this.partnerOf(ctx, primary);
    this.write(ctx, primary, rec);
    this.notice(ctx, userId, `Handed to ${rec.ownerName}.`);
    const recipientUser = this.userOf(ctx, recipientActor);
    this.notice(ctx, recipientUser, rec.name ? `${rec.name} is yours now.` : "You have been given a property.");
  }

  // The menu only offers this on a container, and a container's claim is just
  // its own record, so handing one over is exactly a transfer.
  private doGrantContainer(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
    if (this.baseTypeOf(ctx, primary) !== "CONT") {
      this.notice(ctx, userId, "That is not a container.");
      return;
    }
    this.doTransfer(ctx, userId, primary, rec, isOwner, isManager, rawRecipient);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number, actorId: number, target: number): void {
    const primary = this.primaryOf(ctx, target);
    const rec = primary ? this.read(ctx, primary) : null;
    const owned = !!rec && rec.owner !== 0;
    const profileId = this.profileOf(ctx, actorId);
    const isOwner = owned && rec!.owner === profileId;
    const isManager = !!primary && this.isManager(ctx, actorId, primary);

    let view: string;
    if (isOwner) view = "owner";
    else if (isManager) view = "manager";
    else if (primary && !owned) view = "claimable";
    else view = "denied";

    this.send(ctx, userId, {
      customPacketType: "propertyMenu",
      target: primary || target,
      view,
      owned,
      name: rec ? rec.name : null,
      locked: owned && rec!.locked,
      hasKeys: owned,
      canGrantContainers: (isOwner || isManager) && owned && this.baseTypeOf(ctx, primary) === "CONT",
      ownerName: owned ? (rec!.ownerName || "Someone") : null,
    });
  }

  // ── Access ──────────────────────────────────────────────────────────────────

  private hasAccess(ctx: SystemContext, primary: number, rec: PropertyRecord, actorId: number): boolean {
    return this.hasAccessWith(ctx, primary, rec, this.viewerAccess(ctx, actorId));
  }

  private hasAccessWith(ctx: SystemContext, primary: number, rec: PropertyRecord, v: ViewerAccess): boolean {
    if (rec.owner === 0) return true;
    if (v.profileId && v.profileId === rec.owner) return true;
    if (v.admin) return true;
    const hold = this.holdOf(ctx, primary);
    if (hold && v.ranks.some((r) => r.hold === hold && MANAGER_RANKS.indexOf(r.rank) !== -1)) return true;
    return v.keys.has(this.keyNameOf(primary, rec));
  }

  // One inventory read and one access read per actor, not per claimed ref.
  private viewerAccess(ctx: SystemContext, actorId: number): ViewerAccess {
    const mp = ctx.svr as Mp;
    const keys = new Set<string>();
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      for (const e of entries) {
        if ((Number(e?.baseId) >>> 0) === KEY_BASE_ID && e?.name) keys.add(String(e.name));
      }
    } catch { /* actor gone */ }
    return {
      profileId: this.profileOf(ctx, actorId),
      admin: this.isAdmin(ctx, actorId),
      ranks: this.holdRanks(ctx, actorId),
      keys,
    };
  }

  private isManager(ctx: SystemContext, actorId: number, primary: number): boolean {
    if (this.isAdmin(ctx, actorId)) return true;
    const hold = this.holdOf(ctx, primary);
    if (!hold) return false;
    return this.holdRanks(ctx, actorId).some((r) => r.hold === hold && MANAGER_RANKS.indexOf(r.rank) !== -1);
  }

  // Every admin tier overrides housing claims
  private isAdmin(ctx: SystemContext, actorId: number): boolean {
    return adminTierOf(ctx.svr as Mp, actorId, this.roleCfg) !== null;
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

  // The hold a property answers to. Either half of a teleport pair may be the
  // primary, so check both; only the interior side is in the table.
  private holdOf(ctx: SystemContext, primary: number): string | null {
    const own = HOLD_CELLS[this.cellOf(ctx, primary)];
    if (own) return own;
    const partner = this.partnerOf(ctx, primary);
    return partner ? (HOLD_CELLS[this.cellOf(ctx, partner)] || null) : null;
  }

  // The cell this reference itself stands in.
  private cellOf(ctx: SystemContext, refrId: number): number {
    const mp = ctx.svr as Mp;
    try {
      const desc = mp.get(refrId, "worldOrCellDesc");
      return desc ? (mp.getIdFromDesc(desc) >>> 0) : 0;
    } catch {
      return 0;
    }
  }

  // Claiming has to happen at the door, not from a form id typed into a packet.
  private withinReach(ctx: SystemContext, actorId: number, refrId: number): boolean {
    const mp = ctx.svr as Mp;
    let a: any, b: any;
    try {
      a = mp.get(actorId, "pos");
      b = mp.get(refrId, "pos");
    } catch {
      return true; // position unavailable: do not block a legitimate action
    }
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    const dz = Number(a[2]) - Number(b[2]);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(d2)) return true;
    return d2 <= this.maxDistance * this.maxDistance;
  }

  // ── Keys ────────────────────────────────────────────────────────────────────

  // The credential is the form id plus the serial, never the player-chosen
  // label: a rename must not orphan keys, and no label may forge another
  // property's key. RefDecorService matches this string exactly.
  private keyNameOf(primary: number, rec: PropertyRecord): string {
    const tag = primary.toString(16).toUpperCase();
    return rec.serial > 1 ? `Property Key (${tag}-${rec.serial})` : `Property Key (${tag})`;
  }

  // Pull the current keys from everyone online and move the serial on, so any
  // copy that was missed (offline, in a container) stops matching.
  private reKey(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
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
    rec.serial += 1;
  }

  private giveKey(ctx: SystemContext, actorId: number, keyName: string): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory") || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.slice() : [];
      const carried = entries.filter((e: any) => (Number(e?.baseId) >>> 0) === KEY_BASE_ID).length;
      if (carried >= MAX_KEYS_CARRIED) return false;
      entries.push({ baseId: KEY_BASE_ID, count: 1, name: keyName });
      mp.set(actorId, "inventory", { entries });
      return true;
    } catch (e) {
      this.log(`[housing] could not give key: ${e}`);
      return false;
    }
  }

  // ── refDecor ────────────────────────────────────────────────────────────────

  // `access` is personalized, so each player gets their own view of the set.
  // The record list is built once and reused across every recipient.
  private pushDecorToAll(ctx: SystemContext): void {
    const claims = this.liveClaims(ctx);
    for (const userId of this.onlineUsers(ctx)) this.sendDecor(ctx, userId, claims);
  }

  private pushDecor(ctx: SystemContext, userId: number): void {
    this.sendDecor(ctx, userId, this.liveClaims(ctx));
  }

  private liveClaims(ctx: SystemContext): Array<{ primary: number; rec: PropertyRecord }> {
    const out: Array<{ primary: number; rec: PropertyRecord }> = [];
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (rec && rec.owner !== 0) out.push({ primary, rec });
    }
    return out;
  }

  private sendDecor(ctx: SystemContext, userId: number, claims: Array<{ primary: number; rec: PropertyRecord }>): void {
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const viewer = this.viewerAccess(ctx, actorId);
    const refs: Array<Record<string, unknown>> = [];
    for (const { primary, rec } of claims) {
      const access = this.hasAccessWith(ctx, primary, rec, viewer);
      const keyName = this.keyNameOf(primary, rec);
      refs.push({ refId: primary, name: rec.name, locked: rec.locked, keyName, access });
      if (rec.partner) {
        refs.push({ refId: rec.partner, name: rec.name, locked: rec.locked, keyName, access });
      }
    }
    this.send(ctx, userId, { customPacketType: "refDecor", full: true, refs });
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

    // Nothing stored yet: only doors and containers can become property.
    if (!this.isClaimable(ctx, refrId)) return 0;

    // The pair's primary is the lower of the two ids.
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
      const local = this.readFormIdField(rec, "XTEL");
      if (local && typeof rec.toGlobalRecordId === "function") {
        partner = rec.toGlobalRecordId(local) >>> 0;
      }
    } catch { /* not a door, or no espm record */ }
    this.rememberEspm(this.partnerCache, refrId, partner);
    return partner;
  }

  // "DOOR" / "CONT" / "" - the base object behind a placed reference. Claiming
  // is limited to these two so a stray form id cannot be turned into property.
  private baseTypeOf(ctx: SystemContext, refrId: number): string {
    const cached = this.baseTypeCache.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let type = "";
    try {
      const refr = mp.lookupEspmRecordById(refrId);
      const local = this.readFormIdField(refr, "NAME");
      const baseId = local && typeof refr.toGlobalRecordId === "function" ? refr.toGlobalRecordId(local) >>> 0 : 0;
      if (baseId) {
        const base = mp.lookupEspmRecordById(baseId);
        type = String((base && base.record && base.record.type) || "");
      }
    } catch { /* not an espm reference */ }
    this.rememberEspm(this.baseTypeCache, refrId, type);
    return type;
  }

  private isClaimable(ctx: SystemContext, refrId: number): boolean {
    const t = this.baseTypeOf(ctx, refrId);
    return t === "DOOR" || t === "CONT";
  }

  // First four bytes of a field, little-endian: a plugin-local form id.
  private readFormIdField(lookup: any, fieldType: string): number {
    const fields = lookup && lookup.record && Array.isArray(lookup.record.fields) ? lookup.record.fields : [];
    const field = fields.filter((f: any) => f && f.type === fieldType)[0];
    if (!field || !field.data || field.data.length < 4) return 0;
    const b = field.data;
    return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
  }

  // ESM data never changes, so overflow can just start the cache over.
  private rememberEspm<T>(cache: Map<number, T>, refrId: number, value: T): void {
    if (cache.size >= MAX_ESPM_CACHE) cache.clear();
    cache.set(refrId, value);
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
    } catch (e) {
      this.log(`[housing] write failed for ${primary.toString(16)}: ${e}`);
      return;
    }
    // The index and the pointer are best-effort; the record itself is stored.
    try { mp.set(primary, OWNER_INDEX_PROP, String(rec.owner)); } catch { }
    if (rec.partner) {
      try {
        const pointer: PrimaryPointer = { primary };
        mp.set(rec.partner, HOUSING_PROP, pointer);
      } catch { }
    }
    if (rec.owner !== 0) this.remember(primary); else this.forget(primary);
    this.decorDirty = true;
  }

  // Giving a property up keeps an ownerless stub so the key serial survives;
  // a later claim then cannot mint a credential old copies already answer to.
  private release(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    this.reKey(ctx, primary, rec);
    rec.owner = 0;
    rec.ownerName = "";
    rec.locked = false;
    this.write(ctx, primary, rec);
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
    let raw: string;
    try {
      raw = fs.readFileSync(REGISTRY_FILE, "utf8");
    } catch {
      return []; // first run
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => Number(v) >>> 0).filter((v) => v) : [];
    } catch (e) {
      this.log(`[housing] ${REGISTRY_FILE} is unreadable, starting empty: ${e}`);
      return [];
    }
  }

  // Write through a temp file so an interrupted write cannot truncate the index.
  private saveRegistry(): void {
    const tmp = REGISTRY_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.claimed));
      fs.renameSync(tmp, REGISTRY_FILE);
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
  private baseTypeCache = new Map<number, string>();
  private lastRequestMs = new Map<number, number>();
  private lastDenyMs = new Map<number, number>();
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private maxClaims = DEFAULT_MAX_CLAIMS;
  private maxDistance = DEFAULT_MAX_DISTANCE;
  private decorDirty = false;
  private lastDecorMs = 0;
}
