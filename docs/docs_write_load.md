# Write load: database saves and logging

Assessment of 2026-09-29 (C27): how the game server writes to MongoDB and to its
logs, what the live box measured, what was changed, and what to change before the
population grows. Everything here was read from code and from the live logs; no
database query was run.

Sources: `C:\logs\gameserver.log` (2026-09-29 03:07 to 14:06, 11 h, 22.5 players
online on average, 48 at peak), `C:\logs\2026-09\gameserver-*.log`,
`C:\Alduinak\mongodb\log\mongod.log` (2026-09-10 to 2026-09-29).

## Summary

| Finding | Share today | At 1000 players | Status |
|---|---|---|---|
| `isDead` read on every activated door, chair or container | 49% of log lines, 46% of bytes | about 400 MB of log a day | Fixed (C27) |
| No index on `changeForms.formDesc`: every save scans the whole collection | 2.4 to 3.2 ms per saved form | saver falls behind (see below) | Owner: create the index |
| `ff_afterlife` not registered in the live gamemode | 1.4% of lines | one 6-line error per login | Registered in the test gamemode; live gets it with Migrate server |
| Papyrus natives the server lacks, skipped scripts, "explosion is not supported" | 12% of lines | about 1.2M lines a day | Recommendation (C++) |
| Login dumps the profile object over 31 lines | 7% of lines | about 700k lines a day | Recommendation (TS) |
| Logging is synchronous on the game thread | all lines | 60 to 130 lines a second | Recommendation (C++) |

## 1. The `isDead` error block (fixed)

Each of these was 7 lines in `gameserver.log`, 7,495 times in 11 hours:

```
[warning] Specified Form is ObjectReference, but we tried to treat it as Actor, likely because of a client bug. formId=0xd6944, baseId=0x845, ...
[console] [error] resolved context with 2 entries (reason=exception):
  | (custom) isDead
  | (uint) 878916
  ╰-- ...\ScampServer.cpp:1249 - Get
  o-- ...\ScampServer.cpp:578 - Tick
```

Cause: not a client packet. `ScampServer.cpp:1249` is `ScampServer::Get`, the
gamemode's `mp.get`. The lines around each block are a door press, a chair or a
container (`[doors] ... pressed`, `TryOccupyFurniture`, `ProcessActivate`):
`HuntingSystem.trySkin` runs on every activation (the skinning hook of 880cb1c1,
2026-09-27) and calls `isAlive(mp, target)` for any target that is not a
player. `isAlive` read `isDead`, which throws for anything that is not an actor;
the JS `catch` answered `false` correctly, but the native binding had already
logged the warning and antigo's context block. The warning exists since 2022 and
appears 0 times in every log until the server started with that build at
2026-09-27 09:04 (first one at 09:07), then thousands of times a day. Any `mp.get` that throws writes the same 6-line block even when the gamemode
catches it.

Fix: `isAlive` (actorUtil.ts) checks `type` first, so a door or a chair answers
`false` without an exception. Same answers for every caller; one extra cheap
property read for actors. Effect: about half of the game server log and one C++
exception per activation gone.

## 2. How saves work

- Any change to a form (`EditChangeForm`) calls `WorldState::RequestSave`, which
  copies the whole change form (inventory, dynamic fields, appearance) into a
  per-form slot on the game thread. Several requests before the next save keep
  only the last copy.
- Movement does not request a save by itself: a position or angle change saves
  only when that form has not requested a save for 30 s
  (`MpObjectReference::IsLocationSavingNeeded`). Anything else saves at once:
  health, magicka and stamina reports (`MpActor::SetPercentages`, sent by each
  client at most every 2 s while they change, for the player and for each NPC it
  hosts), inventory, spells, effects, every `mp.set` of a property (needs are
  written once a minute per player).
