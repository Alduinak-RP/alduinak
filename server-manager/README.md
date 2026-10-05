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

- **Console** - four containers, left to right: **Backend** (services
  **Backend** and **Nginx**, collapsible to the left), **MongoDB** (the one
  `AlduinakMongo` instance, which serves the backend and both game servers:
  database `skymp` live, `skymp_test` test; its log view and START/STOP,
  RESTART row; collapsible to the left), **Main Server** (**Game** and
  **LiveKit** of the live server, collapsible to the right) and **Test
  Server** (`AlduinakTestServer` and `AlduinakLiveKitTest`, collapsible to the
  right). Each service has **START/STOP**, **RESTART** and under the buttons
  CPU, RAM (and requests/min for Nginx), sampled every 4 s only while the tab
  is open. The log views are Backend/Nginx, MongoDB and Game per server
  (LiveKit has no log view); each keeps the last 100 lines on screen, the
  files stay in `C:\logs` (live) and `C:\logs\test` (test). A container's dot
  and state follow its first service. The two server containers have a **Stop
  all** button in their head while their game runs, else **Start all**
  (LiveKit then Game in start order, reversed for stop), and a command input
  each, wired to that server's own relay (`WS_PORT` and `WS_PORT_TEST` from
  the backend `.env`). A test service that is not installed yet shows Offline
  and is skipped by the group buttons.
  - MongoDB starts first, stops last and refuses to stop while Backend, Game
    or the test Game run.
  - The game server ensures its own `changeForms` indexes at every start
    (`formDesc_1` unique and `profileId_1_formDesc_1`); older indexes are
    swapped once by `deploy/mongodb/trim-changeforms.js`.
  - The log tail asks nssm where each service writes its stdout/stderr
    (`nssm get <svc> AppStdout`) instead of guessing a fixed folder.
  - The command input first checks for **manager commands** and runs them locally:
    `help`, `status` (every service, by container),
    `start|stop|restart <service|backend|mongo|main|test|all>` (services
    `mongo`, `nginx`, `backend`, `livekit`, `game`, `test-livekit`,
    `test-game`; groups `backend` = Nginx and Backend, `mongo`, `main` =
    LiveKit and Game, `test`; a service key wins over a group of the same
    name, so `backend` names the service, and `all` walks every service in
    start order, reversed for stop), and
    `build <server|launcher|client|native|gamemode>` (builds target the test
    server; the output streams into the console log; one build or sync at a time).
  - Anything else goes to that container's game server over the backend WS
    relay (admin `console` role) and the gamemode's command output streams back
    into the same log. See **Wiring the console** below.
