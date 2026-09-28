import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { addItemTo, baseIdOf, chainMpHook, hex, holdsItem, isAlive, isNear, isPlayerActor, notifyActor, sendActionLock } from "./actorUtil";
import { MasterySystem } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Hunter rank bonuses on animal kills, and skinning.
//
// Butcher (Expert) rolls once per kind of meat the animal dropped; a win hands the hunter one more of that item directly.
// Kills reach this system through the mastery relay (gamemode 62_mastery.js -> globalThis.__alduinakMasteryEvent),
// which fires before the engine adds the death items; the queue is drained a tick later, when they are there.
//
// Pelts never drop as loot (the plugin strips them). A hunter holding a hunting knife skins a dead animal: the interact
// key on the body (SearchSystem's bodyAction for spawned animals, the native activation for plugin ones) kneels them for
// SKIN_SECONDS, then hands the pelt the body's race or base editor id maps to, once per body. The next interaction
// searches the body as usual. Skinning costs one gathering action of fatigue by hunter rank and credits hunter hours.
//
// server-settings.json keys (all optional):
//   huntingButcherChance         chance of one extra meat per kind, default 0.25
//   huntingMeats                 editor id list replacing DEFAULT_MEATS
//   huntingPeltMap               { "<editor id fragment>": "<pelt editor id>" } replacing DEFAULT_PELT_MAP; the first
//                                fragment found in the body's NPC_ or race editor ids (lower-cased) wins

const NOTICE_PACKET = "masteryNotice";
const DEFAULT_BUTCHER_CHANCE = 0.25;
const BUTCHER_RANK = 3;
const MAX_QUEUED_KILLS = 1024;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
const ANIMAL_KEYWORD = "ActorTypeAnimal";
// Skyrim.esm Hunting Knife
const HUNTING_KNIFE = 0x0001f25a;
const SKIN_SECONDS = 5;
const SKIN_REACH = 400;
const SKIN_ANIM = "IdleKneelingEnter";
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

interface Kill {
  killerId: number;
  victimId: number;
}

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
    await this.resolveItems(ctx, meats, peltMap, s.dataDir, s.loadOrder);
    this.installHooks(ctx);
    this.log(`[hunting] ready, butcher ${Math.round(this.butcherChance * 100)}% on ${this.meats.size} meat(s), ${this.pelts.length} pelt rule(s) for skinning`);
  }

  private async resolveItems(ctx: SystemContext, meats: string[], peltMap: Record<string, string>, dataDir: string, loadOrder: string[]): Promise<void> {
    const pelts = Object.values(peltMap).filter((v) => typeof v === "string");
    const names = meats.concat(pelts, [ANIMAL_KEYWORD]);
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
    this.animalKeyword = idOf(ANIMAL_KEYWORD);
    if (!this.animalKeyword) unresolved.push(ANIMAL_KEYWORD);
    if (unresolved.length) this.log(`[hunting] not in the load order, ignored: ${unresolved.join(", ")}`);
  }

  // Kills ride the mastery relay; plugin bodies are skinned through their native activation
  private installHooks(ctx: SystemContext): void {
    const g = globalThis as any;
    const previous = g.__alduinakMasteryEvent;
    g.__alduinakMasteryEvent = (kind: string, actorId: number, detail: any) => {
      try {
        if (typeof previous === "function") previous(kind, actorId, detail);
      } finally {
        if (kind === "kill" && detail && this.kills.length < MAX_QUEUED_KILLS) {
          this.kills.push({ killerId: Number(actorId) >>> 0, victimId: Number(detail.victimId) >>> 0 });
        }
      }
    };
    chainMpHook(ctx.svr as Mp, "onActivate", (targetId: number, casterId: number) => !this.trySkin(ctx, casterId >>> 0, targetId >>> 0));
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    if (!this.kills.length) return;
    const batch = this.kills.splice(0, this.kills.length);
    for (const kill of batch) {
      try {
        this.onKill(ctx, kill);
      } catch (e) {
        this.log(`[hunting] kill bonus failed for ${kill.killerId.toString(16)}: ${e}`);
      }
    }
  }

  private onKill(ctx: SystemContext, kill: Kill): void {
    if (!kill.killerId || !kill.victimId || !isPlayerActor(ctx.svr as Mp, kill.killerId)) return;
    if (this.mastery.rankOf(ctx, kill.killerId, "hunter") < BUTCHER_RANK || !this.isAnimal(ctx, kill.victimId)) return;
    const userId = this.userOf(ctx, kill.killerId);
    for (const baseId of this.inventoryKinds(ctx, kill.victimId)) {
      if (!this.meats.has(baseId) || Math.random() >= this.butcherChance) continue;
      addItemTo(ctx.svr as Mp, kill.killerId, baseId, 1);
      this.notice(ctx, userId, "Your butcher's eye finds an extra cut of meat.");
    }
  }

  // True when the interaction became a skinning, so the body is not opened this time; decided from reads, everything else runs after the hook
  trySkin(ctx: SystemContext, actorId: number, bodyId: number): boolean {
    const mp = ctx.svr as Mp;
    if (!isPlayerActor(mp, actorId) || isPlayerActor(mp, bodyId) || isAlive(mp, bodyId)) return false;
    const rank = this.mastery.rankOf(ctx, actorId, "hunter");
    if (!rank || this.skinning.has(bodyId) || !this.isAnimal(ctx, bodyId) || this.isSkinned(mp, bodyId)) return false;
    const peltId = this.peltOf(ctx, bodyId);
    if (!peltId || !isNear(mp, actorId, bodyId, SKIN_REACH)) return false;
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
    setTimeout(() => this.finishSkin(ctx, actorId, bodyId, peltId), SKIN_SECONDS * 1000);
    return true;
  }

  // A skinner who left, died or went offline leaves the body skinnable for the next try
  private finishSkin(ctx: SystemContext, actorId: number, bodyId: number, peltId: number): void {
    const mp = ctx.svr as Mp;
    this.skinning.delete(bodyId);
    try {
      if (this.userOf(ctx, actorId) < 0 || !isAlive(mp, actorId) || !isNear(mp, actorId, bodyId, SKIN_REACH)) {
        mp.set(bodyId, SKINNED_PROP, 0);
        return;
      }
      addItemTo(mp, actorId, peltId, 1);
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

  // The pelt of the first rule whose fragment is in an NPC_ editor id of the body's template chain or its race's
  private peltOf(ctx: SystemContext, bodyId: number): number {
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
    return this.pelts.find((p) => names.some((n) => n.includes(p.fragment)))?.peltId || 0;
  }

  private inventoryKinds(ctx: SystemContext, actorId: number): Set<number> {
    const out = new Set<number>();
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory");
      for (const e of (inv && Array.isArray(inv.entries)) ? inv.entries : []) {
        if (Number(e.count) > 0) out.add(Number(e.baseId) >>> 0);
      }
    } catch { /* not a container */ }
    return out;
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
  private kills: Kill[] = [];
  // Bodies being skinned right now
  private skinning = new Set<number>();
}
