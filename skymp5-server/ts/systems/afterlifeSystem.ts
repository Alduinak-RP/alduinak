import { Settings } from "../settings";
import { System, Log, SystemContext, AFTERLIFE_EVENT } from "./system";
import { addItemTo, addSpellTo, chainMpHook, hex, holdsItem, isAlive, isPlayerActor, notifyActor, removeSpellFrom, userOf } from "./actorUtil";
import { isEditorId, resolveEditorIds } from "./espmEditorIds";
import { readInventory, sameExtras } from "./inventoryExtras";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Afterlife: a character sent to Sovngarde or the Soul Cairn stays playable but is confined to its realm, and any player who dies inside a realm respawns at its arrival.
// Senders (finish off, execution, soul trap) call sendToSovngarde / sendToSoulCairn; a dead actor is only marked and routed on its respawn.

export type RealmId = "sovngarde" | "soulCairn";

interface Realm {
  label: string;
  arrival: { cellOrWorldDesc: string; pos: number[]; rot: number[] };
  spaces: Set<string>;
}

export const REALMS: Record<RealmId, Realm> = {
  // The COC marker of the Hall of Valor (Skyrim.esm CELL 95C44, REFR 95F39); the hall's doors only lead to the Sovngarde world
  sovngarde: {
    label: "Sovngarde",
    arrival: { cellOrWorldDesc: "95c44:Skyrim.esm", pos: [-590.44, -131.84, -357.73], rot: [0, 0, 359] },
    // The Sovngarde world, the vanilla hall and the plugin's duplicate hall
    spaces: new Set(["2ee41:Skyrim.esm", "95c44:Skyrim.esm", "815:AlduinakAdditions.esp"]),
  },
  // Where the Castle Volkihar portal (Dawnguard.esm door 0200289B) sets the player down in DLC01SoulCairn
  soulCairn: {
    label: "the Soul Cairn",
    arrival: { cellOrWorldDesc: "1408:Dawnguard.esm", pos: [-19965.66, -15986.51, 2079.48], rot: [0, 0, 77.35] },
    // The Soul Cairn and the places its doors reach: the Reaper's lair (CELL 02006429) and the Boneyard (WRLD 0200528D)
    spaces: new Set(["1408:Dawnguard.esm", "6429:Dawnguard.esm", "528d:Dawnguard.esm"]),
  },
};

// { realm, reason, at } on the character
export const AFTERLIFE_PROP = "private.afterlife";
// Neighbor-visible (registered in the gamemode) { realm, shader, alpha }: the realm's look, played by every client that sees the character
const LOOK_PROP = "ff_afterlife";
// The SPEL look ability actually added, so a changed look or a revive removes that one
const SPELL_PROP = "private.afterlifeSpell";
// { realm, granted: { [baseId]: count } }: the realm whose outfit was handed out since the pack was last stripped and the pieces AddItem gave; a lost piece is only handed out again after the next strip
const OUTFIT_PROP = "private.afterlifeOutfit";
interface OutfitRecord {
  realm: RealmId;
  granted: Record<string, number>;
}
// Set by FactionSystem once a fallen character's ranks were released
export const RELEASED_PROP = "private.factionsReleased";
// Where a revived character wakes: the Temple of Kynareth in Whiterun (TempleRespawn.cpp)
export const REVIVE_ARRIVAL = { cellOrWorldDesc: "165a7:Skyrim.esm", pos: [223.24, 248.85, 54], rot: [0, 0, 0] };

