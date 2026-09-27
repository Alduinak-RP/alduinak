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
to the rank level: Novice 25, Adept 40, Expert 60, Master 80, Legendary 100. Speech is never set.

Mage base magicka by rank: Free 100, Novice 125, Adept 150, Expert 175, Master 200, Legendary 500. A mage cannot rise
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
re-synced. One hour is credited per profession activity when `lastPointAt` is at least 60 minutes old.

Activities that credit hours: crafting at a station for crafters; gathering (mine, chop, pick, skin) for gatherers;
killing NPCs (hunter: animals) and casting spells (mage) for fighters.

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
magicka: <base magicka or null> }`, sent on actor assign and after every change. The client sets the base actor values.

The profession menu keeps its current packets (masteryMenu / masteryChoose) with the new fields: `professions` has 10
entries with `type`; `rank` uses the index above; Legendary is only listed when reached.

## Starter kits

Existing kits stay. Farmer: the plugin hoe `AldToolHoe` and 50 gold. Mage: 50 gold and a blank book (the writing system's blank).
