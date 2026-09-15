import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { addItemTo } from "./actorUtil";
import { MasterySystem } from "./masterySystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Hunter rank bonuses on animal kills, and an optional gate on who may take pelts and meat off game.
//
// Butcher (Expert) rolls once per kind of meat the animal dropped, Trophy Hunter (Master) once per kind of pelt;
// a win hands the hunter one more of that item directly, so a corpse looted by someone else changes nothing.
// Kills reach this system through the mastery relay (gamemode 62_mastery.js -> globalThis.__alduinakMasteryEvent),
// which fires before the engine adds the death items; the queue is drained a tick later, when they are there.
//
// server-settings.json keys (all optional):
//   huntingButcherChance         chance of one extra meat per kind, default 0.25
//   huntingTrophyChance          chance of one extra pelt per kind, default 0.15
//   huntingHarvestNeedsHunter    true refuses pelts and meat from animal corpses to characters who are not hunters, default false
//   huntingMeats, huntingPelts   editor id lists replacing DEFAULT_MEATS / DEFAULT_PELTS

const NOTICE_PACKET = "masteryNotice";
const DEFAULT_BUTCHER_CHANCE = 0.25;
const DEFAULT_TROPHY_CHANCE = 0.15;
const BUTCHER_RANK = 2;
const TROPHY_RANK = 3;
const MAX_QUEUED_KILLS = 1024;
const DENY_NOTICE_MS = 1000;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
const ANIMAL_KEYWORD = "ActorTypeAnimal";

// Raw meat and pelts the vanilla and DLC animals drop; VendorItemFoodRaw misses most of the meat, so they are listed.
const DEFAULT_MEATS = ["FoodVenison", "FoodRabbit", "FoodBeef", "FoodGoatMeat", "FoodHorseMeat", "FoodHorkerMeat", "FoodMammothMeat", "FoodChicken", "FoodDogMeat", "BYOHFoodMudcrabLegs", "DLC2FoodBoarMeat", "DLC2FoodAshHopperLeg", "DLC2FoodAshHopperMeat"];
const DEFAULT_PELTS = ["BearPelt", "BearCavePelt", "BearSnowPelt", "SabreCatPelt", "SabreCatSnowPelt", "DLC1SabreCatHide", "WolfPelt", "WolfIcePelt", "FoxPelt", "FoxPeltSnow", "DeerHide", "DeerHide02", "DLC1DeerHide", "GoatHide", "CowHide", "HorseHide", "DLC2NetchLeather", "DLC2ChitinPlate"];

interface Kill {
  killerId: number;
  victimId: number;
}

export class HuntingSystem implements System {
  systemName = "HuntingSystem";

  constructor(private log: Log, private mastery: MasterySystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    this.butcherChance = this.chance(all?.["huntingButcherChance"], DEFAULT_BUTCHER_CHANCE);
    this.trophyChance = this.chance(all?.["huntingTrophyChance"], DEFAULT_TROPHY_CHANCE);
    this.harvestNeedsHunter = !!all?.["huntingHarvestNeedsHunter"];
    const meats = this.list(all?.["huntingMeats"], DEFAULT_MEATS);
    const pelts = this.list(all?.["huntingPelts"], DEFAULT_PELTS);
    await this.resolveItems(ctx, meats, pelts, s.dataDir, s.loadOrder);
    this.installHooks(ctx);
    this.log(`[hunting] ready, butcher ${Math.round(this.butcherChance * 100)}% on ${this.meats.size} meat(s), trophy ${Math.round(this.trophyChance * 100)}% on ${this.pelts.size} pelt(s), harvest ${this.harvestNeedsHunter ? "needs a hunter" : "open to everyone"}`);
  }

  private chance(raw: unknown, fallback: number): number {
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  }

