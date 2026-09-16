# proficiency-patcher

Rewrites `AlduinakAdditions.esp` with the proficiency (mastery) content: the rank marker abilities, the crafting
keywords, the alchemy labs turned into crafting stations, the woodcrafting bench, the potion and charcoal
recipes, and the tier conditions on every cooking, smithing, woodworking and tailoring recipe in the server
load order. `spec.json` is the design; the program only resolves editor ids and writes records.

It is re-runnable: run it again on a fresh plugin from the Creation Kit and the same records come back
(records are found by editor id, overrides by the record they override).

## Run

```bash
python misc/proficiency-patcher/patch.py --plugin "C:/MO2/mods/Alduinak/AlduinakAdditions.esp" --settings build/dist/server/server-settings.json --out misc/proficiency-patcher/out
```

Needs the .NET 9 SDK (`dotnet`), Python 3 and the game Data folder named by `dataDir` in the settings
file, with every plugin of `loadOrder` present (Mutagen reads them to resolve editor ids and winning
records). The first run restores the Mutagen NuGet package.

`patch.py`:

1. writes `AlduinakAdditions.preclean.esp`, the input minus a duplicate LAND record the Creation Kit left in
   one Windhelm exterior cell (the game keeps the last one, Mutagen refuses to load two);
2. runs the C# patcher, which writes `AlduinakAdditions.esp`, `proficiency-report.md` (every record it
   created or changed, per tier) and `proficiency-ids.json` (the marker spells with their global form ids);
3. verifies the output against the pre-cleaned input with `misc/esplib.py`: only KYWD, SPEL, MGEF, FURN and
   COBJ records may be added or changed, everything else must be byte-identical up to Mutagen's known
   normalisations (`-0.0` floats, deleted records without subrecords). A changed master list renumbers every
   form id, so records are then matched by editor id and compared structurally. Exit code 3 on any other
   difference, and `verify.txt` lists it.

## What the spec describes

| Key | Effect |
|---|---|
| `professions`, `ranks` | One Ability spell `AldMastery_<Profession>_<Rank>` per pair. The server grants them by rank; recipes carry `HasSpell` conditions on them. |
| `abilities` | Vanilla perks (`MagicEffect.PerkToApply`) and a flat stamina bonus carried by a rank's ability. A perk with `untilRank` switches off once that higher marker is held, so ranked perks do not stack. |
| `keywords` | `AldCraftingAlchemy`, `AldCraftingKiln`, `AldCraftingWoodcrafting`: the bench keywords of the new recipes. |
| `alchemyLabs` | FURN records switched from the alchemy menu to the crafting menu with the alchemy keyword. |
| `alchemy.recipes` | Potion, drink, poison and salt recipes at the alchemy keyword. Novice recipes carry no condition. |
| `kilnRecipes` | The charcoal recipe. `bench` names the keyword it sits on (`CraftingSmelter`); `keywords.kiln` is the fallback and waits for a kiln mod carrying `AldCraftingKiln`. |
| `woodcraftingBench` | A new FURN copied from the Hearthfire carpenter's workbench, plus existing benches that also get the woodcrafting keyword. |
| `cooking` | Vanilla cooking recipes keep their benches; `needsSalt` adds a Salt Pile where it is missing; `tiers` sets the rank. |
| `smithing` | Every recipe at the smithing benches is tiered by the highest `materials` entry among its inputs and product; vanilla `HasPerk` gates are removed. |
| `woodworking` | Bow, arrow, bolt and shield recipes move from the forge to the woodcrafting keyword with their tier. |
| `tailoring` | The owner's list at the tanning rack with the ingredients from the spec; `disableRecipes` parks recipes on the `MothNest1` keyword, the plugin's convention for a hidden recipe. |

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
