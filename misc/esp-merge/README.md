# esp-merge

Rebuilds AlduinakAdditions.esp from a Creation Kit save by Graves (NEW) and the last released plugin, without letting the
CK's damage through. Graves's CK keeps only ESM-flagged or `.esl` masters, so every raw save re-owns overrides of the dropped
`.esp` masters, loses records whose local id collides with one of theirs and renumbers the losers.

Each step pins its inputs by sha256 and records its output in `<run>/work/manifest.json`. It appends its run to
`<run>/build-log.txt` and at exit checks that the three live copies still hold `DEPLOYED_SHA` and that the run's frozen input
is unchanged. Run the steps from this folder with Python 3 and the .NET 9 SDK. Nothing here writes a live copy: a plugin
reaches players only through a deploy (copy to the three locations, Update manifest, Sync Data, Build Client, restart).

## Runs

`ESP_MERGE_RUN` picks the run (default `r7`); every path, input and pin of a run lives in `RUNS` in `r7lib.py`. A step
whose input is missing from the run's manifest reads it from the run named by `chain`.

| Run | Folder under `esp-fix/` | Stage folder | What it is |
|---|---|---|---|
| `r7` | `r7/` | `r7/` | Graves's 2026-09-14 save merged onto r4 (steps 0-5 below); deployed as be1cb8e3 |
| `r10` | `r10/` | `r7/` | r7's merged base through steps 3-5 with the woodcutter's axe spec; staged ad651b18, never deployed |
| `r11` | `r11/` | `r11/` | Graves's 2026-09-16 save replayed onto r7's merged base, then steps 3-5 with the integrated r11 spec |
| `r11-graves` | `r11/graves-replay/` | `r11/graves-replay/` | The replay check: r11's replayed base through steps 3-5 with r10's spec, compared with r10 |
| `r12` | `r12/` | `r11/` | r11's base through steps 3-5 with the charcoal spec, plus step 4c: one merged plugin, no `AlduinakCreations.esp`; never run |
| `r13` | `r13/` | `r11/` | r12's pipeline with the professions spec; deployed 2026-09-18 as e62b8fe2 |
| `r14` | `r14/` | `r14/` | r13 rebuilt for the owner's 2026-09-18 mod additions and re-sorted load order; its own stage, full slot 0x32 |

The Desktop copy of the 2026-09-14 save (6017a624) was overwritten, so r7's steps 1, 2a and 2b can no longer run; its
padded copy (db02e960) is the frozen input r7 and r10 check.

## r7 steps

