# Test Server

The second game server on the same box, for Admins and Developers only, and the place
where everything is edited and built. It has its own server folder, client files, Data
folder, world database, LiveKit, console relay, logs and versions, and appears in the
launcher's server list as **Test Server**. The live server (**Main Server** in the
manager) only receives files through the manager's **Migrate** box.

## 1. How it fits together

| | Main Server (live) | Test Server |
|---|---|---|
| game server folder | `build\dist\server` | `build\dist\testserver` |
| client files | `build\dist\client` | `build\dist\testclient` |
| Skyrim Data folder (`dataDir`, `loadOrder`, `archives`) | `C:\GOG Games\Skyrim Anniversary Edition\Data` | `C:\GOG Games\Skyrim Anniversary Edition - Test\Data` |
| game service | `AlduinakGameServer`, UDP 7777, UI 3000 | `AlduinakTestServer`, UDP 7787, UI 7788 (loopback) |
| MongoDB | `AlduinakMongo`, 127.0.0.1:27017, `deploy\mongodb\mongod.cfg`, database `skymp` | the same instance, database `skymp_test` (`skympuser` with `readWrite` and `dbAdmin` on it) |
| LiveKit | `AlduinakLiveKit`, `C:\Alduinak\livekit`, 7880/7881, UDP 50000-50200 | `AlduinakLiveKitTest`, `C:\Alduinak\livekit-test`, 7890/7891, UDP 50300-50500, room `alduinak-test` |
| logs | `C:\logs` | `C:\logs\test` |
| console relay | backend `WS_PORT` (7778) | backend `WS_PORT_TEST` (7779, loopback); the service runs with `WS_PORT=7779` |
| backend server id | `alduinak` | `test` (`?server=test` on the version, manifest, modlist and launch-check routes) |
| backend files in `skymp5-backend\data` | `manifest.json`, `modlist.json`, `manifest-diff.json`, `data-sync.json` | `manifest-test.json`, `modlist-test.json`, `manifest-diff-test.json`, `data-sync-test.json` |
| extras archives under `CLIENT_FILES_DIR` | `extras`, served at `/files/extras` | `extras-test`, served at `/files/extras-test` |
| `versions.json` | root `client` and `server` | `test: { client, server }` |

