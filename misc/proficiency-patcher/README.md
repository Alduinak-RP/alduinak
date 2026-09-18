# proficiency-patcher

Rewrites `AlduinakAdditions.esp` with the proficiency (mastery) content: the rank marker abilities, the crafting
keywords, the alchemy labs turned into crafting stations, the woodcrafting bench, the potion and charcoal
recipes, the tier conditions on every cooking, smithing and tailoring recipe in the server
load order, the routing of forge recipes to the bench their materials come from, and the writing items (blank and written letters, journals and books, sealing wax) with their recipes. `spec.json` is the design; the program only resolves editor ids and writes records.

It is re-runnable: run it again on a fresh plugin from the Creation Kit and the same records come back
(records are found by editor id, overrides by the record they override).

## Run

The input is the merged base of the r7 pipeline, never the live plugin. `misc/esp-merge/proficiency.py`
is step 3 of that pipeline and runs the command below, then checks the result against the ids LIVE
shipped:

```bash
python misc/proficiency-patcher/patch.py --plugin <r7 work/base>/AlduinakAdditions.esp --settings <r7 server-settings.stage.json> --out <dir> --next-form-id 0x201D
```

`--next-form-id` pins the own records to the block at `0x201D` so the marker spell ids never move, and
it refuses a plugin that already holds them ("own records already use ..."): the live plugin does, and
`patch.py`'s pre-clean only drops duplicate LAND records, it does not strip the generated layer. Running
against the live plugin without the pin is a hotfix route only. Every record is still found by editor id
and reused, so nothing moves, but a record the spec adds would take the plugin's own next form id rather
than the next id in the pinned block.

Needs the .NET 9 SDK (`dotnet`), Python 3 and the game Data folder named by `dataDir` in the settings
file, with every plugin of `loadOrder` present (Mutagen reads them to resolve editor ids and winning
records). The first run restores the Mutagen NuGet package.

`patch.py`:

1. writes `AlduinakAdditions.preclean.esp`, the input minus a duplicate LAND record the Creation Kit left in
   one Windhelm exterior cell (the game keeps the last one, Mutagen refuses to load two);
2. runs the C# patcher, which writes `AlduinakAdditions.esp`, `proficiency-report.md` (every record it
   created or changed, per tier) and `proficiency-ids.json` (the marker spells with their global form ids);
3. verifies the output against the pre-cleaned input with `misc/esplib.py`: only KYWD, SPEL, MGEF, FURN,
   COBJ, BOOK and MISC records may be added or changed, plus the `AldMeadBench_` references and the overrides of
   the cells `meadery` names, the ENCH overrides `enchantmentMagnitudes` names by editor id and the REFR overrides
   `placements` names by form key; everything else must be byte-identical up to Mutagen's known
   normalisations (`-0.0` floats, deleted records without subrecords). A changed master list renumbers every
   form id, so records are then matched by editor id and compared structurally. Exit code 3 on any other
   difference, and `verify.txt` lists it.

## AlduinakCreations.esp

The settings `loadOrder` must carry the four plugins of `spec.json` `creations.plugins` right after `Dragonborn.esm`, in
`Skyrim.ccc` order: Fish, SurvivalMode, Curios, AdvDSGS (`misc/esp-merge/stage.py` stages them so). The same run then
also writes `AlduinakCreations.esp`, `creations-report.md` and, through `patch.py`, `verify-creations.txt` and
`AlduinakCreations.inputs.json`. A load order with only some of them is refused, and so is one with none of them unless
`--no-creations` is passed to `patch.py`, which builds `AlduinakAdditions.esp` alone (byte-identical to a full run).
`AlduinakCreations.esp` may appear last in the settings `loadOrder` or be absent: the run never reads it.

