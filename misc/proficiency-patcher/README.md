# proficiency-patcher

Rewrites `AlduinakAdditions.esp` with the proficiency (mastery) content: the rank marker abilities, the crafting
keywords, the alchemy labs turned into crafting stations, the woodcrafting bench, the potion and charcoal
recipes, the tier conditions on every cooking, smithing and tailoring recipe in the server
load order, the routing of forge recipes to the bench their materials come from, and the writing items (blank and written letters, journals and books, sealing wax) with their recipes. `spec.json` is the design; the program only resolves editor ids and writes records.

It is re-runnable: run it again on a fresh plugin from the Creation Kit and the same records come back
(records are found by editor id, overrides by the record they override).

## Run

The plugin is patched in place, as one hotfix run on a frozen copy of the live plugin:

```bash
python misc/proficiency-patcher/patch.py --plugin <copy of the live AlduinakAdditions.esp> --settings build/dist/server/server-settings.json --out <dir> --no-creations --hotfix --stage
```

- `--stage` writes `<out>/settings.stage.json`, the `--settings` file with `loadOrder` cut after
  `AlduinakAdditions.esp`: `DynDOLOD.esp` and `Occlusion.esp` load after it and would leak their records into
  the winners. `DynDOLOD.esm` loads before it and stays, and so do the Creation Club plugins. The load order
  reads the plugin from `dataDir`, so the run stops with exit code 5 unless `<dataDir>/AlduinakAdditions.esp`
  is the same file as `--plugin`. Without `--stage`, `--settings` must already be cut that way.
- `--hotfix` runs only the steps of the hotfix list at the top of `Program.cs`: the crafting stations, cooking, smithing, tempering,
  tailoring, factions, uncraftable, leveled items, writing, racial, the enchantment magnitudes, the races, the head
  parts, the disabled references, the overrides, the disabled actors, the crafting categories and the marker effects. The live plugin already
  holds what the others build. Their sweeps of the load order touch only recipes the plugin does not override yet and
  none a Creation Club plugin defines, so the tiers it ships stay as they are; the factions, uncraftable and racial
  rules still read every recipe, the plugin's own overrides included, and the tailoring `tiers` lists apply to the
  recipes they name. A named cooking or `addItems` recipe the sweep skips is not an error. A new step goes into
  both lists, in the full run's order.
- `--no-creations` keeps the Creation plugins in the load order: the plugin has mastered them since r12, so
  every winner is the one the game loads before it.
- No `--next-form-id`: every record is found by editor id and reused, and a new one takes the plugin's own next
  form id. `--next-form-id <hex>` pins new own records to a block and refuses a plugin that already holds
  them, so it does not suit the live plugin.
  The frozen r13 input (67c566a7, next id `0x0410AB`) does not hold the faction marker spells and the crafting
  category keywords: every hotfix run re-creates them in the same order, so they land on `0x0410AB..0x0410D2`
  every time and the live plugin keeps their ids, which characters hold in their changeforms. A new own record
  created before them (a `newRecipes` entry, made in the smithing step) would push every one of them by one, so
  such a record pins its id with `formId` past that block (the Eastmarch guard helmet recipe at `0x041200`, the City
  Guards recipes at `0x041201..0x041258`, the Long Bow and Hunting Bow recipes at `0x041259` and `0x04125A`, the
  Imperial crafting tab keyword at `0x04125B`, the forge recipes of the woodcutter's axe and the pickaxe at
  `0x04125C` and `0x04125D`, the grain mill bench keyword `AldCraftingGrainMill` at `0x04125E` (`craftingStations`, made
  before the smithing step and the keyword's only creator, so the pin holds on a full run too: `keywords` would make it
  first at the next free id) and its salt recipe at `0x04125F`; the loot lists of the plugin's own at
  `0x041260..0x041268` (`AldLootDraugrWeapon50`, `AldLootDwarvenBolts`, `AldLootSkeletonWeapon`,
  `AldLootSkeletonStaff`, `AldDeathItemSkeletonMage`, `AldLootDraugrArmor20`, `AldLootSoulGemBig50`,
  `AldLootImperialBow50`, `AldLootImperialHelmet10`, in the order `leveledItems` lists them) and the death items of the
  deathlord and the corrupted shades at `0x041269` and `0x04126A`, and the two farm grain mills of `craftingStations` at
  `0x04126B` and `0x04126C`; the next one takes `0x04126D`); the
  r15 record diff is what caught the shift. The crafting tab keywords are created in the order the tabs are first
  used, so a new tab would push every later one: it pins its id in `craftingCategories.formIds`.
