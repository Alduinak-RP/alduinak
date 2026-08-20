# Character Creator

A five-screen character creator that replaces the vanilla `ShowRaceMenu` flow
for fresh characters. Species → Race → Identity (sex/age/stats) → Appearance
(face/hair/colors/body) → Bio (name/backstory/description).

## Where the pieces live

| Piece | Path | Rebuild |
|---|---|---|
| UI (5 screens, data catalog) | `skymp5-front/src/features/charCreator` | Build Client + launcher redistribution |
| Client bridge service | `skymp5-client/src/services/services/charCreatorService.ts` | Build Client |
| Server flow + validation | `skymp5-server/ts/systems/spawn.ts` (+ `charCreatorData.ts`) | Build server + service restart |
| RP data in chat (/examine) | `build/dist/server/gamemode_extensions/32_char_creator.js` | Build gamemode (hot-reloads) |

## Flow

1. `spawn.ts` `onSelectCharacter` creates a fresh actor. When the
   `charCreator.enabled` server setting is true it sends `charCreatorOpen`
   instead of `setRaceMenuOpen(actorId, true)` and marks the actor
   `private.charCreatorPending = true` (relogging re-opens the creator until
   a submission is accepted).
2. `charCreatorService.ts` receives the packet, injects a
   `{type: 'charCreator', config}` widget into CEF, focuses the browser and
   disables player controls.
3. The front renders the wizard. On each appearance change it may send a
   `charCreator:preview` browser message; the client applies it locally via
   `applyAppearanceToPlayer` (nothing is sent to the server).
4. On finish, the front sends `charCreator:save`; the client wraps it into the
   `charCreatorResult` custom packet.
5. `spawn.ts` validates everything server-side, applies
   `mp.set(actorId, 'appearance', ...)` (this also syncs to all players),
   stores the RP block under `private.rp`, clears the pending flag and sends
   `charCreatorClose`.

## Wire contract

Server → Client (custom packets):

```json
{ "customPacketType": "charCreatorOpen",
  "config": {
    "disabledRaces": ["giant"],
    "lockedRaces": ["falmer"],
    "allowChildren": true,
    "statPool": 120
  } }
{ "customPacketType": "charCreatorClose" }
{ "customPacketType": "charCreatorError", "message": "..." }
```

`lockedRaces` = paywalled races this particular player has not been granted.
Disabled races are hidden by the UI; locked races render with a lock and
cannot be picked.

Browser → Client (`window.skyrimPlatform.sendMessage`):

- `charCreator:save`, arg 1: JSON string of the result (below)
- `charCreator:preview`, arg 1: JSON string of a full Appearance object
- `charCreator:cancelPreview` — re-applies the last committed appearance

Client → Server:

```json
{ "customPacketType": "charCreatorResult", "data": {
    "race": "nord", "sex": "female", "age": "adult",
    "stats": { "strength": 55, "endurance": 40, "agility": 40, "speed": 40,
               "intelligence": 40, "willpower": 40, "personality": 45, "luck": 40 },
    "bodyExtras": { "muscle": 60, "fat": 25 },
    "appearance": { },
    "name": "Sigrid Winter-Hail",
    "backstory": "…", "description": "…"
} }
```

`appearance` is the standard skymp Appearance JSON (`isFemale`, `raceId`,
`weight`, `skinColor`, `hairColor`, `headpartIds`, `headTextureSetId`,
`options[19]`, `presets[4]`, `tints[]`, `name`).

## Server-side validation (spawn.ts)

- race slug exists in the shared catalog and is not disabled; if paywalled the
  player's profile must be granted it
- `appearance.raceId` must equal the catalog id for (race, age) — children map
  to vanilla child races where they exist
- `age === 'child'` requires `charCreator.allowChildren`
- `isFemale` matches `sex`, weight 0-100, morphs within [-1, 1], presets
  0-255 ints, headpartIds/headTextureSetId uint32s, ≤ 40 tints with string
  texture paths ≤ 128 chars
- name: 2-30 chars, letters/spaces/'/-; backstory ≤ 4000; description ≤ 1000;
  control characters stripped
- stats: ints in [10, 100], total spend ≤ statPool
- non-facegen races (Giant, Falmer, Riekling/Goblin) must submit empty
  headparts/tints

Accepted data lands in `private.rp`:

```json
{ "species": "human", "race": "nord", "sex": "female", "age": "adult",
  "stats": {…}, "bodyExtras": {…}, "backstory": "…", "description": "…",
  "createdAt": 1755640000000 }
```

## Server settings (server-settings.json — live file, edit on the server)

```json
"charCreator": {
  "enabled": true,
  "allowChildren": true,
  "disabledRaces": [],
  "paywalledRaces": { "falmer": "supporter" },
  "grants": { "123456": ["supporter"] },
  "statPool": 120
}
```

`grants` maps profile ids to entitlement keys. Absent `charCreator` block (or
`enabled: false`) keeps the vanilla race menu, so enabling is opt-in per server.

## Data provenance

`skymp5-front/src/features/charCreator/data/headparts.json` and `tints.json`
were extracted from the live load order's `Skyrim.esm`/DLC RACE, HDPT, FLST and
CLFM records (playable headparts with per-race validity; per-race tint layers
with preset palettes). Regenerate with the scripts in the PR description when
the load order gains new races. Race form ids in `data/races.js` were verified
against the same esm dump. Custom races (Colovian, Reachfolk, Akaviri, Maormer,
furstocks, daedra variants) are `placeholder: true` entries that reuse vanilla
races until their esp lands in AlduinakPatchMerged — update `raceId` +
`skymp5-server/ts/systems/charCreatorData.ts` together.
