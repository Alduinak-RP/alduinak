# Syncing: Stage 1 outline

Path key: `sgl/` = skymp5-server/cpp/server_guest_lib, `cpp/` = skymp5-server/cpp, `ts/` = skymp5-server/ts, `systems/` = skymp5-server/ts/systems, `svc/` = skymp5-client/src/services/services, `view/` and `sync/` = skymp5-client/src/view and src/sync, `sp/` = skyrim-platform/src/platform_se/skyrim_platform, `gm/` = build/dist/testserver/gamemode_extensions (gitignored live files). Line numbers are from main 46bd03e6 on 2026-10-04.

Rate terms:
- **frame:** the client `update` event (about 60 Hz, paused in pausing menus) or the client `tick` event (every frame, menus included).
- **server tick:** one pass of `server.tick(); await setTimeout(1)` (ts/index.ts:412-426). That is 1 ms nominal and 1-16 ms in practice on Windows. There is no fixed tick rate.

These items were checked against the source, not just taken from the readers:
- Actors subscribe to themselves (sgl/MpObjectReference.cpp:745-755), and SendToNeighbours does not skip the sender (sgl/ActionListener.cpp:445-450).
- There are 18 `makeProperty` registrations.
- 32 TS systems define `customPacket` and 30 define `updateAsync`.
- DeathStateContainer goes only to the owner or host (sgl/MpActor.cpp:1329).
- Gathering's `updateAsync` has no gate.
- Every cast the player makes is echoed back and logged as an error (svc/remoteServer.ts:1845-1851).
- ApplyChangeForm sets `blockSaving` for its whole body, and EditChangeForm requests no save while it is set (sgl/MpObjectReference.cpp:1227-1229; sgl/ChangeFormGuard.h:31).
- SendMessageToActorListeners always sends reliable and ignores its `reliable` argument (sgl/MpObjectReference.cpp:2141-2147).
- gm/70_admin_loop.js:9-14 writes `isAdmin`, `spawnDelay` and `ff_knownIds` only when a value differs.

## 1. Purpose

Syncing makes every connected player see the same world and the same other people. Each player has one RakNet UDP link between the Skyrim Platform client (MpClientPlugin.dll, driven by skymp5-client) and the native game server (C++ PartOne, exposed to Node as ScampServer). Voice runs beside it on its own LiveKit link (§3.13).

The server owns the world:
- It decides who may enter.
- It streams each player the forms in a 3x3 block of 4096-unit grid cells around them.
- It validates and stores what clients report.
- It persists every changed reference to MongoDB `changeForms`.
- It relays player and NPC state to the other players in range.

Each client runs its own character and any NPCs it "hosts", reports their state, and every frame turns the streamed world model into local Skyrim references. Gamemode features (the TS systems and gamemode JS) ride on top through CustomPacket messages and `mp.set` properties.

## 2. End-to-end process (login to seeing the world and others)

0. **Server boot.** `server.attachSaveStorage()` (ts/index.ts:494) reads the whole `changeForms` collection in PartOne::AttachSaveStorage (sgl/PartOne.cpp:348-410) and MongoDatabase::Iterate (sgl/database_drivers/MongoDatabase.cpp:133-309).
   - Characters become disabled MpActors. ForceSubscriptionsUpdate returns early for disabled forms, so they load no chunks (MpObjectReference.cpp:719-722).
   - Plugin-ref deltas are parked in `changeFormsForDeferredLoad`.
   - FF refs and NPCs are instantiated. ApplyChangeForm calls SetPos (MpObjectReference.cpp:1283-1285). Because `everSubscribedOrListened` is still false (555-556), that runs ForceSubscriptionsUpdate, so each enabled one lazy-loads the 3x3 plugin chunks around it (WorldState.cpp:855-884).
   - Then WORLD_LOADED_EVENT fires and the gamemode loads.
1. **Client auth.** SkympClient restores the stored auth or opens the login (svc/skympClient.ts:31-46). AuthService runs the Discord login and polls the backend every 1.5-3.5 s (svc/authService.ts:382-427).
2. **Connect.**
   - The client resolves the peer with GET `{master}/api/servers/{key}/serverinfo` (5 s timeout, svc/settingsService.ts:61-110).
   - On client boot and on every reconnect, LoadOrderVerificationService fetches `{master}/api/servers/{key}/manifest.json` with up to 5 tries (svc/loadOrderVerificationService.ts:24-30; settingsService.ts:141-166). It then reads each non-vanilla plugin in full to take a CRC32. This runs synchronously on the game thread and nothing is cached (skyrim-platform/src/platform_lib/FileInfo.cpp:10-36).
   - Then `NetworkingService.connect` calls `mpClientPlugin.createClient` with the RakNet password `'7_' + Distribution/password` and a 10 s timeout (cpp/mp_common/MpClientPlugin.cpp:12-41, Networking.cpp:59-80).
3. **Server accepts.** ID_NEW_INCOMING_CONNECTION is mapped to a userId (Networking.cpp:385-399, NetworkingCombined.h:136-161), then PartOne::AddUser runs. That emits TS `connect` to every system and the gamemode (ts/index.ts:446-457) and sends the cached **UpdateGamemodeData (32)** reliable (PartOne.cpp:976-990). TimeSystem also sends `gameTime`.
4. **Login.** On connectionAccepted the client sends **CustomPacket `loginWithSkympIo`** {session} and arms a 15 s timer (authService.ts:646-718). The server runs systems/login.ts:117-286:
   1. a backend session GET (up to 10 retries)
   2. a guid check
   3. the gamemode `onLoginAttempt`
   4. a POST to connection-check
   5. one Discord guild-member call per guild
   6. an IP re-check

   It then emits LOGIN_VERIFIED_EVENT. On failure it sends a `loginFailed*` custom packet or `kicked`.
5. **Queue.** If play slots are free, QueueSystem emits `spawnAllowed` at once. Otherwise it sends **`queueStatus`** every 5 s and on every change (systems/queueSystem.ts:23-27,78,202-204).
6. **Character select.**
   - spawn.ts sends **`characterSelectMenu`** (509-528) and the client answers **`characterSelectResult`** (233-246).
   - onSelectCharacter then runs cancelPark, unpark, releaseSeat, setEnabled(true), bringInsideBorder, setRaceMenuOpen, `svr.setUserActor`, applyAuthProps and `userAssignActor` (spawn.ts:539-625).
   - setRaceMenuOpen sends **SetRaceMenuOpen (29)** through ScampServer.cpp:990-995 and PartOne::SetRaceMenuOpen (PartOne.cpp:277-300). Papyrus can also send it (sgl/script_classes/PapyrusGame.cpp:176). The client handles it at remoteServer.ts:379 and 1541.
7. **Stream-in.** PartOne::SetUserActor (PartOne.cpp:180-237) runs UnsubscribeFromAll, RemoveFromGridAndUnsubscribeAll, actorsMap.Set and ForceSubscriptionsUpdate.
   - Interest is the same world or cell plus the 3x3 block of 4096-unit chunks (MpObjectReference.cpp:161-164,717-758; Grid.h).
   - Plugin chunks not seen before are lazy-loaded at this point (WorldState.cpp:855-892).
   - Every emitter/listener pair gets one reliable **CreateActor (33)** (PartOne.cpp:831-956).
   - The player's own actor arrives with `isMe`, its inventory and every non-private property.
8. **Client spawn.** remoteServer.onCreateActorMessage (svc/remoteServer.ts:869-1000) fills the world model. `isMe` triggers LoadGameService.loadGame, a full engine load (1199-1200), and the login UI closes.
   - Plugin refs below 0xff000000, doors excepted, get a one-shot apply through `onceLoad` (871-932, 1796-1821).
   - Actors, FF refs and plugin doors get a FormModel and a FormView.
9. **Steady state, client to server.** SendInputsService runs on every `update` (svc/sendInputsService.ts:49-147), for the player and for each hosted NPC:

   | Message | When |
   |---|---|
   | **UpdateMovement (2)** | every 130 ms, unreliable |
   | **UpdateAnimation (3)** | on change |
   | **UpdateEquipment (5)** | at most once per 300 ms |
   | **ChangeValues (16)** | at most once per 2 s |
   | **UpdateAppearance (4)** | when the RaceSex menu closes |
   | **Host (14)** | one per frame from the queue |

   MagicSyncService adds **UpdateAnimVariables (24)** every 500 ms while magic is equipped, plus **SpellCast (23)**.

   Event-driven sends: **Activate (6)**, **PutItem (8)** and **TakeItem (9)**, **DropItem (19)**, **OnEquip (11)**, **OnHit (17)**, **PlayerBowShot (22)**, **CraftItem (13)**, **ConsoleCommand (12)**, **FinishSpSnippet (10)** and **CustomPacket (1)**.
10. **Server processing.** Server::Tick drains RakNet with no per-tick budget (Networking.cpp:187-203). Then PartOne::HandleMessagePacket, then PacketParser (PacketParser.cpp:51-181), then `ActionListener::On*`.
    - Relayed types go through SendToNeighbours (ActionListener.cpp:396-453). It checks ownership or hosting, then forwards the raw bytes to every actor listener, the sender included.
    - State changes edit the changeForm through EditChangeForm and RequestSave.
11. **Server to client.**
    - Relays of movement, animation, anim variables, casts, equipment and appearance.
    - **UpdateProperty (7)** for isOpen, isHarvested, isHostedByOther, isDead and `ff_*` props.
    - **UpdateAppearance (4)** from a server-side `mp.set(actor, "appearance")`.
    - **SetInventory (28)** and **SpSnippet (30)** on deferred channels, flushed every tick (PartOne.cpp:1085-1112).
    - **Teleport (20)** and **Teleport2 (31)**; **HostStart (26)** and **HostStop (27)**; **SetRaceMenuOpen (29)**.
    - **ChangeValues** to the owner or host; **DeathStateContainer (18)**; **OpenContainer (21)**; CustomPacket.

    Each message is serialized as byte 134, then the MsgType byte, then BitStream fields. It is sent RELIABLE_ORDERED on channel 0 or UNRELIABLE, at MEDIUM_PRIORITY (Networking.cpp:174-185).
12. **Client receive.** On every `tick`, NetworkingService.onTick calls `mpClientPlugin.tick`. Each message is converted from binary to an nlohmann JSON dump, copied into an ArrayBuffer, decoded with decodeUtf8, parsed with JSON.parse and emitted as `<type>Message` (svc/networkingService.ts:99-223). RemoteServer writes it into the world model and bumps counters such as numMovementChanges.
13. **Client render.** On every `update`, WorldView calls FormViewArray.updateAll, which calls FormView.update and applyAll for every model form (view/worldView.ts:52-138, view/formView.ts:60-741). That covers copy spawn (placeAtMe plus SpawnProcess), applyMovement, applyAnimation, applyEquipment, tints and name tags.
14. **Moving through the world.**
    - Crossing a 4096 line runs ForceSubscriptionsUpdate: **DestroyActor (25)** for refs that leave, CreateActor for refs that enter (MpObjectReference.cpp:546-556).
    - A load door sends **Teleport**, then the server runs SetCellOrWorldObsolete and SetPos, which re-streams everything.
    - On the client, a world change destroys every FormView (worldView.ts:71-85).
