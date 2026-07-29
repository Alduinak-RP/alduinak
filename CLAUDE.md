
# Build & Test Tips

All commands below must be run **inside the build directory**  
(e.g., `mkdir build && cd build && cmake ..`).

## Build
```bash
cmake --build .
````

This compiles the project

## Test

```bash
ctest --verbose
```

Runs all tests with detailed output.

## Test Partuicular Unit Test

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

2) Keep code comments concise and on one line. Do not use the em dash.

3) Don't reinvent the wheel. Check whether this repo already has code that does
   the job before writing a new function from scratch.

4) Warn me if I need to run a CI flatrim build to regenerate the .dlls, or any
   other workflow/rebuild step, after a patch. Say which artifacts are affected.

## Deployment reality (read before promising a fix works)

A change only reaches players after the right rebuild. Getting this wrong is the
single most common source of "the fix didn't work":

| Changed | Rebuild needed |
|---|---|
| `skymp5-server/ts` | manager "Build server" (writes `dist_back`), restart game service |
| `skymp5-client/src` | manager "Build Client" + players re-download via launcher |
| `skymp5-front/src` | manager "Build Client" (same pipeline) + players re-download |
| C++ (`skyrim-platform`, `skymp5-server/cpp`) | **CI flatrim build** (or the manager's Native build), then apply the artifact into `build/dist`, then Build Client |
| `skymp5-launcher/src` | manager "Build launcher" + redistribute the launcher |
| `server-manager/src` | restart the manager app (runs from source) |

The manager Build tab has a **Native (C++)** button that compiles locally with
CMake/MSVC; VS 2022 with the C++ workload is installed on this box. The **CI
Rebuild** button needs `ALDUINAK_GH_TOKEN` in `skymp5-backend/.env`.

Verify a native change actually shipped before blaming the code: the CEF/browser
code compiles into `SkyrimPlatformImpl.dll` (not `SkyrimPlatform.dll`), so
searching that binary for a string you added is a quick sanity check.
