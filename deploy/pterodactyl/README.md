# Pterodactyl eggs

Two eggs, both running the same published image
(`ghcr.io/mesaindigoroleplay/alduinak-server`). They differ only in what the
install step puts into the volume.

| Egg | Install step | Use for |
| --- | --- | --- |
| `egg-alduinak-server.json` | Creates the directory layout and tells the operator to upload their own master files | Anything real |
| `egg-alduinak-server-dev.json` | Downloads the master files from the mirror this repo's CI uses | Internal testing only |

The dev egg fetches Bethesda's copyrighted files. It exists so a test server can
be brought up without hand-uploading five large files, and it must not be used
on a public or commercial node.

## Importing

Admin panel → Nests → Import Egg → upload the JSON. Then create a server on that
egg.

## Two allocations

The server binds two ports:

- the **primary allocation**, UDP, for game traffic. Pterodactyl passes it as
  `SERVER_PORT` and the container picks it up with no further configuration.
- a **second allocation**, TCP, for the http endpoints: static `data/` contents,
  `/metrics` and `/rpc`.

Pterodactyl only exposes the primary allocation automatically, so add the second
one under the server's **Network** tab, then set the egg's `UI_PORT` variable to
that port number. They must not be equal.

Historically this port was not configurable: the server derived it as `port + 1`,
or 3000 when the game port was the default 7777. Since Pterodactyl hands out
arbitrary allocations there was no way to guarantee `port + 1` was free, so the
server gained a `uiPort` setting. If a backend talks to this server, its
`SKYMP_UI_PORT` must match.

## Game files

The production egg deliberately does not fetch them. After installing, upload

```
Skyrim.esm  Update.esm  Dawnguard.esm  HearthFires.esm  Dragonborn.esm
```

from your own `<Steam>/steamapps/common/Skyrim Special Edition/Data/` into the
server's `data/` directory over SFTP or the panel file manager. The server
refuses to start until all five are present and names the ones it cannot find.

## Gamemode

Upload `gamemode.js` into the server root, or drop parts into
`gamemode_extensions/` and let the container concatenate them in filename order
on each start. With neither, the server runs bare: players connect and spawn,
and no roleplay logic applies.

## Startup detection

The egg marks the server as started on `Current process ID is`, which the server
prints once the master files are parsed and the game socket is listening. World
load takes a while on first start; that is normal and the panel will sit in
"starting" until it passes.

Stop is `^C` (SIGINT).

## Registry access

The image is published to GHCR from
[.github/workflows/docker-server.yml](../../.github/workflows/docker-server.yml).
If the package is private, each Wings node needs registry credentials in its
`config.yml` under `docker.registries`. Making the package public avoids that,
and is safe: the image carries no game files.
