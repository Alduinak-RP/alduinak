# Test Server profile

The Test Server is the place everything is edited and built (`docs/docs_test_server.md`).
It lives next to the live server on the same box with its own folders, world database,
LiveKit, console relay port, logs and client files. Live only receives files through the
Server Manager's **Migrate** box.

## Files here

- `setup-testserver.ps1` - **run yourself, elevated.** Creates the whole test profile and
  is safe to re-run: every step skips what already exists. It never stops, edits or
  restarts a live service or file. Claude does not run it (services, firewall rules and
  the backend data are operator actions).
- `../mongodb/mongod-test.cfg` - the test mongod config (port 27018, data and log under
  `C:\Alduinak\mongodb-test`).
- `../livekit/livekit-test.yaml` - the test LiveKit config (7890/7891, UDP 50300-50500);
  the script fills in generated keys.

## What the script does

```
powershell -ExecutionPolicy Bypass -File deploy\testserver\setup-testserver.ps1 -MongoPassword "YourStrongPassword"
```

Parameters: `-MongoPassword` (required, the `skympuser` password on the test mongod),
`-MasterKey` (default: 32 random hex characters), `-Port` 7787, `-MaxPlayers` 20,
`-DataDir "C:\GOG Games\Skyrim Anniversary Edition - Test\Data"`, `-LogDir C:\logs\test`,
`-Repo` (the checkout, found from the script's location).

1. **Folders.** `build\dist\testserver` is copied from `build\dist\server` without the
   world, `writings`, the settings files, `install-services.bat` (it re-registers the
   live services) and the state registries; the registries are created empty
   (`docs/docs_test_server.md` section 2.1). `build\dist\testclient` is
   copied from `build\dist\client`. `C:\logs\test`, `C:\Alduinak\mongodb-test\{data,log}`
   and `C:\Alduinak\livekit-test` are created. `-DataDir` must already exist (a copy of
   the live Data folder).
2. **MongoDB.** `AlduinakMongoTest`, a native mongod service on 27018 from
   `mongod-test.cfg`, with the `skympuser` app user on the `skymp` database.
3. **LiveKit.** `AlduinakLiveKitTest` from `C:\Alduinak\livekit-test` (binaries copied
   from `C:\Alduinak\livekit`), fresh API keys kept on re-runs, firewall rules
   "Alduinak LiveKit Test TCP" (7890, 7891) and "Alduinak LiveKit Test UDP" (50300-50500).
4. **Settings.** `build\dist\testserver\server-settings.json` derived from the live file
   with node: name, port, player cap, log dir, master key, the test MongoDB, the test Data
   folder in `dataDir`, `loadOrder` and `archives`, the test LiveKit, no Discord event or
   security channels, no daily restart, staff-only access. Written only when missing.
5. **Game service.** `AlduinakTestServer` (nssm, manual start) running
   `node dist_back\skymp5-server.js` in `build\dist\testserver`, logs in `C:\logs\test`,
   `WS_PORT` pointing at the backend's test relay, firewall rule
   "Alduinak Test Game UDP 7787".
6. **Backend seeds** in `skymp5-backend\data` (only when missing): `manifest-test.json`
   (from `manifest.json`, archive URLs under `/files/extras-test/`), `modlist-test.json`,
   the `extras-test` archive folder next to `extras`, and the `test` block in
   `versions.json`.
7. **Next steps** are printed at the end (restart the backend and the manager, start the
   Test Server from the Console tab, bump and build the launcher).

## Removing everything

Elevated PowerShell, with the Test Server stopped:

```
$n = 'C:\tools\nssm\nssm.exe'
& $n stop AlduinakTestServer;   & $n remove AlduinakTestServer confirm
& $n stop AlduinakLiveKitTest;  & $n remove AlduinakLiveKitTest confirm
Stop-Service AlduinakMongoTest; & 'C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe' --remove --serviceName AlduinakMongoTest
foreach ($r in 'Alduinak Test Game UDP 7787', 'Alduinak LiveKit Test TCP', 'Alduinak LiveKit Test UDP') { netsh advfirewall firewall delete rule name="$r" }
Remove-Item -Recurse -Force C:\Alduinak\mongodb-test, C:\Alduinak\livekit-test, C:\logs\test
Remove-Item -Recurse -Force build\dist\testserver, build\dist\testclient
Remove-Item -Force skymp5-backend\data\manifest-test.json, skymp5-backend\data\manifest-test.json.prev, skymp5-backend\data\manifest-diff-test.json, skymp5-backend\data\data-sync-test.json, skymp5-backend\data\modlist-test.json -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force build\client-files\extras-test -ErrorAction SilentlyContinue
```

Then delete the `test` block from `skymp5-backend\data\versions.json`, restart
`AlduinakBackend` (it stops listing the test server and closes the test relay) and the
manager. The test Data folder copy can stay or go as you like.
