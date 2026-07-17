import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { filterAccessForSlot } from "../backendFactionApi";

type Mp = any;

function randomInteger(min: number, max: number) {
  const rand = min + Math.random() * (max + 1 - min);
  return Math.floor(rand);
}

// Slots per player; override with the "characterSelectMaxCharacters" server setting (1-10)
const DEFAULT_MAX_CHARACTERS = 3;

// Fresh characters start with a miner's outfit and pocket change, nothing else.
// Form ids verified against Skyrim.esm: ClothesMinerClothes, ClothesMinerBoots, Gold001.
const STARTING_ITEMS = [
  { baseId: 0x00080697, count: 1 },
  { baseId: 0x00080699, count: 1 },
  { baseId: 0x0000000f, count: 50 },
];

// characterSelectMenuRequest guards: rapid repeats are ignored, and a request right after actor assign is treated as a stale client menu event
const REQUEST_COOLDOWN_MS = 15 * 1000;
const ASSIGN_GRACE_MS = 10 * 1000;

// Logout grace: the body stays in the world this long after disconnect/menu quit/character switch, so combat logging leaves a killable body; re-selecting cancels it
const LOGOUT_GRACE_MS = 5 * 60 * 1000;

// Character-select protocol (gated by the "characterSelect" server setting;
// slot count via "characterSelectMaxCharacters", 1-10, default 3).
// When enabled the server no longer auto-spawns on connect; it sends the player
// their character slots and waits for a selection (matches the client's
// CharacterSelectService). Flag off (default) keeps the original
// single-character behaviour, so enabling can never brick login on its own.
//   Server -> Client:
//     { customPacketType: "characterSelectMenu", maxCharacters, characters: [ {name,info} | null ] }
//   Client -> Server:
//     { customPacketType: "characterSelectResult", action: "play"|"create"|"delete", slot }
export class Spawn implements System {
  systemName = "Spawn";
  constructor(private log: Log) { }

  private characterSelect = false;
  private maxCharacters = DEFAULT_MAX_CHARACTERS;
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

