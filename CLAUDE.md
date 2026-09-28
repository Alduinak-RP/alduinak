
# Build & Test Tips

## Where work happens

The **Test Server** is the place everything is edited and built. The live server
(**Main Server** in the manager) only receives files through the Server Manager's
**Migrate** box. Both run on this box:

| | Main Server (live) | Test Server |
|---|---|---|
| game server folder | `build/dist/server` (never edit by hand) | `build/dist/testserver` |
| client files | `build/dist/client` | `build/dist/testclient` |
| Skyrim Data folder | `C:/GOG Games/Skyrim Anniversary Edition/Data` | `C:/GOG Games/Skyrim Anniversary Edition - Test/Data` |
| services (nssm) | AlduinakGameServer 7777, AlduinakMongo 27017, AlduinakLiveKit 7880 | AlduinakTestServer 7787, AlduinakMongoTest 27018, AlduinakLiveKitTest 7890 |
| logs | `C:\logs` | `C:\logs\test` |
| console relay (backend) | `WS_PORT` 7778 | `WS_PORT_TEST` 7779 |
| backend files (`skymp5-backend/data`) | `manifest.json`, `modlist.json`, root keys of `versions.json` | `manifest-test.json`, `modlist-test.json`, the `test` block of `versions.json` |

Gamemode parts are edited in `build/dist/testserver/gamemode_extensions`. The
manager's two profiles live in `server-manager/src/config.js` (`profiles.live`,
`profiles.test`, `buildProfile`). Setup and removal: `deploy/testserver/README.md`;
day-to-day use and the move to live: `docs/docs_test_server.md`.

## Build

Build from the Server Manager: Build tab (the "Run CMake first" checkbox, the Native
(C++) button) or console `build server`, `build gamemode`, `build native`. The repo
pins the CMake binary dir to `build/`; two cache variables choose where the artifacts
land. The manager passes the test folders (`SKYMP_DIST_SERVER_DIR` and
`SKYMP_DIST_CLIENT_DIR`), CI passes nothing and gets the live defaults. The manager
also snapshots `server-settings.json`, `launch_server.bat` and `gamemode.js` in the
target server dir and puts them back after the build, because the CMake build
rewrites them:

- the `skymp5-server` post-build step regenerates `<server dir>/server-settings.json`
  with upstream defaults (`OFFLINE_MODE` is ON by default: `offlineMode: true`,
  `master: ""`), and writes no `.prev` copy
- with `BUILD_GAMEMODE` OFF (the default) an ALL build touches `<server dir>/gamemode.js`
  (creates it empty when missing)
- `ctest` (the integration tests) replaces `<server dir>/server-settings.json` from
  `build/server-settings-base.json`, copies the test script over `gamemode.js` and
  deletes `<server dir>/world/changeForms`

So never run `cmake --build` or `ctest` by hand against a folder a game service uses.
By hand (inside `build/`), only with the Test Server stopped and the three files
backed up first:

```bash
cmake .. -DSKYMP_DIST_SERVER_DIR=<repo>/build/dist/testserver -DSKYMP_DIST_CLIENT_DIR=<repo>/build/dist/testclient
cmake --build . --config Release --target skymp5-server
```

Without the two variables CMake writes `build/dist/server` and `build/dist/client`,
which are live. The cache keeps the last values, so a plain `cmake --build .` targets
whatever the previous configure chose: check `SKYMP_DIST_SERVER_DIR` in
`build/CMakeCache.txt` before building by hand.

## Test

```bash
ctest --verbose
```

Runs the unit tests and then the integration tests, which start a server in
`SKYMP_DIST_SERVER_DIR` and rewrite its settings, `gamemode.js` and world as listed
above. On this box run the unit binary directly instead (next section); `ctest` only
with the Test Server stopped and its settings backed up.

## Test Particular Unit Test

This example runs tests with only [Respawn] tag. Tags you can see in test files (.cpp).
If you see more than 1 unit test failed, please select one to work on and iterate with the following command.
```bash
cd build
./unit/unit [Respawn]
```
## Rules

1) Warn me if any changes have been made to files listed in .gitignore (such as
   .env, gamemode.js, or server-settings.json) so I can update them on the server
   manually. These are live files, they are not carried by a commit.

