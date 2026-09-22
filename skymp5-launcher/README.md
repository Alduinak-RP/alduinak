# Alduinak Launcher

Desktop launcher for the Alduinak SkyMP server. Handles Discord authentication, client file installation, mod management via Mod Organizer 2, and launching Skyrim through SKSE.
Original by the SkyMP team: https://github.com/F02K/SkyMP-Launcher

Pre-built installers are available at **https://alduinak.com/**.

## Instructions

1) Open the Server Manager (server-manager) and go to the Launcher tab
2) Set the version if needed, then click "Rebuild"
3) Collect the installer from build\launcher\AlduinakLauncher.exe and the ready-made build\launcher\AlduinakLauncher.zip
4) Upload the zip to the website and set PACKAGE_URL in skymp5-backend/routes/version.js if its link changed (no restart). Launchers from 2.4.0 update from that zip.
   nginx keeps serving api.alduinak.com/downloads/AlduinakLauncher.exe (DOWNLOAD_URL) for launchers up to 2.3.0, so leave the exe in build\launcher
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
  gameversion.js   SkyrimSE.exe version gate (1.6.1170.0) + Reliquary downgrade popup
  cleanmasters.js  Simple Cleaned Masters patch table (sizes, patch and output sha256)
  renderer/
    index.html     UI shell: topbar, content grid, modals
    renderer.js    Event listeners, API calls, settings, news/modlist rendering
    styles.css     Dark theme, glass effects, custom fonts
assets/            App icon (icon.ico), background.gif, controlmap.txt, 7zip/ and xdelta/ (shipped as extraResources)
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

## Server selection

When `/api/servers` lists more than one server (the Test Server appears once
the backend has its `TEST_SERVER_*` keys), the footer shows a dropdown, with
Alduinak selected by default. The choice is stored as `activeServerId`; the
status badge, the lock state and every serverinfo call then ask for that server,
and the client settings get its address, port and `server-master-key`. The
SkyMP client asks `/api/servers/<master key>/serverinfo` for the host and port
it joins, so the master key is what really picks the server. The Test Server admits
only Admins and Developers, so PLAY stays greyed out for everyone else there
(docs/docs_test_server.md).

## Game version

The client is built against Skyrim SE/AE **1.6.1170.0** (Steam). `gameversion.js`
reads the FileVersion straight out of `SkyrimSE.exe` (pure node PE parser, no
process spawn) and the launcher checks it at startup, before the portable game
copy is created, and on every launch path via `prepareForLaunch`. Any other
build opens a "Wrong Skyrim version" popup with a button to the Reliquary
downgrade tool (https://www.nexusmods.com/site/mods/2188?tab=description) and
blocks the launch; the renderer warning strip shows the same message. GOG
installs (Galaxy64.dll / goggame-* present) are accepted at **1.6.1179.0**, the
GOG build of the same generation. An unreadable version never blocks, it is
only logged.

## Client files

The SkyMP client package (`Platform/**`, `SKSE/Plugins/SkyrimPlatform.dll`,
`SKSE/Plugins/MpClientPlugin.dll`, `Scripts/MpClientPlugin.pex`,
`Scripts/TESModPlatform.pex`; the list is `skymp5-backend/scripts/client-package.js`)
comes from the backend zip (`/api/files/zip`, built by Build Client) and is
extracted into the real Data, under MO2 and in the direct install alike.
`compile-manifest.js` keeps those paths out of every manifest mod, whatever the
mod folder holds, because under MO2 a mod copy shadows the real Data and a
client build then never reaches players (the r13 play test ran a two-day-old
client that way). The launcher still honours a manifest mod that carries
`Platform/Plugins/skymp5-client.js` (`clientMods`), which no manifest built
with the guard contains; the Nexus mod 'Alduinak Client Files' must never carry
`Platform/` or the SkyMP dlls and pex files, only the plugin, the
CraftingCategories json, meshes, scripts and Address Library's bins.

The launcher writes `skymp5-client-settings.txt` and the auth file into the real
Data (the manifest never ships a settings file, or MO2 would let it shadow this
one). The Engine Fixes preloader `d3dx9_42.dll` comes from the manifest's
`root` list (`rootInclude` on the backend) and is restored whenever it goes
missing. Launch checks find client files and plugins in the real Data or any
mod folder (`dataFileFinder`).

A client change reaches players through the zip alone: set a new **Client
version** in the manager's Build tab (launchers download the zip only when the
version differs from the one they stored, `files:updateCheck` and
`installClientFilesCore`), then Build Client, which refuses to rebuild the zip
when its content would differ from the last zip under an unchanged version. No Nexus upload and
no Update manifest are needed for a client change.

## Stray files in the game copy

