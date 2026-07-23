# MongoDB for the Alduinak world DB

The game server's mongo driver is already compiled into `scam_native.node`, so
no CI rebuild is needed. You only need MongoDB installed and running, then a
one-shot migration.

## Files here

- `mongod.cfg` - mongod config (loopback only, auth enabled, data under `C:\Alduinak\mongodb`).
- `setup-mongodb.ps1` - **run yourself, elevated.** Installs MongoDB, registers
  the `AlduinakMongo` service against `mongod.cfg`, and creates the `skympuser`
  app user. Claude does not run installers or register services.

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
