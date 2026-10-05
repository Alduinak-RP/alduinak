# Professions revamp: shared contract

The fixed interface between the server, plugin, native and client work of the professions revamp.
The owner's design (answers of 2026-09-27) is summarised here; each workstream must follow it exactly.

## Professions

| id | label | type | skills set at load |
|---|---|---|---|
| blacksmith | Blacksmith | Crafter | Smithing |
| tailor | Tailor | Crafter | Smithing, LightArmor |
| woodworker | Woodworker | Crafter/Gatherer | Smithing |
| alchemist | Alchemist | Crafter/Gatherer | Alchemy |
| cook | Cook | Crafter | OneHanded |
| miner | Miner | Gatherer | TwoHanded |
| farmer | Farmer | Gatherer | Pickpocket |
| hunter | Hunter | Gatherer/Fighter | Marksman |
| warrior | Warrior | Fighter | HeavyArmor, Block |
| mage | Mage | Fighter | Alteration, Conjuration, Destruction, Enchanting, Illusion, Restoration |

Every skill in this table is 15 for every character (the Free level); the character's own profession sets its skills
to the rank level: Novice 25, Adept 40, Expert 60, Master 80, Legendary 100. Speech is never set. With more than one
craft slot (r27, below) each slot's profession sets its skills and the best slot wins a skill two of them set.

