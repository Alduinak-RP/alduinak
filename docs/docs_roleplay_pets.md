# Pets (horses, livestock, dogs)

A pet is an NPC owned by one character: horses to ride, livestock to harvest, dogs to command. The owner's changeform holds the list; a pet in
the world is a server actor whose AI runs on the owner's client. Conjured companions (`docs_roleplay_companions.md`) are not pets, but the same
menu reaches them.

- **Server:** `skymp5-server/ts/systems/petSystem.ts` (`PetSystem`, created in `ts/index.ts`), with hooks in `hostingSystem.ts` (locked
  hostables), `housingSystem.ts` (owned doors, the Pets option), `searchSystem.ts` (the inventory window), `captureSystem.ts` (carrying an NPC)
  and `adminSystem.ts` (granting).
- **Client:** `skymp5-client/src/services/services/petService.ts` (menu, E actions, transfer pick, command mode), `mountService.ts` (the rider),
  `skymp5-client/src/sync/mountApply.ts` (other players see the rider seated), plus the pet branches in `playerActionService.ts`,
  `interactionPromptService.ts`, `companionService.ts`, `restraintService.ts`, `housingService.ts` and `adminMenuService.ts`.
- **Front:** `skymp5-front/src/features/petList` (the door list), `petPrompt` (rename), the `contextMenu` widget (Trade row optional), the housing
  widget's Pets button and the admin panel's NPCs > Pets sub-tab.

## Rules

| Kind | Home | E does | Menu extras |
|---|---|---|---|
| horse | a stable (any Stable map marker within `petAnchorRadius`) | mounts it; anyone can mount a horse, and doing so takes it from its owner. In the saddle E always dismounts, whatever the crosshair found, and the prompt reads Dismount | Trade (its inventory) |
| livestock | a farm (any Farm or Wheat Mill marker) | harvests: cows and goats give a Jug of Milk, chickens an egg, once per `petHarvestHours` real hours, counted while the owner is offline (a timestamp on the record, checked on the attempt) | none |
| dog | the owner's own house (any door they claimed) | command mode (see below); dogs never sit on furniture | Trade (its inventory) |
| conjured companion | anywhere | command mode | only Pet and Unsummon (= dismiss) |

