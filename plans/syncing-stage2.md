# Syncing: Stage 2 plan

This plan is built from `plans/syncing-stage1.md` (taken at 46bd03e6) and the six reviewed design lanes: L1 persistence, L2 streaming and hosting, L3 transport and movement, L4 actor state, combat and magic, L5 server TS runtime, L6 client view. Where a reviewer revised a proposal, the revised version is used. Missed items get ids like `L2-M1`. Leftovers from Stage 1 that no lane covered get `X-`. Numbers marked "est." are estimates. Every other number was counted or measured in Stage 1. Each task is one commit.

## 1. The short answer

Most of the cost is work repeated when nothing changed:
- idle players report their movement 7.5 times a second, and the server relays every report to everyone nearby, the sender included;
- about 30 TS loops wake every 1-16 ms just to check a clock;
- the client re-runs every FormView every frame;
- the server rewrites whole documents on timers.

The biggest wins, by payoff:
- **Movement sent only on change, with distance tiers:** about 75% fewer movement packets per player in a crowd.
- **Plugin refs streamed only when they differ from the ESP:** entering a city drops from 569 creates to tens.
- **A dirty-driven client view:** about 60,000 to 3,000 native calls a second in a busy scene.
- **Saves on events instead of timers:** about 35 to 2 whole-document writes a minute per active player.

Boot gets lighter: one filtered, sorted cursor; the 3,717 dead docs purged; no CRC of 5.35 GB of BSAs; and, last, characters loaded only at login.

About 4,000 lines of dead code go: SweetPie, the gamemode-function shipping, MockServer, the raw-message path and unused drivers. The open authority holes close too: the anim-var target, spell hits tied to a cast, reach and speed checks, and packets sent before login. Every new check runs log-only first.

The order:
1. Server TS, which needs no native build.
2. Two native server builds that change nothing players see, apart from less traffic.
3. Client release A.
4. The streaming and hosting redesign, and the persistence redesign. These two are independent.
5. Client release B, which carries the only protocol break.

That is two client releases and four native server builds in total. Per-zone database loading is not recommended (D1). The world deltas fit in memory, and chunk loads run inside the tick, so "indexed per zone" becomes "indexed per player, with the world held in memory". Stage 2 does not raise the 1300-players-per-process cap (CMakeLists.txt:47, D33).

| Phase | What it does | What it buys (est.) | Risk | Ships |
|---|---|---|---|---|
| 0 Baseline | Measure before changing | Proof of the gains | none | none |
| 1 Server TS | Plain timers instead of 30 busy loops, one online snapshot, no slot scans, event-driven titles, admin sync, deaths and torches, refDecor deltas, no BSA hashing | 1-15k async wakes/s → ~30; ~460k → ~7k N-API/s at 1,000 players; 5.35 GB less boot I/O; refDecor 110-350 KB → <200 B per user per claim change | low-med | server-ts, gamemode, backend |
| 2 Native N1 + N2 | Boot cursor and indexes, dead docs purged, chunk-loader fixes, slimmer creates, worn-only gear to neighbours, caches, ~2,000 lines of dead code, server ready for event-driven movement, log-only authority | Boot -3,717 docs, peak memory ~60 MB → one doc; appearance parses per hit 2-7 → 0; equipment relay 2-10 KB → <1 KB; 4-7 GB/day less log | low (2A), med (2B) | native-server, server-ts, gamemode, db-migration |
| 3 Client A | Send-on-change movement, one packet parse, id maps, trimmed FormView, event-driven polls, chat as a packet, decor as a property, voice range as a property | Upstream movement -64%; 47 → 1 parses per packet; ~60k → ~16k natives/s in a busy scene; the 5,000-getFormEx hitch every 0.5 s gone | medium | client (+ server switches at release) |
| 4 Streaming and hosting (N3) | Stream only changed refs, load pickables on first touch, hysteresis, one broadcast helper, server-driven hosting, no movement echo, distance tiers | City entry 569 → ~10-40 creates; 30-player area ~225 → ~55-68 packets/s per player; a host of k NPCs gets 1 copy, not k+1 | medium | native-server, server-ts |
| 5 Persistence (N4) | Dirty-set saver, graceful stop, no timed saves, FF id allocator, transient NPCs, registries moved onto changeForms, delta compaction, characters loaded on demand | Active player ~35 → ~2 whole-doc writes/min; NPC writes → 0; boot ~23k → ~12k docs; offline characters not held | med-high | native-server, server-ts, gamemode, db-migration |
| 6 Client B + protocol | Compact sequenced movement, ordered channels, dirty FormView scheduler, host claims deleted, native hook pre-match | Movement packet 59 → 40-44 B; idle forms cost 0 natives/frame (~3k natives/s total) | med-high | client, native-client, native-server |

- Phase 5 can run alongside Phase 4.
- Phase 6 needs Phase 4 (L2-15) live.
- Live files this plan changes:
  - gamemode_extensions, in Phases 1, 2B, 3 and 5;
  - server-settings.json keys: `gamemodeHotReload`, `combatTrace`, the speed, reach and activation limits, the tier radii, `npcCorpseWatch` and the unload delay.
  - They reach live only through Migrate server and settings.

## 2. Phase 0: baseline

| Measure | How (all of this exists today) |
|---|---|
| Boot doc count and time | Game server log in `C:\logs` after the 01:00 restart: `AttachSaveStorage took` (L1-01 removes this line, so read it now) and `loaded N ChangeForms (Including M player characters)`. Also the time from service start to that line. |
| Server CPU | `Get-Process` CPU seconds of the AlduinakGameServer node process, sampled 60 s apart, with the player count from the manager. |
| Tick time | `skymp_tick_duration_*` on `/metrics`. L5-19 deletes it. It includes the 1-16 ms wait, so record it only as a reference. |
| Mongo writes | mongosh: `db.adminCommand({top:1}).totals["skymp.changeForms"].update.count` twice, 10 min apart. Doc counts by category using the Stage 1 §5 recipe. |
| Server egress | `Get-Counter '\Network Interface(*)\Bytes Sent/sec','\Network Interface(*)\Packets Sent/sec'` over 5 min at a known player count, with voice idle. |
| Ping | The native ping histogram on `/metrics` (Networking.cpp:282-311). |
| Client frame | FPS from the Windows Game Bar overlay in one fixed scene: Whiterun market, 10+ testers, 60 s. Also the growth of `skyrim-platform.log` per minute. |
| Reconnect hitch | Time from `connectionAccepted` to control returning, from `skyrim-platform.log` timestamps. |

## 3. Phases

### Phase 1: Server TS and gamemode

This phase needs no native build and no client release. It ships with manager "Build server" plus a Test Server restart (gamemode files hot-reload on test), then reaches live through one Migrate server. Deletions go first, then the shared helpers, then the systems that use them.

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L5-19 | Delete the tick Histogram and Summary and their per-tick timers (metricsSystem.ts:29-57, index.ts:414-423). Delete the `/rpc/:rpcClassName` route (ui.ts:52-66). Keep `/metrics` and the connect and login counters. | ~40 lines and a dead route | 2 timers + a t-digest push per tick | low | — | server-ts |
| L5-20 | Delete MasterApiBalanceSystem, its registration (index.ts:56,386) and the `userAssignSession` emit (login.ts:137). | ~110 lines | 2 log lines per connect | low | — | server-ts |
| L5-23 | manifestGen.ts:48-57 stops reading BSAs. Plugin CRCs are cached in `data/manifest-cache.json` by name, size and mtime. | BSA hashing | 5.35 GB read + CRC32 per boot (5-30 s, >1 GB peak) | low | — | server-ts |
| L5-22 | Gamemode hot reload behind a `gamemodeHotReload` setting, off by default. Set it to true in the testserver settings. | Watcher on live | safety | low | — | server-ts, settings |
| L5-02 | Add `onlineActors()` and a `connectedUsers` set to actorUtil.ts. The 8 user-slot scans switch to them (admin, afk over its states, faction, goldWatch, housing, placedItem, time, writing). Delete `userSlotCount`. | 8 scans of 1,300 slots | ~500-825 isConnected calls/s with 0 players; event paths stop scaling with maxPlayers | low | — | server-ts |
| L5-01 | Add `systems/timers.ts` with `every`, `after`, `KeyedTimers` and `soon`. Each `updateAsync` becomes a named poll on a plain timer at its real cadence. Active-only loops keep their `if (!set.size) return` gate. Housing pushes via `soon()`. Delete `System.updateAsync` and index.ts:428-444. | 30 `setTimeout(1)` drivers and their gate fields | 960-15,000 async resumes/s → ~30 wakes/s idle | medium | L5-02 | server-ts |
| L5-03 | Add `onlineSnapshot.ts`: a 500 ms snapshot of {actor, user, cell, pos} with `byCell`, `near()` and a name/profile cache cleared on assign. npcSpawn zones are indexed by cell. Consumers: npcSpawn, worldFloor, weather, job offers, housing `noticeAround` and gm `players()`. afk keeps `locationalData` because it needs rotation. | Per-system position reads | npcSpawn alone 439×N N-API/s; total ~460k → ~7k/s at N=1000 | low | L5-02 | server-ts, gamemode |
| L5-10 | Weather reads the snapshot and re-resolves a player's region only on a cell change or after 1,024 units of movement. | | ~2,000 N-API/s at N=1000 | low | L5-03 | server-ts |
| L5-26 | World floor and border check on the snapshot. `isAlive` and `locationalData` are read only for a player below the floor or outside the border. | | ~6,000 N-API/s at N=1000 | low | L5-03 | server-ts |
| L5-09 (+L2-19) | Drop the 60 s `gameTime` broadcast. Every 60 s check the UTC offset, and only when it changed send to `connectedUsers`. Keep the sends on connect and on request. | Broadcast | N packets + 1,300 calls per min | low | L5-01, L5-02 | server-ts |
| L5-11 (+L1-13 torch part) | Each lit torch gets a burn-out `KeyedTimer`. Delete the 5 s loop and `SAVE_MS`. A douse from the equipment hook saves via `soon()`; a burn-out saves itself. | Loop and the 60 s saves | 2 N-API per torch per 5 s + 1 whole-doc save per torch per min | low | L5-01 | server-ts |
| L5-13 (+L5-M5) | No 5 s title refresh. A `titleShowers` map tracks title holders, and only factions where the arriving or leaving actor leads or is regent are re-titled. The access file is watched through a shared `watchFileDebounced` taken from jobSystem.ts:585-601 and npcSpawnSystem.ts:941-957. Definitions refresh with `every(20 s)`. | 5 s pass, statSync poll, one watcher copy | ~1,060 N-API/s at N=1000 | low | L5-01, L5-02 | server-ts |
| L5-14 | Afterlife confines only an `onlineFallen` set. Entries leave on revive, disconnect, menu quit and character select. | | ~500 mp.get/s at N=1000 | low | L5-01 | server-ts |
| L5-15 | Gathering: seat activations via `soon()`; one regrow timer at the earliest due time (armed at WORLD_LOADED, hidePicked and retry); one strike timer per session; `seatFree` runs `stillSeated` first. | Per-pass work | 320-5,000 N-API/s → 6 per strike, per chop session | medium | L5-01 | server-ts |
| L5-16 | Mastery: a `banked` set, paid every 60 s; `enqueue` drains via `soon()`; pendingGrants and factionCraft pending use `after()`. Needs and survival keep `every(1 s)`. | 5 s bank load of every player | ~200 record loads/s at N=1000 | medium | L5-01 | server-ts |
| L5-24 | goldWatch samples dirty actors every 10 s (existing hooks, `onActivate`, move packets) plus a full sweep every 60 s (D24). | | 100 → ~17 inventory reads/s at N=1000 | low | L5-01, L5-02 | server-ts |
| L5-M1 | Housing refDecor: logins get a memoised full list; each claim write sends a 1-2 entry delta through `soon()`. The interim fix until L2-17. | Full list per write | 110-350 KB per user per lock toggle → <200 B | low | L5-01 | server-ts |
| L5-07 | gm 70_admin_loop.js becomes `__alduinakSyncPlayer`, wired to `mp.onUserAssignActor` (spawn.ts already calls it at 627 and 992), to the console `admin add/remove` and to `ACCESS_REFRESHED_EVENT`. `isAdminActor` reads profileId with `safeGet`. | 5 s loop | ~1,000 mp.get/s + O(N²) finds + ff_knownIds copies | low | — | gamemode, server-ts |
| L5-M4 | gm 15_players.js keeps a Map by actorId. The `players().find` calls in 35_admin_chat, 20_logging, 30_introductions and 33_chat_at_ref use it. | | ~1M comparisons per staff line at N=1000 | low | L5-03 | gamemode |
| L5-M2 | `__alduinakKnown` caches each player's ff_knownIds as a Set. The sender's title is computed once per line. TS `knowsOf` and tradeSystem reuse the cache. | Two copies of the knows helper | ~1,000 array copies (≤2,000 ids each) per s at 100 lines/s | low | — | gamemode, server-ts |
| L5-05 | Add `guardMpHook` next to `chainMpHook` and convert the 33 hand-written wrappers. Companion's `onHitDamageAttempt` is three-phase, and gathering and search pass their phase-1 verdict to the chain. | ~300 lines; the 4-argument truncation | bug fix | medium | — | server-ts |
| L5-06 | TS owns `onDeath`, `onHitDamage` and `onConsoleCommand`, and re-asserts its dispatcher after every gamemode load. Gamemode handlers go into `g.__alduinakHandlers` lists. Delete 62_mastery.js; its kill relay moves to masterySystem. soulTrap and pet hear deaths via `onDeath` + `soon()`. | 62_mastery.js and two isDead polls | 10 reads per trap per s, 1 per pet per s; a hot reload can no longer overwrite TS hooks | medium | L5-05 | server-ts, gamemode |
| L4-25 | adminSystem's hit-refusal hook handles smite (NPCs, deferred) and healhit. Delete 60_admin_modes.js:58-66. | Double smite, unreachable god branch | 3 mp.get per damaging hit | low | L5-06 | server-ts, gamemode |
| L4-26 | Move all of 55_death.js (alerts, pvp.log, NPC spawnDelay) into a TS `onDeath` hook in bleedoutSystem. Delete 55_death.js, `markDeathAlerted` and `__alduinakDeathAlert`. | Dedup map, 2 globals | — | low | L5-06 | server-ts, gamemode |
| L5-M3 | npcSpawn marks deaths from `onDeath`. Delete `checkDeaths` except a slow check for vanished forms. `watchCorpses` goes behind `npcCorpseWatch`, off on live. | | isDead per NPC + pos/navmesh per corpse every 2 s | low | L5-06 | server-ts |
| L5-04 | index.ts customPacket: one `JSON.parse` in try/catch with an object check. The gamemode gets the parsed object through `__alduinakPacketRoutes`, with an `__alduinakTsRouter` compat flag; plugin `on()` keeps working. Delete the empty listener (488-490) and the MasterClient no-op. Pre-login gate: one week log-only, recording each type and count, then only `loginWithSkympIo` before `LOGIN_VERIFIED`. | Gamemode's second parse, empty listener | 1 parse less per packet; closes the pre-auth surface | medium | — | server-ts, gamemode |
| L1-14A | bodySystem drops bodies.json and keeps its `private.indexed.pkBody` lookup (bodySystem.ts:300-328). | bodies.json and its sync writes | — | low | — | server-ts |
| L4-27 (TS) | Block stamina reads the blocker's armor weight from a Map, cleared on `onUpdateEquipmentAttempt` and on disconnect. | getCombatStats per blocked hit | — | low | — | server-ts |
| L5-18 (+L4-35, L2-18) | Grab TTL via `after()`; delete the 60 s loop. FF items: `itemMoved` goes to actorNeighbors mapped to users, the carrier always included, with no `itemGrabbed`. Plugin refs: snapshot users in the same cell, or the same worldspace within 3×4096 units, and `itemGrabbed` is kept. | 1,300-slot scan per carry event | per grab or move ~900 → ~10 packets at N=1000 | low | L5-01, L5-03 | server-ts |
| L5-21 | wsRelay.js: delete the player role, the nonce, `chat_*` and `playerSockets`. Bind 7778 to 127.0.0.1 (D27). | ~60 lines | attack surface | low | — | backend (restart AlduinakBackend) |