15. **Persistence.** TickSaveStorage hands the dirty buffer over every tick. The AsyncSaveStorage thread wakes every 100 ms and bulk-upserts whole documents keyed by `formDesc` (WorldState.cpp:716-805; MongoDatabase.cpp:77-131). A moving actor's position is saved at most once per 30 s (MpObjectReference.cpp:1385-1390). Several systems also save whole documents on their own timers (§3.3).
16. **Disconnect.** After the 10 s RakNet timeout, ServerSideUserDisconnect runs Durability::Settle, TS `disconnect`, AnimationSystem ClearInfo and serverState.Disconnect (PartOne.cpp:474-493). spawn.ts parks the body for `logoutGraceMs` (248-300), and the queue keeps the slot for 120 s. The parked body stays a listener of the refs around it until restart (§3.2).
17. **Reconnect and kick.**
    - ConnectionWatchdog retries every 10 s, up to 5 times, and gives up at 60 s (svc/connectionWatchdogService.ts:10-83). Every reconnect replays steps 2-8: the manifest fetch and CRC32 pass, character select and a full loadGame.
    - A kick sends `kicked`, then CloseConnection (systems/kickUtil.ts:6-10).
    - A failed teleport sends `teleportReport` and quits to the main menu (remoteServer.ts:772-867).

## 3. What is included

### 3.1 Transport and session

**Purpose.** Framing, reliability, the login, queue and select handshake, the load order check, kicks, reconnects, the server loop, and the backend console relay.

**How it works**
- **Wire format:** packet byte 134, then the MsgType byte, then BitStream fields: raw floats, uint32 length-prefixed strings, 1-bit bools (cpp/messages/MessageSerializerFactory.cpp, serialization/include/archives/BitStreamOutputArchive.h). There are 33 types in cpp/messages/MsgType.h, mirrored by hand in skymp5-client/src/messages.ts and 35 TS interfaces.
- **JSON at both JS edges:**
  - Client send: JSON.stringify, then a simdjson parse in MpClientPlugin::Send, then binary.
  - Client receive: binary, then an nlohmann dump, then an ArrayBuffer copy, decodeUtf8 and JSON.parse (svc/networkingService.ts, cpp/client/main.cpp:26-41, sp/MpClientPluginApi.cpp:92-121).
- **Reliability:**
  - Client "reliable" is RELIABLE (unordered). Server "reliable" is RELIABLE_ORDERED on channel 0. Unreliable is UNRELIABLE, not sequenced.
  - Every message uses MEDIUM_PRIORITY (Networking.cpp:89-93,174-185). The timeout is 10 s on both sides.
- **Server networking:**
  - ServerCombined merges RakNet and the bot MockServer into one userId space (cpp/mp_common/NetworkingCombined.h).
  - PacketParser dispatches the 21 client-sent types.
  - The RakNet drain has no per-tick budget (Networking.cpp:187-203), and ScampServer::Tick goes back into the drain after any handler throws (ScampServer.cpp:836-847).
  - `MAX_PLAYERS` is 1300 at compile time (cpp/CMakeLists.txt:47).
- **Session code:**
  - Server: systems/login.ts, queueSystem.ts, spawn.ts, kickUtil.ts.
  - Client: svc/authService.ts, connectionWatchdogService.ts, kickService.ts, loadOrderVerificationService.ts.
- **Load order check:** the manifest fetch and the full-file CRC32 of each non-vanilla plugin, on every client boot and every reconnect, with no cache (step 2).
- **Console relay:** gm/80_relay.js connects to skymp5-backend/sources/wsRelay.js (7778 live, 7779 test) and carries `console_command` and `console_output`.

**Messages**
- CustomPacket `loginWithSkympIo`, `loginFailed*`, `queueStatus`, `characterSelectMenu`, `characterSelectResult`, `characterSelectMenuRequest`, `kicked`, `teleportReport`, `afkPing`.
- UpdateGamemodeData (32), once per connect.
- HTTP GET `serverinfo` and `manifest.json`.
- Relay WS messages: `auth`, `auth_ok`, `console_command`, `console_output`.

**Recurring costs**
- The server tick loop: a RakNet drain of the real server plus the MockServer, then TickPacketHistoryPlaybacks, TickDeferredMessages and WorldState::Tick.
- A prom-client Histogram and a Summary (t-digest) are observed on every tick (ts/index.ts:414-423).
- Networking ping metrics every 3 s over every maxConnections slot.
- MasterClient POST every 5 s.
- Client receive on every frame.
- A reconnect every 10 s while disconnected, each with a manifest fetch and a CRC32 of every non-vanilla plugin.
- `afkPing` every 60 s.
- While connecting, the login widget is re-sent to CEF every tick.

### 3.2 Streaming and loading (interest management)

**Purpose.** Decides which server forms each player has, and when plugin references enter server memory.

**How it works**
- **Grid:** one GridImpl per world or cell (sgl/Grid.h, WorldState.h:329-338). Each ref sits in the 9 chunk sets around its chunk, so a neighbour query is a single lookup. GetGridPos is `int16(pos/4096)`, which truncates toward zero (MpObjectReference.cpp:161-164).
- **Lazy plugin chunks:** WorldState::GetNeighborsByPosition (WorldState.cpp:855-892) loads unvisited chunks from the per-file libespm index (libespm/src/Browser.cpp:255-268, CombineBrowser.cpp:121-130).
  - LoadForm and AttachEspmRecord (WorldState.cpp:383-714) keep: NPC_ (only when npcEnabled; it is off), FURN, ACTI, DOOR, CONT, FLOR and TREE with an ingredient, and every item type including every LIGH (libespm/src/Utils.cpp:41-48).
  - Chunks are never unloaded.
- **Recompute triggers:** a chunk change in SetPos, SetCellOrWorld, Enable, SetUserActor, LoadForm, Papyrus PlaceAtMe, SetPosition and MoveTo, ScampServer::Place, and door teleports. ForceSubscriptionsUpdate takes the set difference of old and new and subscribes in both directions, the actor to itself included (MpObjectReference.cpp:717-758).
- **Subscribe:** the first player listener fires OnInit, OnCellLoad and OnLoad. Emitters with a primitive (trigger volume) go into `emittersWithPrimitives` and send nothing. onSubscribe sends CreateActor; onUnsubscribe sends DestroyActor (PartOne.cpp:831-973). Subscribe calls the subscribe callback even when nothing new was inserted (MpObjectReference.cpp:1033-1044).
- **Disable:** removes the form from the grid and unsubscribes its own listeners (RemoveFromGridAndUnsubscribeAll, MpObjectReference.cpp:1799-1813). It never calls UnsubscribeFromAll, so a parked character stays a listener of the static refs around where it logged out until restart. As a result:
  - every isOpen, isHarvested or `mp.set` broadcast from those refs serializes a message for that character, and only then finds no user (PartOne.cpp:740-753);
  - `actorNeighbors` returns it (cpp/addon/property_bindings/ActorNeighborsBinding.cpp:12-19);
  - a later Enable re-sends CreateActor through Subscribe.
- **CreateActor contents** (MpObjectReference.cpp:383-449, MpActor.cpp:445-485, PartOne.cpp:901-926):
  - Every ref: refrId, baseId, idx, isMe, transform, the DOOR flag, `isDisabled`, `lastAnimation`, `setNodeScale`, `setNodeTextureSet` and `displayName` (MpObjectReference.cpp:402-439). The client applies the last five in the plugin-ref path (remoteServer.ts:891-923).
  - Actors add: appearance, equipment, last animation event, isDead, isHostedByOther, learnedSpells and templateChain.
  - Custom props are filtered by `private.*` and by makeProperty visibility.
  - The owner also gets inventory, base actor values and isRaceMenuOpen.
- **Client:** non-door plugin refs take the `skipFormViewCreation` path, with the pluginRefProps and pluginRefPose caches and a one-shot apply. Everything else gets a FormModel (remoteServer.ts:869-1000,1816-1821). WorldCleanerService deletes engine-spawned NPCs.

**Messages:** CreateActor (33), DestroyActor (25), Teleport (20), Teleport2 (31).

**Recurring costs** (all event-driven; no subscription work runs per tick)
- A chunk crossing destroys and creates every ref in a 3-chunk row: a few hundred messages in a city.
- The first visit to a chunk costs about 8,100 hash lookups (9 chunks x 90 plugins x GetRecordsAtPos), plus one ForceSubscriptionsUpdate per new ref.
- Every movement packet runs a polygon test against every nearby primitive.
- Every broadcast from a ref near a logout spot serializes a message for each parked character there.
- On the client, `onceLoad` retries for up to 120 frames per plugin ref, and every DestroyActor runs syncFormArray over the whole model.

### 3.3 Persistence

**Purpose.** World and character state survives restarts. Every changed reference or actor carries one MpChangeForm: position, inventory, equipment, appearance, AV percentages, spells, effects, flags, profileId and dynamicFields (every `mp.set` prop, `private.*` included).

**How it works**
- **Boot load:** IterateSync runs with an empty filter (MongoDatabase.cpp:150). MongoDatabase::Iterate does `count_documents({})`, then up to 100 threads of `find({})` with skip/limit, batch_size 1001 and no sort (211-221).
  - Each thread builds one big JSON string of its slice (225) and parses it into a simdjson DOM (248-262). The whole collection therefore sits in memory as text and DOM at once.
  - A chained `Sha256` runs per doc (287): about 26.9k hashes at boot.
  - Each doc goes through JsonToChangeForm and then LoadChangeForm. Characters are forced disabled.
  - Deleted docs and FF items without `private.placedAt` are skipped, but only after they are fetched and parsed. Each skip writes an info log line (PartOne.cpp:359-388, 367, 383): about 3.7k lines on live.
  - The final check compares counts only.
- **Edits:** there are 54 EditChangeForm sites (27 in MpActor.cpp, 27 in MpObjectReference.cpp). In RequestSave mode the whole struct is copied into `changesByIdx[idx]`, a dense vector (WorldState.cpp:305-323; ChangeFormGuard.h:27-35).
  - Movement position saves only when the form has made no save request for 30 s; every other edit saves at once.
  - While ApplyChangeForm runs, `blockSaving` is set, so applying a stored changeForm requests no save (MpObjectReference.cpp:1227-1229).
- **Flush:** TickSaveStorage moves the vector to AsyncSaveStorage (viet/include/save_storages/AsyncSaveStorage.h). The game-thread `Tick()` takes 3 locks every server tick, even with nothing to save (118-131, 172-215). The saver thread wakes every 100 ms and locks 5 mutexes even when idle (296, 426-434). UpsertImpl then:
  1. runs ToJson, a sanitize pass, dump and bsoncxx::from_json per doc;
  2. builds `update_one({formDesc}, {$set: whole doc, $unset: ...}, upsert)` for each;
  3. sends them all in one ordered bulk, with one batch in flight (MongoDatabase.cpp:77-131).
- **`mp.set`:** CustomPropertyBinding calls SetPropertyValueDump, which writes dynamicFields, requests a save and sends UpdateProperty. There is no equality check (CustomPropertyBinding.cpp:55-77, MpObjectReference.cpp:780-797). `private.indexed.*` keys also feed an in-memory index.
- **Periodic whole-doc saves per online player:** `private.needs` every 60 s (needsSystem.ts:812-818, 1040-1045), the torch prop every 60 s, survival every 5 min, and the mastery bank every 5 min (masterySystem.ts:613-627).
- **Side stores:**
  - TS JSON files written with synchronous fs on the game thread: bodies, companions, pets, housing, gathering-picks, weather-state, zone-spawns, starter-grants and `writings/` (systems/fileUtil.ts and others).
  - placedItemSystem opens its own MongoClient and runs `$expr` scans.
  - The backend keeps its own mirrored store (skymp5-backend/sources/db.js).
- **Indexes:** only server-manager/src/formDescIndex.js creates them: `formDesc_1`, `worldOrCellDesc_1` and `profileId_1`, on every game start made through the manager (formDescIndex.js:6, 25-36; services.js:86-88). Starts that bypass the manager, such as the nssm 01:00 restart, never ensure them. In the database on 2026-10-04, live had only `formDesc_1`; skymp_test also had `worldOrCellDesc_1` and `profileId_1`.

**Messages:** ChangeValues (saves at once, up to every 2 s), UpdateMovement (saves at most every 30 s), UpdateProperty (with every `mp.set`), and the Mongo calls: count, find, bulk_write and the `$expr` finds.

