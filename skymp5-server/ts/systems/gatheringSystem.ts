import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, WORLD_LOADED_EVENT } from "./system";
import { espmContainerEntries, espmFieldFormIds, espmLeveledEntries, espmLinkedRefId, readVmadScripts } from "./formIdUtil";
import { addItemTo, countItem, hex, holdsItem, sendActionLock, takeItemFrom } from "./actorUtil";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { FREE, LEGENDARY, MasterySystem, RANK_NAMES } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";
import { FurnitureSeatSystem } from "./furnitureSeatSystem";
import { writeFileAtomic } from "./fileUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Tool check, yield and depletion of chopping blocks and ore veins; their vanilla scripts wait on animation events the server never receives.
//
// server-settings.json keys (all optional):
//   gatheringStrikeSeconds       seconds of work per pickaxe strike, default 5
//   gatheringChopSeconds         seconds one swing of the axe takes before the firewood lands, default 10
//   gatheringChopYield           firewood one swing hands over, default 2
//   gatheringVeinTotal           ore collections every vein holds, default 6; 0 uses each record's resourcecounttotal
//   gatheringVeinRespawnMinutes  minutes after the first ore taken until the whole vein is back, default 1440, 0 keeps it
//   gatheringVeinRegenMinutes    set: minutes per ore collection grown back, one at a time, instead of the whole vein at once
//   miningVeinTiers              { "<ore editor id or hex id>": "Novice" | rank index } overriding DEFAULT_VEIN_TIERS; "Free" or 0 is open to anyone
//   gatheringProduceContainers   { "<container editor id or hex id>": minutes to grow back } replacing DEFAULT_PRODUCE, {} turns it off
//   gatheringProduceYield        { "<container>": { "<item editor id or hex id>": count } } handed over instead of the record's own contents
//   gatheringPickMinutes         how long a picked nirnroot or critter stays empty, default 30
//   gatheringAlchemistFloraDiscount  share of an alchemy flora harvest's fatigue an alchemist saves on top of the rank price, default 0 (off)
//
// A swing of the axe, every ore off a vein and every harvest cost one gathering action of the fatigue bar by the rank in
// woodworker, miner, or farmer and alchemist (NeedsSystem), and a bar that cannot pay for one more turns the station away. A chopper keeps swinging, a yield every swing, until the bar cannot pay for the next.
// A swing's firewood lands only after a whole cycle seated at the block (the client's seat claim, FurnitureSeatSystem);
// standing up mid-cycle ends the sitting with nothing for that cycle, and sitting down again starts a new cycle.
// A vein comes back whole a day after its first ore was taken; gatheringVeinRegenMinutes makes that gradual instead.
// Mining needs a pickaxe (PICKAXES), and every ore but iron and sea salt the miner profession at its rank; a vein above the
// miner's rank, or depleted, reads "You can't identify any useful ore." Every ore has a GEM_CHANCE of a gem besides.
// Produce containers (beehives and apiaries) never open: E hands over what the container record holds, then it grows back.
// Nirnroot and the critters that carry an ingredient are picked the same way; their vanilla scripts also wait on events the server never sees,
// so the server disables the picked ref for everyone and enables it again once it has grown back (gathering-picks.json keeps that over a restart).
// Harvesting a plant (flora or tree with an ingredient) or a nirnroot costs fatigue (flora half) and holds the picker for CROP_MS or FLORA_MS,
// during which they cannot move or harvest again: a crop is hoed (IdleHoe, left through IdleStop so the hoe prop goes away), flora kneels;
// a farmer's or alchemist's yield follows YIELD_BY_RANK. Crops (CROP_WORDS in the editor id) need a hoe in the inventory.
// A plant is handed over by the native harvest, and the fatigue, the kneel and any extra yield follow only once the ref reads harvested,
// so a plant the native side refuses or already holds harvested costs nothing. Hearthfire planters (BYOHHouseFlora*, BYOHHouseIngrd*,
// the mead barrel) hand over a non-playable token whose BYOHHiddenObjectScript would swap it for the produce; the server makes that swap.
// Flora costs the rank price of a farmer or an alchemist, a crop the farmer's alone (an alchemist pays a crop's Free price);
// gatheringAlchemistFloraDiscount, off by default, takes more off alchemy flora (flora whose harvest is an ingredient) for an alchemist.
// Fish (leaping salmon, slaughterfish eggs, racked salmon and oarfish) and hanging clutter (garlic, elves ear, frost mirriam,
// rabbits and pheasants, any flora whose editor id starts with Hanging) cost the fatigue but never kneel.
// Catching a bee costs nothing and plays nothing.
// A fake harvestable (defaultFakeHarvestableScript: the Sleeping Tree's sap spigot) hands over its potion or ingredient on E,
// once per FAKE_HARVEST_MS per reference, costs nothing and plays nothing; the vanilla script never runs on this server.

const VEIN_PROP = "private.gathering";
// Picked refs still hidden, { "<ref id hex>": epoch ms it grows back }
const PICKS_FILE = "./gathering-picks.json";
// A ref that cannot be enabled yet (its cell not loaded) is tried again this much later
const REGROW_RETRY_MS = 60000;
const SEAT_CLOSE_EVENT = "onPapyrusEvent:SkympOnActivateClose";
// Shown by the client's masteryService; gathering is profession work.
const NOTICE_PACKET = "masteryNotice";

const DEFAULT_STRIKE_SECONDS = 5;
// One activation is one swing: the wood lands when the animation ends, never during it.
const DEFAULT_CHOP_SECONDS = 10;
const DEFAULT_CHOP_YIELD = 2;
const DEFAULT_VEIN_RESPAWN_MINUTES = 1440;
// Overrides the record's total on every vein; 0 keeps the record's own
const DEFAULT_VEIN_TOTAL = 6;
const DEFAULT_PICK_MINUTES = 30;
const DEFAULT_ALCHEMIST_FLORA_DISCOUNT = 0;
// A fake harvestable gives its item again this long after it was taken
const FAKE_HARVEST_MS = 20 * 3600000;
// Kneel of a harvest by farmer rank, Free to Legendary
// A crop needs a hoe and 5 s; flora takes 2 s and costs half
const CROP_MS = 5000;
const FLORA_MS = 2000;
// What one node, swing or strike hands over by the worker's rank: double at Adept, triple at Master
const YIELD_BY_RANK = [1, 1, 2, 2, 3, 3];
const CROP_WORDS = ["wheat", "gourd", "cabbage", "potato"];
// Skyrim.esm Hoe
// Skyrim.esm DLC2PickaxeList, every pickaxe
const PICKAXES = 0x0010acc4;
// Skyrim.esm LItemGems
const GEM_LIST = 0x0010e992;
const GEM_CHANCE = 0.02;
const NO_ORE = "You can't identify any useful ore.";
const HARVEST_ANIM = "IdleKneelingEnter";
// Crops: the looping farming idle with its hoe prop; a prop idle must exit through IdleStop, IdleForceDefaultState leaves the hoe in hand
const CROP_ANIM = "IdleHoe";
const CROP_EXIT_ANIM = "IdleStop";
// Hearthfire's harvest token: myBase, ItemCount and itemToAddPotion or itemToAddIngredient
const HIDDEN_OBJECT_SCRIPT = "byohhiddenobjectscript";
// Engine furniture reach is 256; a wall marker stands a little off its vein.
const SEAT_REACH = 400;
// Nobody works one sitting this long; a stuck session is dropped.
const MAX_SESSION_MS = 15 * 60000;
const DENY_NOTICE_MS = 1000;
// Picking plants is the work of these professions
const PICKERS = ["farmer", "alchemist"];
// Flora is priced by either picker's rank, a crop by the farmer's alone
const CROP_PRICERS = ["farmer"];
const CHOP_TIRED = "You are too tired to swing an axe. Rest a while.";
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;

