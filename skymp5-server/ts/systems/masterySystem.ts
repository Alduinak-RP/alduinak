import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmContainerEntries, espmFieldFormIds } from "./formIdUtil";
import { spellInfo, SpellType } from "./espmMagic";
import { GOLD_BASE_ID, HUNTING_KNIFE_ID, addItemTo, addSpellTo, chainMpHook, hadStarterGold, hex, isCreationPending, isPlayerActor, removeSpellFrom } from "./actorUtil";
import { parseStartingItems } from "./spawn";
import { BLANK_BOOK_EDID } from "./writingSystem";
import { effectiveRaceId, npcChainOf } from "./npcTemplate";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Professions: one per character, ranked by hours of work ──────────────────
//
// docs/docs_professions_revamp_contract.md is the fixed interface. Everyone is Free (rank 0); choosing a profession
// makes the character a Novice of it, and hours of its work raise it to Adept, Expert, Master and Legendary. Every
// server-observed activity of the profession is worth one hour, at most one per hour. This system chains the native
// onCraft/onActivate/onSpellCast hooks on `mp` and the gamemode relays kills through globalThis.__alduinakMasteryEvent
// (gamemode_extensions/62_mastery.js); other systems credit their own work (skinning) through creditWork. Each rank
// grants a cumulative marker spell AldProf_<Label>_<Rank>; the plugin's recipes condition on it with HasSpell.
// A mage cannot rise above Adept without having cast an Adept spell, above Expert without an Expert one, and so on.
// Hour bank: each extra craft of the profession inside a counted hour banks one hour, up to masteryHourBank; a banked hour
// is counted once the character has been online for a full interval since the last counted hour and no work counted one.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "masteryInfoRequest" }
//     { customPacketType: "masteryChoose", profession: "<id>" }
//     { customPacketType: "masteryResetRequest" }  the player sets their profession aside, at most masteryResetsPerCharacter times
//   Server -> Client:
//     { customPacketType: "masteryMenu", profession, rank, hours, rankHours, resetsLeft, professions: [...] }
//     { customPacketType: "masteryNotice", text }
//     { customPacketType: "professionState", profession, rank, rankName, hours, skills, magicka }
//
// Persistence: `private.mastery` = { v: 2, profession, points, lastPointAt, rank, granted[], spellTier, resets, bank, onlineMs } on the actor.
//
// server-settings.json keys (all optional):
//   masteryRankHours             [adept, expert, master, legendary] thresholds, default [40, 100, 180, 6000]
//   masteryPointIntervalMinutes  minimum gap between two hours, default 60
//   masteryHourBank              hours extra crafts may bank, default 2; 0 turns the bank off
//   masterySpells                { "<professionId>": [novice, adept, expert, master, legendary] } marker form ids
//                                overriding the plugin's AldProf_<Label>_<Rank> spells
//   masteryActivities            { "<professionId>": { craftKeywords, craftStations, activatePrefixes, activateTypes,
//                                killKeywords } } overriding DEFAULT_ACTIVITIES key by key. Keywords take an editor id,
//                                a hex id or a desc ("88105:Skyrim.esm").
//   masteryKits                  { "<professionId>": [{ baseId, count }] } overriding DEFAULT_KITS key by key; [] gives nothing
//   masteryKitGold               gold every profession's kit carries, default 50; 0 turns it off. A character marked
//                                private.starterGold (its starting items carried gold) gets none.

const MASTERY_PROP = "private.mastery";
// Set with a character's first kit and never cleared, so a reset and a new pick bring no second one
const KIT_PROP = "private.professionKit";
// Plugin recipes any character makes (instruments, broom, war horns) are no one's work
const COMMON_RECIPE_PREFIX = "AldRecipeCommon_";
// Recipes whose rank bonus belongs to several professions, by editor id prefix
const SHARED_RECIPES: Array<[string, string[]]> = [
  ["AldRecipeKiln_Charcoal", ["woodworker", "blacksmith", "miner"]],
  ["AldRecipeWriting_SealingWax", ["blacksmith", "alchemist"]]
];
// Crafting at their benches costs half: cooking, alchemy, and refining at the smelter (miner) and the tanning rack (hunter)
const HALF_COST_BENCHES_OF = ["cook", "alchemist", "miner", "hunter"];
// Refining made at another bench, by the editor id of what the recipe makes
const HALF_COST_PRODUCTS = new Set(["mce_thread"]);
const RECORD_VERSION = 2;

export const RANK_NAMES = ["Free", "Novice", "Adept", "Expert", "Master", "Legendary"];
export const FREE = 0;
export const NOVICE = 1;
export const ADEPT = 2;
export const LEGENDARY = 5;
// Skill level of the character's own profession skills by rank; every other mapped skill stays at the Free level
const RANK_SKILL = [15, 25, 40, 60, 80, 100];
const MAGE_MAGICKA = [100, 125, 150, 175, 200, 500];

const DEFAULT_RANK_HOURS = [40, 100, 180, 6000];
const DEFAULT_POINT_INTERVAL_MINUTES = 60;
const DEFAULT_HOUR_BANK = 2;
const BANK_CHECK_MS = 5000;
// Online time is saved this often while hours are banked, so a crash loses at most this much of it
const BANK_SAVE_MS = 5 * 60000;
const CHOOSE_COOLDOWN_MS = 1000;
// Admin grants are for testing and corrections, never a bulk import.
export const MAX_GRANT = 1000;
// Events queue up between ticks; anything past this is a runaway loop.
const MAX_QUEUED_EVENTS = 4096;
// The C++ never asks where an activator or crafter stands, so a forged packet from afar must not count as work
const ACTIVATE_REACH = 600;
// Bow kills skip the engine's distance check; the reach a bow means is used instead
const KILL_REACH = 8192;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;
// The client wipes and re-applies learnedSpells about a second after spawn; a login backfill has to land after that.
const LOGIN_GRANT_DELAY_MS = 5000;

interface Profession {
  id: string;
  label: string;
  title: string;
  type: string;
  // Actor values the client sets from professionState
  skills: string[];
  // What each rank opens up, Free to Legendary, shown beside the ladder in the Skills tab.
  blurbs: string[];
}

const MAGIC_SKILLS = ["Alteration", "Conjuration", "Destruction", "Enchanting", "Illusion", "Restoration"];

