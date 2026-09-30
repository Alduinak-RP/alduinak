import { Settings } from "../settings";
import { System, Log, SystemContext, Content, CREATION_FINISHED_EVENT, USER_MENU_QUIT_EVENT } from "./system";
import { resolveEditorIds, isEditorId, scanRecords, espmDesc } from "./espmEditorIds";
import { espmContainerEntries, espmFieldFormIds } from "./formIdUtil";
import { hasSpellConditions, spellInfo, SpellType } from "./espmMagic";
import { GOLD_BASE_ID, HUNTING_KNIFE_ID, addItemTo, addSpellTo, chainMpHook, hadStarterGold, hex, isCreationPending, isPlayerActor, removeSpellFrom } from "./actorUtil";
import { parseStartingItems } from "./spawn";
import { setIntroProfessions } from "./startLocations";
import { BLANK_BOOK_EDID } from "./writingSystem";
import { effectiveRaceId, npcChainOf } from "./npcTemplate";
import {
  ADEPT, ChooseRefusal, FREE, HeldSlot, LEGENDARY, NOVICE, RANK_NAMES, RecipeGate, SLOT_NAMES, SlotConfig, SlotRecord, bestSlot, chooseRefusal,
  creditsCraft, defaultSlots, describeSlots, duplicateSlots, emptySlotRecord, hoursToNext, isCapped, multiclassOn, nextEmptySlot, parseSlots,
  slotRankFor, toSlotRecord,
} from "./masterySlots";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Professions: up to three per character, ranked by hours of work ──────────
//
// docs/docs_professions_revamp_contract.md is the fixed interface. Everyone is Free (rank 0); choosing a primary profession
// makes the character a Novice of it, and hours of its work raise it to Adept, Expert, Master and Legendary. Every
// server-observed activity of the profession is worth one hour, at most one per hour. This system chains the native
// onCraft/onActivate/onSpellCast hooks on `mp` and the gamemode relays kills through globalThis.__alduinakMasteryEvent
// (gamemode_extensions/62_mastery.js); other systems credit their own work (skinning) through creditWork. Each rank
// grants a cumulative marker spell AldProf_<Label>_<Rank>; the plugin's recipes condition on it with HasSpell.
// A mage cannot rise above Adept without having cast an Adept spell, above Expert without an Expert one, and so on.
// Hour bank: each extra craft of the profession inside a counted hour banks one hour, up to masteryHourBank; a banked hour
// is counted once the character has been online for a full interval since the last counted hour and no work counted one.
// Multiclassing (masterySlots with more than one slot): a secondary and a tertiary craft, picked in order after the primary,
// start at Free and earn Novice by the hours of their class's free work (an ungated recipe, or a gated one only through a
// marker of the slot's own profession at a rank it holds), then climb to their cap on their own ladder. Every slot has its
// own hour clock and bank; one event credits every slot it qualifies for. The rank readers take the best slot.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "masteryInfoRequest" }
//     { customPacketType: "masteryChoose", profession: "<id>", slot?: 0|1|2 }  slot defaults to the primary
//     { customPacketType: "masteryResetRequest", profession?: "<id>" }  the player sets a craft aside (default the primary),
//                                                   at most masteryResetsPerCharacter times over all slots
//   Server -> Client:
//     { customPacketType: "masteryMenu", profession, rank, hours, rankHours, resetsLeft, professions: [...],
//       slots: [{ slot, name, profession, label, rank, rankName, hours, cap, capName, rankHours }] }
//     { customPacketType: "masteryNotice", text }
//     { customPacketType: "professionState", profession, rank, rankName, hours, skills, magicka, slots: [...] }
//   profession, rank and hours stay the primary's; skills are the best of the slots; magicka is the mage slot's rank value
//   plus the race's bonus, the race's base for anyone else, null while in creation.
//
// Persistence on the actor: `private.mastery` = { v: 2, profession, points, lastPointAt, rank, granted[], spellTier, resets, bank,
// onlineMs } (the primary) and `private.masterySlots` = { v: 1, secondary, tertiary, granted[], kits[] }, each sub-slot a
// { profession, points, lastPointAt, rank, bank, onlineMs } or null, granted the markers held for either sub-slot.
//
// server-settings.json keys (all optional):
//   masteryRankHours             [adept, expert, master, legendary] thresholds, default [40, 100, 180, 6000]
//   masterySlots                 [{ name, cap, rankHours }] in pick order, default one primary (multiclassing off), see masterySlots.ts
//   masterySlotKits              a sub-slot pick hands over that craft's kit items, never gold, once per craft, default true
//   masteryPointIntervalMinutes  minimum gap between two hours of one slot, default 60
//   masteryHourBank              hours extra crafts may bank per slot, default 2; 0 turns the bank off
//   masterySpells                { "<professionId>": [novice, adept, expert, master, legendary] } marker form ids
//                                overriding the plugin's AldProf_<Label>_<Rank> spells
//   masteryActivities            { "<professionId>": { craftKeywords, craftStations, activatePrefixes, activateTypes,
//                                killKeywords } } overriding DEFAULT_ACTIVITIES key by key. Keywords take an editor id,
//                                a hex id or a desc ("88105:Skyrim.esm").
//   masteryKits                  { "<professionId>": [{ baseId, count }] } overriding DEFAULT_KITS key by key; [] gives nothing
//   masteryKitGold               gold every profession's kit carries, default 50; 0 turns it off. A character marked
//                                private.starterGold (its starting items carried gold) gets none.

const MASTERY_PROP = "private.mastery";
const SLOTS_PROP = "private.masterySlots";
const SLOTS_VERSION = 1;
// Set with a character's first kit and never cleared, so a reset and a new pick bring no second one
const KIT_PROP = "private.professionKit";
// Plugin recipes any character makes (instruments, broom, war horns) are no one's work
const COMMON_RECIPE_PREFIX = "AldRecipeCommon_";
// Recipes whose rank bonus belongs to several professions, by editor id prefix
const SHARED_RECIPES: Array<[string, string[]]> = [["AldRecipeKiln_Charcoal", ["woodworker", "blacksmith", "miner"]]];
// Crafting at their benches costs half: cooking, alchemy, and refining at the smelter (miner) and the tanning rack (hunter)
const HALF_COST_BENCHES_OF = ["cook", "alchemist", "miner", "hunter"];
// Refining made at another bench, by the editor id of what the recipe makes
const HALF_COST_PRODUCTS = new Set(["mce_thread"]);
const RECORD_VERSION = 2;