Mage base magicka by rank: Free 100, Novice 125, Adept 150, Expert 175, Master 200, Legendary 500. From r27 the race's
bonus comes on top (its RACE starting magicka above 50: Breton 50 and High Elf 100 with plugin r27a), and a character
with no mage slot of Novice or better is held at 100 plus that bonus, so the mage write never erases a race's
magicka; in creation a mage gets the rank value alone and anyone else nothing. A mage cannot rise
above Adept until they know at least one Adept-level spell, above Expert without an Expert spell, and so on (spell level =
the highest minimum skill level of the spell's magic effects: 0 Novice, 25 Apprentice=Novice, 50 Adept, 75 Expert, 100 Master).

## Ranks and hours

| rank index | name | hours | notes |
|---|---|---|---|
| 0 | Free | - | everyone without a profession; everyone's baseline |
| 1 | Novice | 0 | given when the profession is chosen |
| 2 | Adept | 40 | |
| 3 | Expert | 100 | |
| 4 | Master | 180 | |
| 5 | Legendary | 6000 | hidden in the menu until reached; admins may grant it |

Storage stays `private.mastery = { profession, points, lastPointAt, rank, granted[] }` plus `v: 2`; `points` are hours.
`rank` uses the index above. Characters without `v: 2` are migrated at login: rank recomputed from points, markers
re-synced. One hour is credited per profession activity when `lastPointAt` is at least 60 minutes old. Since 2026-10
(F9) extra crafts inside a counted hour bank up to `masteryHourBank` (2) hours, kept as `bank` and `onlineMs` in the
same record and paid one per 60 online minutes (see `docs_roleplay_mastery.md`).

Activities that credit hours: crafting at a station for crafters; gathering (mine, chop, pick, skin) for gatherers;
killing NPCs (hunter: animals) and casting spells (mage) for fighters.

## Secondary and tertiary crafts (r27, multiclassing)

The owner's rule of 2026-09-30: a primary, a secondary locked to Adept and a tertiary locked to Novice, the two
earning their Novice by 20 hours of their class's free work. The server setting `masterySlots` configures the slots
(one entry, the code default, is multiclassing off); the Test value is:

| slot | name | cap | hours on its own counter |
|---|---|---|---|
| 0 | Primary | Legendary | the ladder above, Novice on choosing |
| 1 | Secondary | Adept | Novice 20, Adept 60 |
| 2 | Tertiary | Novice | Novice 20 |

- Slots are picked in order (primary, then secondary, then tertiary), any three distinct professions; a capped slot
  earns nothing more, and Legendary stays the primary's.
- A sub-slot starts at Free with no marker and earns hours only from free work: a recipe with no marker condition at
  one of its benches, or its Free activity (the table is in `docs_roleplay_mastery.md`). Once ranked, a gated recipe
  counts for it only through a marker of its own profession at a rank it holds.
- Each slot has its own hour clock and hour bank; one activity credits every slot it qualifies for.
- Rank readers for other systems (`rankOf`, `rankIn`, `craftRank`, `craftCost`) take the best slot holding the
  profession; `professionOf` returns the primary and must gain no callers.
- Markers stay `AldProf_<Label>_<Rank>`: a sub-slot holds its profession's markers up to its rank, so recipe gates,
  the native `HasSpell` condition and the client's crafting menu need no change.
- Resets: one shared count (`masteryResetsPerCharacter`); a reset clears one slot and nothing moves up.

Storage: the primary stays in `private.mastery` as above. The sub-slots live in `private.masterySlots = { v: 1,
secondary, tertiary, granted[], kits[] }`, each sub-slot `{ profession, points, lastPointAt, rank, bank, onlineMs }` or
`null`; `granted` lists the markers held for either sub-slot (the manager's MongoDB purge re-encodes it) and `kits` the
crafts whose sub-slot kit was given. Nothing is migrated: no record means two empty sub-slots.

## Plugin records (AlduinakAdditions.esp)

Rank markers: ability spells `AldProf_<Label>_<Rank>` (for example `AldProf_Blacksmith_Adept`), one per profession for
Novice, Adept, Expert, Master and Legendary; cumulative (a Master holds Novice to Master). Free has no marker. The
server finds them by editor id at boot. Each carries the rank's perks through a magic effect's Perk to Apply:

- Blacksmith: Adept Steel Smithing 000CB40D + Advanced Armors 000CB414; Expert Dwarven 000CB40E + Orcish 000CB410 +
  Elven 000CB40F; Master Ebony 000CB412 + Glass 000CB411 + Arcane Blacksmith 0005218E; Legendary Daedric 000CB413 +
  Dragon Armor 00052190.
- Tailor: new perks AldPerk_HideTailor (Novice), AldPerk_FineTailor (Adept), AldPerk_LeatherTailor (Expert),
  AldPerk_NobleTailor (Master), AldPerk_DaedricTailor (Legendary).
- Woodworker: new perks AldPerk_NoviceCarpenter, AldPerk_AdeptCarpenter, AldPerk_ExpertCarpenter,
  AldPerk_MasterCarpenter, AldPerk_Jesus (Legendary; internal name, an easter egg).
- Miner: AldPerk_NoviceMiner ... AldPerk_LegendaryMiner. Farmer: AldPerk_NoviceFarmer ... AldPerk_LegendaryFarmer.
- Alchemist, Cook, Hunter, Warrior: the current tiers and perks carried over; Mage: no perks yet (magicka only).

New perks may be empty (no entry points) where the design gives them no mechanical effect; they exist for conditions.

Recipe (COBJ) gates: `HasSpell(<marker of the required rank>) == 1`, run on subject. Free recipes carry no marker
condition. Tempering recipes (workbench / grinder) carry the marker of the profession and rank that can craft that
material, so a tailor or woodworker only improves what they can craft. New keywords as needed:
`AldKeyword_FineClothing`, `AldKeyword_NobleClothing`, and woodworker tier keywords `AldKeyword_Wood_<Rank>`.

Improvement quality is the engine's Smithing formula; the client sets Smithing per the table above.

## Server to client packet

`{ customPacketType: "professionState", profession, rank, rankName, hours, skills: { <ActorValueName>: level },
magicka: <base magicka or null>, slots }`, sent on actor assign and after every change. The client sets the base actor
values. `profession`, `rank` and `hours` stay the primary's; `skills` and `magicka` fold in every slot.

The profession menu keeps its current packets (masteryMenu / masteryChoose) with the new fields: `professions` has 10
entries with `type`; `rank` uses the index above; Legendary is only listed when reached.

r27 additions, all optional so older clients keep working with the primary alone:
- `masteryMenu` and `professionState` carry `slots: [{ slot, name, profession, label, rank, rankName, hours, cap,
  capName, rankHours }]`, one per configured slot, an empty one with `profession: null`; `rankHours` is indexed by
  rank like the top-level one (`[0, 20, 60]` for the Test secondary).
- `masteryChoose` takes `slot` (0, 1 or 2, default 0) and `masteryResetRequest` takes `profession` (default the
  primary's craft).
- The admin panel's `masteryGrant` and `masteryReset` take a `slot` (default 0).
- `masteryMenu` and `professionState` carry `bank: { max, intervalMs, offline, slots: [{ slot, countedMs, banked,
  payMs, capped }] }`, the hour clock and banked hours of every held craft for the Skills tab's hour bank strip, times
  as left at sending; optional like the rest (see `docs_roleplay_mastery.md`, "The hour bank strip").

## Starter kits

Existing kits stay. Farmer: the plugin hoe `AldToolHoe` and 50 gold. Mage: 50 gold and a blank book (the writing system's blank).
A secondary or tertiary pick hands over that craft's kit items without the gold, once per craft per character, and
nothing when the primary's kit was that craft's (`masterySlotKits`, default on).
