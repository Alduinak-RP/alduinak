# Server Configuration Reference

The recommended way to configure the server is setting up all required values in `server-settings.json`. It's standard JSON without C-style comments support. See also [Server Command Line API](docs_server_command_line_api.md).

## name

Server's name that will be published on a master server.

```json5
{
  // ...
  "name": "My Server"
  // ...
}
```

## masterKey

Specify the server key you wish to use for Master API. Client must have the same key specified to log in successfully.

```json5
{
  // ...
  "masterKey": "my-awesome-server",
  // ...
}
```

## listenHost

Specifies the IP address to bind to. Applies to the main UDP traffic (RakNet). Binds to `0.0.0.0` if unspecified.

```json5
{
  // ...
  "listenHost": "127.0.0.1",
  // ...
}
```

## uiListenHost

Specifies the IP address to bind to. Applies to the `uiPort` (http). Binds to `0.0.0.0` if unspecified.

```json5
{
  // ...
  "uiListenHost": "127.0.0.1",
  // ...
}
```

## metricsAuth

HTTP Basic authentication for the `/metrics` endpoint.

If omitted, `/metrics` is not available.

```json5
{
  // ...
  "metricsAuth": {
    "user": "prometheus",
    "password": "secret"
  },
  // ...
}
```

## port

This port would be used by player clients to connect to your server. At the current version of Skyrim Multiplayer servers use multiple ports and different protocols to manage different sorts of packets. See [Server Ports Usage](docs_server_ports_usage.md) page to learn more.

```json5
{
  // ...
  "port": 7777
  // ...
}
```

## maxPlayers

Sets player limit of the server. Visible in launcher and on skymp.io.

```json5
{
  // ...
  "maxPlayers": 108
  // ...
}
```

## dataDir

Contains relative or absolute path to a "data" directory which contains:
* vanilla Skyrim master files (Skyrim.esm, Update.esm, etc)
* plugin files (mods in .esp format)
* compiled Papyrus scripts in .pex format

This directory is exposed to `uiPort` and available via http.

At this moment, the server uses this directory for non-vanilla needs too:
* storing web-based GUI in `${dataDir}/ui`
* storing auto-generated manifest describing .esm/.esp files used and CRC32 of them

```json5
{
  // ...
  "dataDir": "data"
  // ...
}
```

## loadOrder

A list of relative or absolute paths to .esp/.esm files which would be loaded by the server during startup in the same order as Skyrim SE loads them.

Relative paths are searched in `${dataDir}` directory.

Absolute paths work but aren't accessible via `uiPort`. External tooling wouldn't be able to download them from the server.

```json5
{
  // ...
  "loadOrder": [
    "Skyrim.esm",
    "Update.esm",
    "Dawnguard.esm",
    "HearthFires.esm",
    "Dragonborn.esm"
  ]
  // ...
}
```

## archives

Specify BSA archives that will be loaded by the server.

At this moment, used only for compiled Papyrus scripts.

Relative/absolute paths work similar to esp/esm.

```json5
{
  // ...
  "archives": [
    "Skyrim - Misc.bsa"
  ]
  // ...
}
```

## lang

The language, the translation of which will be obtained from the string files located in Data/strings

```json5
{
  // ...
  "lang": "english"
  // ...
}
```

## offlineMode

The boolean variable shows is server in "offline mode" or not (the server allows clients to connect with any profile id they choose).
Users need to specify `"profileId"` in their `skymp5-settings.txt`.

```json5
{
  // ...
  "offlineMode": true
  // ...
}
```

## databaseDriver

Name of a database driver which would be used to store server data. `file` by default. There are also related options like `"databaseName"`. See [Database Drivers](docs_database_drivers.md) page to learn more.

```json5
{
  // ...
  "databaseDriver": "file"
  // ...
}
```

## reloot

A time before a game object restores its original state in milliseconds. Unlike Skyrim SE, Skyrim Multiplayer doesn't have a built-in Cell Reset mechanism. The server resets every object in the world every hour instead. With this option, you can change this time interval for every kind of game object. `"CONT"`, for example, means "Container" - chests, barrels, etc. See "record types" on [UESP](https://en.uesp.net/wiki/Skyrim_Mod:Mod_File_Format).

```json5
{
  // ...
  "reloot": {
    "FLOR": 86400000,
    "TREE": 86400000,
    "AMMO": 86400000,
    "ARMO": 86400000,
    "BOOK": 86400000,
    "INGR": 86400000,
    "ALCH": 86400000,
    "SCRL": 86400000,
    "CONT": 86400000,
    "SLGM": 86400000,
    "WEAP": 86400000,
    "MISC": 86400000
  }
  // ...
}
```

