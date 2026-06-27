# SkyRP Server Manager

Desktop control panel for the SkyRP server. Runs on the server box. **Run it as
Administrator** — service control (nssm) needs it.

```bash
cd server-manager
setup.bat             # robust install — installs deps then launches the app
Run.bat               # everyday launch (self-elevates for service control)
npm run build:win     # packaged installer -> ../build/server-manager
```

`setup.bat` installs dependencies and then starts the manager via `Run.bat`.
After the first setup, just use `Run.bat` (it requests Administrator rights so
the Console tab can start/stop the Windows services).

If `npm start` reports *"Electron failed to install correctly"*, run `setup.bat`.
It recovers the Electron runtime even on a flaky firewall (reuse the launcher's
Electron, extract a manually-dropped zip, then retry the download). If all else
fails it prints a direct download URL — save that zip as
`server-manager\electron-v41.2.0-win32-x64.zip` and re-run `setup.bat`.

## Tabs

- **Console** — three drop-downs to individually **start / stop / restart** the
  `nginx`, `backend`, and `game` services, a live tail of the **actual server run
  logs**, and a command box that runs commands against the live server.
  - The log tail asks nssm where each service writes its stdout/stderr
    (`nssm get <svc> AppStdout`) instead of guessing a fixed folder, so it always
    shows the real run output regardless of where the install script put the logs.
  - Typed commands go to the game server over the backend WS relay (admin
    `console` role) and the gamemode's command output streams back into the
    console. See **Wiring the console** below.
- **Players** — a searchable player list on the left, an editable detail panel on
  the right. Search matches **name, Discord ID, and character names**. The detail
  panel edits `username` / `displayName` / `notes` (persisted to the backend) and
  shows factions and the player's **characters** (read from the game server's save
  store). No more pop-up.
- **Build** — three columns (**Game Server**, **Launcher**, **Client**) with their
  build buttons and version fields, sharing one build console. The buttons are
  **JS/packaging only** — the native code (`.dll` / `.node`) is compiled by the
  GitHub **PR Windows Flatrim** workflow and downloaded as the `dist` artifact;
  these buttons bundle TypeScript, build the Electron launcher, and zip the
  CI-produced client files for the launcher to serve.
- **Modlist** — read the reference MO2 profile and **Update manifest** (runs
  `compile-manifest.js`).
- **Settings** — structured forms (text / number / on-off radios / drop-downs /
  masked secrets) for both `server-settings.json` and the backend `.env`, instead
  of raw text. Unknown `server-settings.json` keys round-trip through an
  *Other (raw JSON)* box so nothing is silently dropped.

### Builds (packaging — native code comes from CI)

The native binaries (`.dll` / `.node`) are **not built here**. The GitHub
**PR Windows Flatrim** workflow compiles them with the CI-tested VS 2022 (v143)
toolchain and publishes two artifacts: `dist` (the client payload) and
`server-dist` (the server payload incl. `scam_native.node`). Building those
locally was nothing but toolchain whack-a-mole — a newer Visual Studio
(e.g. VS 18 / MSVC 14.5x) produced binaries that **crashed in-game on login** —
so the manager leaves compilation to CI and just packages the result.

**Before building:** download the CI `dist` artifact and extract it into
`build/dist/client`, and copy `scam_native.node` from `server-dist` into
`build/dist/server`.

Each Build button then does the JS/packaging work:

| Button | Does |
|--------|------|
| **Game Server** | Bundles the TypeScript → `build/dist/server/dist_back/skymp5-server.js`, then prunes `build/dist/server` to the deploy set. `scam_native.node` (from CI) is preserved. |
| **Launcher** | Builds the Electron installer `SkyrimRoleplayLauncher.exe` → `build/launcher`. |
| **Client** | Runs the backend `build-client` script (`populate-files.js` + `merge-files.js`) to zip `build/dist/client/Data` into `skymp-client.zip` + `data/files-version.json` for the launcher to download. The version is taken from `CLIENT_VERSION` in the backend `.env` — set it from the **Client** version field before building. |

**Missing prerequisites are installed automatically.** On Windows each build
button checks for **Node.js** and **Git** and installs anything missing with
`winget` (the manager runs elevated), refreshing PATH from the registry so the
new tools work without restarting the manager. That's the whole toolchain now —
no CMake, MSVC, vcpkg, or yarn, since nothing is compiled locally. Set
`SKYRP_NO_AUTO_INSTALL=1` to opt out (you'll get a manual-install hint with links
instead). If `winget` itself isn't available, the build stops with links to
install the tools by hand.

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

The one piece that lives outside this repo is the **gamemode handler** that
actually runs a command — the gamemode (`skymp5-functions-lib`) is fetched and
built separately. A ready-to-drop-in reference handler is provided at
[`gamemode-console-handler.example.js`](gamemode-console-handler.example.js):
add its `console_command` branch to the gamemode's relay socket and rebuild the
gamemode. Until then, commands are delivered and acknowledged but not executed.

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `SKYRP_LOG_DIR` | `C:\logs` | Fallback log directory (nssm-configured paths win) |
| `SKYRP_SERVER_DIR` | folder of `server-settings.json` | Game server working dir (holds the `world/changeForms` save store) |
| `SKYRP_SERVER_SETTINGS` | `build/dist/server/server-settings.json` | Server settings file edited by the Settings tab |
| `SKYRP_MO2_ROOT` | `C:\MO2` | Reference MO2 install (Modlist tab) |
| `SKYRP_GAME_ROOT` | `C:\GOG Games\Skyrim Anniversary Edition` | Game root |
| `SKYRP_MO2_PROFILE` | `Default` | MO2 profile to compile |
| `SKYRP_BUILD_DIR` | `<repo>\build` | Build output dir; the CI `dist/` payloads and the launcher land here |
| `SKYRP_SERVER_KEEP` | *(none)* | Comma-separated extra names to preserve when pruning `build/dist/server` |
| `SKYRP_NO_AUTO_INSTALL` | *(unset)* | Set to `1` to disable auto-installing prerequisites (Node/Git) via winget |

The repo path, service names, and the WS relay port/secret (from the backend
`.env`) are detected automatically.
