# Syncing baseline (live, before Stage 2)

Taken 2026-10-05 06:05-06:10 (UTC-7) on the live Main Server, read-only, with about 6 players online (early hours). Phase 1 was on the Test Server only, so these numbers are the pre-Stage-2 live state. Re-take the same measurements after each Migrate to compare.

| Measure | Value | How |
|---|---|---|
| Game server CPU | 6.84 CPU s over 305 s = 0.022 cores (2.2 % of one core) | `Get-Process` TotalProcessorTime of the live node process (pid 12492), sampled 305 s apart |
| Game server memory | working set 1,699 MB, private 1,586 MB | same process |
| Boot (03:00 restart) | `AttachSaveStorage took 2 seconds and 609 milliseconds, loaded 23685 ChangeForms (Including 226 player characters)` | `C:\logs\gameserver.log` |
| changeForms | 27,926 docs, 29.1 MB data, 7.1 MB on disk; 4,208 `isDeleted`; 230 characters | mongosh `changeForms.stats()` and counts |
| Indexes | `_id_`, `formDesc_1`, `worldOrCellDesc_1`, `profileId_1` | `changeForms.stats().indexSizes` |
| Box network (whole NIC: game, voice, web, test) | sent 81-222 KB/s and 292-337 packets/s; received 36-47 KB/s (two 5 s samples) | `Get-Counter '\Network Interface(*)\...'` |
| Game server log volume | 25.1 MB for the previous day (`gameserver-2026-10-05_03-00-04.log`) | file size |
| Mongo writes per minute | not measurable: `serverStatus` and `top` need the clusterMonitor role, which `skympuser` lacks | grant clusterMonitor or use an admin login to measure |

Not measured: client FPS in a fixed scene and reconnect time (need players in game), tick time (`skymp_tick_duration_*` included the 1-16 ms wait and Phase 1 removes it).