- `WorldState::TickSaveStorage` hands all filled slots to `AsyncSaveStorage` when
  the previous batch has finished. Its thread wakes every 100 ms and writes the
  batch as one ordered bulk of `update_one({ formDesc }, { $set: <whole
  document> }, upsert)` (`MongoDatabase::UpsertImpl`). One batch is in flight at
  a time, so a slow database makes batches larger and later, not more numerous.

Measured write rate (document writes per minute, from the WiredTiger checkpoint
transaction counter in `mongod.log`; includes the backend and the test server,
which are small): 1 to 2 when empty, 283 at 45 players (2026-09-29 13h), 420 at
55 players (2026-09-28 17h), peak minute 867. About 7 writes per player per
minute. A player's document is about 12 KB.

## 3. The missing `formDesc` index (owner action)

`MongoDatabase` never creates an index, and `changeForms` is dropped and created
again by every wipe (last on 2026-09-22), so it only has `_id`. The server
filters on `formDesc`, so every saved form scans the whole collection. The slow
query log shows it:

- `update changeForms q: { formDesc: "e9f" }`: `planSummary: COLLSCAN`,
  `docsExamined: 16589` (2026-09-25) and `9996` (2026-09-28).
- 516 bulk saves took over 100 ms (up to 1,023 ms), 37 to 64 forms each, 2.4 to
  3.2 ms per form. Most were on 2026-09-25 and 2026-09-28, the busiest days.

The cost of a save grows with the collection size, and the number of saves grows
with the population, so the total grows with both:

| | Now (45 players, ~10k documents) | 500 players (~25k documents) | 1000 players (~50k documents) |
|---|---|---|---|
| Saves per second | 5 | about 60 | about 120 |
| Per save, no index | 2.7 ms | about 6 ms | about 12 ms |
| MongoDB busy time, no index | 1.5% of a core | about 35% of a core | about 140%: the saver cannot keep up, saves lag and a crash loses more |
| Per save, with index | under 0.3 ms | under 0.3 ms | under 0.3 ms |
| MongoDB busy time, with index | under 0.2% | about 2% | about 4% |

(Document counts at 500 and 1000 players are estimates; the collection also grows
with world state over time, so it gets slower between wipes even at today's
population.)

Recommendation, in `mongosh` as an admin, for both databases (safe while the
server runs; the build takes about a second on 10k documents):

```javascript
db.getSiblingDB("skymp").changeForms.createIndex({ formDesc: 1 })
db.getSiblingDB("skymp_test").changeForms.createIndex({ formDesc: 1 })
```

It must be created again after every wipe (`deploy/mongodb/wipe-world.js` drops
the collection). A lasting fix is to create it in code: in the
`MongoDatabase` constructor (C++, CI flatrim build) or in `wipe-world.js` right
after the drop. A `unique` index would also guard against duplicate documents,
but it fails if any already exist; check first with
`db.changeForms.aggregate([{ $group: { _id: "$formDesc", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])`.

## 4. Other save recommendations (owner decisions)

These change when data reaches the database, so none was done:

- Health, magicka and stamina reports: save them like positions (at most once
  per 30 s per form unless something else saves it), keeping the immediate save
  on death and respawn. It is probably the largest single source of writes
  (every 2 s per player and hosted NPC while a value regenerates). Cost: a crash
  could restore values up to 30 s old.
- `RequestSave` copies the whole change form on the game thread for every change;
  marking the form dirty and copying once when the batch is handed over would
  cut that to one copy per form per batch (C++).
- Documents are rewritten whole (`$set` of every field). With the index this is
  about 1.2 MB/s at 1000 players, which MongoDB handles; writing only changed
  fields is not needed yet.
- The Server Manager opens a new MongoDB connection for each read (about 1,300
  to 3,300 connections a day, each with a SCRAM login). A shared client would
  remove them; it does not affect the game server.

## 5. Log volume

`gameserver.log` holds the native log and everything the TypeScript systems
print. Before the fix: 9.2 MB and 108k lines in 11 hours (about 1 MB an hour at
25 players, 1.8 MB an hour at 55). The month folder holds 154 MB of game server
logs against under 2 MB for all the gamemode's own logs together (`chat`,
`admin`, `trading`, `writing`, `pvp`, `faction`, `bounty`, `pk`), which append a
line per event asynchronously and need no change.