- `disableActors` copies about 2,650 cell and 27 worldspace records from their winners at run time and masters
  the city mods whose actors it disables. Rerun it whenever a plugin before `AlduinakAdditions.esp` changes
  (a city mod update, a new `DynDOLOD.esm`), or the plugin reverts those cells to the old copy.

After the run, `proficiency-report.md` notes the counts per faction and race rule; a new marker spell is
listed under the new records, and `proficiency-ids.json` must show the same local ids as before. The full slot is
`0x33` today: `DynDOLOD.esm` is a full plugin loaded before `AlduinakAdditions.esp`, so any change of the plugins
before it moves the global ids, and the live `server-settings.json` must then take the Hunter Master id from the
new `proficiency-ids.json`.

`dump_death_items.py` prints what the live spawn bases drop before the spec is edited and after a run: it reads
`loadOrder` and `dataDir` from `--settings` and the base ids from `--spawns` (`NPC-Spawns.json`), follows each
base's template chain while Use Traits is set the way the server does, and prints the death item list it stops at
with its flags, chance none and entries, sublists included; then, through the chain while Use Inventory is set, the
inventory (`CNTO`) and outfit the server adds when it creates the actor. A leveled actor list in a chain is followed
for every actor it can pick at level 1 (`python misc/proficiency-patcher/dump_death_items.py
--settings build/dist/server/server-settings.json --spawns build/dist/server/NPC-Spawns.json DeathItemDraugr`;
editor ids on the command line, NPC_ or LVLI, are printed the same way, and `--plugin out/AlduinakAdditions.esp`
reads the patcher output in place of the Data folder copy). `--forbid Gold001 Ebony` lists every item whose editor id
contains one of the words that a spawn base can still get at level 1, with the lists it comes through, and exits 1 if
there is one. Python only, no Mutagen.

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
   the cells `meadery` names, the ENCH overrides `enchantmentMagnitudes` names by editor id, the LVLI
   records and NPC_ overrides `leveledItems` names by editor id, the REFR overrides `placements` names by form key and the
   records `overrides` names (items, recipes, foods and quests by form key, own references by editor id);
   everything else must be byte-identical up to Mutagen's known
   normalisations (`-0.0` floats, deleted records without subrecords). A record that only gains Initially
   Disabled (header flag `0x800`) passes and is listed; one that loses it fails. A changed master list
   renumbers every form id, so records are then matched by editor id and compared structurally. The plugin
   may never master `DynDOLOD.esm`, `DynDOLOD.esp` or `Occlusion.esp`. Exit code 3 on any other difference,
   and `verify.txt` lists it. A spec section that adds or changes records of other types brings an allow
   rule of its own (`meadery_allowed`, `spec_overrides`, `world_allowed`, `actors_allowed`), listed in `spec_allowed`;
4. with `--stage`, runs `verify_r13.py`, which reads every plugin of `settings.stage.json` with `misc/esplib.py`
   alone and compares the output with the input and with the load order before it, so it still holds when a new
   master renumbers every form id: the masters are a superset of the input's in load order and never a generated
   plugin; every own record keeps its local id and new ones take ids past the input's next object id; the
   `AldMastery_` marker spells and `AldMasteryMarkerEffect` are unchanged; every other record is unchanged up to
   renumbered form ids (a form id left unrenumbered in a form id field fails), or is a type the patcher writes, or
   one the spec's allow rules name; a changed actor is its winner before the plugin with only Initially Disabled
   added and an enable parent turned into the player, opposite, and with `disableActors` no actor can still be
   enabled and no reference hangs on one switched off with the opposite state; a new cell or worldspace override is
   its winner's record (a worldspace: the last winner outside `notFrom`, without the offset table); a
   `disableReferences` reference only gains Initially Disabled; an item of `overrides.misc` is its winner with only
   the weight set, a recipe of `overrides.recipes` its winner with only the created count set, a food of
   `overrides.foods` its winner with only the named effect swapped, a quest of `overrides.quests` its winner without
   the scripts it names, and a reference of
   `overrides.refs` the input's with only the scale set; an item newly overridden for the crafting
   categories is its winner with only category keywords added; a head part of `headParts` only changes its race
   list; a race of `races` only loses the spells the section removes and changes only the passives and description
   it gives, and every one ends without them; and `proficiency-ids.json` carries the plugin's full slot. Exit code
   3 on any problem, and `verify-r13.txt` lists it.

## AlduinakCreations.esp

