
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

A change only reaches players after the right rebuild. Getting this wrong is the
single most common source of "the fix didn't work":

| Changed | Rebuild needed |
|---|---|
| `skymp5-server/ts` | manager "Build server" (writes `dist_back`), restart game service |
| `build/dist/server/gamemode_extensions` | manager "Build gamemode only" (or "Build server", or console `build gamemode`) regenerates `gamemode.js`; the server hot-reloads it, no restart. Never edit `gamemode.js` directly - it is generated |
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