**Recurring costs**
- The saver thread every 100 ms, and 3 locks on the game thread every tick.
- A full struct copy on every edit.
- About 7 doc writes per player per minute. These include position (at most every 30 s), ChangeValues (at most every 2 s while values change), needs and the torch prop every 60 s, and survival and mastery every 5 min. Player docs are 12-16 KB (average 12.8 KB, max 29 KB), and every write rewrites the whole document.
- Boot reads 26,896 docs (29.3 MB) on live, held as text and DOM at once, with a Sha256 per doc.
- Synchronous JSON file rewrites on change.

### 3.4 Position and movement

**Purpose.** Shows where each player and each hosted NPC is, plus mounts and carried bodies.

**How it works**
- **Sample:** getMovement (sync/movementGet.ts:47-116) reads worldOrCell, pos, rot, runMode (sent as a string), direction, the jump, sneak, block, weapon-drawn and isDead flags, healthPercentage, lookAt (NPCs only) and speed. The player's own movement is filtered by RestraintService and MountService.
- **Send:** every 130 ms per owned actor, with no change check, unreliable. The idx comes from `forms.findIndex` (sendInputsService.ts:149-172; networkingService.ts:40-61). The payload is about 59 B, or 71 B with lookAt.
- **Server:** OnUpdateMovement (ActionListener.cpp:473-555) runs in this order:
  1. paralysis gate;
  2. SendToNeighbours relay (490);
  3. MovementValidation (507-515; rejects a cell change or a jump of 4096 units or more and answers with Teleport2);
  4. SetPos and SetAngle (CalledByUpdateMovement), the block counter and NoteSneaking;
  5. a Papyrus OnTrigger event for each primitive the actor is inside;
  6. a re-stream on chunk change.
- **Receive:** the handler stores `form.movement` and bumps numMovementChanges with no sequence check (remoteServer.ts:1276-1293). applyMovement (sync/movementApply.ts:25-287) then runs:
  - teleportIfNeed;
  - translateTo with 0.2 s extrapolation, capped at 128 units;
  - head tracking;
  - keepOffsetFromActor;
  - the sprint, block, sneak and weapon syncs;
  - health smoothing.

  A forced re-apply runs every 2 s.
- **Mounts:** the rider sends Standing, and the horse is hosted by the rider (systems/petSystem.ts:434-505; svc/mountService.ts:79-166). Observers seat the rider clone every frame (sync/mountApply.ts:281-379).
- **Carry:** `ff_carriedBy` is set by captureSystem, which polls every 350 ms while a carry exists (captureSystem.ts:286-330). Each client holds the body on its local copy of the carrier every frame (sync/carryHold.ts:237-262).

**Messages:** UpdateMovement (2), Teleport2 (31), Teleport (20), UpdateProperty `ff_mount` and `ff_carriedBy`, CustomPacket `petRequest`, `petMount`, `petDismount`, `carryState` and `restraintState`.

**Recurring costs**
- Upstream: about 7.5 Hz per owned actor.
- Downstream: that rate x every listener in the 3x3 block, the sender included. A crowd of P players costs about 7.5 x P² packets/s; 100 players is about 75k/s.
- About 20 natives per sample and per apply.

### 3.5 Animations

**Purpose.** Replays the graph events and variables of each actor on its copies.

**How it works**
- **Send:** each controlled actor gets one AnimationSource `sendAnimationEvent` hook (sync/animation.ts:393-484). It skips moveStart, turn and `pa_` events and folds equip events. sendAnimation sends the latest event when numChanges moves, unreliable, except get-ups and forced anims, which go reliable (animation.ts:379-380; sendInputsService.ts:243-274).
- **Server:** OnUpdateAnimation (ActionListener.cpp:557-579) relays RELIABLE_ORDERED. For the sender's own actor it runs AnimationSystem::Process (block state only, because the SweetPie callbacks are inactive) and SetLastAnimEvent, which feeds CreateActor.
- **Receive:** applyAnimation runs once per new numChanges (animation.ts:212-274), with sheathe-first polling (0.2 s x 15) and sit collision. A global setupHooks blocks idles and attacks the sync did not send (510-547).
- **Anim variables:** while a spell, staff, Voice or Instant slot is filled and the player is not mounted, MagicSyncService sends a snapshot every 500 ms: 60 bools, 19 floats, 14 ints, about 200 B (magicSyncService.ts:78-115,395). The server relays it unreliable and ignores the payload's actorRemoteId (ActionListener.cpp:1721-1730). Receivers apply it in remoteServer.ts:2011-2036.
- **Papyrus PlayAnimation:** sends one SpSnippet per listener and calls SetLastAnimation. CellAnimationsService replays `lastAnimation` with a 500 ms retry.

**Messages:** UpdateAnimation (3), UpdateAnimVariables (24), SpSnippet (30).

**Recurring costs**
- One relay per event per listener.
- Anim variables: 2 msgs/s per player holding a spell or staff, reliable upstream, to every listener.
- JS hook callbacks on every animation event of every loaded actor.

### 3.6 Appearance, equipment, actor values, inventory and death

**Purpose.** Shows how actors look, what they wear and their health, and handles death and respawn.

**How it works**
- **Appearance:**
  - The server opens and closes the RaceSex menu with **SetRaceMenuOpen (29)** (PartOne.cpp:277-300), driven by spawn.ts and Papyrus (step 6).
  - The client polls for the RaceSex menu closing every frame, then sends UpdateAppearance (sync/appearance.ts:34-87).
  - The server accepts it only while isRaceMenuOpen. It calls SetAppearance, relays the message and calls SendLearnedSpells (ActionListener.cpp:581-602).
  - Server-made changes: `mp.set(actor, "appearance")` calls SetAppearance and sends UpdateAppearance (4) to every listener on deferred channel 2, without overwrite (cpp/addon/property_bindings/AppearanceBinding.cpp:20-47). polymorph.ts, bodySystem.ts and spawn.ts use it.
  - Receivers create a new TESNPC per copy with `createNpc` (appearance.ts:153-173).
  - Appearance is stored as a JSON string and re-parsed on every read (MpActor.cpp:1202-1214):
    - 3 parses per actor CreateActor (PartOne.cpp:860; MpActor.cpp:449);
    - one per GetRaceId (MpActor.cpp:1255-1262), which runs in the damage formulas on every hit (TES5DamageFormula.cpp:141, 254; AlduinakDamageFormula.cpp:215, 294) and in CropRegeneration on every ChangeValues (CropRegeneration.cpp:13);
    - two per `mp.getActorName` (PartOne.cpp:311), which gm `players()` calls for each player once a second.
- **Equipment:**
  - Equip events and a per-frame poll of the spell slots drive it. **OnEquip** goes out on every equip.
  - **UpdateEquipment** is coalesced to at most one per 300 ms and carries the whole inventory plus 4 spell ids (sync/equipment.ts:182-193).
  - OnUpdateEquipment (ActionListener.cpp:651-961) checks the spawn grace, unlearned spells, ownership and slot conflicts, and substitutes the server's condition data. It then relays and persists.
  - Receivers run applyEquipment (a strip and redress, equipment.ts:211-230) and verify 1.5 s later.
- **Actor values:**
  - ChangeValues goes out at most every 2 s, held 500 ms after casting (sendInputsService.ts:180-241).
  - The server applies it to the sender's own actor and ignores idx. It crops regeneration (sgl/CropRegeneration.cpp) and echoes the corrected values.
  - Server damage goes out through NetSetPercentages to the owner or host only (MpActor.cpp:880-948). Neighbours see health only through `movement.healthPercentage`.
- **Inventory:** every change serializes the whole inventory into a SetInventory on deferred channel 0 in overwrite mode, so only the last one per user per tick is sent and earlier ones are thrown away (MpObjectReference.cpp:1963-1972; PartOne.cpp:792-797). The client also re-applies `pcInv` every 5 s (remoteServer.ts:308-355).
- **Death:**
  - Health at 0 calls TryBleedout, which raises `onKillAttempt` for bleedoutSystem.ts. Otherwise Kill runs SendAndSetDeathState: DeathStateContainer to the owner or host, plus UpdateProperty `isDead` to listeners for NPCs only (MpActor.cpp:1320-1352).
  - RespawnWithDelay uses `spawnDelay`. gm/70_admin_loop.js checks it every 5 s and resets it to `respawnSeconds` only when it differs, leaving values of a day or more alone.
  - Observers learn of a player's death only through `movement.isDead`.

**Messages:** SetRaceMenuOpen (29), UpdateAppearance (4), OnEquip (11), UpdateEquipment (5), ChangeValues (16), SetInventory (28), DeathStateContainer (18), UpdateProperty `isDead`.

**Recurring costs**
- A full-inventory relay on every equip burst.
- A full inventory serialization on every inventory change.
- A save at most every 2 s per player while values change.
- A 5 s inventory re-apply.
- Appearance JSON parsed on every hit, every ChangeValues, every actor create and every name lookup.
- Per-frame RaceSex and spell-slot polls.

### 3.7 NPC hosting

**Purpose.** NPC AI does not run on the server. One "host" client runs it and reports the NPC as if it were a player.

**How it works**
- **Client claim:** FormView.tryHostIfNeed fires when an actor has had no movement for more than 1.5 s, or has no host. It is limited to once per 1000 ms per actor, in the same world or cell only (formView.ts:462-474,526-550,1061-1075). The queue sends at most one Host per frame (sendInputsService.ts:366-379; view/hostAttempts.ts).
- **Server claim:** OnHostAttempt (ActionListener.cpp:1236-1287) refuses player actors and fires the gamemode `onHostAttempt` chain (hostingSystem `mayHost`, companion, pet). It takes over when there is no host or the host's last movement is more than 2 s old. Then:
  - UpdateHoster sends `isHostedByOther` to listeners;
  - StartHosting sends HostStart and runs EquipBestWeapon, then ChangeValues after 1 s;
  - HostStop goes to the old host (PartOne.cpp:665-724).
- **Audit:** HostingSystem re-checks the spawn-zone, companion and pet NPCs every 1.5 s, using `actorNeighbors` and `setHoster` (hostingSystem.ts:107-243; ScampServer.cpp:1084-1134).
- **Enforcement:** SendToNeighbours answers an update from anyone other than the host with HostStop.
- **Client state:** `storage.hosted` changes only on HostStart and HostStop (remoteServer.ts:496-521). The host's copy runs local AI (formView.ts:445); the other copies are puppets.

**Messages:** Host (14), HostStart (26), HostStop (27), UpdateProperty `isHostedByOther`.

**Recurring costs**
- Each client sends up to one claim per second per unhosted or stale actor, and each claim crosses into JS and runs an `actorNeighbors` scan.
- The 1.5 s audit.
- Each hosted NPC adds its own 130 ms movement stream and per-frame lookups.

### 3.8 Activation, doors, containers, items and trade

**Purpose.** Doors, containers, pickups, flora, furniture, drops and placed items, player-to-player trade, lever links, door teleports and Papyrus world effects.

**How it works**
- **Press:**
  - The sp/Hooks.cpp:320-352 ActivateButton hook and the TESActivateEvent sink (sp/EventHandler.cpp:96-136) both emit `activate`.
  - ActivationService (svc/activationService.ts:86-265) snapshots the inventory first, then routes the press:
    - an item goes to ItemService (a tap takes it, a 400 ms hold carries it);
    - a carrier at a load door, or a press mid-swing, triggers the load door query;
    - a stale seat is released;
    - anything else is sent as Activate.
- **Server:** OnActivate calls MpObjectReference::Activate, which checks the worldspace only. ActivateEvent then runs 17 TS `onActivate` hooks, followed by ProcessActivateNormal by type (MpObjectReference.cpp:451-516,1480-1619):
  - pickup or harvest;
  - teleport door;
  - door toggle;
  - container (occupant within 512 units);
  - ACTI;
  - FURN seat (256 units).
