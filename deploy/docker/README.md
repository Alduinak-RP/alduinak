# Alduinak server container

Linux container image for the game server. The Windows-side pieces (Server
Manager, launcher, SkyrimPlatform, the client) are not part of this image and
are not containerised: the manager is an Electron app and the client is a
Windows game mod.

The backend, MongoDB, LiveKit and nginx stay as they are, alongside the
container rather than inside it.

## What you get

| Target | Purpose |
| --- | --- |
| `runtime-byo` | Production. You supply the Skyrim master files. This is the image published to GHCR. |
| `runtime-dev` | Local testing only. Bakes the master files into the image. Never published. |

## Game files

The server loads `Skyrim.esm`, `Update.esm`, `Dawnguard.esm`, `HearthFires.esm`
and `Dragonborn.esm` at startup. Those are Bethesda's copyrighted files. They
are not in the image and never will be: copy them out of your own install at

```
<Steam>/steamapps/common/Skyrim Special Edition/Data/
```

into the server's `data/` directory. The container refuses to start without
them and says which are missing.

`runtime-dev` downloads them from the mirror this repository's CI already uses.
That is a convenience for local testing, not a licence. Building it requires an
explicit acknowledgement:

```bash
docker build -f deploy/docker/Dockerfile --target runtime-dev \
  --build-arg I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE=yes \
  -t alduinak-server:dev .
```

Without that build-arg the stage fails, so no CI job or stray `--target` can
produce a pushable image full of Bethesda's files.

## Building

Build from the repository root; the context is the repo, not this directory.

```bash
docker build -f deploy/docker/Dockerfile --target runtime-byo \
  -t ghcr.io/mesaindigoroleplay/alduinak-server:byo .
```

The first build compiles every vcpkg dependency from source and takes a long
time. BuildKit cache mounts carry the vcpkg binary cache between builds, so
later builds only recompile what changed. On a machine short on RAM per core,
cap the parallelism:

```bash
docker build ... --build-arg BUILD_JOBS=4 .
```

Only the server is built: `-DBUILD_SKYRIM_PLATFORM=OFF` because SkyrimPlatform
is MSVC-gated, and no client, front or Papyrus scripts.

CI publishes `runtime-byo` to GHCR on pushes to `main` and on `v*` tags. See
[.github/workflows/docker-server.yml](../../.github/workflows/docker-server.yml).

## Running standalone

```bash
mkdir -p deploy/docker/server-data/data
cp "/path/to/Skyrim Special Edition/Data/"*.esm deploy/docker/server-data/data/
docker compose -f deploy/docker/docker-compose.yml up
```

## Layout

The image keeps its binaries in `/opt/alduinak` and treats `/home/container` as
the server directory, because the server resolves everything relative to its
working directory: it requires `./scam_native.node`, reads
`./server-settings.json`, loads `./gamemode.js` and reads
`./dist_back/skymp5-server.js.map`.

On every start the entrypoint relinks `scam_native.node` and `dist_back` into
the working directory, so an image upgrade is picked up without touching your
files.

| Path in the volume | What it is |
| --- | --- |
| `data/` | Master files, mods, `.bsa` archives, localisation strings |
| `world/` | Persisted changeForms, when `DATABASE_DRIVER=file` |
| `gamemode.js` | The live gamemode |
| `gamemode_extensions/` | Gamemode parts; concatenated into `gamemode.js` at boot |
| `server-settings.json` | Generated from the environment, then yours to edit |

## Configuration

`server-settings.json` is generated on first boot and merged on every later
boot. Keys whose environment variable is set are overwritten each time, because
on an orchestrator the allocation is authoritative; everything else you write
into the file is preserved.

| Variable | Setting | Notes |
| --- | --- | --- |
| `SERVER_PORT` | `port` | UDP. Pterodactyl sets this from the primary allocation |
| `UI_PORT` | `uiPort` | TCP. Static `data/`, `/metrics`, `/rpc` |
| `SERVER_NAME` | `name` | |
| `MAX_PLAYERS` | `maxPlayers` | |
| `OFFLINE_MODE` | `offlineMode` | `1` ignores the master API entirely |
| `MASTER_URL` | `master` | |
| `MASTER_KEY` | `masterKey` | Must match the backend `SERVER_MASTER_KEY` |
| `MASTER_API_AUTH_TOKEN` | `masterApiAuthToken` | |
| `DATABASE_DRIVER` | `databaseDriver` | `file`, `mongodb` or `zip` |
| `DATABASE_NAME` | `databaseName` | |
| `DATABASE_URI` | `databaseUri` | MongoDB only |
| `DATA_DIR` | `dataDir` | Default `data` |
| `GAMEMODE_PATH` | `gamemodePath` | Default `gamemode.js` |
| `LISTEN_HOST` | `listenHost` | |
| `UI_LISTEN_HOST` | `uiListenHost` | |
| `SERVER_LANG` | `lang` | |
| `LOAD_ORDER` | `loadOrder` | Comma or newline separated. Unset loads the five masters |
| `ARCHIVES` | `archives` | Comma or newline separated `.bsa` list |
| `START_POINTS_JSON` | `startPoints` | Raw JSON |
| `METRICS_AUTH_JSON` | `metricsAuth` | Raw JSON, `{"user":…,"password":…}` |

`UI_PORT` exists because the server used to derive its http port as `port + 1`
(or 3000 for the default 7777), which no orchestrator handing out arbitrary
allocations can guarantee is free. If you set it, the backend's `SKYMP_UI_PORT`
has to agree.

## Gamemode

`gamemode.js` is not in this repository, and not because it is secret: it lives
under `build/`, which is ignored wholesale as the CMake output directory, and
so do its `gamemode_extensions/` sources. Both are build artifacts by accident
of layout rather than by intent.

The container supports both shapes:

1. Upload `gamemode.js` directly, or
2. Drop parts into `gamemode_extensions/` and let the entrypoint concatenate
   them in filename order, the same contract as the Server Manager's "Build
   gamemode only", including the syntax check and the atomic replace.

With neither, the entrypoint writes an empty `gamemode.js`. The server runs and
players connect and spawn, with no roleplay logic. That matches what the
`build/dist/server/README.md` describes as a bare server.
