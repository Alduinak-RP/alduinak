import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT, CHARACTER_LIST_EVENT, CHARACTER_RETIRED_EVENT, ACCESS_REFRESHED_EVENT } from "./system";
import { filterAccessForSlot } from "../backendFactionApi";
import { validateResult, CharCreatorConfig } from "./charCreatorData";
import { scanModHair, ModHairCatalog } from "./hairCatalog";
import { DEFAULT_START_LOCATIONS, INTRO_PAGES, INTRO_QUESTION, StartLocation, arrivalPos, parseStartLocations } from "./startLocations";
import { kickWithReason } from "./kickUtil";
import { REALMS, afterlifeOf, isFallen, readMaxCharacters } from "./afterlifeSystem";
import { chainMpHook, hex, isAlive, isBleedingOut, isCreationPending, isPlayerActor, userOf, weaponAnimType } from "./actorUtil";
import { isRestrained } from "./captureSystem";
import { isOutsideBorder, insideSpot } from "./worldBorder";

type Mp = any;

function randomInteger(min: number, max: number) {
  const rand = min + Math.random() * (max + 1 - min);
  return Math.floor(rand);
}

// Slot indices a character may keep; each fallen character opens one more slot up to this
const MAX_SLOTS = 10;

// Fresh characters start with a miner's outfit (Skyrim.esm: ClothesMinerClothes, ClothesMinerBoots); the gold comes with the first profession kit.
// Overridable via the "startingItems" server setting.
const DEFAULT_STARTING_ITEMS = [
  { baseId: 0x00080697, count: 1 },
  { baseId: 0x00080699, count: 1 },
];

// Parse a base id that may arrive as a decimal number or a "0x..." hex string
const toBaseId = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v >>> 0;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n >>> 0;
  }
  return null;
};

// Validate a "startingItems" setting into {baseId,count} stacks; null if absent or malformed
export function parseStartingItems(raw: unknown): { baseId: number; count: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { baseId: number; count: number }[] = [];
  for (const e of raw) {
    const baseId = toBaseId((e as { baseId?: unknown })?.baseId);
    const count = Number((e as { count?: unknown })?.count);
    if (baseId === null || !Number.isInteger(count) || count <= 0) return null;
    out.push({ baseId, count });
  }
  return out.length ? out : null;
}

// One kit per profile+slot, persisted so delete/recreate cycling can't farm gold
const STARTER_GRANTS_FILE = "./starter-grants.json";

// characterSelectMenuRequest guards: rapid repeats are ignored, and a request right after actor assign is treated as a stale client menu event
const REQUEST_COOLDOWN_MS = 15 * 1000;
const ASSIGN_GRACE_MS = 10 * 1000;

// Logout grace: the body stays in the world this long after disconnect/menu quit/character switch, so combat logging leaves a killable body; re-selecting cancels it
// Overridable via the "logoutGraceMs" server setting.
const DEFAULT_LOGOUT_GRACE_MS = 5 * 60 * 1000;
// The parked body sits down for the grace (the emote wheel's Sit Crossed); overridable via "logoutPose", "" for none
const DEFAULT_LOGOUT_POSE = "IdleSitCrossLeggedEnter";
// Broadcast to the parked body's viewers when it is picked again, so their copies stand up and get their collision back
const UNPARK_POSE = "IdleForceDefaultState";

const DEFAULT_STAT_POOL = 120;

// Wearable kit items are equipped through Papyrus snippets shortly after the inventory update lands
const EQUIP_KIT_DELAY_MS = 1500;
// A fresh spawn strips the player (empty equipment changeForm), so the kit is dressed again once the client settled
const EQUIP_KIT_SPAWN_DELAY_MS = 5000;
// Worn weapons are unequipped this long after a respawn, once the client's get-up is over
const RESPAWN_UNEQUIP_DELAY_MS = 3000;

// Character creator settings ("charCreator" server setting); disabled keeps the vanilla race menu
interface CharCreatorSettings {
  enabled: boolean;
  allowChildren: boolean;
  disabledRaces: string[];
  paywalledRaces: Record<string, string>;
  grants: Record<string, string[]>;
  statPool: number;
}

function parseCharCreatorSettings(raw: unknown): CharCreatorSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
  const paywalledRaces: Record<string, string> = {};
  if (r.paywalledRaces && typeof r.paywalledRaces === "object") {
    for (const [race, key] of Object.entries(r.paywalledRaces)) {
      if (typeof key === "string") paywalledRaces[race] = key;
    }
  }
  const grants: Record<string, string[]> = {};
  if (r.grants && typeof r.grants === "object") {
    for (const [profileId, keys] of Object.entries(r.grants)) {
      grants[profileId] = strings(keys);
    }
  }
  const rawPool = Number(r.statPool);
  return {
    enabled: !!r.enabled,
    allowChildren: r.allowChildren !== false,
    disabledRaces: strings(r.disabledRaces),
    paywalledRaces,
    grants,
    statPool: Number.isInteger(rawPool) && rawPool >= 0 ? rawPool : DEFAULT_STAT_POOL,
  };
}