export { RANK_NAMES, FREE, NOVICE, ADEPT, LEGENDARY };
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
      "A surer footing in a fight.",
      "A faster off hand, a shield carried at speed, and deeper wind.",
      "The charge: with a shield, a blade or a greatsword.",
      "The full stance, the sweeping blow, and a warmaster's reach.",
      "A legend of the battlefield.",
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

const DEFAULT_ACTIVITIES: Record<string, Partial<ActivityRules>> = {
  alchemist: { craftKeywords: ["AldCraftingAlchemy"], craftStations: ["AldCraftingMead"], activateTypes: ["FLOR", "TREE"] },
  // Anything made at a forge, anvil or smelter counts, and a temper at the workbench or grindstone
  blacksmith: {
    craftKeywords: ["CraftingSmithingForge", "CraftingSmelter", "CraftingSmithingSkyforge", "DLC2CraftingSmithingSkaalForge", "DLC1CraftingDawnguard", "DLC1LD_CraftingForgeAetherium", "CraftingSmithingArmorTable", "CraftingSmithingSharpeningWheel"],
    craftStations: ["isBlacksmithForge", "isBlacksmithAnvil", "isSmelter"],
  },
  cook: { craftKeywords: ["CraftingCookpot", "BYOHCraftingOven"], craftStations: ["AldCraftingMead"] },
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

// private.masterySlots; the primary stays in private.mastery
interface SubSlots {
  v: number;
  secondary: SlotRecord | null;
  tertiary: SlotRecord | null;
  // Markers held for either sub-slot
  granted: number[];
  // Crafts whose sub-slot kit was handed over
  kits: string[];
}

type SubKey = "secondary" | "tertiary";
const subKeyOf = (index: number): SubKey | null => (index === 1 ? "secondary" : index === 2 ? "tertiary" : null);

// Hours, clock and bank of one slot; the primary's record carries the same fields
type Progress = Pick<MasteryRecord, "profession" | "points" | "lastPointAt" | "rank" | "bank" | "onlineMs">;

// Both stored records of one character; subs is null until a sub-slot is taken, or while multiclassing is off and they were not read
interface Character {
  primary: MasteryRecord;
  subs: SubSlots | null;
}

// One slot of a character; cfg is null for a sub-slot the settings no longer configure
interface Slot {
  index: number;
  cfg: SlotConfig | null;
  rec: Progress;
  // The list that holds this slot's markers
  granted: number[];
}

interface OnlineClock {
  userId: number;
  // Epoch ms up to which online time is in the records' onlineMs
  since: number;
  savedAt: number;
}

// One configured slot as the admin panel and the Skills tab show it
export interface SlotSummary {
  slot: number;
  name: string;
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
  cap: number;
  capName: string;
  // Hours for each rank indexed by rank, Free first
  rankHours: number[];
}

// What the admin panel shows for one character; the top-level fields are the primary's
export interface MasterySummary {
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
  slots: SlotSummary[];
}

// The race's starting magicka above the common base, RacialSystem.baseBonus
export interface MagickaBonusSource {
  baseBonus(actorId: number): { magicka: number };
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
const emptySubs = (): SubSlots => ({ v: SLOTS_VERSION, secondary: null, tertiary: null, granted: [], kits: [] });
const hoursText = (n: number): string => `${n} ${n === 1 ? "hour" : "hours"}`;
const idList = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Number(x) >>> 0).filter((x) => x) : []);

export const stringList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];

export class MasterySystem implements System {
  systemName = "MasterySystem";

  constructor(private log: Log) { }

  // Mage magicka rides on the race's bonus, and anyone else is held at the race's base
  setRacial(source: MagickaBonusSource): void {
    this.racial = source;
  }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const hours = all?.["masteryRankHours"];
    if (Array.isArray(hours) && hours.length === DEFAULT_RANK_HOURS.length && hours.every((h) => Number.isFinite(Number(h)))) {
      this.rankHours = hours.map((h) => Number(h));
    } else if (hours !== undefined) {
      this.log(`[mastery] masteryRankHours needs ${DEFAULT_RANK_HOURS.length} numbers (adept, expert, master, legendary), default kept`);
    }
    const parsed = parseSlots(all?.["masterySlots"], this.rankHours);
    this.slots = parsed.slots;
    if (parsed.error) this.log(`[mastery] masterySlots ${parsed.error}, default kept`);
    setIntroProfessions(this.slots.map((slot) => ({ name: slot.name, capName: RANK_NAMES[slot.cap] })));
    const slotKits = all?.["masterySlotKits"];
    if (typeof slotKits === "boolean") this.slotKits = slotKits;
    else if (slotKits !== undefined) this.log("[mastery] masterySlotKits must be true or false, default kept");
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
    for (const [profession, list] of Object.entries(this.spells)) {
      list.forEach((spellId, i) => { if (spellId) this.markers.set(spellId >>> 0, { profession, rank: NOVICE + i }); });
    }

