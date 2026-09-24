# Database Wipe Before a Deploy

A world wipe removes every character and all saved world state, then starts the
server on an empty database. We use it instead of a changeForm migration when a
load-order change would otherwise need one. The r11 CC content shifts
`AlduinakAdditions.esp` from slot `0x2B` to `0x2D`, and the same runbook covers
the pre-launch wipe.

The tool is `deploy/mongodb/wipe-world.js`. It runs from source with node, so
nothing needs building. The manager's **Purge MongoDB** cannot do this job. It
only deletes documents from removed plugins and remaps shifted ids, it refuses
whenever a player character is affected, and it never touches the JSON state
files. The runbook still uses it once, on the empty collection, to stamp
`purgedAt` so the manager will start the game server again.

## 1. What the wipe changes

| Store | What happens |
|---|---|
| MongoDB `skymp.changeForms` | **Dropped.** This removes characters, inventories, spells, mastery, knowledge, stored pets, housing claim records, bounty notes, container and flora state, runtime NPCs, and every per-character dynamic field (`private.jobs` trip counters, the `private.writings` counter, faction stamps). |
| `build/dist/server/housing.json`, `zone-spawns.json` | Reset to `[]` |
| `build/dist/server/companions.json` | Reset to `{"active":[],"corpses":[],"stored":[]}` |
| `build/dist/server/pets.json` | Reset to `{"active":[],"released":[]}` |
| `build/dist/server/bodies.json` | Reset to `{"bodies":[]}`. It lists the bodies PKs left; a stale entry is dropped at boot anyway |
| `build/dist/server/starter-grants.json` | Reset to `{}`. The starting kit is the clothes and the gold comes with the first profession, so the ledger only matters when `startingItems` carries gold |
| `build/dist/server/gathering-picks.json` | Reset to `{}`. It lists picked nirnroot and critters waiting to grow back, and their hidden state goes with the dropped changeForms |
| `build/dist/server/weather-state.json` | Reset to `{}`, so every region rolls a fresh weather on the next boot |
| `build/dist/server/writings/` | Emptied. Document ids restart with the wiped counter, so old files would collide with new ones. |
| `skymp5-backend/data/characters.json` | Reset to `{}` (it names wiped characters) |
| `skymp5-backend/data/faction-whitelist.json` | `assignments` cleared. `factions`, `requirements` and the `retired` ids are kept. |
| `C:\logs` `admin`, `ban`, `bounty`, `chat`, `faction`, `pk`, `pvp` and `trading` logs, plus their rotated copies in the log root and in the `C:\logs\YYYY-MM` archive folders | Moved into `C:\logs\pre-wipe-<yyyyMMdd-HHmm>\`. Archived copies keep their `YYYY-MM` subfolder. New characters reuse the old `0xff` ids, so pre-wipe log lines would point at the wrong people. |

**Kept, untouched:**
- **Server folder:** `server-settings.json` (you edit one value by hand in step 10), the `NPC-Spawns.json` zone definitions, `Jobs.json` job definitions, `faction-access.json`, the optional `weather-regions.json` region list, the `alert-keywords.json` Discord keyword list, the gamemode, plugins and `data/`.
- **Backend data:** `bans.json`, `profiles.json`, `players.json`, `role-permissions.json`, `news.json`, the install manifest files and `manifest-diff.json`. Only Purge MongoDB changes `manifest-diff.json`.
- **Sessions:** `sessions.json`, `auth-states.json` and `dashboard-sessions.json` are never copied, changed or restored.
- **Outside the repo:** Discord roles and `adminRoleIds` (staff rights come back at login), the service logs (`gameserver`, `backend` and the rest) and their archived copies in `C:\logs\YYYY-MM`.

World state that staff set by console also goes with the drop, such as opened
doors or filled containers. Recreate anything that matters after the first boot.

## 2. The tool

Run every command from the main checkout: `cd C:\Users\Administrator\Desktop\alduinak`.

| Command | What it does |
|---|---|
| `node deploy\mongodb\wipe-world.js backup` | Dumps the database with `mongodump`, copies the state files and backend data, writes `wipe-backup.json` and `SHA256SUMS.txt`, and prints document counts per class. |
| `node deploy\mongodb\wipe-world.js restore --backup "<dir>" --test` | Restores the dump into the throwaway collection `skymp.wipeRestoreCheck`, compares counts and `_id`s with the backup and the live collection, then drops it. |
| `node deploy\mongodb\wipe-world.js verify [--backup "<dir>"] [--order <plugins.txt>]` | Read-only report on services, collection counts, state files, form ids sitting in shifted slots (with the value each must become) and the Purge MongoDB stamp. |
| `node deploy\mongodb\wipe-world.js apply [--backup "<dir>"]` | Dry run: prints the plan and every reason it would refuse. Without `--backup` it uses the newest `rollback-wipe-*` folder and prints which one. |
| `node deploy\mongodb\wipe-world.js apply --backup "<dir>" --apply` | Runs the wipe: saves the current `manifest-diff.json` into the backup, repeats the restore test, drops `changeForms`, resets the files and moves the logs. |
| `node deploy\mongodb\wipe-world.js restore --backup "<dir>" [--with-settings] [--apply]` | Puts a backup back (a dry run without `--apply`). With `--apply` it first backs up the live data into `pre-restore-<yyyyMMdd-HHmmss>`. `--with-settings` also restores `server-settings.json` and the manifest state for a full revert. |

**Guards:**
- **Game server:** `backup`, `apply --apply` and `restore --apply` refuse unless `AlduinakGameServer` reports `SERVICE_STOPPED` (nssm, then `sc query`) and no process holds `scam_native.node`.
- **Backend:** those modes also refuse while `AlduinakBackend` runs, unless you pass `--backend-running`.
- **Checked backup:** `apply` refuses unless:
  - every file matches `SHA256SUMS.txt` and nothing unlisted was added;
  - the dump holds as many documents as `wipe-backup.json` records;
  - the live `changeForms` count still equals the backup's;
  - every file it resets still equals its backup copy (or is already reset).
  If something wrote after the backup, such as a game server boot, take a new backup.
- **Live data before a restore:** `restore --apply` first runs a full backup of the live database and files into `<backup root>\pre-restore-<yyyyMMdd-HHmmss>` and stops if that backup fails, so characters made after the wipe survive a revert. `apply` never picks these folders on its own.
- **Unknown stores:** `apply` refuses on a collection other than `changeForms`, or on a server folder entry it has no rule for. Add the store to `DB_DROP`/`DB_KEEP` or `SERVER_RESET`/`SERVER_KEEP` in the script, or name extra keeps in `ALDUINAK_SERVER_KEEP` (the same variable Build server honours).
- **Connection string:** the `databaseUri` never reaches a command line or the console. `mongodump` and `mongorestore` read it from a temporary `--config` file in `%TEMP%` that is deleted when they finish, and all error text is sanitized.
- **Backup location:** a backup inside the repository or the server folder is refused.

**Backup folder** (default `C:\Users\Administrator\Desktop\alduinak-overnight-2026-09-11\rollback-wipe-<yyyyMMdd-HHmm>`, or `--out <dir>`):

```
wipe-backup.json      counts per collection and class, load order with light flags, git HEAD
mongodump\skymp\      changeForms.bson and its metadata
server\               housing, zone-spawns, companions, pets, starter-grants, writings\,
                      server-settings.json, NPC-Spawns.json, Jobs.json, faction-access.json,
                      weather-regions.json
