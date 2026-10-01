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

Sets the connection limit of the server, at most the native build's `MAX_PLAYERS` (1300, `skymp5-server/cpp/CMakeLists.txt`); a higher value refuses to start. With `playerSlots` set, the connections above it are queue room, and the master heartbeat reports `playerSlots` as the limit the launcher shows.

Lowering `maxPlayers` caps RakNet itself: a connection above it is refused with "No free incoming connections" before the login or the queue see it, the server logs nothing, and the client's login widget only reads "The server is full, retrying..." until the watchdog's next attempt (every 10 s) gets in. Test the queue with `playerSlots` (and `queueStaffBypass`), never with this key; the boot line `QueueSystem: N play slots of M connections` shows both, and `[queue] off: playerSlots equals maxPlayers` or `[queue] playerSlots N is above maxPlayers M: clamped` flags the mistake. The manager's Settings tab labels this key "Max connections".

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

`FLOR` and `TREE` are the alchemy plants (flowers, bushes, mushrooms, apple trees): a harvested plant grows back after that many milliseconds, natively, and `gatheringSystem.ts` reads that native harvested state (Papyrus `IsHarvested`) to decide whether a harvest is charged. The live file sets both to `1800000` (30 minutes) since r15; without an entry the native default is one hour.

`DOOR` is worth a short entry too, `5000` for example: a load door is marked open on the server when a player goes through it and every client swings it open until the reloot closes it again, so without the entry a used load door stands open for an hour.

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

## torchBurnMinutes

Minutes of use after which a held torch burns out (default `15`, fractions
allowed; `0` turns it off). `TorchSystem` counts on the server: any carryable
light (`LIGH`) worn in the character's equipment reports is a lit torch, and
the clock runs only while its player is connected and holds it (character
select stops it at the menu request itself, also when the spawn guard skips the
logout grace for a request within 10 s of the assign or 15 s of the last one).
The burned time belongs to the character, not to one torch:
it is saved in `private.torchBurnMs` once a minute, on unequip, on logout and
at character select, carries over relogs and restarts, and starts again from 0
after a burn-out. At the limit the server unequips the torch on the player's
client (Papyrus `Actor.UnequipItem`), takes one of that torch out of the
inventory, shows "Your torch burns out." and logs
`[torch] <actor> [profile <id>] "<name>": torch <base> burned out after 15 min of use, <n> left`.
Lighting and putting out log `[torch] <actor> lights <base>, <x> of 15 min burned`
and `[torch] <actor> torch <base> unequipped|offline at <x> of 15 min`; boot logs
`[torch] a held torch burns out after 15 min of use`. The engine has its own
burn timer, the `LIGH` record's Time (240 s for `Torch01`, `Torch01Shadow` and
`SovngardeWarmLight`, 180 s for `DLC1Torch`); `AlduinakAdditions.esp` (from
r24, `overrides.lights` of the patcher spec) overrides those four records with
Time 36000 (10 h) so only the server burns a torch out, which keeps the setting
meaningful up to 600. With a plugin that lacks the override the engine takes
the torch out of the hand after 3 or 4 minutes, the next inventory apply gives
it back unequipped, the server logs it as `unequipped` and the player has to
light it again to use up the rest.

```json5
{
  // ...
  "torchBurnMinutes": 15
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

Defaults to three doors:

- the Thalmor Embassy party room's south west door (`7C98E:Skyrim.esm`), whose
  vanilla pair leaves the player in the room, redirected to the courtyard outside
  the embassy front door;
- the Temple of Jhunal tower pair of Winterhold Restored, both outside in Tamriel
  1111 units apart: the door at the foot (`f058c4:Winterhold Restored.esp`,
  MWRJhunalTowerDoor01Ref) lands on the balcony's XMarkerHeading `f058aa` and the
  balcony door (`f058c5`, MWRJhunalTowerDoor02Ref) at its plugin arrival, each 64
  units above the floor. The plugin's arrivals sit exactly on the floor, and a move
  within one worldspace has no loading screen to settle the player, so a landing
  that starts inside the balcony drops them down the tower to their death.

Giving the key replaces that list, so a configured list that should keep them
repeats them; `[]` turns the overrides off.

The override applies only to the connected player who pressed the door, only
once the lock, faction and job checks of the normal door path have allowed the
activation, and it replaces the door's own teleport rather than adding to it. A
pet or a companion following its owner through keeps the plugin destination.

Overridden or not, every door press by a connected player that reaches the
system is logged as `[doors] <actor> (<name>) pressed <door>`, once per second
per player; a press missing there never reached the server or was refused by a
lock, a faction or the native side (`WorldSpace doesn't match`, logged by the
server itself).

The client drops a press on a door that is still swinging, so it cannot reverse
the swing, except on a load door: the first such press on a plugin door asks the
server (`loadDoorQuery`), which answers from the door's XTEL or this list
(`loadDoorAnswer`), and a load door gets the dropped press sent at once and every
later one straight through. A plain door stuck mid-swing takes a second press
1.5 s after the first ignored one; an ignored press older than 5 s starts that
wait over.

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

## leverLinks

Levers that open or close a gate or door the plugin wires through markers the
server never loads. The server skips every STAT reference, XMarkers included,
so a lever script that reads or activates one moves nothing but the lever. One
entry per gate: `levers` lists the placed levers, `target` the placed door or
gate they move; both take a number, a `"0x..."` string or a `"hex:File.esp"`
descriptor. With `all: true` every lever of the entry must have been pulled once
before the target moves; after that each pull toggles it. A `DOOR` target
toggles its native `isOpen`; any other target plays `openAnim` / `closeAnim`
(default `open` / `close`, the default2StateActivator names), which the server
keeps for players who arrive later. Pulls are stored on the levers and a
door's `isOpen` on the door, and both survive a restart; any other target loads
closed after a restart (its animation is not saved), so the next pull opens it. Only a connected player's pull counts, once the
other activation checks allowed it, and a target moves at most once every 3 s.
Each pull is logged as `[levers] <player> pulled <lever>, ...`.

Defaults to Soljund's Sinkhole: soljundLever `5ebe3` and `5ebe4` run
soljundMasterScript, which disables one XMarker per lever and opens portcullis
`5ebc0` through a third once both are down; here both levers open the
portcullis once each has been pulled. Giving the key replaces the list; `[]`
turns the links off.

```json5
{
  // ...
  "leverLinks": [
    { "levers": ["5ebe3:Skyrim.esm", "5ebe4:Skyrim.esm"], "target": "5ebc0:Skyrim.esm", "all": true }
  ]
  // ...
}
```

## keySplitOnLogin

`false` (default) leaves a stack of property keys cut before keys were
numbered (`Property Key (TAG)` xN) as it is. `true` splits such a stack into N
keys named `Property Key (TAG/n)` when its holder's actor is assigned at login
(`docs_roleplay_property_factions.md`). Turn it on only after the client with
the new `SkyrimPlatformImpl.dll` (the `ExtraTextDisplayData::IsNotEqual` hook)
has shipped and two differently named keys stay separate in game: a client
without it merges the split keys back into one engine stack, and its put/take
requests then fail with "Source inventory doesn't have enough 0xdb0e2". The
split cannot be undone. Read at startup; the boot line `[housing] ready`
says whether stacks are split or kept.