const CONFINE_POLL_MS = 2000;
// A respawn and a login strip the player, so the realm's clothes go on once the client settled (spawn.ts EQUIP_KIT_SPAWN_DELAY_MS)
const DRESS_DELAY_MS = 5000;
// The look: an EFSH plays on every copy through ff_afterlife, a SPEL ability is added on arrival and removed on a revive. Overridable via "afterlifeLooks"
interface RealmLookConfig {
  look?: string;
  outfit: string[];
  // Opacity played with the EFSH, 0-1
  alpha: number;
}
// SovengardeFXS01 (Skyrim.esm EFSH 10B2DF) is the glow FXSovengardeSCRIPT plays on the heroes through AbFXSovengardeGlow
const DEFAULT_LOOKS: Record<RealmId, RealmLookConfig> = {
  sovngarde: { look: "SovengardeFXS01", outfit: ["ArmorDraugrCuirass", "ArmorDraugrBoots", "ArmorDraugrGauntlets", "ArmorDraugrHelmet"], alpha: 1 },
  // The Dawnguard ghost ability DLC1SoulCairnAbGhost pairs the shader with magicSetActorAlphaScript at 0.25
  soulCairn: { look: "DLC1SoulCairnGhostFXShader", outfit: ["ClothesPrisonerRags", "ClothesPrisonerShoes"], alpha: 0.25 },
};
interface RealmLook {
  shaderId: number;
  spellId: number;
  outfit: number[];
  alpha: number;
}
const NO_LOOK: RealmLook = { shaderId: 0, spellId: 0, outfit: [], alpha: 1 };
// Living characters per player; override with the "characterSelectMaxCharacters" server setting (1-10)
const DEFAULT_MAX_CHARACTERS = 3;

export const readMaxCharacters = (all: Record<string, unknown> | null): number => {
  const raw = Number(all?.["characterSelectMaxCharacters"]);
  return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : DEFAULT_MAX_CHARACTERS;
};

const realmIdOf = (realm: unknown): RealmId | null =>
  typeof realm === "string" && Object.prototype.hasOwnProperty.call(REALMS, realm) ? realm as RealmId : null;

export const afterlifeOf = (mp: Mp, actorId: number): RealmId | null => {
  try {
    return realmIdOf(mp.get(actorId, AFTERLIFE_PROP)?.realm);
  } catch {
    return null;
  }
};

// Perma-dead or in an afterlife: the character no longer counts as a living one of its profile
export const isFallen = (mp: Mp, actorId: number): boolean => {
  try {
    if (mp.get(actorId, "private.permaDead") === true) return true;
  } catch {
    return false;
  }
  return afterlifeOf(mp, actorId) !== null;
};

const outfitOf = (mp: Mp, actorId: number): OutfitRecord | null => {
  try {
    const raw = mp.get(actorId, OUTFIT_PROP);
    const realm = realmIdOf(raw?.realm);
    if (!realm) return null;
    const granted: Record<string, number> = {};
    for (const [base, count] of Object.entries(raw.granted && typeof raw.granted === "object" ? raw.granted : {})) {
      if (typeof count === "number" && Number.isInteger(count) && count > 0) granted[base] = count;
    }
    return { realm, granted };
  } catch {
    return null;
  }
};

const realmAt = (mp: Mp, actorId: number): RealmId | null => {
  const desc = String(mp.get(actorId, "worldOrCellDesc"));
  return (Object.keys(REALMS) as RealmId[]).find((id) => REALMS[id].spaces.has(desc)) ?? null;
};

const actorsOf = (mp: Mp, profileId: number): number[] => {
  try { return (mp.getActorsByProfileId(profileId) as number[]).map((a) => a >>> 0); } catch { return []; }
};

export const livingCount = (mp: Mp, profileId: number): number =>
  actorsOf(mp, profileId).filter((a) => !isFallen(mp, a)).length;

export const fallenOf = (mp: Mp, profileId: number): number[] =>
  actorsOf(mp, profileId).filter((a) => isFallen(mp, a));

// "Sovngarde", "the Soul Cairn" or "perma-dead"
export const fallenLabel = (mp: Mp, actorId: number): string => {
  const realm = afterlifeOf(mp, actorId);
  return realm ? REALMS[realm].label : "perma-dead";
};