- **L5-01:**
  - `every()` must catch sync and async errors, log each distinct error once and keep rescheduling.
  - Housing lock changes stay immediate (`soon()`, not a 4 s debounce).
- **L5-04 / L5-06:**
  - On test, "Build server" hot-reloads the new gamemode before the restart brings the new TS.
  - The compat flag (L5-04) and the dispatcher re-assert after each `requireUncached` (L5-06) make either landing order safe.
- **L5-11:** the equipment hook runs inside the native stack. Never write from it.
- **L5-15:** without the `stillSeated` check in `seatFree`, a chopper who stood up blocks the station until the next strike.

### Phase 2: Native server builds N1 and N2

Two builds, each with its TS halves. Prefer CI flatrim, or a local build at below-normal priority, because the box CPU is shared with the live game.
- **2A** changes nothing players see.
- **2B** changes behaviour, and every new authority check is log-only.
- **Migration M1** goes with the deploy. It is `deploy/mongodb/trim-changeforms.js`, built on strip-common.js: dry run by default, `--apply` refuses while the service runs, `--test` targets skymp_test. Its steps: purge isDeleted docs, swap indexes, add `numChanges`, backfill `ff_decor`.

**2A: deletions, slimming, fixes (no visible change)**

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L1-01 | `MongoDatabase::Iterate` (MongoDatabase.cpp:133-309) becomes one `find`: filter `{isDeleted:{$ne:true}}`, sort `_id`, batch 1000, one reused simdjson parser, and the sanitizer restore only when `_enc_keys` is present. On a cursor error it restarts the same find and skips formDescs already passed. The callback takes the form by reference (PartOne.cpp:359). One summary line keeps the `loaded N ChangeForms (Including M player characters)` text and adds a count per skip reason. | 100 threads, skip/limit, count_documents, the Sha256 chain, per-doc logs (~120 lines) | ~1.33M docs walked → 26.9k; peak ~60 MB → 1 doc; ~4.7k log lines → 1 | medium | — | native-server |
| L1-08 | The MongoDatabase constructor ensures a unique `formDesc_1` and a partial `{profileId, formDesc}` index. An M1 step drops the old indexes. Delete server-manager formDescIndex.js, its call (services.js:83-89,109) and tools/test-formdesc-index.js. | ~200 manager lines, `worldOrCellDesc_1` | indexes exist after every start, including 01:00 | low | — | native-server, db-migration, manager restart |
| L1-02 | `UpsertImpl` deletes the doc of an isDeleted form. The boot tombstones FF items without `private.placedAt` and logs each one. An M1 step runs `deleteMany({isDeleted:true})` except characters (D3). | 3,717 dead docs, soft deletes | 13.8% of boot docs | low | L1-01 | native-server, db-migration |
| L1-M6 | An M1 step sets `equipmentDump.numChanges = 0` where it is missing. JsonToChangeForm then parses equipment once and drops its per-doc info line (MpChangeForms.cpp:215-234). | Second parse | 1 nlohmann parse per actor doc load | low | — | native-server, db-migration |
| L1-12 | DynamicFields drops `jsonCache`. Dumps are built from simdjson. `ForEachValueDump` iterates by const reference. | Second nlohmann tree per form | tens of MB; one parse per doc | low | — | native-server |
| L1-18 | Delete the Zip and Migration drivers and their test, `find_package(libzippp)` and vcpkg.json:18, `MpChangeForm::quests` and Quest.h. | ~420 lines, libzippp/libzip | build time | low | — | native-server |
| L1-M5 | One profileId predicate, `>= 0`, in RegisterProfileId, `MpActor::BeforeDestroy` and PartOne. | | correctness for L1-07 | low | — | native-server |
| L1-10 (parts 2, 3) | `SetLastAnimation` uses NoRequestSave. `SetPropertyValueDump` and `RegisterPrivateIndexedProperty` skip the edit when the dump is unchanged. | | saves for an unsaved field and for no-op `mp.set` | low | — | native-server |
| L2-05 (+L1-05, L1-M2) | WorldState: `LoadForm` returns early for a loaded form; the deferred delta is extracted, not copied. New `CombineBrowser::GetRecordsAtPos(fileIdx, …)` is called once per file with that file's own mapping. The chunk loop skips ids already in `forms`. Attach failures go into an unordered_set, only for `LookupFormById` ids or ids with a delta. | Dangling `refrByIdxUnreliable`, stale delta re-apply, second delta copy | 8,100 → 90 lookups per chunk; up to ~20 MB | low | — | native-server |
| L1-06 (+L2-07, L2-M1) | `GetNeighborsByPosition` gains a `loadChunks` flag. `ForceSubscriptionsUpdate` passes true only for actors, and never during the boot load. TS `getNeighborsByPosition` and Papyrus VisitNeighbours still load chunks. | Chunk loads around boot FF forms and around single-loaded refs | the first login after a restart stops loading every claimed door's 3x3 (3,166 claims) in one tick | medium | L2-05 | native-server |
| L2-01 | `onUnsubscribe` sends no DestroyActor for non-actor, non-DOOR ESP refs (PartOne.cpp:958-973). | | 56-1,056 messages per crossing, each a client `syncFormArray` | low | — | native-server |
| L2-09 (+L4-M4, L3-07c) | `Disable` calls `UnsubscribeFromAll` and clears `primitivesWeAreInside`. `Subscribe` returns when nothing was inserted. `sendToUser` and `sendToUserDeferred` (PartOne.cpp:740-799) resolve the user and `disconnectingUserId` before serializing. | Parked listeners | one serialization per send to parked characters and NPCs | low | — | native-server |
| L1-M4 (+L2-08 destroy part) | `BeforeDestroy` calls `RemoveFromGridAndUnsubscribeAll` and `UnsubscribeFromAll` instead of `SetPos(-1e9)`, clears `primitivesWeAreInside` without sending OnTriggerLeave, and unregisters every `private.indexed` key. | int16 overflow chunk, stale index ids | — | low | — | native-server |
| L2-11 (+L2-M6) | Angle is set before position in Papyrus MoveTo (PapyrusObjectReference.cpp:734-738), `LocationalDataBinding::Set` and `MpActor::Teleport` (1816-1818). placedItemSystem.move drops its first `mp.set` (191). Delete `ScampServer::Place`. | ~35 lines | 1 pass + 1 save per MoveTo or carry move | low | — | native-server, server-ts |
| L2-12 | SetPos: bounding-sphere pre-test, skip an empty inside-set, and per emitter a cached "has an OnTrigger handler"; no dispatch when there is none. | | per packet × triggers the actor is inside | low | — | native-server |
| L2-M2 | Subscribe fires OnInit, OnCellLoad and OnLoad only when the REFR or its base has VMAD (cached). `Skipping script` logs go to debug. | | ~1,700 JS crossings on a city's first visit | low | — | native-server |
| L2-13 (+L4-03, L4-M6) | Neighbour CreateActor: learnedSpells and base AVs only for the owner, no templateChain, `ChangeForm()` by reference, one appearance parse, `private.*` skipped inside the visitor, no top-level isDead. | | 0.2-0.6 KB of learnedSpells + tens of KB of private dumps per create | low | L4-01 | native-server |
| L4-04a (+L2-M4, L3-M5) | Neighbours get only worn and wornLeft entries plus spell slots, both in CreateActor (PartOne.cpp:868-870) and in a server-serialized UpdateEquipment relay (ActionListener.cpp:884-890). The hit-source check also reads `GetInventory()` (1693-1707). | | 2-10 KB → 0.3-0.8 KB per relay × listeners, and per create | low | — | native-server |
| L1-M3 (+L2-M3, L4-23 copies) | `ChangeForm()` const reference instead of `GetChangeForm()` copies at: MpObjectReference.cpp:1023; MpActor.cpp:181, 382, 411, 460, 1621, 2095, 2189, 2199, 2302; PartOne.cpp:715; ActionListener.cpp:1693, 2072, 2299, 2321; TES5DamageFormula.cpp:132. OnUpdateEquipment copies the message only when it substitutes something (829). | | one 12-16 KB copy per hit, per Subscribe, per create | low | — | native-server |
| L4-01 | MpActor caches: the parsed Appearance keyed to the dump (`shared_ptr<const>`); the race id; BaseActorValues keyed on base, race and templateChain (reset at 1421 and 1520). The croppers get the precomputed base values. | | parses: 2-3 per weapon hit, ~7 per spell hit, 3 per ChangeValues, 4 per create → 0 | low | — | native-server |
| L4-05 (+L3-16 part 3) | `SendInventoryUpdate` only marks the user dirty (when a user exists) with the expected actor id. `TickDeferredMessages` builds one SetInventory per dirty user. The mark is cleared on disconnect and `SetUserActor`. | N-1 serializations per tick | take-all of 40 items: 40 → 1 | low | — | native-server |
| L4-23 (+L4-M5) | Caches: `IsSpellInTemplateTree` per base; `FindHitPoison` per base and templateChain; per-spell ward, restorative, cast-type and paralysis facts; a granted-spell → parent map for `CanHitWithSpell`'s fallback. | | ≤512-node BFS per NPC hit or cast; GetBaseSpells per cloak tick | low | L4-01 | native-server |
| L4-22 | Per-hit and per-cast info logs go to debug: AlduinakDamageFormula.cpp:377-398; ActionListener.cpp:1425-1429, 1699, 1781, 1849, 2141, 2230, 2408-2443, 2516-2531; Durability.cpp:277-282; needsSystem.ts:463. A `combatTrace` setting turns the formula line back on (D18). | | 4-7 GB/day of log at 200 hits/s | low | — | native-server, server-ts |
| L4-19 | `ApplyMagicEffect` keeps a stronger, longer effect already on the same AV. | Wrong replace rule | correctness | low | — | native-server |
| L4-42 | Durability `lastHitAt` merges into HitRules `lastCombatAt`. Disconnect erases the actor from `refusedHealthIncreases`, the guards and the ward and restoration channels. | Second clock, maps that never shrink | — | low | — | native-server |
| L4-36 | An FF item pickup deletes without `SetHarvested` (MpObjectReference.cpp:1514-1530). | | 1 UpdateProperty per listener per pickup | low | — | native-server |
| L4-M2 | `OnActivate` calls `EquipBestWeapon` only for a WEAP pickup (ActionListener.cpp:1000-1006). | | an equipment copy + inventory walk per NPC door use | low | — | native-server |
| L4-29 (=L5-12) | Durability `Flush` fires `onItemWorn(actor, [[base, before, after, worn]])`. durabilitySystem drops `updateAsync`, `watchWear` and `wornSeen`. | 10 s wear poll | 100 durableCopies reads/s at N=1000 | low | — | native-server, server-ts |
| L4-27 (native) | Delete the never-read `blockStamina` C++ parse (AlduinakCombatSettings.cpp:909-912, .h:276-277). The settings key stays. | | — | low | L4-27 (TS) | native-server |
| L3-03a (+L4-M3) | SendToNeighbours skips the sender's user for UpdateAnimation, UpdateAnimVariables and SpellCast. UpdateAppearance keeps its echo; the equipment and movement echoes wait for L3-03c. | Own echoes, the error on every own cast, the host replaying its NPC's animations twice | 1/P of these relays; all of them for a player alone | low | — | native-server |
| L3-14 | MessageSerializer becomes binary-only. `HandleMessagePacket` drops non-client types before deserializing. A user without an actor may send only CustomPacket. "No actor" handlers return quietly. The `DoMessage` test helper serializes to binary. | JSON branch | ≤33 parses per crafted packet; log spam | low | — | native-server |
| L3-16 | The drain gets a per-user packet budget plus a global cap per tick. `TickDeferredMessages` walks dirty users only. `UpdateMetrics` loops connected ids and removes a slot's gauge on disconnect. | Retry loop, slot walks | ticks stay bounded under a flood | medium | L4-05 | native-server |
| L3-17 | `PreparePropertyMessage_` reads the cached `GetBaseType()`. | ESPM lookup per UpdateProperty (up to ~90 per-file lookups) | — | low | — | native-server |
| L3-M6 | At most 1 HostStop per user and actor per second, and 1 refusal log per 30 s (ActionListener.cpp:415-443). Same for Teleport2 (MovementValidation.cpp:22-32). | | 7.5 error lines + reliable replies per s per stale NPC | low | — | native-server |
| L3-M7 | OnUpdateMovement compares worldOrCell with a cached formId and rejects a bad file index without throwing (FormDesc.cpp:84-108). | | 1 string allocation per report (~22.5k/s at 1,000 players) | low | — | native-server |
| L4-40a | Delete SweetPie native code: the AnimationSystem callbacks (keep blockStart/blockStop and the power note), `weaponStaminaModifiers`, the SweetPie formulas (348 lines), DamageMult at 1, the `hasSweetpie` parameters, the SweetCantDrop checks, SweetHidePlayerNamesService, and their tests. | ~1,000 lines | 2 formula hops per hit; a keyword walk per put, take and drop | low | — | native-server |
| L3-13 (server) | AddUser stops sending UpdateGamemodeData. Delete the JS signer, `MakeEventSource`, `OnCustomEvent` and its parser case, and both message headers. Remove the settings key from settingsSchema.js:40. | ~350 lines | clients can no longer fire `mp._*` handlers | low | — | native-server, manager restart |
| L3-15 (server) | Delete MockServer and packet history (ScampServer.cpp, PartOne.cpp:616-650 and 1008-1083, ServerState.h, PacketHistoryWrapper.*) and scampNative.ts:51. | ~250 lines | 1 MockServer tick + 2 map walks per tick | low | — | native-server, server-ts |
| L4-41 (server) | Delete `RemoveAllMagicEffects`, `SetActorValues` and OnWeaponHit's `isUnarmed`. One `kUnarmedSource` in HitData.h. combatReadoutSystem uses `durableCopies` mapped to `{worn: worn‖wornLeft, left, maxHp‖null}`. | ~150 lines, 4 copies of a constant | — | low | — | native-server, server-ts |
| X-01 | The rest of Stage 1 §6's dead code: GridElement.h, GridPosInfo, `GridImpl::IsNeighbours` and the test-only grid getters with their tests (WorldState.h:6, MpObjectReference.h:27-38, Grid.h:54-66,100-105); the empty if at WorldState.cpp:610-611; the commented-out crop block and its unused `hasActiveMagicEffects` (CropRegeneration.cpp:75-78); the outdated comment at MessageSerializerFactory.cpp:70-73. | dead code | — | low | — | native-server |

