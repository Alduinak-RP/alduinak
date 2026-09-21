# Test Server

A second game server on the same box, for Admins and Developers only. It runs the
live server's build from its own folder, with its own world, port, logs and voice
room, and appears in the launcher's server list as **Test Server**.

## 1. How it fits together

- **A server is a folder.** The game server keeps every state file (`housing.json`,
  `pets.json`, `companions.json`, `zone-spawns.json`, `starter-grants.json`,
  `writings\` and the file database `world\`) in its working directory. A copy of
  `build\dist\server` in `C:\Alduinak\testserver` is a separate server.
- **Its own master key.** The SkyMP client does not use the port the launcher writes.
  It asks `GET /api/servers/<master key>/serverinfo` for the host and port. The test
  server therefore has its own public key (`TEST_SERVER_MASTER_KEY`, for example
  `alduinak-test`). The backend lists it in `/api/servers` and answers its serverinfo,
  `manifest.json` and heartbeat separately. See `skymp5-backend/config.js`
  (`config.servers`).
- **Read-only against live data.** The test key may read live backend state
  (sessions, faction definitions, rosters, ranks) but every write is refused with
  `403 This server has read-only access.` (`checkKey` in `routes/master-api.js`). Test
  play can never change the live `characters.json`, faction ranks, bans or balances.
  Its heartbeat is the one write it may make.
- **Staff only.** The backend admits a session on the test key only when the player
  holds a role in `TEST_SERVER_ROLE_IDS` (Admins `1521259484859863190`, Developers
  `1521259396481421475`). Anyone else gets `staffOnly`; the game server kicks them
  with *This server is for staff only.* and the launcher greys out PLAY for them. The
  global server lock (`SERVER_LOCKED`) applies on top.
- **No console relay.** The backend relay keeps one gamemode connection, which belongs
  to the live server (`say`, `kick` and the daily restart warnings). A folder outside
  the repo cannot find `skymp5-backend\.env`, so its relay stays off, and
  `ALDUINAK_RELAY=off` on the service makes sure of it.
- **Started by hand.** The manager, the web agent and the daily restart control only
  `AlduinakGameServer`. Start and stop the test server from `services.msc` or nssm.

What it cannot test: faction writes (recruit, promote, regency), in-game bans, store
purchases and character roster updates fail with 403 by design, and the ban check at
connection is skipped. The client files and the plugin are shared with live, so only
server-side changes can be tested.

## 2. One-time setup (owner, on the box)

Use an elevated PowerShell for every step.

### 2.1 The folder

Copy the live server without its world and state files, then create empty ones (the
values the wipe tool resets them to):

```
robocopy C:\Users\Administrator\Desktop\alduinak\build\dist\server C:\Alduinak\testserver /E /XD writings world /XF server-settings-merged.json server-settings-dump.json server-settings.json.prev purged-changeforms-*.json housing.json zone-spawns.json companions.json pets.json starter-grants.json gathering-picks.json
cd C:\Alduinak\testserver
[IO.File]::WriteAllText("$PWD\housing.json", '[]')
[IO.File]::WriteAllText("$PWD\zone-spawns.json", '[]')
[IO.File]::WriteAllText("$PWD\companions.json", '{"active":[],"corpses":[],"stored":[]}')
[IO.File]::WriteAllText("$PWD\pets.json", '{"active":[],"released":[]}')
[IO.File]::WriteAllText("$PWD\starter-grants.json", '{}')
[IO.File]::WriteAllText("$PWD\gathering-picks.json", '{}')
mkdir writings
mkdir C:\logs\test
```

Keep the folder outside the repo tree, so the relay cannot find the backend.

### 2.2 The settings

Edit `C:\Alduinak\testserver\server-settings.json` in an editor that saves UTF-8
without a BOM (VS Code or Notepad++, never PowerShell `Set-Content`):

| Key | Value |
|---|---|
| `name` | `"Test Server"` (the launcher lists the heartbeat name, so keep it equal to `TEST_SERVER_NAME`) |
| `port` | `7787` (its UI port becomes 7788, loopback only) |
| `maxPlayers` | `20` |
| `logDir` | `"C:/logs/test"` |
| `masterKey` | the `TEST_SERVER_MASTER_KEY` value, for example `"alduinak-test"` |
| `databaseDriver` | `"file"` |
| `databaseName` | `"world"` |
| `databaseUri` | delete the key |
| `voiceChat.room` | `"alduinak-test"` (LiveKit is shared, the room keeps voice apart) |
| `discordAuth.guilds[0].eventLogChannelId` | `""` (no login lines or staff alerts from the test server) |

Keep `master`, `masterApiAuthToken`, `dataDir`, `loadOrder`, `archives`,
`adminRoles` and the rest as they are live. The test server needs the live
`masterApiAuthToken` for its heartbeat; the backend refuses its writes by key.

For a MongoDB world instead of the file driver, create a separate user and database
as the Mongo admin (`db.getSiblingDB('admin').createUser({user:'skymp_test',pwd:passwordPrompt(),roles:[{role:'readWrite',db:'skymp_test'},{role:'dbAdmin',db:'skymp_test'}]})`),
then use `databaseDriver "mongodb"`, `databaseName "skymp_test"` and its own
`databaseUri`. Never point it at `skymp`.

### 2.3 The backend keys

Add to `skymp5-backend\.env`, then restart **AlduinakBackend**:

```
TEST_SERVER_NAME=Test Server
TEST_SERVER_PORT=7787
TEST_SERVER_MASTER_KEY=alduinak-test
TEST_SERVER_ROLE_IDS=1521259484859863190,1521259396481421475
```

`TEST_SERVER_UI_PORT` defaults to the port + 1 and `TEST_SERVER_ADDRESS` to
`SERVER_ADDRESS`. The backend refuses to list the test server (with a warning in
`C:\logs\backend.log`) when its key equals `SERVER_MASTER_KEY` or its ports hit the
live 7777 or 3000. With `TEST_SERVER_ROLE_IDS` empty nobody can join it.

### 2.4 The service

```
$n = 'C:\tools\nssm\nssm.exe'
& $n install AlduinakTestServer 'C:\Program Files\nodejs\node.exe' 'dist_back\skymp5-server.js'
& $n set AlduinakTestServer AppDirectory C:\Alduinak\testserver
& $n set AlduinakTestServer DisplayName "Alduinak Test Server"
& $n set AlduinakTestServer AppStdout C:\logs\test\gameserver.log
& $n set AlduinakTestServer AppStderr C:\logs\test\gameserver-err.log
& $n set AlduinakTestServer AppRotateFiles 1
& $n set AlduinakTestServer AppRotateBytes 10485760
& $n set AlduinakTestServer AppEnvironmentExtra ALDUINAK_RELAY=off ALDUINAK_LOG_DIR=C:\logs\test
& $n set AlduinakTestServer Start SERVICE_DEMAND_START
& $n set AlduinakTestServer AppThrottle 5000
```

Check the node path first with `(Get-Command node).Source`.

### 2.5 The firewall

```
netsh advfirewall firewall add rule name="Alduinak Test Game UDP 7787" dir=in action=allow protocol=UDP localport=7787
```

Open UDP 7787 in the Iceline panel too if the host filters traffic upstream. Do not
open 7788; the UI port is only read by the backend on the box.

### 2.6 First start

```
C:\tools\nssm\nssm.exe start AlduinakTestServer
```

## 3. Checks

- `C:\logs\test\gameserver.log` shows `relay client disabled (ALDUINAK_RELAY=off)`
  and `Using file with name 'world'`. The manager console `status` still answers
  from the live server.
- `https://api.alduinak.com/api/servers` lists two servers; the test entry has port
  7787 and master key `alduinak-test`. The live entry's name and player count do not
  change when the test server heartbeats.
- `GET /api/servers/alduinak-test/serverinfo` returns port 7787. A PUT to
  `/api/servers/alduinak-test/profiles/1/characters` returns 403.
- A Developer picks **Test Server** in the launcher; the client log shows
  `Connecting to <ip>:7787` and they make a new character.
- A Jarl or member without Admin or Developer sees PLAY greyed out, and if they force
  a connection they are kicked with *This server is for staff only.*
- After playing on test, the staff member's entries in `skymp5-backend\data\characters.json`
  and `faction-whitelist.json` are unchanged.
- Voice works between two test players and cannot be heard on live. `chat.log` appears
  under `C:\logs\test`.

## 4. Updating the test server

- **Server code** (`skymp5-server/ts`): after the manager's **Build server**, stop
  `AlduinakTestServer` and copy `build\dist\server\dist_back` over
  `C:\Alduinak\testserver\dist_back`. To try server code that is not live yet, bundle
  it straight into the test folder from `skymp5-server`:
  `npx esbuild ts/index.ts --loader:.node=copy --bundle --platform=node --target=node16 --keep-names --minify --sourcemap --target=es2022 --outfile=C:/Alduinak/testserver/dist_back/skymp5-server.js`.
  Copy a CI `scam_native.node` only while the test service is stopped.
- **Gamemode**: edit `C:\Alduinak\testserver\gamemode_extensions`, then regenerate its
  `gamemode.js` from the repo root (the manager's Build gamemode writes the live one):
  ```
  node -e "process.env.ALDUINAK_SERVER_DIR='C:\\Alduinak\\testserver';const {Builder}=require('./server-manager/src/build');new Builder(t=>process.stdout.write(String(t))).buildGamemode().then(r=>console.log(r.ok))"
  ```
- **Settings and data**: a new `loadOrder` or data folder must be copied by hand into
  the test `server-settings.json`; Sync server settings writes only the live file.
- **Wiping the test world**: stop the service, delete `C:\Alduinak\testserver\world`
  and reset the state files as in 2.1. The live wipe tool never touches this folder.

Logs are not archived on restart (nssm size rotation only).

## 5. Removing it

```
C:\tools\nssm\nssm.exe stop AlduinakTestServer
C:\tools\nssm\nssm.exe remove AlduinakTestServer confirm
netsh advfirewall firewall delete rule name="Alduinak Test Game UDP 7787"
```

Remove the `TEST_SERVER_*` keys from `skymp5-backend\.env` and restart the backend;
the launcher then lists only Alduinak. Delete `C:\Alduinak\testserver` when you no
longer need its world.
