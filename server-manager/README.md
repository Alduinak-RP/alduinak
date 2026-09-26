# Alduinak Server Manager

Desktop control panel for the Alduinak server. Runs on the server box. **Run it as
Administrator** - service control (nssm) needs it.

```bash
cd server-manager
setup.bat             # robust install - installs deps then launches the app
Run.bat               # everyday launch (self-elevates for service control)
npm run build:win     # packaged installer -> ../build/server-manager
```

`setup.bat` installs dependencies and then starts the manager via `Run.bat`.
After the first setup, just use `Run.bat` (it requests Administrator rights so
the Console tab can start/stop the Windows services).

If `npm start` reports *"Electron failed to install correctly"*, run `setup.bat`.
It recovers the Electron runtime even on a flaky firewall (reuse the launcher's
Electron, extract a manually-dropped zip, then retry the download). If all else
fails it prints a direct download URL - save that zip as
`server-manager\electron-v41.2.0-win32-x64.zip` and re-run `setup.bat`.

## Tabs

- **Console** - three columns: **Nginx**, **Backend** (with **MongoDB** as a
  second service) and **Game** (with **LiveKit** as a second service). Each
  service has **START/STOP**, **RESTART** and its own log view, and under the
  buttons CPU, RAM (and requests/min for Nginx), sampled every 4 s only while
  the tab is open. Each log keeps the last 100 lines on screen; the files stay
  in `C:\logs`. Columns collapse sideways (Nginx and Backend to the left, Game
  to the right) to a strip that still shows status. Only the Game column has
  the command input.
  - MongoDB (`AlduinakMongo`) starts first, stops last and refuses to stop
    while Backend or Game run.
  - The log tail asks nssm where each service writes its stdout/stderr
    (`nssm get <svc> AppStdout`) instead of guessing a fixed folder.
  - The command input first checks for **manager commands** and runs them locally:
    `help`, `status`, `start|stop|restart <mongo|nginx|backend|livekit|game|all>`, and
    `build <server|launcher|client|native|gamemode>` (build output streams into
    the console log; one build or sync at a time).
  - Anything else goes to the game server over the backend WS relay (admin
    `console` role) and the gamemode's command output streams back into the
    console. See **Wiring the console** below.
- **Players** - reads MongoDB directly (`players`, `profiles`, `bans`,
  `playtime` and `changeForms`). A list on the left, the detail on the right,
  with a resizable divider.
  - **Search** matches Discord name, Discord ID, character name and profile ID.
    **Filters** offers Online, GM, Banned, Dead, Male, Female and the ten races
    (flags must all hold, genders and races match any). **Sort** by Profile
    ID, Newest, Oldest, Richest, Poorest, Most Played or Least Played.
    **Refresh** reloads; the header shows visible/total.
  - The pinned **General Stats** entry has a **Generate** button: race, gender
    and profession counts, hours brackets, total and average gold, gold
    brackets.
  - The account detail shows the account, Discord ID, roles (GM is role
    `1521259484859863190`, plus Developer and Whitelist, from the roles saved
    on characters at login), profile ID, created, last seen, hours played, the
    IP address and HWID history lists, factions and the characters (each with
    **Delete**). **Banned** checkbox, **Kick** (through the game console, the
    player must be online) and **Delete account** (optionally with its
    characters). Ban, kick and delete go through the backend API, so the
    backend must run.
  - The character popup edits name, max health/stamina/magicka change
    (`private.attrBonus`), profession and hours, coordinates and cell
    (**Save**), faction ranks for that character, and has the appearance and
    inventory editors. **Send to Sovngarde** and **Send to Soul Cairn** need
    the game server stopped; **Revive** shows only on a fallen character.
    Make edits with the game server stopped.
  - **Hours played** are counted from the game log when the manager or its
    agent archives `gameserver.log` at a game start or restart (the daily
    restart too), per account and per character, into the MongoDB collection
    `playtime`. Each log is counted once (`playtimeLogs`). Backfill old logs
    once with `node server-manager/src/playtime.js <archived gameserver logs...>`.
- **Factions** - create, edit and delete factions (name, zone, colour), their
  ranks (name, ladder order, capacity) and what each rank may do: a tick matrix
  of the ranks it may appoint, promote to, demote from and remove, plus flags
  for inviting, crafting faction gear, managing hold property, and faction
  doors and chests. It is the same editor as the dashboard's Factions view
  (`skymp5-backend/public/dashboard/faction-editor.js`, loaded by relative
  path, so run the manager from the repo checkout) and talks to the running
  backend's `/api/factions` routes: the backend is the only writer, so the
  backend service must be running. The main process adds
  `masterApiAuthToken` from server-settings.json and forwards only
  `/api/factions` paths made of slugs; the backend honours that token only
  from loopback. Deleting a faction or rank that people hold first lists them
  and arms **Remove N memberships and delete**; deleted ids are never reused.
  Edits reach the game server within about 20 seconds. Faction doors and
  chests are edited in the game server's `faction-access.json`, not here. Test: `node tools/test-factions-proxy.js`.