```json5
{
  // ...
  "keySplitOnLogin": true
  // ...
}
```

## playersInheritBaseSpells

`true` (default) keeps the Player record's castable spells (Flames, Healing)
and the race's powers on every player character (`AlduinakAdditions.esp` leaves
the playable races only Khajiit Night Eye). `false` makes characters start
without them; abilities such as the combat heal rate, racial passives (the
race speed abilities `AldRaceSpeed_*` among them) and lesser powers (Khajiit Night Eye) stay,
and spells learned in play (tomes) are kept. The client drops the withheld spells from its own spell lists at
spawn and after the race menu, always from the list the server sent last. Read by the native server at boot.

The client applies the race's abilities again 6 s after each spawn, game load, resurrect and race menu (with no
race, loading or Magic menu up) and writes to the Platform log `race abilities after <reason> ...: before ... |
after ...`; the first Magic menu open per spawn, then at most one a minute, writes `race abilities in the Magic
menu ...` with what that menu shows. Each race spell reads on, off or power, held or not held (Papyrus `HasSpell`,
which the Magic menu reads) and unlisted when the server's list lacks it; the race's speed spell reads
`SpeedMult <now> of <expected>`; other races' spells still running or held are named; the line ends in
`all in place` or `amiss: ...`, and a Magic menu line that ends amiss has the abilities applied again once the
menu closes.

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

Faction-only doors and containers come from `faction-access.json` next to `gamemode.js`, not from this file.

## Bleedout and execution

All optional; see `docs/docs_roleplay_survival_loop.md` section 8 for the system. A player at 0 health bleeds out only with the native server build that fires `onKillAttempt`.

World floor (no setting): a living player below Z -40000 in Tamriel or below -30000 in any other cell or worldspace has fallen through the world. The server kills them (`[floor]` and `[bleedout] ... fell out of the world` log lines, the `[death]` line) and they respawn in the nearest temple after `respawnSeconds`, also after a relog into a saved void position.

World border (no setting): the regions come from the REGN records flagged Border Region in the load order (`[border] N border region(s) over M worldspace(s)` at startup). A living player seen outside every border region of their worldspace on two polls in a row (500 ms apart) is moved back to their last spot inside, or to the nearest start location, and told "You cannot go that way." (`[border]` log line). A character saved outside is placed back inside at login (`[spawn] ... was saved outside the border`). Admins in NoClip are exempt.