backend-data\         everything in skymp5-backend\data except sessions, auth states and *.bak copies
post-sync\            manifest-diff.json as it was at apply time (added by apply)
SHA256SUMS.txt
```

`restore --apply` writes `pre-restore-<yyyyMMdd-HHmmss>` folders with the same layout next to the wipe backups.

**Environment overrides:**
- `ALDUINAK_MONGO_TOOLS`: the Database Tools bin folder (default `C:\Program Files\MongoDB\Tools\100\bin`)
- `ALDUINAK_WIPE_BACKUP_ROOT`: the backup root
- `ALDUINAK_LOG_DIR`: the log folder, which is otherwise `logDir` in the settings or `C:\logs`

## 3. Deploy window runbook

Do the steps in this order, in one sitting. The game server stays stopped until step 12.

1. **Announce the outage.** Post a fixed window in Discord and say that every character is wiped. While the backend is stopped, the website, the dashboard and the launcher checks are down too.

2. **Stop the services and switch the game server to manual start.**
   - In the manager, stop **Game**, then **Backend**. Leave `AlduinakMongo` running.
   - Set manual start, so a reboot or crash-restart cannot boot a half-deployed server:
     ```
     & C:\tools\nssm\nssm.exe set AlduinakGameServer Start SERVICE_DEMAND_START
     & C:\tools\nssm\nssm.exe get AlduinakGameServer Start      # SERVICE_DEMAND_START
     ```

3. **Back up.**
   ```
   node deploy\mongodb\wipe-world.js backup
   ```
   - Write down the folder it prints.
   - Check that the counts look right. On 2026-09-16 there were 3,922 documents: 29 player characters on 29 profiles, 109 runtime actors, 132 runtime objects and 3,652 plugin references.
   - Take the usual code snapshot for the r11 rollback folder too: `dist_back`, `scam_native.node`, the client zip, the launcher, the plugin copies and `plugins.txt`.

4. **Verify the backup with a restore test.**
   ```
   node deploy\mongodb\wipe-world.js restore --backup "<dir>" --test
   ```
   It must print `restore test ok: N documents restored, the same N _ids as the live changeForms`. If it fails, stop here: nothing has changed yet.

5. **Build.** Run the r11 builds: Build server, Build Client, Build launcher, and Native if any C++ changed. Builds never touch MongoDB, and Build server keeps the state files.

6. **Copy the plugins and CC files.**
   - Copy the new `AlduinakAdditions.esp` and the CC plugin files into the MO2 mod folders, the GOG `Data` folder and `build\dist\client\Data`, and update `plugins.txt`, following the r11 CC content notes.
   - Optional preview of the ids that will move:
     ```
     node deploy\mongodb\wipe-world.js verify --order C:\MO2\profiles\Alduinak\plugins.txt
     ```

7. **Update the manifest.** In the manager, run **Modlist, Build manifest** with the backend still stopped. The log must show `AlduinakAdditions.esp full 0x2B -> full 0x2D` and `purgeNeeded`, with no `light flag unknown` warning. That warning makes Purge MongoDB refuse later.

8. **Sync the settings and data.** Run **Sync server settings** (it writes `loadOrder`), then **Sync data folder**.

9. **Apply the wipe.**
   ```
   node deploy\mongodb\wipe-world.js apply --backup "<dir>"
   node deploy\mongodb\wipe-world.js apply --backup "<dir>" --apply
   ```
   - Read the dry-run plan first. It must list the drop, the file resets and the log move, and no `REFUSED` line.
   - The real run repeats the restore test before the drop and ends with `wipe done and re-read`.

10. **Edit hunterOverDraw by hand.**
    ```
    node deploy\mongodb\wipe-world.js verify --backup "<dir>"
    ```
    - Under `form ids in shifting slots`, each `EDIT` line names the setting and the value it must become. For r11, `damageMultConditionalFormulaSettings.hunterOverDraw.conditions[0].parameter1` goes from `0x2B002032` to `0x2D002032`.
    - Edit `build\dist\server\server-settings.json` in an editor that saves UTF-8 without a BOM, such as VS Code or Notepad++. Do not use PowerShell `Set-Content`.
    - Fix any `EDIT` lines for `NPC-Spawns.json` or `Jobs.json` the same way.
    - Re-run verify until it prints `every stored form id matches the new load order`.

11. **Stamp purgedAt.** In the manager, click **Modlist, Purge MongoDB** once for the dry run, which should say `Nothing to purge` or `scanned 0`. Click it again to apply, which records the diff as purged.
    - `verify` must now print `stamped, the start gate is open`.
    - If Purge refuses with `unknown light flag`, fix the plugin file and run Build manifest again. Never bypass the gate by starting the service from `services.msc`.

12. **First boot.** Start **Backend**, then start **Game** from the manager. The manager's Start runs the gate check and rotates the service logs.

13. **Check after boot.**
    - **Boot log** (`C:\logs\gameserver.log`):
      - `loaded 0 ChangeForms (Including 0 player characters)`
      - `[housing] ready, 0 claimed refs in the registry`
      - no `from the previous run` lines for companions or pets
      - `NpcSpawnSystem: 125/125 zone(s) loaded`
      - no espm errors and no `unknown editor ids`
    - **In game:**
      - A new character sees the synopsis and the spawn list.
      - The starting inventory is the two clothing pieces (the gold comes with the first profession), and `starter-grants.json` holds one key.
      - A hunter with Over Draw deals 1.2x bow damage to NPCs.
      - Claiming a property adds one id to `housing.json`, and the lock survives a relog.
      - A summoned pet appears in `pets.json` `active`.
      - The CC items work.
    - **Tool:** run `node deploy\mongodb\wipe-world.js verify`. It should show exactly the test characters under `player characters`, and `every descriptor names a plugin in the live load order`.
    - **Backend:**
      - The hashes of `bans.json`, `profiles.json` and `role-permissions.json` equal the copies in `<dir>\backend-data` (`Get-FileHash`).
      - A Discord-role admin gets `/admin` in game and can log in to the dashboard.
      - `/api/version` reports the r11 versions.

14. **Close the window.**
    ```
    & C:\tools\nssm\nssm.exe set AlduinakGameServer Start SERVICE_AUTO_START
    & C:\tools\nssm\nssm.exe get AlduinakGameServer Start      # SERVICE_AUTO_START
    ```
    Record the backup folder and counts in `DEPLOY.md`, then announce that the server is open.

## 4. Rollback

**A. Fix forward (recommended).** Keep the wiped database, fix the problem and
deploy again. The beta data is wiped again before launch anyway, and nothing
needs restoring.

**B. Full revert from the backup.** Use this only if the r11 plugin set cannot
run at all. Characters created after the wipe leave the live server, and only
the pre-restore copy keeps them.
1. Stop Game and Backend, and keep the game server on manual start.
2. You do not need a separate backup first. `restore --apply` saves the live data, including characters made after the wipe, into `pre-restore-<stamp>` before it changes anything, and prints the folder. To undo the revert, restore that folder the same way.
3. Dry run, then apply:
   ```
   node deploy\mongodb\wipe-world.js restore --backup "<dir>" --with-settings
   node deploy\mongodb\wipe-world.js restore --backup "<dir>" --with-settings --apply
   ```
   This puts back:
   - `changeForms`, the registries, `writings\`, `characters.json` and `faction-whitelist.json`
   - `server-settings.json` (the live copy is kept as `server-settings.json.pre-restore-<stamp>`)
   - `install-manifest.json` and its `.prev`, `manifest-diff.json`, `manifest-sources.json`, `modlist.json`, `data-sync.json` and `files-version.json`

   Session files are never restored, so players log in again.
4. Put back the pre-r11 plugin copies and `plugins.txt`. Remove the CC files from MO2, the GOG `Data` folder and `build\dist\client\Data`. Restore the code snapshot (`dist_back`, `scam_native.node`, the client zip and the launcher).
5. If you want the old moderation logs back, move the contents of `C:\logs\pre-wipe-<stamp>\` into `C:\logs`. Its `YYYY-MM` subfolders merge into the archive folders of the same name.
6. Run `node deploy\mongodb\wipe-world.js verify`. It must say the loadOrder matches the manifest and must not say `NEEDS STAMP`. Then start the services and set auto start (step 14). Players relaunch.

**C. Keep r11 and migrate the old characters (not recommended).**
1. Run `restore --backup "<dir>" --apply` without `--with-settings`.
2. Copy `<dir>\post-sync\manifest-diff.json` over `skymp5-backend\data\manifest-diff.json` and set its `purgedAt` to `null`.
3. Run Purge MongoDB as a dry run, then apply.

This only works with the post-sync diff that apply saved. Any later Build manifest writes a diff that no longer holds the old load order, and `private.mastery.granted` ids stay stale unless the purge learns to remap them.

## 5. Keeping a copy off the box

The backup lives on `C:`, the only disk on this box. It holds:
- Discord ids
- IP addresses and HWIDs (`players.json`, `bans.json`)
- the `server-settings.json` secrets: database URI, bot token, master keys and LiveKit keys

It never holds session or auth-state files.

After the window, make a redacted, encrypted copy and download it:

```
$B = '<dir>'
$O = "$env:TEMP\wipe-offbox\" + (Split-Path $B -Leaf)
New-Item -ItemType Directory -Force (Split-Path $O) | Out-Null
Copy-Item -Recurse $B (Split-Path $O)
node -e "const f=require('fs'),c=require('crypto'),d=process.argv[1],p=d+'/server/server-settings.json';if(f.existsSync(p)){const s=JSON.parse(f.readFileSync(p,'utf8'));for(const k of ['databaseUri','masterKey','masterApiAuthToken','metricsAuth','discordAuth','voiceChat'])if(k in s)s[k]='<redacted>';f.writeFileSync(p,JSON.stringify(s,null,2)+'\n');const h=c.createHash('sha256').update(f.readFileSync(p)).digest('hex'),q=d+'/SHA256SUMS.txt';f.writeFileSync(q,f.readFileSync(q,'utf8').replace(/^[0-9a-f]{64}(?=  server\/server-settings\.json)/m,h))}" "$O"
& 'C:\Program Files\7-Zip\7z.exe' a -t7z -mhe=on -p "$HOME\Desktop\$(Split-Path $O -Leaf).7z" "$O"
```

- **Commands:**
  - `-p` with no value makes 7-Zip ask for the password, which keeps it off the command line.
  - `-mhe=on` also encrypts the file names.
- **Settings:** the node line replaces the settings secrets with `<redacted>` and updates that file's line in `SHA256SUMS.txt`, so the copy still passes the checksum check.
- **Password:** keep it in a password manager, never on the box.
- **Storage:** download the `.7z` to your own machine. Never put it on a shared drive or post it in Discord.
- **Clean-up:** delete `%TEMP%\wipe-offbox` and the `.7z` on the Desktop once the download is confirmed.
- **Restoring from the copy:** it restores like any backup. After `--with-settings`, copy the credentials back from the `server-settings.json.pre-restore-<stamp>` file the restore keeps.
- **Retention:** keep the box copy and the download until the pre-launch wipe is done, then delete both. Any `pre-restore-*` folder holds the same kind of data, so treat it the same way.