- **Players** - reads MongoDB directly (`players`, `profiles`, `bans`,
  `playtime` and `changeForms`). A list on the left, the detail on the right,
  with a resizable divider.
  - **Search** matches Discord name, Discord ID, character name and profile ID.
    **Filters** offers Online, GM, Banned, Dead, Male, Female and the ten races
    (flags must all hold, genders and races match any). **Sort** by Profile
    ID, Newest, Oldest, Richest, Poorest, Most Played or Least Played.
    **Refresh** reloads; the header shows visible/total.
  - The pinned **General Stats** entry has a **Generate** button: race, gender
    and profession counts, hours brackets, gold and material counts. **Total
    gold** is the gold every character of every account carries plus the gold
    in containers: every reference in `changeForms` (`recType` 0, not deleted)
    that holds items, such as house chests, bounty board strongboxes and any
    world container a player opened or filled (a container nobody touched is
    not in the store; NPC and pet inventories are not counted). The average
    and the brackets stay per account and count carried gold only.
    **Materials** counts the same characters and containers. Each row lists
    `local:Plugin` records (`MATERIALS` in `src/playerData.js`), turned into
    form ids against the server's `loadOrder` with the light flags read from
    the plugin headers in `dataDir` (`src/formIds.js`), so a load order change
    moves the ids with it; a plugin missing from the order drops its records
    and a plugin file missing from `dataDir` shows the reason instead of the
    table. Test: `node tools/test-player-stats.js`.

    | Row | Records (form id in the 2026-09 load order) |
    |---|---|
    | Leather | `db5d2:Skyrim.esm` Leather01 (`0x000DB5D2`) |
    | Leather Strips | `800e4:Skyrim.esm` LeatherStrips (`0x000800E4`) |
    | Iron, Steel, Corundum, Dwarven Metal, Quicksilver, Orichalcum, Ebony, Silver, Gold Ingot | Skyrim.esm IngotIron `0x0005ACE4`, IngotSteel `0x0005ACE5`, IngotCorundum `0x0005AD93`, IngotDwarven `0x000DB8A2`, IngotQuicksilver `0x0005ADA0`, IngotOrichalcum `0x0005AD99`, IngotEbony `0x0005AD9D`, ingotSilver `0x0005ACE3`, IngotGold `0x0005AD9E` |
    | Refined Moonstone, Refined Malachite | Skyrim.esm IngotIMoonstone `0x0005AD9F`, IngotMalachite `0x0005ADA1` |
    | Glacial Crystal Ingot | `da0b12:Update.esm` IAMIIngotGlacialCrystal (`0x01DA0B12`), injected by Hothtrooper44_ArmorCompilation.esp |
    | Refined Amber, Madness Ingot | `bc7:ccBGSSSE025-AdvDSGS.esm` (`0x06000BC7`), `bc8:ccBGSSSE025-AdvDSGS.esm` (`0x06000BC8`) |
    | Wood | Firewood `6f993:Skyrim.esm` (`0x0006F993`), Solstheim Firewood `3cf16:Dragonborn.esm` (`0x0403CF16`), Sawn Log `300e:HearthFires.esm` (`0x0300300E`) |
    | Thread | `6ce001:Update.esm` MCE_Thread (`0x016CE001`), injected by MoreCraftableEquipment.esp, the thread every tailoring recipe uses |
    | Charcoal | `33760:Skyrim.esm` Charcoal (`0x00033760`), the item the smelter's charcoal recipe makes |

    The ingots are every misc item in the load order with the
    VendorItemOreIngot keyword and an ingot editor id or name; left out are the ores, the
    Dwemer scrap, the broken weapon parts, the war horns, the quest copies
    `43e27:Skyrim.esm` (FFRiften14Ingot, "Orichalcum Ingot") and
    `b7492:City of Dawnstar.esp` ("Ingot of Zenithar"), and Sea Salt Rock.
    `bfb09:Skyrim.esm` (Coal01, also named "Charcoal") is not the recipe's
    charcoal and is not counted.
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
    (**Save**), faction ranks for that character (the faction list is grouped
    by province, then sorted by name), and has the appearance and
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
  doors and chests. The list sorts by name (courts first) or, with **Group by
  province**, under a heading per province; the choice is remembered on that
  computer and the search box matches provinces too. It is the same editor as the dashboard's Factions view
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
- **Build** - four boxes (**Server**, **Client**, **Migrate**, **Launcher**)
  sharing one build console. Every build targets the **test server**
  (`build/dist/testserver`, `build/dist/testclient`); the live server only
  receives files through the Migrate box. Native code comes from CI (see
  **Builds** below) unless **Run CMake first** is ticked, which configures
  CMake with `SKYMP_DIST_SERVER_DIR` / `SKYMP_DIST_CLIENT_DIR` pointing at the
  test dirs.
  - **Server**: **Live version** (Save writes `server` in
    `skymp5-backend/data/versions.json`), **Test version** (Save writes
    `skymp5-server/package.json` and `test.server`), **Run CMake first**,
    **Build gamemode only** (regenerates `gamemode.js` from
    `build/dist/testserver/gamemode_extensions`, the Test Server hot-reloads
    it), **Build server** (TypeScript into `build/dist/testserver/dist_back`,
    then the gamemode, then the prune; restart the Test Server for `dist_back`
    or `scam_native.node`).
  - **Client**: **Live version** (Save writes `client` in `versions.json`),
    **Test version** (Save writes only `skymp5-client/package.json`),
    **Run CMake first**, **Update modlist** and the three-state **Build
    client** button. **Build client** rebuilds the UI and `skymp5-client.js`
    into `build/dist/testclient` (seeded once from `build/dist/client` when it
    has no `Data` yet); package its `Data` folder as the Alduinak Client Files
    mod, upload it to Nexus and install it into MO2. The button then reads
    **Update Modlist**: it compiles the test manifest from MO2 and, when it
    differs from the deployed one (mods, files or versions), syncs the test
    server settings (`loadOrder`), its Data folder and MongoDB purge (backed up
    first); an unchanged modlist stops there and says so. Then **Update
    Version** publishes `test.client` from `skymp5-client/package.json` and
    the button returns to **Build client**. **Update modlist** on its own runs
    the same sync. Both are disabled with *Test server must be stopped* while
    the test game runs, and refuse when the test `server-settings.json` still
    names the live server dir, `dataDir` or database. There is no separate dry run.
  - **Migrate**: two rows of version fields, **Live** (`server`, `client`) and
    **Test** (`test.server`, `test.client`), the published values next to the
    label. Each row has **Copy test build** (fills the server field from
    `skymp5-server/package.json` and the client field from
    `skymp5-client/package.json`) and **Save** (writes the filled fields of
    that row into `versions.json`; an empty field is left alone). Client and
    server versions stay independent everywhere.
    **Migrate server** copies `dist_back`, `scam_native.node`, `gamemode.js`,
    `gamemode_extensions`, `plugins`, `data/scripts` and the server data json
    files (NPC-Spawns, weather-regions, Jobs, faction-access, alert-keywords)
    from the test server to the live one; the world, writings, player state
    files and `server-settings.json` are never copied. On success it reads
    **Migrate settings**, which merges every test setting the live file lacks or
    has differently, except the protected identity keys (name, ports, players,
    database, dataDir, logDir, voice chat, access, admin and Discord keys, daily
    restart), the debug toggles (console commands for all, Papyrus and gamemode
    hot reload, NPC corpse watch) and the switches of features on trial (`alduinakDamageFormulaSettings`,
    `survivalEnabled`, `masterySlots`, `healthRegenerationMultiplier`, copied to
    live by hand once signed off); `loadOrder` and `archives` are left alone, **Migrate client** syncs
    them from the manifest so its diff records the plugin shifts the MongoDB
    purge needs.
    **Migrate client** installs the test manifest live (`/files/extras-test/`
    URLs rewritten to `/files/extras/`, the extras archive copied), copies the
    modlist, syncs the live settings, Data folder and database (skipped when
    the manifest did not change), then mirrors `build/dist/testclient` onto
    `build/dist/client` (files the test dir lacks are deleted). Both buttons ask
    for a second click and are disabled with *Main server must be stopped*
    while the live game runs. Old files go to
    `build/dist/backup/<YYYYMMDD-HHMMSS>/server/<item>`,
    `.../<stamp>/client/Data/<key file>` (except the CEF runtime) and
    `build/dist/backup/server-settings-<stamp>.json`.
  - **Launcher**: **Save version** writes only `tauri.conf.json`. **Build
    launcher** builds two installers of the same launcher. The website one (about 60 MB),
    `build/launcher-website/AlduinakLauncher.exe`, carries the cleaned-master
    patches (`build/client-files/cleaned-masters/*.vcdiff`, GOG and Steam,
    about 55 MB, copied into the gitignored
    `skymp5-launcher-tauri/src-tauri/resources/cleaned-masters` for the
    build), so a fresh install from it cleans its masters without downloading
    them from this server (a patch missing from the install or failing its
    checksum still downloads from `/files/cleaned-masters`); the build stops
    with an error when that folder has no patch. The nginx one (about 3.6 MB),
    `build/launcher/AlduinakLauncher.exe` (served at
    `https://api.alduinak.com/downloads/`), is re-bundled without the patches,
    since every launcher update and download from this box would carry them:
    it serves Electron launchers up to 2.3.0 and any `launcherUrl` or website
    download link still pointing at this server, whose fresh installs keep
    downloading the patches from here as before. The build log notes when
    `launcherUrl` is still on this server. The button then turns into
    **Update Version**, which writes the launcher version into
    `versions.json`. Press it only after the installer is uploaded where
    `launcherUrl` points. **Download URL** (Save) writes `launcherUrl` in
    `versions.json` (https only; default `https://alduinak.com/download`, the
    website, which redirects to its CDN zip). Zip the website installer and
    upload the zip to the website before Update Version; the launcher's
    updater follows the redirect and unpacks the zip, so launcher downloads
    never touch this server once `launcherUrl` and the website's download
    link point at that zip. The one exception: Electron launchers up to 2.3.0
    run `/api/version`'s `downloadUrl` as an exe and cannot unpack a zip, so
    that field stays on `legacyDownloadUrl` in `versions.json` (default
    the nginx `https://api.alduinak.com/downloads/AlduinakLauncher.exe`);
    keep that exe on nginx for them.
  - Version forms: client and server versions (the package files, `client`,
    `server`, `test.client`, `test.server`) are semver with an optional
    prerelease or build part, `1.2.3`, `1.2.3-b4` or `1.2.3+4`; the launcher
    compares client versions as strings, so a build suffix is safe. The
    launcher version itself stays three numbers (`1.2.3`), its updater parses
    them.
  - The change report (mods, plugins, shifted slots, light flags, files,
    warnings) of the last Update modlist or Migrate client shows as cards on
    the Build tab only; a mod whose MO2 version changed reads `name: v1 -> v2`.
    `skymp5-backend/data/manifest-diff-test.json` (live: `manifest-diff.json`)
    exists only while the steps run and is deleted on success; after a failure
    it is kept, so that game's start gate still refuses a half-applied load
    order. **Restore last purge** appears when a test purge did not finish
    (test game stopped): it puts every backed-up document back by `_id`.
  - Manifest details: the compile writes `manifest-test.json.building` and
    keeps the last deployed manifest as `manifest-test.json.prev` (the live
    pair is `manifest.json` / `.prev`, written only by Migrate client), plus
    `modlist-test.json` and the extras archive under `build/client-files/extras-test`.
    A `skymp5-client-settings.txt` in any mod folder and the SkyMP client package
    (`Platform/**` and the dlls and pex files listed in
    `skymp5-backend/scripts/client-package.js`) are left out, since the client
    zip delivers them. `*.log` files in mod folders and `ActorLimitFix.pdb`
    (debug symbols) are left out too, listed on the compile's `left out:`
    line, and the launcher leaves the same files out of its folder size check
    (`mo2::is_unverified`, launchers after 3.0.5). Its repair line names
    the files that differ: `[install] Actor Limit Fix: folder is A bytes,
    manifest expects B (unlisted X n bytes, Y n bytes, not m, missing Z) -
    repairing`. Actor Limit Fix writes `ActorLimitFix.log` next to its dll on
    every game start; that lands in the mod folder only when the folder
    already has the file (an install from a manifest older than C22, which
    shipped it empty), otherwise MO2 puts it in `overwrite`. Leaving the pdb
    out changes the mod's hash, so every install rebuilds it once after the
    next Update Modlist; a launcher after 3.0.5 keeps the unchanged dll and
    json and downloads nothing, 3.0.5 downloads the archive again (by hand on
    a free Nexus account). Both servers use one MO2 folder, so while the test
    and live manifests differ a PC that plays both rebuilds it on each switch,
    and the switch to live downloads the archive for the pdb, until Migrate
    client. When several downloads
    hold the same file, a mod takes it from the newest archive of its own
    Nexus mod. A mod built from several archives (Alduinak Client Files takes
    the client archive and the DynDOLOD Files archive) is reinstalled as a
    whole when any file changes, but the launcher keeps every file already on
    disk with the manifest's size and sha256 and downloads only the archives
    the changed files come from, so a new client archive no longer pulls the
    DynDOLOD archive again; `install.log` reads `[install] <mod>: keeping N
    of M file(s) ...` and `[install] skipping archive <name> ...`, and Repair
    Modlist still rebuilds everything from the archives. With Mod Manager None
    every mod goes into the one Data folder, so a path two mods share (1333 in
    the test manifest, 1072 of them Alduinak Client Files over DynDOLOD
    Resources SE) is written and checked for the higher-priority mod only, as
    MO2 would show it; before, the lower mod overwrote it and the two mods
    flagged each other on alternate Plays, re-downloading the DynDOLOD archive
    each time (`[install] Mod Manager None: N file(s) left to a higher-priority
    mod with the same path`). The settings sync keeps
    `server-settings.json.prev`; the data sync deletes only unmodified files a
    previous manifest or sync put there, sha256-verifies copies and never
    touches vanilla masters; the purge refuses on an unreadable light flag or
    a player character that references a removed plugin.