- **Build** - three boxes (**Game Server**, **Launcher**, **Client**) sharing one
  build console. Native code comes from CI (see **Builds** below) unless
  **Run CMake first** is ticked.
  - **Game Server**: version, **Build gamemode**, **Run CMake first**,
    **Build server**.
  - **Launcher**: **Save version** writes only `tauri.conf.json`. **Build
    launcher** builds `build/launcher/AlduinakLauncher.exe`; its button then
    turns into **Update Version**, which writes the launcher version into
    `skymp5-backend/data/versions.json`. Press it only after the exe is
    uploaded where `launcherUrl` points.
  - **Client**: **Save version** writes only `skymp5-client/package.json`.
    **Build client**. **Update modlist** runs, in one go: build manifest (from
    MO2), sync server settings (`loadOrder`), sync data folder, MongoDB purge
    (it backs up first). It is disabled with *Server must be stopped* while the
    game server runs. On success the button turns into **Update Version**,
    which writes the client version into `versions.json`; press it once the
    Nexus client files are live. There is no separate dry run.
  - The change report (mods, plugins, shifted slots, light flags, files,
    warnings) shows as cards on the Build tab only.
    `skymp5-backend/data/manifest-diff.json` exists only while the steps run
    and is deleted on success; after a failure it is kept, so the game start
    gate still refuses a half-applied load order. **Restore last purge**
    appears when a purge did not finish (game server stopped): it puts every
    backed-up document back by `_id`.
  - Manifest details: the compile writes `install-manifest.json.building` and
    keeps the last deployed manifest as `install-manifest.json.prev`. A
    `skymp5-client-settings.txt` in any mod folder and the SkyMP client package
    (`Platform/**` and the dlls and pex files listed in
    `skymp5-backend/scripts/client-package.js`) are left out, since the client
    zip delivers them. When several downloads hold the same file, a mod takes
    it from the newest archive of its own Nexus mod. The settings sync keeps
    `server-settings.json.prev`; the data sync deletes only unmodified files a
    previous manifest or sync put there, sha256-verifies copies and never
    touches vanilla masters; the purge refuses on an unreadable light flag or
    a player character that references a removed plugin.
- **News** - edit the news entries the launcher shows.
- **Settings** - structured forms (text / number / on-off radios / drop-downs /
  masked secrets) for both `server-settings.json` and the backend `.env`, instead
  of raw text. Unknown `server-settings.json` keys round-trip through an
  *Other (raw JSON)* box so nothing is silently dropped. Saving
  `server-settings.json` keeps the previous file as `server-settings.json.prev`
  and refuses when the file changed on disk since the tab was loaded (an Update
  modlist run, a hand edit): reload the tab first.

- **Security** - alerts stored in MongoDB `securityAlerts`, with a red unread
  count on the tab. Opening a kind marks its alerts read.
  - **Ban Evasions**: raised by the backend when an IP or HWID a player logs in
    with is already on another Discord account; shows the accounts and which
    are banned. Players keep `ips` and `hwids` history lists, and a ban matches
    any IP or HWID the banned player was ever seen with.
  - **Gold Spawning**: raised by the game server (`GoldWatchSystem`) when a
    character gains more than `goldAlertThreshold` gold (`server-settings.json`,
    default 5000, 0 disables) within 10 s.

Backend records (players, profiles, bans, sessions, characters, balances,
factions) live in MongoDB. The one-time import from the old JSON files is
`node skymp5-backend/scripts/import-json-to-mongo.js` (dry run), then the same
with `--apply`, with the backend stopped.

### Builds (packaging - native code comes from CI)

The native binaries (`.dll` / `.node`) are **not built here**. The GitHub
**PR Windows Flatrim** workflow compiles them with the CI-tested VS 2022 (v143)
toolchain and publishes two artifacts: `dist` (the client payload) and
`server-dist` (the server payload incl. `scam_native.node`). Building those
locally was nothing but toolchain whack-a-mole - a newer Visual Studio
(e.g. VS 18 / MSVC 14.5x) produced binaries that **crashed in-game on login** -
so the manager leaves compilation to CI and just packages the result.

**Before building:** download the CI `dist` artifact and extract it into
`build/dist/client`, and copy `scam_native.node` from `server-dist` into
`build/dist/server`.

Each Build button then does the JS/packaging work:

| Button | Does |
|--------|------|
| **Game Server** | Bundles the TypeScript → `build/dist/server/dist_back/skymp5-server.js`, then prunes `build/dist/server` to the deploy set. `scam_native.node` (from CI) and `gamemode.js` are preserved. |
| **Launcher** | Builds the Electron installer `AlduinakLauncher.exe` → `build/launcher`, plus `AlduinakLauncher.zip` for the website (launchers from 2.4.0 update from the zip at `PACKAGE_URL` in `routes/version.js`; older ones from the nginx exe). |
| **Client** | Rebuilds the front-end UI and `skymp5-client.js` into `build/dist/client`, then runs the backend `build-client` script (`populate-files.js` + `merge-files.js`) to zip `build/dist/client/Data` into `skymp-client.zip` + `data/files-version.json` for the launcher to download. The version is `CLIENT_VERSION` in `skymp5-backend/routes/version.js` - set it from the **Client** version field before building: launchers download the zip only when that version changed, so the build stops before the zip when the zip would differ from the last one under an unchanged version (a file added, removed or resized under `Data/`, or a key client file from `KEY_FILES` in `scripts/client-package.js` with a different hash); an unchanged zip under the same version is allowed and logged. Afterwards it prints one line per key file (a match with `build/dist/client`, or STALE) and fails when the zip carries a mod-owned file (a plugin, a top-level `Data/*.json` or the CraftingCategories json), which `populate-files.js` leaves out. |