- **A server is a folder.** The game server keeps every state file (`housing.json`,
  `pets.json`, `companions.json`, `zone-spawns.json`, `starter-grants.json`,
  `gathering-picks.json`, `weather-state.json`, `bodies.json`, `writings\`) in its
  working directory and its world in its own database, `skymp_test`, on the one MongoDB
  instance the box runs. `build\dist\testserver` is a separate server.
- **Its own master key.** The SkyMP client does not use the port the launcher writes.
  It asks `GET /api/servers/<master key>/serverinfo` for the host and port, so the test
  server has its own `masterKey`. The backend lists it in `/api/servers` and answers
  its serverinfo, manifest and heartbeat separately (`config.servers` in
  `skymp5-backend/config.js`; it reads `build\dist\testserver\server-settings.json`,
  or `TEST_SERVER_SETTINGS_PATH` from `.env`).
- **Read-only against live data.** The test key may read live backend state
  (sessions, faction definitions, rosters, ranks) but every write is refused with
  `403 This server has read-only access.` (`checkKey` in `routes/master-api.js`). Test
  play can never change the live characters, faction ranks, bans or balances. Its
  heartbeat is the one write it may make.
- **Staff only.** The backend admits a session on the test key only when the player
  holds a role in `access.staffOnlyRoleIds` of its settings (Admins
  `1521259484859863190`, Developers `1521259396481421475`). Anyone else gets
  `staffOnly`; the game server kicks them with *This server is for staff only.* and
  the launcher greys out PLAY for them. Its own `access` lock applies on top.
- **Its own console.** The backend runs a second relay on `WS_PORT_TEST`, bound to
  loopback; the gamemode part `80_relay.js` connects to the port in `WS_PORT`, which the
  service sets. The manager's **Test Server** container talks to that relay. The
  dashboard's web console and the daily restart stay live-only.
- **Managed from the manager.** Console tab, four containers: **Backend**, **MongoDB**
  (the shared `AlduinakMongo`, its log, START/STOP/RESTART; it refuses to stop while the
  backend or either game runs), **Main Server** and **Test Server** (Game and LiveKit
  each, Start all / Stop all, the Game log, a command input). Every build in the Build
  tab and every web Build job targets the test profile (`buildProfile` in
  `server-manager/src/config.js`).

What it cannot test: faction writes (recruit, promote, regency), in-game bans, store
purchases and character roster updates fail with 403 by design, and the ban check at
connection is skipped. Nginx, the backend, the dashboard, the Players, Security and
Factions tabs and playtime are shared with live: there is one backend.

## 2. One-time setup (owner, on the box)

Copy the live Data folder first (52 GB), then run the setup script in an elevated
PowerShell:

```
robocopy "C:\GOG Games\Skyrim Anniversary Edition\Data" "C:\GOG Games\Skyrim Anniversary Edition - Test\Data" /E /MT:16
powershell -ExecutionPolicy Bypass -File deploy\testserver\setup-testserver.ps1 -MongoPassword "<skympuser password>" -AdminPassword "<alduinakAdmin password>"
```

The script is idempotent and never stops, edits or restarts a live service or file.
`deploy/testserver/README.md` lists its parameters (`-MongoPassword`, `-AdminPassword`,
`-Port 7787`, `-MaxPlayers 20`, `-MasterKey`, `-DataDir`, `-LogDir`) and how to remove
everything. What it creates:

### 2.1 The folders

`build\dist\testserver` is a copy of `build\dist\server` without `world`, `writings`,
the settings files, `purged-changeforms-*.json`, `install-services.bat` (it stops and
re-registers the live services) and the state registries, which it creates with the
values the wipe tool resets them to:

| File | Empty value |
|---|---|
| `housing.json` | `[]` |
| `zone-spawns.json` | `[]` |
| `companions.json` | `{"active":[],"corpses":[],"stored":[]}` |
| `pets.json` | `{"active":[],"released":[]}` |
| `starter-grants.json` | `{}` |
| `gathering-picks.json` | `{}` |
| `weather-state.json` | `{}` |

`bodies.json` is written by the server at its first body. `build\dist\testclient` is a
copy of `build\dist\client`. `C:\logs\test` and `C:\Alduinak\livekit-test` are created.

### 2.2 The settings

`build\dist\testserver\server-settings.json` is derived from the live file with node
(UTF-8 without a BOM), only when it is missing:

| Key | Value |
|---|---|
| `name` | `"Test Server"` (the name the launcher lists) |
| `port` | `7787` (the UI port is the port + 1, loopback only) |
| `maxPlayers`, `playerSlots` | `20` |
| `logDir` | `"C:/logs/test"` |
| `masterKey` | 32 random hex characters, printed at the end (never the live key) |
| `databaseDriver`, `databaseName`, `databaseUri` | `"mongodb"`, `"skymp_test"`, `mongodb://skympuser:<url-encoded password>@127.0.0.1:27017/skymp_test?authSource=admin` |
| `dataDir`, `loadOrder`, `archives` | the test Data folder; the live lists with the folder prefix swapped |
| `voiceChat` | `ws://<SERVER_ADDRESS from .env>:7890`, the generated test keys, room `alduinak-test` |
| `discordAuth.guilds[*].eventLogChannelId`, `securityAlertChannelId` | `""` (no login lines or alerts from the test server) |
| `dailyRestartAt` | `"off"` |
| `access` | unlocked, no whitelist or banned role, `staffOnlyRoleIds` Admins and Developers |

Everything else (`master`, `masterApiAuthToken`, `adminRoles`, ...) stays as live. The
test server needs the live `masterApiAuthToken` for its heartbeat; the backend refuses
its writes by key. Edit the file later from the manager's Settings tab, subtab
**server-settings.json (test)**.

### 2.3 The database

There is no second mongod. The test world is the `skymp_test` database on the live
`AlduinakMongo` instance (loopback, 27017), and the game server's `skympuser` account
needs `readWrite` and `dbAdmin` on it. `setup-mongodb.ps1` created `skympuser` with
those roles on `skymp` only and no right to grant roles, so the setup grants them as the
root user `alduinakAdmin` when it gets `-AdminPassword`. Without it the script tries the
grant as `skympuser` and, when MongoDB answers *not authorized*, stops before registering
any service and tells you to create the admin once:

```
powershell -ExecutionPolicy Bypass -File deploy\mongodb\rotate-password.ps1 -NewPassword '<the current skympuser password>' -CreateAdmin '<new admin password>'
```

That restarts `AlduinakMongo` twice for a few seconds (the live game and backend
reconnect), so do it in a quiet moment, then re-run the setup with `-AdminPassword`.
With the current password the rotation itself changes nothing: the live `databaseUri`
stays as it is, the game server needs no restart and the `ADMIN_CREATED` line confirms
the new user (`ADMIN_SKIPPED` means it already existed).
Granting again on a re-run is a no-op; the setup ends the step by reading `skymp_test`
as `skympuser` with `-MongoPassword`, the password the test `databaseUri` carries. The
database itself appears at the test server's first write.

The live and test worlds share one process, so the MongoDB container in the manager's
Console tab refuses to stop while the backend or either game runs. `skympuser` holds the
same roles on both databases: every by-hand mongosh command names its database with
`getSiblingDB('skymp_test')`.

### 2.4 The backend

The backend reads the test server from `build\dist\testserver\server-settings.json`
(`TEST_SERVER_SETTINGS_PATH` in `skymp5-backend\.env` overrides) and opens the test
console relay on `WS_PORT_TEST` (default 7779). Restart **AlduinakBackend** after the
setup. It refuses to list the test server (with a warning in `C:\logs\backend.log`)
when its `masterKey` equals the live one or its ports hit the live 7777 or 3000. With
`access.staffOnlyRoleIds` empty nobody can join it.

The setup seeds `manifest-test.json` (from `manifest.json`, archive URLs rewritten to
`/files/extras-test/`), `modlist-test.json`, the `extras-test` folder and the `test`
block of `versions.json` from the live values, so the launcher lists the test server
with the live files until the first **Update modlist** on the test profile.

### 2.5 The services

| Service | Runs | Start |
|---|---|---|
| `AlduinakLiveKitTest` | nssm, `C:\Alduinak\livekit-test\livekit-server.exe --config livekit.yaml` | automatic |
| `AlduinakTestServer` | nssm, `node dist_back\skymp5-server.js` in `build\dist\testserver`, `AppEnvironmentExtra WS_PORT=7779 ALDUINAK_LOG_DIR=C:\logs\test`, stdout and stderr in `C:\logs\test`, 10 MB nssm rotation | manual (the manager's Console tab) |

MongoDB is the live `AlduinakMongo` service (2.3); the setup registers no database
service.

### 2.6 The firewall

The script adds "Alduinak Test Game UDP 7787", "Alduinak LiveKit Test TCP" (7890, 7891)
and "Alduinak LiveKit Test UDP" (50300-50500). Open UDP 7787 and the LiveKit ports in
the Iceline panel too if the host filters traffic upstream. Do not open 7788; the UI
port is only read by the backend on the box.

### 2.7 First start

1. Restart **AlduinakBackend** and the Server Manager.
2. Console tab, **Test Server** container, **Start all** (LiveKit, Game). The
   **MongoDB** container is the shared instance and is already running.
3. Delete the stale `<repo>\testserver` folder if it still exists; the backend reads
   `build\dist\testserver` now.
4. Bump the launcher version in the Build tab's Launcher box and **Build launcher**, so
   players get per-server manifests.

## 3. Checks

- `C:\logs\test\gameserver.log` shows the relay connecting on port 7779 and the mongodb
  driver on 27017 with database `skymp_test`. The Test Server container's `status`
  answers from it, the Main Server container's from live.
- `mongosh "mongodb://127.0.0.1:27017/admin" -u skympuser -p --eval "db.getSiblingDB('skymp_test').getCollectionNames()"`
  lists `changeForms` after the first login; `skymp` keeps its live counts.
- `https://api.alduinak.com/api/servers` lists two servers; the test entry has port
  7787 and its own master key. The live entry's name and player count do not change
  when the test server heartbeats.
- `GET /api/servers/<test key>/serverinfo` returns port 7787. A PUT to
  `/api/servers/<test key>/profiles/1/characters` returns 403.
- `GET /api/manifest?server=test` and `/api/version?server=test` answer from the test
  files.
- A Developer picks **Test Server** in the launcher; the Modlist panel shows the test
  list, the client log shows `Connecting to <ip>:7787` and they make a new character.
- A Jarl or member without Admin or Developer sees PLAY greyed out, and if they force
  a connection they are kicked with *This server is for staff only.*
- After playing on test, the staff member's live characters and faction rosters are
  unchanged.
- Voice works between two test players and cannot be heard on live. `chat.log` appears
  under `C:\logs\test`.

## 4. Working on the test server

Everything below is the manager's Build tab unless noted; the live folders are never
written.

- **Server code** (`skymp5-server/ts`): **Build server** bundles into
  `build\dist\testserver\dist_back` and rebuilds the gamemode. Restart the Test Server
  from the Console tab. `scam_native.node` comes from a CI flatrim build applied into
  the test folder, or from the CMake checkbox (Test Server stopped).
- **Gamemode**: edit `build\dist\testserver\gamemode_extensions`, then **Build gamemode
  only** (or console `build gamemode`). The test server hot-reloads `gamemode.js`.
- **Client** (`skymp5-client`, `skymp5-front`): Client box, set the Test version, **Build
  client** into `build\dist\testclient`. Package `testclient\Data` as the Alduinak
  Client Files mod, upload it to Nexus, install it into MO2, then the same button
  continues as **Update Modlist** and **Update Version** (publishes `test.client`).
  Testers re-download through the launcher.
- **Modlist**: **Update modlist** (Test Server stopped) compiles `manifest-test.json`
  from MO2, syncs the test `server-settings.json` and the test Data folder and purges
  the test database (`skymp_test`; the backup lands in `build\dist\testserver`). A
  modlist that matches the test manifest, versions included, changes nothing.
- **Native**: the CMake checkbox configures `build\` with `SKYMP_DIST_SERVER_DIR` and
  `SKYMP_DIST_CLIENT_DIR` at the test folders and restores the test
  `server-settings.json`, `launch_server.bat` and `gamemode.js` the build rewrites
  (`CLAUDE.md`, Build). The skyrim-platform pack step (`skyrim-platform\tools\dev_service`)
  honours `SKYMP_DIST_CLIENT_DIR` too, so the Client box's **Run CMake first** writes the
  new dlls into `build\dist\testclient`. Never run `cmake --build` or `ctest` by hand
  against a folder a game service uses.
- **Versions**: the Server and Client boxes save the test versions; the live ones are
  only written from the Migrate box. Client and server versions are independent
  everywhere (`versions.json` keeps `client`, `server`, `test.client` and `test.server`
  as four values) and may carry a prerelease or build tag: `1.2.3`, `1.2.3-b4` or
  `1.2.3+4`. The launcher compares the client version by string equality, so a build
  tag is a new version for the players. Only the launcher's own version stays a plain
  `1.2.3` (its updater parses the three numbers).
- **Console**: the Test Server container's command input reaches the test relay
  (`say`, `kick`, `status`, `build gamemode`, `start|stop|restart test`; the shared
  MongoDB is `start|stop|restart mongo`, refused while anything uses it).

## 5. Moving to live (Migrate box)

Stop the Main Server first; every Migrate button is disabled while it runs and asks
for a second click.

1. **Migrate server** copies `dist_back`, `scam_native.node`, `gamemode.js`,
   `gamemode_extensions`, `plugins`, `data\scripts` and the definition files
   (`NPC-Spawns.json`, `weather-regions.json`, `Jobs.json`, `faction-access.json`,
   `alert-keywords.json`) from test to live, after backing up the live copies into
   `build\dist\backup\<timestamp>\server`. World, registries and settings are never
   copied.
2. The button then reads **Migrate settings**: every top-level key of the test settings
   is written into the live file except the live identity and capacity keys (`name`,
   `port`, `maxPlayers`, `playerSlots`, `masterKey`, database, `dataDir`, `loadOrder`,
   `archives`, `logDir`, `voiceChat`, `access`, admin lists, Discord channels,
   `dailyRestartAt`, ...). `loadOrder` and `archives` are left alone: **Migrate client**
   syncs them from the manifest, whose diff records the plugin shifts the MongoDB purge needs.
   The old file is backed up as `build\dist\backup\server-settings-<timestamp>.json`.
3. **Migrate client** publishes the test manifest and modlist as the live ones
   (archive URLs back under `/files/extras`), syncs the live settings and Data folder,
   purges the live MongoDB and mirrors `build\dist\testclient` onto `build\dist\client`
   (the live key files are backed up first).
4. Publish the live versions: the Migrate box's **Live** row has a server field and a
   client field; **Copy test build** fills them from `skymp5-server/package.json` and
   `skymp5-client/package.json`, **Save** writes `server` and `client` in
   `versions.json` (only the filled fields). The **Test** row does the same for
   `test.server` and `test.client`. Then start the Main Server.

## 6. Wiping the test world

Stop the Test Server, then drop `skymp_test` as `skympuser` (its `dbAdmin` role on that
database allows it):

```
mongosh "mongodb://127.0.0.1:27017/admin" -u skympuser -p --eval "db.getSiblingDB('skymp_test').dropDatabase()"
```

Name the database with `getSiblingDB('skymp_test')` every time: the same account may
drop the live `skymp`. Then delete `build\dist\testserver\writings\*` and reset the
registries as in 2.1. The live wipe tool never touches this folder or database; the test
server recreates `skymp_test` at its next write.

Logs are not archived on restart (nssm size rotation only).

## 7. Removing it

`deploy/testserver/README.md`, "Removing everything".