- **Schedule** - timed tasks for the Main or the Test Server, kept in
  `<MANAGER_LOG_DIR or C:\logs\manager>\schedule.json`: **Restart** (the
  `Server restart in N minutes` warnings 60, 30, 10, 5, 4, 3, 2 and 1 minutes
  before, then a restart; skipped when that game is stopped, refused before
  anything stops while a MongoDB purge is pending (as a scheduled Start is),
  waits up to 30 minutes for a build holding the busy lock), **Say**
  (broadcast a message),
  **Console command** (a game console command, as typed in the Console tab),
  **Start** and **Stop**. Each task has a time (HH:MM) and optional weekdays
  (none ticked = every day) in the tab's time zone, an IANA name (default
  `America/New_York`), whatever the box's own zone is (Pacific today). Without
  a `schedule.json` the default is one daily Main Server restart at 04:00 New
  York time; Save writes the file. The `AlduinakManager` agent runs the
  schedule when its service is installed and running (it writes a heartbeat,
  `schedule-runner.json`, every 20 s); otherwise this app runs it while it is
  open, and the tab says so in red. Each run and each restart warning is
  claimed once in `schedule-runs/`, so the agent and the app (or a manager
  open in another Windows session) never both send it; launching this app
  again only brings the open window forward. A runner that takes over from
  one whose heartbeat stopped less than 10 minutes ago (the agent restarted
  or crashed, the app reopened) still runs a task that fell due since that
  heartbeat and nobody claimed, without the warnings it missed. Otherwise a
  task whose time passed more than 10 minutes ago (manager closed, box
  asleep) waits for its next time. The runner's last lines show under the table and as
  `[schedule]` lines in the Console tab, e.g. `restart on live (daily-restart)
  done`. `dailyRestartAt` in `server-settings.json` is no longer read.