**Rebuild it whenever any plugin before it changes.** It copies whole CELL and WRLD records (626 cells, 14 worldspaces
today, including Riverwood, Riften, Dawnstar and Solitude), 87 references, 4 navmeshes and other reverted records from
their winner at build time, `AlduinakAdditions.esp` included, and it loads last, so a stale copy silently undoes a later
edit of Graves's plugin or a city mod. `verify_creations.py` writes `AlduinakCreations.inputs.json` after a clean check:
the plugin's sha256 and the name and sha256 of every plugin loaded before it except the five vanilla masters, in order.
From r12 the esp-merge pipeline folds this plugin into `AlduinakAdditions.esp` at step 4c, so only one plugin ships and
`AlduinakCreations.esp` is an intermediate of `work/prof`. Step 5 turns its inputs file into
`AlduinakAdditions.inputs.json`: the same list without the entry for `AlduinakAdditions.esp` itself, pinned to the merged
plugin. That file ships next to the plugin in the MO2 mod, and `skymp5-backend/scripts/compile-manifest.js` (manager
"Update manifest") refuses to publish a manifest whose plugins before `AlduinakAdditions.esp` differ from it by name,
order or sha256, or where the plugin is not the last enabled one; the file itself is never installed.

- `AlduinakAdditions.esp` is built from a load order without the Creations, so it gains no Creation Club master and
  stays byte-identical to a run without them (checked 2026-09-16: 35c9db43 both ways on r7's merged base). Its full
  slot, and so `proficiency-ids.json`, moves from `0x2B` to `0x2D`; `misc/esp-merge/proficiency.py` expects that shift.
- `AlduinakCreations.esp` is ESL-flagged and holds overrides only, so it takes no full slot and shifts nothing. It
  masters the Creations and `AlduinakAdditions.esp` (for the rank markers) and loads last. Merged in at step 4c its
  records keep their form ids, `AlduinakAdditions.esp` hard-masters the four Creation plugins, and the full slot stays
  `0x2D`: dropping an ESL plugin that loaded after it moves no slot.
- The Creation Club plugins are localized. Every DLC master keeps its strings in `Skyrim - Interface.bsa`, where
  Mutagen only looks for `Skyrim.esm`'s, so the program extracts that archive's strings to a temp folder first.
  The dataDir must hold the four Creation BSAs as well as their plugins.

| Key | Effect |
|---|---|
| `creations.globals` | GLOB values pinned: Survival never switches on and its prompt never shows (its `DOBJ` keys `SRVE`, `SRVS`, `SRVT` point at these globals; no vanilla default object is changed, so the `DOBJ` itself is kept). |
| `creations.stageAbilities` | The hunger and exhaustion stage abilities the server grants lose their `...ImodEffect` screen effect. |
| `creations.revertTypes` | A Creation edit of a master record of these types is replaced by the record as it wins without the Creations. |
| `creations.keepTypes` | Creation edits kept: `ALCH` (the Survival hunger effects the server reads), `DOBJ`, `NAVI` (overridden later by `AlduinakAdditions.esp` anyway). An edit of a type in neither list fails the run. |
| `creations.keepEdits` | Editor ids of Creation edits kept although their type is in `revertTypes`: Survival's four `Survival_FoodRestoreHunger*` magic effects, whose `Survival_HungerRestoreEffectScript` `AmountToRestore` global is where the server reads what a food restores (the `Update.esm` records carry no script). Their `Survival_ModeEnabled == 1` condition keeps the script from running in game. |
| `creations.foodHunger` | Hunger values for every food, written as ALCH overrides (see below). `effectPrefix` names the hunger effects, `effects` the effect of each category, `surveyedOrigins` the plugins Survival went through (their foods without an effect stay without one), `drinkSounds`, `bowlSounds`, `bowlMinWeight` and `snackMaxWeight` the category rule. |
| `creations.recipes` | `cooking`, `smithing`, `uncraftable` sections laid over the root spec for the Creation recipes only; `smithing.materials` adds to the root table. |

Besides the keys, every run clears Start Game Enabled on each Creation quest, neutralises every Creation story manager
branch and quest node and every loading screen (a single `GetRandomPercent < 0` condition), and sets Initially Disabled
without an enable parent on every reference a Creation places. Cells and worldspaces it touches carry the fields of
their winner without the Creations, so no later city mod edit is undone.

**Food hunger.** Two passes over the winning ingestibles, reported in `creations-report.md` and listed in
`creations-food-hunger.md`:
1. **Forwarding.** A food a Creation gives a hunger effect (Survival's 115 overrides and 12 soups, Fishing's 47 foods)
   whose winner lacks one, because a later plugin overrides it, gets the Creation's effect entries appended to a copy
   of that winner, so every other change of the winner stays.
2. **Categories.** A winning ALCH with the Food Item flag, without the Poison flag and without a hunger effect, whose
   record comes from a plugin outside `surveyedOrigins` (mod and Creation Club foods Survival never saw), gets one
   effect by Survival's own categories, in this order: a consume sound in `drinkSounds` is a drink, VerySmall like
   every Survival drink; a model shared with a food that carries exactly one hunger effect takes that food's category
   (the first such food in load order, then form id, so `Bread01A.nif` follows `FoodBread01A`); a consume sound in
   `bowlSounds` at `bowlMinWeight` or more is a stew, Large; `snackMaxWeight` or less is a snack, Small; anything else
   is a meal, Medium. Ingredients (INGR) never get one, as in Survival.

`verify_creations.py` re-reads every plugin with `misc/esp-merge/fastesp.py` and checks each record against its source:
placed references differ only by the flag and the enable parent, reverted records equal the winner without the
Creations (Mutagen's subrecord order, `-0.0` and `XPRM` rounding aside), quests only lose the flag, and every live
Creation reference, start-game quest, loading screen and story manager node is covered. Food overrides must be the
winner with only hunger effect entries appended, the forwarded ones exactly the Creation's and the assigned one the
category its own restatement of the rule gives; every food either pass should reach must carry its effect in the final
order, every `keepEdits` record must win as the Creation edit and every stage ability must be overridden.

## What the spec describes

| Key | Effect |
|---|---|
| `professions`, `ranks` | One Ability spell `AldMastery_<Profession>_<Rank>` per pair. The server grants them by rank; recipes carry `HasSpell` conditions on them. A recipe's `tier` is one of the four ranks or `Anyone`, the only tier that writes no condition: Novice is a real gate, so a character outside the profession makes nothing of it. |
| `abilities` | Vanilla perks (`MagicEffect.PerkToApply`) and a flat stamina bonus carried by a rank's ability. A perk with `untilRank` switches off once that higher marker is held, so ranked perks do not stack. |
| `items` | The plugin's own carryable items: a new MISC copied from `template`, with `name`, `value`, `weight`, an optional `model` and an optional `formId` pinning its local id (the hoe, `0x2100`, which `skymp5-client` names in its emote wheel). |
| `keywords` | `AldCraftingAlchemy`, `AldCraftingKiln`, `AldCraftingWoodcrafting`: the bench keywords of the new recipes. |
| `alchemyLabs` | FURN records switched from the alchemy menu to the crafting menu with the alchemy keyword. |
| `alchemy.recipes` | Potion, poison and salt recipes at the alchemy keyword. |
| `kilnRecipes` | The charcoal recipe. `bench` names the keyword it sits on (`CraftingSmelter`); `keywords.kiln` is the fallback and waits for a kiln mod carrying `AldCraftingKiln`. An entry without `profession` is a common recipe: it must be `Anyone` and named `AldRecipeCommon_*`, any character makes it, and the server's mastery system credits no hours for that prefix. The lute, flute, drum and broom (Woodcrafting Bench) and the two war horns (forge) are common recipes, reported under `common`. |
| `woodcraftingBench` | A new FURN copied from the Hearthfire carpenter's workbench, plus existing benches that also get the woodcrafting keyword. |
| `cooking` | Vanilla cooking recipes keep their benches; `needsSalt` adds a Salt Pile where it is missing; `tiers` sets the rank, Novice where it says nothing, so steaks and fish are the cook's and the five open dishes are listed under `Anyone`. |
| `stripConditions` | CTDA functions `CraftService` has no implementation for. Every recipe the patcher tiers loses them, so the menu and the server agree; an unregistered function answers true server-side. |
| `benchRouting` | Which bench a recipe at one of the `from` benches belongs at. A `products` rule claims a recipe by what it makes (`kinds`, `keywords`): bows, arrows, bolts and shields are the woodworker's whatever they are made of. Otherwise the first `materials` rule whose `items` or `itemKeywords` appear among the inputs wins: ore and the metals smelted from it `keep` the recipe at its forge, leather and pelts send it to the tanning rack and firewood to the woodcrafting bench. A recipe that takes a finished piece of gear and gives another (the closed helmets, the silver upgrades) is a conversion and stays; anything else makes nothing of ore and is parked on the `uncraftable` bench. The rule also names the profession whose ranks gate the recipe, and the one a temper entry asks for. |
| `smithing` | Every recipe at the smithing benches is routed by `benchRouting` and tiered by the highest `materials` entry among its inputs and product, under the profession the route names. `temperBenches` tiers the armour table and the grindstone by the same table, keeping their vanilla conditions. `newRecipes` adds recipes of the plugin's own (the woodcutter's axe). |
| `uncraftable` | Recipes parked on a keyword no furniture carries, so nothing can ever make them: the 20 Daedric recipes, the 105 faction, guild and one-off pieces (hold guard, Stormcloak, Thieves Guild, Dark Brotherhood, Forsworn, Skaal, Companions, Dawnguard armour, Morag Tong, Penitus Oculatus, and the named unique items) that `stripConditions` would otherwise expose, and the owner's 105 launch hides (every Imperial recipe, Bonemold, Chitin, Silver, Titus Mede I, Vampire Royal, Vvardenfell Glass, the Velothi Morag Tong sets, the +40 unarmed Moon Monk gauntlets and the closed-helmet conversions of unique and faction helmets). Runs after `woodworking`, so it also parks the Imperial shields and bow moved there. |
| `meadery` | The mead benches: `keyword` (`AldCraftingMead`, shared) and one keyword per bench, a FURN per bench copied from `template` with `removeKeywords` swapped for both keywords, its Novice `recipe` at its own keyword (`AldRecipeMead_<output>`), and one persistent `AldMeadBench_<boiler>` reference per `placements` entry (`pos`, `rotZ` in degrees) in an override of `cell`, refused further than 256 units from its `boiler`. `drinks` are the recipes brewed at any boiler, on the shared keyword (ale, wine and Nord mead, moved off the alchemy table); every drink is `Anyone`. `honey` is the Bee Honeycomb recipe, at the cooking pot (`AldRecipeCook_FoodHoney`) and at the alchemy bench, both `Anyone`. |
| `benchMoves` | Existing recipes moved to another bench keyword with their tier kept. `recipes` names them, and `match` claims any recipe at one of the `from` benches by its editor id, product editor id or product name, skipping parked ones. The Skyforge move takes the Steel Plate, Nord Hero and Nordic Carved sets, which is all it then offers. A named recipe may not also be `uncraftable`. The report notes every furniture still carrying the keyword. |
| `benchKeywordRemovals` | Bench keywords taken off existing furniture by editor id (the Skyforge keyword off the Riften Extension North and Mammoth Manor anvils, so the Whiterun Skyforge is the only one). A missing bench is a warning. |
| `enchantmentMagnitudes` | One effect's magnitude on an enchantment (the Travelling Merchant Backpack's Fortify Carry Weight, 60). `armors` must be every winning ARMO and WEAP carrying it, otherwise the step refuses, and `enchantment` must be its editor id. |
| `placements` | A placed reference (`ref`, a form key) moved to its `anchor`'s winning position plus the offset the defining plugin had between the two (the Windhelm Gray Quarter gate door back in the arch WindhelmSSE.esp moved). Refused when either record was rotated since. The override joins the plugin's own cell and world groups when it already has them. |
| `factions` | The gear only a faction's own may make. One Ability marker `AldFaction_<id without punctuation>` per `list` entry, and a `HasSpell` condition on every recipe at the `benches` whose editor id, product editor id or product name matches: `match` (any of), `all` (every one of, for the hold guards) and `except`. The game's own factions mean nothing here, so `skymp5-server/ts/systems/factionCraftSystem.ts` grants and revokes the markers from the backend roster. A recipe a rule claims is dropped from `uncraftable`: it is gated by membership now, not hidden. |
| `racial` | The gear only one people may make. A recipe at one of the `benches` whose editor id, product editor id or product name contains one of a rule's `match` strings and none of its `except` strings gains that rule's races as one `GetIsRace` OR group after the rank condition. `GetIsRace` is one of the functions `CraftService` implements, so the crafting menu and the server agree. Dwarven is in no rule: anyone may make it. |
| `craftingCategories` | The filter tabs the CraftingCategories SKSE plugin draws. It matches keywords on the created object, so each category is a keyword of the plugin's own added to every item a bench's recipes make. A `groups` entry names a `bench` and its `categories` in order; the first whose `slots` (biped slot numbers), `kinds` (`ammo`), `keywords`, `items` and `match` (editor id substrings) all hold takes the item, and a category with no test at all is the fallback. The run writes `CraftingCategories/<file>` next to the plugin; it is installed as `SKSE/Plugins/CraftingCategories/<file>` in the Alduinak mod, beside the plugin, and the manifest has to carry it. |
| `writing` | Keywords `AldWritable` (written items) and `AldWritingBlank` (blanks); `books` are new BOOK records copied from vanilla notes with their scripts and teaching removed, a new name, description text, value and weight; `misc` adds Sealing Wax; `recipes` puts the blanks on the tanning rack and the wax on the smelter, all Novice. The server finds every record by editor id (`docs/docs_roleplay_writing.md`). |
| `tailoring` | Every winning recipe at the `benches` (the tanning rack and the loom) is the tailor's, Novice unless `tiers` says otherwise; `tiers.Anyone` is the open list (cloaks and capes, and the coarsest everyday clothing). `recipes` is the owner's list, correcting ingredients, bench and tier by editor id, and may name a recipe at any bench. `disableRecipes` parks recipes on the `MothNest1` keyword, the plugin's convention for a hidden recipe (the bog blight masks, the five tanning-rack twins of the +40 unarmed Moon Monk gauntlets and the children's clothes). The sweep reads the load order, so a recipe `benchRouting` moved to the rack keeps the tier the smithing step gave it. |

Tier conditions are `HasSpell(AldMastery_<Profession>_<Rank>) == 1`, Run On Subject; a recipe tiered `Anyone` carries none. The server evaluates
the same condition in `CraftService`, which is why perks are never used (see `docs/docs_roleplay_mastery.md`).

## After a run

- The output plugin must reach the server Data folder, `C:/MO2/mods/Alduinak`, `build/dist/client/Data` and
  the install manifest together (Server Manager "Update manifest", "Sync Data", "Build Client").
- `CraftingCategories/AlduinakAdditions.json` goes to `C:/MO2/mods/Alduinak/SKSE/Plugins/CraftingCategories/` and
  into the manifest with it. Without it the category keywords are inert and the crafting menu looks as it did.
- The server reads the plugin once at startup: restart the game service.
- `proficiency-ids.json` holds the global ids the live `server-settings.json` needs for
  `damageMultConditionalFormulaSettings` (the hunter's Over Draw rule); `masterySpells` needs nothing, the
  server finds the markers by editor id.
- The master list grows to every plugin whose recipes are gated (see `proficiency-report.md`); those plugins
  become hard dependencies of `AlduinakAdditions.esp`.
