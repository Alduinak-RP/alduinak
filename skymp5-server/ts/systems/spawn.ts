import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

type Mp = any;

function randomInteger(min: number, max: number) {
  const rand = min + Math.random() * (max + 1 - min);
  return Math.floor(rand);
}

// Per-character factions
function filterAccessForSlot(access: any, slot: number): any {
  if (!access || !Array.isArray(access.gameFactions)) return access;
  return {
    ...access,
    gameFactions: access.gameFactions.filter(
      (gf: any) => gf && (gf.slot === null || gf.slot === undefined || gf.slot === slot)
    ),
  };
}

const MAX_CHARACTERS = 3;

// Character-select protocol (gated by the "characterSelect" server setting).
// When enabled, the server no longer auto-spawns on connect; instead it sends
// the player their character slots and waits for a selection. Matches the
// client's CharacterSelectService.
//
//   Server -> Client:
//     { customPacketType: "characterSelectMenu", maxCharacters, characters: [ {name,info} | null ] }
//   Client -> Server:
//     { customPacketType: "characterSelectResult", action: "play"|"create"|"delete", slot }
//
// With the flag off (default) the original single-character behaviour is kept,
// so enabling the feature can never brick login on its own.
export class Spawn implements System {
  systemName = "Spawn";
  constructor(private log: Log) { }

  private characterSelect = false;
  private settingsObject!: Settings;
  // userId -> auth context awaiting a character selection
  private pending = new Map<number, { profileId: number; roles: string[]; discordId?: string; access?: unknown }>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.settingsObject = await Settings.get();
    this.characterSelect = !!(this.settingsObject.allSettings &&
      (this.settingsObject.allSettings as Record<string, unknown>)["characterSelect"]);

    const listenerFn = (userId: number, userProfileId: number, discordRoleIds: string[], discordId?: string, access?: unknown) => {
      if (this.characterSelect) {
        this.pending.set(userId, { profileId: userProfileId, roles: discordRoleIds, discordId, access });
        this.sendCharacterList(ctx, userId, userProfileId);
        return;
      }
      this.legacySpawn(ctx, userId, userProfileId, discordRoleIds, discordId, access);
    };
    ctx.gm.on("spawnAllowed", listenerFn);
    (ctx.svr as any)._onSpawnAllowed = listenerFn;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!this.characterSelect || type !== "characterSelectResult") return;
    const slot = Number(content.slot);
    if (content.action === "delete") this.onDeleteCharacter(ctx, userId, slot);
    else this.onSelectCharacter(ctx, userId, slot);   // "play" or "create"
  }

  disconnect(userId: number, ctx: SystemContext): void {
    this.pending.delete(userId);
    try {
      const actorId = ctx.svr.getUserActor(userId);
      if (actorId !== 0) {
        ctx.svr.setEnabled(actorId, false);
      }
    } catch { /* form vanished */ }
  }

  // Character select

  // The SkyMP gamemode reads these private props off the character; mirror
  // the master-api profile onto the actor so dashboard ranks resolve in-game.
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

  // Mirror the resolved auth context onto the actor. indexed.discordId is only
  // rewritten when it actually changes, keeping the private index stable.
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
    const slots: (number | undefined)[] = new Array(MAX_CHARACTERS).fill(undefined);
    const unassigned: number[] = [];
    for (const a of ctx.svr.getActorsByProfileId(profileId)) {
      // Crash handle for deleting characters
      let s: unknown;
      try { s = mp.get(a, "private.charSlot"); }
      catch { continue; }
      if (Number.isInteger(s) && (s as number) >= 0 && (s as number) < MAX_CHARACTERS && slots[s as number] === undefined) {
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

  private sendCharacterList(ctx: SystemContext, userId: number, profileId: number): void {
    const mp = ctx.svr as unknown as Mp;
    const characters = this.slotMap(ctx, profileId).map((actorId, i) =>
      actorId !== undefined
        ? { name: this.characterName(ctx, actorId) || `Character ${i + 1}`, dead: this.isPermaDead(mp, actorId) }
        : null);
    ctx.svr.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "characterSelectMenu", maxCharacters: MAX_CHARACTERS, characters,
    }));
  }

  private onSelectCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= MAX_CHARACTERS) return;

    const mp = ctx.svr as unknown as Mp;
    const slots = this.slotMap(ctx, auth.profileId);
    let actorId = slots[slot];
    const isNew = actorId === undefined;

    // Permanently dead characters are locked: their body remains in the world
    // but they can never be played again.
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
      this.log("Creating character", actorId.toString(16), "in slot", slot);
    } else {
      this.log("Loading character", actorId.toString(16), "from slot", slot);
    }

    for (const other of slots) {
      if (other !== undefined && other !== actorId) {
        try { ctx.svr.setEnabled(other, false); } catch { /* form vanished */ }
      }
    }

    ctx.svr.setEnabled(actorId, true);
    ctx.svr.setUserActor(userId, actorId);
    if (isNew) ctx.svr.setRaceMenuOpen(actorId, true);

    this.applyAuthProps(mp, actorId, auth.profileId, auth.roles, auth.discordId,
      filterAccessForSlot(auth.access, slot));

    ctx.gm.emit("userAssignActor", userId, actorId);

    this.pending.delete(userId);
  }

  private onDeleteCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= MAX_CHARACTERS) return;

    const actorId = this.slotMap(ctx, auth.profileId)[slot];
    if (actorId !== undefined) {
      // Perma-dead characters may be deleted too — destroying the body — so a
      // perma-death cannot lock the slot forever.
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
    // Permanently dead characters are locked here too (see onSelectCharacter):
    // skip them and start a fresh character instead.
    let actorId = ctx.svr.getActorsByProfileId(userProfileId)
      .find((a) => !this.isPermaDead(mp, a));
    if (actorId) {
      this.log("Loading character", actorId.toString(16));
      ctx.svr.setEnabled(actorId, true);
      ctx.svr.setUserActor(userId, actorId);
    } else {
      const idx = randomInteger(0, startPoints.length - 1);
      actorId = ctx.svr.createActor(0, startPoints[idx].pos, startPoints[idx].angleZ,
        +startPoints[idx].worldOrCell, userProfileId);
      this.log("Creating character", actorId.toString(16));
      ctx.svr.setUserActor(userId, actorId);
      ctx.svr.setRaceMenuOpen(actorId, true);
    }

    this.applyAuthProps(mp, actorId, userProfileId, discordRoleIds, discordId, access);

    ctx.gm.emit("userAssignActor", userId, actorId);
  }
}