- **News** - edit the news entries the launcher shows.
- **Settings** - structured forms (text / number / on-off radios / drop-downs /
  masked secrets) for the live `server-settings.json`, the test server's
  `server-settings.json (test)` (same fields, `build/dist/testserver`) and the
  backend `.env`, instead of raw text. Unknown `server-settings.json` keys
  round-trip through an *Other (raw JSON)* box so nothing is silently dropped.
  Saving a `server-settings.json` keeps the previous file as
  `server-settings.json.prev` and refuses when the file changed on disk since
  the tab was loaded (an Update modlist run, a hand edit): reload the tab first.

- **Security** - alerts stored in MongoDB `securityAlerts`, with a red unread
  count on the tab. Opening a kind marks its alerts read.
  - **Ban Evasions**: raised by the backend when an IP or HWID a player logs in
    with is already on another Discord account; shows the accounts and which
    are banned. Players keep `ips` and `hwids` history lists, and a ban matches
    any IP or HWID the banned player was ever seen with.
  - **Gold Spawning**: raised by the game server (`GoldWatchSystem`) when a
    character gains more than `goldAlertThreshold` gold (`server-settings.json`,
    default 5000, 0 disables) between two samples, 10 to 60 s apart.

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
`build/dist/testclient` (a missing `Data` folder is seeded from
`build/dist/client` on the first Build client), and copy `scam_native.node`
from `server-dist` into `build/dist/testserver`. `Run CMake first` builds
both locally into the same test dirs instead.