// Order matches the menu's left-hand column.
const PROFESSIONS: Profession[] = [
  {
    id: "alchemist", label: "Alchemist", title: "The Patient Hand", type: "Crafter/Gatherer", skills: ["Alchemy"],
    blurbs: [
      "Anyone may gather herbs and brew the simplest remedies.",
      "Minor potions of healing, magicka and stamina.",
      "Weak poisons, and the weak aversions.",
      "The plain potions of every school, attribute and resistance.",
      "Draughts, philters and elixirs: the strongest work of the lab.",
      "The legendary brews few alchemists ever see.",
    ],
  },
  {
    id: "blacksmith", label: "Blacksmith", title: "The Forge-Bound", type: "Crafter", skills: ["Smithing"],
    blurbs: [
      "Anyone may make nails, fittings, locks, hinges and the war horns.",
      "Iron and corundum at the forge, the tools, and iron, corundum and steel ingots at the smelter.",
      "Steel and advanced armour, and gold and silver ingots.",
      "Dwarven, Orcish and Elven work, and orichalcum and moonstone ingots.",
      "Ebony and glass, arcane smithing, and malachite, quicksilver and ebony ingots.",
      "Daedric arms and dragon armour.",
    ],
  },
  {
    id: "cook", label: "Cook", title: "The Hearthkeeper", type: "Crafter", skills: ["OneHanded"],
    blurbs: [
      "Anyone may roast a simple meal over a fire.",
      "Steaks, roasts and grilled fish.",
      "Soups and stews.",
      "Baking: bread, sweet rolls and dumplings.",
      "Gourmet dishes, pies and crostatas.",
      "Feasts fit for a jarl's table.",
    ],
  },
  {
    id: "farmer", label: "Farmer", title: "The Green Hand", type: "Gatherer", skills: ["Pickpocket"],
    blurbs: [
      "Anyone may pick what grows, slowly.",
      "A hoe and a quicker harvest of the fields.",
      "Crops come in at a glance.",
      "Every harvest is instant.",
      "Double yield from every plant.",
      "Four times the yield from every plant.",
    ],
  },
  {
    id: "hunter", label: "Hunter", title: "The Far Tracker", type: "Gatherer/Fighter", skills: ["Marksman"],
    blurbs: [
      "Anyone may hunt game for its meat.",
      "Skinning: a hunting knife takes the pelt of a kill.",
      "A faster draw and a steadier aim afield.",
      "A longer hold on a drawn bow, and the butcher's eye.",
      "Trophy hunting: the full craft of the chase.",
      "The legend of the wilds.",
    ],
  },
  {
    id: "mage", label: "Mage", title: "The Arcane Scholar", type: "Fighter", skills: MAGIC_SKILLS,
    blurbs: [
      "Anyone may learn a few simple spells.",
      "125 magicka, and the schools of magic opened.",
      "150 magicka.",
      "175 magicka; an Adept spell must be known first.",
      "200 magicka; an Expert spell must be known first.",
      "500 magicka; a Master spell must be known first.",
    ],
  },
  {
    id: "miner", label: "Miner", title: "The Deep Delver", type: "Gatherer", skills: ["TwoHanded"],
    blurbs: [
      "Anyone with a pickaxe may mine iron and sea salt.",
      "Corundum veins, and iron, corundum and steel ingots at the smelter.",
      "Gold and silver, veins and ingots.",
      "Orichalcum and moonstone, veins and ingots.",
      "Malachite, quicksilver, ebony and stalhrim, veins and ingots.",
      "Amber and madness ore.",
    ],
  },
  {
    id: "tailor", label: "Tailor", title: "The Fine Thread", type: "Crafter", skills: ["Smithing", "LightArmor"],
    blurbs: [
      "Anyone may mend plain clothes.",
      "Hide, leather and plain cloth at the rack and the loom.",
      "Fine clothing and robes.",
      "The better leathers.",
      "Noble dress, the finest weaves.",
      "Daedric silks and the rarest hides.",
    ],
  },
  {
    id: "warrior", label: "Warrior", title: "The Steadfast Guardian", type: "Fighter", skills: ["HeavyArmor", "Block"],
    blurbs: [
      "Anyone may take up a blade.",
      "Lighter power attacks with one hand or two, and deeper wind.",
      "A faster off hand, the power bash, a shield carried at speed, and light armour that weighs nothing.",
      "The charge, and heavy armour that weighs nothing.",
      "The sweeping blow, a warmaster's reach, and a heavier pack.",
      "A legend of the battlefield, tireless and heavily laden.",
    ],
  },
  {
    id: "woodworker", label: "Woodworker", title: "The Grain Reader", type: "Crafter/Gatherer", skills: ["Smithing"],
    blurbs: [
      "Anyone may chop firewood and burn charcoal.",
      "Tools, and iron bows, arrows and shields.",
      "Steel, silver and gold bows, arrows and shields, and drums.",
      "Orichalcum and moonstone, and flutes.",
      "Malachite, quicksilver and ebony, and lutes.",
      "Work so fine it walks on water.",
    ],
  },
];

const PROFESSION_IDS = PROFESSIONS.map((p) => p.id);
const ALL_SKILLS = Array.from(new Set(PROFESSIONS.flatMap((p) => p.skills)));

// What counts as work, per profession. Every list is optional; an empty list never matches.
interface ActivityRules {
  // Recipe (COBJ) workbench keyword of a server-validated craft or temper.
  craftKeywords: string[];
  // Keyword on the station itself: every craft made there counts, whatever the recipe.
  craftStations: string[];
  // Editor id prefix of the activated reference's base object.
  activatePrefixes: string[];
  // Record type of the activated reference's base object (FLOR, TREE...).
  activateTypes: string[];
  // Keywords on the victim's base or race when this character lands the kill.
  killKeywords: string[];
}

const ACTOR_TYPES = ["ActorTypeNPC", "ActorTypeCreature", "ActorTypeUndead", "ActorTypeDaedra", "ActorTypeDwarven", "ActorTypeDragon", "ActorTypeGiant", "ActorTypeTroll"];

// Player actors have no base record; their race is always a playable one.
const PLAYER_KEYWORD = "ActorTypeNPC";

// Every drink at a meadery boiler: the shared keyword and each boiler's own mead keyword
const MEAD_STATIONS = ["AldCraftingMead", "AldCraftingMeadHonningbrew", "AldCraftingMeadBlackBriar"];

const DEFAULT_ACTIVITIES: Record<string, Partial<ActivityRules>> = {
  alchemist: { craftKeywords: ["AldCraftingAlchemy"], craftStations: MEAD_STATIONS, activateTypes: ["FLOR", "TREE"] },
  // Anything made at a forge, anvil or smelter counts, and a temper at the workbench or grindstone
  blacksmith: {
    craftKeywords: ["CraftingSmithingForge", "CraftingSmelter", "CraftingSmithingSkyforge", "DLC2CraftingSmithingSkaalForge", "DLC1CraftingDawnguard", "DLC1LD_CraftingForgeAetherium", "CraftingSmithingArmorTable", "CraftingSmithingSharpeningWheel"],
    craftStations: ["isBlacksmithForge", "isBlacksmithAnvil", "isSmelter"],
  },
  cook: { craftKeywords: ["CraftingCookpot", "BYOHCraftingOven"], craftStations: MEAD_STATIONS },
  farmer: { activateTypes: ["FLOR", "TREE"] },
  // Hunters and tailors both tan leather
  hunter: { killKeywords: ["ActorTypeAnimal"], craftKeywords: ["CraftingTanningRack"] },
  // Veins hand the swing to a linked PickaxeMining*Marker furniture; smiths and miners both smelt
  miner: { activatePrefixes: ["MineOre", "PickaxeMining"], craftKeywords: ["CraftingSmelter"] },
  tailor: { craftKeywords: ["CraftingTanningRack", "MCE_CraftingLoom", "CraftingSmithingArmorTable"] },
  warrior: { killKeywords: ACTOR_TYPES },
  woodworker: { activatePrefixes: ["WoodChoppingBlock", "DLC2WoodChoppingBlock"], craftKeywords: ["BYOHCarpenterTable", "BYOHBuildingCarpenter", "AldCraftingWoodcrafting", "AldCraftingKiln", "CraftingSmithingSharpeningWheel"] },
};

interface KitItem {
  baseId: number;
  count: number;
}

