# Alduinak Launcher

Desktop launcher for the Alduinak SkyMP server. Handles Discord authentication, client file installation, mod management via Mod Organizer 2, and launching Skyrim through SKSE.
Original by the SkyMP team: https://github.com/F02K/SkyMP-Launcher

Pre-built installers are available at **https://alduinak.com/**.

## Instructions

1) Open the Server Manager (server-manager) and go to the Launcher tab
2) Set the version if needed, then click "Rebuild"
3) Collect the installer from build\launcher\AlduinakLauncher.exe (already named for distribution)
4) nginx is already set up to route api.alduinak.com/download/AlduinakLauncher.exe, change this as needed
5) Whenever you edit these files, rebuild from the Launcher tab. Also, check the Backend readme.md for more.

## Project structure

```
src/
  main.js          Main process: window, IPC handlers, OAuth flow, install, launch
  preload.js       Context-isolated bridge - exposes window.electronAPI to renderer
  config.js        API_URL from env (defaults to https://api.alduinak.com)
  mo2.js           Mod Organizer 2 portable install + manifest replay
  nexus.js         Nexus Mods API (key validation, premium downloads, SSO)
  ini.js           Minimal INI reader/writer for SkyrimPrefs.ini
  renderer/
    index.html     UI shell: topbar, content grid, modals
    renderer.js    Event listeners, API calls, settings, news/modlist rendering
    styles.css     Dark theme, glass effects, custom fonts
assets/            App icon (icon.ico), background.gif, controlmap.txt
```

## Development

```bash
npm install
npm start        # or npm run dev
```

Runs with `--dev` flag: DevTools open, loads `.env` from project root.

Copy `.env.example` to `.env` and set `API_URL` if pointing at a local backend:

```
API_URL=http://localhost:4000
```

## Building

```bash
npm run build:win    # Windows - NSIS installer (x64), the supported target
npm run build        # electron-builder default
```

The app is Windows-only in practice (tasklist process detection, reg.exe nxm
handler, NSIS installer, MO2, LOCALAPPDATA paths). The `build:linux`/`build:mac`
scripts and their config blocks are present but need platform icons added first.

Output goes to `../build/launcher` (see `directories.output` in package.json).

### Client settings file format

Offline mode (server `offlineMode: true`):
```json
{
  "server-ip": "...",
  "server-port": 7777,
  "master": "",
  "server-master-key": null,
  "gameData": { "profileId": 12345 }
}
```

Online mode (server `offlineMode: false`):
```json
{
  "server-ip": "...",
  "server-port": 7777,
  "master": "https://api.alduinak.com/",
  "server-master-key": "<key>"
}
```
In online mode the session credentials are written separately to
`Data/Platform/PluginsNoLoad/auth-data-no-load.js` so the in-game SkyMP client
skips its own Discord OAuth dialog.

## Persistent store keys

| Key | Type | Purpose |
|-----|------|---------|
| `skyrimPath` | string | Path to the source Skyrim Special Edition directory |
| `baseDirPath` | string | Alduinak base dir: MO2 root, with the game copy at `<base>\skyrim` |
| `isolatedGame` | boolean | Play from the isolated game copy instead of `skyrimPath` |
| `mo2Enabled` | boolean | Launch the game through the managed portable MO2 |
| `activeServerIndex` | number | Index into the cached server list |
| `cachedServers` | array | Last-known server list (offline fallback) |
| `filesVersion` | string | Version tag of installed client files |
| `installedRootHash` | string | Manifest root-hash of the installed game-root components |
| `discordUser` | object | Discord user info for display |
| `gameProfileId` | number | Stable player ID (masterApiId) |
| `gameSession` | string | Play-session token |
| `nexusApiKey` | string | Nexus Mods API key |
| `nexusUser` | object | `{ name, isPremium }` from the last Nexus validation |

## Backend API endpoints used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/servers` | Server list |
| GET | `/api/status` | Online/offline + player count |
| GET | `/api/serverinfo` | Name, max players, lock status, auth config |
| GET | `/api/news` | News cards |
| GET | `/api/modlist` | Mod list with Nexus links |
| GET | `/api/metrics` | Server performance stats |
| GET | `/api/files/version` | Current client files version tag |
| GET | `/api/files/zip` | Client files bundle (ZIP download) |
| GET | `/api/install-manifest` | Compiled MO2 modpack manifest |
| GET | `/api/nexus-downloads` | File-pinned Nexus links page (opened in browser) |
| GET | `/api/version` | Launcher update check |
| GET | `/api/users/login-discord` | Starts Discord login (opened in browser) |
| GET | `/api/users/login-discord/status` | Polled for the completed session |

## Server lock

If the backend sets `locked: true`, the Play button is disabled for users whose Discord ID is not in `lockedAllowList`. Used during maintenance or testing periods.
