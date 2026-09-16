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

```json5
{
  // ...
  "forbiddenReloot": ["MISC", "WEAP", "SLGM", "SCRL", "ALCH", "INGR", "BOOK", "ARMO", "AMMO", "KEYM", "CONT"]
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
vanilla coin purses (flora that hands out leveled gold and respawns) and the
loose salmon (`0x000F5ECA`, `0x000F5ECB`). The server sends the list to every
client on connect, which then blocks engine activation and shows no prompt for
those forms. `[]` disables the check.

```json5
{
  // ...
  "untouchableBaseIds": ["0x000D790C", "0x000D8E7F", "0x000D8E80"]
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
and the race's greater power (Highborn, Battle Cry...) on every player
character. `false` makes characters start without them; abilities such as the
combat heal rate, racial passives and lesser powers (Khajiit Night Eye) stay,
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

## npcAggroHostSeconds

For this many seconds after a player and a zone NPC exchanged a damaging hit, that player may host the NPC, so its AI runs on the client that is fighting it. Only hits the other handlers allowed (god mode, ghost mode and the capture carrier rule refuse some) and that deal damage count. A host that is itself inside its window keeps the NPC when another player hits it, so a group fight does not move the AI between clients. Default 30; `0` disables the aggro rule and leaves nearest-player hosting.

```json5
{
  // ...
  "npcAggroHostSeconds": 30
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

## startPoints

Contains a list of spawn points, one of which will be chosen at random.

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

## Admin roles

Every player opens the Personal Menu with the interact key (X by default) while looking at nothing, a world NPC or anything else that is not a player, door or container. It has four tabs, in this order:

- **Admin**, shown only once the server confirms the player's admin tier, with the sub-tabs:
  - Players: roster, teleport to, summon, kick, ban, mastery grant and reset;
  - Teleport: named locations, map markers and temples in collapsible sections;
  - Modes: God, NoClip, Invisible, Ghost, Freecam (the movement keys fly the camera while the character stays put; toggled here, no console needed; X always opens this menu while it is on, and it ends when turned off, on logout, on a character switch, on death or on respawn), Smite, Heal on Hit and Speed (raised movement speed that ends when turned off, on logout, on a character switch or on respawn);
  - NPCs: list, add, teleport to, reset and delete the spawn zones of `NPC-Spawns.json`, see `docs_roleplay_npc_spawns.md`;
  - Item Spawner, see below.
- **Faction**: a work-in-progress placeholder.
- **Skills**: the mastery (craft) menu.
- **Debug**: account and character name, server-side FormID, server name, position, cell id and name, heading, crosshair target distance (activatable references only), magicka/health/stamina, the Tamrielic game date, local and server clocks and the active effects the client has seen start.

Admins also get the admin chat channel. Nobody gets the server console commands (`additem`, `equipitem`, `placeatme`, `disable`, `markfordelete`, `mp`), admins included: AdminSystem clears `consoleCommandsAllowed` whenever a character is assigned, so keep `enableConsoleCommandsForAll` off. The client closes the local ~ console and refuses the local cheat commands for everyone, admins included (`ConsoleBlockService`), so every admin mode, Freecam included, is toggled from Admin > Modes. This is client-side enforcement; the server checks stay the authority. Admin rights come from Discord roles, resolved into one of three tiers by `skymp5-server/ts/systems/adminRoles.ts`.

Each Admin sub-tab needs a cap. A sub-tab shows only when the tier has its cap, and the server refuses every request the tier lacks the cap for, with an admin.log line.

| Tier | `players` | `teleport` | `modes` | `npcs` | `items` | `kick` | `ban` |
|---|---|---|---|---|---|---|---|
| `senior` | yes | yes | yes | yes | yes | yes | yes |
| `developer` | yes | yes | yes | yes | yes | no | no |
| `gm` | yes | yes | yes | yes | yes | yes | yes |

`players` covers the Players sub-tab, `teleport` the Teleport sub-tab, `modes` the Modes sub-tab, `npcs` the NPCs sub-tab and `items` the Item Spawner. `kick` is the Kick button and `ban` the Ban button; both also need `players`. `adminTierCaps` changes the defaults per tier.

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

Optional per-tier overrides of the caps above, merged over the defaults (every cap on, except `kick` and `ban` for `developer`). Only the tiers `senior`, `developer` and `gm` and the caps `players`, `teleport`, `modes`, `npcs`, `items`, `kick` and `ban` with `true` or `false` apply; anything else is ignored and logged once at boot. A change needs a restart.

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

The tab also lists every city, town, settlement, fort, civil war camp, orc stronghold and hold castle map marker of the load order, and every interior cell named "Temple" that a load door leads into (the teleport lands where that door drops you), from `skymp5-server/ts/systems/adminMapMarkers.ts`. That file is generated by `python misc/gen-map-marker-teleports.py` (rerun it after a load order change, then Build server); a configured entry wins over a generated one of the same name, and over a generated temple in the same cell, however its desc is spelled (that temple's name then fills the entry's blank `kind`, so searching either name finds it).

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

Named damage rules, each a multiplier applied when its conditions hold. Conditions use the server's condition functions (`skymp5-server/cpp/server_guest_lib/condition_functions`) with global form ids as parameters; `runsOn` is `Subject` (the attacker) or `Target`. Consecutive `OR` conditions form one group, groups are joined with `AND`. The hunter's Over Draw rule from the proficiency system, 20% more bow and crossbow damage against NPCs only (take the Hunter Master id from `misc/proficiency-patcher/out/proficiency-ids.json`):

```json5
{
  // ...
  "damageMultConditionalFormulaSettings": {
    "hunterOverDraw": {
      "physicalDamageMultiplier": 1.2,
      "conditions": [
        { "function": "HasSpell", "runsOn": "Subject", "comparison": "==", "value": 1, "parameter1": "0x2B002032", "parameter2": "0x0", "logicalOperator": "AND" },
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
| `huntingButcherChance` | `0.25` | Expert hunter: chance of one extra meat per kind an animal dropped |
| `huntingTrophyChance` | `0.15` | Master hunter: chance of one extra pelt per kind |
| `huntingPeltsNeedHunter` | `true` | Pelts on a dead animal, pets included, are left out of the loot window of anyone who is not a hunter, and a take of one is refused. A pelt is any item carrying `VendorItemAnimalHide` plus the `huntingPelts` list. A non-hunter who owned the pet also stops seeing pelts they stored in it |
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
