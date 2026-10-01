import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { HUNTING_KNIFE_ID, addItemTo, chainMpHook, hex, holdsItem, isAlive, isBleedingOut, isNear, isPlayerActor, isSneaking, sendActionLock } from "./actorUtil";
import { effectiveRaceId, npcChainOf } from "./npcTemplate";
import { MasterySystem } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";
import { isRestrained } from "./captureSystem";
import { addEntries, conditionOf, readInventory, withCount } from "./inventoryExtras";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Skinning: pelts and meat never drop as loot (the plugin strips them, and a search never shows an animal's meat through
// SearchSystem's hidesItem). A hunter holding a hunting knife skins a dead animal: the interact key on the body (SearchSystem's
// bodyAction for spawned animals, the native activation for plugin ones) crouches them over it for SKIN_SECONDS, then hands
// the pelt and the meat the body's race or base editor id maps to, once per body; an Expert hunter's butcher's eye may add one
// more cut. The skinner also takes what else the carcass carries, then the body disappears for everyone: a zone corpse on the
// corpseConsumed event (NpcSpawnSystem), any other body disabled for good, as no other NPC respawns (placed ones never do and the
// gamemode's death hook gives the rest a 1e9 s delay). A pet's body stays and gives only its meat. Skinning costs half a kill of fatigue by hunter rank and credits hunter hours.
// A player character's own body, which lies dead until its respawn (respawnSeconds), or the body a PK leaves instead (BodySystem) is skinned the same way,
// only through bodyAction, once per death for Human Flesh, a chance of a Human Heart and, on a body that looks Khajiit, a chance of a Khajiit Pelt.
// The interact menu offers it as Skin next to Search (menuFlags, the player menu's skin and skinTired flags) and its Search never skins; a request without the choice skins for a crouched hunter.
// Only the butcher's eye line is written to the chat; a refused skinning falls through to the search and the Skin row is greyed out while the hunter is too tired.
// Every skinning ends with an actionLock of 0 s, so the skinner stands up whether it gave anything or not.
// SearchSystem refuses every search of the body during the skinning. An own body then goes like a looted one: the victim respawns at once with their
// whole pack. A PK body hands the skinner everything it holds, keys and writings under their names, and BodySystem removes it once emptied.
//
// server-settings.json keys (all optional):
//   huntingButcherChance         chance an Expert or better hunter's skinning gives one more cut of meat, default 0.25
//   huntingMeats                 editor id list replacing DEFAULT_MEATS
//   huntingPeltMap               { "<editor id fragment>": "<pelt editor id>" } replacing DEFAULT_PELT_MAP; the body's own NPC_
//                                editor id is tried first, then its race, then its templates (lower-cased), and the first
//                                fragment found in the earliest name that holds one wins
//   huntingMeatMap               { "<editor id fragment>": ["<meat editor id>", count] } replacing DEFAULT_MEAT_MAP, matched the same way
//   huntingSkinPlayers           "crouch" (default: Skin in the interact menu skins a player's body, as does crouch and interact from a client without the menu; its Search and a plain interact search it),
//                                "interact" (every interact skins, as on an animal) or "off"
//   huntingHumanFlesh            item a skinned player's body gives, editor id or desc, default HumanFlesh (Skyrim.esm 001016B3)
//   huntingHumanHeart            item it may add, default HumanHeart (Skyrim.esm 000B18CD); "" gives none
//   huntingHumanHeartChance      chance of the heart, default 0.1
//   huntingKhajiitPelt           item a body showing KhajiitRace or KhajiitRaceVampire may add, default AldKhajiitPelt; "" gives none
//   huntingKhajiitPeltChance     chance of that pelt, default 0.2

const NOTICE_PACKET = "masteryNotice";
const DEFAULT_BUTCHER_CHANCE = 0.25;
const BUTCHER_RANK = 3;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
const ANIMAL_KEYWORD = "ActorTypeAnimal";
const SKIN_SECONDS = 5;
const SKIN_REACH = 400;
// The kneel the flora harvest and the emote wheel play; its Kneeling_Behavior plays the same clips as the IdleSearchBody idle
const SKIN_ANIM = "IdleKneelingEnter";
// Holds the skinner's actor id once a skinning started, so a body gives one pelt
const SKINNED_PROP = "private.skinned";
// Emitted on SystemContext.gm (bodyId) once a skinning completed; NpcSpawnSystem removes a zone corpse at once
const CORPSE_CONSUMED_EVENT = "corpseConsumed";
// PetSystem's record on a pet actor
const PET_PROP = "private.pet";
const PLAYER_SKIN_MODES = ["crouch", "interact", "off"] as const;
type PlayerSkinMode = typeof PLAYER_SKIN_MODES[number];
const DEFAULT_HUMAN_FLESH = "HumanFlesh";
const DEFAULT_HUMAN_HEART = "HumanHeart";
const DEFAULT_HEART_CHANCE = 0.1;
const DEFAULT_KHAJIIT_PELT = "AldKhajiitPelt";
const DEFAULT_KHAJIIT_PELT_CHANCE = 0.2;
// Skyrim.esm 13745 and 88845, matched against the race a body's appearance shows
const KHAJIIT_RACES = ["KhajiitRace", "KhajiitRaceVampire"];

// A dead player character's own actor, or the body a PK left of them
interface PlayerBody {
  bodyId: number;
  victimId: number;
  profileId: number;
  pk: boolean;
}

interface PlayerSkin extends PlayerBody {
  skinnerId: number;
}

const chanceOf = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

const pct = (chance: number): string => `${Math.round(chance * 100)}%`;

const bodyName = (body: PlayerBody): string =>
  body.pk ? `the PK body ${hex(body.bodyId)} of player ${hex(body.victimId)}` : `the body of player ${hex(body.bodyId)}`;

// Raw meat the vanilla and DLC animals drop; VendorItemFoodRaw misses most of the meat, so they are listed.
const DEFAULT_MEATS = ["FoodVenison", "FoodRabbit", "FoodBeef", "FoodGoatMeat", "FoodHorseMeat", "FoodHorkerMeat", "FoodMammothMeat", "FoodChicken", "FoodDogMeat", "BYOHFoodMudcrabLegs", "DLC2FoodBoarMeat", "DLC2FoodAshHopperLeg", "DLC2FoodAshHopperMeat"];
// Specific fragments first: the race editor ids are BearBlackRace, DLC1SabreCatGlowRace and so on, the NPC_ ones EncWolfIce and EncFoxArctic.
// Bears follow the vanilla death items: the black bear gives Bear Pelt, brown and cave bears Cave Bear Pelt, snow bears Snow Bear Pelt
const DEFAULT_PELT_MAP: Record<string, string> = {
  bearblack: "BearPelt", bearbrown: "BearCavePelt", bearcave: "BearCavePelt", bearsnow: "BearSnowPelt", bear: "BearPelt",
  sabrecatglow: "DLC1SabreCatHide", sabrecatvale: "DLC1SabreCatHide", sabrecatsnow: "SabreCatSnowPelt", sabrecat: "SabreCatPelt",
  wolfice: "WolfIcePelt", icewolf: "WolfIcePelt", wolf: "WolfPelt",
  foxarctic: "FoxPeltSnow", foxsnow: "FoxPeltSnow", snowfox: "FoxPeltSnow", fox: "FoxPelt",
  deerglow: "DLC1DeerHide", deervale: "DLC1DeerHide", elk: "DeerHide", deer: "DeerHide",
  goat: "GoatHide", cow: "CowHide", horse: "HorseHide", netch: "DLC2NetchLeather",
};

// Meat a skinning hands over, by the same editor id fragments as the pelts
interface MeatRule {
  fragment: string;
  meatId: number;
  count: number;
}

// Name-major: the earliest name holding any rule's fragment decides, and the first rule found in it wins
const firstRuleFor = <T extends { fragment: string }>(names: string[], rules: T[]): { name: string; rule: T } | undefined => {
  for (const name of names) {
    const rule = rules.find((r) => name.includes(r.fragment));
    if (rule) return { name, rule };
  }
  return undefined;
};

const DEFAULT_MEAT_MAP: Record<string, [string, number]> = {
  elk: ["FoodVenison", 2], deer: ["FoodVenison", 2], rabbit: ["FoodRabbit", 1], hare: ["FoodRabbit", 1],
  cow: ["FoodBeef", 2], goat: ["FoodGoatMeat", 2], horse: ["FoodHorseMeat", 2], horker: ["FoodHorkerMeat", 2],
  mammoth: ["FoodMammothMeat", 3], chicken: ["FoodChicken", 1], dog: ["FoodDogMeat", 1], mudcrab: ["BYOHFoodMudcrabLegs", 2],
  boar: ["DLC2FoodBoarMeat", 2], ashhopper: ["DLC2FoodAshHopperMeat", 1],
};

export class HuntingSystem implements System {
  systemName = "HuntingSystem";

  constructor(private log: Log, private mastery: MasterySystem, private needs: NeedsSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    this.butcherChance = chanceOf(all?.["huntingButcherChance"], DEFAULT_BUTCHER_CHANCE);
    const meats = Array.isArray(all?.["huntingMeats"]) ? (all!["huntingMeats"] as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : DEFAULT_MEATS;
    const rawMap = all?.["huntingPeltMap"];
    const peltMap = rawMap && typeof rawMap === "object" ? rawMap as Record<string, string> : DEFAULT_PELT_MAP;
    const rawMeat = all?.["huntingMeatMap"];
    const meatMap = rawMeat && typeof rawMeat === "object" ? rawMeat as Record<string, [string, number]> : DEFAULT_MEAT_MAP;
    const rawMode = all?.["huntingSkinPlayers"];
    const mode = PLAYER_SKIN_MODES.find((m) => m === rawMode);
    if (rawMode !== undefined && !mode) this.log(`[hunting] huntingSkinPlayers ${JSON.stringify(rawMode)} is not one of ${PLAYER_SKIN_MODES.join(", ")}, "crouch" is used`);
    this.playerSkinMode = mode ?? "crouch";
    this.ctx = ctx;
    this.heartChance = chanceOf(all?.["huntingHumanHeartChance"], DEFAULT_HEART_CHANCE);
    this.khajiitPeltChance = chanceOf(all?.["huntingKhajiitPeltChance"], DEFAULT_KHAJIIT_PELT_CHANCE);
    const itemName = (raw: unknown, fallback: string): string => typeof raw === "string" ? raw.trim() : fallback;
    const human = [itemName(all?.["huntingHumanFlesh"], DEFAULT_HUMAN_FLESH), itemName(all?.["huntingHumanHeart"], DEFAULT_HUMAN_HEART), itemName(all?.["huntingKhajiitPelt"], DEFAULT_KHAJIIT_PELT)];
    await this.resolveItems(ctx, meats, peltMap, meatMap, human, s.dataDir, s.loadOrder);
    chainMpHook(ctx.svr as Mp, "onActivate", (targetId: number, casterId: number) => !this.trySkin(ctx, casterId >>> 0, targetId >>> 0, false));
    chainMpHook(ctx.svr as Mp, "onRespawn", (actorId: number) => { this.onRespawn(ctx, actorId >>> 0); });
    const khajiit = this.khajiitPeltId && this.khajiitRaces.size ? `, the Khajiit pelt ${hex(this.khajiitPeltId)} at ${pct(this.khajiitPeltChance)} for race ${Array.from(this.khajiitRaces, hex).join(", ")}` : ", no Khajiit pelt";
    const players = this.playerSkinMode === "off" || !this.humanFleshId ? "players not skinned"
      : `players skinned on ${this.playerSkinMode} for ${hex(this.humanFleshId)}${this.humanHeartId ? ` and the heart ${hex(this.humanHeartId)} at ${pct(this.heartChance)}` : ", no heart"}${khajiit}`;
    this.log(`[hunting] ready, ${this.pelts.length} pelt and ${this.meatRules.length} meat rule(s) for skinning, butcher ${pct(this.butcherChance)}, ${players}`);
  }

  private async resolveItems(ctx: SystemContext, meats: string[], peltMap: Record<string, string>, meatMap: Record<string, [string, number]>, human: string[], dataDir: string, loadOrder: string[]): Promise<void> {
    const pelts = Object.values(peltMap).filter((v) => typeof v === "string");
    const meatNames = Object.values(meatMap).map((v) => Array.isArray(v) ? String(v[0]) : "").filter((v) => v);
    const names = meats.concat(pelts, meatNames, human.filter((v) => v), [ANIMAL_KEYWORD], KHAJIIT_RACES);
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, ["ALCH", "MISC", "INGR", "KYWD", "RACE"]);
    const mp = ctx.svr as Mp;
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
    const unresolved: string[] = [];
    for (const name of meats) {
      const id = idOf(name);
      if (id) this.meats.add(id); else unresolved.push(name);
    }
    for (const [fragment, pelt] of Object.entries(peltMap)) {
      const id = typeof pelt === "string" ? idOf(pelt) : 0;
      if (id) this.pelts.push({ fragment: fragment.toLowerCase(), peltId: id }); else unresolved.push(String(pelt));
    }
    for (const [fragment, rule] of Object.entries(meatMap)) {
      const id = Array.isArray(rule) ? idOf(String(rule[0])) : 0;
      const count = Array.isArray(rule) ? Math.max(1, Math.floor(Number(rule[1])) || 1) : 1;
      if (id) this.meatRules.push({ fragment: fragment.toLowerCase(), meatId: id, count }); else unresolved.push(String(Array.isArray(rule) ? rule[0] : rule));
    }
    const [flesh, heart, khajiitPelt] = human;
    this.humanFleshId = flesh ? idOf(flesh) : 0;
    this.humanHeartId = heart ? idOf(heart) : 0;
    this.khajiitPeltId = khajiitPelt ? idOf(khajiitPelt) : 0;
    if (flesh && !this.humanFleshId) unresolved.push(flesh);
    if (heart && !this.humanHeartId) unresolved.push(heart);
    if (khajiitPelt && !this.khajiitPeltId) unresolved.push(khajiitPelt);
    for (const race of KHAJIIT_RACES) {
      const id = idOf(race);
      if (id) this.khajiitRaces.add(id); else unresolved.push(race);
    }
    this.animalKeyword = idOf(ANIMAL_KEYWORD);
    if (!this.animalKeyword) unresolved.push(ANIMAL_KEYWORD);
    if (unresolved.length) this.log(`[hunting] not in the load order, ignored: ${unresolved.join(", ")}`);
  }

  // True when the interaction became a skinning, so the body is not opened this time; decided from reads, everything else runs after the hook
  // players is false for the native activation, which skips SearchSystem's checks of who is searching the body; chosen is the interact menu's Skin (true) or Search (false) on a player's body
  trySkin(ctx: SystemContext, actorId: number, bodyId: number, players = true, chosen?: boolean): boolean {
    const mp = ctx.svr as Mp;
    if (!isPlayerActor(mp, actorId) || !this.isBody(mp, bodyId)) return false;
    if (isPlayerActor(mp, bodyId)) return players && chosen !== false && this.trySkinPlayer(ctx, actorId, bodyId, !!chosen);
    const rank = this.mastery.rankOf(ctx, actorId, "hunter");
    if (!rank || this.skinning.has(bodyId) || !this.isAnimal(ctx, bodyId) || this.isSkinned(mp, bodyId)) return false;
    const names = this.namesOf(ctx, bodyId);
    const pelt = firstRuleFor(names, this.pelts);
    const peltId = pelt?.rule.peltId || 0;
    const meat = firstRuleFor(names, this.meatRules)?.rule;
    if ((!peltId && !meat && !this.meatOf(mp, bodyId).length) || !isNear(mp, actorId, bodyId, SKIN_REACH)) return false;
    if (!holdsItem(mp, actorId, (baseId) => baseId === HUNTING_KNIFE_ID) || !this.needs.canPay(actorId, "fight", rank, true)) return false;
    this.skinning.add(bodyId);
    setImmediate(() => {
      try { mp.set(bodyId, SKINNED_PROP, actorId); } catch { /* body gone */ }
      sendActionLock(mp, actorId, SKIN_ANIM, SKIN_SECONDS);
    });
    this.log(`[hunting] ${hex(actorId)} skins ${hex(bodyId)} (${names.join(" > ") || "no names"}): ${pelt ? `${pelt.rule.fragment} in ${pelt.name}` : "no pelt rule"}`);
    setTimeout(() => this.finishSkin(ctx, actorId, bodyId, peltId, meat), SKIN_SECONDS * 1000);
    return true;
  }

  // A player character's own body until its respawn, or the body a PK left of them, once per death
  private trySkinPlayer(ctx: SystemContext, actorId: number, bodyId: number, chosen: boolean): boolean {
    const mp = ctx.svr as Mp;
    const body = this.playerBodyOf(mp, bodyId);
    const rank = this.playerSkinRank(ctx, actorId, body);
    if (!body || !rank || !(chosen || this.playerSkinMode !== "crouch" || isSneaking(mp, actorId)) || !this.needs.canPay(actorId, "fight", rank, true)) return false;
    const job: PlayerSkin = { ...body, skinnerId: actorId };
    this.playerSkins.set(bodyId, job);
    setImmediate(() => sendActionLock(mp, actorId, SKIN_ANIM, SKIN_SECONDS));
    this.log(`[hunting] ${hex(actorId)} skins ${bodyName(job)} (profile ${job.profileId})`);
    setTimeout(() => this.finishPlayerSkin(ctx, job), SKIN_SECONDS * 1000);
    return true;
  }

  // The hunter rank that may skin this player body now, 0 for no hunter, no knife, a body skinned or being skinned, one out of reach, or the PK body of their own account
  private playerSkinRank(ctx: SystemContext, actorId: number, body?: PlayerBody): number {
    const mp = ctx.svr as Mp;
    if (this.playerSkinMode === "off" || !this.humanFleshId || !body) return 0;
    const rank = this.mastery.rankOf(ctx, actorId, "hunter");
    if (!rank || this.playerSkins.has(body.bodyId) || !isNear(mp, actorId, body.bodyId, SKIN_REACH)) return 0;
    // The search refusal tells the victim's own account and the skinned own body; a skinned PK body opens for the search
    if (body.pk && body.profileId >= 0 && this.profileOf(mp, actorId) === body.profileId) return 0;
    return this.wasSkinned(mp, body) || !holdsItem(mp, actorId, (baseId) => baseId === HUNTING_KNIFE_ID) ? 0 : rank;
  }

  // The player menu's flags for a dead player's body: skin while trySkinPlayer would start for a chosen Skin, skinTired while only the fatigue refuses it
  menuFlags(actorId: number, bodyId: number): Record<string, boolean> {
    const ctx = this.ctx;
    const mp = ctx?.svr as Mp;
    if (!ctx || this.playerSkinMode !== "crouch" || !isPlayerActor(mp, actorId) || !this.isBody(mp, bodyId) || !isPlayerActor(mp, bodyId)) return {};
    const rank = this.playerSkinRank(ctx, actorId, this.playerBodyOf(mp, bodyId));
    return rank ? { skin: true, skinTired: !this.needs.canPay(actorId, "fight", rank, true) } : {};
  }

  // The fallen character a player body stands for; the stripped actor of a PK victim is passed over, as the PK body holds that death
  private playerBodyOf(mp: Mp, bodyId: number): PlayerBody | undefined {
    const pk = this.pkBodyOf?.(bodyId);
    if (pk) return { bodyId, victimId: pk.victimId, profileId: pk.profileId, pk: true };
    const profileId = this.profileOf(mp, bodyId);
    return profileId >= 0 && !this.leftBody?.(bodyId) ? { bodyId, victimId: bodyId, profileId, pk: false } : undefined;
  }

  // A PK body keeps its mark for good, an own body until the respawn
  private wasSkinned(mp: Mp, body: PlayerBody): boolean {
    return body.pk ? this.isSkinned(mp, body.bodyId) : this.skinnedPlayers.has(body.bodyId);
  }

  // Flesh, maybe the heart and on a Khajiit maybe the pelt; a PK body adds its whole pack, an own body goes with the victim's respawn
  private finishPlayerSkin(ctx: SystemContext, job: PlayerSkin): void {
    if (this.playerSkins.get(job.bodyId) !== job) return;
    this.playerSkins.delete(job.bodyId);
    const mp = ctx.svr as Mp;
    const { skinnerId, bodyId } = job;
    sendActionLock(mp, skinnerId, SKIN_ANIM, 0);
    const stop = !this.isBody(mp, bodyId) ? "the body is gone" : !job.pk && this.leftBody?.(bodyId) ? "a PK body took their pack"
      : this.interruption(ctx, skinnerId, bodyId);
    if (stop) {
      this.log(`[hunting] ${hex(skinnerId)} stopped skinning ${bodyName(job)}: ${stop}`);
      return;
    }
    try {
      const heart = !!this.humanHeartId && Math.random() < this.heartChance;
      const khajiit = !!this.khajiitPeltId && this.looksKhajiit(mp, bodyId);
      const pelt = khajiit && Math.random() < this.khajiitPeltChance;
      if (job.pk) mp.set(bodyId, SKINNED_PROP, skinnerId); else this.skinnedPlayers.set(bodyId, skinnerId);
      addItemTo(mp, skinnerId, this.humanFleshId, 1);
      if (heart) addItemTo(mp, skinnerId, this.humanHeartId, 1);
      if (pelt) addItemTo(mp, skinnerId, this.khajiitPeltId, 1);
      let moved = "";
      let packPart = "nothing of the pack taken, the victim respawns now";
      if (job.pk) {
        try {
          moved = this.emptyPkBody?.(bodyId, skinnerId) ?? "";
          packPart = moved ? `the pack went to the skinner: ${moved}` : "the body held nothing";
        } catch (e) {
          packPart = `the body keeps its pack, the hand-off failed: ${e}`;
        }
      }
      this.needs.pay(ctx, skinnerId, "fight", this.mastery.rankOf(ctx, skinnerId, "hunter"), "skin", true);
      this.mastery.creditWork(skinnerId, "hunter");
      const peltPart = khajiit ? `, ${pelt ? `Khajiit pelt ${hex(this.khajiitPeltId)}` : "no Khajiit pelt"} (${pct(this.khajiitPeltChance)} chance)` : "";
      this.log(`[hunting] ${hex(skinnerId)} skinned ${bodyName(job)} (profile ${job.profileId}): ${hex(this.humanFleshId)} x1, ${heart ? `heart ${hex(this.humanHeartId)}` : "no heart"}${this.humanHeartId ? ` (${pct(this.heartChance)} chance)` : ""}${peltPart}, ${packPart}`);
      if (!job.pk) this.respawnSkinned(mp, job.victimId);
    } catch (e) {
      this.log(`[hunting] skinning ${bodyName(job)} by ${hex(skinnerId)} failed: ${e}`);
    }
  }

  // A skinned own body goes like a looted one; when the respawn fails it lies, refused to searches, until respawnSeconds
  private respawnSkinned(mp: Mp, victimId: number): void {
    try {
      mp.respawnActor(victimId);
    } catch (e) {
      this.log(`[hunting] respawning player ${hex(victimId)} after the skinning failed, the body lies until its respawn: ${e}`);
    }
  }

  // By the race the body shows, so a PK body and a polymorphed character count by their look
  private looksKhajiit(mp: Mp, bodyId: number): boolean {
    try { return this.khajiitRaces.has(Number(mp.get(bodyId, "appearance")?.raceId) >>> 0); } catch { return false; }
  }

  // A respawn ends the body: a skinning under way stops and the next death is a fresh body
  private onRespawn(ctx: SystemContext, actorId: number): void {
    this.skinnedPlayers.delete(actorId);
    const job = this.playerSkins.get(actorId);
    if (!job) return;
    this.playerSkins.delete(actorId);
    const mp = ctx.svr as Mp;
    sendActionLock(mp, job.skinnerId, SKIN_ANIM, 0);
    this.log(`[hunting] ${hex(job.skinnerId)} stopped skinning the body of player ${hex(actorId)}: they respawned`);
  }

  // Why a dead player's body may not be searched now, "" when it may
  searchRefusal(bodyId: number): string {
    return this.playerSkins.has(bodyId) ? "A hunter is skinning this body."
      : this.skinnedPlayers.has(bodyId) ? "This body has been skinned. Nothing can be taken from it." : "";
  }

  // Why the skinner can no longer finish, "" while they can
  private interruption(ctx: SystemContext, actorId: number, bodyId: number): string {
    const mp = ctx.svr as Mp;
    return this.userOf(ctx, actorId) < 0 ? "offline" : !isAlive(mp, actorId) ? "dead" : isBleedingOut(mp, actorId) ? "downed"
      : isRestrained(mp, actorId) ? "restrained" : !isNear(mp, actorId, bodyId, SKIN_REACH) ? "out of reach" : "";
  }

  // A skinner who left, died, went down, was restrained or went offline leaves the body skinnable for the next try
  private finishSkin(ctx: SystemContext, actorId: number, bodyId: number, peltId: number, meat?: MeatRule): void {
    const mp = ctx.svr as Mp;
    this.skinning.delete(bodyId);
    sendActionLock(mp, actorId, SKIN_ANIM, 0);
    try {
      if (this.interruption(ctx, actorId, bodyId)) {
        mp.set(bodyId, SKINNED_PROP, 0);
        return;
      }
      if (peltId) addItemTo(mp, actorId, peltId, 1);
      const pet = this.isPet(mp, bodyId);
      const stacks = this.takeFrom(mp, actorId, bodyId, pet ? (baseId) => this.meats.has(baseId) : () => true);
      if (meat) {
        const butcher = this.mastery.rankOf(ctx, actorId, "hunter") >= BUTCHER_RANK && Math.random() < this.butcherChance;
        addItemTo(mp, actorId, meat.meatId, meat.count + (butcher ? 1 : 0));
        if (butcher) this.notice(ctx, this.userOf(ctx, actorId), "Your butcher's eye finds an extra cut of meat.");
      }
      this.needs.pay(ctx, actorId, "fight", this.mastery.rankOf(ctx, actorId, "hunter"), "skin", true);
      this.mastery.creditWork(actorId, "hunter");
      this.log(`[hunting] ${hex(actorId)} skinned ${hex(bodyId)} for ${hex(peltId)} and ${stacks} stack(s) of the carcass`);
      if (!pet) this.consumeBody(ctx, bodyId);
    } catch (e) {
      this.log(`[hunting] skinning ${hex(bodyId)} by ${hex(actorId)} failed: ${e}`);
    }
  }

  private isSkinned(mp: Mp, bodyId: number): boolean {
    try { return !!mp.get(bodyId, SKINNED_PROP); } catch { return true; }
  }

  // A dead actor; isDead is never read off a non-actor, which would log a native error
  private isBody(mp: Mp, id: number): boolean {
    try { return mp.get(id, "type") === "MpActor" && mp.get(id, "isDead") === true; } catch { return false; }
  }

  // Player characters carry a profile id; NPCs and the PK clone keep -1
  private profileOf(mp: Mp, actorId: number): number {
    try { return Number(mp.get(actorId, "profileId")); } catch { return -1; }
  }

  // Lower-cased editor ids the pelt and meat rules match: the body's own NPC_, the race that supplies its traits, then its templates
  private namesOf(ctx: SystemContext, bodyId: number): string[] {
    const mp = ctx.svr as Mp;
    const lookup = (id: number): any => { try { return id ? mp.lookupEspmRecordById(id) : null; } catch { return null; } };
    const edidOf = (id: number, type: string): string => {
      const res = lookup(id);
      return res?.record?.type === type ? String(res.record.editorId || "").toLowerCase() : "";
    };
    const chain = npcChainOf(mp, bodyId);
    const names = chain.map((id) => edidOf(id, "NPC_"));
    names.splice(1, 0, edidOf(effectiveRaceId(mp, chain), "RACE"));
    return names.filter((n) => n);
  }

  // Only a hunter's skinning takes an animal's meat
  hidesMeat(ctx: SystemContext, bodyId: number, baseId: number): boolean {
    return this.meats.has(baseId >>> 0) && this.isAnimal(ctx, bodyId);
  }

  // The raw meat of huntingMeats and the meat rules, resolved at boot
  rawMeatIds(): number[] {
    return Array.from(new Set([...this.meats, ...this.meatRules.map((r) => r.meatId)]));
  }

  private meatOf(mp: Mp, bodyId: number): Array<{ baseId: number; count: number }> {
    try {
      const entries: any[] = mp.get(bodyId, "inventory")?.entries || [];
      return entries.filter((e) => this.meats.has(Number(e.baseId) >>> 0) && Number(e.count) > 0);
    } catch {
      return [];
    }
  }

  // Moves the body's stacks that match to the skinner; the number of stacks moved
  private takeFrom(mp: Mp, actorId: number, bodyId: number, match: (baseId: number) => boolean): number {
    const entries: any[] = mp.get(bodyId, "inventory")?.entries || [];
    const taken = entries.filter((e) => Number(e.count) > 0 && match(Number(e.baseId) >>> 0));
    if (!taken.length) return 0;
    mp.set(bodyId, "inventory", { entries: entries.filter((e) => !taken.includes(e)) });
    // AddItem gives a pristine copy, so a stack that carries wear (durability) moves as the entry it is
    const used = taken.filter((e) => conditionOf(e) < 1);
    for (const e of taken.filter((e) => !used.includes(e))) addItemTo(mp, actorId, Number(e.baseId) >>> 0, Number(e.count));
    if (used.length) mp.set(actorId, "inventory", addEntries(readInventory(mp, actorId), used.map((e) => withCount(e, Number(e.count)))));
    return taken.length;
  }

  // A zone corpse goes at once on corpseConsumed; any other body never respawns, so it stays disabled
  private consumeBody(ctx: SystemContext, bodyId: number): void {
    try { ctx.gm.emit(CORPSE_CONSUMED_EVENT, bodyId); } catch (e) { this.log(`[hunting] ${CORPSE_CONSUMED_EVENT} listener failed for ${hex(bodyId)}: ${e}`); }
    const mp = ctx.svr as Mp;
    try {
      if (mp.get(bodyId, "isDead") !== true) return;
      mp.set(bodyId, "isDisabled", true);
      this.log(`[hunting] body ${hex(bodyId)} hidden for good`);
    } catch { /* removed by its zone */ }
  }

  private isPet(mp: Mp, actorId: number): boolean {
    try { return !!mp.get(actorId, PET_PROP); } catch { return false; }
  }

  isAnimal(ctx: SystemContext, actorId: number): boolean {
    return !!this.animalKeyword && this.mastery.actorHasKeyword(ctx, actorId, this.animalKeyword);
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      const userId = (ctx.svr as Mp).getUserByActor(actorId);
      return userId === INVALID_USER_ID ? -1 : userId;
    } catch {
      return -1;
    }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify({ customPacketType: NOTICE_PACKET, text })); } catch { /* user gone */ }
  }

  // Kept from initAsync for menuFlags, which CaptureSystem calls without one
  private ctx?: SystemContext;
  private butcherChance = DEFAULT_BUTCHER_CHANCE;
  private meats = new Set<number>();
  // Ordered editor id fragment -> pelt rules
  private pelts: Array<{ fragment: string; peltId: number }> = [];
  private animalKeyword = 0;
  private meatRules: MeatRule[] = [];
  // Bodies being skinned right now
  private skinning = new Set<number>();
  private playerSkinMode: PlayerSkinMode = "crouch";
  private humanFleshId = 0;
  private humanHeartId = 0;
  private heartChance = DEFAULT_HEART_CHANCE;
  // Player bodies, own or PK, being skinned right now
  private playerSkins = new Map<number, PlayerSkin>();
  // Own bodies skinned since their death -> the skinner; cleared by the respawn the skinning starts, while a PK body carries SKINNED_PROP
  private skinnedPlayers = new Map<number, number>();
  private khajiitPeltId = 0;
  private khajiitPeltChance = DEFAULT_KHAJIIT_PELT_CHANCE;
  private khajiitRaces = new Set<number>();
  // Set by index.ts: a PK left a body for this victim moments ago, so their own stripped actor is about to respawn
  leftBody?: (victimId: number) => boolean;
  // Set by index.ts: the victim and account of a body a PK left, undefined for any other actor
  pkBodyOf?: (bodyId: number) => { victimId: number; profileId: number } | undefined;
  // Set by index.ts: moves a PK body's whole pack to the skinner, "N item(s) in M stack(s)" or "" when it held nothing; throws when it stays
  emptyPkBody?: (bodyId: number, skinnerId: number) => string;
}
