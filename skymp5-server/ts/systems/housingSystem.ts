import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { espmRefrFieldId, toFormId } from "./formIdUtil";
import { AdminRoleConfig, readAdminRoleConfig, adminTierOf } from "./adminRoles";
import { writeFileAtomic } from "./fileUtil";
import { addItemTo, guardMpHook, holdsItem, isIntroduced, onlineActors, takeItemFrom } from "./actorUtil";
import { FactionDef, factionLand, holdRanksOf, managesHold } from "./factionRules";
import { Hold, holdName, holdOfRefs, isHoldLand, isOutdoors, loadHolds } from "./holdOf";
import { describeActor, profileIdOf, realNameOf, sendJson, titledName } from "./playerText";
import { adminAudit } from "./discordAlerts";
import { WRITING_ID } from "./writingStore";
import { soon } from "./timers";
import { onlineSnapshot } from "./onlineSnapshot";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Housing: claims, locks and keys ───────────────────────────────────────────
//
// Players claim any unowned door or container they are standing at by pressing
// the housing key. Owners lock it, name it, cut keys, hand ownership over, or
// give it up. A locked property refuses activation for everyone, owner included,
// until the owner, an admin or a key holder unlocks it from the menu. A door
// between a worldspace and an interior has two locks: the entrance refuses
// whoever uses its outdoor half, the exit whoever uses its indoor half. Any
// other door and every container has one lock that shuts both ways.
// RefDecorService mirrors each half's lock into the engine as a Master lock so
// every player sees a locked door.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "propertyInfoRequest", target: <refrId> }
//     { customPacketType: "propertyRequest", action, target, recipient?, name?, id?, faction? }
//       action: claim | claimfaction (faction: the id) | abandon | lock | unlock (both locks) | lockentrance | unlockentrance
//             | lockexit | unlockexit | rename | transfer
//             | breaklock (revoke from older clients) | createkey | revokekeys | grantcontainer
//             | pinnote (id: the letter) | takenote | knock
//   Server -> Client:
//     { customPacketType: "propertyMenu", target, view, owned, name, locked (either lock),
//       lockedEntrance, lockedExit, sides, canLock, hasKeys, canGrantContainers, ownerName, pets, hold,
//       note: null | { title, text, byline, signFaction, brokenSeals, mine, canTakeDown }, letters: [{ id, title }], canKnock,
//       faction: null | { id, name, role: "manager" | "member" | "" }, claimFactions: [{ id, name }] }
//     { customPacketType: "propertyNotice", text }
//     { customPacketType: "refDecor", full?, refs: [{refId,name,locked}] }
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
// form ids (the "primary"); the far side stores a pointer to it, so a house is
// managed from either side.
//
// Holds. A property lies in the hold its door's location belongs to (holdOf.ts: the cell's location walked up to the
// LocTypeHold one, either half of a teleport pair). Ranks that manage hold property (Jarl and Steward by default) manage
// only the claims inside their own court's hold, and only while standing inside it; admins manage every claim.
//
// Door notes. A written, unsealed letter can be pinned to one half of a claimed door that is no faction's, one note per
// half. The letter leaves the pinner's pack and the half stores only `private.doorNote` { id, by, byProfile, byName, at };
// the text stays in the writing store. Everyone who opens the menu at that half reads it; the poster (same account and
// character), the owner, a key holder or an admin takes it down into their own pack, and on an unclaimed door only the
// poster or an admin. The server acts on the half the user last opened the menu at, never on an id from the packet.
//
// Knocking. Every viewer of a door, strangers and faction outsiders included, may knock once per KNOCK_COOLDOWN_MS; every
// player within say range (chatRanges.say) of either half reads the notice "<name> knocks on the door." ("Someone" to
// listeners the knocker is not introduced to), the same propertyNotice every other housing line uses.
//
// Faction claims. A member whose rank manages property (the rank's housing flag, a leader or an acting regent) claims an
// unclaimed door or container for the faction with a lock, or hands their own claim to it. The record keeps owner
// FACTION_OWNER and the faction id in `faction`, so it stays the faction's whoever leads or leaves. Ranks with the door
// flag (factionAccess) lock and unlock it and take notes down as a key holder does; managing ranks also rename it, cut and
// void keys, transfer it to a player and give it up. A court claims only inside its own hold and its ranks act on the
// claim only while standing in that hold. Hold officials and admins manage faction claims like any other.

const HOUSING_PROP = "private.housing";
const NOTE_PROP = "private.doorNote";
// Neighbour-visible marker on a half with a note (50_properties.js registers it); clients add a scroll to its prompt
const NOTE_MARK_PROP = "ff_doorNote";
const OWNER_INDEX_PROP = "private.indexed.housingOwner";
const REGISTRY_FILE = "./housing.json";

// Vanilla key form; the name extra carries the credential.
export const KEY_BASE_ID = 0x000db0e2;
// Label of every key cut before keys were named, and of a cut from a client that sends no name
const DEFAULT_KEY_LABEL = "Property Key";
// The bracketed suffix of a key's name: TAG or TAG-serial, optionally /cut
const KEY_CREDENTIAL = /\(([0-9A-F]+(?:-\d+)?)(?:\/\d+)?\)$/;
// A key cut before the cut number existed: TAG or TAG-serial only
const UNCUT_KEY = /^Property Key \(([0-9A-F]+)(?:-\d+)?\)$/;
// HearthFires BYOHMaterialLock; a claim uses one up, admins included. Locking and unlocking are free.
const LOCK_DESC = "3012:HearthFires.esm";
const LOCK_BASE_ID_FALLBACK = 0x03003012;

const MAX_NAME_LEN = 32;
const MAX_KEYS_CARRIED = 64;
const MAX_ESPM_CACHE = 4096;
const DEFAULT_MAX_DISTANCE = 512;
const REQUEST_COOLDOWN_MS = 500;
const KNOCK_COOLDOWN_MS = 10000;
// The chat's say range in game units when server-settings chatRanges.say is not set
const DEFAULT_SAY_RANGE = 2000;
// Set by FactionSystem while Show Title is on
const TITLE_PROP = "ff_factionTitle";
// What a hold official may do to someone else's claim
const MANAGER_ACTIONS = new Set(["abandon", "breaklock", "revoke", "rename", "revokekeys", "transfer", "grantcontainer"]);
// What only the owner, or a faction claim's managing ranks, may do
const OWNER_ACTIONS = new Set(["abandon", "rename", "revokekeys", "transfer", "grantcontainer", "createkey"]);
// The owner of a faction claim; the faction id is in the record's `faction`
const FACTION_OWNER = -1;
const CHANGE_FAILED = "That cannot be changed right now.";
const NAME_REFUSED = "That name will not do. Use letters, numbers, spaces, ' _ and - only.";

// The half of a door someone uses: outdoors or indoors of a worldspace-to-interior pair, "" for a property with one lock
type DoorSide = "outside" | "inside" | "";
const LOCK_OF_SIDE: Record<DoorSide, string> = { outside: "entrance", inside: "exit", "": "lock" };
// False: the exit of a door with two halves is never locked, a lock only keeps people out; true brings Lock Exit back
const EXIT_LOCKS = false;

// One claimed property. Stored on the primary reference. owner 0 is an
// ownerless stub kept only to carry `serial` forward.
interface PropertyRecord {
  owner: number;
  ownerName: string;
  name: string | null;
  lockedEntrance: boolean;
  lockedExit: boolean;
  serial: number;
  cut: number;
  partner: number;
  containers: number[];
  // The owning faction's id when owner is FACTION_OWNER, "" on a personal claim
  faction: string;
}

// One of an actor's factions, and whether its rank uses (door access) and manages (property) the faction's claims
export interface FactionRight {
  id: string;
  name: string;
  use: boolean;
  manage: boolean;
}

// An actor's standing on a faction claim; refusal is the border notice of a court rank outside its hold
interface FactionStanding {
  role: "manager" | "member" | "";
  refusal: string;
}

const NO_STANDING: FactionStanding = { role: "", refusal: "" };

// As stored: "locked" is either lock, the one flag builds before the entrance and exit read
type StoredRecord = PropertyRecord & { locked: boolean };

// The far half of a teleport pair just points at the primary.
interface PrimaryPointer {
  primary: number;
}

// Everything an access decision needs about one actor.
interface ViewerAccess {
  profileId: number;
  admin: boolean;
  keys: Set<string>;
}

// A letter pinned to one door reference; its text stays in the writing store
interface DoorNote {
  id: string;
  by: number;
  byProfile: number;
  byName: string;
  at: number;
}

