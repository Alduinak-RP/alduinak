import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { addItemTo, baseIdOf, chainMpHook, hex, holdsItem, isAlive, isNear, isPlayerActor, notifyActor, sendActionLock } from "./actorUtil";
import { MasterySystem } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Skinning: pelts and meat never drop as loot (the plugin strips them, and a search never shows an animal's meat through
// SearchSystem's hidesItem). A hunter holding a hunting knife skins a dead animal: the interact key on the body (SearchSystem's
// bodyAction for spawned animals, the native activation for plugin ones) crouches them over it for SKIN_SECONDS, then hands
// the pelt and the meat the body's race or base editor id maps to, once per body; an Expert hunter's butcher's eye may add one
// more cut. The next interaction searches the body as usual. Skinning costs half a kill of fatigue by hunter rank and credits
// hunter hours.
//
// server-settings.json keys (all optional):
//   huntingButcherChance         chance an Expert or better hunter's skinning gives one more cut of meat, default 0.25
//   huntingMeats                 editor id list replacing DEFAULT_MEATS
//   huntingPeltMap               { "<editor id fragment>": "<pelt editor id>" } replacing DEFAULT_PELT_MAP; the first
//                                fragment found in the body's NPC_ or race editor ids (lower-cased) wins
//   huntingMeatMap               { "<editor id fragment>": ["<meat editor id>", count] } replacing DEFAULT_MEAT_MAP, matched the same way

const NOTICE_PACKET = "masteryNotice";
const DEFAULT_BUTCHER_CHANCE = 0.25;
const BUTCHER_RANK = 3;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
const ANIMAL_KEYWORD = "ActorTypeAnimal";
// Skyrim.esm Hunting Knife
const HUNTING_KNIFE = 0x0001f25a;
const SKIN_SECONDS = 5;
const SKIN_REACH = 400;
const SKIN_ANIM = "IdleSearchBody";
// Holds the skinner's actor id once a skinning started, so a body gives one pelt
const SKINNED_PROP = "private.skinned";

// Raw meat the vanilla and DLC animals drop; VendorItemFoodRaw misses most of the meat, so they are listed.
const DEFAULT_MEATS = ["FoodVenison", "FoodRabbit", "FoodBeef", "FoodGoatMeat", "FoodHorseMeat", "FoodHorkerMeat", "FoodMammothMeat", "FoodChicken", "FoodDogMeat", "BYOHFoodMudcrabLegs", "DLC2FoodBoarMeat", "DLC2FoodAshHopperLeg", "DLC2FoodAshHopperMeat"];
// Specific fragments first: the race editor ids are BearBlackRace, DLC1SabreCatGlowRace and so on, the NPC_ ones EncWolfIce
const DEFAULT_PELT_MAP: Record<string, string> = {
  bearblack: "BearCavePelt", bearcave: "BearCavePelt", bearsnow: "BearSnowPelt", bear: "BearPelt",
  sabrecatglow: "DLC1SabreCatHide", sabrecatvale: "DLC1SabreCatHide", sabrecatsnow: "SabreCatSnowPelt", sabrecat: "SabreCatPelt",
  wolfice: "WolfIcePelt", icewolf: "WolfIcePelt", wolf: "WolfPelt",
  foxsnow: "FoxPeltSnow", snowfox: "FoxPeltSnow", fox: "FoxPelt",
  deerglow: "DLC1DeerHide", deervale: "DLC1DeerHide", elk: "DeerHide", deer: "DeerHide",
  goat: "GoatHide", cow: "CowHide", horse: "HorseHide", netch: "DLC2NetchLeather",
};

// Meat a skinning hands over, by the same editor id fragments as the pelts
interface MeatRule {
  fragment: string;
  meatId: number;
  count: number;
}

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
    const peltId = this.pelts.find((p) => names.some((n) => n.includes(p.fragment)))?.peltId || 0;
    const meat = this.meatRules.find((m) => names.some((n) => n.includes(m.fragment)));
    if ((!peltId && !meat && !this.meatOf(mp, bodyId).length) || !isNear(mp, actorId, bodyId, SKIN_REACH)) return false;
    const refusal = !holdsItem(mp, actorId, (baseId) => baseId === HUNTING_KNIFE) ? "A hunting knife would take its pelt."
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
      this.takeMeat(mp, actorId, bodyId);
      if (meat) {
        const butcher = this.mastery.rankOf(ctx, actorId, "hunter") >= BUTCHER_RANK && Math.random() < this.butcherChance;
        addItemTo(mp, actorId, meat.meatId, meat.count + (butcher ? 1 : 0));
        if (butcher) this.notice(ctx, this.userOf(ctx, actorId), "Your butcher's eye finds an extra cut of meat.");
      }
      this.needs.pay(ctx, actorId, "fight", this.mastery.rankOf(ctx, actorId, "hunter"), "skin", true);
      this.mastery.creditWork(actorId, "hunter");
      this.log(`[hunting] ${hex(actorId)} skinned ${hex(bodyId)} for ${hex(peltId)}`);
    } catch (e) {
      this.log(`[hunting] skinning ${hex(bodyId)} by ${hex(actorId)} failed: ${e}`);
    }
  }

  private isSkinned(mp: Mp, bodyId: number): boolean {
    try { return !!mp.get(bodyId, SKINNED_PROP); } catch { return true; }
  }

  // The lower-cased NPC_ editor ids of the body's template chain and their races', which the pelt and meat rules match
  private namesOf(ctx: SystemContext, bodyId: number): string[] {
    const mp = ctx.svr as Mp;
    const lookup = (id: number): any => { try { return id ? mp.lookupEspmRecordById(id) : null; } catch { return null; } };
    let chain: number[] = [];
    try {
      const tpl = mp.get(bodyId, "templateChain");
      if (Array.isArray(tpl)) chain = tpl.map((x: unknown) => Number(x) >>> 0);
    } catch { /* not an actor */ }
    const names: string[] = [];
    for (const id of [baseIdOf(mp, bodyId), ...chain]) {
      const res = lookup(id);
      if (res?.record?.type !== "NPC_") continue;
      names.push(String(res.record.editorId || "").toLowerCase());
      const race = lookup(espmFieldFormIds(res, "RNAM")[0] || 0);
      if (race?.record) names.push(String(race.record.editorId || "").toLowerCase());
    }
    return names;
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

  private takeMeat(mp: Mp, actorId: number, bodyId: number): void {
    const meat = this.meatOf(mp, bodyId);
    if (!meat.length) return;
    const entries: any[] = mp.get(bodyId, "inventory")?.entries || [];
    mp.set(bodyId, "inventory", { entries: entries.filter((e) => !this.meats.has(Number(e.baseId) >>> 0)) });
    for (const e of meat) addItemTo(mp, actorId, Number(e.baseId) >>> 0, Number(e.count));
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
