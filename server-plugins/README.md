# Server plugins

## gamemode_extensions (the gamemode source)

The live gamemode is no longer edited as one file. Its source lives in
`build/dist/server/gamemode_extensions/*.js` (gitignored, server box only):
numbered parts that the Server Manager concatenates - sorted by filename -
into `build/dist/server/gamemode.js` on **Build server**, **Build gamemode
only**, or the console command `build gamemode`. The server hot-reloads the
generated file within a second; never edit `gamemode.js` directly.
`00_core.js` must stay first and `99_bootstrap.js` last; everything else is a
drop-in numbered part sharing one script scope. See the README inside that
folder for the ordering rules.

## Plugins

Creator-named gamemode plugin folders, one directory per creator, one
subdirectory per plugin (Space Station 14 downstream style):

```
server-plugins/<Creator>/<plugin>/index.js
```

This folder is the repo-tracked source of truth. The live server loads
plugins from `build/dist/server/plugins/<Creator>/<plugin>/index.js`
(that tree is gitignored, like gamemode.js). Deploy by copying:

```
xcopy /E /I /Y server-plugins build\dist\server\plugins
```

## Runtime

The gamemode's plugin loader runs each `index.js` with an `api` object in
scope. Plugins reload together with the gamemode: save (or touch)
`build/dist/server/gamemode.js` and both reload in about a second.
A plugin that throws at load is skipped and logged; it cannot take chat down.

## api surface

| Member | Purpose |
|---|---|
| `api.mp` | the raw server / gamemode API (mp.get, mp.set, mp.callPapyrusFunction, ...) |
| `api.on(event, fn)` | generation-safe `customPacket` / `connect` / `disconnect` handlers |
| `api.live()` | false once a newer gamemode generation loaded (stop timers) |
| `api.players()` | online players `[{ actorId, userId, profileId, name }]` (1s cache) |
| `api.settings()` | parsed server-settings.json |
| `api.deliver(actorId, line)` | raw chat line to one player (`[[S]]`/`[[A]]`/`[[PM]]` tags, `#{rrggbb}` colors) |
| `api.sendNear(actorId, range, lineOrFn, includeSelf)` | proximity chat broadcast |
| `api.notifyActor(actorId, text)` | corner notification (System tab) |
| `api.sendPacketToActor(actorId, payload)` | CustomPacket to the actor's user |
| `api.color(hex, text)`, `api.COLOR` | chat color helpers |
| `api.isAdminActor(actorId)` | unified admin check (roles, overrides, permissions) |
| `api.findByName(query)` | online player lookup, exact then unique prefix |
| `api.safeGet/safeSet` | throw-safe mp.get/mp.set |
| `api.log(...)` | console.log prefixed with the plugin label |
| `api.registerChatCommand(name, fn)` | `/name` handler: `fn(actorId, args, { userId, name })` |
| `api.registerConsoleCommand(name, fn)` | manager console handler: `fn(restArgs) -> string` |

`module`, `exports`, `require`, and `__dirname` behave like a normal Node
module (`__dirname` is the plugin folder).