- **L1-01:** keep the exact `loaded N ChangeForms` text, because the wipe docs tell the owner to look for it (docs_database_wipe.md:156, docs_wipe_and_lock.md:107). Compare the per-category counts against the old build on skymp_test.
- **L1-02:** the boot tombstone also deletes a drop whose `placedAt` write was lost in a crash. Each one is logged by formDesc.
- **L1-08:**
  - Every boot logs an index conflict until M1 has dropped the old non-unique index.
  - Restores and wipe-world now fail loudly (E11000) on a duplicate formDesc instead of silently duplicating it.
- **L2-05:** the per-file raw mapping must stay. A single shared lookup would drop refs from DLCs, Update.esm and AlduinakAdditions.esp.
- **L1-06:** needs L2-05's guard in the same build. Test a claimed house door after a restart: the first player must see its decor and lock.
- **L1-12:** dumps must print exactly like `JSON.stringify`, or the discordId and pkBody lookups miss after a reload.

**2B: behaviour changes, authority log-only**

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L3-02 | Block, players only: active on blockStart or an `isBlocking` report; ended by blockStop or by a `!isBlocking` report at least 400 ms after blockStart. `hostResetTimeout` and `LIVE_MS` go from 2 to 3 s. OnUpdateMovement skips SetPos/SetAngle for unchanged keepalives, with a `positionSavePending` flag and a `primitivesDirty` re-test. | 5-report block counter | ~1 write/min per idle player, ~2 per hosted FF NPC; polygon tests for idle reports | low | — | native-server, server-ts |
| L3-04 | Split SendToNeighbours: the paralysis gate and MovementValidation run before the relay. A horizontal speed bound `vmax·max(dt,0.13)+256`, log-only behind a setting (D11). | Relaying rejected reports | authority (~31,500 units/s hole) | medium | L3-02 | native-server |
| L3-11 | `OnUpdateAnimVariables` drops a message unless `actorRemoteId` is the sender's own actor, and returns quietly when the sender has no actor. | | closes "drive any actor's graph" | low | — | native-server |
| L4-14 | IsHeldScroll, CanCastSpell and IsSpellBlocked run before `onSpellCastAttempt`. A keep-alive takes the fast path only when the same caster and spell were fully validated within 8 s; the fast path skips Papyrus OnSpellCast. | Fatigue charged for refused casts | 1 Papyrus event + 1 JS crossing + a BFS per keep-alive | low | L4-23 | native-server |
| L4-21 | Move `onHitAttempt` below the target, cell, distance and dead-aggressor checks. | | the JS crossing for hits those checks refuse | low | — | native-server |
| L4-24 (server) | Dead target: send Papyrus OnHit, then return before pricing and wear. Dead aggressor: drop with a debug line, no `RespawnWithDelay` (D16). | | per corpse swing: 2 crossings, a formula run, a ChangeValues | low | — | native-server |
| L4-M1 (server) | `OnActivate` logs at debug and returns for a caster the sender does not host, instead of throwing (ActionListener.cpp:976-983). | Exception + log line | per NPC activation in view | low | — | native-server |
| L4-30 | `OnActivate` refuses a non-closing activation farther than `maxActivateDistance` (default 1024), log-only first. | | authority | medium | — | native-server |
| L4-38 | Player melee reach is `GetReach × fCombatDistance + meleeSlack`, log-only. `maxShotDistance` applies to every bow and crossbow shot. NPCs keep the bounds helpers. | Commented-out call | authority | medium | L4-01 | native-server |
| L4-39 | A per-caster (spell, time) map, shared with L4-14. OnSpellHit needs a recent cast of the spell or of one that grants it (log-only). At most 1 hit per aggressor, target and spell per 90 ms (enforced). | | authority | medium | L4-14 | native-server |
| L4-02 | `MpActor::SetAppearanceAndBroadcast(app, deferred)`: the client RaceSex path sends at once; AppearanceBinding keeps deferred channel 2. Enforce "raceId is a RACE". HDPT, TXST, weight, name and tint caps from settings, log-only (D19). | Binding re-parse | closes the validation gap | low | L4-01 | native-server |
| L4-20 | One source for racial magic resistance. Recommended (D15): keep the conditional entries and delete the native path and its guards (ScampServer.cpp:84-110, 625-667). | ~60 lines | — | low | — | native-server, settings |
| L2-03 | AttachEspmRecord skips a LIGH that cannot be carried when neither the REFR nor its base has VMAD and no deferred delta exists. Precondition: a read-only count of such deltas (expect 0). | | 12,058 refs never load (8% of loadable Skyrim.esm refs) | low | — | native-server |
| L4-10 (server) | `SendAndSetDeathState` sends isDead true and false to actor listeners for players and NPCs, one copy per user. It skips the actor itself and the user that receives the DeathStateContainer. | | fixes NPC revive on observers | medium | L2-09 | native-server |
| L4-31 (server) | onSubscribe adds an `ff_loadDoor` entry for DOORs with XTEL, cached per door. doorTeleportSystem sends its override door ids once per connect. | | — | low | — | native-server, server-ts |
| L4-33 (server) | Disable and Enable of ESP non-actor refs send UpdateProperty `disabled`. Papyrus Enable/Disable drop their SpSnippet loops. `gatheringSystem.setShown` uses `mp.set(isDisabled)`. | Second hide path | — | low | L2-09 | native-server, server-ts |
| L2-17a | `housingSystem.write` sets a neighbour-visible `ff_decor {name, locked}` on the primary and the partner when it changes, and clears it on release. 50_properties.js registers it. An M1 step sets `dynamicFields.ff_decor` on live claims (owner != 0). | | prerequisite for dropping the world-wide list | low | L5-M1 | server-ts, gamemode, db-migration |

