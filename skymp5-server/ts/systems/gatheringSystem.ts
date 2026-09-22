import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, WORLD_LOADED_EVENT } from "./system";
import { espmContainerEntries, espmFieldFormIds, espmLinkedRefId, readVmadScripts } from "./formIdUtil";
import { addItemTo, holdsItem, sendActionLock } from "./actorUtil";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { MasterySystem, RANK_NAMES } from "./masterySystem";
import { NeedsSystem } from "./needsSystem";
import { writeFileAtomic } from "./fileUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Tool check, yield and depletion of chopping blocks and ore veins; their vanilla scripts wait on animation events the server never receives.
//
// server-settings.json keys (all optional):
//   gatheringStrikeSeconds       seconds of work per pickaxe strike, default 5
//   gatheringChopSeconds         seconds one swing of the axe takes before the firewood lands, default 8
//   gatheringChopYield           firewood one swing hands over, default 2
//   gatheringVeinTotal           ore collections every vein holds, default 6; 0 uses each record's resourcecounttotal
//   gatheringVeinRespawnMinutes  minutes after the first ore taken until the whole vein is back, default 1440, 0 keeps it
//   gatheringVeinRegenMinutes    set: minutes per ore collection grown back, one at a time, instead of the whole vein at once
//   miningVeinTiers              { "<ore editor id or hex id>": "Novice" | rank index | "Anyone" } overriding DEFAULT_VEIN_TIERS
//   gatheringProduceContainers   { "<container editor id or hex id>": minutes to grow back } replacing DEFAULT_PRODUCE, {} turns it off
//   gatheringProduceYield        { "<container>": { "<item editor id or hex id>": count } } handed over instead of the record's own contents
//   gatheringPickMinutes         how long a picked nirnroot or critter stays empty, default 30
//   gatheringHarvestSeconds      how long harvesting a plant or nirnroot holds the picker kneeling, default 5
//
// A swing of the axe and every ore off a vein draw on the same fatigue bar crafting spends (needsChopFatigue,
// needsMineFatigue); woodworkers and miners pay the smaller price for their own trade, and a bar that cannot pay
// for one more turns the station away.
// A vein comes back whole a day after its first ore was taken; gatheringVeinRegenMinutes makes that gradual instead.
// Every ore but iron needs the miner profession at its rank; iron is open to anyone with a pickaxe.
// Produce containers (beehives) never open: E hands over what the container record holds, then it grows back.
// Nirnroot and the critters that carry an ingredient are picked the same way; their vanilla scripts also wait on events the server never sees,
// so the server disables the picked ref for everyone and enables it again once it has grown back (gathering-picks.json keeps that over a restart).
// Harvesting a plant (flora or tree with an ingredient) or a nirnroot costs needsPickFatigue and kneels the picker for
// gatheringHarvestSeconds, during which they cannot move or harvest again; the native harvest still hands over the plant's ingredient.
// Catching a bee costs nothing and plays nothing.

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
const DEFAULT_CHOP_SECONDS = 8;
const DEFAULT_CHOP_YIELD = 2;
const DEFAULT_VEIN_RESPAWN_MINUTES = 1440;
// Overrides the record's total on every vein; 0 keeps the record's own
const DEFAULT_VEIN_TOTAL = 6;
const DEFAULT_PICK_MINUTES = 30;
const DEFAULT_HARVEST_SECONDS = 5;
const HARVEST_ANIM = "IdleKneelingEnter";
// The native flora reloot when server-settings names none
const DEFAULT_PLANT_REGROW_MS = 3600000;
// Engine furniture reach is 256; a wall marker stands a little off its vein.
const SEAT_REACH = 400;
// Nobody works one sitting this long; a stuck session is dropped.
const MAX_SESSION_MS = 15 * 60000;
const DENY_NOTICE_MS = 1000;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;

// Papyrus defaults of the vanilla scripts, used when a record leaves a property unset.
const VEIN_DEFAULT_COUNT = 1;
const VEIN_DEFAULT_TOTAL = 3;
const VEIN_DEFAULT_STRIKES = 1;

// Mining rank needed per ore, by the ore item editor id; unlisted ores are open to everyone.
const OPEN_TO_ALL = -1;
const DEFAULT_VEIN_TIERS: Record<string, number> = {
  OreIron: OPEN_TO_ALL, OreCorundum: 0,
  OreGold: 1, OreSilver: 1,
  OreOrichalcum: 2, OreMoonstone: 2, OreQuicksilver: 2,
  OreMalachite: 3, OreEbony: 3,
};