The portable copy (`<base>\skyrim`) holds only what the launcher puts there:
the vanilla files (`vanillaJobs`), `Skyrim.ccc` and the copy and Creation
stamps, the manifest's Creation and root files, the preloader, the SKSE
`skse64_*` exe and dlls, the client settings, the auth file, `controlmap.txt`,
logs, and the client zip's files when no manifest mod carries the client. Every
other file is a stray (`gameCopyStrays`): the MO2 install pass deletes them and
prunes empty folders, and Check Files lists them for Repair Game Copy. Nothing
is deleted unless Portable Skyrim Mode and MO2 are both on, the folder is
`<base>\skyrim` with `alduinak-instance.txt` in `<base>`, it does not overlap
the original install, the original's `Skyrim.esm` is readable, and the manifest
(and, for the zip, its file list) was fetched. Links are never followed.

## Cleaned masters

The server's masters and three Creation plugins are cleaned with Simple Cleaned
Masters, and every client loads the same bytes. `ensureCleanedMasters` runs
after the game copy is made (`createIsolatedImpl`), after the Creation files are
copied on every install pass (`runMO2Install`), after the vanilla check in the
direct install, and from **Repair Cleaned Masters**. Each file's size tells
whether it is already cleaned (skipped, so existing installs are patched on
their next PLAY and never twice), which GOG or Steam patch it takes, or that no
patch knows the build (a warning; the file stays as shipped). Patches download
once from `/files/cleaned-masters/<name>.vcdiff` into `downloads/cleaned-masters`
and are checked by sha256. The bundled `assets/xdelta/xdelta3.exe` is the mod's
own build, which refuses a source whose BLAKE3 differs from the one in the
patch; a stock xdelta3 would not. A real install (Portable Skyrim Mode off)
keeps the originals in `Data/Original ESMs backups`, like the mod's patcher.
The vanilla size check accepts a cleaned size, so it never reverts them.
On the automatic passes a failed download or patch is only a warning and the
file stays as shipped, so PLAY is never blocked; only **Repair Cleaned Masters**
reports it as an error.

## Repair tab

Settings > Repair replaces the old Installation tab. Every button deletes the
files of its section and restores them (`{ force: true }` over the same IPC as
the Play-button install): **Repair MO2** wipes MO2's own files (mods, downloads,
profiles, the game copy and the instance inis stay) and unpacks it again,
**Repair Game Copy** deletes and re-copies every vanilla file and deletes the
Creation files and the strays (the next install pass copies the Creations back
and cleans them), **Repair SKSE** deletes the root `skse64_*` exe and dlls and
the cached archive, then downloads and installs it again, **Repair Client
Files** under MO2 rebuilds only the manifest mods that carry the client plus the
root files and rewrites the settings (without a client mod, and in the direct
install, it deletes every packaged file and extracts the zip again), **Repair
Modlist** clears the caches, the Creation stamp and the stray overwrite files
and rebuilds every mod folder, **Repair Cleaned Masters** restores the original
masters and patches them again. Mod archives are reused when their sha256 checks
out and downloaded again only when missing or damaged. **Repair All** runs
MO2, Game Copy, Cleaned Masters, SKSE, Client Files and Modlist in that order; **Check Files** (`install:check`) is a read-only scan
that lists every missing/corrupt/extra/outdated file with the button that fixes
it. It compares client files by size + sha256 when `/api/files/version` carries
the `files[]` list written by the backend's `npm run merge`.

## Persistent store keys

| Key | Type | Purpose |
|-----|------|---------|
| `skyrimPath` | string | Path to the source Skyrim Special Edition directory |
| `baseDirPath` | string | Alduinak base dir: MO2 root, with the game copy at `<base>\skyrim` |
| `isolatedGame` | boolean | Play from the isolated game copy instead of `skyrimPath` |
| `mo2Enabled` | boolean | Launch the game through the managed portable MO2 |
| `activeServerId` | string | Id of the selected server in the cached list (`alduinak` by default; the first entry when it is gone) |
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
| GET | `/api/servers` | Server list `{ id, name, address, port, masterKey, online, maxPlayers, lastSeen }`, main server first |
| GET | `/api/status` | Online/offline + player count (`?server=<id>` for a server other than the main one) |
| GET | `/api/serverinfo` | Name, max players, lock status, auth config, load order (`?server=<id>` as above) |
| GET | `/api/news` | News cards |
| GET | `/api/modlist` | Mod list with Nexus links |
| GET | `/api/files/version` | Current client files version tag |
| GET | `/api/files/zip` | Client files bundle (ZIP download) |
| GET | `/api/install-manifest?schema=3` | Compiled MO2 modpack manifest; a manifest newer than the schema asked for answers 404 with an update-the-launcher message |
| GET | `/api/nexus-downloads` | File-pinned Nexus links page (opened in browser) |
| GET | `/api/version` | Launcher update check |
| GET | `/api/users/login-discord` | Starts Discord login (opened in browser) |
| GET | `/api/users/login-discord/status` | Polled for the completed session |

## Server lock

If the backend sets `locked: true`, the Play button is disabled for users whose Discord ID is not in `lockedAllowList`. Used during maintenance or testing periods.
