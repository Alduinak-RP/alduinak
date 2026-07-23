# Alduinak: migrate the world DB from `file` to MongoDB

The `file` driver rewrites the whole dirty-changeform batch as individual
`.json` files every save cycle (hundreds of file renames while holding the save
mutex). MongoDB batches the same save into one bulk upsert, so large or busy
worlds stop stalling on disk I/O.

**No CI rebuild is needed.** The current `scam_native.node` already has the
mongo-cxx driver statically linked in (verified: `mongocxx`/`mongoc`/`bsoncxx`
symbols present, the `NO_MONGO` "not supported" path is absent). You only need
MongoDB installed and running on the box.

## 0. Prerequisites (operator steps)

MongoDB is **not** installed on the live box yet. Install MongoDB Community
Server for Windows and start `mongod` (default `127.0.0.1:27017`). The server
does **not** create Mongo auth users - you create the `skymp` user manually
with `mongosh` (below). Back up the current world first:

```
xcopy /e /i "build\dist\server\world" "build\dist\server\world-backup-YYYYMMDD"
```

The live `world/` today is ~900 changeform files (~1.2 MB), so migration is
quick.

## 1. Create the Mongo user

In `mongosh` (connected as an admin), create the app user. Pick a strong
password; if it contains any of `@ : / ? # [ ] % &` you must URL-encode it in
the URI later (e.g. `MyPass@123` -> `MyPass%40123`).

```javascript
use admin
db.createUser({
  user: "skympuser",
  pwd: "REPLACE_WITH_STRONG_PASSWORD",
  roles: [ { role: "readWrite", db: "skymp" }, { role: "dbAdmin", db: "skymp" } ]
})
```

## 2. Run the one-shot migration

Stop the game service, then set `databaseDriver` to `migration` in
`build/dist/server/server-settings.json`. The migration driver reads the old
(file) DB, upserts everything into the new (mongo) DB in chunks, then exits the
process. It refuses to run if the new DB is not empty, so it is safe to re-run.

Add (URL-encode the password in `databaseUri`):

```json
  "databaseDriver": "migration",
  "databaseOld": {
    "databaseDriver": "file",
    "databaseName": "world"
  },
  "databaseNew": {
    "databaseDriver": "mongodb",
    "databaseName": "skymp",
    "databaseUri": "mongodb://skympuser:PASSWORD@127.0.0.1:27017/skymp?authSource=admin"
  }
```

Start the game server once (from `build/dist/server`, CWD matters). It migrates,
logs completion, and exits on its own. Watch `gameserver.log` for the migration
lines and a clean exit.

## 3. Switch to the mongodb driver for good

Replace the migration block above with the plain mongodb driver. Note
`authSource` moves from `admin` (where the user was created) to `skymp` for
normal operation if you granted the roles on `skymp`; keep `admin` if that is
where the credentials live - match whatever `mongosh` accepted in step 1:

```json
  "databaseDriver": "mongodb",
  "databaseName": "skymp",
  "databaseUri": "mongodb://skympuser:PASSWORD@127.0.0.1:27017/skymp?authSource=admin"
```

Restart the game service. Done. The `world/` directory is now dormant (keep the
backup until you have confirmed a few sessions save/load correctly against
Mongo).

## Gotchas

- `server-settings.json` is gitignored and holds live secrets; edit it directly
  on the box, do not commit it, and do not commit the derived
  `server-settings-dump.json` / `server-settings-merged.json`.
- **Server Manager caveat:** the manager's player/character listing currently
  reads the `file` driver layout (`world/` JSON files) directly. After the Mongo
  switch that tab will not reflect live data until the manager is taught to read
  Mongo. Flagged as a follow-up; it does not affect the game server.
- URL-encode reserved characters in the password inside `databaseUri` only; the
  `mongosh` `createUser` call takes the raw password.
- If migration says "newDatabase is not empty, skipping", the `skymp` DB already
  has changeforms - drop the collection (or use a fresh `databaseName`) before
  re-running.