// Character-select protocol (gated by the "characterSelect" server setting;
// living characters via "characterSelectMaxCharacters", 1-10, default 3; each fallen character adds a slot).
// When enabled the server no longer auto-spawns on connect; it sends the player
// their character slots and waits for a selection (matches the client's
// CharacterSelectService). Flag off (default) keeps the original
// single-character behaviour, so enabling can never brick login on its own.
//   Server -> Client:
//     { customPacketType: "characterSelectMenu", maxCharacters, characters: [ {name,info,dead} | null ], lockedSlots, intro?: {pages, question, locations: [{id,label}]}, notice?: "why the last choice was refused" }
//   Client -> Server:
//     { customPacketType: "characterSelectResult", action: "play"|"create"|"delete", slot, start?: locationId }
//     { customPacketType: "characterSelectMenuRequest", loadError?: string, viaPauseMenu?: boolean }
export class Spawn implements System {
  systemName = "Spawn";
  constructor(private log: Log) { }

  private characterSelect = false;
  private maxCharacters = readMaxCharacters(null);
  private startingItems = DEFAULT_STARTING_ITEMS;
  private startLocations = DEFAULT_START_LOCATIONS;
  private logoutGraceMs = DEFAULT_LOGOUT_GRACE_MS;
  private logoutPose = DEFAULT_LOGOUT_POSE;
  private charCreator = parseCharCreatorSettings(undefined);
  private modHair: ModHairCatalog | null = null;
  private settingsObject!: Settings;
  // userId -> auth context awaiting a character selection
  private pending = new Map<number, { profileId: number; roles: string[]; discordId?: string; access?: unknown }>();
  // userId -> last resolved auth context, kept for the whole connection so the menu can reopen after a mid-session quit to main menu
  private authCache = new Map<number, { profileId: number; roles: string[]; discordId?: string; access?: unknown }>();
  // userId -> timestamps backing the onMenuRequest anti-abuse guards
  private lastMenuRequestMs = new Map<number, number>();
  private lastAssignMs = new Map<number, number>();
  // actorId -> pending logout-grace despawn timer; keyed by actor since userIds are recycled across connections, actor form ids are not
  private parkTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // Bodies sitting in the logout pose
  private parked = new Set<number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.settingsObject = await Settings.get();
    this.characterSelect = !!(this.settingsObject.allSettings &&
      (this.settingsObject.allSettings as Record<string, unknown>)["characterSelect"]);
    const all = this.settingsObject.allSettings as Record<string, unknown> | null;
    this.maxCharacters = readMaxCharacters(all);
    const parsedItems = parseStartingItems(all?.["startingItems"]);
    if (parsedItems) this.startingItems = parsedItems;
    if (all?.["startLocations"] !== undefined) {
      const parsedStarts = parseStartLocations(all["startLocations"]);
      if (parsedStarts) this.startLocations = parsedStarts;
      else this.log("[spawn] startLocations setting is malformed, using the default start locations");
    }
    const rawGrace = Number(all?.["logoutGraceMs"]);
    if (Number.isInteger(rawGrace) && rawGrace >= 0) this.logoutGraceMs = rawGrace;
    if (typeof all?.["logoutPose"] === "string") this.logoutPose = (all["logoutPose"] as string).trim();
    this.charCreator = parseCharCreatorSettings(all?.["charCreator"]);
    if (this.charCreator.enabled) this.loadModHair();
    this.installAppearanceHook(ctx);
    this.installEquipmentHook(ctx);
    this.installCreationDamageHook(ctx);
    this.installRespawnHook(ctx);

