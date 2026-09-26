# Launch Wipe, Lock and Daily Restart

The r13 launch window: deploy everything, wipe the world with backups, lock the server
to staff, boot it, then install the agent that runs the daily 04:00 restart. Do the
steps in this order, in one sitting. The tool and its safety checks are described in
[docs_database_wipe.md](docs_database_wipe.md); this page is the order for this window.

Run every command from an elevated PowerShell in `C:\Users\Administrator\Desktop\alduinak`.

## 1. Deploy first

Everything from r13 must be live before the wipe, because the wipe is the last one:

- Build server, Build Client and Build launcher in the manager, plus the CI flatrim
  build (or Native) if any C++ changed.
- Before Build launcher, set the launcher version in the manager's Launcher tab (it
  writes `skymp5-launcher-tauri\src-tauri\tauri.conf.json` only). The build leaves
  `build\launcher\AlduinakLauncher.exe` where nginx serves `/downloads/`, which is
  the `launcherUrl` every launcher updates from, and only then writes `launcher` in
  `skymp5-backend\data\versions.json`, so players update once the new exe is served.
- The plugin copies in the MO2 mod, the GOG `Data` folder and `build\dist\client\Data`,
  then **Update manifest**, **Sync server settings** and **Sync data folder**.
- Every live-file change of the round (gamemode extensions, `server-settings.json`,
  `manifest-sources.json`).
- Any new per-character store added in r13 must already be classified in
  `deploy\mongodb\wipe-world.js`: a server-folder file in `SERVER_RESET` (or
  `SERVER_KEEP` if it is not per character), a backend file in `BACKEND_RESET`. apply
  refuses unknown server-folder entries, but an unknown backend file survives
  silently.

If the daily restart is already running (section 6 done earlier), keep the window
outside 03:00 to 04:30 box time, or set `AUTO_RESTART_AT=off` in
`skymp5-backend\.env` until the end.

## 2. Stop and back up

1. Announce the window in Discord: every character is wiped.
2. In the manager stop **Game**, then **Backend**. Leave `AlduinakMongo` running.
3. Keep the game server from booting half-deployed:
   ```
   & C:\tools\nssm\nssm.exe set AlduinakGameServer Start SERVICE_DEMAND_START
   ```
4. Back up. Always pass the folder: the tool's default root
   (`Desktop\alduinak-overnight-2026-09-11`) no longer exists.
   ```
   $dir = "C:\Users\Administrator\Desktop\alduinak-r13\rollback-wipe-$(Get-Date -Format yyyyMMdd-HHmm)"
   node deploy\mongodb\wipe-world.js backup --out $dir
   ```
   Note the counts it prints.
5. Prove the backup restores:
   ```
   node deploy\mongodb\wipe-world.js restore --backup $dir --test
   ```
   It must print `restore test ok`. If not, stop here: nothing has changed yet.
6. Read the report:
   ```
   node deploy\mongodb\wipe-world.js verify --backup $dir
   ```

## 3. Wipe

1. Dry run, then the real run:
   ```
   node deploy\mongodb\wipe-world.js apply --backup $dir
   node deploy\mongodb\wipe-world.js apply --backup $dir --apply
   ```
   The dry run must list the `changeForms` drop, the state file resets, the
   `characters.json` reset, the faction rank assignments and the log move, with no
   `REFUSED` line. The real run ends with `wipe done and re-read` and names the
   `C:\logs\pre-wipe-<stamp>` folder the moderation logs moved to.
2. Move the stale `C:\Users\Administrator\Desktop\logs\faction.log` (a leftover from
   before `BAN_LOG_DIR=C:\logs`) into that `pre-wipe-<stamp>` folder by hand.
3. Run `node deploy\mongodb\wipe-world.js verify` again. If it says a purge is pending,
   run **Modlist, Purge MongoDB** in the manager once as a dry run and once to apply,
   so the start gate opens.

Bans, profiles, players, role permissions, news, the manifest state, sessions and all
settings are kept. A game boot between the backup and apply makes apply refuse; take a
new backup then.

## 4. Lock

Lock the server to Jarls (`1521707092212191333`), Admins (`1521259484859863190`) and
Developers (`1521259396481421475`). In `skymp5-backend\.env`:

```
SERVER_LOCKED=true
SERVER_LOCKED_ROLE_IDS=1521707092212191333,1521259484859863190,1521259396481421475
SERVER_LOCKED_ALLOW=
```

Leave `WHITELIST_ROLE_ID` as it is (it is ignored while locked). The backend reads
`.env` at start, so this takes effect with the start in section 5.

The dashboard's **Server Access** tab does the same without a restart, but saving it
writes `skymp5-backend\data\server-access.json`, which then overrides these three
`.env` keys for good. Use one of the two; the default is `.env`.

Holders of only another staff role get `serverLocked`. If the bot cannot reach Discord,
everyone is refused while locked (it fails closed).

## 5. First boot

1. Start **Backend**, then **Game** from the manager (its Start runs the purge gate and
   archives the logs).
2. `C:\logs\gameserver.log` shows `loaded 0 ChangeForms (Including 0 player characters)`,
   `[housing] ready, 0 claimed refs in the registry` and the zone spawns loaded.
3. Dashboard, **Server Access**, check one Discord id each: a Jarl, an Admin and a
   Developer are Allowed, a plain member is `serverLocked`.
4. In the launcher a staff member sees PLAY enabled and the lock badge; a plain member
   sees *Server is currently locked*.
5. A staff member makes a new character: the synopsis, the spawn choice and the starter
   kit (the clothes; the gold comes with the first profession) appear, and
   `starter-grants.json` gains one key.
6. The hashes of `bans.json`, `profiles.json` and `role-permissions.json` equal the
   copies in `$dir\backend-data` (`Get-FileHash`).
7. Back to automatic start:
   ```
   & C:\tools\nssm\nssm.exe set AlduinakGameServer Start SERVICE_AUTO_START
   ```
8. Copy `$dir` off the box ([docs_database_wipe.md](docs_database_wipe.md) section 5).

Rollback: [docs_database_wipe.md](docs_database_wipe.md) section 4B,
`restore --backup $dir [--with-settings] --apply`.

## 6. Install the agent (daily restart)

The daily 04:00 restart with its warnings runs inside the `AlduinakManager` agent, which
is not installed on this box yet. One time:

1. Generate a secret and add it to `skymp5-backend\.env`:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   ```
   MANAGER_AGENT_SECRET=<the 64 hex characters>
   ```
   `AUTO_RESTART_AT` can stay unset (04:00 box time, Pacific). `off` disables it.
2. Restart **AlduinakBackend**.
3. Run `server-manager\Setup-Agent.bat` (it asks for admin rights and installs
   `AlduinakManager`). In the nssm editor's **Log on** tab choose *This account*,
   `.\Administrator` and the password, then *Edit service*. Start it:
   `& C:\tools\nssm\nssm.exe start AlduinakManager`.
4. `C:\logs\manager-agent.log` shows `[schedule] next daily restart at ...`. The
   dashboard **Server** tab shows *Agent online*.

From then on, every day the game gets `say` warnings 1 hour, 30, 10, 5, 4, 3, 2 and 1
minutes before 04:00, then restarts as a *Daily restart* job, and its logs, the chat,
admin and other game logs and the backend's `ban.log` and `faction.log` move into
`C:\logs\YYYY-MM`. See [docs_web_server_manager.md](docs_web_server_manager.md),
*Daily restart*.

## 7. Opening up

When the server opens to everyone: `SERVER_LOCKED=false` in `.env` and restart the
backend (or untick it in the dashboard if you locked it there). Players already online
stay until they relog.