// Skyrim.esm: IngotIron, Leather01, LeatherStrips, Axe01, weapPickaxe, SaltPile, IronDagger, weapBasicKnife01; the farmer's hoe and the mage's blank book are added at boot
const DEFAULT_KITS: Record<string, KitItem[]> = {
  blacksmith: [{ baseId: 0x0005ace4, count: 5 }],
  tailor: [{ baseId: 0x000db5d2, count: 5 }, { baseId: 0x000800e4, count: 5 }],
  woodworker: [{ baseId: 0x0002f2f4, count: 1 }],
  miner: [{ baseId: 0x000e3c16, count: 1 }],
  cook: [{ baseId: 0x00034cdf, count: 10 }],
  warrior: [{ baseId: 0x0001397e, count: 1 }],
  hunter: [{ baseId: HUNTING_KNIFE_ID, count: 1 }],
  farmer: [],
  mage: [],
};
const DEFAULT_KIT_GOLD = 50;
// The farmer's hoe, a plugin record
const HOE_EDID = "AldToolHoe";

const ACTIVITY_KINDS = ["craft", "activate", "kill", "cast", "work"] as const;
type ActivityKind = typeof ACTIVITY_KINDS[number];

interface ActivityEvent {
  kind: ActivityKind;
  actorId: number;
  detail: Record<string, number>;
}

interface ResolvedRules {
  craftKeywords: Set<number>;
  craftStations: Set<number>;
  activatePrefixes: string[];
  activateTypes: Set<string>;
  killKeywords: Set<number>;
}

interface MasteryRecord {
  v: number;
  profession: string | null;
  points: number;
  // Epoch ms of the last hour; 0 when none has been earned yet.
  lastPointAt: number;
  rank: number;
  // Marker spells already handed to this character, so a login does not re-grant them into the client's spawn-time spell wipe.
  granted: number[];
  // Highest spell tier a mage has cast, 0 before any
  spellTier: number;
  // Profession resets the player has used
  resets: number;
  // Hours banked by extra crafts, waiting to be counted
  bank: number;
  // Online time since the last counted hour, up to the last save
  onlineMs: number;
}

interface OnlineClock {
  userId: number;
  // Epoch ms up to which online time is in the record's onlineMs
  since: number;
  savedAt: number;
}

// What the admin panel shows for one character.
export interface MasterySummary {
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
}

interface BaseInfo {
  id: number;
  type: string;
  editorId: string;
}

interface Location {
  cell: string;
  pos: number[];
}

const emptyRecord = (): MasteryRecord => ({ v: RECORD_VERSION, profession: null, points: 0, lastPointAt: 0, rank: FREE, granted: [], spellTier: 0, resets: 0, bank: 0, onlineMs: 0 });
const hoursText = (n: number): string => `${n} ${n === 1 ? "hour" : "hours"}`;

export const stringList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];

export class MasterySystem implements System {
  systemName = "MasterySystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const hours = all?.["masteryRankHours"];
    if (Array.isArray(hours) && hours.length === DEFAULT_RANK_HOURS.length && hours.every((h) => Number.isFinite(Number(h)))) {
      this.rankHours = hours.map((h) => Number(h));
    } else if (hours !== undefined) {
      this.log(`[mastery] masteryRankHours needs ${DEFAULT_RANK_HOURS.length} numbers (adept, expert, master, legendary), default kept`);
    }
    const resets = Number(all?.["masteryResetsPerCharacter"]);
    if (Number.isInteger(resets) && resets >= 0) this.resetsPerCharacter = resets;
    const interval = Number(all?.["masteryPointIntervalMinutes"]);
    if (Number.isFinite(interval) && interval > 0) this.intervalMs = interval * 60000;
    const bank = Number(all?.["masteryHourBank"]);
    if (Number.isInteger(bank) && bank >= 0) this.bankMax = bank;

    const spells = all?.["masterySpells"];
    if (spells && typeof spells === "object") {
      for (const id of PROFESSION_IDS) {
        const list = (spells as Record<string, unknown>)[id];
        if (Array.isArray(list) && list.length === LEGENDARY) this.spells[id] = list.map((v) => Number(v) >>> 0);
      }
    }

    this.loadKits(ctx, all?.["masteryKits"]);
    const kitGold = Number(all?.["masteryKitGold"]);
    if (Number.isInteger(kitGold) && kitGold >= 0) this.kitGold = kitGold;
    await this.loadRules(ctx, all?.["masteryActivities"], s.dataDir, s.loadOrder);
    await this.loadPluginForms(ctx, s.dataDir, s.loadOrder);