// Papyrus defaults of the vanilla scripts, used when a record leaves a property unset.
const VEIN_DEFAULT_COUNT = 1;
const VEIN_DEFAULT_TOTAL = 3;
const VEIN_DEFAULT_STRIKES = 1;

// Mining rank needed per ore, by the ore item editor id; unlisted ores are open to everyone. Ores missing from the load order are skipped.
const DEFAULT_VEIN_TIERS: Record<string, number> = {
  OreIron: 0, "12SeaSaltOre": 0, OreCorundum: 1,
  OreGold: 2, OreSilver: 2,
  OreOrichalcum: 3, OreMoonstone: 3,
  OreMalachite: 4, OreQuicksilver: 4, OreEbony: 4, DLC2OreStalhrim: 4,
  ccBGSSSE025_OreAmber: 5, ccBGSSSE025_OreMadness: 5,
};

// Placed containers open empty on this server, so the honeycomb for the honey recipe comes from here.
const DEFAULT_PRODUCE: Record<string, number> = { BeeHive: 60, BeeHiveVacant: 60, BYOHBYOHApiary: 60 };

// The records hold their own mix; every kind, the Hearthfire apiary included, hands over this instead.
const HIVE_YIELD: Record<string, number> = { BeeHoneyComb: 2, CritterBeeIngredient: 2, BeeHiveHusk: 2 };
const DEFAULT_PRODUCE_YIELD: Record<string, Record<string, number>> = {
  BeeHive: HIVE_YIELD, BeeHiveVacant: HIVE_YIELD, BYOHBYOHApiary: HIVE_YIELD,
};
// Flora harvested without the kneel: fish (it breaks a swimmer's animation) and hanging clutter, plus any editor id starting with Hanging
const INSTANT_FLORA = ["FXAmbWaterSalmon01A", "FXAmbWaterSalmon01B", "FXAmbWaterSalmon02A", "FXAmbWaterSalmon02B", "SlaughterfishEggNest01", "DeadSalmon01", "DeadSalmon02", "WHOarFish", "WHOarFishHanging", "WHOarFishHangingBig", "HangingElvesEar01", "HangingFrostMirriam", "HangingGarlicBraid", "HangingRabbit01", "HangingRabbit02", "HangingPheasant01", "HangingPheasant02"];
const INSTANT_PREFIX = "hanging";
// Rabbits, pheasants and salmon hanging on racks are free to take: no fatigue
const FREE_RACK_RE = /^(hangingrabbit|hangingpheasant|deadsalmon|whoarfishhanging)/;

type StationKind = "chop" | "vein" | "marker" | "produce" | "pick" | "plant" | "fake";

interface Station {
  kind: StationKind;
  props: Record<string, number>;
  // Editor id of the base record, for the log
  name: string;
}

interface Session {
  actorId: number;
  furnitureId: number;
  kind: "chop" | "mine";
  veinId: number;
  resource: number;
  perStrike: number;
  // Mining: ore collections a full vein holds. Chopping has none: the fatigue bar ends the sitting.
  cap: number;
  given: number;
  strikesPer: number;
  strikesLeft: number;
  // Chopping and mining work at different speeds.
  intervalMs: number;
  exitIdle: number;
  startedAt: number;
  nextAt: number;
  // Chopping: when the seat claim of this sitting arrived, 0 before any
  seatedAt: number;
  // Chopping: a swing already landed with no seat claim, logged once
  unseatedLogged?: boolean;
}

interface VeinState {
  left: number;
  // Epoch ms when the next collection grows back; 0 while the vein is full.
  regenAt: number;
}

// Undefined: not a gathering station. False: refused. A function: run once the activation went through; returning false keeps the target shut.
type Verdict = undefined | false | (() => void) | (() => false);

export class GatheringSystem implements System {
  systemName = "GatheringSystem";

  constructor(private log: Log, private mastery: MasterySystem, private needs: NeedsSystem, private seats: FurnitureSeatSystem) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    const strike = Number(all?.["gatheringStrikeSeconds"]);
    if (Number.isFinite(strike) && strike > 0) this.strikeMs = strike * 1000;
    const chop = Number(all?.["gatheringChopSeconds"]);
    if (Number.isFinite(chop) && chop > 0) this.chopMs = chop * 1000;
    const chopYield = Number(all?.["gatheringChopYield"]);
    if (Number.isFinite(chopYield) && chopYield > 0) this.chopYield = Math.floor(chopYield);
    const respawn = Number(all?.["gatheringVeinRespawnMinutes"]);
    if (Number.isFinite(respawn) && respawn > 0) this.respawnMs = respawn * 60000;
    const veinTotal = Number(all?.["gatheringVeinTotal"]);
    if (Number.isFinite(veinTotal) && veinTotal >= 0) this.veinTotalOverride = Math.floor(veinTotal);
    const pick = Number(all?.["gatheringPickMinutes"]);
    if (Number.isFinite(pick) && pick >= 0) this.pickMs = pick * 60000;
    const discount = Number(all?.["gatheringAlchemistFloraDiscount"]);
    if (all?.["gatheringAlchemistFloraDiscount"] !== undefined && Number.isFinite(discount)) this.alchemistFloraDiscount = Math.min(1, Math.max(0, discount));
    const regen = Number(all?.["gatheringVeinRegenMinutes"]);
    if (Number.isFinite(regen) && regen > 0) this.regenMs = regen * 60000;
    await this.loadVeinTiers(ctx, all?.["miningVeinTiers"], s.dataDir, s.loadOrder);
    await this.loadProduce(ctx, all?.["gatheringProduceContainers"], s.dataDir, s.loadOrder);
    await this.loadProduceYield(ctx, all?.["gatheringProduceYield"], s.dataDir, s.loadOrder);
    const instant = await this.resolveIds(ctx, INSTANT_FLORA, ["FLOR", "TREE"], s.dataDir, s.loadOrder);
    this.instantFlora = new Set(instant.values());
    const unresolved = INSTANT_FLORA.filter((n) => !instant.has(n));
    if (unresolved.length) this.log(`[gathering] instant flora not in the load order: ${unresolved.join(", ")}`);
    this.loadPicks();
    ctx.gm.once(WORLD_LOADED_EVENT, () => { this.worldLoaded = true; });