The settings `loadOrder` must carry the four plugins of `spec.json` `creations.plugins` right after `Dragonborn.esm`, in
`Skyrim.ccc` order: Fish, SurvivalMode, Curios, AdvDSGS (the live `loadOrder` has them there). The same run then
also writes `AlduinakCreations.esp`, `creations-report.md` and, through `patch.py`, `verify-creations.txt` and
`AlduinakCreations.inputs.json`. A load order with only some of them is refused, and so is one with none of them unless
`--no-creations` is passed to `patch.py`, which builds `AlduinakAdditions.esp` alone against the whole load order.
`AlduinakCreations.esp` may appear last in the settings `loadOrder` or be absent: the run never reads it.

**Rebuild it whenever any plugin before it changes.** It copies whole CELL and WRLD records (626 cells, 14 worldspaces
today, including Riverwood, Riften, Dawnstar and Solitude), 87 references, 4 navmeshes and other reverted records from
their winner at build time, `AlduinakAdditions.esp` included, and it loads last, so a stale copy silently undoes a later
edit of Graves's plugin or a city mod. `verify_creations.py` writes `AlduinakCreations.inputs.json` after a clean check:
the plugin's sha256 and the name and sha256 of every plugin loaded before it except the five vanilla masters, in order.
The live `AlduinakAdditions.esp` already holds this plugin's records, merged in with their form ids, so only one plugin
ships. The hotfix run passes `--no-creations` and keeps those records as they are; nothing in the build or in "Update
manifest" catches a stale cell copy among them.

- The two full Creation plugins (Fish and AdvDSGS) load before `AlduinakAdditions.esp`, so its full slot, and with it
  `proficiency-ids.json`, sits two higher than in a load order without them.
- `AlduinakCreations.esp` is ESL-flagged and holds overrides only, so it takes no full slot and shifts nothing. It
  masters the Creations and `AlduinakAdditions.esp` (for the rank markers) and loads last. Merged into
  `AlduinakAdditions.esp` its records keep their form ids and the plugin hard-masters the four Creation plugins;
  dropping an ESL plugin that loaded after it moves no slot.
- The Creation Club plugins are localized. Every DLC master keeps its strings in `Skyrim - Interface.bsa`, where
  Mutagen only looks for `Skyrim.esm`'s, so the program extracts that archive's strings to a temp folder first.
  The dataDir must hold the four Creation BSAs as well as their plugins.

| Key | Effect |
|---|---|
| `creations.globals` | GLOB values pinned: Survival never switches on and its prompt never shows (its `DOBJ` keys `SRVE`, `SRVS`, `SRVT` point at these globals; no vanilla default object is changed, so the `DOBJ` itself is kept). |
| `creations.stageAbilities` | The hunger and exhaustion stage abilities the server grants lose their `...ImodEffect` screen effect. |
| `creations.revertTypes` | A Creation edit of a master record of these types is replaced by the record as it wins without the Creations. |
| `creations.keepTypes` | Creation edits kept: `ALCH` (the Survival hunger effects the server reads), `DOBJ`, `NAVI` (overridden later by `AlduinakAdditions.esp` anyway). An edit of a type in neither list fails the run. |
| `creations.keepEdits` | Editor ids of Creation edits kept although their type is in `revertTypes`: Survival's four `Survival_FoodRestoreHunger*` magic effects, whose `Survival_HungerRestoreEffectScript` `AmountToRestore` global is what a food restores when the server's `needsFoodHunger` does not list the effect (the `Update.esm` records carry no script). Their `Survival_ModeEnabled == 1` condition keeps the script from running in game. |
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