## forbiddenReloot
Record types (see [UESP](https://en.uesp.net/wiki/Skyrim_Mod:Mod_File_Format)) that never reloot. A listed type wins over its `reloot` timer:

- Item types (`MISC`, `WEAP`, `BOOK`, ...) and `FLOR`/`TREE`: plugin-placed refs of that type can't be picked up or harvested at all. Player-dropped items stay lootable.
- `CONT`: an emptied container never refills. Players can use any container as storage. A container reloot already pending in the database is dropped when the container loads. What a container holds on its first open is set by [`emptyContainers`](#emptycontainers).
- `KEYM`: plugin-placed keys are never loaded by the server, so they are untouchable either way. Listing it documents that.
- `LIGH`: plugin-placed torches, lanterns and other carryable lights stay where they are. Wall sconces are covered by [`untouchableBaseIds`](#untouchablebaseids).

```json5
{
  // ...
  "forbiddenReloot": ["MISC", "WEAP", "SLGM", "SCRL", "ALCH", "INGR", "BOOK", "ARMO", "AMMO", "KEYM", "CONT", "LIGH"]
  // ...
}
```

## emptyContainers

`true` (the default, also when the key is missing): placed containers (`CONT` references from any plugin, chests, barrels, sacks, dressers, safes) open empty.

- The server skips the container's plugin items and leveled lists, on the first open and on any reloot.
- Items players put in stay, and so do items a script or the gamemode adds.
- A container that already got its plugin loot keeps it. Nothing is removed from the database.
- NPCs, NPC corpses and player bodies are actors, not containers, and keep their inventories. Flora, trees and hanging food are harvested, not opened, and are unchanged.

`false` restores the plugin loot. A container that has never received anything then gets it on its next open. The native server reads the key at boot. Any value other than `true` or `false` is logged as an error and the default stays.

```json5
{
  // ...
  "emptyContainers": true
  // ...
}
```

## containerLootBaseIds

Container base records that keep their plugin loot while `emptyContainers` is on. Give the `CONT` record, not the placed reference, as a number, a `"0x..."` string or a `"hex:File.esp"` descriptor. Empty by default. An entry that doesn't resolve (a malformed or negative id, one above 32 bits, or a file that isn't loaded) is skipped and logged at boot.

```json5
{
  // ...
  "containerLootBaseIds": ["18e991:Warbirds Whiterun Metropolis.esp"]
  // ...
}
```

## untouchableBaseIds

Base forms nobody can activate, as numbers or `"0x..."` strings. Defaults to the
vanilla coin purses (flora that hands out leveled gold and respawns), the
loose salmon (`0x000F5ECA`, `0x000F5ECB`), the Stones of Barenziah
(`0x0007F8E1`, whose script would otherwise hand the stone to the first taker
and disable it for everyone) and the wall torch sconce with its torch
(`0x0009151E`, `0x0009151F`). The server sends the list to every
client on connect, which then blocks engine activation and shows no prompt for
those forms. `[]` disables the check.

```json5
{
  // ...
  "untouchableBaseIds": ["0x000D790C", "0x000D8E7F", "0x000D8E80"]
  // ...
}
```

## doorTeleportOverrides

Load doors that send the player somewhere other than their plugin data says,
one entry per door. `door` is the placed reference of the door that is pressed,
`cellOrWorldDesc` the interior cell or the worldspace it leads to; both take a
number, a `"0x..."` string or a `"hex:File.esp"` descriptor. `pos` is the
arrival point in game units and `rot` its angles in degrees, `[0, 0, 0]` when
omitted. An entry the load order has no form for is skipped and logged at boot.

Defaults to the Thalmor Embassy party room's south west door (`7C98E:Skyrim.esm`),
whose vanilla pair leaves the player in the room, redirecting it to the courtyard
outside the embassy front door. Giving the key replaces that list; `[]` turns the
overrides off.

The override applies only to the connected player who pressed the door, only
once the lock, faction and job checks of the normal door path have allowed the
activation, and it replaces the door's own teleport rather than adding to it. A
pet or a companion following its owner through keeps the plugin destination.

```json5
{
  // ...
  "doorTeleportOverrides": [
    {
      "door": "7C98E:Skyrim.esm",
      "cellOrWorldDesc": "3c:Skyrim.esm",
      "pos": [-79858.25, 114377.65, -2273.45],
      "rot": [0, 0, 159.95]
    }
  ]
  // ...
}
```

## exteriorScriptAllowlist

Vanilla Papyrus scripts that still run on exterior references. The server
strips every other vanilla script from exterior refs, and clients run no
Papyrus of their own, so an exterior gate opened by a lever only moves when its
scripts are listed here. Names are case-insensitive. Defaults to the two-state
gate and lever scripts; `[]` strips them too. Read by the native server at
boot.

```json5
{
  // ...
  "exteriorScriptAllowlist": ["default2StateActivator", "NorLever01SCRIPT"]
  // ...
}
```

## playersInheritBaseSpells

`true` (default) keeps the Player record's castable spells (Flames, Healing)
and the race's powers on every player character (`AlduinakAdditions.esp` leaves
the playable races only Khajiit Night Eye). `false` makes characters start
without them; abilities such as the combat heal rate, racial passives and
lesser powers (Khajiit Night Eye) stay,
and spells learned in play (tomes) are kept. The client drops the withheld spells from its own spell lists at
spawn and after the race menu. Read by the native server at boot.

```json5
{
  // ...
  "playersInheritBaseSpells": false
  // ...
}
```

## npcHostRange

How far, in game units, a player can be from a server NPC (a spawn zone NPC or a companion) and still be picked as its new host. Only players the server streams the NPC to count: the server sends an actor to the players in its 4096-unit grid cell and the eight cells around it, so a player 4.1k units away across two cell lines may not have it, while one 11k units away diagonally may. The server moves an NPC's hosting to the player it is fighting, to its owner, or to the nearest such player within this range. A host that still streams the NPC keeps it when nobody else qualifies, so an NPC is unhosted only once its host no longer receives it (see `docs_roleplay_npc_spawns.md`, Hosting). Default 8192. Needs the `scam_native` build with `setHoster`; older builds log once at boot and keep client-driven hosting. A player whose game is paused, alt-tabbed or loading is never picked; that test needs `getMovementAgeMs`, and a build without it logs once and skips such a player only after another client claims its NPC.

```json5
{
  // ...
  "npcHostRange": 8192
  // ...
}
```

## Pets

The pet system (`docs_roleplay_pets.md`) reads `petInteractMaxDistance`, `petAnchorRadius`, `petHarvestHours`, `petCorpseSeconds`, `petReleaseSeconds`, `petFleeSeconds`, `petMountTimeoutSeconds`, `petMaxPets`, `petMaxOut`, `petBases` and `petHarvestItems`; every key is optional and documented there with its default.

```json5
{
  // ...
  "petHarvestHours": 12,
  "petMaxOut": 3
  // ...
}
```

## Writings

Letters, journals and books (`docs_roleplay_writing.md`) read `writingEnabled` (default `false`, the switch for the whole feature), `writingTitleMaxLen`, `writingLetterMaxLen`, `writingPageMaxLen`, `writingJournalMaxPages`, `writingBookMaxPages`, `writingMaxDocuments`, `writingDocumentDays` and `writingMaxPerDay`; every key is optional and documented there with its default. The documents live in `writings/` next to this file.

```json5
{
  // ...
  "writingEnabled": true,
  "writingMaxPerDay": 20
  // ...
}
```

## Weather

The per-region weather sync (`docs_roleplay_weather.md`) rolls one weather per plugin region for 30 to 90 real minutes and every client in the region shows it. The regions come from the load order (`skymp5-server/ts/systems/weatherRegions.ts`, generated by `misc/gen-weather-regions.py`); an optional `weather-regions.json` next to this file replaces them, and `weather-state.json` keeps the current weathers over a restart. All keys optional:

| Key | Default | Meaning |
|---|---|---|
| `weatherEnabled` | `true` | `false` switches the sync off; clients keep the vanilla sky |
| `weatherMinMinutes` | `30` | Shortest weather, real minutes (1 to 1440) |
| `weatherMaxMinutes` | `90` | Longest weather (at least the minimum, at most 1440) |
| `weatherTransition` | `"accelerate"` | How a client changes to a new weather: `accelerate` (the engine's fast fade), `normal` (the vanilla fade, slow at the realm's 1:1 game clock) or `instant` |
| `weatherGameSettings` | none | `{ "fWeatherTransMin": .., "fWeatherTransMax": .., "fWeatherTransAccel": .. }`, floats every client applies once to tune the fade speed, no client rebuild needed |

```json5
{
  // ...
  "weatherMinMinutes": 30,
  "weatherMaxMinutes": 90,
  "weatherTransition": "accelerate"
  // ...
}
```

## Factions

The faction system (`docs_roleplay_property_factions.md` section 6) needs `master`, `masterKey` and `masterApiAuthToken`; without the token it stays off and the Faction tab says factions are unavailable. Faction and rank data live in the backend, not here. Optional keys:

| Key | Default | Meaning |
|---|---|---|
| `factionInviteMaxDistance` | `1024` | How close an officer must stand to invite someone, in game units |
| `factionUniformCooldownHours` | `24` | Hours before the same character can be issued the same faction's uniform again |

Faction-only doors and containers come from `faction-access.json` next to `gamemode.js`, not from this file.

## Bleedout and execution

All optional; see `docs/docs_roleplay_survival_loop.md` section 8 for the system. A player at 0 health bleeds out only with the native server build that fires `onKillAttempt`.

World floor (no setting): a living player below Z -40000 in Tamriel or below -30000 in any other cell or worldspace has fallen through the world. The server kills them (`[floor]` and `[bleedout] ... fell out of the world` log lines, the Discord death line) and they respawn in the nearest temple after `respawnSeconds`, also after a relog into a saved void position.

| Key | Default | Meaning |
|---|---|---|
| `bleedoutSeconds` | `15` | Seconds a downed player has before dying, unless healed, captured or carried |
| `bleedoutHealedHealth` | `0.25` | Share of max health that ends a bleedout when healed back to it |
| `executionBlockBaseIds` | `[0x2E8EB, 0xFE549]` | Base form ids (numbers or `"0x..."` strings) of the furniture that counts as an execution block |
| `executionBlockOffset` | `{ "forward": 0, "right": 0, "up": 0, "yaw": 0 }` | Where Prepare Execution puts the prisoner, relative to the block: along its facing, across it, up, and degrees added to its yaw. Unmeasured default |
| `executionerOffset` | `{ "forward": -40, "right": 70, "up": 0, "yaw": -90 }` | Where Execute puts the executioner, relative to the block. Unmeasured default |
| `executionChopMs` | `3000` | Milliseconds from the chop to the prisoner's death |

## Carry pose

A carried player or pet sits in a vanilla chair idle held in the carrier's arms. `CaptureSystem` sends the pose to the carried player's client, and to the carrier's client for a carried pet or NPC, and uses it for its drift snap. Every key is optional and read at server start, so a change needs a game service restart and no build.

| Key | Default | Meaning |
|---|---|---|
| `carriedAnimEvent` | `IdleChairEnterInstant` | Animation event the carried body plays |
| `carryOffsetForward` | `30` | Units ahead of the carrier |
| `carryOffsetUp` | `40` | Units above the carrier's feet |
| `carryYawOffset` | `45` | Degrees the body is turned from the carrier's facing; `90` lies it across the arms, `0` faces forward |

## npcAggroHostSeconds

For this many seconds after a player and a zone NPC exchanged a damaging hit, that player may host the NPC, so its AI runs on the client that is fighting it. Only hits the other handlers allowed (god mode, ghost mode and the capture carrier rule refuse some) and that deal damage count. A host that is itself inside its window keeps the NPC when another player hits it, so a group fight does not move the AI between clients. Default 30; `0` disables the aggro rule and leaves nearest-player hosting.

```json5
{
  // ...
  "npcAggroHostSeconds": 30
  // ...
}
```

## searchStartMaxDistance, searchKeepMaxDistance

How far, in game units between actor roots, a player may be from another player, a living server NPC or a body to start searching it (`searchStartMaxDistance`, default 256), and how far apart the pair may drift before the window closes with "They moved away." (`searchKeepMaxDistance`, default 512). A living NPC is refused with "They are fighting." while it exchanged a damaging hit with a player within `npcAggroHostSeconds` (the hosting aggro window, no separate search setting), and its weapons and armour move neither way: a take or a put of one snaps back. A dead NPC adds the half length of its base's bounds (the NPC_ `OBND`, at most 512) to both, so a mammoth (264) can be searched from its head or tail; a base without bounds, such as the frost atronach, adds 128. Dead player characters get no extra reach. A refused search logs `[search] <searcher> refused <target>: dead .., distance .., reach ..`, and every session end logs `[search] <searcher> stops searching <target>: <reason>`.

```json5
{
  // ...
  "searchStartMaxDistance": 256,
  "searchKeepMaxDistance": 512
  // ...
}
```

## gamemodePath

Contains a relative or an absolute path to a file or directory with a gamemode.
Searches for `index.js` if a directory specified.

```json5
{
  // ...
  "gamemodePath": "gamemode.js"
  // ...
}
```

## characterSelectMaxCharacters

With `characterSelect` on, how many living characters a profile may hold (1-10, default 3). A character in Sovngarde or the Soul Cairn, or a perma-dead one, no longer counts: it stays listed and one more slot opens, up to 10 slots. Deleting it closes that slot again. Characters never change slot, so a gap a deleted character leaves before a living one stays hidden while the living limit is reached.

## logoutGraceMs, logoutPose

A character's body stays in the world for `logoutGraceMs` (default `300000`, five minutes) after a disconnect, a quit to the main menu or a switch to another slot, so leaving is never an instant escape; re-selecting the character cancels the grace. For that time the body sits down in `logoutPose` (default `"IdleSitCrossLeggedEnter"`, the emote wheel's Sit Crossed; `""` leaves it standing), sent by the server to everyone who sees the body and to anyone who walks in later, with the line `[spawn] <id> parked in <pose>`. A downed, bound or carried body keeps its own pose. No client hosts a parked body (`HostingSystem.mayHost` refuses a living player character without a user), so a neighbour's engine never replaces the pose or clears it with a movement report; hits on the body are server-resolved and need no host. The pose needs the native server build that accepts `mp.set(actorId, "lastAnimEvent", ...)`; an older build logs `[spawn] parking pose ... failed` and the body stands.

## startPoints

Contains a list of spawn points, one of which will be chosen at random. With `characterSelect` on, a new character only uses them when `startLocations` is `[]`; the single-character login path always uses them.

```json5
{
  // ...
  "startPoints": [
    {
      "pos": [22659, -8697, -3594],
      "worldOrCell": "0x1a26f",
      "angleZ": 268
    }
  ]
  // ...
}
```

## startLocations

The start locations a new character chooses from with `characterSelect` on. Pressing Play on an Empty slot shows the synopsis (two pages), then "Where will your journey begin?" with one button per entry and a confirmation. The server checks the chosen `id` against this list and creates the character there. The coordinates never come from the client, and an unknown or missing id creates nothing and resends the character list. Each arrival lands at a random point up to 100 units from `pos`, 64 units higher, so a crowd does not stack on one spot. The character's race menu then opens there as before, and the id is saved on the character as `private.startLocation` (`{ id, at }`). Respawn is unchanged (the nearest temple).

The key is optional. Without it the server uses the five built-in locations below (Tamriel, angle 0). `[]` turns the intro off, so an Empty slot creates at once at a `startPoints` entry. A malformed list logs a warning and keeps the built-in locations. `angleZ` defaults to 0 and `worldOrCell` to `0x3c`. Edit it in `server-settings.json` on the server and restart the game service.

A character whose creation is unfinished (`private.creationPending`, set at creation and cleared when the race menu is accepted) neither takes nor deals weapon or spell damage.

```json5
{
  // ...
  "startLocations": [
    { "id": "dawnstar-docks", "label": "Dawnstar Docks", "pos": [27167.60, 110262.89, -13909.25], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "pale-pass", "label": "Pale Pass - Cyrodiil Border", "pos": [-51425.53, -99716.02, 1068.29], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "morrowind-gate", "label": "Morrowind Gate - Riften", "pos": [212996.14, -111249.54, 8059.13], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "solitude-docks", "label": "Solitude Docks", "pos": [-63893.07, 95463.61, -13936.59], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "dunmeth-pass", "label": "Dunmeth Pass - Windhelm", "pos": [174009.45, 38223.89, -9091.38], "angleZ": 0, "worldOrCell": "0x3c" }
  ]
  // ...
}
```

The synopsis text lives in `skymp5-server/ts/systems/startLocations.ts` (Build server). The client swaps its bracketed placeholders for the player's key bindings and leaves out a line whose key is unbound. A page with `align: "left"` shows its lines left aligned, as the key list page does; other pages are centered.

## isPapyrusHotReloadEnabled

A boolean setting that enables to turn on or turn off hot reload for compiled Papyrus scripts (.pex)

```json5
{
  // ...
  "isPapyrusHotReloadEnabled": false
  // ...
}
```

## locale

The name of a localizaiton file in `data/localization` that would be used by `M.GetText` Papyrus function (without extension).

```json5
{
  // ...
  "locale": "ru-RU"
  // ...
}
```

## enableConsoleCommandsForAll

Lets every player run the server console commands (`additem`, `equipitem`, `placeatme`, `disable`, `markfordelete` and `mp`), whatever their character's console flag says. Keep it off, which is the default. These server console commands are disabled for everyone on this server, admins included, and AdminSystem logs a warning at boot when this key is on. Admins spawn items with the Item Spawner (see Admin roles) instead. Local game console commands (`tgm`, `tcl`, `coc`, `tfc`, `player.setav` and the like) never reach the server. The client (`ConsoleBlockService`) closes the local ~ console the moment it opens and refuses the local cheat commands when they run, for every player, admins included. That is client-side enforcement a modified client can remove, so the server checks stay the authority.

```json5
{
  // ...
  "enableConsoleCommandsForAll": false
  // ...
}
```

## discordAuth

The Discord bot integration. `botToken` is the bot's token, so keep this key secret. For each entry in `guilds`, login checks membership and `banRoleId`, and `DiscordBanSystem` kicks players who get the ban role. `eventLogChannelId` receives the `Server Login` lines and the game alerts below. Leave `eventLogChannelId` out (or turn on `offlineMode`) on a test server, so it posts nothing to the live channel.

Game alerts (`skymp5-server/ts/systems/discordAlerts.ts`) are batched and posted every 2 seconds, so a burst arrives as a few messages. Player text cannot ping anyone or use Discord formatting, and links do not unfurl into previews:

- **[Death]** every player death, with the killer (player or NPC, if any) and the place: the nearest map marker outdoors, the cell indoors, then the raw location. A bleedout death says how it happened (bled out, died of their wounds while bleeding out, logged out while bleeding out, was finished off, was smitten) and names the player who landed the finishing hit.
- **[Execution]** execute and finish off. The killing code calls `globalThis.__alduinakMarkDeathAlerted(actorId)` first, so the same death posts no second [Death] line.
- **[Admin]** every admin power (teleports, summon, kick, ban, item spawn, grants, npc zones, jobs, admin modes), staff writing actions, `/system` broadcasts, and faction changes made with staff powers rather than a rank of the actor's own.
- **[Staff call]** `/gm`, `/ticket`, `/pray` and `/prayer <message>`, with `@here` and a mention of the player. The same line goes to the in-game Admin tab, which players still cannot read, and each player may call once a minute. Staff and players may `/pm` each other without an introduction, so a ticket can go back and forth. For the `@here` to ping, the bot needs the Mention @everyone, @here and All Roles permission in that channel.
- **[Keyword]** any chat line, PMs included, that contains a word from `alert-keywords.json` in the server folder. Staff `/admin` and `/system` lines are not scanned. The server re-reads the file within 5 seconds of a save. It holds `keywords` (whole words or phrases, ignoring case; a trailing `*` matches any ending) and `cooldownSeconds` (default 60, per player and keyword). The seed with notes is `skymp5-server/seeds/alert-keywords.json`. Without the file, keyword alerts are off.

```json5
{
  // ...
  "discordAuth": {
    "botToken": "<bot token>",
    "guilds": [{ "guildId": "<guild id>", "banRoleId": "<role id>", "eventLogChannelId": "<channel id>" }]
  }
  // ...
}
```

## Admin roles

Every player opens the Personal Menu with the interact key (X by default) while looking at nothing, a world NPC or anything else that is not a player, door or container. It has four tabs, in this order:

- **Admin**, shown only once the server confirms the player's admin tier, with the sub-tabs:
  - Players: roster, teleport to, summon, kick, ban, mastery grant and reset, and a permanent max health, magicka and stamina change of the selected online character (-1000..1000 each, absolute not additive, 0 for the plugins' own values; it is stored on the character, survives a relog and the hunger and fatigue penalties recompute against the new maximum);
  - Teleport: named locations, map markers and temples in collapsible sections;
  - Modes: God, NoClip, Invisible, Ghost, Freecam (the movement keys fly the camera while the character stays put; toggled here, no console needed; X always opens this menu while it is on, and it ends when turned off, on logout, on a character switch, on death or on respawn), Smite, Heal on Hit and Speed (raised movement speed that ends when turned off, on logout, on a character switch or on respawn);
  - NPCs: list, add, teleport to, reset and delete the spawn zones of `NPC-Spawns.json`, see `docs_roleplay_npc_spawns.md`, grant pets, and place, teleport to either end of and delete the passive jobs of `Jobs.json`, see `docs_roleplay_jobs.md`;
  - Item Spawner, see below;
  - Weather: every weather region with its current weather, the time left, the players in it and the one the admin stands in; force a weather on a region until cleared or for a number of minutes, and clear it, see `docs_roleplay_weather.md`.
- **Faction**: the character's factions with roster, promote, demote, set rank, remove, uniform, leave and the /f chat choice, see `docs_roleplay_property_factions.md`.
- **Skills**: the mastery (craft) menu.
- **Debug**: account and character name, server-side FormID, server name, position, cell id and name, heading, the distance to whatever the player faces (the crosshair when it picks something, otherwise the loaded cell's ref nearest the screen centre, so statics, trees and other scenery read too; it re-reads once a second while the tab is open and within a quarter second of a crosshair change, and a target the crosshair leaves stays on screen marked "last seen" until the menu closes; a player character you were not introduced to reads Stranger or Body, as on the interaction prompt), the target's ref id with its `hex:Plugin` desc, server id and base id with its desc (a ref created in game shows the server's base from the world model, plus the client's own base when that differs; another player's character shows its ref and server ids to staff only, since those ids would follow a masked character), a Copy IDs button that puts one line on the clipboard (name, ref id, server id when different, base id, cell and position; the descs paste straight into the Item Spawner search), magicka/health/stamina, the Tamrielic game date, local and server clocks and the active effects the client has seen start.

Admins also get the admin chat channel. Nobody gets the server console commands (`additem`, `equipitem`, `placeatme`, `disable`, `markfordelete`, `mp`), admins included: AdminSystem clears `consoleCommandsAllowed` whenever a character is assigned, so keep `enableConsoleCommandsForAll` off. The client closes the local ~ console and refuses the local cheat commands for everyone, admins included (`ConsoleBlockService`), so every admin mode, Freecam included, is toggled from Admin > Modes. This is client-side enforcement; the server checks stay the authority. Admin rights come from Discord roles, resolved into one of three tiers by `skymp5-server/ts/systems/adminRoles.ts`.

Each Admin sub-tab needs a cap. A sub-tab shows only when the tier has its cap, and the server refuses every request the tier lacks the cap for, with an admin.log line.

| Tier | `players` | `teleport` | `modes` | `npcs` | `items` | `kick` | `ban` | `factions` | `weather` |
|---|---|---|---|---|---|---|---|---|---|
| `senior` | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| `developer` | yes | yes | yes | yes | yes | no | no | yes | yes |
| `gm` | yes | yes | yes | yes | yes | yes | yes | yes | yes |

`players` covers the Players sub-tab, `teleport` the Teleport sub-tab, `modes` the Modes sub-tab, `npcs` the NPCs sub-tab, `items` the Item Spawner and `weather` the Weather sub-tab (`weatherList`, `weatherSet`, `weatherClear`). `kick` is the Kick button and `ban` the Ban button; both also need `players`. `factions` lets staff see and manage every faction in the Faction tab, the leader rank included. `adminTierCaps` changes the defaults per tier.

Teleporting yourself (TP to on a player, a Teleport location or an NPC zone's TP) closes the Personal Menu once the server confirms it. A refused teleport, Summon and every other action leave it open.

Precedence when a player holds roles from several tiers: `senior` > `developer` > `gm`. The tier lists are checked before the legacy `adminRoleIds` list, so a role listed under `adminRoles.gm` resolves to `gm` even if it is also in `adminRoleIds`. Housing claim overrides accept every tier.

Discord roles are fetched once at login (`discordAuth`) and stored on the character, so a role change on Discord only takes effect after the player relogs. The tier and its caps are re-evaluated on every Personal Menu request.

### adminRoles

Discord role ids (strings) per tier.

```json5
{
  // ...
  "adminRoles": {
    "senior": ["1521259602061164587"],
    "developer": ["1521259396481421475"],
    "gm": ["1521259484859863190"]
  }
  // ...
}
```

### adminRoleIds

Legacy flat list of Discord role ids. A role listed here that appears in no `adminRoles` tier resolves to `senior` (full rights). Optional once `adminRoles` is set.

```json5
{
  // ...
  "adminRoleIds": ["1521259602061164587"]
  // ...
}
```

### adminProfileIds

Master-api profile ids (numbers) that are always `senior`, regardless of Discord roles. Useful for a server owner without the Discord role.

```json5
{
  // ...
  "adminProfileIds": [1]
  // ...
}
```

### adminTierCaps

Optional per-tier overrides of the caps above, merged over the defaults (every cap on, except `kick` and `ban` for `developer`). Only the tiers `senior`, `developer` and `gm` and the caps `players`, `teleport`, `modes`, `npcs`, `items`, `kick`, `ban` and `factions` with `true` or `false` apply; anything else is ignored and logged once at boot. A change needs a restart.

```json5
{
  // ...
  "adminTierCaps": {
    "gm": { "items": false, "npcs": false }
  }
  // ...
}
```

### Item Spawner

The Admin tab's Item Spawner searches every weapon, armor, ammo, potion, ingredient, book, misc item, key, scroll, soul gem and carryable light of the server load order. The last override of each record wins; deleted records and non-playable armor are left out. The list is built in the background the first time an admin with the `items` cap opens the Personal Menu, which logs `AdminSystem: item catalog N item(s) in X ms`. Names of localized plugins come from `Data/Strings` or `Skyrim - Interface.bsa`, and fall back to the editor id.

A spawn gives 1 to 1000 of the chosen item to the admin or to any online player, at most once per 250 ms. Every spawn is written to the server log, admin.log and the staff channel:

```
profile 12 (gm) spawned 5x "Iron Sword" [12eb7:Skyrim.esm WEAP] for "Hrolf" (profile 34)
```

### adminTeleportLocations

Named destinations offered in the Teleport sub-tab of the Personal Menu's Admin tab. `cellOrWorldDesc` uses the same `"<localFormId>:<file>"` form as spawn zones; `rot` is optional, and so are `kind` (a label shown next to the name and matched by the search) and `group` (the Teleport section: `cities`, `villages`, `forts`, `temples` or `other`, in any case; `temples` when unset or blank, and an unknown value is listed under `temples` with a boot log line). Entries with a bad desc are dropped at boot with a log line.

The tab also lists every city, town, settlement, fort, civil war camp, orc stronghold and hold castle map marker of the load order, and every interior cell named "Temple" that a load door leads into (the teleport lands where that door drops you), from `skymp5-server/ts/systems/adminMapMarkers.ts`. That file is generated by `python misc/gen-map-marker-teleports.py` (rerun it after a load order change, then Build server); its `NUDGES` table offsets a marker whose fast-travel spot lands badly (High Hrothgar: 200 units west and up to the courtyard floor, off the entrance stairs); a configured entry wins over a generated one of the same name, and over a generated temple in the same cell, however its desc is spelled (that temple's name then fills the entry's blank `kind`, so searching either name finds it).

The list is split into collapsible sections, all collapsed at first and remembered until the game restarts: Cities (city markers), Villages (towns, settlements, orc strongholds), Forts (forts, castles, civil war camps), Temples (these configured entries first, then the generated temples) and Other. Each header shows its count and empty sections are hidden. The search covers every section and opens the ones with a match.

```json5
{
  // ...
  "adminTeleportLocations": [
    { "name": "Riften Temple", "cellOrWorldDesc": "16bd7:Skyrim.esm", "pos": [-1414.34, 208.64, 64], "rot": [0, 0, 15.75] },
    { "name": "Staff hall", "cellOrWorldDesc": "3c:Skyrim.esm", "pos": [22659, -8697, -3594], "rot": [0, 0, 268], "group": "other" }
  ]
  // ...
}
```

## sweetPieMinimumPlayersToStart

The minimal amount of players to begin deathmatch. This setting is sweetpie only and does not affect vanilla server. Default is 5.

```json5
{
  // ...
  "sweetPieMinimumPlayersToStart": 5
  // ...
}
```

## sweetPieAllowCheats

Prevents the gamemode from disabling cheats. This setting is sweetpie only and does not affect vanilla server. Default is false.

```json5
{
  // ...
  "sweetPieAllowCheats": true
  // ...
}
```

## sweetPieChatSettings

Allows tuning settings related to in-game chat, such as message visibility radius.

```json5
{
  // ...
  "sweetPieChatSettings": {
    // Hearing distance in units. If player A says something and player B is farther away, they won't see that message.
    "hearingRadiusNormal": 123,
  },
  // ...
}
```

## sweetPieCommandEnabled

Enables or disables `/new2024` command that teleports player to SweetPie hall.

```json5
  // ...
  "sweetPieCommandEnabled": true
  // ...
```

## npcEnabled

Enables npc loading. Default is false.

```json5
{
  // ...
  "npcEnabled": false,
  // ...
}
```

## npcSettings

Optional npcs configuration. May not be present or can be an empty object which means all npcs are allowed to be loaded, provided `"npcEnabled"` is set to `true`.
`"NpcSettings"` consists of fields, each of which describes from what game file it is permitted to load an npc and additional restrictions of
how they should be spawned: in interior or exterior. By default all the npcs are allowed (`"npcSettings": {}`).
`"default":{}` field specifies `"spawnInInterior"` and `"spawnInExterior"` for all non-mentioned game files.

```json5
{
  // ...
  "npcSettings": {
    "default": {
      "spawnInInterior": true,
      "spawnInExterior": false
    },
    "Skyrim.esm": {
      "spawnInInterior": true,
      "spawnInExterior": false
    },
    "Dawnguard.esm": {
      "spawnInInterior": false,
      "spawnInExterior": true
    },
    "DragonBorn.esm": {
      "spawnInInterior": true,
      "spawnInExterior": true
    },
  },
  // ...
}
```

## weaponStaminaModifiers

This setting is only available with game mod file "SweetPie.esp".
This option allows you to flexibly adjust stamina forfeits of players' attacks using keywords set in the Creation Kit.
In case this field is not provided, some default, yet hardcoded, values are in use.

```json5
{
  // ...
  "weaponStaminaModifiers": {
    "WeapTypeDagger": 4.0,
    "WeapTypeShortSword": 5.0,
    "WeapTypeSword": 6.0,
    // ...
  }
  // ...
}
```

## additionalServerSettings

To automate the fetching of the latest server settings from GitHub, configure the additionalServerSettings in your server's startup script or configuration file as follows:

```json5
{
  // ...
  "additionalServerSettings": [
    {
      "type": "github",
      "repo": "your-org/server-settings-repo",
      "ref": "main", // Specify the branch, tag, or commit hash here
      "pathRegex": "^(common|indev)/.*", // No need to check for .json extension
      "token": "YOUR_GITHUB_PERSONAL_ACCESS_TOKEN"
    }
  ]
  // ...
}
```

## damageMultFormulaSettings
This setting allows you to control server damage mult formula through its variables.
If "damageMultFormulaSettings" is not present, the server will use some default values.

```json5
{
  // ...
  "damageMultFormulaSettings": {
    "multiplier": 1.0
  }
  // ...
}
```

## damageMultConditionalFormulaSettings

Named damage rules, each a multiplier applied when its conditions hold. Conditions use the server's condition functions (`skymp5-server/cpp/server_guest_lib/condition_functions`) with global form ids as parameters; `runsOn` is `Subject` (the attacker) or `Target`. Consecutive `OR` conditions form one group, groups are joined with `AND`. The hunter's Over Draw rule from the proficiency system, 20% more bow and crossbow damage against NPCs only (take the Hunter Master id from the `proficiency-ids.json` of the last plugin run: the full slot of `AlduinakAdditions.esp` followed by its local id `002032`, today `0x33002032` because `DynDOLOD.esm` is a full plugin loaded before it; a plugin added or removed before it moves the slot):

```json5
{
  // ...
  "damageMultConditionalFormulaSettings": {
    "hunterOverDraw": {
      "physicalDamageMultiplier": 1.2,
      "conditions": [
        { "function": "HasSpell", "runsOn": "Subject", "comparison": "==", "value": 1, "parameter1": "0x33002032", "parameter2": "0x0", "logicalOperator": "AND" },
        { "function": "SkympGetIsPlayer", "runsOn": "Target", "comparison": "==", "value": 0, "parameter1": "0x0", "parameter2": "0x0", "logicalOperator": "AND" },
        { "function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 7, "parameter1": "0", "parameter2": "0x0", "logicalOperator": "OR" },
        { "function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 7, "parameter1": "1", "parameter2": "0x0", "logicalOperator": "OR" },
        { "function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 12, "parameter1": "0", "parameter2": "0x0", "logicalOperator": "OR" },
        { "function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 12, "parameter1": "1", "parameter2": "0x0", "logicalOperator": "AND" }
      ]
    }
  }
  // ...
}
```

## Hunger and fatigue

All optional; see `docs/docs_roleplay_creations_and_needs.md` for the system. Hunger uses Survival Mode's scale, 0 (full) to 1000, and
fatigue maps onto its exhaustion scale, 0 (rested) to 960. What a food restores is not a setting: it comes from the food's
Survival hunger effect in the plugins.

| Key | Default | Meaning |
|---|---|---|
| `needsEnabled` | `true` | `false` switches hunger and fatigue off |
| `needsHungerDrainPerHour` | `125` | Hunger gained per online hour (full to starving in about 8 hours) |
| `needsHungerOffline` | `false` | `true` drains hunger while logged out too |
| `needsHungerStart` | `145` | Hunger of a new character; 145 is Survival Mode's starting value, in the Satisfied stage |
| `needsHungerStages` | `[80, 160, 340, 520, 770]` | Survival's stage values: Well Fed (after a meal empties hunger) ends at the first, Peckish, Hungry, Famished and Starving begin at the others; the second also starts the max stamina penalty |
| `needsHungerStageAbilities` | `true` | Grant the Survival hunger stage ability of the current stage |
| `needsFatigueCraftsPerHour` | `[6, 12, 18, 24]` | Recipes one full fatigue bar pays for at Novice, Adept, Expert, Master |
| `needsFatigueMemberMult` | `0.5` | Share of that cost a member of the bench's profession pays |
| `needsFatigueImperialMult` | `0.75` | Share an Imperial pays of every own-profession fatigue cost (crafts, warrior kills, woodworker swings, miner ore) |
| `needsFatigueRegenPerMinute` | `0.016` | Share of the bar refilled per minute |
| `needsFatigueOfflineRegen` | `true` | `false` refills the bar only while online |
| `needsFatigueFreeKeywords` | `["AldCraftingMead"]` | Bench keywords whose recipes cost no fatigue |
| `needsFatigueStages` | `[80, 160, 340, 560, 800]` | Survival's exhaustion stage values: Drained, Tired, Weary and Debilitated begin at the last four (the first only ends a sleeping bonus the server never grants); the second also starts the max magicka penalty |
| `needsFatigueStageAbilities` | `true` | Grant the Survival exhaustion stage ability of the current stage |
| `needsExhaustionMax` | `960` | Exhaustion of an empty fatigue bar (`Survival_ExhaustionNeedMaxValue`) |
| `needsPickFatigue` | `10` | Exhaustion harvesting a plant or a nirnroot costs, on the same scale; a bar that cannot pay refuses the harvest |
| `needsAttributePenalties` | `true` | `false` sends no max stamina or max magicka penalty |
| `needsSurvivalModeFlag` | `false` | `true` makes clients set the Creation's `Survival_ModeEnabled` to 1, only needed if the HUD draws the red penalty segments in Survival mode alone; it may bring Survival side effects such as arrow weight |
| `blockStaminaCost` | `0.1` | Share of max stamina a blocked weapon hit costs the blocker; applies with needs off too, `0` turns it off |
| `blockStaminaCostWarrior` | `0.05` | What a warrior pays instead |
| `blockStaggerWithoutStamina` | `true` | A blocker whose stamina is below the block cost still blocks that hit but is staggered on their own screen and on their copies (at most once a second, never while downed, mounted or seated); logs `[needs] <id> staggered: blocked without stamina`. Needs the matching client |
| `blockStaggerMagnitude` | `0.5` | The stagger's `staggerMagnitude`, clamped to 0.1 to 1 |

## Mastery, gathering and hunting

All optional; see `docs/docs_roleplay_mastery.md` for the system.

| Key | Default | Meaning |
|---|---|---|
| `masteryRankHours` | `[40, 100, 180]` | Worked hours for Adept, Expert, Master |
| `masteryPointIntervalMinutes` | `60` | Minimum gap between two counted hours |
| `masterySpells` | plugin markers | `{ "<profession>": [novice, adept, expert, master] }` form ids; a profession left out uses the plugin's `AldMastery_<Profession>_<Rank>` spells |
| `masteryActivities` | see `masterySystem.ts` | What counts as work per profession |
| `gatheringStrikeSeconds` | `5` | Seconds per chop or pickaxe strike |
| `gatheringVeinRespawnMinutes` | `1440` | Time for a fully mined vein to grow back |
| `gatheringVeinRegenMinutes` | respawn / vein total | Minutes per ore collection grown back |
| `miningVeinTiers` | iron, corundum open; gold, silver Adept; orichalcum, moonstone Expert; malachite, quicksilver, ebony Master | `{ "<ore editor id>": "Adept" }` overrides, by the ore item the vein hands out |
| `gatheringProduceContainers` | `{ "BeeHive": 60, "BeeHiveVacant": 60 }` | `{ "<container editor id>": minutes }`: placed containers of these bases never open; E hands over their yield and it grows back after the minutes. Replaces the default, `{}` turns it off |
| `gatheringProduceYield` | `{ "BeeHive": { "BeeHoneyComb": 2, "BeeHiveHusk": 2 }, "BeeHiveVacant": { … } }` | `{ "<container>": { "<item editor id or hex id>": count } }` handed over instead of the container record's own contents. A container whose items do not resolve keeps its record contents |
| `gatheringPickMinutes` | `60` | Minutes a picked nirnroot or ingredient-carrying critter (bees, fireflies) stays gone. The server disables the picked ref for everyone and enables it again when the time is up; `gathering-picks.json` in the server's working folder (beside `housing.json`) keeps the pending ones over a restart |
| `gatheringHarvestSeconds` | `5` | Seconds harvesting a plant or a nirnroot holds the picker kneeling, unable to move or harvest again. `0` skips the kneel. Catching a bee costs no fatigue and plays nothing |
| `huntingButcherChance` | `0.25` | Expert hunter: chance of one extra meat per kind an animal dropped |
| `huntingTrophyChance` | `0.15` | Master hunter: chance of one extra pelt per kind |
| `huntingPeltsNeedHunter` | `true` | Pelts on a dead animal, pets included, are left out of the loot window of anyone who is not a hunter, and a take or a put of one is refused. A pelt is any item carrying `VendorItemAnimalHide` plus the `huntingPelts` list. A non-hunter who owned the pet also stops seeing the pelts and leather they stored in it, and loses them when the body is removed on the `petCorpseSeconds` / `npcCorpseSeconds` timer |
| `huntingHarvestNeedsHunter` | `false` | Hides the meat as well, by the same rule |
| `huntingMeats`, `huntingPelts` | vanilla and DLC lists | Editor ids of what counts as meat and pelt |

## enableGamemodeDataUpdatesBroadcast

A boolean setting that controls hot-reloading behavior for connected clients.

* `false` (Default): Updates to gamemode scripts are applied to the server state but **not** broadcast to currently connected players. Existing players must re-login to receive the update. This ensures client stability if scripts do not support hot-reloading.
* `true`: Updates are immediately broadcast to all connected clients. Useful for local development, but may cause desync or client errors if the scripts are not designed to be re-applied at runtime.

```json5
{
  // ...
  "enableGamemodeDataUpdatesBroadcast": false
  // ...
}