The X menu on a pet you own: **Trade** opens its inventory in the vanilla container window (the search system's occupant path), **Pet** plays the
tanning-rack idle on you, **Carry** picks it up with the player carry system (not horses; the animal freezes, and your client, which hosts it meanwhile, holds it in
your arms), **Unsummon** stores it (only when you stand near its home, see the table), **Rename** (24 characters, letters, numbers, spaces, `'`,
`_`, `-`), **Transfer** hands it to the player you look at next, who must accept the prompt and have room under the caps, **Release** sets it free: it wanders, hosted by
whoever is nearest, and is deleted for good after `petReleaseSeconds`; anyone who mounts a released horse keeps it. Taking a
horse (stealing or claiming a released one) needs room under `petMaxPets` and `petMaxOut`. A commanded pet, like a companion, only
opens doors; containers and items refuse it.

Getting a pet out: at a door of the right kind (a stable door, a farm door or a door you own) the housing menu shows **Pets**; the list shows the
pets kept there and a Summon button. Either side of a teleport door opens the list; horses and livestock come out only from the outside
door, where the stable or farm is, so they can be unsummoned there again. At most `petMaxOut` pets are out at once and a character keeps at most `petMaxPets`. Admins add a pet to
their own list from the admin panel (NPCs > Pets) and hand it over with Transfer.

## Dogs: following, fighting and command mode

An out dog is handed to `CompanionService`, so it follows and fights on exactly the code summons use (`docs_roleplay_companions.md`).

- **Following:** it keeps a spot 128 units behind its owner, facing where it walks. A dog comes out at that spot, so it never starts by backing past its owner. If it ends up more than 4096 units away or in another cell (a load door, a long ride), the server moves it behind its owner and re-hosts it there, never while it is carried, ridden, fleeing or dead. A pet put down after a carry is re-hosted by its owner at once.
- **Fighting:** the dog turns on anyone who damages its owner, any other pet or companion of theirs, or the dog itself, and on anyone its owner hits with a weapon or a hostile spell. It never targets its owner or anything else of its owner's. It drops the target when that target dies, goes beyond 6144 units, or when the dog is picked up, stored, sent home or released. Horses and livestock never fight.
- **Command mode:** E on your own dog or summon starts it. The crosshair prompt on a living actor then reads `{pet name} Attack`, and pressing the interact key again sends the pet in. Command mode ends with that one order, like vanilla, and also on Escape, after 30 s, if the pet dies, or if you stop hosting it. You cannot order an attack on yourself, on the pet you are commanding, or on any other pet or summon of yours. A summon order carries its `companionId`, so only the commanded one goes.

Lifecycle:

- **Death:** the body stays `petCorpseSeconds` (default the `npcCorpseSeconds` value, 300) and is searchable like any NPC body; then it is
  removed and the record deleted. The death is written to the record at once, so a restart in between still deletes it at the owner's
  next login, and a body keeps its timer when its owner logs out. Hitting or killing any pet earns no mastery.
- **Owner logs out, switches character or opens character select** (5 s after they leave): every living pet of theirs goes back to its
  home and a ride ends.
- **Owner downed:** the pet runs off and goes home after `petFleeSeconds` (30).
- **Restart:** every pet of the previous run is removed at boot (`pets.json` lists them); the records start stored.
- **Riding:** the rider hosts the horse; the hosting audit never moves a ridden or carried pet. A rider who dies, disconnects or is teleported is
  dismounted server-side; a horse that dies under its rider too.
- **Dismount:** the activate key in the saddle calls the vanilla Dismount on the rider's own client (`mountService.ts`). A refusal (galloping, a
  slope) says so on screen and the key can be pressed again at once. The ride ends server-side when the rider's client reports `mounted: false`,
  once the player is really off, so other players see the horse emptied about a second later.

## Riding, what other players see

The server tells every client which horse a rider sits on through the neighbor-visible `ff_mount` property on the rider (the horse's id, 0
when none). An observing client parks the rider's copy beside the horse copy, waits for it to get there, and then asks for the saddle with both
copies standing still: the native `mountActor` export where the client has one, otherwise `activate` with default processing, the same call that
opens server containers. The horse copy is stopped where the rider parks (no translation, no offset) and stands there until the seat is answered,
and the rider's copy is off normal movement sync for the whole ride.

Whether the engine seats a non-player rider is still unproven. When it refuses, after six tries or at once if `mountActor` says no, the copy is
attached to the horse copy instead (`setVehicle`, and the `SaddleBone` node when the vehicle does not carry it). That rides along without a
riding pose, but the copy is never dragged on the horse's back and never walks. A refusal the seat cannot even be asked through, such as a copy
whose 3D is not loaded, attaches the same way once it has lasted nine seconds, and lets go again if it clears. An observer with no copy of the
horse at all puts the rider's copy back on normal movement sync after that same wait, rather than leaving it standing for the ride. Each outcome,
including which clause refused and a missing horse copy, is written once per ride to `Documents\My Games\Skyrim Special
Edition\Platform\skyrim-platform.log` on the observer's PC. The design, its fallbacks and the ordered test plan are in
`alduinak-pet-system-2026-09-14/visible-riding-design.md` on the Desktop of the server box.

## Protocol (MsgType.CustomPacket JSON)