- **Containers:**
  - The server sends OpenContainer. The client activates the container, then polls every 100 ms until the menu closes and sends Activate with `isSecondActivation` (remoteServer.ts:607-697).
  - ContainersService diffs the inventory and sends one PutItem or TakeItem per entry (containersService.ts:81-169).
  - The server checks the occupant, moves the items and sends SetInventory (deferred, overwrite).
- **Drops and placed items:**
  - DropItemService sends `itemDropPoint` and DropItem. MpActor::DropItem PlaceAtMe's a ref, and PlacedItemSystem sets its pose and `placedAt` (MpActor.cpp:1986-2073; systems/placedItemSystem.ts).
  - Carry, move, nail and pry go through custom packets.
  - A Mongo sweep every 30 min removes drops older than 2 h.
- **Trade:** systems/tradeSystem.ts runs player-to-player trades over custom packets (tradeSystem.ts:17-36). The flow is a request, an invite to accept or decline, offers on both sides (a new offer resets the locks), both lock, both accept. The server then swaps the items atomically.
- **State and effects:**
  - SetOpen and SetHarvested broadcast UpdateProperty; reloot timers restore state.
  - Papyrus Enable, Disable, SetPosition, PlayAnimation and SetDisplayName fan out SpSnippets (script_classes/PapyrusObjectReference.cpp).
  - Gamemode-side: leverLinkSystem.ts, doorTeleportSystem.ts, gatheringSystem.ts, and housing `refDecor` (names and locks).
- **Client apply:**
  - Plugin refs get a one-shot apply through view/modelApplyUtils.ts.
  - Plugin doors and FF items get a per-frame FormView: setOpen every 133 ms, harvested every 666 ms.

**Messages**
- Native: Activate (6), OpenContainer (21), PutItem (8), TakeItem (9), DropItem (19), SetInventory (28), SpSnippet (30), FinishSpSnippet (10), Teleport (20), UpdateProperty `isOpen`, `isHarvested`, `inventory` and `ff_*`.
- Custom: `loadDoorQuery`, `loadDoorAnswer`, `itemGrab`, `itemMove`, `itemRelease`, `itemDropPoint`, `itemMenuRequest`, `itemNail`, `itemPry`, `itemGrabState`, `itemMenuState`, `itemGrabbed`, `itemMoved`, `refDecor`, `notification`.
- Trade, client to server: `tradeRequest`, `tradeRespond`, `tradeSetOffer`, `tradeLock`, `tradeUnlock`, `tradeAccept`, `tradeCancel`.
- Trade, server to client: `tradeInvite`, `tradeState`, `tradeCompleted`, `tradeCancelled`, `tradeNotice`.

**Recurring costs:** per-frame FormViews for doors and items, the 100 ms seat and container poll, a full inventory snapshot per activate, the 30 min Mongo full scan, and reloot timers.

### 3.9 Properties and custom packets

**Purpose.** The two general channels that gamemode features use.

**How it works**
- **Properties:** `mp.set` sends UpdateProperty to every listener if the prop is `isVisibleByNeighbors`, otherwise to the owner only, and always persists it (MpObjectReference.cpp:780-797).
  - The send goes through SendMessageToActorListeners, which always sends reliable and ignores its `reliable` argument (MpObjectReference.cpp:2141-2147).
  - gm/50_properties.js registers 18 props, all with empty `updateOwner` and `updateNeighbor`.
  - UpdateGamemodeData carries the list once per connect. Client GamemodeUpdateService verifies it, builds the functions and deletes them (gamemodeUpdateService.ts:113-262).
  - Each makeProperty call re-serializes and re-signs the whole UpdateGamemodeData (PartOne.cpp:529-588; ScampServer.cpp:1526): 18 rebuilds per gamemode load.
- **Host redirect:** sends that go through GetActorToSendTo reach an NPC listener's host. That covers UpdateProperty, UpdateHoster, server-set equipment (cpp/addon/property_bindings/EquipmentBinding.cpp:40; MpActor.cpp:247) and server-made animation (MpActor.cpp:289). A player hosting k NPCs gets each of these k+1 times. Client relays (movement, animation, anim vars, casts, client equipment) go through SendToNeighbours, which sends by UserByActor only, so they are not duplicated (ActionListener.cpp:445-450).
- **Gamemode hot reload:** a chokidar watcher on the gamemode file is always set up, on live too (ts/index.ts:196-224). Each reload stacks another generation of `mp.on` handlers, and the old ones only mute themselves (index.ts:169-174). After k reloads every event runs k+1 gamemode handler sets.
- **Server custom packets:**
  1. a simdjson parse and minify in C++ (ActionListener.cpp:463-471; ScampServerListener.cpp:28-39);
  2. JSON.parse in ts/index.ts:472-486;
  3. `customPacket(userId, type, content)` on each of the 32 systems that define it;
  4. the gamemode dispatcher parses the same string again (gm/00_core.js:64-75, 65_packets.js).

  There are about 78 client-to-server and about 120 server-to-client kinds.
- **Client custom packets:** svc/customPacketUtil.ts. About 47 `customPacketMessage` subscribers each JSON.parse every packet.
- **Chat:**
  - The client sends `{type:'cef::chat:send'}`, using `type` rather than `customPacketType`.
  - gm/25_chat_core.js scans all players and calls `mp.set ff_chatMsg` on each recipient.
  - The client polls ownerModel every frame (chatService.ts:451-470).

**Messages:** UpdateProperty (7), UpdateGamemodeData (32), CustomPacket (1).

**Recurring costs:** a multi-stage parse and a 32-way dispatch per custom packet, 47 parses per packet on the client, a changeForm save per chat line per recipient, and k+1 handler sets per event after k hot reloads.

### 3.10 World state: weather, time, torches

**Purpose.** Shared realm conditions.

**How it works**
- **Weather:**
  - systems/weatherSystem.ts polls every 2 s. For each online player it resolves the region (point in polygon, weatherRegions.ts) and sends `weather` when that player's region, weather or start time changed.
  - Region rolls are stored in weather-state.json.
  - Client svc/weatherService.ts applies at 1 Hz, re-checks every 10 s, holds SkyrimClear indoors, and sends `weatherRequest` on every load.
- **Time:**
  - systems/timeSystem.ts sends `gameTime` on connect, on `gameTimeRequest`, and to every slot every 60 s (5 s poll).
  - svc/timeService.ts writes the calendar globals every 2 s and blocks the Sleep menu.
- **Torches:**
  - systems/torchSystem.ts lights and douses through `onUpdateEquipmentAttempt`. A 5 s check burns a torch out after 15 min, and `private.torchBurnMs` is saved every 60 s.
  - The client sets `fTorchEvaluationTimer` to 3600 once (svc/npcTorchCheckService.ts), and FormView.keepTorch re-equips copies' torches every 2 s (formView.ts:769-809).

**Messages:** CustomPacket `weather`, `weatherRequest`, `gameTime`, `gameTimeRequest`, `notification`.

**Recurring costs:** the 2 s weather poll over all players, the 60 s time broadcast, the 5 s torch check, the 60 s torch save, the client's 1 s, 2 s and 10 s apply loops, and the 2 s keepTorch per copy.

### 3.11 Combat and magic

**Purpose.** Clients detect hits, casts and shots. The server prices damage, writes health, applies effects, wears gear and gates deaths through bleedout.

**How it works**
- **Hit report:**
  - The native passes every TESHitEvent in the loaded area to JS as `hit`, NPC vs NPC included (sp/EventHandler.cpp:661-712).
  - svc/hitService.ts reports only hits by the player or a hosted aggressor, with a 100 ms magic dedup per pair, as **OnHit**, reliable.
- **Server hit path:** OnHit (ActionListener.cpp:1593-1719) checks, in order: the host, paralysis, JS `onHitAttempt`, the target lookup, same cell, 4096-unit distance (bows excluded), and a dead aggressor (which triggers RespawnWithDelay).
  - **Weapon hits** go to OnWeaponHit (2196-2557):
    1. the splash window, then the row-interval rate limit;
    2. the block arc and shield check, the HitRules verdicts and poison;
    3. the damage chain (ScampServer.cpp:611-700): DamageMultConditional, SweetPieSpell, SweetPie, DamageMult, then AlduinakDamageFormula or TES5, each reading the race through an appearance JSON parse;
    4. CapHit, `onHitDamageAttempt` and Papyrus OnHit;
    5. NetSetPercentages, then Durability and `onHitDamage`.
  - **Spell hits** go to OnSpellHit (2062-2194).
- **Casting:**
  - magicSyncService.ts sends SpellCast with full anim vars, a keepAlive every 3 s while channeling, and a stop plus echoes at +1 s and +3.5 s.
  - OnSpellCast (ActionListener.cpp:1732-1955) validates, relays reliable, and runs the ward and restoration channels (1 s timer, at most 30 ticks).
- **Observers:** replay the cast on the clone with the natives castSpellImmediate and interruptCast (sp/MagicApi.cpp; remoteServer.ts:1842-2009).
- **Local-damage guards:**
  - Clones have attackDamageMult 0, are immortal and have 1e6 health (formView.ts:290-294).
  - svc/cloneSpellGuardService.ts and svc/npcHitSpellBlockService.ts.
  - Server-side TrackNpcHitPoison and GuardReportedHealth.
- **Other parts:**
  - PlayerBowShot is sent unreliable and drives ammo removal.
  - bleedoutSystem.ts ticks every 250 ms while anyone is downed.
  - Durability flushes when a shown percent changes (at least 5 s apart) and 10 s after the last hit (sgl/Durability.cpp).
  - Active effects are persisted as `effects` (sgl/ActiveMagicEffectsMap.cpp).

**Messages**
- Native: OnHit (17), SpellCast (23), UpdateAnimVariables (24), PlayerBowShot (22), ChangeValues (16), SpSnippet `DoCombatSpellApply`, DeathStateContainer (18), SetInventory (28).
- Custom: `npcHitPoisonBlocked`, `bleedoutState`, `racialState`, `stagger`, `repairNotice`, `durabilityConfig`.

**Recurring costs**
- About 5 native-to-JS crossings per weapon hit.
- Appearance JSON parses for the race on every hit.
- 4 reliable SpellCast packets per fire-and-forget cast.
- The anim-var stream.
- A full inventory serialization on durability flushes.
- The 10 s wear poll.
- Info logs on every hit and every cast.

### 3.12 Client view layer

**Purpose.** Turns the streamed world model into local Skyrim references every frame.

**How it works**
- **Clocks:** `tick` is an SKSE task re-queued every frame, menus included. `update` is the Papyrus VM update hook (sp/SkyrimPlatform.cpp:101-147, sp/main.cpp:79-95).
  - About 100 listeners are built at boot (skymp5-client/src/index.ts:121-222), and each `sp.on` is its own native handler.
  - About 50 services hook `update` or `tick`.
- **WorldView.onUpdate** (worldView.ts:52-138):
  1. resets every view when the player changes world;
  2. caches player data in PlayerCharacterDataHolder;
  3. runs FormViewArray.updateAll over every model form.

  Nothing spawns for 1 s after a load.
- **FormView** (formView.ts:60-741):
  - Picks a base: the plugin id, baseId, or a new TESNPC from `createNpc`.
  - Spawns with placeAtMe at the player plus SpawnProcess (setPosition, tints, enable, resurrect), and makes the copy immortal.
  - Runs applyAll every frame and destroys the copy on the next update when needed.
- **Gating:** there are no dirty flags, only numChanges counters and Date.now() throttles. There is no distance, frustum or LOD culling; only name tags (1000 units plus LOS) and the tint check (on-screen) are limited.
- **Around it:** WorldCleanerService, the hosting queue, and GamemodeUpdateService `updateNeighbor` per form (empty).