  private list(raw: unknown, fallback: string[]): string[] {
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x) : fallback;
  }

  private async resolveItems(ctx: SystemContext, meats: string[], pelts: string[], dataDir: string, loadOrder: string[]): Promise<void> {
    const names = meats.concat(pelts, [ANIMAL_KEYWORD]);
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, ["ALCH", "MISC", "KYWD"]);
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
    for (const name of pelts) {
      const id = idOf(name);
      if (id) this.pelts.add(id); else unresolved.push(name);
    }
    this.animalKeyword = idOf(ANIMAL_KEYWORD);
    if (!this.animalKeyword) unresolved.push(ANIMAL_KEYWORD);
    if (unresolved.length) this.log(`[hunting] not in the load order, ignored: ${unresolved.join(", ")}`);
  }

  // Kills ride the mastery relay; takes chain mp.onTakeItem like SearchSystem does.
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

    const mp = ctx.svr as Mp;
    const previousTake = typeof mp.onTakeItem === "function" ? mp.onTakeItem : null;
    mp.onTakeItem = (sourceId: number, actorId: number, baseId: number, count: number): boolean => {
      if (this.refusesHarvest(ctx, sourceId >>> 0, actorId >>> 0, baseId >>> 0)) return false;
      return previousTake ? previousTake.call(mp, sourceId, actorId, baseId, count) !== false : true;
    };
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
    if (!kill.killerId || !kill.victimId || !this.isPlayer(ctx, kill.killerId)) return;
    const rank = this.mastery.rankOf(ctx, kill.killerId, "hunter");
    if (rank < BUTCHER_RANK || !this.isAnimal(ctx, kill.victimId)) return;
    const dropped = this.inventoryKinds(ctx, kill.victimId);
    const userId = this.userOf(ctx, kill.killerId);
    for (const baseId of dropped) {
      const meat = this.meats.has(baseId);
      const pelt = this.pelts.has(baseId);
      if (!meat && !pelt) continue;
      if (pelt && rank < TROPHY_RANK) continue;
      if (Math.random() >= (meat ? this.butcherChance : this.trophyChance)) continue;
      addItemTo(ctx.svr as Mp, kill.killerId, baseId, 1);
      this.notice(ctx, userId, meat ? "Your butcher's eye finds an extra cut of meat." : "A fine pelt, taken whole: a trophy for the hunter.");
    }
  }

  // Pelts and meat stay on an animal's corpse unless a hunter takes them, when the setting asks for it.
  private refusesHarvest(ctx: SystemContext, sourceId: number, actorId: number, baseId: number): boolean {
    if (!this.harvestNeedsHunter || (!this.meats.has(baseId) && !this.pelts.has(baseId))) return false;
    if (this.isPlayer(ctx, sourceId) || !this.isDead(ctx, sourceId) || !this.isAnimal(ctx, sourceId)) return false;
    if (this.mastery.rankOf(ctx, actorId, "hunter") >= 0) return false;
    const userId = this.userOf(ctx, actorId);
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) > DENY_NOTICE_MS) {
      this.lastDenyMs.set(userId, now);
      this.notice(ctx, userId, "Only a hunter knows how to take pelts and meat from game.");
    }
    return true;
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

  private isAnimal(ctx: SystemContext, actorId: number): boolean {
    return !!this.animalKeyword && this.mastery.actorHasKeyword(ctx, actorId, this.animalKeyword);
  }

  private isPlayer(ctx: SystemContext, actorId: number): boolean {
    try { return Number((ctx.svr as Mp).get(actorId, "profileId")) >= 0; } catch { return false; }
  }

  private isDead(ctx: SystemContext, actorId: number): boolean {
    try { return !!(ctx.svr as Mp).get(actorId, "isDead"); } catch { return false; }
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
  private trophyChance = DEFAULT_TROPHY_CHANCE;
  private harvestNeedsHunter = false;
  private meats = new Set<number>();
  private pelts = new Set<number>();
  private animalKeyword = 0;
  private kills: Kill[] = [];
  private lastDenyMs = new Map<number, number>();
}