Client to server `petRequest {action, target, ...}`: `menu`, `use`, `mount` (plus `mounted: true|false` in the rider's reports), `trade`, `pet`,
`carry`, `unsummon`, `rename {name}`, `transfer {recipient}`, `release`, `attack {victim}`, `list {door}`, `summon {uid, door}`. A transfer's
consent reuses `captureConsentRequest` / `captureConsentResult` with request ids from 1,000,000,000 up. A commanded summon is ordered through
`companionCommand` instead, not through `petRequest`.

A dog's combat target is not part of `petState`: it travels in the `allies` array of `companionState`, because the fight itself is
`CompanionSystem`'s (`docs_roleplay_companions.md`, Allies).

Server to client: `petState {pets: [{uid, id, name, kind, home, homeName, out}]}` to the owner at login and on every change; `petMenu {target,
title, actions, trade}`; `petList {door, category, pets}`; `petMount {target, hosted}` (activate the horse, you host it); `petDismount {target}`;
`petCommand {target}`; `petAction {target, action: "pet"}`; `notification {text}`; `carryState` now carries `target` (the carried NPC); the
housing `propertyMenu` carries `pets` (the door's category or empty); `petBases {bases}` answers the admin's `adminAction petBases`.

Properties: `private.pets {list}` on the owner (never sent), `private.pet {owner, uid, kind, name, released?}` on the actor (never sent),
`ff_pet {kind, name, owner, dead?, flee?, carried?}` on the actor and `ff_mount` on riders, both neighbor-visible. The gamemode must register the
two `ff_` ones (see Deployment).

## Settings (`server-settings.json`, all optional)

| Key | Default | Meaning |
|---|---|---|
| `petInteractMaxDistance` | 256 | reach for every menu and E action, and for the transfer recipient |
| `petAnchorRadius` | 2048 | how far from a Stable / Farm / Wheat Mill marker a door or a player still counts as at the stable or farm |
| `petHarvestHours` | 12 | real hours between harvests of one animal |
| `petCorpseSeconds` | `npcCorpseSeconds` or 300 | how long a dead pet's body stays |
| `petReleaseSeconds` | 3600 | how long a released pet wanders before it is deleted |
| `petFleeSeconds` | 30 | how long a downed owner's pet runs before it goes home |
| `petMountTimeoutSeconds` | 5 | how long a mount grant waits for the rider's report |
| `petMaxPets` | 10 | pets a character may keep |
| `petMaxOut` | 3 | pets a character may have out at once |
| `petBases` | `{ horse: [EncHorseSaddledBrown, EncHorseSaddledBlack, EncHorseSaddledGrey, EncHorseSaddledPalomino], livestock: [EncCow, EncGoatDomestic, EncChicken], dog: [EncDog, TrainedDog] }` | grantable NPC_ bases per kind, editor ids or `hex:Plugin` descs; unknown ones are logged at boot |
| `petHarvestItems` | `{ milk: BYOHFoodMilk, egg: BirdEgg03 }` | the products, editor ids or descs |

Editor ids are resolved by the same plugin scan the spawner uses, so the load order cannot break them. The stable and farm anchors come from
`adminMapMarkers.ts` (`PET_ANCHORS`), regenerated with `python misc/gen-map-marker-teleports.py`.

## Deployment

| Change | Rebuild |
|---|---|
| gamemode: register the two properties in `build/dist/server/gamemode_extensions/50_properties.js` (live file, not in the repo): `try { mp.makeProperty('ff_pet', { isVisibleByOwner: true, isVisibleByNeighbors: true, updateOwner: '', updateNeighbor: '' }) } catch (err) { console.error('[pets] makeProperty ff_pet: ' + (err && err.message)) }` and the same line for `ff_mount` | manager "Build gamemode only" (hot reload); must be live before the server build, or every `ff_pet` write throws |
| server TS (`petSystem.ts` and the hooks) | manager "Build server", restart the game service; add any `pet*` keys you want to change to `server-settings.json` by hand |
| client and front | manager "Build Client", players re-download |
| C++ | none |

Order: gamemode line, server, client. An old client against the new server ignores the pet packets; a new client against an old server gets no
answers and every pet branch stays inert.