    const configured = Object.keys(this.spells).length;
    this.log(`[mastery] ready, ranks at ${this.rankHours.join("/")}h, one hour per ${this.intervalMs / 60000} min, extra crafts bank up to ${hoursText(this.bankMax)}, ${configured}/${PROFESSION_IDS.length} professions have marker spells`);
    const multiclass = multiclassOn(this.slots);
    this.log(`[mastery] slots: ${describeSlots(this.slots)}${multiclass ? `; each slot has its own ${this.intervalMs / 60000} min clock and ${hoursText(this.bankMax)} bank, ${this.resetsPerCharacter} reset(s) shared, sub-slot kits ${this.slotKits ? "on (items, no gold)" : "off"}, ${this.markers.size} rank markers read as recipe gates` : ""}`);
    if (multiclass) {
      this.logFreeRecipes(ctx, s.dataDir, s.loadOrder).catch((e) => this.log(`[mastery] free recipe count failed: ${e}`));
    }

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => {
      this.onActorAssigned(ctx, userId, actorId >>> 0);
    });
    ctx.gm.on(USER_MENU_QUIT_EVENT, (_userId: number, actorId: number) => this.goOffline(ctx, actorId >>> 0));
    // Magicka follows the race once creation has settled it, after the kit trim
    ctx.gm.on(CREATION_FINISHED_EVENT, (actorId: number) => this.pendingGrants.set(actorId >>> 0, Date.now() + LOGIN_GRANT_DELAY_MS));

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
      case "masteryResetRequest": this.onResetRequest(ctx, userId, content); break;
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

  // One hour per interval and slot; an extra craft inside a slot's counted hour goes to that slot's bank instead
  private creditActivity(ctx: SystemContext, ev: ActivityEvent): void {
    const char = this.load(ctx, ev.actorId);
    const slots = char ? this.activeSlots(char) : [];
    if (!char || !slots.length) return;
    if (ev.kind === "cast" && !this.noteCast(ctx, ev.actorId, char, slots, ev.detail["spellId"])) return;
    const gates = ev.kind === "craft" ? this.recipeGates(ctx, ev.detail["recipeId"]) : [];
    for (const slot of slots) {
      const profession = slot.rec.profession || "";
      if (slot.index > 0 && isCapped(slot.cfg!, slot.rec.points)) continue;
      const now = Date.now();
      const elapsed = now - slot.rec.lastPointAt;
      const counted = elapsed >= 0 && elapsed < this.intervalMs;
      if (counted && (ev.kind !== "craft" || slot.rec.bank >= this.bankMax)) continue;
      if (ev.kind === "craft" && !creditsCraft(profession, slot.rec.rank, gates)) continue;
      const rules = this.rules[profession];
      if (!rules || !this.matches(ctx, profession, rules, ev)) continue;
      if (counted) this.deposit(ctx, ev.actorId, char, slot, now);
      else this.countHour(ctx, ev.actorId, char, slot, now, false);
    }
  }

  // Points one hour; banked says it came out of the bank
  private countHour(ctx: SystemContext, actorId: number, char: Character, slot: Slot, now: number, banked: boolean): void {
    const rec = slot.rec;
    rec.points += 1;
    rec.lastPointAt = now;
    this.settleClock(actorId, char, now);
    rec.onlineMs = 0;
    this.save(ctx, actorId, char);
    const left = rec.bank ? `, ${hoursText(rec.bank)} still banked` : "";
    const standing = this.standingText(slot);
    this.log(`[mastery] ${hex(actorId)} ${this.tagOf(slot)} hour ${banked ? `paid from the bank after ${this.intervalMs / 60000} online min` : "counted by work"}: ${rec.points}h${slot.index > 0 ? `, ${standing}` : ""}${left}`);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, `Your ${banked ? "banked " : ""}work as a ${this.labelOf(rec.profession || "")} is counted: ${standing}${left}.`);
    this.syncRank(ctx, actorId, char, slot, userId);
  }

  private deposit(ctx: SystemContext, actorId: number, char: Character, slot: Slot, now: number): void {
    const rec = slot.rec;
    rec.bank += 1;
    this.settleClock(actorId, char, now);
    this.save(ctx, actorId, char);
    const waitMin = Math.max(1, Math.ceil((this.intervalMs - rec.onlineMs) / 60000));
    this.log(`[mastery] ${hex(actorId)} ${this.tagOf(slot)} hour banked (${rec.bank}/${this.bankMax}), next paid in ${waitMin} online min`);
    const whose = slot.index > 0 ? ` for your ${this.slotNameOf(slot.index)} craft` : "";
    this.notice(ctx, this.userOf(ctx, actorId), `Extra work banked${whose}: ${hoursText(rec.bank)} will be counted, one per hour you stay online.`);
  }

  // A banked hour is counted once a full interval of online time has passed since the slot's last counted hour
  private payBanks(ctx: SystemContext): void {
    const now = Date.now();
    if (!this.clocks.size || now - this.lastBankCheck < BANK_CHECK_MS) return;
    this.lastBankCheck = now;
    this.clocks.forEach((clock, actorId) => {
      try {
        const char = this.load(ctx, actorId);
        const banked = char ? this.activeSlots(char).filter((s) => s.rec.bank > 0 && !(s.index > 0 && isCapped(s.cfg!, s.rec.points))) : [];
        if (!char || !banked.length) return;
        let paid = false;
        for (const slot of banked) {
          if (slot.rec.bank > this.bankMax) slot.rec.bank = this.bankMax;
          if (slot.rec.onlineMs + now - clock.since < this.intervalMs || now - slot.rec.lastPointAt < this.intervalMs) continue;
          slot.rec.bank -= 1;
          this.countHour(ctx, actorId, char, slot, now, true);
          paid = true;
        }
        if (paid || now - clock.savedAt < BANK_SAVE_MS) return;
        this.settleClock(actorId, char, now);
        this.save(ctx, actorId, char);
      } catch (e) {
        this.log(`[mastery] bank payout failed for ${hex(actorId)}: ${e}`);
      }
    });
  }

  // Moves the online time since the clock's mark into every slot in force; the caller writes them
  private settleClock(actorId: number, char: Character, now: number): void {
    const clock = this.clocks.get(actorId);
    if (!clock) return;
    const online = Math.max(0, now - clock.since);
    for (const slot of this.activeSlots(char)) slot.rec.onlineMs += online;
    clock.since = now;
    clock.savedAt = now;
  }

  private goOffline(ctx: SystemContext, actorId: number): void {
    if (!this.clocks.has(actorId)) return;
    const char = this.load(ctx, actorId);
    if (char) {
      this.settleClock(actorId, char, Date.now());
      this.save(ctx, actorId, char);
    }
    this.clocks.delete(actorId);
  }

  disconnect(userId: number, ctx: SystemContext): void {
    this.clocks.forEach((clock, actorId) => {
      if (clock.userId === userId) this.goOffline(ctx, actorId);
    });
  }

  // A real spell cast is a mage slot's work; a higher tier than any before may lift the mage's rank cap. False for anything else.
  private noteCast(ctx: SystemContext, actorId: number, char: Character, slots: Slot[], spellId: number): boolean {
    const mage = slots.find((s) => s.rec.profession === "mage");
    if (!mage) return false;
    const info = spellInfo(ctx.svr as Mp, spellId);
    if (info.type !== SpellType.Spell) return false;
    if (info.tier > char.primary.spellTier) {
      char.primary.spellTier = info.tier;
      this.write(ctx, actorId, char.primary);
      if (this.rankOfSlot(char, mage) !== mage.rec.rank) this.syncRank(ctx, actorId, char, mage, this.userOf(ctx, actorId));
    }
    return true;
  }

  private matches(ctx: SystemContext, profession: string, rules: ResolvedRules, ev: ActivityEvent): boolean {
    switch (ev.kind) {
      case "craft": {
        const recipeId = ev.detail["recipeId"];
        const bench = this.recipeBench(ctx, recipeId);
        if (!ev.detail["held"] || !bench || this.isCommonRecipe(ctx, recipeId)) return false;
        const byKeyword = rules.craftKeywords.has(bench) || this.sharesRecipe(ctx, recipeId, profession);
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
        return profession === "mage";
      case "work":
        return PROFESSION_IDS[ev.detail["profession"]] === profession;
      default:
        return false;
    }
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  summaryOf(ctx: SystemContext, actorId: number): MasterySummary {
    const char = this.load(ctx, actorId) || this.emptyCharacter();
    const rec = char.primary;
    return {
      profession: rec.profession,
      label: rec.profession ? this.labelOf(rec.profession) : "",
      rank: rec.rank,
      rankName: RANK_NAMES[rec.rank],
      hours: rec.points,
      slots: this.slotSummaries(char),
    };
  }

  // Adds (or with a negative amount removes) one slot's worked hours; rank and marker spells follow. Null for an amount the system refuses or an empty sub-slot.
  grantPoints(ctx: SystemContext, actorId: number, amount: number, slotIndex = 0): MasterySummary | null {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GRANT) return null;
    const char = this.load(ctx, actorId, slotIndex > 0) || this.emptyCharacter();
    const slot = this.slotAt(char, slotIndex);
    if (!slot) return null;
    slot.rec.points = Math.max(0, slot.rec.points + amount);
    return this.settle(ctx, actorId, char, slot);
  }

  // Lifts the primary to the top of its ladder, and for a mage the spell tier that allows it. Null without a profession.
  grantLegendary(ctx: SystemContext, actorId: number): MasterySummary | null {
    const char = this.load(ctx, actorId);
    if (!char || !char.primary.profession) return null;
    const ladder = this.slots[0].rankHours;
    char.primary.points = Math.max(char.primary.points, ladder[ladder.length - 1]);
    char.primary.spellTier = Math.max(char.primary.spellTier, LEGENDARY - 1);
    return this.settle(ctx, actorId, char, this.slotAt(char, 0)!);
  }

  private settle(ctx: SystemContext, actorId: number, char: Character, slot: Slot): MasterySummary {
    this.save(ctx, actorId, char, slot);
    const userId = this.userOf(ctx, actorId);
    if (slot.rec.profession) this.notice(ctx, userId, `Your hours as a ${this.labelOf(slot.rec.profession)}${slot.index > 0 ? `, your ${this.slotNameOf(slot.index)} craft,` : ""} now stand at ${slot.rec.points}.`);
    this.syncRank(ctx, actorId, char, slot, userId);
    return this.summaryOf(ctx, actorId);
  }

  // Admin escape hatch: clears one slot's choice so the character may pick again; the other slots stay. False when there was nothing to clear.
  resetCharacter(ctx: SystemContext, actorId: number, slotIndex = 0): boolean {
    const char = this.load(ctx, actorId, true);
    const slot = char ? this.slotAt(char, slotIndex) : null;
    const profession = slot ? slot.rec.profession : null;
    if (!char || !slot || !profession) return false;
    const tag = this.tagOf(slot);
    const points = slot.rec.points;
    this.revokeSpells(ctx, actorId, char, slot);
    // Hours belong to the craft, so a fresh choice starts from nothing.
    if (profession === "mage") char.primary.spellTier = 0;
    const key = subKeyOf(slotIndex);
    if (key && char.subs) char.subs[key] = null;
    else Object.assign(char.primary, { profession: null, points: 0, lastPointAt: 0, rank: FREE, bank: 0, onlineMs: 0 });
    this.save(ctx, actorId, char);
    this.log(`[mastery] ${hex(actorId)} ${tag} set aside at ${points}h`);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, key
      ? `Your ${this.slotNameOf(slotIndex)} craft, the ${this.labelOf(profession)}, has been set aside. You may choose again.`
      : "Your profession has been set aside. You may choose again.");
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
    const char = this.load(ctx, actorId, true);
    const rec = char ? char.primary : null;
    if (char && rec && rec.profession) {
      if (rec.v !== RECORD_VERSION) this.migrate(ctx, actorId, char);
      const primary = this.slotAt(char, 0)!;
      const corrected = this.rankOfSlot(char, primary);
      if (corrected < rec.rank) this.revokeAbove(ctx, actorId, char, primary, corrected);
      rec.rank = corrected;
      this.write(ctx, actorId, rec);
      if (rec.bank > 0) this.log(`[mastery] ${hex(actorId)} online with ${hoursText(rec.bank)} banked, next paid in ${Math.max(1, Math.ceil((this.intervalMs - rec.onlineMs) / 60000))} online min`);
    }
    if (char && char.subs) this.settleSubs(ctx, actorId, char);
    this.sendState(ctx, actorId, userId);
    // Grants, kits and the state again wait out the client's spawn-time spell wipe
    this.pendingGrants.set(actorId, Date.now() + LOGIN_GRANT_DELAY_MS);
  }

  // Markers of the old ladder that are not markers of the new one go; the ones still wanted are granted after the login delay
  private migrate(ctx: SystemContext, actorId: number, char: Character): void {
    const rec = char.primary;
    const wanted = rec.profession ? this.spells[rec.profession] || [] : [];
    this.dropMarkers(ctx, actorId, char, rec.granted, rec.granted.filter((id) => wanted.indexOf(id) === -1));
    rec.v = RECORD_VERSION;
    this.log(`[mastery] ${hex(actorId)} migrated to the rank ladder: ${rec.profession} ${rec.points}h`);
  }

  // After the primary: a sub-slot in force whose craft a lower slot follows is dropped (one out of force is kept), ranks follow the slots in force, and markers no sub-slot in force holds go
  private settleSubs(ctx: SystemContext, actorId: number, char: Character): void {
    const subs = char.subs!;
    const before = JSON.stringify(subs);
    for (const index of duplicateSlots(this.professionsOf(char).slice(0, this.slots.length))) {
      const key = subKeyOf(index);
      const rec = key ? subs[key] : null;
      if (!key || !rec) continue;
      this.log(`[mastery] ${hex(actorId)} ${this.slotNameOf(index)} ${rec.profession} dropped at login: a lower slot already follows it`);
      subs[key] = null;
    }
    const inForce = this.activeSlots(char).filter((s) => s.index > 0);
    for (const slot of inForce) slot.rec.rank = this.rankOfSlot(char, slot);
    const wanted = new Set(inForce.flatMap((s) => (this.spells[s.rec.profession || ""] || []).slice(0, s.rec.rank)));
    const extra = subs.granted.filter((id) => !wanted.has(id));
    if (extra.length) {
      this.dropMarkers(ctx, actorId, char, subs.granted, extra);
      this.log(`[mastery] ${hex(actorId)} ${extra.length} sub-slot marker(s) revoked at login: ${extra.map((id) => hex(id)).join(", ")}`);
    }
    if (JSON.stringify(subs) !== before) this.writeSubs(ctx, actorId, subs);
    const text = this.slotSummaries(char).map((s) => (s.profession ? `${s.name} ${s.profession} ${s.rankName} ${s.hours}h` : `${s.name} empty`)).join(", ");
    const banked = inForce.filter((s) => s.rec.bank > 0).map((s) => `${this.tagOf(s)} ${hoursText(s.rec.bank)} banked`);
    this.log(`[mastery] ${hex(actorId)} slots at login: ${text}${banked.length ? `; ${banked.join(", ")}` : ""}`);
  }

  private flushPendingGrants(ctx: SystemContext): void {
    if (!this.pendingGrants.size) return;
    const now = Date.now();
    this.pendingGrants.forEach((dueAt, actorId) => {
      if (now < dueAt) return;
      this.pendingGrants.delete(actorId);
      const userId = this.userOf(ctx, actorId);
      if (userId < 0) return;
      const char = this.load(ctx, actorId);
      if (char) {
        const inForce = this.activeSlots(char);
        for (const slot of inForce) this.applySpells(ctx, actorId, char, slot);
        if (char.primary.profession) this.giveKit(ctx, actorId, userId, char.primary.profession);
        for (const slot of inForce) {
          if (slot.index > 0) this.giveSlotKit(ctx, actorId, userId, char, slot);
        }
      }
      this.sendState(ctx, actorId, userId);
    });
  }

  // The player's own reset of one craft (the primary unless a profession is named): the same as the admin one, counted against masteryResetsPerCharacter over all slots
  private onResetRequest(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastChooseMs.get(userId) || 0) < CHOOSE_COOLDOWN_MS) return;
    this.lastChooseMs.set(userId, now);
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const char = this.load(ctx, actorId);
    const named = typeof content["profession"] === "string" ? content["profession"] : "";
    const slot = !char ? null : named ? this.activeSlots(char).find((s) => s.rec.profession === named) : this.slotAt(char, 0);
    if (!char || !slot || !slot.rec.profession) return;
    if (char.primary.resets >= this.resetsPerCharacter) {
      this.notice(ctx, userId, "You have no profession resets left.");
      return;
    }
    char.primary.resets += 1;
    this.write(ctx, actorId, char.primary);
    this.resetCharacter(ctx, actorId, slot.index);
  }

  private onChoose(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastChooseMs.get(userId) || 0) < CHOOSE_COOLDOWN_MS) return;
    this.lastChooseMs.set(userId, now);
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const professionId = String(content["profession"] || "");
    if (PROFESSION_IDS.indexOf(professionId) === -1) return;

    const slotIndex = content["slot"] === undefined || content["slot"] === null ? 0 : Number(content["slot"]);
    const char = this.load(ctx, actorId, true) || this.emptyCharacter();
    const refusal = chooseRefusal(this.professionsOf(char), this.slots.length, professionId, slotIndex);
    if (refusal) {
      const holder = this.professionsOf(char).indexOf(professionId);
      if (refusal === "held" && holder >= this.slots.length) {
        this.log(`[mastery] ${hex(actorId)} ${professionId} refused as ${this.slotNameOf(slotIndex)} craft: the ${this.slotNameOf(holder)} slot keeps it while this server has no such slot`);
      }
      this.notice(ctx, userId, this.refusalText(char, refusal, slotIndex, professionId));
      return;
    }
    // Finishing creation cuts the inventory back to the starter clothes, which would take the kit with it
    if (isCreationPending(ctx.svr as Mp, actorId)) {
      this.notice(ctx, userId, "Finish creating your character before you choose a craft.");
      return;
    }
    const key = subKeyOf(slotIndex);
    if (key) (char.subs || (char.subs = emptySubs()))[key] = emptySlotRecord(professionId);
    else Object.assign(char.primary, { profession: professionId, v: RECORD_VERSION });
    const slot = this.slotAt(char, slotIndex)!;
    const cfg = this.slots[slotIndex];
    slot.rec.rank = this.rankOfSlot(char, slot);
    this.save(ctx, actorId, char, slot);
    this.applySpells(ctx, actorId, char, slot);
    this.log(`[mastery] ${hex(actorId)} took up ${professionId} as ${this.slotNameOf(slotIndex)} craft (up to ${RANK_NAMES[cfg.cap]}), ${RANK_NAMES[slot.rec.rank]} at ${slot.rec.points}h`);
    const label = this.labelOf(professionId);
    if (key) {
      const gate = slot.rec.rank === FREE ? ` It starts at Free: ${hoursText(cfg.rankHours[0])} of its free work make you a Novice.` : "";
      this.notice(ctx, userId, `You take up the craft of the ${label} as your ${this.slotNameOf(slotIndex)} craft, rising no higher than ${RANK_NAMES[cfg.cap]}.${gate}`);
      this.giveSlotKit(ctx, actorId, userId, char, slot);
    } else {
      this.notice(ctx, userId, `You take up the craft of the ${label}.`);
      this.giveKit(ctx, actorId, userId, professionId);
    }
    this.sendState(ctx, actorId, userId);
    this.sendMenu(ctx, userId);
  }

  private refusalText(char: Character, refusal: ChooseRefusal, slotIndex: number, professionId: string): string {
    switch (refusal) {
      case "taken": {
        const held = this.labelOf(this.slotAt(char, slotIndex)?.rec.profession || "");
        return slotIndex === 0 ? `You have already given yourself to the ${held}.` : `Your ${this.slotNameOf(slotIndex)} craft is already the ${held}.`;
      }
      case "held": {
        const holder = this.professionsOf(char).indexOf(professionId);
        if (holder < this.slots.length) return `You already follow the ${this.labelOf(professionId)}.`;
        const name = this.slotNameOf(holder);
        return `Your ${name} craft, the ${this.labelOf(professionId)}, is kept for when this server offers a ${name} craft again, so you cannot take it up now.`;
      }
      case "out-of-order":
        return `Choose your ${this.slotNameOf(nextEmptySlot(this.professionsOf(char), this.slots.length))} craft first.`;
      default:
        return "This server offers no such craft slot.";
    }
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
    this.handOver(ctx, actorId, kit);
    this.log(`[mastery] ${hex(actorId)} starting kit for ${professionId}: ${kit.map((i) => `${hex(i.baseId)}x${i.count}`).join(", ") || "none"}`);
    if (kit.length) this.notice(ctx, userId, `The ${this.labelOf(professionId)}'s starting kit is in your pack.`);
  }

  // A sub-slot's kit items, never gold, once per craft per character; none for the craft whose kit the primary pick already gave
  private giveSlotKit(ctx: SystemContext, actorId: number, userId: number, char: Character, slot: Slot): void {
    const profession = slot.rec.profession || "";
    if (!this.slotKits || !char.subs || !profession || char.subs.kits.indexOf(profession) !== -1) return;
    let primaryKit = "";
    try { primaryKit = String((ctx.svr as Mp).get(actorId, KIT_PROP)?.profession || ""); } catch { return; }
    char.subs.kits.push(profession);
    if (!this.writeSubs(ctx, actorId, char.subs)) return;
    const kit = primaryKit === profession ? [] : this.kits[profession] || [];
    this.handOver(ctx, actorId, kit);
    this.log(`[mastery] ${hex(actorId)} ${this.slotNameOf(slot.index)} kit for ${profession}: ${kit.map((i) => `${hex(i.baseId)}x${i.count}`).join(", ") || (primaryKit === profession ? "none, the primary kit was this craft's" : "none")}`);
    if (kit.length) this.notice(ctx, userId, `The ${this.labelOf(profession)}'s kit is in your pack.`);
  }

  private handOver(ctx: SystemContext, actorId: number, kit: KitItem[]): void {
    for (const item of kit) {
      try {
        addItemTo(ctx.svr as Mp, actorId, item.baseId, item.count);
      } catch (e) {
        this.log(`[mastery] kit item ${hex(item.baseId)} failed for ${hex(actorId)}: ${e}`);
      }
    }
  }

  // ── Menu and state ──────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number): void {
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const char = this.load(ctx, actorId) || this.emptyCharacter();
    const rec = char.primary;
    this.send(ctx, userId, {
      customPacketType: "masteryMenu",
      profession: rec.profession,
      rank: rec.rank,
      hours: rec.points,
      rankHours: [0].concat(this.slots[0].rankHours),
      resetsLeft: Math.max(0, this.resetsPerCharacter - rec.resets),
      professions: PROFESSIONS.map(({ id, label, title, type, blurbs }) => ({ id, label, title, type, blurbs })),
      slots: this.slotSummaries(char),
    });
  }

  // Every mapped skill at the Free level, each slot's own at its rank level (the best slot wins); magicka as magickaOf says
  private sendState(ctx: SystemContext, actorId: number, userId: number): void {
    if (userId < 0) return;
    const char = this.load(ctx, actorId) || this.emptyCharacter();
    const inForce = this.activeSlots(char);
    const skills: Record<string, number> = {};
    for (const skill of ALL_SKILLS) skills[skill] = RANK_SKILL[FREE];
    for (const slot of inForce) {
      const own = PROFESSIONS.find((p) => p.id === slot.rec.profession);
      for (const skill of own ? own.skills : []) skills[skill] = Math.max(skills[skill], RANK_SKILL[slot.rec.rank]);
    }
    const rec = char.primary;
    this.send(ctx, userId, {
      customPacketType: "professionState",
      profession: rec.profession,
      rank: rec.rank,
      rankName: RANK_NAMES[rec.rank],
      hours: rec.points,
      skills,
      magicka: this.magickaOf(ctx, actorId, inForce),
      slots: this.slotSummaries(char),
    });
  }

  // A mage slot of Novice or better sets base magicka by rank and anyone else is held at the race's base, both with the race's bonus; null in creation
  private magickaOf(ctx: SystemContext, actorId: number, inForce: Slot[]): number | null {
    const mage = inForce.find((s) => s.rec.profession === "mage" && s.rec.rank >= NOVICE);
    if (isCreationPending(ctx.svr as Mp, actorId)) return mage ? MAGE_MAGICKA[mage.rec.rank] : null;
    const bonus = this.racial ? this.racial.baseBonus(actorId).magicka : 0;
    if (mage) return MAGE_MAGICKA[mage.rec.rank] + bonus;
    return this.racial ? MAGE_MAGICKA[FREE] + bonus : null;
  }

  // Every configured slot, empty ones included
  private slotSummaries(char: Character): SlotSummary[] {
    return this.slots.map((cfg, index) => {
      const slot = this.slotAt(char, index);
      const profession = slot ? slot.rec.profession : null;
      const rank = slot ? slot.rec.rank : FREE;
      return {
        slot: index,
        name: cfg.name,
        profession,
        label: profession ? this.labelOf(profession) : "",
        rank,
        rankName: RANK_NAMES[rank],
        hours: slot ? slot.rec.points : 0,
        cap: cfg.cap,
        capName: RANK_NAMES[cfg.cap],
        rankHours: [0].concat(cfg.rankHours),
      };
    });
  }

  // ── Ranks and marker spells ─────────────────────────────────────────────────

  // Rank a slot's hours earn on its ladder: the primary is a Novice from the choice, a sub-slot starts Free; a mage rises past Adept only one rank above the best spell tier cast
  private rankOfSlot(char: Character, slot: Slot): number {
    if (!slot.rec.profession || !slot.cfg) return FREE;
    let rank = slotRankFor(slot.cfg, slot.rec.points);
    if (slot.index === 0) rank = Math.max(NOVICE, rank);
    if (slot.rec.profession === "mage") rank = Math.min(rank, Math.max(ADEPT, char.primary.spellTier + 1));
    return rank;
  }

  // Rank follows points and the marker spells follow rank, both ways.
  private syncRank(ctx: SystemContext, actorId: number, char: Character, slot: Slot, userId: number): void {
    const oldRank = slot.rec.rank;
    const newRank = this.rankOfSlot(char, slot);
    if (newRank < oldRank) this.revokeAbove(ctx, actorId, char, slot, newRank);
    slot.rec.rank = newRank;
    this.save(ctx, actorId, char, slot);
    this.applySpells(ctx, actorId, char, slot);
    this.sendState(ctx, actorId, userId);
    const profession = slot.rec.profession;
    if (newRank === oldRank || !profession) return;
    const label = this.labelOf(profession);
    this.log(`[mastery] ${hex(actorId)} ${this.tagOf(slot)} ${RANK_NAMES[oldRank]} -> ${RANK_NAMES[newRank]} at ${slot.rec.points}h`);
    const name = this.slotNameOf(slot.index);
    if (slot.index === 0) {
      this.notice(ctx, userId, newRank > oldRank
        ? `You are now ${RANK_NAMES[newRank]} of the ${label}.`
        : `Your standing has fallen to ${RANK_NAMES[newRank]} of the ${label}.`);
    } else {
      this.notice(ctx, userId, newRank > oldRank
        ? `You are now a ${RANK_NAMES[newRank]} of the ${label}, your ${name} craft.`
        : `Your ${name} craft has fallen to ${RANK_NAMES[newRank]} of the ${label}.`);
    }
  }

  // Marker list index 0 is Novice, so a slot holds the first `rank` of them.
  private missingSpells(slot: Slot): number[] {
    const list = slot.rec.profession && slot.cfg ? this.spells[slot.rec.profession] : null;
    if (!list) return [];
    return list.slice(0, slot.rec.rank).filter((spellId) => spellId && slot.granted.indexOf(spellId) === -1);
  }

  // The plugin's recipes condition on the exact rank they belong to, so a Master still needs the Novice marker.
  private applySpells(ctx: SystemContext, actorId: number, char: Character, slot: Slot): void {
    const missing = this.missingSpells(slot);
    if (!missing.length) return;
    for (const spellId of missing) {
      this.addSpell(ctx, actorId, spellId);
      slot.granted.push(spellId);
    }
    this.save(ctx, actorId, char, slot);
  }

  private revokeAbove(ctx: SystemContext, actorId: number, char: Character, slot: Slot, keepRank: number): void {
    const list = slot.rec.profession ? this.spells[slot.rec.profession] : null;
    if (list) this.dropMarkers(ctx, actorId, char, slot.granted, list.slice(keepRank));
  }

  // A primary reset drops every marker it lists, old ladders included; a sub-slot only its own craft's
  private revokeSpells(ctx: SystemContext, actorId: number, char: Character, slot: Slot): void {
    this.dropMarkers(ctx, actorId, char, slot.granted, slot.index === 0 ? slot.granted.slice() : this.spells[slot.rec.profession || ""] || []);
  }

  // Takes markers off a slot list; the spell itself stays while the other list still holds it
  private dropMarkers(ctx: SystemContext, actorId: number, char: Character, list: number[], ids: number[]): void {
    const other = list === char.primary.granted ? (char.subs ? char.subs.granted : []) : char.primary.granted;
    for (const spellId of ids) {
      const at = list.indexOf(spellId);
      if (!spellId || at === -1) continue;
      list.splice(at, 1);
      if (other.indexOf(spellId) === -1) this.removeSpell(ctx, actorId, spellId);
    }
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

  // Rank of a character in the given profession, Free (0) when no slot follows it.
  rankOf(ctx: SystemContext, actorId: number, professionId: string): number {
    return this.rankIn(ctx, actorId, [professionId]);
  }

  // Best rank of the slots that follow one of the professions, Free otherwise.
  rankIn(ctx: SystemContext, actorId: number, professionIds: string[]): number {
    return bestSlot(this.heldSlots(ctx, actorId), professionIds)?.rank ?? FREE;
  }

  // Best rank of the slots whose profession works this bench keyword, Free otherwise.
  craftRank(ctx: SystemContext, actorId: number, benchKeyword: number): number {
    return this.craftSlot(ctx, actorId, benchKeyword).rank;
  }

  // The slot that prices work at this bench keyword: its rank and profession, Free and null when none works it
  craftSlot(ctx: SystemContext, actorId: number, benchKeyword: number): { rank: number; profession: string | null } {
    const best = bestSlot(this.heldSlots(ctx, actorId), this.benchProfessions(benchKeyword));
    return { rank: best ? best.rank : FREE, profession: best ? best.profession : null };
  }

  // The rank that prices a craft, the profession it belongs to and whether it costs half; shared recipes take the best of their
  // professions, any other the best slot that works the bench and qualifies for the recipe's rank gates
  craftCost(ctx: SystemContext, actorId: number, recipeId: number): { rank: number; half: boolean; profession: string | null } {
    const bench = this.recipeBench(ctx, recipeId);
    const edid = this.baseInfo(ctx, recipeId)?.editorId || "";
    const shared = SHARED_RECIPES.find(([prefix]) => edid.startsWith(prefix));
    const held = this.heldSlots(ctx, actorId);
    const best = shared ? bestSlot(held, shared[1]) : bestSlot(held, this.benchProfessions(bench), this.recipeGates(ctx, recipeId));
    const product = this.baseInfo(ctx, espmFieldFormIds(this.lookup(ctx, recipeId), "CNAM")[0] || 0)?.editorId || "";
    return { rank: best ? best.rank : FREE, half: this.halfCostBench(bench) || HALF_COST_PRODUCTS.has(product.toLowerCase()), profession: best ? best.profession : null };
  }

  // Professions whose recipe or station keywords include this bench keyword
  private benchProfessions(benchKeyword: number): string[] {
    const k = benchKeyword >>> 0;
    return PROFESSION_IDS.filter((id) => this.rules[id] && (this.rules[id].craftKeywords.has(k) || this.rules[id].craftStations.has(k)));
  }

  // The rank markers a recipe's HasSpell conditions require, an OR group when several; cached
  private recipeGates(ctx: SystemContext, recipeId: number): RecipeGate[] {
    const hit = this.gateCache.get(recipeId);
    if (hit) return hit;
    const out = hasSpellConditions(ctx.svr as Mp, recipeId).map((id) => this.markers.get(id >>> 0)).filter((g): g is RecipeGate => !!g);
    this.gateCache.set(recipeId, out);
    return out;
  }

  // Ungated recipes per bench, the free work a Free sub-slot counts; a boot check against the multiclass design's table
  private async logFreeRecipes(ctx: SystemContext, dataDir: string, loadOrder: string[]): Promise<void> {
    const started = Date.now();
    const mp = ctx.svr as Mp;
    const ids = new Set<number>();
    await scanRecords(dataDir, loadOrder, ["COBJ"], this.log, (rec) => {
      try { ids.add(mp.getIdFromDesc(espmDesc(rec.formId, rec.masters, rec.owner)) >>> 0); } catch { /* not loaded */ }
    });
    const counts = new Map<string, number>();
    for (const id of ids) {
      const bench = this.recipeBench(ctx, id);
      if (!bench || !this.benchProfessions(bench).length || this.isCommonRecipe(ctx, id) || this.recipeGates(ctx, id).length) continue;
      const name = this.baseInfo(ctx, bench)?.editorId || hex(bench);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const text = Array.from(counts).sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => `${name} ${n}`).join(", ");
    this.log(`[mastery] free recipes by bench: ${text || "none"} (${ids.size} recipes read in ${Date.now() - started} ms)`);
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
        granted: idList(r.granted),
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

  private readSubs(ctx: SystemContext, actorId: number): SubSlots | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, SLOTS_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      const isProfession = (id: string) => PROFESSION_IDS.indexOf(id) !== -1;
      return {
        v: Number(r["v"]) || 0,
        secondary: toSlotRecord(r["secondary"], isProfession),
        tertiary: toSlotRecord(r["tertiary"], isProfession),
        granted: idList(r["granted"]),
        kits: stringList(r["kits"]),
      };
    } catch {
      return null;
    }
  }

  private writeSubs(ctx: SystemContext, actorId: number, subs: SubSlots): boolean {
    subs.v = SLOTS_VERSION;
    try {
      (ctx.svr as Mp).set(actorId, SLOTS_PROP, subs);
      return true;
    } catch (e) {
      this.log(`[mastery] sub-slot write failed for ${hex(actorId)}: ${e}`);
      return false;
    }
  }

  // Both records; the sub-slots are read while multiclassing is on or when forced (login, picks, resets, admin sub-slot grants). Null when neither exists.
  private load(ctx: SystemContext, actorId: number, forceSubs = false): Character | null {
    const primary = this.read(ctx, actorId);
    const subs = forceSubs || multiclassOn(this.slots) ? this.readSubs(ctx, actorId) : null;
    return primary || subs ? { primary: primary || emptyRecord(), subs } : null;
  }

  // Writes the record that holds the slot, or both
  private save(ctx: SystemContext, actorId: number, char: Character, only?: Slot): void {
    if (!only || only.index === 0) this.write(ctx, actorId, char.primary);
    if (char.subs && (!only || only.index > 0)) this.writeSubs(ctx, actorId, char.subs);
  }

  private emptyCharacter(): Character {
    return { primary: emptyRecord(), subs: null };
  }

  // The primary always, a sub-slot only when filled
  private slotAt(char: Character, index: number): Slot | null {
    if (index === 0) return { index, cfg: this.slots[0], rec: char.primary, granted: char.primary.granted };
    const key = subKeyOf(index);
    const rec = key && char.subs ? char.subs[key] : null;
    return rec && char.subs ? { index, cfg: this.slots[index] || null, rec, granted: char.subs.granted } : null;
  }

  // Filled slots the settings configure, primary first
  private activeSlots(char: Character): Slot[] {
    return SLOT_NAMES.map((_, i) => this.slotAt(char, i)).filter((s): s is Slot => !!s && !!s.rec.profession && !!s.cfg);
  }

  private professionsOf(char: Character): Array<string | null> {
    return SLOT_NAMES.map((_, i) => this.slotAt(char, i)?.rec.profession || null);
  }

  private heldSlots(ctx: SystemContext, actorId: number): HeldSlot[] {
    const char = this.load(ctx, actorId);
    return char ? this.activeSlots(char).map((s) => ({ profession: s.rec.profession, rank: s.rec.rank })) : [];
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private labelOf(professionId: string): string {
    const p = PROFESSIONS.filter((x) => x.id === professionId)[0];
    return p ? p.label : professionId;
  }

  // "secondary", as the texts and log lines name a slot
  private slotNameOf(index: number): string {
    return (this.slots[index]?.name || SLOT_NAMES[index] || `slot ${index + 1}`).toLowerCase();
  }

  // Log tag: the profession for the primary, "secondary tailor" for a sub-slot
  private tagOf(slot: Slot): string {
    return slot.index > 0 ? `${this.slotNameOf(slot.index)} ${slot.rec.profession}` : String(slot.rec.profession);
  }

  // "7 of 20 hours toward Novice" below a sub-slot's cap, "52 hours at the craft" otherwise
  private standingText(slot: Slot): string {
    const next = slot.index > 0 && slot.cfg ? hoursToNext(slot.cfg, slot.rec.points) : null;
    return next ? `${slot.rec.points} of ${hoursText(next.at)} toward ${RANK_NAMES[next.rank]}` : `${hoursText(slot.rec.points)} at the craft`;
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
  // Configured slots in pick order; one slot is multiclassing off
  private slots: SlotConfig[] = defaultSlots(DEFAULT_RANK_HOURS);
  private slotKits = true;
  private racial: MagickaBonusSource | null = null;
  // Rank marker spell -> the profession and rank it stands for
  private markers = new Map<number, RecipeGate>();
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
  private gateCache = new Map<number, RecipeGate[]>();
  private inputCache = new Map<number, Array<{ baseId: number; count: number }>>();
  private baseCache = new Map<number, BaseInfo | null>();
  private keywordCache = new Map<number, Set<number>>();
}