| Key | Default | Meaning |
|---|---|---|
| `bleedoutSeconds` | `15` | Seconds a downed player has before dying, unless healed, captured or carried |
| `bleedoutHealedHealth` | `0.25` | Share of max health that ends a bleedout when healed back to it |
| `executionBlockBaseIds` | `[0x2E8EB, 0xFE549]` | Base form ids (numbers or `"0x..."` strings) of the furniture that counts as an execution block |
| `executionBlockOffset` | `{ "forward": 87.7, "right": 68.8, "up": 0, "yaw": 270 }` | Where Prepare Execution puts the prisoner, relative to the block: along its facing, across it, up, and degrees added to its yaw. The default is the prisoner's marker of `Furniture\HeadChoppingBlock.nif`, where the vanilla block kneel `IdleExecutioneeIdle` lays the head on the block in front of the headsman, who stands on the block's origin |
| `finishOffMaxMs` | `9000` | Cap on a finish off or assassination killmove: the victim dies when a participant's client reports the end of the pair, or after this. A block execution has its own fixed timing (the kill 14.84 s after Execute, as the head comes off at the chop clip's `Decapitate`, 1.7 s later when a participant's client has to send the prisoner's chop again) |
| `finishOffExtendedPool` | `false` | Adds the killmove tree records, whose conditions the engine may refuse, to the finisher pools; a probe, see docs_roleplay_survival_loop.md section 8 |
| `finishOffStandUp` | `true` | The finish off stands the victim up and plays a standing killmove once the get-up settled; `false` keeps them kneeling and plays the one-handed KillingBlow stab at once (no decapitation, no variety). Read at start, so a change needs a game service restart and no build |
| `executionFinishers` | see section 8 | The finish off pools per weapon type, `{ "sword": [idle form ids], "dagger": [], "axe": [], "mace": [], "greatsword": [], "battleaxe": [], "dual": [], "unarmed": [] }` (numbers or `"0x..."` strings, loose `pa_` IDLE records of that weapon state); a type given replaces its default pool, the others keep theirs. Sword and dagger share the blade pool (`F469B`, `F469D`, `108A45`), axe and mace share `F469A` and `F469C`, dual is `F469F` and greatsword the stab `F4687`; battleaxe is empty and borrows the greatsword pool, unarmed has nothing (refused). Overriding one type never changes another that shares its default pool. Read at start |
| `executionSneakFinishers` | one-handed and dual: `pa_1HMSneakKillBackA` F4679, `pa_1HMKillMoveBackStab` F465A; the others the finish off defaults | The assassination pairs per weapon type, same shape as `executionFinishers`; a type given replaces its default pool. Read at start |
| `bodyMaxSeconds`, `bodyIdleSeconds` | none | No longer read (2026-10-01, the owner's rule): the body a PK leaves has no lifetime and lies, across restarts, until it is emptied, keys and writings included; it is removed at the next 2 s check once no stack a search window can show is left in it and it has lain at least 60 s since the death (`docs_roleplay_survival_loop.md` section 8). A leftover key is harmless. The body carries the neighbor-visible `ff_body` property, registered in the test gamemode's `build/dist/testserver/gamemode_extensions/50_properties.js` (gitignored) with the same `makeProperty` line as `ff_pet` (`docs_roleplay_pets.md`), built with Build gamemode only and carried to live by Migrate server; without it every PK logs `[body] leaving a body for <victim> failed setting ff_body` and the victim keeps the pack |

## Carry pose

A carried player or pet sits in the vanilla chair sit idle held in the carrier's arms and turns with the carrier: every client holds its copy of the body on its own copy of the carrier every frame, through SkyrimPlatform's frame-start hold where the client has it (`docs_roleplay_survival_loop.md` section 10). `CaptureSystem` sends the pose to the carried player's client (`restraintState`), to the carrier's client for a carried pet or NPC (`carryState`), and to everyone else in the neighbour-visible `ff_carriedBy` property, and uses it for the door teleport. The carried client logs the body's pelvis and the carrier's hands relative to their roots 1.5 s into each carry (`carry nodes` in `skyrim-platform.log`), which is what these offsets are tuned from. Every key is optional and read at server start, so a change needs a game service restart and no build. A replacement idle must be in the client's `restraintPosesLowerCase` and `actorSitAnimsLowerCase` lists (`sync/animation.ts`) so viewers' copies turn by `setAngle` and drop collision like the chair idle. An idle with an enter clip, such as `IdleLayDown` (a 3.2 s stand-to-lie clip before its loop), shows only its first part whenever it is sent again before the clip ends.

| Key | Default | Meaning |
|---|---|---|
| `carriedAnimEvent` | `IdleChairEnterInstant` | Animation event the carried body plays; `IdleLayDown` (the emote wheel's Lay Down) lays it down instead |
| `carryOffsetForward` | `16` | Units ahead of the carrier, inside the carrier's own capsule so the held body never pokes through a wall or a bar door |
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

## dailyRestartAt

No longer read. The scheduled restart (and any other timed say, console command, start
or stop) is set in the Server Manager's **Schedule** tab, stored in
`C:\logs\manager\schedule.json` with its own time zone (default `America/New_York`);
see `server-manager/README.md`. A leftover key is harmless.

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

With `characterSelect` on, how many living characters a profile may hold (1-10, default 3; staff use `characterSelectStaffMaxCharacters` instead). A character in Sovngarde or the Soul Cairn, or a perma-dead one, no longer counts: it stays listed and one more slot opens, up to 10 slots. Deleting it closes that slot again, and so does a staff revive (admin panel Players sub-tab or the Server Manager Players tab), which is refused while the living count is at this limit. Characters never change slot, so a gap a deleted character leaves before a living one stays hidden while the living limit is reached.

## characterSelectStaffMaxCharacters

The living limit of every admin tier (`adminRoles` senior, developer and gm, plus `adminProfileIds`; 1-10, default 3) in place of `characterSelectMaxCharacters`. The tier comes from the Discord roles of the login, so a role change takes a relog; the afterlife extra slots and the revive refusal follow the same number. A staff member who loses the role keeps every character but creates none past the ordinary limit.

```json5
{
  // ...
  "characterSelectStaffMaxCharacters": 3
  // ...
}
```

## afterlifeLooks

Optional. What a fallen character looks like and wears in its realm (`docs_roleplay_foundations.md` section 4). One entry per realm, `sovngarde` and `soulCairn`; a realm or a key left out keeps its default, so `"sovngarde": { "look": "AbFXSovengardeGlow" }` keeps the Ancient Nord outfit; `"look": ""` drops the look and `"outfit": []` the outfit. `look` (or `shader`) is an EFSH, played on the character for everyone through the neighbor-visible `ff_afterlife` property, or a SPEL added as an ability; `outfit` lists ARMO records given and put on; `alpha` (0-1, default 1 for Sovngarde and 0.25 for the Soul Cairn, the Dawnguard ghost's value) is the character's opacity while an EFSH look plays; anything but a number from 0 to 1 (`null`, `""`, `false`, `2`) is logged `[afterlife] <realm> alpha <value> is not a number between 0 and 1, the default <a> is used` and the realm's default applies. Every name is an editor id, a `hex:Plugin.esm` desc or a hex id, resolved at start (a game service restart, no build); misses and other record types are logged and ignored. `ff_afterlife` is registered in `build/dist/server/gamemode_extensions/50_properties.js` (live file) with the same `makeProperty` line as `ff_pet` (`docs_roleplay_pets.md`), built with Build gamemode only before the server build.

```json5
"afterlifeLooks": {
  "sovngarde": { "look": "SovengardeFXS01", "outfit": ["ArmorDraugrCuirass", "ArmorDraugrBoots", "ArmorDraugrGauntlets", "ArmorDraugrHelmet"], "alpha": 1 },
  "soulCairn": { "look": "DLC1SoulCairnGhostFXShader", "outfit": ["ClothesPrisonerRags", "ClothesPrisonerShoes"], "alpha": 0.25 }
}
```

## logoutGraceMs, logoutPose

A character's body stays in the world for `logoutGraceMs` (default `300000`, five minutes) after a disconnect, a quit to the main menu or a switch to another slot, so leaving is never an instant escape; re-selecting the character cancels the grace and stands the body up: the server broadcasts `IdleForceDefaultState` to everyone who sees it (their copies get their collision back) and clears the stored event before the player is handed the body, so the `CreateActor` sent to viewers carries no sit pose, with the line `[spawn] <id> unparked`. When the grace runs out instead, the body is disabled and the stored pose is cleared with it (a disable alone keeps it, and the next `CreateActor` would carry it), so a later select of the character also streams a standing body. For that time the body sits down in `logoutPose` (default `"IdleSitCrossLeggedEnter"`, the emote wheel's Sit Crossed; `""` leaves it standing), sent by the server to everyone who sees the body and to anyone who walks in later, with the line `[spawn] <id> parked in <pose>`. A downed, bound or carried body keeps its own pose. No client hosts a parked body (`HostingSystem.mayHost` refuses a living player character without a user), so a neighbour's engine never replaces the pose or clears it with a movement report; hits on the body are server-resolved and need no host. The pose needs the native server build that accepts `mp.set(actorId, "lastAnimEvent", ...)`; an older build logs `[spawn] parking pose ... failed` and the body stands.

The body sits the moment the server learns of the disconnect: at once on a quit to the main menu or a kick, and within about 10 s of a crash, an Alt+F4 or a dead link, because both the server and the client drop a silent connection after 10 s (`Networking.cpp` `timeoutTimeMs`, `MpClientPlugin.cpp` `kTimeoutMs`, RakNet's own default; keepalives run on RakNet's thread, so loading screens never trip it). A client that leaves on purpose destroys its RakNet peer with a 200 ms grace so the server receives the disconnect notification and frees the slot immediately instead of after the timeout. Such a timeout also logs `Networking: user N timed out without a disconnect notice` next to `disconnect N` (a clean quit through the Alduinak Quit buttons logs only `disconnect N`), so that line a few seconds after `Creating character` or `Loading character` means the game closed during the spawn load.

## afkKickMinutes, afkWarnMinutes, afkDebug

`afkKickMinutes` (default `20`, `0` disables the whole system) is how long a player may go without activity before `AfkSystem` kicks them with "You were disconnected after N minutes of inactivity."; the body stays for the `logoutGraceMs` grace. Activity is (2026-09, B5): a move of 32 units or a turn of 10 degrees since the last counted position sample, or a cell change (movement packets never reach TS, so the position is polled every 15 s; less is jitter, a snap or a looped animation); a packet the client only sends on a key press or a menu click (`ACTIVE_PACKET_TYPES` in `afkSystem.ts`: the push-to-talk `afkPing`, admin actions, trade, housing, pet, companion, job, bounty board, writing, search, capture, execution, death, character select and creator, mastery choice, faction and player menu packets, load door queries); a chat line; a craft; an activation of anything but furniture, unless the same target was activated less than 2 s before; every repeat restarts that window, so a client looping E on one target counts once, and furniture (benches, chopping blocks, chairs) never counts, since the crafts made there do and a client's Activate storm at a chopping block comes in bursts. Everything the client sends on its own (seat claims, `craftedExtras`, weather, needs, time, admin menu, mastery info, faction menu and debug requests, teleport reports, `invokeAnimResult`, `pairedIdleDone`, knowledge) counts for nothing. While the client holds a seat claim (crafting stations, chopping blocks, mining markers, chairs and beds) the position is not compared at all, so a looping crafting animation cannot re-arm the timer; the claim ends when the client releases it or the actor is more than 48 units from where they sat. Players in the login, character select or character creation screens are never kicked. `afkWarnMinutes` (default `1`) is how long before that kick the player is warned once per idle period with "You will be kicked for inactivity in N minute(s). Move or chat to stay connected.", a chat line in the System tab that pulls the tab into focus when the chat input is not in use; any activity re-arms the warning. The kick line names the last activity: `AfkSystem: kicking user N (actor X) after M min idle, last activity <channel> at <hh:mm:ss>[, seated at <furniture>]` (the server's local time, like the log's own stamps). `afkDebug` (default `false`) logs `AfkSystem: user N (actor X) kept alive after M min by <channel>` whenever activity lands on a user idle for 10 minutes or more, so the live log names what keeps a parked player online. All keys are read at boot and the boot log prints `AfkSystem: kicking after K min, warning W min before, ...`.

## playerSlots, queueGraceMs, queueStaffBypass

`playerSlots` (default `maxPlayers`, which turns the queue off) is how many verified logins may play at once; `maxPlayers` stays the connection cap, so the difference is the number of players the queue can hold (live: 1200 of 1300). A login past the limit waits in arrival order and sees "You are N of M in the queue", the time waited and a rough estimate instead of the character select; the server re-sends the place every 5 s, which also keeps the idle connection alive. Staff (`adminRoles` tiers, `adminRoleIds`, `adminProfileIds`) never wait, may exceed `playerSlots` up to `maxPlayers` and take no play slot, so a slot freed while staff are online still goes to the head of the queue. A slot is held from admission until the connection ends, so a player parked in the character select keeps it and a quit to the main menu holds it for the `logoutGraceMs` body as well. `queueGraceMs` (default `120000`) keeps a disconnected player's slot, or their queue place, for that long, so a crash inside it skips the queue on the way back; a second connection of the same account while the first still lingers takes the slot over at once. The heartbeat carries `playerSlots` as `maxPlayers` and the number of connected waiting players as `queued` (a place kept for a dropped player is not counted, nor shown in another player's total), so the launcher badge reads "N PLAYERS · Q QUEUED" and `/api/status` returns `queued`. The queue is in memory: a restart re-queues everyone in reconnect order. Log lines start with `[queue]`: every admission that is not a plain free-slot login prints `[queue] profile P admitted (staff | takeover | kept slot | slot freed) after N s, W waiting`, so a staff login into a full test server is visible.

`queueStaffBypass` (default `true`, also when the key is absent) is the test switch: `false` makes staff wait like everyone and take play slots, so the queue can be tested with a staff account. The boot then logs `[queue] queueStaffBypass false: staff wait like everyone`. Leave it absent or `true` for launch, or staff cannot enter a full server. To test, keep `maxPlayers` where it is (lowering it caps RakNet, see above), set `playerSlots` to 1 or 2 and either use accounts without a staff role or set `queueStaffBypass` to `false`; the manager's Settings tab exposes all three as "Play slots", "Queue grace (ms)" and "Staff skip the queue" under Identity, all read at boot.

```json5
{
  // ...
  "maxPlayers": 1300,
  "playerSlots": 1200,
  "queueGraceMs": 120000,
  "queueStaffBypass": true
  // ...
}
```

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

The key is optional. Without it the server uses the seven built-in locations below (Tamriel, angle 0). `[]` turns the intro off, so an Empty slot creates at once at a `startPoints` entry. A malformed list logs a warning and keeps the built-in locations. `angleZ` defaults to 0 and `worldOrCell` to `0x3c`. Edit it in `server-settings.json` on the server and restart the game service.

A character whose creation is unfinished (`private.creationPending`, set at creation and cleared when the race menu is accepted) neither takes nor deals weapon or spell damage.

```json5
{
  // ...
  "startLocations": [
    { "id": "dawnstar-docks", "label": "Dawnstar Docks", "pos": [27167.60, 110262.89, -13909.25], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "hammerfell-gate", "label": "Hammerfell Gate - Falkreath", "pos": [-51425.53, -99716.02, 1068.29], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "pale-pass", "label": "Pale Pass - Helgen", "pos": [27471, -115853, 20361], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "morrowind-gate", "label": "Morrowind Gate - Riften", "pos": [212996.14, -111249.54, 8059.13], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "solitude-docks", "label": "Solitude Docks", "pos": [-63893.07, 95463.61, -13936.59], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "dunmeth-pass", "label": "Dunmeth Pass - Windhelm", "pos": [174009.45, 38223.89, -9091.38], "angleZ": 0, "worldOrCell": "0x3c" },
    { "id": "druadach-pass", "label": "Druadach Pass - High Rock", "pos": [-159824, 94571, -8524], "angleZ": 0, "worldOrCell": "0x3c" }
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

The Discord bot integration. `botToken` is the bot's token, so keep this key secret. For each entry in `guilds`, login checks membership and `banRoleId`, and `DiscordBanSystem` kicks players who get the ban role. `eventLogChannelId` receives the game alerts below. Leave `eventLogChannelId` out (or turn on `offlineMode`) on a test server, so it posts nothing to the live channel.

Game alerts (`skymp5-server/ts/systems/discordAlerts.ts`) are batched and posted every 2 seconds, so a burst arrives as a few messages. Player text cannot ping anyone or use Discord formatting, and links do not unfurl into previews. Only the kinds listed in `discordAlertKinds` are posted, default `["admin", "execute", "ticket"]`; the key is read at boot and a non-empty list replaces the default, so `keyword` and `login` are off unless listed. The boot line `[discordAlerts] posting admin, execute, ticket` names the kinds in use, and a name that is no kind (`death` included) is reported as `[discordAlerts] discordAlertKinds names no such kind: ...` and dropped. A line repeated right after itself inside one 2 second batch goes out once with `(xN)`; a repeat with other lines in between is posted again, so the order of the actions stays true. A burst past 40 lines ends in one "N more alert(s) skipped" line. The `execute` lines also go to every online staff member's in-game Admin tab, listed or not, through the gamemode's `globalThis.__alduinakStaffLine(label, text)` (`35_admin_chat.js`, which the staff calls use too); a gamemode without that hook shows no [Execution] or [Death] line there. The tab also shows console commands and `/system` broadcasts as [Log] lines (`20_logging.js`) and player kills and hits as [PvP] lines (`55_death.js`, `60_admin_modes.js`), which also go to `admin.log` and `pvp.log`.

Deaths are never posted to Discord. Every player death, with the killer (player or NPC, if any) and the place (the nearest map marker outdoors, the cell indoors, then the raw location), is printed to the server log as `[death] <player> <how>[, killed by <killer>], <place>` and shown as a [Death] line in every online staff member's Admin tab. A bleedout death says how it happened (bled out, died of their wounds while bleeding out, logged out while bleeding out, was finished off, was smitten) and names the player who landed the finishing hit. The kinds posted:

- **[Execution]** (`execute`) execute, finish off and a staff PK. The killing code calls `globalThis.__alduinakMarkDeathAlerted(actorId)` first, so the same death shows no second [Death] line.
- **[Staff call]** (`ticket`) `/gm`, `/ticket`, `/pray` and `/prayer <message>`, with `@here` and a mention of the player. The same line goes to the in-game Admin tab, which players still cannot read, and each player may call once a minute. Staff and players may `/pm` each other without an introduction, so a ticket can go back and forth. For the `@here` to ping, the bot needs the Mention @everyone, @here and All Roles permission in that channel.
- **[Admin]** (`admin`) every admin panel action (teleports, summon, kick, ban, revive, item spawn, mastery, attribute and pet grants, polymorph and its manual revert, npc zones, jobs, weather, admin modes, refused actions), staff writing actions, `/system` broadcasts, and faction changes made with staff powers rather than a rank of the actor's own. A PK posts as [Execution] instead. Every one of these lines, PK included, is written to `admin.log` in `logDir` whether or not it is posted; of them only the `/system` broadcasts also reach the in-game Admin tab, as [Log] lines.
- **[Keyword]** (`keyword`, off unless listed) any chat line, PMs included, that contains a word from `alert-keywords.json` in the server folder. Staff `/admin` and `/system` lines are not scanned. The server re-reads the file within 5 seconds of a save. It holds `keywords` (whole words or phrases, ignoring case; a trailing `*` matches any ending) and `cooldownSeconds` (default 60, per player and keyword). The seed with notes is `skymp5-server/seeds/alert-keywords.json`. Without the file, keyword alerts are off.
- **[Login]** (`login`, off unless listed) the `Server Login` line of every verified login (slot, IP, actor ids, profile id) with a mention of the player. The same line is always printed to the server log.

```json5
{
  // ...
  "discordAuth": {
    "botToken": "<bot token>",
    "guilds": [{ "guildId": "<guild id>", "banRoleId": "<role id>", "eventLogChannelId": "<channel id>" }]
  },
  "discordAlertKinds": ["admin", "execute", "ticket"]
  // ...
}
```

## Admin roles

Every player opens the Personal Menu with the interact key (X by default) while looking at nothing, a world NPC or anything else that is not a player, door, container or bounty board. It has four tabs, in this order:

- **Admin**, shown only once the server confirms the player's admin tier, with the sub-tabs:
  - Players: roster, teleport to, summon, Reset needs (the selected online character's hunger and fatigue go back to the new-character values, `needsHungerStart` and a full fatigue bar, with the stage abilities and penalties following at once; logged `[needs] <actor> reset by profile <id>` and in admin.log; answered "Needs are switched off on this server" while `needsEnabled` is `false`), kick, PK (the selected online character dies, leaves a body and goes to Sovngarde, the finish off PK, see `docs_roleplay_survival_loop.md` section 8), ban, mastery grant and reset, a permanent max health, magicka and stamina change of the selected online character (-1000..1000 each, absolute not additive, 0 for the plugins' own values; it is stored on the character, survives a relog and the hunger and fatigue penalties recompute against the new maximum), and Revive for the selected profile's fallen characters (Sovngarde, the Soul Cairn or perma-dead, online or not; refused while a character made in the extra slot is alive, see `docs_roleplay_survival_loop.md` section 8);
  - Teleport: named locations, map markers and temples in collapsible sections;
  - Modes: God, NoClip, Invisible, Ghost, Freecam (the movement keys fly the camera while the character stays put; toggled here, no console needed; X always opens this menu while it is on, and it ends when turned off, on logout, on a character switch, on death or on respawn), Smite, Heal on Hit, Speed (raised movement speed that ends when turned off, on logout, on a character switch or on respawn) and Show account name (while it is on, everyone near the admin sees the admin's own account name on the admin's floating tag in place of the character name, so players know they are dealing with staff and not a character: red for the senior tier, blue for developers, green for GMs; it shows whatever the viewer's chat name toggle or introductions say, through sneaking, a mask (`SweetHidePerson`) or invisibility, within the usual 1000 units and line of sight, and an Invisible admin stays hidden; off restores the character tag, and on a character switch the tag leaves the old character and, with the mode still on, goes to the new one. It rides the neighbour-visible `ff_adminTag` actor property, `{ n: account name, t: senior | developer | gm }` while on and `null` while off, registered in `build/dist/server/gamemode_extensions/50_properties.js` (live file) with the same `makeProperty` line as `ff_adminModes`, built with Build gamemode only);
  - NPCs: list, add, teleport to, reset and delete the spawn zones of `NPC-Spawns.json`, see `docs_roleplay_npc_spawns.md`, grant pets, and place, teleport to either end of and delete the passive jobs of `Jobs.json`, see `docs_roleplay_jobs.md`;
  - Item Spawner, see below;
  - Weather: every weather region with its current weather, the time left, the players in it and the one the admin stands in; force a weather on a region until cleared or for a number of minutes, and clear it, see `docs_roleplay_weather.md`;
  - Polymorph: turn yourself or the online player selected on the Players tab into any race of the load order with a skeleton, and Revert; races known to crash are marked, and logout, a crash, character select and a restart revert on their own, see `docs_admin_polymorph.md`.
- **Faction**: the character's factions with roster, promote, demote, set rank, remove, leave and the /f chat choice, see `docs_roleplay_property_factions.md`. Hold uniforms are crafted by the Captain (and the Jarl or an acting regent), never issued.
- **Skills**: the mastery (craft) menu.
- **Debug**: account and character name, server-side FormID, server name, position, cell id and name, heading, the distance to whatever the player faces (the crosshair when it picks something, otherwise the loaded cell's ref nearest the screen centre, so statics, trees and other scenery read too; it re-reads once a second while the tab is open and within a quarter second of a crosshair change, and a target the crosshair leaves stays on screen marked "last seen" until the menu closes; a player character you were not introduced to reads Stranger or Body, as on the interaction prompt), the target's ref id with its `hex:Plugin` desc, its position and cell, and its base id with its desc (the ref id is always the server's id, so a player character reads its character id, the actor id of the Players tab and the server logs, and a synced NPC its server id; each client spawns other players and server NPCs as its own `ff` copies, whose local ids differ from client to client and mean nothing to the server, so they are never shown; only a ref the server does not know shows the client's id, marked "client only"; a ref created in game shows the server's base from the world model (`7:Skyrim.esm` for a player character), plus the client's own base when that differs and is a plugin record; another player's character shows its id to staff only, since it would follow a masked character, the same rule as the name tag's id line; the body a PK leaves wears the victim's look but reads "body" with its own id, which BodySystem logs and the Players tab does not list), a Copy IDs button that puts one line on the clipboard (name, ref id, or "character" or "body" and the id for a player or a body, base id, cell and position; the descs paste straight into the Item Spawner search), magicka/health/stamina, the Tamrielic game date, local and server clocks and the active effects the client has seen start.

Admins also get the admin chat channel. Nobody gets the server console commands (`additem`, `equipitem`, `placeatme`, `disable`, `markfordelete`, `mp`), admins included: AdminSystem clears `consoleCommandsAllowed` whenever a character is assigned, so keep `enableConsoleCommandsForAll` off. The client closes the local ~ console and refuses the local cheat commands for everyone, admins included (`ConsoleBlockService`), so every admin mode, Freecam included, is toggled from Admin > Modes. This is client-side enforcement; the server checks stay the authority. Admin rights come from Discord roles, resolved into one of three tiers by `skymp5-server/ts/systems/adminRoles.ts`.

Each Admin sub-tab needs a cap. A sub-tab shows only when the tier has its cap, and the server refuses every request the tier lacks the cap for, with an admin.log line.

| Tier | `players` | `teleport` | `modes` | `npcs` | `items` | `kick` | `ban` | `factions` | `weather` | `polymorph` |
|---|---|---|---|---|---|---|---|---|---|---|
| `senior` | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| `developer` | yes | yes | yes | yes | yes | no | no | yes | yes | yes |
| `gm` | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |

`players` covers the Players sub-tab, `teleport` the Teleport sub-tab, `modes` the Modes sub-tab, `npcs` the NPCs sub-tab, `items` the Item Spawner, `weather` the Weather sub-tab (`weatherList`, `weatherSet`, `weatherClear`) and `polymorph` the Polymorph sub-tab (`raceList`, `polymorph`, `polymorphRevert`). `kick` is the Kick and PK buttons and `ban` the Ban button; all three also need `players`. `factions` lets staff see and manage every faction in the Faction tab, the leader rank included. `adminTierCaps` changes the defaults per tier.

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

Optional per-tier overrides of the caps above, merged over the defaults (every cap on, except `kick` and `ban` for `developer`). Only the tiers `senior`, `developer` and `gm` and the caps `players`, `teleport`, `modes`, `npcs`, `items`, `kick`, `ban`, `factions`, `weather` and `polymorph` with `true` or `false` apply; anything else is ignored and logged once at boot. A change needs a restart.

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

A spawn gives 1 to 1000 of the chosen item to the admin or to any online player, at most once per 250 ms. Every spawn is written to the server log and admin.log:

```
profile 12 (gm) spawned 5x "Iron Sword" [12eb7:Skyrim.esm WEAP] for "Hrolf" (profile 34)
```

### adminTeleportLocations

Named destinations offered in the Teleport sub-tab of the Personal Menu's Admin tab. `cellOrWorldDesc` uses the same `"<localFormId>:<file>"` form as spawn zones; `rot` is optional, and so are `kind` (a label shown next to the name and matched by the search) and `group` (the Teleport section: `cities`, `villages`, `forts`, `temples`, `oblivion` or `other`, in any case; `temples` when unset or blank, and an unknown value is listed under `temples` with a boot log line). Entries with a bad desc are dropped at boot with a log line.

The tab also lists every city, town, settlement, fort, civil war camp, orc stronghold and hold castle map marker of the load order, and every interior cell named "Temple" that a load door leads into (the teleport lands where that door drops you), from `skymp5-server/ts/systems/adminMapMarkers.ts`. That file is generated by `python misc/gen-map-marker-teleports.py` (rerun it after a load order change, then Build server); its `NUDGES` table offsets a marker whose fast-travel spot lands badly (High Hrothgar: from the entrance stairs to the spot in front of the doors, 50915 -36112 22584; Helgen: into the town Helgen.esp rebuilds, 15697 -81172 8202); a configured entry wins over a generated one of the same name, and over a generated temple in the same cell, however its desc is spelled (that temple's name then fills the entry's blank `kind`, so searching either name finds it). The Oblivion section is built in (`REALM_LOCATIONS` in `adminSystem.ts`): Sovngarde and the Soul Cairn at the afterlife arrivals of `afterlifeSystem.ts`, the Hall of Valor (`95c44:Skyrim.esm` at -266 147 -448) and Apocrypha at the Waking Dreams origin (`1c0b2:Dragonborn.esm`); a configured entry of the same name replaces one of them, so a `Hall of Valor` entry left in `adminTeleportLocations` keeps its old spot and section.

The list is split into collapsible sections, all collapsed at first and remembered until the game restarts: Cities (city markers), Villages (towns, settlements, orc strongholds), Forts (forts, castles, civil war camps), Temples (these configured entries first, then the generated temples), Oblivion (the realm teleports) and Other. Each header shows its count and empty sections are hidden. The search covers every section and opens the ones with a match.

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

Named damage rules, each a multiplier applied when its conditions hold. Conditions use the server's condition functions (`skymp5-server/cpp/server_guest_lib/condition_functions`) with global form ids as parameters; `runsOn` is `Subject` (the attacker) or `Target`. Consecutive `OR` conditions form one group, groups are joined with `AND`. Two rules ship in the settings. `practiceArrows` makes a bow or crossbow deal nothing while Practice Arrows (Skyrim.esm AMMO `0xCAB52`, 0 damage in the plugin but the server only reads the bow's damage) are nocked, for players and NPC archers alike; a bow bash with them nocked deals nothing too, since the rule cannot tell a bash from a shot. `hunterOverDraw` is the hunter's Over Draw rule from the proficiency system, 20% more bow and crossbow damage against NPCs only (take the Hunter Master id from the `proficiency-ids.json` of the last plugin run: the full slot of `AlduinakAdditions.esp` followed by its local id `002032`, today `0x33002032` because `DynDOLOD.esm` is a full plugin loaded before it; a plugin added or removed before it moves the slot):

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
    },
    "practiceArrows": {
      "physicalDamageMultiplier": 0,
      "conditions": [
        {"function": "GetEquipped", "runsOn": "Subject", "comparison": "==", "value": 1, "parameter1": "0x000CAB52", "parameter2": "0x0", "logicalOperator": "AND"},
        {"function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 7, "parameter1": "0", "parameter2": "0x0", "logicalOperator": "OR"},
        {"function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 7, "parameter1": "1", "parameter2": "0x0", "logicalOperator": "OR"},
        {"function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 12, "parameter1": "0", "parameter2": "0x0", "logicalOperator": "OR"},
        {"function": "GetEquippedItemType", "runsOn": "Subject", "comparison": "==", "value": 12, "parameter1": "1", "parameter2": "0x0", "logicalOperator": "AND"}
      ]
    }
  }
  // ...
}
```

## npcBlockedDamageShare

Share of an NPC's weapon hit that still lands when a player blocks it (a raised weapon or shield facing the NPC, a
shield against arrows). A number from 0 to 1, default `0.2`: a player's block is 80% effective against NPCs. `0`
restores full blocks. A player's hit on a blocking player stays fully blocked, and NPCs blocking are unchanged. The
leaked part is the unblocked damage (armor, power attack and the multiplier formulas included) times the share; the
hit still counts as blocked, so the Falmer hit spell poison does not land through it. Wards are not affected. Read by
the native server at boot, which logs `npcBlockedDamageShare is <share>: ...`; each such hit logs `OnWeaponHit -
<player> blocked npc <npc> with <weapon>, <landed> of <unblocked> damage lands (npcBlockedDamageShare <share>)`. See
`docs/docs_onhit_and_damage.md`, Blocked hits.