2) Code comments (these apply to code comments only, not chat replies):
   a) Keep comments concise, simple, and on a single line.
   b) Do not use the em dash.
   c) Do not comment explanations of changes made to a script.
   d) Do not comment when the function name is self explanatory.

3) Keep code concise:
   a) Use shared functions where possible.
   b) Don't reinvent the wheel. Check whether this repo already has code that
      does the job before writing a new function from scratch.

4) Git workflow:
   a) Never make a PR; the user reviews code before it goes to GitHub.
   b) Make several commits, one per step, each with a description of what was done.

5) Warn me at the end of your reply if I need to take any extra steps, such as a
   CI flatrim build to regenerate the .dlls or any other workflow/rebuild step
   after a patch. Say which artifacts are affected.

## Deployment reality (read before promising a fix works)

A change reaches the Test Server after the right build, and the live server only
after the Migrate box. Getting this wrong is the single most common source of "the
fix didn't work":

| Changed | Rebuild needed |
|---|---|
| `skymp5-server/ts` | manager "Build server" (writes `build/dist/testserver/dist_back`), restart the Test Server from the Console tab. To live: **Migrate server** with the Main Server stopped, then the same button as **Migrate settings**, start the Main Server |
| `build/dist/testserver/gamemode_extensions` | manager "Build gamemode only" (or "Build server", or console `build gamemode`) regenerates `build/dist/testserver/gamemode.js`; the test server hot-reloads it, no restart. Never edit `gamemode.js` directly - it is generated. To live: **Migrate server** (Main Server stopped, like every Migrate button) copies `gamemode.js` and `gamemode_extensions`; nothing hot-reloads on live, it loads them when it is started again |
| `skymp5-client/src`, `skymp5-front/src` | Client box: set a new Test version, "Build client" (into `build/dist/testclient`; it refuses a changed client under an unchanged version), package `testclient/Data` as the Nexus client mod and install it into MO2, then the button's "Update Modlist" and "Update Version" steps; testers re-download via the launcher. The Alduinak Client Files Nexus mod carries the whole `testclient/Data`, `Platform/` and the SkyMP dlls included; the launcher refuses a manifest without a mod that provides `Platform/Plugins/skymp5-client.js`. To live: **Migrate client** (manifest, modlist, settings and data sync, purge, `testclient` -> `client`) and the Migrate box's Live version Save |
| C++ (`skyrim-platform`, `skymp5-server/cpp`) | **CI flatrim build** (apply the artifact into `build/dist/testserver` and `build/dist/testclient`), or the manager's CMake checkbox / `build native`: CMake configures `build/` (the repo refuses any other binary dir) with `SKYMP_DIST_SERVER_DIR` and `SKYMP_DIST_CLIENT_DIR` at the test folders; the Test Server must be stopped for server builds. `scam_native.node` reaches live through Migrate server, the client dlls through Migrate client. The skyrim-platform pack step (`skyrim-platform/tools/dev_service/index.js`) honours `SKYMP_DIST_CLIENT_DIR` as well, so a client native build lands in `testclient`; without the variable (CI, a by-hand build) it writes `build/dist/client` |
| MO2 modlist, versions | Client box "Update modlist" (Test Server stopped) writes the test manifest, settings and Data folder and purges the test DB. The live manifest changes only through Migrate client |
| `skymp5-launcher-tauri` | bump the version in the Launcher box, then "Build launcher" (needs Rust); players get it through the launcher's own update. Per-server manifests (`?server=test`) need this |
| `skymp5-backend` | restart AlduinakBackend; there is one backend serving both servers and both console relays |
| `server-manager/src` | restart the manager app (runs from source) |
| `deploy/testserver/*`, `deploy/mongodb/mongod-test.cfg`, `deploy/livekit/livekit-test.yaml` | the owner re-runs `deploy/testserver/setup-testserver.ps1` (elevated, idempotent) |

The manager Build tab has a **Native (C++)** button that compiles locally with
CMake/MSVC; VS 2022 with the C++ workload is installed on this box. The **CI
Rebuild** button needs `ALDUINAK_GH_TOKEN` in `skymp5-backend/.env`.

Verify a native change actually shipped before blaming the code: the CEF/browser
code compiles into `SkyrimPlatformImpl.dll` (not `SkyrimPlatform.dll`), so
searching that binary for a string you added is a quick sanity check.
