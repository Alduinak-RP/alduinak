import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, WORLD_LOADED_EVENT, USER_MENU_QUIT_EVENT } from "./system";
import { placeNpc, moveNpc, locationNear, locationForFollower, HOSTILE_PROP } from "./npcPlacement";
import { toFormId } from "./formIdUtil";
import { userOf, isAlive, isNear, isStreamedTo, hex, destroyLeftovers, destroyRef, addItemTo, nameShownTo, cleanDisplayName, isDoorRef, formatWait } from "./actorUtil";
import { HostingSystem, Hostable } from "./hostingSystem";
import { CompanionSystem } from "./companionSystem";
import { HousingSystem } from "./housingSystem";
import { SearchSystem } from "./searchSystem";
import { CaptureSystem } from "./captureSystem";
import { resolveEditorIds } from "./espmEditorIds";
import { PET_ANCHORS } from "./adminMapMarkers";
import { Inventory, addEntries, isNamedItem, readInventory, withCount } from "./inventoryExtras";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Pets: horses, livestock and dogs owned by one character. The owner's changeform holds the list (private.pets); a pet in the
// world is a server actor hosted by its owner. Conjured companions stay in CompanionSystem and reach the same menu by delegation.
// Protocol, rules and settings are documented in docs/docs_roleplay_pets.md; the client side is skymp5-client petService.ts.
//
// Client -> server: { customPacketType: "petRequest", action, target, ... }
//   menu {target}                       the X menu on a pet or conjured companion -> petMenu
//   use {target}                        E: horse -> mount handshake, livestock -> harvest, dog / companion -> petCommand
//   attack {target, victim}             E in command mode: the dog goes after that actor
//   mount {target, mounted?}            E on a horse, then the client's mounted:true/false report -> petMount / petDismount
//   trade | pet | carry | unsummon | release {target}
//   rename {target, name}
//   transfer {target, recipient}        recipient picked with the interact key after the menu closed; consent via captureConsentRequest
//   list {door}                         pets storable at this door -> petList
//   summon {uid, door}                  places a stored pet at the door
// Client -> server: { customPacketType: "captureConsentResult", requestId, accepted } (ids from CONSENT_ID_BASE up are ours)
// Server -> client: petState {pets}, petMenu {target, title, actions, trade}, petList {door, category, pets}, petMount {target, hosted},
//   petDismount {target}, petCommand {target}, petAction {target, action}, notification {text}
// Properties: private.pets on the owner, private.pet on the actor (never sent), ff_pet {kind, name, owner, dead?, flee?, carried?}
//   on the actor and ff_mount (horse id or 0) on a rider, both neighbor-visible and registered in the gamemode.

export type PetKind = "horse" | "livestock" | "dog";
export type PetHome = "stable" | "farm" | "house";

// One grantable base as the admin panel sees it
export interface PetBaseEntry {
  desc: string;
  editorId: string;
  name: string;
}

export interface StoredPet {
  uid: string;
  name: string;
  kind: PetKind;
  baseDesc: string;
  home: PetHome;
  // Where it was last stored, for the lists
  homeName: string;
  // 0 while stored
  actorId: number;
  // Epoch ms of the last harvest, 0 never
  harvestAt: number;
  // Epoch ms of its death; the record goes with the body or at the owner's next login
  diedAt?: number;
  inventory?: unknown;
  createdAt: number;
}

interface Active {
  id: number;
  ownerId: number;
  uid: string;
  kind: PetKind;
  name: string;
  ridingBy: number;
  pending?: { rider: number; at: number };
  carriedBy: number;
  diedAt: number;
  fleeSince: number;
  ownerAwaySince: number;
}

interface Released {
  id: number;
  until: number;
}