- **L3-02:** blockStart travels unreliable. A lost one still leaves a held block unhonoured, as today.
- **L4-10:** the actor is its own listener. Sending isDead to the owner would make a revive report the dead engine's 0 health.
- **L4-02:** deferred channel 2 keeps the polymorph packet ahead of the new appearance. Sending immediately reopens the N6 shield-slot crash.
- **L4-14:** observers start real casts from keep-alives. Never fast-path a spell the caster did not fully cast.
- **L4-38:** giants, mammoths and dragons hit from far-off origins. Never apply the player reach rule to NPCs.

### Phase 3: Client release A

This is one client version, JS only with no dll change, and compatible with today's server protocol. It ships after Phase 2 is live, because L3-01 needs L3-02.
- Test it on the Test Server first.
- Rows marked "at release" change the server or gamemode in the same Migrate window.
- Once every client runs A (the launcher checks the exact client version), Phase 4's L3-03c, L3-06 and L2-17c can switch on.

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L6-09 | NetworkingService parses each custom packet once. A typed router `onCustomPacket(type, handler)`. The 47 subscribers and the 4 direct `JSON.parse` sites switch to it. Land this first. | 46 parses per packet | the refDecor list was parsed 47 times | medium | — | client |
| L6-22 | One `sp.on('update')` and one `sp.on('tick')` in CombinedController. Each callback's catch logs the stack to `skyrim-platform.log`. | ~60 native→JS dispatches per frame | ~3,600 → ~120 calls/s | low | — | client |
| L6-01 | `FormView.refrId` sits behind a setter that re-indexes the local↔remote maps. RemoteServer gets `formIdxByRefrId`, deleted only when its entry still matches. Hosted checks use `remoteRefrId`. | O(n) scans, 3 copies of the hosted check | 1-2 ms/frame at 200 forms | low | — | client |
| L6-02 (+L6-M8) | One player sample per frame, which emits `playerWorldOrCellChanged`. FormView and tryHostIfNeed read it. Crosshair from `crosshairRefChanged`, cleared on destroy and on undefined. CellAnimations, Weather, LipSync and CharacterProgress use the event. | N+1 world reads, 2 crosshair polls | ~7,400 natives/s at 40 copies | low | — | client |
| L6-11 | `handleConnectionAccepted` resets IdManager, `storage.hosted`, lastTryHost, the plugin-ref records, the clone-cast maps, `speakingUntil` and the SendInputs maps. | Id leaks, stale hosted NPCs | — | low | — | client |
| L6-M6 | `allocateIdFor` reuses an existing mapping. A repeated CreateActor replaces the model at that idx and destroys its view. | Zombie models | — | low | L6-01 | client |
| L6-M5 | FormView.destroy deletes its groundSamples and WorldCleaner protection. `allowedIdles` becomes a Map<localId, Set> with expiry. | Maps that never shrink | — | low | — | client |
| L6-06 | RemoteServer emits `ownerPropertyChanged` and `ownerModelReset` and sets ownerModel on the own CreateActor. ChatService (mount, isAdmin, name) and AfterlifeLook use these events. Chat bubbles expire on timers. | Per-frame chat diff, 1 s afterlife poll | — | low | L6-09 | client |
| L6-07 (=L3-13 client) | Delete GamemodeUpdateService, GamemodeEventSourceService, SweetTaffyEvalService, ServerJsVerificationService and `messages_gamemode`. Message type 32 is ignored. | ~595 lines, client-side `new Function()` | 2 handlers + n calls per frame | low | L6-06 | client |
| L6-08 | Delete: the FormView stubs, show-clones/skipUpdates, animationFunc1, `filterMovement` (L3-09), verifyVersion, the empty blockedAnims loop, the empty if, the clone-cast diagnostic, `logNpcSpellHit`, `isSpellCastAnim`, the own-cast throw, SweetCameraEnforcementService and the nickname events. The Time and Weather throw-logs become `logToPlatformLog`. Keep the `disabled` prop handling (remoteServer.ts:903, 1415-1416) for L4-33. | ~700 lines | a BeginCast hook per copy cast; an error per own cast | low | — | client |
| L6-M4 | Delete `watchSlide` (or put it behind a setting), the printConsole inside the setupHooks hook, and the FormView printConsoles. | | a console write per blocked copy attack | low | — | client |
| L4-40b (+L6-M7) | Delete `isSweetHidePerson` (formView.ts:682, 823-830) and SweetTaffySweetCantDropService with its callers in containersService and dropItemService. | ~30 lines | keyword lookups per tag per frame | low | — | client |
| L6-04 | Actors skip the object-only paths. The keep-offset is cleared through an `offsetCleared` flag. The MagicInvisibility keyword is resolved once. applyMovement: one-time setup moves to spawn; flags are compared with the last applied values; health is applied until it converges; the death event fires when the model and the engine disagree. A skipped equal packet still runs the death and teleport checks. | | ~36 natives/s per actor copy; 10-15 of ~30 per packet | low | L6-01 | client |
| L6-03a (+L4-34) | FormView trim, no scheduler yet: cache the chosen base; one getFormEx existence check and one is3DLoaded read per update; the player's world from the holder; open and harvested re-asserted only on a property change, a 3D-load transition or an openClose event. | Per-frame respawn check, 133 ms and 666 ms timers | ~2/3 of ~13 natives per idle copy per frame | low | L6-02, L6-04 | client |
| L6-05 | Name tags anchored natively (`setTextRefr`, node `NPC Head [Head]`, offsets). A 5 Hz pass decides visibility, recomputes the name and drives the tint trigger and bInJumpState (D28). | Per-frame LOS raycast, projections, keyword lookups | ~23,000 → ~1,200 natives/s with 20 tagged copies | medium | L6-02 | client |
| L6-12 | A menuState Set fed by menuOpen and menuClose, seeded at construction and on loadGame. `isBadMenuShown` and the per-frame callers use it; the direct read stays at formView.ts:631. The UpdateAppearance send moves to `menuClose(RaceSex)`. The console backstop runs at 4 Hz; the Sleep backstop goes. | ~9 isMenuOpen calls per frame | ~540 → ~8 natives/s | low | — | client |
| L6-13 | A seat tracker from furnitureEnter/Exit on 0x14, read by BlockedAnimations and CraftedExtras. FurnitureSeat polls sitState every 250 ms only while seated. The OpenContainer furniture wait runs on events with a 2-3 s fallback. The container wait is unchanged (L4-37). | 2 getFurnitureReference per frame, 10 Hz seat loop | ~130 natives/s idle, ~20/s while seated | medium | L6-12 | client |
| L6-16 (+L3-M8) | Fast travel off on loadGame and on the map menu opening. Difficulty set on loadGame and journal close. The auth widget refreshes only when its dots change. Interior weather on cellFullyLoaded. Time globals resolved once per load, synced every 10 s. Freecam via `cameraStateChanged`. Twin Souls checked on StatsMenu close and at spawn. `sweepCloneCasts` returns early when empty. HUD alpha only while a crosshair target exists. | 7 polls | ~75 natives/s; 60 → 4 CEF evals/s while connecting | low | L6-12 | client |
| L6-M3 | The sneak-block speed hold runs only while sneaking and blocking (0x14 Sneak/Block start and stop events). The Block Runner perk check runs on loadGame, StatsMenu close and race switch. | Per-frame getPlayer + isSneaking | ~124 natives/s | low | L6-23 | client |
| L6-23 (+L3-09) | One 0x14 hook (the player's AnimationSource, blanking `OffsetBoundStandingPlayerInstant`). One hook on 0xff000000-0xffffffff (attack and idle filter) that dispatches to a JS Map of hosted-copy sources. Sources are plain objects created and disposed on HostStart, HostStop and reconnect. The AnimDebug hook is added only while active. | Unfiltered per-source hooks that are never removed | ~3,000 JS calls/s with 30 leaked sources | low | L6-11 | client |
| L6-14 (+L3-M1) | SendInputs reads actor values at 4 Hz, and at once after a hit, a landing or a death animation. Each hosted target's owner is resolved once per frame through the maps. The casting delay comes from MagicSync's state. A hosted copy's source is rebuilt when its local id changes. | | ~1,200 → ~100 natives/s | medium | L6-01, L6-02, L6-23 | client |
| L4-16 | `sync/spell.ts` exports the magic constants, replacing 5 copies. One 10 Hz sampler of the 4 spell slots and the 2 hand types feeds SendInputs and MagicSync. The crosshair is read inside onSpellCast. CloneSpellGuard loses its own update handler. | 5 constant copies | ~6-8 natives per frame | low | L6-02 | client |
| L4-17 | Merge cloneSpellGuardService and npcHitSpellBlockService into one RemoteDamageGuard: one floor, one hit handler, one update handler. It keeps the magicEffectApply and effectStart listeners and still enforces before the ChangeValues read. | ~100-150 lines | 1 handler per frame | medium | L4-16 | client |
| L4-09 (+L3-M3) | No ChangeValues for hosted targets. ChangeValues sent reliable. | Hosted path | enforce + ~5 natives per hosted NPC per frame | low | — | client |
| L4-11 | UpdateAnimVariables is sent only while casting (within 500 ms of IsCasting) with the weapon drawn, unreliable, plus one final snapshot when casting ends. | 2 msgs/s per player who has any power equipped | ~1.8 MB/s egress for 30 idle mages in a crowd of 100 | low | L3-11 | client |
| L4-12 | A fire-and-forget cast sends one SpellCast. Receivers let a non-concentration replay expire after 600 ms. | 3 of 4 packets per cast | ~93 msgs/s per caster at 1 cast/s and 30 listeners | low | — | client |
| L4-15 | racialSystem adds the server-settings `blockedSpells` to racialState as "blocked" (server-ts at release). Delete the client's `BLOCKED_POWER_IDS`. | 9-id duplicate | one settings edit instead of a client release | low | — | client, server-ts |
| L4-28 | PlayerBowShot sent reliable. | | no ammo desync on packet loss | low | — | client |
| L4-24 (client) | hitService skips weapon hits on dead targets. | | 1 reliable packet per corpse swing | low | L4-24 (server) | client |
| L4-M1 (client) | ActivationService returns unless the caster is 0x14 or an NPC this client hosts, before any inventory read. | | per NPC activation in view: 1 reliable Activate + 1 server exception | low | — | client |
| L4-M7 | A crossbow shot takes the worn ammo id from the last equipment report. | | a full getInventory per shot | low | — | client |
| L4-41 (client) | hitService sends projectile 0. | | — | low | — | client |
| L4-04b | `getEquipment` (equipment.ts:182-193) sends worn and wornLeft entries plus unworn twins of worn bases. | | ~85-95% of each UpdateEquipment; ~40-50% of each player doc | low | L4-04a | client |
| L4-10 (client) | movementApply stops emitting `applyDeathStateEvent` for remote copies. FormView revives a copy when its model's isDead goes from true to false. | Observers trusting a client-reported death | correctness | medium | L4-10 (server) | client |
| L4-31 (client) | ActivationService reads `ff_loadDoor` or the override ids. Delete `loadDoorQuery`, `answerLoadDoor` (doorTeleportSystem.ts:103, 121-126) and afkSystem's entry. | Round trip for static data | 1 round trip per client and door | low | L4-31 (server) | client, server-ts |
| L4-33 (client) | FormView applies `disabled` on plugin doors. | | — | low | L4-33 (server) | client |
| L6-15 (+L4-07) | Own inventory: apply at once on SetInventory, a request, spawn and loadGame. A local containerChanged arms a 5 s settle timer. Holds and bow blocks set a not-before time, and a blocked SetInventory is applied when its block ends. A 60 s safety net (D29). The container snapshot is taken at ContainerMenu open and cleared at close. containerChanged is diffed once per update; no printConsole; LastInvService folded in; a per-frame getInventory memo. | 5 s re-apply, snapshot per activation | ~1.6 full reads + diffs per s idle → 0 (1 per min) | medium | L6-12, L6-13 | client |
| L4-08 (craftedExtras) | CraftedExtras checks on containerChanged, SetInventory, a refusal, Crafting/Inventory/Favorites close, furnitureExit, and once USE_REPORT_MS after an own hit with an enchanted weapon. The workbench comes from furnitureEnter or the crafting menu opening. | 1 s poll, per-frame furniture read | ~1 full read/s + 60 natives/s | medium | L6-15 | client |
| L6-19 (+L4-08 ingredients) | CharacterProgress drops the 10 s marker rescan and the 5 s ingredient poll. Markers are scanned on loadGame, knowledgeState, locationDiscovery, cellFullyLoaded, Journal and map open, and bookRead. Ingredients are read on an ingredient pickup or eat, Crafting close and loadGame. | 2 polls | ~1,800 natives per 10 s + a full read per 5 s | low | L6-15 | client |
| L6-10 | Each plugin ref gets a record (`pluginRefByIdx`), applied at once or on cellAttach/moveAttachDetach. A 2 Hz fallback runs for 30 s and logs its count. UpdateProperty updates the record. A DestroyActor for a plugin ref deletes the record. The destroy path uses `destroyForm(i)`. | onceLoad 120-frame retries, `forms[-1]`, caches that never shrink | a full model scan per DestroyActor; state lost after 120 frames | medium | L6-01 | client |
| L6-18 | WorldCleaner cleans actors named by cellAttach/moveAttachDetach. The random sweep adapts: every frame while it finds strays or right after an attach or a copy's cast, 4 Hz after 20 protected picks (D30). | Per-frame findRandomActor | ~600 → ~15 natives/s idle | medium | L6-10 | client |
| L2-17b | FormView applies the `ff_decor` name and lock, replacing the unconditional dealWithRef unlock. Claimed containers apply it on create and on UpdateProperty. Delete RefDecorService (154 lines), which supersedes L4-32 and L6-17. | 2 Hz world-wide sweep, unlock/relock fight | up to ~5,000 getFormEx in one frame every 0.5 s | medium | L2-17a, L6-10 | client |
| L5-08 | Chat lines travel as a `chat` custom packet to the recipients. gm deliver changes, and sendAround uses `near()` then exact positions. The client queues lines (cap 200) and flushes them on update. Drop `makeProperty('ff_chatMsg')` and the client poll. M2 unsets `ff_chatMsg`. | Persisted chat property | k whole-doc writes and 2N N-API per line | medium | L5-03, L6-09 | client, gamemode (at release), db-migration |
| L2-20 | VoiceService sends `voiceMode {key}`. VoiceSystem validates it and sets a neighbour-visible `ff_voiceRange` (registered in 50_properties.js). VoiceManager reads ranges from the model. Delete `publishRange`, its DataReceived handler and the 20 s heartbeat. | Room-wide data messages | O(N²) deliveries per join (~250k at N=500) | low | — | client, server-ts, gamemode (at release) |
| L2-21 (+L6-20 voice) | `autoSubscribe` false, plus a TrackPublished check. pushPeers uses the player's engine position, rounded to 25 units, and is sent only on change with a 3 s keepalive. It resets on `voice::ready` and on reconnect. | Subscribe-all on join, 2.5 CEF evals/s | ~2×499 subscriptions per join at N=500 → in range only | low | L2-20 | client |
| L6-20 | Survival flame cloak from effectStart/effectFinish. Disease checks at +2 s and +12 s after a hit or magicEffectApply, plus every 60 s. The mount saddle poll runs only for 15 s after a handshake. CellAnimations re-reads the cell on cellFullyLoaded and loadGame and retries only while work is pending. The LipSync sweep runs only while faces are touched. | 4 background loops | ~40 natives/s | low | L6-02 | client |
| L6-21 | Memoise the load-order CRCs for the life of the game process. | Re-read on every reconnect | ~60 MB read per reconnect | low | — | client |
| L4-06 (client) | An `inventoryPatch` handler next to onSetInventoryMessage. It bumps numSetInventory and raises the same triggers. | | enables L4-06 (server) | medium | — | client |
| L3-01 | Send-on-change movement. A 130 ms probe reads ~10 cheap values (pos, yaw, health, weapon drawn, sneak, block, jump, model isDead). A report goes out on: >4 units moved, >2° turned, a flag change, ≥1% health, a non-Standing state, an animation event, or the 1 s keepalive. After a transition, one more report follows. `idx` comes from the FormModel. FormView stall and forced re-apply move to 3 s, without the printConsole. Health smoothing k=1. | 6.5 of 7.5 reports/s per idle actor | upstream ~22.5k → ~8.2k packets/s at 1,000 players with 2 NPCs each; ~110 natives/s per idle actor | medium | L3-02 | client |
| L3-03b (+L6-M2) | SendInputs writes each sent movement and equipment into its own model for the player and hosted NPCs, bumping the counters. Voice uses the engine position. The own appearance is written into the model when UpdateAppearance is sent. | Reliance on the server echo | prerequisite for L3-03c | low | — | client |
| L3-06 (client) | translateTo's window becomes each form's inter-arrival time, clamped to 0.13-0.6 s, with the extrapolation cap scaled to match. | | prerequisite for the server tiers | low | — | client |
| L6-26 (+L3-M2) | No host claim for forms with appearance (players, PK bodies). Prune lastTryHost on DestroyActor. | Refused claims every ~2 s per idle player copy per client | — | low | — | client |

- **L3-01:**
  - Release only after L3-02 is live.
  - Late joiners see an idle player's sneak, weapon and wounds up to 1 s late until L3-M4 lands in B.
- **L6-01:** a map refreshed only after `update` returns misses ids used inside the same update. Re-index in the refrId setter.
- **L6-15:** applying immediately on a local containerChanged races the server's deferred SetInventory and removes the new item. Keep the 5 s settle.
- **L5-08:** chat goes silent for whoever runs the other version. The gamemode switch and the new client version must go out in the same Migrate.
- **L2-17b:** needs M1's `ff_decor` backfill. Keep the interim refDecor push until every client runs A.
- **L6-10:** compare the fallback count with the event count on test before trusting cellAttach alone.

### Phase 4: Streaming, hosting and the movement relay (native build N3 + server-ts)

This phase starts once every client runs A. It is independent of Phase 5.

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L3-03c | The relay skips the sender for UpdateMovement and the equipment loop (ActionListener.cpp:445-450, 884-886). Update PartOne_MovementTest. | Own movement and equipment echo | ~22.5 packets/s (~1.4 KB/s) per player with 2 hosted NPCs | low | L3-03b on all clients | native-server |
| L3-06 (server) | Distance tiers for the movement relay: mid-range listeners get every 2nd moving report, far ones every 4th. Flag changes and keepalives always go. Optional crowd cap K. Radii in settings, with mid ≥ the largest voice range × 1.2 (D13). | | -35% to -47% of moving relays | medium | L3-04, L3-06 (client) | native-server, settings |
| L2-08 | Exteriors use `floor(pos/4096)` clamped to int16, shared by GetGridPos, the Browser chunk key and the N-API binding. Interiors are one chunk (0,0). Actors change chunk only 512 units past the edge (hysteresis), with a stored chunk key. Fix the N-API array (`New(env)`, `Set(i++)`). | 8192-wide chunk 0 | no 3-row re-stream on every line re-cross; TS neighbour loops halve | medium | L1-M4 | native-server |
| L2-06 | A non-actor's subscription pass builds `toAdd` from actor entries only. No second grid. | | ~340k steps on a city's first visit | low | — | native-server |
| L2-02 | A sticky `clientVisible` bit, set from ApplyChangeForm's visible fields, the setters, and XLOC lock data (libespm REFR::GetData). onSubscribe skips non-DOOR ESP non-actors without it. | Creates for untouched refs | city 569 → ~10-40 creates; Tamriel crossing ~19 → ~1 | medium | L2-01 | native-server |
| L2-04 | The chunk loop skips untouched item, FLOR and TREE refs that have no VMAD, no primitive, no XAPR parents and no delta. They load on first touch. | | ~40-55% fewer forms per visited chunk | medium | L2-02, L2-05 | native-server |
| L2-M5 | ForceSubscriptionsUpdate builds and serializes the emitter's non-owner CreateActor once per pass, in two isHostedByOther variants. | Rebuild per listener | K-1 builds when walking into a K-player crowd | low | L2-13 | native-server |
| L3-07 (+L2-14) | `PartOne::Broadcast(emitter, msg, mode, exclude)`: user first, serialize once, each user once; a deferred mode keeps actorIdExpected. It is used by SendMessageToActorListeners (now honouring `reliable`), UpdateHoster (true to all but the hoster's user), MpActor.cpp:246-248 and 287-291, EquipmentBinding.cpp:39-41 and AppearanceBinding (deferred). PlayAnimationAndWait and the SpSnippet loops stay per listener. GetActorToSendTo stays for unicast. | k+1 host duplicates, the host's self "true" | 11 → 1 copy of each broadcast for a host of 10 NPCs | medium | L2-09 | native-server |
| L2-10 | `SetUserActor` accepts a disabled actor: it clears isDisabled and runs the disable sinks and pending snippets once. spawn.ts drops the `setEnabled(false/true)` around login (604-611, 962-967). | 2-3 extra subscription passes per login | 2 full player CreateActors per neighbour per login | medium | L2-09 | native-server, server-ts |
| L2-15 | `PartOne::SetHoster` and `AssignHost` with a host→NPC index. Assignments run on events, each deferred one tick: an unhosted NPC subscribes to a player; it unsubscribes from its host; the host disconnects, detaches, changes chunk, bleeds out or dies; the NPC is destroyed or disabled. A 2 s sweep moves an NPC only when another candidate passes the veto. It never unhosts a host that still listens, and owners and riders get no 60 s exclusion. Unhosted NPCs with player listeners are retried. TS keeps the vetoes, the hit hook and `assign()`. Delete the 1.5 s audit, choose, noteClaim and the providers (D8). | ~250 TS lines (+~100 C++) | ~667 actorNeighbors arrays/s at 1,000 players | medium | L3-02, L3-07 | native-server, server-ts |
| L2-17c | Housing stops sending refDecor: delete pushDecor, decorRefs, sendDecor and the decor parts of updateAsync and onActorAssigned. | World-wide list | — | low | L2-17b on all clients | server-ts |
| L4-06 (server) | At the flush, diff against the last inventory sent to each user. Send a patch when it is small; send a full SetInventory on assignment, reconnect, a large diff or every N patches. Behind a setting. | | archer: 2-10 KB per arrow → 60-200 B | medium | L4-05, L4-06 (client) | native-server |

- **L2-02:** stream-in no longer forces refs back to unharvested and enabled. Audit every setter that changes visible state.
- **L2-08:** plain floor would cut interiors at x=0 and y=0; the single interior chunk avoids that. libespm and the server must change in the same build.
- **L2-15:** test a ridden pet whose rider pauses, a companion whose owner leaves, and 2-3 players in one spawn-zone fight.
- **L2-10:** native and TS halves must go in one deploy.

### Phase 5: Persistence (native build N4 + server-ts + migration M2)

M2 runs with the server stopped:
- delete the NPC docs left by the old spawn system, from a list the owner reviews;
- flag placed items;
- unset transient props and `ff_chatMsg`;
- unset expired gathering state.

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L1-19 | ts/index.ts handles SIGINT/SIGBREAK: stop admitting players; a native `prepareShutdown()` runs every user's disconnect; volatile edits are marked dirty; keep ticking until the last Upsert callback; hard deadline 20 s; a second signal exits at once. Owner step: `nssm set <svc> AppStopMethodConsole 15000` on AlduinakGameServer and AlduinakTestServer; also add it to setup-testserver.ps1. | Data loss on every planned stop | planned restarts lose nothing | medium | — | server-ts, native-server, owner step |
| L1-09 | A WorldState dirty map by formId: `RequestSave` only marks, and each flush takes one `GetChangeForm` per dirty form. Snapshots and tombstones are taken before BeforeDestroy. A failed batch re-queues its own entries for forms that are gone (looked up with `LookupFormByIdNoLoad`). The saver waits on a condition_variable; Tick returns on an atomic zero. Delete the recycled buffers; update SaveStorageTest. | A full struct copy per edit, 100 ms saver poll | one 12-16 KB copy per edit (3 per ChangeValues) | medium | — | native-server |
| L1-M1 | ApplyChangeForm assigns base actor values field by field and keeps the stored health, magicka and stamina percentages (MpActor.cpp:767-772) (D2). | Full heal on every load | closes the log-out-to-heal exploit L1-07 would open | medium | — | native-server |
| L1-10 (part 1) | `SetPercentage(s)` save under the 30 s rule if L1-M1 lands; otherwise never, except on bleedout and kill. | ChangeValues saves | up to 30 → ≤2 whole-doc saves/min per active player | low | L1-M1 (D2) | native-server |
| L1-13 | needs drops its 60 s tick write; mastery drops its 5 min bank-clock save (D4). Survival keeps its policy. | Timed saves | ~17 writes/s at 1,000 players from needs alone | low | L1-19 | server-ts |
| L1-04 | At boot, read every FF formDesc, deleted ones included, into a reserved set. The persistent counter starts at 0xff000000, only moves forward within a run, and skips reserved and loaded ids. The transient range 0xff800000+ has its own forward-only counter. A stored doc in the transient range logs critical. The `$unset` list stays. | Reuse of ids that stored docs still hold | correctness | medium | L1-01 | native-server |
| L1-03 | New binding `placeAtMeTransient(anchor, base, disabled)` with a native RAII scope; saves of transient ids are skipped. placeNpc and ash piles use it; the bounty stash stays persistent. Delete zone-spawns.json, pets.json, the active/corpse part of companions.json, the leftover passes, `destroyLeftovers` and getAllForms (ScampServer.cpp:1762-1795, WorldState.cpp:894-931). M2 deletes the leftover NPC docs from the reviewed list. Update the file lists in build.js, wipe-world.js and setup-testserver.ps1. | ~200 TS + ~80 C++ lines, 3 boot leftover passes | 5-20 writes per NPC lifetime → 0; 49 NPCs loaded and destroyed per boot → 0 | low | L1-04 | native-server, server-ts, db-migration |
| L1-16 | `makeProperty` takes `persist: false`. The value lives in a side map that `GetValueDump` and `ForEachValueDump` read and that GetAsJson and ToJson skip. 50_properties.js marks `ff_chatMsg` (until L5-08), `ff_carriedBy` and `ff_carried`; other props after one-by-one verification. M2 unsets the old values. | Stale carry flags after restarts | one whole-doc save per recipient per chat line while L5-08 is pending | medium | — | native-server, gamemode, db-migration |
| L1-15 | placedItemSystem keeps refId→placedAt, fed by `setPlacedAt` plus `private.indexed.placed`, and filled at WORLD_LOADED through `findFormsByPropertyValue`. The sweep skips plugin descs. Delete the MongoClient, `clearStaleCarries` and the mongodb dependency (package.json:27). M2 flags existing FF docs. | 2 `$expr` full scans, a second Mongo pool | 48 scans/day of 26,896 docs → 0 | low | L1-16 | server-ts, db-migration |
| L1-14B | LoadChangeForm's deferred branch registers `private.indexed.*` keys. housing.json becomes `private.indexed.housing`, migrated only where owner != 0. gathering-picks.json becomes `private.indexed.gatherHidden`. Stored companions move onto the owner as `private.storedCompanions`. Each file is migrated once at boot and renamed `.migrated`. | 3 JSON registries, synchronous file writes | a whole-map rewrite per pick | medium | L1-03, L2-05, L1-06 | native-server, server-ts |
| L1-17 | A dedicated field-by-field compare of a plugin REFR against its ESP default (not `operator==`). An equal one is deleted, and the boot drops default deltas. Start in count-only mode, grouped by base type. Gathering sets `private.indexed.gatherDepleted`, clears both keys once regenAt has passed (at WORLD_LOADED and in regrowPicks), and M2 unsets expired `private.gathering`. | Deltas that match the ESP again | 11,140 gathering docs (41%) → only the depleted ones (verify by base type) | medium | L1-02, L1-14B | native-server, server-ts, db-migration |
| L1-07 | Characters load by profile. The boot skips characters and builds a profile directory from the index. `loadProfile`/`loadForm` Promises use the existing async Iterate. `releaseProfile` unloads after the final Upsert callback, and only if the form was not dirtied again. spawn awaits the load before the character list. An unload-delay setting (D6). An offline admin revive loads first. Faction release retries carry `othersAlive`. Delete legacySpawn (D7), login.ts's dead roles read and the polymorph boot scan. | Disabled actors for every offline character | 227 today; at 10k characters est. ~128 MB BSON and ~300-500 MB of actors | high | L1-01, L1-04, L1-08, L1-09, L1-M1, L1-M4, L1-M5 | native-server, server-ts, gamemode |

- **L1-03:**
  - The owner runs the M2 NPC cleanup before the first boot of this build. Otherwise the old NPC docs load and nothing removes them any more.
  - Console placeatme actors, like the 2026-09-13 dragon, must be kept off the delete list.
- **L1-04:** never reuse an id within a run, because TS timers still hold destroyed ids.
- **L1-07:** test relog, character switch, deletion, death, admin revive and capture of an offline captive. Any write after the unload gets "form doesn't exist".
- **L1-09:** test a Mongo outage on skymp_test: stop AlduinakMongo while the Test Server runs, then start it again.
- **L1-16:** hot reload cannot apply `persist: false`, because makeProperty refuses an existing name. Restart the Test Server.

### Phase 6: Client release B and the protocol switch

This phase needs Phase 4 (L2-15) live. It is one announced forced-update window (D14): the server and client natives change together.

| id | task | deletes | saving | risk | needs | ships |
|---|---|---|---|---|---|---|
| L3-08 | Client RELIABLE becomes RELIABLE_ORDERED on channel 0 (Networking.cpp:91-92). The server `Send` takes a SendMode. Every UpdateAnimation (client relays and SetLastAnimEventAndBroadcast) and every SpellCast relay moves to channel 1. | Unordered client reliables | no head-of-line blocking between world and animation messages | low | — | native-server, native-client |
| L3-05 | UpdateMovement gets a uint16 seq, runMode as a uint8 (JSON keeps the string), optional health, direction as a uint8 and speed as a uint16. The server keeps the last seq per idx with its sender, resets it on host change, SetUserActor, connect and idx reuse, and compares wrap-aware. It relays a server-serialized copy with its own relay seq. Clients reset seq on Create, Destroy and connect. | ~15 B per report; reordering | 59 → 40-44 B per movement packet | medium | L3-04, L3-08 | native-server, native-client, client |
| L3-M4 | CreateActor carries the server's last weapon-drawn, sneak, block and jump flags and the health %. remoteServer.ts:943-957 uses them. | | late joiners see an idle actor correctly at once | low | L3-05 | native-server, native-client, client |
| L4-13 | Delete the cast stop echoes (magicSyncService.ts:216-218, 331-336, 398; remoteServer.ts:1892-1895). | | 2 × (1 + listeners) per concentration stop | low | L3-08 | client |
| L4-41 (wire) | Remove the HitMessage projectile field. | | 4 B per hit | low | — | native-server, native-client |
| L3-15 (client) | Delete the raw-message path: networkingService, events, MpClientPlugin.cpp:104-114, main.cpp:78-82, SkyrimPlatform's SendRaw. | ~100 lines | — | low | — | client, native-client |
| L3-17 (client) | MessageSerializer reuses one simdjson parser; MpClientPluginApi caches its GetProcAddress results. | | per send and per tick | low | — | native-client |
| L6-M1 | `Hook::Enter` tests handler matches on the calling thread before PushAndWait and remembers the result for Leave. Add a "contains" pattern for `*attack*`. | | 2 game-thread→JS hand-offs per animation event no handler wants | medium | L6-23 | native-client |
| L6-05 (native) | TextApi hides anchored text behind the camera (TextApi.cpp:455-457, main.cpp:57). | | — | low | L6-05 | native-client |
| L6-21 (native, optional) | FileInfo keeps a size+mtime sidecar cache. | | CRC reads at first boot | low | L6-21 | native-client |
| L6-03b | A dirty scheduler. Every model writer marks the form dirty. Forms are active while carried, mounted or spawning. Everything is marked dirty on view creation, resize, world change, an allowUpdate flip or a change of the viewer's isAdmin. A 2 Hz sweep checks counters, 3D-load transitions, the settle re-apply, unloaded-copy teleports and expiries. | Per-frame updateAll | ~41,000 natives/s → ~280/s + packet work in the reference scene | high | L6-03a | client |
| L2-16 | Delete tryHostIfNeed, the claim branch, hostAttempts.ts and sendHostAttempts. HostStart queues `setWeaponDrawnMode(-1)` and `clearKeepOffsetFromActor`. The client sends `hostPause` when the window goes inactive or a pausing menu opens (L2-15's sweep becomes a 10 s safety net). Then delete `OnHostAttempt` and its parser case. | Client claims | up to 1 Host packet/s per stale actor per client | low | L2-15 | client, native-server |
| L6-24 | Reuse one TESNPC base per remote actor while race and sex are unchanged; clear on loadGame. | Base leak | ~1 KB per copy spawn | medium | L6-03b | client |
| L6-25 | Delete keepTorch once an in-game test confirms the `fTorchEvaluationTimer` fix (D31). | ~45 lines | 5-8 natives/s per torch copy | low | in-game test | client |
| L4-18 | The Falmer perk poisons are priced on the server, scaled by PoisonResist, for player victims, outside the hit cap (D17). The client dispels only those. Race-attack poisons stay local. Delete TrackNpcHitPoison, GuardReportedHealth, `npcHitPoisonBlocked` and the client's block guessing. | ~180 C++ + ~200 TS lines | — | high | L4-17, L4-23 | native-server, client |
| L3-10 | AnimationSource and receivers keep a 4-entry queue, so two events in one frame both reach others (D21). | | correctness | medium | L6-23 | client |
| L2-22 | The voice token is minted for `<room>-<worldOrCell>` from the server's view of the player's location. The client requests a new token on a cell change and sends its own worldOrCell; the server refuses while the two disagree (D9). | Server-wide room | participant events O(server) → O(location) | medium | L2-20, L2-21 | server-ts, client |

- **L3-05:** a seq kept only per idx, with no resets, freezes NPCs after every rehost and players after every reconnect.
- **L3-08:** client relays and server-made animations must share channel 1. Otherwise a delayed relay overwrites a newer forced pose.
- **L6-03b:** measure L6-03a first. Most of the per-frame saving may already be there.

## 4. Decisions for the owner

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Per-zone DB loading, or the world in memory with per-player loading | **Owner (2026-10-04):** clients must only receive the zone they are in. That is already the stream rule (3x3 chunks of the same worldspace or cell); the DB layer stays world-in-memory, characters per player. The world-wide leaks (refDecor, itemGrabbed/itemMoved, voice events) are removed by L5-M1/L2-17, L5-18 and L2-20..22. | — |
| D2 | Actor values on load: keep the stored health % or full heal | **Owner: keep health (by design).** Today a restart heals everyone (MpActor.cpp:767-771); L1-M1 fixes that and must land before L1-07. | L1-M1, L1-10, L1-07 |
| D3 | Deleted characters: hard delete or keep flagged | Keep flagged until L1-14B, because companion ids could be inherited | L1-02 |
| D4 | Crash-loss windows: health ≤30 s, needs, torch and mastery since the last event | Accept. L1-19 makes planned stops lossless. | L1-10, L1-13, L5-11 |
| D5 | Offline "fallen" rows in the admin panel | Read them from the backend characters store (needs a backend change) | L1-07 |
| D6 | Unload delay after the logout grace | 10 min | L1-07 |
| D7 | Legacy single-character path (characterSelect off) | Delete it; neither server uses it | L1-07 |
| D8 | Hosting: a periodic "nearer player" rebalance, or events only | **Owner: events only, server-driven.** | L2-15, L2-16 |
| D9 | Voice rooms per location | **Owner: yes.** Interiors and child worlds get their own room; Tamriel stays one room with in-range subscriptions (L2-21), split by hold later if its join/leave traffic shows up. | L2-22 |
| D10 | Movement keepalive interval | 1 s | L3-01 |
| D11 | Speed, activation (1024), melee slack (400), shot (8192) and spell-hit window values | **Owner questioned the week.** Log-only on test until one or two sessions exercise the edge cases (horses, mounts, Whirlwind Sprint, lag, polymorph giants, long bows), tune, then enforce on test; live gets a short log-only period after Migrate. | L3-04, L4-30, L4-38, L4-39 |
| D12 | Honour hosted NPCs' block reports | No (unchanged) | L3-02 |
| D13 | Tier radii and crowd cap | Mid = max(4096, largest voice range × 1.2), far 8192, K = 24. The crowd cap is the lever for a full city (80 in Solitude), where distance tiers barely apply. | L3-06 |
| D14 | Forced client update window | **Owner: test server only for now; protocol breaks are fine there.** Client releases are still batched because each test release needs a Nexus upload. Live moves later through Migrate. | Phase 6 |
| D15 | Racial magic resistance source | Keep the conditional entries (today's behaviour) and delete the native path | L4-20 |
| D16 | Corpse hits wear the weapon | No | L4-24 |
| D17 | Creature poison priced instantly on hit; does it count toward the hit cap? | Instant, Falmer perks only, outside the cap | L4-18 |
| D18 | `combatTrace` balance line | On for the Test Server only | L4-22 |
| D19 | Appearance caps | In settings, log-only first; RaceSex accepts any RACE because polymorph needs it | L4-02 |
| D20 | DOT on hosted NPCs | Leave as today | L4-09 |
| D21 | Same-frame animation events | Fix only when a desync is traced to it | L3-10 |
| D22 | Users whose packets keep throwing | Rate-limited log now; kick later if abused | L3-16 |
| D23 | Node process metrics on `/metrics` | Keep `collectDefaultMetrics` (cheap) | L5-19 |
| D24 | Gold watch cadence | Dirty set + a 60 s full sweep | L5-24 |
| D25 | World floor cadence | 500 ms (today) | L5-26 |
| D26 | Hot reload default | Off unless the setting is on; on in the testserver settings | L5-22 |
| D27 | Bind the console relay to loopback | Yes, unless a remote console is used | L5-21 |
| D28 | Name tags reacting within 200 ms | Accept | L6-05 |
| D29 | Client inventory safety re-apply | Every 60 s | L6-15 |
| D30 | How long a stray engine NPC may linger | The adaptive sweep (seconds, not minutes) | L6-18 |
| D31 | keepTorch | Delete after an in-game test confirms the engine fix | L6-25 |
| D32 | In-game CRC check | Keep it, memoised | L6-21 |
| D33 | The 1300-players-per-process cap | Outside Stage 2; re-measure after Phase 6 | — |
| D34 | Manager edits of offline characters while the server runs | Later, after L1-07 | — |

## 5. What stays

| What | Why |
|---|---|
| `server.tick()` loop (RakNet drain, deferred flush, save hand-off) | The core loop; L3-16 bounds it, and a fixed tick rate was rejected |
| AsyncSaveStorage game/saver split with one batch in flight; re-save after a failed batch | Keeps Mongo I/O off the tick; outages lose nothing |
| One doc per changed ref, upserted by formDesc as a whole-doc `$set` | Single source of truth; field-level writes were dropped (L1-11) |
| The 30 s position save throttle; `blockSaving` during apply | Bounds crash loss; stops loads writing themselves back |
| Characters forced disabled on load; the boot skip for unplaced FF items (now a tombstone) | Stops a character loading as an NPC; safety net |
| World deltas loaded at boot and kept in memory; the in-memory `private.indexed` index | Bounded by the interactable refs; chunk loads run inside the tick |
| survival's save policy (events, logout, 5 min only while cold moves) | Already event-driven |
| 3x3 chunk subscription grid, chunk loading on first visit, no chunk unload | A neighbour query is one set lookup; the daily restart bounds growth |
| Doors keep CreateActor and DestroyActor through FormViews | The client addresses door updates by idx |
| `private.*` filtering and makeProperty visibility | Server-only state never leaves the server |
| HostStart/HostStop, `storage.hosted`, isHostedByOther; the onHostAttempt veto chain | Carry the server's hosting decision; owner and rider rules |
| GetActorToSendTo for unicast (Teleport, ChangeValues, DeathState, owner-only props) | An NPC's results must reach the client running it |
| OnTriggerEnter/Leave; Papyrus OnHit and OnSpellCast once per event | Vanilla scripts and 3 TS systems rely on them |
| The `itemMoved` packet | FF item copies have no position stream |
| Server-minted voice token, separate LiveKit link, client gain falloff | Identities cannot be spoofed |
| gameTime on connect and on request | One sample per load |
| One RakNet link and the binary BitStream format | Already compact |
| 130 ms reports while moving; the 1 s keepalive | translateTo is tuned to it; liveness and failover need the heartbeat |
| The server movement authority path (gate, validation, SetPos, SetLastMovUpdate) | The authoritative position |
| UpdateAnimation and SpellCast relays reliable and ordered | Single-slot receivers need order |
| Deferred SetInventory with overwrite | At most one per user per tick |
| Client receive on every tick, menus included | RakNet must drain or the link times out |
| The server makeProperty registry | Decides who gets which property |
| UpdateAppearance echo to the sender | The client applies its own race abilities from it; one message per race-menu exit |
| ServerCombined wrapper | Reserves user id 0 |
| `movement.healthPercentage` | The only health source observers have |
| OnEquip; UpdateEquipment's 300 ms coalescing and validation | Authority over spells, potions and food |
| ChangeValues owner↔server with the 2 s throttle and corrections | The only channel for regen, falls and DOT |
| DeathStateContainer to the owner or host; the `isRaceMenuOpen` gate | Respawn teleport and values; legal appearance edits |
| Damage pricing chain, CapHit, block, sneak and power rules | Server authority over damage |
| Spell keep-alives every 3 s while channeling; ward and restoration timers | needs bills concentration by keep-alive; lost stops time out |
| Durability Settle and calm flush; reloot, effect and respawn timers | Already scheduled per instance |
| Container occupant (512) and seat (256) checks; the 17 TS onActivate gates | One occupant per container or seat; faction, job, housing and carry gates |
| Client 100 ms magic hit dedup; hosting and ownership checks in OnHit, OnSpellCast and OnActivate | Stops double hits at the source; stops impersonation |
| Active-only TS timers: bleedout 250 ms, capture 350 ms, search 500 ms, execution 1 s, body 2 s, pet 1 s, companion 500 ms, job 1 s | No server event exists; they run only while that state exists |
| npcSpawn 2 s, survival 1 s, needs 60 s tick, bountyBoard 1 h, queue status 5 s to queued users, masterClient 5 s heartbeat, relay reconnect 4 s, weather rolls | Game rules, or keeping a link alive |
| `/metrics` with the connect, disconnect and login counters | The backend status probe reads them |
| Small state and config files (weather-state, starter-grants, writings, faction-access, Jobs, NPC-Spawns, weather-regions, alert-keywords) | No changeForm copies; written rarely |
| FileDatabase driver; the backend's mirrored store; manager offline reads and writes | Tests; not game sync; offline admin |
| applyMovement per packet (translateTo); per-frame work only for mount, carry and spawning | The engine interpolates |
| Gated client loops (companion, pet, emote, furniture animations, restraint, execution, paired idle, creation light, polymorph, writing) | Free when idle; drive AI and poses while active |
| getNumKeysPressed per frame; console backstop at 4 Hz; weather 10 s recheck; swimming poll; prompt 500 ms refresh; admin alpha 1 s; reconnect watchdog; load-order name check | One native each, no safe event replaces them, or needed for recovery |
| Native TextApi::OnUpdate, CEF tasks, CEF page timers | Native or UI work, needed |
| `afkPing` every 60 s | Belongs to the AFK stage (L5-25 dropped) |
| Harvest apply's `findRandomActor` ×20 and drop's `findRandomReferenceOfType` ×200 | Per event and bounded; left to the items stage |

## 6. Dropped ideas

| Idea | Reason |
|---|---|
| L1-11 field-level writes with per-field hashes | Removed factions would come back at boot; nested key sanitizing breaks; a missed hash silently skips writes |
| L5-17 MasterClient heartbeat every 10 s | The backend marks a server down after 20 s; one miss would show it offline |
| L5-25 AFK activity from client input | Changes the AFK rule, trusts the client, needs a client release |
| L6-17 and L4-32 (RefDecor applied on attach; dealWithRef asking RefDecor) | Replaced by L2-17, which deletes RefDecorService |
| L3-09 per-source native hook filters | Hook add/remove can throw inside a hook context; L6-23 uses two fixed hooks |
| L3-12 C++ pass-through and gamemode hook, and a per-type router for the 32 server systems | No measurable saving; L5-04 keeps the gate and the single parse |
| L4-21 deleting `onHitAttempt` | Zero-damage hits would slip past the downed, carry and job gates |
| L2-06 second actor-only grid | A filter gets the gain with no sync risk |
| L2-14 / L3-07 folding SpSnippet and PlayAnimationAndWait loops | No host duplicates there; per-listener promises |
| L3-16 part 4, direct SpSnippet and appearance sends | Loses end-of-tick order and the character-switch guard |
| L4-37 event wait for containers | `Utility.wait` does not advance in menus, so it never polled |
| L6-14 (g) anim vars while drawn | L4-11's "while casting" is narrower |
| L5-18 boot Mongo seed for placed items | L1-15's index needs no MongoClient |
| L2-18 deleting `itemGrabbed` outright | Plugin refs in a client's 5x5 game cells still need it |
| L4 missed: dropping the UpdateAppearance echo | The client applies its own race abilities from it |
| L6-20 LipSync `sweepAll` gating | Saves nothing and resets faces other code wrote |
| L1: per-zone DB loading; a worldOrCellDesc index; a TTL index; a high-water id counter; synchronous character load; dirty bits at 54 sites; BSON straight to MpChangeForm; registries in new collections; skipping UpdateProperty for unchanged values; destroying deleted FF refs from memory; the server dropping indexes at boot; saving only at logout; dormant offline records; timed saves in native; changing the backend store | See the L1 lane: either already bounded or more code than gain |
| L2: unloading idle chunks; distance/LOS/height filters in the 3x3; smaller chunks; LiveKit RoomService subscriptions; client claims as the only hosting; no NPC→static subscriptions; removing CreateActor fields; door streaming only with state; client-side unlocks; persisting `clientVisible`; OnTrigger throttled to 1/s; removing the UTC poll | Raw pointers, more churn, or a protocol change for no extra gain |
| L3: fixed tick rate; MsgType codegen; binary JS edges; UNRELIABLE_SEQUENCED; dropping health from movement; culling far listeners; UpdateAnimation with the sender's reliability; suppressing downstream keepalives; flattening properties' JSON in JSON; always-reliable sends | Latency, sequencing across actors, ABI work, or observers losing data |
| L4: server-broadcast health; one shared in-combat state; removing keep-alives; stripping anim vars from keep-alives; dropping UpdateAnimVariables; projectile removal on its own; loadDoor as a new field; UpdateEquipment deltas; server DOT for every spell; reach check inside Activate; structured appearance in Mongo; merging OnHit consumers; native hit event filter; playable-race-only appearance | More bytes or work, breaks Papyrus or polymorph, or needs dll releases for little gain |
| L5: a custom priority-queue scheduler; a flat hook registry; client-side weather regions; a health-change event for bleedout; floor check in native validation; queueStatus on change only; per-user AFK deadline timers; deleting GoldWatch; removing the gamemode watcher | libuv already is the scheduler; the other options were riskier or lost a feature |
| L6: objectLoaded as a 3D signal; buttonEvent for keys; removing the console backstop; dropping the tint trigger; name tags in CEF; JS interpolation; mlh/mrh events for spell slots; events for gated feature loops; `storage.hosted` as a Set; dropping LOS from tags; async CRC | Event floods, gated input, wall-hack tags, or no gain |

## 7. Coverage against Stage 1

**Stage 2 candidates (§6, items 1-12)**

| # | Candidate | Tasks |
|---|---|---|
| 1 | Movement: send on change, skip the sender, validate first, sequenced channel, distance tiers | L3-01, L3-02; L3-03a/b/c; L3-04; L3-05, L3-08; L3-06; also L2-08 (hysteresis), L3-M4, L3-M6, L3-M7 |
| 2 | Streaming: only refs with a delta, only carriable LIGH, one login pass, hysteresis, unload idle chunks, duplicate LoadForm, Disable unsubscribes | L2-01, L2-02, L2-04; L2-03; L2-10; L2-08; unloading **dropped**; L2-05; L2-09; also L1-06, L2-06, L2-12, L2-M2, L2-M5 |
| 3 | Persistence: dirty flags and field writes, per-player/per-zone loading with indexes, sorted paging, purge dead docs, timed saves into the native path, registries into Mongo | L1-09 (field writes **dropped**, L1-11); L1-07 (per-zone **dropped**, D1); L1-08 (chunk key **dropped**); L1-01; L1-02, L1-03, L1-17; L1-13, L5-11 (instead of folding into native); L1-14A/B, L1-15, L1-16; also L1-04, L1-10, L1-12, L1-19 |
| 4 | Message pipeline: one parse and a router, less JSON, ordering channels, an honoured `reliable` flag | L6-09, L5-04 (server router **dropped**); less JSON **dropped**; L3-08; L3-07; also L3-14 |
| 5 | One broadcast helper | L3-07 (+L2-14), L2-09 |
| 6 | Worn equipment only; anim vars only while casting; stops only for channels; parse appearance once | L4-04a/b; L4-11, L3-11; L4-12, L4-13; L4-01 |
| 7 | One server-driven hosting model | L2-15, L2-16, L3-02 (timeouts), L6-26 |
| 8 | Client view: dirty FormViews, id maps, native tags, events for polls, cached load-order check | L6-03a/b; L6-01; L6-05; L6-12, L6-13, L6-15, L6-16, L6-18, L6-19, L6-20, L4-08, L6-M3; L6-21 |
| 9 | One TS scheduler, onlinePlayers, hot reload off on live | L5-01; L5-02, L5-03; L5-22 |
| 10 | Voice | L2-20, L2-21, L2-22 |
| 11 | Authority: activation and melee reach, anim-var target, spell-hit rate and link, DOT, appearance validation | L4-30; L4-38; L3-11; L4-39; L4-09 (reliable) and L4-18; L4-02; also L3-04, L4-14, L5-04 |
| 12 | Remove §6 dead code | L3-13, L6-07, L3-15, L5-19, L5-20, L5-21, L1-18, L4-40a/b, L4-41, L6-08, L6-M4, L4-27, X-01 |

**§4 recurring work inventory**

| §4 row | Stage 2 |
|---|---|
| Node `server.tick()` loop | stays; trimmed by L3-15 and L3-16 |
| prom-client tick Histogram and Summary | L5-19 |
| TickDeferredMessages over every user | L3-16 |
| Packet history playback, MockServer tick | L3-15 |
| TickSaveStorage + 3 idle locks; saver thread 100 ms | L1-09 |
| ~30 `setTimeout(1)` loops | L5-01 |
| Gathering updateAsync | L5-15 |
| Gate-only loops | L5-01; afterlife L5-14; durability L4-29; faction L5-13; housing L5-M1; mastery and factionCraft L5-16; soulTrap L5-06; worldFloor L5-26; the rest stay as active-only timers |
| Fixed-sleep loops | L5-01; afk L5-02; goldWatch L5-24; job and npcSpawn L5-03; placedItem L5-18; time L5-09; torch L5-11; weather L5-10; companion, pet, queue, survival, masterClient stay |
| Periodic whole-doc saves | L1-13, L5-11, L5-16; survival stays |
| User-slot scans | L5-02 |
| Networking ping metrics over every slot | L3-16 |
| HostingSystem audit | L2-15 |
| NpcSpawn zones × players | L5-03, L5-M3 |
| Weather region poll | L5-10 |
| TimeSystem gameTime | L5-09 |
| QueueSystem queueStatus | stays (runs only while a queue exists, L5-01) |
| MasterClient POST | stays (L5-17 dropped) |
| Durability wear poll | L4-29 |
| placedItem Mongo `$expr` sweep | L1-15 |
| gm admin loop | L5-07 |
| gm relay reconnect | stays |
| Gamemode file watcher | L5-22 |
| Restoration, effect, reloot, calm and respawn timers | stays |
| UpdateMovement send | L3-01, L3-05 |
| UpdateMovement relay incl. sender | L3-03c, L3-04, L3-06 |
| UpdateAnimVariables while magic equipped | L4-11, L3-11 |
| SpellCast keepAlive and stop echoes | L4-12, L4-13, L4-14 |
| ChangeValues send | stays (event), trimmed by L4-09, L6-14 |
| Host attempts | L6-26, L2-16 |
| `afkPing` | stays (AFK stage) |
| `refDecor` world-wide list | L5-M1, L2-17a/b/c |
| LiveKit server-wide room | L2-20, L2-21, L2-22 |
| Load order check (CRC per boot and reconnect) | L6-21 |
| NetworkingService.onTick + JSON.parse | stays; parse cost L6-09 |
| WorldView/FormView for every form | L6-03a/b, L6-04 |
| Name tags; tint on-screen check | L6-05 |
| `clearKeepOffsetFromActor` per frame | L6-04 |
| SendInputsService.onUpdate | L6-14, L4-16, L3-01 |
| MagicSyncService.onUpdate | L4-16, L4-11 |
| WorldCleaner `findRandomActor` | L6-18 |
| RemoteServer hooks (isMenuOpen, handlers) | L6-12, L6-15, L6-22 |
| GamemodeUpdateService loops | L6-07 |
| ChatService poll | L6-06, L5-08 |
| Fast travel, HUD alpha, menu backstops, getNumKeysPressed, sneak-block | L6-16, L6-12, L6-M3; keys stay |
| getFurnitureReference polls | L6-13, L4-08 |
| CloneSpellGuard twice; NpcHitSpellBlock | L4-16, L4-17 |
| `onceLoad` retry | L6-10 |
| AuthService widget per tick | L6-16 |
| Native TextApi and CEF per frame | stays |
| Carry preview, carry hold, mount seat, syncRelayedCasts | stays (active only) |
| setOpen / isHarvested re-assert | L6-03a |
| Forced re-apply; rehost + printConsole | L3-01, L6-26, L2-16 |
| keepTorch | L6-25 |
| Own inventory re-apply | L6-15 |
| CraftedExtras diff | L4-08 |
| CharacterProgress markers and ingredients | L6-19 |
| RefDecorService re-check | L2-17b |
| MountService isOnMount | L6-20 |
| WeatherService and TimeService timers | L6-16 (10 s recheck stays) |
| CellAnimations retry | L6-20 |
| OpenContainer seat or menu wait | L6-13 (container wait stays) |
| sweepCloneCasts | L6-16 |
| Voice setPeers; LipSync sweeps | L2-21, L6-20 |
| Survival cloak; disease guard | L6-20 |
| Companion, Pet, Emote, FurnitureAnimations, AfterlifeLook, AdminMode, Restraint, DisableDifficulty | stays; AfterlifeLook L6-06; AdminMode freecam and difficulty L6-16 |
| CEF page timers | stays (L2-21 keeps under VoiceManager's 5 s failsafe) |
| Reconnect attempts | stays |

Other Stage 1 §5/§6 findings that fall outside these groups:

| Finding | Status |
|---|---|
| Login has no per-connection guard | out of scope (login stage) |
| 1300-player cap | D33 |
| JSON at the JS edges | dropped |
| Chunk and form unloading | dropped |
| MsgType kept by hand | dropped |
| Backend second persistence | stays |
| Harvest and drop scans | stays |
| CropRegeneration commented block | X-01 |
| Unused grid code | X-01 |

## 8. Expected end state

All "after" values are estimates for after Phase 6, unless measured in Phase 0.

| Metric | Today | After Stage 2 (est.) |
|---|---|---|
| Boot: docs read | 26,896 (29.3 MB) | ~12,000; characters only at login |
| Boot: extra work | 100 threads; ~1.33M docs walked by skip; 26,896 Sha256; ~4.7k log lines; 5.35 GB BSA CRC; chunk loads around ~2,280 FF forms | 1 cursor, 0 hashes, 1 summary line, changed plugins only, no chunk loads |
| Boot time | measure in Phase 0 | tens of seconds shorter (the BSA read alone is 5-30 s) |
| Server TS loops | ~30 loops waking every 1-16 ms (960-15,000 resumes/s) | ~30 plain timers, ~30 wakes/s idle |
| Slot scans | ~500-825 isConnected/s with 0 players | ~0 |
| Per-player N-API from TS at 1,000 players | ~460,000/s (npcSpawn, floor, weather, offers) | ~7,000/s |
| Saver thread idle wakeups | 10/s | 0 |
| Client natives (20 players, 20 NPCs, 30 doors) | ~60,000/s | ~3,000/s |
| Client parses per custom packet | 47 | 1 |
| Upstream movement per player | 7.5 Hz | ~3.6 Hz average, 1 Hz idle |
| Movement to a player in a 30-player area | ~225 packets/s (~14 KB/s) | ~55-68 packets/s (~2.4-3 KB/s) |
| Plugin-ref creates entering a city | 569 (~35-50 KB) | ~10-40 |
| Neighbour create of a player | full inventory + learnedSpells + private dumps (several to tens of KB) | worn gear + appearance (~1 KB) |
| UpdateEquipment relay | 2-10 KB × listeners | 0.3-0.8 KB |
| refDecor per claim change | 110-350 KB to every online user | <200 B |
| Whole-doc writes per active player | up to ~35/min (ChangeValues 30, needs 1, torch 1, position 2, + 1 per chat line heard) | ~2/min |
| NPC, pet and companion writes | 5-20 per NPC lifetime | 0 |
| Full-collection scans | 48/day + 1 per boot | 0 |
| Combat log volume | 4-7 GB/day at 200 hits/s | debug only |