export class AfterlifeSystem implements System {
  systemName = "AfterlifeSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.ctx = ctx;
    const mp = ctx.svr as Mp;
    this.maxCharacters = readMaxCharacters((await Settings.get()).allSettings as Record<string, unknown> | null);
    (globalThis as any).__alduinakRevive = (actorId: number, by: string) => this.revive(Number(actorId) >>> 0, String(by));
    await this.resolveLooks(mp);
    chainMpHook(mp, "onRespawn", (rawId: number) => {
      const actorId = Number(rawId) >>> 0;
      try {
        if (!isPlayerActor(mp, actorId)) return;
        const realm = afterlifeOf(mp, actorId) ?? realmAt(mp, actorId);
        if (realm) this.routeRespawn(mp, actorId, realm);
        this.syncLook(mp, actorId);
      } catch (e) {
        this.log(`[afterlife] respawn routing of ${hex(actorId)} failed: ${e}`);
      }
    });
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      this.confine(mp, actorId >>> 0);
      this.syncLook(mp, actorId >>> 0);
      const realm = afterlifeOf(mp, actorId >>> 0);
      if (realm) setTimeout(() => this.dress(mp, actorId >>> 0, realm), DRESS_DELAY_MS);
    });
  }

  // Editor ids, descs and hex ids of the look and the outfit per realm, each set field over its default; misses are logged
  private async resolveLooks(mp: Mp): Promise<void> {
    const s = await Settings.get();
    const configured = s.allSettings?.["afterlifeLooks"] as Record<string, unknown> | undefined;
    const configs = {} as Record<RealmId, RealmLookConfig>;
    for (const realm of Object.keys(REALMS) as RealmId[]) {
      const entry = configured && typeof configured === "object" ? configured[realm] : undefined;
      const raw = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const def = DEFAULT_LOOKS[realm];
      const look = "look" in raw ? raw["look"] : "shader" in raw ? raw["shader"] : def.look;
      const outfit = Array.isArray(raw["outfit"]) ? raw["outfit"].filter((v): v is string => typeof v === "string" && !!v) : def.outfit;
      const rawAlpha = "alpha" in raw ? raw["alpha"] : def.alpha;
      const alpha = typeof rawAlpha === "number" && Number.isFinite(rawAlpha) && rawAlpha >= 0 && rawAlpha <= 1 ? rawAlpha : def.alpha;
      if (alpha !== rawAlpha) this.log(`[afterlife] ${REALMS[realm].label} alpha ${JSON.stringify(rawAlpha)} is not a number between 0 and 1, the default ${def.alpha} is used`);
      configs[realm] = { look: typeof look === "string" && look ? look : undefined, outfit, alpha };
    }
    const names = Object.values(configs).flatMap((c) => [c.look ?? "", ...c.outfit]).filter((n) => n && isEditorId(n));
    const scan = await resolveEditorIds(Array.from(new Set(names)), s.dataDir, s.loadOrder, this.log, ["EFSH", "SPEL", "ARMO"]);
    const idOf = (name: string): number => {
      try {
        if (name.includes(":")) return mp.getIdFromDesc(name) >>> 0;
        if (!isEditorId(name)) return parseInt(name, 16) >>> 0;
        const desc = scan.resolved.get(name.toLowerCase());
        return desc ? mp.getIdFromDesc(desc) >>> 0 : 0;
      } catch {
        return 0;
      }
    };
    const typeOf = (id: number): string => {
      try { return String(mp.lookupEspmRecordById(id)?.record?.type ?? ""); } catch { return ""; }
    };
    for (const realm of Object.keys(REALMS) as RealmId[]) {
      const { label } = REALMS[realm];
      const config = configs[realm];
      const look: RealmLook = { ...NO_LOOK, outfit: [], alpha: config.alpha };
      if (config.look) {
        const id = idOf(config.look);
        const type = typeOf(id);
        if (type === "EFSH") look.shaderId = id;
        else if (type === "SPEL") look.spellId = id;
        else this.log(`[afterlife] ${label} look '${config.look}' ${id ? `is a ${type || "record of unknown type"}, not an EFSH or SPEL` : "not found in the load order"}, ignored`);
      }
      for (const name of config.outfit) {
        const id = idOf(name);
        if (id && typeOf(id) === "ARMO") look.outfit.push(id);
        else this.log(`[afterlife] ${label} outfit item '${name}' ${id ? "is not an ARMO" : "not found in the load order"}, ignored`);
      }
      this.looks[realm] = look;
      this.log(`[afterlife] ${label} look: ${look.shaderId ? `shader ${hex(look.shaderId)} at alpha ${look.alpha}` : look.spellId ? `ability ${hex(look.spellId)}` : "none"}, ${look.outfit.length}/${config.outfit.length} outfit item(s)`);
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    if (now < this.nextPollAt) return;
    this.nextPollAt = now + CONFINE_POLL_MS;
    const mp = ctx.svr as Mp;
    let players: unknown[] = [];
    try { players = mp.get(0, "onlinePlayers") ?? []; } catch { return; }
    for (const id of players) this.confine(mp, Number(id) >>> 0);
  }

  sendToSovngarde(actorId: number, reason: string): boolean {
    return this.send(actorId >>> 0, "sovngarde", reason);
  }

  sendToSoulCairn(actorId: number, reason: string): boolean {
    return this.send(actorId >>> 0, "soulCairn", reason);
  }

  // Returns the living: "" on success, else the refusal. Faction ranks released at death are not restored
  revive(actorId: number, by: string): string {
    const ctx = this.ctx;
    if (!ctx) return "Server not ready";
    const mp = ctx.svr as Mp;
    if (!isPlayerActor(mp, actorId)) return "Not a player character";
    if (!isFallen(mp, actorId)) return "They are not fallen";
    if (!isAlive(mp, actorId)) return "They are dead right now, wait for the respawn";
    let profileId = -1;
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { return "Character not found"; }
    if (livingCount(mp, profileId) >= this.maxCharacters) return "The extra slot is in use: delete the character created in it first";
    try {
      mp.set(actorId, AFTERLIFE_PROP, null);
      mp.set(actorId, "private.permaDead", null);
      mp.set(actorId, RELEASED_PROP, null);
      mp.set(actorId, "locationalData", REVIVE_ARRIVAL);
    } catch (e) {
      this.log(`[afterlife] reviving ${hex(actorId)} failed: ${e}`);
      return "Revive failed, see server log";
    }
    this.clearLook(mp, actorId);
    this.undress(mp, actorId);
    notifyActor(mp, actorId, "You have been returned to the living.");
    this.log(`[afterlife] ${hex(actorId)} of profile ${profileId} revived by ${by}`);
    return "";
  }

  // Senders strip the pack into the body first (BodySystem.leaveBody), so the outfit is owed again
  private send(actorId: number, realm: RealmId, reason: string): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const mp = ctx.svr as Mp;
    if (!isPlayerActor(mp, actorId) || isFallen(mp, actorId)) return false;
    const { label, arrival } = REALMS[realm];
    const alive = isAlive(mp, actorId);
    try {
      mp.set(actorId, AFTERLIFE_PROP, { realm, reason, at: Date.now() });
      mp.set(actorId, OUTFIT_PROP, null);
      if (alive) mp.set(actorId, "locationalData", arrival);
    } catch (e) {
      this.log(`[afterlife] sending ${hex(actorId)} to ${label} failed: ${e}`);
      return false;
    }
    this.syncLook(mp, actorId);
    if (alive) this.dress(mp, actorId, realm);
    notifyActor(mp, actorId, `Your soul passes to ${label}.`);
    let profileId = -1;
    let slot: unknown;
    try {
      profileId = Number(mp.get(actorId, "profileId"));
      slot = mp.get(actorId, "private.charSlot");
    } catch { /* form vanished */ }
    ctx.gm.emit(AFTERLIFE_EVENT, profileId, Number.isInteger(slot) ? slot : -1, actorId, realm, reason);
    this.log(`[afterlife] ${hex(actorId)} of profile ${profileId} sent to ${label}: ${reason}`);
    return true;
  }

  // The engine reads the respawn point right after this hook, so the realm's arrival stands in for this one respawn only
  private routeRespawn(mp: Mp, actorId: number, realm: RealmId): void {
    const { label, arrival } = REALMS[realm];
    const home = mp.get(actorId, "spawnPoint");
    mp.set(actorId, "spawnPoint", arrival);
    setTimeout(() => {
      try {
        mp.set(actorId, "spawnPoint", home);
      } catch (e) {
        this.log(`[afterlife] restoring the spawn point of ${hex(actorId)} failed: ${e}`);
      }
    }, 0);
    setTimeout(() => this.dress(mp, actorId, realm), DRESS_DELAY_MS);
    this.log(`[afterlife] ${hex(actorId)} respawns in ${label}`);
  }

  // Writes the look of the character's realm, or clears a stale one when it is in none; ff_afterlife lives in gamemode.js, so a missing property is only logged
  private syncLook(mp: Mp, actorId: number): void {
    const realm = afterlifeOf(mp, actorId);
    let stored: { realm?: unknown; shader?: unknown; alpha?: unknown } | null = null;
    try { stored = mp.get(actorId, LOOK_PROP); } catch { /* unregistered, the set below logs it */ }
    const added = this.addedSpellOf(mp, actorId);
    if (!realm) {
      if (!stored && !added) return;
      const was = realmIdOf(stored?.realm);
      this.clearLook(mp, actorId);
      this.log(`[afterlife] ${hex(actorId)} is in no realm, cleared the stale ${was ? REALMS[was].label : "realm"} look`);
      return;
    }
    const { shaderId, spellId, alpha } = this.looks[realm];
    if (stored?.realm !== realm || stored.shader !== shaderId || stored.alpha !== alpha) {
      try {
        mp.set(actorId, LOOK_PROP, { realm, shader: shaderId, alpha });
      } catch (e) {
        this.log(`[afterlife] ${LOOK_PROP} on ${hex(actorId)} failed (property registered in gamemode.js?): ${e}`);
      }
    }
    if (added === spellId) return;
    if (added) this.removeAddedSpell(mp, actorId, added);
    if (!spellId) return;
    try {
      addSpellTo(mp, actorId, spellId);
      mp.set(actorId, SPELL_PROP, spellId);
    } catch (e) {
      this.log(`[afterlife] adding the ${REALMS[realm].label} ability to ${hex(actorId)} failed: ${e}`);
    }
  }

  private clearLook(mp: Mp, actorId: number): void {
    try {
      mp.set(actorId, LOOK_PROP, null);
    } catch (e) {
      this.log(`[afterlife] clearing ${LOOK_PROP} of ${hex(actorId)} failed: ${e}`);
    }
    const added = this.addedSpellOf(mp, actorId);
    if (added) this.removeAddedSpell(mp, actorId, added);
  }

  private addedSpellOf(mp: Mp, actorId: number): number {
    try {
      const id = mp.get(actorId, SPELL_PROP);
      return typeof id === "number" ? id >>> 0 : 0;
    } catch {
      return 0;
    }
  }

  private removeAddedSpell(mp: Mp, actorId: number, spellId: number): void {
    try {
      removeSpellFrom(mp, actorId, spellId);
      mp.set(actorId, SPELL_PROP, null);
    } catch (e) {
      this.log(`[afterlife] removing the realm ability ${hex(spellId)} from ${hex(actorId)} failed: ${e}`);
    }
  }

  // EquipItem(akItem, abPreventRemoval, abSilent) runs on the owner's client, so only an online living character still in the realm is dressed
  private dress(mp: Mp, actorId: number, realm: RealmId): void {
    const { outfit } = this.looks[realm];
    if (!outfit.length || userOf(mp, actorId) < 0 || !isAlive(mp, actorId) || afterlifeOf(mp, actorId) !== realm) return;
    const given = outfitOf(mp, actorId)?.realm === realm;
    const granted: Record<string, number> = {};
    let worn = 0;
    for (const itemId of outfit) {
      try {
        if (!holdsItem(mp, actorId, (baseId) => baseId === itemId)) {
          if (given) continue;
          addItemTo(mp, actorId, itemId, 1, true);
          granted[itemId] = (granted[itemId] ?? 0) + 1;
        }
        const self = { type: "form", desc: mp.getDescFromId(actorId) };
        mp.callPapyrusFunction("method", "Actor", "EquipItem", self, [{ type: "espm", desc: mp.getDescFromId(itemId) }, false, true]);
        worn++;
      } catch (e) {
        this.log(`[afterlife] dressing ${hex(actorId)} in ${hex(itemId)} failed: ${e}`);
      }
    }
    if (!given && (worn || Object.keys(granted).length)) {
      try {
        mp.set(actorId, OUTFIT_PROP, { realm, granted });
      } catch (e) {
        this.log(`[afterlife] recording the outfit of ${hex(actorId)} failed: ${e}`);
      }
    }
    this.log(`[afterlife] ${hex(actorId)} wears ${worn} piece(s) of the ${REALMS[realm].label} outfit`);
  }

  // Takes back as many plain copies as dress() granted, worn ones first, so a revive carries none of it to Tamriel and the player's own pieces stay
  private undress(mp: Mp, actorId: number): void {
    const record = outfitOf(mp, actorId);
    if (!record) return;
    try {
      const owed = new Map(Object.entries(record.granted).map(([base, count]) => [Number(base) >>> 0, count]));
      const { entries } = readInventory(mp, actorId);
      const counts = entries.map((e) => Number(e.count) || 0);
      const order = entries.map((_, i) => i).sort((a, b) => Number(!!entries[b].worn) - Number(!!entries[a].worn));
      let taken = 0;
      for (const i of order) {
        const base = Number(entries[i].baseId) >>> 0;
        const due = owed.get(base) ?? 0;
        if (!due || !sameExtras(entries[i], { baseId: base, count: 1 })) continue;
        const n = Math.min(due, counts[i]);
        counts[i] -= n;
        owed.set(base, due - n);
        taken += n;
      }
      if (taken) mp.set(actorId, "inventory", { entries: entries.map((e, i) => ({ ...e, count: counts[i] })).filter((e) => e.count > 0) });
      mp.set(actorId, OUTFIT_PROP, null);
      this.log(`[afterlife] took ${taken} granted piece(s) of the ${REALMS[record.realm].label} outfit from ${hex(actorId)}`);
    } catch (e) {
      this.log(`[afterlife] taking the ${REALMS[record.realm].label} outfit from ${hex(actorId)} failed: ${e}`);
    }
  }

  // A living character outside its realm (staff teleport, a portal, marked while away) is brought back to the arrival
  private confine(mp: Mp, actorId: number): void {
    const realm = afterlifeOf(mp, actorId);
    if (!realm || !isAlive(mp, actorId)) return;
    const { label, arrival, spaces } = REALMS[realm];
    try {
      if (spaces.has(String(mp.get(actorId, "worldOrCellDesc")))) return;
      mp.set(actorId, "locationalData", arrival);
    } catch (e) {
      this.log(`[afterlife] returning ${hex(actorId)} to ${label} failed: ${e}`);
      return;
    }
    notifyActor(mp, actorId, `The dead cannot leave ${label}.`);
    this.log(`[afterlife] ${hex(actorId)} returned to ${label}`);
  }

  private ctx: SystemContext | null = null;
  private nextPollAt = 0;
  private maxCharacters = DEFAULT_MAX_CHARACTERS;
  private looks: Record<RealmId, RealmLook> = { sovngarde: NO_LOOK, soulCairn: NO_LOOK };
}
