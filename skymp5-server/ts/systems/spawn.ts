import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

type Mp = any;

function randomInteger(min: number, max: number) {
  const rand = min + Math.random() * (max + 1 - min);
  return Math.floor(rand);
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
  private pending = new Map<number, { profileId: number; roles: string[]; discordId?: string }>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.settingsObject = await Settings.get();
    this.characterSelect = !!(this.settingsObject.allSettings &&
      (this.settingsObject.allSettings as Record<string, unknown>)["characterSelect"]);

    const listenerFn = (userId: number, userProfileId: number, discordRoleIds: string[], discordId?: string) => {
      if (this.characterSelect) {
        this.pending.set(userId, { profileId: userProfileId, roles: discordRoleIds, discordId });
        this.sendCharacterList(ctx, userId, userProfileId);
        return;
      }
      this.legacySpawn(ctx, userId, userProfileId, discordRoleIds, discordId);
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
    const actorId = ctx.svr.getUserActor(userId);
    if (actorId !== 0) {
      ctx.svr.setEnabled(actorId, false);
    }
  }

  // ── Character select ──────────────────────────────────────────────────────

  private characterName(ctx: SystemContext, actorId: number): string {
    try {
      const n = ctx.svr.getActorName(actorId);
      return typeof n === "string" ? n.trim() : "";
    } catch { return ""; }
  }

  private sendCharacterList(ctx: SystemContext, userId: number, profileId: number): void {
    const actors = ctx.svr.getActorsByProfileId(profileId).slice(0, MAX_CHARACTERS);
    const characters = [];
    for (let i = 0; i < MAX_CHARACTERS; i++) {
      const actorId = actors[i];
      characters.push(actorId
        ? { name: this.characterName(ctx, actorId) || `Character ${i + 1}` }
        : null);
    }
    ctx.svr.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "characterSelectMenu", maxCharacters: MAX_CHARACTERS, characters,
    }));
  }

  private onSelectCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= MAX_CHARACTERS) return;

    const mp = ctx.svr as unknown as Mp;
    const actors = ctx.svr.getActorsByProfileId(auth.profileId);
    let actorId = actors[slot];
    const isNew = !actorId;

    if (isNew) {
      const { startPoints } = this.settingsObject;
      const idx = randomInteger(0, startPoints.length - 1);
      actorId = ctx.svr.createActor(0, startPoints[idx].pos, startPoints[idx].angleZ,
        +startPoints[idx].worldOrCell, auth.profileId);
      this.log("Creating character", actorId.toString(16), "in slot", slot);
    } else {
      this.log("Loading character", actorId.toString(16), "from slot", slot);
    }

    ctx.svr.setEnabled(actorId, true);
    ctx.svr.setUserActor(userId, actorId);
    if (isNew) ctx.svr.setRaceMenuOpen(actorId, true);

    mp.set(actorId, "private.discordRoles", auth.roles);
    if (auth.discordId !== undefined &&
      mp.get(actorId, "private.indexed.discordId") !== auth.discordId) {
      mp.set(actorId, "private.indexed.discordId", auth.discordId);
    }

    this.pending.delete(userId);
  }

  private onDeleteCharacter(ctx: SystemContext, userId: number, slot: number): void {
    const auth = this.pending.get(userId);
    if (!auth || !Number.isInteger(slot) || slot < 0 || slot >= MAX_CHARACTERS) return;

    const actorId = ctx.svr.getActorsByProfileId(auth.profileId)[slot];
    if (actorId) {
      ctx.svr.destroyActor(actorId);
      this.log("Deleted character", actorId.toString(16), "from slot", slot);
    }
    // Re-send the (now updated) slot list so the menu refreshes.
    this.sendCharacterList(ctx, userId, auth.profileId);
  }

  // ── Legacy single-character path (flag off): original behaviour verbatim ────

  private legacySpawn(ctx: SystemContext, userId: number, userProfileId: number,
    discordRoleIds: string[], discordId?: string): void {
    const { startPoints } = this.settingsObject;
    let actorId = ctx.svr.getActorsByProfileId(userProfileId)[0];
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

    const mp = ctx.svr as unknown as Mp;
    mp.set(actorId, "private.discordRoles", discordRoleIds);

    if (discordId !== undefined) {
      if (mp.get(actorId, "private.indexed.discordId") !== discordId) {
        mp.set(actorId, "private.indexed.discordId", discordId);
      }
      const forms = mp.findFormsByPropertyValue("private.indexed.discordId", discordId) as number[];
      console.log(`Found forms ${forms}`);
    }
  }
}