Each Build button then does the JS/packaging work:

| Button | Does |
|--------|------|
| **Build server** | Runs the `build-ts` steps of `skymp5-server/package.json` (`tsc --noEmit`, then esbuild) with the bundle written to `build/dist/testserver/dist_back/skymp5-server.js`, rebuilds `gamemode.js`, then prunes `build/dist/testserver` to the deploy set. `scam_native.node` (from CI or CMake) and `gamemode.js` are preserved. |
| **Build launcher** | Builds the Tauri installer twice: with the cleaned-master patches from `build/client-files/cleaned-masters` → `build/launcher-website/AlduinakLauncher.exe` (zip it for the website, where `launcherUrl` in `versions.json` should point), then re-bundled without them → `build/launcher/AlduinakLauncher.exe`, which nginx serves. |
| **Build client** | Rebuilds the front-end UI and `skymp5-client.js` into `build/dist/testclient` (`ALDUINAK_CLIENT_OUT` steers the client webpack output) and checks the key files from `KEY_FILES` in `scripts/client-package.js` are there. The `Data` folder is what goes to Nexus as the Alduinak Client Files mod; the launcher installs it from the manifest like any other mod. |
| **Migrate server / settings / client** | Copy a tested build to `build/dist/server`, `build/dist/client` and the live manifest, see the Build tab notes above; `node tools/test-migrate.js` exercises the copy, merge, mirror and URL rewrite in temp folders, `node tools/test-modsync-diff.js` the version-aware manifest diff. |

