# SkyRP Server Manager

Desktop control panel that replaces the deploy `.bat` scripts. Runs on the
server box. **Run it as Administrator** — service control (nssm) needs it.

```bash
cd server-manager
setup.bat             # robust install (fixes Electron download issues)
npm start             # dev run  (run the terminal as Administrator)
npm run build:win     # packaged installer -> ../build/server-manager
```

If `npm start` reports *"Electron failed to install correctly"*, run `setup.bat`
— it reinstalls with install scripts enabled and verifies the Electron binary
downloaded (set `ELECTRON_MIRROR` first if you're behind a firewall/proxy).

## Tabs

- **Console** — Start / Stop / Restart the nssm services (`SkyrpNginx`,
  `SkyrpBackend`, `SkyrpGameServer`), a live tail of the game/backend logs, and
  a command box. Commands go to the gamemode over the WS relay; their output
  shows up in the log tail.
- **Launcher** — edit the launcher version (writes `skymp5-launcher/package.json`
  and `LATEST_VERSION` in `skymp5-backend/routes/version.js`) and rebuild
  (clears `build/launcher`, rebuilds, names the installer
  `SkyrimRoleplayLauncher.exe`).
- **Modlist** — read the reference MO2 profile (mods / separators / plugins)
  and **Update manifest** (runs `compile-manifest.js`).
- **Client** — edit the client version (writes `skymp5-client/package.json` and
  `CLIENT_VERSION` in the backend `.env`), **Update client** (build plugin →
  build front-end → build client), and a whitelist player list; click a player
  for their Discord / faction / character details.
- **Settings** — reserved for later.

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `SKYRP_LOG_DIR` | `C:\logs` | nssm log directory to tail |
| `SKYRP_MO2_ROOT` | `C:\MO2` | reference MO2 install (Modlist tab) |
| `SKYRP_GAME_ROOT` | `C:\GOG Games\Skyrim Anniversary Edition` | game root for root-file capture |
| `SKYRP_MO2_PROFILE` | `Default` | MO2 profile to compile |

The repo path, service names, and the WS relay port/secret (from the backend
`.env`) are detected automatically.

## Remaining wiring

The Console command box delivers commands to the gamemode via a new `console`
role on the WS relay (`skymp5-backend/sources/wsRelay.js`). The gamemode still
needs a handler for `{ type: 'console_command', text }` (in
`skymp5-functions-lib`) to actually execute them — until then commands are
accepted and forwarded but not run.