**Missing prerequisites are installed automatically.** On Windows each build
button checks for **Node.js** and **Git** and installs anything missing with
`winget` (the manager runs elevated), refreshing PATH from the registry so the
new tools work without restarting the manager. That's the whole toolchain for
the JS builds; only the **Run CMake first** boxes and the console `build native`
compile the C++ locally, with VS 2022 (CMake, MSVC, vcpkg and yarn). Set
`ALDUINAK_NO_AUTO_INSTALL=1` to opt out (you'll get a manual-install hint with links
instead). If `winget` itself isn't available, the build stops with links to
install the tools by hand.

### Script signing

The gamemode signs the scripts it serves so the client's
`ServerJsVerificationService` can verify them; without a signer it logs
*"scripts will be unsigned"*. Generate the keypair once:

```bash
node server-manager/tools/gen-signing-keys.js
```

This writes `sign-gamemode.js` + `signing-private.pem` into `build/dist/server`
(honours `ALDUINAK_BUILD_DIR`, refuses to overwrite an existing key without
`--force`) and prints the entries to merge into
`skymp5-backend/data/public-keys.json` - both the `GM...` key id and the same
id without the `GM` prefix are required (different client services parse the
signature line differently). Restart the backend and game server afterwards.
The **Game Server** build's prune step preserves both files, so the signer
survives rebuilds.

### Wiring the console

Command execution is end-to-end on the in-repo side:

```
Console box → console:command → WS relay (console role)
            → gamemode  → runs command → console_output
            → WS relay  → Console log
```

The relay (`skymp5-backend/sources/wsRelay.js`) already accepts the admin
`console` role, forwards `console_command` to the gamemode, and fans the
gamemode's `console_output` back to every connected console.

The gamemode side lives in `build/dist/server/gamemode.js` (managed directly on
the server box, gitignored): it connects to the relay as the `gamemode` role and
executes `help`, `status`, `players`, `say <text>`, `notify <name|all> <text>`,
`kick <name>`, and `admin list|add|remove <profileId>`. It reads `WS_PORT` /
`RELAY_SECRET` from `skymp5-backend/.env` automatically. If the Console reports
"game console offline", the game server (or its relay connection) is down.

## Web agent (AlduinakManager service)

The dashboard's **Server** tab runs its jobs through `src/agent.js`, a loopback-only
nssm service installed by `Setup-Agent.bat` and running as the Administrator
account. It reuses the same `Builder`, service control (`src/services.js`) and
console relay (`src/relayClient.js`) as this app. Builds and syncs from this app and
web jobs share the busy lock `C:\logs\manager\busy.lock`, so they never run at
the same time. Restart the `AlduinakManager` service after changing
`server-manager/src`, but never while a web job runs. See
`docs/docs_web_server_manager.md` for the security model and runbook.

The agent also runs the daily game restart (`src/restartSchedule.js`): `say` warnings
from 1 hour before `dailyRestartAt` (`server-settings.json`, default `04:00`, `off` disables
it), then a Restart job that archives the logs. Test it with
`node tools/test-restart-schedule.js`.

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `ALDUINAK_LOG_DIR` | `C:\logs` | Fallback log directory (nssm-configured paths win) |
| `ALDUINAK_SERVER_DIR` | folder of `server-settings.json` | Game server working dir (holds the `world/changeForms` save store) |
| `ALDUINAK_SERVER_SETTINGS` | `build/dist/server/server-settings.json` | Server settings file edited by the Settings tab |
| `ALDUINAK_MO2_ROOT` | `C:\MO2` | Reference MO2 install (Update modlist) |
| `ALDUINAK_GAME_ROOT` | `X:\GOG Games\Skyrim Anniversary Edition` | Game root |
| `ALDUINAK_MO2_PROFILE` | `Default` | MO2 profile to compile |
| `ALDUINAK_BUILD_DIR` | `<repo>\build` | Build output dir; the CI `dist/` payloads and the launcher land here |
| `ALDUINAK_SERVER_KEEP` | *(none)* | Comma-separated extra names to preserve when pruning `build/dist/server` |
| `ALDUINAK_NO_AUTO_INSTALL` | *(unset)* | Set to `1` to disable auto-installing prerequisites (Node/Git) via winget; the agent defaults it to `1` |
| `ALDUINAK_EXTRA_PATH` | *(unset)* | Agent only: folders prepended to PATH, e.g. the Administrator npm folder holding yarn |

The repo path, service names, and the WS relay port/secret (from the backend
`.env`) are detected automatically.
