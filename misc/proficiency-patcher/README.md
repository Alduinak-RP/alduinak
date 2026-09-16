# proficiency-patcher

Rewrites `AlduinakAdditions.esp` with the proficiency (mastery) content: the rank marker abilities, the crafting
keywords, the alchemy labs turned into crafting stations, the woodcrafting bench, the potion and charcoal
recipes, the tier conditions on every cooking, smithing, woodworking and tailoring recipe in the server
load order, and the writing items (blank and written letters, journals and books, sealing wax) with their recipes. `spec.json` is the design; the program only resolves editor ids and writes records.

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
The file ships next to the plugin in the MO2 mod, and `skymp5-backend/scripts/compile-manifest.js` (manager "Update
manifest") refuses to publish a manifest whose plugins before `AlduinakCreations.esp` differ from it by name, order or
sha256, or where the plugin is not the last enabled one; the file itself is never installed. The esp-merge pipeline
re-pins `AlduinakAdditions.esp` in it at step 5, after steps 4 and 4b, which add only ARMO and FURN overrides.

- `AlduinakAdditions.esp` is built from a load order without the Creations, so it gains no Creation Club master and
  stays byte-identical to a run without them (checked 2026-09-16: 35c9db43 both ways on r7's merged base). Its full
  slot, and so `proficiency-ids.json`, moves from `0x2B` to `0x2D`; `misc/esp-merge/proficiency.py` expects that shift.
- `AlduinakCreations.esp` is ESL-flagged and holds overrides only, so it takes no full slot and shifts nothing. It
  masters the Creations and `AlduinakAdditions.esp` (for the rank markers) and loads last.
- The Creation Club plugins are localized. Every DLC master keeps its strings in `Skyrim - Interface.bsa`, where
  Mutagen only looks for `Skyrim.esm`'s, so the program extracts that archive's strings to a temp folder first.
  The dataDir must hold the four Creation BSAs as well as their plugins.

| Key | Effect |
|---|---|
| `creations.globals` | GLOB values pinned: Survival never switches on and its prompt never shows (its `DOBJ` keys `SRVE`, `SRVS`, `SRVT` point at these globals; no vanilla default object is changed, so the `DOBJ` itself is kept). |
| `creations.stageAbilities` | The hunger stage abilities the server grants lose their `...ImodEffect` screen effect. |
| `creations.revertTypes` | A Creation edit of a master record of these types is replaced by the record as it wins without the Creations. |
| `creations.keepTypes` | Creation edits kept: `ALCH` (the Survival hunger effects the server reads), `DOBJ`, `NAVI` (overridden later by `AlduinakAdditions.esp` anyway). An edit of a type in neither list fails the run. |
| `creations.recipes` | `cooking`, `smithing`, `woodworking`, `uncraftable` sections laid over the root spec for the Creation recipes only; `smithing.materials` adds to the root table. |

Besides the keys, every run clears Start Game Enabled on each Creation quest, neutralises every Creation story manager
branch and quest node and every loading screen (a single `GetRandomPercent < 0` condition), and sets Initially Disabled
without an enable parent on every reference a Creation places. Cells and worldspaces it touches carry the fields of
their winner without the Creations, so no later city mod edit is undone.

`verify_creations.py` re-reads every plugin with `misc/esp-merge/fastesp.py` and checks each record against its source:
placed references differ only by the flag and the enable parent, reverted records equal the winner without the
Creations (Mutagen's subrecord order, `-0.0` and `XPRM` rounding aside), quests only lose the flag, and every live
Creation reference, start-game quest, loading screen and story manager node is covered.

## What the spec describes

| Key | Effect |
|---|---|
| `professions`, `ranks` | One Ability spell `AldMastery_<Profession>_<Rank>` per pair. The server grants them by rank; recipes carry `HasSpell` conditions on them. |
| `abilities` | Vanilla perks (`MagicEffect.PerkToApply`) and a flat stamina bonus carried by a rank's ability. A perk with `untilRank` switches off once that higher marker is held, so ranked perks do not stack. |
| `keywords` | `AldCraftingAlchemy`, `AldCraftingKiln`, `AldCraftingWoodcrafting`: the bench keywords of the new recipes. |
| `alchemyLabs` | FURN records switched from the alchemy menu to the crafting menu with the alchemy keyword. |
| `alchemy.recipes` | Potion, drink, poison and salt recipes at the alchemy keyword. Novice recipes carry no condition. |
| `kilnRecipes` | The charcoal recipe. `bench` names the keyword it sits on (`CraftingSmelter`); `keywords.kiln` is the fallback and waits for a kiln mod carrying `AldCraftingKiln`. An entry without `profession` is a common recipe: it must be Novice and named `AldRecipeCommon_*`, any character makes it, and the server's mastery system credits no hours for that prefix. The lute, flute, drum and broom (Woodcrafting Bench) and the two war horns (forge) are common recipes, reported under `common`. |
| `woodcraftingBench` | A new FURN copied from the Hearthfire carpenter's workbench, plus existing benches that also get the woodcrafting keyword. |
| `cooking` | Vanilla cooking recipes keep their benches; `needsSalt` adds a Salt Pile where it is missing; `tiers` sets the rank. |
| `stripConditions` | CTDA functions `CraftService` has no implementation for. Every recipe the patcher tiers loses them, so the menu and the server agree; an unregistered function answers true server-side. |
| `smithing` | Every recipe at the smithing benches is tiered by the highest `materials` entry among its inputs and product. `temperBenches` tiers the armour table and the grindstone by the same table, keeping their vanilla conditions; the marker profession is the one whose list crafts the item, so the bows and shields of `woodworking` temper under the woodworker ranks. `newRecipes` adds forge recipes of the plugin's own (the woodcutter's axe). |
| `uncraftable` | Recipes parked on a keyword no furniture carries, so nothing can ever make them: the 20 Daedric recipes, the 105 faction, guild and one-off pieces (hold guard, Stormcloak, Thieves Guild, Dark Brotherhood, Forsworn, Skaal, Companions, Dawnguard armour, Morag Tong, Penitus Oculatus, and the named unique items) that `stripConditions` would otherwise expose, and the owner's 105 launch hides (every Imperial recipe, Bonemold, Chitin, Silver, Titus Mede I, Vampire Royal, Vvardenfell Glass, the Velothi Morag Tong sets, the +40 unarmed Moon Monk gauntlets and the closed-helmet conversions of unique and faction helmets). Runs after `woodworking`, so it also parks the Imperial shields and bow moved there. |
| `meadery` | The mead benches: `keyword` (`AldCraftingMead`, shared) and one keyword per bench, a FURN per bench copied from `template` with `removeKeywords` swapped for both keywords, its Novice `recipe` at its own keyword (`AldRecipeMead_<output>`), and one persistent `AldMeadBench_<boiler>` reference per `placements` entry (`pos`, `rotZ` in degrees) in an override of `cell`, refused further than 256 units from its `boiler`. `honey` is the Bee Honeycomb recipe at the cooking pot (`AldRecipeCook_FoodHoney`). |
| `benchMoves` | Existing recipes moved to another bench keyword with their tier kept (the Nordic Carved set to `CraftingSmithingSkyforge`). A recipe may not also be `uncraftable`. The report notes every furniture still carrying the keyword. |
| `benchKeywordRemovals` | Bench keywords taken off existing furniture by editor id (the Skyforge keyword off the Riften Extension North and Mammoth Manor anvils, so the Whiterun Skyforge is the only one). A missing bench is a warning. |
| `enchantmentMagnitudes` | One effect's magnitude on an enchantment (the Travelling Merchant Backpack's Fortify Carry Weight, 60). `armors` must be every winning ARMO and WEAP carrying it, otherwise the step refuses, and `enchantment` must be its editor id. |
| `placements` | A placed reference (`ref`, a form key) moved to its `anchor`'s winning position plus the offset the defining plugin had between the two (the Windhelm Gray Quarter gate door back in the arch WindhelmSSE.esp moved). Refused when either record was rotated since. The override joins the plugin's own cell and world groups when it already has them. |
| `woodworking` | Bow, arrow, bolt and shield recipes move from the forge to the woodcrafting keyword with their tier. |
| `writing` | Keywords `AldWritable` (written items) and `AldWritingBlank` (blanks); `books` are new BOOK records copied from vanilla notes with their scripts and teaching removed, a new name, description text, value and weight; `misc` adds Sealing Wax; `recipes` puts the blanks on the tanning rack and the wax on the smelter, all Novice. The server finds every record by editor id (`docs/docs_roleplay_writing.md`). |
| `tailoring` | The owner's list at the tanning rack with the ingredients from the spec; `disableRecipes` parks recipes on the `MothNest1` keyword, the plugin's convention for a hidden recipe (the bog blight masks and the five tanning-rack twins of the +40 unarmed Moon Monk gauntlets). |

Tier conditions are `HasSpell(AldMastery_<Profession>_<Rank>) == 1`, Run On Subject. The server evaluates
the same condition in `CraftService`, which is why perks are never used (see `docs/docs_roleplay_mastery.md`).

## After a run

- The output plugin must reach the server Data folder, `C:/MO2/mods/Alduinak`, `build/dist/client/Data` and
  the install manifest together (Server Manager "Update manifest", "Sync Data", "Build Client").
- The server reads the plugin once at startup: restart the game service.
- `proficiency-ids.json` holds the global ids the live `server-settings.json` needs for
  `damageMultConditionalFormulaSettings` (the hunter's Over Draw rule); `masterySpells` needs nothing, the
  server finds the markers by editor id.
- The master list grows to every plugin whose recipes are gated (see `proficiency-report.md`); those plugins
  become hard dependencies of `AlduinakAdditions.esp`.
