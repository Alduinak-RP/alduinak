# esp-merge

Rebuilds AlduinakAdditions.esp from Graves's Creation Kit save (NEW) and the last released plugin (R4), following
`reports/r7-esp-merge-plan.md` in the overnight folder. All output goes under `esp-fix/r7/`. Each step pins its inputs by sha256
and records its output in `r7/work/manifest.json`. It appends its run to `r7/build-log.txt` and re-hashes the live copies and NEW at exit.

| Step | Script | Does |
|---|---|---|
| 0 | `stage.py` | hardlinks the load order into `r7/stage-data`, writes `r7/server-settings.stage.json` |
| 1 | `attribute.py` | classifies every NEW and R4 record into `r7/attribution.json` (read-only) |
| 2a | `pad_masters.py` | pads NEW's masters to 14 so its own index 0x0E is the self index, deletes REFR 0E04B2AB |
| 2b | `merge.py` + `Program.cs merge` | Mutagen: re-keys re-owned records, restores R4 content, forwards city cell data |
| 3 | `proficiency.py` | `../proficiency-patcher/patch.py --next-form-id 0x201D` on the merged base, accepted only if the ids match LIVE |
| 4 | `masks.py` + `Program.cs armor-effects` | clears EITM on the 8 crafted Kad_BogBlightMask.esp masks |
| 5 | `finalise.py` | header and master checks, `r7/AlduinakAdditions.esp`, `r7/rollback/` copy of LIVE |

Run the steps in order from this folder with Python 3 and the .NET 9 SDK. The plugin reaches players only through the deploy steps in
the plan: Update manifest, Sync Data, Build Client and a game service restart.