**Messages:** consumes everything from 3.2 to 3.11.

**Recurring costs**
- Idle, before any remote form exists: about 65-70 natives per frame.
- An NPC copy adds about 10 natives per frame; a player copy about 15, plus about 12 with name tags, including a LOS raycast.
- A plugin door adds about 5, plus setOpen at 7.5 Hz.
- applyMovement costs about 20 natives at 7.5 Hz per remote actor.
- There is an O(n²) id scan per frame.

### 3.13 Voice

**Purpose.** Proximity voice between players, on a LiveKit link separate from RakNet (AlduinakLiveKit 7880 live, AlduinakLiveKitTest 7890 test).

**How it works**
- **Token:** the client asks with `voiceTokenRequest` and the server answers `voiceToken` (systems/voiceSystem.ts:96-123).
- **Room:** every player joins one server-wide LiveKit room with `autoSubscribe: true` (skymp5-front/src/utils/VoiceManager.js:247).
- **Range:** far tracks are dropped only by `setPeers`, which svc/voiceService.ts pushes to the CEF page every 400 ms from the client world model (voiceService.ts:15, 416; VoiceManager.js:375-389).
- **Lip sync:** svc/lipSyncService.ts sweeps speakers (135-287).
- **AFK:** `afkPing` every 60 s (voiceService.ts:19, 388).

**Messages:** CustomPacket `voiceTokenRequest`, `voiceToken`, `afkPing`; LiveKit signalling and media.

**Recurring costs**
- Participant events are world-wide, O(N) per client and O(N²) in total, because every player is in one room and auto-subscribed.
- `setPeers` every 400 ms.
- LipSync sweeps every 1 s and 1.5 s (90 ms while talking).
- VoiceManager page timers at 50, 150 and 2000 ms.

## 4. Recurring work inventory

