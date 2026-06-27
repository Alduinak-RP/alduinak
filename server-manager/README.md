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
  build buttons and version fields, sharing one build console. Each button builds
  its system **end-to-end**: installs any missing dependencies, compiles native
  code (`.dll` / `.node`) via CMake, and writes the redistributable output.
- **Modlist** — read the reference MO2 profile and **Update manifest** (runs
  `compile-manifest.js`).
- **Settings** — structured forms (text / number / on-off radios / drop-downs /
  masked secrets) for both `server-settings.json` and the backend `.env`, instead
  of raw text. Unknown `server-settings.json` keys round-trip through an
  *Other (raw JSON)* box so nothing is silently dropped.

### Builds (.dll / .node / installers)

Each Build button is self-contained:

| Button | Builds |
|--------|--------|
| **Game Server** | TS bundle (`dist_back/skymp5-server.js`) + native `scam_native.node` → `build/dist/server`. The native addon is skipped while `SkyrpGameServer` runs (the file is locked) — stop it from the Console tab first. |
| **Launcher** | Electron installer `SkyrimRoleplayLauncher.exe` → `build/launcher`. |
| **Client** | Client logic → front-end UI → native DLLs (SkyrimPlatform / MpClientPlugin / CEF) → packaged into `build/dist/client`. |

**Missing prerequisites are installed automatically.** On Windows each build
button checks for what it needs and installs anything missing with `winget`
(the manager runs elevated): **Node.js** and **Git** for every build, plus
**CMake** and the **MSVC C++ Build Tools** ("Desktop development with C++") when
a native build is involved. After installing, PATH is refreshed from the
registry so the new tools work without restarting the manager. The MSVC Build
Tools download is several GB, so the first native build on a clean box takes a
while. Set `SKYRP_NO_AUTO_INSTALL=1` to opt out (you'll get a manual-install
hint with links instead). If `winget` itself isn't available, the build stops
with links to install the tools by hand.

The first native build also **bootstraps the bundled `vcpkg` submodule** and
configures CMake; the first configure pulls/builds the vcpkg deps (CEF,
CommonLibSSE-NG) so it can take a while. Point vcpkg at the project's NuGet
binary cache to download instead of compile. Subsequent builds are incremental.

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
| `SKYRP_BUILD_DIR` | `<repo>\build` | CMake build dir; native output lands in its `dist/` |
| `SKYRP_VCPKG_DIR` | `<repo>\vcpkg` | vcpkg checkout (bootstrapped on first native build) |
| `SKYRP_SKIP_NATIVE` | *(unset)* | Set to `1` to skip native (.dll/.node) builds |
| `SKYRP_NO_AUTO_INSTALL` | *(unset)* | Set to `1` to disable auto-installing prerequisites (Node/Git/CMake/MSVC) via winget |
| `SKYRP_CMAKE` | *(auto)* | Path to `cmake.exe` (auto-detected: PATH → standalone → VS-bundled) |
| `SKYRP_CMAKE_GENERATOR` | `Visual Studio 17 2022` | CMake generator |
| `SKYRP_CMAKE_CONFIGURE_ARGS` | *(none)* | Extra flags for the first `cmake` configure |

The repo path, service names, and the WS relay port/secret (from the backend
`.env`) are detected automatically.