// Why a pinned letter can no longer be read
type NoteGone = "missing" | "destroyed";

// What a door note needs from WritingSystem
export interface DoorNoteWritings {
  available(): boolean;
  lettersOf(mp: Mp, actorId: number): Array<{ id: string; title: string }>;
  takeLetterToPin(mp: Mp, userId: number, actorId: number, id: string): { id: string; title: string } | null;
  returnPinnedLetter(mp: Mp, actorId: number, id: string): "given" | "failed" | NoteGone;
  pinnedNoteView(mp: Mp, viewerId: number, id: string): { title: string } | NoteGone | null;
  logDoorNote(text: string): void;
}

const emptyRecord = (): PropertyRecord => ({
  owner: 0, ownerName: "", name: null, lockedEntrance: false, lockedExit: false,
  serial: 1, cut: 0, partner: 0, containers: [], faction: "",
});

const keyCredentialIn = (name: unknown): string => {
  const m = typeof name === "string" ? KEY_CREDENTIAL.exec(name) : null;
  return m ? m[1] : "";
};

export class HousingSystem implements System {
  systemName = "HousingSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const maxDistance = Number(all?.["housingMaxDistance"]);
    if (Number.isFinite(maxDistance) && maxDistance > 0) this.maxDistance = maxDistance;
    const sayRange = Number((all?.["chatRanges"] as Record<string, unknown> | undefined)?.["say"]);
    if (Number.isFinite(sayRange) && sayRange > 0) this.sayRange = sayRange;

    this.roleCfg = readAdminRoleConfig(all);
    this.keySplitOnLogin = all?.["keySplitOnLogin"] === true;
    try { this.lockBaseId = ((ctx.svr as Mp).getIdFromDesc(LOCK_DESC) >>> 0) || LOCK_BASE_ID_FALLBACK; } catch { }