| Step | Script | Does |
|---|---|---|
| 0 | `stage.py` | hardlinks the load order into `<stage>/stage-data`, writes `<stage>/server-settings.stage.json` |
| 1 | `attribute.py` | classifies every NEW and R4 record into `attribution.json` (read-only) |
| 2a | `pad_masters.py` | pads NEW's masters to 14 so its own index 0x0E is the self index, deletes REFR 0E04B2AB |
| 2b | `merge.py` + `Program.cs merge` | Mutagen: re-keys re-owned records, restores R4 content, forwards city cell data |
| 3 | `proficiency.py` | `../proficiency-patcher/patch.py --next-form-id 0x201D` on the merged base, accepted only if the ids match LIVE |
| 4 | `masks.py` + `Program.cs armor-effects` | clears EITM on the 8 crafted Kad_BogBlightMask.esp masks |
| 4b | `thrones.py` | esplib, after the last Mutagen pass: drops FurnitureForce3rdPerson from every winning throne FURN still carrying it (Viking's Longhouse.esp 000E75) |
| 4c | `combine.py` + `Program.cs combine` | only a run with `merge`: folds `AlduinakCreations.esp` into the plugin (see below) |
| 5 | `finalise.py` | header and master checks, `<run>/AlduinakAdditions.esp`, `<run>/rollback/` copy of the plugin the live copies hold (`DEPLOYED_SHA`) |

## r11 pipeline

Graves's 2026-09-16 save (f8cefed9, frozen at `r11/input/`) holds only 30 refs of his own; everything else is CK damage.
The owner chose to replay exactly those onto r7's clean merged base (15ecf7a4) instead of repairing the whole save.
Run every step with `ESP_MERGE_RUN=r11`, in this order:

| Step | Script | Does | State |
|---|---|---|---|
| 0 | `stage.py` | `r11/stage-data` and `r11/server-settings.stage.json`: the 71 live plugins with the four Creations after Dragonborn.esm (75) | done, 57ea2a7d |
| 1 | `attribute.py` | classifies all 7,702 own-index records of NEW against the live plugin be1cb8e3 and writes `attribution.json` and `delta.json`; exits 2 unless every count matches `PLANS['f8cefed9']` | done and pinned (8be20542, b76a9e75) |
| 2 | `delta.py` | writes the 30 delta refs onto r7's base (17 replaced in place or refiled to their new cell, 13 added), deletes the stray portal-box marker 001F84 under the Windhelm arena, keeps masters and next id | done, `r11/work/base` ff7f1d0a |
| 2v | `verify_replay.py` | independent of delta.py: base vs r7's base, each ref against its original, the load-order winner and live, no accidental re-enable | passes |
| 3 | `proficiency.py` | `patch.py` with the integrated `spec.json` (84a4eb15): 1,591 added, 152 own records at 0x201D-0x20B4, `proficiency-ids.json` in slot 0x2D, `AlduinakCreations.esp` | done, 40ca3888 and 7268d00a |
| 4 | `masks.py` | the 8 mask ARMO lose EITM | done, 9bb88081 |
| 4b | `thrones.py` | throne keyword override | done, 7e2ebcfb |
| 4c | (other tracks) | any extra esplib or Mutagen pass; it reads the previous step's manifest tag and `finalise.py` must read its tag instead of `thrones` | none: the door placement runs inside step 3 |
| 5 | `finalise.py` | `r11/AlduinakAdditions.esp`, `r11/AlduinakCreations.esp` with its inputs file re-pinned, and `r11/rollback/` = be1cb8e3 | done, 7e2ebcfb and 7268d00a (inputs cb0fee57) |

The attribution handles what the 2026-09-16 save added to the known damage:

- A slot NEW shares with a dropped master keeps one record whatever its local id range: the ESL range 0x800-0xFFF, and
  also AVExpansion 0x12EA-0x130C, Viking's Longhouse 0x1011, City of Dawnstar 0x1326-0x1902 and 0x748D, Missives 0x12CC
  and 0x9477-0x9491, ArgonianWeapons 0x48A8. The survivor pairs by content or editor id; a loser that came back under a new
  id pairs by content (refs) or editor id (146 COBJ at 0461D8-046269).
- 194 own records (8 CELL, 185 REFR, 1 ACHR) and 12 re-owned overrides (7 City of Dawnstar, 5 JK's Windhelm's Outskirts)
  were renumbered into 04626A-046337; the plan pins both lists and the 8 cell moves.
- Editor ids repeat in live (RiverwoodFaendalsHouseDUPLICATE001 on cells 000848 and 00085A, FaendalREF001 on 007166 and
  00181A), so an editor id pairing with several hits is settled by content, and the plan pins that each pairs once.
- Raw indices 09 and 0A name Missives.esp and Winterhold Restored.esp; the attribution proves each is the only load-order
  plugin defining every id used there.
- CK noise and artifacts: SPEL ETYP, MGEF SNDD and KYWD CNAM added with CK defaults, the junk u16 of LAND VTXT, junk CTDA
  parameters, an empty FULL dropped, global-valued CTDA links and ARMO armature and alternate texture links into dropped
  masters, and 0A17D3, an identical copy of WindhelmSSE's override.

The replay check run is `ESP_MERGE_RUN=r11-graves` steps 0, 3, 4, 4b, 5 and then `verify_replay.py`. It rebuilt r10's
pipeline on the replayed base: 8e99fefd holds 14,722 records, r10's 14,710 plus the 13 added refs less the marker, with
the 17 replaced refs as the only other difference and every other record byte-equal to r10.

### Where the other r11 changes come in

- **Spec sections (step 3).** The forge hides and bench moves, the Windhelm Gray Quarter door and the backpack values
  (forge-plugin-spec), the instrument and broom recipes (anim-props), the mead benches, recipes and honey and apple sources
  with the `AldCraftingMead` keyword (meadery), the blank writing items and sealing wax (writeable-books) and the CC recipe
  tiers plus the `AlduinakCreations.esp` section (cc-content) all go into `../proficiency-patcher/spec.json` and
  `Program.cs`. Step 3 runs once on the merged spec.
- **Pins.** `RUNS['r11']` pins `spec`, `added` (from `work/prof/verify.txt`), `own_records`, `last_id` and `slot`. New own
  records take ids after LIVE's block 0x201D-0x2092; the common recipes moved r10's woodcutter's axe recipe from 0x2093
  to 0x2099. `proficiency-ids.json` must equal LIVE's with only the full slot moved to `slot`; if a track adds marker
  spells, the ids file check needs a new reference.
- **CC plugins (steps 0, 3, 4b, 5).** The four Creation plugins load right after Dragonborn.esm and `AlduinakCreations.esp`
  loads last. The stage leaves `AlduinakCreations.esp` out (step 3 builds it), so `thrones.py` still finds
  AlduinakAdditions last; the two ESM-flagged Creations move its full slot from 0x2B to 0x2D. Steps 1 and 2 are pinned
  and need no rerun.
- **Deploy.** `DEPLOYED_SHA` stays be1cb8e3 until the r11 plugin is live, then re-pin it.

## r12 pipeline: one plugin

r12 is r11's base through steps 3-5 again with the charcoal spec, plus step 4c, which folds `AlduinakCreations.esp` into
`AlduinakAdditions.esp` so the server ships one plugin. Run every step with `ESP_MERGE_RUN=r12`; steps 1 and 2 stay
pinned to r11 through `chain`, and the stage folder is r11's, so `python stage.py` only refills the slot.

| Step | Script | Does |
|---|---|---|
| 0 | `stage.py` | unchanged: r11's `stage-data` and `server-settings.stage.json` (57ea2a7d) |
| 3 | `proficiency.py` | `patch.py` with the charcoal spec; still builds `AlduinakCreations.esp` and its inputs file, still checked by `verify_creations.py` |
| 4, 4b | `masks.py`, `thrones.py` | unchanged |
| 4c | `combine.py` | `Program.cs combine`: every record of `AlduinakCreations.esp` joins `AlduinakAdditions.esp` with its form key, the four Creation plugins join the master list in load order, the ESL flag stays off |
| 5 | `finalise.py` | reads the `combined` tag, writes `r12/AlduinakAdditions.esp` and `r12/AlduinakAdditions.inputs.json`; no `AlduinakCreations.esp` output |

- **Step 4c.** The Creations plugin holds overrides only, so every record keeps its master's form id; only the plugin's
  own index and the master indices move, because the Creation plugins sit after `Dragonborn.esm`. The two plugins share
  only container records (68 CELL and 5 WRLD in the trial merge); the plugin's own copy is kept, which already holds its
  children, and the step refuses any other record held by both, so no version is ever dropped silently. A copied
  worldspace loses its large references and offset table on the way through Mutagen, so the step carries both over by
  hand. `combine.py` then checks with esplib that the merged record set is exactly the union of the two inputs, that
  every record is byte-equal to its source subrecord by subrecord with the master indices remapped and sits under the
  same groups, that the shared containers match both versions, and that the own local ids, the next form id and the
  header flags are unchanged.
- **The inputs file.** `verify_creations.py` still writes `AlduinakCreations.inputs.json` in `work/prof`, so the food
  and stage-ability checks are unchanged. Step 5 turns it into `AlduinakAdditions.inputs.json`: the same list of plugins
  loaded before it, less the entry for `AlduinakAdditions.esp` itself, pinned to the merged plugin's sha256.
  `skymp5-backend/scripts/compile-manifest.js` reads it under that name (`PINNED_PLUGIN`, `PLUGIN_INPUTS`) and refuses a
  manifest whose plugins before `AlduinakAdditions.esp` differ, or where it is not the last enabled plugin. The old
  file's self-entry is not lost information: step 4c proves the Creation records and the plugin's own records agree.
- **Pins.** `RUNS['r12']` carries placeholders for `spec`, `added`, `own_records`, `last_id` and `hedr_offset`; every one
  of them stops a run that disagrees, and the comment in `r7lib.py` says where the real value is printed.
- **Deploy.** One plugin to the three live copies and to `C:/MO2/mods/Alduinak`, with `AlduinakAdditions.inputs.json`
  next to it; the `Alduinak Creations` MO2 mod, its `plugins.txt` line and the `AlduinakCreations.esp` entry of the
  server `loadOrder` all go away. Re-pin `DEPLOYED_SHA` afterwards.

## r13 pipeline: the professions spec

r13 is r12's pipeline (r11's base, steps 3-5 with step 4c) run with the professions spec: bench routing, the
`Anyone` tier, the tools and instruments, the crafting categories, and the race and faction gates. Run every step
with `ESP_MERGE_RUN=r13`; steps 1 and 2 stay pinned to r11 through `chain`, and the stage folder is r11's.