Largest sources in the 11 hours, after the `isDead` block:

| Lines | Source | Kind |
|---|---|---|
| 6,126 + 1,160 | login: `console.log("getUserProfileId:", profile)` and the guid object (login.ts), about 31 lines per login | TS |
| 4,756 | `VirtualMachine::CallMethod - Method not found` (`GetActorBase` 2,056, `GetValue` 1,046, `RegisterForAnimationEvent`, `getStageDone`...) from vanilla furniture and trap scripts | C++ |
| 4,052 | `PapyrusObjectReference::PlaceAtMe - explosion is not supported yet` | C++ |
| 4,068 | `Skipping script <name>` (`TrapOilPool`, `WeaponRackTriggerSCRIPT`, `TrapHitBase`...) on every activation | C++ |
| about 5,200 | crafting: `User N tries to craft`, `CraftService::FindRecipe` twice, `Using craft recipe`, `crafted` (5 lines per craft) | C++ |
| 2,753 | `NpcSpawnSystem`: zone despawned, corpses removed, zone entered | TS |
| 2,706 | `[doors] <actor> pressed <door>` | TS |
| 1,737 + 1,301 | host changes, logged twice: `Hoster of X changed` (C++) and `HostingSystem: X hosted by Y` (TS) | both |
| 2,306 | `[needs]` per gathering action | TS |
| 1,530 | `ff_afterlife` context block, one per login: the property is not registered in the live `gamemode_extensions/50_properties.js` (see `docs_roleplay_foundations.md`) | live file |
| 1,071 | `VarValue::operator> / operator+ - Wrong type` | C++ |

A boot adds about 3,000 lines once (`Skipping deleted form`, `Loaded N
ChangeForms`), which is not a rate problem.

Projection after the fix: about 220 lines and 20 KB per player-hour, so about
30 lines/s and 10 MB/h at 500 players, 60 lines/s and 20 MB/h (about 480 MB a
day) at 1000 players. Without the fix it would have been about twice that.

Recommendations, largest first:

1. Done on the test server: `build/dist/testserver/gamemode_extensions/50_properties.js`
   registers `ff_afterlife` (Build gamemode only there). Migrate server copies the part
   to live. This also makes the realm look reach clients.
2. C++: log each missing Papyrus native, each skipped script and the explosion
   warning once per name per boot instead of on every activation (a static set in
   the VM and in `PlaceAtMe`). About 13k of the 108k lines measured.
3. TS (login.ts): print the profile and the guid check on one line each, with
   only the id and discord id. Nothing parses these lines (the manager's
   playtime reads `Server Login:`, `SetUserActor`, `disconnect` and the
   `QueueSystem: N play slots` boot line).
4. C++: one line per craft (the `crafted` line), the recipe lookups at trace.
5. Host changes: keep the TypeScript line, which carries the reason; drop the
   native `Hoster of` line to debug.
6. C++: make the `console` logger asynchronous (`spdlog::async_logger`), so a
   slow stdout pipe (nssm writes it to the file) never stalls a tick. Raising
   `logLevel` to `warn` instead is not an option: it would also drop every
   TypeScript info line, including the ones the manager's playtime reads.

## Re-measuring

- Log lines per message: `sed -E 's/^\[[^]]*\] //; s/[0-9]+/N/g' C:/logs/gameserver.log | sort | uniq -c | sort -rn | head -40` (Git Bash).
- Write rate: every minute `mongod.log` has a `saving checkpoint snapshot min: N`
  line; the difference of `N` between two lines is the number of document writes
  in that minute.
- Slow saves: `"Slow query"` lines whose command is `"update":"changeForms"`;
  after the index they should disappear, and a per-form line should show
  `IXSCAN { formDesc: 1 }` instead of `COLLSCAN`.
