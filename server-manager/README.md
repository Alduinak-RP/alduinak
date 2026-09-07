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

- **Console** - four drop-downs to individually **start / stop / restart** the
  `nginx`, `backend`, `livekit` (voice media server), and `game` services, plus
  an **All** row that starts them in that order (and stops in reverse), a live
  tail of the **actual server run logs**, and a command box that runs commands
  against the live server.
  - The log tail asks nssm where each service writes its stdout/stderr
    (`nssm get <svc> AppStdout`) instead of guessing a fixed folder, so it always
    shows the real run output regardless of where the install script put the logs.
  - The command box first checks for **manager commands** and runs them locally:
    `help`, `status`, `start|stop|restart <nginx|backend|livekit|game|all>`, and
    `build <server|launcher|client|native|gamemode>` (build output streams into
    the console log; one build or sync at a time).
  - Anything else goes to the game server over the backend WS relay (admin
    `console` role) and the gamemode's command output streams back into the
    console. See **Wiring the console** below.
- **Players** - a searchable player list on the left, an editable detail panel on
  the right. Search matches **name, Discord ID, and character names**. The detail
  panel edits `username` / `displayName` / `notes` (persisted to the backend) and
  shows factions and the player's **characters** (read from the game server's save
  store). No more pop-up.
- **Build** - three columns (**Game Server**, **Launcher**, **Client**) with their
  build buttons and version fields, sharing one build console. The buttons are
  **JS/packaging only** - the native code (`.dll` / `.node`) is compiled by the
  GitHub **PR Windows Flatrim** workflow and downloaded as the `dist` artifact;
  these buttons bundle TypeScript, build the Electron launcher, and zip the
  CI-produced client files for the launcher to serve.
- **Modlist** - read the reference MO2 profile and **Build manifest** (runs
  `compile-manifest.js`). The compile writes `install-manifest.json.building`
  and leaves the live manifest untouched; once it succeeds the last *deployed*
  manifest is kept as `install-manifest.json.prev` and the new file is renamed
  into place (a failed compile only deletes the `.building` file). The backend
  streams the manifest per request, so it needs no restart. Afterwards the
  **diff panel** shows: mods added / removed / changed, plugins added / removed
  (and whether the order changed), plugins whose form-id slot **shifted** and
  light-flag changes (both need the MongoDB purge), files added / removed /
  changed, warnings (red card), a **MongoDB purge needed** card and the applied
  stamps (settings synced / data synced / purged, with times). The diff is
  stored in `skymp5-backend/data/manifest-diff.json` and reloaded on startup;
  it also records the `loadOrder` the database was last written under, which
  the purge re-encodes ids from, and keeps carrying it until that purge ran.
  Modlist output goes to the tab's own log.
  - **Sync server settings** rewrites `loadOrder` in `server-settings.json` to
    the five vanilla masters followed by the manifest's enabled plugins (each as
    `<dataDir>/<plugin>`). It refuses when no manifest diff exists yet (build
    the manifest first so the current load order is recorded for the purge),
    when the file is invalid JSON or the manifest has no enabled plugins; it
    keeps the previous file as `server-settings.json.prev` (preserved by the
    Game Server build's prune step), never touches `archives`, and warns about
    plugins not yet in the Data folder or enabled but provided by no mod. The
    Settings tab reloads afterwards. The game server reads the order at boot.
  - **Sync data folder** mirrors the manifest into the game `Data` folder
    (`dataDir` from `server-settings.json`) from the MO2 mod folders. The first
    click is a **dry run** that prints the plan (every delete, every missing
    source, the first 100 copies) and arms the button; it stays armed until the
    second click applies the plan or any other Modlist action disarms it.
    Only files the previous deployed manifest or the last sync stamp
    (`data-sync.json`) put there are deleted, and only when unmodified (plugins
    and archives are removed even if modified); vanilla masters, `manifest.json`
    and anything else in `Data` are never touched. Copies go through a temp
    file and are sha256-verified. Empty folders left behind are removed.
  - **Purge MongoDB** (game server stopped) removes the world changeForms that
    reference plugins dropped from the load order and re-encodes the numeric
    ids of plugins whose slot shifted; same two-click flow (dry run, then
    apply), with an EJSON backup next to `server-settings.json` first.
  - **Deploy flow:** Build manifest -> Sync server settings -> Sync data folder
    -> Purge MongoDB (game server stopped) -> start the game server. Players
    then re-run the launcher to pick up the changes; the backend needs no
    restart.
- **Settings** - structured forms (text / number / on-off radios / drop-downs /
  masked secrets) for both `server-settings.json` and the backend `.env`, instead
  of raw text. Unknown `server-settings.json` keys round-trip through an
  *Other (raw JSON)* box so nothing is silently dropped. Saving
  `server-settings.json` keeps the previous file as `server-settings.json.prev`
  and refuses when the file changed on disk since the tab was loaded (a Sync
  server settings run, a hand edit): reload the tab first.

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
| **Launcher** | Builds the Electron installer `AlduinakLauncher.exe` → `build/launcher`. |
| **Client** | Runs the backend `build-client` script (`populate-files.js` + `merge-files.js`) to zip `build/dist/client/Data` into `skymp-client.zip` + `data/files-version.json` for the launcher to download. The version is taken from `CLIENT_VERSION` in the backend `.env` - set it from the **Client** version field before building. |

**Missing prerequisites are installed automatically.** On Windows each build
button checks for **Node.js** and **Git** and installs anything missing with
`winget` (the manager runs elevated), refreshing PATH from the registry so the
new tools work without restarting the manager. That's the whole toolchain now,
no CMake, MSVC, vcpkg, or yarn, since nothing is compiled locally. Set
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

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `ALDUINAK_LOG_DIR` | `C:\logs` | Fallback log directory (nssm-configured paths win) |
| `ALDUINAK_SERVER_DIR` | folder of `server-settings.json` | Game server working dir (holds the `world/changeForms` save store) |
| `ALDUINAK_SERVER_SETTINGS` | `build/dist/server/server-settings.json` | Server settings file edited by the Settings tab |
| `ALDUINAK_MO2_ROOT` | `X:\MO2` | Reference MO2 install (Modlist tab) |
| `ALDUINAK_GAME_ROOT` | `X:\GOG Games\Skyrim Anniversary Edition` | Game root |
| `ALDUINAK_MO2_PROFILE` | `Default` | MO2 profile to compile |
| `ALDUINAK_BUILD_DIR` | `<repo>\build` | Build output dir; the CI `dist/` payloads and the launcher land here |
| `ALDUINAK_SERVER_KEEP` | *(none)* | Comma-separated extra names to preserve when pruning `build/dist/server` |
| `ALDUINAK_NO_AUTO_INSTALL` | *(unset)* | Set to `1` to disable auto-installing prerequisites (Node/Git) via winget |

The repo path, service names, and the WS relay port/secret (from the backend
`.env`) are detected automatically.