| Work | Kind | Rate | Where | Could be event-driven |
|---|---|---|---|---|
| Node loop `server.tick()`: RakNet drain (real + MockServer, no budget), deferred flush, save hand-off, timers | per-tick | 1 ms nominal, 1-16 ms real | ts/index.ts:412-426; sgl/PartOne.cpp:149-154; Networking.cpp:187-203 | No (core); could be a fixed-rate tick |
| prom-client tick Histogram and Summary (t-digest) observe | per-tick | every tick | ts/index.ts:414-423 | Sample instead |
| TickDeferredMessages over userId 0..maxConnectedId | per-tick | every tick, O(users) | PartOne.cpp:1085-1112 | Yes: only users with queued messages |
| TickPacketHistoryPlaybacks, MockServer tick | per-tick | every tick | PartOne.cpp:1046-1083; ScampServer.cpp:828-866 | Dead in production |
| TickSaveStorage plus AsyncSaveStorage::Tick (3 locks even when idle) | per-tick | every tick, work only when dirty | WorldState.cpp:716-805; AsyncSaveStorage.h:118-131,172-215 | Yes: on dirty |
| AsyncSaveStorage saver thread (locks 5 mutexes even when idle) | timer | 100 ms forever | AsyncSaveStorage.h:296,426-434 | Yes: wake on Upsert |
| About 30 TS `updateAsync` loops, each `while(1){ await setTimeout(1) }` | per-tick | each wakes every 1-16 ms | ts/index.ts:428-444 | Yes: one scheduler, timers at the next due time |
| GatheringSystem `updateAsync` (pendingSeats, regrowPicks over the whole map, sessions), no gate | per-tick | every pass | gatheringSystem.ts:323-345 | Yes: timer at the next regrow or strike |
| Gate-only loops: afterlife 2 s, bleedout 250 ms (downed), body 2 s, bountyBoard 1 h, capture 350 ms (carrying), durability 10 s, execution 1 s, faction (titles 5 s, access-file statSync 10 s), housing 4 s, search 500 ms, soulTrap 100 ms (traps), worldFloor 500 ms, factionCraft, mastery (bank check per online player 5 s, save 5 min) | timer via per-tick gate | as listed | systems/*.ts; factionSystem.ts:62-64,186-198,790-793; masterySystem.ts:96-98,613-627 | Mostly yes (death, carry and downed events exist) |
| Fixed-sleep loops: afk 15 s, companion 500 ms, goldWatch 10 s, job 1 s, needs 1 s, npcSpawn 2 s, pet 1 s, placedItem 60 s, queue 2 s, survival 1 s, time 5 s, torch 5 s, weather 2 s, masterClient 5 s | timer | as listed | systems/*.ts | Mixed; game rules need some timers |
| Periodic whole-doc saves per online player: needs 60 s, torch 60 s, survival 5 min, mastery bank 5 min | timer | as listed | needsSystem.ts:812-818,1040-1045; torchSystem.ts; masterySystem.ts:613-627 | Partly: field-level writes, save on logout |
| User-slot scans: 8 helpers loop `userSlotCount()` (= maxPlayers) with one N-API `isConnected` per slot | timer | each caller's rate, O(maxPlayers) | adminSystem.ts:305; afkSystem.ts:150; factionSystem.ts:1107; goldWatchSystem.ts:138; housingSystem.ts:1527; placedItemSystem.ts:212; timeSystem.ts:70; writingSystem.ts:569 | Yes: use `onlinePlayers` |
| Networking ping metrics over every maxConnections slot | timer | 3 s | cpp/mp_common/Networking.cpp:205-237 | Keep; loop connected users only |
| HostingSystem audit: `actorNeighbors` per player, distance per hostable | timer | 1.5 s | hostingSystem.ts:107-243 | Partly: grid change, aggro, disconnect |
| NpcSpawnSystem zones x players distance check | timer | 2 s | npcSpawnSystem.ts:547-620 | Partly: chunk change |
| WeatherSystem region poll per player | timer | 2 s | weatherSystem.ts:280-319 | Yes: chunk or cell change plus a region roll timer |
| TimeSystem `gameTime` to every slot | timer | poll 5 s, send 60 s | timeSystem.ts:61-73 | Yes: connect, request, offset change |
| QueueSystem `queueStatus` | timer | 2 s tick, 5 s status | queueSystem.ts:23-27,90-93 | Yes: on queue change |
| MasterClient POST online count | timer | 5 s | masterClient.ts:48-64 | Partly: on count change |
| durabilitySystem wear poll over all players | timer | 10 s | durabilitySystem.ts:220-252 | Yes: native Flush already knows changes |
| placedItemSystem Mongo `$expr` sweep (full scan) | timer | 30 min (60 s loop) | placedItemSystem.ts:314-335 | Yes: in-memory or indexed set |
| gm admin loop: checks isAdmin, spawnDelay and `ff_knownIds` for every player, writes only when a value differs | timer | 5 s | gm/70_admin_loop.js:4-24 | Yes: on spawn or role change |
| gm relay reconnect | timer | 4 s while down | gm/80_relay.js:57-66 | Needed while down |
| Gamemode file watcher (chokidar), live included | event | on file change | ts/index.ts:196-224 | Turn off on live |
| Restoration channel tick, effect timers, reloot timers, durability calm timer, respawn timer | timer (scheduled) | per instance | ActionListener.cpp:1948-1996; MpActor.cpp:2217-2229; Durability.cpp:317-381 | Already event-scheduled |
| UpdateMovement send per owned actor | net stream | 130 ms, unconditional | sendInputsService.ts:149-172 | Partly: on change plus a slow keepalive |
| UpdateMovement relay to listeners, sender included | net stream | per packet x listeners | ActionListener.cpp:445-450 | Partly: skip the sender, distance tiers |
| UpdateAnimVariables while magic is equipped | net stream | 500 ms, reliable | magicSyncService.ts:78-115,395 | Yes: only while casting |
| SpellCast keepAlive and stop echoes | net stream | 3 s while channeling; +1 s and +3.5 s after every stop | magicSyncService.ts:224-226,316-337 | Partly: channels only |
| ChangeValues send | net stream | on change, at least 2 s apart | sendInputsService.ts:180-241 | Event (throttled) |
| Host attempts | net stream | at most 1/s per actor per client | formView.ts:1061-1075 | Partly: server-assigned |
| `afkPing` | net stream | 60 s | voiceService.ts:19,388 | Partly: input events |
| `refDecor` world-wide list to all players | net stream | at most every 4 s when dirty | housingSystem.ts:306-319 | Yes: per cell on load |
| LiveKit participant events in one server-wide room, `autoSubscribe: true` | net stream | every join, leave and track change, world-wide | VoiceManager.js:247 | Yes: per-zone rooms or server-chosen subscriptions |
| Load order check: manifest fetch plus a full-file CRC32 per non-vanilla plugin, on the game thread | event | every client boot and reconnect | loadOrderVerificationService.ts:24-30; FileInfo.cpp:10-36 | Cache by size and mtime |
| NetworkingService.onTick receive, then JSON.parse per message | per-frame (tick) | every frame, menus included | networkingService.ts:99-223 | Needed; parse cost can drop |
| WorldView plus FormView.update/applyAll for every form | per-frame | every update x forms | worldView.ts:52-138; formView.ts:60-741 | Yes: dirty forms only |
| Name tags (LOS raycast, 2 keyword lookups, 3 node reads, screen projection) | per-frame | per player copy while shown | formView.ts:675-740 | Partly: native setTextRefr plus a few Hz visibility check |
| Tint on-screen check (3 node reads plus screen projection) | per-frame | per player copy | formView.ts:574-618 | Partly |
| clearKeepOffsetFromActor | per-frame | per hosted actor | formView.ts:447-450 | Yes: on HostStart |
| SendInputsService.onUpdate (about 18 natives, plus O(n) lookups per hosted actor) | per-frame | every update | sendInputsService.ts:49-147 | Partly: equip events, menuClose |
| MagicSyncService.onUpdate (about 6 natives) | per-frame | every update | magicSyncService.ts:78-115 | Yes: equip events |
| WorldCleanerService `findRandomActor(8192)` plus about 10 natives | per-frame | 1 per update, 8 during a burst | worldCleanerService.ts:38-114 | Yes: objectLoaded or cellAttach |
| RemoteServer hooks (5 isMenuOpen, 6 update handlers, 1 tick handler) | per-frame | every update | remoteServer.ts:308-355,388-476 | Mostly yes |
| GamemodeUpdateService owner/neighbor loops over empty key lists | per-frame | every tick, every update, every form | gamemodeUpdateService.ts:90-217 | Dead |
| ChatService poll of ownerModel `ff_chatMsg`, isAdmin, name | per-frame | every update | chatService.ts:451-499 | Yes: UpdateProperty |
| enableFastTravel(false), HUD rollover alpha, 3 menu backstops, getNumKeysPressed, sneak-block poll | per-frame | every update | disableFastTravelService.ts:6-11; interactionPromptService.ts:86; menuBlockUtil.ts:17-19; keyboardEventsService.ts:12-27; sneakBlockSpeedService.ts:45-95 | Mostly yes (loadGame, menuOpen, input) |
| getFurnitureReference polls (2 services per frame, 1 at 250 ms) | per-frame | every update | blockedAnimationsService.ts:30-35; craftedExtrasService.ts:146-156; furnitureSeatService.ts:28-56 | Yes: furnitureEnter and furnitureExit |
| CloneSpellGuard.enforce (runs twice), NpcHitSpellBlock expiry, other early-out handlers | per-frame | every update | cloneSpellGuardService.ts:66-91; sendInputsService.ts:192 | Cheap; the duplicate call can go |
| `onceLoad` retry per plugin-ref CreateActor | per-frame | up to 120 frames each | remoteServer.ts:1796-1814 | Yes: cell attach or objectLoaded |
| AuthService login widget re-sent to CEF | per-frame (tick) | every tick while connecting | authService.ts:720-733 | Yes: on dot change |
| Native TextApi::OnUpdate; CEF RunTasks, InjectMouseMove, 256-key repeat scan | per-frame | every update | sp/TextApi.cpp:489-520; sp/main.cpp:466-500 | Native, needed |
| Carry preview, carry hold, mount seat, syncRelayedCasts | per-frame | only while active | itemService.ts:99-137; carryHold.ts:237-262; mountApply.ts:281-379; magicSyncService.ts:308-337 | Needed while active |
| FormView setOpen and isHarvested re-assert | timer | 133 ms and 666 ms per form; every frame for the crosshair ref | formView.ts:376-403 | Yes: UpdateProperty plus 3D load |
| Forced movement re-apply; rehost plus printConsole for a stalled copy | timer | 2 s; 1 s per stalled form | formView.ts:460-477 | Partly |
| keepTorch | timer | 2 s per torch-holding copy | formView.ts:769-809 | Overlaps the engine timer fix |
| Own inventory re-apply (2 getInventory, diff, apply, names) | timer | 5 s | remoteServer.ts:308-355 | Yes: SetInventory or containerChanged |
| CraftedExtras inventory diff | timer | 1 s | craftedExtrasService.ts:146-182 | Yes |
| CharacterProgress map markers (517 refs); ingredient poll | timer | 10 s; 5 s | characterProgressService.ts:207-347 | Yes: locationDiscovery, containerChanged |
| RefDecorService re-check of every claimed door in the world | timer | every 30 frames | refDecorService.ts:82-149 | Yes: on cell load |
| MountService isOnMount | timer | 130 ms forever | mountService.ts:125-180 | Partly |
| WeatherService apply and recheck; TimeService globals | timer | 1 s and 10 s; 2 s | weatherService.ts:57-136; timeService.ts:87-126 | Partly |
| CellAnimationsService retry | timer | 500 ms | cellAnimationsService.ts:30-52 | Yes: 3D load |
| OpenContainer seat or menu wait | timer | 100 ms for as long as seated or the menu is open | remoteServer.ts:650-666 | Yes: menuClose, furnitureExit |
| sweepCloneCasts | timer | 250 ms | remoteServer.ts:1970-2009 | Bounded |
| Voice setPeers to CEF; LipSync sweeps | timer | 400 ms; 1 s and 1.5 s (90 ms while talking) | voiceService.ts:362-365,392-418; lipSyncService.ts:135-287 | Yes: on change |
| Survival cloak effects; disease guard | timer | 500 ms; 10 s | survivalService.ts:213-278 | Partly: effect events |
| Companion 250 ms, Pet 250 ms, Emote 250 ms, FurnitureAnimations 500 ms, AfterlifeLook 1 s, AdminMode 2 s and 1 s, Restraint 100 ms when locked, DisableDifficulty every 60 frames | timer | as listed | respective services | Mixed |
| CEF page timers: VoiceManager 50, 150 and 2000 ms; chat; death countdown; admin panel | timer | as listed | skymp5-front/src/utils/VoiceManager.js:430-445 and others | Mostly UI |
| Reconnect attempts | timer | 10 s x 5, give up at 60 s | connectionWatchdogService.ts:10-83 | Needed |

## 5. Loading

**Server, today**
- **Boot reads the whole `changeForms` collection.** On live, 2026-10-04, that is 26,896 docs and 29.3 MB BSON:
  - 20,677 plugin-ref deltas, of which 11,140 are gathering vein state and 3,166 housing claims;
  - 227 characters;
  - 2,231 FF refs and 49 FF NPCs;
  - 3,717 isDeleted docs (13.8%), of which 3,450 are despawned spawn NPCs.

  Every doc is fetched, hashed and parsed, the ones about to be skipped included, and each skip logs an info line (PartOne.cpp:359-400; MongoDatabase.cpp:141-150, 287). Each Iterate thread holds its slice as one JSON string and a simdjson DOM at the same time (MongoDatabase.cpp:225, 248-262).
- **Characters:** every character ever made becomes a disabled MpActor, off the grid, and loads no chunks. That is what feeds `actorIdByProfileId` and `private.indexed.*`.
- **Parked characters:** a logged-out character stays a listener of the refs around where it logged out until restart (Disable never calls UnsubscribeFromAll), so broadcasts there keep serializing messages for it.
- **Plugin-ref deltas:** held in `changeFormsForDeferredLoad`, copied on apply and never erased, so they live twice once applied (WorldState.cpp:227-238, 703-707, 906).
- **FF forms:** instantiated. Each enabled one loads the 3x3 plugin chunks around it at boot, with no player present.
- **Plugin refs:** loaded lazily per chunk on first touch and never unloaded.
  - In Skyrim.esm alone, 146,186 of 690,651 enabled REFRs are loaded types: MISC 33,542, ACTI 17,577, ALCH 15,907, TREE 14,578, CONT 12,271, LIGH 12,076, FLOR 11,546, FURN 11,129.
  - 12,058 of the 12,076 lights cannot be carried.
- **TS and backend:** the JSON registries are read whole; placedItemSystem scans Mongo; the backend mirrors all 9 of its collections in memory.

**Each player, today**
- **Location filter:** the same world or cell, plus the 3x3 chunk square (12,288 units; 4096-8192 units to the edge; chunk 0 is 8192 units wide). There is no height filter, and no distance, LOS or LOD filter inside the block.
- **Stream size** (Skyrim.esm only): a Tamriel 3x3 block holds a median of 56 plugin refs (max 311); a city child world reaches 569; interiors hold a median of 135 per cell (max 1,056) and usually stream whole.
- **Sent but not needed:**
  - A CreateActor and DestroyActor for every interactable plugin ref, even when it is unchanged from the ESP.
  - Other players' whole inventories, through UpdateEquipment and CreateActor.
  - learnedSpells and templateChain to every neighbour.
  - The player's own relayed packets, echoed back.
  - Each UpdateProperty, server-set equipment change and server-made animation sent once more for every NPC the player hosts.
  - Create, Destroy and Create again to neighbours at login.
  - World-wide lists: `refDecor` (every claimed door), `itemGrabbed` and `itemMoved` (the whole worldspace), `gameTime` every 60 s.
  - Voice events for every player on the server, with far tracks dropped only on the client.
  - Chat delivered as a persisted property.
- **Already limited correctly:**
  - `private.*` never leaves the server, and makeProperty visibility is respected (PartOne.cpp:901-926).
  - Container contents go only to the opener.
  - Hit results and ChangeValues go only to the owner or host.
  - Weather goes only to the player whose region changed.
  - SetInventory is overwritten in the deferred queue, so at most one per user per tick goes out.
- **Reconnect:** resends everything, including a full loadGame, the manifest fetch and a fresh CRC32 of every non-vanilla plugin.
- **Client side:** every streamed actor, FF ref and plugin door gets a per-frame FormView, wherever it is in the block. The plugin-ref caches and created TESNPC bases are never freed.

**What per-zone and per-player loading would require**
1. **Characters on demand by profileId at login.**
   - The filtered Iterate only supports `formDesc $in`.
   - `profileId_1` is in the manager's ensure list, but on 2026-10-04 it existed only on skymp_test.
   - The synchronous `getActorsByProfileId` callers would have to await a load: login.ts:191/255, spawn.ts:445/957, queueSystem.ts:271, factionSystem.ts:868, afterlifeSystem.ts:149.
   - Logout would flush the save, wait for the Upsert callback, then DestroyForm. That would also fix the parked-listener leak.
2. **Whole-world lookups turned into indexed DB queries:**
   - `findFormsByPropertyValue(private.indexed.*)`: discordBanSystem.ts:92, bodySystem.ts:302, polymorph.ts:177.
   - `getAllForms(0xff)`: npcSpawnSystem.ts:983.
   - dynamicFields keys are literal dotted names, so they need `$getField` or indexed top-level columns.
3. **A safe FF id allocator.** GenerateFormId restarts at 0xff000000 on every boot and skips only ids in memory (WorldState.cpp:1094-1100).
4. **A zone key.**
   - `worldOrCellDesc` is not selective (Tamriel alone holds 10,969 docs).
   - A stored chunk key matching GetGridPos would need an index and an update whenever a form changes chunk.
   - Chunk loading is synchronous inside the tick, so it would need async prefetch near chunk edges, or an in-memory formDesc-to-chunk index.
5. **Dead docs filtered or removed:** filter isDeleted and unplaced FF items in the query, or hard-delete them or give them a TTL.
6. **Sorted or keyed paging:** replace unsorted skip/limit with a sorted or `_id`-ranged read.
7. **Smaller writes and server-owned indexes:** field-level writes instead of whole-document `$set`, a unique `formDesc` index (no duplicates exist today), and index creation by the game server at boot. Today only the manager ensures indexes, and starts that bypass it (the nssm 01:00 restart) skip that step.

## 6. Problems found

**Dead code**
- An empty second `server.on('customPacket')` listener: ts/index.ts:488-490.
- The `/rpc/:rpcClassName` HTTP route does nothing, because `onHttpRpcRunAttempt` is not set anywhere: ts/ui.ts:52-66.
- The raw-message path (`anyRawMessage`, `sendRawMessage`, SendRaw) is unused: networkingService.ts:17,36-39,126-130; MpClientPlugin.cpp:104-114.
- Client-to-server UpdateProperty is parsed and ignored: PacketParser.cpp:131-133.
- CustomEvent (15) is never sent, because there is no makeEventSource: gamemodeEventSourceService.ts:98-104; ActionListener.cpp:1289-1312.
- UpdateGamemodeData and GamemodeUpdateService do nothing: all 18 props have empty bodies, yet per-frame loops still run: gamemodeUpdateService.ts:90-262; gm/50_properties.js; formView.ts:319-320.
- MasterApiBalanceSystem has no consumer: systems/masterApiBalanceSystem.ts.
- The wsRelay player protocol (`register_nonce`, `chat_*`, `player_*`) has no producer: wsRelay.js:16-31,128-158,182-188.
- MockServer and packet-history playback have no production caller but are ticked every tick: ScampServer.cpp:274,587-588; PartOne.cpp:1046-1083.
- Unused grid code: GridElement.h, GridPosInfo, GridImpl::IsNeighbours, and the test-only GetNeighbours, GetNeighboursAndMe and GetPos: WorldState.h:6; MpObjectReference.h:27-38; Grid.h:54-66,100-105.
- Client handling of a `disabled` prop that nothing sends: remoteServer.ts:903,1415-1416.
- Empty if blocks: WorldState.cpp:610-611; remoteServer.ts:1018-1019.
- SweetPie paths are inactive because SweetPie.esp is not loaded:
  - AnimationSystem stamina callbacks: AnimationSystem.cpp:19-31,86-241.
  - The SweetPie and SweetPieSpell formula wrappers, and DamageMult at 1: ScampServer.cpp:690-695.
  - Four `hasSweetpie` checks: ActionListener.cpp:63-67; MpActor.cpp:2177-2185; EatItemEvent.cpp:43-46.
  - SweetHidePlayerNamesService: SweetHidePlayerNamesService.cpp:15-24.
  - sweetCameraEnforcementService.
- MpChangeForm::quests is never used, and the `lastAnimation` write is commented out: MpChangeForms.h:135-136; MpChangeForms.cpp:83-86.
- The filtered Iterate is used only by MigrationDatabase; the File, Zip and Migration drivers are unused; ISaveStorageUtils is used only by tests: AsyncSaveStorage.h:101-106; DatabaseFactory.cpp:20-54.
- MpActor::RemoveAllMagicEffects and SetActorValues have no callers: MpActor.cpp:2136-2141,2284-2296.
- CropRegeneration ignores `hasActiveMagicEffects`: CropRegeneration.cpp:75-78.
- The OnHit `projectile` field is never read: HitMessage.h:27; hitService.ts:73.
- `isSpellCastAnim` is never called, and OnWeaponHit's `isUnarmed` parameter is unused: magicSyncService.ts:354-364; ActionListener.cpp:2198.
- The melee reach helpers are used only by commented-out code: ActionListener.cpp:1444-1560,2278-2297.
- `blockStamina` is parsed in C++ but never read: AlduinakCombatSettings.cpp:909-912.
- The 62_mastery.js `hit` relay is discarded by masterySystem: gm/62_mastery.js:20-25; masterySystem.ts:304,523.
- The god-mode branch of 60_admin_modes.js `onHitDamage` is unreachable: gm/60_admin_modes.js:58-63; adminSystem.ts:1273-1276.
- Hosted-NPC ChangeValues sends the player's own values, and the server ignores idx: sendInputsService.ts:194; ActionListener.cpp:1317-1333.
- The `reliable` argument of SendMessageToActorListeners is ignored: MpObjectReference.cpp:2141-2147.
- Unused FormView stubs: formViewFunc1/2, animationFunc1, getLeveledBase, wasHostedByOther, an always-true condition, show-clones and skipUpdates: formView.ts:167-168,216-233,242,986-1003,1114; animation.ts:255-258; worldView.ts:116-137.
- `version.ts` verifyVersion is never called, and blockedAnimationsService iterates an always-empty list: version.ts:7-22; blockedAnimationsService.ts:15-27.
- Diagnostic leftovers:
  - TimeService and WeatherService throw to get a log line: timeService.ts:117-131; weatherService.ts:139-144.
  - hitService.logNpcSpellHit: hitService.ts:81-88.
  - The clone-cast hook: remoteServer.ts:436-449.
  - The own-cast error on every cast: remoteServer.ts:1845-1851.
  - Info-level "Skipping script" logs: MpObjectReference.cpp:1916-1928.
  - Info-level logs for every skipped doc at boot: PartOne.cpp:367,383.
  - printConsole of every container diff: containersService.ts:105-108.
- An outdated comment saying server messages use a string `type`: MessageSerializerFactory.cpp:70-73.

**Duplicates**
- The MsgType enum and 35 message interfaces are kept by hand in C++ and TS: cpp/messages/MsgType.h; skymp5-client/src/messages.ts; skymp5-client/src/services/messages.
- About 20 hand-written broadcast loops follow different rules (GetActorToSendTo vs UserByActor, self included or not, deferred or direct): MpActor.cpp:245,287,632; ActionListener.cpp:445,884; AppearanceBinding.cpp:43; PapyrusObjectReference.cpp:456-893.
- NPC listeners are redirected to their host for sends through GetActorToSendTo (UpdateProperty, UpdateHoster, server-set equipment, server-made animation). A player hosting k NPCs gets each of those k+1 times. Client relays through SendToNeighbours are not affected: MpObjectReference.cpp:2142-2148; MpActor.cpp:247,289,544-567; EquipmentBinding.cpp:40.
- `isDead` is sent in both the main props and the props of CreateActor; `baseRecordType` is cached in one place and looked up from the ESPM per UpdateProperty in another: CreateActorMessage.h:121-122; MpObjectReference.cpp:53-78.
- The same appearance string is parsed 3 times per actor CreateActor and twice per `mp.getActorName`: PartOne.cpp:311,860; MpActor.cpp:449,1202-1214.
- ScampServer::SetHoster re-implements the OnHostAttempt host switch: ScampServer.cpp:1084-1134; ActionListener.cpp:1259-1286.
- The "hosted by me" check is written three times: formView.ts:436-444,533-540; worldViewMisc.ts:53-58.
- mp hook chaining is hand-rolled about 10 times instead of using chainMpHook, and hostingSystem's chain forwards only 4 args: actorUtil.ts:210-224; hostingSystem.ts:124,133.
- The player's worldOrCell is read 2+N times per frame: worldView.ts:71-85; playerCharacterDataHolder.ts:12; formView.ts:98.
- CloneSpellGuard.enforce runs twice per frame: cloneSpellGuardService.ts:17; sendInputsService.ts:192.
- Spell slots, IsCasting variables and the crosshair ref are each polled twice per frame: sendInputsService.ts:54-78; magicSyncService.ts:85-87,235-255,366-390.
- Full inventory reads run on three independent timers: remoteServer.ts:330-353; craftedExtrasService.ts:157-162; characterProgressService.ts:305-311.
- The blocked power ids exist both in the client and in server-settings `blockedSpells`: magicSyncService.ts:18-28; ActionListener.cpp:1823.
- The DurableCopy adapter is written twice: combatReadoutSystem.ts:22-57; durabilityNative.ts:72-128.
- The unarmed id 0x1f4 is defined three times: ActionListener.cpp:1400-1403; TES5DamageFormula.cpp:20; Durability.cpp:18.
- Magic constants are redefined per client service: npcHitSpellBlockService.ts:11-27; cloneSpellGuardService.ts:153-160; magicSyncService.ts:392-393.
- Admin smite and healhit are applied twice: bleedoutSystem.ts:147-156; gm/60_admin_modes.js:58-66.
- pvp.log kill lines and death alerts are written twice: bleedoutSystem.ts:350-369; gm/55_death.js:3-15.
- A carried item is hidden twice (`ff_carried` plus `itemGrabbed`); an FF pickup sends isHarvested just before DestroyActor: placedItemSystem.ts:166-172; MpObjectReference.cpp:1514-1530.
- SetLastAnimation requests a full save even though `lastAnimation` is never persisted: MpObjectReference.cpp:1088-1093; MpChangeForms.cpp:83-86.
- 8 server helpers each scan every user slot instead of sharing `onlinePlayers`: adminSystem.ts:305; afkSystem.ts:150; factionSystem.ts:1107; goldWatchSystem.ts:138; housingSystem.ts:1527; placedItemSystem.ts:212; timeSystem.ts:70; writingSystem.ts:569.

**Overlaps**
- Health travels three ways (`movement.healthPercentage`, ChangeValues, host copy), and so does death (`movement.isDead`, DeathStateContainer, `isDead` prop): movementGet.ts:54-57,111; MpActor.cpp:880-931,1320-1352.
- Appearance changes travel two ways (client UpdateAppearance relay, server `mp.set appearance` on deferred channel 2): ActionListener.cpp:581-602; AppearanceBinding.cpp:20-47.
- Two hosting mechanisms run side by side: client first-come claims with the 2 s rule, and the 1.5 s server audit: formView.ts:462-474; ActionListener.cpp:1236-1287; hostingSystem.ts:197-243.
- Three mechanisms compensate for local damage: cloneSpellGuardService, npcHitSpellBlockService, and server TrackNpcHitPoison with `npcHitPoisonBlocked`: ActionListener.cpp:2643-2807.
- "In combat" state is tracked in 6 places: HitRules, Durability, survival, needs, hosting, companion.
- Block stamina calls getCombatStats on every blocked hit to read a weight the formula already computed: needsSystem.ts:443-485.
- Login runs three subscription passes (releaseSeat, setEnabled(true), setUserActor): spawn.ts:329-334,604-610; PartOne.cpp:206-222.
- Papyrus MoveTo and ScampServer::Place each run a subscription pass at the wrong position first: PapyrusObjectReference.cpp:731-738; ScampServer.cpp:1647-1666.
- TS JSON registries duplicate changeForm data (housing, gathering, zone-spawns, bodies, companions, pets): housingSystem.ts:1475-1480; gatheringSystem.ts:719-727.
- Several systems run their own periodic whole-doc saves (needs, torch, survival, mastery) beside the native save path: needsSystem.ts:812-818,1040-1045; masterySystem.ts:613-627.
- placedItemSystem opens its own MongoClient to full-scan for forms that are already in memory: placedItemSystem.ts:241-262,313-335.
- The backend has a second persistence implementation with different semantics: skymp5-backend/sources/db.js:8-103.
- dealWithRef unlocks every plugin ref while RefDecorService re-locks claimed doors: objectReferenceEx.ts:41-45; refDecorService.ts:132-142.
- Torches are handled twice: the `fTorchEvaluationTimer` fix plus the 2 s keepTorch: npcTorchCheckService.ts:6-22; formView.ts:769-809.
- There are two ways to hide a plugin ref (`mp.set isDisabled` and Papyrus Disable), with different reach: MpObjectReference.cpp:518-544; gatheringSystem.ts:694-704.
- `loadDoorQuery` round-trips to the server for static plugin data: activationService.ts:227-250; doorTeleportSystem.ts:121-126.
- Voice range is decided on the client from the world model while the room is server-wide: voiceService.ts:15,416; VoiceManager.js:247,375-389.
- Chat and menus are both event-driven and polled every frame: chatService.ts:451-499; menuBlockUtil.ts:9-19.

**Overload**
- Movement is sent every 130 ms with no change check and no distance tiers; it repeats healthPercentage and sends runMode as a string: sendInputsService.ts:149-172; UpdateMovementMessage.h.
- Every relayed packet is echoed back to its sender (self-subscription): MpObjectReference.cpp:745-755; ActionListener.cpp:445-450.
- The relay inside the 3x3 block is O(N²) packets/s: ActionListener.cpp:396-453.
- Both JS edges round-trip through JSON, and custom packets and properties are JSON inside JSON: networkingService.ts:26-34,118-125; client/main.cpp:26-41.
- Custom packets are parsed three times on the server and dispatched to 32 systems; on the client they are parsed 47 times: ActionListener.cpp:463-471; index.ts:472-486; gm/00_core.js:64-75; customPacketUtil.ts:17-24.
- About 30 `setTimeout(1)` loops busy-poll on the game thread: ts/index.ts:428-444.
- Every tick observes a prom-client Histogram and Summary and takes 3 save-storage locks, even when idle: ts/index.ts:414-423; AsyncSaveStorage.h:118-131,172-215.
- The RakNet drain has no per-tick budget: Networking.cpp:187-203.
- 8 helpers make one N-API `isConnected` call per user slot (maxPlayers) instead of iterating online players: adminSystem.ts:305 and the others listed under Duplicates.
- Untouched plugin refs are streamed: a median 56 per Tamriel block, 569 in a city, up to 1,056 in an interior: PartOne.cpp:831-956; WorldState.cpp:406-424.
- Every LIGH is loaded and streamed, though 12,058 of 12,076 cannot be carried: libespm/src/Utils.cpp:41-48.
- learnedSpells, templateChain, base AVs and a full changeForm copy are built for every neighbour create: MpActor.cpp:445-485.
- `private.*` is copied into each create and then erased: MpObjectReference.cpp:442-448; PartOne.cpp:901-926.
- Appearance is stored as a JSON string and re-parsed on every read, including every hit, every ChangeValues and every `mp.getActorName` (once a second per player from gm `players()`): MpActor.cpp:1202-1214,1255-1262; TES5DamageFormula.cpp:141,254; AlduinakDamageFormula.cpp:215,294; CropRegeneration.cpp:13; PartOne.cpp:311.
- sendToUser serializes before it checks that the target has a user, which parked characters in listener sets hit on every broadcast near them: PartOne.cpp:740-753.
- Chunk load is O(files²), and each new ref runs its own ForceSubscriptionsUpdate: WorldState.cpp:868-880,710; CombineBrowser.cpp:121-130.
- There is no hysteresis at chunk borders: MpObjectReference.cpp:555-556.
- Chunks and forms are never unloaded: WorldState.cpp:866-884.
- Primitive polygon tests and Papyrus OnTrigger run on every movement packet: MpObjectReference.cpp:558-608.
- GetChangeForm full copies are used for single-field reads (Subscribe, per hit, per create): MpObjectReference.cpp:1022-1023,1202-1214; ActionListener.cpp:2072,2299.
- The boot loads the whole collection with 100 skip/limit threads. Each thread holds its slice as a JSON string and a simdjson DOM at once, every doc gets a chained Sha256, and a log line is written every 25 forms and for every skipped doc: MongoDatabase.cpp:154-289; PartOne.cpp:367,383,397-399.
- RequestSave copies the whole struct on every edit; the flush walks the dense `changesByIdx` vector: WorldState.cpp:305-323,785-804.
- Every save is a whole-document `$set` with four format conversions: MongoDatabase.cpp:93-116; MpChangeForms.cpp:23-115.
- ChangeValues saves at once, up to every 2 s, while position is throttled to 30 s: MpActor.cpp:853-875.
- Timed whole-doc saves per online player: needs and torch every 60 s, survival and mastery every 5 min: needsSystem.ts:812-818,1040-1045; masterySystem.ts:613-627.
- `mp.set` has no unchanged-value check, and transient props are persisted (`ff_chatMsg` is stored on 160 docs): CustomPropertyBinding.cpp:55-77.
- Each makeProperty call rebuilds and re-signs the whole UpdateGamemodeData: 18 rebuilds per gamemode load: PartOne.cpp:529-588; ScampServer.cpp:1526.
- 3,717 soft-deleted docs are fetched at every boot: MpObjectReference.cpp:815-827.
- Gathering vein state is stored as about 1 KB full changeForms (11,140 docs): gatheringSystem.ts:740-767.
- DynamicFields keeps each value twice after a load: DynamicFields.cpp:44-54.
- UpdateEquipment carries the whole inventory to every neighbour, persists it and resends it in CreateActor: equipment.ts:182-193; ActionListener.cpp:884-890.
- UpdateAnimVariables streams 2 msgs/s whenever magic is equipped, even sheathed: magicSyncService.ts:81-113.
- A fire-and-forget cast sends 4 reliable SpellCast packets, and each keepAlive re-runs the full cast path including Papyrus OnSpellCast: magicSyncService.ts:182-226; ActionListener.cpp:1787-1866.
- A weapon hit crosses native to JS about 5 times, and `onHitAttempt` runs before the cheap checks: ActionListener.cpp:1633-1677.
- Info logs run on every hit and cast: AlduinakDamageFormula.cpp:377-398; ActionListener.cpp:1425-1429,1781,1850.
- FindHitPoison and IsSpellInTemplateTree are uncached: ActionListener.cpp:277-320,378-393.
- SetInventory serializes the whole inventory on every change, durability and poison flushes included; overwrite mode then discards all but the last one per tick: MpObjectReference.cpp:1963-1972; MpActor.cpp:326-334; PartOne.cpp:792-797.
- Chat sends an UpdateProperty plus a 12 KB doc write per recipient per line, with an O(N) recipient scan: gm/25_chat_core.js:25-27,72-88.
- `itemGrabbed` and `itemMoved` go to the whole worldspace: placedItemSystem.ts:209-218.
- `refDecor` sends the world-wide list: housingSystem.ts:1248-1301.
- Voice puts every player in one auto-subscribed LiveKit room, so participant events are O(N) per client: VoiceManager.js:247.
- Every client boot and reconnect re-reads each non-vanilla plugin in full for a CRC32, synchronously on the game thread, with no cache: loadOrderVerificationService.ts:24-30; FileInfo.cpp:10-36.
- The client has no dirty tracking; every form runs FormView every frame: worldView.ts:52-138.
- Id lookups are O(n²) per frame (linear localIdToRemoteId and remoteIdToLocalId): formView.ts:439,536; formViewArray.ts:89-105.
- Plugin doors are full per-frame FormViews: remoteServer.ts:1816-1821.
- Idle remote actors trigger applyMovement 7.5 times a second; applyMovement repeats one-time setup on every packet: movementApply.ts:25-92.
- The client re-applies its inventory every 5 s, snapshots it on every activate, and makes several reads per container move: remoteServer.ts:308-355; activationService.ts:87-88; containersService.ts:99-136.
- Harvest apply calls findRandomActor up to 20 times; a drop calls findRandomReferenceOfType up to 200 times: modelApplyUtils.ts:50-83; dropItemService.ts:78-113.
- AuthService sends about 60 CEF evals a second while connecting: authService.ts:720-733.
- Ping metrics loop over empty slots, a new simdjson parser is made per message, and an ESPM lookup runs per property send: Networking.cpp:212-237; ActionListener.cpp:466; MpObjectReference.cpp:53-78.
- The server always relays UpdateAnimation RELIABLE_ORDERED: ActionListener.cpp:565-566.

**Risks**
- Movement is relayed before it is validated: ActionListener.cpp:490 vs 507-515.
- Movement validation rejects only a cell change or a jump of 4096 units or more (about 31,500 units/s passes), and the client flags are trusted: MovementValidation.cpp:17-34.
- UpdateAnimVariables `actorRemoteId` is unchecked, so one client can drive any actor's graph on every screen: ActionListener.cpp:1721-1730; remoteServer.ts:2011-2031.
- Reliability is mismatched: client RELIABLE is unordered, movement is not sequenced and has no client sequence check: Networking.cpp:89-93,174-185; remoteServer.ts:1288-1292.
- Every server-reliable message shares channel 0, so one lost packet head-of-line blocks the rest: Networking.cpp:183-184.
- Callers of SendMessageToActorListeners cannot send unreliable; their `reliable` argument is ignored: MpObjectReference.cpp:2141-2147.
- There is no fixed tick rate, and the tick histogram measures the wait too: ts/index.ts:412-426.
- ScampServer::Tick re-enters the drain after any handler throws, so a throwing handler repeats inside one tick: ScampServer.cpp:836-847.
- The client idManager is never reset on reconnect, so ids leak: remoteServer.ts:1503-1511; idManager.ts:2-21.
- Disable() never calls UnsubscribeFromAll, so a parked character stays in the listener sets of the static refs around its logout spot until restart. Broadcasts there serialize messages for it, `actorNeighbors` returns it, and a later Enable re-sends CreateActor because Subscribe fires the callback even when nothing new was inserted: MpObjectReference.cpp:518-530,1033-1044,1799-1820; ActorNeighborsBinding.cpp:12-19.
- An overridden plugin ref can be loaded twice, leaking an idx and leaving a dangling pointer that a client can reach by idx: WorldState.cpp:119-164,868-880.
- The int16 chunk truncation makes chunk 0 8192 units wide, can overflow, and the `SetPos(-1e9)` in BeforeDestroy lands on a bogus cell: MpObjectReference.cpp:161-164,2150-2162.
- The N-API `getNeighborsByPosition` returns length 2n with n leading holes: ScampServer.cpp:1752-1755.
- Reuse of a dirty-buffer idx could overwrite a pending isDeleted save (plausible, not observed): WorldState.cpp:305-323.
- Boot paging uses skip/limit with no sort, and the final check compares counts only, so a doc read twice and another missed would pass (plausible, not observed): MongoDatabase.cpp:211-221.
- The game server creates no indexes. The manager ensures `formDesc_1`, `worldOrCellDesc_1` and `profileId_1` on each start it makes, but starts that bypass it (the nssm 01:00 restart) never do. On 2026-10-04 live held only a non-unique `formDesc_1`: formDescIndex.js:6,25-36; services.js:86-88.
- GenerateFormId reuses FF ids every boot: WorldState.cpp:1094-1100.
- Failed Iterate threads retry with no backoff: MongoDatabase.cpp:173-254.
- Gamemode hot reload is armed on live: any write to a running server's gamemode file reloads it and stacks another handler generation, so each event then runs every generation's handlers: ts/index.ts:169-174,196-224.
- The scale cap is 1300 players per process (UserId is an unsigned short): CMakeLists.txt:47; NetworkingInterface.h:10-12.
- Login has no per-connection guard, and the client's 15 s timeout erases the stored auth: login.ts:41-52,117-286; authService.ts:694-718.
- Unauthenticated packets reach every system, and handlers that throw can be used to spam the log: index.ts:472-486; ActionListener.cpp:1724-1727,1241-1246.
- `storage.hosted` goes stale when the host leaves the grid, leaving a frozen NPC; `lastTryHost` is never pruned: remoteServer.ts:496-521; hostAttempts.ts:17.
- A stalled player copy sends refused Host messages and prints a console line every second: formView.ts:462-474.
- UpdateHoster computes `isHostedByOther` against the NPC id: MpObjectReference.cpp:767-778.
- Plugin-ref state is lost if the ref loads after 120 frames: remoteServer.ts:1796-1813.
- DestroyActor for a plugin ref writes `forms[-1]`; the pluginRefProps and pluginRefPose caches are never pruned: remoteServer.ts:1239-1274; worldViewMisc.ts:116-119.
- TESNPC bases from `createNpc` are never freed: appearance.ts:153-160; PapyrusTESModPlatform.cpp:361-367.
- AnimationSource hooks are never removed: animation.ts:393-412.
- Only the last animation event per frame is sent: animation.ts:434-475.
- Server-made appearance has no validation (a TODO in the binding): AppearanceBinding.cpp:21.
- Activation has no distance check: MpObjectReference.cpp:2117-2140.
- Melee reach is unchecked, and bows have no distance limit: ActionListener.cpp:1665-1677.
- Spell hits have no rate limit and no link to a cast: ActionListener.cpp:2062-2114.
- DOT damage arrives only through the victim's unreliable health reports: ActionListener.cpp:1356-1383.
- PlayerBowShot is unreliable yet drives ammo removal, and the client blocks SetInventory for 5 s after a crossbow shot: playerBowShotService.ts:42-101.
- Corpse hits are fully priced: ActionListener.cpp:2196-2557.
- A hit or cast from a dead actor triggers a respawn that can cut across bleedout: ActionListener.cpp:1679-1685,1794-1800.
- needs charges cast fatigue before the native validation: needsSystem.ts:521-546.
- ActiveMagicEffectsMap keeps one effect per AV: ActiveMagicEffectsMap.cpp:8-21.
- `refusedHealthIncreases` grows without bound: ActionListener.cpp:2751-2770.
- Racial magic resistance can be counted twice: ScampServer.cpp:625-667.
- The live backend relay listens on all interfaces on 7778: wsRelay.js:213.

**Stage 2 candidates**
1. Movement: send on change, skip the sender, validate before relaying, use a sequenced channel, add distance tiers.
2. Streaming: stream only plugin refs that have a server delta, load only carriable LIGH, run one subscription pass at login, add chunk hysteresis, unload idle chunks, fix the duplicate LoadForm, and make Disable call UnsubscribeFromAll so parked characters leave listener sets.
3. Persistence: dirty flags and field-level writes, per-player and per-zone loading with indexes the game server creates (profileId, chunk key, unique formDesc), sorted paging at boot, purge dead docs, fold the timed system saves into the native path, move the JSON registries into Mongo.
4. Message pipeline: a single parse and a type router for custom packets on both sides, less JSON at the JS edges, separate ordering channels, and a `reliable` flag that is honoured.
5. One broadcast helper for listeners: no host duplicates, serialize once, skip users that are not connected before serializing.
6. Equipment: send worn items only. Magic: send anim vars only while casting, and send stops only for channels. Appearance: parse once and cache the race id.
7. One server-driven hosting model.
8. Client view: dirty-driven FormViews, id maps instead of linear scans, native name tags, event-driven replacements for the polls in section 4, and a cached load order check.
9. One scheduler for the TS systems instead of about 30 `setTimeout(1)` loops, iterating `onlinePlayers` instead of user slots, with hot reload off on live.
10. Voice: per-zone rooms or server-chosen subscriptions instead of one server-wide auto-subscribed room.
11. Server authority gaps: activation and melee reach, the anim-var target, spell-hit rate and cast link, DOT handling, appearance validation.
12. Remove the dead code in section 6.