// Placed containers open empty on this server, so the honeycomb for the honey recipe comes from here.
const DEFAULT_PRODUCE: Record<string, number> = { BeeHive: 60, BeeHiveVacant: 60 };

// A hive holds one of each in the record; both kinds hand over this instead.
const DEFAULT_PRODUCE_YIELD: Record<string, Record<string, number>> = {
  BeeHive: { BeeHoneyComb: 2, BeeHiveHusk: 2 },
  BeeHiveVacant: { BeeHoneyComb: 2, BeeHiveHusk: 2 },
};

type StationKind = "chop" | "vein" | "marker" | "produce" | "pick" | "plant";

interface Station {
  kind: StationKind;
  props: Record<string, number>;
}

interface Session {
  actorId: number;
  furnitureId: number;
  kind: "chop" | "mine";
  veinId: number;
  resource: number;
  perStrike: number;
  // Chopping: most resources one sitting hands out. Mining: ore collections a full vein holds.
  cap: number;
  given: number;
  strikesPer: number;
  strikesLeft: number;
  // Chopping and mining work at different speeds.
  intervalMs: number;
  exitIdle: number;
  startedAt: number;
  nextAt: number;
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

  constructor(private log: Log, private mastery: MasterySystem, private needs: NeedsSystem) { }

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
    const harvest = Number(all?.["gatheringHarvestSeconds"]);
    if (Number.isFinite(harvest) && harvest >= 0) this.harvestMs = harvest * 1000;
    const reloot = all?.["reloot"];
    if (reloot && typeof reloot === "object") this.reloot = reloot as Record<string, unknown>;
    const regen = Number(all?.["gatheringVeinRegenMinutes"]);
    if (Number.isFinite(regen) && regen > 0) this.regenMs = regen * 60000;
    await this.loadVeinTiers(ctx, all?.["miningVeinTiers"], s.dataDir, s.loadOrder);
    await this.loadProduce(ctx, all?.["gatheringProduceContainers"], s.dataDir, s.loadOrder);
    await this.loadProduceYield(ctx, all?.["gatheringProduceYield"], s.dataDir, s.loadOrder);
    this.loadPicks();
    ctx.gm.once(WORLD_LOADED_EVENT, () => { this.worldLoaded = true; });