interface PendingTransfer {
  petId: number;
  ownerId: number;
  recipientId: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Anchor {
  name: string;
  kind: "stable" | "farm";
  cellOrWorldDesc: string;
  pos: number[];
}

const PETS_PROP = "private.pets";
const PET_PROP = "private.pet";
const PET_FF = "ff_pet";
const MOUNT_FF = "ff_mount";
const REGISTRY_FILE = "./pets.json";
const UPDATE_MS = 1000;
const SPAWN_DISTANCE = 160;
const MAX_NAME = 24;
// Consent ids above the capture system's own counter so both share the client prompt
const CONSENT_ID_BASE = 1_000_000_000;
const CONSENT_TIMEOUT_MS = 20000;
// Like companions: an owner without a user this long (character switch, quit to the menu) has left
const OWNER_GONE_MS = 5000;
const HOME_OF: Record<PetKind, PetHome> = { horse: "stable", livestock: "farm", dog: "house" };
const KIND_LABEL: Record<PetKind, string> = { horse: "Horse", livestock: "Livestock", dog: "Dog" };
const DEFAULT_BASES: Record<PetKind, string[]> = {
  horse: ["EncHorseSaddledBrown", "EncHorseSaddledBlack", "EncHorseSaddledGrey", "EncHorseSaddledPalomino"],
  livestock: ["EncCow", "EncGoatDomestic", "EncChicken"],
  dog: ["EncDog", "TrainedDog"],
};
// Display names for the bases; in game every horse coat is called just "Horse"
const BASE_LABEL: Record<string, string> = {
  enchorsesaddledbrown: "Brown Horse",
  enchorsesaddledblack: "Black Horse",
  enchorsesaddledgrey: "Grey Horse",
  enchorsesaddledpalomino: "Palomino Horse",
  enccow: "Cow",
  encgoatdomestic: "Goat",
  encchicken: "Chicken",
  encdog: "Dog",
  traineddog: "Trained Dog",
};
// An id outside the table drops its Enc prefix and splits at camel case: EncWolfIce reads "Wolf Ice"
const baseLabel = (editorId: string): string =>
  BASE_LABEL[editorId.toLowerCase()] ||
  editorId.replace(/^Enc(?=[A-Z])/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
// Editor id candidates for the harvest products, the first one found in the load order wins
const DEFAULT_HARVEST_ITEMS: Record<string, string[]> = {
  milk: ["BYOHFoodMilk"],
  egg: ["BirdEgg03"],
};
const HARVEST_RULES: { match: RegExp; product: string }[] = [
  { match: /cow|goat/i, product: "milk" },
  { match: /chicken|hen/i, product: "egg" },
];

// Defaults for every setting; the keys are read from server-settings.json
const DEFAULTS = {
  petInteractMaxDistance: 256,
  petAnchorRadius: 2048,
  petHarvestHours: 12,
  petCorpseSeconds: 300,
  petReleaseSeconds: 3600,
  petFleeSeconds: 30,
  petMountTimeoutSeconds: 5,
  petMaxPets: 10,
  petMaxOut: 3,
};

export class PetSystem implements System {
  systemName = "PetSystem";
  constructor(
    private log: Log,
    private hosting: HostingSystem,
    private companions: CompanionSystem,
    private housing: HousingSystem,
    private search: SearchSystem,
    private capture: CaptureSystem,
  ) { }

  private mp: Mp = null;
  private ctx: SystemContext | null = null;
  private active = new Map<number, Active>();
  private released = new Map<number, Released>();
  private transfers = new Map<number, PendingTransfer>();
  private nextConsentId = CONSENT_ID_BASE;
  private leftovers: number[] = [];
  private cfg = { ...DEFAULTS };
  private bases = new Map<PetKind, PetBaseEntry[]>();
  // product -> item desc
  private harvestItems = new Map<string, string>();
  private anchors: Anchor[] = [];
  private uidCounter = 0;
  private ffWarned = new Set<string>();
  // Characters whose player opened character select; the body stays in the world until the logout grace ends
  private menuAway = new Set<number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    this.ctx = ctx;
    const settings = await Settings.get();
    const all = settings.allSettings as Record<string, unknown> | null;
    for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      const n = Number(all?.[key]);
      if (Number.isFinite(n) && n >= 0) this.cfg[key] = n;
    }
    const corpse = Number(all?.["npcCorpseSeconds"]);
    if (all?.["petCorpseSeconds"] === undefined && Number.isFinite(corpse) && corpse > 0) this.cfg.petCorpseSeconds = corpse;
    this.anchors = (PET_ANCHORS as Anchor[]).filter((a) => a && (a.kind === "stable" || a.kind === "farm"));
    this.loadRegistry();
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.removeLeftovers());
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      try {
        this.menuAway.delete(actorId >>> 0);
        this.onOwnerAssigned(actorId >>> 0);
      } catch (e) {
        this.log(`PetSystem: assign hook failed: ${e}`);
      }
    });
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.menuAway.add(actorId >>> 0));
    this.installHooks();
    this.capture.onNpcCarryEnd = (npcId) => this.onCarryEnd(npcId);
    await this.resolveRecords(all, settings.dataDir, settings.loadOrder);
  }

  async updateAsync(): Promise<void> {
    await new Promise((r) => setTimeout(r, UPDATE_MS));
    try {
      this.tick();
    } catch (e) {
      this.log(`PetSystem: tick failed: ${e}`);
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId) >>> 0; } catch { return; }
    if (!actorId) return;
    this.menuAway.delete(actorId);
    this.dropTransfersOf(actorId);
    const ride = this.rideOf(actorId);
    if (ride) this.clearRide(ride, "rider left");
    // A logged-out owner's pets go back to their homes; a body keeps its timer
    for (const a of this.ownedBy(actorId)) if (!a.diedAt) this.store(a, "owner logged out");
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type === "captureConsentResult") {
      this.onConsentResult(userId, content);
      return;
    }
    if (type !== "petRequest") return;
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId) >>> 0; } catch { return; }
    if (!actorId) return;
    const action = String(content["action"] ?? "");
    const target = toFormId(content["target"]);
    try {
      switch (action) {
        case "menu": return this.onMenu(userId, actorId, target);
        case "use": return this.onUse(userId, actorId, target);
        case "mount": return this.onMount(userId, actorId, target, content["mounted"]);
        case "trade": return this.onTrade(userId, actorId, target);
        case "pet": return this.onPet(userId, actorId, target);
        case "carry": return this.onCarry(userId, actorId, target);
        case "unsummon": return this.onUnsummon(userId, actorId, target);
        case "rename": return this.onRename(userId, actorId, target, content["name"]);
        case "transfer": return this.onTransfer(userId, actorId, target, toFormId(content["recipient"]));
        case "attack": return this.onAttack(userId, actorId, target, toFormId(content["victim"]));
        case "release": return this.onRelease(userId, actorId, target);
        case "list": return this.onList(userId, actorId, toFormId(content["door"]));
        case "summon": return this.onSummon(userId, actorId, String(content["uid"] ?? ""), toFormId(content["door"]));
        default: return;
      }
    } catch (e) {
      this.log(`PetSystem: ${action} by ${hex(actorId)} failed: ${e}`);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  // Every pet in the world, for the hosting audit: the owner hosts it, the rider while ridden; a released one goes to anyone
  hostables(): Hostable[] {
    const out: Hostable[] = [];
    for (const a of this.active.values()) {
      if (a.diedAt) continue;
      const rider = a.ridingBy || a.pending?.rider || 0;
      out.push({ id: a.id, owner: rider || a.ownerId, locked: !!(rider || a.carriedBy) });
    }
    for (const r of this.released.values()) out.push({ id: r.id });
    return out;
  }

  // Grantable bases per kind, for the admin panel
  baseList(): Record<PetKind, PetBaseEntry[]> {
    return {
      horse: this.bases.get("horse") ?? [],
      livestock: this.bases.get("livestock") ?? [],
      dog: this.bases.get("dog") ?? [],
    };
  }

  // Adds a stored pet to a character; empty result on success, else the refusal
  grant(ownerId: number, kind: PetKind, baseRef: string, name: string): string {
    if (!HOME_OF[kind]) return "Unknown pet kind";
    const wanted = String(baseRef ?? "").trim().toLowerCase();
    const list = this.bases.get(kind) ?? [];
    const base = list.find((b) => b.desc.toLowerCase() === wanted || b.editorId.toLowerCase() === wanted) ?? list[0];
    if (!base) return `No ${kind} base is configured`;
    const pets = this.readPets(ownerId);
    if (!pets) return "That character has no pet storage";
    if (this.keptCount(pets) >= this.cfg.petMaxPets) return `They already keep ${this.cfg.petMaxPets} pets`;
    const rec: StoredPet = {
      uid: this.newUid(),
      name: cleanDisplayName(name, MAX_NAME) || this.speciesOf(base.editorId, kind),
      kind,
      baseDesc: base.desc,
      home: HOME_OF[kind],
      homeName: "",
      actorId: 0,
      harvestAt: 0,
      createdAt: Date.now(),
    };
    pets.push(rec);
    if (!this.writePets(ownerId, pets)) return "The pet could not be stored";
    this.sendState(ownerId);
    this.log(`PetSystem: ${kind} ${rec.uid} (${base.editorId}) granted to ${hex(ownerId)}`);
    return "";
  }

  // The kind of pets storable at a door: the owner's own house, a stable or a farm; empty when none
  categoryOfDoor(actorId: number, refrId: number): PetHome | "" {
    if (!refrId) return "";
    const sides = this.sidesOf(refrId);
    if (this.ctx && sides.some((id) => this.housing.ownedRefName(this.ctx!, actorId, id) !== null)) return "house";
    for (const id of sides) {
      const near = this.anchorNearRef(id);
      if (near) return near.kind;
    }
    return "";
  }

  isPetActor(actorId: number): boolean {
    return this.active.has(actorId >>> 0) || this.released.has(actorId >>> 0);
  }

  // Out dogs that may join their owner's fights, for CompanionSystem's targeting
  fighters(): { id: number; ownerId: number }[] {
    const out: { id: number; ownerId: number }[] = [];
    for (const a of this.active.values()) {
      if (a.kind !== "dog" || a.diedAt || a.carriedBy || a.ridingBy || a.pending || a.fleeSince) continue;
      out.push({ id: a.id, ownerId: a.ownerId });
    }
    return out;
  }

  // The owner of a pet in the world, 0 for a released one or anything else
  ownerOf(actorId: number): number {
    return this.active.get(actorId >>> 0)?.ownerId ?? 0;
  }

  // ── Menu and E ───────────────────────────────────────────────────────────────

  private onMenu(userId: number, actorId: number, target: number): void {
    const companion = this.companions.info(target);
    if (companion) {
      if (companion.ownerId !== actorId) return;
      this.send(userId, {
        customPacketType: "petMenu", target, title: "Companion", trade: false,
        actions: [{ id: "pet", label: "Pet" }, { id: "follow", label: "Follow" }, { id: "unsummon", label: "Unsummon" }],
      });
      return;
    }
    const a = this.mine(userId, actorId, target);
    if (!a) return;
    const actions: { id: string; label: string }[] = [{ id: "pet", label: "Pet" }];
    // The client sends Follow as a companionCommand, since a dog fights through CompanionSystem
    if (a.kind === "dog" && !a.carriedBy) actions.push({ id: "follow", label: "Follow" });
    if (a.kind !== "horse") actions.push({ id: "carry", label: a.carriedBy === actorId ? "Put down" : "Carry" });
    if (this.homeNear(actorId, a.kind)) actions.push({ id: "unsummon", label: "Unsummon" });
    actions.push({ id: "rename", label: "Rename" }, { id: "transfer", label: "Transfer" }, { id: "release", label: "Release" });
    this.send(userId, { customPacketType: "petMenu", target, title: a.name, trade: a.kind !== "livestock", actions });
  }

  private onUse(userId: number, actorId: number, target: number): void {
    const companion = this.companions.info(target);
    if (companion) {
      if (companion.ownerId === actorId) this.send(userId, { customPacketType: "petCommand", target });
      return;
    }
    const a = this.active.get(target);
    if (!a) return;
    if (a.kind === "horse") return this.onMount(userId, actorId, target, undefined);
    if (!this.mine(userId, actorId, target)) return;
    if (a.kind === "livestock") return this.harvest(userId, actorId, a);
    this.send(userId, { customPacketType: "petCommand", target });
  }

  // Command mode: the dog is sent at a target CompanionSystem validates the way it validates a summon order
  private onAttack(userId: number, actorId: number, target: number, victimId: number): void {
    const a = this.active.get(target);
    if (!a || a.ownerId !== actorId || a.kind !== "dog") return;
    if (a.diedAt || a.carriedBy || a.ridingBy || a.pending || a.fleeSince || !isAlive(this.mp, a.id)) return;
    if (!this.companions.orderAttack(a.id, victimId)) this.notice(userId, `${a.name} cannot go after that.`);
  }

  private harvest(userId: number, actorId: number, a: Active): void {
    const pets = this.readPets(actorId) ?? [];
    const rec = pets.find((p) => p.uid === a.uid);
    if (!rec) return;
    const product = this.productOf(rec.baseDesc);
    const itemDesc = product ? this.harvestItems.get(product) : undefined;
    if (!product || !itemDesc) {
      this.notice(userId, `${a.name} gives nothing.`);
      return;
    }
    const now = Date.now();
    const readyAt = rec.harvestAt + this.cfg.petHarvestHours * 3600 * 1000;
    if (readyAt > now) {
      this.notice(userId, `${a.name} can be harvested again in ${formatWait(readyAt - now)}.`);
      return;
    }
    let itemId = 0;
    try { itemId = this.mp.getIdFromDesc(itemDesc) >>> 0; } catch { }
    if (!itemId) {
      this.notice(userId, `${a.name} gives nothing.`);
      return;
    }
    rec.harvestAt = now;
    if (!this.writePets(actorId, pets)) return;
    addItemTo(this.mp, actorId, itemId, 1);
    this.notice(userId, `You gathered ${product} from ${a.name}.`);
  }

  // ── Mount handshake (docs: Visible riding) ───────────────────────────────────

  private onMount(userId: number, actorId: number, target: number, mounted: unknown): void {
    const released = mounted === undefined && this.released.has(target);
    if (released && !isNear(this.mp, actorId, target, this.cfg.petInteractMaxDistance)) return this.notice(userId, "Too far.");
    if (released && this.rideOf(actorId)) return this.notice(userId, "You are already mounted.");
    const a = released ? this.adopt(userId, actorId, target) : this.active.get(target);
    if (!a || a.kind !== "horse") return;
    if (mounted === true || mounted === false) return this.onMountReport(userId, actorId, a, mounted);
    if (a.diedAt || !isAlive(this.mp, a.id)) return this.notice(userId, "It is dead.");
    if (a.ridingBy || (a.pending && Date.now() - a.pending.at < this.cfg.petMountTimeoutSeconds * 1000)) {
      return this.notice(userId, "Someone is already riding it.");
    }
    if (a.carriedBy) return this.notice(userId, "It is being carried.");
    if (!isNear(this.mp, actorId, a.id, this.cfg.petInteractMaxDistance)) return this.notice(userId, "Too far.");
    if (this.rideOf(actorId)) return this.notice(userId, "You are already mounted.");
    if (a.ownerId !== actorId) {
      const refusal = this.roomFor(actorId);
      if (refusal) return this.notice(userId, refusal);
    }
    a.pending = { rider: actorId, at: Date.now() };
    // Already the host: no HostStart is coming, so the client may activate at once
    let hosted = false;
    try { hosted = (Number(this.mp.getHoster(a.id)) >>> 0) === actorId; } catch { }
    if (!this.hosting.assign(a.id, actorId, "rider")) {
      a.pending = undefined;
      return this.notice(userId, "Try again.");
    }
    this.send(userId, { customPacketType: "petMount", target: a.id, hosted });
  }

  private onMountReport(userId: number, actorId: number, a: Active, mounted: boolean): void {
    if (!mounted) {
      if (a.pending?.rider === actorId) a.pending = undefined;
      if (a.ridingBy === actorId) this.clearRide(a, "dismounted");
      return;
    }
    if (a.pending?.rider !== actorId || Date.now() - a.pending.at > this.cfg.petMountTimeoutSeconds * 1000) {
      a.pending = undefined;
      return this.send(userId, { customPacketType: "petDismount", target: a.id });
    }
    if (a.diedAt || !isAlive(this.mp, a.id) || !isAlive(this.mp, actorId)) {
      a.pending = undefined;
      return this.send(userId, { customPacketType: "petDismount", target: a.id });
    }
    // The caps may have filled while the rider climbed on
    if (a.ownerId !== actorId) {
      const other = this.rideOf(actorId);
      const refusal = other && other !== a ? "You are already mounted." : this.roomFor(actorId);
      if (refusal) {
        a.pending = undefined;
        this.hosting.assign(a.id, a.ownerId, "owner");
        this.notice(userId, refusal);
        return this.send(userId, { customPacketType: "petDismount", target: a.id });
      }
    }
    let hoster = 0;
    try { hoster = Number(this.mp.getHoster(a.id)) >>> 0; } catch { }
    if (hoster !== actorId && !this.hosting.assign(a.id, actorId, "rider")) {
      a.pending = undefined;
      return this.send(userId, { customPacketType: "petDismount", target: a.id });
    }
    // Mounting someone else's horse takes it; the previous owner only loses it once the rider really sits
    if (a.ownerId !== actorId && !this.changeOwner(a, actorId, "stolen")) {
      a.pending = undefined;
      this.hosting.assign(a.id, a.ownerId, "owner");
      return this.send(userId, { customPacketType: "petDismount", target: a.id });
    }
    a.pending = undefined;
    a.ridingBy = actorId;
    this.setFf(actorId, MOUNT_FF, a.id);
    this.log(`PetSystem: ${hex(actorId)} rides ${a.name} ${hex(a.id)}`);
  }

  private clearRide(a: Active, reason: string): void {
    const rider = a.ridingBy;
    a.ridingBy = 0;
    a.pending = undefined;
    if (!rider) return;
    this.setFf(rider, MOUNT_FF, 0);
    const u = userOf(this.mp, rider);
    if (u >= 0) this.send(u, { customPacketType: "petDismount", target: a.id });
    this.log(`PetSystem: ${hex(rider)} off ${a.name} ${hex(a.id)} (${reason})`);
  }

  private rideOf(riderId: number): Active | undefined {
    for (const a of this.active.values()) if (a.ridingBy === riderId) return a;
    return undefined;
  }

  // ── Menu actions ─────────────────────────────────────────────────────────────

  private onTrade(userId: number, actorId: number, target: number): void {
    const a = this.mine(userId, actorId, target);
    if (!a) return;
    if (a.kind === "livestock") return this.notice(userId, `${a.name} carries nothing.`);
    if (!this.ctx) return;
    const refusal = this.search.openPetInventory(this.ctx, actorId, a.id);
    if (refusal) this.notice(userId, refusal);
  }

  private onPet(userId: number, actorId: number, target: number): void {
    const companion = this.companions.info(target);
    if (companion ? companion.ownerId !== actorId || !isNear(this.mp, actorId, target, this.cfg.petInteractMaxDistance) : !this.mine(userId, actorId, target)) return;
    this.send(userId, { customPacketType: "petAction", target, action: "pet" });
  }

  private onCarry(userId: number, actorId: number, target: number): void {
    const a = this.mine(userId, actorId, target);
    if (!a || !this.ctx) return;
    if (a.kind === "horse") return this.notice(userId, "A horse is too heavy to carry.");
    if (a.carriedBy === actorId) {
      this.capture.stopCarrying(this.ctx, actorId);
      return;
    }
    if (a.ridingBy) return this.notice(userId, "It is being ridden.");
    const refusal = this.capture.carryNpc(this.ctx, actorId, a.id, a.name);
    if (refusal) return this.notice(userId, refusal);
    a.carriedBy = actorId;
    // The carrier's client holds it in its arms and streams where it is
    this.hosting.assign(a.id, actorId, "carried");
    this.pushFf(a);
    this.notice(userId, `You picked up ${a.name}.`);
  }

  private onCarryEnd(npcId: number): void {
    const a = this.active.get(npcId >>> 0);
    if (!a || !a.carriedBy) return;
    a.carriedBy = 0;
    this.pushFf(a);
    // Back to its owner's client at once instead of waiting for the hosting audit
    if (!a.diedAt && !a.ridingBy) this.hosting.assign(a.id, a.ownerId, "owner");
  }

  private onUnsummon(userId: number, actorId: number, target: number): void {
    const companion = this.companions.info(target);
    if (companion) {
      if (companion.ownerId === actorId) this.companions.dismiss(target, "unsummoned by owner");
      return;
    }
    const a = this.mine(userId, actorId, target);
    if (!a) return;
    if (a.ridingBy) return this.notice(userId, "Dismount first.");
    const home = this.homeNear(actorId, a.kind);
    if (!home) return this.notice(userId, this.homeHint(a.kind));
    this.store(a, "unsummoned", home);
    this.notice(userId, `${a.name} is now at ${home}.`);
  }

  private onRename(userId: number, actorId: number, target: number, raw: unknown): void {
    const a = this.mine(userId, actorId, target);
    if (!a) return;
    const name = cleanDisplayName(raw, MAX_NAME);
    if (!name) return this.notice(userId, "That name cannot be used.");
    const pets = this.readPets(actorId) ?? [];
    const rec = pets.find((p) => p.uid === a.uid);
    if (!rec) return;
    rec.name = name;
    if (!this.writePets(actorId, pets)) return;
    a.name = name;
    this.pushFf(a);
    this.sendState(actorId);
    this.notice(userId, `Renamed to ${name}.`);
  }

  private onTransfer(userId: number, actorId: number, target: number, recipientId: number): void {
    const a = this.mine(userId, actorId, target);
    if (!a) return;
    const recipientUser = userOf(this.mp, recipientId);
    if (!recipientId || recipientId === actorId || recipientUser < 0) return this.notice(userId, "Look at the player who should receive it.");
    if (!isNear(this.mp, actorId, recipientId, this.cfg.petInteractMaxDistance)) return this.notice(userId, "They are too far away.");
    if (a.ridingBy || a.carriedBy) return this.notice(userId, "Not while it is ridden or carried.");
    for (const t of this.transfers.values()) {
      if (t.petId === a.id || t.recipientId === recipientId) return this.notice(userId, "A transfer is already pending.");
    }
    const theirs = this.readPets(recipientId);
    if (!theirs) return this.notice(userId, "They cannot keep pets.");
    if (this.roomFor(recipientId)) return this.notice(userId, "They have no room for another pet.");
    const requestId = this.nextConsentId++;
    const timer = setTimeout(() => {
      if (this.transfers.delete(requestId)) this.notice(userOf(this.mp, actorId), `${nameShownTo(this.mp, actorId, recipientId)} did not respond.`);
    }, CONSENT_TIMEOUT_MS);
    this.transfers.set(requestId, { petId: a.id, ownerId: actorId, recipientId, timer });
    this.send(recipientUser, {
      customPacketType: "captureConsentRequest",
      requestId,
      text: `${nameShownTo(this.mp, recipientId, actorId)} offers you ${a.name} (${KIND_LABEL[a.kind].toLowerCase()}). Accept?`,
    });
    this.notice(userId, `Waiting for ${nameShownTo(this.mp, actorId, recipientId)} to accept…`);
  }

  private onConsentResult(userId: number, content: Content): void {
    const requestId = Number(content["requestId"]);
    const t = this.transfers.get(requestId);
    if (!t) return;
    let responder = 0;
    try { responder = this.mp.getUserActor(userId) >>> 0; } catch { return; }
    if (responder !== t.recipientId) return;
    this.transfers.delete(requestId);
    clearTimeout(t.timer);
    const ownerUser = userOf(this.mp, t.ownerId);
    const a = this.active.get(t.petId);
    if (content["accepted"] !== true) {
      this.notice(ownerUser, `${nameShownTo(this.mp, t.ownerId, t.recipientId)} refused.`);
      return;
    }
    if (!a || a.ownerId !== t.ownerId || a.diedAt || a.ridingBy || a.carriedBy) {
      this.notice(ownerUser, "The pet can no longer be handed over.");
      return;
    }
    if (!isNear(this.mp, t.ownerId, t.recipientId, this.cfg.petInteractMaxDistance)) {
      this.notice(ownerUser, `${nameShownTo(this.mp, t.ownerId, t.recipientId)} is out of reach.`);
      return;
    }
    const refusal = this.roomFor(t.recipientId);
    if (refusal) {
      this.notice(userId, refusal);
      this.notice(ownerUser, "They have no room for another pet.");
      return;
    }
    if (!this.changeOwner(a, t.recipientId, "transferred")) {
      this.notice(ownerUser, "The pet could not be handed over.");
      return;
    }
    this.notice(ownerUser, `You handed ${a.name} to ${nameShownTo(this.mp, t.ownerId, t.recipientId)}.`);
    this.notice(userId, `${nameShownTo(this.mp, t.recipientId, t.ownerId)} handed you ${a.name}.`);
  }

  private onRelease(userId: number, actorId: number, target: number): void {
    const a = this.mine(userId, actorId, target);
    if (!a) return;
    if (a.ridingBy || a.carriedBy) return this.notice(userId, "Not while it is ridden or carried.");
    const pets = (this.readPets(actorId) ?? []).filter((p) => p.uid !== a.uid);
    if (!this.writePets(actorId, pets)) return;
    this.endTrade(a.id);
    this.active.delete(a.id);
    try {
      const inv = readInventory(this.mp, a.id);
      if (this.rescueNamedItems(actorId, inv)) this.mp.set(a.id, "inventory", { entries: inv.entries.filter((e) => !isNamedItem(e)) });
    } catch { }
    this.released.set(a.id, { id: a.id, until: Date.now() + this.cfg.petReleaseSeconds * 1000 });
    try { this.mp.set(a.id, PET_PROP, { owner: 0, uid: a.uid, kind: a.kind, name: a.name, released: Date.now() }); } catch { }
    this.setFf(a.id, PET_FF, { kind: a.kind, name: a.name, owner: 0 });
    // Whoever is nearest hosts it from now on, so it wanders
    this.hosting.assign(a.id, 0, "released");
    this.save();
    this.sendState(actorId);
    this.notice(userId, `${a.name} is free.`);
    this.log(`PetSystem: ${hex(actorId)} released ${a.name} ${hex(a.id)}`);
  }

  // ── Doors: list and summon ───────────────────────────────────────────────────

  private onList(userId: number, actorId: number, door: number): void {
    const category = this.categoryOfDoor(actorId, door);
    if (!category) return this.notice(userId, "No pets are kept here.");
    const pets = (this.readPets(actorId) ?? []).filter((p) => p.home === category && !p.diedAt);
    this.send(userId, {
      customPacketType: "petList",
      door,
      category,
      pets: pets.map((p) => ({ uid: p.uid, name: p.name, kind: p.kind, homeName: p.homeName, out: p.actorId !== 0 })),
    });
  }

  private onSummon(userId: number, actorId: number, uid: string, door: number): void {
    const category = this.categoryOfDoor(actorId, door);
    if (!category) return this.notice(userId, "No pets are kept here.");
    if (!this.nearRef(actorId, door)) return this.notice(userId, "Stand at the door.");
    // Horses and livestock come out where they can be unsummoned again
    if (category !== "house" && !this.anchorNearActor(actorId, category)) return this.notice(userId, "Summon it from the outside door.");
    const pets = this.readPets(actorId) ?? [];
    const rec = pets.find((p) => p.uid === uid);
    if (!rec || rec.home !== category) return this.notice(userId, "That pet is not kept here.");
    if (rec.actorId) return this.notice(userId, `${rec.name} is already out.`);
    if (this.outCount(actorId) >= this.cfg.petMaxOut) return this.notice(userId, `You cannot have more than ${this.cfg.petMaxOut} pets out.`);
    if (!isAlive(this.mp, actorId)) return;
    const id = this.spawn(actorId, rec);
    if (!id) return this.notice(userId, `${rec.name} could not be brought out.`);
    this.writePets(actorId, pets);
    this.sendState(actorId);
    this.notice(userId, `${rec.name} is here.`);
  }

  // ── Spawn, store, ownership ──────────────────────────────────────────────────

  private spawn(ownerId: number, rec: StoredPet): number {
    const mp = this.mp;
    let id = 0;
    try {
      const loc = rec.kind === "dog" ? locationForFollower(mp, ownerId) : locationNear(mp, ownerId, SPAWN_DISTANCE);
      id = placeNpc(mp, ownerId, rec.baseDesc, loc) >>> 0;
    } catch (e) {
      this.log(`PetSystem: failed to place ${rec.baseDesc} for ${hex(ownerId)}: ${e}`);
      return 0;
    }
    try { mp.set(id, HOSTILE_PROP, false); } catch { }
    try { mp.set(id, PET_PROP, { owner: ownerId, uid: rec.uid, kind: rec.kind, name: rec.name }); } catch { }
    if (rec.inventory) {
      try { mp.set(id, "inventory", rec.inventory); } catch (e) { this.log(`PetSystem: inventory restore on ${hex(id)} failed: ${e}`); }
    }
    rec.actorId = id;
    const a: Active = { id, ownerId, uid: rec.uid, kind: rec.kind, name: rec.name, ridingBy: 0, carriedBy: 0, diedAt: 0, fleeSince: 0, ownerAwaySince: 0 };
    this.active.set(id, a);
    this.pushFf(a);
    this.hosting.assign(id, ownerId, "owner");
    this.save();
    this.log(`PetSystem: ${rec.kind} ${rec.name} ${hex(id)} out for ${hex(ownerId)}`);
    return id;
  }

  // Takes the pet out of the world and back into its owner's storage, keeping what it carried
  private store(a: Active, reason: string, homeName?: string): void {
    const mp = this.mp;
    if (a.ridingBy) this.clearRide(a, reason);
    if (a.carriedBy && this.ctx) this.capture.stopCarrying(this.ctx, a.carriedBy);
    const pets = this.readPets(a.ownerId);
    const rec = pets?.find((p) => p.uid === a.uid);
    if (pets && rec) {
      if (a.kind !== "livestock") {
        try { rec.inventory = mp.get(a.id, "inventory"); } catch { }
      }
      rec.actorId = 0;
      if (homeName !== undefined) rec.homeName = homeName;
      this.writePets(a.ownerId, pets);
    }
    this.endTrade(a.id);
    this.active.delete(a.id);
    try { destroyRef(mp, a.id); } catch { }
    this.save();
    this.sendState(a.ownerId);
    this.log(`PetSystem: ${a.name} ${hex(a.id)} stored (${reason})`);
  }

  // Moves an active pet's record to another character; the actor stays and follows its new owner
  private changeOwner(a: Active, newOwnerId: number, reason: string): boolean {
    const from = this.readPets(a.ownerId) ?? [];
    const rec = from.find((p) => p.uid === a.uid);
    const to = this.readPets(newOwnerId);
    if (!rec || !to) return false;
    if (!this.writePets(newOwnerId, to.concat([rec]))) return false;
    this.writePets(a.ownerId, from.filter((p) => p.uid !== a.uid));
    const previous = a.ownerId;
    this.endTrade(a.id);
    a.ownerId = newOwnerId;
    try { this.mp.set(a.id, PET_PROP, { owner: newOwnerId, uid: a.uid, kind: a.kind, name: a.name }); } catch { }
    this.pushFf(a);
    this.save();
    this.sendState(previous);
    this.sendState(newOwnerId);
    if (reason === "stolen") {
      this.notice(userOf(this.mp, previous), `${nameShownTo(this.mp, previous, newOwnerId)} took ${a.name}.`);
      this.notice(userOf(this.mp, newOwnerId), `${a.name} is yours now.`);
    }
    this.log(`PetSystem: ${a.name} ${hex(a.id)} ${reason}: ${hex(previous)} -> ${hex(newOwnerId)}`);
    return true;
  }

  // ── Lifecycle poll ───────────────────────────────────────────────────────────

  private tick(): void {
    const mp = this.mp;
    const now = Date.now();
    for (const a of Array.from(this.active.values())) {
      let dead = false;
      let gone = false;
      try { dead = mp.get(a.id, "isDead") === true; } catch { dead = gone = true; }
      if (gone) {
        this.forget(a, "vanished");
        continue;
      }
      if (dead && !a.diedAt) {
        this.onDeath(a, now);
        continue;
      }
      if (a.diedAt) {
        if (now - a.diedAt >= this.cfg.petCorpseSeconds * 1000) this.forget(a, "body removed");
        continue;
      }
      // A character switch or a quit to the menu fires no disconnect
      if (userOf(mp, a.ownerId) < 0 || this.menuAway.has(a.ownerId)) {
        a.ownerAwaySince = a.ownerAwaySince || now;
        if (now - a.ownerAwaySince >= OWNER_GONE_MS) this.store(a, "owner left");
        continue;
      }
      a.ownerAwaySince = 0;
      if (a.ridingBy && (userOf(mp, a.ridingBy) < 0 || this.menuAway.has(a.ridingBy))) this.clearRide(a, "rider left");
      if (a.pending && now - a.pending.at > this.cfg.petMountTimeoutSeconds * 1000) {
        const rider = a.pending.rider;
        a.pending = undefined;
        this.notice(userOf(mp, rider), "Try again.");
      }
      if (a.ridingBy && !isAlive(mp, a.ridingBy)) this.clearRide(a, "rider died");
      // An owner in the dirt sends the pet running; it goes home after a while
      let ownerDead = false;
      try { ownerDead = mp.get(a.ownerId, "isDead") === true; } catch { ownerDead = true; }
      if (ownerDead && !a.fleeSince) {
        a.fleeSince = now;
        if (a.ridingBy) this.clearRide(a, "rider died");
        if (a.carriedBy && this.ctx) this.capture.stopCarrying(this.ctx, a.carriedBy);
        this.pushFf(a);
      }
      if (a.fleeSince && now - a.fleeSince >= this.cfg.petFleeSeconds * 1000) this.store(a, "fled home");
      this.followOwner(a);
    }
    for (const r of Array.from(this.released.values())) {
      let alive = true;
      try { alive = mp.get(r.id, "isDead") === false; } catch { alive = false; }
      if (!alive || now >= r.until) {
        this.released.delete(r.id);
        try { destroyRef(mp, r.id); } catch { }
        this.save();
      }
    }
  }

  // An out dog its owner's client cannot have (a load door, a long ride) is brought in front of them, the way a companion is
  private followOwner(a: Active): void {
    if (a.kind !== "dog" || a.diedAt || a.fleeSince || a.carriedBy || a.ridingBy || a.pending) return;
    if (!this.active.has(a.id) || isStreamedTo(this.mp, a.id, a.ownerId)) return;
    try {
      moveNpc(this.mp, a.id, locationForFollower(this.mp, a.ownerId));
    } catch (e) {
      this.log(`PetSystem: ${a.name} ${hex(a.id)} could not be moved to ${hex(a.ownerId)}: ${e}`);
      return;
    }
    this.log(`PetSystem: ${a.name} ${hex(a.id)} brought to ${hex(a.ownerId)}`);
    // A move with no host reaches no client
    this.hosting.assign(a.id, a.ownerId, "owner");
  }

  private onDeath(a: Active, now: number): void {
    a.diedAt = now;
    if (a.ridingBy) this.clearRide(a, "horse died");
    if (a.carriedBy && this.ctx) this.capture.stopCarrying(this.ctx, a.carriedBy);
    a.pending = undefined;
    const pets = this.readPets(a.ownerId);
    const rec = pets?.find((p) => p.uid === a.uid);
    if (pets && rec) {
      rec.diedAt = now;
      this.writePets(a.ownerId, pets);
    }
    this.pushFf(a);
    this.notice(userOf(this.mp, a.ownerId), `${a.name} has died.`);
    this.log(`PetSystem: ${a.name} ${hex(a.id)} of ${hex(a.ownerId)} died`);
  }

  // The pet is gone for good: the body is removed and the record deleted
  private forget(a: Active, reason: string): void {
    this.endTrade(a.id);
    this.active.delete(a.id);
    const pets = this.readPets(a.ownerId);
    let carried: unknown = pets?.find((p) => p.uid === a.uid)?.inventory;
    try { carried = this.mp.get(a.id, "inventory"); } catch { }
    this.rescueNamedItems(a.ownerId, carried);
    try { destroyRef(this.mp, a.id); } catch { }
    if (pets) this.writePets(a.ownerId, pets.filter((p) => p.uid !== a.uid));
    this.save();
    this.sendState(a.ownerId);
    this.log(`PetSystem: ${a.name} ${hex(a.id)} forgotten (${reason})`);
  }

  // Property keys and writings never vanish with a pet; true when any went to the owner's pack
  private rescueNamedItems(ownerId: number, inventory: unknown): boolean {
    const entries = (inventory as Inventory | undefined)?.entries;
    const named = Array.isArray(entries) ? entries.filter((e) => e && isNamedItem(e) && (e.count | 0) > 0).map((e) => withCount(e, e.count | 0)) : [];
    if (!named.length) return false;
    try {
      this.mp.set(ownerId, "inventory", addEntries(readInventory(this.mp, ownerId), named));
      this.log(`PetSystem: ${named.length} named item(s) from a pet moved to ${hex(ownerId)}`);
      return true;
    } catch (e) {
      this.log(`PetSystem: named items for ${hex(ownerId)} could not be moved: ${e}`);
      return false;
    }
  }

  // ── Hooks ────────────────────────────────────────────────────────────────────

  private installHooks(): void {
    const mp = this.mp;
    const chain = (previous: ((...args: unknown[]) => unknown) | null, args: unknown[]): boolean => {
      if (!previous) return true;
      try {
        return previous.apply(mp, args) !== false;
      } catch {
        return true;
      }
    };
    // Only the living owner, or the rider taking it, hosts a pet; a released one is anyone's
    const previousHost = typeof mp.onHostAttempt === "function" ? mp.onHostAttempt : null;
    mp.onHostAttempt = (requesterId: number, actorId: number): boolean => {
      const a = this.active.get(actorId >>> 0);
      if (a) {
        const rider = a.ridingBy || a.pending?.rider || 0;
        return requesterId >>> 0 === (rider || a.ownerId) && isAlive(mp, requesterId >>> 0);
      }
      return chain(previousHost, [requesterId, actorId]);
    };
    // Strangers get nothing from activating a pet; the rider's forced mount activation passes
    const previousActivate = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      // A commanded pet only opens doors, like a companion
      if (this.isPetActor(casterId) && !isDoorRef(mp, targetId >>> 0)) return false;
      const a = this.active.get(targetId >>> 0);
      if (a) {
        const rider = a.ridingBy || a.pending?.rider || 0;
        const caster = casterId >>> 0;
        return caster === a.ownerId || caster === rider;
      }
      return chain(previousActivate, [targetId, casterId]);
    };
  }

  private onOwnerAssigned(actorId: number): void {
    // A ride cut by a restart still names its horse on the changeform
    if (!this.rideOf(actorId)) {
      try { if (this.mp.get(actorId, MOUNT_FF)) this.setFf(actorId, MOUNT_FF, 0); } catch { }
    }
    const pets = this.readPets(actorId);
    if (!pets) return;
    // Nothing survives a logout or a restart in the world, so every record starts stored; one that died is gone for good
    const kept = pets.filter((p) => !p.diedAt || this.active.has(p.actorId));
    for (const p of pets) if (!kept.includes(p)) this.rescueNamedItems(actorId, p.inventory);
    let changed = kept.length !== pets.length;
    for (const p of kept) {
      if (p.actorId && !this.active.has(p.actorId)) {
        p.actorId = 0;
        changed = true;
      }
    }
    if (changed) this.writePets(actorId, kept);
    this.sendState(actorId);
  }

  // Empty when the character may take one more pet, else why not
  private roomFor(actorId: number): string {
    const pets = this.readPets(actorId);
    if (!pets) return "You cannot keep pets.";
    if (this.keptCount(pets) >= this.cfg.petMaxPets) return "You already keep enough pets.";
    if (this.outCount(actorId) >= this.cfg.petMaxOut) return `You cannot have more than ${this.cfg.petMaxOut} pets out.`;
    return "";
  }

  private outCount(ownerId: number): number {
    return this.ownedBy(ownerId).filter((a) => !a.diedAt).length;
  }

  private keptCount(pets: StoredPet[]): number {
    return pets.filter((p) => !p.diedAt).length;
  }

  // Mounting a released horse makes it the rider's
  private adopt(userId: number, actorId: number, id: number): Active | undefined {
    let info: any = null;
    let baseDesc = "";
    try {
      info = this.mp.get(id, PET_PROP);
      baseDesc = String(this.mp.get(id, "baseDesc") ?? "");
    } catch {
      return undefined;
    }
    if (!info || info.kind !== "horse" || !baseDesc || !isAlive(this.mp, id)) return undefined;
    const refusal = this.roomFor(actorId);
    if (refusal) {
      this.notice(userId, refusal);
      return undefined;
    }
    const rec: StoredPet = {
      uid: String(info.uid || this.newUid()), name: String(info.name || "Horse"), kind: "horse", baseDesc, home: "stable",
      homeName: "", actorId: id, harvestAt: 0, createdAt: Date.now(),
    };
    if (!this.writePets(actorId, (this.readPets(actorId) ?? []).concat([rec]))) return undefined;
    this.released.delete(id);
    const a: Active = { id, ownerId: actorId, uid: rec.uid, kind: "horse", name: rec.name, ridingBy: 0, carriedBy: 0, diedAt: 0, fleeSince: 0, ownerAwaySince: 0 };
    this.active.set(id, a);
    try { this.mp.set(id, PET_PROP, { owner: actorId, uid: rec.uid, kind: "horse", name: rec.name }); } catch { }
    this.pushFf(a);
    this.save();
    this.sendState(actorId);
    this.notice(userId, `${rec.name} is yours now.`);
    this.log(`PetSystem: ${hex(actorId)} claimed the released horse ${hex(id)}`);
    return a;
  }

  // ── Records ──────────────────────────────────────────────────────────────────

  // null when the actor is not a character with storage (a form that cannot hold the property)
  private readPets(ownerId: number): StoredPet[] | null {
    let raw: unknown;
    try {
      raw = this.mp.get(ownerId, PETS_PROP);
    } catch {
      return null;
    }
    const list = raw && typeof raw === "object" && Array.isArray((raw as any).list) ? (raw as any).list : [];
    return list.filter((p: any) => p && typeof p.uid === "string" && HOME_OF[p.kind as PetKind]).map((p: any) => ({
      uid: String(p.uid),
      name: String(p.name || ""),
      kind: p.kind as PetKind,
      baseDesc: String(p.baseDesc || ""),
      home: HOME_OF[p.kind as PetKind],
      homeName: String(p.homeName || ""),
      actorId: Number(p.actorId) >>> 0,
      harvestAt: Number(p.harvestAt) || 0,
      diedAt: Number(p.diedAt) || 0,
      inventory: p.inventory,
      createdAt: Number(p.createdAt) || 0,
    }));
  }

  private writePets(ownerId: number, pets: StoredPet[]): boolean {
    try {
      this.mp.set(ownerId, PETS_PROP, { list: pets });
      return true;
    } catch (e) {
      this.log(`PetSystem: pets write failed for ${hex(ownerId)}: ${e}`);
      return false;
    }
  }

  private ownedBy(ownerId: number): Active[] {
    return Array.from(this.active.values()).filter((a) => a.ownerId === ownerId);
  }

  // The requester's own living pet within reach, else a notice and undefined
  private mine(userId: number, actorId: number, target: number): Active | undefined {
    const a = this.active.get(target);
    if (!a || a.ownerId !== actorId) {
      this.notice(userId, "That is not yours.");
      return undefined;
    }
    if (a.diedAt || !isAlive(this.mp, a.id)) {
      this.notice(userId, `${a.name} is dead.`);
      return undefined;
    }
    if (!isNear(this.mp, actorId, a.id, this.cfg.petInteractMaxDistance)) {
      this.notice(userId, "Too far.");
      return undefined;
    }
    return a;
  }

  private sendState(ownerId: number): void {
    const u = userOf(this.mp, ownerId);
    if (u < 0) return;
    const pets = this.readPets(ownerId) ?? [];
    this.send(u, {
      customPacketType: "petState",
      pets: pets.filter((p) => !p.diedAt).map((p) => ({ uid: p.uid, id: p.actorId, name: p.name, kind: p.kind, home: p.home, homeName: p.homeName, out: p.actorId !== 0 })),
    });
  }

  private pushFf(a: Active): void {
    const value: Record<string, unknown> = { kind: a.kind, name: a.name, owner: a.ownerId };
    if (a.diedAt) value["dead"] = true;
    if (a.fleeSince) value["flee"] = true;
    if (a.carriedBy) value["carried"] = a.carriedBy;
    this.setFf(a.id, PET_FF, value);
  }

  // An unregistered property throws on every write, so a missing gamemode line is logged once
  private setFf(id: number, prop: string, value: unknown): void {
    try {
      this.mp.set(id, prop, value);
    } catch (e) {
      if (this.ffWarned.has(prop)) return;
      this.ffWarned.add(prop);
      this.log(`PetSystem: ${prop} write failed, register it in the gamemode (docs_roleplay_pets.md): ${e}`);
    }
  }

  private endTrade(petId: number): void {
    if (this.ctx) this.search.endPetInventory(this.ctx, petId);
  }

  private dropTransfersOf(actorId: number): void {
    for (const [id, t] of Array.from(this.transfers)) {
      if (t.ownerId === actorId || t.recipientId === actorId) {
        clearTimeout(t.timer);
        this.transfers.delete(id);
      }
    }
  }

  // ── Places ───────────────────────────────────────────────────────────────────

  // The name of the place where this kind can be stored if the actor stands near one, else empty
  private homeNear(actorId: number, kind: PetKind): string {
    if (kind === "dog") {
      const home = this.ctx ? this.housing.nearestOwnedRef(this.ctx, actorId) : null;
      return home ? home.name || "your home" : "";
    }
    const anchor = this.anchorNearActor(actorId, HOME_OF[kind] as "stable" | "farm");
    return anchor ? anchor.name : "";
  }

  private homeHint(kind: PetKind): string {
    return kind === "horse" ? "Horses are left at a stable." : kind === "livestock" ? "Livestock is left at a farm." : "Dogs are left at your home.";
  }

  private anchorNearActor(actorId: number, kind: "stable" | "farm"): Anchor | null {
    let cell = "";
    let pos: number[];
    try {
      cell = String(this.mp.get(actorId, "worldOrCellDesc"));
      pos = this.mp.getActorPos(actorId);
    } catch {
      return null;
    }
    return this.anchorNear(cell, pos, kind);
  }

  private anchorNearRef(refrId: number): Anchor | null {
    let cell = "";
    let pos: unknown;
    try {
      cell = String(this.mp.get(refrId, "worldOrCellDesc"));
      pos = this.mp.get(refrId, "pos");
    } catch {
      return null;
    }
    if (!Array.isArray(pos)) return null;
    return this.anchorNear(cell, pos.map(Number), "stable") ?? this.anchorNear(cell, pos.map(Number), "farm");
  }

  private anchorNear(cell: string, pos: number[], kind: "stable" | "farm"): Anchor | null {
    const r2 = this.cfg.petAnchorRadius * this.cfg.petAnchorRadius;
    let best: Anchor | null = null;
    let bestD2 = r2;
    for (const a of this.anchors) {
      if (a.kind !== kind || a.cellOrWorldDesc !== cell) continue;
      const dx = a.pos[0] - pos[0], dy = a.pos[1] - pos[1], dz = a.pos[2] - pos[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= bestD2) {
        best = a;
        bestD2 = d2;
      }
    }
    return best;
  }

  // Either half of a teleport door counts, so the far side of a stable door works too
  private nearRef(actorId: number, refrId: number): boolean {
    return this.sidesOf(refrId).some((id) => this.nearOneRef(actorId, id));
  }

  private sidesOf(refrId: number): number[] {
    return this.ctx ? this.housing.doorSides(this.ctx, refrId) : [refrId];
  }

  private nearOneRef(actorId: number, refrId: number): boolean {
    let a: unknown, b: unknown, cellA = "", cellB = "";
    try {
      a = this.mp.getActorPos(actorId);
      b = this.mp.get(refrId, "pos");
      cellA = String(this.mp.get(actorId, "worldOrCellDesc"));
      cellB = String(this.mp.get(refrId, "worldOrCellDesc"));
    } catch {
      return false;
    }
    if (!Array.isArray(a) || !Array.isArray(b) || cellA !== cellB) return false;
    const dx = Number(a[0]) - Number(b[0]), dy = Number(a[1]) - Number(b[1]), dz = Number(a[2]) - Number(b[2]);
    const max = this.cfg.petInteractMaxDistance * 2;
    return dx * dx + dy * dy + dz * dz <= max * max;
  }

  // ── Bases and products ───────────────────────────────────────────────────────

  // Editor ids from the settings (or the defaults) become descs by a plugin scan, so the load order cannot break them
  private async resolveRecords(all: Record<string, unknown> | null, dataDir: string, loadOrder: string[]): Promise<void> {
    const wanted = new Map<string, string>();
    const rawBases = all?.["petBases"] as Record<string, unknown> | undefined;
    const basesByKind: Record<PetKind, string[]> = { ...DEFAULT_BASES };
    for (const kind of Object.keys(DEFAULT_BASES) as PetKind[]) {
      const list = rawBases?.[kind];
      if (Array.isArray(list) && list.length) basesByKind[kind] = list.map(String);
    }
    const rawItems = all?.["petHarvestItems"] as Record<string, unknown> | undefined;
    const itemsByProduct: Record<string, string[]> = { ...DEFAULT_HARVEST_ITEMS };
    for (const product of Object.keys(DEFAULT_HARVEST_ITEMS)) {
      const v = rawItems?.[product];
      if (typeof v === "string" && v) itemsByProduct[product] = [v];
    }
    const names = new Set<string>();
    for (const kind of Object.keys(basesByKind) as PetKind[]) for (const n of basesByKind[kind]) if (!n.includes(":")) names.add(n);
    for (const product of Object.keys(itemsByProduct)) for (const n of itemsByProduct[product]) if (!n.includes(":")) names.add(n);
    let resolved = new Map<string, string>();
    if (names.size) {
      try {
        const scan = await resolveEditorIds(Array.from(names), dataDir, loadOrder, (line) => this.log(`PetSystem: ${line}`), ["NPC_", "ALCH", "INGR"]);
        resolved = scan.resolved;
        if (scan.unresolved.length) this.log(`PetSystem: unknown editor ids: ${scan.unresolved.join(", ")}`);
      } catch (e) {
        this.log(`PetSystem: plugin scan failed: ${e}`);
      }
    }
    const descOf = (ref: string): string => (ref.includes(":") ? ref : resolved.get(ref.toLowerCase()) ?? "");
    for (const kind of Object.keys(basesByKind) as PetKind[]) {
      const list: PetBaseEntry[] = [];
      for (const ref of basesByKind[kind]) {
        const desc = descOf(ref);
        if (!desc) continue;
        let ok = false;
        try { ok = this.mp.lookupEspmRecordById(this.mp.getIdFromDesc(desc))?.record?.type === "NPC_"; } catch { }
        if (!ok) continue;
        const editorId = this.editorIdOf(desc) || ref;
        list.push({ desc, editorId, name: baseLabel(editorId) });
      }
      this.bases.set(kind, list);
      wanted.set(kind, list.map((b) => b.editorId).join(", ") || "none");
    }
    for (const product of Object.keys(itemsByProduct)) {
      const desc = itemsByProduct[product].map(descOf).find((d) => !!d);
      if (desc) this.harvestItems.set(product, desc);
      else this.log(`PetSystem: no item found for ${product}, harvesting it gives nothing`);
    }
    this.log(`PetSystem: bases horse [${wanted.get("horse")}], livestock [${wanted.get("livestock")}], dog [${wanted.get("dog")}]; ${this.anchors.length} stable/farm anchors`);
  }

  private editorIdOf(baseDesc: string): string {
    try {
      return String(this.mp.lookupEspmRecordById(this.mp.getIdFromDesc(baseDesc))?.record?.editorId ?? "");
    } catch {
      return "";
    }
  }

  private productOf(baseDesc: string): string {
    const editorId = this.editorIdOf(baseDesc);
    return HARVEST_RULES.find((r) => r.match.test(editorId))?.product ?? "";
  }

  private speciesOf(editorId: string, kind: PetKind): string {
    const m = /horse|cow|goat|chicken|hen|dog|husky|wolf/i.exec(editorId);
    if (!m) return KIND_LABEL[kind];
    const word = m[0].toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  private newUid(): string {
    return `${Date.now().toString(36)}${(++this.uidCounter).toString(36)}`;
  }

  // ── Registry: only which actors of this run to remove at the next boot ───────

  private loadRegistry(): void {
    let saved: { active?: unknown; released?: unknown } = {};
    try { saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) ?? {}; } catch { }
    const ids = (Array.isArray(saved.active) ? saved.active : []).concat(Array.isArray(saved.released) ? saved.released : []);
    this.leftovers = ids.map((id: unknown) => Number(id) >>> 0).filter((id: number) => id > 0);
    if (this.leftovers.length) this.log(`PetSystem: ${this.leftovers.length} pet(s) from the previous run to remove`);
    this.save();
  }

  // Owners were logged out by the restart, so every pet of the previous run goes back to storage
  private removeLeftovers(): void {
    const ids = this.leftovers;
    if (!ids.length) return;
    this.leftovers = [];
    const removed = destroyLeftovers(this.mp, ids, (id) => !!this.mp.get(id, PET_PROP));
    this.log(`PetSystem: removed ${removed}/${ids.length} pet(s) from the previous run`);
    this.save();
  }

  private save(): void {
    const registry = { active: Array.from(this.active.keys()).concat(this.leftovers), released: Array.from(this.released.keys()) };
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry)); }
    catch (e) { this.log(`PetSystem: registry write failed: ${e}`); }
  }

  // ── Packets ──────────────────────────────────────────────────────────────────

  private send(userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { this.mp.sendCustomPacket(userId, JSON.stringify(payload)); } catch { }
  }

  private notice(userId: number, text: string): void {
    this.send(userId, { customPacketType: "notification", text });
  }
}