    const configured = Object.keys(this.spells).length;
    this.log(`[mastery] ready, ranks at ${this.rankHours.join("/")}h, one hour per ${this.intervalMs / 60000} min, extra crafts bank up to ${hoursText(this.bankMax)}, ${configured}/${PROFESSION_IDS.length} professions have marker spells`);

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
      this.onActorAssigned(ctx, userId, actorId >>> 0);
    });
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));

    // Events are only queued so every property write and Papyrus call runs outside the native event call stack.
    (globalThis as any).__alduinakMasteryEvent = (kind: string, actorId: number, detail: unknown) => {
      this.enqueue(kind, actorId, detail);
    };
    this.hookNativeEvents(ctx);
  }

  // Chain onto whatever already owns these `mp` hooks and never change their verdict.
  private hookNativeEvents(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const chain = (name: string, kind: ActivityKind, pick: (args: unknown[]) => [unknown, Record<string, unknown>]) => {
      const previous = typeof mp[name] === "function" ? mp[name] : null;
      mp[name] = (...args: unknown[]) => {
        const verdict = previous ? previous(...args) : undefined;
        // A handler that returns false blocked the action, so nothing was done.
        if (verdict !== false) {
          const [actorId, detail] = pick(args);
          this.enqueue(kind, actorId, detail);
        }
        return verdict;
      };
    };
    // The inputs are consumed the moment the hook returns, so ownership is read here.
    chain("onCraft", "craft", ([actorId, , , recipeId]) =>
      [actorId, { recipeId, held: this.holdsInputs(ctx, Number(actorId) >>> 0, Number(recipeId) >>> 0) ? 1 : 0 }]);
    chain("onActivate", "activate", ([refrId, casterId]) => [casterId, { refrId }]);
    chainMpHook(mp, "onSpellCast", (casterId: number, spellId: number) => this.enqueue("cast", casterId, { spellId }));
  }

  private enqueue(kind: string, actorId: unknown, detail: unknown): void {
    if (ACTIVITY_KINDS.indexOf(kind as ActivityKind) === -1) return;
    const numeric: Record<string, number> = {};
    if (detail && typeof detail === "object") {
      for (const [k, v] of Object.entries(detail as Record<string, unknown>)) numeric[k] = Number(v) >>> 0;
    }
    if (this.events.length >= MAX_QUEUED_EVENTS) this.events.shift();
    this.events.push({ kind: kind as ActivityKind, actorId: Number(actorId) >>> 0, detail: numeric });
  }

  // Work another system verified (skinning); credited like any activity of that profession
  creditWork(actorId: number, professionId: string): void {
    const index = PROFESSION_IDS.indexOf(professionId);
    if (index !== -1) this.enqueue("work", actorId, { profession: index });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "masteryInfoRequest": this.sendMenu(ctx, userId); break;
      case "masteryChoose": this.onChoose(ctx, userId, content); break;
      case "masteryResetRequest": this.onResetRequest(ctx, userId); break;
      default: break;
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    this.flushPendingGrants(ctx);
    this.payBanks(ctx);
    if (!this.events.length) return;
    const batch = this.events.splice(0, this.events.length);
    for (const ev of batch) {
      try {
        this.creditActivity(ctx, ev);
      } catch (e) {
        this.log(`[mastery] ${ev.kind} credit failed for ${ev.actorId.toString(16)}: ${e}`);
      }
    }
  }

  // ── Worked hours ────────────────────────────────────────────────────────────

  // One hour per interval; an extra craft inside a counted hour goes to the bank instead
  private creditActivity(ctx: SystemContext, ev: ActivityEvent): void {
    const rec = this.read(ctx, ev.actorId);
    if (!rec || !rec.profession) return;
    if (ev.kind === "cast" && !this.noteCast(ctx, ev.actorId, rec, ev.detail["spellId"])) return;
    const now = Date.now();
    const elapsed = now - rec.lastPointAt;
    const counted = elapsed >= 0 && elapsed < this.intervalMs;
    if (counted && (ev.kind !== "craft" || rec.bank >= this.bankMax)) return;
    const rules = this.rules[rec.profession];
    if (!rules || !this.matches(ctx, rec, rules, ev)) return;
    if (counted) this.deposit(ctx, ev.actorId, rec, now);
    else this.countHour(ctx, ev.actorId, rec, now, false);
  }

  // Points one hour; banked says it came out of the bank
  private countHour(ctx: SystemContext, actorId: number, rec: MasteryRecord, now: number, banked: boolean): void {
    rec.points += 1;
    rec.lastPointAt = now;
    this.settleClock(actorId, rec, now);
    rec.onlineMs = 0;
    this.write(ctx, actorId, rec);
    const left = rec.bank ? `, ${hoursText(rec.bank)} still banked` : "";
    this.log(`[mastery] ${hex(actorId)} ${rec.profession} hour ${banked ? `paid from the bank after ${this.intervalMs / 60000} online min` : "counted by work"}: ${rec.points}h${left}`);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, `Your ${banked ? "banked " : ""}work as a ${this.labelOf(rec.profession || "")} is counted: ${hoursText(rec.points)} at the craft${left}.`);
    this.syncRank(ctx, actorId, rec, userId);
  }

  private deposit(ctx: SystemContext, actorId: number, rec: MasteryRecord, now: number): void {
    rec.bank += 1;
    this.settleClock(actorId, rec, now);
    this.write(ctx, actorId, rec);
    const waitMin = Math.max(1, Math.ceil((this.intervalMs - rec.onlineMs) / 60000));
    this.log(`[mastery] ${hex(actorId)} ${rec.profession} hour banked (${rec.bank}/${this.bankMax}), next paid in ${waitMin} online min`);
    this.notice(ctx, this.userOf(ctx, actorId), `Extra work banked: ${hoursText(rec.bank)} will be counted, one per hour you stay online.`);
  }

  // A banked hour is counted once a full interval of online time has passed since the last counted hour
  private payBanks(ctx: SystemContext): void {
    const now = Date.now();
    if (!this.clocks.size || now - this.lastBankCheck < BANK_CHECK_MS) return;
    this.lastBankCheck = now;
    this.clocks.forEach((clock, actorId) => {
      try {
        const rec = this.read(ctx, actorId);
        if (!rec || !rec.profession || rec.bank <= 0) return;
        if (rec.bank > this.bankMax) rec.bank = this.bankMax;
        if (rec.onlineMs + now - clock.since < this.intervalMs || now - rec.lastPointAt < this.intervalMs) {
          if (now - clock.savedAt < BANK_SAVE_MS) return;
          this.settleClock(actorId, rec, now);
          this.write(ctx, actorId, rec);
          return;
        }
        rec.bank -= 1;
        this.countHour(ctx, actorId, rec, now, true);
      } catch (e) {
        this.log(`[mastery] bank payout failed for ${hex(actorId)}: ${e}`);
      }
    });
  }

  // Moves the online time since the clock's mark into the record; the caller writes it
  private settleClock(actorId: number, rec: MasteryRecord, now: number): void {
    const clock = this.clocks.get(actorId);
    if (!clock) return;
    rec.onlineMs += Math.max(0, now - clock.since);
    clock.since = now;
    clock.savedAt = now;
  }

  private goOffline(ctx: SystemContext, actorId: number): void {
    if (!this.clocks.has(actorId)) return;
    const rec = this.read(ctx, actorId);
    if (rec) {
      this.settleClock(actorId, rec, Date.now());
      this.write(ctx, actorId, rec);
    }
    this.clocks.delete(actorId);
  }

  disconnect(userId: number, ctx: SystemContext): void {
    this.clocks.forEach((clock, actorId) => {
      if (clock.userId === userId) this.goOffline(ctx, actorId);
    });
  }

  // A mage's cast of a real spell; a higher tier than any before may lift the rank cap. False for anything else.
  private noteCast(ctx: SystemContext, actorId: number, rec: MasteryRecord, spellId: number): boolean {
    if (rec.profession !== "mage") return false;
    const info = spellInfo(ctx.svr as Mp, spellId);
    if (info.type !== SpellType.Spell) return false;
    if (info.tier > rec.spellTier) {
      rec.spellTier = info.tier;
      this.write(ctx, actorId, rec);
      if (this.rankFor(rec) !== rec.rank) this.syncRank(ctx, actorId, rec, this.userOf(ctx, actorId));
    }
    return true;
  }

  private matches(ctx: SystemContext, rec: MasteryRecord, rules: ResolvedRules, ev: ActivityEvent): boolean {
    switch (ev.kind) {
      case "craft": {
        const recipeId = ev.detail["recipeId"];
        const bench = this.recipeBench(ctx, recipeId);
        if (!ev.detail["held"] || !bench || this.isCommonRecipe(ctx, recipeId)) return false;
        const byKeyword = rules.craftKeywords.has(bench) || this.sharesRecipe(ctx, recipeId, rec.profession);
        if (!byKeyword && !rules.craftStations.size) return false;
        return this.benchInReach(ctx, ev.actorId, bench, (keywords) =>
          byKeyword || Array.from(rules.craftStations).some((k) => keywords.has(k)));
      }
      case "activate": {
        const refrId = ev.detail["refrId"];
        const loc = this.locationOf(ctx, ev.actorId);
        if (!loc || !this.inReach(ctx, loc, refrId) || this.isDisabled(ctx, refrId)) return false;
        const base = this.baseOf(ctx, refrId);
        if (!base) return false;
        if (rules.activateTypes.has(base.type)) return true;
        const edid = base.editorId.toLowerCase();
        return rules.activatePrefixes.some((p) => edid.startsWith(p));
      }
      case "kill":
        return this.killCounts(ctx, ev.actorId, ev.detail["victimId"], rules.killKeywords);
      case "cast":
        return true;
      case "work":
        return PROFESSION_IDS[ev.detail["profession"]] === rec.profession;
      default:
        return false;
    }
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  summaryOf(ctx: SystemContext, actorId: number): MasterySummary {
    const rec = this.read(ctx, actorId) || emptyRecord();
    return {
      profession: rec.profession,
      label: rec.profession ? this.labelOf(rec.profession) : "",
      rank: rec.rank,
      rankName: RANK_NAMES[rec.rank],
      hours: rec.points,
    };
  }

  // Adds (or with a negative amount removes) worked hours; rank and marker spells follow. Null for an amount the system refuses.
  grantPoints(ctx: SystemContext, actorId: number, amount: number): MasterySummary | null {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GRANT) return null;
    const rec = this.read(ctx, actorId) || emptyRecord();
    rec.points = Math.max(0, rec.points + amount);
    return this.settle(ctx, actorId, rec);
  }

  // Lifts the character to Legendary: the hours of the last threshold, and for a mage the spell tier that allows it. Null without a profession.
  grantLegendary(ctx: SystemContext, actorId: number): MasterySummary | null {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return null;
    rec.points = Math.max(rec.points, this.rankHours[this.rankHours.length - 1]);
    rec.spellTier = Math.max(rec.spellTier, LEGENDARY - 1);
    return this.settle(ctx, actorId, rec);
  }

  private settle(ctx: SystemContext, actorId: number, rec: MasteryRecord): MasterySummary {
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    if (rec.profession) this.notice(ctx, userId, `Your hours as a ${this.labelOf(rec.profession)} now stand at ${rec.points}.`);
    this.syncRank(ctx, actorId, rec, userId);
    return this.summaryOf(ctx, actorId);
  }

  // Admin escape hatch: clears the choice so the character may pick again. False when there was nothing to clear.
  resetCharacter(ctx: SystemContext, actorId: number): boolean {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return false;
    this.revokeSpells(ctx, actorId, rec);
    // Hours belong to the craft, so a fresh choice starts from nothing.
    Object.assign(rec, { profession: null, points: 0, lastPointAt: 0, rank: FREE, spellTier: 0, bank: 0, onlineMs: 0 });
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, "Your profession has been set aside. You may choose again.");
    this.sendState(ctx, actorId, userId);
    this.sendMenu(ctx, userId);
    return true;
  }

  // ── Login ───────────────────────────────────────────────────────────────────

  // Thresholds can be retuned under a character's feet and older records predate the rank ladder, so rank and markers are settled on login.
  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    const mp = ctx.svr as Mp;
    this.clocks.forEach((clock, otherActor) => {
      if (clock.userId === userId && otherActor !== actorId) this.goOffline(ctx, otherActor);
    });
    if (!isPlayerActor(mp, actorId)) return;
    const now = Date.now();
    this.clocks.set(actorId, { userId, since: now, savedAt: now });
    const rec = this.read(ctx, actorId);
    if (rec && rec.profession) {
      if (rec.v !== RECORD_VERSION) this.migrate(ctx, actorId, rec);
      const corrected = this.rankFor(rec);
      if (corrected < rec.rank) this.revokeAbove(ctx, actorId, rec, corrected);
      rec.rank = corrected;
      this.write(ctx, actorId, rec);
      if (rec.bank > 0) this.log(`[mastery] ${hex(actorId)} online with ${hoursText(rec.bank)} banked, next paid in ${Math.max(1, Math.ceil((this.intervalMs - rec.onlineMs) / 60000))} online min`);
    }
    this.sendState(ctx, actorId, userId);
    // Grants, kits and the state again wait out the client's spawn-time spell wipe
    this.pendingGrants.set(actorId, Date.now() + LOGIN_GRANT_DELAY_MS);
  }

  // Markers of the old ladder that are not markers of the new one go; the ones still wanted are granted after the login delay
  private migrate(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    const wanted = rec.profession ? this.spells[rec.profession] || [] : [];
    for (const spellId of rec.granted.filter((id) => wanted.indexOf(id) === -1)) this.removeSpell(ctx, actorId, spellId);
    rec.granted = rec.granted.filter((id) => wanted.indexOf(id) !== -1);
    rec.v = RECORD_VERSION;
    this.log(`[mastery] ${hex(actorId)} migrated to the rank ladder: ${rec.profession} ${rec.points}h`);
  }

  private flushPendingGrants(ctx: SystemContext): void {
    if (!this.pendingGrants.size) return;
    const now = Date.now();
    this.pendingGrants.forEach((dueAt, actorId) => {
      if (now < dueAt) return;
      this.pendingGrants.delete(actorId);
      const userId = this.userOf(ctx, actorId);
      if (userId < 0) return;
      const rec = this.read(ctx, actorId);
      if (rec && rec.profession) {
        this.applySpells(ctx, actorId, rec);
        this.giveKit(ctx, actorId, userId, rec.profession);
      }
      this.sendState(ctx, actorId, userId);
    });
  }

  // The player's own reset: the same as the admin one, counted against masteryResetsPerCharacter
  private onResetRequest(ctx: SystemContext, userId: number): void {
    const now = Date.now();
    if (now - (this.lastChooseMs.get(userId) || 0) < CHOOSE_COOLDOWN_MS) return;
    this.lastChooseMs.set(userId, now);
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.profession) return;
    if (rec.resets >= this.resetsPerCharacter) {
      this.notice(ctx, userId, "You have no profession resets left.");
      return;
    }
    rec.resets += 1;
    this.write(ctx, actorId, rec);
    this.resetCharacter(ctx, actorId);
  }

  private onChoose(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastChooseMs.get(userId) || 0) < CHOOSE_COOLDOWN_MS) return;
    this.lastChooseMs.set(userId, now);
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const professionId = String(content["profession"] || "");
    if (PROFESSION_IDS.indexOf(professionId) === -1) return;

    const rec = this.read(ctx, actorId) || emptyRecord();
    if (rec.profession) {
      this.notice(ctx, userId, `You have already given yourself to the ${this.labelOf(rec.profession)}.`);
      return;
    }
    // Finishing creation cuts the inventory back to the starter clothes, which would take the kit with it
    if (isCreationPending(ctx.svr as Mp, actorId)) {
      this.notice(ctx, userId, "Finish creating your character before you choose a craft.");
      return;
    }
    rec.profession = professionId;
    rec.v = RECORD_VERSION;
    rec.rank = this.rankFor(rec);
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec);
    this.notice(ctx, userId, `You take up the craft of the ${this.labelOf(professionId)}.`);
    this.giveKit(ctx, actorId, userId, professionId);
    this.sendState(ctx, actorId, userId);
    this.sendMenu(ctx, userId);
  }

  // A read that throws counts as given, so a hiccup never hands out a second kit
  private hasKit(ctx: SystemContext, actorId: number): boolean {
    try { return !!(ctx.svr as Mp).get(actorId, KIT_PROP); } catch { return true; }
  }

  // Once per character; AddItem is not silent, so each stack shows its own "+ name (count)" line
  private giveKit(ctx: SystemContext, actorId: number, userId: number, professionId: string): void {
    if (this.hasKit(ctx, actorId)) return;
    const mp = ctx.svr as Mp;
    const gold = hadStarterGold(mp, actorId) ? 0 : this.kitGold;
    try {
      mp.set(actorId, KIT_PROP, { profession: professionId, at: Date.now(), gold });
    } catch (e) {
      this.log(`[mastery] kit flag failed for ${hex(actorId)}: ${e}`);
      return;
    }
    const kit = (this.kits[professionId] || []).concat(gold > 0 ? [{ baseId: GOLD_BASE_ID, count: gold }] : []);
    for (const item of kit) {
      try {
        addItemTo(mp, actorId, item.baseId, item.count);
      } catch (e) {
        this.log(`[mastery] kit item ${hex(item.baseId)} failed for ${hex(actorId)}: ${e}`);
      }
    }
    this.log(`[mastery] ${hex(actorId)} starting kit for ${professionId}: ${kit.map((i) => `${hex(i.baseId)}x${i.count}`).join(", ") || "none"}`);
    if (kit.length) this.notice(ctx, userId, `The ${this.labelOf(professionId)}'s starting kit is in your pack.`);
  }

  // ── Menu and state ──────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number): void {
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    this.send(ctx, userId, {
      customPacketType: "masteryMenu",
      profession: rec.profession,
      rank: rec.rank,
      hours: rec.points,
      rankHours: [0, 0].concat(this.rankHours),
      resetsLeft: Math.max(0, this.resetsPerCharacter - rec.resets),
      professions: PROFESSIONS.map(({ id, label, title, type, blurbs }) => ({ id, label, title, type, blurbs })),
    });
  }

  // Every mapped skill at the Free level, the character's own at its rank level; magicka only for a mage
  private sendState(ctx: SystemContext, actorId: number, userId: number): void {
    if (userId < 0) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    const skills: Record<string, number> = {};
    for (const skill of ALL_SKILLS) skills[skill] = RANK_SKILL[FREE];
    const own = PROFESSIONS.find((p) => p.id === rec.profession);
    for (const skill of own ? own.skills : []) skills[skill] = RANK_SKILL[rec.rank];
    this.send(ctx, userId, {
      customPacketType: "professionState",
      profession: rec.profession,
      rank: rec.rank,
      rankName: RANK_NAMES[rec.rank],
      hours: rec.points,
      skills,
      magicka: rec.profession === "mage" ? MAGE_MAGICKA[rec.rank] : null,
    });
  }

  // ── Ranks and marker spells ─────────────────────────────────────────────────

  private rankFor(rec: MasteryRecord): number {
    if (!rec.profession) return FREE;
    let rank = NOVICE;
    for (let i = 0; i < this.rankHours.length; i++) {
      if (rec.points >= this.rankHours[i]) rank = NOVICE + i + 1;
    }
    // A mage rises past Adept only as far as one rank above the best spell tier cast
    if (rec.profession === "mage") rank = Math.min(rank, Math.max(ADEPT, rec.spellTier + 1));
    return rank;
  }

  // Rank follows points and the marker spells follow rank, both ways.
  private syncRank(ctx: SystemContext, actorId: number, rec: MasteryRecord, userId: number): void {
    const oldRank = rec.rank;
    const newRank = this.rankFor(rec);
    if (newRank < oldRank) this.revokeAbove(ctx, actorId, rec, newRank);
    rec.rank = newRank;
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec);
    this.sendState(ctx, actorId, userId);
    if (newRank === oldRank || !rec.profession) return;
    const label = this.labelOf(rec.profession);
    this.notice(ctx, userId, newRank > oldRank
      ? `You are now ${RANK_NAMES[newRank]} of the ${label}.`
      : `Your standing has fallen to ${RANK_NAMES[newRank]} of the ${label}.`);
  }

  // Marker list index 0 is Novice, so a character holds the first `rank` of them.
  private missingSpells(rec: MasteryRecord): number[] {
    const list = rec.profession ? this.spells[rec.profession] : null;
    if (!list) return [];
    return list.slice(0, rec.rank).filter((spellId) => spellId && rec.granted.indexOf(spellId) === -1);
  }

  // The plugin's recipes condition on the exact rank they belong to, so a Master still needs the Novice marker.
  private applySpells(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    const missing = this.missingSpells(rec);
    if (!missing.length) return;
    for (const spellId of missing) {
      this.addSpell(ctx, actorId, spellId);
      rec.granted.push(spellId);
    }
    this.write(ctx, actorId, rec);
  }

  private revokeAbove(ctx: SystemContext, actorId: number, rec: MasteryRecord, keepRank: number): void {
    const list = rec.profession ? this.spells[rec.profession] : null;
    if (!list) return;
    for (const spellId of list.slice(keepRank)) {
      const at = rec.granted.indexOf(spellId);
      if (spellId && at !== -1) {
        this.removeSpell(ctx, actorId, spellId);
        rec.granted.splice(at, 1);
      }
    }
  }

  private revokeSpells(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    for (const spellId of rec.granted.slice()) this.removeSpell(ctx, actorId, spellId);
    rec.granted = [];
  }

  // A console addspell would be client-local and lost on the next actor sync.
  private addSpell(ctx: SystemContext, actorId: number, spellId: number): void {
    try {
      addSpellTo(ctx.svr as Mp, actorId, spellId);
    } catch (e) {
      this.log(`[mastery] could not grant spell ${spellId.toString(16)}: ${e}`);
    }
  }

  private removeSpell(ctx: SystemContext, actorId: number, spellId: number): void {
    if (!spellId) return;
    try {
      removeSpellFrom(ctx.svr as Mp, actorId, spellId);
    } catch (e) {
      this.log(`[mastery] could not revoke spell ${spellId.toString(16)}: ${e}`);
    }
  }

  // Marker spells of the professions the settings leave out, by the plugin editor id convention, and the mage's blank book.
  private async loadPluginForms(ctx: SystemContext, dataDir: string, loadOrder: string[]): Promise<void> {
    const missing = PROFESSION_IDS.filter((id) => !this.spells[id]);
    const ranks = RANK_NAMES.slice(NOVICE);
    const edidOf = (id: string, rank: string) => `AldProf_${this.labelOf(id)}_${rank}`;
    const names = missing.flatMap((id) => ranks.map((rank) => edidOf(id, rank)));
    const scan = await resolveEditorIds(names.concat([BLANK_BOOK_EDID, HOE_EDID]), dataDir, loadOrder, this.log, ["SPEL", "BOOK", "WEAP", "MISC"]);
    const mp = ctx.svr as Mp;
    const idOf = (edid: string): number => {
      const desc = scan.resolved.get(edid.toLowerCase());
      try { return desc ? mp.getIdFromDesc(desc) >>> 0 : 0; } catch { return 0; }
    };
    for (const id of missing) {
      const list = ranks.map((rank) => idOf(edidOf(id, rank)));
      if (list.some((v) => v)) this.spells[id] = list;
    }
    this.hoe = idOf(HOE_EDID);
    if (this.hoe && this.kits["farmer"] === DEFAULT_KITS["farmer"]) this.kits["farmer"] = [{ baseId: this.hoe, count: 1 }];
    else if (!this.hoe) this.log(`[mastery] ${HOE_EDID} not in the load order, farmers get no hoe and crops need none`);
    const book = idOf(BLANK_BOOK_EDID);
    if (book && this.kits["mage"] === DEFAULT_KITS["mage"]) this.kits["mage"] = DEFAULT_KITS["mage"].concat([{ baseId: book, count: 1 }]);
    else if (!book) this.log(`[mastery] ${BLANK_BOOK_EDID} not in the load order, the mage kit has no blank book`);
    this.log(`[mastery] plugin marker spells found for ${missing.filter((id) => this.spells[id]).length}/${missing.length} unconfigured profession(s) in ${scan.scannedMs} ms`);
  }

  // The hoe's form id, 0 when the plugin lacks it
  hoeFormId(): number {
    return this.hoe;
  }

  // Rank of a character in the given profession, Free (0) when it follows another craft or none.
  rankOf(ctx: SystemContext, actorId: number, professionId: string): number {
    return this.rankIn(ctx, actorId, [professionId]);
  }

  // Rank when the character follows one of the professions, Free otherwise.
  rankIn(ctx: SystemContext, actorId: number, professionIds: string[]): number {
    const rec = this.read(ctx, actorId);
    return rec && rec.profession && professionIds.indexOf(rec.profession) !== -1 ? rec.rank : FREE;
  }

  // Rank when the character's own profession works this bench keyword, Free otherwise.
  craftRank(ctx: SystemContext, actorId: number, benchKeyword: number): number {
    const rec = this.read(ctx, actorId);
    const rules = rec && rec.profession ? this.rules[rec.profession] : null;
    return rules && (rules.craftKeywords.has(benchKeyword >>> 0) || rules.craftStations.has(benchKeyword >>> 0)) ? rec!.rank : FREE;
  }

  // The rank that prices a craft and whether it costs half; shared recipes take the best of their professions
  craftCost(ctx: SystemContext, actorId: number, recipeId: number): { rank: number; half: boolean } {
    const bench = this.recipeBench(ctx, recipeId);
    const edid = this.baseInfo(ctx, recipeId)?.editorId || "";
    const shared = SHARED_RECIPES.find(([prefix]) => edid.startsWith(prefix));
    const rank = shared ? this.rankIn(ctx, actorId, shared[1]) : this.craftRank(ctx, actorId, bench);
    const product = this.baseInfo(ctx, espmFieldFormIds(this.lookup(ctx, recipeId), "CNAM")[0] || 0)?.editorId || "";
    return { rank, half: this.halfCostBench(bench) || HALF_COST_PRODUCTS.has(product.toLowerCase()) };
  }

  // Whether a shared recipe also counts for this profession
  private sharesRecipe(ctx: SystemContext, recipeId: number, profession: string | null): boolean {
    if (!profession) return false;
    const edid = this.baseInfo(ctx, recipeId)?.editorId || "";
    return SHARED_RECIPES.some(([prefix, professions]) => edid.startsWith(prefix) && professions.indexOf(profession) !== -1);
  }

  halfCostBench(benchKeyword: number): boolean {
    return HALF_COST_BENCHES_OF.some((id) => !!this.rules[id] && this.rules[id].craftKeywords.has(benchKeyword >>> 0));
  }

  // Whether any profession crafts at this bench keyword
  isCraftBench(benchKeyword: number): boolean {
    return PROFESSION_IDS.some((id) => this.rules[id] && this.rules[id].craftKeywords.has(benchKeyword >>> 0));
  }

  professionOf(ctx: SystemContext, actorId: number): string | null {
    return this.read(ctx, actorId)?.profession ?? null;
  }

  // Whether an actor's base records or race carry the keyword; players count as ActorTypeNPC only.
  actorHasKeyword(ctx: SystemContext, actorId: number, keywordId: number): boolean {
    return this.actorHasAny(ctx, actorId, new Set([keywordId >>> 0]));
  }

  // Whether a base record carries the keyword; the espm lookup is cached per base id.
  baseHasKeyword(ctx: SystemContext, baseId: number, keywordId: number): boolean {
    return !!baseId && !!keywordId && this.baseKeywords(ctx, baseId >>> 0).has(keywordId >>> 0);
  }

  // Keywords of the furniture or activator behind a reference, empty for anything else
  stationKeywords(ctx: SystemContext, refrId: number): Set<number> {
    const base = this.baseOf(ctx, refrId);
    return base && (base.type === "FURN" || base.type === "ACTI") ? this.baseKeywords(ctx, base.id) : new Set<number>();
  }

  // Settings override the default kits profession by profession; a malformed list keeps the default
  private loadKits(ctx: SystemContext, raw: unknown): void {
    const overrides = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const unknown = Object.keys(overrides).filter((id) => PROFESSION_IDS.indexOf(id) === -1);
    if (unknown.length) this.log(`[mastery] masteryKits keys that are no profession id: ${unknown.join(", ")}`);
    for (const id of PROFESSION_IDS) {
      const list = overrides[id];
      if (list === undefined) continue;
      const parsed = Array.isArray(list) && !list.length ? [] : parseStartingItems(list);
      if (parsed) this.kits[id] = parsed;
      else this.log(`[mastery] masteryKits.${id} is malformed, the default kit stays`);
    }
    const missing = PROFESSION_IDS.flatMap((id) => (this.kits[id] || []).filter((i) => !this.lookup(ctx, i.baseId)).map((i) => `${id} ${hex(i.baseId)}`));
    if (missing.length) this.log(`[mastery] kit items not in the load order: ${missing.join(", ")}`);
  }

  // ── Activity rules ──────────────────────────────────────────────────────────

  private async loadRules(ctx: SystemContext, raw: unknown, dataDir: string, loadOrder: string[]): Promise<void> {
    const overrides = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const merged: Record<string, ActivityRules> = {};
    const wanted = new Set<string>([PLAYER_KEYWORD]);
    for (const id of PROFESSION_IDS) {
      const def = DEFAULT_ACTIVITIES[id] || {};
      const o = overrides[id] && typeof overrides[id] === "object" ? overrides[id] as Record<string, unknown> : {};
      const pick = (key: keyof ActivityRules): string[] => stringList(key in o ? o[key] : def[key]);
      const rules: ActivityRules = {
        craftKeywords: pick("craftKeywords"),
        craftStations: pick("craftStations"),
        activatePrefixes: pick("activatePrefixes"),
        activateTypes: pick("activateTypes"),
        killKeywords: pick("killKeywords"),
      };
      merged[id] = rules;
      for (const k of rules.craftKeywords.concat(rules.craftStations, rules.killKeywords)) wanted.add(k);
    }

    const ids = new Map<string, number>();
    const names = Array.from(wanted);
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, ["KYWD"]);
    const mp = ctx.svr as Mp;
    const unresolved: string[] = [];
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
      else unresolved.push(name);
    }
    this.playerKeyword = ids.get(PLAYER_KEYWORD) || 0;
    this.log(`[mastery] resolved ${ids.size}/${names.length} keyword(s) in ${scan.scannedMs} ms${unresolved.length ? `, unresolved: ${unresolved.join(", ")}` : ""}`);

    const toIds = (list: string[]): Set<number> => new Set(list.map((n) => ids.get(n) || 0).filter((v) => v));
    for (const id of PROFESSION_IDS) {
      const r = merged[id];
      this.rules[id] = {
        craftKeywords: toIds(r.craftKeywords),
        craftStations: toIds(r.craftStations),
        activatePrefixes: r.activatePrefixes.map((p) => p.toLowerCase()),
        activateTypes: new Set(r.activateTypes.map((t) => t.toUpperCase())),
        killKeywords: toIds(r.killKeywords),
      };
    }
  }

  private locationOf(ctx: SystemContext, actorId: number): Location | null {
    try {
      const loc = (ctx.svr as Mp).get(actorId, "locationalData");
      if (!loc || !Array.isArray(loc.pos) || loc.pos.length !== 3) return null;
      return { cell: String(loc.cellOrWorldDesc), pos: loc.pos.map(Number) };
    } catch {
      return null;
    }
  }

  private isDisabled(ctx: SystemContext, refrId: number): boolean {
    try { return !!(ctx.svr as Mp).get(refrId, "isDisabled"); } catch { return true; }
  }

  private inReach(ctx: SystemContext, loc: Location, refrId: number, reach = ACTIVATE_REACH): boolean {
    const mp = ctx.svr as Mp;
    try {
      if (loc.cell !== String(mp.get(refrId, "worldOrCellDesc"))) return false;
      const pos = mp.get(refrId, "pos");
      if (!Array.isArray(pos)) return false;
      const d = Math.hypot(loc.pos[0] - pos[0], loc.pos[1] - pos[1], loc.pos[2] - pos[2]);
      return Number.isFinite(d) && d <= reach;
    } catch {
      return false;
    }
  }

  // Killing yourself is not work, and neither is a forged kill further away than a bow carries.
  private killCounts(ctx: SystemContext, actorId: number, victimId: number, keywords: Set<number>): boolean {
    if (!victimId || victimId === actorId || !keywords.size) return false;
    // A pet, owned or released, is nobody's game
    if (this.isPet(ctx, victimId)) return false;
    const loc = this.locationOf(ctx, actorId);
    if (!loc || !this.inReach(ctx, loc, victimId, KILL_REACH)) return false;
    return this.actorHasAny(ctx, victimId, keywords);
  }

  private isPet(ctx: SystemContext, actorId: number): boolean {
    try {
      return !!(ctx.svr as any).get(actorId, "private.pet");
    } catch {
      return false;
    }
  }

  // The C++ matches the recipe against the packet's ingredient list, not the inventory, so a craft with nothing in the bag must not count.
  holdsInputs(ctx: SystemContext, actorId: number, recipeId: number): boolean {
    const needed = this.recipeInputs(ctx, recipeId);
    if (!needed.length) return false;
    let held: Map<number, number>;
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory");
      held = new Map();
      for (const e of (inv && Array.isArray(inv.entries)) ? inv.entries : []) {
        const baseId = Number(e.baseId) >>> 0;
        held.set(baseId, (held.get(baseId) || 0) + (Number(e.count) || 0));
      }
    } catch {
      return false;
    }
    return needed.every((n) => (held.get(n.baseId) || 0) >= n.count);
  }

  // The craft packet names no workbench, so look for a station carrying the recipe's keyword next to the crafter.
  private benchInReach(ctx: SystemContext, actorId: number, bench: number, accept: (stationKeywords: Set<number>) => boolean): boolean {
    const loc = this.locationOf(ctx, actorId);
    if (!loc) return false;
    let near: unknown;
    try {
      near = (ctx.svr as Mp).getNeighborsByPosition(loc.cell, loc.pos);
    } catch (e) {
      if (!this.neighborsFailed) this.log(`[mastery] getNeighborsByPosition failed, crafts cannot be credited: ${e}`);
      this.neighborsFailed = true;
      return false;
    }
    if (!Array.isArray(near)) return false;
    for (const id of near) {
      const refrId = Number(id) >>> 0;
      if (!refrId || !this.inReach(ctx, loc, refrId)) continue;
      const base = this.baseOf(ctx, refrId);
      if (!base || (base.type !== "FURN" && base.type !== "ACTI")) continue;
      const keywords = this.baseKeywords(ctx, base.id);
      if (keywords.has(bench) && accept(keywords)) return true;
    }
    return false;
  }

  // ── Espm lookups (cached: plugins only change with a restart) ──────────────

  private lookup(ctx: SystemContext, formId: number): any {
    if (!formId) return null;
    try {
      const res = (ctx.svr as Mp).lookupEspmRecordById(formId >>> 0);
      return res && res.record ? res : null;
    } catch {
      return null;
    }
  }

  // Workbench keyword of a recipe, 0 when unknown.
  recipeBench(ctx: SystemContext, recipeId: number): number {
    const hit = this.benchCache.get(recipeId);
    if (hit !== undefined) return hit;
    const bench = espmFieldFormIds(this.lookup(ctx, recipeId), "BNAM")[0] || 0;
    this.benchCache.set(recipeId, bench);
    return bench;
  }

  private isCommonRecipe(ctx: SystemContext, recipeId: number): boolean {
    const info = this.baseInfo(ctx, recipeId);
    return !!info && info.editorId.startsWith(COMMON_RECIPE_PREFIX);
  }

  private recipeInputs(ctx: SystemContext, recipeId: number): Array<{ baseId: number; count: number }> {
    const hit = this.inputCache.get(recipeId);
    if (hit) return hit;
    const out = espmContainerEntries(this.lookup(ctx, recipeId));
    this.inputCache.set(recipeId, out);
    return out;
  }

  // Base object behind a placed or runtime reference.
  private baseOf(ctx: SystemContext, refrId: number): BaseInfo | null {
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(refrId, "baseDesc"))) >>> 0; } catch { return null; }
    return baseId ? this.baseInfo(ctx, baseId) : null;
  }

  private baseInfo(ctx: SystemContext, formId: number): BaseInfo | null {
    const hit = this.baseCache.get(formId);
    if (hit !== undefined) return hit;
    const res = this.lookup(ctx, formId);
    const info = res ? { id: formId, type: String(res.record.type || ""), editorId: String(res.record.editorId || "") } : null;
    this.baseCache.set(formId, info);
    return info;
  }

  // Keywords of the NPC_ records in the actor's template chain and of the race that supplies its traits.
  private actorHasAny(ctx: SystemContext, actorId: number, keywords: Set<number>): boolean {
    if (!keywords.size || !actorId) return false;
    const mp = ctx.svr as Mp;
    let profileId = -1;
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { /* not an actor */ }
    if (profileId >= 0) return keywords.has(this.playerKeyword);
    const chain = npcChainOf(mp, actorId);
    const raceId = effectiveRaceId(mp, chain);
    for (const baseId of raceId ? [...chain, raceId] : chain) {
      for (const k of this.baseKeywords(ctx, baseId)) {
        if (keywords.has(k)) return true;
      }
    }
    return false;
  }

  // Keywords of any base record (a RACE included); an NPC_'s placeholder race is never read here.
  private baseKeywords(ctx: SystemContext, baseId: number): Set<number> {
    const hit = this.keywordCache.get(baseId);
    if (hit) return hit;
    const out = new Set<number>(espmFieldFormIds(this.lookup(ctx, baseId), "KWDA"));
    this.keywordCache.set(baseId, out);
    return out;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  private read(ctx: SystemContext, actorId: number): MasteryRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, MASTERY_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Partial<MasteryRecord>;
      const profession = typeof r.profession === "string" && PROFESSION_IDS.indexOf(r.profession) !== -1 ? r.profession : null;
      return {
        v: Number(r.v) || 0,
        profession,
        points: Math.max(0, Math.floor(Number(r.points)) || 0),
        lastPointAt: Math.max(0, Number(r.lastPointAt) || 0),
        rank: Math.min(LEGENDARY, Math.max(FREE, Math.floor(Number(r.rank)) || 0)),
        granted: Array.isArray(r.granted) ? r.granted.map((v) => Number(v) >>> 0).filter((v) => v) : [],
        spellTier: Math.max(0, Math.floor(Number(r.spellTier)) || 0),
        resets: Math.max(0, Math.floor(Number(r.resets)) || 0),
        bank: Math.max(0, Math.floor(Number(r.bank)) || 0),
        onlineMs: Math.max(0, Number(r.onlineMs) || 0),
      };
    } catch {
      return null;
    }
  }

  private write(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    try {
      (ctx.svr as Mp).set(actorId, MASTERY_PROP, rec);
    } catch (e) {
      this.log(`[mastery] write failed for ${actorId.toString(16)}: ${e}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private labelOf(professionId: string): string {
    const p = PROFESSIONS.filter((x) => x.id === professionId)[0];
    return p ? p.label : professionId;
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
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

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "masteryNotice", text });
  }

  private rankHours = DEFAULT_RANK_HOURS.slice();
  private kits: Record<string, KitItem[]> = { ...DEFAULT_KITS };
  private kitGold = DEFAULT_KIT_GOLD;
  private intervalMs = DEFAULT_POINT_INTERVAL_MINUTES * 60000;
  private bankMax = DEFAULT_HOUR_BANK;
  // Online player characters and the online time not yet in their record
  private clocks = new Map<number, OnlineClock>();
  private lastBankCheck = 0;
  private hoe = 0;
  // Profession resets a player may use on one character; masteryResetsPerCharacter overrides
  private resetsPerCharacter = 1;
  private spells: Record<string, number[]> = {};
  private rules: Record<string, ResolvedRules> = {};
  private playerKeyword = 0;
  private neighborsFailed = false;
  private events: ActivityEvent[] = [];
  private lastChooseMs = new Map<number, number>();
  private pendingGrants = new Map<number, number>();

  private benchCache = new Map<number, number>();
  private inputCache = new Map<number, Array<{ baseId: number; count: number }>>();
  private baseCache = new Map<number, BaseInfo | null>();
  private keywordCache = new Map<number, Set<number>>();
}