```json5
{
  // ...
  "npcBlockedDamageShare": 0.2
  // ...
}
```

## Hunger and fatigue

All optional; see `docs/docs_roleplay_creations_and_needs.md` for the system. Hunger uses Survival Mode's scale, 0 (full) to 1000, and
fatigue maps onto its exhaustion scale, 0 (rested) to 960. Which hunger effect a food carries comes from the plugins
(its Survival effect: VerySmall, Small, Medium or Large); what each effect restores is `needsFoodHunger`.

| Key | Default | Meaning |
|---|---|---|
| `needsEnabled` | `true` | `false` switches hunger and fatigue off |
| `needsHungerDrainPerHour` | `125` | Hunger gained per online hour (full to starving in about 8 hours); hunger holds while the race menu or creator is pending, for up to 20 minutes (then it drains again and the server logs a warning); fatigue keeps regenerating |
| `needsHungerOffline` | `false` | `true` drains hunger while logged out too |
| `needsFatigueOfflinePerHour` | `1` | Share of the fatigue bar refilled per hour logged out (1 = 100%, the online rate), added once at login and capped at a full bar; `0` turns it off. Logs `[needs] <id> rested offline <time>: fatigue A% -> B%`. Read at boot |
| `needsHungerStart` | `145` | Hunger of a new character, set again (with a full fatigue bar) when its race menu or creator is accepted; 145 is Survival Mode's starting value, in the Satisfied stage |
| `needsHungerStages` | `[80, 160, 340, 520, 770]` | Survival's stage values: Well Fed (after a meal empties hunger) ends at the first, Peckish, Hungry, Famished and Starving begin at the others; the second also starts the max stamina penalty |
| `needsHungerStageAbilities` | `true` | Grant the Survival hunger stage ability of the current stage |
| `needsFoodHunger` | `{ "Survival_FoodRestoreHungerVerySmall": 40, "Survival_FoodRestoreHungerSmall": 100, "Survival_FoodRestoreHungerMedium": 220, "Survival_FoodRestoreHungerLarge": 380 }` | Hunger points (of 1000) each hunger magic effect restores, merged key by key over the default; the HUD bar shows a tenth of that as a percentage (VerySmall 4%, Small 10%, Medium 22%, Large 38%). An effect not listed restores its record's `AmountToRestore` global (Survival's 2, 18, 220, 380). Numbers of 0 or more. Read at boot |
| `needsFatigueStages` | `[80, 160, 340, 560, 800]` | Survival's exhaustion stage values: Drained, Tired, Weary and Debilitated begin at the last four (the first only ends a sleeping bonus the server never grants); the second also starts the max magicka penalty |
| `needsFatigueStageAbilities` | `true` | Grant the Survival exhaustion stage ability of the current stage |
| `needsExhaustionMax` | `960` | Exhaustion of an empty fatigue bar (`Survival_ExhaustionNeedMaxValue`) |
| `needsAttributePenalties` | `true` | `false` sends no max stamina or max magicka penalty |
| `needsSurvivalModeFlag` | `true` | Clients set the Creation's `Survival_ModeToggle` (`SRVT`, esl 0x828) to 1 with every `needsState`. `HUDMenu::AdvanceMovie` polls that global every frame and calls the HUD's `ShowSurvivalElements(true, penalties)` under it; with the toggle at 0 the engine calls it once with false after each load and never again, so `false` hides the red penalty segments whatever the penalty globals hold. `Survival_ModeEnabled` is script-only and nothing in the engine reads it. `true` also brings the engine's own Survival extras on every client: arrows, bolts and the lockpick weigh their record weight, armour cards and the inventory bar show Warmth. Survival's quests and scripts stay off (the plugin drops `Survival_MainScript`, which would otherwise start them from this toggle), so no hunger, cold or exhaustion effect starts from it. Read at boot |
| `needsAlcoholDiscount` | `0.25` | Warmed by drink: the share of the fatigue cost a cook or alchemist (Novice or better) saves on the crafts priced by their own rank after drinking an alcohol; `0` turns the rule off. Any other character gets the hunger only. Read at boot |
| `needsAlcoholMinutes` | `10` | How long one drink warms; another drink refreshes the timer and never stacks |
| `needsAlcoholItems` | `{}` | `{ "<ALCH editor id or hex id>": true \| false }` counting an item as alcohol or not, over the record rule (an ALCH drunk with the `ITMPotionUse` sound that carries a detrimental stamina or magicka rate effect: every vanilla ale, mead, wine, brandy, flin, sujamma, shein and matze; not juice, water, milk or skooma). Rotgut and Battle-Brew Special carry no rate effect and need `true` here to count |
| `blockStaminaCost` | `0.1` | Share of max stamina a blocked weapon hit costs the blocker; applies with needs off too, `0` turns it off |
| `blockStaminaCostWarrior` | `0.05` | What a warrior pays instead |
| `blockStaggerWithoutStamina` | `true` | A blocker whose stamina is below the block cost still blocks that hit but is staggered on their own screen and on their copies (at most once a second, never while downed, mounted or seated); logs `[needs] <id> staggered: blocked without stamina`. Needs the matching client |
| `blockStaggerMagnitude` | `0.5` | The stagger's `staggerMagnitude`, clamped to 0.1 to 1 |