  async initAsync(ctx: SystemContext): Promise<void> {
    this.settingsObject = await Settings.get();
    this.characterSelect = !!(this.settingsObject.allSettings &&
      (this.settingsObject.allSettings as Record<string, unknown>)["characterSelect"]);
    const rawMax = Number(this.settingsObject.allSettings &&
      (this.settingsObject.allSettings as Record<string, unknown>)["characterSelectMaxCharacters"]);
    if (Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 10) this.maxCharacters = rawMax;

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
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!this.characterSelect) return;
    if (type === "characterSelectResult") {
      const slot = Number(content.slot);
      if (content.action === "delete") this.onDeleteCharacter(ctx, userId, slot);
      else this.onSelectCharacter(ctx, userId, slot);   // "play" or "create"
    } else if (type === "characterSelectMenuRequest") {
      this.onMenuRequest(ctx, userId);
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

  // Disable the body LOGOUT_GRACE_MS from now unless re-selected first; also detaches a still-connected owner when firing, since re-selecting a DISABLED actor while still mapped would stream CreateActor(isMe) twice
  private schedulePark(ctx: SystemContext, actorId: number): void {
    this.cancelPark(actorId);
    const handle = setTimeout(() => {
      this.parkTimers.delete(actorId);
      try {
        ctx.svr.setEnabled(actorId, false);
        const userId = ctx.svr.getUserByActor(actorId);
        if (userId >= 0 && userId < 0xffff && ctx.svr.getUserActor(userId) === actorId) {
          ctx.svr.setUserActor(userId, 0);
        }
        this.log("Logout grace expired, actor", actorId.toString(16), "despawned");
      } catch { /* form vanished */ }
    }, LOGOUT_GRACE_MS);
    this.parkTimers.set(actorId, handle);
  }

  private cancelPark(actorId: number): void {
    const handle = this.parkTimers.get(actorId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.parkTimers.delete(actorId);
    }
  }

  // Sent when the player quits to the main menu: reopen the selection menu and start logout grace on the current body (it stays in the world, so quitting is never an instant combat escape)
  // Rapid repeats or requests right after actor assign skip the grace scheduling: packet spam / stale menu events must not park a body that is being played
  private onMenuRequest(ctx: SystemContext, userId: number): void {
    const auth = this.authCache.get(userId);
    if (!auth) return; // not authenticated yet
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
          }
        } catch { /* form vanished */ }
      }
      this.pending.set(userId, auth);
      this.log("Reopening character select for user", userId, mayPark ? "(logout grace started)" : "(guarded, no grace timer)");
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

  private slotMap(ctx: SystemContext, profileId: number): (number | undefined)[] {
    const mp = ctx.svr as unknown as Mp;
    const slots: (number | undefined)[] = new Array(this.maxCharacters).fill(undefined);
    const unassigned: number[] = [];
    for (const a of ctx.svr.getActorsByProfileId(profileId)) {
      // Crash handle for deleting characters
      let s: unknown;
      try { s = mp.get(a, "private.charSlot"); }
      catch { continue; }
      if (Number.isInteger(s) && (s as number) >= 0 && (s as number) < this.maxCharacters && slots[s as number] === undefined) {
        slots[s as number] = a;
      } else {
        unassigned.push(a);
      }
    }
    for (const a of unassigned) {
      const free = slots.indexOf(undefined);
      if (free < 0) break;
      slots[free] = a;
      try { mp.set(a, "private.charSlot", free); } catch { /* form vanished */ }
    }
    return slots;
  }

  private isPermaDead(mp: Mp, actorId: number): boolean {
    try { return mp.get(actorId, "private.permaDead") === true; }
    catch { return false; }
  }

  // New actors are created with an empty inventory, so a wholesale set is safe
  private giveStartingItems(mp: Mp, actorId: number): void {
    try { mp.set(actorId, "inventory", { entries: STARTING_ITEMS.map(e => ({ ...e })) }); }
    catch { /* form vanished */ }
  }

  private sendCharacterList(ctx: SystemContext, userId: number, profileId: number): void {
    const mp = ctx.svr as unknown as Mp;
    const characters = this.slotMap(ctx, profileId).map((actorId, i) =>
      actorId !== undefined
        ? { name: this.characterName(ctx, actorId) || `Character ${i + 1}`, dead: this.isPermaDead(mp, actorId) }
        : null);
    ctx.svr.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "characterSelectMenu", maxCharacters: this.maxCharacters, characters,
    }));
  }

  private onSelectCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= this.maxCharacters) return;

    const mp = ctx.svr as unknown as Mp;
    const slots = this.slotMap(ctx, auth.profileId);
    let actorId = slots[slot];
    const isNew = actorId === undefined;

    // Permanently dead characters are locked: the body remains in the world but can never be played again
    if (!isNew && actorId !== undefined && this.isPermaDead(mp, actorId)) {
      this.log("Refusing to play permanently dead character", actorId.toString(16), "in slot", slot);
      this.sendCharacterList(ctx, userId, auth.profileId);
      return;
    }

    if (isNew) {
      const { startPoints } = this.settingsObject;
      const idx = randomInteger(0, startPoints.length - 1);
      actorId = ctx.svr.createActor(0, startPoints[idx].pos, startPoints[idx].angleZ,
        +startPoints[idx].worldOrCell, auth.profileId);
      mp.set(actorId, "private.charSlot", slot);
      this.giveStartingItems(mp, actorId);
      this.log("Creating character", actorId.toString(16), "in slot", slot);
    } else {
      this.log("Loading character", actorId.toString(16), "from slot", slot);
    }

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
    ctx.svr.setEnabled(actorId, true);
    ctx.svr.setUserActor(userId, actorId);
    if (isNew) ctx.svr.setRaceMenuOpen(actorId, true);

    this.applyAuthProps(mp, actorId, auth.profileId, auth.roles, auth.discordId,
      filterAccessForSlot(auth.access, slot));

    ctx.gm.emit("userAssignActor", userId, actorId);
    // Gamemode store re-sync: re-runs its connect chain when a switch assigns a new body
    (ctx.svr as any).onUserAssignActor?.(userId, actorId);

    this.lastAssignMs.set(userId, Date.now());
    this.pending.delete(userId);
  }

  private onDeleteCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= this.maxCharacters) return;

    const actorId = this.slotMap(ctx, auth.profileId)[slot];
    if (actorId !== undefined) {
      // Perma-dead characters may be deleted too (destroying the body) so a perma-death cannot lock the slot forever
      this.cancelPark(actorId);
      ctx.svr.destroyActor(actorId);
      this.log("Deleted character", actorId.toString(16), "from slot", slot);
    }
    this.sendCharacterList(ctx, userId, auth.profileId);
  }

  // Legacy single-character path (flag off): original behaviour kept

  private legacySpawn(ctx: SystemContext, userId: number, userProfileId: number,
    discordRoleIds: string[], discordId?: string, access?: unknown): void {
    const { startPoints } = this.settingsObject;
    const mp = ctx.svr as unknown as Mp;
    // Perma-dead characters are locked here too (see onSelectCharacter): skip them and start a fresh character instead
    let actorId = ctx.svr.getActorsByProfileId(userProfileId)
      .find((a) => !this.isPermaDead(mp, a));
    if (actorId) {
      this.log("Loading character", actorId.toString(16));
      this.cancelPark(actorId); // reconnected within the logout grace
      ctx.svr.setEnabled(actorId, true);
      ctx.svr.setUserActor(userId, actorId);
    } else {
      const idx = randomInteger(0, startPoints.length - 1);
      actorId = ctx.svr.createActor(0, startPoints[idx].pos, startPoints[idx].angleZ,
        +startPoints[idx].worldOrCell, userProfileId);
      this.giveStartingItems(mp, actorId);
      this.log("Creating character", actorId.toString(16));
      ctx.svr.setUserActor(userId, actorId);
      ctx.svr.setRaceMenuOpen(actorId, true);
    }

    this.applyAuthProps(mp, actorId, userProfileId, discordRoleIds, discordId, access);

    ctx.gm.emit("userAssignActor", userId, actorId);
    // Gamemode store re-sync: re-runs its connect chain when a switch assigns a new body
    (ctx.svr as any).onUserAssignActor?.(userId, actorId);
  }
}