- **Step 3.** 190 own records at 0x201D-0x20D9 plus the hoe pinned at 0x2100, 2,848 added records, and
  `proficiency-ids.json` again equal to LIVE's with only the slot at 0x2D. The `AldMastery_` ids are unmoved, so
  the live `damageMultConditionalFormulaSettings` needed no edit.
- **The id check.** The spec moves ale, wine and Nord mead off the alchemy table to the meadery keyword, so the
  three `AldRecipeAlchemy_*` recipes are gone and every COBJ after them shifts by three. Step 3's check used to
  demand LIVE's whole block byte for byte; it now demands that every record LIVE shipped still exists (or is named
  in the run's `dropped` pin), that none of them changed type, and that no **non-recipe** id moved. Recipes are
  only ever named by editor id, so their ids may move; a marker spell's may not.
- **`CraftingCategories/AlduinakAdditions.json`.** Written by step 3 beside the plugin and installed as
  `C:/MO2/mods/Alduinak/SKSE/Plugins/CraftingCategories/AlduinakAdditions.json`. Without it the category keywords
  are inert.
- **Deploy (done 2026-09-18).** The merged plugin to the three live copies, `AlduinakAdditions.inputs.json` beside
  it in the MO2 mod, and `AlduinakCreations.esp` and its inputs file out of all three (kept in `r13/retired/`),
  off the MO2 profile's `plugins.txt` and out of the server `loadOrder`, which now matches the staged one exactly.
  `r13/rollback/` holds the r11 plugin, the old `plugins.txt` and the old `server-settings.json`.