The web manager's **Build server** and **Build gamemode only** jobs use the
same `Builder`, so they target the test server as well.

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

The agent also runs the Schedule tab's tasks (`src/restartSchedule.js`); a Main
Server restart, start or stop runs as a web job, so the Jobs tab and the audit record
it, and the restart archives the logs. Test the scheduler with
`node tools/test-restart-schedule.js`.

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `ALDUINAK_LOG_DIR` | `C:\logs` | Fallback log directory (nssm-configured paths win) |
| `ALDUINAK_SERVER_DIR` | folder of `server-settings.json` | Game server working dir (holds the `world/changeForms` save store) |
| `ALDUINAK_SERVER_SETTINGS` | `build/dist/server/server-settings.json` | Live server settings file (Settings tab, Players, Security, the agent) |
| `ALDUINAK_TEST_SERVER_DIR` | `build/dist/testserver` | Test game server working dir: every build and Update modlist target it |
| `ALDUINAK_TEST_SERVER_SETTINGS` | `<test server dir>\server-settings.json` | Test server settings file (Settings tab's test subtab, Update modlist) |
| `ALDUINAK_MO2_ROOT` | `C:\MO2` | Reference MO2 install (Update modlist) |
| `ALDUINAK_GAME_ROOT` | `C:\GOG Games\Skyrim Anniversary Edition` | Game root |
| `ALDUINAK_MO2_PROFILE` | `Alduinak` | MO2 profile to compile |
| `ALDUINAK_BUILD_DIR` | `<repo>\build` | Build output dir; the CI `dist/` payloads and the launcher land here |
| `ALDUINAK_SERVER_KEEP` | *(none)* | Comma-separated extra names to preserve when pruning `build/dist/server` |
| `ALDUINAK_NO_AUTO_INSTALL` | *(unset)* | Set to `1` to disable auto-installing prerequisites (Node/Git) via winget; the agent defaults it to `1` |
| `ALDUINAK_EXTRA_PATH` | *(unset)* | Agent only: folders prepended to PATH, e.g. the Administrator npm folder holding yarn |

The repo path, service names, and the WS relay ports/secret (from the backend
`.env`: `WS_PORT` for the live server, `WS_PORT_TEST`, default 7779, for the
test server, one `RELAY_SECRET` for both) are detected automatically; a port
that is not an integer, or a test port equal to the live one, leaves that
console offline (its log says so) instead of falling back to the live relay. The test
game's own logs default to `C:\logs\test` (its `logDir` setting wins);
`ALDUINAK_LOG_DIR` only applies to the live server.
