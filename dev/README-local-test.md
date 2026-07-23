# Local dev test (offline, no VPS)

`dev/local-test.bat` runs the whole loop on one machine with no master API, no
backend, no nginx, and no Discord OAuth. In offline mode the game server accepts
any integer `profileId` the client sends and spawns you straight in.

## One-time setup on the dev box

1. **Node** on PATH.
2. **Server dist** populated at `build/dist/server/` (needs `scam_native.node`,
   `dist_back/skymp5-server.js`, and `gamemode.js`). Build the TS bundle with:
   ```
   cd skymp5-server && npm run build-ts
   ```
   `scam_native.node` comes from a CI build (or a previous deploy).
3. **A Skyrim install** with the client files staged into its `Data` folder.
   From a built client dist:
   - copy `build/dist/client/Data` over `<game>/Data`
   - copy `build/dist/client/d3dx9_42.dll` into the game root
   - have SKSE (`skse64_loader.exe` + `skse64_*.dll`) in the game root
   With a vanilla-only `loadOrder` (the default in `dev-server-settings.json`)
   no extra plugins need enabling in `Plugins.txt`.

## Run it

Edit the three paths/ids at the top of `dev/local-test.bat`:

- `GAME_DIR` - your Skyrim install (the one with the client files in `Data`)
- `PROFILE_ID` - any integer; the offline server accepts it verbatim
- `PORT` - server port (default 7777)

Then double-click `local-test.bat`. It:

1. copies `dev-server-settings.json` to `build/dist/server/server-settings.json`
   (overwriting the production/live settings) and clears stale merge caches,
2. starts the server in its own window,
3. waits for the HTTP UI port (3000 when the game port is 7777),
4. writes `skymp5-client-settings.txt` with `profileId` + `127.0.0.1` and
   `server-info-ignore: true` (so the client skips the 5s gateway lookup),
5. launches Skyrim through SKSE.

## Notes

- The dev DB is `world-dev/` (separate from production `world/`), so testing
  never touches live save data.
- The bat OVERWRITES `build/dist/server/server-settings.json`. On the live VPS,
  re-deploy the real settings before going back online. On a dev box this is
  fine.
- Editing `gamemode.js` while the dev server runs hot-reloads it (~1s), same as
  production - handy for iterating on chat/commands without a restart.
- To reset a character, stop the server and delete the matching file under
  `build/dist/server/world-dev/changeForms/`.