## r14 pipeline: a changed load order

The owner added Immersive Armors, Immersive Weapons, two beard mods, an eyewear mod, Cuyi's antlers and
salt deposits, and re-sorted the load order. `compile-manifest.js` refused the manifest because
`AlduinakAdditions.inputs.json` still pinned the old order, which is the check doing its job: the plugin
copies whole cells and worldspaces from the plugins before it, so a changed order means a rebuild.

Run every step with `ESP_MERGE_RUN=r14`; steps 1 and 2 stay pinned to r11 through `chain`.

- **Its own stage.** The load order grew from 71 base plugins to 79 and the order itself moved, so r14
  stages into `r14/` rather than reusing r11's folder. `stage.py`'s plugin-count check is now the run's
  `base_plugins` pin instead of a literal 71.
- **Before staging**, the seven new plugins have to be in the game Data folder and the live
  `server-settings.json` `loadOrder` has to be the new one: `stage.py` reads the live settings and
  hardlinks from Data. None of the seven is localized, so their BSAs are not needed for the build.
- **The full slot moved from 0x2D to 0x32** - five more full plugins load before `AlduinakAdditions.esp`
  (the four new full ones plus `Saltdeposits.esp`, which was enabled in MO2 but had never reached the
  server load order). Every `AldMastery_` global id moves with it, so the live
  `damageMultConditionalFormulaSettings.hunterOverDraw` parameter went from `0x2D002032` to `0x32002032`.
  The plugin's own local ids are unchanged: still 190 own records at 0x201D-0x20D9 plus the hoe at 0x2100.