    this.claimed = this.loadRegistry();
    await loadHolds(ctx.svr as Mp, s.dataDir, s.loadOrder, this.log);
    this.installActivationHook(ctx);
    ctx.gm.on("userAssignActor", (userId: number) => this.onActorAssigned(ctx, userId));
    this.log(`[housing] ready, ${this.claimed.length} claimed refs in the registry, uncut key stacks ${this.keySplitOnLogin ? "split" : "kept"} at login`);
  }

  // Locks are enforced here: a refused activation never reaches the door.
  private installActivationHook(ctx: SystemContext): void {
    guardMpHook(ctx.svr as Mp, "onActivate", (targetId: number, casterId: number) => {
      try {
        if (!this.onActivate(ctx, targetId >>> 0, casterId >>> 0)) return false;
      } catch (e) {
        this.log(`[housing] activation check failed: ${e}`);
      }
    });
  }

  // Faction doors and containers refuse outsiders; a shut lock on the half used is shut for everyone, access only lets a player unlock it from the menu
  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const faction = this.factionGate ? this.factionGate(casterId, targetId, "faction door") : null;
    if (faction && !faction.allowed && !this.isAdmin(ctx, casterId)) {
      const userId = this.userOf(ctx, casterId);
      if (!this.firstDenial(userId)) return false;
      this.notice(ctx, userId, faction.refusal || `Only ${faction.name} may use this.`);
      if (!faction.refusal) this.log(`[housing] ${targetId.toString(16)} denied to ${this.who(ctx, casterId)}: belongs to ${faction.name}`);
      return false;
    }
    const primary = this.primaryOf(ctx, targetId);
    if (!primary) return true;
    const rec = this.read(ctx, primary);
    if (!rec || rec.owner === 0) return true;
    // The native side refuses a caster outside the door's cell, so the half pressed is the half the caster stands at
    const side = this.sideOf(ctx, primary, rec, targetId);
    if (!this.lockedAt(rec, side)) return true;

    const userId = this.userOf(ctx, casterId);
    if (!this.firstDenial(userId)) return false;
    const role = this.accessRole(ctx, primary, rec, casterId);
    const lock = LOCK_OF_SIDE[side];
    const text = side ? `The ${lock} of ${rec.name || "this property"} is locked.` : `${rec.name || "This"} is locked.`;
    this.notice(ctx, userId, role ? `${text} Unlock it from the housing menu.` : text);
    this.log(`[housing] door ${targetId.toString(16)} of ${this.claimLabel(primary, rec)} denied to ${this.who(ctx, casterId)}: ${side ? `${lock} locked (${side})` : "locked"}${role ? `, may unlock as ${role}` : ""}`);
    return false;
  }

  // One notice and log line per player per second; a held activate key fires repeatedly.
  private firstDenial(userId: number): boolean {
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) <= 1000) return false;
    this.lastDenyMs.set(userId, now);
    return true;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "propertyInfoRequest": this.withFreshRanks(userId, () => this.onInfoRequest(ctx, userId, content), true); break;
      case "propertyRequest": this.withFreshRanks(userId, () => this.onPropertyRequest(ctx, userId, content), this.touchesFactionClaim(ctx, content)); break;
      default: break;
    }
  }

  // Ranks change on the dashboard without a relog, so a menu and any request on a faction claim wait for fresh ones
  private withFreshRanks(userId: number, job: () => void, needed: boolean): void {
    if (needed && this.factionFresh) this.factionFresh(userId, job);
    else job();
  }

  private touchesFactionClaim(ctx: SystemContext, content: Content): boolean {
    if (content["action"] === "claimfaction") return true;
    const target = toFormId(content["target"]);
    const primary = target ? this.primaryOf(ctx, target) : 0;
    return !!primary && !!this.read(ctx, primary)?.faction;
  }

  // A fresh actor needs the full picture: names and locks for every claim.
  private onActorAssigned(ctx: SystemContext, userId: number): void {
    this.menuDoors.delete(userId);
    if (!this.notesMarked) this.markPinnedNotes(ctx);
    this.pushDecor(ctx, userId);
    const actorId = this.actorOf(ctx, userId);
    if (actorId && this.keySplitOnLogin) this.splitUncutKeys(ctx, actorId);
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  private onInfoRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    if (!target) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    if (!this.withinReach(ctx, actorId, target)) {
      this.refuse(ctx, userId, actorId, "menu", target, "That is too far away.");
      return;
    }
    this.menuDoors.set(userId, target);
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
    if (!this.nearProperty(ctx, actorId, target)) {
      this.refuse(ctx, userId, actorId, action, target, "That is too far away.");
      return;
    }

    const primary = this.primaryOf(ctx, target);
    if (!primary) {
      this.refuse(ctx, userId, actorId, action, target, "You cannot claim that.");
      return;
    }
    const rec = this.read(ctx, primary) || emptyRecord();
    const standing = this.factionStanding(ctx, actorId, rec, OWNER_ACTIONS.has(action) ? `faction property ${action}` : "");
    const isOwner = this.ownsClaim(ctx, actorId, rec, standing);
    const asManager = !isOwner && MANAGER_ACTIONS.has(action);
    const managing = this.managerRefusal(ctx, actorId, primary, asManager ? action : "");
    if (managing && asManager) {
      this.notice(ctx, userId, managing);
      return;
    }
    const isManager = managing === "";
    if (standing.refusal && !isOwner && !isManager && OWNER_ACTIONS.has(action)) {
      this.refuse(ctx, userId, actorId, action, primary, standing.refusal);
      return;
    }

    switch (action) {
      case "claim": this.doClaim(ctx, userId, actorId, primary, rec, ""); break;
      case "claimfaction": this.doClaim(ctx, userId, actorId, primary, rec, String(content["faction"] ?? "").slice(0, 64) || "?"); break;
      case "abandon": this.doAbandon(ctx, userId, actorId, primary, rec, isOwner, isManager); break;
      case "breaklock":
      case "revoke": this.doBreakLock(ctx, userId, actorId, primary, rec, isManager); break;
      case "lock": this.doLock(ctx, userId, actorId, primary, rec, "", true); break;
      case "unlock": this.doLock(ctx, userId, actorId, primary, rec, "", false); break;
      case "lockentrance": this.doLock(ctx, userId, actorId, primary, rec, "outside", true); break;
      case "unlockentrance": this.doLock(ctx, userId, actorId, primary, rec, "outside", false); break;
      case "lockexit": this.doLock(ctx, userId, actorId, primary, rec, "inside", true); break;
      case "unlockexit": this.doLock(ctx, userId, actorId, primary, rec, "inside", false); break;
      case "rename": this.doRename(ctx, userId, actorId, primary, rec, isOwner, isManager, content["name"]); break;
      case "createkey": this.doCreateKey(ctx, userId, actorId, primary, rec, isOwner, content["name"]); break;
      case "revokekeys": this.doRevokeKeys(ctx, userId, actorId, primary, rec, isOwner, isManager); break;
      case "transfer": this.doTransfer(ctx, userId, actorId, primary, rec, isOwner, isManager, content["recipient"]); break;
      case "grantcontainer": this.doGrantContainer(ctx, userId, actorId, primary, rec, isOwner, isManager, content["recipient"]); break;
      case "pinnote": this.doPinNote(ctx, userId, actorId, primary, rec, content["id"]); break;
      case "takenote": this.doTakeNote(ctx, userId, actorId, primary, rec); break;
      case "knock": this.doKnock(ctx, userId, actorId, primary, rec); break;
      default: break;
    }
  }

  // A personal claim, or with a faction id one for that faction; the owner of a personal claim hands it to the faction without a lock
  private doClaim(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, factionId: string): void {
    const faction = this.factionGate ? this.factionGate(actorId, primary) : null;
    if (faction) {
      this.notice(ctx, userId, `This belongs to ${faction.name}.`);
      return;
    }
    let right: FactionRight | null = null;
    if (factionId) {
      right = this.factionRightsOf(actorId).find((f) => f.id === factionId) || null;
      const refusal = right ? this.factionClaimRefusal(ctx, actorId, primary, right, "faction claim") : "You do not belong to that faction.";
      if (refusal) {
        this.refuse(ctx, userId, actorId, "claimfaction", primary, refusal);
        return;
      }
      if (rec.owner !== 0 && !rec.faction && rec.owner === this.profileOf(ctx, actorId)) {
        this.handToFaction(ctx, userId, actorId, primary, rec, right!);
        return;
      }
    }
    if (rec.owner !== 0) {
      this.notice(ctx, userId, "Somebody already owns this.");
      return;
    }
    const mp = ctx.svr as Mp;
    if (!holdsItem(mp, actorId, (id) => id === this.lockBaseId)) {
      this.notice(ctx, userId, "You need a lock to claim this.");
      return;
    }
    const profileId = this.profileOf(ctx, actorId);
    if (!profileId) {
      this.notice(ctx, userId, "You cannot claim anything right now.");
      return;
    }
    // The lock goes first, so a failed inventory write never claims for free
    if (!takeItemFrom(mp, actorId, this.lockBaseId, 1)) {
      this.notice(ctx, userId, CHANGE_FAILED);
      this.log(`[housing] claim ${primary.toString(16)} by ${this.who(ctx, actorId)} refused: the lock could not be taken`);
      return;
    }
    rec.owner = right ? FACTION_OWNER : profileId;
    rec.faction = right ? right.id : "";
    rec.ownerName = right ? right.name : this.nameOf(ctx, actorId);
    rec.partner = this.partnerOf(ctx, primary);
    if (!this.commit(ctx, userId, primary, rec)) {
      try { addItemTo(mp, actorId, this.lockBaseId, 1); } catch (e) { this.log(`[housing] could not hand the lock back to ${this.who(ctx, actorId)}: ${e}`); }
      return;
    }
    this.log(`[housing] lock spent by ${this.who(ctx, actorId)} on ${this.claimLabel(primary, rec)}${right ? ` (${right.name}), claimed as faction manager` : ""}`);
    this.notice(ctx, userId, right ? `This belongs to ${right.name} now. The lock is fitted.` : "This is yours now. The lock is fitted.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // Old keys stop fitting, as on any change of owner
  private handToFaction(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, right: FactionRight): void {
    this.reKey(ctx, primary, rec);
    rec.owner = FACTION_OWNER;
    rec.faction = right.id;
    rec.ownerName = right.name;
    rec.partner = this.partnerOf(ctx, primary);
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.log(`[housing] ${this.claimLabel(primary, rec)} (${right.name}) handed to the faction by its owner ${this.who(ctx, actorId)}`);
    this.notice(ctx, userId, `${rec.name || "This"} belongs to ${right.name} now. Old keys no longer fit.`);
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doAbandon(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to give up.");
      return;
    }
    const claim = this.claimLabel(primary, rec);
    const role = this.managedAs(rec, isOwner);
    if (!this.release(ctx, primary, rec)) {
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    this.log(`[housing] ${claim} given up by ${this.who(ctx, actorId)} as ${role}`);
    this.notice(ctx, userId, "Given up.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // The owner and every key holder lose it, the keys are voided and the door is unlocked and claimable again
  private doBreakLock(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isManager: boolean): void {
    if (!isManager) {
      this.refuse(ctx, userId, actorId, "breaklock", primary, "Only an admin or this territory's Jarl or Steward may break this lock.");
      return;
    }
    if (rec.owner === 0) {
      this.notice(ctx, userId, "Nobody owns this.");
      return;
    }
    const former = { ...rec };
    const ownerName = this.ownerNameOf(rec);
    const claim = this.claimLabel(primary, rec);
    if (!this.release(ctx, primary, rec)) {
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    this.log(`[housing] lock broken by ${this.who(ctx, actorId)} on ${claim} (${this.holdOf(ctx, primary)?.name ?? "no hold"})`);
    this.notice(ctx, userId, "The lock is broken. Anyone may claim it now.");
    this.noticeOwners(ctx, former, former.faction
      ? `The lock on ${former.name || `a property of ${ownerName}`} was broken. It no longer belongs to ${ownerName}.`
      : `The lock on ${former.name || "one of your properties"} was broken. It is no longer yours.`);
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // The lock of one half, or with side "" both; a property with one lock always turns both
  private doLock(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, side: DoorSide, locked: boolean): void {
    const action = `${locked ? "lock" : "unlock"}${side ? LOCK_OF_SIDE[side] : ""}`;
    if (!EXIT_LOCKS && side === "inside") {
      this.refuse(ctx, userId, actorId, action, primary, "An exit is never locked. Lock the entrance to keep people out.");
      return;
    }
    if (rec.owner === 0) {
      this.refuse(ctx, userId, actorId, action, primary, "Claim it first.");
      return;
    }
    const role = this.accessRole(ctx, primary, rec, actorId);
    if (!role) {
      this.refuse(ctx, userId, actorId, action, primary, this.factionStanding(ctx, actorId, rec, `faction property ${action}`).refusal || "You have no key to this.");
      return;
    }
    const sided = this.hasSides(ctx, primary, rec);
    const which: DoorSide = sided ? side : "";
    if (which !== "inside") rec.lockedEntrance = locked;
    if (which !== "outside") rec.lockedExit = locked;
    if (!this.commit(ctx, userId, primary, rec)) return;
    const state = locked ? "locked" : "unlocked";
    const what = !sided ? "" : which ? `${LOCK_OF_SIDE[which]} ` : "entrance and exit ";
    this.log(`[housing] ${this.claimLabel(primary, rec)} ${what}${state} by ${this.who(ctx, actorId)} as ${role}`);
    this.notice(ctx, userId, which ? `${which === "outside" ? "Entrance" : "Exit"} ${state}.` : locked ? "Locked." : "Unlocked.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRename(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, raw: unknown): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to name.");
      return;
    }
    const name = this.cleanName(raw);
    if (!name) {
      this.notice(ctx, userId, NAME_REFUSED);
      return;
    }
    const claim = this.claimLabel(primary, rec);
    rec.name = name;
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.log(`[housing] ${claim} renamed "${name}" by ${this.who(ctx, actorId)} as ${this.managedAs(rec, isOwner)}`);
    this.notice(ctx, userId, `Now called ${name}.`);
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // Keys are real inventory items; the name extra is the credential, so a key
  // handed over in trade works immediately and needs no server bookkeeping.
  private doCreateKey(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, raw: unknown): void {
    if (!isOwner) {
      this.notice(ctx, userId, "Only the owner cuts keys.");
      return;
    }
    const label = typeof raw === "string" ? this.cleanName(raw) : DEFAULT_KEY_LABEL;
    if (!label) {
      this.notice(ctx, userId, NAME_REFUSED);
      return;
    }
    // The counter is stored before the key exists so no two cuts ever share a name
    rec.cut += 1;
    if (!this.commit(ctx, userId, primary, rec)) return;
    const keyName = this.keyNameOf(primary, rec, label);
    if (!this.giveKey(ctx, actorId, keyName)) {
      this.notice(ctx, userId, "You are carrying too many keys.");
      return;
    }
    if (rec.faction) this.log(`[housing] ${keyName} cut for ${this.claimLabel(primary, rec)} by ${this.who(ctx, actorId)} as faction manager`);
    this.notice(ctx, userId, `${keyName} is in your pack.`);
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRevokeKeys(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to re-key.");
      return;
    }
    this.reKey(ctx, primary, rec);
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.log(`[housing] keys of ${this.claimLabel(primary, rec)} voided by ${this.who(ctx, actorId)} as ${this.managedAs(rec, isOwner)}`);
    this.notice(ctx, userId, "Every key turned to scrap.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doTransfer(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
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
    if (!rec.faction && recipientProfile === rec.owner) {
      this.notice(ctx, userId, "They already own it.");
      return;
    }
    const claim = this.claimLabel(primary, rec);
    const role = this.managedAs(rec, isOwner);
    // Old keys must not open a new owner's door.
    this.reKey(ctx, primary, rec);
    rec.owner = recipientProfile;
    rec.faction = "";
    rec.ownerName = this.nameOf(ctx, recipientActor);
    rec.partner = this.partnerOf(ctx, primary);
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.log(`[housing] ${claim} transferred to ${this.who(ctx, recipientActor)} by ${this.who(ctx, actorId)} as ${role}`);
    this.notice(ctx, userId, `Handed to ${rec.ownerName}.`);
    const recipientUser = this.userOf(ctx, recipientActor);
    this.notice(ctx, recipientUser, rec.name ? `${rec.name} is yours now.` : "You have been given a property.");
  }

  // The menu only offers this on a container, and a container's claim is just
  // its own record, so handing one over is exactly a transfer.
  private doGrantContainer(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
    if (this.baseTypeOf(ctx, primary) !== "CONT") {
      this.notice(ctx, userId, "That is not a container.");
      return;
    }
    this.doTransfer(ctx, userId, actorId, primary, rec, isOwner, isManager, rawRecipient);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number, actorId: number, target: number): void {
    const primary = this.primaryOf(ctx, target);
    const door = (primary && this.menuDoor(ctx, userId, primary)) || target;
    const canKnock = !!primary && this.baseTypeOf(ctx, door) === "DOOR";
    const faction = this.factionGate ? this.factionGate(actorId, target) : null;
    if (faction && !this.isAdmin(ctx, actorId)) {
      this.send(ctx, userId, {
        customPacketType: "propertyMenu", target, view: "denied", owned: true, name: null, locked: false,
        canLock: false, hasKeys: false, canGrantContainers: false, ownerName: faction.name, pets: "", canKnock,
      });
      return;
    }
    const rec = primary ? this.read(ctx, primary) : null;
    const owned = !!rec && rec.owner !== 0;
    const standing = owned ? this.factionStanding(ctx, actorId, rec!) : NO_STANDING;
    const isOwner = owned && this.ownsClaim(ctx, actorId, rec!, standing);
    // Claimable for a faction while unclaimed, and the owner of a personal claim may hand it to one
    const offersFactions = !!primary && (!owned || (!rec!.faction && isOwner));
    const claimFactions = offersFactions ? this.claimFactionsAt(ctx, actorId, primary).map((f) => ({ id: f.id, name: f.name })) : [];
    // An official outside the hold still gets the manager view, and each action tells them why it is refused
    const isManager = !!primary && this.managerRefusal(ctx, actorId, primary) !== null;
    const canLock = owned && this.hasAccess(ctx, primary, rec!, actorId);
    const holdsKey = canLock && !isOwner && !isManager;
    const lockedEntrance = owned && rec!.lockedEntrance;
    const sidedMenu = owned && this.hasSides(ctx, primary, rec!);
    const lockedExit = owned && rec!.lockedExit && (EXIT_LOCKS || !sidedMenu);

    let view: string;
    if (isOwner) view = "owner";
    else if (isManager) view = "manager";
    else if (holdsKey) view = "keyholder";
    else if (primary && !owned) view = "claimable";
    else view = "denied";

    this.send(ctx, userId, {
      customPacketType: "propertyMenu",
      target: primary || target,
      view,
      owned,
      name: rec ? rec.name : null,
      locked: lockedEntrance || lockedExit,
      lockedEntrance,
      lockedExit,
      sides: owned && this.hasSides(ctx, primary, rec!),
      canLock,
      hasKeys: owned,
      canGrantContainers: (isOwner || isManager) && owned && this.baseTypeOf(ctx, primary) === "CONT",
      ownerName: owned ? this.ownerNameOf(rec!) : null,
      pets: this.petCategoryOf ? this.petCategoryOf(actorId, primary || target) : "",
      hold: primary ? (this.holdOf(ctx, primary)?.name ?? "") : "",
      note: primary ? this.noteFor(ctx, actorId, door, primary, rec || emptyRecord()) : null,
      letters: owned && this.canPinAt(ctx, actorId, door) ? this.writings!.lettersOf(ctx.svr, actorId) : [],
      canKnock,
      faction: owned && rec!.faction ? { id: rec!.faction, name: this.ownerNameOf(rec!), role: standing.role } : null,
      claimFactions,
    });
  }

  // ── Door notes ──────────────────────────────────────────────────────────────

  // Set by WritingSystem: carried letters, pinning, returning and reading them
  writings: DoorNoteWritings | null = null;

  // The half this user last opened the menu at, when it belongs to this property
  private menuDoor(ctx: SystemContext, userId: number, primary: number): number {
    const door = this.menuDoors.get(userId) || 0;
    return door && this.primaryOf(ctx, door) === primary ? door : 0;
  }

  // The remembered half, refused when there is none or the actor walked off
  private menuDoorInReach(ctx: SystemContext, userId: number, actorId: number, primary: number, action: string): number {
    const door = this.menuDoor(ctx, userId, primary);
    if (!door) {
      this.refuse(ctx, userId, actorId, action, primary, "Open the housing menu at the door first.");
      return 0;
    }
    if (!this.withinReach(ctx, actorId, door)) {
      this.refuse(ctx, userId, actorId, action, door, "That is too far away.");
      return 0;
    }
    return door;
  }

  private readNote(ctx: SystemContext, door: number): DoorNote | null {
    let raw: any = null;
    try { raw = (ctx.svr as Mp).get(door, NOTE_PROP); } catch { return null; }
    if (!raw || typeof raw !== "object" || !WRITING_ID.test(String(raw.id))) return null;
    const byProfile = Number(raw.byProfile);
    return {
      id: String(raw.id),
      by: Number(raw.by) >>> 0,
      byProfile: Number.isInteger(byProfile) ? byProfile : -1,
      byName: String(raw.byName || "").slice(0, 100),
      at: Number(raw.at) || 0,
    };
  }

  // null clears the note
  private writeNote(ctx: SystemContext, door: number, note: DoorNote | null): boolean {
    try {
      (ctx.svr as Mp).set(door, NOTE_PROP, note);
    } catch (e) {
      this.log(`[housing] note write failed for door ${door.toString(16)}: ${e}`);
      return false;
    }
    this.markNote(ctx, door, !!note);
    return true;
  }

  private markNote(ctx: SystemContext, door: number, pinned: boolean): boolean {
    try {
      (ctx.svr as Mp).set(door, NOTE_MARK_PROP, pinned ? true : null);
      return true;
    } catch (e) {
      if (!this.noteMarkWarned) this.log(`[housing] door note markers are off, ${NOTE_MARK_PROP} could not be set (register it in 50_properties.js and run Build gamemode): ${e}`);
      this.noteMarkWarned = true;
      return false;
    }
  }

  // Notes pinned before the marker existed get it once the gamemode has registered the property, at the first login
  private markPinnedNotes(ctx: SystemContext): void {
    this.notesMarked = true;
    let marked = 0;
    for (const { primary, rec } of this.liveClaims(ctx)) {
      for (const door of rec.partner ? [primary, rec.partner] : [primary]) {
        if (this.readNote(ctx, door) && this.markNote(ctx, door, true)) marked++;
      }
    }
    this.log(`[housing] door note markers: ${marked} pinned notes on claimed doors marked for clients`);
  }

  // A door that is no faction's with no note on this half; the caller checks the claim
  private canPinAt(ctx: SystemContext, actorId: number, door: number): boolean {
    return !!this.writings && this.writings.available() && this.baseTypeOf(ctx, door) === "DOOR"
      && !(this.factionGate && this.factionGate(actorId, door)) && !this.readNote(ctx, door);
  }

  // The same account and the same character, so a reused actor id of another account never matches
  private isNotePoster(ctx: SystemContext, note: DoorNote, actorId: number): boolean {
    return note.byProfile >= 0 && note.byProfile === profileIdOf(ctx.svr, actorId) && note.by === actorId;
  }

  // "" when this actor may not take the note down
  private noteTakerRole(ctx: SystemContext, primary: number, rec: PropertyRecord, note: DoorNote, actorId: number): string {
    if (this.isNotePoster(ctx, note, actorId)) return "poster";
    if (rec.owner === 0) return this.isAdmin(ctx, actorId) ? "admin" : "";
    return this.accessRole(ctx, primary, rec, actorId);
  }

  // The note on this half as the viewer reads it; one whose document is gone is cleared here
  private noteFor(ctx: SystemContext, actorId: number, door: number, primary: number, rec: PropertyRecord): Record<string, unknown> | null {
    const note = this.writings ? this.readNote(ctx, door) : null;
    if (!note) return null;
    const view = this.writings!.pinnedNoteView(ctx.svr, actorId, note.id);
    if (!view) return null;
    if (typeof view === "string") {
      this.crumble(ctx, door, note, view);
      return null;
    }
    return { ...view, mine: this.isNotePoster(ctx, note, actorId), canTakeDown: this.noteTakerRole(ctx, primary, rec, note, actorId) !== "" };
  }

  private crumble(ctx: SystemContext, door: number, note: DoorNote, reason: NoteGone): void {
    this.writeNote(ctx, door, null);
    const line = `letter ${note.id} pinned to door ${door.toString(16)} crumbled: its document is ${reason}`;
    this.writings?.logDoorNote(line);
    this.log(`[housing] ${line}`);
  }

  private doorLabel(ctx: SystemContext, primary: number, rec: PropertyRecord, door: number, withClaim = true): string {
    const side = this.sideOf(ctx, primary, rec.partner ? rec : { ...rec, partner: this.partnerOf(ctx, primary) }, door);
    return `door ${door.toString(16)}${side ? ` (${side})` : ""}${withClaim && rec.owner !== 0 ? ` of ${this.claimLabel(primary, rec)}` : ""}`;
  }

  private doPinNote(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, rawId: unknown): void {
    const door = this.menuDoorInReach(ctx, userId, actorId, primary, "pinnote");
    const id = String(rawId ?? "");
    if (!door || !WRITING_ID.test(id) || !this.writings) return;
    const faction = this.factionGate ? this.factionGate(actorId, door) : null;
    let refusal = "";
    if (this.baseTypeOf(ctx, door) !== "DOOR") refusal = "Notes can only be pinned to doors.";
    else if (rec.owner === 0) refusal = "Only a claimed door takes a note.";
    else if (faction) refusal = `This belongs to ${faction.name}.`;
    else if (!this.writings.available()) refusal = "Writing is not available yet.";
    if (refusal) {
      this.refuse(ctx, userId, actorId, "pinnote", door, refusal);
      return;
    }
    // Checked before anything is taken, so a second letter stays in the pack
    const there = this.readNote(ctx, door);
    if (there) {
      const view = this.writings.pinnedNoteView(ctx.svr, actorId, there.id);
      if (typeof view !== "string") {
        this.refuse(ctx, userId, actorId, "pinnote", door, "A note is already pinned here.");
        return;
      }
      this.crumble(ctx, door, there, view);
    }
    const taken = this.writings.takeLetterToPin(ctx.svr, userId, actorId, id);
    if (!taken) return;
    const note: DoorNote = { id, by: actorId, byProfile: profileIdOf(ctx.svr, actorId), byName: realNameOf(ctx.svr, actorId).slice(0, 100), at: Date.now() };
    const where = this.doorLabel(ctx, primary, rec, door);
    if (!this.writeNote(ctx, door, note)) {
      const back = this.writings.returnPinnedLetter(ctx.svr, actorId, id);
      this.log(`[housing] note ${id} could not be pinned to ${where} by ${this.who(ctx, actorId)}, letter ${back === "given" ? "given back" : `not given back (${back})`}`);
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    this.writings.logDoorNote(`${describeActor(ctx.svr, actorId)} pinned letter ${id} ${JSON.stringify(taken.title)} to ${where}, owner ${rec.faction || `profile ${rec.owner}`}`);
    this.log(`[housing] note ${id} pinned to ${where} by ${this.who(ctx, actorId)}`);
    this.notice(ctx, userId, "You pin the note to the door.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // Clears the pin first, then hands the letter over; a failed hand-over puts the pin back
  private doTakeNote(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord): void {
    const door = this.menuDoorInReach(ctx, userId, actorId, primary, "takenote");
    if (!door || !this.writings) return;
    const note = this.readNote(ctx, door);
    if (!note) {
      this.notice(ctx, userId, "There is no note here any more.");
      this.sendMenu(ctx, userId, actorId, primary);
      return;
    }
    const role = this.noteTakerRole(ctx, primary, rec, note, actorId);
    if (!role) {
      this.refuse(ctx, userId, actorId, "takenote", door, "Only whoever pinned it, the owner, a key holder or an admin may take it down.");
      return;
    }
    const view = this.writings.pinnedNoteView(ctx.svr, actorId, note.id);
    if (!view) {
      this.refuse(ctx, userId, actorId, "takenote", door, "Writing is not available yet.");
      return;
    }
    if (typeof view !== "string" && !this.writeNote(ctx, door, null)) {
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    const where = this.doorLabel(ctx, primary, rec, door);
    const given = typeof view === "string" ? view : this.writings.returnPinnedLetter(ctx.svr, actorId, note.id);
    if (given === "failed") {
      this.writeNote(ctx, door, note);
      this.log(`[housing] note ${note.id} on ${where} not taken down by ${this.who(ctx, actorId)}: the letter could not be given, the pin is back`);
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    if (given !== "given" || typeof view === "string") {
      if (given !== "given") this.crumble(ctx, door, note, given);
      this.notice(ctx, userId, "The note crumbles to dust.");
      this.sendMenu(ctx, userId, actorId, primary);
      return;
    }
    this.writings.logDoorNote(`${describeActor(ctx.svr, actorId)} took down letter ${note.id} ${JSON.stringify(view.title)} from ${where} as ${role}, pinned by [profile ${note.byProfile}] ${JSON.stringify(note.byName)} at ${new Date(note.at).toISOString()}`);
    this.log(`[housing] note ${note.id} taken down from ${where} by ${this.who(ctx, actorId)} as ${role}`);
    if (role === "admin") adminAudit(`profile ${this.profileOf(ctx, actorId)} (${adminTierOf(ctx.svr as Mp, actorId, this.roleCfg)}) took down letter ${note.id} from door ${door.toString(16)} (${this.claimLabel(primary, rec)})`);
    this.notice(ctx, userId, "You take the note down. It is in your pack.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // ── Knocking ────────────────────────────────────────────────────────────────

  // Anyone at a door may knock; every player within say range of either half reads it
  private doKnock(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord): void {
    const door = this.menuDoorInReach(ctx, userId, actorId, primary, "knock");
    if (!door) return;
    if (this.baseTypeOf(ctx, door) !== "DOOR") {
      this.refuse(ctx, userId, actorId, "knock", door, "Only a door can be knocked on.");
      return;
    }
    const now = Date.now();
    const wait = KNOCK_COOLDOWN_MS - (now - (this.lastKnockMs.get(actorId) || 0));
    if (wait > 0) {
      this.notice(ctx, userId, `You knocked a moment ago. Wait ${Math.ceil(wait / 1000)} s.`);
      return;
    }
    if (this.lastKnockMs.size > 256) {
      for (const [id, at] of this.lastKnockMs) if (now - at >= KNOCK_COOLDOWN_MS) this.lastKnockMs.delete(id);
    }
    this.lastKnockMs.set(actorId, now);
    const mp = ctx.svr as Mp;
    let title = "";
    try { title = String(mp.get(actorId, TITLE_PROP) || ""); } catch { /* no title shown */ }
    const name = titledName(title, this.nameOf(ctx, actorId));
    const line = (listenerId: number) => `${isIntroduced(mp, listenerId, actorId) ? name : "Someone"} knocks on the door.`;
    const told = new Set<number>([actorId]);
    const here = this.noticeAround(ctx, door, told, line);
    const far = this.partnerOf(ctx, door);
    const beyond = far ? `${this.noticeAround(ctx, far, told, line)} at ${this.doorLabel(ctx, primary, rec, far, false)}` : "no other half";
    this.log(`[housing] knock on ${this.doorLabel(ctx, primary, rec, door)} by ${this.who(ctx, actorId)}: read within talking range by ${here} at that door, ${beyond}`);
    this.notice(ctx, userId, "You knock on the door.");
  }

  // A notice for every player not yet told within say range of a ref, in its cell or worldspace; returns how many it reached
  private noticeAround(ctx: SystemContext, refrId: number, told: Set<number>, line: (listenerId: number) => string): number {
    const mp = ctx.svr as Mp;
    let cell = 0;
    let pos: unknown = null;
    try {
      cell = mp.getIdFromDesc(String(mp.get(refrId, "worldOrCellDesc"))) >>> 0;
      pos = mp.get(refrId, "pos");
    } catch {
      return 0;
    }
    if (!Array.isArray(pos)) return 0;
    let reached = 0;
    for (const { actorId: listenerId, userId } of onlineSnapshot(mp).nearNow(cell, pos, this.sayRange)) {
      if (told.has(listenerId)) continue;
      told.add(listenerId);
      this.notice(ctx, userId, line(listenerId));
      reached++;
    }
    return reached;
  }

  // ── Pets ────────────────────────────────────────────────────────────────────

  // Set by PetSystem: the kind of pets storable at a door, shown as the menu's Pets option
  petCategoryOf: ((actorId: number, refrId: number) => string) | null = null;

  // Set by FactionSystem: a faction door's owner, whether this actor may use it and the border notice; null when it is no faction's
  factionGate: ((actorId: number, refrId: number, action?: string) => { name: string; allowed: boolean; refusal: string } | null) | null = null;

  // Set by FactionSystem: a loaded faction definition, so each hold rank's property flag picks the hold managers
  factionDef: ((factionId: string) => FactionDef | null | undefined) | null = null;

  // Set by FactionSystem: the border notice of a court rank used outside its hold, "" inside it; with an action it is logged
  territoryRefusal: ((actorId: number, factionId: string, action?: string) => string) | null = null;

  // Set by FactionSystem: the id a claim's faction has now, when the backend rebuilt it under another type
  factionSuccessor: ((factionId: string) => string) | null = null;

  // Set by FactionSystem: the actor's own factions and what each rank allows on faction claims, staff powers left out
  factionRights: ((actorId: number) => FactionRight[]) | null = null;

  // Set by FactionSystem: runs the job in the player's faction queue once their ranks are reloaded from the backend
  factionFresh: ((userId: number, job: () => void) => void) | null = null;

  // Both halves of a teleport door, just the ref for anything else
  doorSides(ctx: SystemContext, refrId: number): number[] {
    const partner = refrId ? this.partnerOf(ctx, refrId) : 0;
    return partner ? [refrId, partner] : [refrId];
  }

  // The property's name when this character owns the door or container, else null
  ownedRefName(ctx: SystemContext, actorId: number, refrId: number): string | null {
    const primary = this.primaryOf(ctx, refrId);
    const rec = primary ? this.read(ctx, primary) : null;
    if (!rec || rec.owner === 0 || rec.owner !== this.profileOf(ctx, actorId)) return null;
    return rec.name || "";
  }

  // The nearest property this character owns within reach, else null
  nearestOwnedRef(ctx: SystemContext, actorId: number): { refrId: number; name: string } | null {
    const profileId = this.profileOf(ctx, actorId);
    if (!profileId) return null;
    for (const { primary, rec } of this.liveClaims(ctx)) {
      if (rec.owner === profileId && this.nearProperty(ctx, actorId, primary)) return { refrId: primary, name: rec.name || "" };
    }
    return null;
  }

  // ── Access ──────────────────────────────────────────────────────────────────

  private hasAccess(ctx: SystemContext, primary: number, rec: PropertyRecord, actorId: number): boolean {
    return this.accessRole(ctx, primary, rec, actorId) !== "";
  }

  // What lets an actor lock or unlock this: owner, admin, a faction claim's rank or key; hold officials only manage the claim
  private accessRole(ctx: SystemContext, primary: number, rec: PropertyRecord, actorId: number): string {
    if (rec.owner === 0) return "unclaimed";
    const v = this.viewerAccess(ctx, actorId);
    if (!rec.faction && v.profileId && v.profileId === rec.owner) return "owner";
    if (v.admin) return "admin";
    const standing = this.factionStanding(ctx, actorId, rec);
    if (standing.role) return `faction ${standing.role}`;
    return v.keys.has(this.credentialOf(primary, rec)) ? "key" : "";
  }

  // The personal owner, or a managing rank of the faction that owns the claim
  private ownsClaim(ctx: SystemContext, actorId: number, rec: PropertyRecord, standing: FactionStanding): boolean {
    if (rec.owner === 0) return false;
    return rec.faction ? standing.role === "manager" : rec.owner === this.profileOf(ctx, actorId);
  }

  // A managing rank also uses the claim; a court rank counts only inside its own hold, with an action the border refusal is logged
  private factionStanding(ctx: SystemContext, actorId: number, rec: PropertyRecord, action = ""): FactionStanding {
    const right = rec.faction ? this.factionRightsOf(actorId).find((f) => f.id === rec.faction) : undefined;
    if (!right || (!right.use && !right.manage)) return NO_STANDING;
    const refusal = this.territoryRefusal ? this.territoryRefusal(actorId, right.id, action) : "";
    return refusal ? { role: "", refusal } : { role: right.manage ? "manager" : "member", refusal: "" };
  }

  private factionRightsOf(actorId: number): FactionRight[] {
    try {
      return this.factionRights ? this.factionRights(actorId) : [];
    } catch (e) {
      this.log(`[housing] faction rights unavailable: ${e}`);
      return [];
    }
  }

  // The factions this actor may claim this property for
  private claimFactionsAt(ctx: SystemContext, actorId: number, primary: number): FactionRight[] {
    return this.factionRightsOf(actorId).filter((f) => f.manage && !this.factionClaimRefusal(ctx, actorId, primary, f));
  }

  // "" when the rank may claim for its faction here: it manages property, and a territory with land claims only inside its hold while standing in it
  private factionClaimRefusal(ctx: SystemContext, actorId: number, primary: number, right: FactionRight, action = ""): string {
    if (!right.manage) return `Your rank in ${right.name} does not manage its property.`;
    const court = factionLand(right.id, isHoldLand);
    if (court && this.holdOf(ctx, primary)?.key !== court) return `${right.name} may only claim property inside ${holdName(court)}.`;
    return this.territoryRefusal ? this.territoryRefusal(actorId, right.id, action) : "";
  }

  // The faction's current name on a faction claim, else the owner's name at the claim
  private ownerNameOf(rec: PropertyRecord): string {
    if (rec.faction) return this.factionDef?.(rec.faction)?.name || rec.ownerName || rec.faction;
    return rec.ownerName || "Someone";
  }

  // How an owner or manager acted on a claim, for the log
  private managedAs(rec: PropertyRecord, isOwner: boolean): string {
    return isOwner ? (rec.faction ? "faction manager" : "owner") : "manager";
  }

  // One inventory read and one access read per actor, not per claimed ref.
  private viewerAccess(ctx: SystemContext, actorId: number): ViewerAccess {
    const mp = ctx.svr as Mp;
    const keys = new Set<string>();
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      for (const e of entries) {
        if ((Number(e?.baseId) >>> 0) !== KEY_BASE_ID) continue;
        const credential = keyCredentialIn(e?.name);
        if (credential) keys.add(credential);
      }
    } catch { /* actor gone */ }
    return {
      profileId: this.profileOf(ctx, actorId),
      admin: this.isAdmin(ctx, actorId),
      keys,
    };
  }

  // "" for a manager of this claim, the border notice for its hold's official standing outside the hold, null for anyone else
  private managerRefusal(ctx: SystemContext, actorId: number, primary: number, action = ""): string | null {
    if (this.isAdmin(ctx, actorId)) return "";
    const hold = this.holdOf(ctx, primary);
    if (!hold) return null;
    let access: unknown = null;
    try { access = (ctx.svr as Mp).get(actorId, "private.skympAccess"); } catch { return null; }
    const ranks = holdRanksOf(access).filter((r) => r.hold === hold.key && managesHold(this.factionDef?.(r.factionId), r.rank));
    if (!ranks.length) return null;
    return this.territoryRefusal ? this.territoryRefusal(actorId, ranks[0].factionId, action) : "";
  }

  // Every admin tier overrides housing claims
  private isAdmin(ctx: SystemContext, actorId: number): boolean {
    return adminTierOf(ctx.svr as Mp, actorId, this.roleCfg) !== null;
  }

  // The hold a property answers to, from either half of a teleport pair
  private holdOf(ctx: SystemContext, primary: number): Hold | null {
    return holdOfRefs(ctx.svr as Mp, this.doorSides(ctx, primary));
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

  // Either half of a teleport pair counts, since the menu answers with the primary even from the far side
  private nearProperty(ctx: SystemContext, actorId: number, refrId: number): boolean {
    if (this.withinReach(ctx, actorId, refrId)) return true;
    const partner = this.partnerOf(ctx, refrId);
    return !!partner && this.withinReach(ctx, actorId, partner);
  }

  // Which half of a claimed pair a reference is, from the cells the two halves stand in: one in a worldspace, one in an interior
  private sideOf(ctx: SystemContext, primary: number, rec: PropertyRecord, refrId: number): DoorSide {
    const far = !rec.partner ? 0 : refrId === primary ? rec.partner : refrId === rec.partner ? primary : 0;
    if (!far) return "";
    const here = this.outdoors(ctx, refrId);
    const there = this.outdoors(ctx, far);
    if (here === null || there === null || here === there) return "";
    return here ? "outside" : "inside";
  }

  private hasSides(ctx: SystemContext, primary: number, rec: PropertyRecord): boolean {
    return this.sideOf(ctx, primary, rec, primary) !== "";
  }

  // A property with one lock is shut by either flag
  private lockedAt(rec: PropertyRecord, side: DoorSide): boolean {
    if (side === "outside") return rec.lockedEntrance;
    if (side === "inside") return EXIT_LOCKS && rec.lockedExit;
    return rec.lockedEntrance || rec.lockedExit;
  }

  private outdoors(ctx: SystemContext, refrId: number): boolean | null {
    const cached = this.outdoorsCache.get(refrId);
    if (cached !== undefined) return cached;
    const outdoors = isOutdoors(ctx.svr as Mp, refrId);
    if (outdoors !== null) this.rememberEspm(this.outdoorsCache, refrId, outdoors);
    return outdoors;
  }

  // ── Keys ────────────────────────────────────────────────────────────────────

  // The credential is the form id plus the serial, never the player-chosen
  // label: a rename must not orphan keys, and no label may forge another
  // property's key. hasAccess reads it back from the name's bracketed suffix,
  // which cleanName keeps a label from carrying.
  private credentialOf(primary: number, rec: PropertyRecord): string {
    const tag = primary.toString(16).toUpperCase();
    return rec.serial > 1 ? `${tag}-${rec.serial}` : tag;
  }

  // The cut number keeps every key of one property a separate item
  private keyNameOf(primary: number, rec: PropertyRecord, label: string): string {
    return `${label} (${this.credentialOf(primary, rec)}/${rec.cut})`;
  }

  // Pull the current keys from everyone online and move the serial on, so any
  // copy that was missed (offline, in a container) stops matching.
  private reKey(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    const mp = ctx.svr as Mp;
    const credential = this.credentialOf(primary, rec);
    for (const actorId of onlineActors(mp)) {
      try {
        const inv = mp.get(actorId, "inventory");
        const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
        const kept = entries.filter((e: any) => !((Number(e?.baseId) >>> 0) === KEY_BASE_ID && keyCredentialIn(e?.name) === credential));
        if (kept.length !== entries.length) mp.set(actorId, "inventory", { entries: kept });
      } catch { /* actor gone */ }
    }
    rec.serial += 1;
  }

  // A stack of old keys becomes separately numbered keys with the same credential in one inventory write
  private splitUncutKeys(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as Mp;
    let entries: any[];
    try {
      const inv = mp.get(actorId, "inventory");
      entries = inv && Array.isArray(inv.entries) ? inv.entries.slice() : [];
    } catch {
      return;
    }
    let split = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const count = Number(e?.count) || 0;
      if ((Number(e?.baseId) >>> 0) !== KEY_BASE_ID || count < 2 || count > MAX_KEYS_CARRIED) continue;
      const m = typeof e.name === "string" ? UNCUT_KEY.exec(e.name) : null;
      if (!m) continue;
      const primary = parseInt(m[1], 16) >>> 0;
      const rec = primary ? this.read(ctx, primary) : null;
      // A stale key opens nothing, so it is left as it is
      if (!rec || rec.owner === 0 || keyCredentialIn(e.name) !== this.credentialOf(primary, rec)) continue;
      const first = rec.cut + 1;
      rec.cut += count;
      if (!this.write(ctx, primary, rec)) continue;
      const copies = [];
      for (let n = 0; n < count; n++) {
        copies.push({ ...e, count: 1, name: this.keyNameOf(primary, { ...rec, cut: first + n }, DEFAULT_KEY_LABEL) });
      }
      entries.splice(i, 1, ...copies);
      split += count;
    }
    if (!split) return;
    try {
      mp.set(actorId, "inventory", { entries });
      this.log(`[housing] split ${split} uncut keys of ${this.who(ctx, actorId)}`);
    } catch (e) {
      this.log(`[housing] could not split uncut keys of ${this.who(ctx, actorId)}: ${e}`);
    }
  }

  private giveKey(ctx: SystemContext, actorId: number, keyName: string): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory") || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.slice() : [];
      const keys = entries.filter((e: any) => (Number(e?.baseId) >>> 0) === KEY_BASE_ID);
      const carried = keys.reduce((n: number, e: any) => n + (Number(e?.count) || 0), 0);
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

  // Logins share one full list, rebuilt at the first login after a claim changes
  private pushDecor(ctx: SystemContext, userId: number): void {
    if (!this.actorOf(ctx, userId)) return;
    this.decorFull ??= JSON.stringify({ customPacketType: "refDecor", full: true, refs: this.decorRefs(ctx) });
    this.send(ctx, userId, this.decorFull);
  }

  // halves are the claim's before the write; one it no longer covers goes out unnamed and unlocked
  private queueDecorDelta(ctx: SystemContext, primary: number, halves: number[]): void {
    this.decorFull = null;
    const pending = this.decorDelta.get(primary) ?? new Set<number>();
    for (const refId of halves) if (refId) pending.add(refId);
    this.decorDelta.set(primary, pending);
    if (this.decorPushQueued) return;
    this.decorPushQueued = true;
    soon(() => this.pushDecorDelta(ctx));
  }

  // Every client gets only the written claims' halves, one packet for all the writes of a turn
  private pushDecorDelta(ctx: SystemContext): void {
    this.decorPushQueued = false;
    const refs: Array<Record<string, unknown>> = [];
    for (const [primary, before] of this.decorDelta) {
      const rec = this.read(ctx, primary);
      const now = rec && rec.owner !== 0 ? this.decorOf(ctx, primary, rec) : [];
      refs.push(...now);
      for (const refId of before) if (!now.some((r) => r.refId === refId)) refs.push({ refId, name: null, locked: false });
    }
    this.decorDelta.clear();
    if (!refs.length) return;
    const json = JSON.stringify({ customPacketType: "refDecor", refs });
    for (const actorId of onlineActors(ctx.svr)) this.send(ctx, this.userOf(ctx, actorId), json);
  }

  // Each half carries its own side's lock, the same for every viewer, so one list serves everyone
  private decorRefs(ctx: SystemContext): Array<Record<string, unknown>> {
    const refs: Array<Record<string, unknown>> = [];
    const count = { sided: 0, entrance: 0, exit: 0, single: 0, locked: 0 };
    for (const { primary, rec } of this.liveClaims(ctx)) {
      const side = this.sideOf(ctx, primary, rec, primary);
      refs.push(...this.decorOf(ctx, primary, rec));
      if (side) {
        count.sided++;
        if (rec.lockedEntrance) count.entrance++;
        if (rec.lockedExit) count.exit++;
      } else {
        count.single++;
        if (this.lockedAt(rec, side)) count.locked++;
      }
    }
    if (!this.lockSummaryLogged) {
      this.lockSummaryLogged = true;
      this.log(`[housing] lock summary: ${count.sided} doors with an entrance and exit (${count.entrance} entrance locked, ${count.exit} exit locked), ${count.single} with one lock (${count.locked} locked)`);
    }
    return refs;
  }

  private decorOf(ctx: SystemContext, primary: number, rec: PropertyRecord): Array<Record<string, unknown>> {
    const refs: Array<Record<string, unknown>> = [{ refId: primary, name: rec.name, locked: this.lockedAt(rec, this.sideOf(ctx, primary, rec, primary)) }];
    if (rec.partner) refs.push({ refId: rec.partner, name: rec.name, locked: this.lockedAt(rec, this.sideOf(ctx, primary, rec, rec.partner)) });
    return refs;
  }

  // Registry ids without a live record (lost changeforms, older load orders) are dropped from the index
  private liveClaims(ctx: SystemContext): Array<{ primary: number; rec: PropertyRecord }> {
    const out: Array<{ primary: number; rec: PropertyRecord }> = [];
    const dead: number[] = [];
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (rec && rec.owner !== 0) out.push({ primary, rec });
      else dead.push(primary);
    }
    if (dead.length) {
      this.claimed = this.claimed.filter((id) => dead.indexOf(id) === -1);
      this.saveRegistry();
      this.log(`[housing] dropped ${dead.length} registry entries without a claim record: ${dead.map((id) => id.toString(16)).join(", ")}`);
    }
    return out;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  // Resolve any half of a pair (or a plain ref) to the id the record lives on.
  private primaryOf(ctx: SystemContext, refrId: number): number {
    if (!refrId) return 0;
    const mp = ctx.svr as Mp;
    let raw: any = null;
    try {
      raw = mp.get(refrId, HOUSING_PROP);
    } catch (e) {
      this.logUnclaimable(refrId, e);
      return 0;
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
    const far = espmRefrFieldId(ctx.svr as Mp, refrId, "XTEL");
    // A far side the server cannot load would fail every write, so the near side is claimed alone
    const partner = far && this.loadable(ctx, far) ? far : 0;
    this.rememberEspm(this.partnerCache, refrId, partner);
    return partner;
  }

  private loadable(ctx: SystemContext, refrId: number): boolean {
    try {
      (ctx.svr as Mp).get(refrId, HOUSING_PROP);
      return true;
    } catch {
      return false;
    }
  }

  // Once per ref, so the log names doors the server never loads without a held key flooding it
  private logUnclaimable(refrId: number, reason: unknown): void {
    if (this.unclaimableLogged.has(refrId)) return;
    if (this.unclaimableLogged.size >= MAX_ESPM_CACHE) this.unclaimableLogged.clear();
    this.unclaimableLogged.add(refrId);
    this.log(`[housing] ${refrId.toString(16)} cannot hold a claim: ${reason}`);
  }

  // "DOOR" / "CONT" / "" - the base object behind a placed reference. Claiming
  // is limited to these two so a stray form id cannot be turned into property.
  private baseTypeOf(ctx: SystemContext, refrId: number): string {
    const cached = this.baseTypeCache.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let type = "";
    try {
      const baseId = espmRefrFieldId(mp, refrId, "NAME");
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

  // ESM data never changes, so overflow can just start the cache over.
  private rememberEspm<T>(cache: Map<number, T>, refrId: number, value: T): void {
    if (cache.size >= MAX_ESPM_CACHE) cache.clear();
    cache.set(refrId, value);
  }

  private read(ctx: SystemContext, primary: number): PropertyRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(primary, HOUSING_PROP);
      if (!raw || typeof raw !== "object" || Number((raw as any).primary)) return null;
      const r = raw as Partial<StoredRecord>;
      // A record from before the entrance and exit keeps its one lock on both
      const legacy = r.locked === true;
      const owner = Number(r.owner) || 0;
      return {
        owner,
        // A record from before faction claims is personal
        faction: owner === FACTION_OWNER && typeof r.faction === "string" && r.faction.includes(":") ? this.factionSuccessor?.(r.faction) ?? r.faction : "",
        ownerName: String(r.ownerName || ""),
        name: typeof r.name === "string" && r.name ? r.name : null,
        lockedEntrance: typeof r.lockedEntrance === "boolean" ? r.lockedEntrance : legacy,
        lockedExit: typeof r.lockedExit === "boolean" ? r.lockedExit : legacy,
        serial: Number(r.serial) || 1,
        cut: Number(r.cut) || 0,
        partner: Number(r.partner) || 0,
        containers: Array.isArray(r.containers) ? r.containers.map((c) => Number(c) >>> 0) : [],
      };
    } catch {
      return null;
    }
  }

  private write(ctx: SystemContext, primary: number, rec: PropertyRecord): boolean {
    const mp = ctx.svr as Mp;
    const before = this.read(ctx, primary);
    try {
      const stored: StoredRecord = { ...rec, locked: rec.lockedEntrance || rec.lockedExit };
      mp.set(primary, HOUSING_PROP, stored);
    } catch (e) {
      this.log(`[housing] write failed for ${primary.toString(16)}: ${e}`);
      return false;
    }
    // The index and the pointer are best-effort; the record itself is stored.
    try { mp.set(primary, OWNER_INDEX_PROP, rec.faction || String(rec.owner)); } catch { }
    if (rec.partner) {
      try {
        const pointer: PrimaryPointer = { primary };
        mp.set(rec.partner, HOUSING_PROP, pointer);
      } catch { }
    }
    if (rec.owner !== 0) this.remember(primary); else this.forget(primary);
    this.queueDecorDelta(ctx, primary, before && before.owner !== 0 ? [primary, before.partner] : []);
    return true;
  }

  // A failed write must never read as success to the player
  private commit(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord): boolean {
    if (this.write(ctx, primary, rec)) return true;
    this.notice(ctx, userId, CHANGE_FAILED);
    return false;
  }

  // Giving a property up keeps an ownerless stub so the key serial survives;
  // a later claim then cannot mint a credential old copies already answer to.
  private release(ctx: SystemContext, primary: number, rec: PropertyRecord): boolean {
    this.reKey(ctx, primary, rec);
    rec.owner = 0;
    rec.faction = "";
    rec.ownerName = "";
    rec.name = null;
    rec.lockedEntrance = false;
    rec.lockedExit = false;
    return this.write(ctx, primary, rec);
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

  private saveRegistry(): void {
    try {
      writeFileAtomic(REGISTRY_FILE, JSON.stringify(this.claimed));
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

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown> | string): void {
    sendJson(ctx.svr as Mp, userId, payload);
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "propertyNotice", text });
  }

  // Every online character of the owner's profile, or of the owning faction whose rank uses or manages the claim
  private noticeOwners(ctx: SystemContext, rec: PropertyRecord, text: string): void {
    for (const actorId of onlineActors(ctx.svr)) {
      const owner = rec.faction
        ? this.factionRightsOf(actorId).some((f) => f.id === rec.faction && (f.use || f.manage))
        : this.profileOf(ctx, actorId) === rec.owner;
      if (owner) this.notice(ctx, this.userOf(ctx, actorId), text);
    }
  }

  // Logged as well as told, so a failed test shows where the request stopped
  private refuse(ctx: SystemContext, userId: number, actorId: number, action: string, refrId: number, text: string): void {
    this.notice(ctx, userId, text);
    this.log(`[housing] ${action} ${refrId.toString(16)} refused for ${this.who(ctx, actorId)}: ${text}`);
  }

  private who(ctx: SystemContext, actorId: number): string {
    return `${this.nameOf(ctx, actorId)} (profile ${this.profileOf(ctx, actorId)})`;
  }

  private claimLabel(primary: number, rec: PropertyRecord): string {
    return `claim ${primary.toString(16)}${rec.name ? ` "${rec.name}"` : ""}${rec.faction ? ` of ${rec.faction}` : ""}`;
  }

  private claimed: number[] = [];
  private partnerCache = new Map<number, number>();
  private baseTypeCache = new Map<number, string>();
  private outdoorsCache = new Map<number, boolean>();
  private lockSummaryLogged = false;
  private notesMarked = false;
  private noteMarkWarned = false;
  private unclaimableLogged = new Set<number>();
  private lastRequestMs = new Map<number, number>();
  private lastDenyMs = new Map<number, number>();
  // The half each user last opened the menu at
  private menuDoors = new Map<number, number>();
  private lastKnockMs = new Map<number, number>();
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private maxDistance = DEFAULT_MAX_DISTANCE;
  private sayRange = DEFAULT_SAY_RANGE;
  private keySplitOnLogin = false;
  private lockBaseId = LOCK_BASE_ID_FALLBACK;
  private decorPushQueued = false;
  // Claims written since the last delta, each with the halves it had before
  private decorDelta = new Map<number, Set<number>>();
  private decorFull: string | null = null;
}
