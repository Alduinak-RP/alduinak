import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { HUNTING_KNIFE_ID, addItemTo, chainMpHook, hex, holdsItem, isAlive, isNear, isPlayerActor, notifyActor, sendActionLock } from "./actorUtil";
import { effectiveRaceId, npcChainOf } from "./npcTemplate";
import { MasterySystem } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Skinning: pelts and meat never drop as loot (the plugin strips them, and a search never shows an animal's meat through
// SearchSystem's hidesItem). A hunter holding a hunting knife skins a dead animal: the interact key on the body (SearchSystem's
// bodyAction for spawned animals, the native activation for plugin ones) crouches them over it for SKIN_SECONDS, then hands
// the pelt and the meat the body's race or base editor id maps to, once per body; an Expert hunter's butcher's eye may add one
// more cut. The skinner also takes what else the carcass carries, then the body disappears for everyone: a zone corpse on the
// corpseConsumed event (NpcSpawnSystem), any other body disabled for good, as no other NPC respawns (placed ones never do and the
// gamemode's death hook gives the rest a 1e9 s delay). A pet's body stays and gives only its meat. Skinning costs half a kill of fatigue by hunter rank and credits hunter hours.
//
// server-settings.json keys (all optional):
//   huntingButcherChance         chance an Expert or better hunter's skinning gives one more cut of meat, default 0.25
//   huntingMeats                 editor id list replacing DEFAULT_MEATS
//   huntingPeltMap               { "<editor id fragment>": "<pelt editor id>" } replacing DEFAULT_PELT_MAP; the body's own NPC_
//                                editor id is tried first, then its race, then its templates (lower-cased), and the first
//                                fragment found in the earliest name that holds one wins
//   huntingMeatMap               { "<editor id fragment>": ["<meat editor id>", count] } replacing DEFAULT_MEAT_MAP, matched the same way

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
    const butcher = Number(all?.["huntingButcherChance"]);
    this.butcherChance = Number.isFinite(butcher) && butcher >= 0 && butcher <= 1 ? butcher : DEFAULT_BUTCHER_CHANCE;
    const meats = Array.isArray(all?.["huntingMeats"]) ? (all!["huntingMeats"] as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : DEFAULT_MEATS;
    const rawMap = all?.["huntingPeltMap"];
    const peltMap = rawMap && typeof rawMap === "object" ? rawMap as Record<string, string> : DEFAULT_PELT_MAP;
    const rawMeat = all?.["huntingMeatMap"];
    const meatMap = rawMeat && typeof rawMeat === "object" ? rawMeat as Record<string, [string, number]> : DEFAULT_MEAT_MAP;
    await this.resolveItems(ctx, meats, peltMap, meatMap, s.dataDir, s.loadOrder);
    chainMpHook(ctx.svr as Mp, "onActivate", (targetId: number, casterId: number) => !this.trySkin(ctx, casterId >>> 0, targetId >>> 0));
    this.log(`[hunting] ready, ${this.pelts.length} pelt and ${this.meatRules.length} meat rule(s) for skinning, butcher ${Math.round(this.butcherChance * 100)}%`);
  }

  private async resolveItems(ctx: SystemContext, meats: string[], peltMap: Record<string, string>, meatMap: Record<string, [string, number]>, dataDir: string, loadOrder: string[]): Promise<void> {
    const pelts = Object.values(peltMap).filter((v) => typeof v === "string");
    const meatNames = Object.values(meatMap).map((v) => Array.isArray(v) ? String(v[0]) : "").filter((v) => v);
    const names = meats.concat(pelts, meatNames, [ANIMAL_KEYWORD]);
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, ["ALCH", "MISC", "INGR", "KYWD"]);
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
    this.animalKeyword = idOf(ANIMAL_KEYWORD);
    if (!this.animalKeyword) unresolved.push(ANIMAL_KEYWORD);
    if (unresolved.length) this.log(`[hunting] not in the load order, ignored: ${unresolved.join(", ")}`);
  }

  // True when the interaction became a skinning, so the body is not opened this time; decided from reads, everything else runs after the hook
  trySkin(ctx: SystemContext, actorId: number, bodyId: number): boolean {
    const mp = ctx.svr as Mp;
    if (!isPlayerActor(mp, actorId) || isPlayerActor(mp, bodyId) || isAlive(mp, bodyId)) return false;
    const rank = this.mastery.rankOf(ctx, actorId, "hunter");
    if (!rank || this.skinning.has(bodyId) || !this.isAnimal(ctx, bodyId) || this.isSkinned(mp, bodyId)) return false;
    const names = this.namesOf(ctx, bodyId);
    const pelt = firstRuleFor(names, this.pelts);
    const peltId = pelt?.rule.peltId || 0;
    const meat = firstRuleFor(names, this.meatRules)?.rule;
    if ((!peltId && !meat && !this.meatOf(mp, bodyId).length) || !isNear(mp, actorId, bodyId, SKIN_REACH)) return false;
    const refusal = !holdsItem(mp, actorId, (baseId) => baseId === HUNTING_KNIFE_ID) ? "A hunting knife would take its pelt."
      : !this.needs.canPay(actorId, "fight", rank, true) ? "You are too tired to skin it. Rest a while." : "";
    if (refusal) {
      setImmediate(() => notifyActor(mp, actorId, refusal));
      return false;
    }
    this.skinning.add(bodyId);
    setImmediate(() => {
      try { mp.set(bodyId, SKINNED_PROP, actorId); } catch { /* body gone */ }
      sendActionLock(mp, actorId, SKIN_ANIM, SKIN_SECONDS);
    });
    this.log(`[hunting] ${hex(actorId)} skins ${hex(bodyId)} (${names.join(" > ") || "no names"}): ${pelt ? `${pelt.rule.fragment} in ${pelt.name}` : "no pelt rule"}`);
    setTimeout(() => this.finishSkin(ctx, actorId, bodyId, peltId, meat), SKIN_SECONDS * 1000);
    return true;
  }

  // A skinner who left, died or went offline leaves the body skinnable for the next try
  private finishSkin(ctx: SystemContext, actorId: number, bodyId: number, peltId: number, meat?: MeatRule): void {
    const mp = ctx.svr as Mp;
    this.skinning.delete(bodyId);
    try {
      if (this.userOf(ctx, actorId) < 0 || !isAlive(mp, actorId) || !isNear(mp, actorId, bodyId, SKIN_REACH)) {
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
    for (const e of taken) addItemTo(mp, actorId, Number(e.baseId) >>> 0, Number(e.count));
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

  private butcherChance = DEFAULT_BUTCHER_CHANCE;
  private meats = new Set<number>();
  // Ordered editor id fragment -> pelt rules
  private pelts: Array<{ fragment: string; peltId: number }> = [];
  private animalKeyword = 0;
  private meatRules: MeatRule[] = [];
  // Bodies being skinned right now
  private skinning = new Set<number>();
}