`verify_creations.py` re-reads every plugin with `misc/fastesp.py` and checks each record against its source:
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
| `keywords` | `AldCraftingAlchemy`, `AldCraftingKiln`, `AldCraftingWoodcrafting`: the bench keywords of the new recipes. A `craftingStations` keyword is not listed here, so its pin holds. |
| `alchemyLabs` | FURN records switched from the alchemy menu to the crafting menu with the alchemy keyword. |
| `craftingStations` | FURN records turned into crafting benches: each entry names a `keyword` of the plugin's own, created with the local id `keywordFormId` pins when the plugin lacks it, and the `furniture` editor ids that get workbench data (`CreateObject`, no skill) and the keyword. One entry today: the grain mills (`GrainMill`; add the editor ids of any mod grain mill the farms use) on `AldCraftingGrainMill`, where `smithing.newRecipes` puts the salt recipe. Such a mill opens the crafting menu; whether its push idle still plays first is to be confirmed in game. A missing furniture is a warning. `placements` puts references of the plugin's own, in the `world` placement format (`edid`, a `formId` pinning the local id, `base`, `cell`, `pos`, `rot`), where a farm has no such furniture: a `GrainMill` beside the Chillfurrow and Battle-Born Farm windmills (`FarmhouseWindMillWR` activators that offer nothing) at `0x04126B` and `0x04126C`. Runs in the hotfix list too, before the smithing step, so the recipe finds its bench. |
| `alchemy.recipes` | Potion, poison and salt recipes at the alchemy keyword. |
| `kilnRecipes` | The charcoal recipe. `bench` names the keyword it sits on (`CraftingSmelter`); `keywords.kiln` is the fallback and waits for a kiln mod carrying `AldCraftingKiln`. An entry without `profession` is a common recipe: it must be `Anyone` and named `AldRecipeCommon_*`, any character makes it, and the server's mastery system credits no hours for that prefix. The lute, flute, drum and broom (Woodcrafting Bench) and the two war horns (forge) are common recipes, reported under `common`. |
| `woodcraftingBench` | A new FURN copied from the Hearthfire carpenter's workbench, plus existing benches that also get the woodcrafting keyword. |
| `cooking` | Vanilla cooking recipes keep their benches; `needsSalt` adds a Salt Pile where it is missing; `tiers` sets the rank, Novice where it says nothing, so steaks and fish are the cook's and the five open dishes are listed under `Anyone`. |
| `stripConditions` | CTDA functions `CraftService` has no implementation for. Every recipe the patcher tiers loses them, so the menu and the server agree; an unregistered function answers true server-side. |
| `benchRouting` | Which bench a recipe at one of the `from` benches belongs at. A `products` rule claims a recipe by what it makes (`kinds`, `keywords`): bows, arrows, bolts and shields are the woodworker's whatever they are made of. Otherwise the first `materials` rule whose `items` or `itemKeywords` appear among the inputs wins: ore and the metals smelted from it `keep` the recipe at its forge, leather and pelts send it to the tanning rack and firewood to the woodcrafting bench. A recipe that takes a finished piece of gear and gives another (the closed helmets, the silver upgrades) is a conversion and stays; anything else makes nothing of ore and is parked on the `uncraftable` bench. The rule also names the profession whose ranks gate the recipe, and the one a temper entry asks for. |
| `smithing` | Every recipe at the smithing benches is routed by `benchRouting` and tiered by the highest `materials` entry among its inputs and product, under the profession the route names. `temperBenches` tiers the armour table and the grindstone by the same table, keeping their vanilla conditions; `temperRecipes` names Improve entries the table cannot place with their `profession` and `tier` (the Long, Hunting, Colovian and Springsteel bows, the Immersive Armors Skyforge shields), applied by a hotfix run too. `newRecipes` adds recipes of the plugin's own (the woodcutter's axe, the Long Bow at woodworker Novice and the Hunting Bow at Adept, which no plugin had a recipe for, each hold's Sentinel City Guards gear as `AldRecipeGuard<Hold>_<item>` at Expert: that hold's `factions` rule claims it through "Guard" and the hold or city name, so it needs the hold's craft rank and an Expert woodworker for a shield, tailor for a cloak, blacksmith at the forge for the rest; and `AldRecipeSmith_SaltPileMill`, one Sea Salt Rock into 50 Salt Pile at the grain mill keyword of `craftingStations`, `Anyone` like the smelter's `12RecipeSeaSaltPile` and with the same count, so a change of one is a change of both; its `profession` is the blacksmith's like the smelter recipe's owner, inert at `Anyone`). An entry's `also` names further professions whose markers join the `profession`'s in one OR group at the entry's `tier`, so any of them makes it there: the forge copies of the woodcutter's axe and the pickaxe (`AldRecipeSmith_Axe01`, `AldRecipeSmith_Pickaxe`, blacksmith Novice, `also: ["woodworker"]`), which the woodcrafting-bench copies keep beside. The smithing and tailoring sweeps leave every recipe a `newRecipes` entry wrote to that entry, so a full run over a plugin that already holds them keeps their tier and `also`. |
| `uncraftable` | Recipes parked on a keyword no furniture carries, so nothing can ever make them: the 20 Daedric recipes, the 105 faction, guild and one-off pieces (hold guard, Stormcloak, Thieves Guild, Dark Brotherhood, Forsworn, Skaal, Companions, Dawnguard armour, Morag Tong, Penitus Oculatus, and the named unique items) that `stripConditions` would otherwise expose, and the owner's 105 launch hides (every Imperial recipe, Bonemold, Chitin, Silver, Titus Mede I, Vampire Royal, Vvardenfell Glass, the Velothi Morag Tong sets, the +40 unarmed Moon Monk gauntlets and the closed-helmet conversions of unique and faction helmets). Runs after `woodworking`, so it also parks the Imperial shields and bow moved there. |
| `leveledItems` | NPC loot: overrides of the leveled lists the server rolls for a death item or a base container, and lists of the plugin's own. Each entry names a `list` by editor id and may set `chanceNone` (0-100), `remove` the entries of items or lists by editor id and `add` `{item, count, level}` entries. `"new": true` creates the list in the plugin instead, empty, with its local id pinned by `formId` (like a new recipe, so the hotfix block after it keeps its ids); an entry earlier in the section may then `add` it as a sublist. `useAll` sets or clears the list's Use All flag: with it every entry drops, without it the server takes one random entry, so a death item list with several named items wants `true` and a "one of" chance list `false`. `npcs` names NPC_ records by editor id whose winning record is overridden with its death item pointed at the list; the server reads the death item off the record its UseTraits template walk stops at, so name that one (`dump_death_items.py` shows it), and `patch.py` allows those NPC_ overrides. A list that takes its chance from a global (LVLG) is refused, because the server treats such a list as always empty; a sublist entry is rolled once whatever its count, a direct item keeps its count. Re-runs are idempotent: a removed entry already gone is a note, an identical added entry is not added twice, a new list is reused. The creature table: no list a live spawn base reaches gives gold. Every death item list loses the vanilla gold sublists (`LootGoldChange`, `LootPerkGoldenTouchChange`, `LootImperialLuck`; a gold sublist of its own, like `LootGiantGold` or `DeathItemDraugrGold`, is named too), the creature treasure roll `LootSmallTreasure10` loses its `LootGoldChange` and goes to `chanceNone` 95, so its gem and ring (`LItemGemsSmall`, `LItemJewelryRingSmall`) stay at 2.5% each, and `LootFalmerCorpseGold`, the Falmer inventory list the server adds at creation, is emptied. No list a live spawn base reaches gives ebony either: `LItemDraugr05EWeaponBow`, the Ebony Bow and arrows the Sunderstone Gorge deathlord (`EncDraugr05TemplateMissileEbony`) always carries, takes the sublists of the vanilla non-ebony deathlord bow (an Orcish bow and arrows at level 1). Every death item list carries `useAll`, so a body holds every entry the list still has, the named items among them, plus a chance through a sublist of its own with `chanceNone` and one entry taken (`AldLootDraugrWeapon50`, `AldLootSkeletonWeapon`, `AldLootSoulGemBig50` at 50%, `AldLootSkeletonStaff` and `AldLootDraugrArmor20` at 20%, `AldLootImperialHelmet10` at 10%) or a vanilla one (the hagraven's `LootHagravenChestPotions25`, one potion or poison at 25%). An added item replaces the vanilla entries that give the same thing, so the counts the entry names are what drops: the list's own entry of that item and its single-item chance lists (`LItemBoneMeal25`, `LItemFalmerEar50`, `LItemFalmerEar25`, `LItemHagravenClaw25`, `DeathItemChaurusEggs25`, `LItemDwarvenOil50`, the dwemer constructs' soul gem lists and the sphere's `DLC1LootSphereBolts`) are named in `remove`, which runs before `add`. Giants drop no gold and no weapon (`DeathItemGiant`); the dwemer scrap lists of spiders and spheres roll at 50% and the sphere, centurion and ballista death items lose the extra `LootDwarvenScrap25` roll, which the dwarven chests keep; three bases get a list of their own pointed at by `npcs` on the record the live spawn's Use Traits walk stops at: the Windward Ruins skeleton mage (`AldDeathItemSkeletonMage` on `dunLabyrinthianSkeletonMage`, which has no template), the Sunderstone Gorge deathlord (`AldDeathItemDraugrDeathlord` on `EncDraugr05TemplateEbony`) and the Rannveig's Dark Shades corrupted shades (`AldDeathItemCorruptedShade` on `EncSkeletonNecroImp01Melee1H` and `EncSkeletonNecroImp01Missile`). Death hounds and cave bears stay vanilla. Every editor id the entries name is a record of the live load order (`dump_death_items.py <editor id>` prints it or says it is missing), and the run stops on any it cannot resolve. Runs in the hotfix list too. |
| `meadery` | The mead benches: `keyword` (`AldCraftingMead`, shared) and one keyword per bench, a FURN per bench copied from `template` with `removeKeywords` swapped for both keywords, its Novice `recipe` at its own keyword (`AldRecipeMead_<output>`), and one persistent `AldMeadBench_<boiler>` reference per `placements` entry (`pos`, `rotZ` in degrees, an optional `scale`, 1.5 today so the invisible pot is easier to aim at) in an override of `cell`, refused further than 256 units from its `boiler`. A hotfix run does not place benches; `overrides.refs` carries the same scale for the references the live plugin already holds. `drinks` are the recipes brewed at any boiler, on the shared keyword (ale, wine and Nord mead, moved off the alchemy table); every drink is `Anyone`. `honey` is the Bee Honeycomb recipe, at the cooking pot (`AldRecipeCook_FoodHoney`) and at the alchemy bench, both `Anyone`. |
| `benchMoves` | Existing recipes moved to another bench keyword with their tier kept. `recipes` names them, and `match` claims any recipe at one of the `from` benches by its editor id, product editor id or product name, skipping parked ones. The Skyforge move takes the Steel Plate, Nord Hero and Nordic Carved sets, which is all it then offers besides the two Immersive Armors Skyforge shields, which `tailoring.recipes` sends there under the blacksmith's Adept rank. A named recipe may not also be `uncraftable`. The report notes every furniture still carrying the keyword. |
| `benchKeywordRemovals` | Bench keywords taken off existing furniture by editor id (the Skyforge keyword off the Riften Extension North and Mammoth Manor anvils, so the Whiterun Skyforge is the only one). A missing bench is a warning. |
| `enchantmentMagnitudes` | One effect's magnitude on an enchantment: the Fortify Carry Weight of every bag, 60 for a backpack (the Travelling Merchant, Reinforced, lantern, glowdust and Trader's Resource backpacks), 40 for a satchel and 20 for a pouch. `armors` must be every winning ARMO and WEAP carrying it, otherwise the step refuses, and `enchantment` must be its editor id. |
| `disableReferences` | Placed references (`refs`, form keys) turned Initially Disabled: an override of the winner, or the plugin's own reference changed in place; one already disabled is left alone. The beehives and Stonewall Terrace pieces, and the collision box that stayed in the gateway of the iron gate in the Whiterun outer wall once the gate opened; the floating wine bottle outside Whiterun, Salia's and Safni's corpses in Carpe's House (Warbirds Whiterun Metropolis) and the knapsack by the road west of Solitude. A form id from the in-game console carries the client's load order index, which counts no ESL-flagged plugin (`0x10` is `Warbirds Whiterun Metropolis.esp` today, `0x33` this plugin); the server skips an Initially Disabled reference when it loads the world (`WorldState::AttachEspmRecord`). The Helgen keep hall collapse (HelgenKeep01) stays vanilla: it is one mesh with the corridor, so disabling it opens a pit; the client plays its collapsed state instead (`skymp5-client/src/services/services/cellAnimationsService.ts`). |
| `overrides` | One field of a record another plugin defines, overridden in place, or of an own placed reference: `misc` entries set an item's `weight` by form key (`item`; the Sea Salt Rock of Saltdeposits.esp, 20 instead of 1, which makes that plugin a master), `recipes` entries set a recipe's created object `count` (`recipe`; one Sea Salt Rock refines into 50 Salt Pile at the smelter), `refs` entries set the `scale` of one of the plugin's own placed references by editor id (`ref`; the five `AldMeadBench_` benches at 1.5, so the invisible pot the crosshair must hit is half again as big). `foods` entries swap one magic effect of a food by form key (`item`) from `from` to `hunger`, both by editor id (the six raw vegetables, cabbage, carrot, gourd, leek, potato and ash yam, get Survival's Small hunger effect, the one it gives raw apples and tomatoes, instead of Very Small). `quests` entries drop the scripts `dropScripts` names from a quest by form key (`quest`; `Survival_MainScript` off Survival's `SurvivalModeMainQuest`, whose 5 s poll of `Survival_ModeToggle` would start vanilla Survival once the client sets the toggle for the HUD). `name` is a label for the reader. Runs in the hotfix list too, after the disabled references, and a re-run writes the same values. |
| `disableActors` | Every placed actor of the load order, living or dead, is Initially Disabled, so the game shows no vanilla or mod NPC and no corpse (the server spawns none of them anyway). One with an enable parent gets the player as parent, opposite, the xEdit idiom for a removed reference, so no quest or marker turns it back on; that includes the already disabled ones whose parent could. `except` names actors to leave alone. Every cell holding one is overridden from its own winner, and a worldspace from its last winner outside `notFrom` (`DynDOLOD.esm`, whose large references would make it a master), without the offset table. References whose enable parent is such an actor go with it: the carriages and driver seats of the hold stables. |
| `placements` | A placed reference (`ref`, a form key) moved to its `anchor`'s winning position plus the offset the defining plugin had between the two (the Windhelm Gray Quarter gate door back in the arch WindhelmSSE.esp moved). Refused when either record was rotated since. The override joins the plugin's own cell and world groups when it already has them. |
| `world` | The references of `AlduinakWorldChanges.esp`, Graves's world-changes plugin, merged as data rather than as a plugin. `placements` are its new references: an `edid`, a `formId` pinning the local id, a `base` (an editor id of the plugin's own, or a form key), the `cell` they sit in as a form key, and `pos`, `rot` (radians) and an optional `scale`. The cell override comes from the load-order winner, so nothing another mod did to that cell is reverted. `moves` set the position of an existing reference, keeping everything else it wins with, including Initially Disabled. The section is plain data, edited by hand; the plugin's placeholder `BYOHHouseCarpentersWorkbench` is `AldWoodcraftingBench` here. |
| `factions` | The gear only a faction's own may make. One Ability marker `AldFaction_<id without punctuation>` per `list` entry, and a `HasSpell` condition on every recipe at the `benches` whose editor id, product editor id or product name matches: `match` (any of), `all` (every one of, for the hold guards) and `except`. The game's own factions mean nothing here, so `skymp5-server/ts/systems/factionCraftSystem.ts` grants and revokes the markers from the backend roster. A recipe a rule claims is dropped from `uncraftable`: it is gated by membership now, not hidden. The first matching rule wins. `also` names further faction ids whose members may make it too: the markers form one OR group after the rank condition (the College of Winterhold or the Synod), each id needs an entry of its own, and a marker takes its name from the entry without `also` (an entry with no `match` or `all` only creates its marker). A claimed recipe loses every older faction marker and its `GetInFaction`, `GetPCInFaction` and `GetIsRace` conditions. A Creation Club recipe is claimed only by a rule with `"creations": true`. A parked recipe a rule should own instead (the Pale guard pieces) leaves `uncraftable.recipes` and gets its bench back from a `tailoring.recipes` entry, because `benchMoves` runs after the claim. Eastmarch has no vanilla guard set of its own: its guards wear the Stormcloak cuirass, so a second `hold:eastmarch` entry with `also: ["faction:stormcloaks"]` sits before the Stormcloaks rule and claims `MCERecipeArmorStormcloakCuirass` for both, and the Eastmarch guard helmet, which no plugin had a recipe for, is the plugin's own `AldRecipeArmorGuardHelmetFullEastmarch` under `smithing.newRecipes` (forge, blacksmith Expert like all hold gear, 3 iron ingots and 2 leather strips), named in the first `hold:eastmarch` entry's `match`. |
| `racial` | The gear only one people may make. A recipe at one of the `benches` whose editor id, product editor id or product name contains one of a rule's `match` strings and none of its `except` strings gains that rule's races as one `GetIsRace` OR group after the rank condition; Creation Club recipes and recipes a faction claimed are skipped. `GetIsRace` is one of the functions `CraftService` implements, so the crafting menu and the server agree. Dwarven is in no rule: anyone may make it. The two Colovian composite bows of Immersive Weapons and their Improve entries are the Imperials'. `clear` names gear open to every people although a rule's match would claim it (the Immersive Armors Skyforge shields, "Skyforge" being a Nord match): a recipe it matches loses any `GetIsRace` it carries and no rule gates it. |
| `races` | The playable races and their vampire forms (`races`) lose every spell the game hands a character of the race whose type is in `removeSpellTypes` (the greater powers and the vampires' Hunter's Sight), except `keepSpells` (Khajiit Night Eye). The client's `BLOCKED_POWER_IDS` and the live `blockedSpells` keep refusing the old greater powers for a client on an older plugin. `passives` gives races (a race and its vampire form) `startingHealth`, `startingMagicka` or `startingStamina`, an unarmed damage equal to the damage of the `unarmedDamageFrom` weapon as it wins at run time (the Khajiit: the Steel Dagger, 7 today) or the number `unarmedDamage` (the Argonians: 4, like every other race), and abilities to remove (`removeSpells`, the Khajiit claws among them); the server reads the same race data for base attributes and unarmed damage, so both sides agree. `descriptions` is the race menu text of the playable races, and `spells` sets the magnitudes of a racial ability's effects (the Wood Elf's poison and disease resistance). Elemental and poison resistance stays client-side until the server has damage rules for it. |
| `headParts` | The races character creation offers a head part to: each entry sets the `validRaces` form list on its `parts` (the five CuyiAntlers antlers, which listed every race but the beast races, now only `HeadPartsWoodElfandVampire`, the Wood Elf and its vampire form). The client only records the head parts a character picked, so this list is the one gate; characters that already wear antlers keep them. |
| `craftingCategories` | The filter tabs of the CraftingCategories SKSE plugin. It files an item under one section and one category of that section only, the ones whose keywords the created object carries, and a section without keywords receives nothing (the one section the plugin had before r13 was empty for that reason). So every armour, weapon and ammunition the `benches` make gets one section keyword `<keywordPrefix>Slot_<name>`, from the first of `sections` it fits (`slots`, biped slot numbers; `kinds`, `armor`, `weapon` or `ammo`; `keywords` on the item): Shields, Torso, Head, Hands, Feet, Weapons, then Accessories for anything else worn. It also gets one category keyword: `<keywordPrefix>Race_<rule>` when a `racial` rule gates its recipe, otherwise `<keywordPrefix>Mat_<material>`, the `materials` entry its recipes use the most of by count (a tie goes to the earlier entry; `ignoreItems`, the leather strips, never count). Older keywords of the prefix leave the items it tags. `priority` orders the sections in the menu and `icon` is a label of `iconSource`. `formIds` pins the local id of a tab keyword added after the others (`AldCatRace_Imperial`). The run writes `CraftingCategories/<file>`; a race or material that appears in several sections carries trailing spaces in its label after the first, because a label names one category per file. It ships in the Alduinak Client Files mod as `SKSE/Plugins/CraftingCategories/<file>`, beside the plugin, and nowhere else. |
| `writing` | Keywords `AldWritable` (written items) and `AldWritingBlank` (blanks); `books` are new BOOK records copied from vanilla notes with their scripts and teaching removed, a new name, description text, value and weight; `misc` adds Sealing Wax; `recipes` puts the blanks on the tanning rack and the woodcrafting bench, open to everyone (`Anyone`), and the wax on the smelter at Novice. The server finds every record by editor id (`docs/docs_roleplay_writing.md`). |
| `tailoring` | Every winning recipe at the `benches` (the tanning rack and the loom) is the tailor's, Novice unless `tiers` says otherwise; `tiers.Novice` names the cloaks, capes and coarsest everyday clothing outright, so a hotfix run re-tiers them although the plugin already overrides them. Nothing at the rack or the loom is open to everyone but the writing blanks. `shared` rules name `products` (created objects, by editor id) other professions make too: every recipe at the `benches` making one keeps its owner and tier and gains the rule's `also` markers in the same OR group, and a hotfix run re-tiers it although the plugin already overrides it (leather and leather strips, `also: ["hunter"]`; hunters earn no hours at the rack unless the live `masteryActivities.hunter.craftKeywords` names `CraftingTanningRack`). `recipes` is the owner's list, correcting ingredients, bench and tier by editor id, and may name a recipe at any bench; its `profession` puts the recipe (and the temper entry of what it makes) under another profession's ranks, such as the Pale guard helmet at the forge, or keeps a woodworker recipe off its material tier (the Colovian bow at Adept, the Dark Colovian and Springsteel bows at Expert). `disableRecipes` parks recipes on the `MothNest1` keyword, the plugin's convention for a hidden recipe (the bog blight masks, the five tanning-rack twins of the +40 unarmed Moon Monk gauntlets and the children's clothes). The sweep reads the load order, so a recipe `benchRouting` moved to the rack keeps the tier the smithing step gave it. |

