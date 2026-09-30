# MongoDB for the Alduinak world DB

The game server's mongo driver is already compiled into `scam_native.node`, so
no CI rebuild is needed. You only need MongoDB installed and running, then a
one-shot migration.

## Files here

- `mongod.cfg` - mongod config (loopback only, auth enabled, data under `C:\Alduinak\mongodb`).
- `setup-mongodb.ps1` - **run yourself, elevated.** Installs MongoDB, registers
  the `AlduinakMongo` service against `mongod.cfg`, and creates the `skympuser`
  app user. Installs mongosh and the Database Tools (mongodump/mongorestore)
  when they are missing. Claude does not run installers or register services.
- `wipe-world.js` - backup, verify, apply and restore for a full world wipe
  before a deploy. Runbook: [`docs/docs_database_wipe.md`](../../docs/docs_database_wipe.md).
- `forbidden-items.py` + `strip-inventories.js` - one-time strip of gear above
  Adept, jewelry, spell tomes, scrolls, staves, enchanted gear and learned spells
  (abilities stay) from characters and claimed containers. Run
  `python deploy/mongodb/forbidden-items.py --plugin <staged AlduinakAdditions.esp>`
  to write `forbidden-items.json` for the live load order, then
  `node deploy/mongodb/strip-inventories.js` (plan), `backup --out <dir>`, and
  `apply --backup <dir> --apply` with the game server stopped; `restore --backup <dir> --apply` undoes it.
  `strip-common.js` holds the parts it shares with the restore below.
- `restore-stripped-items.js` + `strip-intent.py` / `strip-intent.json` - gives back
  what the 2026-09-28 strip took beyond what was meant (runbook below). Test:
  `node deploy/mongodb/test/test-restore-stripped-items.js`.

## Giving back what the 2026-09-28 strip took too far

The strip was meant to take ebony equipment, spell tomes, learned spells and
Falmer chest armour only. `restore-stripped-items.js` reads its backup
(`Desktop\alduinak-r13\rollback-strip`, left untouched) and gives everything
else back:

- It repeats the strip's own rule on each backed up document (it must match
  the strip's plan report for every document) and, per base id, gives
  `min(removed, backup total - current total)`, counting every variant of the
  item. An item an admin or a trade already returned is not given twice, and
  no entry is ever lowered or removed. The data cannot tell a return from a
  new copy, so any copy held now counts as returned, also one crafted,
  looted or bought since the strip and also in the same document
  (`--per-document` does not change that); `--ignore-held '0x0003B97C'`
  gives an id back in full, not counting held copies. It also caps each profile at what it
  lost less what its characters, their pets (stored saddlebags, or the actor
  of a pet out in the world) and its claimed containers hold now, so a return
  moved to a chest, a pet or another character counts too (`--per-document`
  counts only the document and a character's own pets). Known limit: a return
  since sold, used, dropped, given to someone else, or left in a chest the
  profile no longer claims or on a deleted character is not seen and comes
  back again.
- An apply settles every item id it decided for each document it reached,
  given or already back at the time, and later runs never give that id to
  that document again (a return it counted and the player sold since stays
  settled); only an id decided differently later, such as a new
  `--also-give`, comes back. The apply logs each write
  (`restore-applied.log` beside its record), so after an apply that stopped
  part way the next `plan` gives the documents it never wrote and names them.
- Given items reuse the backup's own entries (enchantment, tempering,
  poison), come back unequipped, and are written with `$set` of
  `inv.entries` only. Learned spells, `equipmentDump` and spell slots are
  never touched.
- `strip-intent.json` sorts every removed id from the plugin data: an ebony
  material keyword, a book that teaches a spell, or a body-slot armour with a
  Falmer keyword or model folder stays removed. It also keeps each item's
  in-game name (where the plugin stores it inline) and crafting recipe, so
  the report names what a material keyword covers when the names do not say
  it (the daedric keyword on Ancient Nord armour), names what stays removed,
  and lists gear whose recipe takes ebony ingots without an ebony keyword
  (Einherjar, Nordic Carved, the Black Dragon Ninjato) as one decision. It also carries the part of
  the strip's list the backup needs (the full list, sha 3c3871dd, was rebuilt
  with `forbidden-items.py` from the professions plugin b843723d in
  `alduinak-r13\esp\professions` and the 89-plugin load order).
