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
| horse | a stable (any Stable map marker within `petAnchorRadius`) | mounts it; anyone can mount a horse, and doing so takes it from its owner | Trade (its inventory) |
| livestock | a farm (any Farm or Wheat Mill marker) | harvests: cows and goats give a Jug of Milk, chickens an egg, once per `petHarvestHours` real hours, counted while the owner is offline (a timestamp on the record, checked on the attempt) | none |
| dog | the owner's own house (any door they claimed) | the vanilla command mode; dogs never sit on furniture | Trade (its inventory) |
| conjured companion | anywhere | the command mode | only Pet and Unsummon (= dismiss) |

The X menu on a pet you own: **Trade** opens its inventory in the vanilla container window (the search system's occupant path), **Pet** plays the
tanning-rack idle on you, **Carry** picks it up with the player carry system (not horses; the animal freezes, and your client, which hosts it meanwhile, holds it in
your arms), **Unsummon** stores it (only when you stand near its home, see the table), **Rename** (24 characters, letters, numbers, spaces, `'`,
`_`, `-`), **Transfer** hands it to the player you look at next, who must accept the prompt, **Release** sets it free: it wanders, hosted by
whoever is nearest, and is deleted for good after `petReleaseSeconds`; anyone who mounts a released horse keeps it. Taking a
horse (stealing or claiming a released one) needs room under `petMaxPets` and `petMaxOut`. A commanded pet, like a companion, only
opens doors; containers and items refuse it.

Getting a pet out: at a door of the right kind (a stable door, a farm door or a door you own) the housing menu shows **Pets**; the list shows the
pets kept there and a Summon button. Either side of a teleport door counts, so a stable's or farm's interior door works as well as the
outside one. At most `petMaxOut` pets are out at once and a character keeps at most `petMaxPets`. Admins add a pet to
their own list from the admin panel (NPCs > Pets) and hand it over with Transfer.

Lifecycle:

- **Death:** the body stays `petCorpseSeconds` (default the `npcCorpseSeconds` value, 300) and is searchable like any NPC body; then it is
  removed and the record deleted. The death is written to the record at once, so a restart in between still deletes it at the owner's
  next login, and a body keeps its timer when its owner logs out. Hitting or killing any pet earns no mastery.
- **Owner logs out, switches character or quits to the menu** (5 s without a user): every living pet of theirs goes back to its home and
  a ride ends.
- **Owner downed:** the pet runs off and goes home after `petFleeSeconds` (30).
- **Restart:** every pet of the previous run is removed at boot (`pets.json` lists them); the records start stored.
- **Riding:** the rider hosts the horse; the hosting audit never moves a ridden or carried pet. A rider who dies, disconnects or is teleported is
  dismounted server-side; a horse that dies under its rider too.

## Riding, what other players see

The server tells every client which horse a rider sits on through the neighbor-visible `ff_mount` property on the rider (the horse's id, 0
when none). An observing client parks the rider's copy beside the horse copy and lets the engine seat it (`activate` with default processing,
the same call that opens server containers), then stops moving that copy itself until the property clears. This needs no C++; whether the engine
seats a non-player activator is the first thing to test in game. The design, its fallbacks and the ordered test plan are in
`alduinak-pet-system-2026-09-14/visible-riding-design.md` on the Desktop of the server box.

## Protocol (MsgType.CustomPacket JSON)

Client to server `petRequest {action, target, ...}`: `menu`, `use`, `mount` (plus `mounted: true|false` in the rider's reports), `trade`, `pet`,
`carry`, `unsummon`, `rename {name}`, `transfer {recipient}`, `release`, `list {door}`, `summon {uid, door}`. A transfer's consent reuses
`captureConsentRequest` / `captureConsentResult` with request ids from 1,000,000,000 up.

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
| `petHarvestItems` | `{ milk: BYOHFoodMilk, egg: FoodChickensEgg }` | the products, editor ids or descs |

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