    this.installHooks(ctx);
    const growth = this.regenMs ? `one collection per ${this.regenMs / 60000} min` : `whole ${this.respawnMs / 60000} min after the first strike`;
    const total = this.veinTotalOverride ? `${this.veinTotalOverride} ore per vein` : "each vein's own ore count";
    this.log(`[gathering] ready, one pickaxe strike per ${this.strikeMs / 1000} s, one swing of the axe per ${this.chopMs / 1000} s for ${this.chopYield} firewood, ${total}, veins grow back ${growth}, ${this.veinTiers.size} ore(s) need a miner rank, ${this.produceMs.size} produce container(s), picks back after ${this.pickMs / 60000} min, a harvest hoes ${CROP_MS / 1000} s for a crop (${CROP_WORDS.join("/")}) and kneels ${FLORA_MS / 1000} s for flora (nirnroot included) except at ${this.instantFlora.size} instant flora, yields x${YIELD_BY_RANK.join("/")} by rank, flora priced by the ${PICKERS.join(" or ")} rank and crops by the ${CROP_PRICERS.join(" or ")} rank, ${this.alchemistFloraDiscount > 0 ? `an alchemist pays ${Math.round(this.alchemistFloraDiscount * 100)}% less again for alchemy flora` : "no extra alchemist flora discount"}`);
  }

  // Ore item ids that need a mining rank, from the defaults plus the settings override.
  private async loadVeinTiers(ctx: SystemContext, raw: unknown, dataDir: string, loadOrder: string[]): Promise<void> {
    const merged: Record<string, number> = { ...DEFAULT_VEIN_TIERS };
    if (raw && typeof raw === "object") {
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        const tier = typeof value === "string" ? RANK_NAMES.indexOf(value) : Number(value);
        if (Number.isInteger(tier) && tier >= FREE && tier <= LEGENDARY) merged[name] = tier;
        else this.log(`[gathering] miningVeinTiers.${name}: unknown rank ${JSON.stringify(value)}, ignored`);
      }
    }
    const names = Object.keys(merged);
    const ids = await this.resolveIds(ctx, names, ["MISC"], dataDir, loadOrder);
    for (const [name, id] of ids) if (merged[name] > FREE) this.veinTiers.set(id, merged[name]);
    this.log(`[gathering] vein ores: ${Array.from(ids, ([name, id]) => `${name} ${id.toString(16)} ${RANK_NAMES[merged[name]]}`).join(", ")}`);
  }

  // Container base ids that hand out their contents and grow them back, from the defaults or the settings replacement.
  private async loadProduce(ctx: SystemContext, raw: unknown, dataDir: string, loadOrder: string[]): Promise<void> {
    const minutes: Record<string, number> = raw && typeof raw === "object" ? {} : { ...DEFAULT_PRODUCE };
    for (const [name, value] of Object.entries(raw && typeof raw === "object" ? raw as Record<string, unknown> : {})) {
      if (Number.isFinite(Number(value)) && Number(value) > 0) minutes[name] = Number(value);
      else this.log(`[gathering] gatheringProduceContainers.${name}: ${JSON.stringify(value)} is not a number of minutes, ignored`);
    }
    const names = Object.keys(minutes);
    const ids = await this.resolveIds(ctx, names, ["CONT"], dataDir, loadOrder);
    for (const [name, id] of ids) this.produceMs.set(id, minutes[name] * 60000);
    const unresolved = names.filter((n) => !ids.has(n));
    if (unresolved.length) this.log(`[gathering] produce container(s) not in the load order: ${unresolved.join(", ")}`);
  }

  // What each produce container hands over, replacing its record contents; a container whose items do not resolve keeps them.
  private async loadProduceYield(ctx: SystemContext, raw: unknown, dataDir: string, loadOrder: string[]): Promise<void> {
    const yields: Record<string, Record<string, number>> = raw && typeof raw === "object" ? {} : { ...DEFAULT_PRODUCE_YIELD };
    for (const [container, value] of Object.entries(raw && typeof raw === "object" ? raw as Record<string, unknown> : {})) {
      if (value && typeof value === "object") yields[container] = value as Record<string, number>;
      else this.log(`[gathering] gatheringProduceYield.${container}: ${JSON.stringify(value)} is not an item list, ignored`);
    }
    const containers = await this.resolveIds(ctx, Object.keys(yields), ["CONT"], dataDir, loadOrder);
    for (const [container, containerId] of containers) {
      const wanted = yields[container];
      const items = await this.resolveIds(ctx, Object.keys(wanted), ["INGR", "MISC", "ALCH"], dataDir, loadOrder);
      const entries: Array<{ baseId: number; count: number }> = [];
      for (const [item, baseId] of items) {
        const count = Math.floor(Number(wanted[item]));
        if (count > 0) entries.push({ baseId, count });
      }
      const missing = Object.keys(wanted).filter((item) => !items.has(item));
      if (missing.length) this.log(`[gathering] ${container} yield item(s) not in the load order, its record contents stand: ${missing.join(", ")}`);
      else if (entries.length) this.produceYield.set(containerId, entries);
    }
  }

  // Editor ids, hex ids and "hex:Plugin.esp" descs to global form ids; unresolved names are left out.
  private async resolveIds(ctx: SystemContext, names: string[], types: string[], dataDir: string, loadOrder: string[]): Promise<Map<string, number>> {
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, types);
    const mp = ctx.svr as Mp;
    const ids = new Map<string, number>();
    for (const name of names) {
      let id = 0;
      try {
        if (name.includes(":")) id = mp.getIdFromDesc(name) >>> 0;
        else if (!isEditorId(name)) id = parseInt(name, 16) >>> 0;
        else {
          const desc = scan.resolved.get(name.toLowerCase());
          if (desc) id = mp.getIdFromDesc(desc) >>> 0;
        }
      } catch { id = 0; }
      if (id) ids.set(name, id);
    }
    return ids;
  }

  // Chained like HousingSystem: a refusal never reaches the furniture, and a
  // session only starts once every other handler let the activation through.
  private installHooks(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let verdict: Verdict;
      try {
        verdict = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[gathering] activation check failed: ${e}`);
      }
      if (verdict === false) return false;
      let allowed = true;
      if (previous) {
        try { allowed = previous.call(mp, targetId, casterId) !== false; } catch { allowed = true; }
      }
      if (allowed && verdict && verdict() === false) return false;
      return allowed;
    };

    const previousClose = typeof mp[SEAT_CLOSE_EVENT] === "function" ? mp[SEAT_CLOSE_EVENT] : null;
    mp[SEAT_CLOSE_EVENT] = (...args: unknown[]) => {
      this.endSessionsAt(Number(args[0]) >>> 0);
      return previousClose ? previousClose.apply(mp, args) : undefined;
    };
  }

  disconnect(userId: number, ctx: SystemContext): void {
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    this.sessions.delete(actorId);
    this.harvestUntil.delete(actorId);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    // Papyrus calls run here, outside the native activation call stack.
    for (const p of this.pendingSeats.splice(0, this.pendingSeats.length)) this.activateFor(ctx, p.markerId, p.actorId);
    this.regrowPicks(ctx);
    if (!this.sessions.size) return;
    const now = Date.now();
    for (const s of Array.from(this.sessions.values())) {
      if (s.kind === "chop" && !this.stillSeated(ctx, s)) continue;
      if (now < s.nextAt) continue;
      if (!this.stillWorking(ctx, s, now)) {
        this.sessions.delete(s.actorId);
        continue;
      }
      s.nextAt = now + s.intervalMs;
      try {
        if (s.kind === "chop") this.chopStrike(ctx, s);
        else this.mineStrike(ctx, s, now);
      } catch (e) {
        this.log(`[gathering] strike failed for ${s.actorId.toString(16)}: ${e}`);
        this.sessions.delete(s.actorId);
      }
    }
  }

  // â”€â”€ Activation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private onActivate(ctx: SystemContext, targetId: number, casterId: number): Verdict {
    if (!this.isPlayer(ctx, casterId)) return undefined;
    const station = this.stationOf(ctx, targetId);
    if (!station) return undefined;
    switch (station.kind) {
      case "chop": return this.onChoppingBlock(ctx, targetId, casterId, station.props);
      case "vein": return this.onVein(ctx, targetId, casterId, station.props);
      case "marker": return this.onMiningMarker(ctx, targetId, casterId, station.props);
      case "produce": return this.onProduce(ctx, targetId, casterId, station.props);
      case "pick": return this.onPick(ctx, targetId, casterId, station.props, station.name);
      case "plant": return this.onPlant(ctx, targetId, casterId, station.props, station.name);
      case "fake": return this.onFakeHarvest(ctx, targetId, casterId, station.props, station.name);
      default: return undefined;
    }
  }

  private onProduce(ctx: SystemContext, containerId: number, actorId: number, props: Record<string, number>): Verdict {
    const regrow = this.produceMs.get(props["base"]) || 0;
    // The engine never asks where an activator stands, so a forged packet from afar gathers nothing
    if (!this.withinReach(ctx, actorId, containerId)) return false;
    if (this.veinState(ctx, containerId, 1, regrow).left <= 0) return this.deny(ctx, actorId, "There is nothing to gather here yet.");
    const items = this.produceYield.get(props["base"])
      || espmContainerEntries(this.lookup(ctx, props["base"])).filter((e) => e.count > 0 && String(this.lookup(ctx, e.baseId)?.record.type || "") !== "LVLI");
    if (!items.length) return undefined;
    return () => {
      for (const e of items) this.addItem(ctx, actorId, e.baseId, e.count);
      this.writeVein(ctx, containerId, { left: 0, regenAt: Date.now() + regrow });
      return false;
    };
  }

  // Nirnroot and bees: one ingredient on E, then nothing there for an hour
  private onPick(ctx: SystemContext, refrId: number, actorId: number, props: Record<string, number>, name: string): Verdict {
    const item = props["item"];
    if (!item) return undefined;
    if (!this.withinReach(ctx, actorId, refrId)) return false;
    if (this.veinState(ctx, refrId, 1, this.pickMs).left <= 0) return this.deny(ctx, actorId, "There is nothing to gather here yet.");
    const grant = (count: number) => {
      this.addItem(ctx, actorId, item, count);
      this.hidePicked(ctx, refrId, Date.now() + this.pickMs);
      this.writeVein(ctx, refrId, { left: 0, regenAt: Date.now() + this.pickMs });
    };
    if (props["harvest"]) return this.harvest(ctx, refrId, actorId, props, name, grant);
    return () => {
      grant(1);
      return false;
    };
  }

  // The script's potion or ingredient, one per FAKE_HARVEST_MS; the ref stays shown, the vein state on its changeform keeps the wait over a restart
  private onFakeHarvest(ctx: SystemContext, refrId: number, actorId: number, props: Record<string, number>, name: string): Verdict {
    const item = props["potionharvested"] || props["ingredientharvested"];
    if (!item) return undefined;
    if (!this.withinReach(ctx, actorId, refrId)) return false;
    if (this.veinState(ctx, refrId, 1, FAKE_HARVEST_MS).left <= 0) return this.deny(ctx, actorId, "There is nothing to gather here yet.");
    return () => {
      this.addItem(ctx, actorId, item, 1);
      this.writeVein(ctx, refrId, { left: 0, regenAt: Date.now() + FAKE_HARVEST_MS });
      this.log(`[gathering] ${actorId.toString(16)} harvested ${name} ${refrId.toString(16)} for ${item.toString(16)}`);
      return false;
    };
  }

  // A plant the native side holds harvested gives nothing, so it is left to it and costs nothing
  private onPlant(ctx: SystemContext, refrId: number, actorId: number, props: Record<string, number>, name: string): Verdict {
    if (this.isHarvested(ctx, refrId)) return undefined;
    return this.harvest(ctx, refrId, actorId, props, name);
  }

  // With grant the server hands the item over; without it the native harvest does, and the rest waits until the ref reads harvested
  private harvest(ctx: SystemContext, refrId: number, actorId: number, props: Record<string, number>, name: string, grant?: (count: number) => void): Verdict {
    if (!this.withinReach(ctx, actorId, refrId)) return false;
    if ((this.harvestUntil.get(actorId) || 0) > Date.now()) return false;
    const mp = ctx.svr as Mp;
    const hoe = this.mastery.hoeFormId();
    if (props["crop"] && hoe && !holdsItem(mp, actorId, (baseId) => baseId === hoe)) return this.deny(ctx, actorId, "You need a hoe to harvest this crop.");
    const rank = this.mastery.rankIn(ctx, actorId, PICKERS);
    const flora = !props["crop"];
    const priceRank = flora ? rank : this.mastery.rankIn(ctx, actorId, CROP_PRICERS);
    const alchemist = flora && !!props["ingredient"] && this.alchemistFloraDiscount > 0 && this.mastery.rankOf(ctx, actorId, "alchemist") > FREE;
    const multiplier = alchemist ? 1 - this.alchemistFloraDiscount : 1;
    if (!props["free"] && !this.needs.canPay(actorId, "gather", priceRank, flora, multiplier)) return this.deny(ctx, actorId, "You are too tired to gather. Rest a while.");
    const kneelMs = props["instant"] ? 0 : flora ? FLORA_MS : CROP_MS;
    const settle = () => {
      const extra = alchemist ? `, alchemist -${Math.round(this.alchemistFloraDiscount * 100)}%` : priceRank !== rank ? `, alchemist r${rank} pays the Free crop price` : "";
      if (!props["free"]) this.needs.pay(ctx, actorId, "gather", priceRank, `harvest ${name} ${flora ? "flora" : "crop"} r${priceRank}${extra}`, flora, multiplier);
      if (kneelMs > 0) sendActionLock(mp, actorId, flora ? HARVEST_ANIM : CROP_ANIM, kneelMs / 1000, flora ? undefined : CROP_EXIT_ANIM);
    };
    return () => {
      if (kneelMs > 0) this.harvestUntil.set(actorId, Date.now() + kneelMs);
      if (grant) {
        grant(YIELD_BY_RANK[rank]);
        settle();
        return false;
      }
      // Runs once the native harvest has returned
      setImmediate(() => {
        if (!this.isHarvested(ctx, refrId)) {
          this.harvestUntil.delete(actorId);
          this.log(`[gathering] ${hex(actorId)} harvest of ${name} ${hex(refrId)} handed over nothing, no fatigue taken`);
          return;
        }
        this.handOverProduce(ctx, actorId, props, name, YIELD_BY_RANK[rank]);
        settle();
      });
      return undefined;
    };
  }

  // Swaps a Hearthfire token the native harvest handed over for its produce, and adds what Adept and up get on top
  private handOverProduce(ctx: SystemContext, actorId: number, props: Record<string, number>, name: string, count: number): void {
    const item = props["item"];
    if (!item) return;
    const mp = ctx.svr as Mp;
    const produce = props["produce"];
    if (!produce) {
      if (count > 1) this.addItem(ctx, actorId, this.rollItem(ctx, item), count - 1);
      return;
    }
    // Tokens from harvests before the swap existed come back too
    const tokens = countItem(mp, actorId, item);
    const swapped = tokens > 0 && takeItemFrom(mp, actorId, item, tokens) ? tokens : 0;
    const total = (swapped + count - 1) * props["perToken"];
    if (total > 0) this.addItem(ctx, actorId, produce, total);
    this.log(`[gathering] ${hex(actorId)} harvested ${name}: ${swapped} token(s) ${hex(item)} swapped, ${total}x ${hex(produce)} handed over`);
  }

  // Papyrus IsHarvested, the native flora state; false when it cannot be read
  private isHarvested(ctx: SystemContext, refrId: number): boolean {
    const mp = ctx.svr as Mp;
    try {
      return mp.callPapyrusFunction("method", "ObjectReference", "IsHarvested", { type: "form", desc: mp.getDescFromId(refrId) }, []) === true;
    } catch (e) {
      this.log(`[gathering] harvest state of ${hex(refrId)} unreadable: ${e}`);
      return false;
    }
  }

  private onChoppingBlock(ctx: SystemContext, blockId: number, actorId: number, props: Record<string, number>): Verdict {
    if (!this.holdsTool(ctx, actorId, props["requireditemlist"])) {
      return this.deny(ctx, actorId, "You need a woodcutter's axe to chop wood.");
    }
    if (!this.needs.canPay(actorId, "gather", this.mastery.rankOf(ctx, actorId, "woodworker"))) {
      return this.deny(ctx, actorId, CHOP_TIRED);
    }
    if (!this.seatFree(ctx, blockId, actorId)) return this.deny(ctx, actorId, "Someone is already using this.");
    const resource = props["resource"] || 0;
    if (!resource || this.sessions.get(actorId)?.furnitureId === blockId) return undefined;
    return () => this.startSession({
      actorId, furnitureId: blockId, kind: "chop", veinId: 0, resource,
      perStrike: this.chopYield, cap: 0, given: 0, strikesPer: 1, strikesLeft: 1,
      intervalMs: this.chopMs,
      exitIdle: props["idlewoodchopexit"] || 0, startedAt: 0, nextAt: 0, seatedAt: 0,
    });
  }

  // The vein itself only checks the tool and hands the player to its linked marker, as MineOreScript does.
  private onVein(ctx: SystemContext, veinId: number, actorId: number, props: Record<string, number>): Verdict {
    const refused = this.veinRefusal(ctx, veinId, actorId, props);
    if (refused !== undefined) return refused;
    const markerId = espmLinkedRefId(this.lookup(ctx, veinId));
    if (!markerId) return undefined;
    this.markerVein.set(markerId, veinId);
    return () => this.pendingSeats.push({ markerId, actorId });
  }

  private onMiningMarker(ctx: SystemContext, markerId: number, actorId: number, markerProps: Record<string, number>): Verdict {
    const veinId = this.veinOfMarker(ctx, markerId);
    // Scripted mines (Cidhna Mine) have no vein behind the marker; leave them be.
    if (!veinId) return undefined;
    const vein = this.stationOf(ctx, veinId);
    if (!vein || vein.kind !== "vein") return undefined;
    const refused = this.veinRefusal(ctx, veinId, actorId, vein.props);
    if (refused !== undefined) return refused;
    if (!this.seatFree(ctx, markerId, actorId)) return this.deny(ctx, actorId, "Someone is already mining here.");
    const ore = vein.props["ore"] || 0;
    if (!ore || this.sessions.get(actorId)?.furnitureId === markerId) return undefined;
    const strikes = Math.max(1, vein.props["strikesbeforecollection"] || VEIN_DEFAULT_STRIKES);
    return () => this.startSession({
      actorId, furnitureId: markerId, kind: "mine", veinId, resource: ore,
      perStrike: Math.max(1, vein.props["resourcecount"] || VEIN_DEFAULT_COUNT),
      cap: this.veinTotal(vein.props), given: 0, strikesPer: strikes, strikesLeft: strikes,
      intervalMs: this.strikeMs,
      exitIdle: markerProps["pickaxeexit"] || 0, startedAt: 0, nextAt: 0, seatedAt: 0,
    });
  }

  private veinRefusal(ctx: SystemContext, veinId: number, actorId: number, props: Record<string, number>): false | undefined {
    if (!this.holdsTool(ctx, actorId, PICKAXES)) {
      return this.deny(ctx, actorId, "You need a pickaxe to mine this vein.");
    }
    if (!this.needs.canPay(actorId, "gather", this.mastery.rankOf(ctx, actorId, "miner"))) {
      return this.deny(ctx, actorId, "You are too tired to swing a pickaxe. Rest a while.");
    }
    const tier = this.veinTiers.get((props["ore"] || 0) >>> 0) ?? FREE;
    if (this.mastery.rankOf(ctx, actorId, "miner") < tier || this.veinState(ctx, veinId, this.veinTotal(props)).left <= 0) {
      return this.deny(ctx, actorId, NO_ORE);
    }
    return undefined;
  }

  // One worker per station, like the engine's own furniture occupancy.
  private seatFree(ctx: SystemContext, furnitureId: number, actorId: number): boolean {
    for (const s of this.sessions.values()) {
      if (s.furnitureId === furnitureId && s.actorId !== actorId && this.stillWorking(ctx, s, Date.now())) return false;
    }
    return true;
  }

  private startSession(s: Session): void {
    const now = Date.now();
    s.startedAt = now;
    s.nextAt = now + s.intervalMs;
    this.sessions.set(s.actorId, s);
  }

  private endSessionsAt(furnitureId: number): void {
    for (const s of Array.from(this.sessions.values())) {
      if (s.furnitureId === furnitureId) this.sessions.delete(s.actorId);
    }
  }

  // â”€â”€ Work â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // False while a chopping cycle cannot land: the chopper left the block (the session ends) or a new sitting restarted the cycle
  private stillSeated(ctx: SystemContext, s: Session): boolean {
    const seat = this.seats.seatOf(this.userOf(ctx, s.actorId));
    const at = seat && seat.furniture === s.furnitureId ? seat.at : 0;
    if (!at) {
      // Never claimed: a client without the seat claim keeps the plain timing
      if (!s.seatedAt) return true;
      this.sessions.delete(s.actorId);
      return false;
    }
    if (at !== s.seatedAt) {
      s.seatedAt = at;
      s.nextAt = at + s.intervalMs;
      return false;
    }
    return true;
  }

  // The chopper stays at the block across yields and stands up once the bar cannot pay for another swing
  private chopStrike(ctx: SystemContext, s: Session): void {
    if (!s.seatedAt && !s.unseatedLogged) {
      s.unseatedLogged = true;
      this.log(`[gathering] ${s.actorId.toString(16)} chops at ${s.furnitureId.toString(16)} with no seat claim, a swing is not checked against standing up`);
    }
    const rank = this.mastery.rankOf(ctx, s.actorId, "woodworker");
    if (!this.needs.canPay(s.actorId, "gather", rank)) return this.finish(ctx, s, CHOP_TIRED);
    const count = s.perStrike * YIELD_BY_RANK[rank];
    this.addItem(ctx, s.actorId, s.resource, count);
    s.given += count;
    this.needs.pay(ctx, s.actorId, "gather", rank, "chop");
    if (!this.needs.canPay(s.actorId, "gather", rank)) this.finish(ctx, s, CHOP_TIRED);
  }

  private mineStrike(ctx: SystemContext, s: Session, now: number): void {
    const state = this.veinState(ctx, s.veinId, s.cap);
    if (state.left <= 0) return this.finish(ctx, s, NO_ORE);
    s.strikesLeft -= 1;
    if (s.strikesLeft > 0) return;
    s.strikesLeft = s.strikesPer;
    const rank = this.mastery.rankOf(ctx, s.actorId, "miner");
    // A sitting ends where an activation would be refused, rather than mining the bar into the ground
    if (!this.needs.canPay(s.actorId, "gather", rank)) return this.finish(ctx, s, "You are too tired to keep mining. Rest a while.");
    this.addItem(ctx, s.actorId, s.resource, s.perStrike * YIELD_BY_RANK[rank]);
    this.needs.pay(ctx, s.actorId, "gather", rank, "ore");
    if (Math.random() < GEM_CHANCE) {
      const gem = this.rollItem(ctx, GEM_LIST);
      if (gem !== GEM_LIST) this.addItem(ctx, s.actorId, gem, 1);
    }
    state.left -= 1;
    if (!state.regenAt) state.regenAt = now + this.regenPer();
    this.writeVein(ctx, s.veinId, state);
    if (state.left <= 0) this.finish(ctx, s, NO_ORE);
  }

  // Stand the worker up the way the vanilla scripts do, with the station's exit idle.
  private finish(ctx: SystemContext, s: Session, text: string): void {
    this.sessions.delete(s.actorId);
    if (text) this.notice(ctx, this.userOf(ctx, s.actorId), text);
    const anim = this.idleEvent(ctx, s.exitIdle);
    if (!anim) return;
    const mp = ctx.svr as Mp;
    try {
      const actor = { type: "form", desc: mp.getDescFromId(s.actorId) };
      mp.callPapyrusFunction("global", "Debug", "SendAnimationEvent", null, [actor, anim]);
    } catch (e) {
      this.log(`[gathering] exit idle failed for ${s.actorId.toString(16)}: ${e}`);
    }
  }

  // Actor.PlayIdle needs a Papyrus stack that calls from JS lack, so the idle's animation event (ENAM) is sent instead.
  private idleEvent(ctx: SystemContext, idleId: number): string {
    const fields = this.lookup(ctx, idleId)?.record.fields || [];
    const f = fields.find((x: any) => x && x.type === "ENAM" && x.data instanceof Uint8Array);
    return f ? String.fromCharCode(...f.data).split("\0")[0] : "";
  }

  private stillWorking(ctx: SystemContext, s: Session, now: number): boolean {
    if (now - s.startedAt > MAX_SESSION_MS) return false;
    if (this.userOf(ctx, s.actorId) < 0) return false;
    try {
      if ((ctx.svr as Mp).get(s.actorId, "isDead")) return false;
    } catch {
      return false;
    }
    return this.withinReach(ctx, s.actorId, s.furnitureId);
  }

  private withinReach(ctx: SystemContext, actorId: number, refId: number): boolean {
    const mp = ctx.svr as Mp;
    try {
      const loc = mp.get(actorId, "locationalData");
      if (!loc || String(loc.cellOrWorldDesc) !== String(mp.get(refId, "worldOrCellDesc"))) return false;
      const pos = mp.get(refId, "pos");
      const d = Math.hypot(loc.pos[0] - pos[0], loc.pos[1] - pos[1], loc.pos[2] - pos[2]);
      return Number.isFinite(d) && d <= SEAT_REACH;
    } catch {
      return false;
    }
  }

  // â”€â”€ Picks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private hidePicked(ctx: SystemContext, refrId: number, regrowAt: number): void {
    this.setShown(ctx, refrId, false);
    this.picked.set(refrId, regrowAt);
    this.savePicks();
  }

  private regrowPicks(ctx: SystemContext): void {
    if (!this.worldLoaded || !this.picked.size) return;
    const now = Date.now();
    let changed = false;
    for (const [refrId, at] of this.picked) {
      if (at > now) continue;
      if (this.setShown(ctx, refrId, true)) this.picked.delete(refrId);
      else this.picked.set(refrId, now + REGROW_RETRY_MS);
      changed = true;
    }
    if (changed) this.savePicks();
  }

  // Papyrus Enable/Disable, unlike the isDisabled property, also tells every client that has the ref
  private setShown(ctx: SystemContext, refrId: number, shown: boolean): boolean {
    const mp = ctx.svr as Mp;
    try {
      mp.callPapyrusFunction("method", "ObjectReference", shown ? "Enable" : "Disable", { type: "form", desc: mp.getDescFromId(refrId) }, [false]);
      return true;
    } catch (e) {
      this.log(`[gathering] could not ${shown ? "show" : "hide"} ${refrId.toString(16)}: ${e}`);
      return false;
    }
  }

  private loadPicks(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(PICKS_FILE, "utf8"));
    } catch {
      return;
    }
    for (const [key, at] of Object.entries(raw && typeof raw === "object" ? raw as Record<string, unknown> : {})) {
      const refrId = parseInt(key, 16) >>> 0;
      if (refrId && Number.isFinite(Number(at))) this.picked.set(refrId, Number(at));
    }
  }

  private savePicks(): void {
    const out: Record<string, number> = {};
    for (const [refrId, at] of this.picked) out[refrId.toString(16)] = at;
    try {
      writeFileAtomic(PICKS_FILE, JSON.stringify(out));
    } catch (e) {
      this.log(`[gathering] could not save ${PICKS_FILE}: ${e}`);
    }
  }

  // â”€â”€ Veins â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private veinTotal(props: Record<string, number>): number {
    return this.veinTotalOverride || Math.max(1, props["resourcecounttotal"] || VEIN_DEFAULT_TOTAL);
  }

  // Time for one collection to grow back, or for the whole vein when growth is not gradual.
  private regenPer(): number {
    return this.regenMs || this.respawnMs;
  }

  // Remaining collections ride the vein changeform, so a restart keeps a mined-out vein empty; growth is settled on read.
  private veinState(ctx: SystemContext, veinId: number, total: number, per = this.regenPer()): VeinState {
    let raw: any = null;
    try { raw = (ctx.svr as Mp).get(veinId, VEIN_PROP); } catch { /* never mined */ }
    let left = raw && Number.isFinite(Number(raw.left)) ? Math.min(Number(raw.left), total) : total;
    // Records from before growth carry resetAt, the moment the whole vein came back.
    let regenAt = raw ? Number(raw.regenAt) || Number(raw.resetAt) || 0 : 0;
    const now = Date.now();
    // Nothing growing back means the total rose since the record was written
    if (left < total && !regenAt) left = total;
    if (this.regenMs) {
      while (left < total && now >= regenAt) {
        left += 1;
        regenAt += per;
      }
    } else if (left < total && now >= regenAt) {
      left = total;
    }
    if (left >= total) return { left: total, regenAt: 0 };
    return { left, regenAt };
  }

  private writeVein(ctx: SystemContext, veinId: number, state: VeinState): void {
    try {
      (ctx.svr as Mp).set(veinId, VEIN_PROP, state);
    } catch (e) {
      this.log(`[gathering] vein write failed for ${veinId.toString(16)}: ${e}`);
    }
  }

  // Veins link to their marker, never the other way, so a marker finds its vein among its neighbours.
  private veinOfMarker(ctx: SystemContext, markerId: number): number {
    const hit = this.markerVein.get(markerId);
    if (hit !== undefined) return hit;
    const mp = ctx.svr as Mp;
    let near: unknown = null;
    try { near = mp.getNeighborsByPosition(String(mp.get(markerId, "worldOrCellDesc")), mp.get(markerId, "pos")); } catch { /* unloaded */ }
    if (!Array.isArray(near)) return 0;
    let found = 0;
    for (const id of near) {
      const refrId = Number(id) >>> 0;
      if (this.stationOf(ctx, refrId)?.kind === "vein" && espmLinkedRefId(this.lookup(ctx, refrId)) === markerId) {
        found = refrId;
        break;
      }
    }
    // A miss is not cached: the vein may sit in a grid cell that is not loaded yet.
    if (found) this.markerVein.set(markerId, found);
    return found;
  }

  // â”€â”€ Records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private stationOf(ctx: SystemContext, refrId: number): Station | null {
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(refrId, "baseDesc"))) >>> 0; } catch { return null; }
    if (!baseId) return null;
    const hit = this.stationCache.get(baseId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, baseId);
    const type = res ? String(res.record.type || "") : "";
    const name = String(res?.record.editorId || "") || baseId.toString(16);
    const scripts = res ? readVmadScripts(res) : new Map<string, Record<string, number>>();
    let station: Omit<Station, "name"> | null = null;
    if (type === "FURN" && scripts.has("resourcefurniturescript")) station = { kind: "chop", props: scripts.get("resourcefurniturescript")! };
    else if (type === "ACTI" && scripts.has("mineorescript")) station = { kind: "vein", props: scripts.get("mineorescript")! };
    else if (type === "FURN" && scripts.has("mineorefurniturescript")) station = { kind: "marker", props: scripts.get("mineorefurniturescript")! };
    else if (type === "CONT" && this.produceMs.has(baseId)) station = { kind: "produce", props: { base: baseId } };
    else if (type === "ACTI" && scripts.has("nirnrootactivatorscript")) station = { kind: "pick", props: this.nirnrootProps(ctx, scripts.get("nirnrootactivatorscript")!["nirnroot"] || 0) };
    else if (type === "ACTI" && scripts.has("firefly")) station = { kind: "pick", props: { item: scripts.get("firefly")!["lootable"] || 0 } };
    else if ((type === "ACTI" || type === "FLOR") && scripts.has("defaultfakeharvestablescript")) station = { kind: "fake", props: scripts.get("defaultfakeharvestablescript")! };
    else if ((type === "FLOR" || type === "TREE") && espmFieldFormIds(res, "PFIG").some((id) => id > 0)) station = { kind: "plant", props: this.plantProps(ctx, res, baseId, name) };
    const out = station ? { ...station, name } : null;
    this.stationCache.set(baseId, out);
    return out;
  }

  // ingredient: the plant (or its Hearthfire token) hands over an ingredient, which makes non-crop flora alchemy flora
  private plantProps(ctx: SystemContext, res: any, baseId: number, name: string): Record<string, number> {
    const item = espmFieldFormIds(res, "PFIG")[0] || 0;
    const hidden = this.hiddenProduce(ctx, item, name);
    return {
      instant: this.isInstantFlora(res, baseId) ? 1 : 0,
      free: FREE_RACK_RE.test(String(res.record.editorId || "").toLowerCase()) ? 1 : 0,
      crop: this.isCrop(res) ? 1 : 0,
      item, ingredient: this.isIngredient(ctx, hidden.produce || item) ? 1 : 0, ...hidden,
    };
  }

  // Wild and crimson nirnroot are flora picked by hand
  private nirnrootProps(ctx: SystemContext, item: number): Record<string, number> {
    return { item, harvest: 1, ingredient: this.isIngredient(ctx, item) ? 1 : 0 };
  }

  private isIngredient(ctx: SystemContext, formId: number): boolean {
    return String(this.lookup(ctx, formId)?.record.type || "") === "INGR";
  }

  private isCrop(res: any): boolean {
    const edid = String(res.record.editorId || "").toLowerCase();
    return CROP_WORDS.some((w) => edid.includes(w));
  }

  // An item, or one random pick down a leveled list; the list id itself when it resolves to nothing
  private rollItem(ctx: SystemContext, formId: number, depth = 0): number {
    const res = this.lookup(ctx, formId);
    if (String(res?.record.type || "") !== "LVLI" || depth > 4) return formId;
    const entries = espmLeveledEntries(res);
    return entries.length ? this.rollItem(ctx, entries[Math.floor(Math.random() * entries.length)].baseId, depth + 1) : formId;
  }

  private isInstantFlora(res: any, baseId: number): boolean {
    return this.instantFlora.has(baseId) || String(res.record.editorId || "").toLowerCase().startsWith(INSTANT_PREFIX);
  }

  // The produce and count per token of a Hearthfire harvest token, nothing for any other item
  private hiddenProduce(ctx: SystemContext, itemId: number, plant: string): { produce?: number; perToken?: number } {
    const script = readVmadScripts(this.lookup(ctx, itemId)).get(HIDDEN_OBJECT_SCRIPT);
    if (!script) return {};
    const produce = script["itemtoaddpotion"] || script["itemtoaddingredient"] || 0;
    const type = String(this.lookup(ctx, produce)?.record.type || "");
    if (type !== "ALCH" && type !== "INGR") {
      this.log(`[gathering] ${plant} hands over token ${hex(itemId)} with no produce in the load order, left to the native harvest`);
      return {};
    }
    const perToken = Math.max(1, Math.floor(script["itemcount"] || 1));
    this.log(`[gathering] ${plant} hands over token ${hex(itemId)}, swapped for ${perToken}x ${hex(produce)} per token`);
    return { produce, perToken };
  }

  // A station without a tool list asks for nothing.
  private holdsTool(ctx: SystemContext, actorId: number, listId: number | undefined): boolean {
    if (!listId) return true;
    let tools = this.toolCache.get(listId);
    if (!tools) {
      tools = new Set(espmFieldFormIds(this.lookup(ctx, listId), "LNAM"));
      this.toolCache.set(listId, tools);
    }
    if (!tools.size) return true;
    return holdsItem(ctx.svr as Mp, actorId, (baseId) => tools!.has(baseId));
  }

  private lookup(ctx: SystemContext, formId: number): any {
    if (!formId) return null;
    try {
      const res = (ctx.svr as Mp).lookupEspmRecordById(formId >>> 0);
      return res && res.record ? res : null;
    } catch {
      return null;
    }
  }

  // â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private addItem(ctx: SystemContext, actorId: number, itemId: number, count: number): void {
    addItemTo(ctx.svr as Mp, actorId, itemId, count);
  }

  // Seats the player through the engine's own furniture path, which also records the occupant.
  private activateFor(ctx: SystemContext, markerId: number, actorId: number): void {
    const mp = ctx.svr as Mp;
    try {
      const self = { type: "form", desc: mp.getDescFromId(markerId) };
      mp.callPapyrusFunction("method", "ObjectReference", "Activate", self, [{ type: "form", desc: mp.getDescFromId(actorId) }, false]);
    } catch (e) {
      this.log(`[gathering] could not seat ${actorId.toString(16)} at marker ${markerId.toString(16)}: ${e}`);
    }
  }

  private deny(ctx: SystemContext, actorId: number, text: string): false {
    // A held activate key fires repeatedly.
    const userId = this.userOf(ctx, actorId);
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) > DENY_NOTICE_MS) {
      this.lastDenyMs.set(userId, now);
      this.notice(ctx, userId, text);
    }
    return false;
  }

  private isPlayer(ctx: SystemContext, actorId: number): boolean {
    try { return Number((ctx.svr as Mp).get(actorId, "profileId")) >= 0; } catch { return false; }
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
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

  private strikeMs = DEFAULT_STRIKE_SECONDS * 1000;
  private chopMs = DEFAULT_CHOP_SECONDS * 1000;
  private chopYield = DEFAULT_CHOP_YIELD;
  private respawnMs = DEFAULT_VEIN_RESPAWN_MINUTES * 60000;
  private regenMs = 0;
  private veinTotalOverride = DEFAULT_VEIN_TOTAL;
  private veinTiers = new Map<number, number>();
  private sessions = new Map<number, Session>();
  private pendingSeats: Array<{ markerId: number; actorId: number }> = [];
  private lastDenyMs = new Map<number, number>();
  private markerVein = new Map<number, number>();
  private stationCache = new Map<number, Station | null>();
  private toolCache = new Map<number, Set<number>>();
  // Produce container base id -> ms until it has produce again
  private produceMs = new Map<number, number>();
  private instantFlora = new Set<number>();
  private pickMs = DEFAULT_PICK_MINUTES * 60000;
  private alchemistFloraDiscount = DEFAULT_ALCHEMIST_FLORA_DISCOUNT;
  // Actor id -> epoch ms its harvest kneel ends
  private harvestUntil = new Map<number, number>();
  // Picked nirnroot and critter refs -> epoch ms they grow back
  private picked = new Map<number, number>();
  private worldLoaded = false;
  private produceYield = new Map<number, Array<{ baseId: number; count: number }>>();
}