    const listenerFn = (userId: number, userProfileId: number, discordRoleIds: string[], discordId?: string, access?: unknown) => {
      if (this.characterSelect) {
        const auth = { profileId: userProfileId, roles: discordRoleIds, discordId, access };
        this.authCache.set(userId, auth);
        this.pending.set(userId, auth);
        this.sendCharacterList(ctx, userId, userProfileId);
        return;
      }
      this.legacySpawn(ctx, userId, userProfileId, discordRoleIds, discordId, access);
    };
    ctx.gm.on("spawnAllowed", listenerFn);
    (ctx.svr as any)._onSpawnAllowed = listenerFn;
    // In-game faction changes replace the access cached at login, so the next character select applies them
    ctx.gm.on(ACCESS_REFRESHED_EVENT, (profileId: number, access: unknown) => {
      for (const auth of [...this.authCache.values(), ...this.pending.values()]) {
        if (auth.profileId === profileId) auth.access = access;
      }
    });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type === "charCreatorResult") {
      this.onCharCreatorResult(ctx, userId, content);
      return;
    }
    if (!this.characterSelect) return;
    if (type === "characterSelectResult") {
      const slot = Number(content.slot);
      if (content.action === "delete") this.onDeleteCharacter(ctx, userId, slot);
      else this.onSelectCharacter(ctx, userId, slot, content.start);   // "play" or "create"
    } else if (type === "characterSelectMenuRequest") {
      this.onMenuRequest(ctx, userId, content);
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    this.pending.delete(userId);
    this.authCache.delete(userId);
    this.lastMenuRequestMs.delete(userId);
    this.lastAssignMs.delete(userId);
    // Logout grace: parkTimers is actorId-keyed and deliberately NOT cleaned here, the timer must outlive the connection; re-selecting the character cancels it
    try {
      const actorId = ctx.svr.getUserActor(userId);
      if (actorId !== 0) {
        this.schedulePark(ctx, actorId);
      }
    } catch { /* form vanished */ }
  }

  // Disable the body after the logout grace unless re-selected first; also detaches a still-connected owner when firing, since re-selecting a DISABLED actor while still mapped would stream CreateActor(isMe) twice
  private schedulePark(ctx: SystemContext, actorId: number): void {
    this.cancelPark(actorId);
    const handle = setTimeout(() => {
      this.parkTimers.delete(actorId);
      this.parked.delete(actorId);
      try {
        ctx.svr.setEnabled(actorId, false);
        const userId = ctx.svr.getUserByActor(actorId);
        if (userId >= 0 && userId < 0xffff && ctx.svr.getUserActor(userId) === actorId) {
          ctx.svr.setUserActor(userId, 0);
        }
        this.log("Logout grace expired, actor", actorId.toString(16), "despawned");
      } catch { /* form vanished */ }
    }, this.logoutGraceMs);
    this.parkTimers.set(actorId, handle);
    this.parkPose(ctx, actorId);
  }

  // Sits the lingering body down for everyone who sees it; a downed, bound or carried body keeps its pose, and re-selecting clears it
  private parkPose(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as Mp;
    if (!this.logoutPose || !isAlive(mp, actorId) || isBleedingOut(mp, actorId) || isRestrained(mp, actorId)) return;
    try {
      mp.set(actorId, "lastAnimEvent", this.logoutPose);
      this.parked.add(actorId);
      this.log(`[spawn] ${hex(actorId)} parked in ${this.logoutPose}`);
    } catch (e) {
      this.log(`[spawn] parking pose of ${hex(actorId)} failed: ${e}`);
    }
  }

  // Runs before setUserActor: the stand-up reaches everyone who sees the parked body, then the cleared event keeps the sit pose out of the CreateActor
  private unpark(ctx: SystemContext, actorId: number): void {
    if (!this.parked.delete(actorId)) return;
    const mp = ctx.svr as Mp;
    try {
      mp.set(actorId, "lastAnimEvent", UNPARK_POSE);
      mp.set(actorId, "lastAnimEvent", "");
      this.log(`[spawn] ${hex(actorId)} unparked`);
    } catch (e) {
      this.log(`[spawn] unparking ${hex(actorId)} failed: ${e}`);
    }
  }

  private cancelPark(actorId: number): void {
    const handle = this.parkTimers.get(actorId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.parkTimers.delete(actorId);
    }
  }

  // Players it returns true for may stay outside the border
  exempt: ((mp: Mp, actorId: number) => boolean) | null = null;

  // Runs before setUserActor, so the client's loadGame already gets the spot inside
  private bringInsideBorder(mp: Mp, actorId: number): void {
    try {
      const loc = mp.get(actorId, "locationalData");
      if (!loc || !isOutsideBorder(mp, loc) || this.exempt?.(mp, actorId)) return;
      const spot = insideSpot(mp, actorId, loc, this.startLocations.length ? this.startLocations : DEFAULT_START_LOCATIONS);
      if (!spot) return;
      mp.set(actorId, "locationalData", spot);
      this.log(`[spawn] ${hex(actorId)} was saved outside the border, placed at ${spot.pos.map(Math.round).join(",")}`);
    } catch (e) {
      this.log(`[spawn] border check of ${hex(actorId)} failed: ${e}`);
    }
  }

  // Sent when the player quits to the main menu: reopen the selection menu and start logout grace on the current body (it stays in the world, so quitting is never an instant combat escape)
  // Rapid repeats or requests right after actor assign skip the grace scheduling: packet spam / stale menu events must not park a body that is being played
  private onMenuRequest(ctx: SystemContext, userId: number, content: Content): void {
    const auth = this.authCache.get(userId);
    if (!auth) return; // not authenticated yet
    if (typeof content.loadError === "string") {
      this.log(`[spawn] user ${userId} (profile ${auth.profileId}) could not load the world: ${content.loadError.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300)}`);
    }
    if (!this.pending.has(userId)) {
      const now = Date.now();
      const mayPark = now - (this.lastMenuRequestMs.get(userId) ?? 0) >= REQUEST_COOLDOWN_MS &&
        now - (this.lastAssignMs.get(userId) ?? 0) >= ASSIGN_GRACE_MS;
      this.lastMenuRequestMs.set(userId, now);
      if (mayPark) {
        try {
          const actorId = ctx.svr.getUserActor(userId);
          if (actorId !== 0) {
            this.schedulePark(ctx, actorId);
            ctx.gm.emit(USER_MENU_QUIT_EVENT, userId, actorId);
          }
        } catch { /* form vanished */ }
      }
      this.pending.set(userId, auth);
      const via = content.viaPauseMenu === true ? " via the pause menu" : content.viaPauseMenu === false ? " without the pause menu" : "";
      this.log("Reopening character select for user", userId, (mayPark ? "(logout grace started)" : "(guarded, no grace timer)") + via);
    }
    this.sendCharacterList(ctx, userId, auth.profileId);
  }

  // Character select

  // The gamemode reads these private props off the character; mirror the master-api profile onto the actor so dashboard ranks resolve in-game
  private setSkympProps(mp: Mp, actorId: number, profileId: number, discordId?: string, access?: unknown): void {
    try {
      mp.set(actorId, "private.skympProfileId", profileId);
      if (discordId !== undefined && discordId !== null) {
        mp.set(actorId, "private.skympDiscordId", discordId);
      }
      if (access !== undefined && access !== null) {
        mp.set(actorId, "private.skympAccess", access);
      }
    } catch { /* form vanished */ }
  }

  // Mirror the resolved auth context onto the actor; indexed.discordId is only rewritten when it actually changes, keeping the private index stable
  private applyAuthProps(mp: Mp, actorId: number, profileId: number,
    roles: string[], discordId?: string, access?: unknown): void {
    mp.set(actorId, "private.discordRoles", roles);
    if (discordId !== undefined &&
      mp.get(actorId, "private.indexed.discordId") !== discordId) {
      mp.set(actorId, "private.indexed.discordId", discordId);
    }
    this.setSkympProps(mp, actorId, profileId, discordId, access);
  }

  private characterName(ctx: SystemContext, actorId: number): string {
    try {
      const n = ctx.svr.getActorName(actorId);
      return typeof n === "string" ? n.trim() : "";
    } catch { return ""; }
  }

  // Characters never change slot, since faction rows, character names and starter grants are keyed by it
  private slotMap(ctx: SystemContext, profileId: number): (number | undefined)[] {
    const mp = ctx.svr as unknown as Mp;
    const taken: (number | undefined)[] = [];
    const unassigned: number[] = [];
    let fallen = 0;
    for (const a of ctx.svr.getActorsByProfileId(profileId)) {
      // Crash handle for deleting characters
      let s: unknown;
      try { s = mp.get(a, "private.charSlot"); }
      catch { continue; }
      if (isFallen(mp, a)) fallen++;
      if (Number.isInteger(s) && (s as number) >= 0 && (s as number) < MAX_SLOTS && taken[s as number] === undefined) {
        taken[s as number] = a;
      } else {
        unassigned.push(a);
      }
    }
    const size = Math.min(MAX_SLOTS, Math.max(this.maxCharacters + fallen, taken.length));
    const slots = Array.from({ length: size }, (_, i) => taken[i]);
    for (const a of unassigned) {
      let free = slots.indexOf(undefined);
      if (free < 0 && slots.length < MAX_SLOTS) free = slots.push(undefined) - 1;
      if (free < 0) break;
      slots[free] = a;
      try { mp.set(a, "private.charSlot", free); } catch { /* form vanished */ }
    }
    return slots;
  }

  // Fallen characters do not count against the living limit
  private canCreate(mp: Mp, slots: (number | undefined)[]): boolean {
    return slots.filter((a) => a !== undefined && !isFallen(mp, a)).length < this.maxCharacters;
  }

  private isPermaDead(mp: Mp, actorId: number): boolean {
    try { return mp.get(actorId, "private.permaDead") === true; }
    catch { return false; }
  }

  // Replaces the Player record's default inventory every new actor is seeded with.
  // One kit per profile+slot: recreating a deleted character reuses the slot and gets the clothes again, but gold listed in startingItems only once.
  private giveStartingItems(mp: Mp, actorId: number, profileId: number, slot: number): void {
    const key = `${profileId}:${slot}`;
    const granted = this.loadStarterGrants();
    const items = granted[key]
      ? this.startingItems.filter(e => e.baseId !== 0x0000000f)
      : this.startingItems;
    try { mp.set(actorId, "inventory", { entries: items.map(e => ({ ...e })) }); }
    catch { /* form vanished */ }
    if (!granted[key]) {
      granted[key] = true;
      try { fs.writeFileSync(STARTER_GRANTS_FILE, JSON.stringify(granted)); }
      catch (e) { this.log(`[spawn] starter-grants write failed: ${e}`); }
    }
  }

  private loadStarterGrants(): Record<string, boolean> {
    try {
      const parsed = JSON.parse(fs.readFileSync(STARTER_GRANTS_FILE, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  // notice is shown above the slot list, so a refused choice never looks like nothing happened
  private sendCharacterList(ctx: SystemContext, userId: number, profileId: number, notice = ""): void {
    const mp = ctx.svr as unknown as Mp;
    const slots = this.slotMap(ctx, profileId);
    const characters = slots.map((actorId, i) => {
      if (actorId === undefined) return null;
      const name = this.characterName(ctx, actorId) || `Character ${i + 1}`;
      const realm = afterlifeOf(mp, actorId);
      return realm ? { name, dead: false, info: `In ${REALMS[realm].label}` } : { name, dead: this.isPermaDead(mp, actorId) };
    });
    const lockedSlots = this.canCreate(mp, slots) ? [] : slots.flatMap((a, i) => (a === undefined ? [i] : []));
    const intro = this.startLocations.length
      ? { pages: INTRO_PAGES, question: INTRO_QUESTION, locations: this.startLocations.map(({ id, label }) => ({ id, label })) }
      : undefined;
    ctx.gm.emit(CHARACTER_LIST_EVENT, profileId, slots
      .map((actorId, slot) => (actorId === undefined ? null : { slot, actorId, dead: isFallen(mp, actorId) }))
      .filter((e) => e !== null));
    ctx.svr.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "characterSelectMenu", maxCharacters: slots.length, characters, lockedSlots, intro,
      ...(notice ? { notice } : {}),
    }));
  }

  private randomStartPoint(): { pos: number[]; angleZ: number; worldOrCell: number } {
    const { startPoints } = this.settingsObject;
    const point = startPoints[randomInteger(0, startPoints.length - 1)];
    return { pos: point.pos, angleZ: point.angleZ, worldOrCell: +point.worldOrCell };
  }

  private onSelectCharacter(ctx: SystemContext, userId: number, slot: number, start: unknown): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0) return;

    const mp = ctx.svr as unknown as Mp;
    const slots = this.slotMap(ctx, auth.profileId);
    if (slot >= slots.length) return;
    let actorId = slots[slot];
    const isNew = actorId === undefined;

    // Permanently dead characters are locked: the body remains in the world but can never be played again
    if (!isNew && actorId !== undefined && this.isPermaDead(mp, actorId)) {
      this.log("Refusing to play permanently dead character", actorId.toString(16), "in slot", slot);
      this.sendCharacterList(ctx, userId, auth.profileId, "That character is dead.");
      return;
    }

    if (isNew && !this.canCreate(mp, slots)) {
      this.log(`Refusing character creation in slot ${slot} for profile ${auth.profileId}: living limit reached`);
      this.sendCharacterList(ctx, userId, auth.profileId, "You already have the maximum number of living characters.");
      return;
    }

    if (isNew) {
      // The intro's choice is the only way in while start locations are configured; coordinates never come from the client
      let loc: StartLocation | undefined;
      if (this.startLocations.length) {
        loc = this.startLocations.find((l) => l.id === start);
        if (!loc) {
          // A client that never showed the intro sends none, and would sit on this refusal forever
          if (start === undefined) {
            this.log("Kicking user", userId, "on character creation: the client sent no start location, its files are out of date");
            kickWithReason(mp, userId, "Your game files are out of date, so this server cannot create your character. Open the Alduinak launcher, run Repair SkyMP Client in Settings, then play again.");
            return;
          }
          this.log("Refusing character creation in slot", slot, "with unknown start location", String(start).slice(0, 64));
          this.sendCharacterList(ctx, userId, auth.profileId, "Unknown start location, try again.");
          return;
        }
      }
      const point = loc ? { pos: arrivalPos(loc), angleZ: loc.angleZ, worldOrCell: loc.worldOrCell } : this.randomStartPoint();
      actorId = ctx.svr.createActor(0, point.pos, point.angleZ, point.worldOrCell, auth.profileId);
      mp.set(actorId, "private.charSlot", slot);
      this.giveStartingItems(mp, actorId, auth.profileId, slot);
      mp.set(actorId, "private.kitPending", true);
      mp.set(actorId, "private.creationPending", true);
      if (loc) mp.set(actorId, "private.startLocation", { id: loc.id, at: Date.now() });
      this.log("Creating character", actorId.toString(16), "in slot", slot, loc ? `at ${loc.id}` : "at a start point");
    } else {
      this.log("Loading character", actorId.toString(16), "from slot", slot);
    }
    this.scheduleKit(ctx, actorId, EQUIP_KIT_SPAWN_DELAY_MS);

    // Other slots despawn via logout grace too (switching must not vanish the previous body instantly); bodies already under a running grace keep their timer
    for (const other of slots) {
      if (other !== undefined && other !== actorId) {
        if (!this.parkTimers.has(other)) {
          this.schedulePark(ctx, other);
        }
      }
    }

    // Selecting the character cancels its pending logout-grace despawn; enable BEFORE setUserActor, PartOne throws on disabled actors
    this.cancelPark(actorId);
    this.unpark(ctx, actorId);
    ctx.svr.setEnabled(actorId, true);
    if (!isNew) this.bringInsideBorder(mp, actorId);
    ctx.svr.setUserActor(userId, actorId);
    if (isNew) {
      if (this.charCreator.enabled) {
        mp.set(actorId, "private.charCreatorPending", true);
        this.sendCharCreatorOpen(ctx, userId, auth.profileId, actorId);
      } else {
        ctx.svr.setRaceMenuOpen(actorId, true);
      }
    } else if (this.charCreator.enabled && this.isCharCreatorPending(mp, actorId)) {
      // Relog protection: an unfinished creator reopens until a submission is accepted
      this.sendCharCreatorOpen(ctx, userId, auth.profileId, actorId);
    }

    this.applyAuthProps(mp, actorId, auth.profileId, auth.roles, auth.discordId,
      filterAccessForSlot(auth.access, slot));

    ctx.gm.emit("userAssignActor", userId, actorId);
    // Gamemode store re-sync: re-runs its connect chain when a switch assigns a new body
    (ctx.svr as any).onUserAssignActor?.(userId, actorId);

    this.lastAssignMs.set(userId, Date.now());
    this.pending.delete(userId);
  }

  // Character creator (gated by the "charCreator" server setting; see docs/character-creator.md)

  // Paywalled races this profile has not been granted
  private lockedRacesFor(profileId: number | undefined): string[] {
    const granted = profileId !== undefined ? this.charCreator.grants[String(profileId)] ?? [] : [];
    return Object.entries(this.charCreator.paywalledRaces)
      .filter(([, entitlement]) => !granted.includes(entitlement))
      .map(([race]) => race);
  }

  private isCharCreatorPending(mp: Mp, actorId: number): boolean {
    try { return !!mp.get(actorId, "private.charCreatorPending"); }
    catch { return false; }
  }

  // private.kitPending: set at creation, cleared once the client reports a worn kit item
  private isKitPending(mp: Mp, actorId: number): boolean {
    try { return mp.get(actorId, "private.kitPending") === true; }
    catch { return false; }
  }

  // Vanilla race menu path: an accepted appearance (isRaceMenuOpen) is the creation-finished moment
  private installAppearanceHook(ctx: SystemContext): void {
    const mp = ctx.svr as unknown as Mp;
    const previous = typeof mp.onUpdateAppearanceAttempt === "function" ? mp.onUpdateAppearanceAttempt : null;
    mp.onUpdateAppearanceAttempt = (actorId: number, appearance: unknown, isAllowed: boolean): boolean => {
      if (isAllowed && isCreationPending(mp, actorId >>> 0)) {
        try { this.finishCreation(ctx, actorId >>> 0); }
        catch (e) { this.log(`[spawn] finishCreation failed: ${e}`); }
      }
      if (!previous) return true;
      try { return previous.call(mp, actorId, appearance, isAllowed) !== false; }
      catch { return true; }
    };
  }

  // Unfinished characters neither take nor deal weapon and spell damage; chained like the admin god mode
  private installCreationDamageHook(ctx: SystemContext): void {
    const mp = ctx.svr as unknown as Mp;
    const previous = typeof mp.onHitDamageAttempt === "function" ? mp.onHitDamageAttempt : null;
    mp.onHitDamageAttempt = (aggressorId: number, targetId: number, sourceId: number, damage: number): boolean => {
      if (isCreationPending(mp, targetId >>> 0) || isCreationPending(mp, aggressorId >>> 0)) return false;
      if (!previous) return true;
      try { return previous.call(mp, aggressorId, targetId, sourceId, damage) !== false; }
      catch { return true; }
    };
  }

  // The worn state only persists through the client's equipment report, so the kit stays pending until one shows it
  private installEquipmentHook(ctx: SystemContext): void {
    const mp = ctx.svr as unknown as Mp;
    const previous = typeof mp.onUpdateEquipmentAttempt === "function" ? mp.onUpdateEquipmentAttempt : null;
    mp.onUpdateEquipmentAttempt = (actorId: number, equipment: unknown, isAllowed: boolean): boolean => {
      try {
        if (isAllowed && this.isKitPending(mp, actorId >>> 0) && this.wearsKit(equipment)) {
          mp.set(actorId >>> 0, "private.kitPending", false);
        }
      } catch (e) { this.log(`[spawn] kit check failed: ${e}`); }
      if (!previous) return true;
      try { return previous.call(mp, actorId, equipment, isAllowed) !== false; }
      catch { return true; }
    };
  }

  // The ragdoll death and the get-up leave the hands' behaviour graph stale while the weapon stays worn, so worn weapons are unequipped through the owner's client
  private installRespawnHook(ctx: SystemContext): void {
    const mp = ctx.svr as unknown as Mp;
    chainMpHook(mp, "onRespawn", (rawId: number) => {
      const actorId = Number(rawId) >>> 0;
      if (isPlayerActor(mp, actorId)) setTimeout(() => this.unequipWeapons(mp, actorId), RESPAWN_UNEQUIP_DELAY_MS);
    });
  }

  private unequipWeapons(mp: Mp, actorId: number): void {
    if (userOf(mp, actorId) < 0) return;
    let entries: any[] = [];
    try { entries = mp.get(actorId, "equipment")?.inv?.entries ?? []; } catch { return; }
    const worn = entries.filter((e) => (e?.worn || e?.wornLeft) && weaponAnimType(mp, Number(e.baseId)) >= 0);
    if (!worn.length) return;
    for (const e of worn) {
      try {
        const self = { type: "form", desc: mp.getDescFromId(actorId) };
        const item = { type: "espm", desc: mp.getDescFromId(Number(e.baseId) >>> 0) };
        // UnequipItem(akItem, abPreventEquip, abSilent)
        mp.callPapyrusFunction("method", "Actor", "UnequipItem", self, [item, false, true]);
      } catch (err) {
        this.log(`[respawn] unequip ${hex(Number(e.baseId))} of ${hex(actorId)} failed: ${err}`);
      }
    }
    this.log(`[respawn] ${hex(actorId)} sheathes ${worn.length} weapon(s)`);
  }

  private wearsKit(equipment: unknown): boolean {
    const kitIds = new Set(this.startingItems.map((e) => e.baseId));
    const entries = (equipment as { inv?: { entries?: unknown } })?.inv?.entries;
    if (!Array.isArray(entries)) return false;
    return entries.some((e: { baseId?: unknown; worn?: unknown; wornLeft?: unknown }) =>
      (e?.worn === true || e?.wornLeft === true) && kitIds.has(toBaseId(e?.baseId) ?? -1));
  }

  // A fresh character keeps only the starter kit and wears it; spells are governed by playersInheritBaseSpells
  private finishCreation(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as unknown as Mp;
    const kitIds = new Set(this.startingItems.map((e) => e.baseId));
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = Array.isArray(inv?.entries)
        ? inv.entries.filter((e: { baseId?: unknown }) => kitIds.has(toBaseId(e?.baseId) ?? -1))
        : [];
      // Re-sent even when unchanged so the client reconciles its save-game default gear against it
      mp.set(actorId, "inventory", { entries });
      mp.set(actorId, "private.charCreatorPending", false);
      mp.set(actorId, "private.creationPending", false);
      // The race menu may have stripped the kit again, so it is dressed once more
      mp.set(actorId, "private.kitPending", true);
    } catch { return; /* form vanished */ }
    this.scheduleKit(ctx, actorId, EQUIP_KIT_DELAY_MS);
    this.log("Character creation finished for actor", actorId.toString(16));
  }

  private scheduleKit(ctx: SystemContext, actorId: number, delayMs: number): void {
    const mp = ctx.svr as unknown as Mp;
    if (!this.isKitPending(mp, actorId)) return;
    setTimeout(() => this.equipKit(ctx, actorId), delayMs);
  }

  // EquipItem(akItem, abPreventRemoval, abSilent): the snippet runs on the owner's client, whose equip event syncs back
  private equipKit(ctx: SystemContext, actorId: number): void {
    const mp = ctx.svr as unknown as Mp;
    if (!this.isKitPending(mp, actorId)) return;
    const wearable = this.startingItems.filter((e) => this.isWearable(mp, e.baseId));
    if (wearable.length === 0) {
      try { mp.set(actorId, "private.kitPending", false); } catch { /* form vanished */ }
      return;
    }
    for (const e of wearable) {
      try {
        const self = { type: "form", desc: mp.getDescFromId(actorId) };
        const item = { type: "espm", desc: mp.getDescFromId(e.baseId) };
        mp.callPapyrusFunction("method", "Actor", "EquipItem", self, [item, false, true]);
      } catch (err) {
        this.log(`[spawn] equip kit item ${e.baseId.toString(16)} failed: ${err}`);
      }
    }
  }

  private wearableCache = new Map<number, boolean>();
  private isWearable(mp: Mp, baseId: number): boolean {
    const cached = this.wearableCache.get(baseId);
    if (cached !== undefined) return cached;
    let wearable = false;
    try {
      const rec = mp.lookupEspmRecordById(baseId);
      const type = String(rec?.record?.type ?? "");
      wearable = type === "ARMO" || type === "WEAP";
    } catch { /* not an espm record */ }
    this.wearableCache.set(baseId, wearable);
    return wearable;
  }

  // Background scan; creators opened before it finishes offer vanilla hair only
  private loadModHair(): void {
    const s = this.settingsObject;
    scanModHair(s.dataDir, s.loadOrder, (line) => this.log(line))
      .then((catalog) => {
        this.modHair = catalog;
        this.log(`[spawn] charCreator: ${catalog.hairs.length} mod hairs from the load order`);
      })
      .catch((e) => this.log(`[spawn] charCreator: mod hair scan failed: ${e}`));
  }

  private sendCharCreatorOpen(ctx: SystemContext, userId: number, profileId: number, actorId: number): void {
    this.log("Character creator opened for actor", actorId.toString(16), "profile", profileId);
    ctx.svr.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "charCreatorOpen",
      config: {
        disabledRaces: this.charCreator.disabledRaces,
        lockedRaces: this.lockedRacesFor(profileId),
        allowChildren: this.charCreator.allowChildren,
        statPool: this.charCreator.statPool,
        modHair: this.modHair ?? undefined,
      },
    }));
  }

  private sendCharCreatorError(ctx: SystemContext, userId: number, message: string): void {
    ctx.svr.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "charCreatorError", message,
    }));
  }

  private onCharCreatorResult(ctx: SystemContext, userId: number, content: Content): void {
    let actorId = 0;
    try { actorId = ctx.svr.getUserActor(userId); } catch { /* user gone */ }
    const mp = ctx.svr as unknown as Mp;
    const ignored = !this.charCreator.enabled ? "the creator is disabled"
      : actorId === 0 ? "no actor"
      : !this.isCharCreatorPending(mp, actorId) ? `not pending for actor ${actorId.toString(16)}`
      : "";
    if (ignored) {
      this.log(`[spawn] charCreatorResult ignored for user ${userId}: ${ignored}`);
      return;
    }

    let profileId = this.authCache.get(userId)?.profileId;
    if (profileId === undefined) {
      try {
        const stored = mp.get(actorId, "private.skympProfileId");
        if (typeof stored === "number") profileId = stored;
      } catch { /* form vanished */ }
    }

    const config: CharCreatorConfig = {
      allowChildren: this.charCreator.allowChildren,
      disabledRaces: this.charCreator.disabledRaces,
      statPool: this.charCreator.statPool,
    };
    const res = validateResult(content.data, config);
    if (res.ok === false) {
      this.log(`[spawn] charCreator refused for ${actorId.toString(16)}: ${res.error}`);
      this.sendCharCreatorError(ctx, userId, res.error);
      return;
    }
    if (this.lockedRacesFor(profileId).includes(res.clean.race)) {
      this.log(`[spawn] charCreator refused for ${actorId.toString(16)}: race ${res.clean.race} is locked for profile ${profileId}`);
      this.sendCharCreatorError(ctx, userId, "This race is locked for your account");
      return;
    }

    try {
      mp.set(actorId, "appearance", res.clean.appearance);
      mp.set(actorId, "private.rp", {
        species: res.clean.species,
        race: res.clean.race,
        sex: res.clean.sex,
        age: res.clean.age,
        stats: res.clean.stats,
        bodyExtras: res.clean.bodyExtras,
        backstory: res.clean.backstory,
        description: res.clean.description,
        createdAt: Date.now(),
      });
    } catch { return; /* form vanished */ }
    this.finishCreation(ctx, actorId);
    ctx.svr.sendCustomPacket(userId, JSON.stringify({ customPacketType: "charCreatorClose" }));
    this.log("Character creator accepted for actor", actorId.toString(16),
      `(${res.clean.race} "${res.clean.name}")`);
  }

  private onDeleteCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return;

    const actorId = this.slotMap(ctx, auth.profileId)[slot];
    if (actorId !== undefined) {
      // Fallen characters may be deleted too (destroying the body); the extra slot they opened closes with them
      const fallen = isFallen(ctx.svr as unknown as Mp, actorId);
      this.cancelPark(actorId);
      this.parked.delete(actorId);
      ctx.gm.emit(CHARACTER_RETIRED_EVENT, auth.profileId, slot, actorId);
      ctx.svr.destroyActor(actorId);
      this.log(fallen ? `Deleted fallen character ${actorId.toString(16)} from slot ${slot}, its extra slot closes` : `Deleted character ${actorId.toString(16)} from slot ${slot}`);
    }
    this.sendCharacterList(ctx, userId, auth.profileId);
  }

  // Legacy single-character path (flag off): original behaviour kept

  private legacySpawn(ctx: SystemContext, userId: number, userProfileId: number,
    discordRoleIds: string[], discordId?: string, access?: unknown): void {
    const mp = ctx.svr as unknown as Mp;
    // Perma-dead characters are locked here too (see onSelectCharacter): skip them and start a fresh character instead
    let actorId = ctx.svr.getActorsByProfileId(userProfileId)
      .find((a) => !this.isPermaDead(mp, a));
    if (actorId) {
      this.log("Loading character", actorId.toString(16));
      this.cancelPark(actorId); // reconnected within the logout grace
      this.unpark(ctx, actorId);
      ctx.svr.setEnabled(actorId, true);
      this.bringInsideBorder(mp, actorId);
      ctx.svr.setUserActor(userId, actorId);
      if (this.charCreator.enabled && this.isCharCreatorPending(mp, actorId)) {
        // Relog protection: an unfinished creator reopens until a submission is accepted
        this.sendCharCreatorOpen(ctx, userId, userProfileId, actorId);
      }
    } else {
      const point = this.randomStartPoint();
      actorId = ctx.svr.createActor(0, point.pos, point.angleZ, point.worldOrCell, userProfileId);
      this.giveStartingItems(mp, actorId, userProfileId, 0);
      mp.set(actorId, "private.kitPending", true);
      mp.set(actorId, "private.creationPending", true);
      this.log("Creating character", actorId.toString(16));
      ctx.svr.setUserActor(userId, actorId);
      if (this.charCreator.enabled) {
        mp.set(actorId, "private.charCreatorPending", true);
        this.sendCharCreatorOpen(ctx, userId, userProfileId, actorId);
      } else {
        ctx.svr.setRaceMenuOpen(actorId, true);
      }
    }
    this.scheduleKit(ctx, actorId, EQUIP_KIT_SPAWN_DELAY_MS);

    this.applyAuthProps(mp, actorId, userProfileId, discordRoleIds, discordId, access);

    ctx.gm.emit("userAssignActor", userId, actorId);
    // Gamemode store re-sync: re-runs its connect chain when a switch assigns a new body
    (ctx.svr as any).onUserAssignActor?.(userId, actorId);
  }
}