## Mastery, gathering and hunting

All optional; see `docs/docs_roleplay_mastery.md` for the system.

| Key | Default | Meaning |
|---|---|---|
| `masteryRankHours` | `[40, 100, 180, 6000]` | Worked hours for Adept, Expert, Master, Legendary; four numbers |
| `masteryPointIntervalMinutes` | `60` | Minimum gap between two counted hours |
| `masteryHourBank` | `2` | Hours that extra crafts inside a counted hour may bank; each is counted after another interval of online time with no counted work. `0` turns the bank off |
| `masterySpells` | plugin markers | `{ "<profession>": [novice, adept, expert, master, legendary] }` form ids; a profession left out uses the plugin's `AldProf_<Label>_<Rank>` spells |
| `masteryActivities` | see `masterySystem.ts` | What counts as work per profession |
| `masteryKits` | see `DEFAULT_KITS` in `masterySystem.ts` | `{ "<profession>": [{ baseId, count }] }` kit a character receives with its first profession, same shape as `startingItems`; a profession left out keeps its default, `[]` gives nothing, an unknown key or item is logged at boot |
| `masteryKitGold` | `50` | Gold every profession's kit carries on top of its items, alchemists included, whatever `masteryKits` says; `0` turns it off. A character that got gold from `startingItems` (marked `private.starterGold`) gets none |
| `gatheringStrikeSeconds` | `5` | Seconds per pickaxe strike |
| `gatheringChopSeconds` | `10` | Seconds per swing of the woodcutter's axe; the firewood lands when the swing ends, counted from the moment the client reports the player seated, and only if they are still seated then |
| `gatheringChopYield` | `2` | Firewood one swing hands over. A sitting at a chopping block has no cap: the chopper stays in the chopping animation, a yield every swing, and stands up with "You are too tired to swing an axe. Rest a while." once the fatigue bar cannot pay for another |
| `gatheringVeinTotal` | `6` | Ore collections every vein holds, vanilla veins and the sea salt deposits alike; each pickaxe strike still gives the record's own count (1), so a vein is six strikes. `0` uses each record's `ResourceCountTotal` (3 for the vanilla veins) |
| `gatheringVeinRespawnMinutes` | `1440` | Minutes after the first ore taken until the whole vein is back, at once, whether one ore or all six were taken. `0` keeps the default rather than making veins endless |
| `gatheringVeinRegenMinutes` | unset | When set, veins grow back gradually instead: one collection per that many minutes, the first one that long after the first ore taken |
| `miningVeinTiers` | iron, sea salt Free; corundum Novice; gold, silver Adept; orichalcum, moonstone Expert; malachite, quicksilver, ebony, stalhrim Master; amber, madness ore Legendary | `{ "<ore editor id>": "Adept" }` overrides (a rank name or index, `Free` or `0` open to anyone), by the ore item the vein hands out |
| `gatheringProduceContainers` | `{ "BeeHive": 60, "BeeHiveVacant": 60, "BYOHBYOHApiary": 60 }` | `{ "<container editor id>": minutes }`: placed containers of these bases never open; E hands over their yield and it grows back after the minutes. `BYOHBYOHApiary` is the Hearthfire apiary every placed apiary uses. Replaces the default, `{}` turns it off |
| `gatheringProduceYield` | `{ "BeeHive": { "BeeHoneyComb": 2, "CritterBeeIngredient": 2, "BeeHiveHusk": 2 }, "BeeHiveVacant": { … }, "BYOHBYOHApiary": { … } }` | `{ "<container>": { "<item editor id or hex id>": count } }` handed over instead of the container record's own contents. A container whose items do not resolve keeps its record contents |
| `gatheringPickMinutes` | `30` | Minutes a picked nirnroot or ingredient-carrying critter (bees, fireflies) stays gone. The server disables the picked ref for everyone and enables it again when the time is up; `gathering-picks.json` in the server's working folder (beside `housing.json`) keeps the pending ones over a restart |
| `gatheringAlchemistFloraDiscount` | `0` | Extra share of the fatigue an alchemist (Novice or better) saves on alchemy flora: a plant that is not a crop and hands over an ingredient (flowers, mushrooms, herbs, berries, eggs, nirnroot, the Hearthfire herb planters), on top of the flora rank price an alchemist already pays like a farmer of the same rank and the flora half. `0` (default) turns it off; crops (priced by the farmer rank alone, so an alchemist pays the Free crop price) and the food plants (apples, vegetables, cheese, fish, meat) never get it. Set, the charge line reads `[needs] <id> harvest <plant> flora r<rank>, alchemist -50%: -N%, fatigue F%`. Read at boot |
| `huntingButcherChance` | `0.25` | Expert hunter: chance of one extra meat per kind an animal dropped |
| `huntingMeats` | vanilla and DLC list | Editor ids of what counts as meat for the butcher bonus |
| `huntingPeltMap` | see `DEFAULT_PELT_MAP` in `huntingSystem.ts` | `{ "<editor id fragment>": "<pelt editor id>" }` replacing the default: the pelt a skinned body gives. The body's own NPC_ editor id is tried first, then the race that supplies its traits, then its template NPC_s (lower-cased); the first fragment found in the earliest name wins |
| `huntingSkinPlayers` | `"crouch"` | How a hunter with the Hunting Knife skins a dead player's own body while it waits for its respawn (`respawnSeconds`), or the body a PK left of them while it lies: `"crouch"` crouch and press interact (a plain press searches it), `"interact"` every press skins as on an animal, `"off"` never. A skinned body gives Human Flesh, maybe a Human Heart and on a Khajiit maybe a Khajiit Pelt, never the victim's pack; an own body cannot be searched by anyone until the respawn, a PK body keeps its pack for the usual loot rules and is skinned once for as long as it lies. An unknown value logs `[hunting] huntingSkinPlayers ... is not one of crouch, interact, off` and uses `"crouch"`. Read at boot |
| `huntingHumanFlesh` | `"HumanFlesh"` | Editor id, `"hex:Plugin.esm"` desc or hex id of the item a skinned player's body gives, one each (Skyrim.esm `001016B3`). Not in the load order: players are not skinned (`players not skinned` on the boot line) |
| `huntingHumanHeart` | `"HumanHeart"` | The same for the item the chance adds (Skyrim.esm `000B18CD`); `""` gives none |
| `huntingHumanHeartChance` | `0.1` | Chance, 0 to 1, rolled on the server per skinned player body |
| `huntingKhajiitPelt` | `"AldKhajiitPelt"` | Editor id, `"hex:Plugin.esm"` desc or hex id of the item a skinned player body that looks Khajiit (its appearance race `KhajiitRace` or `KhajiitRaceVampire`) may add, one (the Alduinak plugin's Khajiit Pelt, from plugin r24); `""` gives none. Not in the load order: `[hunting] not in the load order, ignored: ..., AldKhajiitPelt` once at boot and `no Khajiit pelt` on the boot line |
| `huntingKhajiitPeltChance` | `0.2` | Chance, 0 to 1, of that pelt, rolled on the server per skinned Khajiit body |

## goldAlertThreshold

`GoldWatchSystem` samples every online character's gold every 10 s. A rise above `goldAlertThreshold` (default `5000`, `0` disables the alert) between two samples logs `GoldWatchSystem: <name> (profile P) went from A to B gold` and posts a `goldSpawn` security alert to the manager's Security tab. The first sample of a character only sets its baseline. Since 2026-09 (B24, B14) the same samples watch drops: every drop of gold and every drop of Salt Pile (`0x34cdf`) that the actor's own actions in the interval do not explain are logged as `[inv] <name> (<id>, profile P) gold|salt A -> B[, N unexplained] (interval: crafts C, eats E, puts P, drops D, takes T[, packets tradeAccept bountyBoardPost])`, where the tallies come from the `onCraft` (the recipe's inputs of that item), `onEatItem`, `onPutItem`, `onDropItem` and `onTakeItem` hooks after every other system had its say, and the packets are the trade and bounty board sends the hooks never see. A drop of the item the actor ate less than 2 s before logs `[inv] <name> (<id>, profile P) drop of <editor id> <id> xN <ms> ms after eating one: the client sent the eat as a drop too` (G9; a client before 1.0 sent eating from the inventory near a same item in the world as a drop too). Every other drop the hooks accept logs `[inv] <name> (<id>, profile P) dropped <editor id> <id> xN` (K5) once the server's count of that item has fallen: the hooks run before the native `MpActor::DropItem` removes anything, and it logs at trace level only, while a drop is the one way a player's own client takes items out of the pack without a craft, put, trade or eat line. A drop the server's count does not follow (the native removal then throws `Source inventory doesn't have enough <id> (N is required while 0 present)`) logs `[inv] <name> (<id>, profile P) drop of <editor id> <id> xN refused natively: the server held H` instead, the mark of a client showing items the server never had. Every client version sends a drop for a misc item, a pelt or ore say, that leaves the pack with no container while the inventory menu is open; G9 changed only potions and ingredients. Together with `spawn.ts`'s `[gold] <id> logs out|quits|despawned|logs in with N gold` lines and the `[pack] <id> (profile P) logs out|quits to the menu|despawned|logs in with K kind(s): <base id> x<count>, ...` line written right after each (the whole pack summed per base id in id order, gold apart; K5), a reported loss lands in one of three windows: during play (an `[inv]` line), the parked body (logout vs despawn) or offline (despawn vs login, the only window persistence can explain).

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