Tier conditions are `HasSpell(AldMastery_<Profession>_<Rank>) == 1`, Run On Subject; a recipe tiered `Anyone` carries none. The server evaluates
the same condition in `CraftService`, which is why perks are never used (see `docs/docs_roleplay_mastery.md`).

Two steps exist for the record format alone and run last. Every marker ability with no perk of its own carries the inert
`AldMasteryMarkerEffect`, because a `SPEL` with no effects at all is an invalid record, and any recipe left without a
workbench keyword is parked on `MothNest1` like the hidden ones (the Creation Kit dropped one in the base plugin, and no
bench ever offered it). Running last keeps the ids of everything before them, which the marker spells need: the live
`server-settings.json` names `AldMastery_Hunter_Master` by form id.

## After a run

- The output plugin must reach the server Data folder, `C:/MO2/mods/Alduinak`, `build/dist/client/Data` and
  the install manifest together (Server Manager "Update manifest", "Sync Data", "Build Client").
- `CraftingCategories/AlduinakAdditions.json` goes to `SKSE/Plugins/CraftingCategories/` of the Alduinak Client
  Files mod with the plugin. Without it the category keywords are inert. No other copy may ship: `populate-files.js`
  leaves the `CraftingCategories` folder, the plugin and the top-level json files out of the launcher's client zip
  even when they sit in `build/dist/client/Data`, and Build Client fails if the zip carries one anyway.
- The server reads the plugin once at startup: restart the game service.
- `proficiency-ids.json` holds the global ids the live `server-settings.json` needs for
  `damageMultConditionalFormulaSettings` (the hunter's Over Draw rule); `masterySpells` needs nothing, the
  server finds the markers by editor id.
- The master list grows to every plugin whose recipes are gated (see `proficiency-report.md`); those plugins
  become hard dependencies of `AlduinakAdditions.esp`.