- Every run first checks the Data folder of the server settings: the strip's
  plugins must keep their light flags (the backup's form ids depend on them)
  and the plugins behind the removed items (their defining plugin, winning
  override and template) must be byte for byte the ones `strip-intent.json`
  was made from. When one changed (a plugin update, a CK save), it refuses
  and asks for `python deploy/mongodb/strip-intent.py`, which sorts the
  items again from the plugins as they are now, reusing the part of the list
  it already holds (`--list` takes the full list instead); then take a new
  backup.
- Owner overrides go on every command of a run (plan, backup, apply):
  `--also-give 0x0002AC61` returns an id that stays removed, `--also-keep 0x26005565`
  keeps one removed. Several ids go in one quoted list, each flag once:
  `--also-give '0x000139BF,0x0002AC61'` (PowerShell turns an unquoted list into
  decimal numbers, which the script refuses, as it refuses any id the strip did not remove).
- Reports and backups go to `Desktop\alduinak-r13\restore-strip`.

Run from the repo root in PowerShell, in this order. MongoDB must be running
and the game server stopped; the scripts read the connection from
`build\dist\server\server-settings.json`, so no password is typed.

```
cd C:\Users\Administrator\Desktop\alduinak
Get-Service AlduinakGameServer
node deploy/mongodb/restore-stripped-items.js plan
Get-ChildItem C:\Users\Administrator\Desktop\alduinak-r13\restore-strip\restore-plan-*.txt | Sort-Object LastWriteTime | Select-Object -Last 1 | ForEach-Object { notepad $_.FullName }
node deploy/mongodb/restore-stripped-items.js backup --out C:\Users\Administrator\Desktop\alduinak-r13\restore-strip\rollback-1
node deploy/mongodb/restore-stripped-items.js apply --backup C:\Users\Administrator\Desktop\alduinak-r13\restore-strip\rollback-1
node deploy/mongodb/restore-stripped-items.js apply --backup C:\Users\Administrator\Desktop\alduinak-r13\restore-strip\rollback-1 --apply
node deploy/mongodb/restore-stripped-items.js plan
```

`Get-Service` must say Stopped, and nobody edits a character in the Server
Manager until the last `plan`. The apply checks the game server again right
before its first write and writes a document only while its inventory is
still what it read, so it stops (roll back, take a new backup) rather than
overwrite a change made in between. Read the summary before the backup: per
character and container it lists what comes back, what is already back and
what stays removed, and "FOR THE OWNER TO DECIDE" lists the calls to make. The first `apply`
is a dry run; it refuses if a document changed since the backup (take the
backup again into `rollback-2` and use that name from there on). The last
`plan` is the check: "comes back: 0 items".

To undo the apply, do it before the game server is started again: the
rollback puts back only documents that still hold what the apply wrote
(entry order and number types may differ) and refuses as a whole once any of
them gained or lost an item, which the first login or save can do. With
`--skip-changed` it rolls back the others and leaves the changed ones as
they are, keeping what the apply gave (they stay settled; the ones rolled
back come back in the next `plan`). Dry run first, then:

```
node deploy/mongodb/restore-stripped-items.js restore --backup C:\Users\Administrator\Desktop\alduinak-r13\restore-strip\rollback-1
node deploy/mongodb/restore-stripped-items.js restore --backup C:\Users\Administrator\Desktop\alduinak-r13\restore-strip\rollback-1 --apply
```

`preview` runs with no database at all and shows the upper bound (as if
nothing had been returned).

## Steps

1. Run the setup (elevated PowerShell), choosing a strong password:
   ```
   powershell -ExecutionPolicy Bypass -File deploy\mongodb\setup-mongodb.ps1 -Password "YourStrongPassword"
   ```
2. Run the migration and switch the driver: follow
   [`docs/alduinak_mongodb_migration.md`](../../docs/alduinak_mongodb_migration.md)
   (URL-encode reserved password characters in the `databaseUri`).
3. In `server-manager/`, run `npm install` so the manager's Mongo-aware
   character reader can load the `mongodb` client.

## Notes

- The manager's Players tab reads characters directly from the world DB. Once
  the server is on the mongodb driver, set the same `databaseDriver` /
  `databaseName` / `databaseUri` in the settings the manager reads
  (`build/dist/server/server-settings.json`) so the manager queries Mongo too.
- Keep MongoDB bound to `127.0.0.1`. Nothing external should reach 27017.