- **Fifty of the seventy-five plugins changed slot**, so every global form id in them moved. That is what
  the manager's `manifest-diff.json` `purgeNeeded` and the MongoDB purge exist for; see the deploy note.
- **New content joins the rules automatically.** The new mods contribute 2,814 recipes, all at benches the
  patcher already sweeps (smelter, forge, armour table, grindstone, tanning rack, Skyforge), so routing,
  tiers, race and faction gates and the category keywords all apply to them without new rules. Added
  records rise from 2,848 to 5,775. Where the rules misfired on names they had never seen, the spec was
  corrected rather than the rules loosened (see the professions commit).
- **Deploy (done 2026-09-18).** Plugin `44b09cea` to the three live copies, `AlduinakAdditions.inputs.json`
  and `SKSE/Plugins/CraftingCategories/AlduinakAdditions.json` into the MO2 mod. The live
  `server-settings.json` keeps the **old** `loadOrder` on purpose: `modsync.computeDiff` treats the settings
  order as the one the database was written under, so advancing it by hand would make `purgeNeeded` come out
  false and the MongoDB purge would never be prompted for. Sync Data writes the new order and records the
  shift. Only `damageMultConditionalFormulaSettings` was edited ahead of time, because the plugin is built
  for slot 0x32 either way. After Sync Data the settings `loadOrder` must equal
  `r14/server-settings.stage.json`: 83 entries with `AlduinakAdditions.esp` last.

- **The xEdit errors (2026-09-18).** "Check for Errors" found 47: 46 marker abilities whose effect list was
  empty, and `RecipeArmorTH_Fur1Shield`, a `Sentinel.esp` recipe the base plugin overrode with no workbench
  keyword. Both are record-format faults, not content, and both are fixed in the patcher rather than by hand
  (`Steps.MarkerEffects` and `Steps.Orphans`); the run is otherwise r14 unchanged. Own records 201 -> 202
  (`AldMasteryMarkerEffect` at 0x20E5, the first free id, so nothing else moved) and added 5807 -> 5808.
  Deployed as b562f6f0; `r14/rollback/` holds d4f8f33c.

- **AlduinakWorldChanges.esp (2026-09-18).** Graves's world-changes plugin, 9776cba3, frozen at `r14/input/`.
  It arrived with the usual damage: five vanilla masters, its own records at index 6 because the Creation Kit
  dropped the `Warbirds Whiterun Metropolis.esp` master, and all 33 of the cells and worldspaces it opened
  rewritten (delocalized names, dropped `RNAM` and `OFST` tables, recalculated `MHDT`, reordered regions, a
  location link into the dropped master). Merging it as a plugin would have meant a load-order change and
  another purge, so `worldchanges.py` classifies it and writes the `world` section of the patcher spec instead:
  22 new references (21 carpenter benches, which become `AldWoodcraftingBench`, and one rock), four position
  nudges and one `disableReferences` entry. It drops the containers and the 15 re-owned Warbirds references,
  14 of which the plugin already disables; carrying those would only have moved disabled clutter and lost the
  `XOWN` the Creation Kit stripped from six of them. Run it with `ESP_MERGE_RUN=r14 python worldchanges.py`
  before step 3; without `--write` it checks that the section still matches the plugin.
  The merged plugin gains `Vernim Wood.esp` as a master, which loads at 63 of 83, well before it. Own records
  202 -> 224 (the references take a pinned block at 0x2200) and added 5808 -> 5839. Deployed as b861bd88.

## Graves's next save

Every raw save repeats this damage. Before his next session he needs a CK that keeps `.esp` masters (Creation Kit Platform
Extended with ESP masters allowed); ESM-flagging only the ESL masters would not stop the collisions above 0xFFF. His next
session must start from the plugin that is live then.