    this.installHooks(ctx);
    const growth = this.regenMs ? `one collection per ${this.regenMs / 60000} min` : `whole ${this.respawnMs / 60000} min after the first strike`;
    const total = this.veinTotalOverride ? `${this.veinTotalOverride} ore per vein` : "each vein's own ore count";
    this.log(`[gathering] ready, one pickaxe strike per ${this.strikeMs / 1000} s, one swing of the axe per ${this.chopMs / 1000} s for ${this.chopYield} firewood, ${total}, veins grow back ${growth}, ${this.veinTiers.size} ore(s) need a miner rank, ${this.produceMs.size} produce container(s), picks back after ${this.pickMs / 60000} min, a harvest kneels for ${this.harvestMs / 1000} s`);
  }

  // Ore item ids that need a mining rank, from the defaults plus the settings override.
  private async loadVeinTiers(ctx: SystemContext, raw: unknown, dataDir: string, loadOrder: string[]): Promise<void> {
    const merged: Record<string, number> = { ...DEFAULT_VEIN_TIERS };
    if (raw && typeof raw === "object") {
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        const tier = typeof value === "string" ? RANK_NAMES.indexOf(value) : Number(value);
        if (Number.isInteger(tier) && tier >= OPEN_TO_ALL && tier < RANK_NAMES.length) merged[name] = tier;
        else this.log(`[gathering] miningVeinTiers.${name}: unknown rank ${JSON.stringify(value)}, ignored`);
      }
    }
    const names = Object.keys(merged);
    const ids = await this.resolveIds(ctx, names, ["MISC"], dataDir, loadOrder);
    for (const [name, id] of ids) if (merged[name] >= 0) this.veinTiers.set(id, merged[name]);
    const unresolved = names.filter((n) => !ids.has(n));
    if (unresolved.length) this.log(`[gathering] ore(s) not in the load order, left open to everyone: ${unresolved.join(", ")}`);
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

  // ── Activation ──────────────────────────────────────────────────────────────

  private onActivate(ctx: SystemContext, targetId: number, casterId: number): Verdict {
    if (!this.isPlayer(ctx, casterId)) return undefined;
    const station = this.stationOf(ctx, targetId);
    if (!station) return undefined;
    switch (station.kind) {
      case "chop": return this.onChoppingBlock(ctx, targetId, casterId, station.props);
      case "vein": return this.onVein(ctx, targetId, casterId, station.props);
      case "marker": return this.onMiningMarker(ctx, targetId, casterId, station.props);
      case "produce": return this.onProduce(ctx, targetId, casterId, station.props);
      case "pick": return this.onPick(ctx, targetId, casterId, station.props);
      case "plant": return this.onPlant(ctx, targetId, casterId, station.props);
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
  private onPick(ctx: SystemContext, refrId: number, actorId: number, props: Record<string, number>): Verdict {
    const item = props["item"];
    if (!item) return undefined;
    if (!this.withinReach(ctx, actorId, refrId)) return false;
    if (this.veinState(ctx, refrId, 1, this.pickMs).left <= 0) return this.deny(ctx, actorId, "There is nothing to gather here yet.");
    const grant = () => {
      this.addItem(ctx, actorId, item, 1);
      this.hidePicked(ctx, refrId, Date.now() + this.pickMs);
    };
    if (props["harvest"]) return this.harvest(ctx, refrId, actorId, this.pickMs, grant);
    return () => {
      grant();
      this.writeVein(ctx, refrId, { left: 0, regenAt: Date.now() + this.pickMs });
      return false;
    };
  }

  // The native harvest hands over the ingredient; an already harvested plant is left to it for free
  private onPlant(ctx: SystemContext, refrId: number, actorId: number, props: Record<string, number>): Verdict {
    if (this.veinState(ctx, refrId, 1, props["regrow"]).left <= 0) return undefined;
    return this.harvest(ctx, refrId, actorId, props["regrow"]);
  }

  // Without grant the activation goes on to the native harvest
  private harvest(ctx: SystemContext, refrId: number, actorId: number, readyMs: number, grant?: () => void): Verdict {
    if (!this.withinReach(ctx, actorId, refrId)) return false;
    if ((this.harvestUntil.get(actorId) || 0) > Date.now()) return false;
    if (!this.needs.canPick(ctx, actorId)) return this.deny(ctx, actorId, "You are too tired to gather. Rest a while.");
    return () => {
      grant?.();
      this.needs.applyPickFatigue(ctx, actorId);
      this.writeVein(ctx, refrId, { left: 0, regenAt: Date.now() + readyMs });
      if (this.harvestMs > 0) {
        this.harvestUntil.set(actorId, Date.now() + this.harvestMs);
        sendActionLock(ctx.svr as Mp, actorId, HARVEST_ANIM, this.harvestMs / 1000);
      }
      return grant ? false : undefined;
    };
  }

  private onChoppingBlock(ctx: SystemContext, blockId: number, actorId: number, props: Record<string, number>): Verdict {
    if (!this.holdsTool(ctx, actorId, props["requireditemlist"])) {
      return this.deny(ctx, actorId, "You need a woodcutter's axe to chop wood.");
    }
    if (!this.needs.canChop(ctx, actorId, this.mastery.rankOf(ctx, actorId, "woodworker") >= 0)) {
      return this.deny(ctx, actorId, "You are too tired to swing an axe. Rest a while.");
    }
    if (!this.seatFree(ctx, blockId, actorId)) return this.deny(ctx, actorId, "Someone is already using this.");
    const resource = props["resource"] || 0;
    if (!resource || this.sessions.get(actorId)?.furnitureId === blockId) return undefined;
    return () => this.startSession({
      actorId, furnitureId: blockId, kind: "chop", veinId: 0, resource,
      perStrike: this.chopYield, cap: this.chopYield, given: 0, strikesPer: 1, strikesLeft: 1,
      intervalMs: this.chopMs,
      exitIdle: props["idlewoodchopexit"] || 0, startedAt: 0, nextAt: 0,
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
      exitIdle: markerProps["pickaxeexit"] || 0, startedAt: 0, nextAt: 0,
    });
  }

  private veinRefusal(ctx: SystemContext, veinId: number, actorId: number, props: Record<string, number>): false | undefined {
    if (!this.holdsTool(ctx, actorId, props["mineoretoolslist"])) {
      return this.deny(ctx, actorId, "You need a pickaxe to mine this vein.");
    }
    if (!this.needs.canMine(ctx, actorId, this.mastery.rankOf(ctx, actorId, "miner") >= 0)) {
      return this.deny(ctx, actorId, "You are too tired to swing a pickaxe. Rest a while.");
    }
    const tier = this.veinTiers.get((props["ore"] || 0) >>> 0) ?? OPEN_TO_ALL;
    if (tier >= 0 && this.mastery.rankOf(ctx, actorId, "miner") < tier) {
      return this.deny(ctx, actorId, `Only a miner of ${RANK_NAMES[tier]} rank or better can work this vein.`);
    }
    if (this.veinState(ctx, veinId, this.veinTotal(props)).left <= 0) {
      return this.deny(ctx, actorId, "This vein is depleted.");
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

  // ── Work ────────────────────────────────────────────────────────────────────

  private chopStrike(ctx: SystemContext, s: Session): void {
    const count = Math.min(s.perStrike, s.cap - s.given);
    if (count > 0) {
      this.addItem(ctx, s.actorId, s.resource, count);
      s.given += count;
      this.needs.applyChopFatigue(ctx, s.actorId, this.mastery.rankOf(ctx, s.actorId, "woodworker") >= 0);
    }
    if (s.given >= s.cap) this.finish(ctx, s, "");
  }

  private mineStrike(ctx: SystemContext, s: Session, now: number): void {
    const state = this.veinState(ctx, s.veinId, s.cap);
    if (state.left <= 0) return this.finish(ctx, s, "This vein is depleted.");
    s.strikesLeft -= 1;
    if (s.strikesLeft > 0) return;
    s.strikesLeft = s.strikesPer;
    const miner = this.mastery.rankOf(ctx, s.actorId, "miner") >= 0;
    // A sitting ends where an activation would be refused, rather than mining the bar into the ground
    if (!this.needs.canMine(ctx, s.actorId, miner)) return this.finish(ctx, s, "You are too tired to keep mining. Rest a while.");
    this.addItem(ctx, s.actorId, s.resource, s.perStrike);
    this.needs.applyMineFatigue(ctx, s.actorId, miner);
    state.left -= 1;
    if (!state.regenAt) state.regenAt = now + this.regenPer();
    this.writeVein(ctx, s.veinId, state);
    if (state.left <= 0) this.finish(ctx, s, "The vein is depleted.");
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

  // ── Picks ───────────────────────────────────────────────────────────────────

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

  // ── Veins ───────────────────────────────────────────────────────────────────

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

  // ── Records ─────────────────────────────────────────────────────────────────

  private stationOf(ctx: SystemContext, refrId: number): Station | null {
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(refrId, "baseDesc"))) >>> 0; } catch { return null; }
    if (!baseId) return null;
    const hit = this.stationCache.get(baseId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, baseId);
    const type = res ? String(res.record.type || "") : "";
    const scripts = res ? readVmadScripts(res) : new Map<string, Record<string, number>>();
    let station: Station | null = null;
    if (type === "FURN" && scripts.has("resourcefurniturescript")) station = { kind: "chop", props: scripts.get("resourcefurniturescript")! };
    else if (type === "ACTI" && scripts.has("mineorescript")) station = { kind: "vein", props: scripts.get("mineorescript")! };
    else if (type === "FURN" && scripts.has("mineorefurniturescript")) station = { kind: "marker", props: scripts.get("mineorefurniturescript")! };
    else if (type === "CONT" && this.produceMs.has(baseId)) station = { kind: "produce", props: { base: baseId } };
    else if (type === "ACTI" && scripts.has("nirnrootactivatorscript")) station = { kind: "pick", props: { item: scripts.get("nirnrootactivatorscript")!["nirnroot"] || 0, harvest: 1 } };
    else if (type === "ACTI" && scripts.has("firefly")) station = { kind: "pick", props: { item: scripts.get("firefly")!["lootable"] || 0 } };
    else if ((type === "FLOR" || type === "TREE") && espmFieldFormIds(res, "PFIG").some((id) => id > 0)) station = { kind: "plant", props: { regrow: this.relootMs(type) } };
    this.stationCache.set(baseId, station);
    return station;
  }

  private relootMs(type: string): number {
    const ms = Number(this.reloot[type]);
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PLANT_REGROW_MS;
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

  // ── Helpers ─────────────────────────────────────────────────────────────────

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
  private pickMs = DEFAULT_PICK_MINUTES * 60000;
  private harvestMs = DEFAULT_HARVEST_SECONDS * 1000;
  // Actor id -> epoch ms its harvest kneel ends
  private harvestUntil = new Map<number, number>();
  private reloot: Record<string, unknown> = {};
  // Picked nirnroot and critter refs -> epoch ms they grow back
  private picked = new Map<number, number>();
  private worldLoaded = false;
  private produceYield = new Map<number, Array<{ baseId: number; count: number }>>();
}
